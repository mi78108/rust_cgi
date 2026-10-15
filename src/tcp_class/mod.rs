mod http_func;
mod http_websocket_func;
mod tcp_file_func;
mod tcp_func;
mod http_file_func;

pub use self::tcp_func::Tcp;
pub use self::tcp_func::handle;
