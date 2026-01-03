use clap::Parser;
use std::env;
use std::{collections::HashMap, io::Error, path::PathBuf, sync::OnceLock};
use std::sync::atomic::AtomicU8;
use tokio::net::TcpListener;
mod tcp_class;
mod utils;

use crate::tcp_class::handle;
use crate::utils::local_log::LOG_LEVEL;

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Opt {
    #[arg(short = 'f', long, required = false, default_value = "")]
    path: String,
    #[arg(short = 'b', long, required = false, default_value = "127.0.0.1")]
    bind: String,
    #[arg(short = 'p', long, required = false, default_value = "3000")]
    port: u32,
    #[arg(short = 'v', long, action = clap::ArgAction::Count)]
    verbose: u8,
    #[arg(short = 't', long, required = false, default_value = "2")]
    thread: u32,
}

pub trait Req: Sync + Send + 'static {
    fn read(&self, data: &mut [u8]) -> impl Future<Output = Result<Option<usize>, Error>> + Send;
    fn write(&self, data: &[u8]) -> impl Future<Output = Result<usize, Error>> + Send;
    fn close(&self) -> impl Future<Output = Result<(), Error>> + Send;
    fn env(&self) -> &HashMap<String, String>;
}

pub trait Handle<T: Req>: Sync + Send + 'static {
    fn name() -> &'static str;
    fn matches(stream: &T) -> impl Future<Output = bool> + Send;
    //fn match_from(stream: Tcp) -> impl Future<Output = (Option<Self>, Option<Tcp>)> + Send where Self: Sized;
    fn handle(stream: T) -> impl Future<Output = Result<Self, Error>> + Send
    where
        Self: Sized;
}

pub static SCRIPT_DIR: OnceLock<PathBuf> = OnceLock::new();

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let opt = Opt::parse();
    let addr_basic = format!("{}:{}", opt.bind, opt.port);
    SCRIPT_DIR.get_or_init(|| {
        if (&opt).path.is_empty() {
            env::current_dir().unwrap()
        } else {
            env::current_dir().unwrap().join(&opt.path)
        }
    });
    LOG_LEVEL.get_or_init(|| {
        AtomicU8::new(opt.verbose)
    });

    info!("Starting server on {} script in {}", addr_basic, SCRIPT_DIR.get().unwrap().display());

    let tcp_listener = TcpListener::bind(&addr_basic)
        .await
        .expect(&format!("bind {} erro", addr_basic));
    while let Ok((stream, addr)) = tcp_listener.accept().await {
        info!("Connection Incomin from {}", addr);
        tokio::spawn(async move {
            let rst = handle(stream, addr).await;
            info!("Connection terminated {} status {:?}\n\n", addr, rst);
        });
    }
    info!("Server terminated");
}
