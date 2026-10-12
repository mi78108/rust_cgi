#!/usr/bin/env ruby
# frozen_string_literal: true
# _base_.rb — Spider CGI 框架（v2 重写版）
#
# 设计原则：
#   * 显式方法签名 > method_missing 魔法（魔法仅作体验糖）
#   * ENV 契约文档化（Req_* 子进程只读；Cgi_Root 由 spider 设）
#   * 一次性请求生命周期：method / path / params / argv / headers / body
#   * chainable Rsp，响应写完 throw :q_resp_sent :handled，由 Q.route catch 住
#   * 渲染模板用 @<{}>，eval 在 binding，捕获 StandardError + ScriptError
#
# ENV 契约（rust_cgi 提供，子进程只读）：
#   CGI:
#     Cgi_Root          绝对路径，cgi 脚本根目录
#
#   请求行:
#     Req_Method        GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS
#     Req_Path          不含 query 的 URL path
#     Req_Version       HTTP/1.0 / HTTP/1.1
#     Req_Params        原始 query 字符串（未解码；自动解析见 req.params）
#     Req_Body_Method   HTTP / WEBSOCKET
#
#   restful argv:
#     Req_Argv_N        第 N 个段，从 1 开始
#     Req_Argv_Params   段们 / 拼接
#     Req_Argv_Count    段个数
#
#   脚本定位:
#     Req_Script_Path     绝对文件路径
#     Req_Script_Name     /<相对 cgi 根的路径>
#     Req_Script_Basename 文件名
#     Req_Script_Dir      父目录
#
#   对端:
#     Req_Peer_Ip / Req_Peer_Port / Req_Peer_Addr
#
#   其他:
#     Req_Buffer_Size     stdin/stdout buffer hint（字节）
#     content-type / content-length / *   原始 HTTP header（小写 key）
#
# 公开 API（推荐用法）:
#   require_relative '_base_'
#
#   Q.route '/foo', method: :GET do |req, rsp|
#     rsp.ok_json(req.params)
#   end
#
#   Q.route %r{^\/users\/(?<id>\d+)$}, method: :GET do |req, rsp|
#     rsp.ok_json(id: req.named(:id))
#   end
#
# 所有访问器支持默认值（统一第二参数，默认 nil）：
#   req.param('user', 'guest')           # query 参数
#   req.header('host', 'unknown')        # HTTP header
#   req.cookie('seen')                   # Cookie
#   req.named(:id, 0)                    # 命名捕获组
#   req.argv(0, 'none')                  # restful 第 0 段
#
# Pattern 规则（对照 Q::MAP_PATH）:
#   '/'             匹配 restful 为空（脚本本身调用）
#   '/info'         精确路径
#   '/*'            通配所有非空 restful 路径
#   '/users/<id>'   命名捕获（自动转 (?<id>[^/]+)）
#   /^\/users\/(?<id>\d+)$/  正则（/ 必须显式写）
#   nil             兜底（总是匹配）
#
#   写不写 ^/$ 锚点都行——外层用 \A/\z 统一包。
#   不以 / 开头 → 抛 ArgumentError。

require 'json'
require 'uri'
require 'pathname'      # Q::Body.wrap 智能识别 Pathname → FileBody
require 'stringio'
require 'cgi'           # CGI.unescape / CGI.parse（query / cookie 解析）

# ============================================================
# QEnv — ENV 工具（顶层 module，避免与 class Q 冲突）
# ============================================================
module QEnv
  SNAPSHOT = ENV.to_h.freeze

  def self.fetch(key, default = nil)
    val = SNAPSHOT[key]
    return default if val.nil? || val.empty?
    val
  end

  def self.fetch_i(key, default = 0)
    v = SNAPSHOT[key]
    return default if v.nil? || v.empty?
    v.to_i
  end

  def self.decode(s)
    CGI.unescape(s.to_s)
  end
end

