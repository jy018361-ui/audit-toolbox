"""按注册表启动子工具，结束后返回启动器。"""
from __future__ import annotations

import importlib.util
import inspect
import os
import sys
import traceback
from typing import Callable, Optional

from pathlib import Path

from launcher.registry import ToolSpec, resolve_entry_path, resolve_tool_root, suite_root


def _purge_tool_modules(tool_root: Path) -> None:
    """卸载子工具导入的模块，避免再次进入时使用旧状态。"""
    prefix = str(tool_root.resolve()).lower()
    for key in list(sys.modules):
        mod = sys.modules.get(key)
        if mod is None:
            continue
        mod_file = getattr(mod, "__file__", None)
        if mod_file and str(Path(mod_file).resolve()).lower().startswith(prefix):
            sys.modules.pop(key, None)


def launch_tool(
    tool: ToolSpec,
    parent=None,
    on_error: Optional[Callable[[str], None]] = None,
) -> None:
    """启动子工具；Hub 传入 parent 时子窗口为 Toplevel，主界面保持显示。"""
    tool_root = resolve_tool_root(tool)
    entry_path = resolve_entry_path(tool, tool_root)
    old_cwd = os.getcwd()
    old_path = list(sys.path)
    inserted = str(tool_root)
    module_name = f"suite_tool_{tool.id}"
    loaded_name: str | None = None

    try:
        if inserted not in sys.path:
            sys.path.insert(0, inserted)
        os.chdir(tool_root)

        spec = importlib.util.spec_from_file_location(module_name, entry_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"无法加载: {entry_path}")
        module = importlib.util.module_from_spec(spec)
        loaded_name = module_name
        sys.modules[module_name] = module
        spec.loader.exec_module(module)

        fn = getattr(module, tool.callable_name, None)
        if fn is None or not callable(fn):
            raise AttributeError(f"缺少 {tool.callable_name}()")

        try:
            kwargs = {}
            if parent is not None:
                sig = inspect.signature(fn)
                if "parent" in sig.parameters:
                    kwargs["parent"] = parent
            fn(**kwargs)
        except SystemExit as exc:
            if exc.code not in (0, None) and on_error:
                on_error(f"工具「{tool.name}」异常退出 (code={exc.code})")
    except Exception:
        msg = f"启动「{tool.name}」失败:\n{traceback.format_exc()}"
        if on_error:
            on_error(msg)
        else:
            raise
    finally:
        os.chdir(old_cwd)
        sys.path[:] = old_path
        if loaded_name:
            sys.modules.pop(loaded_name, None)
            for key in list(sys.modules):
                if key == loaded_name or key.startswith(f"{loaded_name}."):
                    sys.modules.pop(key, None)
        _purge_tool_modules(tool_root)
        try:
            os.chdir(suite_root())
        except OSError:
            pass
