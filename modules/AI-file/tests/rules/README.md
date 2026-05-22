# 规则测试

`tests/rules/` 存放固定资产质检规则的自动化测试。

## 测试要求

- 每条规则至少覆盖通过场景和失败场景。
- 金额、日期、空值等规则应覆盖边界场景。
- 测试只读取 `tests/fixtures/` 中的脱敏样例。
- 规则变更必须同步更新测试。

## 后续建议文件

- `test_required_fields.py`
- `test_unique_asset_id.py`
- `test_value_consistency.py`
- `test_date_reasonableness.py`
