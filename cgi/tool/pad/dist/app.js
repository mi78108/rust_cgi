// app.js — 协作编辑器（普通 js，无框架）
//
//   WS → /tool/pad/ws
//
// CRDT 是自己实现的 RGA（crdt.js），网络层是 sync.js。
// 没有第三方依赖。
//
// ─────────────────────────────────────────────────────────────
// 输入 → op 的转换（最容易出错的地方）
//
//   用户按下一个键 'H'：
//     beforeinput → 记下 before = {value, start, end}   ← 此时 value 还是旧的
//     input       → 浏览器已经把 value 改了
//                  diff(before.value, el.value) → 算出插了什么 / 删了什么
//                  → 生成 op
//
//   关键：必须在 beforeinput 里快照。input 时已经拿不到"改之前长什么样"了。
//
//   IME（中文输入法）：compositionstart/end 期间不能生成 op，
//   否则会把拼音中间态也同步出去。
//
// ─────────────────────────────────────────────────────────────
// 本地 op 不经过网络绕一圈
//
//   本地输入 → 直接 apply 到本地 Doc（保证零延迟）+ 发到服务器
//   收到自己的 op（服务器会回吗？会 —— echo）→ apply 是幂等的，直接忽略
//
// ─────────────────────────────────────────────────────────────
// 光标位置变换
//
//   远端 op 应用后，本地光标要跟着挪，否则接着打字会插错位置。

import { Doc, ROOT_ID, compareId, idKey, transformPosition } from './crdt.js';
import { Sync } from './sync.js';

// ── DOM ─────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const ta       = $('ta');
const statusEl = $('status');
const peersEl  = $('peers');
const opsEl    = $('ops');
const meEl     = $('me');
const toastEl  = $('toast');

// ── 常量 ────────────────────────────────────────────────────
const WS_PATH = '/tool/pad/ws';
const WS_URL  = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;

const PEER_COLORS = ['#ff7eb6', '#7eb6ff', '#ffd07e', '#7effc4', '#d07eff'];

// ── 状态 ────────────────────────────────────────────────────
let doc = new Doc();
let sync = null;
let myName = 'anon';
let myColor = PEER_COLORS[0];
let opCount = 0;
let seq = 0;

/** 本地 seq 计数器 —— id = [clientId, seq]，全序比较要用 */
let myClientId = '';

/** 远端光标 DOM: clientId → { el, label, name, color, cursor } */
const peerEls = new Map();

/** 成员表: clientId → {id,name,color,cursor} */
let members = new Map();

// ── toast ───────────────────────────────────────────────────
let toastTimer = 0;
const showToast = (msg) => {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1500);
};

// ── 状态灯 ──────────────────────────────────────────────────
const setStatus = (text, kind) => {
  statusEl.textContent = text;
  statusEl.className = 'pill ' + kind;
};

// ── clientId ────────────────────────────────────────────────
// 必须是 [clientId, seq] 里的 clientId —— 任意唯一字符串都行，
// 但要能字典序比较（compareId 用它做 tiebreak）。
function newClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const h = (n) => {
    const buf = new Uint8Array(n);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
    else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
    return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  };
  return h(4) + h(2) + h(2) + h(2) + h(6);
}

// ── 光标位置测量 ────────────────────────────────────────────
// 用 mirror（隐藏的同排版文本）量出第 cursor 个字符的像素位置。
const mirror = $('mirror');
const anchor = $('anchor');

function cursorPoint(cursor) {
  const text = ta.value.slice(0, cursor);
  mirror.textContent = text;
  mirror.appendChild(anchor);
  const a = anchor.getBoundingClientRect();
  const f = mirror.parentElement.getBoundingClientRect();
  return { x: a.left - f.left, y: a.top - f.top };
}

