# 大文件磁盘处理接入说明

更新日期：2026-10-18。此文件记录本轮接入范围、分流规则及实际边界；各工具的业务验收仍以对应 PARITY 文档为准。

## 接入范围

| 工具 | 大文件路径 |
| --- | --- |
| 折旧测算 | 流式导入、逐行校验和常量内存导出，保留折旧公式 |
| 折旧政策对比 | 两期联合估算、SQLite 合并游标及逐行对比导出 |
| 两列模糊匹配 | 所选列和倒排索引落 SQLite，数据库粗筛排序，结果分页和完整导出 |
| 借款利息测算 | 台账、利率表、TB 和 JE 分批访问；台账预览分页，完整目录扫描 |
| 存款利息收入测算 | TB 完整分类/目录及 JE 磁盘重放，保留核对与逐日计息规则 |
| FA List 匹配 | 卡片清单 SQLite 合并与导出；TB+JE 完整余额表和凭证访问 |
| 汇兑损益测算 | TB 完整分类、JE 凭证磁盘索引与重放、明细按索引读取 |
| TBJE 完整性核对 | TB 完整末级/符号分析，JE 分批聚合，保留三项核对与底稿 |

## 何时走磁盘

公共判断位于 `disk_table::should_use_disk`。同一次任务的全部输入去重后联合估算，包括两期清单或 TB+JE。基础内存估算乘工具工作系数，超过当前 worker 内存预算的 65%，或任一文件达到 2 GiB，就选择磁盘路径；无法估算时也选择安全路径。

- 文本不超过 64 MiB：基础估算为文件大小的 6 倍。
- 更大的文本：抽样开头最多 16 MiB，估算整表行数、单元格数量及字符串开销，再乘 2.5 倍。
- XLSX/XLSM：使用工作表 XML 和共享字符串解压后的体积，基础估算为其与文件体积较大值的 4 倍。
- 工具还需为匹配、分类、核对等中间结构留余量。例如模糊匹配系数为 2、TB 分析为 4、固定资产清单合并为 12；具体入口以代码和各工具文档为准。

worker 预算同时受物理可用内存、系统提交余量和总内存限制：先给 Windows 保留总内存约 10%（至少 1 GiB、至多 4 GiB），剩余余量取 70%，且不超过总内存三分之一。预算小于 256 MiB 时暂停启动并提示释放内存。磁盘处理仍需内存，不会绕过保护规则。

## 数据与缓存约定

XLSX/XLSM 逐行解析 XML，共享字符串使用磁盘字典；CSV/TSV/TXT 流式解码。缓存按规范路径、文件大小、修改时间、Sheet、标题行和层数区分。保留前置空行、列偏移及来源行号；CSV 引号内换行仍属于同一表格记录。读取期间源文件改变、缓存不完整或取消，不发布半成品。

预览仅用于字段复核。正式统计和计算扫描完整数据；模糊结果每页 200 行，借款大台账预览每页 100 行，导出不以当前页为范围。

## 当前边界

- 真正的旧版 XLS、ODS 等格式尚无本轮通用流式读取支持；大文件明确提示另存为 XLSX 或 CSV。文本内容伪装为 XLS 的导出仍按内容识别。
- 完整单主体的 TB 分类、唯一账户目录、单张超大凭证，以及借款/汇兑的最终结果仍有内存预算约束。超限时明确拒绝或提示拆分，不按预览样本替代完整计算。
- 磁盘容量不足、异常超长行和损坏缓存会报错；不代表任意体积、任意结构的文件均可无限处理。

## 验证入口

```text
npm run build
npx vitest run src/FuzzyMatchPage.test.ts src/FuzzyMatchPage.test.tsx src/LoanInterestPageUi.test.tsx src/LoanMatchingFallbackUi.test.tsx src/useLoanInspectionCompletion.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml --lib disk_table::
cargo test --manifest-path src-tauri/Cargo.toml --lib loan_disk_
cargo test --manifest-path src-tauri/Cargo.toml --lib tb_disk_
cargo test --manifest-path src-tauri/Cargo.toml --lib disk_tb_late_rows
cargo test --manifest-path src-tauri/Cargo.toml --lib fx_disk_replay
python scripts/verify_large_file_workers.py --exe src-tauri/target/debug/audit-toolbox.exe --out build/disk-worker-smoke
```

忙碌机器上可为合成小样本测试设置 `AUDIT_TOOLBOX_SYNTHETIC_TEST_BUDGET=1`：仅测试构建中生效，固定 256 MiB worker 预算，仍要求实际可用内存至少 512 MiB。正式程序不包含此开关；真实大样本验收不使用它。

本轮验收：前端构建、相关界面回归、各业务模块定向回归及磁盘/内存结果对照通过；编译后的开发 EXE 通过上述 8 个模块的独立 worker 合成验收。worker 小样本验证参数传递、业务结果和导出文件，其中 FA、政策、折旧、模糊及汇兑显式启用磁盘路径，其余模块的磁盘路径由定向回归验证。这些检查不代替真实超大文件的峰值内存与耗时验收。本轮未打包发布版。
