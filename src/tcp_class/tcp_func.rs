use crate::OPT;
use crate::tcp_class::http_func::Http;
use crate::tcp_class::http_websocket_func::Websocket;
use crate::tcp_class::tcp_file_func::FileSync;
use crate::utils::core::{Handle, Req, call_bridge, call_script};
use std::{collections::HashMap, io::Error, net::SocketAddr, sync::atomic::AtomicBool};
use tokio::io::{BufReader, BufWriter};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{
        TcpStream,
        tcp::{OwnedReadHalf, OwnedWriteHalf},
    },
    sync::Mutex,
};

#[derive(Debug)]
pub struct Tcp {
    pub req_reader: Mutex<BufReader<OwnedReadHalf>>,
    pub req_writer: Mutex<BufWriter<OwnedWriteHalf>>,
    pub req_header: HashMap<String, String>,
    pub is_closed: AtomicBool,
}

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
        self.is_closed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        writer.flush().await?;
        writer.shutdown().await
    }

    fn env(&self) -> &HashMap<String, String> {
        &self.req_header
    }
}

impl From<TcpStream> for Tcp {
    fn from(stream: TcpStream) -> Self {
        {
            let (reader, writer) = stream.into_split();
            let mut header = HashMap::new();

            header.insert("Req_Script_Name".into(), "/tcp_handle".to_string());
            header.insert(
                "Req_Buffer_Size".into(),
                OPT.get().unwrap().buffer.to_string(),
            );
            Tcp {
                req_header: header,
                req_reader: Mutex::new(BufReader::new(reader)),
                req_writer: Mutex::new(BufWriter::new(writer)),
                is_closed: AtomicBool::new(false),
            }
        }
    }
}

impl From<(TcpStream, SocketAddr)> for Tcp {
    fn from((stream, addr): (TcpStream, SocketAddr)) -> Self {
        {
            let (reader, writer) = stream.into_split();
            Tcp {
                req_header: HashMap::from([
                    ("Req_Script_Name".into(), "/tcp_handle".to_string()),
                    ("Req_Peer_Ip".into(), addr.ip().to_string()),
                    ("Req_Peer_Port".into(), addr.port().to_string()),
                    (
                        "Req_Buffer_Size".into(),
                        OPT.get().unwrap().buffer.to_string(),
                    ),
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
    if FileSync::matches().await {
        let file = FileSync::reader(&tcp).await?;
        return Ok(call_bridge(file, tcp).await);
    }
    return Ok(call_script(tcp).await);
}
