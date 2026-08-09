from __future__ import annotations

import sys
import types
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from types import MethodType
from typing import Any

from .errors import EngineError
from .loaders import load_file


SUPPORTED = {".xlsx", ".xls", ".xlsm", ".csv", ".txt"}


class _Value:
    def __init__(self, value: Any):
        self.value = value

    def get(self) -> Any:
        return self.value

    def set(self, value: Any) -> None:
        self.value = value


class _ImmediateRoot:
    def after(self, _delay: int, callback):
        callback()


@contextmanager
def _legacy_ui_stubs():
    """Allow importing the proven merger core without bundling Tkinter."""
    names = ["tkinter", "tkinter.ttk", "tkinter.filedialog", "tkinter.messagebox", "launcher.ui_theme"]
    previous = {name: sys.modules.get(name) for name in names}
    tkinter = types.ModuleType("tkinter")
    tkinter.Toplevel = type("Toplevel", (), {})
    tkinter.Misc = object
    tkinter.TclError = RuntimeError
    tkinter.ttk = types.ModuleType("tkinter.ttk")
    tkinter.filedialog = types.ModuleType("tkinter.filedialog")
    tkinter.messagebox = types.ModuleType("tkinter.messagebox")
    theme = types.ModuleType("launcher.ui_theme")
    for name in (
        "add_standard_button",
        "apply_app_theme",
        "create_button_group",
        "create_section",
        "create_standard_layout",
        "fit_window_to_screen",
    ):
        setattr(theme, name, lambda *args, **kwargs: None)
    sys.modules.update(
        {
            "tkinter": tkinter,
            "tkinter.ttk": tkinter.ttk,
            "tkinter.filedialog": tkinter.filedialog,
            "tkinter.messagebox": tkinter.messagebox,
            "launcher.ui_theme": theme,
        }
    )
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


def _core_module():
    cached = sys.modules.get("audit_excel_merger_core")
    if cached is not None:
        return cached
    with _legacy_ui_stubs():
        return load_file("audit_excel_merger_core", "modules/Excel-Merger/batch_merger.py")


def normalize_paths(values: Any) -> list[Path]:
    if isinstance(values, str):
        values = [part.strip() for part in values.split(";") if part.strip()]
    paths: list[Path] = []
    seen: set[str] = set()
    for value in values or []:
        path = Path(str(value)).expanduser().resolve()
        key = str(path).casefold()
        if key in seen:
            continue
        if not path.is_file():
            raise EngineError("PATH_NOT_FOUND", f"找不到输入文件：{path}")
        if path.suffix.lower() not in SUPPORTED:
            raise EngineError("MERGER_FILE_UNSUPPORTED", f"不支持该文件格式：{path.name}")
        seen.add(key)
        paths.append(path)
    if not paths:
        raise EngineError("INVALID_ARGUMENT", "请至少添加一个 Excel、CSV 或 TXT 文件。")
    return paths


def scan_folder(folder: str) -> dict:
    root = Path(folder).expanduser().resolve()
    if not root.is_dir():
        raise EngineError("PATH_NOT_FOUND", f"找不到文件夹：{root}")
    files = sorted(
        (path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in SUPPORTED),
        key=lambda path: str(path).casefold(),
    )
    return {"folder": str(root), "inputPaths": [str(path) for path in files], "fileCount": len(files)}


def expand_paths(values: Any) -> dict:
    """Expand a mixed drag/drop selection of files and directories."""
    if isinstance(values, str):
        values = [values]
    files: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        path = Path(str(value)).expanduser().resolve()
        candidates = (
            sorted(path.rglob("*"), key=lambda item: str(item).casefold())
            if path.is_dir()
            else [path]
        )
        for candidate in candidates:
            if not candidate.is_file() or candidate.suffix.lower() not in SUPPORTED:
                continue
            key = str(candidate).casefold()
            if key not in seen:
                seen.add(key); files.append(str(candidate))
    return {"inputPaths": files, "fileCount": len(files)}


def inspect_files(values: Any) -> dict:
    module = _core_module()
    rows = []
    all_sheets: list[str] = []
    for path in normalize_paths(values):
        sheets: list[str] = []
        error = None
        if path.suffix.lower() not in {".csv", ".txt"}:
            try:
                sheets = list(module.get_sheet_names_lightweight_file(str(path)))
            except Exception as exc:
                error = str(exc)
        for sheet in sheets:
            if sheet not in all_sheets:
                all_sheets.append(sheet)
        rows.append(
            {
                "path": str(path),
                "name": path.name,
                "size": path.stat().st_size,
                "sheets": sheets,
                "error": error,
            }
        )
    return {"files": rows, "fileCount": len(rows), "availableSheets": all_sheets}


