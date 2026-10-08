import { describe,it,expect } from "vitest";
import {extractFinancialMetrics,isExplicitFinancialMetric} from "./audipickCovenantExtraction";
import {covenantExportRows,isFormalCovenantRow} from "./audipickCovenant";
describe("仅财务指标摘录",()=>{
 it("无需后果链，保留亏损口径并导出原文与出处",async()=>{
 const text="第二十三条 违约事件\n借款人经审计的母公司报表连续两年净利润为负。";
 const result=await extractFinancialMetrics({documents:[{id:"d",name:"合同.pdf",text}],extract:async()=>({parsed:{coverage_complete:true,items:[{title:"连续两年亏损",evidence:[{line_start:2,line_end:2}]}]}})});
 expect(result.items).toHaveLength(1);expect(isFormalCovenantRow(result.items[0])).toBe(true);
 expect(Object.keys(covenantExportRows(result.items,()=>"合同.pdf")[0])).toEqual(["财务契约类型","限制或触发标准","合同原文摘录","原文引用出处"]);
 expect(result.unresolvedCount).toBe(0);
 });
 it("保留 C319 的 condition/default 指标并按独立指标拆行",async()=>{
  const lines=[
   "4.3财务指标监督",
   "发生下列(1)(2)(3)情形的，借款人应按贷款人要求落实贷款人认可的债务保障措施：",
   "(1)经营期项目实际收益低于评估水平",
   "100%",
   "的；",
   "(2)借款人资产负债率达到",
   "100%",
   "以上的；",
   "(3)借款人发生不良信用的；",
  ];
  const result=await extractFinancialMetrics({
   documents:[{id:"c319",name:"C319借款合同.pdf",text:lines.join("\n")}],
   extract:async()=>({parsed:{coverage_complete:true,items:[
    {title:"项目收益触发条件",evidence:[{line_start:2,line_end:2,role:"obligation"},{line_start:3,line_end:5,role:"condition"}]},
    {title:"资产负债率触发条件",evidence:[{line_start:2,line_end:2,role:"obligation"},{line_start:6,line_end:8,role:"default"}]},
   ]}}),
  });
  expect(result.items).toHaveLength(2);
  expect(result.items.map(item=>item.covenant_category_id)).toEqual(["C02","C01"]);
  expect(result.items[0].excerpt).toContain("项目实际收益低于评估水平\n100%");
  expect(result.items[1].excerpt).toContain("资产负债率达到\n100%\n以上");
 });
 it("只收录有财务指标或量化财务门槛的限制",()=>{
 for(const text of ["遵循本合同约定的财务指标约束","贷款用于投资项目","按时还本付息","贷款人有权宣布提前到期","不得分红","不得对外投资","项目资本金1.2亿元","借款人或有负债比率超过"]){expect(isExplicitFinancialMetric(text),text).toBe(false);}
 for(const text of ["关联交易超过净资产10%须同意","担保超过总资产80%须同意","处置经营资产涉及经审计总资产10%以上须同意","信用评级低于A+并追加担保","诉讼标的金额为9000万元以上时须通知","资产负债率不得超过65%","流动比率不得低于1.2","净资产不得低于1亿元","连续两年净利润为负","经营期项目实际收益低于评估水平100%"]){expect(isExplicitFinancialMetric(text),text).toBe(true);}
 });
 it("排除 C300 中的期限、提款、还款、利率、账户和无量化交易条款",()=>{
  for(const text of [
   "第四条贷款期限从2026年6月29日起至2035年6月29日止，共计9年。",
   "第一笔贷款的提款日为2026年6月29日，提款金额为40000万元。",
   "本合同项下提款期为自第一笔提款日起3个月。",
   "借款人应按下列计划向贷款人偿还贷款本金：2027年3月29日2050万元。",
   "借款人应将本合同项下贷款金额的100%通过贷款人结算。",
   "本合同项下项目资本金为12000万元，2026年6月29日前到位。",
   "贷款利率=基准利率+利差，基准利率为LPR5Y报价，利差为-70BP。",
   "借款人提前还款的最低金额为1000万元。",
   "未经贷款人书面同意，借款人不得处置项目资产或用于其他融资。",
   "借款人利用虚假合同及应收账款质押套取贷款人资金。",
   "借款人或其关联方通过关联交易有意逃废债务。",
   "借款人已在贷款人开立贷款账户和结算账户，专门用于贷款发放和回收本息。",
   "借款人应按月归集BaaS服务收入，每月前3个工作日归集并提前5个工作日备足本息。",
  ]) expect(isExplicitFinancialMetric(text),text).toBe(false);
 });
 it("模型返回普通贷款条款时确定性过滤只保留财务指标",async()=>{
  const lines=[
   "第四条贷款期限从2026年6月29日起至2035年6月29日止，共计9年。",
   "第一笔贷款的提款日为2026年6月29日，提款金额为40000万元。",
   "借款人应按计划偿还贷款本金。",
   "借款人应将本合同项下贷款金额的100%通过贷款人结算。",
   "本合同项下项目资本金为12000万元，2026年6月29日前到位。",
   "贷款利率=基准利率+利差，基准利率为LPR5Y报价。",
   "借款人提前还款的最低金额为1000万元。",
   "未经贷款人书面同意，借款人不得处置项目资产或用于其他融资。",
   "借款人利用虚假合同及应收账款质押套取贷款人资金。",
   "借款人或其关联方通过关联交易有意逃废债务。",
   "借款人已开立贷款账户和结算账户，用于贷款发放和回收本息。",
   "借款人应按月归集BaaS服务收入并提前5个工作日备足本息。",
   "借款人资产负债率不得超过70%。",
  ];
  const result=await extractFinancialMetrics({documents:[{id:"d",name:"C300.pdf",text:lines.join("\n")}],extract:async()=>({parsed:{coverage_complete:true,items:lines.map((_,index)=>({title:`候选${index+1}`,evidence:[{line_start:index+1,line_end:index+1}]}))}})});
  expect(result.items).toHaveLength(1);
  expect(result.items[0].excerpt).toBe(lines.at(-1));
 });
 it("共同罚息后果不能把普通偿付义务变成财务契约",async()=>{
  const text="借款人应按时还本付息。\n逾期贷款罚息利率为贷款利率的130%。";
  const result=await extractFinancialMetrics({documents:[{id:"d",name:"合同.pdf",text}],extract:async()=>({parsed:{coverage_complete:true,items:[{
   title:"逾期罚息",evidence:[{line_start:1,line_end:1,role:"obligation"},{line_start:2,line_end:2,role:"consequence"}],
  }]}})});
  expect(result.items).toEqual([]);
 });
 it("无指标合法返回零项，错误来源仍报错",async()=>{
 const documents=[{id:"d",name:"合同",text:"没有财务指标"}];
 expect((await extractFinancialMetrics({documents,extract:async()=>({parsed:{coverage_complete:true,items:[]}})})).items).toEqual([]);
 await expect(extractFinancialMetrics({documents,extract:async()=>({parsed:{coverage_complete:true,items:[{evidence:[{line_start:99}]}]}})})).rejects.toThrow("来源范围");
 });
});
