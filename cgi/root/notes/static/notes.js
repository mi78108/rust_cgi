// notes.js — notes SPA 模块
// 自动接管 #app-root, 并自动 boot [data-mount="notes-mount"] strip
// 暴露 window.NotesApp 供手动调用
//
// 单篇展示: 列表页点击 → #dr 侧边抽屉; hash 直开(/root/notes#slug) / 独立页(/root/notes/read/<slug>) → appRoot 全屏

(function(){
  const PREFIX = '/root/notes';
  const API = {
    list: PREFIX + '/list/all',
    tags: PREFIX + '/tags/all',
    one:  PREFIX + '/get',
    read: PREFIX + '/read',
  };
  const appRoot = document.getElementById('app-root');
  // 单链独立页标记 (article 详情页): 列表渲染时挂 list 链接到 /root/notes/read/<slug>, 不再走 hash
  const isArticlePage = appRoot && appRoot.dataset.articleSlug;
  const ARTICLE_SLUG  = isArticlePage ? appRoot.dataset.articleSlug : null;

  /* drawer DOM (notes SPA 自己的) */
  const drEl    = document.getElementById('dr');
  const drMask  = document.getElementById('dr-mask');
  const drBody  = document.getElementById('dr-body');
  const drTitle = document.getElementById('dr-title');
  const drClose = document.getElementById('dr-close');
  const drFs    = document.getElementById('dr-fs');

  /* ---- utility ---- */
  const escHtml = s => String(s||'').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));

  const fmtDate = iso => {
    try{
      const d = new Date(iso);
      const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return M[d.getUTCMonth()] + ' ' + String(d.getUTCDate()).padStart(2,'0') + ', ' + d.getUTCFullYear();
    }catch(e){ return iso; }
  };

  /* ---- markdown (本地 markdown-it 实例, 跟 posts.js 同配置) ---- */
  const md = window.markdownit
    ? window.markdownit({
        html: false, linkify: true, breaks: false, typographer: true,
        highlight: (str, lang) =>
          `<pre class="hljs"><code class="language-${escHtml(lang || 'text')}">${md.utils.escapeHtml(str)}</code></pre>`,
      })
    : null;
  function renderMd(src){
    // 主页 drawer 里 posts.js 可能已加载, 优先复用它的实例
    if (window.PostsApp && typeof window.PostsApp.renderMd === 'function'){
      return window.PostsApp.renderMd(src);
    }
    if (!md) return escHtml(String(src||'')).replace(/\n/g, '<br>');
    return md.render(String(src||''));
  }
  /* ---- fetch ---- */
  let _listCache = null;
  function fetchList(){
    if (_listCache) return Promise.resolve(_listCache);
    return fetch(API.list, { headers: { 'Accept': 'application/json' } })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => { _listCache = (j.ok ? j.data.notes : []) || []; return _listCache; });
  }
  function fetchOne(slug){
    return fetch(API.one + '/' + encodeURIComponent(slug), { headers: { 'Accept': 'application/json' } })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => { if (!j.ok) throw new Error(j.error || 'failed'); return j.data; });
  }

  /* ---- drawer control ---- */
  function showDrawer(){
    if (!drEl) return;
    drEl.hidden = false;
    requestAnimationFrame(() => { drEl.classList.add('open'); drMask.classList.add('open'); });
  }
  function hideDrawer(){
    if (!drEl) return;
    drEl.classList.remove('open'); drMask.classList.remove('open');
    setTimeout(() => { drEl.hidden = true; }, 240);
  }
  function toggleFs(){
    if (!drEl) return;
    const isFs = drEl.classList.toggle('fullscreen');
    drFs.textContent = isFs ? '🗗' : '⛶';
    drFs.title = isFs ? '恢复 (F)' : '全屏 (F)';
    drBody.style.padding = isFs ? '28px 36px' : '';
  }

  /* ---- renderers ---- */
  function renderListInto(el, items){
    el.innerHTML = '<div class="item-list">' +
      items.map(n => `
        <div class="item" data-slug="${escHtml(n.slug)}">
          <div class="m">${escHtml(fmtDate(n.updated_at))} · ${n.reading_min} min</div>
          <div class="t">${escHtml(n.title)}</div>
          <div class="e">${escHtml(n.excerpt)}</div>
          <div class="tg">${(n.tags||[]).map(t => `<span>#${escHtml(t)}</span>`).join('')}</div>
        </div>
      `).join('') + '</div>';
    el.querySelectorAll('.item').forEach(it => {
      it.addEventListener('click', () => openArticle(it.dataset.slug));
    });
  }

  // 统一模板: meta/body/pnav (list 跟 draw 跟 page 共享; 单链/drawer 不需要 crumb/edit)
  function articleTpl(note, opts){
    return `
        <h1>${escHtml(note.title)}</h1>
        <div class="meta">
          <span class="badge">${escHtml(note.tags?.[0] || 'note')}</span>
          <span>${escHtml(fmtDate(note.created_at))}</span>
          <span>· ${note.reading_min} min read</span>
          <span>· /${escHtml(note.slug)}</span>
        </div>
        <div class="body">${renderMd(note.body)}</div>
        <nav class="pnav">
          <a class="pn ${note.prev ? '' : 'disabled'}" ${note.prev ? `data-slug="${escHtml(note.prev.slug)}"` : ''}>
            <span class="l">← Prev</span>
            <span class="v">${escHtml(note.prev ? note.prev.title : '—')}</span>
          </a>
          <a class="pn next ${note.next ? '' : 'disabled'}" ${note.next ? `data-slug="${escHtml(note.next.slug)}"` : ''}>
            <span class="l">Next →</span>
            <span class="v">${escHtml(note.next ? note.next.title : '—')}</span>
          </a>
        </nav>
      `;
  }

  function bindArticleEvents(scope, slug){
    scope.querySelectorAll('.pn:not(.disabled)').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        if (ARTICLE_SLUG) location.href = '/root/notes/read/' + encodeURIComponent(a.dataset.slug);
        else openArticle(a.dataset.slug);
      });
    });
    document.querySelectorAll('[data-slug]').forEach(i => i.classList.toggle('active', i.dataset.slug === slug));
  }

  // 列表页点开 → 右侧 drawer (快速预览)
  function openArticle(slug){
    if (location.hash !== '#' + slug) location.hash = slug;
    if (!drEl){ location.href = '/root/notes/read/' + encodeURIComponent(slug); return; }
    drTitle.textContent = 'Notes · ' + slug;
    drBody.innerHTML = '<div class="state">loading…</div>';
    showDrawer();
    fetchOne(slug).then(note => {
      drBody.innerHTML = articleTpl(note, { back: '← back to list', backHref: '#' });
      bindArticleEvents(drBody, slug);
    }).catch(err => {
      drBody.innerHTML = '<div class="state err">fetch failed: ' + escHtml(err.message) + '</div>';
    });
  }

  // hash 直开 / 独立页 → appRoot 全屏 (干净阅读视图)
  function renderArticlePage(slug){
    if (!appRoot) return;
    appRoot.innerHTML = '<div class="state">loading…</div>';
    fetchOne(slug).then(note => {
      appRoot.innerHTML = articleTpl(note, { back: '← /root/notes', backHref: '/root/notes' });
      bindArticleEvents(appRoot, slug);
    }).catch(err => {
      appRoot.innerHTML = '<div class="state err">fetch failed: ' + escHtml(err.message) + '</div>';
    });
  }

  function openList(){
    if (location.hash && location.hash !== '#list') location.hash = 'list';
    hideDrawer();
    fetchList().then(items => {
      if (appRoot) renderListInto(appRoot, items);
    }).catch(err => {
      if (appRoot) appRoot.innerHTML = '<div class="state err">fetch failed: ' + escHtml(err.message) + '</div>';
    });
  }

  /* ---- drawer wiring ---- */
  if (drClose) drClose.addEventListener('click', hideDrawer);
  if (drFs)    drFs.addEventListener('click', toggleFs);
  if (drMask)  drMask.addEventListener('click', hideDrawer);
  document.addEventListener('keydown', e => {
    if (!drEl || drEl.hidden) return;
    if (e.key === 'Escape'){ hideDrawer(); return; }
    if (e.key === 'f' || e.key === 'F'){ e.preventDefault(); toggleFs(); }
  });

  /* ---- hash routing: 进入 article 打开 drawer, 默认 list ---- */
  function routeFromHash(){
    if (ARTICLE_SLUG) return;
    const h = location.hash.replace(/^#/, '');
    if (!h || h === 'list') return openList();
    if (appRoot) renderArticlePage(h);
  }

  if (appRoot){
    window.addEventListener('hashchange', routeFromHash);
    if (ARTICLE_SLUG){
      renderArticlePage(ARTICLE_SLUG);
    } else {
      fetchList().then(items => {
        const h = location.hash.replace(/^#/, '');
        if (h && h !== 'list'){ renderListInto(appRoot, items); renderArticlePage(h); }
        else renderListInto(appRoot, items);
      }).catch(err => appRoot.innerHTML = '<div class="state err">fetch failed: ' + escHtml(err.message) + '</div>');
    }
  }

  /* ---- mount API (for page.html strip) ---- */
  function mountStrip(el){
    if (!el) return;
    el.innerHTML = '<div class="state">loading…</div>';
    fetchList().then(items => {
      el.innerHTML = '<div class="item-list">' +
        items.slice(0, 6).map(n => `
          <div class="item" data-slug="${escHtml(n.slug)}">
            <div class="m">${escHtml(fmtDate(n.updated_at))} · ${n.reading_min} min</div>
            <div class="t">${escHtml(n.title)}</div>
            <div class="e">${escHtml(n.excerpt)}</div>
            <div class="tg">${(n.tags||[]).map(t => `<span>#${escHtml(t)}</span>`).join('')}</div>
          </div>
        `).join('') + '</div>';
      el.querySelectorAll('.item').forEach(it => {
        // page.html 没有 drawer, 点击 → 跳 SPA + 打开 drawer (hash 自动生效)
        it.addEventListener('click', () => { location.href = '/root/notes#' + it.dataset.slug; });
      });
      el.setAttribute('data-notes-list', '');
    }).catch(err => {
      el.innerHTML = '<div class="state err">' + escHtml(err.message) + '</div>';
    });
  }

  const autoMount = document.querySelector('[data-mount="notes-mount"]');
  if (autoMount) mountStrip(autoMount);

  window.NotesApp = { mountStrip, openList, openArticle, renderArticlePage, articleTpl, bindArticleEvents, renderMd };
})();