"""Offline actual-worker upload acceptance. Uses synthetic loopback OCR only;
no API credentials, cloud calls or writes to user projects/settings.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading

from PIL import Image

from verify_ocr_dispatch import seed_database
from verify_ocr_workers import invoke


def pixels(data: bytes, rotation: int = 0) -> Image.Image:
    with Image.open(BytesIO(data)) as opened:
        image = opened.convert("RGBA")
    if rotation:
        image = image.transpose({90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}[rotation])
    return image


def main():
    parser = argparse.ArgumentParser(description="隔离原生worker的本机图片上传验收，不调用云端服务。")
    parser.add_argument("--worker-exe", required=True, type=Path)
    parser.add_argument("--baseline-exe", type=Path)
    parser.add_argument("--images", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    worker = args.worker_exe.resolve(strict=True)
    variants = {"new": worker}
    if args.baseline_exe:
        variants["installedBaseline"] = args.baseline_exe.resolve(strict=True)
    captured = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            captured.append(base64.b64decode(request["image"].split(",", 1)[-1]))
            body = json.dumps({"text": "合成原文测试 " * 40, "tables": [], "warnings": []}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    args.output.mkdir(parents=True, exist_ok=False)
    report = {"cloudCalls": 0, "credentialsRead": False, "runs": [],
              "scope": "Actual native worker and optional installed baseline, isolated DB, synthetic local OCR, cached real PNGs. Debug vs installed release timings are not a production speed ratio."}
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="audit-upload-offline-") as temporary:
            root = Path(temporary)
            for page in [1, 11, 30]:
                original = (args.images / f"page-{page:02}.png").read_bytes()
                order = list(variants) if page == 11 else list(reversed(variants))
                for variant in order:
                    db = root / f"{page}-{variant}.sqlite"
                    seed_database(db, 30)
                    count = len(captured)
                    event = invoke(variants[variant], root, "ocr.recognize_page", {
                        "__dbPath": str(db), "__settings": {"ocr": {"engine": "local"}, "llm": {"enabled": False}},
                        "documentId": "d", "page": page, "expectedRevision": 0, "layout": "full",
                        "imageBase64": base64.b64encode(original).decode(),
                    })
                    assert event["phase"] == "completed" and len(captured) == count + 1
                    uploaded = captured[-1]
                    result = event["result"]
                    rotation = result.get("metadata", {}).get("autoRotation", 0)
                    expected, actual = pixels(original, rotation), pixels(uploaded)
                    assert expected.size == actual.size and expected.tobytes() == actual.tobytes()
                    row = {"sourcePage": page, "variant": variant, "rotation": rotation,
                           "sourceBytes": len(original), "uploadBytes": len(uploaded),
                           "byteIdentical": original == uploaded, "pixelsEqual": True,
                           "sourceSha256": hashlib.sha256(original).hexdigest(),
                           "uploadedSha256": hashlib.sha256(uploaded).hexdigest(), "timings": result["timings"]}
                    if variant == "new" and rotation == 0:
                        assert row["byteIdentical"], "普通PNG没有复用原字节。"
                    report["runs"].append(row)
                    (args.output / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
                    print(json.dumps(row, ensure_ascii=False), flush=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
