use ring::digest::{digest, SHA1_FOR_LEGACY_USE_ONLY};
use base64::engine::general_purpose::STANDARD;
use crate::tcp_class::http_func::Http;
use crate::tcp_class::tcp_base::Req;
use std::{
    collections::HashMap,
    io::{Error, ErrorKind, Read, Write},
    ops::Add,
    process::id,
    sync::RwLock,
    thread::current,
};
use base64::Engine;

pub struct Websocket {
    base_on: Http,
    read: RwLock<usize>,
    residue: RwLock<usize>,
    payload_mask: RwLock<[u8; 4]>,
}

impl Websocket {
    fn read_head(&self) -> Result<(Option<usize>, [u8; 4]), Error> {
        let trdid = std::thread::current().id();
        let pid = std::process::id();
        let mut bytes = [0u8; 2];
        if let Err(e) = self
            .base_on
            .base_on
            .req_reader
            .write()
            .unwrap()
            .read_exact(&mut bytes)
        {
            error!(
                "<{:?}:{}> websocket read package length fail read bytes part1 {:?}",
                trdid, pid, e
            );
            if e.kind() == ErrorKind::UnexpectedEof {
                return Ok((None, [0u8; 4]));
            }
            return Err(e);
        }
        debug!("<{:?}:{}> websocket read byte 1:{:b}", trdid, pid, bytes[0]);
        debug!("<{:?}:{}> websocket read byte 2:{:b}", trdid, pid, bytes[1]);
        let count_bytes = |bytes: &[u8]| -> usize {
            bytes.iter().enumerate().fold(0usize, |a, (i, v)| {
                //debug!(" websocket read byte 8 * {} - {}  - 1",bytes.len(),i);
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
                    .write()
                    .unwrap()
                    .read_exact(&mut bytes)
                    .and(Ok(count_bytes(&bytes)))
            }
            n if n == 127 => {
                //8byte
                let mut bytes = [0u8; 8];
                self.base_on
                    .base_on
                    .req_reader
                    .write()
                    .unwrap()
                    .read_exact(&mut bytes)
                    .and(Ok(count_bytes(&bytes)))
            }
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid data",
            )),
        };
        if let Err(e) = length_rst {
            error!(
                "<{:?}:{}> websocket read package length fail read bytes part2  {:?}",
                trdid, pid, e
            );
            return Err(e);
        }
        let length: usize = length_rst.unwrap();
        debug!(
            "<{:?}:{}> websocket read package length {}",
            trdid, pid, length
        );
        //debug!(" websocket read pack len {}", length);
        //println!("play load  len {}", length);
        //part3 mask 4byte
        let mut plymask = [0u8; 4];
        if let Err(e) = self
            .base_on
            .base_on
            .req_reader
            .write()
            .unwrap()
            .read_exact(&mut plymask)
        {
            error!(
                "<{:?}:{}> websocket read package payload fail read bytes mask {:?}",
                trdid, pid, e
            );
            return Err(e);
        }
        debug!(
            "<{:?}:{}> websocket read package mask {:?}",
            trdid, pid, plymask
        );
        // frame read done
        match bytes[0] {
            // h  if h == 0b10000000 => {
            //     continus frame
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
                debug!("<{:?}:{}> websocket ctrl close event", trdid, pid);
                self.write_with_opcode(0b10001000, &[]).unwrap();
                //return Err(Error::from(ErrorKind::UnexpectedEof));
                Ok((None, plymask))
            }
            h if h == 0b10001001 => {
                // ctrl ping 0x9 0b10001001
                // ctrl pong 0xA 0b10001010
                debug!("<{:?}:{}> websocket ctrl ping event", trdid, pid);
                self.write_with_opcode(0b10001010, &[]).unwrap();
                Ok((Some(0), plymask))
            }
            _ => Err(Error::new(
                ErrorKind::InvalidData,
                "invalid data; 不支持的扩展协议",
            )),
        }
    }

    fn write_with_opcode(&self, opcode: u8, data: &[u8]) -> std::io::Result<usize> {
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
        if let Ok(_) = self.base_on.write(&[opcode]) {
            //B2=  +mask+len*7
            let len = data.len();
            debug!(
                "<{:?}:{}> websocket ready to write len {}",
                current().id(),
                id(),
                data.len()
            );
            match len {
                n if n < 126 => {
                    self.base_on.write(&[len as u8]).unwrap();
                }
                n if n >= 126 && n < (2usize).pow(16) => {
                    self.base_on.write(&[126]).unwrap();
                    // 2byte
                    self.base_on.write(&[(len >> 8) as u8, len as u8]).unwrap();
                }
                n if n >= (2usize).pow(16) && n < (2usize).pow(64) => {
                    self.base_on.write(&[127]).unwrap();
                    // 8byte
                    (0..=7).for_each(|v| {
                        self.base_on.write(&[(len >> 8 * (7 - v)) as u8]).unwrap();
                    });
                }
                _ => {
                    return Err(Error::from(ErrorKind::FileTooLarge));
                }
            };
        }
        //let _mask = [13u8, 9, 78, 108];  mask 服务器发送不需要
        //data
        self.base_on.base_on.write(data).and_then(|len| {
            self.base_on
                .base_on
                .req_writer
                .write()
                .unwrap()
                .flush()
                .unwrap();
            Ok(len)
        })
    }

    fn unmask(&self, data: &mut [u8], len: usize) {
        if let Ok(mask) = self.payload_mask.read() {
            if let Ok(read) = self.read.read() {
                for i in 0..len {
                    data[i] = data[i] ^ mask[read.add(i) % 4];
                }
            }
        }
    }
}