# ============================================================
# Q::Req — 请求对象
# ============================================================
class Q
  # restful 段一次性冻结（按 Req_Argv_N 顺序）
  ARGV = ENV.keys
          .select { |k| k =~ /\AReq_Argv_\d+\z/ }
          .sort_by { |k| k.split('_').last.to_i }
          .map { |k| QEnv.decode(ENV[k]) }
          .freeze

  # 最近一次命名捕获组 hash（regex 匹配后填充）
  MATCH = {}

  CGI_ROOT        = QEnv.fetch('Cgi_Root', Dir.pwd).freeze
  REQ_METHOD      = QEnv.fetch('Req_Method', 'GET').freeze
  REQ_PATH        = QEnv.fetch('Req_Path', '/').freeze
  REQ_PARAMS      = QEnv.fetch('Req_Params', '').freeze
  REQ_VERSION     = QEnv.fetch('Req_Version', 'HTTP/1.1').freeze
  BODY_METHOD     = QEnv.fetch('Req_Body_Method', 'HTTP').freeze
  PEER_IP         = QEnv.fetch('Req_Peer_Ip', '').freeze
  PEER_PORT       = QEnv.fetch_i('Req_Peer_Port', '0')
  PEER_ADDR       = "#{PEER_IP}:#{PEER_PORT}".freeze
  BUFFER_SIZE     = QEnv.fetch_i('Req_Buffer_Size', 131_072)
  ARGV_COUNT      = QEnv.fetch_i('Req_Argv_Count', 0)
  ARGV_PARAMS     = QEnv.fetch('Req_Argv_Params', '').freeze
  MAP_PATH        = "/#{ARGV_PARAMS}"  # restful 部分（空时 = '/'），路由匹配基准

  class Req
    attr_reader :method, :path, :query, :body_type, :body_length

    def initialize
      @method      = Q::REQ_METHOD
      @path        = Q::ARGV_PARAMS.empty? ? '/' : "/#{Q::ARGV_PARAMS}"  # restful 路径部分
      @query       = Q::REQ_PARAMS
      @body_type   = QEnv.fetch('content-type', '')
      @body_length = QEnv.fetch_i('content-length', 0)
      @params      = nil
      @cookies     = nil
    end

    # --- restful argv ---
    def argv(idx, default = nil)
      v = Q::ARGV[idx] if idx.is_a?(Integer) && idx >= 0 && idx < Q::ARGV.size
      v.nil? ? default : v
    end

    def argv_count
      Q::ARGV_COUNT
    end

    # --- 命名捕获组 ---
    def named(name, default = nil)
      v = Q::MATCH[name.to_sym]
      v ||= Q::MATCH[name.to_s]
      v.nil? ? default : v
    end

    # --- query 参数 ---
    def params
      @params ||= parse_query(@query)
    end

    def param(key, default = nil)
      v = params[key.to_s]
      # CGI.parse 对每个 key 都返回 Array（可能是空 Array）。空 Array 当 missing。
      if v.nil? || (v.is_a?(Array) && v.empty?)
        return default
      end
      v.is_a?(Array) ? v.first : v
    end

    # --- HTTP headers ---
    def header(name, default = nil)
      QEnv::SNAPSHOT[name.to_s.downcase] || default
    end

    # --- cookies ---
    def cookies
      @cookies ||= parse_cookies(header('cookie', ''))
    end

    def cookie(name, default = nil)
      v = cookies[name.to_s]
      return default if v.nil?
      v.is_a?(Array) ? v.first : v
    end

    # --- body ---
    def body(length = @body_length)
      return nil if @body_length.zero?
      Q.read(length)
    end

    # 解析 body 为 JSON Hash/Array。90% POST JSON 的标准模式。
    #   data = req.body_json   # 自动 rescue JSON::ParserError → nil
    #   data ||= {}            # 拿不到时空 hash
    # body 为空也返 nil（不抛错）。
    def body_json
      raw = body
      return nil if raw.nil? || raw.empty?
      JSON.parse(raw)
    rescue JSON::ParserError
      nil
    end

    # body 原始字符串（与 body 等价，提供语义化名字用于非 JSON/form 场景）。
    def body_text
      body
    end

    # --- multipart/form-data ---
    def body_form_data(&block)
      return nil unless @body_type.include?('form-data')
      boundary = @body_type.split('boundary=', 2).last
      Q::Form.parse(boundary, &block)
    end

    # --- method_missing 糖 ---
    def respond_to_missing?(name, include_private = false)
      s = name.to_s
      return true if s.start_with?('argv_', 'param_', 'header_', 'named_', 'cookie_')
      super
    end

    def method_missing(name, *_args)
      s = name.to_s
      return argv(s.split('_', 2).last.to_i) if s.start_with?('argv_')
      return param(s.split('_', 2).last)     if s.start_with?('param_')
      return header(s.split('_', 2).last)    if s.start_with?('header_')
      return named(s.split('_', 2).last)     if s.start_with?('named_')
      return cookie(s.split('_', 2).last)    if s.start_with?('cookie_')
      super
    end

    private

    def parse_query(qs)
      return {} if qs.nil? || qs.empty?
      CGI.parse(qs)
    rescue StandardError
      {}
    end

    def parse_cookies(raw)
      return {} if raw.nil? || raw.empty?
      out = {}
      raw.split(/;\s*/).each do |pair|
        k, v = pair.split('=', 2)
        next if k.nil? || k.empty?
        out[CGI.unescape(k)] = CGI.unescape(v.to_s)
      end
      out
    end
  end
