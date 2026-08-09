#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""User-interface preferences for Audit Roll Forward.

This module deliberately contains no roll-forward or workbook-processing logic.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

from PyQt6.QtCore import Qt, QTimer, QUrl
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)


APP_VERSION = "Afix2 + Settings 2"

THEMES = {
    "mist_teal": {
        "name": "系列1 · 雾青珊瑚",
        "swatches": ["#11616B", "#7BBDB6", "#EBF4F8", "#FED9CD", "#DC8B70"],
        "background": "#EBF4F8", "input": "#FFFFFF", "panel": "#FFFFFF",
        "panel_alt": "#D7E8EB", "border": "#7BBDB6", "text": "#123F46",
        "muted": "#365F66", "placeholder": "#526F75", "accent": "#11616B",
        "accent_text": "#FFFFFF", "selected": "#CDE8E5", "hover": "#DDEFF1",
        "header_start": "#C9DDE0", "header_end": "#EBF4F8",
        "disabled_bg": "#E3EBED", "disabled_text": "#65777B",
        "success": "#247A55", "error": "#A84529",
    },
    "deep_sea_sun": {
        "name": "系列2 · 深海暖阳",
        "swatches": ["#004E66", "#51A3BC", "#E1EEF6", "#FCBE32", "#FF5F2E"],
        "background": "#003648", "input": "#004459", "panel": "#004E66",
        "panel_alt": "#0C627C", "border": "#51A3BC", "text": "#F4FAFD",
        "muted": "#C5E2EC", "placeholder": "#A6CEDA", "accent": "#FCBE32",
        "accent_text": "#332200", "selected": "#17677C", "hover": "#0B5B72",
        "header_start": "#002E3D", "header_end": "#004E66",
        "disabled_bg": "#234E59", "disabled_text": "#A9C0C6",
        "success": "#72D49B", "error": "#FF7650",
    },
    "indigo_blush": {
        "name": "系列3 · 靛蓝暮粉",
        "swatches": ["#1E50A1", "#5E67AA", "#9284B4", "#C0A3C0", "#E9C4CB"],
        "background": "#F2F3FA", "input": "#FFFFFF", "panel": "#FFFFFF",
        "panel_alt": "#E6E8F3", "border": "#9B94BB", "text": "#173B78",
        "muted": "#485A82", "placeholder": "#63708E", "accent": "#1E50A1",
        "accent_text": "#FFFFFF", "selected": "#E9D7DF", "hover": "#E9ECF7",
        "header_start": "#D5DEEF", "header_end": "#F4F6FB",
        "disabled_bg": "#E4E5EB", "disabled_text": "#6D7180",
        "success": "#267A54", "error": "#A73952",
    },
    "midnight_amber": {
        "name": "系列4 · 午夜琥珀",
        "swatches": ["#171635", "#00225D", "#763262", "#CA7508", "#E9A621"],
        "background": "#101026", "input": "#171635", "panel": "#111F48",
        "panel_alt": "#00225D", "border": "#5B5F83", "text": "#FFF9E9",
        "muted": "#D5D2E3", "placeholder": "#AAA7C1", "accent": "#E9A621",
        "accent_text": "#2A1900", "selected": "#3E2B59", "hover": "#24356A",
        "header_start": "#171635", "header_end": "#00225D",
        "disabled_bg": "#25253A", "disabled_text": "#A7A4B6",
        "success": "#67D795", "error": "#FF7A75",
    },
    "navy_coral": {
        "name": "系列5 · 海军蓝珊瑚",
        "swatches": ["#314A8C", "#F3CDB6", "#EC8D61", "#D03542", "#2C3F2C"],
        "background": "#FFF3EC", "input": "#FFFFFF", "panel": "#FFFFFF",
        "panel_alt": "#F6DED0", "border": "#D6A88C", "text": "#26382A",
        "muted": "#526254", "placeholder": "#68776A", "accent": "#314A8C",
        "accent_text": "#FFFFFF", "selected": "#F3CDB6", "hover": "#FBE4D7",
        "header_start": "#F9DED0", "header_end": "#FFF8F3",
        "disabled_bg": "#ECE3DE", "disabled_text": "#746B67",
        "success": "#2F7650", "error": "#D03542",
    },
    "sage_stone": {
        "name": "系列6 · 岩灰鼠尾草",
        "swatches": ["#44363A", "#62595B", "#959588", "#C2CFAF", "#DFD6D6"],
        "background": "#F0EEEE", "input": "#FFFFFF", "panel": "#FBFAFA",
        "panel_alt": "#E5E2E0", "border": "#959588", "text": "#44363A",
        "muted": "#62595B", "placeholder": "#716B6C", "accent": "#62595B",
        "accent_text": "#FFFFFF", "selected": "#DDE5D4", "hover": "#ECE8E7",
        "header_start": "#DDD9D9", "header_end": "#F3F1F1",
        "disabled_bg": "#E5E2E1", "disabled_text": "#716D6D",
        "success": "#4F7353", "error": "#A5414B",
    },
    "cream_matcha": {
        "name": "系列7 · 奶油抹茶",
        "swatches": ["#D4A373", "#FAEDCD", "#FEFAE0", "#E9EDC9", "#CCD5AE"],
        "background": "#FAEDCD", "input": "#FFFDF4", "panel": "#FEFAE0",
        "panel_alt": "#F5EBC7", "border": "#9AA679", "text": "#455137",
        "muted": "#5F694D", "placeholder": "#70785E", "accent": "#7B542C",
        "accent_text": "#FFFFFF", "selected": "#E9EDC9", "hover": "#F4F1D8",
        "header_start": "#F3DFC0", "header_end": "#FEFAE0",
        "disabled_bg": "#ECE7D2", "disabled_text": "#777160",
        "success": "#527341", "error": "#A64A38",
    },
    "rose_greige": {
        "name": "系列8 · 暖灰玫瑰",
        "swatches": ["#653D43", "#7F7C76", "#999490", "#CCCCCC", "#E5E1DC"],
        "background": "#E5E1DC", "input": "#F9F8F6", "panel": "#F3F1EE",
        "panel_alt": "#D8D4D0", "border": "#999490", "text": "#4A2C32",
        "muted": "#5F5A56", "placeholder": "#6F6A66", "accent": "#653D43",
        "accent_text": "#FFFFFF", "selected": "#D2CECA", "hover": "#E4E1DE",
        "header_start": "#D3D0CC", "header_end": "#ECE9E5",
        "disabled_bg": "#DAD7D3", "disabled_text": "#716D69",
        "success": "#4D704F", "error": "#A33F4A",
    },
    "forest_gold": {
        "name": "系列9 · 森林鎏金",
        "swatches": ["#2C6AA5", "#64894D", "#DDC655", "#D9AE2C", "#D88C27"],
        "background": "#F6F3E8", "input": "#FFFFFF", "panel": "#FFFDF8",
        "panel_alt": "#EFE7C3", "border": "#B6A94F", "text": "#2D4A2D",
        "muted": "#4F624A", "placeholder": "#63725E", "accent": "#2C6AA5",
        "accent_text": "#FFFFFF", "selected": "#F1E49A", "hover": "#F7EFC5",
        "header_start": "#E9E1BD", "header_end": "#F8F5E9",
        "disabled_bg": "#E6E1D0", "disabled_text": "#6D6A5F",
        "success": "#527A3D", "error": "#A64F1C",
    },
}

