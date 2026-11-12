/**
 * dialog.js — 通用弹窗组件
 *
 * 零依赖，纯前端。整个组件自己注入样式（<style> 标签），不依赖宿主页面的 CSS。
 * 颜色用 CSS 变量：宿主页面定义了 :root 变量就跟随宿主主题，没定义就用回退值。
 *
 * ★ 架构：**基于原生 <dialog> 元素**。
 *   模态机制（Esc 关闭 / 焦点陷阱 / 焦点归还 / 背景 inert / top layer）
 *   全部由浏览器提供。
 *
 * ★ 核心就一个内部函数 openDialog()：
 *   造一个 <dialog>，塞进内容，返回 Promise<返回值>。
 *   所有弹层形态都是它的一层薄封装。
 *
 * 用法：
 *   <script src="/pub/js/dialog/dialog.js"></script>
 *   <script>
 *     if (await Dialog.confirm('清空文档？', { danger: true })) { ... }
 *   </script>
 *
 * ★ 危险操作（danger: true）的默认焦点在「取消」上 —— 回车不会误触发。
 * ★ Esc / 点遮罩空白处 = 取消；回车 = 确定（焦点在按钮上时除外，避免触发两次）。
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
        'dialog.dlg{',
        '  width:320px;max-width:calc(100vw - 32px);',
        PANEL_BG,
        '  box-shadow:0 12px 40px rgba(0,0,0,.6);',
        '  padding:18px 18px 14px;',
        '  border-radius:0;',
        /* 覆盖 <dialog> 的 UA 默认样式 —— 放开 max-height，改用自身滚动 */
        '  max-height:calc(100vh - 32px);',
        '  overflow:auto;',
        '}',
        'dialog.dlg::backdrop{background:rgba(0,0,0,.55)}',
        /* 窄版 —— 纯确认类弹窗 */
        'dialog.dlg.dlg-narrow{width:280px}',
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
        '  appearance:none;-webkit-appearance:none;',
        '  border-radius:0;',
        '  padding:6px 8px;font:inherit;font-size:13px;',
        '  margin:0 0 14px;',
        '}',
        '.dlg-msg + .dlg-input{margin-top:-10px}',
        '.dlg-input:focus{outline:none;border-color:var(--lime,#c4f542)}',
        /* 校验错误提示 */
        '.dlg-err{',
        '  font-size:11px;color:var(--red,#ff4d4d);',
        '  margin:-8px 0 12px;',
        '}',
        '.dlg-actions{display:flex;justify-content:flex-end;gap:8px}',
        /* DOM 顺序是「确定、取消」，视觉上「确定」在右边 —— 用 order 翻转 */
        '.dlg-actions .dlg-btn:is(.primary,.danger){order:2}',
        '.dlg-actions .dlg-btn:not(:is(.primary,.danger)){order:1}',
        '.dlg-btn{',
        CTRL_BG,
        '  padding:5px 14px;font:inherit;font-size:13px;cursor:pointer;',
        '}',
        '.dlg-btn:hover{border-color:var(--muted,#8a8a94)}',
        '.dlg-btn.primary{background:var(--lime,#c4f542);color:#0f0f12;border-color:var(--lime,#c4f542)}',
        '.dlg-btn.primary:hover{filter:brightness(1.08)}',
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

    /* id 计数器 —— 给 title 生成唯一 id，供 aria-labelledby 用 */
    var uid = 0;

    /** 建元素。三个参数都可省。 */
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }

    /* 取文本 —— 没给 / 给 null 时用默认值 */
    function str(v, dflt) {
        return v === undefined || v === null ? dflt : String(v);
    }

    /* 从白名单里取 —— hasOwnProperty 挡掉 'constructor' 这类原型链上的键 */
    function pick(map, key, dflt) {
        return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : dflt;
    }

    /**
     * 归一化输入框配置。
     *   true                    → 普通文本框
     *   { type, value, placeholder, multiline }
     * multiline 走 textarea —— 多行时回车是换行，提交靠 Ctrl/Cmd+Enter。
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
     *   模态机制（Esc / 焦点陷阱 / 焦点归还 / inert / top layer）全部由浏览器提供。
     *
     * @param {Object} opts
     * @returns {{ input: ?HTMLElement, errEl: ?HTMLElement,
     *             promise: Promise<string>, close: Function }}
     */
    function openDialog(opts) {
        opts = opts || {};

        var inputCfg = normalizeInput(opts.input);

        ensureStyle();

        var dlg = el('dialog', 'dlg');
        if (opts.maskClass) {
            /* 允许多类名（"a b"） */
            String(opts.maskClass).split(/\s+/).forEach(function (c) {
                if (c) dlg.classList.add(c);
            });
        }
        if (opts.narrow) dlg.classList.add('dlg-narrow');

        /* 内容用 <form method="dialog"> 包起来 ——
           浏览器会把点到的按钮的 value 写进 dialog.returnValue，然后自动 close。
           ★ novalidate：禁用浏览器原生校验 —— 统一走 onSubmit / validate 钩子。
             否则 input type="email" 之类会被原生校验拦住，onSubmit 根本收不到 submit。 */
        var form = el('form', 'dlg-form');
        form.method = 'dialog';
        form.noValidate = true;

        /* 标题 —— 有 title 时挂 id，供 aria-labelledby 用 */
        if (opts.title) {
            var titleEl = el('div', 'dlg-title', opts.title);
            titleEl.id = 'dlg-title-' + (++uid);
            dlg.setAttribute('aria-labelledby', titleEl.id);
            form.appendChild(titleEl);
        }

        if (opts.content) {
            var body = el('div', 'dlg-msg');
            if (typeof opts.content === 'string') {
                body.innerHTML = opts.content;   /* 调用方自己保证可信 */
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

        if (inputCfg) {
            input = inputCfg.multiline ? el('textarea', 'dlg-input') : el('input', 'dlg-input');
            if (!inputCfg.multiline) input.type = inputCfg.type;
            if (inputCfg.placeholder) input.placeholder = inputCfg.placeholder;
            if (inputCfg.multiline) input.rows = 3;
            input.value = inputCfg.value;

            /* 单行回车 = 提交；多行回车是换行，Ctrl/Cmd+Enter 提交。 */
            if (!inputCfg.multiline) {
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

        /* extra —— 插在正文和按钮之间的额外内容 */
        if (opts.extra) form.appendChild(opts.extra);

        dlg.appendChild(form);

        /* 提交必须指定具体按钮 —— 不带 submitter 的 requestSubmit() 不会写 returnValue */
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

            /* Esc / 回车 —— 一个监听器处理两件事 */
            dlg.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    if (stack.length && stack[stack.length - 1] === dlg) dlg.close('');
                    return;
                }
                if (e.key === 'Enter') {
                    var t = e.target;
                    if (t && (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
                    e.preventDefault();
                    submitForm();
                }
            });

            /* 点遮罩空白处 = 取消。
               ★ 不能只看 e.target === dlg —— 点 dialog 的 padding / 滚动条时
                 target 也是 dlg，会误关。用点击坐标是否落在 dialog 矩形外来判断。 */
            dlg.addEventListener('click', function (e) {
                if (e.target !== dlg) return;
                if (opts.dismissOnMask === false) return;
                var rect = dlg.getBoundingClientRect();
                if (e.clientX >= rect.left && e.clientX <= rect.right &&
                    e.clientY >= rect.top && e.clientY <= rect.bottom) return;
                dlg.close('');
            });

            /* onSubmit 钩子 —— 返回 false 就不关（校验失败时用） */
            if (opts.onSubmit) {
                form.addEventListener('submit', function (e) {
                    if (opts.onSubmit(dlg, e) === false) e.preventDefault();
                });
            }
        });

        document.body.appendChild(dlg);
        stack.push(dlg);
        dlg.showModal();

        /* 焦点：autofocus 按钮优先，有输入框时落在输入框上 */
        var focusTarget = dlg.querySelector('[autofocus]');
        if (focusTarget) focusTarget.focus();

        if (input) {
            input.focus();
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

    /* ── Dialog 命名空间 ───────────────────────────────────────── */

    var Dialog = {};

    /**
     * ★ 核心 API —— 弹一个对话框，返回 Promise<返回值>。
     *   所有弹层形态都是它的一层薄封装。
     *
     * @param {Object} opts
     * @param {string}   [opts.title='']      标题（textContent）
     * @param {string}   [opts.message='']    正文（textContent）
     * @param {Node|string} [opts.content]    自定义正文，优先于 message
     * @param {Node}     [opts.extra]         额外内容，插在正文和按钮之间
     * @param {Array}    [opts.buttons]       [{ text, value, cls, autofocus }]
     * @param {Function} [opts.onSubmit]      提交前钩子 —— 返回 false 则不关闭
     * @param {boolean|Object} [opts.input]   输入框。true 或 {type,value,placeholder,multiline}
     * @param {string}   [opts.maskClass='']  追加到 <dialog> 上的 class
     * @param {boolean}  [opts.narrow=false]  窄版（280px）
     * @param {boolean}  [opts.dismissOnMask=true] 点遮罩空白处是否关闭
     * @param {number}   [opts.submitIndex=0] 回车提交时用第几个按钮
     * @returns {Promise<string>} 按钮的 value（Esc 关闭 → ''）
     */
    Dialog.create = function (opts) {
        return openDialog(opts).promise;
    };

    /**
     * 确认框。返回 Promise<boolean>。
     * @param {string} message
     * @param {Object} [opts] title / content / okText / cancelText / danger / hideCancel / narrow …
     */
    Dialog.confirm = function (message, opts) {
        opts = opts || {};
        var danger = !!opts.danger;
        var buttons = [
            { text: str(opts.okText, '确定'), value: 'ok', cls: danger ? 'danger' : 'primary' },
        ];
        if (!opts.hideCancel) {
            buttons.push({ text: str(opts.cancelText, '取消'), value: '', autofocus: danger });
        }
        return openDialog(Object.assign({ narrow: true }, opts, {
            message: message,
            buttons: buttons,
        })).promise.then(function (v) { return v === 'ok'; });
    };

    /**
     * 提示框（只有一个按钮）。返回 Promise<void>。
     * @param {string} message
     * @param {Object} [opts] title / content / okText / narrow …
     */
    Dialog.alert = function (message, opts) {
        opts = opts || {};
        return openDialog(Object.assign({ narrow: true }, opts, {
            message: message,
            buttons: [{ text: str(opts.okText, '确定'), value: 'ok', cls: 'primary' }],
        })).promise.then(function () {});
    };

    /**
     * 输入框。返回 Promise<string|null> —— 确定时 resolve 输入的内容，取消时 null。
     *
     * @param {string} message
     * @param {Object} [opts] title / okText / cancelText / danger / narrow …
     * @param {string}  [opts.value='']        输入框初始值
     * @param {string}  [opts.placeholder='']  占位提示
     * @param {string}  [opts.inputType='text'] input 的 type（text / password / email …）
     * @param {boolean} [opts.multiline=false] 多行（textarea）—— Ctrl/Cmd+Enter 提交
     * @param {Function} [opts.validate] 校验函数 —— 返回字符串表示错误（不关闭），返回 undefined 表示通过
     * @returns {Promise<string|null>}
     */
    Dialog.prompt = function (message, opts) {
        opts = opts || {};
        var validate = opts.validate;
        var userOnSubmit = opts.onSubmit;
        var ctl;

        ctl = openDialog(Object.assign({ narrow: true }, opts, {
            message: message,
            input: {
                type: opts.inputType || 'text',
                value: opts.value === undefined || opts.value === null ? '' : String(opts.value),
                placeholder: opts.placeholder || '',
                multiline: !!opts.multiline,
            },
            buttons: [
                { text: str(opts.okText, '确定'), value: 'ok', cls: opts.danger ? 'danger' : 'primary' },
                { text: str(opts.cancelText, '取消'), value: '' },
            ],
            /* ★ 先跑用户自己的 onSubmit，再跑 validate —— 不能把用户的钩子覆盖掉 */
            onSubmit: function (dlg, e) {
                if (userOnSubmit && userOnSubmit(dlg, e) === false) return false;
                if (!validate) return true;
                var err = validate(ctl.input ? ctl.input.value : '', ctl);
                if (err) {
                    ctl.errEl.textContent = String(err);
                    ctl.errEl.hidden = false;
                    if (ctl.input) { try { ctl.input.focus(); } catch (err2) { /* 忽略 */ } }
                    return false;
                }
                return true;
            },
        }));

        return ctl.promise.then(function (v) {
            return v === 'ok' ? String(ctl.input.value) : null;
        });
    };

    /* ── 轻提示（tips）────────────────────────────────────────── */

    var TIPS_ID = 'dlg-tips-container';

    function tipsContainer() {
        var box = document.getElementById(TIPS_ID);
        if (box) return box;
        box = el('div', 'dlg-tips');
        box.id = TIPS_ID;
        /* 屏幕阅读器友好 —— 新提示会被播报 */
        box.setAttribute('role', 'status');
        (document.body || document.documentElement).appendChild(box);
        return box;
    }

    var TIP_TYPES = { info: 'info', success: 'success', error: 'error' };

    /**
     * 轻提示（toast）。底部居中弹一条，timeout 毫秒后自动消失。
     *
     * @param {string} message
     * @param {Object} [opts]
     * @param {number}  [opts.timeout=5000] 自动消失的毫秒数；0 = 不自动消失
     * @param {string}  [opts.type='info']   info / success / error
     * @returns {{ close: Function }}
     */
    Dialog.tips = function (message, opts) {
        opts = opts || {};

        var timeout = opts.timeout === undefined ? 5000 : Number(opts.timeout);
        if (!isFinite(timeout) || timeout < 0) timeout = 0;

        var type = pick(TIP_TYPES, opts.type, 'info');

        ensureStyle();

        var box = tipsContainer();
        var tip = el('div', 'dlg-tip' + (type === 'info' ? '' : ' ' + type),
            str(message, ''));
        box.appendChild(tip);

        var timer = 0;
        var closed = false;

        function close() {
            if (closed) return;
            closed = true;
            if (timer) { clearTimeout(timer); timer = 0; }
            tip.classList.remove('show');
            setTimeout(function () {
                if (tip.parentNode) tip.parentNode.removeChild(tip);
            }, 200);
        }

        tip.addEventListener('click', close);
        if (timeout > 0) timer = setTimeout(close, timeout);

        /* 下一帧再加 .show —— 同一帧加不会触发 transition */
        var raf = (typeof requestAnimationFrame === 'function')
            ? requestAnimationFrame
            : function (fn) { setTimeout(fn, 16); };
        raf(function () { tip.classList.add('show'); });

        return { close: close };
    };

    /* ── 浮层原语（loading / progress 共用）──────────────────── */

    /* 当前打开的浮层 —— 同时只允许一个 */
    var overlayEl = null;

    function makeOverlay(boxClass, maskOn) {
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
            if (closed) return;
            closed = true;
            if (overlayEl === mask) overlayEl = null;
            if (mask.parentNode) mask.parentNode.removeChild(mask);
        }

        return { mask: mask, box: box, close: close };
    }

    /**
     * 加载遮罩。居中转圈 + 文字，盖住下面的交互。
     *
     * @param {string} [message='加载中…']
     * @param {Object} [opts]
     * @param {boolean} [opts.mask=true] 是否盖住下面的交互
     * @returns {{ close: Function }}
     */
    Dialog.loading = function (message, opts) {
        opts = opts || {};

        ensureStyle();

        var ov = makeOverlay('dlg-loading', opts.mask);
        ov.box.setAttribute('role', 'status');
        ov.box.appendChild(el('span', 'dlg-spinner'));

        var text = str(message, '加载中…');
        if (text) ov.box.appendChild(el('span', null, text));

        return { close: ov.close };
    };

    /* ── 进度（progress）──────────────────────────────────────── */

    var RENDERERS = {

        /* 横向进度条 */
        bar: {
            build: function (box) {
                var bar = el('div', 'dlg-progress-bar');
                var fill = el('div', 'dlg-progress-bar-fill');
                bar.appendChild(fill);
                box.appendChild(bar);

                var pct = el('div', 'dlg-progress-pct');
                box.appendChild(pct);

                return function (v, shown) {
                    fill.style.width = v + '%';
                    pct.textContent = shown + '%';
                };
            }
        },

        /* 环形（SVG）—— 用 stroke-dasharray 画弧 */
        circle: {
            build: function (box) {
                var NS = 'http://www.w3.org/2000/svg';
                var svg = document.createElementNS(NS, 'svg');
                svg.setAttribute('class', 'dlg-progress-circle');
                svg.setAttribute('viewBox', '0 0 36 36');

                var track = document.createElementNS(NS, 'circle');
                track.setAttribute('class', 'track');
                track.setAttribute('cx', '18'); track.setAttribute('cy', '18'); track.setAttribute('r', '15.5');
                svg.appendChild(track);

                var fill = document.createElementNS(NS, 'circle');
                fill.setAttribute('class', 'fill');
                fill.setAttribute('cx', '18'); fill.setAttribute('cy', '18'); fill.setAttribute('r', '15.5');
                svg.appendChild(fill);

                var pct = document.createElementNS(NS, 'text');
                pct.setAttribute('x', '18'); pct.setAttribute('y', '18');
                pct.textContent = '0%';
                svg.appendChild(pct);

                box.appendChild(svg);

                var CIRC = 2 * Math.PI * 15.5;

                return function (v, shown) {
                    /* ★ 0% 时隐藏 fill —— stroke-linecap:round 会画出一个小圆点 */
                    if (v <= 0) {
                        fill.style.display = 'none';
                    } else {
                        fill.style.display = '';
                        fill.setAttribute('stroke-dasharray', (v / 100 * CIRC) + ' ' + CIRC);
                    }
                    pct.textContent = shown + '%';
                };
            }
        },

        /* 三点跳动 —— 不确定进度，没有百分比 */
        dots: {
            build: function (box) {
                var dots = el('div', 'dlg-progress-dots');
                for (var i = 0; i < 3; i++) {
                    var dot = el('span', 'dlg-progress-dot');
                    dot.style.animationDelay = (i * 0.15) + 's';
                    dots.appendChild(dot);
                }
                box.appendChild(dots);

                return function () {};
            }
        },

        /* 分段步骤条 */
        steps: {
            build: function (box, opts) {
                var n = Math.max(1, Math.min(20, opts.steps || 5));
                var steps = el('div', 'dlg-progress-steps');
                var segs = [];
                for (var k = 0; k < n; k++) {
                    var seg = el('div', 'dlg-progress-step');
                    steps.appendChild(seg);
                    segs.push(seg);
                }
                box.appendChild(steps);

                var pct = el('div', 'dlg-progress-pct');
                box.appendChild(pct);

                return function (v, shown) {
                    var done = Math.round(v / 100 * segs.length);
                    for (var s = 0; s < segs.length; s++) {
                        if (s < done) segs[s].classList.add('on');
                        else segs[s].classList.remove('on');
                    }
                    pct.textContent = shown + '%';
                };
            }
        }
    };

    /**
     * 进度框。显示一个进度条/环/点/步骤，并返回句柄更新进度。
     *
     * @param {string} [message='处理中…']
     * @param {Object} [opts]
     * @param {string}  [opts.type='bar']    bar / circle / dots / steps
     * @param {number}  [opts.steps=5]       steps 样式的段数
     * @param {number}  [opts.value=0]       初始进度 0~100
     * @param {boolean} [opts.mask=true]     是否盖住下面的交互
     * @returns {{ set: Function, close: Function }}
     */
    Dialog.progress = function (message, opts) {
        opts = opts || {};

        var renderer = pick(RENDERERS, opts.type, RENDERERS.bar);

        ensureStyle();

        var ov = makeOverlay('dlg-progress', opts.mask);
        var box = ov.box;
        box.setAttribute('role', 'progressbar');
        box.setAttribute('aria-valuemin', '0');
        box.setAttribute('aria-valuemax', '100');

        var msgEl = el('div', 'dlg-progress-msg', str(message, '处理中…'));
        box.appendChild(msgEl);

        var paint = renderer.build(box, opts);

        function set(value, text) {
            var v = Number(value);
            if (!isFinite(v)) return;
            if (v < 0) v = 0;
            if (v > 100) v = 100;

            if (text !== undefined && text !== null) msgEl.textContent = String(text);

            box.setAttribute('aria-valuenow', String(Math.round(v)));
            paint(v, Math.round(v));
        }

        set(opts.value === undefined ? 0 : opts.value);

        return { set: set, close: ov.close };
    };

    /* 暴露到全局 —— 跟 plugin/plugin.js 的风格一致 */
    if (typeof window !== 'undefined') {
        window.Dialog = Dialog;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Dialog;
    }
})();