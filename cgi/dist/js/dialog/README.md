# dialog — 通用弹窗组件

零依赖的纯前端弹窗（modal dialog）。自己注入样式，不依赖宿主页面的 CSS；
颜色走 CSS 变量，宿主页面定义了 `:root` 变量就跟随宿主主题。

## 引入

普通 `<script>` 标签（挂全局 `window.Dialog`）：

```html
<script src="/pub/js/dialog/dialog.js"></script>
```

ES module：

```js
import { Dialog } from '/pub/js/dialog/dialog.js';
```

> 路径里的 `/pub/` 是静态服务器入口（`cgi/pub`，`PUB_ROOT` 默认 `dist`）。
> 直接写 `/dist/js/...` **不通** —— 没有对应的 CGI 脚本，连接会被直接关掉。

## 快捷方法

三个返回 Promise 的静态方法 + 轻提示 + 加载遮罩 + 进度框。

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

### 输入框

`Dialog.prompt` 带一个输入框，确定时 resolve **输入的内容**，取消时 resolve `null`。

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

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `value` | string | `''` | 输入框初始值 |
| `placeholder` | string | `''` | 占位提示 |
| `inputType` | string | `'text'` | input 的 `type`（text / password / email …） |
| `multiline` | boolean | `false` | 多行（textarea）—— Ctrl/Cmd+Enter 提交 |
| `validate` | Function | `null` | `(value, dialog) => string \| undefined` —— 返回错误文案则**不关闭**并显示提示，焦点回到输入框 |

★ 有初始值时它会被**全选** —— 直接打字就能覆盖。
★ 输入框存在时**焦点落在输入框上**（不用先按 Tab）。

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

## 完整用法

```js
const dlg = new Dialog({
  title: '修改名字',
  message: '这个名字会显示给同房间的人。',
  okText: '确定',
  cancelText: '取消',
  danger: false,      // true → 主按钮变红，且默认焦点在「取消」
  okValue: 'ok',      // 确定时 resolve 的值
});

const result = await dlg.open();   // 确定 → 'ok'，取消 → null
```

`open()` 返回 Promise：点「确定」resolve `okValue`，点「取消」/Esc/遮罩 resolve `null`。

## 选项

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `title` | string | `''` | 标题（`textContent`，不解析 HTML） |
| `message` | string | `''` | 正文（`textContent`） |
| `content` | Node \| string | `null` | 自定义正文，**优先于** `message`。字符串会被当 HTML 解析 —— 只放可信内容 |
| `okText` | string | `'确定'` | 主按钮文字 |
| `cancelText` | string | `'取消'` | 取消按钮文字 |
| `danger` | boolean | `false` | 危险操作：主按钮变红，**默认焦点在「取消」上** |
| `hideCancel` | boolean | `false` | 隐藏取消按钮（只剩一个按钮时用） |
| `okValue` | any | `'ok'` | 确定时 resolve 的值 |
| `input` | boolean \| Object | `false` | 输入框。`true` 或 `{type,value,placeholder,multiline}`。有输入框时确定时 resolve 的是**输入框的值**（不是 `okValue`） |
| `maskClass` | string | `'dlg-mask'` | 遮罩层的 class |
| `onOk` | Function | `null` | 确定前的钩子，**返回 `false` 则不关闭** |
| `onCancel` | Function | `null` | 取消时的钩子 |

## 行为

| 操作 | 结果 |
|---|---|
| 点「确定」 | resolve(`okValue`) |
| 点「取消」 | resolve(`null`) |
| Esc | resolve(`null`) |
| 点遮罩空白处 | resolve(`null`) |
| 回车 | 等同「确定」（焦点在输入框里时 = 提交输入框） |
| Tab / Shift+Tab | 焦点锁在弹窗内循环 |

★ **输入框里回车 = 提交**；多行（textarea）里普通回车是换行，**Ctrl/Cmd+Enter** 才提交。
★ **焦点在输入框上**（有输入框时）—— 打开就能直接打字。
★ **有初始值时全选** —— 直接打字就能覆盖。

★ **危险操作的默认焦点在「取消」上** —— 打开时回车不会误触发危险动作。
（这是 monaco 工具踩过的坑：clear 弹窗打开时若焦点在「确定」上，回车会直接清空。）

★ **回车在按钮上时不重复触发** —— 焦点在 `<button>` 上时交还给浏览器处理，
否则会触发两次（按钮的 click + 键盘处理）。

★ **焦点会还给打开前的位置** —— 关闭后回到之前聚焦的元素。

★ **可以叠层** —— 只有最上面那个弹窗响应 Esc 和遮罩点击。

## 样式

组件自己注入 `<style id="dlg-component-style">`，用的 class：

```
.dlg-mask      遮罩层（fixed, 全屏, 半透明黑）
.dlg           弹窗本体
.dlg-title     标题
.dlg-msg       正文
.dlg-input      输入框（prompt 用）
.dlg-err        校验错误提示
.dlg-tips      轻提示容器（底部居中，多条竖着叠）
.dlg-tip       单条轻提示
.dlg-overlay-mask  遮罩层（全屏，盖住交互）—— loading / progress 共用
.dlg-loading   加载框（转圈 + 文字）
.dlg-spinner   转圈
.dlg-progress  进度框
.dlg-progress-bar / -bar-fill   横向进度条 / 填充
.dlg-progress-circle            环形（SVG）
.dlg-progress-dots / -dot       三点跳动 / 单个点
.dlg-progress-steps / -step     分段步骤条 / 单段
.dlg-progress-msg / -pct        标题 / 百分比
.dlg-actions   按钮行（右对齐）
.dlg-btn       按钮
.dlg-btn.primary  主按钮（强调色）
.dlg-btn.danger   危险按钮（红色）
.dlg-narrow    窄版弹窗（280px，纯确认类用）
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

## 参见

- `cgi/tool/monaco/dist/app.js` 里的 `bindDlgKeys()` —— 同一套行为的**手写版**
  （monaco 的弹窗是静态 HTML + 手写绑定，没有抽成组件）
- `cgi/dist/js/index.html` —— 工具目录页
