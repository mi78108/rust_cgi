// sync.js — 网络层：WebSocket 连接 + 消息收发 + 重连
//
// 只管「把消息送到 / 把消息收到」，不懂 CRDT 语义。
// CRDT 的应用在 app.js 里做。
//
// 协议（JSON over WebSocket text frame）：
//
//   客户端 → 服务器
//     {t:"hello", name, color}      加入（带身份）
//     {t:"op", op}                   一个 CRDT op
//     {t:"presence", cursor}         光标位置
//     {t:"sync"}                     请求全量 op（新连接 / 重连后）
//
//   服务器 → 客户端
//     {t:"ops", ops:[...]}           全量或增量 op
//     {t:"members", members:[...]}   在线成员 + 各自光标
//     {t:"hello-ack"}                服务器收到了 hello

export class Sync extends EventTarget {
  /**
   * @param {string} url       ws:// 地址
   * @param {object} opts
   *   opts.name     显示名
   *   opts.color    颜色
   *   opts.onOps    (ops[], total) => void   收到 op
   *                                 total = 服务器 op log 的权威总数（可能是 undefined）
   *   opts.onMembers(members[]) => void   收到成员表
   *   opts.onHelloAck(id) => void         服务端分配的成员表 id（hello-ack）
   *   opts.onOpen () => void               WS 刚连上（重连时要重置 id）
   *   opts.onStatus (status) => void      连接状态变化
   */
  constructor(url, opts = {}) {
    super();
    this.url = url;
    this.name = opts.name || 'anon';
    this.color = opts.color || '#c4f542';
    this.onOps = opts.onOps || (() => {});
    this.onMembers = opts.onMembers || (() => {});
    this.onClear = opts.onClear || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onHelloAck = opts.onHelloAck || (() => {});
    this.onOpen = opts.onOpen || (() => {});
    this.onSeedAck = opts.onSeedAck || (() => {});
    this.onSeedError = opts.onSeedError || (() => {});
    this.onReplace = opts.onReplace || (() => {});

    this.ws = null;
    this.connected = false;
    this.reconnectTimer = 0;
    this.reconnectDelay = 1000;
    this.closedByUser = false;
    /** 断线期间产生的消息 —— 重连后补发 */
    this.pending = [];
  }

  connect() {
    this.closedByUser = false;
    this._open();
  }

  /**
   * 强制重连 —— 先把旧连接彻底拆掉，再开新的。
   *
   * ★ **为什么要单独一个方法**（不能靠 `disconnect(); connect();`）：
   *   `disconnect()` 会调 `ws.close()`，但 WebSocket 的 `close` 事件是
   *   **异步**触发的 —— 它在旧连接的 close 回调里看到
   *   `this.closedByUser`（`disconnect()` 刚设成 true）就跳过自动重连。
   *   但 `connect()` 紧接着把 `closedByUser` **重置回 false** →
   *   旧连接的 close 回调这时才跑到，看到 false → 又排一个自动重连 →
   *   **最终建了 2 条 WebSocket**（实测：点一次 reconnect，wsCreated=2）。
   *
   *   两条连接同时存在 = 同一个文档两个成员身份 + op 发两遍 +
   *   远端光标出现两个「我」。所以这里**先关旧连接、等它真的关掉、
   *   再开新的**，并且用 `_generation` 序号让过期的 close 回调作废。
   */
  reconnect() {
    this._generation = (this._generation || 0) + 1;
    const gen = this._generation;

    // 取消自动重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }

    // ★ closedByUser 只在**这一刻**为 true —— 让旧连接的 close 回调
    //   知道「这是主动关的，别排自动重连」。
    this.closedByUser = true;

    const old = this.ws;
    this.ws = null;
    this.connected = false;

    if (old) {
      try { old.close(); } catch (_) {}
      // 等旧连接真的 close（close 事件是异步的）→ 再开新的
      old.addEventListener('close', () => {
        if (this._generation !== gen) return;   // 过期回调 → 放弃
        this.closedByUser = false;
        this._open();
      }, { once: true });
      // 兜底：旧连接万一不发 close（比如已 CONNECTING）→ 200ms 后照样开
      setTimeout(() => {
        if (this._generation !== gen) return;
        if (this.ws) return;                    // 已经开好了
        this.closedByUser = false;
        this._open();
      }, 200);
      return;
    }

    this.closedByUser = false;
    this._open();
  }

