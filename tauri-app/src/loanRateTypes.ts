/**
 * 借款台账的逐行利率口径：固定还是浮动、浮动时上浮／下浮多少个点。
 *
 * 台账普遍**没有**「利率类型」列，利率列里混着 `3.85`、`0.0365`、`浮动`、
 * `LPR+90BP` 好几种写法。默认值在这里按一条明确规则算出来摆进预览区，
 * 用户看得见也改得动；只将用户实际改动的字段回传，避免预览默认值覆盖源台账。
 */

export type LoanRateType = "fixed" | "floating";
/** 一行的利率口径。`spreadBps` 上浮为正、下浮为负，单位 BP（1BP = 0.01%）。 */
export type LoanRateSetting = { rateType: LoanRateType; spreadBps: number };

/**
 * 判成浮动的字样。收的是**实务里真会写进台账的说法**，
 * 「浮」一个字盖住浮动／浮息／上浮／下浮，不必逐个列。
 */
export const FLOATING_KEYWORDS = [
  "浮",
  "lpr",
  "基准",
  "挂钩",
  "随行就市",
  "重定价",
  "可变",
  "float",
  "variable",
];

/** 单元格是不是一个纯数值（允许百分号、千分位、全角符号、括号负数）。 */
export function isNumericRateCell(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  const clean = raw
    .replace(/[,，\s%％¥￥]/g, "")
    .replace(/[（(]/g, "-")
    .replace(/[）)]/g, "");
  if (!clean || !/^-?\d*\.?\d+$/.test(clean)) return false;
  return Number.isFinite(Number(clean));
}

const hasFloatingWord = (text: string) => {
  const lower = text.toLowerCase();
  return FLOATING_KEYWORDS.some((word) => lower.includes(word));
};

/**
 * 一行的利率口径默认值。
 *
 * 优先级：**已有数值执行利率 → 固定；否则再看利率类型与利率文字**。
 * 这是业务确认口径：即使旁边写着「浮动」，只要执行利率列已经给出数值，
 * 预览仍默认固定；只有用户明确把该行改成浮动，才清空执行利率并走基准＋点数。
 * 没有数值执行利率时，LPR／上浮／下浮等字样才默认浮动。
 */
export function detectLoanRateType(
  rateCell: string,
  rateTypeCell = "",
): LoanRateType {
  if (isNumericRateCell(rateCell)) return "fixed";
  if (rateTypeCell.trim())
    return hasFloatingWord(rateTypeCell) ? "floating" : "fixed";
  return hasFloatingWord(rateCell) ? "floating" : "fixed";
}

const cellAt = (
  row: string[] | undefined,
  headers: string[],
  column?: string,
): string => {
  if (!row || !column?.trim()) return "";
  const index = headers.indexOf(column);
  return index < 0 ? "" : (row[index] ?? "");
};

/**
 * 整份台账的利率口径默认值，下标与预览行一一对应。
 *
 * 映射变了（用户改了利率列指向哪一列）默认值要跟着重算，所以这里只算默认值，
 * 用户的手工改动单独存，读取时叠在默认值上面——两者互不覆盖。
 */
export function loanRateDefaults(
  preview: string[][],
  headers: string[],
  mapping: Record<string, string | undefined>,
): LoanRateSetting[] {
  return preview.map((row) => ({
    rateType: detectLoanRateType(
      cellAt(row, headers, mapping.rate),
      cellAt(row, headers, mapping.rateType),
    ),
    spreadBps: loanSpreadBps(
      cellAt(row, headers, mapping.spreadBps),
      cellAt(row, headers, mapping.rate),
    ),
  }));
}

/** BP 列优先；其次仅识别明确的“+90BP/-25基点”，不把百分比上浮猜成 BP。 */
export function loanSpreadBps(spreadCell: string, rateCell: string): number {
  const spread = spreadCell
    .trim()
    .replace(/[，,\s]/g, "")
    .replace(/(?:bps?|基点)$/i, "");
  if (spread && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(spread))
    return Number(spread);
  const hit = rateCell
    .replace(/[＋]/g, "+")
    .replace(/[−－]/g, "-")
    .match(/([+-]\s*\d+(?:\.\d+)?)\s*(?:bps?|基点)/i);
  return hit ? Number(hit[1].replace(/\s/g, "")) : 0;
}

/**
 * 手工填进 BP 格子的取值。
 *
 * 格子空着（也包括小数还没敲完时浏览器给出的空串）一律当 0——BP 是"在基准上
 * 浮动多少"，没填就是不浮动；留成空值反而会让有效利率算不出来。
 */
export function loanBps(text: string): number {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) ? value : 0;
}

/**
 * 手工填进利率格子的取值。
 *
 * 与 BP 相反，清空利率要回到"这一行还没给利率"（`undefined`），
 * 界面照旧显示空、浮动行提示"请再次测算"；当成 0% 会悄悄算出一笔零利息。
 */
export function loanRateValue(text: string): number | undefined {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) ? value : undefined;
}

/** 保留行号，未修改的行传 null，不能将预览默认值作为覆盖指令。 */
export function loanRateOverrides(
  defaults: LoanRateSetting[],
  edits: Record<number, Partial<LoanRateSetting>>,
): (Partial<LoanRateSetting> | null)[] {
  return defaults.map((_, index) => edits[index] ?? null);
}

/** 默认值叠上用户手工改动，得到最终逐行口径（回传给引擎的就是这一份）。 */
export function resolveLoanRates(
  defaults: LoanRateSetting[],
  edits: Record<number, Partial<LoanRateSetting>>,
): LoanRateSetting[] {
  return defaults.map((item, index) => ({ ...item, ...edits[index] }));
}

/**
 * 报告期开始日：资产负债表日所在年度的 1 月 1 日。
 *
 * 与存款利息 `depositReportStart` 同一口径——界面上只让用户填资产负债表日，
 * 期间开始由它推出来，不再要求填两个日期。
 */
export function loanReportStart(balanceSheetDate: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(balanceSheetDate)
    ? `${balanceSheetDate.slice(0, 4)}-01-01`
    : "";
}