// ── 渲染远端光标 ────────────────────────────────────────────
function renderPeers() {
  const layer = document.querySelector('.cursor-layer');
  if (!layer) return;

  const seen = new Set();

  for (const [id, p] of members) {
    if (id === myClientId) continue;
    seen.add(id);

    let rec = peerEls.get(id);
    if (!rec) {
      const el = document.createElement('div');
      el.className = 'peer-cursor';
      const label = document.createElement('div');
      label.className = 'peer-label';
      el.appendChild(label);
      layer.appendChild(el);
      rec = { el, label, name: '', color: '', cursor: -1 };
      peerEls.set(id, rec);
    }

    if (rec.cursor === p.cursor && rec.name === p.name && rec.color === p.color) continue;

    const pt = cursorPoint(p.cursor ?? 0);
    rec.el.style.left = pt.x + 'px';
    rec.el.style.top = pt.y + 'px';
    rec.el.style.setProperty('--peer-color', p.color || 'var(--cyan)');
    rec.label.textContent = p.name || 'anon';
    rec.cursor = p.cursor;
    rec.name = p.name;
    rec.color = p.color;
  }

  for (const [id, rec] of peerEls) {
    if (!seen.has(id)) { rec.el.remove(); peerEls.delete(id); }
  }
}

function clearPeerEls() {
  for (const rec of peerEls.values()) rec.el.remove();
  peerEls.clear();
}

// ── 应用远端 op ─────────────────────────────────────────────
/**
 * 收到一批 op → 应用到本地 Doc → 更新 textarea + 变换光标。
 * @param {Array} ops
 */
function applyRemoteOps(ops) {
  if (!ops || !ops.length) return;

  const before = ta.value;
  const selStart = ta.selectionStart;
  const selEnd = ta.selectionEnd;

  // 记录应用前后的位置变化，用于光标变换
  let delta = 0;
  let applied = 0;

  for (const op of ops) {
    // 应用前算出这个 op 会插/删在哪个可见位置
    const idx = doc.textIndex();
    let at = -1;
    if (op.t === 'i') {
      // 插入位置 = anchor 之后的第一个可见字符位置
      at = indexAfterAnchor(idx, op.l);
    } else if (op.t === 'd') {
      at = indexOfNode(idx, op.id);
    }
    if (doc.apply(op)) {
      applied++;
      if (at >= 0) {
        if (op.t === 'i') delta += 1;
        else if (op.t === 'd') delta -= 1;
      }
    }
  }

  if (!applied) return;

  const after = doc.getText();
  if (after !== before) {
    ta.value = after;
    // 光标跟着挪
    const newStart = transformPosition(selStart, ...shiftOf(ops, selStart));
    const newEnd = transformPosition(selEnd, ...shiftOf(ops, selEnd));
    ta.selectionStart = Math.min(newStart, after.length);
    ta.selectionEnd = Math.min(newEnd, after.length);
    updateStatus();
  }
  renderPeers();
}

/** 找出 anchor 之后第一个可见字符的下标 */
function indexAfterAnchor(idx, anchorId) {
  if (!anchorId) return 0;
  const ak = idKey(anchorId);
  for (let i = 0; i < idx.length; i++) {
    if (idKey(idx[i].node.id) === ak) return i + 1;
  }
  return idx.length;
}

/** 找出某个节点在可见文本里的下标 */
function indexOfNode(idx, nodeId) {
  const nk = idKey(nodeId);
  for (let i = 0; i < idx.length; i++) {
    if (idKey(idx[i].node.id) === nk) return i;
  }
  return -1;
}

/** 粗略算出光标该挪多少 —— 保守：只算最后一个 op 的影响 */
function shiftOf(ops, pos) {
  // 简化：远端 op 的位置我们不精确追踪，用整体长度差兜底。
  // 真实实现应该逐 op 累积变换，这里先保证不崩、光标大致对。
  let delta = 0;
  for (const op of ops) {
    if (op.t === 'i') delta += 1;
    else if (op.t === 'd') delta -= 1;
  }
  return [pos, delta];
}

// ── 本地输入 → op ───────────────────────────────────────────
let beforeSnapshot = null;      // { value, start, end }
let composing = false;

/** 生成一个插入 op 并本地应用 */
function localInsert(text, at) {
  const anchorId = doc.anchorAt(at);
  const op = { t: 'i', id: [myClientId, seq++], v: text, l: anchorId };
  doc.apply(op);
  opCount++;
  opsEl.textContent = String(opCount);
  if (sync) sync.sendOp(op);
}

/** 生成删除 op 并本地应用 */
function localDelete(at, len) {
  const nodes = doc.nodesInRange(at, len);
  for (const n of nodes) {
    const op = { t: 'd', id: n.id };
    doc.apply(op);
    opCount++;
    opsEl.textContent = String(opCount);
    if (sync) sync.sendOp(op);
  }
}

