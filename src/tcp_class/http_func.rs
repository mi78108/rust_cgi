use crate::tcp_class::tcp_base::Req;
use crate::tcp_class::tcp_func::Tcp;
use crate::CGI_DIR;
use std::collections::HashMap;
use std::fmt::Display;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::thread::current;

#[derive(Debug)]
<<<<<<< Updated upstream
pub struct Http {
    pub base_on: Tcp,
    req_path: String,
    req_method: String,
    req_version: String,
    req_buffer_size: usize,
=======
pub struct Http<'a> {
    pub base_on: &'a mut Tcp,
    // req_path: String,
    // req_method: String,
    // req_version: String,
    // req_buffer_size: usize,
>>>>>>> Stashed changes
    req_content_length: usize,
    req_content_readed: AtomicUsize,
    req_header: HashMap<String, String>,
}

<<<<<<< Updated upstream
=======
impl<'a> Req for Http<'a> {
    async fn read(&self, data: &mut [u8]) -> Result<Option<usize>, Error> {
        if self.req_content_length > 0
            && self
                .req_content_read
                .load(std::sync::atomic::Ordering::Relaxed)
                == self.req_content_length
        {
            // 表示读取正常 但是数据结束
            return Ok(None);
        }
        self.base_on.read(data).await.and_then(|len_opt| {
            if let Some(len) = len_opt {
                self.req_content_read.store(
                    self.req_content_read
                        .load(std::sync::atomic::Ordering::Acquire)
                        + len,
                    std::sync::atomic::Ordering::Relaxed,
                )
            }
            Ok(len_opt)
        })
    }

    async fn write(&self, data: &[u8]) -> Result<usize, Error> {
        self.base_on.write(data).await
    }

    async fn close(&self) -> Result<(), Error> {
        self.base_on.close().await
    }

    fn env(&self) -> &HashMap<String, String> {
        &self.req_header
    }
}

>>>>>>> Stashed changes
fn parse_req_path(req_path: String) -> (PathBuf, Vec<String>) {
    let mut result = Vec::new();
    let mut script_file_path = PathBuf::from(format!("{}{}", CGI_DIR.get().unwrap(), req_path));
    debug!(
        "<{:?}> req_script_file_path {:?}",
        current().id(),
        script_file_path
    );
    loop {
        if script_file_path.exists() {
            if script_file_path.is_file() {
                //文件存在 并且是文件 ok return
                debug!(
                    "<{:?}> script_file_path file while= {:?}",
                    current().id(),
                    script_file_path
                );
                return (script_file_path, result);
            }
            if script_file_path.is_dir() {
                //文件存在 是文件夹 指向当下的 index ok return
                script_file_path.push("index");
                debug!(
                    "<{:?}> script_file_path dir while= {:?}",
                    current().id(),
                    script_file_path
                );
                return (script_file_path, result);
            }
        }
        debug!(
            "<{:?}> script_file_path {:?} {:?} as restful param",
            current().id(),
            script_file_path,
            script_file_path.file_name().unwrap()
        );
        result.push(
            script_file_path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .to_string(),
        );
        script_file_path.pop();
    }
}

