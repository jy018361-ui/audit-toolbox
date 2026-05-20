"""
主程序入口
"""
import sys
import tkinter as tk
from tkinter import messagebox
from gui.main_window import MainWindow


def main(root=None):
    """主函数。root 为 runner 传入的窗口，独立运行时自己创建。"""
    own_root = root is None
    try:
        if own_root:
            root = tk.Tk()
        app = MainWindow(root=root)
        if own_root:
            app.run()
    except Exception as e:
        # 显示错误信息
        err_root = root if root is not None and root.winfo_exists() else tk.Tk()
        if err_root is not root:
            err_root.withdraw()
        messagebox.showerror(
            "启动错误",
            f"应用程序启动失败:\n{str(e)}\n\n请检查依赖包是否已正确安装。"
        , parent=err_root)
        if err_root is not root and err_root.winfo_exists():
            err_root.destroy()
        return


if __name__ == "__main__":
    main()
