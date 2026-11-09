import { AccountConfirmationActions, type ConfirmationColumn, type ConfirmationRow } from "./AccountConfirmationActions";
import { type LedgerInformation, type LoanEvent } from "./LoanLedgerConfirmation";
import { loanLedgerNumber } from "./LoanLedgerNumberInput";

export const loanLedgerColumns: ConfirmationColumn[] = [
  { key: "loanId", title: "借款标识" },
  { key: "entity", title: "主体" },
  { key: "contractStart", title: "合同开始" },
  { key: "contractEnd", title: "到期日" },
  ...["年初余额", "本期新增", "本期减少（还款）", "期末余额"].map((title, i) => ({
    key: ["opening", "added", "reduced", "closing"][i], title, editable: true, numberFormat: "#,##0.00",
  })),
  { key: "rateType", title: "利率类型", editable: true, options: ["固定", "浮动"] },
  { key: "fixedRate", title: "执行利率（%）", editable: true },
  { key: "benchmarkRate", title: "基准利率（%）", editable: true },
  { key: "spreadBps", title: "加减点（BP）", editable: true, numberFormat: "0.########" },
  { key: "additionDates", title: "新增日期（多笔用分号分隔）", editable: true },
  { key: "additionAmounts", title: "新增金额（与日期逐笔对应）", editable: true },
  { key: "repaymentDates", title: "还款日期（多笔用分号分隔）", editable: true },
  { key: "repaymentAmounts", title: "还款金额（与日期逐笔对应）", editable: true },
];

export function loanLedgerConfirmationRows(rows: LedgerInformation[]): ConfirmationRow[] {
  const number = (value: number | null | undefined) => value == null ? "" : String(value);
  const dates = (events: LoanEvent[]) => events.map(event => event.date).join("; ");
  const amounts = (events: LoanEvent[]) => events.map(event => number(event.amount)).join("; ");
  return rows.map(row => ({ key: row.rowKey, values: [
    row.loanId, row.entity, row.contractStart ?? "", row.contractEnd ?? "",
    ...[row.opening, row.added, row.reduced, row.closing].map(number),
    row.rateType === "floating" ? "浮动" : "固定",
    loanLedgerNumber(row.fixedRate, true), loanLedgerNumber(row.benchmarkRate, true), number(row.spreadBps),
    dates(row.additions), amounts(row.additions), dates(row.repayments), amounts(row.repayments),
  ] }));
}

/** 先完整解析，所有行成功后父组件一次回写；金额不平由原有台账校验提示。 */
export function importLoanLedgerConfirmation(changed: ConfirmationRow[], current: LedgerInformation[]): LedgerInformation[] {
  const byKey = new Map(current.map(row => [row.rowKey, row]));
  const seen = new Set<string>();
  return changed.map(item => {
    const original = byKey.get(item.key);
    if (!original || item.values.length !== loanLedgerColumns.length || seen.has(item.key))
      throw new Error("台账借款清单与当前页面不一致，请重新下载。");
    seen.add(item.key);
    const numeric = (text: string, label: string, percent = false, signed = false): number | null => {
      const clean = text.trim().replaceAll(",", "").replaceAll("，", "").replace(percent ? /[％%]$/ : /$^/, "");
      if (!clean) {
        if (text.trim()) throw new Error(`${original.loanId}：${label}须填写有效数字。`);
        return null;
      }
      const value = Number(clean);
      if (!Number.isFinite(value) || (!signed && value < 0))
        throw new Error(`${original.loanId}：${label}须填写${signed ? "有效数字" : "非负数字"}。`);
      return percent ? value / 100 : value;
    };
    const split = (text: string) => text.trim() === "" ? [] : text.split(/[;；\n]/).map(value => value.trim());
    const events = (dateText: string, amountText: string, label: string, old: LoanEvent[]): LoanEvent[] => {
      const dates = split(dateText), amounts = split(amountText);
      if (dates.length !== amounts.length) throw new Error(`${original.loanId}：${label}日期与金额的笔数不一致。`);
      return dates.map((date, i) => {
        if (!date && !amounts[i]) throw new Error(`${original.loanId}：${label}明细存在空白项，请删除多余分号。`);
        if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date))
          throw new Error(`${original.loanId}：${label}日期须按 YYYY-MM-DD 填写有效日期。`);
        const amount = numeric(amounts[i], `${label}金额`);
        return { date, amount, basis: old.find(event => event.date === date && event.amount === amount)?.basis ?? "人工修改" };
      });
    };
    const v = item.values;
    if (v[8] !== "固定" && v[8] !== "浮动") throw new Error(`${original.loanId}：利率类型须为固定或浮动。`);
    const additions = events(v[12], v[13], "新增", original.additions);
    const repayments = events(v[14], v[15], "还款", original.repayments);
    const eventChanged = (next: LoanEvent[], old: LoanEvent[]) => next.length !== old.length || next.some((event, i) => event.date !== old[i]?.date || event.amount !== old[i]?.amount);
    const additionsChanged = eventChanged(additions, original.additions);
    const repaymentsChanged = eventChanged(repayments, original.repayments);
    const fixedRate = numeric(v[9], "执行利率", true), benchmarkRate = numeric(v[10], "基准利率", true);
    return { ...original,
      opening: numeric(v[4], "年初余额"), added: numeric(v[5], "本期新增"),
      reduced: numeric(v[6], "本期减少"), closing: numeric(v[7], "期末余额"),
      rateType: v[8] === "浮动" ? "floating" : "fixed",
      fixedRate: v[9] === loanLedgerNumber(original.fixedRate, true) ? original.fixedRate : fixedRate,
      benchmarkRate: v[10] === loanLedgerNumber(original.benchmarkRate, true) ? original.benchmarkRate : benchmarkRate,
      spreadBps: numeric(v[11], "加减点", false, true) ?? 0,
      additions: additionsChanged ? additions : original.additions,
      repayments: repaymentsChanged ? repayments : original.repayments,
      detailRows: additionsChanged || repaymentsChanged ? undefined : original.detailRows,
    };
  });
}

export function LoanLedgerConfirmationActions({ rows, context, disabled, onImport }: {
  rows: LedgerInformation[];
  context: string;
  disabled: boolean;
  onImport: (rows: LedgerInformation[]) => void;
}) {
  return <>
    <AccountConfirmationActions tool="loan" title="借款利息" documentKind="loanLedger"
      context={JSON.stringify(["loan-ledger-v1", context])} columns={loanLedgerColumns}
      rows={loanLedgerConfirmationRows(rows)} disabled={disabled}
      onImport={changed => onImport(importLoanLedgerConfirmation(changed, rows))} />
    <p className="fx-note">下载当前全部借款台账，在 Excel 黄色单元格中编辑后上传。利率按百分比填写（如 4.38）；多笔新增或还款的日期、金额分别用分号分隔，并按相同顺序对应。上传后请重新复核确认。</p>
  </>;
}
