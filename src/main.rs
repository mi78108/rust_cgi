use clap::{App, Arg};
use udp_class::udp_base::Client;
use std::net::{SocketAddr, TcpListener, UdpSocket};
use std::str::FromStr;
use std::sync::OnceLock;
use std::thread::spawn;

#[macro_use]
extern crate log;

mod tcp_class;
mod udp_class;
mod utils;

static WDIR: OnceLock<String> = OnceLock::new();
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
        .arg(
            Arg::with_name("serv")
            .short("s")
            .long("serv")
            .help("upstream client address")
            .takes_value(true)
            .value_delimiter(",")
        )
        .arg(
            Arg::with_name("udp")
            .short("u")
            .long("udp")
            .help("listen udp")
        )
        .get_matches();

    if let Some(wd) = matches.value_of("workdir") {
        WDIR.get_or_init(||{
            wd.to_string()
        });
        info!("set workdir [{}]", wd);
    }
    if let Some(serv) = matches.values_of("serv"){
        serv.enumerate().for_each(|(i,v)|{
            if let Ok(mut write) = udp_class::udp_base::CLIENTS.write(){
                write.insert(format!("serv_{}",i), Client { from:"static".to_string(), addr: SocketAddr::from_str(v).unwrap(), name: format!("SERV_{}",i), via: None });
            }  
        });
    }

    let addr = match matches.is_present("addr") {
        true =>  matches.value_of("addr").unwrap_or_else(|| "0.0.0.0:8080").to_string(),
        false => format!("{}:{}",matches.value_of("host").unwrap_or("127.0.0.1"), matches.value_of("port").unwrap_or("8080"))
    };
    let addr = addr.as_str();

    if matches.is_present("udp"){
        let udp_listener = UdpSocket::bind(addr).expect(format!("udp bind {} erro",addr).as_str());
        spawn(move ||{
            udp_listener.set_broadcast(true).unwrap();
            udp_class::udp_base::handle(udp_listener);
        });
    }

    let tcp_listener = TcpListener::bind(addr).expect(format!("bind {} erro", addr).as_str());
    info!("Listen on [{}] Work in [{}]", addr, WDIR.get().unwrap());
    for stream in tcp_listener.incoming() {
        match stream {
            Ok(_stream) => {
                std::thread::spawn(move || {
                    debug!("tcp call start new Req thread started");
                    tcp_class::tcp_base::handle(_stream);
                    debug!("tcp call end handle Req thread ended\r\n\r\n");
                });
            }
            Err(e) => {
                error!("Tcp handle erro {:?}", e)
            }
        };
    }


}
