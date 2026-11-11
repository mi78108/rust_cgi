/**
 * utils.js — 通用工具集（容器 / 命名空间）
 *
 * 零依赖，纯前端。**本文件不实现任何具体功能** —— 它只做两件事：
 *   1. 建立 `window.Utils` 容器（子模块往这里挂）
 *   2. 打上版本号
 *
 * ★ 各子模块是**独立插件目录**（`utils/<name>/`），清单写在
 *   同目录 `description.json` 的 `dependencies` 里。
 *   `Plugin.load('utils')` 会**先加载所有 deps**，再加载本文件 ——
 *   所以 load 完 `window.Utils` 上就挂着全部子模块了。
 *
 * 用法：
 *   const U = await Plugin.load('utils');
 *   U.datetime.formatDate(new Date());
 *
 * 只想加载某一个子模块：
 *   const dt = await Plugin.load('utils.datetime');
 *
 * ★ 也可以不用插件加载器，直接 <script> 引子模块：
 *   <script src="/pub/js/utils/datetime/datetime.js"></script>
 *   → 它会自己建 window.Utils 容器并挂上 Utils.datetime
 */
(function () {
  'use strict';

  /* 容器 —— 子模块可能已经先加载过（deps 先于本文件加载），这里不能覆盖 */
  var U = window.Utils = window.Utils || {};

  /* 版本号 —— 跟 description.json 的 version 保持一致 */
  U.version = '0.1.0';

  /* 暴露到全局 —— 跟 dialog.js / table.js / plugin.js 一致 */
  if (typeof window !== 'undefined') {
    window.Utils = U;
  }
  /* CommonJS 环境也挂一下 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = U;
  }
})();
