"""Cold-start OCR worker acceptance with synthetic records and no credentials/network."""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import tempfile
import uuid
import zipfile
from pathlib import Path
from contextlib import closing
from xml.etree import ElementTree as ET


def invoke(exe: Path, root: Path, method: str, params: dict, *, cancelled: bool = False) -> dict:
    marker = root / f"{uuid.uuid4().hex}.cancel"
    if cancelled:
        marker.write_text("cancel", encoding="utf-8")
    request = {
        "jobId": uuid.uuid4().hex, "method": method, "params": params,
        "cancelPath": str(marker), "pausePath": str(root / "unused.pause"),
    }
    result = subprocess.run(
        [str(exe), "--rust-table-worker"],
        input=json.dumps(request, ensure_ascii=False) + "\n", encoding="utf-8",
        capture_output=True, timeout=60, check=False,
    )
    events = [json.loads(line) for line in result.stdout.splitlines() if line.strip().startswith("{")]
    terminal = [event for event in events if event.get("phase") in {"completed", "cancelled", "failed"}]
    assert terminal, f"{method}: missing terminal event: {result.stderr[-1000:]}"
    assert terminal[-1]["toolId"] == "ocr", terminal[-1]
    return terminal[-1]


def workbook_text(path: Path) -> str:
    namespace = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        strings = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        return "\n".join("".join(node.itertext()) for node in strings.findall("s:si", namespace))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True, type=Path)
    args = parser.parse_args()
    exe = args.exe.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="audit-ocr-worker-") as temporary:
        root = Path(temporary)
        db = root / "synthetic.sqlite"
        output = root / "output"
        output.mkdir()
        with closing(sqlite3.connect(db)) as conn, conn:
            conn.executescript("""
                CREATE TABLE ocr_projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE ocr_documents(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ocr_projects(id) ON DELETE CASCADE, data TEXT NOT NULL, source TEXT NOT NULL);
                CREATE TABLE ocr_pages(document_id TEXT NOT NULL REFERENCES ocr_documents(id) ON DELETE CASCADE, page INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(document_id,page));
                CREATE TABLE ocr_extractions(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES ocr_documents(id) ON DELETE CASCADE, data TEXT NOT NULL);
            """)
            project = {"id": "p", "name": "合成 OCR 验收", "prompts": {}, "createdAt": "2026-10-27", "updatedAt": "2026-10-27"}
            conn.execute("INSERT INTO ocr_projects VALUES(?,?)", ("p", json.dumps(project, ensure_ascii=False)))
            for index in (1, 2):
                document = {"id": f"d{index}", "projectId": "p", "name": "同名扫描件.pdf", "mimeType": "application/pdf", "totalPages": 2, "revision": 1, "status": "partial", "sha256": "synthetic"}
                page = {"page": 1, "text": f"合成单证{index}\n账户001234567890123456789\n原始公式字面=1+1", "originalText": "合成初始识别", "tables": [{"id": "t1", "title": "合成表", "rows": [["账号", "金额"], ["001234567890123456789", "=1+1"]]}], "originalTables": [], "revision": 1, "status": "completed", "warnings": []}
                if index == 2:
                    legacy_response = '```json\n{"text":"合成旧版正文","rows":[{"text":"合成后续条款"}],"rotate_rect":[12><34]}\n```'
                    page.update(text=legacy_response, originalText=legacy_response, tables=[], status="needs_review")
                conn.execute("INSERT INTO ocr_documents VALUES(?,?,?,?)", (document["id"], "p", json.dumps(document, ensure_ascii=False), str(root / "unused-source.pdf")))
                conn.execute("INSERT INTO ocr_pages VALUES(?,?,?)", (document["id"], 1, json.dumps(page, ensure_ascii=False)))
            extraction = {"id": "e1", "scenarioId": "custom", "prompts": [{"id": "extract", "label": "用户编辑提示词", "prompt": "仅摘录合成金额，不作推测"}], "sourceRevision": 0, "rows": [{"amount": "100.00", "evidence": {"excerpt": "合成金额100.00", "pages": [1]}, "_internal_diagnostic": {"private_marker": "内部诊断不得导出"}}], "columns": [{"key": "amount", "label": "金额"}, {"key": "evidence", "label": "原文依据"}], "createdAt": "2026-10-27"}
            conn.execute("INSERT INTO ocr_extractions VALUES(?,?,?)", ("e1", "d1", json.dumps(extraction, ensure_ascii=False)))
        params = {"__dbPath": str(db), "__settings": {"llm": {"enabled": False}}, "projectId": "p", "outputDir": str(output)}
        combined = invoke(exe, root, "ocr.export", {**params, "mode": "combined"})
        assert combined["phase"] == "completed", combined
        combined_path = Path(combined["result"]["outputPaths"][0])
        text = workbook_text(combined_path)
        for expected in ["001234567890123456789", "=1+1", "未完成页：2", "合成金额100.00", "摘录需要更新", "合成后续条款", "重新识别"]:
            assert expected in text, expected
        for internal in ["仅摘录合成金额，不作推测", "_internal_diagnostic", "内部诊断不得导出", '"excerpt":', "```json", "rotate_rect", "12><34"]:
            assert internal not in text, internal
        individual = invoke(exe, root, "ocr.export", {**params, "mode": "individual"})
        assert individual["phase"] == "completed", individual
        paths = individual["result"]["outputPaths"]
        assert len(paths) == len(set(paths)) == 2
        assert all(Path(path).is_file() for path in paths)
        assert combined_path.read_bytes().startswith(b"PK")
        before = set(output.iterdir())
        cancelled = invoke(exe, root, "ocr.export", {**params, "mode": "combined"}, cancelled=True)
        assert cancelled["phase"] == "cancelled", cancelled
        assert set(output.iterdir()) == before
        failed = invoke(exe, root, "ocr.extract", {**params, "prompt": "合成测试", "text": "合成原文"})
        assert failed["phase"] == "failed", failed
        assert failed["result"]["error"]["code"] == "LLM_DISABLED", failed
        with closing(sqlite3.connect(db)) as conn:
            assert conn.execute("SELECT COUNT(*) FROM ocr_pages").fetchone()[0] == 2
        print("OCR worker 验收通过：项目合并、逐文件导出、原文与账号保真、摘录可读及过期提示、无内部信息、取消及禁用服务错误。")


if __name__ == "__main__":
    main()
