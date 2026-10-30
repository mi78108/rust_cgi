use crate::tcp_class::http_func::Http;
use crate::utils::core::{Handle, Req};
use crate::{debug, error};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::digest::{SHA1_FOR_LEGACY_USE_ONLY, digest};
use std::collections::HashMap;
use std::io::{Error, ErrorKind};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

const WEBSOCKET_MAGIC_KEY: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ═══════════════════════════════════════════════════════════════════
// WebSocket 协议 —— 总览
// ═══════════════════════════════════════════════════════════════════
//
// 本文件的结构：
//
//   常量区    FRAME_HEADER_LEN / FLAG_LAST / OP_* / DEFAULT_MAX_PAYLOAD
//   frame_head()           构造 WS 帧头（纯函数，发送侧唯一来源）
//   FrameAssembler  CGI → 客户端 的组帧状态（私有 4 字节长度前缀）
//   Websocket::read_head    解析**入站** WS 帧头（RFC 6455 标准帧）
//   Websocket::send_frame   写出**出站**完整 WS 帧（fin=1）
//   Websocket::send_fragmented  写出**出站**帧，payload 超限自动分片
//   Websocket::unmask       payload 解掩码
//   Req::read    WS → CGI   组 9 字节私有头
//   Req::write   CGI → WS   拆 4 字节长度前缀 + 分片
//
// 本文件实现的是 **RFC 6455** 的服务端侧，加上 spider 自己的两层私有协议：
//
//   浏览器 ──标准 WS 帧──> spider ──[9字节私有头]──> CGI 子进程
//   浏览器 <──标准 WS 帧── spider <──[4字节长度前缀]── CGI 子进程
//
// ── 方向一：客户端 → 服务器（标准 WS 帧）──────────────────────────
//
//   帧结构（RFC 6455 §5.2）：
//
//     byte0   : FIN(1) RSV1(1) RSV2(1) RSV3(1) OPCODE(4)
//     byte1   : MASK(1) LEN(7)
//     byte2.. : 长度扩展字节 + 4字节 mask key + payload
//
//   LEN 的三种编码形式：
//     0..125   → LEN 就是 payload 长度，后面没有扩展字节
//     126      → 后跟 2 字节无符号大端长度（126..65535）
//     127      → 后跟 8 字节无符号大端长度（>=65536）
//
//   MASK 位：客户端发往服务器的帧**必须**置 1（RFC 6455 §5.1），
//   payload 逐字节与 4 字节 mask key 异或：
//       masked[i] = raw[i] ^ mask[i % 4]
//   服务器发往客户端的帧**必须**置 0（不掩码）。
//
// ── 方向二：服务器 → 客户端（标准 WS 帧）──────────────────────────
//
//   同上，但 MASK=0（服务器发帧不掩码）。
//
//   payload 超过 DEFAULT_MAX_PAYLOAD（64KB）时**自动分片**：
//     首片   opcode = TEXT/BIN, fin = 0
//     中间片 opcode = CONT(0x0), fin = 0
//     末片   opcode = CONT(0x0), fin = 1
//   客户端的 WebSocket API 会自动把分片拼回一条完整消息 —— JS 侧无感。
//
// ── 方向三：spider ↔ CGI 子进程（**私有协议**，非 RFC）────────────
//
//   CGI 的 STDIN/STDOUT 是**字节流**，不是消息流 —— 没有边界就粘包。
//   所以 spider 自己加了一层长度头。
//
//   spider → CGI（STDIN），每段 payload 前面带 **9 字节头**：
//
//     [len u32 BE][rem u32 BE][flags u8][payload]
//
//     len  = 本次这段 payload 有多少字节（子进程读这么多）
//     rem  = 整个 WS 帧的 payload 还剩多少（0 = 这一帧读完）
//     flags= 标志位，见下方 FLAG_* 定义
//
//     flags bit0 = 这是整个 WS 消息的最后一片（分片消息的末片）。
//     一个 WS 消息可能被拆成多个 WS 帧（分片），
//     每片单独带一个头，runtime 靠 FLAG_LAST 判断消息在哪里结束。
//     低位留给以后扩展（压缩标志等），未定义的位必须为 0。
//
//   CGI → spider（STDOUT），每条消息前面带 **4 字节长度前缀**：
//
//     [len u32 BE][payload]
//
//     Ruby 侧对应 `rsp.ws_write(data)` —— 它自动加这个前缀。
//     ★ 裸 `Q.write(json)` 会让 JSON 的前 4 字节被当成长度解析 → 帧错乱。
//
// ═══════════════════════════════════════════════════════════════════

/// spider → CGI 的 9 字节私有帧头长度
const FRAME_HEADER_LEN: usize = 9;

