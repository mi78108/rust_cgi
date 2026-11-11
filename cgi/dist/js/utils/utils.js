/**
 * utils.js — 通用工具集（入口）
 *
 * 零依赖，纯前端。各子模块一个文件（datetime.js 等），共用 `window.Utils` 容器。
 *
 * 用法一（普通 script 标签 —— 跟 dialog.js / table.js / plugin.js 一致）：
 *   <script src="/pub/js/utils/datetime/datetime.js"></script>
 *   <script src="/pub/js/utils/utils.js"></script>
 *   <script>
 *     Utils.datetime.formatDate(new Date());
 *   </script>
 *
 * 用法二（插件加载器）：
 *   const U = await Plugin.load('utils');
 *   U.datetime.formatDate(new Date());
 *
 * ★ 本文件**不加载**子模块 —— 它只是容器。
 *   子模块各自往 `window.Utils` 上挂自己的命名空间，谁先加载都行。
 *   插件加载器只会拉 utils.js，所以走 Plugin.load('utils') 时
 *   需要页面自己先 <script> 引过子模块（或者用下面 loadSub 显式拉）。
 *
 * ★ 新增子模块：新建 `utils/<name>.js`，在里面写
 *     var U = window.Utils = window.Utils || {};
 *     U.<name> = { ... };
 *   然后在 description.json 的 submodules 里登记。
 */
(function () {
  'use strict';

  /* 容器 —— 子模块可能已经先加载过，这里不能覆盖 */
  var U = window.Utils = window.Utils || {};

  /**
   * 列出已注册的子模块名。
   * @returns {string[]}
   */
  function submodules() {
    return Object.keys(U).filter(function (k) {
      return k !== 'version' && k !== 'loadSub' && k !== 'submodules';
    }).sort();
  }

  /**
   * 子模块目录的默认 base。
   *
   * ★ 优先用 Plugin.base —— 页面把 base 指到哪，模块就在哪找。
   *   写死 '/pub/js/utils/' 的话，页面换个源就找不到了
   *   （插件加载器支持 base 覆盖，就是为了这种场景）。
   *   没有 Plugin（比如直接 <script> 引）时退回默认路径。
   *
   * @returns {string} 结尾带 '/'
   */
  function defaultSubBase() {
    var P = typeof window !== 'undefined' ? window.Plugin : null;
    if (P && typeof P.base === 'string' && P.base) {
      return P.base.charAt(P.base.length - 1) === '/' ? P.base + 'utils/' : P.base + '/utils/';
    }
    return '/pub/js/utils/';
  }

  /**
   * 拉取一个子模块（子模块是独立的 .js 文件，不会被 utils.js 自动加载）。
   *
   * ★ 用动态 <script> 注入 —— 这些模块是 classic script，不是 ES module，
   *   所以不能用 import()。注入是异步的，返回的是 Promise。
   *
   * @param {string} name 子模块名，如 'datetime'
   * @param {Object} [opts]
   * @param {string} [opts.base='/pub/js/utils/'] 子模块所在目录
   * @returns {Promise<Object>} 该子模块导出的 API
   */
  function loadSub(name, opts) {
    var o = opts || {};
    /* ★ base 默认**从 Plugin.base 推**，不是写死 '/pub/js/utils/' ——
       写死的话，页面换个源（或者 Plugin.base 指向别处）就加载不到子模块了。
       Plugin.base 形如 'http://host/pub/js/'，子模块目录是它下面的 'utils/'。 */
    var base = o.base || defaultSubBase();
    if (base.charAt(base.length - 1) !== '/') base += '/';

    /* ★ 子模块名要校验 —— 它会拼进 URL 和 <script src>，放开就能路径穿越 */
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      return Promise.reject(new Error('非法子模块名: ' + JSON.stringify(name)));
    }

    /* ★ 子模块布局：<base>/<name>/<name>.js ——
       跟 Plugin.load('utils.<name>') 找的是同一个文件。
       （description.json 里的 entry 可以是别的名字，那种情况用 Plugin.load。） */
    var url = base + name + '/' + name + '.js';

    /* 已经加载过了 —— 直接返回，不重复注入 */
    if (U[name]) return Promise.resolve(U[name]);

    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = function () {
        if (!U[name]) {
          if (s.parentNode) s.parentNode.removeChild(s);
          reject(new Error('子模块没有挂到 window.Utils.' + name));
          return;
        }
        resolve(U[name]);
      };
      s.onerror = function () {
        if (s.parentNode) s.parentNode.removeChild(s);
        reject(new Error('子模块加载失败: ' + url));
      };
      document.head.appendChild(s);
    });
  }

  /* 版本号 —— 跟 description.json 里的 version 保持一致 */
  U.version = '0.1.0';

  U.submodules = submodules;
  U.loadSub = loadSub;

  /* 暴露到全局 —— 跟 dialog.js / table.js / plugin.js 一致 */
  if (typeof window !== 'undefined') {
    window.Utils = U;
  }
  /* CommonJS 环境也挂一下 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = U;
  }
})();
