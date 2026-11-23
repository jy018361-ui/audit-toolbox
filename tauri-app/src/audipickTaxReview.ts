import type { TaxDocumentIndex } from "./audipickTax";

export const REVIEW_VERSION = "tax-review-v1";

export type TaxReviewGroup = {
  id: string;
  formKey: string;
  companyName: string;
  period: string;
  pages: number[];
  status: "confirmed" | "excluded";
  /** Missing version/fingerprint is treated as stale and cannot authorize extraction. */
  reviewVersion?: string;
  indexFingerprint?: string;
};

export function isTaxReviewCurrent(index: TaxDocumentIndex, group: TaxReviewGroup): boolean {
  return group.reviewVersion === REVIEW_VERSION && group.indexFingerprint === taxReviewFingerprint(index);
}

/** Fingerprint only the page directory, so changing review metadata does not invalidate page ownership. */
export function taxReviewFingerprint(index: TaxDocumentIndex): string {
  const directory = JSON.stringify({
    taxType: index.taxType,
    pages: index.pages.map(({ page, text, source, kind, formKey, formCode, formName, taxType, confidence, reason, rotation }) =>
      [page, text, source, kind, formKey, formCode, formName, taxType, confidence, reason,...(rotation?[rotation]:[])]),
    forms: index.forms.map(({ key, formCode, formName, taxType, pages }) => [key, formCode, formName, taxType, pages]),
  });
  // Two independent 32-bit rolling hashes keep repeated synchronous checks cheap.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < directory.length; i++) {
    const code = directory.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${REVIEW_VERSION}:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function validateTaxReviewGroupsStructure(index: TaxDocumentIndex, groups: TaxReviewGroup[]): TaxReviewGroup[] {
  const ids = new Set<string>();
  const occupiedPages = new Set<number>();
  for (const group of groups) {
    if (!group.id.trim() || ids.has(group.id)) throw new Error("复核组标识为空或重复，请重新确认表单分组。");
    ids.add(group.id);
    if (group.status === "confirmed" && !group.formKey.trim()) throw new Error("已确认复核组缺少表单标识。");
    if (group.status === "confirmed" && !group.companyName.trim()) throw new Error("请填写复核组公司名称。");
    if (group.status === "confirmed" && !group.period.trim()) throw new Error("请填写复核组所属期。");
    if (group.status !== "confirmed" && group.status !== "excluded") throw new Error("复核状态无效。");
    const current = isTaxReviewCurrent(index, group);
    if (!group.pages.length || group.pages.some(page => !Number.isInteger(page) || page < 1 || (current && page > index.pages.length)) || new Set(group.pages).size !== group.pages.length) {
      throw new Error("复核组页码无效，请选择有效且不重复的 PDF 页码。");
    }
    for (const page of group.pages) {
      if (occupiedPages.has(page)) throw new Error(`复核组页码重叠：PDF 第 ${page} 页只能归属一个复核组。`);
      occupiedPages.add(page);
    }
  }
  return groups;
}

export function validateTaxReviewGroups(index: TaxDocumentIndex, groups: TaxReviewGroup[]): TaxReviewGroup[] {
  validateTaxReviewGroupsStructure(index, groups);
  if (groups.some(group => !isTaxReviewCurrent(index, group))) throw new Error("税表页面目录已变化，旧复核确认已失效，请重新确认页码。");
  return groups;
}

/** Validate and stamp a new/explicitly reconfirmed group while retaining stale groups for overlap checks. */
export function validateTaxReviewGroup(index: TaxDocumentIndex, group: TaxReviewGroup, existingGroups: TaxReviewGroup[] = []): TaxReviewGroup {
  const stamped = { ...group, reviewVersion: REVIEW_VERSION, indexFingerprint: taxReviewFingerprint(index) };
  const groups = [...existingGroups.filter(item => item.id !== group.id), stamped];
  validateTaxReviewGroupsStructure(index, groups);
  return stamped;
}

/** Convenience alias for creating a stamped review decision. */
export function stampTaxReviewGroup(index: TaxDocumentIndex, group: TaxReviewGroup): TaxReviewGroup {
  return validateTaxReviewGroup(index, group);
}
