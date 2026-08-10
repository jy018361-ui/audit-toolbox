import { describe, expect, it } from "vitest";
import {
  canApplyFaSupplements,
  faDefaultOutputPath,
  faMappedRolesForColumn,
  faMissingOptionalRoles,
  faOutputPathAfterSourceSelection,
  faHeaderOption,
  faReviewNarrative,
  faReviewReasons,
  faReviewSummary,
  faRolesForSide,
  isFaMatchDisabled,
  normalizeFaSuggestedMapping,
  planFaLlmChanges,
  planFaSupplementChanges,
  sanitizeFaBeginMapping,
  shouldAutoPrefillFaAddition,
  shouldShowFaAdditionFields,
  shouldShowFaPreviewWorkspace,
} from "./faListUi";

const roleLabels = {
  category: "资产类别",
  name: "资产名称",
  originalValue: "原值",
  depreciation: "累计折旧",
  startDate: "开始使用日期",
};
const baseInput = {
  beginMapping: { originalValue: "期末原值", category: "类别" },
  endMapping: { originalValue: "资产原值" },
  beginKeys: ["资产编号"],
  endKeys: ["编号"],
  roleLabels,
};

describe("FA List migration parity", () => {
  it("hides the optional addition group when addition method is unmapped", () => {
    expect(shouldShowFaAdditionFields(undefined)).toBe(false);
    expect(shouldShowFaAdditionFields(" ")).toBe(false);
    expect(shouldShowFaAdditionFields("变动方式")).toBe(true);
  });

  it("does not let an LLM failure disable the deterministic merge button", () => {
    expect(isFaMatchDisabled(true, false)).toBe(false);
    expect(isFaMatchDisabled(false, false)).toBe(true);
    expect(isFaMatchDisabled(true, true)).toBe(true);
  });

  it("clears a prior sample's save target when either source workbook changes", () => {
    const priorOutput = "C:\\sample-01\\FA_List.xlsx";
    expect(
      faOutputPathAfterSourceSelection(
        priorOutput,
        "C:\\sample-01\\begin.xlsx",
        "C:\\sample-02\\begin.xlsx",
      ),
    ).toBe("");
    expect(
      faOutputPathAfterSourceSelection(
        priorOutput,
        "C:\\sample-01\\begin.xlsx",
        "C:\\sample-01\\begin.xlsx",
      ),
    ).toBe(priorOutput);
  });

  it("默认输出路径与 Rust fa::output_path 一致：期末文件旁 + FA_List_<时间戳>.xlsx", () => {
    const now = new Date(2026, 7, 8, 18, 5, 42);
    expect(faDefaultOutputPath("C:\\客户\\2025\\期末固定资产.xlsx", now)).toBe(
      "C:\\客户\\2025\\FA_List_20260808_180542.xlsx",
    );
    // 盘符根目录下的文件不能算成 "C:"
    expect(faDefaultOutputPath("C:\\期末.xlsx", now)).toBe(
      "C:\\FA_List_20260808_180542.xlsx",
    );
    // 没有目录信息时不猜路径，交回空串让界面继续显示占位提示
    expect(faDefaultOutputPath("", now)).toBe("");
  });

  it("lets file2's own 新增方式 count as the supplement instead of forcing 跳过", () => {
    // Nothing browsed and file2 carries no 新增方式: there is genuinely nothing
    // to apply.
    expect(canApplyFaSupplements("", "", undefined)).toBe(false);
    expect(canApplyFaSupplements("", "", " ")).toBe(false);
    // file2 carries 新增方式 — the 新增清单 is already complete, and an empty
    // 处置清单 just means the period had no disposals.
    expect(canApplyFaSupplements("", "", "变动方式")).toBe(true);
    expect(canApplyFaSupplements("C:/新增.xlsx", "", undefined)).toBe(true);
    expect(canApplyFaSupplements("", "C:/处置.xlsx", undefined)).toBe(true);
  });

  it("does not treat an addition date alone as a supplemental addition list", () => {
    expect(shouldAutoPrefillFaAddition(undefined, 12, false)).toBe(false);
    expect(shouldAutoPrefillFaAddition("", 12, false)).toBe(false);
    expect(shouldAutoPrefillFaAddition("新增方式", 0, false)).toBe(false);
    expect(shouldAutoPrefillFaAddition("新增方式", 12, true)).toBe(false);
    expect(shouldAutoPrefillFaAddition("新增方式", 12, false)).toBe(true);
  });

  it("preserves whitespace in an Excel header value while trimming its label", () => {
    expect(faHeaderOption(" 使用寿命(月)")).toEqual({
      value: " 使用寿命(月)",
      label: "使用寿命(月)",
    });
    expect(faHeaderOption(" 残值率 ")).toEqual({
      value: " 残值率 ",
      label: "残值率",
    });
  });

  it("keeps the right preview workspace throughout file and supplement setup", () => {
    expect(shouldShowFaPreviewWorkspace(1, false)).toBe(true);
    expect(shouldShowFaPreviewWorkspace(1, true)).toBe(true);
    expect(shouldShowFaPreviewWorkspace(2, true)).toBe(true);
    expect(shouldShowFaPreviewWorkspace(3, true)).toBe(false);
  });

  it("never renders a malformed LLM mapping string character by character", () => {
    expect(
      normalizeFaSuggestedMapping("file1: 期末原值; file2: 资产原值"),
    ).toEqual({});
    expect(
      normalizeFaSuggestedMapping({ file1: " 期末原值 ", file2: "资产原值" }),
    ).toEqual({ file1: "期末原值", file2: "资产原值" });
  });

  it("文件1始终移除仅适用于文件2的年度折旧和新增字段", () => {
    expect(
      sanitizeFaBeginMapping({
        category: "资产类别",
        currentYearDep: "本年折旧",
        additionMethod: "资产来源",
        additionDate: "资本化日期",
      }),
    ).toEqual({ category: "资产类别" });
  });
});

