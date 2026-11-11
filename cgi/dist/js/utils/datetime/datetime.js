/**
 * datetime.js — 日期时间工具（utils 子模块）
 *
 * 零依赖，纯前端。所有方法接受 Date / 时间戳 / 日期字符串，入参不合法返回 null。
 *
 * 用法：
 *   <script src="/pub/js/utils/datetime.js"></script>
 *   <script>
 *     Utils.datetime.formatDate(new Date());   // '2026-11-11'
 *   </script>
 *
 * ★ 本文件只挂 `window.Utils.datetime`，不自己建 `window.Utils` 容器 ——
 *   容器由 utils.js 建立。这样两个文件谁先加载都行。
 */
(function () {
  'use strict';

  /* 容器 —— utils.js 可能还没加载，这里先兜住 */
  var U = window.Utils = window.Utils || {};

  var DAY_MS = 86400000;

  /* ── 内部：把各种入参统一成 Date ───────────────────────── */

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /**
   * 入参 → Date。认不出来返回 null。
   * @param {Date|number|string} v
   * @returns {Date|null}
   */
  function toDate(v) {
    if (v instanceof Date) {
      return isNaN(v.getTime()) ? null : v;
    }
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      return new Date(v);
    }
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return null;
      /* ISO 8601 带 Z / 时区偏移 —— 交给原生解析 */
      if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
        var t = Date.parse(s);
        return isNaN(t) ? null : new Date(t);
      }
      /* 常见格式：YYYY-MM-DD / YYYY-MM-DD HH:mm[:ss] / YYYY/MM/DD ... */
      var m = s.match(
        /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
      );
      if (!m) return null;
      var y = +m[1], mo = +m[2] - 1, d = +m[3];
      var hh = m[4] ? +m[4] : 0;
      var mi = m[5] ? +m[5] : 0;
      var ss = m[6] ? +m[6] : 0;
      /* 月份 0~11，越界直接判无效（new Date 会自动进位，2024-13 会变成 2025-01） */
      if (mo < 0 || mo > 11 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
      var dt = new Date(y, mo, d, hh, mi, ss);
      /* 溢出回检 —— 2 月 31 日要判无效 */
      if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
      return dt;
    }
    return null;
  }

  /* ── 取值 ─────────────────────────────────────────────── */

  function year(v) { var d = toDate(v); return d ? d.getFullYear() : null; }
  function month(v) { var d = toDate(v); return d ? d.getMonth() + 1 : null; }   /* 1~12 */
  function day(v) { var d = toDate(v); return d ? d.getDate() : null; }
  function hour(v) { var d = toDate(v); return d ? d.getHours() : null; }
  function minute(v) { var d = toDate(v); return d ? d.getMinutes() : null; }
  function second(v) { var d = toDate(v); return d ? d.getSeconds() : null; }
  function weekday(v) { var d = toDate(v); return d ? d.getDay() : null; }         /* 0=周日 */

  /**
   * 一年里的第几天。
   * @param {Date|number|string} v
   * @returns {number|null} 1~366
   */
  function dayOfYear(v) {
    var d = toDate(v);
    if (!d) return null;
    /* 朝单代的明朝不是 24 小时的复数—— floor 会少種一天，改 round */
    return Math.round((d - new Date(d.getFullYear(), 0, 1)) / DAY_MS) + 1;
  }

  /**
   * 某年某月有几天。
   * @param {number} y
   * @param {number} m 月份 1~12
   * @returns {number|null}
   */
  function daysInMonth(y, m) {
    if (typeof y !== 'number' || typeof m !== 'number') return null;
    if (m < 1 || m > 12) return null;
    return new Date(y, m, 0).getDate();
  }

  /**
   * 是不是闰年。
   * @param {number} y
   * @returns {boolean}
   */
  function isLeapYear(y) {
    if (typeof y !== 'number') return false;
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  /* ── 格式化 ───────────────────────────────────────────── */

  /**
   * 按模板格式化。占位符：YYYY YY MM DD HH mm ss SSS
   * @param {Date|number|string} v
   * @param {string} [pattern='YYYY-MM-DD HH:mm:ss']
   * @returns {string} 入参无效返回 ''
   */
  function format(v, pattern) {
    var d = toDate(v);
    if (!d) return '';
    var p = pattern || 'YYYY-MM-DD HH:mm:ss';
    return p
      .replace(/YYYY/g, String(d.getFullYear()))
      .replace(/YY/g, pad2(d.getFullYear() % 100))
      .replace(/MM/g, pad2(d.getMonth() + 1))
      .replace(/DD/g, pad2(d.getDate()))
      .replace(/HH/g, pad2(d.getHours()))
      .replace(/mm/g, pad2(d.getMinutes()))
      .replace(/ss/g, pad2(d.getSeconds()))
      .replace(/SSS/g, String(d.getMilliseconds()).padStart(3, '0'));
  }

  /**
   * 只到天的日期。'2026-11-11'
   * @param {Date|number|string} v
   * @returns {string}
   */
  function formatDate(v) {
    return format(v, 'YYYY-MM-DD');
  }

  /**
   * 只到分的时间。'14:30'
   * @param {Date|number|string} v
   * @returns {string}
   */
  function formatTime(v) {
    return format(v, 'HH:mm');
  }

  /**
   * 完整时间。'2026-11-11 14:30:00'
   * @param {Date|number|string} v
   * @returns {string}
   */
  function formatDateTime(v) {
    return format(v, 'YYYY-MM-DD HH:mm:ss');
  }

  /**
   * 相对时间。'3 分钟前' / '2 小时后' / '刚刚'
   * @param {Date|number|string} v
   * @param {Date|number|string} [now] 参照时刻，默认当前
   * @returns {string}
   */
  function formatRelative(v, now) {
    var d = toDate(v);
    if (!d) return '';
    var base = now === undefined ? new Date() : toDate(now);
    if (!base) return '';
    var diff = d.getTime() - base.getTime();
    var abs = Math.abs(diff);
    var suffix = diff >= 0 ? '后' : '前';

    if (abs < 45 * 1000) return '刚刚';
    if (abs < 90 * 1000) return '1 分钟' + suffix;
    if (abs < 3600 * 1000) return Math.floor(abs / 60000) + ' 分钟' + suffix;
    if (abs < 24 * 3600 * 1000) return Math.floor(abs / 3600000) + ' 小时' + suffix;
    if (abs < 30 * 24 * 3600 * 1000) return Math.floor(abs / DAY_MS) + ' 天' + suffix;
    if (abs < 365 * 24 * 3600 * 1000) return Math.floor(abs / (30 * 24 * 3600 * 1000)) + ' 个月' + suffix;
    return Math.floor(abs / (365 * 24 * 3600 * 1000)) + ' 年' + suffix;
  }

  /* ── 差值 ─────────────────────────────────────────────── */

  /**
   * 两个时刻差了多少天（按自然日算，不按 24 小时整除）。
   * @param {Date|number|string} a
   * @param {Date|number|string} b
   * @returns {number|null} b - a，单位天
   */
  function diffDays(a, b) {
    var da = toDate(a), db = toDate(b);
    if (!da || !db) return null;
    /* 抹掉时分秒再相减 —— 否则 '今天 9:00' 到 '明天 8:00' 会算成 0 天 */
    var ua = new Date(da.getFullYear(), da.getMonth(), da.getDate());
    var ub = new Date(db.getFullYear(), db.getMonth(), db.getDate());
    return Math.round((ub - ua) / DAY_MS);
  }

  /**
   * 两个时刻相差多少毫秒。
   * @param {Date|number|string} a
   * @param {Date|number|string} b
   * @returns {number|null} b - a
   */
  function diffMs(a, b) {
    var da = toDate(a), db = toDate(b);
    if (!da || !db) return null;
    return db.getTime() - da.getTime();
  }

  /* ── 运算 ─────────────────────────────────────────────── */

  /**
   * 加减时间。
   * @param {Date|number|string} v
   * @param {Object} [delta] {years, months, days, hours, minutes, seconds, ms}
   * @returns {Date|null}
   */
  function add(v, delta) {
    var d = toDate(v);
    if (!d) return null;
    var o = delta || {};
    /* 月/年用 setFullYear / setMonth —— setDate 会被夏令时吃掉一天 */
    if (o.years) d.setFullYear(d.getFullYear() + o.years);
    if (o.months) d.setMonth(d.getMonth() + o.months);
    if (o.days) d.setDate(d.getDate() + o.days);
    if (o.hours) d.setHours(d.getHours() + o.hours);
    if (o.minutes) d.setMinutes(d.getMinutes() + o.minutes);
    if (o.seconds) d.setSeconds(d.getSeconds() + o.seconds);
    if (o.ms) d.setMilliseconds(d.getMilliseconds() + o.ms);
    return d;
  }

  /**
   * 加减天数的快捷方式。
   * @param {Date|number|string} v
   * @param {number} n 天数，可为负
   * @returns {Date|null}
   */
  function addDays(v, n) {
    return add(v, { days: n });
  }

  /**
   * 一天的开始（00:00:00.000）。
   * @param {Date|number|string} v
   * @returns {Date|null}
   */
  function startOfDay(v) {
    var d = toDate(v);
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /**
   * 一天的结束（23:59:59.999）。
   * @param {Date|number|string} v
   * @returns {Date|null}
   */
  function endOfDay(v) {
    var d = toDate(v);
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  }

  /**
   * 一周的开始。默认周一，firstDay 传 0 则从周日开始。
   * @param {Date|number|string} v
   * @param {number} [firstDay=1] 0=周日 1=周一
   * @returns {Date|null}
   */
  function startOfWeek(v, firstDay) {
    var d = startOfDay(v);
    if (!d) return null;
    var fd = firstDay === undefined ? 1 : firstDay;
    var diff = (d.getDay() - fd + 7) % 7;
    d.setDate(d.getDate() - diff);
    return d;
  }

  /**
   * 一月的开始。
   * @param {Date|number|string} v
   * @returns {Date|null}
   */
  function startOfMonth(v) {
    var d = toDate(v);
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  /**
   * 一月的结束（最后一秒）。
   * @param {Date|number|string} v
   * @returns {Date|null}
   */
  function endOfMonth(v) {
    var d = toDate(v);
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  /* ── 时间戳 ───────────────────────────────────────────── */

  /**
   * Unix 时间戳（秒）。
   * @param {Date|number|string} v
   * @returns {number|null}
   */
  function toTimestamp(v) {
    var d = toDate(v);
    return d ? Math.floor(d.getTime() / 1000) : null;
  }

  /**
   * Unix 时间戳（秒）→ Date。
   * @param {number} ts
   * @returns {Date|null}
   */
  function fromTimestamp(ts) {
    if (typeof ts !== 'number' || !isFinite(ts)) return null;
    return new Date(ts * 1000);
  }

  /* ══ 导出 ═════════════════════════════════════════════ */

  var datetime = {
    /* 取值 */
    toDate: toDate,
    year: year,
    month: month,
    day: day,
    hour: hour,
    minute: minute,
    second: second,
    weekday: weekday,
    dayOfYear: dayOfYear,
    daysInMonth: daysInMonth,
    isLeapYear: isLeapYear,
    /* 格式化 */
    format: format,
    formatDate: formatDate,
    formatTime: formatTime,
    formatDateTime: formatDateTime,
    formatRelative: formatRelative,
    /* 差值 */
    diffDays: diffDays,
    diffMs: diffMs,
    /* 运算 */
    add: add,
    addDays: addDays,
    startOfDay: startOfDay,
    endOfDay: endOfDay,
    startOfWeek: startOfWeek,
    startOfMonth: startOfMonth,
    endOfMonth: endOfMonth,
    /* 时间戳 */
    toTimestamp: toTimestamp,
    fromTimestamp: fromTimestamp
  };

  U.datetime = datetime;

  /* 暴露到全局 —— 跟 dialog.js / table.js / plugin.js 一致 */
  if (typeof window !== 'undefined') {
    window.Datetime = datetime;
  }
  /* CommonJS 环境也挂一下 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = datetime;
  }
})();
