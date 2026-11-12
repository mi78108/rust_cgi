/**
 * copy.js — 复制到剪贴板（utils 子模块）
 *
 * 零依赖，纯前端。给「快速使用」代码块加一个复制按钮。
 *
 * 用法：
 *   <script src="/pub/js/utils/copy/copy.js"></script>
 *   <div class="quick">
 *     <div class="quick-head">
 *       <span class="qt">快速使用</span>
 *       <span>引入即用</span>
 *       <button class="copy qs" data-copy>复制</button>
 *     </div>
 *     <pre><code>&lt;script src="..."&gt;&lt;/script&gt;</code></pre>
 *   </div>
 *
 * 脚本加载后会自动给页面上所有 `button[data-copy]` 绑上复制行为 ——
 * 复制的是同卡片 `.quick pre code` 的文本（渲染后的代码，不含 HTML 转义）。
 *
 * ★ 本文件只挂 `window.Utils.copy`，不自己建 `window.Utils` 容器 ——
 *   容器由 utils.js 建立。这样两个文件谁先加载都行。
 *
 * ★ 样式自己注入（跟 dialog.js / table.js 一样），页面不用额外写 CSS。
 */
(function () {
  'use strict';

  /* 容器 —— utils.js 可能还没加载，这里先兜住 */
  var U = window.Utils = window.Utils || {};

  var STYLE_ID = 'js-copy-style';

  var CSS = [
    '.quick{',
    '  margin:14px 0 4px;border:1px solid var(--rule);background:var(--bg);',
    '}',
    '.quick-head{',
    '  display:flex;align-items:center;gap:8px;',
    '  padding:5px 8px 5px 10px;border-bottom:1px solid var(--rule);',
    '  background:var(--bg-3);',
    '  font-size:12px;color:var(--muted);',
    '}',
    '.quick-head .qt{color:var(--ink);font-weight:600;font-size:11.5px;letter-spacing:.06em}',
    '.quick-head .qs{margin-left:auto}',
    '.quick pre{',
    '  margin:0;padding:9px 10px;overflow-x:auto;',
    '  background:var(--bg);border:0;',
    '  font-family:"JetBrains Mono",Menlo,ui-monospace,monospace;',
    '  font-size:12px;line-height:1.5;',
    '  color:var(--ink);',
    '}',
    '.quick pre code{background:none;padding:0;font-size:12px;color:inherit}',
    '.quick button.copy{',
    '  background:transparent;border:1px solid var(--rule);',
    '  padding:2px 9px;font-size:11.5px;color:var(--muted);cursor:pointer;',
    '}',
    '.quick button.copy:hover{border-color:var(--lime);color:var(--ink)}',
    '.quick button.copy.ok{border-color:var(--lime);color:var(--lime)}',
    '.quick button.copy.err{border-color:var(--red);color:var(--red)}',
  ].join('\n');

  var styleReady = false;

  function ensureStyle() {
    if (styleReady || typeof document === 'undefined') return;
    styleReady = true;
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  /**
   * 复制文本到剪贴板。
   *
   * ★ navigator.clipboard 需要**安全上下文**（https 或 localhost）。
   *   通过 IP 访问（比如 http://192.168.1.5:3000）时 clipboard API 不可用 ——
   *   这时要退回 execCommand('copy') 老办法。
   *   （跟 monaco 工具的 copyCurrent() 同一套逻辑。）
   *
   * ★ 两条路都失败时给**具体原因** —— 用户能自己判断是不是权限问题。
   *
   * ★ **永远返回 Promise** —— 安全上下文走 clipboard API（本来就是 Promise），
   *   非安全上下文走兜底（同步返回）。两条路必须统一成 Promise，
   *   否则调用方 `.then()` 会在兜底路径上炸掉。
   *
   * @param {string} text
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  function copyText(text) {
    var reasons = [];

    // ① 现代 API
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return { ok: true }; },
        function (e) {
          reasons.push('clipboard api: ' + (e && e.name ? e.name : String(e)));
          return legacyCopy(text, reasons);
        }
      );
    }
    reasons.push('clipboard api unavailable (需 https 或 localhost)');
    return Promise.resolve(legacyCopy(text, reasons));
  }

  /** 老办法兜底 —— 隐藏 textarea + execCommand('copy') */
  function legacyCopy(text, reasons) {
    var ok = false;
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
      if (!ok) reasons.push('execCommand: 未复制');
    } catch (e) {
      reasons.push('execCommand: ' + (e && e.name ? e.name : String(e)));
    }

    if (ok) return { ok: true };
    return { ok: false, reason: reasons.join('; ').slice(0, 90) };
  }

  /**
   * 把代码块的内容选中 —— 剪贴板不可用时用户按 Ctrl+C 就能复制。
   * 比只报「复制失败」有用得多。
   */
  function selectCode(code) {
    try {
      var range = document.createRange();
      range.selectNodeContents(code);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 给一个复制按钮绑行为 */
  function bindButton(btn) {
    if (btn.__copyBound) return;
    btn.__copyBound = true;

    btn.addEventListener('click', function () {
      var quick = btn.closest ? btn.closest('.quick') : null;
      if (!quick) return;
      var code = quick.querySelector('pre code');
      if (!code) return;

      var old = btn.textContent;

      copyText(code.textContent).then(function (r) {
        btn.classList.remove('ok', 'err');

        if (r.ok) {
          btn.textContent = '已复制';
          btn.classList.add('ok');
          return;
        }

        /* ★ 剪贴板不可用时（http + IP 访问最常见）把代码选中 ——
           用户按 Ctrl+C 就能复制 */
        selectCode(code);
        btn.textContent = '已选中，按 Ctrl+C';
        btn.classList.add('err');
        btn.title = r.reason;   /* ★ 具体原因 —— 悬停可见 */
        console.warn('[js] copy failed:', r.reason);
      });

      setTimeout(function () {
        btn.textContent = old;
        btn.classList.remove('ok', 'err');
      }, 2600);
    });
  }

  /** 给 root（默认整个文档）下所有复制按钮绑定 */
  function bind(root) {
    ensureStyle();
    var scope = root || document;
    var buttons = scope.querySelectorAll('button[data-copy]');
    for (var i = 0; i < buttons.length; i++) bindButton(buttons[i]);
    return buttons.length;
  }

  var copy = {
    bind: bind,
    copyText: copyText,
    selectCode: selectCode,
  };

  U.copy = copy;

  /* 暴露到全局 —— 跟 dialog.js / table.js / plugin.js 一致 */
  if (typeof window !== 'undefined') {
    window.Copy = copy;
  }
  /* CommonJS 环境也挂一下 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = copy;
  }

  /* 自动绑定 —— 脚本在 body 末尾就立即生效，在 head 里就等 DOM 就绪 */
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { bind(); });
    } else {
      bind();
    }
  }
})();
