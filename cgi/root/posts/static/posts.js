// posts.js — posts SPA 模块
// 自动接管 #app-root, 并自动 boot [data-mount="posts-mount"] strip
// 单篇展示: 列表页点击 → #dr 侧边抽屉; hash 直开(/root/posts#slug) / 独立页(/root/posts/read/<slug>) → appRoot 全屏

(function(){
  const PREFIX = '/root/posts';       // 拆分 endpoint 目录
  const API = {
    list:   PREFIX + '/list',
    tags:   PREFIX + '/tags',
    one:    PREFIX + '/get',
    read:   PREFIX + '/read',
    create: PREFIX + '/post/new',
    put:    PREFIX + '/put',
  };
  const appRoot = document.getElementById('app-root');
  // 单链独立页标记 (article 详情页): 列表渲染时挂 list 链接到 /root/posts/read/<slug>, 不再走 hash
  const isArticlePage = appRoot && appRoot.dataset.articleSlug;
  const ARTICLE_SLUG  = isArticlePage ? appRoot.dataset.articleSlug : null;

  const drEl    = document.getElementById('dr');
  const drMask  = document.getElementById('dr-mask');
  const drBody  = document.getElementById('dr-body');
  const drTitle = document.getElementById('dr-title');
  const drClose = document.getElementById('dr-close');
  const drFs    = document.getElementById('dr-fs');

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

  const md = window.markdownit
    ? window.markdownit({
        html: false, linkify: true, breaks: false, typographer: true,
        highlight: (str, lang) =>
          `<pre class="hljs"><code class="language-${escHtml(lang || 'text')}">${md.utils.escapeHtml(str)}</code></pre>`,
      })
    : null;
  function renderMd(src){
    if (!md) return escHtml(String(src||'')).replace(/\n/g, '<br>');
    // link 默认 external 加 rel
    return md.render(String(src||''));
  }
  let _listCache = null;
  function fetchList(){
    if (_listCache) return Promise.resolve(_listCache);
    return fetch(API.list, { headers: { 'Accept': 'application/json' } })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => { _listCache = (j.ok ? j.data.posts : []) || []; return _listCache; });
  }
  function fetchOne(slug){
    return fetch(API.one + '/' + encodeURIComponent(slug), { headers: { 'Accept': 'application/json' } })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => { if (!j.ok) throw new Error(j.error || 'failed'); return j.data; });
  }

  /* drawer */
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

  function renderListInto(el, items){
    el.innerHTML = '<div class="item-list">' +
      items.map(p => `
        <div class="item" data-slug="${escHtml(p.slug)}">
          <div class="m">${escHtml(fmtDate(p.updated_at))} · ${p.reading_min} min</div>
          <div class="t">${escHtml(p.title)}</div>
          <div class="e">${escHtml(p.summary || '')}</div>
          <div class="tg">${(p.tags||[]).map(t => `<span>#${escHtml(t)}</span>`).join('')}</div>
        </div>
      `).join('') + '</div>';
    el.querySelectorAll('.item').forEach(it => {
      it.addEventListener('click', () => openArticle(it.dataset.slug));
    });
  }

  // 统一模板: meta/body/pnav (主页 widget drawer / 单链页 无 crumb/edit; posts SPA drawer 有)
  function articleTpl(post, opts){
    const edit = opts && opts.edit;
    const back = edit ? '← back to list' : null;
    return `
        ${back ? `<div class="crumb"><a href="#" data-back>${back}</a><button id="edit-post-btn" class="edit-btn">edit</button></div>` : ''}
        <h1>${escHtml(post.title)}</h1>
        <div class="meta">
          <span class="badge">${escHtml(post.tags?.[0] || 'post')}</span>
          <span>${escHtml(fmtDate(post.created_at))}</span>
          <span>· ${post.reading_min} min read</span>
          <span>· /${escHtml(post.slug)}</span>
        </div>
        <div class="body">${renderMd(post.body)}</div>
        <nav class="pnav">
          <a class="pn ${post.prev ? '' : 'disabled'}" ${post.prev ? `data-slug="${escHtml(post.prev.slug)}"` : ''}>
            <span class="l">← Prev</span>
            <span class="v">${escHtml(post.prev ? post.prev.title : '—')}</span>
          </a>
          <a class="pn next ${post.next ? '' : 'disabled'}" ${post.next ? `data-slug="${escHtml(post.next.slug)}"` : ''}>
            <span class="l">Next →</span>
            <span class="v">${escHtml(post.next ? post.next.title : '—')}</span>
          </a>
        </nav>
      `;
  }

  function bindArticleEvents(scope, slug, opts){
    if (opts && opts.edit){
      // posts SPA drawer: edit + back 入口
      document.getElementById('edit-post-btn')?.addEventListener('click', () => openEditor(slug));
      scope.querySelector('[data-back]')?.addEventListener('click', e => { e.preventDefault(); openList(); });
    }
    scope.querySelectorAll('.pn:not(.disabled)').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        if (ARTICLE_SLUG) location.href = '/root/posts/read/' + encodeURIComponent(a.dataset.slug);
        else openArticle(a.dataset.slug);
      });
    });
    document.querySelectorAll('[data-slug]').forEach(i => i.classList.toggle('active', i.dataset.slug === slug));
  }

  // 列表页点开 → 右侧 drawer (快速预览)
  function openArticle(slug){
    if (location.hash !== '#' + slug) location.hash = slug;
    if (!drEl){ location.href = '/root/posts/read/' + encodeURIComponent(slug); return; }
    drTitle.textContent = 'Posts · ' + slug;
    drBody.innerHTML = '<div class="state">loading…</div>';
    showDrawer();
    fetchOne(slug).then(post => {
      drBody.innerHTML = articleTpl(post, { edit: true });
      bindArticleEvents(drBody, slug, { edit: true });
    }).catch(err => {
      drBody.innerHTML = '<div class="state err">fetch failed: ' + escHtml(err.message) + '</div>';
    });
  }

  // hash 直开 / 独立页 → appRoot 全屏 (干净阅读视图)
  function renderArticlePage(slug){
    if (!appRoot) return;
    appRoot.innerHTML = '<div class="state">loading…</div>';
    fetchOne(slug).then(post => {
      appRoot.innerHTML = articleTpl(post, { back: '← /root/posts', backHref: '/root/posts' });
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

  if (drClose) drClose.addEventListener('click', hideDrawer);
  if (drFs)    drFs.addEventListener('click', toggleFs);
  if (drMask)  drMask.addEventListener('click', hideDrawer);
  document.addEventListener('keydown', e => {
    if (!drEl || drEl.hidden) return;
    if (e.key === 'Escape'){ hideDrawer(); return; }
    if (e.key === 'f' || e.key === 'F'){ e.preventDefault(); toggleFs(); }
  });

  function routeFromHash(){
    const h = location.hash.replace(/^#/, '');
    if (!h || h === 'list') return openList();
    if (appRoot) openArticle(h);
  }

  function routeFromHash(){
    if (ARTICLE_SLUG) return;
    const h = location.hash.replace(/^#/, '');
    if (!h || h === 'list') return openList();
    if (appRoot) openArticle(h);
  }

  if (appRoot){
    window.addEventListener('hashchange', routeFromHash);
    if (ARTICLE_SLUG){
      // 单链独立页 (data-article-slug): 直开全屏, 不走 drawer
      renderArticlePage(ARTICLE_SLUG);
    } else {
      // 列表页: hash 直开 → 列表 + drawer 自动打开 (跟 SPA 列表内点开一致)
      fetchList().then(items => {
        renderListInto(appRoot, items);
        const h = location.hash.replace(/^#/, '');
        if (h && h !== 'list') openArticle(h);
      }).catch(err => appRoot.innerHTML = '<div class="state err">fetch failed: ' + escHtml(err.message) + '</div>');
    }
  }

  function mountStrip(el){
    if (!el) return;
    el.innerHTML = '<div class="state">loading…</div>';
    fetchList().then(items => {
      el.innerHTML = '<div class="item-list">' +
        items.slice(0, 6).map(p => `
          <div class="item" data-slug="${escHtml(p.slug)}">
            <div class="m">${escHtml(fmtDate(p.updated_at))} · ${p.reading_min} min</div>
            <div class="t">${escHtml(p.title)}</div>
            <div class="e">${escHtml(p.summary || '')}</div>
            <div class="tg">${(p.tags||[]).map(t => `<span>#${escHtml(t)}</span>`).join('')}</div>
          </div>
        `).join('') + '</div>';
      el.querySelectorAll('.item').forEach(it => {
        it.addEventListener('click', () => { location.href = '/root/posts#' + it.dataset.slug; });
      });
      el.setAttribute('data-posts-list', '');
    }).catch(err => {
      el.innerHTML = '<div class="state err">' + escHtml(err.message) + '</div>';
    });
  }

  const autoMount = document.querySelector('[data-mount="posts-mount"]');
  if (autoMount) mountStrip(autoMount);

  // ── editor (新建 / 编辑) ─────────────────────────────
  const NEW_BTN = document.getElementById('new-post-btn');
  if (NEW_BTN) NEW_BTN.addEventListener('click', () => openEditor());

  // dev 默认 token (跟后端 ENV['POSTS_WRITE_TOKEN'] 默认值一致)
  // 生产用: localStorage.setItem('hawk.posts.token', '<your-token>')
  const WRITE_TOKEN = (() => {
    try{ return localStorage.getItem('hawk.posts.token') || 'hawk-write-2026'; }catch(e){ return 'hawk-write-2026'; }
  })();

  function openEditor(slug){
    drTitle.textContent = slug ? 'edit · ' + slug : 'new post';
    drBody.className = 'dr-body';
    drBody.innerHTML = `
      <form class="editor" id="editor-form">
        <div><label>slug</label><input name="slug" value="${escHtml(slug || '')}" placeholder="auto from title" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="text" ${slug ? 'readonly' : ''}></div>
        <div><label>title</label><input name="title" required placeholder="post title" inputmode="text"></div>
        <div><label>tags (comma-separated)</label><input name="tags" placeholder="rust, ruby" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="text"></div>
        <div class="row split">
          <div class="half">
            <label>body (markdown) —
              <span class="editor-toggle" id="editor-toggle">
                <button type="button" data-mode="textarea" class="active">textarea</button>
                <button type="button" data-mode="monaco">monaco</button>
              </span>
            </label>
            <textarea name="body" id="editor-body" required placeholder="# hello&#10;&#10;write something..."></textarea>
            <div id="editor-monaco" class="editor-monaco" hidden></div>
          </div>
          <div class="half"><label>preview</label><div id="editor-preview" class="preview"></div></div>
        </div>
        <div class="actions">
          <button type="button" id="editor-cancel">cancel</button>
          <button type="submit" class="save">save</button>
        </div>
        <div class="err" id="editor-err"></div>
      </form>
    `;
    showDrawer();
    const form    = document.getElementById('editor-form');
    const errEl   = document.getElementById('editor-err');
    const cancelB = document.getElementById('editor-cancel');
    const preview = document.getElementById('editor-preview');
    cancelB.addEventListener('click', hideDrawer);
    // editor mode toggle (textarea / monaco) — declare FIRST so updatePreview can read mode
    let mode = 'textarea';
    let monacoEditor = null;
    const bodyEl  = document.getElementById('editor-body');
    const monacoEl = document.getElementById('editor-monaco');
    const toggleBtns = document.querySelectorAll('#editor-toggle button');

    // live preview (markdown-it) — CSS field-sizing:content handles auto-grow (modern browsers);
    // JS autoGrow is a fallback for browsers that lack the property.
    const updatePreview = () => {
      const val = (mode === 'monaco' && monacoEditor) ? monacoEditor.getValue() : bodyEl.value;
      preview.innerHTML = renderMd(val);
    };
    bodyEl.addEventListener('input', () => updatePreview());
    updatePreview();
    toggleBtns.forEach(b => b.addEventListener('click', () => switchMode(b.dataset.mode)));

    function switchMode(target){
      if (target === mode) return;
      toggleBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === target));
      if (target === 'monaco'){
        // sync textarea → monaco
        const cur = bodyEl.value;
        monacoEl.hidden = false;
        bodyEl.hidden = true;
        if (!monacoEditor && window.require){
          window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' }});
          window.require(['vs/editor/editor.main'], () => {
            monacoEditor = window.monaco.editor.create(monacoEl, {
              value: cur,
              language: 'markdown',
              theme: 'vs',
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 13.5,
              wordWrap: 'on',
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
            });
            monacoEditor.onDidChangeModelContent(updatePreview);
            updatePreview();
          });
        }
      } else {
        // monaco → textarea
        if (monacoEditor) bodyEl.value = monacoEditor.getValue();
        monacoEl.hidden = true;
        bodyEl.hidden = false;
        monacoEditor && monacoEditor.dispose();
        monacoEditor = null;
      }
      mode = target;
      updatePreview();
    }

    // save: 从 monaco(如果激活)取最新 body
    function getBodyValue(){ return (mode === 'monaco' && monacoEditor) ? monacoEditor.getValue() : bodyEl.value; }
    // edit mode: 拉现有数据预填
    if (slug){
      fetchOne(slug).then(p => {
        if (!p) return;
        form.title.value    = p.title || '';
        form.tags.value     = (p.tags || []).join(', ');
        bodyEl.value        = p.body || '';
        if (mode === 'monaco' && monacoEditor) monacoEditor.setValue(p.body || '');
        updatePreview();
      }).catch(err => { errEl.textContent = 'fetch failed: ' + err.message; });
    }
    form.addEventListener('submit', e => {
      e.preventDefault();
      errEl.textContent = '';
      const data = {
        slug:     form.slug.value.trim(),
        title:    form.title.value.trim(),
        tags:    form.tags.value.split(',').map(s => s.trim()).filter(Boolean),
        body:    getBodyValue(),
      };
      const url    = slug ? API.put + '/' + encodeURIComponent(slug) : API.create;
      const method = slug ? 'PUT' : 'POST';
      if (!data.title){ errEl.textContent = 'title required'; return; }
      fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + WRITE_TOKEN },
        body: JSON.stringify(data),
      })
        .then(async r => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok || (j && j.ok === false)){ errEl.textContent = (j && j.error) || ('HTTP ' + r.status); return; }
          const saved = (j && j.data) || j;
          _listCache = null;
          hideDrawer();
          openList();
          location.hash = '#' + (saved.slug || data.slug);
        })
        .catch(err => { errEl.textContent = 'save failed: ' + err.message; });
    });
  }

  // 暴露给 fetchOne 调用方
  window.PostsApp = { mountStrip, openList, openArticle, renderArticlePage, articleTpl, bindArticleEvents, openEditor, renderMd };
})();