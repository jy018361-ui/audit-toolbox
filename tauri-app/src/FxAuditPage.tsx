import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ToolManifest, JobEvent } from "./types";
import { useTaskRestore } from "./restore";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenPositionedFileDrops,
  listenJobEvents,
  openOutput,
  pickPath,
} from "./api";
import { PageHeader } from "@/components/PageHeader";
import { AuxiliaryLinkStatusView } from "@/components/AuxiliaryLinkStatus";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress, terminalJobError } from "@/components/JobProgress";
import { DateInput } from "@/components/DateInput";
import { JargonTip } from "@/components/JargonTip";
import { defaultBalanceSheetDate } from "@/dateDefaults";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DEFAULT_ENTITY,
  dropUnlinkedTbAuxiliary,
  ledgerEntitiesByAccount,
  ledgerEntityKeyEnabled,
  ledgerHasMappedRole,
  ledgerMultiEntityCombos,
  ledgerRowEntities,
  correctLedgerSourceKinds,
  missingGoldIdentity,
  resolveRoleLabels,
  scanLedgerUploadSources,
  selectLedgerSourcePair,
  type AuxiliaryLinkResult,
  type EngineRoleLabels,
  type LedgerWorkbookSheetClassification,
} from "@/ledgerMapping";
import {
  describeForm,
  formGroups,
  resolveForm,
  roleRequirement,
  useLedgerForms,
} from "@/ledgerForms";
import { MappingPanel } from "@/components/MappingPanel";
import { StepIndicator } from "@/components/StepIndicator";
import {
  completeLedgerPairReviewKey,
  LedgerReviewAll,
  useLedgerDictReviews,
} from "@/components/LedgerReviewAll";
import {
  KeywordFilter,
  keywordFilterPredicate,
} from "@/components/KeywordFilter";
import { useEntityScopeConfirmation } from "@/components/EntityScopeConfirmation";
import "./fx-audit.css";
import { AccountConfirmationActions, type ConfirmationRow } from "./AccountConfirmationActions";
import { displayFileName } from "./fileDisplay";

type Mode = "realized" | "unrealized" | "combined";
const FX_ACCOUNT_PAGE_SIZE = 250;

export function fxRequiredSources(mode: Mode): { je: boolean; tb: boolean } {
  return {
    je: mode !== "unrealized",
    tb: mode !== "realized",
  };
}

/** 科目粒度不足、TB 缺外币余额行等情形只作下方黄色提示，不在这里拦成红横幅：
 *  科目年初年末本来就没有外币余额、当期只有已实现汇兑损益时，TB 和 JE 都没问题。 */
export function fxResultTrustStatus(summary: Record<string, unknown>): {
  tone: "limited" | "usable";
  title: string;
  detail: string;
} {
  if (summary.formalMeasurementAvailable === false) {
    return {
      tone: "limited",
      title: "当前仅能形成诊断测算",
      detail:
        "正式测算所需的字段或余额滚动校验尚未通过；可查看诊断结果定位问题，但不能据此生成底稿。",
    };
  }
  const tbKnown = summary.tbFxGainLoss != null;
  const needsReview =
    Boolean(summary.needsZeroResultReview) ||
    (tbKnown && summary.reconciliationPassed !== true);
  if (needsReview) {
    return {
      tone: "limited",
      title: "结果受限，需人工复核",
      detail:
        "测算已完成，但仍有差异或待确认事项。请复核下方提示后再生成最终底稿。",
    };
  }
  return {
    tone: "usable",
    title: "测算结果可供复核",
    detail: "关键资料已具备。请核对差异与凭证分类，确认后生成 Excel 底稿。",
  };
}
type Inspection = {
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
  /** 账里真实存在的「主体×科目」组合；旧任务/预览模式缺省。 */
  entityAccounts?: Array<{ entity: string; account: string }>;
  suggestedMapping: Record<string, string>;
  /** 引擎随识别结果全量下发的角色标签（`{name,label}`）；缺失时回落本页的标签表。 */
  roles?: EngineRoleLabels;
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
  foreignCurrencyNeedsConfirmation?: boolean;
  foreignCurrencyCandidates?: Array<{
    column: string;
    confidence: number;
    foreignCurrencies: string[];
  }>;
  uniformCurrency?: string | null;
  entityCurrencies?: Record<string, string>;
  sampledPreview?: boolean;
  accountRoleSuggestions?: Record<string, string>;
  accountRoleDetails?: Record<
    string,
    {
      role: string;
      confidence: number;
      needsConfirmation: boolean;
      reason: string;
      subtype?: string | null;
    }
  >;
  accountCurrencyDetails?: Record<
    string,
    {
      detected: string;
      source: string;
      seen: string[];
      needsConfirmation: boolean;
      columnSeen?: string[];
      columnDetected?: string;
      functionalDetected?: string;
    }
  >;
};
function isFxInspectionSnapshot(value: unknown): value is Inspection {
  if (!value || typeof value !== "object") return false;
  const inspection = value as Partial<Inspection>;
  return (
    Array.isArray(inspection.headers) &&
    Array.isArray(inspection.preview) &&
    Array.isArray(inspection.sheets) &&
    Array.isArray(inspection.entities) &&
    Array.isArray(inspection.accounts) &&
    typeof inspection.rowCount === "number" &&
    Boolean(inspection.headerDetection)
  );
}
// 与 Rust `supported_currencies()` 严格一致；下拉选择不得产生后端不支持的币种。
const CURRENCY_OPTIONS = [
  "CNY",
  "USD",
  "HKD",
  "EUR",
  "JPY",
  "GBP",
  "AUD",
  "NZD",
  "SGD",
  "CHF",
  "CAD",
  "MOP",
  "MYR",
  "RUB",
  "ZAR",
  "KRW",
  "AED",
  "SAR",
  "HUF",
  "PLN",
  "DKK",
  "SEK",
  "NOK",
  "TRY",
  "MXN",
  "THB",
];

/**
 * 本位币只能从币种清单选择。把识别值与历史记录里的值并入常备清单，
 * 既不丢冷门币种，也不再允许自由输入任意三个字符。
 */
export function fxCurrencyOptions(...detected: Array<string | null | undefined>) {
  return [
    ...new Set(
      [...detected, ...CURRENCY_OPTIONS]
        .map((code) => String(code ?? "").trim().toUpperCase())
        .filter((code) => CURRENCY_OPTIONS.includes(code)),
    ),
  ];
}

/**
 * 第二步清单只来自 TB 余额表：该步是 TB 科目类型确认，与 JE 无关
 * （与借款利息、FA 账表核对同口径）。清单内部仍按编码归并，同编码的
 * “裸编码”行让位给带名称的行；TB 同编码确有多个不同名称的明细户时全部保留。
 */
export function fxAccountDisplayList(tbAccounts: string[] = []) {
  const groups = new Map<string, string[]>();
  for (const raw of tbAccounts) {
    const account = raw.trim();
    if (!account) continue;
    const first = account.split(/\s+/)[0];
    const key = /^\d[\d.\-]*$/.test(first)
      ? `code:${first.toUpperCase()}`
      : `text:${account.toUpperCase()}`;
    const values = groups.get(key) ?? [];
    if (!values.includes(account)) values.push(account);
    groups.set(key, values);
  }
  return [...groups.values()].flatMap((values) => {
    // 同编码可能确实对应多个明细户，名称不同的行必须保留；这里只在至少一侧
    // 有名称时去掉另一侧的“裸编码”重复项。
    const named = values.filter((value) => /\s/.test(value));
    return named.length ? named : values.slice(0, 1);
  });
}

type FxAccountReviewRow = {
  key: string;
  account: string;
  /** 辅助核算拆行所属主体（联动验证组下发）；末级兜底行没有主体信息。 */
  entity?: string;
  auxiliary?: string;
};

/** 逐辅助户覆盖键：主体␟归一化科目编码␟归一化辅助值，与存款利息同口径。 */
const fxDetailKey = (entity: string, account: string, auxiliary: string) =>
  `${entity}\u001f${account}\u001f${auxiliary}`;

/** 与后端 normalize_account_code 同口径：编码段大写并去前导零。 */
export function fxAccountCodeOf(account: string): string {
  const token = account.split(/\s+/).find((t) => {
    const digits = (t.match(/\d/g) ?? []).length;
    return digits >= 3 && digits * 2 >= t.length && /^\d/.test(t);
  });
  const code = (token ?? account.trim()).toUpperCase();
  return code.replace(/^0+(?=\d)/, "");
}

/**
 * 第二步清单的行粒度：公共辅助核算联动验证确认「TB 辅助值在 JE 对应列
 * 完整命中」的科目按辅助明细拆行；TB 里同一科目出现在多个主体名下、且
 * 主体已成为匹配键时按「主体×科目」拆行（主体清单来自引擎识别下发的
 * 真实组合）；其余（无辅助列、未验证通过）停在末级科目并保留兜底行。
 * 与存款利息／借款利息同一口径。
 */
export function fxAccountReviewRows(
  accounts: string[],
  link: AuxiliaryLinkResult | null,
  entitiesByAccount: Map<string, string[]> | null = null,
): FxAccountReviewRow[] {
  return accounts.flatMap((account) => {
    const code = fxAccountCodeOf(account);
    const groups = (link?.groups ?? []).filter(
      (group) => group.account === code,
    );
    const expanded = groups.flatMap((group) =>
      group.reviewVerified
        ? (group.details ?? []).map((detail) => ({
            key: fxDetailKey(group.entity, group.account, detail.key),
            account,
            entity: group.entity,
            auxiliary: detail.display,
          }))
        : [],
    );
    const rowEntities =
      entitiesByAccount?.get(code) ?? (entitiesByAccount ? [] : undefined);
    const baseEntities = ledgerRowEntities(rowEntities) ?? [undefined];
    // 兜底行判定：未拆主体时沿用旧口径——只要还有未验证的辅助组就保留
    // 一行科目合计；按主体拆行时，已有验证通过辅助展开的主体不再补行。
    const allGroupsVerified =
      groups.length > 0 && groups.every((group) => group.reviewVerified);
    const hasVerifiedGroup = (baseEntity: string | undefined) =>
      baseEntity === undefined
        ? allGroupsVerified
        : groups.some(
            (group) =>
              group.reviewVerified && group.entity === baseEntity,
          );
    const fallbacks = baseEntities
      .filter((baseEntity) => !hasVerifiedGroup(baseEntity))
      .map((baseEntity) => {
        if (!baseEntity) return { key: account, account };
        return {
          key: `${baseEntity}\u001f${account}`,
          account,
          entity: baseEntity,
        };
      });
    return [...expanded, ...fallbacks];
  });
}

/** 只有全账认定了同一 JE 列才回填辅助映射；逐科目不同列绝不拼成多列。 */
export function fxLinkedJeAuxiliaryColumn(link: AuxiliaryLinkResult | null): string | null {
  if (!link) return null;
  const columns = new Set(
    (link.groups ?? [])
      .filter((group) => group.status === "verified" && group.column)
      .map((group) => group.column as string),
  );
  if (!link.groups?.length && link.status === "verified" && link.column)
    columns.add(link.column);
  return columns.size === 1 ? [...columns][0] : null;
}

/**
 * 科目确认先呈现真正参与汇兑测算的科目：货币性资产／负债与汇兑损益；
 * 非货币性项目、其他损益成本和排除项沉到后面。组内保持 TB 原始顺序，
 * 避免同一类科目在角色状态刷新后互相跳位。
 */
export function fxSortAccountReviewRows(
  rows: FxAccountReviewRow[],
  accountRoles: Record<string, string>,
  detailRoles: Record<string, string>,
): FxAccountReviewRow[] {
  const priority = (row: FxAccountReviewRow) => {
    const role = detailRoles[row.key] ?? accountRoles[row.account] ?? "non_monetary";
    if (role === "monetary_asset" || role === "monetary_liability" || role === "fx_gain_loss")
      return 0;
    if (role === "non_monetary") return 1;
    if (role === "other_pnl") return 2;
    return 3;
  };
  return rows
    .map((row, index) => ({ row, index, priority: priority(row) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ row }) => row);
}

/**
 * 科目确认表是否需要「主体」列：TB/JE 识别出的**实际**主体（去空白、剔除
 * 「默认主体」占位）去重后多于一个才显示；单主体账套维持原有三列布局。
 */
export function fxMultiEntityNames(
  jeEntities: readonly string[] = [],
  tbEntities: readonly string[] = [],
): string[] {
  return [
    ...new Set(
      [...jeEntities, ...tbEntities]
        .map((value) => value.trim())
        .filter((value) => value && value !== DEFAULT_ENTITY),
    ),
  ];
}

/** 确认表与第二步清单使用同一行粒度；筛选和「继续显示」都不截断导出。 */
export function fxConfirmationRows(
  reviewRows: FxAccountReviewRow[],
  accountRoles: Record<string, string>,
  detailRoles: Record<string, string>,
  accountCurrencies: Record<string, string>,
  detailCurrencies: Record<string, string>,
  jeCurrencyDetails: Inspection["accountCurrencyDetails"],
  tbCurrencyDetails: Inspection["accountCurrencyDetails"],
  fallbackFunctional: string,
  /** 多主体账套在首列导出「主体」；末级兜底行主体未知，导出为空。 */
  withEntity = false,
): ConfirmationRow[] {
  return reviewRows.map((row) => {
    const role = detailRoles[row.key] ?? accountRoles[row.account] ?? "non_monetary";
    const roleLabel = ROLE_OPTIONS.find(([value]) => value === role)?.[1] ?? "非货币性项目";
    const currency = role === "non_monetary" || role === "other_pnl"
      ? "N/A"
      : (row.auxiliary ? detailCurrencies[row.key] : accountCurrencies[row.account]) ||
        fxAccountCurrencyDetail(row.account, jeCurrencyDetails, tbCurrencyDetails).detected ||
        fallbackFunctional;
    const subject = row.auxiliary ? `${row.account} · ${row.auxiliary}` : row.account;
    return {
      key: row.key,
      values: withEntity
        ? [
            row.entity && row.entity !== DEFAULT_ENTITY ? row.entity : "",
            subject,
            roleLabel,
            currency,
          ]
        : [subject, roleLabel, currency],
    };
  });
}

/** 回传按稳定行键落到逐户或科目级状态，不能把辅助行误写成科目级覆盖。 */
export function fxConfirmationImportPatches(
  changed: ConfirmationRow[],
  reviewRows: FxAccountReviewRow[],
  currentRows: ConfirmationRow[],
  accountRoles: Record<string, string>,
  accountCurrencies: Record<string, string>,
  jeCurrencyDetails: Inspection["accountCurrencyDetails"],
  tbCurrencyDetails: Inspection["accountCurrencyDetails"],
  fallbackFunctional: string,
  /** 与导出版式一致：带主体列时「分类／账户币种」各右移一列。 */
  withEntity = false,
) {
  const reviewByKey = new Map(reviewRows.map((row) => [row.key, row]));
  const currentByKey = new Map(currentRows.map((row) => [row.key, row]));
  const roles: Record<string, string> = {};
  const detailRoles: Record<string, string> = {};
  const currencies: Record<string, string> = {};
  const detailCurrencies: Record<string, string> = {};
  const detailRoleDeletes: string[] = [];
  const detailCurrencyDeletes: string[] = [];
  const roleIndex = withEntity ? 2 : 1;
  const currencyIndex = withEntity ? 3 : 2;
  for (const item of changed) {
    const row = reviewByKey.get(item.key);
    const original = currentByKey.get(item.key);
    if (!row || !original) throw new Error(`科目 ${item.key} 已不在当前确认清单，请重新下载。`);
    const role = ROLE_OPTIONS.find(([, label]) => label === item.values[roleIndex])?.[0];
    if (!role) throw new Error(`${item.key}：请选择有效的分类。`);
    const currency = item.values[currencyIndex].trim().toUpperCase();
    if (currency && currency !== "N/A" && !CURRENCY_OPTIONS.includes(currency))
      throw new Error(`${item.key}：请选择有效的账户币种。`);
    if (item.values[roleIndex] !== original.values[roleIndex]) {
      if (row.auxiliary) {
        if (role === (accountRoles[row.account] ?? "non_monetary")) detailRoleDeletes.push(row.key);
        else detailRoles[row.key] = role;
      }
      else roles[row.account] = role;
    }
    if (item.values[currencyIndex] !== original.values[currencyIndex] || role === "non_monetary" || role === "other_pnl") {
      const detected = fxAccountCurrencyDetail(row.account, jeCurrencyDetails, tbCurrencyDetails).detected;
      const inherited = (row.auxiliary ? accountCurrencies[row.account] : "") || detected || fallbackFunctional;
      const override = role === "non_monetary" || role === "other_pnl" || currency === "N/A" || currency === inherited
        ? ""
        : currency;
      if (row.auxiliary) {
        if (override) detailCurrencies[row.key] = override;
        else detailCurrencyDeletes.push(row.key);
      }
      else currencies[row.account] = override;
    }
  }
  return { roles, detailRoles, currencies, detailCurrencies, detailRoleDeletes, detailCurrencyDeletes };
}

