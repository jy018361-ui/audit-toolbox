"""只读提取批改内容，避免表格导入器改变空单元格的含义。"""
import json
import sys
import openpyxl

sys.stdout.reconfigure(encoding="utf-8")
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=False)
print(json.dumps({ws.title: list(ws.values) for ws in wb}, ensure_ascii=False))
