"""大文件路径的合成 worker 冒烟验收；开发工具，不随产品运行。

python scripts/verify_large_file_workers.py --exe <EXE> --out <验收目录> --only fx
此脚本验证完整 worker 入口与业务结果，不代替大型原始文件的峰值内存验收。
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
import subprocess
import uuid


def write_csv(path: Path, rows: list[list[object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as stream:
        csv.writer(stream).writerows(rows)


def build_fx_request(root: Path) -> dict:
    """乱序日期、分散凭证及跨月审计基础；强制完整 JE 磁盘路径。"""
    root.mkdir(parents=True, exist_ok=True)
    je = root / "序时账.csv"
    tb = root / "余额表.csv"
    write_csv(je, [
        ["主体", "日期", "凭证号", "科目编码", "科目名称", "币种", "原币", "本位币"],
        ["E", "2025-02-10", "2", "100201", "银行存款", "CNY", 0, 720],
        ["E", "2025-01-10", "1", "112203", "应收账款", "USD", 100, 700],
        [],
        ["E", "2025-02-10", "2", "112203", "应收账款", "USD", -100, -700],
        ["E", "2025-01-10", "1", "6001", "主营业务收入", "CNY", 0, -700],
        ["E", "2025-02-10", "2", "660302", "汇兑损益", "CNY", 0, -20],
    ])
    write_csv(tb, [
        ["主体", "科目编码", "科目名称", "币种", "期初原币", "期末原币", "期初本位币", "期末本位币", "本年借方", "本年贷方"],
        ["E", "100201", "银行存款", "CNY", 0, 0, 0, 720, 720, 0],
        ["E", "112203", "应收账款", "USD", 0, 0, 0, 0, 700, 700],
        ["E", "6001", "主营业务收入", "CNY", 0, 0, 0, -700, 0, 700],
        ["E", "660302", "汇兑损益", "CNY", 0, 0, 0, -20, 0, 20],
    ])
    rates = [("2024-12-31", 6.9), ("2025-01-01", 6.9), ("2025-01-10", 7.0),
             ("2025-01-31", 7.1), ("2025-02-01", 7.1), ("2025-02-10", 7.2), ("2025-02-28", 7.3)]
    points = [{"requestedDate": date, "publishedDate": date, "currency": code, "cnyPerUnit": value}
              for date, usd in rates for code, value in [("USD", usd), ("CNY", 1.0)]]
    params = {
        "mode": "combined", "fixedEntity": "E", "reportStart": "2025-01-01", "reportEnd": "2025-02-28",
        "__largeJeDiskMode": True, "translateTbAccountNames": False,
        "jeSource": {"inputPath": str(je.resolve()), "sheet": "CSV", "headerRow": 1, "headerDepth": 1},
        "tbSource": {"inputPath": str(tb.resolve()), "sheet": "CSV", "headerRow": 1, "headerDepth": 1},
        "jeMapping": {"entity": "主体", "date": "日期", "id": ["凭证号"], "accountCode": "科目编码",
                      "accountName": "科目名称", "currency": "币种", "foreignAmount": "原币",
                      "functionalAmount": "本位币", "__signConvention": "signed"},
        "tbMapping": {"entity": "主体", "accountCode": "科目编码", "accountName": "科目名称", "currency": "币种",
                      "openingForeignAmount": "期初原币", "closingForeignAmount": "期末原币",
                      "openingFunctionalAmount": "期初本位币", "closingFunctionalAmount": "期末本位币",
                      "ytdFunctionalDebit": "本年借方", "ytdFunctionalCredit": "本年贷方", "__signConvention": "unsigned"},
        "accountRoles": {"100201": "cash", "112203": "monetary_asset", "6001": "non_monetary", "660302": "fx_gain_loss"},
        "rateSnapshot": {"source": "合成验收牌价", "sourceUrl": "", "fetchedAt": "", "responseHash": hashlib.sha256(json.dumps(points).encode()).hexdigest(),
                         "startDate": "2024-12-31", "endDate": "2025-02-28", "rates": points, "missing": []},
    }
    return {"jobId": f"disk-fx-{uuid.uuid4().hex}", "method": "fx.preview", "params": params,
            "cancelPath": str((root / "cancel.flag").resolve()), "pausePath": str((root / "pause.flag").resolve())}


def run_worker(exe: Path, root: Path, label: str, request: dict, timeout: int = 120) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":"))
    (root / f"{label}-request.json").write_text(encoded, encoding="utf-8")
    child = subprocess.run([str(exe.resolve()), "--rust-table-worker"], input=encoded + "\n",
                           text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=timeout,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False)
    (root / f"{label}-events.jsonl").write_text(child.stdout, encoding="utf-8")
    (root / f"{label}-stderr.log").write_text(child.stderr, encoding="utf-8")
    events = [json.loads(line) for line in child.stdout.splitlines() if line.strip()]
    completed = [event for event in events if event.get("phase") == "completed"]
    if child.returncode or not completed or "result" not in completed[-1]:
        raise AssertionError(f"{label} worker 未完成，退出码 {child.returncode}；请查看 {root} 的日志")
    return completed[-1]["result"]


def assert_fx_result(result: dict) -> None:
    assert result.get("largeJeDiskMode") is True, "FX 未执行磁盘路径"
    summary = result.get("summary", {})
    assert summary.get("realizedEvents", 0) > 0, "完整凭证未进入已实现测算"
    assert summary.get("unrealizedRows", 0) > 0, "跨月审计余额未生成"
    assert summary.get("realizedGainLoss") is not None, "缺少已实现汇兑损益结果"
    assert abs(summary["realizedGainLoss"] + 10.0) < 0.01, summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--only", choices=["all", "fx", "fa", "policy", "depreciation", "fuzzy", "loan", "deposit", "tbje"], default="all")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    from large_file_smoke_cases import build_cases, assert_case
    requests = build_cases(args.out.resolve() / "cases")
    requests["fx"] = build_fx_request(args.out.resolve() / "fx")
    for label, request in requests.items():
        if args.only not in {"all", label}:
            continue
        root = args.out.resolve() / label
        result = run_worker(args.exe, root, label, request, args.timeout)
        if label == "fx":
            assert_fx_result(result)
        else:
            assert_case(label, result, request)
        (root / f"{label}-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{label} worker 合成验收通过：{root}")


if __name__ == "__main__":
    main()
