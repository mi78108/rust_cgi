# `_env_/python/` — Spider CGI 框架的 Python 实现

与 `ruby/_base_.rb` 行为对齐的 Python 版。宿主机的 spider 直接 exec 脚本，
shebang (`#!/usr/bin/env python3`) 决定解释器 —— 同一个 URL 路径下，
Ruby 脚本和 Python 脚本可以互换，服务端无感知。

    cgi/_env_/
      ruby/    _base_.rb  _ext_form_.rb  _ext_notify_.rb
      python/  _base_.py  _ext_form_.py _ext_notify_.py

## 跑起来

业务脚本：

```python
#!/usr/bin/env python3
import sys, os
sys.path.insert(0, os.path.join(os.environ['Cgi_Root'], '_env_', 'python'))

from _base_ import Q

@Q.get('/')
def index(req, rsp):
    rsp.ok_html('<h1>hi</h1>').finish()

Q.run()          # 被 import 时需手动驱动; 直接 exec 时也会自动兜底
```

放好后 `curl http://<host>:8080/<你的路径>` 即可，改完立即生效（fork-per-request）。

## 与 Ruby 版的差异

行为一致的部分（已用对拍验证，见下）：

- ENV 契约、`MAP_PATH` 推导、pattern 匹配（含命名捕获、`\A...\Z` 包裹、
  纯字符串 pattern 走 `REQ_PATH` 比较）
- `Rsp` 全部构造器与链式语义、`finish` 幂等、chunked 分帧
- `Body.wrap` 类型分派、`each_chunk` 分块行为
- 模板 `@<{}>`：终止符是字面 `}>`、`print` 为输出方式、错误渲染成 `[ERROR: ...]`
- `Req` 全部访问器、默认值、**body 单次可读**语义
- multipart 解析（含 RFC 5987 `filename*`）
- 未命中路由的 404 兜底（`atexit`）
- **HTTP 响应字节级一致**（16 个用例逐字节 diff 通过）

语言层面的表示法差异（行为一致，不必对齐）：

| | Ruby | Python |
|---|---|---|
| 空值 | `nil` | `None` |
| 类名 | `Q::Body::TextBody` | `TextBody` |
| 数字类型 | `Integer` | `int` |
| dict 字面量 | `{"a"=>1}` | `{'a': 1}` |
| 异常名 | `RuntimeError` / `ArgumentError` | `ValueError`（pattern 非法） |
| 异常消息 | 各语言自带措辞 | |

一处**写法**差异（语义相同，但注意）：

- 模板里的语句。Ruby `eval` 接受语句（`raise "x"` 是表达式），
  Python 的 `eval` 模式只收表达式。框架已加 `exec` 回退，两边都能跑；
  但同一段模板要跨语言共用时，写成表达式更稳：

      @<{ (print("a"), 42)[1] }>      # 两边通用
      @<{ print("a"); 42 }>           # 只有 Ruby 合法

- JSON 输出。`rsp.ok_json` 已用 `separators=(',', ':')` 对齐 Ruby 的紧凑
  输出；但自己手写 body 时记得也加，否则 Content-Length 会对不上。

## 自检与对拍

```sh
H=http://172.19.0.1:8080     # 容器内走网关; 宿主机上用 127.0.0.1

# Python 框架自检 (101 断言, GET/POST + 多种 MAP_PATH)
curl -s "$H/test/framework/py_probe2" | jq '.ok,.passed,.total'

# 行为对拍: 两边输出同构 JSON, diff 即可
curl -s "$H/test/parity/rb" | jq . > /tmp/rb.json
curl -s "$H/test/parity/py" | jq . > /tmp/py.json
diff /tmp/rb.json /tmp/py.json

# HTTP 字节对拍: 16 个用例逐字节相同
for c in json html text redirect redirect301 notfound badreq server \
         cookie header file empty unicode chunked 404raw unknown; do
  diff <(curl -si "$H/test/parity/http/rb?case=$c" | od -c) \
       <(curl -si "$H/test/parity/http/py?case=$c" | od -c) \
    && echo "OK $c" || echo "DIFF $c"
done
```

## 注意

- `__pycache__` 会被写进 `_env_/python/`。这目录在 fork-per-request 下被
  大量进程并发 import，建议加进 `.gitignore`。
- 模板求值**不是安全沙箱** —— `__import__` 照样可用。模板内容来自自己的
  `page.html`、不接受外部输入，所以够用；真要隔离得靠独立进程 + seccomp。