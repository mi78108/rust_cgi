# monaco 协同编辑器 — monaco-editor + 自实现 RGA

跟 `tool/pad` 同一套 CRDT + 服务器权威架构，只是**编辑器换成 monaco**。

**为什么单独一个 tool**：pad 的 textarea 方案是稳定的，monaco 还在验证阶段 ——
分开做，互不影响。

## 架构

```
浏览器 A ─┐                      ┌─ 服务器 (ruby, 每连接一进程)
浏览器 B ─┼─ ws /tool/monaco/ws ─►│  · 持有文档 op log（文件）
          │                      │  · 持有成员表（文件 + 广播通知）
          └──────────────────────┘
```

跟 pad 完全一样：服务器持有权威状态，客户端只做 RGA 合并。

```
cgi/tool/monaco/
├── index -> ../../pub    (软连接，静态页面走 pub)
├── ws                    (服务端，仿 pad/ws)
└── dist/
    ├── index.html        (页面壳 + monaco 加载)
    ├── app.js            (monaco 集成)
    ├── crdt.js           (从 pad 复制 —— 自实现 RGA)
    ├── sync.js           (从 pad 复制 —— WS 网络层)
    ├── style.css
    └── vendor/vs/        (monaco-editor npm 包的 min 目录，已本地化)
```

**crdt.js / sync.js 是从 pad 复制的**，不是共享引用 —— 每个 tool 自包含，
改一个不影响另一个。

## ★ 核心收益：偏移量天然对齐

monaco 的 `IModelContentChange` 直接给**扁平字符偏移**，跟 RGA 的位置单位一致：

| | pad（textarea） | monaco |
|---|---|---|
| 拿到改动位置 | `beforeinput` 快照 + `diffText` **猜**公共前后缀 | `c.rangeOffset` **直接给** |
| 位置单位 | `ta.selectionStart` = UTF-16 code unit | `rangeOffset` = UTF-16 code unit |
| RGA 侧单位 | `anchorAt(pos)` = UTF-16 code unit | 同左 —— **无需换算** |
| 远端应用 | `ta.value = after`（整篇替换） | `model.setValue(after)` |
| 远端光标 | mirror 量像素（要处理滚动同步 + 代理对） | monaco decorations（原生支持） |

**EOL 必须统一 LF** —— monaco 的 offset 按「文本自身的 EOL」计算。
model 用 `\r\n` 时每个换行占 2 个 unit，恰好跟 JS 字符串一致，但为了跟
服务器 log / 其它客户端完全一致，强制 `model.setEOL(EndOfLineSequence.LF)`。

### `rangeOffset` 的精确语义（查 monaco 0.52.2 源码确认）

- 内部帧 `[len u32][src 8B][dst 8B][payload]` → 下行 `[len u32][src 8B][payload]`
- `rangeOffset` = 整个文档的**扁平字符偏移**（`getOffsetAt(line, col)`）
- `rangeLength` = 被替换的长度（`getValueLengthInRange(range)`）
- **多个 change 时，每个的 `rangeOffset` 都相对「改动前」的文档**，互不影响
  （monaco 内部按降序应用）→ 可以直接逐个生成 op，不用做偏移修正
- 重叠的改动 monaco 会**合并成一个 change** → 拿到的 changes 元素不重叠

## op 格式（跟 pad 完全一样）

```json
{ "t": "i", "id": ["c1", 3], "v": "A", "l": ["c1", 2] }
{ "t": "d", "id": ["c1", 5] }
```

RGA 逐字符模型，一个字符一个 op。删除用墓碑（`tomb: true`）不真删。

## 多文档（doc）

`/tool/monaco?doc=xxx` —— 不同 doc 完全独立：
- 独立的 op log：`$SPIDER_DATA/monaco/<docId>/ops.log`
- 独立的成员表：`$SPIDER_DATA/monaco/<docId>/members/`
- 独立的 BDR 频道：`monaco-<docId>`

**doc id 严格校验**（它会拼进文件路径和频道名）：
```ruby
DOC_ID_RE = /\A[A-Za-z0-9_-]{1,64}\z/
```
放开的话 `?doc=../../etc` 能目录穿越。非法 / 没给 → 退回 `default`。

