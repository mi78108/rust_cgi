# plugin — 插件加载器

按名称加载 `cgi/dist/js/<name>/` 下的插件。插件的元信息来自同目录的
`description.json`，加载后返回该插件导出的 API。

零依赖，纯前端。

## 用法

```js
const Dialog = await Plugin.load('dialog');
Dialog.confirm('确定？');
```

加载流程：

1. `fetch <base>/<name>/description.json` —— 元信息（`entry` / `global` / `type`）
2. 按 `type` 加载实现文件：
   - `type === 'module'` → 动态 `import()`
   - 否则 → 注入 `<script>` 标签
3. `type` 不是 `module` 时，从 `global` 指定的全局变量上取导出的 API

## 嵌套插件（点号分段）

插件名用**点号**分段，`Plugin.load('utils.datetime')` 对应目录 `utils/datetime/`：

```js
const dt = await Plugin.load('utils.datetime');
dt.formatDate(new Date());
```

★ **每段只允许 `[A-Za-z0-9_-]`** —— 这正是防路径穿透的关键：

| 名字 | 结果 |
|---|---|
| `utils.datetime` | ✅ 两段都合法 |
| `..` | ❌ 点号拆开是空段 |
| `utils..datetime` | ❌ 中间空段 |
| `.utils` / `utils.` | ❌ 首尾空段 |
| `a/b` | ❌ 段里含斜杠 |
| `a%2e%2e` | ❌ 段里含百分号 |

★ 用点号而不是斜杠，是因为**点号分段后，任何一段里都不可能出现点号** ——
于是 `..` 这种段根本构造不出来。斜杠分段的话 `..` 是完整的一段，
得靠额外黑名单挡，少一层就漏。

★ `base` 里也不允许 `..` 段 —— 否则拼出来的 URL 会跳出 base 目录。

## 依赖（dependencies）

`description.json` 的 `dependencies` 列依赖的插件名 —— **加载本插件之前先加载它们**。

```json
{
  "name": "utils",
  "entry": "utils.js",
  "global": "Utils",
  "dependencies": ["utils.datetime"]
}
```

```js
const U = await Plugin.load('utils');
U.datetime.formatDate(new Date());   // deps 已经加载并挂上了
```

★ 工具集类模块（`utils`）靠它把子模块全挂上 —— 容器本身不用实现任何功能。

| 规则 | 说明 |
|---|---|
| 依赖名 | 跟 `load()` 一样用点号分段，**基准同为 base**（相对插件根，不是相对当前插件） |
| 加载顺序 | 依赖先加载，容器后加载 —— 所以子模块挂上来的东西不会被覆盖 |
| 递归 | 依赖自己也有 `dependencies` → 递归加载 |
| 循环依赖 | A→B→A 直接抛「循环依赖」错误，**不会死锁** |
| 非法依赖名 | 跟非法插件名一样被拒（点号分段校验） |
| 去重 | 同一个依赖只加载一次 |

## API

### `Plugin.load(name, options?)` → `Promise<*>`

按名称加载插件，返回该插件导出的 API。

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | string | 插件名（= 目录名）。点号分段，如 `utils.datetime` → `utils/datetime/` |
| `options.base` | string | 插件根目录，默认 `Plugin.base` |

★ `base` 决定**两样东西**：`description.json` 从哪儿取，以及实现文件从哪儿取。
`options.base` 只影响这一次调用，不改 `Plugin.base`。

```js
await Plugin.load('dialog', { base: '/other/js/' });   // 只这一次
```

### `Plugin.describe(name, options?)` → `Promise<Object>`

只读 `description.json` 元信息，**不加载实现**。

```js
const desc = await Plugin.describe('dialog');
// → { name:'dialog', entry:'dialog.js', global:'Dialog', type:'script', ... }
```

### `Plugin.get(name)` → `* | undefined`

取已加载的插件（**同步**）。没加载过返回 `undefined`。

★ 返回的是**已 resolve 的值**，不是 Promise —— 缓存里虽然存的是 Promise，
但 resolve 后会另存一份值供同步读取。所以 `load()` 之后 `get()` 立刻能拿到。

★ 按**插件名**查，跟 base 无关 —— `load('x', { base: '/other/' })` 之后
`get('x')` 照样拿得到。同名在多个 base 下都加载过时，返回最后加载的那份。

```js
await Plugin.load('dialog');
Plugin.get('dialog');   // → Dialog 构造函数
```

### `Plugin.has(name)` → `boolean`

插件是否已加载（同样按名字，不受 base 影响）。

### `Plugin.clear(name?)`

清缓存。不给 `name` 则全清；给了 `name` 则该名字在**所有 base** 下的都清。

### `Plugin.base` → `string`

插件根目录，默认 `'/pub/js/'`。页面在别处时可以改。

```js
Plugin.base = '/other/js/';
await Plugin.load('dialog');   // 走新根目录
```

## description.json 契约

插件目录下的 `description.json` 描述这个插件，加载器靠它定位实现：

| 字段 | 说明 |
|---|---|
| `name` | 插件名，也是目录名 |
| `entry` | 实现文件名，相对插件目录，如 `dialog.js` |
| `global` | 导出到 `window` 上的全局变量名，如 `Dialog`（`type=module` 时不用） |
| `type` | `script`（默认）或 `module` |
| `url` | 实现文件路径（可选） |

`url` 有三种写法，**相对路径跟随 base，绝对路径覆盖 base**：

| `url` 的值 | 实现文件最终位置 |
|---|---|
| 不写 | `<base>/<name>/<entry>` |
| `dialog.js`（相对） | `<base>/<name>/dialog.js` ← 跟随 base |
| `/pub/js/x/x.js` 或 `https://…`（绝对） | 就用它 ← 覆盖 base |

★ **写相对路径**。写死绝对路径会让 `base` / `options.base` 失效 ——
`description.json` 从新 base 取到了，实现文件却还从老路径加载。

## 行为要点

★ **插件名严格白名单** —— `/^[A-Za-z0-9_-]{1,64}$/`。
它会拼进 URL 和文件路径，放开的话 `load('../../etc/passwd')` 能拿到目录外的文件。

★ **并发去重** —— 同名插件同时 `load` 只真正加载一次（缓存的是 Promise）。

★ **失败不写缓存** —— 加载失败会清掉缓存条目，下次 `load` 可以重试。

★ **不重复执行** —— 页面已经用 `<script>` 引过**同一个 url** 的实现时直接复用，
不会二次初始化。★ 按 URL 判断，不看 `window` 上有没有同名全局 ——
否则 `load(name, { base })` 会拿到旧 base 的实现。

★ **名字对不上会警告** —— `description.json` 的 `name` 和请求的名字不一致时
打一条 `console.warn`（目录放错位了）。

## 例子

```js
// 加载
const Dialog = await Plugin.load('dialog');
await Dialog.confirm('清空文档？', { danger: true });

// 只读元信息
const desc = await Plugin.describe('dialog');
console.log(desc.version, desc.global);

// 换根目录（实现文件也跟着换）
Plugin.base = '/pub/js/';
const D = await Plugin.load('dialog', { base: '/pub/js/' });
```

## 参见

- `cgi/dist/js/dialog/` —— 用这个加载器加载的示例插件
- `cgi/dist/js/index.html` —— 工具目录页
