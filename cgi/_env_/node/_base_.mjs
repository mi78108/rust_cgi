#!/usr/bin/env node
// _base_.mjs — Spider CGI 框架, Node 风格
//
// 契约跟 _env_/ruby/_base_.rb 一致（同一份 ENV、同一套 MAP_PATH 匹配语义），
// 但**写法按 node 来**—— 不复刻 ruby 的 DSL 味。
//
//   import { Q } from '../_env_/node/_base_.mjs';
//
//   Q.get('/info', (req, rsp) => rsp.json({ ok: true }).finish());
//   Q.post('/upload', async (req, rsp) => rsp.send(await req.form()).finish());
//
// 三条设计线:
//   1. Rsp 抄 Response 的心智模型 —— json() / text() / html() / redirect() / status()
//   2. pattern 一律归一化成 RegExp —— 没有 <name> 占位符（命名捕获本来就是它）
//   3. route 可挂载 —— 同一个 handler 能挂多个 method / pattern
//
// ENV 契约（rust_cgi 提供, 子进程只读）:
//   Cgi_Root            cgi 脚本根目录
//   Req_Method          GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS
//   Req_Path            不含 query 的 URL path
//   Req_Version         HTTP/1.0 / HTTP/1.1
//   Req_Params          原始 query 字符串
//   Req_Body_Method     HTTP / WEBSOCKET
//   Req_Argv_N          第 N 个 restful 段, 从 1 开始
//   Req_Argv_Params     段们 / 拼接
//   Req_Argv_Count      段个数
//   Req_Script_Path/Name/Basename/Dir   脚本定位
//   Req_Peer_Ip/Port/Addr               对端
//   Req_Buffer_Size     stdin/stdout buffer hint
//   content-type / content-length / *  原始 header（小写 key）
//
// 路由匹配基准 MAP_PATH = "/" + Req_Argv_Params（脚本 URL 之后的 restful 部分）:
//   Req_Path=/test        → MAP_PATH="/"
//   Req_Path=/test/info   → MAP_PATH="/info"
//   Req_Path=/test/u/42   → MAP_PATH="/u/42"

import fs from 'node:fs';

// ============================================================
// 工具
// ============================================================

// URL 解码 —— 畸形编码 (%zz) 不抛异常, 原样返回。
//
// ★ 必须容错: ARGV 在**模块加载期**解码 ——
//   抛异常整个脚本起不来, 表现为「连接被断」, 极难定位。
const safeDecode = (s) => {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '));
  } catch {
    return String(s);
  }
};

// ============================================================
// ENV
// ============================================================
const SNAPSHOT = Object.freeze({ ...process.env });

const env = (k, fallback = null) => {
  const v = SNAPSHOT[k];
  return v === undefined || v === '' ? fallback : v;
};

const envInt = (k, fallback = 0) => {
  const v = SNAPSHOT[k];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
};

// ============================================================
// 请求侧常量
// ============================================================
const CGI_ROOT = env('Cgi_Root', process.cwd());
const REQ_METHOD = env('Req_Method', 'GET');
const REQ_PATH = env('Req_Path', '/');
const REQ_PARAMS = env('Req_Params', '');
const REQ_VERSION = env('Req_Version', 'HTTP/1.1');
const BODY_METHOD = env('Req_Body_Method', 'HTTP');
const WEBSOCKET = 'WEBSOCKET';

const PEER_IP = env('Req_Peer_Ip', '');
const PEER_PORT = envInt('Req_Peer_Port', 0);
const PEER_ADDR = `${PEER_IP}:${PEER_PORT}`;

const BUFFER_SIZE = envInt('Req_Buffer_Size', 131072);
const ARGV_COUNT = envInt('Req_Argv_Count', 0);
const ARGV_PARAMS = env('Req_Argv_Params', '');
const SCRIPT_DIR = env('Req_Script_Dir', '');
const MAP_PATH = `/${ARGV_PARAMS}`;

// Req_Argv_1..N → 解码后的 restful 段
const ARGV = Object.keys(SNAPSHOT)
  .filter((k) => /^Req_Argv_\d+$/.test(k))
  .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
  .map((k) => safeDecode(SNAPSHOT[k]));

// ============================================================
// I/O
//
// spawn 时 fd0 是 pipe。process.stdin 是异步流, 事件循环在你同步跑完
// 整个路由之前不会转 —— 混用会丢包。读一律走 readSync。
// ============================================================
const STDIN_FD = 0;
const STDOUT_FD = 1;

const readOnce = (len) => {
  const buf = Buffer.allocUnsafe(len);
  let n;
  try {
    n = fs.readSync(STDIN_FD, buf, 0, len, null);
  } catch (e) {
    if (e.code === 'EAGAIN') return null;          // 管道暂时空 → 重试
    if (e.code === 'EOF') return Buffer.alloc(0);
    throw e;
  }
  return buf.subarray(0, n);
};

// 读满 len 字节 —— EOF 提前断就返回短的（调用方自己判长度）
const readExact = (len) => {
  if (len <= 0) return Buffer.alloc(0);
  const out = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = readOnce(len - got);
    if (n === null) continue;                       // EAGAIN 重试
    if (n.length === 0) break;                      // EOF
    got += n.copy(out, got);                        // copy 返回写入字节数
  }
  return out.subarray(0, got);
};

// 尽力读一块（长连接 onData 用）
//
// ★ 传 n 就**只读 n 字节** —— 不能先读 BUFFER_SIZE 再截断,
//   那样多读的部分会被丢掉（数据丢失）。
const readSome = (n = BUFFER_SIZE) => readOnce(n) ?? Buffer.alloc(0);

