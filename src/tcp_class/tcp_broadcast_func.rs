use std::collections::HashMap;
use std::io::Error;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, Mutex};

use crate::tcp_class::Tcp;
use crate::{debug, error, info, utils::core::Req};

/// 握手头长度 —— 定长 8 字节
const HEAD_LEN: usize = 8;

/// 握手头魔数 —— 8 字节定长
///
///   0x89 'B' 'R' 'D' 0x0d 0x0a 0x1a 0x00
///
/// 0x89 是二进制/非文本标志，跟 HTTP、纯文本协议天然区分开；
/// 0x0d 0x0a (CRLF) + 0x1a (SUB) + 0x00 (NUL) 进一步降低误撞概率。
const MAGIC: [u8; HEAD_LEN] = [0x89, b'B', b'R', b'D', 0x0d, 0x0a, 0x1a, 0x00];

/// 长度前缀字节数 —— 消息体是 `[len u32 BE][payload]`
const LEN_PREFIX: usize = 4;

/// 单条消息长度上限 —— len 是 u32 (最大 4G)，但不能真让人申请 4G 内存。
/// 超过就断开连接。
const MAX_MSG_LEN: u32 = 16 * 1024 * 1024;

/// 每个订阅者的环形缓冲条数 —— 太小容易触发 Lagged（丢消息）
const CHANNEL_CAPACITY: usize = 1024;

/// 连接 id 长度 —— 定长 8 字节（u64 大端）
///
/// 定长的好处: 广播消息里的 id 不用带长度前缀，客户端按固定偏移就能切。
const ID_LEN: usize = 8;

/// 目标 id —— 定长 8 字节（u64 大端）
///
/// 0 = 广播给全频道；非 0 = 只给这一个连接。
const DST_LEN: usize = 8;

/// 广播哨兵 —— dst == 0 表示「广播给全频道」
///
/// ★ 连接 id **从 1 开始**（UID.fetch_add(1)），0 永远保留给这个哨兵。
///   否则第一个连接就是 id 0，它将永远无法被定向寻址。
const DST_BROADCAST: u64 = 0;

/// 全局频道表: channel 名 -> Sender
///
/// Sender 放在这里而不是每个连接各建一个，是因为 broadcast 只有一个 Sender
/// 才能广播给所有人。连接断开时按 receiver_count 清理，避免表无限增长。
type Channels = Mutex<HashMap<String, broadcast::Sender<Arc<Vec<u8>>>>>;

static CHANNELS: OnceLock<Channels> = OnceLock::new();

/// 连接 id 分配器 —— 自增序号
///
/// 用 u64 而不是 usize：id 会进线格式（定长 8 字节），不能随平台宽度变。
///
/// ★ 从 **1** 开始 —— 0 保留给「广播」哨兵（dst == 0）。
static UID: AtomicU64 = AtomicU64::new(0);

fn channels() -> &'static Channels {
    CHANNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 全局连接表: id -> 连接信息
///
/// key 就是 id（连接的唯一身份），所以结构体里不再重复存一份。
type Connections = Mutex<HashMap<u64, TcpBroadcast>>;

static CONNECTIONS: OnceLock<Connections> = OnceLock::new();

fn connections() -> &'static Connections {
    CONNECTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 查某个频道当前有哪些连接（在线成员）
#[allow(dead_code)]
pub async fn channel_members(channel: &str) -> Vec<TcpBroadcast> {
    let map = connections().lock().await;
    map.values()
        .filter(|c| c.channel == channel)
        .cloned()
        .collect()
}

/// 查全部连接
#[allow(dead_code)]
pub async fn all_connections() -> Vec<TcpBroadcast> {
    let map = connections().lock().await;
    map.values().cloned().collect()
}

