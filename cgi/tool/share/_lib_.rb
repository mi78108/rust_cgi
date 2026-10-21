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
#     return s.fail(rsp, 404, 'not found') if s.nil?
#     return s.fail(rsp, 410, s.expired_message) unless s.alive?
#     return s.fail(rsp, 401, '密码错误', has_pw: true) unless s.authorized?(pw: req.param('p'))
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

SHARE_ROOT = ENV.fetch('SPIDER_DATA', nil).to_s.empty? ? '/tmp/share' : ENV['SPIDER_DATA']

def dir_of(token)   = File.join(SHARE_ROOT, token)
def meta_path(token) = File.join(dir_of(token), 'meta.json')
def data_path(token) = File.join(dir_of(token), 'data')
def part_path(token, n) = File.join(dir_of(token), 'part', n.to_s)

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

def json(rsp, code, payload)
  rsp.code(code).type_json.body(payload.to_json).finish
end

# ══════════════════════════════════════════════════════════════
#  Share
# ══════════════════════════════════════════════════════════════
class Share
  TOKEN_RE = /\A[a-f0-9]{16}\z/

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
      'by'     => owner.to_s.gsub(/[^A-Za-z0-9_-]/, '')[0, 40],
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
    n = 0 if n.negative?
    n = 100_000 if n > 100_000
    set_max!(n)
  end

  def apply_exp!(hours)
    return if hours.negative?          # -1 = 不改
    hours = 87_600 if hours > 87_600   # 上限 10 年
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
  def self.upload_direct!(name:, type:, content:, max: 0, exp_h: 0, pub: 1,
                         pw: '', owner: '', now: Time.now.to_i)
    token = SecureRandom.hex(8)
    FileUtils.mkdir_p(dir_of(token))
    File.binwrite(data_path(token), content)

    meta = {
      'name'   => sanitize_name(name),
      'type'   => type.to_s[0, 100],
      'size'   => content.bytesize,
      'max'    => max,
      'left'   => max,                 # 0 = 无限
      'pub'    => pub,
      'pw'     => pw.to_s[0, 64],
      'by'     => owner.to_s.gsub(/[^A-Za-z0-9_-]/, '')[0, 40],
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
      url:    "/tool/share/download/#{@token}",   # 文件本体，不是分享链接
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
      url:     "/tool/share/download/#{@token}",   # 文件本体，不是分享链接
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
      url:     "/tool/share/download?t=#{@token}",
      dl:      "/tool/share/download/#{@token}",
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

  # ---------- 响应快捷方式 ----------
  #
  # find 返回 nil 时不能调实例方法，所以 404 也提供一个类方法，
  # 让路由能一行写完：return Share.missing(rsp) if s.nil?

  def self.missing(rsp)
    json(rsp, 404, ok: false, error: 'not found')
  end

  def fail(rsp, code, error, **extra)
    json(rsp, code, { ok: false, error: error }.merge(extra))
  end

  def ok(rsp, data)
    json(rsp, 200, { ok: true, data: data })
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