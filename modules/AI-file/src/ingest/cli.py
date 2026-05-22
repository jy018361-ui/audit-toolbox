"""命令行：对案例库或指定 Excel 底稿做读取诊断。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ingest.workbook_reader import diagnose_workbook


def _find_case_library(root: Path) -> Path | None:
    for p in root.iterdir():
        if p.is_dir() and p.name.endswith("agent"):
            for c in p.iterdir():
                if c.is_dir() and "案例" in c.name:
                    return c
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="固定资产底稿读取诊断")
    parser.add_argument(
        "paths",
        nargs="*",
        help="Excel 文件或目录；默认扫描项目下案例库",
    )
    parser.add_argument(
        "--max-mb",
        type=float,
        default=20.0,
        help="跳过大于该体积（MB）的文件，默认 20",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="输出 JSON",
    )
    args = parser.parse_args()

    files: list[Path] = []
    if args.paths:
        for p in args.paths:
            path = Path(p)
            if path.is_file() and path.suffix.lower() in (".xlsx", ".xlsm"):
                files.append(path)
            elif path.is_dir():
                files.extend(sorted(path.glob("*.xlsx")))
    else:
        root = Path.cwd()
        case_dir = _find_case_library(root)
        if case_dir:
            files = sorted(case_dir.glob("*.xlsx"))
        else:
            print("未找到案例库目录，请指定文件路径。", file=sys.stderr)
            sys.exit(1)

    max_bytes = int(args.max_mb * 1024 * 1024)
    results = []
    for f in files:
        if f.stat().st_size > max_bytes:
            results.append({"path": str(f), "skipped": True, "reason": f"size>{args.max_mb}MB"})
            continue
        diag = diagnose_workbook(f)
        results.append(diag.to_dict())

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for item in results:
            if item.get("skipped"):
                print(f"SKIP {item['path']} ({item['reason']})")
                continue
            print(f"\n=== {item['path']} ===")
            for s in item.get("sheets", []):
                if s["kind"] in ("skip",):
                    continue
                line = (
                    f"  [{s['kind']}] {s['sheet_name']} "
                    f"conf={s['confidence']} name={s['name_score']} content={s['content_score']}"
                )
                if s.get("header_row"):
                    line += f" header_row={s['header_row']}"
                print(line)
                if s["kind"] == "fa_list":
                    if s["missing_required"]:
                        print(f"    missing_required: {s['missing_required']}")
                    if s["missing_recommended"]:
                        print(f"    missing_recommended: {s['missing_recommended']}")
                    if s["mapped_fields"]:
                        print(f"    mapped: {len(s['mapped_fields'])} fields")
                if s.get("notes"):
                    for n in s["notes"]:
                        print(f"    note: {n}")


if __name__ == "__main__":
    main()
