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
import {
  verifyAuxiliaryLink,
  type AuxiliaryLinkResult,
  verifyCurrencyLink,
  type CurrencyLinkResult,
} from "@/ledgerMapping";
import { errorText } from "@/lib/errors";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StepIndicator } from "@/components/StepIndicator";
import { JargonTip } from "@/components/JargonTip";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { NumberInput } from "@/components/NumberInput";
import { DateInput } from "@/components/DateInput";
import { defaultBalanceSheetDate } from "@/dateDefaults";
import { displayFileName } from "@/fileDisplay";
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
import { useEntityScopeConfirmation } from "@/components/EntityScopeConfirmation";
import {
  CurrencyFallbackDialog,
  type CurrencyFallbackMode,
} from "@/components/CurrencyFallbackDialog";
import {
  CreditBalanceDialog,
  type CreditBalanceAccount,
} from "@/components/CreditBalanceDialog";

/** 可多列的角色与统一内核一致；`account` 是历史保存映射的旧槽位。 */
const DEPOSIT_MULTI = new Set([
  "id",
  "accountName",
  "auxiliary",
  "account",
  "date",
]);
const ACCOUNT_REVIEW_PAGE_SIZE = 250;
import "./fx-audit.css";
import "./deposit-interest.css";
import { AccountConfirmationActions } from "./AccountConfirmationActions";

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
  /** 末级科目清单（引擎目录末级掩码下发）；旧任务缺省时回退 accounts。 */
  accountsLeaf?: string[];
  /** 账里真实存在的「主体×科目」组合（空主体已归默认主体，最多 2000 条），
      供 FA List 等页面按真实搭配铺科目复核清单；旧后端／预览模式不下发，
      使用方需自行回退。 */
  entityAccounts?: Array<{ entity: string; account: string }>;
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
  /** 利率是否直接取自内置挂牌表（未经用户改写）；来源文案统一后，待确认提示由它驱动。 */
  rateProvisional?: boolean;
  rateWarning: string;
  openingBalance: number;
  tbClosingBalance: number;
  derivedClosingBalance: number;
  jeReconciled?: boolean;
  reconciliationDiff: number;
  averageBalance: number;
  calculatedInterest: number;
  months: MonthCell[];
  status: string;
  note: string;
};

/** 余额是否勾稽与利率是否可用是两件事，不能用单个优先级状态覆盖。 */
export function depositBalanceCheckStatus(
  row: Pick<AccountRow, "jeReconciled" | "reconciliationDiff">,
): "已勾稽" | "待复核" | "未做JE核对" {
  if (row.jeReconciled !== true) return "未做JE核对";
  return Math.abs(row.reconciliationDiff) < 0.005 ? "已勾稽" : "待复核";
}

export function depositRateCheckStatus(
  row: Pick<
    AccountRow,
    "rateResolved" | "rateSource" | "status" | "rateProvisional"
  >,
): "已填利率" | "待确认利率" | "待填利率" {
  if (!row.rateResolved) return "待填利率";
  // 来源文案已统一为「挂牌暂估值」，是否待确认看引擎下发的标记；
  // 旧数据没有标记时按状态回退。
  return row.rateProvisional === true || row.status === "待确认利率"
    ? "待确认利率"
    : "已填利率";
}

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

/** 科目目录只依赖这些身份字段。金额、日期等映射变化不应触发整本 Excel 重读。 */
export function depositCatalogMappingKey(
  mapping: Record<string, string | string[]>,
): string {
  return JSON.stringify(
    ["entity", "account", "accountCode", "accountName"].map((role) => [
      role,
      mapping[role] ?? "",
    ]),
  );
}

type DepositAccountReviewRow = {
  key: string;
  account: string;
  entity?: string;
  auxiliary?: string;
  auxiliaryKey?: string;
};

const depositDetailKey = (entity: string, account: string, auxiliary: string) =>
  `${entity}\u001f${account}\u001f${auxiliary}`;

