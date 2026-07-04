"""Shared tkinter/ttk visual system for the audit toolbox."""
from __future__ import annotations

import ctypes
import sys
import tkinter as tk
from tkinter import font as tkfont
from tkinter import ttk


BG = "#f3efe7"
PANEL_BG = "#efe7db"
SURFACE_BG = "#fbf7f0"
SIDEBAR_BG = "#132d33"
PRIMARY = "#205860"
PRIMARY_DARK = "#173f46"
ACCENT = "#c47d3e"
BORDER = "#d9cebf"
TEXT = "#1b1f23"
MUTED_TEXT = "#5b6765"
LINK = "#205860"
SUCCESS = "#3a6b5c"
WARNING = "#9b5d33"
ERROR = "#9b3f33"

BASE_FONT_SIZE = 10
TITLE_FONT_SIZE = 16
SMALL_FONT_SIZE = 9
TREE_ROW_HEIGHT = 28
WINDOW_PAD = 14
SECTION_PAD = 10
SECTION_GAP = 10
BUTTON_WIDTH = 14


def pick_font_family(root: tk.Misc) -> str:
    try:
        available = set(tkfont.families(root))
    except tk.TclError:
        available = set()
    for family in ("Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI"):
        if family in available:
            return family
    return "TkDefaultFont"