## monaco 本地化（不走 CDN）

`dist/vendor/vs/` 是 npm 包 `monaco-editor@0.52.2` 的 `min/` 目录：
```
loader.js          AMD loader
editor/            editor.main.js (3.6MB) + editor.main.css
basic-languages/   含 markdown
base/worker/       workerMain.js
```

### ★ 三个必须踩过的坑

**① 路径必须用绝对路径**

页面经 `index → pub` 软连接提供，但浏览器解析相对路径时用 URL 里的
`/tool/monaco/`，而 pub 是从 `/tool/` 派发的 —— 相对路径会解析成
`/tool/vendor/...`（**少一级**）→ 404。

所以 index.html / app.js 里的路径全部用绝对路径 `/tool/monaco/...`。
（pad 也用绝对路径，原因相同。）

**② `MonacoEnvironment` 和 `require.config` 必须在 `editor.main.js` 之前**

- `window.require.config({paths:{vs: '/tool/monaco/vendor/vs'}})` ——
  AMD loader 用它拼模块 URL 和 worker URL
- `window.MonacoEnvironment = { getWorkerUrl: () => '/tool/monaco/vendor/vs/base/worker/workerMain.js' }`

设在 `editor.main.js` **之后**太晚 —— monaco 在模块求值时就把
`globalThis.MonacoEnvironment` 缓存住了，worker 路径会按错的 base 算成
`/vs/base/worker/workerMain.js` → worker 加载失败 → monaco 退回主线程
（"Could not create web worker" 警告，大文档时 UI 卡顿）。

**③ monaco API 的命名空间 / 方法归属**

| API | 正确位置 | 踩过的坑 |
|---|---|---|
| `EndOfLineSequence` | `monaco.editor.EndOfLineSequence` | 顶层是 undefined → 取 `.LF` 抛 TypeError |
| `onDidChangeCursorPosition` | **editor 实例**方法 | 写成 `monaco.editor.xxx` → undefined → TypeError |
| `onDidChangeCursorSelection` | **editor 实例**方法 | 同上 |
| `createDecorationsCollection` | **editor 实例**方法 | 同上 |
| `getOffsetAt` | 收 **Position 对象** | 传 `(line, col)` 两个数字 → **静默返回 0**（不报错！） |
| `getPositionAt` | 收 **数字** | 正常 |
| `Range` | 顶层 `monaco.Range` | 正常 |

`getOffsetAt` 那个最阴险 —— 传错参数不报错，只是永远返回 0，
表现为「远端光标永远在文档开头」。

**④ 远端光标的名字标签用 content widget（不是 decoration）**

decoration 在**文字流**里 —— 标签会撑开行宽，把后面的字挤走。
content widget 是独立浮层，不影响排版，还能原生跟随滚动/换行。

| 要点 | 说明 |
|---|---|
| descriptor 要**每次给同一个对象** | monaco 靠对象身份认它，`layoutContentWidget(widget)` 要传同一引用 |
| `getPosition()` 里**现算**位置 | 存 cursor 偏移，用 `model.getPositionAt(off)` 换算。别闭包捕获 position —— 文档变了位置就过期，而远端 op 到达时不会重跑 `renderPeers` |
| **两层 DOM** | monaco 在 layout 时会**直接改写** widget DOM 的 `style.display`，所以显隐/样式放**内层** `.peer-label`，外层 `.peer-label-outer` 交给 monaco |
| 标签**常驻显示** | 不做 hover 才显示 —— 一眼就要看出那根光标是谁的 |
| `pointer-events:none` | 浮层不能挡住鼠标，否则用户选词/点击受影响 |

★ **标签会盖住相邻行的文字** —— 行高 19px / 字号 14px，没有空隙放标签：

```
# 标题行      ← y=93
[标签]第二行文字  ← 标签 y=112，正好压在这一行的字上
第三行文字      ← y=131
```

`preference: [ABOVE, BELOW]` 里 ABOVE 排在前面，但 monaco 实际会挑
「不与当前行字形区冲突」的那个，**实测落在 BELOW**（盖住下一行）。
这是已知取舍（用户确认接受）。

**⑤ 弹窗不用原生 prompt()/confirm()**