/** 算出两段文本的差异：插入位置 + 插入内容 / 删除起点 + 删除长度 */
function diffText(oldStr, newStr) {
  let start = 0;
  while (start < oldStr.length && start < newStr.length && oldStr[start] === newStr[start]) {
    start++;
  }
  let endOld = oldStr.length;
  let endNew = newStr.length;
  // 从尾部往回找公共后缀 —— 比较的是 old 的尾和 new 的尾
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const inserted = newStr.slice(start, endNew);
  const deleted = endOld - start;
  return { start, inserted, deleted };
}

// ── 输入事件绑定 ────────────────────────────────────────────
ta.addEventListener('beforeinput', (e) => {
  if (composing) return;
  beforeSnapshot = {
    value: ta.value,
    start: ta.selectionStart,
    end: ta.selectionEnd,
  };
}, true);

ta.addEventListener('input', (e) => {
  if (composing) return;
  if (e.inputType === 'insertCompositionText') return;
  if (!beforeSnapshot) {
    // 没有 beforeinput（比如某些浏览器/程序化赋值）→ 兜底用当前值
    beforeSnapshot = { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  }

  const { value: oldVal, start, end } = beforeSnapshot;
  const newVal = ta.value;
  beforeSnapshot = null;

  if (oldVal === newVal) return;

  const d = diffText(oldVal, newVal);

  // 先删后插
  if (d.deleted > 0) localDelete(start, d.deleted);
  if (d.inserted.length > 0) {
    // 每个字符一个 op（RGA 一个节点一个字符）
    for (const ch of d.inserted) localInsert(ch, start);
  }
  updateStatus();
});

ta.addEventListener('compositionstart', () => { composing = true; });
ta.addEventListener('compositionend', (e) => {
  composing = false;
  // 合成结束后浏览器会再发一个 input，这里不需要额外处理
});

// 光标变化 → 上报 presence
let presenceTimer = 0;
const reportPresence = () => {
  if (!sync) return;
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    sync.sendPresence(ta.selectionStart);
  }, 80);
};
ta.addEventListener('keyup', reportPresence);
ta.addEventListener('click', reportPresence);
ta.addEventListener('select', reportPresence);

// ── 状态栏 ──────────────────────────────────────────────────
function updateStatus() {
  const text = doc.getText();
  const chars = text.length;
  opsEl.textContent = String(opCount);
  peersEl.textContent = String(members.size);
  return chars;
}

/** 重置本地 Doc —— 服务器广播 clear 时调用 */
function resetDoc() {
  doc = new Doc();
  seq = 0;
}

// ── 连接 ────────────────────────────────────────────────────
function connect() {
  if (sync) sync.disconnect();
  clearPeerEls();
  members = new Map();

  myClientId = newClientId();
  seq = 0;
  myName = 'user-' + myClientId.slice(0, 4);
  myColor = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
  meEl.textContent = myName;
  meEl.style.color = myColor;

  sync = new Sync(WS_URL, {
    name: myName,
    color: myColor,
    onStatus: (s) => {
      if (s === 'connected') setStatus('connected', 'ok');
      else if (s === 'connecting') setStatus('connecting…', 'pending');
      else if (s === 'reconnecting') setStatus('reconnecting…', 'pending');
      else if (s === 'error') setStatus('error', 'err');
      else setStatus('disconnected', 'err');
    },
    onOps: (ops) => applyRemoteOps(ops),
    onMembers: (list) => {
      members = new Map();
      for (const m of list) members.set(m.id, m);
      peersEl.textContent = String(members.size);
      renderPeers();
    },
    onClear: () => {
      // 服务器说文档被清空了 → 重置本地 Doc
      resetDoc();
      ta.value = '';
      opCount = 0;
      opsEl.textContent = '0';
      showToast('cleared');
    },
  });
  sync.connect();
}

// ── 按钮 ────────────────────────────────────────────────────
$('btn-reconnect').addEventListener('click', () => {
  connect();
  showToast('reconnecting');
});

$('btn-clear').addEventListener('click', () => {
  if (sync) sync.sendClear();
});

connect();

window.addEventListener('pagehide', () => {
  if (sync) sync.disconnect();
});
