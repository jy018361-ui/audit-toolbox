/** SOP-based work suggestions, not risk scores or conclusions of compliance.
 * Derived for old and new results alike; only a user's override is persisted.
 * Use the excerpt, never an AI-written summary, to choose the work to suggest.
 */
export const PROCEDURE_LEVELS = {
  1: "一级：建议单独核查",
  2: "二级：结合已有程序核查",
  3: "三级：知悉并评估，通常汇总记录",
} as const;
export type ProcedureLevel = keyof typeof PROCEDURE_LEVELS;
export type ProcedureFilter = "all" | "1" | "2" | "3";
export const PROCEDURE_OVERRIDE_KEY = "procedure_level_override";
export const PROCEDURE_NOTICE =
  "等级为程序安排建议，不代表违约风险或合规结论；项目组需结合风险评估调整。";

type Row = Record<string, unknown>;
export type CovenantProcedure = {
  level: ProcedureLevel;
  suggestedLevel: ProcedureLevel;
  label: string;
  method: string;
  evidence: string;
  reasons: string[];
  needsReview: boolean;
  overridden: boolean;
};
type Suggestion = { level: ProcedureLevel; method: string; evidence: string };
const txt = (value: unknown): string =>
  typeof value === "string" ? value : "";
export function procedureOverride(value: unknown): ProcedureLevel | undefined {
  return value === 1 || value === "1"
    ? 1
    : value === 2 || value === "2"
      ? 2
      : value === 3 || value === "3"
        ? 3
        : undefined;
}

