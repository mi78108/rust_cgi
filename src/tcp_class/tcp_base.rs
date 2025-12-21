use crate::tcp_class::http_func::HttpHandle;
use crate::tcp_class::tcp_func::Tcp;
use crate::{CGI_DIR, THREAD_POOL};
use std::collections::HashMap;
use std::io::{Error, Read, Write};
use std::os::unix::thread;
use std::path::Path;
use std::process::{id, Command, Stdio};
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::RwLock;
use std::thread::current;

/// # 说明
/// - 为协议统一接口
pub trait Req: Send + Sync + 'static {
    fn read(&self, data: &mut [u8]) -> Result<Option<usize>, Error>;
    fn write(&self, data: &[u8]) -> Result<usize, Error>;
    fn close(&self) -> Result<(), Error>;
    fn env(&self) -> &HashMap<String, String>;
}

pub trait Handle: Sync + Send + 'static {
    fn name(&self) -> &'static str;

    fn matches(&self, stream: &Tcp) -> Option<bool>;

    fn handle(&self, stream: Tcp) -> Box<dyn Req>;
}

/// # 说明
/// - 为请求调用相应的脚本
/// - 目前脚本tsdin stdout各使用一个线程
fn call_script(req: Box<dyn Req>) {
    let cgi_dir = CGI_DIR.get().unwrap().to_str().unwrap();
    let buffer_size = req
        .env()
        .get("Req_Buffer_Size")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or((1024 * 128) as usize);

    let Some(script_path) = req.env().get("req_script_path") else {
        info!(
            "<{:?}> on {} call script [{}]",
            current().id(),
            id(),
            "unknown"
        );
        return;
    };
    let script_full_path = CGI_DIR.get().unwrap().join(script_path);

    if let Err(e) = Path::new(script_full_path.as_path()).strip_prefix(cgi_dir) {
        error!(
            "<{}:{:?}> 脚本路径 {:?} 不在 CGI_DIR {:?} 下: {}",
            id(),
            current().id(),
            script_full_path,
            cgi_dir,
            e
        );
        return;
    }

    let script_cmd = Path::new("./")
        .join(script_path)
        .to_string_lossy()
        .into_owned();

    debug!(">>>>>>>>>>>>>>>cmd>>>>>>>>>> {}", script_cmd);
    let mut script = Command::new(script_cmd);
    script
        //.current_dir(PathBuf::from(script_path).parent().unwrap())
        .current_dir(cgi_dir)
        .envs(req.env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());

    let script_opt = script.spawn();
    let Ok(mut child) = script_opt else {
        error!(
            "<{}:{:?}> script spawn erro {:?}",
            id(),
            current().id(),
            script_opt.unwrap_err()
        );
        if let Err(e) =  req.close(){
        }
        return;
    };

    let script_id = child.id();
    let script_path = script_path.clone();

    //
    let req_arc = Arc::new(req);
    let req_reader = req_arc.clone();
    let script_name = script.get_program().to_str().unwrap().to_string();

    if let Some(mut script_stdin) = child.stdin.take() {
        // tcp -> script
        //THREAD_POOL.get().unwrap().execute(move || {
        std::thread::spawn(move || {
            let mut buffer = vec![0u8; buffer_size];
            while let Ok(len_opt) = req_reader.read(&mut buffer) {
                if let Some(len) = len_opt {
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
                } else {
                    //空数据 None 代表结束
                    debug!(
                        "<{:?}:{}> on {} call script [{}] req stream recv NONE mark; break",
                        current().id(),
                        script_id,
                        id(),
                        script_name
                    );
                    break;
                }
            }
           drop(script_stdin);
            debug!(
                "<{:?}:{}> on {} call script [{}] req stream pipe end",
                current().id(),
                script_id,
                id(),
                script_name
            );
        });
    }

    if let Some(mut script_stdout) = child.stdout.take() {
        // script -> tcp
        let mut buffer = vec![0u8; buffer_size];
        let script_name = script.get_program().to_str().unwrap();
        while let Ok(len) = script_stdout.read(&mut buffer) {
            debug!(
                "<{:?}:{}> on {} call script [{}] script stream read [{}]",
                current().id(),
                script_id,
                id(),
                script_name,
                len
            );
            if let Err(e) = req_arc.write(&buffer[..len]) {
                error!("{:?}", e);
                break;
            }
            if len == 0 {
                // 脚本若返回空字节 则认为脚本结束
                break;
            }
        }
        drop(script_stdout);
        debug!(
            "<{:?}:{}> on {} call script [{}] script stream pipe end",
            current().id(),
            script_id,
            id(),
            script_name
        );
    }

    //reader_handle.join().unwrap();
    // block wait
    if let Err(e) = req_arc.close() {
        error!("req close erro {}", e);
    }
    let script_rst = child.wait();
    if let Ok(code) = script_rst {
        debug!(
            "<{:?}> on {} call script [{}] exited [{:?}]",
            current().id(),
            id(),
            script_path,
            code
        );
    } else {
        error!(
            "<{:?}> on {} call script [{}] exits erro [{:?}]",
            current().id(),
            id(),
            script_path,
            script_rst.unwrap_err()
        );
    }
}

static PROTOCOL_HANDLERS: OnceLock<RwLock<Vec<Arc<dyn Handle>>>> = OnceLock::new();

pub fn register_protocol(handler: Arc<dyn Handle>) {
    let mut handlers = PROTOCOL_HANDLERS.get().unwrap().write().unwrap();
    if !handlers.iter().any(|h| h.name() == handler.name()) {
        handlers.push(handler.clone());
        info!(
            "Enabled Module：{}， current count：{}",
            handler.name(),
            handlers.len()
        );
    }
}

pub fn default_register_protocol() {
    PROTOCOL_HANDLERS.get_or_init(|| RwLock::new(Vec::new()));
    register_protocol(Arc::new(HttpHandle));
}

/// # 说明
/// 接管分派请求到相应的协议
pub fn handle(stream: Tcp) {
    let handlers_lock = PROTOCOL_HANDLERS.get().unwrap();
    let handlers = match handlers_lock.read() {
        Ok(lock) => lock,
        Err(poisoned) => {
            debug!("handles lock erro {:?}", poisoned);
            poisoned.into_inner()
        }
    };
    for handler in handlers.iter() {
        match handler.matches(&stream) {
            Some(true) => {
                call_script(handler.handle(stream));
                return;
            }
            _ => {
                continue;
            }
        }
    }

    return call_script(Box::new(stream));
}
