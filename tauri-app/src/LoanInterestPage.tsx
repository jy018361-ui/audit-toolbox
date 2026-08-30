import { useEffect, useRef, useState } from "react";
import type { JobEvent, ToolManifest } from "./types";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenJobEvents,
  openOutput,
  pickPath,
} from "./api";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import {
  applyLedgerReviewToDict,
  missingGoldIdentity,
  resolveRoleLabels,
} from "@/ledgerMapping";
import {
  describeLoanForm,
  loanRoleRequirement,
  resolveLoanForm,
  type LoanForm,
  type LoanRole,
} from "@/loanForms";
import {
  loanBps,
  loanRateDefaults,
  loanRateOverrides,
  loanRateValue,
  loanReportStart,
  resolveLoanRates,
  type LoanRateSetting,
} from "@/loanRateTypes";
import { MappingPanel } from "@/components/MappingPanel";
import { NumberInput } from "@/components/NumberInput";
import { errorText } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import "./loan-interest.css";

type Mode = "ledger" | "tb";
type Kind = "ledger" | "tb" | "je" | "rateLedger";
type Inspection = {
  headers: string[];
  preview: string[][];
  rowCount: number;
  sheet: string;
  sheets: string[];
  headerRow: number;
  headerDepth: number;
  suggestedMapping: Record<string, string>;
  // 台账专有：角色清单与四型定义由引擎随识别结果下发（唯一定义在 Rust）。
  roles?: LoanRole[];
  forms?: LoanForm[];
};
type Source = {
  path: string;
  inspection?: Inspection;
  mapping: Record<string, string>;
};
type LoanRow = {
  loanId: string;
  openingPrincipal: number;
  additions: number;
  reductions: number;
  closingPrincipal: number;
  rateType: "fixed" | "floating";
  fixedRate?: number;
  benchmarkRate?: number;
  spreadBps?: number;
  calculatedInterest?: number;
  matchStatus?: string;
  matchBasis?: string;
};
type ResultRateEdit = Partial<
  Pick<LoanRow, "rateType" | "fixedRate" | "benchmarkRate" | "spreadBps">