/// TCP 广播通道
///
/// 协议:
///   握手: `[0x89 'B' 'R' 'D' 0x0d 0x0a 0x1a 0x00]` (8 字节定长)
///         + `<channel_name>\n` (变长, \n 结尾)
///   服务端下发: `[len u32 BE][id 8 字节]` —— 客户端收到这条 = 通讯建立
///
///   客户端 → 服务端: `[len u32 BE][dst 8 字节][payload]`
///     dst = 目标连接 id，0 = 广播给全频道
///
///   内部广播帧（走 broadcast 通道）: `[len u32 BE][src 8 字节][dst 8 字节][payload]`
///     src = 发送者的连接 id（服务端加的，客户端不管）
///     dst = 原样保留客户端指定的目标
///
///   服务端 → 客户端: `[len u32 BE][src 8 字节][payload]`
///     ★ **下行不带 dst** —— 服务端在 write_loop 里已经按 dst 过滤过了
///       （只接受 dst == 自己的 id 或 dst == 0），发到这里的一定是给自己的。
///     src = 原始发送者的 id（客户端据此知道消息是谁发的）
///
/// 消息带长度前缀是为了让所有订阅者收到的**字节流完全一致** ——
/// TCP 是字节流, 直接广播原始字节的话各客户端的切分点可能不同。
///
/// ★ 定向消息（dst != 0）在 `write_loop` 里过滤 ——
///   每个连接的写任务按自己的 uid 判断：不是发给自己的帧就**跳过不写**。
///   所以定向消息的字节**不会进入非目标连接的 socket**（保密性有保证）。
///
///   注意：`tx.send()` 仍然把内部帧塞进每个订阅者的环形缓冲 ——
///   「不写 socket」做到了，「不广播」没做到。
///   真正的方案 B（服务端路由、只投递给目标）要改成 mpsc 定向投递。
#[derive(Debug, Clone)]
pub struct TcpBroadcast {
    /// 所在频道
    pub channel: String,
    /// 连接 id —— 与连接表的 key 相同
    pub id: u64,
}

impl TcpBroadcast {
    /// 协议探测：看开头是不是本协议
    ///
    /// **会阻塞** —— socket 级 peek 会等客户端发数据。这是分流的必要代价：
    /// 不看数据就没法知道走哪条路。
    ///
    /// 用 `OwnedReadHalf::peek`（socket 级 MSG_PEEK），**不消费**数据 ——
    /// 匹配失败时这些字节仍在 socket 缓冲里，后续 `read()` 照常读到。
    /// 跟 `Http::matches()` 完全同构。
    pub async fn matches(stream: &Tcp) -> bool {
        let mut buffer = [0u8; HEAD_LEN];
        match stream
            .req_reader
            .lock()
            .await
            .get_mut()
            .peek(&mut buffer)
            .await
        {
            Ok(len) => len >= HEAD_LEN && buffer == MAGIC,
            Err(_) => false,
        }
    }