export function covenantProcedure(row: Row): CovenantProcedure {
  const excerpt = txt(row.excerpt).trim();
  const text = excerpt.replace(/\s/g, "");
  const suggestions: Suggestion[] = [];
  const reasons: string[] = [];
  const add = (level: ProcedureLevel, method: string, evidence: string) =>
    suggestions.push({ level, method, evidence });
  // Classify obligation-sized sentences so a reporting deadline in one sentence
  // cannot suppress an independent financial covenant elsewhere in the excerpt.
  for (const part of text.split(/[。；;\n]/).filter(Boolean)) {
    const notice = /通知|通报|报告|报送|报备|披露|提交.*报表|提供.*报表/.test(
      part,
    );
    const consent =
      /(?:事先|事前|书面).{0,12}(?:同意|批准)|(?:征得|取得).{0,15}(?:同意|批准)|未经.{0,15}(?:同意|批准)/.test(
        part,
      );
    const financial =
      /资产负债率|流动比率|速动比率|或有负债率|偿债覆盖率|利息保障倍数|净资产|净利润|EBITDA|现金流量|资金余额|账户余额|资本金|出资|(?:融资|投资|借款|负债)(?:的|累计)?(?:限额|金额|余额|总额|规模)|(?:新增|增加).{0,5}(?:融资|借款|负债)|对外投资/i.test(
        part,
      );
    const restriction =
      /不得|不应|不低于|不高于|不超过|至少|不小于|不大于|维持|保持|低于|高于|超过|覆盖|上限|下限|[<>≤≥]/.test(
        part,
      );
    const guarantee =
      /对外(?:提供)?担保|为.{0,12}(?:第三方|他人|其他).{0,8}担保/.test(part);
    const disposal =
      /合并|分立|控制权|股权转让|对外投资|关联交易|新增.{0,4}(?:融资|负债)|增加债务融资|处分.{0,5}资产|处置.{0,5}资产|转让.{0,5}资产|抵押给第三方/.test(
        part,
      );
    if (consent && (guarantee || disposal)) {
      add(
        1,
        "核对实际发生的担保、融资、投资或重大事项，检查合同要求的事先书面同意及例外条件。",
        "担保／融资台账、重大事项及治理层会议记录、银行书面同意文件",
      );
    } else if (
      notice &&
      !consent &&
      !/(?:资产负债率|流动比率|速动比率|净资产|净利润|EBITDA|账户余额)(?:应当|必须|应|须|需)?(?:保持|维持|不得|不应|不低于|不高于|不超过)|(?:保持|维持)(?:资产负债率|流动比率|速动比率|净资产|净利润|EBITDA|账户余额)/i.test(
        part,
      )
    ) {
      add(
        3,
        "汇总报告／通知事项、门槛及期限；结合历史履行情况和风险评估决定是否检查报送记录。",
        "报送清单、银行收件记录、相关事项底稿（需追加程序时取得）",
      );
    } else if (/财务指标.{0,8}(?:约束|要求)/.test(part) && !financial) {
      add(
        1,
        "回到合同所引用的财务指标条款，补齐具体指标、口径、阈值及应遵循日期，再决定计算程序。",
        "合同原件及所引用条款、审定财务数据、契约计算表",
      );
      reasons.push(
        "当前原文仅引用财务指标要求，未列明具体指标，请补齐关联条款。",
      );
    } else if (/资本金|股东出资|出资额/.test(part)) {
      add(
        1,
        "核对资本金约定金额、来源和到位期限；将银行流水、出资凭证及账务记录逐笔勾稽，并排查借款或明股实债虚假充当资本金。",
        "资本金账户流水、股东出资凭证、验资或记账资料、资金来源说明及相关协议",
      );
    } else if (guarantee) {
      add(
        1,
        "核对对外担保范围及金额；有比例限额时按合同口径使用审定数据计算，并核查审批要求。征信报告须结合其他资料判断完整性。",
        "担保台账、征信报告、银行函证、担保协议、审定净资产及批准文件",
      );
    } else if (
      (financial && restriction) ||
      (/(?:分红|股息|利润分配)/.test(part) &&
        /不得|禁止|条件|前不|未经/.test(part) &&
        !/(?:不得|禁止)用于.{0,10}(?:分红|股息|利润分配)/.test(part))
    ) {
      add(
        1,
        "按合同定义、阈值和应遵循日期逐项重新计算或核对；财务数据使用审定数，分红和账户余额另核对实际记录。",
        "审定财务报表／A3、契约计算表、分红决议、银行对账单及相关明细",
      );
    } else if (
      /担保人|保证人|担保物|抵押|质押|追加担保|补充.{0,6}担保|担保.{0,6}(?:失效|无效|贬值)/.test(
        part,
      )
    ) {
      add(
        2,
        "关联既有抵质押、担保测试，核对担保有效性及价值变化；有失效、贬值或银行追加要求时单独跟进。",
        "抵质押担保底稿、函证、登记证明、估值资料及银行通知",
      );
    } else if (/保险|投保|保单|保险期限|保费/.test(part)) {
      add(
        2,
        "核对投保范围、被保险资产、保险期限、保费支付及向贷款人报送保单的期限；检查是否存在中断或不足额投保。",
        "保险合同、保单及批单、保费付款记录、资产清单、贷款人收件记录",
      );
    } else if (
      disposal ||
      /实控人|实际控制人|控股股东|失信|限高|诉讼|仲裁|查封|冻结|扣押|强制执行|破产|清算|重整|解散|停产|停业|主体资格|有效存续|重大违法/.test(
        part,
      )
    ) {
      add(
        2,
        "结合主体、控制权、法律事项和会议记录检查；存在禁止或事先同意等特殊要求时另行核查。",
        "企业及相关主体公开信息、法律事项底稿、治理层会议记录、股权资料",
      );
    } else if (
      /专款专用|挪用|挪作他用|贷款用途|借款用途|资金.{0,6}(?:用途|支付|归集)|收入.{0,6}归集|监管账户|结算账户|偿债账户|受托支付|回笼账户|用于.{0,20}(?:项目|投资|建设|分红|股息|利润分配)/.test(
        part,
      )
    ) {
      if (
        /受托支付|银行.{0,8}审批|贷款人.{0,8}审批/.test(part) &&
        /\d|审批|批准/.test(part)
      ) {
        add(
          2,
          "核对受托支付门槛及银行审批要求，关联已有资金支付程序；发现用途异常时追加检查。",
          "付款审批、采购合同、银行流水、资金测试底稿",
        );
      } else {
        add(
          3,
          "汇总约定用途、禁止用途及资金控制要求；结合资金程序与项目风险评估决定是否追加检查。",
          "借款用途说明、资金相关底稿；必要时取得付款审批及银行沟通记录",
        );
      }
    } else if (
      /提前到期|加速到期|提前.{0,6}(?:收回|偿还|清偿)|交叉违约|违约金额|偿还.{0,8}本息|还本付息|罚息|逾期/.test(
        part,
      )
    ) {
      add(
        2,
        "将违约后果关联至具体触发条件，结合函证、还本付息及利息测试核对；交叉违约或异常事项单独跟进。",
        "借款及利息底稿、银行函证、还款记录、关联债务协议及银行通知",
      );
    }
  }
  const unique = suggestions.filter(
    (item, index, all) =>
      all.findIndex((other) => other.method === item.method) === index,
  );
  if (!excerpt) reasons.push("缺少原文摘录，无法可靠分级。");
  if (!unique.length)
    reasons.push("当前原文未匹配明确程序，请项目组判断适用工作。");
  if (
    /【\s*】|\[\s*\]|（\s*）|\(\s*\)|(?:不低于|不高于|不超过|超过)[%％]|待填|待补/.test(
      text,
    )
  )
    reasons.push("原文含空白条件或阈值，请核对合同原件。");
  if (/�|……|\.\.\.|OCR不清|无法识别/.test(text))
    reasons.push("原文可能截断或识别不清，请核对完整条款。");
  if (!txt(row.pages).trim() || /未知|不明/.test(txt(row.pages)))
    reasons.push("缺少可靠页码，请核对证据位置。");
  if (
    /事件发生之日起|发生后|事后/.test(text) &&
    /事前|事先/.test(txt(row.title)) &&
    !/事前|事先/.test(text)
  )
    reasons.push("摘要写事前要求，原文为事后要求，请核对时点。");
  if (
    /(?:后果|关联条款|阈值).{0,12}(?:未明确|未找到|不清|缺失)|未明确.{0,8}(?:后果|阈值)/.test(
      `${excerpt} ${txt(row.auditor_summary)}`,
    )
  )
    reasons.push("关联后果或条件尚未明确，需要补证。");
  if (unique.some((s) => s.level === 1) && unique.some((s) => s.level === 3))
    reasons.push(
      "该行同时包含独立核查和通知／用途事项，按较高工作要求提示，请分项核对。",
    );
  const fallback: Suggestion = {
    level: 2,
    method: "核对完整合同及关联条款，确定需要单独核查还是可由已有程序覆盖。",
    evidence: "合同原件、关联条款及项目组风险评估",
  };
  const applicable = unique.length ? unique : [fallback];
  const suggestedLevel = Math.min(
    ...applicable.map((s) => s.level),
  ) as ProcedureLevel;
  const override = procedureOverride(row[PROCEDURE_OVERRIDE_KEY]);
  const level = override ?? suggestedLevel;
  return {
    level,
    suggestedLevel,
    label: PROCEDURE_LEVELS[level],
    method: applicable.map((s) => s.method).join("\n"),
    evidence: [...new Set(applicable.map((s) => s.evidence))].join("；"),
    reasons,
    needsReview: reasons.length > 0,
    overridden: override !== undefined,
  };
}

