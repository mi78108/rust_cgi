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
  .map((k) => decodeURIComponent(SNAPSHOT[k]));

// 最近一次命名捕获
const MATCH = {};

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

// 读满 len 字节, EOF 提前断就返回短的（调用方自己判长度）
const readExact = (len) => {
  if (len <= 0) return Buffer.alloc(0);
  const out = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = readOnce(len - got);
    if (n === null) continue;                       // EAGAIN 重试
    if (n.length === 0) break;                      // EOF
    n.copy(out, got);
    got += n.length;
  }
  return out.subarray(0, got);
};

// 尽力读一块（长连接 onData 用）
const readSome = () => readOnce(BUFFER_SIZE) ?? Buffer.alloc(0);

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
const write = (content) => {
  const b = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'binary');
  fs.writeSync(STDOUT_FD, b, 0, b.length);
  return b.length;
};

// ============================================================
// 解析小工具
// ============================================================
const safeDecode = (s) => {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' '));
  } catch {
    return String(s);
  }
};

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
    this._params = null;
    this._cookies = null;
    this._body = undefined;
  }

  // --- query ---
  get query() { return parseQuery(this.query_); }

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
  named(name, fallback = null) {
    const v = MATCH[name];
    return v === undefined ? fallback : v;
  }

  // --- body ---
  get body() {
    if (this._body === undefined) {
      const n = this.contentLength;
      // content-length 为 0 时**不能**退回 readSome —— 管道没有 writer 会
      // 永远阻塞在 readSync 上（请求已发完但没人关闭写端）。
      const raw = n > 0 ? readExact(n) : Buffer.alloc(0);
      this._body = { raw, text: raw.toString('binary') };
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
    if (!/x-www-form-urlencoded/.test(this.contentType)) return {};
    return parseQuery(this.body.text);
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

  // WS: rust 侧注入 8 字节头 = [len:4BE][remainder:4BE], 之后 len 字节 payload
  // remainder 归零才是一次完整消息
  onMessage(cb) {
    let buf = Buffer.alloc(0);
    for (;;) {
      const head = readExact(8);
      if (head.length < 8) return;                       // EOF → 干净退出
      const len = head.readUInt32BE(0);
      const remainder = head.readUInt32BE(4);
      const payload = readExact(len);
      if (payload.length < len) return;                   // 半包
      buf = Buffer.concat([buf, payload]);
      if (remainder === 0) {
        const ret = cb?.(buf);
        buf = Buffer.alloc(0);
        if (ret != null) write(ret);
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

const CRLF = Buffer.from('\r\n');

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
    this.buf = Buffer.isBuffer(s) ? s : Buffer.from(String(s ?? ''), 'binary');
  }
  get size() { return this.buf.length; }
  eachChunk(fn) { if (this.buf.length) fn(this.buf); }
}

class FileBody extends Body {
  constructor(file) {
    super();
    this.path = file;
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
  }
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
  eachChunk(chunkSize = BUFFER_SIZE) {
    this.fn((c) => {
      if (c == null || c === false || c === '') return;
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'binary');
      if (b.length) this.emit(b);
    }, chunkSize);
  }
}

// body 工厂 —— 类型分派
const toBody = (v) => {
  if (v == null) return new TextBody('');
  if (v instanceof Body) return v;
  if (typeof v === 'function') return new StreamBody(v);
  if (typeof v === 'string') {
    try {
      if (fs.statSync(v).isFile()) return new FileBody(v);    // 路径 → FileBody
    } catch { /* 不是文件 */ }
    return new TextBody(v);
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
  }

  // --- status ---
  status(code, text) {
    this.statusCode = code;
    this.statusText = text ?? STATUS_TEXT[code] ?? 'Unknown';
    return this;
  }

  // --- header ---
  // .set(k, v) 覆盖 / .append(k, v) 累加（Cookie 用）
  set(k, v) { this.headers.set(k, String(v)); return this; }
  append(k, v) {
    const cur = this.headers.get(k);
    this.headers.set(k, cur ? `${cur}\r\n${k}: ${v}` : String(v));
    return this;
  }
  get(k) { return this.headers.get(k) ?? null; }
  del(k) { this.headers.delete(k); return this; }

  type(mime) { return this.set('Content-Type', mime); }

  // --- body（终结调用, 隐含 finish）---
  body(v) {
    this.bodyObj = typeof v === 'string' ? new TextBody(this.subst(v)) : toBody(v);
    return this.finish();
  }

  json(obj) {
    this.type('application/json; charset=utf-8');
    return this.body(JSON.stringify(obj ?? null));
  }
  html(t) { this.type('text/html; charset=utf-8'); return this.body(t); }
  text(t) { this.type('text/plain; charset=utf-8'); return this.body(t); }
  xml(t) { this.type('application/xml; charset=utf-8'); return this.body(t); }

  // --- redirect ---
  redirect(loc, code = 302) {
    this.status(code).set('Location', loc);
    return this.finish();
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
  // rsp.vars({ user, list })  之后 rsp.body('<h1>{{user}}</h1>') 自动替换
  vars(obj) { Object.assign(this.ctx, obj); return this; }
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
        const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'binary');
        if (!b.length) break;
        writeChunk(b);
      }
    } else {
      this.bodyObj.eachChunk(writeChunk);
    }
    writeChunkEnd();
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

    const size = this.bodyObj.size;
    writeHeaders(this, size ?? 0);
    if (size) this.bodyObj.eachChunk(write);
    return this;
  }
}