def run_merge(params: dict, progress, cancel) -> dict:
    module = _core_module()
    paths = normalize_paths(params.get("inputPaths"))
    explicit_output = str(params.get("outputPath") or "").strip()
    output_format = str(params.get("outputFormat") or "xlsx").lower().lstrip(".")
    if output_format not in {"xlsx", "csv"}:
        raise EngineError("MERGER_FORMAT_INVALID", "输出格式只能是 XLSX 或 CSV。")
    if explicit_output:
        output = Path(explicit_output).expanduser().resolve()
    else:
        directory_value = str(params.get("outputDirectory") or "").strip()
        directory = Path(directory_value).expanduser().resolve() if directory_value else paths[0].parent
        if not directory.is_dir():
            raise EngineError("PATH_NOT_FOUND", f"找不到输出目录：{directory}")
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output = directory / f"Excel合并结果_{stamp}.{output_format}"
        sequence = 1
        while output.exists():
            output = directory / f"Excel合并结果_{stamp}_{sequence}.{output_format}"
            sequence += 1
    output_mode = str(params.get("outputMode") or "one_sheet")
    direction = str(params.get("direction") or "vertical")
    sheet_action = str(params.get("sheetAction") or "default")
    target_sheets = [str(value) for value in params.get("targetSheets") or [] if str(value).strip()]
    add_hyperlinks = bool(params.get("addHyperlinks", True))
    if output_mode not in {"one_sheet", "one_workbook"}:
        raise EngineError("MERGER_MODE_INVALID", "输出模式不正确。")
    if direction not in {"vertical", "horizontal"}:
        raise EngineError("MERGER_DIRECTION_INVALID", "拼接方向不正确。")
    if sheet_action not in {"default", "match_selected", "merge_all"}:
        raise EngineError("MERGER_SHEET_ACTION_INVALID", "Sheet 合并范围不正确。")
    if sheet_action == "match_selected" and not target_sheets:
        raise EngineError("MERGER_SHEETS_REQUIRED", "按名称匹配时请至少选择一个 Sheet。")
    if output_mode == "one_workbook" and output.suffix.lower() == ".csv":
        raise EngineError("MERGER_WORKBOOK_REQUIRES_XLSX", "多 Sheet 工作簿必须导出为 XLSX。")
    if output.suffix.lower() not in {".xlsx", ".csv"}:
        output = output.with_suffix(".xlsx")
    output.parent.mkdir(parents=True, exist_ok=True)

    app = module.BatchMergeApp.__new__(module.BatchMergeApp)
    app.root = _ImmediateRoot()
    app.file_list = [str(path) for path in paths]
    app.read_warnings = []
    app.var_mode = _Value(output_mode)
    app.var_direction = _Value(direction)
    app.var_add_hyperlinks = _Value(add_hyperlinks)
    app.cancel_requested = False
    outcome: dict[str, Any] = {"status": "running", "warning": None, "error": None}
    step = {"current": 0}

    def post_status(_self, message: str):
        step["current"] += 1
        progress("merge", step["current"], 0, message, "info", None, None)

    def check_cancelled(_self):
        if cancel.is_set():
            raise module.MergeCancelled("用户已停止本次合并。")

    def notify_success(_self, _path: str, warning: str | None = None):
        outcome.update(status="completed", warning=warning)

    def on_cancelled(_self, message: str):
        outcome.update(status="cancelled", error=message)

    def on_error(_self, message: str):
        outcome.update(status="failed", error=message)

    app._post_status = MethodType(post_status, app)
    app._check_cancelled = MethodType(check_cancelled, app)
    app._notify_success = MethodType(notify_success, app)
    app.on_cancelled = MethodType(on_cancelled, app)
    app.on_error = MethodType(on_error, app)
    sheet_config = {
        "action": sheet_action,
        "targets": target_sheets,
    }
    app.run_process(str(output), sheet_config)
    if outcome["status"] == "cancelled":
        raise EngineError("JOB_CANCELLED", outcome["error"] or "任务已取消。")
    if outcome["status"] != "completed":
        raise EngineError("MERGER_FAILED", "Excel 合并失败。", detail=outcome["error"])
    return {
        "inputFiles": len(paths),
        "outputMode": output_mode,
        "direction": direction,
        "sheetAction": sheet_action,
        "targetSheets": target_sheets,
        "warnings": app.read_warnings,
        "fallbackWarning": outcome["warning"],
        "outputPaths": [str(output)],
    }
