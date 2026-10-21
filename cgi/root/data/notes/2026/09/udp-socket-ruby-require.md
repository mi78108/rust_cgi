---
title: 备忘: udp socket 在 ruby 里 require 的顺序
date: 2026-09-05T22:48:00Z
updated: 2026-09-06T08:12:00Z
tags: [ruby, sensors, ops]
---

调试 bme280 上报脚本时踩了个小坑: 单元测试里写 `require 'socket'` 在文件头, 然后跑 `bundle exec rspec`, 通过。 部署到裸 ruby + systemd unit 之后, 报 `cannot load such file -- socket`。

原因: rspec 间接加载了 socket (通过别的 gem), 把 require 顺序掩盖了。bare 启动里没别的依赖, 直接 RequireError。

教训:

- 用了 stdlib 的东西, **不要**用 `bundle exec`, `ruby` 直接跑就行
- 或者 unit test 启动时主动 `require 'socket'`, 让 stub 至少跟 prod 一样
- 更稳: 部署前 `ruby -c script.rb` 只能查语法, 不能查运行时依赖

今天给 /sensors 加了 sanity assert, systemd 起来头两秒主动发一帧 dummy udp 到 127.0.0.1, 失败立刻 `systemctl restart`, 比上线后人肉去摸机器强。