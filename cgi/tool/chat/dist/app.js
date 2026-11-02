// app.js — chat 前端
//
// ★ 原生 JS，不用框架 —— 手写 HTML/CSS/JS，没有构建步骤。
//   （旧版是 Vue 打包产物，dist/assets/index-*.js 74KB 一个 bundle，
//    改一行要重新打包。这里直接改文件，改完刷新页面就生效。）
//
// 协议跟 cgi/tool/chat/ws 对应（JSON over WS text frame）：
//   → {op:'join', name, color, room}   {op:'msg', text}   {op:'leave'}
//   ← {type:'init'|'msg'|'peers'|'error'}
//
// ★ **成员表是服务端权威**（跟 tool/pad / tool/monaco 同一套模式）：
//   服务端维护 members/<cid>.json，「谁在线」= 目录里有哪些文件。
//   收到 peers 消息就**整个替换**本地列表 —— 不要自己增量拼，
//   那样各客户端的视角会不一致（这是旧版「在线列表总不对」的根因）。

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

const WS_URL = '/tool/chat/ws';

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
let peers = [];              // [{id, name, color}] —— 服务端给的权威名单
let myId = '';               // 服务端分配的客户端 id —— 用它标「你」
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
  localStorage.setItem('chat.nick', myName);
  localStorage.setItem('chat.color', myColor);
  localStorage.setItem('chat.room', curRoom);
};

// 房间名从 URL query 取（/tool/chat?room=xxx），回落 localStorage
const initialRoom = () => {
  const q = new URLSearchParams(location.search).get('room');
  return (q || localStorage.getItem('chat.room') || 'default').trim() || 'default';
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
    // ★ 用服务端分配的 id 判断「哪个是我」—— 不用名字比。
    //   名字可能重复（两个人都叫 bob），用名字比会标错。
    if (p.id && p.id === myId) {
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
      // ★ 服务端在 init 里带上自己的 id —— 用它标「you」
      if (m.you && m.you.id) myId = m.you.id;
      // ★ 服务端起的名字回传过来（本地没缓存昵称时）→ 存起来，下次直接用
      //
      //   ★ 只在输入框**还是空的时候**填 —— 用户可能已经在打字了，
      //     这时候覆盖会把他输的清掉。
      if (m.you && m.you.name && !myName) {
        myName = m.you.name;
        if (!nickEl.value.trim()) nickEl.value = myName;
        savePrefs();
      }
      peers = Array.isArray(m.peers) ? m.peers : [];
      msgsEl.replaceChildren();
      pushMsg({ kind: 'sys', text: `joined #${curRoom} — ${peers.length} online`, ts: Date.now() });
      renderPeers();
      break;

    case 'msg':
      pushMsg({ kind: 'msg', from: m.from, color: m.color, text: m.text, ts: (m.ts || 0) * 1000 });
      break;

    case 'peers':
      // ★ 成员表更新 —— **整个替换**（服务端是权威）
      peers = Array.isArray(m.peers) ? m.peers : [];
      renderPeers();
      break;

    case 'peer-in':
      // ★ 有人进来了 —— 记进 event log（诊断面板）
      pushEvent('in', `${m.name} joined`);
      break;

    case 'peer-out':
      // ★ 有人出去了 —— 记进 event log
      pushEvent('out', `${m.name} left`);
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
  history.replaceState(null, '', `/tool/chat?room=${encodeURIComponent(curRoom)}`);
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
// ★ 昵称：**本地没缓存才随机**，有缓存就用缓存的（用户的身份要稳定）。
//
//   本地没缓存时**不发名字**（发空串）—— 让服务端起一个**房内不重复**的，
//   因为只有服务端知道房里都有谁。服务端起完在 init 里回传，
//   这里存进 localStorage，下次直接用（不会再随机）。
myName = (localStorage.getItem('chat.nick') || '').trim();
myColor = localStorage.getItem('chat.color') || randColor();
curRoom = initialRoom();

nickEl.value = myName;
roomEl.value = curRoom;
roomLbl.textContent = curRoom;
meDot.style.background = myColor;
sendDot.style.background = myColor;

renderSwatches();
renderPeers();
connect();
