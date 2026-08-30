import { describe, expect, it } from "vitest";
import {
  fxAccountCurrencyDetail,
  fxCurrencySourceLabel,
  fxFallbackFunctional,
  fxAccountCurrencyOverrides,
  fxAllowedModes,
  fxApplyJobResult,
  fxAttachRole,
  fxDefaultMode,
  fxDetachRole,
  fxDropTargetAt,
  fxMergeJobResult,
  fxMissingRequired,
  fxPreviewTokenFor,
  fxReportStart,
  fxResolveAccountRoles,
  granularityLabel,
  splitClassificationGroups,
  summarizeQuality,
  validationDetail,
  uncoveredDetail,
  uncoveredBreakdown,
  uncoveredMetricDetail,
} from "./FxAuditPage";
import {
  applyLedgerReviewsTogether,
  resolveLedgerPairKinds,
  reviewLedgerSourceClassification,
} from "./ledgerMapping";
import type React from "react";
describe("fx audit mode selection", () => {
  it("uses two-point unrealized mode for TB only", () => {
    expect(fxDefaultMode(false, true)).toBe("unrealized");
    expect(fxAllowedModes(false, true)).toEqual(["unrealized"]);
  });
  it("uses realized mode for JE only", () =>
    expect(fxDefaultMode(true, false)).toBe("realized"));
  it("defaults to combined when both sources exist", () => {
    expect(fxDefaultMode(true, true)).toBe("combined");
    expect(fxAllowedModes(true, true)).toEqual([
      "realized",
      "unrealized",
      "combined",
    ]);
  });
});
describe("fx audit upload and mapping parity", () => {
  it("jointly assigns an ambiguous two-file upload to stable JE/TB slots", () => {
    const kinds = resolveLedgerPairKinds([
      { kind: "je", scores: { je: 11, tb: 2 } },
      { kind: "je", scores: { je: 2, tb: 9 } },
    ]);
    expect(kinds).toEqual(["je", "tb"]);
  });
  it("always invokes the tool-specific LLM classifier and falls back safely", async () => {
    const scripted = {
      kind: "je" as const,
      scores: { je: 6, tb: 5 },
      headers: ["期末余额"],
      preview: [["100"]],
    };
    const called: string[] = [];
    const reviewed = await reviewLedgerSourceClassification(
      async (method) => {
        called.push(method);
        return { kind: "tb" };
      },
      "deposit.classify_source_llm",
      "tb.xlsx",
      scripted,
    );
    expect(called).toEqual(["deposit.classify_source_llm"]);
    expect(reviewed.classification.kind).toBe("tb");
    expect(reviewed.reviewed).toBe(true);

    const fallback = await reviewLedgerSourceClassification(
      async () => {
        throw new Error("LLM disabled");
      },
      "deposit.classify_source_llm",
      "tb.xlsx",
      scripted,
    );
    expect(fallback.classification).toBe(scripted);
    expect(fallback.reviewed).toBe(false);
  });
  it("routes native drops by actual drop coordinates", () => {
    const je = { left: 0, right: 400, top: 100, bottom: 200 };
    const tb = { left: 500, right: 900, top: 100, bottom: 200 };
    expect(fxDropTargetAt(200, 150, je, tb)).toBe("je");
    expect(fxDropTargetAt(700, 150, je, tb)).toBe("tb");
    expect(fxDropTargetAt(450, 150, je, tb)).toBeUndefined();
  });
  it("shows missing required mappings like kanzhang", () => {
    expect(fxMissingRequired("je", {}, false, "默认主体")).toEqual([
      "记账日期",
      "凭证识别字段",
      "科目编码",
      "科目名称",
      "摘要",
      "原币币种",
      "原币金额方案",
      "本位币金额方案",
    ]);
  });
  it("仅未实现模式下JE不再要求原币币种与原币金额", () => {
    // 本位币记账的序时账没有外币列是常态：TB 才有外币信息，用户手动选
    // 「仅未实现」时 JE 不该再被原币两件套拦住。
    expect(
      fxMissingRequired(
        "je",
        {
          date: "记账日期",
          id: "凭证号",
          accountCode: "科目编码",
          accountName: "科目名称",
          summary: "摘要",
          functionalAmount: "本币金额",
        },
        true,
        "默认主体",
        "unrealized",
      ),
    ).toEqual([]);
    // 币种已映射时原币金额记法仍要提示——月度测算会把外币变动当 0。
    expect(
      fxMissingRequired(
        "je",
        {
          date: "记账日期",
          id: "凭证号",
          accountCode: "科目编码",
          accountName: "科目名称",
          summary: "摘要",
          functionalAmount: "本币金额",
          currency: "货币",
        },
        true,
        "默认主体",
        "unrealized",
      ),
    ).toEqual(["原币金额方案"]);
    // 其他模式下口径不变。
    expect(
      fxMissingRequired(
        "je",
        {
          date: "记账日期",
          id: "凭证号",
          accountCode: "科目编码",
          accountName: "科目名称",
          summary: "摘要",
          functionalAmount: "本币金额",
        },
        true,
        "默认主体",
        "combined",
      ),
    ).toEqual(["原币币种", "原币金额方案"]);
  });
  it("limits TB missing prompts to the fixed required field set", () => {
    expect(fxMissingRequired("tb", {}, true, "默认主体")).toEqual([
      "科目编码",
      "科目名称",
      "币种列或币种线索文本",
      "期初原币或本位币余额",
      "期末原币或本位币余额",
      "本年累计（或本期）借/贷方发生额",
    ]);
  });
  it("accepts either original or functional TB balances at each endpoint", () => {
    expect(
      fxMissingRequired(
        "tb",
        {
          accountCode: "科目编码",
          accountName: "科目名称",
          currency: "币种",
          openingFunctionalAmount: "期初本币",
          closingForeignAmount: "期末原币",
          ytdFunctionalDebit: "借方",
          ytdFunctionalCredit: "贷方",
        },
        true,
        "默认主体",
      ),
    ).toEqual([]);
  });
  it("accepts a currency clue column when the TB has no currency column", () => {
    expect(
      fxMissingRequired(
        "tb",
        {
          accountCode: "科目编码",
          accountName: "科目名称",
          currencyText: "文本",
          openingFunctionalAmount: "期初本币",
          closingFunctionalAmount: "期末本币",
          ytdFunctionalDebit: "借方",
          ytdFunctionalCredit: "贷方",
        },
        true,
        "默认主体",
      ),
    ).toEqual([]);
  });
  it("still accepts the legacy combined account mapping", () => {
    expect(
      fxMissingRequired(
        "tb",
        {
          account: ["科目代码", "科目名称"],
          currency: "币种",
          openingFunctionalAmount: "期初本币",
          closingFunctionalAmount: "期末本币",
          ytdFunctionalDebit: "借方",
          ytdFunctionalCredit: "贷方",
        },
        true,
        "默认主体",
      ),
    ).toEqual([]);
  });
  it("prompts when neither ytd nor period debit/credit pairs are complete", () => {
    const ytdOnlyDebit = {
      accountCode: "科目编码",
      accountName: "科目名称",
      currency: "币种",
      openingFunctionalAmount: "期初本币",
      closingFunctionalAmount: "期末本币",
      ytdFunctionalDebit: "借方",
    };
    expect(fxMissingRequired("tb", ytdOnlyDebit, true, "默认主体")).toEqual([
      "本年累计（或本期）借/贷方发生额",
    ]);
    const periodOk = {
      ...ytdOnlyDebit,
      periodFunctionalDebit: "本期借方",
      periodFunctionalCredit: "本期贷方",
    };
    expect(fxMissingRequired("tb", periodOk, true, "默认主体")).toEqual([]);
  });
  it("未覆盖凭证把不构成与无法测算分开说", () => {
    // 分类二元化后「待确认」废止：未覆盖的只剩「不构成汇兑事项」与
    // 「已分类但缺重算证据」两种，合成一句会自相矛盾。
    expect(
      uncoveredDetail({
        pendingReviewCount: 359,
        pendingUnclassifiedCount: 0,
        pendingUnmeasurableCount: 359,
      }),
    ).toBe("359 张已分类但缺重算证据");
    expect(
      uncoveredDetail({
        pendingReviewCount: 90,
        notFxEventCount: 80,
        pendingUnmeasurableCount: 10,
      }),
    ).toBe("80 张不构成汇兑事项；10 张已分类但缺重算证据");
    expect(uncoveredDetail({ pendingReviewCount: 0 })).toBe(
      "全部凭证均已纳入测算",
    );
    // 旧结果没有拆分字段时退回总数，不假装知道构成。
    expect(uncoveredDetail({ pendingReviewCount: 7 })).toBe("7 张未纳入测算");
  });
  it("「其中」拆分：不构成事项的金额在前，缺证据的余额是剩余", () => {
    // 4800 实测形态：82 张不构成 +5,309.22，其余 361 张挂缺证据。
    const breakdown = uncoveredBreakdown({
      uncoveredTbFxGainLoss: 3856606.17,
      notFxEventCount: 82,
      notFxEventAmount: 5309.22,
      pendingUnmeasurableCount: 361,
    });
    expect(breakdown.notFxCount).toBe(82);
    expect(breakdown.notFxAmount).toBeCloseTo(5309.22, 2);
    expect(breakdown.restAmount).toBeCloseTo(3851296.95, 2);
    expect(breakdown.unmeasurable).toBe(361);
    // 2024 用友形态：全覆盖，拆分为零。
    const clean = uncoveredBreakdown({});
    expect(clean.notFxCount).toBe(0);
    expect(clean.restAmount).toBe(0);
  });
  it("勾稽第 3 步的「其中」行带 ? 图标注释", () => {
    const collectText = (node: unknown): string => {
      if (node == null || typeof node === "boolean") return "";
      if (typeof node === "string" || typeof node === "number")
        return String(node);
      if (Array.isArray(node)) return node.map(collectText).join("");
      if (
        typeof node === "object" &&
        "props" in (node as Record<string, unknown>)
      )
        return collectText(
          (node as { props: { children?: unknown } }).props.children,
        );
      return "";
    };
    const amount = (value: unknown) => String(value);
    const countHints = (node: unknown): number => {
      if (
        node == null ||
        typeof node === "boolean" ||
        typeof node === "string" ||
        typeof node === "number"
      )
        return 0;
      if (Array.isArray(node))
        return node.reduce((sum, item) => sum + countHints(item), 0);
      const element = node as {
        type?: { name?: string };
        props?: { children?: unknown };
      };
      const self =
        typeof element.type === "function" && element.type.name === "InfoHint"
          ? 1
          : 0;
      return self + countHints(element.props?.children);
    };
    const detail = uncoveredMetricDetail(
      {
        uncoveredTbFxGainLoss: 100,
        notFxEventCount: 3,
        notFxEventAmount: 20,
        pendingUnmeasurableCount: 2,
      },
      amount,
    );
    const text = collectText(detail);
    expect(text).toContain("其中：不构成汇兑事项 20（3 张）");
    expect(text).toContain("已分类但缺重算证据 80（2 张）");
    // 两行各带一个 ? 图标。
    expect(countHints(detail)).toBeGreaterThanOrEqual(2);
    // 两类都没有时退回纯文字（不带图标）。
    const fallback = uncoveredMetricDetail({ pendingReviewCount: 7 }, amount);
    expect(fallback).toBe("7 张未纳入测算");
  });

  it("derives the audit year start from the balance sheet date", () =>
    expect(fxReportStart("2024-12-31")).toBe("2024-01-01"));
  it("一键复核从一次动作同时启动 JE 与 TB 两个复核，单个失败不阻塞另一个", async () => {
    const started: string[] = [];
    const call = async (_method: string, params: Record<string, unknown>) => {
      const kind = String((params as { kind?: unknown }).kind);
      started.push(kind);
      if (kind === "je") throw new Error("LLM 暂不可用");
      return {
        changes: [
          { role: "accountCode", suggestedColumn: "科目编码", confidence: 0.9 },
        ],
      };
    };
    const target = {
      headers: ["科目编码"],
      preview: [["1002"]],
      mapping: {},
      labels: { accountCode: "科目编码" },
    };
    const outcomes = await applyLedgerReviewsTogether(call, {
      je: target,
      tb: target,
    });
    expect(started.sort()).toEqual(["je", "tb"]);
    // JE 失败：映射原样退回、failed 标记，错误文本可供界面展示。
    expect(outcomes.je?.failed).toBe(true);
    expect(outcomes.je?.mapping).toEqual({});
    expect(outcomes.je?.error).toContain("LLM 暂不可用");
    // TB 照常完成并应用建议，不受 JE 失败影响。
    expect(outcomes.tb?.failed).toBe(false);
    expect(outcomes.tb?.appliedCount).toBe(1);
    expect(outcomes.tb?.mapping.accountCode).toBe("科目编码");
  });
  it("只复核已上传的文件，未上传的不产生结果", async () => {
    const started: string[] = [];
    const call = async (_method: string, params: Record<string, unknown>) => {
      started.push(String((params as { kind?: unknown }).kind));
      return { changes: [] };
    };
    const outcomes = await applyLedgerReviewsTogether(call, {
      tb: {
        headers: ["科目编码"],
        preview: [["1002"]],
        mapping: {},
        labels: { accountCode: "科目编码" },
      },
    });
    expect(started).toEqual(["tb"]);
    expect(outcomes.je).toBeUndefined();
    expect(outcomes.tb?.appliedCount).toBe(0);
  });
  it("公共 LLM 复核会保留凭证字与凭证号组成的多列凭证键", async () => {
    const call = async () => ({
      changes: [
        { role: "id", suggestedColumn: "凭证号", confidence: 0.94 },
      ],
    });
    const outcomes = await applyLedgerReviewsTogether(call, {
      je: {
        headers: ["凭证字", "凭证号", "摘要"],
        preview: [["记", "1", "采购设备"]],
        mapping: { id: ["凭证字"] },
        labels: { id: "凭证识别字段", summary: "摘要" },
      },
    });
    expect(outcomes.je?.failed).toBe(false);
    expect(outcomes.je?.mapping.id).toEqual(["凭证字", "凭证号"]);
    expect(outcomes.je?.appliedCount).toBe(1);
  });
  it("复核建议允许科目名称与编码共用混写列（03号样例形态）", async () => {
    // 科目编码与名称写在同一格（1001010000:库存现金-人民币），自动映射
    // 已把该列挂到 accountCode；LLM 复核建议 accountName 也指这一列时，
    // 「同列已被占用就跳过」必须放行——这列本该两个角色共用。
    const combined = "项目编码、文本/科目编码、文本";
    const call = async () => ({
      changes: [
        { role: "accountName", suggestedColumn: combined, confidence: 0.9 },
      ],
    });
    const outcomes = await applyLedgerReviewsTogether(call, {
      tb: {
        headers: [combined, "货币", "期初", "期末余额"],
        preview: [
          ["1001/库存现金", "CNY", "984.3", "-984.3"],
          ["1001010000:库存现金-人民币", "CNY", "984.3", "-984.3"],
          ["1002/银行存款", "CNY", "22222745.07", "-8724703.77"],
          ["1002101001:银行存款-建行新乡", "CNY", "14075.88", "28185.73"],
        ],
        mapping: { accountCode: combined },
        labels: { accountCode: "科目编码", accountName: "科目名称" },
      },
    });
    expect(outcomes.tb?.failed).toBe(false);
    expect(outcomes.tb?.appliedCount).toBe(1);
    expect(outcomes.tb?.mapping.accountName).toEqual([combined]);
  });
  it("keeps preview data when export adds an output path", () => {
    const preview = {
      summary: { difference: 12 },
      voucherDetail: [{ voucherId: "1" }],
    };
    const exported = {
      summary: { difference: 12 },
      outputPaths: ["workpaper.xlsx"],
    };
    expect(fxMergeJobResult(preview, exported)).toEqual({
      ...preview,
      ...exported,
    });
  });
  it("keeps the last preview when a completion event has no result payload", () => {
    const preview = { summary: { difference: 12 } };
    expect(fxApplyJobResult(preview, undefined, "fx.preview")).toBe(preview);
  });
  it("accepts a preview result before the completed event", () => {
    const preview = { summary: { difference: 12 } };
    expect(fxApplyJobResult(undefined, preview, "fx.preview")).toEqual(preview);
  });
  it("merges export output into the visible preview instead of replacing it", () => {
    const preview = {
      summary: { difference: 12 },
      voucherDetail: [{ voucherId: "1" }],
    };
    expect(
      fxApplyJobResult(
        preview,
        { outputPaths: ["workpaper.xlsx"] },
        "fx.export",
      ),
    ).toEqual({ ...preview, outputPaths: ["workpaper.xlsx"] });
  });
  it("passes a real preview token only to export", () => {
    const result = { previewToken: "preview-123" };
    expect(fxPreviewTokenFor("fx.export", result)).toBe("preview-123");
    expect(fxPreviewTokenFor("fx.preview", result)).toBeUndefined();
    expect(fxPreviewTokenFor("fx.export", {})).toBeUndefined();
  });
  it("uses backend TB classification by code and preserves only manual overrides", () => {
    const accounts = [
      "1003 其他货币资金",
      "6703 信用减值损失-应收账款",
      "2602 租赁负债",
    ];
    const resolved = fxResolveAccountRoles(
      accounts,
      {
        "1003 Other cash": "monetary_asset",
        "6703 Credit impairment": "other_pnl",
      },
      { "2602 租赁负债": "monetary_liability" },
      { "2602 租赁负债": "non_monetary" },
      { "2602 租赁负债": true },
    );
    expect(resolved).toEqual({
      "1003 其他货币资金": "monetary_asset",
      "6703 信用减值损失-应收账款": "other_pnl",
      "2602 租赁负债": "non_monetary",
    });
  });
  it("replaces a stale automatic FX role with the latest backend cost-account role", () => {
    const account = "6401011101 营业成本-芯片-发票校验与收货差异";
    expect(
      fxResolveAccountRoles(
        [account],
        { [account]: "other_pnl" },
        {},
        { [account]: "fx_gain_loss" },
        {},
      ),
    ).toEqual({ [account]: "other_pnl" });
  });
});