/// 单帧 payload 上限 —— 超过就自动分片（RFC 6455 §5.4）
///
/// 为什么是 64KB：
///   · 64KB 是个「肯定能塞进内核 socket 发送缓冲」的值 —— 单帧写出去
///     不用等对端读，不会卡住
///   · 也远小于 65536 —— 分片后每片的 LEN 用 2 字节形式就够，
///     不会退化成 8 字节长度字段（多 6 字节头）
///   · 实测 7.4MB 的 ops 帧按 64KB 分 = 113 片，实测全部送达
const DEFAULT_MAX_PAYLOAD: usize = 64 * 1024;

/// flags bit0 —— 本片是整个 WS 消息的最后一片
const FLAG_LAST: u8 = 0x01;

/// WS opcode
///
/// 0x0 续片（continuation）——  分片消息的后续片，沿用首片的 opcode
/// 0x1 文本（text）——        payload 是 UTF-8 文本
/// 0x2 二进制（binary）——    payload 是二进制数据
/// 0x8 关闭（close）——       连接关闭，payload 可带状态码+原因
/// 0x9 ping ——               探测对端存活，**必须**原样回 pong
/// 0xa pong ——               ping 的应答，payload 与对应 ping 相同
const OP_CONT: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BIN: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xa;

/// 构造一个 WS 帧头 —— 返回 (首字节, 长度字段缓冲区, 长度字段字节数)
///
///   首字节 = FIN(0x80) | RSV(0x70) | OPCODE(0x0f)
///     fin   = 1 完整帧 / 0 分片消息的非末片
///     rsv   = 恒为 0（没协商扩展）
///     op    = opcode 低 4 位
///
///   长度字段 = MASK(0) + LEN(7) + 可选的扩展长度字节
///     len < 126     → 1 字节：LEN 就是长度
///     len < 65536   → 3 字节：LEN=126 + 2 字节大端长度
///     len >= 65536  → 9 字节：LEN=127 + 8 字节大端长度
///
///   MASK 位恒为 0 —— 服务器发往客户端的帧不掩码（RFC 6455 §5.1）。
///
///   ★ 纯函数，不碰 socket —— 分片发送和单帧发送共用这一份帧头逻辑，
///     不会出现两边实现不一致的情况。
///
///   上界就是 usize::MAX —— usize 不可能 >= 2^64,
///   所以历史上的 `&& n < (2usize).pow(64)` 是死条件,
///   而且 (2usize).pow(64) 本身就溢出 (2^64 > usize::MAX):
///     debug build  -> panic (attempt to multiply with overflow)
///     release build -> 静默 wrap 成 0, 于是大帧永远落到
///                     FileTooLarge, 发不出去
fn frame_head(fin: bool, opcode: u8, len: usize) -> (u8, [u8; 10], usize) {
    let mut head = [0u8; 10];
    let head_len = match len {
        n if n < 126 => {
            head[0] = n as u8;
            1
        }
        n if n < (2usize).pow(16) => {
            head[0] = 126;
            head[1] = (n >> 8) as u8;
            head[2] = n as u8;
            3
        }
        n => {
            head[0] = 127;
            head[1..9].copy_from_slice(&n.to_be_bytes());
            9
        }
    };
    let b0 = ((fin as u8) << 7) | (opcode & 0x0f);
    (b0, head, head_len)
}

pub struct Websocket {
    /// 最近一次读到的数据帧 opcode（text/bin），写回客户端时用
    last_op: AtomicU8,
    base_on: Http,
    /// 当前帧已读入的 payload 字节数 —— 同时是 mask 偏移基准
    processed: AtomicUsize,
    /// 当前帧剩余 payload 字节数
    remainder: AtomicUsize,
    payload_mask: AtomicU32,
    /// CGI -> 客户端 的组帧状态
    outgoing: Mutex<FrameAssembler>,
    /// 当前是否处于分片消息中
    frag_active: AtomicBool,
    /// 当前帧是不是消息的最后一片（fin=1）。
    /// 存字段而不是局部变量：一帧 payload 可能跨多次 read() 才读完，
    /// 每次 read() 都要知道这一帧是不是消息末尾。
    frame_last: AtomicBool,
}

/// CGI -> 客户端 方向的组帧状态
///
/// CGI 写给客户端的每条消息格式是 [len u32 BE][payload]。
/// 一条消息可能被拆成多次写（pipe 的读块跟写入的块不对齐），
/// 所以长度前缀和 payload 都可能只到一半 —— 攒够一帧再发。
struct FrameAssembler {
    /// 还没解析的原始字节 —— 可能只有半个长度前缀
    buf: Vec<u8>,
    /// 当前帧的 payload 长度（None = 长度前缀还没读全）
    len: Option<usize>,
}

