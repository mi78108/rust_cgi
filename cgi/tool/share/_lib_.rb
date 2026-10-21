#!/usr/bin/env ruby
# frozen_string_literal: true
#
# _lib_.rb — tool/share 的领域模型
#
# 定位：一个 Share = 一次文件分享。路由脚本只负责「取参 → 调方法 → 包响应」，
#       所有业务判断（有效期、授权、配额、懒清理）都在这里。
#
# 用法：
#   require_relative '../../_base_'
#   require_relative '_lib_'
#
#   Q.get %r{^/(?<token>[a-f0-9]{16})$} do |req, rsp|
#     s = Share.find(req.named(:token))
#     return err(rsp, 404, 'not found') if s.nil?
#     return err(rsp, 410, s.expired_message) unless s.alive?
#     return err(rsp, 401, '密码错误', has_pw: true) unless s.authorized?(pw: req.param('p'))
#     s.serve_attachment(rsp)
#   end
#
# 为什么用类而不是一堆顶层函数：
#   迁移前「加载 meta + 判存在 + 判失效 + 授权 + 扣配额」这套流程在 9 个脚本里
#   各写一遍，其中失效判定有 3 个变体（字符串/符号/布尔）、懒清理有 2 套语义。
#   收进类之后判定条件只有一份，调用方要什么返回格式由它自己转。
#
# 存储布局（跟迁移前一致，没有改任何磁盘格式）：
#   $SPIDER_DATA/<token>/meta.json   元信息
#   $SPIDER_DATA/<token>/data        原始字节
#   $SPIDER_DATA/<token>/part/<n>    分片（finish 时合并成 data）

require 'fileutils'
require 'json'
require 'securerandom'
require 'uri'
require_relative '../../_ext_form_'

SHARE_ROOT = ENV.fetch('SPIDER_DATA', nil).to_s.empty? ? '/tmp/share' : ENV['SPIDER_DATA']

def dir_of(token)   = File.join(SHARE_ROOT, token)
def meta_path(token) = File.join(dir_of(token), 'meta.json')
def data_path(token) = File.join(dir_of(token), 'data')
def part_path(token, n) = File.join(dir_of(token), 'part', n.to_s)

# ---------- 取值夹取 ----------
#
#   MAX_QUOTA  10 万次 —— 再多没意义，手滑也拦得住
#   MAX_EXP_H  87600 小时 = 10 年 —— 够用，且不溢出时间戳计算
MAX_QUOTA = 100_000
MAX_EXP_H = 87_600

# 负数当 0（无限 / 永久）。注意 apply_exp! 是另一套语义（-1 = 不改）。
# clientId 白名单清洗。写进 meta 和从 query 读出来是同一套规则，抽出来。
def clean_cid(s) = s.to_s.gsub(/[^A-Za-z0-9_-]/, '')[0, 40]

def clamp_max(n) = n.negative? ? 0 : [n, MAX_QUOTA].min
def clamp_exp(h) = h.negative? ? 0 : [h, MAX_EXP_H].min

def ensure_share_root!
  FileUtils.mkdir_p(SHARE_ROOT) unless File.directory?(SHARE_ROOT)
end

# 已收到的分片号 → [0, 2, 5, ...]（升序）
#
# 名字带 scan_ 前缀是为了跟 Share#got_parts 区分开 —— 类里的同名方法会
# 递归调用自己（Share#got_parts 内部要调这个顶层函数）。
def scan_got_parts(token)
  pdir = File.join(dir_of(token), 'part')
  return [] unless File.directory?(pdir)
  Dir.children(pdir).select { |f| f =~ /\A\d+\z/ }.map(&:to_i).sort
end

# ---------- 响应 ----------
#
# json 是底座，ok / err 是它的两种约定写法。别再手拼 ok/error 字段 ——
# 漏了 ok 前端就当成功处理（preview 端点踩过，403 返回成了纯字符串）。
#   ok(rsp, data)           成功，带 data
#   err(rsp, code, error)   失败，带 error（extra 透传，404 时常要附 name/size）
#   err(rsp, 404)           error 走默认值 'not found'

def json(rsp, code, payload)
  rsp.code(code).type_json.body(payload.to_json).finish
end

def ok(rsp, data = nil)
  json(rsp, 200, { ok: true, data: data })
end

def err(rsp, code, error = 'not found', **extra)
  json(rsp, code, { ok: false, error: error }.merge(extra))
end

