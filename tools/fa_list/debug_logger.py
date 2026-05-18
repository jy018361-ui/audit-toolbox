"""Debug logging for NDJSON to workspace log path. Do not log secrets."""
import json
import time

_LOG_PATH = r"c:\Users\Administrator\Downloads\新建文件夹 (7)\.cursor\debug.log"


def _write(**payload) -> None:
    try:
        payload.setdefault("timestamp", int(time.time() * 1000))
        with open(_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass
