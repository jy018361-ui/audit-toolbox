"""兼容旧导出入口；文案直接读取当前 TypeScript，不再维护手抄副本。"""
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"
node = os.environ.get("CODEX_WORKSPACE_NODE") or (str(bundled) if bundled.exists() else shutil.which("node"))
if not node:
    raise SystemExit("未找到 Node.js，无法导出新手指引文案。")
subprocess.run([node, str(root / "scripts/export_tour_copy_list.mjs"), *sys.argv[1:]], cwd=root, check=True)
