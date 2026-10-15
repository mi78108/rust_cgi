# frozen_string_literal: true
# posts/_lib.rb — 长文章数据模块 (跟 notes/_lib.rb 同构)
#
# 数据源: ./root/data/posts/<slug>.md
# frontmatter 跟 notes 一致: title / date / updated / tags
#
# API (跟 notes 同构, 前端可直接复用 drawer):
#   GET /root/posts                 → 列表
#   GET /root/posts/api/tags        → 标签云
#   GET /root/posts/api/posts/<slug> → 单篇 (含 prev/next)
#
# 跟 notes 的差别: posts 适合长文, 加一个字段:
#   summary  (frontmatter 可选) — 列表卡片用的 1-2 句话摘要

require 'date'
require 'time'

# TODO(新 _base_ 不兼容): parse_body (L188-203) 用了老 Rsp API:
#   resp.code = 400
#   resp.status = 'Bad Request'
#   resp.json({...})
# 新版 cgi/_base_.rb 的 Rsp 没有 `code=`/`status=` setter, 也没有 `json` method
# (用 rsp.json(obj) 一站式 type_json + ok + body). 跑起来会 NoMethodError.
# 暂不动业务逻辑, 仅作记录 — 调用方 (posts/post, posts/put) 用 `data = parse_body(req, rsp) || next`
# 会拿到 nil 后 next 跳出 Q.post/Q.put 块; 但 rsp 已被改, finish 仍能写出错 body (200 OK
# + json error body, 而非 400 — 因为新版没有 `code=` setter).

POSTS_DIR = File.expand_path('../data/posts', __dir__)

