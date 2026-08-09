"""Local LLM settings and configuration dialog."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from launcher.llm_client import test_connection


DEFAULT_SETTINGS = {
    "enabled": False,
    "api_type": "openai",
    "base_url": "https://api.openai.com/v1",
    "model": "",
    "api_key": "",
    "auth_mode": "bearer",
    "timeout": 30,
    "thinking_enabled": False,
}

API_TYPE_OPTIONS = {
    "OpenAI 兼容接口": "openai",
    "Dify Chat App": "dify_chat",
}
API_TYPE_LABELS = {value: label for label, value in API_TYPE_OPTIONS.items()}

AUTH_MODE_OPTIONS = {
    "Bearer Token": "bearer",
    "直接使用 API Key": "raw",
}
AUTH_MODE_LABELS = {value: label for label, value in AUTH_MODE_OPTIONS.items()}


def settings_path() -> Path:
    base = os.environ.get("APPDATA")
    root = Path(base) if base else Path.home() / "AppData" / "Roaming"
    return root / "AuditToolbox" / "llm_settings.json"


def load_llm_settings() -> dict[str, Any]:
    path = settings_path()
    settings = DEFAULT_SETTINGS.copy()
    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                settings.update({k: data.get(k, v) for k, v in DEFAULT_SETTINGS.items()})
    except Exception:
        pass
    return settings


def save_llm_settings(settings: dict[str, Any]) -> None:
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    clean = DEFAULT_SETTINGS.copy()
    clean.update({k: settings.get(k, v) for k, v in DEFAULT_SETTINGS.items()})
    path.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")


def is_llm_enabled() -> bool:
    settings = load_llm_settings()
    if not bool(settings.get("enabled") and settings.get("api_key") and settings.get("base_url")):
        return False
    if str(settings.get("api_type") or "openai") == "dify_chat":
        return True
    return bool(settings.get("model"))


def open_llm_settings_dialog(parent: tk.Misc | None = None) -> bool:
    # The Tauri/PyInstaller business engine deliberately excludes Tkinter.
    # Keep all legacy UI imports local so headless callers can still reuse the
    # settings loader and LLM client.
    import tkinter as tk
    from tkinter import messagebox, ttk

    from launcher.ui_theme import apply_app_theme, center_on_parent, fit_window_to_screen

    settings = load_llm_settings()
    win = tk.Toplevel(parent) if parent is not None else tk.Toplevel()
    win.title("LLM API 配置")
    apply_app_theme(win)
    fit_window_to_screen(win, 660, 420, min_width=600, min_height=380)
    win.columnconfigure(0, weight=1)
    win.rowconfigure(0, weight=1)
    if parent is not None:
        try:
            win.transient(parent)
            win.grab_set()
        except tk.TclError:
            pass

    enabled_var = tk.BooleanVar(value=bool(settings.get("enabled")))
    api_type_var = tk.StringVar(value=API_TYPE_LABELS.get(str(settings.get("api_type") or "openai"), "OpenAI 兼容接口"))
    base_url_var = tk.StringVar(value=str(settings.get("base_url") or ""))
    model_var = tk.StringVar(value=str(settings.get("model") or ""))
    api_key_var = tk.StringVar(value=str(settings.get("api_key") or ""))
    auth_mode_var = tk.StringVar(value=AUTH_MODE_LABELS.get(str(settings.get("auth_mode") or "bearer"), "Bearer Token"))
    timeout_var = tk.StringVar(value=str(settings.get("timeout") or 30))
    thinking_var = tk.BooleanVar(value=bool(settings.get("thinking_enabled")))
    saved = {"ok": False}

    body = ttk.Frame(win, padding=14)
    body.grid(row=0, column=0, sticky="nsew")
    body.columnconfigure(1, weight=1)

    ttk.Checkbutton(body, text="启用 LLM 辅助映射", variable=enabled_var).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 10))
    ttk.Label(body, text="接口类型").grid(row=1, column=0, sticky="w", pady=5)
    ttk.Combobox(
        body,
        textvariable=api_type_var,
        values=list(API_TYPE_OPTIONS.keys()),
        state="readonly",
    ).grid(row=1, column=1, sticky="ew", pady=5)
    ttk.Label(body, text="Base URL").grid(row=2, column=0, sticky="w", pady=5)
    ttk.Entry(body, textvariable=base_url_var).grid(row=2, column=1, sticky="ew", pady=5)
    ttk.Label(body, text="模型").grid(row=3, column=0, sticky="w", pady=5)
    ttk.Entry(body, textvariable=model_var).grid(row=3, column=1, sticky="ew", pady=5)
    ttk.Label(body, text="API Key").grid(row=4, column=0, sticky="w", pady=5)
    ttk.Entry(body, textvariable=api_key_var, show="*").grid(row=4, column=1, sticky="ew", pady=5)
    ttk.Label(body, text="鉴权方式").grid(row=5, column=0, sticky="w", pady=5)
    ttk.Combobox(
        body,
        textvariable=auth_mode_var,
        values=list(AUTH_MODE_OPTIONS.keys()),
        state="readonly",
    ).grid(row=5, column=1, sticky="ew", pady=5)
    ttk.Label(body, text="超时秒数").grid(row=6, column=0, sticky="w", pady=5)
    ttk.Entry(body, textvariable=timeout_var, width=10).grid(row=6, column=1, sticky="w", pady=5)
    ttk.Checkbutton(
        body,
        text="启用模型思考模式（响应更慢，单次约 30 秒；关闭时约 3 秒）",
        variable=thinking_var,
    ).grid(row=7, column=0, columnspan=2, sticky="w", pady=(8, 0))
    ttk.Label(
        body,
        text="仅发送表头、当前映射和少量截断/脱敏样例，不发送整表数据。LLM 建议用于减少配置时间，关键映射仍需人工确认。"
             "Dify Chat App 可填写例如 https://ai-platform-uat.ey.net/v1；模型名可留空。"
             "思考模式仅在 DeepSeek 等推理型模型上生效；本工具的字段映射/匹配键复核为结构化任务，关闭思考即可。",
        style="Muted.TLabel",
        wraplength=580,
        justify=tk.LEFT,
    ).grid(row=8, column=0, columnspan=2, sticky="ew", pady=(10, 0))

    footer = ttk.Frame(win, padding=(14, 0, 14, 14))
    footer.grid(row=1, column=0, sticky="ew")
    footer.columnconfigure(0, weight=1)

    def collect() -> dict[str, Any] | None:
        try:
            timeout = max(5, min(120, int(float(timeout_var.get().strip() or "30"))))
        except ValueError:
            messagebox.showwarning("配置不完整", "超时秒数需要填写数字。", parent=win)
            return None
        return {
            "enabled": bool(enabled_var.get()),
            "api_type": API_TYPE_OPTIONS.get(api_type_var.get(), "openai"),
            "base_url": base_url_var.get().strip(),
            "model": model_var.get().strip(),
            "api_key": api_key_var.get().strip(),
            "auth_mode": AUTH_MODE_OPTIONS.get(auth_mode_var.get(), "bearer"),
            "timeout": timeout,
            "thinking_enabled": bool(thinking_var.get()),
        }

    def save() -> None:
        data = collect()
        if data is None:
            return
        save_llm_settings(data)
        saved["ok"] = True
        win.destroy()

    def test() -> None:
        data = collect()
        if data is None:
            return
        ok, msg = test_connection(data)
        (messagebox.showinfo if ok else messagebox.showwarning)("测试连接", msg, parent=win)

    ttk.Button(footer, text="测试连接", command=test, width=12).grid(row=0, column=0, sticky="w")
    ttk.Button(footer, text="取消", command=win.destroy, width=10, style="Secondary.TButton").grid(row=0, column=1, sticky="e", padx=(8, 0))
    ttk.Button(footer, text="保存", command=save, width=10).grid(row=0, column=2, sticky="e")
    center_on_parent(win, parent)
    win.wait_window()
    return saved["ok"]
