"""Manual paid-service comparison: installed OCR worker vs curl, same input,
native OCR task, account and existing Clash rules. No installation/settings edits.
Credentials are obtained by a loopback capture, retained only in memory/stdin.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import re
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.request
from urllib.parse import urlsplit
import uuid

from probe_ocr_network import capture, measure, production_request
from verify_ocr_dispatch import seed_database


class ClashObserver:
    """Read only the configured loopback controller; never record its secret or
    unrelated connections. Counters measure proxy traffic, not remote compute.
    """
    def __init__(self, config: Path | None, host: str):
        self.host = host
        self.connections = {}
        self.errors = []
        self.stopped = threading.Event()
        self.mode = None
        self.thread = None
        self.started = time.perf_counter()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.existing = set()
        if config is None:
            return
        import yaml  # Developer-only; not part of the shipped application.
        data = yaml.safe_load(config.read_text(encoding="utf-8"))
        address = data.get("external-controller", "")
        parsed = urlsplit("http://" + address)
        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or not parsed.port:
            raise ValueError("只读取本机回环 Clash 控制器。")
        self.base = "http://" + address
        self.secret = data.get("secret", "")
        self.mode = self.get("/configs").get("mode")
        self.existing = {item["id"] for item in self.get("/connections").get("connections", [])}
        self.thread = threading.Thread(target=self.poll, daemon=True)

    def get(self, path: str):
        request = urllib.request.Request(self.base + path, headers={"Authorization": "Bearer " + self.secret})
        with self.opener.open(request, timeout=2) as response:
            return json.load(response)

    def poll(self):
        while not self.stopped.is_set():
            try:
                for item in self.get("/connections").get("connections", []):
                    metadata = item.get("metadata", {})
                    if metadata.get("host") != self.host or item["id"] in self.existing:
                        continue
                    row = self.connections.setdefault(item["id"], {
                        "host": self.host, "sourcePort": metadata.get("sourcePort"),
                        "process": Path(metadata.get("processPath") or metadata.get("process") or "unknown").name,
                        "rule": item.get("rule"), "rulePayload": item.get("rulePayload"),
                        "chains": item.get("chains"), "samples": [],
                    })
                    if len(row["samples"]) < 2000:
                        row["samples"].append({"elapsedSeconds": round(time.perf_counter() - self.started, 3),
                                               "upload": item.get("upload", 0), "download": item.get("download", 0)})
            except Exception as error:
                if len(self.errors) < 5:
                    self.errors.append(type(error).__name__)
            self.stopped.wait(.15)

    def start(self):
        if self.thread:
            self.thread.start()

    def stop(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=4)

    def report(self):
        return {"mode": self.mode, "errors": self.errors, "connections": list(self.connections.values()),
                "scope": "Clash counters/rules only; encrypted forwarding counters cannot determine remote queue or compute time."}


def native_worker(exe: Path, root: Path, image: bytes, ocr: dict) -> dict:
    db = root / "native.sqlite"
    seed_database(db, 30)
    request = {"jobId": uuid.uuid4().hex, "method": "ocr.recognize_page",
               "cancelPath": str(root / "unused.cancel"), "pausePath": str(root / "unused.pause"),
               "params": {"__dbPath": str(db), "__settings": {"ocr": ocr, "llm": {"enabled": False}},
                          "documentId": "d", "page": 30, "expectedRevision": 0, "layout": "full",
                          "imageBase64": base64.b64encode(image).decode()}}
    started_at = datetime.now(timezone.utc).isoformat()
    started = time.perf_counter()
    completed = subprocess.run([str(exe), "--rust-table-worker"], input=json.dumps(request) + "\n",
                               encoding="utf-8", capture_output=True, timeout=200)
    events = [json.loads(line) for line in completed.stdout.splitlines() if line.startswith("{")]
    terminals = [event for event in events if event.get("phase") in {"completed", "failed", "cancelled"}]
    terminal = terminals[-1] if terminals else {}
    result = terminal.get("result") or {}
    error = result.get("error") or {}
    return {"startedAtUtc": started_at, "wallSeconds": time.perf_counter() - started,
            "success": terminal.get("phase") == "completed", "phase": terminal.get("phase"),
            "timings": result.get("timings"), "characters": len(result.get("text", "")),
            "errorCode": error.get("code"), "exitCode": completed.returncode}


def main():
    parser = argparse.ArgumentParser(description="安装版原生worker与curl同图同任务配对实测，会调用现有百炼服务并计费。")
    parser.add_argument("--worker-exe", type=Path, required=True)
    parser.add_argument("--settings-db", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--clash-config", type=Path)
    parser.add_argument("--pairs", type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.pairs <= 3:
        parser.error("配对轮数必须为1至3。")
    exe = args.worker_exe.resolve(strict=True)
    image = args.image.resolve(strict=True).read_bytes()
    curl = shutil.which("curl.exe")
    if not curl:
        parser.error("需要Windows curl 8.10及以上版本。")
    version = subprocess.check_output([curl, "--disable", "--version"], encoding="utf-8").splitlines()[0]
    match = re.search(r"curl (\d+)\.(\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < (8, 10, 0):
        parser.error("需要curl 8.10及以上版本记录上传结束时间。")
    with sqlite3.connect(args.settings_db.resolve(strict=True).as_uri() + "?mode=ro", uri=True) as connection:
        ocr = json.loads(connection.execute("SELECT value_json FROM settings WHERE key='ocr'").fetchone()[0])
    if ocr.get("engine") != "bailian":
        parser.error("当前引擎不是百炼，不变更模型配置。")
    args.output.mkdir(parents=True, exist_ok=False)
    output = args.output.resolve()
    report = {"installedExeSha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
              "originalImageSha256": hashlib.sha256(image).hexdigest(), "runs": [],
              "scope": "Installed native worker and independent curl in simultaneous pairs, same image/account/native OCR task, existing proxy rules. No GUI/PDF.js; two requests per pair; not proof of remote internal timing."}
    with tempfile.TemporaryDirectory(prefix="audit-ocr-clients-") as temporary:
        root = Path(temporary)
        captured, authorization = capture(exe, args.image.resolve(), ocr, root)
        url, body = production_request(ocr.get("bailian_base_url") or "https://dashscope.aliyuncs.com/compatible-mode/v1", ocr.get("bailian_model") or "qwen3.5-ocr", captured)
        # Rust serde_json's default map sorts keys; compact ASCII payload makes
        # the independent body comparable without reducing image resolution.
        body = json.dumps(json.loads(body), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        report.update({"requestBytes": len(body), "curlBodySha256": hashlib.sha256(body).hexdigest(),
                       "host": urlsplit(url).hostname, "endpointPath": urlsplit(url).path})
        for pair in range(1, args.pairs + 1):
            work = root / f"pair-{pair}"
            work.mkdir()
            body_file = work / "body.json"
            body_file.write_bytes(body)
            observer = ClashObserver(args.clash_config, urlsplit(url).hostname)
            observer.start()
            print(f"开始第 {pair}/{args.pairs} 组：正式EXE与curl同时调用相同页面。", flush=True)
            try:
                with ThreadPoolExecutor(max_workers=2) as pool:
                    native_future = pool.submit(native_worker, exe, work, image, ocr)
                    curl_future = pool.submit(measure, curl, url, body_file, authorization, work, pair)
                    native, independent = native_future.result(), curl_future.result()
            finally:
                observer.stop()
            native_http = ((native.get("timings") or {}).get("httpRequests") or [{}])[0]
            run = {"pair": pair, "native": native, "curl": independent, "clash": observer.report(),
                   "equalRequestSize": native_http.get("requestBytes") == len(body)}
            report["runs"].append(run)
            (output / "comparison.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"pair": pair, "nativeSeconds": round(native["wallSeconds"], 3),
                              "curlSeconds": independent["metrics"]["time_total"],
                              "nativeHttp": native_http, "curlStages": independent["stages"],
                              "equalRequestSize": run["equalRequestSize"],
                              "routes": [{"process": row["process"], "rule": row["rule"], "rulePayload": row["rulePayload"], "chains": row["chains"]} for row in run["clash"]["connections"]]}, ensure_ascii=False), flush=True)
            if not native["success"] or not independent["success"] or not run["equalRequestSize"]:
                raise RuntimeError("配对请求失败或请求体大小不一致，停止追加付费调用；请检查本机报告。")


if __name__ == "__main__":
    main()
