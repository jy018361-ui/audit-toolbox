"""工具选择主界面。"""
from __future__ import annotations

import tkinter as tk
from tkinter import messagebox, ttk
from typing import Callable, Optional

from launcher.registry import ToolSpec, load_tools, suite_title, suite_version
from launcher.runner import launch_tool


class HubWindow:
  def __init__(self, on_quit: Optional[Callable[[], None]] = None):
    self._on_quit = on_quit
    self.root = tk.Tk()
    self.root.title(suite_title())
    self.root.geometry("520x420")
    self.root.minsize(480, 360)
    self._build_ui()
    self.root.protocol("WM_DELETE_WINDOW", self._quit)

  def _build_ui(self) -> None:
    header = ttk.Frame(self.root, padding=(20, 16, 20, 8))
    header.pack(fill="x")
    ttk.Label(header, text=suite_title(), font=("", 16, "bold")).pack(anchor="w")
    ttk.Label(
      header,
      text=f"版本 {suite_version()}  ·  请选择要进入的工具",
      foreground="#555",
    ).pack(anchor="w", pady=(4, 0))

    body = ttk.Frame(self.root, padding=(20, 8, 20, 12))
    body.pack(fill="both", expand=True)

    tools = load_tools()
    if not tools:
      ttk.Label(body, text="tools.json 中未配置任何工具。").pack()
      return

    for tool in tools:
      self._add_tool_card(body, tool)

    footer = ttk.Frame(self.root, padding=(20, 0, 20, 16))
    footer.pack(fill="x")
    ttk.Button(footer, text="退出", command=self._quit).pack(side="right")

  def _add_tool_card(self, parent: ttk.Frame, tool: ToolSpec) -> None:
    card = ttk.LabelFrame(parent, text=tool.name, padding=12)
    card.pack(fill="x", pady=(0, 10))
    if tool.description:
      ttk.Label(card, text=tool.description, wraplength=440).pack(
        anchor="w", pady=(0, 8)
      )
    ttk.Button(card, text="进入", command=lambda t=tool: self._enter_tool(t)).pack(
      anchor="e"
    )

  def _enter_tool(self, tool: ToolSpec) -> None:
    def show_error(msg: str) -> None:
      messagebox.showerror("工具启动失败", msg, parent=self.root)

    launch_tool(tool, parent=self.root, on_error=show_error)

  def _quit(self) -> None:
    if self._on_quit:
      self._on_quit()
    self.root.destroy()

  def run(self) -> None:
    self.root.mainloop()