def apply_app_theme(root: tk.Misc) -> str:
    """Apply the hub-derived theme to a root or toplevel window."""
    family = pick_font_family(root)
    base_font = (family, BASE_FONT_SIZE)
    small_font = (family, SMALL_FONT_SIZE)
    title_font = (family, TITLE_FONT_SIZE, "bold")

    try:
        root.configure(bg=BG)
    except tk.TclError:
        pass

    for pattern, value in (
        ("*Font", base_font),
        ("*Background", SURFACE_BG),
        ("*Foreground", TEXT),
        ("*Entry.Font", base_font),
        ("*Text.Font", base_font),
        ("*Listbox.Font", base_font),
        ("*Listbox.Background", "#ffffff"),
        ("*Listbox.Foreground", TEXT),
        ("*Listbox.SelectBackground", PRIMARY),
        ("*Listbox.SelectForeground", "#ffffff"),
        ("*TCombobox*Listbox.background", "#ffffff"),
        ("*TCombobox*Listbox.foreground", TEXT),
        ("*TCombobox*Listbox.selectBackground", "#d8e8ea"),
        ("*TCombobox*Listbox.selectForeground", PRIMARY_DARK),
    ):
        try:
            root.option_add(pattern, value)
        except tk.TclError:
            pass

    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass

    style.configure(".", font=base_font, background=BG, foreground=TEXT)
    style.configure("TFrame", background=BG)
    style.configure("AppShell.TFrame", background=BG)
    style.configure("AppHeader.TFrame", background=BG)
    style.configure("AppBody.TFrame", background=BG)
    style.configure("AppFooter.TFrame", background=BG)
    style.configure("Section.TFrame", background=BG)
    style.configure("TLabelframe", background=BG, bordercolor=BORDER, relief="solid")
    style.configure("TLabelframe.Label", background=BG, foreground=PRIMARY, font=(family, BASE_FONT_SIZE, "bold"))
    style.configure("TLabel", background=BG, foreground=TEXT, font=base_font)
    style.configure("Muted.TLabel", background=BG, foreground=MUTED_TEXT, font=small_font)
    style.configure("Title.TLabel", background=BG, foreground=TEXT, font=title_font)
    style.configure("Link.TLabel", background=BG, foreground=LINK, font=(family, SMALL_FONT_SIZE, "bold"))
    style.configure("TButton", font=(family, BASE_FONT_SIZE, "bold"), padding=(12, 6), background=PRIMARY, foreground="#f8f5ee", borderwidth=0)
    style.map(
        "TButton",
        background=[("active", PRIMARY_DARK), ("disabled", "#c9c1b4")],
        foreground=[("disabled", "#7d756a")],
    )
    style.configure("Secondary.TButton", background=SURFACE_BG, foreground=PRIMARY, bordercolor=BORDER, borderwidth=1)
    style.map("Secondary.TButton", background=[("active", "#fffcf5")], foreground=[("active", PRIMARY_DARK)])
    style.configure(
        "Toolband.TButton",
        font=(family, SMALL_FONT_SIZE, "bold"),
        padding=(10, 4),
        background="#f8f3ea",
        foreground=PRIMARY_DARK,
        bordercolor=BORDER,
        borderwidth=1,
    )
    style.map(
        "Toolband.TButton",
        background=[("active", "#ffffff"), ("disabled", "#e8dfd3")],
        foreground=[("active", PRIMARY_DARK), ("disabled", "#8a8176")],
    )
    style.configure(
        "ToolbandPrimary.TButton",
        font=(family, SMALL_FONT_SIZE, "bold"),
        padding=(12, 4),
        background=PRIMARY,
        foreground="#ffffff",
        borderwidth=0,
    )
    style.map(
        "ToolbandPrimary.TButton",
        background=[("active", PRIMARY_DARK), ("disabled", "#c9c1b4")],
        foreground=[("disabled", "#7d756a")],
    )
    style.configure(
        "ToolbandDanger.TButton",
        font=(family, SMALL_FONT_SIZE, "bold"),
        padding=(10, 4),
        background="#f3e8e2",
        foreground=ERROR,
        bordercolor="#e0c6bd",
        borderwidth=1,
    )
    style.map(
        "ToolbandDanger.TButton",
        background=[("active", "#fff6f2"), ("disabled", "#e8dfd3")],
        foreground=[("active", ERROR), ("disabled", "#8a8176")],
    )
    style.configure("TEntry", fieldbackground="#ffffff", foreground=TEXT, bordercolor=BORDER, lightcolor=BORDER, darkcolor=BORDER, padding=4)
    style.configure("TCombobox", fieldbackground="#ffffff", foreground=TEXT, bordercolor="#c9d3cf", arrowcolor=PRIMARY, arrowsize=14, padding=4)
    style.map(
        "TCombobox",
        foreground=[("disabled", "#7d756a"), ("readonly", TEXT), ("focus", TEXT), ("!disabled", TEXT)],
        fieldbackground=[("readonly", "#ffffff"), ("disabled", "#e6ddcf")],
        selectbackground=[("focus", "#d8e8ea"), ("readonly", "#d8e8ea")],
        selectforeground=[("focus", PRIMARY_DARK), ("readonly", PRIMARY_DARK)],
    )
    style.configure("TNotebook", background=BG, borderwidth=0)
    style.configure("TNotebook.Tab", font=base_font, padding=(12, 6), background="#e6ddcf", foreground=MUTED_TEXT)
    style.map("TNotebook.Tab", background=[("selected", SURFACE_BG)], foreground=[("selected", PRIMARY)])
    style.configure("Horizontal.TProgressbar", troughcolor="#e6ddcf", background=PRIMARY, bordercolor=BORDER, lightcolor=PRIMARY, darkcolor=PRIMARY)
    style.configure("Vertical.TScrollbar", background="#d8cdbd", troughcolor="#efe7db", arrowcolor=PRIMARY, bordercolor=BORDER)
    style.configure("Horizontal.TScrollbar", background="#d8cdbd", troughcolor="#efe7db", arrowcolor=PRIMARY, bordercolor=BORDER)
    style.configure(
        "Treeview",
        font=base_font,
        rowheight=TREE_ROW_HEIGHT,
        background="#ffffff",
        fieldbackground="#ffffff",
        foreground=TEXT,
        bordercolor=BORDER,
    )
    style.configure("Treeview.Heading", font=(family, BASE_FONT_SIZE, "bold"), background="#e6ddcf", foreground=PRIMARY, relief="flat")
    style.map("Treeview", background=[("selected", PRIMARY)], foreground=[("selected", "#ffffff")])
    return family