impl FrameAssembler {
    /// 把新到的字节并进来，切出所有**完整**帧的 payload；
    /// 切不出来的留在 buf 里等下次。
    fn take_frames(&mut self, raw: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(raw);
        // 一次性把 buffer 拿过来，最后只 drain 一次 ——
        // 逐帧 drain(..len) 会把剩下的字节反复前移，一帧一帧挪就是 O(n^2)。
        let mut buf = std::mem::take(&mut self.buf);
        let mut frames = Vec::new();
        let mut pos = 0usize;
        loop {
            // self.len 记着当前帧的 payload 长度；None = 长度前缀还没读全。
            // 先把 Option 拷出来 —— Option<usize> 是 Copy，
            // 这样下面的 self.len 赋值不会跟 match 的借用打架。
            let len = match self.len {
                Some(len) => len,
                None => {
                    // 长度前缀还没读全 —— pos 不动，这几个字节留给下次
                    if buf.len() - pos < 4 {
                        break;
                    }
                    let prefix: [u8; 4] = buf[pos..pos + 4].try_into().unwrap();
                    let len = u32::from_be_bytes(prefix) as usize;
                    pos += 4;
                    self.len = Some(len);
                    len
                }
            };
            if buf.len() - pos < len {
                // payload 还没收全 —— 剩下的留在 buf 里等下次。
                // 长度前缀已经被吃掉了，但 len 记在 self.len 里，信息不丢。
                break;
            }
            frames.push(buf[pos..pos + len].to_vec());
            pos += len;
            self.len = None;
        }
        if pos > 0 {
            buf.drain(..pos);
        }
        self.buf = buf;
        frames
    }
}

