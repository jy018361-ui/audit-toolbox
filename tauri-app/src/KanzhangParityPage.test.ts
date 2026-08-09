import { describe, expect, it } from "vitest";
import {
  activeAmountScheme,
  defaultKanzhangOutputName,
  defaultKanzhangOutputPath,
  effectiveVoucherKey,
  filterAccounts,
  isSchemeLockedRole,
  KZ_ROLE_LABELS,
  asShuttleZone,
  moveShuttleAccounts,
  NET_VALUE_FIELD,
  invalidateKanzhangInspection,
  formatMappingValue,
  isRedundantKanzhangReview,
  kanzhangErrorText,
  kanzhangReviewSummary,
  type KanzhangDraft,
  type Mapping,
  mergeMappingChanges,
  needsAttention,
  shouldAutoApply,
  shouldShowKanzhangJobProgress,
  undoMappingChange,
  setKanzhangMapping,
  validKanzhangBatches,
} from "./KanzhangParityPage";

const draft = (): KanzhangDraft => ({
  inputPath: "ledger.xlsx",
  sheet: "总账",
  knownSheets: ["总账", "明细"],
  headerRow: 1,
  inspect: { headers: ["凭证号", "科目", "金额"], preview: [] },
  mapping: { id: ["凭证号"], account: ["科目"], amount: "金额" },
  batches: [{ name: "收入", accounts: ["主营业务收入"] }],
  activeBatch: 0,
  excludes: [],
  outputPath: "",
  outputTouched: false,
  includePivot: true,
  includeVoucherTypes: true,
  markLossTransfer: true,
  enableJeMatching: true,
  llmAnalysis: true,
  pivotRows: [],
  pivotColumns: [],
  pivotValues: [],
  step: 2,
});

