---
title: spider 的 URL→脚本派发: 路径里的文件名会抢先
date: 2026-10-21T17:40:00Z
updated: 2026-10-21T18:10:00Z
tags: [rust, cgi, spider, routing]
---

想把所有路由集中到一个 `index` 里, 遇到一个反直觉的规则。

`src/tcp_class/http_func.rs` 的 `parse_req_path`:

```rust
loop {
    if script_file_path.exists() {
        if is_file { return (script_file_path, result); }
        if is_dir  { push("index"); return (...); }   // ← 目录 → 该目录下的 index
    }
    result.push(file_name);      // 把这一段当 restful 参数收起来
    script_file_path.pop();      // 往上剥一层
}
```

从路径尾部往前剥, **碰到第一个真实存在的文件/目录就停**。

所以 `cgi/tool/share/` 下有个 `download` 脚本时:

```
GET /tool/share/download?t=x
  → download 存在(文件) → 直接派发给它, index 根本看不到

GET /tool/share/download/<token>
  → download 存在 → 同上
```

我在 index 里写 `Q.get %r{^/(?<token>...)$}` 想接管, 永远匹配不到 —— 请求根本到不了 index。

**唯一解法是删掉那些同名文件**, 让路径里那一段不是真实文件, spider 才会继续往上剥到 index。

同理 `preview.js` 也不能叫这个名 —— 会被当 Ruby 脚本执行然后崩。绕法是叫 `preview.js.txt`, 再由某个 CGI 路由吐出去。

还有两个连带约束:

1. **兜底路由要放最后**。`Q.get %r{^/(?<token>[a-f0-9]{16})/?$}` 匹配任意 16 位 hex 单段路径, 排在它前面的所有具体路由才有匹配机会。
2. **不能在路径中间用保留字当动作名**。`/list`、`/info` 这种是字母, 不会被 16 位 hex 正则误伤; 但如果哪天有个 `/abc123...` 这样的单段, 跟短链就撞了。

现在的 URL 设计都是 `/<token>/info` `/<token>/view` `/<token>/chunk` 这种, token 在第一段 —— 天然避开了这个问题。