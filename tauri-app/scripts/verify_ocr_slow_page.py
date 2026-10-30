"""Offline slow-page acceptance through the real dispatcher and native workers.
Page 11 never returns until cancelled; other 29 pages must save, then only page
11 is retried. No cloud, credentials, real documents or installed app settings.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading

from PIL import Image
from verify_ocr_dispatch import seed_database


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-exe", type=Path, required=True)
    parser.add_argument("--worker-exe", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    test_exe = args.test_exe.resolve(strict=True)
    worker_exe = args.worker_exe.resolve(strict=True)
    args.output.mkdir(parents=True, exist_ok=False)
    output = args.output.resolve()
    released = threading.Event()
    allow_slow = threading.Event()
    lock = threading.Lock()
    requests: Counter = Counter()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            image = payload["image"].split(",")[-1]
            with Image.open(io.BytesIO(base64.b64decode(image))) as decoded:
                page = decoded.convert("RGB").getpixel((0, 0))[0]
            with lock:
                requests[page] += 1
            if page == 11 and not allow_slow.is_set():
                released.wait(timeout=120)
            body = json.dumps({"text": f"合成第 {page} 页原文 00123", "tables": [], "warnings": []}, ensure_ascii=False).encode()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="audit-ocr-tail-") as temporary:
            root = Path(temporary)
            db = root / "isolated.sqlite"
            seed_database(db, 30)
            jobs = []
            for page in range(1, 31):
                buffer = io.BytesIO()
                Image.new("RGB", (64, 64), (page, page, page)).save(buffer, format="PNG")
                jobs.append({"__dbPath": str(db), "__settings": {"ocr": {"engine": "local"}, "llm": {"enabled": False}},
                             "documentId": "d", "page": page, "expectedRevision": 0, "layout": "full",
                             "imageBase64": base64.b64encode(buffer.getvalue()).decode()})

            def dispatch(name: str, items: list, defer: int | None = None):
                folder = output / name
                folder.mkdir()
                request = {"workerExe": str(worker_exe), "outputDir": str(folder), "jobs": items, "ocrLimit": 5, "deferPage": defer}
                result = subprocess.run([str(test_exe), "--exact", "excel_merger::tests::ocr_dispatch_workers_from_stdin", "--ignored", "--nocapture"],
                                        input=json.dumps(request) + "\n", capture_output=True, encoding="utf-8", timeout=180)
                (folder / "stdout.txt").write_text(result.stdout, encoding="utf-8")
                (folder / "stderr.txt").write_text(result.stderr, encoding="utf-8")
                assert result.returncode == 0, "原生拖尾验收失败，请检查本机日志。"
                return json.loads((folder / "dispatch-report.json").read_text(encoding="utf-8"))

            first = dispatch("slow-11", jobs, 11)
            assert first["peakRunning"] == 5
            assert first["cancelSeconds"] < 10, "取消慢页后仍长时间等待"
            completed = [event for event in first["pages"] if event["phase"] == "completed"]
            cancelled = [event for event in first["pages"] if event["phase"] == "cancelled"]
            assert len(completed) == 29 and len(cancelled) == 1
            assert sorted(event["result"]["page"] for event in completed) == [page for page in range(1, 31) if page != 11]
            phases = {event["phase"] for event in first["events"]}
            assert {"ocr_request", "ocr_save"}.issubset(phases), "原生进度未上报请求与保存阶段"
            assert first["events"].index(cancelled[0]) > max(first["events"].index(event) for event in completed)
            with closing(sqlite3.connect(db)) as connection:
                before = connection.execute("SELECT page,data FROM ocr_pages ORDER BY page").fetchall()
            assert len(before) == 29
            allow_slow.set()
            released.set()
            retry = dispatch("retry-only-11", [jobs[10]])
            assert retry["pages"][0]["result"]["page"] == 11
            with closing(sqlite3.connect(db)) as connection:
                after = connection.execute("SELECT page,data FROM ocr_pages ORDER BY page").fetchall()
            assert len(after) == 30
            assert before == [(page, data) for page, data in after if page != 11], "补扫改写了其他已保存页"
            assert requests[11] == 2 and all(requests[page] == 1 for page in range(1, 31) if page != 11)
            summary = {"success": True, "completedBeforeCancel": 29, "slowPage": 11,
                       "cancelSeconds": first["cancelSeconds"], "retryPage": 11, "savedAfterRetry": 30,
                       "otherPagesUnchanged": True, "cloudCalls": 0, "peakRunning": first["peakRunning"]}
            (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(summary, ensure_ascii=False))
    finally:
        released.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
