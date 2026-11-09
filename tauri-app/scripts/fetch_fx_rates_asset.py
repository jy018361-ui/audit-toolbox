# -*- coding: utf-8 -*-
"""抓取外汇管理局人民币汇率中间价，生成程序内置牌价表（紧凑 CSV）。

用途：把一段历史期间的官方中间价固化进 `src-tauri/assets/fx/safe_mid_rates.csv`，
`fx.rs` 用 `include_str!` 打进 EXE，离线环境也能测算。历史牌价一经发布不再变动，
因此资产文件只需在发版前用本脚本向尾部追加更新（改下方 START/END 后重跑整段，
脚本按日期去重，重跑安全）。

用法（需联网）：
    python scripts/fetch_fx_rates_asset.py

输出格式：一行一个发布日，列为 25 个币种的外管局原始口径数值
（前 10 个币种=每 100 外币兑人民币，其余=每 100 人民币兑外币），
与 fx.rs 在线抓取的解析口径完全一致，加载时统一换算成"每 1 单位外币兑人民币"。
"""

from __future__ import annotations

import csv
import gzip
import io
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta

SAFE_URL = "https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do"
# 币种顺序必须与 fx.rs `fetch_safe_rates` 的 currencies 数组一致。
CURRENCIES = [
    "USD", "EUR", "JPY", "HKD", "GBP", "AUD", "NZD", "SGD", "CHF", "CAD", "MOP", "MYR", "RUB",
    "ZAR", "KRW", "AED", "SAR", "HUF", "PLN", "DKK", "SEK", "NOK", "TRY", "MXN", "THB",
]
# 内置覆盖区间：报告期起点 2023-01-01 前推 35 天 → 2026-10-07。
# 起点依据：跨年 JE 的月初牌价（上月末重估点）需要报告期首年 1 月前的数据。
START = date(2022, 11, 27)
END = date(2026, 10, 7)
CHUNK_DAYS = 180  # 单次查询远小于官方/程序自身的 366 天上限，留足余量
OUTPUT = "assets/fx/safe_mid_rates.csv"

TD_PATTERN = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
TR_SPLIT = '<tr class="first"'


def strip_tags(value: str) -> str:
    text = re.sub(r"<[^>]+>", "", value)
    return text.replace("&nbsp;", "").strip()


def fetch_chunk(client_from: date, client_to: date) -> str:
    form = urllib.parse.urlencode(
        {"startDate": client_from.isoformat(), "endDate": client_to.isoformat(), "queryYN": "true"}
    ).encode("ascii")
    request = urllib.request.Request(
        SAFE_URL,
        data=form,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AuditToolbox/2.0",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept-Encoding": "gzip",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
    return raw.decode("utf-8", errors="replace")


def parse_chunk(html: str) -> dict[date, list[str | None]]:
    rows: dict[date, list[str | None]] = {}
    for chunk in html.split(TR_SPLIT)[1:]:
        cells = [strip_tags(cell) for cell in TD_PATTERN.findall(chunk)]
        if len(cells) < 26:
            continue
        try:
            row_date = date.fromisoformat(cells[0].strip())
        except ValueError:
            continue
        values = [cell if cell else None for cell in cells[1:26]]
        rows[row_date] = values
    return rows


def main() -> int:
    publications: dict[date, list[str | None]] = {}
    cursor = START
    while cursor <= END:
        chunk_end = min(cursor + timedelta(days=CHUNK_DAYS - 1), END)
        print(f"抓取 {cursor} ~ {chunk_end} …", flush=True)
        html = fetch_chunk(cursor, chunk_end)
        found = parse_chunk(html)
        if not found:
            print(f"  警告：该区间未解析到任何发布日", file=sys.stderr)
        overlap = sorted(set(found) & set(publications))
        for day in overlap:
            if found[day] != publications[day]:
                print(f"  错误：{day} 两次抓取结果不一致，中止。", file=sys.stderr)
                return 1
        publications.update(found)
        cursor = chunk_end + timedelta(days=1)

    days = sorted(publications)
    if not days:
        print("未抓到任何数据。", file=sys.stderr)
        return 1
    missing_value = [
        (day, currency)
        for day in days
        for currency, value in zip(CURRENCIES, publications[day])
        if value is None
    ]
    if missing_value:
        sample = ", ".join(f"{d}:{c}" for d, c in missing_value[:5])
        print(f"错误：{len(missing_value)} 个币种值缺失（如 {sample}），中止。", file=sys.stderr)
        return 1

    import os

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_path = os.path.join(repo_root, OUTPUT.replace("/", os.sep))
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["日期", *CURRENCIES])
        for day in days:
            writer.writerow([day.isoformat(), *publications[day]])

    size = os.path.getsize(output_path)
    print(
        f"完成：{len(days)} 个发布日（{days[0]} ~ {days[-1]}），"
        f"写入 {output_path}（{size / 1024:.0f} KB）。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
