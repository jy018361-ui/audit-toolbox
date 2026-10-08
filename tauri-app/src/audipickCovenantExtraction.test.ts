import { describe, expect, it, vi } from "vitest";
import {
  COVENANT_CANDIDATE_PROMPT,
  COVENANT_LINK_PROMPT,
  covenantChunks,
  covenantConsequenceCodes,
  covenantReferences,
  extractCovenantEvidence,
  groupCovenantRows,
  hasRepaymentConsequence,
  retrieveCovenantContext,
  type CovenantExtractRequest,
} from "./audipickCovenantExtraction";

const obligation = "借款人资产负债率不得超过65%。";
const secondObligation = "借款人流动比率不得低于1.2。";
const guaranteeObligation = "借款人未经贷款人同意不得新增对外担保。";
const event = "违反第19.1条财务承诺构成违约事件。";
const remedy = "发生第21.2条违约事件，贷款人有权通知借款人要求提前还款。";
const doc = { id: "main", name: "主合同.pdf", text: `PDF第1页\n第19.1条 财务承诺\n${obligation}\n${secondObligation}\n${guaranteeObligation}\nPDF第50页\n第21.2条 违约事件\n${event}\nPDF第78页\n第21.18条 加速到期\n${remedy}` };
const candidate = (anchor = remedy, extra = {}) => ({ kind: "consequence", document_id: "main", source_segment_id: "main::s0", anchor, clause_ref: "第21.18条", search_terms: ["第21.2条违约事件"], ...extra });
const response = (items: unknown[], coverage_complete = true) => ({ parsed: { coverage_complete, items } });
const linked = (id: string, extra = {}) => ({
  candidate_id: id,
  covenant_scope: "repayment",
  title: "资产负债率不超过65%",
  covenant_category: "财务类",
  contract_classification: "指标类",
  is_financial: "是",
  obligated_party: "借款人",
  measurement_basis: "合并口径",
  breach_consequence: "违反财务承诺构成违约事件，贷款人有权通知要求提前还款。",
  chain_complete: true,
  references_resolved: true,
  evidence: [
    { document_id: "main", quote: obligation, role: "obligation", clause_ref: "第19.1条" },
    { document_id: "main", quote: event, role: "default", clause_ref: "第21.2条" },
    { document_id: "main", quote: remedy, role: "consequence", clause_ref: "第21.18条" },
  ],
  ...extra,
});