export function compareCovenantRows(left: Row, right: Row): number {
  const a = covenantProcedure(left),
    b = covenantProcedure(right);
  return Number(b.needsReview) - Number(a.needsReview) || a.level - b.level;
}

export function filterCovenantRows<T extends Row>(
  rows: T[],
  level: ProcedureFilter,
  reviewOnly: boolean,
): T[] {
  return rows
    .filter((row) => {
      const advice = covenantProcedure(row);
      return (
        (level === "all" || String(advice.level) === level) &&
        (!reviewOnly || advice.needsReview)
      );
    })
    .sort(compareCovenantRows);
}

/** The only eight fields exposed in covenant workpapers and exports. */
export const COVENANT_LABELS: Record<string, string> = {
  covenant_category: "分类",
  procedure_level: "建议等级",
  title: "条款及限制内容",
  trigger_standard: "触发标准",
  excerpt: "合同原文摘录",
  source_reference: "原文引用出处",
  consequence_display: "违反约定的后果",
  audit_procedure: "建议审计程序",
};

const compactText = (value: unknown): string => txt(value).replace(/\s+/g, " ").trim();

export function covenantConsequence(row: Row): string {
  if (row._financial_metrics_only === true) return "不适用：仅摘录财务指标";
  const text = `${compactText(row.breach_consequence)} ${compactText(row.excerpt)}`;
  const rawCodes = row._covenant_consequence_codes ?? row.consequence_codes;
  const codeText = Array.isArray(rawCodes)
    ? rawCodes.map(compactText).join(" ")
    : compactText(rawCodes);
  const rightType = compactText(
    row._covenant_trigger_mode
      ?? row.consequence_right_type
      ?? row.right_type,
  );
  const labels: string[] = [];
  const add = (label: string, matched: boolean) => {
    if (matched && !labels.includes(label)) labels.push(label);
  };
  const lenderChoice = /有权|可以|可(?:以)?(?:要求|宣布|决定)/.test(text) || /lender|option|right/i.test(rightType);
  const automaticMode = /automatic|mixed/i.test(rightType);
  const lenderMode = /lender|option|mixed/i.test(rightType);
  add(
    "立即到期（自动触发）",
    (/immediate[_ -]?(?:maturity|due)/i.test(codeText) && automaticMode) ||
      /automatic[_ -]?(?:maturity|acceleration|due)/i.test(codeText) ||
      (!lenderChoice && /自动.{0,8}到期|立即到期|立即应付|视为.{0,6}到期/.test(text)),
  );
  add(
    "加速到期（贷款人有权宣布）",
    ((/acceleration|immediate[_ -]?due/i.test(codeText) && lenderMode) ||
      /lender[_ -]?(?:option|declaration)/i.test(codeText)) ||
      /加速到期|(?:有权|可以|可).{0,12}(?:要求|宣布|决定).{0,12}(?:立即|提前|全部债务)?.{0,6}(?:到期|应付)|可宣布.{0,10}到期/.test(text),
  );
  add(
    "提前还款（贷款人有权要求）",
    /early[_ -]?repayment/i.test(codeText) ||
      /提前.{0,8}(?:还款|偿还|清偿|收回)|提前要求.{0,8}(?:还款|偿还|清偿)/.test(text),
  );
  add("罚息／违约利率", /penalty[_ -]?(?:interest|rate)/i.test(codeText) || /罚息|违约利率|加收.{0,6}利息|上浮.{0,6}(?:利率|利息)/.test(text));
  add("违约金／赔偿", /liquidated[_ -]?damages|damages|compensation|(?:^|\s)penalty(?:\s|$)/i.test(codeText) || /违约金|赔偿|补偿损失|承担损失/.test(text));
  add("停止提款／取消额度", /stop[_ -]?(?:drawdown|funding)|cancel[_ -]?(?:facility|limit)/i.test(codeText) || /停止.{0,6}(?:放款|发放|提款)|暂停.{0,6}(?:放款|发放|提款)|取消.{0,6}(?:授信|额度)/.test(text));
  add("执行担保／追加担保", /enforce[_ -]?(?:security|guarantee)|additional[_ -]?(?:security|guarantee)/i.test(codeText) || /执行.{0,4}(?:担保|抵押|质押)|追加担保|补充担保/.test(text));
  add("解除／终止", /termination|rescission/i.test(codeText) || /解除.{0,4}(?:合同|协议)|终止.{0,4}(?:合同|协议)/.test(text));
  return labels.length ? labels.join("、") : "后果待核实";
}