describe("同一列的多重映射", () => {
  it("币种线索文本可以叠加在科目名称上", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "科目名称", "accountName");
    m = fxAttachRole(m, "科目名称", "currencyText");
    expect(m.accountName).toEqual(["科目名称"]);
    expect(m.currencyText).toBe("科目名称");
  });

  it("换成别的字段时挤掉原有的正经角色，但留住币种线索", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "科目全称", "accountName");
    m = fxAttachRole(m, "科目全称", "currencyText");
    m = fxAttachRole(m, "科目全称", "accountCode");
    expect(m.accountName).toEqual([]);
    expect(m.accountCode).toBe("科目全称");
    expect(m.currencyText).toBe("科目全称");
  });

  it("两个正经角色不能共用一列", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "期初余额", "openingFunctionalAmount");
    m = fxAttachRole(m, "期初余额", "closingFunctionalAmount");
    expect(m.openingFunctionalAmount).toBe("");
    expect(m.closingFunctionalAmount).toBe("期初余额");
  });

  it("摘掉标记只影响指定的那一个", () => {
    let m: Record<string, string | string[]> = {};
    m = fxAttachRole(m, "科目名称", "accountName");
    m = fxAttachRole(m, "科目名称", "currencyText");
    m = fxDetachRole(m, "科目名称", "currencyText");
    expect(m.accountName).toEqual(["科目名称"]);
    expect(m.currencyText).toBe("");
  });
});

