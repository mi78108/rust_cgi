pub mod local_log {
    use std::sync::OnceLock;
    use std::sync::atomic::AtomicU8;
    use std::sync::mpsc::{Receiver, Sender, channel};
    use std::thread::{self};
    pub static LOG_LEVEL: OnceLock<AtomicU8> = OnceLock::new();
    pub static LOG_SENDER: OnceLock<Sender<String>> = OnceLock::new();

    pub fn logger_init(level: u8) {
        let (send, recv): (Sender<String>, Receiver<String>) = channel();
        LOG_SENDER.get_or_init(|| send);
        LOG_LEVEL.get_or_init(|| AtomicU8::new(level));
        thread::spawn(move || {
            while let Ok(log) = recv.recv() {
                eprintln!("{}", log);
            }
        });
    }

    #[macro_export]
    macro_rules! _log_common {
        ($level:expr, $color:expr, $threshold:expr, $fmt:literal $(, $args:expr)*) => {{
            if let Some(log_level) = $crate::LOG_LEVEL.get() {
                if $threshold <= log_level.load(std::sync::atomic::Ordering::Relaxed) {
                    use std::thread::current;
                    use tokio::task::try_id;
                    use colored::Colorize;
                    use chrono::Local;

                    let now = Local::now().format("%Y-%m-%d %H:%M:%S.%3f").to_string();

                    let task_id = try_id().map(|id| id.to_string()).unwrap_or_else(|| "_".to_string());

                    let log_content = format!($fmt $(, $args)*);
                    if let Some(sender) = crate::utils::local_log::LOG_SENDER.get() {
                       if let Err(e) = sender.send(format!(
                            "[{}] [{}] [{}:{:3}] <{:?}:{}-> {}",
                            now,
                            $level.color($color),
                            module_path!(),
                            line!(),
                            current().id(),
                            task_id,
                            log_content
                        )) {
                            eprintln!("{}",e);
                        }
                    }
                }
            };
        }}
    }

    #[macro_export]
    macro_rules! info {
        ($fmt:literal $(, $args:expr)*) => {
            $crate::_log_common!("INFO ", colored::Color::Green, 1, $fmt $(, $args)*)
        };
    }

    #[macro_export]
    macro_rules! debug {
        ($fmt:literal $(, $args:expr)*) => {
            $crate::_log_common!("DEBUG", colored::Color::Yellow, 2, $fmt $(, $args)*)
        };
    }

    #[macro_export]
    macro_rules! error {
        ($fmt:literal $(, $args:expr)*) => {
            $crate::_log_common!("ERROR", colored::Color::Red, 1, $fmt $(, $args)*)
        };
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
        process::{Child, ChildStdin, ChildStdout, Command},
        sync::Mutex,
    };

    use crate::{OPT, SCRIPT_DIR, debug, error, info, tcp_class::FileSync};

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
        // fn name() -> &'static str;
        fn matches(req: &T) -> impl Future<Output = bool> + Send;
        // fn match_from(stream: Tcp) -> impl Future<Output = (Option<Self>, Option<Tcp>)> + Send where Self: Sized;
        fn handle(req: T) -> impl Future<Output = Result<Self, Error>> + Send
        where
            Self: Sized;
    }

    pub struct Script {
        script: Mutex<Child>,
        script_stdin: Mutex<Option<ChildStdin>>,
        script_stdout: Mutex<ChildStdout>,
        //script_stderr: Mutex<ChildStderr>,
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
            self.script_stdin
                .lock()
                .await
                .as_mut()
                .ok_or_else(|| Error::new(ErrorKind::BrokenPipe, "has been closed"))?
                .write(data)
                .await
        }

        async fn close(&self) -> Result<(), Error> {
            if let Some(mut stdin) = self.script_stdin.lock().await.take() {
                stdin.flush().await?;
            }

            self.script
                .lock()
                .await
                .wait()
                .await
                .map(|status| {
                    debug!("Script finished ok exited with {:?}", status);
                })
                .map_err(|e| {
                    debug!("Script finished errno exited with {:?}", e);
                    e
                })
        }

        fn env(&self) -> &HashMap<String, String> {
            &self.script_header
        }
    }

    impl Script {
        pub fn new(req_env: &HashMap<String, String>) -> Result<Self, Error> {
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
                //.env_clear()
                .envs(req_env)
                .current_dir(SCRIPT_DIR.get().unwrap())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                //                .stderr(std::process::Stdio::piped())
                .spawn()?;

            Ok(Script {
                script_header: HashMap::from([(
                    "Req_Buffer_Size".to_string(),
                    (1024 * 128).to_string(),
                )]),
                script_stdin: Mutex::new(Some(cmd.stdin.take().unwrap())),
                script_stdout: Mutex::new(cmd.stdout.take().unwrap()),
                //script_stderr: Mutex::new(cmd.stderr.take().unwrap()),
                script: Mutex::new(cmd),
            })
        }
    }

    pub async fn call_script<T: Req>(req: T) -> bool {
        if let Some(opt) = OPT.get() {
            if let Some(key) = &opt.key {
                if let Some(k) = req.env().get("Req_Script_Name") {
                    if key.contains(k) {
                       // let flsc = FileSync::matches().await;
                       // return call_bridge(req, flsc).await;
                    }
                }
            }
        }
        if let Ok(script) = Script::new(req.env()) {
            return call_bridge(req, script).await;
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
            debug!("Req_Buffer_Size src {}", rst.len());
            while let Ok(Some(read_len)) = reader_src.read(&mut rst).await {
                debug!("Req src read {} bytes", read_len);
                if read_len == 0 {
                    debug!("Req src read ZERO will closed");
                    break;
                }
                let mut remaining = &rst[0..read_len];
                while remaining.len() > 0 {
                    if let Ok(written_len) = writer_dst.write(remaining).await.inspect_err(|e| {
                        error!(
                            "Req src -> dst Write failed (written: {}/{}): {}",
                            read_len - remaining.len(),
                            read_len,
                            e
                        )
                    }) {
                        remaining = &remaining[written_len..];
                        debug!("Req src -> dst {} bytes", written_len);
                    } else {
                        break;
                    }
                }
            }
            //
            writer_dst.close().await.unwrap();
            debug!("Req src read end");
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
            while let Ok(Some(read_len)) = reader_dst.read(&mut rst).await {
                debug!("Req dst read {} bytes", read_len);
                if read_len == 0 {
                    debug!("Req dst read ZERO will closed");
                    break;
                }
                let mut remaining = &rst[0..read_len];
                while remaining.len() > 0 {
                    if let Ok(written_len) = writer_src.write(remaining).await.inspect_err(|e| {
                        error!(
                            "Req dst -> src Write failed (written: {}/{}): {}",
                            read_len - remaining.len(),
                            read_len,
                            e
                        )
                    }) {
                        remaining = &remaining[written_len..];
                        debug!("Req dst -> src {} bytes", written_len);
                    } else {
                        break;
                    }
                }
            }
            //
            writer_src.close().await.unwrap();
            debug!("Req dst read end");
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
