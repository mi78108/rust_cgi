# frozen_string_literal: true
# posts/_read_tpl.rb — 独立阅读页 (单链 URL) 共享 HTML 模板
#
# 两个 CGI 都 require_relative 同一份:
#   cgi/root/posts/read
#   cgi/root/notes/read
#
# 后端只 SSR <title>/<meta>/<header>; 正文/编辑/分页都走客户端 JS 接管。
# drawer 行为/样式行为, 跟 SPA drawer 保持一致: 因为都是 .dr-body 同一套 CSS。

def esc_html(s)
  String(s).gsub(/[&<>"']/) { |c| { '&'=>'&amp;','<'=>'&lt;','>'=>'&gt;','"'=>'&quot;',"'"=>'&#39;' }[c] }
end

def render_404_html(kind, slug)
  list_path = kind == 'post' ? '/root/posts' : '/root/notes'
  esc = esc_html(slug)
  "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>404 · #{esc}</title>" \
    "<style>body{font-family:ui-monospace,monospace;padding:40px;background:#f4f1de;color:#0f0f12}</style>" \
    "</head><body><h1>404 · #{esc_html(kind)} not found</h1><p>slug: <code>#{esc}</code></p>" \
    "<p><a href=\"#{list_path}\">← #{list_path}</a></p></body></html>"
end

# 参数:
#   kind: 'posts' | 'notes'
#   slug: 当前文章 slug
#   title: 文章标题
#   excerpt: 摘要 (用于 og:description / meta description)
def render_read_page_html(kind:, slug:, title:, excerpt:)
  is_post  = kind == 'posts'
  asset_js = is_post ? '/root/posts/assets/posts.js' : '/root/notes/assets/notes.js'
  list_href = "/root/#{kind}"
  title_label = is_post ? 'hawk / posts' : 'hawk / notes'
  og_type    = 'article'
  <<~HTML
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>#{title} · #{title_label}</title>
    <meta name="description" content="#{excerpt}">
    <meta property="og:title" content="#{title}">
    <meta property="og:type" content="#{og_type}">
    <meta property="og:description" content="#{excerpt}">
    <style>
      :root{
        --bg:#f4f1de; --bg-2:#ecead7; --ink:#0f0f12; --ink-2:#2a2a30;
        --muted:#5a5a64; --rule:#1a1a1f;
        --lime:#c4f542; --lime-ink:#0f0f12;
        --yellow:#ffd84a; --red:#ff4d4d;
      }
      *{box-sizing:border-box}
      html,body{margin:0;padding:0;min-height:100%}
      body{background:var(--bg);color:var(--ink);
        font-family:"Inter","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
        font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
      .wrap{max-width:780px;margin:0 auto;padding:48px 24px 80px}
      .state{padding:24px;text-align:center;font-family:"JetBrains Mono",monospace;font-size:13px;letter-spacing:.1em;color:var(--muted)}
      .state.err{color:var(--red)}

      h1{font-size:36px;font-weight:800;letter-spacing:-.02em;line-height:1.1;margin:6px 0 12px}
      .meta{display:flex;gap:14px;flex-wrap:wrap;align-items:center;
        font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.14em;
        color:var(--muted);text-transform:uppercase;padding-bottom:14px;border-bottom:1px solid var(--ink);margin-bottom:24px}
      .meta .badge{background:var(--lime);color:var(--ink);padding:2px 7px;letter-spacing:.16em}
      .body{font-size:17px;line-height:1.75;color:var(--ink-2)}
      .body p{margin:0 0 16px}
      .body h2{font-size:24px;font-weight:700;letter-spacing:-.01em;margin:28px 0 10px;color:var(--ink)}
      .body h3{font-size:19px;font-weight:700;margin:20px 0 8px;color:var(--ink)}
      .body ul,.body ol{margin:0 0 16px;padding-left:24px}
      .body li{margin:5px 0}
      .body code{font-family:"JetBrains Mono",monospace;font-size:13.5px;background:var(--bg-2);padding:1px 6px;border:1px solid var(--ink)}
      .body pre{background:var(--ink);color:var(--bg);padding:14px 16px;font-family:"JetBrains Mono",monospace;font-size:13px;line-height:1.55;overflow-x:auto;margin:0 0 20px}
      .body pre code{background:transparent;border:0;padding:0;color:var(--bg)}
      .body blockquote{border-left:4px solid var(--lime);padding:4px 14px;margin:0 0 16px;background:var(--bg-2);color:var(--ink)}
      .body table{border-collapse:collapse;margin:0 0 16px;width:100%;font-size:14px}
      .body th,.body td{border:1px solid var(--ink);padding:6px 10px;text-align:left}
      .body th{background:var(--bg-2);font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:.06em}
      .body a{color:var(--ink);text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px}
      .body strong{font-weight:700;color:var(--ink)}
      .body em{font-style:italic}
      .pnav{margin-top:32px;padding-top:18px;border-top:1px solid var(--ink);display:grid;grid-template-columns:1fr 1fr;gap:14px}
      .pnav .pn{border:1px solid var(--ink);padding:14px 16px;display:flex;flex-direction:column;gap:4px;text-decoration:none;color:var(--ink);background:var(--bg)}
      .pnav .pn:hover{background:var(--bg-2)}
      .pnav .pn.next{text-align:right}
      .pnav .pn .l{font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.18em;color:var(--muted);text-transform:uppercase}
      .pnav .pn .v{font-weight:600;font-size:14.5px;line-height:1.25}
      .pnav .pn.disabled{opacity:.35;pointer-events:none}

      /* 移动端 (<=640px) */
      @media (max-width: 640px){
        .wrap{padding:24px 16px 60px}
        h1{font-size:28px;margin:4px 0 10px}
        .meta{padding-bottom:10px;margin-bottom:18px;font-size:10.5px;gap:10px}
        .body{font-size:15px;line-height:1.7}
        .body h2{font-size:20px;margin:22px 0 8px}
        .body h3{font-size:16px;margin:16px 0 6px}
        .body pre{padding:12px 14px;font-size:12px}
        .pnav{margin-top:24px;padding-top:14px;grid-template-columns:1fr;gap:10px}
        .pnav .pn{padding:12px 14px}
      }
      /* 极窄屏 (<=480px) */
      @media (max-width: 480px){
        .wrap{padding:18px 12px 48px}
        h1{font-size:24px}
        .meta{font-size:10px;gap:8px;margin-bottom:14px}
        .body{font-size:14.5px;line-height:1.65}
        .body h2{font-size:17px;margin:18px 0 6px}
        .body h3{font-size:14px}
        .body pre{padding:10px 12px;font-size:11.5px}
        .body code{font-size:12px;padding:0 4px}
        .pnav .pn{padding:10px 12px}
        .pnav .pn .v{font-size:13px}
      }
    </style>
    </head>
    <body>
    <div class="wrap">
      <main id="app-root" data-article-slug="#{esc_html(slug)}">
        <div class="state">loading…</div>
      </main>
    </div>
    <script src="/root/posts/assets/markdown-it-14.1.0.min.js"></script>
    <script src="#{asset_js}"></script>
    </body>
    </html>
  HTML
end

# 摘要在 md 里很脆, 这里做点容错
def excerpt_from_body(body)
  String(body.to_s)[0, 160].gsub(/[#>*_`\-\n]/, ' ').squeeze(' ').strip
end