#!/usr/bin/env python3
r"""Spider CGI framework — Python 实现.

与 `ruby/_base_.rb` 行为对齐的 Python 版框架。spider 每请求 fork 一个进程,
解释器由脚本 shebang (`#!/usr/bin/env python3`) 决定, 因此本文件既可被业务
脚本 `import`, 也可独立 exec。

    from _base_ import Q, Req, Rsp, Body

    Q.get('/') do |req, rsp|          # do 语法糖 → 实际用 @route 装饰器
    ...

Python 没有 block 语法, 路由注册用装饰器 (Q.get / Q.route) —— 见文件末尾
"Pythonic 用法" 一节。对外行为(匹配规则、响应字节、模板语义)与 Ruby 版一致。

---------------------------------------------------------------------------
ENV 契约 (spider 注入, 子进程只读):

    Cgi_Root            cgi 脚本根目录绝对路径
    Req_Method          GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS
    Req_Path            不含 query 的 URL path
    Req_Params          原始 query 字符串 (未解码)
    Req_Version         HTTP/1.0 / HTTP/1.1
    Req_Body_Method     HTTP / WEBSOCKET
    Req_Argv_N          第 N 个 restful 路径段, 从 1 开始
    Req_Argv_Count      段个数
    Req_Argv_Params     段们 / 拼接
    Req_Script_Path     脚本绝对路径
    Req_Script_Name     /<相对 cgi 根的路径>
    Req_Script_Basename 文件名
    Req_Script_Dir      脚本所在目录
    Req_Peer_Ip / Req_Peer_Port / Req_Peer_Addr
    Req_Buffer_Size     stdin/stdout buffer hint (字节)
    content-type / content-length / ...   原始 HTTP header (小写 key)

MAP_PATH 路由基准
    MAP_PATH = "/" + Req_Argv_Params, 即 URL 里「脚本自身位置之后」的剩余段。
    spider 逐段剥 URL, 剥到存在的文件为止, 剩下的段成为 argv。

        /root/search?q=x      → 脚本 root/search        → MAP_PATH = /
        /root/posts/read/s1   → 脚本 root/posts/read    → MAP_PATH = /s1
        /test/demo/u/42       → 脚本 test/index         → MAP_PATH = /demo/u/42

pattern 写法
    '/'                    精确匹配 restful 为空
    '/info'                精确路径
    '/*'                   通配所有非空 restful
    '/users/<id>'          命名捕获 → (?P<id>[^/]+)
    re.Pattern / re.compile r'/users/(?P<id>\d+)'   正则, / 必须显式写
    None                   兜底 (总是匹配)

    所有 pattern 统一用 \\A...\\Z 包裹, 写不写 ^/$ 都行。
    String pattern 不以 / 开头 → ValueError。
    纯字符串 pattern 含正则元字符 [?*+()|^\\[\\]\\\\.] 或 <name> 占位符时, 也按正则解析。
    捕获结果写入 Q.MATCH (每次匹配前清空), 用 req.named('id') 读取。

---------------------------------------------------------------------------
CWD 约定 (与 Ruby 版一致)

    顶层执行时      CWD = cgi 根          (spider 用 .current_dir(cgi_root) 起进程)
    进入 route block CWD = Req_Script_Dir (Q.route 执行前 chdir 到脚本目录)

    所以顶层不要用裸相对路径读文件, 用 __file__ / Cgi_Root 推导。

body 单次可读
    body / body_json / body_text 全部走 Q.read(length) → stdin.read(length)。
    stdin 是被读干的管道: 第一个调用拿到字节, 之后一律返回 None。
    要么先调 body_json, 要么 body 一次再自己 json.loads。

body 抽象
    Body.text / Body.file / Body.stream —— size 已知发 Content-Length,
    未知发 Transfer-Encoding: chunked。
"""

from __future__ import annotations

import atexit
import io
import json
import os
import re
import sys
import threading
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping, Pattern, Sequence

__all__ = [
    'Q', 'QEnv', 'Req', 'Rsp', 'Body', 'TextBody', 'FileBody', 'StreamBody',
    'WEBSOCKET', 'log', 'capture_stdout', 'script_name', 'script_dir',
    'script_path', 'script_basename', 'script_cwd',
]

WEBSOCKET = 'WEBSOCKET'

# 哨兵: 区分 "不传参"(getter) 与 "显式传 nil"(setter), 语义同 Ruby 的 RSP_READ
_READ = object()


# ═══════════════════════════════════════════════════════════════════════════
# QEnv — ENV 工具
# ═══════════════════════════════════════════════════════════════════════════
class QEnv:
    """ENV 快照. 一次性冻结, 之后 os.environ 变化不影响已解析的常量."""

    SNAPSHOT: Mapping[str, str] = dict(os.environ)

    @classmethod
    def fetch(cls, key: str, default: Any = None) -> Any:
        """空串与 None 一律当 missing —— 与 Ruby 版 QEnv.fetch 语义一致."""
        val = cls.SNAPSHOT.get(key)
        return default if not val else val

    @classmethod
    def fetch_i(cls, key: str, default: int = 0) -> int:
        val = cls.SNAPSHOT.get(key)
        if not val:
            return default
        try:
            return int(val)
        except ValueError:
            return default

    @classmethod
    def decode(cls, s: Any) -> str:
        """form 风格解码 (+ → 空格). 等价 Ruby 的 CGI.unescape."""
        return urllib.parse.unquote_plus(str(s))


# ═══════════════════════════════════════════════════════════════════════════
# 日志 (走 stderr; stdout 是 HTTP 响应通道, 不能碰)
# ═══════════════════════════════════════════════════════════════════════════
def log(*info: Any) -> None:
    frame = sys._getframe(3) if len(sys._getframe(0).f_back.f_back.f_code.co_names) else None
    site = 'unknown'
    try:
        site = f'{os.path.basename(sys._getframe(3).f_code.co_filename)}:{sys._getframe(3).f_lineno}'
    except (ValueError, AttributeError):
        pass
    for v in info:
        sys.stderr.write(f'>>[{os.getpid()}]> LOG <{site}> {v}\n')
    sys.stderr.flush()