describe("FA LLM 复核先改后核", () => {
  it("重新复核能把已取消的开始使用日期映射补回对应文件", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      beginMapping: { ...baseInput.beginMapping, startDate: undefined },
      endMapping: { ...baseInput.endMapping, startDate: undefined },
      autoApplied: [
        {
          role: "date",
          file_side: "file1",
          suggested_column: "开始使用日期",
          confidence: 0.95,
        },
        {
          role: "date",
          file_side: "file2",
          suggested_column: "开始使用日期",
          confidence: 0.95,
        },
      ],
    });
    expect(plan.beginMapping.startDate).toBe("开始使用日期");
    expect(plan.endMapping.startDate).toBe("开始使用日期");
    expect(plan.changes.map((item) => item.id)).toEqual([
      "begin.startDate",
      "end.startDate",
    ]);
  });

  it("忽略 LLM 对文件1的本年折旧、新增方式和新增日期建议", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      beginMapping: {
        ...baseInput.beginMapping,
        currentYearDep: "旧本年折旧",
        additionMethod: "旧新增方式",
        additionDate: "旧新增日期",
      },
      autoApplied: [
        { role: "current_year_dep", file_side: "file1", suggested_column: "本年折旧" },
        { role: "addition_method", file_side: "file1", suggested_column: "资产来源" },
        { role: "addition_date", file_side: "file1", suggested_column: "资本化日期" },
      ],
      fieldReviews: [
        { role: "current_year_dep", suggested_mapping: { file1: "本年折旧", file2: "本年至今折旧" } },
      ],
    });
    expect(plan.beginMapping.currentYearDep).toBeUndefined();
    expect(plan.beginMapping.additionMethod).toBeUndefined();
    expect(plan.beginMapping.additionDate).toBeUndefined();
    expect(plan.endMapping.currentYearDep).toBe("本年至今折旧");
    expect(plan.changes.map((item) => item.id)).toEqual(["end.currentYearDep"]);
    expect(plan.pending).toEqual([]);
  });
  it("覆盖已有映射时留下改前改后和撤销所需的原值", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      autoApplied: [
        {
          role: "original_value",
          file_side: "file1",
          suggested_column: "期初原值",
          confidence: 0.92,
          reason: "该列才是期初原值",
        },
      ],
    });
    expect(plan.beginMapping.originalValue).toBe("期初原值");
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      label: "期初 原值",
      before: "期末原值",
      after: "期初原值",
      attention: false,
      restore: {
        kind: "mapping",
        side: "begin",
        key: "originalValue",
        value: "期末原值",
      },
    });
  });

  it("原本没映射的字段显示成未映射而不是空白", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      fieldReviews: [
        {
          role: "depreciation",
          suggested_mapping: { file1: "累计折旧额" },
          confidence: 0.9,
        },
      ],
    });
    expect(plan.changes[0]).toMatchObject({
      label: "期初 累计折旧",
      before: "未映射",
      after: "累计折旧额",
    });
    expect(plan.changes[0].restore).toEqual({
      kind: "mapping",
      side: "begin",
      key: "depreciation",
      value: undefined,
    });
  });

  it("建议与现有映射一致时不产生变更", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      autoApplied: [
        {
          role: "original_value",
          file_side: "file1",
          suggested_column: " 期末原值 ",
          confidence: 0.99,
        },
      ],
      matchReview: { action: "keep" },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.beginMapping.originalValue).toBe("期末原值");
  });

  it("把握 60% 到 70% 之间照改，但标为需重点核对", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      fieldReviews: [
        {
          role: "category",
          suggested_mapping: { file1: "资产分类" },
          confidence: 0.65,
        },
      ],
    });
    expect(plan.beginMapping.category).toBe("资产分类");
    expect(plan.changes[0].attention).toBe(true);
    expect(plan.pending).toEqual([]);
  });

  it("把握不足 60% 的一律不改，交回用户采纳", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      fieldReviews: [
        {
          role: "category",
          suggested_mapping: { file1: "资产分类" },
          confidence: 0.45,
          reason: "两列都像类别",
        },
      ],
    });
    // 映射保持原样
    expect(plan.beginMapping.category).toBe("类别");
    expect(plan.changes).toEqual([]);
    expect(plan.pending).toEqual([
      {
        id: "begin.category",
        label: "期初 资产类别",
        current: "类别",
        suggested: "资产分类",
        reason: "两列都像类别",
        confidence: 0.45,
        apply: {
          kind: "mapping",
          side: "begin",
          key: "category",
          value: "资产分类",
        },
      },
    ]);
  });

  it("把握不足的匹配键建议也不自动改", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      matchReview: {
        action: "replace",
        confidence: 0.3,
        suggested_file1_columns: ["资产编号", "名称"],
        suggested_file2_columns: ["编号", "名称"],
      },
    });
    expect(plan.beginKeys).toEqual(["资产编号"]);
    expect(plan.endKeys).toEqual(["编号"]);
    expect(plan.changes).toEqual([]);
    expect(plan.pending[0]).toMatchObject({
      id: "matchKeys",
      apply: {
        kind: "matchKeys",
        begin: ["资产编号", "名称"],
        end: ["编号", "名称"],
      },
    });
  });

  it("匹配键改动会整组记录，撤销可还原两侧", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      matchReview: {
        action: "replace",
        confidence: 0.8,
        suggested_file1_columns: ["资产编号", "资产名称"],
        suggested_file2_columns: ["编号", "名称"],
        reasons: ["单列编号不唯一"],
      },
    });
    expect(plan.beginKeys).toEqual(["资产编号", "资产名称"]);
    expect(plan.endKeys).toEqual(["编号", "名称"]);
    expect(plan.changes[0]).toMatchObject({
      label: "匹配 ID",
      before: "期初 资产编号；期末 编号",
      after: "期初 资产编号 + 资产名称；期末 编号 + 名称",
      // 匹配键错了整张表都对不上，始终提示核对
      attention: true,
      restore: { kind: "matchKeys", begin: ["资产编号"], end: ["编号"] },
    });
  });

  it("两侧匹配键数量对不上时不动用户的设置", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      matchReview: {
        action: "replace",
        suggested_file1_columns: ["资产编号", "资产名称"],
        suggested_file2_columns: ["编号"],
      },
    });
    expect(plan.beginKeys).toEqual(["资产编号"]);
    expect(plan.endKeys).toEqual(["编号"]);
    expect(plan.changes).toEqual([]);
  });

  it("同一字段被连续改动时只呈现净变化", () => {
    const plan = planFaLlmChanges({
      ...baseInput,
      autoApplied: [
        {
          role: "original_value",
          file_side: "file1",
          suggested_column: "原值A",
          confidence: 0.9,
        },
      ],
      fieldReviews: [
        {
          role: "original_value",
          suggested_mapping: { file1: "原值B" },
          confidence: 0.8,
          reason: "复核后改用 B",
        },
      ],
    });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      before: "期末原值",
      after: "原值B",
      restore: { value: "期末原值" },
    });
  });

  it("复核结论分别交代改了什么和还要你定什么", () => {
    expect(faReviewSummary(2)).toBe(
      "LLM 复核完成：已自动调整 2 项，不合适可逐条撤销。",
    );
    expect(faReviewSummary(2, 1)).toBe(
      "LLM 复核完成：已自动调整 2 项，不合适可逐条撤销；另有 1 项把握不足 60%，未改动，请确认是否采纳。",
    );
    expect(faReviewSummary(0, 1)).toBe(
      "LLM 复核完成：另有 1 项把握不足 60%，未改动，请确认是否采纳。",
    );
    expect(faReviewSummary(0)).toBe(
      "LLM 复核完成：现有映射与 LLM 判断一致，未做改动。",
    );
    expect(
      faReviewNarrative(
        "LLM 复核完成：现有脚本映射无需补充，匹配键已复核。",
        0,
      ),
    ).toBe("LLM 复核完成：现有脚本映射无需补充，匹配键已复核。");
    expect(faReviewNarrative("LLM 映射复核完成。", 2, 1)).toBe(
      "LLM 复核完成：已自动调整 2 项，不合适可逐条撤销；另有 1 项把握不足 60%，未改动，请确认是否采纳。",
    );
    expect(faReviewNarrative("LLM 映射复核完成。", 0)).toBe(
      "LLM 复核完成：现有映射与 LLM 判断一致，未做改动。",
    );
    expect(
      faReviewReasons(
        [{ reason: "原值列样例均为金额" }],
        [{ reason: "原值列样例均为金额" }, { reason: "日期格式一致" }],
        ["匹配 ID 两侧口径一致"],
      ),
    ).toEqual(["原值列样例均为金额", "日期格式一致", "匹配 ID 两侧口径一致"]);
  });
});