describe("看账页面状态规则", () => {
  it("金额方向方案与借贷方案互斥", () => {
    const schemeB = setKanzhangMapping(
      { id: ["凭证号"], account: ["科目"], amount: "金额", direction: "方向" },
      "debit",
      "借方",
    );
    expect(schemeB.amount).toBeUndefined();
    expect(schemeB.direction).toBeUndefined();
    const schemeA = setKanzhangMapping({ ...schemeB, credit: "贷方" }, "amount", "金额");
    expect(schemeA.debit).toBeUndefined();
    expect(schemeA.credit).toBeUndefined();
  });

  it("只在任务进行中显示进度，不把上一轮完成态误当成尚未开始的导出", () => {
    expect(shouldShowKanzhangJobProgress("queued")).toBe(true);
    expect(shouldShowKanzhangJobProgress("running")).toBe(true);
    expect(shouldShowKanzhangJobProgress("completed")).toBe(false);
    expect(shouldShowKanzhangJobProgress("failed")).toBe(false);
    expect(shouldShowKanzhangJobProgress(undefined)).toBe(false);
  });

  it("实际唯一识别码由公司、日期和用户选择的凭证编号组成", () => {
    expect(effectiveVoucherKey({
      id: ["凭证号"],
      account: ["科目"],
      entity: "单位名称",
      date: "日期",
    })).toEqual(["单位名称", "日期", "凭证号"]);
  });

  it("只提交有名称且有目标科目的批次", () => {
    expect(validKanzhangBatches([
      { name: "收入", accounts: ["主营业务收入"] },
      { name: "", accounts: ["费用"] },
      { name: "空批次", accounts: [] },
    ])).toEqual([{ name: "收入", accounts: ["主营业务收入"] }]);
  });

  it("切换 Sheet 或标题行会清除旧预览映射但保留 Sheet 选项", () => {
    const next = invalidateKanzhangInspection(draft(), { sheet: "明细", headerRow: 3 });
    expect(next.knownSheets).toEqual(["总账", "明细"]);
    expect(next.sheet).toBe("明细");
    expect(next.headerRow).toBe(3);
    expect(next.inspect).toBeUndefined();
    expect(next.mapping).toEqual({ id: [], account: [] });
    expect(next.step).toBe(1);
  });

  it("优先显示结构化错误中的用户提示", () => {
    expect(kanzhangErrorText({ code: "BROKEN", userMessage: "文件被占用。", detail: "secret" })).toBe("文件被占用。");
  });

  it("LLM 建议与现有映射一致时不再提示复核", () => {
    const mapping: Mapping = {
      id: ["凭证号"],
      account: ["科目名称"],
      entity: "公司",
      date: "记账日期",
      debit: "借方",
      credit: "贷方",
    };
    // 截图里的六条建议全部是"X → X"，采纳与否结果相同，应全部过滤掉
    for (const [role, column] of [
      ["account", "科目名称"], ["credit", "贷方"], ["date", "记账日期"],
      ["debit", "借方"], ["entity", "公司"], ["id", "凭证号"],
    ] as const) {
      expect(isRedundantKanzhangReview(mapping, { role, suggestedColumn: column })).toBe(true);
    }
    // 首尾空格不算差异
    expect(isRedundantKanzhangReview(mapping, { role: "entity", suggestedColumn: " 公司 " })).toBe(true);
    // 空建议没有可执行内容
    expect(isRedundantKanzhangReview(mapping, { role: "summary", suggestedColumn: "  " })).toBe(true);
  });

  it("LLM 建议确实会改变映射时保留提示", () => {
    const mapping: Mapping = { id: ["凭证号"], account: ["科目名称"], entity: "公司" };
    // 换成别的列
    expect(isRedundantKanzhangReview(mapping, { role: "entity", suggestedColumn: "主体" })).toBe(false);
    // 当前未映射
    expect(isRedundantKanzhangReview(mapping, { role: "summary", suggestedColumn: "摘要" })).toBe(false);
    // 多选列收敛成一列，会丢掉其他列，属于真实变更
    expect(isRedundantKanzhangReview(
      { id: ["凭证号", "序号"], account: ["科目名称"] },
      { role: "id", suggestedColumn: "凭证号" },
    )).toBe(false);
  });

  it("把握达到六成才自动改，否则交回用户", () => {
    expect(shouldAutoApply(0.95)).toBe(true);
    expect(shouldAutoApply(0.6)).toBe(true);
    expect(shouldAutoApply(0.59)).toBe(false);
    expect(shouldAutoApply(0.2)).toBe(false);
    // LLM 没给把握时按原有行为直接应用
    expect(shouldAutoApply(undefined)).toBe(true);
  });

  it("复核结论分别交代改了什么和还要你定什么", () => {
    expect(kanzhangReviewSummary(3, 0)).toBe("LLM 复核完成：已自动调整 3 项，不合适可逐条撤销。");
    expect(kanzhangReviewSummary(3, 2)).toBe("LLM 复核完成：已自动调整 3 项，不合适可逐条撤销；另有 2 项把握不足 60%，未改动，请确认是否采纳。");
    expect(kanzhangReviewSummary(0, 2)).toBe("LLM 复核完成：另有 2 项把握不足 60%，未改动，请确认是否采纳。");
    expect(kanzhangReviewSummary(0, 0)).toBe("LLM 复核完成：现有字段映射与 LLM 判断一致，未做改动。");
  });

  it("变更前后一律显示成人话，未映射不显示为空白", () => {
    expect(formatMappingValue(undefined)).toBe("未映射");
    expect(formatMappingValue("")).toBe("未映射");
    expect(formatMappingValue([])).toBe("未映射");
    expect(formatMappingValue("借方")).toBe("借方");
    expect(formatMappingValue(["凭证号", "序号"])).toBe("凭证号、序号");
  });

  it("撤销自动补充只清掉该字段，不牵连互斥字段", () => {
    // LLM 补了 amount，用户撤销时 debit/credit 不该被 setKanzhangMapping 的互斥逻辑清掉
    const after = undoMappingChange(
      { id: ["凭证号"], account: ["科目"], amount: "金额", debit: "借方", credit: "贷方" },
      { role: "amount", before: undefined, after: "金额", source: "fill" },
    );
    expect(after.amount).toBeUndefined();
    expect(after.debit).toBe("借方");
    expect(after.credit).toBe("贷方");
  });

  it("撤销方案清除会恢复原字段并重新排除互斥方案", () => {
    // LLM 判定方案A清空了借贷方；撤销后借方回来，方案A的金额/方向要让位
    const after = undoMappingChange(
      { id: ["凭证号"], account: ["科目"], amount: "金额", direction: "方向" },
      { role: "debit", before: "借方", after: undefined, source: "scheme" },
    );
    expect(after.debit).toBe("借方");
    expect(after.amount).toBeUndefined();
    expect(after.direction).toBeUndefined();
  });

  it("撤销多选字段能还原全部原列", () => {
    const after = undoMappingChange(
      { id: ["凭证号"], account: ["科目名称"] },
      { role: "id", before: ["凭证号", "序号"], after: ["凭证号"], source: "replace" },
    );
    expect(after.id).toEqual(["凭证号", "序号"]);
    const cleared = undoMappingChange(
      { id: ["凭证号"], account: ["科目名称"] },
      { role: "id", before: [], after: ["凭证号"], source: "fill" },
    );
    expect(cleared.id).toEqual([]);
  });

  it("同一字段被反复改动时只呈现净变化", () => {
    // 先补上金额，又因为判定方案B被清除：净效果是没变，不该出现在清单里
    expect(mergeMappingChanges([
      { role: "amount", before: undefined, after: "金额", source: "fill" },
      { role: "amount", before: "金额", after: undefined, source: "scheme" },
    ])).toEqual([]);
    // 连续两次改列名：合并成最初值到最终值的一条
    const merged = mergeMappingChanges([
      { role: "entity", before: "主体", after: "公司", source: "replace" },
      { role: "entity", before: "公司", after: "单位名称", source: "replace", reason: "更贴近实体列" },
    ]);
    expect(merged).toEqual([
      { role: "entity", before: "主体", after: "单位名称", source: "replace", reason: "更贴近实体列" },
    ]);
  });

  it("清除原映射和低把握改动会被标为需重点核对", () => {
    expect(needsAttention({ role: "debit", before: "借方", after: undefined, source: "scheme" })).toBe(true);
    expect(needsAttention({ role: "entity", before: "主体", after: "公司", source: "replace", confidence: 0.4 })).toBe(true);
    expect(needsAttention({ role: "entity", before: "主体", after: "公司", source: "replace", confidence: 0.95 })).toBe(false);
    expect(needsAttention({ role: "summary", before: undefined, after: "摘要", source: "fill" })).toBe(false);
  });
});

