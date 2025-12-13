mod thread_pool {
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::thread;

    use log::debug;
    pub struct ThreadPool {
        workers: Vec<Worker>,
        sender: mpsc::Sender<Job>,
    }
    type Job = Box<dyn FnOnce() + Send + 'static>;

    impl ThreadPool {
        pub fn new(size: usize) -> ThreadPool {
            let (sender, receiver) = mpsc::channel();

            let receiver = Arc::new(Mutex::new(receiver));

            let mut workers = Vec::with_capacity(size);

            for id in 0..size {
                workers.push(Worker::new(id, Arc::clone(&receiver)));
            }

            ThreadPool { workers, sender }
        }

        pub fn execute<F>(&self, f: F)
        where
            F: FnOnce() + Send + 'static,
        {
            let job = Box::new(f);

            self.sender.send(job).unwrap();
        }
    }

    struct Worker {
        id: usize,
        thread: thread::JoinHandle<()>,
    }

    impl Worker {
        fn new(id: usize, receiver: Arc<Mutex<mpsc::Receiver<Job>>>) -> Worker {
            let thread = thread::spawn(move || loop {
                let job = receiver.lock().unwrap().recv().unwrap();

                debug!("Worker {} got a job; executing.", id);

                job();
                debug!("Worker {} finished a job. release", id);
            });

            Worker { id, thread }
        }
    }
}

pub mod thread_pool_mio {
    use std::convert::TryInto;
    use std::io::Stdin;
    use std::net::TcpStream;
    use std::process::ChildStdin;
    use std::sync::mpsc;
    use std::sync::mpsc::Receiver;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    use log::debug;
    use mio::Events;
    use mio::Interest;
    use mio::Poll;
    use mio::Token;

    const IO_TYPE_TCP_READ: u16 = 0x0000;
    const IO_TYPE_SCRIPT_STDOUT: u16 = 0x0002;

    #[derive(Debug)]
    pub enum WorkerCommand {
        CreateGroup(TcpStream, ChildStdin),
        Exit,
    }
    pub struct ThreadPool {
        workers: Vec<Worker>,
        sender: mpsc::Sender<Job>,
    }
    type Job = WorkerCommand;

    impl ThreadPool {
        pub fn new(size: usize) -> ThreadPool {
            let (sender, receiver) = mpsc::channel();

            let receiver = Arc::new(Mutex::new(receiver));

            let mut workers = Vec::with_capacity(size);

            for id in 0..size {
                workers.push(Worker::new(id, Arc::clone(&receiver)));
            }

            ThreadPool { workers, sender }
        }

        pub fn execute(&self, j: Job) {
            debug!("000000000000000000000000");
            self.sender.send(j).unwrap();
        }
    }

    struct Worker {
        id: usize,
        thread: thread::JoinHandle<()>,
    }

    impl Worker {
        fn new(id: usize, receiver: Arc<Mutex<mpsc::Receiver<Job>>>) -> Worker {
            let thread = thread::spawn(move || {
                let mut poll = Poll::new().unwrap();
                let mut events = Events::with_capacity(1024);
                loop {
                    let registry = poll.registry();
                    while let Ok(mut task) = receiver.try_lock().unwrap().try_recv(){
                        debug!("..........................................");
                        match task {
                            WorkerCommand::CreateGroup(mut tcp_stream, mut child_stdin) => {
                                let mut mio_tcp = mio::net::TcpStream::from_std(tcp_stream);
                                registry
                                    .register(&mut mio_tcp, Token(1), Interest::WRITABLE)
                                    .unwrap();

                                //  registry
                                //     .register(&mut child_stdin, Token(2), Interest::READABLE)
                                //     .unwrap();
                            }

                            WorkerCommand::Exit => todo!(),
                        }
                    }
                    match poll.poll(&mut events, Some(std::time::Duration::from_millis(200))) {
                        Ok(_) => {
                            //debug!(">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>");
                            for event in events.iter() {
                                match event.token() {
                                    _ => {

                                        debug!("vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv")
                                    }
                                }
                            }
                        }
                        Err(_) => {
                            debug!("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
                        }
                    }
                }
            });
            Worker { id, thread }
        }
    }
}
