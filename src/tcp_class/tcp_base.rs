
use crate::lib::thread_pool_mio::WorkerCommand;
use crate::tcp_class::http_func::HttpHandle;
use crate::tcp_class::tcp_func::Tcp;
use crate::{CGI_DIR, THREAD_POOL};
use std::collections::HashMap;
use std::io::{Error, Read, Write};
use std::net::TcpStream;
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
    fn stream(&self) -> TcpStream;
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
            "unkown"
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
        return;
    };

    let script_id = child.id();
    let script_path = script_path.clone();
debug!("3333333333333333333");
    //
    let task = WorkerCommand::CreateGroup(req.stream(), child.stdin.unwrap());
    debug!("111111111111111111111111111111111111");
    THREAD_POOL.get().unwrap().execute(task);
    debug!("222222222222222222222222222222222");
}

static PROTOCOL_HANDLERS: OnceLock<RwLock<Vec<Arc<dyn Handle>>>> = OnceLock::new();

pub fn register_protocol(handler: Arc<dyn Handle>) {
    let mut handlers = PROTOCOL_HANDLERS.get().unwrap().write().unwrap();
    if !handlers.iter().any(|h| h.name() == handler.name()) {
        handlers.push(handler.clone());
        info!(
            "注册协议：{}，当前协议总数：{}",
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
            debug!("协议选择器锁异常，恢复数据");
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