>;
/** 与 Rust `ledger_mapping::loan_roles()` 同名同序的兜底清单（浏览器预览模式用）。 */
const LOAN_ROLE_FALLBACK: Record<string, string> = {
  principal: "本金",
  openingPrincipal: "期初余额",
  closingPrincipal: "期末余额",
  startDate: "起始日",
  endDate: "到期日",
  term: "期限",
  rate: "利率",
  rateType: "利率类型",
  drawdownAmount: "本期新增",
  repaymentAmount: "本期归还",
  loanId: "借款标识",
  lender: "贷款方",
  currency: "币种",
  drawdownDate: "新增借款日期",
  repaymentDate: "还款日期",
  repaymentMethod: "还本方式",
  loanStatus: "借款状态",
  benchmarkRate: "基准利率",
  spreadBps: "加/减点（BP）",
  remark: "备注",
};
const LABELS: Record<Kind, Record<string, string>> = {
  // 台账角色以引擎下发的 `inspection.roles` 为准；这里这份是浏览器预览模式的兜底，
  // 必须与 Rust `ledger_mapping::loan_roles()` 同名同序。
  ledger: LOAN_ROLE_FALLBACK,
  tb: {
    entity: "核算主体",
    accountCode: "借款科目编码",
    accountName: "借款科目名称",
    loanId: "借款明细/辅助核算",
    currency: "币种",
    openingDirection: "期初方向",
    closingDirection: "期末方向",
    openingFunctionalAmount: "期初余额（净额）",
    openingFunctionalDebit: "期初借方余额",
    openingFunctionalCredit: "期初贷方本金",
    closingFunctionalAmount: "期末余额（净额）",
    closingFunctionalDebit: "期末借方余额",
    closingFunctionalCredit: "期末贷方本金",
    ytdFunctionalDebit: "本年累计借方（还款）",
    ytdFunctionalCredit: "本年累计贷方（新增）",
  },
  je: {
    date: "记账日期",
    id: "凭证号",
    accountCode: "借款科目编码",
    accountName: "借款科目名称",
    loanId: "借款明细/辅助核算",
    summary: "摘要",
    functionalDebit: "借方金额",
    functionalCredit: "贷方金额",
    functionalAmount: "有符号金额",
    direction: "借贷方向",
  },
  rateLedger: LOAN_ROLE_FALLBACK,
};
export function loanEffectiveRate(
  type: string,
  fixed?: number,
  benchmark?: number,
  bps = 0,
) {
  return type === "floating" && benchmark != null
    ? Number(benchmark) + Number(bps) / 10000
    : Number(fixed ?? Number(benchmark ?? 0) + Number(bps) / 10000);
}
export function loanEquation(
  r: Pick<
    LoanRow,
    "openingPrincipal" | "additions" | "reductions" | "closingPrincipal"
  >,
) {
  return r.openingPrincipal + r.additions - r.reductions - r.closingPrincipal;
}
/** TB/JE 的余额与科目走统一角色名，同一语义有几种写法时任一到位即可。 */
const ANY_OF: Record<string, string[][]> = {
  tb: [
    ["accountCode", "accountName", "account"],
    ["loanId"],
    [
      "openingFunctionalAmount",
      "openingFunctionalDebit",
      "openingFunctionalCredit",
      "openingPrincipal",
    ],
    [
      "closingFunctionalAmount",
      "closingFunctionalDebit",
      "closingFunctionalCredit",
      "closingPrincipal",
    ],
  ],
  je: [["date"], ["accountCode", "accountName", "account"]],
};
const ANY_OF_LABEL: Record<string, string[]> = {
  tb: ["借款科目", "借款明细/辅助核算", "期初余额", "期末余额"],
  je: ["记账日期", "借款科目"],
};
/**
 * 尚未映射的必填项。
 *
 * TB／JE 走金标身份槽 ∪ 本工具必填；**借款台账与利率台账按形态判定**——
 * 必填项随命中的型号变（类型1 要到期日、类型2 要期限、类型3／5 要期间发生额），
 * 不是一张固定清单。此前这里写死「期初本金＋期末本金＋利率类型」四项，
 * 是类型3／5 的口径，套在最常见的类型1 台账上必然误报（那种表根本没有期初列，
 * 利率直接给数值也没有利率类型列），台账模式因此一直点不动测算。
 */
export function loanMissing(
  kind: Kind,
  m: Record<string, string>,
  forms?: LoanForm[],
) {
  const filled = (role: string) => Boolean(m[role]?.trim());
  const groups = ANY_OF[kind];
  if (groups) {
    const gold = missingGoldIdentity(kind === "tb" ? "tb" : "je", (role) =>
      role === "accountCode" || role === "accountName"
        ? filled(role) || filled("account")
        : filled(role),
    );
    const own = groups
      .map((g, i) => (g.some(filled) ? "" : ANY_OF_LABEL[kind][i]))
      .filter(Boolean);
    // 借款科目在金标身份槽里已经报过，本工具的「借款科目」组不再重复报。
    return [...new Set([...gold, ...own])];
  }
  // 利率台账是选填资料，映射不全不拦（用户可在变动表里逐笔手填利率）。
  if (kind === "rateLedger") return [];
  // 引擎没下发形态表（浏览器预览模式）时不拦，让后端去报。
  if (!forms?.length) return [];
  const hit = resolveLoanForm(forms, m);
  if (!hit || hit.complete) return [];
  const label = (role: string) => LOAN_ROLE_FALLBACK[role] ?? role;
  return [
    ...hit.missing.map(label),
    ...hit.missingAny.map((slot) => `${slot.map(label).join("／")}（任一）`),
    ...hit.partialOptional.map(label),
  ];
}

