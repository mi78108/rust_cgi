# frozen_string_literal: true
# posts/_lib_.rb — 长文章领域模型
#
# 一个 Post = data/posts/<yyyy>/<mm>/<slug>.md 一个文件。
# 目录按 frontmatter date (created_at) 分, 建后不再变动。
#
# 分层 (跟 tool/share 的 Share + Share::Api 同一套思路):
#   class Post    领域模型: 一篇文章是什么、能做什么
#   module Api    把 HTTP 请求翻译成对 Post 的调用
# 路由脚本只写「取参 → 调方法 → 包响应」, 不写业务逻辑。
#
# frontmatter:
#   ---
#   title: 文章标题
#   date: 2026-09-28T11:00:00Z       # created_at
#   updated: 2026-09-28T11:00:00Z    # updated_at (可选)
#   tags: [rust, ruby, gentoo]
#   summary: 列表卡片用的 1-2 句话摘要 (可选, 缺省从正文截)
#   ---

require 'date'
require 'time'
require 'json'
require 'timeout'
require 'fileutils'

class Post
  # __dir__ 定位 (不能只靠相对路径): 本文件被 cgi/root/posts/* (CWD=cgi/root/posts)
  # 和 cgi/root/search (CWD=cgi/root) 两处 require, 两者 CWD 差一层, 相对路径必有一个错
  ROOT = File.expand_path('../data/posts', __dir__)

  # ── 存储层 ────────────────────────────────────────────

  # 递归列出全部 .md (data/posts/<yyyy>/<mm>/ 下, 任意深度)
  def self.paths
    return [] unless Dir.exist?(ROOT)
    Dir.glob(File.join(ROOT, '**', '*.md')).sort
  end

  # 按 slug 定位文件 (递归搜索; 重名取第一个)
  def self.path_for(slug)
    paths.find { |p| File.basename(p, '.md') == slug }
  end

  # date → '<yyyy>/<mm>' 相对子目录
  def self.rel_dir(date)
    t = date.is_a?(Time) ? date : (parse_iso(date) || Time.now.utc)
    format('%04d/%02d', t.year, t.month)
  end

  # ── 构造 ──────────────────────────────────────────────

  # full: true 时带 body (列表不需要, 全文搜索/详情需要)
  def self.list(full: false)
    paths.filter_map { |path| from_path(path, full: full) }
         .sort_by { |p| p[:updated_at] }.reverse
  end

  def self.find(slug)
    path = path_for(slug)
    path && from_path(path, full: true)
  end

  def self.find_by_slug_prefix(prefix)
    list.find { |p| p[:slug].start_with?(prefix) }
  end

  # 从文件构造 (解析 frontmatter)
  def self.from_path(path, full: false)
    raw  = File.read(path, encoding: 'utf-8')
    meta, body = parse_frontmatter(raw)
    created = parse_iso(meta[:date])   || File.mtime(path)
    updated = parse_iso(meta[:updated]) || created
    {
      slug:        File.basename(path, '.md'),
      title:       meta[:title].to_s.empty? ? File.basename(path, '.md') : meta[:title],
      summary:     meta[:summary].to_s.empty? ? excerpt(body, 200) : meta[:summary],
      tags:        meta[:tags].is_a?(Array) ? meta[:tags] : [],
      reading_min: reading_minutes(body),
      created_at:  created,
      updated_at:  updated,
      body:        full ? body.strip : nil,
      _path:       path,
    }
  end

  # ── 写入 ──────────────────────────────────────────────

  # 创建: slug 为空时从 title 生成; 返回 { ok:, slug:, error: }
  def self.create(slug:, title:, body:, summary: nil, tags: [], date: nil)
    slug = slug.to_s.empty? ? slugify(title) : slug.to_s
    return { ok: false, error: 'slug conflict' } if path_for(slug)
    write(slug: slug, title: title, body: body, summary: summary, tags: tags, date: date)
  end

  # 更新: 目录不变 (date 决定路径, 更新时不传 date 就沿用原目录)
  def self.update(slug:, title:, body:, summary: nil, tags: [])
    path = path_for(slug)
    return { ok: false, error: 'not found' } unless path
    old = from_path(path, full: true)
    write(slug: slug, title: title, body: body, summary: summary,
          tags: tags, date: old[:created_at])
  end

  def self.write(slug:, title:, body:, summary: nil, tags: [], date: nil)
    now   = Time.now.utc
    stamp = date || now
    meta  = { title: title, author: 'hawk', date: stamp.iso8601,
              updated: now.iso8601, tags: tags }
    meta[:summary] = summary unless summary.to_s.empty?
    yaml  = meta.map { |k, v| "#{k}: #{v.is_a?(Array) ? "[#{v.join(', ')}]" : v}" }.join("\n")
    content = "---\n#{yaml}\n---\n\n#{body}\n"

    dir = File.join(ROOT, rel_dir(stamp))
    FileUtils.mkdir_p(dir)
    path = File.join(dir, "#{slug}.md")
    File.write(path, content)
    { ok: true, slug: slug, path: path }
  rescue => e
    { ok: false, error: e.message }
  end

  def self.slugify(title)
    s = title.to_s.downcase.strip.gsub(/[^a-z0-9]+/, '-').gsub(/^-+|-+$/, '')[0, 40]
    s.nil? || s.empty? ? "post-#{Time.now.to_i}" : s
  end

  # ── 查询辅助 ──────────────────────────────────────────

  # [{ name:, count: }] 按数量降序
  def self.tag_counts
    counts = Hash.new(0)
    list.each { |p| p[:tags].each { |t| counts[t] += 1 } }
    counts.sort_by { |_, v| -v }.map { |name, count| { name: name, count: count } }
  end

  # 给单篇加 prev/next (按 updated_at desc 列表里的相邻项)
  # 出参走 Api.serialize, 保证时间字段是 ISO 字符串
  def self.with_prev_next(slug, post)
    ordered = list
    idx = ordered.index { |p| p[:slug] == slug }
    return Api.serialize(post) if idx.nil?
    prev_p = ordered[idx + 1]     # 更新更新的在前面, 所以"上一篇"是 idx+1
    next_p = idx > 0 ? ordered[idx - 1] : nil
    Api.serialize(post.merge(
      prev: prev_p ? { slug: prev_p[:slug], title: prev_p[:title] } : nil,
      next: next_p ? { slug: next_p[:slug], title: next_p[:title] } : nil,
    ))
  end

  # ── 解析 / 工具 ───────────────────────────────────────

  # → [meta_hash, body_string]
  def self.parse_frontmatter(raw)
    return [{}, raw] unless raw.start_with?("---\n")
    m = raw.match(/\A---\n(.*?)\n---\n?(.*)\z/m)
    return [{}, raw] unless m
    meta = {}
    m[1].each_line do |line|
      k, v = line.split(':', 2)
      next if k.nil? || v.nil?
      key = k.strip.to_sym
      val = v.strip
      meta[key] = if val.start_with?('[') && val.end_with?(']')
                    val[1..-2].split(',').map(&:strip).reject(&:empty?)
                  else
                    val
                  end
    end
    [meta, m[2].to_s]
  end

  def self.parse_iso(s)
    return nil if s.nil? || s.to_s.empty?
    Time.parse(s.to_s)
  rescue ArgumentError
    nil
  end

  # 粗略阅读时长: 中文按字, 英文按词, ~300 字/分钟
  def self.reading_minutes(text)
    cjk  = text.to_s.scan(/\p{Han}/).size
    words = text.to_s.scan(/[A-Za-z]+/).size
    [((cjk / 300.0) + (words / 220.0)).ceil, 1].max
  end

  # 列表摘要: 剥掉 markdown 符号后截断
  def self.excerpt(body, max = 200)
    s = body.to_s.gsub(/[#>*_`\-]/, '').gsub(/\s+/, ' ').strip
    return s if s.length <= max
    s[0, max].rstrip + '…'
  end

  # ── HTTP 边界: Api 层 ────────────────────────────────

  module Api
    module_function

    # 列表项/详情序列化: 去掉内部字段 _path, 时间转 ISO 字符串
    # body 为 nil (list 模式不带正文) 时整个字段不输出, 而不是输出 null
    def serialize(p)
      h = p.reject { |k, _| k == :_path }
      h[:created_at] = h[:created_at].iso8601
      h[:updated_at] = h[:updated_at].iso8601
      h.delete(:body) if h[:body].nil?
      h
    end

    # 请求体解析 (JSON), 空/坏体返回 nil
    def parse_body(req)
      raw = req.body.to_s
      if raw.empty?
        begin
          Timeout.timeout(0.05) { raw = STDIN.read_nonblock(65_536) }
        rescue StandardError
          raw = ''
        end
      end
      return {} if raw.nil? || raw.empty?
      # symbolize_names: true → 下游统一用 symbol key 取参
      JSON.parse(raw, symbolize_names: true)
    rescue JSON::ParserError
      nil
    end

    # 写操作参数: title/summary/tags/body (不含 slug —— 端点自己从 URL 或 body 取)
    def write_params(data)
      {
        title:   data[:title].to_s.strip,
        summary: data[:summary],
        body:    data[:body].to_s,
        tags:    Array(data[:tags]).map(&:to_s).reject(&:empty?),
      }
    end
  end
end