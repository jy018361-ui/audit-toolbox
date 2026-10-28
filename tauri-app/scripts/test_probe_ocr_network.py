import unittest
from pathlib import Path
import json
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

from probe_ocr_network import endpoint, measure, request_id, stages


class NetworkProbeTests(unittest.TestCase):
    def test_stage_boundaries_do_not_double_count_upload_as_service_wait(self):
        result = stages({"time_namelookup": .01, "time_connect": .03, "time_appconnect": .08,
                         "time_pretransfer": .09, "time_posttransfer": 1.09,
                         "time_starttransfer": 4.09, "time_total": 4.10}, True)
        self.assertEqual(result["uploadMs"], 1000)
        self.assertEqual(result["afterUploadWaitMs"], 3000)
        self.assertAlmostEqual(sum(result.values()), 4100)

    def test_early_error_response_is_not_reported_as_negative_server_wait(self):
        self.assertIsNone(stages({"time_namelookup": .01, "time_connect": .03, "time_appconnect": .08,
                                  "time_pretransfer": .09, "time_posttransfer": 0,
                                  "time_starttransfer": .1, "time_total": .11}, True))

    def test_endpoint_and_request_id_only_allow_safe_metadata(self):
        self.assertEqual(endpoint("https://example.test/v1/"), "https://example.test/v1/chat/completions")
        for url in ["https://user:password@example.test", "https://example.test/v1?key=secret", "file:///tmp/ocr"]:
            with self.assertRaises(ValueError):
                endpoint(url)
        self.assertEqual(request_id("X-Request-Id: abc-123\r\nContent-Type: application/json"), "abc-123")
        self.assertIsNone(request_id("X-Request-Id: private document content"))

    def test_direct_probe_keeps_credential_off_argv_and_out_of_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "response-0.json").write_text(json.dumps({"choices": [{"message": {"content": "合成原文"}}]}), encoding="utf-8")
            (root / "headers-0.txt").write_text("X-Request-Id: request-123", encoding="utf-8")
            metrics = {"time_namelookup": .01, "time_connect": .02, "time_appconnect": .03, "time_pretransfer": .04,
                       "time_posttransfer": .1, "time_starttransfer": .2, "time_total": .3, "http_code": 200}
            with patch("probe_ocr_network.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(metrics))) as run:
                result = measure("curl.exe", "https://example.test/v1", root / "body.json", "Bearer private-api-key", root, 0, True)
            arguments, options = run.call_args
            self.assertNotIn("private-api-key", " ".join(arguments[0]))
            self.assertIn("private-api-key", options["input"])
            self.assertIn("--noproxy", arguments[0])
            self.assertNotIn("private-api-key", json.dumps(result))
            self.assertTrue(result["success"])

    def test_connection_failure_keeps_zero_http_status_and_partial_timings(self):
        with tempfile.TemporaryDirectory() as temporary:
            metrics = {key: 0 for key in ["time_namelookup", "time_connect", "time_appconnect", "time_pretransfer", "time_posttransfer", "time_starttransfer", "time_total"]}
            metrics["http_code"] = "000"
            with patch("probe_ocr_network.subprocess.run", return_value=SimpleNamespace(returncode=7, stdout=json.dumps(metrics))):
                result = measure("curl.exe", "https://example.test/v1", Path(temporary)/"body.json", "Bearer fake", Path(temporary), 0)
            self.assertEqual(result["metrics"]["http_code"], 0)
            self.assertEqual(result["curlExit"], 7)
            self.assertFalse(result["success"])


if __name__ == "__main__":
    unittest.main()
