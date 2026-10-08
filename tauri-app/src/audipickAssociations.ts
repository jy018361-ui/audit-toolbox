export type AudiPickAssociationMember = {
  fileId: string;
  role: string;
  source?: "ai" | "ai-confirmed" | "manual" | string;
  confidence?: "high" | "medium" | "low" | string;
  reason?: string;
  [key: string]: unknown;
};

export type AudiPickAssociationGroup = {
  id: string;
  anchorFileId: string;
  members: AudiPickAssociationMember[];
};

export type AudiPickAssociationDocument = {
  id: string;
  name: string;
  text?: string;
  detectedLabel?: string;
  detectedRuleId?: string;
  ruleId?: string;
  ruleName?: string;
};

export type AudiPickAssociationSuggestion = {
  fileId: string;
  anchorFileId: string;
  anchorName: string;
  role: string;
  score: number;
  confidence: "high" | "medium";
  reason: string;
};

type AssociationSignals = {
  projectCodes: string[];
  documentNumbers: string[];
  entities: string[];
};

function uniqueAssociationValues(values: string[]) {
  const seen = new Set<string>();
  return values.flatMap((raw) => {
    const value = String(raw || "")
      .toUpperCase()
      .replace(/[\s_—–－]/g, "-")
      .replace(/-+/g, "-");
    if (!value || seen.has(value)) return [];
    seen.add(value);
    return [value];
  });
}

export function associationRoleForDocument(document?: AudiPickAssociationDocument | null) {
  if (!document) return null;
  const label = [document.name, document.detectedLabel].filter(Boolean).join(" ");
  const heading = String(document.text ?? "").slice(0, 500);
  const matches = (labelPattern: RegExp, headingPattern?: RegExp) =>
    labelPattern.test(label) || Boolean(headingPattern?.test(heading));

  if (matches(/补充协议|变更协议|合同变更|amendment|addendum/i, /(?:^|\n)\s*(?:补充|变更)协议/))
    return "补充协议/变更";
  if (matches(/验收单|验收报告|交付单|签收单|验收证明|acceptance|delivery\s*(note|report)/i, /(?:^|\n)\s*(?:项目|产品|服务|交付)?\s*(?:验收单|验收报告|交付单|签收单)/))
    return "验收/交付资料";
  if (matches(/采购订单|订单|purchase\s*order|\bPO\b/i, /(?:^|\n)\s*(?:采购)?订单/))
    return "订单/采购订单";
  if (matches(/技术附件|规格书|技术协议|需求书|technical\s*(appendix|specification)/i, /(?:^|\n)\s*(?:技术附件|技术规格书|项目需求书)/))
    return "技术附件";
  if (matches(/征信|信用报告|信用评估|授信资料|credit\s*(report|assessment)/i, /(?:^|\n)\s*(?:企业)?(?:征信|信用)报告/))
    return "信用资料";
  if (matches(/发票|开票|结算单|对账单|收款凭证|回款记录|invoice|settlement/i, /(?:^|\n)\s*(?:发票|结算单|对账单|收款凭证)/))
    return "发票/结算资料";
  if (matches(/质押合同|抵押合同|保证合同|担保合同|质押协议|抵押协议|担保协议|保证书/i, /(?:^|\n)\s*(?:最高额)?(?:质押|抵押|保证|担保)(?:合同|协议|书)/))
    return "担保/抵质押资料";
  if (matches(/提款通知书|放款通知书|提款申请(?:书)?|放款凭证|借款借据|借据/i, /(?:^|\n)\s*(?:提款|放款)(?:通知书|申请书|凭证)/))
    return "提款/放款资料";
  return null;
}

function associationSignals(document: AudiPickAssociationDocument): AssociationSignals {
  const source = [document.name, String(document.text ?? "").slice(0, 5_000)].join("\n");
  const projectCodes: string[] = [];
  const documentNumbers: string[] = [];
  const entities: string[] = [];
  const codePattern = /(?:^|[^A-Z0-9])([A-Z]{1,6})[\s_—–－-]*(\d{2,10})(?![A-Z0-9])/gi;
  const numberPattern = /(?:合同|协议|项目|订单)(?:编号|号)?\s*[：:]?\s*([A-Z0-9][A-Z0-9._\/-]{3,})/gi;
  const entityPattern = /[\u4e00-\u9fa5]{2,32}(?:股份有限公司|有限责任公司|有限公司|集团公司|研究所|银行)/g;
  let match: RegExpExecArray | null;
  while ((match = codePattern.exec(source))) projectCodes.push(`${match[1]}${match[2]}`);
  while ((match = numberPattern.exec(source))) documentNumbers.push(match[1]);
  while ((match = entityPattern.exec(source))) entities.push(match[0].replace(/[\s（）()]/g, ""));
  return {
    projectCodes: uniqueAssociationValues(projectCodes),
    documentNumbers: uniqueAssociationValues(documentNumbers),
    entities: uniqueAssociationValues(entities),
  };
}