// ── 异步版（WS 场景必须用）─────────────────────────────────
//
// 同步版 readSync 会**阻塞事件循环** —— 一旦卡住，
// socket 的 'data' 事件（广播消息）就永远排不上队。
// fs.read 是异步的，挂起时事件循环照常转。
//
// EOF 时 fs.read 回调收到 n=0（不抛错），跟同步版语义对齐。

const readOnceAsync = (len) => new Promise((resolve, reject) => {
  if (len <= 0) return resolve(Buffer.alloc(0));
  const buf = Buffer.allocUnsafe(len);
  fs.read(STDIN_FD, buf, 0, len, null, (err, n) => {
    if (err) {
      if (err.code === 'EOF') return resolve(Buffer.alloc(0));
      return reject(err);
    }
    resolve(buf.subarray(0, n));
  });
});

const readExactAsync = async (len) => {
  if (len <= 0) return Buffer.alloc(0);
  const out = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = await readOnceAsync(len - got);
    if (n.length === 0) break;                      // EOF
    got += n.copy(out, got);
  }
  return out.subarray(0, got);
};

// 读到 EOF —— 只在**确认**没有 content-length 时用（管道会关闭写端）
const readAll = () => {
  const parts = [];
  for (;;) {
    const n = readSome();
    if (n.length === 0) break;
    parts.push(n);
  }
  return Buffer.concat(parts);
};

const log = (...msg) => {
  fs.writeSync(2, `>>[${process.pid}]> LOG ${msg.map(String).join(' ')}\n`);
};

// fs.writeSync 无缓冲
//
// ★ 字符串一律按 **utf8** 编码 —— 'binary'(latin1) 会把每个字符截成 1 字节，
//   中文 "中文" 变 2 字节（实际字节 6 个）→ 收方解出乱码。
//   要传原始字节就传 Buffer。
const write = (content) => {
  const b = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  fs.writeSync(STDOUT_FD, b, 0, b.length);
  return b.length;
};

// ============================================================
// 解析小工具
// ============================================================

const parseQuery = (qs) => {
  const out = {};
  if (!qs) return out;
  for (const pair of String(qs).split(/[&;]/)) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = safeDecode(eq < 0 ? pair : pair.slice(0, eq));
    const val = eq < 0 ? '' : safeDecode(pair.slice(eq + 1));
    if (key in out) out[key] = [].concat(out[key], val);
    else out[key] = val;
  }
  return out;
};

const parseCookies = (raw) => {
  const out = {};
  if (!raw) return out;
  for (const pair of raw.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = safeDecode(pair.slice(0, eq).trim());
    if (k) out[k] = safeDecode(pair.slice(eq + 1).trim());
  }
  return out;
};

// ============================================================
// Req
// ============================================================
class Req {
  constructor() {
    this.method = REQ_METHOD;
    this.version = REQ_VERSION;
    this.path = MAP_PATH;               // restful 部分 = 路由匹配基准
    this.scriptPath = REQ_PATH;         // 完整 URL path
    this.query_ = REQ_PARAMS;           // 原始 query 串（'' 不是 null）
    this.contentType = env('content-type', '');
    this.contentLength = envInt('content-length', 0);
    this.peer = { ip: PEER_IP, port: PEER_PORT };
    this.argv = ARGV;
    this._captures = {};           // 本次路由匹配的命名捕获
    this._query = null;            // query 解析结果（缓存）
    this._cookies = null;          // cookie 解析结果（缓存）
    this._form = null;             // urlencoded body 解析结果（缓存）
    this._body = undefined;        // body Buffer + text
  }

  // --- query ---
  //
  // ★ 缓存 —— 每次都重新 parseQuery 会造出新对象,
  //   req.query === req.query 为 false, 引用比较会失败。
  get query() {
    if (this._query === null) this._query = parseQuery(this.query_);
    return this._query;
  }

  q(key, fallback = null) {
    const v = this.query[key];
    if (v === undefined || v === '') return fallback;
    return Array.isArray(v) ? (v[0] ?? fallback) : v;
  }

  // --- headers ---
  header(name, fallback = null) {
    const v = SNAPSHOT[String(name).toLowerCase()];
    return v === undefined || v === '' ? fallback : v;
  }

  // --- cookies ---
  get cookies() {
    if (this._cookies === null) this._cookies = parseCookies(this.header('cookie', ''));
    return this._cookies;
  }

  cookie(name, fallback = null) {
    const v = this.cookies[name];
    return v === undefined ? fallback : v;
  }

  // --- 命名捕获 ---
  //
  // ★ 捕获随请求走（this._captures），不是模块级全局 ——
  //   全局变量会被后续路由的匹配清空，async handler 里
  //   await 之后再读就变 null 了。
  named(name, fallback = null) {
    const v = this._captures[name];
    return v === undefined ? fallback : v;
  }

  // --- body ---
  get body() {
    if (this._body === undefined) {
      const n = this.contentLength;
      // content-length 为 0 时**不能**退回 readSome —— 管道没有 writer 会
      // 永远阻塞在 readSync 上（请求已发完但没人关闭写端）。
      const raw = n > 0 ? readExact(n) : Buffer.alloc(0);
      this._body = { raw, text: raw.toString('utf8') };
    }
    return this._body;
  }

  json() {
    const t = this.body.text;
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }

  // urlencoded body —— q() 只看 query, form 参数在 body 里
  get form() {
    if (this._form === null) {
      this._form = /x-www-form-urlencoded/.test(this.contentType)
        ? parseQuery(this.body.text)
        : {};
    }
    return this._form;
  }