# ═══════════════════════════════════════════════════════════════════════════
# Body — 响应 body 抽象
#
#   size        → 已知字节数 (int) 或 None (未知 → 走 chunked)
#   each_chunk  → 逐块产出 bytes (调用方负责循环到底)
#
# 命名避开 String/File/Stream —— 这些名字在 Python 里是内置类型, 遮蔽后
# 嵌套引用会出错, 与 Ruby 版同样的考虑。
# ═══════════════════════════════════════════════════════════════════════════
class Body:
    """响应 body 基类.

    注意 chunk_size 一律用 None 哨兵 + 调用时解析: Q.BUFFER_SIZE 在本模块
    下半部分才赋值, 不能当类定义期的默认参数。
    """

    def size(self) -> int | None:
        raise NotImplementedError

    def each_chunk(self, chunk_size: int | None = None) -> Iterator[bytes]:
        raise NotImplementedError

    def __bytes__(self) -> bytes:
        """只用于 TextBody / FileBody 这类 size 已知的 body."""
        return b''.join(self.each_chunk())

    def __str__(self) -> str:
        return self.to_text()

    def to_text(self) -> str:
        return bytes(self).decode('utf-8', errors='replace')

    # ── 工厂: 按值的类型自动包装 ────────────────────────────────────────────
    @staticmethod
    def wrap(v: Any = None, block: Callable[[Callable[[bytes], None], int], None] | None = None
             ) -> 'Body':
        """v 的类型 → 对应 Body 子类.

            wrap('hello')              → TextBody
            wrap('/path/to/file')      → FileBody (自动探测路径是否存在)
            wrap(Path('/path'))        → FileBody
            wrap(IO / StringIO)        → StreamBody (按 BUFFER_SIZE 读)
            wrap(proc / lambda)        → StreamBody
            wrap(block=fn)             → StreamBody
            wrap(Body 实例)            → 原样返回
            wrap(None)                 → TextBody('')
        """
        if isinstance(v, Body):
            return v
        if isinstance(v, str):
            return FileBody(v) if os.path.isfile(v) else TextBody(v)
        if isinstance(v, bytes):
            return TextBody(v.decode('utf-8', errors='surrogateescape'))
        if isinstance(v, Path):
            return FileBody(str(v))
        if callable(v):
            return StreamBody(v)
        if hasattr(v, 'read') and callable(v.read):
            # 任何「可读字节流」都当 StreamBody: size 未知 → chunked。
            # 结束后**不**自动关闭 (调用方自己管)。
            def _pump(emit, _chunk_size, _src=v):
                while True:
                    chunk = _src.read(Q.BUFFER_SIZE)
                    if not chunk:
                        break
                    emit(chunk if isinstance(chunk, bytes) else chunk.encode('utf-8'))
            return StreamBody(_pump)
        if v is None and block is not None:
            return StreamBody(block)
        if v is None:
            return TextBody('')
        log(f'body wrap unimplemented {v!r} | {block!r}')
        return TextBody('')


class TextBody(Body):
    """内存字符串 body."""

    def __init__(self, s: Any) -> None:
        self._s = s if isinstance(s, str) else str(s)

    def size(self) -> int:
        return len(self._s.encode('utf-8', errors='surrogateescape'))

    def each_chunk(self, chunk_size: int | None = None) -> Iterator[bytes]:
        yield self._s.encode('utf-8', errors='surrogateescape')

    def to_text(self) -> str:
        return self._s


class FileBody(Body):
    """静态文件 body. each_chunk 按 chunk_size 分块, 不一次性吃光内存."""

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._size = os.path.getsize(self.path)

    def size(self) -> int:
        return self._size

    def each_chunk(self, chunk_size: int | None = None) -> Iterator[bytes]:
        chunk_size = Q.BUFFER_SIZE if not chunk_size else chunk_size
        with open(self.path, 'rb') as f:
            while True:
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                yield chunk


class StreamBody(Body):
    """块生成器 body. size 恒 None → 走 chunked."""

    def __init__(self, cbk: Callable[[Callable[[bytes], None], int], None]) -> None:
        self._cbk = cbk

    def size(self) -> int | None:
        return None

    def each_chunk(self, chunk_size: int | None = None) -> Iterator[bytes]:
        chunk_size = Q.BUFFER_SIZE if not chunk_size else chunk_size
        out: list[bytes] = []
        self._cbk(out.append, chunk_size)
        yield from out


# ═══════════════════════════════════════════════════════════════════════════
# I/O — stdout 是 HTTP 响应通道, 任何日志都不能写进来
# ═══════════════════════════════════════════════════════════════════════════
def read(length: int | None = None) -> bytes | None:
    """读 stdin. 返回 None 表示 EOF (对齐 Ruby STDIN.read 的 nil)."""
    if length is None or length <= 0:
        return sys.stdin.buffer.read()
    data = sys.stdin.buffer.read(length)
    return data if data else None


def recv(max_size: int) -> bytes:
    return sys.stdin.buffer.read(max_size)


def write(content: bytes | str, flush: bool = True) -> int:
    data = content.encode('utf-8') if isinstance(content, str) else content
    n = sys.stdout.buffer.write(data)
    if flush:
        sys.stdout.buffer.flush()
    return n or 0


def capture_stdout(fn: Callable[[], Any]) -> tuple[str, Any]:
    """跑 fn, 把 print 输出收进字符串. 返回 (输出, fn 的返回值).

    模板 `@<{...}>` 的求值包在这层里 —— 所以模板里用 print 输出;
    只有在没打印任何东西时, 表达式的返回值才会被采用。
    """
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        ret = fn()
        return buf.getvalue(), ret
    finally:
        sys.stdout = old