/**
 * 逐辅助户的手选币种进 payload：留空不传；对应行按非货币性项目／其他损益
 * 成本分类时也不传（这类行界面固定 N/A，残留旧选择不得影响口径）。
 */
export function fxDetailCurrencyOverridesPayload(
  selections: Record<string, string>,
  reviewRows: FxAccountReviewRow[],
  roles: Record<string, string>,
  detailRoles: Record<string, string>,
) {
  const accountByKey = new Map(reviewRows.map((row) => [row.key, row.account]));
  return Object.fromEntries(
    Object.entries(selections)
      .map(([key, code]) => [key, code.trim().toUpperCase()] as const)
      .filter(([key, code]) => {
        if (!code) return false;
        const role = detailRoles[key] ?? roles[accountByKey.get(key) ?? ""];
        return role !== "non_monetary" && role !== "other_pnl";
      }),
  );
}

type SourceClassification = LedgerWorkbookSheetClassification & {
  reasons: string[];
};
type VoucherClassification =
  "已实现汇兑损益" | "未实现汇兑损益" | "不构成汇兑事项";

const JE_LABELS: Record<string, string> = {
  id: "凭证识别字段",
  voucherType: "凭证类型",
  entity: "公司/核算主体",
  date: "记账日期",
  accountCode: "科目编码",
  accountName: "科目名称",
  // 币种分两列，与科目余额表同口径：原币币种逐行可变，本位币币种整列同值。
  currency: "原币币种",
  functionalCurrency: "本位币币种",
  summary: "摘要",
  auxiliary: "辅助核算",
  direction: "借贷方向（原币与本位币共用）",
  foreignAmount: "原币净额",
  foreignDebit: "原币借方",
  foreignCredit: "原币贷方",
  functionalAmount: "本位币净额",
  functionalDebit: "本位币借方",
  functionalCredit: "本位币贷方",
};
const TB_LABELS: Record<string, string> = {
  entity: "公司/核算主体",
  accountCode: "科目编码",
  accountName: "科目名称",
  currency: "原币币种列",
  auxiliary: "辅助核算",
  functionalCurrency: "本位币币种",
  openingDirection: "期初方向",
  closingDirection: "期末方向",
  openingFunctionalAmount: "期初本位币净额",
  openingFunctionalDebit: "期初本位币借方",
  openingFunctionalCredit: "期初本位币贷方",
  openingForeignAmount: "期初原币净额",
  openingForeignDebit: "期初原币借方",
  openingForeignCredit: "期初原币贷方",
  closingFunctionalAmount: "期末本位币净额",
  closingFunctionalDebit: "期末本位币借方",
  closingFunctionalCredit: "期末本位币贷方",
  closingForeignAmount: "期末原币净额",
  closingForeignDebit: "期末原币借方",
  closingForeignCredit: "期末原币贷方",
  ytdFunctionalDebit: "本年累计本位币借方",
  ytdFunctionalCredit: "本年累计本位币贷方",
  ytdForeignDebit: "本年累计原币借方",
  ytdForeignCredit: "本年累计原币贷方",
  periodFunctionalDebit: "本期本位币借方",
  periodFunctionalCredit: "本期本位币贷方",
};

/**
 * 下拉框的分组。必填还是可选、要不要选一种记法，由**组标题**统一交代——
 * 原先每一项后面都挂「（二选一）」，满屏括号反而看不出哪几项是一伙的。
 *
 * 分组与 TB 六型／JE 三型对应：期初、期末各是一个槽，槽内几种记法任选其一。
 */
const ROLE_OPTIONS = [
  ["monetary_asset", "货币性资产"],
  ["monetary_liability", "货币性负债"],
  ["non_monetary", "非货币性项目"],
  ["fx_gain_loss", "汇兑损益"],
  ["other_pnl", "其他损益/成本科目"],
];

/** 合并 TB 与 JE 两侧对同一科目的币种识别结果，供「外币」列展示。 */
export function fxAccountCurrencyDetail(
  account: string,
  jeDetails: Record<
    string,
    {
      detected: string;
      source: string;
      seen: string[];
      needsConfirmation: boolean;
      columnSeen?: string[];
      columnDetected?: string;
      functionalDetected?: string;
    }
  > = {},
  tbDetails: Record<
    string,
    {
      detected: string;
      source: string;
      seen: string[];
      needsConfirmation: boolean;
      columnSeen?: string[];
      columnDetected?: string;
      functionalDetected?: string;
    }
  > = {},
) {
  // 账户币种只取原币币种列。TB 列优先；JE 只有同一科目
  // 所有行币种完全一致时才可作为复核展示，多币种仍列入 seen。
  //
  // 精确名取不到就按科目编码取：TB 与 JE 的科目名拼法常常不同——4800 上
  // TB 写「1002010017 货币资金 货币资金-银行存款-建设银行」、JE 写
  // 「1002010017 银行存款-建行RMB3250-4800」，**两边全名完全相同的是 0 个**，
  // 按编码却能对上 54 个。只按全名查，JE 侧识别出的真实币种就传不到 TB 那一行，
  // 同一个科目会一行显示 HKD、另一行显示「USD（按本位币）」。
  // 与后端 `currency_for` 的覆盖回退是同一套规则。
  const pick = (
    details: Record<
      string,
      {
        detected: string;
        source: string;
        seen: string[];
        needsConfirmation: boolean;
        columnSeen?: string[];
        columnDetected?: string;
        functionalDetected?: string;
      }
    >,
  ) => {
    const exact = details[account];
    if (exact) return exact;
    const code = account.trim().split(/\s+/)[0];
    return Object.entries(details).find(
      ([candidate]) => candidate.trim().split(/\s+/)[0] === code,
    )?.[1];
  };
  const je = pick(jeDetails);
  const tb = pick(tbDetails);
  const columnSeen = (detail: typeof je) =>
    detail?.columnSeen ?? (detail?.source === "币种列" ? detail.seen : []);
  const functionalCurrency = (detail: typeof je) =>
    detail?.functionalDetected ??
    (detail?.source === "本位币列" ? detail.detected : "");
  const tbColumns = columnSeen(tb);
  const jeColumns = columnSeen(je);
  const selected = tbColumns.length
    ? {
        detected: tb?.columnDetected || tb?.detected || tbColumns[0],
        source: "币种列",
        side: "TB" as const,
        fellBack: false,
      }
    : jeColumns.length === 1
          ? {
              detected: je?.columnDetected || jeColumns[0],
              source: "币种列",
              side: "JE" as const,
              fellBack: false,
            }
          : functionalCurrency(tb)
            ? {
                detected: functionalCurrency(tb),
                source: "本位币列",
                side: "TB" as const,
                fellBack: true,
              }
            : functionalCurrency(je)
              ? {
                  detected: functionalCurrency(je),
                  source: "本位币列",
                  side: "JE" as const,
                  fellBack: true,
                }
              : {
                  detected: "",
                  source: "",
                  side: "" as const,
                  fellBack: true,
                };
  const seen = [
    ...new Set(
      [
        ...(je?.seen ?? []),
        ...(tb?.seen ?? []),
        ...jeColumns,
        ...tbColumns,
      ].filter(Boolean),
    ),
  ];
  return {
    detected: selected.detected,
    source: selected.source,
    // 结论取自哪份文件——界面在「外币」列直接标出来，用户不必悬浮才知道
    // 这个 USD 是 TB 上写着的还是从 JE 凭证里推出来的。
    side: selected.side,
    seen,
    // 两侧都没给出真凭据时才算「没识别出来」，界面标注「按本位币」。
    fellBack: selected.fellBack,
    // 同一科目下挂了多种币种：TB 往往只给这个科目一个**合计**余额，
    // 这时把它指定成单一币种，等于拿一种汇率去重估几种币种的合计数。
    // 实测 4800 的「过渡银行」有 CNY／HKD／JPY／USD 四种、合计恰好为零，
    // 指定成 CNY 后未实现从 -3,395 跳到 7,613 万——全是假数。
    multiCurrency: seen.length > 1,
    // JE 是逐笔明细；同一科目在 JE 币种列出现多个币种时，应在测算前立即
    // 提醒用户复核 TB 是否按币种拆行，不能等用户手工选了单一币种才告警。
    jeMultiCurrency: jeColumns.length > 1,
  };
}

/** 科目筛选的匹配文本：科目本身＋该科目出现过的币种，支持按币种（如 USD）筛科目。 */
export function fxAccountFilterText(
  account: string,
  jeDetails: Record<
    string,
    {
      detected: string;
      source: string;
      seen: string[];
      needsConfirmation: boolean;
    }
  > = {},
  tbDetails: Record<
    string,
    {
      detected: string;
      source: string;
      seen: string[];
      needsConfirmation: boolean;
    }
  > = {},
) {
  const { seen } = fxAccountCurrencyDetail(account, jeDetails, tbDetails);
  return [account, ...seen].join(" ");
}

/**
 * 「外币」列括号里的来源短标签——告诉用户这个币种是**怎么取到的**。
 *
 * 依据强度从高到低：TB 原币币种列＞同一科目全部行一致的
 * JE 原币币种列＞按本位币。JE 币种列出现多币种时不自动采纳。
 * 前两种再标出来自 TB 还是 JE：同一个科目 TB 只有一行合计、JE 有逐笔凭证，
 * 用户判断可信度时这个区别很重要。
 */
/**
 * 三层依据全空时，科目实际按**界面上填的本位币**处理——后端各处的过滤都是
 * 「币种为空 或 币种等于本位币 → 跳过」，空币种走的正是本位币那一支。
 * 所以界面不该只说「未识别」，要把这个兜底币种显示出来。
 *
 * 多主体且本位币不一致时无法给出唯一答案，返回空串，界面仍显示「未识别」。
 */
export function fxFallbackFunctional(
  entities: string[],
  entityCurrencies: Record<string, string>,
  fixedEntity: string,
  defaultCode: string,
) {
  const keys = entities.length ? entities : [fixedEntity];
  const codes = new Set(
    keys
      .map((key) => (entityCurrencies[key] ?? defaultCode).trim().toUpperCase())
      .filter(Boolean),
  );
  return codes.size === 1 ? [...codes][0] : "";
}

/** 主体级本位币优先；用户手选值不被后续识别覆盖。 */
export function fxResolveEntityCurrencies(
  entities: string[],
  detected: Record<string, string> = {},
  uniformCurrency: string | null | undefined,
  current: Record<string, string> = {},
  touched: Record<string, boolean> = {},
) {
  // 无主体列时界面挂 DEFAULT_ENTITY（「本位币（全表）」）。若按空列表原样
  // 返回空 map，手选值会被这个函数的调用方 effect 整体清掉，下拉永远弹回
  // 识别值——表现为「本位币改不动」。
  const keys = entities.length ? entities : [DEFAULT_ENTITY];
  return Object.fromEntries(
    keys.map((entity) => [
      entity,
      touched[entity]
        ? (current[entity] ?? "CNY")
        : (detected[entity] ?? uniformCurrency ?? "CNY").toUpperCase(),
    ]),
  );
}

export function fxCurrencySourceLabel(side: "JE" | "TB" | "", source: string) {
  if (source === "币种列") return `${side}币种列`;
  return "按本位币";
}

export function fxCurrencyDefaultLabel(
  detected: string,
  side: "JE" | "TB" | "",
  source: string,
  fallbackFunctional: string,
) {
  if (detected) return `${detected}（${fxCurrencySourceLabel(side, source)}）`;
  return fallbackFunctional ? `${fallbackFunctional}（按本位币）` : "未识别";
}

/**
 * 只有用户真正选过的币种才作为覆盖传给后端。
 *
 * 留空表示「按系统识别的来」——**刻意不预填检测值**：一旦预填，就再也分不清
 * 「用户确认过 USD」和「系统猜了 USD」，日后改进识别逻辑也推不动已落盘的值。
 * 主体本位币那一处就是预填踩出来的坑（见下方 entityCurrencies 的注释）。
 */
export function fxAccountCurrencyOverrides(selections: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(selections)
      .map(([account, code]) => [account, code.trim().toUpperCase()] as const)
      .filter(([, code]) => code !== ""),
  );
}

/**
 * 非货币性项目／其他损益成本科目不参与外币重估，界面币种固定 N/A；
 * 这些科目的手选币种不再作为覆盖传给后端，避免残留旧选择影响口径。
 */
export function fxAccountCurrencyOverridesForRoles(
  selections: Record<string, string>,
  roles: Record<string, string>,
) {
  return fxAccountCurrencyOverrides(
    Object.fromEntries(
      Object.entries(selections).filter(
        ([account]) =>
          roles[account] !== "non_monetary" && roles[account] !== "other_pnl",
      ),
    ),
  );
}

export function fxResolveAccountRoles(
  accounts: string[],
  jeSuggestions: Record<string, string> = {},
  tbSuggestions: Record<string, string> = {},
  current: Record<string, string> = {},
  touched: Record<string, boolean> = {},
) {
  const exact = { ...jeSuggestions, ...tbSuggestions };
  const byCode = new Map<string, string>();
  for (const [account, role] of Object.entries(jeSuggestions))
    byCode.set(account.trim().split(/\s+/)[0], role);
  // TB 是科目主数据，编码相同时优先使用 TB 的名称与分类结论。
  for (const [account, role] of Object.entries(tbSuggestions))
    byCode.set(account.trim().split(/\s+/)[0], role);
  return Object.fromEntries(
    accounts.map((account) => [
      account,
      touched[account] && current[account]
        ? current[account]
        : (exact[account] ??
          byCode.get(account.trim().split(/\s+/)[0]) ??
          "non_monetary"),
    ]),
  );
}

export function fxReportStart(balanceSheetDate: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(balanceSheetDate)
    ? `${balanceSheetDate.slice(0, 4)}-01-01`
    : "";
}
export function fxDropTargetAt(
  x: number,
  y: number,
  jeRect: Pick<DOMRect, "left" | "right" | "top" | "bottom"> | undefined,
  tbRect: Pick<DOMRect, "left" | "right" | "top" | "bottom"> | undefined,
): "je" | "tb" | undefined {
  const hit = (rect: typeof jeRect) =>
    Boolean(
      rect &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom,
    );
  return hit(jeRect) ? "je" : hit(tbRect) ? "tb" : undefined;
}
export function fxMergeJobResult(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
) {
  return { ...current, ...next };
}
/** 未覆盖凭证按结构结论与已分类但缺少重算证据分别披露。 */
export function uncoveredDetail(summary: Record<string, unknown>): string {
  const total = Number(summary.pendingReviewCount ?? 0);
  const unclassified = Number(summary.pendingUnclassifiedCount ?? 0);
  const unmeasurable = Number(summary.pendingUnmeasurableCount ?? 0);
  const notFx = Number(summary.notFxEventCount ?? 0);
  if (!total) return "全部凭证均已纳入测算";
  // 旧结果没有拆分字段时退回总数，不假装知道构成。
  if (!unclassified && !unmeasurable && !notFx) return `${total} 张未纳入测算`;
  const parts = [];
  if (notFx) parts.push(`${notFx} 张不构成汇兑事项`);
  if (unclassified) parts.push(`${unclassified} 张待确认分类`);
  if (unmeasurable) parts.push(`${unmeasurable} 张已分类但缺重算证据`);
  return parts.join("；");
}
/** 未覆盖金额的「其中」拆分：不构成汇兑事项的金额张数在前，缺重算证据的余额在后。 */
export function uncoveredBreakdown(summary: Record<string, unknown>) {
  const total = Number(summary.uncoveredTbFxGainLoss ?? 0);
  const notFxCount = Number(summary.notFxEventCount ?? 0);
  const notFxAmount = Number(summary.notFxEventAmount ?? 0);
  const unmeasurable = Number(summary.pendingUnmeasurableCount ?? 0);
  return {
    notFxCount,
    notFxAmount,
    unmeasurable,
    restAmount: total - notFxAmount,
  };
}
export const NOT_FX_EVENT_HINT =
  "这些凭证按结构看不出汇兑损益，账面汇差未纳入测算；明细见底稿「汇兑事项复核」页。";
export const UNMEASURABLE_HINT =
  "这些凭证已分好类，但缺少重算所需的原币余额或汇率证据（常见原因：科目余额表没按币种拆分），审计金额暂未测出；补资料后重算。";