def create_standard_layout(
    root: tk.Misc,
    title: str,
    subtitle: str = "",
    *,
    pad: int = WINDOW_PAD,
) -> tuple[ttk.Frame, ttk.Frame, ttk.Frame]:
    """Create the standard top/body/footer window regions."""
    shell = ttk.Frame(root, padding=pad, style="AppShell.TFrame")
    shell.pack(fill=tk.BOTH, expand=True)
    shell.columnconfigure(0, weight=1)
    shell.rowconfigure(2, weight=1)

    header = ttk.Frame(shell, style="AppHeader.TFrame")
    header.grid(row=0, column=0, sticky="ew")
    header.columnconfigure(0, weight=1)
    ttk.Label(header, text=title, style="Title.TLabel").grid(row=0, column=0, sticky="w")
    if subtitle:
        ttk.Label(header, text=subtitle, style="Muted.TLabel").grid(row=1, column=0, sticky="w", pady=(2, 0))
    ttk.Separator(shell, orient=tk.HORIZONTAL).grid(row=1, column=0, sticky="ew", pady=(SECTION_GAP, 0))

    body = ttk.Frame(shell, style="AppBody.TFrame")
    body.grid(row=2, column=0, sticky="nsew", pady=(SECTION_GAP, SECTION_GAP))
    body.columnconfigure(0, weight=1)
    body.rowconfigure(0, weight=1)

    ttk.Separator(shell, orient=tk.HORIZONTAL).grid(row=3, column=0, sticky="ew")
    footer = ttk.Frame(shell, style="AppFooter.TFrame")
    footer.grid(row=4, column=0, sticky="ew", pady=(SECTION_GAP, 0))
    footer.columnconfigure(0, weight=1)
    return header, body, footer


def create_section(
    parent: tk.Misc,
    title: str,
    *,
    row: int | None = None,
    column: int = 0,
    sticky: str = "nsew",
    padx: tuple[int, int] | int = 0,
    pady: tuple[int, int] | int = 0,
) -> ttk.LabelFrame:
    section = ttk.LabelFrame(parent, text=title, padding=SECTION_PAD)
    if row is None:
        section.pack(fill=tk.BOTH, expand=True, padx=padx, pady=pady)
    else:
        section.grid(row=row, column=column, sticky=sticky, padx=padx, pady=pady)
    return section


def create_button_group(parent: tk.Misc, align: str = "right") -> ttk.Frame:
    group = ttk.Frame(parent)
    side = tk.RIGHT if align == "right" else tk.LEFT
    group.pack(side=side)
    return group


def add_standard_button(
    parent: tk.Misc,
    text: str,
    command,
    *,
    secondary: bool = False,
    side: str = tk.LEFT,
) -> ttk.Button:
    style = "Secondary.TButton" if secondary else "TButton"
    button = ttk.Button(parent, text=text, command=command, width=BUTTON_WIDTH, style=style)
    button.pack(side=side, padx=(8, 0), pady=2)
    return button


