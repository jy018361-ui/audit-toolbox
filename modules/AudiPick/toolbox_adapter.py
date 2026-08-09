"""audit-toolbox adapter for the AudiPick Electron application."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from tkinter import messagebox


def _portable_candidates() -> list[Path]:
    """Return supported sidecar/build locations without bundling Electron."""
    roots: list[Path] = []
    if getattr(sys, "frozen", False):
        suite_dir = Path(sys.executable).resolve().parent
        roots.extend((suite_dir / "AudiPick", suite_dir))

    module_dir = Path(__file__).resolve().parent
    roots.extend((module_dir / "dist", module_dir))

    candidates: list[Path] = []
    patterns = ("AudiPick-便携版-*.exe", "AudiPick*.exe")
    for root in roots:
        if not root.is_dir():
            continue
        for pattern in patterns:
            candidates.extend(root.glob(pattern))
    return sorted(
        {path.resolve() for path in candidates if path.is_file()},
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def _npm_command() -> list[str] | None:
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        return None
    if os.name == "nt" and npm.lower().endswith((".cmd", ".bat")):
        command_processor = os.environ.get("ComSpec", "cmd.exe")
        return [command_processor, "/d", "/c", npm, "start"]
    return [npm, "start"]


def main(parent=None):
    """Launch a portable AudiPick build, or its source tree during development."""
    portable = _portable_candidates()
    if portable:
        return subprocess.call([str(portable[0])])

    module_dir = Path(__file__).resolve().parent
    package_json = module_dir / "package.json"
    npm_command = _npm_command()
    if package_json.is_file() and npm_command and not getattr(sys, "frozen", False):
        return subprocess.call(npm_command, cwd=module_dir)

    messagebox.showerror(
        "AudiPick 未安装",
        (
            "未找到 AudiPick 便携版。\n\n"
            "发布工具箱时，请将 AudiPick 便携版放到主程序旁的 "
            "AudiPick 文件夹中；开发环境也可以先在 modules/AudiPick "
            "执行 npm install。"
        ),
        parent=parent,
    )
    return 1


if __name__ == "__main__":
    main()