impl Websocket {
    /// 读一个 WS 帧头 —— 返回本帧 payload 字节数
    ///
    ///   None = close / EOF（连接结束）
    ///   Some(0) = 控制帧（ping）已处理，没有数据 payload
    ///   Some(len) = 数据帧，payload 有 len 字节
    ///
    /// mask key 在这里就地存进 payload_mask —— 读 payload 之前必须就位，
    /// unmask 靠它解密。
    ///
    /// ── 帧头解析 ─────────────────────────────────────────────────
    ///
    ///   byte0 = FIN(0x80) | RSV1-3(0x70) | OPCODE(0x0f)
    ///
    ///     fin = 这片是不是消息的最后一片
    ///     rsv = 保留位，必须为 0（没协商 permessage-deflate 之类的扩展）
    ///     op  = opcode: 0x0 续片 / 0x1 文本 / 0x2 二进制
    ///                    0x8 关闭 / 0x9 ping / 0xa pong
    ///
    ///   byte1 = MASK(0x80) | LEN(0x7f)
    ///
    ///     mask = 客户端发的帧恒为 1（RFC 6455 §5.1 强制要求）
    ///     len  = payload 长度，形式取决于取值：
    ///             <126     → 就是长度
    ///             ==126    → 后跟 2 字节大端长度
    ///             ==127    → 后跟 8 字节大端长度
    ///
    ///   之后是 4 字节 mask key（客户端→服务器必有），再往后是 payload。
    ///
    ///   payload 解密：masked[i] = raw[i] ^ mask[i % 4]
    ///   ★ 偏移必须**整体取模** —— 写成 mask[i % 4] 会在本帧
    ///     不是第一个读块时错位（RFC: mask 偏移跨读块连续）。
    ///
    /// ── 分片消息状态机 ───────────────────────────────────────────
    ///
    ///   客户端可以发一个消息被拆成多个 WS 帧：
    ///     首片   opcode = TEXT/BIN, fin = 0
    ///     中间片 opcode = CONT(0x0), fin = 0
    ///     末片   opcode = CONT(0x0), fin = 1
    ///
    ///   收到 CONT 但没有分片消息在途 → 协议错误。
    ///   RFC 6455 §5.5: 每个分片有**自己的** mask key，
    ///   偏移在本片内从 0 开始，不跨片连续。
    ///
    /// ── 控制帧 ───────────────────────────────────────────────────
    ///
    ///   ping  → 必须回 pong，且 payload 原样回显（RFC 6455 §5.5.2）
    ///   close → 回 close 后结束连接
    ///   控制帧的 payload 不交给 CGI，但**必须在这里读掉** ——
    ///   否则它留在 socket 里，下一轮会被当成帧头解析（desync）。
    ///
    ///   RFC 6455 §5.5 规定控制帧 payload 上限 125 字节且不能分片。
    ///   本实现**不做这个校验** —— 超长的控制帧照样读进来，
    ///   但正常客户端不会这么发。
    async fn read_head(&self) -> Result<Option<usize>, Error> {
        // 整个帧头在**同一次持锁**里读完 —— 帧头是一个不可分割的整体，
        // 拆成多次抢锁去读没有意义。
        let mut reader = self.base_on.base_on.req_reader.lock().await;
        let mut bytes = [0u8; 2];
        if let Err(e) = reader.read_exact(&mut bytes).await {
            error!(
                "websocket read package length fail read bytes part1 {:?}",
                e
            );
            if e.kind() == ErrorKind::UnexpectedEof {
                return Ok(None);
            }
            return Err(e);
        }
        debug!("websocket read byte 1:{:b}", bytes[0]);
        debug!("websocket read byte 2:{:b}", bytes[1]);
        let count_bytes = |bytes: &[u8]| -> usize {
            bytes.iter().enumerate().fold(0usize, |a, (i, v)| {
                debug!(" websocket read byte 8 * {} - {}  - 1", bytes.len(), i);
                a + ((*v as usize) << (8 * (bytes.len() - 1 - i)))
            })
        };
        //part2 byte 1 [+mask,+++++++load len ]
        let length_rst: Result<usize, Error> = match bytes[1] & 0x7f {
            n if n < 126 => Ok(n as usize),
            //2byte
            n if n == 126 => {
                let mut bytes = [0u8; 2];
                reader
                    .read_exact(&mut bytes)
                    .await
                    .and(Ok(count_bytes(&bytes)))
            }
            n if n == 127 => {
                //8byte
                let mut bytes = [0u8; 8];
                reader
                    .read_exact(&mut bytes)
                    .await
                    .and(Ok(count_bytes(&bytes)))
            }
            _ => Err(Error::new(ErrorKind::InvalidData, "invalid data")),
        };
        let length: usize = match length_rst {
            Ok(len) => len,
            Err(e) => {
                error!(
                    "websocket read package length fail read bytes part2  {:?}",
                    e
                );
                return Err(e);
            }
        };
        debug!("websocket read package length {}", length);
        //debug!(" websocket read pack len {}", length);
        //part3 mask 4byte
        let mut plymask = [0u8; 4];
        if let Err(e) = reader.read_exact(&mut plymask).await {
            error!(
                "websocket read package payload fail read bytes mask {:?}",
                e
            );
            return Err(e);
        }
        debug!("websocket read package mask {:?}", plymask);
        // ★ mask key 就地存好 —— 接下来读 payload 时 unmask 靠它解密。
        //   存进 payload_mask 而不是往外传，读 payload 之前它必须就位。
        self.payload_mask
            .store(u32::from_be_bytes(plymask), Ordering::Relaxed);
        // frame read done
        //
        // 首字节 = fin(0x80) | rsv(0x70) | opcode(0x0f)
        //   fin  = 这片是不是消息的最后一片
        //   rsv  = 保留位, 必须为 0 (没协商扩展的话)
        //   op   = opcode: 0x0 续片 / 0x1 文本 / 0x2 二进制 / 0x8 关闭 / 0x9 ping
        let fin = bytes[0] & 0x80 != 0;
        let rsv = bytes[0] & 0x70;
        let op = bytes[0] & 0x0f;
        if rsv != 0 {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "websocket rsv bits set, 没有协商扩展",
            ));
        }
        debug!("websocket frame fin={} op={:#x}", fin, op);
        // 这一帧是不是消息最后一片 —— 存字段，因为一帧 payload 可能跨多次 read()
        self.frame_last.store(fin, Ordering::Release);
        match op {
            OP_TEXT | OP_BIN => {
                // 数据帧。fin=1 是完整消息；fin=0 是分片消息的首片。
                self.last_op.store(op, Ordering::Release);
                // 完整消息：mask 偏移从头开始
                // （mask 已在 read_head 里存入 payload_mask）
                self.processed.store(0, Ordering::Relaxed);
                if !fin {
                    // 分片首片：进入分片状态。
                    self.frag_active.store(true, Ordering::Release);
                }
                Ok(Some(length))
            }
            OP_CONT => {
                // 续片：必须处在分片消息中
                if !self.frag_active.load(Ordering::Acquire) {
                    return Err(Error::new(
                        ErrorKind::InvalidData,
                        "websocket continuation frame 但没有分片消息在途",
                    ));
                }
                if fin {
                    // 末片：消息结束
                    self.frag_active.store(false, Ordering::Release);
                }
                // RFC 6455 5.5: "Clients MUST choose a new masking key for each frame"
                //   -> 每个分片有自己的 mask key，偏移在本片内从 0 开始，
                //      不跨片连续，也不沿用首片的 key。
                self.processed.store(0, Ordering::Relaxed);
                Ok(Some(length))
            }
            OP_CLOSE => {
                //0x88 0x80 4byte_masking
                //ctrl close 0x8 0b10001000
                debug!("websocket ctrl close event");
                // 放掉读锁再写 —— 写 socket 期间不该占着读锁
                drop(reader);
                // 回 close 帧时对端可能已经走了，写失败不该 panic。
                if let Err(e) = self.send_frame(OP_CLOSE, &[]).await {
                    error!("websocket ctrl close write fail {:?}", e);
                }
                Ok(None)
            }
            OP_PING => {
                // ctrl ping 0x9 0b10001001
                // ctrl pong 0xA 0b10001010
                debug!("websocket ctrl ping event");
                // 控制帧的 payload 不交给 CGI，但必须在这里读掉，
                // 否则它会留在 socket 里，被下一轮当成帧头解析（desync）。
                // RFC 6455: pong 必须回显 ping 的 payload。
                let mut payload = vec![0u8; length];
                if length > 0 {
                    if let Err(e) = reader.read_exact(&mut payload).await {
                        error!("websocket ctrl ping read payload fail {:?}", e);
                        return Err(e);
                    }
                    // 客户端发来的帧是带 mask 的，回显前要先解 mask
                    let mask = u32::from_be_bytes(plymask).to_be_bytes();
                    for (i, b) in payload.iter_mut().enumerate() {
                        *b ^= mask[i % 4];
                    }
                }
                // 放掉读锁再写 —— 写 socket 期间不该占着读锁
                drop(reader);
                if let Err(e) = self.send_frame(OP_PONG, &payload).await {
                    error!("websocket ctrl pong write fail {:?}", e);
                }
                // 返回 len=Some(0) 表示"控制帧已处理，没有数据帧 payload"。
                // read() 见到 0 长度就提前返回 Some(0)，
                // call_bridge 见 read_len==0 走 continue，下一轮 read() 再读数据帧。
                Ok(Some(0))
            }
            _ => Err(Error::new(
                ErrorKind::InvalidData,
                "invalid data; 不支持的扩展协议",
            )),
        }
    }

    /// 往 socket 写一个完整的 WS 帧（fin=1，不分片）
    ///
    /// 数据帧（转发给客户端）和控制帧（pong/close）都走这里。
    /// 要发超过单帧上限的大 payload，用 send_fragmented。
    ///
    /// ── 帧头构造 ─────────────────────────────────────────────────
    ///
    ///   byte[0]  [+fin,+rsv1,+rsv2,+rsv3,++++opcode]
    ///   fin = 1; rsv1-3 保留
    ///   opcode 4bit 0附加数据 1文本数据 2二进制数据 3-7保留为控制帧 8链接关闭 9ping 0xApong b-f同3-7保留
    ///   0x00 连续帧，浏览器的WebSocket API一般不会收到该类型的操作码
    ///   0x01 文本帧，最常用到的数据帧类别之一，表示该帧的负载是一段文本(UTF-8字符流)
    ///   0x02 二进制帧，较常用到的数据帧类别之一，表示该帧的负载是二进制数据
    ///   0x03-0x07 保留帧，留给未来非控制帧扩展使用
    ///   0x08 关闭连接控制帧，表示要断开WebSocket连接，浏览器端调用close方法会发送0x08控制帧
    ///   0x09 ping帧，用于检测端点是否可用，暂未发现浏览器可以通过何种方法发送该帧
    ///   0x0A pong帧，用于回复ping帧，暂未发现浏览器可以发送此种类型的控制帧
    ///   0x0B-0x0F 保留帧，留作未来控制帧扩展使用
    ///   B1 = +fin+rsv1+rsv2+rsv3+opcode*4+
    ///   fin 1末尾包 0还有后续包
    ///
    ///   B2 = MASK(1) + LEN(7)
    ///   MASK 恒为 0 —— 服务器发往客户端的帧**不掩码**（RFC 6455 §5.1）。
    ///   代码里 head[0] 直接放 LEN 值、不置 0x80 位，就是这个意思。
    ///   LEN 三种形式：
    ///     len < 126       → LEN 就是长度（1 字节）
    ///     len < 65536     → LEN=126 + 2 字节大端长度（3 字节）
    ///     len >= 65536    → LEN=127 + 8 字节大端长度（9 字节）
    ///
    ///   所以实际写出的字节是：
    ///     [b0][LEN 形式][LEN 字节...][payload]
    ///      ^     ^
    ///      |     └─ head[0..head_len]，长度用哪种形式由 payload 大小决定
    ///      └─ FIN|RSV|OPCODE
    ///
    ///   这里收到的 opcode 是纯 opcode（不含 fin/rsv），统一在这里补上 fin=1。
    ///   send_frame 发的**永远是完整帧**（fin=1）。
    ///   要发分片消息用 send_fragmented —— 它内部复用同一个 frame_head。
    ///
    /// ── ★ 整帧在**同一次持锁**里写出去 —— 两个原因：─────────────────
    ///
    ///   1. 帧头和 payload 必须连续，中间不能插进别的帧。
    ///      原来头(1~3 次 write)和 payload(1 次 write) 各抢一次锁，
    ///      期间 pong/close 帧可能插进来 -> 帧被撕裂。
    ///
    ///   2. payload 必须**写满**。write() 只保证写一部分：
    ///      底层是 tokio BufWriter(8KB)，大 payload 走直通路径 =
    ///      单次 write() 系统调用，写多少完全看内核 socket 缓冲。
    ///      帧长超过 sndbuf 时 write() 静默少写，帧头声明的长度
    ///      和实际发出的字节数对不上 -> 客户端解析错位 -> 直接 RST。
    ///      write_all 内部循环补写直到写完。
    async fn send_frame(&self, opcode: u8, data: &[u8]) -> Result<usize, Error> {
        let len = data.len();
        debug!("websocket ready to write len {}", len);

        let (b0, head, head_len) = frame_head(true, opcode, len);
        let mut writer = self.base_on.base_on.req_writer.lock().await;
        writer.write_all(&[b0]).await?;
        writer.write_all(&head[..head_len]).await?;
        writer.write_all(data).await?;
        // 必须在这里 flush：控制帧(pong/close)没有别的出口，
        // 不 flush 的话会一直留在缓冲区，直到别的地方碰巧写数据才发出去。
        writer.flush().await?;
        drop(writer);
        Ok(len)
    }

    /// 写一个 payload，**超过 max_payload 就自动分片**
    ///
    ///   payload <= max_payload  → 一个完整帧（等价 send_frame）
    ///   payload >  max_payload  → 拆成多个帧：
    ///     首片   opcode = 原 opcode, fin = 0
    ///     中间片 opcode = CONT(0x0), fin = 0
    ///     末片   opcode = CONT(0x0), fin = 1
    ///
    /// 客户端的 WebSocket API 会自动把分片消息**拼回**一条完整消息，
    /// 所以对 JS 侧是透明的 —— 但**服务端**的读侧要认 CONT 帧
    /// （见 read_head 的分片状态机）。
    ///
    /// ★ 所有片在**同一次持锁**里写完 —— 这是必须的：
    ///   片与片之间如果插进了别的帧（比如 pong），客户端看到的
    ///   就是一个**交错**的消息流 —— 分片消息的边界就乱了。
    ///   （RFC 6455 §5.4 的消息完整性要求）
    ///
    /// 控制帧（opcode & 0x08 != 0）**不能分片** —— RFC 6455 §5.5
    /// 规定控制帧 payload 上限 125 字节。这里直接报错，
    /// 不做静默截断（截断会丢数据）。
    async fn send_fragmented(
        &self,
        opcode: u8,
        data: &[u8],
        max_payload: usize,
    ) -> Result<usize, Error> {
        // 控制帧不能分片 —— 也不允许超长
        if opcode & 0x08 != 0 {
            if data.len() > 125 {
                return Err(Error::new(
                    ErrorKind::InvalidInput,
                    "控制帧 payload 不能超过 125 字节，且不能分片",
                ));
            }
            return self.send_frame(opcode, data).await;
        }
        if max_payload == 0 {
            return Err(Error::new(ErrorKind::InvalidInput, "max_payload 必须 > 0"));
        }
        // 装得下 —— 不分片，直接一个完整帧
        if data.len() <= max_payload {
            return self.send_frame(opcode, data).await;
        }

        let len = data.len();
        let mut writer = self.base_on.base_on.req_writer.lock().await;
        let mut offset = 0usize;
        let mut first = true;
        while offset < len {
            let end = (offset + max_payload).min(len);
            let chunk = &data[offset..end];
            // 首片用原 opcode 且 fin=0；后续片用 CONT，末片 fin=1
            let (op, fin) = if first {
                (opcode, false)
            } else if end == len {
                (OP_CONT, true)
            } else {
                (OP_CONT, false)
            };
            let (b0, head, head_len) = frame_head(fin, op, chunk.len());
            writer.write_all(&[b0]).await?;
            writer.write_all(&head[..head_len]).await?;
            writer.write_all(chunk).await?;
            first = false;
            offset = end;
        }
        writer.flush().await?;
        drop(writer);
        debug!(
            "websocket fragmented write len {} into {} bytes chunks",
            len, max_payload
        );
        Ok(len)
    }

    /// 解 payload 的掩码 —— 原地 XOR
    ///
    ///   masked[i] = raw[i] ^ mask[i % 4]
    ///
    /// ★ 偏移必须**整体取模**：(read + i) % 4
    ///   - `read` = 本帧已经读入的字节数（跨多次 read 连续累计）
    ///   - 写成 mask[read + i % 4] 会在 read > 0 时取模结果错位，
    ///     极端情况下还越界 panic
    ///
    /// 一帧 payload 可能跨多次 read() 才读完（socket 缓冲不够时），
    /// 所以偏移要跨调用连续 —— 这就是 `processed` 字段的用途。
    fn unmask(&self, data: &mut [u8], len: usize) {
        let mask = self.payload_mask.load(Ordering::Relaxed).to_be_bytes();
        let read = self.processed.load(Ordering::Relaxed);
        for i in 0..len {
            // 掩码是 4 字节循环的，索引必须整体取模：(read + i) % 4
            // 写成 mask[read + i % 4] 会在 read > 0 时越界 panic。
            data[i] = data[i] ^ mask[(read + i) % 4];
        }
    }
}

