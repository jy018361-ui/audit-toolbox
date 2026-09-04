# XLS 输入兼容范围

## 2026-09-04 统一读取

新增 `src-tauri/src/spreadsheet_input.rs`，统一按内容识别文本型 XLS、严格解码及逐记录读取。各工具仍保留自己的标题行、字段映射、金额和业务计算规则。原有真正 XLS 的 Calamine 读取保留。

| 工具 | XLS 数据输入入口 |
| --- | --- |
| 汇兑损益测算 | `fx` 账表读取及分类复核导入 |
| 存款利息收入测算 | 复用 `fx` 公共账表读取 |
| 借款利息测算 | TB/JE 复用 `fx`；合同台账/利率台账接共享文本读取 |
| FA List 匹配 | `fa::load_table`，含新增/处置补充清单；TB/JE 复用公共账表入口 |
| 折旧测算、折旧政策对比 | 复用 FA 数据读取 |
| TS、看账、正负数凭证标记 | `tabular` 识别、正式读取和缓存均接入；缓存版本升级，避免复用旧有损解码结果 |
| TBJE 完整性核对 | 初次识别复用 `fx`，正式读取复用 `tabular` |
| 两列模糊匹配 | `fuzzy_match` 输入读取 |
| 函证进度 | 清单首表读取支持文本型 XLS |
| FY27 WP 服务单 | 文件夹发现服务单/Section List/SER 配置时支持 XLS；数据读取及模板准备接入共享模块 |
| WP Roll Forward | 单文件、目录扫描、模板同名 XLS 回退、上年底稿及 PMTE 读取；界面文件选择放开 XLS |
| Excel 批量合并 | 检查、纵向、横向及多 Sheet 输入准备；文本纵向 CSV/XLSX 流式写出 |

文件夹超链接清单原本就能列出 XLS 文件，不解析单元格。PDF 转 Excel、AudiPick 合同 PDF 审阅没有表格输入入口，未将它们改造成 XLS 解析工具。

## 格式与边界

- 支持真正的二进制 XLS，以及后缀为 `.xls` / `.XLS` 的分隔文本（逗号、Tab、分号、竖线，含单列清单）。文本支持 UTF-8（可带 BOM）、GBK、带 BOM 的 UTF-16LE/BE。
- 不把任意后缀为 XLS 的文件都视为合法工作簿；HTML/XML 导出、加密、损坏文件没有新增专用解析器。混合编码、错误编码明确报错。
- 数据工具保持文本编号的前导零；不同工具原有业务金额/日期处理规则不变。文本解码统一收紧为严格模式，故过去静默变成乱码的输入现在可能报错。
- WP 和 Roll Forward 等需保留工作簿结构的入口，将真正 XLS 转成临时 XLSX 后处理，依赖本机 Microsoft Excel。转换只读打开、不更新外链、禁用宏；含宏模板明确拒绝，避免静默丢失宏。原文件不覆盖，临时副本用后清理，结果来源路径仍指向原文件。
- 文本型 XLS 可生成临时 XLSX 单元格数据供模板/多 Sheet 流程读取，但文本没有公式、样式或原始 Sheet 名。业务模板仍必须满足对应工具要求的 Sheet/单元格结构。
- 大文件低内存流式保证针对合并工具的文本纵向输出；其他工具的计算仍可能需要全量数据，不能把格式兼容等同于任意文件规模都低内存。

## 回归和本机验收

- 跨工具输入契约：`cargo test --manifest-path src-tauri/Cargo.toml --lib -j 1 xls_inputs -- --test-threads=1`。验证真实 BIFF8、GBK/UTF-8/UTF-16 文本型 XLS、编号/金额保留、WP/底稿文件发现和临时副本清理。
- 模板转换真机测试：`cargo test --manifest-path src-tauri/Cargo.toml --lib -j 1 xls_inputs_binary_template_conversion -- --ignored --test-threads=1`。
- 全库回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib -j 1 -- --test-threads=1`；前端：`npm run build`。
- 本次全库回归、前端构建及上述 Excel 模板转换真机测试均通过。最终调试 EXE 的 worker 入口另行通过二进制/文本 XLS 混合 CSV 合并、TS 检查、凭证标记检查及混合 XLS 多 Sheet 合并验收；默认忽略的其他 COM 测试未全部执行。
- 合并流式路径已用本机六份 GBK 文本型 XLS 共 2,380,740,210 字节验收：4,171,379 条记录（含各输入表头），与 Python 标准库逐字段对比一致。调试 worker 合并耗时约 158.5 秒，峰值工作集约 28.5 MiB。该指标不代表其他工具或发布构建的性能。
- 合成 BIFF8 样例见 `tests/fixtures/Excel Merger/`；未将用户业务数据加入仓库。新源码需重新构建发布 EXE 才会进入现有桌面版本。
