import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ToolManifest, JobEvent } from "./types";
import { engineCall, jobCancel, jobStart, listenPositionedFileDrops, listenJobEvents, openOutput, openReferenceUrl, pickPath } from "./api";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { applyLedgerReviewToDict, missingGoldIdentity } from "@/ledgerMapping";
import { MappingPanel } from "@/components/MappingPanel";

/** 可多列的角色与统一内核一致；`account` 是历史保存映射的旧槽位。 */
const DEPOSIT_MULTI = new Set(["id", "accountName", "auxiliary", "account"]);
import "./fx-audit.css";
import "./deposit-interest.css";

type Kind = "je" | "tb";
type DayBasis = "month12" | "actual360" | "actual365";
type SignChoice = "auto" | "unsigned" | "signed";
type Inspection = {
  headers: string[]; sheet: string; sheets: string[]; headerRow: number; headerDepth: number;
  rowCount: number; preview: string[][]; entities: string[]; accounts: string[];
  suggestedMapping: Record<string, string | string[]>;
  suggestedAccountRoles: Record<string, string>;
  mappingCandidates: Array<{role: string; candidates: Array<{column: string; confidence: number; conflictTerms: string[]}>}>;
  headerDetection: {needsConfirmation: boolean; candidates: Array<{row: number; score: number}>};
  dataYears: number[]; suggestedBalanceSheetDate?: string;
};
type SourceClassification = {kind: Kind; confidence: number; needsLlm: boolean; scores: {je: number; tb: number}; headers: string[]; preview: string[][]; sheet: string; headerRow: number; headerDepth: number};
type RateTier = {
  key: string; category: string; categoryLabel: string; termLabel: string; label: string;
  benchmarkRate: number | null; listedRate: number | null; autoApply: boolean;
  practiceLow: number | null; practiceHigh: number | null; practiceNote: string;
};
type RateCategory = {key: string; label: string; terms: Array<{key: string; label: string}>};
type ReferenceLink = {label: string; url: string; hint: string; group: string};
type ReferenceGroup = {key: string; label: string; hint: string};
type RateTiers = {
  benchmarkDate: string; listedDate: string; benchmarkSource: string; listedSource: string;
  practiceSource: string; authority: string; autoApplyPolicy: string;
  links: ReferenceLink[]; linkGroups: ReferenceGroup[];
  listedRateDate: string; rateAgeMonths: number; ratesStale: boolean; staleMessage: string;
  categories: RateCategory[]; tiers: RateTier[];
};
type MonthCell = {month: number; opening: number; debit: number; credit: number; closing: number; average: number; days: number; denominator: number; interest: number};
type AccountRow = {
  key: string; entity: string; account: string; auxiliary: string; currency: string; role: string;
  tier: string; tierLabel: string; category: string; termLabel: string; tierMatchedBy: string;
  rateSource: string; annualRate: number; rateResolved: boolean; rateWarning: string;
  openingBalance: number; tbClosingBalance: number; derivedClosingBalance: number; reconciliationDiff: number;
  averageBalance: number; calculatedInterest: number; months: MonthCell[]; status: string; note: string;
};

// 角色名与 Rust 侧的统一映射内核（ledger_mapping.rs）一一对应，五个工具共用。
const JE_LABELS: Record<string, string> = {
  date: "记账日期", id: "凭证号", voucherType: "凭证类型",
  entity: "公司/核算主体", accountCode: "科目编码", accountName: "科目名称",
  auxiliary: "辅助核算/银行账户", summary: "摘要", currency: "币种",
  functionalDebit: "借方金额", functionalCredit: "贷方金额",
  functionalAmount: "本位币有符号金额", direction: "借贷方向",
};
const TB_LABELS: Record<string, string> = {
  entity: "公司/核算主体", accountCode: "科目编码", accountName: "科目名称",
  auxiliary: "辅助核算/银行账户", currency: "币种", period: "会计期间（选填）",
  openingDirection: "期初方向", closingDirection: "期末方向",
  openingFunctionalAmount: "年初余额（净额）",
  openingFunctionalDebit: "年初余额借方", openingFunctionalCredit: "年初余额贷方",
  closingFunctionalAmount: "期末余额（净额）",
  closingFunctionalDebit: "期末余额借方", closingFunctionalCredit: "期末余额贷方",
  ytdFunctionalDebit: "本年累计借方发生额", ytdFunctionalCredit: "本年累计贷方发生额",
  periodFunctionalDebit: "本期借方发生额", periodFunctionalCredit: "本期贷方发生额",
};
const ROLE_OPTIONS: Array<[string, string]> = [
  ["deposit", "银行存款（计息）"],
  ["other_monetary", "其他货币资金（计息）"],
  ["cash_on_hand", "库存现金（默认不计息）"],
  ["interest_income", "利息收入（勾稽基准）"],
  ["excluded", "不参与测算"],
];
const DAY_BASIS_OPTIONS: Array<[DayBasis, string]> = [
  ["month12", "年利率÷12（按月平均）"],
  ["actual360", "实际天数÷360（银行计息惯例）"],
  ["actual365", "实际天数÷365"],
];

/** 上传的 TB 至少要能取出年初和年末余额；序时账只在提供时才校验。 */
/**
 * 有序时账时年初余额不是必填——SAP 的 Trial Balance LC/GC 只出 MTD/YTD，
 * 根本没有年初余额列，这时由"期末余额 − 期间内发生额"倒推。
 */
export function depositMissingRequired(kind: Kind, mapping: Record<string, string | string[]>, hasJe = false): string[] {
  const has = (role: string) => {
    const value = mapping[role];
    return Array.isArray(value) ? value.some((item) => item.trim()) : Boolean(String(value ?? "").trim());
  };
  // 金标身份槽在前，本工具自己的必填在后，两者取并集。
  // 历史保存的映射把科目编码与名称混在一个 account 里，判定时一并认。
  const missing: string[] = missingGoldIdentity(kind === "tb" ? "tb" : "je", (role) =>
    role === "accountCode" || role === "accountName" ? has(role) || has("account") : has(role),
  );
  if (kind === "tb") {
    if (!(has("closingFunctionalAmount") || has("closingFunctionalDebit") || has("closingFunctionalCredit")))
      missing.push("期末余额方案");
    if (!hasJe && !(has("openingFunctionalAmount") || has("openingFunctionalDebit") || has("openingFunctionalCredit")))
      missing.push("期初余额方案（或上传序时账）");
  } else {
    // 序时账一律走记账日期：会计期间只在科目余额表上有用，
    // 旧版把两者当成二选一放行，后端却硬性要求日期列。
    if (!(has("functionalAmount") || has("functionalDebit") || has("functionalCredit")))
      missing.push("发生额方案");
  }
  // 金标身份槽与本工具声明可能指向同一角色（记账日期、科目编码），只报一次。
  return [...new Set(missing)];
}

/**
 * 序时账的金额布局。这一维不是用户选的——映射了哪几列就定了哪种布局，
 * 再配上"符号记法"两种取值，合起来就是看账工具说的 5 种形态：
 * 借贷分列×2、金额＋方向列×2、单一金额列×1（必然已带符号）。
 */
export type JeLayout = "split" | "directed" | "single" | "none";
export function depositJeLayout(mapping: Record<string, string | string[]>): JeLayout {
  const has = (role: string) => {
    const value = mapping[role];
    return Array.isArray(value) ? value.some((item) => item.trim()) : Boolean(String(value ?? "").trim());
  };
  // 角色名与统一映射内核一致（functionalDebit 等）；后端读的也是这套新名，
  // 旧名写法在这里放行只会让测算在更晚一步报映射缺失。
  if (has("functionalDebit") && has("functionalCredit")) return "split";
  if (has("functionalAmount") && has("direction")) return "directed";
  if (has("functionalAmount")) return "single";
  return "none";
}
export const JE_LAYOUT_LABEL: Record<JeLayout, string> = {
  split: "借贷分列",
  directed: "金额＋方向列",
  single: "单一金额列",
  none: "尚未映射金额字段",
};
/** 每种布局下"符号记法"的两个取值，措辞必须贴着该布局说，否则会误导。 */
export function depositSignOptions(layout: JeLayout): Array<[SignChoice, string]> {
  if (layout === "split") {
    return [
      ["unsigned", "借方、贷方两列都是正数"],
      ["signed", "贷方列是负数（借正贷负）"],
    ];
  }
  if (layout === "directed") {
    return [
      ["unsigned", "金额都是正数，靠借贷方向列区分"],
      ["signed", "金额已带正负号（借正贷负）"],
    ];
  }
  // 单一金额列只有一种可能：不带符号就配不出借贷，凭证也就配不平。
  return [];
}

/** 利率一律以百分数呈现给用户，内部仍用小数（0.05% ↔ 0.0005）。 */
export function depositRateToPercent(rate: number | undefined | null) {
  if (rate == null || !Number.isFinite(rate)) return "";
  return String(Number((rate * 100).toFixed(6)));
}
export function depositPercentToRate(text: string) {
  if (text.trim() === "") return Number.NaN;
  const value = Number(text);
  return Number.isFinite(value) ? value / 100 : Number.NaN;
}
export function depositReportStart(balanceSheetDate: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(balanceSheetDate) ? `${balanceSheetDate.slice(0, 4)}-01-01` : "";
}
export function depositDropTargetInside(x: number, y: number, rect?: Pick<DOMRect, "left" | "right" | "top" | "bottom">) {
  return Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
}
/** 月均余额口径：（月初＋月末）÷2，与导出 Excel 里的公式保持同一条式子。 */
export function depositMonthlyAverage(opening: number, closing: number) {
  return (Number(opening) + Number(closing)) / 2;
}
/** 月度利息 = 月均余额 × 年利率 × 计息天数 ÷ 年基数；month12 口径下天数=1、基数=12。 */
export function depositMonthlyInterest(average: number, annualRate: number, days: number, denominator: number) {
  return denominator === 0 ? 0 : (Number(average) * Number(annualRate) * Number(days)) / Number(denominator);
}
/** 自动套用的默认利率：只有活期有。其余档位必须由用户填实际利率。 */
export function depositAutoRate(tier: RateTier | undefined) {
  return tier?.autoApply ? tier.listedRate ?? undefined : undefined;
}
/** 档位实际采用的利率：用户改写过就用改写值，否则只有活期有内置默认值。 */
export function depositEffectiveTierRate(tier: RateTier | undefined, custom: Record<string, number>) {
  if (!tier) return undefined;
  const overridden = custom[tier.key];
  return Number.isFinite(overridden) ? overridden : depositAutoRate(tier);
}
/** 央行基准只作上限参照：填入的利率高于基准时提示确认，绝不参与测算。 */
export function depositRateAboveBenchmark(tier: RateTier | undefined, rate: number) {
  if (!tier || tier.benchmarkRate == null || !Number.isFinite(rate)) return false;
  return rate > tier.benchmarkRate;
}
/** 只有存在有名称的期限时才需要第二级下拉（活期、协定、自定义没有期限）。 */
export function depositTermsOf(tiers: RateTiers | undefined, category: string) {
  return (tiers?.categories.find((item) => item.key === category)?.terms ?? []).filter((term) => term.label);
}
/** 切换大类时落到该大类的第一个期限，避免出现"大类变了但档位没变"。 */
export function depositFirstTierOf(tiers: RateTiers | undefined, category: string) {
  return tiers?.categories.find((item) => item.key === category)?.terms[0]?.key ?? category;
}
export function depositRateOutOfPractice(tier: RateTier | undefined, rate: number) {
  if (!tier || tier.practiceLow == null || tier.practiceHigh == null || !Number.isFinite(rate)) return false;
  return rate < tier.practiceLow || rate > tier.practiceHigh;
}

