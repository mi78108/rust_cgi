// app.js — chat2 前端
//
// 原生 JS，不用框架（chat 用的是 Vue 打包产物，但 chat2 要的是
// 「node 后端 + 手写前端」的完整链路，且不带构建步骤）。
//
// 协议跟 cgi/tool/chat2/ws 对应（JSON over WS text frame）：
//   → {op:'join', name, color, room}   {op:'msg', text}   {op:'leave'}
//   ← {type:'init'|'msg'|'join'|'leave'|'peers'|'error'}

const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const peersEl  = $('peers');
const msgsEl   = $('msgs');
const eventsEl = $('events');
const nickEl   = $('nick');
const roomEl   = $('room');
const textEl   = $('text');
const meDot    = $('me-dot');
const sendDot  = $('send-dot');
const roomLbl  = $('room-label');
const peerCnt  = $('peer-count');
const btnSend  = $('btn-send');

const WS_URL = '/tool/chat2/ws';

const COLORS = [
  '#ff7eb6', '#7eb6ff', '#ffd07e', '#7effc4', '#d07eff',
  '#ff9f7e', '#7effe3', '#e6ff7e', '#7e8fff', '#ff7ed6',
];

const MSG_MAX = 300;         // 屏幕上保留的消息条数
const EVENT_MAX = 60;        // 事件日志条数

// ── 状态 ────────────────────────────────────────────────────
let ws = null;
let myName = '';
let myColor = COLORS[0];
let curRoom = 'default';
let peers = [];              // [{name, color}]
let eventSeq = 0;

// ── 工具 ────────────────────────────────────────────────────
const randName = () => {
  const a = ['swift', 'quiet', 'bright', 'lucky', 'calm', 'bold', 'clever', 'eager'];
  const b = ['fox', 'otter', 'hawk', 'lynx', 'heron', 'mole', 'ibis', 'shrew'];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(a)}-${pick(b)}`;
};

const randColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

const hhmmss = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const savePrefs = () => {
  localStorage.setItem('chat2.nick', myName);
  localStorage.setItem('chat2.color', myColor);
  localStorage.setItem('chat2.room', curRoom);
};

// 房间名从 URL query 取（/tool/chat2?room=xxx），回落 localStorage
const initialRoom = () => {
  const q = new URLSearchParams(location.search).get('room');
  return (q || localStorage.getItem('chat2.room') || 'default').trim() || 'default';
};

// ── 消息流 ──────────────────────────────────────────────────
const scrollBottom = () => {
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
};

const pushMsg = (m) => {
  const div = document.createElement('div');
  div.className = m.kind === 'sys' ? 'msg sys' : 'msg';

  if (m.kind === 'sys') {
    const line = document.createElement('span');
    line.className = 'sysline';
    line.textContent = `— ${m.text} —`;
    const ts = document.createElement('span');
    ts.className = 'mts';
    ts.textContent = hhmmss(m.ts);
    div.append(line, ts);
  } else {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = m.color || '#888';

    const who = document.createElement('span');
    who.className = 'who';
    who.style.color = m.color || '#e8e8ea';
    who.textContent = m.from;

    const ts = document.createElement('span');
    ts.className = 'mts';
    ts.textContent = hhmmss(m.ts);

    const txt = document.createElement('span');
    txt.className = 'text';
    txt.textContent = m.text;

    div.append(dot, who, ts, txt);
  }

  msgsEl.appendChild(div);
  while (msgsEl.children.length > MSG_MAX) msgsEl.removeChild(msgsEl.firstChild);
  scrollBottom();
};

// ── 事件日志 ────────────────────────────────────────────────
const pushEvent = (kind, text) => {
  const li = document.createElement('li');
  li.className = kind;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = hhmmss(Date.now());
  const body = document.createElement('span');
  body.textContent = text;
  li.append(ts, body);
  eventsEl.appendChild(li);
  while (eventsEl.children.length > EVENT_MAX) eventsEl.removeChild(eventsEl.firstChild);
};

// ── 在线成员 ────────────────────────────────────────────────
const renderPeers = () => {
  peersEl.replaceChildren();
  peerCnt.textContent = String(peers.length);

  for (const p of peers) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color || '#888';
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;
    li.append(dot, name);
    if (p.name === myName) {
      const me = document.createElement('span');
      me.className = 'me';
      me.textContent = 'you';
      li.appendChild(me);
    }
    peersEl.appendChild(li);
  }

  if (peers.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '— nobody —';
    peersEl.appendChild(li);
  }
};

// ── 颜色选择器 ──────────────────────────────────────────────
const renderSwatches = () => {
  const box = $('swatches');
  box.replaceChildren();
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'sw' + (c === myColor ? ' on' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      if (myColor === c) return;
      myColor = c;
      meDot.style.background = c;
      sendDot.style.background = c;
      renderSwatches();
      savePrefs();
      reconnect();          // 换身份要重新 join
    });
    box.appendChild(b);
  }
};

// ── WebSocket ───────────────────────────────────────────────
const setStatus = (text, kind) => {
  statusEl.textContent = text;
  statusEl.className = 'pill ' + kind;
};

const send = (obj) => {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      pushEvent('err', 'send fail: ' + e.message);
    }
  }
};

const onMessage = (ev) => {
  let m = null;
  try {
    m = JSON.parse(ev.data);
  } catch {
    pushEvent('err', 'bad frame');
    return;
  }
  if (!m || typeof m !== 'object') return;

  switch (m.type) {
    case 'init':
      setStatus('connected', 'ok');
      peers = Array.isArray(m.peers) ? m.peers : [];
      msgsEl.replaceChildren();
      pushMsg({ kind: 'sys', text: `joined #${curRoom} — ${peers.length} online`, ts: Date.now() });
      renderPeers();
      break;

    case 'msg':
      pushMsg({ kind: 'msg', from: m.from, color: m.color, text: m.text, ts: (m.ts || 0) * 1000 });
      break;

    case 'join':
      pushMsg({ kind: 'sys', text: `${m.peer.name} joined`, ts: Date.now() });
      pushEvent('in', `${m.peer.name} joined`);
      if (!peers.some((p) => p.name === m.peer.name)) peers.push(m.peer);
      renderPeers();
      break;

    case 'leave':
      pushMsg({ kind: 'sys', text: `${m.name} left`, ts: Date.now() });
      pushEvent('out', `${m.name} left`);
      peers = peers.filter((p) => p.name !== m.name);
      renderPeers();
      break;

    case 'peers':
      peers = Array.isArray(m.peers) ? m.peers : [];
      renderPeers();
      break;

    case 'error':
      pushEvent('err', m.msg);
      setStatus(m.msg, 'err');
      break;
  }
};