/** 只有公共验证确认 TB 辅助值在 JE 对应列完整命中时才展开。 */
export function depositAccountReviewRows(
  accounts: string[],
  link: AuxiliaryLinkResult | null,
): DepositAccountReviewRow[] {
  return accounts.flatMap((account) => {
    const code = depositAccountCode(account);
    const groups = (link?.groups ?? []).filter(
      (group) => group.account === code,
    );
    const expanded = groups.flatMap((group) =>
      group.reviewVerified
        ? (group.details ?? []).map((detail) => ({
            key: depositDetailKey(group.entity, group.account, detail.key),
            account,
            entity: group.entity,
            auxiliary: detail.display,
            auxiliaryKey: detail.key,
          }))
        : [],
    );
    const hasFallback =
      groups.length === 0 || groups.some((group) => !group.reviewVerified);
    return [...expanded, ...(hasFallback ? [{ key: account, account }] : [])];
  });
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
/** 有挂牌参考值的标准档位均自动带出暂估利率；自定义档位仍须手填。 */
export function depositAutoRate(tier: RateTier | undefined) {
  return tier?.autoApply ? (tier.listedRate ?? undefined) : undefined;
}
/** 档位实际采用的利率：用户改写过就用改写值，否则使用内置挂牌暂估值。 */
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
  // 辅助核算语义映射保留；公共验证逐主体＋科目决定是否启用辅助键。
  const [auxLink, setAuxLink] = useState<AuxiliaryLinkResult | null>(null);
  const [currencyLink, setCurrencyLink] = useState<CurrencyLinkResult | null>(
    null,
  );
  const [currencyFallbackMode, setCurrencyFallbackMode] = useState<
    CurrencyFallbackMode | ""
  >("");
  const [currencyDialogOpen, setCurrencyDialogOpen] = useState(false);
  function resetCurrencyFallback() {
    setCurrencyLink(null);
    setCurrencyFallbackMode("");
    setCurrencyDialogOpen(false);
  }
  const [accountRoles, setAccountRoles] = useState<Record<string, string>>({});
  const [accountRoleOverrides, setAccountRoleOverrides] = useState<
    Record<string, string>
  >({});
  const [accountTierOverrides, setAccountTierOverrides] = useState<
    Record<string, string>
  >({});
  const [accountDetailRoleOverrides, setAccountDetailRoleOverrides] = useState<
    Record<string, string>
  >({});
  const [accountDetailTierOverrides, setAccountDetailTierOverrides] = useState<
    Record<string, string>
  >({});
  const [accountFilter, setAccountFilter] = useState("");
  const [accountReviewLimit, setAccountReviewLimit] = useState(
    ACCOUNT_REVIEW_PAGE_SIZE,
  );
  const [reportEnd, setReportEnd] = useState(defaultBalanceSheetDate());
  const [tiers, setTiers] = useState<RateTiers>();
  const [tierRates, setTierRates] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [rateOverrides, setRateOverrides] = useState<
    Record<string, { tier?: string; annualRate?: number }>
  >({});
  // 第二步「科目与利率确认」表里的逐户利率改写：键与存款类型覆盖同一套
  // （普通行＝科目全文，辅助明细行＝主体␟科目␟辅助）。没改写的户在测算时
  // 自动套所选档位的挂牌默认利率，所以这里只存用户真正动手改过的值。
  const [accountRateOverrides, setAccountRateOverrides] = useState<
    Record<string, number>
  >({});
  const [expanded, setExpanded] = useState("");
  const [result, setResult] = useState<Record<string, unknown>>();
  const [outputPath, setOutputPath] = useState("");
  const [sourceStatus, setSourceStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // 引擎下发的「测算前行清单」：键与测算结果行完全一致，供第二步按币种拆行、
  // 逐行填利率，并与第三步的逐户改价联动。旧后端／预览模式没有这份清单，
  // 第二步回退到按科目整行显示。
  const [accountCurrencyRows, setAccountCurrencyRows] = useState<
    Array<{
      key: string;
      entity: string;
      account: string;
      auxiliary: string;
      currency: string;
      role: string;
    }>
  >([]);
  // 贷方余额存款账户的处理口径：缺省＝不纳入测算；用户在弹窗里确认后 include。
  const [creditBalancePolicy, setCreditBalancePolicy] = useState<"" | "include">(
    "",
  );
  const [creditDialogOpen, setCreditDialogOpen] = useState(false);
  // 三步导引，与汇兑损益／FA 一致：上传识别 → 科目分类 → 测算与底稿。
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [job, setJob] = useState<JobEvent>();
  const activeJob = useRef("");
  // 启动测算时的口径与方法：完成事件按“本次用没用纳入口径”决定是否弹窗。
  const creditPolicyAtRunRef = useRef<"" | "include">("");
  const lastRunMethod = useRef<"deposit.preview" | "deposit.export">(
    "deposit.preview",
  );
  const uploadDropRef = useRef<HTMLDivElement>(null);
  // 一键复核 TB＋JE：引擎与汇兑损益共用同一份（见 components/LedgerReviewAll）。
  const reviews = useLedgerDictReviews(engineCall, {
    tb: JSON.stringify([tbPath, tb?.sheet, tb?.headerRow, tb?.headerDepth]),
    je: JSON.stringify([jePath, je?.sheet, je?.headerRow, je?.headerDepth]),
  });
  const ledgerReviewOwner = useRef({});
  const reviewingAny = reviews.reviewing.tb || reviews.reviewing.je;
  const entityScope = useEntityScopeConfirmation({
    tbEntities: tb?.entities ?? [],
    jeEntities: je?.entities ?? [],
    onInvalidate: () => {
      activeJob.current = "";
      setResult(undefined);
      setRows([]);
      setJob(undefined);
    },
  });

  const accounts = useMemo(
    // 科目确认只列末级科目：末级清单由公共引擎的目录末级掩码下发
    // （分段编码等层级形态只有引擎认得）；旧任务没有该字段时回退全量清单。
    () =>
      mergeAccountList(
        tb?.accountsLeaf ?? tb?.accounts ?? [],
        je?.accounts ?? [],
      ),
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
  const reviewAccounts = useMemo(
    () => depositAccountReviewRows(accounts, auxLink),
    [accounts, auxLink],
  );
  const reviewRole = (row: DepositAccountReviewRow) =>
    accountDetailRoleOverrides[row.key] ?? accountRoles[row.account] ?? "";
  const activeAccount = (row: DepositAccountReviewRow) => {
    const role = reviewRole(row);
    return role !== "" && role !== "excluded";
  };
  const visibleAccounts = useMemo(
    () =>
      reviewAccounts
        .filter((row) =>
          accountMatches(
            `${row.account} ${row.entity ?? ""} ${row.auxiliary ?? ""}`,
          ),
        )
        .sort((a, b) => Number(activeAccount(b)) - Number(activeAccount(a))),
    // activeAccount reads the two override maps that determine the priority group.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reviewAccounts, accountMatches, accountDetailRoleOverrides, accountRoles],
  );
  const renderedAccounts = visibleAccounts.slice(0, accountReviewLimit);

  useEffect(() => {
    setAccountReviewLimit(ACCOUNT_REVIEW_PAGE_SIZE);
  }, [accountFilter, accounts]);

  useEffect(() => {
    void engineCall("deposit.rate_tiers", {})
      .then((x) => setTiers(x as RateTiers))
      .catch(() => undefined);
  }, []);
  // 两侧映射齐了就认定一次辅助列联动。触发键只认「数据源＋两侧辅助核算
  // 明细映射」：其余角色（金额/币种/日期等）的调整沿用既有联动结论，
  // 不再整表重读——与汇兑损益、FA TBJE 同一口径。
  const auxLinkKey = tb && je
    ? JSON.stringify({
        tb: [tbPath, tb.sheet, tb.headerRow, tb.headerDepth, tbMapping.auxiliary ?? null],
        je: [jePath, je.sheet, je.headerRow, je.headerDepth, jeMapping.auxiliary ?? null],
      })
    : null;
  useEffect(() => {
    if (!tb || !je || auxLinkKey === null) {
      setAuxLink(null);
      return;
    }
    setAuxLink(null);
    let cancelled = false;
    void verifyAuxiliaryLink({
      ...payload(),
      selectedAccounts: Object.entries(accountRoles)
        .filter(([, role]) =>
          ["deposit", "other_monetary", "cash_on_hand"].includes(role),
        )
        .map(([account]) => ({ account })),
    }).then((result) => {
      if (cancelled) return;
      setAuxLink(result);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auxLinkKey]);
  // 测算前行清单（含分币种拆行与引擎行键）：身份输入一变就重取，
  // 键与测算结果行一致，第二步的逐行利率与第三步逐户改价共用同一键空间。
  const accountCurrencyKey = tb
    ? JSON.stringify({
        tb: [tbPath, tb.sheet, tb.headerRow, tb.headerDepth, tbMapping],
        je: [jePath, je?.sheet ?? "", je?.headerRow ?? 0, je?.headerDepth ?? 0, jeMapping],
        roles: [accountRoles, accountRoleOverrides, accountDetailRoleOverrides],
        currencyFallbackMode,
        entityScope: entityScope.selection,
      })
    : null;
  useEffect(() => {
    if (accountCurrencyKey === null) {
      setAccountCurrencyRows([]);
      return;
    }
    let cancelled = false;
    void engineCall("deposit.account_currencies", payload())
      .then((x) => {
        if (cancelled) return;
        const list = (x as { rows?: typeof accountCurrencyRows }).rows;
        setAccountCurrencyRows(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setAccountCurrencyRows([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountCurrencyKey]);
  useEffect(() => {
    resetCurrencyFallback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityScope.selection]);
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
  // 历史参数不含预览表头/行数，不能伪装成完整 Inspection 给映射面板渲染；
  // 恢复时按存档 Sheet/标题行重新识别，存档的最终科目分类仍由 overrides 采纳。
  // restoredDepositRef：用户重新识别同一文件时，applyInspection 默认套用
  // 建议映射并清空分类覆盖——这里把存档值顶回，逐侧一次性消费。
  const restoredDepositRef = useRef<{
    sides: {
      je?: { path: string; mapping: Record<string, string | string[]> };
      tb?: { path: string; mapping: Record<string, string | string[]> };
    };
    accountRoleOverrides?: Record<string, string>;
  } | null>(null);
  const restoreGeneration = useRef(0);
  const catalogRefreshGeneration = useRef({ tb: 0, je: 0 });
  useTaskRestore(tool.id, (restore) => {
    const generation = ++restoreGeneration.current;
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
      accountDetailRoleOverrides?: Record<string, string>;
      accountDetailTierOverrides?: Record<string, string>;
      rateOverrides?: Record<string, { tier?: string; annualRate?: number }>;
      accountRateOverrides?: Record<string, number>;
      tierRates?: Record<string, number>;
      creditBalancePolicy?: "include";
      currencyFallbackMode?: CurrencyFallbackMode;
      outputPath?: string;
    };
    const restoredJePath =
      typeof p.jeSource?.inputPath === "string" ? p.jeSource.inputPath : "";
    const restoredTbPath =
      typeof p.tbSource?.inputPath === "string" ? p.tbSource.inputPath : "";
    if (!restoredJePath && !restoredTbPath) return;
    const isMapping = (
      value: unknown,
    ): value is Record<string, string | string[]> =>
      Boolean(value && typeof value === "object");
    restoredDepositRef.current = {
      sides: {
        ...(restoredJePath
          ? {
              je: {
                path: restoredJePath,
                mapping: isMapping(p.jeMapping) ? p.jeMapping : {},
              },
            }
          : {}),
        ...(restoredTbPath
          ? {
              tb: {
                path: restoredTbPath,
                mapping: isMapping(p.tbMapping) ? p.tbMapping : {},
              },
            }
          : {}),
      },
      ...(isMapping(p.accountRoles)
        ? { accountRoleOverrides: p.accountRoles }
        : {}),
    };
    setJePath(restoredJePath);
    setTbPath(restoredTbPath);
    setJe(undefined);
    setTb(undefined);
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
    setAccountDetailRoleOverrides(
      p.accountDetailRoleOverrides &&
        typeof p.accountDetailRoleOverrides === "object"
        ? p.accountDetailRoleOverrides
        : {},
    );
    setAccountDetailTierOverrides(
      p.accountDetailTierOverrides &&
        typeof p.accountDetailTierOverrides === "object"
        ? p.accountDetailTierOverrides
        : {},
    );
    setRateOverrides(
      p.rateOverrides && typeof p.rateOverrides === "object"
        ? p.rateOverrides
        : {},
    );
    setAccountRateOverrides(
      p.accountRateOverrides && typeof p.accountRateOverrides === "object"
        ? Object.fromEntries(
            Object.entries(p.accountRateOverrides).filter(
              ([, value]) => typeof value === "number" && Number.isFinite(value),
            ),
          )
        : {},
    );
    if (p.tierRates && typeof p.tierRates === "object")
      setTierRates(p.tierRates);
    setCreditBalancePolicy(p.creditBalancePolicy === "include" ? "include" : "");
    setCurrencyFallbackMode(
      p.currencyFallbackMode === "functional" ||
        p.currencyFallbackMode === "twoPointByCurrency"
        ? p.currencyFallbackMode
        : "",
    );
    setOutputPath(typeof p.outputPath === "string" ? p.outputPath : "");
    setStep(0);
    setBusy(true);
    setError("");
    setResult(undefined);
    setRows([]);
    setJob(undefined);
    setSourceStatus("正在重新识别历史任务的源文件…");
    void (async () => {
      const failures: string[] = [];
      for (const [kind, path, source] of [
        ["tb", restoredTbPath, p.tbSource],
        ["je", restoredJePath, p.jeSource],
      ] as const) {
        if (!path || !source) continue;
        try {
          const response = (await engineCall(`deposit.inspect_${kind}`, {
            source: {
              inputPath: path,
              sheet: source.sheet ?? "",
              headerRow: source.headerRow ?? 0,
              headerDepth: source.headerDepth ?? 0,
            },
            // 历史任务保存的是用户最终确认的映射；目录也必须按这份映射
            // 重建，不能继续沿用初次自动识别时可能为空的科目列。
            mapping: kind === "tb" ? (p.tbMapping ?? {}) : (p.jeMapping ?? {}),
          })) as Inspection;
          if (generation !== restoreGeneration.current) return;
          applyInspection(kind, path, response);
        } catch (e) {
          if (generation !== restoreGeneration.current) return;
          failures.push(`${fileName(path)}：${errorText(e)}`);
        }
      }
      if (generation !== restoreGeneration.current) return;
      if (typeof p.reportEnd === "string" && p.reportEnd)
        setReportEnd(p.reportEnd);
      setCurrencyFallbackMode(
        p.currencyFallbackMode === "functional" ||
          p.currencyFallbackMode === "twoPointByCurrency"
          ? p.currencyFallbackMode
          : "",
      );
      setError(failures.join("；"));
      setSourceStatus(
        failures.length
          ? "历史任务部分源文件未能重新识别。"
          : "历史任务源文件已重新识别，请复核映射后继续。",
      );
      setBusy(false);
    })();
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
        // 贷方余额账户：本次任务按默认口径跑完才提示；已选纳入的不重复弹。
        const summary = next.summary as
          | { creditBalanceCount?: number }
          | undefined;
        if (
          Number(summary?.creditBalanceCount ?? 0) > 0 &&
          creditPolicyAtRunRef.current !== "include"
        )
          setCreditDialogOpen(true);
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
    resetCurrencyFallback();
    ++restoreGeneration.current;
    // 新来源开始识别时，上一批文件产生的复核、测算和手工覆盖全部失效。
    // 利率档位字典属于工具长期配置，保留；逐账户选择属于文件派生状态，清空。
    reviews.clearReview("tb");
    reviews.clearReview("je");
    // 公共入口代表重新选择整组；单侧补传走下方空卡片，不混用两种语义。
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
    setAccountRateOverrides({});
    currencyCheckRef.current = { key: "", check: null };
    setAccountCurrencyRows([]);
    setCreditBalancePolicy("");
    setCreditDialogOpen(false);
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
    catalogRefreshGeneration.current[kind] += 1;
    resetCurrencyFallback();
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
    setAccountRoleOverrides(match ? (stash?.accountRoleOverrides ?? {}) : {});
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

  /**
   * 字段复核／人工修订可能补上最初未识别出的科目编码、名称或主体列。
   * inspect 的 accounts/accountsLeaf 是映射派生数据，因此只改 mapping state
   * 会留下旧目录。这里按确认后的映射重读元数据，但不重置用户映射、复核状态
   * 和其他页面状态；对象身份守卫同时避免换文件后的慢请求覆盖新来源。
   */
  async function refreshAccountCatalog(
    kind: Kind,
    mapping: Record<string, string | string[]>,
  ) {
    const current = kind === "tb" ? tb : je;
    const path = kind === "tb" ? tbPath : jePath;
    if (!current || !path) return;
    const generation = ++catalogRefreshGeneration.current[kind];
    try {
      const response = (await engineCall(`deposit.inspect_${kind}`, {
        source: {
          inputPath: path,
          sheet: current.sheet,
          headerRow: current.headerRow,
          headerDepth: current.headerDepth,
        },
        mapping,
      })) as Inspection;
      if (catalogRefreshGeneration.current[kind] !== generation) return;
      if (kind === "tb") {
        setTb((latest) => (latest === current ? response : latest));
      } else {
        setJe((latest) => (latest === current ? response : latest));
      }
    } catch (e) {
      if (catalogRefreshGeneration.current[kind] !== generation) return;
      setError(`字段映射已更新，但科目清单刷新失败：${errorText(e)}`);
    }
  }

  function updateMapping(
    kind: Kind,
    mapping: Record<string, string | string[]>,
  ) {
    resetCurrencyFallback();
    const current = kind === "tb" ? tbMapping : jeMapping;
    if (kind === "tb") setTbMapping(mapping);
    else setJeMapping(mapping);
    if (
      depositCatalogMappingKey(current) !== depositCatalogMappingKey(mapping)
    ) {
      void refreshAccountCatalog(kind, mapping);
    }
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
  async function replaceSource(kind: Kind) {
    const picked = await pickPath(
      "file",
      kind === "tb" ? "更换 TB 科目余额表" : "更换 JE 序时账",
      ["xlsx", "xls", "xlsm", "csv"],
    );
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    ++restoreGeneration.current;
    reviews.clearReview(kind);
    setBusy(true);
    setError("");
    setSourceStatus(`正在按 ${kind.toUpperCase()} 读取 ${fileName(path)}…`);
    try {
      const response = (await engineCall(`deposit.inspect_${kind}`, {
        source: { inputPath: path, sheet: "", headerRow: 0, headerDepth: 0 },
      })) as Inspection;
      applyInspection(kind, path, response);
      setSourceStatus(
        `${kind.toUpperCase()} 已更换为 ${fileName(path)} / ${response.sheet}。`,
      );
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

  function payload(creditPolicy: "" | "include" = creditBalancePolicy) {
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
      accountDetailRoleOverrides,
      accountDetailTierOverrides,
      rateOverrides,
      accountRateOverrides,
      tierRates,
      ...(currencyFallbackMode ? { currencyFallbackMode } : {}),
      ...(creditPolicy ? { creditBalancePolicy: creditPolicy } : {}),
      entityScope: entityScope.selection,
      ...(outputPath ? { outputPath } : {}),
    };
  }
  // 币种衔接验证只跟这些输入有关：输入没变就复用上次结论，
  // 导航栏来回切步骤不再重跑验证（重跑只在底部“下一步”或首次进入时发生一次）。
  const currencyCheckRef = useRef<{
    key: string;
    check: CurrencyLinkResult | null;
  }>({ key: "", check: null });
  function currencyCheckKey() {
    return JSON.stringify([
      tbPath,
      tb?.sheet,
      tb?.headerRow,
      tb?.headerDepth,
      tbMapping,
      jePath,
      je?.sheet,
      je?.headerRow,
      je?.headerDepth,
      jeMapping,
      accountRoles,
      accountRoleOverrides,
      entityScope.selection,
    ]);
  }
  async function advanceToConfirmation() {
    const key = currencyCheckKey();
    const cached =
      currencyCheckRef.current.key === key
        ? currencyCheckRef.current.check
        : null;
    // 已验证通过（或用户已选定多币种口径）时，直接进第二步，不再调用引擎。
    if (
      cached &&
      (currencyFallbackMode || !(cached.required && !cached.verified))
    ) {
      setStep(1);
      return;
    }
    if (!je || !jePath || !tb || !tbMapping.currency) {
      setStep(1);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const check = await verifyCurrencyLink({
        ...payload(),
        selectedAccounts: depositAccounts.map((account) => ({ account })),
      });
      if (!check) {
        setError("暂时无法验证 TB 与 JE 的外币币种对应关系，请稍后重试。");
        return;
      }
      currencyCheckRef.current = { key, check };
      setCurrencyLink(check);
      if (check.required && !check.verified) {
        setCurrencyDialogOpen(true);
        return;
      }
      setCurrencyFallbackMode("");
      setStep(1);
    } finally {
      setBusy(false);
    }
  }
  async function run(
    method: "deposit.preview" | "deposit.export",
    // 弹窗确认后立即按新口径重算：状态更新是异步的，口径必须显式传参。
    creditPolicy: "" | "include" = creditBalancePolicy,
  ) {
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
      creditPolicyAtRunRef.current = creditPolicy;
      lastRunMethod.current = method;
      activeJob.current = await jobStart(method, payload(creditPolicy));
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
    }
  }
  /** 第二步逐户利率：清空即回到该户当前档位的默认利率。 */
  function commitAccountRate(key: string, text: string) {
    const rate = depositPercentToRate(text);
    setAccountRateOverrides((current) => {
      const next = { ...current };
      if (Number.isFinite(rate)) next[key] = rate;
      else delete next[key];
      return next;
    });
  }
  function clearAccountRate(key: string) {
    setAccountRateOverrides((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }
  function overrideRow(
    key: string,
    next: { tier?: string; annualRate?: number },
  ) {
    setRateOverrides((current) => {
      const merged = { ...current[key], ...next };
      // 只换档位时丢掉旧的手改利率，回落到新档位默认，
      // 与第二步「换类型自动跟默认利率」同一行为。
      if (next.tier && next.annualRate === undefined)
        delete merged.annualRate;
      return { ...current, [key]: merged };
    });
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
                    ? "挂牌暂估值"
                    : "自定义档位利率"
                : row.rateSource,
          rateProvisional:
            next.annualRate !== undefined
              ? false
              : next.tier
                ? tierRate !== undefined && tierRates[tier] === undefined
                : row.rateProvisional,
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
  // 贷方余额账户清单：引擎在测算汇总里下发，弹窗据此点名。
  const creditBalanceAccounts = useMemo(() => {
    const list = (
      result?.summary as
        | { creditBalanceAccounts?: CreditBalanceAccount[] }
        | undefined
    )?.creditBalanceAccounts;
    return Array.isArray(list) ? list : [];
  }, [result]);
  const reviewTier = (row: DepositAccountReviewRow) =>
    accountDetailTierOverrides[row.key] ?? accountTier(row.account);
  const accountCategory = (account: string, tier = accountTier(account)) =>
    tiers?.tiers.find((item) => item.key === tier)?.category ?? "demand";
  // 多主体账套才显示“主体”列；单主体保持原布局（与 TBJE 系确认表同口径）。
  const entitySet = useMemo(
    () =>
      new Set(
        [...(tb?.entities ?? []), ...(je?.entities ?? [])].filter(
          (entity) => entity && entity !== "默认主体",
        ),
      ),
    [tb?.entities, je?.entities],
  );
  const multiEntity = entitySet.size > 1;
  // 引擎下发的测算行按科目编码归组，确认表据此按币种（或主体）拆行展示。
  const engineRowsByCode = useMemo(() => {
    const map = new Map<string, typeof accountCurrencyRows>();
    for (const item of accountCurrencyRows) {
      const code = depositAccountCode(item.account);
      const list = map.get(code);
      if (list) list.push(item);
      else map.set(code, [item]);
    }
    return map;
  }, [accountCurrencyRows]);
  /** 确认表行对应的引擎测算行：键与测算结果一致，利率改写直接落到这些键上。
      无辅助明细的确认行匹配未分辅助的引擎行；明细行按辅助值匹配（合并行
      的辅助以「；」连接，任一段命中即可）。 */
  function engineVariantsOf(row: DepositAccountReviewRow) {
    const candidates =
      engineRowsByCode.get(depositAccountCode(row.account)) ?? [];
    return candidates.filter((item) => {
      if (row.auxiliaryKey) {
        if (
          row.entity &&
          item.entity !== row.entity &&
          item.entity !== "默认主体"
        )
          return false;
        return item.auxiliary.split("；").includes(row.auxiliary ?? "");
      }
      return item.auxiliary === "";
    });
  }
  /** 引擎行键上的逐户利率（第三步改价与第二步同键，天然联动）。 */
  const engineRateOf = (key: string) => {
    const rate = rateOverrides[key]?.annualRate;
    return Number.isFinite(rate) ? rate : undefined;
  };
  /** 换存款类型时把该户各币种行的手改利率一并清掉，全部回到新档位默认。 */
  function clearEngineRates(keys: string[]) {
    if (!keys.length) return;
    setRateOverrides((current) => {
      const next = { ...current };
      for (const key of keys) {
        const entry = next[key];
        if (!entry) continue;
        if (entry.tier === undefined) delete next[key];
        else next[key] = { tier: entry.tier };
      }
      return next;
    });
  }

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
        onStepClick={(next) => {
          if (next === 1 && step === 0) void advanceToConfirmation();
          else setStep(next);
        }}
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
              <div className="fx-source-requirements" aria-label="所需审计资料">
                <strong>当前测算所需资料</strong>
                <span className={jePath ? "ready" : "optional"}>
                  JE 序时账{jePath ? "（已添加）" : "（可选）"}
                </span>
                <span className={tbPath ? "ready" : "required"}>
                  TB 科目余额表{tbPath ? "（已添加）" : "（必需）"}
                </span>
              </div>
              <FileDropInput
                containerRef={uploadDropRef}
                value={jePath || tbPath}
                displayValue={[
                  jePath && `JE：${fileName(jePath)}${je?.sheet ? ` / ${je.sheet}` : ""}`,
                  tbPath && `TB：${fileName(tbPath)}${tb?.sheet ? ` / ${tb.sheet}` : ""}`,
                ]
                  .filter(Boolean)
                  .join("；")}
                hideFilledLabel
                disabled={busy}
                placeholder="拖放或选择 TB、序时账文件（可同时选择）"
                onBrowse={() => void browse()}
                onDragStateChange={() => {}}
                onClear={() => {
                  resetCurrencyFallback();
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
                  description="TB 为必传资料；JE 选传，用于更准确地还原月度余额。"
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
                  onReplace={() => void replaceSource("je")}
                  onClear={() => {
                    resetCurrencyFallback();
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
                    <Button
                      type="button"
                      variant="secondary"
                      className="fx-side-upload"
                      disabled={busy}
                      onClick={() => void replaceSource("je")}
                    >
                      补充上传 JE
                    </Button>
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
                  onReplace={() => void replaceSource("tb")}
                  onClear={() => {
                    resetCurrencyFallback();
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
                      description="TB 是测算与账面利息勾稽的必需资料。"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      className="fx-side-upload"
                      disabled={busy}
                      onClick={() => void replaceSource("tb")}
                    >
                      补充上传 TB
                    </Button>
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
              // 自动复核只针对一组完整的 TB＋JE。删除任一侧后 key 立即清空，
              // 不会因为 present 从双侧变成单侧而误启动一次新的 LLM 复核。
              autoReviewKey={
                !busy && tb && je
                  ? JSON.stringify([
                      [tbPath, tb.sheet, tb.headerRow, tb.headerDepth],
                      [jePath, je.sheet, je.headerRow, je.headerDepth],
                    ])
                  : ""
              }
              autoReviewOwner={ledgerReviewOwner.current}
              onReviewAll={() =>
                void reviews.reviewAll({
                  tb: tb
                    ? {
                        headers: tb.headers,
                        preview: tb.preview,
                        mapping: tbMapping,
                        labels: resolveRoleLabels(tb.roles, TB_LABELS),
                        tool: "deposit_interest",
                        onApplied: (mapping) => updateMapping("tb", mapping),
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
                        onApplied: (mapping) => updateMapping("je", mapping),
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
                  <>
                    {(reviews.reviewing.tb || reviews.status.tb) && (
                      <p aria-live="polite" className="fx-hint">
                        {reviews.reviewing.tb
                          ? "正在复核字段映射；复核期间暂时锁定。"
                          : reviews.status.tb}
                      </p>
                    )}
                  </>
                }
                onMappingChange={(mapping) => {
                  updateMapping(
                    "tb",
                    typeof mapping === "function"
                      ? mapping(tbMapping)
                      : mapping,
                  );
                }}
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
                  <>
                    {(reviews.reviewing.je || reviews.status.je) && (
                      <p aria-live="polite" className="fx-hint">
                        {reviews.reviewing.je
                          ? "正在复核字段映射；复核期间暂时锁定。"
                          : reviews.status.je}
                      </p>
                    )}
                  </>
                }
                onMappingChange={(mapping) => {
                  updateMapping(
                    "je",
                    typeof mapping === "function"
                      ? mapping(jeMapping)
                      : mapping,
                  );
                }}
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
            <Button
              disabled={!tb || busy}
              onClick={() => void advanceToConfirmation()}
            >
              下一步：科目与利率确认
            </Button>
          </div>
        </>
      )}
      {step === 1 && (
        <>
          {currencyFallbackMode && (
            <section className="deposit-currency-mode" role="status">
              <span>
                多币种口径：
                <b>
                  {currencyFallbackMode === "functional"
                    ? "统一使用本位币匡算"
                    : "按币种使用年初、年末平均值"}
                </b>
              </span>
              <Button
                variant="secondary"
                onClick={() => setCurrencyDialogOpen(true)}
              >
                更改口径
              </Button>
            </section>
          )}
          {accounts.length > 0 && (
            <Card>
              <CardHeader>
                <div className="deposit-confirm-heading">
                  <div>
                    <span className="deposit-section-kicker">第 1 项</span>
                    <CardTitle>科目分类与存款类型</CardTitle>
                  </div>
                  <div className="deposit-account-summary">
                    <Badge variant="secondary">
                      计息科目 {depositAccounts.length}
                    </Badge>
                    <Badge variant="secondary">
                      利息收入 {interestAccounts.length}
                    </Badge>
                    <HelpTip text="清单只列末级科目，层级判定与公共引擎同一口径；TB 带辅助核算且通过验证时按辅助户拆行。利息收入是 TB 比较基准；未设置时仍可测算，但不能勾稽。存款类型关联下方利率档位，名称无法判断时默认活期；利率列默认带出该类型的挂牌利率，可直接改写。" />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <details open>
                  <summary>逐个核对科目分类（末级明细）</summary>
                  <KeywordFilter
                    value={accountFilter}
                    onChange={setAccountFilter}
                    ariaLabel="筛选科目"
                    placeholder="输入科目编码、名称或辅助核算关键词，即时过滤（多个词用空格分隔）"
                    matched={visibleAccounts.length}
                    total={reviewAccounts.length}
                  />
                  <div className="deposit-account-list">
                    <table className={multiEntity ? "deposit-multi-entity" : undefined}>
                      <thead>
                        <tr>
                          {multiEntity && <th>主体</th>}
                          <th>科目</th>
                          <th>分类</th>
                          <th>存款类型</th>
                          <th>
                            利率（%）
                            <HelpTip text="默认带出所选存款类型的挂牌利率（在下方档位表改写过的用改写值）；可直接改写为协议利率。改写后切换存款类型，会自动回到新类型的默认利率。多币种账户按币种拆行，可分别填写各币种利率；与第三步的逐户改价同键联动。" />
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {renderedAccounts.flatMap((row) => {
                          const tierMeta = tiers?.tiers.find(
                            (item) => item.key === reviewTier(row),
                          );
                          const manualRate = accountRateOverrides[row.key];
                          const tierRate = depositEffectiveTierRate(
                            tierMeta,
                            tierRates,
                          );
                          const effectiveRate = Number.isFinite(manualRate)
                            ? manualRate
                            : tierRate;
                          const isDepositRow = ["deposit", "other_monetary"].includes(
                            reviewRole(row),
                          );
                          const variants = engineVariantsOf(row);
                          // 引擎行按币种（多主体时含主体）拆成多行；没有引擎
                          // 行的（旧后端／仅在序时账出现）保持科目整行一条。
                          const lines = variants.length > 0 ? variants : [null];
                          return lines.map((variant, index) => {
                            const currency =
                              variant && lines.length > 1
                                ? `（${variant.currency}）`
                                : "";
                            const rate = variant
                              ? (engineRateOf(variant.key) ?? effectiveRate)
                              : effectiveRate;
                            return (
                          <tr
                            key={variant ? variant.key : row.key}
                            className={index > 0 ? "deposit-account-sub" : undefined}
                          >
                            {multiEntity && (
                              <td>
                                {variant
                                  ? variant.entity === "默认主体"
                                    ? "未区分主体"
                                    : variant.entity
                                  : (row.entity ?? "—")}
                              </td>
                            )}
                            {index === 0 ? (
                              <td
                                title={`${row.account}${row.auxiliary ? ` / ${row.auxiliary}` : ""}`}
                              >
                                {row.account}
                                {row.auxiliary
                                  ? ` · ${row.entity ? `${row.entity} / ` : ""}${row.auxiliary}`
                                  : ""}
                                {currency}
                              </td>
                            ) : (
                              <td className="deposit-account-continuation">
                                {currency}
                              </td>
                            )}
                            {index === 0 ? (
                              <td>
                                <select
                                  className="deposit-account-role"
                                  aria-label={`${row.account}${row.auxiliary ? ` ${row.auxiliary}` : ""}的分类`}
                                  value={
                                    row.auxiliaryKey
                                      ? (accountDetailRoleOverrides[row.key] ??
                                        "")
                                      : (accountRoleOverrides[row.account] ?? "")
                                  }
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    const setter = row.auxiliaryKey
                                      ? setAccountDetailRoleOverrides
                                      : setAccountRoleOverrides;
                                    setter((current) => {
                                      const next = { ...current };
                                      if (value) next[row.key] = value;
                                      else delete next[row.key];
                                      return next;
                                    });
                                  }}
                                >
                                  <option value="">
                                    {
                                      ROLE_OPTIONS.find(
                                        ([role]) =>
                                          role ===
                                          (tb?.suggestedAccountRoles?.[
                                            row.account
                                          ] ??
                                            je?.suggestedAccountRoles?.[
                                              row.account
                                            ] ??
                                            "excluded"),
                                      )?.[1]
                                    }
                                  </option>
                                  {ROLE_OPTIONS.map(([value, label]) => (
                                    <option key={value} value={value}>
                                      {label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            ) : (
                              <td />
                            )}
                            {isDepositRow ? (
                              <>
                                {index === 0 ? (
                                  <td>
                                    <div className="deposit-account-tier">
                                      <select
                                        className="deposit-account-category"
                                        aria-label={`${row.account}${row.auxiliary ? ` ${row.auxiliary}` : ""}的存款类型`}
                                        value={accountCategory(
                                          row.account,
                                          reviewTier(row),
                                        )}
                                        onChange={(e) => {
                                          (
                                            row.auxiliaryKey
                                              ? setAccountDetailTierOverrides
                                              : setAccountTierOverrides
                                          )((current) => ({
                                            ...current,
                                            [row.key]: depositFirstTierOf(
                                              tiers,
                                              e.target.value,
                                            ),
                                          }));
                                          // 换了类型就回到新档位的默认利率，
                                          // 避免旧类型的手改利率悄悄跟着过去。
                                          clearAccountRate(row.key);
                                          clearEngineRates(
                                            variants.map((item) => item.key),
                                          );
                                        }}
                                      >
                                        {(tiers?.categories ?? []).map(
                                          (category) => (
                                            <option
                                              key={category.key}
                                              value={category.key}
                                            >
                                              {category.label}
                                            </option>
                                          ),
                                        )}
                                      </select>
                                      {depositTermsOf(
                                        tiers,
                                        accountCategory(
                                          row.account,
                                          reviewTier(row),
                                        ),
                                      ).length > 0 && (
                                        <select
                                          className="deposit-account-term"
                                          aria-label={`${row.account}${row.auxiliary ? ` ${row.auxiliary}` : ""}的存款期限`}
                                          value={reviewTier(row)}
                                          onChange={(e) => {
                                            (
                                              row.auxiliaryKey
                                                ? setAccountDetailTierOverrides
                                                : setAccountTierOverrides
                                            )((current) => ({
                                              ...current,
                                              [row.key]: e.target.value,
                                            }));
                                            clearAccountRate(row.key);
                                            clearEngineRates(
                                              variants.map((item) => item.key),
                                            );
                                          }}
                                        >
                                          {depositTermsOf(
                                            tiers,
                                            accountCategory(
                                              row.account,
                                              reviewTier(row),
                                            ),
                                          ).map((term) => (
                                            <option
                                              key={term.key}
                                              value={term.key}
                                            >
                                              {term.label}
                                            </option>
                                          ))}
                                        </select>
                                      )}
                                    </div>
                                  </td>
                                ) : (
                                  <td />
                                )}
                                <td>
                                  <span className="deposit-pct">
                                    <NumberInput
                                      label={`${row.account}${row.auxiliary ? ` ${row.auxiliary}` : ""}${currency}的年利率`}
                                      step="0.01"
                                      min="0"
                                      max="20"
                                      className={
                                        rate === undefined
                                          ? "deposit-rate-missing"
                                          : undefined
                                      }
                                      value={depositRateToPercent(rate)}
                                      placeholder="需填"
                                      onCommit={(text) =>
                                        variant
                                          ? overrideRow(variant.key, {
                                              annualRate:
                                                depositPercentToRate(text),
                                            })
                                          : commitAccountRate(row.key, text)
                                      }
                                    />
                                    <b>%</b>
                                  </span>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="deposit-account-na">不适用</td>
                                <td className="deposit-account-na">不适用</td>
                              </>
                            )}
                          </tr>
                            );
                          });
                        })}
                      </tbody>
                    </table>
                  </div>
                  {renderedAccounts.length < visibleAccounts.length && (
                    <div className="deposit-account-more">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          setAccountReviewLimit(
                            (current) => current + ACCOUNT_REVIEW_PAGE_SIZE,
                          )
                        }
                      >
                        继续显示（已显示 {renderedAccounts.length} /{" "}
                        {visibleAccounts.length}）
                      </Button>
                    </div>
                  )}
                  {reviewAccounts.length > 0 &&
                    visibleAccounts.length === 0 && (
                      <p className="fx-hint">
                        没有匹配「{accountFilter.trim()}」的科目。
                      </p>
                    )}
                  <AccountConfirmationActions
                    tool="deposit"
                    title="存款利息"
                    context={JSON.stringify([tbPath, jePath, tbMapping, jeMapping, reviewAccounts.map((row) => row.key)])}
                    columns={[
                      { key: "account", title: "科目" },
                      { key: "role", title: "分类", editable: true, options: ROLE_OPTIONS.map(([, label]) => label) },
                      { key: "category", title: "存款类型", editable: true, options: (tiers?.categories ?? []).map((category) => category.label) },
                      { key: "term", title: "存款期限", editable: true, options: [...new Set((tiers?.tiers ?? []).map((tier) => tier.termLabel))] },
                      { key: "rate", title: "利率（%）", editable: true },
                    ]}
                    rows={reviewAccounts.map((row) => {
                      const tier = (tiers?.tiers ?? []).find((item) => item.key === reviewTier(row));
                      const manualRate = accountRateOverrides[row.key];
                      const effectiveRate = Number.isFinite(manualRate)
                        ? manualRate
                        : depositEffectiveTierRate(tier, tierRates);
                      const isRateRow = ["deposit", "other_monetary"].includes(reviewRole(row));
                      return { key: row.key, values: [
                        `${row.account}${row.auxiliary ? ` · ${row.entity ? `${row.entity} / ` : ""}${row.auxiliary}` : ""}`,
                        ROLE_OPTIONS.find(([key]) => key === reviewRole(row))?.[1] ?? "",
                        (tiers?.categories ?? []).find((item) => item.key === tier?.category)?.label ?? "",
                        tier?.termLabel ?? "",
                        isRateRow ? depositRateToPercent(effectiveRate) : "",
                      ] };
                    })}
                    onImport={(changed) => {
                      const byKey = new Map(reviewAccounts.map((row) => [row.key, row]));
                      const roleUpdates: Record<string, string> = {};
                      const tierUpdates: Record<string, string> = {};
                      const rateUpdates: Record<string, number | undefined> = {};
                      for (const item of changed) {
                        const row = byKey.get(item.key)!;
                        const role = ROLE_OPTIONS.find(([, label]) => label === item.values[1])?.[0];
                        if (!role) throw new Error(`${row.account}：请选择有效的科目分类。`);
                        roleUpdates[row.key] = role;
                        if (role === "deposit" || role === "other_monetary") {
                          const category = tiers?.categories.find((value) => value.label === item.values[2]);
                          const tier = tiers?.tiers.find((value) => value.category === category?.key && value.termLabel === item.values[3]);
                          if (!tier) throw new Error(`${row.account}：存款类型与期限不匹配。`);
                          tierUpdates[row.key] = tier.key;
                          // 利率留空＝回到档位默认；填了就按百分比换算成小数。
                          const rate = depositPercentToRate(item.values[4] ?? "");
                          if (item.values[4] && item.values[4].trim() !== "") {
                            if (!Number.isFinite(rate))
                              throw new Error(`${row.account}：年利率须填写数字百分比。`);
                            rateUpdates[row.key] = rate;
                          } else {
                            rateUpdates[row.key] = undefined;
                          }
                        } else {
                          rateUpdates[row.key] = undefined;
                        }
                      }
                      setAccountRoleOverrides((current) => ({ ...current, ...Object.fromEntries(Object.entries(roleUpdates).filter(([key]) => !byKey.get(key)?.auxiliaryKey)) }));
                      setAccountDetailRoleOverrides((current) => ({ ...current, ...Object.fromEntries(Object.entries(roleUpdates).filter(([key]) => byKey.get(key)?.auxiliaryKey)) }));
                      setAccountTierOverrides((current) => ({ ...current, ...Object.fromEntries(Object.entries(tierUpdates).filter(([key]) => !byKey.get(key)?.auxiliaryKey)) }));
                      setAccountDetailTierOverrides((current) => ({ ...current, ...Object.fromEntries(Object.entries(tierUpdates).filter(([key]) => byKey.get(key)?.auxiliaryKey)) }));
                      setAccountRateOverrides((current) => {
                        const next = { ...current };
                        for (const [key, rate] of Object.entries(rateUpdates)) {
                          if (typeof rate === "number" && Number.isFinite(rate))
                            next[key] = rate;
                          else delete next[key];
                        }
                        return next;
                      });
                    }}
                  />
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
          {entityScope.panel}
          <Card>
            <CardHeader>
              <CardTitle>
                测算与底稿
                <HelpTip text="利率可在第二步「科目与利率确认」逐户维护，也可在本表直接改写，两处联动、取同一口径。来源为「挂牌暂估值」表示系统按内置挂牌利率暂估，请按协议或对账单确认；手工指定的利率以实际填写为准。未取得对应 JE 时，全年平均余额直接按（期初＋期末）÷2 暂估。" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              {currencyFallbackMode && (
                <section className="deposit-currency-mode" role="status">
                  <span>
                    多币种口径：
                    <b>
                      {currencyFallbackMode === "functional"
                        ? "统一使用本位币匡算"
                        : "按币种使用年初、年末平均值"}
                    </b>
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() => setCurrencyDialogOpen(true)}
                  >
                    更改口径
                  </Button>
                </section>
              )}
              <div className="deposit-run-grid">
                <label>
                  资产负债表日
                  <DateInput value={reportEnd} onChange={setReportEnd} />
                </label>
                <label>
                  输出文件
                  <span className="deposit-output-row">
                    <Input
                      value={displayFileName(outputPath)}
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
              {((result?.outputPaths ?? []) as string[]).length > 0 && (
                <div className="deposit-export-done">
                  <p>
                    导出的 Excel
                    中，「测算汇总」黄色“年利率”单元格可直接改写；月度利息、测算利息合计及与
                    TB 的勾稽差异会即时重算。
                  </p>
                  {((result?.outputPaths ?? []) as string[]).map((path) => (
                    <Button
                      key={path}
                      variant="secondary"
                      onClick={() => void openOutput(path)}
                    >
                      打开 Excel 底稿
                    </Button>
                  ))}
                </div>
              )}
              {creditBalancePolicy === "include" && (
                <p className="deposit-credit-policy">
                  已按你的选择把贷方余额账户纳入测算，其负余额会抵减测算利息合计。
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setCreditBalancePolicy("");
                      void run(lastRunMethod.current, "");
                    }}
                  >
                    改回不纳入并重算
                  </Button>
                </p>
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

          {rows.length > 0 && (
            <AccountConfirmationActions
              tool="deposit"
              title="存款账户利率"
              context={JSON.stringify([tbPath, jePath, tbMapping, jeMapping, rows.map((row) => row.key), "account-rates"])}
              columns={[
                { key: "entity", title: "主体" },
                { key: "account", title: "银行账户／科目" },
                { key: "currency", title: "币种" },
                { key: "tier", title: "存款档位" },
                { key: "annualRate", title: "年利率（%）", editable: true },
              ]}
              rows={rows.map((row) => ({ key: row.key, values: [
                row.entity, row.account, row.currency, row.tierLabel,
                row.rateResolved ? String(depositRateToPercent(row.annualRate)) : "",
              ] }))}
              disabled={busy}
              onImport={(changed) => {
                const updates = new Map(changed.map((item) => {
                  const value = Number(item.values[4]);
                  if (!item.values[4] || !Number.isFinite(value))
                    throw new Error(`${item.values[1]}：年利率须填写数字百分比。`);
                  return [item.key, depositPercentToRate(item.values[4])] as const;
                }));
                setRateOverrides((current) => {
                  const next = { ...current };
                  for (const [key, annualRate] of updates)
                    next[key] = { ...next[key], annualRate };
                  return next;
                });
                setRows((current) => current.map((row) => updates.has(row.key)
                  ? { ...row, annualRate: updates.get(row.key)!, rateResolved: true, rateSource: "本账户手工指定", rateProvisional: false }
                  : row));
              }}
            />
          )}

          <div className="fx-step-actions">
            <Button variant="secondary" onClick={() => setStep(1)}>
              返回科目与利率确认
            </Button>
          </div>
        </>
      )}
      <CurrencyFallbackDialog
        open={currencyDialogOpen}
        affectedGroupCount={currencyLink?.affectedGroupCount ?? 0}
        missingCurrencies={currencyLink?.missingCurrencies ?? []}
        value={currencyFallbackMode}
        onChange={setCurrencyFallbackMode}
        onCancel={() => setCurrencyDialogOpen(false)}
        onContinue={() => {
          setCurrencyDialogOpen(false);
          setResult(undefined);
          setRows([]);
          setStep(1);
        }}
      />
      <CreditBalanceDialog
        open={creditDialogOpen && creditBalanceAccounts.length > 0}
        accounts={creditBalanceAccounts}
        onCancel={() => setCreditDialogOpen(false)}
        onInclude={() => {
          setCreditBalancePolicy("include");
          setCreditDialogOpen(false);
          void run(lastRunMethod.current, "include");
        }}
      />
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
          <div className="deposit-confirm-heading">
            <div>
              <span className="deposit-section-kicker">第 2 项</span>
              <CardTitle>存款利率档位</CardTitle>
            </div>
          </div>
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
        <div className="deposit-confirm-heading">
          <div>
            <span className="deposit-section-kicker">第 2 项</span>
            <CardTitle>存款利率档位</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent>
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
  onReplace: () => void;
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
          <button
            className="fx-file-name-button"
            type="button"
            title={`${props.path}（点击更换）`}
            disabled={props.disabled}
            onClick={props.onReplace}
          >
            {fileName(props.path)}
          </button>
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

export function Results({
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
  // 来源文案已统一，是否"系统预设暂估"看引擎标记位。
  const provisional = rows.filter((row) => row.rateProvisional === true);
  const auxiliaryWarnings = Array.isArray(summary.auxiliaryWarnings)
    ? summary.auxiliaryWarnings.map(String).filter(Boolean)
    : [];
  const stale =
    Math.abs(liveTotal - Number(summary.calculatedInterest ?? 0)) > 0.005;
  const jeCurrencyAllocationWarning = String(
    summary.jeCurrencyAllocationWarning ?? "",
  );
  const jeUncoveredEntities: string[] = Array.isArray(
    summary.jeUncoveredEntities,
  )
    ? summary.jeUncoveredEntities.map((item) => String(item)).filter(Boolean)
    : [];

  return (
    <section className="fx-result deposit-result">
      <div className="fx-result-heading">
        <div>
          <h3>
            存款利息测算结果
            <HelpTip
              text={`${
                String(summary.monthlySource ?? "").includes("两点法")
                  ? "两点法平均余额＝（期初余额＋期末余额）÷2，不推导月末余额"
                  : "序时账口径下，月均余额＝（月初余额＋月末余额）÷2"
              }；余额来源：${String(
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
      </div>

      <div className="deposit-result-overview" role="status">
        <Badge
          variant="outline"
          className={
            missing.length ||
            provisional.length ||
            stale ||
            !booked ||
            summary.reconciliationPassed !== true
              ? "badge-warning"
              : "badge-ready"
          }
        >
          {missing.length
            ? "测算未完整"
            : provisional.length
              ? "利率待确认"
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
            : provisional.length
              ? "暂估利率已纳入测算，请按协议或对账单确认。"
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
      {provisional.length > 0 && (
        <section className="deposit-notice" aria-label="暂估利率待确认">
          <h4>{provisional.length} 个账户已采用系统预设利率，请确认</h4>
        </section>
      )}
      {jeCurrencyAllocationWarning && (
        <p className="deposit-stale" role="alert">
          <b>JE 发生额无法按币种分配</b>
          <span>{jeCurrencyAllocationWarning}</span>
        </p>
      )}
      {auxiliaryWarnings.length > 0 && (
        <section className="deposit-notice" aria-label="辅助核算联动">
          <h4>辅助核算联动</h4>
          <p>以下账户未按辅助核算拆分，已按主体＋科目执行测算：</p>
          <ul>
            {auxiliaryWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
      {jeUncoveredEntities.length > 0 && (
        <p className="deposit-stale" role="alert">
          <b>序时账未覆盖核算主体</b>
          <span>
            序时账期间内没有匹配到主体
            {jeUncoveredEntities.join("、")}
            的任何发生额，这些主体的账户已直接按（期初＋期末）÷2
            暂估全年平均余额（共
            {Number(summary.jeUncoveredAccountCount ?? 0)}
            户），不推导月末余额；如需逐月勾稽，请补充对应主体的序时账。
          </span>
        </p>
      )}
      {stale && (
        <p className="fa-missing-hint">
          存款类型或利率已调整，下方逐户金额已按调整后的利率更新；与
          TB 的比较仍是上一次测算的结果，点“按新利率重算”后同步。
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
            booked &&
              (summary.bookedDirectionConfirmed === false ||
                Number(summary.bookedInterestIncome) < 0)
              ? "warning"
              : "",
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
        <h4>逐户余额勾稽与利息测算</h4>
        <Button variant="secondary" disabled={busy} onClick={onRecalculate}>
          按新利率重算
        </Button>
      </div>
      <div className="deposit-table">
        <table>
          <thead>
            <tr>
              <th>核算主体</th>
              <th>银行账户／科目</th>
              <th>存款类型</th>
              <th>年利率（%）</th>
              <th>期初余额</th>
              <th>期末 TB</th>
              <th>JE 推导期末</th>
              <th>余额差异</th>
              <th>利率来源</th>
              <th>测算利息</th>
              <th>
                余额勾稽{" "}
                <JargonTip
                  term="余额勾稽"
                  text={
                    "已勾稽：JE 推导期末与 TB 一致。\n待复核：两者存在差异。\n未做JE核对：缺少可用 JE 或 TB 期初余额；两点法出现零差异也不算勾稽。"
                  }
                />
              </th>
              <th>
                利率状态{" "}
                <JargonTip
                  term="利率状态"
                  text={
                    "已填利率：有可用利率，仍请以协议或对账单复核。\n待确认利率：暂用挂牌参考利率，已纳入测算。\n待填利率：没有可用利率，未纳入合计。"
                  }
                />
              </th>
              <th>明细</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.key}>
                <tr
                  className={
                    depositBalanceCheckStatus(row) === "已勾稽" &&
                    depositRateCheckStatus(row) === "已填利率"
                      ? ""
                      : "deposit-review-row"
                  }
                >
                  <td>
                    {row.entity === "默认主体" ? "未区分主体" : row.entity}
                  </td>
                  <td className="deposit-account-cell" title={row.account}>
                    <strong>{row.account}</strong>
                    {row.auxiliary && <small>辅助：{row.auxiliary}</small>}
                    <small>币种：{row.currency || "未标币种"}</small>
                  </td>
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
                  <td
                    title={
                      row.rateResolved
                        ? "与第二步「科目与利率确认」联动：这里的改写会体现在第二步的利率列"
                        : undefined
                    }
                  >
                    <span className="deposit-pct">
                      <NumberInput
                        label={`${row.account}（${row.currency || "未标币种"}）的年利率`}
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
                  <td className="deposit-amount-cell">
                    {amount(row.openingBalance)}
                  </td>
                  <td className="deposit-amount-cell">
                    {amount(row.tbClosingBalance)}
                  </td>
                  <td className="deposit-amount-cell">
                    {row.jeReconciled ? amount(row.derivedClosingBalance) : "—"}
                  </td>
                  <td
                    className={`deposit-amount-cell${row.jeReconciled && Math.abs(row.reconciliationDiff) >= 0.005 ? " deposit-difference" : ""}`}
                  >
                    {row.jeReconciled
                      ? amount(
                          Math.abs(row.reconciliationDiff) < 0.005
                            ? 0
                            : row.reconciliationDiff,
                        )
                      : "—"}
                  </td>
                  <td title={row.rateWarning}>
                    {row.rateWarning
                      ? `${row.rateSource}（高于央行基准）`
                      : row.rateSource}
                  </td>
                  <td className="deposit-amount-cell">
                    {amount(rowInterest(row))}
                  </td>
                  <td title={row.note}>
                    <Badge
                      variant="outline"
                      className={
                        row.status.startsWith("贷方余额")
                          ? "badge-warning"
                          : depositBalanceCheckStatus(row) === "已勾稽"
                            ? "badge-ready"
                            : "badge-warning"
                      }
                    >
                      {row.status.startsWith("贷方余额")
                        ? row.status
                        : depositBalanceCheckStatus(row)}
                    </Badge>
                  </td>
                  <td title={row.rateSource}>
                    <Badge
                      variant="outline"
                      className={
                        depositRateCheckStatus(row) === "已填利率"
                          ? "badge-ready"
                          : depositRateCheckStatus(row) === "待填利率"
                            ? "badge-danger"
                            : "badge-warning"
                      }
                    >
                      {depositRateCheckStatus(row)}
                    </Badge>
                  </td>
                  <td>
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      className="deposit-expand"
                      aria-expanded={expanded === row.key}
                      aria-label={`${row.account}的测算明细`}
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
                    <td colSpan={13}>
                      <div className="deposit-average-detail">
                        <span>年平均余额</span>
                        <strong>{amount(row.averageBalance)}</strong>
                        {row.status === "两点法推算" && (
                          <span>两点法推算，无月度明细</span>
                        )}
                      </div>
                      {row.months.length > 0 && (
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
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}
