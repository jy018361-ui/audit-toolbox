import { describe, expect, it } from "vitest";
import { governingCovenantText, isNotificationOnlyCovenant } from "./covenantObligationContext";
import { classifyCovenant } from "./audipickCaseMatching";
import { DEFAULT_CASE_LIBRARY } from "./audipickCaseLibrary";

describe("财务指标契约按实际义务分类", () => {
  const intro = "▲8.6 借款人应当在下列事项发生或可能发生之日起7日内书面通知贷款人并按法律\n法规、监管规定及贷款人要求及时提交相关证明：";
  const event = "(10) 发生关联交易，且交易金额达到或超过最近经审计的净资产的 10%；";
  const source = `${intro}\n(1) 借款人修改章程；\n---PDF第13页---\n${event}\n (111) 8.8 借款人资产负债率不得超过65%。`;

  it("跨页子项继承通知主句，下一条独立指标不继承", () => {
    expect(governingCovenantText(source, source.indexOf(event))).toBe(intro + "\n");
    expect(classifyCovenant(event, DEFAULT_CASE_LIBRARY, governingCovenantText(source, source.indexOf(event))).decision).toBe("exclude");
    expect(governingCovenantText(source, source.indexOf(" (111)"))).toBe("");
  });

  it("首个子项也继承主句，不从相邻子项借用义务", () => {
    const first = `${intro}\n(1) 关联交易超过净资产10%；`;
    expect(isNotificationOnlyCovenant("关联交易超过净资产10%", governingCovenantText(first, first.indexOf("(1)")))).toBe(true);
    const independent = `8.5 发生下列事项时：\n(1) 须通知贷款人。\n${event}`;
    expect(isNotificationOnlyCovenant(event, governingCovenantText(independent, independent.indexOf(event)))).toBe(false);
  });

  it("提前通知并落实清偿方案后方可行动，不是单纯通知", () => {
    const parent = "▲8.5 借款人发生下列任一情形时，应当至少提前30日书面通知贷款人；并且，在清偿本合同项下所有贷款本息或提供贷款人认可的还款方案之前，不应采取行动：";
    const child = "(1) 处置净资产10%以上的资产；";
    const text = parent + "\n" + child;
    const context = governingCovenantText(text, text.indexOf(child));
    expect(isNotificationOnlyCovenant(child, context)).toBe(false);
    expect(classifyCovenant(child, DEFAULT_CASE_LIBRARY, context)).toMatchObject({decision:"include",categoryId:"C03"});
  });

  it.each([
    "发生关联交易且金额达到净资产10%时，应在7日内通知贷款人。",
    "诉讼标的金额为9000万元以上时须通知贷款人。",
    "资产负债率超过65%时应书面报告贷款人。",
    "关联交易达到净资产10%时应至少提前7日书面通知贷款人。",
    "关联交易达到净资产10%时应通知贷款人，不得隐瞒报告事项。",
  ])("仅通知门槛排除：%s", text => {
    expect(classifyCovenant(text, DEFAULT_CASE_LIBRARY).decision).toBe("exclude");
  });

  it.each([
    ["关联交易超过净资产10%须取得贷款人事先同意，并书面通知贷款人。", "C03"],
    ["关联交易超过净资产10%应通知贷款人并征得其同意。", "C03"],
    ["资产负债率不得超过65%，超过时应通知贷款人。", "C01"],
    ["发生诉讼标的金额9000万元以上的，构成违约事件。", "C05"],
  ])("保留独立财务限制和违约事件：%s", (text, categoryId) => {
    expect(classifyCovenant(text, DEFAULT_CASE_LIBRARY)).toMatchObject({ decision: "include", categoryId });
  });
});
