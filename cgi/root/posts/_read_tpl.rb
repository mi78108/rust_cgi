# frozen_string_literal: true
# posts/_read_tpl.rb — 独立阅读页 (单链 URL) 的模板渲染
#
# HTML 骨架在 posts/static/read.html (跟 index.html 同级, 由 /root/posts/assets 服务),
# 这里只做占位符替换。/root/posts/read 和 /root/notes/read 共用本文件。
#
# 后端只 SSR <title>/<meta>/<header>; 正文/编辑/分页都走客户端 JS 接管,
# 跟 SPA 抽屉共用 articleTpl()。

READ_TPL = File.expand_path('static/read.html', __dir__)

def esc_html(s)
  String(s).gsub(/[&<>"']/) { |c| { '&'=>'&amp;','<'=>'&lt;','>'=>'&gt;','"'=>'&quot;',"'"=>'&#39;' }[c] }
end

# 摘要在 md 里很脆, 这里做点容错
def excerpt_from_body(body)
  String(body.to_s)[0, 160].gsub(/[#>*_`\-\n]/, ' ').squeeze(' ').strip
end

# 渲染独立阅读页。kind: 'posts' | 'notes'
def render_read_page_html(kind:, slug:, title:, excerpt:)
  tpl = File.read(READ_TPL, encoding: 'utf-8')
  tpl
    .gsub('{{TITLE}}',   esc_html(title))
    .gsub('{{EXCERPT}}', esc_html(excerpt))
    .gsub('{{SLUG}}',    esc_html(slug))
    .gsub('{{KIND}}',   kind)
    .gsub('{{ASSET_JS}}', kind == 'posts' ? '/root/posts/assets/posts.js'
                                         : '/root/notes/assets/notes.js')
end

def render_404_html(kind, slug)
  list_path = kind == 'post' || kind == 'posts' ? '/root/posts' : '/root/notes'
  esc = esc_html(slug)
  "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>404 · #{esc}</title>" \
    "<style>body{font-family:ui-monospace,monospace;padding:40px;background:#f4f1de;color:#0f0f12}</style>" \
    "</head><body><h1>404 · #{esc_html(kind)} not found</h1><p>slug: <code>#{esc}</code></p>" \
    "<p><a href=\"#{list_path}\">← #{list_path}</a></p></body></html>"
end