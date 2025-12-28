pub mod LocalTreadPoll {
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::sync::atomic::AtomicU8;
    use std::sync::Mutex;
    use std::sync::RwLock;
    use std::sync::mpsc::Receiver;
    use std::thread;
    use std::time::Duration;

    use log::debug;

    pub struct ThreadPool {
        max: usize,
        min: usize,
        workers: Arc<RwLock<Vec<Worker>>>,
        sender: mpsc::Sender<Job>,
        receiver: Arc<Mutex<Receiver<Job>>>
    }
    type Job = Box<dyn FnOnce() + Send + 'static>;

    impl ThreadPool {
        pub fn new(size: usize, max: usize) -> ThreadPool {
            let (sender, receiver) = mpsc::channel();

            let receiver = Arc::new(Mutex::new(receiver));

            let workers = Arc::new(RwLock::new(Vec::with_capacity(size)));

            for id in 0..size {
                workers.write().unwrap().push(Worker::new(id, Arc::clone(&receiver)));
            }

            ThreadPool { max: max, min: size, workers, sender, receiver }
        }

        pub fn execute<F>(&self, f: F)
        where
            F: FnOnce() + Send + 'static
        {
            let job = Box::new(f);

            let count = self.workers.read().unwrap().iter().filter(|v| v.running.load(std::sync::atomic::Ordering::Acquire) == 1).count();
            let running_count = self.workers.read().unwrap().iter().filter(|v| v.running.load(std::sync::atomic::Ordering::Acquire) > 1).count();
            debug!("new task comming current available threads count {}", count);
            if count == 0 && self.max > running_count {
                let recovery: Vec<usize> = self.workers.read().unwrap().iter().enumerate().filter(|(i, v)| v.running.load(std::sync::atomic::Ordering::Acquire) == 0).map(|(i, _)| i).collect();
                recovery.iter().rev().for_each(|v| {
                    self.workers.write().unwrap().remove(*v);
                });

                let id = self.workers.read().unwrap().len();
                self.workers.write().unwrap().push(Worker::new(id, Arc::clone(&self.receiver)));
            }
            debug!("new task comming current available threads all count {}", self.workers.read().unwrap().len());
            self.sender.send(job).unwrap();
        }
    }

    struct Worker {
        id: usize,
        thread: thread::JoinHandle<()>,
        running: Arc<AtomicU8>,
    }

    impl Worker {
        fn new(id: usize, receiver: Arc<Mutex<mpsc::Receiver<Job>>>) -> Worker {
            let running = Arc::new(AtomicU8::new(1));
            let running_thread = Arc::clone(&running);
            let thread = thread::spawn(move || {
                loop {
                    if let Ok(reader) = receiver.lock() {
                        if let Ok(job) = reader.recv_timeout(Duration::from_mins(3)) {
                            running_thread.store(2, std::sync::atomic::Ordering::Release);
                            debug!("Worker {} got a job; executing.", id);
                            drop(reader);
                            job();
                            running_thread.store(1, std::sync::atomic::Ordering::Release);
                            debug!("Worker {} finished a job. release", id);
                        } else {
                            running_thread.store(0, std::sync::atomic::Ordering::Release);
                            debug!("Worker {} waitting timeout; exit.", id);
                            break;
                        }
                    }
                }
            });

            Worker { id, thread, running }
        }
    }
}
