#!/usr/bin/env python3
"""Spider 扩展 — 跨进程消息总线 (UDP 组播).

对应 `ruby/_ext_notify_.rb` 的 SocketNotify 部分。定位相同: 只负责
「把字节从 A 搬到 B」, 不解析 payload —— 永远是原始 bytes, 格式由应用层自己定。

协议与 Ruby 版完全一致 (便于两端互通):

    HEADER 行 + "\\n" + PAYLOAD (ASCII-8BIT 原始字节)
    HEADER 用空格分隔 k=v, 短 key 省字节:
        k=msg|hb  c=<channel>  s=<seq>  l=<body_len>
        n=<name>  h=<host>  p=<pid>   [任意自定义 meta key=v]

    Message:
        kind / name / host / pid / seq / from / channel / data / header

用法:

    m = SocketNotify('alice')

    @m.on(:chat)                    # 订阅 (自己发的也会回调)
    def _(msg): print(msg.data.decode())

    m.emit(:chat, 'hi')             # 发
    m.emit(:chat, {'a': 1}.encode() if not isinstance else json.dumps({'a': 1}).encode())
    m.stop()

坑 (从 Ruby 版继承, 不要回退):
  1. payload 一律当 bytes —— 不要对 str 调 encode 之外的处理, 非法 UTF-8 字节
     必须原样保留 (Python 的 bytes 天然如此; 若用 str 中转会毁数据)。
  2. HEADER 强制 ASCII —— channel / meta 值不能含空格或换行, 否则解析错位。
  3. 单包硬上限 ~65507 字节 (IP 层), 超了静默截断 —— 大数据自己分片。
  4. SIGTERM 上下文里不能 acquire lock, 所以 stop() 必须主线程同步调。
"""

from __future__ import annotations

import errno
import json
import os
import selectors
import socket
import struct
import threading
from dataclasses import dataclass, field
from typing import Any, Callable

__all__ = ['SocketNotify', 'Message', 'Notify']

DEFAULT_GROUP = '239.255.0.1'
DEFAULT_PORT = 5000
DEFAULT_IFACE = '0.0.0.0'
DEFAULT_HB_SEC = 5
HB_TTL = 2
PACKET_LIMIT = 60 * 1024          # UDP 单包上限 65507, 留余量

IP_ADD_MEMBERSHIP = 35
IP_MULTICAST_TTL = 33


@dataclass
class Message:
    """一条收到的消息. data 是原始 bytes, 应用层自己解码."""

    kind: str = 'msg'
    name: str | None = None
    host: str | None = None
    pid: int | None = None
    seq: int = 0
    from_: str | None = None
    channel: str = 'default'
    data: bytes = b''
    header: str = ''

    def json(self) -> Any:
        """便捷解码 (data 必须是 UTF-8 JSON)。"""
        return json.loads(self.data.decode('utf-8'))

    @property
    def text(self) -> str:
        return self.data.decode('utf-8', errors='replace')