    /// 主流程：握手 -> 订阅频道 -> 收发循环
    pub async fn run(stream: Tcp) -> Result<bool, Error> {
        // ---- 1. 读握手头 + 频道名 ----
        let channel_name = {
            let mut reader = stream.req_reader.lock().await;

            // 8 字节定长头
            // 注意: 必须在同一个 reader lock 里读，不能调 read_full(&stream, ..)
            // —— 那个函数内部会再 lock 同一个 mutex，死锁。
            let mut head = [0u8; HEAD_LEN];
            if reader.read_exact(&mut head).await.is_err() {
                debug!("TcpBroadcast handshake EOF at head");
                return Ok(false);
            }
            if head != MAGIC {
                debug!("TcpBroadcast bad magic {:?}", head);
                return Ok(false);
            }

            // 频道名: 变长, \n 结尾
            let mut line = Vec::new();
            let n = reader.read_until(b'\n', &mut line).await?;
            if n == 0 {
                debug!("TcpBroadcast handshake EOF at channel name");
                return Ok(false);
            }
            // read_until 会把 \n 也读进来，去掉尾部换行
            let name = String::from_utf8_lossy(&line)
                .trim_end_matches(['\r', '\n'])
                .to_string();
            if name.is_empty() {
                debug!("TcpBroadcast empty channel name");
                return Ok(false);
            }
            debug!("TcpBroadcast handshake ok channel={}", name);
            name
        };
        // ---- 2. 分配连接 id —— 连接的唯一身份 ----
        //
        // 后面所有日志、连接表、广播消息里的 id 都用它，不再另起一套编号。
        //
        // ★ 从 1 开始 —— 0 保留给 dst 的「广播」哨兵。
        //   fetch_add(1) 返回的是**自增前**的值，所以第一次拿到 1。
        let uid = UID.fetch_add(1, Ordering::Relaxed) + 1;

        // ---- 3. 订阅频道 ----
        let tx = {
            let mut map = channels().lock().await;
            map.entry(channel_name.clone())
                .or_insert_with(|| {
                    // broadcast::channel 返回 (Sender, Receiver)，只取 Sender。
                    // Receiver 丢弃 —— 每个连接自己 subscribe()。
                    broadcast::channel(CHANNEL_CAPACITY).0
                })
                .clone()
        };
        let rx = tx.subscribe();
        info!(
            "TcpBroadcast[{}] join channel={} receivers={}",
            uid,
            channel_name,
            tx.receiver_count()
        );

        // ---- 4. 下发连接 id —— 表示通讯建立 ----
        //
        // 客户端收到这条消息 = 握手完成、连接可用。
        // 只发给这个连接自己（不广播给频道里的其他人）。
        //
        // 必须在写任务启动**之前**写 —— 否则跟写任务并发写 socket，字节顺序会乱。
        {
            let mut frame = Vec::with_capacity(LEN_PREFIX + ID_LEN);
            frame.extend_from_slice(&(ID_LEN as u32).to_be_bytes());
            frame.extend_from_slice(&uid.to_be_bytes());
            if let Err(e) = stream.write(&frame).await {
                error!("TcpBroadcast[{}] send id failed {:?}", uid, e);
                return Ok(false);
            }
            if let Err(e) = stream.req_writer.lock().await.flush().await {
                error!("TcpBroadcast[{}] flush id failed {:?}", uid, e);
                return Ok(false);
            }
        }
        info!("TcpBroadcast[{}] established", uid);

        // ---- 5. 保存连接信息（查成员列表用），断开时移除 ----
        {
            let mut map = connections().lock().await;
            map.insert(
                uid,
                TcpBroadcast {
                    channel: channel_name.clone(),
                    id: uid,
                },
            );
            let members = map.values().filter(|c| c.channel == channel_name).count();
            debug!(
                "TcpBroadcast[{}] channel={} members={}",
                uid, channel_name, members
            );
        }

        // ---- 5. 并发: 读任务广播 + 写任务转发 ----
        let tcp = Arc::new(stream);
        let mut reader_task = Some({
            let tcp = Arc::clone(&tcp);
            let tx = tx.clone();
            tokio::spawn(async move { read_loop(tcp, tx, uid).await })
        });

        let mut writer_task = Some({
            let tcp = Arc::clone(&tcp);
            tokio::spawn(async move { write_loop(tcp, rx, uid).await })
        });

        // 任一方向结束就整体结束
        //
        // 用 Option 包着: select! 里借用 (`as_mut().unwrap()`) 而不是 move ——
        // 结束后还要对没完成的那个调 abort()。
        // 完成的那个直接置 None —— **已完成的 JoinHandle 不能再 poll**
        // (tokio 会 panic "JoinHandle polled after completion")。
        tokio::select! {
            _ = reader_task.as_mut().unwrap() => { reader_task = None; },
            _ = writer_task.as_mut().unwrap() => { writer_task = None; },
        }

        // 关键: 必须 abort 掉还在跑的那个 task。
        //
        // write_loop 持有 broadcast::Receiver —— task 没结束, Receiver 就没 drop,
        // receiver_count 就不减, channel 永远清理不掉（表无限增长）。
        //
        // 实测症状: 连接全断了之后, 新连接 join 时 receivers 仍然是 3 而不是 1。
        if let Some(t) = reader_task {
            t.abort();
            let _ = t.await;
        }
        if let Some(t) = writer_task {
            t.abort();
            let _ = t.await;
        }

        // ---- 6. 清理 ----
        // 6a. 移除连接记录
        {
            let mut map = connections().lock().await;
            map.remove(&uid);
        }
        // 6b. 没人订阅了就删掉 channel
        {
            let mut map = channels().lock().await;
            if tx.receiver_count() == 0 {
                map.remove(&channel_name);
                debug!("TcpBroadcast[{}] channel {} removed", uid, channel_name);
            }
        }
        let _ = tcp.close().await;
        Ok(true)
    }
}

