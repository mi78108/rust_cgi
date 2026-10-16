use crate::tcp_class::http_func::Http;
use crate::{OPT, debug, error, utils::core::Req};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    collections::HashMap,
    io::{Error},
    path::PathBuf,
};
use std::io::SeekFrom;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncWriteExt, BufReader, BufWriter},
    sync::Mutex,
};
use tokio::io::AsyncSeekExt;

#[derive(Debug)]
pub struct WWWFile {
    base_on: Http,
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
     async fn send_body(&self) -> Result<usize, Error> {
         debug!("WWWFile send file by body {}",self.file_length);
         let mut buffer = [0u8;1024 * 128];
         self.base_on.write_header("200", "OK", self.env()).await?;
         while let Ok(Some(size)) = self.read(&mut buffer).await {
             self.base_on.write(&buffer[0..size]).await?;
         }
        self.base_on.close().await?;
        Ok(self.file_length)
    }

    fn parse_range(header: &str, total: u64) -> Option<(u64, u64)> {
        let spec = header.trim().strip_prefix("bytes=")?.trim();
        let (l, r) = spec.split_once('-')?;

        let (start, end) = match (l.is_empty(), r.is_empty()) {
            (false, false) => (l.parse().ok()?, r.parse().ok()?),
            (false, true)  => (l.parse().ok()?, total.checked_sub(1)?),
            (true,  false) => (total.checked_sub(r.parse().ok()?)?, total.checked_sub(1)?),
            (true,  true)  => return None,
        };

        if start > end || start >= total {
            return None;
        }
        Some((start, end.min(total - 1)))
    }

    pub async fn send_file(&self) -> Result<usize, Error> {
        if let Some(rg) = self.base_on.env().get("range") {
            //Range: bytes=1000-1999
            if let Some((s,e)) = Self::parse_range(rg,self.file_length as u64) {
                let len = e - s + 1;
                debug!("WWWFile send file by range {}:{}/{}={}", s,e,self.file_length,len);
                let mut env = self.env().clone();
                env.insert("Accept-Ranges".to_string(), "bytes".to_string());
                env.insert("Content-Range".to_string(), format!("bytes {}-{}/{}", s, e,self.file_length));
                env.insert("Content-Length".to_string(), len.to_string());
                self.base_on.write_header("206", "Partial Content", &env).await?;
                let mut reader = self.file_reader.lock().await;
                reader.seek(SeekFrom::Start(s)).await?;

                let mut remaining = len;
                let mut buffer = vec![0u8; 64 * 1024];
                while remaining > 0 {
                    let want = remaining.min(buffer.len() as u64) as usize;
                    let n = reader.read(&mut buffer[..want]).await?;
                    if n == 0 {
                        break;
                    }
                    self.base_on.write(&buffer[..n]).await?;
                    remaining -= n as u64;
                }
                self.base_on.close().await?;
                return Ok(self.file_length);
            }
        }
        self.send_body().await
    }



    pub async fn handle(req: Http) -> Result<Self, Http> {
        if OPT.get().unwrap().www.is_none() {
            //return Err(Error::new(ErrorKind::NotFound, "not www file req"));
            return Err(req);
        }
        let mut file_path = PathBuf::from("/");
        if let Some(req_path) = req.env().get("Req_Path") {
            if let Some(prefix) = OPT.get().unwrap().www.as_ref() {
                // debug!(">>> {:?}", prefix);
                // -w:tmp
                //-w/tmp
                let mut kv = prefix.splitn(2, ':');
                if let (Some(src), vir_opt) = (kv.next(), kv.next()) {
                    file_path.push(src);
                    // debug!(">>> src {:?}", src);
                    // debug!(">>> vir {:?}", vir_opt);
                    // debug!("> {}", file_path.display());
                    if let Some(vir) = vir_opt {
                        let v_str = format!("{}/", vir);
                        let path = req_path.strip_prefix(v_str.as_str()).unwrap();
                        file_path.push(path);
                    } else {
                        file_path.push(req_path.strip_prefix("/pub/").unwrap());
                    }
                }
            }
            debug!("WWWFile req {}", file_path.display());
            if !file_path.exists() {
                debug!("WWWFile req {} File not found", file_path.display());
                //404
                //return Err(Error::new(ErrorKind::NotFound, "File not found"));
                return Err(req);
            }
        } else {
           // return Err(Error::new(ErrorKind::NotFound, "REQ_PATH not found"));
            return Err(req);
        }

        let file = File::open(&file_path).await.unwrap();
        let reader = file.try_clone().await.unwrap();
        let writer = file.try_clone().await.unwrap();
        let mut env = req.env().clone();
        // env.insert("Req_Body_Method".to_string(), "HTTP_FILE".to_string());
        env.insert(
            "Req_File_Path".to_string(),
            file_path.to_string_lossy().to_string(),
        );
        let file_length = file.metadata().await.unwrap().len() as usize;
        let mut header = HashMap::new();
        header.insert(
            "Content-Length".to_string(),
            file_length.to_string(),
        );

        Ok(WWWFile {
            base_on: req,
            file_reader: Mutex::new(BufReader::new(reader)),
            file_writer: Mutex::new(BufWriter::new(writer)),
            file_length,
            file_processed: AtomicUsize::new(0),
            file_header: env,
        })
    }
}
