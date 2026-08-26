import { describe, expect, it } from "vitest";
import { fxAllowedModes, fxApplyJobResult, fxDefaultMode, fxDropTargetAt, fxMergeJobResult, fxMissingRequired, fxPreviewTokenFor, fxReportStart, fxRunMappingReviews, fxAttachRole, fxDetachRole} from "./FxAuditPage";
describe("fx audit mode selection",()=>{
  it("uses two-point unrealized mode for TB only",()=>{expect(fxDefaultMode(false,true)).toBe("unrealized");expect(fxAllowedModes(false,true)).toEqual(["unrealized"])});
  it("uses realized mode for JE only",()=>expect(fxDefaultMode(true,false)).toBe("realized"));
  it("defaults to combined when both sources exist",()=>{expect(fxDefaultMode(true,true)).toBe("combined");expect(fxAllowedModes(true,true)).toEqual(["realized","unrealized","combined"])});
});
describe("fx audit upload and mapping parity",()=>{
  it("routes native drops by actual drop coordinates",()=>{const je={left:0,right:400,top:100,bottom:200};const tb={left:500,right:900,top:100,bottom:200};expect(fxDropTargetAt(200,150,je,tb)).toBe("je");expect(fxDropTargetAt(700,150,je,tb)).toBe("tb");expect(fxDropTargetAt(450,150,je,tb)).toBeUndefined()});
  it("shows missing required mappings like kanzhang",()=>{expect(fxMissingRequired("je",{},false,"默认主体")).toEqual(["记账日期","凭证识别字段","科目编码","科目名称","摘要","原币币种","原币金额方案","本位币金额方案"])});
  it("limits TB missing prompts to the fixed required field set",()=>{expect(fxMissingRequired("tb",{},true,"默认主体")).toEqual(["科目编码","科目名称","币种列或币种线索文本","期初原币或本位币余额","期末原币或本位币余额","本年累计（或本期）借/贷方发生额"])});
  it("accepts either original or functional TB balances at each endpoint",()=>{expect(fxMissingRequired("tb",{accountCode:"科目编码",accountName:"科目名称",currency:"币种",openingFunctionalAmount:"期初本币",closingForeignAmount:"期末原币",ytdFunctionalDebit:"借方",ytdFunctionalCredit:"贷方"},true,"默认主体")).toEqual([])});
  it("accepts a currency clue column when the TB has no currency column",()=>{expect(fxMissingRequired("tb",{accountCode:"科目编码",accountName:"科目名称",currencyText:"文本",openingFunctionalAmount:"期初本币",closingFunctionalAmount:"期末本币",ytdFunctionalDebit:"借方",ytdFunctionalCredit:"贷方"},true,"默认主体")).toEqual([])});
  it("still accepts the legacy combined account mapping",()=>{expect(fxMissingRequired("tb",{account:["科目代码","科目名称"],currency:"币种",openingFunctionalAmount:"期初本币",closingFunctionalAmount:"期末本币",ytdFunctionalDebit:"借方",ytdFunctionalCredit:"贷方"},true,"默认主体")).toEqual([])});
  it("prompts when neither ytd nor period debit/credit pairs are complete",()=>{const ytdOnlyDebit={accountCode:"科目编码",accountName:"科目名称",currency:"币种",openingFunctionalAmount:"期初本币",closingFunctionalAmount:"期末本币",ytdFunctionalDebit:"借方"};expect(fxMissingRequired("tb",ytdOnlyDebit,true,"默认主体")).toEqual(["本年累计（或本期）借/贷方发生额"]);const periodOk={...ytdOnlyDebit,periodFunctionalDebit:"本期借方",periodFunctionalCredit:"本期贷方"};expect(fxMissingRequired("tb",periodOk,true,"默认主体")).toEqual([])});
  it("derives the audit year start from the balance sheet date",()=>expect(fxReportStart("2024-12-31")).toBe("2024-01-01"));
  it("starts JE and TB mapping reviews from one action",async()=>{const started:string[]=[];const pending:Record<string,()=>void>={};const task=fxRunMappingReviews(kind=>new Promise<void>(resolve=>{started.push(kind);pending[kind]=resolve}));expect(started).toEqual(["je","tb"]);pending.je();pending.tb();await task});
  it("keeps preview data when export adds an output path",()=>{const preview={summary:{difference:12},voucherDetail:[{voucherId:"1"}]};const exported={summary:{difference:12},outputPaths:["workpaper.xlsx"]};expect(fxMergeJobResult(preview,exported)).toEqual({...preview,...exported})});
  it("keeps the last preview when a completion event has no result payload",()=>{const preview={summary:{difference:12}};expect(fxApplyJobResult(preview,undefined,"fx.preview")).toBe(preview)});
  it("accepts a preview result before the completed event",()=>{const preview={summary:{difference:12}};expect(fxApplyJobResult(undefined,preview,"fx.preview")).toEqual(preview)});
  it("merges export output into the visible preview instead of replacing it",()=>{const preview={summary:{difference:12},voucherDetail:[{voucherId:"1"}]};expect(fxApplyJobResult(preview,{outputPaths:["workpaper.xlsx"]},"fx.export")).toEqual({...preview,outputPaths:["workpaper.xlsx"]})});
  it("passes a real preview token only to export",()=>{const result={previewToken:"preview-123"};expect(fxPreviewTokenFor("fx.export",result)).toBe("preview-123");expect(fxPreviewTokenFor("fx.preview",result)).toBeUndefined();expect(fxPreviewTokenFor("fx.export",{})).toBeUndefined()});
});

