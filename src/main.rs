use clap::Parser;
use std::env;
use std::{path::PathBuf, sync::OnceLock};
use tokio::net::TcpListener;
mod tcp_class;
mod utils;

use crate::tcp_class::{Tcp, handle};
use crate::utils::local_log::{logger_init, LOG_LEVEL};

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Opt {
    #[arg(short = 'f', long, required = false, default_value = "cgi")]
    path: String,
    #[arg(short = 'b', long, required = false, default_value = "127.0.0.1")]
    bind: String,
    #[arg(short = 'p', long, required = false, default_value = "3000")]
    port: u32,
    #[arg(short = 't', long, required = false, default_value = "2")]
    thread: u32,
    #[arg(short = 'm', long, required = false, default_value = "131072")]
    buffer: u32,
    #[arg(short = 'v', long, action = clap::ArgAction::Count)]
    verbose: u8,
    #[arg(short = 'k', long, required = false)]
    key: Option<Vec<String>>,
    #[arg(short = 'o', long, required = false)]
    output: Option<Option<PathBuf>>,
    #[arg(short = 'i', long, required = false, action = clap::ArgAction::Append)]
    input: Option<Vec<String>>,
}

pub static SCRIPT_DIR: OnceLock<PathBuf> = OnceLock::new();
static OPT: OnceLock<Opt> = OnceLock::new();

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
    
    logger_init(opt.verbose);

    info!(
        "Starting server on {} script in {} opt: {:?}",
        addr_basic,
        SCRIPT_DIR.get().unwrap().display(),
        opt
    );

    OPT.get_or_init(|| opt);

    let tcp_listener = TcpListener::bind(&addr_basic)
        .await
        .expect(&format!("bind {} erro", addr_basic));
    while let Ok((stream, addr)) = tcp_listener.accept().await {
        info!("Connection Incoming from {}", addr);
        tokio::spawn(async move {
            let tcp = Tcp::from((stream, addr));
            handle(tcp)
                .await
                .map(|status| info!("Connection terminated {} status {:?}\n\n", addr, status))
                .map_err(|e| error!("Connection terminated {} status {:?}\n\n", addr, e))
        });
    }
    info!("Server terminated");
}
