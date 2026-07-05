import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import launcher.llm_client as llm_client
import launcher.llm_settings as llm_settings


class _FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self.payload, ensure_ascii=False).encode("utf-8")


class DifyClientTests(unittest.TestCase):
    def test_dify_chat_app_uses_chat_messages_endpoint_and_no_model_required(self):
        captured = {}

        def fake_urlopen(req, timeout):
            captured["url"] = req.full_url
            captured["timeout"] = timeout
            captured["authorization"] = req.get_header("Authorization")
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _FakeResponse({"answer": '{"ping":"ok"}'})

        with patch("launcher.llm_client.urllib.request.urlopen", side_effect=fake_urlopen):
            content = llm_client._chat_completion(
                {
                    "api_type": "dify_chat",
                    "base_url": "https://ai-platform-uat.ey.net/v1",
                    "api_key": "secret",
                    "timeout": 9,
                },
                [
                    {"role": "system", "content": "Return JSON only."},
                    {"role": "user", "content": '{"ping":"ok"}'},
                ],
                max_tokens=24,
                json_response=True,
                task_name="connection_test",
            )

        self.assertEqual('{"ping":"ok"}', content)
        self.assertEqual("https://ai-platform-uat.ey.net/v1/chat-messages", captured["url"])
        self.assertEqual("Bearer secret", captured["authorization"])
        self.assertEqual("blocking", captured["body"]["response_mode"])
        self.assertEqual({}, captured["body"]["inputs"])
        self.assertIn("Return JSON only.", captured["body"]["query"])
        self.assertIn("请只返回严格 JSON", captured["body"]["query"])

    def test_dify_enabled_does_not_require_model_name(self):
        with patch(
            "launcher.llm_settings.load_llm_settings",
            return_value={
                "enabled": True,
                "api_type": "dify_chat",
                "base_url": "https://ai-platform-uat.ey.net/v1",
                "api_key": "secret",
                "model": "",
            },
        ):
            self.assertTrue(llm_settings.is_llm_enabled())


if __name__ == "__main__":
    unittest.main()
