# 文件夹超链接清单

将选定文件夹内所有文件导出为 Excel 清单，并按层级列出文件夹结构；每个文件带有可点击的超链接。

## 功能

- 图形界面选择源文件夹与保存位置
- 按文件夹层级分列（1级、2级……）
- 列出文件名、超链接、完整路径
- 导出时显示进度条

## 环境要求

- Python 3.8+
- Windows（使用 tkinter 文件对话框）

## 安装

```bash
pip install -r requirements.txt
```

## 使用

```bash
python 超链接2.0.py
```

运行后依次选择要扫描的文件夹和 Excel 保存路径即可。

## 依赖

- [xlsxwriter](https://xlsxwriter.readthedocs.io/) — 生成 Excel
- [tqdm](https://github.com/tqdm/tqdm) — 进度条
