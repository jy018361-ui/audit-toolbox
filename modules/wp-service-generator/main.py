"""audit-toolbox adapter for the FY27 WP service order generator."""

from pathlib import Path
from tkinter import filedialog, messagebox

from FY27_WP服务单生成工具 import ensure_template, run_generation


def main(parent=None):
    selected = filedialog.askdirectory(
        parent=parent,
        title="选择包含FY27 WP服务单和Section List的文件夹",
    )
    if not selected:
        return

    folder = Path(selected)
    required = ("FY27 WP服务单.xlsx", "FY27 section list.xlsx")
    missing = [name for name in required if not (folder / name).exists()]
    if missing:
        messagebox.showerror(
            "FY27 WP服务单生成工具",
            "缺少以下文件：\n\n" + "\n".join(missing),
            parent=parent,
        )
        return

    try:
        ensure_template(folder)
        result = run_generation(folder)
    except Exception as exc:
        messagebox.showerror(
            "FY27 WP服务单生成工具",
            "生成失败：\n\n" + str(exc),
            parent=parent,
        )
        return

    messagebox.showinfo(
        "FY27 WP服务单生成工具",
        (
            f"生成完成：{result['services']}张服务方案\n"
            f"AUD2026：{result['aud2026_rows']}个\n"
            f"IPO：{result['ipo_rows']}个\n"
            f"IPO archive：{result['ipo_archive_rows']}个\n\n"
            "输出文件：FY27+WP服务单汇总.xlsx"
        ),
        parent=parent,
    )


if __name__ == "__main__":
    main()
