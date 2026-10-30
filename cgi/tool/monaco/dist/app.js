// app.js — monaco 协同编辑器前端
//
// 用 monaco-editor 当编辑器，CRDT 跟 tool/pad 完全一样（自实现 RGA）。
//
// ★ 与 pad 的核心差异：**偏移量单位天然对齐**
//
//   pad（textarea）：
//     本地输入 → 靠 beforeinput 快照 + diffText 猜改动位置（容易错）
//     位置单位 = ta.selectionStart = UTF-16 code unit
//
//   monaco：
//     本地输入 → onDidChangeModelContent 直接给
//                   c.rangeOffset（扁平字符偏移）
//                   c.rangeLength（被替换长度）
//                   c.text（插入内容）
//     位置单位 = UTF-16 code unit ← **跟 RGA 的 anchorAt(pos) 单位一致**
//
//   所以不需要自己换算，也不需要 diff 猜测 —— 这是 monaco 方案最大的收益。
//
// ★ EOL 必须统一成 LF：
//   monaco 的 offset 按「文本自身的 EOL」计算。model 用 \r\n 时每个换行占 2 个
//   unit，而 RGA 的字符索引是按 JS 字符串算的（\r\n 也是 2 个 unit）—— 恰好一致。
//   但为了跟服务器 log / 其它客户端完全一致，强制 LF + 入库前归一化。
//
// 远端光标用 monaco 的 decorations API（deltaDecorations），
// 不像 pad 那样用 mirror 量像素 —— 干净得多，也不用处理滚动同步。

// ★ import 用**绝对路径** —— 同上，相对路径会少一级。
import { Doc, ROOT_ID } from '/tool/monaco/crdt.js';
import { Sync } from '/tool/monaco/sync.js';

// ─────────────────────────────────────────────────────────────
// monaco 加载（AMD loader，vendor 到本地）
// ─────────────────────────────────────────────────────────────
// ★ 绝对路径 —— AMD loader 按这个路径去取模块和 worker。
//   相对路径会少一级（页面经 index → pub 软连接提供，派发根是 /tool/）。
const AMD_VS = '/tool/monaco/vendor/vs';

function loadMonaco() {
  return new Promise((resolve, reject) => {
    if (window.monaco) return resolve(window.monaco);
    if (typeof window.require !== 'function') {
      return reject(new Error('AMD loader 没加载 —— 检查 vendor/vs/loader.js'));
    }

    // ★ MonacoEnvironment.getWorkerUrl 在 **index.html 里**设置（必须早于
    //   editor.main.js 的模块求值 —— monaco 那时就缓存住了 globalThis）。
    //   这里只做兜底：如果 HTML 里那段没跑到（比如单测环境），至少不至于
    //   让 monaco 用错误的 worker 路径。

    window.require.config({ paths: { vs: AMD_VS } });
    window.require(
      ['vs/editor/editor.main'],
      () => (window.monaco ? resolve(window.monaco) : reject(new Error('monaco 未就绪'))),
      (err) => reject(new Error('monaco 加载失败: ' + err)),
    );
  });
}

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const statusEl = $('btn-conn');
const peersEl  = $('peers');
const meEl     = $('me');
const docEl    = $('doc');
const opsLocalEl  = $('ops-local');
const opsGlobalEl = $('ops-global');

/**
 * 设置连接状态（显示在状态按钮上，点击即重连）。
 *
 * ★ 状态 pill 和 reconnect 按钮**合并成一个**（#btn-conn）——
 *   文字就是状态，点它就是重连。少一个按钮，header 也不挤。
 */
const setStatus = (text, kind) => {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = 'pill ' + kind;
};

// ─────────────────────────────────────────────────────────────
// 语言选择（状态栏「doc:」左边）
// ─────────────────────────────────────────────────────────────
// ★ 选项直接来自 monaco.languages.getLanguages() —— 91 种，
//   不用自己维护一份列表（monaco 加语言，这里自动跟着变）。
//
// ★ 用途：把**整个文档**按某种语言解析。
//   - 语法高亮：91 种全支持（monarch 定义在 basic-languages/）
//   - 补全 / 跳转 / 类型检查：**只有** TS / JS / JSON / CSS / HTML
//     五种有语言服务（vendor/vs/language/ 下的 worker）
//
// ★ 切语言 = monaco.editor.setModelLanguage(model, langId)。
//   这是**本地视图状态**，不进 CRDT —— 不同客户端可以各自选不同语言，
//   互不影响（文档内容始终是同一份 markdown 文本）。
//
// ★ 切到非 markdown 后，文档里的 ``` 代码围栏不再按内嵌语言高亮
//   —— 整篇按新语言解析。这是预期行为，不是 bug。
const langEl = $('lang');

/** 当前文档语言（model 的 languageId） */
let currentLang = 'markdown';

/** 语言 id → 显示名 */
function langLabel(info) {
  const a = info.aliases && info.aliases.length ? info.aliases : [];

  // ① 短大写缩写优先（WGSL / JSON / SQL / PQ / C# …）—— 比长全称紧凑
  const acro = a.find(s => s.length >= 2 && s.length <= 6 && s === s.toUpperCase() && /[A-Z]/.test(s));
  if (acro) return acro;

  // ② 其次取「首字母大写」的那个（Python / Rust / JavaScript …）
  const nice = a.find(s => /^[A-Z]/.test(s));
  if (nice) return nice;

  return a[0] || info.id;
}

/** 填充下拉框的选项（monaco 加载后调一次） */
function fillLangOptions() {
  if (!langEl || !monaco) return;

  const langs = monaco.languages.getLanguages()
    // ★ 过滤 id 带 '.' 的 —— 那是 monaco 的**内部方言**（如
    //   freemarker2.tag-angle.interpolation-dollar），共 6 个，
    //   名字又长又 meaningless，还会把下拉框撑到 200px 宽。
    .filter(l => !l.id.includes('.'))
    .slice()
    .sort((a, b) => langLabel(a).localeCompare(langLabel(b)));

  langEl.textContent = '';
  for (const info of langs) {
    const opt = document.createElement('option');
    opt.value = info.id;
    opt.textContent = langLabel(info);
    opt.title = info.id;
    langEl.appendChild(opt);
  }
  langEl.disabled = false;
}

