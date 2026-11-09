"""用合成音视频验收发布 EXE 的本地音轨处理，不访问凭据或云端。"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path


FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "meeting-media"


def invoke(exe: Path, root: Path, source: Path, channel: str, *, cancelled: bool = False) -> list[dict]:
    marker = root / f"{uuid.uuid4().hex}.cancel"
    if cancelled:
        marker.write_text("cancel", encoding="utf-8")
    scratch = root / "temporary"
    scratch.mkdir(exist_ok=True)
    environment = os.environ.copy()
    environment.update(TEMP=str(scratch), TMP=str(scratch))
    # generate 在原生解码后校验地址，两个无效地址都必须先于读取密钥失败。
    # 绝不使用默认服务地址，也不读取或修改实际应用设置和凭据。
    request = {
        "jobId": uuid.uuid4().hex,
        "method": "meeting.generate",
        "params": {
            "audioPath": str(source),
            "__settings": {"meeting": {
                "asr_channel": channel,
                "asr_base_url": "invalid-local-validation-address",
                "plan_base_url": "invalid-local-validation-address",
            }},
        },
        "cancelPath": str(marker),
        "pausePath": str(root / "unused.pause"),
    }
    original = source.read_bytes()
    result = subprocess.run(
        [str(exe), "--rust-table-worker"],
        input=json.dumps(request, ensure_ascii=False) + "\n",
        encoding="utf-8", capture_output=True, timeout=60,
        env=environment, check=False,
    )
    events = [json.loads(line) for line in result.stdout.splitlines() if line.strip().startswith("{")]
    terminal = [event for event in events if event.get("phase") in {"completed", "cancelled", "failed"}]
    assert len(terminal) == 1, f"{source.name}/{channel}: 未收到唯一结束事件：{result.stderr[-1000:]}"
    assert terminal[0]["toolId"] == "meeting_minutes", terminal[0]
    assert result.returncode == (0 if cancelled else 1), terminal[0]
    assert source.read_bytes() == original, "导入原文件必须保持不变"
    temporary_media = scratch / "AuditToolbox" / "meeting-media"
    assert not temporary_media.exists() or not any(temporary_media.iterdir()), "必须清理本任务的音轨文件和目录"
    assert all(not event.get("outputPaths") for event in events), "校验不得生成纪要或登记暂存音轨"
    return events


def error_code(events: list[dict]) -> str:
    return events[-1].get("result", {}).get("error", {}).get("code", "")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    args = parser.parse_args()
    exe = args.exe.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="audit-meeting-media-worker-") as temporary:
        root = Path(temporary)
        sources = []
        for suffix in ("mp4", "wmv", "avi"):
            source = root / f"合成 会议#100%.{suffix}"
            source.write_bytes((FIXTURES / f"tone.{suffix}").read_bytes())
            sources.append(source)
        no_audio = root / "只有画面.mp4"
        no_audio.write_bytes((FIXTURES / "no-audio.mp4").read_bytes())
        corrupt = root / "损坏视频.wmv"
        corrupt.write_bytes(b"synthetic corrupt media")
        for channel in ("general", "token_plan"):
            expected = "PLAN_ASR_URL_INVALID" if channel == "token_plan" else "ASR_URL_INVALID"
            for source in sources:
                events = invoke(exe, root, source, channel)
                assert any("已处理" in event.get("message", "") for event in events), events
                assert error_code(events) == expected, events[-1]
                print(f"通过：{source.suffix.upper()[1:]} 音轨解码到 {channel} 配置校验；暂存已清理")
            for source, code in ((no_audio, "MEETING_MEDIA_NO_AUDIO"), (corrupt, "MEETING_MEDIA_DECODE_FAILED")):
                events = invoke(exe, root, source, channel)
                assert error_code(events) == code, events[-1]
            events = invoke(exe, root, sources[0], channel, cancelled=True)
            assert events[-1]["phase"] == "cancelled" and error_code(events) == "JOB_CANCELLED", events[-1]
        print("会议音视频 worker 验收通过：双通道、无音轨、损坏、预先取消和清理；未调用云端。")


if __name__ == "__main__":
    main()
