use crate::tcp_class::http_func::Http;
use crate::{OPT, debug, error, tcp_class::Tcp, utils::core::Req};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    collections::HashMap,
    fs,
    io::{Error, ErrorKind},
    path::PathBuf,
};
use tokio::{
    fs::File,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter},
    sync::Mutex,
};

#[derive(Debug)]
pub struct WWWFile {
    file_reader: Mutex<BufReader<File>>,
    file_writer: Mutex<BufWriter<File>>,
    // file_path: PathBuf,
    // file_key: Option<String>,
    file_length: usize,
    file_processed: AtomicUsize,
    file_header: HashMap<String, String>,
}

impl Req for WWWFile {
    async fn read(&self, data: &mut [u8]) -> Result<Option<usize>, Error> {
        self.file_reader
            .lock()
            .await
            .read(data)
            .await
            .and_then(|len| {
                if len == 0 {
                    return Ok(None);
                }
                self.file_processed.fetch_add(len, Ordering::Relaxed);
                Ok(Some(len))
            })
    }

    fn remainder(&self) -> Option<usize> {
        //Some(self.file_length - self.file_processed.load(Ordering::Relaxed))
        None
    }

    async fn write(&self, data: &[u8]) -> Result<usize, Error> {
        self.file_writer.lock().await.write(data).await
    }

    async fn close(&self) -> Result<(), Error> {
        if let Err(e) = self.file_writer.lock().await.flush().await {
            error!("FileSync close error {:?}", e);
            return Ok(());
        }
        Ok(())
    }

    fn env(&self) -> &HashMap<String, String> {
        &self.file_header
    }
}

impl WWWFile {
    // pub async fn matches(stream: &Http) -> bool {
    //     if OPT.get().unwrap().www.is_some() {
    //         debug!("wwwwww");
    //         if let Some(req_path) = stream.env().get("Req_Path") {
    //             if let Some(prefix) = OPT.get().unwrap().www.as_ref() {
    //                 let mut kv = prefix.splitn(2, ':');
    //                 if let (Some(src), vir) = (kv.next(), kv.next()) {
    //                     if let Some(v) = vir {
    //                         if req_path.starts_with(v) {
    //                             return true;
    //                         }
    //                     }
    //                 }
    //             }
    //             if req_path.starts_with("/pub") {
    //                 return true;
    //             }
    //         }
    //     }
    //     false
    // }

    // pub async fn handle() -> Result<Self, Error> {
    //     todo!()
    // }
    // pub async fn parse_from(req: &Http) -> Result<Self, Error> {
    //     None
    // }

    pub async fn reader(req: &Http) -> Result<Self, Error> {
        if OPT.get().unwrap().www.is_none() {
            return Err(Error::new(ErrorKind::NotFound, "not www file req"));
        }
        let mut file_path = PathBuf::from("/");
        if let Some(req_path) = req.env().get("Req_Path") {
            if let Some(prefix) = OPT.get().unwrap().www.as_ref() {
                debug!(">>> {:?}", prefix);
                // -w:tmp
                //-w/tmp
                let mut kv = prefix.splitn(2, ':');
                if let (Some(src), vir_opt) = (kv.next(), kv.next()) {
                    file_path.push(src);
                    debug!(">>> src {:?}", src);
                    debug!(">>> vir {:?}", vir_opt);
                    debug!("> {}", file_path.display());
                    if let Some(vir) = vir_opt {
                        let v_str = format!("{}/", vir);
                        let path = req_path.strip_prefix(v_str.as_str()).unwrap();
                        file_path.push(path);
                    } else {
                        file_path.push(req_path.strip_prefix("/pub/").unwrap());
                    }
                }
            }

            debug!(">>>>>>>>>>>>>>>>>>>>> {}", file_path.display());
            if !file_path.exists() {
                //404
                return Err(Error::new(ErrorKind::NotFound, "File not found"));
            }
        } else {
            return Err(Error::new(ErrorKind::NotFound, "REQ_PATH not found"));
        }

        let file = File::open(&file_path).await?;
        let mut reader = file.try_clone().await?;
        let writer = file.try_clone().await?;
        let mut env = req.env().clone();
        // env.insert("Req_Body_Method".to_string(), "HTTP_FILE".to_string());
        env.insert(
            "Req_File_Path".to_string(),
            file_path.to_string_lossy().to_string(),
        );

        let mut header = HashMap::new();
        header.insert(
            "Content-Length".to_string(),
            file.metadata().await?.len().to_string(),
        );

        debug!(";;;;;;;;;;;;;;;;sned file");
        let mut body = String::new();
        reader.read_to_string(&mut body).await?;
        req.write_header("200", "OK", &header).await?;
        req.write(body.as_bytes()).await?;
        req.close().await?;

        Ok(WWWFile {
            file_reader: Mutex::new(BufReader::new(reader)),
            file_writer: Mutex::new(BufWriter::new(writer)),
            // file_path: file_path,
            // file_key: Some(String::from(&file_key)),
            file_length: file.metadata().await?.len() as usize,
            file_processed: AtomicUsize::new(0),
            file_header: env,
        })
    }

    // pub async fn writer(req: &Tcp) -> Result<Self, Error> {
    //     let mut file_keys = OPT.get().unwrap().key.unwrap();
    //     if file_keys.is_empty() {
    //         return Err(Error::new(ErrorKind::InvalidInput, ""))
    //     }
    //     let file_path = PathBuf::from(file_rst.unwrap().1);
    //     if !file_path.exists() || !file_path.is_file() {
    //         return Err(Error::new(ErrorKind::InvalidInput, ""))
    //     }
    //     let file = File::open(&file_path).await?;
    //     let reader = file.try_clone().await?;
    //     let writer = file.try_clone().await?;
    //     Ok(FileSync {
    //         file_reader: Mutex::new(BufReader::new(reader)),
    //         file_writer: Mutex::new(BufWriter::new(writer)),
    //         file_path: file_path,
    //         file_key: Some(String::from(&file_key)),
    //         file_lenght: file.metadata().await?.len(),
    //         file_processed: AtomicUsize::new(0),
    //         file_header: HashMap::from([
    //             ("Req_Buffer_Size".to_string(),(1024 * 128).to_string()),
    //             ("Req_File_Key".to_string(),file_key.to_string())
    //         ])
    //     })
    // }
}