def fit_window_to_screen(
    win: tk.Misc,
    width: int,
    height: int,
    min_width: int | None = None,
    min_height: int | None = None,
    margin_x: int = 80,
    margin_y: int = 120,
) -> None:
    """Size and center a window without exceeding the current screen."""
    try:
        screen_w = win.winfo_screenwidth()
        screen_h = win.winfo_screenheight()
        actual_w = min(width, max(320, screen_w - margin_x))
        actual_h = min(height, max(240, screen_h - margin_y))
        pos_x = max(20, (screen_w - actual_w) // 2)
        pos_y = max(20, (screen_h - actual_h) // 2)
        win.geometry(f"{actual_w}x{actual_h}+{pos_x}+{pos_y}")
        if min_width is not None and min_height is not None:
            win.minsize(min(min_width, actual_w), min(min_height, actual_h))
    except tk.TclError:
        win.geometry(f"{width}x{height}")


def center_on_parent(win: tk.Misc, parent: tk.Misc | None = None) -> None:
    try:
        win.update_idletasks()
        if parent is not None and parent.winfo_exists():
            x = parent.winfo_rootx() + max(0, (parent.winfo_width() - win.winfo_width()) // 2)
            y = parent.winfo_rooty() + max(0, (parent.winfo_height() - win.winfo_height()) // 2)
        else:
            x = (win.winfo_screenwidth() - win.winfo_width()) // 2
            y = (win.winfo_screenheight() - win.winfo_height()) // 2
        win.geometry(f"+{max(20, x)}+{max(20, y)}")
    except tk.TclError:
        pass


def style_legacy_widgets(widget: tk.Misc) -> None:
    """Normalize non-ttk widgets created by older tools."""
    for child in widget.winfo_children():
        _style_legacy_widget(child)
        style_legacy_widgets(child)


def normalize_layout_tree(widget: tk.Misc) -> None:
    """Apply spacing and control-size normalization to a widget subtree."""
    for child in widget.winfo_children():
        _style_legacy_widget(child)
        if isinstance(child, ttk.Label):
            _normalize_label_color(child)
        normalize_layout_tree(child)


def _style_legacy_widget(widget: tk.Misc) -> None:
    if isinstance(widget, (tk.Frame, tk.LabelFrame)):
        _safe_config(widget, bg=BG)
    elif isinstance(widget, tk.Label):
        fg = widget.cget("fg") if _has_option(widget, "fg") else TEXT
        if fg in ("blue", "#0066cc"):
            fg = LINK
        elif fg in ("red",):
            fg = ERROR
        elif fg in ("green",):
            fg = SUCCESS
        elif fg in ("gray", "grey"):
            fg = MUTED_TEXT
        _safe_config(widget, bg=BG, fg=fg)
    elif isinstance(widget, tk.Button):
        _safe_config(
            widget,
            bg=PRIMARY,
            fg="#f8f5ee",
            activebackground=PRIMARY_DARK,
            activeforeground="#f8f5ee",
            relief="flat",
            bd=0,
            cursor="hand2",
            padx=10,
            pady=5,
        )
    elif isinstance(widget, (tk.Listbox, tk.Text)):
        _safe_config(
            widget,
            bg="#ffffff",
            fg=TEXT,
            selectbackground=PRIMARY,
            selectforeground="#ffffff",
            highlightthickness=1,
            highlightbackground=BORDER,
            relief="flat",
        )
    elif isinstance(widget, tk.Canvas):
        _safe_config(widget, bg=BG, highlightthickness=0, bd=0)
    elif isinstance(widget, ttk.Button):
        _normalize_button_width(widget)


def _safe_config(widget: tk.Misc, **kwargs) -> None:
    supported = {key: value for key, value in kwargs.items() if _has_option(widget, key)}
    if supported:
        try:
            widget.configure(**supported)
        except tk.TclError:
            pass


def _has_option(widget: tk.Misc, option: str) -> bool:
    try:
        return option in widget.configure()
    except tk.TclError:
        return False


def _normalize_button_width(button: ttk.Button) -> None:
    try:
        if getattr(button, "_compact_width", False):
            return
        text = str(button.cget("text") or "")
        current = button.cget("width")
        current_width = int(current) if str(current).strip() else 0
        target_width = max(BUTTON_WIDTH, min(22, len(text) + 2))
        if current_width <= 0 or current_width < BUTTON_WIDTH:
            button.configure(width=target_width)
    except (tk.TclError, ValueError):
        pass


def _normalize_label_color(label: ttk.Label) -> None:
    try:
        fg = str(label.cget("foreground") or "")
        if fg in ("blue", "#0066cc"):
            label.configure(foreground=LINK)
        elif fg in ("red",):
            label.configure(foreground=ERROR)
        elif fg in ("green",):
            label.configure(foreground=SUCCESS)
        elif fg in ("gray", "grey"):
            label.configure(foreground=MUTED_TEXT)
    except tk.TclError:
        pass


# ── Windows 系统标题栏深色化 ────────────────────────────────────

# 深色标题栏颜色（COLORREF 格式：0x00BBGGRR，即 BGR 字节序）
_TITLE_BAR_DARK = 0x00332D13  # #132d33 → SIDEBAR_BG


def set_dark_title_bar(win: tk.Misc) -> None:
    """将窗口的系统标题栏设为深色（仅 Windows 10/11）。

    通过 after 延迟执行，确保窗口已映射到屏幕后再调用 DWM API。
    注意：HWND 解析必须在 after 回调内部进行，因为 Toplevel 在刚创建时
    尚未映射到屏幕，winfo_id() 可能返回 0 或临时句柄。
    """
    if sys.platform != "win32":
        return

    def _apply_when_mapped() -> None:
        """窗口映射后获取真实 HWND 并调用 DWM API。"""
        try:
            win.update_idletasks()
            raw = int(win.winfo_id())
        except (tk.TclError, ValueError):
            return

        if not raw:
            return

        # winfo_id() 返回的是 tk 内部子窗口句柄，需通过 GetAncestor 拿到
        # 真正的顶层窗口 HWND，否则 DWM API 返回 E_HANDLE。
        GA_ROOT = 2
        top_hwnd = ctypes.windll.user32.GetAncestor(raw, GA_ROOT)
        if not top_hwnd:
            top_hwnd = raw

        _apply_dark_title_bar(top_hwnd)

    # 延迟到窗口显示后再设置，否则 DWM 属性可能不生效
    win.after(200, _apply_when_mapped)


def _apply_dark_title_bar(hwnd: int) -> None:
    """通过 DWM API 设置标题栏深色（在窗口显示后调用）。"""
    try:
        dwmapi = ctypes.windll.dwmapi
        # 明确函数签名，避免参数传递错误
        dwmapi.DwmSetWindowAttribute.argtypes = [
            ctypes.c_void_p,  # HWND
            ctypes.c_uint32,  # dwAttribute
            ctypes.c_void_p,  # pvAttribute
            ctypes.c_uint32,  # cbAttribute
        ]
        dwmapi.DwmSetWindowAttribute.restype = ctypes.c_long

        hwnd_p = ctypes.c_void_p(hwnd)

        # ① Windows 10 20H1+：启用沉浸式深色模式
        DWMWA_USE_IMMERSIVE_DARK_MODE = 20
        dark_bool = ctypes.c_int(1)
        dwmapi.DwmSetWindowAttribute(
            hwnd_p,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            ctypes.byref(dark_bool),
            ctypes.sizeof(dark_bool),
        )

        # ② Windows 11：设置自定义标题栏颜色
        DWMWA_CAPTION_COLOR = 35
        DWMWA_BORDER_COLOR = 34
        color_val = ctypes.c_uint32(_TITLE_BAR_DARK)
        dwmapi.DwmSetWindowAttribute(
            hwnd_p,
            DWMWA_CAPTION_COLOR,
            ctypes.byref(color_val),
            ctypes.sizeof(color_val),
        )
        dwmapi.DwmSetWindowAttribute(
            hwnd_p,
            DWMWA_BORDER_COLOR,
            ctypes.byref(color_val),
            ctypes.sizeof(color_val),
        )

        # ③ 标题栏文字浅色
        DWMWA_TEXT_COLOR = 36
        text_color = ctypes.c_uint32(0x00E0ECF0)  # #f0ece0
        dwmapi.DwmSetWindowAttribute(
            hwnd_p,
            DWMWA_TEXT_COLOR,
            ctypes.byref(text_color),
            ctypes.sizeof(text_color),
        )
    except OSError:
        pass  # 旧版 Windows 不支持某些属性
    except Exception:
        pass  # 非关键功能，静默失败
