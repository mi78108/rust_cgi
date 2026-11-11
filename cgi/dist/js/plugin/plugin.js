/**
 * plugin.js — 插件加载器
 *
 * 按名称加载 `cgi/dist/js/<name>/` 下的插件。插件的元信息来自同目录的
 * `description.json`，加载后返回该插件导出的 API。
 *
 * 用法：
 *   const Dialog = await Plugin.load('dialog');
 *   Dialog.confirm('确定？');
 *
 * ★ 加载流程：
 *   1. fetch `<base>/<name>/description.json`  —— 元信息（entry/global/type）
 *   2. 按 `type` 加载实现文件：
 *        type === 'module' → 动态 import()
 *        否则               → 注入 <script> 标签
 *   3. type 不是 module 时，从 `global` 指定的全局变量上取导出的 API
 *
 * ★ 实现文件的最终位置（resolveUrl）：
 *        没写 url          → <base>/<name>/<entry>
 *        url 是相对路径     → <base>/<name>/<url>    ← 跟随 base
 *        url 是绝对 URL     → 直接用                   ← 显式覆盖 base
 *   ★ 相对路径跟随 base 很重要 —— 写死绝对路径会让 base/base 覆盖**失效**。
 *
 * ★ 并发去重：同名插件同时 load 只会真正加载一次（缓存的是 Promise）。
 * ★ 加载失败会清掉缓存，下次 load 可以重试。
 * ★ `type` 不是 module 且页面上已有该 `global` 时**直接复用，不重复执行脚本**
 *   —— 页面已经用 <script> 引过插件时，避免二次初始化。
 *
 * ★ get/has/clear 按**插件名**索引，与 base 无关 —— load 时用了别的 base
 *   也查得到（同名在多个 base 下都 load 过时，get 返回最后加载的那份）。
 *
 * 元信息字段（见 description.json）：
 *   name    插件名（也是目录名）
 *   entry   实现文件名，相对插件目录，如 "dialog.js"
 *   global  导出到 window 上的全局变量名，如 "Dialog"（type=module 时不用）
 *   type    "script"（默认）或 "module"
 *   url     实现文件路径。相对路径跟随 base；绝对 URL 覆盖 base（可选）
 */
