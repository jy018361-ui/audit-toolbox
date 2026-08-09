from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


def _tool_id(method: str) -> str:
    prefix = method.split(".", 1)[0]
    return {
        "wp": "wp_service_generator",
        "confirmation": "confirmation_progress",
        "file_list": "file_list_directory",
        "fa": "fa_list",
        "roll_forward": "audit_roll_forward",
    }.get(prefix, prefix)


def _event(job_id: str, method: str, phase: str, current: int, total: int, message: str, severity: str, output_paths=None, result=None) -> dict:
    return {
        "protocol": 1,
        "type": "event",
        "event": "job-event",
        "payload": {
            "jobId": job_id,
            "toolId": _tool_id(method),
            "phase": phase,
            "current": current,
            "total": total,
            "message": message,
            "severity": severity,
            "outputPaths": output_paths or [],
            "result": result,
        },
    }


@dataclass
class Job:
    job_id: str
    method: str
    params: dict
    cancel_path: Path
    pause_path: Path
    process: subprocess.Popen[str] | None = None


class JobManager:
    def __init__(self, emit: Callable[[dict], None]):
        self.emit = emit
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.heavy_lock = threading.Lock()
        self.cancel_root = Path(tempfile.gettempdir()) / "AuditToolbox" / "job-cancel"
        self.cancel_root.mkdir(parents=True, exist_ok=True)

    def start(self, method: str, params: dict) -> str:
        job_id = uuid.uuid4().hex
        job = Job(
            job_id,
            method,
            params,
            self.cancel_root / f"{job_id}.cancel",
            self.cancel_root / f"{job_id}.pause",
        )
        with self.lock:
            self.jobs[job_id] = job
        threading.Thread(target=self._monitor, args=(job,), daemon=True).start()
        return job_id

    def cancel(self, job_id: str) -> bool:
        with self.lock:
            job = self.jobs.get(job_id)
        if not job:
            return False
        job.cancel_path.touch(exist_ok=True)
        self.emit(_event(job_id, job.method, "cancelling", 0, 1, "正在取消任务…", "warning"))
        return True

    def pause(self, job_id: str, paused: bool) -> bool:
        with self.lock:
            job = self.jobs.get(job_id)
        if not job:
            return False
        if paused:
            job.pause_path.touch(exist_ok=True)
            message = "已请求暂停，将在当前科目完成后暂停。"
        else:
            job.pause_path.unlink(missing_ok=True)
            message = "已继续处理。"
        self.emit(_event(job_id, job.method, "paused" if paused else "running", 0, 1, message, "warning" if paused else "info"))
        return True

    @staticmethod
    def _worker_command() -> list[str]:
        if getattr(sys, "frozen", False):
            return [sys.executable, "--job-worker"]
        return [sys.executable, "-m", "audit_engine.worker"]

    @staticmethod
    def _creation_flags() -> int:
        return 0x08000000 if os.name == "nt" else 0

    @staticmethod
    def _terminate_tree(process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        if os.name == "nt":
            subprocess.run(
                ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            process.terminate()

    def _monitor(self, job: Job) -> None:
        self.emit(_event(job.job_id, job.method, "queued", 0, 1, "任务已进入队列", "info"))
        terminal_seen = False
        cancel_started: float | None = None
        messages: queue.Queue[str] = queue.Queue()
        reader_done = threading.Event()
        try:
            with self.heavy_lock:
                if job.cancel_path.exists():
                    self.emit(_event(job.job_id, job.method, "cancelled", 1, 1, "任务已取消。", "warning"))
                    return
                process = subprocess.Popen(
                    self._worker_command(),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=self._creation_flags(),
                )
                job.process = process
                request = {
                    "jobId": job.job_id,
                    "method": job.method,
                    "params": job.params,
                    "cancelPath": str(job.cancel_path),
                    "pausePath": str(job.pause_path),
                }
                assert process.stdin is not None and process.stdout is not None
                process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
                process.stdin.close()

                def read_output() -> None:
                    try:
                        assert process.stdout is not None
                        for line in process.stdout:
                            messages.put(line)
                    finally:
                        reader_done.set()

                threading.Thread(target=read_output, daemon=True).start()
                while process.poll() is None or not reader_done.is_set() or not messages.empty():
                    try:
                        message = json.loads(messages.get(timeout=0.15))
                        terminal_seen = message.get("payload", {}).get("phase") in {"completed", "failed", "cancelled"} or terminal_seen
                        self.emit(message)
                    except queue.Empty:
                        pass
                    except json.JSONDecodeError:
                        pass
                    if job.cancel_path.exists():
                        cancel_started = cancel_started or time.monotonic()
                        if time.monotonic() - cancel_started > 5 and process.poll() is None:
                            self._terminate_tree(process)
                            self.emit(_event(job.job_id, job.method, "cancelled", 1, 1, "任务已强制停止。", "warning"))
                            terminal_seen = True
                process.wait(timeout=2)
                if not terminal_seen:
                    message = "处理进程异常退出。" if process.returncode else "任务已结束。"
                    severity = "error" if process.returncode else "success"
                    self.emit(_event(job.job_id, job.method, "failed" if process.returncode else "completed", 1, 1, message, severity))
        finally:
            job.cancel_path.unlink(missing_ok=True)
            job.pause_path.unlink(missing_ok=True)
            with self.lock:
                self.jobs.pop(job.job_id, None)
