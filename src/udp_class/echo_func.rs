use std::{net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket}, process::{Command, Stdio}, str::FromStr, sync::{Arc, LazyLock, Mutex, RwLock}, thread::spawn, time::Duration};

use crate::udp_class::{self, udp_base::Client};

pub static HOSTNAME:LazyLock<String> = LazyLock::new(||{
    get_host_name()
});

pub fn init(socket:UdpSocket){
    spawn(move ||{
        socket.set_broadcast(true).unwrap();
        loop {
            for addr in get_broadcast_addrs() {
                socket.send_to(format!("\x05\x02pinghere:{}",HOSTNAME.as_str()).as_bytes(), SocketAddr::new(addr, socket.local_addr().unwrap().port())).unwrap();
            };
            if let Ok(read) = udp_class::udp_base::CLIENTS.read() {
                read.iter().for_each(|(_,v)| {
                    socket.send_to(format!("\x05\x02pinghere:{}",HOSTNAME.as_str()).as_bytes(), v.addr).unwrap();
                });
            }
            std::thread::sleep(Duration::from_secs(70));
        };
    });
}


pub fn handle(socket:UdpSocket){
    let mut buffer = [0u8;1024];
    if let Ok((len, addr)) = socket.recv_from(&mut buffer){
        spawn(move|| {
            match &buffer[2..len] {
                v if v.starts_with(b"ponghere") =>{
                    let load = String::from_utf8_lossy(&buffer[11..len]);
                    let argv:Vec<&str> = load.split("|").collect();
                    debug!("recv pong resp from {} [{}]",addr,load);
                    if addr.to_string().ne(argv.get(0).unwrap()){
                       let via =  Some(Box::new(Client { from: "pong".to_string(), addr: SocketAddr::from_str(argv.get(0).unwrap()).unwrap(), name: HOSTNAME.to_string(), via: None }));
                        if let Ok(mut write) = udp_class::udp_base::CLIENTS.write() {
                            write.insert(addr.ip().to_string(),  udp_class::udp_base::Client {
                                from:"pong".to_string(),
                                addr,
                                name: argv.get(1).unwrap_or(&"").to_string(),
                                via: via.clone()
                            });
                        }
                        if let Ok(read) = udp_class::udp_base::CLIENTS.read() {
                            read.iter().for_each(|(_,v)| {
                                if v.from.eq("pong") {
                                let mut client = v.clone();
                                client.via = via.clone();
                                socket.send_to(format!("\x05\x02exhehere:{}", client.to_parse()).as_bytes(), addr).unwrap();
                                }
                            });
                        }
                    }
                    println!("done");

                },
                v if v.starts_with(b"exhehere") => {
                    let load = String::from_utf8_lossy(&buffer[11..len]);
                    debug!("recv exhehere resp from {} {} [{}]",len,addr.ip(),load);
                    if let Ok(mut write) = udp_class::udp_base::CLIENTS.write() {
                        if let Some(client) = udp_class::udp_base::Client::from_str(&load,"exchange"){
                            write.insert(client.get_id(),  client);
                        }else {
                            error!("recv pong cannot parse to client")
                        }
                    }
                },
                v if v.starts_with(b"pinghere") =>{
                    let load = String::from_utf8_lossy(&buffer[11..len]);
                    debug!("recv ping req from {} [{}]",addr.ip(),load);
                    //if let Ok(mut write) = udp_class::udp_base::CLIENTS.write() {
                    //    write.insert(addr.ip().to_string(),  udp_class::udp_base::Client { 
                    //        from:"ping".to_string(),
                    //        addr,
                    //        name: String::from_str(&load).unwrap_or(String::new()),
                    //        via: None
                    //    });
                    //}
                    socket.send_to(format!("\x05\x02ponghere:{}|{}",addr,HOSTNAME.as_str()).as_bytes(), addr).unwrap();
                },
                v if v.starts_with(b"client_list") =>{
                    println!("获取客户端 列表");
                    if let Ok(read) = udp_class::udp_base::CLIENTS.read() {
                        let clients = read.iter().map(|(k,v)| {
                            let mut rst = String::new();
                            rst.push_str("{");
                            rst += format!("\"{}\":\"{}\",","key",k.to_string()).as_str();
                            rst += format!("\"{}\":{}","value",v.to_json_string()).as_str();
                            rst.push_str("}");
                            rst
                        }).collect::<Vec<String>>().join(",");
                        socket.send_to(format!("[{}]",clients).as_bytes(), addr).unwrap();
                    }
                    println!("获取客户端 列表完成");
                }
                _ => {
                    error!("udp echo_func unknown handle {:?}",&buffer[0..len])
                }
            }
        });
    }
}


fn get_host_name() -> String{
    if let Ok(handle) =  Command::new("sh").arg("-c").arg("cat /etc/hostname").stdout(Stdio::piped()) .spawn() {
        if let Ok(val) = handle.wait_with_output() {
            if val.status.success() {
                return String::from_utf8_lossy(&val.stdout).trim().to_string()
            }
        }
    }
    error!("get hostname erro");
    String::new()
}

fn get_broadcast_addrs() ->Vec<IpAddr>{
    let mut rst = Vec::new();
    match Command::new("sh").arg("-c").arg("ip addr | grep -oP '(?<=brd ).*?(?= )' | sort | uniq").stdout(Stdio::piped()) .spawn() {
        Ok(handle)=>{
            if let Ok(val) = handle.wait_with_output() {
                if val.status.success() {
                    String::from_utf8_lossy(&val.stdout).trim().split("\n").for_each(|saddr| {
                        println!(">>>>>>>>>>>>>> {:?}",saddr);
                        rst.push(IpAddr::V4(Ipv4Addr::from_str(saddr).unwrap()));
                    })
                }
            }
        },
        Err(e)=>{
            error!("get broadcast erro {:?}",e)
        }
    }
    return rst;
}
