"""Exercise three real OCR worker processes against a local synthetic OCR server."""
from __future__ import annotations

import argparse
import base64
import json
import sqlite3
import struct
import tempfile
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from verify_ocr_workers import invoke


def synthetic_png() -> str:
    def chunk(name: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))
    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff"))
    data += chunk(b"IEND", b"")
    return base64.b64encode(data).decode("ascii")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, required=True)
    args = parser.parse_args()
    exe = args.exe.resolve(strict=True)
    barrier = threading.Barrier(3, timeout=20)
    lock = threading.Lock()
    requests = 0

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            nonlocal requests
            self.rfile.read(int(self.headers["Content-Length"]))
            with lock:
                requests += 1
                index = requests
            # All three requests must arrive before any is answered. Serial workers fail.
            barrier.wait()
            time.sleep((3 - index) * 0.1)
            body = json.dumps({"text": "合成正文 0012345", "tables": [], "warnings": []}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    # The existing local OCR adapter uses this fixed port; never replace a running service.
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="audit-ocr-concurrent-") as temporary:
            root = Path(temporary)
            db = root / "synthetic.sqlite"
            with closing(sqlite3.connect(db)) as conn, conn:
                conn.executescript("""
                    CREATE TABLE ocr_projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
                    CREATE TABLE ocr_documents(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ocr_projects(id), data TEXT NOT NULL, source TEXT NOT NULL);
                """)
                project = {"id": "p", "name": "并发验收", "prompts": {}, "createdAt": "2026-10-27", "updatedAt": "2026-10-27"}
                document = {"id": "d", "projectId": "p", "name": "合成扫描件.pdf", "mimeType": "application/pdf", "totalPages": 3, "revision": 0, "status": "pending", "sha256": "synthetic"}
                conn.execute("INSERT INTO ocr_projects VALUES(?,?)", ("p", json.dumps(project)))
                conn.execute("INSERT INTO ocr_documents VALUES(?,?,?,?)", ("d", "p", json.dumps(document), str(root / "unused.pdf")))

            def recognize(page: int):
                return invoke(exe, root, "ocr.recognize_page", {
                    "__dbPath": str(db), "__settings": {"ocr": {"engine": "local"}, "llm": {"enabled": False}},
                    "documentId": "d", "page": page, "expectedRevision": 0, "layout": "full", "imageBase64": synthetic_png(),
                })

            with ThreadPoolExecutor(max_workers=3) as pool:
                events = list(pool.map(recognize, (1, 2, 3)))
            for page, event in enumerate(events, 1):
                assert event["phase"] == "completed", event
                result = event["result"]
                assert result["page"] == page and result["revision"] == 1, result
                assert result["text"] == "合成正文 0012345", result
                timings = result["timings"]
                assert set(timings) == {"setupMs", "imageMs", "recognitionMs", "structureMs", "saveMs", "workerMs"}, timings
                assert all(isinstance(value, (int, float)) and value >= 0 for value in timings.values()), timings
                assert timings["recognitionMs"] > 0 and timings["saveMs"] > 0, timings
                assert sum(value for key, value in timings.items() if key != "workerMs") <= timings["workerMs"] + 1, timings
            assert requests == 3, requests
            stale = recognize(1)
            assert stale["phase"] == "failed", stale
            assert stale["result"]["error"]["code"] == "OCR_REVISION_CONFLICT", stale
            assert requests == 3, "Stale page must fail before another OCR request"
            with closing(sqlite3.connect(db)) as conn:
                assert conn.execute("SELECT page FROM ocr_pages ORDER BY page").fetchall() == [(1,), (2,), (3,)]
                stored = json.loads(conn.execute("SELECT data FROM ocr_documents WHERE id='d'").fetchone()[0])
                assert stored["revision"] == 3 and stored["status"] == "completed", stored
                assert all("timings" not in json.loads(row[0]) for row in conn.execute("SELECT data FROM ocr_pages"))
            print("OCR 并发 worker 验收通过：三请求同时在途、分页保存无丢失、修订号与冲突检查正确、分段耗时完整且不混入正文。")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
