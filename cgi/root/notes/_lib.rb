# frozen_string_literal: true
# notes/_lib.rb — 共享 frontmatter 解析 + 列表/单篇查询
#
# 数据源: ./root/data/notes/<slug>.md
# 文件格式:
#   ---
#   title: My note title
#   date: 2026-09-28T11:00:00Z       # created_at
#   updated: 2026-09-28T11:00:00Z    # updated_at (可选)
#   tags: [rust, ruby, gentoo]
#   ---
#   <body markdown>
#
# API 契约 (今天已落地, 假数据已填):
#   GET /notes        → { notes: [...] }
#   GET /notes/:slug  → { slug, title, body_md, tags, ... } | 404
#   GET /notes/tags   → { tags: [...] }
#
# 未来扩展点 (今天不做, 留好形状):
#   - 分页: GET /notes?limit=&offset=
#   - 按 tag 过滤: GET /notes?tag=rust
#   - 全文搜索: GET /notes?q=keyword
#   - 草稿/发布: frontmatter 加 `draft: true`, 列表接口过滤
#   - 写接口: POST/PATCH /notes (需鉴权, 留 TODO)

require 'date'
require 'time'

NOTES_DIR = File.expand_path('../data/notes', __dir__)

# 解析 frontmatter, 返回 { meta: {sym=>val}, body: String }
def parse_note_file(path)
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
    # simple YAML-ish: 数组 [a, b] / 标量
    if v.start_with?('[') && v.end_with?(']')
      inner = v[1..-2].split(',').map { |s| s.strip.gsub(/\A["']|["']\z/, '') }.reject(&:empty?)
      meta[k] = inner
    else
      meta[k] = v.gsub(/\A["']|["']\z/, '')
    end
  end
  { meta: meta, body: m[2] }
end

def parse_iso(s)
  return nil if s.nil? || s.empty?
  Time.parse(s)
rescue ArgumentError
  nil
end

def slug_from_filename(path)
  File.basename(path, '.md')
end

# 计算 reading time (粗略: 中文按字, 英文按词, 平均 ~300 字/分钟)
def reading_minutes(text)
  cjk = text.scan(/\p{Han}/).size
  ascii_words = text.scan(/[A-Za-z]+/).size
  minutes = (cjk / 300.0) + (ascii_words / 220.0)
  [minutes.ceil, 1].max
end

def excerpt_for(body, max = 140)
  s = body.gsub(/[#>*_`\-]/, '').gsub(/\s+/, ' ').strip
  return s if s.length <= max
  s[0, max].rstrip + '…'
end

# 列出全部笔记 (返回 hash 数组), 按 updated_at desc 排序
def all_notes
  return [] unless Dir.exist?(NOTES_DIR)
  Dir.glob(File.join(NOTES_DIR, '*.md')).map do |path|
    parsed = parse_note_file(path)
    slug = slug_from_filename(path)
    meta = parsed[:meta]
    created_at = parse_iso(meta[:date]) || File.mtime(path)
    updated_at = parse_iso(meta[:updated]) || created_at
    tags = meta[:tags].is_a?(Array) ? meta[:tags] : []
    {
      slug:        slug,
      title:       meta[:title].to_s.empty? ? slug : meta[:title],
      excerpt:     excerpt_for(parsed[:body]),
      tags:        tags,
      reading_min: reading_minutes(parsed[:body]),
      created_at:  created_at.iso8601,
      updated_at:  updated_at.iso8601,
      _path:       path,
    }
  end.sort_by { |n| n[:updated_at] }.reverse
end

def find_note(slug)
  path = File.join(NOTES_DIR, "#{slug}.md")
  return nil unless File.file?(path)
  parsed = parse_note_file(path)
  meta = parsed[:meta]
  created_at = parse_iso(meta[:date]) || File.mtime(path)
  updated_at = parse_iso(meta[:updated]) || created_at
  tags = meta[:tags].is_a?(Array) ? meta[:tags] : []
  {
    slug:        slug,
    title:       meta[:title].to_s.empty? ? slug : meta[:title],
    body:        parsed[:body].strip,
    tags:        tags,
    reading_min: reading_minutes(parsed[:body]),
    created_at:  created_at.iso8601,
    updated_at:  updated_at.iso8601,
  }
end

# tags 聚合 [{ name, count }]
def tag_counts
  counts = Hash.new(0)
  all_notes.each { |n| n[:tags].each { |t| counts[t] += 1 } }
  counts.sort_by { |_, v| -v }.map { |name, count| { name: name, count: count } }
end

# 给单篇加 prev/next (按 updated_at desc 列表里)
def with_prev_next(slug, note_hash)
  list = all_notes
  idx = list.index { |n| n[:slug] == slug }
  return note_hash if idx.nil?
  prev_n = list[idx + 1]
  next_n = idx > 0 ? list[idx - 1] : nil
  note_hash.merge(
    prev: prev_n ? { slug: prev_n[:slug], title: prev_n[:title] } : nil,
    next: next_n ? { slug: next_n[:slug], title: next_n[:title] } : nil,
  )
end

# 列表响应裁剪字段 (隐藏内部 _path)
def serialize_list(n)
  n.reject { |k, _| k == :_path }
end

# ── 写操作 (create / update) ──────────────────────
# 输入 (Hash): { slug, title, body, author?, tags: [..] }
def write_note(data)
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
  Dir.mkdir(NOTES_DIR) unless Dir.exist?(NOTES_DIR)
  path = File.join(NOTES_DIR, "#{slug}.md")
  File.write(path, content)
  { ok: true, slug: slug, path: path }
rescue => e
  { ok: false, error: e.message }
end

def create_note(data)
  slug = data[:slug].to_s.empty? ? slugify(data[:title].to_s) : data[:slug].to_s
  return { ok: false, error: 'slug conflict' } if File.file?(File.join(NOTES_DIR, "#{slug}.md"))
  write_note(data.merge(slug: slug))
end

def update_note(slug, data)
  path = File.join(NOTES_DIR, "#{slug}.md")
  return { ok: false, error: 'not found' } unless File.file?(path)
  write_note(data.merge(slug: slug))
end

def slugify(title)
  title.to_s.downcase.strip.gsub(/[^a-z0-9]+/, '-').gsub(/^-+|-+$/, '')[0, 40] || "note-#{Time.now.to_i}"
end