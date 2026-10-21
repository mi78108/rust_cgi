#!/usr/bin/env ruby
# frozen_string_literal: true
#
# api_upload.rb — 上传系列的请求处理
#
# 路由注册在 index（统一入口），这里只放「拿到 req/rsp 之后干什么」。
#
#   POST /tool/share/shares                    一次性上传（multipart）
#   POST /tool/share/uploads                   建分片会话
#   PUT  /tool/share/uploads/<token>           传一片
#   POST /tool/share/uploads/<token>/complete  合并收尾
#
# 为什么分片会话用 /uploads 而不直接 /shares：
#   分片上传是「建会话 → 传片 → 合并」三段，跟一次性上传不是一回事。
#   同一个 /shares 资源上再挂 parts 会让路径变深，而会话本身的语义就是
#   「正在上传的东西」，跟已完成的分享（/shares/<token>）不是一回事。

require_relative '_lib_'
require_relative '../../_ext_form_'
require 'uri'

module ShareUpload
  module_function

  # ---------- POST / : 一次性上传 ----------
  #
  # 配置参数从哪来：query 优先，没有就取 multipart 里的同名字段。
  # 两种都支持是因为路由分流靠「query 是否为空」—— 不带 query 时
  # 一次性上传的配置只能跟着文件一起走 multipart。
  #
  # token 给了就用给的（POST /<token>），没给就随机生成。
  def create_share(req, rsp, token = nil)
    form = req.body_form_data
    return json(rsp, 400, ok: false, error: 'not multipart/form-data') if form.nil?

    item = form.items.find(&:file?)
    return json(rsp, 400, ok: false, error: 'no file field') if item.nil?

    content = item.content
    return json(rsp, 400, ok: false, error: 'empty file') if content.empty?

    # 指定 token 时查重：
    #   已完成（done=1）→ 409，不能让人凭 token 覆盖别人的分享
    #   未完成（done=0）→ 允许覆盖，那本来就是半成品（重传 / 换文件继续传）
    if token
      existing = Share.find(token)
      if existing && existing.done?
        return json(rsp, 409, ok: false,
                    error: '这个 token 已被使用',
                    data: { name: existing.name, size: existing.size })
      end
    end

    # query 优先，其次 multipart 字段（form[key] 返回 FormItem 或 nil）
    #
    # 局部变量都叫 f_xxx，别跟外层的 item 撞名 —— Ruby 的 block 会捕获
    # 外层同名局部变量并改写它，撞名会让 file_item 变成 nil。
    opt = ->(key, default = '') {
      v = req.param(key)
      next v if v && !v.to_s.empty?
      f = form[key]
      f && !f.file? ? f.content.to_s : default
    }

    max = opt.call('max', '0').to_i
    max = 0 if max.negative?
    max = 100_000 if max > 100_000          # 防手滑
    pw = opt.call('pw', '').to_s
    pub = opt.call('pub', '1').to_s != '0' ? 1 : 0
    if pub.zero? && pw.empty?
      return json(rsp, 400, ok: false, error: '私密分享必须设置密码（pub=0 需要 pw）')
    end

    # 有效期：小时数，0 = 永久。上限 10 年，防手滑。
    exp_h = opt.call('exp', '0').to_i
    exp_h = 0 if exp_h.negative?
    exp_h = 87_600 if exp_h > 87_600

    # 显式 name 优先，没给就用 multipart 里的文件名
    name = opt.call('name', '').to_s
    name = item.filename if name.empty?

    s = Share.upload_direct!(name:    name,
                             type:    item.content_type,
                             content: content,
                             max:     max,
                             exp_h:   exp_h,
                             pub:     pub,
                             pw:      pw,
                             owner:   opt.call('c', '').to_s,
                             token:   token)

    json(rsp, 200, ok: true, data: s.to_upload_info)
  end

  # ---------- POST / : 建分片会话 ----------
  #
  # 参数走 POST body（application/x-www-form-urlencoded），不是 query。
  # 原因：路由分流靠「query 是否为空」—— 没 query 才走这里，所以参数
  # 不能再放 query。req.param 只解析 query，这里自己解析 body。
  def create_session(req, rsp)
    q = parse_form_body(req)

    size = q['size'].to_i
    return json(rsp, 400, ok: false, error: "bad size: #{q['size']}") if size <= 0

    chunk = q['chunk'].to_i
    return json(rsp, 400, ok: false, error: "bad chunk: #{q['chunk']}") if chunk.negative?

    max = q['max'].to_i
    max = 0 if max.negative?
    max = 100_000 if max > 100_000

    exp_h = q['exp'].to_i
    exp_h = 0 if exp_h.negative?
    exp_h = 87_600 if exp_h > 87_600

    pub = (q['pub'].nil? || q['pub'].empty? ? '1' : q['pub']) != '0' ? 1 : 0
    pw  = q['pw'].to_s
    # 私密必须带密码，否则这个分享等于公开却标着「私密」，自相矛盾
    if pub.zero? && pw.empty?
      return json(rsp, 400, ok: false, error: '私密分享必须设置密码（pub=0 需要 pw）')
    end

    s = Share.create(name:  q['name'],
                     type:  q['type'],
                     size:  size,
                     chunk: chunk,
                     max:   max,
                     exp_h: exp_h,
                     pub:   pub,
                     pw:    pw,
                     owner: q['c'])
    json(rsp, 200, ok: true, data: s.to_create_info)
  end

  # 解析 application/x-www-form-urlencoded 的 POST body
  def parse_form_body(req)
    return {} unless req.body_type.to_s.include?('x-www-form-urlencoded')
    URI.decode_www_form(req.body.to_s).to_h
  end

  # ---------- GET /<token>/info : 元信息 ----------
  #
  # 下载页 / 预览页加载时要先知道文件名、大小、还有没有次数。
  # 不校验密码 —— 只回 has_pw 布尔值，不回明文，也不回 by 之类内部字段。
  def show_info(req, rsp, token)
    s = Share.find(token)
    return Share.missing(rsp) if s.nil?
    # 用 :mark —— 第一次发现失效只打标记（本次还能报「次数已用完」而不是
    # 404），下次访问才物理删。误判一次不会立刻丢数据。
    return Share.missing(rsp) if s.reap!(purge: :mark)

    unless s.alive?
      return s.fail(rsp, 410, s.dead_message, data: { name: s.name, size: s.size })
    end
    return s.fail(rsp, 404, 'file gone') unless s.data_exists?

    s.ok(rsp, s.to_info)
  end

  # ---------- GET /<token> : 下载文件本体 ----------
  #
  # attachment + 扣一次配额。
  #
  # 密码校验（密码错的不消耗下载次数）
  # 私密分享（pub=0）强制要求正确密码：哪怕历史数据里 pw 意外为空，
  # 也不能放行（否则「私密」形同虚设）。公开（pub=1）行为不变：设了密码才校验。
  def content(req, rsp, token)
    s = Share.find(token)
    return Share.missing(rsp) if s.nil?
    return Share.missing(rsp) if s.reap!(purge: :mark)

    unless s.alive?
      return s.fail(rsp, 410, s.dead_message, data: { name: s.name, size: s.size })
    end

    unless s.authorized?(pw: req.param('p'))
      return s.fail(rsp, 401, '密码错误',
                    data: { name: s.name, size: s.size, has_pw: true,
                            pub: s.public? ? 1 : 0 })
    end

    return s.fail(rsp, 404, 'file gone') unless s.data_exists?
    s.serve_attachment(rsp)
  end

  # ---------- DELETE /<token> : 删除分享 ----------
  #
  # 两种授权任一即可：归属（cid）或正确密码。
  # 未完成的分享（done=0）无凭证也允许丢 —— 它还没对外发过链接。
  #
  # 密码参数名是 pw 不是 p —— 跟 download 的 ?p= 故意不一样：
  #   download 的 ?p= 会出现在分享链接里（对方点开就要输密码），要短；
  #   这里是内部管理接口，前端只传 ?c= 或 ?pw=，用全称更清楚。
  # 两边各自保持原样，别「顺手统一」。
  def destroy(req, rsp, token)
    s = Share.find(token)
    return Share.missing(rsp) if s.nil?

    cid = req.param('c').to_s.gsub(/[^A-Za-z0-9_-]/, '')[0, 40]
    pw  = req.param('pw').to_s

    unless s.authorized?(cid: cid, pw: pw, require_cred: true) || s.discardable?
      # 区分「凭证错了」和「压根没给凭证」，提示才准确
      given = !cid.empty? || !pw.empty?
      return s.fail(rsp, 403,
                    given ? '没有权限删除这个分享' : '需要密码或上传者身份才能删除')
    end

    s.destroy!
    s.ok(rsp, { token: token, deleted: true })
  end

  # ---------- PATCH /<token> : 改配置 ----------
  #
  # 归属校验只认 clientId，不接受密码兜底 ——
  # 「修改配置」比「删除」更需要限定所有者：删除只是回到没人能访问的状态，
  # 修改却可能把一个私密分享改成公开。
  def update(req, rsp, token)
    s = Share.find(token)
    return Share.missing(rsp) if s.nil?

    cid = req.param('c').to_s.gsub(/[^A-Za-z0-9_-]/, '')[0, 40]
    return s.fail(rsp, 403, '没有权限修改这个分享') if cid.empty?
    return s.fail(rsp, 403, '只有上传者可以修改这个分享') unless s.owned_by?(cid)

    s.apply_max!(req.param('max').to_i) if req.param('max')
    s.apply_exp!(req.param('exp').to_i) if req.param('exp')
    s.apply_pw!(req.param('pw'))         if req.param('pw')

    # 改成私密必须有密码，否则这个分享等于公开却标着「私密」，
    # 而且下载端会一直 401 谁都下不了 —— 直接拒绝这个组合。
    if req.param('pub')
      pub = req.param('pub').to_i
      if !pub.negative? && pub.zero? && !s.can_be_private?
        return s.fail(rsp, 400, '私密分享必须设置密码')
      end
      s.apply_pub!(pub)
    end

    s.save!
    s.ok(rsp, s.to_config)
  end

  # ---------- PUT /<token> : 传一片 ----------
  def put_part(req, rsp, token)
    return json(rsp, 400, ok: false, error: 'missing token') unless Share::TOKEN_RE.match?(token)

    s = Share.find(token)
    return Share.missing(rsp) if s.nil?
    return json(rsp, 409, ok: false, error: 'already done') if s.done?

    n = req.param('n').to_i
    if n.negative? || n >= s.total_parts
      return json(rsp, 400, ok: false, error: "bad n: #{req.param('n')}")
    end

    # Content-Range 必填：客户端必须显式声明这一片在文件里的位置，
    # 服务端不靠「下一个 n 是多少」推断（并发时顺序不可控）。
    cr = req.header('content-range', '')
    md = cr.to_s.match(%r{\Abytes\s+(\d+)-(\d+)/(\d+)\z})
    unless md
      return json(rsp, 400, ok: false,
                  error: "bad or missing Content-Range: #{cr.inspect} (want 'bytes 0-1023/#{s.size}')")
    end
    start, finish, cr_total = md[1].to_i, md[2].to_i, md[3].to_i

    err = s.check_part_range(n, start, finish, cr_total)
    return json(rsp, 400, ok: false, error: err) if err

    content = req.body.to_s
    want = finish - start + 1
    if content.bytesize != want
      return json(rsp, 400, ok: false,
                  error: "body size #{content.bytesize} != range length #{want}")
    end

    json(rsp, 200, ok: true, data: s.write_part!(n, content))
  end

  # ---------- POST /uploads/<token>/complete : 合并收尾 ----------
  def complete(req, rsp, token)
    return json(rsp, 400, ok: false, error: 'missing token') unless Share::TOKEN_RE.match?(token)

    s = Share.find(token)
    return Share.missing(rsp) if s.nil?

    # 幂等：已完成就直接返回成功（客户端重试不会报错）
    return json(rsp, 200, ok: true, data: s.to_finish_info(0, already: true)) if s.done?

    missing = s.missing_parts
    unless missing.empty?
      return json(rsp, 409, ok: false,
                  error: "missing #{missing.length} part(s): #{missing.first(20).join(',')}",
                  data: { got: s.got_parts, total_parts: s.total_parts, missing: missing })
    end

    begin
      merged = s.merge_parts!
    rescue RangeError => e
      return json(rsp, 500, ok: false, error: e.message)
    end

    json(rsp, 200, ok: true, data: s.to_finish_info(merged))
  end

  # ---------- GET /<token>/chunk : 内联预览（inline，不扣次数） ----------
  #
  # 跟 GET /<token>（下载本体）的区别：
  #   disposition  inline（浏览器直接渲染）vs attachment（强制存盘）
  #   下载次数    不扣vs 扣 1
  #   Range       支持 206（浏览器能拖进度条边下边播）vs 忽略
  #   密码        不校验。私密分享一律 403 ——
  #                这个端点没有 ?p= 参数，链接泄露就等于内容泄露，
  #                密码形同虚设。私密内容只能走 /<token> 输密码下载。
  #
  # 懒清理不做（:none）—— 它是只读的，不该有副作用；
  # 清理交给下载端和 list。
  def chunk(req, rsp, token)
    s = Share.find(token)
    return Share.missing(rsp) if s.nil?
    return s.fail(rsp, 403, '私密分享不支持预览') unless s.public?

    unless s.alive?
      return s.fail(rsp, 410, s.dead_message)
    end
    return s.fail(rsp, 404, 'file gone') unless s.data_exists?

    size = File.size(s.data_path)
    rng = parse_range(req.header('range', ''), size)

    s.preview_headers(rsp)

    unless rng
      rsp.type(s.mime_inline).body(s.data_path).finish
    else
      first, last = rng
      rsp.code(206)
         .header_field('Content-Range', "bytes #{first}-#{last}/#{size}")
         .type(s.mime_inline)
         .body(Q::RangeBody.new(s.data_path, first, last - first + 1))
         .finish
    end
  end

  # ---------- Range ----------
  #
  # 解析 Range 请求头 → [first, last]（闭区间，字节偏移），不支持就返回 nil
  #   Range: bytes=0-            → 0 .. size-1
  #   Range: bytes=100-199      → 100 .. 199
  #   Range: bytes=-500         → 最后 500 字节（后缀式）
  #   Range: bytes=500-         → 500 .. size-1
  #   多个 range（bytes=0-1,5-6）不支持 → nil（按整块发）
  def parse_range(hdr, size)
    return nil if hdr.to_s.strip.empty?
    m = hdr.strip.match(%r{\Abytes\s*=\s*(\d*)\s*-\s*(\d*)\z}i)
    return nil unless m
    first, last = m[1], m[2]

    # 后缀式：bytes=-N → 取末尾 N 字节
    if first.empty?
      return nil if last.empty?
      n = last.to_i
      return nil if n <= 0
      n = size if n > size
      return [size - n, size - 1]
    end

    f = first.to_i
    return nil if f >= size          # 越界 → 当作不支持，让上层发整块
    l = last.empty? ? size - 1 : last.to_i
    l = size - 1 if l >= size        # 开放结尾：夹到文件末尾
    return nil if l < f
    [f, l]
  end
end

# 文件的 [offset, offset+len) 片段。
# 为什么不用 Q::Body::StreamBody：它 #size 恒为 nil，Rsp#finish 会直接
# Content-Length: 0 把响应发完，压根不会调 each_chunk（body 不输出）。
# 206 必须带真实的 Content-Length，所以要一个 size 已知的 body。
# each_chunk 按 BUFFER_SIZE 读 → 大视频也是边读边发，不整个读进内存。
class Q
  class RangeBody < Q::Body::Base
    def initialize(path, offset, len)
      @path = path
      @offset = offset
      @len = len
    end

    def size = @len

    def each_chunk(chunk_size = Q::BUFFER_SIZE)
      File.open(@path, 'rb') do |f|
        f.seek(@offset)
        left = @len
        while left > 0 && (buf = f.read([chunk_size, left].min))
          yield buf
          left -= buf.bytesize
        end
      end
    end
  end
end