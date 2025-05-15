use crate::WDIR;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Error, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::process::{Command, Stdio};
use std::sync::{Arc, RwLock};
use std::{io, process};

pub trait Req {
    fn read(&self, data: &mut Vec<u8>) -> Result<Option<usize>, io::Error>;
    fn write(&self, data: &[u8]) -> Result<usize, io::Error>;
    fn close(&self) -> Result<(), std::io::Error>;
    fn env(&self) -> &HashMap<String, String>;
}

pub fn call_script(req: Box<(dyn Req + Send + Sync)>) {
    let BUFFER_SIZE = req
        .env()
        .get("Req_Buffer_Size")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or((1024 * 128) as usize);
    if let Some(req_path) = req.env().get("req_script_path") {
        info!("Req [{}]", req_path);
        let mut script = Command::new(format!(
            ".{}",
            req_path.replacen(WDIR.read().unwrap().as_str(), "", 1)
        ));
        script.current_dir(WDIR.read().unwrap().as_str());
        //let mut env = req.env().clone();
        script
            .env_clear()
            .envs(req.env())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        debug!(
            "OS EXEC [{}][{}] with {} ppid {}",
            script.get_current_dir().unwrap().to_string_lossy(),
            script.get_program().to_string_lossy(),
            format!(
                "{} {}",
                req.env().get("req_method").unwrap_or(&"".to_string()),
                req.env().get("req_body_method").unwrap_or(&"".to_string())
            ),
            process::id()
        );
        match script.spawn() {
            Ok(mut child) => {
                debug!(
                    "OS RUN [{}] with {} pid {}",
                    script.get_program().to_string_lossy(),
                    format!(
                        "{} {}",
                        req.env().get("req_method").unwrap_or(&"".to_string()),
                        req.env().get("req_body_method").unwrap_or(&"".to_string())
                    ),
                    child.id()
                );
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
                            match req_read.read(&mut buffer) {
                                //debug!("tcpStream read len [{}] [{:?}]", len, String::from_utf8_lossy(&buffer[..len]));
                                Ok(Some(len)) => {
                                    debug!("tcpStream read len [{}]", len);
                                    if len > 0 {
                                        if let Err(e) = stdin.write(&buffer[..len]) {
                                            error!("script stdin write thread {:?} break", e);
                                            break;
                                        }
                                        debug!("script stdin write [{}]", len);
                                        if let Err(e) = stdin.flush() {
                                            error!(
                                                "script stdin write thread flush erro {:?}; break",
                                                e
                                            );
                                            break;
                                        }
                                        // fix 会引起 read 读取不到数据
                                        //buffer.clear();
                                    } else {
                                        debug!(
                                            "script stdin thread tcpStream read data len 0; break"
                                        );
                                        break;
                                    }
                                }
                                Ok(None) => {
                                    // 忽略None， 直接再次读取
                                }

                                Err(e) => {
                                    // 读错误， 忽略并结束
                                    error!("tcpStream read erro [{:?}]", e);
                                    break;
                                }
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
                        match stdout.read(&mut buffer) {
                            Ok(len) => {
                                //debug!("script stdout read len [{}] [{:?}]", len, String::from_utf8_lossy(&buffer[..len]));
                                debug!("script stdout read len [{}]", len);
                                if len > 0 {
                                    if let Err(e) = req_write.write(&buffer[..len]) {
                                        error!(
                                            "script stdout write tcpStream  erro; break [{:?}]",
                                            e
                                        );
                                        break;
                                    }
                                    debug!("script stdout write tcpStream  [{}]", len);
                                } else {
                                    // 正常退出， 脚本退出后读取不到
                                    debug!("script stdout read data len 0; break");
                                    break;
                                }
                            }
                            Err(e) => {
                                error!("script stdout read erro [{:?}]", e);
                                break;
                            }
                        }
                    }
                    debug!("script stdout read func end");
                }
                // kill script
                debug!("script ready to kill {:?}", child.id());
                if let Err(e) = child.kill() {
                    error!("script kill erro {:?}", e)
                }
                debug!("script kill done wait result");
                if let Ok(code) = child.wait() {
                    debug!(
                        ">>> [{}] script kill done [{:?}]",
                        _req.env().get("req_script_path").unwrap(),
                        code
                    );
                    if !code.success() {
                        error!("script exit erro [{:?}]", code);
                        if _req.env().get("req_body_method").unwrap().eq("HTTP") {
                            if let Err(e) = _req.write(format!("HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/text\r\n\r\nscript panic [ {:?} ]", code).as_bytes()) {
                                error!("script exit erro resp erro [{:?}]",e);
                            }
                        }
                    }
                }

                if let Err(e) = _req.close() {
                    error!("tcpStream close erro {:?}", e);
                } else {
                    debug!("tcpStream closed");
                }
            }
            Err(e) => {
                error!("script spawn  erro {:?}", e);
                if let Err(e) = req.write(format!("HTTP/1.0 404 Not Found\r\nContent-Type: text/text\r\n\r\nscript spawn fail [ {} ]", e.to_string()).as_bytes()) {
                    error!("script spawn erro resp erro [{:?}]",e);
                }
            } // do something
        }
    }
}

struct Tcp {
    pub req_stream: TcpStream,
    req_reader: RwLock<BufReader<TcpStream>>,
    req_writer: RwLock<BufWriter<TcpStream>>,
    headers: HashMap<String, String>,
}

impl Req for Tcp {
    fn read(&self, data: &mut Vec<u8>) -> Result<Option<usize>, Error> {
        self.req_reader
            .write()
            .unwrap()
            .read(data)
            .and_then(|len| Ok(Some(len)))
            .or_else(|e| Err(e))
    }

    fn write(&self, data: &[u8]) -> Result<usize, Error> {
        let mut writer = self.req_writer.write().unwrap();
        writer
            .write(data)
            .and_then(|len| writer.flush().and(Ok(len)))
            .or_else(|e| Err(e))
    }

    fn close(&self) -> Result<(), Error> {
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
    Box::new(Tcp {
        req_stream: stream,
        req_reader: RwLock::new(reader),
        req_writer: RwLock::new(writer),
        headers: HashMap::from([
            (
                "Req_Peer_Addr".to_string(),
                format!("{}:{}", peer_addr.ip().to_string(), peer_addr.port()),
            ),
            (
                "Req_Peer_Ip".to_string(),
                format!("{}", peer_addr.ip().to_string()),
            ),
            ("Req_Peer_Port".to_string(), format!("{}", peer_addr.port())),
            ("req_body_method".to_string(), "TCP".to_string()),
            ("req_script_path".to_string(), "/tcp_handle".to_string()),
        ]),
    })
}
