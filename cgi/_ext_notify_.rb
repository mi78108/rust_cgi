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
# 协议：HEADER 行 + "\n" + PAYLOAD
#   HEADER 字段：kind=msg|hb  ch=<channel>  fmt=json|text|bin  seq=N
#                id=host:pid  name=...  body_len=N
#   PAYLOAD：按 fmt 分派，SocketNotify 不解释内容 —— 格式由上层决定。
#     fmt=json  → 任意可 JSON 序列化的对象 (Hash / Array / 标量)
#     fmt=text  → UTF-8 文本 (String)，原样透传
#     fmt=bin   → 任意字节 (ASCII-8BIT String)，原样透传
#
#   上层分派规则（Notify#send_msg）：
#     Hash / Array          → fmt=json
#     nil                   → fmt=json（body 为 {}）
#     String (UTF-8 有效)    → fmt=text
#     String (含非法 UTF-8)  → fmt=bin
#   也可显式指定：notify(:ch, payload, fmt: :bin)
#
#   Message 字段：
#     fmt      — 'json' | 'text' | 'bin'
#     data     — fmt=json 时是解析后的 Ruby 对象；fmt=text/bin 时是原始 String
#     raw      — 始终是原始 payload bytes (ASCII-8BIT)，与 fmt 无关
#     text     — 兼容字段：data 是 String 时等于 data，否则 data.to_s
#     body     — 兼容字段：fmt=json 时的 Hash（含 meta），否则 {}
#
# 用法：
#   m = SocketNotify.new('alice')              # 自动 start
#   m.notify(:chat) { |msg| puts msg.data }    # 订阅
#   m.notify(:chat, 'hi')                       # 发文本 → fmt=text
#   m.notify(:chat, {a: 1})                    # 发 JSON → fmt=json
#   m.notify(:chat, binary_bytes, fmt: :bin)   # 发二进制 → fmt=bin
#   m.emit(:chat, 'hi')                          # 同上，更明确的"广播"语义
#   ...
#   m.stop
#
#   f = FsNotify.new('/tmp/notify')
#   f.notify(:file) { |msg| puts "[#{msg.fmt}] #{msg.data}" }  # 订阅
#   f.emit(:chat, 'hi')                    # 写到 /tmp/notify/chat/<token>
#   ...
#   f.stop                                 # 删自己的 token 文件

require 'socket'
require 'ipaddr'
require 'json'
require 'base64'
require 'fileutils'

