use crate::tcp_class::http_func::Http;
use crate::utils::core::{Handle, Req};
use crate::{debug, error};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ring::digest::{SHA1_FOR_LEGACY_USE_ONLY, digest};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{Error, ErrorKind, Write};
use std::sync::atomic::{AtomicU8, AtomicU32, AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::RwLock;

const WEBSOCKET_MAGIC_KEY: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// WS 帧头长度 —— 子进程 STDIN 里每段 payload 前面带的头
//
//   [len u32 BE][rem u32 BE][payload]
//
//   len = 本次这段 payload 有多少字节（子进程读这么多）
//   rem = 整个 WS 帧的 payload 还剩多少（0 = 这一帧读完）
//
// 子进程 STDIN 是字节流，靠这个头还原帧边界 —— 没有它就会粘包。
const FRAME_HEADER_LEN: usize = 8;

pub struct Websocket {
    last_op: AtomicU8,
    base_on: Http,
    processed: AtomicUsize,
    remainder: AtomicUsize,
    payload_mask: AtomicU32,
    payload_buffer: RwLock<Vec<u8>>,
    payload_remainder: AtomicUsize,
}

impl Websocket {
    async fn read_head(&self) -> Result<(Option<usize>, [u8; 4]), Error> {
        let mut bytes = [0u8; 2];
        if let Err(e) = self
            .base_on
            .base_on
            .req_reader
            .lock()
            .await
            .read_exact(&mut bytes)
            .await
        {
            error!(
                "websocket read package length fail read bytes part1 {:?}",
                e
            );
            if e.kind() == ErrorKind::UnexpectedEof {
                return Ok((None, [0u8; 4]));
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
                self.base_on
                    .base_on
                    .req_reader
                    .lock()
                    .await
                    .read_exact(&mut bytes)
                    .await
                    .and(Ok(count_bytes(&bytes)))
            }
            n if n == 127 => {
                //8byte
                let mut bytes = [0u8; 8];
                self.base_on
                    .base_on
                    .req_reader
                    .lock()
                    .await
                    .read_exact(&mut bytes)
                    .await
                    .and(Ok(count_bytes(&bytes)))
            }
            _ => Err(Error::new(ErrorKind::InvalidData, "invalid data")),
        };
        if let Err(e) = length_rst {
            error!(
                "websocket read package length fail read bytes part2  {:?}",
                e
            );
            return Err(e);
        }
        let length: usize = length_rst?;
        debug!("websocket read package length {}", length);
        //debug!(" websocket read pack len {}", length);
        //part3 mask 4byte
        let mut plymask = [0u8; 4];
        if let Err(e) = self
            .base_on
            .base_on
            .req_reader
            .lock()
            .await
            .read_exact(&mut plymask)
            .await
        {
            error!(
                "websocket read package payload fail read bytes mask {:?}",
                e
            );
            return Err(e);
        }
        debug!("websocket read package mask {:?}", plymask);
        // frame read done
        self.last_op.store(bytes[0], Ordering::Release);
        match bytes[0] {
            // h  if h == 0b10000000 => {
            //     continues frame
            //     Some(Ok(length))
            // },
            h if h == 0b10000010 => {
                // bin frame
                Ok((Some(length), plymask))
            }
            h if h == 0b10000001 => {
                // text frame
                Ok((Some(length), plymask))
            }
            h if h == 0b10001000 => {
                //0x88 0x80 4byte_masking
                //ctrl close 0x8 0b10001000
                debug!("websocket ctrl close event");
                self.write_with_opcode(0b10001000, &[]).await.unwrap();
                //return Err(Error::from(ErrorKind::UnexpectedEof));
                Ok((None, plymask))
            }
            h if h == 0b10001001 => {
                // ctrl ping 0x9 0b10001001
                // ctrl pong 0xA 0b10001010
                debug!("websocket ctrl ping event");
                self.write_with_opcode(0b10001010, &[]).await.unwrap();
                Ok((Some(0), plymask))
            }
            _ => Err(Error::new(
                ErrorKind::InvalidData,
                "invalid data; 不支持的扩展协议",
            )),
        }
    }

    async fn write_with_opcode(&self, opcode: u8, data: &[u8]) -> std::io::Result<usize> {
        // byte[0]  [+fin,+rsv1,+rsv2,+rsv3,++++opcode]
        // fin = 1; rsv1-3 保留
        // opcode 4bit 0附加数据 1文本数据 2二进制数据 3-7保留为控制帧 8链接关闭 9ping 0xApong b-f同3-7保留
        // 0x00 连续帧，浏览器的WebSocket API一般不会收到该类型的操作码
        // 0x01 文本帧，最常用到的数据帧类别之一，表示该帧的负载是一段文本(UTF-8字符流)
        // 0x02 二进制帧，较常用到的数据帧类别之一，表示该帧的负载是二进制数据
        // 0x03-0x07 保留帧，留作未来非控制帧扩展使用
        // 0x08 关闭连接控制帧，表示要断开WebSocket连接，浏览器端调用close方法会发送0x08控制帧
        // 0x09 ping帧，用于检测端点是否可用，暂未发现浏览器可以通过何种方法发送该帧
        // 0x0A pong帧，用于回复ping帧，暂未发现浏览器可以发送此种类型的控制帧
        // 0x0B-0x0F 保留帧，留作未来控制帧扩展使用
        // B1 = +fin+rsv1+rsv2+rsv3+opcode*4+
        // fin 1末尾包 0还有后续包
        if let Ok(_) = self.base_on.write(&[opcode]).await {
            //B2=  +mask+len*7
            let len = data.len();
            debug!("websocket ready to write len {}", data.len());
            match len {
                n if n < 126 => {
                    self.base_on.write(&[len as u8]).await?;
                }
                n if n >= 126 && n < (2usize).pow(16) => {
                    self.base_on.write(&[126]).await?;
                    // 2byte
                    self.base_on
                        .write(&[(len >> 8) as u8, len as u8])
                        .await
                        .unwrap();
                }
                n if n >= (2usize).pow(16) && n < (2usize).pow(64) => {
                    // 8byte
                    let mut len_bytes = [0u8; 9];
                    len_bytes[0] = 127;
                    len_bytes[1..9].copy_from_slice(&len.to_be_bytes());
                    self.base_on.write(&len_bytes).await?;
                    //self.base_on.write(&[127]).await.unwrap();
                    // (0..=7).for_each(|v| {
                    //     self.base_on.write(&[(len >> 8 * (7 - v)) as u8]).await.unwrap();
                    // });
                }
                _ => {
                    return Err(Error::from(ErrorKind::FileTooLarge));
                }
            }
            self.base_on.base_on.write(data).await
        } else {
            Err(Error::from(ErrorKind::WriteZero))
        }
        //let _mask = [13u8, 9, 78, 108];  mask 服务器发送不需要
        //data
        // self.base_on.base_on.write(data).await.and_then(|len| async move {
        //     self.base_on
        //         .base_on
        //         .req_writer
        //         .lock()
        //         .await
        //         .flush()
        //         .await
        //         .unwrap();
        //     Ok(len)
        // }).await;
    }

    fn unmask(&self, data: &mut [u8], len: usize) {
        // if let Ok(mask) = self.payload_mask.read() {
        //     if let Ok(read) = self.read.read() {
        //         for i in 0..len {
        //             data[i] = data[i] ^ mask[read.add(i) % 4];
        //         }
        //     }
        // }
        let mask = self.payload_mask.load(Ordering::Relaxed).to_be_bytes();
        let read = self.processed.load(Ordering::Relaxed);
        for i in 0..len {
            // 掩码是 4 字节循环的，索引必须整体取模：(read + i) % 4
            // 写成 mask[read + i % 4] 会在 read > 0 时越界 panic。
            data[i] = data[i] ^ mask[(read + i) % 4];
        }
    }

    async fn deliver_current_frame(&self) -> Result<usize, Error> {
        let len = self.payload_buffer.read().await.len();
        let payload: Vec<u8> = {
            let buf = self.payload_buffer.read().await;
            buf.clone()
        };
        self.write_with_opcode(self.last_op.load(Ordering::Relaxed), &payload)
            .await?;
        self.base_on
            .base_on
            .req_writer
            .lock()
            .await
            .flush()
            .await?;
        self.payload_buffer.write().await.clear();
        self.payload_remainder.store(0, Ordering::Relaxed);
        Ok(len)
    }
}

impl Req for Websocket {
    /// 读一段 payload，产出 [len u32 BE][rem u32 BE][payload]
    ///
    ///   len = 本次读到的 payload 字节数（子进程读这么多）
    ///   rem = 整个 WS 帧的 payload 还剩多少（0 = 这一帧读完）
    ///
    /// 帧边界知识全部收在这里 —— call_bridge 只是把 read 出来的字节转发出去，
    /// 不需要理解 [len][rem] 的含义，也不需要 remainder() 钩子。
    async fn read(&self, data: &mut [u8]) -> Result<Option<usize>, Error> {
        if self.remainder.load(Ordering::Relaxed) == 0 {
            let header_rst = self.read_head().await.and_then(|(len_opt, mask)| {
                if let Some(len) = len_opt {
                    self.processed.store(0, Ordering::Relaxed);
                    self.remainder.store(len, Ordering::Relaxed);
                    self.payload_mask
                        .store(u32::from_be_bytes(mask), Ordering::Relaxed);
                }
                Ok(len_opt)
            });
            if let Err(_) | Ok(None) = header_rst {
                return header_rst;
            }
        }

        // payload 缓冲区：留出 8 字节头的位置
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
            // 组帧：[len][rem][payload]
            // len == 0 是 EOF（连接关闭），不是一帧 —— 不加头。
            if let Some(len) = len_opt {
                if len == 0 {
                    return Some(0);
                }
                let rem = self.remainder.load(Ordering::Relaxed);
                data[0..4].copy_from_slice(&(len as u32).to_be_bytes());
                data[4..8].copy_from_slice(&(rem as u32).to_be_bytes());
                return Some(len + FRAME_HEADER_LEN);
            }
            len_opt
        })
    }

    async fn write(&self, data: &[u8]) ->Result<usize, Error> {
        let mut consumed = 0usize;

        // ---- 1. 补上次未收完的半帧 payload ----
        let mut rem = self.payload_remainder.load(Ordering::Relaxed);
        if rem > 0 {
            let take = rem.min(data.len() - consumed);
            {
                let mut buf = self.payload_buffer.write().await;
                buf.extend_from_slice(&data[consumed..consumed + take]);
            }
            consumed += take;
            rem -= take;
            self.payload_remainder.store(rem, Ordering::Relaxed);

            if rem > 0 {
                return Ok(data.len()); // 还是半帧，等下次
            }
            self.deliver_current_frame().await?; // 补齐，投递整帧
        }

        // ---- 2. 按整帧切分剩余 data ----
        while data.len() - consumed >= 4 {
            let len = u32::from_be_bytes(
                data[consumed..consumed + 4].try_into().unwrap(),
            ) as usize;
            let payload_start = consumed + 4;
            let available = data.len() - payload_start;

            if available < len {
                // 半帧：存已有 payload，记还差多少
                {
                    let mut buf = self.payload_buffer.write().await;
                    buf.clear();
                    buf.extend_from_slice(&data[payload_start..]);
                }
                self.payload_remainder
                    .store(len - available, Ordering::Relaxed);
                return Ok(data.len()); // 全部接纳
            }

            // 整帧：直接投递
            let frame = &data[payload_start..payload_start + len];
            self.write_with_opcode(self.last_op.load(Ordering::Relaxed), frame)
                .await?;
            self.base_on
                .base_on
                .req_writer
                .lock()
                .await
                .flush()
                .await?;

            consumed = payload_start + len;
        }

        // 剩余 < 4 字节（半个头）：不消费，交由调用方下次重传
        Ok(data.len())
    }





    // async fn write(&self, data: &[u8]) -> Result<usize, Error> {
    //     if data.len() > 4 {
    //         if self.payload_remainder.load(Ordering::Relaxed) == 0 {
    //             let value = u32::from_le_bytes(data[0..4].try_into().unwrap());
    //             //
    //             if data.len() - 4 >= value as usize {
    //
    //             }
    //             self.payload_remainder.store(value as usize, Ordering::Relaxed);
    //             self.payload_buffer.write().await.extend(&data[3..]);
    //             return Ok(data.len() - 3);
    //         }
    //     }else {
    //
    //     }
    //
    //     // 默认 文本末包hdu
    //     // let rst = if data[0] == 0b10000010 {
    //     //    self.write_with_opcode(0b10000010, &data[1..]).await
    //     // }else{
    //     //     self.write_with_opcode(0b10000001, data).await
    //     // };
    //     let rst = self
    //         .write_with_opcode(
    //             self.last_op.load(Ordering::Relaxed),
    //             self.payload_buffer.read().await.as_slice(),
    //         )
    //         .await;
    //     if rst.is_ok() {
    //         if let Err(_) = self.base_on.base_on.req_writer.lock().await.flush().await {
    //         } else {
    //             self.payload_buffer.write().await.clear();
    //             self.payload_remainder.store(0, Ordering::Relaxed);
    //         }
    //     };
    //     rst
    // }

    async fn close(&self) -> Result<(), Error> {
        if self.write_with_opcode(0b10001000, &[]).await.is_ok() {
            if let Err(_) = self.base_on.base_on.req_writer.lock().await.flush().await {}
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
            last_op: AtomicU8::new(0b10000001),
            base_on: stream,
            processed: AtomicUsize::new(0),
            remainder: AtomicUsize::new(0),
            payload_mask: AtomicU32::new(0),
            payload_buffer: RwLock::new(Vec::new()),
            payload_remainder: AtomicUsize::new(0),
        })
    }
}
