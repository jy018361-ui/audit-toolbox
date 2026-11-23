// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { inspectTaxDocument, extractTaxForm, resolveTaxForms, taxExtractionKey, taxFormIdentity, taxOcrHasTableStructure, TAX_PAGE_READER_VERSION, type AudiPickTaxWorkflowState } from "./audipickTaxPipeline";
import { buildTaxPageIndex, type TaxDocumentIndex } from "./audipickTax";
import { stampTaxReviewGroup } from "./audipickTaxReview";

const index = (): TaxDocumentIndex => ({ fileName: "甲公司.pdf", companyName: "甲公司", period: "2025年度", taxType: "corporate_income", pages: Array.from({length: 10}, (_, i) => ({page: i+1,text:"",source:"text",kind:"unknown",taxType:"unknown",confidence:"low"})), forms: [{key:"A105000",formCode:"A105000",formName:"纳税调整项目明细表",taxType:"corporate_income",pages:[7,8]}, {key:"A106000",formCode:"A106000",formName:"企业所得税弥补亏损明细表",taxType:"corporate_income",pages:[9]}] });
const state = (): AudiPickTaxWorkflowState => ({indexes:{doc:index()},tables:[],pageTexts:{}});
describe("纳税表按表单选择工作流", () => {
  it("预检中断时保留尚未处理页的已有目录和人工方向", async () => {
    const cached=buildTaxPageIndex([{page:1,text:"",source:"header_ocr"},{page:2,text:"",source:"header_ocr",rotation:270}],"旋转扫描.pdf");
    const onPage=vi.fn(async(_value:TaxDocumentIndex)=>{});
    const recognize=vi.fn().mockResolvedValueOnce("增值税纳税申报表（一般纳税人适用）").mockRejectedValueOnce(new Error("识别中断"));
    const pdf={numPages:2,getPage:async()=>({getTextContent:async()=>({items:[]}),cleanup:vi.fn()})};
    await expect(inspectTaxDocument({pdf,fileName:cached.fileName,cached,recognizeHeader:recognize,onPage})).rejects.toThrow("识别中断");
    expect(onPage.mock.calls.at(-1)![0].pages).toEqual(expect.arrayContaining([expect.objectContaining({page:2,rotation:270})]));
  });
  it("重预检保留人工方向和元数据，但旧单税种缓存不掩盖新的混税识别", async () => {
    const cached=buildTaxPageIndex([{page:1,text:"增值税纳税申报表（一般纳税人适用）",source:"header_ocr",rotation:90},{page:2,text:"A105000 纳税调整项目明细表",source:"header_ocr"}],"混税.pdf");
    cached.companyName="人工完整公司名称";cached.period="人工所属期";cached.taxType="vat";
    const pdf={numPages:2,getPage:vi.fn()};
    const result=await inspectTaxDocument({pdf,fileName:cached.fileName,cached,recognizeHeader:vi.fn(),onPage:vi.fn()});
    expect(result).toMatchObject({taxType:"mixed",companyName:"人工完整公司名称",period:"人工所属期"});
    expect(result.pages[0].rotation).toBe(90);expect(pdf.getPage).not.toHaveBeenCalled();
    const overridden=await inspectTaxDocument({pdf,fileName:cached.fileName,cached:{...cached,taxTypeOverride:"vat"},recognizeHeader:vi.fn(),onPage:vi.fn()});
    expect(overridden).toMatchObject({taxType:"vat",taxTypeOverride:"vat"});
  });
  it("旋转只改变所选受影响页的提取缓存身份", () => {
    const value=index(),form=value.forms[0];
    const changed={...value,pages:value.pages.map(page=>page.page===7?{...page,rotation:90 as const}:page)};
    expect(taxExtractionKey(changed,form)).not.toBe(taxExtractionKey(value,form));
    expect(taxExtractionKey(changed,value.forms[1])).toBe(taxExtractionKey(value,value.forms[1]));
  });
  it("预检只在缺少文字层时调用标题识别，不提前完整 OCR", async () => {
    const header = vi.fn(async (_page:unknown, _number:number) => "A105000 纳税调整项目明细表");
    const pdf = {numPages:2,getPage:vi.fn(async (page:number)=>({getTextContent:async()=>({items:page===1 ? [{str:"纳税人名称：甲公司 企业所得税年度纳税申报表 A100000 "+"内容".repeat(60)}] : []}),cleanup:vi.fn()}))};
    const result = await inspectTaxDocument({pdf,fileName:"甲公司.pdf",recognizeHeader:header,onPage:vi.fn()});
    expect(header).toHaveBeenCalledTimes(1);
    expect(header.mock.calls[0][1]).toBe(2);
    expect(result.pages[1].source).toBe("header_ocr");
  });
  it("每张表独立修正页码，续页一起选择，其他表保持原页码", () => {
    const forms = resolveTaxForms(index(),["A105000","A106000"],{"A105000":"6-7"});
    expect(forms.map(f=>f.pages)).toEqual([[6,7],[9]]);
    expect(()=>resolveTaxForms(index(),["A105000"],{"A105000":"11"})).toThrow();
  });
  it("上传探测缓存的空文字页和失败的空标题缓存会重新识别", async () => {
    const cached=index();cached.pages=cached.pages.slice(0,2);cached.pages[1].source="header_ocr";
    const header=vi.fn(async (_page:unknown,number:number)=>number===1?"A100000 企业所得税年度纳税申报表":"A105000 纳税调整项目明细表");
    const pdf={numPages:2,getPage:async()=>({getTextContent:async()=>({items:[]}),cleanup:vi.fn()})};
    const result=await inspectTaxDocument({pdf,fileName:cached.fileName,cached,recognizeHeader:header,onPage:async()=>{}});
    expect(header).toHaveBeenCalledTimes(2);
    expect(result.forms.some(form=>form.key==="A105000")).toBe(true);
  });
  it("拒绝无结构OCR文本，接受保留列边界的表格", () => {
    expect(taxOcrHasTableStructure("行次 项目 账载金额 税收金额 1 收入 100 0")).toBe(false);
    expect(taxOcrHasTableStructure("| 行次 | 项目 | 金额 |\n| 1 | 收入 | 0 |" )).toBe(true);
  });
  it("重复候选必须明确输入页码确认，不能直接合并多份表单", () => {
    const value=index();value.pages[6]={...value.pages[6],formKey:"A105000",kind:"form",confidence:"low",reason:"重复命中"};
    expect(()=>resolveTaxForms(value,["A105000"])).toThrow(/手动确认/);
    expect(resolveTaxForms(value,["A105000"],{A105000:"7-8"})[0].pages).toEqual([7,8]);
  });
  it("人工确认组隔离同表不同期间，排除组和未分配重复页不会混入提取", () => {
    const value=index();
    value.pages[6]={...value.pages[6],formKey:"A105000",kind:"form",confidence:"low",reason:"重复命中"};
    value.pages[7]={...value.pages[7],formKey:"A105000",kind:"form",confidence:"low",reason:"重复命中"};
    const groups=[
      stampTaxReviewGroup(value,{id:"a105000-2024",formKey:"A105000",companyName:"甲公司",period:"2024年度",pages:[7],status:"confirmed"}),
      stampTaxReviewGroup(value,{id:"a105000-2025",formKey:"A105000",companyName:"甲公司",period:"2025年度",pages:[8],status:"confirmed"}),
      stampTaxReviewGroup(value,{id:"a105000-excluded",formKey:"A105000",companyName:"甲公司",period:"不适用",pages:[6],status:"excluded"}),
    ];
    const forms=resolveTaxForms(value,["A105000"],{},[],groups);
    expect(forms.map(form=>[form.instanceId,form.companyName,form.period,form.pages])).toEqual([
      ["a105000-2024","甲公司","2024年度",[7]],["a105000-2025","甲公司","2025年度",[8]],
    ]);
    expect(forms.every(form=>taxFormIdentity(form)===form.instanceId)).toBe(true);
    expect(taxExtractionKey(value,forms[0])).not.toBe(taxExtractionKey(value,forms[1]));
  });
  it("页面目录改变后过期复核组不授权页码，也不阻断其他已重新确认组", () => {
    const value=index();
    const stale=stampTaxReviewGroup(value,{id:"stale",formKey:"A105000",companyName:"甲公司",period:"2024年度",pages:[7],status:"confirmed"});
    const changed={...value,pages:value.pages.slice(0,6).map(page=>page.page===1?{...page,formKey:"A000000"}:page)};
    const current=stampTaxReviewGroup(changed,{id:"current",formKey:"A105000",companyName:"甲公司",period:"2025年度",pages:[6],status:"confirmed"});
    const forms=resolveTaxForms(changed,["A105000"],{},[],[stale,current]);
    expect(forms.map(form=>[form.instanceId,form.pages])).toEqual([["current",[6]]]);
    expect(resolveTaxForms(changed,["A105000"],{},[],[stale])).toEqual([]);
    const oldOtherKey=stampTaxReviewGroup(value,{id:"old-other-key",formKey:"A106000",companyName:"甲公司",period:"2024年度",pages:[7],status:"confirmed"});
    expect(resolveTaxForms(changed,["A105000"],{},[],[oldOtherKey])[0].pages).toEqual([8]);
  });
  it("任何人工组都占用页码：自动定位过滤他组与排除页，手动覆盖冲突时报错", () => {
    const value=index();
    value.pages[6].confidence="high";
    value.pages[7].confidence="high";
    const reassigned=stampTaxReviewGroup(value,{id:"reassigned",formKey:"A106000",companyName:"甲公司",period:"2024年度",pages:[7],status:"confirmed"});
    const excluded=stampTaxReviewGroup(value,{id:"excluded",formKey:"",companyName:"",period:"",pages:[8],status:"excluded"});
    expect(resolveTaxForms(value,["A105000"],{},[],[reassigned])[0].pages).toEqual([8]);
    expect(resolveTaxForms(value,["A105000"],{},[],[reassigned,excluded])).toEqual([]);
    expect(()=>resolveTaxForms(value,["A105000"],{A105000:"7"},[],[reassigned])).toThrow(/页码与其他人工复核组冲突/);
  });
  it("同一文件同表的两个复核组各自缓存结果和诊断，不互相覆盖", async () => {
    let latest=state();
    const formA={...latest.indexes.doc.forms[0],pages:[7],instanceId:"a105000-2024",companyName:"甲公司",period:"2024年度"};
    const formB={...latest.indexes.doc.forms[0],pages:[8],instanceId:"a105000-2025",companyName:"甲公司",period:"2025年度"};
    latest.pageTexts={doc:{7:'<table><tr><td>2024</td><td>金额</td></tr></table>',8:'<table><tr><td>2025</td><td>金额</td></tr></table>'}};
    latest.pageTextVersions={doc:{7:TAX_PAGE_READER_VERSION,8:TAX_PAGE_READER_VERSION}};
    const save=async(next:AudiPickTaxWorkflowState)=>{latest=next;};
    const options={documentId:"doc",index:latest.indexes.doc,getState:()=>latest,save,readFullPage:async()=>"",extract:vi.fn()};
    const first=await extractTaxForm({...options,form:formA});
    const second=await extractTaxForm({...options,form:formB});
    expect(first).toMatchObject({instanceId:"a105000-2024",period:"2024年度",rows:[["2024","金额"]]});
    expect(second).toMatchObject({instanceId:"a105000-2025",period:"2025年度",rows:[["2025","金额"]]});
    expect(latest.tables.map(table=>table.instanceId)).toEqual(["a105000-2024","a105000-2025"]);
    expect(Object.keys(latest.diagnostics?.doc??{})).toEqual(["a105000-2024","a105000-2025"]);
  });
  it("只对所选表页做完整 OCR，逐页保存并将结果与公司名绑定", async () => {
    let latest=state(); const save=vi.fn(async (next:AudiPickTaxWorkflowState)=>{latest=next;});
    const read=vi.fn(async (page:number)=>`第${page}页 | 行次 | 账载金额 | 税收金额 |`);
    const model=vi.fn(async (prompt:string)=>{
      const page=prompt.includes('"pages":[7]')?7:8;
      expect(prompt).not.toContain(`---PDF第${page===7?8:7}页---`);
      return {parsed:{companyName:"甲公司",period:"2025年度",tables:[{formKey:"A105000",formCode:"A105000",formName:"纳税调整项目明细表",pages:[page],rows:page===7?[["行次","账载金额","税收金额"]]:[[1,"0",null]],merges:[]}]}};
    });
    const result=await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save,readFullPage:read,extract:model});
    expect(read.mock.calls.map(c=>c[0])).toEqual([7,8]);
    expect(save).toHaveBeenCalledTimes(5);
    expect(save.mock.calls[2][0].diagnostics?.doc.A105000.source).toBe("llm");
    expect(save.mock.calls[2][0].tables).toHaveLength(0);
    expect(model.mock.calls[0][0]).toContain("第7页");
    expect(model.mock.calls[0][0]).not.toContain("第9页");
    expect(result.companyName).toBe("甲公司");
    expect(latest.tables[0].pages).toEqual([7,8]);
    expect(latest.tables[0].rows[1]).toEqual([1,"0",null]);
    await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save,readFullPage:read,extract:model});
    expect(read).toHaveBeenCalledTimes(2);
    expect(model).toHaveBeenCalledTimes(2);
  });
  it("拒绝模型输出不在所选范围内的页码，失败不写入结果", async () => {
    let latest=state(); const save=async(next:AudiPickTaxWorkflowState)=>{latest=next;};
    await expect(extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save,readFullPage:async()=>"表格",extract:async()=>({parsed:{companyName:"甲公司",period:"2025年度",tables:[{formKey:"A105000",formCode:"A105000",formName:"纳税调整项目明细表",pages:[9],rows:[["错误页"]],merges:[]}]}})})).rejects.toThrow(/页码/);
    expect(latest.tables).toHaveLength(0);
  });
  it("HTML表格按rowspan/colspan确定性直通，续页拼接且不调用第二次模型", async () => {
    let latest=state();const save=vi.fn(async(next:AudiPickTaxWorkflowState)=>{latest=next;});
    const first='<table><tr><th rowspan="2">行次</th><th colspan="2">金额</th></tr><tr><th>账载金额</th><th>税收金额</th></tr><tr><td>1</td><td>0</td><td>*</td></tr></table>';
    const second='<table><tr><td>2</td><td>-1.00</td><td></td></tr></table>';
    const extract=vi.fn(async()=>{throw new Error("HTML不应请求模型");});
    const result=await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save,readFullPage:async page=>page===7?first:second,extract});
    expect(extract).not.toHaveBeenCalled();
    expect(result.rows).toEqual([["行次","金额",null],[null,"账载金额","税收金额"],["1","0","*"],["2","-1.00",null]]);
    expect(result.merges).toEqual(expect.arrayContaining([{firstRow:0,lastRow:1,firstCol:0,lastCol:0},{firstRow:0,lastRow:0,firstCol:1,lastCol:2}]));
    expect(result.companyName).toBe("甲公司");
    expect(latest.diagnostics?.doc.A105000.source).toBe("html");
    expect(latest.diagnostics?.doc.A105000.attempts[0].raw).toContain(first);
  });
  it("混合旧缓存先只刷新非HTML页，刷新为HTML后完整直通", async () => {
    let latest=state();
    latest.pageTexts={doc:{7:"旧Markdown\n【PDF文字层定位 tax-display-layout-v2】",8:'<table><tr><td>续页</td><td>0</td></tr></table>'}};
    latest.pageTextVersions={doc:{8:TAX_PAGE_READER_VERSION}};
    const read=vi.fn(async()=>'<table><tr><td>首页</td><td>100</td></tr></table>'),extract=vi.fn();
    const result=await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save:async next=>{latest=next;},readFullPage:read,extract});
    expect(read.mock.calls).toEqual([[7]]);
    expect(extract).not.toHaveBeenCalled();
    expect(result.rows).toEqual([["首页","100"],["续页","0"]]);
    expect(latest.pageTexts.doc[7]).toContain("<table>");
  });
  it("全旧Markdown失败缓存也由新版读取器重读，不再次交整表模型猜测合并", async () => {
    let latest=state();
    latest.pageTexts={doc:{7:"|行次|金额|\n|1|旧金额|",8:"|行次|金额|\n|2|旧金额|"}};
    latest.diagnostics={doc:{A105000:{source:"llm",pages:[7,8],attempts:[{raw:"错误旧网格",error:"A1:A3 覆盖 A2=行次"}]}}};
    const read=vi.fn(async(page:number)=>`<table><tr><td>${page}</td><td>123.45</td></tr></table>`),extract=vi.fn();
    const result=await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save:async next=>{latest=next;},readFullPage:read,extract});
    expect(read.mock.calls).toEqual([[7],[8]]);
    expect(extract).not.toHaveBeenCalled();
    expect(result.rows).toEqual([["7","123.45"],["8","123.45"]]);
    expect(latest.diagnostics?.doc.A105000.attempts[0].raw).toBe("错误旧网格");
  });
  it("增值税与所得税失败的旧HTML缓存均升级读取版本，续页不会留在旧布局", async () => {
    for(const key of ["A105080","VAT_APPENDIX_2"]) {
      let latest=state();
      const form={...latest.indexes.doc.forms[0],key,formCode:key,pages:[7,8]};
      latest.pageTexts={doc:{7:'<table><tr><td>旧识别表头</td></tr></table>',8:'<table><tr><td>旧续页</td></tr></table>'}};
      latest.diagnostics={doc:{[key]:{source:"html",pages:[7,8],attempts:[{raw:"原始失败结构",error:"旧表格无法拼接"}]}}};
      const read=vi.fn(async(page:number)=>`<table><tr><td>页${page}</td><td>-123.45</td></tr></table>`),extract=vi.fn();
      const result=await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form,getState:()=>latest,save:async next=>{latest=next;},readFullPage:read,extract});
      expect(read.mock.calls).toEqual([[7],[8]]);expect(extract).not.toHaveBeenCalled();
      expect(result.rows).toEqual([["页7","-123.45"],["页8","-123.45"]]);
      expect(latest.pageTextVersions?.doc).toEqual({7:TAX_PAGE_READER_VERSION,8:TAX_PAGE_READER_VERSION});
      expect(latest.diagnostics?.doc[key].attempts[0]).toEqual({raw:"原始失败结构",error:"旧表格无法拼接"});
    }
  });
  it("已成功校验的历史非HTML结果保留，不因读取版本升级重复收费或丢失结果", async () => {
    let latest=state();const form=latest.indexes.doc.forms[0];
    const original={...form,formKey:form.key,documentId:"doc",sourceFile:latest.indexes.doc.fileName,companyName:"甲公司",period:"2025年度",rows:[["原表头","金额"],["1","-123.45"]],merges:[],extractionKey:JSON.stringify({companyName:"甲公司",period:"2025年度",form})};
    latest.pageTexts={doc:{7:"|行次|金额|\n|1|-123.45|",8:"|行次|金额|\n|2|0|"}};latest.tables=[original];
    const read=vi.fn(),extract=vi.fn(),save=vi.fn();
    const result=await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form,getState:()=>latest,save,readFullPage:read,extract});
    expect(result).toBe(original);expect(latest.tables).toEqual([original]);
    expect(read).not.toHaveBeenCalled();expect(extract).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
  });
  it("新识别页格式不同仅旧格式单页走严格模型，原生HTML不交模型重猜并保留续页表头", async () => {
    let latest=state();
    const html='<p>单位：元</p><table><tr><td colspan="2">可信首页表头</td></tr><tr><td>1</td><td>100</td></tr></table>';
    const read=vi.fn(async(page:number)=>page===7?html:"|续页表头|金额|\n|2|-1.00|");
    const extract=vi.fn(async(prompt:string)=>{
      expect(prompt).not.toContain(html);expect(prompt).not.toContain("可信首页表头");
      expect(prompt).toContain('"pages":[8]');
      return {companyName:"甲公司",period:"2025年度",tables:[{formKey:"A105000",formCode:"A105000",formName:"纳税调整项目明细表",pages:[8],rows:[["续页表头","金额"],["2","-1.00"]],merges:[],warnings:["金额需复核"],notes:["续页原页说明"]}]};
    });
    const result=await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save:async next=>{latest=next;},readFullPage:read,extract});
    expect(read.mock.calls).toEqual([[7],[8]]);expect(extract).toHaveBeenCalledTimes(1);
    expect(result.rows).toEqual([["可信首页表头",null],["1","100"],["续页表头","金额"],["2","-1.00"]]);
    expect(result.merges).toEqual([{firstRow:0,lastRow:0,firstCol:0,lastCol:1}]);
    expect(result.warnings).toEqual(["PDF 第 8 页：金额需复核"]);
    expect(result.notes).toEqual(["单位：元","续页原页说明"]);
    expect(latest.diagnostics?.doc.A105000.source).toBe("mixed");
    await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save:async next=>{latest=next;},readFullPage:read,extract});
    expect(extract).toHaveBeenCalledTimes(1);
  });
  it("混合格式单页模型返回其他页码时定向重试，失败原文与刷新标记可恢复且不再次刷新", async () => {
    let latest=state();latest.pageTexts={doc:{7:"旧Markdown",8:'<table><tr><td>第二页</td><td>0</td></tr></table>'}};
    latest.pageTextVersions={doc:{8:TAX_PAGE_READER_VERSION}};
    const read=vi.fn(async()=>"|项目|金额|\n|收入|0|");
    const good={companyName:"甲公司",period:"2025年度",tables:[{formKey:"A105000",formCode:"A105000",formName:"纳税调整项目明细表",pages:[7],rows:[["收入","0"]],merges:[]}]};
    const extract=vi.fn(async()=>({...good,tables:[{...good.tables[0],pages:[8]}]}));
    const run=()=>extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save:async next=>{latest=next;},readFullPage:read,extract});
    await expect(run()).rejects.toThrow(/页码/);
    expect(extract).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledTimes(1);
    expect(latest.diagnostics?.doc.A105000.attempts.filter(attempt=>attempt.error)).toHaveLength(2);
    expect(latest.tables).toHaveLength(0);
    extract.mockImplementation(async()=>good);
    const result=await run();
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.rows).toEqual([["收入","0"],["第二页","0"]]);
  });
  it("混合页中HTML损坏仍直接失败，不用模型覆盖原结构", async()=>{
    let latest=state();const extract=vi.fn();
    await expect(extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save:async next=>{latest=next;},readFullPage:async page=>page===7?"|行次|金额|\n|1|0|":'<table><tr><td rowspan="0">坏结构</td></tr></table>',extract})).rejects.toThrow(/rowspan/);
    expect(extract).not.toHaveBeenCalled();expect(latest.tables).toHaveLength(0);
    expect(latest.diagnostics?.doc.A105000.attempts.at(-1)?.error).toContain("rowspan");
  });
  it("混合缓存刷新完成后暂停仍保存新原文，恢复不再次OCR或丢失既有诊断", async()=>{
    let latest=state();latest.pageTexts={doc:{7:"旧原文",8:'<table><tr><td>续页</td><td>0</td></tr></table>'}};
    latest.pageTextVersions={doc:{8:TAX_PAGE_READER_VERSION}};
    latest.diagnostics={doc:{A105000:{source:"html",pages:[7,8],attempts:[{raw:"前次失败原文",error:"旧错误"}]}}};
    const text="|项目|金额|\n|本年|0|",read=vi.fn(async()=>text),extract=vi.fn(async()=>({companyName:"甲公司",period:"2025年度",tables:[{formKey:"A105000",formCode:"A105000",formName:"纳税调整项目明细表",pages:[7],rows:[["本年","0"]],merges:[]}]}));
    const options={documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save:async(next:AudiPickTaxWorkflowState)=>{latest=next;},readFullPage:read,extract};
    await expect(extractTaxForm({...options,checkpoint:async()=>{if(latest.pageTexts.doc[7]===text) throw new Error("暂停");}})).rejects.toThrow("暂停");
    expect(latest.pageTexts.doc[7]).toBe(text);
    expect(latest.diagnostics?.doc.A105000.refreshedPageTexts?.[7]).toBe(text);
    expect(latest.diagnostics?.doc.A105000.attempts).toEqual([{raw:"前次失败原文",error:"旧错误"}]);
    await extractTaxForm(options);
    expect(read).toHaveBeenCalledTimes(1);expect(extract).toHaveBeenCalledTimes(1);
    expect(latest.diagnostics?.doc.A105000.refreshedPageTexts?.[7]).toBe(text);
    expect(latest.diagnostics?.doc.A105000.attempts[0].raw).toBe("前次失败原文");
  });
  it("无效HTML必须保留诊断并明确失败，不回退模型猜结构", async () => {
    for(const text of ['<table><tr><td rowspan="0">非法</td></tr></table>','<table><tr><td>未闭合结构']) {
      let latest=state();const extract=vi.fn();
      const form={...latest.indexes.doc.forms[0],pages:[7]};
      await expect(extractTaxForm({documentId:"doc",index:latest.indexes.doc,form,getState:()=>latest,save:async next=>{latest=next;},readFullPage:async()=>text,extract})).rejects.toThrow();
      expect(extract).not.toHaveBeenCalled();
      expect(latest.diagnostics?.doc.A105000.attempts.at(-1)?.raw).toContain(text);
      expect(latest.diagnostics?.doc.A105000.attempts.at(-1)?.error).toBeTruthy();
      expect(latest.tables).toHaveLength(0);
    }
  });
  it("同页多表和异宽续页保留每块网格，公司与页码绑定且不调用模型", async () => {
    let latest=state();
    const first='<table><tr><td colspan="2">第一块表头</td></tr><tr><td>账载金额</td><td>123.45</td></tr></table><table><tr><td>第二块</td><td>0</td><td>-9.99</td></tr></table>';
    const second='<table><tr><td>续页独立表</td><td>98.76</td><td>0</td><td>*</td></tr></table>';
    const extract=vi.fn();
    const result=await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save:async next=>{latest=next;},readFullPage:async page=>page===7?first:second,extract});
    expect(extract).not.toHaveBeenCalled();
    expect(result.companyName).toBe("甲公司");expect(result.pages).toEqual([7,8]);
    expect(result.sections).toEqual([
      {page:7,tableIndex:1,rows:[["第一块表头",null],["账载金额","123.45"]],merges:[{firstRow:0,lastRow:0,firstCol:0,lastCol:1}]},
      {page:7,tableIndex:2,rows:[["第二块","0","-9.99"]],merges:[]},
      {page:8,tableIndex:1,rows:[["续页独立表","98.76","0","*"]],merges:[]},
    ]);
    expect(result.rows).toEqual([["第一块表头",null,null,null],["账载金额","123.45",null,null],["第二块","0","-9.99",null],["续页独立表","98.76","0","*"]]);
  });
  it("原始content优先于parsed，先保存失败原文并定向修正一次，OCR不重跑", async () => {
    let latest=state();const save=vi.fn(async(next:AudiPickTaxWorkflowState)=>{latest=next;});
    const form={...latest.indexes.doc.forms[0],pages:[7]};
    const good=JSON.stringify({companyName:"甲公司",period:"2025年度",tables:[{formKey:"A105000",formCode:"A105000",formName:"纳税调整项目明细表",pages:[7],rows:[["行次","金额"],["1","0"]],merges:[]}]});
    const raw='{"companyName":"甲公司","tables":[';
    const read=vi.fn(async()=>"|行次|金额|\n|1|0|");
    const extract=vi.fn(async(_prompt:string)=>{
      if(extract.mock.calls.length===1) return {content:raw,parsed:JSON.parse(good)};
      expect(latest.diagnostics?.doc.A105000.attempts[0]).toEqual(expect.objectContaining({raw,error:expect.any(String)}));
      return {content:good};
    });
    await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form,getState:()=>latest,save,readFullPage:read,extract});
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract.mock.calls[1][0]).toContain(raw);
    expect(extract.mock.calls[1][0]).toContain("完整 JSON");
    expect(read).toHaveBeenCalledTimes(1);
    expect(latest.diagnostics?.doc.A105000.attempts).toHaveLength(2);
    expect(latest.diagnostics?.doc.A105000.attempts[1]).toEqual({raw:good});
  });
  it("连续两次不合法时停止，保留两个原始响应与错误，已完成OCR缓存可复用", async () => {
    let latest=state();const read=vi.fn(async()=>"Markdown旧表格");
    const extract=vi.fn(async()=>({raw:'{"tables":['}));
    await expect(extractTaxForm({documentId:"doc",index:latest.indexes.doc,form:latest.indexes.doc.forms[0],getState:()=>latest,save:async next=>{latest=next;},readFullPage:read,extract})).rejects.toThrow(/JSON/);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(latest.diagnostics?.doc.A105000.attempts).toHaveLength(2);
    expect(latest.diagnostics?.doc.A105000.attempts.every(attempt=>Boolean(attempt.error))).toBe(true);
    expect(Object.keys(latest.pageTexts.doc)).toEqual(["7","8"]);
    expect(latest.tables).toHaveLength(0);
  });
  it("旧PDF坐标缓存及由其产生的旧表结果不复用，重新读取所选页", async () => {
    let latest=state();const form=latest.indexes.doc.forms[0];
    latest.pageTexts={doc:{7:"旧OCR\n【PDF文字层定位（单位：PDF点）】旧坐标",8:"旧OCR\n【PDF文字层定位（单位：PDF点）】旧坐标"}};
    latest.tables=[{...form,formKey:form.key,documentId:"doc",sourceFile:latest.indexes.doc.fileName,companyName:"甲公司",period:"2025年度",rows:[["错误旧表"]],merges:[],extractionKey:JSON.stringify({companyName:"甲公司",period:"2025年度",form})}];
    const read=vi.fn(async()=>"<table><tr><td>新识别表格</td></tr></table>");
    const result=await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form,getState:()=>latest,save:async next=>{latest=next;},readFullPage:read,extract:vi.fn()});
    expect(read.mock.calls).toHaveLength(2);
    expect(result.rows).toEqual([["新识别表格"],["新识别表格"]]);
    expect(latest.pageTexts.doc[7]).not.toContain("旧坐标");
  });
  it("已有HTML缓存却仍是旧模型结果时重新确定性解析，不沿用猜测合并", async () => {
    let latest=state();const form={...latest.indexes.doc.forms[0],pages:[7]};
    latest.pageTexts={doc:{7:'<table><tr><td colspan="2">可信原表头</td></tr><tr><td>1</td><td>0</td></tr></table>'}};
    latest.pageTextVersions={doc:{7:TAX_PAGE_READER_VERSION}};
    latest.tables=[{...form,formKey:form.key,documentId:"doc",sourceFile:latest.indexes.doc.fileName,companyName:"甲公司",period:"2025年度",rows:[["旧模型猜测表头"]],merges:[],extractionKey:JSON.stringify({companyName:"甲公司",period:"2025年度",form})}];
    const read=vi.fn(),extract=vi.fn();
    const result=await extractTaxForm({documentId:"doc",index:latest.indexes.doc,form,getState:()=>latest,save:async next=>{latest=next;},readFullPage:read,extract});
    expect(result.rows[0]).toEqual(["可信原表头",null]);
    expect(result.merges).toEqual([{firstRow:0,lastRow:0,firstCol:0,lastCol:1}]);
    expect(read).not.toHaveBeenCalled();expect(extract).not.toHaveBeenCalled();
  });
});