export function covenantSummary(row: Row): string {
  const generic = /^(?:其他可执行限制|具体约定待核实|其他(?:限制|事项)?|限制性契约|违约事项|相关约定)$/;
  const rawTitle = compactText(row.title);
  const evidence = Array.isArray(row._covenant_evidence)
    ? row._covenant_evidence as Array<Record<string, unknown>>
    : [];
  const obligation = evidence
    .filter((item) => compactText(item.role) === "obligation")
    .map((item) => compactText(item.quote))
    .find(Boolean);
  const excerpt = compactText(row.excerpt);
  const summary = compactText(row.auditor_summary);
  const fallback = obligation || (excerpt.length > 80 ? `${excerpt.slice(0, 80)}…` : excerpt);
  const title = rawTitle
    ? (generic.test(rawTitle) ? fallback : rawTitle)
    : summary || fallback;
  const party = compactText(row._covenant_obligated_party ?? row.obligated_party);
  if (title) return party && !title.includes(party) ? `${party}：${title}` : title;
  return "具体约定待核实";
}

type CovenantEvidenceView = {
  document_id?: unknown;
  document_name?: unknown;
  quote?: unknown;
  role?: unknown;
  clause_ref?: unknown;
  pages?: unknown;
};

const COVENANT_SOURCE_ROLE_LABELS: Record<string, string> = {
  obligation: "具体约定",
  condition: "条件／例外",
  default: "违约关联",
  consequence: "法律后果",
};