/// 读任务：从 socket 读消息 -> 广播给频道
///
/// 客户端发来的消息格式 `[len u32 BE][dst 8 字节][payload]`。
///
/// 服务端加上 src（发送者 id）后，构成**内部广播帧**：
///   `[len u32 BE][src 8 字节][dst 8 字节][payload]`
/// len = 16 + payload.len()
/// dst 原样保留 —— write_loop 靠它判断这条是不是发给自己的。
///
/// **按固定大小分块读写**（用 env 里的 Req_Buffer_Size），不一次性按 len 分配大缓冲。
async fn read_loop(tcp: Arc<Tcp>, tx: broadcast::Sender<Arc<Vec<u8>>>, uid: u64) {
    let buf_size = buffer_size(&tcp);
    let mut buf = vec![0u8; buf_size];

    loop {
        // ---- 读 4 字节长度前缀 ----
        let mut len_bytes = [0u8; LEN_PREFIX];
        match read_full(&tcp, &mut len_bytes).await {
            Ok(true) => {}
            Ok(false) => {
                debug!("TcpBroadcast[{}] read EOF at len prefix", uid);
                break;
            }
            Err(e) => {
                debug!("TcpBroadcast[{}] read len err {:?}", uid, e);
                break;
            }
        }
        let len = u32::from_be_bytes(len_bytes);

        if len > MAX_MSG_LEN {
            error!(
                "TcpBroadcast[{}] msg too large {} > {}, drop connection",
                uid, len, MAX_MSG_LEN
            );
            break;
        }
        if len < DST_LEN as u32 {
            // 连 dst 都装不下 —— 帧格式不对，断连（继续读只会错位）
            error!(
                "TcpBroadcast[{}] msg len {} < dst len {}, drop connection",
                uid,
                len,
                DST_LEN
            );
            break;
        }

        // ---- 读 dst（定长 8 字节）----
        //
        // dst = 0 → 广播给全频道；非 0 → 只给这一个连接。
        //
        // 这里**照样广播给全频道**（tx.send()），过滤发生在 write_loop ——
        // 每个连接的写任务按自己的 uid 决定要不要写进 socket。
        let mut dst_bytes = [0u8; DST_LEN];
        if let Err(e) = read_full(&tcp, &mut dst_bytes).await {
            debug!("TcpBroadcast[{}] read dst err {:?}", uid, e);
            break;
        }
        let dst = u64::from_be_bytes(dst_bytes);

        // ---- 读 payload，分块累积 ----
        let payload_len = len as usize - DST_LEN;
        let mut payload = Vec::with_capacity(payload_len);
        let mut remaining = payload_len;
        while remaining > 0 {
            let want = remaining.min(buf.len());
            match read_full(&tcp, &mut buf[..want]).await {
                Ok(true) => {}
                Ok(false) => {
                    // 不完整的消息 —— 丢弃（连接断了，TCP 语义下这条消息不完整）
                    debug!(
                        "TcpBroadcast[{}] incomplete msg, dropped ({} bytes left)",
                        uid,
                        remaining
                    );
                    return;
                }
                Err(e) => {
                    debug!("TcpBroadcast[{}] read payload err {:?}", uid, e);
                    return;
                }
            }
            payload.extend_from_slice(&buf[..want]);
            remaining -= want;
        }

        // ---- 广播（内部帧）----
        // 加上发送者的 src + 原样保留 dst + 长度前缀：
        //   [len u32 BE][src 8 字节][dst 8 字节][payload]
        // len = ID_LEN + DST_LEN + payload.len()
        //
        // dst 保留在帧里 —— write_loop 靠它判断这条是不是发给自己的，
        // 以及重拼下行帧时要把这 8 字节去掉。
        let mut frame = Vec::with_capacity(LEN_PREFIX + ID_LEN + DST_LEN + payload.len());
        frame.extend_from_slice(&((ID_LEN + DST_LEN + payload.len()) as u32).to_be_bytes());
        frame.extend_from_slice(&uid.to_be_bytes());
        frame.extend_from_slice(&dst.to_be_bytes());
        frame.extend_from_slice(&payload);

        match tx.send(Arc::new(frame)) {
            Ok(n) => {
                debug!(
                    "TcpBroadcast[{}] broadcast {} bytes to {} peers (dst={})",
                    uid,
                    payload.len(),
                    n,
                    if dst == DST_BROADCAST {
                        "all".to_string()
                    } else {
                        dst.to_string()
                    }
                );
            }
            Err(e) => {
                // 一个订阅者都没有 —— 频道空了，消息丢掉无所谓
                debug!("TcpBroadcast[{}] broadcast failed (no peer): {}", uid, e);
            }
        }
    }
}

