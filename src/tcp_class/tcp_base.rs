use crate::tcp_class::http_func::Http;
use crate::tcp_class::tcp_func::Tcp;
use crate::tcp_class::websocket_func::Websocket;
use crate::CGI_DIR;
use std::collections::HashMap;
use std::io::{Error, Read, Write};
use std::process::{id, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc};
use std::thread::{self, current};

pub trait Req {
    fn read(&self, data: &mut [u8]) -> Result<usize, Error>;
    fn write(&self, data: &[u8]) -> Result<usize, Error>;
    fn close(&self) -> Result<(), Error>;
    fn env(&self) -> &HashMap<String, String>;
}

fn call_script(req: Box<(dyn Req + Send + Sync)>) {
    let BUFFER_SIZE = req
        .env()
        .get("Req_Buffer_Size")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or((1024 * 128) as usize);

    if let Some(script_path) = req.env().get("req_script_path") {
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

        match script.spawn() {
            Ok(mut child) => {
                let script_path = script_path.clone();
                let req_arc = Arc::new(req);
                let req_reader = req_arc.clone();
                let req_writer = req_arc.clone();

                let mut script_stdin = child.stdin.take().unwrap();
                let mut script_stdout = child.stdout.take().unwrap();
                let script_id = child.id();
                //
                let script_arc = Arc::new(script);
                let script_stdin_arc = script_arc.clone();
                let script_stdout_arc = script_arc.clone();

                //
                let script_stop = Arc::new(AtomicBool::new(false));
                let script_stop_in = script_stop.clone();
                let script_stop_out = script_stop.clone();
                thread::spawn(move || {
                    // script -> tcp
                    let script_name = script_stdin_arc.get_program().to_str().unwrap();
                    let mut buffer = vec![0u8; BUFFER_SIZE];
                    while let Ok(len) = script_stdout.read(&mut buffer) {
                        if script_stop_in.load(std::sync::atomic::Ordering::Acquire) {
                            break;
                        }                    
                        debug!(
                            "<{:?}:{}> on {} call script [{}] script stream read [{}]",
                            current().id(),
                            script_id,
                            id(),
                            script_name,
                            len
                        );
                         if len == 0 {
                            break;
                        }
                        if let Err(e) = req_writer.write(&buffer[..len]) {
                            error!("{:?}", e);
                            break;
                        }
                    }
                    debug!(
                        "<{:?}:{}> on {} call script [{}] script stream pipe end",
                        current().id(),
                        script_id,
                        id(),
                        script_name
                    );
                });
                thread::spawn(move || {
                    // tcp -> script
                    let script_name = script_stdout_arc.get_program().to_str().unwrap();
                    let mut buffer = vec![0u8; BUFFER_SIZE];
                    while let Ok(len) = req_reader.read(&mut buffer) {
                        if script_stop_out.load(std::sync::atomic::Ordering::Acquire) {
                            break;
                        }
                        debug!(
                            "<{:?}:{}> on {} call script [{}] req stream read [{}]",
                            current().id(),
                            script_id,
                            id(),
                            script_name,
                            len
                        );
                        if let Err(e) = script_stdin.write(&buffer[..len]) {
                            error!("{:?}", e);
                            break;
                        }
                        if let Err(e) = script_stdin.flush() {
                            error!("{:?}", e);
                            break;
                        }
                        error!("scrip wirte end")
                    }
                    debug!(
                        "<{:?}:{}> on {} call script [{}] req stream pipe end",
                        current().id(),
                        script_id,
                        id(),
                        script_name
                    );
                    // 远端断开 终止脚本
                    script_stop_out.store(true, std::sync::atomic::Ordering::Release);
                });
                // block wait
                let script_rst = child.wait();
                script_stop.store(true, std::sync::atomic::Ordering::Release);
                req_arc.close().unwrap();
                if let Ok(code) = script_rst {
                    debug!(
                        "<{:?}> on {} call script [{}] exited [{:?}]",
                        current().id(),
                        id(),
                        script_path,
                        code
                    );
                }
                if let Err(e) = script_rst {
                    error!(
                        "<{:?}> on {} call script [{}] exits erro [{:?}]",
                        current().id(),
                        id(),
                        script_path,
                        e
                    );
                }
            }
            Err(e) => {
                error!("<{}:{:?}> script spawn erro {:?}", id(), current().id(), e);
            }
        }
    }
}

pub fn handle(stream: Tcp) {
    let mut buffer = [0u8; 16];
    if let Ok(len) = stream.req_stream.peek(&mut buffer) {
        debug!(
            "Handled TcpStream {:?} [{:?}]",
            &buffer[0..len],
            String::from_utf8_lossy(&buffer)
        );
    }

    call_script(match buffer {
        ref h
            if [
                "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT",
            ]
            .iter()
            .find(|v| h.starts_with(v.as_bytes()))
            .is_some() =>
        {
            debug!("Tcp Req Handled on HTTP");
            let http = Http::from(stream);
            //Websocket
            if let Some(websocket) = http.env().get("req_body_method") {
                if websocket == "WEBSOCKET" {
                    debug!("Tcp Req Handled on HTTP Upgrade Websocket");
                    Box::new(Websocket::from(http))
                } else {
                    Box::new(http)
                }
            } else {
                Box::new(http)
            }
        }
        _ => {
            debug!("Tcp Req Handled on tcp default");
            Box::new(stream)
        }
    })
}
