from __future__ import annotations

import base64
import ctypes
import os
import shutil
import sys
from pathlib import Path

from generate_wp_project_workbook import generate


APP_TITLE = "FY27 WP服务单生成工具"
REQUIRED_FILES = (
    "FY27 WP服务单.xlsx",
    "FY27 section list.xlsx",
    "SER配置.xlsx",
)

MB_OK = 0x00000000
MB_YESNO = 0x00000004
MB_ICONERROR = 0x00000010
MB_ICONQUESTION = 0x00000020
MB_ICONINFORMATION = 0x00000040
MB_TOPMOST = 0x00040000
IDYES = 6


def application_folder() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def resource_folder() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def message_box(message: str, flags: int) -> int:
    return ctypes.windll.user32.MessageBoxW(
        None, message, APP_TITLE, flags | MB_TOPMOST
    )


def ensure_template(folder: Path) -> Path:
    target = folder / "FY27+WP服务单.xlsx"
    if target.exists():
        return target
    source = resource_folder() / "templates" / "FY27+WP服务单.xlsx"
    if source.exists():
        shutil.copy2(source, target)
        return target

    encoded_source = Path(str(source) + ".b64")
    if not encoded_source.exists():
        raise FileNotFoundError("程序内未找到脱敏版服务方案模板。")
    target.write_bytes(base64.b64decode(encoded_source.read_text(encoding="ascii")))
    return target


def run_generation(folder: Path):
    ensure_template(folder)
    return generate(
        folder / "FY27 WP服务单.xlsx",
        folder / "FY27+WP服务单汇总.xlsx",
    )


def interactive_main():
    folder = application_folder()
    missing = [name for name in REQUIRED_FILES if not (folder / name).exists()]
    if missing:
        message_box(
            "缺少以下文件：\n\n"
            + "\n".join(missing)
            + "\n\n请将文件放在EXE所在文件夹后重试。",
            MB_OK | MB_ICONERROR,
        )
        return

    answer = message_box(
        "已找到WP服务单和Section List。\n\n"
        "点击“是”开始生成，通常需要10至30秒。",
        MB_YESNO | MB_ICONQUESTION,
    )
    if answer != IDYES:
        return

    try:
        result = run_generation(folder)
    except Exception as exc:
        message_box("生成失败：\n\n" + str(exc), MB_OK | MB_ICONERROR)
        return

    summary = (
        f"生成完成：{result['services']}张服务方案\n"
        f"AUD2026：{result['aud2026_rows']}个\n"
        f"IPO：{result['ipo_rows']}个\n"
        f"IPO archive：{result['ipo_archive_rows']}个\n\n"
        "是否打开结果文件夹？"
    )
    if message_box(summary, MB_YESNO | MB_ICONINFORMATION) == IDYES:
        os.startfile(folder)


def smoke_test():
    run_generation(application_folder())


if __name__ == "__main__":
    if "--smoke-test" in sys.argv:
        smoke_test()
    else:
        interactive_main()