describe("金额口径方案互斥", () => {
  const base: Mapping = { id: ["凭证号"], account: ["科目名称"] };

  it("借贷方映射成功后判定为方案B", () => {
    expect(activeAmountScheme({ ...base, debit: "借方", credit: "贷方" })).toBe("B");
    expect(activeAmountScheme({ ...base, debit: "借方" })).toBe("B");
  });

  it("金额方向映射成功后判定为方案A", () => {
    expect(activeAmountScheme({ ...base, amount: "金额", direction: "方向" })).toBe("A");
  });

  it("两套都空或都有时不锁定任何一方", () => {
    expect(activeAmountScheme(base)).toBeUndefined();
    expect(activeAmountScheme({ ...base, amount: "金额", debit: "借方" })).toBeUndefined();
    // 空白字符串不算映射成功
    expect(activeAmountScheme({ ...base, debit: "  " })).toBeUndefined();
  });

  it("方案B成立时方案A的字段停用，反之亦然", () => {
    const schemeB: Mapping = { ...base, debit: "借方", credit: "贷方" };
    expect(isSchemeLockedRole(schemeB, "amount")).toBe(true);
    expect(isSchemeLockedRole(schemeB, "direction")).toBe(true);
    expect(isSchemeLockedRole(schemeB, "debit")).toBe(false);
    // 与金额口径无关的字段永远可改
    expect(isSchemeLockedRole(schemeB, "summary")).toBe(false);
    expect(isSchemeLockedRole(schemeB, "entity")).toBe(false);

    const schemeA: Mapping = { ...base, amount: "金额", direction: "方向" };
    expect(isSchemeLockedRole(schemeA, "debit")).toBe(true);
    expect(isSchemeLockedRole(schemeA, "credit")).toBe(true);
    expect(isSchemeLockedRole(schemeA, "amount")).toBe(false);

    // 方案未定时两套都开放，LLM 也可以照常给建议
    for (const role of ["amount", "direction", "debit", "credit"] as const) {
      expect(isSchemeLockedRole(base, role)).toBe(false);
    }
  });
});

