import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ToolManifest, JobEvent } from "./types";
import { useTaskRestore } from "./restore";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenPositionedFileDrops,
  listenJobEvents,
  openOutput,
  openReferenceUrl,
  pickPath,
} from "./api";
import { PageHeader } from "@/components/PageHeader";
import { errorText } from "@/lib/errors";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StepIndicator } from "@/components/StepIndicator";
import { JargonTip } from "@/components/JargonTip";
import { DataHandlingNotice } from "@/components/DataHandlingNotice";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { NumberInput } from "@/components/NumberInput";
import {
  correctLedgerSourceKinds,
  missingGoldIdentity,
  resolveRoleLabels,
  scanLedgerUploadSources,
  selectLedgerSourcePair,
  type EngineRoleLabels,
  type LedgerWorkbookSheetClassification,
} from "@/ledgerMapping";
import { MappingPanel } from "@/components/MappingPanel";
import { BusySpinner } from "@/components/BusySpinner";
import {
  describeForm,
  formGroups,
  resolveForm,
  roleRequirement,
  useLedgerForms,
} from "@/ledgerForms";
import {
  LedgerReviewAll,
  useLedgerDictReviews,
} from "@/components/LedgerReviewAll";
import {
  KeywordFilter,
  keywordFilterPredicate,
} from "@/components/KeywordFilter";

/** 可多列的角色与统一内核一致；`account` 是历史保存映射的旧槽位。 */
const DEPOSIT_MULTI = new Set(["id", "accountName", "auxiliary", "account"]);
import "./fx-audit.css";
import "./deposit-interest.css";

type Kind = "je" | "tb";
export type Inspection = {
  headers: string[];
  sheet: string;
  sheets: string[];
  headerRow: number;
  headerDepth: number;
  rowCount: number;
  preview: string[][];
  entities: string[];
  accounts: string[];
  suggestedMapping: Record<string, string | string[]>;
  /** 引擎随识别结果全量下发的角色标签（`{name,label}`）；缺失时回落本页的标签表。 */
  roles?: EngineRoleLabels;
  suggestedAccountRoles: Record<string, string>;
  suggestedAccountTiers?: Record<string, string>;
  mappingCandidates: Array<{
    role: string;
    candidates: Array<{
      column: string;
      confidence: number;
      conflictTerms: string[];
    }>;
  }>;
  headerDetection: {
    needsConfirmation: boolean;
    candidates: Array<{ row: number; score: number }>;
  };
  dataYears: number[];
  suggestedBalanceSheetDate?: string;
};
type SourceClassification = LedgerWorkbookSheetClassification;
type RateTier = {
  key: string;
  category: string;
  categoryLabel: string;
  termLabel: string;
  label: string;
  benchmarkRate: number | null;
  listedRate: number | null;
  autoApply: boolean;
  practiceLow: number | null;
  practiceHigh: number | null;
  practiceNote: string;
};
type RateCategory = {
  key: string;
  label: string;
  terms: Array<{ key: string; label: string }>;
};
type ReferenceLink = {
  label: string;
  url: string;
  hint: string;
  group: string;
};
type ReferenceGroup = { key: string; label: string; hint: string };
type RateTiers = {
  benchmarkDate: string;
  listedDate: string;
  benchmarkSource: string;
  listedSource: string;
  practiceSource: string;
  authority: string;
  autoApplyPolicy: string;
  links: ReferenceLink[];
  linkGroups: ReferenceGroup[];
  listedRateDate: string;
  rateAgeMonths: number;
  ratesStale: boolean;
  staleMessage: string;
  categories: RateCategory[];
  tiers: RateTier[];
};
type MonthCell = {
  month: number;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
  average: number;
  days: number;
  denominator: number;
  interest: number;
};
type AccountRow = {
  key: string;
  entity: string;
  account: string;
  auxiliary: string;
  currency: string;
  role: string;
  tier: string;
  tierLabel: string;
  category: string;
  termLabel: string;
  tierMatchedBy: string;
  rateSource: string;
  annualRate: number;
  rateResolved: boolean;
  rateWarning: string;
  openingBalance: number;
  tbClosingBalance: number;
  derivedClosingBalance: number;
  reconciliationDiff: number;
  averageBalance: number;
  calculatedInterest: number;
  months: MonthCell[];
  status: string;
  note: string;
};

// 角色名与 Rust 侧的统一映射内核（ledger_mapping.rs）一一对应，五个工具共用。
export const JE_LABELS: Record<string, string> = {
  date: "记账日期",
  id: "凭证号",
  voucherType: "凭证类型",
  entity: "公司/核算主体",
  accountCode: "科目编码",
  accountName: "科目名称",
  auxiliary: "辅助核算/银行账户",
  summary: "摘要",
  currency: "币种",
  functionalDebit: "借方金额",
  functionalCredit: "贷方金额",
  functionalAmount: "本位币有符号金额",
  direction: "借贷方向",
};
export const TB_LABELS: Record<string, string> = {
  entity: "公司/核算主体",
  accountCode: "科目编码",
  accountName: "科目名称",
  auxiliary: "辅助核算/银行账户",
  currency: "币种",
  period: "会计期间（选填）",
  openingDirection: "期初方向",
  closingDirection: "期末方向",
  openingFunctionalAmount: "年初余额（净额）",
  openingFunctionalDebit: "年初余额借方",
  openingFunctionalCredit: "年初余额贷方",
  closingFunctionalAmount: "期末余额（净额）",
  closingFunctionalDebit: "期末余额借方",
  closingFunctionalCredit: "期末余额贷方",
  ytdFunctionalDebit: "本年累计借方发生额",
  ytdFunctionalCredit: "本年累计贷方发生额",
  periodFunctionalDebit: "本期借方发生额",
  periodFunctionalCredit: "本期贷方发生额",
};
const ROLE_OPTIONS: Array<[string, string]> = [
  ["deposit", "银行存款（计息）"],
  ["other_monetary", "其他货币资金（计息）"],
  ["cash_on_hand", "库存现金（默认不计息）"],
  ["interest_income", "利息收入（勾稽基准）"],
  ["excluded", "不参与测算"],
];

/** 提科目编码：与引擎同口径——首 token 是足位数数字串才算编码，
 *  用来把 TB 的「编码＋名称」与 JE 的「名称＋编码」两种拼法归并成一条。 */
export function depositAccountCode(account: string): string {
  const token = account.split(/\s+/).find((t) => {
    const digits = (t.match(/\d/g) ?? []).length;
    return digits >= 3 && digits * 2 >= t.length && /^\d/.test(t);
  });
  return token ?? account.trim();
}

/** 科目分类清单：TB 与 JE 的同一科目按编码去重（TB 拼法优先保留），
 *  排序把已映射为计息科目/利息收入的排在前面，excluded 沉底——
 *  用户要核对的正是参与测算的那批科目。 */
export function mergeAccountList(
  tbAccounts: string[],
  jeAccounts: string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const account of [...tbAccounts, ...jeAccounts]) {
    const code = depositAccountCode(account);
    if (seen.has(code)) continue;
    seen.add(code);
    merged.push(account);
  }
  return merged;
}

/** 上传的 TB 至少要能取出年初和年末余额；序时账只在提供时才校验。 */
/**
 * 有序时账时年初余额不是必填——SAP 的 Trial Balance LC/GC 只出 MTD/YTD，
 * 根本没有年初余额列，这时由"期末余额 − 期间内发生额"倒推。
 */
export function depositMissingRequired(
  kind: Kind,
  mapping: Record<string, string | string[]>,
  hasJe = false,
): string[] {
  const has = (role: string) => {
    const value = mapping[role];
    return Array.isArray(value)
      ? value.some((item) => item.trim())
      : Boolean(String(value ?? "").trim());
  };
  // 金标身份槽在前，本工具自己的必填在后，两者取并集。
  // 历史保存的映射把科目编码与名称混在一个 account 里，判定时一并认。
  const missing: string[] = missingGoldIdentity(
    kind === "tb" ? "tb" : "je",
    (role) =>
      role === "accountCode" || role === "accountName"
        ? has(role) || has("account")
        : has(role),
  );
  if (kind === "tb") {
    if (!(
      has("closingFunctionalAmount") ||
      has("closingFunctionalDebit") ||
      has("closingFunctionalCredit")
    ))
      missing.push("期末余额方案");
    if (
      !hasJe &&
      !(
        has("openingFunctionalAmount") ||
        has("openingFunctionalDebit") ||
        has("openingFunctionalCredit")
      )
    )
      missing.push("期初余额方案（或上传序时账）");
  } else {
    // 序时账一律走记账日期：会计期间只在科目余额表上有用，
    // 旧版把两者当成二选一放行，后端却硬性要求日期列。
    if (!(
      has("functionalAmount") ||
      has("functionalDebit") ||
      has("functionalCredit")
    ))
      missing.push("发生额方案");
  }
  // 金标身份槽与本工具声明可能指向同一角色（记账日期、科目编码），只报一次。
  return [...new Set(missing)];
}

