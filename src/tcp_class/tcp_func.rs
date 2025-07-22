use crate::tcp_class::tcp_base::Req;
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Error, ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::process::id;
use std::sync::atomic::AtomicBool;
use std::sync::RwLock;
use std::thread::current;

#[derive(Debug)]
pub struct Tcp {
    pub req_stream: TcpStream,
    req_header: HashMap<String, String>,
    pub req_reader: RwLock<BufReader<TcpStream>>,
    pub req_writer: RwLock<BufWriter<TcpStream>>,
    pub is_closed: AtomicBool,
}

impl Req for Tcp {
    fn read(&self, data: &mut [u8]) -> Result<Option<usize>, Error> {
        self.req_reader.write().unwrap().read(data).and_then(|len| {
            if len == 0 {
                return Err(Error::from(ErrorKind::ConnectionAborted));
            }
            Ok(Some(len))
        })
    }

    fn write(&self, data: &[u8]) -> Result<usize, Error> {
        if self.is_closed.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Error::from(ErrorKind::ConnectionAborted));
        }
        self.req_writer.write().unwrap().write(data)
    }

    fn close(&self) -> Result<(), Error> {
        debug!("<{:?}:{}> Tcp connect ready close", current().id(), id());
        self.is_closed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self.req_writer.write().unwrap().flush().unwrap();
        self.req_stream.shutdown(Shutdown::Both)
    }

    fn env(&self) -> &HashMap<String, String> {
        &self.req_header
    }
}

impl From<TcpStream> for Tcp {
    fn from(stream: TcpStream) -> Self {
        {
            let writer = stream.try_clone().unwrap();
            let reader = stream.try_clone().unwrap();
            Tcp {
                req_stream: stream,
                req_header: HashMap::new(),
                req_reader: RwLock::new(BufReader::new(reader)),
                req_writer: RwLock::new(BufWriter::new(writer)),
                is_closed: AtomicBool::new(false),
            }
        }
    }
}
