import { createJSONEditor } from './vanilla-jsoneditor-standalone.js';

    const $ = (id) => document.getElementById(id);
    const statBytes = $('stat-bytes');
    const statKeys = $('stat-keys');
    const statErr = $('stat-err');
    const dropzone = $('dropzone');
    const toast = $('toast');
    let toastTimer = 0;

    const showToast = (msg) => {
      toast.textContent = msg;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
    };

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

    // open — 触发隐藏的 file input
    const fileInput = $('file-input');
    $('btn-open').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      // 尝试 parse 喂 json, 失败则落到 text 模式让用户手动修
      let obj = null;
      try { obj = JSON.parse(text); } catch (_) {}
      if (obj !== null) {
        editor.set({ json: obj, text: undefined });
        showToast(`opened: ${file.name}`);
      } else {
        editor.set({ text, json: undefined });
        showToast(`text mode: ${file.name}`);
      }
      // 允许重复选同一文件
      fileInput.value = '';
      updateStatus();
    });

    // download — 序列化当前内容 → blob → a[download] 触发
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
      showToast('cleared');
    });

    $('btn-sample').addEventListener('click', () => {
      editor.set({ ...initial });
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
      editor.set({ text, json: undefined });
      showToast(`${file.name}`);
    });

    updateStatus();
