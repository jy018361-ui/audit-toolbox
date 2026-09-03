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
import { StepIndicator } from "@/components/StepIndicator";
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
  formGroups,
  useLedgerForms,
  type LedgerFormKind,
} from "@/ledgerForms";
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
/** 底稿反馈里只展示文件名，完整路径放 title 悬浮提示。 */
function fileNameOf(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
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
  const [step, setStep] = useState(0);
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
  const sourcesReady = activeKinds.every((kind) => sources[kind].inspection);
  const mappingsReady =
    sourcesReady &&
    activeKinds.every(
      (kind) =>
        loanMissing(
          kind,
          sources[kind].mapping,
          sources[kind].inspection?.forms,
        ).length === 0,
    );
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
  // 导出完成后除结果区的打开按钮外，测算卡里也要有明确的「已生成＋文件名＋打开」
  // 反馈——此前唯一反馈是结果区标题旁悄悄出现的小按钮，用户感知不到已导出。
  const exported = ((result?.outputPaths ?? []) as string[]).filter(Boolean);
  return (
    <main className="tool-page fx-page loan-page">
      <PageHeader
        eyebrow="借款审计"
        title={tool.name}
        detail="从完整借款台账直接重算，或以 TB＋JE 模糊还原逐笔本金变动后测算利息。"
      />
      <ErrorBox error={error} onDismiss={() => setError("")} />
      <StepIndicator
        steps={[
          { key: "source", label: "上传与识别" },
          { key: "rates", label: "利率确认", disabled: !sourcesReady },
          { key: "run", label: "测算与底稿", disabled: !mappingsReady },
        ]}
        current={step}
        onStepClick={setStep}
      />

      {step === 0 && (
        <>
          <section className="fx-mode-bar">
            <button
              className={mode === "ledger" ? "active" : ""}
              onClick={() => {
                invalidateResults();
                setMode("ledger");
              }}
            >
              完整借款台账
            </button>
            <button
              className={mode === "tb" ? "active" : ""}
              onClick={() => {
                invalidateResults();
                setMode("tb");
              }}
            >
              TB＋JE
            </button>
          </section>
          {mode === "tb" && (
            <section className="loan-warning">
              <strong>TB＋JE 将生成待复核的推算台账</strong>
              <span>请重点核对本金变动、匹配依据和勾稽差异。</span>
            </section>
          )}
          <Card>
            <CardHeader>
              <CardTitle>
                {mode === "ledger" ? "上传完整借款台账" : "上传 TB 与 JE"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="loan-upload-grid">
                {activeKinds.map((kind) => (
                  <Upload
                    key={kind}
                    kind={kind}
                    source={sources[kind]}
                    busy={busy}
                    browse={() => void browse(kind)}
                    clear={() => setSource(kind, empty())}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
          {activeKinds.map(
            (kind) =>
              sources[kind].inspection && (
                <Mapping
                  key={kind}
                  kind={kind}
                  source={sources[kind]}
                  busy={busy}
                  change={(mapping) => setSource(kind, { mapping })}
                  header={(sheet, row, depth) =>
                    void inspect(kind, undefined, {
                      sheet,
                      headerRow: row,
                      headerDepth: depth,
                    })
                  }
                />
              ),
          )}
          <div className="fx-step-actions">
            <Button disabled={!sourcesReady} onClick={() => setStep(1)}>
              下一步：利率确认
            </Button>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          {mode === "ledger" ? (
            <LedgerRateConfirmation
              inspection={ledgerInspection!}
              mapping={sources.ledger.mapping}
              rates={rateRows}
              busy={busy}
              onEdit={editRate}
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>补充借款利率（可选）</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="fx-hint">
                  可上传借款台账自动补充；未匹配项可在测算结果中逐笔填写。
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
          {mode === "tb" && sources.rateLedger.inspection && (
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
          <div className="fx-step-actions">
            <Button variant="secondary" onClick={() => setStep(0)}>
              返回上传与识别
            </Button>
            <Button disabled={!mappingsReady} onClick={() => setStep(2)}>
              下一步：测算与底稿
            </Button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
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
                  <span className="loan-output-row">
                    <input
                      value={outputPath}
                      readOnly
                      placeholder="默认保存到源文件目录"
                    />
                    <Button
                      variant="secondary"
                      onClick={async () => {
                        const path = await pickPath(
                          "save",
                          "保存底稿",
                          ["xlsx"],
                          "借款利息测算.xlsx",
                        );
                        if (typeof path === "string") setOutputPath(path);
                      }}
                    >
                      选择位置
                    </Button>
                  </span>
                </label>
              </div>
              <p className="fx-rate-note">
                浮动利率按“基准利率＋加减点（BP÷10,000）”换算有效年利率。
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
              {!busy && exported.length > 0 && (
                <div className="loan-export-done" role="status">
                  <strong>Excel 底稿已生成</strong>
                  {exported.map((p) => (
                    <span key={p} className="loan-export-path">
                      <span className="loan-export-file" title={p}>
                        {fileNameOf(p)}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void openOutput(p)}
                      >
                        打开底稿
                      </Button>
                    </span>
                  ))}
                </div>
              )}
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
          <div className="fx-step-actions">
            <Button variant="secondary" onClick={() => setStep(1)}>
              返回利率确认
            </Button>
          </div>
        </>
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
          已识别 {source.inspection.rowCount.toLocaleString()} 行 ×{" "}
          {source.inspection.headers.length} 列
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
}: {
  kind: Kind;
  source: Source;
  busy: boolean;
  change: (m: Record<string, string>) => void;
  header: (s: string, r: number, d: number) => void;
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
  // 下拉分组与其他账表工具一致：借款/利率台账用引擎随识别下发的形态表，
  // TB/JE 用共享内核的形态表（formGroups 已支持 loan）。
  const groupKind: LedgerFormKind = kind === "tb" || kind === "je" ? kind : "loan";
  const fetchedForms = useLedgerForms(groupKind);
  const forms =
    groupKind === "loan" && x.forms?.length ? x.forms : fetchedForms;
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
        headers={x.headers}
        rows={x.preview}
        mapping={source.mapping}
        roles={roleList}
        groups={formGroups(groupKind, roleList, forms, source.mapping)}
        requirementOf={
          hit ? (role) => loanRoleRequirement(hit, role) : undefined
        }
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

function LedgerRateConfirmation({
  inspection,
  mapping,
  rates,
  busy,
  onEdit,
}: {
  inspection: Inspection;
  mapping: Record<string, string>;
  rates: LoanRateSetting[];
  busy: boolean;
  onEdit: (index: number, patch: Partial<LoanRateSetting>) => void;
}) {
  const valueAt = (row: string[], role: string) => {
    const index = inspection.headers.indexOf(mapping[role] ?? "");
    return index >= 0 ? (row[index] ?? "") : "";
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>借款利率确认</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="loan-rate-confirmation">
          <table>
            <thead>
              <tr>
                <th>借款标识</th>
                <th>台账利率</th>
                <th>利率类型</th>
                <th>加减点（BP）</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {inspection.preview.map((row, index) => {
                const sourceRate = valueAt(row, "rate");
                const loanId =
                  valueAt(row, "loanId") ||
                  valueAt(row, "lender") ||
                  `第 ${index + 1} 行`;
                const rate = rates[index] ?? {
                  rateType: "fixed",
                  spreadBps: 0,
                };
                return (
                  <tr key={`${loanId}-${index}`}>
                    <td title={loanId}>{loanId}</td>
                    <td>{sourceRate || "—"}</td>
                    <td>
                      <select
                        className="loan-rate-pick"
                        disabled={busy}
                        value={rate.rateType}
                        onChange={(event) =>
                          onEdit(index, {
                            rateType: event.target
                              .value as LoanRateSetting["rateType"],
                          })
                        }
                      >
                        <option value="fixed">固定</option>
                        <option value="floating">浮动</option>
                      </select>
                    </td>
                    <td>
                      <NumberInput
                        label={`${loanId}的加减点`}
                        className="loan-rate-bps"
                        step="1"
                        disabled={busy || rate.rateType !== "floating"}
                        value={rate.spreadBps}
                        onCommit={(text) =>
                          onEdit(index, { spreadBps: loanBps(text) })
                        }
                      />
                    </td>
                    <td>
                      <span className={sourceRate ? "loan-ok" : "loan-review"}>
                        {sourceRate ? "已识别" : "待补充"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
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
  const totals = rows.reduce(
    (sum, row) => ({
      opening: sum.opening + Number(row.openingPrincipal),
      additions: sum.additions + Number(row.additions),
      reductions: sum.reductions + Number(row.reductions),
      closing: sum.closing + Number(row.closingPrincipal),
    }),
    { opening: 0, additions: 0, reductions: 0, closing: 0 },
  );
  const amount = (value: number) =>
    value.toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const metric = (label: string, value: number | string) => (
    <div className="fx-bridge-metric">
      <span>{label}</span>
      <strong>{typeof value === "number" ? amount(value) : value}</strong>
    </div>
  );
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
      <div className="fx-bridge-step">
        <div className="fx-step-label">
          <b>1</b>
          <span>本金变动</span>
        </div>
        <div className="loan-bridge-equation">
          {metric("期初本金", totals.opening)}
          <span className="fx-operator" aria-hidden="true">
            ＋
          </span>
          {metric("本期增加", totals.additions)}
          <span className="fx-operator" aria-hidden="true">
            －
          </span>
          {metric("本期减少", totals.reductions)}
          <span className="fx-operator" aria-hidden="true">
            ＝
          </span>
          {metric("期末本金", totals.closing)}
        </div>
      </div>
      <div className="fx-bridge-step comparison">
        <div className="fx-step-label">
          <b>2</b>
          <span>测算结果</span>
        </div>
        <div className="loan-result-summary">
          {metric("借款笔数", `${rows.length} 笔`)}
          {metric("测算利息合计", total)}
          {metric(
            "待复核",
            `${rows.filter((row) => row.matchStatus !== "已匹配").length} 笔`,
          )}
        </div>
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
