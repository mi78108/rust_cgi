# pad 协作编辑器 — 自实现方案（路线 B）

不用 @weavo，自写 RGA CRDT + 服务器权威成员表/文档状态。

## 为什么不跟 weavo 一样做纯转发

weavo 用 UDP 组播做纯 peer-to-peer 转发，membership 靠 CASPaxos 共识
（ballot/epoch/quorum）自选举 —— 3159 行里 824 行是共识层。

但 spider 是 fork-per-request：每个 ws 连接一个 ruby 进程，进程间只共享
UDP 组播。服务器本来就是唯一的可信协调点，没必要在客户端跑共识。

所以：**服务器持有权威状态**，客户端只做 RGA 合并。

（进程间转发后来从 UDP 组播换成了 BDR —— TCP 长连接，spider 做扇出。
有序、可靠、不丢包，见下面「进程间广播」。）

## 架构

```
浏览器 A ─┐                      ┌─ 服务器 (ruby, 每连接一进程)
浏览器 B ─┼─ ws /tool/pad/ws ────►│  · 持有文档 op log（文件）
          │                      │  · 持有成员表（文件 + 广播通知）
          └──────────────────────┘
```

服务器做三件事：
1. **转交 op** —— 收到客户端的 op → 追加到 op log → 广播给其他客户端
2. **提供快照** —— 新客户端连上 → 发当前 op log 全量
3. **维护成员表** —— 谁在线、谁在哪个位置（presence）

## RGA CRDT

### 数据结构

```
节点: { id: [clientId, seq], v: "字", tomb: bool, left: id|null }
```

文档 = 一棵有序树，ROOT 是虚拟根。

### 插入 op

```json
{ "t": "i", "id": ["c1", 3], "v": "A", "l": ["c1", 2] }
```
- `l` = 左边锚点节点 id（插入位置的左侧邻居）
- `id` = `[clientId, seq]`，clientId 唯一 + seq 单调递增

### 插入位置决策

实现用的是**层序渲染**，不是链式扫描：

```
节点只记 left（"我插在谁后面"），不记 next 指针。
渲染时：visible(node) = node.v + 依次拼接 visible(children(node))，
        children 按 id 字典序排。
顶层 = children(ROOT) 按 id 排序依次拼。
```

- **同锚点 tiebreak**：两个客户端同时在 `L` 后面插入 → 两者都是 `L` 的子节点
  → 按 `compareId`（clientId 字典序 + seq）排序 → 所有副本顺序一致 ✅
- **嵌套**：A 插入后又在它后面插 A2（A2 的 left = A）→ A2 是 A 的子节点
  → 渲染时紧跟 A → 与"A2 插在 A 后面"的直觉一致 ✅

> 代价：极端交错场景下，兄弟节点与更深的后代之间的顺序与"直觉"可能不同
> （链式 RGA 能做得更准）。层序版本更简单，且同样保证收敛。

### 删除 op

```json
{ "t": "d", "id": ["c1", 5] }
```
删的是**节点 id**，不是位置。节点标 `tomb = true`（墓碑），
文本输出时跳过。

**必须用墓碑不能真删**：否则并发场景下，已删内容会被别的客户端"复活"。
客户端 1 删了 X，客户端 2 还没收到这条时又在 X 后面插了 Y —— 真删 X 的话
Y 会挂到 X 的父节点上，内容错位。

### 乱序到达

op 可能先于它的锚点到达（left 节点还没到）。此时 `applyInsert` 返回 false，
op 进 `pending` 缓冲；等锚点到了再 `drainPending()` 重放。

### 收敛性

RGA 的 op 满足交换律 + 幂等：
- 同一 op 在任何副本上应用，结果相同
- 重复应用同一个 op，结果不变（幂等键含 op 类型：`i:` / `d:`）
→ 所有副本最终收敛

前提：op 到达所有副本。服务器转发 + 新客户端拿全量 log，保证这点。

## 消息格式（JSON over WS text frame）

客户端 → 服务器：
```json
{"t":"op","op":{...}}              // 一个 CRDT op
{"t":"hello","name":"user-ab12","color":"#c4f542"}   // 加入
{"t":"presence","cursor":42}       // 光标位置
{"t":"sync"}                      // 请求全量（重连后）
{"t":"clear"}                     // 清空文档（广播给所有客户端）
```

服务器 → 客户端：
```json
{"t":"ops","ops":[...]}             // 全量或增量 op 列表
{"t":"members","members":[{id,name,color,cursor}]}
{"t":"clear"}                      // 清空通知
```