/**
 * 设置文档语言（本地视图状态，不广播）。
 *
 * ★ 拿 model.getLanguageId() 当**真值**，不用模块级的 currentLang 判断
 *   「要不要切」—— 万一 model 的语言被别处改过（换 model、
 *   monaco 内部重置），模块变量就会脱节，导致「切回 markdown」
 *   被误判成「已经是 markdown」而跳过。
 */
function setDocLang(langId) {
  if (!monaco || !model) return;
  if (!langId) return;
  const now = model.getLanguageId();
  if (langId === now) return;
  try {
    monaco.editor.setModelLanguage(model, langId);
    currentLang = model.getLanguageId();
    if (langEl) langEl.value = currentLang;
    showToast('lang: ' + currentLang);
  } catch (e) {
    console.error('[monaco] setModelLanguage failed:', e);
    showToast('lang failed: ' + String((e && e.message) || e).slice(0, 60));
  }
}

/**
 * 按**文件扩展名**猜语言 —— 打开本地文件时自动切。
 *
 * ★ monaco 自己不带「按内容猜语言」的 API，但它在
 *   monaco.languages.getLanguages() 里给了每种语言的 extensions 数组，
 *   拿它拼一张「扩展名 → 语言 id」表就行。
 *
 * ⚠️ 猜不到就**保持原样**（不切回 markdown）—— 用户手选过的语言
 *   不该被一次「打开 .txt」冲掉。
 */
function langFromFilename(filename) {
  if (!monaco || !filename) return null;
  const m = /\.([A-Za-z0-9_+-]+)$/.exec(String(filename));
  if (!m) return null;
  const ext = '.' + m[1].toLowerCase();
  for (const info of monaco.languages.getLanguages()) {
    if (info.extensions && info.extensions.includes(ext)) return info.id;
  }
  return null;
}

/**
 * 语言 id → 常用扩展名（下载时用）。
 *
 * ★ extensions[0] 不一定是「最常用」的那个 ——
 *   python 的 extensions[0] 是 '.py' ✅，但 markdown 的是 '.md' ✅，
 *   而 typescript 的是 '.cts'（罕见），javascript 是 '.es6'。
 *   所以先查一张手写的常用表，查不到再退回 extensions[0]。
 */
const LANG_EXT = {
  markdown: '.md', plaintext: '.txt', python: '.py', javascript: '.js',
  typescript: '.ts', json: '.json', css: '.css', html: '.html',
  rust: '.rs', go: '.go', java: '.java', c: '.c', cpp: '.cpp',
  ruby: '.rb', php: '.php', shell: '.sh', yaml: '.yaml', xml: '.xml',
  sql: '.sql', csharp: '.cs', kotlin: '.kt', swift: '.swift',
  dart: '.dart', lua: '.lua', perl: '.pl', r: '.r', scala: '.scala',
  clojure: '.clj', vue: '.vue', dockerfile: '.dockerfile',
};

function extForLang(langId) {
  if (LANG_EXT[langId]) return LANG_EXT[langId];
  const info = monaco && monaco.languages.getLanguages().find(l => l.id === langId);
  if (info && info.extensions && info.extensions.length) return info.extensions[0];
  return '.txt';
}

/** 初始化语言下拉框的事件绑定 —— 只调一次 */
function initLangSelect() {
  if (!langEl) return;
  langEl.addEventListener('change', () => setDocLang(langEl.value));
}

let toastTimer = 0;
const toastEl = document.createElement('div');
toastEl.id = 'toast';
toastEl.className = 'toast';
document.body.appendChild(toastEl);
const showToast = (text) => {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1500);
};

