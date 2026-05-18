"""
审计工具箱 — 统一入口
"""
from __future__ import annotations

import sys
from pathlib import Path

# 保证套件根目录在 sys.path，便于 import launcher
_SUITE_ROOT = Path(__file__).resolve().parent
if str(_SUITE_ROOT) not in sys.path:
    sys.path.insert(0, str(_SUITE_ROOT))


def _ensure_vendor() -> None:
    """开发模式下若 vendor 缺失则自动同步（便于首次运行）。"""
    if getattr(sys, "frozen", False):
        return
    vendor_fa = _SUITE_ROOT / "vendor" / "fa_list" / "main.py"
    if vendor_fa.is_file():
        return
    try:
        from build_suite import sync_vendor

        print("首次运行：正在同步 vendor ...")
        sync_vendor()
    except Exception as exc:
        print(f"vendor 自动同步失败（将使用 dev_root）: {exc}")


def main() -> None:
    from launcher.bundle_anchor import touch_bundle_deps
    from launcher.hub_window import HubWindow

    _ensure_vendor()
    touch_bundle_deps()
    app = HubWindow()
    app.run()


if __name__ == "__main__":
    main()
