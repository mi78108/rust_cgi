use clap::{App, Arg};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::RwLock;
use std::{io, process, vec};
use std::fmt::format;

#[macro_use]
extern crate log;
#[macro_use]
extern crate lazy_static;

mod http_func;
mod tcp_class;
lazy_static! {
    static ref WDIR: RwLock<String> = RwLock::new(String::from("/tmp"));
}
// todo
fn main() {
    env_logger::init();
    let matches = App::new("A WebService Program")
        .version("1.0")
        .author("mi78108@live.com>")
        .arg(
            Arg::with_name("workdir")
                .short("f")
                .long("cgi")
                .help("www cgi work dir")
                .takes_value(true).default_value("./"),
        )
        .arg(
            Arg::with_name("addr")
                .short("l")
                .long("addr")
                .help("bind address")
                .takes_value(true),
        )
        .arg(
            Arg::with_name("host")
                .short("h")
                .long("host")
                .help("bind host address")
                .takes_value(true).conflicts_with("addr").requires("port")
        )
        .arg(
            Arg::with_name("port")
                .short("p")
                .long("port")
                .help("bind port address")
                .takes_value(true).conflicts_with("addr").requires("host")
        )
        .get_matches();

    if let Some(wd) = matches.value_of("workdir") {
        if let Ok(mut wwd) = WDIR.write() {
            wwd.clear();
            wwd.push_str(wd);
        };
        info!("set workdir [{}]", wd);
    }

    let addr = match matches.is_present("addr") {
        true =>  matches.value_of("addr").unwrap_or_else(|| "0.0.0.0:8080").to_string(),
        false => format!("{}:{}",matches.value_of("host").unwrap(), matches.value_of("port").unwrap())
    };
    let addr = addr.as_str();

    let listener = TcpListener::bind(addr).expect(format!("bind {} erro", addr).as_str());
    info!("Listen on [{}] Work in [{}]", addr, WDIR.read().unwrap());
    for stream in listener.incoming() {
        match stream {
            Ok(_stream) => {
                std::thread::spawn(move || {
                    println!("call start new Req thread started");
                    handle(_stream);
                    println!("call end handle Req thread ended\r\n\r\n");
                });
            }
            Err(e) => {
                error!("Tcp handle erro {:?}", e)
            }
        };
    }

    fn handle(stream: TcpStream) {
        let mut buffer = [0u8; 16];
        if let Err(e) = stream.peek(&mut buffer) {
            error!("Tcp handle read erro {:?}", e)
        }
        if String::from_utf8_lossy(&buffer[..])
            .to_uppercase()
            .contains("HTTP")
        {
            debug!("Tcp Req Handled With HTTP");
            tcp_class::call_script(http_func::parse_req(stream));
        } else {
            debug!("Tcp Req Handled With Tcp default");
            tcp_class::call_script(tcp_class::parse_req(stream));
        }
    }
}
