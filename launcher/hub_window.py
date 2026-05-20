"""工具箱工作台主界面。"""
from __future__ import annotations

import tkinter as tk
from tkinter import font as tkfont
from tkinter import messagebox
from typing import Callable, Optional

from launcher.registry import ToolSpec, load_tools, suite_title, suite_version
from launcher.runner import launch_tool


class HubWindow:
  def __init__(self, on_quit: Optional[Callable[[], None]] = None):
    self._on_quit = on_quit
    self.root = tk.Tk()
    self._all_tools = load_tools()
    self._search_var = tk.StringVar()
    self._search_var.trace_add("write", self._on_search_change)
    self._tool_cards: list[tuple[ToolSpec, tk.Frame]] = []
    self._status_var = tk.StringVar()
    self._empty_state: Optional[tk.Frame] = None
    self._cards_container: Optional[tk.Frame] = None
    self._content_window: Optional[int] = None
    self._content_canvas: Optional[tk.Canvas] = None
    self._columns = 2
    self._summary_var = tk.StringVar()
    self._title_font_family = ""
    self._ui_font_family = ""
    self._apply_window_settings()
    self._build_ui()
    self.root.protocol("WM_DELETE_WINDOW", self._quit)

  # ── Window settings ──────────────────────────────────────────────

  def _apply_window_settings(self) -> None:
    self.root.title(suite_title())
    sw = self.root.winfo_screenwidth()
    sh = self.root.winfo_screenheight()
    # 初始窗口不超过屏幕尺寸，保留任务栏空间
    init_w = max(1000, min(1600, sw - 40))
    init_h = max(680, min(1000, sh - 80))
    self.root.geometry(f"{init_w}x{init_h}")
    self.root.minsize(900, 600)
    # 在 Windows 上直接最大化，充分利用屏幕
    try:
      self.root.state("zoomed")
    except tk.TclError:
      pass
    self.root.configure(bg="#f3efe7")
    self._title_font_family = self._pick_font_family(
      "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI"
    )
    self._ui_font_family = self._pick_font_family(
      "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", "TkDefaultFont"
    )

  def _pick_font_family(self, *candidates: str) -> str:
    available = set(tkfont.families(self.root))
    for candidate in candidates:
      if candidate in available:
        return candidate
    return "TkDefaultFont"

  # ── Build UI ─────────────────────────────────────────────────────

  def _build_ui(self) -> None:
    shell = tk.Frame(self.root, bg="#f3efe7", padx=18, pady=18)
    shell.pack(fill="both", expand=True)
    shell.grid_columnconfigure(0, weight=0)
    shell.grid_columnconfigure(1, weight=1)
    shell.grid_rowconfigure(0, weight=1)

    self._build_sidebar(shell)
    self._build_main_panel(shell)
    self._render_tool_cards()

  # ── Sidebar ──────────────────────────────────────────────────────

  def _build_sidebar(self, parent: tk.Widget) -> None:
    sidebar = tk.Frame(parent, bg="#132d33", width=320, padx=24, pady=24)
    sidebar.grid(row=0, column=0, sticky="nsew")
    sidebar.grid_propagate(False)

    # Brand
    badge = tk.Label(
      sidebar,
      text="AUDIT TOOLKIT",
      bg="#1e4a54",
      fg="#c8e0da",
      padx=12,
      pady=5,
      font=(self._ui_font_family, 11, "bold"),
    )
    badge.pack(anchor="w")

    title_label = tk.Label(
      sidebar,
      text=suite_title(),
      bg="#132d33",
      fg="#f8f4ec",
      justify="left",
      wraplength=220,
      font=(self._title_font_family, 24, "bold"),
      pady=10,
    )
    title_label.pack(anchor="w")

    tk.Label(
      sidebar,
      text="把高频审计动作收束到一个稳定、干净、易上手的工作台。",
      bg="#132d33",
      fg="#a8c4be",
      justify="left",
      wraplength=220,
      font=(self._ui_font_family, 10),
    ).pack(anchor="w")

    overview = tk.Frame(sidebar, bg="#132d33", pady=14)
    overview.pack(fill="x")
    self._build_sidebar_metric(overview, "工具总数", str(len(self._all_tools))).pack(
      fill="x", pady=(0, 10)
    )
    self._build_sidebar_metric(overview, "默认动作", "搜索或直接打开").pack(fill="x")

    # Tips
    tips_frame = tk.Frame(sidebar, bg="#1a3d44", padx=12, pady=12)
    tips_frame.pack(fill="x", pady=(16, 0))
    tk.Label(
      tips_frame,
      text="工作建议",
      bg="#1a3d44",
      fg="#e0d5c5",
      font=(self._ui_font_family, 11, "bold"),
    ).pack(anchor="w")
    for tip in (
      "先看右侧卡片说明，再进入对应工具。",
      "搜索支持工具名称、模块 ID 和描述关键词。",
      "工具在独立窗口中运行，关闭后自动返回本页面。",
    ):
      tk.Label(
        tips_frame,
        text=f"- {tip}",
        bg="#1a3d44",
        fg="#a3bfb9",
        justify="left",
        wraplength=210,
        font=(self._ui_font_family, 10),
        pady=2,
      ).pack(anchor="w")

    # Spacer
    tk.Frame(sidebar, bg="#132d33").pack(expand=True)

    # Footer: version + exit
    footer = tk.Frame(sidebar, bg="#132d33")
    footer.pack(side="bottom", fill="x")
    tk.Label(
      footer,
      text=f"v{suite_version()}",
      bg="#132d33",
      fg="#6a8a84",
      font=(self._ui_font_family, 10),
    ).pack(anchor="w", pady=(0, 6))

    tk.Button(
      footer,
      text="退出工具箱",
      command=self._quit,
      bg="#c47d3e",
      fg="#fffaf2",
      activebackground="#a86930",
      activeforeground="#fffaf2",
      relief="flat",
      cursor="hand2",
      padx=14,
      pady=7,
      font=(self._ui_font_family, 11, "bold"),
    ).pack(anchor="w")

  def _build_sidebar_metric(self, parent: tk.Widget, label: str, value: str) -> tk.Frame:
    card = tk.Frame(parent, bg="#193940", padx=10, pady=8)
    tk.Label(
      card,
      text=label,
      bg="#193940",
      fg="#89aca6",
      font=(self._ui_font_family, 10),
    ).pack(anchor="w")
    tk.Label(
      card,
      text=value,
      bg="#193940",
      fg="#f3eee4",
      wraplength=200,
      justify="left",
      font=(self._ui_font_family, 11, "bold"),
      pady=1,
    ).pack(anchor="w")
    return card

  # ── Main panel ───────────────────────────────────────────────────

  def _build_main_panel(self, parent: tk.Widget) -> None:
    main = tk.Frame(parent, bg="#efe7db", padx=18, pady=18)
    main.grid(row=0, column=1, sticky="nsew", padx=(12, 0))
    main.grid_columnconfigure(0, weight=1)
    main.grid_rowconfigure(2, weight=1)

    # Top bar: heading + search
    topbar = tk.Frame(main, bg="#efe7db")
    topbar.grid(row=0, column=0, sticky="ew")
    topbar.grid_columnconfigure(0, weight=1)
    topbar.grid_columnconfigure(1, weight=0)

    # Heading
    intro = tk.Frame(topbar, bg="#efe7db")
    intro.grid(row=0, column=0, sticky="w")
    tk.Label(
      intro,
      text="作业中枢",
      bg="#efe7db",
      fg="#205860",
      font=(self._ui_font_family, 11, "bold"),
    ).pack(anchor="w")
    tk.Label(
      intro,
      text="选择一个入口，开始本轮审计处理",
      bg="#efe7db",
      fg="#1b1f23",
      font=(self._title_font_family, 20, "bold"),
      pady=2,
    ).pack(anchor="w")

    # Search box
    actions = tk.Frame(topbar, bg="#efe7db")
    actions.grid(row=0, column=1, sticky="e", padx=(12, 0))
    search_shell = tk.Frame(
      actions,
      bg="#fbf7f0",
      highlightbackground="#c9bb9f",
      highlightthickness=1,
      bd=0,
    )
    search_shell.pack(anchor="e", fill="x")

    tk.Label(
      search_shell,
      text="搜索",
      bg="#fbf7f0",
      fg="#8a7e6b",
      padx=9,
      font=(self._ui_font_family, 10),
    ).pack(side="left")

    self._search_entry = tk.Entry(
      search_shell,
      textvariable=self._search_var,
      relief="flat",
      bd=0,
      bg="#fbf7f0",
      fg="#252b2f",
      width=24,
      insertbackground="#205860",
      font=(self._ui_font_family, 10),
    )
    self._search_entry.pack(side="left", padx=(0, 10), pady=8)
    self._search_entry.bind("<FocusIn>", self._on_search_focus_in)
    self._search_entry.bind("<FocusOut>", self._on_search_focus_out)
    self._search_var.set(self._SEARCH_PLACEHOLDER)
    self._search_entry.configure(fg="#9a917f")
    self._search_entry.focus_set()

    # Status bar
    toolbar = tk.Frame(main, bg="#efe7db")
    toolbar.grid(row=1, column=0, sticky="ew", pady=(10, 6))
    toolbar.grid_columnconfigure(0, weight=1)
    tk.Label(
      toolbar,
      textvariable=self._status_var,
      bg="#efe7db",
      fg="#5b6765",
      font=(self._ui_font_family, 10),
    ).grid(row=0, column=0, sticky="w")
    tk.Label(
      toolbar,
      textvariable=self._summary_var,
      bg="#efe7db",
      fg="#7f7567",
      font=(self._ui_font_family, 10),
    ).grid(row=0, column=1, sticky="e")

    # Scrollable card area
    cards_shell = tk.Frame(main, bg="#efe7db")
    cards_shell.grid(row=2, column=0, sticky="nsew")
    cards_shell.grid_columnconfigure(0, weight=1)
    cards_shell.grid_rowconfigure(0, weight=1)

    self._content_canvas = tk.Canvas(
      cards_shell,
      bg="#efe7db",
      highlightthickness=0,
      bd=0,
      relief="flat",
    )
    self._content_canvas.grid(row=0, column=0, sticky="nsew")

    scrollbar = tk.Scrollbar(cards_shell, orient="vertical")
    scrollbar.grid(row=0, column=1, sticky="ns")
    scrollbar.configure(command=self._content_canvas.yview)
    self._content_canvas.configure(yscrollcommand=scrollbar.set)

    content = tk.Frame(self._content_canvas, bg="#efe7db")
    self._cards_container = content
    self._content_window = self._content_canvas.create_window(
      (0, 0), window=content, anchor="nw"
    )

    content.bind("<Configure>", self._sync_scroll_region)
    self._content_canvas.bind("<Configure>", self._on_canvas_resize)
    self._content_canvas.bind("<MouseWheel>", self._on_mouse_wheel)
    content.bind("<MouseWheel>", self._on_mouse_wheel)

  def _on_canvas_resize(self, event: tk.Event) -> None:
    """窗口宽度变化时重新计算列数和排列卡片。"""
    if self._content_canvas is not None and self._content_window is not None:
      self._content_canvas.itemconfigure(self._content_window, width=event.width)
      new_columns = self._calc_columns(event.width)
      if new_columns != self._columns:
        self._columns = new_columns
        self._render_tool_cards()

  def _calc_columns(self, available_width: int) -> int:
    if available_width > 1100:
      return 3
    elif available_width > 640:
      return 2
    return 1

  # ── Scroll helpers ───────────────────────────────────────────────

  def _sync_scroll_region(self, _event: tk.Event) -> None:
    if self._content_canvas is not None:
      self._content_canvas.configure(scrollregion=self._content_canvas.bbox("all"))

  def _on_mouse_wheel(self, event: tk.Event) -> None:
    if self._content_canvas is not None:
      self._content_canvas.yview_scroll(int(-event.delta / 120), "units")

  # ── Search placeholder ──────────────────────────────────────────

  _SEARCH_PLACEHOLDER = "输入工具名称搜索..."
  _search_has_content = False

  def _on_search_focus_in(self, _event: tk.Event) -> None:
    if not self._search_has_content:
      self._search_var.set("")
      self._search_entry.configure(fg="#252b2f")

  def _on_search_focus_out(self, _event: tk.Event) -> None:
    if not self._search_var.get().strip():
      self._search_var.set(self._SEARCH_PLACEHOLDER)
      self._search_entry.configure(fg="#9a917f")
      self._search_has_content = False
    else:
      self._search_has_content = True

  # ── Render cards ─────────────────────────────────────────────────

  def _render_tool_cards(self) -> None:
    if self._cards_container is None:
      return

    for child in self._cards_container.winfo_children():
      child.destroy()
    self._tool_cards.clear()
    self._empty_state = None

    tools = self._filtered_tools()
    total = len(self._all_tools)
    shown = len(tools)

    if self._search_var.get().strip() and self._search_var.get().strip() != self._SEARCH_PLACEHOLDER:
      self._status_var.set(f"共 {total} 个工具，搜索匹配 {shown} 个")
    else:
      self._status_var.set(f"共 {total} 个工具")
    self._summary_var.set("点击卡片空白区域或右下按钮均可进入")

    if not tools:
      self._empty_state = self._build_empty_state(self._cards_container)
      self._empty_state.pack(fill="both", expand=True, pady=48)
      return

    # Configure columns and rows so cards in the same row share height
    for i in range(self._columns):
      self._cards_container.grid_columnconfigure(i, weight=1, uniform="tool")
    row_count = (len(tools) + self._columns - 1) // self._columns
    for row in range(row_count):
      # 给每行一个统一的最小高度，减少不同文案长度导致的视觉错位
      self._cards_container.grid_rowconfigure(row, weight=1, uniform="toolrow", minsize=208)

    for index, tool in enumerate(tools):
      row = index // self._columns
      column = index % self._columns
      card = self._build_tool_card(self._cards_container, tool)
      card.grid(row=row, column=column, sticky="nsew", padx=10, pady=10)
      self._tool_cards.append((tool, card))

  # ── Empty state ──────────────────────────────────────────────────

  def _build_empty_state(self, parent: tk.Widget) -> tk.Frame:
    frame = tk.Frame(
      parent,
      bg="#fbf7f0",
      padx=28,
      pady=28,
      highlightbackground="#dccfbd",
      highlightthickness=1,
    )
    tk.Label(
      frame,
      text="没有找到匹配的工具",
      bg="#fbf7f0",
      fg="#173f46",
      font=(self._title_font_family, 16, "bold"),
    ).pack()
    tk.Label(
      frame,
      text="试试输入工具名称或描述关键词，也可以清空搜索查看所有模块。",
      bg="#fbf7f0",
      fg="#6f756e",
      font=(self._ui_font_family, 10),
      pady=8,
    ).pack()
    tk.Button(
      frame,
      text="清空搜索",
      command=lambda: self._search_var.set(""),
      bg="#205860",
      fg="#f4f6f4",
      activebackground="#173f46",
      activeforeground="#f4f6f4",
      relief="flat",
      cursor="hand2",
      padx=14,
      pady=7,
      font=(self._ui_font_family, 11, "bold"),
    ).pack()
    return frame

  # ── Tool card ────────────────────────────────────────────────────

  def _build_tool_card(self, parent: tk.Widget, tool: ToolSpec) -> tk.Frame:
    base_bg = "#fbf7f0"
    hover_bg = "#fffcf5"
    accent_bg = self._accent_for_tool(tool)

    # 根据当前列数估算卡片可用宽度，使文字自然换行
    canvas_w = self._content_canvas.winfo_width() if self._content_canvas else 800
    card_w = max(180, (canvas_w - 40) // self._columns - 30)
    wrap_title = max(140, card_w - 92)
    wrap_desc = max(160, card_w - 44)

    card = tk.Frame(
      parent,
      bg=base_bg,
      padx=16,
      pady=16,
      highlightbackground="#d9cebf",
      highlightthickness=1,
      bd=0,
      cursor="hand2",
    )

    # Card uses grid so footer alignment remains consistent
    card.grid_columnconfigure(0, weight=1)
    card.grid_rowconfigure(1, weight=1)

    # Header: fixed badge slot + title area
    header = tk.Frame(card, bg=base_bg)
    header.grid(row=0, column=0, sticky="ew")
    header.grid_columnconfigure(1, weight=1)

    badge_slot = tk.Frame(header, bg=base_bg, width=44, height=44)
    badge_slot.grid(row=0, column=0, sticky="nw")
    badge_slot.grid_propagate(False)
    badge = tk.Label(
      badge_slot,
      text=self._tool_badge(tool),
      bg=accent_bg,
      fg="#fff9f1",
      font=(self._ui_font_family, 11, "bold"),
      bd=0,
      padx=0,
      pady=0,
    )
    badge.place(relx=0.5, rely=0.5, anchor="center", width=40, height=40)

    heading = tk.Frame(header, bg=base_bg)
    heading.grid(row=0, column=1, sticky="nsew", padx=(14, 0))
    heading.grid_columnconfigure(0, weight=1)
    heading.grid_rowconfigure(0, minsize=40)

    title_label = tk.Label(
      heading,
      text=tool.name,
      bg=base_bg,
      fg="#172126",
      anchor="nw",
      justify="left",
      wraplength=wrap_title,
      font=(self._title_font_family, 15, "bold"),
    )
    title_label.grid(row=0, column=0, sticky="nw")
    id_label = tk.Label(
      heading,
      text=tool.id,
      bg=base_bg,
      fg="#8a8f8b",
      anchor="w",
      font=(self._ui_font_family, 10),
      pady=1,
    )
    id_label.grid(row=1, column=0, sticky="w")

    # Description
    description = tool.description or "暂无描述，可直接进入查看功能。"
    desc_label = tk.Label(
      card,
      text=description,
      bg=base_bg,
      fg="#56615d",
      justify="left",
      anchor="nw",
      wraplength=wrap_desc,
      font=(self._ui_font_family, 10),
    )
    desc_label.grid(row=1, column=0, sticky="nsew", pady=(10, 10))

    # Footer: tagline + launch button
    footer = tk.Frame(card, bg=base_bg)
    footer.grid(row=2, column=0, sticky="ew")
    footer.grid_columnconfigure(0, weight=1)
    tagline_label = tk.Label(
      footer,
      text=self._tool_tagline(tool),
      bg=base_bg,
      fg=accent_bg,
      font=(self._ui_font_family, 11, "bold"),
      anchor="w",
      justify="left",
    )
    tagline_label.grid(row=0, column=0, sticky="w")

    short_name = tool.name if len(tool.name) <= 8 else tool.name[:7] + "…"
    launch_button = tk.Button(
      footer,
      text=f"打开 {short_name}",
      command=lambda t=tool: self._enter_tool(t),
      bg="#205860",
      fg="#f8f5ee",
      activebackground="#173f46",
      activeforeground="#f8f5ee",
      relief="flat",
      cursor="hand2",
      padx=14,
      pady=6,
      width=13,
      font=(self._ui_font_family, 11, "bold"),
    )
    launch_button.grid(row=0, column=1, sticky="e")

    self._bind_card_events(
      tool,
      card,
      launch_button,
      (header, badge_slot, heading, desc_label, footer),
      (badge,),
      base_bg,
      hover_bg,
      accent_bg,
    )
    return card

  # ── Card hover / click events ────────────────────────────────────

  def _bind_card_events(
    self,
    tool: ToolSpec,
    card: tk.Frame,
    button: tk.Button,
    surfaces: tuple[tk.Widget, ...],
    badges: tuple[tk.Widget, ...],
    base_bg: str,
    hover_bg: str,
    accent_bg: str,
  ) -> None:
    def apply_state(is_hover: bool) -> None:
      bg = hover_bg if is_hover else base_bg
      border = accent_bg if is_hover else "#d9cebf"
      thickness = 2 if is_hover else 1
      card.configure(bg=bg, highlightbackground=border, highlightthickness=thickness)
      for widget in surfaces:
        widget.configure(bg=bg)
      badge_ids = {str(widget) for widget in badges}
      for child in card.winfo_children():
        self._repaint_widget_tree(child, bg, badge_ids, accent_bg)
      for badge in badges:
        badge.configure(bg=accent_bg)
      button.configure(bg="#173f46" if is_hover else "#205860")

    def on_enter(_event: tk.Event) -> None:
      apply_state(True)

    def on_leave(_event: tk.Event) -> None:
      apply_state(False)

    def on_click(_event: tk.Event) -> None:
      self._enter_tool(tool)

    for widget in (card, *surfaces, *badges):
      widget.bind("<Enter>", on_enter)
      widget.bind("<Leave>", on_leave)
      widget.bind("<Button-1>", on_click)

  def _repaint_widget_tree(
    self,
    widget: tk.Widget,
    bg: str,
    badge_ids: set[str],
    accent_bg: str,
  ) -> None:
    if isinstance(widget, tk.Button):
      return
    if str(widget) in badge_ids:
      widget.configure(bg=accent_bg)
      return
    try:
      widget.configure(bg=bg)
    except tk.TclError:
      return
    for child in widget.winfo_children():
      self._repaint_widget_tree(child, bg, badge_ids, accent_bg)

  # ── Filtered tools ───────────────────────────────────────────────

  def _filtered_tools(self) -> list[ToolSpec]:
    keyword = self._search_var.get().strip().lower()
    if not keyword or keyword == self._SEARCH_PLACEHOLDER.lower():
      return list(self._all_tools)
    return [
      tool for tool in self._all_tools
      if keyword in tool.name.lower()
      or keyword in tool.id.lower()
      or keyword in (tool.description or "").lower()
    ]

  def _on_search_change(self, *_args: str) -> None:
    val = self._search_var.get()
    if val and val != self._SEARCH_PLACEHOLDER:
      self._search_has_content = True
    self._render_tool_cards()

  # ── Tool helpers ─────────────────────────────────────────────────

  def _accent_for_tool(self, tool: ToolSpec) -> str:
    palette = ("#205860", "#9b5d33", "#3a6b5c", "#80513d", "#58739b")
    return palette[sum(ord(ch) for ch in tool.id) % len(palette)]

  def _tool_badge(self, tool: ToolSpec) -> str:
    letters = [part[0] for part in tool.id.replace("-", "_").split("_") if part]
    badge = "".join(letters[:2]).upper()
    return badge or tool.name[:2].upper()

  def _tool_tagline(self, tool: ToolSpec) -> str:
    keywords = {
      "fa": "固定资产流程",
      "kan": "凭证与看账",
      "ts": "工时管理",
      "con": "函证进度",
      "exc": "批量 Excel",
    }
    tool_id = tool.id.lower()
    for prefix, label in keywords.items():
      if tool_id.startswith(prefix):
        return label
    return "通用模块"

  # ── Launch / quit ────────────────────────────────────────────────

  def _enter_tool(self, tool: ToolSpec) -> None:
    """进入子工具：隐藏 Hub 主窗口，避免子工具运行期间 Hub 反复抢前台。

    背景：Hub 是 tk.Tk() 根窗口，子工具是它的 Toplevel。只要 Hub 仍然可见，
    子工具中的任何 messagebox（未显式指定 parent）、focus 变化、Toplevel
    transient 等操作都会被 Windows 窗口管理器解释为"激活根窗口"，导致 Hub
    频繁蹦到前面。彻底的做法是进入子工具时直接 withdraw 隐藏 Hub，
    子工具关闭后再 deiconify 恢复——Windows 下 Toplevel 即使父被 withdraw
    仍可正常显示与交互。
    """
    def show_error(msg: str) -> None:
      messagebox.showerror("工具启动失败", msg, parent=self.root)

    # 记录 Hub 之前是否为最大化状态，关闭子工具后还原
    prev_state = "normal"
    try:
      prev_state = self.root.state()
    except tk.TclError:
      pass

    try:
      self.root.withdraw()
    except tk.TclError:
      pass

    try:
      launch_tool(tool, parent=self.root, on_error=show_error)
    finally:
      try:
        if self.root.winfo_exists():
          self.root.deiconify()
          if prev_state == "zoomed":
            try:
              self.root.state("zoomed")
            except tk.TclError:
              pass
          self.root.lift()
          self.root.focus_force()
      except tk.TclError:
        pass

  def _quit(self) -> None:
    if self._on_quit:
      self._on_quit()
    self.root.destroy()

  def run(self) -> None:
    self.root.mainloop()
