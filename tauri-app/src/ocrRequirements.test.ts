import { describe, expect, it, vi } from "vitest";
import { extractOcrScenario, getOcrPromptStages, loadOcrScenarios, withSavedOcrScenarios } from "./ocrScenarios";
import { readableLegacyRequirement, responseColumns } from "./ocrRequirements";
import type { OcrPageData } from "./ocrTypes";

vi.mock("./audipickCaseLibrary", async original => {
  const actual = await original<typeof import("./audipickCaseLibrary")>();
  return { ...actual, loadCaseLibraryState: vi.fn(async () => ({ active: { library: actual.DEFAULT_CASE_LIBRARY } })) };
});

const doc = { id: "requirements-document", name: "验证合同.pdf" };
const page = (text: string, number = 1): OcrPageData => ({ page: number, text, originalText: text, tables: [], originalTables: [], revision: 1, status: "completed", warnings: [] });
const scene = async (id: string) => (await loadOcrScenarios()).find(value => value.id === id)!;
const answer = (items: Record<string, unknown>[], columns?: { key: string; label: string }[]) => ({ parsed: { coverage_complete: true, items, ...(columns ? { columns } : {}) } });
const refs = (line = 1) => [{ line_start: line, line_end: line, role: "obligation" }];

describe("长合同自然语言分段与指标展示", () => {
  it("本金及期限散在不同页时核验每段后合为同一行，不保留分段别名空列", async () => {
    const selected = await scene("custom");
    const principal = "合同编号A001，本金为人民币600万元。";
    const term = "合同编号A001，借款期限为12个月。";
    const calls: { prompt: string; text: string }[] = [];
    const columns = [{ key: "本金", label: "本金" }, { key: "借款期限", label: "借款期限" }];
    const result = await extractOcrScenario({ scenario: selected,
      stages: [{ ...selected.defaultPrompts[0], prompt: "帮我提取下本金、借款期限，每份主合同一行" }], document: doc,
      pages: [page(principal + "\n" + "普通说明。".repeat(1200), 1), page(term, 8)],
      request: async input => {
        calls.push(input);
        if (input.prompt.includes("【汇总返回契约】")) {
          const data = JSON.parse(input.text.slice(input.text.indexOf("\n") + 1));
          expect(data.records).toHaveLength(2);
          expect(data.evidence.map((item: { text: string }) => item.text)).toEqual([principal, term]);
          expect(input.prompt).toContain("不同合同、账户、单据、交易或明细必须分行");
          return answer([{ 本金: "人民币600万元", 借款期限: "12个月", evidence_ids: ["E1", "E2"] }], columns);
        }
        expect(input.prompt).toContain("不要生成全部字段为未明确");
        const line = Number(input.text.match(/\[L(\d+)\]\[PDF第(?:1|8)页\]合同编号/)?.[1]);
        return input.text.includes(principal)
          ? answer([{ contract_principal: "人民币600万元", evidence_refs: refs(line) }], [{ key: "contract_principal", label: "借款本金" }])
          : answer([{ contract_term: "12个月", evidence_refs: refs(line) }], [{ key: "contract_term", label: "合同期限" }]);
      } });
    expect(calls).toHaveLength(3);
    expect(result.columns.slice(0, 2)).toEqual(columns);
    expect(result.columns).not.toContainEqual({ key: "contract_principal", label: "借款本金" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ 本金: "人民币600万元", 借款期限: "12个月", sourcePage: "1、8", evidence: principal + "\n\n" + term });
  });

  it("无命中段空证据占位仅可重新检查为确无匹配，不会把有事实坏行静默删除", async () => {
    const selected = await scene("custom");
    let irrelevant = 0;
    const result = await extractOcrScenario({ scenario: selected,
      stages: [{ ...selected.defaultPrompts[0], prompt: "仅提取本金" }], document: doc,
      pages: [page("本金600万元。", 1), page("普通说明。".repeat(1200), 2)],
      request: async ({ prompt, text }) => {
        if (text.includes("本金600万元")) return answer([{ 本金: "600万元", evidence_refs: refs() }]);
        if (++irrelevant === 1) return answer([{ 本金: "未明确", evidence_refs: [] }]);
        expect(prompt).toContain("不要生成全部字段为未明确");
        return answer([]);
      } });
    expect(irrelevant).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ 本金: "600万元", evidence: "本金600万元。" });
    await expect(extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts, document: doc,
      pages: [page("本金600万元。")], request: async () => answer([{ 本金: "600万元", evidence_refs: [] }]) })).rejects.toThrow("证据为空");
  });

  it("自定义未完成只允许一次拆分，拆后仍不完整不会假装成功", async () => {
    const selected = await scene("custom");
    const sources = ["本金600万元。", ...Array(30).fill("补充说明。".repeat(15)), "借款期限12个月。"];
    const counts = new Map<string, number>();
    const request = vi.fn(async ({ text }: { prompt: string; text: string }) => {
      counts.set(text, (counts.get(text) ?? 0) + 1);
      return { parsed: { coverage_complete: false, items: [] } };
    });
    await expect(extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts, document: doc,
      pages: [page(sources.join("\n"))], request })).rejects.toThrow("检查完整");
    expect(counts.size).toBe(2); // Original range, then the first smaller range; no recursive retry tree.
    expect([...counts.values()]).toEqual([1, 2]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("同证据中的投资、担保、融资三项保留三行，各自标准只展示本项且原文完整", async () => {
    const selected = await scene("loan_covenant");
    const quote = "20.1 借款人对外投资限额为人民币50000万元；对外提供担保限额为人民币30000万元；增加债务融资限额为人民币20000万元。";
    const titles = ["借款人对外投资限额", "借款人对外提供担保限额", "借款人增加债务融资限额"];
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts, document: doc,
      pages: [page(quote, 21)], request: async ({ text }) => {
        const line = Number(text.match(/\[L(\d+)\]20\.1/)?.[1]);
        return answer(titles.map(title => ({ title, evidence: refs(line) })));
      } });
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map(row => row.trigger_standard)).toEqual(quote.split("；"));
    expect(result.rows.every(row => row.evidence === quote && row.sourcePage === "21")).toBe(true);
  });

  it("指标标准不能裁掉未独立量化的共同条件及例外", async () => {
    const selected = await scene("loan_covenant");
    const quote = "借款人对外投资限额为人民币50000万元；经乙方事先书面同意的除外。";
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts, document: doc,
      pages: [page(quote)], request: async ({ text }) => answer([{ title: "借款人对外投资限额",
        evidence: refs(Number(text.match(/\[L(\d+)\]借款人/)?.[1])) }]) });
    expect(result.rows[0].trigger_standard).toBe(quote);
  });

  it("空匹配段的列不污染后续实际记录，只有一条命中也不产生同义空列", async () => {
    const selected = await scene("custom");
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts, document: doc,
      pages: [page("普通说明。".repeat(1200), 1), page("本金600万元，借款期限12个月。", 9)],
      request: async ({ text }) => text.includes("本金600万元")
        ? answer([{ principal_amount: "600万元", loan_term: "12个月", evidence_refs: refs() }],
          [{ key: "principal_amount", label: "本金" }, { key: "loan_term", label: "借款期限" }])
        : answer([], [{ key: "本金", label: "本金" }, { key: "借款期限", label: "借款期限" }]) });
    expect(result.rows).toHaveLength(1);
    expect(result.columns.slice(0, 2).map(column => column.key)).toEqual(["principal_amount", "loan_term"]);
    expect(result.rows[0]).not.toHaveProperty("本金");
    expect(result.rows[0]).not.toHaveProperty("借款期限");
  });

  it("真实捕获形态：全目标未知且备注明确本段未命中必须重查，无关证据不强塞入汇总", async () => {
    const selected = await scene("custom");
    const irrelevant = "还本计划：2023年12月21日还本100万元；2030年5月31日还本1050万元。";
    let repair = 0;
    const result = await extractOcrScenario({ scenario: selected,
      stages: [{ ...selected.defaultPrompts[0], prompt: "帮我提取下本金、借款期限" }], document: doc,
      pages: [page("本金600万元，借款期限12个月。\n" + "普通说明。".repeat(1200), 1), page(irrelevant, 9)],
      request: async ({ prompt, text }) => {
        if (text.includes("本金600万元")) return answer([{ 本金: "600万元", 借款期限: "12个月", evidence_refs: refs() }]);
        if (++repair === 1) {
          const line = Number(text.match(/\[L(\d+)\]\[PDF第9页\]还本计划/)?.[1]);
          return answer([{ 本金: "未明确", 借款期限: "未明确",
            备注: "本段包含还本计划，涉及具体还款日期和金额，但未直接约定借款本金总额及明确的借款起止期限条款。还本计划不等同于借款期限或本金事实，故标记为未明确。",
            evidence_refs: refs(line) }], [{ key: "本金", label: "本金" }, { key: "借款期限", label: "借款期限" }, { key: "备注", label: "备注" }]);
        }
        expect(prompt).toContain("没有实际摘录的目标事实");
        return answer([]);
      } });
    expect(repair).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].evidence).toBe("本金600万元，借款期限12个月。");
    expect(result.columns.map(column => column.key)).not.toContain("备注");
  });

  it("有明确独立合同身份时本金与期限均未知也保留，不依据空目标字段删记录", async () => {
    const selected = await scene("custom");
    const result = await extractOcrScenario({ scenario: selected,
      stages: [{ ...selected.defaultPrompts[0], prompt: "提取各合同本金、借款期限" }], document: doc,
      pages: [page("合同A001，借款人为甲公司。")], request: async () => answer([{ 合同编号: "A001", 借款人: "甲公司",
        本金: "未明确", 借款期限: "未明确", 备注: "本段未提供本金总额及明确的借款期限。", evidence_refs: refs() }]) });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ 合同编号: "A001", 借款人: "甲公司", 本金: "未明确", 借款期限: "未明确" });
  });

  it("有出处不代表有事实：还本计划推断值必须修复，不能直接当借款期限", async () => {
    const selected = await scene("custom");
    const request = vi.fn()
      .mockResolvedValueOnce(answer([{ 本金: "未明确", 借款期限: "2023年12月21日至2030年5月31日（依据还本计划推断）", evidence_refs: refs() }]))
      .mockResolvedValueOnce(answer([]));
    const result = await extractOcrScenario({ scenario: selected,
      stages: [{ ...selected.defaultPrompts[0], prompt: "帮我提取下本金、借款期限" }], document: doc,
      pages: [page("还本计划：2023年12月21日还本100万元；2030年5月31日还本1050万元。")], request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].prompt).toContain("含推断值");
    expect(result.rows).toEqual([]);
    await expect(extractOcrScenario({ scenario: selected, stages: [{ ...selected.defaultPrompts[0], prompt: "提取借款期限" }], document: doc,
      pages: [page("还本计划：2023年12月21日还本100万元；2030年5月31日还本1050万元。")],
      request: async () => answer([{ 借款期限: "2023年12月21日至2030年5月31日", evidence_refs: refs() }]) })).rejects.toThrow("还款计划或其他日期");
  });

  it("不因本金缺失删掉合法独立记录；正文及附件同主合同规则在实际请求中生效", async () => {
    const selected = await scene("custom");
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts, document: doc,
      pages: [page("合同A001借款期限12个月。\n合同B001借款期限6个月。")], request: async ({ prompt }) => {
        expect(prompt).toContain("还本计划不是新的借款");
        return answer([{ 合同编号: "A001", 本金: "未明确", 借款期限: "12个月", evidence_refs: refs(1) },
          { 合同编号: "B001", 本金: "未明确", 借款期限: "6个月", evidence_refs: refs(2) }]);
      } });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map(row => row.合同编号)).toEqual(["A001", "B001"]);
  });

  it("额度证据不能直接冒充本金，但允许明确保留授信额度口径", async () => {
    const selected = await scene("custom");
    const request = vi.fn()
      .mockResolvedValueOnce(answer([{ principal_amount: "373万元", evidence_refs: refs() }]))
      .mockResolvedValueOnce(answer([{ principal_amount: "实际本金未明确；授信额度373万元", evidence_refs: refs() }]));
    const result = await extractOcrScenario({ scenario: selected, stages: [{ ...selected.defaultPrompts[0], prompt: "提取本金" }], document: doc,
      pages: [page("本合同授信额度为373万元。")], request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.rows[0].principal_amount).toBe("实际本金未明确；授信额度373万元");
  });

  it("用户明确要求计算时允许有依据的推算，并接受不含固定借款术语的实际期限措辞", async () => {
    const selected = await scene("custom");
    const derived = await extractOcrScenario({ scenario: selected,
      stages: [{ ...selected.defaultPrompts[0], prompt: "按还本计划首末日期推算跨度，作为估算借款期限并注明依据" }], document: doc,
      pages: [page("还本计划：2023年12月21日还本100万元；2030年5月31日还本1050万元。")],
      request: async () => answer([{ 借款期限: "2023年12月21日至2030年5月31日（依据还本计划推断）", evidence_refs: refs() }]) });
    expect(derived.rows[0].借款期限).toContain("依据还本计划推断");
    const explicit = await extractOcrScenario({ scenario: selected,
      stages: [{ ...selected.defaultPrompts[0], prompt: "摘录本金和借款期限" }], document: doc,
      pages: [page("期限为12个月，自2026年1月1日起至2026年12月31日止。")],
      request: async () => answer([{ 借款期限: "12个月，自2026年1月1日起至2026年12月31日止", evidence_refs: refs() }]) });
    expect(explicit.rows[0].借款期限).toContain("12个月");
    await expect(extractOcrScenario({ scenario: selected,
      stages: [{ ...selected.defaultPrompts[0], prompt: "提取本金和借款期限，不要自行推算，不能计算" }], document: doc,
      pages: [page("还本计划：2023年12月21日还本100万元；2030年5月31日还本1050万元。")],
      request: async () => answer([{ 借款期限: "2023年12月21日至2030年5月31日（依据还本计划推断）", evidence_refs: refs() }]) })).rejects.toThrow("含推断值");
  });
});

