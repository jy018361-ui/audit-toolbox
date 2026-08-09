#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Off-screen regression check for UI settings; does not process workbooks."""

import copy
import os
import tempfile
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
_APP_STATE = tempfile.TemporaryDirectory(prefix="arf-ui-state-")
os.environ["APPDATA"] = _APP_STATE.name

from PyQt6.QtWidgets import QApplication, QPushButton

import main_gui
from app_settings import DEFAULT_SETTINGS, THEMES, SettingsDialog, load_settings, validate_themes


def run():
    validate_themes()
    app = QApplication.instance() or QApplication([])
    window = main_gui.RollForwardApp()
    window.show()
    app.processEvents()

    labels = {button.text() for button in window.findChildren(QPushButton)}
    assert "⚙ 设置" in labels, "settings button missing"
    assert "新手指引" in labels, "existing guide button missing"
    assert hasattr(window, "start_btn"), "existing processing controls missing"

    original = copy.deepcopy(window.user_settings)
    original["show_new_user_guide"] = False
    screenshot_dir = os.getenv("ARF_SCREENSHOT_DIR", "").strip()
    if screenshot_dir:
        Path(screenshot_dir).mkdir(parents=True, exist_ok=True)
    for theme_key, palette in THEMES.items():
        settings = copy.deepcopy(original)
        settings.update({"theme": theme_key, "font_size": "large", "density": "compact"})
        window.apply_user_settings(settings, persist=False)
        app.processEvents()
        stylesheet = window.styleSheet().upper()
        assert palette["background"].upper() in stylesheet
        assert palette["text"].upper() in stylesheet
        assert palette["accent"].upper() in stylesheet
        if screenshot_dir:
            window.resize(1100, 760)
            app.processEvents()
            window.grab().save(str(Path(screenshot_dir) / f"main_{theme_key}.png"))
            preview = SettingsDialog(window, window.user_settings, main_gui.FEEDBACK_URL)
            preview.show()
            app.processEvents()
            preview.grab().save(str(Path(screenshot_dir) / f"settings_{theme_key}.png"))
            preview.close()

    dialog = SettingsDialog(window, window.user_settings, main_gui.FEEDBACK_URL)
    collected = dialog.collect_settings()
    assert collected["theme"] in THEMES
    dialog.close()

    defaults_with_paths = copy.deepcopy(DEFAULT_SETTINGS)
    defaults_with_paths["default_prior_dir"] = "X:/prior"
    defaults_with_paths["default_output_dir"] = "X:/output"
    window.apply_user_settings(defaults_with_paths, persist=False)
    company = window.create_empty_company("测试公司")
    assert company["prior_path"] == "X:/prior"
    assert company["output_dir"] == "X:/output"

    with tempfile.TemporaryDirectory(prefix="arf-settings-") as temp_dir:
        settings_path = Path(temp_dir) / "settings.json"
        main_gui.save_settings(settings_path, defaults_with_paths)
        loaded = load_settings(settings_path)
        assert loaded["default_output_dir"] == "X:/output"

    window.apply_user_settings(original, persist=False)
    window.close()
    app.processEvents()
    _APP_STATE.cleanup()
    print(f"PASS: {len(THEMES)} themes, settings dialog, persistence and existing controls")


if __name__ == "__main__":
    run()
