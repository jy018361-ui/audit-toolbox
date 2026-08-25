import { describe, expect, it } from "vitest";
import {
  DEP_MAPPING_ROLES,
  depMissingOptionalRoles,
  depMissingRoles,
  faDepDefaultOutputName,
  faDepDefaultOutputPath,
  faPolicyDefaultOutputName,
  faPolicyDefaultOutputPath,
  planDepLlmChanges,
  POLICY_MAPPING_ROLES,
  policyMissingOptionalRoles,
  policyMissingRoles,
} from "./faSubtoolsUi";

describe("FA 子工具角色表与缺失检查", () => {
  it("折旧测算的必填角色与 Rust 侧公式块要求一致（六项）", () => {
    // 类别/名称是选填；六个公式源列缺一不可，否则后端拒绝导出。
    expect(
      depMissingRoles({
        category: "",
        name: "",
        originalValue: "原值",
        depreciation: "累计折旧",
        startDate: "入账开始日期",
        life: "使用寿命",
        residualRate: "残值率",
        currentYearDep: "本年折旧",
      }),
    ).toEqual([]);
    const missing = depMissingRoles({
      originalValue: "原值",
      startDate: "入账开始日期",
      life: "使用寿命",
    });
    expect(missing).toEqual(["累计折旧", "残值率", "本年折旧"]);
    expect(depMissingOptionalRoles({ category: "", name: "" })).toEqual([
      "资产类别",
      "资产名称",
    ]);
    expect(depMissingOptionalRoles({ category: "资产类别", name: "名称" })).toEqual([]);
  });

  it("折旧政策对比必填角色与 FA 主工具一致（类别/名称/原值/累计折旧）", () => {
    const full = {
      category: "类别",
      name: "名称",
      originalValue: "原值",
      depreciation: "累计折旧",
    };
    expect(policyMissingRoles(full)).toEqual([]);
    expect(policyMissingRoles({ category: "类别", name: "名称" })).toEqual([
      "原值",
      "累计折旧",
    ]);
  });

  it("政策对比选填提示按侧过滤：期初不提醒文件2专属角色", () => {
    const sparse = {
      category: "类别",
      name: "名称",
      originalValue: "原值",
      depreciation: "累计折旧",
    };
    // 期初：开始日期/寿命/残值率未映射要提醒；本年折旧/新增组不出现在该侧。
    expect(policyMissingOptionalRoles("begin", sparse)).toEqual([
      "开始使用日期",
      "使用寿命",
      "残值率",
    ]);
    // 期末：完整选填集（含本年折旧/新增方式/新增日期）。
    expect(policyMissingOptionalRoles("end", sparse)).toEqual([
      "开始使用日期",
      "使用寿命",
      "残值率",
      "本年折旧",
      "新增方式",
      "新增日期",
    ]);
    const full = {
      ...sparse,
      startDate: "开始日期",
      life: "寿命",
      residualRate: "残值率",
      currentYearDep: "本年折旧",
      additionMethod: "新增方式",
      additionDate: "新增日期",
    };
    expect(policyMissingOptionalRoles("end", full)).toEqual([]);
    expect(policyMissingOptionalRoles("begin", full)).toEqual([]);
  });

  it("政策对比角色表与 FA 主工具同构（十个角色、同名同序）", () => {
    expect(POLICY_MAPPING_ROLES).toEqual([
      ["category", "资产类别"],
      ["name", "资产名称"],
      ["originalValue", "原值"],
      ["depreciation", "累计折旧"],
      ["startDate", "开始使用日期"],
      ["life", "使用寿命"],
      ["residualRate", "残值率"],
      ["currentYearDep", "本年折旧"],
      ["additionMethod", "新增方式"],
      ["additionDate", "新增日期"],
    ]);
    expect(DEP_MAPPING_ROLES.map(([key]) => key)).toContain("currentYearDep");
  });
});

describe("FA 子工具默认输出路径", () => {
  it("默认名带工具前缀与时间戳，落在源文件所在目录", () => {
    expect(faDepDefaultOutputName(new Date(2026, 7, 16, 9, 5, 3))).toBe(
      "折旧测算_20260816_090503.xlsx",
    );
    expect(faPolicyDefaultOutputName(new Date(2026, 7, 16, 9, 5, 3))).toBe(
      "折旧政策对比_20260816_090503.xlsx",
    );
    expect(
      faDepDefaultOutputPath("D:\\审计资料\\期末清单.xlsx", new Date(2026, 7, 16)),
    ).toBe("D:\\审计资料\\折旧测算_20260816_000000.xlsx");
    // 混用分隔符的拼接口径与主工具 faDefaultOutputPath 一致（目录保留原样，连接符用 \）。
    expect(
      faPolicyDefaultOutputPath("D:/审计资料/期末清单.xlsx", new Date(2026, 7, 16)),
    ).toBe("D:/审计资料\\折旧政策对比_20260816_000000.xlsx");
    expect(faDepDefaultOutputPath("期末清单.xlsx")).toBe("");
  });
});

describe("折旧测算单文件 LLM 复核规划器", () => {
  it("高把握建议直接应用并进变更清单，低把握进待定", () => {
    const plan = planDepLlmChanges({
      mapping: { originalValue: "原值", life: "寿命" },
      autoApplied: [
        {
          role: "residual",
          file_side: "file2",
          suggested_column: "残值率",
          confidence: 0.95,
        },
      ],
      fieldReviews: [
        {
          role: "depreciation",
          file_side: "file2",
          suggested_column: "累计折旧",
          confidence: 0.5,
        },
      ],
    });
    expect(plan.mapping.residualRate).toBe("残值率");
    expect(plan.changes.map((change) => change.label)).toEqual(["残值率"]);
    expect(plan.pending.map((item) => item.label)).toEqual(["累计折旧"]);
  });

  it("越权角色（政策外的新增方式等）不会进入映射", () => {
    const plan = planDepLlmChanges({
      mapping: {},
      autoApplied: [
        {
          role: "addition_method",
          file_side: "file2",
          suggested_column: "新增方式",
          confidence: 0.99,
        },
      ],
    });
    expect(plan.mapping).toEqual({});
    expect(plan.changes).toEqual([]);
  });

  it("同字段的多次建议只呈现净变化，撤销可回到最初值", () => {
    const plan = planDepLlmChanges({
      mapping: { life: "寿命(月)" },
      autoApplied: [
        {
          role: "life",
          file_side: "file2",
          suggested_column: "使用寿命",
          confidence: 0.9,
        },
      ],
    });
    expect(plan.mapping.life).toBe("使用寿命");
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].before).toBe("寿命(月)");
    expect(plan.changes[0].restore.value).toBe("寿命(月)");
  });
});