// ============================================================
// HTTP 字节输出
// ============================================================
const writeHeaders = (rsp, contentLength) => {
  if (contentLength !== null) rsp.set('Content-Length', String(contentLength));
  let head = `HTTP/1.0 ${rsp.statusCode} ${rsp.statusText}\r\n`;
  for (const [k, v] of rsp.headers) head += `${k}: ${v}\r\n`;
  head += '\r\n';
  write(head);
};

const writeChunk = (b) => {
  write(`${b.length.toString(16)}\r\n`);
  write(b);
  write('\r\n');
};

const writeChunkEnd = () => write('0\r\n\r\n');

const writeResp = (code, status, header, content) => {
  const body = content == null ? '' : String(content);
  const rsp = new Rsp();
  rsp.status(code, status);
  for (const [k, v] of Object.entries(header)) rsp.set(k, v);
  writeHeaders(rsp, Buffer.byteLength(body, 'binary'));
  write(body);
};

// ============================================================
// 路由 —— pattern 一律归一化成 RegExp
//
//   Q.get('/info', h)            string  → /^\\/info$/
//   Q.get(/^\/u\/(?<id>\d+)$/, h)  RegExp → 外面包一层锚点
//   Q.get(/u\/(?<id>\d+)/, h)     不写 ^$ 也行（外层统一加）
//   Q.get(h)                       无 pattern = 兜底
//   Q.get((map) => bool, h)        predicate 兜底
//
// 没有 <name> 占位符 —— 命名捕获本来就是 RegExp 的功能。
// ============================================================

// JS 没有 \A \z（那是 ruby 锚点），用 ^ $（非 multiline 时等价）
const anchored = (re) => new RegExp(`^(?:${re.source})$`, re.flags.replace(/[gy]/g, ''));

const ALWAYS = () => true;
const NOT_ROOT = (path) => path !== '/';

// pattern → matcher。**只在 route() 注册时调用一次**，不是每请求。
const toMatcher = (pattern) => {
  if (pattern == null) return ALWAYS;                      // 兜底
  if (pattern instanceof RegExp) {
    const re = anchored(pattern);                          // 编译一次
    return (path) => {
      const m = re.exec(path);
      if (m?.groups) Object.assign(MATCH, m.groups);
      return Boolean(m);
    };
  }
  if (typeof pattern === 'function') return pattern;        // predicate(map, full)
  const p = String(pattern);
  if (!p.startsWith('/')) {
    throw new Error(`Q.route pattern 必须以 '/' 开头, got: ${JSON.stringify(pattern)}`);
  }
  if (p === '/*') return NOT_ROOT;
  const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return (path) => re.test(path);
};

