use crate::tcp_class::tcp_base::Req;
use crate::WDIR;
use base64::encode;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fmt::Display;
use std::io::{BufRead, BufReader, BufWriter, Error, ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::ops::AddAssign;
use std::path::PathBuf;
use std::sync::RwLock;

#[derive(Debug)]
pub struct Http {
    req_path: String,
    req_method: String,
    req_version: String,
    pub req_stream: TcpStream,
    req_reader: RwLock<BufReader<TcpStream>>,
    req_writer: RwLock<BufWriter<TcpStream>>,
    req_buffer_size: usize,
    req_read_size: RwLock<usize>,
    headers: HashMap<String, String>,
}

impl Display for Http {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "req_method {}\nreq_path {}\nreq_headers:\n{}\n\n",
            self.req_method,
            self.req_path,
            self.headers
                .iter()
                .map(|(k, v)| { return format!(" {} -> {}\n", k, v) })
                .collect::<String>()
        )
    }
}

impl Req for Http {
    fn read(&self, data: &mut Vec<u8>) -> Result<Option<usize>, std::io::Error> {
        if let Some(content_length) = self.env().get("Content-Length") {
            if let Ok(length) = content_length.parse::<usize>() {
                if let Ok(req_read_size) = self.req_read_size.read() {
                    if length.eq(&req_read_size) {
                        debug!("Http Content-Length: {} read end", req_read_size);
                        return Ok(Some(0));
                    }
                }
            }
        } else {
            debug!("no Content-Length Header set; read 0");
            return Ok(Some(0));
        }
        //data.resize(self.req_buffer_size, 0);
        match self.req_reader.write().unwrap().read(data) {
            Ok(len) => {
                self.req_read_size.write().unwrap().add_assign(len);
                Ok(Some(len))
            }
            Err(e) => Err(e),
        }
    }
    fn write(&self, data: &[u8]) -> Result<usize, std::io::Error> {
        //BufWriter::new(self.req_stream.try_clone()?).write(data)
        self.req_writer.write().unwrap().write(data)
    }
    fn close(&self) -> Result<(), std::io::Error> {
        //BufWriter::new(self.req_stream.try_clone().unwrap()).flush()?;
        self.req_writer.write().unwrap().flush()?;
        self.req_stream.shutdown(Shutdown::Both)
    }
    fn env(&self) -> &HashMap<String, String> {
        &self.headers
    }
}

pub fn parse_req(stream: TcpStream) -> Box<dyn Req + Send + Sync> {
    let peer_addr = stream.peer_addr().unwrap();
    let reader = BufReader::new(stream.try_clone().unwrap());
    let writer = BufWriter::new(stream.try_clone().unwrap());
    let mut buffer = String::new();
    let mut http = Http {
        req_method: String::from("GET"),
        req_path: String::from("/"),
        req_version: String::from(""),
        headers: HashMap::from([
            (String::from("req_body_method"), String::from("HTTP")),
            (
                String::from("Req_Buffer_Size"),
                String::from(format!("{}", 1024 * 128)),
            ),
            (
                String::from("Req_Peer_Addr"),
                String::from(format!(
                    "{}:{}",
                    peer_addr.ip().to_string(),
                    peer_addr.port()
                )),
            ),
            (
                String::from("Req_Peer_Ip"),
                String::from(format!("{}", peer_addr.ip().to_string())),
            ),
            (
                String::from("Req_Peer_Port"),
                String::from(format!("{}", peer_addr.port())),
            ),
        ]),
        req_reader: RwLock::new(reader),
        req_writer: RwLock::new(writer),
        req_stream: stream,
        req_buffer_size: 1024 * 128,
        req_read_size: RwLock::new(0),
    };
    if let Ok(_size) = http.req_reader.write().unwrap().read_line(&mut buffer) {
        let line = buffer.trim_matches(|c| c == '\n' || c == '\r');
        let mut rst = line.splitn(3, " ");
        if let Some(method) = rst.next() {
            http.req_method = method.to_string();
            http.headers
                .insert(String::from("req_method"), method.to_string());
        };
        if let Some(path) = rst.next() {
            http.req_path = path.to_string();
        };
        if let Some(version) = rst.next() {
            http.req_version = version.to_string();
        };
        buffer.clear();
    }
    // Header
    while let Ok(_size) = http.req_reader.write().unwrap().read_line(&mut buffer) {
        let line = buffer.trim_matches(|c| c == '\n' || c == '\r');
        if line.is_empty() {
            if let Ok(_size) = http
                .headers
                .get("Req_Buffer_Size")
                .unwrap()
                .parse::<usize>()
            {
                http.req_buffer_size = _size
            }
            break;
        }
        let mut head = line.splitn(2, ":");
        if let Some(req_head_name) = head.next() {
            if let Some(req_head_value) = head.next() {
                http.headers.insert(
                    String::from(req_head_name),
                    String::from(String::from(req_head_value).trim_start()),
                );
            }
        }
        buffer.clear();
    }

    //
    // parse_path_params
    let mut path = http.req_path.splitn(2, "?");
    if let Some(req_path) = path.next() {
        http.headers
            .insert(String::from("req_path"), String::from(req_path));
    }
    if let Some(req_params) = path.next() {
        http.headers
            .insert(String::from("req_params"), String::from(req_params));
        // get param
        let mut params = req_params.split("&");
        while let Some(req_param_item) = params.next() {
            let mut req_item_kv = req_param_item.splitn(2, "=");
            if let Some(req_param_name) = req_item_kv.next() {
                if let Some(req_param_value) = req_item_kv.next() {
                    http.headers.insert(
                        format!("req_param_{}", req_param_name),
                        String::from(req_param_value),
                    );
                }
            }
        }
    }
    // parse restful argv
    let mut restful_argv: Vec<String> =
        [http.headers.get("req_path").unwrap().to_string()].to_vec();
    parse_req_path(&mut restful_argv);
    debug!("parse req path {:?}", restful_argv);
    http.headers
        .insert(String::from("req_script_path"), restful_argv[0].to_string());
    if restful_argv.len() > 1 {
        restful_argv.remove(0);
        restful_argv.reverse();
        restful_argv.iter().enumerate().for_each(|(i, v)| {
            http.headers
                .insert(format!("req_argv_{}", i + 1), String::from(v));
            http.headers
                .insert(format!("req_param_argv_{}", i + 1), String::from(v));
        });
        http.headers
            .insert("req_argv_count".to_string(), restful_argv.len().to_string());
        http.headers
            .insert("req_argv_params".to_string(), restful_argv.join("/"));
    }
    debug!("restful_argv = {:?}", restful_argv);
    //Websocket
    if let Some(upgrade) = http.headers.get("Upgrade") {
        if upgrade.to_lowercase() == "websocket" {
            http.headers
                .insert(String::from("req_body_method"), String::from("WEBSOCKET"));
            return Box::new(Websocket::from(http));
        }
    }
    print!("{}", http);
    return Box::new(http);
}

