#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Notify 抽象基类 + SocketNotify (Socket 实现) + FsNotify (文件系统 IPC 实现)
#
# 定位：只负责「把字节从 A 搬到 B」，附带必要的路由元数据。
#       不关心 payload 是什么 —— 永远是 ASCII-8BIT 原始字节，
#       格式（JSON / 文本 / protobuf / 任意二进制）由应用层自己解析。
#
# 架构:
#   class Notify            -- 抽象基类：公共 API (notify / emit / stop)
#                            + 通用逻辑 (subscriber dispatch、HEADER 拼解、mutex)
#   class SocketNotify   -- Notify 子类：用 UDP multicast socket 收发
#   class FsNotify       -- Notify 子类：用「每 channel 一个 token 文件」append 收发
#
# 子类需实现 (protected):
#   do_send_packet(bytes)   -- 发 packet bytes
#   do_stop                 -- 清理资源
#   parse_packet(data, addr)-- 解收到的包 → Message
#   header_fields           -- 发送时附加的 HEADER 字段 (host / pid / name 等)
#
# 已踩过的坑（不要回退）：
#   1) Ruby 3.4 移除 UDPSocket#add_membership，必须用
#        setsockopt(IPPROTO_IP, IP_ADD_MEMBERSHIP, ip_mreq)
#      手工构造 ip_mreq。
#   2) Ruby 3.4 默认 require 'socket' 不再拉 IPAddr，显式 require 'ipaddr'。
#   3) sock.connect(group, port) 后，本地回环的组播包源地址是 INADDR_ANY，
#      Linux 对 connected UDP 直接丢 → "自己看不见自己"。
#      解法是 send(msg, 0, GROUP, PORT) 显式传目标，不 connect。
#   4) trap 上下文不能 acquire Mutex（ThreadError），所以 stop() 必须是
#      主线程同步调用。
#   5) meta / channel 拼进 HEADER 时不能含空格或 \n（用 \s+ 解析）——
#      调用方自己保证，框架不校验。
#
# 协议：HEADER 行 + "\n" + PAYLOAD（ASCII-8BIT 原始字节）
#   HEADER (短 key，省字节):
#     k=msg|hb  c=<channel>  s=N(seq)  l=<body_len>
#     n=<name>  h=<host>  p=<pid>   [任意自定义 meta key=v]
#   PAYLOAD: 原样字节，不解析
#
#   完整 key → 短 key 映射见 KEYMAP。id 字段已删除（= host:pid，纯冗余）。
#
#   因为 payload 不解析，channel / seq / pid 这些路由元数据必须在 HEADER 里，
#   否则二进制 payload 里没法挖字段。
#
# Message 字段:
#   kind     — 'msg' | 'hb'
#   name     — 实例名（发送方传入的 name）        ← header n=
#   host     — 发送方主机名                        ← header h=
#   pid      — 发送方进程 pid                      ← header p=
#   seq      — 发送方递增序号                      ← header s=
#   from     — 发送方标识（socket 是 "ip:port"）    ← 来自 socket 地址，不在 header
#   channel  — Symbol                             ← header c=
#   data     — ★ ASCII-8BIT 原始字节               ← payload
#   header   — 原始 HEADER 行（读自定义 meta 用 msg.header）
#
# 用法：
#   m = SocketNotify.new('alice')              # 自动 start
#
#   m.notify(:chat) do |msg|                   # 订阅（自己发的也会回调）
#     puts msg.data.force_encoding('UTF-8')   # data 永远是 bytes
#   end
#   m.notify(:chat, false) do |msg|            # 订阅但跳过自己发的
#     puts msg.data.force_encoding('UTF-8')
#   end
#   m.notify(:other) { |msg| ... }             # 另开一个 channel
#
#   m.notify(:chat, 'hi')                       # 发（String → UTF-8 bytes）
#   m.notify(:chat, {a: 1}.to_json)             # 发 JSON（自己序列化）
#   m.notify(:chat, some_binary)               # 发任意二进制
#   m.notify(:chat, payload, tag: 'x')         # 附加自定义 meta 进 HEADER
#
#   m.stop
#
#   f = FsNotify.new('alice', root: '/tmp/notify_fs')
#   f.notify(:file) { |msg| puts msg.data }
#   f.notify(:file, 'hello')
#   f.stop                                     # 删自己的 token 文件

