#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Audit Roll Forward desktop application.

Technology stack: PyQt6 + openpyxl + PyInstaller
"""

import os
import sys
import json
import datetime
import multiprocessing
import subprocess
import tempfile
import re
import time
from pathlib import Path

from PyQt6.QtCore import QPoint, QRect, QSize, Qt, QThread, QTimer, pyqtSignal
from PyQt6.QtGui import QAction, QColor, QDesktopServices, QFont, QIcon, QPainter, QPen, QPixmap
from PyQt6.QtCore import QUrl
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFrame,
    QFileDialog,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMenu,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QStackedWidget,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from roll_forward_core import SubjectConfig, resource_path
from roll_worker_process import run_rollforward_process
from cra_support import (
    CRA_PARSER_VERSION,
    detect_cra_header_options,
    parse_cra_paste_text,
    write_cra_parse_debug_log,
    normalize_assertion,
    normalize_risk_level,
    check_ratio_range,
)
from app_settings import (
    APP_VERSION,
    DENSITIES,
    FONT_SIZES,
    THEMES,
    SettingsDialog,
    load_settings,
    normalize_settings,
    save_settings,
)

try:
    from llm_enhancement import test_llm_connection
except Exception:
    test_llm_connection = None


EY_YELLOW = "#67E8F9"
EY_BLACK = "#0B0F1A"
EY_OFF_BLACK = "#151A27"
EY_PANEL = "#111827"
EY_PANEL_ALT = "#1B2435"
EY_BORDER = "#30394D"
EY_TEXT = "#F8FAFC"
EY_MUTED = "#C2CBE0"
EY_PLACEHOLDER = "#8B96AD"
EY_SUCCESS = "#2DBE60"
EY_ERROR = "#FF4B55"
EY_ACCENT_TEXT = EY_BLACK
FEEDBACK_URL = "https://v.wjx.cn/vm/mEfMFm4.aspx"
APP_LOGO_PATH = "assets/audit_roll_forward_logo.png"
APP_ICON_PATH = "assets/audit_roll_forward_icon.ico"
APP_STATE_DIR = Path(os.getenv("APPDATA", str(Path.home()))) / "AuditRollForward"
FEEDBACK_STATE_PATH = APP_STATE_DIR / "feedback_state.json"
GUIDE_STATE_PATH = APP_STATE_DIR / "guide_state.json"
APP_LOG_PATH = APP_STATE_DIR / "logs" / "app.log"
WORKBENCH_PROJECTS_PATH = APP_STATE_DIR / "projects.json"
APP_SETTINGS_PATH = APP_STATE_DIR / "settings.json"


def apply_palette_globals(palette):
    """Expose the active palette to existing UI-only color references."""
    global EY_YELLOW, EY_BLACK, EY_OFF_BLACK, EY_PANEL, EY_PANEL_ALT
    global EY_BORDER, EY_TEXT, EY_MUTED, EY_PLACEHOLDER, EY_SUCCESS, EY_ERROR
    global EY_ACCENT_TEXT
    EY_YELLOW = palette["accent"]
    EY_BLACK = palette["background"]
    EY_OFF_BLACK = palette["input"]
    EY_PANEL = palette["panel"]
    EY_PANEL_ALT = palette["panel_alt"]
    EY_BORDER = palette["border"]
    EY_TEXT = palette["text"]
    EY_MUTED = palette["muted"]
    EY_PLACEHOLDER = palette["placeholder"]
    EY_SUCCESS = palette["success"]
    EY_ERROR = palette["error"]
    EY_ACCENT_TEXT = palette["accent_text"]


class SortableTableWidgetItem(QTableWidgetItem):
    """Sort percentages numerically while retaining their formatted display text."""

    def __lt__(self, other):
        left = self.data(Qt.ItemDataRole.UserRole)
        right = other.data(Qt.ItemDataRole.UserRole) if isinstance(other, QTableWidgetItem) else None
        if isinstance(left, (int, float)) and isinstance(right, (int, float)):
            return left < right
        return super().__lt__(other)


class CurrentPageStackedWidget(QStackedWidget):
    """Size the main stack from its visible page instead of its tallest page."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.currentChanged.connect(lambda _index: self.updateGeometry())

    def sizeHint(self):
        current = self.currentWidget()
        return current.sizeHint() if current is not None else super().sizeHint()

    def minimumSizeHint(self):
        current = self.currentWidget()
        return current.minimumSizeHint() if current is not None else super().minimumSizeHint()


FILE_DIALOG_STYLESHEET = """
    QFileDialog {
        background: #F8FAFC;
        color: #111827;
    }
    QFileDialog QLabel,
    QFileDialog QCheckBox,
    QFileDialog QRadioButton {
        color: #111827;
        background: transparent;
    }
    QFileDialog QTreeView,
    QFileDialog QListView,
    QFileDialog QTableView {
        background: #FFFFFF;
        color: #111827;
        alternate-background-color: #F1F5F9;
        border: 1px solid #CBD5E1;
        selection-background-color: #D7EBFF;
        selection-color: #0F172A;
    }
    QFileDialog QHeaderView::section {
        background: #E2E8F0;
        color: #0F172A;
        border: 1px solid #CBD5E1;
        padding: 6px;
        font-weight: 700;
    }
    QFileDialog QLineEdit,
    QFileDialog QComboBox {
        background: #FFFFFF;
        color: #111827;
        border: 1px solid #CBD5E1;
        border-radius: 3px;
        padding: 6px 8px;
        selection-background-color: #D7EBFF;
        selection-color: #0F172A;
    }
    QFileDialog QComboBox QAbstractItemView {
        background: #FFFFFF;
        color: #111827;
        selection-background-color: #D7EBFF;
        selection-color: #0F172A;
    }
    QFileDialog QToolButton {
        background: #FFFFFF;
        color: #111827;
        border: 1px solid #CBD5E1;
        border-radius: 3px;
        padding: 5px;
    }
    QFileDialog QToolButton:hover {
        background: #E0F2FE;
    }
    QFileDialog QPushButton {
        background: #1E293B;
        color: #FFFFFF;
        border: 1px solid #1E293B;
        border-radius: 4px;
        padding: 8px 14px;
        font-weight: 700;
    }
    QFileDialog QPushButton:hover {
        background: #334155;
    }
    QFileDialog QScrollBar {
        background: #E2E8F0;
        border: none;
    }
"""


class GuideOverlay(QWidget):
    """Step-by-step in-app guide with a spotlight around the active section."""

    def __init__(self, host, steps):
        super().__init__(host)
        self.host = host
        self.steps = steps
        self.index = 0
        self.target_rect = QRect()
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setWindowFlags(Qt.WindowType.Widget)

        self.popup = QFrame(self)
        self.popup.setObjectName("GuidePopup")
        self.popup.setStyleSheet(f"""
            QFrame#GuidePopup {{
                background: #F8FAFC;
                border: 1px solid #D6DDEA;
                border-radius: 8px;
            }}
            QLabel#GuideTitle {{
                color: #0B0F1A;
                font-size: 16px;
                font-weight: 800;
            }}
            QLabel#GuideBody {{
                color: #1F2937;
                font-size: 13px;
                line-height: 1.35;
            }}
            QLabel#GuideStep {{
                color: #64748B;
                font-size: 12px;
            }}
            QPushButton {{
                background: #E2E8F0;
                color: #0B0F1A;
                border: 1px solid #CBD5E1;
                border-radius: 4px;
                padding: 7px 12px;
                font-weight: 700;
            }}
            QPushButton#GuidePrimary {{
                background: {EY_YELLOW};
                color: {EY_ACCENT_TEXT};
                border-color: {EY_YELLOW};
            }}
        """)
        popup_layout = QVBoxLayout(self.popup)
        popup_layout.setContentsMargins(18, 16, 18, 16)
        popup_layout.setSpacing(10)

        self.step_label = QLabel()
        self.step_label.setObjectName("GuideStep")
        self.title_label = QLabel()
        self.title_label.setObjectName("GuideTitle")
        self.body_label = QLabel()
        self.body_label.setObjectName("GuideBody")
        self.body_label.setWordWrap(True)
        popup_layout.addWidget(self.step_label)
        popup_layout.addWidget(self.title_label)
        popup_layout.addWidget(self.body_label)

        button_row = QHBoxLayout()
        self.skip_btn = QPushButton("跳过")
        self.prev_btn = QPushButton("上一步")
        self.next_btn = QPushButton("下一步")
        self.next_btn.setObjectName("GuidePrimary")
        self.skip_btn.clicked.connect(self.close)
        self.prev_btn.clicked.connect(self.previous_step)
        self.next_btn.clicked.connect(self.next_step)
        button_row.addWidget(self.skip_btn)
        button_row.addStretch()
        button_row.addWidget(self.prev_btn)
        button_row.addWidget(self.next_btn)
        popup_layout.addLayout(button_row)

    def start(self):
        self.setGeometry(self.host.rect())
        self.raise_()
        self.show()
        self.show_step(0)

    def show_step(self, index):
        self.index = max(0, min(index, len(self.steps) - 1))
        step = self.steps[self.index]
        if step.get("main_page") and hasattr(self.host, "switch_page"):
            self.host.switch_page(step["main_page"])
        if step.get("workspace_page") and hasattr(self.host, "switch_workspace_page"):
            self.host.switch_workspace_page(step["workspace_page"])
        target = step.get("target")
        if target is not None and hasattr(self.host, "root_scroll"):
            self.host.root_scroll.ensureWidgetVisible(target, 60, 60)
        QTimer.singleShot(80, self.refresh_step)

    def refresh_step(self):
        if not self.steps:
            self.close()
            return
        step = self.steps[self.index]
        target = step.get("target")
        if target is not None:
            top_left = target.mapTo(self.host, QPoint(0, 0))
            self.target_rect = QRect(top_left, target.size()).adjusted(-8, -8, 8, 8)
            self.target_rect = self.target_rect.intersected(self.rect().adjusted(16, 16, -16, -16))
        else:
            self.target_rect = QRect()

        self.step_label.setText(f"步骤 {self.index + 1} / {len(self.steps)}")
        self.title_label.setText(step.get("title", ""))
        self.body_label.setText(step.get("body", ""))
        self.prev_btn.setEnabled(self.index > 0)
        self.next_btn.setText("完成" if self.index == len(self.steps) - 1 else "下一步")
        self.position_popup()
        self.update()

    def position_popup(self):
        width = 390
        self.popup.setFixedWidth(width)
        self.popup.adjustSize()
        height = self.popup.sizeHint().height()
        margin = 18

        if self.target_rect.isValid():
            right_x = self.target_rect.right() + margin
            left_x = self.target_rect.left() - width - margin
            if right_x + width <= self.width() - margin:
                x = right_x
            elif left_x >= margin:
                x = left_x
            else:
                x = min(max(margin, self.target_rect.left()), self.width() - width - margin)

            below_y = self.target_rect.bottom() + margin
            above_y = self.target_rect.top() - height - margin
            if below_y + height <= self.height() - margin:
                y = below_y
            elif above_y >= margin:
                y = above_y
            else:
                y = min(max(margin, self.target_rect.top()), self.height() - height - margin)
        else:
            x = (self.width() - width) // 2
            y = (self.height() - height) // 2

        self.popup.setGeometry(x, y, width, height)

    def next_step(self):
        if self.index >= len(self.steps) - 1:
            self.close()
        else:
            self.show_step(self.index + 1)

    def previous_step(self):
        self.show_step(self.index - 1)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.position_popup()
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        shade = QColor(0, 0, 0, 160)
        if self.target_rect.isValid():
            target = self.target_rect
            painter.fillRect(QRect(0, 0, self.width(), max(0, target.top())), shade)
            painter.fillRect(QRect(0, target.bottom(), self.width(), max(0, self.height() - target.bottom())), shade)
            painter.fillRect(QRect(0, target.top(), max(0, target.left()), target.height()), shade)
            painter.fillRect(QRect(target.right(), target.top(), max(0, self.width() - target.right()), target.height()), shade)
            pen = QPen(QColor(EY_YELLOW), 3)
            painter.setPen(pen)
            painter.drawRoundedRect(self.target_rect.adjusted(1, 1, -1, -1), 10, 10)
        else:
            painter.fillRect(self.rect(), shade)