<<<<<<< Updated upstream
impl Req for Http {
    fn read(&self, data: &mut [u8]) -> Result<Option<usize>, std::io::Error> {
        if self.req_content_length > 0
            && self
                .req_content_readed
                .load(std::sync::atomic::Ordering::Relaxed)
                == self.req_content_length
        {
            //return Err(Error::from(ErrorKind::UnexpectedEof));
            // 表示读取正常 但是数据结束
            return Ok(None);
=======
impl<'a> Handle<'a, Tcp> for Http<'a> {
    // fn name() -> &'static str {
    //     "HTTP"
    // }

    async fn matches(stream: &Tcp) -> bool {
        const HTTP_METHODS: &[&[u8]] = &[
            b"GET ",
            b"POST ",
            b"PUT ",
            b"DELETE ",
            b"PATCH ",
            b"HEAD ",
            b"OPTIONS ",
            b"CONNECT ",
        ];
        if {
            let mut buffer = [0u8; 16];
            if let Ok(len) = stream
                .req_reader
                .lock()
                .await
                .get_mut()
                .peek(&mut buffer)
                .await
            {
                len > 0 && HTTP_METHODS.iter().any(|&v| buffer.starts_with(v))
            } else {
                false
            }
        } {
            return true;
>>>>>>> Stashed changes
        }
        self.base_on.read(data).and_then(|len_opt| {
            if let Some(len) = len_opt {
                self.req_content_readed.store(
                    self.req_content_readed
                        .load(std::sync::atomic::Ordering::Acquire)
                        + len,
                    std::sync::atomic::Ordering::Relaxed,
                )
            }
            Ok(len_opt)
        })
    }

<<<<<<< Updated upstream
    fn write(&self, data: &[u8]) -> Result<usize, std::io::Error> {
        self.base_on.write(data)
    }

    fn close(&self) -> Result<(), std::io::Error> {
        self.base_on.close()
    }

    fn env(&self) -> &HashMap<String, String> {
        &self.req_header
    }
}

impl From<Tcp> for Http {
    fn from(stream: Tcp) -> Self {
        let peer_addr = stream.req_stream.peer_addr().unwrap();
        let mut http = Http {
            base_on: stream,
            req_path: String::from("/"),
            req_method: String::from("GET"),
            req_version: String::from("1"),
            req_buffer_size: 1024 * 128,
            req_header: HashMap::from([
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
            req_content_length: 0,
            req_content_readed: AtomicUsize::new(0),
        };

=======
    async fn handle(stream: &'a mut Tcp) -> Result<Self, Error> {
        let peer_ip = stream.req_header.get("Req_Peer_Ip").unwrap().clone();
        let peer_port = stream.req_header.get("Req_Peer_Port").unwrap().clone();
>>>>>>> Stashed changes
        let mut buffer = String::new();
        if let Ok(_size) = http
            .base_on
            .req_reader
            .write()
            .unwrap()
            .read_line(&mut buffer)
        {
            let line = buffer.trim_matches(|c| c == '\n' || c == '\r');
            let mut rst = line.splitn(3, " ");
            if let Some(method) = rst.next() {
                http.req_method.clear();
                http.req_method.push_str(method);
                http.req_header.insert("req_method".into(), method.into());
            }
            if let Some(path) = rst.next() {
                http.req_path.clear();
                http.req_path.push_str(path);
                http.req_header.insert("req_path".into(), path.into());
            };
            if let Some(version) = rst.next() {
                http.req_version.clear();
                http.req_version.push_str(version);
                http.req_header.insert("req_version".into(), version.into());
            };
            buffer.clear();
        }
        // Header
        while let Ok(_) = http
            .base_on
            .req_reader
            .write()
            .unwrap()
            .read_line(&mut buffer)
        {
            let line = buffer.trim_matches(|c| c == '\n' || c == '\r');
            if line.is_empty() {
                if let Ok(len) = http
                    .req_header
                    .get("Req_Buffer_Size")
                    .unwrap()
                    .parse::<usize>()
                {
                    http.req_buffer_size = len
                }
                if let Some(length) = http.req_header.get("Content-Length") {
                    if let Ok(len) = length.parse::<usize>() {
                        http.req_content_length = len;
                    }
                }
                break;
            }
            let mut head = line.splitn(2, ":");
            if let Some(req_head_name) = head.next() {
                if let Some(req_head_value) = head.next() {
                    http.req_header
                        .insert(req_head_name.into(), req_head_value.trim_start().into());
                }
            }
            buffer.clear();
        }
        // parse_path_params
        let mut path = http.req_path.splitn(2, "?");
        if let Some(req_path) = path.next() {
            http.req_header.insert("req_path".into(), req_path.into());
        }
        if let Some(req_params) = path.next() {
            http.req_header
                .insert("req_params".into(), req_params.into());
            // get param
            let mut params = req_params.split("&");
            while let Some(req_param_item) = params.next() {
                let mut req_item_kv = req_param_item.splitn(2, "=");
                if let Some(req_param_name) = req_item_kv.next() {
                    if let Some(req_param_value) = req_item_kv.next() {
                        http.req_header.insert(
                            format!("req_param_{}", req_param_name),
                            req_param_value.into(),
                        );
                    }
                }
            }
        }
        // parse restful argv
        let (req_script_path, mut restful_argvs) =
            parse_req_path(http.req_header.get("req_path").unwrap().into());
        http.req_header.insert(
            "req_script_path".into(),
            req_script_path.to_str().unwrap().to_string(),
        );
        restful_argvs.reverse();
        restful_argvs.iter().enumerate().for_each(|(i, v)| {
            http.req_header
                .insert(format!("req_argv_{}", i + 1), v.to_owned());
            http.req_header
                .insert(format!("req_param_argv_{}", i + 1), v.to_owned());
        });
        http.req_header
            .insert("req_argv_count".into(), restful_argvs.len().to_string());
        http.req_header
            .insert("req_argv_params".into(), restful_argvs.join("/"));
        debug!("<{:?}> restful_argv = {:?}", current().id(), restful_argvs);
        //debug!("<{:?}> new http req create  {}", current().id(), http);
        debug!("<{:?}> new http req create", current().id());
        //Websocket
        if let Some(upgrade) = http.req_header.get("Upgrade") {
            if upgrade.to_lowercase() == "websocket" {
                http.req_header
                    .insert(String::from("req_body_method"), "WEBSOCKET".to_string());
            }
        }
        return http;
    }
}

impl Display for Http {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "\nreq_method {}\nreq_path {}\nreq_headers:\n{}",
            self.req_method,
            self.req_path,
            self.req_header
                .iter()
                .map(|(k, v)| { return format!(" {} -> {}\n", k, v) })
                .collect::<String>()
        )
    }
}
