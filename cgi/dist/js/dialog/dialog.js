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
 *
 * 用法三（输入框）：
 *   const name = await Dialog.prompt('请输入名字');
 *   if (name === null) return;              // 用户取消了
 *   const pw = await Dialog.prompt('密码', { inputType: 'password' });
 *
 * 用法四（轻提示 —— 底部居中，默认 5 秒后自动消失）：
 *   Dialog.tips('已保存');
 *   Dialog.tips('出错了', { type: 'error' });
 *
 * 用法五（加载遮罩 —— 居中转圈，挡住下面的交互）：
 *   const l = Dialog.loading('加载中…');
 *   try { await doWork(); } finally { l.close(); }
 *
 * 用法六（进度框 —— 四种样式）：
 *   const p = Dialog.progress('上传中…', { type: 'bar' });
 *   p.set(45);                 // 45%
 *   p.set(45, '已传 4.5MB');    // 顺带换文案
 *   p.close();
 */
(function () {
  'use strict';

  var STYLE_ID = 'dlg-component-style';

  /* ★ 面板底色三件套 —— 弹窗 / 加载框 / 进度框共用一套，配色只改这里
   *   （含换行，保证拼出来的 CSS 跟以前逐字节一致） */
  var PANEL_BG = '  background:var(--bg-2,#1e2027);color:var(--ink,#e6e6e6);\n' +
                 '  border:1px solid var(--rule,#33363f);';
  /* 控件底色三件套 —— 输入框 / 提示 / 按钮共用一套 */
  var CTRL_BG = '  background:var(--bg-3,#262931);color:var(--ink,#e6e6e6);\n' +
                '  border:1px solid var(--rule,#33363f);';

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
    PANEL_BG,
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
    '/* 输入框（prompt 用） */',
    '.dlg-input{',
    '  width:100%;box-sizing:border-box;',
    CTRL_BG,
    '  padding:6px 8px;font:inherit;font-size:13px;',
    '  margin:0 0 14px;',
    '}',
    '/* 消息紧挨着输入框 —— 收紧消息的下边距 */',
    '.dlg-msg + .dlg-input{margin-top:-10px}',
    '.dlg-input:focus{outline:none;border-color:var(--lime,#c4f542)}',
    '/* 校验错误提示 */',
    '.dlg-err{',
    '  font-size:11px;color:var(--red,#ff4d4d);',
    '  margin:-8px 0 12px;',
    '}',
    '/* 轻提示（tips）—— 底部居中，自动消失 */',
    '.dlg-tips{',
    '  position:fixed;left:50%;bottom:28px;transform:translateX(-50%);',
    '  display:flex;flex-direction:column;align-items:center;gap:8px;',
    '  z-index:1200;pointer-events:none;',
    '}',
    '.dlg-tip{',
    '  pointer-events:auto;cursor:pointer;',
    CTRL_BG,
    '  padding:8px 16px;font-size:13px;',
    '  max-width:min(480px,80vw);',
    '  opacity:0;transform:translateY(12px);',
    '  transition:opacity .18s,transform .18s;',
    '}',
    '.dlg-tip.show{opacity:1;transform:translateY(0)}',
    '.dlg-tip.success{border-color:var(--lime,#c4f542)}',
    '.dlg-tip.error{border-color:var(--red,#ff4d4d)}',
    '/* 遮罩层（loading / progress 共用）*/',
    '.dlg-overlay-mask{',
    '  position:fixed;inset:0;z-index:1300;',
    '  display:flex;align-items:center;justify-content:center;',
    '  background:rgba(0,0,0,.55);',
    '}',
    '.dlg-loading{',
    '  display:flex;align-items:center;gap:10px;',
    PANEL_BG,
    '  padding:14px 18px;font-size:13px;',
    '}',
    '.dlg-spinner{',
    '  flex:none;width:14px;height:14px;border-radius:50%;',
    '  border:2px solid var(--rule,#33363f);border-top-color:var(--lime,#c4f542);',
    '  animation:dlg-spin .7s linear infinite;',
    '}',
    '@keyframes dlg-spin{to{transform:rotate(360deg)}}',
    '/* 减少动态效果时停掉转圈 */',
    '@media (prefers-reduced-motion:reduce){.dlg-spinner{animation:none}}',
    '/* 进度框（progress）*/',
    '.dlg-progress{',
    '  display:flex;flex-direction:column;gap:10px;',
    '  min-width:220px;max-width:min(420px,80vw);',
    PANEL_BG,
    '  padding:16px 18px;',
    '}',
    '.dlg-progress-msg{font-size:13px;line-height:1.5;color:var(--ink,#e6e6e6)}',
    '.dlg-progress-pct{font-size:11px;color:var(--muted,#8a8a94);text-align:right}',
    '/* 条形 —— 跟 share 工具的 .pbar 一个路子 */',
    '.dlg-progress-bar{height:6px;background:var(--bg-3,#262931);border:1px solid var(--rule,#33363f);overflow:hidden}',
    '.dlg-progress-bar-fill{height:100%;width:0;background:var(--lime,#c4f542);transition:width .15s linear}',
    '/* 环形 */',
    '.dlg-progress-circle{width:64px;height:64px;display:block;margin:0 auto}',
    '.dlg-progress-circle circle{fill:none;stroke-width:3}',
    '.dlg-progress-circle .track{stroke:var(--bg-3,#262931)}',
    '.dlg-progress-circle .fill{stroke:var(--lime,#c4f542);stroke-linecap:round;transition:stroke-dasharray .15s linear;transform:rotate(-90deg);transform-origin:50% 50%}',
    '.dlg-progress-circle text{fill:var(--ink,#e6e6e6);font-size:12px;text-anchor:middle;dominant-baseline:central}',
    '/* 三点（不确定进度）*/',
    '.dlg-progress-dots{display:flex;gap:5px;justify-content:center}',
    '.dlg-progress-dot{width:7px;height:7px;border-radius:50%;background:var(--lime,#c4f542);animation:dlg-bounce 1s ease-in-out infinite}',
    '@keyframes dlg-bounce{0%,80%,100%{transform:scale(.5);opacity:.45}40%{transform:scale(1);opacity:1}}',
    '/* 步骤段 */',
    '.dlg-progress-steps{display:flex;gap:4px}',
    '.dlg-progress-step{flex:1;height:4px;background:var(--bg-3,#262931);border:1px solid var(--rule,#33363f)}',
    '.dlg-progress-step.on{background:var(--lime,#c4f542);border-color:var(--lime,#c4f542)}',
    '@media (prefers-reduced-motion:reduce){.dlg-progress-dot{animation:none}}',
    '.dlg-actions{display:flex;justify-content:flex-end;gap:8px}',
    '.dlg-btn{',
    CTRL_BG,
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
    /* ★ 局部变量别叫 el —— 会遮蔽同名的 el() 辅助函数 */
    var styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  /* 打开中的弹窗栈 —— 只有最上面那个响应 Esc / 遮罩点击 */
  var stack = [];

  /**
   * 建元素。三个参数都可省。
   *
   * ★ 到处 `document.createElement` + `className` + `textContent` 三行写一遍
   *   太啰嗦 —— 统一走这里。
   *
   * @param {string} tag
   * @param {string} [cls]     className
   * @param {string} [text]    textContent（走 textContent —— 不当 HTML 解析）
   * @returns {HTMLElement}
   */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  /**
   * 造一个**幂等**的 close 函数 —— 摘掉节点，摘一次就作废。
   *
   * ★ tips / loading / progress 三处的「关掉」都归它管 ——
   *   否则同一个「幂等守卫 + 摘节点」要抄三遍。
   *
   * @param {HTMLElement} node      要摘掉的节点
   * @param {Object} [opts]
   * @param {number}  [opts.fade]   摘掉前等多久（毫秒）—— 淡出动画
   * @param {Function}[opts.before] 摘掉之前做的事（比如清计时器）
   * @returns {Function}
   */
  function closer(node, opts) {
    opts = opts || {};
    var closed = false;
    return function close() {
      if (closed) return;      /* ★ 幂等 —— 调多次只关一次 */
      closed = true;
      if (opts.before) opts.before();
      if (opts.fade) {
        /* ★ 淡出走完再摘 —— 直接摘会丢掉动画 */
        setTimeout(function () {
          if (node.parentNode) node.parentNode.removeChild(node);
        }, opts.fade);
      } else if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    };
  }

  /**
   * 合并快捷方法的选项 —— 复制一份（不污染调用方传进来的对象）+ 填 message。
   *
   * @param {string} message
   * @param {Object} [opts]
   * @returns {Object}
   */
  function optsWith(message, opts) {
    var o = Object.assign({}, opts || {});
    if (message !== undefined && message !== null) o.message = message;
    return o;
  }

  /**
   * 归一化输入框配置。
   *
   * opts.input 可以是：
   *   true                    → 普通文本框
   *   { type, value, placeholder, multiline }
   *
   * ★ type 是 input 的 type 属性（text / password / email …）
   *   multiline 走 textarea —— 多行时回车是换行，提交靠 Ctrl/Cmd+Enter。
   *
   * @param {*} cfg
   * @returns {Object|null} 不显示输入框返回 null
   */
  function normalizeInput(cfg) {
    if (!cfg) return null;
    if (cfg === true) cfg = {};
    if (typeof cfg !== 'object') return null;
    return {
      type: typeof cfg.type === 'string' && cfg.type ? cfg.type : 'text',
      value: cfg.value === undefined || cfg.value === null ? '' : String(cfg.value),
      placeholder: typeof cfg.placeholder === 'string' ? cfg.placeholder : '',
      multiline: !!cfg.multiline,
    };
  }

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
   * @param {boolean|Object} [opts.input] 输入框：true 或 {type,value,placeholder,multiline}
   *        有输入框时确定时 resolve 的是**输入框的值**（不是 okValue）
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

    /* 输入框配置 —— null 表示不显示输入框 */
    this.inputCfg = normalizeInput(opts.input);
    /* 输入框 DOM（_build 后才有） */
    this.input = null;

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

    var mask = el('div', this.maskClass);
    mask.hidden = true;

    var box = el('div', 'dlg');

    if (this.title) {
      /* textContent —— 不当 HTML 解析 */
      box.appendChild(el('div', 'dlg-title', this.title));
    }

    if (this.content) {
      var body = el('div', 'dlg-msg');
      if (typeof this.content === 'string') {
        body.innerHTML = this.content;   /* 故意用 innerHTML —— 调用方自己保证可信 */
      } else {
        body.appendChild(this.content);
      }
      box.appendChild(body);
    } else if (this.message) {
      box.appendChild(el('div', 'dlg-msg', this.message));
    }

    if (this.inputCfg) {
      var self = this;
      var inp = this.inputCfg.multiline
        ? el('textarea', 'dlg-input')
        : el('input', 'dlg-input');
      if (!this.inputCfg.multiline) inp.type = this.inputCfg.type;
      if (this.inputCfg.placeholder) inp.placeholder = this.inputCfg.placeholder;
      if (this.inputCfg.multiline) inp.rows = 3;
      inp.value = this.inputCfg.value;
      /* ★ 单行输入框里回车 = 提交（不走全局 keydown —— 全局那个会拦掉 textarea 的换行） */
      if (!this.inputCfg.multiline) {
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); self._doOk(); }
        });
      }
      box.appendChild(inp);
      this.input = inp;

      /* 错误提示容器（validate 失败时填内容） */
      var err = el('div', 'dlg-err');
      err.hidden = true;
      box.appendChild(err);
      this.errEl = err;
    }

    var actions = el('div', 'dlg-actions');

    if (!this.hideCancel) {
      this.cancelBtn = el('button', 'dlg-btn', this.cancelText);
      this.cancelBtn.type = 'button';
      this.cancelBtn.addEventListener('click', this._doCancel.bind(this));
      actions.appendChild(this.cancelBtn);
    }

    this.okBtn = el('button', 'dlg-btn ' + (this.danger ? 'danger' : 'primary'), this.okText);
    this.okBtn.type = 'button';
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

    /* ★ 有输入框时焦点落在输入框上（否则得先按 Tab 才能打字）。
       危险操作默认焦点在「取消」上 —— 回车不会误触发危险动作。 */
    var focusTarget = this.input ? this.input : (this.danger ? this.cancelBtn : this.okBtn);
    if (focusTarget) focusTarget.focus();
    /* 有预填值时全选 —— 直接打字就能覆盖掉 */
    if (this.input && this.inputCfg.value) {
      try { this.input.select(); } catch (e) { /* 某些浏览器不支持 —— 忽略 */ }
    }

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
    /* ★ 有输入框时 resolve **输入框的值**（不是 okValue）—— prompt 就靠这个 */
    this.close(this.input ? this.input.value : this.okValue);
  };

  Dialog.prototype._doCancel = function () {
    if (this.onCancel) this.onCancel(this);
    this.close(null);
  };

  /**
   * 显示校验错误（validate 钩子用）。传 null/空串清除。
   * @param {string|null} msg
   */
  Dialog.prototype.showError = function (msg) {
    if (!this.errEl) return;
    var text = msg ? String(msg) : '';
    this.errEl.textContent = text;
    this.errEl.hidden = !text;
    /* 报错后焦点回输入框 —— 方便直接改 */
    if (text && this.input) {
      try { this.input.focus(); } catch (e) { /* 忽略 */ }
    }
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
      var tag = e.target && e.target.tagName;
      /* 焦点在按钮上时让浏览器自己处理（否则会触发两次） */
      if (tag === 'BUTTON') return;
      /* 单行输入框自己绑了 keydown —— 这里必须放行，否则会提交两次 */
      if (tag === 'INPUT') return;
      /* 多行输入框：普通回车是换行，Ctrl/Cmd+Enter 才提交 */
      if (tag === 'TEXTAREA') {
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); this._doOk(); }
        return;
      }
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
    var dlg = new Dialog(optsWith(message, opts));
    return dlg.open().then(function (v) {
      return v !== null && v !== undefined && v !== false;
    });
  };

  /**
   * 输入框。返回 Promise<string|null> —— 确定时 resolve 输入的内容，取消时 resolve null。
   *
   * 用法：
   *   const name = await Dialog.prompt('请输入名字');
   *   if (name === null) return;          // 用户取消了
   *
   * @param {string} message
   * @param {Object} [opts] 同构造函数，另加：
   * @param {string}  [opts.value='']        输入框初始值（提交前就在里面）
   * @param {string}  [opts.placeholder='']  占位提示
   * @param {string}  [opts.inputType='text'] input 的 type（text / password / email …）
   * @param {boolean} [opts.multiline=false] 多行（textarea）—— Ctrl/Cmd+Enter 提交
   * @param {Function} [opts.validate] 校验函数 —— 返回字符串表示错误（不关闭），返回 undefined 表示通过
   * @returns {Promise<string|null>}
   */
  Dialog.prompt = function (message, opts) {
    opts = optsWith(message, opts);

    var input = {
      type: opts.inputType || 'text',
      value: opts.value === undefined || opts.value === null ? '' : String(opts.value),
      placeholder: opts.placeholder || '',
      multiline: !!opts.multiline,
    };
    opts.input = input;

    /* ★ validate 钩子：返回错误文案就不关闭 —— 用 onOk 钩子实现（它返回 false 可否决） */
    var validate = opts.validate;
    if (validate) {
      var userOnOk = opts.onOk;
      opts.onOk = function (dlg) {
        if (userOnOk && userOnOk(dlg) === false) return false;
        var err = validate(dlg.input ? dlg.input.value : '', dlg);
        if (err) {
          dlg.showError(err);
          return false;   /* 钩子返回 false → 不关闭 */
        }
        return true;
      };
    }

    return new Dialog(opts).open().then(function (v) {
      return v === null || v === undefined ? null : String(v);
    });
  };

  /* ── 轻提示（tips）──────────────────────────────────────────── */

  var TIPS_ID = 'dlg-tips-container';

  /* 轻提示的容器 —— 底部居中，多条竖着叠 */
  function tipsContainer() {
    var box = document.getElementById(TIPS_ID);
    if (box) return box;
    box = el('div', 'dlg-tips');
    box.id = TIPS_ID;
    (document.body || document.documentElement).appendChild(box);
    return box;
  }

  /**
   * 轻提示（toast）。底部居中弹一条，timeout 毫秒后自动消失。
   *
   * 用法：
   *   Dialog.tips('已保存');
   *   Dialog.tips('出错了', { type: 'error' });
   *   const t = Dialog.tips('加载中…', { timeout: 0 });   // 0 = 不自动消失
   *   t.close();                                          // 手动关掉
   *
   * ★ 多条提示会竖着叠起来（新的在下面），每条各自计时。
   * ★ 点提示本身也能提前关掉。
   *
   * @param {string} message
   * @param {Object} [opts]
   * @param {number}  [opts.timeout=5000] 自动消失的毫秒数；0 = 不自动消失
   * @param {string}  [opts.type='info']   info / success / error（决定边框色）
   * @returns {{ close: Function }} 手动关闭的句柄
   */
  Dialog.tips = function (message, opts) {
    opts = optsWith(null, opts);

    var timeout = opts.timeout === undefined ? 5000 : Number(opts.timeout);
    if (!isFinite(timeout) || timeout < 0) timeout = 0;

    /* type 白名单 —— 免得拼出乱七八糟的 class */
    var type = opts.type === 'success' || opts.type === 'error' ? opts.type : 'info';

    ensureStyle();

    var box = tipsContainer();
    var tip = el('div', 'dlg-tip' + (type === 'info' ? '' : ' ' + type),
                 message === undefined || message === null ? '' : String(message));
    box.appendChild(tip);

    var timer = 0;
    var close = closer(tip, {
      fade: 200,   /* ★ 淡出 180ms 后再摘掉 —— 直接摘会丢掉动画 */
      before: function () {
        if (timer) { clearTimeout(timer); timer = 0; }
        tip.classList.remove('show');
      },
    });

    /* 点提示本身 → 提前关掉 */
    tip.addEventListener('click', close);

    if (timeout > 0) timer = setTimeout(close, timeout);

    /* ★ 下一帧再加 .show —— 同一帧加不会触发 transition（元素还没布局） */
    var raf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : function (fn) { setTimeout(fn, 16); };
    raf(function () { tip.classList.add('show'); });

    return { close: close };
  };

  /* ── 浮层原语（loading / progress 共用）──────────────────────────── */

  /* 当前打开的浮层 —— 同时只允许一个 */
  var overlayEl = null;

  /**
   * 造一个居中浮层（遮罩 + 里面的框）。
   *
   * ★ loading / progress 共用 —— 它们只是「浮层里的内容不同」。
   *
   * @param {string} boxClass  浮层里那个框的 class
   * @param {boolean} maskOn   false = 不挡交互（透明底 + pointer-events:none）
   * @returns {{ mask: HTMLElement, box: HTMLElement, close: Function }}
   */
  function makeOverlay(boxClass, maskOn) {
    /* 已有浮层 → 先关掉（不叠加） */
    if (overlayEl) {
      var prev = overlayEl;
      overlayEl = null;
      if (prev.parentNode) prev.parentNode.removeChild(prev);
    }

    var mask = el('div', 'dlg-overlay-mask');
    var box = el('div', boxClass);
    mask.appendChild(box);

    if (maskOn === false) {
      mask.style.background = 'transparent';
      mask.style.pointerEvents = 'none';
    }

    (document.body || document.documentElement).appendChild(mask);
    overlayEl = mask;

    var close = closer(mask, {
      before: function () { if (overlayEl === mask) overlayEl = null; },
    });

    return { mask: mask, box: box, close: close };
  }

  /**
   * 加载遮罩。居中转圈 + 文字，盖住下面的交互。
   *
   * 用法：
   *   const l = Dialog.loading('加载中…');
   *   try {
   *     await doWork();
   *   } finally {
   *     l.close();
   *   }
   *
   * ★ 同一时刻只有一个遮罩 —— 再调一次会**换掉**上一个（不叠加）。
   * ★ close() 幂等 —— 调多次只关一次。
   *
   * @param {string} [message='加载中…']
   * @param {Object} [opts]
   * @param {boolean} [opts.mask=true]  是否盖住下面的交互（挡住点击）
   * @returns {{ close: Function }}  关闭句柄
   */
  Dialog.loading = function (message, opts) {
    opts = optsWith(null, opts);

    ensureStyle();

    var ov = makeOverlay('dlg-loading', opts.mask);

    ov.box.appendChild(el('span', 'dlg-spinner'));

    var text = message === undefined || message === null ? '加载中…' : String(message);
    if (text) ov.box.appendChild(el('span', null, text));

    return { close: ov.close };
  };

  /* ── 进度（progress）───────────────────────────────────────────── */

  /* 进度样式 —— 白名单，跟 type 一样只认这几个 */
  var PROGRESS_TYPES = ['bar', 'circle', 'dots', 'steps'];

  /**
   * 进度框。显示一个进度条/环/点/步骤，并返回句柄更新进度。
   *
   * 用法：
   *   const p = Dialog.progress('上传中…', { type: 'bar' });
   *   p.set(45);                 // 45%
   *   p.set(45, '已传 4.5MB');    // 带新文案
   *   p.close();
   *
   * ★ 四种样式：
   *   bar    —— 横向进度条（默认），跟 share 工具的 .pbar 一个路子
   *   circle —— 环形进度（SVG），中间显示百分比
   *   dots   —— 三点跳动（**不确定进度** —— 不知道总量时用这个）
   *   steps  —— 分段步骤条，段数由 opts.steps 定
   *
   * ★ 同一时刻只有一个遮罩 —— 再调一次会换掉上一个。
   *
   * @param {string} [message='处理中…']
   * @param {Object} [opts]
   * @param {string}  [opts.type='bar']    bar / circle / dots / steps
   * @param {number}  [opts.steps=5]       steps 样式的段数
   * @param {boolean} [opts.mask=true]      是否盖住下面的交互
   * @returns {{ set: Function, close: Function }}  句柄
   */
  Dialog.progress = function (message, opts) {
    opts = optsWith(null, opts);

    var type = PROGRESS_TYPES.indexOf(opts.type) >= 0 ? opts.type : 'bar';

    ensureStyle();

    var ov = makeOverlay('dlg-progress', opts.mask);
    var box = ov.box;

    /* 标题 */
    var msg = message === undefined || message === null ? '处理中…' : String(message);
    var msgEl = el('div', 'dlg-progress-msg', msg);
    box.appendChild(msgEl);

    var pctEl = null;      /* 百分比文字 */
    var fillEl = null;     /* 条形填充 */
    var circleEl = null;   /* 环形 */
    var stepsEl = [];      /* 步骤段 */

    if (type === 'bar') {
      var bar = el('div', 'dlg-progress-bar');
      fillEl = el('div', 'dlg-progress-bar-fill');
      bar.appendChild(fillEl);
      box.appendChild(bar);

      pctEl = el('div', 'dlg-progress-pct');
      box.appendChild(pctEl);

    } else if (type === 'circle') {
      /* SVG 环 —— 用 stroke-dasharray 画弧 */
      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'dlg-progress-circle');
      svg.setAttribute('viewBox', '0 0 36 36');

      var track = document.createElementNS(NS, 'circle');
      track.setAttribute('class', 'track');
      track.setAttribute('cx', '18'); track.setAttribute('cy', '18'); track.setAttribute('r', '15.5');
      svg.appendChild(track);

      circleEl = document.createElementNS(NS, 'circle');
      circleEl.setAttribute('class', 'fill');
      circleEl.setAttribute('cx', '18'); circleEl.setAttribute('cy', '18'); circleEl.setAttribute('r', '15.5');
      svg.appendChild(circleEl);

      pctEl = document.createElementNS(NS, 'text');
      pctEl.setAttribute('x', '18'); pctEl.setAttribute('y', '18');
      pctEl.textContent = '0%';
      svg.appendChild(pctEl);

      box.appendChild(svg);

    } else if (type === 'dots') {
      /* 三点 —— 不确定进度，没有百分比 */
      var dots = el('div', 'dlg-progress-dots');
      for (var i = 0; i < 3; i++) {
        var dot = el('span', 'dlg-progress-dot');
        dot.style.animationDelay = (i * 0.15) + 's';
        dots.appendChild(dot);
      }
      box.appendChild(dots);

    } else { /* steps */
      var n = Math.max(1, Math.min(20, opts.steps || 5));
      var steps = el('div', 'dlg-progress-steps');
      for (var k = 0; k < n; k++) {
        var seg = el('div', 'dlg-progress-step');
        steps.appendChild(seg);
        stepsEl.push(seg);
      }
      box.appendChild(steps);

      pctEl = el('div', 'dlg-progress-pct');
      box.appendChild(pctEl);
    }

    var CIRC = 2 * Math.PI * 15.5;   /* 环的周长（viewBox 半径 15.5） */

    /**
     * 设置进度。
     * @param {number} value 0~100
     * @param {string} [text] 顺带换掉标题
     */
    function set(value, text) {
      var v = Number(value);
      if (!isFinite(v)) return;
      if (v < 0) v = 0;
      if (v > 100) v = 100;

      if (text !== undefined && text !== null) msgEl.textContent = String(text);

      var shown = Math.round(v);

      if (type === 'bar') {
        fillEl.style.width = v + '%';
        pctEl.textContent = shown + '%';

      } else if (type === 'circle') {
        circleEl.setAttribute('stroke-dasharray', (v / 100 * CIRC) + ' ' + CIRC);
        pctEl.textContent = shown + '%';

      } else if (type === 'dots') {
        /* 不确定进度 —— 没有百分比可显示 */

      } else { /* steps */
        var done = Math.round(v / 100 * stepsEl.length);
        for (var s = 0; s < stepsEl.length; s++) {
          if (s < done) stepsEl[s].classList.add('on');
          else stepsEl[s].classList.remove('on');
        }
        pctEl.textContent = shown + '%';
      }
    }

    /* 初始进度 —— opts.value（没给就是 0） */
    set(opts.value === undefined ? 0 : opts.value);

    return { set: set, close: ov.close };
  };

  /**
   * 提示框（只有一个按钮）。返回 Promise<void>。
   * @param {string} message
   * @param {Object} [opts]
   */
  Dialog.alert = function (message, opts) {
    var o = optsWith(message, opts);
    o.hideCancel = true;
    return new Dialog(o).open().then(function () {});
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
