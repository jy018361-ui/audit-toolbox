"""工具注册表：解析 tools.json 与工具根目录（开发 / vendor / 冻结）。"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional


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
        vendor_root = suite_root() / "vendor" / data["vendor_dir"]
        entry_dev = data.get("entry_dev")
        entry_vendor = data.get("entry_vendor")
        entry = data.get("entry")
        if not entry:
            if vendor_root.is_dir() and entry_vendor:
                entry = entry_vendor
            elif entry_dev:
                entry = entry_dev
            else:
                entry = "main.py"
        return ToolSpec(
            id=data["id"],
            name=data["name"],
            description=data.get("description", ""),
            vendor_dir=data["vendor_dir"],
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
    vendor = suite_root() / "vendor" / tool.vendor_dir
    if vendor.is_dir():
        return vendor.resolve()
    if tool.dev_root:
        dev = Path(tool.dev_root)
        if dev.is_dir():
            return dev.resolve()
    raise FileNotFoundError(
        f"找不到工具「{tool.name}」的运行目录。\n"
        f"请确认 dev_root 存在，或执行: python build_suite.py --sync-only"
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