export function LoanInterestPage({ tool }: { tool: ToolManifest }) {
  const empty = (): Source => ({ path: "", mapping: {} });
  const [mode, setMode] = useState<Mode>("ledger");
  const [sources, setSources] = useState<Record<Kind, Source>>({
    ledger: empty(),
    tb: empty(),
    je: empty(),
    rateLedger: empty(),
  });
  const [reportEnd, setReportEnd] = useState("");
  const [rateEdits, setRateEdits] = useState<
    Record<number, Partial<LoanRateSetting>>
  >({});
  const [outputPath, setOutputPath] = useState("");
  const [rows, setRows] = useState<LoanRow[]>([]);
  const [result, setResult] = useState<Record<string, unknown>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobEvent>();
  const activeJob = useRef("");
  useEffect(() => {
    const stop = listenJobEvents((e) => {
      if (e.jobId !== activeJob.current) return;
      setJob(e);
      if (e.phase === "completed") {
        setBusy(false);
        const next = e.result as Record<string, unknown>;
        setResult(next);
        setRows((next.rows ?? []) as LoanRow[]);
      } else if (e.phase === "failed" || e.phase === "cancelled") {
        setBusy(false);
        const p = e.result as { error?: { userMessage?: string } } | undefined;
        setError(p?.error ? errorText(p.error) : e.message);
      }
    });
    return () => {
      void stop.then((x) => x());
    };
  }, []);
  const [resultRateEdits, setResultRateEdits] = useState<
    Record<string, ResultRateEdit>
  >({});
  const invalidateResults = () => {
    activeJob.current = "";
    setRows([]);
    setResult(undefined);
    setResultRateEdits({});
    setJob(undefined);
  };
  const setSource = (kind: Kind, next: Partial<Source>) => {
    invalidateResults();
    if (kind === "ledger") setRateEdits({});
    setSources((v) => ({ ...v, [kind]: { ...v[kind], ...next } }));
  };
  const activeKinds: Kind[] = mode === "ledger" ? ["ledger"] : ["tb", "je"];
  // 逐行利率口径：默认值由台账的「利率」「利率类型」两列现算（改映射立刻跟着变），
  // 用户的手工改动单独存在 rateEdits 里叠上去，两者互不覆盖。
  const ledgerInspection = sources.ledger.inspection;
  const rateDefaults = ledgerInspection
    ? loanRateDefaults(
        ledgerInspection.preview,
        ledgerInspection.headers,
        sources.ledger.mapping,
      )
    : [];
  const rateRows = resolveLoanRates(rateDefaults, rateEdits);
  const editRate = (index: number, patch: Partial<LoanRateSetting>) => {
    invalidateResults();
    setRateEdits((v) => ({ ...v, [index]: { ...v[index], ...patch } }));
  };
  const editResultRate = (index: number, patch: ResultRateEdit) => {
    const id = rows[index].loanId;
    setRows((v) =>
      v.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    setResultRateEdits((v) => ({ ...v, [id]: { ...v[id], ...patch } }));
  };
  // 台账预览区追加的两列：利率类型下拉；选了浮动才让填上浮(+)/下浮(-)点数。
  const rateColumns = [
    {
      key: "rateType",
      title: "利率类型",
      render: (i: number) => (
        <select
          className="loan-rate-pick"
          disabled={busy}
          value={rateRows[i]?.rateType ?? "fixed"}
          onChange={(e) =>
            editRate(i, {
              rateType: e.target.value as LoanRateSetting["rateType"],
            })
          }
        >
          <option value="fixed">固定</option>
          <option value="floating">浮动</option>
        </select>
      ),
    },
    {
      key: "spreadBps",
      title: "上浮(+)/下浮(-) BP",
      render: (i: number) =>
        rateRows[i]?.rateType === "floating" ? (
          <NumberInput
            label={`第 ${i + 1} 行的上浮下浮点数`}
            className="loan-rate-bps"
            step="1"
            disabled={busy}
            value={rateRows[i]?.spreadBps ?? 0}
            onCommit={(text) => editRate(i, { spreadBps: loanBps(text) })}
          />
        ) : (
          <span className="loan-rate-na">—</span>
        ),
    },
  ];
  async function browse(kind: Kind) {
    const picked = await pickPath("file", "选择表格文件", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
      "tsv",
    ]);
    if (typeof picked !== "string") return;
    setSource(kind, { path: picked, inspection: undefined, mapping: {} });
    await inspect(kind, picked);
  }
  async function inspect(
    kind: Kind,
    path = sources[kind].path,
    over?: Partial<Inspection>,
  ) {
    setBusy(true);
    setError("");
    try {
      const old = sources[kind].inspection;
      const x = (await engineCall("loan.inspect", {
        kind,
        source: {
          inputPath: path,
          sheet: over?.sheet ?? old?.sheet ?? "",
          headerRow: over?.headerRow ?? old?.headerRow ?? 0,
          // 0 = 让引擎自动判定层数（TB/JE 走 fx 内核推断；台账固定单层）。
          headerDepth: over?.headerDepth ?? old?.headerDepth ?? 0,
        },
      })) as Inspection;
      setSource(kind, { path, inspection: x, mapping: x.suggestedMapping });
      if (kind === "ledger") setRateEdits({});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function source(kind: Kind) {
    const x = sources[kind];
    return x.path
      ? {
          source: {
            inputPath: x.path,
            sheet: x.inspection?.sheet ?? "",
            headerRow: x.inspection?.headerRow ?? 1,
            headerDepth: x.inspection?.headerDepth ?? 1,
          },
          mapping: x.mapping,
        }
      : undefined;
  }
  function payload() {
    return {
      mode,
      reportStart: loanReportStart(reportEnd),
      reportEnd,
      ledgerRateOverrides:
        mode === "ledger"
          ? loanRateOverrides(rateDefaults, rateEdits)
          : undefined,
      ledgerSource: source("ledger"),
      tbSource: source("tb"),
      jeSource: source("je"),
      rateLedgerSource: source("rateLedger"),
      rateOverrides: resultRateEdits,
      ...(outputPath ? { outputPath } : {}),
    };
  }
  async function run(method: "loan.preview" | "loan.export") {
    setError("");
    if (!reportEnd) return setError("请选择资产负债表日。");
    for (const kind of activeKinds) {
      if (!sources[kind].inspection)
        return setError(`请先上传并识别${kind.toUpperCase()}。`);
      const missing = loanMissing(
        kind,
        sources[kind].mapping,
        sources[kind].inspection?.forms,
      );
      if (missing.length)
        return setError(
          `${kind.toUpperCase()}尚未映射：${missing.join("、")}。`,
        );
    }
    setBusy(true);
    try {
      activeJob.current = await jobStart(method, payload());
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
    }
  }
  return (
    <main className="tool-page fx-page loan-page">
      <PageHeader
        eyebrow="借款审计"
        title={tool.name}
        detail="从完整借款台账直接重算，或以 TB＋JE 模糊还原逐笔本金变动后测算利息。"
      />
      <ErrorBox error={error} onDismiss={() => setError("")} />
      <section className="fx-mode-bar">
        <button
          className={mode === "ledger" ? "active" : ""}
          onClick={() => {
            setMode("ledger");
            setRows([]);
          }}
        >
          以借款台账为基准
        </button>
        <button
          className={mode === "tb" ? "active" : ""}
          onClick={() => {
            setMode("tb");
            setRows([]);
          }}
        >
          以 TB 为基准
        </button>
      </section>
      {mode === "tb" && (
        <section className="loan-warning">
          <strong>TB＋JE 生成的是待复核的推算台账</strong>
          <span>
            系统按借款科目、辅助明细、摘要和记账日期模糊匹配本金新增/减少；请核对匹配依据、日期和勾稽差异。
          </span>
        </section>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            {mode === "ledger" ? "上传完整借款台账" : "上传 TB 与 JE"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="fx-hint">
            上传、表头识别和字段映射沿用汇兑损益测算的交互方式。
          </p>
          <div className="loan-upload-grid">
            {activeKinds.map((k) => (
              <Upload
                key={k}
                kind={k}
                source={sources[k]}
                busy={busy}
                browse={() => void browse(k)}
                clear={() => setSource(k, empty())}
              />
            ))}
          </div>
        </CardContent>
      </Card>
      {activeKinds.map(
        (k) =>
          sources[k].inspection && (
            <Mapping
              key={k}
              kind={k}
              source={sources[k]}
              busy={busy}
              change={(mapping) => setSource(k, { mapping })}
              header={(sheet, row, depth) =>
                void inspect(k, undefined, {
                  sheet,
                  headerRow: row,
                  headerDepth: depth,
                })
              }
              trailing={k === "ledger" ? rateColumns : undefined}
            />
          ),
      )}
      {mode === "tb" && (
        <Card>
          <CardHeader>
            <CardTitle>补充借款利率（可选）</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="fx-hint">
              可上传客户借款台账自动补充；未匹配利率可在变动表中逐笔手工填写。
            </p>
            <Upload
              kind="rateLedger"
              source={sources.rateLedger}
              busy={busy}
              browse={() => void browse("rateLedger")}
              clear={() => setSource("rateLedger", empty())}
            />
          </CardContent>
        </Card>
      )}
      {sources.rateLedger.inspection && (
        <Mapping
          kind="rateLedger"
          source={sources.rateLedger}
          busy={busy}
          change={(mapping) => setSource("rateLedger", { mapping })}
          header={(sheet, row, depth) =>
            void inspect("rateLedger", undefined, {
              sheet,
              headerRow: row,
              headerDepth: depth,
            })
          }
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>测算与底稿</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="loan-run-grid">
            <label>
              资产负债表日
              <input
                type="date"
                value={reportEnd}
                onChange={(e) => setReportEnd(e.target.value)}
              />
            </label>
            <label>
              输出文件
              <input
                value={outputPath}
                readOnly
                placeholder="默认保存到源文件目录"
              />
            </label>
            <Button
              variant="secondary"
              onClick={async () => {
                const p = await pickPath(
                  "save",
                  "保存底稿",
                  ["xlsx"],
                  "借款利息测算.xlsx",
                );
                if (typeof p === "string") setOutputPath(p);
              }}
            >
              选择位置
            </Button>
          </div>
          <p className="fx-rate-note">
            测算期间为资产负债表日所属年度的 1 月 1
            日至该日。浮动利率按“基准利率＋上浮/下浮点数（BP÷10,000）”换算有效年利率。
          </p>
          <div className="fx-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run("loan.preview")}
            >
              {mode === "tb" ? "生成并复核借款变动表" : "测算预览"}
            </Button>
            <Button disabled={busy} onClick={() => void run("loan.export")}>
              生成 Excel 底稿
            </Button>
          </div>
          {job && (
            <JobProgress
              job={job}
              onCancel={busy ? (id) => void jobCancel(id) : undefined}
            />
          )}
        </CardContent>
      </Card>
      {rows.length > 0 && (
        <Results rows={rows} editRate={editResultRate} result={result} />
      )}
    </main>
  );
}
function Upload({
  kind,
  source,
  busy,
  browse,
  clear,
}: {
  kind: Kind;
  source: Source;
  busy: boolean;
  browse: () => void;
  clear: () => void;
}) {
  const name =
    kind === "ledger"
      ? "完整借款台账"
      : kind === "rateLedger"
        ? "借款利率台账"
        : kind.toUpperCase();
  return (
    <div className="loan-upload">
      <b>{name}</b>
      <FileDropInput
        value={source.path}
        disabled={busy}
        placeholder={`选择${name}文件`}
        onBrowse={browse}
        onClear={clear}
        onDragStateChange={() => {}}
      />
      {source.inspection && (
        <small>
          已识别 {source.inspection.rowCount} 行 · {source.inspection.sheet}
        </small>
      )}
    </div>
  );
}
function Mapping({
  kind,
  source,
  busy,
  change,
  header,
  trailing,
}: {
  kind: Kind;
  source: Source;
  busy: boolean;
  change: (m: Record<string, string>) => void;
  header: (s: string, r: number, d: number) => void;
  trailing?: {
    key: string;
    title: React.ReactNode;
    render: (rowIndex: number) => React.ReactNode;
  }[];
}) {
  const x = source.inspection!;
  // 角色标签统一走共享解析：引擎下发的 roles（台账）优先，TB/JE 与浏览器预览
  // 模式没有 roles，回落本页标签表——清单与顺序仍由本页兜底表定。
  const labels = resolveRoleLabels(x.roles, LABELS[kind]);
  // TB/JE 走共用的映射复核；借款台账与利率台账不是账表，没有对应的复核规则。
  const [review, setReview] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const reviewable = kind === "tb" || kind === "je";
  async function runReview() {
    setReviewing(true);
    setReview("正在复核字段映射…");
    try {
      const { mapping, applied } = await applyLedgerReviewToDict(
        engineCall,
        kind as "je" | "tb",
        x.headers,
        x.preview,
        source.mapping,
        labels,
      );
      change(mapping as Record<string, string>);
      setReview(
        applied.length
          ? `复核完成，已应用 ${applied.length} 项建议。`
          : "复核完成，当前映射无需调整。",
      );
    } catch (e) {
      setReview(`${errorText(e)} 可继续手工映射。`);
    } finally {
      setReviewing(false);
    }
  }
  const name =
    kind === "ledger"
      ? "借款台账"
      : kind === "rateLedger"
        ? "利率台账"
        : kind.toUpperCase();
  // 角色清单与标签：台账兜底表与引擎的 loan_roles 同名同序，合并后下拉顺序不变；
  // 引擎标签与本地不一致时以引擎为准（唯一定义在 Rust）。
  const roleList: [string, string][] = Object.entries(labels);
  // 借款台账按四型判定：命中哪一型决定哪些字段必填。利率台账不判型。
  const hit =
    kind === "ledger" && x.forms?.length
      ? resolveLoanForm(x.forms, source.mapping)
      : undefined;
  const formNote = hit
    ? describeLoanForm(hit, (role) => labels[role] ?? role)
    : undefined;
  return (
    <>
      <MappingPanel
        title={`${name}字段映射`}
        note={`${x.rowCount} 行 × ${x.headers.length} 列`}
        headers={x.headers}
        rows={x.preview}
        mapping={source.mapping}
        roles={roleList}
        requirementOf={
          hit ? (role) => loanRoleRequirement(hit, role) : undefined
        }
        trailingColumns={trailing}
        formNote={formNote}
        missing={loanMissing(kind, source.mapping, x.forms)}
        busy={busy || reviewing}
        maxHeight={360}
        toolbar={
          <>
            <label>
              Sheet
              <select
                value={x.sheet}
                onChange={(e) => header(e.target.value, 0, 0)}
              >
                {x.sheets.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              标题行
              <input
                type="number"
                min={1}
                value={x.headerRow}
                onChange={(e) =>
                  header(x.sheet, Number(e.target.value), x.headerDepth)
                }
              />
            </label>
            {/* 表头层数只有 TB/JE 需要（「金额」下再分借方/贷方的两层表头）； */}
            {/* 台账固定单层，引擎也不支持多级表头，不给这个控件。 */}
            {reviewable && (
              <label>
                表头层数
                <select
                  value={x.headerDepth}
                  onChange={(e) =>
                    header(x.sheet, x.headerRow, Number(e.target.value))
                  }
                >
                  <option value={1}>1层</option>
                  <option value={2}>2层</option>
                </select>
              </label>
            )}
            {reviewable && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || reviewing}
                onClick={() => void runReview()}
              >
                {reviewing ? "复核中…" : "LLM 复核映射"}
              </Button>
            )}
          </>
        }
        onChange={(next) => change(next as Record<string, string>)}
      />
      {review && <p className="fx-hint">{review}</p>}
    </>
  );
}
function Results({
  rows,
  editRate,
  result,
}: {
  rows: LoanRow[];
  editRate: (index: number, patch: ResultRateEdit) => void;
  result?: Record<string, unknown>;
}) {
  const total = rows.reduce((s, r) => s + Number(r.calculatedInterest ?? 0), 0);
  return (
    <section className="loan-results">
      <div className="fx-result-heading">
        <div>
          <h3>借款本金变动与利息测算</h3>
          <p>期初＋本期增加－本期减少＝期末；请优先处理待复核行。</p>
        </div>
        {((result?.outputPaths ?? []) as string[]).map((p) => (
          <Button
            key={p}
            variant="secondary"
            onClick={() => void openOutput(p)}
          >
            打开 Excel 底稿
          </Button>
        ))}
      </div>
      <div className="loan-summary">
        <span>
          借款笔数<strong>{rows.length}</strong>
        </span>
        <span>
          测算利息合计
          <strong>
            {total.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}
          </strong>
        </span>
        <span>
          待复核
          <strong>
            {rows.filter((r) => r.matchStatus !== "已匹配").length}
          </strong>
        </span>
      </div>
      <div className="loan-rate-table">
        <table>
          <thead>
            <tr>
              <th>借款标识</th>
              <th>期初</th>
              <th>增加</th>
              <th>减少</th>
              <th>期末</th>
              <th>勾稽差异</th>
              <th>利率类型</th>
              <th>固定/基准利率</th>
              <th>加点 BP</th>
              <th>有效利率</th>
              <th>测算利息</th>
              <th>匹配状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.loanId}-${i}`}>
                <td title={r.matchBasis}>{r.loanId}</td>
                {[
                  r.openingPrincipal,
                  r.additions,
                  r.reductions,
                  r.closingPrincipal,
                  loanEquation(r),
                ].map((n, j) => (
                  <td key={j}>{Number(n).toLocaleString()}</td>
                ))}
                <td>
                  <select
                    value={r.rateType}
                    onChange={(e) => {
                      const rateType = e.target.value as LoanRow["rateType"];
                      editRate(
                        i,
                        rateType === "floating"
                          ? { rateType, fixedRate: undefined }
                          : {
                              rateType,
                              benchmarkRate: undefined,
                              spreadBps: undefined,
                            },
                      );
                    }}
                  >
                    <option value="fixed">固定</option>
                    <option value="floating">浮动</option>
                  </select>
                </td>
                <td>
                  <NumberInput
                    label={`${r.loanId}的${
                      r.rateType === "fixed" ? "固定利率" : "基准利率"
                    }`}
                    step=".0001"
                    value={
                      r.rateType === "fixed"
                        ? (r.fixedRate ?? "")
                        : (r.benchmarkRate ?? "")
                    }
                    onCommit={(text) =>
                      editRate(
                        i,
                        r.rateType === "fixed"
                          ? { fixedRate: loanRateValue(text) }
                          : { benchmarkRate: loanRateValue(text) },
                      )
                    }
                  />
                </td>
                <td>
                  <NumberInput
                    label={`${r.loanId}的加点 BP`}
                    step="1"
                    disabled={r.rateType !== "floating"}
                    value={r.spreadBps ?? 0}
                    onCommit={(text) =>
                      editRate(i, { spreadBps: loanBps(text) })
                    }
                  />
                </td>
                <td>
                  {r.rateType === "floating" && r.benchmarkRate == null
                    ? "请再次测算"
                    : `${(
                        loanEffectiveRate(
                          r.rateType,
                          r.fixedRate,
                          r.benchmarkRate,
                          r.spreadBps,
                        ) * 100
                      ).toFixed(4)}%`}
                </td>
                <td>{Number(r.calculatedInterest ?? 0).toLocaleString()}</td>
                <td>
                  <span
                    className={
                      r.matchStatus === "已匹配" ? "loan-ok" : "loan-review"
                    }
                  >
                    {r.matchStatus ?? "—"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fx-rate-note">
        修改利率后请再次测算。已有执行利率默认为固定利率；手动改为浮动后，不再沿用执行利率，改按基准利率加减BP重算。
      </p>
    </section>
  );
}
