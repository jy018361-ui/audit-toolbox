//! Network OCR pages have a bounded lane independent of exclusive table jobs.
use parking_lot::{Condvar, Mutex, MutexGuard};
use std::{path::Path, time::Duration};

pub(crate) const OCR_PAGE_WORKER_LIMIT: usize = 5;

pub(crate) struct WorkerLanes {
    heavy: Mutex<()>,
    ocr_active: Mutex<usize>,
    ocr_ready: Condvar,
    ocr_limit: usize,
}

pub(crate) enum WorkerPermit<'a> {
    Exclusive { _guard: MutexGuard<'a, ()> },
    OcrPage { _permit: OcrPagePermit<'a> },
}

pub(crate) struct OcrPagePermit<'a>(&'a WorkerLanes);
impl Drop for OcrPagePermit<'_> {
    fn drop(&mut self) {
        *self.0.ocr_active.lock() -= 1;
        self.0.ocr_ready.notify_one();
    }
}

impl WorkerLanes {
    pub(crate) fn new() -> Self {
        Self {
            heavy: Mutex::new(()),
            ocr_active: Mutex::new(0),
            ocr_ready: Condvar::new(),
            ocr_limit: OCR_PAGE_WORKER_LIMIT,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_ocr_limit(limit: usize) -> Self {
        // Manual throughput probes may compare eight workers. This test-only
        // constructor never changes the application's five-worker default.
        assert!((1..=8).contains(&limit));
        Self { ocr_limit: limit, ..Self::new() }
    }

    /// A permit lives until its worker exits. OCR cancellation also wakes while
    /// waiting for a slot; existing exclusive jobs retain their original lane.
    pub(crate) fn acquire(&self, method: &str, cancel_path: &Path) -> Option<WorkerPermit<'_>> {
        if method != "ocr.recognize_page" {
            return Some(WorkerPermit::Exclusive { _guard: self.heavy.lock() });
        }
        let mut active = self.ocr_active.lock();
        while *active >= self.ocr_limit {
            if cancel_path.exists() { return None; }
            self.ocr_ready.wait_for(&mut active, Duration::from_millis(50));
        }
        if cancel_path.exists() { return None; }
        *active += 1;
        Some(WorkerPermit::OcrPage { _permit: OcrPagePermit(self) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::{Arc, mpsc}, thread};

    #[test]
    fn five_ocr_workers_enter_while_heavy_job_runs_and_sixth_waits_for_a_slot() {
        let root = tempfile::tempdir().unwrap();
        let cancel = root.path().join("unused.cancel");
        let lanes = Arc::new(WorkerLanes::new());
        let heavy = lanes.acquire("excel_merger.merge", &cancel).unwrap();
        let (entered, received) = mpsc::channel();
        let mut releases = vec![];
        let mut threads = vec![];
        for index in 0..6 {
            let (release, wait) = mpsc::channel();
            releases.push(release);
            let lanes = lanes.clone();
            let cancel = cancel.clone();
            let entered = entered.clone();
            threads.push(thread::spawn(move || {
                let _permit = lanes.acquire("ocr.recognize_page", &cancel).unwrap();
                let _ = entered.send(index);
                let _ = wait.recv_timeout(Duration::from_secs(5));
            }));
        }
        let first: Vec<_> = (0..5).filter_map(|_| received.recv_timeout(Duration::from_secs(2)).ok()).collect();
        let sixth_waited = received.recv_timeout(Duration::from_millis(100)).is_err();
        if let Some(index) = first.first() { let _ = releases[*index].send(()); }
        let sixth_started = received.recv_timeout(Duration::from_secs(2)).is_ok();
        drop(heavy);
        drop(releases);
        for worker in threads { worker.join().unwrap(); }
        assert_eq!(first.len(), 5, "OCR must bypass the exclusive heavy-job mutex");
        assert!(sixth_waited, "the backend must cap OCR at five workers");
        assert!(sixth_started, "a freed slot must admit the next page");
    }

    #[test]
    fn queued_ocr_cancel_returns_without_waiting_for_running_pages() {
        let root = tempfile::tempdir().unwrap();
        let cancel = root.path().join("queued.cancel");
        let lanes = Arc::new(WorkerLanes::new());
        let running: Vec<_> = (0..5).map(|_| lanes.acquire("ocr.recognize_page", &cancel).unwrap()).collect();
        let (sender, receiver) = mpsc::channel();
        let waiting = lanes.clone();
        let marker = cancel.clone();
        let worker = thread::spawn(move || {
            let cancelled = waiting.acquire("ocr.recognize_page", &marker).is_none();
            sender.send(cancelled).unwrap();
        });
        std::fs::write(&cancel, b"cancel").unwrap();
        let cancelled = receiver.recv_timeout(Duration::from_secs(2)).unwrap_or(false);
        drop(running);
        worker.join().unwrap();
        assert!(cancelled);
    }

    #[test]
    fn export_extract_and_other_heavy_jobs_keep_exclusive_serialization() {
        let root = tempfile::tempdir().unwrap();
        for method in ["ocr.export", "ocr.extract", "meeting.generate", "excel_merger.merge"] {
            let cancel = root.path().join("unused.cancel");
            let lanes = Arc::new(WorkerLanes::new());
            let first = lanes.acquire("excel_merger.merge", &cancel).unwrap();
            let (sender, receiver) = mpsc::channel();
            let next = lanes.clone();
            let worker = thread::spawn(move || {
                let _permit = next.acquire(method, &cancel).unwrap();
                sender.send(()).unwrap();
            });
            let waited = receiver.recv_timeout(Duration::from_millis(100)).is_err();
            drop(first);
            let entered = receiver.recv_timeout(Duration::from_secs(2)).is_ok();
            worker.join().unwrap();
            assert!(waited && entered, "{method} lost the heavy-job protection");
        }
    }
}
