use std::borrow::Borrow;
use std::collections::HashMap;
use std::fmt::{format, Debug, Display};
use std::ops::{Add, AddAssign};
use std::ptr::null;
use std::{io, process, vec};
use std::io::prelude::*;
use std::io::{BufReader, BufWriter, Error, ErrorKind};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::fs::{metadata, read};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::RwLock;
use std::thread;
use std::thread::Thread;
use std::time::Duration;

//use nix::unistd::Pid;
//use nix::sys::signal::{self,Signal};
use clap::{App, Arg};
//use libc::{self, signal, size_t, SIGTERM};

use base64::encode;
//use libc::setbuf;
//use libc::kill;
//use libc::sighandler_t;

use sha1::digest::impl_write;
use sha1::{Digest, Sha1};
use sha1::digest::generic_array::typenum::Pow;

#[macro_use]
extern crate log;
#[macro_use]
extern crate lazy_static;


lazy_static! {
    static ref WDIR: RwLock<String> = RwLock::new(String::from("/tmp"));
}
// todo 
fn main() {
    env_logger::init();
    let matches = App::new("A WebService Program")
        .version("1.0")
        .author("mi78108@live.com>")
        .arg(
            Arg::with_name("workdir")
                .short("w")
                .long("workdir")
                .help("www work dir")
                .takes_value(true),
        )
        .arg(
            Arg::with_name("addr")
                .short("l")
                .long("localaddr")
                .help("bind address")
                .takes_value(true),
        )
        .get_matches();

    if let Some(wd) = matches.value_of("workdir") {
        if let Ok(mut _wwd) = WDIR.write() {
            _wwd.clear();
            _wwd.push_str(wd);
        };
        info!("set workdir [{}]", wd);
    }

    let addr = match matches.value_of("addr") {
        Some(_addr) => _addr,
        None => "0.0.0.0:8080",
    };

    let listener = TcpListener::bind(addr).expect(format!("bind {} erro", addr).as_str());
    info!("Listen on [{}] Work in [{}]", addr, WDIR.read().unwrap());
    for stream in listener.incoming() {
        match stream {
            Ok(_stream) => {
                std::thread::spawn(move || {
                    println!("call start new Req thread started");
                    handle(_stream);
                    println!("call end handle Req thread ended\r\n\r\n");
                });
            }
            Err(e) => {
                error!("Tcp handle erro {:?}", e)
            }
        };
    }

    pub trait Req {
        fn read(&self, data: &mut Vec<u8>) -> Result<Option<usize>, io::Error>;
        fn write(&self, data: &[u8]) -> Result<usize, io::Error>;
        fn close(&self) -> Result<(), std::io::Error>;
        fn env(&self) -> &HashMap<String, String>;
    }

    #[derive(Debug)]
    struct Http {
        req_path: String,
        req_method: String,
        req_version: String,
        req_stream: TcpStream,
        req_reader: RwLock<BufReader<TcpStream>>,
        req_writer: RwLock<BufWriter<TcpStream>>,
        req_buffer_size: usize,
        req_readed_size: RwLock<usize>,
        headers: HashMap<String, String>,
    }

    impl Display for Http {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "req_method {}\nreq_path {}\nreq_headers:\n{}\n\n", self.req_method, self.req_path, self.headers.iter().map(|(k, v)| {
                return format!(" {} -> {}\n", k, v)
            }).collect::<String>())
        }
    }

    impl Req for Http {
        fn read(&self, data: &mut Vec<u8>) -> Result<Option<usize>, std::io::Error> {
            if let Some(content_length) = self.env().get("Content-Length") {
                if let Ok(length) = content_length.parse::<usize>() {
                    if let Ok(req_readed_size) = self.req_readed_size.read() {
                        if length.eq(&req_readed_size) {
                            debug!("Http Content-Length: {} read end", req_readed_size);
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
                    self.req_readed_size.write().unwrap().add_assign(len);
                    Ok(Some(len))
                }
                Err(e) => {
                    Err(e)
                }
            }
        }
        fn write(&self, data: &[u8]) -> Result<usize, std::io::Error> {
            BufWriter::new(self.req_stream.try_clone()?).write(data)
        }
        fn close(&self) -> Result<(), std::io::Error> {
            BufWriter::new(self.req_stream.try_clone().unwrap()).flush()?;
            self.req_stream.shutdown(Shutdown::Both)
        }
        fn env(&self) -> &HashMap<String, String> {
            self.headers.borrow()
        }
    }

    struct Websocket {
        http: Http,
    }

    impl Websocket {
        fn write_with_h1(&self, head_byte_1: u8, data: &[u8]) -> io::Result<usize> {
            let mut writer = BufWriter::new(self.http.req_stream.try_clone()?);
            let mut resp: Vec<u8> = Vec::new();
            let len = data.len();
            //B1= +fin+rsv1+rsv2+rsv3+opcode*4+
            //fin 1末尾包 0还有后续包
            //opcode 4bit 0附加数据 1文本数据 2二进制数据 3-7保留为控制帧 8链接关闭 9ping 0xApong b-f同3-7保留
            resp.push(head_byte_1);
            //B2=  +mask+len*7
            //debug!("websocket ready to write len {}",data.len());
            match len {
                n if n < 126 => {
                    resp.push(len as u8)
                }
                n if n >= 126 && n < (2usize).pow(16) => {
                    resp.push(126);
                    // 2byte
                    resp.extend_from_slice(&[(len >> 8) as u8, len as u8]);
                }
                n if n >= (2usize).pow(16)  && n < (2usize).pow(64)=> {
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
            return writer.write(&resp).and_then(|len| {
                if let Err(e) = writer.flush() {
                    return Err(e);
                }
                return Ok(len);
            }).or_else(|e| Err(e))
        }
    }
    impl From<Http> for Websocket {
        fn from(mut http: Http) -> Self {
            debug!("Req upgrade to Websocket");
            if let Some(sec_websocket_key) = http.env().get("Sec-WebSocket-Key") {
                let mut hasher = Sha1::new();
                hasher.update(format!("{}258EAFA5-E914-47DA-95CA-C5AB0DC85B11", sec_websocket_key));
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
                error!("websocket read package length fail read bytes part1 {:?}",e);
                return Err(e);
            }
            debug!(" websocket read byte 1:{:b}",bytes[0]);
            debug!(" websocket read byte 2:{:b}",bytes[1]);
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
                _ => Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid data"))
            };
            if let Err(e) = length_rst {
                error!("websocket read package length fail read bytes part2  {:?}",e);
                return Err(e);
            }
            let length: usize = length_rst.unwrap();
            //println!("play load  len {}", length);
            //part3 mask 4byte
            let mut mask = [0u8; 4];
            if let Err(e) = reader.read_exact(&mut mask) {
                error!("websocket read package length fail read bytes mask {:?}",e);
                return Err(e);
            }
            //println!("get mask {:?}", _mask);
            //get play load
            debug!("Websocket read package length {}",length);
            data.resize(length, 0);
            if let Err(e) = reader.read_exact(data) {
                error!("websocket read package length fail read bytes:{} {:?}",length,e);
                return Err(e);
            }
            //unmask
            for i in 0..data.len() {
                data[i] = data[i] ^ mask[i % 4];
            }
            // frame read done
            //byte 1 [+fin,+rsv1,+rsv2,+rsv3,++++opcode]
            return match bytes[0] {
                // h  if h == 0b10000000 => {
                //     // con frame
                //     Some(Ok(length))
                // },
                h  if h == 0b10000010 => {
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
                    Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "connection closed"))
                }
                h if h == 0b10001001 => {
                    // ctrl ping 0x9 0b10001001
                    // ctrl pong 0xA 0b10001010
                    Ok(None)
                }
                _ => Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid data; 不支持的扩展协议")),
            };
        }

        fn write(&self, data: &[u8]) -> Result<usize, Error> {
            // 文本 末包
            self.write_with_h1(0x81, data)
        }

        fn close(&self) -> Result<(), Error> {
            self.http.req_stream.shutdown(Shutdown::Both)
        }

        fn env(&self) -> &HashMap<String, String> {
            self.http.headers.borrow()
        }
    }

    fn parse_req(stream: TcpStream) -> Box<dyn Req + Send + Sync> {
        let peer_addr = stream.peer_addr().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut writer = BufWriter::new(stream.try_clone().unwrap());
        let mut buffer = String::new();
        let mut http = Http {
            req_method: String::from("GET"),
            req_path: String::from("/"),
            req_version: String::from(""),
            headers: HashMap::from([
                (String::from("req_body_method"), String::from("HTTP")), 
                (String::from("Req_Buffer_Size"), String::from(format!("{}", 1024 * 128))),
                (String::from("Req_Peer_Addr"),String::from(format!("{}:{}",peer_addr.ip().to_string(),peer_addr.port()))),
                (String::from("Req_Peer_Ip"),String::from(format!("{}",peer_addr.ip().to_string()))),
                (String::from("Req_Peer_Port"),String::from(format!("{}",peer_addr.port()))),
            ]),
            req_reader: RwLock::new(reader),
            req_writer: RwLock::new(writer),
            req_stream: stream,
            req_buffer_size: 1024 * 128,
            req_readed_size: RwLock::new(0),
        };
        if let Ok(size) = http.req_reader.write().unwrap().read_line(&mut buffer) {
            let line = buffer.trim_matches(|c| c == '\n' || c == '\r');
            let mut rst = line.splitn(3, " ");
            if let Some(method) = rst.next() {
                http.req_method = method.to_string();
                http.headers.insert(String::from("req_method"), method.to_string());
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
        while let Ok(size) = http.req_reader.write().unwrap().read_line(&mut buffer) {
            let line = buffer.trim_matches(|c| c == '\n' || c == '\r');
            if line.is_empty() {
                if let Ok(_size) = http.headers.get("Req_Buffer_Size").unwrap().parse::<usize>() {
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
            http.headers.insert(String::from("req_path"), String::from(req_path));
        }
        if let Some(req_params) = path.next() {
            http.headers.insert(String::from("req_params"), String::from(req_params));
            // get param
            let mut params = req_params.split("&");
            while let Some(req_param_item) = params.next() {
                let mut req_item_kv = req_param_item.splitn(2, "=");
                if let Some(req_param_name) = req_item_kv.next() {
                    if let Some(req_param_value) = req_item_kv.next() {
                        http.headers.insert(format!("req_param_{}", req_param_name), String::from(req_param_value));
                    }
                }
            }
        }
        // parse restful argv
        let mut restful_argv: Vec<String> = [http.headers.get("req_path").unwrap().to_string()].to_vec();
        parse_req_path(&mut restful_argv);
        debug!("parseed req path {:?}",restful_argv);
        http.headers.insert(String::from("req_script_path"), restful_argv[0].to_string());
        if restful_argv.len() > 1 {
            restful_argv.remove(0);
            restful_argv.reverse();
            restful_argv.iter().enumerate().for_each(|(i, v)| {
                http.headers.insert(format!("req_argv_{}", i + 1), String::from(v));
                http.headers.insert(format!("req_param_argv_{}", i + 1), String::from(v));
            });
            http.headers.insert("req_argv_count".to_string(), restful_argv.len().to_string());
            http.headers.insert("req_argv_params".to_string(), restful_argv.join("/"));
        }
        debug!("restful_argv = {:?}", restful_argv);
        //Websocket
        if let Some(upgrade) = http.headers.get("Upgrade") {
            if upgrade.to_lowercase() == "websocket" {
                http.headers.insert(String::from("req_body_method"), String::from("WEBSOCKET"));
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
        let mut script_file_path = PathBuf::from(format!("{}{}", WDIR.read().unwrap(), req_path));
        debug!("script_file_path = {:?}", script_file_path);
        if script_file_path.exists() {
            if script_file_path.is_file() {
                debug!("script_file_path file= {:?}", script_file_path);
                //文件存在 并且是文件  ok return
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
                    //文件存在 并且是文件  ok return
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
    fn call_script(req: Box<(dyn Req + Send + Sync)>) {
        let BUFFER_SIZE = req.env().get("Req_Buffer_Size").unwrap().parse::<usize>().unwrap_or_else(|e| 1024 * 128);
        if let Some(req_path) = req.env().get("req_script_path") {
            info!("Req [{}]", req_path);
            let mut script = Command::new(format!(".{}", req_path.replacen(WDIR.read().unwrap().as_str(), "", 1)));
            script.current_dir(WDIR.read().unwrap().as_str());
            //let mut env = req.env().clone();
            script.env_clear().envs(req.env()).stdin(Stdio::piped()).stdout(Stdio::piped());
            debug!("OS EXEC [{}][{}] with {} pid {}",
                script.get_current_dir().unwrap().to_string_lossy(),
                script.get_program().to_string_lossy(),
                format!("{} {}",req.env().get("req_method").unwrap_or("".to_string().borrow()),req.env().get("req_body_method").unwrap_or("".to_string().borrow())),
                process::id()
            );
            match script.spawn() {
                Ok(mut child) => {
                    let req_body_method = req.env().get("req_body_method").unwrap().to_string();
                    //TRANS
                    let script_stdin = child.stdin.take();
                    let script_stdout = child.stdout.take();
                    let _req = Arc::new(req);
                    let req_read = _req.clone();
                    let req_write = _req.clone();


                    let script_stdin_thread = std::thread::spawn(move || {
                        // 读取请求，并传递给脚本程序
                        if let Some(mut stdin) = script_stdin {
                            let mut buffer = Vec::new();
                            buffer.resize(BUFFER_SIZE, 0);
                            // 按缓存读取内容，避免内存溢出
                            loop {
                                //while let Ok(len_opt) = req_read.read(&mut buffer) {
                                let len_rst = req_read.read(&mut buffer);
                                if let Ok(Some(len)) = len_rst {
                                    //debug!("tcpStream read len [{}] [{:?}]", len, String::from_utf8_lossy(&buffer[..len]));
                                    debug!("tcpStream read len [{}]", len);
                                    if len > 0 {
                                        if let Err(e) = stdin.write(&buffer[..len]) {
                                            error!("script stdin write thread {:?} break", e);
                                            break;
                                        }
                                        debug!("script stdin write [{}]",len);
                                        if let Err(e) = stdin.flush() {
                                            error!("script stdin write thread flush erro {:?}; break", e);
                                            break;
                                        }
                                        // fix 会引起 read 读取不到数据
                                        //buffer.clear();
                                    } else {
                                        debug!("script stdin thread tcpStream read data len 0; break");
                                        break;
                                    }
                                } else {
                                    // 忽略None， 直接再次读取
                                }
                                if let Err(e) = len_rst {
                                    // 读错误， 忽略并结束
                                    error!("tcpStream read erro [{:?}]", e);
                                    break;
                                }
                            }
                            //drop(stdin);
                            debug!("tcpStream read func end");
                        }
                    });
                    //drop(script_stdin_thread);
                    //
                    if let Some(mut stdout) = script_stdout {
                        let mut buffer = Vec::new();
                        buffer.resize(BUFFER_SIZE, 0);
                        loop {
                            //while let Ok(len) = stdout.read(&mut buffer) {
                            let len_rst = stdout.read(&mut buffer);
                            if let Ok(len) = len_rst {
                                //debug!("script stdout read len [{}] [{:?}]", len, String::from_utf8_lossy(&buffer[..len]));
                                debug!("script stdout read len [{}]", len);
                                if len > 0 {
                                    if let Err(e) = req_write.write(&buffer[..len]) {
                                        error!("script stdout write tcpStream  erro; break [{:?}]",e);
                                        break;
                                    }
                                    debug!("script stdout write tcpStream  [{}]",len);
                                } else {
                                    // 正常退出， 脚本退出后读取不到
                                    debug!("script stdout read data len 0; break");
                                    break;
                                }
                            }
                            if let Err(e) = len_rst {
                                error!("script stdout read erro [{:?}]", e);
                                break;
                            }
                        }
                        debug!("script stdout read func end");
                    }
                    // kill script
                    error!("script ready to kill {:?}", child.id());
                    if let Err(e) = child.kill() {
                        error!("script kill erro {:?}", e)
                    }
                    debug!("script kill done wait result");
                    if let Ok(code) = child.wait() {
                        debug!(">>> [{}] script kill done [{:?}]",_req.env().get("req_script_path").unwrap(),code);
                        if !code.success() {
                            error!("script exit erro [{:?}]",code);
                            _req.write(format!("HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/text\r\n\r\nscript panic [ {:?} ]", code).as_bytes()).unwrap();
                        }
                    }

                    if let Err(e) = _req.close() {
                        error!("tcpStream close erro {:?}",e);
                    } else {
                        debug!("tcpStream closed");
                    }
                }
                Err(e) => {
                    error!("script spawn  erro {:?}",e);
                    req.write(format!("HTTP/1.0 404 Not Found\r\nContent-Type: text/text\r\n\r\nscript spawn fail [ {} ]", e.to_string()).as_bytes()).unwrap();
                }
                // do something
            }
        }
    }

    fn handle(stream: TcpStream) {
        call_script(parse_req(stream));
    }
}
