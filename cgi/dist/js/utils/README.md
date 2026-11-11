# utils — 通用工具集

零依赖的纯前端工具集。按**子模块**组织：每个子模块一个 `.js` 文件，
共用 `window.Utils` 容器，互不依赖。

当前子模块：**`datetime`**（日期时间）。

## 引入

普通 `<script>` 标签（挂全局 `window.Utils`）：

```html
<script src="/pub/js/utils/datetime/datetime.js"></script>
<script src="/pub/js/utils/utils.js"></script>
```

> 路径里的 `/pub/` 是静态服务器入口（`cgi/pub`，`PUB_ROOT` 默认 `dist`）。
> 直接写 `/dist/js/...` **不通** —— 没有对应的 CGI 脚本，连接会被直接关掉。

> ⚠️ `utils.js` **不自动加载**子模块 —— 它只是容器。
> 要用 `datetime` 就把 `datetime.js` 一起引上。

## 子模块

### datetime

所有方法都吃三种入参：`Date` / 时间戳（毫秒）/ 日期字符串。
**认不出来返回 `null`**（格式化类返回空串），不抛异常。

#### 格式化

```js
Utils.datetime.format(d);                    // '2026-11-11 14:30:00'  默认模板
Utils.datetime.format(d, 'YYYY/MM/DD');      // '2026/11/11'
Utils.datetime.formatDate(d);                // '2026-11-11'
Utils.datetime.formatTime(d);                // '14:30'
Utils.datetime.formatDateTime(d);            // '2026-11-11 14:30:00'
```

`format` 的占位符：`YYYY` `YY` `MM` `DD` `HH` `mm` `ss` `SSS`（毫秒补 3 位）。

#### 相对时间

```js
Utils.datetime.formatRelative(Date.now() - 3 * 60000);   // '3 分钟前'
Utils.datetime.formatRelative(Date.now() + 2 * 3600000);  // '2 小时后'
```

阈值：`< 45 秒` → `刚刚`；`< 90 秒` → `1 分钟`；之后按分钟 / 小时 / 天 / 月 / 年。

#### 取值

```js
Utils.datetime.year('2026-11-11');        // 2026
Utils.datetime.month('2026-11-11');       // 11      1~12
Utils.datetime.day('2026-11-11');         // 11
Utils.datetime.hour('2026-11-11 14:30');  // 14
Utils.datetime.minute('2026-11-11 14:30');// 30
Utils.datetime.second('2026-11-11');       // 0
Utils.datetime.weekday('2026-11-11');     // 3       0=周日（跟 Date.getDay 一致）
Utils.datetime.dayOfYear('2026-11-11');   // 315     1~366
Utils.datetime.daysInMonth(2024, 2);      // 29
Utils.datetime.isLeapYear(2024);          // true
```

> `month()` 是 **1~12**（跟 `daysInMonth(y, m)` 对齐），不是 JS 的 0~11。
> `weekday()` 是 **0~6**，0 = 周日。

#### 差值

```js
Utils.datetime.diffDays('2026-11-01', '2026-11-11');  // 10
Utils.datetime.diffMs(a, b);                          // b - a，单位毫秒
```

> `diffDays` 按**自然日**算 —— 先抹掉时分秒再相减。
> 所以「今天 9:00 → 明天 8:00」是 **1 天**，不是 0。

#### 运算

```js
Utils.datetime.add('2026-11-11', { months: 1, days: 2 });  // Date
Utils.datetime.addDays('2026-11-11', 3);                  // Date
Utils.datetime.addDays('2026-11-11', -10);                // Date（负数往前）

Utils.datetime.startOfDay('2026-11-11 14:30');   // 2026-11-11 00:00:00.000
Utils.datetime.endOfDay('2026-11-11 14:30');     // 2026-11-11 23:59:59.999
Utils.datetime.startOfWeek('2026-11-11');        // 2026-11-09（周一）
Utils.datetime.startOfWeek('2026-11-11', 0);     // 2026-11-08（周日）
Utils.datetime.startOfMonth('2026-11-11');       // 2026-11-01
Utils.datetime.endOfMonth('2026-11-11');         // 2026-11-30 23:59:59.999
```

`add` 的 `delta` 支持 `years` `months` `days` `hours` `minutes` `seconds` `ms`。

#### 时间戳

```js
Utils.datetime.toTimestamp('2026-11-11 00:00:00');  // 秒
Utils.datetime.fromTimestamp(1757203200);            // Date
```

#### 解析

```js
Utils.datetime.toDate('2026-11-11');              // Date
Utils.datetime.toDate('2026-11-11 14:30:25');     // Date
Utils.datetime.toDate('2026/11/11');              // Date
Utils.datetime.toDate('2026-11-11T08:30:00Z');    // Date（UTC）
Utils.datetime.toDate('2026-02-31');              // null（不存在的日期）
Utils.datetime.toDate('乱写');                     // null
```

## 容器 API

```js
Utils.version;                    // '0.1.0'
Utils.submodules();               // ['datetime']  已注册的子模块名
await Utils.loadSub('datetime');  // 动态拉子模块 → Promise<Object>
```

`loadSub` 用动态 `<script>` 注入（这些模块是 classic script，不是 ES module，
所以不能用 `import()`）。已经加载过的直接返回，不重复注入。

★ **`base` 默认从 `Plugin.base` 推导**，不是写死 `/pub/js/utils/` ——
页面把 `Plugin.base` 指到哪，子模块就在哪找（`Plugin.base` 下面拼 `utils/`）。
写死路径的话，页面换个源就加载不到了。没有 `Plugin` 时才退回 `/pub/js/utils/`。

子模块名会拼进 URL 和 `<script src>`，所以做了白名单校验 ——
`/^[A-Za-z0-9_-]{1,64}$/`。

## 插件加载器

`Plugin.load('utils')` 只会拉 `entry`（`utils.js`），拿到的是**容器**，
不含子模块 —— 插件加载器一次只拉一个文件。

```js
const U = await Plugin.load('utils');   // → Utils（容器）
U.submodules();                        // → []（datetime 还没加载）
```

要用 `datetime`：

```js
const dt = await Utils.loadSub('datetime');
dt.formatDate(new Date());
```

## 新增子模块

1. 在 `utils/` 下建 `<name>.js`：

```js
(function () {
  'use strict';
  var U = window.Utils = window.Utils || {};
  U.<name> = { /* ... */ };
  if (typeof window !== 'undefined') window.<Name> = U.<name>;
  if (typeof module !== 'undefined' && module.exports) module.exports = U.<name>;
})();
```

2. 在 `description.json` 的 `submodules` 里登记。

子模块之间互不依赖，谁先加载都行。

## 行为

| 情况 | 结果 |
|---|---|
| 入参不合法 | 返回 `null`（`format` 类返回 `''`） |
| 日期不存在（2 月 31 日） | `toDate` 返回 `null` |
| ISO 8601 带 `Z` / 时区偏移 | 走原生解析（按 UTC 算） |
| `diffDays` 跨夏令时 | 按自然日，不受 24 小时整除影响 |
| `add` 加月 / 年 | 用 `setMonth` / `setFullYear` —— 不会被夏令时吃掉一天 |

## 参见

- `dialog/` — 通用弹窗组件
- `table/` — 表格渲染组件
- `plugin/` — 插件加载器
