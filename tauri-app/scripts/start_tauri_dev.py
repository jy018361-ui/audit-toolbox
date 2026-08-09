from __future__ import annotations

import os
import json
import shutil
import subprocess
import time
from pathlib import Path

from build_tauri_release import BUILD_ENV, load_msvc_environment


DEV_PORT = 1420


def _pwsh_json(script: str):
    pwsh = shutil.which("pwsh.exe") or shutil.which("pwsh")
    if not pwsh:
        raise RuntimeError("未找到 PowerShell 7，无法检查开发服务端口。")
    completed = subprocess.run(
        [pwsh, "-NoLogo", "-NoProfile", "-Command", script],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    text = completed.stdout.strip()
    if completed.returncode and not text:
        return None
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or "PowerShell 端口检查失败。")
    return json.loads(text) if text else None


def _as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _stop_stale_project_dev_server(root: Path) -> None:
    listeners = _as_list(
        _pwsh_json(
            f"Get-NetTCPConnection -LocalPort {DEV_PORT} -State Listen "
            "-ErrorAction SilentlyContinue | Select-Object OwningProcess | "
            "ConvertTo-Json -Compress"
        )
    )
    if not listeners:
        return

    processes = _as_list(
        _pwsh_json(
            "Get-CimInstance Win32_Process | "
            "Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | "
            "ConvertTo-Json -Compress"
        )
    )
    by_pid = {int(item["ProcessId"]): item for item in processes if item.get("ProcessId")}
    root_text = str(root.resolve()).replace("/", "\\").casefold()
    roots_to_stop: set[int] = set()
    for listener in listeners:
        pid = int(listener["OwningProcess"])
        process = by_pid.get(pid, {})
        command = str(process.get("CommandLine") or "").replace("/", "\\").casefold()
        if root_text not in command or "vite" not in command:
            name = process.get("Name") or "未知进程"
            raise RuntimeError(
                f"端口 {DEV_PORT} 被其他程序占用（PID {pid}，{name}）。"
                "请关闭该程序后重试。"
            )

        root_pid = pid
        current = process
        for _ in range(12):
            parent_pid = int(current.get("ParentProcessId") or 0)
            parent = by_pid.get(parent_pid)
            if not parent:
                break
            parent_command = str(parent.get("CommandLine") or "").replace("/", "\\").casefold()
            current = parent
            if root_text in parent_command and "@tauri-apps" in parent_command and "tauri" in parent_command and "dev" in parent_command:
                root_pid = parent_pid
                break
        roots_to_stop.add(root_pid)

    print(f"检测到上次未退出的开发服务（端口 {DEV_PORT}），正在安全清理……")
    for pid in sorted(roots_to_stop):
        subprocess.run(
            ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    for _ in range(30):
        remaining = _as_list(
            _pwsh_json(
                f"Get-NetTCPConnection -LocalPort {DEV_PORT} -State Listen "
                "-ErrorAction SilentlyContinue | Select-Object OwningProcess | "
                "ConvertTo-Json -Compress"
            )
        )
        if not remaining:
            print("旧开发服务已清理。")
            return
        time.sleep(0.1)
    raise RuntimeError(f"端口 {DEV_PORT} 仍未释放，请关闭旧版审计工具箱后重试。")


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    cargo = shutil.which("cargo") or str(Path.home() / ".cargo" / "bin" / "cargo.exe")
    if not npm:
        raise RuntimeError("未找到 Node.js/npm，请先安装 Node.js 22 x64。")
    if not Path(cargo).is_file():
        raise RuntimeError("未找到 Rust/Cargo，请先安装 rustup stable-msvc。")
    _stop_stale_project_dev_server(root)
    if not (root / "node_modules").is_dir():
        subprocess.check_call([npm, "ci", "--no-audit", "--no-fund"], cwd=root)
    load_msvc_environment()
    BUILD_ENV["PATH"] = str(Path(cargo).parent) + os.pathsep + BUILD_ENV.get("PATH", "")
    print("正在启动 Tauri 迁移版审计工具箱……关闭窗口后本命令会自动结束。")
    return subprocess.call([npm, "run", "tauri:dev"], cwd=root, env=BUILD_ENV)


if __name__ == "__main__":
    raise SystemExit(main())