impl Req for Websocket {
    /// 读一段 payload，产出 [len u32 BE][rem u32 BE][flags u8][payload]
    ///
    ///   len  = 本次读到的 payload 字节数（子进程读这么多）
    ///   rem  = 整个 WS 帧的 payload 还剩多少（0 = 这一帧读完）
    ///   flags= FLAG_LAST 表示本片是整个 WS 消息的最后一片
    ///
    /// 帧边界知识全部收在这里 —— call_bridge 只是把 read 出来的字节转发出去，
    /// 不需要理解 [len][rem][flags] 的含义，也不需要 remainder() 钩子。
    ///
    /// ── 为什么需要这层私有头 ─────────────────────────────────────
    ///
    ///   CGI 的 STDIN 是字节流。一条 WS 消息（比如 100KB 的 JSON）
    ///   会被 socket 切成任意大小的块，CGI 侧必须能还原边界，
    ///   否则两个消息粘在一起就解析出垃圾。
    ///
    /// ── len / rem / flags 三个字段怎么来的 ───────────────────────
    ///
    ///   len   = 本次 read() 实际读到的字节数（socket 给了多少）
    ///   rem   = 本帧 payload 还没读到的字节数
    ///          rem > 0 → 这帧还没读完，后面还有
    ///          rem == 0 → 这帧读完了
    ///   flags = FLAG_LAST 只在**两个条件同时成立**时置位：
    ///          · frame_last（这一帧的 fin=1）
    ///          · rem == 0（这一帧确实读完了）
    ///          rem > 0 时肯定不是消息末尾 —— 一帧都没读完呢。
    ///
    ///   ⚠️ `rem` 只描述「这一帧」，不跨帧累加 —— 分片消息的
    ///   「整体是否结束」看的是 flags & FLAG_LAST，不是 rem == 0。
    async fn read(&self, data: &mut [u8]) -> Result<Option<usize>, Error> {
        if self.remainder.load(Ordering::Relaxed) == 0 {
            match self.read_head().await? {
                None => {
                    // close / EOF
                    return Ok(None);
                }
                Some(0) => {
                    // 控制帧（ping）已处理，没有数据 payload。
                    // 交 0 长度给 call_bridge，它会 continue，下一轮再读数据帧。
                    return Ok(Some(0));
                }
                Some(len) => {
                    // mask 已经在 read_head 里存进 payload_mask 了
                    self.remainder.store(len, Ordering::Relaxed);
                }
            }
        }

        // payload 缓冲区：留出帧头的位置
        let body = &mut data[FRAME_HEADER_LEN..];

        if self.remainder.load(Ordering::Relaxed) > body.len() {
            self.base_on.read(body).await.and_then(|len_opt| {
                if let Some(len) = len_opt {
                    self.unmask(body, len);
                    self.processed.fetch_add(len, Ordering::Relaxed);
                    self.remainder.fetch_sub(len, Ordering::Relaxed);
                }
                Ok(len_opt)
            })
        } else {
            let residue = self.remainder.load(Ordering::Relaxed);
            let mut buffer = vec![0u8; residue];
            self.base_on.read(&mut buffer).await.and_then(|len_opt| {
                if let Some(len) = len_opt {
                    // 只拷实际读到的 len 字节；buffer 是按 residue 开的，
                    // 一次 read 不一定读满，直接拷整个 buffer 会长度不匹配 panic。
                    body[0..len].copy_from_slice(&buffer[0..len]);
                    self.unmask(body, len);
                    self.processed.fetch_add(len, Ordering::Relaxed);
                    self.remainder.fetch_sub(len, Ordering::Relaxed);
                }
                if let None = len_opt {
                    return Ok(Some(0));
                }
                Ok(len_opt)
            })
        }
        .map(|len_opt| {
            // 组帧：[len][rem][flags][payload]
            // len == 0 是 EOF（连接关闭），不是一帧 —— 不加头。
            if let Some(len) = len_opt {
                if len == 0 {
                    return Some(0);
                }
                let rem = self.remainder.load(Ordering::Relaxed);
                // 帧读完了才谈得上"消息最后一片"。
                // rem > 0 说明这帧还没读完，肯定不是消息末尾。
                let last = self.frame_last.load(Ordering::Relaxed);
                let flags = if last && rem == 0 { FLAG_LAST } else { 0 };
                data[0..4].copy_from_slice(&(len as u32).to_be_bytes());
                data[4..8].copy_from_slice(&(rem as u32).to_be_bytes());
                data[8] = flags;
                return Some(len + FRAME_HEADER_LEN);
            }
            len_opt
        })
    }