describe("跨表对齐后的币种线索", () => {
  /**
   * 4800 的 TB 有独立「文本」列（`银行存款-建行USD4150-4800`），初次识别会把它
   * 当币种线索；跨表对齐发现它才是与 JE 同口径的科目名称，于是建议改映射。
   * 两个角色共用这一列即可——科目名称里写着账户币种正是线索的来源。
   */
  it("对齐把科目名称改到币种线索那一列时，线索角色要留住", () => {
    const before: Record<string, string | string[]> = {
      accountCode: "科目代码",
      accountName: ["科目名称一级", "科目名称二级"],
      currencyText: "文本",
    };
    const fix = { accountName: "文本" };
    // 展开带索引签名的对象时 TS 会丢掉索引签名，不标注的话 after 只剩 fix 里那一个键。
    const after: Record<string, string | string[]> = { ...before, ...fix };
    expect(after.accountName).toBe("文本");
    expect(after.currencyText).toBe("文本");
    // 币种线索还在，就不会冒出「尚未映射：币种列或币种线索文本」。
    expect(
      fxMissingRequired(
        "tb",
        {
          ...after,
          openingFunctionalAmount: "期初金额-本位币",
          closingFunctionalAmount: "期末金额-本位币",
        },
        false,
        "3300",
      ),
    ).not.toContain("币种列或币种线索文本");
  });
});

