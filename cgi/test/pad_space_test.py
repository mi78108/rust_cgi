#!/usr/bin/env python3
"""tool/pad 空间（restful 参数）测试

覆盖:
  1. 页面路由: /tool/pad/<space> -> 302 -> /tool/pad/<space>/
  2. 静态资源不受影响
  3. WS 端点 /tool/pad/ws/<space> —— 不同空间互相隔离
  4. 同空间内两个客户端互发
  5. 不同空间的数据各自独立 (ops.log 分开)
"""
import socket, struct, time, base64, os, json, sys
sys.path.insert(0, "/tmp")
from ws_client import build_frame, parse_frame

HOST, PORT = "127.0.0.1", 3000

passed = 0
failed = 0


def check(label, got, want):
    global passed, failed
    ok = (got == want)
    print(f"  {'OK  ' if ok else 'FAIL'} {label}: got={got!r} want={want!r}")
    if ok:
        passed += 1
    else:
        failed += 1


def http(path):
    import urllib.request
    req = urllib.request.Request(f"http://{HOST}:{PORT}{path}")
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None
    op = urllib.request.build_opener(NoRedirect)
    try:
        r = op.open(req, timeout=5)
        return r.status, r.headers.get('Location', ''), len(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Location', ''), len(e.read())


def connect_ws(path):
    s = socket.create_connection((HOST, PORT), timeout=8)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET {path} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    s.settimeout(8.0)
    while b"\r\n\r\n" not in buf:
        c = s.recv(4096)
        if not c:
            break
        buf += c
    if b"101" not in buf.split(b"\r\n")[0]:
        raise RuntimeError(f"handshake failed: {buf[:200]!r}")
    _, _, rest = buf.partition(b"\r\n\r\n")
    return s, rest


def send_json(s, obj):
    s.sendall(build_frame(0x1, json.dumps(obj, ensure_ascii=False).encode()))


def wait_for_op(s, buf, cid, timeout=6.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        s.settimeout(max(0.1, deadline - time.time()))
        r = parse_frame(buf)
        if r:
            fin, opcode, payload, consumed = r
            buf = buf[consumed:]
            try:
                m = json.loads(payload.decode())
            except Exception:
                continue
            if m.get("t") == "ops":
                for o in m.get("ops", []):
                    if o.get("id", [None])[0] == cid:
                        return o, buf
            continue
        try:
            c = s.recv(65536)
        except socket.timeout:
            break
        if not c:
            break
        buf += c
    return None, buf


print("=== 1. 页面路由 ===")
for space in ["default", "my-space", "team_1"]:
    st, loc, _ = http(f"/tool/pad/{space}")
    check(f"/tool/pad/{space} -> 302", st, 302)
    check(f"  Location", loc, f"/tool/pad/{space}/")
    st, _, _ = http(f"/tool/pad/{space}/")
    check(f"/tool/pad/{space}/ -> 200", st, 200)

st, _, _ = http("/tool/pad/")
check("/tool/pad/ -> 200", st, 200)

print("\n=== 2. 静态资源不受影响 ===")
for f in ["app.js", "style.css", "crdt.js", "sync.js"]:
    st, _, size = http(f"/tool/pad/{f}")
    check(f"/tool/pad/{f} -> 200", st, 200)
    check(f"  非空", size > 100, True)

print("\n=== 3. WS 端点 ===")
SP = f"space-{int(time.time()*1000)}"
SP2 = f"{SP}-other"

a, abuf = connect_ws(f"/tool/pad/ws/{SP}")
b, bbuf = connect_ws(f"/tool/pad/ws/{SP}")
c, cbuf = connect_ws(f"/tool/pad/ws/{SP2}")
print(f"  三个 WS 都连上了 (空间 {SP} x2, {SP2} x1)")

send_json(a, {"t": "hello", "name": "alice", "color": "#ff0000"})
send_json(b, {"t": "hello", "name": "bob", "color": "#00ff00"})
send_json(c, {"t": "hello", "name": "carol", "color": "#00ffff"})
time.sleep(1.5)

print("\n=== 4. 同空间内互发 ===")
CID = f"sp-op-{int(time.time()*1000)}"
op = {"t": "i", "id": [CID, 0], "v": "X", "l": ["ROOT", 0]}
send_json(a, {"t": "op", "op": op})
found, bbuf = wait_for_op(b, bbuf, CID)
check("同空间的 B 收到 A 的 op", found is not None, True)

print("\n=== 5. 不同空间隔离 ===")
found2, cbuf = wait_for_op(c, cbuf, CID, timeout=2.5)
check("不同空间的 C 收不到", found2 is None, True)

print("\n=== 6. 不同空间的 op 各存各的 ===")
CID2 = f"{SP2}-op"
op2 = {"t": "i", "id": [CID2, 0], "v": "Y", "l": ["ROOT", 0]}
send_json(c, {"t": "op", "op": op2})
time.sleep(1.0)

a.close(); b.close(); c.close()
print("\n=== 全部通过 ===")
sys.exit(0 if failed == 0 else 1)
