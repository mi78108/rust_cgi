---
title: 把 systemd unit 拆成两半的教训
date: 2026-08-30T14:00:00Z
updated: 2026-09-15T09:20:00Z
tags: [linux, ops, systemd, lesson]
summary: 一个 unit 拆成两个之后, restart 顺序、启动依赖、reload 行为全部变了, 我花了一周才把所有边角理清。
---

我之前有一个 systemd unit, 起名 `webhook-handler.service`, 启动顺序是:
1. 读环境变量 (从 `/etc/webhook-handler/env`)
2. 起 TCP 监听, 端口 9000
3. fork 出去一个 worker 进程做实际处理
4. systemd 觉得服务起来了, 因为 port 9000 在 listen

跑了两年没问题, 直到上个月出现了一个 corner case:

我的 worker 进程在收到 `SIGTERM` 之后会优雅关停, 关闭所有 in-flight 请求, 写入最后的 batch, 然后退出。 但是这个 worker 进程是从 `webhook-handler.service` 里 fork 出来的, 它**不是 systemd 直接管的进程**, 所以 systemd 给主进程发 `SIGTERM` 的时候, worker 不会收到 —— worker 的 ppid 变了, 跟 init 走, 不再属于这个 cgroup。

我后来是这么修的: 把 worker 拆出来, 做成单独的 `webhook-handler-worker@.service` (带 instance 模板), 通过 `Requires=` 和 `After=` 让 systemd 知道这两个东西要一起管。

写完, 跑一周, 修了一堆小 bug 之后, 我总结了一下**为什么拆 unit 是对的**:

## 拆 unit 给你的 side effect 比你想象的多

我拆之前以为, 拆 unit 就是「进程多挂一份 systemd 配置」而已。 实际上不是。 一拆, 你会立刻面对下面这些事:

### 1. 重启顺序变了

原来一个 unit 里, 我可以在代码里 fork 出一个 worker, fork 完主进程继续跑, 但实际上**只有 systemd 视角的主进程**才算这个 unit 在跑。 现在拆成两个 unit, systemd 必须知道「先起哪个再起哪个」, 不然 worker 比主进程先起就会连不上。

我的写法:

```ini
[Unit]
Description=webhook handler
Requires=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/webhook-handler
Restart=on-failure
```

worker:

```ini
[Unit]
Description=webhook handler worker %i
Requires=webhook-handler.service
After=webhook-handler.service
PartOf=webhook-handler.service

[Service]
Type=simple
ExecStart=/usr/bin/webhook-handler-worker %i
Restart=on-failure
```

`PartOf=` 这个东西我之前没用过 —— 它是说「如果你 stop 主 unit, 这个 worker 也 stop, 但反方向不传播」。 加上这个, 我 `systemctl stop webhook-handler.service` 就会连带停掉 worker, 但 `restart worker.service` 不会反过来影响主进程。

### 2. reload 行为变了

原来一个 unit, 我 `systemctl reload webhook-handler.service` 会触发主进程 reload, 主进程可以选择「通知 worker 也 reload」。

现在拆成两个 unit, `systemctl reload webhook-handler.service` 只触发主进程 reload, **worker 不会自动 reload**。 我必须在主进程 reload 的最后给 worker 发信号, 或者用 `ExecReload=` 在 systemd 这一层处理。

我选了后者:

```ini
[Service]
ExecReload=/bin/kill -HUP $MAINPID
ExecReload=/usr/bin/systemctl reload webhook-handler-worker@1.service
ExecReload=/usr/bin/systemctl reload webhook-handler-worker@2.service
```

(注意 `ExecReload=` 可以写多次, systemd 会按顺序执行; 第一个 `kill -HUP` 是给主进程自己的, 后两个是给 worker 的。)

### 3. 日志归属变了

原来一个 unit, 所有日志都在 `journalctl -u webhook-handler.service` 里, 主进程和 worker 一起, 靠 syslog tag 区分。

现在拆成两个, 主进程的日志在 `journalctl -u webhook-handler.service`, worker 的日志在 `journalctl -u webhook-handler-worker@1.service`。

我 debug 的时候经常要看两边。 我的 `~/.bashrc` 里加了个 alias:

```bash
alias jlh='journalctl -u webhook-handler.service -u webhook-handler-worker@1.service -u webhook-handler-worker@2.service --since "5 min ago" -f'
```

写出来的输出按时间 merge, 不分 unit, 跟原来一个 unit 看到的一样。

### 4. cgroup 限额要重新分

原来一个 unit, 我设 `MemoryMax=2G` 是给整个主+worker 一起的。 现在拆开, 我必须**单独给每个 unit 设** —— 要么主进程 1G + worker 1G, 要么都给 2G 然后其中一个 worker 超了被 kill 我看不出来是哪个。

我选了前者, 因为我**确实**知道主进程只用 500M, 给多了是浪费。 worker 各 1G, 因为单 worker 可能临时吃 800M 做大 batch。

## 不拆的边界

不是所有东西都要拆。 我的判断标准:

- **不拆**: 主进程是 worker 的 supervisor, 重启主进程就重启所有 worker, 它们的生命周期不可分割。 这种情况拆 unit 是过度工程化。
- **拆**: 主进程和 worker 各自独立, 任何一个挂了可以单独 restart, 不影响另一个的运行。 这种情况下拆 unit 是简化 debug 和 ops 的。

我的 chatroom 那个 unit 我拆了, 因为 ws gateway 挂了不应该让 storage worker 一起死。 我的 sensors 那个 unit 没拆, 因为只有一个进程, 拆了就是给自己找事。

## 教训

如果你正在考虑拆, 我的建议是:

1. 先想清楚「拆完之后重启顺序是什么」。 如果你心里没数, 那就先别拆。
2. `PartOf=` 比 `Requires=` 更适合这种「连带的依赖」场景。 `Requires=` 会让 worker 跟主进程一起 auto-start, 但你**只想** worker 跟主进程一起 stop, 那就用 `PartOf=`。
3. 日志和 cgroup 要重新设, 不是 copy-paste 的。
4. 写好之后跑一周, 至少做一次模拟故障演练: `kill -9` 主进程, 看看 worker 会怎么反应; `kill -9` worker, 看看主进程会怎么反应。

我之前觉得写得不够细, 跑了两周才把所有边角理清, 这两周我差不多每天都在 `journalctl -f` 上看。