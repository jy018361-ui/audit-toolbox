import { useState } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";

export type LoanEvent = { date: string; amount: number | null; basis?: string };
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
  originalClosing: number | null;
  contractStart?: string;
  contractEnd?: string;
  additions: LoanEvent[];
  repayments: LoanEvent[];
};
export function ledgerInformationErrors(
  row: LedgerInformation,
  start: string,
  end: string,
): string[] {
  const errors: string[] = [];
  const rate = row.rateType === "fixed" ? row.fixedRate : row.benchmarkRate;
  if (
    rate == null ||
    !Number.isFinite(rate) ||
    rate < 0 ||
    !Number.isFinite(row.spreadBps)
  )
    errors.push("请补充有效的执行利率或基准利率");
  const amounts = [row.opening, row.added, row.reduced, row.closing];
  if (amounts.some((a) => a == null || !Number.isFinite(a) || a < 0))
    errors.push("请补齐四类非负金额，空白不视为零");
  else if (
    Math.abs(row.opening! + row.added! - row.reduced! - row.closing!) >= 0.005
  )
    errors.push("年初＋新增－减少与期末不一致");
  for (const [label, items, total] of [
    ["新增", row.additions, row.added],
    ["还款", row.repayments, row.reduced],
  ] as const) {
    if (
      items.some(
        (e) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(e.date) ||
          !Number.isFinite(Date.parse(e.date)) ||
          new Date(e.date).toISOString().slice(0, 10) !== e.date ||
          e.date < start ||
          e.date > end,
      )
    )
      errors.push(`${label}日期须填写且在报告期内`);
    if (
      items.some(
        (e) => e.amount == null || !Number.isFinite(e.amount) || e.amount <= 0,
      )
    )
      errors.push(`${label}明细金额须大于零`);
    if (
      total != null &&
      Math.abs(items.reduce((s, e) => s + (e.amount ?? 0), 0) - total) >= 0.005
    )
      errors.push(`${label}明细合计与主行金额不一致`);
  }
  const changes = new Map<string, number>();
  for (const [items, sign] of [
    [row.additions, 1],
    [row.repayments, -1],
  ] as const)
    for (const e of items)
      changes.set(e.date, (changes.get(e.date) ?? 0) + (e.amount ?? 0) * sign);
  let balance = row.opening ?? 0;
  for (const [, change] of [...changes].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    balance += change;
    if (balance < -0.005) {
      errors.push("还款后本金为负");
      break;
    }
  }
  return errors;
}
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
  const filtered = rows.filter((r) =>
    `${r.entity} ${r.loanId}`.includes(query),
  );
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / 50) - 1),
  );
  const number = (
    label: string,
    value: number | null,
    change: (v: number | null) => void,
  ) => (
    <Input
      aria-label={label}
      type="number"
      min="0"
      step="any"
      value={value ?? ""}
      disabled={busy}
      onChange={(e) =>
        change(e.target.value === "" ? null : Number(e.target.value))
      }
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
          。默认新增日期取合同开始日，默认还款日期取到期日，请逐笔复核。拆分明细替代默认事件，不重复计息。
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
          缺少年初余额或期间发生额时，金额可能按合同和期末余额推算，请核实。共{" "}
          {rows.length}{" "}
          笔借款；金额单位与台账取数口径一致。空白金额需补充，不能直接当作零。
        </p>
        {filtered.slice(current * 50, (current + 1) * 50).map((row) => {
          const errors = ledgerInformationErrors(row, start, end);
          const events = (key: "additions" | "repayments", label: string) => (
            <section className="loan-information-events">
              <h4>{label}明细</h4>
              {row[key].map((event, i) => (
                <div className="loan-information-event" key={i}>
                  <label>
                    {label}日期
                    <Input
                      aria-label={`${row.loanId}${label}日期${i + 1}`}
                      type="date"
                      min={start}
                      max={end}
                      disabled={busy}
                      value={event.date}
                      onChange={(e) =>
                        onEdit({
                          ...row,
                          [key]: row[key].map((v, j) =>
                            j === i
                              ? {
                                  ...v,
                                  date: e.target.value,
                                  basis: "人工修改",
                                }
                              : v,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    {label}金额
                    {number(
                      `${row.loanId}${label}金额${i + 1}`,
                      event.amount,
                      (v) =>
                        onEdit({
                          ...row,
                          [key]: row[key].map((e, j) =>
                            j === i
                              ? { ...e, amount: v, basis: "人工修改" }
                              : e,
                          ),
                        }),
                    )}
                  </label>
                  <span>{event.basis}</span>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      onEdit({
                        ...row,
                        [key]: row[key].filter((_, j) => j !== i),
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              ))}
              <p>
                明细合计：
                {row[key]
                  .reduce((s, e) => s + (e.amount ?? 0), 0)
                  .toLocaleString("zh-CN", { minimumFractionDigits: 2 })}
              </p>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  onEdit({
                    ...row,
                    [key]: [
                      ...row[key],
                      { date: "", amount: null, basis: "人工补充" },
                    ],
                  })
                }
              >
                添加{label}明细
              </Button>
            </section>
          );
          return (
            <article className="loan-information-row" key={row.rowKey}>
              <h3>
                {row.loanId} · {row.entity || "未区分主体"}
              </h3>
              <p>
                合同开始：{row.contractStart || "未提供"}　到期：
                {row.contractEnd || "未提供"}　台账原始期末：
                {row.originalClosing == null
                  ? "未提供"
                  : row.originalClosing.toLocaleString()}
              </p>
              <div className="loan-information-amounts">
                {(
                  [
                    ["opening", "年初余额"],
                    ["added", "本期新增"],
                    ["reduced", "本期减少（还款）"],
                    ["closing", "期末余额"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    {number(`${row.loanId}${label}`, row[key], (v) =>
                      onEdit({ ...row, [key]: v }),
                    )}
                  </label>
                ))}
              </div>
              <div className="loan-information-amounts">
                <label>
                  利率类型
                  <select
                    aria-label={`${row.loanId}利率类型`}
                    className="loan-rate-pick"
                    value={row.rateType}
                    disabled={busy}
                    onChange={(e) =>
                      onEdit({
                        ...row,
                        rateType: e.target.value as "fixed" | "floating",
                      })
                    }
                  >
                    <option value="fixed">固定</option>
                    <option value="floating">浮动</option>
                  </select>
                </label>
                <label>
                  加减点（BP）
                  <Input
                    aria-label={`${row.loanId}加减点`}
                    type="number"
                    value={row.spreadBps}
                    disabled={busy}
                    onChange={(e) =>
                      onEdit({ ...row, spreadBps: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  执行利率（小数，3.85% 填 0.0385）
                  {number(`${row.loanId}执行利率`, row.fixedRate ?? null, (v) =>
                    onEdit({ ...row, fixedRate: v }),
                  )}
                </label>
                <label>
                  基准利率（浮动利率使用）
                  {number(
                    `${row.loanId}基准利率`,
                    row.benchmarkRate ?? null,
                    (v) => onEdit({ ...row, benchmarkRate: v }),
                  )}
                </label>
              </div>
              <details open={errors.length > 0}>
                <summary>
                  新增与还款明细（新增 {row.additions.length} 笔，还款{" "}
                  {row.repayments.length} 笔）
                </summary>
                <div className="loan-information-event-tables">
                  {events("additions", "新增")}
                  {events("repayments", "还款")}
                </div>
              </details>
              <div
                role="status"
                className={
                  errors.length ? "loan-warning" : "loan-information-valid"
                }
              >
                {errors.length ? errors.join("；") : "金额与明细校验通过"}
              </div>
            </article>
          );
        })}
        {filtered.length > 50 && (
          <div className="fx-actions">
            <Button
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              上一页
            </Button>
            <span>
              {current + 1} / {Math.ceil(filtered.length / 50)}
            </span>
            <Button
              disabled={(current + 1) * 50 >= filtered.length}
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