原生 `prompt()` / `confirm()` 太难看，且样式不可控（跟页面风格完全不搭）。
改成统一的弹窗壳子 —— 同一套 `.dlg-mask` + `.dlg` 结构，两种用途：

| 弹窗 | id | 用途 |
|---|---|---|
| 名字/颜色 | `#dlg-profile` | 名字输入框 + `<input type="color">` 取色器 + hex 文本框（**双向联动**）+ 12 个预设色板 |
| 清空确认 | `#dlg-clear` | 纯确认，`280px` 窄版，说明文字 + 取消/清空（红色 danger 按钮） |

公共行为抽成 `bindDlgKeys(dlg, onOk, onCancel)`：

- Esc → 取消
- 回车 → 提交（`onOk` 为 null 则不响应）
- 点遮罩空白处 → 取消

★ **危险操作的默认焦点放在「取消」上** —— clear 弹窗打开时
`document.activeElement` 是 `#dlg-clear-cancel`，回车不会误触发清空。

★ **别在两处弹同一个 toast** —— clear 按钮提交后不弹 toast，
等服务端回 `clear` 时 `onClear` 弹 `'cleared'`，否则后者立刻覆盖前者。

`myName` / `myColor` 提到**模块级** —— 弹窗提交改的是这两个，
之后 `reconnect()` 也要沿用新值，不能每次从 localStorage 重读。

### ★ `anchorAt()` 和 `offsetOfNode()` 不是逆运算 —— 远端光标会偏左一个字符

光标位置用 **CRDT anchor**（节点 id）表示是对的 —— 别人在你前面插字符，
你的 anchor 仍指向同一个字符，位置自动跟着走。

**但两个函数的语义不对称**：

```
anchorAt(pos)        返回「光标【前面】那个字符」的节点 id
                     → 光标是紧跟在那个字符【后面】的

offsetOfNode(id)     返回那个字符的【起始】偏移（字符自己占的那一格）
                     → 比光标位置【小一个字符】
```

所以 `offsetOfNode(anchorAt(pos))` = `pos - 1` → **远端光标偏左一个字符**。

**实测**（"ABCDE\nFGHIJ"，光标 offset 8）：

| pos | anchorAt(pos) | offsetOfNode | cursorOffsetOfNode |
|---|---|---|---|
| 1 | `["c1",0]` | 0 ❌ | **1** ✅ |
| 3 | `["c1",2]` | 2 ❌ | **3** ✅ |
| 6 | `["c1",5]` | 5 ❌ | **6** ✅ |
| 8 | `["c1",7]` | 7 ❌ | **8** ✅ |
| 11 | `["c1",10]` | 10 ❌ | **11** ✅ |
| 0 | `["ROOT",0]` | -1 ❌ | **0** ✅ |

**修法**：新增 `cursorOffsetOfNode(nodeId)` —— 返回「那个字符**之后**」的偏移，
这才是 `anchorAt` 的真正逆运算。`offsetOfNode` 保留（它对「某个字符在哪」的
其它用途仍然正确）。

**判据**：任何「A → B」和「B → A」成对出现的函数，都要单独验证它们是不是
真互逆 —— 名字相似不代表语义对称。

### ★ decoration 的像素偏移（跟上面无关，是另一回事）

`beforeContentClassName` 插入的元素位于**字符的左边缘**，实测比 monaco
自己的光标（`.cursor`，宽 2px）**偏右 1px**：

| 位置 | 原始 diff | 加 `margin-left:-1px` 后 |
|---|---|---|
| 行中 | +1px | **0** ✅ |
| 行尾 | +1px | **0** ✅ |
| 行首 | 0 | -1px（1px 误差，可接受） |

`margin-left:-1px` 是**对的** —— 它把 2px 宽的光标条居中到 2px 宽的
`.cursor` 上。行首差 1px 是因为行首没有前一个字符。

**不要用 `inlineClassName`** —— 实测它在**行尾会跑到前一行**（diff -20px），
因为零宽 range 的 inline decoration 锚定到前一个字符的结束位置。

## 文件操作：打开 / 下载 / 复制

三个按钮在 header 里（`#btn-open` / `#btn-download` / `#btn-copy`）。

