use std::net::{SocketAddr, UdpSocket};
use std::io::{Read, Write};
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::str::FromStr;
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::thread::spawn;

use crate::{udp_class, WDIR};

pub static CLIENTS:LazyLock<RwLock<HashMap<String,Client>>> = LazyLock::new(||{
    RwLock::new(HashMap::new())
});

#[derive(Clone,Debug)]
pub struct Client{
    pub from:String,
    pub addr:SocketAddr,
    pub name:String,
    pub via:Option<Box<Client>>
}

impl Client {
    pub fn addr_string(&self)->String{
        format!("{}:{}",self.addr.ip(),self.addr.port())
    }

    pub fn get_id(&self) ->String{
        match &self.via {
            Some(via)=> format!("{}<{}",format!("{}",self.addr.ip()),via.addr.ip()),
            None => format!("{}",self.addr.ip())
        }
    }

    pub fn from_str(data:&str,from:&str)->Option<Self>{
        let rst:Vec<&str> = data.split("|").collect();
        if rst.len() >= 2 {
            let via = Client::from_str(rst[2..].join("|").as_str(),from).and_then(|v| Option::Some(Box::new(v)));
            return Some(Client { from: from.to_string(),addr: SocketAddr::from_str(rst.get(0).unwrap()).unwrap(), name: rst.get(1).unwrap().to_string(), via });
        }
        return None;
    }
    pub fn to_parse(&self)->String{
        let rst = format!("{}|{}",self.addr,self.name);
        if let Some(via) = &self.via {
            return format!("{}|{}",rst,via.to_parse());
        }
        return rst;
    }


    pub fn to_json_string(&self)->String{
        let mut rst = String::new();
        rst += "{";
        rst += format!("\"{}\":\"{}\",","ip",self.addr.ip()).as_str();
        rst += format!("\"{}\":\"{}\",","port",self.addr.port()).as_str();
        rst += format!("\"{}\":\"{}\",","hostname",self.name).as_str();
        rst += format!("\"{}\":\"{}\",","from",self.from).as_str();
        if let Some(via) = &self.via{
            rst += format!("\"{}\":{},","via",via.to_json_string()).as_str();
        }
        rst += format!("\"{}\":\"{}\"","string",self.to_parse()).as_str();
        rst.push_str("}");
        rst
    }
}

#[test]
fn test(){
}


fn call_script(socket:UdpSocket){
    let mut buffer = [0u8;1024];
    if let Ok((len,addr)) = socket.recv_from(&mut buffer){
        debug!("call_script read data [{}] from {}:{}",len,addr.ip().to_string(),addr.port());
        spawn(move ||{
            let mut script = Command::new("./udp_handle");
            script.current_dir(WDIR.get().unwrap().as_str())
                .env_clear()
                .envs(HashMap::from([   (
                            "Req_Peer_Addr".to_string(),
                            format!("{}:{}", addr.ip().to_string(), addr.port()),
                ),
                (
                    "Req_Peer_Ip".to_string(),
                    format!("{}", addr.ip().to_string()),
                ),
                ("Req_Peer_Port".to_string(), format!("{}", addr.port())),
                ("req_body_method".to_string(), "UDP".to_string()),
                ("req_script_path".to_string(), "/udp_handle".to_string()),
                ]))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped());

            match script.spawn() {
                Ok(mut child)=>{
                    let pid = child.id();
                    let mut script_stdin = child.stdin.take().unwrap();
                    let mut script_stdout = child.stdout.take().unwrap();

                    if let Err(e) = script_stdin.write_all(&buffer[0..len]){
                        error!("[{}] udp script stdin write erro {:?}",pid, e);
                    }
                    while let Ok(len) =  script_stdout.read(&mut buffer) {
                        debug!("[{}] udp script stdout read {}",pid,len);
                        if len == 0 {
                            break;
                        }
                        socket.send_to(&buffer[0..len], addr).unwrap();
                    }
                    if let Err(e) = child.kill() {
                        error!("[{}] script kill erro {:?}",pid, e)
                    }
                    debug!("[{}] script kill done wait result",pid);
                    if let Ok(code) = child.wait() {
                        debug!("[{}] >>> [udp_handle] script kill done [{:?}]",pid,code);
                        if !code.success() {
                            error!("[{}] script exit erro [{:?}]", pid, code);
                        }
                    }
                },
                Err(e) =>{
                    error!("udp script spawn  erro {:?}", e);
                }
            }
            debug!("udp script spawn end");
        });
    };

}

pub fn handle(socket:UdpSocket){
    udp_class::echo_func::init(socket.try_clone().unwrap());

    let mut buffer = [0u8;16];
    loop {
        match socket.peek(&mut buffer)  {
            Ok(len)=>{
                debug!("Handled new udpStream {:?}",&buffer[0..len]);
                let socket = socket.try_clone().unwrap();
                if buffer.starts_with(&[0x5,0x1]){
                    //udp tun_service
                    //udp_class::utun_func::handle(socket);
                }else if buffer.starts_with(&[0x5,0x2]) {
                    //udp echo_service
                    udp_class::echo_func::handle(socket);
                }else {
                    debug!("udp_handle to call_script");
                    call_script(socket);
                }
            },
            Err(e)=>{
                error!("Udp handle read erro {:?}", e)
            }
        }
    } 
}