def write_resp(code: str, status: str, header: Mapping[str, str], content: Any) -> None:
    """直接写一整个 HTTP 响应 (不经 Rsp). 供兜底 / 老脚本兼容."""
    body = b'' if content is None else (
        content.encode('utf-8') if isinstance(content, str) else content)
    merged = {'Connection': 'close', **dict(header)}
    merged['Content-Length'] = str(len(body))
    head = f'HTTP/1.0 {code} {status}\r\n'
    for k, v in merged.items():
        head += f'{k}: {v}\r\n'
    head += '\r\n'
    write(head.encode('utf-8'), flush=False)
    write(body, flush=True)


def write_headers(header: Mapping[str, str], content_length: int | None = None,
                  transfer_encoding: str | None = None,
                  code: str = '200', status: str = 'OK') -> None:
    merged = {'Connection': 'close', **dict(header)}
    if content_length is not None:
        merged['Content-Length'] = str(content_length)
    if transfer_encoding:
        merged['Transfer-Encoding'] = transfer_encoding
        merged.pop('Content-Length', None)
    head = f'HTTP/1.0 {code} {status}\r\n'
    for k, v in merged.items():
        head += f'{k}: {v}\r\n'
    head += '\r\n'
    sys.stdout.buffer.write(head.encode('utf-8'))
    sys.stdout.buffer.flush()


def write_chunk(chunk: bytes | str) -> None:
    data = chunk.encode('utf-8') if isinstance(chunk, str) else chunk
    out = sys.stdout.buffer
    out.write(f'{len(data):x}\r\n'.encode('ascii'))
    out.write(data)
    out.write(b'\r\n')
    out.flush()


def write_chunk_end() -> None:
    sys.stdout.buffer.write(b'0\r\n\r\n')
    sys.stdout.buffer.flush()


# ═══════════════════════════════════════════════════════════════════════════
# Req — 请求对象 (一次性)
# ═══════════════════════════════════════════════════════════════════════════
class Req:
    """一次请求的只读视图. 每个 route block 拿到一个新实例."""

    def __init__(self) -> None:
        self.method = Q.REQ_METHOD
        # restful 路径部分 (不含脚本自身位置)
        self.path = '/' + Q.ARGV_PARAMS if Q.ARGV_PARAMS else '/'
        self.query = Q.REQ_PARAMS
        self.body_type = QEnv.fetch('content-type', '')
        self.body_length = QEnv.fetch_i('content-length', 0)
        self._params: dict[str, list[str]] | None = None
        self._cookies: dict[str, str] | None = None

    # ── restful argv ───────────────────────────────────────────────────────
    def argv(self, idx: int, default: Any = None) -> Any:
        if isinstance(idx, int) and 0 <= idx < len(Q.ARGV):
            return Q.ARGV[idx]
        return default

    @property
    def argv_count(self) -> int:
        return Q.ARGV_COUNT

    # ── 命名捕获组 ─────────────────────────────────────────────────────────
    def named(self, name: str, default: Any = None) -> Any:
        return Q.MATCH.get(name, default)

    # ── query 参数 ─────────────────────────────────────────────────────────
    @property
    def params(self) -> dict[str, list[str]]:
        if self._params is None:
            self._params = _parse_query(self.query)
        return self._params

    def param(self, key: str, default: Any = None) -> Any:
        v = self.params.get(str(key))
        # 每个 key 的值都是 list; 空 list 当 missing (对齐 Ruby 版)
        if not v:
            return default
        return v[0]

    # ── HTTP headers ───────────────────────────────────────────────────────
    def header(self, name: str, default: Any = None) -> Any:
        return QEnv.SNAPSHOT.get(name.lower(), default)

    # ── cookies ────────────────────────────────────────────────────────────
    @property
    def cookies(self) -> dict[str, str]:
        if self._cookies is None:
            self._cookies = _parse_cookies(self.header('cookie', ''))
        return self._cookies

    def cookie(self, name: str, default: Any = None) -> Any:
        v = self.cookies.get(str(name))
        return default if v is None else v

    # ── body (单次可读, 见模块 docstring) ──────────────────────────────────
    def body(self, length: int | None = None) -> bytes | None:
        if self.body_length == 0:
            return None
        return read(self.body_length if length is None else length)

    def body_text(self) -> str | None:
        """body 的语义化别名 (非 JSON / form 场景)."""
        raw = self.body()
        return None if raw is None else raw.decode('utf-8', errors='replace')

    def body_json(self) -> Any:
        """解析 body 为 JSON. 空 / 坏体返回 None, 不抛异常."""
        raw = self.body()
        if raw is None:
            return None
        text = raw.decode('utf-8', errors='replace')
        if not text:
            return None
        try:
            return json.loads(text)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def body_form_data(self, block: Callable[['FormItem'], None] | None = None):
        """multipart/form-data 解析. 需先 `from _ext_form_ import Form`."""
        if 'form-data' not in self.body_type:
            return None
        boundary = self.body_type.split('boundary=', 1)[-1]
        return Q.Form.parse(boundary, block)

    # ── 流式回调 ───────────────────────────────────────────────────────────
    def on_data(self, cbk: Callable[[bytes], Any]) -> None:
        """循环读直到 EOF; cbk 返回值非 None 则写回 stdout."""
        while True:
            try:
                val = recv(Q.BUFFER_SIZE)
            except (EOFError, OSError):
                log('connection EOF')
                break
            ret = cbk(val)
            if ret is not None:
                write(ret)

    def on_ws_data(self, cbk: Callable[[bytes], Any] | None) -> None:
        """WebSocket 帧循环.

        spider 给每帧加 8 字节头 [len u32 BE][remainder u32 BE];
        remainder==0 表示一个完整帧结束, 此时回调并清空累积缓冲。
        """
        value = b''
        while True:
            head = read(8)
            if head is None or len(head) < 8:
                break
            length = int.from_bytes(head[0:4], 'big')
            remainder = int.from_bytes(head[4:8], 'big')
            body = read(length)
            if body is None:
                break
            value += body
            if remainder == 0:
                ret = cbk(value) if cbk else None
                value = b''
                if ret is not None:
                    write(ret)
        return None

    # ── 方法糖: req.param_q / req.header_host / req.named_id ──────────────
    def __getattr__(self, name: str) -> Any:
        # 只在属性确实不存在时触发 (正常属性在 __init__ 里已设好)
        for prefix, getter in (('argv_', None), ('param_', 'param'),
                               ('header_', 'header'), ('named_', 'named'),
                               ('cookie_', 'cookie')):
            if name.startswith(prefix):
                suffix = name[len(prefix):]
                if getter is None:
                    try:
                        idx = int(suffix)
                    except ValueError:
                        break
                    return self.argv(idx)
                return getattr(self, getter)(suffix)
        raise AttributeError(f'{type(self).__name__!r} object has no attribute {name!r}')