fn parse_req_path(parse_path: &mut Vec<String>) {
    let mut req_path = parse_path.get(0).unwrap().to_string();
    // 特殊情况
    if req_path == "/" {
        req_path += "index"
    }
    let mut script_file_path = PathBuf::from(format!("{}{}", WDIR.get().unwrap(), req_path));
    debug!("script_file_path = {:?}", script_file_path);
    if script_file_path.exists() {
        if script_file_path.is_file() {
            debug!("script_file_path file= {:?}", script_file_path);
            //文件存在 并且是文件 ok return
            return;
        }
        if script_file_path.is_dir() {
            //文件存在 是文件夹 指向当下的 index ok return
            script_file_path.push("index");
            parse_path[0] = script_file_path.to_str().unwrap().to_string();
            debug!("script_file_path dir= {:?}", script_file_path);
            return;
        }
    }
    while !script_file_path.exists() {
        let argv = script_file_path.file_name().unwrap().to_str().unwrap();
        parse_path.push(argv.to_string());
        script_file_path.pop();
        //
        if script_file_path.exists() {
            if script_file_path.is_file() {
                //文件存在 并且是文件 ok return
                debug!("script_file_path file while= {:?}", script_file_path);
                parse_path[0] = script_file_path.to_str().unwrap().to_string();
                return;
            }
            if script_file_path.is_dir() {
                //文件存在 是文件夹 指向当下的 index ok return
                script_file_path.push("index");
                parse_path[0] = script_file_path.to_str().unwrap().to_string();
                debug!("script_file_path dir while= {:?}", script_file_path);
                parse_path[0] = script_file_path.to_str().unwrap().to_string();
                return;
            }
        }
    }
    debug!("script_file_path while end= {:?}", script_file_path);
}

pub struct Websocket {
    http: Http,
}

