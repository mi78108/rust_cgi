---
title: 把 cgi 跑在单文件网关上的两年
date: 2026-09-25T20:00:00Z
updated: 2026-09-28T16:30:00Z
tags: [cgi, ruby, hack, retrospect]
summary: 两年下来, 单文件 cgi 路由从「能跑就行」变成了「能维护就行」。回头看哪些决定对了, 哪些把自己坑了。
---

两年前的某个周末, 我把 nginx 反代到一个 rust 写的 TCP 解析器上, 再 fork 出 ruby 进程跑一段 `puts "HTTP/1.0 200 OK\r\n\r\nHello"`。 那时候想的是「能 ping 通就行」, 后来这套东西就成了 `rust_cgi`。

两年下来, 这台机器上已经挂了 5 个对外路由、3 个内部传感器、1 个 chatroom demo、1 个地图瓦片服务、还有这个个人站。 它们全都跑在同一套 "1 个 router index + 1 个 route index" 的结构上, 总共 ~1500 行 ruby + ~800 行 rust。 没有 ORM, 没有 controller, 没有 view 模板引擎 —— 真的, 全靠 `File.read` 和 `puts`。

## 一开始为什么这么写

写第一个路由的时候, 我刚把一个 Django 项目从硬盘上删掉。 那个项目 6 个 model、4 个 view 类、2 层 middleware、1 个 custom template tag, 改一行 css 要重启 6 个 cache, 我实在受不了了。

那个周末我打开 vim, 写了一个 14 行的 ruby 文件:

```ruby
require_relative './_init_'
Q.map :GET do |_, resp|
  resp.body(File.read('./root/page.html')).html.render.finally
end
```

跑通了。 curl 通, 浏览器能开, 没有 build step, 没有 venv 激活, 没有 `manage.py runserver`, 也没有任何一行因为一行之浏览器的 console 报错。

我当时的直觉是: **如果这套东西撑不过一个周末, 那就回到 Django; 如果它撑过了, 那就说明这套结构对一个 5 个路由 1 个人的项目来说够用。**

它撑过去了。 而且后来一直撑过来了。

## 两年后它变成了什么

现在 `cgi/` 长这样:

```
cgi/
├── _init_.rb        # framework, ~460 行
├── _ext_.rb         # extension helpers
├── index            # / → 302 /root
├── root/            # 主站
│   ├── index        # /root → page.html
│   ├── page.html    # 前端单页
│   ├── data/
│   │   └── notes/   # 5 篇短笔记 .md
│   ├── notes/
│   │   ├── _lib.rb  # frontmatter 解析器
│   │   └── index    # GET /root/notes 三段路由
│   └── posts/       # 新增 (本周)
│       ├── _lib.rb
│       └── index
├── chatroom/        # websocket + STOMP
├── map/             # 离线地图瓦片
├── sensors/         # bme280 上报
└── ...
```

每个子模块都是同一个形状: 一个可执行的 `index` (Ruby 路由入口) + 一个 `_lib.rb` 或 `_db.rb` (数据层) + `data/` (源数据) + 可选 `static/` 和 `uploads/`。

数据层全部走文件系统, 没碰过 sqlite/postgres。 这不是因为 sqlite 不好, 是因为文件系统够用: 5 篇笔记不需要事务, 1k 条消息可以扔 sqlite, 100k 条消息开始需要分表。

## 哪些决定对了

**1. `Q.map` 是惰性的, 不是声明式的。**

第一版我写过 `routes :get, '/notes' => 'notes#index'` 这种, 后来发现不对。 路由声明应该贴着它的 handler, 中间不要隔一个 dispatcher。 看现在的写法:

```ruby
Q.map(:GET, '/api/tags') do |req, resp|
  resp.ok_json({ tags: post_tag_counts }).finally
end
```

这是 3 行。 想加一个 endpoint 就 copy 一份, 改 path 和 body。 想删一行就 grep, 删掉。 没有 router 文件夹要扫, 没有 controller 类要 new。

**2. frontmatter 放在文件里, 不放在数据库里。**

`./root/data/notes/foo.md`:

```markdown
---
title: foo
date: 2026-09-28T11:19:00Z
tags: [rust, embedded]
---

正文 markdown
```