require 'socket'
require 'ipaddr'
require 'json'
require 'fileutils'
# ============================================================
# Notify — 抽象基类
# ============================================================
class Notify
  Message = Struct.new(:kind, :name, :host, :pid, :seq, :from,
                       :channel, :data, :header,
                       keyword_init: true)

  # 完整 key → header 短 key（省字节）。加新字段时同步这里。
  KEYMAP = {
    kind: 'k', channel: 'c', seq: 's', body_len: 'l',
    name: 'n', host: 'h', pid: 'p'
  }.freeze

  attr_reader :name

  def initialize(name)
    @name        = name
    @running     = false
    @seq         = 0
    @send_mutex  = Mutex.new
    @notify_lock = Mutex.new
    @subs        = {}  # Symbol channel => [Proc]
  end

  def running?; @running; end

  # 公共 API：订阅（带 block）或发送（无 block + payload）
  #
  
  #   m.notify(:chat) { |msg| ... }         订阅（收到自己发的也会回调）
  #   m.notify(:chat, false) { |msg| ... }  订阅但跳过自己发的（不依赖 pid 比对）
  #   m.notify(:chat, 'hi')                 发送
  def notify(channel, payload = nil, **meta, &blk)
    if blk
      if payload == false
        @notify_lock.synchronize { (@subs[coerce(channel)] ||= []) << [blk, false] }
      else
        @notify_lock.synchronize { (@subs[coerce(channel)] ||= []) << [blk, true] }
      end
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
  # @subs 里每项是 [cb, want_echo] —— want_echo=false 的订阅跳过自己发的消息
  def dispatch_msg(msg)
    subs = @notify_lock.synchronize { (@subs[msg.channel] || []) + (@subs[:default] || []) }
    own = msg.pid.to_i == Process.pid
    subs.each do |cb, want_echo|
      next if own && !want_echo
      cb.call(msg) rescue warn("[#{@name}] notify callback error: #{$!.class}: #{$!.message}")
    end
  end

 # payload 一律当 bytes，不判断类型 / 不编码转换。
  #   String → dup + force_encoding(ASCII_8BIT)，字节序列原样保留
  #            （不要 encode!  非法 UTF-8 字节会被 replace 成 U+FFFD，数据就毁了）
  #   其他   → to_s
  def payload_bytes(payload)
    case payload
    when nil    then ''.dup.force_encoding(Encoding::ASCII_8BIT)
    when String then payload.dup.force_encoding(Encoding::ASCII_8BIT)
    else             payload.to_s.dup.force_encoding(Encoding::ASCII_8BIT)
    end
  end

  def send_msg(channel, payload, meta = {})
    body = payload_bytes(payload)
    packet = build_packet(kind: 'msg', channel: channel, body: body, meta: meta)
    @send_mutex.synchronize { do_send_packet(packet) }
  end

  def build_packet(kind:, channel: nil, body: nil, meta: nil)
    @seq += 1
    k = KEYMAP
    parts = ["#{k[:kind]}=#{kind}", "#{k[:seq]}=#{@seq}"] + header_fields
    parts << "#{k[:channel]}=#{channel}" if channel
    parts << "#{k[:body_len]}=#{body.bytesize}" if body
    parts.concat(meta.map { |key, v| "#{key}=#{v}" }) if meta && !meta.empty?
    # header 强制 ASCII_8BIT —— 否则 pkt(ASCII_8BIT) << utf8_header 会触发
    # Encoding::CompatibilityError（非 ASCII 的 channel/meta 值时）。
    # header 只能放 ASCII；应用层要传中文元数据请 base64 或放 payload。
    head = parts.join(' ').dup.force_encoding(Encoding::ASCII_8BIT)
    pkt = ''.dup.force_encoding(Encoding::ASCII_8BIT)
    pkt << head << "\n"
    pkt << body if body
    pkt
  end

  # 拆 header 行 / payload，并把 payload 原样交给应用层
  def split_packet(data)
    nl = data.index("\n")
    header = nl ? data[0...nl] : data
    body   = nl ? data[(nl + 1)..] : ''.dup.force_encoding(Encoding::ASCII_8BIT)
    body   = body.dup.force_encoding(Encoding::ASCII_8BIT)
    body_len = header_kv(header, :body_len)&.to_i
    body = body.byteslice(0, body_len) if body_len && body.bytesize > body_len
    [header, body]
  end

  def parse_common_kv(line, key)
    line.to_s.split(/\s+/).each do |tok|
      k, val = tok.split('=', 2)
      return val if k == key
    end
    nil
  end

  # 按完整 key 读 header 字段（自动转短 key）。
  #   header_kv(h, :channel)  →  找 "c=..."
  #   header_kv(h, :body_len) →  找 "l=..."
  # 应用层读自定义 meta 直接 header_kv(msg.header, 'mykey')（meta 的 key 不缩写）。
  def header_kv(header, key)
    short = KEYMAP[key.to_sym] || key.to_s
    parse_common_kv(header, short)
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
  # UDP 单包硬上限 ~65507 字节 (IP 层)。recvfrom 的缓冲区，给到 60KB 留余量。
  # 超过会被静默截断 —— 应用层要发大数据得自己分片。
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
    @loop_thread.name = "Notify-#{@name}"
    warn "[#{@name}] up id=#{@peer_id} group=#{@group}:#{@port} hb=#{@hb_sec}s"
  end

  protected

  def header_fields
    k = KEYMAP
    ["#{k[:name]}=#{@name}", "#{k[:host]}=#{@host}", "#{k[:pid]}=#{@pid}"]
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
    return nil if data.nil? || data.empty?
    header, body = split_packet(data)
    return nil if header.to_s.empty?

    Message.new(
      kind:    header_kv(header, :kind) || 'msg',
      name:    header_kv(header, :name),
      host:    header_kv(header, :host),
      pid:     header_kv(header, :pid)&.to_i,
      seq:     (header_kv(header, :seq) || 0).to_i,
      from:    from_addr,
      channel: (header_kv(header, :channel) || 'default').to_sym,
      data:    body,
      header:  header,
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
    packet = build_packet(kind: 'hb')
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
#
# 架构：
#   <root>/<channel>/<token>      ← 每个 FsNotify 实例一个 token 文件 (token = pid)
#
#   emit(:chat, 'hi') →
#   追加一行到自己的 token 文件（File.open(@file, 'a')）
#   header 一行 + '\n' + payload 一行
#
#   Listen.to(root) 监听 root 下任何文件变化 →
#   handle_event 过滤掉自己 token 的修改 →
#   读取对方的 token 文件，每行一条消息，构造 Message，dispatch_msg
#
# 约定：
#   * 不回环（自己 emit 不触发自己的 callback）
#   * 启动时清理 root 下 pid 已死的过期 token 文件
#   * 单实例支持多 channel
#   * FsNotify 与 SocketNotify 协议一致（HEADER 行 + \n + payload 行）
#     唯一区别：文件必须按行切分，所以 payload 内不能含 \n —— 二进制要先 base64
# ============================================================
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

  def emit(channel, payload, **meta)
    ch = coerce(channel)
    file = File.join(@root, ch.to_s, @token)
    FileUtils.mkdir_p(File.dirname(file))
    body = payload_bytes(payload)
    raise ArgumentError, "FsNotify payload must not contain \\n (#{body.bytesize}B)" if body.include?("\n")
    k = KEYMAP
    line = build_packet(kind: 'msg', channel: ch, body: body, meta: meta.merge(
      k[:name] => @name, k[:pid] => Process.pid, k[:host] => Socket.gethostname
    ))
    File.open(file, 'a') { |f| f.write(line) }
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
      ch = File.basename(File.dirname(path)).to_sym
      next unless @running
      File.foreach(path) do |line|
        line = line.chomp
        next if line.empty?
        header, body = split_packet(line)
        next if header.to_s.empty?
        peer_pid = (basename =~ /\A\d+\z/) ? basename.to_i : nil
        msg = Message.new(
          kind:    header_kv(header, :kind) || 'msg',
          name:    header_kv(header, :name) || "fs-#{peer_pid}",
          host:    header_kv(header, :host),
          pid:     header_kv(header, :pid)&.to_i || peer_pid,
          seq:     header_kv(header, :seq)&.to_i,
          from:    header_kv(header, :name) || basename,
          channel: (header_kv(header, :channel) || ch.to_s).to_sym,
          data:    body,
          header:  header,
        )
        dispatch_msg(msg)
      rescue => e
        warn "[#{@name}] fs parse failed: #{e.class}: #{e.message}"
        next
      end
    end
    removed.each { |_| }   # 暂不处理删除事件
  end
end