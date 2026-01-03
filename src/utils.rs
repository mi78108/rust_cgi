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
                let task_id = try_id().and_then(|v| Some(v.to_string())).unwrap_or("-".to_string());
                // 3. 输出到控制台（可替换为文件/网络等）
                println!("[{}] [INFO] [{}:{}] <{:?}:{}> {}", now, module_path!(), line!(), current().id(), task_id, log_content);
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
                let task_id = try_id().and_then(|v| Some(v.to_string())).unwrap_or("-".to_string());
                // 3. 输出到控制台（可替换为文件/网络等）
                println!("[{}] [DEBUG] [{}:{}] <{:?}:{}> {}", now, module_path!(), line!(), current().id(), task_id, log_content);
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
                let task_id = try_id().and_then(|v| Some(v.to_string())).unwrap_or("-".to_string());
                // 3. 输出到控制台（可替换为文件/网络等）
                println!("[{}] [ERROR] [{}:{}] <{:?}:{}> {}", now, module_path!(), line!(), current().id(), task_id, log_content);
            }
        }};
    }
}
