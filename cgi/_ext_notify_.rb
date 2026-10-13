#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Notify 抽象基类 + SocketNotify (Socket 实现)
#
# 架构:
#   class Notify            -- 抽象基类：公共 API (send / notify / running? / stop)
#                            + 通用逻辑 (subscriber dispatch、HEADER 拼/解、mutex)
#   class SocketNotify   -- Notify 子类：用 UDP multicast socket 收发
#
# 子类需实现 (protected):
#   do_send_packet(bytes)   -- 发 packet bytes
#   do_stop                 -- 关 socket + 停线程
#   parse_packet(data, addr)-- 解收到的包 → Message
#   header_fields           -- 发送时附加的 HEADER 字段 (host / pid / name 等)
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
#      主线程同步调用。
#
# 协议：HEADER 行 + "\n" + BODY (UTF-8 JSON)
#   HEADER 字段：kind=msg|hb  seq=N  id=host:pid  name=...  body_len=N
#   BODY：{"text":"...","ch":"chat",...}        (msg 才需要 body)
#
# 用法：
#   m = SocketNotify.new('alice')         # 自动 start
#   m.notify(:chat) { |msg| puts msg.text }  # 订阅
#   m.notify(:chat, 'hi')                   # 发
#   m.emit(:chat, 'hi')                      # 同上，更明确的"广播"语义
#   ...
#   m.stop
#
#   f = FsNotify.new('/tmp/notify')
#   f.notify(:file) { |msg| puts "[#{msg.body['kind']}] #{msg.text}" }
#   f.emit(:chat, 'hi')                    # 写到 /tmp/notify/chat/<token>
#   ...
#   f.stop                                 # 删自己的 token 文件

require 'socket'
require 'ipaddr'
require 'json'
require 'fileutils'

# ============================================================
# Notify — 抽象基类
# ============================================================
class Notify
  Message = Struct.new(:kind, :id, :name, :host, :pid, :seq, :from,
                       :channel, :text, :body,
                       keyword_init: true)

  attr_reader :name

  def initialize(name)
    @name       = name
    @running    = false
    @seq        = 0
    @send_mutex  = Mutex.new
    @notify_lock = Mutex.new
    @subs        = {}  # Symbol channel => [Proc]
  end

  def running?; @running; end

  # 公共 API：订阅（带 block）或发送（无 block + text）
  def notify(channel, text = nil, **meta, &blk)
    if blk
      @notify_lock.synchronize { (@subs[coerce(channel)] ||= []) << blk }
    else
      raise ArgumentError, 'send requires text (no block)' if text.nil?
      send_msg(coerce(channel), text, meta)
    end
    self
  end

  def emit(channel, text, **meta)
    send_msg(coerce(channel), text, meta)
  end

  def stop
    return self unless @running
    @running = false
    do_stop
    self
  end

  # ----- 子类实现 -----
  protected

  def do_send_packet(_bytes); raise NotImplementedError, 'emit not supported by this impl'; end
  def do_stop;              end   # 默认 no-op
  def parse_packet(_data, _addr); raise NotImplementedError; end
  def header_fields;        []; end   # 默认空，emit 时 HEADER 至少含 kind/seq

  # ----- 子类可用的工具 -----

  # 业务消息分发（receive 线程调）
  def dispatch_msg(msg)
    cbs = @notify_lock.synchronize { (@subs[msg.channel] || []) + (@subs[:default] || []) }
    cbs.each do |cb|
      cb.call(msg) rescue warn("[#{@name}] notify callback error: #{$!.class}: #{$!.message}")
    end
  end

  def send_msg(channel, text, meta)
    body = { 'text' => text.to_s, 'ch' => channel.to_s }.merge(meta.transform_keys(&:to_s))
    packet = build_packet(kind: 'msg', channel: channel, body: body)
    @send_mutex.synchronize { do_send_packet(packet) }
  end

  def build_packet(kind:, channel: nil, body: nil)
    @seq += 1
    parts = ["kind=#{kind}", "seq=#{@seq}"] + header_fields
    parts << "ch=#{channel}" if channel
    body_json = body ? JSON.generate(body) : nil
    parts << "body_len=#{body_json.bytesize}" if body_json
    pkt = +''
    pkt << parts.join(' ') << "\n"
    pkt << body_json if body_json
    pkt
  end

  def parse_common_kv(line, key)
    line.split(/\s+/).each do |tok|
      k, val = tok.split('=', 2)
      return val if k == key
    end
    nil
  end

  private

  def coerce(ch); ch.nil? ? :default : ch.to_sym; end