end

# ============================================================
# Q::Body — 响应 body 抽象
#   size           → Integer 字节数（已知）or nil（未知，要走 chunked）
#   each_chunk     → yield 一段段 bytes（调用方负责循环到底）
# Rsp#finish 据 size 决定 Content-Length 还是 Transfer-Encoding: chunked。
#
# 命名避坑：Body 下的子类用 TextBody / FileBody / StreamBody，
# 不用 String / File / Stream —— 避免嵌套 Ruby 类查找时 `::String` 歧义。
# ============================================================
class Q
  module Body
    # 抽象基类
    class Base
      def size;        raise NotImplementedError, "#{self.class}#size";        end
      def each_chunk(chunk_size = Q::BUFFER_SIZE, &block); raise NotImplementedError, "#{self.class}#each_chunk"; end
    end

    # 工厂方法：根据 v 的类型自动包成对应 Q::Body 子类
    #   wrap('hello')              → TextBody
    #   wrap('/path/to/file')      → FileBody（自动检测字符串路径）
    #   wrap(Pathname.new('...'))  → FileBody
    #   wrap(IO / StringIO)        → StreamBody（按 BUFFER_SIZE 读）
    #   wrap(proc { |emit| ... })  → StreamBody
    #   wrap(&block)               → StreamBody.new(&block)
    #   wrap(Q::Body 实例)         → 原样返回
    #   wrap(nil)                  → TextBody.new('')
    def self.wrap(v = nil, &block)
      return TextBody.new('') if v.nil? && block.nil?

      case v
      when Base        then v
      when String
        # 如果 string 路径指向真实文件，当 FileBody（不复制内容）
        File.file?(v) ? FileBody.new(v) : TextBody.new(v)
      when Pathname    then FileBody.new(v.to_s)
      when Proc        then StreamBody.new(&v)
      when IO, StringIO
        # IO / File / Socket / StringIO 任何"可读字节流"对象都当 StreamBody：
        # each_chunk 时按 BUFFER_SIZE 读，yield 数据块。size 未知 → chunked。
        # 注意 IO 在 each_chunk 结束后**不**自动关闭（caller 自己关）。
        StreamBody.new do |emit|
          while (chunk = v.read(Q::BUFFER_SIZE))
            emit.call(chunk)
          end
        end
      when nil
        unless block.nil?
          StreamBody.new(&block)
        end
      else
        Q.log "body wrap unimplemented #{v} | #{block}"
      end
    end

    # 内存字符串 body。
    class TextBody < Base
      def initialize(str); @str = str.to_s; end
      def size; @str.bytesize; end
      def each_chunk(chunk_size = Q::BUFFER_SIZE); yield @str; end
      def to_s; @str; end
      alias_method :bytes, :to_s
    end

    # 静态文件 body。
    # each_chunk 按参数 chunk_size 分块 yield（默认 Q::BUFFER_SIZE），避免大文件一次性吃光内存。
    class FileBody < Base
      attr_reader :path, :size

      def initialize(path)
        @path = path
        @size = File.stat(path).size
      end

      def each_chunk(chunk_size = Q::BUFFER_SIZE)
        File.open(@path, 'rb') do |f|
          while (chunk = f.read(chunk_size))
            yield chunk
          end
        end
      end
    end

    # 块生成器 body。size 永远 nil（未知 → chunked）。
    class StreamBody < Base
      def initialize(&cbk)
        @cbk = cbk
      end

      def size; nil; end
      def each_chunk(chunk_size = Q::BUFFER_SIZE, &emit)
        @cbk.call(emit, chunk_size)
      end
    end
  end
end

