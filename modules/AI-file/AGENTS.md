# 固定资产质检 Agent

## 项目目标

建设一个面向固定资产台账、单据和后续影像材料的质检 Agent。第一阶段先聚焦结构化台账数据，完成字段校验、业务规则校验和质检报告输出。

## 当前阶段：MVP

- 读取脱敏固定资产台账样例数据。
- 校验必填字段、资产编码唯一性、金额关系和基础日期逻辑。
- 输出统一的质检结果结构，支持后续导出 Excel、JSON 或接入人工复核。

## 推荐技术栈

- Python 作为第一版实现语言。
- `pandas` 用于读取 Excel/CSV。
- `pydantic` 用于字段结构校验。
- `pytest` 用于规则单测。

## 模块边界

- `src/ingest/`：负责读取台账、字段映射、基础清洗，不写具体质检规则。
- `src/rules/`：负责质检规则、错误码、严重级别，不处理文件导入导出。
- `src/report/`：负责汇总质检结果、生成报告结构或导出文件。
- `tests/fixtures/`：仅存放脱敏样例数据。
- `tests/rules/`：存放规则单元测试。

## 质检结论枚举

- `PASS`：校验通过。
- `WARN`：存在轻微风险，建议业务确认。
- `FAIL`：明确不符合规则。
- `NEED_REVIEW`：规则无法自动判断，需要人工复核。

## 数据安全约定

- 不提交真实资产编号、真实部门名称、真实人员信息、真实合同或发票信息。
- 样例资产编号使用 `FA-TEST-001` 这类脱敏编号。
- 涉及真实数据分析时，只提交规则、脚本和脱敏后的 fixture。

## 开发约定

- 开发新规则前，先查看 `docs/domain-glossary.md` 和 `docs/handoff/latest.md`。
- 修改 `src/rules/` 时，必须同步增加或更新 `tests/rules/`。
- 规则含义、错误码或严重级别发生变化时，更新 `docs/architecture.md` 或 `docs/decisions/`。
- 每天收工前更新 `docs/handoff/latest.md`，说明已完成、进行中、下一步和风险。

## 新会话启动提示

建议在 Cursor 新会话第一条消息中使用：

```text
继续固定资产质检 Agent 开发。
请先阅读 AGENTS.md、docs/handoff/latest.md 和 docs/PROJECT_STRUCTURE.md。
当前任务是：<写清楚具体任务、分支、涉及文件和验收标准>。
```