    /// CGI -> 客户端：把 CGI stdout 的 [len u32 BE][payload] 组帧后发出去
    ///
    ///   CGI 侧写的是 `[4字节长度][payload]`（Ruby 的 `rsp.ws_write` 加前缀），
    ///   这里把它还原成一帧一帧的标准 WS 帧发给客户端。
    ///
    ///   一条消息可能被拆成多次写（pipe 的读块跟写入的块不对齐），
    ///   长度前缀和 payload 都可能只到一半 —— 组帧器攒够一帧再发。
    ///
    ///   ★ 返回值是 data.len()（全部消费）—— 组帧器把没凑齐的尾巴
    ///     留在自己 buffer 里等下次，所以这里确实是全消费。
    ///     早期版本在「剩余不足 4 字节」时也返回 data.len()，
    ///     但那 1~3 个长度前缀字节实际被丢掉了 → 下一帧错位。
    ///
    ///   ★ 大 payload 自动分片（上限 DEFAULT_MAX_PAYLOAD = 64KB）：
    ///     一条消息超过 64KB 就拆成多个 WS 帧（首片 TEXT/BIN + 续片 CONT），
    ///     客户端的 WebSocket API 会自动拼回一条完整消息 —— JS 侧无感。
    ///     不分片的话，7.4MB 的 ops 帧就是单个 7.4MB 的 write()，
    ///     底层 BufWriter 直通路径下单次 write 只保证写一部分，
    ///     帧头声明的长度跟实际发出的字节数对不上 → 客户端解析错位 → RST。
    async fn write(&self, data: &[u8]) -> Result<usize, Error> {
        let frames = {
            let mut assembler = self.outgoing.lock().await;
            assembler.take_frames(data)
        };
        for frame in frames {
            let opcode = self.last_op.load(Ordering::Relaxed);
            self.send_fragmented(opcode, &frame, DEFAULT_MAX_PAYLOAD)
                .await?;
        }
        Ok(data.len())
    }