describe("TB 粒度不足提示", () => {
  it("按隔离类型给出用户看得懂的原因", () => {
    expect(granularityLabel("科目余额混合本位币与外币")).toBe(
      "科目余额里既有本位币又有外币，拆不开",
    );
    expect(granularityLabel("同一科目存在多种外币敞口")).toBe(
      "同一科目持有多种外币，TB 只有合计数",
    );
    expect(granularityLabel("无外币敞口的评估调整科目")).toBe(
      "评估调整科目，本身不持有外币",
    );
    // 历史结果里的旧类型名也要有兜底，不能显示成空白。
    expect(granularityLabel("同一余额键存在多个外币")).toBe(
      "TB 未提供可唯一对应的原币币种",
    );
    expect(granularityLabel(undefined)).toBe("TB 未提供可唯一对应的原币币种");
  });
});

describe("逐行数据质量归并", () => {
  it("按严重度排序并合并同类，隔离排在提示前面", () => {
    const groups = summarizeQuality([
      { type: "汇率缺失", severity: "提示", row: 5 },
      {
        type: "同一科目存在多种外币敞口",
        severity: "隔离",
        row: 10,
        detail: "拆不出来",
      },
      { type: "同一科目存在多种外币敞口", severity: "隔离", row: 11 },
      { type: "汇率缺失", severity: "提示", row: 6 },
      { type: "汇率缺失", severity: "提示", row: 7 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      severity: "隔离",
      type: "同一科目存在多种外币敞口",
      count: 2,
      detail: "拆不出来",
    });
    expect(groups[0].rows).toEqual([10, 11]);
    expect(groups[1]).toMatchObject({
      severity: "提示",
      type: "汇率缺失",
      count: 3,
    });
  });
  it("示例行号最多留 5 个，不把几百行铺开", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      type: "汇率缺失",
      severity: "隔离",
      row: i,
    }));
    const [group] = summarizeQuality(many);
    expect(group.count).toBe(200);
    expect(group.rows).toHaveLength(5);
  });
  it("没有严重度或行号时不崩", () => {
    const [group] = summarizeQuality([{ type: "未知" }]);
    expect(group).toMatchObject({ severity: "提示", count: 1 });
    expect(group.rows).toEqual([]);
  });
});

