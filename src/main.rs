use std::borrow::Borrow;
use std::collections::HashMap;
use std::fmt::{format, Debug, Display};
use std::ops::{Add, AddAssign};
use std::ptr::null;
use std::{io, vec};
use std::io::prelude::*;
use std::io::{BufReader, BufWriter, Error};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::fs::{metadata, read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::RwLock;
use std::thread;
use std::time::Duration;

//use nix::unistd::Pid;
//use nix::sys::signal::{self,Signal};
use clap::{App, Arg};
use libc::{self, size_t};

use base64::encode;
use libc::setbuf;
use sha1::digest::impl_write;
use sha1::{Digest, Sha1};
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
                    debug!("new Req thread started");
                    handle(_stream);
                    debug!("handle Req thread ended");
                });
            }
            Err(e) => {
                error!("Tcp handle erro {:?}", e)
            }
        };
    }

    pub trait Req {
        fn read(&self, data: &mut Vec<u8>) -> Result<usize, io::Error>;
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
        fn read(&self, data: &mut Vec<u8>) -> Result<usize, std::io::Error> {
            if let Some(content_length) = self.env().get("Content-Length") {
                if let Ok(length) = content_length.parse::<usize>() {
                    if let Ok(req_readed_size) = self.req_readed_size.read() {
                        if length.eq(&req_readed_size) {
                            return Ok(0);
                        }
                    }
                }
            } else {
                debug!("no Content-Length Header set; read 0");
                return Ok(0);
            }
            //data.resize(self.req_buffer_size, 0);
            let rst = self.req_reader.write().unwrap().read(data);
            if let Ok(len) = rst {
                self.req_readed_size.write().unwrap().add_assign(len);
            }
            return rst;
        }
        fn write(&self, data: &[u8]) -> Result<usize, std::io::Error> {
            BufWriter::new(self.req_stream.try_clone().unwrap()).write(data)
        }
        fn close(&self) -> Result<(), std::io::Error> {
            BufWriter::new(self.req_stream.try_clone().unwrap()).flush();
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
        fn write_with_h1(&self, h1: u8, data: &[u8]) -> io::Result<usize> {
            let mut writer = BufWriter::new(self.http.req_stream.try_clone().unwrap());
            let mut resp: Vec<u8> = Vec::new();
            let len = data.len();
            //h1 +fin+rsv1+rsv2+rsv3+opcode*4+
            //fin 1末尾包 0还有后续包
            //opcoce 4bit 0附加数据 1文本数据 2二进制数据 3-7保留为控制帧 8链接关闭 9ping apong b-f同3-7
            if h1 > 0 {
                resp.push(h1);
            } else {
                resp.push(0x81);
            }
            //h2 128 for mask bit
            if len < 126 {
                resp.push(len as u8);
            } else {
                if len > 125 && len < (1 << 16) {
                    resp.push(126);
                    // 2byte
                    resp.push((len >> 8) as u8);
                    resp.push(len as u8);
                } else {
                    if len > (1 << 16) - 1 {
                        resp.push(127);
                        // 8byte
                        (0..8).for_each(|v| resp.push((len >> 8 * (7 - v)) as u8))
                    }
                }
            }
            //mask
            //let _mask = [13u8, 9, 78, 108];
            //data
            return match writer.write(resp.as_slice()) {
                Ok(_) => {
                    let rst = writer.write(data);
                    writer.flush();
                    return rst;
                }
                Err(e) => Err(e),
            };
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
        fn read(&self, data: &mut Vec<u8>) -> Result<usize, std::io::Error> {
            let mut reader = BufReader::new(self.http.req_stream.try_clone().unwrap());
            //let mut load: Vec<u8> = Vec::new();
            let mut _mask = [0u8; 4];
            let mut _byte = [0u8; 1];
            //byte 1
            if let Ok(_) = reader.read(&mut _byte) {
                //println!(" > websocket byte one {:b}", _byte[0]);
                if 0b10001000 == _byte[0] {
                    // ctrl close
                    return Ok(0);
                }
                if 0b10001001 == _byte[0] {
                    // ctrl ping 0b1000-1010
                    self.write_with_h1(0b10001010, b"pong").unwrap();
                    debug!("Websocket wrote pong");
                    return self.read(data);
                }
                //byte 2
                if let Ok(_) = reader.read(&mut _byte) {
                    //println!(" websocket fram byte 2 {:b}", _byte[0]);
                    let _length = match _byte[0] & 0x7f {
                        n if n < 126 => n as usize,
                        n if n == 126 => {
                            //2byte
                            (0..2).fold(0usize, |a, v| {
                                while let Ok(_) = reader.read(&mut _byte) {
                                    return a + (_byte[0] as usize) << 8 * (1 - v);
                                }
                                return a;
                            })
                        }
                        n if n == 127 => {
                            //8byte
                            (0..8).fold(0usize, |a, v| {
                                if let Ok(_) = reader.read(&mut _byte) {
                                    return a + (_byte[0] as usize) << 8 * (7 - v);
                                }
                                return a;
                            })
                        }
                        _ => 0,
                    };
                    //println!("play load  len {}", _length);
                    //mask 4byte
                    if let Ok(_) = reader.read(&mut _mask) {
                        //println!("get mask {:?}", _mask);
                        //get playload
                        data.resize(_length, 0);
                        while let Ok(_) = reader.read(&mut data[.._length]) {
                            //unmask
                            for i in 0.._length {
                                data[i] = data[i] ^ _mask[i % 4];
                            }
                            return Ok(_length);
                        }
                    }
                }
            }
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "websocket read erro",
            ));
        }

        fn write(&self, data: &[u8]) -> Result<usize, Error> {
            self.write_with_h1(0, data)
        }

        fn close(&self) -> Result<(), Error> {
            self.http.req_stream.shutdown(Shutdown::Both)
        }

        fn env(&self) -> &HashMap<String, String> {
            self.http.headers.borrow()
        }
    }

    fn parse_req(stream: TcpStream) -> Box<dyn Req + Send + Sync> {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut writer = BufWriter::new(stream.try_clone().unwrap());
        let mut buffer = String::new();
        let mut http = Http {
            req_method: String::from("GET"),
            req_path: String::from("/"),
            req_version: String::from(""),
            headers: HashMap::from([(String::from("req_body_method"), String::from("HTTP")), (String::from("Req_Buffer_Size"), String::from("256"))]),
            req_reader: RwLock::new(reader),
            req_writer: RwLock::new(writer),
            req_stream: stream,
            req_buffer_size: 256,
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
        let mut restful_argv:Vec<String> = [http.headers.get("req_path").unwrap().to_string()].to_vec();
        parse_req_path(&mut restful_argv);
        http.headers.insert(String::from("req_script_path"), restful_argv[0].to_string());
        if restful_argv.len() > 1 {
            restful_argv.remove(0);
            restful_argv.reverse();
            restful_argv.iter().enumerate().for_each(|(i,v)| {
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
                    return;
                }
                if script_file_path.is_dir() {
                    //文件存在 是文件夹 指向当下的 index ok return
                    script_file_path.push("index");
                    parse_path[0] = script_file_path.to_str().unwrap().to_string();
                    debug!("script_file_path dir while= {:?}", script_file_path);
                    return;
                }
            }
        }
        debug!("script_file_path while end= {:?}", script_file_path);
    }
    fn call_script(req: Box<(dyn Req + Send + Sync)>) {
        let BUFFER_SIZE = req.env().get("Req_Buffer_Size").unwrap().parse::<usize>().unwrap_or_else(|e| 256);
        if let Some(req_path) = req.env().get("req_script_path") {
            info!("Req [{}]", req_path);
            let mut script = Command::new(format!(".{}", req_path.replacen(WDIR.read().unwrap().as_str(),"",1)));
            script.current_dir(WDIR.read().unwrap().as_str());
            //let mut env = req.env().clone();
            script.env_clear().envs(req.env()).stdin(Stdio::piped()).stdout(Stdio::piped());
            debug!("OS EXEC [{}][{}]",script.get_current_dir().unwrap().to_string_lossy(),script.get_program().to_string_lossy());
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
                            while let Ok(len) = req_read.read(&mut buffer) {
                                debug!("tcpStream read len [{}] [{:?}]", len, String::from_utf8_lossy(&buffer[..len]));
                                //debug!("tcpStream read len [{}]",len);
                                if len > 0 {
                                    if let Err(e) = stdin.write(&buffer[..len]) {
                                        error!("script stdin write thread {:?} break", e);
                                        break;
                                    }
                                    debug!("script stdin write [{}]",len);
                                    if let Err(e) = stdin.flush() {
                                        error!("script stdin write thread flush erro {:?}; break", e);
                                        //drop(stdin);
                                        break;
                                    }
                                    // test
                                    // if req_body_method.eq("WEBSOCKET") {
                                    //     stdin.write(&[0x0]).unwrap();
                                    //     stdin.flush().unwrap();
                                    //     debug!(">>>>>>>>>>>>>>>>>>>> : write [] done");
                                    // }
                                    buffer.clear();
                                } else {
                                    debug!("script stdin thread tcpStream read data len 0; break");

                                    break;
                                }
                            }
                        }
                    });
                    //
                    if let Some(mut stdout) = script_stdout {
                        let mut buffer = Vec::new();
                        buffer.resize(BUFFER_SIZE, 0);
                        while let Ok(len) = stdout.read(&mut buffer) {
                            debug!("script stdout read len [{}] [{:?}]", len, String::from_utf8_lossy(&buffer[..len]));
                            //debug!("script stdout read len [{}]", len);
                            if len > 0 {
                                if let Err(e) = req_write.write(&buffer[..len]) {
                                    error!("script stdout write tcpStream  erro; break");
                                    break;
                                }
                                debug!("script stdout write tcpStream  [{}]",len);
                            } else {
                                // 正常退出， 脚本退出后读取不到
                                debug!("script stdout read data len 0; break");
                                break;
                            }
                        }
                        debug!("script stdout read end");
                    }

                    //script_stdin_thread.join().unwrap();
                    // kill thread
                    // kill script
                    if let Err(e) = child.kill() {
                        error!("script kill erro {:?}", e)
                    }
                    if let Ok(code) = child.wait() {
                        debug!("script kill done [{:?}]",code);
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
        println!("call start");
        call_script(parse_req(stream));
        println!("call end");
    }
}