/** 「?」圆形图标：鼠标移上去（或键盘聚焦）显示口径注释。 */
export function InfoHint({ text }: { text: string }) {
  return (
    <span className="fx-info-hint" tabIndex={0} role="note" aria-label={text}>
      ?<span className="fx-info-hint-tip">{text}</span>
    </span>
  );
}
/** 勾稽第 3 步「未覆盖账面金额」下的「其中」拆分行：不构成事项与缺重算证据
 *  各自成行、各带 ? 图标注释；两者都没有时退回纯文字说明。 */
export function uncoveredMetricDetail(
  summary: Record<string, unknown>,
  amount: (value: unknown) => string,
): ReactNode {
  const { notFxCount, notFxAmount, unmeasurable, restAmount } =
    uncoveredBreakdown(summary);
  if (!notFxCount && !unmeasurable) return uncoveredDetail(summary);
  return (
    <>
      {notFxCount > 0 && (
        <span className="fx-metric-line">
          其中：不构成汇兑事项 {amount(notFxAmount)}（{notFxCount} 张）
          <InfoHint text={NOT_FX_EVENT_HINT} />
        </span>
      )}
      {unmeasurable > 0 && (
        <span className="fx-metric-line">
          已分类但缺重算证据 {amount(restAmount)}（{unmeasurable} 张）
          <InfoHint text={UNMEASURABLE_HINT} />
        </span>
      )}
    </>
  );
}

export function fxApplyJobResult(
  current: Record<string, unknown> | undefined,
  next: unknown,
  method: "fx.preview" | "fx.export",
) {
  if (!next || typeof next !== "object" || Array.isArray(next)) return current;
  return method === "fx.export"
    ? fxMergeJobResult(current, next as Record<string, unknown>)
    : (next as Record<string, unknown>);
}
export function fxPreviewTokenFor(
  method: "fx.preview" | "fx.export",
  result: Record<string, unknown> | undefined,
) {
  const token = result?.previewToken;
  return method === "fx.export" && typeof token === "string" && token.trim()
    ? token
    : undefined;
}
export function fxMissingRequired(
  kind: "je" | "tb",
  mapping: Record<string, string | string[]>,
  _hasJe: boolean,
  fixedEntity: string,
  mode: Mode = "combined",
): string[] {
  return [...new Set(fxMissingRaw(kind, mapping, _hasJe, fixedEntity, mode))];
}

/**
 * inspect 下发的科目、主体和主体×科目目录只依赖账表身份字段。
 * 金额、日期等映射变化不需要重新读取整本工作簿。
 */
export function fxCatalogMappingKey(
  mapping: Record<string, string | string[]>,
): string {
  return JSON.stringify(
    ["entity", "account", "accountCode", "accountName"].map((role) => [
      role,
      mapping[role] ?? "",
    ]),
  );
}

/**
 * 汇兑损益测算必须直接读取原币币种列；不再从科目名称或备注猜币种。
 */
export function fxCurrencyRequirement(
  kind: "je" | "tb",
  mapping: Record<string, string | string[]>,
  mode: Mode,
  role: string,
): "required" | "optional" | undefined {
  void kind;
  void mapping;
  void mode;
  if (role === "currency") return "required";
  if (role === "functionalCurrency") return "optional";
  return undefined;
}
function fxMissingRaw(
  kind: "je" | "tb",
  mapping: Record<string, string | string[]>,
  _hasJe: boolean,
  // 主体改为选填后这里不再判定它；形参保留，调用方与测试不必全改。
  _fixedEntity: string,
  mode: Mode = "combined",
): string[] {
  const has = (role: string) => {
    const value = mapping[role];
    return Array.isArray(value)
      ? value.some((item) => item.trim())
      : Boolean(value?.trim());
  };
  const scheme = (prefix: string) =>
    has(`${prefix}Amount`) ||
    (has(`${prefix}Debit`) && has(`${prefix}Credit`)) ||
    (has(`${prefix}Amount`) && (has("direction") || has(`${prefix}Direction`)));
  const missing: string[] = missingGoldIdentity(kind, (role) =>
    role === "accountCode" || role === "accountName"
      ? has(role) || has("account")
      : has(role),
  );
  if (kind === "je") {
    if (!has("currency")) missing.push("原币币种");
    if (!scheme("foreign")) missing.push("原币金额方案");
    if (!scheme("functional")) missing.push("本位币金额方案");
  } else {
    if (!has("currency")) missing.push("原币币种");
    if (!scheme("openingForeign")) missing.push("期初原币余额");
    if (!scheme("closingForeign")) missing.push("期末原币余额");
    if (!scheme("openingFunctional")) missing.push("期初本位币余额");
    if (!scheme("closingFunctional")) missing.push("期末本位币余额");
    // 本年累计借/贷是 TB 六型的必填组（整组匹配缺一不可）；表里只有本期
    // 发生时本期借/贷作次选兜底，两组都不齐就提示。
    const ytdOk = has("ytdFunctionalDebit") && has("ytdFunctionalCredit");
    const periodOk =
      has("periodFunctionalDebit") && has("periodFunctionalCredit");
    if (!ytdOk && !periodOk) missing.push("本年累计（或本期）借/贷方发生额");
  }
  return missing;
}