  // multipart → Form | null
  formData() {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(this.contentType);
    if (!/form-data/.test(this.contentType) || !m) return null;
    return new Form(parseMultipart(this.body.raw, (m[1] ?? m[2]).trim()));
  }

  // --- 长连接 ---
  onData(cb) {
    for (;;) {
      const chunk = readSome();
      if (chunk.length === 0) {
        log('connection EOF');
        return;
      }
      const ret = cb(chunk);
      if (ret != null) write(ret);
    }
  }

  // WS: rust 侧注入 9 字节头 = [len:4BE][remainder:4BE][flags:1], 之后 len 字节 payload
  //   len      = 本段 payload 字节数
  //   remainder= 本帧 payload 还剩多少 (0 = 这帧读完)
  //   flags    = bit0 = 本段是整个 WS 消息的最后一片
  // flags bit0 才是"消息结束"的信号 —— remainder===0 只说明这一帧读完,
  // 分片消息(一个消息拆成多帧)要等最后一片才交付。
  //
  // ★ 同步版。**会阻塞事件循环** —— WS 场景要同时处理 BDR 广播的话
  //   必须用 onMessageAsync()（见下面）。
  onMessage(cb) {
    return this._readMessages(readExact, cb);
  }

  // --- WS: 异步版 ---
  //
  // ★ 为什么需要异步版
  //
  //   onMessage() 用 readExact()/readSync() —— **同步阻塞**。
  //   在 WS 场景里这会**饿死事件循环**：脚本既要读浏览器发来的帧，
  //   又要处理 BDR 广播 socket 的 'data' 事件（别的客户端发来的消息）。
  //   一旦卡在 readSync(0) 上，socket 的事件回调就永远排不上队 →
  //   广播进来的消息收不到（表现为「只有自己说话，别人说话没反应」）。
  //
  //   fs.read() 是异步的 —— 挂起时不阻塞事件循环，
  //   实测：pending 的 fs.read 不影响 timer / socket 事件触发。
  //
  // 用法：
  //   req.onMessageAsync((msg) => { ...; return 'reply' })   // 返回值自动 wsWrite
  //
  // 与同步版的差异：
  //   · 回调可以是 async
  //   · 返回值（Promise 或普通值）都会走 wsWrite 加帧头
  //   · 需要 await handler 完成后才继续读下一帧
  onMessageAsync(cb) {
    return this._readMessages(readExactAsync, cb, true);
  }

  // WS 消息循环 —— 同步/异步共用。
  //
  // read:  读指定字节数的函数（readExact / readExactAsync）
  // isAsync: 回调结果要不要 await
  async _readMessages(read, cb, isAsync = false) {
    let buf = Buffer.alloc(0);
    for (;;) {
      const head = await read(9);
      if (head.length < 9) return;                       // EOF → 干净退出
      const len = head.readUInt32BE(0);
      const flags = head[8];
      const payload = await read(len);
      if (payload.length < len) return;                   // 半包
      buf = Buffer.concat([buf, payload]);
      if (flags & 0x01) {                                 // 最后一片 → 交付
        const ret = isAsync ? await cb?.(buf) : cb?.(buf);
        buf = Buffer.alloc(0);
        // ★ 必须走 wsFrame —— server→client 方向要自己加 4 字节长度前缀。
        //   裸写的话 Rust 会把前 4 个字节当成长度 → 帧错乱 → 客户端收不到。
        if (ret != null) write(wsFrame(ret));
      }
    }
  }
}

// ============================================================
// multipart/form-data
// ============================================================
class FormItem {
  constructor({ name, filename, contentType, content }) {
    this.name = name;
    this.filename = filename;
    this.contentType = contentType;
    this.content = content;                                 // Buffer
  }

  get isFile() { return Boolean(this.filename); }
  get size() { return this.content.length; }
  text() { return this.content.toString('utf8'); }

  toJSON() {
    return {
      name: this.name,
      filename: this.filename,
      content_type: this.contentType,
      size: this.content.length,
    };
  }
}

class Form {
  constructor(items) { this.items = items; }

  get(name) { return this.items.find((i) => i.name === String(name)) ?? null; }
  get files() { return this.items.filter((i) => i.isFile); }
  get values() { return this.items.map((i) => i.name); }
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
}

const parseMultipart = (buf, boundary) => {
  const items = [];
  const delim = Buffer.from(`--${boundary}`);

  let pos = buf.indexOf(delim);
  while (pos >= 0) {
    let cur = pos + delim.length;
    if (buf[cur] === 0x2d && buf[cur + 1] === 0x2d) break;      // '--' 终止

    // 跳过 boundary 后的 CRLF
    if (buf[cur] === 0x0d && buf[cur + 1] === 0x0a) cur += 2;
    else if (buf[cur] === 0x0a) cur += 1;

    const headEnd = buf.indexOf('\r\n\r\n', cur, 'binary');
    if (headEnd < 0) break;
    const next = buf.indexOf(delim, headEnd + 4);
    // 末尾 CRLF 属于分隔符, 不算内容
    let bodyEnd = next < 0 ? buf.length : next;
    if (buf[bodyEnd - 1] === 0x0a) bodyEnd -= 1;
    if (buf[bodyEnd - 1] === 0x0d) bodyEnd -= 1;

    items.push(buildFormItem(
      buf.toString('binary', cur, headEnd),
      buf.subarray(headEnd + 4, bodyEnd),
    ));
    if (next < 0) break;
    pos = next;
  }
  return items;
};