export function DepositInterestPage({ tool }: { tool: ToolManifest }) {
  const [jePath, setJePath] = useState(""); const [tbPath, setTbPath] = useState("");
  const [je, setJe] = useState<Inspection>(); const [tb, setTb] = useState<Inspection>();
  const [jeMapping, setJeMapping] = useState<Record<string, string | string[]>>({});
  const [tbMapping, setTbMapping] = useState<Record<string, string | string[]>>({});
  const [accountRoles, setAccountRoles] = useState<Record<string, string>>({});
  const [reportEnd, setReportEnd] = useState("");
  const [dayBasis, setDayBasis] = useState<DayBasis>("month12");
  const [signOverride, setSignOverride] = useState<SignChoice>("auto");
  const [includeCashOnHand, setIncludeCashOnHand] = useState(false);
  const [tiers, setTiers] = useState<RateTiers>();
  const [tierRates, setTierRates] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [rateOverrides, setRateOverrides] = useState<Record<string, {tier?: string; annualRate?: number}>>({});
  const [expanded, setExpanded] = useState("");
  const [result, setResult] = useState<Record<string, unknown>>();
  const [outputPath, setOutputPath] = useState("");
  const [sourceStatus, setSourceStatus] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [job, setJob] = useState<JobEvent>();
  const activeJob = useRef(""); const uploadDropRef = useRef<HTMLDivElement>(null);

  const accounts = useMemo(() => [...new Set([...(tb?.accounts ?? []), ...(je?.accounts ?? [])])], [je, tb]);
  const depositAccounts = accounts.filter((a) => ["deposit", "other_monetary", "cash_on_hand"].includes(accountRoles[a] ?? ""));
  const interestAccounts = accounts.filter((a) => (accountRoles[a] ?? "") === "interest_income");

  useEffect(() => { void engineCall("deposit.rate_tiers", {}).then((x) => setTiers(x as RateTiers)).catch(() => undefined) }, []);
  useEffect(() => {
    setAccountRoles((current) => Object.fromEntries(accounts.map((account) => {
      const suggested = tb?.suggestedAccountRoles?.[account] ?? je?.suggestedAccountRoles?.[account] ?? "excluded";
      return [account, current[account] ?? suggested];
    })));
  }, [accounts, je, tb]);
  useEffect(() => {
    const drops = listenPositionedFileDrops(({paths, x, y}) => {
      if (!depositDropTargetInside(x, y, uploadDropRef.current?.getBoundingClientRect())) return;
      void classifyAndInspect(paths);
    });
    const jobs = listenJobEvents((event) => {
      if (event.jobId !== activeJob.current) return;
      setJob(event);
      if (event.phase === "completed") {
        setBusy(false);
        const next = event.result as Record<string, unknown>;
        setResult((current) => ({...current, ...next}));
        setRows((next.rows ?? []) as AccountRow[]);
      } else if (event.phase === "failed" || event.phase === "cancelled") {
        setBusy(false);
        const payload = event.result as {error?: {userMessage?: string}} | undefined;
        setError(payload?.error?.userMessage ?? event.message);
      }
    });
    return () => { void drops.then((x) => x()); void jobs.then((x) => x()) };
  }, []);

  async function browse() {
    const picked = await pickPath("files", "选择 TB 或序时账文件", ["xlsx", "xls", "xlsm", "csv", "txt", "tsv", "parquet"]);
    if (!picked) return;
    void classifyAndInspect(Array.isArray(picked) ? picked : [picked]);
  }
  async function classifyAndInspect(paths: string[]) {
    const files = paths.filter((p) => /\.(xlsx?|xlsm|csv|txt|tsv|parquet)$/i.test(p));
    if (!files.length) return;
    setBusy(true); setError(""); setSourceStatus("正在识别文件类型、表头和字段…");
    const failures: string[] = [];
    try {
      for (const path of files) {
        try {
          const scripted = await engineCall("deposit.classify_source", {source: {inputPath: path, sheet: "", headerRow: 0, headerDepth: 0}}) as SourceClassification;
          const response = await engineCall(`deposit.inspect_${scripted.kind}`, {source: {inputPath: path, sheet: scripted.sheet, headerRow: scripted.headerRow, headerDepth: scripted.headerDepth}}) as Inspection;
          applyInspection(scripted.kind, path, response);
          setSourceStatus(`${files.length} 个文件已识别；${scripted.kind === "tb" ? "TB 科目余额表" : "JE 序时账"}由脚本判定。`);
        } catch (e) { failures.push(`${fileName(path)}：${errorText(e)}`) }
      }
      if (failures.length) setError(failures.join("；"));
    } finally { setBusy(false) }
  }
  function applyInspection(kind: Kind, path: string, response: Inspection) {
    if (response.suggestedBalanceSheetDate) setReportEnd(response.suggestedBalanceSheetDate);
    else if (response.dataYears?.length === 1) setReportEnd(`${response.dataYears[0]}-12-31`);
    if (kind === "je") { setJePath(path); setJe(response); setJeMapping(response.suggestedMapping) }
    else { setTbPath(path); setTb(response); setTbMapping(response.suggestedMapping) }
    setRows([]); setResult(undefined);
  }
  async function inspect(kind: Kind, over?: Partial<{sheet: string; headerRow: number; headerDepth: number}>) {
    setBusy(true); setError("");
    try {
      const current = kind === "je" ? je : tb;
      const response = await engineCall(`deposit.inspect_${kind}`, {source: {
        inputPath: kind === "je" ? jePath : tbPath,
        sheet: over?.sheet ?? current?.sheet ?? "",
        headerRow: over?.headerRow ?? current?.headerRow ?? 0,
        headerDepth: over?.headerDepth ?? current?.headerDepth ?? 0,
      }}) as Inspection;
      applyInspection(kind, kind === "je" ? jePath : tbPath, response);
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  function payload() {
    return {
      reportStart: depositReportStart(reportEnd), reportEnd, dayBasis, includeCashOnHand,
      ...(signOverride === "auto" ? {} : {signOverride}),
      tbSource: {inputPath: tbPath, sheet: tb?.sheet ?? "", headerRow: tb?.headerRow ?? 0, headerDepth: tb?.headerDepth ?? 0},
      tbMapping,
      ...(jePath ? {jeSource: {inputPath: jePath, sheet: je?.sheet ?? "", headerRow: je?.headerRow ?? 0, headerDepth: je?.headerDepth ?? 0}, jeMapping} : {}),
      accountRoles, rateOverrides, tierRates,
      ...(outputPath ? {outputPath} : {}),
    };
  }
  async function run(method: "deposit.preview" | "deposit.export") {
    setError("");
    if (!tb) return setError("请先上传并识别 TB 科目余额表。");
    if (!reportEnd) return setError("请选择资产负债表日。");
    const tbMissing = depositMissingRequired("tb", tbMapping, Boolean(jePath));
    if (tbMissing.length) return setError(`TB 尚未映射：${tbMissing.join("、")}。请先在预览表头完成字段映射。`);
    if (jePath) {
      const jeMissing = depositMissingRequired("je", jeMapping);
      if (jeMissing.length) return setError(`序时账尚未映射：${jeMissing.join("、")}。请先在预览表头完成字段映射。`);
    }
    if (!depositAccounts.length) return setError("科目分类里没有任何计息的货币资金科目，请先确认银行存款/其他货币资金科目。");
    setBusy(true);
    try { activeJob.current = await jobStart(method, payload()) }
    catch (e) { setBusy(false); setError(errorText(e)) }
  }
  function overrideRow(key: string, next: {tier?: string; annualRate?: number}) {
    setRateOverrides((current) => ({...current, [key]: {...current[key], ...next}}));
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      const tier = next.tier ?? row.tier;
      const meta = tiers?.tiers.find((t) => t.key === tier);
      const tierRate = next.tier ? depositEffectiveTierRate(meta, tierRates) : undefined;
      const rate = next.annualRate ?? (next.tier ? tierRate ?? 0 : row.annualRate);
      return {
        ...row, tier, annualRate: rate,
        tierLabel: meta?.label ?? row.tierLabel,
        category: meta?.category ?? row.category,
        termLabel: meta?.termLabel ?? row.termLabel,
        tierMatchedBy: next.tier ? "用户手工选择档位" : row.tierMatchedBy,
        rateResolved: next.annualRate !== undefined ? Number.isFinite(next.annualRate) : (next.tier ? tierRate !== undefined : row.rateResolved),
        rateSource: next.annualRate !== undefined ? "本账户手工指定"
          : next.tier ? (tierRate === undefined ? "需填写实际利率" : (tierRates[tier] === undefined ? "活期挂牌默认值" : "自定义档位利率"))
          : row.rateSource,
      };
    }));
  }

  return <main className="tool-page fx-page deposit-page">
    <PageHeader eyebrow="货币资金审计" title={tool.name}
      detail="识别货币资金科目，按序时账还原逐月余额，以（月初＋月末）÷2 的月均余额乘存款利率重算利息，并与 TB 利息收入勾稽。" />
    <ErrorBox error={error} onDismiss={() => setError("")} />

    <Card><CardHeader><CardTitle>上传审计数据</CardTitle></CardHeader><CardContent>
      <p className="fx-hint">TB 和序时账使用同一入口，可一次拖入两个文件；系统按表格结构自动判定类型、标题行和字段映射。TB 必传，序时账用于还原每月余额波动。</p>
      <FileDropInput containerRef={uploadDropRef}
        value={[tbPath && `TB：${fileName(tbPath)}`, jePath && `序时账：${fileName(jePath)}`].filter(Boolean).join("；")}
        disabled={busy} placeholder="拖放或选择 TB、序时账文件（可同时选择）"
        onBrowse={() => void browse()} onDragStateChange={() => {}}
        onClear={() => { setJePath(""); setTbPath(""); setJe(undefined); setTb(undefined); setJeMapping({}); setTbMapping({}); setRows([]); setResult(undefined); setSourceStatus("") }} />
      {sourceStatus && <p className="fx-source-status" aria-live="polite">{sourceStatus}</p>}
    </CardContent></Card>

    <div className="fx-source-grid">
      {tbPath && <SourceCard title="已识别：TB 科目余额表" hint="年初/年末余额与利息收入勾稽的数据源" path={tbPath} inspection={tb} disabled={busy}
        onClear={() => { setTbPath(""); setTb(undefined); setTbMapping({}) }} onInspect={() => void inspect("tb")}
        onHeaderChange={(row, depth, sheet) => void inspect("tb", {headerRow: row, headerDepth: depth, sheet})} />}
      {jePath && <SourceCard title="已识别：序时账明细" hint="逐月余额波动的数据源；不上传则退回年初/年末两点法" path={jePath} inspection={je} disabled={busy}
        onClear={() => { setJePath(""); setJe(undefined); setJeMapping({}) }} onInspect={() => void inspect("je")}
        onHeaderChange={(row, depth, sheet) => void inspect("je", {headerRow: row, headerDepth: depth, sheet})} />}
    </div>

    <div className="fx-preview-stack">
      {tb && <MappingPreview title="TB 文件预览" kind="tb" inspection={tb} mapping={tbMapping} labels={TB_LABELS}
        missing={depositMissingRequired("tb", tbMapping, Boolean(jePath))} onMappingChange={setTbMapping} />}
      {je && <MappingPreview title="序时账文件预览" kind="je" inspection={je} mapping={jeMapping} labels={JE_LABELS}
        missing={depositMissingRequired("je", jeMapping)} onMappingChange={setJeMapping} />}
    </div>

    {accounts.length > 0 && <Card><CardHeader><CardTitle>科目分类</CardTitle></CardHeader><CardContent>
      <p className="fx-hint">
        已识别计息货币资金科目 <b>{depositAccounts.length}</b> 个、利息收入科目 <b>{interestAccounts.length}</b> 个。
        利息收入科目是测算结果的比较基准，没有它就只能得到测算值、无法勾稽。
      </p>
      <details open={!interestAccounts.length}><summary>逐个核对科目分类</summary>
        <div className="fx-list fx-accounts">{accounts.map((account) =>
          <label key={account}><span title={account}>{account}</span>
            <select value={accountRoles[account] ?? "excluded"} onChange={(e) => setAccountRoles((v) => ({...v, [account]: e.target.value}))}>
              {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>)}
        </div>
      </details>
    </CardContent></Card>}

    <RateTierCard tiers={tiers} custom={tierRates}
      onChange={(key, rate) => setTierRates((current) => {
        const next = {...current};
        if (Number.isFinite(rate)) next[key] = rate; else delete next[key];
        return next;
      })}
      onReset={() => setTierRates({})} />

    <Card><CardHeader><CardTitle>测算与底稿</CardTitle></CardHeader><CardContent>
      <div className="deposit-run-grid">
        <label>资产负债表日<input type="date" value={reportEnd} onChange={(e) => setReportEnd(e.target.value)} /></label>
        <label>计息口径<select value={dayBasis} onChange={(e) => setDayBasis(e.target.value as DayBasis)}>
          {DAY_BASIS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        {jePath && (() => {
          const layout = depositJeLayout(jeMapping);
          const options = depositSignOptions(layout);
          return <label>
            序时账金额记法
            {options.length ? <select value={signOverride} onChange={(e) => setSignOverride(e.target.value as SignChoice)}>
              <option value="auto">自动识别</option>
              {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select> : <input value={layout === "single" ? "单一金额列，必然已带正负号" : "请先映射金额字段"} readOnly />}
            <small className="deposit-layout">当前布局：{JE_LAYOUT_LABEL[layout]}（由你映射的列决定）</small>
          </label>;
        })()}
        <label className="deposit-check"><input type="checkbox" checked={includeCashOnHand} onChange={(e) => setIncludeCashOnHand(e.target.checked)} />库存现金也计息</label>
        <label>输出文件<input value={outputPath} readOnly placeholder="默认保存到源文件目录" /></label>
        <Button variant="secondary" onClick={async () => { const path = await pickPath("save", "保存审计底稿", ["xlsx"], "存款利息收入测算.xlsx"); if (typeof path === "string") setOutputPath(path) }}>选择位置</Button>
      </div>
      <p className="fx-rate-note">
        只有<b>活期</b>自动套用挂牌默认利率——对公活期没有议价空间。协定、通知、定期、大额存单的利率是逐笔合同约定的，
        默认留空，填入实际利率后才计入测算合计。央行基准只作合理性上限参照，不参与测算。
      </p>
      <p className="fx-rate-note">未上传序时账时，月末余额按年初到年末直线推算，月均余额仅供参考，底稿会标注为“两点法推算”。</p>
      <div className="fx-actions">
        <Button variant="secondary" disabled={busy} onClick={() => void run("deposit.preview")}>测算预览</Button>
        <Button disabled={busy} onClick={() => void run("deposit.export")}>生成 Excel 底稿</Button>
      </div>
      {job && <JobProgress job={job} onCancel={busy ? (id) => void jobCancel(id) : undefined} />}
    </CardContent></Card>

    {rows.length > 0 && <Results rows={rows} result={result} tiers={tiers} expanded={expanded}
      onExpand={setExpanded} onOverride={overrideRow} onRecalculate={() => void run("deposit.preview")} busy={busy} />}
  </main>;
}

function RateTierCard({tiers, custom, onChange, onReset}: {
  tiers?: RateTiers; custom: Record<string, number>;
  onChange: (key: string, rate: number) => void; onReset: () => void;
}) {
  const pct = (value: number | null | undefined, fallback = "—") =>
    value == null ? fallback : `${(value * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`;
  if (!tiers) {
    return <Card><CardHeader><CardTitle>存款利率档位</CardTitle></CardHeader><CardContent>
      <p className="fx-hint">利率档位表由本机引擎提供，浏览器预览模式下不可用；在正式应用里会显示完整的档位、来源说明和官方查询入口。</p>
    </CardContent></Card>;
  }
  const changed = Object.keys(custom).length;
  return <Card><CardHeader><CardTitle>存款利率档位</CardTitle></CardHeader><CardContent>
    {tiers.ratesStale && <p className="deposit-stale">
      <b>内置挂牌利率可能已过期</b>
      <span>{tiers.staleMessage}</span>
    </p>}
    <p className="fx-hint">{tiers.autoApplyPolicy}</p>
    <p className="fx-hint">
      在「本次采用」里填一次，就会应用到所有归入该档的账户；单个账户还可以在下方测算结果里单独改，单户改写优先于这里。
    </p>
    <div className="deposit-tier-table"><table>
      <thead><tr>
        <th>大类</th><th>期限</th>
        <th>央行基准<small>{tiers.benchmarkDate} 起 · 仅上限参照</small></th>
        <th>大行挂牌<small>{tiers.listedDate}</small></th>
        <th>实务常见区间</th><th>本次采用（%，可修改）</th><th>实务说明</th>
      </tr></thead>
      <tbody>{tiers.tiers.map((tier) => {
        const applied = depositEffectiveTierRate(tier, custom);
        const overridden = custom[tier.key] !== undefined;
        return <tr key={tier.key} className={applied === undefined ? "deposit-tier-unset" : undefined}>
          <td>{tier.categoryLabel}</td>
          <td>{tier.termLabel || "—"}</td>
          <td>{pct(tier.benchmarkRate, "央行未公布")}</td>
          <td>{pct(tier.listedRate, "按存款协议")}</td>
          <td>{tier.practiceLow == null ? "—" : `${pct(tier.practiceLow)} ~ ${pct(tier.practiceHigh)}`}</td>
          <td><span className="deposit-pct">
            <input type="number" step="0.01" min="0" max="20" className={overridden ? "deposit-tier-changed" : undefined}
              value={depositRateToPercent(applied)} placeholder={tier.autoApply ? "" : "需填"}
              onChange={(e) => onChange(tier.key, depositPercentToRate(e.target.value))} />
            <b>%</b></span></td>
          <td className="deposit-tier-note">{tier.practiceNote}</td>
        </tr>;
      })}</tbody>
    </table></div>
    {changed > 0 && <p className="deposit-tier-actions">
      已改写 {changed} 档默认利率。<button type="button" onClick={onReset}>全部恢复内置默认值</button>
    </p>}
    <ReferenceLinks tiers={tiers} />
    <details className="deposit-tier-source"><summary>利率来源与口径说明</summary>
      <ul>
        <li><b>央行基准</b>：{tiers.benchmarkSource}</li>
        <li><b>大行挂牌</b>：{tiers.listedSource}</li>
        <li><b>实务常见区间</b>：{tiers.practiceSource}</li>
        <li><b>审计依据</b>：{tiers.authority}</li>
      </ul>
    </details>
  </CardContent></Card>;
}

/**
 * 官方利率查询入口。默认只露出首行三个官方渠道，其余收进折叠区，
 * 免得一屏参考链接把利率档位表挤下去。
 * 链接经 Rust 侧白名单校验后交给系统浏览器打开——前端不能用这条命令
 * 访问任意地址，与本地文件走 AllowedPaths 是同一套约束。
 */
function ReferenceLinks({tiers}: {tiers: RateTiers}) {
  const [failed, setFailed] = useState("");
  const [copied, setCopied] = useState("");
  async function open(link: ReferenceLink) {
    setFailed(""); setCopied("");
    try {
      await openReferenceUrl(link.url);
    } catch {
      // 打不开浏览器时至少把网址送到剪贴板，别让用户卡在这里。
      try {
        await navigator.clipboard.writeText(link.url);
        setCopied(link.url);
      } catch {
        setFailed(link.url);
      }
    }
  }
  const button = (link: ReferenceLink) =>
    <button type="button" key={link.url} onClick={() => void open(link)}
      title={`${link.hint}（在系统浏览器中打开 ${link.url}）`}>
      {link.label}<span aria-hidden="true">↗</span>
    </button>;

  const [primary, ...rest] = tiers.linkGroups;
  const primaryLinks = tiers.links.filter((link) => link.group === primary?.key);
  const restGroups = rest
    .map((group) => ({group, items: tiers.links.filter((link) => link.group === group.key)}))
    .filter((entry) => entry.items.length > 0);

  return <section className="deposit-links" aria-labelledby="deposit-links-title">
    <div className="deposit-link-row">
      <h4 id="deposit-links-title">官方利率查询入口</h4>
      {primaryLinks.map(button)}
    </div>
    {restGroups.map(({group, items}) =>
      <details className="deposit-link-more" key={group.key}>
        <summary>{group.label}（{items.length} 家）</summary>
        <p className="deposit-link-group-head"><span>{group.hint}</span></p>
        <ul>{items.map((link) =>
          <li key={link.url}>
            {button(link)}
            <span className="deposit-link-hint">{link.hint}</span>
            <code>{link.url}</code>
          </li>)}
        </ul>
      </details>)}
    {copied && <p className="deposit-link-note" aria-live="polite">无法直接打开浏览器，已把网址复制到剪贴板：{copied}</p>}
    {failed && <p className="deposit-link-note" aria-live="polite">无法打开浏览器，请手工复制网址：{failed}</p>}
  </section>;
}

function SourceCard(props: {title: string; hint: string; path: string; inspection?: Inspection; disabled: boolean; onClear: () => void; onInspect: () => void; onHeaderChange: (row: number, depth: number, sheet: string) => void}) {
  return <Card><CardHeader><CardTitle>{props.title}</CardTitle></CardHeader><CardContent>
    <p className="fx-hint">{props.hint}</p>
    <div className="fx-detected-file"><span title={props.path}>{props.path}</span>
      <button type="button" disabled={props.disabled} onClick={props.onClear}>移除</button></div>
    {props.path && !props.inspection && <Button variant="secondary" disabled={props.disabled} onClick={props.onInspect}>自动识别表头和字段</Button>}
    {props.inspection && <div className="fx-source-meta">
      <span>{props.inspection.rowCount.toLocaleString()} 行</span>
      <label>Sheet<select value={props.inspection.sheet} onChange={(e) => props.onHeaderChange(0, 0, e.target.value)}>
        {props.inspection.sheets.length ? props.inspection.sheets.map((s) => <option key={s}>{s}</option>) : <option>{props.inspection.sheet}</option>}
      </select></label>
      <label>标题行<input type="number" min={1} value={props.inspection.headerRow}
        onChange={(e) => props.onHeaderChange(Number(e.target.value), props.inspection!.headerDepth, props.inspection!.sheet)} /></label>
      <label>表头层数<select value={props.inspection.headerDepth}
        onChange={(e) => props.onHeaderChange(props.inspection!.headerRow, Number(e.target.value), props.inspection!.sheet)}>
        <option value={1}>1层</option><option value={2}>2层</option></select></label>
      {props.inspection.headerDetection.needsConfirmation && <strong className="fx-warning">标题候选得分接近，请确认标题行</strong>}
    </div>}
  </CardContent></Card>;
}

function MappingPreview(props: {title: string; kind: "je" | "tb"; inspection: Inspection; mapping: Record<string, string | string[]>; labels: Record<string, string>; missing: string[]; onMappingChange: React.Dispatch<React.SetStateAction<Record<string, string | string[]>>>}) {
  // 存款利息此前没有任何 LLM 复核——不是不需要，是没人给它接。
  const [review, setReview] = useState("");
  const [reviewing, setReviewing] = useState(false);
  async function runReview() {
    setReviewing(true);
    setReview("正在复核字段映射…");
    try {
      const {mapping, applied} = await applyLedgerReviewToDict(
        engineCall, props.kind, props.inspection.headers, props.inspection.preview, props.mapping, props.labels,
      );
      props.onMappingChange(mapping as Record<string, string | string[]>);
      setReview(applied.length ? `复核完成，已应用 ${applied.length} 项建议。` : "复核完成，当前映射无需调整。");
    } catch (e) {
      setReview(`${errorText(e)} 可继续手工映射。`);
    } finally {
      setReviewing(false);
    }
  }
  return <>
    <MappingPanel
      title={props.title}
      note={`${props.inspection.rowCount} 行 × ${props.inspection.headers.length} 列`}
      headers={props.inspection.headers}
      rows={props.inspection.preview}
      mapping={props.mapping}
      roles={Object.entries(props.labels)}
      multi={DEPOSIT_MULTI}
      missing={props.missing}
      busy={reviewing}
      toolbar={<Button variant="secondary" size="sm" disabled={reviewing} onClick={() => void runReview()}>
        {reviewing ? "复核中…" : "LLM 复核映射"}
      </Button>}
      onChange={(next) => props.onMappingChange(next as Record<string, string | string[]>)}
    />
    {review && <p className="fx-hint">{review}</p>}
  </>;
}

function Results({rows, result, tiers, expanded, onExpand, onOverride, onRecalculate, busy}: {
  rows: AccountRow[]; result?: Record<string, unknown>; tiers?: RateTiers; expanded: string;
  onExpand: (key: string) => void; onOverride: (key: string, next: {tier?: string; annualRate?: number}) => void;
  onRecalculate: () => void; busy: boolean;
}) {
  const summary = (result?.summary ?? {}) as Record<string, unknown>;
  const outputs = (result?.outputPaths ?? []) as string[];
  const amount = (value: unknown) => new Intl.NumberFormat("zh-CN", {minimumFractionDigits: 2, maximumFractionDigits: 2}).format(Number(value ?? 0));
  const percent = (value: unknown) => value == null ? "无法计算" : new Intl.NumberFormat("zh-CN", {style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2}).format(Number(value));
  const booked = summary.hasInterestIncomeAccount === true;
  const metric = (label: string, value: unknown, detail?: string, tone = "") =>
    <div className={`fx-bridge-metric ${tone}`.trim()}><span>{label}</span>
      <strong>{typeof value === "string" ? value : amount(value)}</strong>{detail && <small>{detail}</small>}</div>;
  // 用户在表里改利率后立刻按同一条公式重算行内金额；上方与 TB 的比较仍是
  // 服务端结果，两者对不上时提示重算，避免同屏出现两个口径的合计。
  const rowInterest = (row: AccountRow) =>
    row.rateResolved
      ? row.months.reduce((sum, month) => sum + depositMonthlyInterest(month.average, row.annualRate, month.days, month.denominator), 0)
      : 0;
  const liveTotal = rows.filter((row) => row.rateResolved).reduce((sum, row) => sum + rowInterest(row), 0);
  const missing = rows.filter((row) => !row.rateResolved);
  const stale = Math.abs(liveTotal - Number(summary.calculatedInterest ?? 0)) > 0.005;

  return <section className="fx-result deposit-result">
    <div className="fx-result-heading">
      <div><h3>存款利息测算结果</h3>
        <p>
          月均余额＝（月初余额＋月末余额）÷2；月度余额来源：{String(summary.monthlySource ?? "—")}；
          期初余额来源：{String(summary.openingSource ?? "—")}；测算月份：{String(summary.monthCount ?? "—")} 个月；
          计息口径：{String(summary.dayBasisLabel ?? "—")}。
        </p>
        {Boolean(summary.amountScheme) && <p className="deposit-scheme" title={String(summary.amountEvidence ?? "")}>
          序时账金额口径：<b>{String(summary.amountScheme)}</b>
          <span>{String(summary.amountEvidence ?? "")}</span>
        </p>}
        </div>
      {outputs.map((path) => <Button key={path} variant="secondary" onClick={() => void openOutput(path)}>打开 Excel 底稿</Button>)}
    </div>

    {missing.length > 0 && <p className="deposit-stale">
      <b>{missing.length} 个账户尚未确定利率，测算尚不完整</b>
      <span>
        涉及 {[...new Set(missing.map((row) => row.tierLabel))].join("、")}，月均余额合计 {amount(missing.reduce((sum, row) => sum + row.averageBalance, 0))}。
        这些档位的利率是逐笔合同约定的，请按存款协议、银行对账单或利息清单填入实际利率——填之前它们的利息不计入下方合计和与 TB 的比较。
      </span>
    </p>}
    {stale && <p className="fa-missing-hint">已修改利率，下方逐户金额已按新利率更新；与 TB 的比较仍是上一次测算的结果，点“按新利率重算”后同步。</p>}
    <div className="fx-bridge-step comparison"><div className="fx-step-label"><b>1</b><span>与 TB 比较</span></div>
      <div className="fx-bridge-equation">
        {metric("审计测算存款利息", summary.calculatedInterest)}
        <span className="fx-operator compare" aria-hidden="true">对比</span>
        {metric("TB 账面利息收入", booked ? summary.bookedInterestIncome : "未识别")}
        <span className="fx-operator" aria-hidden="true">＝</span>
        {metric("差异", booked ? summary.difference : "无法比较",
          !booked ? "TB 中未识别到利息收入科目"
            : missing.length ? `差异率 ${percent(summary.differenceRatio)}；尚有 ${missing.length} 户未定利率`
            : `差异率 ${percent(summary.differenceRatio)}`,
          booked && summary.reconciliationPassed === true ? "pass" : "warning")}
      </div>
    </div>

    <div className="deposit-rate-head">
      <div><h4>逐户利率与利息测算</h4>
        <p>{String(summary.rateBasisLabel ?? "—")}改成存款协议或对账单上的实际利率后，点“按新利率重算”。</p></div>
      <Button variant="secondary" disabled={busy} onClick={onRecalculate}>按新利率重算</Button>
    </div>
    <div className="deposit-table"><table>
      <thead><tr>
        <th>核算主体</th><th>科目</th><th>辅助核算</th><th>存款档位（大类／期限）</th><th>年利率（%）</th><th>利率来源</th>
        <th>年初余额</th><th>年末余额(TB)</th><th>年末余额(还原)</th><th>勾稽差异</th><th>月均余额</th><th>测算利息</th><th>状态</th><th>月度</th>
      </tr></thead>
      <tbody>{rows.map((row) => <Fragment key={row.key}>
        <tr className={row.status === "已勾稽" ? "" : "deposit-review-row"}>
          <td>{row.entity}</td><td title={row.account}>{row.account}</td><td>{row.auxiliary}</td>
          <td title={row.tierMatchedBy}><div className="deposit-tier-picker">
            <select value={row.category} onChange={(e) => onOverride(row.key, {tier: depositFirstTierOf(tiers, e.target.value)})}>
              {(tiers?.categories ?? []).map((category) => <option key={category.key} value={category.key}>{category.label}</option>)}
            </select>
            {depositTermsOf(tiers, row.category).length > 0 &&
              <select value={row.tier} onChange={(e) => onOverride(row.key, {tier: e.target.value})}>
                {depositTermsOf(tiers, row.category).map((term) => <option key={term.key} value={term.key}>{term.label}</option>)}
              </select>}
          </div></td>
          <td><span className="deposit-pct">
            <input type="number" step="0.01" min="0" max="20"
              className={!row.rateResolved ? "deposit-rate-missing" : undefined}
              value={row.rateResolved ? depositRateToPercent(row.annualRate) : ""} placeholder="需填"
              onChange={(e) => onOverride(row.key, {annualRate: depositPercentToRate(e.target.value)})} />
            <b>%</b></span></td>
          <td title={row.rateWarning}>{row.rateWarning ? `${row.rateSource}（高于央行基准）` : row.rateSource}</td>
          <td>{amount(row.openingBalance)}</td><td>{amount(row.tbClosingBalance)}</td>
          <td>{amount(row.derivedClosingBalance)}</td><td>{amount(row.reconciliationDiff)}</td>
          <td>{amount(row.averageBalance)}</td><td>{amount(rowInterest(row))}</td>
          <td title={row.note}><span className={row.status === "已勾稽" ? "deposit-ok" : row.status === "待填利率" ? "deposit-missing" : "deposit-warn"}>{row.status}</span></td>
          <td><button type="button" className="deposit-expand" onClick={() => onExpand(expanded === row.key ? "" : row.key)}>
            {expanded === row.key ? "收起" : "展开"}</button></td>
        </tr>
        {expanded === row.key && <tr className="deposit-month-row"><td colSpan={14}>
          <table className="deposit-month-table">
            <thead><tr><th>月份</th><th>月初余额</th><th>本月借方</th><th>本月贷方</th><th>月末余额</th><th>月均余额</th><th>当月利息</th></tr></thead>
            <tbody>{row.months.map((month) => <tr key={month.month}>
              <td>{month.month}月</td><td>{amount(month.opening)}</td><td>{amount(month.debit)}</td>
              <td>{amount(month.credit)}</td><td>{amount(month.closing)}</td>
              <td>{amount(depositMonthlyAverage(month.opening, month.closing))}</td>
              <td>{amount(depositMonthlyInterest(month.average, row.annualRate, month.days, month.denominator))}</td>
            </tr>)}</tbody>
          </table>
        </td></tr>}
      </Fragment>)}</tbody>
    </table></div>
    <p className="fx-rate-note">
      导出的 Excel 里，「测算汇总」的黄色“年利率”单元格可以直接改写：月度利息、测算利息合计和与 TB 的勾稽差异都是活公式，改完即时重算，不必回到工具里。
    </p>
  </section>;
}

function fileName(path: string) { return path.split(/[\\/]/).pop() ?? path }
function errorText(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return String(v.userMessage ?? v.message ?? v.detail ?? "处理失败，请重试。");
  }
  return "处理失败，请重试。";
}
