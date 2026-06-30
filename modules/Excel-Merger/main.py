"""Excel-Merger 工具入口，供审计工具箱 Hub 调用。"""
from __future__ import annotations

import tkinter as tk
from launcher.ui_theme import apply_app_theme, normalize_layout_tree, set_dark_title_bar


def main(parent=None):
    """启动 Excel 批量合并工具。parent 为 None 时独立运行，否则在父窗口下打开 Toplevel。"""
    if parent is not None:
        root = tk.Toplevel(parent)
    else:
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
    root.mainloop()


if __name__ == "__main__":
    main()