# ============================================================
# Q::Rsp — 响应构造器（chainable + 幂等 finish）
# ============================================================
class Q
  class Rsp
    DEFAULT_HEADERS = {
      'Connection'   => 'close',
      'Content-Type' => 'text/html; charset=utf-8',
    }.freeze

    attr_reader :header, :sent

    # chainable setter + getter（then 风格 sentinel）。
    # 用唯一 Object 实例作为哨兵，避免和任何用户传值冲突。
    #   rsp.code(200)        # 设
    #   rsp.code             # 读，返回 @code
    #   rsp.code(200).body   # 链式
    RSP_READ = Object.new
    private_constant :RSP_READ

    def code(v = RSP_READ)
      return @code if v.equal?(RSP_READ)
      @code = v
      self
    end

    def status(v = RSP_READ)
      return @status if v.equal?(RSP_READ)
      @status = v
      self
    end

    # then-style sentinel chainable setter + getter for body
    #   rsp.body('hello')           # 字符串 → TextBody
    #   rsp.body('/path/to/file')   # 文件路径 → FileBody
    #   rsp.body { |emit| ... }     # block  → StreamBody
    #   rsp.body(Q::Body::*)        # Body 实例 → 原样
    #   rsp.body                    # 0 参 → 读，返回当前 body 对象
    def body(v = RSP_READ, &block)
      return @body if v.equal?(RSP_READ) && block.nil?

      @body = if v.equal?(RSP_READ)
                Q::Body.wrap(nil, &block)
              else
                Q::Body.wrap(v, &block)
              end
      self
    end

    # = setter：rsp.body = "..." 形式（与 body(v) 等价，chainable）
    # def body=(v)
    #   @body = Q::Body.wrap(v)
    #   @streaming = true if @body.is_a?(Q::Body::StreamBody)
    #   self
    # end

    def initialize
      @code        = 200
      @status      = 'OK'
      @body        = Q::Body::TextBody.new('')
      @header      = DEFAULT_HEADERS.dup
      @sent        = false
      @chunking   = false
    end

    # --- Content-Type 快捷 ---
    def type(v);  @header['Content-Type'] = v; self; end
    def type_json; type('application/json; charset=utf-8'); self; end
    def type_html; type('text/html; charset=utf-8');     self; end
    def type_text; type('text/plain; charset=utf-8');    self; end
    def type_xml;  type('application/xml; charset=utf-8'); self; end
    def type_bin(mime = 'application/octet-stream'); type(mime); self; end

    # 文件相关 header 快捷：设 Content-Type + Content-Disposition。
    # 文件不存在时返 404 + "file not found: <path>" 文本。
    #   rsp.type_file('/path/to/img.png', mime: 'image/png', download_as: 'logo.png')
    #   rsp.body('/path/to/img.png')    # body(wrap) 自动识别路径 → FileBody
    def type_file(path, mime: nil, download_as: nil)
      unless ::File.readable?(path)
        fail_404.type_html.body("file not found: #{path}")
        return self
      end
      type(mime) if mime
      @header['Content-Disposition'] =
        download_as ? %(attachment; filename="#{download_as}") : 'inline'
      self
    end

    # --- 自定义 header ---
    def header_field(name, value)
      @header[name] = value
      self
    end

    def header_remove(name)
      @header.delete(name)
      self
    end

    # Set-Cookie（多次调用会累加成多个 Set-Cookie header）
    def cookie_set(name, value, max_age: nil, path: '/', httponly: false, secure: false, samesite: nil)
      parts = ["#{name}=#{value}", "Path=#{path}"]
      parts << "Max-Age=#{max_age}"  if max_age
      parts << 'HttpOnly'             if httponly
      parts << 'Secure'               if secure
      parts << "SameSite=#{samesite}" if samesite
      cookie_field = parts.join('; ')
      existing = @header['Set-Cookie']
      @header['Set-Cookie'] = existing ? "#{existing}\r\nSet-Cookie: #{cookie_field}" : cookie_field
      self
    end

    # --- 200 OK 快捷构造 ---
    #   rsp.ok('hello')
    #   rsp.ok_json({a: 1}).type_html.body('x')   # 也可链上其他 setter
    def ok(body_str)
      code(200).status('OK').body(body_str)
      self
    end
    def ok_html(text); type_html; ok(text); end
    def ok_json(obj)
      type_json
      ok(obj.nil? ? '' : JSON.generate(obj))
    end
    def ok_text(text); type_text; ok(text); end
    def ok_xml(text);  type_xml;  ok(text); end

    # --- 错误状态构造器（无 body / 无默认 type —— 由调用方链 type_xxx + body）---
    #   rsp.fail_404.type_json.body({error: 'not found'}.to_json)
    #   rsp.fail_500.type_html.body('<h1>boom</h1>')
    def fail_400; code(400).status('Bad Request');                 self; end
    def fail_403; code(403).status('Forbidden');                   self; end
    def fail_404; code(404).status('Not Found');                   self; end
    def fail_405; code(405).status('Method Not Allowed');          self; end
    def fail_500; code(500).status('Internal Server Error');       self; end
    def fail_501; code(501).status('Not Implemented');             self; end

    # 重定向（默认 302）
    def redirect_to(loc, code: 302, body: '')
      self.code(code).status(code == 301 ? 'Moved Permanently' : 'Found').type_html
      @header['Location'] = loc
      @body = Q::Body::TextBody.new(body)
      self
    end

    # 兼容旧 send_file：type_file + body 的组合。
    #   rsp.send_file('/path/to/img.png', download_as: 'logo.png')
    def send_file(path, download_as: nil, mime: nil)
      type_file(path, mime: mime, download_as: download_as)
      # type_file 文件不存在时已 fail_404 并设了错误消息 body，不要覆盖
      body(path) if @code == 200
      self
    end

    # 流式响应：切换到 Transfer-Encoding: chunked。
    #
    # 3 种用法：
    #   1) rsp.stream { |i| i < 10 ? "frame #{i}\n" : nil }
    #      生成器风格 —— block 收 i 计数，返回 chunk；返回 nil / "" / false 停止。
    #      max 防 block 永远 truthy 的无限循环（默认 1024）。
    #
    #   2) rsp.body(File.open(path)) { ... }   # body(IO) 已设 StreamBody
    #      rsp.stream                              # 切 chunked，让 finish yield each_chunk
    #      body 是 StreamBody 时，stream 不重复发 headers、不发 chunks。
    #
    #   3) rsp.stream                              # 无 block：单纯切 chunked 模式
    #      headers 发出去，body 留空给 finish 时通过 each_chunk yield。
    def stream(chunk_size = BUFFER_SIZE, &block)
        return self if @chunking

      # 切 chunked 模式：发 headers + 标记 streaming
      @header.delete('Content-Length')
      @header['Transfer-Encoding'] = 'chunked'
      Q.write_headers(@header, transfer_encoding: 'chunked', code: @code, status: @status)
        @chunking = true
      unless block
        @body.each_chunk(chunk_size) do |chunk|
          Q.write_chunk(chunk)
        end
        Q.write_chunk_end
        return self
      end

      i = 0
      while (data = block.call(i))
        break if data.nil? || data.size == 0 || data == false
        Q.write_chunk(data)
        i += 1
      end
      Q.write_chunk_end
      self
    end

    # 单 chunk 流式：把 block 返回值当一个 chunk frame 发出。
    # 链式可调多次发多个 chunk，最后调 rsp.finish 触发 write_stream_end。
    #   rsp.chunk { "hello\n" }.chunk { Time.now.to_s + "\n" }.finish
    # def stream(chunk_size = BUFFER_SIZE, &block)
    #   unless @chunking
    #     type(content_type)
    #     Q.write_headers(@header, transfer_encoding: 'chunked', code: @code, status: @status)
    #     @chunking = true
    #   end
    #   data = block&.call
    #   Q.write_chunk(data.to_s) if data
    #   self
    # end
    #
    # --- 模板渲染 ---

    # 模板渲染：@<{}> 在 ctx 上 eval；异常 → "[ERROR: msg]"
    #
    # 只接受 hash：rsp.render(key: value, ...) —— hash 转成 ctx 局部变量
    # 块内局部变量（如 user/title）通过 rsp.set(hash) 注入到 rsp 实例变量，
    # render 会自动把 rsp 实例变量导入 ctx，@<{}> 可访问。
    #
    # 用法：
    #   Q.route '/x' do |req, rsp|
    #     rsp.set(title: '事件统计', user: req.param('user', 'alice'))
    #     rsp.body '<h1>@<{title}></h1><p>@<{user}></p>'
    #     rsp.render                          # → @<{}> 看到 title/user
    #
    #     # 或者直接 inline（hash 一次性注入）：
    #     rsp.render(title: '事件统计', user: req.param('user', 'alice'))
    #   end
    #
    # 优先级（覆盖关系，后注入的赢）：
    #   1. rsp 实例变量（@header / @code / rsp.set 注入的 @xxx）
    #   2. render 的 hash 参数（最高优先级，hash key 覆盖前面所有同名变量）
    #
    # @<{}> 内的 eval 被 Q.capture_stdout 包住，模板内 puts/print 输出会进入 body。
    def render(**vars_hash)
      #Q.log(@body.to_s)
      ctx = binding
      instance_variables.each do |iv|
        name = iv.to_s.delete_prefix('@')
        next if name.empty? || name == '_'
        ctx.local_variable_set(name, instance_variable_get(iv))
      end
      vars_hash.each { |k, v| ctx.local_variable_set(k.to_s, v) }
      rendered = @body.to_s.gsub(%r|@<{(?<code>.*?)}>|m) do |match|
        code = $~[:code]
        Q.log "render match code=#{code}"
        begin
          captured = Q.capture_stdout do
            ret  = ctx.eval(code).to_s
            Q.log "render eval=#{ret}"
          end
          Q.log "render replaced=#{captured}"
          captured
        rescue StandardError, ScriptError => e
          err = "[ERROR: #{e.class}: #{e.message}]"
          Q.log "render error=#{err}"
          err
        end
      end
      @body = Q::Body::TextBody.new(rendered)
      self
    end

    # 给模板 @<{}> 注入变量（链式 render 时用：rsp.html(p).render { rsp.set(...) }）
    def set(key, value = nil)
      if key.is_a?(Hash)
        key.each { |k, v| instance_variable_set("@#{k}", v) }
      else
        instance_variable_set("@#{key}", value)
      end
      self
    end

    # 一次性发送（幂等）。改名为 finish 避免覆盖 Object#send。
    #
    # 三种 body 源 × 两种协议（Content-Length / chunked）：
    #   1) @body 是 StreamBody（body(IO/block/Proc) 设的）→ 走 each_chunk
    #   2) streaming? + @body.size 已知 → yield body 当 chunk + end frame
    #   3) streaming? 已发完所有 chunks（老 stream 路径）→ finish 不动
    #   4) @body.size 已知 → Content-Length
    #   5) size 未知（空 body）→ Content-Length: 0
    #
    # 写完响应后抛 :q_resp_sent（带 :handled arg），Q.route catch 住跑 on_close + exit 0。
    def finish
      return self if @sent
      @sent = true
      Q::STATE[:responded] = true
      unless @chunking
        if @body.size
          Q.write_headers(@header, content_length: @body.size, code: @code, status: @status)
          @body.each_chunk { |chunk| Q.write(chunk, true) }
        else
          Q.write_headers(@header, content_length: 0, code: @code, status: @status)
        end
        throw :q_resp_sent, :handled
      end
      Q.log "stream ..."
      throw :q_resp_sent, :handled
    end
  end
