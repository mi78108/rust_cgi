use std::collections::HashMap;
use std::io::Error;
use std::sync::{Arc, OnceLock};
use ring::rand::{SecureRandom, SystemRandom};
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

/// uuid 文本长度 —— UUID v4 文本格式固定 36 字符
///
/// 定长的好处: 广播消息里的 id 不用带长度前缀，客户端按固定偏移就能切。
const UUID_LEN: usize = 36;

/// 全局频道表: channel 名 -> Sender
///
/// Sender 放在这里而不是每个连接各建一个，是因为 broadcast 只有一个 Sender
/// 才能广播给所有人。连接断开时按 receiver_count 清理，避免表无限增长。
type Channels = Mutex<HashMap<String, broadcast::Sender<Arc<Vec<u8>>>>>;

static CHANNELS: OnceLock<Channels> = OnceLock::new();

fn channels() -> &'static Channels {
    CHANNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 一个已连接的客户端
#[derive(Debug, Clone)]
pub struct ConnInfo {
    /// 所在频道
    pub channel: String,
}

/// 全局连接表: uuid -> 连接信息
///
/// key 就是 uuid（连接的唯一身份），所以 ConnInfo 里不再重复存一份。
type Connections = Mutex<HashMap<String, ConnInfo>>;

static CONNECTIONS: OnceLock<Connections> = OnceLock::new();

fn connections() -> &'static Connections {
    CONNECTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 生成 UUID v4（文本格式 36 字符）
