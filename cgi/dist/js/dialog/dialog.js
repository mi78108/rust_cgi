/**
 * dialog.js — 通用弹窗组件
 *
 * 零依赖，纯前端。整个组件自己注入样式（<style> 标签），不依赖宿主页面的 CSS。
 * 颜色用 CSS 变量：宿主页面定义了 :root 变量就跟随宿主主题，没定义就用回退值。
 *
 * ★ 架构：**基于原生 <dialog> 元素**。
 *   模态机制（Esc 关闭 / 焦点陷阱 / 焦点归还 / 背景 inert / top layer）
 *   全部由浏览器提供 —— 不用自己实现那 180 行。
 *
 * ★ 核心就一个 API —— Dialog.create()：
 *   造一个 <dialog>，塞进内容，返回 Promise<返回值>。
 *   所有弹层形态都是它的一层薄封装。
 *
 * 用法一（普通 script 标签 —— 跟 plugin/plugin.js 一致，全局命名空间）：
 *   <script src="/pub/js/dialog/dialog.js"></script>
 *   <script>
 *     if (await Dialog.confirm('清空文档？', { danger: true })) { ... }
 *   </script>
 *
 * ★ 危险操作（danger: true）的默认焦点在「取消」上 —— 回车不会误触发。
 * ★ Esc / 点遮罩空白处 = 取消；回车 = 确定（焦点在按钮上时除外，避免触发两次）。
 *
 * 用法二（输入框）：
 *   const name = await Dialog.prompt('请输入名字');
 *   if (name === null) return;              // 用户取消了
 *   const pw = await Dialog.prompt('密码', { inputType: 'password' });
 *
 * 用法三（轻提示 —— 底部居中，默认 5 秒后自动消失）：
 *   Dialog.tips('已保存');
 *   Dialog.tips('出错了', { type: 'error' });
 *
 * 用法四（加载遮罩 —— 居中转圈，挡住下面的交互）：
 *   const l = Dialog.loading('加载中…');
 *   try { await doWork(); } finally { l.close(); }
 *
 * 用法五（进度框 —— 四种样式）：
 *   const p = Dialog.progress('上传中…', { type: 'bar' });
 *   p.set(45);                 // 45%
 *   p.set(45, '已传 4.5MB');    // 顺带换文案
 *   p.close();
 */