const buildFormItem = (rawHeaders, content) => {
  const out = { name: null, filename: null, contentType: 'text/plain' };

  for (const line of rawHeaders.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();

    if (key === 'content-disposition') {
      for (const seg of val.split(';')) {
        const eq = seg.indexOf('=');
        if (eq < 0) continue;
        const pk = seg.slice(0, eq).trim().toLowerCase();
        const pv = seg.slice(eq + 1).trim().replace(/^"|"$/g, '');
        // RFC 5987: filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt
        if (pk === 'filename*') out.filename = safeDecode(pv.split("'").pop());
        else if (pk === 'name') out.name = pv;
        else if (pk === 'filename') out.filename = safeDecode(pv);
      }
    } else if (key === 'content-type') {
      out.contentType = val;
    }
  }
  return new FormItem({ ...out, content });
};

// ============================================================
// Body —— size 已知走 Content-Length, 未知走 chunked
// ============================================================
class Body {
  get size() { return null; }                       // null = 未知
  eachChunk(_fn) { /* noop */ }
}

class TextBody extends Body {
  constructor(s) {
    super();
    this.buf = Buffer.isBuffer(s) ? s : Buffer.from(String(s ?? ''), 'utf8');
  }
  get size() { return this.buf.length; }
  eachChunk(fn) { if (this.buf.length) fn(this.buf); }
}

class FileBody extends Body {
  constructor(file) {
    super();
    this.path = file;
    this.fd = fs.openSync(file, 'r');
    // ★ size 是**继承自 Body 的 getter**（只有 getter，没有 setter），
    //   在这里写 `this.size = ...` 会抛
    //   TypeError: Cannot set property size of #<Body> which has only a getter
    //   —— 构造函数整个炸掉，toBody() 的 catch 又把它降级成 TextBody，
    //   于是 rsp.file(path) 发出去的是**路径字符串**而不是文件内容。
    //   所以这里用 _size 私有字段 + 覆盖 getter。
    this._size = fs.fstatSync(this.fd).size;
  }
  get size() { return this._size; }
  eachChunk(fn) {
    const buf = Buffer.allocUnsafe(BUFFER_SIZE);
    for (let pos = 0; pos < this.size;) {
      const n = fs.readSync(this.fd, buf, 0, BUFFER_SIZE, pos);
      if (n === 0) break;
      pos += n;
      fn(Buffer.from(buf.subarray(0, n)));          // 拷出来, buf 会复用
    }
  }
  close() { try { fs.closeSync(this.fd); } catch { /* already closed */ } }
}

class StreamBody extends Body {
  constructor(fn) { super(); this.fn = fn; }        // fn(emit) => void
  eachChunk(sink) {
    // ★ emit 是**参数**, 不是 this.emit ——
    //   之前写成 this.emit(...) → TypeError: this.emit is not a function
    //   → rsp.body(fn) + rsp.stream() 直接炸。
    //   sink 是 Body 契约里的下游（writeChunk / write）。
    this.fn((c) => {
      if (c == null || c === false || c === '') return;
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8');
      if (b.length) sink(b);
    });
  }
}

// 是不是一个存在的文件路径
//
// ★ body() 要用它区分「路径」和「文本」——
//   rsp.file(path) 传的也是字符串，不判的话会被当文本发出去。
const isFilePath = (v) => {
  if (!v || v.includes('\0')) return false;
  // 太长 / 含换行的肯定不是路径
  if (v.length > 4096 || /[\r\n]/.test(v)) return false;
  try {
    return fs.statSync(v).isFile();
  } catch {
    return false;
  }
};

// body 工厂 —— 类型分派
//
// xform: 可选的文本变换（模板替换用）。**只作用于文本 body** ——
// 文件 body 是原始字节, 不能被改。
const toBody = (v, xform) => {
  if (v == null) return new TextBody('');
  if (v instanceof Body) return v;
  if (typeof v === 'function') return new StreamBody(v);
  if (typeof v === 'string') {
    // ★ 字符串有两种含义：**文件路径** 和 **文本内容**。
    //   先判是不是存在的文件 —— 否则 rsp.file(path) 会把**路径本身**
    //   当成响应体发出去。
    if (isFilePath(v)) return new FileBody(v);
    return new TextBody(xform ? xform(v) : v);
  }
  if (Buffer.isBuffer(v)) return new TextBody(v);
  // Readable / 有 .read 的
  if (typeof v.read === 'function') {
    return new StreamBody((emit) => {
      const b = Buffer.allocUnsafe(BUFFER_SIZE);
      for (;;) {
        const n = v.read(b);
        if (!n) break;
        emit(Buffer.isBuffer(n) ? n : Buffer.from(n));
      }
    });
  }
  return new TextBody(String(v));
};

// ============================================================
// Rsp —— 抄 Response 的心智模型
// ============================================================
const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
  413: 'Payload Too Large', 415: 'Unsupported Media Type',
  422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented',
};

class Rsp {
  constructor() {
    this.statusCode = 200;
    this.statusText = 'OK';
    this.headers = new Map([['Connection', 'close']]);
    this.bodyObj = new TextBody('');
    this.sent = false;
    this.chunked = false;
    this.ctx = {};                          // 模板变量（方法名 vars 不能被字段占用）
    this.templated = false;                 // 是否显式调过 vars()（决定要不要 subst）
  }

  // --- status ---
  status(code, text) {
    this.statusCode = code;
    this.statusText = text ?? STATUS_TEXT[code] ?? 'Unknown';
    return this;
  }

  // --- header ---
  //
  // ★ header 值是 **string | string[]** —— 多值 header（Set-Cookie 等）
  //   用数组存, 不把 '\r\nKey: v' 塞进 Map 的 value 里。
  //   （之前那样写: get('Set-Cookie') 拿回来的字符串里嵌着完整 header 行,
  //    调用方没法用; writeHeaders 也要靠字符串拼接还原。）
  set(k, v) { this.headers.set(k, String(v)); return this; }