describe("FA 补充清单 LLM 复核先改后核", () => {
  const supplement = () => ({
    addition: { method: "变动方式", date: "", keys: ["资产编号"] },
    disposal: {
      method: "",
      date: "",
      originalValue: "原值",
      depreciation: "",
      keys: [] as string[],
    },
  });

  it("按角色前缀落到新增或处置清单，并记录改前改后", () => {
    const plan = planFaSupplementChanges({
      ...supplement(),
      autoApplied: [
        {
          role: "addition_date",
          file_side: "file1",
          suggested_column: "入账日期",
          confidence: 0.9,
        },
      ],
      fieldReviews: [
        {
          role: "disposal_orig",
          suggested_mapping: { file2: "处置原值" },
          // 正好压线，仍然自动改
          confidence: 0.6,
          reason: "该列才是处置原值",
        },
      ],
    });
    expect(plan.addition.date).toBe("入账日期");
    expect(plan.disposal.originalValue).toBe("处置原值");
    const dateChange = plan.changes.find((item) => item.id === "addition.date");
    expect(dateChange).toMatchObject({
      label: "新增清单 变动日期",
      before: "未映射",
      after: "入账日期",
      attention: false,
    });
    const origChange = plan.changes.find(
      (item) => item.id === "disposal.originalValue",
    );
    expect(origChange).toMatchObject({
      before: "原值",
      after: "处置原值",
      // 把握 60% 低于阈值，需要重点核对
      attention: true,
      restore: {
        kind: "supplement",
        target: "disposal",
        key: "originalValue",
        value: "原值",
      },
    });
  });

  it("两张清单的匹配键各自独立记录", () => {
    const plan = planFaSupplementChanges({
      ...supplement(),
      matchReview: {
        action: "replace",
        suggested_file1_columns: ["资产编号", "名称"],
        suggested_file2_columns: ["编号"],
        reasons: ["与第一步口径一致"],
      },
    });
    expect(plan.addition.keys).toEqual(["资产编号", "名称"]);
    expect(plan.disposal.keys).toEqual(["编号"]);
    expect(
      plan.changes.find((item) => item.id === "addition.keys"),
    ).toMatchObject({
      before: "资产编号",
      after: "资产编号 + 名称",
      restore: { kind: "supplementKeys", target: "addition", keys: ["资产编号"] },
    });
    expect(
      plan.changes.find((item) => item.id === "disposal.keys"),
    ).toMatchObject({ before: "未映射", after: "编号" });
  });

  it("三样本精确碰撞已证明的匹配键不被 LLM 覆盖", () => {
    const plan = planFaSupplementChanges({
      ...supplement(),
      addition: {
        ...supplement().addition,
        keys: ["精确编码", "精确名称"],
        matchKeysVerified: true,
      },
      matchReview: {
        action: "replace",
        confidence: 0.99,
        suggested_file1_columns: ["LLM编码", "LLM名称"],
      },
    });
    expect(plan.addition.keys).toEqual(["精确编码", "精确名称"]);
    expect(plan.changes.some((item) => item.id === "addition.keys")).toBe(false);
    expect(plan.pending.some((item) => item.id === "addition.keys")).toBe(false);
  });

  it("把握不足的补充清单建议交回用户采纳", () => {
    const plan = planFaSupplementChanges({
      ...supplement(),
      fieldReviews: [
        {
          role: "disposal_dep",
          suggested_mapping: { file2: "处置累计折旧" },
          confidence: 0.35,
        },
      ],
      matchReview: {
        action: "replace",
        confidence: 0.4,
        suggested_file1_columns: ["编号"],
        suggested_file2_columns: ["编号"],
      },
    });
    expect(plan.disposal.depreciation).toBe("");
    expect(plan.addition.keys).toEqual(["资产编号"]);
    expect(plan.changes).toEqual([]);
    expect(plan.pending.map((item) => item.id)).toEqual([
      "disposal.depreciation",
      "addition.keys",
      "disposal.keys",
    ]);
  });

  it("同一低把握字段由两路复核返回时只提示一次", () => {
    const duplicate = {
      role: "disposal_date",
      suggested_mapping: { file2: "入账开始日期" },
      confidence: 0.3,
      reason: "需人工确认",
    };
    const plan = planFaSupplementChanges({
      ...supplement(),
      autoApplied: [duplicate],
      fieldReviews: [duplicate],
    });
    expect(plan.pending).toHaveLength(1);
    expect(plan.pending[0].id).toBe("disposal.date");
  });

  it("建议与现状一致或没有建议时不产生变更", () => {
    const plan = planFaSupplementChanges({
      ...supplement(),
      autoApplied: [
        {
          role: "addition_method",
          file_side: "file1",
          suggested_column: "变动方式",
          confidence: 0.95,
        },
      ],
      matchReview: {
        action: "replace",
        suggested_file1_columns: [],
        suggested_file2_columns: [],
      },
    });
    expect(plan.changes).toEqual([]);
    expect(plan.addition.keys).toEqual(["资产编号"]);
  });
});

