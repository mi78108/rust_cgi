---
title: 我从 php 切到 rust + ruby 的那个周末
date: 2026-07-12T18:00:00Z
updated: 2026-07-12T18:00:00Z
tags: [rust, ruby, retrospect, hack]
summary: 4 个月前我把自己跑了 6 年的 php 站全删了, 换成 rust + ruby。 当时觉得是冲动的决定, 现在看是对的。
---

4 个月前的一个周五晚上, 我把 `rm -rf /var/www/legacy/` 这个命令敲了下去。

那个目录里跑着我从 2019 年开始维护的 6 个 php 应用: 一个私人日记、一个家庭照片库、一个客户的项目管理面板、一个给爸妈做的简易新闻订阅页、两个我忘了干什么用的 cron script。 它们都很丑, 都很慢, 都有我没修完的 bug。

我删掉它们的理由很具体: **那周我为了加一个「按日期筛选照片」的功能, 花了 4 个小时, 因为我不知道这个功能加在哪一层。** 项目结构是个 2019 年写的 mini-framework, 它有 controller、view、helper, 还有几个我自己也说不清干嘛的 plugin。 我 grep 了 5 分钟才找到 sql query 在哪。

那天晚上我没睡好。 第二天周六早上起来, 我做了一件事: 用 `cargo new` 开了一个新项目, 写了一个 50 行的 rust TCP 解析器。 周日晚上, 它能 npm 我能 curl 通。

## 为什么是 rust + ruby, 不是别的

周六早上我打开 vscode 之前, 列过几个候选:

| 候选 | 优点 | 缺点 |
|---|---|---|
| 继续 php, 重构 | 学习曲线低, 数据都在 | 2019 写的 mini-framework 我已经看不懂了 |
| node + express | 生态丰富, async | 我装 node 生态的痛点: 每年 npm 半年后 6 个 minor 版本不兼容 |
| python + flask | 简单, 数据分析好用 | 我前年用过, 装依赖的痛苦记忆犹新 |
| go + gin | 编译快, 二进制小 | 我没写过 go, 不愿意为了一个周末学新东西 |
| **rust + ruby** | rust 写 router, ruby 写 handler | 看起来奇怪 |

**我选了 rust + ruby 是因为我已经有 rust 基础 + ruby 基础**。 写 router 那一块, rust 给我静态保证 (没有「忘了 catch 某个 errno」这种 bug), 写 handler 那一块, ruby 给我快速 string 处理。 各取所长。

这听起来像 hack, 但其实有个哲学: **让每种语言做它擅长的事, 不要硬塞**。 rust 擅长**类型安全 + 并发 + 零成本抽象**, 不擅长快速 string 操作; ruby 擅长**字符串处理 + eval + 文件 IO**, 不擅长性能 + 类型安全。 两者拼起来正好。

## 那个周末我做了什么

```
周六早上 09:00  cargo new rust_cgi
周六上午 11:00  50 行 TCP parser + accept loop
周六下午 14:00  协议: 解析 method/path/version/headers
周六下午 17:00  fork 出去跑 ruby handler
周六晚上 20:00  handler 写出第一个 200 OK + content-length

周日早上 09:00  handler 读 ./_init_.rb, 跑 Q.map 注册
周日上午 11:00  ENV 字段对齐 (Req_Path / Req_Method / Req_Headers)
周日下午 16:00  nginx 反代 + 第一个真实路由跑通
周日晚上 20:00 迁移完一个最旧的 php 页面, 删掉 /var/www/legacy
```

周一, 一切都在跑, 我没改任何东西, 我去上班了。

## 4 个月后, 那个周末留下的债

删 `/var/www/legacy` 是个冲动的决定, 但 4 个月后我没后悔过。 留下的债:

1. **6 个原 php 应用, 我只迁了 4 个**。 还有一个家庭照片库和 1 个 cron 还在老的 vm 上跑, 因为迁的 effort 大于价值, 我留着。
2. **新框架没测试**。 我前面有篇 post 说过, 我在 5 个路由以内不写测试, 现在是 12 个路由 (加上 chatroom / map / sensors / website 这些), 还是不写测试。 我知道这事迟早要还。
3. **rust 那边偶尔 panic**。 我那个 TCP parser 写得粗糙, 没处理某个 corner case 时会 `unwrap()` panic, 然后 systemd restart。 大概一个月一次, 我还没修。

这些债加起来, 比继续维护那 6 个 php 应用的债少。

## 我学到的

**周末能 ship 的东西比想的更值钱**。 如果我那个周末去选 PHP+Django, 我可能周末过完了还在装 venv; 如果我选 node+express, 我可能周末过完了还在 `npm install`。 **选自己已经会的东西, 不要在周末学新东西**, 这个原则我以后都会遵守。

**rust + ruby 看起来奇怪, 但对我这个项目是对的**。 不是因为 rust 跟 ruby 是好搭配, 是因为**我是 rust + ruby 程序员, 不是 python 程序员, 不是 go 程序员**。 选工具看自己会什么, 不是看业界热度。

**删 `/var/www/legacy` 是个正确的「冲动」**。 我当时没列利弊清单, 没跟谁讨论, 周六晚上敲的 `rm -rf`。 4 个月后看, 这是我过去 4 个月做得最对的几个决定之一。

冲动的决定不一定是错的。 如果你有 6 年没维护的项目, 想删就删, 别拖着。 拖着的成本比删掉高。