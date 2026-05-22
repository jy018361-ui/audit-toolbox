"""ASCII 入口，供审计工具箱动态加载文件夹清单工具。"""
from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_impl_module():
    base = Path(__file__).resolve().parent
    candidates = [
        path for path in base.glob("*.py")
        if path.name.lower() != "main.py"
    ]
    if not candidates:
        raise FileNotFoundError("未找到文件夹清单工具实现脚本")

    impl_path = candidates[0]
    spec = importlib.util.spec_from_file_location("file_list_directory_impl", impl_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载工具实现: {impl_path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(root=None):
    module = _load_impl_module()
    if not hasattr(module, "main"):
        raise AttributeError("工具实现缺少 main(root=None) 入口")
    return module.main(root=root)
