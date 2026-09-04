from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import json
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
LEGACY_ROOT = ROOT.parent
BUILD = ROOT / "build"
DIST = ROOT / "dist"
TAURI_TARGET = BUILD / "tauri-cargo-target"
VERSION = "2.0.0-alpha.48"
BUILD_ENV = os.environ.copy()


def run(command: list[str], *, cwd: Path = ROOT) -> None:
    print("运行:", " ".join(command))
    subprocess.check_call(command, cwd=cwd, env=BUILD_ENV)


def require(command: str, hint: str) -> str:
    value = shutil.which(command)
    if not value:
        raise RuntimeError(f"缺少 {command}。{hint}")
    return value


def load_msvc_environment() -> None:
    if os.name != "nt":
        return
    vswhere = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft Visual Studio" / "Installer" / "vswhere.exe"
    if not vswhere.is_file():
        raise RuntimeError("缺少 Visual Studio Build Tools。请安装 C++ Build Tools 和 Windows SDK。")
    install = subprocess.check_output([
        str(vswhere), "-latest", "-products", "*", "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath",
    ], text=True, encoding="utf-8", errors="replace").strip()
    if not install:
        raise RuntimeError("Visual Studio Build Tools 未安装 C++ x64 工具集。")
    developer = Path(install) / "Common7" / "Tools" / "VsDevCmd.bat"
    output = subprocess.check_output(
        f'cmd.exe /d /c ""{developer}" -arch=x64 -host_arch=x64 >nul && set"',
        text=True, encoding="mbcs", errors="replace",
    )
    for line in output.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            BUILD_ENV[key] = value
    # Windows environment keys are case-insensitive, while Python dictionaries
    # are not. VsDevCmd returns `Path`, so collapse duplicate PATH spellings.
    normalized_path = BUILD_ENV.get("Path") or BUILD_ENV.get("PATH", "")
    for key in [key for key in BUILD_ENV if key.lower() == "path"]:
        del BUILD_ENV[key]
    BUILD_ENV["PATH"] = normalized_path


def test_all(python: str, npm: str, cargo: str, *, legacy_regression: bool = False) -> None:
    # The production Tauri project is self-contained. Historical Python and
    # Electron baselines remain available as an explicit migration audit only.
    if legacy_regression:
        run([python, "-m", "pytest", "-q", "tests"], cwd=LEGACY_ROOT)
        run([npm, "test", "--prefix", str(LEGACY_ROOT / "modules" / "AudiPick")])
    run([npm, "test"])
    run([cargo, "test", "--manifest-path", "src-tauri/Cargo.toml"])
    if os.name == "nt":
        run([
            cargo, "test", "--manifest-path", "src-tauri/Cargo.toml",
            "excel_com_preserves_formula_and_sheet_order", "--", "--ignored",
        ])


def build_desktop(npm: str, cargo: str, *, reuse_dependencies: bool = False) -> Path:
    if reuse_dependencies:
        if not (ROOT / "node_modules").is_dir():
            raise RuntimeError("要求复用前端依赖，但 node_modules 不存在。")
        print("复用当前 node_modules（仅用于开发窗口占用依赖时继续打包）")
    else:
        run([npm, "ci", "--no-audit", "--no-fund"])
    # Tauri CLI sets the production build configuration and embeds frontendDist.
    # A plain `cargo build --release` leaves the WebView pointed at devUrl.
    run([npm, "run", "tauri:build"])
    source = TAURI_TARGET / "release" / "audit-toolbox.exe"
    if not source.is_file():
        raise RuntimeError(f"Tauri 构建后未找到 {source}")
    installers = sorted((TAURI_TARGET / "release" / "bundle" / "nsis").glob("*-setup.exe"))
    if not installers:
        raise RuntimeError("Tauri 构建后未找到 NSIS 安装包。请确认 bundle.targets=nsis。")
    # bundle/nsis 会累积历史版本的安装包，必须按本次 VERSION 精确匹配，
    # 不能取 sorted[0]（否则会拿到字母序最前的旧版本安装包拷进 dist）。
    installers = [p for p in installers if f"_{VERSION}_" in p.name]
    if not installers:
        raise RuntimeError(f"Tauri 构建后未找到 v{VERSION} 的 NSIS 安装包。")
    DIST.mkdir(parents=True, exist_ok=True)
    runtime_target = DIST / f"E点通工具箱-v{VERSION}-runtime-win-x64.exe"
    installer_target = DIST / f"E点通工具箱-v{VERSION}-win-x64-setup.exe"
    shutil.copy2(source, runtime_target)
    shutil.copy2(installers[0], installer_target)
    signature = installers[0].with_suffix(installers[0].suffix + ".sig")
    if signature.is_file():
        shutil.copy2(signature, installer_target.with_suffix(installer_target.suffix + ".sig"))
    digest = hashlib.sha256(installer_target.read_bytes()).hexdigest()
    installer_target.with_suffix(installer_target.suffix + ".sha256").write_text(
        f"{digest}  {installer_target.name}\n", encoding="utf-8"
    )
    return runtime_target


