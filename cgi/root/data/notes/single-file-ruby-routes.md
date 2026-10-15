---
title: Ruby 单文件路由慢慢变成另一个形状
date: 2026-09-20T18:02:00Z
updated: 2026-09-25T22:40:00Z
tags: [ruby, cgi, hack]
---

`rust_cgi/cgi/` 这个目录结构最早是个 demo, 写着写着变真了:

- 每个路由一个 `index` 文件, `Q.map :GET, ...`
- 静态源放 `root/`, 路由直接 `File.read('./root/xxx.html')`
- 没有 ORM, 没有 controller 层, 没有 view 模板引擎 —— `@{var}` 内嵌 eval 够用就好

听起来很离谱, 但对一个 5 个路由 + 1 个人 + 周末维护的项目, 这种「每个路由就是一段代码」的结构, 改起来比 Rails 还快。今天加 /notes 接口, 从我提需求到能 curl 出来一共 40 分钟, 其中 30 分钟在写假数据。

什么时候这结构会撑不住? 大概是路由超过 30 个, 或者开始有人写中间件的时候。

那之前我大概率会搬去 axum 或者 Sinatra, 不再自己造。