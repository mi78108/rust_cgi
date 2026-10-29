# pad 协作编辑器 — 自实现方案（路线 B）

不用 @weavo，自写 RGA CRDT + 服务器权威成员表/文档状态。

## 为什么不跟 weavo 一样做纯转发

weavo 用 UDP 组播做纯 peer-to-peer 转发，membership 靠 CASPaxos 共识
（ballot/epoch/quorum）自选举 —— 3159 行里 824 行是共识层。

但 spider 是 fork-per-request：每个 ws 连接一个 ruby 进程，进程间只共享
UDP 组播。服务器本来就是唯一的可信协调点，没必要在客户端跑共识。

所以：**服务器持有权威状态**，客户端只做 RGA 合并。

## 架构

```
浏览器 A ─┐                      ┌─ 服务器 (ruby, 每连接一进程)
浏览器 B ─┼─ ws /tool/pad/ws ────►│  · 持有文档 op log（文件）
          │                      │  · 持有成员表（文件 + 组播通知）
          └──────────────────────┘
```

服务器做三件事：
1. **转交 op** —— 收到客户端的 op → 追加到 op log → 组播给其他客户端
2. **提供快照** —— 新客户端连上 → 发当前 op log 全量
3. **维护成员表** —— 谁在线、谁在哪个位置（presence）

## RGA CRDT

### 数据结构

```
节点: { id: [clientId, seq], value: "字", tombstone: bool, left: id|null, right: id|null }
```

文档 = 一棵有序树，ROOT 是虚拟根。

### 插入 op

```json
{ "t": "i", "id": ["c1", 3], "v": "A", "l": ["c1", 2], "r": null }
```
- `l` = 左边锚点节点 id（插入位置的左侧邻居）
- `r` = 右边锚点节点 id（可选，用于精确定位）
- `id` = `[clientId, seq]`，clientId 唯一 + seq 单调递增

### 插入位置决策（RGA 核心）

给定 op（left=L, right=R, id=I）：
```
prev = L
scan = L.next
while scan != null and scan.id != R:
    if scan.left != L and not isDescendantOf(scan.left, L):  break   # 出了 L 的子树
    if scan.left == L and compareId(I, scan.id) < 0:            break   # 同锚点按 id 排序
    prev = scan; scan = scan.next
insert I between prev and scan
```

**为什么要 `isDescendantOf`**：RGA 是树形结构，`L` 的所有子孙都在 `L` 之后。
如果不判断，"L 的兄弟节点"会被误插到 L 后面。

**同锚点 tiebreak**：两个客户端同时在 `L` 后面插入，必须有确定的全序，
否则两边顺序不同。用 `compareId(I, scan.id) < 0`（clientId 字典序 + seq）
保证所有副本一致。

### 删除 op

```json
{ "t": "d", "id": ["c1", 5] }
```
删的是**节点 id**，不是位置。节点标 `tombstone = true`（墓碑），
文本输出时跳过。

**必须用墓碑不能真删**：否则并发场景下，已删内容会被别的客户端"复活"。

### 收敛性

RGA 的 op 满足交换律 + 幂等：
- 同一 op 在任何副本上应用，结果相同
- 重复应用同一个 op，结果不变
→ 所有副本最终收敛

前提：op 到达所有副本。服务器转发 + 新客户端拿全量 log，保证这点。

## 消息格式（JSON over WS text frame）

客户端 → 服务器：
```json
{"t":"op","op":{...}}              // 一个 CRDT op
{"t":"hello","name":"user-ab12","color":"#c4f542"}   // 加入
{"t":"presence","cursor":42}       // 光标位置
{"t":"sync-request"}               // 请求全量（重连后）
```

服务器 → 客户端：
```json
{"t":"ops","ops":[...]}             // 全量或增量 op 列表
{"t":"members","members":[{id,name,color,cursor}]}
{"t":"ack"}                        // 确认
```

**为什么用 JSON text 而不是二进制**：这个规模（几百字节文档）下 JSON 的
带宽开销可以忽略，换来的是可调试（curl 能直接看懂）+ 不用写编解码器。
RGA 的 op 数 = 每次按键一个，长文档会涨，但 demo 阶段够用。

## 客户端实现

### crdt.js（~250 行）
- `Doc` 类：nodes Map、applyOp、getText、getIndexOf、transformPosition
- `compareId(a, b)`：clientId 字典序，再比 seq

### sync.js（~150 行）
- WS 连接、消息收发、重连
- 本地 pending buffer（发送失败/未连接时缓存）
- 收到远端 op → apply → 回调 onChange

### app.js（~250 行）
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
$SPIDER_DATA/pad/<docId>/ops.log      # 每行一个 op (JSON)
$SPIDER_DATA/pad/<docId>/members.json  # 成员表
```

- ops.log 只追加，不重写 → 简单、无锁（单进程 append 原子）
- 成员表每个 ws 进程写自己那一份？不行，会互相覆盖。
  → 用 **每客户端一个文件**：`members/<clientId>.json`，
    进程退出时删掉自己的。谁在线 = 目录里有哪些文件。

### 转发

```
收到 op →
  追加到 ops.log
  mcast.notify(:pad, op_json)     # 组播给其他客户端
  Q.write(op_json, true)           # 不回环（want_echo=false 已处理）
```

自己那份由本地直接应用（不必绕一圈）。

## 与 weavo 版本的对比

| | weavo | 本方案 |
|---|---|---|
| 代码量 | 3159 行 vendor | ~650 行 |
| 成员管理 | 客户端 CASPaxos 共识（824行） | 服务器文件 + 目录扫描 |
| 文档状态 | 客户端各自持有 | 服务器持有 op log |
| 离线支持 | 靠 snapshot/delta | 重连时拉全量 |
| 依赖 | 5 个 npm 包 | 无 |
| 协议 | 自定义二进制 | JSON text |

## 已知取舍

1. **op log 只增不减** —— 长文档会越来越大。要做定期快照 + 压缩。
2. **全量同步** —— 新客户端拉全量 log，文档大了就慢。可以加"最近 N 个 op + 快照"。
3. **无权限控制** —— 谁能连上就能改。demo 可以。
4. **单文档** —— 一个 docId 一个文档。多文档要加路由。

## 里程碑

1. crdt.js 单测：并发插入/删除顺序一致（浏览器里跑两个 Doc 实例）
2. sync.js：WS 收发 + 重连
3. app.js：输入绑定 + 光标
4. 后端：ops.log + 组播转发 + 成员表
5. 端到端：两浏览器并发打字，验证不丢字 + 顺序一致
