import { describe, expect, it } from "vitest";
import {
  faAssignmentsForEntities,
  faTbJeMissingMappings,
  suggestFaAccount,
} from "./FaTbJePage";

describe("FA TB+JE account role presets", () => {
  it("suggests roles without creating an independent ledger dictionary", () => {
    expect(suggestFaAccount("1601 固定资产-机器设备")).toEqual({
      account: "1601 固定资产-机器设备",
      role: "cost",
      category: "机器设备",
    });
    expect(suggestFaAccount("1602 累计折旧-机器设备")).toEqual({
      account: "1602 累计折旧-机器设备",
      role: "depreciation",
      category: "机器设备",
    });
    expect(suggestFaAccount("2202 应付账款").role).toBe("excluded");
  });

  it("keeps the same account code independently classified for each entity", () => {
    const account = "FA01 固定资产";
    const actual = faAssignmentsForEntities(
      [account],
      ["A", "B"],
      [
        { entity: "A", account, role: "cost", category: "机器设备" },
        { entity: "B", account, role: "cost", category: "运输设备" },
      ],
    );
    expect(actual.map((item) => [item.entity, item.category])).toEqual([
      ["A", "机器设备"],
      ["B", "运输设备"],
    ]);
    expect(faAssignmentsForEntities([account], ["C"], actual)[0].entity).toBe(
      "C",
    );
    expect(
      faAssignmentsForEntities([account], ["C"], actual)[0].category,
    ).not.toBe("运输设备");
  });

  it("blocks the next step until TB and JE required roles are mapped", () => {
    expect(faTbJeMissingMappings("tb", {})).toEqual([
      "科目编码或科目名称",
      "期初余额",
      "期末余额",
    ]);
    expect(
      faTbJeMissingMappings("tb", {
        accountCode: "科目编码",
        openingFunctionalDebit: "期初借方",
        openingFunctionalCredit: "期初贷方",
        closingFunctionalAmount: "期末余额",
      }),
    ).toEqual([]);
    expect(
      faTbJeMissingMappings("je", {
        accountName: "科目名称",
        id: ["凭证字", "凭证号"],
        date: "记账日期",
        functionalDebit: "借方金额",
        functionalCredit: "贷方金额",
      }),
    ).toEqual([]);
  });

  it("does not create hundreds of unassigned-entity rows before entity confirmation", () => {
    expect(
      faAssignmentsForEntities(["1601 固定资产", "1602 累计折旧"], [], []),
    ).toEqual([]);
  });
});
