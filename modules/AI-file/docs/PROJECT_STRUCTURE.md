# 项目文件说明

本文说明固定资产质检 Agent 项目中每个核心目录和文件的作用，便于团队成员、新会话 Agent 和代码评审快速接续工作。

## 根目录

| 路径 | 作用 |
| --- | --- |
| `AGENTS.md` | 项目级 Agent 总说明。记录目标、模块边界、质检结论枚举、数据安全和开发约定。新会话必须优先阅读。 |
| `.gitignore` | Git 忽略规则。用于排除本地状态、密钥、日志、依赖目录和系统临时文件。 |

## 文档目录

| 路径 | 作用 |
| --- | --- |
| `docs/PROJECT_STRUCTURE.md` | 当前文件。说明每个文件存储什么内容以及用途。 |
| `docs/domain-glossary.md` | 固定资产领域词典。记录字段定义、取值约束和常见业务口径。 |
| `docs/architecture.md` | 架构说明。记录模块边界、数据流、规则结果结构和后续演进方向。 |
| `docs/audit-workflow.md` | 固定资产底稿 SOP 与程序流程。沉淀 K.00-K.03 的执行逻辑和 Agent 质检关注点。 |
| `docs/qc-checklist.md` | 固定资产质检 checklist。区分可自动化检查、预警和人工复核项目。 |
| `docs/workpaper-fields.md` | 标准底稿字段与资料映射。记录各工作表字段、标准字段名和规则输入口径。 |
| `docs/source-materials-reading-notes.md` | 资料库读取摘要。记录已读取的 Excel/PDF 文件、工作表和内容预览。 |
| `docs/case-workpaper-diagnostic.md` | 案例库底稿读取诊断（首轮脚本输出）。 |
| `docs/sheet-classification.md` | 工作表识别策略：名称变体 + 表头内容特征。 |
| `docs/tasks.md` | 阶段性任务清单。记录待办事项、负责人和验收标准。 |
| `docs/progress.md` | 项目里程碑进度。记录 M0、M1、M2 等阶段目标和当前状态。 |
| `docs/handoff/latest.md` | 最新交接文档。记录当前进展、下一步、阻塞问题和相关文件。 |
| `docs/decisions/ADR-0001-mvp-scope.md` | 第一条架构决策记录。说明 MVP 范围和暂不做的内容。 |

## Cursor 配置

| 路径 | 作用 |
| --- | --- |
| `.cursor/rules/project-core.mdc` | 全局项目规则。让 Cursor Agent 在所有会话中理解项目基础约束。 |
| `.cursor/rules/python-qc-agent.mdc` | Python 与质检代码规则。适用于 `src/**/*.py` 和 `tests/**/*.py`。 |
| `.cursor/skills/fixed-asset-qc/SKILL.md` | 固定资产质检开发工作流 Skill。用于指导 Agent 添加规则、更新测试和维护文档。 |
| `.cursor/skills/fixed-asset-qc/reference.md` | Skill 的补充参考。记录质检结果结构、错误码命名和样例数据约定。 |
| `.cursor/agents/asset-ingest.md` | 接入子 Agent 说明。聚焦 Excel/CSV/后续影像或单据解析。 |
| `.cursor/agents/qc-rules.md` | 规则子 Agent 说明。聚焦质检规则实现、错误码和单测。 |
| `.cursor/agents/qc-report.md` | 报告子 Agent 说明。聚焦报告结构、汇总和导出。 |

## 源码目录

| 路径 | 作用 |
| --- | --- |
| `src/ingest/README.md` | 数据接入模块说明。记录输入格式、字段映射和清洗边界。 |
| `src/rules/README.md` | 规则引擎模块说明。记录规则组织方式、结果结构和首批规则。 |
| `src/report/README.md` | 报告模块说明。记录报告输出目标、字段和导出约定。 |

## 测试目录

| 路径 | 作用 |
| --- | --- |
| `tests/fixtures/README.md` | 样例数据说明。规定只提交脱敏 fixture 以及推荐覆盖场景。 |
| `tests/rules/README.md` | 规则测试说明。规定每条规则至少覆盖通过、失败和边界场景。 |

## 维护原则

- 聊天中形成的长期结论，必须沉淀到 `docs/`、`.cursor/rules/` 或 `.cursor/skills/`。
- 模块职责变化时，优先更新 `docs/architecture.md` 和本文。
- 每次开始新任务前，先阅读 `AGENTS.md`、`docs/handoff/latest.md` 和本文。
