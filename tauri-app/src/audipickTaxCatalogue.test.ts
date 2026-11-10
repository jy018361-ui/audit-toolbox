import { describe, expect, it } from "vitest";
import { buildTaxPageIndex, canProcessTaxType, taxTypeName, taxTypeOptions, taxFormCatalogue } from "./audipickTax";

describe("tax form classification", () => {
  it("does not turn a filing receipt that mentions the VAT form into the form itself", () => {
    const index = buildTaxPageIndex([{
      page: 1,
      text: "电子税务局申报回执\n申报事项：增值税及附加税费申报表（一般纳税人适用）\n申报状态：已受理\n受理时间：2026-10-28",
    }], "申报回执.pdf");

    expect(index.forms).toEqual([]);
    expect(index.pages[0].kind).toBe("receipt");
  });

  it("recognizes VAT appendix II as its own schedule and never as the VAT main form", () => {
    const index = buildTaxPageIndex([{
      page: 1,
      text: "增值税及附加税费申报表（小规模纳税人适用）附列资料（二）\n（附加税费情况表）\n税（费）种 计税依据 本期应纳税费额\n城市维护建设税 教育费附加 地方教育附加",
    }], "增值税申报.pdf");

    expect(index.forms.map(({ key }) => key)).toEqual(["vat_small_appendix_2"]);
    expect(index.forms[0]).toMatchObject({ taxType: "vat", formName: "增值税及附加税费申报表（小规模纳税人适用）附列资料（二）" });
  });

  it("recognizes the historical VAT appendix II label written as 表二", () => {
    const title = "增值税纳税申报表附列资料（表二）（本期进项税额明细）";
    const index = buildTaxPageIndex([{ page: 1, text: `${title}\n本期进项税额明细\n税额` }], "历史增值税.pdf");
    expect(index.forms[0]).toMatchObject({ key: "vat_appendix_2", formName: title });
  });

  it("retains a printed historical VAT title verbatim", () => {
    const title = "增值税纳税申报表（一般纳税人适用）";
    const index = buildTaxPageIndex([{ page: 1, text: `${title}\n纳税人名称：示例有限公司` }], "历史税表.pdf");
    expect(index.forms[0]).toMatchObject({ key: "vat_main", formName: title });
  });

  it("recognizes the old small-taxpayer main title and keeps its wording", () => {
    const title = "增值税纳税申报表（小规模纳税人适用）";
    const index = buildTaxPageIndex([{ page: 1, text: title }], "小规模增值税.pdf");
    expect(index.forms[0]).toMatchObject({ key: "vat_main_small", formName: title });
  });

  it("separates numbered 2026 pilot schedules from the same-numbered general schedules", () => {
    const index = buildTaxPageIndex([
      { page: 1, text: "增值税及附加税费申报表附列资料（一）\n一般项目" },
      { page: 2, text: "增值税及附加税费申报表（试行）附列资料（一）\n本期销售情况明细表" },
      { page: 3, text: "增值税及附加税费申报表（试行）（封面）" },
      { page: 4, text: "增值税及附加税费申报表主表\n销售额 应纳税额" },
      { page: 5, text: "增值税及附加税费申报表业务信息表\n纳税人基本信息" },
      { page: 6, text: "附1 未开具发票销售情况明细" },
      { page: 7, text: "附2 扣除项目明细" },
      { page: 8, text: "附3 简易计税明细" },
      { page: 9, text: "附1 本期加计抵减情况明细" },
    ], "增值税申报.pdf");

    expect(index.forms.map(({ key }) => key)).toEqual([
      "vat_appendix_1", "vat_pilot_2026_appendix_一", "vat_main_pilot_2026", "vat_pilot_2026_business_info",
      "vat_pilot_2026_appendix_1_attachment_1", "vat_pilot_2026_appendix_1_attachment_2",
      "vat_pilot_2026_appendix_1_attachment_3", "vat_pilot_2026_appendix_2_attachment_1",
    ]);
    expect(index.pages[2].kind).toBe("cover");
  });

  it("recognizes the small-taxpayer appendix I and its appendix II independently", () => {
    const index = buildTaxPageIndex([
      { page: 1, text: "增值税及附加税费申报表（小规模纳税人适用）附列资料（一）" },
      { page: 2, text: "增值税及附加税费申报表（小规模纳税人适用）附列资料（二）" },
    ], "小规模增值税申报.pdf");
    expect(index.forms.map(({ key }) => key)).toEqual(["vat_small_appendix_1", "vat_small_appendix_2"]);
  });

  it("recognizes land appreciation tax without classifying it as VAT", () => {
    const index = buildTaxPageIndex([{
      page: 1,
      text: "土地增值税预征申报\n土地增值税税源明细表（从事房地产开发的纳税人预缴适用）\n纳税人名称：示例房地产有限公司",
    }], "土地增值税.pdf");

    expect(index.forms[0]).toMatchObject({ key: "land_appreciation_prepaid_source", taxType: "land_appreciation" });
    expect(index.taxType).toBe("land_appreciation");
  });

  it("does not infer a prepaid subtype from the ambiguous land appreciation return name alone", () => {
    const title = "土地增值税纳税申报表（一）";
    const index = buildTaxPageIndex([{ page: 1, text: title }], "土地增值税.pdf");
    expect(index.forms[0]).toMatchObject({ key: "land_appreciation_declaration", formName: title, taxType: "land_appreciation" });
  });

  it("keeps the historical real-estate installment deduction schedule outside current appendix V", () => {
    const index = buildTaxPageIndex([{ page: 1, text: "不动产分期抵扣计算表" }], "历史增值税.pdf");
    expect(index.forms[0]).toMatchObject({ key: "vat_historical_real_estate_deduction", formName: "不动产分期抵扣计算表" });
  });

  it("does not attach a payment voucher as a second page of the prior form", () => {
    const index = buildTaxPageIndex([
      { page: 13, text: "A105000 纳税调整项目明细表\nPage 1 of 2\n1 收入类 100 80 20 0\n2 成本类 100 80 20 0" },
      { page: 14, text: "付款凭证\n42 付款金额 100 100\n43 实付金额 100 100" },
    ], "申报资料.pdf");
    expect(index.forms[0].pages).toEqual([13]);
    expect(index.pages[1].kind).toBe("receipt");
  });

  it("requires the surcharge form title and table labels before classifying a short OCR title", () => {
    const titleOnly = buildTaxPageIndex([{ page: 1, text: "附加税申报表" }], "扫描.pdf");
    expect(titleOnly.forms).toEqual([]);

    const withFields = buildTaxPageIndex([{ page: 1, text: "附加税申报表\n征收项目\n税率\n税额" }], "附加税.pdf");
    expect(withFields.forms[0]).toMatchObject({ key: "surcharge", formName: "附加税申报表", taxType: "surcharge" });
  });

  it("only treats 申报结果 as a receipt when accompanied by submission or acceptance status", () => {
    const index = buildTaxPageIndex([
      { page: 1, text: "申报结果" },
      { page: 2, text: "申报结果\n申报状态：已提交" },
      { page: 3, text: "申报结果\n受理状态：已受理" },
    ], "扫描.pdf");
    expect(index.pages.map((page) => page.kind)).toEqual(["unknown", "receipt", "receipt"]);
    expect(index.forms).toEqual([]);
  });

  it("recognizes repeated scanned receipt titles containing the explicit word 回执", () => {
    const index = buildTaxPageIndex([1, 7, 10, 12].map((page) => ({ page, text: "申报结果回执" })), "扫描.pdf");
    expect(index.pages.map((item) => item.kind)).toEqual(["receipt", "receipt", "receipt", "receipt"]);
    expect(index.forms).toEqual([]);
  });

  it("preserves the rotated stamp-title page and leaves a fragment without a title pending", () => {
    const index = buildTaxPageIndex([
      { page: 13, text: "印花税申报（报告）表", rotation: 270 },
      { page: 14, text: "实缴税额", rotation: 270 },
    ], "扫描.pdf");
    expect(index.pages[0]).toMatchObject({ kind: "form", formKey: "stamp_declaration", rotation: 270 });
    expect(index.pages[1].kind).toBe("unknown");
  });

  it.each([
    ["增值税及附加税费预缴表", "vat_prepaid"],
    ["城市维护建设税及教育费附加申报表", "surcharge"],
    ["印花税税源明细表", "stamp_source"],
    ["印花税申报（报告）表", "stamp_declaration"],
  ])("recognizes the %s as a distinct form", (title, key) => {
    const index = buildTaxPageIndex([{ page: 1, text: `${title}\n纳税人名称：示例有限公司\n税款所属期：2026年10月` }], `${title}.pdf`);
    expect(index.forms.map(({ key: formKey }) => formKey)).toContain(key);
  });

  it("keeps the property and behavior tax return and stamp tax sources separate", () => {
    const index = buildTaxPageIndex([
      { page: 1, text: "财产和行为税纳税申报表\n纳税人名称：示例房地产有限公司" },
      { page: 2, text: "土地增值税税源明细表（从事房地产开发的纳税人预缴适用）\n项目名称：样本项目" },
      { page: 3, text: "印花税税源明细表\n税目：买卖合同" },
    ], "多税种申报.pdf");

    expect(index.forms.map(({ key, taxType }) => [key, taxType])).toEqual([
      ["property_behavior_main", "property_behavior"],
      ["land_appreciation_prepaid_source", "land_appreciation"],
      ["stamp_source", "stamp"],
    ]);
    expect(index.taxType).toBe("mixed");
  });

  it("catalogues 2026 trial forms under separate keys and preserves the generic numbered appendices", () => {
    const catalogue = taxFormCatalogue();
    expect(catalogue.map(({ key }) => key)).toContain("vat_appendix_1");
    expect(catalogue.map(({ key }) => key)).toEqual(expect.arrayContaining([
      "vat_appendix_2", "vat_pilot_2026_appendix_一", "vat_main_pilot_2026",
      "vat_pilot_2026_business_info", "land_appreciation_prepaid_source", "property_behavior_main", "stamp_source",
    ]));
    expect(new Set(catalogue.map(({ key }) => key)).size).toBe(catalogue.length);
  });

  it("exposes UI labels and only allows concrete, single-tax extraction", () => {
    expect(taxTypeName.stamp).toBe("印花税");
    expect(taxTypeOptions.map(({ value }) => value)).not.toEqual(expect.arrayContaining(["unknown", "mixed"]));
    expect(canProcessTaxType("stamp")).toBe(true);
    expect(canProcessTaxType("unknown")).toBe(false);
    expect(canProcessTaxType("mixed")).toBe(false);
  });
});
