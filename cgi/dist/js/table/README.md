# table — 表格渲染组件

把一组对象数据渲染成 `<table>`。零依赖，纯前端。

样式自己注入，颜色走 CSS 变量（带回退值），宿主页面定义了 `:root` 变量就跟随宿主主题。

## 引入

```html
<script src="/pub/js/table/table.js"></script>
```

ES module：

```js
import { Table } from '/pub/js/table/table.js';
```

## 最简用法

```js
const t = new Table({
  columns: [
    { key: 'name', label: '名称' },
    { key: 'size', label: '大小', align: 'right' },
  ],
  rows: [
    { name: 'a.txt', size: 1024 },
    { name: 'b.txt', size: 2048 },
  ],
});

container.replaceChildren(t.element);
```

快捷方式 —— 直接拿到表格元素：

```js
container.replaceChildren(Table.render(rows, columns, { sortable: true }));
```

## 列定义

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 对应行对象的字段名，**必需** |
| `label` | string | 表头文字，缺省用 `key` |
| `align` | string | `left` / `right` / `center`（`right` 会加 `.num` 类，数字对齐） |
| `render` | Function | `(value, row, index) => string\|number\|null`，格式化单元格 |
| `renderNode` | Function | `(value, row, index) => Node`，返回 DOM 节点，**优先于** `render` |
| `sortValue` | Function | `(row) => 值`，排序用的取值，缺省用 `row[key]` |
| `sortable` | boolean | `false` = 这一列不可排序（需先开 `opts.sortable`） |
| `className` | string | 该列单元格额外的 class |
| `width` | string | 列宽，如 `'120px'` |

## 选项

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `columns` | Array | `[]` | 列定义 |
| `rows` | Array | `[]` | 行数据（对象数组） |
| `caption` | string | `''` | 表标题（`<caption>`） |
| `emptyText` | string | `'没有数据'` | 空数据时的提示 |
| `sortable` | boolean | `false` | 表头是否可点击排序 |
| `sortKey` | string | `null` | 初始排序列的 key |
| `sortDir` | string | `'asc'` | 初始排序方向 |
| `onRowClick` | Function | `null` | 点行时的回调 `(row, index)` |
| `className` | string | `''` | 表格额外的 class |

## 方法

| 方法 | 返回 | 说明 |
|---|---|---|
| `t.render()` | Table | 重新渲染 |
| `t.setRows(rows)` | Table | 换数据并重绘 |
| `t.setColumns(columns)` | Table | 换列并重绘（表头重建） |
| `t.sortBy(key, dir?)` | Table | 按指定列排序并重绘 |
| `t.getSortKey()` | string\|null | 当前排序列 |
| `t.getSortDir()` | string | 当前排序方向 |
| `t.destroy()` | Table | 从 DOM 摘掉 |

属性：`t.element`（表格元素）、`t.rows`、`t.columns`。

## 行为

★ **默认用 `textContent` 填单元格** —— 数据不会被当 HTML 解析。
要 HTML 得显式写 `html: true`（自己确保数据可信），要 DOM 节点用 `renderNode`。

★ **空值永远排最后** —— 升序降序都一样。排序的意义是让人快速找数据，
不是把 `null` 顶到最上面。

★ **点表头排序** —— 同一列再点一次反向，换列从升序开始。

★ **数字按数值比，字符串用 `localeCompare` 的 numeric 模式** ——
所以 `'10' > '9'`（字符串直接比会反过来）。

★ **空值单元格显示 `—`（破折号）** 并加 `.tbl-null` 类。

★ **无数据时渲染一行** `colspan=列数` 的提示行。

### 格式化示例

```js
{
  key: 'size',
  label: '大小',
  align: 'right',
  render: (v) => v === null ? null : fmtBytes(v),
}
```

### 点行

```js
new Table({
  columns: [...],
  rows: data,
  onRowClick: (row, index) => { console.log('点了', index, row); },
});
```

## 样式 class

| class | 说明 |
|---|---|
| `.tbl` | 表格本体 |
| `.tbl th` / `.tbl td` | 表头 / 单元格 |
| `.tbl th.sortable` | 可排序列 |
| `.tbl th.sorted` / `.tbl th.sorted-desc` | 当前排序列（升 / 降） |
| `.tbl th .tbl-sort` | 排序箭头槽位 |
| `.tbl tbody tr.clickable` | 可点击行 |
| `.tbl td.num` / `.tbl td.center` | 右对齐（数字）/ 居中 |
| `.tbl .tbl-empty` | 空数据提示行 |
| `.tbl .tbl-null` | 空值单元格 |

颜色全部走 CSS 变量，带回退值：`--bg` `--bg-2` `--bg-3` `--ink` `--muted`
`--rule` `--lime`。

## 参见

- `cgi/dist/js/dialog/` —— 另一个组件，样式注入方式相同
- `cgi/dist/js/plugin/` —— 可以用 `Plugin.load('table')` 加载本组件
- `cgi/dist/js/index.html` —— 工具目录页
