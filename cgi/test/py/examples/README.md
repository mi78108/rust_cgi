# pyex — Python 框架的示例集

放在 `/opt/tools/pyex`（持久化目录），通过软链暴露到 CGI 树：

    cgi/test/py/examples        # Python 示例(在仓库里, 不可用软链)

因为 spider 只会执行 `cgi/` 下的文件，而 `/opt/tools` 不在 CGI 树里，
所以用软链接过去 —— 改这里，`cgi/test/py/examples` 立刻跟着变。

## 跑

```sh
H=http://172.19.0.1:8080      # 容器内走网关；宿主机上用 127.0.0.1

curl -s "$H/test/py/examples/01/basics"
curl -s "$H/test/py/examples/01/basics?q=1&user=hawk"
curl -s "$H/test/py/examples/01/basics/greet/zh/hawk"

curl -s "$H/test/py/examples/02/json-api"
curl -s "$H/test/py/examples/02/json-api?q=中文"
curl -s -X POST -H 'content-type: application/json' \
     -d '{"title":"hello","tags":["a","b"]}' "$H/test/py/examples/02/json-api"
curl -s "$H/test/py/examples/02/json-api/1"
curl -s -X DELETE "$H/test/py/examples/02/json-api/1"

curl -s "$H/test/py/examples/03-templates"
curl -s "$H/test/py/examples/03-templates/file"

curl -s "$H/test/py/examples/04/advanced/stream"
curl -sI "$H/test/py/examples/04/advanced/download"
curl -sI "$H/test/py/examples/04/advanced/cookie"
curl -s -F 'f=@/etc/hostname' "$H/test/py/examples/04/advanced/upload"
```

## 文件

| 文件 | 演示 |
|---|---|
| `01-basics` | 最小骨架：导入 / 装饰器路由 / query 参数 / 命名捕获 |
| `02-json-api` | 完整 API：领域层与 HTTP 层分离、参数校验、统一错误格式 |
| `03-templates` | `@<{}>` 模板：print 输出、洞内可用 `{}`、大模板走文件 |
| `04-advanced` | 流式 / 文件下载 / cookie / 上传 / pub 静态资源 / WebSocket |
| `page.tpl` | 03 用的大模板文件 |
| `sample.txt` | 04 下载用的样本 |

## 写起来是什么样

```python
#!/usr/bin/env python3
import os, sys
sys.path.insert(0, os.path.join(os.environ['Cgi_Root'], '_env_', 'python'))
from _base_ import Q

@Q.get('/user/<name>')
def user(req, rsp):
    rsp.ok_json({'name': req.named('name'), 'argv': list(Q.ARGV)}).finish()

Q.run()
```

对照 Ruby 版（同一个端点）：

```ruby
require_relative '../../_env_/ruby/_base_'

Q.get '/user/<name>' do |req, rsp|
  rsp.ok_json(name: req.named(:name), argv: Q::ARGV).finish
end
```

差别只有导入方式和块语法；响应字节完全一致（`/test/parity` 那套用例验过 16 组）。