describe("自然语言摘录要求与内部输出协议", () => {
  it("全部14个预设只有自然语言业务要求，实际请求仍有完整性与原文证据协议", async () => {
    const all = await loadOcrScenarios();
    expect(all).toHaveLength(14);
    for (const selected of all) {
      const requirements = getOcrPromptStages(selected);
      expect(requirements).toHaveLength(1);
      expect(requirements[0].prompt).not.toMatch(/JSON|coverage_complete|evidence_refs|line_start|【字段定义】|\b[a-z_]+\s*:/i);
      expect(requirements[0].prompt).toContain("Excel");
      expect(selected.internalPrompts?.[0].prompt).toMatch(/JSON|evidence|字段定义/);
      const request = vi.fn(async ({ prompt, text }: { prompt: string; text: string }) => {
        expect(prompt).toContain("coverage_complete");
        expect(prompt).toContain("【内部表格组织规则】");
        expect(prompt).toContain(requirements[0].prompt);
        const line = Number(text.match(/\[L(\d+)\](?:\[PDF第3页\])?借款人资产负债率/)?.[1]);
        expect(line).toBeGreaterThan(0);
        return answer([{ title: "资产负债率", consequence: "本条未明确", [selected.id === "loan_covenant" ? "evidence" : "evidence_refs"]: refs(line) }]);
      });
      const result = await extractOcrScenario({ scenario: selected, stages: requirements, document: doc,
        pages: [page("借款人资产负债率不得超过65%。", 3)], request });
      expect(result.rows[0]).toMatchObject({ sourcePage: "3", evidence: "借款人资产负债率不得超过65%。" });
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("借款通用场景可直接自然语言指定四列，内部核验字段不能在Excel重新冒出来", async () => {
    const selected = await scene("loan_general");
    const requirement = "每份合同一行，只要借款人、金额、利率、到期日四列。";
    const columns = [{ key: "borrower", label: "借款人" }, { key: "contract_principal", label: "金额" }, { key: "interest_rate", label: "利率" }, { key: "maturity_date", label: "到期日" }];
    const text = "借款人甲公司，金额001200.00元，利率4.35%，到期日2027年9月1日。合同编号A001。";
    const request = vi.fn(async ({ prompt }: { prompt: string; text: string }) => {
      expect(prompt).toContain(requirement);
      return answer([{ borrower: "甲公司", contract_principal: "001200.00元", interest_rate: "4.35%", maturity_date: "2027年9月1日", contract_no: "A001", auditor_summary: "不要自动成为额外列", evidence_refs: refs() }], columns);
    });
    const result = await extractOcrScenario({ scenario: selected, stages: [{ ...selected.defaultPrompts[0], prompt: requirement }], document: doc, pages: [page(text, 8)], request });
    expect(result.columns.slice(0, 4)).toEqual(columns);
    expect(result.columns).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "contract_no" })]));
    expect(result.rows[0]).toMatchObject({ borrower: "甲公司", contract_principal: "001200.00元", interest_rate: "4.35%", maturity_date: "2027年9月1日", sourcePage: "8", evidence: text });
    expect(result.rows[0]).not.toHaveProperty("contract_no");
    expect(result.rows[0]).not.toHaveProperty("auditor_summary");
  });

  it("自定义只描述信息目标，由模型组织中文列，账号前导零与原始日期单位均保留", async () => {
    const selected = await scene("custom");
    const text = "单证号ZD001；银行账号001234567890；金额人民币600万元；日期2024年5月10日。";
    const columns = [{ key: "单证号", label: "单证号" }, { key: "账号", label: "账号" }, { key: "金额", label: "金额" }, { key: "日期", label: "日期" }];
    const result = await extractOcrScenario({ scenario: selected,
      stages: [{ ...selected.defaultPrompts[0], prompt: "把这份单证的重要信息整理成Excel，不用我指定列名。" }], document: doc, pages: [page(text, 4)],
      request: async () => answer([{ 单证号: "ZD001", 账号: "001234567890", 金额: "人民币600万元", 日期: "2024年5月10日", category: "内部核验字段", _trace: "隐藏数据", evidence_refs: refs() }], columns) });
    expect(result.columns.slice(0, 4)).toEqual(columns);
    expect(result.rows[0]).toMatchObject({ 账号: "001234567890", 金额: "人民币600万元", 日期: "2024年5月10日", _trace: "隐藏数据", sourcePage: "4", evidence: text });
    expect(result.rows[0]).not.toHaveProperty("category");
    expect(result.columns.some(column => column.key.startsWith("_"))).toBe(false);
  });

  it("没有新columns的旧返回兼容自动列，不插入场景中完全不存在的空列", async () => {
    const selected = await scene("invoice");
    const result = await extractOcrScenario({ scenario: selected, stages: getOcrPromptStages(selected), document: doc,
      pages: [page("发票号码00123。")], request: async () => answer([{ invoice_no: "00123", evidence_refs: refs() }]) });
    expect(result.columns[0]).toEqual({ key: "invoice_no", label: "发票号码" });
    expect(result.columns.some(column => column.key === "buyer_name")).toBe(false);
    expect(result.rows[0].invoice_no).toBe("00123");
  });

  it("旧命名JSON场景展示保留业务要求且隐藏格式示例，历史汇总配置不被丢弃", async () => {
    const all = await loadOcrScenarios();
    const base = all.find(item => item.id === "loan_general")!;
    const legacy = "只摘录金额超过100万元的借款。\n【字段定义】\nborrower: 借款人\n【输出要求】\n只输出JSON。\n{\"coverage_complete\":true,\"items\":[]}\n【业务补充】\n保留抵押物名称，不收录正常付息。";
    const saved = withSavedOcrScenarios(all, [{ id: "saved-natural", name: "大额借款", baseScenarioId: base.id, version: "old", fields: base.fields,
      stages: [{ id: "extract", label: "旧摘录", prompt: legacy }, { id: "consolidate", label: "旧汇总", prompt: "历史人工汇总业务约定" }] }]).at(-1)!;
    const stages = getOcrPromptStages(saved);
    expect(stages[0].prompt).toContain("金额超过100万元");
    expect(stages[0].prompt).toContain("保留抵押物名称");
    expect(stages[0].prompt).not.toMatch(/JSON|coverage_complete|borrower:|items/);
    expect(stages[1]).toEqual({ id: "consolidate", label: "旧汇总", prompt: "历史人工汇总业务约定" });
    expect(saved.defaultPrompts[0].prompt).toBe(legacy);
    expect(saved.internalPrompts).toBeDefined();
    stages[0].prompt = "编辑不污染历史";
    expect(saved.defaultPrompts[0].prompt).toBe(legacy);
  });

  it("旧输出段之后的人工补充需求也必须保留，不能因移除JSON而截掉用户约束", () => {
    const legacy = '只摘录借款。\n【输出要求】\n只输出JSON {"coverage_complete":true,"items":[]}\n用户补充：仅保留金额超过100万元且有抵押担保的合同。';
    const displayed = readableLegacyRequirement(legacy, "默认要求", []);
    expect(displayed).toContain("仅保留金额超过100万元且有抵押担保的合同");
    expect(displayed).not.toMatch(/JSON|coverage_complete|items/);
  });

  it.each([
    { name: "重复键", columns: [{ key: "金额", label: "金额" }, { key: "金额", label: "其他金额" }] },
    { name: "协议字段", columns: [{ key: "evidence_refs", label: "原文" }] },
    { name: "内部键", columns: [{ key: "_trace", label: "轨迹" }] },
    { name: "原型键", columns: [{ key: "__proto__", label: "名称" }] },
    { name: "空列名", columns: [{ key: "金额", label: " " }] },
    { name: "非字符串键", columns: [{ key: 8, label: "金额" }] },
    { name: "坏形状", columns: "金额" },
    { name: "超长列名", columns: [{ key: "金额", label: "甲".repeat(101) }] },
    { name: "过多列", columns: Array.from({ length: 201 }, (_, i) => ({ key: `列${i}`, label: `信息${i}` })) },
  ])("$name的列定义拒绝通过", ({ columns }) => {
    expect(() => responseColumns({ columns })).toThrow(/列/);
  });

  it("列定义错误只修复一次，不能拿空字段或错误结构作成功结果", async () => {
    const selected = await scene("custom");
    const row = { 金额: "00123", evidence_refs: refs() };
    const request = vi.fn()
      .mockResolvedValueOnce(answer([row], [{ key: "金额", label: "金额" }, { key: "金额", label: "重复" }]))
      .mockResolvedValueOnce(answer([row], [{ key: "金额", label: "金额" }]));
    const result = await extractOcrScenario({ scenario: selected, stages: getOcrPromptStages(selected), document: doc, pages: [page("金额00123")], request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].prompt).toContain("校验修复");
    expect(result.rows[0]).toMatchObject({ 金额: "00123", evidence: "金额00123" });
    const alwaysInvalid = vi.fn(async () => answer([row], [{ key: "evidence_refs", label: "原文" }]));
    await expect(extractOcrScenario({ scenario: selected, stages: getOcrPromptStages(selected), document: doc, pages: [page("金额00123")], request: alwaysInvalid })).rejects.toThrow(/列名/);
    expect(alwaysInvalid).toHaveBeenCalledTimes(2);
  });

  it("声明的列与实际字段不一致须修复，不能把其他字段中的账号静默投影成未明确", async () => {
    const selected = await scene("custom");
    const source = "银行账号001234567890，金额00123元。";
    const columns = [{ key: "账号", label: "银行账号" }, { key: "金额", label: "金额" }];
    const wrong = { 账户号码: "001234567890", 金额: "00123元", evidence_refs: refs() };
    const corrected = { 账号: "001234567890", 金额: "00123元", evidence_refs: refs() };
    const request = vi.fn().mockResolvedValueOnce(answer([wrong], columns)).mockResolvedValueOnce(answer([corrected], columns));
    const result = await extractOcrScenario({ scenario: selected, stages: getOcrPromptStages(selected), document: doc, pages: [page(source, 7)], request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].prompt).toContain("表格列与记录字段不一致");
    expect(result.rows[0]).toMatchObject({ 账号: "001234567890", 金额: "00123元", sourcePage: "7", evidence: source });
    expect(result.rows[0]).not.toHaveProperty("账户号码");
    const unrepaired = vi.fn(async () => answer([wrong], columns));
    await expect(extractOcrScenario({ scenario: selected, stages: getOcrPromptStages(selected), document: doc, pages: [page(source)], request: unrepaired })).rejects.toThrow("表格列与记录字段不一致");
    expect(unrepaired).toHaveBeenCalledTimes(2);
  });

  it("用户自然语言明确要求英文表头时保留业务英文，技术协议字段依然不可作为列", async () => {
    const selected = await scene("custom");
    const text = "账号001234，币种人民币。";
    const columns = [{ key: "account", label: "Account" }, { key: "currency", label: "Currency" }];
    const result = await extractOcrScenario({ scenario: selected, stages: [{ ...selected.defaultPrompts[0], prompt: "请用Account和Currency两列输出账号及币种，英文表头。" }], document: doc, pages: [page(text)],
      request: async () => answer([{ account: "001234", currency: "人民币", evidence_refs: refs() }], columns) });
    expect(result.columns.slice(0, 2)).toEqual(columns);
    expect(result.rows[0]).toMatchObject({ account: "001234", currency: "人民币", evidence: text });
  });

  it("自然语言缩小限制性场景关注范围时不强制补其他账户义务，但证据和无源同意仍严格", async () => {
    const selected = await scene("loan_restrictive");
    const text = "借款人不得对外提供担保。\n借款人应确保账户状态正常。";
    const stages = [{ ...selected.defaultPrompts[0], prompt: "只摘录对外担保限制，其余事项不要。" }];
    const request = vi.fn(async () => answer([{ category: "禁止性约束", requirement: "不得对外提供担保", consequence: "本条未明确", evidence_refs: refs() }]));
    const result = await extractOcrScenario({ scenario: selected, stages, document: doc, pages: [page(text)], request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    for (const bad of [
      { category: "须经同意的约束", requirement: "对外提供担保应事先取得贷款人同意", evidence_refs: refs() },
      { requirement: "不得对外提供担保", evidence_refs: refs(999) },
    ]) {
      const invalid = vi.fn(async () => answer([{ ...bad, consequence: "本条未明确" }]));
      await expect(extractOcrScenario({ scenario: selected, stages, document: doc, pages: [page(text)], request: invalid })).rejects.toThrow(/同意|来源|行号/);
      expect(invalid).toHaveBeenCalledTimes(2);
    }
  });

  it("并发段乱序完成时Excel业务列及记录仍按请求来源顺序，不能随网络快慢变化", async () => {
    const selected = await scene("loan_restrictive");
    let finishFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { finishFirst = resolve; });
    const firstColumns = [{ key: "requirement", label: "限制内容" }, { key: "party", label: "主体" }];
    const source = (index: number) => `借款人不得提供第${index}项担保。\n` + "中性背景说明。".repeat(360);
    const request = vi.fn(async ({ text }: { prompt: string; text: string }) => {
      const second = text.includes("第2项担保");
      if (second) finishFirst(); else await firstGate;
      return answer([{ requirement: second ? "第二项担保禁止" : "第一项担保禁止", party: "借款人", consequence: "本条未明确", evidence_refs: refs() }], second ? [...firstColumns].reverse() : firstColumns);
    });
    const result = await extractOcrScenario({ scenario: selected, stages: getOcrPromptStages(selected), document: doc, pages: [page(source(1), 5), page(source(2), 6)], request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.columns.slice(0, 2)).toEqual(firstColumns);
    expect(result.rows.map(row => row.requirement)).toEqual(["第一项担保禁止", "第二项担保禁止"]);
    expect(result.rows.map(row => row.sourcePage)).toEqual(["5", "6"]);
  });
});
