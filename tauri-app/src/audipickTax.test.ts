import { describe, expect, it } from "vitest";
import { buildTaxPageIndex, selectedTaxPages, parseTaxPageSelection, validateTaxGridResponse, buildTaxExtractionPrompt, taxFormCatalogue } from "./audipickTax";

const adjustment = "A105000 纳税调整项目明细表\n纳税人名称：测试制造有限公司\n税款所属期间：2024年1月1日至2024年12月31日\n行次 项目 账载金额 税收金额 调增金额 调减金额\n1 收入类调整项目 1,000.00 800.00 200.00 0\n2 视同销售收入 0 0 0 0\n42 其他 0 0 0 0";

describe("tax page index", () => {
  it("offers known forms with empty pages for a fully unrecognized scanned batch", () => {
    const catalogue = taxFormCatalogue();
    expect(catalogue.find((form) => form.key === "A105000")).toMatchObject({ taxType: "corporate_income", pages: [] });
    expect(catalogue.filter((form) => form.taxType === "vat")).toHaveLength(8);
    expect(catalogue.every((form) => form.pages.length === 0)).toBe(true);
    expect(new Set(catalogue.map((form) => form.key)).size).toBe(catalogue.length);
  });
  it("includes the unnumbered overseas investment report and its evidenced consecutive continuation pages", () => {
    const report=taxFormCatalogue().find(form=>form.formName==="居民企业境外投资信息报告表");
    expect(report).toMatchObject({taxType:"corporate_income",pages:[]});
    const index=buildTaxPageIndex([
      {page:18,text:"居民企业境外投资信息报告表\n一、报告人信息\n企业名称：测试投资有限公司\n二、外国企业信息"},
      {page:19,text:"1.外国企业名称 Test Overseas Limited\n3.外国企业识别号 100\n4.注册地国家（地区）甲国\n6.首次取得股权时间 2025"},
      {page:20,text:"7.主要业务活动\n10.报告人持股比例（年末数）\n13.外国企业所在层级\n（三）受控外国企业信息"},
      {page:21,text:"三、报告人声明\n报告人（签章）：测试公司\n主管税务机关受理人：测试人\n税务机关（盖章）"},
    ],"企业所得税.pdf");
    expect(index.forms).toHaveLength(1);
    expect(index.forms[0]).toMatchObject({key:report?.key,pages:[18,19,20,21]});
    expect(index.pages.map(page=>page.kind)).toEqual(["form","continuation","continuation","continuation"]);
    expect(index.pages.every(page=>page.confidence==="high")).toBe(true);
  });
  it("keeps repeated report titles and foreign-entity resets without treating them as annual-form duplicates", () => {
    const title="居民企业境外投资信息报告表\n一、报告人信息\n二、外国企业信息";
    const index=buildTaxPageIndex([{page:1,text:title},{page:2,text:`三、报告人声明\n${title}`},{page:3,text:"17.特许权使用费收入 0.00\n（三）受控外国企业信息\n25.受控外国企业构成条件"}],"申报.pdf");
    expect(index.forms[0]?.pages).toEqual([1,2,3]);
    expect(index.pages.every(page=>page.confidence==="high")).toBe(true);
  });
  it("does not attach blanks, generic notes, other forms, or report-like pages without adjacency to the report", () => {
    const title="居民企业境外投资信息报告表\n一、报告人信息";
    const body="主要业务活动\n报告人持股比例\n外国企业所在层级";
    for(const middle of ["","业务说明：请核对申报数据。","收入总额 100\n利润总额 20\n资产总额 50"]) {
      const index=buildTaxPageIndex([{page:1,text:title},{page:2,text:middle},{page:3,text:body}],"申报.pdf");
      expect(index.forms[0]?.pages).toEqual([1]);
      expect(index.pages.slice(1).map(page=>page.kind)).toEqual(["unknown","unknown"]);
    }
    const other=buildTaxPageIndex([{page:1,text:title},{page:2,text:adjustment},{page:3,text:body}],"申报.pdf");
    expect(other.forms.map(form=>form.pages)).toEqual([[1],[2]]);
    expect(other.pages[2].kind).toBe("unknown");
    expect(buildTaxPageIndex([{page:1,text:title},{page:3,text:body}],"申报.pdf").forms[0]?.pages).toEqual([1]);
    const unrelatedRows=buildTaxPageIndex([{page:1,text:`${title}\n28 其他字段 0 0`},{page:2,text:"29 资产项目 0 0\n30 合计 0 0"}],"申报.pdf");
    expect(unrelatedRows.forms[0]?.pages).toEqual([1]);
    expect(unrelatedRows.pages[1].kind).toBe("unknown");
  });
  it("locates the same form independently and excludes the declaration directory", () => {
    for (const target of [5, 7, 8]) {
      const index = buildTaxPageIndex([
        { page: 1, text: "企业所得税年度纳税申报表" },
        { page: 2, text: "企业所得税年度纳税申报表填报表单\nA100000 主表\nA105000 纳税调整项目明细表\nA106000 企业所得税弥补亏损明细表\nA104000 期间费用明细表" },
        { page: target, text: adjustment },
      ], "申报.pdf");
      expect(index.pages[1].kind).toBe("directory");
      expect(index.companyName).toBe("测试制造有限公司");
      expect(index.taxType).toBe("corporate_income");
      expect(index.forms.find((form) => form.formCode === "A105000")?.pages).toEqual([target]);
      expect(selectedTaxPages(index, ["A105000"])).toEqual([target]);
    }
  });

  it("attaches a titleless continuation only with adjacent, increasing row evidence", () => {
    const index = buildTaxPageIndex([
      { page: 8, text: adjustment },
      { page: 9, text: "43 其他资产类调整项目 0 0 0 0\n44 特殊事项调整项目 0 0 0 0\n45 合计 1000 800 200 0" },
      { page: 10, text: "业务说明：请核对申报数据。" },
      { page: 11, text: "46 其他 0 0 0 0\n47 合计 0 0 0 0" },
    ], "申报.pdf");
    expect(index.forms[0].pages).toEqual([8, 9]);
    expect(index.pages.map((page) => page.kind)).toEqual(["form", "continuation", "unknown", "unknown"]);
  });

  it("does not confuse payroll adjustment with the general adjustment form", () => {
    const index = buildTaxPageIndex([{ page: 1, text: "A105050 职工薪酬支出及纳税调整明细表\n行次 项目\n1 工资薪金 100 100" }], "企业所得税.pdf");
    expect(index.forms.map((form) => form.key)).toEqual(["A105050"]);
    expect(selectedTaxPages(index, ["A105000"])).toEqual([]);
  });

  it("recognizes VAT main sheet, all five appendices, and deduction sheet", () => {
    const titles = ["增值税及附加税费申报表（一般纳税人适用）", ...["一", "二", "三", "四", "五"].map((n) => `增值税及附加税费申报表附列资料（${n}）`), "增值税减免税申报明细表"];
    const index = buildTaxPageIndex(titles.map((title, i) => ({ page: i + 1, text: `${title}\n行次 项目 金额\n1 本期发生额 100.00` })), "增值税.pdf");
    expect(index.taxType).toBe("vat");
    expect(index.forms).toHaveLength(7);
    expect(new Set(index.forms.map((form) => form.key)).size).toBe(7);
  });

  it("keeps unknown scanned pages available for manual selection", () => {
    const index = buildTaxPageIndex([{ page: 1, text: "", source: "text" }, { page: 2, text: "A106000 企业所得税弥补亏损明细表", source: "header_ocr" }], "扫描.pdf");
    expect(index.pages[0].kind).toBe("unknown");
    expect(index.pages[1].source).toBe("header_ocr");
  });

  it("reads a VAT company name wrapped across lines and its tax time instead of filing date", () => {
    const index = buildTaxPageIndex([{ page: 1, text: "增值税及附加税费申报表\n税款所属时间：自 2026年 04月 01日 至 2026年 04月 30日 填表日期: 2026年 05月 15日 金额单位：元\n纳税人名称 测试医学检验所有限\n公司\n法定代表人\n姓名 测试人" }], "增值税.pdf");
    expect(index.companyName).toBe("测试医学检验所有限公司");
    expect(index.period).toBe("自 2026年 04月 01日 至 2026年 04月 30日");
  });

  it("skips unpopulated period labels rather than treating metadata labels as a date", () => {
    const index = buildTaxPageIndex([{ page: 1, text: "所属期（年度）入库编号1 210-2入库时间1" }, { page: 2, text: "企业所得税\n税款所属期间：2025-01-01 至 2025-12-31\n纳税人名称：测试有限公司" }], "所得税.pdf");
    expect(index.period).toBe("2025-01-01 至 2025-12-31");
  });

  it("requires manual confirmation when the same form is repeated after other forms", () => {
    const index = buildTaxPageIndex([{ page: 1, text: adjustment }, { page: 2, text: "A106000 企业所得税弥补亏损明细表" }, { page: 3, text: adjustment }], "多份申报.pdf");
    expect(index.forms.find((form) => form.key === "A105000")?.pages).toEqual([1, 3]);
    expect(index.pages.filter((page) => page.formKey === "A105000").every((page) => page.confidence === "low" && page.reason?.includes("重复"))).toBe(true);
  });

  it("does not identify a referenced code in the main table as its own form", () => {
    const index = buildTaxPageIndex([{ page: 1, text: "企业所得税年度纳税申报主表\n行次 项目 金额\n20 加：纳税调整增加额（填写A105000） 100.00" }], "所得税.pdf");
    expect(index.forms[0].key).toBe("A100000");
  });

  it("keeps the final total-only page of a depreciation schedule with wrapped last rows", () => {
    const index = buildTaxPageIndex([{ page: 15, text: "A105080 资产折旧、摊销及纳税调整明细表\n27 六、油气开发投资 0.00 0.00\n28 享受资产加速折旧\n（一）加速折旧（摊销） 0.00 0.00\n29 （二）一次性扣除\n（摊销） 0.00 0.00" }, { page: 16, text: "的部分\n30 合计 923,048,091.02 13,695,404.94 160,530,430.59\n附列资料 全民所有制企业公司制改制\n资产评估增值政策资产 0.00 0.00" }], "所得税.pdf");
    expect(index.forms[0].pages).toEqual([15, 16]);
  });

  it("labels the signed annual declaration cover separately from its data main table", () => {
    const index = buildTaxPageIndex([{ page: 1, text: "中华人民共和国企业所得税年度纳税申报表（A类）\n税款所属期间：2025-01-01 至2025-12-31\n谨声明：本纳税申报表是真实的、可靠的、完整的。\n纳税人（签章）：" }], "申报.pdf");
    expect(index.pages[0].kind).toBe("cover");
    expect(index.forms).toEqual([]);
  });

  it("recognizes the unnumbered annual A-class main form with a printed version year", () => {
    const index = buildTaxPageIndex([{ page: 13, text: "中华人民共和国企业所得税年度纳税申报表（A类 2017版）\n纳税人名称：测试有限公司\n行次类别项目金额\n1 一、营业收入（填写A101010） 0.00" }], "审计报告及税表.pdf");
    expect(index.forms[0]?.key).toBe("A100000");
  });

  it("does not treat decimal fragments on the total-only continuation as new row numbers", () => {
    const index = buildTaxPageIndex([{ page: 15, text: "A105080 资产折旧、摊销及纳税调整明细表\n28 （一）加速折旧 0.00 0.00\n29 （二）一次性扣除\n（摊销） 0.00 0.00" }, { page: 16, text: "般折旧（摊销）额\n的部分\n30 合计 1,234,567,890.\n37 12,345,678.90 1,234,567,890.\n67\n1,234,567,890\n.67\n附列资料全民所有制企业公司制改制\n资产评估增值政策资产 0.00 0.00 0.00" }], "企业所得税.pdf");
    expect(index.forms[0].pages).toEqual([15, 16]);
  });

  it("uses a following text label to distinguish standalone row indices from number fragments", () => {
    const index = buildTaxPageIndex([{ page: 20, text: "A107011 符合条件的居民企业之间的股息、红利等权益性投资收益优惠明细表\n15\n测试甲有限公司\n直接投资 100,000.00 20,000.00\n16\n测试乙有限公司\n直接投资 200,000.00 30,000.00" }, { page: 21, text: "17\n测试丙有限公司\n直接投资 300,000.00 40,000.00\n18\n测试丁有限公司\n直接投资 400,000.00 50,000.00" }], "企业所得税.pdf");
    expect(index.forms[0].pages).toEqual([20, 21]);
  });
});

