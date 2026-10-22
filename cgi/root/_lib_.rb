# frozen_string_literal: true
# root/_lib_.rb — 主站各子模块共享的 HTML 渲染工具
#
# 仅提供: 常量 + 纯函数. 不注册 Q.map (避免 require 时副作用)
#
# 目前只服务独立阅读页: /root/posts/read/<slug> 和 /root/notes/read/<slug> 共用
# posts/static/read.html 这一份模板, 这里做占位符替换。

READ_TPL   = File.expand_path('posts/static/read.html', __dir__)
READ_ASSET = { 'posts' => '/root/posts/assets/posts.js',
               'notes' => '/root/notes/assets/notes.js' }.freeze

def esc_html(s)
  String(s).gsub(/[&<>"']/) { |c| { '&'=>'&amp;','<'=>'&lt;','>'=>'&gt;','"'=>'&quot;',"'"=>'&#39;' }[c] }
end

# 摘要在 md 里很脆, 这里做点容错
def excerpt_from_body(body)
  String(body.to_s)[0, 160].gsub(/[#>*_`\-\n]/, ' ').squeeze(' ').strip
end

# 渲染独立阅读页。kind: 'posts' | 'notes'; title/excerpt 传入未转义的原文。
def render_read_page_html(kind:, slug:, title:, excerpt:)
  fields = {
    'TITLE'    => esc_html(title),
    'EXCERPT'  => esc_html(excerpt),
    'SLUG'     => esc_html(slug),
    'KIND'     => kind,
    'ASSET_JS' => READ_ASSET.fetch(kind),
  }
  File.read(READ_TPL, encoding: 'utf-8').gsub(/{{(\w+)}}/) { fields.fetch($1) }
end

# 404 页。kind: 'posts' | 'notes'
def render_404_html(kind, slug)
  esc = esc_html(slug)
  "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>404 · #{esc}</title>" \
    "<style>body{font-family:ui-monospace,monospace;padding:40px;background:#f4f1de;color:#0f0f12}</style>" \
    "</head><body><h1>404 · #{kind} not found</h1><p>slug: <code>#{esc}</code></p>" \
    "<p><a href=\"/root/#{kind}\">← /root/#{kind}</a></p></body></html>"
end