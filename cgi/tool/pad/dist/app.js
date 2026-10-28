// tool/pad/app.js — 协作编辑器 (普通 js, 无框架)
//
//   WS → /tool/pad/ws
//
// CRDT 用 @weavo/client (vendor/ 里是本地化的 ESM, import 已改成相对路径)。
// 后端只做透明转发, 收敛全靠浏览器端的 CRDT。
//
// 用法:
//   import { createWeavo } from '/tool/pad/vendor/client.js';
//
// 关键 API:
//   createWeavo(url)      → { bind(el), textSubscribe(fn), onPresence(fn),
//                             getPresence(), setIdentity({name,color}),
//                             membership.isJoined(), disconnect() }
//   membership.onJoined()  → join 成功回调
//   onPresence(peers)      → peers 是 Map<clientId, {cursor,name,color}>

import { createWeavo } from '/tool/pad/vendor/client.js';

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
let weavo      = null;
let unbind     = null;
let unsubPresence = null;
let ops        = 0;
let myClientId = null;

// peer 光标 DOM: clientId → { el, label, name, color, cursor }
const peerEls = new Map();

// ── toast ───────────────────────────────────────────────────
let toastTimer = 0;
const showToast = (msg) => {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1500);
};

// ── clientId ────────────────────────────────────────────────
function newClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const q = () => Math.floor(Math.random() * 4294967295).toString(16).padStart(8, '0');
  return `${q()}-${q()}-${q()}-${q()}`;
}

// ── 状态灯 ──────────────────────────────────────────────────
const setStatus = (text, kind) => {
  statusEl.textContent = text;
  statusEl.className = 'pill ' + kind;
};

// ── 光标位置换算 ────────────────────────────────────────────
// 用 mirror (隐藏的同排版文本) 量出第 cursor 个字符的像素位置。
// anchor 是 mirror 里的一个 inline 元素, 把它塞到 cursor 位置前面,
// 再取 anchor 的 offsetLeft/offsetTop 相对 .editor-frame 就是坐标。
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
function renderPeers(peers) {
  const layer = document.querySelector('.cursor-layer');
  if (!layer) return;

  const seen = new Set();

  for (const [id, p] of peers) {
    if (id === myClientId) continue;   // 自己的光标不画
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

    // 没变化就不动 DOM (presence 回调挺频繁)
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

  // 清掉走掉的 peer
  for (const [id, rec] of peerEls) {
    if (!seen.has(id)) {
      rec.el.remove();
      peerEls.delete(id);
    }
  }
}

function clearPeerEls() {
  for (const rec of peerEls.values()) rec.el.remove();
  peerEls.clear();
}

// ── 连接 ────────────────────────────────────────────────────
async function connect() {
  // 断开旧的
  if (weavo) {
    if (unbind) { unbind(); unbind = null; }
    if (unsubPresence) { unsubPresence(); unsubPresence = null; }
    weavo.disconnect();
  }
  clearPeerEls();

  setStatus('connecting…', 'pending');

  myClientId = newClientId();
  const myName = 'user-' + myClientId.slice(0, 4);
  const myColor = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
  meEl.textContent = myName;
  meEl.style.color = myColor;

  try {
    weavo = createWeavo(WS_URL, { clientId: myClientId });
    weavo.setIdentity({ name: myName, color: myColor });
  } catch (e) {
    setStatus('init fail: ' + e.message, 'err');
    return;
  }

  weavo.textSubscribe(() => { ops++; opsEl.textContent = String(ops); });

  unbind = weavo.bind(ta);

  setStatus('joining…', 'pending');

  unsubPresence = weavo.onPresence((peers) => {
    peersEl.textContent = String(peers.size);
    renderPeers(peers);
  });

  weavo.membership.onJoined(() => {
    setStatus('connected', 'ok');
    showToast('joined');
  });

  // join 超时 —— ws 没连上时给个提示, 免得一直转圈
  setTimeout(() => {
    if (weavo && !weavo.membership.isJoined()) {
      setStatus('join timeout', 'err');
      showToast('join failed (check ws server)');
    }
  }, 5000);
}

// ── 事件绑定 ────────────────────────────────────────────────
$('btn-reconnect').addEventListener('click', connect);

connect();

// 离开页面时断开
window.addEventListener('pagehide', () => {
  if (unbind) unbind();
  if (unsubPresence) unsubPresence();
  if (weavo) weavo.disconnect();
});