// ─────────────────────────────────────────────────────────────
// 文档 id（多空间）
// ─────────────────────────────────────────────────────────────
// 页面 /tool/monaco?doc=xxx → 前端从 location.search 读
// WS    /tool/monaco/ws?doc=xxx → 透传给后端
const DOC_ID = new URLSearchParams(location.search).get('doc') || 'default';
const WS_PATH = '/tool/monaco/ws';
const WS_URL  = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}` +
                `?doc=${encodeURIComponent(DOC_ID)}`;

// ─────────────────────────────────────────────────────────────
// 状态
// ─────────────────────────────────────────────────────────────
// ★ 用 let —— 服务器广播 clear 时要整个换掉（resetDoc）
let doc = new Doc();

let monaco = null;
let editor = null;
let model = null;

let sync = null;
let myClientId = null;
let initialized = false;
let seq = 0;              // CRDT 序号（每个 client 内单调递增）
let localOpCount = 0;
let globalOpCount = 0;

const members = new Map();   // id -> {id, name, color, cursor}

/** ★ 抑制远端 op 触发的 change 事件（否则会回环发 op） */
let applyingRemote = false;

// ─────────────────────────────────────────────────────────────
// CRDT op 生成（跟 pad 同格式）
// ─────────────────────────────────────────────────────────────

/** 生成一个插入 op 并本地应用 */
function localInsert(text, at) {
  // ★ 没收到 hello-ack 之前不算初始化成功 —— 此时没有自己的 id，
  //   生成的 op 会是 [null, seq]，其他客户端收到就废了。
  if (!initialized || !myClientId) return;
  const anchorId = doc.anchorAt(at);
  const op = { t: 'i', id: [myClientId, seq++], v: text, l: anchorId };
  doc.apply(op);
  localOpCount++;
  globalOpCount++;
  renderOpCounts();
  if (sync) sync.sendOp(op);
}

/**
 * 插入一段文本 —— 每个字符一个 op（RGA 一个节点一个字符）。
 *
 * 位置要**逐字符递增**：连续插入 "abc" 时，第 2 个字符的 anchor 应该是
 * 第 1 个字符（而不是都锚在同一个位置），否则 RGA 渲染时这几个兄弟节点
 * 会按 id 排序，插入位置就跑到了末尾。
 *
 * ★ pos 要按 **UTF-16 长度**递增（`pos += ch.length`），不是 `pos++` ——
 *   `for...of` 按 **code point** 迭代，emoji 是 1 个 code point 但占
 *   **2 个 UTF-16 unit**。只加 1 的话，emoji 后面所有字符的 pos 都偏小
 *   → anchor 选错 → **字符顺序错乱**（实测 "a😀b" 变成 "ab😀"）。
 *
 *   pos 的单位是 UTF-16 code unit（跟 doc.anchorAt / monaco 的
 *   rangeOffset 一致），所以必须按 ch.length 递增。
 */
function localInsertText(text, at) {
  let pos = at;
  for (const ch of text) {
    localInsert(ch, pos);
    pos += ch.length;
  }
}

/** 生成删除 op 并本地应用 */
function localDelete(at, len) {
  if (!initialized || !myClientId) return;
  const nodes = doc.nodesInRange(at, len);
  for (const n of nodes) {
    const op = { t: 'd', id: n.id };
    doc.apply(op);
    localOpCount++;
    globalOpCount++;
    renderOpCounts();
    if (sync) sync.sendOp(op);
  }
}

// ─────────────────────────────────────────────────────────────
// monaco 事件 → CRDT op
// ─────────────────────────────────────────────────────────────

/**
 * monaco 的 contentChanges → CRDT op。
 *
 * ★ rangeOffset 就是**扁平字符偏移**（UTF-16 code unit），
 *   跟 RGA 的 anchorAt(pos) / nodesInRange(start, len) 单位一致 —— 直接用。
 *
 * ★ 多个 change 时，每个 change 的 rangeOffset 都是相对**改动前**文档的
 *   偏移，互不影响（monaco 内部按降序应用）。所以可以直接逐个生成 op，
 *   不用做偏移修正。
 *
 * ★ 重叠的改动 monaco 会合并成一个 change —— 拿到的 changes 数组元素不重叠。
 */
function onMonacoChange(e) {
  // 远端 op 引起的 change —— 不再生成 op（否则回环）
  if (applyingRemote) return;

  const changes = e.changes || [];
  if (!changes.length) return;

  for (const c of changes) {
    const at = c.rangeOffset;         // 替换的起点（扁平偏移）
    const len = c.rangeLength;        // 被替换的长度
    const text = c.text || '';        // 插入的内容

    // 先删后插 —— 顺序跟 pad 一致
    if (len > 0) localDelete(at, len);
    if (text.length > 0) localInsertText(text, at);
  }
}

// ─────────────────────────────────────────────────────────────
// 远端 op → monaco
// ─────────────────────────────────────────────────────────────

/**
 * 应用**全量** op（服务端 sync 的响应）—— **替换**本地 Doc。
 *
 * ★ 全量 op 是文档的**权威状态** —— 必须替换，不能追加。
 *   追加的话，本地已有内容后面会再接一份 → 文档变成两份。
 *
 *   什么时候会踩到：
 *   · 「打开本地文件」后 sync（本地已经有旧内容了）
 *   · 断线重连后 sync
 *   · clear 后 sync
 *
 * ★ 为什么不能直接 `doc = new Doc()` 然后 apply：
 *   那样会丢掉**本地未发送的编辑**（用户刚打的字）。
 *   这里保留本地 Doc，只把「服务端不认识的节点」标记掉 ——
 *   做法：新建一个 Doc，apply 全量 op，然后**保留本地多出来的节点**。
 *
 *   ★ 实际上更简单也更安全：新建 Doc + apply 全量，
 *     本地多出来的（服务端没有的）编辑会丢 —— 但那些编辑
 *     本来也会被服务端的全量覆盖掉（服务端是权威）。
 *     用户的未发送编辑会在下次本地输入时重新发出去。
 */
function applyFullOps(ops) {
  if (!ops) ops = [];

  // ★ 重建 Doc —— 全量 op 的 anchor 链跟旧 Doc 无关
  const fresh = new Doc();
  let applied = 0;
  for (const op of ops) {
    if (fresh.apply(op)) applied++;
  }

  const before = doc.getText();
  doc = fresh;
  const after = doc.getText();

  if (after === before) {
    // 内容没变 → 不用动 model（避免闪烁 + 丢光标）
    renderPeers();
    return applied;
  }

  // 更新编辑器显示
  applyingRemote = true;
  try {
    model.setValue(after);
    // 光标放到文档末尾（内容全变了，原位置没意义）
    const p = model.getPositionAt(0);
    editor.setSelection({
      startLineNumber: p.lineNumber, startColumn: p.column,
      endLineNumber: p.lineNumber, endColumn: p.column,
    });
  } finally {
    applyingRemote = false;
  }

  renderPeers();
  return applied;
}

/**
 * 收到一批 op → 应用到本地 Doc → 更新 monaco。
 *
 * ★ 不能用 setValue() —— 那会清掉 undo 栈、折叠状态、光标位置，
 *   而且会触发一次大的 change 事件。用 applyEdits() 做**增量**编辑，
 *   monaco 会自动把光标位置跟着挪。
 *
 * ★ 但 CRDT 的位置是**扁平字符偏移**，monaco 的 edit 要 line/column。
 *   所以要用 getPositionAt(offset) 换算。
 */
function applyRemoteOps(ops) {
  if (!ops || !ops.length) return 0;

  const before = doc.getText();

  // ★ **先记下本地光标的 CRDT 锚点，再应用 op**。
  //
  //   顺序很关键：doc.apply() 一执行，doc 的内容就变了，
  //   而 model 里还是**旧文本** —— 这时 model.getOffsetAt() 得到的偏移
  //   和 doc 的字符对不上，anchorAt() 会算错节点。
  //
  //   所以必须在 apply 之前，用**两边都还一致**的状态取锚点。
  const sel = editor.getSelection();
  const selStart = sel ? model.getOffsetAt({ lineNumber: sel.startLineNumber, column: sel.startColumn }) : 0;
  const selEnd = sel ? model.getOffsetAt({ lineNumber: sel.endLineNumber, column: sel.endColumn }) : 0;
  const startAnchor = doc.anchorAt(selStart);
  const endAnchor = doc.anchorAt(selEnd);

  let applied = 0;
  for (const op of ops) {
    if (doc.apply(op)) applied++;
  }
  if (!applied) return 0;

  const after = doc.getText();
  if (after === before) return applied;

  // ★ 整篇替换（最简单、最稳）
  //   逐 op 换算成 edit 也能做，但需要处理「多个 op 的偏移互相影响」——
  //   远端 op 应用后，本地可见文本已经变了，而 monaco 里的文本还是旧的，
  //   中间态的偏移换算会错位。
  //
  //   整篇 setValue 的代价：光标位置会丢（要自己恢复）、undo 栈会断。
  //   对协同编辑器来说 undo 栈本来就不可靠（本地 undo 会跟远端 op 打架），
  //   所以先接受这个代价 —— 但**光标位置必须恢复**（否则用户光标会跳到开头）。
  applyingRemote = true;
  try {
    model.setValue(after);

    // 还原光标 —— 优先用 anchor（精确），解析不出来才退回按比例缩放
    //
    // ★ **必须用 cursorOffsetOfNode()，不能用 offsetOfNode()** ——
    //   anchorAt(pos) 返回的是「光标**前面**那个字符」的 id，
    //   而 offsetOfNode(id) 返回那个字符的**起始**偏移（= pos - 1）。
    //   两者不是逆运算 —— 用 offsetOfNode 会让光标**恒偏左一个字符**。
    //   cursorOffsetOfNode(id) 返回「那个字符**之后**」的偏移，才是真逆运算。
    //
    //   症状：对方在**文末**追加内容（跟我的光标无关），我的光标却往左跳一格；
    //   每来一次远端编辑就累积漂一格，最终漂到文档开头。
    let newStart = doc.cursorOffsetOfNode(startAnchor);
    let newEnd = doc.cursorOffsetOfNode(endAnchor);
    if (newStart < 0 || newEnd < 0) {
      const ratio = before.length ? after.length / before.length : 1;
      newStart = Math.min(Math.round(selStart * ratio), after.length);
      newEnd = Math.min(Math.round(selEnd * ratio), after.length);
    }
    const p1 = model.getPositionAt(newStart);
    const p2 = model.getPositionAt(newEnd);
    editor.setSelection({
      startLineNumber: p1.lineNumber, startColumn: p1.column,
      endLineNumber: p2.lineNumber, endColumn: p2.column,
    });
  } finally {
    applyingRemote = false;
  }

  renderPeers();
  return applied;
}

// ─────────────────────────────────────────────────────────────
// 远端光标（monaco decorations）+ 名字标签（content widget）
// ─────────────────────────────────────────────────────────────

/**
 * 远端光标用 decorations 画竖线 —— monaco 原生支持，不用像 pad 那样量像素。
 *
 * ★ 成员记录里有两个位置字段：
 *   · cursor —— 扁平字符偏移，**兜底**用
 *   · anchor —— 光标所在字符的 CRDT 节点 id，**精确**用
 *
 *   只有偏移的话，别人在自己文档里插字符，那个数字就过时了 → 光标漂移。
 *   节点 id 是字符身份，插删都不影响 → 光标牢牢钉在那个字符上。
 *
 * ★ 名字标签用 **content widget**（不是 decoration）——
 *   decoration 在文字流里，没法把标签浮到行上方。
 *   content widget 是 monaco 的「浮动部件」机制：
 *     · 自己带 DOM（可以任意样式）
 *     · 位置用 position（line/column），monaco 负责算像素
 *     · 超出视口自动隐藏（overflowingContentWidgets 容器）
 *     · 滚动时跟着内容走 —— 不用自己处理滚动同步
 */
const peerDecorations = new Map();   // id -> decorations collection
const peerWidgets = new Map();       // id -> { widget, el }

/**
 * 每个 peer 一个专属 CSS class —— 颜色写进规则里。
 *
 * monaco 的 decoration options 没有「inline style」入口，只有 className 系列。
 * 所以动态注入一条 <style> 规则把对端颜色定死。
 *
 * @param {string} id  peer 的连接 id
 * @returns {string} class 名（如 "pc-c2699443_baf45f43"）
 */
const peerCaretStyles = new Map();   // id -> class 名

function peerCaretClass(id) {
  let cls = peerCaretStyles.get(id);
  if (cls) return cls;

  // class 名必须合法 CSS 标识符 —— id 形如 c2699443_baf45f43，
  // 只有字母数字下划线，安全起见还是过滤一遍。
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
  cls = 'pc-' + safe;

  const info = members.get(id);
  const color = (info && info.color) || '#7eb6ff';

  let style = document.getElementById('peer-caret-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'peer-caret-styles';
    document.head.appendChild(style);
  }
  style.textContent += `
