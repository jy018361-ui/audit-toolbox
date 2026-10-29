import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from compare_ocr_clients import ClashObserver, native_worker


class OcrClientComparisonTests(unittest.TestCase):
    def test_worker_uses_installed_entry_and_isolated_db_without_storing_text_or_secret(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            event = {"phase": "completed", "result": {"text": "合成私有正文", "timings": {"recognitionMs": 10}}}
            with patch("compare_ocr_clients.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(event))) as run:
                report = native_worker(Path("installed.exe"), root, b"synthetic-image", {"engine": "bailian"})
            arguments, options = run.call_args
            self.assertEqual(arguments[0], ["installed.exe", "--rust-table-worker"])
            request = json.loads(options["input"])
            self.assertEqual(request["params"]["__dbPath"], str(root / "native.sqlite"))
            self.assertEqual(request["params"]["page"], 30)
            self.assertNotIn("合成私有正文", json.dumps(report, ensure_ascii=False))
            self.assertTrue(report["success"])

    def test_clash_report_filters_unrelated_connections_and_does_not_expose_controller_secret(self):
        observer = ClashObserver(None, "dashscope.aliyuncs.com")
        rows = [
            {"id": "old", "metadata": {"host": observer.host}},
            {"id": "other", "metadata": {"host": "private.example"}},
            {"id": "new", "metadata": {"host": observer.host, "process": "audit-toolbox.exe", "sourcePort": "1234"},
             "rule": "RuleSet", "rulePayload": "direct", "chains": ["DIRECT"], "upload": 100, "download": 0},
        ]
        observer.existing = {"old"}
        observer.secret = "synthetic-controller-secret"

        def get(_path):
            observer.stopped.set()
            return {"connections": rows}

        observer.get = get
        observer.poll()
        result = observer.report()
        self.assertEqual(len(result["connections"]), 1)
        self.assertEqual(result["connections"][0]["chains"], ["DIRECT"])
        self.assertNotIn("synthetic-controller-secret", json.dumps(result))
        self.assertNotIn("private.example", json.dumps(result))

    def test_controller_must_be_loopback_before_authentication(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "clash.yaml"
            config.write_text("external-controller: external.example:9090\nsecret: synthetic-secret\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "回环"):
                ClashObserver(config, "dashscope.aliyuncs.com")


if __name__ == "__main__":
    unittest.main()