const connect = () => {
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
  }

  peers = [];
  renderPeers();
  msgsEl.replaceChildren();
  setStatus('connecting…', 'pending');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}${WS_URL}`);

  ws.addEventListener('open', () => {
    setStatus('joining…', 'pending');
    send({ op: 'join', name: myName, color: myColor, room: curRoom });
  });
  ws.addEventListener('message', onMessage);
  ws.addEventListener('error', () => {
    pushEvent('err', 'websocket error');
    setStatus('connect failed', 'err');
  });
  ws.addEventListener('close', () => {
    setStatus('disconnected', 'err');
    peers = [];
    renderPeers();
  });
};

const reconnect = () => connect();

// ── 发消息 ──────────────────────────────────────────────────
const doSend = () => {
  const t = textEl.value.trim();
  if (!t) return;
  send({ op: 'msg', text: t });
  textEl.value = '';
};

// ── 切房间 ──────────────────────────────────────────────────
const switchRoom = () => {
  const r = roomEl.value.trim();
  if (!r || r === curRoom) return;
  curRoom = r;
  roomLbl.textContent = curRoom;
  savePrefs();
  history.replaceState(null, '', `/tool/chat2?room=${encodeURIComponent(curRoom)}`);
  reconnect();
};

// ── 事件绑定 ────────────────────────────────────────────────
btnSend.addEventListener('click', doSend);

textEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
});

nickEl.addEventListener('blur', () => {
  const n = nickEl.value.trim();
  if (!n || n === myName) {
    if (myName) nickEl.value = myName;
    return;
  }
  myName = n;
  savePrefs();
  reconnect();
});

nickEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') nickEl.blur();
});

roomEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') switchRoom();
});

$('btn-room').addEventListener('click', switchRoom);
$('btn-bottom').addEventListener('click', scrollBottom);

$('btn-random').addEventListener('click', () => {
  myName = randName();
  myColor = randColor();
  nickEl.value = myName;
  meDot.style.background = myColor;
  sendDot.style.background = myColor;
  renderSwatches();
  savePrefs();
  reconnect();
});

// 页面卸载时告诉服务端下线（不等结果 —— 页面马上就没了）
window.addEventListener('beforeunload', () => {
  send({ op: 'leave' });
});

// ── 启动 ────────────────────────────────────────────────────
myName = (localStorage.getItem('chat2.nick') || '').trim() || randName();
myColor = localStorage.getItem('chat2.color') || randColor();
curRoom = initialRoom();

nickEl.value = myName;
roomEl.value = curRoom;
roomLbl.textContent = curRoom;
meDot.style.background = myColor;
sendDot.style.background = myColor;

renderSwatches();
renderPeers();
connect();
