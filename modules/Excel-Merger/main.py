"""Excel-Merger 工具入口，供审计工具箱 Hub 调用。"""
from __future__ import annotations

import tkinter as tk
from launcher.ui_theme import apply_app_theme, normalize_layout_tree, set_dark_title_bar


def main(root=None):
    """启动 Excel 批量合并工具。root 为 Hub 传入窗口；独立运行时自己创建。"""
    own_root = root is None
    if own_root:
        root = tk.Tk()
    apply_app_theme(root)
    set_dark_title_bar(root)

    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass

    from batch_merger import BatchMergeApp
    app = BatchMergeApp(root)
    normalize_layout_tree(root)
    if own_root:
        root.mainloop()


if __name__ == "__main__":
    main()
