import { describe, expect, it } from "vitest";
import type { TaxDocumentIndex } from "./audipickTax";
import { isTaxReviewCurrent, REVIEW_VERSION, stampTaxReviewGroup, validateTaxReviewGroup, validateTaxReviewGroups } from "./audipickTaxReview";

const index = (): TaxDocumentIndex => ({
  fileName: "甲公司.pdf", companyName: "甲公司", period: "2025年度", taxType: "corporate_income",
  pages: [1,2,3,4].map(page => ({ page, text: `page ${page}`, source: "text", kind: "form", formKey: "A105000", taxType: "corporate_income", confidence: "high" })),
  forms: [{ key: "A105000", formCode: "A105000", formName: "纳税调整项目明细表", taxType: "corporate_income", pages: [1,2,3,4] }],
});

describe("税表人工复核组", () => {
  it("确认组保存目录指纹和版本；不同所属期的同表可分组且页码不重叠", () => {
    const value = index();
    const groups = [
      stampTaxReviewGroup(value, { id: "a", formKey: "A105000", companyName: "甲公司", period: "2024年度", pages: [1,2], status: "confirmed" }),
      stampTaxReviewGroup(value, { id: "b", formKey: "A105000", companyName: "甲公司", period: "2025年度", pages: [3,4], status: "confirmed" }),
    ];
    expect(groups[0]).toMatchObject({ reviewVersion: REVIEW_VERSION, indexFingerprint: expect.any(String) });
    expect(validateTaxReviewGroups(value, groups)).toEqual(groups);
  });
  it("拒绝公司/期间为空、非法页码、重复占页以及与新目录不匹配的旧确认", () => {
    const value = index();
    const base = { id: "a", formKey: "A105000", companyName: "甲公司", period: "2025年度", pages: [1], status: "confirmed" as const };
    expect(() => stampTaxReviewGroup(value, { ...base, companyName: " " })).toThrow(/公司名称/);
    expect(() => stampTaxReviewGroup(value, { ...base, period: "" })).toThrow(/所属期/);
    expect(() => stampTaxReviewGroup(value, { ...base, pages: [0,5] })).toThrow(/页码/);
    const groups = [stampTaxReviewGroup(value, base), stampTaxReviewGroup(value, { ...base, id: "b", pages: [1] })];
    expect(() => validateTaxReviewGroups(value, groups)).toThrow(/重叠/);
    const stale = stampTaxReviewGroup(value, base);
    const changed = index(); changed.pages[0].formKey = "A100000";
    expect(() => validateTaxReviewGroups(changed, [stale])).toThrow(/目录已变化/);
    const reaffirmed=validateTaxReviewGroup(changed,stale,[stale]);
    expect(reaffirmed.indexFingerprint).not.toBe(stale.indexFingerprint);
    expect(validateTaxReviewGroup(changed,reaffirmed,[stale])).toEqual(reaffirmed);
  });
  it("未知页面允许用空表单键排除，但已确认组必须选表单", () => {
    const value=index();
    const excluded=stampTaxReviewGroup(value,{id:"unknown-1",formKey:"",companyName:"",period:"",pages:[4],status:"excluded"});
    expect(validateTaxReviewGroups(value,[excluded])).toEqual([excluded]);
    expect(()=>stampTaxReviewGroup(value,{...excluded,id:"unknown-confirmed",status:"confirmed",companyName:"甲公司",period:"2025年度"})).toThrow(/表单标识/);
  });
  it("文档税种变化会使人工确认失效，但公司和期间编辑不会", () => {
    const value=index();
    const group=stampTaxReviewGroup(value,{id:"a",formKey:"A105000",companyName:"甲公司",period:"2025年度",pages:[1],status:"confirmed"});
    expect(isTaxReviewCurrent({...value,companyName:"甲公司全称",period:"2024年度"},group)).toBe(true);
    expect(isTaxReviewCurrent({...value,taxType:"vat"},group)).toBe(false);
  });
});
