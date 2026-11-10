// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudiPickTaxWorkflow } from "./AudiPickTaxWorkflow";
import type { TaxDocumentIndex } from "./audipickTax";
import { stampTaxReviewGroup } from "./audipickTaxReview";
import { TAX_PAGE_READER_VERSION, type AudiPickTaxWorkflowState } from "./audipickTaxPipeline";

const mocks=vi.hoisted(()=>({engineCall:vi.fn(),pickPath:vi.fn(),recognize:vi.fn(),extract:vi.fn()}));
vi.mock("./api",()=>({engineCall:mocks.engineCall,pickPath:mocks.pickPath,jobCancel:vi.fn(),jobPause:vi.fn()}));
vi.mock("./audipickExtractJob",()=>({runAudiPickExtractJob:mocks.extract}));
vi.mock("./audipickPdfPreparation",async()=>({...await vi.importActual("./audipickPdfPreparation"),recognizePdfPage:mocks.recognize}));
const forms=[{key:"vat_main",formCode:"VAT_MAIN",formName:"增值税及附加税费申报表（一般纳税人适用）",taxType:"vat" as const,pages:[1]},
  {key:"A105000",formCode:"A105000",formName:"纳税调整项目明细表",taxType:"corporate_income" as const,pages:[2]}];
function mixedIndex():TaxDocumentIndex {
  return {fileName:"混合税表.pdf",companyName:"测试企业",period:"2020年5月",taxType:"mixed" as TaxDocumentIndex["taxType"],forms,
    pages:forms.map((form,i)=>({page:i+1,text:form.formName,source:"text",kind:"form",formKey:form.key,formName:form.formName,taxType:form.taxType,confidence:"high"}))};
}
function props() {
  const page={rotate:0,getViewport:vi.fn(({rotation=0}:{rotation?:number})=>({width:rotation%180?1000:800,height:rotation%180?800:1000})),getTextContent:async()=>({items:[]}),render:()=>({promise:Promise.resolve(),cancel:vi.fn()}),cleanup:vi.fn()};
  return {documents:[{id:"m",name:"混合税表.pdf"}],initialIndexes:{m:mixedIndex()},onSave:vi.fn(async(_state:AudiPickTaxWorkflowState)=>{}),onClose:vi.fn(),loadPdf:vi.fn(async()=>({numPages:2,getPage:vi.fn(async()=>page),destroy:vi.fn()})),page};
}
beforeEach(()=>{vi.clearAllMocks();vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({} as CanvasRenderingContext2D);vi.spyOn(HTMLCanvasElement.prototype,"toDataURL").mockReturnValue("data:image/jpeg;base64,dGVzdA==");});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

it("混合税种文件分别提取已选表，按税种过滤时只提取该税种",async()=>{
  const own=props(),read=vi.fn();
  own.loadPdf.mockImplementation(async()=>{read();return {numPages:2,getPage:vi.fn(async()=>own.page),destroy:vi.fn()};});
  render(<AudiPickTaxWorkflow {...own} initialSelectedFormKeys={forms.map(form=>form.key)} initialPageTexts={{m:{1:'<table><tr><td>增值税</td><td>100</td></tr></table>',2:'<table><tr><td>所得税</td><td>200</td></tr></table>'}}} initialPageTextVersions={{m:{1:TAX_PAGE_READER_VERSION,2:TAX_PAGE_READER_VERSION}}}/>);
  fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 2 张表"));
  fireEvent.change(screen.getByLabelText("处理范围"),{target:{value:"vat"}});
  fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 1 张表"));
  expect(read).not.toHaveBeenCalled();expect(mocks.recognize).not.toHaveBeenCalled();expect(mocks.extract).not.toHaveBeenCalled();
});

it("混合文件的不同税种允许分别人工确认",async()=>{
  const own=props();render(<AudiPickTaxWorkflow {...own}/>);
  fireEvent.click(screen.getByRole("button",{name:"混合税表.pdf 第 2 页 预览并确认"}));
  fireEvent.click(within(screen.getByRole("dialog",{name:"税表人工复核"})).getByRole("button",{name:"确认并保存"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"混合税表.pdf 第 2 页 预览并确认"})).toHaveTextContent("已人工确认"));
  expect(own.onSave).toHaveBeenCalledWith(expect.objectContaining({reviews:{m:[expect.objectContaining({formKey:"A105000",pages:[2]})]}}));
});

