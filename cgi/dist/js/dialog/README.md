# dialog — 通用弹窗组件

零依赖的纯前端弹窗（modal dialog）。自己注入样式，不依赖宿主页面的 CSS；
颜色走 CSS 变量，宿主页面定义了 `:root` 变量就跟随宿主主题。

★ **基于原生 `<dialog>` 元素** —— 下面这些模态机制全部由浏览器提供，不用自己实现：

| 机制 | 谁负责 |
|---|---|
| Esc 关闭 | 浏览器（`close` 事件 + `returnValue`） |
| 焦点陷阱（Tab 循环） | 浏览器 |
| 焦点归还（关闭后回到原处） | 浏览器 |
| 背景 inert（底层不可点/不可聚焦） | 浏览器 |
| top layer（永远最上层） | 浏览器 |

★ **核心只有一个内部函数** —— `openDialog(options)`，造一个 `<dialog>` 塞进内容，
返回 `{ promise, input, errEl, close }`。

对外暴露的是**一个命名空间 `Dialog`**，上面挂着 7 个静态方法：

| 方法 | 返回 | 说明 |
|---|---|---|
| `Dialog.create(options)` | `Promise<string>` | ★ 核心 API —— 弹一个自定义对话框，resolve 按钮的 value |
| `Dialog.confirm(msg, opts?)` | `Promise<boolean>` | 确认框 |
| `Dialog.alert(msg, opts?)` | `Promise<void>` | 提示框（只有一个按钮） |
| `Dialog.prompt(msg, opts?)` | `Promise<string\|null>` | 输入框，`null` = 用户取消 |
| `Dialog.tips(msg, opts?)` | `{ close() }` | 轻提示（底部居中） |
| `Dialog.loading(msg?, opts?)` | `{ close() }` | 加载遮罩 |
| `Dialog.progress(msg?, opts?)` | `{ set(), close() }` | 进度框（四种样式） |

所有形态都是 `Dialog.create` 的薄封装 —— 想加新形态就调它，不用改内部。

## 引入

普通 `<script>` 标签（挂全局 `window.Dialog`）：

```html
<script src="/pub/js/dialog/dialog.js"></script>
```

CommonJS：

```js
const Dialog = require('/pub/js/dialog/dialog.js');
```

> 路径里的 `/pub/` 是静态服务器入口（`cgi/pub`，`PUB_ROOT` 默认 `dist`）。
> 直接写 `/dist/js/...` **不通** —— 没有对应的 CGI 脚本，连接会被直接关掉。
>
> ★ 本模块是 **classic script**，不是 ES module —— 没有 `export` 关键字。
> `import { Dialog } from '...'` **用不了**（没有具名导出）。

## 核心 API

`Dialog.create(options)` 是所有形态的底座 —— 返回 `Promise<按钮的 value>`：

```js
const v = await Dialog.create({
  title: '标题',
  content: '<b>正文</b>',
  buttons: [
    { text: '确定', value: 'ok', cls: 'primary' },
    { text: '取消', value: 'cancel' },
  ],
});
if (v === 'ok') { ... }   // Esc 关闭 → ''
```

★ 按钮的 **DOM 顺序决定回车触发谁** —— 浏览器触发的是第一个 submit 按钮。
所以「确定」要排在前面（视觉顺序用 CSS `order` 翻到右边）。

★ **返回值就是按钮的 `value`** —— 想自定义 resolve 什么，就在 `buttons` 里写 `value`。
（没有独立的 `okValue` 选项。）

```js
// 确认框 → Promise<boolean>
const yes = await Dialog.confirm('清空文档？', { danger: true });
if (yes) { /* ... */ }

// 提示框（只有一个按钮）→ Promise<void>
await Dialog.alert('已保存。');

// 输入框 → Promise<string|null>   ★ null = 用户取消
const name = await Dialog.prompt('请输入名字');
if (name === null) return;   // 用户取消了（Esc / 点遮罩 / 取消按钮）
```