/**
 * 序时账的金额布局。这一维不是用户选的——映射了哪几列就定了哪种布局；
 * "符号记法"也不再让用户选，后端按凭证配平等数据形态自动判定，
 * 判定结论与依据都会写进测算结果。
 */
export type JeLayout = "split" | "directed" | "single" | "none";
export function depositJeLayout(
  mapping: Record<string, string | string[]>,
): JeLayout {
  const has = (role: string) => {
    const value = mapping[role];
    return Array.isArray(value)
      ? value.some((item) => item.trim())
      : Boolean(String(value ?? "").trim());
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
  return /^\d{4}-\d{2}-\d{2}$/.test(balanceSheetDate)
    ? `${balanceSheetDate.slice(0, 4)}-01-01`
    : "";
}
export function depositDropTargetInside(
  x: number,
  y: number,
  rect?: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
) {
  return Boolean(
    rect &&
    x >= rect.left &&
    x <= rect.right &&
    y >= rect.top &&
    y <= rect.bottom,
  );
}
/** 月均余额口径：（月初＋月末）÷2，与导出 Excel 里的公式保持同一条式子。 */
export function depositMonthlyAverage(opening: number, closing: number) {
  return (Number(opening) + Number(closing)) / 2;
}
/** 月度利息 = 月均余额 × 年利率 × 计息天数 ÷ 年基数；month12 口径下天数=1、基数=12。 */
export function depositMonthlyInterest(
  average: number,
  annualRate: number,
  days: number,
  denominator: number,
) {
  return denominator === 0
    ? 0
    : (Number(average) * Number(annualRate) * Number(days)) /
        Number(denominator);
}
/** 自动套用的默认利率：只有活期有。其余档位必须由用户填实际利率。 */
export function depositAutoRate(tier: RateTier | undefined) {
  return tier?.autoApply ? (tier.listedRate ?? undefined) : undefined;
}
/** 档位实际采用的利率：用户改写过就用改写值，否则只有活期有内置默认值。 */
export function depositEffectiveTierRate(
  tier: RateTier | undefined,
  custom: Record<string, number>,
) {
  if (!tier) return undefined;
  const overridden = custom[tier.key];
  return Number.isFinite(overridden) ? overridden : depositAutoRate(tier);
}
/** 央行基准只作上限参照：填入的利率高于基准时提示确认，绝不参与测算。 */
export function depositRateAboveBenchmark(
  tier: RateTier | undefined,
  rate: number,
) {
  if (!tier || tier.benchmarkRate == null || !Number.isFinite(rate))
    return false;
  return rate > tier.benchmarkRate;
}
/** 只有存在有名称的期限时才需要第二级下拉（活期、协定、自定义没有期限）。 */
export function depositTermsOf(tiers: RateTiers | undefined, category: string) {
  return (
    tiers?.categories.find((item) => item.key === category)?.terms ?? []
  ).filter((term) => term.label);
}
/** 切换大类时落到该大类的第一个期限，避免出现"大类变了但档位没变"。 */
export function depositFirstTierOf(
  tiers: RateTiers | undefined,
  category: string,
) {
  return (
    tiers?.categories.find((item) => item.key === category)?.terms[0]?.key ??
    category
  );
}
export function depositRateOutOfPractice(
  tier: RateTier | undefined,
  rate: number,
) {
  if (
    !tier ||
    tier.practiceLow == null ||
    tier.practiceHigh == null ||
    !Number.isFinite(rate)
  )
    return false;
  return rate < tier.practiceLow || rate > tier.practiceHigh;
}

function HelpTip({ text }: { text: string }) {
  return (
    <span className="deposit-help" title={text} aria-label={text} tabIndex={0}>
      ⓘ
    </span>
  );
}

export function DepositInterestPage({ tool }: { tool: ToolManifest }) {
  const [jePath, setJePath] = useState("");
  const [tbPath, setTbPath] = useState("");
  const [je, setJe] = useState<Inspection>();
  const [tb, setTb] = useState<Inspection>();
  const [jeMapping, setJeMapping] = useState<Record<string, string | string[]>>(
    {},
  );
  const [tbMapping, setTbMapping] = useState<Record<string, string | string[]>>(
    {},
  );
  const [accountRoles, setAccountRoles] = useState<Record<string, string>>({});
  const [accountRoleOverrides, setAccountRoleOverrides] = useState<
    Record<string, string>
  >({});
  const [accountTierOverrides, setAccountTierOverrides] = useState<
    Record<string, string>
  >({});
  const [accountFilter, setAccountFilter] = useState("");
  const [reportEnd, setReportEnd] = useState("");
  const [tiers, setTiers] = useState<RateTiers>();
  const [tierRates, setTierRates] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [rateOverrides, setRateOverrides] = useState<
    Record<string, { tier?: string; annualRate?: number }>
  >({});
  const [expanded, setExpanded] = useState("");
  const [result, setResult] = useState<Record<string, unknown>>();
  const [outputPath, setOutputPath] = useState("");
  const [sourceStatus, setSourceStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // 三步导引，与汇兑损益／FA 一致：上传识别 → 科目分类 → 测算与底稿。
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [job, setJob] = useState<JobEvent>();
  const activeJob = useRef("");
  const uploadDropRef = useRef<HTMLDivElement>(null);
  // 一键复核 TB＋JE：引擎与汇兑损益共用同一份（见 components/LedgerReviewAll）。
  const reviews = useLedgerDictReviews(engineCall, {
    tb: JSON.stringify([tbPath, tb?.sheet, tb?.headerRow, tb?.headerDepth]),
    je: JSON.stringify([jePath, je?.sheet, je?.headerRow, je?.headerDepth]),
  });
  const reviewingAny = reviews.reviewing.tb || reviews.reviewing.je;

  const accounts = useMemo(
    () => mergeAccountList(tb?.accounts ?? [], je?.accounts ?? []),
    [je, tb],
  );
  const depositAccounts = accounts.filter((a) =>
    ["deposit", "other_monetary", "cash_on_hand"].includes(
      accountRoles[a] ?? "",
    ),
  );
  const interestAccounts = accounts.filter(
    (a) => (accountRoles[a] ?? "") === "interest_income",
  );
  // 科目分类清单的关键词筛选：只影响展示，不改变上方的分类计数和测算口径。
  const accountMatches = useMemo(
    () => keywordFilterPredicate(accountFilter),
    [accountFilter],
  );
  // 已映射为计息科目/利息收入的排前面，excluded 与未分类沉底；
  // 排序稳定，同组内保持账表原顺序。
  const activeAccount = (account: string) => {
    const role = accountRoles[account] ?? "";
    return role !== "" && role !== "excluded";
  };
  const visibleAccounts = accounts
    .filter((account) => accountMatches(account))
    .sort((a, b) => Number(activeAccount(b)) - Number(activeAccount(a)));

  useEffect(() => {
    void engineCall("deposit.rate_tiers", {})
      .then((x) => setTiers(x as RateTiers))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    setAccountRoles(
      Object.fromEntries(
        accounts.map((account) => {
          const suggested =
            tb?.suggestedAccountRoles?.[account] ??
            je?.suggestedAccountRoles?.[account] ??
            "excluded";
          return [account, accountRoleOverrides[account] ?? suggested];
        }),
      ),
    );
  }, [accounts, je, tb, accountRoleOverrides]);

  // 历史记录「继续任务」：回填两表路径/基准日/映射与分层利率、逐户改价。
  // Sheet 等识别信息以存档参数重建最小 Inspection，不点「重新识别」也能直接
  // 测算；存档的最终科目分类整体写入 overrides，预填 effect 会原样采纳。
  // restoredDepositRef：用户重新识别同一文件时，applyInspection 默认套用
  // 建议映射并清空分类覆盖——这里把存档值顶回，逐侧一次性消费。
  const restoredDepositRef = useRef<{
    sides: {
      je?: { path: string; mapping: Record<string, string | string[]> };
      tb?: { path: string; mapping: Record<string, string | string[]> };
    };
    accountRoleOverrides?: Record<string, string>;
  } | null>(null);
  useTaskRestore(tool.id, (restore) => {
    type DepositSourceParams = {
      inputPath?: string;
      sheet?: string;
      headerRow?: number;
      headerDepth?: number;
    };
    const p = restore.params as {
      reportEnd?: string;
      tbSource?: DepositSourceParams;
      jeSource?: DepositSourceParams;
      tbMapping?: Record<string, string | string[]>;
      jeMapping?: Record<string, string | string[]>;
      accountRoles?: Record<string, string>;
      accountTierOverrides?: Record<string, string>;
      rateOverrides?: Record<string, { tier?: string; annualRate?: number }>;
      tierRates?: Record<string, number>;
      outputPath?: string;
    };
    const restoredJePath =
      typeof p.jeSource?.inputPath === "string" ? p.jeSource.inputPath : "";
    const restoredTbPath =
      typeof p.tbSource?.inputPath === "string" ? p.tbSource.inputPath : "";
    if (!restoredJePath && !restoredTbPath) return;
    const accountList = [
      ...new Set([
        ...Object.keys(p.accountRoles ?? {}),
        ...Object.keys(p.accountTierOverrides ?? {}),
        ...Object.keys(p.rateOverrides ?? {}),
      ]),
    ];
    const minimalInspection = (src: DepositSourceParams): Inspection =>
      ({
        sheet: src.sheet ?? "",
        headerRow: src.headerRow ?? 0,
        headerDepth: src.headerDepth ?? 0,
        accounts: accountList,
      }) as Inspection;
    const isMapping = (value: unknown): value is Record<string, string | string[]> =>
      Boolean(value && typeof value === "object");
    restoredDepositRef.current = {
      sides: {
        ...(restoredJePath && isMapping(p.jeMapping)
          ? { je: { path: restoredJePath, mapping: p.jeMapping } }
          : {}),
        ...(restoredTbPath && isMapping(p.tbMapping)
          ? { tb: { path: restoredTbPath, mapping: p.tbMapping } }
          : {}),
      },
      ...(isMapping(p.accountRoles)
        ? { accountRoleOverrides: p.accountRoles }
        : {}),
    };
    setJePath(restoredJePath);
    setTbPath(restoredTbPath);
    setJe(restoredJePath ? minimalInspection(p.jeSource!) : undefined);
    setTb(restoredTbPath ? minimalInspection(p.tbSource!) : undefined);
    if (typeof p.reportEnd === "string" && p.reportEnd)
      setReportEnd(p.reportEnd);
    setJeMapping(
      p.jeMapping && typeof p.jeMapping === "object" ? p.jeMapping : {},
    );
    setTbMapping(
      p.tbMapping && typeof p.tbMapping === "object" ? p.tbMapping : {},
    );
    setAccountRoleOverrides(
      p.accountRoles && typeof p.accountRoles === "object"
        ? p.accountRoles
        : {},
    );
    setAccountTierOverrides(
      p.accountTierOverrides && typeof p.accountTierOverrides === "object"
        ? p.accountTierOverrides
        : {},
    );
    setRateOverrides(
      p.rateOverrides && typeof p.rateOverrides === "object"
        ? p.rateOverrides
        : {},
    );
    if (p.tierRates && typeof p.tierRates === "object")
      setTierRates(p.tierRates);
    setOutputPath(typeof p.outputPath === "string" ? p.outputPath : "");
    setStep(2);
    setBusy(false);
    setError("");
    setResult(undefined);
    setRows([]);
    setJob(undefined);
  });
  useEffect(() => {
    const drops = listenPositionedFileDrops(({ paths, x, y }) => {
      if (
        !depositDropTargetInside(
          x,
          y,
          uploadDropRef.current?.getBoundingClientRect(),
        )
      )
        return;
      void classifyAndInspect(paths);
    });
    const jobs = listenJobEvents((event) => {
      if (event.jobId !== activeJob.current) return;
      setJob(event);
      if (event.phase === "completed") {
        setBusy(false);
        const next = event.result as Record<string, unknown>;
        setResult((current) => ({ ...current, ...next }));
        setRows((next.rows ?? []) as AccountRow[]);
      } else if (event.phase === "failed" || event.phase === "cancelled") {
        setBusy(false);
        const payload = event.result as
          { error?: { userMessage?: string } } | undefined;
        setError(payload?.error ? errorText(payload.error) : event.message);
      }
    });
    return () => {
      void drops.then((x) => x());
      void jobs.then((x) => x());
    };
  }, []);

  async function browse() {
    const picked = await pickPath("files", "选择 TB 或序时账文件", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
      "tsv",
      "parquet",
    ]);
    if (!picked) return;
    void classifyAndInspect(Array.isArray(picked) ? picked : [picked]);
  }
  async function classifyAndInspect(paths: string[]) {
    const files = paths.filter((p) =>
      /\.(xlsx?|xlsm|csv|txt|tsv|parquet)$/i.test(p),
    );
    if (!files.length) return;
    // 新来源开始识别时，上一批文件产生的复核、测算和手工覆盖全部失效。
    // 利率档位字典属于工具长期配置，保留；逐账户选择属于文件派生状态，清空。
    reviews.clearReview("tb");
    reviews.clearReview("je");
    setJePath("");
    setTbPath("");
    setJe(undefined);
    setTb(undefined);
    setJeMapping({});
    setTbMapping({});
    setAccountRoles({});
    setAccountRoleOverrides({});
    setAccountTierOverrides({});
    setRateOverrides({});
    setRows([]);
    setExpanded("");
    setResult(undefined);
    setJob(undefined);
    setOutputPath("");
    setReportEnd("");
    setStep(0);
    setBusy(true);
    setError("");
    setSourceStatus("正在识别文件…");
    const failures: string[] = [];
    try {
      const scan = await scanLedgerUploadSources<SourceClassification>(
        engineCall,
        files,
        { llmMethod: "deposit.classify_source_llm" },
      );
      failures.push(
        ...scan.failures.map(
          (failure) => `${fileName(failure.path)}：${errorText(failure.error)}`,
        ),
      );
      const selected = selectLedgerSourcePair(scan.sources);
      for (const item of selected) {
        try {
          const response = (await engineCall(`deposit.inspect_${item.kind}`, {
            source: {
              inputPath: item.path,
              sheet: item.classification.sheet,
              headerRow: 0,
              headerDepth: 0,
            },
          })) as Inspection;
          applyInspection(item.kind, item.path, response);
        } catch (e) {
          failures.push(`${fileName(item.path)}：${errorText(e)}`);
        }
      }
      setSourceStatus(
        scan.hiddenSheets
          ? `${selected.length} 个账表来源已识别；${scan.hiddenSheets} 张低置信度 Sheet 已忽略。`
          : "",
      );
      if (failures.length) setError(failures.join("；"));
    } finally {
      setBusy(false);
    }
  }
  function applyInspection(kind: Kind, path: string, response: Inspection) {
    // 历史恢复后重新识别同一文件：用存档映射与科目分类顶回建议值，
    // 逐侧一次性消费；换文件照旧用建议值。
    const stash = restoredDepositRef.current;
    const side = stash?.sides[kind];
    const samePath = (a: string, b: string) =>
      a.trim().toLowerCase() === b.trim().toLowerCase();
    const match = side && samePath(side.path, path) ? side : undefined;
    if (match && stash) {
      delete stash.sides[kind];
      if (!stash.sides.je && !stash.sides.tb) restoredDepositRef.current = null;
    }
    setAccountRoleOverrides(
      match ? (stash?.accountRoleOverrides ?? {}) : {},
    );
    if (response.suggestedBalanceSheetDate)
      setReportEnd(response.suggestedBalanceSheetDate);
    else if (response.dataYears?.length === 1)
      setReportEnd(`${response.dataYears[0]}-12-31`);
    if (kind === "je") {
      setJePath(path);
      setJe(response);
      setJeMapping(match ? match.mapping : (response.suggestedMapping ?? {}));
    } else {
      setTbPath(path);
      setTb(response);
      setTbMapping(match ? match.mapping : (response.suggestedMapping ?? {}));
    }
    reviews.clearReview(kind);
    setRows([]);
    setResult(undefined);
  }
  async function inspect(
    kind: Kind,
    over?: Partial<{ sheet: string; headerRow: number; headerDepth: number }>,
  ) {
    reviews.clearReview(kind);
    setBusy(true);
    setError("");
    try {
      const current = kind === "je" ? je : tb;
      const response = (await engineCall(`deposit.inspect_${kind}`, {
        source: {
          inputPath: kind === "je" ? jePath : tbPath,
          sheet: over?.sheet ?? current?.sheet ?? "",
          headerRow: over?.headerRow ?? current?.headerRow ?? 0,
          headerDepth: over?.headerDepth ?? current?.headerDepth ?? 0,
        },
      })) as Inspection;
      applyInspection(kind, kind === "je" ? jePath : tbPath, response);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function changeSourceKind(from: Kind, to: Kind) {
    const path = from === "je" ? jePath : tbPath;
    const current = from === "je" ? je : tb;
    const occupiedPath = to === "je" ? jePath : tbPath;
    const occupied = to === "je" ? je : tb;
    if (!path || !current) return;
    setBusy(true);
    setError("");
    try {
      const changed = await correctLedgerSourceKinds(
        from,
        to,
        { path, inspection: current },
        occupiedPath && occupied
          ? { path: occupiedPath, inspection: occupied }
          : undefined,
        async (kind, source) =>
          (await engineCall(`deposit.inspect_${kind}`, {
            source: {
              inputPath: source.path,
              sheet: source.inspection.sheet,
              headerRow: 0,
              headerDepth: 0,
            },
          })) as Inspection,
      );
      setJePath("");
      setTbPath("");
      setJe(undefined);
      setTb(undefined);
      setJeMapping({});
      setTbMapping({});
      for (const item of changed)
        applyInspection(item.kind, item.path, item.inspection);
      setSourceStatus(
        changed.length > 1
          ? "JE 与 TB 来源已交换，并按新类型重新识别。"
          : `${fileName(path)} 已更正为 ${to.toUpperCase()}。`,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function payload() {
    return {
      reportStart: depositReportStart(reportEnd),
      reportEnd,
      // 计息口径固定按月平均（年利率÷12）：选项对用户没有实际意义，已从界面移除。
      dayBasis: "month12",
      // 库存现金不参与存款利息测算；保留字段仅用于兼容现有引擎入参。
      includeCashOnHand: false,
      tbSource: {
        inputPath: tbPath,
        sheet: tb?.sheet ?? "",
        headerRow: tb?.headerRow ?? 0,
        headerDepth: tb?.headerDepth ?? 0,
      },
      tbMapping,
      ...(jePath
        ? {
            jeSource: {
              inputPath: jePath,
              sheet: je?.sheet ?? "",
              headerRow: je?.headerRow ?? 0,
              headerDepth: je?.headerDepth ?? 0,
            },
            jeMapping,
          }
        : {}),
      accountRoles,
      accountRoleOverrides,
      accountTierOverrides,
      rateOverrides,
      tierRates,
      ...(outputPath ? { outputPath } : {}),
    };
  }
  async function run(method: "deposit.preview" | "deposit.export") {
    setError("");
    if (!tb) return setError("请先上传并识别 TB 科目余额表。");
    if (!reportEnd) return setError("请选择资产负债表日。");
    const tbMissing = depositMissingRequired("tb", tbMapping, Boolean(jePath));
    if (tbMissing.length)
      return setError(
        `TB 尚未映射：${tbMissing.join("、")}。请先在预览表头完成字段映射。`,
      );
    if (jePath) {
      const jeMissing = depositMissingRequired("je", jeMapping);
      if (jeMissing.length)
        return setError(
          `序时账尚未映射：${jeMissing.join("、")}。请先在预览表头完成字段映射。`,
        );
    }
    if (!depositAccounts.length)
      return setError(
        "科目分类里没有任何计息的货币资金科目，请先确认银行存款/其他货币资金科目。",
      );
    setBusy(true);
    try {
      activeJob.current = await jobStart(method, payload());
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
    }
  }
  function overrideRow(
    key: string,
    next: { tier?: string; annualRate?: number },
  ) {
    setRateOverrides((current) => ({
      ...current,
      [key]: { ...current[key], ...next },
    }));
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row;
        const tier = next.tier ?? row.tier;
        const meta = tiers?.tiers.find((t) => t.key === tier);
        const tierRate = next.tier
          ? depositEffectiveTierRate(meta, tierRates)
          : undefined;
        const rate =
          next.annualRate ?? (next.tier ? (tierRate ?? 0) : row.annualRate);
        return {
          ...row,
          tier,
          annualRate: rate,
          tierLabel: meta?.label ?? row.tierLabel,
          category: meta?.category ?? row.category,
          termLabel: meta?.termLabel ?? row.termLabel,
          tierMatchedBy: next.tier ? "用户手工选择档位" : row.tierMatchedBy,
          rateResolved:
            next.annualRate !== undefined
              ? Number.isFinite(next.annualRate)
              : next.tier
                ? tierRate !== undefined
                : row.rateResolved,
          rateSource:
            next.annualRate !== undefined
              ? "本账户手工指定"
              : next.tier
                ? tierRate === undefined
                  ? "需填写实际利率"
                  : tierRates[tier] === undefined
                    ? "活期挂牌默认值"
                    : "自定义档位利率"
                : row.rateSource,
        };
      }),
    );
  }

  // 测算前还缺什么：TB 没传或必填映射没齐都列在这里，第三步直接提示并
  // 拦下测算按钮，不用等点了按钮才从报错里猜（与汇兑损益同一待遇）。
  const requiredMappingsMissing = [
    ...(!tbPath
      ? ["TB 未上传"]
      : depositMissingRequired("tb", tbMapping, Boolean(jePath)).map(
          (item) => `TB ${item}`,
        )),
    ...(jePath
      ? depositMissingRequired("je", jeMapping).map((item) => `序时账 ${item}`)
      : []),
  ];
  const accountTier = (account: string) =>
    accountTierOverrides[account] ??
    tb?.suggestedAccountTiers?.[account] ??
    je?.suggestedAccountTiers?.[account] ??
    "demand";
  const accountCategory = (account: string) =>
    tiers?.tiers.find((tier) => tier.key === accountTier(account))?.category ??
    "demand";

  return (
    <main className="tool-page fx-page deposit-page">
      <PageHeader
        eyebrow="货币资金审计"
        title={tool.name}
        detail="按月均余额重算存款利息，并与 TB 勾稽。"
      />
      <ErrorBox error={error} onDismiss={() => setError("")} />
      <StepIndicator
        steps={[
          { key: "source", label: "上传与识别" },
          // 利率档位与官方查询入口是参考资料，没上传文件也该看得到，
          // 所以第二步始终可进；测算那步没数据可跑，没传文件时置灰。
          { key: "accounts", label: "科目与利率确认" },
          { key: "run", label: "测算与底稿", disabled: !tb && !je },
        ]}
        current={step}
        onStepClick={setStep}
      />
      {step === 0 && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                上传审计数据
                <HelpTip text="TB 必传；序时账选传，用于还原每月余额。可一次拖入两个文件，系统会自动判断类型、标题行和字段。" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DataHandlingNotice
                mode="network-assisted"
                title="测算默认在本机完成"
                description="文件读取与利息测算在本机进行；AI 辅助识别或 LLM 字段复核可能将字段名和预览样本按设置发送到所配置服务。"
                details="TB 必传；JE 选传，用于还原月度余额。未上传 JE 时按 TB 期初、期末两点法测算。"
              />
              <FileDropInput
                containerRef={uploadDropRef}
                value=""
                disabled={busy}
                placeholder="拖放或选择 TB、序时账文件（可同时选择）"
                onBrowse={() => void browse()}
                onDragStateChange={() => {}}
                onClear={() => {
                  reviews.clearReview("je");
                  reviews.clearReview("tb");
                  setAccountRoleOverrides({});
                  setJePath("");
                  setTbPath("");
                  setJe(undefined);
                  setTb(undefined);
                  setJeMapping({});
                  setTbMapping({});
                  setRows([]);
                  setResult(undefined);
                  setSourceStatus("");
                }}
              />
              {!tbPath && !jePath && (
                <EmptyState
                  compact
                  title="准备存款利息资料"
                  description="先加入科目余额表（TB）；如需更准确地还原月度余额，可同时加入序时账（JE）。"
                />
              )}
              {sourceStatus && (
                <p className="fx-source-status" aria-live="polite">
                  <i aria-hidden="true" />
                  {sourceStatus}
                </p>
              )}
            </CardContent>
          </Card>

          <div className="fx-source-grid">
            <div className="fx-source-slot fx-source-slot-je">
              {jePath ? (
                <SourceCard
                  title="已识别：JE 序时账"
                  path={jePath}
                  inspection={je}
                  disabled={busy}
                  onClear={() => {
                    reviews.clearReview("je");
                    setAccountRoleOverrides({});
                    setJePath("");
                    setJe(undefined);
                    setJeMapping({});
                  }}
                  onInspect={() => void inspect("je")}
                  onKindChange={() => void changeSourceKind("je", "tb")}
                  kindChangeLabel="更正为 TB"
                />
              ) : tbPath ? (
                <Card className="fx-source-empty">
                  <CardHeader>
                    <CardTitle>JE 序时账</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <EmptyState
                      compact
                      title="JE 为选传资料"
                      description="当前将使用 TB 期初、期末两点法；加入 JE 后可还原月度余额。"
                    />
                  </CardContent>
                </Card>
              ) : null}
            </div>
            <div className="fx-source-slot fx-source-slot-tb">
              {tbPath ? (
                <SourceCard
                  title="已识别：TB 科目余额表"
                  path={tbPath}
                  inspection={tb}
                  disabled={busy}
                  onClear={() => {
                    reviews.clearReview("tb");
                    setAccountRoleOverrides({});
                    setTbPath("");
                    setTb(undefined);
                    setTbMapping({});
                  }}
                  onInspect={() => void inspect("tb")}
                  onKindChange={() => void changeSourceKind("tb", "je")}
                  kindChangeLabel="更正为 JE"
                />
              ) : jePath ? (
                <Card className="fx-source-empty">
                  <CardHeader>
                    <CardTitle>TB 科目余额表</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <EmptyState
                      compact
                      title="还需要 TB"
                      description="TB 是测算与账面利息勾稽的必需资料，请补充上传或检查文件表头。"
                    />
                  </CardContent>
                </Card>
              ) : null}
            </div>
          </div>

          {(tb || je) && (
            <LedgerReviewAll
              present={tb && je ? ["tb", "je"] : tb ? ["tb"] : ["je"]}
              names={{ tb: "TB", je: "序时账" }}
              reviewing={reviews.reviewing}
              status={reviews.status}
              results={reviews.results}
              disabled={busy}
              onReviewAll={() =>
                void reviews.reviewAll({
                  tb: tb
                    ? {
                        headers: tb.headers,
                        preview: tb.preview,
                        mapping: tbMapping,
                        labels: resolveRoleLabels(tb.roles, TB_LABELS),
                        tool: "deposit_interest",
                        onApplied: setTbMapping,
                        missingAfter: (mapping) =>
                          depositMissingRequired(
                            "tb",
                            mapping,
                            Boolean(jePath),
                          ),
                      }
                    : undefined,
                  je: je
                    ? {
                        headers: je.headers,
                        preview: je.preview,
                        mapping: jeMapping,
                        labels: resolveRoleLabels(je.roles, JE_LABELS),
                        tool: "deposit_interest",
                        onApplied: setJeMapping,
                        missingAfter: (mapping) =>
                          depositMissingRequired("je", mapping),
                      }
                    : undefined,
                })
              }
              onUndo={reviews.undoChange}
              onAccept={reviews.acceptPending}
            />
          )}

          <div className="fx-preview-stack">
            {tb && (
              <MappingPreview
                title="TB 文件预览与字段映射"
                kind="tb"
                inspection={tb}
                mapping={tbMapping}
                labels={TB_LABELS}
                missing={depositMissingRequired(
                  "tb",
                  tbMapping,
                  Boolean(jePath),
                )}
                banner={
                  reviews.reviewing.tb || reviews.status.tb ? (
                    <p aria-live="polite" className="fx-hint">
                      {reviews.reviewing.tb
                        ? "正在复核字段映射；复核期间暂时锁定。"
                        : reviews.status.tb}
                    </p>
                  ) : null
                }
                onMappingChange={setTbMapping}
                onHeaderChange={(row, depth, sheet) =>
                  void inspect("tb", {
                    headerRow: row,
                    headerDepth: depth,
                    sheet,
                  })
                }
                reviewBusy={reviews.reviewing.tb}
              />
            )}
            {je && (
              <MappingPreview
                title="序时账文件预览与字段映射"
                kind="je"
                inspection={je}
                mapping={jeMapping}
                labels={JE_LABELS}
                missing={depositMissingRequired("je", jeMapping)}
                banner={
                  reviews.reviewing.je || reviews.status.je ? (
                    <p aria-live="polite" className="fx-hint">
                      {reviews.reviewing.je
                        ? "正在复核字段映射；复核期间暂时锁定。"
                        : reviews.status.je}
                    </p>
                  ) : null
                }
                onMappingChange={setJeMapping}
                onHeaderChange={(row, depth, sheet) =>
                  void inspect("je", {
                    headerRow: row,
                    headerDepth: depth,
                    sheet,
                  })
                }
                reviewBusy={reviews.reviewing.je}
              />
            )}
          </div>
          {/* 步骤条第二步是参考资料、没传文件也允许进（见上方 StepIndicator
              注释）；但底部主按钮要设防：没拿到 TB 就不许走这条快捷路径。 */}
          <div className="fx-step-actions">
            <Button disabled={!tb} onClick={() => setStep(1)}>
              下一步：科目与利率确认
            </Button>
            {!tb && (
              <p className="fx-hint self-center">
                先加入科目余额表（TB）后可继续下一步。
              </p>
            )}
          </div>
        </>
      )}
      {step === 1 && (
        <>
          {accounts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>科目分类</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="deposit-account-summary">
                  计息科目 <b>{depositAccounts.length}</b> · 利息收入{" "}
                  <b>{interestAccounts.length}</b>
                  <HelpTip text="利息收入是 TB 比较基准；未设置时仍可测算，但不能勾稽。存款类型关联下方利率档位；名称无法判断时默认活期。" />
                </p>
                <details open>
                  <summary>逐个核对科目分类</summary>
                  <KeywordFilter
                    value={accountFilter}
                    onChange={setAccountFilter}
                    ariaLabel="筛选科目"
                    placeholder="输入科目编码或名称关键词，即时过滤（多个词用空格分隔）"
                    matched={visibleAccounts.length}
                    total={accounts.length}
                  />
                  <div className="fx-list fx-accounts deposit-account-list">
                    <div className="deposit-account-head" aria-hidden="true">
                      <span>科目</span>
                      <span>分类</span>
                      <span>存款类型</span>
                    </div>
                    {visibleAccounts.map((account) => (
                      <label key={account}>
                        <span title={account}>{account}</span>
                        <select
                          aria-label={`${account}的分类`}
                          value={accountRoleOverrides[account] ?? ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setAccountRoleOverrides((current) => {
                              const next = { ...current };
                              if (value) next[account] = value;
                              else delete next[account];
                              return next;
                            });
                          }}
                        >
                          <option value="">
                            自动（
                            {
                              ROLE_OPTIONS.find(
                                ([role]) =>
                                  role ===
                                  (tb?.suggestedAccountRoles?.[account] ??
                                    je?.suggestedAccountRoles?.[account] ??
                                    "excluded"),
                              )?.[1]
                            }
                            ）
                          </option>
                          {ROLE_OPTIONS.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                        {["deposit", "other_monetary", "cash_on_hand"].includes(
                          accountRoles[account] ?? "",
                        ) ? (
                          <div className="deposit-account-tier">
                            <select
                              aria-label={`${account}的存款类型`}
                              value={accountCategory(account)}
                              onChange={(e) =>
                                setAccountTierOverrides((current) => ({
                                  ...current,
                                  [account]: depositFirstTierOf(
                                    tiers,
                                    e.target.value,
                                  ),
                                }))
                              }
                            >
                              {(tiers?.categories ?? []).map((category) => (
                                <option key={category.key} value={category.key}>
                                  {category.label}
                                </option>
                              ))}
                            </select>
                            {depositTermsOf(tiers, accountCategory(account))
                              .length > 0 && (
                              <select
                                aria-label={`${account}的存款期限`}
                                value={accountTier(account)}
                                onChange={(e) =>
                                  setAccountTierOverrides((current) => ({
                                    ...current,
                                    [account]: e.target.value,
                                  }))
                                }
                              >
                                {depositTermsOf(
                                  tiers,
                                  accountCategory(account),
                                ).map((term) => (
                                  <option key={term.key} value={term.key}>
                                    {term.label}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        ) : (
                          <span className="deposit-account-na">—</span>
                        )}
                      </label>
                    ))}
                  </div>
                  {accounts.length > 0 && visibleAccounts.length === 0 && (
                    <p className="fx-hint">
                      没有匹配「{accountFilter.trim()}」的科目。
                    </p>
                  )}
                </details>
              </CardContent>
            </Card>
          )}

          <RateTierCard
            tiers={tiers}
            custom={tierRates}
            onChange={(key, rate) =>
              setTierRates((current) => {
                const next = { ...current };
                if (Number.isFinite(rate)) next[key] = rate;
                else delete next[key];
                return next;
              })
            }
            onReset={() => setTierRates({})}
          />

          <div className="fx-step-actions">
            <Button variant="secondary" onClick={() => setStep(0)}>
              返回上传与识别
            </Button>
            <Button onClick={() => setStep(2)}>下一步：测算与底稿</Button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                测算与底稿
                <HelpTip text="仅活期自动使用默认利率；其他类型须填写协议利率。未上传序时账时采用期初/期末两点法。" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="deposit-run-grid">
                <label>
                  资产负债表日
                  <Input
                    type="date"
                    value={reportEnd}
                    onChange={(e) => setReportEnd(e.target.value)}
                  />
                </label>
                <label>
                  输出文件
                  <span className="deposit-output-row">
                    <Input
                      value={outputPath}
                      readOnly
                      title={outputPath || undefined}
                      placeholder="默认保存到源文件目录"
                    />
                    <Button
                      variant="secondary"
                      onClick={async () => {
                        const path = await pickPath(
                          "save",
                          "保存审计底稿",
                          ["xlsx"],
                          "存款利息收入测算.xlsx",
                        );
                        if (typeof path === "string") setOutputPath(path);
                      }}
                    >
                      选择位置
                    </Button>
                  </span>
                </label>
              </div>
              {jePath && (
                <p className="deposit-layout">
                  当前序时账布局：{JE_LAYOUT_LABEL[depositJeLayout(jeMapping)]}
                  （由你映射的列决定）；金额符号记法由系统按凭证配平自动识别，测算结果中会披露判定依据。
                </p>
              )}
              {requiredMappingsMissing.length > 0 && (
                <p className="fx-warning" aria-live="polite">
                  还不能测算：{requiredMappingsMissing.join("、")}。请回到
                  <button
                    type="button"
                    className="fx-link-button"
                    onClick={() => setStep(0)}
                  >
                    上传与识别
                  </button>
                  补齐。
                </p>
              )}
              <div className="fx-actions">
                <Button
                  variant="secondary"
                  disabled={
                    busy || reviewingAny || requiredMappingsMissing.length > 0
                  }
                  onClick={() => void run("deposit.preview")}
                >
                  {busy && <BusySpinner />}测算预览
                </Button>
                <Button
                  disabled={
                    busy || reviewingAny || requiredMappingsMissing.length > 0
                  }
                  onClick={() => void run("deposit.export")}
                >
                  {busy && <BusySpinner />}生成 Excel 底稿
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
            <Results
              rows={rows}
              result={result}
              tiers={tiers}
              expanded={expanded}
              onExpand={setExpanded}
              onOverride={overrideRow}
              onRecalculate={() => void run("deposit.preview")}
              busy={busy}
            />
          )}

          <div className="fx-step-actions">
            <Button variant="secondary" onClick={() => setStep(1)}>
              返回科目与利率确认
            </Button>
          </div>
        </>
      )}
    </main>
  );
}

function RateTierCard({
  tiers,
  custom,
  onChange,
  onReset,
}: {
  tiers?: RateTiers;
  custom: Record<string, number>;
  onChange: (key: string, rate: number) => void;
  onReset: () => void;
}) {
  // 默认只展示前两档（活期/协定），其余折叠；useState 必须在下方 !tiers 提前返回之前调用
  const [folded, setFolded] = useState(true);
  const pct = (value: number | null | undefined, fallback = "—") =>
    value == null
      ? fallback
      : `${(value * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`;
  if (!tiers) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>存款利率档位</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="fx-hint">
            利率档位表由本机引擎提供，浏览器预览模式下不可用；在正式应用里会显示完整的档位、来源说明和官方查询入口。
          </p>
        </CardContent>
      </Card>
    );
  }
  const changed = Object.keys(custom).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          存款利率档位
          <HelpTip text="科目类型会关联这里的档位。活期自动采用默认利率；协定、通知、定期及大额存单须按协议填写。账户级改写优先。" />
          <JargonTip
            term="存款类型"
            text="活期有内置利率；定期、协定、通知等按客户协议利率填写。"
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {tiers.ratesStale && (
          <details className="deposit-stale">
            <summary>内置挂牌利率可能已过期</summary>
            <span>{tiers.staleMessage}</span>
          </details>
        )}
        <div className="deposit-tier-table">
          <table>
            <thead>
              <tr>
                <th>大类</th>
                <th>期限</th>
                <th>
                  央行基准<small>{tiers.benchmarkDate} 起 · 仅上限参照</small>
                </th>
                <th>
                  大行挂牌<small>{tiers.listedDate}</small>
                </th>
                <th>实务常见区间</th>
                <th>本次采用（%，可修改）</th>
                <th>实务说明</th>
              </tr>
            </thead>
            <tbody id="deposit-rate-tier-rows">
              {(folded ? tiers.tiers.slice(0, 2) : tiers.tiers).map((tier) => {
                const applied = depositEffectiveTierRate(tier, custom);
                const overridden = custom[tier.key] !== undefined;
                return (
                  <tr
                    key={tier.key}
                    className={
                      applied === undefined ? "deposit-tier-unset" : undefined
                    }
                  >
                    <td>{tier.categoryLabel}</td>
                    <td>{tier.termLabel || "—"}</td>
                    <td>{pct(tier.benchmarkRate, "央行未公布")}</td>
                    <td>{pct(tier.listedRate, "按存款协议")}</td>
                    <td>
                      {tier.practiceLow == null
                        ? "—"
                        : `${pct(tier.practiceLow)} ~ ${pct(tier.practiceHigh)}`}
                    </td>
                    <td>
                      <span className="deposit-pct">
                        <NumberInput
                          label={`${tier.label}的采用利率`}
                          step="0.01"
                          min="0"
                          max="20"
                          className={
                            overridden ? "deposit-tier-changed" : undefined
                          }
                          value={depositRateToPercent(applied)}
                          placeholder={tier.autoApply ? "" : "需填"}
                          onCommit={(text) =>
                            onChange(tier.key, depositPercentToRate(text))
                          }
                        />
                        <b>%</b>
                      </span>
                    </td>
                    <td className="deposit-tier-note">{tier.practiceNote}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {tiers.tiers.length > 2 && (
            <button
              type="button"
              className="deposit-tier-fold"
              aria-controls="deposit-rate-tier-rows"
              aria-expanded={!folded}
              onClick={() => setFolded((f) => !f)}
            >
              {folded
                ? `展开其余 ${tiers.tiers.length - 2} 个档位 ▾`
                : "收起，只保留前两档 ▴"}
            </button>
          )}
        </div>
        {changed > 0 && (
          <p className="deposit-tier-actions">
            已改写 {changed} 档默认利率。
            <button type="button" onClick={onReset}>
              全部恢复内置默认值
            </button>
          </p>
        )}
        <ReferenceLinks tiers={tiers} />
        <p className="deposit-tier-note">
          利率来源与口径说明
          <HelpTip
            text={`央行基准：${tiers.benchmarkSource}；大行挂牌：${tiers.listedSource}；实务常见区间：${tiers.practiceSource}；审计依据：${tiers.authority}`}
          />
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * 官方利率查询入口。默认只露出首行三个官方渠道，其余收进折叠区，
 * 免得一屏参考链接把利率档位表挤下去。
 * 链接经 Rust 侧白名单校验后交给系统浏览器打开——前端不能用这条命令
 * 访问任意地址，与本地文件走 AllowedPaths 是同一套约束。
 */
function ReferenceLinks({ tiers }: { tiers: RateTiers }) {
  const [failed, setFailed] = useState("");
  const [copied, setCopied] = useState("");
  async function open(link: ReferenceLink) {
    setFailed("");
    setCopied("");
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
  const button = (link: ReferenceLink) => (
    <button
      type="button"
      key={link.url}
      onClick={() => void open(link)}
      title={`${link.hint}（在系统浏览器中打开 ${link.url}）`}
    >
      {link.label}
      <span aria-hidden="true">↗</span>
    </button>
  );

  const [primary, ...rest] = tiers.linkGroups;
  const primaryLinks = tiers.links.filter(
    (link) => link.group === primary?.key,
  );
  const restGroups = rest
    .map((group) => ({
      group,
      items: tiers.links.filter((link) => link.group === group.key),
    }))
    .filter((entry) => entry.items.length > 0);

  return (
    <section className="deposit-links" aria-labelledby="deposit-links-title">
      <div className="deposit-link-row">
        <h4 id="deposit-links-title">官方利率查询入口</h4>
        {primaryLinks.map(button)}
      </div>
      {restGroups.map(({ group, items }) => (
        <details className="deposit-link-more" key={group.key}>
          <summary>
            {group.label}（{items.length} 家）
          </summary>
          <p className="deposit-link-group-head">
            <span>{group.hint}</span>
          </p>
          <ul>
            {items.map((link) => (
              <li key={link.url}>
                {button(link)}
                <span className="deposit-link-hint">{link.hint}</span>
                <code>{link.url}</code>
              </li>
            ))}
          </ul>
        </details>
      ))}
      {copied && (
        <p className="deposit-link-note" aria-live="polite">
          无法直接打开浏览器，已把网址复制到剪贴板：{copied}
        </p>
      )}
      {failed && (
        <p className="deposit-link-note" aria-live="polite">
          无法打开浏览器，请手工复制网址：{failed}
        </p>
      )}
    </section>
  );
}

function SourceCard(props: {
  title: string;
  path: string;
  inspection?: Inspection;
  disabled: boolean;
  onClear: () => void;
  onInspect: () => void;
  onKindChange?: () => void;
  kindChangeLabel?: string;
}) {
  return (
    <Card className="fx-source-card">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="fx-detected-file">
          <span title={props.path}>{fileName(props.path)}</span>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={props.disabled}
            onClick={props.onClear}
          >
            移除
          </Button>
          {props.onKindChange && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={props.disabled}
              onClick={props.onKindChange}
            >
              {props.kindChangeLabel ?? "更正类型"}
            </Button>
          )}
        </div>
        {props.path && !props.inspection && (
          <Button
            variant="secondary"
            disabled={props.disabled}
            onClick={props.onInspect}
          >
            自动识别表头和字段
          </Button>
        )}
        {props.inspection && (
          <div className="fx-source-meta">
            <span>
              {props.inspection.rowCount.toLocaleString()} 行 ×{" "}
              {props.inspection.headers.length} 列
            </span>
            {props.inspection.headerDetection.needsConfirmation && (
              <strong className="fx-warning">
                标题候选得分接近，请确认标题行
              </strong>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MappingPreview(props: {
  title: string;
  kind: "je" | "tb";
  inspection: Inspection;
  mapping: Record<string, string | string[]>;
  labels: Record<string, string>;
  missing: string[];
  /** 复核状态等提示，并进预览面板顶部——不再单独飘一条（与汇兑损益一致）。 */
  banner?: React.ReactNode;
  onMappingChange: React.Dispatch<
    React.SetStateAction<Record<string, string | string[]>>
  >;
  onHeaderChange: (row: number, depth: number, sheet: string) => void;
  reviewBusy: boolean;
}) {
  // 复核按钮已上移为「一键复核 TB＋JE」（页面级 LedgerReviewAll），
  // 这里只负责展示与锁定：复核期间该文件的字段映射不可编辑。
  // 标签优先取引擎随识别结果下发的 roles，未下发（或没有该角色）回落本地表。
  const labels = resolveRoleLabels(props.inspection.roles, props.labels);
  const roles = Object.entries(labels);
  const forms = useLedgerForms(props.kind);
  const formMatch = forms.length
    ? resolveForm(props.kind, forms, props.mapping)
    : undefined;
  return (
    <MappingPanel
      title={props.title}
      headers={props.inspection.headers}
      rows={props.inspection.preview}
      mapping={props.mapping}
      roles={roles}
      groups={formGroups(props.kind, roles, forms, props.mapping)}
      requirementOf={(role) => roleRequirement(formMatch, role)}
      formNote={describeForm(formMatch, (role) => labels[role] ?? role)}
      multi={DEPOSIT_MULTI}
      missing={props.missing}
      banner={props.banner}
      busy={props.reviewBusy}
      toolbar={
        <>
          <label>
            Sheet
            <select
              value={props.inspection.sheet}
              onChange={(e) => props.onHeaderChange(0, 0, e.target.value)}
            >
              {(props.inspection.sheets.length
                ? props.inspection.sheets
                : [props.inspection.sheet]
              ).map((sheet) => (
                <option key={sheet}>{sheet}</option>
              ))}
            </select>
          </label>
          <label>
            标题行
            <Input
              controlSize="sm"
              type="number"
              min={1}
              value={props.inspection.headerRow}
              onChange={(e) =>
                props.onHeaderChange(
                  Number(e.target.value),
                  props.inspection.headerDepth,
                  props.inspection.sheet,
                )
              }
            />
          </label>
          <label>
            表头层数
            <select
              value={props.inspection.headerDepth}
              onChange={(e) =>
                props.onHeaderChange(
                  props.inspection.headerRow,
                  Number(e.target.value),
                  props.inspection.sheet,
                )
              }
            >
              <option value={1}>1层</option>
              <option value={2}>2层</option>
            </select>
          </label>
        </>
      }
      onChange={(next) =>
        props.onMappingChange(next as Record<string, string | string[]>)
      }
    />
  );
}

function Results({
  rows,
  result,
  tiers,
  expanded,
  onExpand,
  onOverride,
  onRecalculate,
  busy,
}: {
  rows: AccountRow[];
  result?: Record<string, unknown>;
  tiers?: RateTiers;
  expanded: string;
  onExpand: (key: string) => void;
  onOverride: (
    key: string,
    next: { tier?: string; annualRate?: number },
  ) => void;
  onRecalculate: () => void;
  busy: boolean;
}) {
  const summary = (result?.summary ?? {}) as Record<string, unknown>;
  const outputs = (result?.outputPaths ?? []) as string[];
  const amount = (value: unknown) =>
    new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value ?? 0));
  const percent = (value: unknown) =>
    value == null
      ? "无法计算"
      : new Intl.NumberFormat("zh-CN", {
          style: "percent",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(Number(value));
  const booked = summary.hasInterestIncomeAccount === true;
  const metric = (
    label: string,
    value: unknown,
    detail?: string,
    tone = "",
  ) => (
    <div className={`fx-bridge-metric ${tone}`.trim()}>
      <span>{label}</span>
      <strong>{typeof value === "string" ? value : amount(value)}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
  // 用户在表里改利率后立刻按同一条公式重算行内金额；上方与 TB 的比较仍是
  // 服务端结果，两者对不上时提示重算，避免同屏出现两个口径的合计。
  const rowInterest = (row: AccountRow) =>
    row.rateResolved
      ? row.months.reduce(
          (sum, month) =>
            sum +
            depositMonthlyInterest(
              month.average,
              row.annualRate,
              month.days,
              month.denominator,
            ),
          0,
        )
      : 0;
  const liveTotal = rows
    .filter((row) => row.rateResolved)
    .reduce((sum, row) => sum + rowInterest(row), 0);
  const missing = rows.filter((row) => !row.rateResolved);
  const stale =
    Math.abs(liveTotal - Number(summary.calculatedInterest ?? 0)) > 0.005;

  return (
    <section className="fx-result deposit-result">
      <div className="fx-result-heading">
        <div>
          <h3>
            存款利息测算结果
            <HelpTip
              text={`月均余额＝（月初余额＋月末余额）÷2；月度余额来源：${String(
                summary.monthlySource ?? "—",
              )}；期初余额来源：${String(
                summary.openingSource ?? "—",
              )}；测算月份：${String(summary.monthCount ?? "—")} 个月；计息口径：${String(
                summary.dayBasisLabel ?? "—",
              )}。`}
            />
          </h3>
          {Boolean(summary.amountScheme) && (
            <p
              className="deposit-scheme"
              title={String(summary.amountEvidence ?? "")}
            >
              序时账金额口径：<b>{String(summary.amountScheme)}</b>
              <span>{String(summary.amountEvidence ?? "")}</span>
            </p>
          )}
        </div>
        {outputs.map((path) => (
          <Button
            key={path}
            variant="secondary"
            onClick={() => void openOutput(path)}
          >
            打开 Excel 底稿
          </Button>
        ))}
      </div>

      <div className="deposit-result-overview" role="status">
        <Badge
          variant="outline"
          className={
            missing.length ||
            stale ||
            !booked ||
            summary.reconciliationPassed !== true
              ? "badge-warning"
              : "badge-ready"
          }
        >
          {missing.length
            ? "测算未完整"
            : stale
              ? "结果待重算"
              : !booked
                ? "待补充勾稽"
                : summary.reconciliationPassed === true
                  ? "勾稽一致"
                  : "存在差异"}
        </Badge>
        <span>
          {missing.length
            ? "先补齐未定利率，再按新利率重算。"
            : stale
              ? "按新利率重新测算后，再复核与 TB 的差异。"
              : !booked
                ? "请确认 TB 利息收入科目映射，再完成账面勾稽。"
                : summary.reconciliationPassed === true
                  ? "可继续复核逐户明细并生成 Excel 底稿。"
                  : "请复核利率、科目分类和月度余额后重新测算。"}
        </span>
      </div>

      {missing.length > 0 && (
        <p className="deposit-stale">
          <b>{missing.length} 个账户尚未确定利率，测算尚不完整</b>
          <span>
            涉及 {[...new Set(missing.map((row) => row.tierLabel))].join("、")}
            ，月均余额合计{" "}
            {amount(missing.reduce((sum, row) => sum + row.averageBalance, 0))}
            。
            这些档位的利率是逐笔合同约定的，请按存款协议、银行对账单或利息清单填入实际利率——填之前它们的利息不计入下方合计和与
            TB 的比较。
          </span>
        </p>
      )}
      {stale && (
        <p className="fa-missing-hint">
          已修改利率，下方逐户金额已按新利率更新；与 TB
          的比较仍是上一次测算的结果，点“按新利率重算”后同步。
        </p>
      )}
      <div className="fx-bridge-step">
        <div className="fx-step-label">
          <b>1</b>
          <span>形成测算</span>
        </div>
        <div className="deposit-result-summary">
          {metric("计息账户", `${rows.length} 户`)}
          {metric("测算月份", `${String(summary.monthCount ?? "—")} 个月`)}
          {metric("审计测算存款利息", summary.calculatedInterest)}
        </div>
      </div>
      <div className="fx-bridge-step comparison">
        <div className="fx-step-label">
          <b>2</b>
          <span>与 TB 比较</span>
        </div>
        <div className="fx-bridge-equation">
          {metric("审计测算存款利息", summary.calculatedInterest)}
          <span className="fx-operator compare" aria-hidden="true">
            对比
          </span>
          {metric(
            "TB 账面利息收入",
            booked ? summary.bookedInterestIncome : "未识别",
            booked && summary.bookedNote
              ? String(summary.bookedNote)
              : undefined,
            booked && Number(summary.bookedInterestIncome) < 0 ? "warning" : "",
          )}
          <span className="fx-operator" aria-hidden="true">
            ＝
          </span>
          {metric(
            "差异",
            booked ? summary.difference : "无法比较",
            !booked
              ? "TB 中未识别到利息收入科目"
              : missing.length
                ? `差异率 ${percent(summary.differenceRatio)}；尚有 ${missing.length} 户未定利率`
                : `差异率 ${percent(summary.differenceRatio)}`,
            booked && summary.reconciliationPassed === true
              ? "pass"
              : "warning",
          )}
        </div>
      </div>

      <div className="deposit-rate-head">
        <div>
          <h4>逐户利率与利息测算</h4>
          <p>
            {String(summary.rateBasisLabel ?? "—")}
            改成存款协议或对账单上的实际利率后，点“按新利率重算”。
          </p>
        </div>
        <Button variant="secondary" disabled={busy} onClick={onRecalculate}>
          按新利率重算
        </Button>
      </div>
      <div className="deposit-table">
        <table>
          <thead>
            <tr>
              <th>核算主体</th>
              <th>科目</th>
              <th>辅助核算</th>
              <th>存款档位（大类／期限）</th>
              <th>年利率（%）</th>
              <th>利率来源</th>
              <th>年初余额</th>
              <th>年末余额(TB)</th>
              <th>年末余额(JE推导)</th>
              <th>勾稽差异</th>
              <th>月均余额</th>
              <th>测算利息</th>
              <th>状态</th>
              <th>月度</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.key}>
                <tr
                  className={
                    row.status === "已勾稽" ? "" : "deposit-review-row"
                  }
                >
                  <td>{row.entity}</td>
                  <td title={row.account}>{row.account}</td>
                  <td>{row.auxiliary}</td>
                  <td title={row.tierMatchedBy}>
                    <div className="deposit-tier-picker">
                      <select
                        value={row.category}
                        onChange={(e) =>
                          onOverride(row.key, {
                            tier: depositFirstTierOf(tiers, e.target.value),
                          })
                        }
                      >
                        {(tiers?.categories ?? []).map((category) => (
                          <option key={category.key} value={category.key}>
                            {category.label}
                          </option>
                        ))}
                      </select>
                      {depositTermsOf(tiers, row.category).length > 0 && (
                        <select
                          value={row.tier}
                          onChange={(e) =>
                            onOverride(row.key, { tier: e.target.value })
                          }
                        >
                          {depositTermsOf(tiers, row.category).map((term) => (
                            <option key={term.key} value={term.key}>
                              {term.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className="deposit-pct">
                      <NumberInput
                        label={`${row.account}的年利率`}
                        step="0.01"
                        min="0"
                        max="20"
                        className={
                          !row.rateResolved ? "deposit-rate-missing" : undefined
                        }
                        value={
                          row.rateResolved
                            ? depositRateToPercent(row.annualRate)
                            : ""
                        }
                        placeholder="需填"
                        onCommit={(text) =>
                          onOverride(row.key, {
                            annualRate: depositPercentToRate(text),
                          })
                        }
                      />
                      <b>%</b>
                    </span>
                  </td>
                  <td title={row.rateWarning}>
                    {row.rateWarning
                      ? `${row.rateSource}（高于央行基准）`
                      : row.rateSource}
                  </td>
                  <td>{amount(row.openingBalance)}</td>
                  <td>{amount(row.tbClosingBalance)}</td>
                  <td>{amount(row.derivedClosingBalance)}</td>
                  <td>{amount(row.reconciliationDiff)}</td>
                  <td>{amount(row.averageBalance)}</td>
                  <td>{amount(rowInterest(row))}</td>
                  <td title={row.note}>
                    <Badge
                      variant="outline"
                      className={
                        row.status === "已勾稽"
                          ? "badge-ready"
                          : row.status === "待填利率"
                            ? "badge-danger"
                            : "badge-warning"
                      }
                    >
                      {row.status}
                    </Badge>
                  </td>
                  <td>
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      className="deposit-expand"
                      onClick={() =>
                        onExpand(expanded === row.key ? "" : row.key)
                      }
                    >
                      {expanded === row.key ? "收起" : "展开"}
                    </Button>
                  </td>
                </tr>
                {expanded === row.key && (
                  <tr className="deposit-month-row">
                    <td colSpan={14}>
                      <table className="deposit-month-table">
                        <thead>
                          <tr>
                            <th>月份</th>
                            <th>月初余额</th>
                            <th>本月借方</th>
                            <th>本月贷方</th>
                            <th>月末余额</th>
                            <th>月均余额</th>
                            <th>当月利息</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.months.map((month) => (
                            <tr key={month.month}>
                              <td>{month.month}月</td>
                              <td>{amount(month.opening)}</td>
                              <td>{amount(month.debit)}</td>
                              <td>{amount(month.credit)}</td>
                              <td>{amount(month.closing)}</td>
                              <td>
                                {amount(
                                  depositMonthlyAverage(
                                    month.opening,
                                    month.closing,
                                  ),
                                )}
                              </td>
                              <td>
                                {amount(
                                  depositMonthlyInterest(
                                    month.average,
                                    row.annualRate,
                                    month.days,
                                    month.denominator,
                                  ),
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fx-rate-note">
        导出的 Excel
        里，「测算汇总」的黄色“年利率”单元格可以直接改写：月度利息、测算利息合计和与
        TB 的勾稽差异都是活公式，改完即时重算，不必回到工具里。
      </p>
    </section>
  );
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}
