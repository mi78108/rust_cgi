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

module ShareUpload
  module_function

  # ---------- POST /shares : 一次性上传 ----------
  def create_share(req, rsp)
    max = req.param('max').to_i
    max = 0 if max.negative?
    max = 100_000 if max > 100_000          # 防手滑
    pw = req.param('pw').to_s
    pub = req.param('pub', '1').to_s != '0' ? 1 : 0
    if pub.zero? && pw.empty?
      return json(rsp, 400, ok: false, error: '私密分享必须设置密码（pub=0 需要 pw）')
    end

    # 有效期：小时数，0 = 永久。上限 10 年，防手滑。
    exp_h = req.param('exp').to_i
    exp_h = 0 if exp_h.negative?
    exp_h = 87_600 if exp_h > 87_600

    form = req.body_form_data
    return json(rsp, 400, ok: false, error: 'not multipart/form-data') if form.nil?

    item = form.items.find(&:file?)
    return json(rsp, 400, ok: false, error: 'no file field') if item.nil?

    content = item.content
    return json(rsp, 400, ok: false, error: 'empty file') if content.empty?

    # 显式 name 优先，没给就用 multipart 里的文件名
    name = req.param('name').to_s.empty? ? item.filename : req.param('name')

    s = Share.upload_direct!(name:    name,
                             type:    item.content_type,
                             content: content,
                             max:     max,
                             exp_h:   exp_h,
                             pub:     pub,
                             pw:      pw,
                             owner:   req.param('c'))

    json(rsp, 200, ok: true, data: s.to_upload_info)
  end

  # ---------- POST /uploads : 建分片会话 ----------
  def create_session(req, rsp)
    size = req.param('size').to_i
    return json(rsp, 400, ok: false, error: "bad size: #{req.param('size')}") if size <= 0

    chunk = req.param('chunk').to_i
    return json(rsp, 400, ok: false, error: "bad chunk: #{req.param('chunk')}") if chunk.negative?

    max = req.param('max').to_i
    max = 0 if max.negative?
    max = 100_000 if max > 100_000

    exp_h = req.param('exp').to_i
    exp_h = 0 if exp_h.negative?
    exp_h = 87_600 if exp_h > 87_600

    pub = req.param('pub', '1').to_s != '0' ? 1 : 0
    pw  = req.param('pw').to_s
    # 私密必须带密码，否则这个分享等于公开却标着「私密」，自相矛盾
    if pub.zero? && pw.empty?
      return json(rsp, 400, ok: false, error: '私密分享必须设置密码（pub=0 需要 pw）')
    end

    s = Share.create(name:  req.param('name'),
                     type:  req.param('type'),
                     size:  size,
                     chunk: chunk,
                     max:   max,
                     exp_h: exp_h,
                     pub:   pub,
                     pw:    pw,
                     owner: req.param('c'))

    json(rsp, 200, ok: true, data: s.to_create_info)
  end

  # ---------- PUT /uploads/<token> : 传一片 ----------
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
end