/// 写任务：从频道收消息 -> 写 socket
///
/// ★ **定向消息在这里过滤**（dst != 0 时只写给目标连接）。
///
/// 收到的**内部帧**布局: [len u32 BE][src 8B][dst 8B][payload]
/// dst 在帧里的偏移 = LEN_PREFIX + ID_LEN = 12，长度 DST_LEN = 8。
///
/// 每一帧先看 dst：
///   dst == 0    → 广播，全频道都写
///   dst == uid  → 定向给本连接，写
///   其它        → 不是给本连接的，**跳过不写**
///
/// ★ 这样定向消息的字节**不会进入非目标连接的 socket** —— 比客户端过滤强：
///   客户端过滤的话，字节还是过了别人的 socket（对方只是丢弃）。
///   在服务端过滤，保密性有保证。
///
/// ★ **下行帧不带 dst** —— 重拼成 `[len u32 BE][src 8B][payload]`：
///   已经过滤过了，发到这里的一定是给自己的，dst 是多余信息。
///   len 也要跟着减 8。
///
/// ⚠️ 注意：`tx.send()` 仍然把内部帧塞进了每个订阅者的环形缓冲 ——
///   「不写 socket」做到了，「不广播」没做到。
///   真正的方案 B（服务端路由）要改成 mpsc 定向投递。
async fn write_loop(tcp: Arc<Tcp>, mut rx: broadcast::Receiver<Arc<Vec<u8>>>, uid: u64) {
    let buf_size = buffer_size(&tcp);

    loop {
        match rx.recv().await {
            Ok(frame) => {
                // ---- 定向消息过滤 ----
                //
                // 帧太短（装不下 src + dst）→ 跳过，不写。
                let need = LEN_PREFIX + ID_LEN + DST_LEN;
                if frame.len() < need {
                    debug!(
                        "TcpBroadcast[{}] frame too short {} (need {}), skipped",
                        uid,
                        frame.len(),
                        need
                    );
                    continue;
                }
                // dst 在帧里的偏移 = LEN_PREFIX + ID_LEN（跳过 len 和 src）
                let dst = u64::from_be_bytes([
                    frame[LEN_PREFIX + ID_LEN],
                    frame[LEN_PREFIX + ID_LEN + 1],
                    frame[LEN_PREFIX + ID_LEN + 2],
                    frame[LEN_PREFIX + ID_LEN + 3],
                    frame[LEN_PREFIX + ID_LEN + 4],
                    frame[LEN_PREFIX + ID_LEN + 5],
                    frame[LEN_PREFIX + ID_LEN + 6],
                    frame[LEN_PREFIX + ID_LEN + 7],
                ]);
                if dst != DST_BROADCAST && dst != uid {
                    // 不是发给本连接的 —— 跳过（不写 socket）
                    debug!(
                        "TcpBroadcast[{}] skip directed msg for dst={}",
                        uid,
                        dst
                    );
                    continue;
                }

                // ---- 重拼下行帧：去掉 dst ----
                //
                // 内部帧: [len 4B][src 8B][dst 8B][payload]   len = 16 + payload.len()
                // 下行帧: [len 4B][src 8B][payload]            len = 8  + payload.len()
                //
                // len 也要改 —— 声明的长度必须等于实际写入的字节数。
                let payload_len = frame.len() - need;
                let mut out = Vec::with_capacity(LEN_PREFIX + ID_LEN + payload_len);
                out.extend_from_slice(&((ID_LEN + payload_len) as u32).to_be_bytes());
                out.extend_from_slice(&frame[LEN_PREFIX..LEN_PREFIX + ID_LEN]);
                out.extend_from_slice(&frame[need..]);

                // 按固定大小分块写
                let mut off = 0usize;
                let mut failed = false;
                while off < out.len() {
                    let end = (off + buf_size).min(out.len());
                    match tcp.write(&out[off..end]).await {
                        Ok(n) if n > 0 => off += n,
                        Ok(_) => {
                            debug!("TcpBroadcast[{}] write zero", uid);
                            failed = true;
                            break;
                        }
                        Err(e) => {
                            debug!("TcpBroadcast[{}] write err {:?}", uid, e);
                            failed = true;
                            break;
                        }
                    }
                }
                if failed {
                    return;
                }
                // 必须 flush —— Tcp::write 不 flush，数据会卡在 BufWriter 里，
                // 客户端收不到（跟 WS 的 write_with_opcode 同一个坑）
                //
                // 注意: 这里单独 lock req_writer, 不能跟 write 一起 lock ——
                // Tcp::write 内部已经 lock 了同一个 mutex, 重复 lock 会死锁。
                if let Err(e) = tcp.req_writer.lock().await.flush().await {
                    debug!("TcpBroadcast[{}] flush err {:?}", uid, e);
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                // TCP 是字节流，丢消息会导致上层解析错乱 —— 不能像"可丢"那样继续。
                // 直接断开，让客户端重连并重新同步。
                error!(
                    "TcpBroadcast[{}] lagged {} msgs, closing (byte stream cannot lose data)",
                   uid, n
                );
                return;
            }
            Err(broadcast::error::RecvError::Closed) => {
                debug!("TcpBroadcast[{}] channel closed", uid);
                return;
            }
        }
    }
}

/// 读满 buf 为止。
/// 返回 Ok(true) = 读满，Ok(false) = EOF，Err = 错误
async fn read_full(tcp: &Tcp, buf: &mut [u8]) -> Result<bool, Error> {
    let mut got = 0usize;
    while got < buf.len() {
        match tcp.read(&mut buf[got..]).await? {
            Some(n) if n > 0 => got += n,
            Some(_) => return Ok(false),
            None => return Ok(false),
        }
    }
    Ok(true)
}

/// 单次读写的缓冲大小 —— 跟其它 Req 实现一致，取 env 里的 Req_Buffer_Size
fn buffer_size(tcp: &Tcp) -> usize {
    tcp.env()
        .get("Req_Buffer_Size")
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(131072)
}