///
/// 用 `ring` 的 CSPRNG —— 项目已经依赖 ring，不引入新的 uuid crate。
/// 按 RFC 4122 改两个 bit：version=4、variant=RFC4122。
fn gen_uuid() -> String {
    let mut bytes = [0u8; 16];
    // ring 的 SystemRandom 不会失败（系统熵源），失败就退化成全 0
    if SystemRandom::new().fill(&mut bytes).is_err() {
        debug!("gen_uuid: CSPRNG failed, fallback to zero bytes");
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

    let hex = b"0123456789abcdef";
    let mut out = String::with_capacity(36);
    for (i, b) in bytes.iter().enumerate() {
        if i == 4 || i == 6 || i == 8 || i == 10 {
            out.push('-');
        }
        out.push(hex[(b >> 4) as usize] as char);
        out.push(hex[(b & 0x0f) as usize] as char);
    }
    out
}

/// 日志里用的短标识 —— uuid 前 8 字符，够定位且不占太多日志宽度
fn short_id(uuid: &str) -> &str {
    &uuid[..8.min(uuid.len())]
}

/// TCP 广播通道
///
/// 协议:
///   握手: `[0x89 'B' 'R' 'D' 0x0d 0x0a 0x1a 0x00]` (8 字节定长)
///         + `<channel_name>\n` (变长, \n 结尾)
///   服务端下发: `[len u32 BE][uuid 文本]` —— 客户端收到这条 = 通讯建立
///   客户端发: `[len u32 BE][payload]`
///   广播给订阅者: `[len u32 BE][id 36 字节][payload]`
///                len = 36 + payload.len()，id 是发送者的 uuid
///
/// 消息带长度前缀是为了让所有订阅者收到的**字节流完全一致** ——
/// TCP 是字节流, 直接广播原始字节的话各客户端的切分点可能不同。
///
/// 广播消息里的 id 定长 36 字节（UUID v4 文本），所以客户端按固定偏移就能
/// 把 id 和 payload 切开，不需要额外的长度前缀。
#[derive(Debug)]
pub struct TcpBroadcast;

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

    /// 查某个频道当前有哪些连接（在线成员）
    #[allow(dead_code)]
    pub async fn channel_members(channel: &str) -> Vec<ConnInfo> {
        let map = connections().lock().await;
        map.values()
            .filter(|c| c.channel == channel)
            .cloned()
            .collect()
    }

    /// 查全部连接
    #[allow(dead_code)]
    pub async fn all_connections() -> Vec<ConnInfo> {
        let map = connections().lock().await;
        map.values().cloned().collect()
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

        // ---- 2. 生成连接名（uuid）—— 连接的唯一身份 ----
        //
        // 后面所有日志、连接表、广播消息里的 id 都用它，不再另起一套编号。
        let uuid = gen_uuid();

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
            short_id(&uuid),
            channel_name,
            tx.receiver_count()
        );

        // ---- 4. 下发连接名（uuid）—— 表示通讯建立 ----
        //
        // 客户端收到这条消息 = 握手完成、连接可用。
        // 只发给这个连接自己（不广播给频道里的其他人）。
        //
        // 必须在写任务启动**之前**写 —— 否则跟写任务并发写 socket，字节顺序会乱。
        {
            let mut frame = Vec::with_capacity(LEN_PREFIX + UUID_LEN);
            frame.extend_from_slice(&(UUID_LEN as u32).to_be_bytes());
            frame.extend_from_slice(uuid.as_bytes());
            if let Err(e) = stream.write(&frame).await {
                error!("TcpBroadcast[{}] send uuid failed {:?}", short_id(&uuid), e);
                return Ok(false);
            }
            if let Err(e) = stream.req_writer.lock().await.flush().await {
                error!("TcpBroadcast[{}] flush uuid failed {:?}", short_id(&uuid), e);
                return Ok(false);
            }
        }
        info!("TcpBroadcast[{}] established", short_id(&uuid));

        // ---- 4. 保存连接信息（查成员列表用），断开时移除 ----
        {
            let mut map = connections().lock().await;
            map.insert(
                uuid.clone(),
                ConnInfo {
                    channel: channel_name.clone(),
                },
            );
            let members = map.values().filter(|c| c.channel == channel_name).count();
            debug!(
                "TcpBroadcast[{}] channel={} members={}",
                short_id(&uuid), channel_name, members
            );
        }

        // ---- 5. 并发: 读任务广播 + 写任务转发 ----
        let tcp = Arc::new(stream);
        let mut reader_task = Some({
            let tcp = Arc::clone(&tcp);
            let tx = tx.clone();
            let uuid = uuid.clone();
            tokio::spawn(async move { read_loop(tcp, tx, uuid).await })
        });

        let mut writer_task = Some({
            let tcp = Arc::clone(&tcp);
            let uuid = uuid.clone();
            tokio::spawn(async move { write_loop(tcp, rx, uuid).await })
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
            map.remove(&uuid);
        }
        // 6b. 没人订阅了就删掉 channel
        {
            let mut map = channels().lock().await;
            if tx.receiver_count() == 0 {
                map.remove(&channel_name);
                debug!("TcpBroadcast[{}] channel {} removed", short_id(&uuid), channel_name);
            }
        }
        let _ = tcp.close().await;
        Ok(true)
    }
}