describe("看账其他交互口径", () => {
  it("变更清单用中文角色名，不暴露内部键名", () => {
    expect(KZ_ROLE_LABELS.summary).toBe("摘要");
    expect(KZ_ROLE_LABELS.direction).toBe("方案A-方向");
    expect(KZ_ROLE_LABELS.debit).toBe("方案B-借方");
    // 九个映射角色都要有中文名，否则清单里会出现 undefined
    expect(Object.keys(KZ_ROLE_LABELS)).toHaveLength(9);
    expect(Object.values(KZ_ROLE_LABELS).every(Boolean)).toBe(true);
  });

  it("科目检索在已载入列表上即时过滤，不区分大小写", () => {
    const values = ["主营业务收入", "银行存款-USD", "银行存款-CNY"];
    expect(filterAccounts(values, "银行")).toEqual(["银行存款-USD", "银行存款-CNY"]);
    expect(filterAccounts(values, "usd")).toEqual(["银行存款-USD"]);
    // 空关键词返回全量，不是空列表——原来敲字后列表会瞬间清空
    expect(filterAccounts(values, "  ")).toEqual(values);
  });

  it("科目在待选/目标/剔除三个区之间拖拽互移", () => {
    const base = { targets: ["收入"], excludes: ["银行"] };
    // 待选 → 目标：只加不减
    expect(moveShuttleAccounts(base, ["成本"], "source", "target")).toEqual({
      targets: ["收入", "成本"],
      excludes: ["银行"],
    });
    // 目标 → 剔除：从目标摘掉、并进剔除，一次完成
    expect(moveShuttleAccounts(base, ["收入"], "target", "exclude")).toEqual({
      targets: [],
      excludes: ["银行", "收入"],
    });
    // 剔除 → 待选：只从剔除摘掉，回到待选是算出来的，不需要单独存
    expect(moveShuttleAccounts(base, ["银行"], "exclude", "source")).toEqual({
      targets: ["收入"],
      excludes: [],
    });
    // 拖回原区、或拖了个空选择，都不该产生变更
    expect(moveShuttleAccounts(base, ["收入"], "target", "target")).toBe(base);
    expect(moveShuttleAccounts(base, [], "source", "target")).toBe(base);
    // 重复拖同一个科目不会出现两条
    expect(
      moveShuttleAccounts(base, ["收入"], "source", "target").targets,
    ).toEqual(["收入"]);
  });

  it("拖拽落点只认三个穿梭区，别的元素一律不接收", () => {
    expect(asShuttleZone("source")).toBe("source");
    expect(asShuttleZone("target")).toBe("target");
    expect(asShuttleZone("exclude")).toBe("exclude");
    // 页面上别处的 data 属性、拖到空白处、拖出窗口都算没有落点
    expect(asShuttleZone("pivot")).toBeNull();
    expect(asShuttleZone("")).toBeNull();
    expect(asShuttleZone(undefined)).toBeNull();
    expect(asShuttleZone(null)).toBeNull();
  });

  it("净额是透视的伪列名，和后端约定的字面量必须一致", () => {
    // 后端 tabular.rs 的 NET_VALUE_FIELD 与导出表头都用这个字符串，改一处就对不上。
    expect(NET_VALUE_FIELD).toBe("#_净额(Net)");
  });

  it("默认导出名沿用旧版命名，且默认走 CSV", () => {
    const now = new Date(2026, 7, 8, 18, 5, 42);
    expect(defaultKanzhangOutputName("C:\\data\\JE-用于测试.xlsx", "JE-PRC", now))
      .toBe("看账导出_JE-用于测试_工作表JE-PRC_20260808_180542.csv");
    // 未选 Sheet 时不拼工作表片段
    expect(defaultKanzhangOutputName("/tmp/凭证.csv", "", now))
      .toBe("看账导出_凭证_20260808_180542.csv");
    // 文件名里的非法字符要替换掉，否则保存对话框直接报错
    expect(defaultKanzhangOutputName("C:\\data\\a:b?c.xlsx", "", now))
      .toBe("看账导出_a_b_c_20260808_180542.csv");
  });

  it("默认输出路径落在凭证文件所在目录", () => {
    const now = new Date(2026, 7, 8, 18, 5, 42);
    expect(defaultKanzhangOutputPath("C:\\data\\JE-用于测试.xlsx", "JE-PRC", now))
      .toBe("C:\\data\\看账导出_JE-用于测试_工作表JE-PRC_20260808_180542.csv");
    // 盘符根目录下的凭证文件不能算成 "C:"
    expect(defaultKanzhangOutputPath("C:\\凭证.csv", "", now))
      .toBe("C:\\看账导出_凭证_20260808_180542.csv");
    // 没选文件时不猜路径
    expect(defaultKanzhangOutputPath("", "", now)).toBe("");
  });
});