describe("限制性契约：从还款后果反向追踪具体约定", () => {
  it("生产接口只返回损坏JSON而无finish_reason时也会拆分范围，完整子结果保留", async () => {
    const directObligation = "借款人不得挪用本合同贷款。";
    const generalEvent = "借款人违反本合同的其他约定，构成违约事件。";
    const generalRemedy = "当上述任一违约事件发生时，贷款人有权宣布贷款提前到期。";
    const source = { id: "main", name: "主合同.pdf", text: `第三条 贷款用途\n${directObligation}\n${"普通说明。".repeat(600)}\n第二十三条 违约责任\n${generalEvent}\n${generalRemedy}` };
    const calls: string[] = [];
    const result = await extractCovenantEvidence({ documents: [source], extract: async request => {
      if (request.stage === "candidates") return response(request.text.includes(generalRemedy) ? [candidate(generalRemedy)] : []);
      calls.push(request.candidateId!);
      if (request.candidateId!.endsWith("part1")) return { parsed: { items: [], raw: '{"items":[' } };
      if (request.candidateId!.endsWith("part1-split1")) return response([linked(request.candidateId!, { evidence: [{ document_id: "main", quote: directObligation, role: "obligation" }, { document_id: "main", quote: generalEvent, role: "default" }, { document_id: "main", quote: generalRemedy, role: "consequence" }] })]);
      return response([]);
    } });
    expect(calls.some(id => id.includes("split"))).toBe(true);
    expect(result.unresolvedCount).toBe(0);
    expect(result.items.some(row => row.covenant_scope === "repayment")).toBe(true);
  });

  it("利率替代机制即使直接约定强制提前还款也不进入黄金主题", async () => {
    const direct = "发生基准利率停发且三十日内未达成替代利率时，贷款人有权要求强制提前还款。";
    const source = { id: "main", name: "主合同.pdf", text: `第五条 贷款利率\n${direct}` };
    const result = await extractCovenantEvidence({ documents: [source], extract: async request => request.stage === "candidates" ? response([candidate("贷款人有权要求强制提前还款")]) : response([linked(request.candidateId!, { title: "借款人在利率停发且三十日未协商一致时承担强制还款", covenant_category: "还本付息及交叉违约", evidence: [{ document_id: "main", quote: direct, role: "obligation" }] })]) });
    expect(result.unresolvedCount).toBe(0);
    expect(result.items[0].covenant_scope).toBe("supporting");
    expect(result.items[0]._covenant_review_reason).toContain("不属于黄金标准");
    expect(result.items[0]._covenant_evidence).toEqual(expect.arrayContaining([expect.objectContaining({ quote: direct, role: "consequence" })]));
  });

  it("普通后果锚点的关联请求不会混入无引用关系的其他条款", async () => {
    const source = { ...doc, text: doc.text + "\n第九十九条 旁支条款\n旁支证据不得混入本轮" };
    let context = "";
    await extractCovenantEvidence({ documents: [source], extract: async request => {
      if (request.stage === "candidates") return response([candidate()]);
      context = request.text;
      return response([linked(request.candidateId!)]);
    } });
    expect(context).toContain(obligation);
    expect(context).toContain(event);
    expect(context).not.toContain("旁支证据不得混入本轮");
  });

  it("行号证据保留源文字，否定自动到期不被选择权校验误杀，并保存原始响应", async () => {
    const lines = doc.text.split("\n");
    const evidence = [obligation, event, remedy].map((quote, index) => ({ document_id: doc.id, line_start: lines.indexOf(quote) + 1, line_end: lines.indexOf(quote) + 1, role: ["obligation", "default", "consequence"][index] }));
    const result = await extractCovenantEvidence({ documents: [doc], extract: async (request) => request.stage === "candidates" ? response([candidate()]) : response([linked(request.candidateId!, { evidence, breach_consequence: "贷款人有权要求提前还款，并非自动到期。" })]) });
    expect(result.unresolvedCount).toBe(0);
    expect(result.items[0].covenant_scope).toBe("repayment");
    expect(result.items[0]._covenant_evidence).toEqual(expect.arrayContaining([expect.objectContaining({ quote: obligation })]));
    expect(result.items[0]._covenant_extraction_trace).toBeInstanceOf(Array);
  });

  it("超过十二行的真实证据按源文分段保留，不因长度被丢弃", async () => {
    const obligationLines = Array.from({ length: 15 }, (_, index) => `借款人应完成第${index + 1}项资金管理要求。`);
    const longEvent = "借款人违反上述资金管理要求构成违约事件。";
    const longRemedy = "发生上述违约事件时，贷款人有权宣布贷款提前到期并要求偿还本息。";
    const source = { id: "long", name: "长证据合同.pdf", text: ["资金管理义务", ...obligationLines, "违约事件", longEvent, "违约救济", longRemedy].join("\n") };
    const result = await extractCovenantEvidence({ documents: [source], extract: async request => request.stage === "candidates"
      ? response([{ ...candidate(longRemedy), document_id: "long" }])
      : response([linked(request.candidateId!, {
        title: "资金管理要求",
        evidence: [
          { document_id: "long", line_start: 2, line_end: 16, role: "obligation" },
          { document_id: "long", line_start: 18, line_end: 18, role: "default" },
          { document_id: "long", line_start: 20, line_end: 20, role: "consequence" },
        ],
      })]) });
    expect(result.unresolvedCount).toBe(0);
    const evidence = (result.items[0]._covenant_evidence ?? []) as Array<{ role: string; quote: string }>;
    expect(evidence.filter(item => item.role === "obligation")).toHaveLength(2);
    expect(evidence.every(item => source.text.includes(item.quote))).toBe(true);
    expect(evidence.filter(item => item.role === "obligation").flatMap(item => item.quote.split("\n"))).toEqual(obligationLines);
  });

  it("归集条款中的需提前和确保属于可测试义务", async () => {
    const accountObligation = "借款人按月归集收入，确保每月前3个工作日归集上月收入，并需提前5个工作日确保账户资金足额偿还当期本息。";
    const accountEvent = "借款人违反本合同的其他约定。";
    const accountRemedy = "当上述任一违约事件发生时，贷款人有权宣布贷款提前到期。";
    const source = { id: "account", name: "账户条款.pdf", text: [accountObligation, accountEvent, accountRemedy].join("\n") };
    const result = await extractCovenantEvidence({ documents: [source], extract: async request => request.stage === "candidates"
      ? response([{ ...candidate(accountRemedy), document_id: "account" }])
      : response([linked(request.candidateId!, {
        title: "借款人按月归集并提前备足偿债资金",
        evidence: [
          { document_id: "account", line_start: 1, line_end: 1, role: "obligation" },
          { document_id: "account", line_start: 2, line_end: 2, role: "default" },
          { document_id: "account", line_start: 3, line_end: 3, role: "consequence" },
        ],
      })]) });
    expect(result.unresolvedCount).toBe(0);
    expect(result.items[0].covenant_scope).toBe("repayment");
  });

  it("越界行号和伪造引文保留原始拒绝证据，不静默过滤", async () => {
    const rejected = { document_id: doc.id, line_start: 99999, line_end: 99999, role: "obligation" };
    const result = await extractCovenantEvidence({ documents: [doc], extract: async (request) => request.stage === "candidates" ? response([candidate()]) : response([linked(request.candidateId!, { evidence: [rejected] })]) });
    expect(result.unresolvedCount).toBe(1);
    expect(result.items[0]._covenant_rejected_evidence).toEqual([rejected]);
    expect(result.items[0]._covenant_raw_link).toBeDefined();
  });

  it("肯定的自动到期仍被拒绝", async () => {
    const result = await extractCovenantEvidence({ documents: [doc], extract: async (request) => request.stage === "candidates" ? response([candidate()]) : response([linked(request.candidateId!, { breach_consequence: "借款自动提前到期。" })]) });
    expect(result.unresolvedCount).toBe(1);
    expect(result.items[0]._covenant_review_reason).toContain("选择权");
  });
  it("候选提示只扫描还款后果，不正向罗列普通义务", () => {
    expect(COVENANT_CANDIDATE_PROMPT).toContain("只扫描明确的还款后果锚点");
    expect(COVENANT_CANDIDATE_PROMPT).toContain("不要正向罗列");
    expect(COVENANT_CANDIDATE_PROMPT).toContain("source_segment_id");
  });

  it("第二阶段按可执行证据链覆盖资金、公司行为、司法和明确合规义务", () => {
    expect(COVENANT_LINK_PROMPT).toContain("违反义务→构成违约事件→贷款人有权宣布提前到期");
    expect(COVENANT_LINK_PROMPT).toContain("贷款用途、支付方式、监管账户、收入归集和偿债资金准备");
    expect(COVENANT_LINK_PROMPT).toContain("报表/项目报告报送、重大事项通知、保险和追加担保");
    expect(COVENANT_LINK_PROMPT).toContain("条数由独立审计事项决定");
    expect(COVENANT_LINK_PROMPT).toContain("纯违约定义、罚息计算");
    expect(COVENANT_LINK_PROMPT).toContain("承担主体＋具体可测试事项");
    expect(COVENANT_LINK_PROMPT).not.toContain("即使被总括性违约条款覆盖，也不能逐条展开");
  });

  it("跨页引用从后果反向找到违约事件和具体财务约定", () => {
    const context = retrieveCovenantContext([doc], { documentId: "main", quote: remedy, searchTerms: ["第21.2条违约事件"] });
    expect(context).toContain(event);
    expect(context).toContain(obligation);
    expect(covenantReferences("第十九条、第21.18款、第21.4款(b)段")).toEqual(["19", "21.18", "21.4"]);
  });

  it("通用违约事件救济会把同一合同的具体义务提供给反向关联", () => {
    const general = { id: "spread", name: "双页借款合同.pdf", text: [
      "PDF第3页\n第三条 贷款用途\n贷款仅用于项目建设，不得用于股权投资。",
      "PDF第12页\n第十三条 账户及项目收入归集\n合同项下贷款金额应当100%通过贷款人结算。",
      "PDF第18页\n第二十条 借款人的权利和义务\n出售占总资产10%以上资产应事先取得贷款人书面同意。",
      "PDF第21页\n第二十三条 违约事件及处理\n下列事件被视为违约事件：借款人违反本合同约定或未履行本合同项下义务。\n贷款人有权宣布贷款提前到期，同时要求借款人限期偿还贷款本息。",
    ].join("\n") };
    const context = retrieveCovenantContext([general], { documentId: "spread", quote: "宣布贷款提前到期", searchTerms: [] });
    expect(context).toContain("贷款仅用于项目建设");
    expect(context).toContain("100%通过贷款人结算");
    expect(context).toContain("总资产10%以上资产");
  });

  it("旧双页 OCR 把长句插断时，用同片段内连续后果短语保留候选", async () => {
    const brokenRemedy = "贷款人有权停止、取消贷款金额的发放和支付，或宣布贷款提前到期，同时要求借款人限期国家开发区无关文字偿还本合同项下贷款本息。";
    const brokenDoc = { id: "broken", name: "交错OCR.pdf", text: `PDF第8页\n第十二条\n${obligation}\n违反本条构成违约事件。\n${brokenRemedy}` };
    let linkText = "";
    const extract = vi.fn(async (request: CovenantExtractRequest) => {
      if (request.stage === "candidates") return response([{
        kind: "consequence", document_id: "broken", source_segment_id: "broken::s0",
        anchor: "贷款人有权停止、取消贷款金额的发放和支付，或宣布贷款提前到期，同时要求借款人限期偿还本合同项下贷款本息",
      }]);
      linkText = request.text;
      return response([]);
    });
    const result = await extractCovenantEvidence({ documents: [brokenDoc], extract });
    expect(result.candidateCount).toBe(1);
    expect(linkText).toContain("宣布贷款提前到期");
    expect(result.items[0].covenant_scope).toBe("unresolved");
    expect(String(result.items[0]._covenant_review_reason)).not.toContain("锚点经自动重试后仍无法回到");
  });

  it("同编号不同文件不会仅凭编号串联；明确文件引用可以补充", () => {
    const unrelated = { id: "other", name: "其他合同.pdf", text: "第21.2条\n其他主体违约。\n第21.18条\n其他主体自动提前到期。" };
    expect(retrieveCovenantContext([doc, unrelated], { documentId: "main", quote: remedy, searchTerms: ["第21.2条"] })).not.toContain("其他主体");
    const supplement = { id: "supp", name: "补充.pdf", text: "第1条\n主合同.pdf第19.1条修改为资产负债率不得超过70%。" };
    expect(retrieveCovenantContext([doc, supplement], { documentId: "main", quote: remedy, searchTerms: ["第19.1条"] })).toContain("不得超过70%");
  });

  it("按稳定片段ID和短锚点定位，再由程序保留源文字", async () => {
    const source = { ...doc, text: doc.text.replace("有权通知", "有权，通知") };
    const extract = vi.fn(async (request: CovenantExtractRequest) => request.stage === "candidates"
      ? response([candidate("贷款人有权,通知借款人要求提前还款")])
      : response([linked(request.candidateId!, {
        evidence: [
          { document_id: "main", quote: obligation, role: "obligation" },
          { document_id: "main", quote: "贷款人有权,通知借款人要求提前还款", role: "consequence" },
        ],
      })]));
    const result = await extractCovenantEvidence({ documents: [source], extract });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].excerpt).toContain("贷款人有权，通知借款人要求提前还款");
    expect(result.items[0].excerpt).not.toContain("贷款人有权,通知借款人要求提前还款");
  });

  it("OCR 字间空格不会把已定位的提前还款后果误判为无效候选", async () => {
    const spacedRemedy = "发生第21.2条违约事件，贷款 人有权通知借款人要求提 前还款。";
    const source = { ...doc, text: doc.text.replace(remedy, spacedRemedy) };
    const extract = vi.fn(async (request: CovenantExtractRequest) => request.stage === "candidates"
      ? response([candidate()])
      : response([linked(request.candidateId!, {
        evidence: [
          { document_id: "main", quote: obligation, role: "obligation" },
          { document_id: "main", quote: event, role: "default" },
          { document_id: "main", quote: remedy, role: "consequence" },
        ],
      })]));
    const result = await extractCovenantEvidence({ documents: [source], extract });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].covenant_scope).toBe("repayment");
    expect(result.items[0].excerpt).toContain("提 前还款");
  });

  it("OCR 损坏提前二字时，用完整的宣布到期和限期偿还结构二次确认", () => {
    expect(hasRepaymentConsequence("宣布贪款浞前到期，同时要求借款人限期偿还本合同项下贷款本息、费用和其他应付款项")).toBe(true);
    expect(hasRepaymentConsequence("贷款本金于2028年12月31日到期应付")).toBe(false);
  });

  it("模型片段号错误但同合同锚点唯一时自动回定位并传递正确片段号", async () => {
    const source = { ...doc, text: `${"背景说明。".repeat(1200)}\n${doc.text}` };
    let firstCandidate = true;
    let linkedText = "";
    const extract = vi.fn(async (request: CovenantExtractRequest) => {
      if (request.stage === "candidates") {
        if (!firstCandidate) return response([]);
        firstCandidate = false;
        return response([candidate(remedy, { source_segment_id: "main::s0" })]);
      }
      linkedText = request.text;
      return response([linked(request.candidateId!)]);
    });
    const result = await extractCovenantEvidence({ documents: [source], extract });
    expect(result.items.some((item) => item.covenant_scope === "repayment")).toBe(true);
    expect(linkedText).toMatch(/source_segment_id\\?"?:\\?"main::s(?!0)\d+/);
  });

  it("一个后果锚点可反向形成多个审计目标，不要求恰好一项", async () => {
    const extract = vi.fn(async (request: CovenantExtractRequest) => request.stage === "candidates" ? response([candidate()]) : response([
      linked(request.candidateId!),
      linked(request.candidateId!, {
        title: "对外担保限制",
        covenant_category: "担保限制",
        contract_classification: "非指标类",
        is_financial: "否",
        evidence: [{ document_id: "main", quote: guaranteeObligation, role: "obligation" }, { document_id: "main", quote: remedy, role: "consequence" }],
      }),
    ]));
    const result = await extractCovenantEvidence({ documents: [doc], extract });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.covenant_category)).toEqual(["财务指标及资本金", "担保及融资限制"]);
  });

  it("通用违约链下的贷款用途、明确报送和司法事件可形成正式结果", async () => {
    const use = "借款人应将贷款用于项目建设，不得用于分红或购买金融资产。";
    const report = "借款人应在每季度结束后10个营业日内向贷款人报送项目报告。";
    const freeze = "借款人金额达到1亿元的资产被冻结且30个营业日内未解除。";
    const generalDefault = "借款人违反本合同项下任何具体义务构成违约事件。";
    const source = { ...doc, text: `${doc.text}\n${use}\n${report}\n${freeze}\n${generalDefault}` };
    const result = await extractCovenantEvidence({
      documents: [source],
      extract: async (request) => request.stage === "candidates" ? response([candidate()]) : response([
        linked(request.candidateId!, { title: "贷款用途及禁止用途", is_financial: "否", evidence: [{ document_id: "main", quote: use, role: "obligation" }, { document_id: "main", quote: generalDefault, role: "default" }, { document_id: "main", quote: remedy, role: "consequence" }] }),
        linked(request.candidateId!, { title: "项目报告报送期限", is_financial: "否", evidence: [{ document_id: "main", quote: report, role: "obligation" }, { document_id: "main", quote: generalDefault, role: "default" }, { document_id: "main", quote: remedy, role: "consequence" }] }),
        linked(request.candidateId!, { title: "重大资产冻结未解除", is_financial: "否", evidence: [{ document_id: "main", quote: freeze, role: "obligation" }, { document_id: "main", quote: generalDefault, role: "default" }, { document_id: "main", quote: remedy, role: "consequence" }] }),
      ]),
    });
    expect(result.items.map((item) => item.covenant_category)).toEqual(expect.arrayContaining([
      "资金用途及账户管理",
      "报送、通知、保险及增信义务",
      "诉讼、司法及持续经营事项",
    ]));
    expect(result.items.every((item) => item.covenant_scope === "repayment")).toBe(true);
  });

  it("相同主体、口径和触发方式的财务指标确定性合并并保留全部证据", () => {
    const rows = [linked("c1"), linked("c2", {
      title: "流动比率不低于1.2",
      evidence: [{ document_id: "main", quote: secondObligation, role: "obligation" }, { document_id: "main", quote: remedy, role: "consequence" }],
    })].map((row) => ({ ...row, _covenant_evidence: row.evidence }));
    const grouped = groupCovenantRows(rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].title).toBe("财务表现指标");
    expect(grouped[0]._covenant_group_members).toEqual(expect.arrayContaining(["资产负债率不超过65%", "流动比率不低于1.2"]));
    expect((grouped[0]._covenant_evidence as Array<{ quote: string }>).map((item) => item.quote)).toEqual(expect.arrayContaining([obligation, secondObligation]));
  });

  it("同一审计程序和同一后果的担保限制合并，资产处置保持独立", () => {
    const guaranteeTwo = "借款人未经贷款人同意不得为第三方提供抵押。";
    const base = {
      ...linked("c1", {
        title: "新增对外担保限制",
        covenant_category: "担保限制",
        contract_classification: "非指标类",
        is_financial: "否",
      }),
      _covenant_evidence: [
        { document_id: "main", quote: guaranteeObligation, role: "obligation" },
        { document_id: "main", quote: remedy, role: "consequence" },
      ],
    };
    const rows = [
      base,
      {
        ...base,
        title: "第三方抵押限制",
        _covenant_evidence: [
          { document_id: "main", quote: guaranteeTwo, role: "obligation" },
          { document_id: "main", quote: remedy, role: "consequence" },
        ],
      },
      {
        ...base,
        title: "重大资产处置限制",
        covenant_category: "资产处置",
        excerpt: "借款人未经同意不得处置重大资产。",
        _covenant_evidence: [
          { document_id: "main", quote: "借款人未经同意不得处置重大资产。", role: "obligation" },
          { document_id: "main", quote: remedy, role: "consequence" },
        ],
      },
    ];
    const grouped = groupCovenantRows(rows);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].title).toBe("对外担保上限");
    expect(grouped[0]._covenant_group_members).toEqual(expect.arrayContaining(["新增对外担保限制", "第三方抵押限制"]));
    expect(grouped[1].covenant_category).toBe("重大资产处置及公司行为");
  });

  it("不同主体和不同会计口径不合并，同一审计事项不同后果片段不重复成行", () => {
    const base = { ...linked("c1"), _covenant_evidence: linked("c1").evidence };
    const rows = [
      base,
      { ...base, title: "保证人指标", obligated_party: "保证人", _covenant_obligated_party: "保证人" },
      { ...base, title: "单体指标", measurement_basis: "单体口径", _covenant_measurement_basis: "单体口径" },
      { ...base, title: "自动到期指标", breach_consequence: "违反后自动立即到期", _covenant_trigger_mode: undefined, _covenant_evidence: [{ document_id: "main", quote: obligation, role: "obligation" }, { document_id: "main", quote: "违反后自动立即到期", role: "consequence" }] },
    ];
    expect(groupCovenantRows(rows)).toHaveLength(3);
  });

  it("一条候选定位失败会自动重试并保留待核实，不丢掉同段已验证结果", async () => {
    let candidateCalls = 0;
    const invalid = { kind: "consequence", document_id: "main", source_segment_id: "main::s0", anchor: "并不存在的立即到期文字" };
    const extract = vi.fn(async (request: CovenantExtractRequest) => {
      if (request.stage === "candidates") { candidateCalls += 1; return response([candidate(), invalid]); }
      return response([linked(request.candidateId!)]);
    });
    const result = await extractCovenantEvidence({ documents: [doc], extract });
    expect(candidateCalls).toBe(2);
    expect(result.items.some((item) => item.covenant_scope === "repayment")).toBe(true);
    expect(result.items.some((item) => item.covenant_scope === "unresolved")).toBe(true);
  });

  it("关联证据首次无法定位时自动重试单个锚点", async () => {
    let links = 0;
    const extract = vi.fn(async (request: CovenantExtractRequest) => {
      if (request.stage === "candidates") return response([candidate()]);
      links += 1;
      return response([linked(request.candidateId!, links === 1 ? { evidence: [{ document_id: "main", quote: "模型改写且不存在", role: "consequence" }] } : {})]);
    });
    const result = await extractCovenantEvidence({ documents: [doc], extract });
    expect(links).toBe(2);
    expect(result.items[0].covenant_scope).toBe("repayment");
  });

  it("关联重试仍失败时只保留该锚点待核实，不能冒充成功", async () => {
    const extract = vi.fn(async (request: CovenantExtractRequest) => request.stage === "candidates" ? response([candidate()]) : response([]));
    const result = await extractCovenantEvidence({ documents: [doc], extract });
    expect(extract.mock.calls.filter(([request]) => request.stage === "link")).toHaveLength(2);
    expect(result.items[0].covenant_scope).toBe("unresolved");
  });

  it("缺后果、引用不完整或伪造证据进入待核实", async () => {
    for (const patch of [
      { evidence: [{ document_id: "main", quote: obligation, role: "obligation" }] },
      { references_resolved: false },
      { evidence: [{ document_id: "wrong", quote: obligation, role: "obligation" }] },
    ]) {
      const result = await extractCovenantEvidence({ documents: [doc], extract: async (request) => request.stage === "candidates" ? response([candidate()]) : response([linked(request.candidateId!, patch)]) });
      expect(result.items[0].covenant_scope).toBe("unresolved");
    }
  });

  it("多个独立关联默认四路并发执行", async () => {
    const remedies = Array.from({ length: 4 }, (_, index) => `发生第${index + 1}类违约时，贷款人有权要求借款人提前还款。`);
    const parallelDoc = { id: "parallel", name: "并发合同.pdf", text: [obligation, event, ...remedies].join("\n") };
    let active = 0;
    let maximum = 0;
    const extract = vi.fn(async (request: CovenantExtractRequest) => {
      if (request.stage === "candidates") return response(remedies.map((anchor) => ({ ...candidate(anchor), document_id: "parallel", source_segment_id: "parallel::s0" })));
      const index = Number(request.candidateId!.match(/c(\d+)/)?.[1] ?? 1) - 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return response([linked(request.candidateId!, {
        evidence: [
          { document_id: "parallel", quote: obligation, role: "obligation" },
          { document_id: "parallel", quote: event, role: "default" },
          { document_id: "parallel", quote: remedies[index], role: "consequence" },
        ],
      })]);
    });
    await extractCovenantEvidence({ documents: [parallelDoc], extract });
    expect(maximum).toBe(4);
  });

  it("同一范围已有正式结果时保留未核实诊断但不整段重试", async () => {
    let links = 0;
    const extract = vi.fn(async (request: CovenantExtractRequest) => {
      if (request.stage === "candidates") return response([candidate()]);
      links += 1;
      return response([
        linked(request.candidateId!),
        linked(request.candidateId!, { evidence: [{ document_id: "main", quote: "不存在的模型改写", role: "obligation" }] }),
      ]);
    });
    const result = await extractCovenantEvidence({ documents: [doc], extract });
    expect(links).toBe(1);
    expect(result.items.some((item) => item.covenant_scope === "repayment")).toBe(true);
    expect(result.items.some((item) => item.covenant_scope === "unresolved")).toBe(true);
  });

  it("相同条款和原因的未关联记录归并并保留原始次数", async () => {
    const secondRemedy = "发生其他违约事件时，贷款人有权通知借款人要求提前还款。";
    const source = { ...doc, text: `${doc.text}\n${secondRemedy}` };
    const extract = vi.fn(async (request: CovenantExtractRequest) => request.stage === "candidates"
      ? response([candidate(), candidate(secondRemedy)])
      : response([linked(request.candidateId!, { evidence: [{ document_id: "main", quote: "不存在的模型改写", role: "obligation" }] })]));
    const result = await extractCovenantEvidence({ documents: [source], extract, linkConcurrency: 1 });
    expect(result.unresolvedCount).toBe(1);
    expect(result.unresolvedRecordCount).toBe(2);
    expect(result.items.find((item) => item.covenant_scope === "unresolved")?._covenant_failure_count).toBe(2);
  });

  it("长合同全部分块均扫描，重复后果锚点只反向核对一次", async () => {
    const long = { ...doc, text: `${doc.text}\n${"背景资料\n".repeat(2500)}尾部仍须完整扫描` };
    expect(covenantChunks(long.text).at(-1)).toContain("尾部仍须完整扫描");
    let scanned = "";
    const extract = vi.fn(async (request: CovenantExtractRequest) => {
      if (request.stage === "link") return response([linked(request.candidateId!)]);
      scanned += request.text;
      return response(request.text.includes(remedy) ? [candidate()] : []);
    });
    const result = await extractCovenantEvidence({ documents: [long], extract });
    expect(scanned).toContain("尾部仍须完整扫描");
    expect(result.candidateCount).toBe(1);
    expect(extract.mock.calls.filter(([request]) => request.stage === "link")).toHaveLength(1);
  });

  it("只有普通义务而没有还款后果锚点可合法返回零项", async () => {
    const result = await extractCovenantEvidence({ documents: [{ id: "plain", name: "普通合同.pdf", text: obligation }], extract: async () => response([]) });
    expect(result.items).toEqual([]);
    expect(result.candidateCount).toBe(0);
  });

  it("无明确后果不得进入还款或补充正式范围", async () => {
    const invalidRemedy = "贷款人有权要求借款人补交相关资料。";
    const extract = vi.fn(async (request: CovenantExtractRequest) => request.stage === "candidates"
      ? response([candidate()])
      : response([linked(request.candidateId!, {
        covenant_scope: "supplementary",
        breach_consequence: "贷款人有权要求借款人补交相关资料。",
        evidence: [
          { document_id: "main", quote: obligation, role: "obligation" },
          { document_id: "main", quote: event, role: "consequence" },
        ],
      })]));
    const result = await extractCovenantEvidence({ documents: [doc], extract });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].covenant_scope).toBe("unresolved");
    expect(String(result.items[0].breach_consequence)).toContain("待核实");
    expect(String(result.items[0]._covenant_review_reason)).toContain("不纳入限制性契约正式结果");
  });

  it("宽扫描遗漏账户归集、保险和固定评级时只凭逐字源文与已核实后果链补齐", async () => {
    const account = "借款人应将本合同项下贷款金额的100%通过贷款人结算。借款人应按月归集BaaS服务收入，确保每月前3个工作日归集上月项目运营收入，并提前5个工作日确保资金足额偿还当期本息，赋予贷款人直接从销售资金\n监管账户中扣收本息的权利。";
    const insurance = "借款人应按照国家有关规定和行业要求，根据贷款项目运营需要向保险公司投保所需保险，并在购买保险后20个营业日内提供有关保险合同或保险单据。";
    const rating = "本合同签订后，如果借款人在贷款人处的信用评级下降到A+级以下（不含A+级）的，借款人应根据贷款人的要求为本合同项下贷款增加充分有效的担保措施。";
    const source = { ...doc, text: `${doc.text}\n第十三条 账户管理\n${account}\n第十九条 保险\n${insurance}\n第二十二条 担保\n${rating}` };
    const result = await extractCovenantEvidence({ documents: [source], extract: async (request) => request.stage === "candidates"
      ? response([candidate()])
      : response([linked(request.candidateId!)]) });
    for (const objective of ["account_collection", "insurance", "additional_security"]) {
      const supplement = result.items.find((item) => item._covenant_audit_objective === objective);
      expect(supplement?.covenant_scope).toBe("repayment");
      expect((supplement?._covenant_evidence as Array<{ quote: string }>).every((item) => source.text.includes(item.quote))).toBe(true);
    }
    expect(String(result.items.find((item) => item._covenant_audit_objective === "additional_security")?.trigger_standard)).toContain("A+级以下");
  });

  it("同一主题已有完整源文链时空拒绝数组的重复未关联不会再次显示", () => {
    const accountEvidence = [
      { document_id: "main", quote: "借款人应将贷款金额100%结算并按月归集项目运营收入。", role: "obligation", clause_ref: "第十三条" },
      { document_id: "main", quote: "当上述任一违约事件发生时，贷款人有权采取下列措施。", role: "default", clause_ref: "第二十三条" },
      { document_id: "main", quote: "贷款人有权宣布贷款提前到期并要求限期偿还本息。", role: "consequence", clause_ref: "第二十三条" },
    ];
    const formal = { ...linked("c1", { title: "账户归集", covenant_category: "资金用途及账户管理" }), _covenant_evidence: accountEvidence };
    const duplicate = {
      ...formal,
      title: "第二十三条第(二)项第8目：关联未完成",
      covenant_scope: "unresolved",
      _covenant_review_reason: "缺少具体义务到违约事件的关联证据。",
      _covenant_rejected_evidence: [],
      _covenant_evidence: [accountEvidence[0], accountEvidence[2]],
    };
    const grouped = groupCovenantRows([formal, duplicate]);
    expect(grouped.filter((item) => item.covenant_scope === "unresolved")).toHaveLength(0);
    expect(grouped.some((item) => item.covenant_scope === "repayment" && item._covenant_audit_objective === "account_collection")).toBe(true);
  });

  it("最终已转为内部支撑的诊断不再计入原始未关联记录", async () => {
    const general = "借款人可以申请调整普通还款计划。";
    const source = { id: "diagnostic", name: "诊断计数.pdf", text: `${general}\n${remedy}` };
    const result = await extractCovenantEvidence({ documents: [source], extract: async (request) => request.stage === "candidates"
      ? response([{ ...candidate(), document_id: "diagnostic", source_segment_id: "diagnostic::s0" }])
      : response([{
        ...linked(request.candidateId!),
        covenant_scope: "unresolved",
        unresolved_reason: "具体约定、后果或引用链未完整核实。",
        evidence: [{ document_id: "diagnostic", quote: general, role: "obligation" }],
      }]) });
    expect(result.unresolvedCount).toBe(0);
    expect(result.unresolvedRecordCount).toBe(0);
    expect(result.supportingCount).toBe(1);
  });

  it("纯通用救济即使被模型错标为obligation也不能进入正式底稿", async () => {
    const genericDefault = "借款人违反本合同的其他约定。";
    const genericRemedy = "如果发生下述事件，贷款人有权宣布贷款提前到期，同时要求借款人限期偿还贷款本息。";
    const source = { id: "generic", name: "通用救济.pdf", text: `${genericDefault}\n${genericRemedy}` };
    const result = await extractCovenantEvidence({ documents: [source], extract: async (request) => request.stage === "candidates"
      ? response([{ kind: "consequence", document_id: "generic", source_segment_id: "generic::s0", anchor: "宣布贷款提前到期", clause_ref: "第二十三条（二）" }])
      : response([linked(request.candidateId!, {
        title: "强制提前还款",
        evidence: [
          { document_id: "generic", quote: genericDefault, role: "obligation", clause_ref: "第二十三条（一）" },
          { document_id: "generic", quote: genericRemedy, role: "consequence", clause_ref: "第二十三条（二）" },
        ],
      })]) });
    expect(result.items.some((item) => item.covenant_scope === "repayment")).toBe(false);
    expect(result.unresolvedCount).toBe(0);
    expect(result.supportingCount).toBe(1);
    expect(result.items.find((item) => item.covenant_scope === "supporting")?._covenant_review_reason).toContain("不列为未关联");
  });

  it("同一审计事项关联不同罚息和提前到期证据时仍合并为一行", () => {
    const first = { ...linked("c1", { audit_objective: "debt_service", title: "未按期支付本金", measurement_basis: "还款计划" }), _covenant_evidence: [
      { document_id: "main", quote: "借款人未按还款计划支付到期贷款本金。", role: "obligation", clause_ref: "第六条" },
      { document_id: "main", quote: "贷款人有权宣布贷款提前到期。", role: "consequence", clause_ref: "第二十三条" },
    ] };
    const second = { ...linked("c2", { audit_objective: "debt_service", title: "未按期支付利息", measurement_basis: "还款计划", breach_consequence: "贷款人有权计收罚息并宣布贷款提前到期。" }), _covenant_evidence: [
      { document_id: "main", quote: "借款人未按约定的结息日和利率支付利息。", role: "obligation", clause_ref: "第十条" },
      { document_id: "main", quote: "逾期利息按罚息利率计收复利。", role: "condition", clause_ref: "第十条" },
      { document_id: "main", quote: "贷款人有权宣布贷款提前到期并计收罚息。", role: "consequence", clause_ref: "第二十三条" },
    ] };
    const grouped = groupCovenantRows([first, second]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].title).toBe("本息偿付");
    expect(grouped[0]._covenant_group_members).toEqual(expect.arrayContaining(["未按期支付本金", "未按期支付利息"]));
  });

  it("普通计划到期付款不属于提前还款后果", async () => {
    const ordinary = { id: "ordinary", name: "普通借款.pdf", text: "贷款本金于2028年12月31日到期应付。" };
    const extract = vi.fn(async () => response([{
      kind: "consequence",
      document_id: "ordinary",
      source_segment_id: "ordinary::s0",
      anchor: ordinary.text,
    }]));
    const result = await extractCovenantEvidence({ documents: [ordinary], extract });
    expect(result.items.every((item) => item.covenant_scope !== "repayment")).toBe(true);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { parsed: {} }, { parsed: { items: [] } }, { parsed: { items: [], coverage_complete: false } }, { parsed: { items: [], coverage_complete: true }, finish_reason: "length" }])("候选扫描连续两次空格式/截断/未完成才整体失败：%j", async (invalid) => {
    await expect(extractCovenantEvidence({ documents: [doc], extract: async () => invalid })).rejects.toThrow();
  });

  it("网络错误不落半份成功；重复资料ID去重且冲突版本拒绝", async () => {
    await expect(extractCovenantEvidence({ documents: [doc], extract: async () => { throw new Error("网络断开"); } })).rejects.toThrow("网络断开");
    const extract = vi.fn(async () => response([]));
    await extractCovenantEvidence({ documents: [doc, doc], extract });
    expect(extract).toHaveBeenCalledTimes(1);
    await expect(extractCovenantEvidence({ documents: [doc, { ...doc, text: "其他文字" }], extract })).rejects.toThrow("不同文字版本");
  });

  it("违反约定的后果生成稳定内部代码供八列表格投影", () => {
    expect(covenantConsequenceCodes({ breach_consequence: "贷款人有权要求提前还款，并计收罚息及违约金和赔偿损失。" })).toEqual(["early_repayment", "penalty_interest", "penalty", "compensation"]);
  });
});
