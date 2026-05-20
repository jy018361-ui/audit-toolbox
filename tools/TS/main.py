"""TS 管理工具箱入口包装。"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _load_impl_module():
    base = Path(__file__).resolve().parent
    impl_path = base / "cop123213y.py"
    if not impl_path.is_file():
        raise FileNotFoundError(f"未找到 TS 实现脚本: {impl_path}")

    spec = importlib.util.spec_from_file_location("ts_tool_impl", impl_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载 TS 实现脚本: {impl_path}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main(root=None):
    module = _load_impl_module()
    app_cls = getattr(module, "TimesheetPivotApp", None)
    if app_cls is None:
        raise AttributeError("TS 实现脚本缺少 TimesheetPivotApp 类")

    own_root = root is None
    if own_root:
        import tkinter as tk
        root = tk.Tk()

    app_cls(root)

    if own_root:
        root.mainloop()
