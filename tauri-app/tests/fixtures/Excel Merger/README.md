# Excel 合并回归样例

`simple-biff8.xls` 由 Microsoft Excel 的 `SaveAs(..., 56)` 生成，是真正的 OLE/BIFF8 工作簿，不是改后缀的 XLSX。

仅包含合成数据：Sheet「明细」，表头「编号 / 金额」，数据为文本 `001` 和数字 `123.5`。没有用户业务数据。

用于 `excel_merger::tests::real_biff8_xls_and_text_xls_merge_together`。文本型 XLS 的各编码样例由测试动态生成。

`formatted-biff8.xls` 同样由 Excel 生成：Sheet「模板」，A1=7（加粗）、B1 公式 `=A1*2`、A3:B3 合并标题及自定义列宽。用于验证旧 XLS 模板转换保留公式和样式，不含业务数据或宏。