describe("凭证分类分两段", () => {
  const group = (
    key: string,
    items: Array<{
      voucherId: string;
      classification: string;
      measurementStatus?: string;
    }>,
  ) => ({ key, label: key, items });
  it("组内还有不构成汇兑事项的归入『不构成』，其余归入『算不出金额』", () => {
    const { undecided, unmeasurable } = splitClassificationGroups(
      [
        group("A", [{ voucherId: "1", classification: "不构成汇兑事项" }]),
        group("B", [
          {
            voucherId: "2",
            classification: "未实现汇兑损益",
            measurementStatus: "无法测算，未纳入结果",
          },
        ]),
      ],
      {},
    );
    expect(undecided.map((g) => g.key)).toEqual(["A"]);
    expect(unmeasurable.map((g) => g.key)).toEqual(["B"]);
  });
  it("用户改过的分类立刻生效——草稿优先于后端给的分类", () => {
    const groups = [
      group("A", [{ voucherId: "1", classification: "不构成汇兑事项" }]),
    ];
    expect(
      splitClassificationGroups(groups, { "1": "已实现汇兑损益" }).undecided,
    ).toHaveLength(0);
    expect(
      splitClassificationGroups(groups, { "1": "已实现汇兑损益" }).unmeasurable,
    ).toHaveLength(1);
    // 反过来：后端判好了，用户手动改成不构成，就该重新进入待办
    const decided = [
      group("B", [{ voucherId: "2", classification: "未实现汇兑损益" }]),
    ];
    expect(
      splitClassificationGroups(decided, { "2": "不构成汇兑事项" }).undecided,
    ).toHaveLength(1);
  });
  it("4800 的形态：360 张全部已分类，待确认段为空", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      group(`P${i}`, [
        {
          voucherId: `v${i}`,
          classification: "未实现汇兑损益",
          measurementStatus: "无法测算，未纳入结果",
        },
      ]),
    );
    const { undecided, unmeasurable } = splitClassificationGroups(many, {});
    expect(undecided).toHaveLength(0);
    expect(unmeasurable).toHaveLength(12);
  });
});

