import { useEffect, useMemo, useState } from "react";
import "./AudiPickLegacyLoanAudit.css";

export type AudiPickLoanAuditProject = {
  id: string;
  name: string;
  client?: string;
  date?: string;
  reportDate?: string;
  loanReportDate?: string;
};

export type AudiPickLoanAuditContract = {
  id: string;
  name?: string;
  file?: string;
  ruleId?: string;
  detectedRuleId?: string;
};

export type AudiPickLoanAuditResult = Record<string, unknown> & {
  id?: string;
  contractId?: string;
  ruleId?: string;
  fieldSetId?: string;
  extractAt?: string;
};

export type AudiPickLoanAuditRelationGroup = {
  anchorFileId: string;
  members?: Array<{ fileId: string; role?: string }>;
};

export type AudiPickLegacyLoanAuditActions = {
  onBack: () => void;
  onReportDateChange: (date: string) => void | Promise<void>;
  onExport: () => void | Promise<void>;
  onOpenWorkpaper: (contractId: string) => void | Promise<void>;
};

export type AudiPickLegacyLoanAuditProps = {
  project: AudiPickLoanAuditProject;
  contracts: AudiPickLoanAuditContract[];
  results: AudiPickLoanAuditResult[];
  relationGroups?: AudiPickLoanAuditRelationGroup[];
  reportDate?: string;
  busy?: boolean;
  actions: AudiPickLegacyLoanAuditActions;
};

type LoanAuditTab = "dashboard" | "cards" | "repayment";
type Tone = "green" | "amber" | "red" | "blue" | "gray";
type ParsedDate = { date: Date; iso: string };
type LoanRisk = {
  type: string;
  label: string;
  severity: "medium" | "high";
  detail: string;
};
type RepaymentRow = {
  debtId: string;
  contractId: string;
  contractNo: string;
  date: string;
  currency: string;
  amount: number | null;
  amountText: string;
  source: string;
  status: string;
};
type Validation = {
  level: "warning" | "error";
  code: string;
  message: string;
  debtId?: string;
};

export type AudiPickLoanAuditDebt = {
  id: string;
  contractId: string;
  contractName: string;
  contractNo: string;
  displayName: string;
  borrower: string;
  lender: string;
  currency: string;
  principal: number | null;
  principalText: string;
  signingDate: ParsedDate | null;
  startDate: ParsedDate | null;
  maturityDate: ParsedDate | null;
  newSigned: boolean;
  newEffective: boolean;
  computedStatementClassification: string;
  repayment: {
    status: string;
    rows: RepaymentRow[];
    pendingReason: string;
    raw: string;
  };
  risks: LoanRisk[];
  validations: Validation[];
  relatedFiles: Array<{ fileId: string; role: string; name: string }>;
  raw: AudiPickLoanAuditResult;
};

export type AudiPickLoanAuditModel = {
  project: AudiPickLoanAuditProject;
  reportDate: string;
  reportYear: number | null;
  debts: AudiPickLoanAuditDebt[];
  counts: {
    debtCount: number;
    contractCount: number;
    associatedExcluded: number;
    loanCandidateFileCount: number;
    extractedLoanFileCount: number;
    extractionCoverage: number;
    newSigned: number;
    newEffective: number;
    riskCount: number;
    pendingRepayment: number;
    futureTwelveMonthDebtCount: number;
    maturityWithinTwelveCount: number;
    floatingRateCount: number;
    securedCount: number;
    restrictionCount: number;
    rateResetSoonCount: number;
  };
  currencyStats: Array<{
    currency: string;
    currencyName: string;
    amount: number;
    debtCount: number;
    display: string;
  }>;
  futureTwelveMonthTotals: Record<string, number>;
  risks: Array<
    LoanRisk & { debtId: string; contractId: string; contractNo: string }
  >;
  repaymentPlan: RepaymentRow[];
  monthlyMatrix: {
    months: string[];
    rowByDebtId: Record<
      string,
      {
        cells: Record<string, { amount: number | null; hasUncertain: boolean }>;
      }
    >;
    totalsByCurrency: Record<string, Record<string, number>>;
  };
  validations: Validation[];
};

const CURRENCY_NAMES: Record<string, string> = {
  CNY: "人民币",
  USD: "美元",
  HKD: "港币",
  EUR: "欧元",
  JPY: "日元",
  GBP: "英镑",
  AUD: "澳元",
  CAD: "加元",
  SGD: "新加坡元",
  CHF: "瑞士法郎",
};

const EMPTY_VALUES = new Set([
  "",
  "未明确",
  "不适用",
  "无",
  "暂无",
  "-",
  "--",
  "null",
  "undefined",
]);

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function known(value: unknown): boolean {
  return !EMPTY_VALUES.has(text(value).toLowerCase());
}