def parse_post_file(path)
  raw = File.read(path, encoding: 'utf-8')
  return { meta: {}, body: raw } unless raw.start_with?("---\n")

  m = raw.match(/\A---\n(.*?\n)---\n(.*)\z/m)
  return { meta: {}, body: raw } unless m

  meta = {}
  m[1].each_line do |line|
    line = line.strip
    next if line.empty? || line.start_with?('#')
    k, v = line.split(':', 2)
    next unless k && v
    k = k.strip.to_sym
    v = v.strip
    if v.start_with?('[') && v.end_with?(']')
      inner = v[1..-2].split(',').map { |s| s.strip.gsub(/\A["']|["']\z/, '') }.reject(&:empty?)
      meta[k] = inner
    else
      meta[k] = v.gsub(/\A["']|["']\z/, '')
    end
  end
  { meta: meta, body: m[2] }
end

def parse_iso_post(s)
  return nil if s.nil? || s.empty?
  Time.parse(s)
rescue ArgumentError
  nil
end

def slug_from_post_path(path)
  File.basename(path, '.md')
end

def reading_minutes_post(text)
  cjk = text.scan(/\p{Han}/).size
  ascii_words = text.scan(/[A-Za-z]+/).size
  minutes = (cjk / 300.0) + (ascii_words / 220.0)
  [minutes.ceil, 1].max
end

def excerpt_for_post(body, max = 200)
  s = body.gsub(/[#>*_`\-]/, '').gsub(/\s+/, ' ').strip
  return s if s.length <= max
  s[0, max].rstrip + '…'
end

def all_posts
  return [] unless Dir.exist?(POSTS_DIR)
  Dir.glob(File.join(POSTS_DIR, '*.md')).map do |path|
    parsed = parse_post_file(path)
    slug = slug_from_post_path(path)
    meta = parsed[:meta]
    created_at = parse_iso_post(meta[:date]) || File.mtime(path)
    updated_at = parse_iso_post(meta[:updated]) || created_at
    tags = meta[:tags].is_a?(Array) ? meta[:tags] : []
    summary = meta[:summary].to_s.empty? ? excerpt_for_post(parsed[:body], 200) : meta[:summary]
    {
      slug:        slug,
      title:       meta[:title].to_s.empty? ? slug : meta[:title],
      summary:     summary,
      tags:        tags,
      reading_min: reading_minutes_post(parsed[:body]),
      created_at:  created_at.iso8601,
      updated_at:  updated_at.iso8601,
      _path:       path,
    }
  end.sort_by { |p| p[:updated_at] }.reverse
end

def find_post(slug)
  path = File.join(POSTS_DIR, "#{slug}.md")
  return nil unless File.file?(path)
  parsed = parse_post_file(path)
  meta = parsed[:meta]
  created_at = parse_iso_post(meta[:date]) || File.mtime(path)
  updated_at = parse_iso_post(meta[:updated]) || created_at
  tags = meta[:tags].is_a?(Array) ? meta[:tags] : []
  author = meta[:author].to_s.empty? ? 'hawk' : meta[:author]
  {
    slug:        slug,
    title:       meta[:title].to_s.empty? ? slug : meta[:title],
    body:        parsed[:body].strip,
    author:      author,
    tags:        tags,
    reading_min: reading_minutes_post(parsed[:body]),
    created_at:  created_at.iso8601,
    updated_at:  updated_at.iso8601,
  }
end

# ── 写操作 (create / update) ──────────────────────
# 输入 (Hash): { slug, title, body, author?, tags: [..] }
# 自动写入 frontmatter, 文件名 <slug>.md
def write_post(data)
  slug = data[:slug].to_s
  return { ok: false, error: 'slug must match /[a-z0-9_-]+/' } unless slug =~ /\A[a-z0-9_-]{1,40}\z/
  title = data[:title].to_s.strip
  return { ok: false, error: 'title required' } if title.empty?
  body  = data[:body].to_s
  tags  = Array(data[:tags]).map(&:to_s).select { |t| t =~ /\A[a-z0-9_-]+\z/ }
  author = data[:author].to_s.empty? ? 'hawk' : data[:author]
  now   = Time.now.utc.iso8601
  meta = { title: title, author: author, date: now, updated: now, tags: tags }
  yaml_meta = meta.map { |k, v| "#{k}: #{v.is_a?(Array) ? "[#{v.join(', ')}]" : v}" }.join("\n")
  content = "---\n#{yaml_meta}\n---\n\n#{body}\n"
  Dir.mkdir(POSTS_DIR) unless Dir.exist?(POSTS_DIR)
  path = File.join(POSTS_DIR, "#{slug}.md")
  File.write(path, content)
  { ok: true, slug: slug, path: path }
rescue => e
  { ok: false, error: e.message }
end

def create_post(data)
  slug = data[:slug].to_s.empty? ? slugify(data[:title].to_s) : data[:slug].to_s
  return { ok: false, error: 'slug conflict' } if File.file?(File.join(POSTS_DIR, "#{slug}.md"))
  write_post(data.merge(slug: slug))
end

def update_post(slug, data)
  path = File.join(POSTS_DIR, "#{slug}.md")
  return { ok: false, error: 'not found' } unless File.file?(path)
  write_post(data.merge(slug: slug))
end

def slugify(title)
  title.to_s.downcase.strip.gsub(/[^a-z0-9]+/, '-').gsub(/^-+|-+$/, '')[0, 40] || "post-#{Time.now.to_i}"
end

def post_tag_counts
  counts = Hash.new(0)
  all_posts.each { |p| p[:tags].each { |t| counts[t] += 1 } }
  counts.sort_by { |_, v| -v }.map { |name, count| { name: name, count: count } }
end

def post_with_prev_next(slug, post_hash)
  list = all_posts
  idx = list.index { |p| p[:slug] == slug }
  return post_hash if idx.nil?
  prev_p = list[idx + 1]
  next_p = idx > 0 ? list[idx - 1] : nil
  post_hash.merge(
    prev: prev_p ? { slug: prev_p[:slug], title: prev_p[:title] } : nil,
    next: next_p ? { slug: next_p[:slug], title: next_p[:title] } : nil,
  )
end

def serialize_post_list(p)
  p.reject { |k, _| k == :_path }
end

# ── 写操作 helper (鉴权 / body parse) ──────────────────
# # 写操作鉴权 (Bearer token) — demo 级, 不是真安全
# WRITE_TOKEN = ENV['POSTS_WRITE_TOKEN'] || 'hawk-write-2026'
#
# def require_write_auth(req, resp)
#   auth = req.header('Authorization') || ENV['HTTP_AUTHORIZATION']
#   token = auth.to_s.sub(/^Bearer\s+/i, '').strip
#   return true if token == WRITE_TOKEN
#   resp.code   = 401
#   resp.status = 'Unauthorized'
#   resp.json({ error: 'unauthorized', code: 401 })
#   false
# end

def parse_body(req, resp)
  raw = req.body.to_s
  # framework 已读 STDIN (Q.read); 兜底: 若空且无 content-length, 尝试读剩余 stdin
  if raw.empty?
    begin
      Timeout.timeout(0.05){ raw = STDIN.read_nonblock(65536) } rescue nil
    rescue
    end
  end
  return {} if raw.nil? || raw.empty?
  JSON.parse(raw, symbolize_names: true)
rescue JSON::ParserError => e
  resp.code   = 400
  resp.status = 'Bad Request'
  resp.json({ error: 'invalid JSON body', msg: e.message })
  nil
end