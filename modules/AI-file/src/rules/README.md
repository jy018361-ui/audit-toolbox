# 质检规则模块

`src/rules/` 存放固定资产质检规则和规则执行相关代码。

## 存放内容

- 必填字段校验。
- 资产编码唯一性校验。
- 金额关系校验。
- 日期合理性校验。
- 规则注册和规则执行器。

## 规则输出

规则应输出统一的质检问题结构：

```json
{
  "asset_id": "FA-TEST-001",
  "rule_id": "required_fields",
  "field": "asset_name",
  "severity": "FAIL",
  "message": "资产名称不能为空",
  "suggestion": "补充资产名称后重新提交质检"
}
```

## 后续建议文件

- `models.py`：定义资产记录和质检问题数据结构。
- `required_fields.py`：必填字段校验。
- `unique_asset_id.py`：资产编码唯一性校验。
- `value_consistency.py`：原值、累计折旧、净值关系校验。
- `runner.py`：统一执行规则。