end

# ============================================================
# SocketNotify — UDP multicast 实现
# ============================================================
class SocketNotify < Notify
  DEFAULT_GROUP  = '239.255.0.1'
  DEFAULT_PORT   = 5000
  DEFAULT_IFACE  = '0.0.0.0'
  DEFAULT_HB_SEC = 5
  HB_TTL         = 2
  PACKET_LIMIT   = 8 * 1024

  def initialize(name, group: DEFAULT_GROUP, port: DEFAULT_PORT,
                 iface: DEFAULT_IFACE, hb_interval: DEFAULT_HB_SEC)
    super(name)
    @group      = group
    @port       = port
    @iface_addr = iface
    @hb_sec     = hb_interval
    @host       = Socket.gethostname
    @pid        = Process.pid
    @peer_id    = "#{@host}:#{@pid}"

    @sock, @stop_pipe_r, @stop_pipe_w = open_socket
    @running = true
    @last_hb_at = Time.now.to_f - @hb_sec - 1   # 启动后下一 tick 立刻发 hb
    @loop_thread = Thread.new { loop_main }
    @loop_thread.name = "mcast-#{@name}"
    warn "[#{@name}] up id=#{@peer_id} group=#{@group}:#{@port} hb=#{@hb_sec}s"
  end

  protected

  def header_fields
    ["id=#{@peer_id}", "name=#{@name}", "host=#{@host}", "pid=#{@pid}"]
  end

  def do_send_packet(packet)
    @sock.send(packet, 0, @group, @port)
  end

  def do_stop
    @stop_pipe_w&.write_nonblock('.')
    @loop_thread&.join(2)
    close_socket
    warn "[#{@name}] down"
  end

  def parse_packet(data, from_addr)
    return nil if data.empty?
    nl = data.index("\n")
    header  = nl ? data[0...nl] : data
    body_bytes = nl ? data[(nl + 1)..] : ''
    body_len = parse_common_kv(header, 'body_len')&.to_i
    if body_len && body_bytes.bytesize > body_len
      body_bytes = body_bytes.byteslice(0, body_len)
    end

    body_obj = body_bytes.empty? ? {} : (JSON.parse(body_bytes) rescue {})
    body_obj = body_obj.is_a?(Hash) ? body_obj : { 'data' => body_obj }

    Message.new(
      kind:    parse_common_kv(header, 'kind') || 'msg',
      id:      parse_common_kv(header, 'id'),
      name:    parse_common_kv(header, 'name'),
      host:    parse_common_kv(header, 'host'),
      pid:     parse_common_kv(header, 'pid')&.to_i,
      seq:     (parse_common_kv(header, 'seq') || 0).to_i,
      from:    from_addr,
      channel: (body_obj['ch'] || 'default').to_sym,
      text:    body_obj['text'].to_s,
      body:    body_obj,
    )
  rescue => e
    warn "[#{@name}] parse failed: #{e.class}: #{e.message}"
    nil
  end

  private

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
    msg = parse_packet(data, "#{addr[3]}:#{addr[1]}")
    dispatch_msg(msg) if msg && msg.kind == 'msg'
  rescue IO::WaitReadable
    # 没数据，忽略
  end

  def emit_hb_if_due
    return if Time.now.to_f - @last_hb_at < @hb_sec
    @last_hb_at = Time.now.to_f
    packet = build_packet(kind: 'hb', body: nil)
    @send_mutex.synchronize { do_send_packet(packet) }
  end

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
end

