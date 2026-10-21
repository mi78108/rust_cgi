---
title: 9 个 CGI 脚本收成 2 个的全过程
date: 2026-10-21T19:00:00Z
updated: 2026-10-21T19:40:00Z
tags: [ruby, refactor, cgi, design]
summary: 文件分享服务从 9 个 CGI 入口、17 条散落的路由, 收成一个 index + 一个 _lib_.rb。URL 顺便改成了 RESTful。这篇记录整个过程里踩到的坑和做的取舍。
---

文件分享服务(`tool/share`)用了几个月, 从最初的 3 个脚本长到 9 个:

```
create  upload  finish  list  preview  download  edit  delete  index
```

每个文件 100~200 行, 每个文件顶部都是 `require_relative '../../_base_'`, 中间重复着同一套「加载 meta.json → 判断存在 → 判断有效 → 写 JSON 响应」的流程。

某天我发现改一个业务规则要同时改 3 个文件, 就决定收一收。

## 第一步: 先把「重复」量化

动手之前先写了个脚本, 把每个函数定义抽出来对比:

```python
from collections import defaultdict
byname = defaultdict(list)
for f in files:
    for name, body in defs(f).items():
        byname[name].append((f, body))

for name, lst in byname.items():
    if len(set(b for _, b in lst)) == 1:
        print(f"  {name:16s} × {len(lst)}  {','.join(f for f,_ in lst)}")
```

结果比我预想的干净 —— 大部分函数是**逐字相同**的多份拷贝:

| 函数 | 份数 | 分布在 |
|---|---|---|
| `json` | 9 | 全部 |
| `dir_of` / `meta_path` | 6 | create, download, edit, finish, preview, upload |
| `load_meta` / `save_meta` | 2 | download, upload |

但有三个函数**名字相同、实现不同**:

```
dead_reason   list → 'quota'（字符串，给前端看）
              download → :quota（符号，给 reap_if_dead 用）
              preview → true/false（布尔）
```

判定条件完全一样, 只是返回格式不同。当时我在 `_lib_.rb` 里写了注释说"这个不能合并, 会影响调用点"。

## 第二步: 换个模型，而不是继续搬函数

第二次动手时我意识到问题不在"重复多少", 在于**重复的是流程不是片段**。

9 个脚本都是同一个模子:

```
取参 → 存在性检查 → 授权/有效性判定 → 核心操作 → 写响应
```

我把「一个分享」当成对象, 而不是一堆散落的函数:

```ruby
class Share
  def self.find(token)         # 加载 + 判存在
  def dead_reason              # :quota / :expired / :none
  def reap!(purge: :mark)       # 懒清理
  def authorized?(cid:, pw:, require_cred:)
  def consume_quota!
  def merge_parts!
  def serve_attachment(rsp)
end
```

那个"返回格式不同所以不能合并"的障碍消失了 —— 现在只有一份判定, 调用方要什么格式自己转:

```ruby
s.dead_reason == Share::QUOTA   # download 端
s.dead_message                  # "次数已用完"，给前端看
```

路由脚本从 1131 行降到 738 行。

## 第三步: 把路由也收进一处

收完类之后, 9 个文件还在。这时候 spider 的派发规则给了我一个硬约束 —— 正好逼我做了对的决定。

`parse_req_path` 从路径尾部往前剥, **碰到第一个真实存在的文件就派发给它**。所以 `cgi/tool/share/download` 这个文件存在时, `/tool/share/download/*` 永远到不了 index。

想集中路由, 只能删掉那些同名文件。想通这一点之后, 删文件反而成了明确的目标而不是损失:

- `create` + `upload` + `finish` → 一个 `Share::Api` 模块, `POST /` 按 query 空/非空分流
- `edit` → `PATCH /<token>`
- `delete` → `DELETE /<token>`
- `preview` → `GET /<token>/chunk`
- `download` → `GET /<token>` (文件本体) + `GET /<token>/page` (详情页)
- `list` → `GET /list` + `GET /<token>/list`

最后 `tool/share` 目录下只剩两个 Ruby 文件:

```
index       165 行  15 条路由，零顶层方法
_lib_.rb   1091 行  Share + Share::Api + RangeBody
```

## 中途搞砸的两次

### 第一次: 把 `Share.missing` 批量换成 `fail(rsp, 404)`

我写了个 Python 脚本做替换, 匹配 3 处, 全部替换成功, `ruby -c` 通过。

然后 HTTP 测一遍, 发现所有「token 不存在」的请求返回 **HTTP 200 + 空 body**。

原来那行是:

```ruby
return Share.missing(rsp) if s.nil?    # 它负责写出 404 响应
```

替换后变成:

```ruby
return if s.nil?                        # rsp 从来没被写过
```

字符串替换看不出差别, 因为字面上"等价"(都是找不到就返回)。但副作用丢了。

### 第二次: 删方法时把邻近的路由也删了

删 `share_view_page` / `share_download_page` 两个 helper 时, 字符串替换连带吃掉了紧邻的 `Q.get %r{^/view/?$}` 整条路由。

`/tool/share/view?t=xxx` 404 了。这条路由上一轮就已经被误删过一次, 我当时没测到, 这次又踩一遍。

两次都是同一类错误: **批量替换只适用于纯机械、无副作用的代码**。有副作用的调用点(写响应、改状态)必须逐个看。

补一句: 两次都是靠 HTTP 实测发现的, 光读代码和 `ruby -c` 都看不出来。

## 现在的分工

```
index        只做路由分发，一眼看完 15 条端点
_lib_.rb
  Share       领域模型 — 一个分享是什么、能做什么（不碰 req/rsp）
  Share::Api  协议适配 — 把 HTTP 请求翻译成对 Share 的调用
  Q::RangeBody  206 响应体（HTTP 细节）
```

`Share` 不认识 `req` / `rsp`, 所以它可以被单元测试直接 new 出来验证:

```ruby
s = Share.new('x', {'max' => 5, 'left' => 3, 'done' => 1})
s.set_max!(10)
s.left   # => 8，  按「已用掉 2 次」重算
```

17 条断言, 不用起服务。

## 值不值

从 9 个文件到 2 个, 行数基本没变(1206 → 1092 + 165), 但:

- 业务规则从"散在 9 处"变成"每个只有一份"
- 加一个端点不用新建文件
- URL 顺便统一成 RESTful, 老链接全断了(这个是代价, 但分享链接本来就有失效风险)

如果要保留老链接, 值得加一层重定向 —— 我这次没做, 因为实际的分享量不大。

## 下次会怎么做

1. **先量化再动手**。写个脚本数重复函数, 比我凭感觉猜靠谱
2. **重复的如果是流程不是片段, 换模型**。搬函数只能消掉机械重复, 流程重复得靠对象
3. **副作用是红线**。批量替换前先标记哪些行有副作用, 那些手工改
4. **每步都 HTTP 测**。这次两个 bug 都是这样抓到的, 静态检查全绿