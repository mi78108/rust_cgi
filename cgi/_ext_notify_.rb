#!/usr/bin/env ruby
# frozen_string_literal: true
#
# MulticastMember -- Ruby 3.4+ UDP 组播 peer 广播消息组件
#
# 已踩过的坑（不要回退）：
#   1) Ruby 3.4 移除 UDPSocket#add_membership，必须用
#        setsockopt(IPPROTO_IP, IP_ADD_MEMBERSHIP, json_str)
#      手工构造 ip_mreq。
#   2) Ruby 3.4 默认 require 'socket' 不再拉 IPAddr，显式 require 'ipaddr'。
#   3) sock.connect(group, port) 后，本地回环的组播包源地址是 INADDR_ANY，
#      Linux 对 connected UDP 直接丢 → "自己看不见自己"。
#      解法是 send(msg, 0, GROUP, PORT) 显式传目标，不 connect。
#   4) trap 上下文不能 acquire Mutex（ThreadError），所以 stop() 必须是
#      主线程同步调用，trap 只能翻旗 + 唤醒 self-pipe。
#
# 协议：HEADER 行 + "\n" + BODY (UTF-8 JSON)
#   HEADER 字段：kind=msg|hb  seq=N  id=host:pid  name=...  body_len=N
#   BODY：{"text":"...","ch":"chat",...}        (msg 才需要 body)
#
# 用法：
#   m = MulticastMember.new('alice')      # 自动 start（开 socket + 起 bg 线程）
#   m.notify(:chat) { |msg| puts msg.text } # 订阅
#   m.notify(:chat, 'hi')                   # 发
#   ...
#   m.stop                                 # 关闭

require 'socket'
require 'ipaddr'
require 'json'

class MulticastMember
  DEFAULT_GROUP  = '239.255.0.1'
  DEFAULT_PORT   = 5000
  DEFAULT_IFACE  = '0.0.0.0'
  DEFAULT_HB_SEC = 5
  HB_TTL         = 2
  PACKET_LIMIT   = 8 * 1024

  Message = Struct.new(:kind, :id, :name, :host, :pid, :seq, :from,
                       :channel, :text, :body,
                       keyword_init: true)

  attr_reader :name

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

    @sock        = nil
    @running     = false
    @stop_pipe_r = nil
    @stop_pipe_w = nil
    @seq         = 0
    @last_hb_at  = 0.0

    @send_mutex  = Mutex.new
    @notify_lock = Mutex.new
    @subs        = {}  # channel Symbol => [Proc]

    # 自动 start（new 即开 socket + 起 bg 线程）
    @sock, @stop_pipe_r, @stop_pipe_w = open_socket
    @running = true
    @loop_thread = Thread.new { loop_main }
    @loop_thread.name = "mcast-#{@name}"
    @last_hb_at = Time.now.to_f - @hb_sec - 1   # 启动后下一 tick 立刻发 hb
    warn "[#{@name}] up id=#{@peer_id} group=#{@group}:#{@port} hb=#{@hb_sec}s"
  end

  # ==========================================================
  # 公共 API
  # ==========================================================

  def stop
    return self unless @running
    @running = false
    @stop_pipe_w&.write_nonblock('.')
    @loop_thread&.join(2)
    close_socket
    warn "[#{@name}] down"
    self
  end

  def running?; @running; end

  # 订阅（带 block）或发送（无 block + text）
  def notify(channel, text = nil, **meta, &blk)
    if blk
      @notify_lock.synchronize { (@subs[coerce(channel)] ||= []) << blk }
    else
      raise ArgumentError, 'send requires text (no block)' if text.nil?
      send_msg(coerce(channel), text, meta)
    end
    self
  end

  def send(channel, text, **meta)
    send_msg(coerce(channel), text, meta)
  end

  # ==========================================================
  # 内部
  # ==========================================================
  private

  def coerce(ch); ch.nil? ? :default : ch.to_sym; end

  # ---------- socket ----------
  def open_socket
    sock = UDPSocket.new
    sock.setsockopt(Socket::SOL_SOCKET, Socket::SO_REUSEADDR, true)
    sock.setsockopt(Socket::SOL_SOCKET, Socket::SO_REUSEPORT, true)
    sock.bind(@iface_addr, @port)
    membership = IPAddr.new(@group).hton + IPAddr.new(@iface_addr).hton
    sock.setsockopt(Socket::IPPROTO_IP, Socket::IP_ADD_MEMBERSHIP, membership)
    r, w = IO.pipe
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
    end
  rescue => e
    warn "[#{@name}] loop crashed: #{e.class}: #{e.message}"
  end

  def handle_read(io)
    data, addr = io.recvfrom_nonblock(PACKET_LIMIT)
    msg = parse(data, "#{addr[3]}:#{addr[1]}")
    dispatch_msg(msg) if msg && msg.kind == 'msg'
  rescue IO::WaitReadable
    # 没数据，忽略
  end

  def emit_hb_if_due
    return if Time.now.to_f - @last_hb_at < @hb_sec
    @last_hb_at = Time.now.to_f
    send_packet(kind: 'hb', body: nil)
  end

  # ---------- 业务消息分发 ----------
  def dispatch_msg(msg)
    cbs = @notify_lock.synchronize { (@subs[msg.channel] || []) + (@subs[:default] || []) }
    cbs.each do |cb|
      cb.call(msg) rescue warn("[#{@name}] notify callback error: #{$!.class}: #{$!.message}")
    end
  end

  # ---------- 发送 ----------
  def send_msg(channel, text, meta)
    @seq += 1
    body = { 'text' => text.to_s, 'ch' => channel.to_s }.merge(meta.transform_keys(&:to_s))
    send_packet(kind: 'msg', channel: channel, body: body)
  end

  def send_packet(kind:, body:, channel: nil)
    @send_mutex.synchronize do
      @seq += 1
      parts = %W[kind=#{kind} seq=#{@seq} id=#{@peer_id} name=#{@name} host=#{@host} pid=#{@pid}]
      parts << "ch=#{channel}" if channel
      body_json = body ? JSON.generate(body) : nil
      parts << "body_len=#{body_json.bytesize}" if body_json
      packet = +''
      packet << parts.join(' ') << "\n"
      packet << body_json if body_json
      @sock.send(packet, 0, @group, @port) if @sock
    end
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
    if body_len && body_bytes.bytesize > body_len
      body_bytes = body_bytes.byteslice(0, body_len)
    end

    body_obj = body_bytes.empty? ? {} : (JSON.parse(body_bytes) rescue {})
    body_obj = body_obj.is_a?(Hash) ? body_obj : { 'data' => body_obj }

    Message.new(
      kind:    kv(header, 'kind') || 'msg',
      id:      kv(header, 'id'),
      name:    kv(header, 'name'),
      host:    kv(header, 'host'),
      pid:     kv(header, 'pid')&.to_i,
      seq:     (kv(header, 'seq') || 0).to_i,
      from:    from_addr,
      channel: (body_obj['ch'] || 'default').to_sym,
      text:    body_obj['text'].to_s,
      body:    body_obj,
    )
  rescue => e
    warn "[#{@name}] parse failed: #{e.class}: #{e.message}"
    nil
  end

  def kv(line, key)
    line.split(/\s+/).each do |tok|
      k, val = tok.split('=', 2)
      return val if k == key
    end
    nil
  end
end