  append(k, v) {
    const cur = this.headers.get(k);
    if (cur === undefined) this.headers.set(k, String(v));
    else if (Array.isArray(cur)) cur.push(String(v));
    else this.headers.set(k, [cur, String(v)]);
    return this;
  }

  // 取 header —— 多值时返回**第一个**（跟 HTTP 语义一致）
  get(k) {
    const v = this.headers.get(k);
    if (v === undefined) return null;
    return Array.isArray(v) ? (v[0] ?? null) : v;
  }

  // 取全部值 —— 多值 header 用
  all(k) {
    const v = this.headers.get(k);
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  }

  del(k) { this.headers.delete(k); return this; }

  type(mime) { return this.set('Content-Type', mime); }

  // --- body ---
  //
  // ★ body() **只设置 body, 不发送**。
  //
  //   为什么: json()/html()/text() 是**终结调用** —— 它们设好 Content-Type
  //   就把响应发出去。之后再链 `.set('X-Foo', ...)` 头已经发出去了,
  //   **设置静默失效**（实测: rsp.json({...}).set('X-Late','v') → 头里没有 X-Late）。
  //
  //   跟 ruby 版对齐: ruby 的 body() 只设 body, finish() 才发。
  //   ruby 的 json/html 是 ok_json/ok_html 这类**独立**方法。
  //
  //   现在 node 的 json/html/text/xml **也只设 body** —— 由 exec() 统一 finish()。
  //   所以链式调用全程有效:
  //     rsp.set('X-Foo','v').json({...})        ✓ 头生效
  //     rsp.json({...}).set('X-Foo','v')        ✓ 头也生效（body 已设, finish 在后面）
  body(v) {
    // 模板替换只在**显式调过 vars()** 时做 —— 否则 json 里的 {{}} 会被吃掉。
    this.bodyObj = toBody(v, this.templated ? (s) => this.subst(s) : null);
    return this;
  }

  json(obj) {
    this.type('application/json; charset=utf-8');
    return this.body(JSON.stringify(obj ?? null));
  }
  html(t) { this.type('text/html; charset=utf-8'); return this.body(t); }
  text(t) { this.type('text/plain; charset=utf-8'); return this.body(t); }
  xml(t) { this.type('application/xml; charset=utf-8'); return this.body(t); }

  // --- redirect ---
  //
  // ★ 不在这里 finish() —— redirect 只是设状态码 + Location,
  //   body 空不空无所谓, 由 exec() 统一 finish()。
  redirect(loc, code = 302) {
    this.status(code).set('Location', loc);
    return this;
  }

  // --- WS 帧 ---
  //
  // server → client 方向：**必须**自己加 4 字节长度前缀
  // （spider 的 Websocket::write 按 [len u32 BE][payload] 切帧）。
  //
  //   rsp.wsWrite({ type: 'msg', text: 'hi' })   ← 传对象会自动 JSON.stringify
  //   rsp.wsWrite('raw text')
  //   rsp.wsWrite(buf)                            ← Buffer 原样，不加编码
  wsWrite(data) {
    const payload = (typeof data === 'string' || Buffer.isBuffer(data))
      ? data
      : JSON.stringify(data ?? null);
    write(wsFrame(payload));
    return this;
  }

  // --- 文件 ---
  // rsp.file(path)              inline
  // rsp.file(path, 'name.txt')  attachment
  // rsp.file(path, { mime, as })
  file(p, opts) {
    const { mime, as } = typeof opts === 'string'
      ? { as: opts }
      : (opts ?? {});
    try {
      fs.accessSync(p, fs.constants.R_OK);
    } catch {
      return this.status(404).text(`file not found: ${p}`);
    }
    if (mime) this.type(mime);
    this.set('Content-Disposition', as ? `attachment; filename="${as}"` : 'inline');
    return this.body(p);
  }

  // --- cookie ---
  cookie(name, value, o = {}) {
    const parts = [`${name}=${value}`, `Path=${o.path ?? '/'}`];
    if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
    if (o.httpOnly) parts.push('HttpOnly');
    if (o.secure) parts.push('Secure');
    if (o.sameSite) parts.push(`SameSite=${o.sameSite}`);
    return this.append('Set-Cookie', parts.join('; '));
  }

  // --- 模板变量 ---
  //
  // ★ **只有显式调了 vars() 才做替换**。
  //   之前 body() 对所有字符串无条件 subst → rsp.json({tpl:'{{user}}'})
  //   会把 JSON 里的 {{user}} 吃掉（输出 {"tpl":""}）。
  //   模板替换必须是**显式意图**, 不能是 body() 的副作用。
  //
  //   rsp.vars({ user: 'x' }).html('<p>{{user}}</p>')   → 替换
  //   rsp.html('<p>{{user}}</p>')                        → 原样输出
  vars(obj) {
    Object.assign(this.ctx, obj);
    this.templated = true;
    return this;
  }
  render(obj) { return this.vars(obj); }

  subst(tpl) {
    return String(tpl).replace(/\{\{\s*([\w$]+(?:\.[\w$]+)*)\s*\}\}/g, (_m, expr) => {
      const v = expr.split('.')
        .reduce((o, k) => (o == null ? o : o[k]), this.ctx);
      return v == null ? '' : String(v);
    });
  }

