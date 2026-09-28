import { describe, expect, it } from "vitest";
import {
  covenantProcedure,
  covenantConsequence,
  covenantExportRows,
  covenantSummary,
  formalCovenantCategory,
  filterCovenantRows,
  procedureOverride,
  PROCEDURE_LEVELS,
} from "./audipickCovenant";

const row = (
  excerpt: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ excerpt, pages: "12", ...extra });

describe("限制性契约程序建议（不是风险等级或合规结论）", () => {
  it.each([
    ["借款人的资产负债率不得超过70%。", 1],
    ["净利润必须保持为正。", 1],
    ["贷款期间账户余额不低于100万元。", 1],
    ["对外担保金额不得超过审定净资产的30%。", 1],
    ["未经贷款人书面同意不得对外担保。", 1],
    ["未经贷款人同意不得新增融资。", 1],
    ["对外投资总额不得超过5000万元。", 1],
    ["新增借款金额不得超过100万元。", 1],
    ["新增融资不得超过100万元。", 1],
    ["全部债务清偿前不得分红。", 1],
    ["贷款不得用于股东分红。", 3],
    [
      "借款人相关违约金额累计超过10000万元，其关联方相关违约金额累计超过50000万元。",
      2,
    ],
    ["未经贷款人同意不得对外提供担保。", 1],
    ["保证人丧失担保能力时借款人须追加担保。", 2],
    ["担保失效或者担保物贬值，应补充担保。", 2],
    ["发生交叉违约时贷款人可以宣布加速到期。", 2],
    ["借款人应按期还本付息。", 2],
    ["单笔超过500万元时适用受托支付。", 2],
    ["贷款须专款专用，不得挪作他用。", 3],
    ["借款人每季应报送财务报表。", 3],
    ["借款人发生重大诉讼后应通知贷款人。", 3],
    ["对外担保超过净资产10%时，应在发生后五日内通知贷款人。", 3],
    ["净资产低于100万元时应报告贷款人。", 3],
    ["按经审计的财务报告计算，资产负债率不得超过70%。", 1],
  ])("%s → %s级", (excerpt, expected) => {
    const advice = covenantProcedure(row(String(excerpt)));
    expect(advice.level).toBe(expected);
    expect(advice.needsReview).toBe(false);
    expect(advice.method).not.toBe("");
    expect(advice.evidence).not.toBe("");
  });

  it("不依据 AI 的财务类标签或审计摘要提高报送义务等级", () => {
    expect(
      covenantProcedure(
        row("每季度提交财务报表。", {
          title: "财务指标承诺",
          is_financial: "是",
          auditor_summary: "应计算财务比率",
        }),
      ).level,
    ).toBe(3);
  });
  it("仅引用财务指标要求时仍提示一级关注，但须先补齐指标条款", () => {
    const advice = covenantProcedure(
      row(
        "借款人能够遵循本合同约定的财务指标约束，有能力按期清偿本合同项下全部到期债务。",
      ),
    );
    expect(advice.level).toBe(1);
    expect(advice.needsReview).toBe(true);
    expect(advice.reasons.join(" ")).toContain("未列明具体指标");
  });
  it("跨句保留独立义务，混合条款提示复核", () => {
    const advice = covenantProcedure(
      row("每季度报送财务报表；资产负债率不得高于70%。"),
    );
    expect(advice.level).toBe(1);
    expect(advice.needsReview).toBe(true);
    expect(advice.method).toContain("汇总报告");
    expect(advice.method).toContain("重新计算");
  });
  it.each([
    ["资产负债率不得超过【】%。", "空白条件"],
    ["账户余额应不低于待填万元。", "空白条件"],
    ["贷款用途为……", "截断"],
    ["原文无法识别", "识别不清"],
  ])("证据异常独立提示：%s", (excerpt, reason) => {
    expect(covenantProcedure(row(excerpt)).reasons.join(" ")).toContain(reason);
  });
  it("缺原文或未识别内容不能静默归入三级", () => {
    for (const excerpt of ["", "合同约定的其他事项"]) {
      const advice = covenantProcedure(row(excerpt));
      expect(advice.level).toBe(2);
      expect(advice.needsReview).toBe(true);
    }
  });
  it("缺页码、事前事后冲突和关联后果缺失均留待复核", () => {
    const advice = covenantProcedure(
      row("重大事项发生后五日内通知。", {
        pages: "未知",
        title: "应事先通知",
        auditor_summary: "关联后果未明确",
      }),
    );
    expect(advice.reasons).toHaveLength(3);
    expect(advice.level).toBe(3);
  });
  it("人工降级不清除证据问题和原建议，自动建议不修改历史原始记录", () => {
    const original = Object.freeze(
      row("资产负债率不得超过【】%。", {
        procedure_level_override: 3,
        reviewed: false,
      }),
    );
    const advice = covenantProcedure(original);
    expect(advice).toMatchObject({
      level: 3,
      suggestedLevel: 1,
      overridden: true,
      needsReview: true,
    });
    expect(advice.method).toContain("重新计算");
    expect(original.reviewed).toBe(false);
    expect(procedureOverride("auto")).toBeUndefined();
    expect(procedureOverride(9)).toBeUndefined();
    expect(procedureOverride("2")).toBe(2);
  });
  it("筛选按证据问题优先再按程序排序；原始数组不删除不重排", () => {
    const rows = [
      row("每季报送财务报表。", { id: "c" }),
      row("资产负债率不得超过70%。", { id: "a" }),
      row("专款专用。", { id: "warning", pages: "" }),
      row("按期还本付息。", { id: "b" }),
    ];
    expect(filterCovenantRows(rows, "all", false).map((r) => r.id)).toEqual([
      "warning",
      "a",
      "b",
      "c",
    ]);
    expect(filterCovenantRows(rows, "3", true).map((r) => r.id)).toEqual([
      "warning",
    ]);
    expect(filterCovenantRows(rows, "1", true)).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual(["c", "a", "warning", "b"]);
  });
  it("触发后果归一为可扫读类别，摘要兼容历史结果", () => {
    expect(covenantConsequence(row("", { breach_consequence: "贷款人有权要求提前偿还，并计收罚息和赔偿损失。", covenant_scope: "repayment" }))).toBe("提前还款（贷款人有权要求）、罚息／违约利率、违约金／赔偿");
    expect(covenantConsequence(row("", { breach_consequence: "全部债务立即到期，并宣布加速到期。", covenant_scope: "repayment" }))).toBe("立即到期（自动触发）、加速到期（贷款人有权宣布）");
    expect(covenantConsequence(row("", { breach_consequence: "贷款人有权宣布全部债务立即到期。", covenant_scope: "repayment" }))).toBe("加速到期（贷款人有权宣布）");
    expect(covenantConsequence(row("", { breach_consequence: "关联后果尚未核实。", covenant_scope: "unresolved" }))).toBe("后果待核实");
    expect(covenantConsequence(row("", { breach_consequence: "贷款人有权采取其他必要措施。", covenant_scope: "supplementary" }))).toBe("后果待核实");
    expect(covenantConsequence(row("", { consequence_codes: ["early_repayment", "penalty_interest"], breach_consequence: "", covenant_scope: "repayment" }))).toBe("提前还款（贷款人有权要求）、罚息／违约利率");
    expect(covenantConsequence(row("", { _covenant_consequence_codes: ["immediate_due", "penalty"], _covenant_trigger_mode: "automatic", breach_consequence: "", covenant_scope: "repayment" }))).toBe("立即到期（自动触发）、违约金／赔偿");
    expect(covenantConsequence(row("", { _covenant_consequence_codes: ["immediate_due"], _covenant_trigger_mode: "lender_option", breach_consequence: "", covenant_scope: "repayment" }))).toBe("加速到期（贷款人有权宣布）");
    expect(covenantSummary(row("很长的原文", { title: "资产负债率不得超过70%" }))).toBe("资产负债率不得超过70%");
    expect(covenantSummary(row("很长的原文", { auditor_summary: "需关注财务指标" }))).toBe("需关注财务指标");
    expect(covenantSummary(row("很长的原文", { title: "其他可执行限制", _covenant_obligated_party: "借款人", _covenant_evidence: [{ role: "obligation", quote: "借款人应将项目收入归集至监管账户。" }] }))).toBe("借款人应将项目收入归集至监管账户。");
    expect(covenantSummary(row("很长的原文", { title: "对外担保上限", _covenant_obligated_party: "借款人" }))).toBe("借款人：对外担保上限");
  });
  it("按可执行审计事项覆盖分享口径中的七类正式契约", () => {
    const samples = [
      ["项目资本金1.2亿元应于约定日期前到位。", "财务指标及资本金"],
      ["贷款仅用于项目建设并将收入归集至监管账户。", "资金用途及账户管理"],
      ["未经同意不得为第三方提供担保。", "担保及融资限制"],
      ["关联交易累计超过净资产10%须取得书面同意。", "重大资产处置及公司行为"],
      ["其他债务逾期达到1亿元构成交叉违约。", "还本付息及交叉违约"],
      ["金额1亿元以上资产被冻结30个营业日未解除。", "诉讼、司法及持续经营事项"],
      ["每季度报送财务报表并维持项目资产保险。", "报送、通知、保险及增信义务"],
    ];
    for (const [excerpt, category] of samples)
      expect(formalCovenantCategory(row(excerpt))).toBe(category);
  });
  it("完整与筛选导出共用唯一八列投影，来源位置与逐字原文分列", () => {
    const rows = [
      row("每季报送财务报表。", {
        id: "c",
        ruleId: "loan_covenant",
        extractRunId: "r",
      }),
      row("对外担保不得超过净资产30%。", {
        id: "a",
        procedure_level_override: 2,
        reviewed: true,
        clause_ref: "5.1",
        pages: "12、13",
        covenant_category: "财务类",
        covenant_scope: "repayment",
        title: "对外担保不得超过净资产30%",
        trigger_standard: "对外担保超过净资产30%",
        breach_consequence: "违反后贷款人有权要求提前还款并计收罚息。",
        _covenant_evidence: [
          { document_id: "d1", document_name: "合同.pdf", quote: "对外担保不得超过净资产30%。", role: "obligation", clause_ref: "5.1", pages: "第12页" },
          { document_id: "d1", document_name: "合同.pdf", quote: "违反第5.1条构成违约事件。", role: "default", clause_ref: "21.2", pages: "第20页" },
          { document_id: "d1", document_name: "合同.pdf", quote: "贷款人有权要求提前还款并计收罚息。", role: "consequence", clause_ref: "21.18", pages: "第21页" },
        ],
        custom: "历史字段",
      }),
    ];
    const exported = covenantExportRows(rows, () => "合同.pdf");
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      分类: "担保及融资限制",
      建议等级: PROCEDURE_LEVELS[2],
      条款及限制内容: "对外担保不得超过净资产30%",
      触发标准: "对外担保超过净资产30%",
      违反约定的后果: "提前还款（贷款人有权要求）、罚息／违约利率",
    });
    expect(exported[0].合同原文摘录).toBe("对外担保不得超过净资产30%。");
    expect(exported[0].合同原文摘录).not.toContain("来源");
    expect(exported[0].原文引用出处).toContain("具体约定：文件：合同.pdf；页码：第12页；条款：5.1");
    expect(exported[0].原文引用出处).toContain("违约关联：文件：合同.pdf；页码：第20页；条款：21.2");
    expect(exported[0].原文引用出处).toContain("法律后果：文件：合同.pdf；页码：第21页；条款：21.18");
    expect(exported[0].合同原文摘录).not.toContain("违反第5.1条");
    expect(exported[0].合同原文摘录).not.toContain("贷款人有权");
    expect(exported[0].建议审计程序).toContain("担保");
    expect(Object.keys(exported[0])).toEqual(["分类", "建议等级", "条款及限制内容", "触发标准", "合同原文摘录", "原文引用出处", "违反约定的后果", "建议审计程序"]);
    for (const result of exported)
      for (const key of [
        "文件名称",
        "结果范围",
        "人工复核状态",
        "条款编号/位置",
        "页码",
        "custom",
        "id",
        "ruleId",
        "extractRunId",
        "procedure_level_override",
        "证据待复核",
        "待复核原因",
        "建议核查方式",
        "所需资料／已有底稿",
        "分级来源",
        "原建议等级",
        "分级说明",
      ])
        expect(result).not.toHaveProperty(key);
    const filtered = covenantExportRows(
      filterCovenantRows(rows, "2", false),
      () => "合同.pdf",
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].合同原文摘录).toContain(String(rows[1].excerpt));
    expect(rows).toHaveLength(2);
  });
});
