import { describe, expect, it } from "vitest";
import { describeLoanForm, loanRoleRequirement, resolveLoanForm, type LoanForm } from "./loanForms";
import { loanMissing } from "./LoanInterestPage";

// 与 Rust `ledger_mapping::LOAN_FORMS` 同序同槽的夹具。
// 型号定义的**权威在 Rust**（运行时也由引擎下发），这份只是给前端判型逻辑当输入；
// 别名库、真实台账的判型基线在 `loan_interest.rs` 的 `loan_form_tests` 里。
const FORMS: LoanForm[] = [
  { id: "D", label: "期末余额＋期间发生额", anyOf: [["closingPrincipal", "principal"]], required: [["startDate"], ["rate"], ["drawdownAmount", "repaymentAmount"]], optional: [["rateType"]] },
  { id: "C", label: "期初余额＋期间发生额", anyOf: [["openingPrincipal", "principal"]], required: [["startDate"], ["rate"], ["drawdownAmount", "repaymentAmount"]], optional: [["rateType"]] },
  { id: "B", label: "起始日＋期限", anyOf: [["principal", "openingPrincipal"]], required: [["startDate"], ["term"], ["rate"]], optional: [["rateType"]] },
  { id: "A", label: "起始日＋到期日", anyOf: [["principal", "openingPrincipal"]], required: [["startDate"], ["endDate"], ["rate"]], optional: [["rateType"]] },
];
const label = (role: string) => role;

describe("借款台账判型", () => {
  it("四型各自命中", () => {
    const at = (m: Record<string, string>) => resolveLoanForm(FORMS, m)?.form.id;
    expect(at({ principal: "借款金额", startDate: "放款日", endDate: "到期日", rate: "利率" })).toBe("A");
    expect(at({ principal: "借款金额", startDate: "放款日", term: "期限", rate: "利率" })).toBe("B");
    expect(at({ openingPrincipal: "期初余额", startDate: "放款日", rate: "利率", drawdownAmount: "本期新增", repaymentAmount: "本期归还" })).toBe("C");
    expect(at({ closingPrincipal: "期末余额", startDate: "放款日", rate: "利率", drawdownAmount: "本期新增", repaymentAmount: "本期归还" })).toBe("D");
  });

  it("到期日与期限并存时认A型", () => {
    const hit = resolveLoanForm(FORMS, { principal: "借款金额", startDate: "放款日", endDate: "到期日", term: "期限(月)", rate: "利率" });
    expect(hit?.form.id).toBe("A");
    expect(hit?.complete).toBe(true);
  });

  it("起算额三者任一到位即可，不必同时给", () => {
    const base = { startDate: "放款日", endDate: "到期日", rate: "利率" };
    expect(resolveLoanForm(FORMS, { ...base, principal: "借款金额" })?.complete).toBe(true);
    expect(resolveLoanForm(FORMS, { ...base, openingPrincipal: "期初余额" })?.complete).toBe(true);
    // 三个都给也不冲突——差额是「年内有归还」的复核线索。
    expect(resolveLoanForm(FORMS, { ...base, principal: "借款金额", openingPrincipal: "期初余额", closingPrincipal: "期末余额" })?.complete).toBe(true);
  });

  it("必填项随命中的型号变，不是一张固定清单", () => {
    const t1 = resolveLoanForm(FORMS, { principal: "本金", startDate: "放款日", endDate: "到期日", rate: "利率" });
    expect(loanRoleRequirement(t1, "endDate")).toBe("required");
    expect(loanRoleRequirement(t1, "term")).toBeUndefined();
    expect(loanRoleRequirement(t1, "rateType")).toBe("optional");
    // 老口径写死的「期初本金＋期末本金＋利率类型」在 A 型下都不是必填。
    expect(loanRoleRequirement(t1, "openingPrincipal")).toBe("required"); // 起算额那一格，与本金二选一
    expect(loanRoleRequirement(t1, "closingPrincipal")).toBeUndefined();

    const t2 = resolveLoanForm(FORMS, { principal: "本金", startDate: "放款日", term: "期限", rate: "利率" });
    expect(loanRoleRequirement(t2, "term")).toBe("required");
    expect(loanRoleRequirement(t2, "endDate")).toBeUndefined();
  });

  it("没完整命中时报最接近那一型缺什么", () => {
    // 只有起算额＋起始日＋利率 = 已确认不纳入的无固定期限借款形态。
    const hit = resolveLoanForm(FORMS, { principal: "借款金额", startDate: "放款日", rate: "利率" });
    expect(hit?.complete).toBe(false);
    expect(hit?.form.id).toBe("A");
    expect(hit?.missing).toEqual(["endDate"]);
    expect(describeLoanForm(hit, label)).toContain("endDate");
  });

  it("起算额一个都没给时提示至少映射一个", () => {
    const hit = resolveLoanForm(FORMS, { startDate: "放款日", endDate: "到期日", rate: "利率" });
    expect(hit?.missingAny).toEqual([["principal", "openingPrincipal"]]);
    expect(describeLoanForm(hit, label)).toContain("至少映射一个");
  });
});

describe("借款台账必填校验", () => {
  it("命中任一型即放行", () => {
    // 01 华辰那份表的形状：合同本金＋起止日＋利率，没有期初本金、没有利率类型。
    // 旧口径写死四项必填，这种最常见的台账必然被误拦。
    expect(loanMissing("ledger", { principal: "借款金额(元)", startDate: "借款起始日", endDate: "到期日", rate: "利率(%)" }, FORMS)).toEqual([]);
  });

  it("缺终点时按最接近的型号报缺失", () => {
    expect(loanMissing("ledger", { principal: "借款金额", startDate: "放款日", rate: "利率" }, FORMS)).toEqual(["到期日"]);
  });

  it("起算额缺失报任一即可", () => {
    expect(loanMissing("ledger", { startDate: "放款日", endDate: "到期日", rate: "利率" }, FORMS)).toEqual(["本金／期初余额（任一）"]);
  });

  it("利率台账不拦，引擎没下发形态表时也不拦", () => {
    expect(loanMissing("rateLedger", {}, FORMS)).toEqual([]);
    expect(loanMissing("ledger", {})).toEqual([]);
  });
});
