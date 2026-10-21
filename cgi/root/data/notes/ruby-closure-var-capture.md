---
title: CGI 路由里 block 局部变量会互相污染
date: 2026-10-21T15:40:00Z
updated: 2026-10-21T16:10:00Z
tags: [ruby, gotcha, refactor]
---

重构 `create_share` 时想抽个 helper 取配置参数, 写成这样:

```ruby
opt = ->(key, default = '') {
  v = req.param(key)
  next v if v && !v.to_s.empty?
  item = form[key]          # ← 撞名了
  item && !item.file? ? item.content.to_s : default
}

item = form.items.find(&:file?)   # 外层的文件项
content = item.content
...
name = opt.call('name', '')       # 这里调用后 item 变成了 nil
name = item.filename if name.empty?  # NoMethodError
```

报 `undefined method 'filename' for nil`。

原因: Ruby 的 block 是**闭包**, 会捕获并改写外层的同名局部变量。lambda 里写的 `item = form[key]` 不是新变量, 是给外层那个 `item` 重新赋值。

修法就一个字: 换名。

```ruby
opt = ->(key, default = '') {
  v = req.param(key)
  next v if v && !v.to_s.empty?
  f = form[key]
  f && !f.file? ? f.content.to_s : default
}
```

教训: 在闭包里做赋值前先看一眼外层有没有同名变量。这类 bug 编译期不报错、运行时静默改变语义, 而且只在特定调用顺序下才暴露 —— 我是先写了 `opt` 定义、后面才 `item = form.items...`, 顺序反过来的话根本发现不了。