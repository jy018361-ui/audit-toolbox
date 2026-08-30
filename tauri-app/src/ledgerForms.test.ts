import { describe, expect, it } from "vitest";
import {
  describeForm,
  formGroups,
  resolveForm,
  roleRequirement,
  type LedgerForm,
} from "@/ledgerForms";

// 与 Rust `ledger_mapping::tb_forms` 下发的形状一致（这里只取判定用得到的三型）。
const TB_FORMS: LedgerForm[] = [
  {
    id: "TB1",
    display: "TB-类型A",
    label: "本位币净额",
    anyOf: [],
    required: [
      ["openingFunctionalAmount"],
      ["closingFunctionalAmount"],
      ["ytdFunctionalDebit", "ytdFunctionalCredit"],
    ],
    optional: [["ytdForeignDebit", "ytdForeignCredit"]],
  },
  {
    id: "TB3",
    display: "TB-类型C",
    label: "本位币借贷分列",
    anyOf: [],
    required: [
      ["openingFunctionalDebit", "openingFunctionalCredit"],
      ["closingFunctionalDebit", "closingFunctionalCredit"],
      ["ytdFunctionalDebit", "ytdFunctionalCredit"],
    ],
    optional: [["ytdForeignDebit", "ytdForeignCredit"]],
  },
];

const TB_ROLES: [string, string][] = [
  ["entity", "公司/核算主体"],
  ["accountCode", "科目编码"],
  ["accountName", "科目名称"],
  ["currency", "原币币种"],
  ["openingFunctionalAmount", "年初余额（净额）"],
  ["openingFunctionalDebit", "年初余额借方"],
  ["openingFunctionalCredit", "年初余额贷方"],
  ["closingFunctionalDebit", "期末余额借方"],
  ["closingFunctionalCredit", "期末余额贷方"],
  ["ytdFunctionalDebit", "本年累计借方发生额"],
  ["ytdFunctionalCredit", "本年累计贷方发生额"],
  ["periodFunctionalDebit", "本期借方发生额"],
  ["periodFunctionalCredit", "本期贷方发生额"],
];

const debitCreditMapping = {
  accountCode: "科目编码",
  accountName: "科目名称",
  openingFunctionalDebit: "期初借",
  openingFunctionalCredit: "期初贷",
  closingFunctionalDebit: "期末借",
  closingFunctionalCredit: "期末贷",
  ytdFunctionalDebit: "本年借",
  ytdFunctionalCredit: "本年贷",
};

describe("按型号判定", () => {
  it("借贷分列齐全时命中借贷分列那一型，型号名给用户看的是字母", () => {
    const match = resolveForm("tb", TB_FORMS, debitCreditMapping);
    expect(match?.form.id).toBe("TB3");
    expect(match?.complete).toBe(true);
    expect(describeForm(match, (role) => role)).toBe(
      "已识别为 TB-类型C（本位币借贷分列）",
    );
  });

  it("没命中时报最接近的那一型缺哪几列", () => {
    const match = resolveForm("tb", TB_FORMS, {
      accountCode: "科目编码",
      openingFunctionalDebit: "期初借",
      openingFunctionalCredit: "期初贷",
      closingFunctionalDebit: "期末借",
      closingFunctionalCredit: "期末贷",
    });
    expect(match?.complete).toBe(false);
    expect(describeForm(match, (role) => role)).toContain("TB-类型C");
    expect(match?.missing).toEqual([
      "ytdFunctionalDebit",
      "ytdFunctionalCredit",
    ]);
  });

  it("本期借贷不经勾稽提升时不能代替本年累计", () => {
    const periodOnly = {
      ...debitCreditMapping,
      ytdFunctionalDebit: "",
      ytdFunctionalCredit: "",
      periodFunctionalDebit: "本期借",
      periodFunctionalCredit: "本期贷",
    };
    expect(resolveForm("tb", TB_FORMS, periodOnly)?.complete).toBe(false);
  });

  it("必填标记跟着当前命中的型走，不是一张固定清单", () => {
    const match = resolveForm("tb", TB_FORMS, debitCreditMapping);
    expect(roleRequirement(match, "openingFunctionalDebit")).toBe("required");
    // 净额列属于另一型，在这一型下既不必填也不选填。
    expect(roleRequirement(match, "openingFunctionalAmount")).toBeUndefined();
    expect(roleRequirement(match, "ytdForeignDebit")).toBe("optional");
  });
});

describe("下拉分组", () => {
  it("公共必填单独置顶，每个形态独立显示适配状态", () => {
    const groups = formGroups("tb", TB_ROLES, TB_FORMS, debitCreditMapping);
    expect(groups.map((group) => group.title)).toEqual([
      "公共必填字段",
      "公共选填字段",
      "TB-类型A（本位币净额）",
      "TB-类型C（本位币借贷分列）",
      "本期发生额（通过勾稽后自动提升）",
    ]);
    expect(groups[0].roles).toEqual(["accountCode", "accountName"]);
    expect(groups[0].required).toEqual(["accountCode", "accountName"]);
    expect(groups[1].roles).toEqual(["entity", "currency"]);
    expect(groups[2].status).toBe("未适配");
    expect(groups[3].status).toBe("已适配");
    expect(groups[3].roles).toEqual([
      "openingFunctionalDebit",
      "openingFunctionalCredit",
      "closingFunctionalDebit",
      "closingFunctionalCredit",
      "ytdFunctionalDebit",
      "ytdFunctionalCredit",
    ]);
  });

  it("拿不到型号定义时退回一组平铺，不影响映射", () => {
    expect(formGroups("tb", TB_ROLES, [], {})).toEqual([
      {
        title: "公共必填字段",
        roles: ["accountCode", "accountName"],
        required: ["accountCode", "accountName"],
      },
      {
        title: "公共选填字段",
        roles: ["entity", "currency"],
      },
      {
        title: "本期发生额（通过勾稽后自动提升）",
        roles: ["periodFunctionalDebit", "periodFunctionalCredit"],
      },
      {
        title: "金额字段",
        roles: [
          "openingFunctionalAmount",
          "openingFunctionalDebit",
          "openingFunctionalCredit",
          "closingFunctionalDebit",
          "closingFunctionalCredit",
          "ytdFunctionalDebit",
          "ytdFunctionalCredit",
        ],
      },
    ]);
  });
});