  _open() {
    this.onStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.onStatus('error');
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    // ★ 本次连接的「身份证」—— 用来识别过期的回调。
    //   reconnect() 会 +1 generation；旧连接的事件回调拿到旧号
    //   就知道自己过期了，直接作废（不碰 this.ws / 不排自动重连）。
    const gen = this._generation || 0;
    const isStale = () => (this._generation || 0) !== gen;

    ws.addEventListener('open', () => {
      if (isStale()) { try { ws.close(); } catch (_) {} return; }
      this.connected = true;
      this.reconnectDelay = 1000;
      // ★ 连接刚建立 —— 通知上层"要重新初始化了"。
      //   服务端每次 hello 都会分配**新的** id（重连 = 新进程 = 新 cid），
      //   所以上层必须把旧的 id / 初始化状态清掉，等新的 hello-ack。
      //   不清的话会用旧 id 发 op —— 那个 id 在服务器 log 里已经不属于你了。
      this.onOpen();
      this.onStatus('connected');
      // 打招呼 + 要全量
      this._send({ t: 'hello', name: this.name, color: this.color });
      this._send({ t: 'sync' });
      // 补发断线期间攒的消息
      const queued = this.pending.splice(0);
      for (const m of queued) this._send(m);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;                       // 不是 JSON，忽略
      }
      if (!msg || !msg.t) return;
      switch (msg.t) {
        case 'ops':
          this.onOps(msg.ops || [], msg.total);
          break;
        case 'hello-ack':
          // 服务端分配了成员表 id → 告诉上层"你是谁"
          this.onHelloAck(msg.id);
          break;
        case 'members':
          this.onMembers(msg.members || []);
          break;
        case 'clear':
          this.onClear();
          break;
        case 'seed-ack':
          // 服务端已经覆盖了当前 doc 的内容
          this.onSeedAck(msg.doc, msg.chars);
          break;
        case 'replace':
          // ★ 文档被**整体替换**（打开本地文件）→ 重建 Doc
          this.onReplace();
          break;
        case 'seed-error':
          this.onSeedError(msg.error || 'seed failed');
          break;
        default:
          break;
      }
    });

    ws.addEventListener('close', () => {
      // ★ 过期连接（被 reconnect() 换掉的）—— 直接作废。
      //   不碰 this.connected / this.ws，也不排自动重连 ——
      //   否则旧的 close 回调会覆盖新连接的状态，或再排一条重连。
      if (isStale()) return;
      this.connected = false;
      this.ws = null;
      this.onStatus('disconnected');
      if (!this.closedByUser) this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      if (isStale()) return;
      this.onStatus('error');
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.onStatus('reconnecting');
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = 0;
      if (!this.closedByUser) this._open();
    }, delay);
  }

  _send(obj) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 没连上 → 攒着
      this.pending.push(obj);
      return false;
    }
    // 直接发 JSON —— **不要**自己加帧头。
    //
    // spider 在把 WS 帧负载写给子进程 STDIN 时，会自动加一层
    // [len(4,BE)][rem(4,BE)][flags(1)] 头（见 src/tcp_class/http_websocket_func.rs
    // 的 Websocket::read），ruby 的 Req#on_ws_data 就是靠这个头还原消息边界。
    // 自己再加一层会变成双头 → ruby 解析出垃圾 → 消息被丢弃。
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  // ── 对外 API ────────────────────────────────────────────

  /** 发送一个 CRDT op */
  sendOp(op) {
    this._send({ t: 'op', op });
  }

  /**
   * 上报光标位置。
   *
   * ★ cursor  = 扁平偏移（UTF-16 code unit）—— 兜底用
   * ★ anchor = 光标所在字符的 **CRDT 节点 id** —— 精确用
   *
   * 只有偏移是不够的：那个数字是「上报者文档里」的数字，
   * 别人在自己文档里套用时会错位（别人在前面插字符 → 偏移要 +1）。
   * 节点 id 是全局唯一的字符身份，插删都不影响它 —— 用它才准。
   */
  sendPresence(cursor, anchor) {
    this._send({ t: 'presence', cursor, anchor });
  }

  /** 改自己的名称 / 颜色 */
  sendProfile(name, color) {
    this._send({ t: 'profile', name, color });
  }

  /**
   * 请求全量 op
   */
  requestSync() {
    this._send({ t: 'sync' });
  }

  /**
   * ★ 用本地文件内容**替换当前 doc**。
   *
   *   服务端会覆盖当前 doc 的 op log，然后广播 `replace` 给所有客户端。
   *
   * @param {string} filename  原始文件名（仅用于日志）
   * @param {string} content   文件内容（UTF-8 文本）
   */
  sendSeed(filename, content) {
    this._send({ t: 'seed', filename, content });
  }

  /** 请求清空文档（服务器会广播给所有客户端） */
  sendClear() {
    this._send({ t: 'clear' });
  }

  /** 主动断开（不再重连） */
  disconnect() {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
    this.onStatus('closed');
  }
}
