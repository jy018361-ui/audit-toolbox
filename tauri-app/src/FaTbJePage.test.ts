import { describe, expect, it } from "vitest";
import {
  faAssignmentsForEntities,
  faTbJeMissingMappings,
  splitFaAccount,
  suggestFaAccount,
  suggestFaAccounts,
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

  it("拆科目串时不把纯英文名的首个单词当编码", () => {
    expect(splitFaAccount("16020002 机械设备")).toEqual({
      code: "16020002",
      name: "机械设备",
    });
    expect(splitFaAccount("16010004-数据处理设备")).toEqual({
      code: "16010004",
      name: "数据处理设备",
    });
    expect(splitFaAccount("1602")).toEqual({ code: "1602", name: "" });
    // SAP 型余额表把编码拼在串尾
    expect(splitFaAccount("固定资产 固定资产-累计折旧-办公设备 1601130001")).toEqual({
      code: "1601130001",
      name: "固定资产 固定资产-累计折旧-办公设备",
    });
    expect(splitFaAccount("Accumulated Depreciation")).toEqual({
      code: "",
      name: "Accumulated Depreciation",
    });
  });

  it("下级科目跟着上级科目走，不再按名称各判各的", () => {
    // 真实样例：1602 累计折旧下面挂着「机械设备」「数据处理设备」，
    // 只看名称会整片判成原值。
    const chart = [
      "1601 固定资产",
      "16010004 数据处理设备",
      "1602 累计折旧",
      "16020002 机械设备",
      "16020004 数据处理设备",
      "1604 在建工程",
      "16040003 数据处理设备",
      "1606 固定资产清理",
      "5301 研发支出",
      "5301000125 直接投入-仪器设备维护费",
      "5301000128 直接投入-房屋租赁费",
    ];
    expect(
      Object.fromEntries(
        suggestFaAccounts(chart).map((item) => [item.account, item.role]),
      ),
    ).toEqual({
      "1601 固定资产": "cost",
      "16010004 数据处理设备": "cost",
      "1602 累计折旧": "depreciation",
      "16020002 机械设备": "depreciation",
      "16020004 数据处理设备": "depreciation",
      "1604 在建工程": "excluded",
      "16040003 数据处理设备": "excluded",
      "1606 固定资产清理": "excluded",
      "5301 研发支出": "excluded",
      "5301000125 直接投入-仪器设备维护费": "excluded",
      "5301000128 直接投入-房屋租赁费": "excluded",
    });
    // 原值与折旧按同名类别配对，汇总变动表才能对上。
    expect(
      suggestFaAccounts(chart)
        .filter((item) => item.role !== "excluded")
        .map((item) => item.category),
    ).toEqual([
      "固定资产",
      "数据处理设备",
      "固定资产",
      "机械设备",
      "数据处理设备",
    ]);
  });

  it("SAP 型科目表：编码在串尾、累计折旧挂在 1601 下、损益类科目不进原值", () => {
    // 4800 真实样例。余额表列序是「名称一级 名称二级 代码」，编码落在最后；
    // 累计折旧不在 1602 而是 1601 的子科目；6601 是损益类折旧费用，
    // 名称里带「固定资产」「设备」，只看名称会被当成原值捞进来。
    const chart = [
      "固定资产 固定资产-办公设备 1601030001",
      "固定资产 固定资产-计算机及硬件设备 1601040001",
      "固定资产 固定资产-机器设备 1601050002",
      "固定资产 固定资产-累计折旧-办公设备 1601130001",
      "固定资产 固定资产-累计折旧-计算机及硬件设备 1601140001",
      "固定资产 固定资产-累计折旧-机器设备 1601150002",
      "使用权资产 使用权资产-原值 1605010001",
      "使用权资产 减：使用权资产-累计折旧 1605110001",
      "运营费用 运营费用-折旧费-固定资产 6601090401",
      "运营费用 运营费用-设备租赁费 6601330001",
    ];
    expect(
      suggestFaAccounts(chart).map((item) => [item.role, item.category]),
    ).toEqual([
      ["cost", "办公设备"],
      ["cost", "计算机及硬件设备"],
      ["cost", "机器设备"],
      ["depreciation", "办公设备"],
      ["depreciation", "计算机及硬件设备"],
      ["depreciation", "机器设备"],
      ["excluded", "使用权资产 使用权资产-原值"],
      ["excluded", "使用权资产 减：使用权资产"],
      ["excluded", "运营费用 运营费用-折旧费"],
      ["excluded", "运营费用 运营费用-设备租赁费"],
    ]);
  });

  it("同一科目在 TB 与 JE 里拼法不同也归一到同一角色与类别", () => {
    // TB 侧「名称 代码」、JE 侧「代码 名称」，名称取的列还不一样。
    // 不归一的话两条分类会带着不同类别送进引擎，原值与累计折旧永远配不上对。
    const rows = suggestFaAccounts([
      "固定资产 固定资产-机器设备 1601050002",
      "固定资产 固定资产-累计折旧-机器设备 1601150002",
      "1601050002 固定资产-机器设备-检测仪器",
      "1601150002 累计折旧-机器设备-检测仪器",
    ]);
    expect(rows.map((item) => [item.role, item.category])).toEqual([
      ["cost", "机器设备"],
      ["depreciation", "机器设备"],
      ["cost", "机器设备"],
      ["depreciation", "机器设备"],
    ]);
  });

  it("科目表没有上级行时按一级编码兜底", () => {
    expect(
      suggestFaAccounts(["16010004 数据处理设备", "16020004 数据处理设备"]).map(
        (item) => item.role,
      ),
    ).toEqual(["cost", "depreciation"]);
  });

  it("固定资产科目排在前面，其余科目垫底", () => {
    const rows = faAssignmentsForEntities(
      ["1002 银行存款", "1602 累计折旧", "2202 应付账款", "1601 固定资产"],
      [],
      [],
    );
    expect(rows.map((row) => row.account)).toEqual([
      "1601 固定资产",
      "1602 累计折旧",
      "1002 银行存款",
      "2202 应付账款",
    ]);
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

  it("uses the public default entity when neither ledger has an entity column", () => {
    const rows = faAssignmentsForEntities(
      ["1601 固定资产", "1602 累计折旧"],
      [],
      [],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.entity))).toEqual(
      new Set(["默认主体"]),
    );
    expect(rows.map((row) => [row.role, row.category])).toEqual([
      ["cost", "固定资产"],
      ["depreciation", "固定资产"],
    ]);
  });
});