impl Websocket {
    fn write_with_h1(&self, head_byte_1: u8, data: &[u8]) -> std::io::Result<usize> {
        //let mut writer = BufWriter::new(self.http.req_stream.try_clone()?);
        let mut resp: Vec<u8> = Vec::new();
        let len = data.len();
        //B1= +fin+rsv1+rsv2+rsv3+opcode*4+
        //fin 1末尾包 0还有后续包
        //opcode 4bit 0附加数据 1文本数据 2二进制数据 3-7保留为控制帧 8链接关闭 9ping 0xApong b-f同3-7保留
        resp.push(head_byte_1);
        //B2=  +mask+len*7
        //debug!("websocket ready to write len {}",data.len());
        match len {
            n if n < 126 => resp.push(len as u8),
            n if n >= 126 && n < (2usize).pow(16) => {
                resp.push(126);
                // 2byte
                resp.extend_from_slice(&[(len >> 8) as u8, len as u8]);
            }
            n if n >= (2usize).pow(16) && n < (2usize).pow(64) => {
                resp.push(127);
                // 8byte
                (0..=7).for_each(|v| resp.push((len >> 8 * (7 - v)) as u8));
            }
            _ => {
                return Err(ErrorKind::FileTooLarge.into());
            }
        };
        //let _mask = [13u8, 9, 78, 108];  mask 服务器发送不需要
        //data
        resp.extend(data);
        let mut writer = self.http.req_writer.write().unwrap();
        writer.write(&resp).and_then(|len| writer.flush().and(Ok(len)) ).or_else(|e| Err(e))
    }
}
impl From<Http> for Websocket {
    fn from(http: Http) -> Self {
        debug!("Req upgrade to Websocket");
        if let Some(sec_websocket_key) = http.env().get("Sec-WebSocket-Key") {
            let mut hasher = Sha1::new();
            hasher.update(format!(
                "{}258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
                sec_websocket_key
            ));
            let sha1_key = hasher.finalize();
            let sec_websocket_accept = encode(sha1_key);
            // switch resp
            let resp = format!("HTTP/1.1 101 SWITCH\r\nServer: Hawk web\r\nConnection: upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {}\r\n\r\n", sec_websocket_accept);
            if let Ok(_) = http.write(resp.as_bytes()) {
                debug!("Websocket handshake finished");
            }
        }
        Websocket { http }
    }
}

impl Req for Websocket {
    fn read(&self, data: &mut Vec<u8>) -> Result<Option<usize>, std::io::Error> {
        let mut reader = BufReader::new(self.http.req_stream.try_clone().unwrap());
        let mut bytes = [0u8; 2];
        if let Err(e) = reader.read_exact(&mut bytes) {
            error!(
                "websocket read package length fail read bytes part1 {:?}",
                e
            );
            return Err(e);
        }
        debug!(" websocket read byte 1:{:b}", bytes[0]);
        debug!(" websocket read byte 2:{:b}", bytes[1]);
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
                reader.read_exact(&mut bytes).and(Ok(count_bytes(&bytes)))
            }
            n if n == 127 => {
                //8byte
                let mut bytes = [0u8; 8];
                reader.read_exact(&mut bytes).and(Ok(count_bytes(&bytes)))
            }
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid data",
            )),
        };
        if let Err(e) = length_rst {
            error!(
                "websocket read package length fail read bytes part2  {:?}",
                e
            );
            return Err(e);
        }
        let length: usize = length_rst.unwrap();
        //println!("play load  len {}", length);
        //part3 mask 4byte
        let mut mask = [0u8; 4];
        if let Err(e) = reader.read_exact(&mut mask) {
            error!("websocket read package length fail read bytes mask {:?}", e);
            return Err(e);
        }
        //println!("get mask {:?}", _mask);
        //get play load
        debug!("Websocket read package length {}", length);
        data.resize(length, 0);
        if let Err(e) = reader.read_exact(data) {
            error!(
                "websocket read package length fail read bytes:{} {:?}",
                length, e
            );
            return Err(e);
        }
        //unmask
        for i in 0..data.len() {
            data[i] = data[i] ^ mask[i % 4];
        }
        // frame read done
        //byte 1 [+fin,+rsv1,+rsv2,+rsv3,++++opcode]
        match bytes[0] {
            // h  if h == 0b10000000 => {
            //     // con frame
            //     Some(Ok(length))
            // },
            h if h == 0b10000010 => {
                // bin frame
                Ok(Some(length))
            }
            h if h == 0b10000001 => {
                // text frame
                Ok(Some(length))
            }
            h if h == 0b10001000 => {
                //0x88 0x80 4byte_masking
                //ctrl close 0x8 0b10001000
                Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionAborted,
                    "connection closed",
                ))
            }
            h if h == 0b10001001 => {
                // ctrl ping 0x9 0b10001001
                // ctrl pong 0xA 0b10001010
                Ok(None)
            }
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid data; 不支持的扩展协议",
            )),
        }
    }

    fn write(&self, data: &[u8]) -> Result<usize, Error> {
        // 文本 末包
        self.write_with_h1(0x81, data)
    }

    fn close(&self) -> Result<(), Error> {
        self.http.req_stream.shutdown(Shutdown::Both)
    }

    fn env(&self) -> &HashMap<String, String> {
        &self.http.headers
    }
}