def worker_events(result: subprocess.CompletedProcess[str]) -> list[dict]:
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def run_worker(target: Path, request: dict, *, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(target), "--excel-merger-worker"],
        input=json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n",
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def assert_worker_completed(result: subprocess.CompletedProcess[str], output: Path, label: str) -> None:
    events = worker_events(result)
    if result.returncode != 0 or not output.is_file() or not any(row.get("phase") == "completed" for row in events):
        detail = result.stderr[-1000:] or result.stdout[-1000:]
        raise RuntimeError(f"{label} Rust worker 验收失败：{detail}")


def runtime_snapshot(root: Path) -> set[str]:
    if not root.is_dir():
        return set()
    return {str(path.relative_to(root)) for path in root.rglob("*")}


def assert_windows_gui_subsystem(target: Path) -> None:
    """Fail release validation when Windows would allocate a console window."""
    data = target.read_bytes()
    if len(data) < 0x40 or data[:2] != b"MZ":
        raise RuntimeError(f"发布文件不是有效的 Windows PE 程序：{target}")
    pe_offset = int.from_bytes(data[0x3C:0x40], "little")
    optional_header = pe_offset + 24
    subsystem_offset = optional_header + 68
    if data[pe_offset:pe_offset + 4] != b"PE\0\0" or len(data) < subsystem_offset + 2:
        raise RuntimeError(f"发布文件的 PE 头不完整：{target}")
    subsystem = int.from_bytes(data[subsystem_offset:subsystem_offset + 2], "little")
    if subsystem != 2:  # IMAGE_SUBSYSTEM_WINDOWS_GUI
        raise RuntimeError(
            f"发布 EXE 仍是控制台子系统（值 {subsystem}），用户双击时会出现黑色 CLI 窗口。"
        )


