# 借款利息台账确认口径

## 2026-09-27 台账信息确认

- 保留：台账识别、合同/变动表及多段来源读取；未携带确认信息的旧调用仍按原计算路径执行。
- 新增：`loan.prepare_rates` 在台账模式返回完整借款确认清单，而非前端截断预览；逐笔四栏金额、固定/浮动利率和多笔新增/还款明细允许编辑。
- 默认假设：新增日取合同开始日，减少日取合同到期日；存在台账逐笔日期则优先使用。默认值不等于实际发生证据，界面要求复核确认；日期在报告期外须修正。
- 调整：携带 `ledgerInformation` 的测算与导出按确认后的事件逐日加权，辅助行替代汇总事件；空白余额须人工补充，不视同零。
- 校验：四栏勾稽、辅助合计、有效日期、报告期范围及本金非负均由前后端验证。相同日新增/归还合并净额后判断本金。
- 原始台账字段仍留存在底稿来源信息区。TB/JE 模式不使用台账确认信息。
- 未保留为事实：合同到期日不能证明部分还款实际发生日；确认前不会自动将默认时点解释为已核实。

验证：`npx vitest run src/LoanLedgerConfirmation.test.tsx src/BalanceLayouts.test.tsx src/loanForms.test.ts src/loanRateTypes.test.ts`；`cargo test --manifest-path src-tauri/Cargo.toml --lib loan_interest::`。
