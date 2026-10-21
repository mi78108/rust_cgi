---
title: 批量正则替换会把控制流里的调用一起删掉
date: 2026-10-21T16:30:00Z
updated: 2026-10-21T17:05:00Z
tags: [ruby, refactor, gotcha]
---

把 `Share.missing(rsp)` 批量换成 `fail(rsp, 404)` (统一响应 helper), 用了这么个脚本:

```python
s = s.replace('return Share.missing(rsp) if s.nil?',
              's = load(req, rsp, token)\n    return if s.nil?')
```

匹配数: 3 处。都替换成功了。

然后 HTTP 测一遍, 发现所有「token 不存在」的请求返回 **HTTP 200 + 空 body**。

看代码 —— `load` 长这样:

```ruby
def load(req, rsp, token, purge: nil)
  s = Share.find(token)
  return nil if s.nil?          # ← rsp 从来没被写过!
  ...
end```

原来那行是 `return Share.missing(rsp) if s.nil?` —— **它负责写出 404 响应**。我的替换把它换成了 `return if s.nil?`, 逻辑上"等价"(都是找不到就返回 nil), 但丢掉了副作用。

字符串替换看不出这个差别, 因为它只认字面。

修:

```ruby
def load(req, rsp, token, purge: nil)
  s = Share.find(token)
  if s.nil? || (purge && s.reap!(purge: purge))
    fail(rsp, 404)
    return nil
  end
  s
end
```

同类事故这周出了两次, 另一次是批量删方法时把紧邻的一整条路由 (`GET /view`) 连带删了。

结论: 批量替换只适用于**纯机械、无副作用**的代码。有副作用的调用点(写响应、改状态、抛异常)必须逐个看。替换完至少 HTTP 测一遍每个分支, 光 `ruby -c` 过不了关 —— 语法是对的, 行为已经错了。