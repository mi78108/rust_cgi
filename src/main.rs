use mio::Poll;
use std::net::{SocketAddr, TcpListener, UdpSocket};
use clap::Parser;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::thread::{self};

use crate::lib::thread_pool_mio::ThreadPool;
use crate::tcp_class::tcp_base::default_register_protocol;

#[macro_use]
extern crate log;

mod lib;
mod tcp_class;
mod udp_class;
mod utils;

static CGI_DIR: OnceLock<PathBuf> = OnceLock::new();
static THREAD_POOL: OnceLock<ThreadPool> = OnceLock::new();

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Cli {
    #[arg(short = 'p', long = "port", default_value = "3000")]
    port: u16,

    #[arg(short = 't', long = "thread", default_value = "4")]
    threads: u16,
    /// 数据存储目录（默认：./data）
    #[arg(short = 'f', long = "cgi", default_value = "./src/cgi")]
    cgi: String,

    #[arg(short = 'h', long = "host", default_value = "127.0.0.1")]
    host: String,

    /// 最大连接数（默认：100）
    #[arg(long = "max-conn", default_value_t = 100)]
    max_conn: usize,
}

/// # 简单的实现了CGI的小工具
/// - 简单使用线程允许多访问 但并发受限制
/// - 判断脚本结束的策略有待改进
fn main() {
    env_logger::init();
    let cli = Cli::parse();

    CGI_DIR.get_or_init(|| {
        debug!("Set Cgi Dir Path: {}", cli.cgi);
        PathBuf::from(cli.cgi.clone())
    });
    THREAD_POOL.get_or_init(|| ThreadPool::new(4));
    // if let Some(serv) = matches.values_of("serv") {
    //     serv.enumerate().for_each(|(i, v)| {
    //         if let Ok(mut write) = udp_class::udp_base::CLIENTS.write() {
    //             write.insert(
    //                 format!("serv_{}", i),
    //                 Client {
    //                     from: "static".to_string(),
    //                     addr: SocketAddr::from_str(v).unwrap(),
    //                     name: format!("SERV_{}", i),
    //                     via: None,
    //                 },
    //             );
    //         }
    //     });
    // }


    let addr_basic = format!("{}:{}", cli.host, cli.port);
    // if matches.is_present("udp") {
    //     let udp_listener = UdpSocket::bind(addr).expect(format!("udp bind {} erro", addr).as_str());
    //     spawn(move || {
    //         udp_listener.set_broadcast(true).unwrap();
    //         udp_class::udp_base::handle(udp_listener);
    //     });
    // }

    let tcp_listener = TcpListener::bind(&addr_basic).expect(format!("bind {} erro", addr_basic).as_str());
    default_register_protocol();
    info!(
        "Listen on [{}] CGI in [{}]",
        addr_basic,
        CGI_DIR.get().unwrap().to_string_lossy()
    );
    for stream in tcp_listener.incoming() {
        match stream {
            Ok(_stream) => {
                    debug!(
                        "<{:?}> tcp call start new Req thread started",
                        thread::current().id()
                    );
                    tcp_class::tcp_base::handle(_stream.into());
                    debug!(
                        "<{:?}>tcp call end handle Req thread   ended\n\n",
                        thread::current().id()
                    );
            }
            Err(e) => {
                error!("Tcp handle erro {:?}", e)
            }
        };
    }
}