function covenantEvidence(row: Row): CovenantEvidenceView[] {
  return Array.isArray(row._covenant_evidence)
    ? row._covenant_evidence.filter((item): item is CovenantEvidenceView => !!item && typeof item === "object")
    : [];
}

/** Only source wording needed to understand the obligation and its conditions belongs in the excerpt column. */
export function covenantOriginalExcerpt(row: Row): string {
  const excerpts = covenantEvidence(row)
    .filter((item) => ["obligation", "condition"].includes(compactText(item.role)))
    .map((item) => txt(item.quote).trim())
    .filter(Boolean);
  if (excerpts.length) return [...new Set(excerpts)].join("\n\n");
  // Historical rows may not carry structured evidence. Remove legacy location labels,
  // but preserve their original wording instead of fabricating a new quotation.
  return txt(row.excerpt)
    .split(/\n{2,}/)
    .map((part) => part.replace(/^【[^\n]+】\s*\n?/, "").trim())
    .filter(Boolean)
    .filter((part, index, all) => all.indexOf(part) === index)
    .join("\n\n");
}

export function covenantTriggerStandard(row: Row): string {
  const explicit = compactText(row.trigger_standard);
  if (explicit) return explicit;
  const evidenceText = covenantEvidence(row)
    .filter((item) => ["obligation", "condition"].includes(compactText(item.role)))
    .map((item) => compactText(item.quote))
    .filter(Boolean)
    .join("；");
  if (evidenceText) return evidenceText;
  return covenantSummary(row);
}

export function covenantSourceReference(row: Row, fileName = ""): string {
  const defaultDocument = compactText(row.source_documents) || fileName;
  const references = covenantEvidence(row).map((item) => {
    const role = compactText(item.role);
    const label = COVENANT_SOURCE_ROLE_LABELS[role] || "关联依据";
    const document = compactText(item.document_name) || defaultDocument;
    const parts = [
      document ? `文件：${document}` : "",
      compactText(item.pages) ? `页码：${compactText(item.pages)}` : "",
      `条款：${compactText(item.clause_ref) || "位置待核对"}`,
    ].filter(Boolean);
    return parts.length ? `${label}：${parts.join("；")}` : "";
  }).filter(Boolean);
  if (references.length) return [...new Set(references)].join("\n");
  const fallback = [
    defaultDocument,
    compactText(row.pages),
    compactText(row.clause_ref),
  ].filter(Boolean).join("｜");
  return fallback ? `具体约定：${[defaultDocument ? `文件：${defaultDocument}` : "", compactText(row.pages) ? `页码：${compactText(row.pages)}` : "", compactText(row.clause_ref) ? `条款：${compactText(row.clause_ref)}` : ""].filter(Boolean).join("；")}` : "出处待核对";
}