(function () {
  'use strict';

  var STYLE_ID = 'dlg-component-style';

  var PANEL_BG = '  background:var(--bg-2,#1e2027);color:var(--ink,#e6e6e6);\n'
    + '  border:1px solid var(--rule,#33363f);\n';

  var CTRL_BG = '  background:var(--bg-3,#262931);color:var(--ink,#e6e6e6);\n'
    + '  border:1px solid var(--rule,#33363f);\n';

  var CSS = [
    /* ── 模态对话框 ── */
    /* ★ 用原生 <dialog> —— 遮罩由 ::backdrop 提供（不用自己造 .dlg-mask 那层 div） */
    'dialog.dlg{',
    '  width:320px;max-width:calc(100vw - 32px);',
    PANEL_BG,
    '  box-shadow:0 12px 40px rgba(0,0,0,.6);',
    '  padding:18px 18px 14px;',
    '  border-radius:0;',
    /* ★ 覆盖 <dialog> 的 UA 默认样式 ——
       UA 给的 max-height 会截断内容 —— 放开，改用自身滚动。
       （背景/边框/文字色已由 PANEL_BG 提供，不重复写。） */
    '  max-height:calc(100vh - 32px);',
    '  overflow:auto;',
    '}',
    /* ★ 遮罩 —— 原生 dialog 的 ::backdrop 天然在最上层，不用 z-index */
    'dialog.dlg::backdrop{background:rgba(0,0,0,.55)}',
    /* 窄版 —— 纯确认类弹窗（没有输入框） */
    '.dlg-narrow{width:280px}',
    '.dlg-title{',
    '  font-size:13px;font-weight:600;letter-spacing:.04em;',
    '  color:var(--ink,#e6e6e6);margin-bottom:14px;',
    '}',
    '.dlg-msg{',
    '  font-size:12px;line-height:1.6;color:var(--muted,#8a8a94);',
    '  margin:-4px 0 16px;',
    '}',
    /* 输入框（prompt 用） */
    '.dlg-input{',
    '  width:100%;box-sizing:border-box;',
    CTRL_BG,
    /* ★ 盖掉 UA 的原生外观（灰底 + 内阴影） */
    '  appearance:none;-webkit-appearance:none;',
    '  border-radius:0;',
    '  padding:6px 8px;font:inherit;font-size:13px;',
    '  margin:0 0 14px;',
    '}',
    '/* 消息紧挨着输入框 —— 收紧消息的下边距 */',
    '.dlg-msg + .dlg-input{margin-top:-10px}',
    '.dlg-input:focus{outline:none;border-color:var(--lime,#c4f542)}',
    /* 校验错误提示 */
    '.dlg-err{',
    '  font-size:11px;color:var(--red,#ff4d4d);',
    '  margin:-8px 0 12px;',
    '}',
    '.dlg-actions{display:flex;justify-content:flex-end;gap:8px}',
    /* ★ DOM 顺序是「确定、取消」（回车要触发确定 —— 浏览器触发第一个 submit 按钮），
       但视觉上「确定」在右边 —— 用 order 翻转，不用改 DOM 顺序。 */
    '.dlg-actions .dlg-btn:is(.primary,.danger){order:2}',
    '.dlg-actions .dlg-btn:not(:is(.primary,.danger)){order:1}',
    '.dlg-btn{',
    CTRL_BG,
    '  padding:5px 14px;font:inherit;font-size:13px;cursor:pointer;',
    '}',
    '.dlg-btn:hover{border-color:var(--muted,#8a8a94)}',
    '.dlg-btn.primary{background:var(--lime,#c4f542);color:#0f0f12;border-color:var(--lime,#c4f542)}',
    '.dlg-btn.primary:hover{filter:brightness(1.08)}',
    /* 危险操作 —— 红色 */
    '.dlg-btn.danger{background:var(--red,#ff4d4d);color:#fff;border-color:var(--red,#ff4d4d)}',
    '.dlg-btn.danger:hover{filter:brightness(1.12)}',

    /* ── 轻提示（tips）── 底部居中，自动消失 */
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

    /* ── 加载遮罩 / 进度框 ── */
    /* ★ 这两个不是模态（不抢焦点、不进栈），自己造遮罩 div */
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
    '@media (prefers-reduced-motion:reduce){.dlg-spinner{animation:none}}',
    '.dlg-progress{',
    '  display:flex;flex-direction:column;gap:10px;',
    '  min-width:220px;max-width:min(420px,80vw);',
    PANEL_BG,
    '  padding:16px 18px;',
    '}',
    '.dlg-progress-msg{font-size:13px;line-height:1.5;color:var(--ink,#e6e6e6)}',
    '.dlg-progress-pct{font-size:11px;color:var(--muted,#8a8a94);text-align:right}',
    '.dlg-progress-bar{height:6px;background:var(--bg-3,#262931);border:1px solid var(--rule,#33363f);overflow:hidden}',
    '.dlg-progress-bar-fill{height:100%;width:0;background:var(--lime,#c4f542);transition:width .15s linear}',
    '.dlg-progress-circle{width:64px;height:64px;display:block;margin:0 auto}',
    '.dlg-progress-circle circle{fill:none;stroke-width:3}',
    '.dlg-progress-circle .track{stroke:var(--bg-3,#262931)}',
    '.dlg-progress-circle .fill{stroke:var(--lime,#c4f542);stroke-linecap:round;transition:stroke-dasharray .15s linear;transform:rotate(-90deg);transform-origin:50% 50%}',
    '.dlg-progress-circle text{fill:var(--ink,#e6e6e6);font-size:12px;text-anchor:middle;dominant-baseline:central}',
    '.dlg-progress-dots{display:flex;gap:5px;justify-content:center}',
    '.dlg-progress-dot{width:7px;height:7px;border-radius:50%;background:var(--lime,#c4f542);animation:dlg-bounce 1s ease-in-out infinite}',
    '@keyframes dlg-bounce{0%,80%,100%{transform:scale(.5);opacity:.45}40%{transform:scale(1);opacity:1}}',
    '.dlg-progress-steps{display:flex;gap:4px}',
    '.dlg-progress-step{flex:1;height:4px;background:var(--bg-3,#262931);border:1px solid var(--rule,#33363f)}',
    '.dlg-progress-step.on{background:var(--lime,#c4f542);border-color:var(--lime,#c4f542)}',
    '@media (prefers-reduced-motion:reduce){.dlg-progress-dot{animation:none}}',
  ].join('\n');

  var styleReady = false;

  function ensureStyle() {
    if (styleReady) return;
    styleReady = true;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* 打开中的模态弹窗 —— 只有最上面那个能响应 Esc */
  var stack = [];

  /* OK 按钮的内部哨兵值 —— 用来区分「确定」和「取消」。
     ★ 不能直接用 okValue —— 用户可能传 okValue:'' ，那就跟取消分不出来了。 */
  var OK_TOKEN = 'ok';

  /** 建元素。三个参数都可省。 */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
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

  /**
   * ★ 核心 —— 造一个原生 <dialog> 挂上去，返回控制器。
   *
   * ★ 模态机制全部由浏览器提供，不用自己实现：
   *   Esc 关闭       → close 事件，returnValue = ''
   *   焦点陷阱       → 浏览器把焦点锁在 dialog 里
   *   焦点归还       → 关闭后焦点自动回到打开前的元素
   *   背景 inert     → 底层元素不可聚焦、不可点击
   *   top layer      → 永远在最上面（z-index 无效）
   *
   * ★ 内部函数 —— 公开入口是 Dialog.create()，options 清单见那里。
   *
   * @param {Object} opts
   * @returns {{ input: ?HTMLInputElement, errEl: ?HTMLElement,
   *             promise: Promise<string>, close: Function }}
   */
  function openDialog(opts) {
    opts = opts || {};

    ensureStyle();

    var dlg = el('dialog', 'dlg');
    if (opts.maskClass) dlg.classList.add(opts.maskClass);
    if (opts.narrow) dlg.classList.add('dlg-narrow');

    /* ★ 内容用 <form method="dialog"> 包起来 ——
       浏览器会把点到的按钮的 value 写进 dialog.returnValue，然后自动 close。
       这就是「返回值」不用自己传的原因。 */
    var form = el('form', 'dlg-form');
    form.method = 'dialog';

    if (opts.title) form.appendChild(el('div', 'dlg-title', opts.title));

    if (opts.content) {
      var body = el('div', 'dlg-msg');
      if (typeof opts.content === 'string') {
        body.innerHTML = opts.content;   /* 故意用 innerHTML —— 调用方自己保证可信 */
      } else {
        body.appendChild(opts.content);
      }
      form.appendChild(body);
    } else if (opts.message) {
      form.appendChild(el('div', 'dlg-msg', opts.message));
    }

    /* 输入框 + 错误提示容器 */
    var input = null;
    var errEl = null;

    if (opts.inputCfg) {
      input = opts.inputCfg.multiline ? el('textarea', 'dlg-input') : el('input', 'dlg-input');
      if (!opts.inputCfg.multiline) input.type = opts.inputCfg.type;
      if (opts.inputCfg.placeholder) input.placeholder = opts.inputCfg.placeholder;
      if (opts.inputCfg.multiline) input.rows = 3;
      input.value = opts.inputCfg.value;

      /* ★ 单行输入框里回车 = 提交。
         不靠浏览器默认行为 —— 实测默认触发的是**第一个** submit 按钮，
         而按钮顺序是「确定在前」，所以浏览器默认行为正好就是提交。
         但 textarea 里回车是换行 —— 多行时提交靠 Ctrl/Cmd+Enter。 */
      if (!opts.inputCfg.multiline) {
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); submitForm(); }
        });
      } else {
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitForm(); }
        });
      }
      form.appendChild(input);

      errEl = el('div', 'dlg-err');
      errEl.hidden = true;
      form.appendChild(errEl);
    }

    /* 按钮 */
    var buttons = opts.buttons || [];
    var btnEls = [];
    if (buttons.length) {
      var actions = el('div', 'dlg-actions');
      buttons.forEach(function (b) {
        var btn = el('button', 'dlg-btn' + (b.cls ? ' ' + b.cls : ''), b.text);
        btn.type = 'submit';
        btn.value = b.value === undefined ? '' : String(b.value);
        if (b.autofocus) btn.setAttribute('autofocus', '');
        actions.appendChild(btn);
        btnEls.push(btn);
      });
      form.appendChild(actions);
    }

    /* ★ extra —— 插在正文和按钮之间的额外内容（勾选框、自定义控件…） */
    if (opts.extra) form.appendChild(opts.extra);

    dlg.appendChild(form);

    /* ★ 提交 —— 必须**指定具体按钮**。
       requestSubmit() 不带参数 = 没有 submitter → returnValue 保持 ''，
       而且 method=dialog 的 dialog 根本不会关（实测）。
       带上按钮，浏览器才会把它的 value 写进 returnValue 并关掉 dialog。 */
    function submitForm() {
      var btn = btnEls[opts.submitIndex || 0];
      if (!btn) return;
      if (typeof form.requestSubmit === 'function') form.requestSubmit(btn);
      else btn.click();
    }

    var settled = false;
    var promise = new Promise(function (resolve) {
      dlg.addEventListener('close', function () {
        if (settled) return;
        settled = true;
        var i = stack.indexOf(dlg);
        if (i >= 0) stack.splice(i, 1);
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
        resolve(dlg.returnValue);
      });

      /* ★ Esc 只会关最上面那个 ——
         原生行为是「一次 Esc 把所有叠着的 dialog 全关掉」。
         自己拦一层：preventDefault 掉原生关闭，然后只关自己。
         ★ 用 keydown 而不是 cancel 事件 —— 实测 cancel 事件不可取消
           （cancelable=false），preventDefault 拦不住。 */
      dlg.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        if (stack.length && stack[stack.length - 1] === dlg) dlg.close('');
      });

      /* ★ 点遮罩空白处 = 取消 ——
         原生 dialog 点 backdrop 不会关闭，得自己判：
         e.target === dlg 说明点在 dialog 元素本身（而不是里面的内容）。 */
      dlg.addEventListener('click', function (e) {
        if (e.target !== dlg) return;
        if (opts.dismissOnMask === false) return;
        dlg.close('');
      });

      /* ★ onSubmit 钩子 —— 返回 false 就不关（校验失败时用） */
      if (opts.onSubmit) {
        form.addEventListener('submit', function (e) {
          if (opts.onSubmit(dlg, e) === false) e.preventDefault();
        });
      }
    });

    document.body.appendChild(dlg);
    stack.push(dlg);
    dlg.showModal();

    /* ★ 焦点：autofocus 的按钮优先（浏览器原生行为），
       有输入框时落在输入框上（否则得先按 Tab 才能打字）。 */
    var focusTarget = dlg.querySelector('[autofocus]');
    if (focusTarget) focusTarget.focus();

    if (input) {
      input.focus();
      /* 有预填值时全选 —— 直接打字就能覆盖掉 */
      if (input.value) {
        try { input.select(); } catch (e) { /* 某些浏览器不支持 —— 忽略 */ }
      }
    }

    return {
      input: input,
      errEl: errEl,
      promise: promise,
      close: function (value) {
        if (settled) return;
        dlg.close(value === undefined || value === null ? '' : String(value));
      },
    };
  }

  /* ── Dialog 类 ───────────────────────────────────────────────
   *
   * ★ 模态对话框（确认框 / 提示框 / 输入框）的可编程形态：
   *
   *   new Dialog({ title, message, okText, cancelText, danger })
   *     .open()   → Promise<okValue | null>
   *     .close(v)
   *     .showError(msg)
   *
   * ★ 快捷方法（confirm / alert / prompt）都是它的薄封装。
   *   轻提示 / 加载遮罩 / 进度框不是模态 —— 不走这个类（见下）。
   */

  /**
   * @param {Object} [opts]
   * @param {string}  [opts.title='']
   * @param {string}  [opts.message='']
   * @param {Node|string} [opts.content] 自定义正文，优先于 message
   * @param {string}  [opts.okText='确定']
   * @param {string}  [opts.cancelText='取消']
   * @param {boolean} [opts.danger=false]    危险操作 —— 主按钮变红，焦点落在「取消」上
   * @param {boolean} [opts.hideCancel=false] 隐藏取消按钮
   * @param {*}       [opts.okValue='ok']     确定时 resolve 的值
   * @param {boolean|Object} [opts.input]     输入框。true 或 {type,value,placeholder,multiline}
   * @param {Function} [opts.onOk]    确定前的钩子，返回 false 则不关闭
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
    this.onOk = opts.onOk || null;
    this.onCancel = opts.onCancel || null;
    this.inputCfg = normalizeInput(opts.input);
    this.maskClass = opts.maskClass || '';

    this._ctl = null;   /* 打开后的控制器 */
  }

  /**
   * 打开弹窗。返回 Promise —— 确定时 resolve(okValue)，取消时 resolve(null)。
   * @returns {Promise}
   */
  Dialog.prototype.open = function () {
    var self = this;

    var buttons = [];
    /* ★ 按钮 DOM 顺序：确定在前、取消在后 ——
       实测输入框里回车触发的是**第一个** submit 按钮，
       确定必须排在前面，回车才是「确定」。 */
    buttons.push({
      text: this.okText,
      value: OK_TOKEN,
      cls: this.danger ? 'danger' : 'primary',
    });
    if (!this.hideCancel) {
      /* ★ danger 时 autofocus「取消」—— 回车不会误触发危险动作。
         原生 dialog 默认聚焦第一个可聚焦元素（确定），所以这里必须显式指定。 */
      buttons.push({ text: this.cancelText, value: 'cancel', autofocus: this.danger });
    }

    this._ctl = openDialog({
      title: this.title,
      message: this.message,
      content: this.content,
      inputCfg: this.inputCfg,
      maskClass: this.maskClass,
      buttons: buttons,
      onSubmit: function (dlgEl, e) {
        /* ★ 传给钩子的是 **Dialog 实例**（不是原始 <dialog> 元素）——
           钩子要能拿到 dlg._ctl.input / dlg.showError() 这些。 */
        if (self.onOk && self.onOk(self, e) === false) return false;   /* 钩子可以否决 */
        return true;
      },
    });

    var ctl = this._ctl;

    return ctl.promise.then(function (v) {
      /* 取消（cancel / Esc）→ onCancel 钩子 + resolve(null) */
      if (v !== OK_TOKEN) {
        if (self.onCancel) self.onCancel(ctl);
        return null;
      }
      /* ★ 有输入框时 resolve **输入框的值**（不是 okValue）—— prompt 就靠这个 */
      if (ctl.input) return ctl.input.value;
      return self.okValue;
    });
  };

  /**
   * 关闭弹窗。value 会 resolve 给 open() 返回的 Promise。
   * @param {*} [value]
   */
  Dialog.prototype.close = function (value) {
    if (!this._ctl) return;
    this._ctl.close(value);
  };

  /**
   * 显示校验错误提示（validate 钩子用）。传 null/空串清除。
   * @param {string|null} msg
   */
  Dialog.prototype.showError = function (msg) {
    if (!this._ctl || !this._ctl.errEl) return;
    var text = msg ? String(msg) : '';
    this._ctl.errEl.textContent = text;
    this._ctl.errEl.hidden = !text;
    /* 报错后焦点回输入框 —— 方便直接改 */
    if (text && this._ctl.input) {
      try { this._ctl.input.focus(); } catch (e) { /* 忽略 */ }
    }
  };

  /* ── 快捷方法 ───────────────────────────────────────────── */

  /**
   * ★ 核心 API —— 弹一个对话框，返回 Promise<返回值>。
   *
   * 所有弹层形态都是它的一层薄封装；想加新形态就调它。
   *
   * 用法：
   *   const v = await Dialog.create({
   *     title: '标题',
   *     content: '<b>正文</b>',
   *     buttons: [
   *       { text: '取消', value: 'cancel' },
   *       { text: '确定', value: 'ok', cls: 'primary' },
   *     ],
   *   });
   *   if (v === 'ok') { ... }
   *
   * @param {Object} opts
   * @param {string}   [opts.title='']      标题（textContent，不解析 HTML）
   * @param {string}   [opts.message='']    正文（textContent）
   * @param {Node|string} [opts.content]     自定义正文，优先于 message
   * @param {Node}     [opts.extra]         额外内容，插在正文和按钮之间
   * @param {Array}    [opts.buttons]        [{ text, value, cls, autofocus }]
   * @param {Function} [opts.onSubmit]       提交前钩子 —— 返回 false 则不关闭
   * @param {string}   [opts.maskClass='']   追加到 <dialog> 上的 class
   * @param {boolean}  [opts.narrow=false]   窄版（280px）
   * @param {boolean}  [opts.dismissOnMask=true] 点遮罩空白处是否关闭
   * @param {number}   [opts.submitIndex=0]  回车提交时用第几个按钮
   * @returns {Promise<string>} 按钮的 value（Esc 关闭 → ''）
   */
  Dialog.create = function (opts) {
    return openDialog(opts).promise;
  };

  /**
   * 确认框。返回 Promise<boolean>。
   * @param {string} message
   * @param {Object} [opts] 同构造函数
   */
  Dialog.confirm = function (message, opts) {
    /* ★ message / hideCancel 是显式参数 —— 压过 opts 里的同名字段 */
    var dlg = new Dialog(Object.assign({}, opts, { message: message }));
    return dlg.open().then(function (v) {
      return v !== null && v !== undefined && v !== false;
    });
  };

  /**
   * 提示框（只有一个按钮）。返回 Promise<void>。
   * @param {string} message
   * @param {Object} [opts] 同构造函数
   */
  Dialog.alert = function (message, opts) {
    var dlg = new Dialog(Object.assign({}, opts, { message: message, hideCancel: true }));
    return dlg.open().then(function () {});
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
    opts = opts || {};

    var dlg = new Dialog(Object.assign({}, opts, {
      message: message,
      input: {
        type: opts.inputType || 'text',
        value: opts.value === undefined || opts.value === null ? '' : String(opts.value),
        placeholder: opts.placeholder || '',
        multiline: !!opts.multiline,
      },
    }));

    /* ★ validate 钩子：返回错误文案就不关闭 —— 用 onOk 钩子实现（它返回 false 可否决） */
    var validate = opts.validate;
    if (validate) {
      var userOnOk = dlg.onOk;
      dlg.onOk = function (d, e) {
        if (userOnOk && userOnOk(d, e) === false) return false;
        var err = validate(d._ctl.input ? d._ctl.input.value : '', d);
        if (err) {
          d.showError(err);
          return false;   /* 钩子返回 false → 不关闭 */
        }
        return true;
      };
    }

    return dlg.open().then(function (v) {
      return v === null ? null : String(v);
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
    opts = opts || {};

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
    var closed = false;

    function close() {
      if (closed) return;      /* ★ 幂等 —— 调多次只关一次 */
      closed = true;
      if (timer) { clearTimeout(timer); timer = 0; }
      tip.classList.remove('show');
      /* ★ 淡出 200ms 后再摘掉 —— 直接摘会丢掉动画 */
      setTimeout(function () {
        if (tip.parentNode) tip.parentNode.removeChild(tip);
      }, 200);
    }

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

    var closed = false;
    function close() {
      if (closed) return;      /* ★ 幂等 —— 调多次只关一次 */
      closed = true;
      if (overlayEl === mask) overlayEl = null;
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }

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
    opts = opts || {};

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
    opts = opts || {};

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

  /* 暴露到全局 —— 跟 plugin/plugin.js 的风格一致 */
  if (typeof window !== 'undefined') {
    window.Dialog = Dialog;
  }
  /* CommonJS 环境也挂一下 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Dialog;
  }
})();