### 打开（本地文件 → **替换当前 doc**）

```
浏览器 <input type="file"> → file.text() → WS {t:'seed', filename, content}
  → 服务端**覆盖**当前 doc 的 op log → 广播 {t:'replace'}
  → 所有客户端：重建 Doc + 重新 sync → 页面**不跳转**
```

**就是「在当前空间打开这个文件」** —— 不新建 doc、不跳转，
当前 doc 的内容被整个替换（别人正在编辑的内容也会没，所以有确认弹窗）。

**为什么内容不进 CRDT op**：op 是逐字符的，一个 10KB 文件 = 10000 个 op，
一帧 WS 发 10000 个 JSON op 会超大。服务端直接覆盖写 op log 更省事
（新客户端 sync 一次拿全量）。

**服务端要覆盖而不是「删光 + 追加」**：删光是 N 个 delete op + N 个 insert op，
日志会**永久增长**（反复打开几次就是几倍大，每个客户端都要重放全部）。
覆盖写 = 日志永远只有当前内容那么大。

**seed 的 op 是链式的**（`l` 指向前一个字符的 id）—— RGA 同层节点按 id
**逆序**排，如果全锚在 ROOT 就是兄弟节点 → 顺序全乱。

大小上限 `MAX_SEED_BYTES = 2MB`，超了回 `seed-error`。

### 🔴🔴 覆盖 op log 的三个坑（每个都难查）

**① `log_lock` 是缓存的句柄，`rename` 换 inode 后它写进孤儿文件**

```ruby
def log_lock
  @log_lock ||= File.open($ops_log, File::WRONLY | File::CREAT | File::APPEND)
end
```

`replace_ops_log` 用 `File.rename(tmp, path)` 替换文件 —— rename 换的是
**inode**，旧 inode 上还挂着 `log_lock`。于是后续 `append_op` 写进的是
**已被 unlink 的孤儿文件** —— 磁盘上看不到，日志里也没有 append 记录。

> **症状极隐蔽**：文件内容是对的（新 seed 的内容），但之后**所有编辑都消失**。
> 排查时看到「文件在、内容对，但 append 没记录」就该想到这个。

**修法**：`reset_log_lock` —— 关掉旧句柄，`@log_lock = nil`，
下次 `log_lock` 重新打开。

**② `@op_seen` 是进程级缓存，覆盖后必须失效**

每个 WS 连接一个 ruby 进程，各有各的 `@op_seen`。
覆盖 op log 后，缓存里还是旧 op 的 id。

**修法**：`invalidate_op_seen`（`@op_seen = nil`），下次重新从文件加载。

★ **不能写 `@op_seen = {}`** —— 那会让缓存变空，**旧的 op id 就忘了** →
重复的 op 会被再追加一次。缓存的语义应该是「文件里现在有什么」，
所以是**失效**（nil）而不是**清空**（{}）。

**③ 客户端的 `seq` 不能重置**

`resetDoc()` 原来有 `seq = 0` —— **错**。
seq 是 CRDT 身份的组成部分，必须在同一 clientId 内单调递增。
重置它 → 新 op 的 id 撞上旧 id（如新旧都是 `[A,0]`）→
`crdt.js` 的 `applyInsert` 看到 id 已存在就**静默丢弃**新 op →
「打了字但文档不变」。

`seq` 只在**重连**时重置（`onOpen`）—— 那时 cid 也换了，是新身份。

### 下载

纯前端：`model.getValue()` → Blob → `a.download = '<docId><ext>'`。
带 **UTF-8 BOM**（Windows 记事本不认 BOM 会乱码）。

★ **扩展名跟着当前语言走**（`extForLang()`）—— 文档按 python 模式编辑，
下载成 `.md` 就名不副实。

⚠️ `LANG_EXT` 手写表是必要的：monaco 的 `extensions[0]` **不一定是常用那个**
—— typescript 的 `extensions[0]` 是 `.cts`（罕见），javascript 是 `.es6`。

### 复制

纯前端：`navigator.clipboard.writeText()`。

★ **需要安全上下文**（https 或 localhost）。通过 IP 访问
（`http://192.168.1.5:3000`）时 clipboard API 不可用 → 退回
`document.execCommand('copy')`（隐藏 textarea）。

