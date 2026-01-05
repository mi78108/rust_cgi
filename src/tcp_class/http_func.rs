use crate::error;
use crate::utils::core::{Handle, Req};
use crate::{SCRIPT_DIR, debug, tcp_class::Tcp};
use std::borrow::Cow;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::{collections::HashMap, io::Error, sync::atomic::AtomicUsize};
use tokio::io::AsyncBufReadExt;
use urlencoding::decode;

#[derive(Debug)]
pub struct Http {
    pub base_on: Tcp,
    // req_path: String,
    // req_method: String,
    // req_version: String,
    // req_buffer_size: usize,
    req_content_length: usize,
    req_content_read: AtomicUsize,
    req_header: HashMap<String, String>,
}

impl Req for Http {
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

fn parse_req_path(req_path: String) -> (PathBuf, Vec<String>) {
    let mut result = Vec::new();
    let req_script = Path::new(req_path.as_str());
    let mut script_file_path = PathBuf::from(SCRIPT_DIR.get().unwrap())
        .join(req_script.strip_prefix("/").unwrap_or(req_script));

    debug!("req_script_file_path {:?}", script_file_path);
    loop {
        if script_file_path.exists() {
            if script_file_path.is_file() {
                //文件存在 并且是文件 ok return
                debug!("script_file_path file while= {:?}", script_file_path);
                return (script_file_path, result);
            }
            if script_file_path.is_dir() {
                //文件存在 是文件夹 指向当下的 index ok return
                script_file_path.push("index");
                debug!("script_file_path dir while= {:?}", script_file_path);
                return (script_file_path, result);
            }
        }
        debug!(
            "script_file_path {:?} {:?} as restful param",
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

impl Handle<Tcp> for Http {
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
        }
        return false;
    }

    async fn handle(stream: Tcp) -> Result<Self, Error> {
        let peer_ip = stream.req_header.get("Req_Peer_Ip").unwrap().clone();
        let peer_port = stream.req_header.get("Req_Peer_Port").unwrap().clone();
        let mut buffer = String::new();
        stream
            .req_reader
            .lock()
            .await
            .read_line(&mut buffer)
            .await?;

        let mut req_headers = stream.req_header.clone();
        req_headers.insert(
            String::from("Req_Peer_Addr"),
            format!("{}:{}", &peer_ip, &peer_port),
        );
        req_headers.insert(String::from("Req_Peer_Ip"), peer_ip);
        req_headers.insert(String::from("Req_Peer_Port"), peer_port);
        req_headers.insert(String::from("Req_Body_Method"), String::from("HTTP"));
        // Pro
        let line = buffer.trim_matches(|c| c == '\n' || c == '\r').to_string();
        let mut rst = line.splitn(3, " ");
        let req_method = rst
            .next()
            .ok_or_else(|| Error::new(ErrorKind::InvalidData, "Format Error: missing method"))?;

        let req_path = rst
            .next()
            .ok_or_else(|| Error::new(ErrorKind::InvalidData, "Format Error: missing path"))?;

        let req_version = rst
            .next()
            .ok_or_else(|| Error::new(ErrorKind::InvalidData, "Format Error: missing version"))?;
        req_headers.insert("Req_Method".into(), req_method.into());
        req_headers.insert("Req_Path".into(), req_path.into());
        req_headers.insert("Req_Version".into(), req_version.into());
        buffer.clear();

        // Header
        while let Ok(len) = stream.req_reader.lock().await.read_line(&mut buffer).await {
            if len == 0 {
                return Err(Error::new(ErrorKind::UnexpectedEof, "Read Error"));
            }
            let line = buffer.trim_matches(|c| c == '\n' || c == '\r');
            if line.is_empty() {
                break;
            }
            let mut header = line.splitn(2, ":");
            if let (Some(key), Some(value)) = (header.next(), header.next()) {
                let key = key.trim().to_lowercase();
                let value = value.trim_start().to_string();
                req_headers.insert(key, value);
            } else {
                error!("Invalid HTTP Header: {}", line);
            }
            buffer.clear();
        }
        // let req_buffer_size = stream
        //     .req_header
        //     .get("Req_Buffer_Size")
        //     .and_then(|s| s.parse::<usize>().ok())
        //     .unwrap_or(1024 * 128);
        let req_content_length = req_headers
            .get("content-length")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);

        // Parse Path Params
        let mut req_params = req_path.splitn(2, "?");
        if let (Some(req_path), Some(params)) = (req_params.next(), req_params.next()) {
            req_headers.insert("Req_Path".to_string(), req_path.to_string());
            req_headers.insert("Req_Params".to_string(), params.to_string());
            let mut param_kvs = params.split("&");
            while let Some(req_param_item) = param_kvs.next() {
                let mut req_item_kv = req_param_item.splitn(2, "=");
                if let (Some(key), Some(val)) = (req_item_kv.next(), req_item_kv.next()) {
                    let decoded_key = decode(key).unwrap_or_else(|_| Cow::from(key));
                    let decoded_val = decode(val).unwrap_or_else(|_| Cow::from(val));
                    req_headers.insert(
                        format!("Req_Param_{}", decoded_key),
                        decoded_val.to_string(),
                    );
                }
            }
        } else {
            debug!("Have Not Params: {} ignore", req_path);
        }

        // Parse Restful Argv
        let (req_script_path, mut restful_argvs) =
            parse_req_path(req_headers.get("Req_Path").unwrap().to_string());

        req_headers.insert(
            "Req_Script_Path".to_string(),
            req_script_path.to_string_lossy().to_string(),
        );
        if let Some(script_name) = req_script_path.file_name() {
            req_headers.insert(
                "Req_Script_Basename".to_string(),
                script_name.to_str().unwrap().to_string(),
            );
            req_headers.insert(
                "Req_Script_Name".to_string(),
                req_script_path
                    .strip_prefix(SCRIPT_DIR.get().unwrap())
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
            );
        }
        if let Some(script_dir) = req_script_path.parent() {
            req_headers.insert(
                "Req_Script_Dir".to_string(),
                script_dir.to_string_lossy().to_string(),
            );
        }
        restful_argvs.reverse();
        restful_argvs.iter().enumerate().for_each(|(i, v)| {
            req_headers.insert(format!("Req_Argv_{}", i + 1), v.to_owned());
            req_headers.insert(format!("Req_Param_Argv_{}", i + 1), v.to_owned());
        });
        req_headers.insert(
            "Req_Argv_Count".to_string(),
            restful_argvs.len().to_string(),
        );
        req_headers.insert("Req_Argv_Params".to_string(), restful_argvs.join("/"));
        debug!("restful_argv = {:?}", restful_argvs);
        debug!("new http req create");
        //Websocket
        if let Some(upgrade) = req_headers.get("upgrade") {
            if upgrade.to_lowercase() == "websocket" {
                req_headers.insert(String::from("Req_Body_Method"), "WEBSOCKET".to_string());
            }
        }
        debug!("header: {:?}", req_headers);

        Ok(Http {
            base_on: stream,
            // req_path: req_path.to_string(),
            // req_method: req_method.to_string(),
            // req_version: req_version.to_string(),
            // req_buffer_size,
            req_header: req_headers,
            req_content_length,
            req_content_read: AtomicUsize::new(0),
        })
    }
}
