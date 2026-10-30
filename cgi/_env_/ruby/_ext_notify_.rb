#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Notify 抽象基类 + SocketNotify (Socket 实现) + FsNotify (文件系统 IPC 实现)
#                          + TcpNotify (TCP 长连接, BDR 协议客户端)
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
#   class TcpNotify      -- Notify 子类：用 TCP 长连接收发（BDR 协议）
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
#   6) TCP 读 socket 时 IO#read(n) 可能返回少于 n 字节（TCP 分段），
#      必须循环读满 —— 一次 read 就当拿齐了会解析出垃圾帧。
#   7) BDR 的连接 id 从 **1** 开始 —— 0 保留给 dst 的「广播」哨兵。
#      判断"帧里有没有 id"要用 nil，不能用 != 0。
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
#   ★ TcpNotify 是例外 —— 它走 BDR 二进制帧协议，没有 HEADER 行。
#
# ★ BDR 帧格式（2026-10 加 dst）：
#     客户端 → 服务端: [len u32 BE][dst 8 字节][payload]
#                   dst = 目标连接 id，0 = 广播给全频道
#     服务端 → 客户端: [len u32 BE][src 8 字节][payload]
#                   ★ 下行**不带 dst** —— 服务端已经按 dst 过滤过了
#                     （只接受 dst == 自己的 id 或 dst == 0），
#                     发到客户端的一定是给自己的。
#                   src = 原始发送者的连接 id
#     握手确认帧:       [len=8][id 8 字节]        ← 不变
#
#   连接 id 从 1 开始，0 永远保留给「广播」哨兵。
#
#   ★ **定向过滤在服务端做**（write_loop 里按 dst 判断）——
#     非目标连接的帧不会写进它的 socket，字节不会流到别的客户端。
#
# Message 字段:
#   kind     — 'msg' | 'hb'
#   name     — 实例名（发送方传入的 name）        ← header n=
#   host     — 发送方主机名                        ← header h=
#   pid      — 发送方进程 pid                      ← header p=
#              ★ TcpNotify 复用这个字段放**连接 id**（BDR 没有 pid 概念）
#   seq      — 发送方递增序号                      ← header s=
#   from     — 发送方标识（socket 是 "ip:port"）    ← 来自 socket 地址，不在 header
#   channel  — Symbol                             ← header c=
#   data     — ★ ASCII-8BIT 原始字节               ← payload
#   header   — 原始 HEADER 行（读自定义 meta 用 msg.header）
#              ★ TcpNotify 里是 "id=<连接id>" 形式
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
#   m.notify(:chat, payload)                    # 发任意二进制
#   m.notify(:chat, payload, tag: 'x')          # 附加自定义 meta 进 HEADER
#
#   m.stop
#
#   f = FsNotify.new('alice', root: '/tmp/notify_fs')
#   f.notify(:file) { |msg| puts msg.data }
#   f.notify(:file, 'hello')
#   f.stop                                     # 删自己的 token 文件
#
#   t = TcpNotify.new('alice', channel: 'room1')
#   t.notify(:room1) { |msg| puts msg.data }
#   t.notify(:room1, 'hello')
#   t.id                                       # 本连接的 id
#   t.stop
#
#   host/port 不传时: 127.0.0.1 + ENV['Cgi_Port']（spider 注入的自己的监听端口），
#   再默认 3000。要连别处就显式传:
#     TcpNotify.new('alice', host: '10.0.0.9', port: 9999, channel: 'room1')

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
    own = own_message?(msg)
    subs.each do |cb, want_echo|
      next if own && !want_echo
      cb.call(msg) rescue warn("[#{@name}] notify callback error: #{$!.class}: #{$!.message}")
    end
  end

  # 这条消息是不是「自己发的」——
  # dispatch_msg 用它决定 want_echo=false 的订阅要不要跳过。
  #
  # 默认按 pid 比对：SocketNotify / FsNotify 都是「同进程 = 自己发的」模型
  # （组播订阅时 want_echo=false 靠这个跳过回环）。
  #
  # TcpNotify 要覆盖成按**连接 id** 比对 —— BDR 协议里发送者身份是
  # 连接 id，同一个进程可以开多个连接（pid 相同但 id 不同），
  # 用 pid 比对会把别的连接的广播也误判成「自己的」。
  def own_message?(msg)
    msg.pid.to_i == Process.pid
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