# ============================================================
# Notify — 抽象基类
# ============================================================
class Notify
  Message = Struct.new(:kind, :id, :name, :host, :pid, :seq, :from,
                       :channel, :fmt, :data, :raw,
                       keyword_init: true) do
    # fmt=json 且 data 是 Hash 时返回它, 否则空 Hash (兼容旧的 msg.body 用法)
    def body
      fmt == 'json' && data.is_a?(Hash) ? data : {}
    end

    # 兼容字段: data 是 String 就原样给, 否则 to_s
    def text
      data.is_a?(String) ? data : data.to_s
    end

    # 便捷: 原始 bytes (ASCII-8BIT)
    def bytes
      raw || (data.is_a?(String) ? data.dup.force_encoding(Encoding::ASCII_8BIT) : nil)
    end
  end

  attr_reader :name

  # 显式 fmt 白名单
  FORMATS = %w[json text bin].freeze

  def initialize(name)
    @name       = name
    @running    = false
    @seq        = 0
    @send_mutex  = Mutex.new
    @notify_lock = Mutex.new
    @subs        = {}  # Symbol channel => [Proc]
  end

  def running?; @running; end

  # 公共 API：订阅（带 block）或发送（无 block + payload）
  def notify(channel, payload = nil, **meta, &blk)
    if blk
      @notify_lock.synchronize { (@subs[coerce(channel)] ||= []) << blk }
    else
      send_msg(coerce(channel), payload, meta)
    end
    self
  end

  def emit(channel, payload, **meta)
    send_msg(coerce(channel), payload, meta)
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

  # 业务消息分发（receive 线程调）
  def dispatch_msg(msg)
    cbs = @notify_lock.synchronize { (@subs[msg.channel] || []) + (@subs[:default] || []) }
    cbs.each do |cb|
      cb.call(msg) rescue warn("[#{@name}] notify callback error: #{$!.class}: #{$!.message}")
    end
  end

  # payload → [fmt, payload_bytes] 的自动分派。
  # 上层想跳过自动判断就传 meta[:fmt]。
  def encode_payload(payload)
    fmt = nil
    body = nil
    case payload
    when nil
      fmt, body = 'json', '{}'
    when Hash, Array, Integer, Float, TrueClass, FalseClass
      fmt = 'json'
      body = JSON.generate(payload)
    when String
      # 非法 UTF-8 → 二进制通道；合法 → 文本通道
      if payload.encoding == Encoding::ASCII_8BIT && !payload.dup.force_encoding('UTF-8').valid_encoding?
        fmt = 'bin'
        body = payload.dup.force_encoding(Encoding::ASCII_8BIT)
      elsif !payload.valid_encoding?
        fmt = 'bin'
        body = payload.dup.force_encoding(Encoding::ASCII_8BIT)
      else
        fmt = 'text'
        body = payload.encode('UTF-8')
      end
    else
      # 其他对象 → to_s 再走文本
      fmt = 'text'
      body = payload.to_s.encode('UTF-8')
    end
    [fmt, body]
  end

  def send_msg(channel, payload, meta = {})
    meta = meta.transform_keys(&:to_s)
    # 显式指定 fmt 时跳过自动分派
    fmt = meta.delete('fmt')&.to_s
    if fmt && FORMATS.include?(fmt)
      body =
        case fmt
        when 'json' then JSON.generate(payload)
        when 'text' then payload.to_s.encode('UTF-8')
        when 'bin'  then payload.to_s.dup.force_encoding(Encoding::ASCII_8BIT)
        end
    else
      fmt, body = encode_payload(payload)
    end
    packet = build_packet(kind: 'msg', channel: channel, fmt: fmt, body: body, meta: meta)
    @send_mutex.synchronize { do_send_packet(packet) }
  end

  def build_packet(kind:, channel: nil, fmt: nil, body: nil, meta: nil)
    @seq += 1
    parts = ["kind=#{kind}", "seq=#{@seq}"] + header_fields
    parts << "ch=#{channel}" if channel
    parts << "fmt=#{fmt}" if fmt
    parts << "body_len=#{body.bytesize}" if body
    parts.concat(meta.map { |k, v| "#{k}=#{v}" }) if meta && !meta.empty?
    pkt = +''
    pkt << parts.join(' ') << "\n"
    pkt << body if body
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
  # UDP 单包上限 ~65507 字节 (IP 层). 8KB 太小: 大 payload (如 base64 编码的
  # 二进制帧) 会被 recvfrom_nonblock 静默截断, 导致数据残缺.
  PACKET_LIMIT   = 60 * 1024

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

  # 按 HEADER 的 fmt 字段分派 payload 解码 —— SocketNotify 不理解内容格式。
  #   fmt=json → JSON.parse（失败则当原始文本，不丢消息）
  #   fmt=text → 原始 UTF-8 String
  #   fmt=bin  → 原始 ASCII-8BIT String
  #   fmt 缺失 → 向后兼容：试 JSON，失败则当 text
  def parse_packet(data, from_addr)
    return nil if data.empty?
    nl = data.index("\n")
    header  = nl ? data[0...nl] : data
    body_bytes = nl ? data[(nl + 1)..] : ''
    body_len = parse_common_kv(header, 'body_len')&.to_i
    if body_len && body_bytes.bytesize > body_len
      body_bytes = body_bytes.byteslice(0, body_len)
    end

    fmt = parse_common_kv(header, 'fmt')

    data_obj =
      case fmt
      when 'bin'
        body_bytes.dup.force_encoding(Encoding::ASCII_8BIT)
      when 'text'
        body_bytes.dup.force_encoding(Encoding::UTF_8)
      when 'json'
        if body_bytes.empty?
          {}
        else
          JSON.parse(body_bytes) rescue body_bytes.dup.force_encoding(Encoding::UTF_8)
        end
      else
        # fmt 缺失（旧版本 peer）→ 尽量当 JSON，失败退回 text
        if body_bytes.empty?
          {}
        else
          JSON.parse(body_bytes) rescue body_bytes.dup.force_encoding(Encoding::UTF_8)
        end
      end

    Message.new(
      kind:    parse_common_kv(header, 'kind') || 'msg',
      id:      parse_common_kv(header, 'id'),
      name:    parse_common_kv(header, 'name'),
      host:    parse_common_kv(header, 'host'),
      pid:     parse_common_kv(header, 'pid')&.to_i,
      seq:     (parse_common_kv(header, 'seq') || 0).to_i,
      from:    from_addr,
      channel: (parse_common_kv(header, 'ch') || 'default').to_sym,
      fmt:     fmt || (data_obj.is_a?(String) ? 'text' : 'json'),
      data:    data_obj,
      raw:     body_bytes.dup.force_encoding(Encoding::ASCII_8BIT),
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

  # FsNotify 的存储介质是"每行一条 JSON"，所以 payload 一律包成 JSON。
  # 二进制 payload 在这里无法透明传输（会被 JSON 转义）—— 用 base64 自行处理。
  # 走 SocketNotify 才支持任意二进制。
  def emit(channel, payload, **meta)
    ch = coerce(channel)
    file = File.join(@root, ch.to_s, @token)
    FileUtils.mkdir_p(File.dirname(file))
    fmt, encoded = encode_payload(payload)
    body = {
      'fmt'   => fmt,
      'data'  => (fmt == 'bin' ? Base64.strict_encode64(encoded) : encoded),
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
        fmt = body['fmt'] || 'text'
        # 向后兼容: 旧 token 文件只有 'text' 字段（无 fmt/data）
        payload = body.key?('data') ? body['data'] : body['text']
        data =
          case fmt
          when 'bin'  then Base64.decode64(payload.to_s)
          when 'json' then (JSON.parse(payload.to_s) rescue payload)
          else            payload.to_s
          end
        data = data.dup.force_encoding(Encoding::ASCII_8BIT) if fmt == 'bin'
        msg = Message.new(
          kind:    'fs',
          id:      nil,
          name:    body['name']  || "fs-{#{peer_pid}}",
          host:    body['host'],
          pid:     body['pid']&.to_i || peer_pid,
          seq:     body['seq']&.to_i,
          from:    body['name'] || basename,
          channel: (body['ch'] || ch.to_s).to_sym,
          fmt:     fmt,
          data:    data,
          raw:     (fmt == 'bin' ? data.dup.force_encoding(Encoding::ASCII_8BIT) : data.to_s.dup.force_encoding(Encoding::ASCII_8BIT)),
        )
        dispatch_msg(msg)
      rescue JSON::ParserError
        next
      end
    end
    removed.each { |_| }   # 暂不处理删除事件
  end
end