end

# ============================================================
# Q::Form / Q::FormItem — multipart/form-data 解析
# ============================================================
class Q
  class FormItem
    attr_reader :name, :filename, :content_type, :content

    def initialize(header, content)
      cd = (header['Content-Disposition'] || '').split(';').map(&:strip)
      name = nil
      filename = nil
      cd.each do |seg|
        k, v = seg.split('=', 2)
        next unless v
        v = v.gsub(/\A"|"\z/, '')
        name = v if k == 'name'
        filename = v if k == 'filename'
      end
      @name = name
      @filename = filename
      @content_type = header['Content-Type'] || 'text/plain'
      @content = content
    end

    def file?
      !@filename.nil? && !@filename.empty?
    end

    def to_h
      {
        name: @name,
        filename: @filename,
        content_type: @content_type,
        size: @content.bytesize,
      }
    end
  end

  class Form
    attr_reader :items

    def self.parse(boundary, &block)
      return nil unless boundary
      boundary = boundary.strip
      items = []
      STDIN.readline # 丢弃首行 CRLF
      loop do
        headers = {}
        while (line = STDIN.readline.chomp) != ''
          next unless line.include?(':')
          k, v = line.split(':', 2)
          headers[k.strip] = v.strip
        end
        content = +''
        finish_marker = nil
        loop do
          line = STDIN.readline
          if line.start_with?("--#{boundary}--\r\n") || line.start_with?("--#{boundary}--\n") || line.chomp == "--#{boundary}--"
            finish_marker = :final
            break
          elsif line.start_with?("--#{boundary}--") || line.start_with?("--#{boundary}")
            finish_marker = :more
            break
          else
            content << line
          end
        end
        content.chomp! # 去末尾 CRLF
        item = FormItem.new(headers, content)
        items << item
        block&.call(item)
        break if finish_marker == :final
      end
      new(items)
    end

    def initialize(items)
      @items = items
    end

    def [](name)
      @items.find { |i| i.name == name.to_s }
    end

    def each_file
      return enum_for(:each_file) unless block_given?
      @items.each { |i| yield i if i.file? }
    end

    def files_count
      @items.count(&:file?)
    end
  end
