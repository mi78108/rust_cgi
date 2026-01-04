use std::{
    collections::HashMap,
    io::{Error, ErrorKind},
    path::PathBuf,
    sync::atomic::AtomicUsize,
};

use tokio::{
    fs::File,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter},
    sync::Mutex,
};

use crate::{OPT, debug, error, tcp_class::Tcp, utils::core::Req};

#[derive(Debug)]
pub struct FileSync {
    file_reader: Mutex<BufReader<File>>,
    file_writer: Mutex<BufWriter<File>>,
    file_path: PathBuf,
    file_key: Option<String>,
    file_lenght: u64,
    file_processed: AtomicUsize,
    file_header: HashMap<String, String>,
}

impl Req for FileSync {
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
                Ok(Some(len))
            })
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

impl FileSync {
    pub async fn matches() -> bool {
        OPT.get().unwrap().input.is_some() && OPT.get().unwrap().key.is_some()
    }

    pub async fn handle() -> Result<Self, Error> {
        todo!()
    }

    pub async fn reader(req: &Tcp) -> Result<Self, Error> {
        let mut file_key = String::new();
        req.req_reader.lock().await.read_line(&mut file_key).await?;
        let key_file: HashMap<String, String> = OPT
            .get()
            .map(|cfg| {
                let keys = cfg.key.clone().unwrap_or_default();
                let values = cfg.input.clone().unwrap_or_default();
                keys.into_iter().zip(values.into_iter()).collect()
            })
            .unwrap_or_default();
        if key_file.is_empty() {
            return Err(Error::new(ErrorKind::InvalidInput, "File Key Invalid"));
        }

        let file_rst = key_file
            .iter()
            .find(|v| (file_key.trim()).eq_ignore_ascii_case(v.0.trim()));
        if file_rst.is_none() {
            return Err(Error::new(ErrorKind::InvalidInput, "File Key Not Exist"));
        }
        let file_path = PathBuf::from(file_rst.unwrap().1);
        if !file_path.exists() || !file_path.is_file() {
            return Err(Error::new(ErrorKind::InvalidInput, "File Not Exists"));
        }
        let file = File::open(&file_path).await?;
        let reader = file.try_clone().await?;
        let writer = file.try_clone().await?;
        Ok(FileSync {
            file_reader: Mutex::new(BufReader::new(reader)),
            file_writer: Mutex::new(BufWriter::new(writer)),
            file_path: file_path,
            file_key: Some(String::from(&file_key)),
            file_lenght: file.metadata().await?.len(),
            file_processed: AtomicUsize::new(0),
            file_header: HashMap::from([
                ("Req_Buffer_Size".to_string(), (1024 * 128).to_string()),
                ("Req_File_Key".to_string(), file_key.to_string()),
            ]),
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
