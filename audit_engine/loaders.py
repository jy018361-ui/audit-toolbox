from __future__ import annotations

import importlib.util
import sys
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parent.parent


@contextmanager
def import_path(path: Path):
    value = str(path)
    sys.path.insert(0, value)
    try:
        yield
    finally:
        try:
            sys.path.remove(value)
        except ValueError:
            pass


def load_file(module_name: str, relative_path: str) -> ModuleType:
    path = ROOT / relative_path
    if not path.is_file():
        raise FileNotFoundError(path)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载模块: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    with import_path(path.parent):
        spec.loader.exec_module(module)
    return module
