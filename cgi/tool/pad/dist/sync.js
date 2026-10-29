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
   *   opts.onOps    (ops[]) => void       收到 op
   *   opts.onMembers(members[]) => void   收到成员表
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

    ws.addEventListener('open', () => {
      this.connected = true;
      this.reconnectDelay = 1000;
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
          this.onOps(msg.ops || []);
          break;
        case 'members':
          this.onMembers(msg.members || []);
          break;
        case 'clear':
          this.onClear();
          break;
        default:
          break;
      }
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      this.ws = null;
      this.onStatus('disconnected');
      if (!this.closedByUser) this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
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
    // 直接发 JSON —— **不要**自己加 8 字节头。
    //
    // spider 在把 WS 帧负载写给子进程 STDIN 时，会自动加一层
    // [len(4,BE)][rem(4,BE)] 头（见 src/utils.rs 的 call_bridge remainder 逻辑），
    // ruby 的 Req#on_ws_data 就是靠这个头还原消息边界。
    // 自己再加一层会变成双头 → ruby 解析出垃圾 → 消息被丢弃。
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  // ── 对外 API ────────────────────────────────────────────

  /** 发送一个 CRDT op */
  sendOp(op) {
    this._send({ t: 'op', op });
  }

  /** 上报光标位置 */
  sendPresence(cursor) {
    this._send({ t: 'presence', cursor });
  }

  /** 请求全量 op */
  requestSync() {
    this._send({ t: 'sync' });
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