export function FxAuditPage({ tool }: { tool: ToolManifest }) {
  const [jePath, setJePath] = useState("");
  const [tbPath, setTbPath] = useState("");
  // 测算模式固定为「已实现＋未实现」：TB 和 JE 两份都必传。
  // 历史上还有「仅已实现 / 仅未实现」两个单边模式，2026-09 按需求移除。
  const mode: Mode = "combined";
  const [reportEnd, setReportEnd] = useState(defaultBalanceSheetDate());
  const [je, setJe] = useState<Inspection>();
  const [tb, setTb] = useState<Inspection>();
  const [jeMapping, setJeMapping] = useState<Record<string, string | string[]>>(
    {},
  );
  const [jeAuxiliaryManual, setJeAuxiliaryManual] = useState(false);
  const [tbMapping, setTbMapping] = useState<Record<string, string | string[]>>(
    {},
  );
  // 每侧目录记录其生成时采用的身份映射。人工/LLM 修订身份字段后异步
  // 重新 inspect；代次与对象身份双重守卫，避免慢请求覆盖更换后的来源。
  const catalogRefreshGeneration = useRef({ tb: 0, je: 0 });
  const catalogMappingKeys = useRef<{ tb?: string; je?: string }>({});
  const [entityCurrencies, setEntityCurrencies] = useState<
    Record<string, string>
  >({});
  const [accountRoles, setAccountRoles] = useState<Record<string, string>>({});
  const [accountRolesTouched, setAccountRolesTouched] = useState<
    Record<string, boolean>
  >({});
  // 科目分类清单的关键词筛选：只影响展示，不改变角色分类和测算口径。
  const [accountFilter, setAccountFilter] = useState("");
  const [accountReviewLimit, setAccountReviewLimit] = useState(FX_ACCOUNT_PAGE_SIZE);
  // 三步导引，与其他工具一致：上传识别 → 科目类型确认 → 测算与底稿。
  // 之前所有区块平铺在一页，用户要一路滚到底才知道下一步做什么。
  const [step, setStep] = useState(0);
  // 币种覆盖刻意**不预填**：空字符串就是「按系统识别的来」，只有用户手工选过的
  // 才进 payload。主体本位币那一处预填踩过时序的坑（见下方注释），这里不重蹈。
  const [accountCurrencies, setAccountCurrencies] = useState<
    Record<string, string>
  >({});
  // 辅助核算拆行后的逐户手工覆盖（键＝主体␟科目编码␟辅助键）。留空即回落
  // 科目级识别结论；换文件上传时与科目级覆盖一起清空。
  const [accountDetailRoles, setAccountDetailRoles] = useState<
    Record<string, string>
  >({});
  const [accountDetailCurrencies, setAccountDetailCurrencies] = useState<
    Record<string, string>
  >({});
  const [manualClassifications, setManualClassifications] = useState<
    Record<string, VoucherClassification>
  >({});
  const [tbCurrencyConfirmed, setTbCurrencyConfirmed] = useState(false);
  const [alignment, setAlignment] = useState<string[]>([]);
  // 辅助联动属于第一步映射确认门禁：来源刚就绪时不自动读取 JE；用户明确
  // 点击“下一步”后才生成一次计划，同一来源/映射键来回切换步骤直接复用。
  const [auxiliaryLinkState, setAuxiliaryLinkState] = useState<{
    key: string;
    result: AuxiliaryLinkResult;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [changingKind, setChangingKind] = useState<"je" | "tb">();
  const [error, setError] = useState("");
  // 一键复核的进行态与结果文案由共享 hook 管理（与存款利息同一实现）。
  const reviews = useLedgerDictReviews(engineCall, {
    tb: JSON.stringify([tbPath, tb?.sheet, tb?.headerRow, tb?.headerDepth]),
    je: JSON.stringify([jePath, je?.sheet, je?.headerRow, je?.headerDepth]),
  });
  const ledgerReviewOwner = useRef({});
  const { reviewing, status: reviewStatus } = reviews;
  const [job, setJob] = useState<JobEvent>();
  const [result, setResult] = useState<Record<string, unknown>>();
  const formalMeasurementBlocked =
    (result?.summary as Record<string, unknown> | undefined)
      ?.formalMeasurementAvailable === false;
  const [outputPath, setOutputPath] = useState("");
  const [sourceStatus, setSourceStatus] = useState("");
  // fx.recalculate 与 fx.preview 走同一个任务方法，但按钮标识必须分开：
  // 否则「测算预览」运行时「重新测算」也跟着转圈（UI 审计 P3-3）。
  const [activeStage, setActiveStage] = useState<
    "fx.preview" | "fx.recalculate" | "fx.export"
  >();
  const [completedStage, setCompletedStage] = useState<
    "fx.preview" | "fx.export"
  >();
  const activeJob = useRef("");
  const activeJobMethod = useRef<"fx.preview" | "fx.export">("fx.preview");
  const uploadDropRef = useRef<HTMLDivElement>(null);
  const entityKeyEnabled = je && tb
    ? ledgerEntityKeyEnabled(tbMapping, jeMapping)
    : je ? ledgerHasMappedRole(jeMapping, "entity") : ledgerHasMappedRole(tbMapping, "entity");
  const entities = useMemo(
    () => entityKeyEnabled
      ? [...new Set([...(je?.entities ?? []), ...(tb?.entities ?? [])])]
      : [],
    [je, tb, entityKeyEnabled],
  );
  // 多主体账套：第二步科目确认的屏幕表与导出确认表都加「主体」列；
  // 单主体保持原有三列布局，不占列宽。
  const showEntityColumn = useMemo(
    () => entityKeyEnabled && fxMultiEntityNames(je?.entities ?? [], tb?.entities ?? []).length > 1,
    [je?.entities, tb?.entities, entityKeyEnabled],
  );
  const entityScope = useEntityScopeConfirmation({
    tbEntities: entityKeyEnabled ? (tb?.entities ?? []) : [],
    jeEntities: entityKeyEnabled ? (je?.entities ?? []) : [],
    onInvalidate: () => {
      activeJob.current = "";
      setResult(undefined);
      setJob(undefined);
      setActiveStage(undefined);
      setCompletedStage(undefined);
    },
  });
  // 主体是选填角色：映射了主体列就按列里的名字，没映射就全表统一挂 DEFAULT_ENTITY，
  // 不再要用户手填。它只是本位币与底稿封面的挂载点——用户要填的是本位币。
  const fixedEntity = entities.length === 1 ? entities[0] : DEFAULT_ENTITY;
  // 联动结论依赖 TB 发生额列及 JE 正文掩码等映射；来源或这些映射变化
  // 必须重验，避免第三步因计划指纹失配再单独扫描 JE。
  // （声明在科目清单 memo 之前：第二步的行粒度要按验证结果拆辅助明细。）
  const inferredJeMapping = useMemo(() => {
    if (!tb || !je || jeAuxiliaryManual) return jeMapping;
    const { auxiliary: _automatic, ...withoutAutomaticAuxiliary } = jeMapping;
    return withoutAutomaticAuxiliary;
  }, [tb, je, jeAuxiliaryManual, jeMapping]);
  const auxiliaryLinkKey = tb && je
    ? JSON.stringify({
        tb: [tbPath, tb.sheet, tb.headerRow, tb.headerDepth, tbMapping],
        je: [jePath, je.sheet, je.headerRow, je.headerDepth, inferredJeMapping],
        entityScope: entityScope.selection,
      })
    : null;
  const auxiliaryLink =
    auxiliaryLinkKey && auxiliaryLinkState?.key === auxiliaryLinkKey
      ? auxiliaryLinkState.result
      : null;
  useEffect(() => {
    if (!auxiliaryLink) return;
    setTbMapping((current) =>
      dropUnlinkedTbAuxiliary(current, auxiliaryLink),
    );
  }, [auxiliaryLink]);
  useEffect(() => {
    if (!tb || !je || jeAuxiliaryManual) return;
    const column = fxLinkedJeAuxiliaryColumn(auxiliaryLink);
    if (!auxiliaryLink) return;
    setJeMapping((current) => {
      const held = current.auxiliary;
      if (column ? Array.isArray(held) && held.length === 1 && held[0] === column : !held)
        return current;
      const next = { ...current };
      if (column) next.auxiliary = [column];
      else delete next.auxiliary;
      return next;
    });
  }, [auxiliaryLink, tb, jeAuxiliaryManual]);
  useEffect(() => {
    if (!tb || !je || jeAuxiliaryManual) return;
    // JE 单独上传时的 Coding 建议不能在配对后继续作为辅助列裁判。
    setJeMapping((current) => {
      if (!current.auxiliary) return current;
      const next = { ...current };
      delete next.auxiliary;
      return next;
    });
  }, [tbPath, jePath, tb?.sheet, je?.sheet, jeAuxiliaryManual]);
  const accounts = useMemo(
    // 科目类型确认只列 TB 末级科目：该步与 JE 无关（全工具统一口径），
    // 末级清单由公共引擎的目录末级掩码下发，平级/无编码的账表不受影响；
    // 旧任务没有该字段时回退全量清单。
    () => fxAccountDisplayList(tb?.accountsLeaf ?? tb?.accounts),
    [tb?.accountsLeaf, tb?.accounts],
  );
  // 第二步行粒度：辅助核算联动验证通过的科目按辅助明细拆行（与存款利息／
  // 借款利息同口径），其余停在末级科目；主体拆行只在双侧映射主体列且账里
  // 确实多主体时启用（与引擎建户口径一致）。筛选文本包含辅助名，便于按客商找。
  const entityRowsByAccount = useMemo(
    () =>
      entityKeyEnabled && ledgerMultiEntityCombos(tb?.entityAccounts)
        ? ledgerEntitiesByAccount(tb?.entityAccounts, fxAccountCodeOf)
        : null,
    [tb?.entityAccounts, entityKeyEnabled],
  );
  const reviewRows = useMemo(
    () => fxAccountReviewRows(accounts, auxiliaryLink, entityRowsByAccount),
    [accounts, auxiliaryLink, entityRowsByAccount],
  );
  const orderedReviewRows = useMemo(
    () => fxSortAccountReviewRows(reviewRows, accountRoles, accountDetailRoles),
    [reviewRows, accountRoles, accountDetailRoles],
  );
  const accountMatches = useMemo(
    () => keywordFilterPredicate(accountFilter),
    [accountFilter],
  );
  const visibleRows = useMemo(
    () =>
      orderedReviewRows.filter((row) =>
        accountMatches(
          fxAccountFilterText(
            row.auxiliary ? `${row.account} ${row.auxiliary}` : row.account,
            je?.accountCurrencyDetails,
            tb?.accountCurrencyDetails,
          ),
        ),
      ),
    [
      orderedReviewRows,
      accountMatches,
      je?.accountCurrencyDetails,
      tb?.accountCurrencyDetails,
    ],
  );
  const renderedRows = visibleRows.slice(0, accountReviewLimit);
  useEffect(() => {
    setAccountReviewLimit(FX_ACCOUNT_PAGE_SIZE);
  }, [accountFilter, reviewRows]);
  const reviewingAny = reviewing.je || reviewing.tb;
  const requiredSources = fxRequiredSources(mode);
  const requiredMappingsMissing = [
    ...(je && requiredSources.je
      ? fxMissingRequired("je", jeMapping, true, fixedEntity)
      : []),
    ...(tb && requiredSources.tb
      ? fxMissingRequired("tb", tbMapping, Boolean(je), fixedEntity)
      : []),
  ];
  const defaultFunctionalCurrency = tb?.uniformCurrency || "CNY";
  const fallbackFunctional = useMemo(
    () =>
      fxFallbackFunctional(
        entities,
        entityCurrencies,
        fixedEntity,
        defaultFunctionalCurrency,
      ),
    [entities, entityCurrencies, fixedEntity, defaultFunctionalCurrency],
  );
  const confirmationRows = useMemo(
    () => fxConfirmationRows(
      orderedReviewRows,
      accountRoles,
      accountDetailRoles,
      accountCurrencies,
      accountDetailCurrencies,
      je?.accountCurrencyDetails,
      tb?.accountCurrencyDetails,
      fallbackFunctional,
      showEntityColumn,
    ),
    [
      orderedReviewRows,
      accountRoles,
      accountDetailRoles,
      accountCurrencies,
      accountDetailCurrencies,
      je?.accountCurrencyDetails,
      tb?.accountCurrencyDetails,
      fallbackFunctional,
      showEntityColumn,
    ],
  );
  const currencyConfirmationMissing = Boolean(
    tb &&
    requiredSources.tb &&
    tb.foreignCurrencyNeedsConfirmation &&
    !tbCurrencyConfirmed,
  );

  // 只有用户手工改过的主体才不许自动预填覆盖。
  // 之前这里写的是 `v[e] ?? uniformCurrency ?? "CNY"`：JE 比 TB 先解析完时，
  // entities 已经有值而 tb 还是空，先被填成 CNY；等 TB 的 uniformCurrency 到了，
  // `v[e] ??` 发现已有值就跳过——**一旦落成 CNY 就再也改不回来**，
  // 4800 这种本位币是 USD 的账会把全表科目都当成外币。
  const [currencyTouched, setCurrencyTouched] = useState<
    Record<string, boolean>
  >({});
  const setEntityCurrency = (entity: string, value: string) => {
    setCurrencyTouched((v) => ({ ...v, [entity]: true }));
    setEntityCurrencies((v) => ({ ...v, [entity]: value.toUpperCase() }));
  };
  useEffect(() => {
    setEntityCurrencies((v) =>
      fxResolveEntityCurrencies(
        entities,
        tb?.entityCurrencies,
        tb?.uniformCurrency,
        v,
        currencyTouched,
      ),
    );
  }, [entities, tb?.entityCurrencies, tb?.uniformCurrency, currencyTouched]);
  useEffect(
    () =>
      setAccountRoles((current) =>
        fxResolveAccountRoles(
          accounts,
          je?.accountRoleSuggestions,
          tb?.accountRoleSuggestions,
          current,
          accountRolesTouched,
        ),
      ),
    [
      accounts,
      je?.accountRoleSuggestions,
      tb?.accountRoleSuggestions,
      accountRolesTouched,
    ],
  );

  // 历史记录「继续任务」：回填两表路径/模式/基准日/映射与各口径覆盖。Sheet
  // 等识别信息以存档参数重建最小 Inspection，不点「重新识别」也能直接测算；
  // 主体/科目清单也按存档键重建，并把角色与币种标记为已手选，避免上面的
  // 预填副作用把恢复值改写掉。
  // restoredFxRef：用户重新识别**同一文件**时，applyInspection 默认套用建议
  // 映射并清空角色/币种覆盖——这里把存档值顶回，逐侧一次性消费；换文件
  // 不顶回。
  const restoredFxRef = useRef<{
    sides: {
      je?: { path: string; mapping: Record<string, string | string[]> };
      tb?: { path: string; mapping: Record<string, string | string[]> };
    };
    manualClassifications?: Record<string, VoucherClassification>;
    accountRoles?: Record<string, string>;
    entityCurrencies?: Record<string, string>;
    accountCurrencies?: Record<string, string>;
  } | null>(null);
  useTaskRestore(tool.id, (restore) => {
    type FxSourceParams = {
      inputPath?: string;
      sheet?: string;
      headerRow?: number;
      headerDepth?: number;
    };
    const p = restore.params as {
      mode?: string;
      reportEnd?: string;
      jeSource?: FxSourceParams;
      tbSource?: FxSourceParams;
      jeMapping?: Record<string, string | string[]>;
      tbMapping?: Record<string, string | string[]>;
      entityCurrencies?: Record<string, string>;
      accountRoles?: Record<string, string>;
      accountCurrencies?: Record<string, string>;
      manualClassifications?: Record<string, VoucherClassification>;
      outputPath?: string;
    };
    const restoredJePath =
      typeof p.jeSource?.inputPath === "string" ? p.jeSource.inputPath : "";
    const restoredTbPath =
      typeof p.tbSource?.inputPath === "string" ? p.tbSource.inputPath : "";
    if (!restoredJePath && !restoredTbPath) return;
    const entityList = Object.keys(p.entityCurrencies ?? {});
    const accountList = [
      ...new Set([
        ...Object.keys(p.accountRoles ?? {}),
        ...Object.keys(p.accountCurrencies ?? {}),
        ...Object.keys(p.manualClassifications ?? {}),
      ]),
    ];
    const minimalInspection = (
      src: FxSourceParams | undefined,
      withLists: boolean,
    ): Inspection =>
      ({
        sheet: src?.sheet ?? "",
        headerRow: src?.headerRow ?? 0,
        headerDepth: src?.headerDepth ?? 0,
        ...(withLists ? { entities: entityList, accounts: accountList } : {}),
      }) as Inspection;
    const snapshot = restore.snapshot as
      | { je?: unknown; tb?: unknown }
      | null;
    const cachedJe = isFxInspectionSnapshot(snapshot?.je) ? snapshot.je : undefined;
    const cachedTb = isFxInspectionSnapshot(snapshot?.tb) ? snapshot.tb : undefined;
    const isMapping = (value: unknown): value is Record<string, string | string[]> =>
      Boolean(value && typeof value === "object");
    restoredFxRef.current = {
      sides: {
        ...(restoredJePath && isMapping(p.jeMapping)
          ? { je: { path: restoredJePath, mapping: p.jeMapping } }
          : {}),
        ...(restoredTbPath && isMapping(p.tbMapping)
          ? { tb: { path: restoredTbPath, mapping: p.tbMapping } }
          : {}),
      },
      ...(isMapping(p.manualClassifications)
        ? { manualClassifications: p.manualClassifications }
        : {}),
      ...(isMapping(p.accountRoles) ? { accountRoles: p.accountRoles } : {}),
      ...(isMapping(p.entityCurrencies)
        ? { entityCurrencies: p.entityCurrencies }
        : {}),
      ...(isMapping(p.accountCurrencies)
        ? { accountCurrencies: p.accountCurrencies }
        : {}),
    };
    setJePath(restoredJePath);
    setTbPath(restoredTbPath);
    setJe(
      restoredJePath
        ? restore.snapshotStatus === "valid" && cachedJe
          ? cachedJe
          : minimalInspection(p.jeSource, !restoredTbPath)
        : undefined,
    );
    setTb(
      restoredTbPath
        ? restore.snapshotStatus === "valid" && cachedTb
          ? cachedTb
          : minimalInspection(p.tbSource, true)
        : undefined,
    );
    // 模式已固定为 combined，旧任务草稿里保存的 mode 一律忽略。
    if (typeof p.reportEnd === "string" && p.reportEnd)
      setReportEnd(p.reportEnd);
    setJeMapping(
      p.jeMapping && typeof p.jeMapping === "object" ? p.jeMapping : {},
    );
    setTbMapping(
      p.tbMapping && typeof p.tbMapping === "object" ? p.tbMapping : {},
    );
    setEntityCurrencies(
      p.entityCurrencies && typeof p.entityCurrencies === "object"
        ? p.entityCurrencies
        : {},
    );
    setAccountRoles(
      p.accountRoles && typeof p.accountRoles === "object"
        ? p.accountRoles
        : {},
    );
    setAccountRolesTouched(
      Object.fromEntries(
        Object.keys(p.accountRoles ?? {}).map((account) => [account, true]),
      ),
    );
    setAccountCurrencies(
      p.accountCurrencies && typeof p.accountCurrencies === "object"
        ? p.accountCurrencies
        : {},
    );
    setManualClassifications(
      p.manualClassifications && typeof p.manualClassifications === "object"
        ? p.manualClassifications
        : {},
    );
    setOutputPath(typeof p.outputPath === "string" ? p.outputPath : "");
    setStep(2);
    setBusy(false);
    setError("");
    setResult(undefined);
    setJob(undefined);
    setActiveStage(undefined);
    setCompletedStage(undefined);
  });
  useEffect(() => {
    const drops = listenPositionedFileDrops(({ paths, x, y }) => {
      const rect = uploadDropRef.current?.getBoundingClientRect();
      if (
        !rect ||
        x < rect.left ||
        x > rect.right ||
        y < rect.top ||
        y > rect.bottom
      )
        return;
      void classifyAndInspect(paths);
    });
    const jobs = listenJobEvents((event) => {
      if (event.jobId !== activeJob.current) return;
      setJob(event);
      if (event.result)
        setResult((current) =>
          fxApplyJobResult(current, event.result, activeJobMethod.current),
        );
      if (event.phase === "completed") {
        setBusy(false);
        setActiveStage(undefined);
        if (event.result) setCompletedStage(activeJobMethod.current);
        else {
          setCompletedStage(undefined);
          setError(
            "任务进程已结束，但系统未收到测算结果。请重新测算；若再次出现，结果传输诊断会保留此异常。",
          );
        }
      } else if (event.phase === "failed" || event.phase === "cancelled") {
        setBusy(false);
        setActiveStage(undefined);
        setCompletedStage(undefined);
        // 失败原因后端已经写清楚（validate_mapping 的每一条），只是塞在 detail 里。
        // 这里必须走 errorText 展开，否则界面只剩一句「字段映射或数据质量校验未
        // 通过」，用户无从判断该改哪一项。
        const p = event.result as { error?: unknown } | undefined;
        setError(p?.error ? errorText(p.error) : event.message);
      }
    });
    return () => {
      void drops.then((x) => x());
      void jobs.then((x) => x());
    };
  }, []);

  async function browse() {
    const picked = await pickPath("files", "选择JE或TB文件", [
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
    // 新一轮上传不得沿用上一批数据的测算结果、跨表复核提示或手工口径。
    // 特别是 currencyTouched：旧账套手工选过的币种不能压住新 TB
    // 识别出的公司本位币。3300 的 TB 本位币列是 CNY；账户文本里出现
    // USD 只是原币线索，不能反过来把公司本位币改成 USD。
    reviews.clearReview("je");
    reviews.clearReview("tb");
    setAlignment([]);
    setResult(undefined);
    setJob(undefined);
    setCompletedStage(undefined);
    setActiveStage(undefined);
    setManualClassifications({});
    setAccountRoles({});
    setAccountRolesTouched({});
    setAccountCurrencies({});
    setAccountDetailRoles({});
    setAccountDetailCurrencies({});
    setEntityCurrencies({});
    setCurrencyTouched({});
    setTbCurrencyConfirmed(false);
    setReportEnd("");
    setBusy(true);
    setError("");
    setSourceStatus("正在识别文件类型、表头和字段…");
    const failures: string[] = [];
    try {
      const scan = await scanLedgerUploadSources<SourceClassification>(
        engineCall,
        files,
        {
          classificationMethod: "fx.classify_source",
          llmMethod: "fx.classify_source_llm",
        },
      );
      failures.push(
        ...scan.failures.map(
          (failure) => `${fileName(failure.path)}：${errorText(failure.error)}`,
        ),
      );
      const selectedSources = selectLedgerSourcePair(scan.sources);
      const pairedUpload = selectedSources.some((source) => source.kind === "tb")
        && selectedSources.some((source) => source.kind === "je");
      for (const item of selectedSources) {
        try {
          const response = (await engineCall("fx.inspect_" + item.kind, {
            pairedTbJe: pairedUpload,
            source: {
              inputPath: item.path,
              sheet: item.classification.sheet,
              // 分类阶段只负责选 Sheet；正式 inspect 必须重新自动判定表头。
              headerRow: 0,
              headerDepth: 0,
            },
          })) as Inspection;
          applyInspection(item.kind, item.path, response);
        } catch (e) {
          failures.push(
            `${fileName(item.path)} / ${item.classification.sheet}：${errorText(e)}`,
          );
        }
      }
      const hiddenText = scan.hiddenSheets
        ? `；另有 ${scan.hiddenSheets} 张低置信度 Sheet 已忽略`
        : "";
      setSourceStatus(
        scan.llmFallbacks
          ? `${selectedSources.length} 个账表来源已由本机规则识别${hiddenText}；智能复核不可用的来源已保留识别结果。`
          : `${selectedSources.length} 个账表来源已完成本机识别与智能复核${hiddenText}。`,
      );
      if (failures.length) setError(failures.join("；"));
    } finally {
      setBusy(false);
    }
  }
  function applyInspection(
    kind: "je" | "tb",
    path: string,
    response: Inspection,
  ) {
    // 历史恢复后重新识别同一文件：用存档映射与各口径覆盖顶回建议值，
    // 逐侧一次性消费；换文件照旧用建议值。
    const stash = restoredFxRef.current;
    const side = stash?.sides[kind];
    const samePath = (a: string, b: string) =>
      a.trim().toLowerCase() === b.trim().toLowerCase();
    const match = side && samePath(side.path, path) ? side : undefined;
    if (match && stash) {
      delete stash.sides[kind];
      if (!stash.sides.je && !stash.sides.tb) restoredFxRef.current = null;
    }
    if (response.suggestedBalanceSheetDate)
      setReportEnd(response.suggestedBalanceSheetDate);
    else if (response.dataYears?.length === 1)
      setReportEnd(`${response.dataYears[0]}-12-31`);
    reviews.clearReview(kind);
    if (match && stash?.accountRoles) {
      setAccountRoles(stash.accountRoles);
      setAccountRolesTouched(
        Object.fromEntries(
          Object.keys(stash.accountRoles).map((account) => [account, true]),
        ),
      );
    } else {
      setAccountRoles({});
      setAccountRolesTouched({});
    }
    const appliedMapping = match
      ? match.mapping
      : (response.suggestedMapping ?? {});
    catalogRefreshGeneration.current[kind] += 1;
    // 本次 response 是按 suggestedMapping 生成；历史恢复映射若不同，下面的
    // effect 必须再按存档映射刷新，不能误把旧目录标成已是最新。
    catalogMappingKeys.current[kind] = fxCatalogMappingKey(
      response.suggestedMapping ?? {},
    );
    if (kind === "je") {
      setJeAuxiliaryManual(false);
      setManualClassifications(match ? (stash?.manualClassifications ?? {}) : {});
      setJePath(path);
      setJe(response);
      setJeMapping(appliedMapping);
    } else {
      setTbPath(path);
      setTb(response);
      setTbMapping(appliedMapping);
      setTbCurrencyConfirmed(!response.foreignCurrencyNeedsConfirmation);
      if (match && stash?.entityCurrencies) {
        setEntityCurrencies(stash.entityCurrencies);
        // 标记已手选，真实识别带来的 uniformCurrency 不得再改写恢复值。
        setCurrencyTouched(
          Object.fromEntries(
            Object.keys(stash.entityCurrencies).map((entity) => [entity, true]),
          ),
        );
      }
      if (match && stash?.accountCurrencies)
        setAccountCurrencies(stash.accountCurrencies);
    }
  }

  useEffect(() => {
    const refresh = async (kind: "je" | "tb") => {
      const current = kind === "je" ? je : tb;
      const path = kind === "je" ? jePath : tbPath;
      const mapping = kind === "je" ? jeMapping : tbMapping;
      if (!current || !path) return;
      const mappingKey = fxCatalogMappingKey(mapping);
      // 配对时 JE 全量币种证据由辅助反查的同一次读取返回。
      if (kind === "je" && tb && je) return;
      const needsFullCatalog = step === 1 && current.sampledPreview === true;
      if (catalogMappingKeys.current[kind] === mappingKey && !needsFullCatalog) return;
      const generation = ++catalogRefreshGeneration.current[kind];
      try {
        const response = (await engineCall(`fx.inspect_${kind}`, {
          source: {
            inputPath: path,
            sheet: current.sheet,
            headerRow: current.headerRow,
            headerDepth: current.headerDepth,
          },
          mapping,
          fullCatalog: needsFullCatalog,
        })) as Inspection;
        if (catalogRefreshGeneration.current[kind] !== generation) return;
        catalogMappingKeys.current[kind] = mappingKey;
        if (kind === "je") {
          setJe((latest) => (latest === current ? response : latest));
        } else {
          setTb((latest) => (latest === current ? response : latest));
        }
      } catch (reason) {
        if (catalogRefreshGeneration.current[kind] !== generation) return;
        setError(`字段映射已更新，但科目清单刷新失败：${errorText(reason)}`);
      }
    };
    void refresh("je");
    void refresh("tb");
  }, [je, jeMapping, jePath, tb, tbMapping, tbPath, step]);
  async function inspect(
    kind: "je" | "tb",
    over?: Partial<{ sheet: string; headerRow: number; headerDepth: number }>,
  ) {
    reviews.clearReview(kind);
    setBusy(true);
    setError("");
    try {
      const current = kind === "je" ? je : tb;
      const response = (await engineCall("fx.inspect_" + kind, {
        pairedTbJe: kind === "je" && Boolean(tb),
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
  async function replaceSource(kind: "je" | "tb") {
    const picked = await pickPath(
      "file",
      kind === "tb" ? "更换 TB 科目余额表" : "更换 JE 凭证明细",
      ["xlsx", "xls", "xlsm", "csv"],
    );
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    reviews.clearReview(kind);
    setBusy(true);
    setError("");
    setSourceStatus(`正在按 ${kind.toUpperCase()} 读取 ${fileName(path)}…`);
    setAlignment([]);
    setResult(undefined);
    try {
      const response = (await engineCall(`fx.inspect_${kind}`, {
        pairedTbJe: kind === "je" && Boolean(tb),
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
  async function changeSourceKind(from: "je" | "tb", to: "je" | "tb") {
    const path = from === "je" ? jePath : tbPath;
    const current = from === "je" ? je : tb;
    const occupiedPath = to === "je" ? jePath : tbPath;
    const occupied = to === "je" ? je : tb;
    if (!path || !current || from === to) return;
    setBusy(true);
    setChangingKind(from);
    setError("");
    setSourceStatus(
      occupied
        ? "正在交换 JE 与 TB，并重新自动识别标题行、层数和字段…"
        : `正在更正为 ${to.toUpperCase()}，并重新自动识别标题行、层数和字段…`,
    );
    setAlignment([]);
    setResult(undefined);
    try {
      const changed = await correctLedgerSourceKinds(
        from,
        to,
        { path, inspection: current },
        occupiedPath && occupied
          ? { path: occupiedPath, inspection: occupied }
          : undefined,
        async (kind, source) =>
          (await engineCall("fx.inspect_" + kind, {
            source: {
              inputPath: source.path,
              sheet: source.inspection.sheet,
              // 更正类型意味着旧类型下的表头结论也失效，重新自动识别。
              headerRow: 0,
              headerDepth: 0,
            },
          })) as Inspection,
      );
      reviews.clearReview(from);
      reviews.clearReview(to);
      if (from === "je") {
        setJePath("");
        setJe(undefined);
        setJeMapping({});
      } else {
        setTbPath("");
        setTb(undefined);
        setTbMapping({});
      }
      for (const item of changed)
        applyInspection(item.kind, item.path, item.inspection);
      setSourceStatus(
        changed.length > 1
          ? `JE 与 TB 来源已交换，并按新类型重新识别。`
          : `${fileName(path)} / ${changed[0].inspection.sheet} 已更正为 ${to.toUpperCase()}。`,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChangingKind(undefined);
      setBusy(false);
    }
  }
  // 一键复核 JE＋TB：引擎与状态管理都与存款利息共用同一份
  // （applyLedgerReviewsTogether ＋ useLedgerDictReviews），改一处两套工具同时生效。
  async function reviewBoth() {
    setError("");
    setAlignment([]);
    const outcomes = await reviews.reviewAll({
      je: je
        ? {
            headers: je.headers,
            preview: je.preview,
            // TB/JE 配对后 JE 辅助列只由 TB 值反查；Coding/LLM 均不裁决此角色。
            mapping: tb ? inferredJeMapping : jeMapping,
            labels: tb
              ? Object.fromEntries(Object.entries(resolveRoleLabels(je.roles, JE_LABELS)).filter(([role]) => role !== "auxiliary"))
              : resolveRoleLabels(je.roles, JE_LABELS),
            tool: "fx_audit",
            onApplied: (mapping) => setJeMapping((current) => {
              if (!tb) return mapping;
              const { auxiliary: _ignored, ...reviewed } = mapping;
              return current.auxiliary
                ? { ...reviewed, auxiliary: current.auxiliary }
                : reviewed;
            }),
            missingAfter: (mapping) =>
              fxMissingRequired("je", mapping, true, fixedEntity, mode),
          }
        : undefined,
      tb: tb
        ? {
            headers: tb.headers,
            preview: tb.preview,
            mapping: tbMapping,
            labels: resolveRoleLabels(tb.roles, TB_LABELS),
            tool: "fx_audit",
            onApplied: setTbMapping,
            missingAfter: (mapping) =>
              fxMissingRequired("tb", mapping, Boolean(je), fixedEntity),
          }
        : undefined,
    });
    // 任一源已切换时不再拿旧闭包里的另一侧映射做跨表校验。
    if ((je && !outcomes.je) || (tb && !outcomes.tb)) return;
    const failed = (["je", "tb"] as const).filter(
      (kind) => outcomes[kind]?.failed,
    );
    if (failed.length)
      setError(
        failed
          .map(
            (kind) =>
              `${kind === "je" ? "JE" : "TB"}字段映射复核失败，可继续手工映射。`,
          )
          .join("；"),
      );
    await checkAlignment(
      outcomes.je?.mapping ?? jeMapping,
      outcomes.tb?.mapping ?? tbMapping,
    );
  }
  // 脚本和LLM都可能把TB的科目编码映射到科目名称列。复核结束后立刻拿两边的
  // 真实取值交叉核对，把“口径对不上”当场摆出来，而不是等到测算失败。
  async function checkAlignment(
    nextJe: Record<string, string | string[]>,
    nextTb: Record<string, string | string[]>,
  ) {
    if (!je || !tb) return;
    const isCurrent = reviews.currentGuard();
    try {
      const response = (await engineCall("ledger.check_mapping_alignment", {
        jeSource: {
          inputPath: jePath,
          sheet: je.sheet,
          headerRow: je.headerRow,
          headerDepth: je.headerDepth,
        },
        jeMapping: nextJe,
        tbSource: {
          inputPath: tbPath,
          sheet: tb.sheet,
          headerRow: tb.headerRow,
          headerDepth: tb.headerDepth,
        },
        tbMapping: nextTb,
      })) as {
        errors?: string[];
        warnings?: string[];
        fix?: {
          jeMapping?: Record<string, string>;
          tbMapping?: Record<string, string>;
        } | null;
      };
      if (!isCurrent()) return;
      const jeFix = response.fix?.jeMapping;
      const tbFix = response.fix?.tbMapping;
      if (jeFix && Object.keys(jeFix).length)
        setJeMapping((current) => ({ ...current, ...jeFix }));
      if (tbFix && Object.keys(tbFix).length)
        setTbMapping((current) => ({ ...current, ...tbFix }));
      setAlignment([...(response.errors ?? []), ...(response.warnings ?? [])]);
    } catch (e) {
      if (isCurrent()) setAlignment([`口径核对未能完成：${errorText(e)}`]);
    }
  }

  function payload(
    method: "fx.preview" | "fx.export",
    overrides = manualClassifications,
  ) {
    const effectiveEntities = entities.length
      ? entityCurrencies
      : {
          [fixedEntity]:
            entityCurrencies[fixedEntity] ?? defaultFunctionalCurrency,
        };
    const start = fxReportStart(reportEnd);
    const snapshot = result?.rateSnapshot as
      { startDate?: string; endDate?: string } | undefined;
    const reusableSnapshot =
      snapshot?.startDate === start && snapshot?.endDate === reportEnd
        ? snapshot
        : undefined;
    const cachedTranslations = (result?.accountTranslations ?? {}) as Record<
      string,
      string
    >;
    const previewToken = fxPreviewTokenFor(method, result);
    return {
      mode,
      reportStart: start,
      reportEnd,
      fixedEntity,
      tbForeignCurrencyConfirmed:
        !tb?.foreignCurrencyNeedsConfirmation || tbCurrencyConfirmed,
      ...(je
        ? {
            jeSource: {
              inputPath: jePath,
              sheet: je.sheet,
              headerRow: je.headerRow,
              headerDepth: je.headerDepth,
            },
            jeMapping,
          }
        : {}),
      ...(tb
        ? {
            tbSource: {
              inputPath: tbPath,
              sheet: tb.sheet,
              headerRow: tb.headerRow,
              headerDepth: tb.headerDepth,
            },
            tbMapping,
          }
        : {}),
      entityCurrencies: effectiveEntities,
      entityScope: entityScope.selection,
      accountRoles,
      accountCurrencies: fxAccountCurrencyOverridesForRoles(
        accountCurrencies,
        accountRoles,
      ),
      accountDetailRoleOverrides: Object.fromEntries(
        Object.entries(accountDetailRoles).filter(([, role]) => role !== ""),
      ),
      accountDetailCurrencyOverrides: fxDetailCurrencyOverridesPayload(
        accountDetailCurrencies,
        reviewRows,
        accountRoles,
        accountDetailRoles,
      ),
      ...(tb && je && auxiliaryLink?.planKey
        ? { auxiliaryPlan: {
            planKey: auxiliaryLink.planKey,
            autoInferred: !jeAuxiliaryManual,
            groups: (auxiliaryLink.groups ?? [])
              .filter((group) => group.status === "verified" && group.column && group.tbColumn)
              .map((group) => ({ entity: group.entity, account: group.account,
                tbColumn: group.tbColumn, jeColumn: group.column })),
          } }
        : {}),
      manualClassifications: overrides,
      translateTbAccountNames: true,
      ...(Object.keys(cachedTranslations).length
        ? { accountTranslations: cachedTranslations }
        : {}),
      ...(reusableSnapshot ? { rateSnapshot: reusableSnapshot } : {}),
      ...(previewToken ? { previewToken } : {}),
      ...(outputPath ? { outputPath } : {}),
      __restoreSnapshot: {
        version: 1,
        sources: [jePath, tbPath].filter(Boolean),
        data: { je, tb },
      },
    };
  }
  async function proceedAfterMappingGate(targetStep = 1) {
    // 无 TB/JE 配对、或 TB 根本没有辅助映射时，辅助联动不适用。币种字段的
    // 必填/内容校验由 inspect 与正式测算统一负责，不再调用恒通过的
    // fx.validate_currency_mapping 空往返。
    if (
      !tb ||
      !je ||
      !auxiliaryLinkKey ||
      !ledgerHasMappedRole(tbMapping, "auxiliary")
    ) {
      setError("");
      setStep(targetStep);
      return;
    }
    if (auxiliaryLinkState?.key === auxiliaryLinkKey) {
      setError("");
      setStep(targetStep);
      return;
    }
    setError("");
    setBusy(true);
    try {
      const response = (await engineCall("ledger.auxiliary_link", {
        tbSource: {
          inputPath: tbPath,
          sheet: tb.sheet,
          headerRow: tb.headerRow,
          headerDepth: tb.headerDepth,
        },
        jeSource: {
          inputPath: jePath,
          sheet: je.sheet,
          headerRow: je.headerRow,
          headerDepth: je.headerDepth,
        },
        tbMapping,
        jeMapping: inferredJeMapping,
        entityScope: entityScope.selection,
      })) as AuxiliaryLinkResult;
      if (!response || typeof response.status !== "string")
        throw new Error("辅助核算联动验证未返回有效结果。");
      setAuxiliaryLinkState({ key: auxiliaryLinkKey, result: response });
      setStep(targetStep);
    } catch (e) {
      setStep(0);
      setError(`辅助核算联动验证失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }
  async function run(
    method: "fx.preview" | "fx.export",
    overrides = manualClassifications,
    // stage 只是界面按钮的 loading 归属，不影响任务方法。
    stage: "fx.preview" | "fx.recalculate" | "fx.export" = method,
  ) {
    setError("");
    if (!reportEnd) return setError("请选择资产负债表日。");
    if (requiredSources.je && !je)
      return setError("已实现测算需先上传并识别JE。");
    if (requiredSources.tb && !tb)
      return setError("未实现测算需先上传并识别TB。");
    const jeMissing =
      je && requiredSources.je
        ? fxMissingRequired("je", jeMapping, true, fixedEntity)
        : [];
    if (jeMissing.length)
      return setError(
        `JE尚未映射：${jeMissing.join("、")}。请先在预览表头完成字段映射。`,
      );
    const tbMissing =
      tb && requiredSources.tb
        ? fxMissingRequired("tb", tbMapping, Boolean(je), fixedEntity)
        : [];
    if (tbMissing.length)
      return setError(
        `TB尚未映射：${tbMissing.join("、")}。请先在预览表头完成字段映射。`,
      );
    if (currencyConfirmationMissing)
      return setError("TB检测到多个外币币种候选，请确认系统预选的外币币种列。");
    if (entities.some((e) => !entityCurrencies[e]))
      return setError("请为每个公司选择ISO本位币。");
    setBusy(true);
    setJob(undefined);
    setCompletedStage(undefined);
    setActiveStage(stage);
    activeJobMethod.current = method;
    try {
      activeJob.current = await jobStart(method, payload(method, overrides));
    } catch (e) {
      setBusy(false);
      setActiveStage(undefined);
      setError(errorText(e));
    }
  }
  async function recalculateClassifications() {
    await run("fx.preview", manualClassifications, "fx.recalculate");
  }

  return (
    <main className="tool-page fx-page">
      <PageHeader
        eyebrow="外币审计"
        title={tool.name}
        detail="按凭证识别结算事件，按官方人民币汇率中间价重算，并生成可追踪Excel底稿。"
      />
      <ErrorBox error={step === 2 && error === terminalJobError(job) ? "" : error} onDismiss={() => setError("")} />
      <AuxiliaryLinkStatusView result={auxiliaryLink} />
      <StepIndicator
        steps={[
          { key: "source", label: "上传与识别" },
          { key: "accounts", label: "TB科目类型确认", disabled: !je && !tb },
          { key: "run", label: "测算与底稿", disabled: !je && !tb },
        ]}
        current={step}
        onStepClick={(next) => {
          if (next === 0) setStep(0);
          else void proceedAfterMappingGate(next);
        }}
      />
      {step === 0 && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>上传审计数据</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="fx-source-requirements" aria-label="所需审计资料">
                <strong>所需资料（两份都必传）</strong>
                <span
                  className={
                    jePath
                      ? "ready"
                      : requiredSources.je
                        ? "required"
                        : "optional"
                  }
                >
                  JE 凭证明细
                  {!requiredSources.je
                    ? "（可选）"
                    : jePath
                      ? "（已添加）"
                      : "（必需）"}
                </span>
                <span
                  className={
                    tbPath
                      ? "ready"
                      : requiredSources.tb
                        ? "required"
                        : "optional"
                  }
                >
                  TB 科目余额表
                  {!requiredSources.tb
                    ? "（可选）"
                    : tbPath
                      ? "（已添加）"
                      : "（必需）"}
                </span>
              </div>
              <FileDropInput
                containerRef={uploadDropRef}
                value={jePath || tbPath}
                hideFilledLabel
                ariaLabel="重新选择 JE、TB 文件"
                displayValue={[
                  jePath && `JE：${fileName(jePath)}${je?.sheet ? ` / ${je.sheet}` : ""}`,
                  tbPath && `TB：${fileName(tbPath)}${tb?.sheet ? ` / ${tb.sheet}` : ""}`,
                ]
                  .filter(Boolean)
                  .join("；")}
                disabled={busy || reviewingAny}
                placeholder="拖放或选择JE、TB文件（可同时选择）"
                onBrowse={() => void browse()}
                onDragStateChange={() => {}}
                onClear={() => {
                  reviews.clearReview("je");
                  reviews.clearReview("tb");
                  setJePath("");
                  setTbPath("");
                  setJe(undefined);
                  setTb(undefined);
                  setJeMapping({});
                  setTbMapping({});
                  setAccountRoles({});
                  setAccountRolesTouched({});
                  setAccountCurrencies({});
                  setEntityCurrencies({});
                  setCurrencyTouched({});
                  setManualClassifications({});
                  setTbCurrencyConfirmed(false);
                  setAlignment([]);
                  setResult(undefined);
                  setJob(undefined);
                  setCompletedStage(undefined);
                  setActiveStage(undefined);
                  setReportEnd("");
                  setSourceStatus("");
                }}
              />
              {sourceStatus && (
                <p className="fx-source-status" aria-live="polite">
                  {sourceStatus}
                </p>
              )}
            </CardContent>
          </Card>
          <div className="fx-source-grid">
            <div className="fx-source-slot fx-source-slot-je">
              {jePath ? (
                <SourceCard
                  title="已识别：JE 凭证明细"
                  path={jePath}
                  inspection={je}
                  disabled={busy || reviewingAny}
                  onReplace={() => void replaceSource("je")}
                  onClear={() => {
                    reviews.clearReview("je");
                    setJePath("");
                    setJe(undefined);
                    setJeMapping({});
                  }}
                  onInspect={() => void inspect("je")}
                  onHeaderChange={(headerRow, headerDepth, sheet) =>
                    void inspect("je", { headerRow, headerDepth, sheet })
                  }
                  onKindChange={
                    () => void changeSourceKind("je", "tb")
                  }
                  kindChangeLabel={
                    changingKind === "je"
                      ? "正在更正…"
                      : tbPath
                        ? "与 TB 交换"
                        : "更正为 TB"
                  }
                />
              ) : tbPath ? (
                <Card className="fx-source-empty">
                  <CardHeader>
                    <CardTitle>JE 凭证明细</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p>未识别到 JE；请补充上传或检查文件表头。</p>
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
                  disabled={busy || reviewingAny}
                  onReplace={() => void replaceSource("tb")}
                  onClear={() => {
                    reviews.clearReview("tb");
                    setTbPath("");
                    setTb(undefined);
                    setTbMapping({});
                  }}
                  onInspect={() => void inspect("tb")}
                  onHeaderChange={(headerRow, headerDepth, sheet) =>
                    void inspect("tb", { headerRow, headerDepth, sheet })
                  }
                  onKindChange={
                    () => void changeSourceKind("tb", "je")
                  }
                  kindChangeLabel={
                    changingKind === "tb"
                      ? "正在更正…"
                      : jePath
                        ? "与 JE 交换"
                        : "更正为 JE"
                  }
                />
              ) : jePath ? (
                <Card className="fx-source-empty">
                  <CardHeader>
                    <CardTitle>TB 科目余额表</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p>未识别到 TB；请补充上传或检查文件表头。</p>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          </div>
          {(je || tb) && (
            <LedgerReviewAll
              present={je && tb ? ["je", "tb"] : je ? ["je"] : ["tb"]}
              names={{ je: "JE", tb: "TB" }}
              reviewing={reviewing}
              status={reviewStatus}
              results={reviews.results}
              disabled={busy}
              autoReviewKey={busy ? "" : completeLedgerPairReviewKey(
                tb && [tbPath, tb.sheet, tb.headerRow, tb.headerDepth],
                je && [jePath, je.sheet, je.headerRow, je.headerDepth],
              )}
              autoReviewOwner={ledgerReviewOwner.current}
              onReviewAll={() => void reviewBoth()}
              onUndo={reviews.undoChange}
              onAccept={reviews.acceptPending}
            />
          )}
          {je && tb && alignment.length > 0 && (
            <section className="kz-card fx-alignment" aria-live="polite">
              <h2>TB 与 JE 口径核对</h2>
              <ul>
                {alignment.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          )}
          {(je || tb) && (
            <Card>
              <CardHeader>
                <CardTitle>公司本位币</CardTitle>
              </CardHeader>
              <CardContent className="fx-list">
                {tb?.entityCurrencies &&
                Object.keys(tb.entityCurrencies).length > 0 ? (
                  <p className="fx-hint">
                    已按主体识别本位币：
                    {Object.entries(tb.entityCurrencies)
                      .map(([entity, code]) => `${entity} = ${code}`)
                      .join("；")}
                    。下拉框已分别预选，请核对后继续。
                  </p>
                ) : tb?.uniformCurrency ? (
                  <p className="fx-hint">
                    TB 的本位币币种列整列都是 {tb.uniformCurrency}
                    ，已自动预填。这与“原币币种”是两个独立口径：原币为 USD
                    不代表公司本位币也是 USD。
                  </p>
                ) : (
                  <p className="fx-hint">
                    未从 TB 识别到单一的本位币币种，暂按 CNY 预填。请在核对 JE
                    字段映射前确认；“原币币种”不会被当作公司本位币。
                  </p>
                )}
                {entities.length ? (
                  entities.map((entity) => (
                    <label key={entity}>
                      <span>{entity}</span>
                      <select
                        aria-label={`${entity} 本位币`}
                        value={
                          entityCurrencies[entity] ?? defaultFunctionalCurrency
                        }
                        onChange={(e) =>
                          setEntityCurrency(entity, e.target.value)
                        }
                      >
                        {fxCurrencyOptions(
                          entityCurrencies[entity],
                          defaultFunctionalCurrency,
                        ).map((code) => (
                          <option key={code} value={code}>
                            {code}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))
                ) : (
                  <label>
                    <span>本位币（全表）</span>
                    <select
                      aria-label="全表本位币"
                      value={
                        entityCurrencies[fixedEntity] ??
                        defaultFunctionalCurrency
                      }
                      onChange={(e) =>
                        setEntityCurrency(fixedEntity, e.target.value)
                      }
                    >
                      {fxCurrencyOptions(
                        entityCurrencies[fixedEntity],
                        defaultFunctionalCurrency,
                      ).map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </CardContent>
            </Card>
          )}
          <div className="fx-preview-stack">
            {je && (
              <FxPreview
                title="JE 文件预览与字段映射"
                kind="je"
                mode={mode}
                inspection={je}
                mapping={jeMapping}
                labels={JE_LABELS}
                missing={fxMissingRequired(
                  "je",
                  jeMapping,
                  true,
                  fixedEntity,
                  mode,
                )}
                banner={
                  reviewing.je ? (
                    <p aria-live="polite" className="fx-hint">
                      正在复核字段映射；复核期间暂时锁定。
                    </p>
                  ) : null
                }
                onMappingChange={(action) => {
                  const next = typeof action === "function" ? action(jeMapping) : action;
                  if (JSON.stringify(next.auxiliary ?? null) !== JSON.stringify(jeMapping.auxiliary ?? null))
                    setJeAuxiliaryManual(true);
                  reviews.clearReview("je");
                  setJeMapping(next);
                }}
                reviewBusy={reviewing.je}
              />
            )}
            {tb && (
              <FxPreview
                title="TB 文件预览与字段映射"
                kind="tb"
                mode={mode}
                inspection={tb}
                mapping={tbMapping}
                labels={TB_LABELS}
                missing={fxMissingRequired(
                  "tb",
                  tbMapping,
                  Boolean(je),
                  fixedEntity,
                )}
                banner={
                  <>
                    {reviewing.tb ? (
                      <p aria-live="polite" className="fx-hint">
                        正在复核字段映射；复核期间暂时锁定。
                      </p>
                    ) : null}
                    {tb.foreignCurrencyNeedsConfirmation && (
                      <div className="fx-currency-confirm">
                        <div>
                          <strong>检测到多个外币币种候选</strong>
                          <p>
                            系统已预选“{String(tbMapping.currency ?? "—")}
                            ”。候选：
                            {(tb.foreignCurrencyCandidates ?? [])
                              .map(
                                (item) =>
                                  `${item.column}（${item.foreignCurrencies.join("/")}）`,
                              )
                              .join("、")}
                            。请核对预览后确认。
                          </p>
                        </div>
                        <Button
                          variant="secondary"
                          disabled={busy || reviewing.tb || tbCurrencyConfirmed}
                          onClick={() => setTbCurrencyConfirmed(true)}
                        >
                          {tbCurrencyConfirmed
                            ? "已确认外币列"
                            : "确认当前外币列"}
                        </Button>
                      </div>
                    )}
                  </>
                }
                onMappingChange={(action) => {
                  setTbCurrencyConfirmed(false);
                  reviews.clearReview("tb");
                  setTbMapping(action);
                }}
                reviewBusy={reviewing.tb}
              />
            )}
          </div>
          <div className="fx-step-actions fx-step-actions-sticky">
            <Button
              disabled={(!je && !tb) || busy}
              onClick={() => void proceedAfterMappingGate(1)}
            >
              下一步：确认TB科目类型
            </Button>
          </div>
        </>
      )}
      {step === 1 && (
        <>
          {(tb?.sampledPreview || je?.sampledPreview) && (
            <p className="fx-hint" role="status">正在读取完整科目清单，当前样本目录不能用于最终分类。</p>
          )}
          {!tb && (
            <p className="fx-hint" role="status">
              未上传 TB 科目余额表：本步无需确认科目类型，可直接进入下一步测算。
            </p>
          )}
          {(je || tb) && (
            <div>
              <Card>
                <CardHeader>
                  <CardTitle>TB科目类型确认</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="fx-accounts-block">
                    <KeywordFilter
                      value={accountFilter}
                      onChange={setAccountFilter}
                      ariaLabel="筛选科目"
                      placeholder="输入科目编码、名称、辅助核算或币种（如 USD）关键词，即时过滤"
                      matched={visibleRows.length}
                      total={accounts.length}
                    />
                    <div className={`fx-list fx-accounts${showEntityColumn ? " has-entity" : ""}`}>
                      <div className="fx-accounts-head">
                        {showEntityColumn && <span>主体</span>}
                        <span>科目</span>
                        <span>分类</span>
                        <span>
                          账户币种与识别状态
                          <JargonTip
                            term="账户币种与识别状态"
                            text={"（TB币种列）：取自 TB 的原币币种列。\n（JE币种列）：该科目 JE 明细的原币币种全部一致。\n（按本位币）：未识到有效的原币币种值，需返回检查必填的原币币种列。\n（JE 多币种）：该科目 JE 明细出现多个币种，需按币种拆分 TB 后复核。\n未识别：多主体本位币不一致，无法给出唯一币种。"}
                          />
                        </span>
                      </div>
                      {renderedRows.map((row) => {
                        const account = row.account;
                        const displayName = row.auxiliary
                          ? `${account} · ${row.auxiliary}`
                          : account;
                        const detail =
                          tb?.accountRoleDetails?.[account] ??
                          je?.accountRoleDetails?.[account];
                        // 两边都看：JE 逐行读凭证，比只有一行的 TB 更能反映该科目实际用过哪些币种。
                        // 辅助拆行的行沿用科目级证据作默认：逐户未手选时后端本就按科目级链路取值。
                        const {
                          detected,
                          source,
                          side,
                          seen,
                          fellBack,
                          jeMultiCurrency,
                        } = fxAccountCurrencyDetail(
                          account,
                          je?.accountCurrencyDetails,
                          tb?.accountCurrencyDetails,
                        );
                        // JE 已证明同科目存在多币种时，TB 若只给一行合计余额就无法
                        // 重估；拆行后的逐辅助户正是在这里分币种指定，徽标只挂科目行。
                        const currencyRisk = jeMultiCurrency && !row.auxiliary;
                        // 逐辅助户手选的角色优先，其余回落科目级分类。
                        const rowRole =
                          accountDetailRoles[row.key] ??
                          accountRoles[account] ??
                          "non_monetary";
                        // 非货币性项目／其他损益成本不参与外币重估，账户币种
                        // 固定 N/A，不再让用户选择。
                        const currencyNotApplicable =
                          rowRole === "non_monetary" || rowRole === "other_pnl";
                        return (
                          <label key={row.key}>
                            {showEntityColumn && (
                              <span
                                className="fx-entity-cell"
                                title={row.entity ?? undefined}
                              >
                                {row.entity && row.entity !== DEFAULT_ENTITY
                                  ? row.entity
                                  : "—"}
                              </span>
                            )}
                            <span
                              className="fx-account-name"
                              title={
                                detail
                                  ? `${displayName}\n${detail.reason}（置信度 ${Math.round(detail.confidence * 100)}%）`
                                  : displayName
                              }
                            >
                              {displayName}
                              {!row.auxiliary && !/\s/.test(account.trim()) && (
                                <small className="fx-account-name-missing">
                                  名称未识别，请返回检查“科目名称”映射
                                </small>
                              )}
                            </span>
                            <select
                              value={rowRole}
                              onChange={(e) => {
                                if (row.auxiliary) {
                                  setAccountDetailRoles((v) => ({
                                    ...v,
                                    [row.key]: e.target.value,
                                  }));
                                  return;
                                }
                                setAccountRolesTouched((v) => ({
                                  ...v,
                                  [account]: true,
                                }));
                                setAccountRoles((v) => ({
                                  ...v,
                                  [account]: e.target.value,
                                }));
                              }}
                            >
                              {ROLE_OPTIONS.map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </select>
                            <span className="fx-currency-cell">
                              {currencyNotApplicable ? (
                                <span
                                  className="fx-currency-na"
                                  title="非货币性项目／其他损益成本科目不参与外币重估，无需账户币种"
                                >
                                  N/A
                                </span>
                              ) : (
                                <select
                                  aria-label={`${displayName} 账户币种`}
                                  aria-invalid={currencyRisk || undefined}
                                  className={
                                    currencyRisk
                                      ? "fx-currency-risky"
                                      : (row.auxiliary
                                          ? accountDetailCurrencies[row.key]
                                          : accountCurrencies[account])
                                        ? "fx-currency-override"
                                        : fellBack
                                          ? "fx-currency-unknown"
                                          : undefined
                                  }
                                  title={
                                    currencyRisk
                                      ? `JE中该科目出现过 ${seen.join("、")} 等多个币种，说明该科目可能同时持有多币种敞口。
请复核TB是否按币种拆分；若TB只给该科目一行合计余额，就无法用单一汇率可靠重估。
正确做法是改用按币种拆分的科目余额表。`
                                      : detected
                                        ? `系统识别：${detected}（依据${source}）${
                                          seen.length > 1
                                            ? `
该科目出现过：${seen.join("、")}`
                                            : ""
                                        }`
                                        : fallbackFunctional
                                          ? `系统未识别到该科目的币种，按界面填写的本位币 ${fallbackFunctional} 处理，不参与重估。
若该科目实际持有外币，请在此手工指定。`
                                          : "系统未识别到该科目的币种，请手工指定"
                                  }
                                  value={
                                    (row.auxiliary
                                      ? accountDetailCurrencies[row.key]
                                      : accountCurrencies[account]) ?? ""
                                  }
                                  onChange={(e) => {
                                    if (row.auxiliary) {
                                      setAccountDetailCurrencies((v) => ({
                                        ...v,
                                        [row.key]: e.target.value,
                                      }));
                                      return;
                                    }
                                    setAccountCurrencies((v) => ({
                                      ...v,
                                      [account]: e.target.value,
                                    }));
                                  }}
                                >
                                  <option value="">
                                    {fxCurrencyDefaultLabel(detected, side, source, fallbackFunctional)}
                                  </option>
                                  {fxCurrencyOptions(...seen).map((code) => (
                                    <option key={code} value={code}>
                                      {code}
                                    </option>
                                  ))}
                                </select>
                              )}
                              {currencyRisk && !currencyNotApplicable && (
                                <small className="fx-currency-risk-label" role="alert">
                                  JE 多币种；需按币种拆分 TB 后复核
                                </small>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {renderedRows.length < visibleRows.length && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => setAccountReviewLimit((current) => current + FX_ACCOUNT_PAGE_SIZE)}
                      >
                        继续显示（已显示 {renderedRows.length} / {visibleRows.length}）
                      </Button>
                    )}
                    {accounts.length > 0 && visibleRows.length === 0 && (
                      <p className="fx-hint">
                        没有匹配「{accountFilter.trim()}」的科目。
                      </p>
                    )}
                    <AccountConfirmationActions
                      tool="fx"
                      title="汇兑损益"
                      context={JSON.stringify([tbPath, jePath, tbMapping, jeMapping, showEntityColumn, reviewRows.map((row) => row.key)])}
                      columns={[
                        ...(showEntityColumn ? [{ key: "entity", title: "主体" }] : []),
                        { key: "account", title: "科目" },
                        { key: "role", title: "分类", editable: true, options: ROLE_OPTIONS.map(([, label]) => label) },
                        { key: "currency", title: "账户币种", editable: true, options: ["N/A", ...CURRENCY_OPTIONS] },
                      ]}
                      rows={confirmationRows}
                      onImport={(changed) => {
                        const patches = fxConfirmationImportPatches(
                          changed,
                          reviewRows,
                          confirmationRows,
                          accountRoles,
                          accountCurrencies,
                          je?.accountCurrencyDetails,
                          tb?.accountCurrencyDetails,
                          fallbackFunctional,
                          showEntityColumn,
                        );
                        setAccountRoles((current) => ({ ...current, ...patches.roles }));
                        setAccountDetailRoles((current) => {
                          const next = { ...current, ...patches.detailRoles };
                          patches.detailRoleDeletes.forEach((key) => delete next[key]);
                          return next;
                        });
                        setAccountRolesTouched((current) => ({ ...current, ...Object.fromEntries(changed.map((row) => [row.key, true])) }));
                        setAccountCurrencies((current) => ({ ...current, ...patches.currencies }));
                        setAccountDetailCurrencies((current) => {
                          const next = { ...current, ...patches.detailCurrencies };
                          patches.detailCurrencyDeletes.forEach((key) => delete next[key]);
                          return next;
                        });
                      }}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
          <div className="fx-step-actions">
            <Button variant="secondary" onClick={() => setStep(0)}>
              返回上传与识别
            </Button>
            <Button
              disabled={Boolean(tb?.sampledPreview || je?.sampledPreview)}
              onClick={() => setStep(2)}
            >下一步：测算与底稿</Button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <div className="fx-step-actions">
            <Button variant="secondary" onClick={() => setStep(1)}>
              返回科目类型确认
            </Button>
          </div>
          {entityScope.panel}
          <Card>
            <CardHeader>
              <CardTitle>测算与底稿</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="fx-run-grid">
                <label>
                  资产负债表日
                  <DateInput
                    value={reportEnd}
                    onChange={setReportEnd}
                  />
                </label>
                <label>
                  输出文件
                  <input
                    value={displayFileName(outputPath)}
                    readOnly
                    placeholder="默认保存到源文件目录"
                  />
                </label>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const path = await pickPath(
                      "save",
                      "保存审计底稿",
                      ["xlsx"],
                      "汇兑损益测算.xlsx",
                    );
                    if (typeof path === "string") setOutputPath(path);
                  }}
                >
                  选择位置
                </Button>
              </div>
              <p className="fx-rate-note">汇率取自中国人民银行。</p>
              {(requiredMappingsMissing.length > 0 ||
                currencyConfirmationMissing) && (
                <p className="fx-warning" aria-live="polite">
                  还不能测算：
                  {[
                    ...requiredMappingsMissing,
                    ...(currencyConfirmationMissing
                      ? ["TB 外币币种列待确认"]
                      : []),
                  ].join("、")}
                  。请回到
                  <button
                    type="button"
                    className="fx-link-button"
                    onClick={() => setStep(0)}
                  >
                    上传与识别
                  </button>
                  补齐字段映射。
                </p>
              )}
              <p className="fx-stage-note">
                “测算预览”会执行完整汇兑损益测算并在下方展示结果；修改凭证分类后点击“重新测算”。“生成Excel底稿”只生成并保存当前口径的底稿，不会清空已显示的预览结果。
              </p>
              <div className="fx-actions">
                <Button
                  variant="secondary"
                  disabled={
                    busy ||
                    reviewingAny ||
                    requiredMappingsMissing.length > 0 ||
                    currencyConfirmationMissing
                  }
                  onClick={() => void run("fx.preview")}
                >
                  {activeStage === "fx.preview" ? "测算中…" : "测算预览"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    busy ||
                    reviewingAny ||
                    !je ||
                    !result ||
                    requiredMappingsMissing.length > 0 ||
                    currencyConfirmationMissing
                  }
                  onClick={() => void recalculateClassifications()}
                >
                  {activeStage === "fx.recalculate"
                    ? "重新测算中…"
                    : "重新测算"}
                </Button>
                <Button
                  disabled={
                    busy ||
                    reviewingAny ||
                    !result ||
                    formalMeasurementBlocked ||
                    requiredMappingsMissing.length > 0 ||
                    currencyConfirmationMissing
                  }
                  onClick={() => void run("fx.export")}
                >
                  {activeStage === "fx.export"
                    ? "正在生成底稿…"
                    : "生成Excel底稿"}
                </Button>
              </div>
              {activeJobMethod.current === "fx.export" ? (
                busy ? (
                  <div className="fx-export-stage" role="status">
                    <strong>正在生成Excel底稿</strong>
                    <span>
                      测算预览已经完成；当前步骤仅整理并保存底稿，页面上的测算结果会继续保留。
                    </span>
                  </div>
                ) : (
                  completedStage === "fx.export" &&
                  outputsFrom(result).length > 0 && (
                    <p className="fx-export-complete" role="status">
                      Excel底稿已生成；测算预览结果已保留在下方。
                    </p>
                  )
                )
              ) : (
                job && (
                  <JobProgress
                    job={job}
                    detail={step === 2 && error === terminalJobError(job) ? error : undefined}
                    onCancel={busy ? (id) => jobCancel(id) : undefined}
                  />
                )
              )}
              {result && (
                <FxResult result={result} />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </main>
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
  onHeaderChange: (row: number, depth: number, sheet: string) => void;
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
            {displayFileName(props.path)}
          </button>
          <button
            type="button"
            disabled={props.disabled}
            onClick={props.onClear}
          >
            移除
          </button>
          {props.onKindChange && (
            <button
              type="button"
              disabled={props.disabled}
              onClick={props.onKindChange}
            >
              {props.kindChangeLabel ?? "更正类型"}
            </button>
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
            <span>{props.inspection.rowCount.toLocaleString()} 行</span>
            <label>
              Sheet
              <select
                value={props.inspection.sheet}
                onChange={(e) => props.onHeaderChange(0, 0, e.target.value)}
              >
                {props.inspection.sheets.length ? (
                  props.inspection.sheets.map((s) => (
                    <option key={s}>{s}</option>
                  ))
                ) : (
                  <option>{props.inspection.sheet}</option>
                )}
              </select>
            </label>
            <label>
              标题行
              <input
                type="number"
                min={1}
                value={props.inspection.headerRow}
                onChange={(e) =>
                  props.onHeaderChange(
                    Number(e.target.value),
                    props.inspection!.headerDepth,
                    props.inspection!.sheet,
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
                    props.inspection!.headerRow,
                    Number(e.target.value),
                    props.inspection!.sheet,
                  )
                }
              >
                <option value={1}>1层</option>
                <option value={2}>2层</option>
              </select>
            </label>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
/** 可以一个角色对应多列的角色。 */
const MULTI_COLUMN_ROLES = new Set(["id", "accountName", "auxiliary", "date"]);

/**
 * 给某一列加上一个角色标记，返回新的映射。
 *
 * 辅助字段由 TB 值反查认定时可以和 JE 已映射角色共列，手工修订亦如此。
 * 其余核心角色仍维持互斥。
 */
export function fxAttachRole(
  mapping: Record<string, string | string[]>,
  header: string,
  role: string,
): Record<string, string | string[]> {
  const next = { ...mapping };
  if (!role) return next;
  if (role !== "auxiliary") {
    for (const [key, value] of Object.entries(next)) {
      if (key === "auxiliary") continue;
      if (Array.isArray(value)) {
        if (value.includes(header)) {
          const remaining = value.filter((x) => x !== header);
          if (remaining.length) next[key] = remaining;
          else delete next[key];
        }
      } else if (value === header) delete next[key];
    }
  }
  if (!MULTI_COLUMN_ROLES.has(role)) {
    next[role] = header;
    return next;
  }
  const held = Array.isArray(next[role])
    ? next[role]
    : next[role]
      ? [String(next[role])]
      : [];
  if (!held.includes(header)) next[role] = [...held, header];
  return next;
}

/** 摘掉某一列的某个角色标记。 */
export function fxDetachRole(
  mapping: Record<string, string | string[]>,
  header: string,
  role: string,
): Record<string, string | string[]> {
  const next = { ...mapping };
  const value = next[role];
  if (Array.isArray(value)) {
    const remaining = value.filter((x) => x !== header);
    if (remaining.length) next[role] = remaining;
    else delete next[role];
  } else if (value === header) delete next[role];
  return next;
}

function FxPreview(props: {
  title: string;
  kind: "je" | "tb";
  /** JE 与 TB 的原币币种都是必填角色。 */
  mode: Mode;
  inspection: Inspection;
  mapping: Record<string, string | string[]>;
  labels: Record<string, string>;
  missing: string[];
  /** 复核状态与该文件专属的提示，跟着预览表一起显示。 */
  banner?: React.ReactNode;
  onMappingChange: React.Dispatch<
    React.SetStateAction<Record<string, string | string[]>>
  >;
  reviewBusy: boolean;
}) {
  // 标签优先取引擎随识别结果下发的 roles（fx.inspect_* 响应字段），未下发或
  // 没有该角色时回落本页标签表——清单与顺序始终由本页标签表定。
  const labels = resolveRoleLabels(props.inspection.roles, props.labels);
  const roles = Object.entries(labels);
  const forms = useLedgerForms(props.kind);
  const formMatch = forms.length
    ? resolveForm(props.kind, forms, props.mapping)
    : undefined;
  const formNote = describeForm(formMatch, (role) => labels[role] ?? role);
  const mappedRoles = (header: string) =>
    roles
      .filter(([role]) => {
        const value = props.mapping[role];
        return Array.isArray(value)
          ? value.includes(header)
          : String(value ?? "") === header;
      })
      .map(([role]) => role);
  const attach = (header: string, role: string) =>
    props.onMappingChange((current) => fxAttachRole(current, header, role));
  const detach = (header: string, role: string) =>
    props.onMappingChange((current) => fxDetachRole(current, header, role));
  const usedRoles = new Set(
    roles
      .filter(([role]) => {
        const value = props.mapping[role];
        return Array.isArray(value)
          ? value.length > 0
          : Boolean(value && String(value).trim());
      })
      .map(([role]) => role),
  );
  const schemeGroups = [
    ["foreignAmount", "direction"],
    ["foreignDebit", "foreignCredit"],
    ["functionalAmount", "direction"],
    ["functionalDebit", "functionalCredit"],
    ["openingForeignAmount"],
    ["openingForeignDebit", "openingForeignCredit"],
    ["openingFunctionalAmount"],
    ["openingFunctionalDebit", "openingFunctionalCredit"],
    ["closingForeignAmount"],
    ["closingForeignDebit", "closingForeignCredit"],
    ["closingFunctionalAmount"],
    ["closingFunctionalDebit", "closingFunctionalCredit"],
  ];
  const locked = (role: string) =>
    schemeGroups.some(
      (group) =>
        group.includes(role) &&
        schemeGroups.some(
          (other) =>
            other !== group &&
            group.some((value) =>
              value.startsWith("openingForeign")
                ? other.some((x) => x.startsWith("openingForeign"))
                : value.startsWith("openingFunctional")
                  ? other.some((x) => x.startsWith("openingFunctional"))
                  : value.startsWith("closingForeign")
                    ? other.some((x) => x.startsWith("closingForeign"))
                    : value.startsWith("closingFunctional")
                      ? other.some((x) => x.startsWith("closingFunctional"))
                      : value.startsWith("foreign")
                        ? other.some((x) => x.startsWith("foreign"))
                        : value.startsWith("functional")
                          ? other.some((x) => x.startsWith("functional"))
                          : false,
            ) &&
            other.some((value) => usedRoles.has(value)),
        ),
    );
  // 下拉分组按**当前命中的型**排：身份类在前，然后逐个槽位，最后是这一型
  // 用不到的其他记法。必填标记也跟着型走，不再写死在分组标题里。
  const groups = formGroups(props.kind, roles, forms, props.mapping);
  /** 点一下就切换：没选上就加上，已选上就摘掉。 */
  const toggle = (header: string, role: string) => {
    if (!role) return;
    if (mappedRoles(header).includes(role)) detach(header, role);
    else attach(header, role);
  };
  const option = (role: string, label: string, held: string[]) => {
    const chosen = held.includes(role);
    const taken = usedRoles.has(role) && !chosen;
    const roleLocked = locked(role);
    return (
      <option
        key={role}
        value={role}
        className={taken || roleLocked ? "dt-role-taken" : undefined}
      >
        {chosen ? `✓ ${label}` : label}
        {chosen
          ? "（再点取消）"
          : taken
            ? "（已用）"
            : roleLocked
              ? "（与已选记法冲突）"
              : ""}
      </option>
    );
  };
  // 渲染交给共用面板；本工具的叠加规则（fxAttachRole/fxDetachRole）与
  // 记法冲突锁定留在这里，面板只负责把它们呈现出来。
  return (
    <MappingPanel
      title={props.title}
      note={`${props.inspection.rowCount} 行 × ${props.inspection.headers.length} 列`}
      headers={props.inspection.headers}
      rows={props.inspection.preview}
      mapping={props.mapping}
      roles={roles}
      groups={groups}
      requirementOf={(role) =>
        fxCurrencyRequirement(props.kind, props.mapping, props.mode, role) ??
        roleRequirement(formMatch, role)
      }
      formNote={formNote}
      multi={MULTI_COLUMN_ROLES}
      isLocked={locked}
      missing={props.missing}
      banner={props.banner}
      busy={props.reviewBusy}
      mode="toggle"
      rolesOf={mappedRoles}
      onToggle={toggle}
      onChange={() => {
        /* toggle 模式下改动全部走 onToggle */
      }}
    />
  );
}
/** 逐行数据质量按「问题类型 ＋ 严重度」归并，同类几百行不必逐条铺开。 */
export function summarizeQuality(items: Array<Record<string, unknown>>) {
  const order: Record<string, number> = {
    阻断: 0,
    隔离: 1,
    重要提示: 2,
    待复核: 3,
    合并: 4,
    提示: 5,
  };
  const groups = new Map<
    string,
    {
      type: string;
      severity: string;
      count: number;
      detail: string;
      rows: number[];
    }
  >();
  for (const item of items) {
    const type = String(item.type ?? "未分类");
    const severity = String(item.severity ?? "提示");
    const key = `${severity}\u0000${type}`;
    const group = groups.get(key) ?? {
      type,
      severity,
      count: 0,
      detail: "",
      rows: [],
    };
    group.count += 1;
    if (!group.detail && item.detail) group.detail = String(item.detail);
    const row = Number(item.row ?? item.sourceRow ?? NaN);
    if (Number.isFinite(row) && group.rows.length < 5) group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || b.count - a.count,
  );
}
export function fxQualityAction(type: string, severity: string): string {
  if (severity === "合并") return "已合并计入，无需处理";
  if (type.includes("不构成汇兑事项")) return "在底稿“汇兑事项复核”页查看明细";
  if (type.includes("入账汇率") && (type.includes("不恒定") || type.includes("偏离")))
    return "核对该月凭证的入账汇率";
  if (type.includes("牌价口径回退")) return "核对本次采用的替代牌价";
  if (type.includes("汇率") || type.includes("牌价")) return "核对对应日期的汇率，补齐后重算";
  if (type.includes("余额") || type.includes("外币敞口")) return "检查 TB 的科目和币种余额，补齐后重算";
  if (type.includes("日期")) return "核对原始凭证日期";
  if (type.includes("科目") || type.includes("映射")) return "检查科目分类及字段映射";
  if (severity === "提示") return "查看来源资料，确认口径";
  return "检查相关源行，修正后重算";
}

function fxQualityImpact(severity: string, type: string): string {
  if (type.includes("不构成汇兑事项")) return "未纳入测算";
  if (type.includes("估算") || type.includes("倒算") || type.includes("口径回退"))
    return "使用替代口径";
  if (severity === "隔离" || severity === "阻断") return "未计入测算";
  if (severity === "合并") return "已合并计入";
  if (severity === "待复核" || severity === "重要提示") return "结果需复核";
  return "不影响测算";
}
/** 测算跑完后的全部检查结论。
 *
 *  这些结论一直都在算，但以前只写进 Excel 底稿的「数据质量 / 异常与限制 /
 *  TB勾稽」几个 Sheet，界面上一个字都不显示——用户看到一个对不上的差异率，
 *  却没有任何线索说明哪一步没通过、被隔离了多少行、TB 那个数是从哪几个
 *  科目取的。这里把三块摊开：校验提示、逐行数据质量、TB 汇兑损益诊断取数。 */
function FxChecks({ result }: { result: Record<string, unknown> }) {
  const validation = (result.validation ?? {}) as Record<string, unknown>;
  const warnings = (validation.warnings ?? []) as string[];
  const quality = (result.dataQuality ?? []) as Array<Record<string, unknown>>;
  const reconciliation = (result.reconciliation ?? {}) as Record<
    string,
    unknown
  >;
  const tbRows = (reconciliation.tbRows ?? []) as Array<
    Record<string, unknown>
  >;
  const tbGainAmount = reconciliation.tbFxGainAmount ?? tbRows.reduce(
    (sum, row) => sum + Math.max(0, -Number(row.amount ?? 0)), 0,
  );
  const tbLossAmount = reconciliation.tbFxLossAmount ?? tbRows.reduce(
    (sum, row) => sum + Math.max(0, Number(row.amount ?? 0)), 0,
  );
  const groups = summarizeQuality(quality);
  if (!warnings.length && !groups.length && !tbRows.length) return null;
  const prominentWarnings = warnings.filter((message) =>
    message.startsWith("【期间不一致") || message.startsWith("JE 已跳过"),
  );
  const money = (value: unknown) =>
    new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value ?? 0));
  const isolated = groups
    .filter((g) => g.severity === "隔离" || g.severity === "阻断")
    .reduce((sum, g) => sum + g.count, 0);
  const headline = [
    isolated ? `${isolated} 行未计入测算` : "",
    groups.length ? `${groups.length} 类数据问题` : "",
    warnings.length ? `${warnings.length} 项其他提示` : "",
  ].filter(Boolean).join(" · ") || "已核对 TB 来源";
  return (
    <>
    {prominentWarnings.length > 0 && (
      <div className="fx-prominent-warnings" role="status">
        <strong>测算已完成，请复核以下来源问题</strong>
        <ul>{prominentWarnings.map((message, index) => <li key={index}>{message}</li>)}</ul>
      </div>
    )}
    <details className="fx-checks">
      <summary>
        <strong>检查与勾稽</strong>
        <span>{headline}</span>
      </summary>
      <div className="fx-checks-body">
        {warnings.length > 0 && (
          <section>
            <h5>其他提示：{warnings.length} 项</h5>
            <p>测算已完成；如结果不符合预期，再核对这些来源和映射提示。</p>
            <details className="fx-checks-evidence">
              <summary>查看原始提示</summary>
              <ul className="fx-checks-list">
                {warnings.map((text, index) => <li key={index}>{text}</li>)}
              </ul>
            </details>
          </section>
        )}
        {groups.length > 0 && (
          <section>
            <h5>需要检查的数据</h5>
            <div className="fx-checks-table fx-checks-quality">
              <table>
                <thead>
                  <tr>
                    <th>问题</th>
                    <th>影响</th>
                    <th>涉及行</th>
                    <th>建议操作</th>
                    <th>依据</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group, index) => (
                    <tr key={index}>
                      <td>{group.type}</td>
                      <td><span className={`fx-severity ${group.severity === "隔离" || group.severity === "阻断" ? "blocking" : ""}`}>{fxQualityImpact(group.severity, group.type)}</span></td>
                      <td>{group.count} 行{group.rows.length ? `（如第 ${group.rows.join("、")} 行）` : ""}</td>
                      <td>{fxQualityAction(group.type, group.severity)}</td>
                      <td>{group.detail ? <details className="fx-checks-evidence"><summary>查看</summary><small>{group.detail}</small></details> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {tbRows.length > 0 && (
          <section>
            <h5>TB 汇兑损益发生额诊断</h5>
            <p>
              汇兑收益 {money(tbGainAmount)}；汇兑损失 {money(tbLossAmount)}。
              TB 金额只用于追溯和勾稽，不作为客户账面汇兑损益净额；
              JE 剔除损益结转后的净额与该 TB 诊断金额差异：
              {money(reconciliation.jeTbDifference)}。
            </p>
            <div className="fx-checks-table">
              <table>
                <thead>
                  <tr>
                    <th>科目</th>
                    <th>净额方向</th>
                    <th>金额</th>
                    <th>取数口径</th>
                    <th>源文件行</th>
                  </tr>
                </thead>
                <tbody>
                  {tbRows.map((row, index) => (
                    <tr key={index}>
                      <td>{String(row.account ?? "")}</td>
                      <td>{String(row.nature ?? "汇兑损益")}</td>
                      <td className="fx-checks-number">{money(row.amount)}</td>
                      <td>{String(row.basis ?? "")}</td>
                      <td className="fx-checks-number">
                        {String(row.sourceRow ?? "")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </details>
    </>
  );
}
/** TB＋JE 余额滚动失配清单：**提示但不阻断**，逐条列出差在哪，用户自己判断。 */
function RollforwardIssues({
  validation,
}: {
  validation?: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const issues = (validation?.issues ?? []) as Array<Record<string, unknown>>;
  if (!issues.length) return null;
  const money = (value: unknown) =>
    new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value ?? 0));
  const unit = String(validation?.unit ?? "本位币");
  return (
    <section className="fx-rollforward-issues">
      <div className="fx-rollforward-head">
        <div>
          <strong>TB ＋ JE 余额滚动有 {issues.length} 个账户对不上</strong>
          <small>
            按「期初 ＋ JE 发生额 ＝ 期末」逐个账户核对（{unit}
            口径）。测算照常完成， 但按月推算余额依赖 JE
            的完整性，这部分结果需要你自行判断可用性。
          </small>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起明细" : "查看明细"}
        </Button>
      </div>
      {open && (
        <div className="fx-rollforward-table">
          <table>
            <thead>
              <tr>
                <th>主体</th>
                <th>科目</th>
                <th>币种</th>
                <th>期初</th>
                <th>JE 发生额</th>
                <th>推算期末</th>
                <th>TB 期末</th>
                <th>差异</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((item, index) => (
                <tr key={index}>
                  <td>{String(item.entity ?? "")}</td>
                  <td title={String(item.account ?? "")}>
                    {String(item.account ?? "")}
                  </td>
                  <td>{String(item.currency ?? "")}</td>
                  <td>{item.type ? "—" : money(item.opening)}</td>
                  <td>{money(item.jeMovement)}</td>
                  <td>{item.type ? "—" : money(item.derivedClosing)}</td>
                  <td>{item.type ? "—" : money(item.tbClosing)}</td>
                  <td className="fx-rollforward-diff">
                    {item.type ? String(item.type) : money(item.difference)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FxResult({ result }: { result: Record<string, unknown> }) {
  const summary = (result.summary ?? {}) as Record<string, unknown>;
  const formalMeasurementAvailable =
    summary.formalMeasurementAvailable !== false;
  const formalGateReasons = Array.isArray(summary.formalMeasurementGateReasons)
    ? summary.formalMeasurementGateReasons.map(String)
    : [];
  const outputs = (result.outputPaths ?? []) as string[];
  const rollforward = (result.unrealizedBalanceRollforward ?? []) as Array<
    Record<string, unknown>
  >;
  const realizedRates = (result.realized ?? []) as Array<Record<string, unknown>>;
  const rateRows = [
    ...realizedRates.map((item) => ({
      type: "已实现",
      period: item.date,
      voucherId: item.voucherId,
      account: item.account,
      currency: item.currency,
      customerRate: item.customerRate,
      customerRateBasis: item.customerRateBasis ?? "",
      reliability: item.customerRateReliability ?? "",
      auditOpeningRate: item.monthOpeningRate,
      auditRate: item.officialRate,
      openingDifference: item.customerVsAuditOpeningRateDifference,
      auditDifference: item.customerVsAuditTransactionRateDifference,
      impact: item.carryingBasisDifference,
    })),
    ...rollforward.map((item) => ({
      type: "未实现",
      period: item.monthEnd,
      voucherId: "",
      account: item.account,
      currency: item.currency,
      customerRate: item.customerRate,
      customerRateBasis: item.customerRateBasis ?? "",
      reliability: item.customerRateReliability ?? "",
      auditOpeningRate: null,
      auditRate: item.officialRate,
      openingDifference: null,
      auditDifference: item.customerVsAuditRateDifference,
      impact: item.customerVsAuditRateImpact,
    })),
  ]
    .filter((item) => item.customerRate != null)
    .sort(
      (left, right) =>
        Math.abs(Number(right.impact ?? 0)) - Math.abs(Number(left.impact ?? 0)),
    );
  const unrealizedComparisonDifference = rollforward.reduce(
    (sum, item) => sum + Number(item.suggestedAdjustment ?? 0),
    0,
  );
  const amount = (value: unknown) => {
    const number = Number(value ?? 0);
    return new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Object.is(number, -0) || Math.abs(number) < 0.005 ? 0 : number);
  };
  const percent = (value: unknown) =>
    value == null
      ? "无法计算"
      : new Intl.NumberFormat("zh-CN", {
          style: "percent",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(Number(value));
  const rate = (value: unknown) =>
    value == null || !Number.isFinite(Number(value))
      ? "—"
      : Number(value).toFixed(6);
  const bookKnown = summary.tbFxGainLoss != null;
  const bookSplit = summary.tbFxGainLossPresentation === "split";
  const passed = summary.reconciliationPassed === true;
  const resultStatus = fxResultTrustStatus(summary);
  const entityCoverage = (result.entityCoverage ?? {}) as {
    matched?: string[];
    unmatchedJe?: string[];
    unmatchedTb?: string[];
  };
  const unmatchedEntities = [
    ...(entityCoverage.unmatchedJe ?? []).map((name) => `JE：${name}`),
    ...(entityCoverage.unmatchedTb ?? []).map((name) => `TB：${name}`),
  ];
  const metric = (
    label: string,
    value: unknown,
    detail?: ReactNode,
    tone = "",
  ) => (
    <div className={`fx-bridge-metric ${tone}`.trim()}>
      <span>{label}</span>
      <strong>{typeof value === "string" ? value : amount(value)}</strong>
      {detail != null && detail !== "" && <small>{detail}</small>}
    </div>
  );
  return (
    <section className="fx-result" aria-labelledby="fx-result-title">
      <div className="fx-result-heading">
        <div>
          <h3 id="fx-result-title">汇兑损益测算结果</h3>
        </div>
        {outputs.map((path) => (
          <Button
            key={path}
            variant="secondary"
            onClick={() => void openOutput(path)}
          >
            打开Excel底稿
          </Button>
        ))}
      </div>
      <div
        className={`fx-result-status ${resultStatus.tone}`}
        role="status"
        aria-live="polite"
      >
        <strong>{resultStatus.title}</strong>
        <span>{resultStatus.detail}</span>
      </div>
      {!formalMeasurementAvailable && (
        <div className="fx-prominent-warnings" role="alert">
          <strong>正式测算结果及 Excel 底稿已阻断</strong>
          <span>下方金额仅作诊断，不得作为审计结论。</span>
          {formalGateReasons.length > 0 && (
            <ul>
              {formalGateReasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {unmatchedEntities.length > 0 && (
        <p className="fa-missing-hint">
          本次仅测算 TB 与 JE 匹配上的主体：
          {(entityCoverage.matched ?? []).join("、") || "无"}。以下未匹配主体仅作提示，
          未进入任何测算：{unmatchedEntities.join("、")}。
        </p>
      )}
      {Boolean(summary.needsZeroResultReview) && (
        <p className="fa-missing-hint">
          已读取外币凭证，但没有事件进入自动测算；相关金额已归入待复核项目，不会再被当作正常“0”。
        </p>
      )}
      <RollforwardIssues
        validation={
          result.balanceRollforwardValidation as
            Record<string, unknown> | undefined
        }
      />
      <div className="fx-bridge-step">
        <div className="fx-step-label">
          <b>1</b>
          <span>形成自动测算</span>
        </div>
        <div className="fx-bridge-equation">
          {metric("已实现汇兑损益", summary.realizedGainLoss)}
          <span className="fx-operator" aria-hidden="true">
            ＋
          </span>
          {metric("未实现汇兑损益", summary.unrealizedAdjustment)}
          <span className="fx-operator" aria-hidden="true">
            ＝
          </span>
          {metric(
            formalMeasurementAvailable ? "自动测算合计" : "诊断测算合计",
            formalMeasurementAvailable
              ? summary.automaticMeasuredFxGainLoss
              : summary.diagnosticMeasuredFxGainLoss,
            undefined,
            "total",
          )}
        </div>
      </div>
      {formalMeasurementAvailable && bookSplit ? (
        <>
          <div className="fx-bridge-step comparison">
            <div className="fx-step-label">
              <b>2</b>
              <span>比较已实现</span>
            </div>
            <div className="fx-bridge-equation">
              {metric("自动测算已实现", summary.realizedGainLoss)}
              <span className="fx-operator compare" aria-hidden="true">
                对比
              </span>
              {metric("客户账面已实现（JE）", summary.tbRealizedGainLoss)}
              <span className="fx-operator" aria-hidden="true">
                ＝
              </span>
              {metric(
                "已实现差异",
                Number(summary.realizedGainLoss ?? 0) -
                  Number(summary.tbRealizedGainLoss ?? 0),
                undefined,
                "total",
              )}
            </div>
          </div>
          <div className="fx-bridge-step comparison">
            <div className="fx-step-label">
              <b>3</b>
              <span>比较未实现</span>
            </div>
            <div className="fx-bridge-equation">
              {metric("自动测算未实现", summary.unrealizedAdjustment)}
              <span className="fx-operator compare" aria-hidden="true">
                对比
              </span>
              {metric("客户账面未实现（JE）", summary.tbUnrealizedGainLoss)}
              <span className="fx-operator" aria-hidden="true">
                ＝
              </span>
              {metric(
                "未实现差异",
                Number(summary.unrealizedAdjustment ?? 0) -
                  Number(summary.tbUnrealizedGainLoss ?? 0),
                undefined,
                "total",
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="fx-bridge-step comparison">
          <div className="fx-step-label">
            <b>2</b>
            <span>比较合计</span>
          </div>
          <div className="fx-bridge-equation">
            {metric(
              formalMeasurementAvailable ? "自动测算合计" : "诊断测算合计",
              formalMeasurementAvailable
                ? summary.automaticMeasuredFxGainLoss
                : summary.diagnosticMeasuredFxGainLoss,
            )}
            <span className="fx-operator compare" aria-hidden="true">
              对比
            </span>
            {metric(
              "客户账面汇兑损益净额（JE）",
              bookKnown ? summary.tbFxGainLoss : "无法比较",
            )}
            <span className="fx-operator" aria-hidden="true">
              ＝
            </span>
            {metric(
              "合计差异",
              bookKnown && formalMeasurementAvailable
                ? (summary.difference ?? 0)
                : "无法比较",
              bookKnown && formalMeasurementAvailable
                ? `差异率 ${percent(summary.differenceRatio)}`
                : undefined,
              bookKnown && formalMeasurementAvailable && passed
                ? "pass"
                : "warning",
            )}
          </div>
        </div>
      )}
      <FxChecks result={result} />
      {rollforward.length > 0 && (
        <section className="fx-unrealized-module">
          <div>
            <h4>未实现汇兑损益测算</h4>
            <p>
              月末按官方汇率重估各外币账户余额，得出审计口径的未实现汇兑损益；右边是与客户已入账数的差额。
            </p>
          </div>
          <div className="fx-unrealized-metrics">
            {metric(
              "与客户入账差异",
              unrealizedComparisonDifference,
              "审计重估损益 − 客户已入账未实现汇兑损益",
              "warning",
            )}
          </div>
        </section>
      )}
      {rateRows.length > 0 && (
        <section className="fx-rate-comparison" aria-labelledby="fx-rate-comparison-title">
          <div>
            <h4 id="fx-rate-comparison-title">客户与审计汇率比较</h4>
            <p>
              客户隐含汇率由原币金额与本位币金额静默反推，仅用于解释差异，不参与审计测算。
            </p>
          </div>
          <div className="fx-rate-comparison-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>类型</th><th>日期/月末</th><th>凭证号</th><th>科目</th><th>币种</th>
                  <th>客户隐含汇率</th><th>反推依据</th><th>审计月初汇率</th>
                  <th>审计交易日/月末汇率</th><th>对月初汇率差</th>
                  <th>对交易日/月末汇率差</th><th>汇率基础影响</th>
                </tr>
              </thead>
              <tbody>
                {rateRows.slice(0, 100).map((item, index) => (
                  <tr key={`${String(item.type)}-${String(item.period)}-${String(item.voucherId)}-${String(item.account)}-${index}`}>
                    <td>{String(item.type)}</td>
                    <td>{String(item.period ?? "")}</td>
                    <td>{String(item.voucherId ?? "")}</td>
                    <td title={String(item.account ?? "")}>{String(item.account ?? "")}</td>
                    <td>{String(item.currency ?? "")}</td>
                    <td>{rate(item.customerRate)}</td>
                    <td>{`${String(item.reliability)}｜${String(item.customerRateBasis)}`}</td>
                    <td>{item.type === "已实现" ? rate(item.auditOpeningRate) : "—"}</td>
                    <td>{rate(item.auditRate)}</td>
                    <td>{item.type === "已实现" ? rate(item.openingDifference) : "—"}</td>
                    <td>{rate(item.auditDifference)}</td>
                    <td>{item.impact == null ? "—" : amount(item.impact)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rateRows.length > 100 && (
            <p>预览按影响金额展示前100行；Excel底稿列示全部{rateRows.length}行。</p>
          )}
        </section>
      )}
    </section>
  );
}
function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}
function outputsFrom(value: Record<string, unknown> | undefined) {
  return (value?.outputPaths ?? []) as string[];
}
/** 校验未通过时，把后端塞在 detail 里的那段 JSON 拆成人话。
 *
 *  `MAPPING_INVALID` 的 detail 是 validate_mapping 的完整结果，直接显示就是
 *  一串花括号。用户实测遇到过：界面只说「字段映射或数据质量校验未通过」，
 *  到底哪一条不通过要靠猜——而后端其实已经把原因写得很清楚了。 */
export function validationDetail(detail: unknown): string {
  if (typeof detail !== "string" || !detail.includes("errors")) return "";
  try {
    const parsed = JSON.parse(detail) as { errors?: unknown };
    const texts = ((parsed.errors ?? []) as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
    if (!texts.length) return "";
    return `具体是：${texts.map((text, index) => `${index + 1}. ${text}`).join("；")}`;
  } catch {
    return "";
  }
}
function errorText(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const detailed = validationDetail(v.detail);
    if (detailed)
      return `${String(v.userMessage ?? "校验未通过。")}${detailed}`;
    return String(
      v.userMessage ?? v.message ?? v.detail ?? "处理失败，请重试。",
    );
  }
  return "处理失败，请重试。";
}
