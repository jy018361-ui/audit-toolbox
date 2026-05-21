# 最新交接

> 每次收工前更新本文。新会话或新成员接手时，先读 `AGENTS.md`、`docs/PROJECT_STRUCTURE.md` 和本文。

## 当前状态

- Git 仓库已初始化并关联 GitHub 远程。
- 已创建固定资产质检 Agent 项目骨架。
- 已读取资料库中的固定资产标准底稿、SOP、checklist 和程序执行资料。
- 已对案例库中 6 份较小脱敏底稿完成读取诊断，暂跳过 42MB 的 A 公司底稿。
- 当前处于业务资料沉淀与规则设计阶段，尚未开始实现业务代码。

## 已完成

- 项目长期上下文：`AGENTS.md`
- 项目结构说明：`docs/PROJECT_STRUCTURE.md`
- 领域词典：`docs/domain-glossary.md`
- 架构说明：`docs/architecture.md`
- 任务清单：`docs/tasks.md`
- 项目进度：`docs/progress.md`
- 资料库读取摘要：`docs/source-materials-reading-notes.md`
- 固定资产质检流程与 SOP：`docs/audit-workflow.md`
- 固定资产质检 checklist：`docs/qc-checklist.md`
- 固定资产底稿字段映射：`docs/workpaper-fields.md`
- 案例库底稿读取诊断：`docs/case-workpaper-diagnostic.md`
- MVP 范围 ADR：`docs/decisions/ADR-0001-mvp-scope.md`
- Cursor 规则、Skill 和子 Agent 初始配置
- 源码与测试目录说明

## 进行中

- 基于案例库诊断结果，字段同义词和 sheet 识别模式已初步确认。
- 下一步应实现轻量读取器，将诊断逻辑落到 `src/ingest/`。

## 下一步

1. 初始化 Python 工程配置，例如 `pyproject.toml`、依赖和测试命令。
2. 在 `src/ingest/` 实现标准底稿 sheet 分类、表头定位和字段映射。
3. 先支持 6 份小型案例底稿，再回头处理 42MB 的 A 公司底稿。
4. 实现第一批自动化规则：字段完整性、资产编号唯一、金额非负、金额关系、使用寿命、残值率。

## 已知问题

- PDF `固定资产程序执行方法指引.pdf` 当前未抽取到正文文本，可能需要 OCR 或源文件。
- A 公司底稿约 42MB，首轮诊断已跳过，需要读取器具备性能优化后再处理。
- 部分字段不能简单模糊匹配，例如处置清单中的 `单据编号` 不应自动当成 `asset_id`。
- 尚未确定报告输出格式是 Excel、JSON 还是两者都要。

## 相关文件

- `AGENTS.md`
- `docs/PROJECT_STRUCTURE.md`
- `docs/domain-glossary.md`
- `docs/architecture.md`
- `docs/source-materials-reading-notes.md`
- `docs/audit-workflow.md`
- `docs/qc-checklist.md`
- `docs/workpaper-fields.md`
- `docs/case-workpaper-diagnostic.md`
- `docs/tasks.md`
- `docs/progress.md`
- `.cursor/skills/fixed-asset-qc/SKILL.md`