/** Derived display values; derived fields are never persisted to the source row. */
export function covenantUserView(row: Row): Row {
  const advice = covenantProcedure(row);
  return {
    ...row,
    covenant_category: formalCovenantCategory(row) || "待分类",
    procedure_level: advice.label,
    title: covenantSummary(row),
    trigger_standard: covenantTriggerStandard(row),
    excerpt: covenantOriginalExcerpt(row),
    source_reference: covenantSourceReference(row),
    consequence_display: covenantConsequence(row),
    audit_procedure: advice.method,
  };
}
export const COVENANT_SCOPES = {
  repayment: "还款影响",
  supplementary: "补充后果（罚息／赔偿）",
  unresolved: "关联待核实／历史结果",
  supporting: "关联依据",
  excluded: "未纳入事项",
} as const;
export const COVENANT_WORKPAPER_SCOPES = {
  repayment: COVENANT_SCOPES.repayment,
  supplementary: COVENANT_SCOPES.supplementary,
} as const;
export const FORMAL_COVENANT_CATEGORIES = new Set([
  "财务指标及资本金",
  "资金用途及账户管理",
  "担保及融资限制",
  "重大资产处置及公司行为",
  "还本付息及交叉违约",
  "诉讼、司法及持续经营事项",
  "报送、通知、保险及增信义务",
]);
export function formalCovenantCategory(row: Row): string {
  const explicit = compactText(row.covenant_category);
  if (row._financial_metrics_only === true && /^(?:C0[1-5](?:\s|$)|财务报表指标|盈利(?:及|与)现金流趋势|财务行为(?:和|与)交易限制|资金账户与资本条件|金额型风险事件)/.test(explicit)) return explicit;
  if (FORMAL_COVENANT_CATEGORIES.has(explicit)) return explicit;
  const evidence = Array.isArray(row._covenant_evidence)
    ? row._covenant_evidence as Array<Record<string, unknown>>
    : [];
  const obligationText = evidence
    .filter((item) => compactText(item.role) === "obligation")
    .map((item) => compactText(item.quote))
    .join(" ");
  const text = [
    explicit,
    compactText(row.contract_classification),
    compactText(row.title),
    obligationText || compactText(row.excerpt),
  ].join(" ");
  if (/交叉违约|逾期|未按期(?:支付|偿还|付息|还本)|欠息|其他债务|债务到期|还本付息/.test(text)) return "还本付息及交叉违约";
  if (/诉讼|仲裁|查封|冻结|扣押|强制执行|征收|没收|破产|清算|重整|解散|停产|停业|许可证.{0,6}(?:注销|吊销)/.test(text)) return "诉讼、司法及持续经营事项";
  if (/贷款用途|借款用途|专款专用|挪用|转贷|套利|受托支付|自主支付|监管账户|收入归集|资金归集|结算账户|偿债资金|账户余额/.test(text)) return "资金用途及账户管理";
  if (/报送|报告|通知|披露|财务报表|项目报告|保险|投保|保单|追加担保|补充担保|增信/.test(text)) return "报送、通知、保险及增信义务";
  if (/担保|保证|抵押|质押|融资|举债|借款限额/.test(text)) return "担保及融资限制";
  if (/资产处置|出售资产|转让资产|租赁资产|委托经营|重大投资|对外投资|关联交易|合并|分立|联营|合资|重组|股权|控制权|注册资本|分红|利润分配/.test(text)) return "重大资产处置及公司行为";
  if (/财务|资产负债率|流动比率|净资产|净利润|连续.{0,4}亏损|资本金|出资|EBITDA|利息保障|偿债覆盖|指标/.test(text)) return "财务指标及资本金";
  return "";
}
export function isFormalCovenantRow(row: Row): boolean {
  if (row._covenant_pending_case === true) return false;
  if (row._financial_metrics_only === true) return covenantScope(row) === "repayment" && !!covenantOriginalExcerpt(row);
  return (
    (covenantScope(row) === "repayment" || covenantScope(row) === "supplementary") &&
    !!formalCovenantCategory(row) &&
    covenantConsequence(row) !== "后果待核实"
  );
}
export type CovenantScope = keyof typeof COVENANT_SCOPES;
export type CovenantScopeFilter = CovenantScope | "all";
export function covenantScope(row: Row): CovenantScope {
  const scope = txt(row.covenant_scope);
  return Object.prototype.hasOwnProperty.call(COVENANT_SCOPES, scope)
    ? scope as CovenantScope : "unresolved";
}
export function filterCovenantScope<T extends Row>(rows: T[], scope: CovenantScopeFilter): T[] {
  return rows.filter((row) => scope === "all" || covenantScope(row) === scope);
}
export const COVENANT_INTERNAL_FIELDS = new Set([
  "证据待复核", "待复核原因", "建议核查方式", "所需资料／已有底稿", "所需资料/已有底稿", "分级来源", "原建议等级", "分级说明",
  "covenant_scope", "source_documents", "source_document_id", "_covenant_evidence", "_covenant_pipeline_version",
]);
/** Same eight-column projection for current, filtered, document-wide and project exports. */
export function covenantExportRows(
  rows: Row[],
  fileName: (row: Row) => string,
): Row[] {
  return [...rows]
    .filter(isFormalCovenantRow)
    .sort(
      (a, b) =>
        fileName(a).localeCompare(fileName(b), "zh-CN") ||
        compareCovenantRows(a, b),
    )
    .map((row) => {
      const advice = covenantProcedure(row);
      if (row._financial_metrics_only === true) return {
        财务契约类型: formalCovenantCategory(row) || "待分类",
        限制或触发标准: covenantTriggerStandard(row),
        合同原文摘录: covenantOriginalExcerpt(row),
        原文引用出处: covenantSourceReference(row, fileName(row)),
      };
      return {
        分类: formalCovenantCategory(row) || "待分类",
        建议等级: advice.label,
        条款及限制内容: covenantSummary(row),
        触发标准: covenantTriggerStandard(row),
        合同原文摘录: covenantOriginalExcerpt(row),
        原文引用出处: covenantSourceReference(row, fileName(row)),
        违反约定的后果: covenantConsequence(row),
        建议审计程序: advice.method,
      };
    });
}