function sharedValues(left: string[], right: string[]) {
  const available = new Set(right);
  return left.filter((value) => available.has(value));
}

function isLikelyPrimaryDocument(document: AudiPickAssociationDocument) {
  if (associationRoleForDocument(document)) return false;
  const label = [document.name, document.detectedLabel, document.ruleName].filter(Boolean).join(" ");
  if (/合同|协议|contract|agreement/i.test(label)) return true;
  return Boolean(document.detectedRuleId || document.ruleId);
}

export function buildAssociationSuggestions(
  documents: AudiPickAssociationDocument[],
  groups: AudiPickAssociationGroup[],
  dismissedPairs: string[] = [],
) {
  const memberIds = new Set(groups.flatMap((group) => group.members.map((member) => member.fileId)));
  const anchorIds = new Set(groups.map((group) => group.anchorFileId));
  const dismissed = new Set(dismissedPairs);
  const signals = new Map(documents.map((document) => [document.id, associationSignals(document)]));
  const suggestions: AudiPickAssociationSuggestion[] = [];

  for (const document of documents) {
    if (memberIds.has(document.id) || anchorIds.has(document.id)) continue;
    const role = associationRoleForDocument(document);
    if (!role) continue;
    const sourceSignals = signals.get(document.id)!;
    const candidates = documents
      .filter((anchor) =>
        anchor.id !== document.id &&
        !memberIds.has(anchor.id) &&
        isLikelyPrimaryDocument(anchor) &&
        !dismissed.has(`${anchor.id}>${document.id}`),
      )
      .map((anchor) => {
        const targetSignals = signals.get(anchor.id)!;
        const codes = sharedValues(sourceSignals.projectCodes, targetSignals.projectCodes);
        const numbers = sharedValues(sourceSignals.documentNumbers, targetSignals.documentNumbers);
        const entities = sharedValues(sourceSignals.entities, targetSignals.entities);
        const reasons: string[] = [];
        let score = 0;
        if (codes.length) { score += 85; reasons.push(`项目编号 ${codes[0]} 一致`); }
        if (numbers.length) { score += 70; reasons.push("合同/项目编号一致"); }
        if (entities.length) { score += 20; reasons.push(`合同主体 ${entities[0]} 一致`); }
        if (document.detectedRuleId && anchor.detectedRuleId && document.detectedRuleId === anchor.detectedRuleId)
          score += 5;
        return { anchor, score, reasons };
      })
      .filter((candidate) => candidate.score >= 65)
      .sort((left, right) => right.score - left.score);
    if (!candidates.length || (candidates[1] && candidates[0].score - candidates[1].score < 15)) continue;
    const best = candidates[0];
    suggestions.push({
      fileId: document.id,
      anchorFileId: best.anchor.id,
      anchorName: best.anchor.name || "主合同",
      role,
      score: best.score,
      confidence: best.score >= 85 ? "high" : "medium",
      reason: [...best.reasons, `文件识别为${role}`].join("；"),
    });
  }
  return suggestions;
}

export function applyHighConfidenceAssociations(
  groups: AudiPickAssociationGroup[],
  suggestions: AudiPickAssociationSuggestion[],
) {
  const next = groups.map((group) => ({
    ...group,
    members: group.members.map((member) => ({ ...member })),
  }));
  const occupied = new Set(next.flatMap((group) => [group.anchorFileId, ...group.members.map((member) => member.fileId)]));
  for (const suggestion of suggestions) {
    if (suggestion.confidence !== "high" || occupied.has(suggestion.fileId)) continue;
    if (next.some((group) => group.members.some((member) => member.fileId === suggestion.anchorFileId))) continue;
    let group = next.find((candidate) => candidate.anchorFileId === suggestion.anchorFileId);
    if (!group) {
      group = { id: `g_auto_${suggestion.anchorFileId}`, anchorFileId: suggestion.anchorFileId, members: [] };
      next.push(group);
      occupied.add(suggestion.anchorFileId);
    }
    group.members.push({
      fileId: suggestion.fileId,
      role: suggestion.role,
      source: "ai",
      confidence: suggestion.confidence,
      reason: suggestion.reason,
    });
    occupied.add(suggestion.fileId);
  }
  return next;
}
