import { describe, expect, it } from "vitest";
import { fxAllowedModes, fxDefaultMode, fxDropTargetAt, fxMissingRequired, fxReportStart } from "./FxAuditPage";
describe("fx audit mode selection",()=>{
  it("uses two-point unrealized mode for TB only",()=>{expect(fxDefaultMode(false,true)).toBe("unrealized");expect(fxAllowedModes(false,true)).toEqual(["unrealized"])});
  it("uses realized mode for JE only",()=>expect(fxDefaultMode(true,false)).toBe("realized"));
  it("defaults to combined when both sources exist",()=>{expect(fxDefaultMode(true,true)).toBe("combined");expect(fxAllowedModes(true,true)).toEqual(["realized","unrealized","combined"])});
});
describe("fx audit upload and mapping parity",()=>{
  it("routes native drops by actual drop coordinates",()=>{const je={left:0,right:400,top:100,bottom:200};const tb={left:500,right:900,top:100,bottom:200};expect(fxDropTargetAt(200,150,je,tb)).toBe("je");expect(fxDropTargetAt(700,150,je,tb)).toBe("tb");expect(fxDropTargetAt(450,150,je,tb)).toBeUndefined()});
  it("shows missing required mappings like kanzhang",()=>{expect(fxMissingRequired("je",{},false,"默认主体")).toEqual(["凭证识别字段","记账日期","科目编码/名称","交易币种","原币金额方案","本位币金额方案"])});
  it("derives the audit year start from the balance sheet date",()=>expect(fxReportStart("2024-12-31")).toBe("2024-01-01"));
});