it("合订文件中未识别的土地增值税页可以人工选表并独立提取",async()=>{
  const own=props(),value=own.initialIndexes.m;
  value.forms=[forms[0]];
  value.pages[1]={page:2,text:"增税申报表（一）",source:"header_ocr",kind:"unknown",taxType:"unknown",confidence:"low"};
  render(<AudiPickTaxWorkflow {...own} initialPageTexts={{m:{2:'<table><tr><td>土地增值税</td><td>0</td><td>*</td></tr></table>'}}} initialPageTextVersions={{m:{2:TAX_PAGE_READER_VERSION}}}/>);
  fireEvent.click(screen.getByRole("button",{name:"混合税表.pdf 第 2 页 预览并确认"}));
  const dialog=screen.getByRole("dialog",{name:"税表人工复核"});
  fireEvent.change(within(dialog).getByLabelText("表单类型"),{target:{value:"land_appreciation_declaration"}});
  fireEvent.click(within(dialog).getByRole("button",{name:"确认并保存"}));
  await waitFor(()=>expect(screen.queryByRole("dialog",{name:"税表人工复核"})).not.toBeInTheDocument());
  fireEvent.change(screen.getByLabelText("处理范围"),{target:{value:"land_appreciation"}});
  expect(screen.getByRole("heading",{name:"混合税表.pdf"})).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 1 张表"));
  expect(own.onSave.mock.calls.at(-1)![0].tables[0]).toMatchObject({formKey:"land_appreciation_declaration",pages:[2],rows:[["土地增值税","0","*"]]});
  expect(mocks.recognize).not.toHaveBeenCalled();expect(mocks.extract).not.toHaveBeenCalled();
});

it("重预检保存前页进度后，后页的人工方向仍用于实际标题识别",async()=>{
  const own=props();
  own.initialIndexes.m.pages=own.initialIndexes.m.pages.map(page=>({...page,text:"",kind:"unknown",confidence:"low",rotation:page.page===2?90:0}));
  mocks.recognize.mockResolvedValueOnce(forms[0].formName).mockResolvedValueOnce(forms[1].formName);
  render(<AudiPickTaxWorkflow {...own}/>);
  fireEvent.click(screen.getByRole("button",{name:"1. 预检文件目录"}));
  await waitFor(()=>expect(mocks.recognize).toHaveBeenCalledTimes(2));
  expect(own.page.getViewport).toHaveBeenNthCalledWith(2,expect.objectContaining({rotation:90}));
});

it("人工旋转持久化方向并使旧复核和受影响页缓存失效，重新识别使用旋转方向",async()=>{
  const own=props(),value=own.initialIndexes.m;
  const group=stampTaxReviewGroup(value,{id:"old",formKey:"vat_main",companyName:value.companyName,period:value.period,pages:[1],status:"confirmed"});
  mocks.recognize.mockResolvedValue("增值税纳税申报表（一般纳税人适用）\n行次 项目 金额");
  render(<AudiPickTaxWorkflow {...own} initialReviews={{m:[group]}} initialPageTexts={{m:{1:"旧方向缓存",2:"保留缓存"}}} initialPageTextVersions={{m:{1:TAX_PAGE_READER_VERSION,2:TAX_PAGE_READER_VERSION}}}/>);
  fireEvent.click(screen.getByRole("button",{name:"混合税表.pdf 第 1 页 预览并确认"}));
  const dialog=screen.getByRole("dialog",{name:"税表人工复核"});
  fireEvent.click(within(dialog).getByRole("button",{name:"向右旋转"}));
  await waitFor(()=>expect(own.onSave).toHaveBeenCalled());
  const saved=own.onSave.mock.calls.at(-1)![0];
  expect(saved.indexes.m.pages[0]).toMatchObject({rotation:90});
  expect(saved.pageTexts.m).toEqual({2:"保留缓存"});
  expect(screen.getByRole("button",{name:"混合税表.pdf 第 1 页 预览并确认"})).not.toHaveTextContent("已人工确认");
  fireEvent.click(within(dialog).getByRole("button",{name:"重新识别此页"}));
  await waitFor(()=>expect(mocks.recognize).toHaveBeenCalledTimes(1));
  expect(own.page.getViewport).toHaveBeenCalledWith(expect.objectContaining({rotation:90}));
});

it("旋转保存失败不改变方向或清除已有页缓存",async()=>{
  const own=props();own.onSave.mockRejectedValue(new Error("磁盘不可写"));
  render(<AudiPickTaxWorkflow {...own} initialPageTexts={{m:{1:"既有缓存"}}}/>);
  fireEvent.click(screen.getByRole("button",{name:"混合税表.pdf 第 1 页 预览并确认"}));
  const dialog=screen.getByRole("dialog",{name:"税表人工复核"});
  fireEvent.click(within(dialog).getByRole("button",{name:"向右旋转"}));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("磁盘不可写");
  expect(within(dialog).getByText("方向：0°")).toBeInTheDocument();
});

it("旋转后的整页识别与文字层坐标使用同一方向",async()=>{
  const own=props(),value=own.initialIndexes.m;
  value.pages[0].rotation=90;
  mocks.recognize.mockResolvedValue("| 行次 | 项目 | 金额 |\n| 1 | 收入 | 0 |");
  mocks.extract.mockResolvedValue({companyName:value.companyName,period:value.period,tables:[{...forms[0],formKey:"vat_main",rows:[["行次","项目","金额"],["1","收入","0"]],merges:[]}]});
  render(<AudiPickTaxWorkflow {...own} initialSelectedFormKeys={["vat_main"]}/>);
  fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 1 张表"));
  expect(own.page.getViewport).toHaveBeenCalledWith({scale:1,rotation:90});
});