def _parse_query(qs: str | None) -> dict[str, list[str]]:
    """解析 query string → {key: [values]}. 空串 / 坏输入返回 {}."""
    if not qs:
        return {}
    out: dict[str, list[str]] = {}
    try:
        for pair in qs.split('&'):
            if not pair:
                continue
            k, _, v = pair.partition('=')
            key = urllib.parse.unquote_plus(k)
            out.setdefault(key, []).append(urllib.parse.unquote_plus(v))
    except Exception:
        return {}
    return out


def _parse_cookies(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    out: dict[str, str] = {}
    for pair in raw.split(';'):
        pair = pair.strip()
        if not pair:
            continue
        k, _, v = pair.partition('=')
        if not k:
            continue
        out[urllib.parse.unquote_plus(k)] = urllib.parse.unquote_plus(v)
    return out


# ═══════════════════════════════════════════════════════════════════════════
# Rsp — 响应构造器 (chainable + 幂等 finish)
#
# getter / setter 用哨兵区分: rsp.code 设值, rsp.code 读值。
# ═══════════════════════════════════════════════════════════════════════════
class Rsp:
    """链式响应构造器. finish() 幂等; 写完抛 _RespSent 由 Q.route 捕获."""

    DEFAULT_HEADERS = {
        'Connection': 'close',
        'Content-Type': 'text/html; charset=utf-8',
    }

    def __init__(self) -> None:
        self._code: Any = 200
        self._status: Any = 'OK'
        self._body: Body = TextBody('')
        self._header: dict[str, str] = dict(self.DEFAULT_HEADERS)
        self.sent = False
        self._chunking = False

    # ── 链式 setter / getter ───────────────────────────────────────────────
    @property
    def code(self) -> Any:
        return self._code

    @code.setter
    def code(self, v: Any) -> None:
        self._code = v

    @property
    def status(self) -> Any:
        return self._status

    @status.setter
    def status(self, v: Any) -> None:
        self._status = v

    @property
    def body(self) -> Body:
        return self._body

    @body.setter
    def body(self, v: Any) -> None:
        self._body = Body.wrap(v)

    @property
    def header(self) -> dict[str, str]:
        return self._header

    def set_body(self, v: Any = None,
                 block: Callable[[Callable[[bytes], None], int], None] | None = None) -> 'Rsp':
        """链式设 body (装饰器语法下属性名被占用, 用这个方法)."""
        self._body = Body.wrap(v, block)
        return self

    def set(self, *args: Any, **kwargs: Any) -> 'Rsp':
        """给模板注入变量: set(k, v) / set({k: v}) / set(k=v).

        值存在实例属性上, render 会自动导入模板上下文。
        用 *args/**kwargs 而非 (key, value) 签名 —— 后者会让 set(v='x')
        把 v 当关键字参数, 而不是 key='v'。
        """
        if len(args) == 1 and isinstance(args[0], Mapping):
            for k, v in args[0].items():
                setattr(self, str(k), v)
        elif len(args) == 2:
            setattr(self, str(args[0]), args[1])
        elif args:
            raise TypeError(f'set() takes 1-2 positional args, got {len(args)}')
        for k, v in kwargs.items():
            setattr(self, str(k), v)
        return self

    # 更明确的名字, 避免和 builtin set 混淆
    set_var = set

    # ── Content-Type 快捷 ──────────────────────────────────────────────────
    def type(self, v: str) -> 'Rsp':
        self._header['Content-Type'] = v
        return self

    def type_json(self) -> 'Rsp':
        return self.type('application/json; charset=utf-8')

    def type_html(self) -> 'Rsp':
        return self.type('text/html; charset=utf-8')

    def type_text(self) -> 'Rsp':
        return self.type('text/plain; charset=utf-8')

    def type_xml(self) -> 'Rsp':
        return self.type('application/xml; charset=utf-8')

    def type_bin(self, mime: str = 'application/octet-stream') -> 'Rsp':
        return self.type(mime)

    # ── 自定义 header ──────────────────────────────────────────────────────
    def header_field(self, name: str, value: str) -> 'Rsp':
        self._header[name] = value
        return self

    def header_remove(self, name: str) -> 'Rsp':
        self._header.pop(name, None)
        return self

    def type_file(self, path: str, mime: str | None = None,
                  download_as: str | None = None) -> 'Rsp':
        """设 Content-Type + Content-Disposition. 文件不可读则转 404."""
        if not os.access(path, os.R_OK):
            self.fail_404().type_html().set_body(f'file not found: {path}')
            return self
        if mime:
            self.type(mime)
        self._header['Content-Disposition'] = (
            f'attachment; filename="{download_as}"' if download_as else 'inline')
        return self

    def cookie_set(self, name: str, value: str, max_age: int | None = None,
                   path: str = '/', httponly: bool = False, secure: bool = False,
                   samesite: str | None = None) -> 'Rsp':
        parts = [f'{name}={value}', f'Path={path}']
        if max_age is not None:
            parts.append(f'Max-Age={max_age}')
        if httponly:
            parts.append('HttpOnly')
        if secure:
            parts.append('Secure')
        if samesite:
            parts.append(f'SameSite={samesite}')
        field = '; '.join(parts)
        existing = self._header.get('Set-Cookie')
        self._header['Set-Cookie'] = (
            f'{existing}\r\nSet-Cookie: {field}' if existing else field)
        return self

    # ── 200 快捷 ───────────────────────────────────────────────────────────
    def ok(self, body_str: Any) -> 'Rsp':
        self._code, self._status = 200, 'OK'
        return self.set_body(body_str)

    def ok_html(self, text: str) -> 'Rsp':
        return self.type_html().ok(text)

    def ok_json(self, obj: Any) -> 'Rsp':
        # separators=(',', ':') —— Ruby 的 Hash#to_json 默认紧凑输出,
        # 不加这个 Python 会写成 '{"a": 1}' (带空格), Content-Length 也就不一样。
        # 与 ruby/_base_.rb 的 Rsp#ok_json 字节级一致。
        self.type_json()
        payload = '' if obj is None else json.dumps(obj, ensure_ascii=False,
                                                     separators=(',', ':'))
        return self.ok(payload)

    def ok_text(self, text: str) -> 'Rsp':
        return self.type_text().ok(text)

    def ok_xml(self, text: str) -> 'Rsp':
        return self.type_xml().ok(text)

    # ── 错误状态 ───────────────────────────────────────────────────────────
    def fail_400(self) -> 'Rsp':
        return self._fail(400, 'Bad Request')

    def fail_403(self) -> 'Rsp':
        return self._fail(403, 'Forbidden')

    def fail_404(self) -> 'Rsp':
        return self._fail(404, 'Not Found')

    def fail_405(self) -> 'Rsp':
        return self._fail(405, 'Method Not Allowed')

    def fail_500(self) -> 'Rsp':
        return self._fail(500, 'Internal Server Error')

    def fail_501(self) -> 'Rsp':
        return self._fail(501, 'Not Implemented')

    def _fail(self, code: int, status: str) -> 'Rsp':
        self._code, self._status = code, status
        return self

    # ── 重定向 / 文件 / 流式 ───────────────────────────────────────────────
    def redirect_to(self, loc: str, code: int = 302, body: str = '') -> 'Rsp':
        self._code = code
        self._status = 'Moved Permanently' if code == 301 else 'Found'
        self.type_html()
        self._header['Location'] = loc
        self._body = TextBody(body)
        return self

    def send_file(self, path: str, download_as: str | None = None,
                  mime: str | None = None) -> 'Rsp':
        self.type_file(path, mime=mime, download_as=download_as)
        # type_file 文件不存在时已置 404 + 错误 body, 不要覆盖
        if self._code == 200:
            self.set_body(path)
        return self

    def stream(self, block: Callable[[int], Any] | None = None,
               chunk_size: int | None = None) -> 'Rsp':
        """切 chunked 并把 body 逐块发出.

            rsp.stream()                      body 是 StreamBody → 逐块 yield
            rsp.stream(lambda i: f'#{i}' if i < 5 else None)
                                              生成器风格, 返回 None 停止
        """
        if self._chunking:
            return self
        size = self._body.size() if chunk_size is None else chunk_size
        self._header.pop('Content-Length', None)
        self._header['Transfer-Encoding'] = 'chunked'
        write_headers(self._header, transfer_encoding='chunked',
                      code=str(self._code), status=str(self._status))
        self._chunking = True

        if block is None:
            for chunk in self._body.each_chunk(size):
                write_chunk(chunk)
            write_chunk_end()
            return self

        i = 0
        while True:
            data = block(i)
            if data is None or data is False or len(data) == 0:
                break
            write_chunk(data)
            i += 1
        write_chunk_end()
        return self

    # ── 模板渲染 ───────────────────────────────────────────────────────────
    def render(self, **vars_hash: Any) -> 'Rsp':
        """求值 body 里的每个 `@<{...}>` 洞.

        - 上下文 = 本实例属性 + render 的关键字参数 (后者覆盖前者)
        - 求值包在 capture_stdout 里: 模板内用 print 输出;
          没打印任何东西时才采用表达式的返回值
        - 出错渲染成 `[ERROR: Class: msg]`, 不向外抛
        - 终止符是字面序列 `}>` —— 洞里可以用 {} 块 / dict 字面量;
          唯一禁忌是洞内出现 `}>` 这个序列(会被误认成洞结束)
        - 表达式走 eval; 语句 (raise / 赋值 / 分号分隔) Python 的 eval 不收,
          自动回退到 exec —— Ruby 的 eval 是收的, 这样两边行为一致
        """
        ctx = self._template_ctx()
        ctx.update(vars_hash)
        out = []
        last = 0
        for m in _TEMPLATE_RE.finditer(self._body.to_text()):
            out.append(self._body.to_text()[last:m.start()])
            last = m.end()
            out.append(self._eval_hole(m.group('code'), ctx))
        out.append(self._body.to_text()[last:])
        self._body = TextBody(''.join(out))
        return self

    def _template_ctx(self) -> dict[str, Any]:
        """把本实例的属性导入模板上下文 (set() 注入的值也在内)."""
        ctx: dict[str, Any] = {}
        for k, v in vars(self).items():
            if not k.startswith('_'):
                ctx[k] = v
        return ctx

    @staticmethod
    def _eval_hole(code: str, ctx: dict[str, Any]) -> str:
        """求值单个洞. 语法错误也要兜住 (不只运行时异常).

        两处 Python 特有的处理:
          * `compile(src, mode='eval')` 拒绝前导空格 / 空串 —— 模板洞两侧天然
            带空白 (`@<{ x }>` 的 code 是 " x "), 所以先 strip; 全空则直接返回。
          * 编译与执行都要包在 capture_stdout 里, 否则 print 的输出会漏进 stdout。
        """
        src = code.strip()
        if not src:
            return ''

        def _run() -> Any:
            return _eval_render(src, ctx)

        try:
            captured, ret = capture_stdout(_run)
            if captured:
                return captured
            return '' if ret is None else str(ret)
        except BaseException as e:  # noqa: BLE001
            return f'[ERROR: {type(e).__name__}: {e}]'

    # ── 发送 ───────────────────────────────────────────────────────────────
    def finish(self) -> 'Rsp':
        """一次性发送 (幂等). 写完抛 _RespSent, 由 Q.route 捕获后 exit 0."""
        if self.sent:
            return self
        self.sent = True
        Q.STATE['responded'] = True
        if Q.BODY_METHOD == WEBSOCKET:
            # WS 不走 HTTP 响应; 连接由 stdin EOF 驱动关闭
            return self

        if not self._chunking:
            size = self._body.size()
            if size is not None:
                write_headers(self._header, content_length=size,
                              code=str(self._code), status=str(self._status))
                for chunk in self._body.each_chunk():
                    write(chunk, flush=True)
            else:
                write_headers(self._header, content_length=0,
                              code=str(self._code), status=str(self._status))
        raise _RespSent('handled')


def _fail(self: Rsp, code: int, status: str) -> Rsp:
    self._code, self._status = code, status
    return self


Rsp._fail = _fail


# 模板洞: 终止符是字面 `}>`, 非贪婪匹配到第一个 `}>` (不是第一个 `}`)
_TEMPLATE_RE = re.compile(r'@<\{(?P<code>.*?)\}>', re.DOTALL)

def _eval_render(src: str, ctx: dict[str, Any]) -> Any:
    """求值一段模板代码, 返回其值.

    先按表达式编译 (`eval` 模式), 这样 `@<{ 1 + 1 }>` 的返回值能直接用。
    表达式模式不接受语句 —— 而 Ruby 的 `eval` 是接受的 (`raise "x"` 在 Ruby 里
    是表达式)。为了行为对齐, 编译失败时回退到 `exec` 模式: 语句能跑,
    异常照常抛出给上层转成 [ERROR: ...], 只是拿不到返回值。

    注意这不是安全沙箱 —— 内置的 __import__ 照样可用 (实测)。模板内容来自
    自己的 page.html, 不接受外部输入, 所以够用; 真要隔离得靠独立进程 + seccomp。
    """
    try:
        return eval(compile(src, '<q-render>', 'eval'), _RENDER_GLOBALS, ctx)  # noqa: S307
    except SyntaxError:
        exec(compile(src, '<q-render>', 'exec'), _RENDER_GLOBALS, ctx)  # noqa: S102
        return ctx.get('__q_last__')


_RENDER_GLOBALS: dict[str, Any] = {
    '__builtins__': __builtins__,
    # 留个位置让 exec 模式回退时写回值 (当前回退路径不产生返回值)
    '__q_last__': None,
}


# ═══════════════════════════════════════════════════════════════════════════
# 路由控制流
# ═══════════════════════════════════════════════════════════════════════════
class _RespSent(Exception):
    """Rsp.finish 抛出, Q.route 捕获。值恒为 'handled'."""


class _Route:
    """一条注册好的路由."""

    __slots__ = ('pattern', 'methods', 'fn')

    def __init__(self, pattern: Any, methods: Sequence[str] | None, fn: Callable) -> None:
        self.pattern = pattern
        self.methods = tuple(m.upper() for m in methods) if methods else None
        self.fn = fn


# ═══════════════════════════════════════════════════════════════════════════
# Q — 路由 + 常量 + 生命周期
# ═══════════════════════════════════════════════════════════════════════════
class Q:
    """框架入口. 常量在 import 时从 ENV 冻结一次."""

    STATE: dict[str, Any] = {'responded': False}
    ONCLOSE_CBS: list[Callable[[], Any]] = []

    # ── 脚本定位 ───────────────────────────────────────────────────────────
    @staticmethod
    def script_name() -> str | None:
        return QEnv.SNAPSHOT.get('Req_Script_Name')

    @staticmethod
    def script_basename() -> str | None:
        return QEnv.SNAPSHOT.get('Req_Script_Basename')

    @staticmethod
    def script_path() -> str | None:
        return QEnv.SNAPSHOT.get('Req_Script_Path')

    @staticmethod
    def script_dir() -> str | None:
        return QEnv.SNAPSHOT.get('Req_Script_Dir')

    @staticmethod
    def script_cwd() -> str | None:
        """脚本所在目录 —— 注意这是 URL 上的 restful 路径之外的东西.

        与 os.getcwd() 不同: 顶层执行时 os.getcwd() 是 cgi 根。
        """
        return QEnv.SNAPSHOT.get('Req_Script_Dir') or None


# restful 段一次性冻结 (按 Req_Argv_N 顺序)
Q.ARGV = tuple(
    QEnv.decode(v)
    for _, v in sorted(
        ((int(k.rsplit('_', 1)[1]), v) for k, v in QEnv.SNAPSHOT.items()
         if re.fullmatch(r'Req_Argv_\d+', k)),
        key=lambda kv: kv[0])
)

# 最近一次命名捕获组 (每次匹配前清空)
Q.MATCH: dict[str, Any] = {}

Q.CGI_ROOT = QEnv.fetch('Cgi_Root', os.getcwd())
Q.REQ_METHOD = QEnv.fetch('Req_Method', 'GET')
Q.REQ_PATH = QEnv.fetch('Req_Path', '/')
Q.REQ_PARAMS = QEnv.fetch('Req_Params', '')
Q.REQ_VERSION = QEnv.fetch('Req_Version', 'HTTP/1.1')
Q.BODY_METHOD = QEnv.fetch('Req_Body_Method', 'HTTP')
Q.PEER_IP = QEnv.fetch('Req_Peer_Ip', '')
Q.PEER_PORT = QEnv.fetch_i('Req_Peer_Port', 0)
Q.PEER_ADDR = f'{Q.PEER_IP}:{Q.PEER_PORT}'
Q.BUFFER_SIZE = QEnv.fetch_i('Req_Buffer_Size', 131_072)
Q.ARGV_COUNT = QEnv.fetch_i('Req_Argv_Count', 0)
Q.ARGV_PARAMS = QEnv.fetch('Req_Argv_Params', '')
Q.SCRIPT_DIR = QEnv.fetch('Req_Script_Dir', '')
Q.MAP_PATH = '/' + Q.ARGV_PARAMS          # 路由匹配基准
_BUFFER_SIZE = Q.BUFFER_SIZE

# 路由表 + 装饰器入口
Q.ROUTES: list[_Route] = []


def _register(pattern: Any, methods: Sequence[str] | str | None) -> Callable:
    """内部: 生成路由装饰器."""
    if isinstance(methods, str):
        methods = [methods]
    elif methods is not None:
        methods = list(methods)

    def deco(fn: Callable) -> Callable:
        Q.ROUTES.append(_Route(pattern, methods, fn))
        return fn
    return deco


def route(pattern: Any = None, method: Any = None) -> Callable:
    """路由注册装饰器.

        @Q.route('/users/<id>')                       method 默认 = 全部匹配
        @Q.route('/users', method='GET')
        @Q.route('/x', method=['GET', 'POST'])
        @Q.route()                                    兜底 (总是匹配)
        @Q.ws('/echo')                                WebSocket 端点

    `Q.get/post/put/delete/patch/head/options` 是带 method 的简写。
    """
    return _register(pattern, method)


# Q.get('/x') 这种「函数式」写法 —— 传 pattern 直接注册, 拿不到装饰器能力时用
def _functional_getter(method: str) -> Callable:
    """生成绑定单一 method 的路由工厂 (Q.get / Q.post / ...)。"""
    def factory(pattern: Any = None) -> Callable:
        return _register(pattern, [method])
    return factory


def on_close(cb: Callable[[], Any]) -> None:
    """注册进程退出回调 (WS 端点用它释放资源)."""
    Q.ONCLOSE_CBS.append(cb)


def dispatch(rsp: Rsp) -> None:
    """命中路由后的收尾: 跑 on_close 回调, 然后 exit 0.

    用 sys.exit 而非 return —— 语义对齐 Ruby 的 `exit 0`,
    保证后续的 Q.route 注册与 atexit 兜底都不再执行。
    """
    for i, cb in enumerate(Q.ONCLOSE_CBS):
        try:
            sys.stderr.write(f' >>> call onclose cbk ({i}) ->  {cb()}\n')
        except BaseException as e:  # noqa: BLE001
            sys.stderr.write(f' >>> call onclose ({i}) error: {type(e).__name__}: {e}\n')
    sys.stderr.flush()
    sys.exit(0)


def match_pattern(pattern: Any, map_path: str | None = None,
                  req_path: str | None = None) -> bool:
    """判断一条 pattern 是否命中. 捕获写入 Q.MATCH (每次匹配前清空)."""
    map_path = Q.MAP_PATH if map_path is None else map_path
    req_path = Q.REQ_PATH if req_path is None else req_path

    Q.MATCH.clear()
    result: bool
    if pattern is None:
        result = True
    elif isinstance(pattern, str):
        result = _match_string(pattern, map_path, req_path)
    elif isinstance(pattern, re.Pattern):
        result = _match_regexp(pattern, map_path)
    elif callable(pattern):
        result = pattern(map_path, req_path) is True
    else:
        result = False

    _log_match(pattern, map_path, req_path, result)
    return result


_META_RE = re.compile(r'[?*+()|^\[\]\\.]')
_CAPTURE_RE = re.compile(r'<([A-Za-z_]\w*)>')


def _match_string(pattern: str, map_path: str, req_path: str) -> bool:
    """字符串 pattern 匹配.

        pattern == '/*'        → 总匹配
        pattern == map_path    → 精确匹配
        含元字符或 <name>       → 当正则解析 (\\A...\\Z 包裹)
        其余                    → 与完整 URL 路径 (req_path) 比
    """
    if not pattern.startswith('/'):
        raise ValueError(
            f"Q.route String pattern 必须以 '/' 开头, got: {pattern!r}")

    if pattern == '/*':
        return True
    if pattern == map_path:
        return True

    if _META_RE.search(pattern) or _CAPTURE_RE.search(pattern):
        # <name> → (?P<name>[^/]+); 其余部分当正则 (注意 .* 之类原样保留)
        converted = _CAPTURE_RE.sub(lambda m: f'(?P<{m.group(1)}>[^/]+)', pattern)
        try:
            anchored = re.compile(r'\A' + converted + r'\Z')
        except re.error:
            return False
        mm = anchored.match(map_path)
        if not mm:
            return False
        Q.MATCH.update(mm.groupdict())
        return True

    # 纯字面量: 跟完整 URL 路径比 (不是 map_path)
    return pattern == req_path


def _match_regexp(pattern: Pattern, map_path: str) -> bool:
    """正则 pattern 匹配. 统一用 \\A...\\Z 包裹, 所以 ^/$ 写不写都行."""
    anchored = re.compile(r'\A(?:' + pattern.pattern + r')\Z', pattern.flags)
    m = anchored.match(map_path)
    if not m:
        return False
    Q.MATCH.update(m.groupdict())
    return True


def _log_match(pattern: Any, map_path: str, req_path: str, result: bool) -> None:
    """把每条 pattern 的匹配结果打到 stderr, 方便调试路由."""
    matched = 'true ' if result else 'false'
    msg = (f'Q.match {pattern!r:<36} [match={matched}] '
           f'map_path={map_path!r} req={req_path!r}')
    if Q.MATCH:
        msg += f'  captured={Q.MATCH!r}'
    sys.stderr.write(f'>>[{os.getpid()}]> LOG <match> {msg}\n')
    sys.stderr.flush()


def run() -> None:
    """按注册顺序匹配当前请求, 命中就执行并 exit 0. 全不命中则落到 atexit 兜底."""
    try:
        for rt in Q.ROUTES:
            if rt.methods and WEBSOCKET in rt.methods:
                # WS 路由只看 Req_Body_Method —— 普通 HTTP 请求直接跳过
                if Q.BODY_METHOD == WEBSOCKET and match_pattern(rt.pattern):
                    _exec_route_block(rt)
                    raise _RespSent('handled')
                continue
            if (not rt.methods or rt.methods == () or Q.REQ_METHOD in rt.methods) \
                    and match_pattern(rt.pattern):
                _exec_route_block(rt)
                raise _RespSent('handled')
    except _RespSent:
        dispatch(None)


def _exec_route_block(rt: _Route) -> None:
    """跑用户 handler. 异常 → 500 body. 结束后若还没 finish 则补 finish."""
    rsp = Rsp()
    prev_cwd = os.getcwd()
    try:
        os.chdir(Q.SCRIPT_DIR or prev_cwd)   # 进入 route block 才 chdir 到脚本目录
    except OSError:
        pass
    try:
        try:
            rt.fn(Req(), rsp)
        except _RespSent:
            raise
        except BaseException as e:  # noqa: BLE001 — handler 异常转 500
            log(f'{type(e).__name__}: {e}')
            tb = sys.exc_info()[2]
            for line in (tb or []) and _tb_lines(tb)[:5]:
                log(f'  {line}')
            rsp._code = 500
            rsp._status = 'Internal Server Error'
            rsp.set_body(f'{type(e).__name__}: {e}')
            rsp.finish()
        if not rsp.sent:
            rsp.finish()
    finally:
        try:
            os.chdir(prev_cwd)
        except OSError:
            pass


def _tb_lines(tb: Any) -> list[str]:
    import traceback
    return traceback.format_tb(tb)


class _ExtFormShim:
    """`Q.Form` 的转发占位。

    Req.body_form_data 调 Q.Form.parse。未 `import _ext_form_` 时下面没有
    parse 属性, 调用会抛 AttributeError —— 与 Ruby 版未 require _ext_form_
    时抛 NameError 同类。_ext_form_.py 导入后把真 Form 类绑上来即可。
    """

    @staticmethod
    def parse(*args, **kwargs):
        raise AttributeError(
            "Q.Form.parse 不可用: 需要先 `import _ext_form_`")


def bind_form(form_cls) -> None:
    """由 _ext_form_.py 在导入时调用, 把 Form 类挂到 Q 上."""
    Q.Form = form_cls


# ── 进程生命周期 ───────────────────────────────────────────────────────────
sys.stderr.write(
    f' ******************** [{os.getpid()}]> BEGIN cgi '
    f'{QEnv.SNAPSHOT.get("Req_Script_Name")} ******************** \n')
sys.stderr.flush()


@atexit.register
def _end() -> None:
    """兜底: 所有路由都没命中 → 404 (对齐 Ruby 的 END 块).

    命中路径已经 exit 0, 不会走到这里。WS 模式没有 404 协议,
    spider 通过 stdin EOF 触发关闭即可。
    """
    if not Q.STATE.get('responded') and Q.BODY_METHOD != WEBSOCKET:
        write_resp(404, 'Not Found', {},
                   f'unhandled request: {Q.REQ_PATH} with {Q.REQ_METHOD}\n')

    for i, cb in enumerate(Q.ONCLOSE_CBS):
        try:
            sys.stderr.write(f' >>> call onclose cbk ({i}) ->  {cb()}\n')
        except BaseException as e:  # noqa: BLE001
            sys.stderr.write(f' >>> call onclose ({i}) error: {type(e).__name__}: {e}\n')
    sys.stderr.write(
        f' ******************** [{os.getpid()}]> END   cgi '
        f'{QEnv.SNAPSHOT.get("Req_Script_Name")} ******************** \n')
    sys.stderr.flush()


# ── 把路由 API 挂到 Q 上 ───────────────────────────────────────────────────
#
# 上面这些函数是模块级定义 (Python 里类体内赋值会绑到类命名空间, 但把装饰器
# 工厂直接塞进类体会让它们变成 unbound 方法, 调用时拿不到 self)。这里显式挂载,
# 业务脚本就可以写 Q.route / Q.get / Q.on_close —— 和 Ruby 的 Q.get 一致。
#
#     from _base_ import Q
#
#     @Q.get('/')
#     def index(req, rsp):
#         rsp.type_html().set_body('<h1>hi</h1>').finish()
#
#     Q.run()        # 被 import 时需手动驱动; 直接 exec 本文件会自动跑
Q.route = staticmethod(route)
Q.get = staticmethod(_functional_getter('GET'))
Q.post = staticmethod(_functional_getter('POST'))
Q.put = staticmethod(_functional_getter('PUT'))
Q.delete = staticmethod(_functional_getter('DELETE'))
Q.patch = staticmethod(_functional_getter('PATCH'))
Q.head = staticmethod(_functional_getter('HEAD'))
Q.options = staticmethod(_functional_getter('OPTIONS'))
Q.ws = staticmethod(_functional_getter(WEBSOCKET))
Q.on_close = staticmethod(on_close)
Q.match_pattern = staticmethod(match_pattern)
Q.dispatch = staticmethod(dispatch)
Q.Form = _ExtFormShim          # _ext_form_ 导入后由 bind_form 替换
Q.run = staticmethod(run)