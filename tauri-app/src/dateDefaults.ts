/**
 * 各测算工具"资产负债表日"的统一默认值：没有数据可依据时取当前年度年末。
 * 用户上传账套并识别后，各页会按数据年度的建议表日覆盖它。
 */
export function defaultBalanceSheetDate(): string {
  return `${new Date().getFullYear()}-12-31`;
}