# ============================================================
# TcpNotify — TCP 长连接广播客户端（对齐 rust TcpBroadcast 的 BDR 协议）
#
# 跟 SocketNotify / FsNotify 的区别:
#   SocketNotify — UDP 组播, 进程间广播, 无中心服务器
#   FsNotify     — 文件 IPC, 进程间广播, 无中心服务器
#   TcpNotify    — TCP 长连接, **有**中心服务器 (spider), 消息由服务端转发
#
# BDR 协议（跟 src/tcp_class/tcp_broadcast_func.rs 严格一致）:
#
#   握手（客户端 -> 服务端）:
#     [0x89 'B' 'R' 'D' 0x0d 0x0a 0x1a 0x00]   8 字节定长魔数
#     + "<channel>\n"                          变长频道名, \n 结尾
#
#   服务端 -> 客户端（握手确认）:
#     [len u32 BE][id 8 字节]                  len == 8
#     id = 本连接的连接 id（u64 大端）—— 客户端收到这条 = 通讯建立
#
#   客户端 -> 服务端:
#     [len u32 BE][payload]                    len == payload.bytesize
#
#   服务端 -> 订阅者（广播）:
#     [len u32 BE][id 8 字节][payload]          len == 8 + payload.bytesize
#     id = 发送者的连接 id
#
# 为什么帧里带长度前缀:
#   TCP 是字节流, 直接广播原始字节的话各客户端的切分点可能不同。
#   长度前缀保证所有订阅者收到的字节流完全一致。
#
# 为什么 id 定长 8 字节:
#   客户端按固定偏移就能把 id 和 payload 切开, 不需要额外长度前缀。
#
# 回环语义:
#   Rust 端用 tokio::broadcast, 消息发给该频道**所有**订阅者,
#   **包括发送者自己**。TcpNotify 保持一致 —— 自己发的自己也收得到。
#   want_echo=false 时按**连接 id** 跳过自己发的。
#   （不能用 pid 判断: 同一个 Ruby 进程可以开多条 TCP 连接, pid 相同但连接不同）
#
# 用法:
#   t = TcpNotify.new('alice', host: '127.0.0.1', port: 3000, channel: 'room1')
#   t.notify(:room1) { |msg| puts msg.data.force_encoding('UTF-8') }
#   t.notify(:room1, 'hello')                 # 发
#   t.id                                       # 本连接的 id (u64)
#   t.stop
#
# ★ 频道在**握手时**就定死了 —— 一条连接只有一个频道。
#   notify(:ch) 的 :ch 只用于本地订阅匹配, 不会发给服务器。
#   要发到别的频道, 得另开一条连接。
# ============================================================
class TcpNotify < Notify
  # 握手魔数 —— 8 字节定长, 必须跟 rust 侧一致
  MAGIC = [0x89, 0x42, 0x52, 0x44, 0x0d, 0x0a, 0x1a, 0x00].pack('C*').freeze

  MAGIC_LEN   = 8
  LEN_PREFIX  = 4          # 长度前缀字节数
  ID_LEN      = 8          # 连接 id 字节数（u64 大端）
  DST_LEN     = 8          # 目标 id 字节数（u64 大端）—— 0 = 广播
  MAX_MSG_LEN = 16 * 1024 * 1024   # 单条消息上限, 跟 rust 侧一致

  # 广播哨兵 —— dst == 0 表示「发给全频道」
  #
  # ★ 连接 id 从 **1** 开始（rust 侧 UID.fetch_add(1)），0 永远保留给这个哨兵。
  #   所以「dst == 0」就是安全的广播判据，不会跟合法连接 id 撞。
  DST_BROADCAST = 0

  DEFAULT_HOST = '127.0.0.1'
  DEFAULT_PORT = 3000

  # 服务端地址
  #
  #   默认 127.0.0.1 + Cgi_Port —— spider 注入的自己的监听端口。
  #   主机名写死 127.0.0.1: BDR 是**本机进程之间**的连接,
  #   而 spider 的 bind 地址可能是 0.0.0.0（监听所有网卡）——
  #   那不是可连接的目标。127.0.0.1 一定通。
  #
  #   要连别处就显式传 host/port:
  #     TcpNotify.new('alice', host: '10.0.0.9', port: 9999, channel: 'room1')
  ENV_CGI_PORT = 'Cgi_Port'

  attr_reader :host, :port, :channel, :id

  # 构造 = 连接 + 握手 + 起读线程
  #
  # @param name    实例名（只用于日志和 header）
  # @param host    服务端地址（默认 127.0.0.1）
  # @param port    服务端端口（默认取 ENV['Cgi_Port']，再默认 3000）
  # @param channel 订阅的频道名（握手时定死）
  def initialize(name, host: nil, port: nil, channel: 'default')
    raise ArgumentError, 'TcpNotify needs name' if name.nil? || name.empty?
    raise ArgumentError, 'TcpNotify needs channel' if channel.nil? || channel.to_s.empty?

    super(name)
    auto_host, auto_port = resolve_endpoint
    @host    = host || auto_host
    @port    = port || auto_port
    @channel = channel.to_s
    @id      = nil
    @sock    = nil
    @stop_pipe_r = nil
    @stop_pipe_w = nil
    # ★ 主动 stop 标志 —— 区分「主动关闭」和「意外断开」。
    #   意外断开要自动重连；主动关闭不能重连（否则进程退出了还在重连）。
    @stopping = false
    # EOF 标记 —— handle_read 返回 false 时置位，loop_main 用它跳出读循环
    @eof = false

    connect!
  end

  # 连接 + 握手 + 起读线程
  #
  # 断了之后可以手动调这个重连（不自动重连 —— 后台悄悄重连很难排查）。
  # 建立 socket 连接 + 握手（**不起线程**）
  #
  # ★ 和 connect! 分开 —— 重连时只需要重新握手，
  #   读线程还在（loop_main 内部调这个）。
  def connect_socket!
    close_socket
    @sock = TCPSocket.new(@host, @port)

    # ---- 握手: 魔数 + 频道名 ----
    @sock.write(MAGIC + @channel.to_s.b + "\n")

    # ---- 读服务端的连接 id: [len u32 BE][id 8 字节] ----
    head = read_exactly(LEN_PREFIX)
    raise IOError, 'BDR handshake EOF at len prefix' if head.nil?
    (len,) = head.unpack('N')
    raise IOError, "BDR handshake bad id len #{len} (expect #{ID_LEN})" if len != ID_LEN

    id_raw = read_exactly(ID_LEN)
    raise IOError, 'BDR handshake EOF at id' if id_raw.nil?
    @id, = id_raw.unpack('Q>')   # Q> = u64 大端
    @id
  end

  def connect!
    connect_socket!

    # ---- 起读线程 ----
    @stop_pipe_r, @stop_pipe_w = IO.pipe
    @running = true
    @loop_thread = Thread.new { loop_main }
    @loop_thread.name = "TcpNotify-#{@name}"
    @loop_thread.abort_on_exception = false

    warn "[#{@name}] up id=#{@id} host=#{@host}:#{@port} channel=#{@channel}"
    self
  end

  # 断开并重连 —— 保留已有的订阅
  def reconnect!
    connect!
  end

  def connected?
    @running && !@sock.nil? && !@sock.closed?
  end

  def stop
    return self unless @running
    # ★ 主动关闭 —— 不要触发自动重连
    @stopping = true
    @running = false
    @stop_pipe_w&.write_nonblock('.') rescue nil
    @loop_thread&.join(2)
    close_socket
    # ★ stop pipe 在这里关（close_socket 不再管它 —— 那是读线程的生命周期）
    @stop_pipe_w&.close rescue nil
    @stop_pipe_r&.close rescue nil
    @stop_pipe_w = nil
    @stop_pipe_r = nil
    warn "[#{@name}] down id=#{@id}"
    self
  end

  # 消息来源标识 —— BDR 里没有 "host:port" 这种 from, 用连接 id
  def peer_id; @id; end

  # 定向发送 —— 只发给某一个连接（dst != 0）
  #
  #   t.send_to(7, 'hello')       # 只发给连接 id = 7 的那个连接
  #   t.send_to(nil, 'hello')     # nil → 广播（等价于 notify）
  #
  # **服务端在 write_loop 里做过滤** —— 非目标连接的帧不会写进它的 socket，
  # 所以定向消息的字节不会流到别的客户端（保密性有保证）。
  #
  # @param dst 目标连接的 id（从对端的握手确认帧里拿到）
  def send_to(dst, payload, channel: nil)
    d = dst.to_i
    d = DST_BROADCAST if d <= 0
    send_msg(coerce(channel || @channel), payload, {}, dst: d)
  end

  protected

  # TcpNotify 不走 HEADER 协议 —— BDR 是二进制帧, 没有 header 行。
  # header_fields 只在 build_packet 里用, 这里用不到。
  def header_fields; []; end

  def do_send_packet(packet)
    @sock.write(packet)
  end

  # BDR 没有 "HEADER + payload" 这一层 —— 帧是纯二进制。
  # 发送路径直接写 [len u32 BE][dst 8 字节][payload]。
  #
  # @param dst 目标连接 id —— 0（默认）= 广播给全频道；
  #              其它值 = 只发给那一个连接（服务端在 write_loop 里过滤）。
  def send_msg(channel, payload, meta = {}, dst: DST_BROADCAST)
    body = payload_bytes(payload)
    return self if body.bytesize > MAX_MSG_LEN
    d = dst.to_i
    d = DST_BROADCAST if d.negative?
    frame = [DST_LEN + body.bytesize].pack('N') +
            [d].pack('Q>') +
            body
    @send_mutex.synchronize { do_send_packet(frame) }
    self
  end

  # BDR 不需要 —— 收到的是二进制帧, 直接在读线程里解析。
  def parse_packet(_data, _addr); raise NotImplementedError; end

  # 业务消息分发 —— 覆盖基类。
  #
  # 基类用 `msg.pid == Process.pid` 判断"自己发的", 但 BDR 的发送者身份是
  # **连接 id**: 同一个 Ruby 进程可以开多条 TCP 连接, pid 相同但连接不同,
  # 按 pid 判断会误杀别的连接发来的消息。
  #
  # 这里的 own = (帧里的 id == 本连接的 id)。
  #
  # ★ 连接 id 从 1 开始（0 保留给 dst 的广播哨兵），但这里仍然用
  #   nil 判断「有没有 id」而不是 `id != 0` —— 语义更明确，不依赖
  #   「id 不会是 0」这个前提。
  def dispatch_msg(msg)
    subs = @notify_lock.synchronize { (@subs[msg.channel] || []) + (@subs[:default] || []) }
    from_id = msg.pid
    own = !from_id.nil? && !@id.nil? && from_id.to_i == @id.to_i
    subs.each do |cb, want_echo|
      next if own && !want_echo
      cb.call(msg) rescue warn("[#{@name}] notify callback error: #{$!.class}: #{$!.message}")
    end
  end

  private

  # 解析服务端地址 —— 返回 [host, port]
  #
  # 默认: 127.0.0.1 + Cgi_Port（spider 注入的自己的监听端口）
  # 显式传的 host/port 优先（见 initialize）。
  def resolve_endpoint
    [DEFAULT_HOST, injected_port || DEFAULT_PORT]
  end

  # spider 注入的端口 (Cgi_Port) —— 没有或非法就 nil
  def injected_port
    v = ENV[ENV_CGI_PORT].to_s.strip
    return nil if v.empty?
    n = v.to_i
    n > 0 ? n : nil
  end

  # 读线程主循环 —— IO.select 挂在 socket + stop pipe 上
  #
  # ★ **断线自动重连**（2026-10-30 加）
  #
  #   之前：socket EOF → handle_read 里 `return if head.nil?` →
  #         回到 while 继续循环 → IO.select 对已 EOF 的 socket
  #         **立即返回** → 100% CPU 忙循环，
  #         而且**永远收不到广播**（socket 已经死了）。
  #
  #   症状：客户端页面看着一切正常（WS 连接还在），
  #         但别人的编辑/广播**永远收不到** ——
  #         「有时候是自己没反应，有时候是对面没反应」
  #         （取决于谁的 BDR 连接先断）。
  #
  #   现在：EOF/异常 → 退出循环 → 退避重连 → 恢复。
  def loop_main
    backoff = 0.5
    while @running
      @eof = false
      begin
        rd, = IO.select([@sock, @stop_pipe_r], nil, nil, 0.5)
        unless rd
          next
        end
        rd.each do |io|
          break if io.equal?(@stop_pipe_r)
          # ★ handle_read 返回 false = EOF → 标记，跳出读循环去重连
          unless handle_read(io)
            @eof = true
            break
          end
        end
        backoff = 0.5 if backoff > 0.5    # 成功读到东西 → 重置退避
      rescue IOError, Errno::ECONNRESET, Errno::EPIPE, Errno::ECONNABORTED => e
        warn "[#{@name}] loop io error: #{e.class}: #{e.message}" if @running
        @eof = true
      rescue => e
        warn "[#{@name}] loop crashed: #{e.class}: #{e.message}" if @running
        @eof = true
      end

      # ★ 读线程断了（EOF / 异常）—— **在循环内部**重连。
      #
      #   为什么必须在循环内部：重连后要**继续读**，
      #   如果在 ensure 里重连，那个线程马上就结束了，
      #   新 socket 没人读 → 还是收不到广播。
      #
      #   ★ 为什么不能直接 `break` 跳出 while ——
      #     break 会跳过下面这段重连代码（break 直接跳到循环外）。
      #     要用「标志 + 继续循环」的方式。
      #
      #   用 connect_socket!（不起新线程）—— 当前就在读线程里。
      next unless @eof
      break if @stopping
      attempt = 0
      until @stopping
        attempt += 1
        delay = [0.5 * (2 ** [attempt - 1, 6].min), 30.0].min
        warn "[#{@name}] disconnected, reconnecting in #{delay}s (attempt #{attempt})"
        sleep(delay)
        break if @stopping
        begin
          connect_socket!
          warn "[#{@name}] reconnected id=#{@id}"
          backoff = 0.5
          @eof = false
          break
        rescue => e
          warn "[#{@name}] reconnect failed: #{e.class}: #{e.message}"
        end
      end
    end
  ensure
    @running = false
  end

  # 读一帧: [len u32 BE][src 8 字节][payload]
  #
  # ★ 下行帧**不带 dst** —— 服务端在 write_loop 里已经按 dst 过滤过了
  #   （只接受 dst == 自己的 id 或 dst == 0），发到这里的一定是给自己的。
  #   所以客户端**不需要**再判断目标是谁，收到就处理。
  #
  # src 是原始发送者的连接 id —— 客户端据此知道消息是谁发的。
  #
  # ★ 握手确认帧（[len=8][id 8]）在 connect! 里就读掉了，读线程起得更晚，
  #   所以这里只会看到广播帧。
  def handle_read(io)
    head = read_exactly(LEN_PREFIX)
    # ★ EOF —— 对端关闭。
    #   返回 false → loop_main 退出 while 去重连。
    #
    #   ★ 不能只 `return`（回到 while 继续循环）——
    #     IO.select 对已 EOF 的 socket **立即返回** → 100% CPU 忙循环，
    #     而且永远收不到广播。
    #   ★ 也不能设 @running = false —— 那样 while 直接结束，
    #     走不到重连那段代码。
    if head.nil?
      warn "[#{@name}] EOF from peer" if @running
      return false
    end
    (len,) = head.unpack('N')

    if len < ID_LEN
      warn "[#{@name}] bad frame len #{len} (< #{ID_LEN})"
      return
    end

    body = read_exactly(len)
    return if body.nil?                     # 帧不完整 —— 丢弃

    id_raw = body[0, ID_LEN]
    payload = body[ID_LEN..] || ''.b
    (from_id,) = id_raw.unpack('Q>')

    # id 塞进 header（按约定不扩展 Message 结构, 应用层自己读）
    # header 用 "id=<n>" 的形式, 跟自定义 meta 一个路子
    header = "id=#{from_id}"
    ch = (@channel || 'default').to_sym

    msg = Message.new(
      kind:    'msg',
      name:    nil,
      host:    nil,
      pid:     from_id,        # 借用 pid 字段放连接 id（own 判断要用）
      seq:     nil,
      from:    from_id.to_s,
      channel: ch,
      data:    payload,
      header:  header,
    )
    dispatch_msg(msg)
    true                                   # ← 正常读到一帧
  rescue IOError, Errno::ECONNRESET, Errno::EPIPE => e
    warn "[#{@name}] read failed: #{e.class}: #{e.message}" if @running
    false                                  # ← 读失败 → 去重连
  end

  # 读满 n 字节 —— EOF 返回 nil
  #
  # IO#read(n) 在 socket 上可能返回少于 n 字节（TCP 分段），
  # 所以必须循环读满。
  def read_exactly(n)
    buf = ''.dup.force_encoding(Encoding::ASCII_8BIT)
    while buf.bytesize < n
      chunk = @sock.read(n - buf.bytesize)
      return nil if chunk.nil?      # EOF
      break if chunk.empty?
      buf << chunk
    end
    buf
  end

  def close_socket
    # ★ **只关 socket，不动 stop pipe** ——
    #   stop pipe 是**读线程的生命周期**，不是连接的。
    #   重连时（connect_socket! → close_socket）如果把 stop pipe 关了，
    #   loop_main 里的 IO.select([@sock, @stop_pipe_r]) 就拿到 nil
    #   → TypeError: no implicit conversion of nil into IO
    #   → 线程崩 → 又触发重连 → 无限循环。
    @sock&.close rescue nil
    @sock = nil
  end
end