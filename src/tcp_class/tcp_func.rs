use crate::tcp_class::http_websocket_func::Websocket;
use crate::{Handle, Req, SCRIPT_DIR, tcp_class::http_func::Http, info, debug};
use std::{
    collections::HashMap,
    io::Error,
    net::SocketAddr,
    path::Path,
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};
use tokio::io::{BufReader, BufWriter};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{
        TcpStream,
        tcp::{OwnedReadHalf, OwnedWriteHalf},
    },
    process::Command,
    sync::Mutex,
};
async fn call_script<T: Req>(req: T) -> bool {
    let req_script = Path::new(req.env().get("Req_Script_Name").unwrap());
    let script_file = PathBuf::from(SCRIPT_DIR.get().unwrap())
        .join(req_script.strip_prefix("/").unwrap_or(req_script));

    debug!("Script in {:?} will exec {:?} final script file {:?}",
        SCRIPT_DIR.get(),
        req_script,
        script_file
    );
    if !script_file.exists() || !script_file.is_file() {
        info!("Script file {:?} does not valid", script_file);
        return false;
    }

    let req = Arc::new(req);
    let reader = Arc::clone(&req);
    let writer = Arc::clone(&req);
    let mut cmd = Command::new(script_file)
        .env_clear()
        .envs(req.env())
        .current_dir(SCRIPT_DIR.get().unwrap())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();

    let mut child_in = cmd.stdin.take().unwrap();
    let mut child_out = cmd.stdout.take().unwrap();
    tokio::spawn(async move {
        let mut rst = vec![0u8; 128];
        while let Ok(len) = child_out.read(&mut rst).await {
            debug!("Script read {} bytes", len);
            if len == 0 {
                debug!("Script read Zero will closed");
                break;
            }
            writer.write(&rst[0..len]).await.unwrap();
        }
        //
        writer.close().await.unwrap();
    });

    let mut rst = vec![0u8; 128];
    while let Ok(rst_len) = reader.read(&mut rst).await {
        if let Some(len) = rst_len {
            debug!("Stream read {} bytes", len);
            if len == 0 {
                //break;
            }
            child_in.write(&rst[0..len]).await.unwrap();
            child_in.flush().await.unwrap();
        }else {
            debug!("Stream read None will closed");
            break;
        }
    }
    match cmd.wait().await {
        Ok(status) => {
            debug!("Script finished ok exited with {:?}", status);
            true
        },
        Err(e) =>{
            debug!("Script finished errno exited with {:?}", e);
            false
        }
    }
}

#[derive(Debug)]
pub struct Tcp {
    pub req_reader: Mutex<BufReader<OwnedReadHalf>>,
    pub req_writer: Mutex<BufWriter<OwnedWriteHalf>>,
    pub req_header: HashMap<String, String>,
    pub is_closed: AtomicBool,
}

// static PROTOCOL_HANDLERS: OnceLock<RwLock<Vec<Arc<dyn Handle>>>> = OnceLock::new();
// impl Tcp {
//     fn matches(&self) -> bool {
//         true
//     }
// }

impl Req for Tcp {
    async fn read(&self, data: &mut [u8]) -> Result<Option<usize>, Error> {
        self.req_reader
            .lock()
            .await
            .read(data)
            .await
            .and_then(|len| {
                if len == 0 {
                    return Ok(None);
                }
                Ok(Some(len))
            })
    }
    async fn write(&self, data: &[u8]) -> Result<usize, Error> {
        let mut writer = self.req_writer.lock().await;
        let len = writer.write(data).await?;
        //writer.flush().await?;
        Ok(len)
    }

    async fn close(&self) -> Result<(), Error> {
        if self.is_closed.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }
        let mut writer = self.req_writer.lock().await;
        self.is_closed.store(true, std::sync::atomic::Ordering::Relaxed);
        writer.flush().await?;
        writer.shutdown().await
    }

    fn env(&self) -> &HashMap<String, String> {
        &self.req_header
    }
}

// impl From<TcpStream> for Tcp {
//     fn from(stream: TcpStream) -> Self {
//         {
//             let (reader, writer) = stream.into_split();
//             let mut header = HashMap::new();
//             header.insert("req_script_path".into(), "tcp_handle".into());
//             Tcp {
//                 req_header: header,
//                 req_reader: Mutex::new(reader),
//                 req_writer: Mutex::new(writer),
//                 is_closed: AtomicBool::new(false),
//             }
//         }
//     }
// }

impl From<(TcpStream, SocketAddr)> for Tcp {
    fn from((stream, addr): (TcpStream, SocketAddr)) -> Self {
        {
            let (reader, writer) = stream.into_split();
            Tcp {
                req_header: HashMap::from([
                    ("Req_Script_Name".into(), "/tcp_handle".to_string()),
                    ("Req_Peer_Ip".into(), addr.ip().to_string()),
                    ("Req_Peer_Port".into(), addr.port().to_string()),
                    ("Req_Buffer_Size".into(), (1024 * 128).to_string()),
                ]),
                req_reader: Mutex::new(BufReader::new(reader)),
                req_writer: Mutex::new(BufWriter::new(writer)),
                is_closed: AtomicBool::new(false),
            }
        }
    }
}

pub async fn handle(stream: TcpStream, addr: SocketAddr) -> Result<bool, Error> {
    let tcp = Tcp::from((stream, addr));
    if Http::matches(&tcp).await {
        let http = Http::handle(tcp).await?;
        if Websocket::matches(&http).await {
            return Ok(call_script(Websocket::handle(http).await?).await);
        }
        return Ok(call_script(http).await);
    }
    return Ok(call_script(tcp).await);
}
