"""Windows x64：在 Job Object 内运行真实看账 worker，采样并保护性终止。

仅使用 Python 标准库，不修改源 CSV。诊断日志可能含预览数据，请留在本机。
python scripts/diagnose_kanzhang_import.py --exe <EXE> --input <CSV> --out <新目录>
"""
import argparse
import ctypes as c
from ctypes import wintypes as w
import csv
import datetime
import json
from pathlib import Path
import subprocess
import time

GIB = 1024 ** 3
k = c.WinDLL("kernel32", use_last_error=True)
ps = c.WinDLL("psapi", use_last_error=True)


class Memory(c.Structure):
    _fields_ = [("length", w.DWORD), ("load", w.DWORD)] + [
        (n, c.c_ulonglong) for n in ("total", "available", "commit_limit", "commit_available", "virtual", "virtual_available", "extended")]


class ProcessMemory(c.Structure):
    _fields_ = [("cb", w.DWORD), ("faults", w.DWORD)] + [
        (n, c.c_size_t) for n in ("peak_ws", "ws", "peak_paged", "paged", "peak_nonpaged", "nonpaged", "pagefile", "peak_pagefile", "private")]


class IO(c.Structure):
    _fields_ = [(n, c.c_ulonglong) for n in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]


class BasicLimit(c.Structure):
    _fields_ = [("process_time", c.c_longlong), ("job_time", c.c_longlong), ("flags", w.DWORD),
                ("min_ws", c.c_size_t), ("max_ws", c.c_size_t), ("active", w.DWORD),
                ("affinity", c.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]


class Limits(c.Structure):
    _fields_ = [("basic", BasicLimit), ("io", IO)] + [(n, c.c_size_t) for n in
                ("process_memory", "job_memory", "peak_process", "peak_job")]


def bind(lib, name, args, result=w.BOOL):
    fn = getattr(lib, name)
    fn.argtypes, fn.restype = args, result
    return fn


create_job = bind(k, "CreateJobObjectW", [c.c_void_p, w.LPCWSTR], w.HANDLE)
set_job = bind(k, "SetInformationJobObject", [w.HANDLE, c.c_int, c.c_void_p, w.DWORD])
assign = bind(k, "AssignProcessToJobObject", [w.HANDLE, w.HANDLE])
close = bind(k, "CloseHandle", [w.HANDLE])
terminate = bind(k, "TerminateJobObject", [w.HANDLE, w.UINT])
global_mem = bind(k, "GlobalMemoryStatusEx", [c.POINTER(Memory)])
process_mem = bind(ps, "GetProcessMemoryInfo", [w.HANDLE, c.POINTER(ProcessMemory), w.DWORD])
process_io = bind(k, "GetProcessIoCounters", [w.HANDLE, c.POINTER(IO)])
process_times = bind(k, "GetProcessTimes", [w.HANDLE] + [c.POINTER(w.FILETIME)] * 4)


def checked(ok):
    if not ok:
        raise c.WinError(c.get_last_error())
    return ok


def memory():
    m = Memory()
    m.length = c.sizeof(m)
    checked(global_mem(c.byref(m)))
    return m


def sample(handle, started):
    m = memory()
    p = ProcessMemory()
    p.cb = c.sizeof(p)
    checked(process_mem(handle, c.byref(p), p.cb))
    io = IO()
    checked(process_io(handle, c.byref(io)))
    times = [w.FILETIME() for _ in range(4)]
    checked(process_times(handle, *[c.byref(t) for t in times]))
    cpu = sum((t.dwHighDateTime << 32) + t.dwLowDateTime for t in times[2:]) / 1e7
    return dict(seconds=round(time.monotonic() - started, 3), private_bytes=p.private,
                working_set_bytes=p.ws, peak_working_set_bytes=p.peak_ws,
                available_bytes=m.available, commit_available_bytes=m.commit_available,
                cpu_seconds=cpu, read_bytes=io.read_bytes, write_bytes=io.write_bytes,
                page_faults=p.faults)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--exe", required=True, type=Path)
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--soft-gib", type=float, default=1.5)
    ap.add_argument("--hard-gib", type=float, default=2)
    ap.add_argument("--reserve-gib", type=float, default=3)
    ap.add_argument("--timeout", type=float, default=120)
    args = ap.parse_args()
    if not (0 < args.soft_gib < args.hard_gib <= 2 and args.reserve_gib >= 3 and 0 < args.timeout <= 1800):
        ap.error("保护设置要求 0 < soft < hard <= 2 GiB，reserve >= 3 GiB，0 < timeout <= 1800 秒")
    args.exe, args.input = args.exe.resolve(strict=True), args.input.resolve(strict=True)
    initial = memory()
    if initial.available < (args.reserve_gib + args.hard_gib) * GIB:
        raise RuntimeError("当前可用内存不足以同时容纳硬上限和系统预留；未启动导入。")
    args.out.mkdir(parents=True, exist_ok=False)
    job = checked(create_job(None, None))
    child = None
    records = []
    reason = "未启动"
    started = time.monotonic()
    try:
        limits = Limits()
        # PROCESS_MEMORY | JOB_MEMORY | KILL_ON_JOB_CLOSE
        limits.basic.flags = 0x100 | 0x200 | 0x2000
        limits.process_memory = limits.job_memory = int(args.hard_gib * GIB)
        checked(set_job(job, 9, c.byref(limits), c.sizeof(limits)))
        with (args.out / "worker.jsonl").open("wb") as stdout, (args.out / "worker.stderr.log").open("wb") as stderr:
            child = subprocess.Popen([str(args.exe), "--rust-table-worker"], stdin=subprocess.PIPE,
                                     stdout=stdout, stderr=stderr, creationflags=0x08000000 | 0x4000)
            # Worker blocks on stdin until the kernel memory limit is installed.
            checked(assign(job, int(child._handle)))
            request = dict(jobId="diagnose-import", method="kanzhang.inspect",
                           params=dict(inputPath=str(args.input), headerRow=1),
                           cancelPath=str(args.out.resolve() / "cancel"), pausePath=str(args.out.resolve() / "pause"))
            child.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
            child.stdin.close()
            reason = "进程自行退出，需结合事件日志判断成功或失败"
            with (args.out / "samples.csv").open("w", newline="", encoding="utf-8-sig") as output:
                writer = None
                while child.poll() is None:
                    try:
                        row = sample(int(child._handle), started)
                    except OSError:
                        if child.poll() is not None:
                            break
                        raise
                    records.append(row)
                    if writer is None:
                        writer = csv.DictWriter(output, fieldnames=row.keys())
                        writer.writeheader()
                    writer.writerow(row)
                    output.flush()
                    if row["private_bytes"] >= args.soft_gib * GIB:
                        reason = "进程私有内存达到软保护线"
                    elif row["available_bytes"] < args.reserve_gib * GIB:
                        reason = "系统可用内存低于预留线"
                    elif row["commit_available_bytes"] < 2 * GIB:
                        reason = "系统剩余提交额度低于 2 GiB"
                    elif row["seconds"] >= args.timeout:
                        reason = "达到诊断时间上限"
                    else:
                        time.sleep(0.2)
                        continue
                    checked(terminate(job, 124))
                    break
            child.wait(timeout=10)
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        close(job)
        terminal_phase = None
        worker_read_ms = None
        dimensions = None
        event_path = args.out / "worker.jsonl"
        if event_path.exists():
            with event_path.open(encoding="utf-8", errors="replace") as events:
                for line in events:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if event.get("phase") in ("completed", "failed", "cancelled"):
                        terminal_phase = event["phase"]
                        result = event.get("result") or {}
                        worker_read_ms = result.get("timings", {}).get("readMs")
                        dimensions = result.get("dimensions")
        summary = dict(timestamp=datetime.datetime.now().isoformat(), exe=str(args.exe),
                       exe_mtime=args.exe.stat().st_mtime, input=str(args.input), file_bytes=args.input.stat().st_size,
                       total_memory_bytes=initial.total, initial_available_bytes=initial.available,
                       soft_gib=args.soft_gib, hard_gib=args.hard_gib, reserve_gib=args.reserve_gib,
                       stop_reason=reason, exit_code=child.returncode if child else None,
                       terminal_phase=terminal_phase, worker_read_ms=worker_read_ms, dimensions=dimensions,
                       elapsed_seconds=round(time.monotonic() - started, 3), samples=len(records),
                       peak_private_bytes=max((r["private_bytes"] for r in records), default=0),
                       min_available_bytes=min((r["available_bytes"] for r in records), default=initial.available))
        (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
