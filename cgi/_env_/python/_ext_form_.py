#!/usr/bin/env python3
"""Spider 扩展 — multipart/form-data 解析.

对应 `ruby/_ext_form_.rb`。需显式导入:

    from _ext_form_ import Form, FormItem

然后 `req.body_form_data()` 即可。

已踩:
  - boundary 分隔的 CRLF / LF 两种都要认
  - 终止 boundary `--<boundary>--` 单独成行
  - Content-Disposition 里的 name= / filename= 可能带引号, 要去掉
  - RFC 5987 的 `filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt` 必须优先于 filename
  - 裸 filename 里也可能带 %XX 编码 (部分客户端不发 filename*)
"""

from __future__ import annotations

import sys
import urllib.parse
from typing import Any, Callable, Iterator

__all__ = ['Form', 'FormItem']

import _base_  # noqa: E402  — 仅为把 Form 挂到 Q


def _unescape_percent(s: str) -> str:
    """只解 %XX, 其余原样保留 (避免把正常字符当转义)."""
    if '%' not in s:
        return s
    return urllib.parse.unquote(s, errors='replace')


class FormItem:
    """multipart 的一个 part."""

    __slots__ = ('name', 'filename', 'content_type', 'content')

    def __init__(self, header: dict[str, str], content: bytes) -> None:
        cd = (header.get('Content-Disposition') or '').split(';')
        name: str | None = None
        filename: str | None = None

        for seg in cd:
            k, sep, v = seg.strip().partition('=')
            if not sep:
                continue
            k = k.strip()
            v = v.strip()
            # RFC 5987 扩展参数: 浏览器传非 ASCII 文件名时优先用它
            if k.lower() == 'filename*':
                filename = self._decode_ext_param(v)
                continue
            if k.lower() == 'name':
                name = v.strip('"')
            elif k.lower() == 'filename':
                v = v.strip('"')
                # 裸 filename 里也可能是 %XX 编码
                filename = _unescape_percent(v)

        self.name = name
        self.filename = filename
        self.content_type = header.get('Content-Type') or 'text/plain'
        self.content = content

    @staticmethod
    def _decode_ext_param(v: str) -> str:
        """解 "UTF-8''%E6%8A%A5%E5%91%8A.txt" → "报告.txt"

        三段式 charset'lang'pct-encoded; charset 可能是 UTF-8 或 utf-8。
        """
        v = v.strip('"')
        parts = v.split("'", 2)
        enc = parts[0] if parts else ''
        body = parts[2] if len(parts) > 2 else (parts[-1] if parts else '')
        body = _unescape_percent(body)
        return body if enc.upper() == 'UTF-8' else v

    def is_file(self) -> bool:
        return bool(self.filename)

    def to_h(self) -> dict[str, Any]:
        return {
            'name': self.name,
            'filename': self.filename,
            'content_type': self.content_type,
            'size': len(self.content),
        }

    def save_to(self, path: str) -> str:
        with open(path, 'wb') as f:
            f.write(self.content)
        return path

    def __repr__(self) -> str:
        return (f'FormItem(name={self.name!r}, filename={self.filename!r}, '
                f'content_type={self.content_type!r}, size={len(self.content)})')


class Form:
    """解析后的 multipart 表单. 支持按 name 取 part 与遍历文件."""

    def __init__(self, items: list[FormItem]) -> None:
        self.items = items

    @staticmethod
    def parse(boundary: str | None,
              block: Callable[[FormItem], None] | None = None) -> 'Form | None':
        """从 stdin 读并解析整个 multipart body.

        boundary 取自 content-type 的 boundary= 参数。逐 part 调用 block。
        """
        if not boundary:
            return None
        boundary = boundary.strip()
        items: list[FormItem] = []

        stream = sys.stdin.buffer
        stream.readline()          # 丢弃首行 CRLF

        while True:
            header: dict[str, str] = {}
            while True:
                raw = stream.readline()
                if not raw:
                    return Form(items)
                line = raw.decode('utf-8', errors='replace').rstrip('\r\n')
                if line == '':
                    break
                if ':' not in line:
                    continue
                k, _, v = line.partition(':')
                header[k.strip()] = v.strip()

            content = b''
            final = False
            while True:
                raw = stream.readline()
                if not raw:
                    final = True
                    break
                line = raw.decode('utf-8', errors='surrogateescape')
                if line.startswith(f'--{boundary}--'):
                    final = True
                    break
                if line.startswith(f'--{boundary}'):
                    break
                content += raw
            if content.endswith(b'\r\n'):
                content = content[:-2]
            elif content.endswith(b'\n'):
                content = content[:-1]

            item = FormItem(header, content)
            items.append(item)
            if block is not None:
                block(item)
            if final:
                break

        return Form(items)

    def __getitem__(self, name: str) -> FormItem | None:
        return next((i for i in self.items if i.name == str(name)), None)

    def get(self, name: str, default: Any = None) -> Any:
        item = self[name]
        return default if item is None else item

    def each_file(self) -> Iterator[FormItem]:
        return (i for i in self.items if i.is_file())

    def files_count(self) -> int:
        return sum(1 for i in self.items if i.is_file())

    def __len__(self) -> int:
        return len(self.items)

    def __repr__(self) -> str:
        return f'Form({len(self.items)} items)'


# 挂到 Q 上, 让 Req#body_form_data 里的 Q.Form.parse 能找到。
# 放在文件末尾: 此时 Form 已定义。
_base_.bind_form(Form)
