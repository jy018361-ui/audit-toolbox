import { describe, expect, it } from "vitest";
import {
  accountHierarchyCode,
  accountLeafAccounts,
  accountNearestParent,
  accountTopLevel,
} from "./accountHierarchy";

describe("科目层级筛选（多层级 TB 清单口径）", () => {
  it("一级科目隐藏名下末级，末级清单反向只留末级", () => {
    const accounts = [
      "1002 银行存款",
      "10020101 银行存款-中国银行",
      "1002010101 银行存款-中国银行-闵行支行",
      "6603 财务费用",
      "66030101 财务费用-利息收入",
      "2202 应付账款",
    ];
    expect(accountTopLevel(accounts)).toEqual([
      "1002 银行存款",
      "6603 财务费用",
      "2202 应付账款",
    ]);
    expect(accountLeafAccounts(accounts)).toEqual([
      "1002010101 银行存款-中国银行-闵行支行",
      "66030101 财务费用-利息收入",
      "2202 应付账款",
    ]);
  });

  it("平级编码与无编码科目原样保留，不做层级推断", () => {
    const flat = ["1001 库存现金", "1002 银行存款", "2202 应付账款"];
    expect(accountTopLevel(flat)).toEqual(flat);
    expect(accountLeafAccounts(flat)).toEqual(flat);
    const segmented = ["1002.01 人民币", "1002.02 美元", "6603 财务费用"];
    expect(accountTopLevel(segmented)).toEqual(segmented);
    const named = ["银行存款", "财务费用-利息收入"];
    expect(accountTopLevel(named)).toEqual(named);
  });

  it("补零混写不构成前缀关系，双方都保留", () => {
    const accounts = ["9431000 汇兑", "00009431001 汇兑-明细"];
    expect(accountTopLevel(accounts)).toEqual(accounts);
  });

  it("编码提取只认首词纯数字（≥2 位）", () => {
    expect(accountHierarchyCode("1002 银行存款")).toBe("1002");
    expect(accountHierarchyCode("1002.01 银行存款")).toBe("");
    expect(accountHierarchyCode("银行存款 1002")).toBe("");
    expect(accountHierarchyCode("1 现金")).toBe("");
  });

  it("上级继承取编码最长的严格前缀", () => {
    expect(
      accountNearestParent("1002010101 闵行支行", [
        "1002 银行存款",
        "10020101 中国银行",
        "2202 应付账款",
      ]),
    ).toBe("10020101 中国银行");
    expect(
      accountNearestParent("1002010101 闵行支行", ["1002010199 他行"]),
    ).toBeUndefined();
    expect(accountNearestParent("银行存款", ["1002 银行存款"])).toBeUndefined();
  });
});