function firstValue(source: AudiPickLoanAuditResult, keys: string[]): unknown {
  return keys.map((key) => source[key]).find(known) ?? "";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function validDate(year: number, month: number, day: number): Date | null {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day
    ? value
    : null;
}

function parseDate(value: unknown): ParsedDate | null {
  const source = text(value);
  const match = source.match(
    /(19|20)\d{2}\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/,
  );
  if (!match) return null;
  const date = validDate(
    Number(match[0].match(/^(19|20)\d{2}/)?.[0]),
    Number(match[2]),
    Number(match[3]),
  );
  return date ? { date, iso: isoDate(date) } : null;
}

function dateMatches(
  value: unknown,
): Array<ParsedDate & { index: number; length: number }> {
  const source = text(value);
  const matches: Array<ParsedDate & { index: number; length: number }> = [];
  const pattern =
    /(19|20)\d{2}\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/g;
  for (const match of source.matchAll(pattern)) {
    const year = Number(match[0].match(/^(19|20)\d{2}/)?.[0]);
    const date = validDate(year, Number(match[2]), Number(match[3]));
    if (date)
      matches.push({
        date,
        iso: isoDate(date),
        index: match.index ?? 0,
        length: match[0].length,
      });
  }
  return matches;
}

function normalizeCurrency(value: unknown): string {
  const source = text(value).toUpperCase().replace(/\s+/g, "");
  if (/人民币|RMB|CNY|￥|¥/.test(source)) return "CNY";
  if (/美元|美金|USD|US\$/.test(source) || /^\$/.test(source)) return "USD";
  if (/港币|港元|HKD|HK\$/.test(source)) return "HKD";
  if (/欧元|EUR|€/.test(source)) return "EUR";
  if (/日元|JPY|JP¥/.test(source)) return "JPY";
  if (/英镑|GBP|£/.test(source)) return "GBP";
  if (/澳元|AUD|A\$/.test(source)) return "AUD";
  if (/加元|CAD|C\$/.test(source)) return "CAD";
  if (/新加坡元|新币|SGD|S\$/.test(source)) return "SGD";
  if (/瑞士法郎|CHF/.test(source)) return "CHF";
  return CURRENCY_NAMES[source] ? source : "";
}

function parseAmount(value: unknown, fallbackCurrency?: unknown) {
  const raw = text(value);
  const currency =
    normalizeCurrency(raw) || normalizeCurrency(fallbackCurrency);
  const match = raw
    .replace(/[,，\s]/g, "")
    .match(
      /(-?\d+(?:\.\d+)?)\s*(亿元|千万|百万元|万元|千元|元|BILLION|MILLION|THOUSAND)?/i,
    );
  if (!match) return { raw, currency, amount: null as number | null };
  const factors: Record<string, number> = {
    元: 1,
    千元: 1_000,
    万元: 10_000,
    百万元: 1_000_000,
    千万: 10_000_000,
    亿元: 100_000_000,
    thousand: 1_000,
    million: 1_000_000,
    billion: 1_000_000_000,
  };
  const unit = (match[2] ?? "").toLowerCase();
  const amount = Number(match[1]) * (factors[unit] ?? 1);
  return { raw, currency, amount: Number.isFinite(amount) ? amount : null };
}

function formatAmount(amount: number | null, currency: string): string {
  if (amount === null) return "待明确";
  const name = CURRENCY_NAMES[currency] ?? currency;
  return `${name ? `${name} ` : ""}${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

function addMonths(date: Date, count: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCMonth(copy.getUTCMonth() + count);
  return copy;
}

function quarterEndsBetween(start: Date, end: Date): Date[] {
  const result: Date[] = [];
  for (
    let year = start.getUTCFullYear();
    year <= end.getUTCFullYear();
    year += 1
  ) {
    [3, 6, 9, 12].forEach((month) => {
      const day = month === 3 || month === 12 ? 31 : 30;
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date >= start && date <= end) result.push(date);
    });
  }
  return result;
}

function buildRepayment(
  debt: Omit<AudiPickLoanAuditDebt, "displayName" | "repayment" | "risks">,
  validations: Validation[],
) {
  const schedule = text(debt.raw.repayment_schedule);
  const method = text(debt.raw.repayment_method);
  const rows: RepaymentRow[] = [];
  let pendingReason = "";
  if (/每(?:一)?季度(?:末|季末)|按季末/.test(schedule)) {
    if (debt.startDate && debt.maturityDate) {
      const recurring = parseAmount(schedule, debt.currency);
      quarterEndsBetween(debt.startDate.date, debt.maturityDate.date).forEach(
        (date) => {
          rows.push({
            debtId: debt.id,
            contractId: debt.contractId,
            contractNo: debt.contractNo,
            date: isoDate(date),
            currency: recurring.currency || debt.currency,
            amount: recurring.amount,
            amountText: recurring.amount === null ? "待明确" : recurring.raw,
            source: "每季度末（借款起止日展开）",
            status:
              recurring.amount === null ? "仅展开日期，金额待明确" : "推定",
          });
        },
      );
    } else {
      pendingReason = "“每季度末”未提供明确起止日期，不展开还款日期";
    }
  } else {
    const matches = dateMatches(schedule);
    matches.forEach((entry, index) => {
      const segment = schedule.slice(
        entry.index + entry.length,
        matches[index + 1]?.index ?? schedule.length,
      );
      const amount = parseAmount(segment, debt.currency);
      rows.push({
        debtId: debt.id,
        contractId: debt.contractId,
        contractNo: debt.contractNo,
        date: entry.iso,
        currency: amount.currency || debt.currency,
        amount: amount.amount,
        amountText: amount.amount === null ? "待明确" : amount.raw,
        source: "明确日期",
        status: amount.amount === null ? "金额待明确" : "明确",
      });
    });
  }
  if (!rows.length && /到期一次还本|一次性还本/.test(`${method} ${schedule}`)) {
    if (debt.maturityDate) {
      rows.push({
        debtId: debt.id,
        contractId: debt.contractId,
        contractNo: debt.contractNo,
        date: debt.maturityDate.iso,
        currency: debt.currency,
        amount: debt.principal,
        amountText: debt.principalText,
        source: "到期一次还本推定",
        status: debt.principal === null ? "日期明确，金额待明确" : "推定",
      });
    } else {
      pendingReason = "到期一次还本但到期日未明确";
    }
  }
  if (!rows.length && !pendingReason)
    pendingReason = "无法从现有条款确定还款日期";
  if (pendingReason) {
    validations.push({
      level: "warning",
      code: "repayment_unclear",
      message: pendingReason,
      debtId: debt.id,
    });
  }
  return {
    status: rows.length
      ? rows.some((row) => row.amount === null)
        ? "部分待明确"
        : "已解析"
      : "待明确",
    rows,
    pendingReason,
    raw: schedule || method,
  };
}

function buildRisks(
  debt: AudiPickLoanAuditDebt,
  covenantRows: AudiPickLoanAuditResult[],
  reportDate: ParsedDate | null,
): LoanRisk[] {
  const risks: LoanRisk[] = [];
  const rate = `${text(debt.raw.interest_rate_type)} ${text(debt.raw.interest_rate)} ${text(debt.raw.interest_method)}`;
  if (/浮动|LPR|SOFR|HIBOR|SHIBOR|基准利率|基点|\bBP\b|加点|减点/i.test(rate)) {
    risks.push({
      type: "floating_rate",
      label: "浮动利率重定价",
      severity: "medium",
      detail: text(debt.raw.interest_rate) || text(debt.raw.interest_method),
    });
  }
  const security = [
    debt.raw.loan_nature,
    debt.raw.guarantor,
    debt.raw.security_summary,
  ]
    .filter(known)
    .map(text)
    .join("；");
  if (/保证|抵押|质押|混合担保/.test(security)) {
    risks.push({
      type: "security",
      label: "担保及权利受限",
      severity: "medium",
      detail: security,
    });
  }
  const covenant = [
    debt.raw.covenant_summary,
    ...covenantRows.map(
      (row) => row.title ?? row.auditor_summary ?? row.excerpt,
    ),
  ]
    .filter(known)
    .map(text)
    .join("；");
  if (covenant && !/未发现明确限制性契约|无明确/.test(covenant)) {
    risks.push({
      type: "covenant",
      label: "限制性条款及违约触发",
      severity: /提前到期|加速到期|取消授信|违约/.test(covenant)
        ? "high"
        : "medium",
      detail: covenant,
    });
  }
  const prepayment = `${text(debt.raw.prepayment_restriction_status)} ${text(debt.raw.prepayment_default)}`;
  if (
    /有限制|同意|通知|补偿|违约金|手续费|最低额/.test(prepayment) &&
    !/无限制|未明确/.test(prepayment)
  ) {
    risks.push({
      type: "prepayment",
      label: "提前还款存在限制",
      severity: "medium",
      detail: prepayment,
    });
  }
  if (/存在明确财务指标约束/.test(text(debt.raw.financial_covenant_status))) {
    risks.push({
      type: "financial_covenant",
      label: "存在财务指标约束",
      severity: "medium",
      detail: text(debt.raw.covenant_summary),
    });
  }
  if (
    /存在明确触发/.test(
      text(debt.raw.acceleration_or_material_default_trigger_status),
    )
  ) {
    risks.push({
      type: "acceleration",
      label: "存在加速到期触发",
      severity: "high",
      detail: text(debt.raw.prepayment_default),
    });
  }
  const reset = parseDate(debt.raw.next_interest_rate_adjustment_date);
  if (reportDate && reset) {
    const days = Math.ceil(
      (reset.date.getTime() - reportDate.date.getTime()) / 86_400_000,
    );
    if (days >= 0 && days <= 60) {
      risks.push({
        type: "rate_reset_soon",
        label: "利率调整日临近",
        severity: "medium",
        detail: `${reset.iso}，距报告日${days}天`,
      });
    }
  }
  return risks;
}

function latestLoanResults(
  results: AudiPickLoanAuditResult[],
  memberOwner: Record<string, string>,
) {
  const grouped = new Map<
    string,
    Map<
      string,
      { rows: AudiPickLoanAuditResult[]; latest: number; index: number }
    >
  >();
  results.forEach((row, index) => {
    const contractId = text(row.contractId);
    if (
      text(row.ruleId) !== "loan_general" ||
      !contractId ||
      memberOwner[contractId]
    )
      return;
    const fieldSetId = text(row.fieldSetId) || "__legacy__";
    const bySet = grouped.get(contractId) ?? new Map();
    const group = bySet.get(fieldSetId) ?? { rows: [], latest: 0, index };
    group.rows.push(row);
    group.index = Math.max(group.index, index);
    const timestamp = Date.parse(text(row.extractAt));
    if (Number.isFinite(timestamp))
      group.latest = Math.max(group.latest, timestamp);
    bySet.set(fieldSetId, group);
    grouped.set(contractId, bySet);
  });
  return [...grouped.values()].flatMap(
    (bySet) =>
      [...bySet.values()].sort(
        (left, right) => right.latest - left.latest || right.index - left.index,
      )[0]?.rows ?? [],
  );
}

/** Pure presentation-model builder, kept exported for parity tests and parent adapters. */
export function buildAudiPickLoanAuditModel(
  input: Omit<AudiPickLegacyLoanAuditProps, "actions" | "busy">,
): AudiPickLoanAuditModel {
  const { project, contracts, results, relationGroups = [] } = input;
  const reportDate = parseDate(
    input.reportDate ||
      project.loanReportDate ||
      project.reportDate ||
      project.date,
  );
  const validations: Validation[] = [];
  if (!reportDate)
    validations.push({
      level: "error",
      code: "report_date_missing",
      message: "请先明确项目报告日，才能判断本年及报表列报。",
    });
  const contractMap = Object.fromEntries(
    contracts.map((contract) => [contract.id, contract]),
  );
  const memberOwner: Record<string, string> = {};
  const memberRole: Record<string, string> = {};
  relationGroups.forEach((group) =>
    group.members?.forEach((member) => {
      memberOwner[member.fileId] = group.anchorFileId;
      memberRole[member.fileId] = member.role || "关联资料";
    }),
  );
  const covenantByOwner: Record<string, AudiPickLoanAuditResult[]> = {};
  results
    .filter((row) => row.ruleId === "loan_covenant")
    .forEach((row) => {
      const id = text(row.contractId);
      const owner = memberOwner[id] || id;
      if (owner) (covenantByOwner[owner] ??= []).push(row);
    });
  const counters: Record<string, number> = {};
  const debts = latestLoanResults(results, memberOwner).map((raw, index) => {
    const contractId = text(raw.contractId);
    counters[contractId] = (counters[contractId] ?? 0) + 1;
    const contract = contractMap[contractId];
    const parsedAmount = parseAmount(
      firstValue(raw, [
        "contract_principal",
        "principal_amount",
        "loan_amount",
        "amount",
      ]),
      raw.currency,
    );
    const currency =
      parsedAmount.currency || normalizeCurrency(raw.currency) || "未明确";
    const signingDate = parseDate(raw.signing_date);
    const startDate = parseDate(raw.loan_start_date);
    const maturityDate = parseDate(raw.maturity_date);
    const debtValidations: Validation[] = [];
    const debtBase = {
      id: text(raw.id) || `${contractId}:debt:${counters[contractId]}`,
      contractId,
      contractName:
        text(contract?.file || contract?.name || raw.source_document) ||
        "未命名借款文件",
      contractNo: text(raw.contract_no) || "未明确",
      borrower: text(raw.borrower) || "未明确",
      lender: text(raw.lender) || "未明确",
      currency,
      principal: parsedAmount.amount,
      principalText:
        text(
          firstValue(raw, [
            "contract_principal",
            "principal_amount",
            "loan_amount",
            "amount",
          ]),
        ) || "未明确",
      signingDate,
      startDate,
      maturityDate,
      newSigned: false,
      newEffective: false,
      computedStatementClassification: "待结合报告日判断",
      validations: debtValidations,
      relatedFiles:
        relationGroups
          .find((group) => group.anchorFileId === contractId)
          ?.members?.map((member) => ({
            fileId: member.fileId,
            role: member.role || "关联资料",
            name:
              text(
                contractMap[member.fileId]?.file ||
                  contractMap[member.fileId]?.name,
              ) || member.fileId,
          })) ?? [],
      raw,
    };
    if (reportDate) {
      const year = reportDate.date.getUTCFullYear();
      debtBase.newSigned = Boolean(
        signingDate &&
        signingDate.date.getUTCFullYear() === year &&
        signingDate.date <= reportDate.date,
      );
      debtBase.newEffective = Boolean(
        startDate &&
        startDate.date.getUTCFullYear() === year &&
        startDate.date <= reportDate.date,
      );
      if (signingDate && signingDate.date > reportDate.date)
        debtValidations.push({
          level: "warning",
          code: "signed_after_report_date",
          message: "合同签订日晚于报告日，应作为期后合同或复核日期准确性。",
          debtId: debtBase.id,
        });
      if (startDate && startDate.date > reportDate.date)
        debtValidations.push({
          level: "warning",
          code: "effective_after_report_date",
          message: "借款起始日晚于报告日，不应计入报告日存续借款。",
          debtId: debtBase.id,
        });
      if (maturityDate) {
        const days = Math.ceil(
          (maturityDate.date.getTime() - reportDate.date.getTime()) /
            86_400_000,
        );
        debtBase.computedStatementClassification =
          days < 0
            ? "报告日前已到期，待核实"
            : days <= 365
              ? "流动负债（辅助测算）"
              : "非流动负债（辅助测算）";
        if (days < 0)
          debtValidations.push({
            level: "warning",
            code: "past_due",
            message: "报告日已超过合同到期日，请核实续期、偿还或逾期状态。",
            debtId: debtBase.id,
          });
      }
    }
    if (currency === "未明确")
      debtValidations.push({
        level: "warning",
        code: "currency_missing",
        message: "借款币种未明确，金额不纳入分币种汇总。",
        debtId: debtBase.id,
      });
    if (parsedAmount.amount === null)
      debtValidations.push({
        level: "warning",
        code: "principal_invalid",
        message: "合同借款金额无法可靠解析。",
        debtId: debtBase.id,
      });
    if (startDate && maturityDate && startDate.date > maturityDate.date)
      debtValidations.push({
        level: "error",
        code: "date_conflict",
        message: "借款起始日晚于到期日。",
        debtId: debtBase.id,
      });
    const repayment = buildRepayment(debtBase, debtValidations);
    const debt: AudiPickLoanAuditDebt = {
      ...debtBase,
      displayName: `${known(debtBase.lender) ? `${debtBase.lender}-` : ""}${known(debtBase.contractNo) ? debtBase.contractNo : debtBase.contractName}`,
      repayment,
      risks: [],
    };
    debt.risks = buildRisks(
      debt,
      covenantByOwner[contractId] ?? [],
      reportDate,
    );
    validations.push(...debtValidations);
    return debt;
  });
  if (!debts.length)
    validations.push({
      level: "warning",
      code: "no_loan_results",
      message: "当前项目没有可用于借款审计的主文件提取结果。",
    });

  const currencyTotals: Record<string, number> = {};
  const currencyCounts: Record<string, number> = {};
  debts.forEach((debt) => {
    if (debt.principal === null || debt.currency === "未明确") return;
    currencyTotals[debt.currency] =
      (currencyTotals[debt.currency] ?? 0) + debt.principal;
    currencyCounts[debt.currency] = (currencyCounts[debt.currency] ?? 0) + 1;
  });
  const currencyStats = Object.keys(currencyTotals)
    .sort()
    .map((currency) => ({
      currency,
      currencyName: CURRENCY_NAMES[currency] ?? currency,
      amount: currencyTotals[currency],
      debtCount: currencyCounts[currency],
      display: formatAmount(currencyTotals[currency], currency),
    }));
  const risks = debts.flatMap((debt) =>
    debt.risks.map((risk) => ({
      ...risk,
      debtId: debt.id,
      contractId: debt.contractId,
      contractNo: debt.contractNo,
    })),
  );
  const repaymentPlan = debts
    .flatMap((debt) => debt.repayment.rows)
    .sort((left, right) => left.date.localeCompare(right.date));
  const futureTwelveMonthTotals: Record<string, number> = {};
  const futureDebtIds = new Set<string>();
  const maturityDebtIds = new Set<string>();
  if (reportDate) {
    const cutoff = addMonths(reportDate.date, 12);
    repaymentPlan.forEach((row) => {
      const due = parseDate(row.date);
      if (!due || due.date <= reportDate.date || due.date > cutoff) return;
      futureDebtIds.add(row.debtId);
      if (row.amount !== null)
        futureTwelveMonthTotals[row.currency] =
          (futureTwelveMonthTotals[row.currency] ?? 0) + row.amount;
    });
    debts.forEach((debt) => {
      if (
        debt.maturityDate &&
        debt.maturityDate.date > reportDate.date &&
        debt.maturityDate.date <= cutoff
      )
        maturityDebtIds.add(debt.id);
    });
  }
  const months = [
    ...new Set(
      repaymentPlan.map((row) => row.date.slice(0, 7)).filter(Boolean),
    ),
  ].sort();
  const rowByDebtId: AudiPickLoanAuditModel["monthlyMatrix"]["rowByDebtId"] =
    {};
  const totalsByCurrency: Record<string, Record<string, number>> = {};
  debts.forEach((debt) => {
    const cells: Record<
      string,
      { amount: number | null; hasUncertain: boolean }
    > = {};
    debt.repayment.rows.forEach((row) => {
      const month = row.date.slice(0, 7);
      const current = cells[month] ?? { amount: 0, hasUncertain: false };
      if (row.amount === null) current.hasUncertain = true;
      else current.amount = (current.amount ?? 0) + row.amount;
      cells[month] = current;
      if (row.amount !== null) {
        (totalsByCurrency[row.currency] ??= {})[month] =
          ((totalsByCurrency[row.currency] ??= {})[month] ?? 0) + row.amount;
      }
    });
    rowByDebtId[debt.id] = { cells };
  });
  const contractIds = new Set(debts.map((debt) => debt.contractId));
  const loanCandidates = contracts.filter(
    (contract) =>
      !memberOwner[contract.id] &&
      (contract.ruleId === "loan_general" ||
        contract.detectedRuleId === "loan_general" ||
        contractIds.has(contract.id)),
  );
  const counts = {
    debtCount: debts.length,
    contractCount: contractIds.size,
    associatedExcluded: Object.keys(memberOwner).length,
    loanCandidateFileCount: loanCandidates.length,
    extractedLoanFileCount: contractIds.size,
    extractionCoverage: loanCandidates.length
      ? Math.round((contractIds.size / loanCandidates.length) * 100)
      : 0,
    newSigned: debts.filter((debt) => debt.newSigned).length,
    newEffective: debts.filter((debt) => debt.newEffective).length,
    riskCount: risks.length,
    pendingRepayment: debts.filter((debt) => debt.repayment.status !== "已解析")
      .length,
    futureTwelveMonthDebtCount: futureDebtIds.size,
    maturityWithinTwelveCount: maturityDebtIds.size,
    floatingRateCount: debts.filter((debt) =>
      debt.risks.some((risk) => risk.type === "floating_rate"),
    ).length,
    securedCount: debts.filter((debt) =>
      debt.risks.some((risk) => risk.type === "security"),
    ).length,
    restrictionCount: debts.filter((debt) =>
      debt.risks.some((risk) =>
        [
          "covenant",
          "financial_covenant",
          "prepayment",
          "acceleration",
        ].includes(risk.type),
      ),
    ).length,
    rateResetSoonCount: debts.filter((debt) =>
      debt.risks.some((risk) => risk.type === "rate_reset_soon"),
    ).length,
  };
  return {
    project,
    reportDate: reportDate?.iso ?? "",
    reportYear: reportDate?.date.getUTCFullYear() ?? null,
    debts,
    counts,
    currencyStats,
    futureTwelveMonthTotals,
    risks,
    repaymentPlan,
    monthlyMatrix: { months, rowByDebtId, totalsByCurrency },
    validations,
  };
}

function Badge({
  children,
  tone = "gray",
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return <span className={`alla-badge is-${tone}`}>{children}</span>;
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="alla-field">
      <span>{label}</span>
      <p>{known(value) ? text(value) : "未明确"}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="alla-card alla-empty">{children}</div>;
}

function Dashboard({ model }: { model: AudiPickLoanAuditModel }) {
  const stats: Array<[string, string | number, string]> = [
    ["独立债项", model.counts.debtCount, "neutral"],
    ["提取覆盖率", `${model.counts.extractionCoverage}%`, "blue"],
    ["本年新签", model.counts.newSigned, "green"],
    ["未来12个月有还款", model.counts.futureTwelveMonthDebtCount, "red"],
    ["未来12个月整笔到期", model.counts.maturityWithinTwelveCount, "red"],
    ["浮动利率", model.counts.floatingRateCount, "blue"],
    ["存在担保", model.counts.securedCount, "blue"],
    ["存在限制条款", model.counts.restrictionCount, "amber"],
    ["利率调整临近", model.counts.rateResetSoonCount, "amber"],
    ["还款待明确", model.counts.pendingRepayment, "red"],
  ];
  return (
    <div className="alla-stack">
      <div className="alla-stat-grid">
        {stats.map(([label, value, tone]) => (
          <div className="alla-card alla-stat" key={label}>
            <span>{label}</span>
            <strong className={`is-${tone}`}>{value}</strong>
          </div>
        ))}
      </div>
      <p className="alla-caption">
        借款主文件提取进度：{model.counts.extractedLoanFileCount}/
        {model.counts.loanCandidateFileCount}
        ；汇总结果仅覆盖已完成“借款·通用条款”提取的主文件。
      </p>
      <div className="alla-dashboard-columns">
        <section className="alla-card alla-section">
          <h2>分币种合同金额</h2>
          <div className="alla-stack is-tight">
            {model.currencyStats.length ? (
              model.currencyStats.map((entry) => (
                <div className="alla-currency" key={entry.currency}>
                  <div>
                    <span>
                      {entry.currencyName} ({entry.currency})
                    </span>
                    <Badge>{entry.debtCount}笔</Badge>
                  </div>
                  <strong>{entry.display}</strong>
                  <p>
                    未来12个月合同约定还本：
                    {model.futureTwelveMonthTotals[entry.currency] === undefined
                      ? "暂无明确金额"
                      : formatAmount(
                          model.futureTwelveMonthTotals[entry.currency],
                          entry.currency,
                        )}
                  </p>
                </div>
              ))
            ) : (
              <p className="alla-muted">暂无可汇总的币种金额。</p>
            )}
          </div>
          <p className="alla-caption">
            不同币种保持独立统计，不进行汇率折算；金额为合同约定金额，不代表报告日实际借款余额。
          </p>
        </section>
        <section className="alla-card alla-section">
          <h2>重点风险</h2>
          <div className="alla-stack">
            {model.risks.length ? (
              model.risks.map((risk, index) => (
                <div
                  className={`alla-risk is-${risk.severity}`}
                  key={`${risk.debtId}-${risk.type}-${index}`}
                >
                  <div>
                    <Badge tone={risk.severity === "high" ? "red" : "amber"}>
                      {risk.label}
                    </Badge>
                    <span>{risk.contractNo}</span>
                  </div>
                  <p>{risk.detail || "请结合合同原文复核"}</p>
                </div>
              ))
            ) : (
              <p className="alla-muted">
                未识别到浮动利率、担保或限制性条款风险。
              </p>
            )}
          </div>
        </section>
      </div>
      <section className="alla-card alla-section">
        <div className="alla-section-head">
          <h2>校验提示</h2>
          <Badge tone="blue">
            {model.counts.associatedExcluded}份关联子文件已排除
          </Badge>
        </div>
        <ul className="alla-validations">
          {model.validations.length ? (
            model.validations.map((item, index) => (
              <li className={`is-${item.level}`} key={`${item.code}-${index}`}>
                <span>•</span>
                {item.message}
              </li>
            ))
          ) : (
            <li className="is-ok">
              <span>•</span>未发现结构化校验异常。
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

function Cards({
  model,
  expanded,
  onToggle,
  onOpenWorkpaper,
}: {
  model: AudiPickLoanAuditModel;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onOpenWorkpaper: (contractId: string) => void;
}) {
  if (!model.debts.length) return <Empty>暂无借款主文件提取结果。</Empty>;
  return (
    <div className="alla-stack is-tight">
      {model.debts.map((debt) => {
        const isExpanded = expanded.has(debt.id);
        const suggestions = ["余额函证"];
        if (
          debt.risks.some(
            (risk) =>
              risk.type === "floating_rate" || risk.type === "rate_reset_soon",
          )
        )
          suggestions.push("利率重新计算");
        if (debt.repayment.rows.length || debt.repayment.pendingReason)
          suggestions.push("还款计划及流动性分类核对");
        if (debt.risks.some((risk) => risk.type === "security"))
          suggestions.push("担保文件及权利状态核对");
        if (
          debt.risks.some((risk) =>
            ["covenant", "financial_covenant", "acceleration"].includes(
              risk.type,
            ),
          )
        )
          suggestions.push("限制性契约合规测试");
        return (
          <article className="alla-card alla-debt" key={debt.id}>
            <div className="alla-debt-summary">
              <div className="alla-debt-title">
                <div>
                  <h3>{debt.displayName}</h3>
                  {debt.newSigned && <Badge tone="green">本年新签</Badge>}
                  {debt.newEffective && <Badge tone="green">本年生效</Badge>}
                  {debt.risks.map((risk, index) => (
                    <Badge
                      tone={risk.severity === "high" ? "red" : "amber"}
                      key={`${risk.type}-${index}`}
                    >
                      {risk.label}
                    </Badge>
                  ))}
                  {!debt.newSigned &&
                    !debt.newEffective &&
                    !debt.risks.length && <Badge>常规复核</Badge>}
                </div>
                <p>来源文件：{debt.contractName}</p>
              </div>
              <div className="alla-debt-amount">
                <strong>{formatAmount(debt.principal, debt.currency)}</strong>
                <span>原文：{debt.principalText}</span>
              </div>
            </div>
            <div className="alla-field-grid is-four">
              <Field label="起始日" value={debt.startDate?.iso} />
              <Field label="到期日" value={debt.maturityDate?.iso} />
              <Field label="还款计划" value={debt.repayment.status} />
              <Field label="风险数" value={`${debt.risks.length}项`} />
            </div>
            <div className="alla-card-actions">
              <button
                type="button"
                onClick={() => onOpenWorkpaper(debt.contractId)}
              >
                跳转底稿
              </button>
              <button type="button" onClick={() => onToggle(debt.id)}>
                {isExpanded ? "收起" : "展开"}
              </button>
            </div>
            {isExpanded && (
              <div className="alla-debt-details">
                <DetailSection title="基本信息" columns="four">
                  <Field label="借款人" value={debt.borrower} />
                  <Field label="贷款人" value={debt.lender} />
                  <Field label="签约日" value={debt.signingDate?.iso} />
                  <Field label="借款起始日" value={debt.startDate?.iso} />
                  <Field label="到期日" value={debt.maturityDate?.iso} />
                  <Field
                    label="报告日列报辅助测算"
                    value={debt.computedStatementClassification}
                  />
                  <Field label="借款用途" value={debt.raw.loan_purpose} />
                  <Field
                    label="关联资料"
                    value={
                      debt.relatedFiles
                        .map((item) => `${item.name}（${item.role}）`)
                        .join("；") || "无"
                    }
                  />
                </DetailSection>
                <DetailSection title="利率信息" columns="four">
                  <Field label="利率类型" value={debt.raw.interest_rate_type} />
                  <Field label="执行利率" value={debt.raw.interest_rate} />
                  <Field
                    label="调整频率"
                    value={debt.raw.interest_rate_adjustment_frequency}
                  />
                  <Field
                    label="下次调整日"
                    value={debt.raw.next_interest_rate_adjustment_date}
                  />
                  <Field
                    label="计息及结息方式"
                    value={debt.raw.interest_method}
                  />
                </DetailSection>
                <DetailSection title="还款安排" columns="two">
                  <Field label="还本方式" value={debt.raw.repayment_method} />
                  <Field
                    label="本金还款计划"
                    value={debt.raw.repayment_schedule}
                  />
                </DetailSection>
                <DetailSection title="担保情况" columns="three">
                  <Field label="借款性质" value={debt.raw.loan_nature} />
                  <Field label="保证人" value={debt.raw.guarantor} />
                  <Field
                    label="抵质押及担保范围"
                    value={debt.raw.security_summary}
                  />
                </DetailSection>
                <DetailSection title="关键条款识别" columns="three">
                  <Field
                    label="提前还款限制"
                    value={debt.raw.prepayment_restriction_status}
                  />
                  <Field
                    label="财务指标约束"
                    value={debt.raw.financial_covenant_status}
                  />
                  <Field
                    label="加速到期/重大违约触发"
                    value={
                      debt.raw.acceleration_or_material_default_trigger_status
                    }
                  />
                  <Field
                    label="提前还款及违约条款"
                    value={debt.raw.prepayment_default}
                  />
                  <Field label="限制性契约" value={debt.raw.covenant_summary} />
                </DetailSection>
                <section className="alla-detail-section is-audit">
                  <h4>审计关注事项</h4>
                  <Field label="AI判断" value={debt.raw.auditor_summary} />
                  <div className="alla-suggestions">
                    {suggestions.map((item) => (
                      <span key={item}>□ {item}</span>
                    ))}
                  </div>
                </section>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function DetailSection({
  title,
  columns,
  children,
}: {
  title: string;
  columns: "two" | "three" | "four";
  children: React.ReactNode;
}) {
  return (
    <section className="alla-detail-section">
      <h4>{title}</h4>
      <div className={`alla-field-grid is-${columns}`}>{children}</div>
    </section>
  );
}

function Repayment({ model }: { model: AudiPickLoanAuditModel }) {
  const currencies = [...new Set(model.debts.map((debt) => debt.currency))];
  const pending = model.debts.filter((debt) => debt.repayment.pendingReason);
  return (
    <div className="alla-stack is-tight">
      {model.repaymentPlan.length ? (
        <details className="alla-card alla-plan" open>
          <summary>查看逐笔还款明细（{model.repaymentPlan.length}笔）</summary>
          <div className="alla-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>合同编号</th>
                  <th>还款日</th>
                  <th>币种</th>
                  <th className="is-number">本金金额</th>
                  <th>解析口径</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {model.repaymentPlan.map((row, index) => (
                  <tr key={`${row.debtId}-${row.date}-${index}`}>
                    <td>{row.contractNo}</td>
                    <td>{row.date}</td>
                    <td>{row.currency || "未明确"}</td>
                    <td className="is-number">
                      {row.amount === null
                        ? row.amountText
                        : formatAmount(row.amount, row.currency)}
                    </td>
                    <td>{row.source}</td>
                    <td>
                      <Badge tone={row.amount === null ? "amber" : "green"}>
                        {row.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : (
        <Empty>还款日期均待明确，未生成计划行。</Empty>
      )}
      {model.monthlyMatrix.months.length > 0 &&
        currencies.map((currency) => {
          const debts = model.debts.filter(
            (debt) => debt.currency === currency,
          );
          if (!debts.length) return null;
          return (
            <section className="alla-card alla-matrix" key={currency}>
              <div className="alla-section-head">
                <h2>按月还本矩阵 · {CURRENCY_NAMES[currency] ?? currency}</h2>
                <Badge tone="blue">{debts.length}笔债项</Badge>
              </div>
              <div className="alla-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>还款月份</th>
                      {debts.map((debt) => (
                        <th
                          className="is-number"
                          title={debt.contractName}
                          key={debt.id}
                        >
                          {debt.displayName}
                        </th>
                      ))}
                      <th className="is-number">当月合计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.monthlyMatrix.months.map((month) => (
                      <tr key={month}>
                        <td>{month.replace("-", "年")}月</td>
                        {debts.map((debt) => {
                          const cell =
                            model.monthlyMatrix.rowByDebtId[debt.id]?.cells[
                              month
                            ];
                          return (
                            <td
                              className={`is-number${cell?.hasUncertain ? " is-uncertain" : ""}`}
                              key={debt.id}
                            >
                              {!cell
                                ? "—"
                                : cell.amount === null
                                  ? "待明确"
                                  : `${cell.amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${cell.hasUncertain ? " + 待明确" : ""}`}
                            </td>
                          );
                        })}
                        <td className="is-number is-total">
                          {model.monthlyMatrix.totalsByCurrency[currency]?.[
                            month
                          ]?.toLocaleString("zh-CN", {
                            maximumFractionDigits: 2,
                          }) ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="alla-caption">
                行按月份列示，列为独立债项；不同币种分表。“每季度末”只落入3、6、9、12月，绝不平均分摊到季度内各月。
              </p>
            </section>
          );
        })}
      {pending.length > 0 && (
        <section className="alla-card alla-section">
          <h2>待明确事项</h2>
          <ul className="alla-pending">
            {pending.map((debt) => (
              <li key={debt.id}>
                {debt.contractNo}：{debt.repayment.pendingReason}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function AudiPickLegacyLoanAudit({
  project,
  contracts,
  results,
  relationGroups = [],
  reportDate,
  busy = false,
  actions,
}: AudiPickLegacyLoanAuditProps) {
  const [tab, setTab] = useState<LoanAuditTab>("dashboard");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const effectiveReportDate =
    reportDate ??
    project.loanReportDate ??
    project.reportDate ??
    project.date ??
    "";
  const [dateDraft, setDateDraft] = useState(effectiveReportDate);
  useEffect(() => setDateDraft(effectiveReportDate), [effectiveReportDate]);
  const model = useMemo(
    () =>
      buildAudiPickLoanAuditModel({
        project,
        contracts,
        results,
        relationGroups,
        reportDate: dateDraft,
      }),
    [project, contracts, results, relationGroups, dateDraft],
  );
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="alla-page">
      <header className="alla-header">
        <div>
          <button className="alla-back" type="button" onClick={actions.onBack}>
            返回项目
          </button>
          <h1>借款审计中心</h1>
          <p>
            {project.name || "当前项目"} ·
            主文件形成债项，关联子文件仅作支持资料
          </p>
        </div>
        <div className="alla-header-actions">
          <label>
            项目报告日
            <input
              type="date"
              value={dateDraft}
              onChange={(event) => {
                const value = event.target.value;
                setDateDraft(value);
                void actions.onReportDateChange(value);
              }}
            />
          </label>
          <button
            className="alla-primary"
            type="button"
            disabled={busy}
            onClick={() => void actions.onExport()}
          >
            {busy ? "处理中…" : "导出借款审计Excel"}
          </button>
        </div>
      </header>
      <nav className="alla-tabs" aria-label="借款审计视图">
        {(
          [
            ["dashboard", "驾驶舱"],
            ["cards", `合同卡片 · ${model.counts.debtCount}`],
            ["repayment", `还款计划 · ${model.repaymentPlan.length}`],
          ] as Array<[LoanAuditTab, string]>
        ).map(([id, label]) => (
          <button
            type="button"
            className={tab === id ? "is-active" : ""}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
            key={id}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "dashboard" ? (
        <Dashboard model={model} />
      ) : tab === "cards" ? (
        <Cards
          model={model}
          expanded={expanded}
          onToggle={toggle}
          onOpenWorkpaper={(id) => void actions.onOpenWorkpaper(id)}
        />
      ) : (
        <Repayment model={model} />
      )}
    </div>
  );
}

export default AudiPickLegacyLoanAudit;
