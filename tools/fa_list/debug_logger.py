"""Debug logging for NDJSON to the current user's AuditToolbox log path."""
import json
import os
import time
from pathlib import Path


def _log_path() -> Path:
    base = os.environ.get("APPDATA")
    if base:
        return Path(base) / "AuditToolbox" / "fa_list_debug.jsonl"
    return Path.home() / ".audit_toolbox" / "fa_list_debug.jsonl"


def _write(**payload) -> None:
    try:
        payload.setdefault("timestamp", int(time.time() * 1000))
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass
