import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { JobEvent, ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenJobEvents,
  listenPositionedFileDrops,
  openOutput,
  pickPath,
} from "./api";
import { depositDropTargetInside } from "./DepositInterestPage";
import {
  DEFAULT_ENTITY,
  dropUnlinkedTbAuxiliary,
  ledgerEntityKeyEnabled,
  ledgerMultiEntityCombos,
  ledgerRowEntities,
  verifyAuxiliaryLink,
  verifyCurrencyLink,
  type AuxiliaryLinkResult,
  type CurrencyLinkResult,
} from "@/ledgerMapping";
import {
  CurrencyFallbackDialog,
  type CurrencyFallbackMode,
} from "@/components/CurrencyFallbackDialog";
import { DateInput } from "@/components/DateInput";
import { defaultBalanceSheetDate } from "@/dateDefaults";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress, terminalJobError } from "@/components/JobProgress";
import { StepIndicator } from "@/components/StepIndicator";
import { EmptyState } from "@/components/EmptyState";
import { displayFileName } from "@/fileDisplay";
import {
  correctLedgerSourceKinds,
  missingGoldIdentity,
  resolveRoleLabels,
  scanLedgerUploadSources,
  selectLedgerSourcePair,
  type LedgerWorkbookSheetClassification,
} from "@/ledgerMapping";
import {
  completeLedgerPairReviewKey,
  LedgerReviewAll,
  useLedgerDictReviews,
} from "@/components/LedgerReviewAll";
import {
  describeLoanForm,
  loanRoleRequirement,
  resolveLoanForm,
  type LoanForm,
  type LoanRole,
} from "@/loanForms";
import { formGroups, useLedgerForms, type LedgerFormKind } from "@/ledgerForms";
import {
  loanBps,
  loanRateDefaults,
  loanRateOverrides,
  loanRateValue,
  loanReportStart,
  resolveLoanRates,
  type LoanRateSetting,
} from "@/loanRateTypes";
import { MappingPanel, type MappingDict } from "@/components/MappingPanel";
import { JargonTip } from "@/components/JargonTip";
import { NumberInput } from "@/components/NumberInput";
import { useEntityScopeConfirmation } from "@/components/EntityScopeConfirmation";
import { errorText } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import "./loan-interest.css";
import { AccountConfirmationActions, type ConfirmationRow } from "./AccountConfirmationActions";
// 来源卡与统一上传框的样式（fx-source-grid／fx-source-card／fx-detected-file）
// 与其他账表工具共用，定义在 fx-audit.css。
import "./fx-audit.css";

type Mode = "ledger" | "tb";
type Kind = "ledger" | "tb" | "je" | "rateLedger";
type LoanMapping = MappingDict;
type Inspection = {
  headers: string[];
  preview: string[][];
  rowCount: number;
  sheet: string;
  sheets: string[];
  headerRow: number;
  headerDepth: number;
  entities?: string[];
  /** 账里真实存在的「主体×科目」组合（TB 识别下发；空主体归「默认主体」）。 */
  entityAccounts?: Array<{ entity: string; account: string }>;
  suggestedMapping: LoanMapping;
  // TB/JE 专有：数据年度与由它推出的建议表日，识别后自动预填资产负债表日。
  dataYears?: string[];
  suggestedBalanceSheetDate?: string;
  // 台账专有：角色清单与四型定义由引擎随识别结果下发（唯一定义在 Rust）。
  roles?: LoanRole[];
  forms?: LoanForm[];
};
function isLoanInspectionSnapshot(value: unknown): value is Inspection {
  if (!value || typeof value !== "object") return false;
  const inspection = value as Partial<Inspection>;
  return (
    Array.isArray(inspection.headers) &&
    Array.isArray(inspection.preview) &&
    Array.isArray(inspection.sheets) &&
    typeof inspection.rowCount === "number" &&
    typeof inspection.sheet === "string" &&
    Boolean(inspection.suggestedMapping)
  );
}
type Source = {
  path: string;
  inspection?: Inspection;
  mapping: LoanMapping;
};
type LoanRow = {
  entity: string;
  rowKey?: string;
  accountCode?: string;
  accountName?: string;
  auxiliary?: string;
  currency?: string;
  loanId: string;
  openingPrincipal: number;
  additions: number;
  reductions: number;
  closingPrincipal: number;
  /** 台账期末余额原值；无期末列或期外借款为 null，此时推算期末即全部信息。 */
  ledgerClosing?: number | null;
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
/** TB 模式「利率确认」：粘贴的利率区域与 TB 借款明细匹配后的逐笔利率。 */
type PasteRateRow = {
  entity?: string;
  rowKey?: string;
  accountCode?: string;
  auxiliary?: string;
  loanId: string;
  rateType: "fixed" | "floating";
  fixedRate?: number;
  benchmarkRate?: number;
  spreadBps?: number;
  matchStatus?: string;
  matchBasis?: string;
};
/** TB＋JE 没有合同利率时的界面预填值：当前 1 年期 LPR（2026-08-20）为 3.00%。
 *  这里只作为可编辑起点，不冒充合同执行利率；表头提示用户必须据实修改。 */
export const DEFAULT_LOAN_RATE = 0.03;
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
    auxiliary: "辅助核算",
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
    entity: "核算主体",
    auxiliary: "辅助核算",
    summary: "摘要",
    functionalDebit: "借方金额",
    functionalCredit: "贷方金额",
    functionalAmount: "有符号金额",
    direction: "借贷方向",
  },
  rateLedger: LOAN_ROLE_FALLBACK,
};
const loanRowKey = (row: { entity?: string; loanId: string; rowKey?: string }) =>
  row.rowKey || `${row.entity || "默认主体"}\u001f${row.loanId}`;

/** 与 Rust `norm` 同口径的宽松比较键：去空白与 -/_/— 后小写。利率明细行
 *  与科目行的匹配兜底用它；新版数据 rowKey 的科目段本身就是同一 norm
 *  的产物，可精确对上，这里再 norm 一次保证两侧一致。 */
const normKey = (value: string) => value.toLowerCase().replace(/[\s\-_/—]/g, "");

/** loan.preview 明细行可能归属的科目键候选，按置信度排序：
 *  rowKey 科目段（新版精确）→ 科目编码 → 科目文本（旧任务兜底）。 */
function rateRowAccountKeyCandidates(row: LoanRow): string[] {
  const candidates: string[] = [];
  if (row.rowKey) {
    const parts = row.rowKey.split("\u001f");
    if (parts[0] === "tb" && parts.length >= 3) candidates.push(parts[2]);
  }
  if (row.accountCode?.trim()) candidates.push(row.accountCode);
  candidates.push(row.loanId);
  return [...new Set(candidates.map(normKey))];
}

const entityDisplay = (entity?: string) =>
  !entity || entity === "默认主体" ? "未区分主体" : entity;

type TbAccount = {
  key: string;
  identity?: string;
  code: string;
  name: string;
  currency?: string;
  account: string;
  opening: number;
  closing: number;
  /** TB 损益发生额；null 表示源表没有可用发生额列。 */
  occurrence?: number | null;
  occurrenceBasis?: string | null;
  /** 各主体的余额小计（TB 主体列映射了才下发）：按主体拆行时逐行取数。 */
  byEntity?: Array<{
    entity: string;
    opening: number;
    closing: number;
    occurrence?: number | null;
  }>;
  reviewAuxiliaries?: Array<{ entity: string; auxiliary: string }>;
  /** 仅用于初始化科目角色，不在界面展示内部判断过程。 */
  suggestedType?: LoanAccountRole;
  suggestionReason?: string;
};

type LoanAccountRole = "loan" | "interest_expense" | "skip";

type LoanAccountReviewRow = TbAccount & {
  reviewKey: string;
  entity?: string;
  auxiliary?: string;
  auxiliaryKey?: string;
};

const reviewKey = (entity: string, account: string, auxiliary: string) =>
  `${entity}\u001f${account}\u001f${auxiliary}`;

/** 公共辅助验证成功才把末级科目展开；没有通过的科目仍只出现一次。 */
/**
 * 确认清单的行粒度：与存款利息同口径——TB 里同一科目出现在多个主体名下、
 * 且主体已成为匹配键时按「主体×科目」拆行（余额与发生额取该主体自己的数，
 * 来自引擎 byEntity 小计），辅助核算验证通过再按辅助户展开；其余一科一行。
 * splitEntity 由页面按「双侧映射主体列＋账里确实多主体」判定后传入。
 */
export function loanAccountReviewRows(
  accounts: TbAccount[],
  link: AuxiliaryLinkResult | null,
  splitEntity = false,
): LoanAccountReviewRow[] {
  const sameCodeCounts = new Map<string, number>();
  for (const account of accounts)
    sameCodeCounts.set(account.key, (sameCodeCounts.get(account.key) ?? 0) + 1);
  return accounts.flatMap((account) => {
    const identity = account.identity ?? account.key;
    // 公共辅助计划只按编码返回组；同码多名称时不能把一组辅助户复制到每个名称。
    const groups = (link?.groups ?? []).filter(
      (group) => group.account === account.key,
    );
    const sourceAuxiliaries = account.reviewAuxiliaries ?? [];
    const detailsOf = (group: (typeof groups)[number]) => {
      if ((sameCodeCounts.get(account.key) ?? 0) <= 1) return group.details ?? [];
      return (group.details ?? []).filter((detail) => sourceAuxiliaries.some((source) =>
        source.entity === group.entity && [detail.key, detail.display]
          .some((value) => normKey(value) === normKey(source.auxiliary))));
    };
    const expanded = groups.flatMap((group) =>
      group.reviewVerified
        ? detailsOf(group).map((detail) => ({
            ...account,
            reviewKey: reviewKey(group.entity, identity, detail.key),
            entity: group.entity,
            auxiliary: detail.display,
            auxiliaryKey: detail.key,
          }))
        : [],
    );
    const allGroupsVerified =
      groups.length > 0 && groups.every((group) => group.reviewVerified && detailsOf(group).length > 0);
    const hasVerifiedGroup = (baseEntity: string | undefined) =>
      baseEntity === undefined
        ? allGroupsVerified
        : groups.some(
            (group) => group.reviewVerified && group.entity === baseEntity && detailsOf(group).length > 0,
          );
    const rowEntities = splitEntity
      ? ledgerRowEntities(
          account.byEntity?.map((item) => item.entity),
        )
      : undefined;
    const baseEntities = rowEntities ?? [undefined];
    const fallbacks = baseEntities
      .filter((baseEntity) => !hasVerifiedGroup(baseEntity))
      .map((baseEntity) => {
        if (!baseEntity) return { ...account, reviewKey: identity };
        const amounts = account.byEntity?.find(
          (item) => item.entity === baseEntity,
        );
        return {
          ...account,
          opening: amounts?.opening ?? account.opening,
          closing: amounts?.closing ?? account.closing,
          occurrence: amounts ? (amounts.occurrence ?? account.occurrence) : account.occurrence,
          reviewKey: reviewKey(baseEntity, identity, ""),
          entity: baseEntity,
        };
      });
    return [...expanded, ...fallbacks];
  });
}

/** 兼容旧任务/浏览器演示数据；新版 Rust 会直接下发更审慎的 suggestedType。 */
function initialLoanAccountRole(account: TbAccount): LoanAccountRole {
  if (
    account.suggestedType === "loan" ||
    account.suggestedType === "interest_expense" ||
    account.suggestedType === "skip"
  ) {
    return account.suggestedType;
  }
  if (/利息支出|利息费用|借款利息|贷款利息|融资利息|interest expense|finance cost/i.test(
    account.name || account.account,
  )) {
    return "interest_expense";
  }
  return /短期借款|长期借款|银行借款|借款本金|贷款本金|应付债券|有息负债|租赁负债/.test(
    account.name || account.account,
  )
    ? "loan"
    : "skip";
}
/** 多列角色与公共引擎对齐：日期组成列、凭证号、科目名称（一级/二级拆列）、
 * 辅助核算都是引擎侧的多列角色（3300 家族 TB 的科目名称挂一级＋二级正是
 * 黄金裁决口径），此前只登记 date 会让面板与 LLM 复核回写把多列建议硬
 * 收敛成单列。 */
const LOAN_MULTI_COLUMN_ROLES = new Set<string>([
  "date",
  "id",
  "accountName",
  "auxiliary",
]);
const loanSingleColumnMapping = (mapping: LoanMapping) =>
  Object.fromEntries(
    Object.entries(mapping).map(([role, value]) => [
      role,
      Array.isArray(value) ? value[0] : value,
    ]),
  ) as Record<string, string | undefined>;
/** 公共 LLM 复核契约不接受显式 undefined；映射面板字典允许它表示未选。 */
const loanReviewMapping = (mapping: LoanMapping) =>
  Object.fromEntries(
    Object.entries(mapping).filter(
      (entry): entry is [string, string | string[]] =>
        typeof entry[1] === "string" || Array.isArray(entry[1]),
    ),
  );
/**
 * 历史任务的手工选择优先，但不能用旧版整份字典覆盖新版确定性建议。
 * 这样新增的公共别名（如“核算组织”→主体）可在继续任务时自动补入；同时
 * 已被历史映射占用的物理列不会再分给另一个新角色。
 */
export function mergeRestoredLoanMapping(
  suggested: LoanMapping,
  restored: LoanMapping,
  headers: string[],
): LoanMapping {
  const validColumns = new Set(headers);
  const validValue = (value: string | string[] | undefined) =>
    Array.isArray(value)
      ? value.filter((column) => validColumns.has(column))
      : value && validColumns.has(value)
        ? value
        : undefined;
  const merged: LoanMapping = {};
  const occupied = new Set<string>();
  for (const [role, raw] of Object.entries(restored)) {
    const value = validValue(raw);
    if (!value || (Array.isArray(value) && !value.length)) continue;
    merged[role] = value;
    for (const column of Array.isArray(value) ? value : [value]) occupied.add(column);
  }
  for (const [role, raw] of Object.entries(suggested)) {
    if (merged[role]) continue;
    const value = validValue(raw);
    if (!value) continue;
    if (Array.isArray(value)) {
      const available = value.filter((column) => !occupied.has(column));
      if (!available.length) continue;
      merged[role] = available;
      available.forEach((column) => occupied.add(column));
    } else if (!occupied.has(value)) {
      merged[role] = value;
      occupied.add(value);
    }
  }
  return merged;
}
/** 底稿反馈里只展示文件名，完整路径放 title 悬浮提示。 */
function fileNameOf(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
/** JavaScript 会把 IEEE-754 的 -0 原样格式化成“-0”；界面展示统一归零。 */
export function loanDisplayNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
) {
  if (value === 0) return "0";
  return value.toLocaleString("zh-CN", options);
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
    | "openingPrincipal"
    | "additions"
    | "reductions"
    | "closingPrincipal"
    | "ledgerClosing"
  >,
): number | null {
  // 差异＝推算期末（期初＋增加－减少）－台账期末；台账无期末列时无从对照，
  // 不出假 0，返回 null 让界面显示为空。有账面数的行差异是真实的独立勾稽。
  if (r.ledgerClosing == null) return null;
  return (
    r.openingPrincipal +
    r.additions -
    r.reductions -
    r.ledgerClosing
  );
}
/** TB/JE 的余额与科目走统一角色名，同一语义有几种写法时任一到位即可。 */
const ANY_OF: Record<string, string[][]> = {
  tb: [
    ["accountCode", "accountName", "account"],
    // 期初余额不再必填：缺失时后端按 0 参与测算（2026-09-25，与存款同口径）。
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
  tb: ["借款科目", "期末余额"],
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
  m: LoanMapping,
  forms?: LoanForm[],
) {
  const filled = (role: string) => {
    const value = m[role];
    return Array.isArray(value) ? value.some(Boolean) : Boolean(value?.trim());
  };
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
  // inspection 必须显式置 undefined：setSource 是合并语义，「清空」若不带它，
  // 旧识别信息会残留，来源身份（路径）一变还触发一次多余的自动 LLM 复核。
  const empty = (): Source => ({ path: "", inspection: undefined, mapping: {} });
  const [mode, setMode] = useState<Mode>("ledger");
  const [sources, setSources] = useState<Record<Kind, Source>>({
    ledger: empty(),
    tb: empty(),
    je: empty(),
    rateLedger: empty(),
  });
  const [reportEnd, setReportEnd] = useState(defaultBalanceSheetDate());
  /** 本位币（TB 模式）：美元等外币本位币主体需显式指定——余额表本位币行
   *  币种常留空、序时账逐行标币种，币种桶按本位币归一后凭证才能按科目归集。
   *  缺省空串 = 人民币口径（空白/人民币都算本位币，与旧行为一致）。 */
  const [functionalCurrency, setFunctionalCurrency] = useState("");
  const [rateEdits, setRateEdits] = useState<
    Record<number, Partial<LoanRateSetting>>
  >({});
  const [outputPath, setOutputPath] = useState("");
  const [rows, setRows] = useState<LoanRow[]>([]);
  // 利率确认（TB 模式）：用户从 Excel 复制粘贴的利率区域原文，与匹配出的逐笔利率。
  // 粘贴原文保留（方便换映射后一键重匹配），匹配结果随 TB 来源/映射变化作废。
  /** 「确认科目与利率」步骤：TB 末级科目清单（loan.tb_accounts 下发）。 */
  const [tbAccounts, setTbAccounts] = useState<TbAccount[]>([]);
  const [accountsBusy, setAccountsBusy] = useState(false);
  const [ratesBusy, setRatesBusy] = useState(false);
  /** 科目角色确认：行键 → 借款科目/排除；预选规则为名称含「借款/贷款」。 */
  const [loanAccountRoles, setLoanAccountRoles] = useState<Record<string, LoanAccountRole>>({});
  const [loanDetailRoles, setLoanDetailRoles] = useState<Record<string, LoanAccountRole>>({});
  const restoredLoanAccounts = useRef<string[] | null>(null);
  const restoredInterestExpenseAccounts = useRef<string[] | null>(null);
  const [accountQuery, setAccountQuery] = useState("");
  const [accountPage, setAccountPage] = useState(0);
  const [accountChangeNote, setAccountChangeNote] = useState("");
  const accountListRef = useRef<HTMLDivElement>(null);
  /** 利率手填：行标识 → 利率口径（叠加在 preview 借款行之上）。 */
  const [tbRateEdits, setTbRateEdits] = useState<Record<string, PasteRateRow>>({});
  const [result, setResult] = useState<Record<string, unknown>>();
  const [resultStale, setResultStale] = useState(false);
  const [ratesConfirmed, setRatesConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [pairStatus, setPairStatus] = useState("");
  const [currencyFallbackMode, setCurrencyFallbackMode] = useState<
    CurrencyFallbackMode | ""
  >("");
  const [currencyFallbackPrompt, setCurrencyFallbackPrompt] =
    useState<CurrencyLinkResult | null>(null);
  const [busy, setBusy] = useState(false);
  // 运行中的按钮归属（UI 审计 P3-3）：只有被点击的按钮进 loading 文案，
  // 另一个按钮保持普通禁用；任务终态由 busy 归零统一收回。
  const [activeRun, setActiveRun] = useState<"loan.preview" | "loan.export">();
  const [step, setStep] = useState(0);
  const [job, setJob] = useState<JobEvent>();
  const activeJob = useRef("");
  // TB＋JE 必须在同一次 LLM 请求里互相校验科目身份与匹配键；复核状态放在
  // 页面层，避免两个 Mapping 子组件各自发起互不知情的单表请求。
  const reviews = useLedgerDictReviews(engineCall, {
    tb: JSON.stringify([
      sources.tb.path,
      sources.tb.inspection?.sheet,
      sources.tb.inspection?.headerRow,
      sources.tb.inspection?.headerDepth,
    ]),
    je: JSON.stringify([
      sources.je.path,
      sources.je.inspection?.sheet,
      sources.je.inspection?.headerRow,
      sources.je.inspection?.headerDepth,
    ]),
  });
  const ledgerReviewOwner = useRef({});
  const reviewingAny = reviews.reviewing.tb || reviews.reviewing.je;
  // TB＋JE 统一上传框：拖放命中以这个框的坐标为准（台账模式不渲染，自然不响应）。
  const uploadDropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stop = listenJobEvents((e) => {
      if (e.jobId !== activeJob.current) return;
      setJob(e);
      if (e.phase === "completed") {
        setBusy(false);
        const next = e.result as Record<string, unknown>;
        setResult(next);
        setRows((next.rows ?? []) as LoanRow[]);
        setResultStale(false);
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
  // 借款明细联动验证（公共锚点反查，角色＝loanId、纯锚点口径）：
  // 与计算侧同一套判定，用户在映射页就能看到 JE 有没有对应的借款明细列。
  const [auxLink, setAuxLink] = useState<AuxiliaryLinkResult | null>(null);
  const entityScope = useEntityScopeConfirmation({
    tbEntities: ledgerEntityKeyEnabled(sources.tb.mapping, sources.je.mapping)
      ? (sources.tb.inspection?.entities ?? []) : [],
    jeEntities: ledgerEntityKeyEnabled(sources.tb.mapping, sources.je.mapping)
      ? (sources.je.inspection?.entities ?? []) : [],
    onInvalidate: () => invalidateResults(),
  });
  // 触发键只认「数据源＋两侧辅助核算明细映射」：其余角色的映射调整不重验，
  // 与汇兑损益、存款利息同一口径（锚点反查本身仍按完整映射计算）。
  const auxLinkKey = sources.tb.path && sources.je.path
    ? JSON.stringify({
        tb: [
          sources.tb.path,
          sources.tb.inspection?.sheet ?? "",
          sources.tb.inspection?.headerRow ?? 1,
          sources.tb.inspection?.headerDepth ?? 1,
          sources.tb.mapping.auxiliary ?? null,
        ],
        je: [
          sources.je.path,
          sources.je.inspection?.sheet ?? "",
          sources.je.inspection?.headerRow ?? 1,
          sources.je.inspection?.headerDepth ?? 1,
          sources.je.mapping.auxiliary ?? null,
        ],
      })
    : null;
  useEffect(() => {
    if (auxLinkKey === null) {
      setAuxLink(null);
      return;
    }
    let cancelled = false;
    setAuxLink(null);
    void verifyAuxiliaryLink({
      tbSource: {
        inputPath: sources.tb.path,
        sheet: sources.tb.inspection?.sheet ?? "",
        headerRow: sources.tb.inspection?.headerRow ?? 1,
        headerDepth: sources.tb.inspection?.headerDepth ?? 1,
      },
      tbMapping: sources.tb.mapping,
      jeSource: {
        inputPath: sources.je.path,
        sheet: sources.je.inspection?.sheet ?? "",
        headerRow: sources.je.inspection?.headerRow ?? 1,
        headerDepth: sources.je.inspection?.headerDepth ?? 1,
      },
      jeMapping: sources.je.mapping,
      auxRole: "auxiliary",
      anchorOnly: true,
      selectedAccounts: selectedLoanAccounts(),
      entityScope: entityScope.selection,
    }).then((result) => {
      if (cancelled) return;
      setAuxLink(result);
      setSources((current) => {
        const mapping = dropUnlinkedTbAuxiliary(current.tb.mapping, result);
        return mapping === current.tb.mapping
          ? current
          : { ...current, tb: { ...current.tb, mapping } };
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auxLinkKey]);
  // TB＋JE 模式支持把两个文件整组拖进上传框，与存款利息／FA 一致。
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
    return () => {
      void drops.then((unlisten) => unlisten());
    };
  }, []);
  const [resultRateEdits, setResultRateEdits] = useState<
    Record<string, ResultRateEdit>
  >({});
  /** 借款利率表自动生成键（取值见 loanSelectionKey）：记录最近一次自动生成
   *  使用的科目选择；结果作废（换映射/换文件/换主体范围等）时清空，回到
   *  第二步会自动补一次生成，不给用户留「表没了又没有按钮」的死路。 */
  const autoRateKey = useRef("");
  const invalidateResults = () => {
    autoRateKey.current = "";
    activeJob.current = "";
    if (rows.length || result) setResultStale(true);
    setRatesConfirmed(false);
    setJob(undefined);
  };
  const setSource = (kind: Kind, next: Partial<Source>) => {
    invalidateResults();
    setResultRateEdits({});
    if (kind === "tb" || kind === "je") {
      setCurrencyFallbackMode("");
      setCurrencyFallbackPrompt(null);
    }
    if (kind === "ledger") setRateEdits({});
    // TB 的文件/Sheet/映射一变，借款行清单就可能变：科目确认与手填利率作废，
    // 回到第二步重新确认。
    if (kind === "tb") {
      setTbAccounts([]);
      setLoanAccountRoles({});
      setLoanDetailRoles({});
      setTbRateEdits({});
    }
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
        loanSingleColumnMapping(sources.ledger.mapping),
      )
    : [];
  const rateRows = resolveLoanRates(rateDefaults, rateEdits);
  const editRate = (index: number, patch: Partial<LoanRateSetting>) => {
    invalidateResults();
    setRateEdits((v) => ({ ...v, [index]: { ...v[index], ...patch } }));
  };
  const editResultRate = (index: number, patch: ResultRateEdit) => {
    setResultStale(true);
    setRatesConfirmed(false);
    const id = loanRowKey(rows[index]);
    setRows((v) =>
      v.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    setResultRateEdits((v) => ({ ...v, [id]: { ...v[id], ...patch } }));
  };
  // 步骤 2 停在"可选的利率确认"上时，禁用的下一步其实卡的是步骤 1 的映射——
  // 把缺什么明说并给一键返回，不让用户在可选步骤上猜哪里没完成。
  const mappingGaps = activeKinds.flatMap((kind) =>
    loanMissing(
      kind,
      sources[kind].mapping,
      sources[kind].inspection?.forms,
    ).map((item) => `${kind.toUpperCase()}：${item}`),
  );
  /** 进入「确认科目与利率」步骤时拉取 TB 末级科目清单并按名称预选。 */
  async function loadTbAccounts() {
    if (!sources.tb.inspection || accountsBusy) return;
    setAccountsBusy(true);
    setError("");
    try {
      const res = (await engineCall("loan.tb_accounts", {
        tbSource: source("tb"),
      })) as { accounts: TbAccount[] };
      setTbAccounts(res.accounts ?? []);
      const restored = restoredLoanAccounts.current;
      const restoredExpenses = restoredInterestExpenseAccounts.current;
      restoredLoanAccounts.current = null;
      restoredInterestExpenseAccounts.current = null;
      setLoanAccountRoles(
        Object.fromEntries(
          (res.accounts ?? []).map((a) => [
            a.identity ?? a.key,
            restored || restoredExpenses
              ? restored?.includes(a.key)
                ? "loan"
                : restoredExpenses?.includes(a.key)
                  ? "interest_expense"
                  : "skip"
              : initialLoanAccountRole(a),
          ]),
        ),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setAccountsBusy(false);
    }
  }
  useEffect(() => {
    if (step === 1 && mode === "tb" && sources.tb.inspection && !tbAccounts.length) {
      void loadTbAccounts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, mode, sources.tb.inspection, sources.tb.mapping, tbAccounts.length]);
  const selectedLoanAccounts = () =>
    [...new Set(loanAccountReviewRows(tbAccounts, auxLink, loanSplitEntity)
      .filter((row) => loanReviewRole(row) === "loan").map((row) => row.key))];
  const selectedInterestExpenseAccounts = () =>
    [...new Set(loanAccountReviewRows(tbAccounts, auxLink, loanSplitEntity)
      .filter((row) => loanReviewRole(row) === "interest_expense").map((row) => row.key))];
  const loanReviewRole = (row: LoanAccountReviewRow) =>
    loanDetailRoles[row.reviewKey] ?? loanAccountRoles[row.identity ?? row.key] ?? "skip";
  // 主体拆行开关：TB 与 JE 双侧映射主体列、且 TB 里确实出现多个主体时启用
  // （与引擎建户的主体键口径一致）；单主体账套维持一科一行。
  const loanSplitEntity =
    ledgerEntityKeyEnabled(sources.tb.mapping, sources.je.mapping) &&
    ledgerMultiEntityCombos(sources.tb.inspection?.entityAccounts);
  const loanReviewSelections = () =>
    loanAccountReviewRows(tbAccounts, auxLink, loanSplitEntity)
      .map((row) => ({
        entity: row.entity ?? "",
        account: row.key,
        reviewKey: row.reviewKey,
        name: row.name,
        currency: row.currency ?? "",
        auxiliary: row.auxiliaryKey ?? "",
        role: loanReviewRole(row),
        selected: loanReviewRole(row) === "loan",
      }));
  /** 借款利率表的自动生成键：借款科目/利息支出科目选择（含辅助明细勾选）
   *  或主体范围一变，屏幕上的利率明细快照即过期，第二步会自动按新选择
   *  重新生成——利率填写入口随科目类型实时出现/消失，不再依赖手动按钮。 */
  const loanSelectionKey = useMemo(
    () =>
      JSON.stringify([
        selectedLoanAccounts(),
        selectedInterestExpenseAccounts(),
        loanReviewSelections(),
        entityScope.selection,
        functionalCurrency,
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tbAccounts, loanAccountRoles, loanDetailRoles, auxLink, entityScope.selection, functionalCurrency],
  );
  const editTbRate = (row: LoanRow, patch: Partial<PasteRateRow>) => {
    if (rows.length || result) setResultStale(true);
    setRatesConfirmed(false);
    const key = loanRowKey(row);
    setTbRateEdits((v) => {
      const prev = v[key] ?? { rateType: "fixed" as const };
      const base: PasteRateRow = { ...prev, ...patch };
      return {
        ...v,
        [key]: { ...base, entity: row.entity, loanId: row.loanId, rowKey: row.rowKey, accountCode: row.accountCode, auxiliary: row.auxiliary },
      };
    });
  };
  /** 合并引擎识别值、人工改写与市场基准预填。默认值只在固定利率且原始资料
   *  没有数值利率时生效；用户的回传/手填始终优先。 */
  const resolvedTbRate = (row: LoanRow): PasteRateRow => {
    const edit = tbRateEdits[loanRowKey(row)];
    const rateType = edit?.rateType ?? row.rateType ?? "fixed";
    return {
      entity: row.entity,
      loanId: row.loanId,
      rowKey: row.rowKey,
      accountCode: row.accountCode,
      auxiliary: row.auxiliary,
      rateType,
      fixedRate:
        rateType === "fixed"
          ? (edit?.fixedRate ?? row.fixedRate ?? DEFAULT_LOAN_RATE)
          : edit?.fixedRate,
      benchmarkRate: edit?.benchmarkRate ?? row.benchmarkRate,
      spreadBps: edit?.spreadBps ?? row.spreadBps,
      matchStatus: row.matchStatus,
      matchBasis: row.matchBasis,
    };
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
    ++restoreGeneration.current;
    restoredLoanAccounts.current = null;
    setSource(kind, { path: picked, inspection: undefined, mapping: {} });
    await inspect(kind, picked);
  }
  async function browsePair() {
    const picked = await pickPath("files", "选择 TB 或序时账文件", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
      "tsv",
    ]);
    if (!picked) return;
    void classifyAndInspect(Array.isArray(picked) ? picked : [picked]);
  }
  /** TB＋JE 统一上传入口：与其他账表工具一致，先公共引擎自动分类再逐侧识别。 */
  async function classifyAndInspect(selected: string[]) {
    const files = selected.filter((p) =>
      /\.(xlsx?|xlsm|csv|txt|tsv)$/i.test(p),
    );
    if (!files.length) return;
    ++restoreGeneration.current;
    restoredLoanAccounts.current = null;
    // 公共入口代表重新选择整组：先清空旧 TB/JE，再按本轮文件重建。
    // 分批补齐请使用下方待上传单侧卡片，避免“追加”和“换账套”语义混淆。
    setSources((v) => ({ ...v, tb: empty(), je: empty() }));
    invalidateResults();
    setBusy(true);
    setError("");
    setPairStatus("正在通过公共账表引擎逐 Sheet 识别…");
    const failures: string[] = [];
    try {
      const scan =
        await scanLedgerUploadSources<LedgerWorkbookSheetClassification>(
          engineCall,
          files,
          {
            onWorkbookStart: (path, index, total) =>
              setPairStatus(
                `正在识别第 ${index + 1}/${total} 份：${fileNameOf(path)}`,
              ),
          },
        );
      failures.push(
        ...scan.failures.map(
          (failure) => `${fileNameOf(failure.path)}：${errorText(failure.error)}`,
        ),
      );
      const picked = selectLedgerSourcePair(scan.sources);
      setPairStatus(`正在并行读取 ${picked.length} 个账表来源并识别字段…`);
      const inspected = await Promise.all(
        picked.map(async (item) => {
          try {
            const response = (await engineCall(
              "loan.inspect",
              {
                kind: item.kind,
                source: {
                  inputPath: item.path,
                  sheet: item.classification.sheet,
                  headerRow: 0,
                  headerDepth: 0,
                },
              },
              `${fileNameOf(item.path)} / ${item.classification.sheet}`,
            )) as Inspection;
            return { item, response };
          } catch (error) {
            return { item, error };
          }
        }),
      );
      // 保持自动配对顺序写回，避免并发完成先后改变 TB/JE 的既有选择。
      for (const entry of inspected) {
        if (entry.response)
          applyInspection(entry.item.kind, entry.item.path, entry.response);
        else
          failures.push(
            `${fileNameOf(entry.item.path)}：${errorText(entry.error)}`,
          );
      }
      setPairStatus(
        scan.hiddenSheets
          ? `${scan.hiddenSheets} 张低置信度 Sheet 已忽略，请核对已选工作表。`
          : "",
      );
      if (failures.length) setError(failures.join("；"));
    } finally {
      setBusy(false);
    }
  }
  /** 来源卡上的单侧更换：按该侧既定类型直接读取新文件（Sheet 重新自动识别）。 */
  async function replaceSource(kind: "tb" | "je") {
    const picked = await pickPath(
      "file",
      kind === "tb" ? "更换 TB 科目余额表" : "更换 JE 序时账",
      ["xlsx", "xls", "xlsm", "csv", "txt", "tsv"],
    );
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    ++restoreGeneration.current;
    restoredLoanAccounts.current = null;
    setPairStatus(`正在按 ${kind.toUpperCase()} 读取 ${fileNameOf(path)}…`);
    const x = await inspect(kind, path, {
      sheet: "",
      headerRow: 0,
      headerDepth: 0,
    });
    setPairStatus(
      x ? `${kind.toUpperCase()} 已更换为 ${fileNameOf(path)}。` : "",
    );
  }
  /** 来源卡上的「更正为 TB/JE」：目标槽被占时交换两侧，全部按新类型重新识别。 */
  async function changeSourceKind(from: "tb" | "je", to: "tb" | "je") {
    const current = sources[from];
    const occupied = sources[to];
    if (!current.path || !current.inspection) return;
    setBusy(true);
    setError("");
    setPairStatus(`正在更正为 ${to.toUpperCase()}，并按新类型重新识别…`);
    try {
      const changed = await correctLedgerSourceKinds<Inspection>(
        from,
        to,
        { path: current.path, inspection: current.inspection },
        occupied.path && occupied.inspection
          ? { path: occupied.path, inspection: occupied.inspection }
          : undefined,
        async (kind, src) =>
          (await engineCall(
            "loan.inspect",
            {
              kind,
              source: {
                inputPath: src.path,
                sheet: src.inspection.sheet,
                headerRow: 0,
                headerDepth: 0,
              },
            },
            `${fileNameOf(src.path)} / ${src.inspection.sheet}`,
          )) as Inspection,
      );
      setSources((v) => ({ ...v, tb: empty(), je: empty() }));
      for (const item of changed)
        applyInspection(item.kind, item.path, item.inspection);
      setPairStatus(
        changed.length > 1
          ? "TB 与 JE 来源已交换，并按新类型重新识别。"
          : `${fileNameOf(current.path)} 已更正为 ${to.toUpperCase()}。`,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(
    kind: Kind,
    path = sources[kind].path,
    over?: Partial<Inspection>,
  ): Promise<Inspection | undefined> {
    setBusy(true);
    setError("");
    try {
      const old = sources[kind].inspection;
      const sheet = over?.sheet ?? old?.sheet ?? "";
      const x = (await engineCall(
        "loan.inspect",
        {
          kind,
          source: {
            inputPath: path,
            sheet,
            headerRow: over?.headerRow ?? old?.headerRow ?? 0,
            // 0 = 让引擎自动判定层数（TB/JE 走 fx 内核推断；台账固定单层）。
            headerDepth: over?.headerDepth ?? old?.headerDepth ?? 0,
          },
        },
        `${fileNameOf(path)}${sheet ? ` / ${sheet}` : ""}`,
      )) as Inspection;
      applyInspection(kind, path, x);
      return x;
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  /** 把识别结果落到对应来源：存档映射顶回建议映射（一次性消费），其余用建议值。 */
  function applyInspection(kind: Kind, path: string, x: Inspection) {
    // 历史恢复后重新识别同一文件：存档映射顶回建议映射，一次性消费；
    // 换文件照旧用建议值。
    const stash = restoredLoanMappings.current[kind];
    const samePath = (a: string, b: string) =>
      a.trim().toLowerCase() === b.trim().toLowerCase();
    const mapping = stash && samePath(stash.path, path)
      ? mergeRestoredLoanMapping(x.suggestedMapping ?? {}, stash.mapping, x.headers)
      : (x.suggestedMapping ?? {});
    if (stash && samePath(stash.path, path))
      restoredLoanMappings.current[kind] = undefined;
    setSource(kind, { path, inspection: x, mapping });
    if (kind === "ledger") setRateEdits({});
    // TB/JE 识别出数据年度就预填表日：期间起点、LPR 取期和 JE 归集都由它
    // 推导，账套不是本年度时留着默认值会把这三处全部带偏。
    if (kind === "tb" || kind === "je") {
      if (x.suggestedBalanceSheetDate) setReportEnd(x.suggestedBalanceSheetDate);
      else if (x.dataYears?.length === 1)
        setReportEnd(`${x.dataYears[0]}-12-31`);
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
      // TB 模式：确认的借款科目清单 + 「确认科目与利率」步骤手填/回读的利率。
      // 引擎按借款行标识归一化对应，优先于利率台账文件（后者仅历史任务恢复用）。
      loanAccounts: mode === "tb" ? selectedLoanAccounts() : undefined,
      interestExpenseAccounts:
        mode === "tb" ? selectedInterestExpenseAccounts() : undefined,
      loanReviewSelections: mode === "tb" ? loanReviewSelections() : undefined,
      // 第一步已完成的辅助联动计划：第二步据此决定是否展开明细，
      // 第三步复用已认定的 JE 列，不重新反查。
      auxiliaryLink: mode === "tb" ? auxLink : undefined,
      rateRows:
        mode === "tb" && rows.length
          ? rows.map((r) => {
              const rate = resolvedTbRate(r);
              return {
                loanId: rate.loanId,
                rowKey: rate.rowKey,
                accountCode: rate.accountCode,
                auxiliary: rate.auxiliary,
                entity: rate.entity,
                rateType: rate.rateType,
                fixedRate: rate.fixedRate,
                benchmarkRate: rate.benchmarkRate,
                spreadBps: rate.spreadBps,
              };
            })
          : undefined,
      rateLedgerSource: source("rateLedger"),
      rateOverrides: resultRateEdits,
      rateConfirmationAccepted: mode === "tb" ? ratesConfirmed : undefined,
      entityScope: entityScope.selection,
      currencyFallbackMode:
        mode === "tb" && currencyFallbackMode
          ? currencyFallbackMode
          : undefined,
      functionalCurrency:
        mode === "tb" && functionalCurrency ? functionalCurrency : undefined,
      ...(outputPath ? { outputPath } : {}),
      __restoreSnapshot: {
        version: 1,
        sources: (Object.values(sources) as Source[])
          .map((item) => item.path)
          .filter(Boolean),
        data: {
          inspections: Object.fromEntries(
            (Object.entries(sources) as Array<[Kind, Source]>)
              .filter(([, item]) => Boolean(item.inspection))
              .map(([kind, item]) => [kind, item.inspection]),
          ),
        },
      },
    };
  }

  // 历史记录「继续任务」：回填台账/TB/JE/利率台账路径、模式与映射；Sheet 等
  // 新任务优先恢复带文件指纹的轻量识别快照；旧任务、超限快照或源文件
  // 已变化时才重新识别，绝不把不完整参数伪装成 Inspection 传给映射面板。
  // 逐行利率的手工改动依赖台账预览现算默认值，恢复后需在识别后重设。
  // restoredLoanMappings：重新识别同一文件后，以新版建议补齐旧任务没有的角色，
  // 再由仍有效的存档人工选择覆盖；逐来源一次性消费。
  const restoredLoanMappings = useRef<
    Partial<Record<Kind, { path: string; mapping: LoanMapping }>>
  >({});
  const restoreGeneration = useRef(0);
  useTaskRestore(tool.id, (restore) => {
    const generation = ++restoreGeneration.current;
    type LoanSourceParams = {
      source?: {
        inputPath?: string;
        sheet?: string;
        headerRow?: number;
        headerDepth?: number;
      };
      mapping?: LoanMapping;
    };
    const p = restore.params as {
      mode?: string;
      reportEnd?: string;
      ledgerSource?: LoanSourceParams;
      tbSource?: LoanSourceParams;
      jeSource?: LoanSourceParams;
      rateLedgerSource?: LoanSourceParams;
      rateRows?: PasteRateRow[];
      loanAccounts?: string[];
      interestExpenseAccounts?: string[];
      loanReviewSelections?: Array<{ entity?: string; account?: string; reviewKey?: string; name?: string; currency?: string; auxiliary?: string; role?: LoanAccountRole; selected?: boolean }>;
      outputPath?: string;
      currencyFallbackMode?: CurrencyFallbackMode;
      functionalCurrency?: string;
    };
    const paramsKey: Record<Kind, keyof typeof p> = {
      ledger: "ledgerSource",
      tb: "tbSource",
      je: "jeSource",
      rateLedger: "rateLedgerSource",
    };
    const next: Record<Kind, Source> = {
      ledger: empty(),
      tb: empty(),
      je: empty(),
      rateLedger: empty(),
    };
    let restoredAny = false;
    const restoreSources: Array<{ kind: Kind; path: string; source: NonNullable<LoanSourceParams["source"]> }> = [];
    for (const kind of ["ledger", "tb", "je", "rateLedger"] as Kind[]) {
      const src = p[paramsKey[kind]] as LoanSourceParams | undefined;
      if (!src?.source) continue;
      const path =
        typeof src.source.inputPath === "string" ? src.source.inputPath : "";
      if (!path) continue;
      restoredAny = true;
      restoreSources.push({ kind, path, source: src.source });
      next[kind] = {
        path,
        mapping:
          src.mapping && typeof src.mapping === "object" ? src.mapping : {},
      };
    }
    if (!restoredAny) return;
    const snapshot = restore.snapshot as
      | { inspections?: Partial<Record<Kind, unknown>> }
      | null;
    const snapshotComplete =
      restore.snapshotStatus === "valid" &&
      restoreSources.every((item) =>
        isLoanInspectionSnapshot(snapshot?.inspections?.[item.kind]),
      );
    if (snapshotComplete) {
      for (const item of restoreSources) {
        next[item.kind].inspection = snapshot!.inspections![item.kind] as Inspection;
      }
    }
    for (const kind of ["ledger", "tb", "je", "rateLedger"] as Kind[]) {
      const mapping = next[kind].mapping;
      restoredLoanMappings.current[kind] =
        next[kind].path && Object.keys(mapping).length
          ? { path: next[kind].path, mapping }
          : undefined;
    }
    invalidateResults();
    setSources(next);
    setRateEdits({});
    // 「确认科目与利率」的选择一并回填：确认清单按行键恢复，利率按行标识恢复。
    if (Array.isArray(p.loanAccounts))
      restoredLoanAccounts.current = p.loanAccounts;
    if (Array.isArray(p.interestExpenseAccounts))
      restoredInterestExpenseAccounts.current = p.interestExpenseAccounts;
    if (Array.isArray(p.loanAccounts) || Array.isArray(p.interestExpenseAccounts))
      setLoanAccountRoles(
        Object.fromEntries(
          [
            ...((p.loanAccounts ?? []).map((key) => [key, "loan"] as const)),
            ...((p.interestExpenseAccounts ?? []).map(
              (key) => [key, "interest_expense"] as const,
            )),
          ],
        ),
      );
    setLoanDetailRoles(
      Array.isArray(p.loanReviewSelections)
        ? Object.fromEntries(
            p.loanReviewSelections
              .filter((item) => item.reviewKey || (item.account && item.auxiliary))
              .map((item) => [
                item.reviewKey ?? reviewKey(item.entity ?? "", item.account ?? "", item.auxiliary ?? ""),
                item.role ?? (item.selected === false ? "skip" : "loan"),
              ]),
          )
        : {},
    );
    if (Array.isArray(p.rateRows))
      setTbRateEdits(
        Object.fromEntries(
          (p.rateRows as PasteRateRow[]).map((r) => [loanRowKey(r), r]),
        ),
      );
    if (p.mode === "ledger" || p.mode === "tb") setMode(p.mode);
    if (typeof p.reportEnd === "string" && p.reportEnd)
      setReportEnd(p.reportEnd);
    if (typeof p.functionalCurrency === "string")
      setFunctionalCurrency(p.functionalCurrency);
    setOutputPath(typeof p.outputPath === "string" ? p.outputPath : "");
    setCurrencyFallbackMode(
      p.currencyFallbackMode === "functional" ||
        p.currencyFallbackMode === "twoPointByCurrency"
        ? p.currencyFallbackMode
        : "",
    );
    setStep(0);
    setError("");
    if (snapshotComplete) {
      setBusy(false);
      return;
    }
    setBusy(true);
    void (async () => {
      const failures: string[] = [];
      for (const item of restoreSources) {
        try {
          const inspection = (await engineCall("loan.inspect", {
            kind: item.kind,
            source: {
              inputPath: item.path,
              sheet: item.source.sheet ?? "",
              headerRow: item.source.headerRow ?? 0,
              headerDepth: item.source.headerDepth ?? 0,
            },
          })) as Inspection;
          if (generation !== restoreGeneration.current) return;
          applyInspection(item.kind, item.path, inspection);
        } catch (e) {
          if (generation !== restoreGeneration.current) return;
          failures.push(`${fileNameOf(item.path)}：${errorText(e)}`);
        }
      }
      if (generation !== restoreGeneration.current) return;
      // TB 重新识别会清空依赖该来源的人工分类与利率；历史值在全部来源
      // 成功读回后再覆盖一次，避免“恢复成功”却悄悄丢掉用户确认。
      if (Array.isArray(p.loanAccounts))
        setLoanAccountRoles(
          Object.fromEntries(
            [
              ...p.loanAccounts.map((key) => [key, "loan"] as const),
              ...(p.interestExpenseAccounts ?? []).map(
                (key) => [key, "interest_expense"] as const,
              ),
            ],
          ),
        );
      if (Array.isArray(p.rateRows))
        setTbRateEdits(
          Object.fromEntries(
            p.rateRows.map((rate) => [loanRowKey(rate), rate]),
          ),
        );
      setCurrencyFallbackMode(
        p.currencyFallbackMode === "functional" ||
          p.currencyFallbackMode === "twoPointByCurrency"
          ? p.currencyFallbackMode
          : "",
      );
      setError(failures.join("；"));
      setBusy(false);
    })();
  });
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
    if (mode === "tb") {
      if (!tbAccounts.length)
        return setError("尚未生成科目清单，请返回“确认科目与利率”等待清单读取完成。");
      if (!selectedLoanAccounts().length)
        return setError("请至少确认一个借款科目后再继续。");
      if (method === "loan.export" && !rows.length)
        return setError("尚未生成利率明细，请先点击“生成测算预览”。");
      if (method === "loan.export" && (resultStale || !ratesConfirmed))
        return setError("当前结果待重算，或利率尚未确认。请先生成最新预览并确认利率，再导出正式底稿。");
    }
    setBusy(true);
    setActiveRun(method);
    try {
      activeJob.current = await jobStart(method, payload());
    } catch (e) {
      setBusy(false);
      setActiveRun(undefined);
      setError(errorText(e));
    }
  }
  /** 第二步只从 TB 生成可编辑的利率行；不启动 job，不读 JE，
   *  不生成本金变动、勾稽或利息结果。 */
  async function prepareRates() {
    setRatesBusy(true);
    setError("");
    try {
      const next = (await engineCall(
        "loan.prepare_rates",
        payload(),
        "生成借款利率明细",
      )) as { rows?: LoanRow[] };
      setRows(next.rows ?? []);
      setResult(undefined);
      setResultStale(false);
      setRatesConfirmed(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRatesBusy(false);
    }
  }
  // 进入第二步的币种衔接验证记忆化：底部「下一步」与步骤条导航共用本入口。
  // 验证输入（TB/JE 来源＋两侧映射＋已选借款科目＋主体口径，即完整验证请求体）
  // 不变且已通过时直接跳步，反复来回切换不再重读两本账表；输入变化或尚未
  // 通过时才重新验证。弹口径选择框（required 且未通过）与请求失败不记忆。
  const currencyLinkCheckRef = useRef<{ key: string; ok: boolean } | null>(null);
  async function enterTbRateStep() {
    if (mode !== "tb") {
      setStep(1);
      return;
    }
    const tb = sources.tb;
    const je = sources.je;
    const request = {
      tbSource: {
        inputPath: tb.path,
        sheet: tb.inspection?.sheet ?? "",
        headerRow: tb.inspection?.headerRow ?? 1,
        headerDepth: tb.inspection?.headerDepth ?? 1,
      },
      tbMapping: tb.mapping,
      jeSource: {
        inputPath: je.path,
        sheet: je.inspection?.sheet ?? "",
        headerRow: je.inspection?.headerRow ?? 1,
        headerDepth: je.inspection?.headerDepth ?? 1,
      },
      jeMapping: je.mapping,
      selectedAccounts: selectedLoanAccounts(),
      entityScope: entityScope.selection,
    };
    const key = JSON.stringify(request);
    if (currencyLinkCheckRef.current?.key === key && currencyLinkCheckRef.current.ok) {
      setError("");
      setStep(1);
      return;
    }
    setError("");
    setBusy(true);
    const link = await verifyCurrencyLink(request);
    setBusy(false);
    if (!link) {
      setError("暂时无法验证 TB 与 JE 的外币币种衔接，请重试。");
      return;
    }
    if (link.required && !link.verified) {
      setCurrencyFallbackPrompt(link);
      return;
    }
    currencyLinkCheckRef.current = { key, ok: true };
    setCurrencyFallbackMode("");
    setCurrencyFallbackPrompt(null);
    setStep(1);
  }
  /** 两种模式进入第三步都只导航，不隐式启动耗时任务。 */
  function advanceToRunStep() {
    if (!mappingsReady) {
      setError("请先补齐字段映射。");
      return;
    }
    if (mode === "tb" && (!tbAccounts.length || !selectedAccountCount || !rows.length)) {
      setError(
        !tbAccounts.length
          ? "科目清单尚未生成，请稍候。"
          : !selectedAccountCount
            ? "请至少确认一个借款科目。"
            : "利率明细尚未按当前选择生成，请留在第二步等待生成完成。",
      );
      return;
    }
    setError("");
    setStep(2);
  }
  // 导出完成后除结果区的打开按钮外，测算卡里也要有明确的「已生成＋文件名＋打开」
  // 反馈——此前唯一反馈是结果区标题旁悄悄出现的小按钮，用户感知不到已导出。
  const exported = ((result?.outputPaths ?? []) as string[]).filter(Boolean);
  const orderedTbAccounts = useMemo(() => {
    const collator = new Intl.Collator("zh-CN", { numeric: true });
    const roleRank: Record<LoanAccountRole, number> = {
      loan: 0,
      interest_expense: 1,
      skip: 2,
    };
    return loanAccountReviewRows(tbAccounts, auxLink, loanSplitEntity).sort((a, b) => {
      const roleOrder = roleRank[loanReviewRole(a)] - roleRank[loanReviewRole(b)];
      return roleOrder || collator.compare(a.code, b.code);
    });
  }, [tbAccounts, loanAccountRoles, loanDetailRoles, auxLink, loanSplitEntity]);
  /** 利率明细行（loan.preview 结果）挂到哪一行科目行：先按科目归组，再让
   *  辅助验证通过的辅助行按辅助核算认领，普通科目行兜底接收对不上的明细；
   *  账套只有辅助行、没有兜底行时挂到首行，保证逐笔利率始终有填写入口。
   *  同一笔明细只会出现一次；被改成排除/利息支出的科目在渲染层把关不展示，
   *  已填利率仍留在 tbRateEdits 里不丢。 */
  const reviewRateDetails = useMemo(() => {
    const bucket = (account: LoanAccountReviewRow) =>
      `${normKey(account.identity ?? account.key)}\u001f${normKey(account.entity ?? "")}`;
    const byAccount = new Map<string, LoanRow[]>();
    for (const row of rows) {
      const candidates = rateRowAccountKeyCandidates(row);
      const matches = orderedTbAccounts.filter((account) =>
        candidates.some((key) => [account.key, account.code, account.account]
          .some((candidate) => normKey(candidate) === key)));
      const preferred = matches.find((account) =>
        (!row.accountName || normKey(account.name) === normKey(row.accountName))
        && (!account.entity || normKey(account.entity) === normKey(row.entity))
        && (!account.currency || !row.currency || normKey(account.currency) === normKey(row.currency)))
        ?? matches.find((account) =>
          !row.accountName || normKey(account.name) === normKey(row.accountName))
        ?? matches[0];
      if (!preferred) continue;
      const accountKey = bucket(preferred);
      const list = byAccount.get(accountKey);
      if (list) list.push(row);
      else byAccount.set(accountKey, [row]);
    }
    const assignment = new Map<string, LoanRow[]>();
    const claimed = new Set<string>();
    const auxMatch = (detail: LoanRow, account: LoanAccountReviewRow) =>
      normKey(detail.auxiliary ?? "") === normKey(account.auxiliaryKey ?? "") ||
      normKey(detail.auxiliary ?? "") === normKey(account.auxiliary ?? "");
    // 第一遍：辅助明细行按辅助核算对号入座。
    for (const account of orderedTbAccounts) {
      if (!account.auxiliaryKey) continue;
      const mine = (byAccount.get(bucket(account)) ?? []).filter((detail) =>
        auxMatch(detail, account),
      );
      mine.forEach((detail) => claimed.add(loanRowKey(detail)));
      if (mine.length) assignment.set(account.reviewKey, mine);
    }
    // 第二遍：普通科目行兜底接收未被认领的明细。
    for (const account of orderedTbAccounts) {
      if (account.auxiliaryKey) continue;
      const rest = (byAccount.get(bucket(account)) ?? []).filter(
        (detail) => !claimed.has(loanRowKey(detail)),
      );
      if (!rest.length) continue;
      rest.forEach((detail) => claimed.add(loanRowKey(detail)));
      assignment.set(account.reviewKey, rest);
    }
    // 第三遍：只剩辅助行的科目（无兜底行）把孤儿明细挂到首行。
    for (const [accountKey, list] of byAccount) {
      const orphans = list.filter((detail) => !claimed.has(loanRowKey(detail)));
      if (!orphans.length) continue;
      const target = orderedTbAccounts.find(
        (account) => bucket(account) === accountKey,
      );
      if (!target || loanReviewRole(target) !== "loan") continue;
      assignment.set(target.reviewKey, [
        ...(assignment.get(target.reviewKey) ?? []),
        ...orphans,
      ]);
      orphans.forEach((detail) => claimed.add(loanRowKey(detail)));
    }
    return assignment;
  }, [rows, orderedTbAccounts, loanAccountRoles, loanDetailRoles]);
  const confirmationRateRows = useMemo(() => {
    const seen = new Set<string>();
    return orderedTbAccounts
      .filter((account) => loanReviewRole(account) === "loan")
      .flatMap((account) => reviewRateDetails.get(account.reviewKey) ?? [])
      .filter((detail) => {
        const key = loanRowKey(detail);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [orderedTbAccounts, reviewRateDetails, loanAccountRoles, loanDetailRoles]);
  const filteredTbAccounts = useMemo(() => {
    const keyword = accountQuery.trim().toLowerCase();
    if (!keyword) return orderedTbAccounts;
    const own = (account: LoanAccountReviewRow) =>
      `${account.code} ${account.name} ${account.account} ${account.entity ?? ""} ${account.auxiliary ?? ""}`.toLowerCase();
    return orderedTbAccounts.filter(
      (account) =>
        own(account).includes(keyword) ||
        // 利率明细子行的辅助核算/名称也能搜到所属科目行。
        (reviewRateDetails.get(account.reviewKey) ?? []).some((detail) =>
          `${detail.auxiliary ?? ""} ${detail.accountName ?? ""} ${detail.loanId}`
            .toLowerCase()
            .includes(keyword),
        ),
    );
  }, [orderedTbAccounts, accountQuery, reviewRateDetails]);
  const accountPageSize = 80;
  const accountPageCount = Math.max(1, Math.ceil(filteredTbAccounts.length / accountPageSize));
  const visibleAccountPage = Math.min(accountPage, accountPageCount - 1);
  const displayedTbAccounts = filteredTbAccounts.slice(
    visibleAccountPage * accountPageSize,
    (visibleAccountPage + 1) * accountPageSize,
  );
  const goToAccountPage = (nextPage: number) => {
    const page = Math.max(0, Math.min(nextPage, accountPageCount - 1));
    setAccountPage(page);
    const first = page * accountPageSize + 1;
    const last = Math.min((page + 1) * accountPageSize, filteredTbAccounts.length);
    setAccountChangeNote(`已切换到第 ${page + 1} 页（第 ${first}–${last} 项）。`);
    requestAnimationFrame(() => accountListRef.current?.scrollTo?.({ top: 0, left: 0 }));
  };
  const selectedAccountCount = orderedTbAccounts.filter((row) => loanReviewRole(row) === "loan").length;
  const tbRunReady =
    mode !== "tb" ||
    (mappingsReady &&
      !ratesBusy &&
      tbAccounts.length > 0 &&
      selectedAccountCount > 0 &&
      rows.length > 0);
  const selectedInterestExpenseCount = tbAccounts.filter(
    (row) => loanAccountRoles[row.identity ?? row.key] === "interest_expense",
  ).length;
  /** 合并表的条件列：辅助核算列在「辅助验证展开」或「利率明细带辅助核算」时显示；
   *  主体列只在账套确实区分主体时显示，单一主体账套不浪费列宽——TB/JE 识别出
   *  多个实际主体（「默认主体」占位不算）时必须显示，其余沿用辅助拆行/利率明细
   *  自带主体的旧口径。 */
  const showAuxiliaryColumn =
    orderedTbAccounts.some((row) => Boolean(row.auxiliaryKey)) ||
    rows.some((row) => Boolean(row.auxiliary?.trim()));
  const showCurrencyColumn = tbAccounts.some((row) => Boolean(row.currency?.trim()));
  const showEntityDimension = mode !== "tb" ||
    ledgerEntityKeyEnabled(sources.tb.mapping, sources.je.mapping);
  const multiEntityLedger = useMemo(() => {
    if (!showEntityDimension) return false;
    const names = [
      ...(sources.tb.inspection?.entities ?? []),
      ...(sources.je.inspection?.entities ?? []),
    ]
      .map((value) => value.trim())
      .filter((value) => value && value !== DEFAULT_ENTITY);
    return new Set(names).size > 1;
  }, [sources.tb.inspection, sources.je.inspection, showEntityDimension]);
  const showSubject =
    showEntityDimension && (
      multiEntityLedger ||
      orderedTbAccounts.some((row) => Boolean(row.entity)) ||
      rows.some((row) => Boolean(row.entity && row.entity !== DEFAULT_ENTITY))
    );
  // 进入「确认科目与利率」即自动生成利率确认表，且科目选择（含辅助明细勾选、
  // 利息支出科目、主体范围）一变就自动按新选择重新生成：生成是必经动作，
  // 利率填写入口必须随科目类型实时出现，不再依赖「重新生成借款利率表」按钮。
  // 生成键在结果作废时由 invalidateResults 清空，作废后回到本步骤自动补一次；
  // 键值相同则不重跑，避免引擎返回空明细时陷入无限重试。
  useEffect(() => {
    if (
      mode !== "tb" ||
      step !== 1 ||
      autoRateKey.current === loanSelectionKey ||
      accountsBusy ||
      ratesBusy ||
      busy ||
      !tbAccounts.length ||
      !selectedAccountCount ||
      !mappingsReady ||
      !reportEnd
    ) {
      return;
    }
    autoRateKey.current = loanSelectionKey;
    void prepareRates();
  });
  // 表日只在第三步维护（第二步的重复字段已删）：生成过利率表后再改表日，
  // 屏幕上的利率明细与 LPR 口径就与表日脱节，作废后回到第二步会自动重新
  // 生成，手填利率存在独立状态里不会丢。
  const generatedReportEnd = useRef(reportEnd);
  useEffect(() => {
    if (generatedReportEnd.current === reportEnd) return;
    generatedReportEnd.current = reportEnd;
    if (rows.length) invalidateResults();
  }, [reportEnd, rows.length]);
  const mappingWarnings = Array.isArray(result?.mappingWarnings)
    ? result.mappingWarnings.filter((item): item is string => typeof item === "string")
    : [];
  /** 利率编辑六格（利率类型／执行利率／浮动基准／加减点／匹配状态／匹配依据）：
   *  合并表里科目行的单一明细与辅助子行共用；手填值以百分数展示
   *  （3.85 ↔ 0.0385），行键沿用 tbRateEdits（按明细行 rowKey），
   *  与合并科目确认表的下载、回传及测算 payload 同一口径。 */
  const rateEditCells = (detail: LoanRow) => {
    const e = resolvedTbRate(detail);
    const rateType = e.rateType ?? "fixed";
    const edit = tbRateEdits[loanRowKey(detail)];
    const provisional =
      rateType === "fixed" &&
      edit?.fixedRate == null &&
      detail.fixedRate == null;
    const label = `${detail.loanId}${detail.currency ? ` ${detail.currency}` : ""}`;
    return (
      <>
        <td>
          <select
            aria-label={`${label}的利率类型`}
            value={rateType}
            onChange={(ev) =>
              editTbRate(detail, {
                rateType: ev.target.value as "fixed" | "floating",
              })
            }
          >
            <option value="fixed">固定</option>
            <option value="floating">浮动</option>
          </select>
        </td>
        <td>
          <span className="loan-rate-input-stack">
            <input
              aria-label={`${label}的执行利率`}
              className="loan-manual-number"
              type="number"
              step="0.0001"
              placeholder="如 3.85"
              value={e.fixedRate == null ? "" : e.fixedRate * 100}
              disabled={rateType === "floating"}
              onChange={(ev) =>
                editTbRate(detail, {
                  fixedRate:
                    ev.target.value === "" ? undefined : Number(ev.target.value) / 100,
                })
              }
            />
            {provisional && <small className="loan-provisional-rate">暂估 3.00%</small>}
          </span>
        </td>
        <td>
          <input
            aria-label={`${label}的基准利率`}
            className="loan-manual-number"
            type="number"
            step="0.0001"
            placeholder="如 3.1"
            value={e.benchmarkRate == null ? "" : e.benchmarkRate * 100}
            disabled={rateType === "fixed"}
            onChange={(ev) =>
              editTbRate(detail, {
                benchmarkRate:
                  ev.target.value === "" ? undefined : Number(ev.target.value) / 100,
              })
            }
          />
        </td>
        <td>
          <input
            aria-label={`${label}的加减点`}
            className="loan-manual-number"
            type="number"
            step="1"
            placeholder="如 90"
            value={e.spreadBps ?? ""}
            disabled={rateType === "fixed"}
            onChange={(ev) =>
              editTbRate(detail, {
                spreadBps: ev.target.value === "" ? undefined : Number(ev.target.value),
              })
            }
          />
        </td>
        <td>{detail.matchStatus || "—"}</td>
        <td className="loan-match-basis" title={detail.matchBasis}>
          {detail.matchBasis || "—"}
        </td>
      </>
    );
  };
  const reviewSourceKey = completeLedgerPairReviewKey(
    sources.tb.inspection && [
      sources.tb.path,
      sources.tb.inspection.sheet,
      sources.tb.inspection.headerRow,
      sources.tb.inspection.headerDepth,
    ],
    sources.je.inspection && [
      sources.je.path,
      sources.je.inspection.sheet,
      sources.je.inspection.headerRow,
      sources.je.inspection.headerDepth,
    ],
  );
  return (
    <main className="tool-page fx-page loan-page">
      <PageHeader
        eyebrow="借款审计"
        title={tool.name}
        detail="从完整借款台账直接重算，或以 TB＋JE 模糊还原逐笔本金变动后测算利息。"
      />
      <ErrorBox error={step === 2 && error === terminalJobError(job) ? "" : error} onDismiss={() => setError("")} />
      <StepIndicator
        steps={[
          { key: "source", label: "上传与识别" },
          { key: "rates", label: mode === "tb" ? "确认科目与利率" : "利率确认", disabled: !sourcesReady },
          { key: "run", label: "测算与底稿", disabled: !mappingsReady || !tbRunReady },
        ]}
        current={step}
        onStepClick={(next) => {
          if (next === 1 && step === 0) void enterTbRateStep();
          else if (next === 2 && step !== 2) advanceToRunStep();
          else setStep(next);
        }}
      />
      {step !== 0 && (
        <div className="loan-mode-context" role="status">
          <strong>资料模式</strong>
          <span>{mode === "ledger" ? "完整借款台账" : "TB＋JE"}</span>
          {resultStale && <Badge variant="outline" className="badge-warning">结果待重算</Badge>}
        </div>
      )}
      <CurrencyFallbackDialog
        open={currencyFallbackPrompt !== null}
        affectedGroupCount={currencyFallbackPrompt?.affectedGroupCount ?? 0}
        missingCurrencies={currencyFallbackPrompt?.missingCurrencies ?? []}
        value={currencyFallbackMode}
        onChange={setCurrencyFallbackMode}
        onCancel={() => setCurrencyFallbackPrompt(null)}
        onContinue={() => {
          if (!currencyFallbackMode) return;
          setCurrencyFallbackPrompt(null);
          invalidateResults();
          setStep(1);
        }}
      />

      {step === 0 && (
        <>
          <section className="fx-mode-bar" data-tour="tool-mode">
            <Button
              type="button"
              variant={mode === "ledger" ? "default" : "ghost"}
              className={mode === "ledger" ? "active" : ""}
              aria-pressed={mode === "ledger"}
              onClick={() => {
                invalidateResults();
                setCurrencyFallbackMode("");
                setCurrencyFallbackPrompt(null);
                setMode("ledger");
              }}
            >
              完整借款台账
            </Button>
            <Button
              type="button"
              variant={mode === "tb" ? "default" : "ghost"}
              className={mode === "tb" ? "active" : ""}
              aria-pressed={mode === "tb"}
              onClick={() => {
                invalidateResults();
                setCurrencyFallbackMode("");
                setCurrencyFallbackPrompt(null);
                setMode("tb");
              }}
            >
              TB＋JE
            </Button>
          </section>
          <Card>
            <CardHeader>
              <CardTitle>
                {mode === "ledger" ? "上传完整借款台账" : "上传 TB 与 JE"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {mode === "tb" ? (
                <>
                  <div className="fx-source-requirements" aria-label="所需审计资料">
                    <strong>当前模式所需资料</strong>
                    <span className={sources.je.path ? "ready" : "required"}>
                      JE 序时账{sources.je.path ? "（已添加）" : "（必需）"}
                    </span>
                    <span className={sources.tb.path ? "ready" : "required"}>
                      TB 科目余额表{sources.tb.path ? "（已添加）" : "（必需）"}
                    </span>
                  </div>
                  <FileDropInput
                    containerRef={uploadDropRef}
                    value={sources.je.path || sources.tb.path}
                    displayValue={[
                      sources.je.path && `JE：${fileNameOf(sources.je.path)}${sources.je.inspection?.sheet ? ` / ${sources.je.inspection.sheet}` : ""}`,
                      sources.tb.path && `TB：${fileNameOf(sources.tb.path)}${sources.tb.inspection?.sheet ? ` / ${sources.tb.inspection.sheet}` : ""}`,
                    ]
                      .filter(Boolean)
                      .join("；")}
                    hideFilledLabel
                    disabled={busy}
                    placeholder="拖放或选择 TB、序时账文件（可同时选择）"
                    onBrowse={() => void browsePair()}
                    onDragStateChange={() => {}}
                    onClear={() => {
                      reviews.clearReview("tb");
                      reviews.clearReview("je");
                      setSource("tb", empty());
                      setSource("je", empty());
                      setPairStatus("");
                    }}
                  />
                  <div className="fx-source-grid">
                    <div className="fx-source-slot fx-source-slot-tb">
                      {sources.tb.path ? (
                        <LoanSourceCard
                          kind="tb"
                          source={sources.tb}
                          disabled={busy}
                          onReplace={() => void replaceSource("tb")}
                          onClear={() =>
                            setSource("tb", {
                              path: "",
                              inspection: undefined,
                              mapping: {},
                            })
                          }
                          onInspect={() => void inspect("tb")}
                          onKindChange={() => void changeSourceKind("tb", "je")}
                        />
                      ) : sources.je.path ? (
                        <Card className="fx-source-empty">
                          <CardHeader>
                            <CardTitle>TB 科目余额表</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <EmptyState
                              compact
                              title="还需要 TB"
                              description="TB 提供期初、期末本金，是推算借款变动的必需资料。"
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
                    <div className="fx-source-slot fx-source-slot-je">
                      {sources.je.path ? (
                        <LoanSourceCard
                          kind="je"
                          source={sources.je}
                          disabled={busy}
                          onReplace={() => void replaceSource("je")}
                          onClear={() =>
                            setSource("je", {
                              path: "",
                              inspection: undefined,
                              mapping: {},
                            })
                          }
                          onInspect={() => void inspect("je")}
                          onKindChange={() => void changeSourceKind("je", "tb")}
                        />
                      ) : sources.tb.path ? (
                        <Card className="fx-source-empty">
                          <CardHeader>
                            <CardTitle>JE 序时账</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <EmptyState
                              compact
                              title="还需要 JE"
                              description="JE 用于逐笔还原新增借款与还款。"
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
                  </div>
                </>
              ) : (
                <div className="loan-upload-grid">
                  <Upload
                    kind="ledger"
                    source={sources.ledger}
                    busy={busy}
                    browse={() => void browse("ledger")}
                    clear={() => setSource("ledger", empty())}
                  />
                </div>
              )}
              {mode === "tb" && pairStatus && (
                <p className="fx-source-status" aria-live="polite">
                  <i aria-hidden="true" />
                  {pairStatus}
                </p>
              )}
              {!activeKinds.some((kind) => sources[kind].path) && (
                <EmptyState
                  compact
                  title={
                    mode === "ledger" ? "准备完整借款台账" : "准备 TB 与 JE"
                  }
                  description={
                    mode === "ledger"
                      ? "加入包含借款标识、本金或余额、起止日期及利率信息的台账。"
                      : "同时加入科目余额表（TB）与序时账（JE），用于还原并核对本金变动。"
                  }
                />
              )}
            </CardContent>
          </Card>
          {mode === "tb" &&
            (sources.tb.inspection || sources.je.inspection) && (
              <LedgerReviewAll
                present={
                  sources.tb.inspection && sources.je.inspection
                    ? ["tb", "je"]
                    : sources.tb.inspection
                      ? ["tb"]
                      : ["je"]
                }
                names={{ tb: "TB", je: "JE" }}
                reviewing={reviews.reviewing}
                status={reviews.status}
                results={reviews.results}
                disabled={busy}
                autoReviewKey={
                  busy ? "" : reviewSourceKey
                }
                autoReviewOwner={ledgerReviewOwner.current}
                onReviewAll={() => {
                  void reviews.reviewAll({
                    tb: sources.tb.inspection
                      ? {
                          headers: sources.tb.inspection.headers,
                          preview: sources.tb.inspection.preview,
                          mapping: loanReviewMapping(sources.tb.mapping),
                          labels: resolveRoleLabels(
                            sources.tb.inspection.roles,
                            LABELS.tb,
                          ),
                          tool: "loan_interest",
                          pairLabel: "借款利息测算 TB＋JE",
                          multiColumnRoles: LOAN_MULTI_COLUMN_ROLES,
                          onApplied: (mapping) => setSource("tb", { mapping }),
                          missingAfter: (mapping) =>
                            loanMissing(
                              "tb",
                              mapping,
                              sources.tb.inspection?.forms,
                            ),
                        }
                      : undefined,
                    je: sources.je.inspection
                      ? {
                          headers: sources.je.inspection.headers,
                          preview: sources.je.inspection.preview,
                          mapping: loanReviewMapping(sources.je.mapping),
                          labels: resolveRoleLabels(
                            sources.je.inspection.roles,
                            LABELS.je,
                          ),
                          tool: "loan_interest",
                          pairLabel: "借款利息测算 TB＋JE",
                          multiColumnRoles: LOAN_MULTI_COLUMN_ROLES,
                          onApplied: (mapping) => setSource("je", { mapping }),
                          missingAfter: (mapping) =>
                            loanMissing(
                              "je",
                              mapping,
                              sources.je.inspection?.forms,
                            ),
                        }
                      : undefined,
                  });
                }}
                onUndo={reviews.undoChange}
                onAccept={reviews.acceptPending}
              />
            )}
          {activeKinds.map(
            (kind) =>
              sources[kind].inspection && (
                <Mapping
                  key={kind}
                  kind={kind}
                  source={sources[kind]}
                  busy={busy}
                  reviewing={
                    (kind === "tb" || kind === "je")
                      ? reviews.reviewing[kind]
                      : false
                  }
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
            <Button
              disabled={!sourcesReady || reviewingAny}
              onClick={() => void enterTbRateStep()}
            >
              {mode === "tb" ? "下一步：确认科目与利率" : "下一步：利率确认"}
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
            <div className="loan-confirm-workspace">
              <Card>
                <CardHeader>
                  <div className="loan-confirm-heading">
                    <div>
                      <span className="loan-section-kicker">确认科目与利率</span>
                      <CardTitle>确认借款及利息支出科目并设置利率</CardTitle>
                    </div>
                    <div className="loan-account-summary" aria-label="科目确认汇总">
                      <Badge variant="secondary">借款科目 {selectedAccountCount}</Badge>
                      <Badge variant="secondary">利息支出 {selectedInterestExpenseCount}</Badge>
                      <span>其他项目 {Math.max(0, orderedTbAccounts.length - selectedAccountCount - selectedInterestExpenseCount)}</span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                {accountsBusy ? (
                  <p className="fx-hint">正在读取科目清单…</p>
                ) : (
                  <>
                  {mappingWarnings.map((warning) => (
                    <section className="loan-warning" role="status" key={warning}>
                      <strong>{warning}</strong>
                    </section>
                  ))}
                  {/* 表日在第三步「测算与底稿」统一维护：这里只做科目与利率确认，
                      两个步骤各放一个日期只会出现改了一处忘另一处的口径分歧。 */}
                  <div className="loan-account-list-toolbar">
                    <label>
                      查找科目
                      <Input
                        value={accountQuery}
                        onChange={(event) => {
                          setAccountQuery(event.target.value);
                          setAccountPage(0);
                        }}
                        placeholder="输入编码或名称"
                      />
                    </label>
                    <label>
                      本位币
                      <select
                        value={functionalCurrency}
                        onChange={(event) => {
                          setFunctionalCurrency(event.target.value);
                          invalidateResults();
                        }}
                        title="美元等外币本位币的海外主体请选择实际本位币：余额表本位币行币种常留空、序时账逐行标币种，指定本位币后两边才能按科目归集"
                      >
                        <option value="">人民币（默认）</option>
                        <option value="USD">美元 USD</option>
                        <option value="HKD">港币 HKD</option>
                        <option value="EUR">欧元 EUR</option>
                        <option value="JPY">日元 JPY</option>
                        <option value="GBP">英镑 GBP</option>
                        <option value="AUD">澳元 AUD</option>
                        <option value="CAD">加元 CAD</option>
                        <option value="SGD">新加坡元 SGD</option>
                      </select>
                    </label>
                    {accountChangeNote && <span role="status">{accountChangeNote}</span>}
                  </div>
                  {!rows.length && (
                    <EmptyState
                      compact
                      title="等待生成利率明细"
                      description="进入本步骤后按已确认的借款科目自动生成利率明细，并在本表利率列逐笔确认；科目类型改动后也会自动刷新。若因映射缺失未自动生成，请回第一步补齐映射后再进入本步骤。"
                    />
                  )}
                  <div
                    className={`loan-account-confirm loan-confirm-table${showSubject ? " has-subject" : ""}${showAuxiliaryColumn ? " has-auxiliary" : ""}`}
                    ref={accountListRef}
                  >
                    <table>
                      <thead>
                        <tr>
                          {showSubject && <th>主体</th>}
                          <th>科目编码</th>
                          <th>科目名称</th>
                          {showCurrencyColumn && <th>币种</th>}
                          {showAuxiliaryColumn && <th>辅助核算</th>}
                          <th>科目类型</th>
                          <th>期初余额</th>
                          <th>期末余额</th>
                          <th>
                            发生额
                            <JargonTip
                              term="发生额"
                              text="优先取本年累计借贷发生额，其次取本期借贷发生额；已结转的损益科目按登记方向还原。第三步有发生额时用发生额比较，没有发生额列时才使用余额。"
                            />
                          </th>
                          <th>利率类型</th>
                          <th aria-label="执行利率（%）">
                            执行利率（%）
                            <JargonTip
                              term="执行利率"
                              text="无合同利率时暂按 2026-08-20 一年期 LPR 3.00% 预填。该数值仅用于预览，请根据合同、函证或其他审计证据确认后再导出底稿。"
                            />
                          </th>
                          <th>浮动基准（%）</th>
                          <th>
                            加减点（BP）
                            <JargonTip
                              term="加减点（BP）"
                              text="BP＝万分之一。浮动利率＝基准利率＋加减点BP÷10000。"
                            />
                          </th>
                          <th>匹配状态</th>
                          <th>匹配依据</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedTbAccounts.flatMap((a) => {
                          const role = loanReviewRole(a);
                          // 利率明细只挂在借款科目行下；改类型的科目不展示
                          // 子行，已填利率仍在 tbRateEdits 里保留。
                          const rateRows =
                            role === "loan"
                              ? reviewRateDetails.get(a.reviewKey) ?? []
                              : [];
                          const inline = rateRows.length === 1 ? rateRows[0] : undefined;
                          const detailRows = inline ? [] : rateRows;
                          return [
                          <tr
                            key={a.reviewKey}
                            className={
                              role === "loan"
                                ? "is-loan"
                                : role === "interest_expense"
                                  ? "is-interest-expense"
                                  : "is-skipped"
                            }
                          >
                            {showSubject && (
                              <td title={inline?.entity}>
                                {a.entity || (inline ? entityDisplay(inline.entity) : "—")}
                              </td>
                            )}
                            <td>{a.code}</td>
                            <td title={a.account}>{a.name || a.account}</td>
                            {showCurrencyColumn && <td>{a.currency || "—"}</td>}
                            {showAuxiliaryColumn && (
                              <td title={a.auxiliary || inline?.auxiliary || undefined}>
                                {a.auxiliary || inline?.auxiliary || "—"}
                              </td>
                            )}
                            <td>
                              <select
                                aria-label={`${a.account}的科目类型`}
                                value={role}
                                onChange={(e) => {
                                  const next = e.target.value as LoanAccountRole;
                                  if (a.auxiliaryKey || a.entity) {
                                    setLoanDetailRoles((v) => ({ ...v, [a.reviewKey]: next }));
                                  } else {
                                    setLoanAccountRoles((v) => ({ ...v, [a.identity ?? a.key]: next }));
                                  }
                                  invalidateResults();
                                  setAccountChangeNote(
                                    `${a.account}已设为${
                                      next === "loan"
                                        ? "借款科目"
                                        : next === "interest_expense"
                                          ? "利息支出科目"
                                          : "排除"
                                    }。`,
                                  );
                                }}
                              >
                                <option value="loan">借款科目</option>
                                {!a.auxiliaryKey && (
                                  <option value="interest_expense">利息支出科目</option>
                                )}
                                <option value="skip">排除</option>
                              </select>
                            </td>
                            <td className="loan-num">{a.auxiliary ? "—" : loanDisplayNumber(a.opening)}</td>
                            <td className="loan-num">{a.auxiliary ? "—" : loanDisplayNumber(a.closing)}</td>
                            <td
                              className="loan-num"
                              title={a.occurrenceBasis ?? undefined}
                            >
                              {role !== "interest_expense" || a.auxiliary || a.occurrence == null
                                ? "—"
                                : loanDisplayNumber(a.occurrence)}
                            </td>
                            {role === "loan" && inline ? (
                              rateEditCells(inline)
                            ) : role === "loan" && rateRows.length > 1 ? (
                              <>
                                <td>—</td>
                                <td>—</td>
                                <td>—</td>
                                <td>—</td>
                                <td>{rateRows.length} 笔明细</td>
                                <td className="loan-match-basis">按辅助核算拆分为 {rateRows.length} 笔，请在下方明细行逐笔设置利率</td>
                              </>
                            ) : role === "loan" ? (
                              <>
                                <td>—</td>
                                <td>—</td>
                                <td>—</td>
                                <td>—</td>
                                <td>{busy ? "生成中" : rows.length ? "无借款行" : "待生成"}</td>
                                <td className="loan-match-basis">
                                  {busy
                                    ? "正在按最新科目选择生成利率明细…"
                                    : rows.length
                                      ? "本次生成的利率明细未包含该科目；请检查借款明细列映射或科目类型选择"
                                      : "利率明细自动生成后在此填写利率"}
                                </td>
                              </>
                            ) : (
                              <>
                                <td>—</td>
                                <td>—</td>
                                <td>—</td>
                                <td>—</td>
                                <td>—</td>
                                <td>—</td>
                              </>
                            )}
                          </tr>,
                          ...detailRows.map((detail) => (
                            <tr key={`rate-${loanRowKey(detail)}`} className="is-rate-detail">
                              {showSubject && <td>{entityDisplay(detail.entity)}</td>}
                              <td>{detail.accountCode || "—"}</td>
                              <td title={detail.accountName || detail.loanId}>
                                {detail.accountName || detail.loanId}
                              </td>
                              {showCurrencyColumn && <td>{detail.currency || "—"}</td>}
                              {showAuxiliaryColumn && (
                                <td title={detail.auxiliary || undefined}>{detail.auxiliary || "—"}</td>
                              )}
                              <td>
                                <span className="loan-detail-tag">借款明细</span>
                              </td>
                              <td className="loan-num">{loanDisplayNumber(detail.openingPrincipal)}</td>
                              <td className="loan-num">{loanDisplayNumber(detail.closingPrincipal)}</td>
                              <td>—</td>
                              {rateEditCells(detail)}
                            </tr>
                          )),
                          ];
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="loan-confirm-footer">
                    <AccountConfirmationActions
                    tool="loan"
                    title="借款利息"
                    context={JSON.stringify([source("tb"), source("je"), orderedTbAccounts.map((account) => account.reviewKey), confirmationRateRows.map(loanRowKey)])}
                    columns={[
                      { key: "kind", title: "行类型" },
                      { key: "entity", title: "主体" },
                      { key: "account", title: "科目／借款明细" },
                      { key: "auxiliary", title: "辅助核算" },
                      { key: "role", title: "科目类型", editable: true, options: ["借款科目", "利息支出科目", "排除"] },
                      { key: "rateType", title: "利率类型", editable: true, options: ["固定", "浮动"] },
                      { key: "fixedRate", title: "执行利率（%）", editable: true },
                      { key: "benchmarkRate", title: "浮动基准（%）", editable: true },
                      { key: "spreadBps", title: "加减点（BP）", editable: true },
                    ]}
                    rows={[
                      ...orderedTbAccounts.map((account): ConfirmationRow => ({
                        key: `account:${account.reviewKey}`,
                        editable: [false, false, false, false, true, false, false, false, false],
                        values: ["科目", account.entity ?? "", account.account, account.auxiliary ?? "",
                          loanReviewRole(account) === "loan" ? "借款科目" : loanReviewRole(account) === "interest_expense" ? "利息支出科目" : "排除",
                          "", "", "", ""],
                      })),
                      ...confirmationRateRows.map((detail): ConfirmationRow => {
                        const edit = resolvedTbRate(detail);
                        return { key: `rate:${loanRowKey(detail)}`,
                          editable: [false, false, false, false, false, true, true, true, true],
                          values: [
                          "借款明细", detail.entity ?? "", detail.accountName || detail.loanId, detail.auxiliary ?? "", "",
                          edit.rateType === "floating" ? "浮动" : "固定",
                          edit.fixedRate == null ? "" : String(edit.fixedRate * 100),
                          edit.benchmarkRate == null ? "" : String(edit.benchmarkRate * 100),
                          edit.spreadBps == null ? "" : String(edit.spreadBps),
                        ] };
                      }),
                    ]}
                    disabled={busy || accountsBusy || ratesBusy}
                    onImport={(changed) => {
                      const accountsByKey = new Map(orderedTbAccounts.map((row) => [`account:${row.reviewKey}`, row]));
                      const ratesByKey = new Map(confirmationRateRows.map((row) => [`rate:${loanRowKey(row)}`, row]));
                      const roleUpdates: Array<{ account: LoanAccountReviewRow; role: LoanAccountRole }> = [];
                      const rateUpdates: Array<{ detail: LoanRow; patch: Partial<PasteRateRow> }> = [];
                      const percent = (value: string, label: string) => {
                        if (!value) return undefined;
                        const parsed = Number(value);
                        if (!Number.isFinite(parsed)) throw new Error(`${label}必须为数字。`);
                        return parsed / 100;
                      };
                      for (const item of changed) {
                        if (item.key.startsWith("account:")) {
                          const account = accountsByKey.get(item.key)!;
                          const role: LoanAccountRole = item.values[4] === "借款科目" ? "loan" : item.values[4] === "利息支出科目" ? "interest_expense" : "skip";
                          if (account.auxiliaryKey && role === "interest_expense") throw new Error(`${account.account}：辅助行不能设为利息支出科目。`);
                          roleUpdates.push({ account, role });
                        } else {
                          const detail = ratesByKey.get(item.key)!;
                          const spread = item.values[8] ? Number(item.values[8]) : undefined;
                          if (spread !== undefined && !Number.isFinite(spread)) throw new Error(`${detail.loanId}：加减点必须为数字。`);
                          rateUpdates.push({ detail, patch: {
                            rateType: item.values[5] === "浮动" ? "floating" : "fixed",
                            fixedRate: percent(item.values[6], `${detail.loanId}执行利率`),
                            benchmarkRate: percent(item.values[7], `${detail.loanId}浮动基准`),
                            spreadBps: spread,
                          } });
                        }
                      }
                      setLoanDetailRoles((current) => ({ ...current, ...Object.fromEntries(roleUpdates.filter(({ account }) => account.auxiliaryKey || account.entity).map(({ account, role }) => [account.reviewKey, role])) }));
                      setLoanAccountRoles((current) => ({ ...current, ...Object.fromEntries(roleUpdates.filter(({ account }) => !account.auxiliaryKey && !account.entity).map(({ account, role }) => [account.identity ?? account.key, role])) }));
                      invalidateResults();
                      setTbRateEdits((current) => {
                        const next = { ...current };
                        for (const { detail, patch } of rateUpdates) {
                          const key = loanRowKey(detail);
                          next[key] = {
                            ...(next[key] ?? { rateType: "fixed" }), ...patch,
                            entity: detail.entity, loanId: detail.loanId, rowKey: detail.rowKey,
                            accountCode: detail.accountCode, auxiliary: detail.auxiliary,
                          };
                        }
                        return next;
                      });
                    }}
                    />
                    {accountPageCount > 1 && (
                      <div className="loan-account-list-pages">
                        <Button type="button" variant="secondary" disabled={visibleAccountPage === 0} onClick={() => goToAccountPage(visibleAccountPage - 1)}>上一页</Button>
                        <span>第 {visibleAccountPage + 1} / {accountPageCount} 页</span>
                        <Button type="button" variant="secondary" disabled={visibleAccountPage >= accountPageCount - 1} onClick={() => goToAccountPage(visibleAccountPage + 1)}>下一页</Button>
                      </div>
                    )}
                  </div>
                  </>
                )}
                </CardContent>
              </Card>
            </div>
          )}
          {mode === "tb" && currencyFallbackMode && (
            <section className="loan-currency-policy" role="status">
              <strong>多币种测算口径</strong>
              <span>
                {currencyFallbackMode === "functional"
                  ? "统一使用本位币匡算：合并各币种余额，使用 JE 本位币发生额。"
                  : "按币种使用年初、年末平均值：分币种填写利率，不使用 JE 还原逐日余额。"}
              </span>
            </section>
          )}
          {mode === "tb" && entityScope.panel}
          <div className="fx-step-actions">
            <Button variant="secondary" onClick={() => setStep(0)}>
              返回上传与识别
            </Button>
            <Button
              disabled={!mappingsReady || busy || accountsBusy || ratesBusy || !tbRunReady}
              onClick={advanceToRunStep}
            >
              下一步：测算与底稿
            </Button>
          </div>
          {!mappingsReady && (
            <p className="fx-hint loan-step-gate">
              {sourcesReady ? (
                <>
                  下一步前需先补齐字段映射：{mappingGaps.join("、")}。
                  <Button variant="link" onClick={() => setStep(0)}>
                    返回补齐映射
                  </Button>
                </>
              ) : (
                "请先回到「上传与识别」完成文件识别。"
              )}
            </p>
          )}
          {mode === "tb" && mappingsReady && !tbRunReady && (
            <p className="fx-hint loan-step-gate" role="status">
              {!tbAccounts.length
                ? "正在生成科目清单。"
                : !selectedAccountCount
                  ? "请至少确认一个借款科目。"
                  : "正在按当前科目与利率生成明细；完成后才能进入测算。"}
            </p>
          )}
        </>
      )}

      {step === 2 && (
        <>
          {mode === "tb" && currencyFallbackMode && (
            <section className="loan-currency-policy" role="status">
              <strong>本次多币种口径</strong>
              <span>
                {currencyFallbackMode === "functional"
                  ? "统一使用本位币匡算"
                  : "按币种使用年初、年末平均值"}
              </span>
            </section>
          )}
          <Card>
            <CardHeader>
              <CardTitle>测算与底稿</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="loan-run-grid">
                <label>
                  资产负债表日
                  <DateInput
                    value={reportEnd}
                    onChange={setReportEnd}
                  />
                </label>
                <label>
                  输出文件
                  <span className="loan-output-row">
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
              <div className="fx-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run("loan.preview")}
                >
                  {busy && activeRun === "loan.preview"
                    ? "测算中…"
                    : mode === "tb"
                      ? "生成并复核借款变动表"
                      : "测算预览"}
                </Button>
                <Button
                  disabled={busy || (mode === "tb" && (resultStale || !ratesConfirmed || !rows.length))}
                  onClick={() => void run("loan.export")}
                >
                  {busy && activeRun === "loan.export"
                    ? "正在生成底稿…"
                    : "生成 Excel 底稿"}
                </Button>
              </div>
              {mode === "tb" && (
                <label className="loan-rate-acknowledgement">
                  <input
                    type="checkbox"
                    checked={ratesConfirmed}
                    disabled={busy || resultStale || !rows.length}
                    onChange={(event) => setRatesConfirmed(event.target.checked)}
                  />
                  <span>我已根据合同、函证或其他审计证据复核本次全部利率；其中 3.00% 暂估值不会被视为已确认依据。</span>
                </label>
              )}
              {resultStale && (
                <section className="loan-warning" role="status">
                  <strong>{result ? "当前展示的是修改前结果" : "利率已修改，等待测算"}</strong>
                  <span>{result
                    ? "参数或利率已经变化。旧结果保留供对照，但不能作为当前结果导出；请重新生成预览。"
                    : "请生成测算预览，并核对结果后再导出底稿。"}</span>
                </section>
              )}
              {!busy && !resultStale && exported.length > 0 && (
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
                  detail={step === 2 && error === terminalJobError(job) ? error : undefined}
                  onCancel={busy ? (id) => jobCancel(id) : undefined}
                />
              )}
            </CardContent>
          </Card>
          {result && rows.length > 0 && (
            <Results rows={rows} editRate={editResultRate} result={result} stale={resultStale} />
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
  const name = kind === "ledger" ? "完整借款台账" : kind.toUpperCase();
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
/** TB＋JE 模式的来源卡：与其他账表工具一致，在这里更换、移除或一键更正类型。 */
function LoanSourceCard(props: {
  kind: "tb" | "je";
  source: Source;
  disabled: boolean;
  onReplace: () => void;
  onClear: () => void;
  onInspect: () => void;
  onKindChange: () => void;
}) {
  const name = props.kind === "tb" ? "TB 科目余额表" : "JE 序时账";
  const x = props.source.inspection;
  return (
    <Card className="fx-source-card">
      <CardHeader>
        <CardTitle>已识别：{name}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="fx-detected-file">
          <button
            className="fx-file-name-button"
            type="button"
            title={`${props.source.path}（点击更换）`}
            disabled={props.disabled}
            onClick={props.onReplace}
          >
            {fileNameOf(props.source.path)}
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
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={props.disabled}
            onClick={props.onKindChange}
          >
            更正为 {props.kind === "tb" ? "JE" : "TB"}
          </Button>
        </div>
        {props.source.path && !x && (
          <Button
            variant="secondary"
            disabled={props.disabled}
            onClick={props.onInspect}
          >
            自动识别表头和字段
          </Button>
        )}
        {x && (
          <div className="fx-source-meta">
            <span>
              {x.rowCount.toLocaleString()} 行 × {x.headers.length} 列
            </span>
            <span>Sheet：{x.sheet}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Mapping({
  kind,
  source,
  busy,
  reviewing,
  change,
  header,
}: {
  kind: Kind;
  source: Source;
  busy: boolean;
  reviewing: boolean;
  change: (m: LoanMapping) => void;
  header: (s: string, r: number, d: number) => void;
}) {
  const x = source.inspection!;
  // 角色标签统一走共享解析：引擎下发的 roles（台账）优先，TB/JE 与浏览器预览
  // 模式没有 roles，回落本页标签表——清单与顺序仍由本页兜底表定。
  const labels = resolveRoleLabels(x.roles, LABELS[kind]);
  // 借款台账与利率台账不是账表；TB/JE 的联合复核入口在页面层统一呈现。
  const reviewable = kind === "tb" || kind === "je";
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
  const groupKind: LedgerFormKind =
    kind === "tb" || kind === "je" ? kind : "loan";
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
      <MappingPanel
        title={`${name}字段映射`}
        headers={x.headers}
        rows={x.preview}
        mapping={source.mapping}
        multi={LOAN_MULTI_COLUMN_ROLES}
        roles={roleList}
        groups={formGroups(
          groupKind,
          roleList,
          forms,
          source.mapping,
          // 「借款明细/辅助核算」按业务口径是选填：走借款台账时根本用不到它；
          // 走 TB＋JE 重建时缺了它，引擎在测算入口报「未从 TB 识别到借款明细」
          // 明确提示，不靠映射阶段的必填标记拦人。
        )}
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
              <Input
                controlSize="sm"
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
          </>
        }
        onChange={change}
      />
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
  mapping: LoanMapping;
  rates: LoanRateSetting[];
  busy: boolean;
  onEdit: (index: number, patch: Partial<LoanRateSetting>) => void;
}) {
  const pageSize = 100;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(inspection.preview.length / pageSize));
  const visiblePage = Math.min(page, pageCount - 1);
  const visibleRows = inspection.preview.slice(
    visiblePage * pageSize,
    (visiblePage + 1) * pageSize,
  );
  const valueAt = (row: string[], role: string) => {
    const mapped = mapping[role];
    const column = Array.isArray(mapped) ? mapped[0] : mapped;
    const index = inspection.headers.indexOf(column ?? "");
    return index >= 0 ? (row[index] ?? "") : "";
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>借款利率确认</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="loan-list-summary" role="status">
          共 {inspection.rowCount} 行，当前显示第 {visiblePage * pageSize + 1}–{Math.min((visiblePage + 1) * pageSize, inspection.preview.length)} 行；全部行均参与测算。
        </div>
        <div className="loan-rate-confirmation">
          <table>
            <thead>
              <tr>
                <th>借款标识</th>
                <th>台账利率</th>
                <th>利率类型</th>
                <th>
                  加减点（BP）
                  <JargonTip
                    term="加减点（BP）"
                    text="BP＝万分之一。浮动利率＝基准利率＋加减点BP÷10000。"
                  />
                </th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, localIndex) => {
                const index = visiblePage * pageSize + localIndex;
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
                        className="loan-rate-bps loan-manual-number"
                        step="1"
                        disabled={busy || rate.rateType !== "floating"}
                        value={rate.spreadBps}
                        onCommit={(text) =>
                          onEdit(index, { spreadBps: loanBps(text) })
                        }
                      />
                    </td>
                    <td>
                      <Badge
                        variant="outline"
                        className={sourceRate ? "badge-ready" : "badge-warning"}
                      >
                        {sourceRate ? "已识别" : "待补充"}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="loan-account-list-pages">
            <Button type="button" variant="secondary" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>上一页</Button>
            <span>第 {visiblePage + 1} / {pageCount} 页</span>
            <Button type="button" variant="secondary" disabled={visiblePage >= pageCount - 1} onClick={() => setPage(visiblePage + 1)}>下一页</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Results({
  rows,
  editRate,
  result,
  stale = false,
}: {
  rows: LoanRow[];
  editRate: (index: number, patch: ResultRateEdit) => void;
  result?: Record<string, unknown>;
  stale?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
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
    loanDisplayNumber(value, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const principalDifferenceCount = rows.filter((row) => {
    const difference = loanEquation(row);
    return difference != null && Math.abs(difference) >= 0.005;
  }).length;
  const measurementStatus = (row: LoanRow) => {
    const missingRate =
      row.rateType === "floating"
        ? row.benchmarkRate == null
        : row.fixedRate == null;
    if (missingRate) return "待填利率";
    if (row.matchStatus === "已匹配") return "已确认";
    if (row.matchStatus === "两点法推算") return "两点法推算";
    return "时点待确认";
  };
  const measurementReviewCount = rows.filter(
    (row) => measurementStatus(row) !== "已确认",
  ).length;
  const visibleRows = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      const keyword = query.trim().toLowerCase();
      const matchesQuery =
        !keyword ||
        `${row.entity} ${row.loanId} ${row.accountCode ?? ""} ${row.accountName ?? ""} ${row.auxiliary ?? ""}`
          .toLowerCase()
          .includes(keyword);
      const difference = loanEquation(row);
      const isException =
        (difference != null && Math.abs(difference) >= 0.005) ||
        measurementStatus(row) !== "已确认";
      return matchesQuery && (!exceptionsOnly || isException);
    });
  const summary = (result?.summary ?? {}) as Record<string, unknown>;
  const hasInterestExpenseAccount = summary.hasInterestExpenseAccount === true;
  const bookedInterestExpense = Number(summary.bookedInterestExpense ?? 0);
  const interestExpenseDifference = Number(
    summary.interestExpenseDifference ?? total - bookedInterestExpense,
  );
  const metric = (label: string, value: number | string, detail?: string) => (
    <div className="fx-bridge-metric">
      <span>{label}</span>
      <strong>{typeof value === "number" ? amount(value) : value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
  return (
    <section className="loan-results">
      <div className="fx-result-heading">
        <h3>借款本金变动与利息测算</h3>
        {!stale && ((result?.outputPaths ?? []) as string[]).map((p) => (
          <Button
            key={p}
            variant="secondary"
            onClick={() => void openOutput(p)}
          >
            打开 Excel 底稿
          </Button>
        ))}
      </div>
      <div className="loan-result-overview" role="status">
        {stale && <Badge variant="outline" className="badge-warning">结果待重算，仅供对照</Badge>}
        <Badge variant="outline" className={principalDifferenceCount ? "badge-warning" : "badge-ready"}>
          {principalDifferenceCount ? `${principalDifferenceCount} 笔本金有差异` : "本金已勾稽"}
        </Badge>
        <Badge variant="outline" className={measurementReviewCount ? "badge-warning" : "badge-ready"}>
          {measurementReviewCount ? `${measurementReviewCount} 笔计息口径待确认` : "计息口径已确认"}
        </Badge>
      </div>
      <div className="loan-result-filters">
        <label>
          搜索结果
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="主体、科目、借款标识或辅助核算" />
        </label>
        <label className="loan-exception-filter">
          <input type="checkbox" checked={exceptionsOnly} onChange={(event) => setExceptionsOnly(event.target.checked)} />
          只看有差异或待确认
        </label>
        <span>显示 {visibleRows.length} / {rows.length} 行</span>
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
          {/* 与明细列头统一叫「本期归还」（UI 审计 P3-1），同一金额两个叫法会被当成两个数。 */}
          {metric("本期归还", totals.reductions)}
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
          {metric("测算利息支出", total)}
          {metric(
            "TB 利息支出",
            hasInterestExpenseAccount ? bookedInterestExpense : "未选择科目",
          )}
          {metric(
            "差异（测算－TB）",
            hasInterestExpenseAccount ? interestExpenseDifference : "—",
          )}
        </div>
      </div>
      <div className="loan-rate-table">
        <table>
          <thead>
            <tr>
              <th>主体</th>
              <th>借款标识</th>
              <th>币种</th>
              <th>期初本金</th>
              <th>本期增加</th>
              <th>本期归还</th>
              <th>推算期末</th>
              <th>台账／TB 期末</th>
              <th>本金差异</th>
              <th>本金勾稽</th>
              <th>利率类型</th>
              <th>固定/基准利率</th>
              <th>加点 BP</th>
              <th>有效利率</th>
              <th>测算利息</th>
              <th>
                计息口径{" "}
                <JargonTip
                  term="计息口径"
                  text={"已确认：利率与本金时点均有明确依据。\n待填利率：尚未填写该笔借款利率。\n时点待确认：归还或新增时点由账表推算，不代表本金勾稽有差异。\n两点法推算：按（期初＋期末）÷2 估算全年平均本金。"}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ row: r, index: i }) => {
              const inferredClosing = r.openingPrincipal + r.additions - r.reductions;
              const principalDifference = loanEquation(r);
              return <tr key={`${r.loanId}-${i}`}>
                <td>{!r.entity || r.entity === "默认主体" ? "未区分主体" : r.entity}</td>
                <td title={[r.loanId, r.matchBasis].filter(Boolean).join("\n")}>{r.loanId}</td>
                <td>{r.currency || "—"}</td>
                {[
                  r.openingPrincipal,
                  r.additions,
                  r.reductions,
                  inferredClosing,
                  r.ledgerClosing ?? null,
                  principalDifference,
                ].map((n, j) => (
                  <td key={j} className={j === 5 && principalDifference != null && Math.abs(principalDifference) >= 0.005 ? "loan-principal-difference" : undefined}>
                    {n == null ? "—" : loanDisplayNumber(Number(n), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                ))}
                <td>
                  <Badge variant="outline" className={principalDifference == null ? "badge-warning" : Math.abs(principalDifference) < 0.005 ? "badge-ready" : "badge-warning"}>
                    {principalDifference == null ? "未比较" : Math.abs(principalDifference) < 0.005 ? "一致" : "有差异"}
                  </Badge>
                </td>
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
                    className="loan-manual-number"
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
                    className="loan-manual-number"
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
                    : loanEffectiveRate(
                        r.rateType,
                        r.fixedRate,
                        r.benchmarkRate,
                        r.spreadBps,
                      ) === 0
                      ? "0%"
                      : `${(
                          loanEffectiveRate(
                            r.rateType,
                            r.fixedRate,
                            r.benchmarkRate,
                            r.spreadBps,
                          ) * 100
                        ).toFixed(4)}%`}
                </td>
                <td>{loanDisplayNumber(Number(r.calculatedInterest ?? 0))}</td>
                <td>
                  <Badge
                    variant="outline"
                    className={
                      measurementStatus(r) === "已确认"
                        ? "badge-ready"
                        : "badge-warning"
                    }
                    title={r.matchBasis}
                  >
                    {measurementStatus(r)}
                  </Badge>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
