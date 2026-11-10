import { describe, expect, it } from "vitest";
import type { TaxDocumentIndex, TaxForm, TaxPage } from "./audipickTax";
import { taxFormCatalogue } from "./audipickTax";
import { stampTaxReviewGroup, type TaxReviewGroup } from "./audipickTaxReview";
import { buildTaxReviewConfirmation } from "./audipickTaxConfirmation";

const vat: TaxForm = { key: "vat_main", formCode: "VAT_MAIN", formName: "增值税申报表", taxType: "vat", pages: [] };
const catalogue = [vat, ...taxFormCatalogue()];
const page = (number: number, kind: TaxPage["kind"], formKey?: string, confidence: TaxPage["confidence"] = "high"): TaxPage => ({
  page: number, text: `page ${number}`, source: "text", kind, taxType: formKey ? "vat" : "unknown", confidence,
  ...(formKey ? { formKey, formCode: "VAT_MAIN", formName: "增值税申报表" } : {}),
});
const index = (pages: TaxPage[], forms: TaxForm[] = [], taxType: TaxDocumentIndex["taxType"] = "vat"): TaxDocumentIndex => ({
  fileName: "申报材料.pdf", companyName: "甲公司", period: "2025年度", taxType, pages, forms,
});
const id = (() => { let count = 0; return () => `batch-${++count}`; })();
const baseGroup = (overrides: Partial<TaxReviewGroup> = {}): TaxReviewGroup => ({ id: "manual-1", formKey: "vat_main", companyName: "甲公司", period: "2025年度", pages: [1], status: "confirmed", ...overrides });

describe("buildTaxReviewConfirmation", () => {
  it("缺少公司或所属期时不批量确认正式表单，仍可排除明确回执", () => {
    for(const missing of [{companyName:""},{period:""}]) {
      const value={...index([page(1,"form","vat_main"),page(2,"receipt")],[{...vat,pages:[1]}]),...missing};
      const result=buildTaxReviewConfirmation(value,[],catalogue,id);
      expect(result.groups).toEqual([expect.objectContaining({pages:[2],status:"excluded"})]);
      expect(result.addedFormKeys).toEqual([]);
      expect(result.confirmedPages).toBe(1);
    }
  });
  it("批量确认高置信表单及续页，并把回执/封面/目录归为无需提取", () => {
    const value = index([
      page(1, "form", "vat_main"), page(2, "continuation", "vat_main"),
      page(3, "receipt"), page(4, "cover"), page(5, "directory"), page(6, "unknown"),
    ], [{ ...vat, pages: [1, 2] }], "mixed");
    const result = buildTaxReviewConfirmation(value, [], catalogue, id);
    expect(result.groups.map(({ formKey, pages, status }) => ({ formKey, pages, status }))).toEqual([
      { formKey: "vat_main", pages: [1, 2], status: "confirmed" },
      { formKey: "", pages: [3, 4, 5], status: "excluded" },
    ]);
    expect(result.addedFormKeys).toEqual(["vat_main"]);
    expect(result.confirmedPages).toBe(5);
    expect(result.skippedPages).toBe(1);
  });

  it("保留当前组；部分已分配页阻止同一自动表单剩余页被另建组", () => {
    const value = index([page(1, "form", "vat_main"), page(2, "continuation", "vat_main")], [{ ...vat, pages: [1, 2] }]);
    const current = stampTaxReviewGroup(value, baseGroup({ pages: [2], id: "existing" }));
    const result = buildTaxReviewConfirmation(value, [current], catalogue, id);
    expect(result.groups).toEqual([current]);
    expect(result.addedFormKeys).toEqual([]);
    expect(result.confirmedPages).toBe(0);
    expect(result.skippedPages).toBe(2);
  });

  it("只重确认语义和原范围完全匹配的 stale 表组，并保留原 id、元数据与页范围", () => {
    const old = index([page(1, "form", "vat_main")], [{ ...vat, pages: [1] }]);
    const stale = stampTaxReviewGroup(old, baseGroup({ id: "keep-me", companyName: "手工公司名", period: "2024年12月" }));
    const changed = index([{ ...page(1, "form", "vat_main"), reason: "OCR缓存更新" }], [{ ...vat, pages: [1] }]);
    const result = buildTaxReviewConfirmation(changed, [stale], catalogue, id);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ id: "keep-me", companyName: "手工公司名", period: "2024年12月", pages: [1], status: "confirmed" });
    expect(result.groups[0].indexFingerprint).not.toBe(stale.indexFingerprint);
    expect(result.addedFormKeys).toEqual(["vat_main"]);
  });

  it("不自动盖章低置信重复表、未知页或被 stale 组占用的页面", () => {
    const value = index([
      page(1, "form", "vat_main", "low"), page(2, "continuation", "vat_main", "high"), page(3, "unknown"),
    ], [{ ...vat, pages: [1, 2] }]);
    const stale = { ...baseGroup({ pages: [3] }), indexFingerprint: "old-fingerprint", reviewVersion: "old-version" };
    const result = buildTaxReviewConfirmation(value, [stale], catalogue, id);
    expect(result.groups).toEqual([stale]);
    expect(result.confirmedPages).toBe(0);
    expect(result.skippedPages).toBe(3);
  });

  it("只在目录税种与文件相同或文件标为混合时确认新表单", () => {
    const land = { key: "land_appreciation_declaration", formCode: "LAND_APPRECIATION_DECLARATION", formName: "土地增值税纳税申报表（一）", taxType: "land_appreciation" as const, pages: [1] };
    const wrongType = index([page(1, "form", land.key)], [land], "vat");
    const rejected = buildTaxReviewConfirmation(wrongType, [], [land], id);
    expect(rejected.groups).toEqual([]);
    expect(rejected.skippedPages).toBe(1);
    const mixed = { ...wrongType, taxType: "mixed" as const };
    expect(buildTaxReviewConfirmation(mixed, [], [land], id).groups[0]).toMatchObject({ formKey: land.key, pages: [1], status: "confirmed" });
  });

  it("只有全部 AI 页仍支持无需提取时才重确认 stale 排除组", () => {
    const old = index([page(1, "receipt"), page(2, "directory")]);
    const stale = stampTaxReviewGroup(old, baseGroup({ id: "excluded-old", formKey: "", companyName: "", period: "", pages: [1, 2], status: "excluded" }));
    const stillExcluded = index([{ ...page(1, "receipt"), reason: "回执文本更新" }, page(2, "directory")]);
    const confirmed = buildTaxReviewConfirmation(stillExcluded, [stale], catalogue, id);
    expect(confirmed.groups[0]).toMatchObject({ id: "excluded-old", pages: [1, 2], status: "excluded" });
    expect(confirmed.groups[0].indexFingerprint).not.toBe(stale.indexFingerprint);
    const conflicting = index([page(1, "receipt"), page(2, "unknown")]);
    expect(buildTaxReviewConfirmation(conflicting, [stale], catalogue, id).groups).toEqual([stale]);
  });
});