**为什么用 JSON text 而不是二进制**：这个规模（几百字节文档）下 JSON 的
带宽开销可以忽略，换来的是可调试（curl 能直接看懂）+ 不用写编解码器。
RGA 的 op 数 = 每次按键一个，长文档会涨，但 demo 阶段够用。

## 客户端实现

### crdt.js（313 行）
- `Doc` 类：`nodes` Map、`apply(op)`、`getText()`、`textIndex()`、
  `anchorAt(pos)`、`nodesInRange(start, len)`、`toOps()`
- `compareId(a, b)`：clientId 字典序，再比 seq
- `transformPosition(pos, start, len)`：远端 op 应用后挪本地光标

### sync.js（175 行）
- WS 连接、消息收发、重连
- 本地 pending buffer（发送失败/未连接时缓存）
- 收到远端 op → apply → 回调 onOps

### app.js（406 行）
- textarea 绑定：beforeinput/input/composition 事件
- 本地输入 → 生成 op → 发送
- 远端 op → apply → 更新 textarea + 变换光标
- presence：光标位置上报 + 远端光标渲染（mirror 测量法）

## 输入 → op 的转换（最容易出错的地方）

```
用户按下一个键 'H'：
  beforeinput: 记下 before = {value, start, end}   ← 此时 value 还是旧的
  input:       value 已被浏览器改成新的
               diff(before.value, el.value) → 算出插入/删除
               → 生成 op
```

**关键**：必须在 `beforeinput` 里快照，`input` 里才拿得到"改之前长什么样"。

本地删除：算出被删的节点的 id → 发 delete op。
**注意**：被删的可能是多个字符（选区删除）→ 要发多个 delete op。

## 光标位置变换

远端 op 应用后，本地光标要跟着挪，否则打字会插错位置。

```
插入：在 index 处插了 k 个字符 → 起点 >= index 的光标 += k
删除：区间 [start, start+len) 被删 → 落在区间内的光标 → start
```

## 服务器端实现（ruby）

### 状态文件

```
$SPIDER_DATA/pad/<space>/ops.log      # 每行一个 op (JSON)
$SPIDER_DATA/pad/<space>/members/<clientId>.json  # 成员表，每客户端一份
```

（`<space>` 是空间名，默认 `default` —— 见下面「空间」一节）

- ops.log 只追加，不重写 → 简单、无锁（单进程 append 原子）
- 成员表每个 ws 进程写自己那一份？不行，会互相覆盖。
  → 用 **每客户端一个文件**：`members/<clientId>.json`，
    进程退出时删掉自己的。谁在线 = 目录里有哪些文件。

### 转发

```
收到 op →
  追加到 ops.log
  mcast.notify(PAD_CHANNEL, {t:'ops',ops:[op]})   # BDR 广播给频道里其他客户端
  （自己那份由客户端本地直接应用，不绕一圈）
```

新客户端连上 → 发 `{"t":"ops","ops":[...]}` 全量（从 ops.log 读）。
服务器回客户端用 `rsp.ws_write`（带 4 字节长度前缀），
客户端发来的帧由 spider 解包成 `[len][rem]` 头交给 ruby。

### 进程间广播：BDR（TCP 长连接）

服务器进程之间用 `TcpNotify`（BDR 协议）转发，不是 UDP 组播：

```
每个 ws 连接 fork 一个 ruby 进程 →
  每个进程用 TcpNotify 连 spider 自己的监听端口（magic 探测分流到 tcp_broadcast）
  → spider 做扇出，广播给频道里所有订阅者
```

连线格式（跟 `src/tcp_class/tcp_broadcast_func.rs` 一致）：

```
握手:  [0x89 'B' 'R' 'D' 0x0d 0x0a 0x1a 0x00] + "<channel>\n"
服务端: [len u32 BE][id 8 字节]              ← 本连接的 id
客户端: [len u32 BE][payload]
广播:   [len u32 BE][id 8 字节][payload]      ← len = 8 + payload.len()
```

频道在握手时定死（一条连接一个频道），pad 用 `pad-<space>`（每空间一个频道）。
服务端地址默认 `127.0.0.1` + `$Cgi_Port`（spider 注入的自己的监听端口）。
主机名写死 127.0.0.1 —— BDR 是本机进程之间的连接，而 spider 的 bind 地址
可能是 `0.0.0.0`（监听所有网卡），那不是可连接的目标。

要连别处就显式传：

```ruby
TcpNotify.new('alice', host: '10.0.0.9', port: 9999, channel: 'room1')
```

