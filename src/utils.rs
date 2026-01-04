pub mod local_log {
    use std::sync::OnceLock;
    use std::sync::atomic::AtomicU8;

    pub static LOG_LEVEL: OnceLock<AtomicU8> = OnceLock::new();

    #[macro_export]
    macro_rules! info {
        // 匹配：log!(级别, 格式化字符串, 参数...)
        ($fmt:literal $(, $args:expr)*) => {{
            if $crate::LOG_LEVEL.get().unwrap().load(std::sync::atomic::Ordering::Relaxed) > 0 {
                use std::thread::current;
                use tokio::task::try_id;
                // 1. 格式化时间（Rust 1.8+ 需引入 `time` 包，或用标准库 `SystemTime`）
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                // 2. 拼接日志内容
                let log_content = format!($fmt $(, $args)*);
                let task_id = try_id().and_then(|v| Some(v.to_string())).unwrap_or("_".to_string());
                // 3. 输出到控制台（可替换为文件/网络等）
                eprintln!("[{}] [INFO] [{}:{}] <{:?}:{}> {}", now, module_path!(), line!(), current().id(), task_id, log_content);
            }
        }};
    }

    #[macro_export]
    macro_rules! debug {
        // 匹配：log!(级别, 格式化字符串, 参数...)
        ($fmt:literal $(, $args:expr)*) => {{
            if $crate::LOG_LEVEL.get().unwrap().load(std::sync::atomic::Ordering::Relaxed) > 1 {
                use std::thread::current;
                use tokio::task::try_id;
                // 1. 格式化时间（Rust 1.8+ 需引入 `time` 包，或用标准库 `SystemTime`）
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                // 2. 拼接日志内容
                let log_content = format!($fmt $(, $args)*);
                let task_id = try_id().and_then(|v| Some(v.to_string())).unwrap_or("_".to_string());
                // 3. 输出到控制台（可替换为文件/网络等）
                eprintln!("[{}] [DEBUG] [{}:{}] <{:?}:{}> {}", now, module_path!(), line!(), current().id(), task_id, log_content);
            }
        }};
    }

    #[macro_export]
    macro_rules! error {
        // 匹配：log!(级别, 格式化字符串, 参数...)
        ($fmt:literal $(, $args:expr)*) => {{
            if $crate::LOG_LEVEL.get().unwrap().load(std::sync::atomic::Ordering::Relaxed) > 1 {
                use std::thread::current;
                use tokio::task::try_id;
                // 1. 格式化时间（Rust 1.8+ 需引入 `time` 包，或用标准库 `SystemTime`）
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                // 2. 拼接日志内容
                let log_content = format!($fmt $(, $args)*);
                let task_id = try_id().and_then(|v| Some(v.to_string())).unwrap_or("_".to_string());
                // 3. 输出到控制台（可替换为文件/网络等）
                eprintln!("[{}] [ERROR] [{}:{}] <{:?}:{}> {}", now, module_path!(), line!(), current().id(), task_id, log_content);
            }
        }};
    }
}