/// 读任务：从 socket 读消息 -> 广播给频道
///
/// 客户端发来的消息格式 `[len u32 BE][payload]`。
/// 广播出去时前面加上发送者的 id（定长 36 字节）：
///   `[len u32 BE][id 36 字节][payload]`，len = 36 + payload.len()
/// 订阅者据此知道每条消息是谁发的。
///
/// **按固定大小分块读写**（用 env 里的 Req_Buffer_Size），不一次性按 len 分配大缓冲。
async fn read_loop(tcp: Arc<Tcp>, tx: broadcast::Sender<Arc<Vec<u8>>>, uuid: String) {
    let buf_size = buffer_size(&tcp);
    let mut buf = vec![0u8; buf_size];

    loop {
        // ---- 读 4 字节长度前缀 ----
        let mut len_bytes = [0u8; LEN_PREFIX];
        match read_full(&tcp, &mut len_bytes).await {
            Ok(true) => {}
            Ok(false) => {
                debug!("TcpBroadcast[{}] read EOF at len prefix", short_id(&uuid));
                break;
            }
            Err(e) => {
                debug!("TcpBroadcast[{}] read len err {:?}", short_id(&uuid), e);
                break;
            }
        }
        let len = u32::from_be_bytes(len_bytes);

        if len > MAX_MSG_LEN {
            error!(
                "TcpBroadcast[{}] msg too large {} > {}, drop connection",
                short_id(&uuid), len, MAX_MSG_LEN
            );
            break;
        }
        if len == 0 {
            // 长度为 0 的消息：跳过，不广播（避免给订阅者塞空消息）
            continue;
        }

        // ---- 读 payload，分块累积 ----
        let mut payload = Vec::with_capacity(len as usize);
        let mut remaining = len as usize;
        while remaining > 0 {
            let want = remaining.min(buf.len());
            match read_full(&tcp, &mut buf[..want]).await {
                Ok(true) => {}
                Ok(false) => {
                    // 不完整的消息 —— 丢弃（连接断了，TCP 语义下这条消息不完整）
                    debug!(
                        "TcpBroadcast[{}] incomplete msg, dropped ({} bytes left)",
                        short_id(&uuid), remaining
                    );
                    return;
                }
                Err(e) => {
                    debug!("TcpBroadcast[{}] read payload err {:?}", short_id(&uuid), e);
                    return;
                }
            }
            payload.extend_from_slice(&buf[..want]);
            remaining -= want;
        }

        // ---- 广播 ----
        // 带上发送者的 id（定长 36 字节）+ 长度前缀一起发，
        // 订阅者拿到的就是能直接写的完整帧:
        //   [len u32 BE][id 36 字节][payload]
        // len = UUID_LEN + payload.len()
        let mut frame = Vec::with_capacity(LEN_PREFIX + UUID_LEN + payload.len());
        frame.extend_from_slice(&((UUID_LEN + payload.len()) as u32).to_be_bytes());
        frame.extend_from_slice(uuid.as_bytes());
        frame.extend_from_slice(&payload);

        match tx.send(Arc::new(frame)) {
            Ok(n) => {
                debug!(
                    "TcpBroadcast[{}] broadcast {} bytes to {} peers",
                    short_id(&uuid),
                    payload.len(),
                    n
                );
            }
            Err(e) => {
                // 一个订阅者都没有 —— 频道空了，消息丢掉无所谓
                debug!("TcpBroadcast[{}] broadcast failed (no peer): {}", short_id(&uuid), e);
            }
        }
    }
}

/// 写任务：从频道收消息 -> 写 socket
async fn write_loop(tcp: Arc<Tcp>, mut rx: broadcast::Receiver<Arc<Vec<u8>>>, uuid: String) {
    let buf_size = buffer_size(&tcp);

    loop {
        match rx.recv().await {
            Ok(frame) => {
                // 按固定大小分块写
                let mut off = 0usize;
                let mut failed = false;
                while off < frame.len() {
                    let end = (off + buf_size).min(frame.len());
                    match tcp.write(&frame[off..end]).await {
                        Ok(n) if n > 0 => off += n,
                        Ok(_) => {
                            debug!("TcpBroadcast[{}] write zero", short_id(&uuid));
                            failed = true;
                            break;
                        }
                        Err(e) => {
                            debug!("TcpBroadcast[{}] write err {:?}", short_id(&uuid), e);
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
                    debug!("TcpBroadcast[{}] flush err {:?}", short_id(&uuid), e);
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                // TCP 是字节流，丢消息会导致上层解析错乱 —— 不能像"可丢"那样继续。
                // 直接断开，让客户端重连并重新同步。
                error!(
                    "TcpBroadcast[{}] lagged {} msgs, closing (byte stream cannot lose data)",
                    short_id(&uuid), n
                );
                return;
            }
            Err(broadcast::error::RecvError::Closed) => {
                debug!("TcpBroadcast[{}] channel closed", short_id(&uuid));
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
