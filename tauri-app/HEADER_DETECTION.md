# 表头结构公共判据

## 2026-09-26 接入范围

`src-tauri/src/header_detection.rs` 提供与业务词表无关的结构判断：规范化后的不同标签数量、重复标题排除、候选行排序、双层分组与正文证据。各工具继续提供自己的关键词评分；相同分数优先较早的行。只有单列的来源保留原评分兜底，不因标签数量少而拒绝读取。

| 来源 | 接入行为 |
| --- | --- |
| TB／JE 共用读取 | 双层上层不同分组数量复用公共判据；原有账表评分及大文件物理行号处理保留 |
| 固定资产主清单／补充清单 | 保留资产关键词和选 Sheet 评分；自动双层列名合并，后续按确认起始行重新读取时使用相同层数 |
| 借款／利率台账 | 保留台账关键词；`headerDepth=0` 联合探测，显式 1／2 层覆盖；两层均不进入正文 |
| 模糊匹配 | 保留名称类关键词；新文件自动识别，检测层数传给匹配任务及历史恢复 |
| Excel 智能合并 | 共用重复标题排除；保留已有合并区域、置信度和人工复核机制 |
| TS | 当前界面明确指定标题行，保留此约定；未新增自动识别入口 |

双层必须同时满足：上层有至少两个不同标签且存在分组形态；下层以文字为主、至少两个业务字段；下一行存在数值或日期数据。合并使用公共列名规则。没有足够证据时按单层读取，可手动指定已支持的层数。

限制：通用台账结构检测尚未读取 XLSX 合并区域；靠单元格形态推断。不把全为文本的正文当成双层佐证。固定资产接口尚无独立手动层数参数；可手动选下层作为单层字段行。非账表工具尚未迁入账表的大文件流式预览策略。

回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib 通用表头`；`cargo test --manifest-path src-tauri/Cargo.toml --lib 合成台账测试集逐份验收`；`cargo test --manifest-path src-tauri/Cargo.toml --lib inspect_detects_title_row_and_real_duplicate_id_column`；`npx vitest run src/FuzzyMatchPage.test.ts src/FuzzyMatchPage.test.tsx`。
