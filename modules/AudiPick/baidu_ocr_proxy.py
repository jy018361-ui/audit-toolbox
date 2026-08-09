# -*- coding: utf-8 -*-
"""
AudiPick 百度OCR本地代理
作用：绕过浏览器CORS限制，由本机代理转发请求到百度文字识别API。
用法：
  1. 把下面 BAIDU_AK / BAIDU_SK 改成你在百度智能云控制台拿到的 API Key / Secret Key
  2. 命令行运行：  python baidu_ocr_proxy.py
  3. 在 AudiPick 配置页 -> OCR引擎 -> 第三方OCR 里这样填：
        接口URL:   http://127.0.0.1:8765/ocr
        鉴权方式:   无需鉴权      (AK/SK 已写在本代理里，不用再填)
        请求格式:   JSON: {"image":"base64"}
        文本字段路径: words_result[].words
  4. 点"检测可用性"
依赖：仅用 Python 标准库，无需 pip 安装任何东西。需要 Python 3.6+。
"""
import json
import time
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

# ====== 在这里填你的百度 OCR 凭证 ======
BAIDU_AK = "1i5O4B3MPstjtNwzKMj1kYD0"
BAIDU_SK = "把你的SecretKey粘贴在这里"
# =====================================

# 百度OCR接口地址（标准版）。如需高精度版，改成 accurate_basic
BAIDU_OCR_URL = "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic"
TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token"

PORT = 8765

_token_cache = {"token": None, "expire": 0}


def get_access_token():
    now = time.time()
    if _token_cache["token"] and _token_cache["expire"] > now + 60:
        return _token_cache["token"]
    params = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": BAIDU_AK,
        "client_secret": BAIDU_SK,
    })
    req = urllib.request.Request(TOKEN_URL + "?" + params, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if "access_token" not in data:
        raise RuntimeError("获取百度token失败: " + json.dumps(data, ensure_ascii=False))
    _token_cache["token"] = data["access_token"]
    _token_cache["expire"] = now + data.get("expires_in", 2592000)
    return _token_cache["token"]


def baidu_ocr(image_base64):
    token = get_access_token()
    body = urllib.parse.urlencode({"image": image_base64}).encode("utf-8")
    url = BAIDU_OCR_URL + "?access_token=" + urllib.parse.quote(token)
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            body = json.dumps({"status": "ok"}).encode("utf-8")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            payload = {}
        # 兼容两种请求格式：JSON {"image":...} 或 表单 image=...
        image = payload.get("image")
        if not image:
            try:
                form = urllib.parse.parse_qs(raw.decode("utf-8"))
                image = form.get("image", [None])[0]
            except Exception:
                image = None
        if not image:
            body = json.dumps({"error": "缺少image参数"}).encode("utf-8")
            self.send_response(400)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            result = baidu_ocr(image)
            body = json.dumps(result, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            body = json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8")
            self.send_response(500)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        # 简化日志
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    if "粘贴" in BAIDU_SK or not BAIDU_SK:
        print("请先在 baidu_ocr_proxy.py 顶部填写 BAIDU_SK (Secret Key)")
        raise SystemExit(1)
    print("百度OCR代理已启动: http://127.0.0.1:%d/ocr" % PORT)
    print("在 AudiPick 第三方OCR配置里把 接口URL 填为: http://127.0.0.1:%d/ocr" % PORT)
    print("按 Ctrl+C 停止")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
