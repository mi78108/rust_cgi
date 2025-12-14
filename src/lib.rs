use std::sync::atomic::AtomicU8;
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

        ThreadPool {
            workers,
            sender,
        }
    }

    pub fn execute<F>(&self, f: F)
    where
        F: FnOnce() + Send + 'static
        {
            let job = Box::new(f);
            let count = self.workers.iter().filter(|v| v.running.load(std::sync::atomic::Ordering::Relaxed) == 0).count();
            debug!("new task comming current available threads count {}", count);
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
         let running =Arc::new(AtomicU8::new(0)); 
         let running_thread = Arc::clone(&running);
        let thread = thread::spawn(move || {
            loop {
                let job = receiver.lock().unwrap().recv().unwrap();
                debug!("Worker {} got a job; executing.", id);
                running_thread.store(1, std::sync::atomic::Ordering::Relaxed);
                job();
                debug!("Worker {} finished a job. release", id);
                running_thread.store(0, std::sync::atomic::Ordering::Relaxed);
            }
        });

        Worker {
            id,
            thread,
            running
        }
    }
}