## `Dialog.create` 选项

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `title` | string | `''` | 标题（`textContent`，不解析 HTML） |
| `message` | string | `''` | 正文（`textContent`） |
| `content` | Node \| string | `null` | 自定义正文，**优先于** `message`。字符串会被当 HTML 解析 —— 只放可信内容 |
| `extra` | Node | `null` | 额外内容，插在正文和按钮之间（勾选框、自定义控件…） |
| `buttons` | Array | `[]` | `[{ text, value, cls, autofocus }]` |
| `input` | boolean \| Object | `false` | 输入框。`true` 或 `{type,value,placeholder,multiline}` |
| `onSubmit` | Function | `null` | 提交前钩子 —— **返回 `false` 则不关闭** |
| `maskClass` | string | `''` | 追加到 `<dialog>` 上的 class。**支持空格分隔的多个**（`"a b"`） |
| `narrow` | boolean | `false` | 窄版（280px）。默认宽度 320px |
| `dismissOnMask` | boolean | `true` | 点遮罩空白处是否关闭 |
| `submitIndex` | number | `0` | 回车提交时用第几个按钮（0 = 第一个） |

★ `input` 存在时，`Dialog.create` resolve 的**仍然是按钮的 value**。
想要「resolve 输入框的内容」，用 `Dialog.prompt`。

## 各方法的额外选项

`confirm` / `alert` / `prompt` 除了上表的通用选项，还有各自的：

| 方法 | 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| `confirm` | `okText` | string | `'确定'` | 主按钮文字 |
| | `cancelText` | string | `'取消'` | 取消按钮文字 |
| | `danger` | boolean | `false` | 危险操作：主按钮变红，**默认焦点在「取消」上** |
| | `hideCancel` | boolean | `false` | 隐藏取消按钮（只剩一个按钮时用） |
| `alert` | `okText` | string | `'确定'` | 主按钮文字 |
| `prompt` | `okText` | string | `'确定'` | 主按钮文字 |
| | `cancelText` | string | `'取消'` | 取消按钮文字 |
| | `danger` | boolean | `false` | 同 confirm |
| | `value` | string | `''` | 输入框初始值 |
| | `placeholder` | string | `''` | 占位提示 |
| | `inputType` | string | `'text'` | input 的 `type`（text / password / email …） |
| | `multiline` | boolean | `false` | 多行（textarea）—— Ctrl/Cmd+Enter 提交 |
| | `validate` | Function | `null` | `(value, dialog) => string \| undefined` —— 返回错误文案则**不关闭**并显示提示，焦点回到输入框 |
| | `onSubmit` | Function | `null` | 提交前钩子 —— 返回 `false` 则不关闭 |

★ `confirm` / `alert` / `prompt` **默认窄版（280px）**，`Dialog.create` 默认 320px。
（用 `narrow: false` 可以改回去。）
★ `prompt` 的 `onSubmit` 和 `validate` **都会跑** —— 先跑你的 `onSubmit`，
返回 `false` 就直接否决；否则再跑 `validate`。

### 输入框

```js
// 初始值 + 占位提示
const name = await Dialog.prompt('请输入名字', {
  value: '张三',          // 提交前就在输入框里
  placeholder: '你的名字',
});

// 密码
const pw = await Dialog.prompt('请输入密码', { inputType: 'password' });

// 校验：返回错误文案就不关闭，显示提示
const pw2 = await Dialog.prompt('密码（至少 6 位）', {
  inputType: 'password',
  validate: (v) => v.length < 6 ? '至少 6 位' : undefined,
});

// 多行：普通回车换行，Ctrl/Cmd+Enter 提交
const text = await Dialog.prompt('备注', { multiline: true });
```

★ 有初始值时它会被**全选** —— 直接打字就能覆盖。
★ 输入框存在时**焦点落在输入框上**（不用先按 Tab）。
★ 表单设了 `novalidate` —— `input type="email"` 这类原生校验**不会**拦截提交，
统一走 `onSubmit` / `validate` 钩子。

### 轻提示（tips）

`Dialog.tips` 在**底部居中**弹一条轻提示，**默认 5 秒后自动消失**。