★ 两条路都失败时 toast 显示**具体原因**（`clipboard api: NotAllowedError`），
不要笼统报 "copy failed" —— 用户要能自己判断是不是浏览器权限问题。

### ⚠️ `model.setValue()` 是整篇替换

`setValue` 触发的 change 是 `{rangeOffset: 0, rangeLength: 全文长}` ——
所以**一次 setValue = N 个删除 op + N+1 个插入 op**。

- **真实用户打字**不受影响（monaco 给增量 change）
- **远端 op 应用**走 `model.setValue(after)`，但被 `applyingRemote` 标志挡住，
  不会回环发 op（实测 opsLocal 计数会停住不涨）

## 语言选择（状态栏「doc:」左边）

一个 `<select id="lang">`，把**整个文档**按某种语言解析。

### 选项从 monaco 动态来，不手维护

```js
monaco.languages.getLanguages()   // 91 个 id
```

★ **过滤掉 id 带 `.` 的**（`freemarker2.tag-angle.interpolation-dollar` 等 6 个）
—— 那是 monaco 的**内部方言**，名字又长又没意义，还会把下拉框撑到 213px。
过滤后 85 个，宽度降到 129px。

★ 显示名用 `aliases` 推：先找「短大写缩写」（JSON / SQL / WGSL / C#），
再找「首字母大写」的（Python / Rust）—— 别直接用 `aliases[0]`，
有些语言的第一个 alias 是小写 id。

### 切语言 = `monaco.editor.setModelLanguage(model, langId)`

★ 这是**本地视图状态**，不进 CRDT —— 不同客户端可以各自选不同语言，
文档内容始终是同一份文本。

★ 切到非 markdown 后，文档里的 ``` 代码围栏**不再按内嵌语言高亮**
（整篇按新语言解析）—— 预期行为。

⚠️ **判断「要不要切」要用 `model.getLanguageId()`，不要用模块级变量** ——
module 变量会跟 model 脱节（换 model / monaco 内部重置），
导致「切回 markdown」被误判成「已经是 markdown」而跳过。

### 打开本地文件时按扩展名自动切

```js
langFromFilename('a.py')   // → 'python'
```

用 monaco 自带的 `extensions` 数组做「扩展名 → 语言 id」表。

⚠️ **猜不到就保持原样**（不切回 markdown）—— 用户手选过的语言
不该被一次「打开 .txt」冲掉。

### 能力边界（对外承诺按这个说）

| 能力 | 支持范围 |
|---|---|
| 语法高亮 | 85 种全支持（monarch 定义在 `basic-languages/`） |
| 补全 / 跳转 / 类型检查 | **只有** TS / JS / JSON / CSS / HTML 五种 |

实测：切到 TypeScript → `Type 'string' is not assignable to type 'number'.` ✅
切到 Rust → 0 条 diagnostic（Rust 无语言服务，只有高亮）✅

### 视觉

- 高度锁 **20px**（状态栏文字是 18px）—— 更高会在那一行里凸出来
- 边框 `1px solid var(--rule)` —— 跟 header 按钮、状态灯同一个变量
- 垂直居中跟 `doc:` / `you:` 对齐（实测中心 y 都是 83）
- 自绘下拉箭头（`appearance:none` + 两个 `linear-gradient`）—— 保持直角风格

## 连接控制：状态 pill + reconnect 合并，加 refresh

header 右边三个东西：

| 元素 | id | 行为 |
|---|---|---|
| `refresh` 按钮 | `#btn-refresh` | 发 `{t:'sync'}` → 服务端重发全量 op（**不重连 WS**） |
| 状态按钮 | `#btn-conn` | 显示连接状态，**点击即重连** |

★ **状态和 reconnect 合并成一个按钮** —— 少一个按钮，header 不挤。
状态色有语义（绿=connected / 红=disconnected / 青=connecting），
所以 hover **不能**走 lime（其它 header 按钮的 hover 色）——
`header>button:not(.pill):hover` 排除了 pill，pill 只提亮不改语义色。