比 UDP 组播好在：**有序、可靠、不丢包**，而且扇出在服务端做，
不用 N² 的组播流量。回环语义一致 —— BDR 会把消息发给发送者自己，
所以订阅用 `want_echo=false`，自己那份走 `rsp.ws_write`。

## 空间（多文档）

pad 支持「空间」—— 不同空间是**完全隔离**的：各自的 op log、各自的成员表、
各自的 BDR 频道。

```
/tool/pad/<space>          302 → /tool/pad/<space>/
/tool/pad/<space>/         页面
/tool/pad/<space>/app.js   静态资源（不分空间，还是平铺的 /tool/pad/app.js）
/tool/pad/ws/<space>       WS 端点
/tool/pad/                 默认空间 (default)
/tool/pad/ws               默认空间 (default)
```

数据目录：`$SPIDER_DATA/pad/<space>/{ops.log, members/}`

空间名规则：`[A-Za-z0-9._-]{1,64}` —— 会拼进文件路径和频道名，必须严格校验。

### ★ 为什么 WS 路径是 `/tool/pad/ws/<space>` 而不是 `/tool/pad/<space>/ws`

spider 派发时从右往左剥路径，**遇到目录就补 index**：

```
/tool/pad/<space>/ws
  cgi/tool/pad/<space>/ws   不存在
  cgi/tool/pad/<space>      不存在
  cgi/tool/pad              是目录 → 补 index → cgi/tool/pad/index  ← 命中!
```

`cgi/tool/pad/` 是**目录**，所以任何 `/tool/pad/<x>` 都会先命中目录，
派发到 `tool/pad/index`（静态文件服务器），**永远到不了 `tool/pad/ws`**。

而 `/tool/pad/ws/<space>` 不同：`cgi/tool/pad/ws` 是**文件**，先命中它，
restful 余段 = `["<space>"]` —— 空间名就在 `MAP_PATH` 里。

推演方法（别猜，直接算）：从右往左逐段试 `cgi/<前缀>` 是否是**文件**；
是就停（该文件执行）；若是**目录**，补 index 继续剥。

### index 为什么不是 pub 软连接

`pub` 是所有 `tool/*` 共用的静态文件服务器，不认识「空间」概念。
`/tool/pad/<space>` 会被派发到 `tool/pad/index`（原来是 pub 软连接），
restful 余段 = `["<space>"]` —— 所以 `tool/pad/index` 换成真脚本，
自己处理空间路由，静态文件部分照抄 pub 的逻辑。

路由顺序有坑：空间路由必须排在静态文件路由**前面**，
否则 `/my-space` 会被当成静态文件名（`file="my-space"`）→ 404。
但空间路由也不能把静态文件吞掉（`/app.js` 正则一样），所以要先看
`dist/` 里有没有同名文件 —— 有就当静态资源，没有才当空间名。

## 与 weavo 版本的对比

| | weavo | 本方案 |
|---|---|---|
| 代码量 | 3159 行 vendor | 894 行（crdt+sync+app） |
| 成员管理 | 客户端 CASPaxos 共识（824行） | 服务器文件 + 目录扫描 |
| 文档状态 | 客户端各自持有 | 服务器持有 op log |
| 进程间转发 | UDP 组播 | BDR（TCP 长连接，spider 扇出） |
| 离线支持 | 靠 snapshot/delta | 重连时拉全量 |
| 依赖 | 5 个 npm 包 | 无 |
| 协议 | 自定义二进制 | JSON text |

## 已知取舍

1. **op log 只增不减** —— 长文档会越来越大。要做定期快照 + 压缩。
2. **全量同步** —— 新客户端拉全量 log，文档大了就慢。可以加"最近 N 个 op + 快照"。
3. **无权限控制** —— 谁能连上就能改。demo 可以。
4. **单文档** —— 一个 docId 一个文档。多文档要加路由。
5. **BDR 频道固定在握手时** —— 一条连接只能收发一个频道。要跨频道得另开连接。

## 实现状态

已完成：
1. crdt.js 收敛性测试：40 轮 × 3 副本 × 18 op（含删除 + 随机投递顺序），全部收敛
2. sync.js：WS 收发 + 重连 + pending buffer
3. app.js：输入绑定（beforeinput 快照 + IME composition 处理）+ 远端光标 mirror 测量
4. 后端：ops.log + BDR 广播转发 + 成员表 + clear
5. 端到端：两个独立 WS 客户端并发编辑，文本收敛一致
