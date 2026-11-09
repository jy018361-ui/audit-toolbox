/**
 * 界面数字统一显示口径：
 * - 金额：千位分隔 + 固定两位小数（1,234,567.89）；
 * - 计数（行数、笔数、文件数）：千位分隔的整数（12,345）。
 * 利率、汇率、百分比等不会到千位的比率类数字不走这里，维持各页原状。
 */

export type MoneyFormatOptions = {
  /** 零值（含四舍五入到零的极小值）显示文本，与导出格式对齐时可传 "-"。默认 "0.00"。 */
  zeroText?: string;
  /** 非数字（null/undefined/NaN/文本）占位。默认 "—"。 */
  invalidText?: string;
  /** 绝对值小于该值按零显示；默认 0.005（即两位小数下会舍成 0.00 的都归零）。 */
  snapZeroBelow?: number;
};

const moneyFormatter = new Intl.NumberFormat("zh-CN", {
  useGrouping: true,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(
  value: unknown,
  options: MoneyFormatOptions = {},
): string {
  const { zeroText = "0.00", invalidText = "—", snapZeroBelow = 0.005 } =
    options;
  // 布尔会被 Number() 转成 0/1，null 与空字符串会转成 0，都不属于金额。
  if (
    typeof value === "boolean" ||
    value == null ||
    (typeof value === "string" && value.trim() === "")
  )
    return invalidText;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return invalidText;
  const zero =
    num === 0 || Object.is(num, -0) || Math.abs(num) < snapZeroBelow;
  return zero ? zeroText : moneyFormatter.format(num);
}

export type CountFormatOptions = {
  /** 允许保留的小数位（工时等非整数计数用），默认 0 位。 */
  maxFractionDigits?: number;
};

const countFormatters = new Map<number, Intl.NumberFormat>();

export function formatCount(
  value: unknown,
  options: CountFormatOptions = {},
): string {
  const maxDigits = options.maxFractionDigits ?? 0;
  let formatter = countFormatters.get(maxDigits);
  if (!formatter) {
    formatter = new Intl.NumberFormat("zh-CN", {
      useGrouping: true,
      maximumFractionDigits: maxDigits,
    });
    countFormatters.set(maxDigits, formatter);
  }
  if (typeof value === "boolean" || value == null)
    return value == null ? "" : String(value);
  if (typeof value !== "number") return String(value);
  if (!Number.isFinite(value)) return String(value);
  return formatter.format(Object.is(value, -0) ? 0 : value);
}

/**
 * 预览/结果表格里「看起来是数值」的单元格判定：带千位分隔或带小数点的
 * 数字（可带负号、括号负数、百分号）才右对齐。纯整数字串（科目编码、
 * 年份、单号）不匹配，保持左对齐，避免编码被右对齐造成误读。
 */
const NUMERIC_CELL_PATTERN =
  /^\(?-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?%?$|^\(?-?\d+\.\d+\)?%?$/;

export function isNumericCellText(text: string): boolean {
  return NUMERIC_CELL_PATTERN.test(text.trim());
}
