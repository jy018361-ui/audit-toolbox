// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FaTbJePage,
  faAssignmentsForEntities,
  faAssignmentsForEntityAccounts,
  faReviewEntityAccounts,
  faInspectionAccounts,
  faConfirmedTbAssignments,
  faTbJeMissingMappings,
  groupAssignmentViews,
  normalizeFaCategory,
  splitFaAccount,
  suggestFaAccount,
  suggestFaAccounts,
  defaultOutput,
  unionEntityAccounts,
} from "./FaTbJePage";
import type { Inspection } from "./DepositInterestPage";
import type { EntityAccountPair } from "./FaTbJePage";
import { publishTaskRestore } from "./restore";
import type { TaskRestore } from "./types";

const pageMock = vi.hoisted(() => ({ engineCall: vi.fn(), jobStart: vi.fn() }));
vi.mock("./api", () => ({
  engineCall: pageMock.engineCall,
  jobStart: pageMock.jobStart,
  jobCancel: vi.fn(),
  listenJobEvents: vi.fn(async () => () => undefined),
  listenPositionedFileDrops: vi.fn(async () => () => undefined),
  openOutput: vi.fn(),
  pickPath: vi.fn(),
}));
// 本轮验证分类工作流；字段建议入口已有专门测试，不自动调用LLM改写测试映射。
vi.mock("./components/LedgerReviewAll", async (importOriginal) => ({
  ...await importOriginal<typeof import("./components/LedgerReviewAll")>(),
  LedgerReviewAll: () => null,
}));
afterEach(cleanup);

it.skipIf(!process.env.FA_TB_ONLY_CASES)("真实原件由前端TB分类函数生成worker验收参数", () => {
  const cases = JSON.parse(readFileSync(process.env.FA_TB_ONLY_CASES!, "utf8")) as Array<{
    name: string;
    params: Record<string, unknown>;
    pairs: EntityAccountPair[];
    expected?: unknown;
  }>;
  const generated = cases.map((item) => {
    const pairs = faReviewEntityAccounts(item.pairs);
    const assignments = faAssignmentsForEntityAccounts(pairs, []);
    expect(assignments.length, item.name).toBe(pairs.length);
    expect(faConfirmedTbAssignments(pairs, assignments), item.name).toEqual(assignments);
    expect(assignments.some((row) => row.role === "cost"), item.name).toBe(true);
    expect(assignments.filter((row) => row.role !== "excluded").every((row) => row.category.trim()), item.name).toBe(true);
    return { ...item, params: { ...item.params, assignmentBasis: "assetRoleCategory", accountAssignments: assignments } };
  });
  if (process.env.FA_TB_ONLY_CASES_OUTPUT) {
    writeFileSync(process.env.FA_TB_ONLY_CASES_OUTPUT, JSON.stringify(generated, null, 2));
  }
});

it("第二步只使用TB公共选层目录，JE空目录或纯编码明细均无需人工分类", () => {
  const tb = { reviewAccounts: [
    { entity: "2002", account: "1601020000 Fixed assets_Machinery equipment", auxiliary: "", currency: "EUR" },
    { entity: "2002", account: "1602020000 Depreciation_Machinery equipment", auxiliary: "", currency: "EUR" },
  ], entityAccounts: [], entities: ["2002"], accounts: [] } as unknown as Inspection;
  const je = { reviewAccounts: [], entityAccounts: [
    { entity: "2002", account: "1601020000" },
    { entity: "2002", account: "1602020000" },
    { entity: "2002", account: "6601160100" },
  ], entities: ["2002"], accounts: ["1601020000", "1602020000", "6601160100"] } as unknown as Inspection;
  expect(faInspectionAccounts(je)).toEqual([]);
  const rows = faAssignmentsForEntityAccounts(faReviewEntityAccounts(
    faInspectionAccounts(tb), true), []);
  expect(rows.filter((row) => row.role !== "excluded").map((row) => [row.account, row.role, row.category]))
    .toEqual([
      ["1601020000 Fixed assets_Machinery equipment", "cost", "Machinery equipment"],
      ["1602020000 Depreciation_Machinery equipment", "depreciation", "Machinery equipment"],
    ]);
  expect(rows).toHaveLength(2);
  expect(rows.some((row) => je.accounts.includes(row.account))).toBe(false);
  // 空目录表示选层后无可复核项，不得重新带回父项或笛卡尔积。
  expect(faInspectionAccounts({ ...tb, reviewAccounts: [], entityAccounts: [{ entity: "2002", account: "1601 汇总" }] })).toEqual([]);
  expect(faInspectionAccounts(undefined)).toEqual([]);
});

