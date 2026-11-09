import json
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

from benchmark_ocr_speed import quality_summary, read_ocr, workspace_base


class OcrSpeedBenchmarkTests(unittest.TestCase):
    def test_workspace_address_cannot_redirect_credentials(self):
        self.assertEqual(workspace_base("ws-abcdefgh1234"), "https://ws-abcdefgh1234.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")
        for value in ["evil.example", "ws-abc@evil", "ws-abc/secret", "ws-abc?token=secret", "", "WS-ABCDEFGH"]:
            with self.assertRaises(ValueError):
                workspace_base(value)

    def test_settings_are_read_only_and_other_provider_configuration_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            db = Path(temporary) / "settings.sqlite"
            with closing(sqlite3.connect(db)) as connection, connection:
                connection.execute("CREATE TABLE settings(key TEXT,value_json TEXT)")
                value = {"engine": "bailian", "bailian_model": "qwen3.5-ocr", "bailian_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1"}
                connection.execute("INSERT INTO settings VALUES('ocr',?)", (json.dumps(value),))
            original = db.read_bytes()
            self.assertEqual(read_ocr(db), value)
            self.assertEqual(db.read_bytes(), original)
            with closing(sqlite3.connect(db)) as connection, connection:
                value["bailian_base_url"] = "https://another-provider.example/v1"
                connection.execute("UPDATE settings SET value_json=?", (json.dumps(value),))
            with self.assertRaises(ValueError):
                read_ocr(db)

    def test_quality_summary_contains_hashes_without_document_or_token(self):
        value = {"text": "私密合同金额00123.45元", "tables": [{"rows": [["00123.45"]]}], "apiKey": "synthetic-secret"}
        result = quality_summary(value)
        self.assertEqual(result["tableCount"], 1)
        self.assertEqual(result["characters"], len(value["text"]))
        for private in [value["text"], "00123.45", "synthetic-secret"]:
            self.assertNotIn(private, json.dumps(result, ensure_ascii=False))
        self.assertNotEqual(result["numericSha256"], quality_summary({"text": "金额00123.46元"})["numericSha256"])


if __name__ == "__main__":
    unittest.main()
