#!/usr/bin/env ruby
# frozen_string_literal: true
#
# MulticastMember -- Ruby 3.4 UDP 组播成员封装（去中心广播消息组件）
#
# 已踩过的坑（已修复，不要回退）：
#   1) Ruby 3.4 移除 UDPSocket#add_membership，必须用
#        setsockopt(IPPROTO_IP, IP_ADD_MEMBERSHIP, pack('a4a4', grp, iface))
#      手工构造 ip_mreq。
#   2) Ruby 3.4 默认 require 'socket' 不再拉 IPAddr，显式 require 'ipaddr'。
#   3) sock.connect(group, port) 后，本地回环的组播包源地址是 INADDR_ANY，
#      Linux 对 connected UDP 直接丢 → "自己看不见自己"。
#      解法是 send(msg, 0, GROUP, PORT) 显式传目标，不 connect。
#   4) trap 上下文不能 acquire Mutex（ThreadError），所以 stop() 必须是
#      主线程同步调用，trap 只能翻旗 + 唤醒 self-pipe。
#
# 协议：
#   包 = HEADER 行 + BODY 块，二者之间用 "\n" 分隔
#   HEADER：key=value 空格分隔
#     kind=hb|leave|msg         （默认 msg）
#     seq=N                     发包方独立单调递增
#     id=host:pid               发包方 peer id
#     name=...  host=...  pid=N
#     peers=a,b,c               （hb）发包方视角的在线节点 id 列表
#     ch=channel                （msg）业务 channel
#     body_len=N                （msg）BODY 的 UTF-8 字节数
#   BODY：紧跟 HEADER 后的 N 个字节，UTF-8 JSON 对象
#         { "text": "hello", "ch": "channel", ...任意字段... }
#
# 用法：
#   m = MulticastMember.new('alice')                       # 必须给个名字
#
#   # 发送
#   m.send(:chat, 'hello!')
#   m.send(:chat, 'meta', user: 'alice', priority: 1)      # meta 进 BODY
#
#   # 订阅（带 block）
#   m.notify(:chat)         { |msg| ... }                  # 仅 :chat
#   m.notify([:log, :audit]){ |msg| ... }                  # :log 或 :audit
#   m.notify(nil)           { |msg| ... }                  # 所有 channel
#
#   # notify 单参语义：带 block = 订阅；不 block + text = 发
#   m.notify(:chat, 'hi')                                 # 发
#
#   # 集群视图
#   m.on_peer_joined { |peer| puts "[+] #{peer.id}" }
#   m.on_peer_left   { |peer| puts "[-] #{peer.id}" }
#
#   m.start
#   sleep 60
#   m.stop
#
require 'socket'
require 'ipaddr'
require 'json'