describe("tax extraction selection and structured grid", () => {
  it("parses exact manual PDF page ranges and rejects invalid input", () => {
    expect(parseTaxPageSelection("2,4-6，8、8", 10)).toEqual([2, 4, 5, 6, 8]);
    for (const invalid of ["0", "11", "6-4", "1abc", "1.5", "1-", "1,,2"]) expect(() => parseTaxPageSelection(invalid, 10)).toThrow();
  });

  const valid = () => ({ companyName: "测试有限公司", period: "2024年度", tables: [{ formKey: "A105000", formCode: "A105000", formName: "纳税调整项目明细表", pages: [8, 9], rows: [["项目", "金额", null], ["零", 0, "*"], ["空白", null, "-1.00"]], merges: [{ firstRow: 0, lastRow: 0, firstCol: 1, lastCol: 2 }] }] });

  it("preserves null, zero, masks and negative amounts and accepts a single fenced JSON object", () => {
    const response = validateTaxGridResponse(`\`\`\`json\n${JSON.stringify(valid())}\n\`\`\``, { companyName: "测试有限公司", formKeys: ["A105000"] });
    expect(response.tables[0].rows[1]).toEqual(["零", 0, "*"]);
    expect(response.tables[0].merges).toHaveLength(1);
  });
  it("合并冲突报告原表范围与具体格值，禁止静默清空金额", () => {
    const response=valid();
    response.tables[0].rows[0][2]="独立金额";
    expect(()=>validateTaxGridResponse(JSON.stringify(response))).toThrow(/A105000.*B1:C1.*C1="独立金额"/);
  });

  it("保留不同列数的独立分区并校验兼容投影，不能静默忽略分区或覆盖金额",()=>{
    const table={formKey:"vat_appendix_2",formCode:"VAT_APPENDIX_2",formName:"附列资料二",pages:[3],rows:[["甲",null],["乙","0.00"]],merges:[],sections:[{page:3,tableIndex:1,rows:[["甲"]],merges:[]},{page:3,tableIndex:2,rows:[["乙","0.00"]],merges:[]}]};
    const input={companyName:"测试有限公司",period:"2026-04",tables:[table]};
    expect(validateTaxGridResponse(JSON.stringify(input)).tables[0]).toHaveProperty("sections",table.sections);
    for(const change of [
      (v:any)=>{v.tables[0].sections[1].page=4;},
      (v:any)=>{v.tables[0].sections[1].tableIndex=1;},
      (v:any)=>{v.tables[0].sections[1].rows[0][1]="999.00";},
      (v:any)=>{v.tables[0].sections[1].merges=[{firstRow:0,lastRow:0,firstCol:0,lastCol:1}];},
    ]){const next=structuredClone(input);change(next);expect(()=>validateTaxGridResponse(JSON.stringify(next))).toThrow();}
  });

  it("有独立分区时原页说明必须包含在可导出的分区中",()=>{
    const table={formKey:"vat_appendix_2",formCode:"VAT_APPENDIX_2",formName:"附列资料二",pages:[3],rows:[["甲",null],["乙","0.00"]],merges:[],notes:["金额单位：元"],sections:[{page:3,tableIndex:1,rows:[["甲"]],merges:[],notes:[] as string[]},{page:3,tableIndex:2,rows:[["乙","0.00"]],merges:[],notes:[] as string[]}]};
    const input={companyName:"测试有限公司",period:"2026-04",tables:[table]};
    expect(()=>validateTaxGridResponse(JSON.stringify(input))).toThrow(/说明/);
    table.sections[1].notes=["金额单位：元"];
    expect(validateTaxGridResponse(JSON.stringify(input)).tables[0].notes).toEqual(table.notes);
  });

  it("rejects empty, truncated, ragged, overlapping and out of bounds results", () => {
    for (const raw of ["", "{}", JSON.stringify(valid()).slice(0, -3), `说明\n${JSON.stringify(valid())}`]) expect(() => validateTaxGridResponse(raw)).toThrow();
    const empty = valid(); empty.tables[0].rows = []; expect(() => validateTaxGridResponse(JSON.stringify(empty))).toThrow();
    const ragged = valid(); ragged.tables[0].rows[1].pop(); expect(() => validateTaxGridResponse(JSON.stringify(ragged))).toThrow();
    const outside = valid(); outside.tables[0].merges[0].lastCol = 3; expect(() => validateTaxGridResponse(JSON.stringify(outside))).toThrow();
    const overlap = valid(); overlap.tables[0].merges.push({ firstRow: 0, lastRow: 1, firstCol: 2, lastCol: 2 }); expect(() => validateTaxGridResponse(JSON.stringify(overlap))).toThrow();
    expect(() => validateTaxGridResponse(JSON.stringify(valid()), { formKeys: ["A106000"] })).toThrow();
    expect(() => validateTaxGridResponse(JSON.stringify(valid()), { companyName: "另一家公司" })).toThrow();
  });

  it("instructs the model to retain original grid and contains only selected source pages", () => {
    const index = buildTaxPageIndex([{ page: 8, text: adjustment }], "申报.pdf");
    const prompt = buildTaxExtractionPrompt({ companyName: index.companyName, period: index.period, forms: index.forms, pages: [{ page: 8, text: adjustment }] });
    expect(prompt).toContain("多级表头");
    expect(prompt).toContain("PDF第8页");
    expect(prompt).toContain("firstRow");
    expect(prompt).toContain("不得把空白补成0");
    expect(prompt).toContain("跨页表头全部保留");
    expect(prompt).not.toContain("表头只保留一次");
  });
});