# ══════════════════════════════════════════════════════════════
#  Share
# ══════════════════════════════════════════════════════════════

class Share
  TOKEN_RE = /\A[a-f0-9]{16}\z/

  module Api
    module_function

    # 找分享并做存在性检查。8 个端点都是这个开头，抽出来少写 16 行。
    # 返回 nil 时 rsp 已经写好了，调用方直接 return。
    def load(req, rsp, token, purge: nil)
      s = Share.find(token)
      if s.nil? || (purge && s.reap!(purge: purge))
        err(rsp, 404)      # 找不到 / 已被懒清理删除
        return nil
      end
      s
    end

    # 上传者 clientId（所有权凭证）。白名单字符 + 截断，跟 meta 里的 by 对齐。
    def cid_of(req) = clean_cid(req.param('c'))

    # 私密分享必须带密码，否则「公开却标着私密」自相矛盾。
    # 返回错误文案，通过则 nil。
    def check_private(pub, pw)
      return '私密分享必须设置密码（pub=0 需要 pw）' if pub.zero? && pw.to_s.empty?
      nil
    end

    # 解析 application/x-www-form-urlencoded 的 POST body。
    # req.param 只读 query，分片会话的参数走 body 得自己解析。
    def form_body(req)
      return {} unless req.body_type.to_s.include?('x-www-form-urlencoded')
      URI.decode_www_form(req.body.to_s).to_h
    end


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

    max = clamp_max(opt.call('max', '0').to_i)
    pw = opt.call('pw', '').to_s
    pub = opt.call('pub', '1').to_s != '0' ? 1 : 0
    if (err = check_private(pub, pw))
      return json(rsp, 400, ok: false, error: err)
    end

    # 有效期：小时数，0 = 永久。上限 10 年，防手滑。
    exp_h = clamp_exp(opt.call('exp', '0').to_i)

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

  #
  # 参数走 POST body（application/x-www-form-urlencoded），不是 query。
  # 原因：路由分流靠「query 是否为空」—— 没 query 才走这里，所以参数
  # 不能再放 query。req.param 只解析 query，这里自己解析 body。
  def create_session(req, rsp)
    q = form_body(req)

    size = q['size'].to_i
    return json(rsp, 400, ok: false, error: "bad size: #{q['size']}") if size <= 0

    chunk = q['chunk'].to_i
    return json(rsp, 400, ok: false, error: "bad chunk: #{q['chunk']}") if chunk.negative?

    max = clamp_max(q['max'].to_i)

    exp_h = clamp_exp(q['exp'].to_i)

    pub = (q['pub'].nil? || q['pub'].empty? ? '1' : q['pub']) != '0' ? 1 : 0
    pw  = q['pw'].to_s
    # 私密必须带密码，否则这个分享等于公开却标着「私密」，自相矛盾
    if (err = check_private(pub, pw))
      return json(rsp, 400, ok: false, error: err)
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


  #
  # 下载页 / 预览页加载时要先知道文件名、大小、还有没有次数。
  # 不校验密码 —— 只回 has_pw 布尔值，不回明文，也不回 by 之类内部字段。
  def show_info(req, rsp, token)
    s = load(req, rsp, token)
    return if s.nil?
    # 用 :mark —— 第一次发现失效只打标记（本次还能报「次数已用完」而不是
    # 404），下次访问才物理删。误判一次不会立刻丢数据。
    return err(rsp, 404) if s.reap!(purge: :mark)

    unless s.alive?
      return err(rsp, 410, s.dead_message, data: { name: s.name, size: s.size })
    end
    return err(rsp, 404, 'file gone') unless s.data_exists?

    ok(rsp, s.to_info)
  end

  #
  # attachment + 扣一次配额。
  #
  # 密码校验（密码错的不消耗下载次数）
  # 私密分享（pub=0）强制要求正确密码：哪怕历史数据里 pw 意外为空，
  # 也不能放行（否则「私密」形同虚设）。公开（pub=1）行为不变：设了密码才校验。
  def content(req, rsp, token)
    s = load(req, rsp, token)
    return if s.nil?
    return err(rsp, 404) if s.reap!(purge: :mark)

    unless s.alive?
      return err(rsp, 410, s.dead_message, data: { name: s.name, size: s.size })
    end

    unless s.authorized?(pw: req.param('p'))
      return err(rsp, 401, '密码错误',
                    data: { name: s.name, size: s.size, has_pw: true,
                            pub: s.public? ? 1 : 0 })
    end

    return err(rsp, 404, 'file gone') unless s.data_exists?
    s.serve_attachment(rsp)
  end

  #
  # 两种授权任一即可：归属（cid）或正确密码。
  # 未完成的分享（done=0）无凭证也允许丢 —— 它还没对外发过链接。
  #
  # 密码参数名是 pw 不是 p —— 跟 download 的 ?p= 故意不一样：
  #   download 的 ?p= 会出现在分享链接里（对方点开就要输密码），要短；
  #   这里是内部管理接口，前端只传 ?c= 或 ?pw=，用全称更清楚。
  # 两边各自保持原样，别「顺手统一」。
  def destroy(req, rsp, token)
    s = load(req, rsp, token)
    return if s.nil?

    cid = cid_of(req)
    pw  = req.param('pw').to_s

    unless s.authorized?(cid: cid, pw: pw, require_cred: true) || s.discardable?
      # 区分「凭证错了」和「压根没给凭证」，提示才准确
      given = !cid.empty? || !pw.empty?
      return err(rsp, 403,
                    given ? '没有权限删除这个分享' : '需要密码或上传者身份才能删除')
    end

    s.destroy!
    ok(rsp, { token: token, deleted: true })
  end

  #
  # 归属校验只认 clientId，不接受密码兜底 ——
  # 「修改配置」比「删除」更需要限定所有者：删除只是回到没人能访问的状态，
  # 修改却可能把一个私密分享改成公开。
  def update(req, rsp, token)
    s = load(req, rsp, token)
    return if s.nil?

    cid = cid_of(req)
    return err(rsp, 403, '没有权限修改这个分享') if cid.empty?
    return err(rsp, 403, '只有上传者可以修改这个分享') unless s.owned_by?(cid)

    s.apply_max!(req.param('max').to_i) if req.param('max')
    s.apply_exp!(req.param('exp').to_i) if req.param('exp')
    s.apply_pw!(req.param('pw'))         if req.param('pw')

    # 改成私密必须有密码，否则这个分享等于公开却标着「私密」，
    # 而且下载端会一直 401 谁都下不了 —— 直接拒绝这个组合。
    if req.param('pub')
      pub = req.param('pub').to_i
      if !pub.negative? && pub.zero? && !s.can_be_private?
        return err(rsp, 400, '私密分享必须设置密码')
      end
      s.apply_pub!(pub)
    end

    s.save!
    ok(rsp, s.to_config)
  end

  def put_part(req, rsp, token)
    return json(rsp, 400, ok: false, error: 'missing token') unless Share::TOKEN_RE.match?(token)

    s = load(req, rsp, token)
    return if s.nil?
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

  def complete(req, rsp, token)
    return json(rsp, 400, ok: false, error: 'missing token') unless Share::TOKEN_RE.match?(token)

    s = load(req, rsp, token)
    return if s.nil?

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

  #
  #   ?c=<clientId>  只列这个浏览器上传过的
  #   ?pub=1只列「已完成 + 公开」的（公开广场用）
  #
  # 过滤必须放服务端：列表要给任何人看，如果不按 pub 过滤，
  # 私密分享的文件名/大小/类型就会随 JSON 发给每一个访问者
  # （哪怕前端不显示），等于泄露私密元信息。
  def list(req, rsp)
    cid = cid_of(req)
    pub_only = req.param('pub').to_s == '1'
    json(rsp, 200, ok: true, data: Share.list(cid: cid, pub_only: pub_only))
  end

  #
  # 未完成的分享也要能查 —— 续传时要靠它知道已收了哪几片。
  def show(req, rsp, token)
    s = load(req, rsp, token)
    return if s.nil?

    cid = cid_of(req)
    ok(rsp, s.to_item(cid))
  end

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
    s = load(req, rsp, token)
    return if s.nil?
    return err(rsp, 403, '私密分享不支持预览') unless s.public?

    unless s.alive?
      return err(rsp, 410, s.dead_message)
    end
    return err(rsp, 404, 'file gone') unless s.data_exists?

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

  # 失效原因。统一成符号，取值只有这四个（含 :none 表示有效）。
  # 迁移前 list 返回字符串 'quota'、download 返回符号 :quota、preview 返回布尔，
  # 三份判定条件完全相同 —— 现在只有这一份实现。
  NONE     = :none
  QUOTA    = :quota      # 下载次数耗尽
  EXPIRED  = :expired    # 到期
  GONE     = :gone       # 文件本体不见了（meta 在但 data 没了）

  attr_reader :token, :meta

  # find 返回 nil（找不到），find! 由调用方决定怎么处理
  def self.find(token)
    return nil unless TOKEN_RE.match?(token.to_s)
    m = (JSON.parse(File.read(meta_path(token))) rescue nil)
    return nil unless m.is_a?(Hash)
    new(token, m)
  end

  def self.find!(token)
    find(token) || raise(ArgumentError, "no such share: #{token}")
  end

  # 建一个新分享（分片上传第一步）。
  #
  #   pub=1 公开（默认），pub=0 私密。私密 = 下载端强制要求正确密码，
  #   所以私密必须带密码，否则这个分享等于公开却标着「私密」，自相矛盾。
  #   → 调用方要在私密且 pw 空时返回 400，这里只负责构造。
  #
  # 返回新 Share（已落盘），调用方拿它返回 token / total_parts。
  def self.create(name:, type:, size:, chunk:, max: 0, exp_h: 0, pub: 1,
                  pw: '', owner: '', now: Time.now.to_i)
    token = SecureRandom.hex(8)
    total = chunk > 0 ? (size + chunk - 1) / chunk : 1
    FileUtils.mkdir_p(File.join(dir_of(token), 'part'))

    meta = {
      'name'   => sanitize_name(name),
      'type'   => type.to_s[0, 100],
      'size'   => size,
      'max'    => max,
      'left'   => max,
      'pub'    => pub,
      'pw'     => pw.to_s[0, 64],
      'by'     => clean_cid(owner),
      'exp'    => exp_h,
      'exp_at' => (exp_h > 0 ? now + exp_h * 3600 : 0),
      'at'     => now,
      'done'   => 0,
      'chunk'  => chunk,
      'total_parts' => total
    }
    File.write(meta_path(token), meta.to_json)
    new(token, meta)
  end

  def to_create_info
    { token: @token, total_parts: total_parts, chunk: chunk_size, got_parts: [] }
  end

  # 遍历所有分享。filter 块返回 false 的跳过。
  # 懒清理就在这里做 —— list/download/info 都走这条路径，
  # 保证「标记失效」和「物理清理」只有一处实现。
  def self.each_share(purge: :mark)
    return enum_for(:each_share, purge: purge) unless block_given?

    Dir.glob(File.join(SHARE_ROOT, '*', 'meta.json')).sort.each do |mp|
      m = (JSON.parse(File.read(mp)) rescue nil)
      next unless m.is_a?(Hash)
      s = new(File.basename(File.dirname(mp)), m)

      # 清理策略：
      #   :mark   第一次发现失效 → 打 dead 标记并落盘（下次访问才物理删）
      #           下载端用这个：这样本次还能返回「次数已用完」而不是 404，
      #           误判一次不会立刻丢数据。
      #   :delete 直接物理删（list 用这个：列表本来就返回全量，
      #           失效项直接消失更干脆）
      # 两种策略都跳过未完成的（done=0）—— 它们还没对外发过链接，
      # 要留着给上传者续传。
      # reap! 返回 true = 这个分享已经被清理掉了，跳过。
      next if s.reap!(purge: purge)

      yield s
    end
  end

  # 列表查询。
  #
  #   cid      只列这个 clientId 的（传 nil = 全部）
  #   pub_only 只列「已完成 + 公开」的
  #
  # 清理策略用 :delete —— 列表本来就返回全量，失效项直接消失更干脆，
  # 不像下载端那样还要「先标记再删」。
  def self.list(cid: nil, pub_only: false, purge: :delete)
    items = []
    each_share(purge: purge) do |s|
      if pub_only
        next unless s.done? && s.public?
      else
        next if !cid.to_s.empty? && !s.owned_by?(cid)
      end
      items << s.to_item(cid)
    end
    # 新的在前
    items.sort_by! { |i| -i[:at] }
    items
  end

  def initialize(token, meta)
    @token = token
    @meta  = meta
  end

  # ---------- 元信息读取（带默认值，老数据缺字段也不炸）----------

  def name        = @meta['name'].to_s
  def type        = @meta['type'].to_s
  def size        = @meta['size'].to_i
  def done?       = @meta['done'].to_i != 0
  def max         = @meta['max'].to_i
  def left        = @meta['left'].to_i
  def public?     = @meta.fetch('pub', 1).to_i != 0
  def password    = @meta['pw'].to_s
  def has_pw?     = !password.empty?
  def owner       = @meta['by'].to_s
  def created_at  = @meta['at'].to_i
  def expires_at  = @meta['exp_at'].to_i
  def chunk_size  = @meta['chunk'].to_i
  def total_parts = @meta['total_parts'].to_i
  def dead?       = !@meta['dead'].nil?
  def data_path   = self.class.send(:data_path, @token)
  def meta_path   = self.class.send(:meta_path, @token)

  # ---------- 失效判定（判定条件只有这一份）----------

  def quota_used?   = max > 0 && left <= 0
  def time_expired? = expires_at > 0 && Time.now.to_i >= expires_at

  # 失效原因，:none 表示有效。
  def dead_reason
    return QUOTA   if quota_used?
    return EXPIRED if time_expired?
    NONE
  end

  def alive? = dead_reason == NONE

  # 给用户看的话
  def dead_message
    case dead_reason
    when QUOTA   then '次数已用完'
    when EXPIRED then '链接已过期'
    else ''
    end
  end

  # 文件本体在不在（meta 还在但 data 被删了 —— 少见但要能报出来）
  def data_exists? = File.file?(data_path)

  # ---------- 懒清理 ----------
  #
  # 返回 true = 这个分享已经没了，调用方应该跳过。
  #
  # :mark   → 第一次打 dead 标记（保留数据，返回 false，本次还能报具体原因）
  # :delete → 直接物理删
  #
  # 未完成的（done=0）一律不清：留着给上传者续传。
  def reap!(purge: :mark)
    if dead?
      destroy!            # 之前就标记过了 → 这次真的删
      return true
    end
    return false if done? == false   # 续传中的不碰
    return false if alive?

    case purge
    when :delete then destroy!
    when :mark
      @meta['dead'] = true
      @meta['dead_at'] = Time.now.to_i
      save!
    end
    false
  end

  def destroy!
    FileUtils.rm_rf(dir_of(@token))
    @meta = {}
    true
  end

  def save!
    File.write(meta_path, @meta.to_json)
  end

  # ---------- 授权 ----------
  #
  # 迁移前三套策略各写一遍：
  #   delete   允许 owner(cid) 或 正确密码 任一通过
  #            —— 删掉就是回到「没人能访问」的状态，风险低；
  #            给「知道密码但换设备」留个后路。
  #   edit     只认 owner
  #            —— 改配置能把私密改成公开，风险更高，必须限定所有者。
  #   download 只认密码，且私密分享强制要密码
  #            —— 密码是唯一凭证。
  #   preview  只认「公开且有效」
  #
  # 现在是一个方法，策略由调用方用关键字组合：
  #   s.authorized?(pw: pw)                  # 下载
  #   s.authorized?(cid: cid)                # 改配置
  #   s.authorized?(cid: cid, pw: pw)        # 删除（任一即可）
  def owned_by?(cid)  = !cid.to_s.empty? && owner == cid.to_s
  def pw_matches?(pw) = !password.empty? && password == pw.to_s

  # 私密分享（pub=0）必须过密码，哪怕历史数据里 pw 意外为空也不能放行
  # —— 否则「私密」名不副实时会泄露。公开分享则是「设了密码才校验，没密码直接过」。
  def pw_required? = !public?
  def pw_needed?   = pw_required? || has_pw?

  # 授权。三个策略组合，对应迁移前三套实现：
  #
  #   authorized?(pw: pw)                    下载 —— 只认密码。
  #                                          公开免密分享任何人可下，这是产品设计。
  #   authorized?(cid: cid, require_cred: true)   改配置 —— 只认所有者。
  #                                          公开也不能免，否则能把私密改成公开。
  #   authorized?(cid: cid, pw: pw, require_cred: true)
  #                                          删除 —— 两者任一，但**不能两个都没有**。
  #                                          token 只有 16 位 hex，链接被别人捡到
  #                                          就能删掉别人的分享，所以裸 token 绝不放行。
  #
  # require_cred: true 时，除非拿到有效的 cid 或正确密码，否则一律拒绝。
  def authorized?(cid: nil, pw: nil, require_cred: false)
    return true if !cid.to_s.empty? && owned_by?(cid)
    if pw_needed?
      return pw_matches?(pw)
    elsif require_cred
      # 公开免密分享：没有密码可校验，那就必须有所有者身份
      return false
    end
    pw.to_s.empty?
  end

  # 未完成的分享（done=0）没有凭证也允许删除 —— 它还没对外发过链接，
  # 传出去也没用，留着只是等续传。调用方拿它做「丢弃」按钮的后端判断。
  #
  # 注意 Ruby 里 "" 是 truthy，所以「调用方有没有给凭证」必须用 empty? 判断，
  # 不能写 `|| pw` —— 后者永远为真，会把「什么都没给」也当成有凭证。
  def discardable? = !done?

  # ---------- 配额 ----------

  def unlimited?  = max <= 0
  def left_label  = unlimited? ? 'inf' : left.to_s

  # 扣一次下载次数。发出响应前调用 —— 扣减和发文件在同一进程内完成，
  # 单机 CGI 每请求独立进程，正常不会并发写同一个 token。
  def consume_quota!
    return false if unlimited?
    @meta['left'] = [left - 1, 0].max
    save!
    true
  end

  # 改 max 时按「已用掉多少」重算 left，让配额调整后剩余次数仍自洽。
  def set_max!(n)
    used = max > 0 ? (max - left) : 0
    used = 0 if used.negative?
    @meta['max']  = n
    @meta['left'] = n > 0 ? [n - used, 0].max : n
  end

  # ---------- 配置修改（edit 端点）----------
  #
  # 为什么用哨兵值表示「不改」：max 的合法值含 0（无限）、exp 含 0（永久）、
  # pub 含 0（私密）、pw 含空串（免密）—— 四者都有「合法且必须显式表达」的值，
  # 不能用「参数缺失」表示不改。统一用 -1（数值）/ 不传（pw）区分。

  def apply_max!(n)
    set_max!(clamp_max(n))
  end

  def apply_exp!(hours)
    return if hours.negative?             # -1 = 不改（clamp_exp 里负数当 0，语义不同）
    hours = MAX_EXP_H if hours > MAX_EXP_H
    @meta['exp']    = hours
    @meta['exp_at'] = hours > 0 ? Time.now.to_i + hours * 3600 : 0
  end

  # 改密码。取消密码后如果它本来是「私密」，那这个分享就没有任何保护了 ——
  # 自动降级成公开，否则下载端会因为「私密却没密码」而永久拒绝（死锁）。
  def apply_pw!(new_pw)
    new_pw = new_pw.to_s[0, 64]
    @meta['pub'] = 1 if new_pw.empty? && !public?
    @meta['pw']  = new_pw
  end

  # 改成私密必须有密码，否则这个分享等于公开却标着「私密」，
  # 而且下载端会一直 401 谁都下不了 —— 调用方要拒绝这个组合。
  def apply_pub!(v)
    return if v.negative?              # -1 = 不改
    v = 1 if v > 1
    @meta['pub'] = v
  end

  def can_be_private? = !password.empty?

  def to_config
    {
      token:  @token,
      max:    max,
      left:   left,
      exp:    @meta['exp'].to_i,
      exp_at: expires_at,
      pub:    public? ? 1 : 0,
      has_pw: has_pw?
    }
  end

  # 一次性上传（不分片）：直接写 data，meta.done = 1。
  # 分片上传走 create → PUT part → finish 那条路，不走这里。
  #
  # token 省略时用 SecureRandom 生成；给了就用给的 ——
  # 调用方自己指定 token 的场景（POST /<token>）走这条路。
  def self.upload_direct!(name:, type:, content:, max: 0, exp_h: 0, pub: 1,
                         pw: '', owner: '', now: Time.now.to_i, token: nil)
    token ||= SecureRandom.hex(8)
    FileUtils.mkdir_p(dir_of(token))
    # 覆盖已有分享时清掉残留的 part/ —— 那是之前分片上传留下的半成品，
    # 留着既占空间，又会让 missing_parts 的判断失真（以为还有片没传）。
    FileUtils.rm_rf(File.join(dir_of(token), 'part'))
    File.binwrite(data_path(token), content)

    meta = {
      'name'   => sanitize_name(name),
      'type'   => type.to_s[0, 100],
      'size'   => content.bytesize,
      'max'    => max,
      'left'   => max,                 # 0 = 无限
      'pub'    => pub,
      'pw'     => pw.to_s[0, 64],
      'by'     => clean_cid(owner),
      'exp'    => exp_h,
      'exp_at' => (exp_h > 0 ? now + exp_h * 3600 : 0),
      'at'     => now,
      'done'   => 1,                    # 1=已完成
      'chunk'  => 0,                    # 0=不分片
      'total_parts' => 1
    }
    File.write(meta_path(token), meta.to_json)
    new(token, meta)
  end

  def to_upload_info
    {
      token:  @token,
      url:    "/tool/share/#{@token}",         # 文件本体，不是分享链接（分享链接用 /page）
      name:   name,
      size:   size,
      type:   type,
      max:    max,
      pub:    public? ? 1 : 0,
      has_pw: has_pw?,
      exp_at: expires_at
    }
  end

  # ---------- 分片 ----------

  def got_parts    = done? ? [] : scan_got_parts(@token)
  def part_size    = chunk_size
  def parts_total  = total_parts
  def all_parts?   = got_parts.length >= total_parts && total_parts > 0

  # 缺哪些片 → (0...total) - got
  def missing_parts
    (0...total_parts).to_a - got_parts
  end

  # 写一片。幂等：重传同一片直接覆盖。
  # 幂等很重要 —— 客户端重试 / 网络抖动重发都不该报错。
  def write_part!(n, content)
    FileUtils.mkdir_p(File.join(dir_of(@token), 'part'))
    File.binwrite(part_path(@token, n), content)
    got = scan_got_parts(@token)
    {
      token: @token, n: n,
      got: got.length, total_parts: total_parts,
      all_parts: got,
      complete: got.length >= total_parts
    }
  end

  # 校验一片的 Content-Range 是否跟 n 自洽。
  #
  # 为什么必须校验而不是信任客户端：
  #   客户端必须显式声明这一片在文件里的位置，服务端不靠「下一个 n 是多少」推断
  #   （并发时顺序不可控）。n × chunk 必须等于 start，否则分片顺序错了，
  #   finish 合并出来的文件就是乱的，而那时已经晚了。
  #
  # 返回 nil 表示校验通过，否则返回错误文案。
  def check_part_range(n, start, finish, cr_total)
    return "range end < start" if finish < start
    return "total mismatch: #{cr_total} != #{size}" if cr_total != size
    c = chunk_size
    return "start #{start} != n*chunk #{n * c}" if c > 0 && start != n * c
    nil
  end

  # 合并 part/* → data。
  #
  # 先写 data.tmp 再 rename —— rename 在同一文件系统内是原子的。
  # 下载端 GET /<token> 直接读 data 文件，如果边合并边被下载，
  # 对方拿到的是残缺内容。rename 让下载端要么看到旧状态（没有 data），
  # 要么看到完整的。
  #
  # 返回合并后的字节数；大小对不上抛 RangeError（调用方转成 500）。
  def merge_parts!
    total = total_parts
    tmp = File.join(dir_of(@token), 'data.tmp')
    merged = 0
    File.open(tmp, 'wb') do |out|
      (0...total).each do |i|
        data = File.binread(part_path(@token, i))
        out.write(data)
        merged += data.bytesize
      end
    end

    unless merged == size
      File.delete(tmp)
      raise RangeError, "size mismatch: merged #{merged} != declared #{size}"
    end

    File.rename(tmp, data_path)
    FileUtils.rm_rf(File.join(dir_of(@token), 'part'))   # 省空间
    @meta['done'] = 1
    save!
    merged
  end

  def to_finish_info(merged, already: false)
    {
      token:   @token,
      url:     "/tool/share/#{@token}",         # 文件本体，不是分享链接（分享链接用 /page）
      name:    name,
      size:    size,
      type:    type,
      max:     max,
      has_pw:  has_pw?,
      exp_at:  expires_at,
      merged:  merged,
      already: (already ? true : nil)
    }.compact
  end

  # ---------- 视图 ----------

  # 列表用的完整记录。editable 由调用方给的 cid 决定 —— 判定在服务端，
  # 前端不用自己猜。
  def to_item(cid = nil)
    {
      token:   @token,
      # url  分享链接给人看（详情页，能输密码）
      # dl   文件本体，给程序取（curl / wget）
      url:     "/tool/share/#{@token}/page",
      dl:      "/tool/share/#{@token}",
      name:    name,
      size:    size,
      type:    type,
      max:     max,
      left:    left,
      pub:     public? ? 1 : 0,
      has_pw:  has_pw?,
      exp_at:  expires_at,
      at:      created_at,
      done:    done? ? 1 : 0,
      editable: owned_by?(cid),
      chunk:   chunk_size,
      total_parts: total_parts,
      got_parts:  got_parts
    }
  end

  # 元信息接口用的精简记录（下载页/预览页要的那几个字段）
  def to_info
    {
      name:    name,
      type:    type,
      size:    size,
      max:     max,
      left:    left,
      pub:     public? ? 1 : 0,
      has_pw:  has_pw?,
      exp_at:  expires_at,
      at:      created_at
    }
  end

  # ---------- 文件输出 ----------
  #
  # 下载和预览的响应头在这里拼 —— 两者共用一个方法，差异只在
  # disposition 是 attachment（下载）还是 inline（预览）。

  # Content-Disposition 里用的文件名：跟 create/upload 同一套规则（Unicode 安全），
  # 另外把 " 和 CR/LF 去掉 —— 这两个进了 header 会破坏响应头结构。
  def header_safe_name
    n = name.gsub(/["\r\n]/, '')
         .gsub(%r{[/\\]} , '_')
         .gsub(/[^\p{L}\p{N}._\- ]/u, '_')
         .strip[0, 160]
    n.empty? ? 'file' : n
  end

  # RFC 6266：filename 给 ASCII 兜底，filename* 给 UTF-8 真名。
  # 直接把中文塞进 filename="..." 的话，浏览器多半拿到乱码或整串丢弃。
  #
  # 顺序要紧：先把非 ASCII 字节转成 %XX，再单独处理 " % 空格这三个字符。
  # 反过来做的话，刚生成的 % 会被第二次 gsub 再转义成 %25，就坏了。
  def content_disposition(disp)
    safe = header_safe_name
    ascii = safe.gsub(/[^\x20-\x7e]/, '_').gsub('"', '')
    utf8  = safe.b
          .gsub(/["%\s]/)  { |c| format('%%%02X', c.ord) }
          .gsub(/[\x80-\xff]/n) { |b| format('%%%02X', b.ord) }
    %(#{disp}; filename="#{ascii}"; filename*=UTF-8''#{utf8})
  end

  def mime
    t = type
    t.empty? ? 'application/octet-stream' : t
  end

  # 预览用的 mime：文本补 charset，否则浏览器按 latin-1 解码中文会乱码
  def mime_inline
    m = mime
    m.include?('charset') ? m : (m.start_with?('text/') ? "#{m}; charset=utf-8" : m)
  end

  # 预览专用的响应头。跟下载的区别：
  #   inline 而不是 attachment（浏览器当页面内容渲染）
  #   no-store（预览是只读展示，改完配置不该还看到旧内容）
  #   nosniff（这是别人上传的内容，别让浏览器嗅探类型）
  #   Accept-Ranges（声明支持 Range，浏览器才会用 206 拖动/续传音视频）
  def preview_headers(rsp)
    rsp.header_field('Content-Disposition', 'inline')
    rsp.header_field('Cache-Control', 'no-store')
    rsp.header_field('X-Content-Type-Options', 'nosniff')
    rsp.header_field('Accept-Ranges', 'bytes')
  end

  # 下载：attachment + 扣一次配额
  def serve_attachment(rsp)
    consume_quota!
    rsp.header_field('Content-Disposition', content_disposition('attachment'))
    rsp.header_field('X-Share-Left', left_label)
    rsp.type(mime).body(data_path).finish
  end

  # 预览：inline + 不扣配额。
  # Range（206 分段）由调用方处理 —— 那是 preview 端点特有的逻辑，
  # 跟共享的这套响应头拼装无关。
  def serve_inline(rsp)
    rsp.header_field('Content-Disposition', content_disposition('inline'))
    rsp.header_field('X-Share-Left', left_label)
    rsp.type(mime).body(data_path).finish
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

# ---------- 文件名清洗 ----------
#
# create/upload 版本：保留 Unicode 字母数字（\p{L}\p{N}），干掉路径分隔符和控制字符。
# 原来用 [^\w.\- ]，但 Ruby 的 \w 只认 ASCII —— 中文会被整片替换成 _，
# 「报告.txt」变成「__.txt」，等于文件名丢失。必须用 \p{L}\p{N} + /u。
def sanitize_name(s)
  n = s.to_s.gsub(%r{[/\\]} , '_')
       .gsub(/[\x00-\x1f\x7f]/, '')
       .gsub(/[^\p{L}\p{N}._\- ]/u, '_')
       .strip[0, 160]
  n.empty? ? 'file' : n
end