def smoke_test_desktop(target: Path) -> None:
    if os.name != "nt":
        return
    assert_windows_gui_subsystem(target)
    print("Windows GUI 子系统验收通过：双击 EXE 不会创建控制台窗口")
    with tempfile.TemporaryDirectory(prefix="audit-rust-release-smoke-") as temp:
        smoke_root = Path(temp)
        first = smoke_root / "输入一.csv"
        second = smoke_root / "输入二.csv"
        output = smoke_root / "Rust合并验收.xlsx"
        first.write_text("编号,金额\n1,100\n", encoding="utf-8-sig")
        second.write_text("编号,金额\n2,200\n", encoding="utf-8-sig")
        request = {
            "jobId": "release-rust-smoke",
            "method": "excel_merger.merge",
            "cancelPath": str(smoke_root / "cancel.flag"),
            "pausePath": str(smoke_root / "pause.flag"),
            "params": {
                "inputPaths": [str(first), str(second)],
                "outputPath": str(output),
                "outputFormat": "xlsx",
                "outputMode": "one_sheet",
                "direction": "vertical",
                "sheetAction": "default",
                "targetSheets": [],
                "addHyperlinks": False,
            },
        }
        worker = subprocess.run(
            [str(target), "--excel-merger-worker"],
            input=json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n",
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=30,
            check=False,
        )
        events = [json.loads(line) for line in worker.stdout.splitlines() if line.strip()]
        if worker.returncode != 0 or not output.is_file() or not any(row.get("phase") == "completed" for row in events):
            raise RuntimeError(f"Rust Excel worker 冷启动验收失败：{worker.stderr[-1000:]}")
        print("Rust Excel worker 冷启动验收通过")
        timesheet = smoke_root / "Timesheet样例.csv"
        timesheet_output = smoke_root / "TS透视验收.xlsx"
        timesheet.write_text(
            "COE Manager,Employee Name,Engagement Name,Transaction Cycle Date,Hours\n"
            "经理A,员工甲,项目一,2026-01,2.5\n经理A,员工甲,项目一,2026-01,1.5\n",
            encoding="utf-8-sig",
        )
        ts_request = {
            "jobId": "release-ts-smoke", "method": "ts.export",
            "cancelPath": str(smoke_root / "ts-cancel.flag"),
            "pausePath": str(smoke_root / "ts-pause.flag"),
            "params": {"inputPath": str(timesheet), "outputPath": str(timesheet_output), "pivotMode": "dual_default", "filters": []},
        }
        ts_worker = subprocess.run(
            [str(target), "--rust-table-worker"], input=json.dumps(ts_request, ensure_ascii=False) + "\n",
            text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=30, check=False,
        )
        ts_events = [json.loads(line) for line in ts_worker.stdout.splitlines() if line.strip()]
        if ts_worker.returncode != 0 or not timesheet_output.is_file() or not any(row.get("phase") == "completed" for row in ts_events):
            raise RuntimeError(f"Rust Polars TS worker 验收失败：{ts_worker.stderr[-1000:]}")
        ledger = smoke_root / "凭证样例.csv"
        ledger_output = smoke_root / "看账验收.xlsx"
        ledger.write_text(
            "凭证号,科目名称,借方金额,贷方金额\n"
            "1,收入,100,0\n1,银行,0,100\n"
            "2,费用,20,0\n2,银行,0,20\n"
            "3,本年利润,50,0\n3,收入,0,50\n"
            "4,收入,0,100\n4,银行,100,0\n",
            encoding="utf-8-sig",
        )
        ledger_request = {
            "jobId": "release-ledger-smoke", "method": "kanzhang.export",
            "cancelPath": str(smoke_root / "ledger-cancel.flag"),
            "pausePath": str(smoke_root / "ledger-pause.flag"),
            "params": {
                "inputPath": str(ledger), "outputPath": str(ledger_output),
                "targetBatches": [{"name": "收入", "accounts": ["收入"]}, {"name": "费用", "accounts": ["费用"]}],
                "includePivot": True, "includeVoucherTypes": True,
                "markLossTransfer": True, "enableJeMatching": True,
            },
        }
        ledger_worker = subprocess.run(
            [str(target), "--rust-table-worker"], input=json.dumps(ledger_request, ensure_ascii=False) + "\n",
            text=True, encoding="utf-8", errors="replace", capture_output=True, timeout=30, check=False,
        )
        ledger_events = [json.loads(line) for line in ledger_worker.stdout.splitlines() if line.strip()]
        second_batch = smoke_root / "看账验收_费用_02.xlsx"
        completed = next((row for row in ledger_events if row.get("phase") == "completed"), {})
        if ledger_worker.returncode != 0 or not ledger_output.is_file() or not second_batch.is_file() or completed.get("result", {}).get("batchCount") != 2:
            raise RuntimeError(f"Rust Polars 看账 worker 验收失败：{ledger_worker.stderr[-1000:]}")
        # 与旧版一致的两阶段导出：明细一个工作簿，套表另一个工作簿。
        ledger_suite = smoke_root / "看账验收_套表.xlsx"
        if not ledger_suite.is_file():
            raise RuntimeError("Rust Polars 看账验收失败：未产出套表文件。")
        with zipfile.ZipFile(ledger_output) as workbook_zip:
            detail_xml = workbook_zip.read("xl/workbook.xml").decode("utf-8")
        if "凭证明细" not in detail_xml:
            raise RuntimeError("Rust Polars 看账明细验收失败：缺少凭证明细 Sheet。")
        with zipfile.ZipFile(ledger_suite) as workbook_zip:
            suite_xml = workbook_zip.read("xl/workbook.xml").decode("utf-8")
        required_sheets = ["科目汇总", "凭证", "凭证类型-宽松", "凭证类型-严格"]
        if not all(name in suite_xml for name in required_sheets):
            raise RuntimeError("Rust Polars 看账高级套表验收失败：缺少预期 Sheet。")
        print("Rust Polars TS/看账 worker 冷启动验收通过")
        # FA List, WP 服务单和 Roll Forward 均通过发布 EXE 自身的 Rust
        # worker 入口验收，避免编译期测试通过但发布包缺少业务代码。
        fa_begin = smoke_root / "FA期初.csv"
        fa_end = smoke_root / "FA期末.csv"
        fa_output = smoke_root / "FA_List_验收.xlsx"
        header = "卡片编号,资产类别,资产名称,原值,累计折旧,开始使用日期,使用寿命,残值率"
        fa_begin.write_text(
            header + "\nA001,机器设备,设备甲,1000,200,2024-01-01,60,0.05\n",
            encoding="utf-8-sig",
        )
        fa_end.write_text(
            header + ",本年折旧\nA001,机器设备,设备甲,1000,300,2024-01-01,60,0.05,100\n",
            encoding="utf-8-sig",
        )
        begin_mapping = {
            "category": "资产类别", "name": "资产名称",
            "originalValue": "原值", "depreciation": "累计折旧",
            "startDate": "开始使用日期", "life": "使用寿命",
            "residualRate": "残值率",
        }
        fa_request = {
            "jobId": "release-fa-export-smoke", "method": "fa.export",
            "cancelPath": str(smoke_root / "fa-cancel.flag"),
            "pausePath": str(smoke_root / "fa-pause.flag"),
            "params": {
                "beginPath": str(fa_begin), "endPath": str(fa_end),
                "beginKeys": ["卡片编号"], "endKeys": ["卡片编号"],
                "beginMapping": begin_mapping,
                "endMapping": dict(begin_mapping, currentYearDep="本年折旧"),
                "beginOriginalValue": "原值", "endOriginalValue": "原值",
                "beginDepreciation": "累计折旧", "endDepreciation": "累计折旧",
                "endResidualRate": "残值率", "beginDisplayName": "期初",
                "endDisplayName": "期末", "balanceSheetDate": "2025-12-31",
                "outputPath": str(fa_output),
            },
        }
        fa_worker = run_worker(target, fa_request, timeout=90)
        assert_worker_completed(fa_worker, fa_output, "FA List 导出")

        samples = ROOT / "tests" / "fixtures"
        wp_sample = samples / "WP服务单"
        wp_root = smoke_root / "WP服务单"
        wp_root.mkdir()
        for name in ["FY27 WP服务单.xlsx", "FY27 section list.xlsx", "FY27+WP服务单.xlsx"]:
            source = wp_sample / name
            if not source.is_file():
                raise RuntimeError(f"缺少打包验收样例：{source}")
            shutil.copy2(source, wp_root / name)
        wp_output = wp_root / "WP发布包验收.xlsx"
        wp_request = {
            "jobId": "release-wp-smoke", "method": "wp.generate",
            "cancelPath": str(smoke_root / "wp-cancel.flag"),
            "pausePath": str(smoke_root / "wp-pause.flag"),
            "params": {"folder": str(wp_root), "outputPath": str(wp_output)},
        }
        wp_worker = run_worker(target, wp_request, timeout=120)
        assert_worker_completed(wp_worker, wp_output, "WP 服务单")

        rf_sample = samples / "Audit Roll Forward"
        rf_root = smoke_root / "roll-forward-sample"
        shutil.copytree(rf_sample / "templates", rf_root / "templates")
        shutil.copytree(rf_sample / "prior", rf_root / "prior")
        rf_output = smoke_root / "RollForward输出"
        rf_request = {
            "jobId": "release-roll-forward-smoke", "method": "roll_forward.process",
            "cancelPath": str(smoke_root / "rf-cancel.flag"),
            "pausePath": str(smoke_root / "rf-pause.flag"),
            "params": {
                "templateDir": str(rf_root / "templates"),
                "priorDir": str(rf_root / "prior"),
                "outputDir": str(rf_output), "subjectCodes": ["C"],
                # The checked-in prior-year fixture is named for 样例公司;
                # keep the smoke request aligned so file discovery exercises
                # the real production matcher instead of returning no output.
                "companyName": "样例公司", "bsDate": "2026-12-31",
                "generateSummary": True,
            },
        }
        rf_worker = run_worker(target, rf_request, timeout=120)
        rf_events = worker_events(rf_worker)
        rf_outputs = next(
            (row.get("outputPaths", []) for row in rf_events if row.get("phase") == "completed"),
            [],
        )
        if rf_worker.returncode != 0 or not rf_outputs or not all(Path(path).is_file() for path in rf_outputs):
            detail = rf_worker.stderr[-1000:] or rf_worker.stdout[-1000:]
            raise RuntimeError(f"Audit Roll Forward Rust worker 验收失败：{detail}")
        print("FA/WP/Roll Forward Rust worker 冷启动验收通过")

    local_app_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    runtime_root = local_app_data / "AuditToolbox" / "AuditToolbox" / "data" / "runtime"
    before_runtime = runtime_snapshot(runtime_root)
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    process = subprocess.Popen([str(target)], startupinfo=startup)
    try:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        if process.poll() == 0:
            raise RuntimeError("Tauri 冷启动窗口提前退出。请先关闭正在运行的旧版工具箱后重试。")
        if process.poll() is not None:
            raise RuntimeError(f"Tauri 单文件冷启动失败，退出码：{process.returncode}")
        child_probe = subprocess.run(
            ["pwsh", "-NoLogo", "-NoProfile", "-Command",
             f"@(Get-CimInstance Win32_Process -Filter 'ParentProcessId={process.pid}' | Where-Object Name -eq 'audit-engine.exe').Count"],
            text=True, capture_output=True, check=False,
        )
        if child_probe.stdout.strip() not in ("", "0"):
            raise RuntimeError("全 Rust 发布包仍启动了 audit-engine.exe 子进程。")
        after_runtime = runtime_snapshot(runtime_root)
        if after_runtime - before_runtime:
            raise RuntimeError(f"全 Rust 发布包仍创建 Python runtime 文件：{sorted(after_runtime - before_runtime)[:5]}")
        print("Tauri Rust 原生冷启动验收通过：未启动 Python sidecar，未释放 Python runtime")
    finally:
        subprocess.run(
            ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="构建严格单文件 Tauri 审计工具箱")
    parser.add_argument("--skip-tests", action="store_true")
    parser.add_argument("--reuse-dependencies", action="store_true")
    parser.add_argument("--smoke-only", action="store_true")
    parser.add_argument(
        "--legacy-regression",
        action="store_true",
        help="额外运行上一级旧 Python/Electron 金标；不影响 Tauri 独立构建",
    )
    args = parser.parse_args()
    if args.smoke_only:
        target = DIST / f"E点通工具箱-v{VERSION}-runtime-win-x64.exe"
        if not target.is_file():
            raise RuntimeError(f"未找到待验收程序：{target}")
        smoke_test_desktop(target)
        print(f"冷启动验收通过: {target}")
        return 0
    python = sys.executable
    npm = require("npm", "请安装 Node.js 22。")
    cargo = shutil.which("cargo") or str(Path.home() / ".cargo" / "bin" / "cargo.exe")
    if not Path(cargo).is_file():
        raise RuntimeError("缺少 Rust/Cargo，请先安装 rustup stable-msvc。")
    load_msvc_environment()
    BUILD_ENV["PATH"] = str(Path(cargo).parent) + os.pathsep + BUILD_ENV.get("PATH", "")
    BUILD_ENV["CARGO_TARGET_DIR"] = str(TAURI_TARGET)
    if not args.skip_tests:
        test_all(python, npm, cargo, legacy_regression=args.legacy_regression)
    target = build_desktop(npm, cargo, reuse_dependencies=args.reuse_dependencies)
    smoke_test_desktop(target)
    installer = DIST / f"E点通工具箱-v{VERSION}-win-x64-setup.exe"
    print(f"\n构建完成: {installer}\n体积: {installer.stat().st_size / 1024 / 1024:.1f} MiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