pub mod core {
    use std::{
        collections::HashMap,
        io::{Error, ErrorKind},
        path::{Path, PathBuf},
        sync::Arc,
    };

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
        sync::Mutex,
    };

    use crate::{SCRIPT_DIR, debug, error, info};

    pub trait Req: Sync + Send + 'static {
        fn read(
            &self,
            data: &mut [u8],
        ) -> impl Future<Output = Result<Option<usize>, Error>> + Send;
        fn write(&self, data: &[u8]) -> impl Future<Output = Result<usize, Error>> + Send;
        fn close(&self) -> impl Future<Output = Result<(), Error>> + Send;
        fn env(&self) -> &HashMap<String, String>;
    }

    pub trait Handle<T: Req>: Sync + Send + 'static {
        fn name() -> &'static str;
        fn matches(req: &T) -> impl Future<Output = bool> + Send;
        //fn match_from(stream: Tcp) -> impl Future<Output = (Option<Self>, Option<Tcp>)> + Send where Self: Sized;
        fn handle(req: T) -> impl Future<Output = Result<Self, Error>> + Send
        where
            Self: Sized;
    }

    pub struct Script {
        script: Mutex<Child>,
        script_stdin: Mutex<ChildStdin>,
        script_stdout: Mutex<ChildStdout>,
        script_stderr: Mutex<ChildStderr>,
        script_header: HashMap<String, String>,
    }

    impl Req for Script {
        async fn read(&self, data: &mut [u8]) -> Result<Option<usize>, Error> {
            self.script_stdout
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
            self.script_stdin.lock().await.write(data).await
        }

        async fn close(&self) -> Result<(), Error> {
            match self.script.lock().await.wait().await {
                Ok(status) => {
                    debug!("Script finished ok exited with {:?}", status);
                    Ok(())
                }
                Err(e) => {
                    debug!("Script finished errno exited with {:?}", e);
                    Err(e)
                }
            }
        }

        fn env(&self) -> &HashMap<String, String> {
            &self.script_header
        }
    }

    impl Script {
        pub fn new(req_env: &HashMap<String,String>) -> Result<Self, Error>{
            let req_script = Path::new(req_env.get("Req_Script_Name").unwrap());
            let script_file = PathBuf::from(SCRIPT_DIR.get().unwrap())
                .join(req_script.strip_prefix("/").unwrap_or(req_script));

            debug!(
                "Script in {:?} will exec {:?} final script file {:?}",
                SCRIPT_DIR.get(),
                req_script,
                script_file
            );
            if !script_file.exists() || !script_file.is_file() {
                info!("Script file {:?} does not valid", script_file);
                return Err(Error::new(ErrorKind::InvalidInput, ""));
            }

            let mut cmd = Command::new(script_file)
                .env_clear()
                .envs(req_env)
                .current_dir(SCRIPT_DIR.get().unwrap())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()?;

            Ok(Script {
                script_header: HashMap::from([("Req_Buffer_Size".to_string(),(1024 * 128).to_string())]),
                script_stdin: Mutex::new(cmd.stdin.take().unwrap()),
                script_stdout: Mutex::new(cmd.stdout.take().unwrap()),
                script_stderr: Mutex::new(cmd.stderr.take().unwrap()),
                script: Mutex::new(cmd),
            })
        }
    }

    pub async fn call_script<T: Req>(req: T) -> bool {
        if let Ok(script)  = Script::new(req.env()) {
            return call_bridge(req, script).await
        }
        false
    }


    pub async fn call_bridge<A: Req, B: Req>(req_src: A, req_dst: B) -> bool {
        let req_src = Arc::new(req_src);
        let reader_src = Arc::clone(&req_src);
        let writer_src = Arc::clone(&req_src);

        let req_dst = Arc::new(req_dst);
        let reader_dst = Arc::clone(&req_dst);
        let writer_dst = Arc::clone(&req_dst);
        let src = tokio::spawn(async move {
            let mut rst = vec![
                0u8;
                reader_src
                    .env()
                    .get("Req_Buffer_Size")
                    .unwrap()
                    .parse::<usize>()
                    .unwrap()
            ];
            while let Ok(Some(len)) = reader_src.read(&mut rst).await {
                debug!("Req src read {} bytes", len);
                if len == 0 {
                    debug!("Req src read Zero will closed");
                    break;
                }
                writer_dst.write(&rst[0..len]).await.unwrap();
            }
            //
            writer_dst.close().await.unwrap();
        });

        let dst = tokio::spawn(async move {
            let mut rst = vec![
                0u8;
                reader_dst
                    .env()
                    .get("Req_Buffer_Size")
                    .unwrap()
                    .parse::<usize>()
                    .unwrap()
            ];
            while let Ok(Some(len)) = reader_dst.read(&mut rst).await {
                debug!("Req dst read {} bytes", len);
                if len == 0 {
                    debug!("Req dst read Zero will closed");
                    break;
                }
                writer_src.write(&rst[0..len]).await.unwrap();
            }
            //
            writer_src.close().await.unwrap();
        });

        let (src_rst, dst_rst) = tokio::join!(src, dst);
        if let Err(e) = src_rst {
            error!("Req Bridge src error {:?}", e);
            return false;
        }
        if let Err(e) = dst_rst {
            error!("Req Bridge dst error {:?}", e);
            return false;
        }
        debug!("Req Bridge finished");
        true
    }
}
