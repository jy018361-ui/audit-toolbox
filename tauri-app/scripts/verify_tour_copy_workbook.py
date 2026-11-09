"""只读逐项验证最终 Excel 与本次提取的实际文案一致。"""
import json
from pathlib import Path
import sys
import openpyxl

sys.stdout.reconfigure(encoding="utf-8")
book, summary_path, data_path = map(Path, sys.argv[1:4])
summary = json.loads(summary_path.read_text(encoding="utf-8"))
data = json.loads(data_path.read_text(encoding="utf-8"))
wb = openpyxl.load_workbook(book, data_only=False)
actual = {}
for name, id_col, text_col in [("工作台导览", 6, 3), ("工具导览与步骤提示", 7, 4), ("通用兜底与固定文字", 6, 3)]:
    ws = wb[name]
    assert ws.freeze_panes == "A2", (name, ws.freeze_panes)
    for row in list(ws.values)[1:]:
        if not row[id_col-1]:
            assert not any(row), (name, "多余旧行", row)
            continue
        key = row[id_col-1]
        assert key not in actual, key
        actual[key] = row[text_col-1]
assert set(actual) == set(summary["ids"]), (set(actual) ^ set(summary["ids"]))
expected = {f"workspace.{step['id']}": step["body"] for step in data["workspace"]}
expected.update({f"fixed.{key}": value for key, value in data["fixed"].items()})
tool_rows = {row[6]: row for row in list(wb["工具导览与步骤提示"].values)[1:] if row[6]}
for tool in data["tools"]:
    for step in tool["tour"]:
        key = f"{tool['id']}.tour.{step['id']}"
        expected[key] = step["body"]
        assert tool_rows[key][2] == step["title"], key
    for key, body in tool["script"].get("stepHints", {}).items():
        expected[f"{tool['id']}.hint.{key}"] = body
    for index, step in enumerate(tool["steps"]):
        for variant, label in enumerate(step["labels"]):
            expected[f"{tool['id']}.label.{step['file'].replace('.tsx', '')}.{step['key']}.{variant}"] = label
assert actual == expected, [(key, actual.get(key), value) for key, value in expected.items() if actual.get(key) != value]
for row, step in zip(list(wb["工作台导览"].values)[1:], data["workspace"]):
    assert row[1] == step["title"]
assert len(list(wb["历史批改"].values)) - 1 == summary["historicalEdits"]
for ws in wb:
    for row in ws:
        for cell in row:
            assert cell.data_type not in ("e", "f"), (ws.title, cell.coordinate, cell.value)
assert all("设置 → 新手模式" not in str(value) for value in actual.values())
assert data["version"] in wb["说明"]["A1"].value
print(f"逐项核验通过：{len(actual)} 项文案及标题一致，保留 {summary['historicalEdits']} 条批改，无公式或错误单元格。")
