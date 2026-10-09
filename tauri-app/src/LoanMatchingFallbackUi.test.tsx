// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {LoanInterestPage} from "./LoanInterestPage";
import type {ToolManifest} from "./types";

const mock = vi.hoisted(() => ({engineCall:vi.fn(),jobStart:vi.fn()}));
vi.mock("./api",()=>({engineCall:mock.engineCall,jobStart:mock.jobStart,jobCancel:vi.fn(),
  pickPath:vi.fn(async()=>["tb.xlsx","je.xlsx"]),openOutput:vi.fn(),listenJobEvents:vi.fn(async()=>()=>undefined),listenPositionedFileDrops:vi.fn(async()=>()=>undefined)}));
afterEach(cleanup);
const tool = {id:"loan_interest",name:"借款利息测算",route:"/tools/loan_interest",description:"",version:"test",capabilities:[],migrationStatus:"ready"} as ToolManifest;
it.each(["accountJe","tbAverage"] as const)("选择%s才生成对应利率表，换口径后作废旧结果",async choice=>{
  mock.engineCall.mockReset();
  mock.jobStart.mockReset();
  const headers = ["科目编码","科目名称","期初余额","期末余额","记账日期","借方","贷方","凭证号","摘要"];
  const mapping = {accountCode:"科目编码",accountName:"科目名称",openingFunctionalAmount:"期初余额",closingFunctionalAmount:"期末余额",date:"记账日期",functionalDebit:"借方",functionalCredit:"贷方",id:"凭证号",summary:"摘要"};
  const inspection = {headers,preview:[["2001","短期借款","300","400","2025-09-01","0","100","1","借款"]],rowCount:2,sheet:"Sheet1",sheets:["Sheet1"],headerRow:1,headerDepth:1,suggestedMapping:mapping,dataYears:[2025],suggestedBalanceSheetDate:"2025-12-31"};
  const groups = [{entity:"默认主体",accountCode:"2001",names:["银行甲","银行乙"],canUseJe:true}];
  mock.engineCall.mockImplementation(async(method:string,p:Record<string,unknown>)=>{
    if(method==="ledger.forms")return [];
    if(method==="ledger.currency_link")return {required:false,verified:true,missingCurrencies:[],affectedGroupCount:0};
    if(method==="deposit.classify_source")return {...inspection,kind:(p.source as {inputPath:string}).inputPath.startsWith("je")?"je":"tb",scores:{tb:10,je:1},confidence:1};
    if(method==="loan.inspect")return inspection;
    if(method==="loan.tb_accounts")return {accounts:[{key:"2001",code:"2001",name:"短期借款",account:"2001 短期借款",opening:300,closing:400,suggestedType:"loan"}]};
    if(method==="loan.prepare_rates"){
      if(!p.matchingFallbackMode)return {rows:[],matchingFallbackGroups:groups};
      const names = p.matchingFallbackMode === "accountJe" ? ["借款汇总（明细无法衔接）"] : ["银行甲","银行乙"];
      return {matchingFallbackGroups:groups,rows:names.map((name,i)=>({rowKey:`${p.matchingFallbackMode}-${i}`,entity:"默认主体",accountCode:"2001",accountName:name,auxiliary:"",loanId:name,openingPrincipal:300,closingPrincipal:400,matchStatus:"待测算",rateType:"fixed",fixedRate:null}))};
    }
    throw new Error(`unexpected ${method}`);
  });
  render(<LoanInterestPage tool={tool}/>);
  fireEvent.click(screen.getByRole("button",{name:"TB＋JE"}));
  fireEvent.click(screen.getByRole("button",{name:"拖放或选择 TB、序时账文件（可同时选择）"}));
  await screen.findByText("已识别：JE 序时账");
  await screen.findByText("已识别：TB 科目余额表");
  await waitFor(()=>expect(screen.getByRole("button",{name:"下一步：确认科目与利率"})).toBeEnabled());
  fireEvent.click(screen.getByRole("button",{name:"下一步：确认科目与利率"}));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("button",{name:"按所选口径继续"})).toBeDisabled();
  expect(mock.jobStart).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("radio",{name:choice === "accountJe" ? /合并同码借款/ : /保留 TB 明细/}));
  fireEvent.click(within(dialog).getByRole("button",{name:"按所选口径继续"}));
  await waitFor(()=>expect(mock.engineCall).toHaveBeenLastCalledWith("loan.prepare_rates",expect.objectContaining({matchingFallbackMode:choice,requireMatchingFallbackChoice:true}),"生成借款利率明细"));
  const expected = choice === "accountJe" ? "借款汇总（明细无法衔接）" : "银行甲";
  expect(await screen.findByRole("spinbutton",{name:`${expected}的执行利率`})).toBeVisible();
  if (choice === "accountJe") {
    expect(screen.getByRole("heading", {name:"借款汇总利率确认"})).toBeVisible();
    const summary = screen.getByRole("spinbutton",{name:`${expected}的执行利率`}).closest("table")!;
    expect(within(summary).getByRole("columnheader",{name:"期初本金"})).toBeVisible();
    expect(within(summary).getByText("默认主体 · 2001 借款汇总（明细无法衔接）")).toBeVisible();
  }
  fireEvent.click(screen.getByRole("button",{name:"选择明细衔接口径"}));
  const again = await screen.findByRole("dialog");
  fireEvent.click(within(again).getByRole("radio",{name:choice === "accountJe" ? /保留 TB 明细/ : /合并同码借款/}));
  fireEvent.click(within(again).getByRole("button",{name:"按所选口径继续"}));
  await waitFor(()=>expect(mock.engineCall).toHaveBeenLastCalledWith("loan.prepare_rates",expect.objectContaining({matchingFallbackMode:choice === "accountJe" ? "tbAverage" : "accountJe",rateConfirmationAccepted:false}),"生成借款利率明细"));
});
