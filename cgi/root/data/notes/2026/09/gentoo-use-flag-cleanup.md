---
title: Gentoo USE flag 失控后怎么回到原点
date: 2026-09-12T09:15:00Z
updated: 2026-09-12T09:15:00Z
tags: [gentoo, linux, ops]
---

`/etc/portage/package.use` 加着加着 80 个, 哪天 `emerge -uDN @world` 之后 systemd 突然拉不起 networkd, 想回滚都记不清是哪个 flag 触发的。

我用的"清理"姿势:

1. `emerge --info | grep ^USE` 看当前全局
2. 把 `package.use` 按包拆, 每个文件命名 `<category>-<pkg>.use`
3. 给每个文件加一行注释: `# added 2026-09-12, why: ...`
4. 不再全局加 flag, 全部走 package.use
5. 每月一次 `eix-diff-USE` 自检: 全局 USE 跟我上次记录差太多就停下来查

没用工具, 全靠注释和 git。git 救过我三次。

附: 不要在没快照的情况下 `emerge --emptytree @world`, 血泪。