"""
审计工具箱 — 统一入口
"""
from __future__ import annotations

import sys
from pathlib import Path

# 在创建任何 Tk 窗口之前设置进程级 DPI 感知，确保全程 UI 清晰度一致。
# 必须在 import tkinter 之前调用；子工具若重复调用此 API 会静默忽略（已设置则无效）。
try:
    from ctypes import windll
    windll.shcore.SetProcessDpiAwareness(1)
except Exception:
    pass

# 保证套件根目录在 sys.path，便于 import launcher
_SUITE_ROOT = Path(__file__).resolve().parent
if str(_SUITE_ROOT) not in sys.path:
    sys.path.insert(0, str(_SUITE_ROOT))


def main() -> None:
    from launcher.bundle_anchor import touch_bundle_deps
    from launcher.hub_window import HubWindow

    touch_bundle_deps()
    app = HubWindow()
    app.run()


if __name__ == "__main__":
    main()
