use std::collections::HashMap;
use std::io;
use std::io::prelude::*;
use std::io::{BufReader, BufWriter};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
// use std::ptr::metadata;
use std::fs::metadata;
use std::sync::Arc;
use std::sync::RwLock;
use std::thread;
use std::time::Duration;

//use nix::unistd::Pid;
//use nix::sys::signal::{self,Signal};
use clap::{App, Arg};
use libc;

use base64::encode;
use sha1::{Digest, Sha1};
#[macro_use]
extern crate log;
#[macro_use]
extern crate lazy_static;

struct Req {
    // _handle_script: RwLock<Option<std::process::Child>>,
    _stream_closed: RwLock<bool>,
    _stream: TcpStream,
    headers: HashMap<String, String>,
    reader: RwLock<BufReader<TcpStream>>,
    writer: RwLock<BufWriter<TcpStream>>,
}

impl Req {
    //fn new(reader: &mut BufReader<TcpStream>, writer: &mut BufWriter<TcpStream>) -> Req {
    fn new(stream: TcpStream) -> Req {
        let mut headers: HashMap<String, String> = HashMap::new();
        let mut reader = BufReader::new(stream.try_clone().expect("open readerBuf erro"));
        let mut writer = BufWriter::new(stream.try_clone().expect("open writerBuf erro"));
        //let mut script_handle: Option<std::process::Child> = None;

        let mut buffer = String::new(); //Vec::with_capacity(1024);
        if let Ok(_) = reader.read_line(&mut buffer) {
            let line = buffer.trim_matches(|c| c == '\n' || c == '\r');
            let mut req = line.splitn(3, " ");
            if let Some(req_method) = req.next() {
                headers.insert(String::from("req_method"), String::from(req_method));
            }
            if let Some(req_path) = req.next() {
                let mut path = req_path.splitn(2, "?");
                if let Some(req_path) = path.next() {
                    headers.insert(String::from("req_path"), String::from(req_path));
                }
                if let Some(req_param) = path.next() {
                    headers.insert(String::from("req_param"), String::from(req_param));
                    // get param
                    let mut param = req_param.split("&");
                    while let Some(req_param_item) = param.next() {
                        let mut req_item_kv = req_param_item.splitn(2, "=");
                        if let Some(req_param_name) = req_item_kv.next() {
                            if let Some(req_param_value) = req_item_kv.next() {
                                headers.insert(
                                    format!("req_param_{}", req_param_name),
                                    String::from(req_param_value),
                                );
                            }
                        }
                    }
                }
                headers.insert(String::from("req_body_method"), "HTTP".to_string());
            }
            if let Some(req_version) = req.next() {
                headers.insert(String::from("req_version"), String::from(req_version));
            }
            // Read Header
            buffer.clear();
            while let Ok(_) = reader.read_line(&mut buffer) {
                //println!("> [{}]", buffer);
                let line = buffer.trim_matches(|c| c == '\n' || c == '\r');
                if line.is_empty() {
                    break;
                }
                let mut head = line.splitn(2, ":");
                if let Some(req_head_name) = head.next() {
                    if let Some(req_head_value) = head.next() {
                        headers.insert(
                            String::from(req_head_name),
                            String::from(String::from(req_head_value).trim_start()),
                        );
                    }
                }
                buffer.clear();
            }
            debug!("req header {:?}", headers);
            // handle websocket
            if let Some(upgrade) = headers.get("Upgrade") {
                if upgrade.to_lowercase() == "websocket" {
                    debug!("Req upgrade to Websocket");
                    if let Some(sec_websocket_key) = headers.get("Sec-WebSocket-Key") {
                        let mut hasher = Sha1::new();
                        hasher.update(format!(
                            "{}258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
                            sec_websocket_key
                        ));
                        let sha1_key = hasher.finalize();
                        let sec_websocket_accept = encode(sha1_key);
                        // switch resp
                        let resp = format!("HTTP/1.1 101 SWITCH\r\nServer: Hawk web\r\nConnection: upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {}\r\n\r\n",sec_websocket_accept);
                        if let Ok(_) = writer.write(resp.as_bytes()) {
                            if let Ok(_) = writer.flush() {
                                //websocket
                                headers.insert(
                                    String::from("req_body_method"),
                                    "WEBSOCKET".to_string(),
                                );
                                debug!("Websocket handshake finished");
                            }
                        }
                    }
                }
            } // handle script
        }
        return Req {
            //_stream: RwLock::new(stream),
            _stream: stream,
            _stream_closed: RwLock::new(false),
            // _handle_script: RwLock::new(script_handle),
            headers: headers,
            reader: RwLock::new(reader),
            writer: RwLock::new(writer),
        };
    }