class Notify:
    """组播总线的公共部分: 订阅表 + 协议拼解 + 分发."""

    # 完整 key → header 短 key
    KEYMAP = {
        'kind': 'k', 'channel': 'c', 'seq': 's', 'body_len': 'l',
        'name': 'n', 'host': 'h', 'pid': 'p',
    }

    def __init__(self, name: str) -> None:
        self.name = name
        self.running = False
        self._seq = 0
        self._send_lock = threading.Lock()
        self._subs_lock = threading.Lock()
        self._subs: dict[str, list[tuple[Callable[[Message], Any], bool]]] = {}

    # ── 订阅 ────────────────────────────────────────────────────────────────
    def on(self, channel: str | None, fn: Callable[[Message], Any],
          want_echo: bool = True) -> 'Notify':
        """订阅. want_echo=False 表示跳过自己发的消息 (不靠 pid 比对)。"""
        key = self._coerce(channel)
        with self._subs_lock:
            self._subs.setdefault(key, []).append((fn, want_echo))
        return self

    def off(self, channel: str | None = None,
            fn: Callable[[Message], Any] | None = None) -> 'Notify':
        """退订. 不给 fn 就清掉该 channel 全部订阅。"""
        key = self._coerce(channel)
        with self._subs_lock:
            if key not in self._subs:
                return self
            if fn is None:
                self._subs.pop(key, None)
            else:
                self._subs[key] = [(c, e) for c, e in self._subs[key] if c is not fn]
        return self

    # ── 协议 ────────────────────────────────────────────────────────────────
    @staticmethod
    def _coerce(ch: str | None) -> str:
        return 'default' if ch is None else str(ch)

    def _build_packet(self, kind: str = 'msg', channel: str | None = None,
                      body: bytes = b'', meta: dict[str, Any] | None = None) -> bytes:
        """拼一个完整包: HEADER 行 + \\n + payload."""
        with self._send_lock:
            self._seq += 1
        k = self.KEYMAP
        parts = [f'{k["kind"]}={kind}', f'{k["seq"]}={self._seq}']
        parts += self._header_fields()
        if channel is not None:
            parts.append(f'{k["channel"]}={channel}')
        if body:
            parts.append(f'{k["body_len"]}={len(body)}')
        for mk, mv in (meta or {}).items():
            parts.append(f'{mk}={mv}')
        head = ' '.join(parts).encode('ascii', errors='replace')
        return head + b'\n' + body

    @staticmethod
    def _split_packet(data: bytes) -> tuple[str, bytes]:
        """拆 HEADER / PAYLOAD; 按 l= 截断多余字节。"""
        i = data.find(b'\n')
        if i < 0:
            return data.decode('ascii', errors='replace'), b''
        header = data[:i].decode('ascii', errors='replace')
        body = data[i + 1:]
        body_len = Notify._header_kv(header, 'body_len')
        if body_len is not None:
            try:
                n = int(body_len)
                if len(body) > n:
                    body = body[:n]
            except ValueError:
                pass
        return header, body

    @staticmethod
    def _header_kv(header: str, key: str) -> str | None:
        short = Notify.KEYMAP.get(key, key)
        for tok in header.split():
            k, sep, v = tok.partition('=')
            if sep and k == short:
                return v
        return None

    def _header_fields(self) -> list[str]:
        return [f'{self.KEYMAP["name"]}={self.name}',
                f'{self.KEYMAP["host"]}={socket.gethostname()}',
                f'{self.KEYMAP["pid"]}={os.getpid()}']

    def _dispatch(self, msg: Message) -> None:
        """投递给同 channel 的订阅者 (以及 :default)。

        want_echo=False 的订阅跳过自己 pid 的消息 —— 这是 CRDT join
        能否收敛的关键, 也决定了是否需要自己回声。
        """
        with self._subs_lock:
            subs = list(self._subs.get(msg.channel, ())) + list(self._subs.get('default', ()))
        own = msg.pid == os.getpid()
        for cb, want_echo in subs:
            if own and not want_echo:
                continue
            try:
                cb(msg)
            except Exception as e:  # noqa: BLE001 — 一个订阅者炸了不影响别人
                print(f'[{self.name}] notify callback error: {type(e).__name__}: {e}',
                      file=__import__('sys').stderr)

    def _parse_packet(self, data: bytes, from_: str) -> Message | None:
        header, body = self._split_packet(data)
        if not header:
            return None

        def g(key: str) -> str | None:
            return self._header_kv(header, key)

        pid_s = g('pid')
        seq_s = g('seq')
        return Message(
            kind=g('kind') or 'msg',
            name=g('name'),
            host=g('host'),
            pid=int(pid_s) if pid_s and pid_s.isdigit() else None,
            seq=int(seq_s) if seq_s and seq_s.lstrip('-').isdigit() else 0,
            from_=from_,
            channel=g('channel') or 'default',
            data=body,
            header=header,
        )

    # ── 子类接口 ────────────────────────────────────────────────────────────
    def emit(self, channel: str | None, payload: Any = b'',
             **meta: Any) -> 'Notify':
        raise NotImplementedError

    def stop(self) -> 'Notify':
        raise NotImplementedError