  // --- chunked ---
  // rsp.stream(i => i < 5 ? `tick ${i}\n` : null)   生成器
  // rsp.stream('text/event-stream', i => ...)      指定 content-type
  // rsp.stream()                                   flush 已设的 body
  stream(mimeOrFn, maybeFn) {
    const fn = typeof mimeOrFn === 'function' ? mimeOrFn : maybeFn;
    if (typeof mimeOrFn === 'string') this.type(mimeOrFn);

    if (!this.chunked) {
      this.chunked = true;
      this.del('Content-Length').set('Transfer-Encoding', 'chunked');
      writeHeaders(this, null);
    }

    if (fn) {
      for (let i = 0; i < 1024; i += 1) {           // 上限防死循环
        const data = fn(i);
        if (data == null || data === false) break;
        const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        if (!b.length) break;
        writeChunk(b);
      }
    } else {
      this.bodyObj.eachChunk(writeChunk);
    }
    writeChunkEnd();
    this.sent = true;              // 头和 chunk 都发完了 —— 别再 finish()
    STATE.responded = true;
    return this;
  }

  // --- 幂等发送 ---
  //
  // 两种发送路径，只会发生一种:
  //   chunked（stream 走过）→ headers/chunks/end 已在 stream() 里发完，这里什么都不做
  //   Content-Length        → 正常发 headers + body
  finish() {
    if (this.sent) return this;
    this.sent = true;
    STATE.responded = true;
    if (BODY_METHOD === WEBSOCKET || this.chunked) return this;

    const size = this.bodyObj.size ?? 0;
    writeHeaders(this, size);
    // ★ HEAD 请求**不发 body** —— 但 Content-Length 照发（HTTP 语义）。
    //   否则客户端会等一个永远不来的 body。
    if (size && REQ_METHOD !== 'HEAD') this.bodyObj.eachChunk(write);
    return this;
  }
}

// ============================================================
// HTTP 字节输出
// ============================================================
const writeHeaders = (rsp, contentLength) => {
  if (contentLength !== null) rsp.set('Content-Length', String(contentLength));
  let head = `HTTP/1.0 ${rsp.statusCode} ${rsp.statusText}\r\n`;
  for (const [k, v] of rsp.headers) {
    // 多值 header（Set-Cookie）—— 每个值一行
    if (Array.isArray(v)) {
      for (const one of v) head += `${k}: ${one}\r\n`;
    } else {
      head += `${k}: ${v}\r\n`;
    }
  }
  head += '\r\n';
  write(head);
};

const writeChunk = (b) => {
  write(`${b.length.toString(16)}\r\n`);
  write(b);
  write('\r\n');
};

const writeChunkEnd = () => write('0\r\n\r\n');

// WS 帧头 —— server → client 方向必须自己加
//
// ★ spider 的 Websocket::write() 按「[len u32 BE][payload]」切帧：
//   它读前 4 字节当长度，然后把这么长的字节当成一个 WS frame 的 payload。
//   所以 CGI 往 stdout 写 WS 消息时，**必须**自己加 4 字节长度前缀，
//   否则前 4 个字节会被当成长度 → 帧长错乱 → 客户端收到乱码或收不到。
//
//   （客户端 → server 方向不用加：spider 那边已经加了 [len][rem][flags]。）
const WS_LEN_PREFIX = 4;

const wsFrame = (payload) => {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  const head = Buffer.allocUnsafe(WS_LEN_PREFIX);
  head.writeUInt32BE(b.length, 0);
  return Buffer.concat([head, b]);
};

const writeResp = (code, status, header, content) => {
  const body = content == null ? '' : String(content);
  const rsp = new Rsp();
  rsp.status(code, status);
  for (const [k, v] of Object.entries(header)) rsp.set(k, v);
  writeHeaders(rsp, Buffer.byteLength(body, 'utf8'));
  if (REQ_METHOD !== 'HEAD') write(body);
  // ★ 标记已响应 —— 否则 beforeExit 和 exit 都会写 404 → 响应发两遍。
  STATE.responded = true;
};

// ============================================================
// 路由 —— pattern 一律归一化成 RegExp
//
//   Q.get('/info', h)            string  → /^\/info$/
//   Q.get(/^\/u\/(?<id>\d+)$/, h)  RegExp → 外面包一层锚点
//   Q.get(/u\/(?<id>\d+)/, h)     不写 ^$ 也行（外层统一加）
//   Q.get('/u/<id>', h)          字符串占位符 → (?<id>[^/]+)
//   Q.get(h)                       无 pattern = 兜底
//   Q.get((map) => bool, h)        predicate 兜底
//
// 没有 <name> 占位符 —— 命名捕获本来就是 RegExp 的功能。
// ============================================================

// JS 没有 \A \z（那是 ruby 锚点），用 ^ $（非 multiline 时等价）
const anchored = (re) => new RegExp(`^(?:${re.source})$`, re.flags.replace(/[gy]/g, ''));

// ★ 字符串 pattern → 正则
//
//   '<id>' → '(?<id>[^/]+)' —— 一段路径对应一个名字。
//   名字里不能有 '/'（否则跟段边界冲突）。
//
//   转义顺序很重要: 先把 <name> 换成占位标记, 再对**其余**字符做转义,
//   否则会把刚生成的 '(?<id>...)' 里的特殊字符也转义掉。
const PLACEHOLDER = /<([A-Za-z_][A-Za-z0-9_]*)>/g;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const patternToRegExp = (p) => {
  let out = '';
  let last = 0;
  for (const m of p.matchAll(PLACEHOLDER)) {
    out += escapeRe(p.slice(last, m.index));
    out += `(?<${m[1]}>[^/]+)`;
    last = m.index + m[0].length;
  }
  out += escapeRe(p.slice(last));
  return new RegExp(`^${out}$`);
};

