"""
主程序入口
"""
import sys
import tkinter as tk
from tkinter import messagebox
from gui.main_window import MainWindow


def main(parent=None):
    """主函数。parent 为工具箱 Hub 窗口时，子工具以 Toplevel 打开且不关闭 Hub。"""
    try:
        if parent is not None:
            win = tk.Toplevel(parent)
            win.transient(parent)
            app = MainWindow(root=win)
            app.run()
        else:
            app = MainWindow()
            app.run()
    except Exception as e:
        # 显示错误信息
        root = tk.Tk()
        root.withdraw()  # 隐藏主窗口
        messagebox.showerror(
            "启动错误",
            f"应用程序启动失败:\n{str(e)}\n\n请检查依赖包是否已正确安装。"
        )
        return


if __name__ == "__main__":
    main()