end

# ============================================================
# Q — 路由 + I/O + lifecycle
# ============================================================
class Q
  ONCLOSE_CBS = []
  STATE     = { responded: false }
  class << self
    # --- 脚本定位 ---
    def script_name;     ENV.fetch('Req_Script_Name', nil);     end
    def script_basename; ENV.fetch('Req_Script_Basename', nil); end
    def script_path;     ENV.fetch('Req_Script_Path', nil);     end
    def script_dir;      ENV.fetch('Req_Script_Dir', nil);      end

    # 脚本工作目录：脚本所在 dir（不是 URL 上的 restful 路径）
    def script_cwd
      dir = ENV['Req_Script_Dir']
      dir unless dir.nil? || dir.empty?
    end
    alias_method :cwd, :script_cwd

    # --- I/O ---
    def read(length = nil)
      length.nil? || length <= 0 ? STDIN.read : STDIN.read(length)
    end

    def log(*info)
      info.each do |v|
        STDERR.puts ">>[#{Process.pid}]> LOG <#{caller(3, 1).first}> #{v}"
        STDERR.flush
      end
    end

    def Q.capture_stdout
      original_stdout = $stdout
      $stdout = StringIO.new
      yield
      $stdout.string
    ensure
      $stdout = original_stdout
    end

    def write(content, flush = true)
      n = STDOUT.write(content)
      STDOUT.flush if flush
      n
    end

    # 模块级快捷：直接写 HTTP 响应（无 Rsp 对象）。用于 END 块兜底 / 老脚本兼容。
    # 写完不抛 throw —— 调用方自己 exit。
    def write_resp(code, status, header, content)
      body_bytes = content.nil? ? '' : content.to_s
      merged = { 'Connection' => 'close' }.merge(header)
      merged['Content-Length'] = body_bytes.bytesize.to_s

      head = +"HTTP/1.0 #{code} #{status}\r\n"
      merged.each { |k, v| head << "#{k}: #{v}\r\n" }
      head << "\r\n"

      write(head, false)
      write(body_bytes, true)
    end

    # 流式：先发 header + Transfer-Encoding: chunked
    def write_headers(header, content_length: nil, transfer_encoding: nil, code: 200, status: 'OK')
      merged = { 'Connection' => 'close' }.merge(header)
      merged['Content-Length'] = content_length.to_s if content_length
      merged['Transfer-Encoding'] = transfer_encoding if transfer_encoding
      merged.delete('Content-Length') if transfer_encoding
      head = +"HTTP/1.0 #{code} #{status}\r\n"
      merged.each { |k, v| head << "#{k}: #{v}\r\n" }
      head << "\r\n"
      STDOUT.write(head)
      STDOUT.flush
    end

    def write_chunk(chunk)
      data = chunk
      length = data.to_s.bytesize
      STDOUT.write("#{length.to_s(16)}\r\n")
      STDOUT.write(data)
      STDOUT.write("\r\n")
      STDOUT.flush
    end

    def write_chunk_end
      STDOUT.write("0\r\n\r\n")
      STDOUT.flush
    end

    # 进程退出前回调（脚本被路由命中 throw :handled 跑完所有 callback 后 exit 0）
    def on_close(&cb)
      ONCLOSE_CBS << cb
    end

    # 注册路由 + 立即尝试匹配当前请求。匹配 + 执行后跑 on_close + exit 0。
    #   Q.route '/foo', method: :GET do |req, rsp| ... end
    #   Q.route %r{^\/users\/(?<id>\d+)$}, method: :GET do |req, rsp| ... end
    #   Q.route '/api', method: %i[GET POST] do |req, rsp| ... end
    #   Q.route '/*', method: :GET do |req, rsp| ... end   # catch-all
    #   Q.route do |req, rsp| ... end                      # 兜底（无 method/pattern）
    #
    # HTTP method 快捷别名：
    #   Q.get  '/users' do |req, rsp| ... end
    #   Q.post '/users' do |req, rsp| ... end
    #   Q.put / Q.delete / Q.patch / Q.head / Q.options 同理
    %w[get post put delete patch head options].each do |m|
      define_method(m) do |pattern = nil, &block|
        route(pattern, method: m.upcase, &block)
      end
    end

    def route(pattern = nil, method: nil, &block)
      # 兜底：pattern 和 method 都 nil → 总是匹配
      caught = catch(:q_resp_sent) do
        if pattern.nil? && method.nil?
          exec_route_block(block)
          throw :q_resp_sent, :handled
        end

        methods = method.nil? ? nil : Array(method).map(&:to_s).map(&:upcase)
        if (methods.nil? || methods.empty? || methods.include?(REQ_METHOD)) && match_pattern?(pattern)
          exec_route_block(block)
          throw :q_resp_sent, :handled
        end
        :not_handled
      end

      # 命中 → exit 0（不继续跑后续 Q.route / END 兜底）
      if caught == :handled
        exit 0
      end
      self
    end

    # --- 路由匹配 ---