// ★ matcher 契约: **返回命名捕获对象 = 命中, 返回 null = 没命中**。
//   统一成一种形状 —— 之前有 boolean 和 object 混着返回, 调用处
//   得写 `hit !== null && hit !== false` 那种防御式判断。
//
//   不用模块级 MATCH 全局变量: 那个全局被每次匹配清空,
//   async handler 里 await 之后 req.named() 就变 null 了。
//   现在捕获随请求走, 谁匹配谁拿自己的。
const toMatcher = (pattern) => {
  if (pattern == null) return () => ({});                     // 兜底
  if (pattern instanceof RegExp) {
    const re = anchored(pattern);                             // 编译一次
    return (path) => {
      const m = re.exec(path);
      return m ? { ...(m.groups ?? {}) } : null;
    };
  }
  if (typeof pattern === 'function') {
    // predicate —— 返回真值即命中
    return (path) => (pattern(path) ? {} : null);
  }
  const p = String(pattern);
  if (!p.startsWith('/')) {
    throw new Error(`Q.route pattern 必须以 '/' 开头, got: ${JSON.stringify(pattern)}`);
  }
  if (p === '/*') return (path) => (path !== '/' ? {} : null);
  const re = patternToRegExp(p);
  return (path) => {
    const m = re.exec(path);
    return m ? { ...(m.groups ?? {}) } : null;
  };
};

const describe = (pattern) => {
  if (pattern == null) return 'null';
  if (pattern instanceof RegExp) return String(pattern);
  if (typeof pattern === 'function') return '[Function]';
  return JSON.stringify(pattern);
};

// 匹配 + 记录日志。返回命名捕获对象或 null。
const matchPattern = (matcher, pattern) => {
  const hit = matcher(MAP_PATH);
  log(`Q.match ${describe(pattern).padEnd(34)} [${hit ? 'hit ' : 'miss'}]`
    + ` map_path=${JSON.stringify(MAP_PATH)}`
    + (hit && Object.keys(hit).length ? `  captured=${JSON.stringify(hit)}` : ''));
  return hit;
};

// ============================================================
// Q
// ============================================================
const STATE = { responded: false, dispatched: false };
const ONCLOSE = [];

const onClose = (cb) => { ONCLOSE.push(cb); };

const scriptName = () => SNAPSHOT.Req_Script_Name ?? null;
const scriptBasename = () => SNAPSHOT.Req_Script_Basename ?? null;
const scriptFile = () => SNAPSHOT.Req_Script_Path ?? null;
const scriptDir = () => SNAPSHOT.Req_Script_Dir ?? null;
const scriptCwd = () => SNAPSHOT.Req_Script_Dir || null;

let closed = false;

// onClose 回调 + END banner —— 保证只跑一次
// 路由命中走 shutdown()（process.exit 触发 exit handler），未命中靠 exit handler，
// 两条路径都会撞到这里，所以必须加幂等标志，否则回调跑两遍。
//
// ★ 回调**可以是 async** —— 需要在进程退出前把数据发出去的场景
//   （比如广播「某人下线」）必须 await 到 flush 完成，
//   否则 process.exit() 会把还在写队列里的数据丢掉。
//   非 async 回调走同步路径，行为不变。
const ONCLOSE_TIMEOUT_MS = 2000;

const runOnClose = async () => {
  if (closed) return;
  closed = true;
  for (const cb of ONCLOSE) {
    try {
      let r = cb();
      if (r && typeof r.then === 'function') {
        // 超时保护 —— 回调卡住不能把进程吊死（spider 会等超时）
        //
        // ★ timer.unref() —— 不让这个兜底 timer 把事件循环吊住。
        //   否则即使回调 1ms 就完成, 进程也要干等满 2 秒才退出
        //   （每次 WS 断开都白等 2 秒, spider 那边也等）。
        //   unref 的 timer 不计入事件循环存活 —— 回调自己的 await
        //   （socket 写 / 定时器）会正常吊住循环。
        let timer;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve('(timeout)'), ONCLOSE_TIMEOUT_MS);
          timer.unref?.();
        });
        r = await Promise.race([r, timeout]);
        clearTimeout(timer);
      }
      fs.writeSync(2, ` >>> onclose -> ${r}\n`);
    } catch (e) {
      fs.writeSync(2, ` >>> onclose error: ${e.message}\n`);
    }
  }
  fs.writeSync(2, ` ******************** [${process.pid}]> END   cgi ${scriptName()} ******************** \n`);
};

// ★ 兜底 —— 404 路径（没有任何路由命中）走的是 process 'beforeExit'。
//   'exit' 处理器**不能 await** —— 进程正在退出, microtask 不会跑完。
//   所以 async 回调在 exit 路径会被完全截断（实测 0 次完成）。
//
//   解法: 用 'beforeExit' —— 它在事件循环空转时触发, **可以** await。
//   'exit' 只作为最后一道保险（同步写 END banner）。
//
//   'beforeExit' 的坑: 回调里如果又有异步工作, 会再次触发 'beforeExit'。
//   closed 标志保证只跑一次。
const shutdown = (code) => {
  runOnClose()
    .catch(() => {})
    .finally(() => process.exit(code));
};

// 跑 handler —— 同步 / async 都吃, 异常 → 500
const exec = async (handler, captures) => {
  const rsp = new Rsp();
  const req = new Req();
  req._captures = captures ?? {};
  try {
    await handler(req, rsp);
  } catch (e) {
    log(`${e.constructor.name}: ${e.message}`);
    log(String(e.stack ?? '').split('\n').slice(1, 6).map((l) => `  ${l}`));
    if (!rsp.sent) rsp.status(500).text(`${e.constructor.name}: ${e.message}`);
  }
  if (!rsp.sent) rsp.finish();
};

