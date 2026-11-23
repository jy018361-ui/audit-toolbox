import { describe, expect, it } from "vitest";
import { buildTaxPageIndex } from "./audipickTax";
import { taxDirectoryGaps } from "./audipickTaxDiscovery";

describe("税表目录完整性提示", () => {
  it("目录中列出而正文尚未匹配的表单列为疑似缺表，不把目录当内容页", () => {
    const index = buildTaxPageIndex([{page:1,text:"申报表目录 A104000 期间费用明细表 A105000 纳税调整项目明细表"},{page:2,text:"A105000 纳税调整项目明细表\n行次 项目 金额"}], "企业所得税.pdf");
    expect(taxDirectoryGaps(index).map(form => form.key)).toEqual(["A104000"]);
  });
  it("已由用户确认的目录表单不再提示缺表", () => {
    const index = buildTaxPageIndex([{page:1,text:"申报表目录 A104000 期间费用明细表"},{page:2,text:"扫描件"}], "企业所得税.pdf");
    expect(taxDirectoryGaps(index, ["A104000"])).toEqual([]);
  });
  it("普通正文提及其他表号不会制造目录缺表提示", () => {
    const index = buildTaxPageIndex([{page:1,text:"A105000 纳税调整项目明细表\n行次 项目 金额\n参考A104000"}], "企业所得税.pdf");
    expect(taxDirectoryGaps(index)).toEqual([]);
  });
});
