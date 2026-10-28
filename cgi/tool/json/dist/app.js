import { createJSONEditor } from './vanilla-jsoneditor-standalone.js';

    const $ = (id) => document.getElementById(id);
    const statBytes = $('stat-bytes');
    const statKeys = $('stat-keys');
    const statErr = $('stat-err');
    const dropzone = $('dropzone');
    const toast = $('toast');
    const urlInput = $('url-input');
    const btnFetch = $('btn-fetch');
    const btnRefresh = $('btn-refresh');
    let toastTimer = 0;

    const showToast = (msg) => {
      toast.textContent = msg;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
    };

    // 当前数据来源 —— refresh 靠它重新拉
    //   { kind: 'file', name, text, file }   本地文件
    //   { kind: 'url',  url, text }           远端 URL
    //   null                                  手输 / sample / clear —— 无来源, refresh 无效
    let source = null;

    // 无来源时 refresh 不可用（source 一变就同步）
    const syncRefreshBtn = () => { btnRefresh.disabled = !source; };

    const initial = {
      json: {
        greeting: 'Hello World',
        timestamp: Date.now(),
        features: ['格式化', '校验', '编辑']
      },
      text: undefined
    };

    const editor = createJSONEditor({
      target: $('editor'),
      props: {
        content: initial,
        mode: 'tree',
        onChange: (updatedContent, _previousContent, { contentErrors }) => {
          updateStatus(updatedContent, contentErrors);
        }
      }
    });

    const bytesOf = (s) => new TextEncoder().encode(s).length;
    const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
    const countKeys = (v) => {
      if (v === null || typeof v !== 'object') return 0;
      let n = 0;
      const walk = (x) => {
        if (x === null || typeof x !== 'object') return;
        if (Array.isArray(x)) { x.forEach(walk); return; }
        for (const k in x) { n++; walk(x[k]); }
      };
      walk(v);
      return n;
    };

    // 当前编辑内容序列化为字符串 (text 模式直接用, json 模式格式化)
    const currentText = () => {
      const cur = editor.get();
      if (cur.text !== undefined) return cur.text;
      if (cur.json !== undefined) return JSON.stringify(cur.json, null, 2);
      return '';
    };

    const updateStatus = (content, contentErrors) => {
      const cur = editor.get();
      if (cur.text !== undefined) {
        statBytes.textContent = fmtBytes(bytesOf(cur.text));
        statKeys.textContent = '0 keys';
      } else if (cur.json !== undefined) {
        statBytes.textContent = fmtBytes(bytesOf(JSON.stringify(cur.json)));
        statKeys.textContent = `${countKeys(cur.json)} keys`;
      }
      const errs = (contentErrors || []).filter(e => e.type === 'error').length;
      const warns = (contentErrors || []).filter(e => e.type === 'warn').length;
      if (errs > 0) {
        statErr.textContent = `${errs} error${errs > 1 ? 's' : ''}` + (warns ? ` / ${warns} warn` : '');
        statErr.className = 'err';
      } else if (warns > 0) {
        statErr.textContent = `${warns} warn${warns > 1 ? 's' : ''}`;
        statErr.className = 'warn';
      } else {
        statErr.textContent = 'ok';
        statErr.className = 'ok';
      }
    };

    // 把一段文本喂进编辑器 —— 能 parse 成 JSON 走 json 模式, 否则 text 模式
    // 返回是否成功解析成 JSON
    const loadText = (text) => {
      let obj = null;
      try { obj = JSON.parse(text); } catch (_) {}
      if (obj !== null) {
        editor.set({ json: obj, text: undefined });
        return true;
      }
      editor.set({ text, json: undefined });
      return false;
    };

    // open — 触发隐藏的 file input
    const fileInput = $('file-input');
    $('btn-open').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const isJson = loadText(text);
      source = { kind: 'file', name: file.name, text, file };
      showToast(isJson ? `opened: ${file.name}` : `text mode: ${file.name}`);
      // 允许重复选同一文件
      fileInput.value = '';
      syncRefreshBtn();
      updateStatus();
    });

    // ============================================================
    // open URL — 浏览器直连优先, 服务端代抓兜底
    //
    // 顺序很重要:
    //   1) 浏览器直连 fetch —— 快, 不占 spider 进程, 带 CORS 头的源直接能用
    //   2) 直连失败（CORS / 网络 / 非 2xx）→ 走 /tool/json/fetch 由 spider 代抓
    //
    // 直连失败的典型情况就是 CORS —— 目标站不带 Access-Control-Allow-Origin,
    // 浏览器直接拒绝, 这时服务端代抓能救回来。
    // ============================================================
    const FETCH_API = 'json/fetch';

    const setBusy = (btn, busy, label) => {
      btn.disabled = busy;
      if (busy) {
        btn.dataset.label = btn.textContent;
        btn.textContent = label;
      } else if (btn.dataset.label) {
        btn.textContent = btn.dataset.label;
      }
    };

    const shortUrl = (u) => {
      try {
        const p = new URL(u);
        return p.host + (p.pathname === '/' ? '' : p.pathname);
      } catch (_) { return u; }
    };

    // 浏览器直连 —— 返回 { text, url } 或抛错
    const fetchDirect = async (url) => {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return { text, url: res.url || url };
    };

    // 服务端代抓 —— 返回 { text, url } 或抛错
    const fetchViaServer = async (url) => {
      const res = await fetch(`${FETCH_API}?url=${encodeURIComponent(url)}`);
      let j = null;
      try { j = await res.json(); } catch (_) {}
      if (!j) throw new Error(`HTTP ${res.status} (bad response)`);
      if (!j.ok) throw new Error(j.error || `HTTP ${j.status || res.status}`);

      // 服务端能 parse 成 JSON 给 data, 否则给 text
      const text = j.data !== undefined && j.data !== null
        ? JSON.stringify(j.data, null, 2)
        : (j.text || '');
      return { text, url: j.url || url };
    };

    // 载入 URL —— 直连优先, 失败回退服务端; 返回实际用的路径
    const loadFromUrl = async (url) => {
      let got = null;
      let via = 'direct';
      try {
        got = await fetchDirect(url);
      } catch (e) {
        // 直连失败 → 服务端代抓
        via = 'proxy';
        try {
          got = await fetchViaServer(url);
        } catch (e2) {
          // 两条路都失败 —— 报服务端那条的错误（信息更有用）
          throw new Error(`${e2.message}`);
        }
      }

      const isJson = loadText(got.text);
      source = { kind: 'url', url: got.url, text: got.text, via };
      syncRefreshBtn();                       // 有来源了 → 启用 refresh
      showToast(`${isJson ? 'fetched' : 'text mode'}: ${shortUrl(got.url)}${via === 'proxy' ? ' (proxy)' : ''}`);
      updateStatus();
      return via;
    };

    const doFetch = async () => {
      const url = urlInput.value.trim();
      if (!url) { showToast('enter a url'); urlInput.focus(); return; }
      setBusy(btnFetch, true, 'fetching…');
      try {
        await loadFromUrl(url);
      } catch (e) {
        showToast(`fetch failed: ${e.message}`);
      } finally {
        setBusy(btnFetch, false);
      }
    };

    btnFetch.addEventListener('click', doFetch);
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doFetch(); }
    });

    // ============================================================
    // refresh — 重新拉数据来源, 重新渲染
    //
    // 来源是 URL → 重新抓（沿用上次的路径: 直连成功过的就直接直连，
    //             走过代理的就走代理 —— 避免每次都白等一次 CORS 失败）
    // 来源是文件 → 重读 File 句柄（浏览器不允许再按路径读, 但句柄还在）
    // 无来源      → 按钮禁用
    // ============================================================
    // 按 source.via 重新拉 —— direct 失败也回退 proxy（跟首次加载同策略）
    const reloadUrl = async (src) => {
      if (src.via === 'proxy') {
        const got = await fetchViaServer(src.url);
        return { ...got, via: 'proxy' };
      }
      try {
        const got = await fetchDirect(src.url);
        return { ...got, via: 'direct' };
      } catch (e) {
        // 上次直连成功过, 这次却失败了 → 也给代理一次机会
        const got = await fetchViaServer(src.url);
        return { ...got, via: 'proxy' };
      }
    };

    const doRefresh = async () => {
      if (!source) { showToast('no source'); return; }
      setBusy(btnRefresh, true, 'refreshing…');
      try {
        if (source.kind === 'url') {
          const got = await reloadUrl(source);
          loadText(got.text);
          source.text = got.text;
          source.url = got.url;
          source.via = got.via;
          showToast(`refreshed: ${shortUrl(got.url)}${got.via === 'proxy' ? ' (proxy)' : ''}`);
          updateStatus();
        } else if (source.kind === 'file') {
          // File 句柄可重复 read()
          const text = await source.file.text();
          loadText(text);
          source.text = text;
          showToast(`refreshed: ${source.name}`);
          updateStatus();
        }
      } catch (e) {
        showToast(`refresh failed: ${e.message}`);
      } finally {
        setBusy(btnRefresh, false);
      }
    };

    btnRefresh.addEventListener('click', doRefresh);

    $('btn-download').addEventListener('click', () => {
      const text = currentText();
      if (!text) { showToast('empty'); return; }
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `json-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // 释放 URL — 让浏览器能 GC blob
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('downloaded');
    });

    $('btn-copy').addEventListener('click', async () => {
      const text = currentText();
      if (!text) { showToast('empty'); return; }
      try {
        await navigator.clipboard.writeText(text);
        showToast('copied');
      } catch (e) {
        // fallback for non-secure contexts
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); showToast('copied'); }
        catch (_) { showToast('copy failed'); }
        document.body.removeChild(ta);
      }
    });

    $('btn-clear').addEventListener('click', () => {
      editor.set({ json: {}, text: undefined });
      source = null;                 // 清空后没有来源, refresh 无效
      syncRefreshBtn();
      showToast('cleared');
    });

    $('btn-sample').addEventListener('click', () => {
      editor.set({ ...initial });
      source = null;                 // sample 是内置数据, 不是外部来源
      syncRefreshBtn();
      showToast('sample loaded');
    });

    // 拖文件打开
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      dropzone.classList.add('show');
    });
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropzone.classList.remove('show');
    });
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropzone.classList.remove('show');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const text = await file.text();
      const isJson = loadText(text);
      source = { kind: 'file', name: file.name, text, file };
      syncRefreshBtn();
      showToast(isJson ? file.name : `text mode: ${file.name}`);
      updateStatus();
    });

    syncRefreshBtn();
    updateStatus();