# ============================================================
# FsNotify — listen gem 文件系统 IPC 实现（单机多进程广播）
# ============================================================
#
# 架构：
#   <root>/<channel>/<token>      ← 每个 FsNotify 实例一个 token 文件
#
#   emit(:chat, 'hi') →
#     追加一行 JSON 到自己的 token 文件（File.open(@file, 'a')）
#
#   Listen.to(root) 监听 root 下任何文件变化 →
#     handle_event 过滤掉自己 token 的修改 →
#     读取对方的 token 文件，每行一条消息，构造 Message，dispatch_msg
#
# 约定：
#   * 不回环（自己 emit 不触发自己的 callback）
#   * 启动时清理 root 下 pid 已死的过期 token 文件
#   * 单实例支持多 channel（emit 接 channel 参数；listen 监听所有 channel_dir）
#
# Message 字段（与 SocketNotify 对齐，peer 实例信息由 emit 时写入 body）：
#   kind:    'fs'
#   name:    来源 peer 实例的 @name（用户传入，如 "cgi-12345"）
#   pid:     来源进程 pid（优先从 body['pid']，否则从 token 文件名解析）
#   host:    来源进程主机名（emit 时 Socket.gethostname）
#   seq:     peer 端 emit 序列号
#   from:    来源标识（同 name）
#   channel: 消息所在 channel 目录名（Symbol）
#   text:    消息文本
#   body:    完整 JSON body（含 meta）
class FsNotify < Notify
  attr_reader :root, :token

  DEFAULT_ROOT = '/tmp/notify_fs'

  def initialize(name, root: DEFAULT_ROOT, force_polling: false)
    raise ArgumentError, 'FsNotify needs name' if name.nil? || name.empty?
    raise ArgumentError, 'FsNotify needs root path' if root.nil? || root.empty?
    super(name)
    @root  = root
    @token = Process.pid.to_s

    FileUtils.mkdir_p(root)
    cleanup_stale_tokens!

    require 'listen'
    @listener = Listen.to(root, force_polling: force_polling, recursive: true) do |modified, added, removed|
      handle_event(modified, added, removed)
    end
    @listener.start
    @running = true
  end

  def emit(channel, text, **meta)
    ch = coerce(channel)
    file = File.join(@root, ch.to_s, @token)
    FileUtils.mkdir_p(File.dirname(file))
    body = {
      'text'  => text.to_s,
      'ch'    => ch.to_s,
      'name'  => @name,
      'pid'   => Process.pid,
      'host'  => Socket.gethostname,
      'seq'   => (@seq += 1),
    }.merge(meta.transform_keys(&:to_s))
    File.open(file, 'a') { |f| f.puts JSON.generate(body) }
    self
  end

  def stop
    return self unless @running
    @running = false
    @listener&.stop
    Dir.glob(File.join(@root, '*', @token)).each { |f| File.delete(f) if File.exist?(f) }
    self
  end

  protected

  def do_send_packet(_bytes); raise NotImplementedError, 'FsNotify uses emit/append-to-file'; end

  def header_fields; []; end

  def parse_packet(_data, _addr); raise NotImplementedError, 'FsNotify uses dispatch_msg directly'; end

  private

  # 扫描 root 下所有 channel 目录，过滤掉自己 token 后，
  # 用 token 名（pid）检查进程是否还活着决定清理。
  #   Linux: /proc/<pid> 存在则活
  #   其他平台: 看 mtime（5 分钟没动视为退出）
  def cleanup_stale_tokens!
    Dir.glob(File.join(@root, '*', '*')).each do |f|
      next unless File.file?(f)
      next if File.basename(f) == @token
      pid = File.basename(f)
      dead =
        if pid =~ /\A\d+\z/ && File.directory?('/proc')
          !File.directory?("/proc/#{pid}")
        else
          Time.now - File.mtime(f) > 300
        end
      File.delete(f) if dead
    end
  end

  def handle_event(modified, added, removed)
    (modified + added).each do |path|
      next unless path.start_with?(@root + '/')
      basename = File.basename(path)
      next if basename == @token     # 过滤自己
      ch_dir = File.dirname(path)
      ch = File.basename(ch_dir).to_sym
      next unless @running
      File.foreach(path) do |line|
        line = line.strip
        next if line.empty?
        body = JSON.parse(line)
        peer_pid = basename.to_i if basename =~ /\A\d+\z/
        msg = Message.new(
          kind:    'fs',
          id:      nil,
          name:    body['name']  || "fs-{#{peer_pid}}",
          host:    body['host'],
          pid:     body['pid']&.to_i || peer_pid,
          seq:     body['seq']&.to_i,
          from:    body['name'] || basename,
          channel: (body['ch'] || ch.to_s).to_sym,
          text:    body['text'].to_s,
          body:    body,
        )
        dispatch_msg(msg)
      rescue JSON::ParserError
        next
      end
    end
    removed.each { |_| }   # 暂不处理删除事件
  end
end