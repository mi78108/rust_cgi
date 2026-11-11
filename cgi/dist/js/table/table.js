/**
 * table.js — 表格渲染组件
 *
 * 把一组对象数据渲染成 <table>。零依赖，纯前端。
 * 样式自己注入（<style> 标签），颜色走 CSS 变量（带回退值），
 * 宿主页面定义了 :root 变量就跟随宿主主题。
 *
 * 用法：
 *   const t = new Table({
 *     columns: [
 *       { key: 'name', label: '名称' },
 *       { key: 'size', label: '大小', align: 'right',
 *         render: (v) => fmtBytes(v) },
 *     ],
 *     rows: data,
 *   });
 *   container.replaceChildren(t.element);
 *
 * ★ 默认用 textContent 填单元格 —— 不会把数据当 HTML 解析。
 *   要 HTML 就用 `html: true` 明确开（自己确保数据可信）。
 *   要 DOM 节点用 `renderNode`。
 */
(function () {
  'use strict';

  var STYLE_ID = 'tbl-component-style';

  var CSS = [
    '.tbl{',
    '  width:100%;border-collapse:collapse;',
    '  background:var(--bg-2,#ecead7);color:var(--ink,#0f0f12);',
    '  font-size:13px;',
    '}',
    '.tbl caption{',
    '  caption-side:top;text-align:left;',
    '  font-size:13px;font-weight:600;color:var(--ink,#0f0f12);',
    '  padding:0 0 8px;',
    '}',
    '.tbl th,.tbl td{',
    '  border:1px solid var(--rule,#1a1a1f);',
    '  padding:6px 10px;text-align:left;vertical-align:top;',
    '}',
    '.tbl thead th{',
    '  background:var(--bg-3,#e3e0c9);',
    '  font-weight:600;white-space:nowrap;',
    '}',
    '/* 可排序列 —— 鼠标变手型 */',
    '.tbl th.sortable{cursor:pointer;user-select:none}',
    '.tbl th.sortable:hover{background:var(--bg,#f4f1de)}',
    '/* 排序箭头 */',
    '.tbl th .tbl-sort{',
    '  display:inline-block;width:1em;margin-left:4px;',
    '  color:var(--muted,#5a5a64);font-size:10px;',
    '}',
    '/* 当前排序列 —— 箭头高亮 */',
    '.tbl th.sorted .tbl-sort{color:var(--lime,#c4f542)}',
    '.tbl th.sorted-desc .tbl-sort{color:var(--lime,#c4f542)}',
    '.tbl tbody tr:nth-child(even){background:rgba(0,0,0,.03)}',
    '.tbl tbody tr:hover{background:rgba(0,0,0,.06)}',
    '.tbl tbody tr.clickable{cursor:pointer}',
    '.tbl td.num,.tbl th.num{text-align:right;font-variant-numeric:tabular-nums}',
    '.tbl td.center,.tbl th.center{text-align:center}',
    '.tbl .tbl-empty{',
    '  text-align:center;color:var(--muted,#5a5a64);',
    '  padding:22px 10px;font-style:italic;',
    '}',
    '.tbl .tbl-null{color:var(--muted,#5a5a64);font-style:italic}',
  ].join('\n');

  var styleReady = false;

  function ensureStyle() {
    if (styleReady || typeof document === 'undefined') return;
    styleReady = true;
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  /* 空值判定 —— null / undefined 都算空 */
  function isNil(v) {
    return v === null || v === undefined;
  }

  /* 值比较 —— 数字按数值比，其它按字符串比（numeric 让 "10" > "9"） */
  function compareValues(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  /**
   * @param {Object} [opts]
   * @param {Array}  [opts.columns]  列定义 [{ key, label, align, render, renderNode, sortValue, sortable, className }]
   * @param {Array}  [opts.rows]     行数据（对象数组）
   * @param {string} [opts.caption]  表标题（<caption>）
   * @param {string} [opts.emptyText='没有数据']  空数据时的提示
   * @param {boolean} [opts.sortable=false]  表头是否可点击排序
   * @param {string}  [opts.sortKey]  初始排序列的 key
   * @param {string}  [opts.sortDir='asc']  初始排序方向 asc/desc
   * @param {Function} [opts.onRowClick]  点行时的回调 (row, index)
   * @param {string}  [opts.className]  额外 class
   */
  function Table(opts) {
    opts = opts || {};

    this.columns = opts.columns || [];
    this.rows = opts.rows || [];
    this.caption = opts.caption || '';
    this.emptyText = opts.emptyText || '没有数据';
    this.sortable = !!opts.sortable;
    this.onRowClick = opts.onRowClick || null;
    this.className = opts.className || '';

    this._sortKey = opts.sortKey || null;
    this._sortDir = opts.sortDir === 'desc' ? 'desc' : 'asc';

    this._build();
    this.render();
  }

  Table.prototype._build = function () {
    ensureStyle();

    var table = document.createElement('table');
    table.className = 'tbl' + (this.className ? ' ' + this.className : '');

    if (this.caption) {
      var cap = document.createElement('caption');
      cap.textContent = this.caption;
      table.appendChild(cap);
    }

    var thead = document.createElement('thead');
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    table.appendChild(tbody);

    this.element = table;
    this._tbody = tbody;
    this._thead = thead;

    this._buildHead();
  };

  /* ★ 表头单独一个方法 —— _build 和 setColumns 共用。
     两处各写一遍的话，改一处另一处就漂移了。 */
  Table.prototype._buildHead = function () {
    var thead = this._thead;
    thead.replaceChildren();

    var tr = document.createElement('tr');
    this._headCells = [];

    for (var i = 0; i < this.columns.length; i++) {
      var col = this.columns[i];
      var th = document.createElement('th');
      th.textContent = col.label === undefined ? col.key : col.label;
      if (col.align) th.classList.add(col.align);
      if (col.className) th.className += ' ' + col.className;
      /* 列宽 —— 用 style 而不是 CSS 变量 */
      if (col.width) th.style.width = col.width;

      /* 可排序的列 —— 加一个箭头槽位 */
      if (col.sortable !== false && this.sortable) {
        th.classList.add('sortable');
        var arrow = document.createElement('span');
        arrow.className = 'tbl-sort';
        th.appendChild(arrow);
        th.addEventListener('click', this._onHeaderClick.bind(this, col.key));
      }

      this._headCells.push(th);
      tr.appendChild(th);
    }

    thead.appendChild(tr);
  };

  Table.prototype._onHeaderClick = function (key) {
    /* 同一列再点一次 → 反向；换列 → 从升序开始 */
    if (this._sortKey === key) {
      this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this._sortKey = key;
      this._sortDir = 'asc';
    }
    this.render();
  };

  /** 排好序的行的副本 */
  Table.prototype._sortedRows = function () {
    var self = this;
    var key = this._sortKey;
    if (!key) return this.rows.slice();

    var col = null;
    for (var i = 0; i < this.columns.length; i++) {
      if (this.columns[i].key === key) { col = this.columns[i]; break; }
    }

    var get = function (row) {
      return col && col.sortValue ? col.sortValue(row) : row[key];
    };

    return this.rows.slice().sort(function (ra, rb) {
      var va = get(ra);
      var vb = get(rb);
      /* ★ 空值永远排最后 —— 升序降序都一样。
         排序的意义是让人快速找数据，不是把 null 顶到最上面。 */
      if (isNil(va) || isNil(vb)) {
        if (isNil(va) && isNil(vb)) return 0;
        return isNil(va) ? 1 : -1;
      }
      var c = compareValues(va, vb);
      return self._sortDir === 'desc' ? -c : c;
    });
  };

  /** 重新渲染整个 tbody */
  Table.prototype.render = function () {
    var self = this;
    var tbody = this._tbody;
    tbody.replaceChildren();

    /* 表头排序标记 */
    for (var i = 0; i < this._headCells.length; i++) {
      var th = this._headCells[i];
      var col = this.columns[i];
      var arrow = th.querySelector('.tbl-sort');
      var isSorted = col && col.key === this._sortKey;
      th.classList.toggle('sorted', isSorted && this._sortDir === 'asc');
      th.classList.toggle('sorted-desc', isSorted && this._sortDir === 'desc');
      if (arrow) {
        arrow.textContent = isSorted ? (this._sortDir === 'asc' ? '▲' : '▼') : '';
      }
    }

    var rows = this._sortedRows();

    if (!rows.length) {
      var emptyTr = document.createElement('tr');
      var emptyTd = document.createElement('td');
      emptyTd.className = 'tbl-empty';
      emptyTd.colSpan = Math.max(1, this.columns.length);
      emptyTd.textContent = this.emptyText;
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
      return this;
    }

    rows.forEach(function (row, index) {
      var tr = document.createElement('tr');

      for (var c = 0; c < self.columns.length; c++) {
        var col = self.columns[c];
        var td = document.createElement('td');
        if (col.align) td.classList.add(col.align);
        if (col.className) td.className += ' ' + col.className;

        var value = row ? row[col.key] : undefined;

        /* renderNode 优先 —— 返回 DOM 节点 */
        if (col.renderNode) {
          var node = col.renderNode(value, row, index);
          if (node) td.appendChild(node);
        } else if (col.render) {
          var rendered = col.render(value, row, index);
          if (isNil(rendered)) {
            td.classList.add('tbl-null');
            td.textContent = '—';
          } else if (col.html) {
            /* ★ 明确开了 html —— 调用方自己保证数据可信 */
            td.innerHTML = String(rendered);
          } else {
            td.textContent = String(rendered);
          }
        } else if (isNil(value)) {
          td.classList.add('tbl-null');
          td.textContent = '—';
        } else {
          td.textContent = String(value);
        }

        tr.appendChild(td);
      }

      if (self.onRowClick) {
        tr.classList.add('clickable');
        tr.addEventListener('click', function () { self.onRowClick(row, index); });
      }

      tbody.appendChild(tr);
    });

    return this;
  };

  /**
   * 换数据并重绘。
   * @param {Array} rows
   */
  Table.prototype.setRows = function (rows) {
    this.rows = rows || [];
    return this.render();
  };

  /**
   * 换列并重绘。
   * @param {Array} columns
   */
  Table.prototype.setColumns = function (columns) {
    this.columns = columns || [];
    /* 表头要重建 —— 列数/标签可能都变了 */
    this._buildHead();
    return this.render();
  };

  /** 当前排序列的 key（没排就是 null） */
  Table.prototype.getSortKey = function () {
    return this._sortKey;
  };

  /** 当前排序方向 'asc' / 'desc' */
  Table.prototype.getSortDir = function () {
    return this._sortDir;
  };

  /** 按指定列排序并重绘 */
  Table.prototype.sortBy = function (key, dir) {
    this._sortKey = key;
    this._sortDir = dir === 'desc' ? 'desc' : 'asc';
    return this.render();
  };

  /** 卸载（从 DOM 摘掉） */
  Table.prototype.destroy = function () {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    return this;
  };

  /**
   * 快捷方式 —— 直接拿到表格元素。
   * @param {Array} rows
   * @param {Array} columns
   * @param {Object} [opts]
   * @returns {HTMLTableElement}
   */
  Table.render = function (rows, columns, opts) {
    opts = Object.assign({}, opts || {});
    opts.rows = rows;
    opts.columns = columns;
    return new Table(opts).element;
  };

  /* 暴露到全局 —— 跟 dialog.js / plugin.js 一致 */
  if (typeof window !== 'undefined') window.Table = Table;
  if (typeof module !== 'undefined' && module.exports) module.exports = Table;
})();
