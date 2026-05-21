# 数据接入模块

`src/ingest/` 存放固定资产数据接入代码。

## 存放内容

- Excel/CSV/API 输入读取逻辑。
- 原始字段名到标准字段名的映射。
- 基础数据清洗，例如去空格、日期格式标准化、金额类型转换。
- 输入数据的轻量结构检查。

## 不存放内容

- 业务质检规则。
- 报告导出逻辑。
- 真实资产数据。

## 已实现

| 模块 | 作用 |
| --- | --- |
| `models.py` | 工作表类型、分类结果、诊断结构 |
| `constants.py` | 字段同义词、语义必需列、内容特征签名 |
| `field_mapping.py` | 表头→标准字段；FA list 语义必需列检查 |
| `header_detection.py` | 多行表头扫描 |
| `sheet_classifier.py` | **名称 + 内容** 综合识别 sheet 类型 |
| `workbook_reader.py` | 读取整本底稿并输出诊断 |
| `cli.py` | 命令行诊断入口 |

## 使用方式

```powershell
cd "D:\AI file"
$env:PYTHONPATH = "src"
python -m ingest.cli
python -m ingest.cli "固定资产质检agent\案例库\某文件.xlsx"
python -m ingest.cli --max-mb 50 --json
```

识别策略见 `docs/sheet-classification.md`。

## 后续

- `normalize.py`：将映射后的行转为标准资产记录对象。
- `load_assets.py`：对外统一加载 FA list / 清单。
