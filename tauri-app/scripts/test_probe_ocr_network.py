import unittest
from pathlib import Path
import json
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

from probe_ocr_network import endpoint, measure, production_request, request_id, response_text, stages


class NetworkProbeTests(unittest.TestCase):
    def test_official_qwen35_probe_uses_production_native_task_and_exact_image(self):
        captured = json.dumps({"messages": [{"content": [{"image_url": {"url": "data:image/png;base64,original"}}]}]}).encode()
        url, body = production_request("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3.5-ocr", captured)
        value = json.loads(body)
        self.assertTrue(url.endswith("/api/v1/services/aigc/multimodal-generation/generation"))
        self.assertEqual(value["input"]["messages"][0]["content"][0]["image"], "data:image/png;base64,original")
        self.assertFalse(value["input"]["messages"][0]["content"][0]["enable_rotate"])
        self.assertEqual(value["parameters"]["ocr_options"]["task"], "document_parsing")
        explicit_port_url, explicit_port_body = production_request("https://dashscope.aliyuncs.com:443/compatible-mode/v1", "qwen3.5-ocr", captured)
        self.assertTrue(explicit_port_url.endswith("/api/v1/services/aigc/multimodal-generation/generation"))
        self.assertEqual(json.loads(explicit_port_body), value)
        for base, model in [("https://gateway.example/v1", "qwen3.5-ocr"),
                            ("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-vl-ocr")]:
            _, body = production_request(base, model, captured)
            self.assertEqual(body, captured)

    def test_native_response_counts_assembled_text_once_and_preserves_truncation(self):
        text, finish = response_text({"output": {"choices": [{"finish_reason": "length", "message": {"content": [
            {"text": "正文", "blocks": [{"text": "正文"}]}, {"layout": "metadata"}, {"text": "尾部"},
        ]}}]}})
        self.assertEqual(text, "正文\n\n尾部")
        self.assertEqual(finish, "length")

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