export type CovenantDiagnostic = {
  id: string;
  clause: string;
  reason: string;
  evidence: string;
  rejected: string;
  count: number;
};

/** Collapse repeated chunk/retry failures without hiding how many raw records occurred. */
export function covenantDiagnosticGroups(rows: Row[]): CovenantDiagnostic[] {
  const groups = new Map<string, CovenantDiagnostic & { evidenceParts: string[]; rejectedParts: unknown[] }>();
  for (const row of rows) {
    if (covenantScope(row) !== "unresolved") continue;
    const clause = (txt(row.clause_ref) || txt(row.title).replace(/：关联未完成$/, "") || "来源条款").trim();
    const reason = (txt(row._covenant_review_reason) || txt(row.breach_consequence) || "证据链未完成").trim();
    const key = `${txt(row.source_document_id)}\u0000${clause}\u0000${reason}`;
    const count = Number(row._covenant_failure_count) || 1;
    const evidence = txt(row.excerpt).trim();
    const rejected = Array.isArray(row._covenant_rejected_evidence) ? row._covenant_rejected_evidence : [];
    const previous = groups.get(key);
    if (!previous) {
      groups.set(key, {
        id: txt(row.id) || key,
        clause,
        reason,
        count,
        evidence: "",
        rejected: "",
        evidenceParts: evidence ? [evidence] : [],
        rejectedParts: [...rejected],
      });
      continue;
    }
    previous.count += count;
    if (evidence && !previous.evidenceParts.includes(evidence)) previous.evidenceParts.push(evidence);
    for (const entry of rejected) if (!previous.rejectedParts.some((value) => JSON.stringify(value) === JSON.stringify(entry))) previous.rejectedParts.push(entry);
  }
  return [...groups.values()].map(({ evidenceParts, rejectedParts, ...group }) => ({
    ...group,
    evidence: evidenceParts.join("\n\n"),
    rejected: rejectedParts.length ? JSON.stringify(rejectedParts, null, 2) : "",
  }));
}

export const FINANCIAL_METRIC_LABELS = { covenant_category: "财务契约类型", trigger_standard: "限制或触发标准", excerpt: "合同原文摘录", source_reference: "原文引用出处" };