const describe = (pattern) => {
  if (pattern == null) return 'null';
  if (pattern instanceof RegExp) return String(pattern);
  if (typeof pattern === 'function') return '[Function]';
  return JSON.stringify(pattern);
};

const matchPattern = (matcher, pattern) => {
  for (const k of Object.keys(MATCH)) delete MATCH[k];
  const ok = matcher(MAP_PATH);
  log(`Q.match ${describe(pattern).padEnd(34)} [${ok ? 'hit ' : 'miss'}]`
    + ` map_path=${JSON.stringify(MAP_PATH)}`
    + (Object.keys(MATCH).length ? `  captured=${JSON.stringify(MATCH)}` : ''));
  return ok;
};

// ============================================================
// Q
// ============================================================
const STATE = { responded: false };
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
const finalize = () => {
  if (closed) return;
  closed = true;
  for (const cb of ONCLOSE) {
    try {
      fs.writeSync(2, ` >>> onclose -> ${cb()}\n`);
    } catch (e) {
      fs.writeSync(2, ` >>> onclose error: ${e.message}\n`);
    }
  }
  fs.writeSync(2, ` ******************** [${process.pid}]> END   cgi ${scriptName()} ******************** \n`);
};

const shutdown = (code) => {
  finalize();
  process.exit(code);
};

// 跑 handler —— 同步 / async 都吃, 异常 → 500
const exec = async (handler) => {
  const rsp = new Rsp();
  try {
    await handler(new Req(), rsp);
  } catch (e) {
    log(`${e.constructor.name}: ${e.message}`);
    log(String(e.stack ?? '').split('\n').slice(1, 6).map((l) => `  ${l}`));
    if (!rsp.sent) rsp.status(500).text(`${e.constructor.name}: ${e.message}`);
  }
  if (!rsp.sent) rsp.finish();
};

// 立即匹配 + 执行。命中 → on_close → exit（后续 route 不再跑）
const route = (pattern, methods, handler) => {
  // 正则在这里编译一次并被 matcher 闭包捕获 —— 匹配时不再 new RegExp
  const matcher = toMatcher(pattern);
  const ms = methods == null ? null
    : [].concat(methods).map((m) => String(m).toUpperCase());

  let hit;
  if (ms?.includes(WEBSOCKET)) {
    // WS 路由只看 BODY_METHOD, HTTP 请求直接跳过
    hit = BODY_METHOD === WEBSOCKET && matchPattern(matcher, pattern);
  } else {
    hit = (!ms || ms.length === 0 || ms.includes(REQ_METHOD))
      && matchPattern(matcher, pattern);
  }
  if (!hit) return Q;

  if (SCRIPT_DIR) { try { process.chdir(SCRIPT_DIR); } catch { /* dir gone */ } }
  // exec 内部已兜住 handler 异常；这里再兜一层 —— 万一 exec 本身炸了
  // （new Req() 失败等），也要 shutdown，否则进程挂到 spider 超时。
  exec(handler).then(() => shutdown(0), (e) => {
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
  //   Q.read()      读到 EOF（body 无 content-length 时的兜底）
  //   Q.read(n)     读满 n 字节（EOF 提前断则返回短的）
  //   Q.recv(n)     读一块，最多 n 字节 —— 长连接 onData 用这个
  read: (n) => (n === undefined ? readAll() : readExact(n)).toString('binary'),
  recv: (n) => readSome().subarray(0, n ?? BUFFER_SIZE).toString('binary'),
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
process.on('exit', () => {
  // 所有 route 都没匹配 → 兜底 404（WS 靠 STDIN EOF 关闭, 不写）
  if (!STATE.responded && BODY_METHOD !== WEBSOCKET) {
    writeResp(404, STATUS_TEXT[404], {},
      `unhandled request: ${REQ_PATH} with ${REQ_METHOD}\n`);
  }
  finalize();          // 幂等 —— 命中路由时 shutdown() 已经调过了
});

fs.writeSync(2, ` ******************** [${process.pid}]> BEGIN cgi ${scriptName()} ******************** \n`);