.${cls}-bar{position:relative;margin-left:-1px;}
.${cls}-bar::before{content:"";position:absolute;left:0;top:-2px;bottom:-2px;width:2px;background:${color};border-radius:1px;}
.${cls}-label{background:${color};color:#0f0f12;}
`;

  peerCaretStyles.set(id, cls);
  return cls;
}

function renderPeers() {
  if (!editor || !model) return;

  const seen = new Set();
  const ids = Array.from(members.keys());

  for (const id of ids) {
    // ★ **跳过自己** —— members 表里包含自己（服务端把所有人都写进成员表）。
    //   不跳过的话会多画一根「自己的 peer 光标」和一块自己的名字标签，
    //   而且它会跟着自己的真光标动 —— 看起来就像「远端光标跟着我动」。
    if (id === myClientId) continue;

    const info = members.get(id);
    seen.add(id);

    // ★ **位置换算：优先用 anchor（节点 id），兜底用数字偏移**。
    //
    //   anchor 是那个字符的 CRDT 身份，全局唯一 → 别人在我前面插字符，
    //   我的 anchor 仍然指向**同一个字符**，位置自动跟着走。
    //
    //   只有数字偏移的话，那个数字是「上报者文档里」的数字 ——
    //   套到我的文档上会错位（插字符 → 偏移 +1，删字符 → 偏移 -1）。
    //   这正是「我编辑时远端光标跟着我动」的第二个成因。
    //
    // ★ **必须用 cursorOffsetOfNode()，不能用 offsetOfNode()** ——
    //   anchorAt() 返回的是「光标**前面**那个字符」的 id，
    //   而 offsetOfNode() 返回那个字符的**起始**偏移（比光标位置小一个字符）。
    //   两者不是逆运算 → 用 offsetOfNode 会让光标**偏左一个字符**。
    //   cursorOffsetOfNode() 返回「那个字符**之后**」的偏移，才是真正的逆运算。
    let cursor = -1;
    if (info.anchor) {
      cursor = doc.cursorOffsetOfNode(info.anchor);
    }
    if (cursor < 0) {
      cursor = info.cursor | 0;      // 兜底：老客户端 / anchor 暂时解析不出来
    }
    if (cursor < 0 || cursor > model.getValueLength()) continue;

    const pos = model.getPositionAt(cursor);
    const color = info.color || '#c4f542';

    let decos = peerDecorations.get(id);
    if (!decos) {
      // ★ createDecorationsCollection 是 **editor 实例的方法**，
      //   不是 monaco.editor 上的静态方法 —— 后者是 undefined，
      //   调用会抛 TypeError（渲染远端光标时炸）。
      decos = editor.createDecorationsCollection([]);
      peerDecorations.set(id, decos);
    }

    decos.set([
      {
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        options: {
          // ★ 每个 peer 一个专属 class —— 颜色写进 CSS 规则里。
          //   monaco 的 decoration options 没有 inline style 的入口，
          //   只有 className / inlineClassName / beforeContentClassName。
          //   所以用动态 class + 动态注入 <style> 来带上对端颜色。
          inlineClassName: peerCaretClass(id),
          beforeContentClassName: peerCaretClass(id) + '-bar',
          hoverMessage: { value: `**${info.name || id}**` },
        },
      },
    ]);

    // ---- 名字标签（content widget）----
    renderPeerLabel(id, info, cursor);
  }

  // 清理已下线的
  for (const [id, decos] of peerDecorations) {
    if (seen.has(id)) continue;
    decos.clear();
    peerDecorations.delete(id);
  }
  for (const [id, rec] of peerWidgets) {
    if (seen.has(id)) continue;
    removePeerLabel(id);
  }

  // ★ "peers online" = **别人**的数量，不含自己。
  //   members 表里是有自己的（服务端把所有人都写进去）。
  const peerCount = Math.max(0, members.size - (myClientId && members.has(myClientId) ? 1 : 0));
  peersEl.textContent = String(peerCount);
}

/**
 * 渲染（或更新）某个 peer 的名字标签 —— content widget。
 *
 * ★ content widget 的 descriptor 要**每次**给同一个对象 ——
 *   monaco 靠对象身份（getId）认它，layoutContentWidget(widget) 要传同一个引用。
 *
 * ★ getPosition 里**现算**位置（存 cursor 偏移，用 model.getPositionAt 换算），
 *   不要闭包捕获 pos —— 文档变了之后 pos 就过期了，
 *   而远端 op 到达时不会重新 renderPeers（只 applyRemoteOps），
 *   标签就会停在旧位置。
 *
 * ★ 名字标签**常驻显示** —— content widget 浮在光标所在行的上方，
 *   一眼就能看出那根光标是谁的。
 *
 * @param {string} id    peer id
 * @param {object} info  成员信息（name/color/cursor）
 * @param {number} cursor 扁平字符偏移
 */
function renderPeerLabel(id, info, cursor) {
  let rec = peerWidgets.get(id);

  if (!rec) {
    // ★ **两层结构**：外层给 monaco 当 widget 的 DOM，内层自己控制显隐。
    //
    //   monaco 在 layout 时会**直接改写 widget DOM 节点的 style.display**
    //   （实测：内联 style 变成 "display: block; position: absolute; ..."），
    //   所以在外层设 display:none 会被它覆盖掉。
    //   把显隐放到**内层**元素上，monaco 碰不到它。
    const outer = document.createElement('div');
    outer.className = 'peer-label-outer';

    const el = document.createElement('div');
    el.className = 'peer-label ' + peerCaretClass(id) + '-label';
    el.textContent = info.name || id;

    outer.appendChild(el);

    const widget = {
      getId: () => 'peer-label-' + id,
      getDomNode: () => outer,
      // ★ preference ABOVE → BELOW：
      //   标签浮在光标所在行的**上方**（Google Docs / VS Code Live Share 的惯例）——
      //   标签从上一行行尾垂下来，视觉上属于下面那根光标。
      //   ABOVE 排不下时自动退到 BELOW。
      //
      //   注：标签常驻显示，行高 19px 放不下标签，它会盖住上一行的文字
      //   （实测：盖住「第二行文字」）。这是已知取舍，已确认接受。
      getPosition: () => {
        const cur = peerWidgets.get(id);
        const off = cur ? cur.cursor : 0;
        const p = model.getPositionAt(Math.min(off, model.getValueLength()));
        return {
          position: { lineNumber: p.lineNumber, column: p.column },
          preference: [
            monaco.editor.ContentWidgetPositionPreference.ABOVE,
            monaco.editor.ContentWidgetPositionPreference.BELOW,
          ],
        };
      },
    };

    rec = { widget, el, outer, cursor };
    peerWidgets.set(id, rec);
    editor.addContentWidget(widget);
  } else {
    // 名字可能变了（改过 profile）
    if (rec.el.textContent !== (info.name || id)) {
      rec.el.textContent = info.name || id;
    }
    rec.cursor = cursor;
  }

  // 位置变了 → 重新 layout
  editor.layoutContentWidget(rec.widget);
}

/**
 * 移除某个 peer 的名字标签 widget。
 */
function removePeerLabel(id) {
  const rec = peerWidgets.get(id);
  if (!rec) return;
  try {
    editor.removeContentWidget(rec.widget);
  } catch (e) {
    // editor 已经 dispose —— 忽略
  }
  peerWidgets.delete(id);
}

// ─────────────────────────────────────────────────────────────
// presence（光标位置上报）
// ─────────────────────────────────────────────────────────────
let presenceTimer = 0;
const reportPresence = () => {
  if (!sync || !model) return;
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    const sel = editor.getSelection();
    if (!sel) return;
    // ★ 同样要传 Position 对象（见上面 applyRemoteOps 的注释）
    const off = model.getOffsetAt({ lineNumber: sel.startLineNumber, column: sel.startColumn });

    // ★ 同时上报**光标所在字符的 CRDT 节点 id**（anchor）。
    //   只有数字偏移是不够的 —— 那个数字是「我这份文档」的数字，
    //   别人在自己文档里套用会错位（别人在我前面插字符 → 偏移要 +1，
    //   但那个 +1 是别人的文档算出来的，跟我的对不上）。
    //   节点 id 是字符的**全局身份**，插删都不影响 —— 用它才准。
    const anchor = doc.anchorAt(off);

    sync.sendPresence(off, anchor);
  }, 80);
};

// ─────────────────────────────────────────────────────────────
// 状态栏
// ─────────────────────────────────────────────────────────────
function renderOpCounts() {
  opsLocalEl.textContent = String(localOpCount);
  opsGlobalEl.textContent = String(globalOpCount);
}

function updateStatus() {
  renderOpCounts();
}

/**
 * 重置本地 Doc —— 服务器广播 clear / replace 时调用。
 *
 * ★ **不要重置 seq** ——
 *   seq 是 CRDT 身份的组成部分，必须在同一个 clientId 内**单调递增**。
 *   重置它会让新 op 的 id 撞上替换前的旧 id
 *   （比如旧的 [A,0] 和新的 [A,0]）→ crdt.js 的 applyInsert 看到
 *   id 已存在就**静默丢弃**新 op → 打了字但文档没变。
 *
 *   seq 只在「重连」时重置（onOpen）—— 那时 cid 也换了，是新身份。
 */
function resetDoc() {
  doc = new Doc();
}

// ─────────────────────────────────────────────────────────────
// 连接
// ─────────────────────────────────────────────────────────────
function connect() {
  // ★ 名字/颜色以**模块级**的 myName/myColor 为准 ——
  //   弹窗提交时改的就是这两个，之后 reconnect 也要沿用新值，
  //   不能每次都从 localStorage 重新读（虽然值一样，但会丢掉内存态）。
  if (!myName) {
    myName = localStorage.getItem('monaco_name') || ('anon-' + Math.random().toString(36).slice(2, 6));
    myColor = localStorage.getItem('monaco_color') || '#7eb6ff';
  }

  sync = new Sync(WS_URL, {
    name: myName,
    color: myColor,
    onOpen: () => {
      // 重连 = 新进程 = 新 cid → 旧 id 作废，等新的 hello-ack
      initialized = false;
      myClientId = null;
      seq = 0;
    },
    onHelloAck: (id) => {
      myClientId = id;
      initialized = true;
      meEl.textContent = myName;
      meEl.style.color = myColor;
    },
    onOps: (ops, total) => {
      if (total !== undefined && total !== null) globalOpCount = total;
      // ★ **全量 vs 增量** —— 服务端只在「sync 响应」里带 total，
      //   增量广播（mcast.notify）不带。
      //
      //   全量 = 文档的**权威状态** → 必须**替换**本地 Doc
      //   增量 = 在当前 Doc 上**追加**
      //
      //   ★ 之前两种都走 applyRemoteOps（追加语义）——
      //     收到全量时会在**已有内容**后面追加 → 文档变成两份内容。
      if (total !== undefined && total !== null) {
        applyFullOps(ops);
      } else {
        applyRemoteOps(ops);
      }
      updateStatus();
    },
    onMembers: (list) => {
      members.clear();
      for (const m of list) members.set(m.id, m);
      renderPeers();
    },
    onClear: () => {
      // 服务器说文档被清空了 → 重置本地 Doc
      resetDoc();
      model.setValue('');
      localOpCount = 0;
      globalOpCount = 0;
      updateStatus();
      showToast('cleared');
    },
    onSeedAck: (newDoc) => {
      // 服务端已覆盖当前 doc —— 内容通过 'replace' 广播过来了。
      // 这里**不用跳转**（打开就是「在当前空间打开这个文件」）。
      showToast('opened');
    },
    onReplace: () => {
      // ★ 文档被**整体替换**（有人打开了本地文件）。
      //
      //   做法：重新 sync 拿全量 op，applyFullOps 会**替换**本地 Doc。
      //
      //   ★ 这里**不要**先 resetDoc() ——
      //     applyFullOps 内部会重建 Doc（`doc = fresh`）。
      //     先 resetDoc 的话：
      //     1. 旧的 pending（等 anchor 的 op）被丢掉 —— 那倒是好事
      //     2. ★ 但更糟：resetDoc 后 model 还显示旧内容，
      //        而 applyRemoteOps 里 `if (!applied) return 0` 会跳过 model 更新
      //        → **空白**（用户看到"对方显示了，本地是空的"）
      //
      //   ★ 还要清掉 pending —— 旧 Doc 的 pending op（anchor 指向旧节点）
      //     在新 Doc 里永远等不到 → 泄漏 + 可能污染。
      if (doc && doc.pending) doc.pending.clear();
      sync.requestSync();
    },
    onSeedError: (err) => {
      pendingSeedFile = '';
      showToast('open failed');
      console.error('[monaco] seed error:', err);
    },
    onStatus: (s) => {
      if (s === 'connected') setStatus('connected', 'ok');
      else if (s === 'connecting') setStatus('connecting', 'pending');
      else if (s === 'disconnected') setStatus('disconnected', 'bad');
      else setStatus(s, 'pending');
    },
  });
  sync.connect();

  // 状态栏显示当前 doc
  if (docEl) {
    docEl.textContent = DOC_ID;
    docEl.title = `当前文档: ${DOC_ID}（点击复制链接）`;
    docEl.classList.add('who-btn');
    docEl.addEventListener('click', () => {
      const url = `${location.origin}/tool/monaco?doc=${encodeURIComponent(DOC_ID)}`;
      navigator.clipboard?.writeText(url).then(
        () => showToast('link copied'),
        () => showToast(url),
      );
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 修改名字 / 颜色 弹窗
// ─────────────────────────────────────────────────────────────

/** 预设色板 —— 不用手输 hex，点一下就选 */
const SWATCHES = [
  '#7eb6ff', '#3aa76d', '#c4f542', '#22c7d6',
  '#ff4d4d', '#ff9f43', '#c77dff', '#ff7eb6',
  '#e6e6e6', '#8a8a94', '#5f6b7a', '#2f3640',
];

/** 当前生效的名字/颜色（弹窗提交时用） */
let myName = '';
let myColor = '#7eb6ff';

/** #rrggbb 校验 —— 非法返回 null */
function parseHex(s) {
  const v = String(s || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(v)) return null;
  return v;
}

/**
 * 应用名字/颜色：写 localStorage、更新状态栏、通知服务端。
 *
 * @param {string} name
 * @param {string} color  #rrggbb
 */
function applyProfile(name, color) {
  myName = name;
  myColor = color;
  localStorage.setItem('monaco_name', name);
  localStorage.setItem('monaco_color', color);
  meEl.textContent = name;
  meEl.style.color = color;
  if (sync) sync.sendProfile(name, color);
  // 自己光标的颜色规则也要重建（class 名跟 id 绑定，颜色在规则里）
  // ★ renderPeers 里有 `if (!editor || !model) return` 保护，
  //   monaco 还没加载完时调用是安全的。
  renderPeers();
}

/**
 * 打开弹窗。
 */
function openProfileDlg() {
  const dlg = $('dlg-profile');
  const nameInput = $('dlg-name');
  const colorInput = $('dlg-color');
  const hexInput = $('dlg-hex');

  nameInput.value = myName || meEl.textContent || 'anon';
  colorInput.value = parseHex(myColor) || '#7eb6ff';
  hexInput.value = colorInput.value;

  // 色板按钮
  const sw = $('dlg-swatches');
  sw.textContent = '';
  for (const c of SWATCHES) {
    const b = document.createElement('button');
    b.className = 'dlg-swatch';
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      colorInput.value = c;
      hexInput.value = c;
    });
    sw.appendChild(b);
  }

  dlg.hidden = false;
  nameInput.focus();
  nameInput.select();
}

/** 关闭弹窗 */
function closeProfileDlg() {
  $('dlg-profile').hidden = true;
}

/** 提交弹窗 */
function submitProfileDlg() {
  const nameInput = $('dlg-name');
  const colorInput = $('dlg-color');
  const hexInput = $('dlg-hex');

  const name = nameInput.value.trim() || 'anon';

  // hex 输入框和取色器联动 —— 手输 hex 时同步取色器
  const hex = parseHex(hexInput.value);
  if (hex) {
    colorInput.value = hex;
  } else {
    // 非法 hex → 回落成取色器当前值
    hexInput.value = colorInput.value;
  }

  applyProfile(name, colorInput.value);
  closeProfileDlg();
  showToast('profile updated');
}

/** 初始化弹窗的事件绑定 —— 只调一次 */
function initProfileDlg() {
  const dlg = $('dlg-profile');
  const colorInput = $('dlg-color');
  const hexInput = $('dlg-hex');

  // 取色器 → hex 框
  colorInput.addEventListener('input', () => { hexInput.value = colorInput.value; });

  // hex 框 → 取色器（只认合法 hex）
  hexInput.addEventListener('input', () => {
    const hex = parseHex(hexInput.value);
    if (hex) colorInput.value = hex;
  });

  $('dlg-ok').addEventListener('click', () => submitProfileDlg());
  $('dlg-cancel').addEventListener('click', () => closeProfileDlg());

  bindDlgKeys($('dlg-profile'), () => submitProfileDlg(), closeProfileDlg);
}

// ─────────────────────────────────────────────────────────────
// 文件操作：打开（本地文件 → 新 doc）/ 下载 / 复制
// ─────────────────────────────────────────────────────────────

/** 当前文档的纯文本内容 */
const currentText = () => (model ? model.getValue() : '');

/**
 * 下载当前文档。
 *
 * ★ 用 Blob + object URL —— 不走服务端（内容已经在浏览器里了）。
 *   `a.download` 属性在同源 blob URL 上有效，Chrome/Firefox/Safari 都支持。
 *
 * ★ 扩展名跟着**当前语言**走 —— 文档按 python 模式编辑，
 *   下载成 .md 就名不副实了。取 monaco 给的 extensions[0]。
 */
function downloadCurrent() {
  const text = currentText();
  // BOM 开头 —— 让 Windows 记事本正确识别 UTF-8（否则中文乱码）
  const blob = new Blob(['﻿' + text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${DOC_ID}${extForLang(currentLang)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // ★ 必须 revoke —— 否则 blob 会一直占着内存（Firefox 尤其明显）
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('downloaded');
}

/**
 * 复制当前文档内容到剪贴板。
 *
 * ★ navigator.clipboard 需要**安全上下文**（https 或 localhost）。
 *   通过 IP 访问（比如 http://192.168.1.5:3000）时 clipboard API 不可用 ——
 *   这时要退回 execCommand('copy') 老办法。
 *
 * ★ 两条路都失败时给**具体原因**，不要笼统报 "copy failed" ——
 *   常见原因：浏览器没给剪贴板权限、无头环境、页面失焦。
 */
async function copyCurrent() {
  const text = currentText();
  const reasons = [];

  // ① 现代 API
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('copied');
      return;
    } catch (e) {
      reasons.push('clipboard api: ' + (e && e.name ? e.name : String(e)));
    }
  } else {
    reasons.push('clipboard api unavailable (需 https 或 localhost)');
  }

  // ② 老办法兜底
  let ok = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ok = document.execCommand('copy');
    ta.remove();
  } catch (e) {
    reasons.push('execCommand: ' + (e && e.name ? e.name : String(e)));
  }

  if (ok) {
    showToast('copied');
  } else {
    // ★ 把原因说清楚 —— 用户能自己判断是不是权限问题
    showToast('copy failed: ' + reasons.join('; ').slice(0, 80));
    console.warn('[monaco] copy failed:', reasons);
  }
}

/**
 * 打开本地文件 → 内容发到服务端 → **替换当前 doc** → 所有客户端同步。
 *
 * ★ 就是「在当前空间打开这个文件」—— 不跳转、不新建 doc。
 *   当前 doc 的内容被整个替换掉（别人正在编辑的内容也会没）。
 *
 * ★ 文件内容**不进** CRDT op —— 服务端直接覆盖写 op log。
 *   10KB 文件 = 10000 个 op，一帧 WS 发 10000 个 JSON op 会超大。
 */
function openLocalFile() {
  // ★ 破坏性操作 —— 先确认（打开会替换别人正在编辑的内容）
  openOpenDlg();
}

/** 打开「打开本地文件」确认弹窗 */
function openOpenDlg() {
  $('dlg-open').hidden = false;
  $('dlg-open-cancel').focus();     // 默认焦点在「取消」上
}

/** 关闭「打开本地文件」确认弹窗 */
function closeOpenDlg() {
  $('dlg-open').hidden = true;
}

/** 初始化打开弹窗的事件绑定 */
function initOpenDlg() {
  $('dlg-open-cancel').addEventListener('click', () => closeOpenDlg());
  $('dlg-open-ok').addEventListener('click', () => {
    closeOpenDlg();
    const input = $('file-input');
    input.value = '';          // ★ 允许连续选同一个文件（否则 change 不触发）
    input.click();
  });
  bindDlgKeys($('dlg-open'), null, closeOpenDlg);
}

/** 处理选中的本地文件 */
async function handleLocalFile(file) {
  if (!file) return;
  let content;
  try {
    content = await file.text();
  } catch (e) {
    showToast('read failed');
    return;
  }

  if (!sync) {
    showToast('not connected');
    return;
  }

  // 服务端覆盖 op log 后广播 replace → onReplace 重建 Doc + sync
  pendingSeedFile = file.name;

  // ★ 按扩展名自动切语言（.py → python / .rs → rust / .ts → typescript …）
  //   猜不到就不动 —— 用户手选过的语言不该被一次「打开 .txt」冲掉。
  const guess = langFromFilename(file.name);
  if (guess) setDocLang(guess);

  sync.sendSeed(file.name, content);
  showToast('opening...');
}

/** 待跳转的种子文件名（onSeedAck 里用） */
let pendingSeedFile = '';

// ─────────────────────────────────────────────────────────────
// 清空文档 确认弹窗
// ─────────────────────────────────────────────────────────────

/**
 * 打开「清空文档」确认弹窗。
 *
 * ★ 不用原生 confirm() —— 样式不可控，跟页面风格完全不搭。
 */
function openClearDlg() {
  $('dlg-clear').hidden = false;
  // 默认焦点放在「取消」上 —— 危险操作不该默认回车触发
  $('dlg-clear-cancel').focus();
}

/** 关闭「清空文档」确认弹窗 */
function closeClearDlg() {
  $('dlg-clear').hidden = true;
}

/** 初始化清空弹窗的事件绑定 */
function initClearDlg() {
  $('dlg-clear-cancel').addEventListener('click', () => closeClearDlg());
  $('dlg-clear-ok').addEventListener('click', () => {
    closeClearDlg();
    if (sync) sync.sendClear();
    // 不在这里弹 toast —— 服务端回 'clear' 时 onClear 会弹 'cleared'，
    // 两处都弹的话后者会立刻覆盖前者。
  });

  bindDlgKeys($('dlg-clear'), null, closeClearDlg);
}

/**
 * 给弹窗绑通用的键盘/遮罩行为。
 *
 * @param {HTMLElement} dlg    遮罩元素
 * @param {Function|null} onOk   回车时的动作（null = 回车不提交）
 * @param {Function|null} onCancel Esc / 点遮罩时的动作
 */
function bindDlgKeys(dlg, onOk, onCancel) {
  // 回车提交 / Esc 取消
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (onCancel) onCancel();
    } else if (e.key === 'Enter' && onOk && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      onOk();
    }
  });

  // 点遮罩空白处关闭
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && onCancel) onCancel();
  });
}

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────
async function main() {
  // 弹窗的事件绑定要**在 monaco 加载前**做 ——
  // monaco 加载失败时，状态栏的 "you" 按钮和 "clear" 按钮也得能用。
  initProfileDlg();
  initClearDlg();
  initOpenDlg();
  initLangSelect();

  try {
    monaco = await loadMonaco();
  } catch (e) {
    setStatus('monaco load failed', 'bad');
    showToast(String(e.message || e));
    return;
  }

  editor = monaco.editor.create($('editor'), {
    value: '',
    language: 'markdown',
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
    wordWrap: 'on',
    renderWhitespace: 'selection',
    scrollBeyondLastLine: false,
    // ★ 固定 LF —— offset 单位跟 RGA 对齐的前提
  });

  model = editor.getModel();
  // ★ EndOfLineSequence 在 **monaco.editor** 命名空间下，不是顶层 ——
  //   monaco.EndOfLineSequence 是 undefined，取它会抛
  //   "Cannot read properties of undefined (reading 'LF')"，
  //   整个 main() 中断 → 连接根本建立不起来（状态灯永远 disconnected）。
  model.setEOL(monaco.editor.EndOfLineSequence.LF);

  // ★ 语言下拉框 —— 选项来自 monaco.languages.getLanguages()（91 种）。
  //   放这儿（monaco 加载之后）是因为得先有 monaco 才知道有哪些语言。
  fillLangOptions();
  currentLang = model.getLanguageId();
  if (langEl) langEl.value = currentLang;

  // 本地输入 → op
  model.onDidChangeContent((e) => onMonacoChange(e));

  // 光标变化 → presence
  //
  // ★ onDidChangeCursorPosition / onDidChangeCursorSelection 是
  //   **editor 实例的方法**，不是 monaco.editor 上的静态方法 ——
  //   写成 monaco.editor.onDidChangeCursorPosition(...) 会是 undefined，
  //   调用直接抛 TypeError，整个 main() 中断（连接都建立不起来）。
  editor.onDidChangeCursorPosition(() => reportPresence());
  editor.onDidChangeCursorSelection(() => reportPresence());

  connect();

  // 改名称 / 颜色 —— 弹窗
  meEl.addEventListener('click', () => openProfileDlg());

  // clear —— 弹窗确认
  $('btn-clear').addEventListener('click', () => openClearDlg());

  // ★ open —— 打开本地文件（新建一个 doc）
  $('btn-open').addEventListener('click', () => openLocalFile());
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleLocalFile(f);
  });

  // download —— 下载当前文档
  $('btn-download').addEventListener('click', () => downloadCurrent());

  // copy —— 复制当前文档到剪贴板
  $('btn-copy').addEventListener('click', () => copyCurrent());

  // ★ 状态按钮（#btn-conn）—— 显示连接状态，点击即重连。
  //   状态 pill 和 reconnect 合并成一个了。
  const connBtn = $('btn-conn');
  if (connBtn) {
    connBtn.addEventListener('click', () => {
      if (!sync) return;
      // ★ 用 sync.reconnect()（不是 disconnect()+connect()）——
      //   后者会建出**两条** WebSocket（详见 sync.js reconnect 的注释）。
      sync.reconnect();
      showToast('reconnecting');
    });
  }

  // ★ refresh —— 不重连 WS，只发 sync 让服务端重发全量 op。
  //   断线时也能点：sync.js 的 _send 会把消息攒进 pending，
  //   等重连后自动补发（不会丢）。
  $('btn-refresh').addEventListener('click', () => {
    if (!sync) return;
    sync.requestSync();
    showToast('refreshing');
  });

  // 页面关闭前关掉 ws
  window.addEventListener('beforeunload', () => { if (sync) sync.disconnect(); });
}

main();