class RollForwardApp(QWidget):
    def __init__(self):
        super().__init__()
        self.user_settings = load_settings(APP_SETTINGS_PATH)
        self.theme_palette = THEMES[self.user_settings["theme"]]
        apply_palette_globals(self.theme_palette)
        self.worker = None
        self.llm_test_worker = None
        self.project_file_path = ""
        self.project_batch_queue = []
        self.project_batch_active = False
        self.active_processing_company_index = None
        self.cra_skip_confirmed_companies = set()
        self.current_project_index = self.user_settings["last_project_index"] if self.user_settings["remember_last_project"] else 0
        self.current_company_index = self.user_settings["last_company_index"] if self.user_settings["remember_last_project"] else 0
        self.project_view_mode = "list"
        self.workbench_data = self.load_workbench_data()
        self.current_project_index = max(0, min(self.current_project_index, len(self.workbench_data["projects"]) - 1))
        self.project_data = self.workbench_data["projects"][self.current_project_index]
        companies = self.project_data.get("companies", [])
        self.current_company_index = max(0, min(self.current_company_index, max(len(companies) - 1, 0)))
        self.setWindowTitle("Audit Roll Forward")
        self.setWindowIcon(QIcon(resource_path(APP_ICON_PATH)))
        self.setMinimumSize(1100, 760)
        self.restore_window_geometry()
        self.setStyleSheet(self.stylesheet())
        self.init_ui()
        QTimer.singleShot(500, self.maybe_show_new_user_guide)

    def restore_window_geometry(self):
        geometry = self.user_settings.get("window_geometry", {})
        if self.user_settings.get("remember_window") and geometry:
            try:
                width = max(1100, int(geometry.get("width", 1400)))
                height = max(760, int(geometry.get("height", 1000)))
                self.setGeometry(
                    int(geometry.get("x", 80)),
                    int(geometry.get("y", 60)),
                    width,
                    height,
                )
                return
            except (TypeError, ValueError):
                pass
        self.setGeometry(80, 60, 1400, 1000)

    def capture_runtime_settings(self, settings=None):
        settings = normalize_settings(settings or self.user_settings)
        if settings["remember_window"]:
            geometry = self.geometry()
            settings["window_geometry"] = {
                "x": geometry.x(),
                "y": geometry.y(),
                "width": geometry.width(),
                "height": geometry.height(),
            }
        else:
            settings["window_geometry"] = {}
        if settings["remember_last_project"]:
            settings["last_project_index"] = self.current_project_index
            settings["last_company_index"] = self.current_company_index
        else:
            settings["last_project_index"] = 0
            settings["last_company_index"] = 0
        return settings

    def save_user_settings(self):
        self.user_settings = save_settings(
            APP_SETTINGS_PATH,
            self.capture_runtime_settings(self.user_settings),
        )

    def apply_user_settings(self, settings, persist=False):
        default_theme = normalize_settings({})["theme"]
        previous_palette = dict(getattr(self, "theme_palette", THEMES[default_theme]))
        self.user_settings = normalize_settings(settings)
        self.theme_palette = THEMES[self.user_settings["theme"]]
        apply_palette_globals(self.theme_palette)
        self.setStyleSheet(self.stylesheet())
        self.refresh_inline_theme_colors(previous_palette, self.theme_palette)
        if persist:
            self.save_user_settings()

    def refresh_inline_theme_colors(self, previous, current):
        color_keys = (
            "background", "input", "panel", "panel_alt", "border", "text", "muted",
            "placeholder", "accent", "accent_text", "success", "error",
        )
        replacements = {
            previous[key].upper(): current[key]
            for key in color_keys
            if previous.get(key) and current.get(key)
        }
        if replacements:
            pattern = re.compile("|".join(re.escape(key) for key in sorted(replacements, key=len, reverse=True)), re.I)

            def replace_colors(value):
                return pattern.sub(lambda match: replacements.get(match.group(0).upper(), match.group(0)), value or "")

            for widget in self.findChildren(QWidget):
                inline_style = widget.styleSheet()
                if inline_style:
                    widget.setStyleSheet(replace_colors(inline_style))
                if isinstance(widget, QLabel) and "#" in widget.text():
                    widget.setText(replace_colors(widget.text()))
            for table in self.findChildren(QTableWidget):
                for row in range(table.rowCount()):
                    for column in range(table.columnCount()):
                        item = table.item(row, column)
                        if item is None:
                            continue
                        old_color = item.foreground().color().name().upper()
                        if old_color in replacements:
                            item.setForeground(QColor(replacements[old_color]))
        if hasattr(self, "feedback_link"):
            self.feedback_link.setText(
                f'<a href="{FEEDBACK_URL}" style="color: {EY_YELLOW}; text-decoration: none;">意见反馈</a>'
            )

    def show_settings_dialog(self):
        dialog = SettingsDialog(self, self.user_settings, FEEDBACK_URL)
        dialog.setWindowIcon(QIcon(resource_path(APP_ICON_PATH)))
        dialog.exec()

    def closeEvent(self, event):
        self.save_workbench_data()
        try:
            self.save_user_settings()
        except Exception:
            pass
        super().closeEvent(event)

    def stylesheet(self):
        palette = self.theme_palette
        base_font = FONT_SIZES[self.user_settings["font_size"]][1]
        control_padding = DENSITIES[self.user_settings["density"]][1]
        compact_padding = max(5, control_padding - 2)
        return f"""
            QWidget {{
                font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
                font-size: {base_font}px;
                color: {EY_TEXT};
            }}
            QMainWindow {{
                background: {EY_BLACK};
            }}
            QWidget#AppRoot {{
                background: {EY_BLACK};
            }}
            QWidget#Page {{
                background: {EY_BLACK};
            }}
            QWidget#Header {{
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 {palette['header_start']}, stop:1 {palette['header_end']});
                border: 1px solid {EY_BORDER};
                border-radius: 8px;
            }}
            QScrollArea {{
                border: none;
                background: {EY_BLACK};
            }}
            QScrollArea#RootScroll {{
                background: {EY_BLACK};
            }}
            QScrollArea#RootScroll > QWidget {{
                background: {EY_BLACK};
            }}
            QFrame#Card {{
                background: {EY_PANEL};
                border: 1px solid {EY_BORDER};
                border-radius: 8px;
            }}
            QLabel#EyMark {{
                background: transparent;
                border: none;
            }}
            QLabel#Title {{
                color: {EY_TEXT};
                font-size: {base_font + 13}px;
                font-weight: 700;
            }}
            QLabel#Subtitle {{
                color: {EY_MUTED};
                font-size: {max(11, base_font - 1)}px;
            }}
            QLabel#SectionTitle {{
                color: {EY_TEXT};
                font-size: {base_font + 2}px;
                font-weight: 700;
                padding-bottom: 8px;
                border-bottom: 1px solid {EY_BORDER};
            }}
            QLabel#FieldLabel {{
                color: {EY_MUTED};
                font-size: {max(11, base_font - 1)}px;
                font-weight: 600;
            }}
            QLineEdit {{
                background: {EY_OFF_BLACK};
                border: 1px solid {EY_BORDER};
                border-radius: 3px;
                color: {EY_TEXT};
                padding: {control_padding}px {control_padding + 2}px;
                selection-background-color: {EY_YELLOW};
                selection-color: {EY_ACCENT_TEXT};
            }}
            QLineEdit:focus {{
                border: 1px solid {EY_YELLOW};
            }}
            QLineEdit[readOnly="true"] {{
                color: {EY_MUTED};
            }}
            QLineEdit::placeholder {{
                color: {EY_PLACEHOLDER};
            }}
            QPushButton {{
                background: {EY_PANEL_ALT};
                color: {EY_TEXT};
                border: 1px solid {EY_BORDER};
                border-radius: 3px;
                padding: {control_padding}px {control_padding + 5}px;
                font-weight: 600;
            }}
            QPushButton:hover {{
                border-color: {EY_YELLOW};
                color: {EY_YELLOW};
            }}
            QPushButton:disabled {{
                color: {palette['disabled_text']};
                border-color: {EY_BORDER};
                background: {palette['disabled_bg']};
            }}
            QPushButton#PrimaryButton {{
                background: {EY_YELLOW};
                color: {EY_ACCENT_TEXT};
                border: 1px solid {EY_YELLOW};
                padding: {control_padding + 4}px {control_padding + 15}px;
                font-size: {base_font + 1}px;
                font-weight: 800;
            }}
            QPushButton#PrimaryButton:hover {{
                background: {EY_YELLOW};
                color: {EY_ACCENT_TEXT};
            }}
            QPushButton#PrimaryButton:disabled {{
                background: {EY_YELLOW};
                color: {EY_ACCENT_TEXT};
                border: 1px solid {EY_YELLOW};
            }}
            QPushButton#SecondaryButton {{
                color: {EY_YELLOW};
                border-color: {EY_YELLOW};
            }}
            QPushButton#NavButton {{
                color: {EY_MUTED};
                border-color: {EY_BORDER};
                padding: {control_padding}px {control_padding + 4}px;
                min-width: 76px;
            }}
            QPushButton#NavButton:hover {{
                color: {EY_YELLOW};
                border-color: {EY_YELLOW};
            }}
            QPushButton#NavButton:checked {{
                background: {palette['selected']};
                color: {EY_YELLOW};
                border-color: {EY_YELLOW};
            }}
            QListWidget {{
                background: {EY_OFF_BLACK};
                border: 1px solid {EY_BORDER};
                border-radius: 3px;
                padding: {control_padding + 1}px;
                outline: none;
            }}
            QListWidget::item {{
                padding: {control_padding + 1}px {control_padding + 3}px;
                margin: 4px;
                border: 1px solid {EY_BORDER};
                border-left: 4px solid transparent;
                border-radius: 3px;
                color: {EY_MUTED};
            }}
            QListWidget::item:hover {{
                background: {palette['hover']};
                border-color: {EY_YELLOW};
            }}
            QListWidget::item:selected {{
                background: {palette['selected']};
                border: 1px solid {EY_YELLOW};
                border-left: 4px solid {EY_YELLOW};
                color: {EY_TEXT};
            }}
            QCheckBox {{
                spacing: 8px;
                color: {EY_TEXT};
            }}
            QCheckBox::indicator {{
                width: 16px;
                height: 16px;
                border: 1px solid {EY_BORDER};
                background: {EY_OFF_BLACK};
            }}
            QCheckBox::indicator:checked {{
                background: {EY_YELLOW};
                border-color: {EY_YELLOW};
            }}
            QCheckBox::indicator:checked:disabled {{
                background: {palette['disabled_text']};
                border-color: {palette['disabled_text']};
            }}
            QCheckBox#SubjectCheckbox {{
                background: {EY_OFF_BLACK};
                border: 1px solid {EY_BORDER};
                border-radius: 3px;
                padding: {control_padding + 1}px {control_padding + 3}px;
                min-height: 32px;
                font-weight: 600;
            }}
            QCheckBox#SubjectCheckbox:hover {{
                border-color: {EY_YELLOW};
                color: {EY_YELLOW};
            }}
            QCheckBox#SubjectCheckbox:checked {{
                background: {palette['selected']};
                border-color: {EY_YELLOW};
                color: {EY_TEXT};
            }}
            QGroupBox {{
                border: 1px solid {EY_BORDER};
                border-radius: 3px;
                margin-top: 12px;
                padding: {control_padding + 7}px {control_padding + 3}px {control_padding + 3}px {control_padding + 3}px;
                color: {EY_MUTED};
                font-weight: 600;
            }}
            QGroupBox::title {{
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 4px;
            }}
            QProgressBar {{
                background: {EY_OFF_BLACK};
                border: 1px solid {EY_BORDER};
                border-radius: 3px;
                color: {EY_TEXT};
                height: 24px;
                text-align: center;
                font-weight: 700;
            }}
            QProgressBar::chunk {{
                background: {EY_YELLOW};
            }}
            QTextEdit {{
                background: {EY_OFF_BLACK};
                border: 1px solid {EY_BORDER};
                border-radius: 3px;
                color: {EY_MUTED};
                padding: {control_padding + 1}px;
                font-family: Consolas, "Courier New", monospace;
                font-size: {max(11, base_font - 1)}px;
            }}
            QTableWidget {{
                background: {EY_OFF_BLACK};
                border: 1px solid {EY_BORDER};
                gridline-color: {EY_BORDER};
                selection-background-color: {palette['selected']};
                selection-color: {EY_TEXT};
            }}
            QHeaderView::section {{
                background: {EY_PANEL_ALT};
                color: {EY_YELLOW};
                border: 1px solid {EY_BORDER};
                padding: {compact_padding}px;
                font-weight: 700;
            }}
            QComboBox {{
                background: {EY_OFF_BLACK};
                border: 1px solid {EY_BORDER};
                border-radius: 3px;
                color: {EY_TEXT};
                padding: {control_padding}px {control_padding + 8}px;
                min-width: 140px;
            }}
            QComboBox:hover, QComboBox:focus {{
                border-color: {EY_YELLOW};
            }}
            QComboBox QAbstractItemView {{
                background: {EY_PANEL};
                color: {EY_TEXT};
                border: 1px solid {EY_BORDER};
                selection-background-color: {palette['selected']};
                selection-color: {EY_TEXT};
                outline: none;
            }}
            QTabWidget::pane {{
                background: {EY_PANEL};
                border: 1px solid {EY_BORDER};
                border-radius: 4px;
            }}
            QTabBar::tab {{
                background: {EY_PANEL_ALT};
                color: {EY_MUTED};
                border: 1px solid {EY_BORDER};
                padding: {control_padding}px {control_padding + 7}px;
                min-width: 90px;
            }}
            QTabBar::tab:selected {{
                background: {palette['selected']};
                color: {EY_TEXT};
                border-color: {EY_YELLOW};
            }}
            QDialog {{
                background: {EY_BLACK};
                color: {EY_TEXT};
            }}
            QLabel#DialogTitle {{
                color: {EY_TEXT};
                font-size: {base_font + 6}px;
                font-weight: 800;
            }}
            QLabel#MutedLabel {{
                color: {EY_MUTED};
            }}
            QLabel#BuildBadge {{
                color: {EY_MUTED};
                background: {EY_PANEL_ALT};
                padding: 6px 10px;
                font-weight: 700;
                border-radius: 4px;
                border: 1px solid {EY_BORDER};
            }}
            QScrollBar:vertical {{
                background: {EY_BLACK};
                width: 8px;
            }}
            QScrollBar::handle:vertical {{
                background: {EY_BORDER};
                min-height: 30px;
            }}
            QScrollBar::handle:vertical:hover {{
                background: {EY_YELLOW};
            }}
            QMessageBox {{
                background: #FFFFFF;
                color: #1F1F29;
                font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
                font-size: 13px;
            }}
            QMessageBox QLabel {{
                background: transparent;
                color: #1F1F29;
                font-size: 13px;
                min-width: 360px;
            }}
            QMessageBox QPushButton {{
                background: #FFE600;
                color: #000000;
                border: 1px solid #C8B800;
                border-radius: 3px;
                padding: 7px 18px;
                min-width: 84px;
                font-weight: 700;
            }}
            QMessageBox QPushButton:hover {{
                background: #FFF166;
                color: #000000;
            }}
            QMenu {{
                background: #FFFFFF;
                color: #111827;
                border: 1px solid #CBD5E1;
                padding: 6px;
                font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
                font-size: 13px;
            }}
            QMenu::item {{
                color: #111827;
                background: transparent;
                padding: 7px 28px 7px 12px;
                min-width: 120px;
            }}
            QMenu::item:selected {{
                background: #D7EBFF;
                color: #0F172A;
            }}
            QMenu::item:disabled {{
                color: #94A3B8;
            }}
            QMenu::separator {{
                height: 1px;
                background: #E2E8F0;
                margin: 5px 4px;
            }}
            QInputDialog {{
                background: #FFFFFF;
                color: #111827;
            }}
            QInputDialog QLabel {{
                color: #111827;
                background: transparent;
                min-width: 260px;
            }}
            QInputDialog QLineEdit {{
                background: #FFFFFF;
                color: #111827;
                border: 1px solid #CBD5E1;
                border-radius: 3px;
                padding: 6px 8px;
                selection-background-color: #D7EBFF;
                selection-color: #0F172A;
            }}
            QInputDialog QPushButton {{
                background: #FFE600;
                color: #000000;
                border: 1px solid #C8B800;
                border-radius: 3px;
                padding: 7px 18px;
                min-width: 76px;
                font-weight: 700;
            }}
            QInputDialog QPushButton:hover {{
                background: #FFF166;
                color: #000000;
            }}
        """

    def create_empty_company(self, name=None):
        default_prior_dir = getattr(self, "user_settings", {}).get("default_prior_dir", "")
        default_output_dir = getattr(self, "user_settings", {}).get("default_output_dir", "")
        return {
            "name": name or f"公司{len(getattr(self, 'project_data', {}).get('companies', [])) + 1}",
            "bs_date": "",
            "functional_currency": "",
            "accounting_standard": "",
            "pm": "",
            "te": "",
            "sad": "",
            "prior_path": default_prior_dir,
            "output_dir": default_output_dir,
            "subjects": [],
            "roll_wording": False,
            "generate_summary": True,
            "cra_source": "文本粘贴 / Excel 复制",
            "cra_canvas_url": "",
            "cra_canvas_endpoint": "",
            "cra_canvas_token": "",
            "cra_text": "",
            "cra_table_records": [],
            "cra_records_stale": False,
            "cra_parser_version": "",
            "apply_cra": False,
            "status": "未处理",
            "generated": 0,
            "failed": 0,
            "last_message": "",
        }

    def create_empty_project(self, name=None, year=""):
        project_count = len(getattr(self, "workbench_data", {}).get("projects", []))
        return {
            "project_name": name or f"项目{project_count + 1}",
            "project_year": year or "",
            "status": "未处理",
            "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "companies": [self.create_empty_company("A公司")],
        }

    def normalize_project_data(self, project):
        if not isinstance(project, dict):
            project = {}
        project.setdefault("project_name", f"项目{len(getattr(self, 'workbench_data', {}).get('projects', [])) + 1}")
        project.setdefault("project_year", "")
        project.setdefault("status", "未处理")
        project.setdefault("updated_at", "")
        companies = project.get("companies")
        if not isinstance(companies, list) or not companies:
            project["companies"] = [self.create_empty_company("A公司")]
        return project

    def load_workbench_data(self):
        try:
            if WORKBENCH_PROJECTS_PATH.exists():
                with open(WORKBENCH_PROJECTS_PATH, "r", encoding="utf-8") as state_file:
                    data = json.load(state_file)
                projects = data.get("projects", [])
                if isinstance(projects, list) and projects:
                    self.workbench_data = {"projects": []}
                    return {"projects": [self.normalize_project_data(project) for project in projects]}
        except Exception:
            pass
        self.workbench_data = {"projects": []}
        return {"projects": [self.create_empty_project("东风项目", "2026")]}

    def save_workbench_data(self):
        try:
            self.save_current_company_from_form()
        except Exception:
            pass
        try:
            APP_STATE_DIR.mkdir(parents=True, exist_ok=True)
            if self.project_data in self.workbench_data.get("projects", []):
                self.project_data["updated_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with open(WORKBENCH_PROJECTS_PATH, "w", encoding="utf-8") as state_file:
                json.dump(self.workbench_data, state_file, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def init_ui(self):
        self.setObjectName("AppRoot")
        root_layout = QVBoxLayout(self)
        root_layout.setContentsMargins(0, 0, 0, 0)

        self.root_scroll = QScrollArea()
        self.root_scroll.setObjectName("RootScroll")
        self.root_scroll.setWidgetResizable(True)
        root_layout.addWidget(self.root_scroll)

        container = QWidget()
        container.setObjectName("Page")
        self.page_container = container
        self.root_scroll.setWidget(container)
        layout = QVBoxLayout(container)
        layout.setContentsMargins(34, 28, 34, 28)
        layout.setSpacing(18)

        self.header_widget = self.create_header()
        self.project_card = self.create_project_card()
        self.parameters_card = self.create_parameters_card()
        self.cra_card = self.create_cra_card()
        self.llm_card = self.create_llm_card()
        self.file_card = self.create_file_card()
        self.subject_card = self.create_subject_card()
        self.action_card = self.create_action_card()
        self.log_card = self.create_log_card()
        self.results_card = self.create_results_card()
        self.company_workspace = self.create_company_workspace()
        self.footer_widget = self.create_footer()
        self.pages = {}
        self.page_stack = CurrentPageStackedWidget()
        self.page_stack.setObjectName("PageStack")

        page_map = {
            "project": [self.project_card],
            "company": [self.company_workspace],
        }
        for key, widgets in page_map.items():
            page = QWidget()
            page.setObjectName("PagePanel")
            page_layout = QVBoxLayout(page)
            page_layout.setContentsMargins(0, 0, 0, 0)
            page_layout.setSpacing(18)
            for widget in widgets:
                page_layout.addWidget(widget)
            page_layout.addStretch()
            self.pages[key] = page
            self.page_stack.addWidget(page)

        layout.addWidget(self.header_widget)
        layout.addWidget(self.page_stack)
        layout.addWidget(self.footer_widget)
        self.refresh_workbench_table()
        self.switch_page("project")
        self.show_project_list()

    def switch_page(self, page_key):
        if not hasattr(self, "pages") or page_key not in self.pages:
            return
        if hasattr(self, "company_input"):
            self.save_current_company_from_form()
            if page_key == "project":
                self.refresh_project_table(select_index=self.current_company_index)
        self.page_stack.setCurrentWidget(self.pages[page_key])
        for key, button in getattr(self, "nav_buttons", {}).items():
            button.setChecked(key == page_key)
        if page_key == "company":
            self.update_company_workspace_header()
        self.root_scroll.verticalScrollBar().setValue(0)

    def switch_workspace_page(self, page_key):
        if not hasattr(self, "workspace_pages") or page_key not in self.workspace_pages:
            return
        self.save_current_company_from_form()
        if page_key == "basic":
            self.load_company_to_form(self.current_company_index)
        self.workspace_stack.setCurrentWidget(self.workspace_pages[page_key])
        for key, button in getattr(self, "workspace_nav_buttons", {}).items():
            button.setChecked(key == page_key)
        self.update_company_workspace_header()
        self.root_scroll.verticalScrollBar().setValue(0)

    def create_header(self):
        header = QWidget()
        header.setObjectName("Header")
        layout = QHBoxLayout(header)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(10)

        mark = QLabel()
        mark.setObjectName("EyMark")
        mark.setFixedSize(64, 64)
        mark.setAlignment(Qt.AlignmentFlag.AlignCenter)
        mark.setStyleSheet("background: transparent; border: none;")
        logo = QPixmap(resource_path(APP_LOGO_PATH))
        if logo.isNull():
            mark.setText("ARF")
            mark.setStyleSheet(
                f"background: {EY_PANEL_ALT}; color: {EY_YELLOW}; "
                "font-size: 22px; font-weight: 800; border-radius: 8px;"
            )
        else:
            mark.setPixmap(
                logo.scaled(
                    64,
                    64,
                    Qt.AspectRatioMode.KeepAspectRatio,
                    Qt.TransformationMode.SmoothTransformation,
                )
            )
        layout.addWidget(mark)

        title_box = QVBoxLayout()
        title_box.setSpacing(3)
        title = QLabel("Audit Roll Forward")
        title.setObjectName("Title")
        subtitle = QLabel("底稿自动结转工具 | 标准模板、上年底稿和基础参数一键生成")
        subtitle.setObjectName("Subtitle")
        title_box.addWidget(title)
        title_box.addWidget(subtitle)
        layout.addLayout(title_box, 1)

        self.nav_buttons = {}
        for page_key, label in (
            ("project", "项目概览"),
        ):
            nav_btn = self.create_browse_btn(label)
            nav_btn.setObjectName("NavButton")
            nav_btn.setCheckable(True)
            nav_btn.setMinimumHeight(42)
            nav_btn.clicked.connect(lambda checked=False, key=page_key: self.switch_page(key))
            self.nav_buttons[page_key] = nav_btn
            layout.addWidget(nav_btn)

        guide_btn = self.create_browse_btn("新手指引")
        guide_btn.setObjectName("SecondaryButton")
        guide_btn.setMinimumHeight(42)
        guide_btn.clicked.connect(lambda: self.show_new_user_guide(mark_shown=True))
        layout.addWidget(guide_btn)

        settings_btn = self.create_browse_btn("⚙ 设置")
        settings_btn.setObjectName("SecondaryButton")
        settings_btn.setMinimumHeight(42)
        settings_btn.clicked.connect(self.show_settings_dialog)
        layout.addWidget(settings_btn)

        badge = QLabel("TEST BUILD")
        badge.setObjectName("BuildBadge")
        badge.setMinimumHeight(42)
        badge.setFixedWidth(88)
        badge.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(badge)
        return header

    def create_card(self, title):
        card = QFrame()
        card.setObjectName("Card")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(18, 16, 18, 18)
        layout.setSpacing(14)

        title_label = QLabel(title)
        title_label.setObjectName("SectionTitle")
        layout.addWidget(title_label)
        return card

    def create_project_card(self):
        card = self.create_card("项目概览")
        layout = QVBoxLayout()
        layout.setSpacing(12)

        self.project_fields_widget = QWidget()
        project_grid = QGridLayout(self.project_fields_widget)
        project_grid.setHorizontalSpacing(12)
        project_grid.setVerticalSpacing(10)
        self.project_name_input = self.create_input("例如：某某集团 2026 年审项目")
        self.project_year_input = self.create_input("例如：2026")
        project_grid.addWidget(self.create_label("项目名称"), 0, 0)
        project_grid.addWidget(self.project_name_input, 0, 1)
        project_grid.addWidget(self.create_label("项目年度"), 0, 2)
        project_grid.addWidget(self.project_year_input, 0, 3)
        layout.addWidget(self.project_fields_widget)

        self.project_detail_title = QLabel("")
        self.project_detail_title.setObjectName("SectionTitle")
        self.project_detail_title.setVisible(False)
        layout.addWidget(self.project_detail_title)

        button_row = QHBoxLayout()
        self.new_project_btn = self.create_browse_btn("新建项目")
        self.save_project_btn = self.create_browse_btn("导出项目")
        self.enter_project_btn = self.create_browse_btn("进入项目")
        self.enter_project_btn.setObjectName("SecondaryButton")
        self.back_project_list_btn = self.create_browse_btn("返回项目列表")
        self.add_company_btn = self.create_browse_btn("添加公司")
        self.delete_company_btn = self.create_browse_btn("删除公司")
        self.enter_company_btn = self.create_browse_btn("进入公司")
        self.enter_company_btn.setObjectName("SecondaryButton")
        self.process_company_btn = self.create_browse_btn("处理选中公司")
        self.process_all_btn = self.create_browse_btn("处理全部公司")
        self.process_all_btn.setObjectName("SecondaryButton")

        self.new_project_btn.clicked.connect(self.new_project)
        self.save_project_btn.clicked.connect(self.save_project)
        self.enter_project_btn.clicked.connect(self.enter_selected_project)
        self.back_project_list_btn.clicked.connect(self.show_project_list)
        self.add_company_btn.clicked.connect(self.add_company)
        self.delete_company_btn.clicked.connect(self.delete_company)
        self.enter_company_btn.clicked.connect(self.enter_selected_company)
        self.process_company_btn.clicked.connect(self.process_selected_company)
        self.process_all_btn.clicked.connect(self.process_all_companies)

        for button in (
            self.new_project_btn,
            self.save_project_btn,
            self.enter_project_btn,
            self.back_project_list_btn,
            self.add_company_btn,
            self.delete_company_btn,
            self.enter_company_btn,
            self.process_company_btn,
            self.process_all_btn,
        ):
            button_row.addWidget(button)
        button_row.addStretch()
        layout.addLayout(button_row)

        self.project_table = QTableWidget(0, 5)
        self.project_table.setHorizontalHeaderLabels(["项目名称", "年度", "公司数", "状态", "最近更新"])
        self.project_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.project_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.project_table.verticalHeader().setVisible(False)
        self.project_table.setMinimumHeight(300)
        self.project_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.project_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self.project_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.project_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.project_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        self.project_table.itemSelectionChanged.connect(self.project_selection_changed)
        self.project_table.itemDoubleClicked.connect(lambda item: self.enter_selected_project())
        self.project_table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.project_table.customContextMenuRequested.connect(self.show_project_context_menu)
        layout.addWidget(self.project_table)

        self.company_table = QTableWidget(0, 7)
        self.company_table.setHorizontalHeaderLabels(["公司", "科目数", "状态", "已生成", "失败", "CRA", "输出路径"])
        self.company_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.company_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.company_table.verticalHeader().setVisible(False)
        self.company_table.setMinimumHeight(360)
        self.company_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.company_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self.company_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.company_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.company_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.ResizeToContents)
        self.company_table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        self.company_table.horizontalHeader().setSectionResizeMode(6, QHeaderView.ResizeMode.Stretch)
        self.company_table.itemSelectionChanged.connect(self.company_selection_changed)
        self.company_table.itemDoubleClicked.connect(lambda item: self.enter_selected_company())
        self.company_table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.company_table.customContextMenuRequested.connect(self.show_company_context_menu)
        layout.addWidget(self.company_table)

        self.project_status_label = QLabel("当前项目未保存")
        self.project_status_label.setStyleSheet(f"color: {EY_MUTED};")
        layout.addWidget(self.project_status_label)

        card.layout().addLayout(layout)
        return card

    def create_company_workspace(self):
        workspace = QWidget()
        layout = QVBoxLayout(workspace)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(14)

        header = QFrame()
        header.setObjectName("Card")
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(16, 12, 16, 12)
        header_layout.setSpacing(10)

        back_btn = self.create_browse_btn("返回项目")
        back_btn.setObjectName("SecondaryButton")
        back_btn.clicked.connect(lambda: self.switch_page("project"))
        self.company_workspace_title = QLabel("当前公司")
        self.company_workspace_title.setObjectName("SectionTitle")
        header_layout.addWidget(back_btn)
        header_layout.addWidget(self.company_workspace_title)
        header_layout.addStretch()
        layout.addWidget(header)

        nav_row = QHBoxLayout()
        nav_row.setSpacing(10)
        self.workspace_nav_buttons = {}
        for page_key, label in (
            ("basic", "基础信息"),
            ("cra", "CRA解析"),
            ("llm", "AI复核"),
            ("logs", "处理日志"),
        ):
            nav_btn = self.create_browse_btn(label)
            nav_btn.setObjectName("NavButton")
            nav_btn.setCheckable(True)
            nav_btn.setMinimumHeight(38)
            nav_btn.clicked.connect(lambda checked=False, key=page_key: self.switch_workspace_page(key))
            self.workspace_nav_buttons[page_key] = nav_btn
            nav_row.addWidget(nav_btn)
        nav_row.addStretch()
        layout.addLayout(nav_row)

        self.workspace_stack = QStackedWidget()
        self.workspace_pages = {}
        workspace_map = {
            "basic": [self.parameters_card, self.file_card, self.subject_card, self.action_card],
            "cra": [self.cra_card],
            "llm": [self.llm_card],
            "logs": [self.results_card, self.log_card],
        }
        for key, widgets in workspace_map.items():
            page = QWidget()
            page_layout = QVBoxLayout(page)
            page_layout.setContentsMargins(0, 0, 0, 0)
            page_layout.setSpacing(18)
            for widget in widgets:
                page_layout.addWidget(widget)
            page_layout.addStretch()
            self.workspace_pages[key] = page
            self.workspace_stack.addWidget(page)
        layout.addWidget(self.workspace_stack)
        self.switch_workspace_page("basic")
        return workspace

    def create_parameters_card(self):
        card = self.create_card("基础参数")
        grid = QGridLayout()
        grid.setHorizontalSpacing(16)
        grid.setVerticalSpacing(12)
        grid.setColumnStretch(1, 3)
        grid.setColumnStretch(3, 3)

        self.company_input = self.create_input("例如：A公司")
        self.date_input = self.create_input("例如：2026/12/31 或 20261231")
        self.functional_currency_input = self.create_input("例如：人民币")
        self.accounting_standard_input = self.create_input("例如：企业会计准则")
        self.pm_input = self.create_input("可选：手工输入 PM")
        self.te_input = self.create_input("可选：手工输入 TE")
        self.sad_input = self.create_input("可选：手工输入 SAD")

        grid.addWidget(self.create_label("公司名称"), 0, 0)
        grid.addWidget(self.company_input, 0, 1)
        grid.addWidget(self.create_label("资产负债表日"), 0, 2)
        grid.addWidget(self.date_input, 0, 3)
        grid.addWidget(self.create_label("记账本位币"), 1, 0)
        grid.addWidget(self.functional_currency_input, 1, 1)
        grid.addWidget(self.create_label("适用会计准则"), 1, 2)
        grid.addWidget(self.accounting_standard_input, 1, 3)
        grid.addWidget(self.create_label("PM"), 2, 0)
        grid.addWidget(self.pm_input, 2, 1)
        grid.addWidget(self.create_label("TE"), 2, 2)
        grid.addWidget(self.te_input, 2, 3)
        grid.addWidget(self.create_label("SAD"), 3, 0)
        grid.addWidget(self.sad_input, 3, 1)

        self.options_group = QGroupBox("处理选项")
        option_layout = QGridLayout(self.options_group)
        option_layout.setHorizontalSpacing(18)
        option_layout.setVerticalSpacing(10)

        self.roll_wording_checkbox = QCheckBox("Roll forward wording / 分析说明 / 调整分录汇总")
        self.roll_wording_checkbox.setToolTip("勾选后会复制上年底稿中的说明文字和调整汇总，并用黄色标注需复核区域。")
        self.generate_summary_checkbox = QCheckBox("生成 Roll Forward Summary")
        self.generate_summary_checkbox.setChecked(True)
        self.generate_summary_checkbox.setToolTip("每个输出底稿附加检查报告工作表，列示更新、标黄和未匹配信息。")

        option_layout.addWidget(self.roll_wording_checkbox, 0, 0)
        option_layout.addWidget(self.generate_summary_checkbox, 0, 1)
        grid.addWidget(self.options_group, 4, 0, 1, 4)

        card.layout().addLayout(grid)
        return card

    def create_llm_card(self):
        card = self.create_card("AI复核")
        layout = QVBoxLayout()
        layout.setSpacing(12)

        self.llm_enhanced_checkbox = QCheckBox("启用 LLM 增强预检 + Review")
        self.llm_enhanced_checkbox.setToolTip("默认关闭。勾选后会执行结构预检并生成LLM Review；需要设置OPENAI_API_KEY。")
        self.llm_wording_checkbox = QCheckBox("允许 LLM 修订已标黄 wording")
        self.llm_wording_checkbox.setToolTip("只允许修改程序已标黄的wording单元格，不修改金额、公式或核心roll forward数据。")

        option_group = QGroupBox("AI复核选项")
        option_layout = QGridLayout(option_group)
        option_layout.setHorizontalSpacing(18)
        option_layout.setVerticalSpacing(10)
        option_layout.addWidget(self.llm_enhanced_checkbox, 0, 0)
        option_layout.addWidget(self.llm_wording_checkbox, 0, 1)

        self.llm_group = QGroupBox("LLM 配置")
        llm_layout = QGridLayout(self.llm_group)
        llm_layout.setHorizontalSpacing(16)
        llm_layout.setVerticalSpacing(10)
        llm_layout.setColumnStretch(1, 3)
        llm_layout.setColumnStretch(3, 3)

        self.llm_api_key_input = self.create_input("可选：留空则读取 OPENAI_API_KEY 环境变量")
        self.llm_api_key_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.llm_model_input = self.create_input("默认：gpt-4o-mini")
        self.llm_base_url_input = self.create_input("默认：https://api.openai.com/v1")
        self.llm_test_status_label = QLabel("未测试")
        self.llm_test_status_label.setStyleSheet(f"color: {EY_MUTED};")

        llm_layout.addWidget(self.create_label("API Key"), 0, 0)
        llm_layout.addWidget(self.llm_api_key_input, 0, 1)
        llm_layout.addWidget(self.create_label("模型"), 0, 2)
        llm_layout.addWidget(self.llm_model_input, 0, 3)
        llm_layout.addWidget(self.create_label("Base URL"), 1, 0)
        llm_layout.addWidget(self.llm_base_url_input, 1, 1, 1, 2)
        self.llm_test_btn = self.create_browse_btn("测试连接")
        self.llm_test_btn.clicked.connect(self.test_llm_connection)
        llm_layout.addWidget(self.llm_test_btn, 1, 3)
        llm_layout.addWidget(self.create_label("连接状态"), 2, 0)
        llm_layout.addWidget(self.llm_test_status_label, 2, 1, 1, 3)

        layout.addWidget(option_group)
        layout.addWidget(self.llm_group)
        card.layout().addLayout(layout)
        return card

    def create_cra_card(self):
        card = self.create_card("CRA 解析")
        layout = QVBoxLayout()
        layout.setSpacing(12)

        self.apply_cra_checkbox = QCheckBox("启用 CRA 写入本次选择的底稿")
        self.apply_cra_checkbox.setToolTip("开启后，仅匹配状态为“将写入”的 CRA 记录会写入输出底稿；预览表不需要逐行勾选。")

        self.apply_cra_checkbox.stateChanged.connect(lambda *_: self.update_execution_cra_status())
        self.cra_records_stale = False

        hint = QLabel(
            "从 CRA Excel 或 Canvas 导出/复制区域粘贴到左侧。解析后右侧会按当前已选择的底稿科目自动判断是否写入。"
        )
        hint.setWordWrap(True)
        hint.setStyleSheet(f"color: {EY_MUTED};")

        split_layout = QHBoxLayout()
        split_layout.setSpacing(14)

        left_panel = QGroupBox("用户粘贴信息")
        left_layout = QVBoxLayout(left_panel)
        left_layout.setSpacing(10)
        cra_source_row = QHBoxLayout()
        self.cra_source_label = QLabel("CRA 数据来源")
        self.cra_source_label.setStyleSheet(f"color: {EY_MUTED};")
        self.cra_source_combo = QComboBox()
        self.cra_source_combo.addItem("文本粘贴 / Excel 复制")
        self.cra_source_combo.addItem("EY Canvas 接入读取")
        self.cra_source_combo.setToolTip("可继续使用已修复的文本解析；EY Canvas 接口待公司开放链接/API 后配置。")
        self.cra_source_combo.currentIndexChanged.connect(self.update_cra_source_mode)
        cra_source_row.addWidget(self.cra_source_label)
        cra_source_row.addWidget(self.cra_source_combo, 1)
        left_layout.addLayout(cra_source_row)

        self.cra_canvas_group = QGroupBox("EY Canvas 接入")
        canvas_layout = QGridLayout(self.cra_canvas_group)
        canvas_layout.setHorizontalSpacing(10)
        canvas_layout.setVerticalSpacing(8)
        self.cra_canvas_url_input = QLineEdit()
        self.cra_canvas_url_input.setPlaceholderText("EY Canvas 页面链接或环境地址")
        self.cra_canvas_endpoint_input = QLineEdit()
        self.cra_canvas_endpoint_input.setPlaceholderText("CRA 数据接口路径，待公司开放后填写")
        self.cra_canvas_token_input = QLineEdit()
        self.cra_canvas_token_input.setPlaceholderText("访问凭证 / Token（可选，按公司安全要求填写）")
        self.cra_canvas_token_input.setEchoMode(QLineEdit.EchoMode.Password)
        self.read_cra_canvas_btn = self.create_browse_btn("读取 Canvas CRA")
        self.read_cra_canvas_btn.clicked.connect(self.read_cra_from_canvas)
        self.cra_canvas_status_label = QLabel("接口未配置")
        self.cra_canvas_status_label.setWordWrap(True)
        self.cra_canvas_status_label.setStyleSheet(f"color: {EY_MUTED};")
        canvas_layout.addWidget(self.create_label("Canvas 链接"), 0, 0)
        canvas_layout.addWidget(self.cra_canvas_url_input, 0, 1, 1, 2)
        canvas_layout.addWidget(self.create_label("接口路径"), 1, 0)
        canvas_layout.addWidget(self.cra_canvas_endpoint_input, 1, 1, 1, 2)
        canvas_layout.addWidget(self.create_label("访问凭证"), 2, 0)
        canvas_layout.addWidget(self.cra_canvas_token_input, 2, 1, 1, 2)
        canvas_layout.addWidget(self.read_cra_canvas_btn, 3, 0)
        canvas_layout.addWidget(self.cra_canvas_status_label, 3, 1, 1, 2)
        self.cra_canvas_group.setVisible(False)
        left_layout.addWidget(self.cra_canvas_group)

        self.cra_text_input = QTextEdit()
        self.cra_text_input.setAcceptRichText(False)
        self.cra_text_input.setPlaceholderText("粘贴 CRA 内容，例如：科目名称\t认定\tCRA\t比例")
        self.cra_text_input.setMinimumHeight(430)
        self.cra_text_input.textChanged.connect(self.cra_input_changed)
        left_layout.addWidget(self.cra_text_input)

        cra_column_row = QHBoxLayout()
        self.cra_column_label = QLabel("CRA 列")
        self.cra_column_label.setStyleSheet(f"color: {EY_MUTED};")
        self.cra_column_combo = QComboBox()
        self.cra_column_combo.addItem("粘贴后自动识别")
        self.cra_column_combo.setEnabled(False)
        self.cra_column_combo.setToolTip("多公司 CRA 表可在这里选择要解析的公司 CRA 列。")
        cra_column_row.addWidget(self.cra_column_label)
        cra_column_row.addWidget(self.cra_column_combo, 1)
        left_layout.addLayout(cra_column_row)

        button_row = QHBoxLayout()
        self.parse_cra_btn = self.create_browse_btn("解析 CRA")
        self.parse_cra_btn.clicked.connect(self.parse_cra_text)
        self.clear_cra_btn = self.create_browse_btn("清空 CRA")
        self.clear_cra_btn.clicked.connect(self.clear_cra_inputs)
        self.cra_status_label = QLabel("未解析")
        self.cra_status_label.setStyleSheet(f"color: {EY_MUTED};")
        button_row.addWidget(self.parse_cra_btn)
        button_row.addWidget(self.clear_cra_btn)
        button_row.addWidget(self.cra_status_label)
        button_row.addStretch()
        left_layout.addLayout(button_row)

        right_panel = QGroupBox("解析信息")
        right_layout = QVBoxLayout(right_panel)
        filter_row = QHBoxLayout()
        filter_row.setSpacing(8)
        self.cra_filter_input = QLineEdit()
        self.cra_filter_input.setPlaceholderText("搜索科目、认定或备注")
        self.cra_filter_input.setClearButtonEnabled(True)
        self.cra_filter_input.textChanged.connect(self.apply_cra_table_filters)
        self.cra_subject_filter = QComboBox()
        self.cra_subject_filter.addItem("全部底稿科目", "__all__")
        self.cra_subject_filter.currentIndexChanged.connect(self.apply_cra_table_filters)
        self.cra_status_filter = QComboBox()
        self.cra_status_filter.addItem("全部状态", "__all__")
        self.cra_status_filter.addItem("将写入", "write")
        self.cra_status_filter.addItem("需确认", "confirm")
        self.cra_status_filter.addItem("不写入", "skip")
        self.cra_status_filter.currentIndexChanged.connect(self.apply_cra_table_filters)
        self.cra_exception_filter = QCheckBox("只看异常")
        self.cra_exception_filter.stateChanged.connect(self.apply_cra_table_filters)
        filter_row.addWidget(self.cra_filter_input, 2)
        filter_row.addWidget(self.cra_subject_filter, 1)
        filter_row.addWidget(self.cra_status_filter, 1)
        filter_row.addWidget(self.cra_exception_filter)
        right_layout.addLayout(filter_row)

        self.cra_table = QTableWidget(0, 9)
        self.cra_table.setHorizontalHeaderLabels([
            "匹配状态",
            "底稿科目",
            "CRA科目名称",
            "认定",
            "CRA",
            "比例",
            "比例状态",
            "区间检查",
            "备注",
        ])
        self.cra_table.setEditTriggers(
            QTableWidget.EditTrigger.DoubleClicked
            | QTableWidget.EditTrigger.EditKeyPressed
            | QTableWidget.EditTrigger.SelectedClicked
        )
        self.cra_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.cra_table.setSortingEnabled(True)
        self.cra_table.horizontalHeader().setSortIndicatorShown(True)
        self.cra_table.verticalHeader().setVisible(False)
        self.cra_table.setMinimumHeight(430)
        self.cra_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self.cra_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self.cra_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.cra_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.cra_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.ResizeToContents)
        self.cra_table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        self.cra_table.horizontalHeader().setSectionResizeMode(6, QHeaderView.ResizeMode.Stretch)
        self.cra_table.horizontalHeader().setSectionResizeMode(7, QHeaderView.ResizeMode.Stretch)
        self.cra_table.horizontalHeader().setSectionResizeMode(8, QHeaderView.ResizeMode.Stretch)
        self.cra_table.itemChanged.connect(self.cra_table_item_changed)
        right_layout.addWidget(self.cra_table)

        split_layout.addWidget(left_panel, 1)
        split_layout.addWidget(right_panel, 2)

        layout.addWidget(self.apply_cra_checkbox)
        layout.addWidget(hint)
        layout.addLayout(split_layout)
        card.layout().addLayout(layout)
        return card

    def create_file_card(self):
        card = self.create_card("文件路径")
        layout = QGridLayout()
        layout.setHorizontalSpacing(12)
        layout.setVerticalSpacing(12)
        layout.setColumnStretch(1, 1)

        self.prior_dir_input = self.create_file_input("请选择上年底稿目录，或粘贴/选择单个上年底稿文件")
        self.prior_dir_input.editingFinished.connect(self.auto_select_subjects_from_prior_input)
        self.output_dir_input = self.create_file_input("请选择输出目录")

        self.prior_dir_btn = self.create_browse_btn("选择目录")
        self.prior_dir_btn.clicked.connect(self.browse_prior_dir)
        self.prior_file_btn = self.create_browse_btn("选择文件")
        self.prior_file_btn.clicked.connect(self.browse_prior_file)
        output_btn = self.create_browse_btn("选择目录")
        output_btn.clicked.connect(self.browse_output_dir)

        layout.addWidget(self.create_label("上年底稿目录/文件"), 0, 0)
        layout.addWidget(self.prior_dir_input, 0, 1)
        layout.addWidget(self.prior_dir_btn, 0, 2)
        layout.addWidget(self.prior_file_btn, 0, 3)
        layout.addWidget(self.create_label("输出目录"), 1, 0)
        layout.addWidget(self.output_dir_input, 1, 1, 1, 2)
        layout.addWidget(output_btn, 1, 3)

        card.layout().addLayout(layout)
        return card

    def create_subject_card(self):
        card = self.create_card("科目选择")
        layout = QVBoxLayout()
        layout.setSpacing(12)

        self.subject_checkboxes = {}
        subject_grid = QGridLayout()
        subject_grid.setHorizontalSpacing(12)
        subject_grid.setVerticalSpacing(10)
        subject_grid.setColumnStretch(0, 1)
        subject_grid.setColumnStretch(1, 1)
        subject_grid.setColumnStretch(2, 1)

        try:
            config_manager = SubjectConfig()
            for index, (code, name) in enumerate(config_manager.get_subject_list()):
                checkbox = QCheckBox(f"{code}    {name}")
                checkbox.setObjectName("SubjectCheckbox")
                checkbox.setMinimumHeight(44)
                self.subject_checkboxes[code] = checkbox
                subject_grid.addWidget(checkbox, index // 3, index % 3)
        except Exception as exc:
            error_label = QLabel(f"加载失败: {exc}")
            error_label.setStyleSheet(f"color: {EY_ERROR};")
            subject_grid.addWidget(error_label, 0, 0, 1, 3)

        button_row = QHBoxLayout()
        select_all_btn = self.create_browse_btn("全选 / 取消")
        select_all_btn.setObjectName("SecondaryButton")
        select_all_btn.clicked.connect(self.toggle_select_all)
        button_row.addWidget(select_all_btn)
        button_row.addStretch()

        layout.addLayout(subject_grid)
        layout.addLayout(button_row)
        card.layout().addLayout(layout)
        return card

    def create_action_card(self):
        card = self.create_card("执行")
        layout = QVBoxLayout()
        layout.setSpacing(12)

        button_row = QHBoxLayout()
        button_row.setSpacing(12)
        self.start_btn = QPushButton("开始处理")
        self.start_btn.setObjectName("PrimaryButton")
        self.start_btn.setMinimumHeight(52)
        self.start_btn.clicked.connect(self.start_processing)
        self.clear_btn = QPushButton("一键清空")
        self.clear_btn.setObjectName("SecondaryButton")
        self.clear_btn.clicked.connect(self.clear_form)
        self.pause_btn = QPushButton("暂停")
        self.pause_btn.setObjectName("SecondaryButton")
        self.pause_btn.setEnabled(False)
        self.pause_btn.clicked.connect(self.toggle_pause_processing)
        self.stop_btn = QPushButton("终止")
        self.stop_btn.setObjectName("SecondaryButton")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self.request_stop_processing)
        self.execution_cra_status_label = QLabel("CRA：未解析")
        self.execution_cra_status_label.setWordWrap(True)
        self.execution_cra_status_label.setStyleSheet(f"color: {EY_MUTED};")
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)

        button_row.addWidget(self.start_btn, 3)
        button_row.addWidget(self.pause_btn, 1)
        button_row.addWidget(self.stop_btn, 1)
        button_row.addWidget(self.clear_btn, 1)
        layout.addLayout(button_row)
        layout.addWidget(self.execution_cra_status_label)
        layout.addWidget(self.progress_bar)
        card.layout().addLayout(layout)
        return card

    def create_log_card(self):
        card = self.create_card("处理日志")
        self.log_output = QTextEdit()
        self.log_output.setReadOnly(True)
        self.log_output.setPlaceholderText("等待处理...")
        self.log_output.setMaximumHeight(190)
        card.layout().addWidget(self.log_output)
        return card

    def create_results_card(self):
        card = self.create_card("处理结果")
        self.results_table = QTableWidget(0, 6)
        self.results_table.setHorizontalHeaderLabels(["科目", "状态", "输出文件", "Warnings", "Wording 匹配数量", "LLM改写数"])
        self.results_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.results_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.results_table.verticalHeader().setVisible(False)
        self.results_table.setMinimumHeight(170)
        self.results_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self.results_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self.results_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.results_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        self.results_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.ResizeToContents)
        self.results_table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        card.layout().addWidget(self.results_table)
        return card

    def create_footer(self):
        footer = QWidget()
        layout = QHBoxLayout(footer)
        layout.setContentsMargins(0, 4, 0, 0)
        left = QLabel("READY | Audit Roll Forward test build")
        left.setStyleSheet(f"color: {EY_MUTED}; font-size: 11px;")
        right = QLabel("EY black / yellow theme")
        right.setStyleSheet(f"color: {EY_MUTED}; font-size: 11px;")
        self.feedback_link = QLabel(
            f'<a href="{FEEDBACK_URL}" style="color: {EY_YELLOW}; text-decoration: none;">意见反馈</a>'
        )
        self.feedback_link.setObjectName("FeedbackLink")
        self.feedback_link.setOpenExternalLinks(True)
        self.feedback_link.setToolTip("打开使用反馈问卷")
        layout.addWidget(left)
        layout.addStretch()
        layout.addWidget(right)
        layout.addSpacing(12)
        layout.addWidget(self.feedback_link)
        return footer

    def create_label(self, text):
        label = QLabel(text)
        label.setObjectName("FieldLabel")
        return label

    def create_input(self, placeholder):
        line_edit = QLineEdit()
        line_edit.setPlaceholderText(placeholder)
        return line_edit

    def create_file_input(self, placeholder):
        line_edit = QLineEdit()
        line_edit.setPlaceholderText(placeholder)
        line_edit.setReadOnly(False)
        return line_edit

    def create_browse_btn(self, text):
        return QPushButton(text)

    def show_project_context_menu(self, position):
        if getattr(self, "project_view_mode", "list") != "list":
            return
        row = self.project_table.rowAt(position.y())
        has_row = row >= 0
        if has_row:
            self.project_table.selectRow(row)
            self.current_project_index = row
            projects = self.workbench_data.setdefault("projects", [])
            if row < len(projects):
                self.project_data = projects[row]

        menu = QMenu(self)
        new_action = QAction("新建项目", self)
        enter_action = QAction("进入项目", self)
        edit_action = QAction("编辑项目", self)
        delete_action = QAction("删除项目", self)
        export_action = QAction("导出项目", self)
        enter_action.setEnabled(has_row)
        edit_action.setEnabled(has_row)
        delete_action.setEnabled(has_row)
        export_action.setEnabled(has_row)

        new_action.triggered.connect(self.new_project)
        enter_action.triggered.connect(self.enter_selected_project)
        edit_action.triggered.connect(self.edit_selected_project)
        delete_action.triggered.connect(self.delete_company)
        export_action.triggered.connect(self.save_project)

        menu.addAction(new_action)
        menu.addSeparator()
        menu.addAction(enter_action)
        menu.addAction(edit_action)
        menu.addAction(export_action)
        menu.addAction(delete_action)
        menu.exec(self.project_table.viewport().mapToGlobal(position))

    def show_company_context_menu(self, position):
        if getattr(self, "project_view_mode", "list") != "detail":
            return
        row = self.company_table.rowAt(position.y())
        has_row = row >= 0
        if has_row:
            self.company_table.selectRow(row)
            self.current_company_index = row

        menu = QMenu(self)
        new_action = QAction("新建公司", self)
        enter_action = QAction("进入公司", self)
        edit_action = QAction("编辑公司名称", self)
        process_action = QAction("处理公司", self)
        delete_action = QAction("删除公司", self)
        enter_action.setEnabled(has_row)
        edit_action.setEnabled(has_row)
        process_action.setEnabled(has_row)
        delete_action.setEnabled(has_row)

        new_action.triggered.connect(self.add_company)
        enter_action.triggered.connect(self.enter_selected_company)
        edit_action.triggered.connect(self.edit_selected_company_name)
        process_action.triggered.connect(self.process_selected_company)
        delete_action.triggered.connect(self.delete_company)

        menu.addAction(new_action)
        menu.addSeparator()
        menu.addAction(enter_action)
        menu.addAction(edit_action)
        menu.addAction(process_action)
        menu.addAction(delete_action)
        menu.exec(self.company_table.viewport().mapToGlobal(position))

    def edit_selected_project(self):
        projects = self.workbench_data.setdefault("projects", [])
        row = self.project_table.currentRow() if hasattr(self, "project_table") else self.current_project_index
        if row < 0 or row >= len(projects):
            return
        project = projects[row]
        current_name = project.get("project_name", f"项目{row + 1}")
        name, ok = QInputDialog.getText(self, "编辑项目", "项目名称", text=current_name)
        if not ok:
            return
        name = name.strip()
        if not name:
            QMessageBox.information(self, "提示", "项目名称不能为空。")
            return
        project["project_name"] = name
        project["updated_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.current_project_index = row
        self.project_data = project
        try:
            APP_STATE_DIR.mkdir(parents=True, exist_ok=True)
            with open(WORKBENCH_PROJECTS_PATH, "w", encoding="utf-8") as state_file:
                json.dump(self.workbench_data, state_file, ensure_ascii=False, indent=2)
        except Exception:
            pass
        self.refresh_workbench_table(select_index=row)

    def edit_selected_company_name(self):
        companies = self.project_data.setdefault("companies", [])
        row = self.company_table.currentRow() if hasattr(self, "company_table") else self.current_company_index
        if row < 0 or row >= len(companies):
            return
        company = companies[row]
        current_name = company.get("name", f"公司{row + 1}")
        name, ok = QInputDialog.getText(self, "编辑公司名称", "公司名称", text=current_name)
        if not ok:
            return
        name = name.strip()
        if not name:
            QMessageBox.information(self, "提示", "公司名称不能为空。")
            return
        company["name"] = name
        self.current_company_index = row
        if row == self.current_company_index and hasattr(self, "company_input"):
            self.company_input.setText(name)
        self.save_workbench_data()
        self.refresh_project_table(select_index=row)
        self.update_company_workspace_header()

    def refresh_workbench_table(self, select_index=None):
        if not hasattr(self, "project_table"):
            return
        projects = self.workbench_data.setdefault("projects", [])
        self.project_table.blockSignals(True)
        self.project_table.setRowCount(len(projects))
        for row, project in enumerate(projects):
            values = [
                project.get("project_name", f"项目{row + 1}"),
                project.get("project_year", ""),
                str(len(project.get("companies", []))),
                project.get("status", "未处理"),
                project.get("updated_at", ""),
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(str(value or ""))
                self.project_table.setItem(row, col, item)
        target = self.current_project_index if select_index is None else select_index
        if projects:
            target = max(0, min(target, len(projects) - 1))
            self.project_table.selectRow(target)
        self.project_table.blockSignals(False)

    def show_project_list(self):
        self.save_workbench_data()
        self.project_view_mode = "list"
        self.project_fields_widget.setVisible(True)
        self.project_detail_title.setVisible(False)
        self.project_table.setVisible(True)
        self.company_table.setVisible(False)
        self.project_name_input.clear()
        self.project_year_input.clear()
        self.project_name_input.setPlaceholderText("输入项目名称后点击新建项目，例如：东风项目")
        self.project_year_input.setPlaceholderText("例如：2026")
        self.new_project_btn.setVisible(True)
        self.save_project_btn.setVisible(True)
        self.enter_project_btn.setVisible(True)
        self.back_project_list_btn.setVisible(False)
        self.add_company_btn.setVisible(False)
        self.delete_company_btn.setText("删除项目")
        self.enter_company_btn.setVisible(False)
        self.process_company_btn.setVisible(False)
        self.process_all_btn.setVisible(False)
        self.project_status_label.setText("工作台项目列表会自动保存到本地")
        self.refresh_workbench_table(select_index=self.current_project_index)

    def show_project_detail(self):
        self.project_view_mode = "detail"
        self.project_fields_widget.setVisible(False)
        project_name = self.project_data.get("project_name", "") or "未命名项目"
        project_year = self.project_data.get("project_year", "") or "未填写年度"
        self.project_detail_title.setText(f"当前项目：{project_name}    年度：{project_year}")
        self.project_detail_title.setVisible(True)
        self.project_table.setVisible(False)
        self.company_table.setVisible(True)
        self.new_project_btn.setVisible(False)
        self.save_project_btn.setVisible(False)
        self.enter_project_btn.setVisible(False)
        self.back_project_list_btn.setVisible(True)
        self.add_company_btn.setVisible(True)
        self.delete_company_btn.setText("删除公司")
        self.enter_company_btn.setVisible(True)
        self.process_company_btn.setVisible(True)
        self.process_all_btn.setVisible(True)
        self.refresh_project_table(select_index=self.current_company_index)

    def project_selection_changed(self):
        if not hasattr(self, "project_table") or not self.project_table.selectedItems():
            return
        row = self.project_table.currentRow()
        if row >= 0:
            if row != self.current_project_index:
                self.current_company_index = 0
            self.current_project_index = row
            projects = self.workbench_data.setdefault("projects", [])
            if row < len(projects):
                self.project_data = projects[row]

    def enter_selected_project(self):
        projects = self.workbench_data.setdefault("projects", [])
        if not projects:
            self.new_project()
            return
        row = self.project_table.currentRow() if hasattr(self, "project_table") else self.current_project_index
        if row < 0:
            row = self.current_project_index
        self.current_project_index = max(0, min(row, len(projects) - 1))
        self.project_data = projects[self.current_project_index]
        companies = self.project_data.get("companies", [])
        self.current_company_index = max(0, min(self.current_company_index, max(len(companies) - 1, 0)))
        self.load_company_to_form(self.current_company_index)
        self.show_project_detail()

    def current_company(self):
        companies = self.project_data.setdefault("companies", [])
        if not companies:
            companies.append(self.create_empty_company("A公司"))
        self.current_company_index = max(0, min(self.current_company_index, len(companies) - 1))
        return companies[self.current_company_index]

    def save_current_company_from_form(self):
        if not hasattr(self, "company_input"):
            return
        companies = self.project_data.setdefault("companies", [])
        if not companies:
            return
        index = max(0, min(self.current_company_index, len(companies) - 1))
        company = companies[index]
        prior_path = self.prior_dir_input.text().strip() or company.get("prior_path", "")
        output_dir = self.output_dir_input.text().strip() or company.get("output_dir", "")
        company.update({
            "name": self.company_input.text().strip() or company.get("name") or f"公司{index + 1}",
            "bs_date": self.date_input.text().strip(),
            "functional_currency": self.functional_currency_input.text().strip(),
            "accounting_standard": self.accounting_standard_input.text().strip(),
            "pm": self.pm_input.text().strip(),
            "te": self.te_input.text().strip(),
            "sad": self.sad_input.text().strip(),
            "prior_path": prior_path,
            "output_dir": output_dir,
            "subjects": self.selected_subject_codes(),
            "roll_wording": self.roll_wording_checkbox.isChecked(),
            "generate_summary": self.generate_summary_checkbox.isChecked(),
            "cra_source": self.cra_source_combo.currentText() if hasattr(self, "cra_source_combo") else "文本粘贴 / Excel 复制",
            "cra_canvas_url": self.cra_canvas_url_input.text().strip() if hasattr(self, "cra_canvas_url_input") else "",
            "cra_canvas_endpoint": self.cra_canvas_endpoint_input.text().strip() if hasattr(self, "cra_canvas_endpoint_input") else "",
            "cra_canvas_token": self.cra_canvas_token_input.text().strip() if hasattr(self, "cra_canvas_token_input") else "",
            "cra_text": self.cra_text_input.toPlainText(),
            "cra_table_records": self.collect_cra_table_records(include_all=True) if hasattr(self, "cra_table") else company.get("cra_table_records", []),
            "cra_records_stale": bool(getattr(self, "cra_records_stale", False)),
            "cra_parser_version": (
                CRA_PARSER_VERSION
                if not getattr(self, "cra_records_stale", False) and hasattr(self, "cra_table") and self.cra_table.rowCount()
                else company.get("cra_parser_version", "")
            ),
            "apply_cra": self.apply_cra_checkbox.isChecked(),
        })
        if hasattr(self, "project_name_input") and getattr(self, "project_view_mode", "detail") != "list":
            self.project_data["project_name"] = self.project_name_input.text().strip()
            self.project_data["project_year"] = self.project_year_input.text().strip()

    def load_company_to_form(self, index):
        companies = self.project_data.setdefault("companies", [])
        if not companies or not hasattr(self, "company_input"):
            return
        self.current_company_index = max(0, min(index, len(companies) - 1))
        company = companies[self.current_company_index]
        self.company_input.setText(company.get("name", ""))
        self.date_input.setText(company.get("bs_date", ""))
        self.functional_currency_input.setText(company.get("functional_currency", ""))
        self.accounting_standard_input.setText(company.get("accounting_standard", ""))
        self.pm_input.setText(company.get("pm", ""))
        self.te_input.setText(company.get("te", ""))
        self.sad_input.setText(company.get("sad", ""))
        self.prior_dir_input.setText(company.get("prior_path", ""))
        self.output_dir_input.setText(company.get("output_dir", ""))
        self.roll_wording_checkbox.setChecked(bool(company.get("roll_wording", False)))
        self.generate_summary_checkbox.setChecked(bool(company.get("generate_summary", True)))
        selected = set(company.get("subjects", []))
        for code, checkbox in getattr(self, "subject_checkboxes", {}).items():
            checkbox.setChecked(code in selected)
        if hasattr(self, "cra_source_combo"):
            source = company.get("cra_source", "文本粘贴 / Excel 复制")
            source_index = self.cra_source_combo.findText(source)
            self.cra_source_combo.setCurrentIndex(source_index if source_index >= 0 else 0)
            self.cra_canvas_url_input.setText(company.get("cra_canvas_url", ""))
            self.cra_canvas_endpoint_input.setText(company.get("cra_canvas_endpoint", ""))
            self.cra_canvas_token_input.setText(company.get("cra_canvas_token", ""))
            self.update_cra_source_mode()
        self.cra_text_input.blockSignals(True)
        self.cra_text_input.setPlainText(company.get("cra_text", ""))
        self.cra_text_input.blockSignals(False)
        saved_cra_records = company.get("cra_table_records") or []
        parser_version_stale = bool(
            saved_cra_records
            and company.get("cra_parser_version", "") != CRA_PARSER_VERSION
        )
        self.cra_records_stale = bool(company.get("cra_records_stale", False)) or parser_version_stale
        self.apply_cra_checkbox.setEnabled(not self.cra_records_stale)
        self.apply_cra_checkbox.setChecked(bool(company.get("apply_cra", False)) and not self.cra_records_stale)
        self.cra_table.setRowCount(0)
        if saved_cra_records:
            self.populate_cra_table(saved_cra_records)
            write_count = sum(1 for record in saved_cra_records if record.get("match_status") == "将写入")
            if self.cra_records_stale:
                self.cra_status_label.setText("内容已变化，请重新解析；右侧旧结果仅供对照")
                self.cra_status_label.setStyleSheet(f"color: {EY_YELLOW};")
            else:
                self.cra_status_label.setText(f"已保留 {len(saved_cra_records)} 条 CRA 解析记录，{write_count} 条将写入")
                self.cra_status_label.setStyleSheet(f"color: {EY_SUCCESS};")
        else:
            self.cra_status_label.setText("内容已变化，请重新解析" if self.cra_records_stale else "未解析")
            self.cra_status_label.setStyleSheet(f"color: {EY_YELLOW if self.cra_records_stale else EY_MUTED};")
        self.update_execution_cra_status()
        self.refresh_project_table(select_index=self.current_company_index)

    def refresh_project_table(self, select_index=None):
        if not hasattr(self, "company_table"):
            return
        if hasattr(self, "project_name_input"):
            self.project_name_input.setText(self.project_data.get("project_name", ""))
            self.project_year_input.setText(self.project_data.get("project_year", ""))
        companies = self.project_data.setdefault("companies", [])
        self.company_table.blockSignals(True)
        self.company_table.setRowCount(len(companies))
        for row, company in enumerate(companies):
            cra_state = "已粘贴" if str(company.get("cra_text", "")).strip() else "未提供"
            values = [
                company.get("name", f"公司{row + 1}"),
                str(len(company.get("subjects", []))),
                company.get("status", "未处理"),
                str(company.get("generated", 0)),
                str(company.get("failed", 0)),
                cra_state,
                company.get("output_dir", ""),
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(str(value or ""))
                if col == 2:
                    status = str(value)
                    if "成功" in status or status == "已完成":
                        item.setForeground(QColor(EY_SUCCESS))
                    elif "失败" in status:
                        item.setForeground(QColor(EY_ERROR))
                    elif "处理中" in status:
                        item.setForeground(QColor(EY_YELLOW))
                self.company_table.setItem(row, col, item)
        target = self.current_company_index if select_index is None else select_index
        if companies:
            target = max(0, min(target, len(companies) - 1))
            self.company_table.selectRow(target)
        self.company_table.blockSignals(False)
        self.project_status_label.setText("当前项目会自动保存到本地；如需共享，请使用“导出项目”。")

    def company_selection_changed(self):
        if not hasattr(self, "company_table") or not self.company_table.selectedItems():
            return
        row = self.company_table.currentRow()
        if row < 0 or row == self.current_company_index:
            return
        self.save_current_company_from_form()
        self.load_company_to_form(row)

    def update_company_workspace_header(self):
        if not hasattr(self, "company_workspace_title"):
            return
        company = self.current_company()
        project_name = self.project_data.get("project_name") or "未命名项目"
        self.company_workspace_title.setText(f"当前公司：{company.get('name', '')}    项目：{project_name}")

    def enter_selected_company(self):
        row = self.company_table.currentRow() if hasattr(self, "company_table") else self.current_company_index
        if row < 0:
            row = self.current_company_index
        self.save_current_company_from_form()
        self.load_company_to_form(row)
        self.switch_page("company")
        self.switch_workspace_page("basic")

    def new_project(self):
        if self.worker and self.worker.isRunning():
            QMessageBox.information(self, "提示", "当前正在处理，请等待完成后再新建项目。")
            return
        name = self.project_name_input.text().strip() or f"项目{len(self.workbench_data.get('projects', [])) + 1}"
        year = self.project_year_input.text().strip()
        project = self.create_empty_project(name, year)
        self.workbench_data.setdefault("projects", []).append(project)
        self.current_project_index = len(self.workbench_data["projects"]) - 1
        self.project_data = project
        self.current_company_index = 0
        self.load_company_to_form(0)
        self.save_workbench_data()
        self.project_name_input.clear()
        self.project_year_input.clear()
        self.show_project_list()
        self.refresh_workbench_table(select_index=self.current_project_index)

    def add_company(self):
        self.save_current_company_from_form()
        companies = self.project_data.setdefault("companies", [])
        companies.append(self.create_empty_company(f"公司{len(companies) + 1}"))
        self.load_company_to_form(len(companies) - 1)
        self.save_workbench_data()
        self.switch_page("company")
        self.switch_workspace_page("basic")

    def delete_company(self):
        if getattr(self, "project_view_mode", "detail") == "list":
            projects = self.workbench_data.setdefault("projects", [])
            if len(projects) <= 1:
                QMessageBox.information(self, "提示", "工作台中至少保留一个项目。")
                return
            row = self.project_table.currentRow()
            if row < 0:
                row = self.current_project_index
            removed = projects.pop(row)
            self.current_project_index = max(0, min(row, len(projects) - 1))
            self.project_data = projects[self.current_project_index]
            self.current_company_index = 0
            self.save_workbench_data()
            self.show_project_list()
            self.log_output.append(f">>> 已删除项目: {removed.get('project_name', '')}")
            return

        companies = self.project_data.setdefault("companies", [])
        if len(companies) <= 1:
            QMessageBox.information(self, "提示", "项目中至少保留一个公司。")
            return
        row = self.company_table.currentRow()
        if row < 0:
            row = self.current_company_index
        removed = companies.pop(row)
        self.current_company_index = max(0, min(row, len(companies) - 1))
        self.load_company_to_form(self.current_company_index)
        self.refresh_project_table(select_index=self.current_company_index)
        self.log_output.append(f">>> 已删除公司: {removed.get('name', '')}")
        self.save_workbench_data()

    def save_project(self):
        if getattr(self, "project_view_mode", "detail") == "detail":
            self.save_current_company_from_form()
        else:
            projects = self.workbench_data.setdefault("projects", [])
            row = self.project_table.currentRow() if hasattr(self, "project_table") else self.current_project_index
            if 0 <= row < len(projects):
                self.current_project_index = row
                self.project_data = projects[row]
        path, _ = QFileDialog.getSaveFileName(
            self,
            "导出项目",
            str(Path.home() / f"{self.project_data.get('project_name', 'AuditRollForward')}.auditproj"),
            "Audit Roll Forward 项目 (*.auditproj);;JSON 文件 (*.json)",
        )
        if not path:
            return
        if not path.lower().endswith((".auditproj", ".json")):
            path += ".auditproj"
        with open(path, "w", encoding="utf-8") as project_file:
            json.dump(self.project_data, project_file, ensure_ascii=False, indent=2)
        self.save_workbench_data()
        self.refresh_project_table()
        QMessageBox.information(self, "导出项目", f"项目已导出：{path}")

    def selected_subject_codes(self):
        return [
            code for code, checkbox in getattr(self, "subject_checkboxes", {}).items()
            if checkbox.isChecked()
        ]

    def current_company_key(self, company_index=None):
        if company_index is None:
            company_index = self.current_company_index
        project_name = self.project_data.get("project_name", "")
        return (self.current_project_index, company_index, project_name)

    def cra_input_changed(self):
        if hasattr(self, "cra_skip_confirmed_companies"):
            self.cra_skip_confirmed_companies.discard(self.current_company_key())
        has_text = bool(self.cra_text_input.toPlainText().strip()) if hasattr(self, "cra_text_input") else False
        has_preview = bool(self.cra_table.rowCount()) if hasattr(self, "cra_table") else False
        self.cra_records_stale = has_text or has_preview
        if hasattr(self, "apply_cra_checkbox"):
            self.apply_cra_checkbox.setChecked(False)
            self.apply_cra_checkbox.setEnabled(not self.cra_records_stale)
        if hasattr(self, "cra_status_label"):
            if self.cra_records_stale:
                suffix = "；右侧旧结果仅供对照" if has_preview else ""
                self.cra_status_label.setText(f"内容已变化，请重新解析{suffix}")
                self.cra_status_label.setStyleSheet(f"color: {EY_YELLOW};")
            else:
                self.cra_status_label.setText("未解析")
                self.cra_status_label.setStyleSheet(f"color: {EY_MUTED};")
        if hasattr(self, "execution_cra_status_label"):
            self.update_execution_cra_status()

    def cra_records_for_company(self, company, subject_codes=None):
        if company is self.current_company() and getattr(self, "cra_records_stale", False):
            return []
        if company is not self.current_company():
            stored_records = company.get("cra_table_records") or []
            if company.get("cra_records_stale", False) or (
                stored_records and company.get("cra_parser_version", "") != CRA_PARSER_VERSION
            ):
                return []
        if hasattr(self, "cra_table") and company is self.current_company():
            return self.collect_cra_table_records(include_all=True)
        table_records = company.get("cra_table_records") or []
        if table_records:
            return table_records
        text = str(company.get("cra_text", "")).strip()
        if not text and hasattr(self, "cra_text_input"):
            text = self.cra_text_input.toPlainText().strip()
        subject_codes = subject_codes or list(company.get("subjects", []))
        if not text:
            return []
        cra_column = ""
        if hasattr(self, "cra_column_combo") and self.cra_column_combo.isEnabled():
            current = self.cra_column_combo.currentText()
            if current and "自动" not in current and "仅检测到" not in current:
                cra_column = current
        return parse_cra_paste_text(text, subject_codes, cra_column)

    def describe_cra_state(self, company=None, company_index=None):
        if company is None:
            companies = self.project_data.get("companies", [])
            if not companies:
                return {"status": "CRA：未解析", "records": [], "write_records": [], "text": ""}
            company_index = self.current_company_index if company_index is None else company_index
            company = companies[max(0, min(company_index, len(companies) - 1))]
        subject_codes = list(company.get("subjects", []))
        text = str(company.get("cra_text", "")).strip()
        is_current_company = company_index is None or company_index == self.current_company_index
        records_stale = (
            bool(getattr(self, "cra_records_stale", False))
            if is_current_company
            else bool(company.get("cra_records_stale", False)) or bool(
                company.get("cra_table_records")
                and company.get("cra_parser_version", "") != CRA_PARSER_VERSION
            )
        )
        if company_index is None or company_index == self.current_company_index:
            if hasattr(self, "cra_text_input"):
                text = self.cra_text_input.toPlainText().strip()
                records = self.collect_cra_table_records(include_all=True) if hasattr(self, "cra_table") else []
            else:
                records = company.get("cra_table_records") or []
        else:
            records = company.get("cra_table_records") or []
        if records_stale:
            records = []
        if not records and text:
            if not records_stale:
                records = self.cra_records_for_company({**company, "cra_text": text}, subject_codes)
        write_records = [record for record in records if record.get("match_status") == "将写入"]
        selected = set(subject_codes)
        matched = {record.get("subject_code") for record in write_records if record.get("subject_code")}
        missing = [code for code in subject_codes if code not in matched]
        apply_enabled = bool(company.get("apply_cra", False))
        if company_index is None or company_index == self.current_company_index:
            apply_enabled = self.apply_cra_checkbox.isChecked() if hasattr(self, "apply_cra_checkbox") else apply_enabled
        skip_confirmed = self.current_company_key(company_index) in getattr(self, "cra_skip_confirmed_companies", set())
        if records_stale:
            status = "CRA：内容已变化，请重新解析"
        elif skip_confirmed:
            status = "CRA：本次明确不使用"
        elif not text and not records:
            status = "CRA：未解析"
        elif not records:
            status = "CRA：已粘贴，未解析到有效记录"
        elif not apply_enabled:
            status = f"CRA：已解析 {len(records)} 条，但未启用写入"
        else:
            status = f"CRA：已解析 {len(records)} 条，{len(write_records)} 条将写入"
        return {
            "status": status,
            "records": records,
            "write_records": write_records,
            "missing_subjects": missing,
            "apply_enabled": apply_enabled,
            "text": text,
            "skip_confirmed": skip_confirmed,
            "records_stale": records_stale,
        }

    def update_execution_cra_status(self):
        if not hasattr(self, "execution_cra_status_label"):
            return
        state = self.describe_cra_state()
        detail = state["status"]
        if state.get("missing_subjects") and state.get("write_records"):
            detail += "；未匹配科目：" + ", ".join(state["missing_subjects"])
        self.execution_cra_status_label.setText(detail)
        color = EY_SUCCESS if "将写入" in detail or "明确不使用" in detail else EY_YELLOW
        if "未解析" in detail or "未启用" in detail:
            color = EY_ERROR
        self.execution_cra_status_label.setStyleSheet(f"color: {color};")

    def ensure_cra_ready_before_processing(self, company, company_index):
        state = self.describe_cra_state(company, company_index)
        self.update_execution_cra_status()
        if state.get("skip_confirmed"):
            self.log_output.append(">>> CRA：用户已确认本次不使用 CRA，继续执行")
            return True
        if state.get("records") and state.get("apply_enabled"):
            self.log_output.append(f">>> CRA：已启用写入，预计写入 {len(state.get('write_records', []))} 条")
            return True

        msg = QMessageBox(self)
        msg.setWindowTitle("执行前 CRA 确认")
        missing_text = ", ".join(state.get("missing_subjects", [])) or "无"
        if state.get("records") and not state.get("apply_enabled"):
            msg.setText(
                f"{state['status']}\n\n当前选中科目未匹配 CRA：{missing_text}\n\n是否启用 CRA 写入后继续？"
            )
            enable_btn = msg.addButton("启用 CRA 并继续", QMessageBox.ButtonRole.AcceptRole)
        else:
            msg.setText(
                f"{state['status']}\n\n当前选中科目未匹配 CRA：{missing_text}\n\n请确认本次是否使用 CRA。"
            )
            enable_btn = None
        go_btn = msg.addButton("去解析 CRA", QMessageBox.ButtonRole.ActionRole)
        skip_btn = msg.addButton("本次不使用 CRA，继续执行", QMessageBox.ButtonRole.AcceptRole)
        cancel_btn = msg.addButton("取消", QMessageBox.ButtonRole.RejectRole)
        msg.setDefaultButton(go_btn)
        msg.exec()
        clicked = msg.clickedButton()
        if enable_btn is not None and clicked == enable_btn:
            company["apply_cra"] = True
            if company_index == self.current_company_index:
                self.apply_cra_checkbox.setChecked(True)
            self.log_output.append(f">>> CRA：已启用写入，预计写入 {len(state.get('write_records', []))} 条")
            self.update_execution_cra_status()
            return True
        if clicked == skip_btn:
            self.cra_skip_confirmed_companies.add(self.current_company_key(company_index))
            self.log_output.append(">>> CRA：用户确认本次不使用 CRA，继续执行")
            self.update_execution_cra_status()
            return True
        if clicked == go_btn:
            self.log_output.append(">>> CRA：跳转到 CRA 页面等待确认")
            self.load_company_to_form(company_index)
            self.switch_page("company")
            self.switch_workspace_page("cra")
            return False
        return False

    def update_cra_source_mode(self, *_args):
        if not hasattr(self, "cra_canvas_group"):
            return
        use_canvas = self.cra_source_combo.currentIndex() == 1
        self.cra_canvas_group.setVisible(use_canvas)
        if use_canvas:
            self.cra_canvas_status_label.setText("待配置 EY Canvas 链接/API 后可读取；当前仍可使用下方文本粘贴解析。")
        else:
            self.cra_canvas_status_label.setText("接口未配置")

    def read_cra_from_canvas(self):
        canvas_url = self.cra_canvas_url_input.text().strip()
        endpoint = self.cra_canvas_endpoint_input.text().strip()
        if not canvas_url or not endpoint:
            self.cra_canvas_status_label.setText("请先填写 Canvas 链接和 CRA 数据接口路径。")
            QMessageBox.information(
                self,
                "EY Canvas 接入",
                "当前仅预留接入入口。待公司开放 Canvas 链接/API 后，填写 Canvas 链接、接口路径和凭证，再启用自动读取。现在请继续使用文本粘贴解析。",
            )
            return
        self.cra_canvas_status_label.setText("EY Canvas 接口尚未启用：缺少公司开放的接口协议。")
        QMessageBox.information(
            self,
            "EY Canvas 接入",
            "已保留 Canvas 接入配置，但当前没有可调用的公司接口协议。为避免读取错误数据，本版本不会伪造 Canvas 请求；请继续使用文本粘贴解析。",
        )

    def refresh_cra_column_options(self, text):
        if not hasattr(self, "cra_column_combo"):
            return ""
        current = self.cra_column_combo.currentText()
        options = detect_cra_header_options(text)
        self.cra_column_combo.blockSignals(True)
        self.cra_column_combo.clear()
        if len(options) > 1:
            self.cra_column_combo.setEnabled(True)
            self.cra_column_combo.addItem("自动选择第一列")
            for option in options:
                self.cra_column_combo.addItem(option)
        elif len(options) == 1:
            self.cra_column_combo.setEnabled(False)
            self.cra_column_combo.addItem(f"仅检测到：{options[0]}")
        else:
            self.cra_column_combo.setEnabled(False)
            self.cra_column_combo.addItem("未检测到 CRA 列")
        if current and current != "自动选择第一列":
            index = self.cra_column_combo.findText(current)
            if index >= 0:
                self.cra_column_combo.setCurrentIndex(index)
        self.cra_column_combo.blockSignals(False)
        selected = self.cra_column_combo.currentText()
        return selected if self.cra_column_combo.isEnabled() and selected != "自动选择第一列" else ""

    def parse_cra_text(self):
        text = self.cra_text_input.toPlainText().strip()
        if not text:
            QMessageBox.warning(self, "CRA 解析", "请先粘贴 CRA 内容。")
            return

        cra_column = self.refresh_cra_column_options(text)
        try:
            debug_path = write_cra_parse_debug_log(text, self.selected_subject_codes(), cra_column)
            if hasattr(self, "log_output"):
                self.log_output.append(f">>> CRA解析调试日志: {debug_path}")
        except Exception as exc:
            if hasattr(self, "log_output"):
                self.log_output.append(f">>> CRA解析调试日志写入失败: {exc}")
        records = parse_cra_paste_text(text, self.selected_subject_codes(), cra_column)
        self.populate_cra_table(records)
        if records:
            self.cra_records_stale = False
            self.apply_cra_checkbox.setEnabled(True)
            write_count = sum(1 for record in records if record.get("match_status") == "将写入")
            ratio_count = sum(1 for record in records if record.get("ratio_text"))
            self.cra_status_label.setText(f"已解析 {len(records)} 条，{write_count} 条将写入，{ratio_count} 条有比例")
            self.cra_status_label.setStyleSheet(f"color: {EY_SUCCESS};")
            self.apply_cra_checkbox.setChecked(True)
            self.save_current_company_from_form()
            self.save_workbench_data()
            self.update_execution_cra_status()
        else:
            self.cra_records_stale = True
            self.apply_cra_checkbox.setChecked(False)
            self.apply_cra_checkbox.setEnabled(False)
            self.cra_status_label.setText("未解析到有效 CRA 记录")
            self.cra_status_label.setStyleSheet(f"color: {EY_ERROR};")
            self.update_execution_cra_status()
            QMessageBox.information(
                self,
                "CRA 解析",
                "未解析到有效记录。请确认粘贴内容包含：科目名称、认定、CRA，比例可选。",
            )

    def populate_cra_table(self, records):
        sorting_enabled = self.cra_table.isSortingEnabled()
        self.cra_table.setSortingEnabled(False)
        self._updating_cra_table = True
        self.cra_table.setRowCount(len(records))
        try:
            for row, record in enumerate(records):
                self.set_cra_table_row(row, record)
        finally:
            self._updating_cra_table = False
            self.cra_table.setSortingEnabled(sorting_enabled)
        self.refresh_cra_filter_options()
        self.apply_cra_table_filters()
        self.cra_table.resizeRowsToContents()

    def set_cra_table_row(self, row, record):
        ratio = record.get("ratio")
        ratio_text = record.get("ratio_text") or (f"{float(ratio):.0%}" if ratio not in (None, "") else "")
        values = [
            record.get("match_status", "将写入" if record.get("apply", True) else "不写入"),
            record.get("subject_code", ""),
            record.get("account_name", ""),
            record.get("assertion", ""),
            record.get("cra_level", ""),
            ratio_text,
            record.get("ratio_status", ""),
            record.get("range_status", ""),
            record.get("note", ""),
        ]
        for col, value in enumerate(values):
            item = SortableTableWidgetItem(str(value or "")) if col == 5 else QTableWidgetItem(str(value or ""))
            if col == 5:
                sort_value = ratio
                try:
                    sort_value = float(sort_value)
                except (TypeError, ValueError):
                    sort_value = self.parse_cra_ratio_value(ratio_text)
                item.setData(
                    Qt.ItemDataRole.UserRole,
                    sort_value if sort_value not in (None, "") else -1.0,
                )
            if col in (6, 7):
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            if col == 0 and str(value) == "将写入":
                item.setForeground(QColor(EY_SUCCESS))
            elif col == 0 and str(value).startswith("需确认"):
                item.setForeground(QColor(EY_YELLOW))
            elif col == 0 and str(value).startswith("不写入"):
                item.setForeground(QColor(EY_MUTED))
            elif col == 7 and str(value).startswith("超出"):
                item.setForeground(QColor(EY_ERROR))
            elif col == 7 and str(value) == "通过":
                item.setForeground(QColor(EY_SUCCESS))
            self.cra_table.setItem(row, col, item)

    def refresh_cra_filter_options(self):
        if not hasattr(self, "cra_subject_filter"):
            return
        current_data = self.cra_subject_filter.currentData()
        subjects = sorted({
            self.cra_table_text(row, 1)
            for row in range(self.cra_table.rowCount())
        })
        self.cra_subject_filter.blockSignals(True)
        self.cra_subject_filter.clear()
        self.cra_subject_filter.addItem("全部底稿科目", "__all__")
        for subject in subjects:
            self.cra_subject_filter.addItem(subject or "未匹配科目", subject)
        index = self.cra_subject_filter.findData(current_data)
        self.cra_subject_filter.setCurrentIndex(index if index >= 0 else 0)
        self.cra_subject_filter.blockSignals(False)

    def apply_cra_table_filters(self, *_args):
        if not hasattr(self, "cra_table"):
            return
        search_text = self.cra_filter_input.text().strip().lower() if hasattr(self, "cra_filter_input") else ""
        subject_filter = self.cra_subject_filter.currentData() if hasattr(self, "cra_subject_filter") else "__all__"
        status_filter = self.cra_status_filter.currentData() if hasattr(self, "cra_status_filter") else "__all__"
        exception_only = self.cra_exception_filter.isChecked() if hasattr(self, "cra_exception_filter") else False

        for row in range(self.cra_table.rowCount()):
            status = self.cra_table_text(row, 0)
            subject = self.cra_table_text(row, 1)
            searchable = " ".join(
                self.cra_table_text(row, col).lower()
                for col in (1, 2, 3, 4, 8)
            )
            visible = not search_text or search_text in searchable
            if subject_filter != "__all__":
                visible = visible and subject == str(subject_filter or "")
            if status_filter == "write":
                visible = visible and status == "将写入"
            elif status_filter == "confirm":
                visible = visible and status.startswith("需确认")
            elif status_filter == "skip":
                visible = visible and status.startswith("不写入")
            if exception_only:
                ratio_status = self.cra_table_text(row, 6)
                range_status = self.cra_table_text(row, 7)
                is_exception = (
                    status != "将写入"
                    or range_status.startswith("超出")
                    or "未识别" in ratio_status
                    or "区间" in ratio_status
                )
                visible = visible and is_exception
            self.cra_table.setRowHidden(row, not visible)

    def cra_table_text(self, row, col):
        item = self.cra_table.item(row, col)
        return item.text().strip() if item else ""

    def parse_cra_ratio_value(self, ratio_text):
        ratio_text = str(ratio_text or "").strip()
        if not ratio_text or ratio_text.upper() in {"N/A", "NA"}:
            return None
        try:
            cleaned = ratio_text.replace("%", "").replace(",", "").strip()
            numeric = float(cleaned)
            return numeric / 100 if "%" in ratio_text or numeric > 1 else numeric
        except ValueError:
            return None

    def cra_table_record_from_row(self, row):
        match_status = self.cra_table_text(row, 0) or "将写入"
        subject_code = self.cra_table_text(row, 1)
        account_name = self.cra_table_text(row, 2)
        assertion = normalize_assertion(self.cra_table_text(row, 3))
        cra_level = normalize_risk_level(self.cra_table_text(row, 4))
        ratio_text = self.cra_table_text(row, 5)
        applicable = cra_level != "N/A" and ratio_text.strip().upper() not in {"N/A", "NA"}
        if not applicable:
            cra_level = "N/A"
            ratio_text = ratio_text or "N/A"
        ratio = None if not applicable else self.parse_cra_ratio_value(ratio_text)
        range_status = check_ratio_range(subject_code, assertion, cra_level, ratio, account_name)
        ratio_status = "N/A" if not applicable else ("已填写" if ratio_text else "未提供")
        return {
            "match_status": match_status,
            "apply": match_status == "将写入",
            "subject_code": subject_code,
            "account_name": account_name,
            "assertion": assertion,
            "cra_level": cra_level,
            "ratio": ratio,
            "ratio_text": ratio_text,
            "ratio_status": ratio_status,
            "range_status": range_status,
            "applicable": applicable,
            "note": self.cra_table_text(row, 8),
        }

    def collect_cra_table_records(self, include_all=False):
        if not hasattr(self, "cra_table"):
            return []
        records = []
        for row in range(self.cra_table.rowCount()):
            record = self.cra_table_record_from_row(row)
            if include_all or record.get("match_status") == "将写入":
                records.append(record)
        return records

    def cra_table_item_changed(self, item):
        if getattr(self, "_updating_cra_table", False) or item is None:
            return
        if item.column() in (6, 7):
            return
        sorting_enabled = self.cra_table.isSortingEnabled()
        self.cra_table.setSortingEnabled(False)
        self._updating_cra_table = True
        try:
            record = self.cra_table_record_from_row(item.row())
            for col, value in ((4, record.get("cra_level", "")), (5, record.get("ratio_text", "")), (6, record.get("ratio_status", "")), (7, record.get("range_status", ""))):
                table_item = self.cra_table.item(item.row(), col)
                if table_item:
                    table_item.setText(str(value or ""))
                    if col == 5:
                        sort_value = record.get("ratio")
                        table_item.setData(
                            Qt.ItemDataRole.UserRole,
                            float(sort_value) if sort_value not in (None, "") else -1.0,
                        )
            status_item = self.cra_table.item(item.row(), 0)
            if status_item:
                status_item.setForeground(QColor(EY_SUCCESS if record.get("match_status") == "将写入" else EY_MUTED))
            range_item = self.cra_table.item(item.row(), 7)
            if range_item:
                range_value = record.get("range_status", "")
                if str(range_value).startswith("超出"):
                    range_item.setForeground(QColor(EY_ERROR))
                elif range_value == "通过":
                    range_item.setForeground(QColor(EY_SUCCESS))
        finally:
            self._updating_cra_table = False
            self.cra_table.setSortingEnabled(sorting_enabled)
        self.refresh_cra_filter_options()
        self.apply_cra_table_filters()
        rows = self.collect_cra_table_records(include_all=True)
        write_count = sum(1 for record in rows if record.get("match_status") == "将写入")
        self.cra_status_label.setText(f"已手工调整 {len(rows)} 条 CRA 记录，{write_count} 条将写入")
        self.cra_status_label.setStyleSheet(f"color: {EY_SUCCESS if write_count else EY_YELLOW};")
        self.update_execution_cra_status()

    def collect_cra_records(self):
        if (
            not hasattr(self, "cra_table")
            or not self.apply_cra_checkbox.isChecked()
            or getattr(self, "cra_records_stale", False)
        ):
            return []

        records = []
        for record in self.collect_cra_table_records(include_all=False):
            if not record.get("apply"):
                continue
            subject_code = str(record.get("subject_code") or "").strip()
            account_name = str(record.get("account_name") or "").strip()
            assertion = normalize_assertion(record.get("assertion"))
            cra_level = normalize_risk_level(record.get("cra_level"))
            applicable = bool(record.get("applicable", True))
            if not applicable:
                cra_level = "N/A"
            ratio_text = str(record.get("ratio_text") or "").strip()
            ratio = None
            if not applicable:
                ratio = None
                ratio_text = "N/A"
            elif record.get("ratio") not in (None, ""):
                try:
                    ratio = float(record.get("ratio"))
                except (TypeError, ValueError):
                    ratio = None
            elif ratio_text:
                ratio = self.parse_cra_ratio_value(ratio_text)
            range_status = check_ratio_range(subject_code, assertion, cra_level, ratio, account_name)
            records.append({
                "apply": True,
                "subject_code": subject_code,
                "account_name": account_name,
                "assertion": assertion,
                "cra_level": cra_level,
                "ratio": ratio,
                "ratio_text": ratio_text,
                "range_status": range_status,
                "applicable": applicable,
                "note": str(record.get("note") or ""),
            })
        return records

    def clear_cra_inputs(self):
        self.cra_text_input.blockSignals(True)
        self.cra_text_input.clear()
        self.cra_text_input.blockSignals(False)
        self.cra_table.setRowCount(0)
        self.cra_records_stale = False
        self.cra_column_combo.clear()
        self.cra_column_combo.addItem("粘贴后自动识别")
        self.cra_column_combo.setEnabled(False)
        self.apply_cra_checkbox.setChecked(False)
        self.apply_cra_checkbox.setEnabled(True)
        if hasattr(self, "cra_filter_input"):
            self.cra_filter_input.clear()
            self.cra_status_filter.setCurrentIndex(0)
            self.cra_exception_filter.setChecked(False)
            self.refresh_cra_filter_options()
        self.cra_status_label.setText("未解析")
        self.cra_status_label.setStyleSheet(f"color: {EY_MUTED};")
        self.cra_skip_confirmed_companies.discard(self.current_company_key())
        self.update_execution_cra_status()

    def clear_form(self):
        if self.worker and self.worker.isRunning():
            QMessageBox.information(self, "提示", "当前正在处理，请等待完成后再清空。")
            return

        for field in (
            self.company_input,
            self.date_input,
            self.functional_currency_input,
            self.accounting_standard_input,
            self.pm_input,
            self.te_input,
            self.sad_input,
            self.prior_dir_input,
            self.output_dir_input,
        ):
            field.clear()

        self.roll_wording_checkbox.setChecked(False)
        self.generate_summary_checkbox.setChecked(True)
        self.llm_enhanced_checkbox.setChecked(False)
        self.llm_wording_checkbox.setChecked(False)
        self.llm_api_key_input.clear()
        self.llm_model_input.clear()
        self.llm_base_url_input.clear()
        self.llm_test_status_label.setText("未测试")
        self.llm_test_status_label.setStyleSheet(f"color: {EY_MUTED};")

        if hasattr(self, "subject_checkboxes"):
            for checkbox in self.subject_checkboxes.values():
                checkbox.setChecked(False)

        self.progress_bar.setVisible(False)
        self.progress_bar.setValue(0)
        self.log_output.clear()
        self.results_table.setRowCount(0)
        self.clear_cra_inputs()

    def toggle_select_all(self):
        if hasattr(self, "subject_checkboxes"):
            should_check = not all(checkbox.isChecked() for checkbox in self.subject_checkboxes.values())
            for checkbox in self.subject_checkboxes.values():
                checkbox.setChecked(should_check)

    def log_event(self, message):
        try:
            APP_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with open(APP_LOG_PATH, "a", encoding="utf-8") as log_file:
                log_file.write(f"[{timestamp}] {message}\n")
        except Exception:
            pass

    def dialog_helper_command(self):
        if getattr(sys, "frozen", False):
            helper_path = Path(sys.executable).with_name("AuditRollForward_DialogHelper.exe")
            if not helper_path.exists():
                raise FileNotFoundError(f"找不到选择器组件: {helper_path}")
            return [str(helper_path)]

        helper_path = Path(__file__).with_name("dialog_helper.py")
        if not helper_path.exists():
            raise FileNotFoundError(f"找不到选择器脚本: {helper_path}")
        return [sys.executable, str(helper_path)]

    def run_external_dialog_helper(self, kind, title, result_path, filter_text=""):
        command = self.dialog_helper_command() + [
            kind,
            "--result",
            str(result_path),
            "--title",
            title,
        ]
        if filter_text:
            command.extend(["--filter", filter_text])
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )
        if completed.returncode != 0:
            stderr = (completed.stderr or completed.stdout or "").strip()
            raise RuntimeError(stderr or f"Dialog helper exited with code {completed.returncode}")
        result_file = Path(result_path)
        if not result_file.exists():
            return ""
        return result_file.read_text(encoding="utf-8-sig").strip()

    def choose_directory_external(self, title):
        self.log_event(f"open_qt_directory_dialog: {title}")
        try:
            dialog = QFileDialog(self, title)
            dialog.setWindowIcon(QIcon(resource_path(APP_ICON_PATH)))
            dialog.setFileMode(QFileDialog.FileMode.Directory)
            dialog.setOption(QFileDialog.Option.ShowDirsOnly, False)
            dialog.setOption(QFileDialog.Option.DontUseNativeDialog, True)
            dialog.setLabelText(QFileDialog.DialogLabel.Accept, "选择")
            dialog.setLabelText(QFileDialog.DialogLabel.Reject, "取消")
            dialog.setStyleSheet(FILE_DIALOG_STYLESHEET)
            path = ""
            if dialog.exec():
                selected = dialog.selectedFiles()
                path = selected[0] if selected else ""
            self.log_event(f"qt_directory_selected: {path}")
            return path or ""
        except Exception as exc:
            self.log_event(f"qt_directory_error: {exc}")
            QMessageBox.warning(self, "提示", f"打开目录选择窗口失败：{exc}\n\n也可以直接把目录路径粘贴到输入框。")
            return ""

    def choose_file_external(self, title, filter_text):
        self.log_event(f"open_helper_file_dialog: {title}")
        result_path = tempfile.NamedTemporaryFile(delete=False, suffix=".txt").name
        Path(result_path).unlink(missing_ok=True)
        try:
            path = self.run_external_dialog_helper("file", title, result_path, filter_text)
            self.log_event(f"helper_file_selected: {path}")
            return path or ""
        except Exception as exc:
            self.log_event(f"helper_file_error: {exc}")
            try:
                dialog = QFileDialog(self, title)
                dialog.setWindowIcon(QIcon(resource_path(APP_ICON_PATH)))
                dialog.setFileMode(QFileDialog.FileMode.ExistingFile)
                dialog.setNameFilter(filter_text)
                dialog.setOption(QFileDialog.Option.DontUseNativeDialog, True)
                dialog.setLabelText(QFileDialog.DialogLabel.Accept, "选择")
                dialog.setLabelText(QFileDialog.DialogLabel.Reject, "取消")
                dialog.setStyleSheet(FILE_DIALOG_STYLESHEET)
                path = ""
                if dialog.exec():
                    selected = dialog.selectedFiles()
                    path = selected[0] if selected else ""
                self.log_event(f"qt_file_selected_after_helper_error: {path}")
                return path or ""
            except Exception as qt_exc:
                self.log_event(f"qt_file_error_after_helper_error: {qt_exc}")
                QMessageBox.warning(self, "提示", f"打开文件选择窗口失败：{exc}\n\n也可以直接把文件路径粘贴到输入框。")
                return ""
        finally:
            Path(result_path).unlink(missing_ok=True)

    def normalize_subject_match_text(self, value):
        return re.sub(r"[\s_\-./\\：:；;（）()\[\]【】]+", "", str(value or "").upper())

    def subject_match_tokens(self):
        tokens = {}
        for code, checkbox in getattr(self, "subject_checkboxes", {}).items():
            label = checkbox.text()
            name = label.replace(code, "", 1).strip()
            variants = {code, code.replace("_", ""), name}
            if code.lower() == "uexp":
                variants.update({"U_EXP", "UEXP"})
            elif code.lower() == "uexpvcvd":
                variants.update({"U_EXPVCVD", "UEXPVCVD", "VCVD", "VC&VD"})
            tokens[code] = [self.normalize_subject_match_text(item) for item in variants if item]
        return tokens

    def detect_subjects_from_prior_path(self, source_path):
        path_text = str(source_path or "").strip().strip('"')
        if not path_text:
            return []
        path_obj = Path(path_text)
        files = []
        if path_obj.is_file():
            files = [path_obj]
        elif path_obj.is_dir():
            try:
                files = [item for item in path_obj.rglob("*.xlsx") if item.is_file()]
            except Exception:
                files = []

        tokens = self.subject_match_tokens()
        detected = set()
        for file_path in files[:500]:
            name = file_path.name
            if name.startswith("~$"):
                continue
            normalized_name = self.normalize_subject_match_text(name)
            for code, variants in tokens.items():
                code_token = self.normalize_subject_match_text(code)
                has_code_token = bool(re.search(rf"(^|[^A-Z0-9]){re.escape(code.upper())}([^A-Z0-9]|$)", name.upper()))
                if code.lower() == "uexp":
                    is_vcvd_file = "VC&VD" in name.upper() or "VCVD" in normalized_name
                    has_code_token = (not is_vcvd_file) and (has_code_token or "U_EXP" in name.upper() or "UEXP" in normalized_name)
                elif code.lower() == "uexpvcvd":
                    has_code_token = has_code_token or "VC&VD" in name.upper() or "VCVD" in normalized_name
                has_name_token = any(token and token != code_token and token in normalized_name for token in variants)
                if has_code_token or has_name_token:
                    detected.add(code)

        ordered_codes = list(getattr(self, "subject_checkboxes", {}).keys())
        return [code for code in ordered_codes if code in detected]

    def auto_select_subjects_from_prior_input(self):
        self.auto_select_subjects_from_prior_path(self.prior_dir_input.text(), notify=False)

    def auto_select_subjects_from_prior_path(self, source_path, notify=True):
        detected = self.detect_subjects_from_prior_path(source_path)
        if not detected:
            if hasattr(self, "log_output"):
                self.log_output.append(">>> 未能从上年底稿路径自动识别科目，请手动确认需要 roll 的科目。")
            return

        for code, checkbox in getattr(self, "subject_checkboxes", {}).items():
            checkbox.setChecked(code in detected)
        message = f"已根据上年底稿文件默认勾选科目：{', '.join(detected)}。请再确认是否需要增删本次 roll 的科目。"
        if hasattr(self, "log_output"):
            self.log_output.append(f">>> {message}")
        if hasattr(self, "cra_status_label"):
            self.cra_status_label.setText(message)
        self.save_current_company_from_form()
        if notify:
            QMessageBox.information(self, "科目已自动识别", message)

    def browse_prior_dir(self):
        dir_path = self.choose_directory_external("选择上年底稿目录")
        if dir_path:
            self.prior_dir_input.setText(dir_path)
            self.auto_select_subjects_from_prior_path(dir_path)

    def browse_prior_file(self):
        file_path = self.choose_file_external("选择上年底稿文件", "Excel 文件 (*.xlsx)")
        if file_path:
            self.prior_dir_input.setText(file_path)
            self.auto_select_subjects_from_prior_path(file_path)

    def browse_output_dir(self):
        dir_path = self.choose_directory_external("选择输出目录")
        if dir_path:
            self.output_dir_input.setText(dir_path)

    def feedback_prompt_already_shown(self):
        try:
            if not FEEDBACK_STATE_PATH.exists():
                return False
            with open(FEEDBACK_STATE_PATH, "r", encoding="utf-8") as state_file:
                state = json.load(state_file)
            return bool(state.get("feedback_prompt_shown"))
        except Exception:
            return False

    def save_feedback_prompt_state(self, opened=False):
        try:
            APP_STATE_DIR.mkdir(parents=True, exist_ok=True)
            state = {
                "feedback_prompt_shown": True,
                "feedback_opened": bool(opened),
                "feedback_prompt_shown_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "feedback_url": FEEDBACK_URL,
            }
            with open(FEEDBACK_STATE_PATH, "w", encoding="utf-8") as state_file:
                json.dump(state, state_file, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def new_user_guide_already_shown(self):
        try:
            if not GUIDE_STATE_PATH.exists():
                return False
            with open(GUIDE_STATE_PATH, "r", encoding="utf-8") as state_file:
                state = json.load(state_file)
            return bool(state.get("new_user_guide_shown"))
        except Exception:
            return False

    def save_new_user_guide_state(self):
        try:
            APP_STATE_DIR.mkdir(parents=True, exist_ok=True)
            state = {
                "new_user_guide_shown": True,
                "new_user_guide_shown_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
            with open(GUIDE_STATE_PATH, "w", encoding="utf-8") as state_file:
                json.dump(state, state_file, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def maybe_show_new_user_guide(self):
        if not self.user_settings.get("show_new_user_guide", True):
            return
        if not self.new_user_guide_already_shown():
            self.show_new_user_guide(mark_shown=True)

    def show_new_user_guide(self, mark_shown=False):
        self.switch_page("company")
        self.switch_workspace_page("basic")
        steps = [
            {
                "main_page": "project",
                "target": self.project_card,
                "title": "项目与公司",
                "body": "先在项目页维护项目和公司。可以进入单个公司，也可以从这里处理选中公司或处理全部公司；公司表会显示科目数、处理状态、CRA状态和输出路径。",
            },
            {
                "main_page": "company",
                "workspace_page": "basic",
                "target": self.company_workspace,
                "title": "公司工作区",
                "body": "进入公司后，顶部页签按工作流拆成基础信息、CRA解析、AI复核和处理日志。每家公司有独立的基础信息、CRA文本、选中科目和输出目录。",
            },
            {
                "workspace_page": "basic",
                "target": self.parameters_card,
                "title": "基础参数",
                "body": "先填写本次底稿的项目基础信息。公司名称、资产负债表日、PM、TE、SAD、记账本位币和会计准则会写入底稿信息区；PM、TE、SAD 会按千分符和小数格式显示。",
            },
            {
                "workspace_page": "basic",
                "target": self.file_card,
                "title": "文件路径",
                "body": "选择上年底稿目录或单个上年底稿文件，再选择输出目录。选择路径后，工具会尽量从文件名自动勾选匹配的科目，仍建议在科目区复核一次。",
            },
            {
                "workspace_page": "basic",
                "target": self.subject_card,
                "title": "科目选择",
                "body": "只勾选本次需要生成的科目。未勾选科目不会处理；如果某科目找不到模板或上年底稿，会在处理结果和日志中提示。",
            },
            {
                "workspace_page": "basic",
                "target": self.options_group,
                "title": "处理选项",
                "body": "如需延续上年底稿中的分析说明、wording或调整汇总，打开对应选项。工具会用黄色标注需要项目组复核的内容，黄色区域不代表自动完成审计结论。",
            },
            {
                "workspace_page": "cra",
                "target": self.cra_card,
                "title": "CRA解析",
                "body": "在CRA页粘贴从CRA Excel或Canvas复制的区域，点击解析后查看右侧预览。确认匹配状态、CRA等级、比例和区间检查后，再决定是否启用CRA写入。",
            },
            {
                "workspace_page": "llm",
                "target": self.llm_card,
                "title": "AI复核",
                "body": "AI复核默认可以不启用。需要LLM预检、Review或wording修订时，先配置连接信息；没有配置时，常规roll forward流程不受影响。",
            },
            {
                "workspace_page": "basic",
                "target": self.action_card,
                "title": "执行处理",
                "body": "执行区会显示本次CRA状态。开始处理前，如果CRA未解析、未启用或疑似漏用，工具会弹窗确认；处理过程中可暂停、继续或终止，都会在当前科目安全完成后生效。",
            },
            {
                "workspace_page": "logs",
                "title": "结果复核",
                "target": self.results_card,
                "body": "完成后会自动切到处理日志页。先看处理结果表中的成功、失败、Warnings和LLM改写数量，再打开输出底稿复核黄色标注区域。",
            },
            {
                "workspace_page": "logs",
                "target": self.log_card,
                "title": "处理日志",
                "body": "日志会记录CRA选择、预计写入数量、用户明确不使用CRA、暂停继续和终止位置。若出现失败，先从这里看原因，再回到对应页调整后重跑。",
            },
        ]
        overlay = GuideOverlay(self, steps)
        self.active_guide_overlay = overlay
        overlay.destroyed.connect(lambda: setattr(self, "active_guide_overlay", None))
        overlay.start()
        if mark_shown:
            self.save_new_user_guide_state()

    def maybe_show_feedback_prompt(self, success_count, total_count):
        if not self.user_settings.get("show_feedback_prompt", True):
            return
        if total_count <= 0 or success_count <= 0 or self.feedback_prompt_already_shown():
            return

        message = QMessageBox(self)
        message.setWindowTitle("使用反馈")
        message.setIcon(QMessageBox.Icon.Information)
        message.setText("本次 Roll Forward 已完成。")
        message.setInformativeText("为了继续优化工具，是否愿意花 1 分钟填写使用反馈？")
        fill_button = message.addButton("填写问卷", QMessageBox.ButtonRole.AcceptRole)
        later_button = message.addButton("暂不填写", QMessageBox.ButtonRole.RejectRole)
        message.setDefaultButton(fill_button)
        message.exec()

        opened = message.clickedButton() == fill_button
        self.save_feedback_prompt_state(opened=opened)
        if opened:
            QDesktopServices.openUrl(QUrl(FEEDBACK_URL))

    def process_selected_company(self):
        row = self.company_table.currentRow() if hasattr(self, "company_table") else self.current_company_index
        if row < 0:
            row = self.current_company_index
        self.start_company_processing(row, batch_mode=False)

    def process_all_companies(self):
        if self.worker and self.worker.isRunning():
            QMessageBox.information(self, "提示", "当前正在处理，请等待完成。")
            return
        self.save_current_company_from_form()
        self.project_batch_queue = list(range(len(self.project_data.get("companies", []))))
        self.project_batch_active = True
        self.process_next_company_in_batch()

    def process_next_company_in_batch(self):
        if not self.project_batch_queue:
            self.project_batch_active = False
            self.active_processing_company_index = None
            self.refresh_project_table()
            QMessageBox.information(self, "项目处理", "项目内公司已处理完成，请在处理日志页查看结果。")
            return
        next_index = self.project_batch_queue[0]
        started = self.start_company_processing(next_index, batch_mode=True)
        if started:
            self.project_batch_queue.pop(0)
        else:
            self.project_batch_active = False

    def start_processing(self):
        self.start_company_processing(self.current_company_index, batch_mode=False)

    def start_company_processing(self, company_index, batch_mode=False):
        if self.worker and self.worker.isRunning():
            QMessageBox.information(self, "提示", "当前正在处理，请等待完成。")
            return

        self.save_current_company_from_form()
        companies = self.project_data.get("companies", [])
        if not companies:
            QMessageBox.warning(self, "提示", "请先添加公司。")
            return
        company_index = max(0, min(company_index, len(companies) - 1))
        self.load_company_to_form(company_index)
        company = companies[company_index]

        subject_codes = list(company.get("subjects", []))
        if not subject_codes:
            QMessageBox.warning(self, "提示", f"{company.get('name', '当前公司')} 请至少选择一个科目。")
            return

        prior_path = str(company.get("prior_path", "")).strip()
        company_name = str(company.get("name", "")).strip()
        bs_date = str(company.get("bs_date", "")).strip()
        output_dir = str(company.get("output_dir", "")).strip()

        if not all([prior_path, company_name, bs_date, output_dir]):
            QMessageBox.warning(self, "提示", f"{company_name or '当前公司'} 请填写公司名称、资产负债表日，并选择上年底稿目录/文件和输出目录。")
            return

        if not os.path.exists(prior_path):
            QMessageBox.warning(self, "提示", f"找不到上年底稿目录/文件: {prior_path}")
            return

        if os.path.isfile(prior_path):
            if not prior_path.lower().endswith(".xlsx") or os.path.basename(prior_path).startswith("~$"):
                QMessageBox.warning(self, "提示", "单文件模式请选择一个有效的 .xlsx 上年底稿文件，不能选择临时文件。")
                return
            if len(subject_codes) != 1:
                QMessageBox.warning(self, "提示", "单文件模式下请只选择一个科目。")
                return
        elif not os.path.isdir(prior_path):
            QMessageBox.warning(self, "提示", f"上年底稿路径不是有效目录或文件: {prior_path}")
            return

        template_dir = resource_path("templates")
        if not os.path.exists(template_dir):
            QMessageBox.warning(self, "提示", f"找不到模板目录: {template_dir}")
            return

        if not self.ensure_cra_ready_before_processing(company, company_index):
            return False

        self.active_processing_company_index = company_index
        company["status"] = "处理中"
        company["generated"] = 0
        company["failed"] = 0
        self.refresh_project_table(select_index=company_index)

        self.start_btn.setEnabled(False)
        self.process_company_btn.setEnabled(False)
        self.process_all_btn.setEnabled(False)
        self.clear_btn.setEnabled(False)
        self.pause_btn.setEnabled(True)
        self.pause_btn.setText("暂停")
        self.stop_btn.setEnabled(True)
        self.start_btn.setText("处理中...")
        self.progress_bar.setVisible(True)
        self.progress_bar.setMaximum(len(subject_codes))
        self.progress_bar.setValue(0)
        self.results_table.setRowCount(0)
        if not batch_mode:
            self.log_output.clear()

        self.log_output.append(">>> 初始化完成")
        self.log_output.append(f">>> 目标公司: {company_name}")
        self.log_output.append(f">>> 资产负债表日: {bs_date}")
        if company.get("functional_currency"):
            self.log_output.append(f">>> 记账本位币: {company.get('functional_currency')}")
        if company.get("accounting_standard"):
            self.log_output.append(f">>> 适用会计准则: {company.get('accounting_standard')}")
        if company.get("pm"):
            self.log_output.append(f">>> PM: {company.get('pm')}")
        if company.get("te"):
            self.log_output.append(f">>> TE: {company.get('te')}")
        if company.get("sad"):
            self.log_output.append(f">>> SAD: {company.get('sad')}")
        self.log_output.append(f">>> 待处理科目数: {len(subject_codes)}")
        self.log_output.append(f">>> 上年底稿{'文件' if os.path.isfile(prior_path) else '目录'}: {prior_path}")
        if company.get("roll_wording"):
            self.log_output.append(">>> Wording roll forward 已启用")
        if company.get("generate_summary", True):
            self.log_output.append(">>> Roll Forward Summary 已启用")

        llm_wording_requested = self.llm_wording_checkbox.isChecked()
        llm_enhanced_requested = self.llm_enhanced_checkbox.isChecked() or llm_wording_requested
        if llm_enhanced_requested:
            self.log_output.append(">>> LLM 增强预检 + Review 已启用")
        if llm_wording_requested:
            self.log_output.append(">>> LLM wording 修订已启用，仅处理已标黄wording单元格")

        cra_records = self.collect_cra_records()
        if cra_records:
            self.log_output.append(f">>> CRA 写入已启用，已确认记录数: {len(cra_records)}")
        self.log_output.append(">>> " + "=" * 50)

        self.worker = RollForwardWorker(
            subject_codes=subject_codes,
            template_dir=template_dir,
            prior_dir=prior_path,
            company_name=company_name,
            bs_date=bs_date,
            output_dir=output_dir,
            functional_currency=company.get("functional_currency", ""),
            accounting_standard=company.get("accounting_standard", ""),
            pm_value=company.get("pm", ""),
            te_value=company.get("te", ""),
            sad_value=company.get("sad", ""),
            cra_records=cra_records,
            roll_forward_wording=bool(company.get("roll_wording", False)),
            generate_summary=bool(company.get("generate_summary", True)),
            llm_enhanced=llm_enhanced_requested,
            llm_wording_revision=llm_wording_requested,
            llm_options=self.get_llm_options(),
        )
        self.worker.progress_signal.connect(self.update_progress)
        self.worker.finished_signal.connect(self.processing_finished)
        self.worker.start()
        return True

    def update_progress(self, current, total, message):
        self.progress_bar.setMaximum(max(total, 1))
        self.progress_bar.setValue(current)
        self.log_output.append(message)

    def toggle_pause_processing(self):
        if not self.worker or not self.worker.isRunning():
            return
        if self.worker.pause_requested:
            self.worker.resume_processing()
            self.pause_btn.setText("暂停")
            self.log_output.append(">>> 继续处理")
        else:
            self.worker.request_pause()
            self.pause_btn.setText("继续")
            self.log_output.append(">>> 已请求暂停，将在当前科目完成后暂停")

    def request_stop_processing(self):
        if not self.worker or not self.worker.isRunning():
            return
        self.worker.request_stop()
        self.stop_btn.setEnabled(False)
        self.log_output.append(">>> 已请求终止，将在当前科目完成后停止")

    def populate_results_table(self, results):
        self.results_table.setRowCount(len(results))
        for row, result in enumerate(results):
            subject_code, success, message, output_path, warnings_list = result[:5]
            metadata = getattr(warnings_list, "metadata", {}) if warnings_list is not None else {}
            warning_text = "; ".join(str(item) for item in warnings_list) if warnings_list else ""
            display_success = bool(success)
            status_text = "成功"
            if display_success and warning_text:
                status_text = "成功(有提醒)"
            elif not display_success:
                status_text = "失败"
            detail_text = warning_text or message
            if not display_success and message:
                detail_text = message if not warning_text else f"{message}; {warning_text}"
            values = [
                subject_code,
                status_text,
                output_path or "",
                detail_text,
                str(metadata.get("wording_copied_count", 0)),
                str(metadata.get("llm_wording_changes", 0)),
            ]

            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                if col == 1:
                    if display_success:
                        item.setForeground(QColor(EY_YELLOW if warning_text else EY_SUCCESS))
                    else:
                        item.setForeground(QColor(EY_ERROR))
                if col == 3 and value:
                    item.setToolTip(value)
                self.results_table.setItem(row, col, item)
        self.results_table.resizeRowsToContents()

    def get_llm_options(self):
        return {
            "api_key": self.llm_api_key_input.text().strip(),
            "model": self.llm_model_input.text().strip(),
            "base_url": self.llm_base_url_input.text().strip(),
        }

    def test_llm_connection(self):
        if test_llm_connection is None:
            QMessageBox.warning(self, "LLM连接测试", "LLM模块不可用。")
            return
        if self.llm_test_worker and self.llm_test_worker.isRunning():
            return

        self.llm_test_btn.setEnabled(False)
        self.llm_test_status_label.setText("正在测试连接...")
        self.llm_test_status_label.setStyleSheet(f"color: {EY_YELLOW};")
        self.llm_test_worker = LLMConnectionTestWorker(self.get_llm_options())
        self.llm_test_worker.finished_signal.connect(self.llm_connection_test_finished)
        self.llm_test_worker.start()

    def llm_connection_test_finished(self, result):
        self.llm_test_btn.setEnabled(True)
        if result.get("ok"):
            message = f"连接成功 | model={result.get('model')} | base={result.get('base_url')}"
            self.llm_test_status_label.setText(message)
            self.llm_test_status_label.setStyleSheet(f"color: {EY_SUCCESS};")
            QMessageBox.information(self, "LLM连接测试", message)
        else:
            message = result.get("error", "连接失败")
            self.llm_test_status_label.setText(message)
            self.llm_test_status_label.setStyleSheet(f"color: {EY_ERROR};")
            QMessageBox.warning(self, "LLM连接测试", message)

    def processing_finished(self, results):
        terminated = bool(getattr(self.worker, "was_terminated", False))
        self.start_btn.setEnabled(True)
        self.process_company_btn.setEnabled(True)
        self.process_all_btn.setEnabled(True)
        self.clear_btn.setEnabled(True)
        self.pause_btn.setEnabled(False)
        self.pause_btn.setText("暂停")
        self.stop_btn.setEnabled(False)
        self.start_btn.setText("开始处理")

        success_count = sum(1 for result in results if len(result) > 1 and result[1])
        total_count = len(results)
        failed_count = max(total_count - success_count, 0)
        if self.active_processing_company_index is not None:
            companies = self.project_data.get("companies", [])
            if 0 <= self.active_processing_company_index < len(companies):
                company = companies[self.active_processing_company_index]
                company["generated"] = success_count
                company["failed"] = failed_count
                company["status"] = "已完成" if total_count and failed_count == 0 else "部分失败"
                company["last_message"] = f"{success_count}/{total_count}"
                if terminated:
                    company["status"] = "已终止"
        self.refresh_project_table(select_index=self.active_processing_company_index)
        self.populate_results_table(results)
        self.switch_page("company")
        self.switch_workspace_page("logs")
        self.log_output.append(">>> " + "=" * 50)
        self.log_output.append(f">>> 处理完成: {success_count}/{total_count}")

        if terminated:
            self.project_batch_queue = []
            self.project_batch_active = False
            self.log_output.append(">>> 处理已终止，后续公司未执行")

        if self.project_batch_active:
            self.save_workbench_data()
            self.process_next_company_in_batch()
            return

        self.save_workbench_data()

        if total_count and success_count == total_count:
            QMessageBox.information(self, "完成", f"全部科目处理成功，共生成 {success_count} 个底稿文件。")
        else:
            QMessageBox.warning(self, "完成", f"部分科目处理失败，成功 {success_count}/{total_count}。")

        if success_count and self.user_settings.get("open_output_after_success", False):
            output_dir = ""
            for result in results:
                if len(result) > 3 and result[1] and result[3]:
                    output_dir = str(Path(result[3]).parent)
                    break
            if not output_dir and self.active_processing_company_index is not None:
                companies = self.project_data.get("companies", [])
                if 0 <= self.active_processing_company_index < len(companies):
                    output_dir = companies[self.active_processing_company_index].get("output_dir", "")
            if output_dir and Path(output_dir).is_dir():
                QDesktopServices.openUrl(QUrl.fromLocalFile(str(Path(output_dir).resolve())))

        self.maybe_show_feedback_prompt(success_count, total_count)


class RollForwardWorker(QThread):
    progress_signal = pyqtSignal(int, int, str)
    finished_signal = pyqtSignal(list)

    def __init__(
        self,
        subject_codes,
        template_dir,
        prior_dir,
        company_name,
        bs_date,
        output_dir,
        functional_currency=None,
        accounting_standard=None,
        pm_value=None,
        te_value=None,
        sad_value=None,
        cra_records=None,
        roll_forward_wording=False,
        generate_summary=True,
        llm_enhanced=False,
        llm_wording_revision=False,
        llm_options=None,
    ):
        super().__init__()
        self.subject_codes = subject_codes
        self.template_dir = template_dir
        self.prior_dir = prior_dir
        self.company_name = company_name
        self.bs_date = bs_date
        self.output_dir = output_dir
        self.functional_currency = functional_currency
        self.accounting_standard = accounting_standard
        self.pm_value = pm_value
        self.te_value = te_value
        self.sad_value = sad_value
        self.cra_records = cra_records or []
        self.roll_forward_wording = roll_forward_wording
        self.generate_summary = generate_summary
        self.llm_enhanced = llm_enhanced
        self.llm_wording_revision = llm_wording_revision
        self.llm_options = llm_options or {}
        self.pause_requested = False
        self.stop_requested = False
        self.was_terminated = False

    def request_pause(self):
        self.pause_requested = True

    def resume_processing(self):
        self.pause_requested = False

    def request_stop(self):
        self.stop_requested = True
        self.pause_requested = False

    def control_callback(self, event, subject_code, index, total):
        if self.stop_requested:
            self.was_terminated = True
            self.progress_signal.emit(index - 1, total, ">>> 处理已终止，后续科目未执行")
            return "terminate"
        if self.pause_requested:
            self.progress_signal.emit(index - 1, total, ">>> 已暂停，将从下一个科目继续")
        while self.pause_requested and not self.stop_requested:
            time.sleep(0.2)
        if self.stop_requested:
            self.was_terminated = True
            self.progress_signal.emit(index - 1, total, ">>> 处理已终止，后续科目未执行")
            return "terminate"
        return "continue"

    def _request_for_subject(self, subject_code):
        return {
            "subject_code": subject_code,
            "template_dir": self.template_dir,
            "prior_dir": self.prior_dir,
            "company_name": self.company_name,
            "bs_date": self.bs_date,
            "output_dir": self.output_dir,
            "functional_currency": self.functional_currency,
            "accounting_standard": self.accounting_standard,
            "pm_value": self.pm_value,
            "te_value": self.te_value,
            "sad_value": self.sad_value,
            "cra_records": self.cra_records,
            "roll_forward_wording": self.roll_forward_wording,
            "generate_summary": self.generate_summary,
            "llm_enhanced": self.llm_enhanced,
            "llm_wording_revision": self.llm_wording_revision,
            "llm_options": self.llm_options,
        }

    def _wait_between_subjects(self, completed, total):
        if self.pause_requested:
            self.progress_signal.emit(completed, total, ">>> 已暂停，将从下一个科目继续")
        while self.pause_requested and not self.stop_requested:
            time.sleep(0.2)
        if self.stop_requested:
            self.was_terminated = True
            self.progress_signal.emit(completed, total, ">>> 处理已终止，后续科目未执行")
            return False
        return True

    def _run_isolated_subject(self, subject_code, completed, total):
        context = multiprocessing.get_context("spawn")
        parent_connection, child_connection = context.Pipe(duplex=False)
        process = context.Process(
            target=run_rollforward_process,
            args=(child_connection, self._request_for_subject(subject_code)),
            name=f"RollForward-{subject_code}",
        )
        try:
            process.start()
        except Exception as exc:
            parent_connection.close()
            child_connection.close()
            return [(subject_code, False, f"后台处理进程启动失败: {exc}", None, [])]
        child_connection.close()

        subject_results = None
        fatal_error = None
        started_at = time.monotonic()
        next_heartbeat = started_at + 15.0
        pipe_open = True

        try:
            while process.is_alive() or pipe_open:
                has_event = False
                if pipe_open:
                    try:
                        has_event = parent_connection.poll(0.2)
                    except (EOFError, OSError):
                        pipe_open = False

                if has_event:
                    try:
                        event = parent_connection.recv()
                    except (EOFError, OSError):
                        pipe_open = False
                        continue
                    event_type = event[0]
                    if event_type == "progress":
                        child_current, _, message = event[1:]
                        current = completed + (1 if child_current else 0)
                        self.progress_signal.emit(current, total, message)
                    elif event_type == "result":
                        subject_results = event[1]
                    elif event_type == "fatal":
                        fatal_error = event[1]

                if not process.is_alive() and not has_event:
                    if not pipe_open:
                        break
                    try:
                        if not parent_connection.poll():
                            break
                    except (EOFError, OSError):
                        break

                now = time.monotonic()
                if process.is_alive() and now >= next_heartbeat:
                    elapsed = int(now - started_at)
                    self.progress_signal.emit(
                        completed,
                        total,
                        f">>> [{subject_code}] 大文件处理中，已用时 {elapsed} 秒，请耐心等待",
                    )
                    next_heartbeat = now + 15.0
        finally:
            process.join()
            parent_connection.close()

        if subject_results:
            return subject_results

        if fatal_error:
            detail = fatal_error.strip().splitlines()[-1]
        else:
            detail = f"后台处理进程异常退出（代码 {process.exitcode}）"
        return [(subject_code, False, f"处理失败: {detail}", None, [])]

    def run(self):
        try:
            results = []
            total = len(self.subject_codes)
            for subject_code in self.subject_codes:
                completed = len(results)
                if not self._wait_between_subjects(completed, total):
                    break
                results.extend(self._run_isolated_subject(subject_code, completed, total))
            self.finished_signal.emit(results)
        except Exception as exc:
            self.progress_signal.emit(0, 0, f"错误: {exc}")
            self.finished_signal.emit([])


class LLMConnectionTestWorker(QThread):
    finished_signal = pyqtSignal(dict)

    def __init__(self, llm_options):
        super().__init__()
        self.llm_options = llm_options

    def run(self):
        try:
            if test_llm_connection is None:
                self.finished_signal.emit({"ok": False, "error": "LLM模块不可用"})
                return
            self.finished_signal.emit(test_llm_connection(self.llm_options))
        except Exception as exc:
            self.finished_signal.emit({"ok": False, "error": f"LLM连接测试失败: {exc}"})


def main():
    multiprocessing.freeze_support()
    app = QApplication(sys.argv)
    app.setFont(QFont("Microsoft YaHei", 10))
    app.setWindowIcon(QIcon(resource_path(APP_ICON_PATH)))
    window = RollForwardApp()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
