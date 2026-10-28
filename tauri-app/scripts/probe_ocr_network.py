"""Manual, paid-service diagnostic. Capture a native request locally, then time
the same body with curl. Credentials stay in memory/stdin, never argv or reports.
curl is a developer probe, not an application runtime dependency.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit, urlunsplit

from verify_ocr_dispatch import seed_database
from verify_ocr_workers import invoke


def endpoint(base: str) -> str:
    parsed = urlsplit(base.strip().rstrip("/"))
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("OCR 地址无效，不能包含账号、密码、查询参数或片段。")
    path = parsed.path.rstrip("/")
    if not path.endswith("/chat/completions"):
        path += "/chat/completions"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def production_request(base: str, model: str, captured: bytes) -> tuple[str, bytes]:
    """Mirror official-endpoint selection after local credential capture.

    The capture listener intentionally has a loopback URL, so the worker uses
    its compatibility protocol there. Replaying it unchanged to the official
    Qwen3.5 service would measure a different OCR task than production.
    """
    url = endpoint(base)
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    official = host in {"dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"} or host.endswith(".maas.aliyuncs.com")
    # reqwest::Url normalizes an explicit HTTPS default port to None.
    if model != "qwen3.5-ocr" or not official or parsed.scheme != "https" or parsed.port not in {None, 443} or parsed.path != "/compatible-mode/v1/chat/completions":
        return url, captured
    value = json.loads(captured)
    image = value["messages"][0]["content"][0]["image_url"]["url"]
    native = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": [{
            "image": image, "min_pixels": 3072, "max_pixels": 8388608, "enable_rotate": False,
        }]}]},
        "parameters": {"ocr_options": {"task": "document_parsing"}},
    }
    return urlunsplit((parsed.scheme, parsed.netloc, "/api/v1/services/aigc/multimodal-generation/generation", "", "")), json.dumps(native, ensure_ascii=False).encode()


def response_text(value: dict) -> tuple[str, str | None]:
    """Accept the actual native assembled text; never count repeated blocks."""
    choice = (value.get("output", value))["choices"][0]
    content = choice["message"]["content"]
    if isinstance(content, list):
        content = "\n\n".join(part["text"] for part in content if isinstance(part.get("text"), str))
    if not isinstance(content, str):
        raise ValueError("缺少识别正文。")
    return content, choice.get("finish_reason")


def stages(metrics: dict, https: bool) -> dict | None:
    """Cumulative curl times become disjoint intervals; reject early responses.
    Waiting after upload still contains network return and remote processing.
    """
    dns = metrics["time_namelookup"]
    tcp = metrics["time_connect"]
    tls = metrics["time_appconnect"] if https else tcp
    ready = metrics["time_pretransfer"]
    uploaded = metrics["time_posttransfer"]
    first = metrics["time_starttransfer"]
    total = metrics["time_total"]
    points = [0, dns, tcp, tls, ready, uploaded, first, total]
    if any(b < a for a, b in zip(points, points[1:])):
        return None
    return {key: round((b - a) * 1000, 3) for key, a, b in zip(
        ["dnsMs", "tcpMs", "tlsMs", "pretransferMs", "uploadMs", "afterUploadWaitMs", "downloadMs"], points, points[1:]
    )}


def request_id(headers: str) -> str | None:
    found = None
    for line in headers.splitlines():
        key, separator, value = line.partition(":")
        if separator and key.lower() in {"x-request-id", "x-dashscope-request-id"}:
            value = value.strip()
            if re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", value):
                found = value
    return found


def capture(worker: Path, image: Path, ocr: dict, root: Path) -> tuple[bytes, str]:
    """Let the installed worker read its own channel's credential. Only a local
    ephemeral listener receives it. Never change the real saved settings/DB.
    """
    captured = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            captured["body"] = self.rfile.read(int(self.headers["Content-Length"]))
            captured["authorization"] = self.headers.get("Authorization", "")
            body = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": "合成诊断响应"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        db = root / "isolated.sqlite"
        seed_database(db, 1)
        local = {**ocr, "engine": "bailian", "bailian_base_url": f"http://127.0.0.1:{server.server_port}/v1"}
        event = invoke(worker, root, "ocr.recognize_page", {
            "__dbPath": str(db), "__settings": {"ocr": local, "llm": {"enabled": False}},
            "documentId": "d", "page": 1, "expectedRevision": 0, "layout": "full",
            "imageBase64": base64.b64encode(image.read_bytes()).decode(),
        })
        if event["phase"] != "completed" or not captured.get("authorization", "").startswith("Bearer "):
            raise RuntimeError("未能在本机捕获识别请求，请确认原生程序的百炼凭据已配置。")
        return captured["body"], captured["authorization"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def measure(curl: str, url: str, body_file: Path, authorization: str, root: Path, index: int, direct: bool = False) -> dict:
    response_file = root / f"response-{index}.json"
    headers_file = root / f"headers-{index}.txt"
    keys = ["time_namelookup", "time_connect", "time_appconnect", "time_pretransfer", "time_posttransfer", "time_starttransfer", "time_total", "size_upload", "size_download", "http_code"]
    # curl prints status 000 on connection failures; quote it for valid JSON.
    output_format = "{" + ",".join(json.dumps(key) + (':"%{http_code}"' if key == "http_code" else ":%{" + key + "}") for key in keys) + "}"
    # curl's config string quoting supports the JSON escapes used for an ASCII
    # Authorization header. The secret is never placed on the command line.
    if any(ord(ch) < 32 or ord(ch) > 126 for ch in authorization):
        raise ValueError("凭据头格式无效。")
    config = "header = " + json.dumps("Authorization: " + authorization) + "\n"
    command = [
        curl, "--disable", "--silent", "--connect-timeout", "20", "--max-time", "180",
        "--retry", "0", "--max-redirs", "0", "--header", "Content-Type: application/json",
        "--header", "Expect:", "--data-binary", "@" + str(body_file),
        "--output", str(response_file), "--dump-header", str(headers_file),
        "--write-out", output_format, "--config", "-",
    ]
    if direct:
        command.extend(["--noproxy", "*"])
    command.append(url)
    started_at = datetime.now(timezone.utc).isoformat()
    completed = subprocess.run(command, input=config, capture_output=True, encoding="utf-8", timeout=200)
    # Do not record stderr: diagnostic libraries may echo request parameters.
    metrics = json.loads(completed.stdout)
    metrics["http_code"] = int(metrics["http_code"])
    result = {"sample": index, "startedAtUtc": started_at, "curlExit": completed.returncode, "metrics": metrics,
              "stages": stages(metrics, urlsplit(url).scheme == "https"),
              "requestId": request_id(headers_file.read_text(encoding="utf-8", errors="replace")) if headers_file.exists() else None}
    result["success"] = False
    if completed.returncode == 0 and metrics["http_code"] == 200 and response_file.exists():
        try:
            value = json.loads(response_file.read_bytes())
            content, finish = response_text(value)
            result["success"] = bool(content.strip()) and finish != "length"
            result["characters"] = len(content)
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            pass
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="使用现有原生 worker 的请求，对已授权图片进行真实 OCR 网络分段测速（产生服务费用）。")
    parser.add_argument("--worker-exe", required=True, type=Path)
    parser.add_argument("--settings-db", required=True, type=Path)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--levels", default="1,5")
    parser.add_argument("--repeats", default=1, type=int)
    parser.add_argument("--route", choices=["configured", "direct"], default="configured", help="仅为本次 curl 请求禁用代理，不修改系统或应用设置。")
    args = parser.parse_args()
    levels = [int(item) for item in args.levels.split(",")]
    if not levels or any(level < 1 or level > 5 for level in levels) or not 1 <= args.repeats <= 3:
        parser.error("并发级别必须为 1–5；每档重复次数为 1–3。")
    curl = shutil.which("curl.exe")
    if not curl:
        parser.error("未找到 Windows curl.exe。")
    version = subprocess.check_output([curl, "--disable", "--version"], encoding="utf-8").splitlines()[0]
    match = re.search(r"curl (\d+)\.(\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < (8, 10, 0):
        parser.error("需 curl 8.10 或以上版本才能准确记录上传结束时间。")
    with sqlite3.connect(args.settings_db.resolve(strict=True).as_uri() + "?mode=ro", uri=True) as connection:
        row = connection.execute("SELECT value_json FROM settings WHERE key='ocr'").fetchone()
        ocr = json.loads(row[0])
    if ocr.get("engine") != "bailian":
        parser.error("当前 OCR 引擎不是百炼，不改动现有引擎。")
    base = ocr.get("bailian_base_url") or "https://dashscope.aliyuncs.com/compatible-mode/v1"
    model = (ocr.get("bailian_model") or "qwen3.5-ocr").strip() or "qwen3.5-ocr"
    url = endpoint(base)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {"curl": version, "host": urlsplit(url).hostname, "model": ocr.get("bailian_model") or "qwen3.5-ocr", "route": args.route,
              "proxyEnvironmentConfigured": any(value for key, value in os.environ.items() if key.lower() in {"https_proxy", "http_proxy", "all_proxy"}),
              "scope": "Independent curl transport with the native worker's exact normalized image/body. Fresh connections, no retries. Waiting after upload includes remote processing AND return-network latency; not server-only compute time. No image downscaling or prompt changes.", "runs": []}
    with tempfile.TemporaryDirectory(prefix="audit-ocr-network-") as temporary:
        root = Path(temporary)
        body, authorization = capture(args.worker_exe.resolve(strict=True), args.image.resolve(strict=True), ocr, root)
        url, body = production_request(base, model, body)
        report["protocol"] = "native-document-parsing" if "/multimodal-generation/" in url else "compatible"
        report["bodySha256"] = hashlib.sha256(body).hexdigest()
        report["requestBytes"] = len(body)
        body_file = root / "body.json"
        body_file.write_bytes(body)
        index = 0
        for repeat in range(args.repeats):
            for level in levels:
                started = time.perf_counter()
                with ThreadPoolExecutor(max_workers=level) as pool:
                    samples = list(pool.map(lambda i: measure(curl, url, body_file, authorization, root, i, args.route == "direct"), range(index, index + level)))
                index += level
                run = {"repeat": repeat + 1, "concurrency": level, "wallSeconds": time.perf_counter() - started, "samples": samples}
                report["runs"].append(run)
                (args.output / "network-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
                print(json.dumps(run, ensure_ascii=False), flush=True)
        if not all(sample["success"] for run in report["runs"] for sample in run["samples"]):
            raise RuntimeError("部分请求失败；错误码、状态和已测阶段已写入报告，没有自动重试。")


if __name__ == "__main__":
    main()
