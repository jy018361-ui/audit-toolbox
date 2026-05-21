# 架构说明

固定资产质检 Agent 第一版采用清晰的三段式架构：数据接入、规则质检、报告输出。每个模块保持边界清楚，便于后续接入更多数据源和规则。

业务流程和底稿口径以 `docs/audit-workflow.md`、`docs/qc-checklist.md` 和 `docs/workpaper-fields.md` 为准。

## 数据流

```text
固定资产标准底稿/台账/样例数据
        |
        v
src/ingest/      读取、字段映射、基础清洗
        |
        v
src/rules/       执行质检规则，产生结构化问题
        |
        v
src/report/      汇总结果，输出报告或人工复核清单
```

## 模块职责

### `src/ingest/`

- 读取 Excel、CSV 或后续 API 输入。
- 将原始列名映射为标准字段名。
- 执行轻量清洗，例如去除空格、标准化日期格式。
- 识别来源工作表，例如 `FA list`、`新增清单`、`处置清单`、`K.03.2 折旧测试TOD`。
- 不实现业务质检规则。

### `src/rules/`

- 每条规则独立实现，便于单测和维护。
- 规则输入为标准化资产记录。
- 规则输出统一的质检问题结构。
- 规则设计优先参考 `docs/qc-checklist.md` 中的 `AUTO_FAIL` 和 `AUTO_WARN` 项。
- 不读取文件，也不负责导出报告。

### `src/report/`

- 汇总每条资产的质检结果。
- 生成错误明细、资产级结论和统计摘要。
- 区分自动化失败、预警和人工复核项。
- 后续支持导出 Excel、JSON 或对接人工复核系统。

## 质检问题结构

MVP 阶段建议每个问题包含以下字段：

```json
{
  "asset_id": "FA-TEST-001",
  "procedure_code": "FA_LIST",
  "source_sheet": "FA list",
  "rule_id": "required_fields",
  "field": "asset_name",
  "severity": "FAIL",
  "message": "资产名称不能为空",
  "suggestion": "补充资产名称后重新提交质检"
}
```

## 错误码命名

- 规则 ID 使用小写蛇形命名，例如 `required_fields`。
- 字段级问题写入 `field`。
- 跨字段问题可将 `field` 设为 `null` 或组合字段名，例如 `original_value/net_value`。

## 首批规则来源

首批自动化规则来自 `docs/qc-checklist.md`：

- `fa_list_required_fields`
- `unique_asset_id`
- `asset_amount_non_negative`
- `asset_value_consistency`
- `useful_life_positive`
- `salvage_rate_range`
- `asset_start_date_reasonable`
- `addition_required_fields`
- `disposal_required_fields`
- `depreciation_required_fields`

涉及 Canvas、CRA、TE/SAD 外部一致性、证据充分性、拒绝执行理由恰当性等事项，先进入人工复核。

## 当前不做

- 不接入真实生产系统。
- 不提交真实资产数据。
- 不实现影像 OCR。
- 不实现复杂工作流审批。
- 不引入数据库，先以文件和内存数据结构完成 MVP。

## 后续演进

- 增加资产类别枚举和折旧年限规则。
- 接入影像、合同、发票等非结构化材料。
- 增加人工复核状态流转。
- 提供 API 服务或 Web 页面。
