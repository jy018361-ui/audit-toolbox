// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudiPickTaxWorkflow } from "./AudiPickTaxWorkflow";
import type { TaxDocumentIndex } from "./audipickTax";
import { TAX_PAGE_READER_VERSION } from "./audipickTaxPipeline";
import { getAudiPickOperations, dismissFinishedAudiPickOperations } from "./audipickOperation";

const mocks=vi.hoisted(()=>({engineCall:vi.fn(),pickPath:vi.fn(),recognize:vi.fn(),extract:vi.fn()}));
vi.mock("./api",()=>({engineCall:mocks.engineCall,pickPath:mocks.pickPath,jobCancel:vi.fn(async()=>{}),jobPause:vi.fn(async()=>{})}));
vi.mock("./audipickExtractJob",()=>({runAudiPickExtractJob:mocks.extract}));
vi.mock("./audipickPdfPreparation",async()=>({...await vi.importActual("./audipickPdfPreparation"),recognizePdfPage:mocks.recognize}));
const form={key:"A105000",formCode:"A105000",formName:"纳税调整项目明细表",taxType:"corporate_income" as const,pages:[7]};
const other={key:"A106000",formCode:"A106000",formName:"企业所得税弥补亏损明细表",taxType:"corporate_income" as const,pages:[9]};
function index(companyName:string,pages:number[]=[7]):TaxDocumentIndex {
  return {fileName:`${companyName}.pdf`,companyName,period:"2025年度",taxType:"corporate_income",pages:Array.from({length:10},(_,i)=>({page:i+1,text:"",source:"text",kind:"unknown",taxType:"unknown",confidence:"low"})),forms:[{...form,pages},other]};
}
function pdf() {return {numPages:10,destroy:vi.fn(async()=>{}),getPage:vi.fn(async()=>({getViewport:()=>({width:800,height:1000}),getTextContent:async()=>({items:[]}),render:()=>({promise:Promise.resolve(),cancel:vi.fn()}),cleanup:vi.fn()}))};}
beforeEach(()=>{
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype,"toDataURL").mockReturnValue("data:image/jpeg;base64,dGVzdA==");
  mocks.recognize.mockResolvedValue("| 行次 | 项目 | 账载金额 | 税收金额 |\n| 1 | 收入 | 0 | * |");
  mocks.pickPath.mockResolvedValue("D:/纳税表.xlsx");
  mocks.engineCall.mockResolvedValue({});
});
afterEach(()=>{cleanup();dismissFinishedAudiPickOperations();vi.restoreAllMocks();});
describe("税表工作流交互",()=>{
  it("百度表格V2契约HTML在无文字层扫描件中保留原值、合并、空格和表外说明并直接导出",async()=>{
    // Contract shared with baidu_table_ocr.rs:
    // baidu_table_preserves_merged_cells_empty_cells_and_numeric_strings.
    const html='<p>测试税表 &amp; 金额单位：元</p><table><tr><td rowspan="2">项目</td><td>本期金额</td></tr><tr><td>销售额</td></tr><tr><td>000123</td><td>-12.50</td></tr><tr><td></td><td>*</td></tr><tr><td>13%</td><td>0.00</td></tr></table><p>原页说明<br>续行</p>';
    const rows=[["项目","本期金额"],[null,"销售额"],["000123","-12.50"],[null,"*"],["13%","0.00"]];
    const merges=[{firstRow:0,lastRow:1,firstCol:0,lastCol:0}];
    const notes=["测试税表 & 金额单位：元","原页说明\n续行"];
    mocks.recognize.mockResolvedValue(html);
    const save=vi.fn(async()=>{}),instance=pdf();
    const view=render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:index("甲公司")}} initialSelectedFormKeys={[form.key]} loadPdf={async()=>instance} onSave={save} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 1 张表"));
    expect(instance.getPage).toHaveBeenCalledWith(7);
    expect(mocks.recognize).toHaveBeenCalledTimes(1);
    expect(mocks.recognize).toHaveBeenCalledWith(expect.objectContaining({documentId:"a",page:7,taxTable:true}),expect.anything());
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({pageTexts:{a:{7:html}},tables:[expect.objectContaining({rows,merges,notes})]}));
    const previewRows=view.container.querySelectorAll(".tax-grid-scroll tr");
    expect(Array.from(previewRows[3].querySelectorAll("td")).map(cell=>cell.textContent)).toEqual(["","*"]);
    expect(previewRows[0].querySelector("td")).toHaveAttribute("rowspan","2");
    fireEvent.click(screen.getByRole("button",{name:"3. 导出 Excel"}));
    await waitFor(()=>expect(mocks.engineCall).toHaveBeenCalledWith("audipick.tax_export",expect.objectContaining({tables:[expect.objectContaining({companyName:"甲公司",pages:[7],sourceFile:"甲公司.pdf",rows,merges,notes})]})));
  });
  it("HTML视觉OCR在PDF定位可用时不追加内部坐标，也不污染原页说明",async()=>{
    const html='<p>金额单位：元</p><table><tr><td>项目</td><td>123.45</td></tr></table><p>原页注释</p>';
    mocks.recognize.mockResolvedValue(html);
    const page={getViewport:()=>({width:800,height:1000,transform:[1,0,0,-1,0,1000]}),
      getTextContent:async()=>({items:Array.from({length:4},(_,i)=>({str:`纳税原文${i}与说明文字`.repeat(4),transform:[10,0,0,10,i%2*200,100+Math.floor(i/2)*30],width:100,height:10,hasEOL:true}))}),
      render:()=>({promise:Promise.resolve()}),cleanup:vi.fn()};
    const save=vi.fn(async()=>{});
    render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:index("甲公司")}} initialSelectedFormKeys={[form.key]} loadPdf={async()=>({numPages:10,getPage:async()=>page,destroy:async()=>{}})} onSave={save} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 1 张表"));
    expect(mocks.recognize).toHaveBeenCalledTimes(1);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({pageTexts:{a:{7:html}},tables:[expect.objectContaining({notes:["金额单位：元","原页注释"]})]}));
  });
  it("重新打开后保留新版页缓存版本，成功缓存不重复读取或OCR",async()=>{
    const loadPdf=vi.fn(async()=>pdf()),save=vi.fn(async()=>{});
    render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:index("甲公司")}} initialPageTexts={{a:{7:'<table><tr><td>行次</td><td>金额</td></tr><tr><td>1</td><td>0.00</td></tr></table>'}}} initialPageTextVersions={{a:{7:TAX_PAGE_READER_VERSION}}} initialSelectedFormKeys={[form.key]} loadPdf={loadPdf} onSave={save} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 1 张表"));
    expect(loadPdf).not.toHaveBeenCalled();expect(mocks.recognize).not.toHaveBeenCalled();expect(mocks.extract).not.toHaveBeenCalled();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({pageTextVersions:{a:{7:TAX_PAGE_READER_VERSION}}}));
  });
  it("同页异宽表块按各自列数预览并完整传给导出",async()=>{
    const ownIndex=index("甲公司");
    const sections=[{page:7,tableIndex:1,rows:[["项目","金额"]],merges:[]},{page:7,tableIndex:2,rows:[["行次","类别","123.45"]],merges:[]}];
    const table={...form,formKey:form.key,documentId:"a",sourceFile:"甲公司.pdf",companyName:"甲公司",period:"2025年度",rows:[["项目","金额",null],["行次","类别","123.45"]],merges:[],sections,extractionKey:JSON.stringify({companyName:"甲公司",period:"2025年度",form})};
    const view=render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:ownIndex}} initialTables={[table]} initialSelectedFormKeys={[form.key]} loadPdf={async()=>pdf()} onSave={async()=>{}} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:`甲公司 · ${form.formName}`}));
    expect(Array.from(view.container.querySelectorAll(".tax-grid-scroll tr")).map(row=>row.querySelectorAll("td").length)).toEqual([2,3]);
    expect(screen.getByText("PDF 第 7 页 · 第 2 张表")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"3. 导出 Excel"}));
    await waitFor(()=>expect(mocks.engineCall).toHaveBeenCalledWith("audipick.tax_export",expect.objectContaining({tables:[expect.objectContaining({companyName:"甲公司",sections})]})));
  });
  it.each([["mixed",true],["llm",false]] as const)("跨页混合结构结果恢复后可导出，未验证的旧模型结果不可导出：%s",async(source,allowed)=>{
    const ownForm={...form,pages:[7,8]},ownIndex=index("甲公司",[7,8]);
    const table={...ownForm,formKey:form.key,documentId:"a",sourceFile:"甲公司.pdf",companyName:"甲公司",period:"2025年度",rows:[["行次","金额"],["1","0.00"]],merges:[],extractionKey:JSON.stringify({companyName:"甲公司",period:"2025年度",form:ownForm})};
    render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:ownIndex}} initialTables={[table]} initialPageTexts={{a:{7:"|行次|金额|\n|1|0.00|",8:"<table><tr><td>续页</td><td>*</td></tr></table>"}}} initialDiagnostics={{a:{A105000:{source,pages:[7,8],attempts:[]}}}} initialSelectedFormKeys={[form.key]} loadPdf={async()=>pdf()} onSave={async()=>{}} onClose={vi.fn()}/>);
    const button=screen.getByRole("button",{name:"3. 导出 Excel"});
    if(allowed){
      expect(button).toBeEnabled();fireEvent.click(button);
      await waitFor(()=>expect(mocks.engineCall).toHaveBeenCalledWith("audipick.tax_export",expect.objectContaining({tables:[table]})));
    }else expect(button).toBeDisabled();
    expect(mocks.recognize).not.toHaveBeenCalled();expect(mocks.extract).not.toHaveBeenCalled();
  });
  it("结构OCR直接形成带合并的原表，并显示保存的原始记录，不调用二次提取模型",async()=>{
    mocks.recognize.mockResolvedValue('<table><tr><th colspan="2">金额</th><th rowspan="2">结转</th></tr><tr><th>境内</th><th>境外</th></tr><tr><td>0.00</td><td>*</td><td>-12.50</td></tr></table>');
    const save=vi.fn(async()=>{});
    render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:index("甲公司")}} initialSelectedFormKeys={[form.key]} loadPdf={async()=>pdf()} onSave={save} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 1 张表"));
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(screen.getByText("原始识别与校验记录",{exact:false})).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"3. 导出 Excel"}));
    await waitFor(()=>expect(mocks.engineCall).toHaveBeenCalledWith("audipick.tax_export",expect.objectContaining({tables:[expect.objectContaining({rows:[["金额",null,"结转"],["境内","境外",null],["0.00","*","-12.50"]],merges:[{firstRow:0,lastRow:0,firstCol:0,lastCol:1},{firstRow:0,lastRow:1,firstCol:2,lastCol:2}]})]})));
  });
  it("等待选表后才完整OCR；批量同名表按各自页码提取，单文件失败不阻断",async()=>{
    const a=index("甲公司",[7]),b=index("乙公司",[8]);
    const loadPdf=vi.fn(async()=>pdf());
    const save=vi.fn(async()=>{});
    mocks.extract.mockImplementation(async(params:{documentId:string;prompt:string})=>{
      if(params.documentId==="a") throw new Error("甲文件服务暂不可用");
      return {parsed:{companyName:"乙公司",period:"2025年度",tables:[{...form,formKey:form.key,pages:[8],rows:[["行次","项目","账载金额","税收金额"],["1","收入","0","*"]],merges:[]}]}};
    });
    render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"},{id:"b",name:"乙公司.pdf"}]} initialIndexes={{a,b}} loadPdf={loadPdf} onSave={save} onClose={vi.fn()}/>);
    expect(mocks.recognize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox",{name:/纳税调整项目明细表/}));
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 1 张表，1 项失败"));
    expect(mocks.recognize.mock.calls.map(call=>[call[0].documentId,call[0].page,call[0].taxTable])).toEqual([["a",7,true],["b",8,true]]);
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent("甲文件服务暂不可用");
    expect(getAudiPickOperations().at(-1)).toMatchObject({status:"failed",message:expect.stringContaining("甲公司.pdf · 纳税调整项目明细表：甲文件服务暂不可用")});
    fireEvent.click(screen.getByRole("button",{name:"3. 导出 Excel"}));
    await waitFor(()=>expect(mocks.engineCall).toHaveBeenCalledWith("audipick.tax_export",expect.objectContaining({tables:[expect.objectContaining({companyName:"乙公司",pages:[8],sourceFile:"乙公司.pdf"})]})));
    fireEvent.click(screen.getByRole("button",{name:"乙公司.pdf 第 8 页 预览并确认"}));
    const dialog=within(screen.getByRole("dialog",{name:"税表人工复核"}));
    fireEvent.change(dialog.getByLabelText("表单类型"),{target:{value:form.key}});
    fireEvent.change(dialog.getByLabelText("PDF 页码（含续页）"),{target:{value:"6"}});
    fireEvent.click(dialog.getByRole("button",{name:"确认并保存"}));
    await waitFor(()=>expect(screen.getByRole("button",{name:"3. 导出 Excel"})).toBeDisabled());
  });
  it.each([
    ["缺少目录", "请先完成目录预检。"],
    ["税种未知", "税种待确认"],
    ["没有确认页码", "纳税调整项目明细表：未找到可提取的已确认页码"],
  ])("后台失败详情包含文件和前置校验原因：%s",async(scenario,reason)=>{
    const value=index("甲公司");
    if(scenario==="税种未知") value.taxType="unknown";
    if(scenario==="没有确认页码") value.forms=[];
    render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={scenario==="缺少目录"?{}:{a:value}} initialSelectedFormKeys={[form.key]} loadPdf={async()=>pdf()} onSave={async()=>{}} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 0 张表，1 项失败"));
    const operation=getAudiPickOperations().at(-1)!;
    expect(operation.status).toBe("failed");
    expect(operation.message).toContain("甲公司.pdf");
    expect(operation.message).toContain(reason);
    expect(screen.getByRole("alert")).toHaveTextContent(reason);
    expect(mocks.recognize).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });
  it("公司名、页码按文件保存，两个表单页码相互独立",async()=>{
    const save=vi.fn(async()=>{});
    render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:index("甲公司")}} loadPdf={async()=>pdf()} onSave={save} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("checkbox",{name:/纳税调整项目明细表/}));
    fireEvent.click(screen.getByRole("checkbox",{name:/^企业所得税弥补亏损明细表/}));
    fireEvent.change(screen.getByRole("textbox",{name:"甲公司.pdf 公司名称"}),{target:{value:"甲公司全称"}});
    fireEvent.click(screen.getByRole("button",{name:"甲公司.pdf 第 7 页 预览并确认"}));
    let dialog=within(screen.getByRole("dialog",{name:"税表人工复核"}));
    fireEvent.change(dialog.getByLabelText("表单类型"),{target:{value:form.key}});
    fireEvent.change(dialog.getByLabelText("PDF 页码（含续页）"),{target:{value:"6-7"}});
    fireEvent.click(dialog.getByRole("button",{name:"确认并保存"}));
    await waitFor(()=>expect(screen.queryByRole("dialog",{name:"税表人工复核"})).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button",{name:"甲公司.pdf 第 9 页 预览并确认"}));
    dialog=within(screen.getByRole("dialog",{name:"税表人工复核"}));
    expect(dialog.getByLabelText("PDF 页码（含续页）")).toHaveValue("9");
    fireEvent.change(dialog.getByLabelText("表单类型"),{target:{value:other.key}});
    fireEvent.click(dialog.getByRole("button",{name:"确认并保存"}));
    await waitFor(()=>expect(save).toHaveBeenLastCalledWith(expect.objectContaining({indexes:{a:expect.objectContaining({companyName:"甲公司全称"})},reviews:{a:[expect.objectContaining({formKey:form.key,pages:[6,7],companyName:"甲公司全称"}),expect.objectContaining({formKey:other.key,pages:[9]})]}})));
  });
  it("扫描OCR未提供行列边界时拒绝交给模型猜测网格",async()=>{
    mocks.recognize.mockResolvedValue("行次项目金额一二三四五六七");
    render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:index("甲公司")}} initialSelectedFormKeys={[form.key]} loadPdf={async()=>pdf()} onSave={async()=>{}} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("未保留表格结构或坐标"));
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(screen.getByRole("button",{name:"3. 导出 Excel"})).toBeDisabled();
  });
  it("原页预览无需父级回调，关闭后销毁PDF实例",async()=>{
    const instance=pdf(),loadPdf=vi.fn(async()=>instance);
    render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:index("甲公司")}} initialSelectedFormKeys={[form.key]} loadPdf={loadPdf} onSave={async()=>{}} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"7"}));
    await waitFor(()=>expect(instance.getPage).toHaveBeenCalledWith(7));
    expect(screen.getByRole("dialog",{name:"税表 PDF 原页预览"})).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"关闭原页预览"}));
    await waitFor(()=>expect(instance.destroy).toHaveBeenCalledTimes(1));
  });
  it("运行按钮阻止重复启动，卸载后停止后续模型请求和结果保存",async()=>{
    let complete:(text:string)=>void=()=>{};
    mocks.recognize.mockImplementation(()=>new Promise<string>(resolve=>{complete=resolve;}));
    const instance=pdf(),save=vi.fn(async()=>{});
    const view=render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:index("甲公司",[7,8])}} initialSelectedFormKeys={[form.key]} loadPdf={async()=>instance} onSave={save} onClose={vi.fn()}/>);
    const button=screen.getByRole("button",{name:"2. 提取所选表单"});
    fireEvent.click(button);fireEvent.click(button);
    await waitFor(()=>expect(mocks.recognize).toHaveBeenCalledTimes(1));
    view.unmount();
    complete("| 行次 | 项目 | 金额 |\n| 1 | 收入 | 0 |");
    await waitFor(()=>expect(instance.destroy).toHaveBeenCalledTimes(1));
    expect(mocks.recognize).toHaveBeenCalledTimes(1);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it("目录没有匹配表单时仍可选标准表并手填页码，未知税种明确待确认",async()=>{
    const value=index("甲公司");value.forms=[];value.taxType="unknown";
    mocks.extract.mockResolvedValue({parsed:{companyName:"甲公司",period:"2025年度",tables:[{...form,formKey:form.key,pages:[6],rows:[["行次","金额"],["1","0"]],merges:[]}]}});
    render(<AudiPickTaxWorkflow documents={[{id:"a",name:"甲公司.pdf"}]} initialIndexes={{a:value}} loadPdf={async()=>pdf()} onSave={async()=>{}} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button",{name:"全部表单库"}));
    fireEvent.click(screen.getByRole("checkbox",{name:/纳税调整项目明细表/}));
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("税种待确认"));
    expect(mocks.recognize).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox",{name:"甲公司.pdf 税种"}),{target:{value:"corporate_income"}});
    fireEvent.click(screen.getByRole("button",{name:"甲公司.pdf 第 6 页 预览并确认"}));
    const dialog=within(screen.getByRole("dialog",{name:"税表人工复核"}));
    fireEvent.change(dialog.getByLabelText("表单类型"),{target:{value:form.key}});
    fireEvent.click(dialog.getByRole("button",{name:"确认并保存"}));
    await waitFor(()=>expect(screen.queryByRole("dialog",{name:"税表人工复核"})).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 1 张表"));
    expect(mocks.recognize.mock.calls[0][0].page).toBe(6);
    expect(screen.getByRole("button",{name:"3. 导出 Excel"})).toBeEnabled();
  });
});
