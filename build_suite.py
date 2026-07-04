"""
审计工具箱构建：同步工具源码 → PyInstaller 单文件 exe。
用法:
  python build_suite.py --sync-only
  python build_suite.py
  python build_suite.py --no-baseline   # 跳过单包体积对比
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor"
DIST = ROOT / "dist"
TOOLS = ROOT / "tools"
MODULES = ROOT / "modules"

# 旧版兼容：modules/、tools/ 均无时，尝试从这些路径同步
LEGACY_PATHS = {
    "fa_list": Path(r"C:\Users\Administrator\Downloads\备份FA\挤塑板"),
    "kanzhang": Path(r"C:\Users\Administrator\Downloads\看账小工具"),
}
KANZHANG_ENTRY = "看账小工具+4.0.py"

EXCLUDE_DIRS = {"build", "dist", "__pycache__", ".cursor", ".vscode", ".git"}
EXCLUDE_GLOBS = [
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

SECRET_SCAN_EXCLUDE_DIRS = {
    ".git",
    ".venv",
    "venv",
    "build",
    "dist",
    "__pycache__",
    ".cursor",
    ".vscode",
}
SECRET_FILE_NAME_PATTERNS = {
    ".env",
    ".env.*",
    "*llm_settings*.json",
    "*api_key*",
    "*apikey*",
    "*secret*",
    "*token*",
    "*credential*",
    "*credentials*",
}
SECRET_CONTENT_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"OPENAI_API_KEY\s*=", re.IGNORECASE),
    re.compile(r"Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]{20,}", re.IGNORECASE),
]
SECRET_BINARY_PATTERNS = [
    re.compile(rb"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(rb"OPENAI_API_KEY\s*=", re.IGNORECASE),
    re.compile(rb"Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]{20,}", re.IGNORECASE),
]


def _should_skip_file(name: str) -> bool:
    for pat in EXCLUDE_GLOBS:
        import fnmatch
        if fnmatch.fnmatch(name, pat):
            return True
    return False


def _matches_any_glob(name: str, patterns: set[str]) -> bool:
    import fnmatch

    lower = name.lower()
    return any(fnmatch.fnmatch(lower, pat) for pat in patterns)


def assert_no_packaged_secrets() -> None:
    """Fail fast if local secrets are accidentally placed under the project tree."""
    findings: list[str] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SECRET_SCAN_EXCLUDE_DIRS]
        rel_dir = Path(dirpath).relative_to(ROOT)
        for fname in filenames:
            path = Path(dirpath) / fname
            rel = rel_dir / fname
            if _matches_any_glob(fname, SECRET_FILE_NAME_PATTERNS):
                findings.append(f"敏感文件名: {rel}")
                continue
            try:
                if path.stat().st_size > 2 * 1024 * 1024:
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            if any(pattern.search(text) for pattern in SECRET_CONTENT_PATTERNS):
                findings.append(f"疑似密钥内容: {rel}")

    if findings:
        preview = "\n".join(f"- {item}" for item in findings[:20])
        extra = "" if len(findings) <= 20 else f"\n- 另有 {len(findings) - 20} 项未显示"
        raise RuntimeError(
            "打包已中止：项目目录中发现疑似 API 密钥或敏感配置，不能写入 exe。\n"
            f"{preview}{extra}\n\n"
            "请将真实密钥只保存在 %APPDATA%\\AuditToolbox\\llm_settings.json "
            "或环境变量中，不要放在项目目录、tools/ 或 modules/ 下。"
        )


def _load_local_runtime_api_key() -> str:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return ""
    settings = Path(appdata) / "AuditToolbox" / "llm_settings.json"
    try:
        data = json.loads(settings.read_text(encoding="utf-8"))
    except Exception:
        return ""
    if not isinstance(data, dict):
        return ""
    return str(data.get("api_key") or "")


def assert_built_exe_has_no_secrets(exe: Path) -> None:
    data = exe.read_bytes()
    findings: list[str] = []
    local_key = _load_local_runtime_api_key()
    if local_key:
        if local_key.encode("utf-8") in data or local_key.encode("utf-16le") in data:
            findings.append("当前本机 AppData 中保存的 LLM API Key")
    if any(pattern.search(data) for pattern in SECRET_BINARY_PATTERNS):
        findings.append("疑似明文 OpenAI/API Key 形态")
    if findings:
        raise RuntimeError(
            "打包已中止：生成的 exe 中发现疑似 API 密钥，已拒绝发布。\n"
            + "\n".join(f"- {item}" for item in findings)
            + "\n\n请删除 dist/build 后重新打包，并立即轮换已暴露的密钥。"
        )


def _sync_directory(src: Path, dest: Path) -> None:
    """将 src 目录内容同步到 dest，排除不需要的文件。"""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        rel = Path(dirpath).relative_to(src)
        for fname in filenames:
            if _should_skip_file(fname):
                continue
            src_file = Path(dirpath) / fname
            out = dest / rel / fname
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_file, out)


def _find_tool_source(tool_id: str) -> tuple[Path | None, str]:
    """按 modules → tools → 旧版路径 查找源码目录。"""
    modules_dir = MODULES / tool_id
    if modules_dir.is_dir():
        return modules_dir, "modules"
    tools_dir = TOOLS / tool_id
    if tools_dir.is_dir():
        return tools_dir, "tools"
    if tool_id in LEGACY_PATHS:
        legacy = LEGACY_PATHS[tool_id]
        if legacy.is_dir():
            return legacy, "legacy"
    return None, ""


def sync_tool(tool_id: str, dest: Path) -> None:
    """同步单个工具到 vendor 目录。"""
    src, label = _find_tool_source(tool_id)
    if src is not None:
        print(f"同步 {tool_id} (从 {label}/) ...")
        _sync_directory(src, dest)
        return

    print(f"警告: 找不到 {tool_id} 的源码（请放入 modules/{tool_id} 或 tools/{tool_id}），跳过同步")


def sync_vendor() -> None:
    """从 modules/、tools/ 或旧版路径同步所有工具到 vendor/。"""
    config_path = ROOT / "tools.json"
    if config_path.is_file():
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        tools = config.get("tools", [])
    else:
        tools = [{"vendor_dir": "fa_list"}, {"vendor_dir": "kanzhang"}]

    for tool in tools:
        vendor_dir = tool.get("vendor_dir", "")
        if not vendor_dir:
            continue
        dest = VENDOR / vendor_dir
        sync_tool(vendor_dir, dest)

    print("vendor 同步完成.")


def _mb(path: Path) -> float:
    return path.stat().st_size / (1024 * 1024)


def _latest_exe(folder: Path) -> Path | None:
    if not folder.is_dir():
        return None
    exes = sorted(folder.glob("*.exe"), key=lambda p: p.stat().st_mtime, reverse=True)
    return exes[0] if exes else None


def build_fa_baseline(py: str) -> Path | None:
    spec = LEGACY_PATHS.get("fa_list", ROOT) / "main.spec"
    if not spec.is_file():
        print("跳过 FA 基线: 无 main.spec")
        return None
    print("构建 FA 单包基线 ...")
    subprocess.check_call(
        [py, "-m", "PyInstaller", str(spec), "--noconfirm", "--clean"],
        cwd=str(spec.parent),
    )
    return _latest_exe(spec.parent / "dist")


def build_kanzhang_baseline(py: str) -> Path | None:
    src = LEGACY_PATHS.get("kanzhang", ROOT) / KANZHANG_ENTRY
    if not src.is_file():
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
            str(src),
        ],
        cwd=str(src.parent),
    )
    return _latest_exe(src.parent / "dist")


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
    parser.add_argument("--sync-only", action="store_true", help="同步工具到 vendor/（默认不再自动同步）")
    parser.add_argument(
        "--no-baseline", action="store_true", help="跳过 FA/看账单包基线对比"
    )
    parser.add_argument("--no-pip", action="store_true", help="跳过 pip install")
    args = parser.parse_args()

    py = sys.executable
    os.chdir(ROOT)

    if not MODULES.is_dir():
        MODULES.mkdir(parents=True)
        (MODULES / ".gitkeep").touch(exist_ok=True)
    if not TOOLS.is_dir():
        TOOLS.mkdir(parents=True)

    if args.sync_only:
        sync_vendor()
        return 0

    assert_no_packaged_secrets()

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
    assert_built_exe_has_no_secrets(suite_exe)
    print_size_report(fa_exe, kz_exe, suite_exe)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
