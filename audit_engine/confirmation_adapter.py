from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable

from .errors import EngineError
from .loaders import load_file


Progress = Callable[[str, int, int, str, str, list[str] | None, Any | None], None]

BANK_REQUIRED_COLUMNS = {
    "函证类型",
    "函证编号",
    "发函单位名称",
    "函证状态",
    "函证基准日",
    "发函模版",
    "发函签收时间",
    "询证项回函结果",
}
TRADE_REQUIRED_COLUMNS = {
    "函证类型",
    "函证编号",
    "发函单位名称",
    "函证状态",
    "发函签收时间",
    "询证项回函结果",
}
VALID_MODES = {"bank", "trade", "both"}


def _mode(value: Any) -> str:
    mode = str(value or "both")
    if mode not in VALID_MODES:
        raise EngineError("CONFIRMATION_MODE_INVALID", "统计类型必须为银行函证、往来函证或两类都生成。")
    return mode


def inspect_confirmation(path: Path, mode_value: Any = "both", limit: int = 12) -> dict:
    """Read the same first worksheet and string values as the legacy processor."""
    import pandas as pd

    mode = _mode(mode_value)
    try:
        frame = pd.read_excel(path, dtype=str)
    except Exception as exc:
        raise EngineError(
            "CONFIRMATION_READ_FAILED",
            "无法读取函证清单，请确认文件格式正确且未被占用。",
            detail=str(exc),
        ) from exc

    frame.columns = [str(value).strip() for value in frame.columns]
    headers = list(frame.columns)
    header_set = set(headers)
    if "函证类型" in frame.columns:
        bank_mask = frame["函证类型"].isin(["银行", "银行-电子函证"])
        bank_count = int(bank_mask.sum())
        trade_count = int((~bank_mask).sum())
    else:
        bank_count = 0
        trade_count = 0

    # The old program returns early for an empty category before touching that
    # category's other columns. Keep that behavior: a trade-only workbook can
    # still run "both" without bank-only columns such as 函证基准日.
    required = {"函证类型"}
    if mode in {"bank", "both"} and bank_count > 0:
        required.update(BANK_REQUIRED_COLUMNS)
    if mode in {"trade", "both"} and trade_count > 0:
        required.update(TRADE_REQUIRED_COLUMNS)
    missing = sorted(required - header_set)

    base_dates: list[str] = []
    if "函证基准日" in frame.columns:
        parsed = pd.to_datetime(frame["函证基准日"], errors="coerce")
        base_dates = sorted({value.strftime("%Y-%m-%d") for value in parsed.dropna()})

    def unique_count(column: str) -> int:
        if column not in frame.columns:
            return 0
        values = frame[column].dropna().astype(str).str.strip()
        return int(values[values.ne("")].nunique())

    preview_frame = frame.head(max(1, limit)).where(frame.head(max(1, limit)).notna(), None)
    preview = [list(row) for row in preview_frame.itertuples(index=False, name=None)]
    return {
        "path": str(path),
        "kind": "excel",
        "mode": mode,
        "headers": headers,
        "preview": preview,
        "dimensions": {"rows": len(frame), "columns": len(headers)},
        "requiredColumns": sorted(required),
        "requiredColumnsPresent": sorted(required & header_set),
        "missingColumns": missing,
        "statistics": {
            "total": len(frame),
            "bank": bank_count,
            "trade": trade_count,
            "projects": unique_count("项目名称"),
            "units": unique_count("发函单位名称"),
            "baseDates": base_dates,
        },
        "outputDirectory": str(path.parent / "函证统计结果"),
        "willGenerate": {
            "bank": mode in {"bank", "both"} and bank_count > 0,
            "trade": mode in {"trade", "both"} and trade_count > 0,
        },
    }


def process_confirmation(
    path: Path,
    mode_value: Any,
    progress: Progress,
    cancel: threading.Event,
) -> dict:
    mode = _mode(mode_value)
    check = inspect_confirmation(path, mode)
    if check["missingColumns"]:
        raise EngineError(
            "CONFIRMATION_COLUMNS_MISSING",
            "函证清单缺少列：" + "、".join(check["missingColumns"]),
        )

    module = load_file("audit_confirmation", "modules/confirmation_progress/confirmation_app.py")
    modes = ["bank", "trade"] if mode == "both" else [mode]
    outputs: list[str] = []
    reports: list[dict] = []
    total = len(modes)
    for index, item in enumerate(modes, start=1):
        if cancel.is_set():
            raise EngineError("JOB_CANCELLED", "任务已取消。")
        label = "银行函证" if item == "bank" else "往来函证"
        expected = check["statistics"][item]
        progress("process", index - 1, total, f"正在生成{label}报告", "info", None, None)
        if expected == 0:
            reports.append({"type": item, "label": label, "status": "skipped", "reason": "没有符合类型的数据"})
            progress("process", index, total, f"未发现{label}数据，已跳过", "warning", None, None)
            continue
        summary, output = (
            module.process_bank_confirmation(str(path))
            if item == "bank"
            else module.process_trade_confirmation(str(path))
        )
        if summary is None or output is None:
            raise EngineError(
                "CONFIRMATION_REPORT_FAILED",
                f"{label}报告生成失败，请检查函证清单内容。",
            )
        output_path = str(output)
        outputs.append(output_path)
        reports.append(
            {
                "type": item,
                "label": label,
                "status": "completed",
                "summaryRows": len(summary),
                "outputPath": output_path,
            }
        )
        progress("process", index, total, f"{label}报告已生成", "success", [output_path], None)

    if not outputs:
        raise EngineError("CONFIRMATION_EMPTY", "输入文件中没有符合所选类型的函证数据。")
    return {
        "mode": mode,
        "inputPath": str(path),
        "statistics": check["statistics"],
        "reports": reports,
        "outputDirectory": check["outputDirectory"],
        "outputPaths": outputs,
    }
