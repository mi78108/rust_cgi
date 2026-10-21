---
title: 一次 Rust 二进制在板子上跑不起来的排查
date: 2026-09-28T11:19:00Z
updated: 2026-09-28T11:19:00Z
tags: [rust, embedded, gentoo]
---

今天把一个 Rust 1.79 编出来的二进制推到板子上跑, 直接 `Segmentation fault`, 啥 stack trace 都没有。

排查路径基本靠猜:

1. **musl vs glibc** — 板子上 rootfs 是 musl, 主机是 glibc。`-C target=x86_64-unknown-linux-musl` 编译后 OK。
2. **stripped vs not** — release 默认 `strip = "symbols"`, 但 musl 环境下 `strip` 工具是 host 的 binutils, 处理目标文件偶尔崩。`strip = "none"` 然后上板后手撕。
3. **linker 顺序** — `[profile.release]` 加 `lto = "thin"` 之后体积小了 30%, 但启动顺序变了, 静态 init 段先后乱了。改回 `lto = false` 暂时搁置。

教训: 嵌入式项目应该一开始就把 `target/` 锁定到一个镜像版本, 别等到上线前一晚才发现 strip 默认值改了。