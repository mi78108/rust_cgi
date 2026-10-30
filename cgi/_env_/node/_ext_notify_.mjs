// ============================================================
// TcpNotify — TCP 长连接广播客户端（BDR 协议）
//
// 对齐 rust 的 TcpBroadcast（src/tcp_class/tcp_broadcast_func.rs）。
// 跟 SocketNotify / FsNotify 的区别：
//   SocketNotify — UDP 组播，进程间广播，无中心服务器
//   FsNotify     — 文件 IPC，进程间广播，无中心服务器
//   TcpNotify    — TCP 长连接，**有**中心服务器（spider），消息由服务端扇出
//
// BDR 协议：
//
//   握手（客户端 -> 服务端）：
//     [0x89 'B' 'R' 'D' 0x0d 0x0a 0x1a 0x00]   8 字节定长魔数
//     + "<channel>\n"                          变长频道名，\n 结尾
//
//   服务端 -> 客户端（握手确认）：
//     [len u32 BE][id 8 字节]                  len == 8
//     id = 本连接的连接 id（u64 大端）—— 收到这条 = 通讯建立
//
//   客户端 -> 服务端：
//     [len u32 BE][payload]                    len == payload 字节数
//
//   服务端 -> 订阅者（广播）：
//     [len u32 BE][id 8 字节][payload]          len == 8 + payload 字节数
//     id = 发送者的连接 id
//
// 帧里带长度前缀是为了让所有订阅者收到的字节流完全一致 —— TCP 是字节流，
// 直接广播原始字节的话各客户端的切分点可能不同。id 定长 8 字节，
// 客户端按固定偏移就能把 id 和 payload 切开，不需要额外的长度前缀。
//
// ★ 回环语义：spider 广播给频道里**所有**订阅者，**包括发送者自己**。
//   wantEcho=false 时按**连接 id** 跳过自己发的。
//   （不能用 pid 判断：同一个进程可以开多条 TCP 连接，pid 相同但连接不同）
//
// ★ 频道在**握手时**就定死了 —— 一条连接只有一个频道。
//   subscribe(channel) 的 channel 只用于本地订阅匹配，不会发给服务器。
//   要发到别的频道，得另开一条连接。
//
// 用法：
//   import { TcpNotify } from '../_env_/node/_ext_notify_.mjs';
//
//   const t = new TcpNotify('alice', { channel: 'room1' });
//   t.subscribe('room1', (msg) => console.log(msg.data.toString('utf8')));
//   t.send('hello');
//   t.id;                       // 本连接的 id
//   t.stop();
//
//   // 定向发送（只发给某一个连接）：
//   t.sendTo(7n, 'hello');      // 只发给连接 id = 7 的那个连接
//
//   // 跳过自己发的：
//   t.subscribe('room1', handler, { wantEcho: false });
//
//   // 连别处：
//   new TcpNotify('alice', { host: '10.0.0.9', port: 9999, channel: 'room1' });
//
// BDR 帧格式（2026-10 加 dst）：
//     客户端 → 服务端: [len u32 BE][dst 8 字节][payload]
//                   dst = 目标连接 id，0 = 广播给全频道
//     服务端 → 客户端: [len u32 BE][src 8 字节][payload]
//                   ★ 下行**不带 dst** —— 服务端已经按 dst 过滤过了
//                     （只接受 dst == 自己的 id 或 dst == 0），
//                     发到客户端的一定是给自己的。
//                   src = 原始发送者的连接 id
//     握手确认帧:       [len=8][id 8 字节]        ← 不变
//
//   连接 id 从 1 开始，0 永远保留给「广播」哨兵。
//
//   ★ **定向过滤在服务端做**（write_loop 里按 dst 判断）——
//     非目标连接的帧不会写进它的 socket，字节不会流到别的客户端。
//
// 服务端地址：默认 127.0.0.1 + env('Cgi_Port')（spider 注入的自己的
// 监听端口），再默认 3000。主机名写死 127.0.0.1 —— BDR 是**本机进程
// 之间**的连接，而 spider 的 bind 地址可能是 0.0.0.0（监听所有网卡），
// 那不是可连接的目标。要连别处就显式传 host/port。
// ============================================================

