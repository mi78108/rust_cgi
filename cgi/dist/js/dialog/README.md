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

最常用的是两个静态方法，都返回 Promise。

```js
// 确认框 → Promise<boolean>
const yes = await Dialog.confirm('清空文档？', { danger: true });
if (yes) { /* ... */ }

// 提示框（只有一个按钮）→ Promise<void>
await Dialog.alert('已保存。');
```

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
| 回车 | 等同「确定」 |
| Tab / Shift+Tab | 焦点锁在弹窗内循环 |

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

- 没有动画（保持简单，避免 transition 引起的时序问题）
- 没有输入框组件 —— 需要输入框时用 `content` 传自定义 DOM
- 不做焦点以外的 trap（背景内容仍可被程序滚动）

## 参见

- `cgi/tool/monaco/dist/app.js` 里的 `bindDlgKeys()` —— 同一套行为的**手写版**
  （monaco 的弹窗是静态 HTML + 手写绑定，没有抽成组件）
- `cgi/dist/js/index.html` —— 工具目录页