it("历史两侧分类只恢复TB完整身份，保留同码多名、辅助、币种及人工排除", () => {
  const pairs = [
    { entity: "A", account: "1998 资产甲", auxiliary: "生产部", currency: "CNY" },
    { entity: "A", account: "1998 资产乙", auxiliary: "生产部", currency: "CNY" },
    { entity: "A", account: "1998 资产甲", auxiliary: "研发部", currency: "CNY" },
    { entity: "A", account: "1998 资产甲", auxiliary: "生产部", currency: "USD" },
  ];
  const tb = pairs.map((pair, index) => ({ ...pair, role: index === 1 ? "excluded" as const : "cost" as const, category: `人工类别${index}` }));
  const old = [...tb,
    { entity: "A", account: "1998", role: "cost" as const, category: "旧JE类别" },
    { ...tb[0], entity: "B", category: "其他主体" },
    { ...tb[0], auxiliary: "", category: "JE无辅助" },
    { ...tb[0], currency: "EUR", category: "JE其他币种" },
  ];
  expect(faConfirmedTbAssignments(pairs, old)).toEqual(tb);
  expect(faAssignmentsForEntityAccounts(pairs, old)).toEqual(tb);
  expect(groupAssignmentViews(faConfirmedTbAssignments(pairs, old))).toHaveLength(4);
  expect(faConfirmedTbAssignments([], old)).toEqual([]);
});

it("英文角色前缀只影响类别建议，保留原始身份及人工类别", () => {
  for (const suffix of ["Machinery equipment", "Furniture, tools, appliances", "Electoric equipment"]) {
    const pairs = [
      { entity: "2002", account: `1601020000 Fixed assets_${suffix}` },
      { entity: "2002", account: `1602020000 Depreciation_${suffix}` },
    ];
    const rows = faAssignmentsForEntityAccounts(pairs, []);
    expect(rows.map((row) => row.category)).toEqual([suffix, suffix]);
    const manual = { ...rows[0], category: "人工类别" };
    expect(faAssignmentsForEntityAccounts(pairs, [manual])[0]).toEqual(manual);
  }
  expect(suggestFaAccount("FA01 Machinery with depreciation sensor").category).toBe("Machinery with depreciation sensor");
  expect(suggestFaAccount("FA01 DepreciationSensor").category).toBe("DepreciationSensor");
});

it.skipIf(!process.env.FA_SAP_SNAPSHOT)("真实SAP仅提交TB分类，JE目录无须人工确认", () => {
  const snapshot = JSON.parse(readFileSync(process.env.FA_SAP_SNAPSHOT!, "utf8"));
  const { tb, je } = snapshot.data.inspects as { tb: Inspection; je: Inspection };
  expect(je.reviewAccounts).toEqual([]);
  const rows = faAssignmentsForEntityAccounts(faReviewEntityAccounts(
    faInspectionAccounts(tb), true), []);
  expect(rows.filter((row) => row.role !== "excluded")).toHaveLength(10);
  expect(rows.every((row) => faInspectionAccounts(tb).some((pair) => pair.account === row.account && pair.entity === row.entity))).toBe(true);
  if (process.env.FA_SAP_ASSIGNMENTS_OUTPUT) {
    writeFileSync(process.env.FA_SAP_ASSIGNMENTS_OUTPUT, JSON.stringify(rows, null, 2));
  }
});

it("同码汇总语义用于FA建议但不改变源行身份或覆盖人工分类", () => {
  const pairs = faReviewEntityAccounts([
    { entity: "A", account: "1998 资产甲", currency: "CNY", classificationContext: "固定资产-机器设备" },
    { entity: "A", account: "1998 资产乙", currency: "CNY", classificationContext: "累计折旧-机器设备" },
    { entity: "B", account: "1998 资产甲", currency: "CNY" },
  ]);
  const assigned = faAssignmentsForEntityAccounts(pairs, []);
  expect(assigned.map((row) => [row.entity, row.account, row.role, row.category])).toEqual([
    ["A", "1998 资产甲", "cost", "机器设备"],
    ["A", "1998 资产乙", "depreciation", "机器设备"],
    ["B", "1998 资产甲", "excluded", "资产甲"],
  ]);
  const manual = { ...assigned[0], role: "excluded" as const, category: "其他" };
  expect(faAssignmentsForEntityAccounts(pairs, [manual]).find((row) => row.entity === "A" && row.account === manual.account)).toEqual(manual);
  expect(faAssignmentsForEntityAccounts([
    { entity: "A", account: "1998 机器设备", classificationContext: "固定资产" },
  ], [])[0]).toMatchObject({ account: "1998 机器设备", role: "cost", category: "机器设备" });
});

