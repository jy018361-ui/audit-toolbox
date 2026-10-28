"""验收会议词库在独立 worker 中的读取与双版纪要路径，不读凭据、不调用云端。"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import uuid
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    args = parser.parse_args()
    exe = args.exe.resolve(strict=True)
    defaults = json.loads((Path(__file__).resolve().parents[1] / "assets/meeting/vocabulary-defaults.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="audit-meeting-vocabulary-") as directory:
        root = Path(directory)
        # record-* 目录让 worker 全部输出保留在本次临时目录，避免写用户数据目录。
        record = root / "record-vocabulary-validation"
        record.mkdir()
        transcript = record / "合成会议.txt"
        original = "[00:00] 本周讨论 CSDC、COE 和 working paper，EIC 稍后 review。\n"
        transcript.write_text(original, encoding="utf-8")
        cases = [(defaults, "LLM Base URL"), ([], "LLM Base URL"), ({"invalid": True}, "会议词库快照格式不正确")]
        for vocabulary, expected in cases:
            request = {
                "jobId": str(uuid.uuid4()), "method": "meeting.summarize",
                "params": {"transcriptPath": str(transcript), "__meetingVocabulary": vocabulary,
                           "__settings": {"llm": {"enabled": True, "base_url": "invalid-local-validation-address"}}},
                "cancelPath": str(root / "unused.cancel"), "pausePath": str(root / "unused.pause"),
            }
            process = subprocess.run([str(exe), "--rust-table-worker"], input=json.dumps(request, ensure_ascii=False) + "\n",
                                     capture_output=True, encoding="utf-8", timeout=60, check=False)
            events = [json.loads(line) for line in process.stdout.splitlines() if line.strip().startswith("{")]
            terminal = [event for event in events if event.get("phase") in {"completed", "failed", "cancelled"}]
            assert process.returncode == 0 and len(terminal) == 1, process.stderr[-1000:]
            assert terminal[0]["phase"] == "completed", terminal
            result = terminal[0]["result"]
            versions = result["minutesVersions"]
            assert {version["kind"] for version in versions} == {"content", "timeline"}, versions
            assert all(expected in version["minutesError"] for version in versions), versions
            assert result["transcriptPath"] == str(transcript), result
            assert transcript.read_text(encoding="utf-8") == original
            assert not list(record.glob("*.md")), "失败时不能生成虚构纪要"
        print("会议词库 worker 验收通过：内置词库、空词库、无效快照及双版纪要错误；未读取凭据或调用云端。")


if __name__ == "__main__":
    main()
