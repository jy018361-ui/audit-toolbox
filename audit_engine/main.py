from __future__ import annotations

import json
import multiprocessing
import sys
import threading
import traceback

from . import __version__
from .errors import EngineError
from .handlers import dispatch
from .jobs import JobManager
from .protocol import json_safe


WRITE_LOCK = threading.Lock()


def configure_stdio() -> None:
    """JSONL transport is always UTF-8, independent of the Windows code page."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def emit(message: dict) -> None:
    with WRITE_LOCK:
        sys.stdout.write(json.dumps(
            json_safe(message), ensure_ascii=False, separators=(",", ":"), allow_nan=False,
        ) + "\n")
        sys.stdout.flush()


def response(request_id, result=None, error=None):
    message = {"protocol": 1, "type": "response", "id": request_id, "ok": error is None}
    message["result" if error is None else "error"] = result if error is None else error
    emit(message)


def serve() -> int:
    configure_stdio()
    jobs = JobManager(emit)
    emit({"protocol":1,"type":"ready","version":__version__})
    for raw in sys.stdin:
        try:
            request = json.loads(raw)
            if request.get("protocol") != 1: raise EngineError("PROTOCOL_MISMATCH", "桌面程序与业务引擎协议版本不一致。")
            request_id = request.get("id"); method = str(request.get("method") or ""); params = request.get("params") or {}
            if method == "system.health": response(request_id, {"version":__version__,"status":"ok"})
            elif method == "job.start": response(request_id, {"jobId":jobs.start(str(params.get("method") or ""), params.get("params") or {})})
            elif method == "job.cancel": response(request_id, {"cancelled":jobs.cancel(str(params.get("jobId") or ""))})
            elif method == "job.pause": response(request_id, {"paused":jobs.pause(str(params.get("jobId") or ""), bool(params.get("paused")))})
            else: response(request_id, dispatch(method, params))
        except EngineError as exc: response(request.get("id") if "request" in locals() else None, error=exc.as_dict())
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            error = EngineError("UNEXPECTED_ERROR", "业务引擎发生未预期错误。", detail=str(exc))
            response(request.get("id") if "request" in locals() else None, error=error.as_dict())
    return 0


if __name__ == "__main__":
    multiprocessing.freeze_support()
    raise SystemExit(serve())
