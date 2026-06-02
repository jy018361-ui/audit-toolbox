# Excel Merger（批量 Excel 合并工具）

基于 Python + Tkinter 的桌面小工具，支持批量合并多个 Excel 文件，并按 Sheet 名称匹配或全部堆叠。

## 功能

- 批量选择文件夹内的 `.xlsx` / `.xls` 文件
- 多 Sheet 时可选：按名称匹配合并，或合并全部 Sheet
- 合并结果导出为 Excel（可选 `xlsxwriter` 格式化）

## 运行

```bash
pip install pandas openpyxl xlsxwriter
python batch_merger.py
```

## 打包

使用 PyInstaller 等工具打包为 `Excel Merger.exe`（`build/`、`dist/` 为本地产物，未纳入版本库跟踪）。

## 环境

- Python 3.x
- pandas、openpyxl（必需）；xlsxwriter（可选，用于导出格式）
