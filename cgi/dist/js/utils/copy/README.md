# copy — 复制到剪贴板

`utils` 的子模块。零依赖的纯前端剪贴板工具。

给「快速使用」代码块加一个复制按钮 —— 页面上放好 `.quick` 卡片和
`button[data-copy]`，脚本加载后自动生效。

## 引入

```html
<script src="/pub/js/utils/copy/copy.js"></script>
```

用插件加载器：

```js
const c = await Plugin.load('utils.copy');
```

> 加载后同时挂在 `window.Copy` 和 `window.Utils.copy` 上。

## 用法

页面里放一个「快速使用」卡片 —— **复制按钮的文案和位置自己写**，
脚本只负责把 `button[data-copy]` 绑上行为：

```html
<script src="/pub/js/utils/copy/copy.js"></script>

<div class="quick">
  <div class="quick-head">
    <span class="qt">快速使用</span>
    <span>引入即用，全局变量 <code>Dialog</code></span>
    <button class="copy qs" data-copy>复制</button>
  </div>
  <pre><code>&lt;script src="/pub/js/dialog/dialog.js"&gt;&lt;/script&gt;</code></pre>
</div>
```

★ 复制的是**渲染后的代码文本**（`code.textContent`），不含 HTML 转义 ——
所以 `<script>` 在 `<pre>` 里写成 `&lt;script&gt;` 也没关系。

## API

| 方法 | 返回 | 说明 |
|---|---|---|
| `Copy.bind(root?)` | number | 给 `root`（默认整个文档）下所有 `button[data-copy]` 绑定复制行为，返回绑定的按钮数 |
| `Copy.copyText(text)` | `Promise<{ok, reason?}>` | 复制文本到剪贴板 |
| `Copy.selectCode(codeEl)` | boolean | 把代码块内容选中 |

### copyText

```js
const r = await Utils.copy.copyText('要复制的文本');
if (r.ok) {
  console.log('复制成功');
} else {
  console.warn('失败：' + r.reason);   // 具体原因
}
```

★ **永远返回 Promise** —— 安全上下文走 `navigator.clipboard`（本来就是 Promise），
非安全上下文走 `execCommand` 兜底（同步返回）。两条路必须统一成 Promise，
否则调用方 `.then()` 会在兜底路径上炸掉。

### bind

一般不用手动调 —— 脚本加载后会自动绑整个文档。

```js
Utils.copy.bind();            // 整个文档
Utils.copy.bind(someRoot);    // 只绑某个容器
```

★ **幂等** —— 同一个按钮不会绑两次（按钮上打了 `__copyBound` 标记），
所以重复调用安全。

## 行为

| 情况 | 结果 |
|---|---|
| 脚本加载 | 自动给页面上所有 `button[data-copy]` 绑行为 |
| `https` 或 `localhost` | 走 `navigator.clipboard` |
| `http` + IP 访问 | clipboard API 不可用 → 自动退回 `execCommand('copy')` |
| 两条路都失败 | 把代码**选中**，按钮文案变成「已选中，按 Ctrl+C」，具体原因挂在按钮 `title` 上 |
| 点按钮后 | 文案变「已复制」（绿）或「已选中，按 Ctrl+C」（红），2.6 秒后自动恢复 |

★ **剪贴板不可用时不是只报「复制失败」** —— 而是把代码选中，
用户按 Ctrl+C 就能复制。（http + IP 访问是最常见的触发场景。）

## 样式

组件自己注入 `<style id="js-copy-style">`，用的 class：

```
.quick                    「快速使用」代码块卡片
.quick-head               卡片头部（标题 + 右侧复制按钮）
.quick-head .qt           头部标题
.quick-head .qs           头部右侧（复制按钮靠它推到右边）
.quick pre / pre code     代码块
.quick button.copy        复制按钮
.quick button.copy.ok     复制成功（绿）
.quick button.copy.err    复制失败（红）
```

颜色全部走 CSS 变量，**带回退值**：

| 变量 | 回退值 | 用途 |
|---|---|---|
| `--rule` | `#33363f` | 边框 |
| `--bg` | `#f4f1de` | 卡片底色 |
| `--bg-3` | `#e3e0c9` | 头部底色 |
| `--ink` | `#0f0f12` | 文字 |
| `--muted` | `#5a5a64` | 次要文字 |
| `--lime` | `#c4f542` | 成功 |
| `--red` | `#ff4d4d` | 失败 |

## 参见

- `cgi/dist/js/utils/` — 工具集总览
- `cgi/dist/js/utils/datetime/` — 另一个子模块
- `cgi/tool/monaco/dist/app.js` 里的 `copyCurrent()` — 同一套剪贴板逻辑的手写版
