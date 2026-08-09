from __future__ import annotations

import json
import sys
from pathlib import Path

from .errors import EngineError
from .handlers import dispatch
from .jobs import _event
from .protocol import json_safe


class FileCancelEvent:
    def __init__(self, path: str):
        self.path = Path(path)

    def is_set(self) -> bool:
        return self.path.exists()


def emit(message: dict) -> None:
    sys.stdout.write(json.dumps(
        json_safe(message), ensure_ascii=False, separators=(",", ":"), allow_nan=False,
    ) + "\n")
    sys.stdout.flush()


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
    raw = sys.stdin.readline()
    if not raw:
        return 2
    request = json.loads(raw)
    job_id = str(request["jobId"]); method = str(request["method"])
    cancel = FileCancelEvent(str(request["cancelPath"]))
    params = request.get("params") or {}
    params["__pausePath"] = str(request.get("pausePath") or "")

    def progress(phase, current, total, message, severity="info", output_paths=None, result=None):
        emit(_event(job_id, method, phase, current, total, message, severity, output_paths, result))

    try:
        progress("running", 0, 1, "任务开始运行")
        result = dispatch(method, params, progress, cancel)
        outputs = result.get("outputPaths", []) if isinstance(result, dict) else []
        progress("completed", 1, 1, "任务已完成", "success", outputs, result)
        return 0
    except EngineError as exc:
        cancelled = exc.code == "JOB_CANCELLED"
        progress("cancelled" if cancelled else "failed", 1, 1, exc.user_message, "warning" if cancelled else "error", result={"error": exc.as_dict()})
        return 0 if cancelled else 1
    except BaseException as exc:
        error = EngineError("WORKER_CRASH", "独立处理进程发生未预期错误。", detail=str(exc))
        progress("failed", 1, 1, error.user_message, "error", result={"error": error.as_dict()})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