    fn get_current_target(&self) -> String {
        if let Some(req_path) = self.headers.get("req_path") {
            if cfg!(windows) {
                return String::from(req_path).replace("/", "\\");
            }
            //if cfg!(target_os = "macos" ) || cfg!(target_os = "linux") {
            // if req_path == "/" {
            //     return String::from("/index");
            // }
            return String::from(req_path);
        }
        return String::new();
    }

    fn read_from(&self, buffer: &mut Vec<u8>) -> io::Result<usize> {
        if let Some(method) = self.headers.get("req_body_method") {
            match method.as_str() {
                "WEBSOCKET" => return self.recv_websocket(buffer),
                "HTTP" => {
                    if let Some(length_s) = self.headers.get("Content-Length") {
                        if let Ok(length) = length_s.parse::<usize>() {
                            if length > 0 {
                                //let mut buffer = [0; 128];
                                buffer.resize(length, 0);
                                return self.recv(buffer);
                            }
                        }
                    }
                    //return Ok(0);
                    return Err(io::Error::new(io::ErrorKind::Other, "No Content-Lengt"));
                }
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("Unknow req_body_method {}", method),
                    ))
                }
            }
        }
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "No req_body_method",
        ));
    }

    fn send_to(&self, buffer: &[u8]) -> io::Result<usize> {
        if let Some(method) = self.headers.get("req_body_method") {
            match method.as_str() {
                "WEBSOCKET" => return self.send_websocket(0, buffer),
                "HTTP" => return self.send(buffer),
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("Unknow req_body_method {}", method),
                    ))
                }
            }
        }
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "No req_body_method",
        ));
    }

    fn send(&self, data: &[u8]) -> io::Result<usize> {
        if self.is_closed() {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "writer is closed",
            ));
        }
        if let Ok(mut writer) = self.writer.write() {
            return writer.write(data);
        }
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "writer RwLock write Erro",
        ));
    }

    fn close(&self) -> io::Result<()> {
        if let Ok(mut closed) = self._stream_closed.write() {
            if *closed {
                return Ok(());
            }
            let _flush = self.flush();
            if let Ok(_) = _flush {
                let _shutdown = self._stream.shutdown(std::net::Shutdown::Both);
                if let Ok(_) = _shutdown {
                    *closed = true;
                }
                return _shutdown;
            }
            return _flush;
        }
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "writer RwLock write Erro",
        ));
    }

    fn is_closed(&self) -> bool {
        if let Ok(closed) = self._stream_closed.read() {
            if *closed {
                return true;
            }
            return false;
        }
        return true;
    }

    fn recv(&self, data: &mut [u8]) -> io::Result<usize> {
        if self.is_closed() {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "reader Erro"));
        }
        if let Ok(mut reader) = self.reader.write() {
            return reader.read(data);
        }
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "reader RwLock write Erro",
        ));
    }

    fn flush(&self) -> io::Result<()> {
        if let Ok(mut writer) = self.writer.write() {
            return writer.flush();
        }
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "writer RwLock write Erro",
        ));
    }

    fn send_websocket(&self, h1: u8, data: &[u8]) -> io::Result<usize> {
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
        return match self.send(resp.as_slice()) {
            Ok(_) => self.send(data),
            Err(e) => Err(e),
        };
    }

    //fn recv_websocket(&self,reader:&mut BufReader<TcpStream>,data:&mut Vec<u8>) -> Result<usize,usize>{
    fn recv_websocket(&self, data: &mut Vec<u8>) -> io::Result<usize> {
        //let mut load: Vec<u8> = Vec::new();
        let mut _mask = [0u8; 4];
        let mut _byte = [0u8; 1];
        //byte 1
        if let Ok(_) = self.recv(&mut _byte) {
            //println!(" > websocket byte one {:b}", _byte[0]);
            if 0b10001000 == _byte[0] {
                // ctrl close
                return Ok(0);
            }
            if 0b10001001 == _byte[0] {
                // ctrl ping 0b1000-1010
                self.send_websocket(0b10001010, b"pong").unwrap();
            }
            //byte 2
            if let Ok(_) = self.recv(&mut _byte) {
                //println!(" websocket fram byte 2 {:b}", _byte[0]);
                let _length = match _byte[0] & 0x7f {
                    n if n < 126 => n as usize,
                    n if n == 126 => {
                        //2byte
                        (0..2).fold(0usize, |a, v| {
                            while let Ok(_) = self.recv(&mut _byte) {
                                return a + (_byte[0] as usize) << 8 * (1 - v);
                            }
                            return a;
                        })
                    }
                    n if n == 127 => {
                        //8byte
                        (0..8).fold(0usize, |a, v| {
                            if let Ok(_) = self.recv(&mut _byte) {
                                return a + (_byte[0] as usize) << 8 * (7 - v);
                            }
                            return a;
                        })
                    }
                    _ => 0,
                };
                //println!("play load  len {}", _length);
                //mask 4byte
                if let Ok(_) = self.recv(&mut _mask) {
                    //println!("get mask {:?}", _mask);
                    //get playload
                    data.resize(_length, 0);
                    while let Ok(_) = self.recv(&mut data[.._length]) {
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
}

fn resp_404(req: &Req) {
    let mut body = String::from("HTTP/1.1 404 NOT FOUND\r\n");
    body.push_str("Server: Hawk\r\n");
    body.push_str("\r\n");
    body.push_str("\r\n");
    body.push_str("404 Not Found\n");
    req.send(body.as_bytes()).unwrap();
    if let Err(e) = req.flush() {
        error!("resp 404 flush erro {:?}", e);
    }
}

fn handle(stream: TcpStream) {
    info!("TcpStream handled");
    stream.set_nodelay(true).unwrap();
    //stream.set_read_timeout(Some(Duration::new(60, 0))).unwrap();
    //stream.set_write_timeout(Some(Duration::new(60, 0))).unwrap();
    if let Ok(peer_addr) = stream.peer_addr() {
        info!("Tcp From {}:{}", peer_addr.ip(), peer_addr.port());
        let req = Arc::new(Req::new(stream));
        // Read body

        //let script_spawn = script.spawn();
        if let Some(_) = req.headers.get("req_path") {
            let mut script_path = req.get_current_target(); //format!("{}{}", WDIR.read().unwrap(), req.get_current_target());
            info!("Req [{}]", script_path);

            let script_file_path = format!("{}{}", WDIR.read().unwrap().as_str(), script_path);
            debug!(
                "test => {} -- {}",
                metadata(&script_file_path).is_ok(),
                &script_file_path
            );
            if let Ok(file) = metadata(&script_file_path) {
                if file.is_dir() {
                    script_path = format!("{}/index", script_path);
                }
            }
            debug!("EXEC [{}]", script_path);
            let mut script = Command::new(format!(".{}", script_path));
            script.current_dir(WDIR.read().unwrap().as_str());
            script.env_clear();
            script
                .envs(&req.headers)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped());
            //

            debug!(
                "OS EXEC [{}][{}]",
                script.get_current_dir().unwrap().to_string_lossy(),
                script.get_program().to_string_lossy()
            );
            match script.spawn() {
                Ok(mut child) => {
                    let mut _req_stdin = req.clone();
                    let mut _req_stdout = req.clone();

                    let script_stdin = child.stdin.take();
                    let script_stdout = child.stdout.take(); //= child.stdout;                  //

                    let _stdout_thread = std::thread::spawn(move || {
                        if let Some(mut stdout) = script_stdout {
                            let mut buffer = [0; 1024];
                            while let Ok(len) = stdout.read(&mut buffer) {
                                debug!(
                                    "script stdout read len [{}] [{:?}]",
                                    len,
                                    String::from_utf8_lossy(&buffer[..len])
                                );
                                //debug!("script stdout read len [{}]", len);
                                if len > 0 {
                                    if let Err(e) = _req_stdout.send_to(&buffer[..len]) {
                                        error!("script stdout send_to {:?}; break", e);
                                        break;
                                    }
                                    if let Err(e) = _req_stdout.flush() {
                                        error!("script stdout read {:?}; break", e);
                                        break;
                                    }
                                } else {
                                    debug!("script stdout read data len 0; break");
                                    // todo
                                    break;
                                }
                            }
                        }
                        debug!("script stdout read thread end");
                        debug!("close the tcpStream");
                        //std::thread::sleep(std::time::Duration::new(2,0));
                        if let Err(e) = _req_stdout.close() {
                            error!("script stdout close the tcpStream {:?}; break", e);
                        }
                    });
                    //
                     if let Some(mut stdin) = script_stdin {
                        let mut recv_len = 0;
                        let mut buffer = Vec::new();
                        //let _read = _req_stdin.read_from(&mut buffer);
                        while let Ok(len) = _req_stdin.read_from(&mut buffer) {
                            //debug!("tcpStream read len [{}]", len);
                            recv_len += len;
                            if len > 0 {
                                debug!(
                                    "script stdin write [{}] [{}]",
                                    len,
                                    String::from_utf8_lossy(&buffer[..len])
                                );
                                //debug!("script stdin write [{}]",len);

                                if let Err(e) = stdin.write(&buffer[..len]) {
                                    error!("script stdin write {:?} break", e);
                                    break;
                                }
                                if let Err(e) = stdin.flush() {
                                    error!("script stdin flush {:?}; break", e);
                                    break;
                                }
                                if let Some(content_length) =
                                    _req_stdin.headers.get("Content-Length")
                                {
                                    if let Ok(length) = content_length.parse::<usize>() {
                                        if length == recv_len {
                                            debug!("script stdin write done {:?}; break", length);
                                            break;
                                        }
                                    }
                                }
                            } else {
                                debug!("tcpStream read data len 0; break");
                                break;
                            }
                        }
                    }
                    // wait thread
                    if let Some(method) = _req_stdin.headers.get("req_body_method") {
                        if method == "HTTP" {
                            if let Err(e) = _stdout_thread.join() {
                                error!("script stdout read thread join erro {:?}", e)
                            }
                        }
                    }
                    //kill spawn
                    //if let Err(e) = child.kill() {
                    //if let Err(e) =  signal::kill(Pid::from_raw(child.id() as i32),Signal::SIGTERM) {
                    //if let Err(e) = child.kill() {
                    //     error!("script stdout thread kill erro {:?}", e)
                    // } else {
                    //     debug!("script stdout thread kill done")
                    // }
                    unsafe {
                        //
                        thread::sleep(Duration::from_millis(1000));
                        if let Err(_e) = child.kill() {
                            error!("script stdout thread kill erro {:?}", _e);
                            if libc::kill(child.id() as i32, libc::SIGTERM) == 0 {
                                debug!("script stdout thread kill done by sigterm")
                            } else {
                                error!(
                                    "script stdout thread kill erro by sigterm {:?}",
                                    std::io::Error::last_os_error()
                                )
                            }
                        } else {
                            debug!("script stdout thread kill done")
                        }
                        if let Err(_e) = child.wait() {
                            debug!("script stdout thread kill and wait erro {:?}", _e)
                        }
                    }
                }
                Err(e) => {
                    error!("script [{:?}] spawn erro {:?}", script_path, e);
                    resp_404(&req);
                }
            }
        }
        debug!("Req End");

        if let Err(e) = req.close() {
            error!("Tcpstream close erro {:?}", e)
        }
    } else {
        if let Err(e) = stream.shutdown(std::net::Shutdown::Both) {
            error!("Tcpstream close erro {:?}", e)
        }
    }
    info!(" > TcpStream End\n\n");
}

lazy_static! {
    static ref WDIR: RwLock<String> = RwLock::new(String::from("/tmp"));
}

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
                std::thread::spawn(move || handle(_stream));
                debug!("new Req thread started")
            }
            Err(e) => {
                error!("Tcp handle erro {:?}", e)
            }
        };
    }
}