★ **高度锁 30px** —— `.pill` 默认只有 23px（padding 3px + 11px 字号），
跟同排 30px 的其它按钮不齐会矮一截。用 `inline-flex` + `align-items:center` 居中。

### 🔴🔴🔴 `disconnect(); connect();` 会建出**两条** WebSocket

**实测**：点一次 reconnect，`wsCreated = 2`。

**根因**（异步竞态）：

```
disconnect()  →  ws.close()  →  closedByUser = true
connect()     →  closedByUser = false        ← 立刻重置
               →  _open()  →  建 WS#2
（这时 WS#1 的 close 事件才异步触发）
WS#1 close 回调 → 看到 closedByUser == false → 又排一个自动重连 → 建 WS#3
```

**两条连接同时存在 = 同一个文档两个成员身份 + op 发两遍 + 远端光标出现两个「我」**。

**修法**：`Sync.reconnect()` 单独一个方法 ——

1. `_generation` 序号 +1，本次连接拿到「身份证」
2. `closedByUser = true`，取消自动重连定时器
3. 关旧连接，等它**真的** close（close 事件是异步的）→ 再 `_open()`
4. `_open()` 里所有事件回调都带 `isStale()` 检查 —— 过期连接直接作废
5. 兜底：旧连接万一不发 close（还在 CONNECTING）→ 200ms 后照样开

```js
reconnect() {
  this._generation = (this._generation || 0) + 1;
  const gen = this._generation;
  if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = 0; }
  this.closedByUser = true;
  const old = this.ws;
  this.ws = null;
  this.connected = false;
  if (old) {
    try { old.close(); } catch (_) {}
    old.addEventListener('close', () => {
      if (this._generation !== gen) return;
      this.closedByUser = false;
      this._open();
    }, { once: true });
    setTimeout(() => {
      if (this._generation !== gen) return;
      if (this.ws) return;
      this.closedByUser = false;
      this._open();
    }, 200);
    return;
  }
  this.closedByUser = false;
  this._open();
}
```

**判据**：点一次重连，`wsCreated` 必须**恰好是 1**。用拦截 `WebSocket`
构造器来数：

```js
const OrigWS = window.WebSocket;
const created = [];
window.WebSocket = function(...a) { const w = new OrigWS(...a); created.push(w); return w; };
// ... 点重连，等 3 秒 ...
window.WebSocket = OrigWS;
// created.length === 1  ✅
```

### refresh 的语义

`sync.requestSync()` → 服务端回 `{t:'ops', ops:[...], total:N}` →
`applyFullOps()` **替换**本地 Doc。

★ **断线时也能点** —— `sync.js` 的 `_send()` 在未连接时把消息攒进
`this.pending`，重连后自动补发（不丢）。

**实测**（严格测法：直接改服务端的 op log 文件，再点 refresh）：

```
服务端 op log = 'SERVER-SIDE-CONTENT'  →  页面显示 SERVER-SIDE-CONTENT
服务端 op log = 'FRESH-FROM-SERVER'   →  点 refresh
页面变成 FRESH-FROM-SERVER, opsGlobal 17, opsLocal 0, 连接没断  ✅
```

⚠️ **别用 `model.setValue()` 造测试数据** —— 它会触发 change 事件，
把脏内容**真的发到服务端**（实测 opsLocal 涨了 111）。要测「服务端改了
客户端没同步」，正确做法是**改服务端的 op log 文件**。

## 已知不足

- **远端 op 用整篇 `model.setValue(after)`** —— 简单稳，但丢 undo 栈，
  光标按比例恢复（远端改动改变长度时会偏）。要做到精确增量得按 op 逐个
  换算 edit，且要处理「多个 op 偏移互相影响」。
- **逐字符一个 op** —— 沿用 pad 的 CRDT 语义。输入 10 个字 = 10 个 op。
- **没有 markdown 预览** —— 只做源码编辑 + 语法高亮。

## 测试

```bash
# 协议层（裸 WebSocket 客户端，16 项断言）
python3 /tmp/monaco_ws_test.py 3000 <doc>

# 浏览器端（手动）
#   开两个 tab 同 doc → 互相看到对方的输入 + 远端光标
#   开两个 tab 不同 doc → 完全隔离
```
