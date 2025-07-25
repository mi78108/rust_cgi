use crate::tcp_class::http_func::Http;
use crate::tcp_class::tcp_func::Tcp;
use crate::tcp_class::websocket_func::Websocket;
use crate::CGI_DIR;
use std::collections::HashMap;
use std::io::{Error, Read, Write};
use std::ops::DerefMut;
use std::process::{id, Child, Command, Stdio};
use std::sync::Arc;
use std::thread::{self, current};
use mio::event::{Event, Source};
use mio::{Events, Interest, Poll, Token};

/// # 说明
/// - 为协议统一接口
pub trait Req {
    fn read(&self, data: &mut [u8]) -> Result<Option<usize>, Error>;
    fn write(&self, data: &[u8]) -> Result<usize, Error>;
    fn close(&self) -> Result<(), Error>;
    fn env(&self) -> &HashMap<String, String>;
}

/// # 说明
/// - 为请求调用相应的脚本
/// - 目前脚本tsdin stdout各使用一个线程
fn call_script(req: &mut impl Req) {
    let buffer_size = req
        .env()
        .get("Req_Buffer_Size")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or((1024 * 128) as usize);
    let script_path_rst = req.env().get("req_script_path");
    if let Some(script_path) = script_path_rst {
        info!(
            "<{:?}> on {} call script [{}]",
            current().id(),
            id(),
            script_path
        );
        let mut script = Command::new(format!(
                ".{}",
                script_path.replace(CGI_DIR.get().unwrap(), "")
        ));
        script
            //.current_dir(PathBuf::from(script_path).parent().unwrap())
            .current_dir(CGI_DIR.get().unwrap())
            .envs(req.env())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut poll = Poll::new().unwrap();
        let mut evnets = mio::Events::with_capacity(16);

        let mut echo = Echo(req);

        poll.registry().register(&mut echo, Token(1), Interest::READABLE);


        match script.spawn() {
            Ok(mut child) => {

                let mut script_stdin = child.stdin.take().unwrap();
                let mut script_stdout = child.stdout.take().unwrap();
                let script_id = child.id();
                //
                let script_arc = Arc::new(script);
                let script_stdin_arc = script_arc.clone();
                let script_stdout_arc = script_arc.clone();

                //
            },
            Err(e)=>{

            }
        }
    }
}

/// # 说明
/// 接管分派请求到相应的协议
pub fn handle(stream: Tcp) {
    let mut buffer = [0u8; 16];
    if let Ok(len) = stream.req_stream.peek(&mut buffer) {
        debug!(
            "Handled TcpStream {:?} [{:?}]",
            &buffer[0..len],
            String::from_utf8_lossy(&buffer)
        );
    }

    match buffer {
        ref h
            if [
                "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT",
            ]
                .iter()
                .find(|v| h.starts_with(v.as_bytes()))
                .is_some() =>
            {
                debug!("Tcp Req Handled on HTTP");
                let mut http = Http::from(stream);
                //Websocket
                if let Some(websocket) = http.env().get("req_body_method") {
                    if websocket == "WEBSOCKET" {
                        debug!("Tcp Req Handled on HTTP Upgrade Websocket");
                        call_script(&mut Websocket::from(http))
                    } else {
                        call_script(&mut http)
                    }
                } else {
                    call_script(&mut http)
                }
            }
        _ => {
            debug!("Tcp Req Handled on tcp default");
            let mut stream = stream;
            call_script(&mut stream)
        }
    }
}

struct Echo<T>(T);
impl<T> Source for Echo<T>{
    fn register(
        &mut self,
        registry: &mio::Registry,
        token: Token,
        interests: Interest,
    ) -> std::io::Result<()> {
        todo!()
    }

    fn reregister(
        &mut self,
        registry: &mio::Registry,
        token: Token,
        interests: Interest,
    ) -> std::io::Result<()> {
        todo!()
    }

    fn deregister(&mut self, registry: &mio::Registry) -> std::io::Result<()> {
        todo!()
    }
}