describe("字段映射角色按文件侧过滤", () => {
  const roles = [
    ["category", "资产类别"],
    ["originalValue", "原值"],
    ["currentYearDep", "本年折旧"],
    ["additionMethod", "新增方式"],
    ["additionDate", "新增日期"],
  ] as const;
  const required = ["category", "originalValue"];

  it("文件1（期初）不出现只属于文件2的角色", () => {
    expect(faRolesForSide("begin", roles).map(([key]) => key)).toEqual([
      "category",
      "originalValue",
    ]);
  });

  it("文件2（期末）保留全部角色", () => {
    expect(faRolesForSide("end", roles)).toHaveLength(roles.length);
  });

  it("文件2 未映射的本年折旧要作为选填缺失被提示", () => {
    const missing = faMissingOptionalRoles("end", roles, required, {
      category: "类别",
      originalValue: "原值",
    });
    expect(missing).toContain("本年折旧");
  });

  it("必填角色不混进选填提示", () => {
    const missing = faMissingOptionalRoles("end", roles, required, {});
    expect(missing).not.toContain("资产类别");
    expect(missing).not.toContain("原值");
  });

  it("文件1 不会因为本年折旧未映射而被提示（该角色对它不适用）", () => {
    expect(faMissingOptionalRoles("begin", roles, required, {})).toEqual([]);
  });

  it("已映射的选填角色不再提示；空白字符串按未映射处理", () => {
    expect(
      faMissingOptionalRoles("end", roles, required, {
        currentYearDep: "本年折旧额",
        additionMethod: "   ",
        additionDate: "新增日",
      }),
    ).toEqual(["新增方式"]);
  });
});

describe("预览表头展示同列多角色", () => {
  it("返回同一字段命中的全部映射关系，而不是只取第一个", () => {
    const roles = [
      ["matchKeys", "组合匹配键"],
      ["name", "资产名称"],
      ["category", "资产类别"],
    ] as const;
    expect(
      faMappedRolesForColumn("资产编号", roles, {
        matchKeys: ["资产编号"],
        name: "资产编号",
        category: "类别",
      }).map(([, label]) => label),
    ).toEqual(["组合匹配键", "资产名称"]);
  });
});