```js
Dialog.tips('已保存');                              // 5 秒后自动消失
Dialog.tips('出错了', { type: 'error' });           // 红边框
Dialog.tips('加载中…', { timeout: 0 });             // 不自动消失（常驻）

const t = Dialog.tips('常驻', { timeout: 0 });
t.close();                                          // 手动关掉
```

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `timeout` | number | `5000` | 自动消失的毫秒数。**`0` = 不自动消失**；负数 / 非法值按 `0` 处理 |
| `type` | string | `'info'` | `info` / `success` / `error` —— 决定边框色（默认 / 绿 / 红）。其它值按 `info` 处理 |

返回值是 `{ close() }` —— 手动关掉。

★ **多条提示竖着叠**（新的在下面），每条各自计时。
★ **点提示本身也能提前关掉。**

### 加载遮罩（loading）

`Dialog.loading` 在**居中**显示一个转圈 + 文字，**挡住下面的交互**（防止重复点击）。

```js
const l = Dialog.loading('加载中…');
try {
  await doWork();
} finally {
  l.close();          // 用完一定要关
}
```

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mask` | boolean | `true` | 是否挡住下面的交互。`false` = 只显示转圈，不挡点击 |

返回值是 `{ close() }`。

★ **同一时刻只有一个 loading** —— 再调一次会**换掉**上一个（不叠加）。
★ **`close()` 幂等** —— 调多次只关一次，`finally` 里放心调。
★ **加载期间 Esc / 点遮罩都不会关掉它** —— 只能用 `close()` 关。

### 进度框（progress）

`Dialog.progress` 显示一个进度指示器，返回句柄可以随时更新进度。

```js
const p = Dialog.progress('上传中…', { type: 'bar' });
p.set(45);                 // 45%
p.set(45, '已传 4.5MB');    // 顺带换文案
p.close();
```

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `type` | string | `'bar'` | 四种样式，见下 |
| `steps` | number | `5` | `steps` 样式的段数（1~20） |
| `value` | number | `0` | 初始进度（0~100） |
| `mask` | boolean | `true` | 是否挡住下面的交互 |

**四种样式：**

| `type` | 长相 | 用途 |
|---|---|---|
| `bar` | 横向进度条 | 知道百分比时用（默认） |
| `circle` | 环形，中间显示百分比 | 知道百分比时用，比条更醒目 |
| `dots` | 三点跳动 | **不知道总量**时用（不确定进度，没有百分比） |
| `steps` | 分段步骤条 | 多阶段任务，段数由 `steps` 定 |

返回值是 `{ set(value, text?), close() }`。

★ `set()` 的值自动夹在 **0~100**，非法值（NaN / 字符串）**忽略**。
★ **progress 跟 loading 共用一个遮罩槽** —— 后开的会换掉先开的（不叠加）。
★ 进度期间 **Esc / 点遮罩都不会关掉它** —— 只能用 `close()` 关。

## 行为

| 操作 | 结果 | 谁实现 |
|---|---|---|
| 点「确定」 | resolve(按钮的 value) | 浏览器（`form method=dialog`） |
| 点「取消」 | resolve(按钮的 value) | 浏览器 |
| Esc | resolve(`''`) | 自己拦（只关最上面那个） |
| 点遮罩空白处 | resolve(`''`) | 自己判（点击坐标是否落在 dialog 矩形外） |
| 回车 | 触发 `submitIndex` 指定的按钮（默认第一个） | 自己拦（焦点不在按钮/输入框上时） |
| 回车（焦点在输入框里） | 单行 = 提交；多行 = 换行（Ctrl/Cmd+Enter 才提交） | 自己拦 |
| Tab / Shift+Tab | 焦点锁在弹窗内循环 | 浏览器 |
| 关闭后焦点 | 自动回到打开前的元素 | 浏览器 |
| 模态期间底层页面 | inert —— 不可点击、不可聚焦 | 浏览器 |

★ **点 dialog 的 padding / 滚动条不会误关** —— 用点击坐标是否落在
dialog 矩形外来判断，不是简单看 `e.target`。
★ **回车在按钮上时不重复触发** —— 焦点在 `<button>` 上时交还给浏览器处理，
否则会触发两次（按钮的 click + 键盘处理）。
★ **危险操作的默认焦点在「取消」上** —— 打开时回车不会误触发危险动作。
★ **焦点会还给打开前的位置** —— 关闭后回到之前聚焦的元素。
★ **可以叠层** —— 只有最上面那个弹窗响应 Esc 和遮罩点击。

> 原生行为是「一次 Esc 把所有叠着的 `dialog` 全关掉」，
> 所以这里自己拦了一层 `keydown` + `preventDefault`，只关最上面那个。
> （用 `keydown` 而不是 `cancel` 事件 —— 实测 `cancel` 不可取消，`cancelable=false`。）

## 无障碍

- 标题挂唯一 `id`，`<dialog>` 上设 `aria-labelledby` 指向它
- 进度框是 `role="progressbar"`，带 `aria-valuemin` / `aria-valuemax` / `aria-valuenow`
- 轻提示容器和加载框是 `role="status"`（屏幕阅读器会播报）

## 样式

组件自己注入 `<style id="dlg-component-style">`，用的 class：

```
dialog.dlg     弹窗本体（就是 <dialog> 元素本身）
dialog.dlg::backdrop   遮罩（原生提供，不用自己造遮罩 div）
dialog.dlg.dlg-narrow  窄版弹窗（280px，纯确认类用）
.dlg-form      内部 <form method="dialog">
.dlg-title     标题
.dlg-msg       正文
.dlg-input     输入框（prompt 用）
.dlg-err       校验错误提示
.dlg-actions   按钮行（右对齐）
.dlg-btn       按钮
.dlg-btn.primary  主按钮（强调色）
.dlg-btn.danger   危险按钮（红色）
.dlg-tips      轻提示容器（底部居中，多条竖着叠）
.dlg-tip       单条轻提示
.dlg-tip.success / .dlg-tip.error  绿 / 红边框
.dlg-overlay-mask  遮罩层（全屏，盖住交互）—— loading / progress 共用
.dlg-loading   加载框（转圈 + 文字）
.dlg-spinner   转圈
.dlg-progress  进度框
.dlg-progress-bar / -bar-fill    横向进度条 / 填充
.dlg-progress-circle             环形（SVG）
.dlg-progress-dots / -dot        三点跳动 / 单个点
.dlg-progress-steps / -step      分段步骤条 / 单段
.dlg-progress-msg / -pct         标题 / 百分比
```

颜色全部走 CSS 变量，**带回退值**：

| 变量 | 回退值 | 用途 |
|---|---|---|
| `--bg-2` | `#1e2027` | 弹窗背景 |
| `--bg-3` | `#262931` | 按钮背景 |
| `--ink` | `#e6e6e6` | 文字 |
| `--muted` | `#8a8a94` | 次要文字 |
| `--rule` | `#33363f` | 边框 |
| `--lime` | `#c4f542` | 主按钮强调色 |
| `--red` | `#ff4d4d` | 危险按钮 |

宿主页面只要定义了这几个 `:root` 变量，弹窗就自动跟随主题
（monaco 工具的深色主题、root 主页的浅色主题都能直接用）。

## 已知边界

- 弹窗本身没有动画（保持简单，避免 transition 引起的时序问题）—— **只有轻提示有淡入淡出**
- 输入框只有单行/多行两种形态 —— 复杂的表单用 `content` 传自定义 DOM
- 不做焦点以外的 trap（背景内容仍可被程序滚动）
- `Dialog.create` 里 `value: ''` 的按钮和 Esc 关闭**都 resolve `''`** —— 分不清就用非空 value

## 参见

- `cgi/tool/monaco/dist/app.js` 里的 `bindDlgKeys()` —— 同一套行为的**手写版**
  （monaco 的弹窗是静态 HTML + 手写绑定，没有抽成组件）
- `cgi/dist/js/index.html` —— 工具目录页
