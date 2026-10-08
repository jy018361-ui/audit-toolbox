import { Fragment, useState } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { LoanLedgerNumberInput, loanLedgerNumber } from "./LoanLedgerNumberInput";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { useTableColumnResize } from "./components/useTableColumnResize";

export type LoanEvent = { date: string; amount: number | null; basis?: string };
/**
 * 台账确认界面的统一明细行：新增、还款金额与主行同列，日期在金额下方。
 *
 * 用户点一次「＋」加一行，哪一侧需要就填哪一侧，留空的一侧不产生事件——
 * 引擎要的仍是 additions/repayments 两个数组（见 [`splitDetailRows`]），
 * 这里只是把两份清单按行号并排成一张可无限加行的表。
 */
export type LoanDetailRow = {
  addDate: string;
  addAmount: number | null;
  repayDate: string;
  repayAmount: number | null;
  /** 双侧各自保留来源说明（按合同开始日默认／台账提取／人工修改），改过的一侧刷新。 */
  addBasis?: string;
  repayBasis?: string;
};
export type LedgerInformation = {
  rowKey: string;
  loanId: string;
  entity: string;
  opening: number | null;
  added: number | null;
  reduced: number | null;
  closing: number | null;
  rateType: "fixed" | "floating";
  spreadBps: number;
  fixedRate?: number | null;
  benchmarkRate?: number | null;
  amountSources?: Partial<
    Record<"opening" | "added" | "reduced" | "closing", "PBC" | "推算">
  >;
  originalAmounts?: Partial<
    Record<"opening" | "added" | "reduced" | "closing", number | null>
  >;
  originalClosing: number | null;
  contractStart?: string;
  contractEnd?: string;
  additions: LoanEvent[];
  repayments: LoanEvent[];
  /** 界面明细行的稳定行序：一旦用户编辑过明细就随行保存，避免按行号配对时串行。 */
  detailRows?: LoanDetailRow[];
};
type Issue = {
  field: "opening" | "added" | "reduced" | "closing" | "rate";
  message: string;
};
export function ledgerInformationIssues(
  row: LedgerInformation,
  start: string,
  end: string,
): Issue[] {
  const issues: Issue[] = [];
  const push = (field: Issue["field"], message: string) =>
    issues.push({ field, message });
  const rate = row.rateType === "fixed" ? row.fixedRate : row.benchmarkRate;
  if (
    rate == null ||
    !Number.isFinite(rate) ||
    rate < 0 ||
    !Number.isFinite(row.spreadBps)
  )
    push("rate", "请补充有效的执行利率或基准利率");
  const fields = ["opening", "added", "reduced", "closing"] as const;
  for (const field of fields) {
    const value = row[field];
    if (
      (field !== "closing" && value == null) ||
      (value != null && (!Number.isFinite(value) || value < 0))
    )
      push(field, "请填写有效的非负金额");
  }
  if (
    !issues.some((i) => fields.includes(i.field as (typeof fields)[number]))
  ) {
    const difference =
      row.opening! + row.added! - row.reduced! - (row.closing ?? 0);
    if (Math.abs(difference) >= 0.005)
      push(
        "closing",
        `余额不平，差额 ${difference.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      );
  }
  for (const [field, label, raw, total] of [
    ["added", "新增", row.additions, row.added],
    ["reduced", "还款", row.repayments, row.reduced],
  ] as const) {
    const items = raw.filter((e) => e.date !== "" || e.amount != null);
    for (const [i, e] of items.entries()) {
      if (!e.date) push(field, `第 ${i + 1} 笔请填写${label}日期`);
      else if (
        !/^\d{4}-\d{2}-\d{2}$/.test(e.date) ||
        !Number.isFinite(Date.parse(e.date)) ||
        new Date(e.date).toISOString().slice(0, 10) !== e.date
      )
        push(field, `第 ${i + 1} 笔${label}日期无效`);
      else if (e.date > end)
        push(field, `第 ${i + 1} 笔${label}日期超过测算截止日 ${end}`);
      else if (e.date < start)
        push(field, `第 ${i + 1} 笔${label}日期早于报告期开始日 ${start}`);
      if (e.amount == null || !Number.isFinite(e.amount) || e.amount <= 0)
        push(field, `第 ${i + 1} 笔请填写大于零的${label}金额`);
    }
    const difference =
      (total ?? 0) - items.reduce((s, e) => s + (e.amount ?? 0), 0);
    if (total != null && Math.abs(difference) >= 0.005)
      push(
        field,
        `${label}明细${difference > 0 ? "少填" : "多填"} ${Math.abs(difference).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      );
  }
  if (!issues.some((i) => i.field === "added" || i.field === "reduced")) {
    const changes = new Map<string, number>();
    for (const [items, sign] of [
      [row.additions, 1],
      [row.repayments, -1],
    ] as const)
      for (const e of items)
        if (e.date && e.amount != null)
          changes.set(e.date, (changes.get(e.date) ?? 0) + e.amount * sign);
    let balance = row.opening ?? 0;
    for (const [, change] of [...changes].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      balance += change;
      if (balance < -0.005) {
        push("reduced", "还款后本金为负，请检查日期和金额");
        break;
      }
    }
  }
  return issues;
}
export function ledgerInformationErrors(
  row: LedgerInformation,
  start: string,
  end: string,
): string[] {
  return ledgerInformationIssues(row, start, end).map((i) => i.message);
}

export const blankDetailRow = (): LoanDetailRow => ({
  addDate: "",
  addAmount: null,
  repayDate: "",
  repayAmount: null,
});

/** additions/repayments 按行号并排成界面明细行；引擎下发的行没有界面行序时用它。 */
export const zipDetailRows = (row: LedgerInformation): LoanDetailRow[] => {
  if (row.detailRows) return row.detailRows;
  const len = Math.max(row.additions.length, row.repayments.length);
  return Array.from({ length: len }, (_, i) => ({
    addDate: row.additions[i]?.date ?? "",
    addAmount: row.additions[i]?.amount ?? null,
    addBasis: row.additions[i]?.basis,
    repayDate: row.repayments[i]?.date ?? "",
    repayAmount: row.repayments[i]?.amount ?? null,
    repayBasis: row.repayments[i]?.basis,
  }));
};

/** 界面明细行还原成引擎要的两个事件数组：两侧全空的行不产生事件。 */
export const splitDetailRows = (
  rows: LoanDetailRow[],
): Pick<LedgerInformation, "additions" | "repayments"> => ({
  additions: rows
    .filter((r) => r.addDate !== "" || r.addAmount != null)
    .map((r) => ({
      date: r.addDate,
      amount: r.addAmount,
      basis: r.addBasis ?? "人工补充",
    })),
  repayments: rows
    .filter((r) => r.repayDate !== "" || r.repayAmount != null)
    .map((r) => ({
      date: r.repayDate,
      amount: r.repayAmount,
      basis: r.repayBasis ?? "人工补充",
    })),
});

const withDetails = (
  row: LedgerInformation,
  details: LoanDetailRow[],
): LedgerInformation => ({
  ...row,
  detailRows: details,
  ...splitDetailRows(details),
});

const updateDetail = (
  row: LedgerInformation,
  details: LoanDetailRow[],
  index: number,
  patch: Partial<LoanDetailRow>,
  side: "add" | "repay",
) =>
  withDetails(
    row,
    details.map((r, i) =>
      i === index
        ? side === "add"
          ? { ...r, ...patch, addBasis: "人工修改" }
          : { ...r, ...patch, repayBasis: "人工修改" }
        : r,
    ),
  );

const PAGE_SIZE = 50;
const amountFields = [
  ["opening", "年初余额"],
  ["added", "本期新增"],
  ["reduced", "本期减少（还款）"],
  ["closing", "期末余额"],
] as const;
export function LoanLedgerConfirmation({
  rows,
  start,
  end,
  busy,
  onEdit,
}: {
  rows: LedgerInformation[];
  start: string;
  end: string;
  busy: boolean;
  onEdit: (row: LedgerInformation) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  // 台账确认表 14 列含长标识与金额，接入统一的列宽拖拽（拖动/双击自适应/右键重置）
  const resize = useTableColumnResize<HTMLDivElement>({ storageKey: "loan.step2-ledger" });
  const filtered = rows.filter((r) =>
    `${r.entity} ${r.loanId}`.includes(query),
  );
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1),
  );
  const toggle = (row: LedgerInformation) => {
    if (!openKeys[row.rowKey] && !zipDetailRows(row).length)
      onEdit(withDetails(row, [blankDetailRow()]));
    setOpenKeys((v) => ({ ...v, [row.rowKey]: !v[row.rowKey] }));
  };
  const sourceTitle = (field: (typeof amountFields)[number][0]) => {
    const values = new Set(rows.map((r) => r.amountSources?.[field] ?? "推算"));
    return values.size > 1 ? "PBC／推算" : ([...values][0] ?? "推算");
  };
  const number = (
    label: string,
    value: number | null | undefined,
    change: (v: number | null) => void,
    invalid = false,
    percent = false,
  ) => (
    <LoanLedgerNumberInput
      label={label}
      invalid={invalid}
      percent={percent}
      value={value}
      disabled={busy}
      onChange={change}
    />
  );
  return (
    <Card className="loan-information-card">
      <CardHeader>
        <CardTitle>台账信息确认</CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          报告期：{start} 至 {end}
          。点行首「＋」展开新增与还款明细；金额与主行同列，金额下方填写日期。拆分明细替代默认事件，不重复计息。
        </p>
        <Input
          aria-label="搜索台账借款"
          placeholder="搜索主体或借款标识"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <p>
          共 {rows.length} 笔借款。PBC
          为台账提供，推算为系统补充；默认日期按报告期边界限定，可修改。期末空白按零检查四栏平衡。
        </p>
        <div className="loan-ledger-scroll" ref={resize.ref}>
          <table className="loan-ledger-table">
            <colgroup>
              {Array.from({ length: 14 }, (_, i) => (
                <col
                  key={i}
                  style={{
                    width:
                      i === 0
                        ? 52
                        : i === 1
                          ? 250
                          : i >= 5 && i <= 8
                            ? 220
                            : 170,
                  }}
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th>明细</th>
                <th>借款标识／待处理原因</th>
                <th>主体</th>
                <th>合同开始</th>
                <th>到期日</th>
                {amountFields.map(([field, label]) => (
                  <th key={field}>
                    {label}（{sourceTitle(field)}）
                  </th>
                ))}
                <th>利率类型</th>
                <th>加减点（BP）</th>
                <th>执行利率（%）</th>
                <th>基准利率（%，浮动用）</th>
                <th>校验</th>
              </tr>
            </thead>
            <tbody>
              {filtered
                .slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
                .map((row) => {
                  const issues = ledgerInformationIssues(row, start, end),
                    open = !!openKeys[row.rowKey],
                    details = zipDetailRows(row);
                  const fieldErrors = (field: Issue["field"]) =>
                    issues.filter((i) => i.field === field);
                  const messages = (field: Issue["field"]) =>
                    fieldErrors(field).map((i) => (
                      <span key={i.message} className="loan-ledger-error">
                        {i.message}
                      </span>
                    ));
                  const eventCell = (
                    side: "add" | "repay",
                    event: LoanDetailRow,
                    i: number,
                  ) => {
                    const added = side === "add",
                      label = added ? "新增" : "还款",
                      value = added ? event.addAmount : event.repayAmount,
                      d = added ? event.addDate : event.repayDate,
                      basis = added ? event.addBasis : event.repayBasis;
                    const active = d !== "" || value != null;
                    const invalidDate =
                      active &&
                      (!d ||
                        !Number.isFinite(Date.parse(d)) ||
                        d < start ||
                        d > end);
                    return (
                      <div className="loan-ledger-event-cell">
                        <label>
                          {label}金额
                          {number(
                            `${row.loanId}${label}金额${i + 1}`,
                            value,
                            (v) =>
                              onEdit(
                                updateDetail(
                                  row,
                                  details,
                                  i,
                                  { [added ? "addAmount" : "repayAmount"]: v },
                                  side,
                                ),
                              ),
                            active && (value == null || value <= 0),
                          )}
                        </label>
                        <label>
                          {label}日期
                          <Input
                            aria-label={`${row.loanId}${label}日期${i + 1}`}
                            aria-invalid={invalidDate}
                            type="date"
                            value={d}
                            min={start}
                            max={end}
                            disabled={busy}
                            onChange={(e) =>
                              onEdit(
                                updateDetail(
                                  row,
                                  details,
                                  i,
                                  {
                                    [added ? "addDate" : "repayDate"]:
                                      e.target.value,
                                  },
                                  side,
                                ),
                              )
                            }
                          />
                        </label>
                        {basis && (
                          <span className="loan-ledger-basis">{basis}</span>
                        )}
                        {invalidDate && (
                          <span className="loan-ledger-error">
                            {!d
                              ? `请填写${label}日期`
                              : d > end
                                ? "日期超过测算截止日"
                                : d < start
                                  ? "日期早于报告期开始日"
                                  : "日期无效"}
                          </span>
                        )}
                      </div>
                    );
                  };
                  return (
                    <Fragment key={row.rowKey}>
                      <tr
                        className={`loan-ledger-row${issues.length ? " has-errors" : ""}`}
                      >
                        <td className="loan-ledger-toggle">
                          <button
                            type="button"
                            className="loan-ledger-expand"
                            aria-expanded={open}
                            aria-label={`${open ? "收起" : "展开"}${row.loanId}明细`}
                            disabled={busy}
                            onClick={() => toggle(row)}
                          >
                            {open ? "－" : "＋"}
                          </button>
                        </td>
                        <td className="loan-ledger-id">
                          {row.loanId}
                          {issues.length > 0 && (
                            <button
                              type="button"
                              className="loan-ledger-status bad"
                              aria-label={`${row.loanId}待处理${issues.length}项`}
                              onClick={() =>
                                setOpenKeys((v) => ({
                                  ...v,
                                  [row.rowKey]: true,
                                }))
                              }
                            >
                              待处理 {issues.length} 项
                              <span className="loan-ledger-reasons">
                                {issues.map((i) => i.message).join("；")}
                              </span>
                            </button>
                          )}
                        </td>
                        <td>{row.entity || "未区分主体"}</td>
                        <td>{row.contractStart || "未提供"}</td>
                        <td>{row.contractEnd || "未提供"}</td>
                        {amountFields.map(([field, label]) => (
                          <td
                            key={field}
                            data-amount-field={field}
                            title={
                              row.originalAmounts
                                ? `原始默认值：${loanLedgerNumber(row.originalAmounts[field]) || "空白"}`
                                : undefined
                            }
                          >
                            {number(
                              `${row.loanId}${field === "reduced" ? "本期减少" : label}`,
                              row[field],
                              (v) => onEdit({ ...row, [field]: v }),
                              !!fieldErrors(field).length,
                            )}
                            {sourceTitle(field) === "PBC／推算" && (
                              <span className="loan-ledger-basis">
                                {row.amountSources?.[field] ?? "推算"}
                              </span>
                            )}
                            {row.originalAmounts &&
                              row[field] !== row.originalAmounts[field] && (
                                <span className="loan-ledger-basis">
                                  已修改
                                </span>
                              )}
                            {messages(field)}
                          </td>
                        ))}
                        <td>
                          <select
                            aria-label={`${row.loanId}利率类型`}
                            className="loan-rate-pick"
                            disabled={busy}
                            value={row.rateType}
                            onChange={(e) =>
                              onEdit({
                                ...row,
                                rateType: e.target.value as
                                  "fixed" | "floating",
                              })
                            }
                          >
                            <option value="fixed">固定</option>
                            <option value="floating">浮动</option>
                          </select>
                        </td>
                        <td>
                          <Input
                            aria-label={`${row.loanId}加减点`}
                            type="number"
                            disabled={busy}
                            value={row.spreadBps}
                            onChange={(e) =>
                              onEdit({
                                ...row,
                                spreadBps: Number(e.target.value),
                              })
                            }
                          />
                        </td>
                        <td>
                          {number(
                            `${row.loanId}执行利率`,
                            row.fixedRate,
                            (v) => onEdit({ ...row, fixedRate: v }),
                            row.rateType === "fixed" &&
                              !!fieldErrors("rate").length,
                            true,
                          )}
                          {row.rateType === "fixed" && messages("rate")}
                        </td>
                        <td>
                          {number(
                            `${row.loanId}基准利率`,
                            row.benchmarkRate,
                            (v) => onEdit({ ...row, benchmarkRate: v }),
                            row.rateType === "floating" &&
                              !!fieldErrors("rate").length,
                            true,
                          )}
                          {row.rateType === "floating" && messages("rate")}
                        </td>
                        <td>
                          <span
                            className={`loan-ledger-status ${issues.length ? "bad" : "ok"}`}
                          >
                            {issues.length ? "待处理" : "通过"}
                          </span>
                        </td>
                      </tr>
                      {open && (
                        <>
                          <tr className="loan-ledger-detail-toolbar">
                            <td></td>
                            <td>
                              <Button
                                variant="secondary"
                                disabled={busy}
                                onClick={() =>
                                  onEdit(
                                    withDetails(row, [
                                      ...details,
                                      blankDetailRow(),
                                    ]),
                                  )
                                }
                              >
                                ＋ 添加明细
                              </Button>
                            </td>
                            <td colSpan={12}>
                              新增与还款明细：只填需要的一侧，全空行忽略。
                            </td>
                          </tr>
                          {details.map((event, i) => (
                            <tr className="loan-ledger-details-row" key={i}>
                              <td></td>
                              <td>
                                明细 {i + 1}
                                <Button
                                  variant="ghost"
                                  aria-label={`删除${row.loanId}明细${i + 1}`}
                                  disabled={busy}
                                  onClick={() =>
                                    onEdit(
                                      withDetails(
                                        row,
                                        details.filter((_, j) => j !== i),
                                      ),
                                    )
                                  }
                                >
                                  删除
                                </Button>
                              </td>
                              <td></td>
                              <td></td>
                              <td></td>
                              <td></td>
                              <td data-detail-field="added">
                                {eventCell("add", event, i)}
                              </td>
                              <td data-detail-field="reduced">
                                {eventCell("repay", event, i)}
                              </td>
                              <td></td>
                              <td></td>
                              <td></td>
                              <td></td>
                              <td></td>
                              <td></td>
                            </tr>
                          ))}
                          <tr className="loan-ledger-detail-total">
                            <td></td>
                            <td>明细合计</td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td>
                              {details
                                .reduce((s, e) => s + (e.addAmount ?? 0), 0)
                                .toLocaleString("zh-CN", {
                                  minimumFractionDigits: 2,
                                })}
                            </td>
                            <td>
                              {details
                                .reduce((s, e) => s + (e.repayAmount ?? 0), 0)
                                .toLocaleString("zh-CN", {
                                  minimumFractionDigits: 2,
                                })}
                            </td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                          </tr>
                        </>
                      )}
                    </Fragment>
                  );
                })}
            </tbody>
          </table>
        </div>
        {filtered.length > PAGE_SIZE && (
          <div className="fx-actions">
            <Button
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              上一页
            </Button>
            <span>
              {current + 1} / {Math.ceil(filtered.length / PAGE_SIZE)}
            </span>
            <Button
              disabled={(current + 1) * PAGE_SIZE >= filtered.length}
              onClick={() => setPage(current + 1)}
            >
              下一页
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