// 立即匹配 + 执行。
//
// ★ **首个匹配的路由胜出** —— 后续 route() 直接返回, 不再执行。
//   跟 ruby 版一致（ruby 用 catch/throw 抛 :q_resp_sent 跳过后续路由）。
//   之前 node 版会继续跑后面的路由 → handler 执行两次 →
//   HTTP 头发两遍 → 响应体是坏的。
const route = (pattern, methods, handler) => {
  // 已经命中过了 —— 后续路由不再执行
  if (STATE.dispatched) return Q;

  // 正则在这里编译一次并被 matcher 闭包捕获 —— 匹配时不再 new RegExp
  const matcher = toMatcher(pattern);
  const ms = methods == null ? null
    : [].concat(methods).map((m) => String(m).toUpperCase());

  // 匹配基准是 MAP_PATH（脚本位置之后的 restful 部分）,
  // 不是完整 URL —— 完整 URL 在 req.scriptPath。
  const methodOk = ms?.includes(WEBSOCKET)
    ? BODY_METHOD === WEBSOCKET                       // WS 路由只看 BODY_METHOD
    : (!ms || ms.length === 0 || ms.includes(REQ_METHOD));

  const captures = methodOk ? matchPattern(matcher, pattern) : null;
  if (!captures) return Q;

  STATE.dispatched = true;
  if (SCRIPT_DIR) { try { process.chdir(SCRIPT_DIR); } catch { /* dir gone */ } }
  // exec 内部已兜住 handler 异常；这里再兜一层 —— 万一 exec 本身炸了
  // （new Req() 失败等），也要 shutdown，否则进程挂到 spider 超时。
  exec(handler, captures).then(() => shutdown(0), (e) => {
    log(`exec failed: ${e?.message ?? e}`);
    shutdown(1);
  });
  return Q;
};

export const Q = {
  // 常量
  ARGV, ARGV_COUNT, ARGV_PARAMS, MAP_PATH, BUFFER_SIZE, CGI_ROOT,
  PEER_IP, PEER_PORT, PEER_ADDR, REQ_METHOD, REQ_PATH, REQ_PARAMS, SCRIPT_DIR,

  // I/O
  //   Q.read()        读到 EOF（body 无 content-length 时的兜底）
  //   Q.read(n)       读满 n 字节（EOF 提前断则返回短的）—— n<=0 视为「读到 EOF」
  //   Q.recv(n)       读一块，最多 n 字节 —— 长连接 onData 用这个
  //   Q.readBuf(n)    同 read(n) 但返回 **Buffer**（二进制不丢）
  //
  // ★ read/recv 返回**字符串** —— 二进制数据会被 utf8 解码损坏。
  //   要原始字节用 readBuf()。
  read: (n) => (n === undefined || n <= 0 ? readAll() : readExact(n)).toString('utf8'),
  readBuf: (n) => (n === undefined || n <= 0 ? readAll() : readExact(n)),
  recv: (n) => readSome(n ?? BUFFER_SIZE).toString('utf8'),
  recvBuf: (n) => readSome(n ?? BUFFER_SIZE),
  write, log,

  // 脚本定位
  scriptName, scriptBasename, scriptFile, scriptDir, scriptCwd,
  cwd: scriptCwd,

  // 路由
  route,
  ws: (pattern, handler) => route(pattern, WEBSOCKET, handler),
  onClose,

  // 类
  Req, Rsp, Body, TextBody, FileBody, StreamBody, Form, FormItem,

  get responded() { return STATE.responded; },
};

// 挂载式用法:
//   const info = (req, rsp) => rsp.json({ ok: true }).finish();
//   Q.get('/info', info);
//   Q.post('/info', info);
for (const m of ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']) {
  Q[m] = (pattern, handler) => route(pattern, m.toUpperCase(), handler);
}

export default Q;

// ============================================================
// 生命周期
// ============================================================
//
// ★ 'beforeExit' 而不是 'exit' ——
//   'exit' 处理器不能 await: 进程正在退出, pending 的 promise 回调
//   不会再跑。async 的 onClose 回调（比如「广播某人下线」）会被**完全截断**。
//
//   'beforeExit' 在事件循环空转时触发, 可以 await —— 异步回调能跑完。
//
//   'exit' 保留作最后一道保险（只补 END banner, 幂等）。
process.on('beforeExit', () => {
  // 所有 route 都没匹配 → 兜底 404（WS 靠 STDIN EOF 关闭, 不写）
  if (!STATE.responded && BODY_METHOD !== WEBSOCKET) {
    writeResp(404, STATUS_TEXT[404], {},
      `unhandled request: ${REQ_PATH} with ${REQ_METHOD}\n`);
  }
  runOnClose().catch(() => {});   // 幂等 —— 命中路由时 shutdown() 已经调过了
});

process.on('exit', () => {
  // 'beforeExit' 没跑成的兜底（比如 beforeExit 里又抛了错）
  if (!STATE.responded && BODY_METHOD !== WEBSOCKET) {
    writeResp(404, STATUS_TEXT[404], {},
      `unhandled request: ${REQ_PATH} with ${REQ_METHOD}\n`);
  }
  if (!closed) {
    closed = true;
    fs.writeSync(2, ` ******************** [${process.pid}]> END   cgi ${scriptName()} ******************** \n`);
  }
});

fs.writeSync(2, ` ******************** [${process.pid}]> BEGIN cgi ${scriptName()} ******************** \n`);