class MulticastMember
  DEFAULT_GROUP     = '239.255.0.1'
  DEFAULT_PORT      = 5000
  DEFAULT_IFACE     = '0.0.0.0'
  DEFAULT_HB_SEC    = 5
  PEER_TIMEOUT_MULT = 3      # peers 在 HB_SEC * 3 未见心跳 → 视为掉线
  HB_TTL            = 2
  PACKET_LIMIT      = 8 * 1024
  HEADER_RESERVE    = 1024   # header 字节预算上限

  Peer = Struct.new(:id, :name, :host, :pid, :addr, :last_seen, keyword_init: true)

  # msg 业务包解出的对象
  Message = Struct.new(:kind, :id, :name, :host, :pid, :seq, :from,
                       :channel, :text, :body, :peers_str,
                       keyword_init: true) do
    def [](k); body[k.to_s]; end
  end

  attr_reader :name

  # ---------- 构造 ----------
  def initialize(name, group: DEFAULT_GROUP, port: DEFAULT_PORT,
                 iface: DEFAULT_IFACE, hb_interval: DEFAULT_HB_SEC)
    @name       = name
    @group      = group
    @port       = port
    @iface_addr = iface
    @hb_sec     = hb_interval
    @host       = Socket.gethostname
    @pid        = Process.pid
    @peer_id    = "#{@host}:#{@pid}"

    @on_peer_joined = nil
    @on_peer_left   = nil

    @sock         = nil
    @running      = false
    @stop_pipe_r  = nil
    @stop_pipe_w  = nil
    @seq          = 0
    @last_hb_at   = 0.0

    @send_mutex  = Mutex.new
    @peers_lock  = Mutex.new
    @peers       = {}     # id => Peer
    @peer_seqs   = {}     # id => last_seq

    @notify_lock = Mutex.new
    @subs        = {}     # channel(Symbol/nil) => Array<Proc>
  end

  # ==========================================================
  # 公共 API
  # ==========================================================

  def on_peer_joined(&blk); @on_peer_joined = blk; self; end
  def on_peer_left(&blk);   @on_peer_left   = blk; self; end

  def start
    raise 'already started' if @running
    @sock, @stop_pipe_r, @stop_pipe_w = open_socket
    @running = true
    @loop_thread = Thread.new { loop_main }
    @loop_thread.name = "mcast-#{@name}"
    # 启动后下一轮 tick 立刻发 hb（让其它节点 1s 内看到）
    @last_hb_at = Time.now.to_f - @hb_sec - 1
    warn "[#{@name}] up id=#{@peer_id} group=#{@group}:#{@port} hb=#{@hb_sec}s"
    self
  end

  def stop
    return self unless @running
    @running = false
    @stop_pipe_w&.write_nonblock('.')
    @loop_thread&.join(2)
    close_socket
    warn "[#{@name}] down"
    self
  end

  # trap context 只能调这个：翻旗 + 唤醒；leave 由 loop 线程退出前发
  def stop_async
    return unless @running
    @running = false
    @stop_pipe_w&.write_nonblock('.') rescue nil
  end

  def running?; @running; end

  def peers
    @peers_lock.synchronize { @peers.values.map(&:dup) }
  end

  # 订阅（带 block）或发送（无 block + text）。
  # 发送时 channels 必须能 resolve 到恰好 1 个 channel；订阅支持多 / nil。
  def notify(channels, text = nil, **meta, &blk)
    if blk
      subscribe(normalize_channels_for_subscribe(channels), blk)
    else
      raise ArgumentError, 'send requires text (no block)' if text.nil?
      ch_list = normalize_channels_for_send(channels)
      raise ArgumentError, "send takes exactly 1 channel, got #{ch_list.size}" if ch_list.size != 1
      send_msg(ch_list.first, text, meta)
    end
    self
  end

  # 直白发：channel, text, **meta
  def send(channel, text, **meta)
    send_msg(coerce_channel(channel), text, meta)
  end

  # ==========================================================
  # 内部
  # ==========================================================
  private

  # ---------- channel 规整 ----------
  def coerce_channel(ch)
    return :default if ch.nil?
    ch.to_sym
  end

  def normalize_channels_for_subscribe(arg)
    case arg
    when nil    then [nil]
    when Symbol then [arg]
    when String then [arg.to_sym]
    when Array  then arg.map { |c| c.nil? ? nil : c.to_sym }
    else raise ArgumentError, "channel must be Symbol/String/Array/nil, got #{arg.class}"
    end
  end

  def normalize_channels_for_send(arg)
    case arg
    when nil    then [:default]
    when String then [arg.to_sym]
    when Symbol then [arg]
    else raise ArgumentError, "send channel must be Symbol/String/nil, got #{arg.class}"
    end
  end

  # ---------- 订阅 ----------
  def subscribe(channels, blk)
    @notify_lock.synchronize do
      channels.each { |ch| (@subs[ch] ||= []) << blk }
    end
  end

  # ---------- socket ----------
  def open_socket
    sock = UDPSocket.new
    sock.setsockopt(Socket::SOL_SOCKET, Socket::SO_REUSEADDR, true)
    sock.bind(@iface_addr, @port)
    mreq = [IPAddr.new(@group).hton, IPAddr.new(@iface_addr).hton].pack('a4a4')
    sock.setsockopt(Socket::IPPROTO_IP, Socket::IP_ADD_MEMBERSHIP, mreq)
    sock.setsockopt(Socket::IPPROTO_IP, Socket::IP_MULTICAST_TTL,    HB_TTL)
    sock.setsockopt(Socket::IPPROTO_IP, Socket::IP_MULTICAST_LOOP,   1)
    sock.setsockopt(Socket::IPPROTO_IP, Socket::IP_MULTICAST_IF,
                    IPAddr.new(@iface_addr).hton)

    r, w = IO.pipe
    r.binmode; w.binmode
    [sock, r, w]
  end

  def close_socket
    @stop_pipe_w&.close rescue nil
    @stop_pipe_r&.close rescue nil
    @sock&.close         rescue nil
    @sock = nil
  end

  # ---------- 主循环 ----------
  def loop_main
    while @running
      rd, = IO.select([@sock, @stop_pipe_r], nil, nil, 0.5)
      rd&.each { |io| handle_read(io) unless io.equal?(@stop_pipe_r) }
      emit_hb_if_due
      reap_dead_peers
    end
    # 退出前在主线程上下文发 leave（trap context 不能 lock Mutex）
    send_leave
  rescue => e
    warn "[#{@name}] loop crashed: #{e.class}: #{e.message}"
  end

  def handle_read(io)
    data, addr = io.recvfrom_nonblock(PACKET_LIMIT)
    msg = parse(data, "#{addr[3]}:#{addr[1]}")
    return unless msg
    case msg.kind
    when 'hb'    then process_hb(msg)
    when 'leave' then process_leave(msg)
    when 'msg'   then dispatch_msg(msg)
    end
  rescue IO::WaitReadable
    # 没数据，忽略
  end

  # ---------- 业务消息分发 ----------
  def dispatch_msg(msg)
    cbs = @notify_lock.synchronize do
      (@subs[msg.channel] || []) + (@subs[nil] || [])
    end
    cbs.each do |cb|
      cb.call(msg) rescue warn("[#{@name}] notify callback error: #{$!.class}: #{$!.message}")
    end
  end

  # ---------- hb / leave / gossip ----------
  def process_hb(msg)
    return if msg.id.nil? || msg.id == @peer_id
    return if stale?(msg)

    now = Time.now.to_f
    snapshot, is_new = @peers_lock.synchronize do
      peer = @peers[msg.id]
      if peer.nil?
        peer = Peer.new(id: msg.id, name: msg.name, host: msg.host,
                        pid: msg.pid, addr: msg.from, last_seen: now)
        @peers[msg.id] = peer
        [peer.dup, true]
      else
        peer.last_seen = now
        peer.addr = msg.from
        peer.name = msg.name if msg.name
        peer.host = msg.host if msg.host
        peer.pid  = msg.pid  if msg.pid
        [peer.dup, false]
      end
    end
    update_seq(msg)

    @on_peer_joined&.call(snapshot) if is_new
    merge_gossip(msg, now)
  end

  def merge_gossip(msg, now)
    peers_str = msg.peers_str
    return unless peers_str && !peers_str.empty?

    snap = []
    @peers_lock.synchronize do
      peers_str.split(',').each do |id|
        next if id.empty? || id == @peer_id || @peers[id]
        host, pid_str = id.split(':')
        peer = Peer.new(id: id, name: nil, host: host, pid: pid_str&.to_i,
                        addr: nil, last_seen: now)
        @peers[id] = peer
        snap << peer.dup
      end
    end
    snap.each { |p| @on_peer_joined&.call(p) }
  end

  def stale?(msg)
    return false unless msg.seq && msg.seq > 0
    prev = @peer_seqs[msg.id]
    return false if prev.nil?
    msg.seq <= prev
  end

  def update_seq(msg)
    @peer_seqs[msg.id] = msg.seq if msg.seq && msg.seq > 0
  end

  def process_leave(msg)
    return if msg.id == @peer_id || msg.id.nil?
    removed = nil
    @peers_lock.synchronize do
      removed = @peers.delete(msg.id)
      @peer_seqs.delete(msg.id)
    end
    @on_peer_left&.call(removed&.dup) if removed
  end

  def reap_dead_peers
    threshold = DEFAULT_HB_SEC * PEER_TIMEOUT_MULT
    now = Time.now.to_f
    dead = []
    @peers_lock.synchronize do
      @peers.each do |id, peer|
        next unless now - peer.last_seen > threshold
        dead << peer.dup
        @peers.delete(id)
        @peer_seqs.delete(id)
      end
    end
    dead.each { |p| @on_peer_left&.call(p) }
  end

  def emit_hb_if_due
    now = Time.now.to_f
    return if now - @last_hb_at < @hb_sec
    @last_hb_at = now
    @seq += 1
    send_packet(kind: 'hb', body: nil)
  end

  def send_leave
    @seq += 1
    send_packet(kind: 'leave', body: nil)
  end

  def send_msg(channel, text, meta)
    @seq += 1
    body = { 'text' => text.to_s, 'ch' => channel.to_s }.merge(meta.transform_keys(&:to_s))
    send_packet(kind: 'msg', channel: channel, body: body)
  end

  # ---------- 组装 UDP 报文 ----------
  def send_packet(kind:, body:, channel: nil)
    parts = ["kind=#{kind}", "seq=#{@seq}", "id=#{@peer_id}",
             "name=#{@name}", "host=#{@host}", "pid=#{@pid}"]

    if kind == 'msg'
      body_str = JSON.generate(body || {})
      cap = PACKET_LIMIT - HEADER_RESERVE
      body_bytes = body_str.bytesize > cap ? body_str.byteslice(0, cap) : body_str
      parts << "ch=#{channel}" if channel
      parts << "body_len=#{body_bytes.bytesize}"
      packet = parts.join(' ') + "\n" + body_bytes
    elsif kind == 'hb'
      parts << "peers=#{@peers_lock.synchronize { @peers.keys.join(',') }}"
      packet = parts.join(' ')
    else
      packet = parts.join(' ')
    end

    @send_mutex.synchronize { @sock&.send(packet, 0, @group, @port) }
  rescue => e
    warn "[#{@name}] send failed: #{e.class}: #{e.message}"
  end

  # ---------- 解析 ----------
  def parse(packet, from_addr)
    return nil if packet.empty?
    nl = packet.index("\n")
    header = nl ? packet[0...nl] : packet
    body_bytes = nl ? packet[(nl + 1)..] : ''
    body_len = kv(header, 'body_len')&.to_i
    body_bytes = body_bytes.byteslice(0, body_len) if body_len && body_bytes && body_bytes.bytesize > body_len

    kind = kv(header, 'kind') || 'msg'
    msg = Message.new(
      kind: kind, id: kv(header, 'id'), name: kv(header, 'name'),
      host: kv(header, 'host'), pid: kv(header, 'pid')&.to_i,
      seq: (kv(header, 'seq') || 0).to_i, from: from_addr,
      channel: nil, text: nil, body: {}, peers_str: kv(header, 'peers'),
    )

    if kind == 'msg'
      parse_msg_body(msg, body_bytes.to_s)
      msg.channel = msg.body['ch']&.to_s&.to_sym || :default
    end
    msg
  rescue => e
    warn "[#{@name}] parse failed: #{e.class}: #{e.message}"
    nil
  end

  def parse_msg_body(msg, raw)
    obj = raw.empty? ? {} : (JSON.parse(raw) rescue {})
    msg.body = obj.is_a?(Hash) ? obj : { 'data' => obj }
    msg.text = msg.body['text'].to_s
  end

  def kv(line, key)
    line.split(/\s+/).each do |tok|
      k, val = tok.split('=', 2)
      return val if k == key
    end
    nil
  end
end