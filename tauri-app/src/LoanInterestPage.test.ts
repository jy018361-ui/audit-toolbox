import {describe,expect,it} from "vitest";
import {loanEffectiveRate,loanEquation,loanMissing} from "./LoanInterestPage";

describe("借款利息测算",()=>{
  it("按基准利率加BP换算浮动利率",()=>expect(loanEffectiveRate("floating",0,.035,75)).toBeCloseTo(.0425));
  it("勾稽期初+增加-减少-期末",()=>expect(loanEquation({openingPrincipal:100,additions:30,reductions:20,closingPrincipal:110})).toBe(0));
  // 金标要求 TB 的科目编码与名称都到位，缺名称同样拦。
  it("不允许TB明细缺少借款识别和本金余额",()=>expect(loanMissing("tb",{accountCode:"科目编码"})).toEqual(["科目名称","借款明细/辅助核算","期初余额","期末余额"]));
  it("六种TB形态的期初期末任一到位即可",()=>{
    // 借贷分列（TB3/TB6）。
    expect(loanMissing("tb",{accountCode:"科目",accountName:"科目名称",loanId:"辅助",openingFunctionalCredit:"期初贷方",closingFunctionalCredit:"期末贷方"})).toEqual([]);
    // 净额（TB1/TB4）。
    expect(loanMissing("tb",{accountCode:"科目",accountName:"科目名称",loanId:"辅助",openingFunctionalAmount:"期初余额",closingFunctionalAmount:"期末余额"})).toEqual([]);
  });
  it("历史保存的旧角色名仍然认",()=>expect(loanMissing("tb",{account:"科目",loanId:"辅助",openingPrincipal:"期初本金",closingPrincipal:"期末本金"})).toEqual([]));
});