写一篇新笔记就是 `vim` 一份, 改日期, 写正文。 没后台、没 auth、没「保存」按钮。 想看就 `cat`, 想改就 `vim`, 提交 git 就有了 audit trail。

git log 就是我的 changelog。 我从来没写过一篇「v0.4.2 release notes」, 因为 git 已经是 release notes 了。

**4. 用 `File.read` 直接渲染 html, 不用 ERB/Haml/Slim。**

第一版我用过 ERB, 后来发现 ERB 在我项目里的价值是负的 —— 我需要在 html 里写 ruby 不是因为业务逻辑复杂, 是因为变量替换 (title / items / 当前的 section)。 5 行 `gsub` 加 `eval` 就够了:

```ruby
def render(body, vars)
  body.gsub(/@\{(\w+)\}/) { vars[$1.to_sym].to_s }
end
```

15 行能替代一个完整的模板引擎, 而 ERB 给我的 17 行就是「引号怎么转义」之类我**根本不想记**的语法糖。

## 哪些把自己坑了

**1. 没有写测试。**

嗯, 是的, 我项目里一个 `*_spec.rb` 都没有。

不是因为我赞成不写测试 —— 测试是有用的, 是不应该在这里混。 我「不写测试」是因为我没法说服自己为 spec/dummy 写一个「setup → expect → assert」循环。 我的 5 个路由都是「读文件 + 字符串拼接 + 输出」, 没有 state transition, 没有 side effect, 没有 race condition。

如果哪天这里加了一个「文件上传 → 转码 → webhook 通知」, 我会立刻加测试。 在那之前, smoke test (curl 一下 + 看一眼输出) 就够。

**3. websocket 那块代码写得太重。**

chatroom 是最早上的一个子模块, 当时我想用 SockJS + STOMP 跟前端对齐。 写了 ~600 行 ruby 处理 STOMP 帧: CONNECTED/SUBSCRIBE/SEND, 心跳, room 广播, 文件上传进度。

跑了 8 个月没问题。 8 个月之后, 我自己读这 600 行, 不知道哪个订阅属于哪个 connection。 我已经修过两次 bug, 每次都是「读半小时 + 加 console.log + 跑一下」。

下次写 chatroom 我会用更简单的方案 —— ws 收到一帧就转发给 room 里的其他人, 不解析 STOMP, 不维护 subscription 表。 4 行能替代 600 行。

**4. 没有写版本管理。**

我没有 SemVer, 没有 changelog, 没有 release branch。 我的「版本」是「现在跑的是哪份 git commit」, 用 `git rev-parse --short HEAD` 拼成 `v0.4.2-1a2b3c4` 写到 frontend 的 footer 里。

这有个好处: 我永远知道线上跑的是哪一份。 坏处是: 我从来没有「回滚」这个动作, 因为我从不上线我没跑过的版本。

## 这套结构的边界

写了一年多之后我有个判断: **这套结构在我这个项目上能撑到大约 30 个路由, 再多就开始走下坡路。**

不是因为 framework 不够, 是因为「grep 改 route」这个工作流的效率是 O(n), 30 个路由以内我能在 5 秒内定位到要改的那段; 100+ 超过这就要工具。 我会搬去 Sinatra 或者 axum, 把 framework 那块省了, 不再自己维护 dispatch 逻辑。

跨过这线之前, 我不打算优化任何东西。 它现在的形态是我当时能写出来的最好的, 而优化它不产生新功能。 我宁愿花两个月加个新路由。

## 给同样想这么干的人

如果你也想写一个 14 行的 cgi, 我的建议是:

- **不要写 framework, 写 router** —— dispatch 那一块是必须有的, 但「controller / model / view」三层不是。
- **不要用 ORM, 用文件** —— 直到你的数据开始需要事务, 才需要 sqlite。
- **不要写测试, 写 smoke** —— 除非你的代码有 state, 不然 curl 比 rspec 简单。
- **不要写文档, 写 commit** —— git log 就是文档, 比 README 真实。

如果这套撑不过一个周末, 那就回到 Django。 没人会因为你写过 14 行 ruby 就指责你。