use std::{fmt::format, net::UdpSocket, thread::spawn};

use super::udp_base::Client;

pub struct Play{
    to: Client,
    from: Client,
    body: Vec<u8>
}

impl Play {
    fn new()->Self{
        return Play{
            to: todo!(),
            from: todo!(),
            body: todo!(),
        }
    }

    fn from_byte(data: &[u8])->Self{
        return Play{
            to: todo!(),
            from: todo!(),
            body: todo!(),
        };
    }

    fn send_to(&self, socket: UdpSocket){
        socket.send_to(&self.body, self.to.addr).unwrap();
    }
}

pub fn handle(socket:UdpSocket){
    let mut buffer = [0u8;1024];
    if let Ok((len, addr)) = socket.recv_from(&mut buffer){
        spawn(move|| {

        });
    }
}