impl Req for Websocket {
    fn read(&self, data: &mut [u8]) -> Result<Option<usize>, std::io::Error> {
        if *self.residue.read().unwrap() == 0 {
            let header_rst = self.read_head().and_then(|(len_opt, mask)| {
                if let Some(len) = len_opt {
                    *self.read.write().unwrap() = 0;
                    *self.residue.write().unwrap() = len;
                    *self.payload_mask.write().unwrap() = mask;
                }
                Ok(len_opt)
            });
            if let Err(_) | Ok(None) = header_rst {
                return header_rst;
            }
        }
        if *self.residue.read().unwrap() > data.len() {
            return self.base_on.read(data).and_then(|len_opt| {
                if let Some(len) = len_opt {
                    self.unmask(data, len);
                    *self.read.write().unwrap() += len;
                    *self.residue.write().unwrap() -= len;
                }
                Ok(len_opt)
            });
        } else {
            let residue = *self.residue.read().unwrap();
            let mut buffer = vec![0u8; residue];
            return self.base_on.read(&mut buffer).and_then(|len_opt| {
                if let Some(len) = len_opt {
                    for i in 0..buffer.len() {
                        data[i] = buffer[i];
                    }
                    self.unmask(data, len);
                    *self.read.write().unwrap() += len;
                    *self.residue.write().unwrap() -= len;
                }
                Ok(len_opt)
            });
        }
    }

    fn write(&self, data: &[u8]) -> Result<usize, std::io::Error> {
        // 默认 文本末包
        self.write_with_opcode(0b10000001, data)
    }

    fn close(&self) -> Result<(), std::io::Error> {
        self.write_with_opcode(0b10001000, &[]).unwrap();
        self.base_on.close()
    }

    fn env(&self) -> &HashMap<String, String> {
        self.base_on.env()
    }
}

impl From<Http> for Websocket {
    fn from(value: Http) -> Self {
        debug!("Req upgrade to Websocket init");
        if let Some(sec_websocket_key) = value.env().get("Sec-WebSocket-Key") {
            let hash = digest(&SHA1_FOR_LEGACY_USE_ONLY, format!(
                "{}258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
                sec_websocket_key
            ).as_bytes());

            let sec_websocket_accept = STANDARD.encode(&hash.as_ref());
            // switch resp
            let resp = format!("HTTP/1.1 101 SWITCH\r\nServer: Rust Cgi\r\nConnection: upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {}\r\n\r\n", sec_websocket_accept);
            if let Ok(_) = value.write(resp.as_bytes()) {
                value.base_on.req_writer.write().unwrap().flush().unwrap();
                debug!("Websocket handshake finished");
            }
        }
        Websocket {
            base_on: value,
            read: RwLock::new(0),
            residue: RwLock::new(0),
            payload_mask: RwLock::new([0u8; 4]),
        }
    }
}
