"""Explicit, bounded paid OCR probes; never changes user settings/projects.

Endpoint pairs use the installed worker, same image/model/task, one variable.
Concurrency batches use the actual parent dispatcher and an isolated database.
Credentials remain in the existing Windows credential manager / worker memory.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import statistics
import tempfile

from compare_ocr_clients import ClashObserver, native_worker
from verify_ocr_dispatch import dispatch, seed_database


def workspace_base(workspace: str) -> str:
    if not re.fullmatch(r"ws-[a-z0-9]{8,64}", workspace):
        raise ValueError("业务空间编号格式无效。")
    return f"https://{workspace}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"


def read_ocr(path: Path) -> dict:
    with closing(sqlite3.connect(path.resolve(strict=True).as_uri() + "?mode=ro", uri=True)) as connection:
        result = json.loads(connection.execute("SELECT value_json FROM settings WHERE key='ocr'").fetchone()[0])
    if result.get("engine") != "bailian" or result.get("bailian_model", "qwen3.5-ocr") != "qwen3.5-ocr":
        raise ValueError("只测试当前百炼 qwen3.5-ocr，不改变模型。")
    if (result.get("bailian_base_url") or "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/") != "https://dashscope.aliyuncs.com/compatible-mode/v1":
        raise ValueError("当前不是既有北京公共地址；请先核对测试范围。")
    return result


def quality_summary(value: dict) -> dict:
    text = value.get("text", "")
    tables = value.get("tables", [])
    # Hash/lengths are diagnostics, not an accuracy claim. Never put full
    # financial text or credentials in the summary printed to the terminal.
    return {"characters": len(text), "textSha256": hashlib.sha256(text.encode()).hexdigest(),
            "tableCount": len(tables), "tablesSha256": hashlib.sha256(json.dumps(tables, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
            "numericSha256": hashlib.sha256("|".join(re.findall(r"\d+(?:[.,/%-]\d+)*", text)).encode()).hexdigest()}


def saved_page(db: Path) -> dict:
    with closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)) as connection:
        row = connection.execute("SELECT data FROM ocr_pages LIMIT 1").fetchone()
    return quality_summary(json.loads(row[0])) if row else {}


def metrics(report: dict) -> dict:
    rows = [event["result"] for event in report["pages"] if event.get("phase") == "completed"]
    durations = [row["timings"]["workerMs"] / 1000 for row in rows]
    return {"wallSeconds": report["wallSeconds"], "success": len(rows), "peakRunning": report["peakRunning"],
            "medianPageSeconds": statistics.median(durations) if durations else None,
            "maxPageSeconds": max(durations, default=None),
            "pages": [{"page": row["page"], "timings": row["timings"], "quality": quality_summary(row)} for row in rows]}


def main():
    parser = argparse.ArgumentParser(description="手动付费测速：相同合同页面、原生文档解析、现有Clash规则，隔离数据库。")
    parser.add_argument("--mode", choices=["endpoints", "concurrency"], required=True)
    parser.add_argument("--worker-exe", type=Path, required=True)
    parser.add_argument("--test-exe", type=Path)
    parser.add_argument("--settings-db", type=Path, required=True)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--clash-config", type=Path)
    parser.add_argument("--host", choices=["public", "workspace"], default="workspace")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--reverse", action="store_true", help="按8、5、3倒序对照，降低固定测试顺序的影响。")
    args = parser.parse_args()
    if args.repeats not in (1, 2):
        parser.error("每档仅允许1至2轮。")
    ocr = read_ocr(args.settings_db)
    dedicated = workspace_base(args.workspace)
    bases = {"public": "https://dashscope.aliyuncs.com/compatible-mode/v1", "workspace": dedicated}
    exe = args.worker_exe.resolve(strict=True)
    args.output.mkdir(parents=True, exist_ok=False)
    output = args.output.resolve()
    report = {"mode": args.mode, "workerSha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
              "runs": [], "newOcrCalls": 0, "productionDefaultConcurrency": 5,
              "scope": "Same cached PNGs, qwen3.5-ocr native document_parsing, existing proxy rules, isolated DB. Not full GUI/PDF.js; no changes to settings, credentials, installations, or user projects."}

    def save():
        (output / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="audit-ocr-speed-") as temporary:
        root = Path(temporary)
        if args.mode == "endpoints":
            # Three paired probes, six paid calls total. Reverse scheduling in
            # the middle pair; do not infer p95 from this small sample.
            for index, page in enumerate([30, 11, 1]):
                image = (args.images / f"page-{page:02}.png").read_bytes()
                order = ["public", "workspace"] if index % 2 == 0 else ["workspace", "public"]
                observers = [ClashObserver(args.clash_config, base.split('/')[2]) for base in bases.values()]
                for observer in observers:
                    observer.start()
                print(f"开始地址对照 {index + 1}/3，源第 {page} 页，两个地址同时识别。", flush=True)
                try:
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        tasks = {}
                        for host in order:
                            work = root / f"{index}-{host}"
                            work.mkdir()
                            config = {**ocr, "bailian_base_url": bases[host]}
                            tasks[host] = (work, pool.submit(native_worker, exe, work, image, config))
                        samples = {}
                        for host, (work, task) in tasks.items():
                            result = task.result()
                            result["quality"] = saved_page(work / "native.sqlite") if result["success"] else {}
                            samples[host] = result
                finally:
                    for observer in observers:
                        observer.stop()
                report["newOcrCalls"] += 2
                row = {"sourcePage": page, "imageSha256": hashlib.sha256(image).hexdigest(), "samples": samples,
                       "routes": [observer.report() for observer in observers]}
                report["runs"].append(row)
                save()
                print(json.dumps({"sourcePage": page, "samples": {host: {
                    "success": item["success"], "wallSeconds": item["wallSeconds"],
                    "http": ((item.get("timings") or {}).get("httpRequests") or [])
                } for host, item in samples.items()}}, ensure_ascii=False), flush=True)
                if not all(item["success"] for item in samples.values()):
                    raise RuntimeError("地址对照失败，停止后续付费调用；未重试或更改配置。")
                for host, sample in samples.items():
                    requests = (sample.get("timings") or {}).get("httpRequests") or []
                    if not requests or requests[0].get("host") != bases[host].split('/')[2]:
                        raise RuntimeError("请求未到达预期主机，停止后续调用。")
        else:
            if not args.test_exe:
                parser.error("并发测试需要当前真实父调度器测试EXE。")
            test = args.test_exe.resolve(strict=True)
            pages = [1, 2, 3, 11, 21, 25, 29, 30]
            report["testExeSha256"] = hashlib.sha256(test.read_bytes()).hexdigest()
            report["host"] = bases[args.host].split('/')[2]
            for repeat in range(args.repeats):
                order = [8, 5, 3] if args.reverse else [3, 5, 8]
                for level in (order if repeat == 0 else list(reversed(order))):
                    work = output / f"round-{repeat + 1}-limit-{level}"
                    work.mkdir()
                    db = work / "isolated.sqlite"
                    seed_database(db, 30, "同八页并发对照")
                    jobs = [{"__dbPath": str(db), "__settings": {"ocr": {**ocr, "bailian_base_url": bases[args.host]}, "llm": {"enabled": False}},
                             "documentId": "d", "page": page, "expectedRevision": 0, "layout": "full",
                             "imageBase64": base64.b64encode((args.images / f"page-{page:02}.png").read_bytes()).decode()} for page in pages]
                    print(f"开始并发 {level} 页，第 {repeat + 1} 轮，同一组8页。", flush=True)
                    # dispatch enforces success of every page. On any failure
                    # retain its detailed local report and stop later batches.
                    report["newOcrCalls"] += len(jobs)
                    save()
                    try:
                        result = dispatch(test, exe, work, jobs, level)
                    except Exception:
                        report["stoppedAfterFailure"] = True
                        save()
                        raise
                    row = {"repeat": repeat + 1, "concurrency": level, **metrics(result)}
                    report["runs"].append(row)
                    save()
                    print(json.dumps({key: value for key, value in row.items() if key != "pages"}, ensure_ascii=False), flush=True)
                    if row["success"] != 8 or row["peakRunning"] > level:
                        raise RuntimeError("批次未满足并发/成功检查，停止后续调用。")


if __name__ == "__main__":
    main()
