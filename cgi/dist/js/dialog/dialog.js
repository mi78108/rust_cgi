/**
 * dialog.js — 通用弹窗组件
 *
 * 零依赖，纯前端。整个组件自己注入样式（<style> 标签），不依赖宿主页面的 CSS。
 * 颜色用 CSS 变量：宿主页面定义了 :root 变量就跟随宿主主题，没定义就用回退值。
 *
 * 用法一（普通 script 标签 —— 跟 plugin/plugin.js 一致，全局命名空间）：
 *   <script src="/pub/js/dialog/dialog.js"></script>
 *   <script>
 *     if (await Dialog.confirm('清空文档？', { danger: true })) { ... }
 *   </script>
 *
 * 用法二（ES module）：
 *   import { Dialog, confirm, alert } from '/pub/js/dialog/dialog.js';
 *
 * ★ 危险操作（danger: true）的默认焦点在「取消」上 —— 回车不会误触发。
 * ★ Esc / 点遮罩空白处 = 取消；回车 = 确定（焦点在按钮上时除外，避免触发两次）。
 */
(function () {
  'use strict';

  var STYLE_ID = 'dlg-component-style';

  var CSS = [
    '.dlg-mask{',
    '  position:fixed;inset:0;z-index:1000;',
    '  background:rgba(0,0,0,.55);',
    '  display:flex;align-items:center;justify-content:center;',
    '  padding:16px;',
    '}',
    '/* [hidden] 要能压过上面的 display:flex */',
    '.dlg-mask[hidden]{display:none}',
    '.dlg{',
    '  width:320px;max-width:100%;',
    '  background:var(--bg-2,#1e2027);color:var(--ink,#e6e6e6);',
    '  border:1px solid var(--rule,#33363f);',
    '  box-shadow:0 12px 40px rgba(0,0,0,.6);',
    '  padding:18px 18px 14px;',
    '}',
    '.dlg-title{',
    '  font-size:13px;font-weight:600;letter-spacing:.04em;',
    '  color:var(--ink,#e6e6e6);margin-bottom:14px;',
    '}',
    '/* 窄版 —— 纯确认类弹窗（没有输入框） */',
    '.dlg-narrow{width:280px}',
    '.dlg-msg{',
    '  font-size:12px;line-height:1.6;color:var(--muted,#8a8a94);',
    '  margin:-4px 0 16px;',
    '}',
    '.dlg-actions{display:flex;justify-content:flex-end;gap:8px}',
    '.dlg-btn{',
    '  background:var(--bg-3,#262931);color:var(--ink,#e6e6e6);',
    '  border:1px solid var(--rule,#33363f);',
    '  padding:5px 14px;font:inherit;font-size:13px;cursor:pointer;',
    '}',
    '.dlg-btn:hover{border-color:var(--muted,#8a8a94)}',
    '.dlg-btn.primary{background:var(--lime,#c4f542);color:#0f0f12;border-color:var(--lime,#c4f542)}',
    '.dlg-btn.primary:hover{filter:brightness(1.08)}',
    '/* 危险操作 —— 红色 */',
    '.dlg-btn.danger{background:var(--red,#ff4d4d);color:#fff;border-color:var(--red,#ff4d4d)}',
    '.dlg-btn.danger:hover{filter:brightness(1.12)}',
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

  /* 打开中的弹窗栈 —— 只有最上面那个响应 Esc / 遮罩点击 */
  var stack = [];

  var FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function focusableIn(root) {
    var all = root.querySelectorAll(FOCUSABLE);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      /* offsetParent 为 null = 隐藏（display:none） */
      if (all[i].offsetParent !== null) out.push(all[i]);
    }
    return out;
  }

  /**
   * @param {Object} [opts]
   * @param {string}  [opts.title]      标题
   * @param {string}  [opts.message]    正文（纯文本，走 textContent）
   * @param {Node|string} [opts.content] 自定义正文（HTML 字符串会被当成 HTML —— 只放可信内容）
   * @param {string}  [opts.okText='确定']
   * @param {string}  [opts.cancelText='取消']
   * @param {boolean} [opts.danger=false]    危险操作：主按钮变红，默认焦点在「取消」
   * @param {boolean} [opts.hideCancel=false] 隐藏取消按钮（只有一个按钮时用）
   * @param {*}      [opts.okValue='ok']     确定时 resolve 的值
   * @param {string}  [opts.maskClass='dlg-mask']
   * @param {Function} [opts.onOk]     确定前的钩子 —— 返回 false 则不关闭
   * @param {Function} [opts.onCancel] 取消时的钩子
   */
  function Dialog(opts) {
    opts = opts || {};

    this.title = opts.title || '';
    this.message = opts.message || '';
    this.content = opts.content || null;
    this.okText = opts.okText === undefined ? '确定' : opts.okText;
    this.cancelText = opts.cancelText === undefined ? '取消' : opts.cancelText;
    this.danger = !!opts.danger;
    this.hideCancel = !!opts.hideCancel;
    this.okValue = opts.okValue === undefined ? 'ok' : opts.okValue;
    this.maskClass = opts.maskClass || 'dlg-mask';
    this.onOk = opts.onOk || null;
    this.onCancel = opts.onCancel || null;

    this._resolve = null;
    this._promise = null;
    this._prevFocus = null;
    this._built = false;

    /* 绑定成实例属性 —— 关闭时要用**同一个引用** removeEventListener。
       ★ 这两行必须有：open() 里 addEventListener(this._onKeyDown) 用的是它们，
         漏掉的话 addEventListener 收到 undefined，会静默注册一个空监听器 ——
         Esc 和点遮罩就都不响应了（按钮点击走 .bind(this) 另算，所以只有键盘失效）。 */
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onMaskClick = this._handleMaskClick.bind(this);
  }

  Dialog.prototype._build = function () {
    if (this._built) return;
    ensureStyle();

    var mask = document.createElement('div');
    mask.className = this.maskClass;
    mask.hidden = true;

    var box = document.createElement('div');
    box.className = 'dlg';

    if (this.title) {
      var title = document.createElement('div');
      title.className = 'dlg-title';
      title.textContent = this.title;   /* textContent —— 不当 HTML 解析 */
      box.appendChild(title);
    }

    if (this.content) {
      var body = document.createElement('div');
      body.className = 'dlg-msg';
      if (typeof this.content === 'string') {
        body.innerHTML = this.content;   /* 故意用 innerHTML —— 调用方自己保证可信 */
      } else {
        body.appendChild(this.content);
      }
      box.appendChild(body);
    } else if (this.message) {
      var msg = document.createElement('div');
      msg.className = 'dlg-msg';
      msg.textContent = this.message;
      box.appendChild(msg);
    }

    var actions = document.createElement('div');
    actions.className = 'dlg-actions';

    if (!this.hideCancel) {
      this.cancelBtn = document.createElement('button');
      this.cancelBtn.className = 'dlg-btn';
      this.cancelBtn.type = 'button';
      this.cancelBtn.textContent = this.cancelText;
      this.cancelBtn.addEventListener('click', this._doCancel.bind(this));
      actions.appendChild(this.cancelBtn);
    }

    this.okBtn = document.createElement('button');
    this.okBtn.className = 'dlg-btn ' + (this.danger ? 'danger' : 'primary');
    this.okBtn.type = 'button';
    this.okBtn.textContent = this.okText;
    this.okBtn.addEventListener('click', this._doOk.bind(this));
    actions.appendChild(this.okBtn);

    box.appendChild(actions);
    mask.appendChild(box);

    this.mask = mask;
    this.box = box;
    this._built = true;
  };

  /**
   * 打开弹窗。返回 Promise —— 确定时 resolve(okValue)，取消时 resolve(null)。
   */
  Dialog.prototype.open = function () {
    if (this._promise) return this._promise;

    var self = this;
    this._promise = new Promise(function (resolve) {
      self._resolve = resolve;
    });

    this._build();
    this._prevFocus = document.activeElement;

    this.mask.hidden = false;
    document.body.appendChild(this.mask);
    stack.push(this);

    document.addEventListener('keydown', this._onKeyDown, true);
    this.mask.addEventListener('click', this._onMaskClick);

    /* ★ 危险操作默认焦点在「取消」上 —— 回车不会误触发危险动作 */
    var focusTarget = this.danger ? this.cancelBtn : this.okBtn;
    if (focusTarget) focusTarget.focus();

    return this._promise;
  };

  /** 关闭弹窗。value 会 resolve 给 open() 返回的 Promise。 */
  Dialog.prototype.close = function (value) {
    if (!this._promise) return;

    var idx = stack.indexOf(this);
    if (idx >= 0) stack.splice(idx, 1);

    document.removeEventListener('keydown', this._onKeyDown, true);
    this.mask.removeEventListener('click', this._onMaskClick);

    if (this.mask.parentNode) this.mask.parentNode.removeChild(this.mask);

    /* 焦点还给打开之前的位置 */
    if (this._prevFocus && document.contains(this._prevFocus)) {
      try {
        this._prevFocus.focus();
      } catch (e) {
        /* 元素已经不可聚焦 —— 忽略 */
      }
    }
    this._prevFocus = null;

    var resolve = this._resolve;
    this._resolve = null;
    this._promise = null;

    if (resolve) resolve(value === undefined ? null : value);
  };

  Dialog.prototype._doOk = function () {
    if (this.onOk && this.onOk(this) === false) return;   /* 钩子可以否决 */
    this.close(this.okValue);
  };

  Dialog.prototype._doCancel = function () {
    if (this.onCancel) this.onCancel(this);
    this.close(null);
  };

  Dialog.prototype._isTop = function () {
    return stack.length > 0 && stack[stack.length - 1] === this;
  };

  Dialog.prototype._handleKeyDown = function (e) {
    if (!this._isTop()) return;   /* 叠层时只有最上面那个响应 */

    if (e.key === 'Escape') {
      e.preventDefault();
      this._doCancel();
      return;
    }

    if (e.key === 'Enter') {
      /* 焦点在按钮上时让浏览器自己处理（否则会触发两次）；
         文本域里的回车是换行，不提交 */
      var tag = e.target && e.target.tagName;
      if (tag === 'BUTTON' || tag === 'TEXTAREA') return;
      e.preventDefault();
      this._doOk();
      return;
    }

    if (e.key === 'Tab') this._trapFocus(e);
  };

  /** 焦点锁在弹窗内 —— Tab 到底回到开头，Shift+Tab 反向 */
  Dialog.prototype._trapFocus = function (e) {
    var items = focusableIn(this.box);
    if (!items.length) return;

    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;

    if (!this.box.contains(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  Dialog.prototype._handleMaskClick = function (e) {
    /* 点到遮罩本身才关 —— 点弹窗内容不关 */
    if (e.target === this.mask) this._doCancel();
  };

  /* ── 快捷方法 ───────────────────────────────────────────── */

  /**
   * 确认框。返回 Promise<boolean>。
   * @param {string} message
   * @param {Object} [opts] 同构造函数
   */
  Dialog.confirm = function (message, opts) {
    opts = Object.assign({}, opts || {});
    if (message !== undefined && message !== null) opts.message = message;
    var dlg = new Dialog(opts);
    return dlg.open().then(function (v) {
      return v !== null && v !== undefined && v !== false;
    });
  };

  /**
   * 提示框（只有一个按钮）。返回 Promise<void>。
   * @param {string} message
   * @param {Object} [opts]
   */
  Dialog.alert = function (message, opts) {
    opts = Object.assign({}, opts || {});
    if (message !== undefined && message !== null) opts.message = message;
    opts.hideCancel = true;
    var dlg = new Dialog(opts);
    return dlg.open().then(function () {});
  };

  /* 暴露到全局 —— 跟 plugin/plugin.js 的风格一致 */
  if (typeof window !== 'undefined') {
    window.Dialog = Dialog;
  }
  /* CommonJS 环境也挂一下 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Dialog;
  }
})();