describe("FA TB+JE account role presets", () => {
  it("折旧费用优先排除，无费用语境的固定资产折旧建议为累计折旧", () => {
    for (const name of ["固定资产折旧", "固定資產折舊", "固定资产折旧-机器设备"]) {
      expect(suggestFaAccount(`1998 ${name}`).role).toBe("depreciation");
    }
    expect(suggestFaAccount("1998 固定资产折旧-机器设备").category).toBe("机器设备");
    expect(suggestFaAccount("1998 固定资产折旧").category).toBe("固定资产");
    for (const name of ["管理费用-固定资产折旧", "固定资产折旧-制造费用", "銷售費用-固定資產折舊", "费用-累计折旧", "折旧费用"]) {
      expect(suggestFaAccount(`1998 ${name}`).role, name).toBe("excluded");
    }
    const chart = ["6600 管理费用", "660032 固定资产折旧", "66003201 机器设备"];
    expect(suggestFaAccounts(chart).map((row) => row.role)).toEqual(["excluded", "excluded", "excluded"]);
    expect(suggestFaAccount("1602 累计折旧-机器设备").role).toBe("depreciation");
    expect(suggestFaAccount("1601 固定资产-机器设备").role).toBe("cost");
    expect(suggestFaAccount("1998 使用权资产-固定资产折旧").role).toBe("excluded");
    expect(suggestFaAccount("222101 进项税额-固定资产折旧").role).toBe("excluded");
    expect(suggestFaAccount("100201 银行存款-固定资产折旧专户").role).toBe("excluded");
  });

  it("05同名折旧费用按每条来源的上级及分类语境排除，不覆盖人工确认", () => {
    const pairs: EntityAccountPair[] = [
      ...["制造费用", "销售费用", "管理费用"].map((parent, i) => ({
        entity: "A", account: "6600320000 固定资产折旧", auxiliary: `来源${i}`,
        parentAccountName: parent,
      })),
      { entity: "B", account: "6600320000 固定资产折旧", parentAccountName: "固定资产" },
      { entity: "C", account: "1998 固定资产折旧", classificationContext: "制造费用" },
      { entity: "D", account: "1998 固定资产折旧", classificationContext: "固定资产", parentAccountName: "管理费用" },
      { entity: "E", account: "6600320000 固定资产折旧", parentAccountNames: ["制造费用", "销售费用", "管理费用"] },
    ];
    const rows = faAssignmentsForEntityAccounts(faReviewEntityAccounts(pairs), []);
    expect(rows.filter((row) => row.entity !== "B").every((row) => row.role === "excluded")).toBe(true);
    expect(rows.find((row) => row.entity === "B")?.role).toBe("depreciation");
    const manual = { ...pairs[0], role: "cost" as const, category: "人工类别" };
    expect(faAssignmentsForEntityAccounts(pairs, [manual])).toContainEqual(manual);
    expect(faConfirmedTbAssignments(pairs, rows)).toEqual(rows);
  });

  it("混写名称重复编码时旧制度原值仍能识别，且无需拼入科目大类", () => {
    const cost = "15010101 15010101\\固定资产－自有－机械设备";
    const depreciation = "15020101 15020101\\累计折旧－自有－机械设备";
    const rows = suggestFaAccounts([cost, depreciation]);
    expect(rows.map((row) => [row.account, row.role])).toEqual([
      [cost, "cost"],
      [depreciation, "depreciation"],
    ]);
    expect(rows[0].category).toBe(rows[1].category);
    expect(rows[0].category).not.toContain("15010101");

    const pairs = [
      { entity: "3080", account: cost, currency: "CNY", auxiliary: "变动维度" },
      { entity: "3080", account: depreciation, currency: "CNY", auxiliary: "变动维度" },
    ];
    const assigned = faAssignmentsForEntityAccounts(faReviewEntityAccounts(pairs), []);
    expect(assigned.map((row) => row.role)).toEqual(["cost", "depreciation"]);
    expect(assigned[0]).toMatchObject(pairs[0]);
    // 保留用户明确排除与手填类别，也不归一化原始名称或合并复核身份。
    const manual = { ...assigned[0], role: "excluded" as const, category: "人工类别" };
    expect(faAssignmentsForEntityAccounts(pairs, [manual])).toContainEqual(manual);
    expect(unionEntityAccounts([pairs[0], { ...pairs[0], account: "15010101 固定资产－自有－机械设备" }], [])).toHaveLength(2);
  });

  it("重复编码仅影响分类取名，不放宽税费损益及使用权资产的排除规则", () => {
    for (const [code, name] of [
      ["2221010102", "应交税费-进项税额-固定资产"],
      ["630102", "营业外收入-固定资产报废利得"],
      ["15010105", "使用权资产-固定资产"],
      ["10020101", "银行存款-汉口银行(房屋积金)"],
      ["55000301", "共性费用－固定资产折旧－机械设备"],
      ["2221010102", "应交税费－进项税额－固定资产"],
      ["55000301", "共性费用–固定资产折旧–机械设备"],
    ]) {
      expect(suggestFaAccount(`${code} ${code}\\${name}`).role).toBe("excluded");
    }
    expect(suggestFaAccount("15010101 1501010101\\固定资产-机器设备").role).toBe("excluded");
    expect(suggestFaAccount("15010101 22210101\\固定资产-机器设备").role).toBe("excluded");
  });

  it.skipIf(!process.env.FA_TBJE_CLASSIFICATION_SAMPLE)("真实TB在不映射Account Class时恢复原值分类", () => {
    const sample = JSON.parse(readFileSync(process.env.FA_TBJE_CLASSIFICATION_SAMPLE!, "utf8")) as {
      pairs: Array<{ entity: string; account: string; auxiliary: string; currency: string }>;
      expectedRoles: Record<string, "cost" | "depreciation" | "excluded">;
    };
    const assigned = faAssignmentsForEntityAccounts(faReviewEntityAccounts(sample.pairs), []);
    expect(assigned).toHaveLength(sample.pairs.length);
    for (const row of assigned) {
      const key = JSON.stringify([row.entity, row.account, row.auxiliary ?? "", row.currency ?? ""]);
      expect(row.role, key).toBe(sample.expectedRoles[key]);
    }
    const counts = (roles: string[]) => Object.fromEntries(["cost", "depreciation", "excluded"].map((role) => [role, roles.filter((value) => value === role).length]));
    expect(counts(assigned.map((row) => row.role))).toEqual(counts(Object.values(sample.expectedRoles)));
    console.log("不映射 Account Class 的真实 TB 自动分类：", counts(assigned.map((row) => row.role)));
  });

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
    expect(suggestFaAccount("6711.03 处置固定资产净损失").role).toBe("excluded");
    expect(suggestFaAccount("6711.03 制造部").role).toBe("excluded");
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
    expect(splitFaAccount("01-1401-000-000-000 固定资产-厂房 FA - Buildings")).toEqual({
      code: "01-1401-000-000-000",
      name: "固定资产-厂房 FA - Buildings",
    });
    expect(splitFaAccount("01-1001-000-000-000")).toEqual({
      code: "01-1001-000-000-000",
      name: "",
    });
    // SAP 型余额表把编码拼在串尾
    expect(
      splitFaAccount("固定资产 固定资产-累计折旧-办公设备 1601130001"),
    ).toEqual({
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

  it("TBJEPBC 样例：名称带资产字样的非固定资产科目与编码残留的类别", () => {
    // 02 号样例：银行存款户名带「房屋积金」——宽词（房屋／设备）不参与
    // 非标准编码的进表判断，只有明确写出「固定资产」才算。
    expect(
      suggestFaAccount("1002016871 银行存款-汉口银行硚口支行(房屋积金)6").role,
    ).toBe("excluded");
    // 10 号样例：自定义 1642 使用权资产折旧。原值侧不含使用权资产，
    // 折旧侧混入必然勾稽不平。
    expect(suggestFaAccount("1642 使用权资产累计折旧").role).toBe("excluded");
    expect(suggestFaAccount("1642.01 使用权资产折旧-医药港5期租赁").role).toBe(
      "excluded",
    );
    // 05 号样例：SAP 技术性清账科目不是固定资产本体。
    expect(suggestFaAccount("1601999999 固定资产技术性清账科目").role).toBe(
      "excluded",
    );
    // 08 号样例：名称部分自带一份编码（160101\固定资产\房屋建筑物），
    // 类别要剥干净编码与路径分隔，不能显示成「160101\房屋建筑物」。
    expect(
      suggestFaAccount("160101 160101\\固定资产\\房屋建筑物").category,
    ).toBe("房屋建筑物");
    expect(suggestFaAccount("160101 160101\\固定资产\\房屋建筑物").role).toBe(
      "cost",
    );
    expect(suggestFaAccount("160104 固定资产_办公设备及其他").category).toBe(
      "办公设备及其他",
    );
    expect(normalizeFaCategory("_房屋_建筑物")).toBe("房屋建筑物");
  });

  it("同编码不同名称分别保留自身资产类别", () => {
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
      ["cost", "机器设备-检测仪器"],
      ["depreciation", "机器设备-检测仪器"],
    ]);
  });

  it("科目表没有上级行时按一级编码兜底", () => {
    expect(
      suggestFaAccounts(["16010004 数据处理设备", "16020004 数据处理设备"]).map(
        (item) => item.role,
      ),
    ).toEqual(["cost", "depreciation"]);
  });

  it("非标准编码账套：自身或上级科目名明确写固定资产/累计折旧才进表", () => {
    // 旧制度 1501/1502 形态：上级「1 资产」无语义，靠自身名称进表，
    // 子级沿编码前缀继承；银行存款户名带宽词依旧被挡。
    const chart = [
      "1 资产",
      "1501 固定资产",
      "150101 房屋及建筑物",
      "150102 机械设备",
      "1502 累计折旧",
      "150201 房屋及建筑物",
      "1002 银行存款",
      "1002016871 银行存款-汉口银行(房屋积金)",
    ];
    expect(
      Object.fromEntries(suggestFaAccounts(chart).map((item) => [item.account, item.role])),
    ).toEqual({
      "1 资产": "excluded",
      "1501 固定资产": "cost",
      "150101 房屋及建筑物": "cost",
      "150102 机械设备": "cost",
      "1502 累计折旧": "depreciation",
      "150201 房屋及建筑物": "depreciation",
      "1002 银行存款": "excluded",
      "1002016871 银行存款-汉口银行(房屋积金)": "excluded",
    });
    // 单科目、无上级行可查时：名称明确的进表，宽词的不进。
    expect(suggestFaAccount("1501 固定资产").role).toBe("cost");
    expect(suggestFaAccount("1502 累计折旧").role).toBe("depreciation");
    expect(suggestFaAccount("150101 房屋及建筑物").role).toBe("excluded");
    // 名称含「固定资产」但属费用/清理口径的依旧排除。
    expect(suggestFaAccount("6601090401 折旧费-固定资产").role).toBe("excluded");
    expect(suggestFaAccount("16060001 固定资产清理-设备").role).toBe("excluded");
  });

  it("尾段提及固定资产的税费/损益科目不进表（明确词只认首段）", () => {
    // 实测样例（2026-10-08 用户反馈）：进项税科目尾段的「-固定资产」是辅助核算
    // 标注（这笔税产生自购固定资产），营业外收入的「固定资产报废利得」是损益
    // 修饰——旧的全名包含匹配把它们判成原值，资产类别还被填成科目全名。
    const rows = suggestFaAccounts([
      "2221 应交税费",
      "222101 应交税费-应交增值税",
      "2221010102 应交税费-应交增值税-进项税额-专用发票17%-固定资产",
      "2221010142 应交税费-应交增值税-进项税额-专用发票13%：固定资产",
      "6301 营业外收入",
      "630102 营业外收入-固定资产报废利得",
    ]);
    expect(rows.every((row) => row.role === "excluded")).toBe(true);
    // 无上级科目行可回查的单科目形态同样排除。
    expect(
      suggestFaAccount("2221010102 应交税费-应交增值税-进项税额-专用发票17%-固定资产")
        .role,
    ).toBe("excluded");
    expect(suggestFaAccount("630102 营业外收入-固定资产报废利得").role).toBe("excluded");
    // 首段口径不误伤：名称以「固定资产」开头的非标准编码照常进表，
    // 上下文里上级科目名首段写明的也照常（1998 资产甲样例另测）。
    expect(suggestFaAccount("1501 固定资产-机器设备").role).toBe("cost");
    expect(suggestFaAccount("99 固定资产-电子设备").role).toBe("cost");
    expect(
      suggestFaAccount("1998 资产甲 固定资产-机器设备").role,
    ).toBe("cost");
  });

  it("默认输出文件名带日期与时分秒，路径部分原样保留", () => {
    expect(defaultOutput("D:\\账套\\tb.xlsx", new Date(2026, 9, 8, 9, 5, 3))).toBe(
      "D:\\账套\\FA_TBJE_20261008_090503.xlsx",
    );
    expect(defaultOutput("tb.xlsx", new Date(2026, 9, 8, 21, 42, 5))).toBe(
      "FA_TBJE_20261008_214205.xlsx",
    );
    expect(
      defaultOutput("/data/账套/tb.xlsx", new Date(2026, 11, 31, 23, 59, 59)),
    ).toBe("/data/账套/FA_TBJE_20261231_235959.xlsx");
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
      "期初余额（还缺期初本位币借方、期初本位币贷方；或映射期初本位币净额）",
      "期末余额（还缺期末本位币借方、期末本位币贷方；或映射期末本位币净额）",
      "本年累计借方和贷方发生额",
    ]);
    expect(
      faTbJeMissingMappings("tb", {
        accountCode: "科目编码",
        openingFunctionalDebit: "期初借方",
        openingFunctionalCredit: "期初贷方",
        closingFunctionalAmount: "期末余额",
        ytdFunctionalDebit: "本年借方",
        ytdFunctionalCredit: "本年贷方",
      }),
    ).toEqual([]);
    expect(faTbJeMissingMappings("tb", {
      accountCode: "科目编码",
      openingFunctionalDebit: "期初借方",
      closingFunctionalAmount: "期末净额",
      ytdFunctionalDebit: "本年借方",
      ytdFunctionalCredit: "本年贷方",
    })).toEqual(["期初余额（还缺期初本位币贷方；或映射期初本位币净额）"]);
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

describe("FA TB+JE 真实主体×科目组合", () => {
  it("不同主体的相同编码、名称、辅助和币种保持两条确认行", () => {
    const rows = faAssignmentsForEntityAccounts(faReviewEntityAccounts([
      { entity: "甲公司", account: "160101 机器设备", auxiliary: "生产部", currency: "CNY" },
      { entity: "乙公司", account: "160101 机器设备", auxiliary: "生产部", currency: "CNY" },
    ]), []);
    expect(groupAssignmentViews(rows).map((row) => row.entity)).toEqual(["甲公司", "乙公司"]);
  });

  it("只复核TB原值和折旧，保留TB范围内的非资产排除项", () => {
    const rows = faReviewEntityAccounts([
      { entity: "默认主体", account: "1601020000 固定资产-房屋" },
      { entity: "默认主体", account: "1602020000 累计折旧-房屋" },
      { entity: "默认主体", account: "660201 修理费-房屋建筑物-大修理" },
    ]);
    const assigned = faAssignmentsForEntityAccounts(rows, []);
    expect(assigned).toHaveLength(3);
    expect(assigned.filter((row) => row.role !== "excluded").map((row) => [row.role, row.category]))
      .toEqual([["cost", "房屋"], ["depreciation", "房屋"]]);
    expect(assigned.find((row) => row.account.startsWith("660201"))?.role).toBe("excluded");
  });

  it("只有 TB 有主体映射时，复核项使用测算引擎的默认主体", () => {
    const rows = faReviewEntityAccounts([
      { entity: "3000", account: "130010 PP&E - Land 固定资产-土地" },
      { entity: "3000", account: "140000 Accumulated Depreciation 累计折旧" },
    ], false);
    expect(rows.map((row) => row.entity)).toEqual(["默认主体", "默认主体"]);
    expect(faAssignmentsForEntityAccounts(rows, []).map((row) => row.role)).toEqual([
      "cost", "depreciation",
    ]);
  });

  it("分段科目编码不按账套段合并，保留各原值和折旧科目", () => {
    const names = [
      "01-1001-000-000-000 库存现金 Cash on hand",
      "01-1401-000-000-000 固定资产-厂房 FA - Buildings",
      "01-1402-000-000-000 固定资产-机器设备 FA - Machinery",
      "01-1451-000-000-000 累计折旧 Accumulated depreciation",
    ];
    const rows = faAssignmentsForEntityAccounts(
      names.map((account) => ({ entity: "默认主体", account })), [],
    );
    const views = groupAssignmentViews(rows);
    expect(views).toHaveLength(4);
    expect(views.map((view) => view.role)).toEqual([
      "cost", "cost", "depreciation", "excluded",
    ]);
  });

  it("只按账里真实存在的组合铺清单，主体 2000 名下不出现只有 2002 才有的科目", () => {
    const pairs = unionEntityAccounts(
      [
        {
          entity: "2000",
          account: "1601040000 Fixed assets_Transportaion equipment",
        },
        {
          entity: "2000",
          account: "1601020000 Fixed assets_Machinery equipment",
        },
      ],
      [{ entity: "2002", account: "1601020000" }],
    );
    expect(pairs).toHaveLength(3);
    const rows = faAssignmentsForEntityAccounts(pairs, []);
    // 旧笛卡尔积口径下这会是「2 主体 × 3 科目 = 6 行」，其中一半是幻影组合。
    expect(rows).toHaveLength(3);
    const codesUnder2000 = rows
      .filter((row) => row.entity === "2000")
      .map((row) => splitFaAccount(row.account).code);
    expect(codesUnder2000).toEqual(["1601040000", "1601020000"]);
    // 1601020000 在 2000 名下只来自 TB 的带名称写法，2002 名下只有纯编码写法。
    expect(
      rows
        .filter((row) => splitFaAccount(row.account).code === "1601020000")
        .map((row) => row.entity),
    ).toEqual(["2000", "2002"]);
    // 2002 的纯编码写法保留原串，payload 逐条匹配用。
    expect(rows.find((row) => row.entity === "2002")?.account).toBe(
      "1601020000",
    );
  });

  it("同主体同编码但名称不同的两种写法分别保留", () => {
    const pairs = unionEntityAccounts(
      [
        {
          entity: "2000",
          account: "1601020000 Fixed assets_Machinery equipment",
        },
      ],
      [{ entity: "2000", account: "1601020000" }],
    );
    const rows = faAssignmentsForEntityAccounts(pairs, []);
    // payload 级：两种写法各自成行、缺一不可（引擎按这些串逐侧匹配）。
    expect(rows.map((row) => row.account)).toEqual([
      "1601020000 Fixed assets_Machinery equipment",
      "1601020000",
    ]);
    // 两种写法经自动归一拿到同一角色与类别。
    expect(new Set(rows.map((row) => `${row.role}|${row.category}`))).toEqual(
      new Set(["cost|Machinery equipment"]),
    );
    const views = groupAssignmentViews(rows);
    expect(views).toHaveLength(2);
    expect(views[0].label).toBe("1601020000 Fixed assets_Machinery equipment");
    expect(views[0].accounts).toEqual(["1601020000 Fixed assets_Machinery equipment"]);
  });

  it("保留用户已确认的角色与类别（按主体＋科目串匹配），排序口径与旧版一致", () => {
    const pairs = unionEntityAccounts(
      [
        { entity: "A", account: "1002 银行存款" },
        { entity: "A", account: "1601 固定资产" },
      ],
      [{ entity: "B", account: "1602 累计折旧" }],
    );
    const rows = faAssignmentsForEntityAccounts(pairs, [
      {
        entity: "A",
        account: "1601 固定资产",
        role: "depreciation",
        category: "机修设备",
      },
    ]);
    expect(rows.map((row) => [row.entity, row.account])).toEqual([
      ["A", "1601 固定资产"],
      ["B", "1602 累计折旧"],
      ["A", "1002 银行存款"],
    ]);
    expect(rows[0]).toEqual({
      entity: "A",
      account: "1601 固定资产",
      role: "depreciation",
      category: "机修设备",
    });
  });

  it("跨主体统一把原值和折旧排在排除科目前面", () => {
    const rows = faAssignmentsForEntityAccounts(
      [
        { entity: "2000", account: "1002 银行存款" },
        { entity: "2000", account: "1601040000 固定资产-运输设备" },
        { entity: "2002", account: "1601020000 固定资产-机器设备" },
        { entity: "2002", account: "1602020000 累计折旧-机器设备" },
      ],
      [],
    );
    expect(rows.map((row) => [row.entity, row.role])).toEqual([
      ["2000", "cost"],
      ["2002", "cost"],
      ["2002", "depreciation"],
      ["2000", "excluded"],
    ]);
  });

  it("认不出编码的科目按科目串本身分组，互不混并", () => {
    const views = groupAssignmentViews([
      {
        entity: "A",
        account: "Accumulated Depreciation",
        role: "depreciation",
        category: "固定资产",
      },
      {
        entity: "A",
        account: "Accumulated Depreciation - Vehicles",
        role: "depreciation",
        category: "固定资产",
      },
    ]);
    expect(views).toHaveLength(2);
    expect(views.map((view) => view.label)).toEqual([
      "Accumulated Depreciation",
      "Accumulated Depreciation - Vehicles",
    ]);
  });

  it("两侧 entityAccounts 均为空时得到空清单（页面据此回退笛卡尔积）", () => {
    expect(unionEntityAccounts([], [])).toEqual([]);
    expect(unionEntityAccounts(undefined, undefined)).toEqual([]);
  });
});

describe("FA TB+JE 三步向导（源码契约）", () => {
  const source = readFileSync(
    "src/FaTbJePage.tsx",
    "utf8",
  );
  const stepOne = source.slice(
    source.indexOf("{step === 1 && ("),
    source.indexOf("{step === 2 && ("),
  );

  it("步骤条只有三步：上传与映射、科目复核、预览与导出", () => {
    const stepsArray = source.slice(
      source.indexOf("steps={["),
      source.indexOf("]}", source.indexOf("steps={[")),
    );
    expect(stepsArray.match(/key: "/g)).toHaveLength(3);
    expect(stepsArray).toContain('label: "上传与映射"');
    expect(stepsArray).toContain('label: "科目复核"');
    expect(stepsArray).toContain('label: "预览与导出"');
    expect(source).not.toContain('label: "上传与识别"');
    expect(source).not.toContain('label: "字段映射"');
  });

  it("第 1 步同屏承载源卡片、LLM 联合复核与两侧字段映射面板", () => {
    expect(stepOne).toContain("FaLedgerSourceCard");
    expect(stepOne).toContain("<LedgerReviewAll");
    expect(stepOne).toContain("<FaTbJeMappingPanel");
    expect(stepOne).not.toContain("继续核对字段");
    expect(source).not.toContain("返回上传\n");
  });

  it("第 1 步底部门禁为「TB/JE 均已识别且必填字段映射完成」，按钮为复核科目分类", () => {
    expect(stepOne).toContain("复核科目分类");
    expect(stepOne).toContain("disabled={!mappingsReady || reviewing || busy}");
    expect(stepOne).toContain("openAccountReview");
  });

  it("payload只提交当前TB目录内的确认项，历史JE分类不会进入复核或任务", () => {
    expect(source).toContain("accountAssignments: tbAssignments");
    expect(source).toContain("faConfirmedTbAssignments(entityAccountPairs, assignments)");
    expect(source).toContain("groupAssignmentViews(tbAssignments)");
  });

  it("复核表只确认TB类别与角色，无JE分类标签或门禁，提供科目筛选", () => {
    expect(source).toContain('<div className="fa-tbje-account-cell">');
    expect(source).not.toContain(
      '<td\n                        className="fa-tbje-account-cell"',
    );
    expect(source).toContain(
      'faReviewEntityAccounts(faInspectionAccounts(inspects.tb), entityKeyEnabled)',
    );
    expect(source).toContain('assignmentBasis: "assetRoleCategory"');
    expect(source).not.toContain("hasConfirmedJe");
    expect(source).not.toContain("尚未确认 JE 来源科目");
    expect(source).not.toContain("view.sources");
    expect(source).toContain("JE 分录自动承接分类并汇总变动");
    expect(source).toContain('ariaLabel="筛选科目"');
    expect(source).toContain('placeholder="输入科目编码或名称"');
    expect(source).not.toContain('className="fa-tbje-source-tag"');
    expect(source).not.toContain("批量资产类别");
  });

  it("切换 FA 子工具时缓存并恢复 TB+JE 草稿", () => {
    expect(source).toContain("let faTbJeDraftCache");
    expect(source).toContain("faTbJeDraftCache = {");
    expect(source).toContain("faTbJeDraftCache?.mappings");
    expect(source).toContain("faTbJeDraftCache?.assignments");
  });
});

describe("FA只复核TB的实际页面流程", () => {
  const pairs = [
    { entity: "默认主体", account: "160101 固定资产-机器设备", auxiliary: "", currency: "CNY" },
    { entity: "默认主体", account: "160201 累计折旧-机器设备", auxiliary: "", currency: "CNY" },
    { entity: "默认主体", account: "1002 银行存款", auxiliary: "", currency: "CNY" },
  ];
  const inspection = (kind: "tb" | "je"): Inspection => ({
    sheet: "Sheet1", sheets: ["Sheet1"], headerRow: 1, headerDepth: 1, rowCount: 12,
    headers: ["科目", "期初", "期末", "凭证", "日期", "借方", "贷方", "本年借方", "本年贷方"], preview: [],
    entities: ["默认主体"], accounts: kind === "tb" ? pairs.map((row) => row.account) : ["160101", "160201", "6601"],
    entityAccounts: kind === "tb" ? pairs : [{ entity: "默认主体", account: "JE独有费用科目" }],
    reviewAccounts: kind === "tb" ? pairs : [],
    suggestedMapping: {}, suggestedAccountRoles: {}, mappingCandidates: [],
    headerDetection: { needsConfirmation: false, candidates: [] }, dataYears: [2026],
  });
  const restore = (withSnapshot = true): TaskRestore => ({
    toolId: "fa_list", jobId: "old-two-sided", method: "fa.tbje_preview", missingPaths: [], authorizedPathCount: 2,
    params: {
      tbSource: { inputPath: "D:\\tb.xlsx", sheet: "Sheet1" },
      jeSource: { inputPath: "D:\\je.xlsx", sheet: "Sheet1" },
      tbMapping: { accountName: "科目", openingFunctionalAmount: "期初", closingFunctionalAmount: "期末", currency: "币种", ytdFunctionalDebit: "本年借方", ytdFunctionalCredit: "本年贷方" },
      jeMapping: { accountName: "科目", id: "凭证", date: "日期", functionalDebit: "借方", functionalCredit: "贷方" },
      accountAssignments: [
        { ...pairs[0], role: "cost", category: "人工类别" },
        { ...pairs[1], role: "depreciation", category: "人工类别" },
        { ...pairs[2], role: "excluded", category: "明确排除" },
        { entity: "默认主体", account: "JE独有费用科目", role: "cost", category: "错误旧JE分类" },
      ], outputPath: "D:\\output.xlsx",
    },
    snapshotStatus: withSnapshot ? "valid" : "none",
    snapshot: withSnapshot ? { inspects: { tb: inspection("tb"), je: inspection("je") } } : null,
  });
  const prepare = () => {
    pageMock.engineCall.mockReset();
    pageMock.jobStart.mockReset().mockResolvedValue("preview-tb-only");
    pageMock.engineCall.mockImplementation(async (method: string) => {
      if (method === "deposit.inspect_tb") return inspection("tb");
      if (method === "deposit.inspect_je") return inspection("je");
      if (method === "ledger.auxiliary_link") return { status: "not_required", groups: [] };
      if (method === "ledger.forms") return [];
      return {};
    });
  };

  it("旧两侧历史任务只列TB且无需JE分类即可继续和启动预览", async () => {
    prepare();
    render(createElement(FaTbJePage));
    act(() => publishTaskRestore(restore()));
    fireEvent.click(await screen.findByRole("button", { name: "下一步：复核科目分类" }));
    const confirm = await screen.findByRole("button", { name: "确认复核并继续" });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.queryByText("JE独有费用科目")).not.toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
    expect(screen.getByLabelText(`${pairs[0].account}的资产类别`)).toHaveValue("人工类别");
    expect(screen.getByLabelText(`${pairs[2].account}的科目角色`)).toHaveValue("excluded");
    expect(pageMock.engineCall.mock.calls.filter(([method]) => method === "deposit.inspect_tb")).toHaveLength(1);
    expect(pageMock.engineCall.mock.calls.some(([method]) => method === "deposit.inspect_je")).toBe(false);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "生成预览" }));
    await waitFor(() => expect(pageMock.jobStart).toHaveBeenCalledOnce());
    const [method, params] = pageMock.jobStart.mock.calls[0];
    expect(method).toBe("fa.tbje_preview");
    expect(params.assignmentBasis).toBe("assetRoleCategory");
    const previous = restore().params.accountAssignments as ReturnType<typeof faAssignmentsForEntityAccounts>;
    expect(params.accountAssignments).toEqual(previous.slice(0, 3));
    expect(screen.queryByText(/尚未确认 JE 来源科目/)).not.toBeInTheDocument();
  });

  it("取消TB累计贷方映射立即提示并阻止进入科目复核，补回恢复", async () => {
    prepare();
    render(createElement(FaTbJePage));
    act(() => publishTaskRestore(restore()));
    const next = await screen.findByRole("button", {name:"下一步：复核科目分类"});
    await waitFor(() => expect(next).toBeEnabled());
    const credit = screen.getAllByRole("combobox", {name:"将「本年贷方」映射为字段"})[0];
    fireEvent.change(credit,{target:{value:""}});
    expect(screen.getByText("尚未映射：本年累计借方和贷方发生额")).toBeInTheDocument();
    expect(next).toBeDisabled();
    fireEvent.change(credit,{target:{value:"ytdFunctionalCredit"}});
    expect(next).toBeEnabled();
  });

  it("无可用快照时重新读取来源仍保留TB人工类别且过滤旧JE项", async () => {
    prepare();
    render(createElement(FaTbJePage));
    act(() => publishTaskRestore(restore(false)));
    const next = await screen.findByRole("button", { name: "下一步：复核科目分类" });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    await screen.findByRole("button", { name: "确认复核并继续" });
    expect(screen.getByLabelText(`${pairs[0].account}的资产类别`)).toHaveValue("人工类别");
    expect(screen.queryByText("JE独有费用科目")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认复核并继续" })).toBeEnabled();
  });

  it("TB显式空选层目录不带回父项，不用JE项补足原值门禁", async () => {
    prepare();
    pageMock.engineCall.mockImplementation(async (method: string) => {
      if (method === "deposit.inspect_tb") return { ...inspection("tb"), reviewAccounts: [] };
      if (method === "ledger.auxiliary_link") return { status: "not_required", groups: [] };
      return [];
    });
    render(createElement(FaTbJePage));
    act(() => publishTaskRestore(restore()));
    fireEvent.click(await screen.findByRole("button", { name: "下一步：复核科目分类" }));
    const confirm = await screen.findByRole("button", { name: "确认复核并继续" });
    expect(confirm).toBeDisabled();
    expect(screen.getByText("没有可复核的 TB 科目。")).toBeInTheDocument();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });
});