(function () {
  'use strict';

  /* 插件根目录 —— 静态服务器入口。页面在别处时用 Plugin.base 改。 */
  var DEFAULT_BASE = '/pub/js/';

  /* ★ 插件名 → 路径段
   *
   * 用**点号**分段（'utils.datetime' → ['utils','datetime']），不用斜杠。
   *
   * ★ 为什么点号比斜杠更安全 —— 这是防路径穿透的关键：
   *   点号分段后，**任何一段里都不可能出现点号**，于是 '..' 这种段
   *   根本构造不出来：'..'.split('.') → ['', ''] → 空段 → 直接拒。
   *   斜杠分段的话 '..' 是完整的一段，得靠额外黑名单挡 —— 少一层就漏。
   *
   *   段内只允许 [A-Za-z0-9_-] —— 空段、含点、含斜杠全拒。
   */
  var SEG_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var MAX_SEGMENTS = 8;

  /**
   * 校验插件根目录 base。
   *
   * ★ base 是页面作者设的（可信），但**仍然要挡 '..'** ——
   *   base 里一个 '..' 就能让拼接出来的 URL 跳出 base 目录。
   *   挡掉之后，「名字受控 → URL 受控」这条链才是闭合的：
   *   名字每段合法 + base 无 '..' → 拼出来的路径里不可能有 '..'。
   *
   * @param {string} base
   * @returns {string} 结尾带 '/'
   */
  function safeBase(base) {
    var b = String(base == null ? '' : base);
    if (!b) throw new Error('插件根目录 base 不能为空');
    if (b.charAt(0) === '/') {
      /* 绝对路径（相对 origin）—— 逐段查 '..' */
      var segs = b.split('/');
      for (var i = 0; i < segs.length; i++) {
        if (segs[i] === '..') throw new Error('base 里不能含 ".." 段: ' + b);
      }
    } else {
      /* 完整 URL —— 查路径部分 */
      var m = b.match(/^([a-z][a-z0-9+.-]*:)?\/\/[^/]*(\/.*)?$/i);
      var pathPart = (m && m[2]) || '/';
      var ps = pathPart.split('/');
      for (var j = 0; j < ps.length; j++) {
        if (ps[j] === '..') throw new Error('base 里不能含 ".." 段: ' + b);
      }
    }
    return b.charAt(b.length - 1) === '/' ? b : b + '/';
  }

  /**
   * 插件名 → 路径段数组。非法返回 null。
   * @param {string} name
   * @returns {string[]|null}
   */
  function parseName(name) {
    if (typeof name !== 'string') return null;
    if (!name || name.length > 128) return null;
    var segs = name.split('.');
    if (segs.length > MAX_SEGMENTS) return null;
    for (var i = 0; i < segs.length; i++) {
      if (!SEG_RE.test(segs[i])) return null;
    }
    return segs;
  }

  /**
   * 插件名 → URL 里的相对路径。'utils.datetime' → 'utils/datetime'
   * @param {string} name
   * @returns {string|null}
   */
  function nameToPath(name) {
    var segs = parseName(name);
    return segs ? segs.join('/') : null;
  }

  /**
   * 路径最后一段 —— 用来比 description.json 的 name。
   * @param {string} path
   * @returns {string}
   */
  function lastSegment(path) {
    return path.slice(path.lastIndexOf('/') + 1);
  }

  /**
   * 校验**相对路径**（description.json 的 entry / url）。
   * 它会拼进 URL，所以拒掉：绝对路径、空段、'.'、'..'、百分号编码。
   * @param {string} p
   * @returns {string|null} 合法返回原串，非法返回 null
   */
  function safeRelPath(p) {
    if (typeof p !== 'string' || !p) return null;
    if (p.charAt(0) === '/' || p.indexOf('%') >= 0) return null;
    var segs = p.split('/');
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!s || s === '.' || s === '..') return null;
    }
    return p;
  }

  /* key(base+name) -> Promise<api>（并发去重用的） */
  var cache = new Map();

  /* name -> {key, api} —— 按**插件名**索引，与 base 无关。
     get/has/clear 走这个，所以 load 时用了别的 base 也能查得到。 */
  var byName = new Map();

  /* name -> Set<key> —— 某名字在哪些 base 下被 load 过（clear 时全清） */
  var registry = new Map();

  function joinBase(base) {
    /* ★ 走 safeBase —— base 里的 '..' 也要挡（见 safeBase 的注释） */
    return safeBase(base);
  }

  /* 绝对 URL（/xxx 或 http://xxx）—— 显式指定，覆盖 base */
  function isAbsolute(url) {
    return /^([a-z][a-z0-9+.-]*:)?\//i.test(url);
  }

  /* 实现文件最终放哪：
       1. description.json 没写 url → <base>/<name>/<entry>
       2. url 是相对路径          → <base>/<name>/<url>   （跟随 base）
       3. url 是绝对 URL          → 直接用（显式覆盖 base）
     相对路径跟随 base 是关键 —— 否则 base 改了实现文件却还从旧路径加载。 */
  function resolveUrl(base, path, desc) {
    /* entry 缺省 = 末段 + '.js' —— 'utils.datetime' → 'datetime.js' */
    var entry = desc.entry || (lastSegment(path) + '.js');
    if (desc.url) {
      if (isAbsolute(desc.url)) return desc.url;
      var rel = safeRelPath(desc.url);
      if (!rel) throw new Error('description.json 的 url 非法: ' + desc.url);
      return base + path + '/' + rel;
    }
    var e = safeRelPath(entry);
    if (!e) throw new Error('description.json 的 entry 非法: ' + entry);
    return base + path + '/' + e;
  }

  function addKey(name, key) {
    var set = registry.get(name);
    if (!set) { set = new Set(); registry.set(name, set); }
    set.add(key);
  }

  function dropKey(name, key) {
    var set = registry.get(name);
    if (!set) return;
    set.delete(key);
    if (!set.size) registry.delete(name);
  }

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = function () { resolve(s); };
      s.onerror = function () {
        /* ★ 失败的 script 标签要摘掉 —— 它还留在 DOM 里，
           下次重试会被 scriptAlreadyPresent 误判成"已加载"。 */
        if (s.parentNode) s.parentNode.removeChild(s);
        reject(new Error('脚本加载失败: ' + url));
      };
      document.head.appendChild(s);
    });
  }

  /* 绝对化 URL —— 比对脚本标签时要用 */
  function absUrl(url) {
    try { return new URL(url, location.href).href; }
    catch (e) { return url; }
  }

  /* 页面上是否已经引过**这个 url** 的脚本。
     ★ 按 URL 比，不按 window 上有没有那个全局变量 ——
       后者会把"别的 base 加载的同款插件"也当成已加载，
       于是 load(name, {base}) 悄悄返回了旧 base 的实现。 */
  function scriptAlreadyPresent(url) {
    var target = absUrl(url);
    var tags = document.querySelectorAll('script[src]');
    for (var i = 0; i < tags.length; i++) {
      if (absUrl(tags[i].getAttribute('src')) === target) return true;
    }
    return false;
  }

  class Plugin {
    /** 插件根目录（默认 '/pub/js/'） */
    static base = DEFAULT_BASE;

    /**
     * 按名称加载插件。
     * @param {string} name    插件名（= 目录名）
     * @param {Object} [opts]
     * @param {string} [opts.base]  插件根目录（默认 Plugin.base）
     * @returns {Promise<*>}  插件导出的 API
     */
    static async load(name, opts) {
      var base = joinBase((opts && opts.base) || Plugin.base);

      if (!parseName(name)) {
        throw new Error('非法插件名: ' + JSON.stringify(name) + '（点号分段，每段只允许字母/数字/下划线/连字符）');
      }

      var key = base + name;
      if (cache.has(key)) return cache.get(key);

      var p = Plugin._load(name, base);
      cache.set(key, p);
      addKey(name, key);

      try {
        var api = await p;
        /* ★ 已 resolve 的值另存一份 —— Plugin.get 是同步的，
           不能靠 p.then() 回调（那是微任务，同步读不到）。 */
        byName.set(name, { key: key, api: api });
        return api;
      } catch (e) {
        /* 失败不缓存 —— 下次可以重试 */
        cache.delete(key);
        dropKey(name, key);
        if (byName.get(name) && byName.get(name).key === key) byName.delete(name);
        throw e;
      }
    }

    static async _load(name, base) {
      var desc = await Plugin.describe(name, { base: base });

      var path = nameToPath(name);
    if (!path) throw new Error('非法插件名: ' + JSON.stringify(name));
    var url = resolveUrl(base, path, desc);

      var api;
      if (desc.type === 'module') {
        var mod = await import(new URL(url, location.href).href);
        api = mod && mod.default !== undefined ? mod.default : mod;
      } else {
        /* 页面已经引过**这个 url** 的脚本 → 直接用，不重复执行。
           ★ 按 URL 判断，不看 window 上有没有同名全局 ——
             否则 load(name, {base}) 会拿到旧 base 的实现。 */
        if (!scriptAlreadyPresent(url)) {
          await loadScript(url);
        }
        if (desc.global) {
          api = window[desc.global];
          if (!api) {
            throw new Error(
              '插件没有导出全局变量 ' + desc.global + '（检查 description.json 的 global 字段）'
            );
          }
        }
      }

      /* 自检：描述里的名字和请求的名字对不上 → 目录放错了 */
      if (desc.name && desc.name !== lastSegment(path)) {
        console.warn('[plugin] description.json 的 name 是 "' + desc.name +
                     '"，但加载的是 "' + name + '"');
      }

      return api;
    }

    /**
     * 读插件的元信息（description.json），不加载实现。
     * @param {string} name
     * @param {Object} [opts]
     * @returns {Promise<Object>}
     */
    static async describe(name, opts) {
      var base = joinBase((opts && opts.base) || Plugin.base);

      if (!parseName(name)) {
        throw new Error('非法插件名: ' + JSON.stringify(name));
      }

      var path = nameToPath(name);
      if (!path) throw new Error('非法插件名: ' + JSON.stringify(name));
      var res = await fetch(base + path + '/description.json', { cache: 'no-cache' });
      if (!res.ok) {
        throw new Error('插件不存在或缺少 description.json: ' + name +
                        ' (HTTP ' + res.status + ')');
      }
      return await res.json();
    }

    /**
     * 取已加载的插件（同步）。没加载过返回 undefined。
     *
     * ★ 按**插件名**查，不按 base —— load 时用了别的 base 也查得到。
     *   同名在多个 base 下都 load 过时，返回**最后加载**的那份。
     * @param {string} name
     * @returns {*}
     */
    static get(name) {
      var rec = byName.get(name);
      return rec ? rec.api : undefined;
    }

    /** 插件是否已加载 */
    static has(name) {
      return byName.has(name);
    }

    /**
     * 清缓存。不给 name 则全清；给了 name 则该名字在**所有 base** 下的都清。
     * @param {string} [name]
     */
    static clear(name) {
      if (name === undefined) {
        cache.clear();
        byName.clear();
        registry.clear();
        return;
      }
      var keys = registry.get(name);
      if (keys) {
        keys.forEach(function (k) { cache.delete(k); });
      }
      registry.delete(name);
      byName.delete(name);
    }
  }

  /* 暴露到全局 —— 跟 dialog.js 一致 */
  if (typeof window !== 'undefined') window.Plugin = Plugin;
  if (typeof module !== 'undefined' && module.exports) module.exports = Plugin;
})();