class SocketNotify(Notify):
    """UDP 组播实现 —— 同机跨进程广播。

    每个 ws 连接 (即每个 fork 出的 CGI 进程) 各自持有一个实例,
    生命周期跟连接走; 记得在 Q.on_close / atexit 里 stop()。
    """

    def __init__(self, name: str, group: str = DEFAULT_GROUP, port: int = DEFAULT_PORT,
                 iface: str = DEFAULT_IFACE, hb_interval: int = DEFAULT_HB_SEC) -> None:
        super().__init__(name)
        self.group = group
        self.port = port
        self.iface = iface
        self.hb_sec = hb_interval
        self.sent: list[bytes] = []          # 测试用: 记录出站包 (不依赖真实收发)
        self._dry_run = False

        self._sock = self._open_socket()
        self.running = True
        self._last_hb = 0.0
        self._stop_r, self._stop_w = __import__('os').pipe()
        self._thread = threading.Thread(target=self._loop, name=f'Notify-{name}',
                                        daemon=True)
        self._thread.start()

    # ── 发送 ────────────────────────────────────────────────────────────────
    def emit(self, channel: str | None, payload: Any = b'', **meta: Any) -> 'SocketNotify':
        """发一条消息. payload 走 bytes (str 自动 UTF-8 编码)。"""
        body = payload if isinstance(payload, bytes) else str(payload).encode('utf-8')
        pkt = self._build_packet('msg', self._coerce(channel), body, meta)
        self.sent.append(pkt)
        if self._dry_run:
            return self
        with self._send_lock:
            # 显式传目标地址, 不 connect —— Linux 下 connected UDP 直接丢回环包
            self._sock.sendto(pkt, (self.group, self.port))
        return self

    # ── 收发循环 ────────────────────────────────────────────────────────────
    def _open_socket(self) -> socket.socket:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        s.bind((self.iface, self.port))
        mreq = socket.inet_aton(self.group) + socket.inet_aton(self.iface)
        s.setsockopt(socket.IPPROTO_IP, IP_ADD_MEMBERSHIP, mreq)
        s.setsockopt(socket.IPPROTO_IP, IP_MULTICAST_TTL, HB_TTL)
        s.setblocking(False)
        return s

    def _loop(self) -> None:
        sel = selectors.DefaultSelector()
        sel.register(self._sock, selectors.EVENT_READ)
        sel.register(self._stop_r, selectors.EVENT_READ)
        import time
        try:
            while self.running:
                for key, _ in sel.select(timeout=0.5):
                    if key.fd == self._stop_r:
                        return
                    self._read_once()
                self._emit_hb()
        except Exception as e:  # noqa: BLE001
            print(f'[{self.name}] loop crashed: {type(e).__name__}: {e}',
                  file=__import__('sys').stderr)
        finally:
            sel.close()

    def _read_once(self) -> None:
        try:
            data, addr = self._sock.recvfrom(PACKET_LIMIT)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                return
            raise
        msg = self._parse_packet(data, f'{addr[0]}:{addr[1]}')
        if msg is not None and msg.kind == 'msg':
            self._dispatch(msg)

    def _emit_hb(self) -> None:
        import time
        now = time.time()
        if self.running and now - self._last_hb >= self.hb_sec:
            self._last_hb = now
            pkt = self._build_packet('hb')
            self.sent.append(pkt)
            if not self._dry_run:
                try:
                    with self._send_lock:
                        self._sock.sendto(pkt, (self.group, self.port))
                except OSError:
                    pass

    def stop(self) -> 'SocketNotify':
        """停收发循环. 必须在主线程同步调 (signal handler 里不能 acquire lock)。"""
        if not self.running:
            return self
        self.running = False
        try:
            __import__('os').write(self._stop_w, b'.')
        except OSError:
            pass
        self._thread.join(timeout=2)
        for s in (self._stop_w, self._stop_r):
            try:
                s.close()
            except OSError:
                pass
        try:
            self._sock.close()
        except OSError:
            pass
        return self

    def __repr__(self) -> str:
        return f'SocketNotify(name={self.name!r}, group={self.group}:{self.port})'


def on(instance: Notify, channel: str | None):
    """方法装饰器版订阅.

        @on(m, :chat)
        def handler(msg): ...
    """
    def deco(fn: Callable[[Message], Any]) -> Callable[[Message], Any]:
        instance.on(channel, fn)
        return fn
    return deco