// Tests exercise ExcelMergerService::start -> monitor -> dispatch -> worker,
// rather than launching worker processes directly and skipping the parent lane.

#[test]
fn ocr_dispatch_queue_time_is_attached_without_changing_other_results() {
    let root = tempfile::tempdir().unwrap();
    let (sender, receiver) = mpsc::channel();
    let service = dispatch_test_service(root.path(), PathBuf::from("unused.exe"), 5, sender);
    service.emit_worker_event(json!({"phase":"completed","result":{"page":1,"text":"原文","timings":{"workerMs":10.0}}}), 123.0);
    let result = receiver.recv().unwrap();
    assert_eq!(result["result"]["timings"]["queueMs"], 123.0);
    assert_eq!(result["result"]["text"], "原文");
    service.emit_worker_event(json!({"phase":"completed","result":{"outputPaths":["result.xlsx"]}}), 123.0);
    let result = receiver.recv().unwrap();
    assert!(result["result"]["timings"].is_null());
}

fn dispatch_test_service(root: &Path, worker_exe: PathBuf, limit: usize, sender: mpsc::Sender<Value>) -> ExcelMergerService {
    fs::create_dir_all(root).unwrap();
    ExcelMergerService {
        events: JobEventTarget::Test(Arc::new(move |event| { let _ = sender.send(event); })),
        allowed: AllowedPaths(Arc::new(Mutex::new(HashSet::new()))),
        jobs: Arc::new(Mutex::new(HashMap::new())),
        job_starts: Arc::new(Mutex::new(HashMap::new())),
        lanes: Arc::new(WorkerLanes::with_ocr_limit(limit)),
        cancel_root: root.to_path_buf(),
        worker_exe: Some(worker_exe),
    }
}

/// Manual only. Caller must authorize documents/service calls and provide an
/// isolated database plus an existing native worker EXE. No Tauri UI or real
/// app settings/history is needed; all dispatch/process/event code is real.
#[test]
#[ignore]
fn ocr_dispatch_workers_from_stdin() {
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    let input: Value = serde_json::from_str(&line).unwrap();
    let output = PathBuf::from(input["outputDir"].as_str().unwrap());
    fs::create_dir_all(&output).unwrap();
    let exe = PathBuf::from(input["workerExe"].as_str().unwrap());
    assert!(exe.is_file());
    let limit = input["ocrLimit"].as_u64().unwrap_or(5) as usize;
    let pending = input["jobs"].as_array().unwrap();
    let (sender, receiver) = mpsc::channel();
    let service = dispatch_test_service(&output.join("markers"), exe, limit, sender);
    let started = Instant::now();
    let mut next = 0;
    let mut active = HashSet::new();
    let mut running = HashSet::new();
    let mut peak_running = 0;
    let mut pages = vec![];
    let mut events = vec![];
    while next < pending.len() || !active.is_empty() {
        while next < pending.len() && active.len() < 5 {
            let item = &pending[next];
            let id = service.start("ocr.recognize_page", item.clone()).unwrap();
            active.insert(id);
            next += 1;
        }
        let event = receiver.recv_timeout(Duration::from_secs(240)).expect("任务启动器没有返回终态");
        let id = event["jobId"].as_str().unwrap().to_owned();
        let phase = event["phase"].as_str().unwrap_or("");
        if phase == "running" {
            running.insert(id.clone());
            peak_running = peak_running.max(running.len());
        }
        if matches!(phase, "completed" | "failed" | "cancelled") && active.remove(&id) {
            running.remove(&id);
            pages.push(event.clone());
            println!("已完成 {} / {} 页，经过 {:.2} 秒", pages.len(), pending.len(), started.elapsed().as_secs_f64());
        }
        events.push(event);
    }
    // monitor owns cleanup until the child has exited, just as in the app.
    let cleanup = Instant::now();
    while !service.jobs.lock().is_empty() && cleanup.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(service.jobs.lock().is_empty(), "后台进程退出后未释放名额");
    let report = json!({"wallSeconds":started.elapsed().as_secs_f64(),"ocrLimit":limit,"peakRunning":peak_running,"pages":pages,"events":events});
    fs::write(output.join("dispatch-report.json"), serde_json::to_string_pretty(&report).unwrap()).unwrap();
    assert!(report["pages"].as_array().unwrap().iter().all(|event| event["phase"] == "completed"), "部分 OCR 页失败，请检查本机报告");
}