FONT_SIZES = {
    "small": ("小", 12),
    "standard": ("标准", 13),
    "large": ("大", 15),
    "extra_large": ("特大", 17),
}

DENSITIES = {
    "compact": ("紧凑", 7),
    "standard": ("标准", 9),
    "comfortable": ("宽松", 12),
}

DEFAULT_SETTINGS = {
    "theme": "mist_teal",
    "font_size": "standard",
    "density": "standard",
    "remember_window": True,
    "remember_last_project": True,
    "show_new_user_guide": True,
    "show_feedback_prompt": True,
    "default_prior_dir": "",
    "default_output_dir": "",
    "open_output_after_success": False,
    "window_geometry": {},
    "last_project_index": 0,
    "last_company_index": 0,
}


def _channel(hex_color: str):
    value = hex_color.lstrip("#")
    return tuple(int(value[index:index + 2], 16) / 255 for index in (0, 2, 4))


def _relative_luminance(hex_color: str):
    values = []
    for value in _channel(hex_color):
        values.append(value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]


def contrast_ratio(first: str, second: str):
    lighter, darker = sorted((_relative_luminance(first), _relative_luminance(second)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def validate_themes():
    """Reject a palette if normal text can become unreadable."""
    required_pairs = (
        ("text", "background"),
        ("text", "panel"),
        ("text", "input"),
        ("muted", "panel"),
        ("placeholder", "input"),
        ("accent_text", "accent"),
    )
    failures = []
    for key, palette in THEMES.items():
        for foreground, background in required_pairs:
            ratio = contrast_ratio(palette[foreground], palette[background])
            if ratio < 4.5:
                failures.append(f"{key}: {foreground}/{background}={ratio:.2f}")
    if failures:
        raise ValueError("Theme contrast validation failed: " + "; ".join(failures))
    return True


validate_themes()


def normalize_settings(value):
    settings = copy.deepcopy(DEFAULT_SETTINGS)
    if isinstance(value, dict):
        settings.update({key: item for key, item in value.items() if key in settings})
    if settings["theme"] not in THEMES:
        settings["theme"] = DEFAULT_SETTINGS["theme"]
    if settings["font_size"] not in FONT_SIZES:
        settings["font_size"] = DEFAULT_SETTINGS["font_size"]
    if settings["density"] not in DENSITIES:
        settings["density"] = DEFAULT_SETTINGS["density"]
    for key in (
        "remember_window",
        "remember_last_project",
        "show_new_user_guide",
        "show_feedback_prompt",
        "open_output_after_success",
    ):
        settings[key] = bool(settings[key])
    for key in ("last_project_index", "last_company_index"):
        try:
            settings[key] = max(0, int(settings[key]))
        except (TypeError, ValueError):
            settings[key] = 0
    if not isinstance(settings.get("window_geometry"), dict):
        settings["window_geometry"] = {}
    return settings


def load_settings(path: Path):
    try:
        if path.exists():
            return normalize_settings(json.loads(path.read_text(encoding="utf-8")))
    except Exception:
        pass
    return normalize_settings({})


def save_settings(path: Path, settings):
    normalized = normalize_settings(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")
    return normalized


class SettingsDialog(QDialog):
    """A UI-only settings dialog with live preview and safe cancellation."""

    def __init__(self, host, settings, feedback_url):
        super().__init__(host)
        self.host = host
        self.feedback_url = feedback_url
        self.original_settings = normalize_settings(settings)
        self.setWindowTitle("设置")
        self.setMinimumSize(680, 560)
        self.resize(760, 630)
        self.build_ui()
        self.load_controls(self.original_settings)
        self.connect_preview_signals()

    def build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 20, 20, 18)
        root.setSpacing(14)

        heading = QLabel("Audit Roll Forward 设置")
        heading.setObjectName("DialogTitle")
        root.addWidget(heading)

        self.tabs = QTabWidget()
        root.addWidget(self.tabs, 1)
        self.tabs.addTab(self.create_appearance_tab(), "外观")
        self.tabs.addTab(self.create_general_tab(), "常规")
        self.tabs.addTab(self.create_files_tab(), "文件与输出")
        self.tabs.addTab(self.create_help_tab(), "帮助与反馈")

        buttons = QHBoxLayout()
        self.reset_btn = QPushButton("恢复默认")
        self.reset_btn.clicked.connect(self.reset_defaults)
        buttons.addWidget(self.reset_btn)
        buttons.addStretch()
        cancel_btn = QPushButton("取消")
        cancel_btn.clicked.connect(self.cancel_changes)
        save_btn = QPushButton("保存并应用")
        save_btn.setObjectName("PrimaryButton")
        save_btn.clicked.connect(self.save_changes)
        buttons.addWidget(cancel_btn)
        buttons.addWidget(save_btn)
        root.addLayout(buttons)

    def create_appearance_tab(self):
        page = QWidget()
        form = QFormLayout(page)
        form.setContentsMargins(18, 22, 18, 18)
        form.setHorizontalSpacing(24)
        form.setVerticalSpacing(18)
        self.theme_combo = QComboBox()
        for key, palette in THEMES.items():
            self.theme_combo.addItem(palette["name"], key)
        self.font_combo = QComboBox()
        for key, (label, _size) in FONT_SIZES.items():
            self.font_combo.addItem(label, key)
        self.density_combo = QComboBox()
        for key, (label, _padding) in DENSITIES.items():
            self.density_combo.addItem(label, key)
        swatch_widget = QWidget()
        swatch_layout = QHBoxLayout(swatch_widget)
        swatch_layout.setContentsMargins(0, 0, 0, 0)
        swatch_layout.setSpacing(6)
        self.theme_swatches = []
        for _index in range(5):
            swatch = QLabel()
            swatch.setAlignment(Qt.AlignmentFlag.AlignCenter)
            swatch.setMinimumHeight(58)
            swatch.setMinimumWidth(78)
            swatch_layout.addWidget(swatch, 1)
            self.theme_swatches.append(swatch)
        form.addRow("主题配色", self.theme_combo)
        form.addRow("配色色卡", swatch_widget)
        form.addRow("字体大小", self.font_combo)
        form.addRow("界面密度", self.density_combo)
        note = QLabel("主题切换仅影响软件界面，不改变底稿、公式、CRA、Wording或Roll Forward处理规则。")
        note.setObjectName("MutedLabel")
        note.setWordWrap(True)
        form.addRow("", note)
        return page

    def create_general_tab(self):
        page = QWidget()
        form = QFormLayout(page)
        form.setContentsMargins(18, 22, 18, 18)
        form.setVerticalSpacing(17)
        self.remember_window_checkbox = QCheckBox("记住窗口大小和位置")
        self.remember_project_checkbox = QCheckBox("启动时返回上次使用的项目和公司")
        self.guide_checkbox = QCheckBox("首次使用时自动显示新手指引")
        self.feedback_checkbox = QCheckBox("处理成功后显示一次问卷提醒")
        form.addRow(self.remember_window_checkbox)
        form.addRow(self.remember_project_checkbox)
        form.addRow(self.guide_checkbox)
        form.addRow(self.feedback_checkbox)
        return page

    def _path_row(self, line_edit, callback):
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        layout.addWidget(line_edit, 1)
        button = QPushButton("浏览")
        button.clicked.connect(callback)
        layout.addWidget(button)
        return row

    def create_files_tab(self):
        page = QWidget()
        form = QFormLayout(page)
        form.setContentsMargins(18, 22, 18, 18)
        form.setHorizontalSpacing(20)
        form.setVerticalSpacing(16)
        self.prior_dir_input = QLineEdit()
        self.prior_dir_input.setPlaceholderText("新建公司时默认使用，可留空")
        self.output_dir_input = QLineEdit()
        self.output_dir_input.setPlaceholderText("新建公司时默认使用，可留空")
        self.open_output_checkbox = QCheckBox("单个公司处理成功后自动打开输出文件夹")
        form.addRow("默认上年底稿目录", self._path_row(self.prior_dir_input, self.browse_prior_dir))
        form.addRow("默认输出目录", self._path_row(self.output_dir_input, self.browse_output_dir))
        form.addRow("", self.open_output_checkbox)
        note = QLabel("默认路径只用于新建公司，不覆盖现有公司已经保存的路径。工具仍会生成新文件，不会自动覆盖上年底稿。")
        note.setObjectName("MutedLabel")
        note.setWordWrap(True)
        form.addRow("", note)
        return page

    def create_help_tab(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(18, 22, 18, 18)
        layout.setSpacing(12)
        version = QLabel(f"当前版本：{APP_VERSION}")
        version.setObjectName("SectionTitle")
        layout.addWidget(version)
        guide_btn = QPushButton("重新查看新手指引")
        guide_btn.clicked.connect(self.open_guide)
        feedback_btn = QPushButton("打开意见反馈与内测问卷")
        feedback_btn.clicked.connect(lambda: QDesktopServices.openUrl(QUrl(self.feedback_url)))
        scope_btn = QPushButton("查看使用范围说明")
        scope_btn.clicked.connect(self.show_scope)
        layout.addWidget(guide_btn)
        layout.addWidget(feedback_btn)
        layout.addWidget(scope_btn)
        layout.addStretch()
        privacy = QLabel("设置保存在本机用户目录，不包含底稿内容、公司数据、密码或客户敏感信息。")
        privacy.setObjectName("MutedLabel")
        privacy.setWordWrap(True)
        layout.addWidget(privacy)
        return page

    def connect_preview_signals(self):
        self.theme_combo.currentIndexChanged.connect(self.preview)
        self.font_combo.currentIndexChanged.connect(self.preview)
        self.density_combo.currentIndexChanged.connect(self.preview)

    @staticmethod
    def _set_combo(combo, value):
        index = combo.findData(value)
        combo.setCurrentIndex(index if index >= 0 else 0)

    def load_controls(self, settings):
        settings = normalize_settings(settings)
        for combo in (self.theme_combo, self.font_combo, self.density_combo):
            combo.blockSignals(True)
        self._set_combo(self.theme_combo, settings["theme"])
        self._set_combo(self.font_combo, settings["font_size"])
        self._set_combo(self.density_combo, settings["density"])
        for combo in (self.theme_combo, self.font_combo, self.density_combo):
            combo.blockSignals(False)
        self.remember_window_checkbox.setChecked(settings["remember_window"])
        self.remember_project_checkbox.setChecked(settings["remember_last_project"])
        self.guide_checkbox.setChecked(settings["show_new_user_guide"])
        self.feedback_checkbox.setChecked(settings["show_feedback_prompt"])
        self.prior_dir_input.setText(settings["default_prior_dir"])
        self.output_dir_input.setText(settings["default_output_dir"])
        self.open_output_checkbox.setChecked(settings["open_output_after_success"])
        self.update_theme_swatches()

    def collect_settings(self):
        settings = copy.deepcopy(self.original_settings)
        settings.update({
            "theme": self.theme_combo.currentData(),
            "font_size": self.font_combo.currentData(),
            "density": self.density_combo.currentData(),
            "remember_window": self.remember_window_checkbox.isChecked(),
            "remember_last_project": self.remember_project_checkbox.isChecked(),
            "show_new_user_guide": self.guide_checkbox.isChecked(),
            "show_feedback_prompt": self.feedback_checkbox.isChecked(),
            "default_prior_dir": self.prior_dir_input.text().strip(),
            "default_output_dir": self.output_dir_input.text().strip(),
            "open_output_after_success": self.open_output_checkbox.isChecked(),
        })
        return normalize_settings(settings)

    def preview(self):
        self.update_theme_swatches()
        self.host.apply_user_settings(self.collect_settings(), persist=False)

    def update_theme_swatches(self):
        palette = THEMES.get(self.theme_combo.currentData(), THEMES[DEFAULT_SETTINGS["theme"]])
        for swatch, color in zip(self.theme_swatches, palette["swatches"]):
            light_ratio = contrast_ratio("#FFFFFF", color)
            dark_ratio = contrast_ratio("#172033", color)
            foreground = "#FFFFFF" if light_ratio >= dark_ratio else "#172033"
            swatch.setText(color.upper())
            swatch.setStyleSheet(
                f"background: {color}; color: {foreground}; border: 1px solid rgba(0, 0, 0, 55); "
                "border-radius: 7px; font-size: 10px; font-weight: 700;"
            )

    def reset_defaults(self):
        self.load_controls(DEFAULT_SETTINGS)
        self.preview()

    def save_changes(self):
        try:
            self.host.apply_user_settings(self.collect_settings(), persist=True)
        except Exception as exc:
            QMessageBox.warning(self, "设置", f"设置保存失败：{exc}")
            return
        self.accept()

    def cancel_changes(self):
        self.host.apply_user_settings(self.original_settings, persist=False)
        self.reject()

    def reject(self):
        self.host.apply_user_settings(self.original_settings, persist=False)
        super().reject()

    def browse_prior_dir(self):
        path = self.host.choose_directory_external("选择默认上年底稿目录")
        if path:
            self.prior_dir_input.setText(path)

    def browse_output_dir(self):
        path = self.host.choose_directory_external("选择默认输出目录")
        if path:
            self.output_dir_input.setText(path)

    def open_guide(self):
        self.save_changes()
        if self.result() == QDialog.DialogCode.Accepted:
            QTimer.singleShot(0, lambda: self.host.show_new_user_guide(mark_shown=True))

    def show_scope(self):
        QMessageBox.information(
            self,
            "使用范围",
            "仅适用于公司标准V6底稿模板的Roll Forward。上年底稿须为.xlsx格式；"
            "若Sheet名称、表头或底稿结构被大幅修改，可能无法正确识别。生成后仍需项目组复核金额、公式、CRA及黄色标记内容。",
        )