# pattern 写法（必须以 '/' 开头或为 Regexp，对照 Q::MAP_PATH）：
    #   '/'            匹配 restful 为空（脚本本身调用，无 restful 段）
    #   '/info'        匹配 MAP_PATH="/info"
    #   '/*'           通配所有非空 MAP_PATH
    #   '/users/<id>'  字符串命名捕获占位符（自动转 (?<id>[^/]+)）
    #   /^\/users\/(?<id>\d+)$/  正则（/ 必须显式写，^/$ 写不写都行）
    #
    # 不以 / 开头 → 抛 ArgumentError
    def match_pattern?(pattern)

      # 每条 pattern 测试前清空 Q::MATCH（避免上一次命中的捕获污染日志）
      Q::MATCH.clear

      result = case pattern
               when nil      then true
               when String   then match_string(pattern, MAP_PATH)
               when Regexp   then match_regexp(pattern, MAP_PATH)
               when Proc     then pattern.call(MAP_PATH, REQ_PATH) == true
               else               false
               end

      log_match(pattern, MAP_PATH, result)
      result
    end

    # 内部 helper：把每条路由的匹配结果打到 STDERR（含命中的命名捕获），方便调试路由
    def log_match(pattern, map_path, result)
      matched = result ? 'true ' : 'false'
      caller_line = caller(2, 1).first || 'unknown'
      msg = "Q.match #{pattern.inspect.ljust(36)} [match=#{matched}] map_path=#{map_path.inspect} req=#{REQ_PATH.inspect}"
      msg += "  captured=#{Q::MATCH.inspect}" unless Q::MATCH.empty?
      STDERR.puts ">>[#{Process.pid}]> LOG <#{caller_line}> #{msg}"
      STDERR.flush
    end
    private :log_match

    # 字符串 pattern 匹配逻辑
    #
    # pattern 直接与 MAP_PATH 对照（必须以 '/' 开头）。
    #   MAP_PATH="/info"       →  pattern '/info' 命中
    #   MAP_PATH="/users/42"   →  pattern '/users/<id>' 命中（捕获到 id="42"）
    #   MAP_PATH="/"           →  pattern '/' 命中（restful 为空）
    #   MAP_PATH 任意非空       →  pattern '/*' 命中
    def match_string(pattern, map_path)
      raise ArgumentError, "Q.route String pattern 必须以 '/' 开头，got: #{pattern.inspect}" unless pattern.start_with?('/')

      return true if pattern == '/*'
      return true if pattern == map_path

      # 含正则元字符或命名捕获的字符串当 Regexp 解析
      if pattern.match?(/[?*+()|^\[\]\\.]/) || pattern.match?(/<[A-Za-z_]\w*>/)
        # 把 <name> 命名捕获占位符转成 (?<name>[^/]+)
        converted = pattern.gsub(/<([A-Za-z_]\w*)>/, '(?<\\1>[^/]+)')
        # 注意：必须用单引号或 Regexp.escape 防止 \\A 被双引号吃掉
        re = Regexp.new('\A' + converted + '\z')
        mm = re.match(map_path)
        return false unless mm
        Q::MATCH.replace(mm.named_captures.transform_keys(&:to_sym))
        true
      else
        # 字符串精确匹配：完整路径 = rel + pattern
        pattern == REQ_PATH
      end
    end
    private :match_string

    # Regexp pattern 匹配逻辑
    #
    # Regexp 直接对照 MAP_PATH（必须以 / 开头，/ 必须显式写）。
    #   pattern /^\/users\/(?<id>\d+)$/  →  匹配 MAP_PATH="/users/42"（捕获到 id="42"）
    #   ^ 和 $ 写不写都行（外层用 \A/\z 统一包）
    def match_regexp(pattern, map_path)
      anchored = Regexp.new('\A' + pattern.source + '\z', pattern.options)
      m = anchored.match(map_path)
      return false unless m
      Q::MATCH.replace(m.named_captures.transform_keys(&:to_sym))
      true
    end
    private :match_regexp

    private

    # 跑用户 block；rescue → 500 响应
    def exec_route_block(block)
      rsp = Rsp.new
      begin
        instance_exec(Req.new, rsp, &block)
      rescue StandardError => e
        log "#{e.class}: #{e.message}"
        log((e.backtrace || []).first(5).map { |b| "  #{b}" })
        rsp.code(500).body("#{e.class}: #{e.message}").finish
      end
      rsp.finish unless rsp.sent
    end
  end
end

# ============================================================
# 进程生命周期钩子
# ============================================================
BEGIN {
  STDERR.puts " ******************** [#{Process.pid}]> BEGIN cgi #{ENV['Req_Script_Name']} ******************** "
}

END {
  # 兜底：脚本所有 Q.route 都没匹配当前请求时返 404。
  # （Q.route 命中路径已经 throw :handled 跑完 callback 后 exit 0，不会进这里。）
  Q.write_resp(404, "Not Found", {}, "unhandled request: #{Q::REQ_PATH} with #{Q::REQ_METHOD}\n") unless Q::STATE[:responded]

  Q::ONCLOSE_CBS.each_with_index do |cb, i|
    begin
      STDERR.puts " >>> call onclose cbk (#{i}) ->  #{cb.call}"
    rescue StandardError => e
      STDERR.puts " >>> call onclose (#{i}) error: #{e.class}: #{e.message} ******************** )"
    end
  end
  STDERR.puts " ******************** [#{Process.pid}]> END   cgi #{ENV['Req_Script_Name']} ******************** "
}
