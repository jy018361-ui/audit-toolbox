"""Excel-Merger 工具入口，供审计工具箱 Hub 调用。"""
from __future__ import annotations

import tkinter as tk


def main(parent=None):
    """启动 Excel 批量合并工具。parent 为 None 时独立运行，否则在父窗口下打开 Toplevel。"""
    if parent is not None:
        root = tk.Toplevel(parent)
    else:
        root = tk.Tk()

    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass

    from batch_merger import BatchMergeApp
    app = BatchMergeApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