describe("校验未通过时展开具体原因", () => {
  it("把 detail 里的 errors 列成编号句子", () => {
    const detail = JSON.stringify({
      valid: false,
      errors: [
        "TB 缺少期初余额：原币或本位币余额至少映射一组",
        "JE 缺少必填字段：原币币种（currency）",
      ],
      warnings: ["无关紧要"],
    });
    expect(validationDetail(detail)).toBe(
      "具体是：1. TB 缺少期初余额：原币或本位币余额至少映射一组；2. JE 缺少必填字段：原币币种（currency）",
    );
  });
  it("不是校验错误、解析失败或 errors 为空时不硬凑", () => {
    expect(validationDetail(undefined)).toBe("");
    expect(validationDetail("普通的错误描述")).toBe("");
    expect(validationDetail('{"errors":[]}')).toBe("");
    expect(validationDetail('{"errors": 这不是JSON')).toBe("");
  });
});

describe("科目币种覆盖", () => {
  const je = {
    "1002990001 过渡银行": {
      detected: "HKD",
      source: "币种列",
      seen: ["HKD", "JPY"],
      needsConfirmation: false,
    },
  };
  const tb = {
    "1002990001 过渡银行": {
      detected: "USD",
      source: "本位币列",
      seen: ["USD"],
      needsConfirmation: true,
    },
    "1122010001 应收账款": {
      detected: "USD",
      source: "本位币列",
      seen: ["USD"],
      needsConfirmation: true,
    },
  };

  it("JE 的逐行币种优先于 TB 的单行结论，seen 取两边并集", () => {
    const detail = fxAccountCurrencyDetail("1002990001 过渡银行", je, tb);
    expect(detail.detected).toBe("HKD");
    expect(detail.source).toBe("币种列");
    expect(detail.side).toBe("JE");
    expect(detail.seen).toEqual(["HKD", "JPY", "USD"]);
    expect(detail.fellBack).toBe(false);
  });

  it("界面括号里标出币种是怎么取到的，含来自 TB 还是 JE", () => {
    expect(fxCurrencySourceLabel("JE", "币种列")).toBe("JE币种列");
    expect(fxCurrencySourceLabel("TB", "币种列")).toBe("TB币种列");
    expect(fxCurrencySourceLabel("TB", "科目文本")).toBe("TB科目名");
    // 退回本位币列等于没认出账户币种，不必再区分来自哪份文件。
    expect(fxCurrencySourceLabel("TB", "本位币列")).toBe("按本位币");
    expect(fxCurrencySourceLabel("", "")).toBe("按本位币");
  });

  it("只有 TB 且依据是本位币列时标记为未识别", () => {
    const detail = fxAccountCurrencyDetail("1122010001 应收账款", je, tb);
    expect(detail.detected).toBe("USD");
    expect(detail.side).toBe("TB");
    expect(detail.fellBack).toBe(true);
  });

  it("两侧都没有该科目时视为未识别，不假装有结论", () => {
    const detail = fxAccountCurrencyDetail("9999 未知", je, tb);
    expect(detail.detected).toBe("");
    expect(detail.seen).toEqual([]);
    expect(detail.fellBack).toBe(true);
  });

  it("科目在数据里出现过多种币种时标记出来，防止被当成单币种指定", () => {
    expect(
      fxAccountCurrencyDetail("1002990001 过渡银行", je, tb).multiCurrency,
    ).toBe(true);
    expect(
      fxAccountCurrencyDetail("1122010001 应收账款", je, tb).multiCurrency,
    ).toBe(false);
    expect(fxAccountCurrencyDetail("9999 未知", je, tb).multiCurrency).toBe(
      false,
    );
  });

  it("TB 与 JE 科目名拼法不同时按科目编码对上，JE 的真实币种传得到 TB 那一行", () => {
    // 4800 的实况：TB「1002990001 货币资金 货币资金-银行存款-过渡银行」，
    // JE「1002990001 过渡银行」，两边全名不同、编码相同。
    const detail = fxAccountCurrencyDetail(
      "1002990001 货币资金 货币资金-银行存款-过渡银行",
      je,
      tb,
    );
    expect(detail.detected).toBe("HKD");
    expect(detail.source).toBe("币种列");
    expect(detail.seen).toEqual(["HKD", "JPY", "USD"]);
  });

  it("三层依据全空时按界面填写的本位币兜底，界面据此显示「按本位币」", () => {
    // 有主体列：取各主体的本位币，一致时给出唯一兜底币种。
    expect(
      fxFallbackFunctional(
        ["A", "B"],
        { A: "CNY", B: "CNY" },
        "默认主体",
        "CNY",
      ),
    ).toBe("CNY");
    // 无主体列：取固定主体那一格。
    expect(
      fxFallbackFunctional([], { 默认主体: "usd" }, "默认主体", "CNY"),
    ).toBe("USD");
    // 没填过就用默认值（TB 整列同值时是那个值，否则 CNY）。
    expect(fxFallbackFunctional(["A"], {}, "默认主体", "USD")).toBe("USD");
    // 多主体本位币不一致时无法给出唯一兜底，仍显示「未识别」。
    expect(
      fxFallbackFunctional(
        ["A", "B"],
        { A: "CNY", B: "USD" },
        "默认主体",
        "CNY",
      ),
    ).toBe("");
  });

  it("留空的选择不进 payload，只传用户真正改过的", () => {
    expect(
      fxAccountCurrencyOverrides({ A: "", B: "hkd", C: "  ", D: " usd " }),
    ).toEqual({ B: "HKD", D: "USD" });
  });

  it("没有任何选择时传空对象，不影响后端自动识别", () => {
    expect(fxAccountCurrencyOverrides({})).toEqual({});
  });
});
