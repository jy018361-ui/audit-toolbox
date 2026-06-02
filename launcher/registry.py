"""工具注册表：解析 tools.json 与工具根目录（vendor / modules / tools / dev_root）。"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional

# 开发时查找子工具源码的顺序（冻结后仅 bundle 内的 vendor/）
_TOOL_SOURCE_DIRS = ("vendor", "modules", "tools")


def suite_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


def config_path() -> Path:
    root = suite_root()
    candidate = root / "tools.json"
    if candidate.is_file():
        return candidate
    return Path(__file__).resolve().parent.parent / "tools.json"


def tool_source_roots() -> tuple[str, ...]:
    """返回当前环境下用于查找工具源码的子目录名。"""
    if getattr(sys, "frozen", False):
        return ("modules", "tools")
    return _TOOL_SOURCE_DIRS


@dataclass(frozen=True)
class ToolSpec:
    id: str
    name: str
    description: str
    vendor_dir: str
    dev_root: Optional[str]
    entry: str
    callable_name: str
    entry_dev: Optional[str] = None
    entry_vendor: Optional[str] = None

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "ToolSpec":
        root = suite_root()
        vendor_dir = data["vendor_dir"]
        entry_dev = data.get("entry_dev")
        entry_vendor = data.get("entry_vendor")
        entry = data.get("entry")
        if not entry:
            has_vendor_tree = any(
                (root / sub / vendor_dir).is_dir() for sub in tool_source_roots()
            )
            if has_vendor_tree and entry_vendor:
                entry = entry_vendor
            elif entry_dev:
                entry = entry_dev
            else:
                entry = "main.py"
        return ToolSpec(
            id=data["id"],
            name=data["name"],
            description=data.get("description", ""),
            vendor_dir=vendor_dir,
            dev_root=data.get("dev_root"),
            entry=entry,
            callable_name=data.get("callable", "main"),
            entry_dev=entry_dev,
            entry_vendor=entry_vendor,
        )


def load_config() -> dict[str, Any]:
    with open(config_path(), "r", encoding="utf-8") as f:
        return json.load(f)


def load_tools() -> List[ToolSpec]:
    cfg = load_config()
    return [ToolSpec.from_dict(t) for t in cfg.get("tools", [])]


def suite_title() -> str:
    return load_config().get("suite_title", "审计工具箱")


def suite_version() -> str:
    return load_config().get("suite_version", "1.0.0")


def resolve_tool_root(tool: ToolSpec) -> Path:
    root = suite_root()
    for sub in tool_source_roots():
        candidate = root / sub / tool.vendor_dir
        if candidate.is_dir():
            return candidate.resolve()
    if tool.dev_root:
        dev = Path(tool.dev_root)
        if dev.is_dir():
            return dev.resolve()
    frozen = getattr(sys, "frozen", False)
    hint = (
        "工具未打包进 exe，请检查 tools.json 配置和构建流程"
        if frozen
        else (
            "请将工具放入 tools/ 或 modules/ 目录，或配置 dev_root 路径"
        )
    )
    raise FileNotFoundError(
        f"找不到工具「{tool.name}」的运行目录（vendor_dir={tool.vendor_dir}）。\n{hint}"
    )


def resolve_entry_path(tool: ToolSpec, tool_root: Path) -> Path:
    for name in (tool.entry, tool.entry_dev, tool.entry_vendor):
        if not name:
            continue
        candidate = tool_root / name
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(
        f"工具「{tool.name}」入口不存在: {tool.entry}\n目录: {tool_root}"
    )
