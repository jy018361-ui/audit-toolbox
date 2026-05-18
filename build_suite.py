"""
审计工具箱构建：同步 vendor 源码 → PyInstaller 单文件 exe。
用法:
  python build_suite.py --sync-only
  python build_suite.py
  python build_suite.py --no-baseline   # 跳过单包体积对比
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor"
DIST = ROOT / "dist"

FA_SRC = Path(r"C:\Users\Administrator\Downloads\备份FA\挤塑板")
KANZHANG_SRC = Path(r"C:\Users\Administrator\Downloads\看账小工具")
KANZHANG_ENTRY = "看账小工具+4.0.py"

FA_EXCLUDE_DIRS = {"build", "dist", "__pycache__", ".cursor", ".vscode", ".git"}
FA_EXCLUDE_GLOBS = [
    "test_*.py",
    "*_recovered.py",
    "*_restored*.py",
    "*_wrapper_broken.py",
    "run_sample_then_build.py",
    "start_ev_recording.py",
    "build_exe.py",
    "main.spec",
    "*.bat",
    "ev_capture_config.txt",
]


def _should_skip_file(name: str) -> bool:
    for pat in FA_EXCLUDE_GLOBS:
        if fnmatch.fnmatch(name, pat):
            return True
    return False


def sync_fa_list(dest: Path) -> None:
    if not FA_SRC.is_dir():
        raise FileNotFoundError(f"FA 源码目录不存在: {FA_SRC}")
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    for dirpath, dirnames, filenames in os.walk(FA_SRC):
        dirnames[:] = [d for d in dirnames if d not in FA_EXCLUDE_DIRS]
        rel = Path(dirpath).relative_to(FA_SRC)
        for fname in filenames:
            if _should_skip_file(fname):
                continue
            src = Path(dirpath) / fname
            out = dest / rel / fname
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, out)


def sync_kanzhang(dest: Path) -> None:
    if not KANZHANG_SRC.is_dir():
        raise FileNotFoundError(f"看账源码目录不存在: {KANZHANG_SRC}")
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    src_file = KANZHANG_SRC / KANZHANG_ENTRY
    if not src_file.is_file():
        raise FileNotFoundError(src_file)
    shutil.copy2(src_file, dest / "kanzhang_app.py")


def sync_vendor() -> None:
    print("同步 vendor/fa_list ...")
    sync_fa_list(VENDOR / "fa_list")
    print("同步 vendor/kanzhang ...")
    sync_kanzhang(VENDOR / "kanzhang")
    print("vendor 同步完成.")


def _mb(path: Path) -> float:
    return path.stat().st_size / (1024 * 1024)


def _latest_exe(folder: Path) -> Path | None:
    if not folder.is_dir():
        return None
    exes = sorted(folder.glob("*.exe"), key=lambda p: p.stat().st_mtime, reverse=True)
    return exes[0] if exes else None


def build_fa_baseline(py: str) -> Path | None:
    spec = FA_SRC / "main.spec"
    if not spec.is_file():
        print("跳过 FA 基线: 无 main.spec")
        return None
    print("构建 FA 单包基线 ...")
    subprocess.check_call(
        [py, "-m", "PyInstaller", str(spec), "--noconfirm", "--clean"],
        cwd=str(FA_SRC),
    )
    return _latest_exe(FA_SRC / "dist")


def build_kanzhang_baseline(py: str) -> Path | None:
    entry = KANZHANG_SRC / KANZHANG_ENTRY
    if not entry.is_file():
        print("跳过看账基线: 入口不存在")
        return None
    print("构建看账单包基线 ...")
    out_name = "看账小工具_基线"
    subprocess.check_call(
        [
            py,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onefile",
            "--windowed",
            "--name",
            out_name,
            str(entry),
        ],
        cwd=str(KANZHANG_SRC),
    )
    return _latest_exe(KANZHANG_SRC / "dist")


def build_suite(py: str) -> Path:
    spec = ROOT / "suite.spec"
    if not spec.is_file():
        raise FileNotFoundError(spec)
    print("构建审计工具箱 ...")
    subprocess.check_call(
        [py, "-m", "PyInstaller", str(spec), "--noconfirm", "--clean"],
        cwd=str(ROOT),
    )
    exe = _latest_exe(DIST)
    if not exe:
        raise RuntimeError("dist 下未找到 exe")
    return exe


def print_size_report(fa: Path | None, kz: Path | None, suite: Path) -> None:
    print()
    print("=" * 56)
    print("体积对比 (MB)")
    print("=" * 56)
    s_suite = _mb(suite)
    print(f"  审计工具箱:     {s_suite:8.1f}  {suite}")
    sum_parts = 0.0
    if fa:
        s_fa = _mb(fa)
        sum_parts += s_fa
        print(f"  FA 单包:        {s_fa:8.1f}  {fa}")
    if kz:
        s_kz = _mb(kz)
        sum_parts += s_kz
        print(f"  看账单包:       {s_kz:8.1f}  {kz}")
    if sum_parts > 0:
        ratio = s_suite / sum_parts
        ok = "✓ 1+1<2" if s_suite < sum_parts else "未达 1+1<2"
        print(f"  单包之和:       {sum_parts:8.1f}")
        print(f"  套件/之和:      {ratio:8.1%}  ({ok})")
    print("=" * 56)


def main() -> int:
    parser = argparse.ArgumentParser(description="审计工具箱构建")
    parser.add_argument("--sync-only", action="store_true", help="仅同步 vendor")
    parser.add_argument(
        "--no-baseline", action="store_true", help="跳过 FA/看账单包基线对比"
    )
    parser.add_argument("--no-pip", action="store_true", help="跳过 pip install")
    args = parser.parse_args()

    py = sys.executable
    os.chdir(ROOT)

    sync_vendor()
    if args.sync_only:
        return 0

    req = ROOT / "requirements.txt"
    if not args.no_pip and req.is_file():
        print("安装依赖 ...")
        subprocess.check_call([py, "-m", "pip", "install", "-U", "pip"])
        subprocess.check_call([py, "-m", "pip", "install", "-r", str(req)])

    fa_exe = kz_exe = None
    if not args.no_baseline:
        try:
            fa_exe = build_fa_baseline(py)
        except subprocess.CalledProcessError as e:
            print(f"FA 基线构建失败 (可忽略): {e}")
        try:
            kz_exe = build_kanzhang_baseline(py)
        except subprocess.CalledProcessError as e:
            print(f"看账基线构建失败 (可忽略): {e}")

    suite_exe = build_suite(py)
    print_size_report(fa_exe, kz_exe, suite_exe)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
