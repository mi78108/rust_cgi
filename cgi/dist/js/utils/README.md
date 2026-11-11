# utils — 通用工具集

零依赖的纯前端工具集。**`utils.js` 本身不实现任何具体功能** —— 它只是
`window.Utils` 容器；具体功能都在独立子模块目录里。

## 结构

```
utils/
├── utils.js              # 容器：建立 window.Utils + 版本号
├── description.json      # deps 清单（dependencies 字段）
├── index.html            # 总览页（不列子模块 API）
├── README.md
└── datetime/             # 子模块 —— 独立插件目录
    ├── datetime.js
    ├── description.json
    ├── index.html        # 子模块自己的详细页 + demo
    └── README.md
```

## 引入

用插件加载器（**一次加载全部子模块**）：

```html
<script src="/pub/js/plugin/plugin.js"></script>
<script type="module">
  const U = await Plugin.load('utils');
  U.datetime.formatDate(new Date());   // '2026-11-11'
</script>
```

★ `Plugin.load('utils')` 会**先加载 `description.json` 里 `dependencies`
列出的全部子模块**，再加载 `utils.js` —— 所以 load 完 `window.Utils` 上
已经挂着所有子模块。

只加载某一个子模块：

```js
const dt = await Plugin.load('utils.datetime');
```

不用插件加载器也行 —— 子模块自己会建容器：

```html
<script src="/pub/js/utils/datetime/datetime.js"></script>
<script>
  Utils.datetime.formatDate(new Date());
</script>
```

## 容器 API

| 成员 | 类型 | 说明 |
|---|---|---|
| `Utils.version` | string | 版本号，跟 `description.json` 的 `version` 一致 |

子模块挂在 `Utils.<name>` 上（由各子模块自己挂）。

## 子模块

| 插件名 | 说明 | 文档 |
|---|---|---|
| `utils.datetime` | 日期时间 —— 格式化 / 解析 / 取值 / 差值 / 运算 / 时间戳 | [`datetime/README.md`](datetime/README.md) · [演示页](datetime/index.html) |

★ **子模块的具体 API 看各自的页面** —— 本页只做总览。

## 新增子模块

1. 在 `utils/` 下建 `<name>/` 目录（**独立插件目录**），写 `<name>.js`，
   并给它自己的 `description.json`（`entry` / `global` / `type`）
2. 把插件名加进**本目录** `description.json` 的 `dependencies` 数组：

```json
"dependencies": ["utils.datetime", "utils.foo"]
```

3. 在本目录 `description.json` 的 `api.submodules` 里登记一行（供机器读）

## 行为

| 情况 | 结果 |
|---|---|
| `Plugin.load('utils')` | 先加载全部 deps，再加载容器 |
| deps 用点号分段 | `utils.datetime` → `utils/datetime/` |
| 循环依赖 | 抛「循环依赖」错误，不会死锁 |
| 子模块单独加载 | `Plugin.load('utils.datetime')` 不用先加载 utils |

## 参见

- `cgi/dist/js/plugin/` — 插件加载器（点号分段、deps、路径穿透防护）
- `cgi/dist/js/index.html` — 工具目录页
