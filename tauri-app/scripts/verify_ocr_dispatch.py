"""Offline acceptance through the app's real parent dispatcher, not raw workers."""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import tempfile
import threading
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from verify_ocr_concurrency import synthetic_png


def seed_database(path: Path, total: int, name: str = "合成扫描件.pdf") -> str:
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.executescript("""
            CREATE TABLE ocr_projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE ocr_documents(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ocr_projects(id), data TEXT NOT NULL, source TEXT NOT NULL);
        """)
        project = {"id": "p", "name": "任务调度验收", "prompts": {}, "createdAt": "2026-10-27", "updatedAt": "2026-10-27"}
        document = {"id": "d", "projectId": "p", "name": name, "mimeType": "application/pdf", "totalPages": total, "revision": 0, "status": "pending", "sha256": "isolated-dispatch-test"}
        connection.execute("INSERT INTO ocr_projects VALUES(?,?)", ("p", json.dumps(project)))
        connection.execute("INSERT INTO ocr_documents VALUES(?,?,?,?)", ("d", "p", json.dumps(document), "not-read.pdf"))
    return "d"


def dispatch(test_exe: Path, worker_exe: Path, output: Path, jobs: list[dict], limit: int = 5) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    request = {"workerExe": str(worker_exe), "outputDir": str(output), "ocrLimit": limit, "jobs": jobs}
    result = subprocess.run(
        [str(test_exe), "--exact", "excel_merger::tests::ocr_dispatch_workers_from_stdin", "--ignored", "--nocapture"],
        input=json.dumps(request, ensure_ascii=False) + "\n", encoding="utf-8", capture_output=True, timeout=1200,
    )
    (output / "native-stdout.txt").write_text(result.stdout, encoding="utf-8")
    (output / "native-stderr.txt").write_text(result.stderr, encoding="utf-8")
    report_path = output / "dispatch-report.json"
    assert result.returncode == 0 and report_path.is_file(), "真实任务启动器验收失败，请检查本机日志：" + str(output)
    return json.loads(report_path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-exe", type=Path, required=True)
    parser.add_argument("--worker-exe", type=Path, required=True)
    args = parser.parse_args()
    test_exe = args.test_exe.resolve(strict=True)
    worker_exe = args.worker_exe.resolve(strict=True)
    barrier = threading.Barrier(5, timeout=30)
    lock = threading.Lock()
    count = 0

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            nonlocal count
            self.rfile.read(int(self.headers["Content-Length"]))
            with lock:
                count += 1
            barrier.wait()
            body = json.dumps({"text": "合成原文 00123", "tables": [], "warnings": []}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="audit-dispatch-") as temporary:
            root = Path(temporary)
            db = root / "isolated.sqlite"
            document = seed_database(db, 5)
            jobs = [{"__dbPath": str(db), "__settings": {"ocr": {"engine": "local"}, "llm": {"enabled": False}}, "documentId": document, "page": page, "expectedRevision": 0, "layout": "full", "imageBase64": synthetic_png()} for page in range(1, 6)]
            report = dispatch(test_exe, worker_exe, root / "events", jobs)
            assert count == 5 and report["peakRunning"] == 5, report["peakRunning"]
            pages = [event["result"] for event in report["pages"]]
            assert sorted(page["page"] for page in pages) == list(range(1, 6))
            assert all(0 <= page["timings"]["queueMs"] < 3000 for page in pages), "OCR pages unexpectedly waited in the exclusive job queue"
            with closing(sqlite3.connect(db)) as connection:
                document = json.loads(connection.execute("SELECT data FROM ocr_documents WHERE id='d'").fetchone()[0])
                assert document["revision"] == 5
                assert connection.execute("SELECT COUNT(*) FROM ocr_pages").fetchone()[0] == 5
            print("OCR 真实任务调度验收通过：start/monitor 后五请求同时到达、后端限额有效、分页完整、排队耗时返回。")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