describe("同一列的多重映射", () => {
  it("币种线索文本可以叠加在科目名称上", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "科目名称", "accountName");
    m = fxAttachRole(m, "科目名称", "currencyText");
    expect(m.accountName).toEqual(["科目名称"]);
    expect(m.currencyText).toBe("科目名称");
  });

  it("换成别的字段时挤掉原有的正经角色，但留住币种线索", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "科目全称", "accountName");
    m = fxAttachRole(m, "科目全称", "currencyText");
    m = fxAttachRole(m, "科目全称", "accountCode");
    expect(m.accountName).toEqual([]);
    expect(m.accountCode).toBe("科目全称");
    expect(m.currencyText).toBe("科目全称");
  });

  it("两个正经角色不能共用一列", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "期初余额", "openingFunctionalAmount");
    m = fxAttachRole(m, "期初余额", "closingFunctionalAmount");
    expect(m.openingFunctionalAmount).toBe("");
    expect(m.closingFunctionalAmount).toBe("期初余额");
  });

  it("摘掉标记只影响指定的那一个", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "科目名称", "accountName");
    m = fxAttachRole(m, "科目名称", "currencyText");
    m = fxDetachRole(m, "科目名称", "currencyText");
    expect(m.accountName).toEqual(["科目名称"]);
    expect(m.currencyText).toBe("");
  });
});

describe("跨表对齐后的币种线索", () => {
  /**
   * 4800 的 TB 有独立「文本」列（`银行存款-建行USD4150-4800`），初次识别会把它
   * 当币种线索；跨表对齐发现它才是与 JE 同口径的科目名称，于是建议改映射。
   * 两个角色共用这一列即可——科目名称里写着账户币种正是线索的来源。
   */
  it("对齐把科目名称改到币种线索那一列时，线索角色要留住", () => {
    const before: Record<string, string | string[]> = {
      accountCode: "科目代码",
      accountName: ["科目名称一级", "科目名称二级"],
      currencyText: "文本",
    };
    const fix = {accountName: "文本"};
    // 展开带索引签名的对象时 TS 会丢掉索引签名，不标注的话 after 只剩 fix 里那一个键。
    const after: Record<string, string | string[]> = {...before, ...fix};
    expect(after.accountName).toBe("文本");
    expect(after.currencyText).toBe("文本");
    // 币种线索还在，就不会冒出「尚未映射：币种列或币种线索文本」。
    expect(fxMissingRequired("tb", {
      ...after,
      openingFunctionalAmount: "期初金额-本位币",
      closingFunctionalAmount: "期末金额-本位币",
    }, false, "3300")).not.toContain("币种列或币种线索文本");
  });
});
