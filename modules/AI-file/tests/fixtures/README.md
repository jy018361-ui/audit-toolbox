# 测试样例数据

`tests/fixtures/` 存放脱敏后的固定资产样例数据。

## 存放内容

- 小规模 Excel/CSV/JSON fixture。
- 覆盖正常记录、缺失字段、重复编码、金额错误和日期异常的样例。
- 与测试用例配套的输入文件。

## 数据安全

- 不提交真实资产编号。
- 不提交真实部门、真实人员、真实供应商、合同号或发票号。
- 资产编号使用 `FA-TEST-001`、`FA-TEST-002` 等格式。

## 后续建议文件

- `basic_assets.csv`：基础正常样例。
- `invalid_required_fields.csv`：缺失必填字段样例。
- `invalid_amounts.csv`：金额关系异常样例。