    async fn close(&self) -> Result<(), Error> {
        // 回一个 close 帧再断 —— send_frame 内部已经 flush。
        // 对端可能已经走了，写失败不影响关闭流程。
        if let Err(e) = self.send_frame(OP_CLOSE, &[]).await {
            debug!("websocket close frame write fail {:?}", e);
        }
        self.base_on.close().await
    }

    fn env(&self) -> &HashMap<String, String> {
        self.base_on.env()
    }
}

impl Handle<Http> for Websocket {
    // fn name() -> &'static str {
    //     "WEBSOCKET"
    // }

    async fn matches(stream: &Http) -> bool {
        if let Some(upgrade) = stream.env().get("upgrade") {
            if upgrade.to_lowercase() == "websocket" {
                return true;
            }
        }
        false
    }

    async fn handle(stream: Http) -> Result<Self, Error> {
        if let Some(sec_websocket_key) = stream.env().get("sec-websocket-key") {
            let hash = digest(
                &SHA1_FOR_LEGACY_USE_ONLY,
                format!("{}{}", sec_websocket_key, WEBSOCKET_MAGIC_KEY).as_bytes(),
            );

            let sec_websocket_accept = STANDARD.encode(&hash.as_ref());
            // switch resp
            let resp = format!(
                "HTTP/1.1 101 SWITCH\r\nServer: Rust Cgi\r\nConnection: upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {}\r\n\r\n",
                sec_websocket_accept
            );
            if stream.write(resp.as_bytes()).await.is_ok() {
                stream.base_on.req_writer.lock().await.flush().await?;
            }
        }
        Ok(Websocket {
            last_op: AtomicU8::new(OP_TEXT),
            base_on: stream,
            processed: AtomicUsize::new(0),
            remainder: AtomicUsize::new(0),
            payload_mask: AtomicU32::new(0),
            outgoing: Mutex::new(FrameAssembler {
                buf: Vec::new(),
                len: None,
            }),
            frag_active: AtomicBool::new(false),
            frame_last: AtomicBool::new(true),
        })
    }
}