import net from 'node:net';
import { EventEmitter } from 'node:events';

// 握手魔数 —— 8 字节定长，必须跟 rust 侧一致
const MAGIC = Buffer.from([0x89, 0x42, 0x52, 0x44, 0x0d, 0x0a, 0x1a, 0x00]);

const LEN_PREFIX = 4;          // 长度前缀字节数
const ID_LEN = 8;              // 连接 id 字节数（u64 大端）
const DST_LEN = 8;             // 目标 id 字节数（u64 大端）—— 0 = 广播
const MAX_MSG_LEN = 16 * 1024 * 1024;   // 单条消息上限，跟 rust 侧一致

// 广播哨兵 —— dst == 0n 表示「发给全频道」
//
// ★ 连接 id 从 **1** 开始（rust 侧 UID.fetch_add(1)），0 永远保留给这个哨兵。
//   所以「dst == 0n」就是安全的广播判据，不会跟合法连接 id 撞。
const DST_BROADCAST = 0n;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

const ENV_CGI_PORT = 'Cgi_Port';

// spider 注入的端口 —— 没有或非法就 null
const injectedPort = () => {
  const raw = (process.env[ENV_CGI_PORT] ?? '').trim();
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// 解析服务端地址 —— 返回 [host, port]
const resolveEndpoint = () => [DEFAULT_HOST, injectedPort() ?? DEFAULT_PORT];

// ============================================================
// TcpNotify
// ============================================================
export class TcpNotify extends EventEmitter {
  /**
   * @param {string} name     实例名（只用于日志）
   * @param {object} opts
   *   @param {string} opts.channel  订阅的频道名（握手时定死）
   *   @param {string} opts.host     服务端地址（默认 127.0.0.1）
   *   @param {number} opts.port     服务端端口（默认取 env('Cgi_Port')，再默认 3000）
   */
  constructor(name, opts = {}) {
    super();
    if (!name) throw new Error('TcpNotify needs name');
    const channel = opts.channel ?? 'default';
    if (!channel) throw new Error('TcpNotify needs channel');

    this.name = name;
    this.channel = String(channel);
    this.id = null;

    const [autoHost, autoPort] = resolveEndpoint();
    this.host = opts.host ?? autoHost;
    this.port = opts.port ?? autoPort;

    this.socket = null;
    this.running = false;
    this.subs = new Map();          // channel -> [{ handler, wantEcho }]
    this._buffer = Buffer.alloc(0);  // 读到的字节（可能是半帧）

    // ★ 握手完成前的发送队列
    //
    //   node 的 net.connect 是**异步**的 —— 连接建好之前 socket.write()
    //   会把数据排在队列里，等连上再发。但 BDR 的握手帧和业务帧
    //   必须**按顺序**到达服务端：
    //
    //     [MAGIC][channel]\n   ← 握手
    //     [len][dst][payload]   ← 业务
    //
    //   如果业务帧先于握手帧发出（或者挤在一起），spider 端
    //   tcp_broadcast_func.rs 读到的第一段就不是 MAGIC →
    //   「bad magic」→ 连接被拒 → 广播全部丢失。
    //
    //   ruby 版没这问题：TcpNotify.new 里 connect! 是**阻塞**的，
    //   返回时握手已经完成。node 是异步的 → 必须显式等。
    //
    //   解法：握手 id 收到之前把业务帧排队，握手完成后按序冲刷。
    this._ready = false;
    this._pendingFrames = [];
    this._readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    // 没人 await 时也不能有 unhandled rejection
    this._readyPromise.catch(() => {});

    this.connect();
  }

  // 握手完成的 promise —— 业务代码可以 await 它
  //
  //   await notifier.ready;   ← 之后 send() 一定走真实 socket
  get ready_promise() {
    return this._readyPromise;
  }

  // 连接 + 握手 + 起读循环
  connect() {
    this._teardownSocket();

    const sock = net.connect({ host: this.host, port: this.port });
    this.socket = sock;

    sock.on('connect', () => {
      // ---- 握手：魔数 + 频道名 ----
      const name = Buffer.from(this.channel, 'utf8');
      const hello = Buffer.concat([MAGIC, name, Buffer.from('\n', 'binary')]);
      sock.write(hello);

      // ---- 读服务端的连接 id：[len u32 BE][id 8 字节] ----
      this._pending = { stage: 'handshake' };
    });

    sock.on('data', (chunk) => this._onData(chunk));
    sock.on('error', (e) => {
      if (this.running) {
        process.stderr.write(`[${this.name}] socket error: ${e?.message ?? e}\n`);
      }
      this.running = false;
      if (!this._ready) {
        this._ready = true;                 // 失败也算「结束等待」
        this._rejectReady?.(e);
      }
      this.emit('error', e);
    });
    sock.on('close', () => {
      this.running = false;
      if (!this._ready) {
        this._ready = true;
        this._rejectReady?.(new Error(`${this.name}: socket closed before handshake`));
      }
      this.emit('close');
    });

    this.running = true;
  }

  // 断开并重连 —— 保留已有的订阅
  reconnect() {
    this.connect();
    return this;
  }

  get connected() {
    return this.running && this.socket !== null && !this.socket.destroyed;
  }

  // 订阅
  //
  //   subscribe('room1', handler)                  收到自己发的也会回调
  //   subscribe('room1', handler, { wantEcho: false })  跳过自己发的
  subscribe(channel, handler, opts = {}) {
    const key = channel == null ? 'default' : String(channel);
    const wantEcho = opts.wantEcho !== false;
    if (!this.subs.has(key)) this.subs.set(key, []);
    this.subs.get(key).push({ handler, wantEcho });
    return this;
  }

  // 退订 —— 不传 handler 就清掉该频道的全部订阅
  unsubscribe(channel, handler) {
    const key = channel == null ? 'default' : String(channel);
    if (!this.subs.has(key)) return this;
    if (!handler) {
      this.subs.delete(key);
      return this;
    }
    this.subs.set(key, this.subs.get(key).filter((s) => s.handler !== handler));
    return this;
  }

  // 发消息
  //
  // payload: string | Buffer | Uint8Array
  // dst: 目标连接 id —— 0n（默认）= 广播给全频道；
  //      其它值 = 只发给那一个连接（服务端在 write_loop 里过滤）
  //
  // ★ 握手没完成时**排队**，不直接写 socket。
  //   理由见构造函数里的说明：业务帧必须排在握手帧之后。
  //   队列在握手 id 到达时按序冲刷。
  send(payload, dst = DST_BROADCAST) {
    const body = toBuffer(payload);
    if (body.length > MAX_MSG_LEN) return false;

    // BDR 发送帧：[len u32 BE][dst 8 字节][payload]
    const d = BigInt(dst ?? 0) < 0n ? DST_BROADCAST : BigInt(dst ?? 0);
    const frame = Buffer.allocUnsafe(LEN_PREFIX + DST_LEN + body.length);
    frame.writeUInt32BE(DST_LEN + body.length, 0);
    frame.writeBigUInt64BE(d, LEN_PREFIX);
    body.copy(frame, LEN_PREFIX + DST_LEN);

    if (!this._ready) {
      this._pendingFrames.push(frame);
      return true;
    }

    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(frame);
    return true;
  }

  // 定向发送 —— 只发给某一个连接（dst != 0n）
  //
  //   t.sendTo(7n, 'hello');      // 只发给连接 id = 7 的那个连接
  //   t.sendTo(null, 'hello');    // null → 广播（等价于 send）
  //
  // **服务端在 write_loop 里做过滤** —— 非目标连接的帧不会写进它的 socket，
  // 所以定向消息的字节不会流到别的客户端（保密性有保证）。
  sendTo(dst, payload) {
    const d = dst === null || dst === undefined ? DST_BROADCAST : BigInt(dst);
    return this.send(payload, d <= 0n ? DST_BROADCAST : d);
  }

  // 异步发送 —— 等 socket 真正 flush 完再 resolve
  //
  // ★ 什么时候需要它：**进程即将退出**时。
  //   socket.write() 只是把数据排进 libuv 的写队列，
  //   紧接着 process.exit() 的话队列里的数据就丢了 ——
  //   典型场景：客户端断开时要广播「下线通知」，
  //   消息发不出去 → 对端的成员列表里一直挂着幽灵成员。
  //
  //   sendAsync(payload) → Promise<boolean>
  //   resolve(true) = 已 flush；resolve(false) = socket 已断 / 超长
  sendAsync(payload, dst = DST_BROADCAST) {
    const body = toBuffer(payload);
    if (body.length > MAX_MSG_LEN) return Promise.resolve(false);

    const d = BigInt(dst ?? 0) < 0n ? DST_BROADCAST : BigInt(dst ?? 0);
    const frame = Buffer.allocUnsafe(LEN_PREFIX + DST_LEN + body.length);
    frame.writeUInt32BE(DST_LEN + body.length, 0);
    frame.writeBigUInt64BE(d, LEN_PREFIX);
    body.copy(frame, LEN_PREFIX + DST_LEN);

    // 握手没完成 → 等握手，再写
    if (!this._ready) {
      return this._readyPromise.then(
        () => this._writeFrame(frame),
        () => false,
      );
    }
    return this._writeFrame(frame);
  }

  // 真正把一帧写出去（等 flush 回调）
  _writeFrame(frame) {
    if (!this.socket || this.socket.destroyed) return Promise.resolve(false);
    return new Promise((resolve) => {
      // write 的回调在数据交给内核后才触发
      this.socket.write(frame, (err) => resolve(!err));
    });
  }

  // emit 风格别名 —— 跟 ruby's notify(:ch, payload) 对应
  //
  // dst 可选 —— 0n（默认）= 广播；其它值 = 定向给那一个连接
  notify(channel, payload, dst = DST_BROADCAST) {
    return this.send(payload, dst);
  }

  // 消息来源标识 —— BDR 里没有 "host:port" 这种 from，用连接 id
  get peerId() {
    return this.id;
  }

  stop() {
    if (!this.running && !this.socket) return this;
    this.running = false;
    this._teardownSocket();
    return this;
  }

  // ----- 内部 -----

  // 冲刷握手前排队的业务帧
  //
  // 按入队顺序写出去 —— BDR 帧之间有顺序要求（虽然每帧自带 len/dst，
  // 但保持顺序更符合协议语义，也方便抓包排查）。
  _flushPending() {
    if (!this._pendingFrames.length) return;
    const frames = this._pendingFrames;
    this._pendingFrames = [];
    if (!this.socket || this.socket.destroyed) return;
    for (const f of frames) this.socket.write(f);
  }

  _teardownSocket() {
    const sock = this.socket;
    this.socket = null;
    if (!sock) return;
    sock.removeAllListeners('data');
    sock.removeAllListeners('connect');
    sock.removeAllListeners('error');
    sock.removeAllListeners('close');
    try {
      sock.destroy();
    } catch {
      // 已经断了 —— 忽略
    }
  }

  // 收到字节 —— 攒进 buffer 再切帧
  //
  // TCP 是字节流，一次 data 可能带来半帧，也可能带来好几帧。
  _onData(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;

    for (;;) {
      if (this._buffer.length < LEN_PREFIX) return;   // 长度前缀还没收全

      const len = this._buffer.readUInt32BE(0);

      // 握手确认帧：[len=8][id 8 字节]
      if (this._pending?.stage === 'handshake') {
        if (len !== ID_LEN) {
          process.stderr.write(`[${this.name}] bad handshake id len ${len} (expect ${ID_LEN})\n`);
          this.stop();
          return;
        }
        if (this._buffer.length < LEN_PREFIX + ID_LEN) return;   // id 还没收全
        this.id = this._buffer.readBigUInt64BE(LEN_PREFIX);
        this._buffer = this._buffer.subarray(LEN_PREFIX + ID_LEN);
        this._pending = null;
        process.stderr.write(
          `[${this.name}] up id=${this.id} host=${this.host}:${this.port} channel=${this.channel}\n`);
        this.emit('connected', this.id);

        // ★ 握手完成 —— 冲刷排队中的业务帧
        //
        //   到这里服务端已经确认了我们的连接 id，
        //   之后的业务帧一定能被正确路由。
        this._ready = true;
        this._resolveReady?.(this.id);
        this._flushPending();

        continue;
      }

      // 下行帧：[len][src 8 字节][payload]
      //
      // ★ 下行帧**不带 dst** —— 服务端在 write_loop 里已经按 dst 过滤过了
      //   （只接受 dst == 自己的 id 或 dst == 0），发到这里的一定是给自己的。
      //   所以客户端**不需要**再判断目标是谁，收到就处理。
      //
      // ★ 握手确认帧（[len=8][id 8]）在连接建立时就读掉了，
      //   所以这里只会看到下行帧。
      if (len < ID_LEN) {
        process.stderr.write(`[${this.name}] bad frame len ${len} (< ${ID_LEN})\n`);
        this.stop();
        return;
      }
      if (this._buffer.length < LEN_PREFIX + len) return;   // 帧还没收全

      const body = this._buffer.subarray(LEN_PREFIX, LEN_PREFIX + len);
      this._buffer = this._buffer.subarray(LEN_PREFIX + len);

      const fromId = body.readBigUInt64BE(0);
      const payload = Buffer.from(body.subarray(ID_LEN));

      this._dispatch(fromId, payload);
    }
  }

  // 业务消息分发
  //
  // own = (帧里的 id == 本连接的 id)。
  //
  // ★ 连接 id 从 1 开始（0 保留给 dst 的广播哨兵），但这里仍然用
  //   null/undefined 判断「有没有 id」而不是 `id !== 0n` —— 语义更明确，
  //   不依赖「id 不会是 0」这个前提。
  _dispatch(fromId, payload) {
    const key = this.channel || 'default';
    const list = [...(this.subs.get(key) ?? []), ...(this.subs.get('default') ?? [])];

    // own 判断：BigInt 比较
    const own = this.id !== null && fromId === this.id;

    for (const { handler, wantEcho } of list) {
      if (own && !wantEcho) continue;
      const msg = {
        kind: 'msg',
        // id 放 header（跟自定义 meta 一个路子，应用层自己读）
        header: `id=${fromId}`,
        channel: key,
        data: payload,               // Buffer —— 原样字节
        from: fromId.toString(),
        id: fromId,                  // 发送者的连接 id
      };
      try {
        handler(msg);
      } catch (e) {
        process.stderr.write(
          `[${this.name}] notify callback error: ${e?.class?.name ?? 'Error'}: ${e?.message ?? e}\n`);
      }
    }
  }
}

// payload -> Buffer
//
//   Buffer / Uint8Array  原样字节，不转换
//   string               UTF-8 编码（文本）
//   其他                 String() 后按 UTF-8
//
// ★ 不要用 'binary'（= latin1）编码字符串 —— 那会把每个字符截成 1 字节，
//   中文 "中文" 变 2 字节，收方解出来是乱码。要传原始字节就传 Buffer。
const toBuffer = (payload) => {
  if (payload === null || payload === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (Array.isArray(payload)) return Buffer.from(payload);
  return Buffer.from(String(payload), 'utf8');
};

export default TcpNotify;
