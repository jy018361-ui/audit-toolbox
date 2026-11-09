import { describe, expect, it, vi } from "vitest";
import {
  extractOcrScenario,
  getOcrPromptStages,
  loadOcrScenarios,
} from "./ocrScenarios";
import {
  extractFinancialMetrics,
  FINANCIAL_METRICS_PROMPT,
} from "./audipickCovenantExtraction";
import type { OcrPageData } from "./ocrTypes";
import {
  OcrDocumentDetailSchema,
  OcrProjectSchema,
  ocrResponseSchemas,
} from "./ocrTypes";
import {
  handlers as demoHandlers,
  jobHandlers as demoJobHandlers,
} from "./preview/demo/ocr";

vi.mock("./audipickCaseLibrary", async (original) => {
  const actual = await original<typeof import("./audipickCaseLibrary")>();
  return {
    ...actual,
    loadCaseLibraryState: vi.fn(async () => ({
      active: { library: actual.DEFAULT_CASE_LIBRARY },
    })),
  };
});

describe("OCR 浏览器演示契约", () => {
  it("预置可解码 PNG、已扫描单证、待扫描队列、表格、人工修订和失效摘录", () => {
    const saved = demoHandlers["ocr.projects"]({}) as { projects: unknown[] };
    const project = OcrProjectSchema.parse(saved.projects[0]);
    const listing = demoHandlers["ocr.documents"]({
      projectId: project.id,
    }) as { documents: { id: string }[] };
    expect(listing.documents.length).toBeGreaterThan(9);
    const docs = listing.documents.map((document) =>
      OcrDocumentDetailSchema.parse(
        demoHandlers["ocr.document"]({ documentId: document.id }),
      ),
    );
    expect(
      docs.filter((item) => item.document.status === "pending"),
    ).toHaveLength(9);
    expect(
      docs
        .filter((item) => item.document.status === "pending")
        .every((item) => !item.pages.length),
    ).toBe(true);
    expect(docs[0].pages[0].tables[0].rows[1][1]).toBe("00123456789012345678");
    expect(docs[1].document.revision).toBeGreaterThan(
      docs[1].extractions[0].sourceRevision,
    );
    const image = demoHandlers["ocr.document_bytes"]({
      documentId: docs[0].document.id,
    }) as { mimeType: string; dataBase64: string };
    expect(image.mimeType).toBe("image/png");
    expect(
      Array.from(atob(image.dataBase64).slice(0, 8), (character) =>
        character.charCodeAt(0),
      ),
    ).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(project.prompts.custom[0].prompt).toContain("演示项目");
  });

  it("项目 prompt 内存保存生效，识别完成事件前不提前写入页面", () => {
    const created = OcrProjectSchema.parse(
      demoHandlers["ocr.project_save"]({ name: "独立演示测试项目" }),
    );
    const prompts = {
      custom: [
        { id: "extract", label: "自定义", prompt: "修改后的演示 prompt" },
      ],
    };
    const updated = OcrProjectSchema.parse(
      demoHandlers["ocr.project_save"]({
        id: created.id,
        name: created.name,
        prompts,
      }),
    );
    expect(updated.prompts).toEqual(prompts);
    const imported = demoHandlers["ocr.document_import"]({
      projectId: created.id,
      paths: ["fixture.png"],
    }) as { documents: { id: string }[] };
    const documentId = imported.documents[0].id;
    const events = demoJobHandlers["ocr.recognize_page"]({
      documentId,
      page: 1,
      expectedRevision: 0,
    });
    expect(
      OcrDocumentDetailSchema.parse(
        demoHandlers["ocr.document"]({ documentId }),
      ).pages,
    ).toHaveLength(0);
    expect(events.at(-1)!.result).toMatchObject({
      page: 1,
      status: "completed",
    });
    expect(
      OcrDocumentDetailSchema.parse(
        demoHandlers["ocr.document"]({ documentId }),
      ).pages,
    ).toHaveLength(1);
    demoHandlers["ocr.project_delete"]({ id: created.id });
    expect(() => demoHandlers["ocr.document"]({ documentId })).toThrow(
      "不存在",
    );
  });

  it("多页多表演示返回同步可解码的逐页图片及十二张跨页表格", () => {
    const documentId = "ocr-demo-multipage";
    const document = OcrDocumentDetailSchema.parse(
      demoHandlers["ocr.document"]({ documentId }),
    );
    const images = ocrResponseSchemas["ocr.image_pages"].parse(
      demoHandlers["ocr.image_pages"]({ documentId }),
    ) as { pages: { page: number; imageBase64: string }[] };
    expect(document.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(document.pages.flatMap((page) => page.tables)).toHaveLength(12);
    expect(images.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    for (const page of images.pages) {
      expect(
        Array.from(
          atob(page.imageBase64.replace(/^data:[^,]+,/, "")).slice(0, 8),
          (value) => value.charCodeAt(0),
        ),
      ).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });

  it("演示导出按选择范围及三种方式返回实际选定目录中的文件清单", () => {
    const selected = ["ocr-demo-voucher", "ocr-demo-multipage"];
    for (const mode of ["single_sheet", "per_document", "individual"]) {
      const events = demoJobHandlers["ocr.export"]({
        projectId: "ocr-demo-general",
        documentIds: selected,
        mode,
        outputDir: "C:/合成输出",
      });
      const result = events.at(-1)!.result as {
        documentCount: number;
        outputPaths: string[];
      };
      expect(result.documentCount).toBe(2);
      expect(result.outputPaths).toHaveLength(mode === "individual" ? 2 : 1);
      expect(
        result.outputPaths.every((path) => path.startsWith("C:/合成输出\\")),
      ).toBe(true);
    }
  });
});

const page = (text: string, number = 1): OcrPageData => ({
  page: number,
  text,
  originalText: text,
  tables: [],
  originalTables: [],
  revision: 1,
  status: "completed",
  warnings: [],
});
const document = { id: "d1", name: "测试单证.pdf" };
const response = (items: Record<string, unknown>[], extra = {}) => ({
  parsed: { coverage_complete: true, items },
  ...extra,
});
const scenario = async (id: string) =>
  (await loadOcrScenarios()).find((item) => item.id === id)!;

function restrictiveRepairFixture() {
  const lines = [
    "借款人不得将贷款资金用于证券投资。",
    "未经贷款人书面同意，借款人不得变更项目用途。",
    "借款人应于每季度末向贷款人报送财务报告。",
  ];
  const requirements = ["贷款资金证券投资禁止", "变更项目用途须经同意", "季度财务报告报送"];
  const categories = ["禁止性约束", "须经同意的约束", "报送/检查等附带义务"];
  const rows = requirements.map((requirement, index) => ({
    category: categories[index], requirement, consequence: index === 1 ? "贷款人有权宣布借款提前到期" : "本条未明确",
    record_marker: ["已通过A不可重生", "待修复B", "已通过C不可重生"][index],
    evidence_refs: [{ line_start: index + 1, line_end: index + 1, role: "obligation" }],
  }));
  return { lines, rows, repaired: { ...rows[1], consequence: "本条未明确" } };
}

describe("OCR 场景默认提示词与逐字来源", () => {
  it("没有政府关键词的批准登记、担保及开户条件也不误作贷款人同意", async () => {
    const selected = await scenario("loan_restrictive");
    const lines = ["第五条 贷款发放", "一、发放贷款的前提条件", "除乙方全部或部分放弃外，只有持续满足下列前提条件，乙方才有义务发放贷款。",
      "1. 甲方应办妥相关批准、登记和保险手续。", "2. 符合乙方要求的担保应生效且持续有效。", "3. 甲方应开立提款和还款账户。"];
    const request = vi.fn(async () => response(["办妥批准登记保险手续", "确保担保生效且持续有效", "开立提款和还款账户"].map((requirement, index) => ({
      requirement, category: "须经同意的约束", consequence: "本条未明确",
      // Deliberately wide evidence includes the preceding approval condition.
      evidence_refs: [{ line_start: 3, line_end: 4 + index, role: "obligation" }],
    }))));
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(lines.join("\n"), 6)], request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.rows.map((row) => row.category)).toEqual(Array(3).fill("报送/检查等附带义务"));
  });

  it("项目批准字样不能充当贷款人同意的来源，业务正文自加同意仍拒绝", async () => {
    const selected = await scenario("loan_restrictive");
    const source = "甲方应办妥项目批准、登记和保险手续。";
    const request = vi.fn(async () => response([{ requirement: "办理项目登记须经贷款人事先同意", category: "须经同意的约束", consequence: "本条未明确",
      evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] }]));
    await expect(extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(source, 6)], request })).rejects.toThrow(/原文.*同意|同意要求/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("中文括号上级重置旧数字4，空白括号3不粘到后段，2.3小数条号正确定位", async () => {
    const selected = await scenario("loan_restrictive");
    const lines = ["第八条 甲方的义务", "二、具体义务", "（十二）保险措施", "4. 乙方要求的其他措施。",
      "（十三）甲方应采取建设期风险措施。", "第十一条 其他条款", "十二、其他约定", "（一）增值税", "2. 发票", "(2) 其他约定。",
      "2.3 甲方应协助作废发票。", "（二）送达安排", "3. 送达资料", "（3）此栏空白。", "甲方应定期更新联络资料。", "4. 法律后果", "（1）此栏空白。", "（三）甲方应配合核对通知资料。"];
    const chosen = lines.map((text, index) => ({ text, index })).filter((line) => line.text.includes("甲方应"));
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(lines.join("\n"), 18)], request: async () => response(chosen.map(({ text, index }) => ({
        requirement: text, clause: "模型的错误条号", category: "附带义务", consequence: "本条未明确",
        evidence_refs: [{ line_start: index + 1, line_end: index + 1, role: "obligation" }],
      }))) });
    expect(result.rows.map((row) => row.clause)).toEqual([
      "第八条 · 二 · （十三）", "第十一条 · 十二 · （一） · 2.3", "第十一条 · 十二 · （二） · 3", "第十一条 · 十二 · （三）",
    ]);
    expect(result.rows.map((row) => row.evidence)).toEqual(chosen.map((line) => line.text));
  });

  it.each(["先坏行后漏项", "先漏项后坏行"].flatMap((order) => [false, true].flatMap((wholeRetry) =>
    [false, true].map((repairWorks) => ({ order, wholeRetry, repairWorks })))))(
    "三类修复预算独立且总请求有界：$order，整段重试=$wholeRetry，最终有效=$repairWorks", async ({ order, wholeRetry, repairWorks }) => {
      const selected = await scenario("loan_restrictive");
      const source = ["甲方不得擅自处分贷款资金。", "所有项目收入应进入指定账户。"];
      const original = { requirement: "不得擅自处分贷款资金", party: "甲方", record_marker: "原有义务不可重生",
        category: "禁止性约束", consequence: "本条未明确",
        evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] };
      const added = { requirement: "所有项目收入进入指定账户", party: "甲方", record_marker: "唯一新增归集义务",
        category: "附带义务", consequence: "本条未明确",
        evidence_refs: [{ line_start: 2, line_end: 2, role: "obligation" }] };
      const unsupported = "乙方有权宣布借款提前到期";
      const expectedKinds: string[] = [];
      const outputs: ReturnType<typeof response>[] = [];
      if (wholeRetry) {
        expectedKinds.push("初次");
        outputs.push(response([], { parsed: { coverage_complete: false, items: [] } }));
      }
      expectedKinds.push(wholeRetry ? "整段" : "初次");
      if (order === "先坏行后漏项") {
        outputs.push(response([{ ...original, consequence: unsupported }]));
        expectedKinds.push("坏行"); outputs.push(response([original]));
        expectedKinds.push("补漏"); outputs.push(response([{ ...added, consequence: repairWorks ? "本条未明确" : unsupported }]));
      } else {
        outputs.push(response([original]));
        expectedKinds.push("补漏"); outputs.push(response([{ ...added, consequence: unsupported }]));
        expectedKinds.push("坏行"); outputs.push(response([{ ...added, consequence: repairWorks ? "本条未明确" : unsupported }]));
      }
      let call = 0;
      const request = vi.fn(async ({ prompt }: { prompt: string; text: string }) => {
        const kind = expectedKinds[call];
        if (kind === "整段") expect(prompt).toContain("请重新检查同一本轮来源后返回完整结果");
        if (kind === "坏行") expect(prompt).toContain("本轮是定点修复");
        if (kind === "补漏") expect(prompt).toContain("本轮是定点补漏");
        const output = outputs[call++];
        if (!output) throw new Error("不得发出第五次或重复类别的修复请求");
        return output;
      });
      const task = extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
        document, pages: [page(source.join("\n"), 13)], request });
      if (repairWorks) {
        const result = await task;
        expect(result.rows.map((row) => row.record_marker)).toEqual([original.record_marker, added.record_marker]);
        expect(result.rows.map((row) => row.evidence)).toEqual(source);
      } else await expect(task).rejects.toThrow("后果缺少原文");
      expect(request).toHaveBeenCalledTimes(wholeRetry ? 4 : 3);
    },
  );

  it("条款从原文跨页标题定位，提款条件放弃例外仅补当前节而不泄漏后续节或条", async () => {
    const selected = await scenario("loan_restrictive");
    const texts = [
      "第五条 贷款的发放与支付\n一、发放贷款的前提条件\n除乙方全部或部分放弃外，只有持续满足下列前提条件，乙方才有义务发放贷款。\n1. 甲方已办妥项目登记。",
      "2. 甲方应开立贷款账户。\n二、用款计划\n1. 甲方应提供最新用款计划。\n第六条 账户使用与监管\n3. 项目收入账户\n（1）甲方应提供该账户资金明细。",
    ];
    const requirements = ["办妥项目登记", "开立贷款账户", "提供最新用款计划", "提供该账户资金明细"];
    const request = vi.fn(async () => response([4, 5, 7, 10].map((line, index) => ({
      requirement: requirements[index], trigger: "合同约定时", category: "附带义务", clause: "模型伪造第九十九条",
      consequence: "本条未明确", evidence_refs: [{ line_start: line, line_end: line, role: "obligation" }],
    }))));
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(texts[0], 6), page(texts[1], 7)], request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.rows.map((row) => row.clause)).toEqual(["第五条 · 一 · 1", "第五条 · 一 · 2", "第五条 · 二 · 1", "第六条 · 3 · （1）"]);
    expect(result.rows.slice(0, 2).every((row) => String(row.trigger).includes("除乙方全部或部分放弃外，须持续满足"))).toBe(true);
    expect(result.rows.slice(2).every((row) => !String(row.trigger).includes("放弃"))).toBe(true);
    expect(result.rows.map((row) => row.sourcePage)).toEqual(["6", "7", "7", "7"]);
  });

  it.each([
    { name: "交易对手匹配", source: "甲方应确保其交易对手与借款具体用途及交易资料相符，各项资料准确无误。", requirement: "确保交易对手与借款用途及交易资料相符，并确保资料准确无误" },
    { name: "向司法机构通知地址变更", source: "一方在仲裁或民事诉讼中变更地址的，该方还应向仲裁机构、法院履行书面通知义务。", requirement: "变更地址时向仲裁机构、法院履行书面通知义务" },
  ].flatMap((duty) => [true, false].map((repairWorks) => ({ ...duty, repairWorks }))))(
    "$name漏项只能定点补齐，不能由其他已通过义务代替（补齐=$repairWorks）", async ({ source, requirement, repairWorks }) => {
      const selected = await scenario("loan_restrictive");
      const original = { category: "禁止性约束", requirement: "不得擅自处分贷款资金", record_marker: "已通过义务必须保留",
        consequence: "本条未明确", evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] };
      const added = { category: "附带义务", requirement, consequence: "本条未明确",
        evidence_refs: [{ line_start: 2, line_end: 2, role: "obligation" }] };
      const request = vi.fn().mockResolvedValueOnce(response([original]))
        .mockImplementationOnce(async ({ prompt }: { prompt: string; text: string }) => {
          expect(prompt).toContain("定点补漏");
          return response(repairWorks ? [added] : [original]);
        });
      const task = extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts, document,
        pages: [page("甲方不得擅自处分贷款资金。\n" + source, 26)], request });
      if (repairWorks) {
        const result = await task;
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toMatchObject({ record_marker: "已通过义务必须保留" });
        expect(result.rows[1]).toMatchObject({ requirement, evidence: source, sourcePage: "26" });
      } else await expect(task).rejects.toThrow("独立义务");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("同证据同主体只有一个义务的同义重发去重，保留原有完整书面证明例外", async () => {
    const selected = await scenario("loan_restrictive");
    const source = "除非甲方提供书面证明并经乙方认可，否则甲方不得主张项目总投资增加。";
    const common = { party: "甲方", category: "禁止性约束", consequence: "本条未明确",
      evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] };
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(source, 29)], request: async () => response([
        { ...common, requirement: "不得主张项目总投资增加", trigger: "除非提供书面证明并经乙方认可" },
        { ...common, requirement: "项目投资增加须经乙方认可", trigger: "主张增加投资时" },
      ]) });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ requirement: "不得主张项目总投资增加", trigger: "除非提供书面证明并经乙方认可", evidence: source });
  });

  it.each([
    { name: "多项ESG义务", source: "甲方承诺加强环境和社会风险管理，并应按乙方要求提交环境和社会风险报告。", requirements: ["加强环境和社会风险管理", "按乙方要求提交环境和社会风险报告"], parties: ["甲方", "甲方"] },
    { name: "列表中不同报送事项", source: "甲方应报送年度经营报告、融资余额明细。", requirements: ["报送年度经营报告", "报送融资余额明细"], parties: ["甲方", "甲方"] },
    { name: "不同财务阈值", source: "甲方资产负债率不得高于70%，流动比率不得低于0.1。", requirements: ["资产负债率不得高于70%", "流动比率不得低于0.1"], parties: ["甲方", "甲方"] },
    { name: "不同适用主体", source: "甲乙双方均应书面通知。", requirements: ["甲方书面通知", "乙方书面通知"], parties: ["甲方", "乙方"] },
  ])("同一证据的$name不被单义务去重规则误删", async ({ source, requirements, parties }) => {
    const selected = await scenario("loan_restrictive");
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(source, 27)], request: async () => response(requirements.map((requirement, index) => ({
        requirement, party: parties[index], category: "附带义务", consequence: "本条未明确",
        evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }],
      }))) });
    expect(result.rows.map((row) => row.requirement)).toEqual(requirements);
    expect(result.rows.map((row) => row.party)).toEqual(parties);
    expect(result.rows.every((row) => row.evidence === source)).toBe(true);
  });

  it("集团客户条件与模糊OCR费率只按原文保留，不将1%0静默改成1‰", async () => {
    const selected = await scenario("loan_restrictive");
    const group = "甲方如为集团客户，应及时报告甲方净资产10%以上关联交易的情况。";
    const repayment = "甲方提前还本须经乙方同意。";
    const rate = "违约金金额=提前还本额×提前还款天数×1%0。";
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page([group, repayment, rate].join("\n"), 17)], request: async () => response([
        { requirement: "及时报告净资产10%以上关联交易", trigger: "发生关联交易时", category: "附带义务", consequence: "本条未明确",
          evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] },
        { requirement: "提前还本须经乙方同意", trigger: "提前还本时", category: "须经同意的约束", consequence: "乙方有权收取违约金，金额=提前还本额×提前还款天数×1‰",
          evidence_refs: [{ line_start: 2, line_end: 2, role: "obligation" }, { line_start: 3, line_end: 3, role: "consequence" }] },
      ]) });
    expect(result.rows[0]).toMatchObject({ trigger: "仅甲方为集团客户时；发生关联交易时", category: "报送/检查等附带义务" });
    expect(result.rows[1].consequence).toContain("1%0");
    expect(result.rows[1].consequence).not.toContain("1‰");
    expect(result.rows[1].evidence).toContain(rate);
  });

  it("罚息利率节只过滤普通罚息独立行，后续新节真实限制仍保留", async () => {
    const selected = await scenario("loan_restrictive");
    const lines = ["第四条 贷款利率", "二、罚息利率", "逾期罚息利率为贷款利率上浮50%。", "第五条 资金使用", "一、借款用途", "借款人不得将贷款资金用于证券投资。"];
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(lines.join("\n"), 5)], request: async () => response([
        { requirement: "逾期罚息上浮50%", category: "附带义务", consequence: "本条未明确",
          evidence_refs: [{ line_start: 3, line_end: 3, role: "obligation" }] },
        { requirement: "禁止贷款资金证券投资", category: "禁止性约束", consequence: "本条未明确",
          evidence_refs: [{ line_start: 6, line_end: 6, role: "obligation" }] },
      ]) });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ requirement: "禁止贷款资金证券投资", clause: "第五条 · 一", evidence: lines[5] });
  });

  it("定点补漏只追加遗漏义务，即使模型重发整段也不覆盖或复制已核验行", async () => {
    const selected = await scenario("loan_restrictive");
    const lines = [
      "未经贷款人书面同意，借款人不得转让项目资产。",
      "所有项目收入应进入指定账户。",
      "借款人应于每季度末报送财务报告。",
    ];
    const original = [
      { category: "须经同意的约束", requirement: "转让项目资产须经书面同意", record_marker: "保留首条原记录",
        consequence: "本条未明确", evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] },
      { category: "报送/检查等附带义务", requirement: "每季度末报送财务报告", record_marker: "保留尾条原记录",
        consequence: "本条未明确", evidence_refs: [{ line_start: 3, line_end: 3, role: "obligation" }] },
    ];
    const added = { category: "报送/检查等附带义务", requirement: "所有项目收入进入指定账户", record_marker: "新增归集义务",
      consequence: "本条未明确", evidence_refs: [{ line_start: 2, line_end: 2, role: "obligation" }] };
    const request = vi.fn()
      .mockResolvedValueOnce(response(original))
      .mockImplementationOnce(async ({ prompt }: { prompt: string; text: string }) => {
        expect(prompt).toContain("定点补漏");
        expect(prompt).toContain("仅返回上述遗漏义务");
        // A model may ignore append-only instructions and rewrite valid rows.
        return response([
          { ...original[0], requirement: "被重写的资产转让义务", record_marker: "不应替换首条" },
          added,
          { ...original[1], record_marker: "不应替换尾条" },
        ]);
      });
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(lines.join("\n"), 13)], request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].text).toBe(request.mock.calls[0][0].text);
    expect(result.rows.map((row) => row.record_marker)).toEqual(["保留首条原记录", "新增归集义务", "保留尾条原记录"]);
    expect(result.rows.map((row) => row.requirement)).toEqual([original[0].requirement, added.requirement, original[1].requirement]);
    expect(result.rows.map((row) => row.evidence)).toEqual(lines);
    expect(result.rows.every((row) => row.sourcePage === "13")).toBe(true);
  });

  it("长段首次未完成即拆分，避免重复大段请求，子窗口完整覆盖来源及双并发上限", async () => {
    const selected = await scenario("loan_restrictive");
    const lines = Array.from({ length: 6 }, (_, index) =>
      `第${index + 1}项：借款人不得转让该项资产。` + "中性背景说明。".repeat(110));
    const pages = [page(lines.slice(0, 3).join("\n"), 7), page(lines[3], 9), page(lines.slice(4).join("\n"), 11)];
    const accepted: { text: string; page: number }[] = [];
    const incompleteInputs: string[] = [];
    let active = 0; let peak = 0;
    const request = vi.fn(async ({ text }: { prompt: string; text: string }) => {
      active++; peak = Math.max(peak, active);
      try {
        await Promise.resolve();
        const sent = [...text.matchAll(/^\[L(\d+)\]\[PDF第(\d+)页\](.*)$/gm)];
        if (sent.length > 2) {
          incompleteInputs.push(text);
          return { parsed: { coverage_complete: false, items: [] } };
        }
        accepted.push(...sent.map((match) => ({ text: match[3], page: Number(match[2]) })));
        return response(sent.map((match) => ({
          category: "禁止性约束", requirement: `${match[3].match(/^第\d+项/)![0]}资产转让限制`, consequence: "本条未明确",
          evidence_refs: [{ line_start: Number(match[1]), line_end: Number(match[1]), role: "obligation" }],
        })));
      } finally { active--; }
    });
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts, document, pages, request });
    expect(request).toHaveBeenCalledTimes(4);
    expect(incompleteInputs).toHaveLength(1);
    expect(peak).toBe(2);
    expect(accepted.map((line) => line.text).sort()).toEqual([...lines].sort());
    expect(result.rows.map((row) => row.evidence)).toEqual(lines);
    expect(result.rows.map((row) => row.sourcePage)).toEqual(["7", "7", "7", "9", "11", "11"]);
    expect(result.rows.map((row) => row.source_reference)).toEqual([7, 7, 7, 9, 11, 11].map((number) => `文件：${document.name}；第${number}页`));
  });

  it("拆分后的子窗口仍未完成时严格拒绝，不继续递归拆分或把部分结果当成功", async () => {
    const selected = await scenario("loan_restrictive");
    const lines = Array.from({ length: 4 }, (_, index) =>
      `第${index + 1}项：借款人不得转让该项资产。` + "中性背景说明。".repeat(110));
    const request = vi.fn(async (_input: { prompt: string; text: string }) => ({ parsed: { coverage_complete: false, items: [] } }));
    await expect(extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(lines.join("\n"), 18)], request })).rejects.toThrow("模型未确认本段检查完整");
    expect(request).toHaveBeenCalledTimes(3);
    const inputs = request.mock.calls;
    expect(inputs[1][0].text).toBe(inputs[2][0].text);
    expect(inputs[1][0].text.length).toBeLessThan(inputs[0][0].text.length);
    expect(inputs[2][0].text).toContain("[PDF第18页]");
  });

  it.each([true, false])("整段重试后发现坏行只允许一次定点修复（修复有效=%s）", async (validRepair) => {
    const selected = await scenario("loan_restrictive");
    const fixture = restrictiveRepairFixture();
    const request = vi.fn()
      .mockResolvedValueOnce({ parsed: { coverage_complete: false, items: [] } })
      .mockImplementationOnce(async ({ prompt }: { prompt: string; text: string }) => {
        expect(prompt).toContain("请重新检查同一本轮来源后返回完整结果");
        expect(prompt).not.toContain("本轮是定点修复");
        return response(fixture.rows);
      })
      .mockImplementationOnce(async ({ prompt }: { prompt: string; text: string }) => {
        const repair = prompt.slice(prompt.indexOf("本轮是定点修复"));
        expect(repair).toContain("待修复B");
        expect(repair).not.toContain("已通过A不可重生");
        expect(repair).not.toContain("已通过C不可重生");
        return response([validRepair ? fixture.repaired : fixture.rows[1]]);
      });
    const task = extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(fixture.lines.join("\n"), 22)], request });
    if (validRepair) {
      const result = await task;
      expect(result.rows.map((row) => row.record_marker)).toEqual(fixture.rows.map((row) => row.record_marker));
      expect(result.rows.map((row) => row.evidence)).toEqual(fixture.lines);
      expect(result.rows[1].consequence).toBe("本条未明确");
    } else await expect(task).rejects.toThrow("后果缺少原文");
    expect(request).toHaveBeenCalledTimes(3);
    expect(new Set(request.mock.calls.map(([input]) => input.text)).size).toBe(1);
  });

  it("跨页银行违约事件不变成借款人绝对禁止，新义务章节中的真实约束仍保留", async () => {
    const selected = await scenario("loan_restrictive");
    const riskA = "甲方发生合并且乙方认为危及债权安全时，乙方有权停止发放贷款。";
    const riskB = "甲方股东滥用法人独立地位且危及债权安全时，乙方有权停止发放贷款。";
    const duty = "借款人不得将贷款资金用于证券投资。";
    const request = vi.fn(async () => response([
      { category: "禁止性约束", requirement: "甲方不得合并", consequence: "本条未明确",
        evidence_refs: [{ line_start: 2, line_end: 2, role: "obligation" }] },
      { category: "禁止性约束", requirement: "甲方不得滥用法人独立地位", consequence: "本条未明确",
        evidence_refs: [{ line_start: 3, line_end: 3, role: "obligation" }] },
      { category: "禁止性约束", requirement: "贷款资金证券投资禁止", consequence: "本条未明确",
        evidence_refs: [{ line_start: 5, line_end: 5, role: "obligation" }] },
    ]));
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page("一、违约情形\n" + riskA, 16), page(riskB + "\n二、其他约定\n" + duty, 17)], request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ requirement: "贷款资金证券投资禁止", evidence: duty, sourcePage: "17" });
  });

  it("普通诉讼费及独立征信授权不混入限制性结果，合同特有资金限制仍保留", async () => {
    const selected = await scenario("loan_restrictive");
    const lines = ["借款人承担实现债权所需诉讼费。", "借款人同意乙方向征信机构报送信用信息。", "借款人不得擅自处分项目账户资金。"];
    const request = vi.fn(async () => response([
      { requirement: "承担实现债权的诉讼费", category: "附带义务" },
      { requirement: "同意乙方向征信机构报送信用信息", category: "附带义务" },
      { requirement: "不得擅自处分项目账户资金", category: "禁止性约束" },
    ].map((row, index) => ({ ...row, consequence: "本条未明确",
      evidence_refs: [{ line_start: index + 1, line_end: index + 1, role: "obligation" }] }))));
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(lines.join("\n"), 21)], request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ requirement: "不得擅自处分项目账户资金", evidence: lines[2] });
  });

  it("政府批准保证和肯定报送义务不因模型误分类变成贷款人同意或禁止性约束", async () => {
    const selected = await scenario("loan_restrictive");
    const lines = ["借款人保证建设项目已获政府主管部门批准。", "借款人应定期提供项目进度证明。"];
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(lines.join("\n"), 17)],
      request: async () => response([
        { category: "须经同意的约束", requirement: "保证项目已获政府批准", consequence: "本条未明确",
          evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] },
        { category: "禁止性约束", requirement: "定期提供项目进度证明", consequence: "本条未明确",
          evidence_refs: [{ line_start: 2, line_end: 2, role: "obligation" }] },
      ]),
    });
    expect(result.rows.map((row) => row.category)).toEqual(["报送/检查等附带义务", "报送/检查等附带义务"]);
    expect(result.rows.map((row) => row.evidence)).toEqual(lines);
  });

  it("同一证据中的或有负债率及金额上限拆为独立事项且保留两项阈值和原文", async () => {
    const selected = await scenario("loan_restrictive");
    const source = "借款人或有负债率不得超过50%，或有负债金额不得超过5000万元。";
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(source, 30)],
      request: async () => response([{ category: "财务指标约束", party: "借款人",
        requirement: "或有负债率不得超过50%且或有负债金额不得超过5000万元", consequence: "本条未明确",
        evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] }]),
    });
    expect(result.rows.map((row) => row.requirement)).toEqual(["或有负债率不得超过50%", "或有负债金额不得超过5000万元"]);
    expect(result.rows.every((row) => row.evidence === source && row.sourcePage === "30" && row.party === "借款人")).toBe(true);
  });

  it("限制性三条记录仅修复中间坏行，已核验记录原样保留并按来源顺序合并", async () => {
    const selected = await scenario("loan_restrictive");
    const fixture = restrictiveRepairFixture();
    const original = structuredClone(fixture.rows);
    const request = vi.fn()
      .mockResolvedValueOnce(response(fixture.rows))
      .mockImplementationOnce(async ({ prompt }: { prompt: string; text: string }) => {
        const repair = prompt.slice(prompt.indexOf("定点修复"));
        expect(repair).toContain("待修复B");
        expect(repair).not.toContain("已通过A不可重生");
        expect(repair).not.toContain("已通过C不可重生");
        return response([fixture.repaired]);
      });
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(fixture.lines.join("\n"), 7)], request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].text).toBe(request.mock.calls[0][0].text);
    expect(result.rows.map((row) => row.requirement)).toEqual(original.map((row) => row.requirement));
    expect(result.rows.map((row) => row.record_marker)).toEqual(original.map((row) => row.record_marker));
    expect(result.rows.map((row) => row.evidence)).toEqual(fixture.lines);
    expect(result.rows.map((row) => row.sourcePage)).toEqual(["7", "7", "7"]);
    expect(result.rows[1].consequence).toBe("本条未明确");
    expect(fixture.rows).toEqual(original);
  });

  it("坏行定点修复若重发整段，只接收原坏行匹配记录，其他已通过记录不重写或重复", async () => {
    const selected = await scenario("loan_restrictive");
    const fixture = restrictiveRepairFixture();
    const request = vi.fn().mockResolvedValueOnce(response(fixture.rows))
      .mockResolvedValue(response([
        { ...fixture.rows[0], record_marker: "模型擅自重生首行" },
        fixture.repaired,
        { ...fixture.rows[2], record_marker: "模型擅自重生尾行" },
      ]));
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(fixture.lines.join("\n"), 7)], request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((row) => row.record_marker)).toEqual(fixture.rows.map((row) => row.record_marker));
    expect(result.rows.map((row) => row.evidence)).toEqual(fixture.lines);
    expect(result.rows[1].consequence).toBe("本条未明确");
  });

  it.each(["未完成", "行号仍无效", "遗漏坏行"])("定点修复%s时拒绝整份成功，不让已通过两条掩盖失败", async (failure) => {
    const selected = await scenario("loan_restrictive");
    const fixture = restrictiveRepairFixture();
    const repaired = failure === "未完成"
      ? { parsed: { coverage_complete: false, items: [fixture.repaired] } }
      : failure === "行号仍无效"
        ? response([{ ...fixture.repaired, evidence_refs: [{ line_start: 99, line_end: 99, role: "obligation" }] }])
        : response([]);
    const request = vi.fn().mockResolvedValueOnce(response(fixture.rows)).mockResolvedValue(repaired);
    const task = extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(fixture.lines.join("\n"), 7)], request });
    await expect(task).rejects.toThrow(failure === "未完成" ? /检查完整/ : failure === "行号仍无效" ? /无效|超出/ : /修复|保留|缺少|遗漏/);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].prompt).toContain("定点修复");
  });

  it.each([
    { field: "requirement", content: "甲方合并隐含需经乙方同意" },
    { field: "trigger", content: "推定合并须事先取得乙方同意" },
    { field: "requirement", content: "甲方合并应事先取得乙方书面同意" },
  ])("银行风险触发事件不能在$field中推导无源同意义务：$content", async ({ field, content }) => {
    const selected = await scenario("loan_restrictive");
    const source = "甲方发生合并，乙方认为可能危及其债权实现时，乙方有权停止发放贷款。";
    const request = vi.fn(async () => response([{
      category: "其他约束", requirement: "甲方发生合并", trigger: "", [field]: content,
      consequence: "本条未明确",
      evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }],
    }]));
    await expect(extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(source, 17)], request })).rejects.toThrow(/原文|推断|同意|风险/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("提款前提应办妥登记不能误归无原文同意要求的须经同意约束", async () => {
    const selected = await scenario("loan_restrictive");
    const source = "借款人应在提款前办妥项目用地登记。";
    const request = vi.fn(async () => response([{
      category: "须经同意的约束", requirement: "提款前办妥项目用地登记", trigger: "提款前",
      consequence: "本条未明确", evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }],
    }]));
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(source, 9)], request });
    expect(result.rows[0]).toMatchObject({ category: "报送/检查等附带义务", requirement: "提款前办妥项目用地登记", evidence: source });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("保险赔款控制仅类别错标可本地纠正，无需再次请求模型或删除真实义务", async () => {
    const selected = await scenario("loan_restrictive");
    const source = "甲方应将乙方作为项目所投保商业保险的第一顺位保险金请求权人，或采取其他措施确保乙方能够有效控制保险赔款权益。";
    const request = vi.fn(async () => response([{
      category: "须经同意的约束", party: "甲方", requirement: "将乙方作为第一顺位保险金请求权人，或采取措施确保其有效控制保险赔款权益",
      trigger: "项目投保商业保险时", consequence: "本条未明确",
      evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }],
    }]));
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(source, 17)], request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ category: "报送/检查等附带义务", party: "甲方", trigger: "项目投保商业保险时", evidence: source, sourcePage: "17" });
  });

  it.each(["requirement", "trigger"])("纯肯定保险义务的%s自加贷款人同意仍严格拒绝，类别纠正不能掩盖事实虚构", async (field) => {
    const selected = await scenario("loan_restrictive");
    const source = "甲方应将乙方作为项目所投保商业保险的第一顺位保险金请求权人。";
    const request = vi.fn(async () => response([{
      category: "须经同意的约束", requirement: "指定保险金请求权人", trigger: "项目投保商业保险时",
      [field]: "指定保险金请求权人须经贷款人事先同意", consequence: "本条未明确",
      evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }],
    }]));
    await expect(extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(source, 17)], request })).rejects.toThrow(/原文.*同意|同意要求/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("保险赔款权益不套用一般财务承诺标签，真实泛泛财务指标承诺仍保留原类", async () => {
    const selected = await scenario("loan_restrictive");
    const insurance = "保险赔款受益权归贷款人所有，借款人应办理赔款划付手续。";
    const financial = "借款人承诺其财务指标持续符合本合同约定。";
    const result = await extractOcrScenario({
      scenario: selected, stages: selected.defaultPrompts, document,
      pages: [page(insurance + "\n" + financial, 11)],
      request: async () => response([
        { category: "一般财务承诺（具体指标待核对）", requirement: "办理保险赔款划付手续", consequence: "本条未明确",
          evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] },
        { category: "一般财务承诺（具体指标待核对）", requirement: "财务指标持续符合合同约定", consequence: "本条未明确",
          evidence_refs: [{ line_start: 2, line_end: 2, role: "obligation" }] },
      ]),
    });
    expect(result.rows[0]).toMatchObject({ category: "报送/检查等附带义务", evidence: insurance });
    expect(result.rows[1]).toMatchObject({ category: "一般财务承诺（具体指标待核对）", evidence: financial });
  });

  it.each([
    { name: "账户状态", source: "借款人应确保账户状态正常且未被冻结。", requirement: "维持约定的账户", trigger: "账户状态正常且未被冻结" },
    { name: "资料重交", source: "支付方式变更后，借款人应重新提交资料。", requirement: "重新提交资料", trigger: "支付方式变更后" },
    { name: "收入归集", source: "所有项目收入应进入指定账户。", requirement: "所有项目收入归集", trigger: "进入指定账户" },
    { name: "地址提前通知", source: "甲方变更送达地址应提前15个工作日书面通知贷款人。", requirement: "送达地址变更的通知义务", trigger: "提前15个工作日书面通知贷款人" },
    { name: "通用借款人地址期限", source: "借款人变更送达地址应提前10个工作日书面通知贷款人。", requirement: "送达地址变更的通知义务", trigger: "提前10个工作日书面通知贷款人" },
  ].flatMap((duty) => ["other", "empty"].map((initial) => ({ ...duty, initial }))))(
    "$name不能被另一条资金处分约束或空结果代替（$initial）且只修复一次", async ({ source, requirement, trigger, initial }) => {
      const selected = await scenario("loan_restrictive");
      const unrelated = "借款人不得擅自处分账户中的资金。";
      const other = { category: "禁止性约束", requirement: "不得擅自处分账户资金", consequence: "本条未明确",
        evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] };
      const correct = { category: "报送/检查等附带义务", requirement, trigger, consequence: "本条未明确",
        evidence_refs: [{ line_start: 2, line_end: 2, role: "obligation" }] };
      const request = vi.fn()
        .mockResolvedValueOnce(response(initial === "empty" ? [] : [other]))
        .mockImplementationOnce(async ({ prompt }: { prompt: string; text: string }) => {
          expect(prompt).toContain("本轮校验修复");
          expect(prompt).toContain("独立义务");
          return response([other, correct]);
        });
      const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
        document, pages: [page(unrelated + "\n" + source, 19)], request });
      expect(request).toHaveBeenCalledTimes(2);
      // Append-only repairs accept requested missing duties; they must not
      // introduce an unrelated row that was absent from the original output.
      expect(result.rows).toHaveLength(initial === "empty" ? 1 : 2);
      expect(result.rows.at(-1)).toMatchObject({ requirement, trigger, evidence: source, sourcePage: "19" });
    },
  );

  it("明确独立义务字段正确也不能在缺少行号证据时通过", async () => {
    const selected = await scenario("loan_restrictive");
    const request = vi.fn(async () => response([{
      category: "报送/检查等附带义务", requirement: "维持账户状态正常且未被冻结", trigger: "持续适用",
      consequence: "本条未明确", evidence_refs: [],
    }]));
    await expect(extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page("借款人应确保账户状态正常且未被冻结。", 20)], request })).rejects.toThrow("原文行号证据");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["15", "10"])("送达地址提前%s工作日通知不得被立即通知替代", async (days) => {
    const selected = await scenario("loan_restrictive");
    const source = `借款人变更送达地址应提前${days}个工作日书面通知贷款人。`;
    const row = { category: "报送/检查等附带义务", requirement: "送达地址变更通知", consequence: "本条未明确",
      evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] };
    const request = vi.fn()
      .mockResolvedValueOnce(response([{ ...row, trigger: "变更后立即通知" }]))
      .mockResolvedValueOnce(response([{ ...row, trigger: `变更送达地址前应提前${days}个工作日通知` }]));
    const result = await extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(source, 23)], request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.rows[0]).toMatchObject({ trigger: `变更送达地址前应提前${days}个工作日通知`, evidence: source });
  });

  it("原生parsed为null时解析完整JSON代码块，仍拒绝未完成和损坏结果", async () => {
    const selected = await scenario("loan_restrictive");
    const source = "借款人不得将贷款资金用于股权投资。";
    const parsed = { coverage_complete: true, items: [{ requirement: "贷款资金股权投资限制", consequence: "本条未明确",
      evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] }] };
    const raw = "```json\n" + JSON.stringify(parsed) + "\n```";
    const options = { scenario: selected, stages: selected.defaultPrompts, document, pages: [page(source, 3)] };
    const request = vi.fn(async () => ({ parsed: null, raw }));
    const result = await extractOcrScenario({ ...options, request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.rows[0]).toMatchObject({ sourcePage: "3", evidence: source });
    await expect(extractOcrScenario({ ...options, request: async () => ({ parsed: null,
      raw: "```json\n" + JSON.stringify({ ...parsed, coverage_complete: false }) + "\n```" }) })).rejects.toThrow("检查完整");
    await expect(extractOcrScenario({ ...options, request: async () => ({ parsed: null,
      raw: '```json\n{"coverage_complete":true,"items":[' }) })).rejects.toThrow("有效 JSON");
    // A genuinely supplied parsed result takes precedence over a conflicting
    // raw payload; fallback must not turn an explicit incomplete result true.
    await expect(extractOcrScenario({ ...options, request: async () => ({ parsed: { ...parsed, coverage_complete: false }, raw }) })).rejects.toThrow("检查完整");
  });
  it("旧限制性提示词仍补齐专属运行时协议，明确空后果不导致整段重复请求", async () => {
    const selected = await scenario("loan_restrictive");
    const source = "未经贷款人书面同意，借款人不得对外提供担保。";
    for (const consequence of ["未明确", "未约定", "无明确约定", "不适用", "无"]) {
      const request = vi.fn(async ({ prompt, text }: { prompt: string; text: string }) => {
        expect(prompt).toContain("用户保存的旧限制性规则");
        expect(prompt).toContain("coverage_complete");
        expect(prompt).toContain("evidence_refs");
        expect(prompt).toContain("obligation");
        expect(prompt).toContain("consequence");
        const line = Number(text.match(/\[L(\d+)\]\[PDF第4页\]/)?.[1]);
        return response([{ requirement: "提供担保须经同意", consequence,
          evidence_refs: [{ line_start: line, line_end: line, role: "obligation" }] }]);
      });
      const result = await extractOcrScenario({
        scenario: selected,
        stages: [{ ...selected.defaultPrompts[0], prompt: "用户保存的旧限制性规则，只输出业务字段。" }],
        document, pages: [page(source, 4)], request,
      });
      expect(request, consequence).toHaveBeenCalledTimes(1);
      expect(result.rows[0]).toMatchObject({ consequence: "本条未明确", sourcePage: "4", evidence: source });
    }
    const invalid = vi.fn(async () => response([{ consequence: "贷款自动提前到期",
      evidence_refs: [{ line_start: 1, line_end: 1, role: "obligation" }] }]));
    await expect(extractOcrScenario({ scenario: selected, stages: selected.defaultPrompts,
      document, pages: [page(source, 4)], request: invalid })).rejects.toThrow("后果缺少原文");
    expect(invalid).toHaveBeenCalledTimes(2);
  });

  it("三十页密集限制按小段最多双并发，乱序返回仍按来源排序且进度单调", async () => {
    const selected = await scenario("loan_restrictive");
    const pages = Array.from({ length: 30 }, (_, index) => page(
      `第${index + 1}页：未经贷款人书面同意不得转让该页所列资产。` + "合同补充说明。".repeat(80), index + 1));
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let active = 0; let peak = 0; let settled = false;
    const inputs: string[] = [];
    const work: { completed: number; total: number }[] = [];
    const task = extractOcrScenario({
      scenario: selected, stages: selected.defaultPrompts, document, pages,
      onWorkProgress: (value) => work.push(value),
      request: async ({ text }) => {
        const call = inputs.length; inputs.push(text); active++; peak = Math.max(peak, active);
        try {
          if (!call) await first;
          return response([...text.matchAll(/^\[L(\d+)\]\[PDF第(\d+)页\](.+)$/gm)].map((match) => ({
            requirement: `第${match[2]}页转让限制`, consequence: "本条未明确",
            evidence_refs: [{ line_start: Number(match[1]), line_end: Number(match[1]), role: "obligation" }],
          })));
        } finally { active--; }
      },
    }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(inputs.length).toBeGreaterThan(2));
    expect(settled).toBe(false);
    expect(peak).toBe(2);
    releaseFirst();
    const result = await task;
    expect(inputs.every((text) => text.length < 4_700)).toBe(true);
    const sentPages = inputs.flatMap((text) => [...text.matchAll(/\[PDF第(\d+)页\]/g)].map((match) => Number(match[1])));
    expect([...new Set(sentPages)].sort((a, b) => a - b)).toEqual(pages.map((item) => item.page));
    expect(result.rows.map((row) => Number(row.sourcePage))).toEqual(pages.map((item) => item.page));
    expect(result.rows.map((row) => row.evidence)).toEqual(pages.map((item) => item.text));
    expect(work.length).toBeGreaterThan(2);
    expect(work[0].completed).toBe(0);
    expect(work.at(-1)!.completed).toBe(work.at(-1)!.total);
    expect(work.every((value, index) => value.completed >= (work[index - 1]?.completed ?? 0))).toBe(true);
  });

  it("限制性后段传输失败停止新派发并等待在途任务，不将已完成片段冒充整份成功", async () => {
    const selected = await scenario("loan_restrictive");
    const pages = Array.from({ length: 12 }, (_, index) => page(
      `第${index + 1}页不得用于股权投资。` + "合同文字。".repeat(220), index + 1));
    let releaseFirst!: () => void; let failSecond!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const second = new Promise<void>((resolve) => { failSecond = resolve; });
    let calls = 0; let settled = false;
    const work: { completed: number; total: number }[] = [];
    const task = extractOcrScenario({
      scenario: selected, stages: selected.defaultPrompts, document, pages,
      onWorkProgress: (value) => work.push(value),
      request: async () => {
        const call = ++calls;
        if (call === 1) { await first; return response([]); }
        if (call === 2) { await second; throw new Error("模型连接失败"); }
        throw new Error("失败后不应派发新段");
      },
    });
    const outcome = task.then(() => { settled = true; return "错误地整份成功"; }, (error: Error) => { settled = true; return error.message; });
    await vi.waitFor(() => expect(calls).toBe(2));
    failSecond();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(calls).toBe(2);
    releaseFirst();
    expect(await outcome).toContain("模型连接失败");
    expect(calls).toBe(2);
    expect(work.at(-1)!.completed).toBeLessThan(work.at(-1)!.total);
  });

  it("限制性分段边界仍沿全文主句区分通知门槛与独立财务限制", async () => {
    const selected = await scenario("loan_restrictive");
    const introduction = "8.6 借款人应当在下列事项发生之日起7日内书面通知贷款人：\n(1) 修改章程；\n";
    const prior = introduction.padEnd(3_980, "说明");
    const event = "(10) 发生关联交易，且交易金额达到或超过最近经审计的净资产的10%；";
    const limit = "8.7 关联交易超过净资产20%须取得贷款人事先同意。";
    const inputs: string[] = [];
    const result = await extractOcrScenario({
      scenario: selected, stages: selected.defaultPrompts, document,
      pages: [page(prior, 12), page(event + "\n" + limit, 13)],
      request: async ({ text }) => {
        inputs.push(text);
        return response([...text.matchAll(/^\[L(\d+)\]\[PDF第13页\](.+)$/gm)].map((match) => ({
          category: "财务指标约束", requirement: match[2], consequence: "本条未明确",
          evidence_refs: [{ line_start: Number(match[1]), line_end: Number(match[1]), role: "obligation" }],
        })));
      },
    });
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.find((text) => text.includes(event))).not.toContain(introduction);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ category: "报送/检查等附带义务", evidence: event, sourcePage: "13" });
    expect(result.rows[1]).toMatchObject({ category: "财务指标约束", evidence: limit, sourcePage: "13" });
  });

  it("限制性重叠片段的完全相同记录仍只保留一条", async () => {
    const selected = await scenario("loan_restrictive");
    const restriction = "借款人不得将贷款资金用于股权投资。";
    const source = "说明。".repeat(1_100) + "\n" + restriction + "\n" + "补充说明。".repeat(1_000);
    let matchingRequests = 0;
    const result = await extractOcrScenario({
      scenario: selected, stages: selected.defaultPrompts, document, pages: [page(source, 5)],
      request: async ({ text }) => {
        const match = text.match(/^\[L(\d+)\]\[PDF第5页\]借款人不得将贷款资金用于股权投资。$/m);
        if (!match) return response([]);
        matchingRequests++;
        return response([{ requirement: "贷款资金用途禁止", consequence: "本条未明确",
          evidence_refs: [{ line_start: Number(match[1]), line_end: Number(match[1]), role: "obligation" }] }]);
      },
    });
    expect(matchingRequests).toBeGreaterThan(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ evidence: restriction, sourcePage: "5" });
  });

  it("限制性并发摘录的暂停和取消检查点阻止后续请求", async () => {
    const selected = await scenario("loan_restrictive");
    const pages = Array.from({ length: 12 }, (_, index) => page(
      `第${index + 1}页不得对外提供担保。` + "合同文字。".repeat(220), index + 1));
    let releaseRequests!: () => void; let resume!: () => void;
    const requestGate = new Promise<void>((resolve) => { releaseRequests = resolve; });
    const pauseGate = new Promise<void>((resolve) => { resume = resolve; });
    let paused = false; let cancelled = false; let calls = 0; let blocked = 0;
    const task = extractOcrScenario({
      scenario: selected, stages: selected.defaultPrompts, document, pages,
      checkpoint: async () => {
        if (cancelled) throw new Error("用户已取消");
        if (paused) { blocked++; await pauseGate; }
        if (cancelled) throw new Error("用户已取消");
      },
      request: async () => { calls++; await requestGate; return response([]); },
    });
    const outcome = task.then(() => "错误地整份成功", (error: Error) => error.message);
    await vi.waitFor(() => expect(calls).toBe(2));
    paused = true; releaseRequests();
    await vi.waitFor(() => expect(blocked).toBeGreaterThan(0));
    expect(calls).toBe(2);
    cancelled = true; resume();
    expect(await outcome).toContain("用户已取消");
    expect(calls).toBe(2);
  });
  it("分段结果核验完成才推进计数，校验修复不增加完成数", async () => {
    const selected = await scenario("custom");
    const work: { completed: number; total: number }[] = [];
    let calls = 0;
    await extractOcrScenario({
      scenario: selected, stages: selected.defaultPrompts, document,
      pages: [page("合成合同原文")],
      onWorkProgress: (value) => work.push(value),
      request: async () => {
        expect(work.at(-1)).toEqual({ completed: 0, total: 1 });
        calls++;
        return calls === 1 ? response([], { parsed: { coverage_complete: false, items: [] } }) : response([]);
      },
    });
    expect(calls).toBe(2);
    expect(work.at(-1)).toEqual({ completed: 1, total: 1 });
  });
  it("所有内置场景均有完整返回封装、行号回填与严格失败回归", async () => {
    const all = await loadOcrScenarios();
    const source = "借款人资产负债率不得超过65%。\n合同金额为001234元。";
    for (const selected of all) {
      const financial = selected.id === "loan_covenant";
      const request = vi.fn(
        async ({ prompt, text }: { prompt: string; text: string }) => {
          expect(prompt).toContain("coverage_complete");
          const line = Number(
            text.match(/\[L(\d+)\](?:\[PDF第8页\])?借款人资产负债率/)?.[1],
          );
          expect(line).toBeGreaterThan(0);
          return response([
            {
              title: "资产负债率",
              excerpt: "不应保存的模型改写",
              pages: "999",
              [financial ? "evidence" : "evidence_refs"]: [
                { line_start: line, line_end: line, role: "obligation" },
              ],
            },
          ]);
        },
      );
      const options = {
        scenario: selected,
        stages: getOcrPromptStages(selected),
        document,
        pages: [page(source, 8)],
      };
      const result = await extractOcrScenario({ ...options, request });
      expect(result.rows[0], selected.id).toMatchObject({
        sourcePage: "8",
        evidence: source.split("\n")[0],
      });
      expect(result.rows[0].excerpt, selected.id).not.toContain("模型改写");
      const invalid = vi.fn(async () => ({
        parsed: { coverage_complete: false, items: [] },
      }));
      await expect(
        extractOcrScenario({ ...options, request: invalid }),
        selected.id,
      ).rejects.toThrow("检查完整");
      expect(invalid).toHaveBeenCalledTimes(2);
      await expect(
        extractOcrScenario({
          ...options,
          request: async () =>
            response([
              {
                [financial ? "evidence" : "evidence_refs"]: [
                  { line_start: 9999, line_end: 9999, role: "obligation" },
                ],
              },
            ]),
        }),
        selected.id,
      ).rejects.toThrow("超出");
    }
  });

  it("旧编辑提示词补齐返回协议，修复一次后仍须重新通过证据校验，网络错误不重试", async () => {
    const selected = await scenario("loan_general");
    const options = {
      scenario: selected,
      stages: [
        {
          ...selected.defaultPrompts[0],
          prompt: '旧规则：只返回 {"items":[]}',
        },
        selected.defaultPrompts[1],
      ],
      document,
      pages: [page("本金600万元。", 2)],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        parsed: { items: [{ excerpt: "本金600万元" }] },
      })
      .mockResolvedValueOnce(
        response([
          { excerpt: "", evidence_refs: [{ line_start: 1, line_end: 1 }] },
        ]),
      );
    const result = await extractOcrScenario({ ...options, request });
    expect(result.rows[0]).toMatchObject({
      evidence: "本金600万元。",
      sourcePage: "2",
    });
    expect(request.mock.calls[0][0].prompt).toContain("只返回");
    expect(request.mock.calls[0][0].prompt).toContain("此前模板");
    expect(request.mock.calls[1][0].prompt).toContain("本轮校验修复");
    const network = vi.fn(async () => {
      throw new Error("服务超时");
    });
    await expect(
      extractOcrScenario({ ...options, request: network }),
    ).rejects.toThrow("服务超时");
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("跨段借款按证据编号汇总，不重抄非连续原文，未知编号严格拒绝", async () => {
    const selected = await scenario("loan_general");
    const options = {
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [
        page("本金600万元。\n" + "普通说明。".repeat(5000), 2),
        page("期限24个月。", 3),
      ],
    };
    const request = vi.fn(
      async ({ prompt, text }: { prompt: string; text: string }) => {
        if (prompt.includes("【汇总返回契约】")) {
          const input = JSON.parse(text.slice(text.indexOf("\n") + 1));
          expect(input.records.length).toBeGreaterThan(1);
          expect(
            input.evidence.map((item: { text: string }) => item.text),
          ).toEqual(["本金600万元。", "期限24个月。"]);
          return response([
            { contract_no: "A001", excerpt: "", evidence_ids: ["E1", "E2"] },
          ]);
        }
        const matches = [
          ...text.matchAll(
            /\[L(\d+)\]\[PDF第\d+页\](本金600万元。|期限24个月。)/g,
          ),
        ];
        return response(
          matches.map((match) => ({
            contract_no: "A001",
            excerpt: "",
            evidence_refs: [
              { line_start: Number(match[1]), line_end: Number(match[1]) },
            ],
          })),
        );
      },
    );
    const result = await extractOcrScenario({ ...options, request });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      sourcePage: "2、3",
      evidence: "本金600万元。\n\n期限24个月。",
    });
    expect(result.columns.map((column) => column.key)).not.toContain(
      "evidence_ids",
    );
    await expect(
      extractOcrScenario({
        ...options,
        request: async (params) =>
          params.prompt.includes("【汇总返回契约】")
            ? response([{ evidence_ids: ["E999"] }])
            : request(params),
      }),
    ).rejects.toThrow("证据编号无效");
    await expect(
      extractOcrScenario({
        ...options,
        request: async (params) =>
          params.prompt.includes("【汇总返回契约】")
            ? response([
                { contract_no: "A001", evidence_ids: ["E1", "E2"] },
                { contract_no: "A001", evidence_ids: ["E2"] },
              ])
            : request(params),
      }),
    ).rejects.toThrow("同一合同编号");
    await expect(
      extractOcrScenario({
        ...options,
        request: async (params) =>
          params.prompt.includes("【汇总返回契约】")
            ? response([{ contract_no: "A001", evidence_ids: ["E1"] }])
            : request(params),
      }),
    ).rejects.toThrow("遗漏本轮已核验证据");
  });

  it("借款主表不得省略本段单笔期限、限额及报送义务证据，缺失时明确修复", async () => {
    const selected = await scenario("loan_general");
    const lines = [
      "合同编号A001。",
      "19.1 本合同下每笔贷款期限不长于12月，全部贷款的到期日不迟于2025年12月30日。",
      "19.4 借款人须在贷款发放后15日内汇总报告支付情况。",
      "20.1 借款人对外投资限额为人民币50000万元。",
    ];
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            contract_no: "A001",
            evidence_refs: [{ line_start: 1, line_end: 1 }],
          },
        ]),
      )
      .mockResolvedValueOnce(
        response([
          {
            contract_no: "A001",
            evidence_refs: [{ line_start: 1, line_end: 4 }],
          },
        ]),
      );
    const result = await extractOcrScenario({
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [page(lines.join("\n"), 21)],
      request,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].prompt).toContain("L2、L3、L4");
    expect(result.rows[0].evidence).toBe(lines.join("\n"));
    expect(result.rows[0].sourcePage).toBe("21");
  });

  it("同一原文行三项量化限制不能合为一条，修复后保留三个独立财务事项", async () => {
    const selected = await scenario("loan_covenant");
    const text =
      "20.1 借款人对外投资限额为人民币50000万元；对外提供担保限额为人民币50000万元；增加债务融资限额为人民币50000万元。";
    const evidence = [{ line_start: 2, line_end: 2, role: "obligation" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response([{ title: "对外投资、担保及融资限额", evidence }]),
      )
      .mockResolvedValueOnce(
        response(
          ["对外投资限额", "对外担保限额", "增加债务融资限额"].map((title) => ({
            title,
            evidence,
          })),
        ),
      );
    const result = await extractOcrScenario({
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [page(text, 21)],
      request,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(3);
    expect(
      result.rows.every(
        (row) => row.sourcePage === "21" && row.evidence === text,
      ),
    ).toBe(true);
  });

  it("读取所有维护中的通用场景及完整默认 prompt，排除收入底稿专门流程", async () => {
    const all = await loadOcrScenarios();
    expect(all.map((item) => item.id)).toEqual([
      "loan_restrictive",
      "loan_covenant",
      "loan_general",
      "revenue",
      "procurement",
      "invoicing_agreement",
      "statement",
      "invoice",
      "warehouse_io",
      "account_opening",
      "tax_declaration",
      "credit_report",
      "tax_audit_report",
      "custom",
    ]);
    for (const item of all) {
      expect(item.name).not.toBe(item.id);
      expect(item.version).toBeTruthy();
      expect(item.fields.length).toBeGreaterThan(0);
      expect(item.defaultPrompts[0].prompt.length).toBeGreaterThan(150);
    }
    expect(
      all.find((item) => item.id === "loan_covenant")!.internalPrompts![0].prompt,
    ).toBe(FINANCIAL_METRICS_PROMPT);
    expect(
      all.find((item) => item.id === "invoice")!.defaultPrompts[0].prompt,
    ).toContain("发票号码");
    expect(
      all.find((item) => item.id === "loan_general")!.defaultPrompts,
    ).toHaveLength(1);
  });

  it("项目 prompt 覆写用于实际请求，恢复默认不受其他项目修改影响", async () => {
    const selected = await scenario("custom");
    const edited = getOcrPromptStages(selected, {
      custom: [
        { ...selected.defaultPrompts[0], prompt: "用户编辑后的完整 prompt" },
      ],
    });
    const request = vi.fn(async () =>
      response([
        { category: "金额", excerpt: "金额：001234", pages: "第99页" },
      ]),
    );
    const result = await extractOcrScenario({
      scenario: selected,
      stages: edited,
      document,
      pages: [page("金额：001234", 7)],
      request,
    });
    expect(request.mock.calls[0]).toEqual([
      {
        prompt: expect.stringContaining("用户编辑后的完整 prompt"),
        text: expect.stringContaining("[L1][PDF第7页]金额：001234"),
      },
    ]);
    expect(result.rows[0]).toMatchObject({
      sourceFile: document.name,
      sourcePage: "7",
      pages: "7",
      evidence: "金额：001234",
    });
    edited[0].prompt = "再次修改";
    expect(getOcrPromptStages(selected)[0].prompt).toContain(
      "没有指定列名",
    );
    expect(selected.defaultPrompts[0].prompt).toContain("没有指定列名");
  });

  it("不会使用模型伪造页码，无证据表格也须修复后重新验证", async () => {
    const selected = await scenario("invoice");
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response([{ invoice_no: "001234", pages: "第999页" }]),
      )
      .mockResolvedValueOnce(
        response([
          {
            invoice_no: "001234",
            pages: "第999页",
            evidence_refs: [{ line_start: 1, line_end: 1 }],
          },
        ]),
      );
    const options = {
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [page("发票号码：001234", 4)],
    };
    const result = await extractOcrScenario({ ...options, request });
    expect(result.rows[0]).toMatchObject({
      invoice_no: "001234",
      pages: "4",
      sourcePage: "4",
      evidence: "发票号码：001234",
    });
    expect(request).toHaveBeenCalledTimes(2);
    await expect(
      extractOcrScenario({
        ...options,
        request: async () =>
          response([{ invoice_no: "001234", pages: "第999页" }]),
      }),
    ).rejects.toThrow("缺少原文行号");
  });

  it("拒绝改写或虚构的引用，非连续真实证据逐段验证后定位", async () => {
    const selected = await scenario("custom");
    const options = {
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [
        page("金额为100元。\n开票人为甲公司。", 2),
        page("税额13元。", 3),
      ],
    };
    await expect(
      extractOcrScenario({
        ...options,
        request: async () => response([{ excerpt: "金额为200元。" }]),
      }),
    ).rejects.toThrow("无法逐字");
    const result = await extractOcrScenario({
      ...options,
      request: async () =>
        response([
          {
            excerpt: "模型改写摘要",
            evidence_quotes: ["金额为100元。", "税额13元。"],
          },
        ]),
    });
    expect(result.rows[0]).toMatchObject({
      sourcePage: "2、3",
      excerpt: "金额为100元。\n\n税额13元。",
      evidence: "金额为100元。\n\n税额13元。",
    });
  });

  it("长文分段覆盖尾部且只允许引用本次送出的范围", async () => {
    const selected = await scenario("custom");
    const source = "无关说明。".repeat(6_000) + "尾部唯一证据。";
    const request = vi.fn(async ({ text }: { prompt: string; text: string }) =>
      response(
        text.includes("尾部唯一证据。") ? [{ excerpt: "尾部唯一证据。" }] : [],
      ),
    );
    const result = await extractOcrScenario({
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [page(source, 9)],
      request,
    });
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(
      request.mock.calls.every(([input]) => input.text.length < 12_200),
    ).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sourcePage).toBe("9");
    await expect(
      extractOcrScenario({
        scenario: selected,
        stages: getOcrPromptStages(selected),
        document,
        pages: [page(source)],
        request: async () => response([{ excerpt: "尾部唯一证据。" }]),
      }),
    ).rejects.toThrow("本轮来源");
  });

  it("输出截断、未完整检查、损坏 JSON 不会被当作零项成功", async () => {
    const selected = await scenario("custom");
    const options = {
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [page("正文")],
    };
    await expect(
      extractOcrScenario({
        ...options,
        request: async () => response([], { finish_reason: "length" }),
      }),
    ).rejects.toThrow("截断");
    await expect(
      extractOcrScenario({
        ...options,
        request: async () => ({
          parsed: { coverage_complete: false, items: [] },
        }),
      }),
    ).rejects.toThrow("检查完整");
    await expect(
      extractOcrScenario({
        ...options,
        request: async () => ({ raw: "损坏 JSON" }),
      }),
    ).rejects.toThrow("有效 JSON");
    await expect(
      extractOcrScenario({
        ...options,
        request: async () => ({ parsed: { items: [] } }),
      }),
    ).rejects.toThrow("检查完整");
  });

  it("广义限制性契约保留无量化门槛的用途限制及报送义务，跨页后果证据逐字定位", async () => {
    const selected = await scenario("loan_restrictive");
    const restriction =
      "贷款资金不得用于股本权益性投资（监管部门另有规定的除外）。";
    const consequence =
      "如未按规定用途使用资金，乙方有权通知甲方提前收回贷款或停止发放贷款。";
    const reporting = "丙方应及时提供有关计划、统计、财务会计报表等资料。";
    const request = vi.fn(async (_input: { prompt: string; text: string }) =>
      response([
        {
          category: "禁止性约束",
          clause: "第二条",
          requirement: "贷款资金股权投资限制",
          consequence: "提前收回或停止放款",
          evidence_refs: [
            { line_start: 1, line_end: 1, role: "obligation" },
            { line_start: 2, line_end: 2, role: "consequence" },
          ],
          excerpt: "模型改写的原文不用采纳",
          pages: "999",
        },
        {
          category: "附带义务",
          clause: "第十条",
          requirement: "报送资料",
          evidence_refs: [{ line_start: 3, line_end: 3, role: "obligation" }],
        },
      ]),
    );
    const result = await extractOcrScenario({
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [page(restriction, 2), page(consequence + "\n" + reporting, 3)],
      request,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      sourcePage: "2、3",
      pages: "2、3",
      excerpt: restriction + "\n\n" + consequence,
    });
    expect(result.rows[1]).toMatchObject({
      sourcePage: "3",
      evidence: reporting,
    });
    expect(request.mock.calls[0][0].prompt).toContain(
      "没有金额、比例或财务门槛也必须检查和摘录",
    );
    expect(request.mock.calls[0][0].prompt).not.toContain("本轮启用案例库版本");
    expect((await scenario("loan_covenant")).internalPrompts![0].prompt).toBe(
      FINANCIAL_METRICS_PROMPT,
    );
  });

  it("广义限制性契约拒绝无证据、越界引用及无依据后果，命名模板沿用相同检查", async () => {
    const { withSavedOcrScenarios } = await import("./ocrScenarios");
    const defaults = await loadOcrScenarios();
    const base = defaults.find((item) => item.id === "loan_restrictive")!;
    const selected = withSavedOcrScenarios(defaults, [
      {
        id: "saved-restrictive",
        name: "我的限制性契约",
        baseScenarioId: base.id,
        version: base.version,
        fields: base.fields,
        stages: getOcrPromptStages(base),
      },
    ]).at(-1)!;
    const options = {
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [page("不得用于股权投资。", 4)],
    };
    const ref = { line_start: 1, line_end: 1, role: "obligation" };
    await expect(
      extractOcrScenario({
        ...options,
        request: async () =>
          response([
            { requirement: "禁止投资", excerpt: "不得用于股权投资。" },
          ]),
      }),
    ).rejects.toThrow("必须提供原文行号");
    await expect(
      extractOcrScenario({
        ...options,
        request: async () =>
          response([{ evidence_refs: [{ ...ref, line_end: 999 }] }]),
      }),
    ).rejects.toThrow("超出本轮来源");
    await expect(
      extractOcrScenario({
        ...options,
        request: async () =>
          response([{ consequence: "自动提前到期", evidence_refs: [ref] }]),
      }),
    ).rejects.toThrow("后果缺少原文");
    await expect(
      extractOcrScenario({
        ...options,
        request: async () =>
          response([{ evidence_refs: [{ ...ref, role: "consequence" }] }]),
      }),
    ).rejects.toThrow("缺少限制或义务本身");
    const result = await extractOcrScenario({
      ...options,
      request: async () =>
        response([
          { requirement: "贷款资金股权投资限制", evidence_refs: [ref] },
        ]),
    });
    expect(result.rows[0].sourcePage).toBe("4");
  });

  it("两个场景共用义务口径：量化通知归附带义务，独立限制归财务指标约束", async () => {
    const selected = await scenario("loan_restrictive");
    const texts = [
      "▲8.6 借款人应当在下列事项发生之日起7日内书面通知贷款人：\n(1) 修改章程；",
      "(10) 发生关联交易，且交易金额达到或超过最近经审计的净资产的10%；\n8.7 关联交易超过净资产20%须取得贷款人事先同意。\n8.8 借款人的财务指标始终符合合同约定。",
    ];
    const result = await extractOcrScenario({
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [page(texts[0], 12), page(texts[1], 13)],
      request: async () =>
        response([
          {
            category: "财务指标约束",
            evidence_refs: [{ line_start: 3, line_end: 3, role: "obligation" }],
          },
          {
            category: "须经同意的约束",
            evidence_refs: [{ line_start: 4, line_end: 4, role: "obligation" }],
          },
          {
            category: "财务指标约束",
            evidence_refs: [{ line_start: 5, line_end: 5, role: "obligation" }],
          },
        ]),
    });
    expect(result.rows.map((row) => row.category)).toEqual([
      "报送/检查等附带义务",
      "财务指标约束",
      "一般财务承诺（具体指标待核对）",
    ]);
    expect(result.rows[0].sourcePage).toBe("13");
    expect(result.rows[0].excerpt).toBe(texts[1].split("\n")[0]);
    const financial = await scenario("loan_covenant");
    expect(financial.name).toBe("借款·财务指标契约");
    expect(financial.fields[0].label).toBe("财务指标契约类型");
    const narrow = await extractOcrScenario({
      scenario: financial,
      stages: getOcrPromptStages(financial),
      document,
      pages: [page(texts[0], 12), page(texts[1], 13)],
      request: async ({ text }) =>
        response(
          ["\\(10\\)", "8\\.7", "8\\.8"].map((pattern) => ({
            evidence: [
              {
                line_start: Number(
                  text.match(new RegExp(`\\[L(\\d+)\\]${pattern}`))?.[1],
                ),
                role: "obligation",
              },
            ],
          })),
        ),
    });
    expect(narrow.rows).toHaveLength(1);
    expect(narrow.rows[0].covenant_category_id).toBe("C03");
    expect(narrow.rows[0].excerpt).toBe(texts[1].split("\n")[1]);
  });

  it("财务契约使用用户 prompt 和启用案例，但原文仍按行号回填", async () => {
    const selected = await scenario("loan_covenant");
    const stages = getOcrPromptStages(selected);
    stages[0].prompt = "自定义财务契约关注事项";
    const request = vi.fn(
      async ({ text }: { prompt: string; text: string }) => {
        const line = Number(
          text.match(/\[L(\d+)\]借款人资产负债率不得超过65%/)?.[1],
        );
        return response([
          {
            title: "资产负债率",
            evidence: [
              { line_start: line, line_end: line, role: "obligation" },
            ],
          },
        ]);
      },
    );
    const result = await extractOcrScenario({
      scenario: selected,
      stages,
      document,
      pages: [page("借款人资产负债率不得超过65%。", 6)],
      request,
    });
    expect(request.mock.calls[0][0].prompt).toContain("自定义财务契约关注事项");
    expect(request.mock.calls[0][0].prompt).toContain("本轮启用案例库版本");
    expect(result.rows[0]).toMatchObject({
      excerpt: "借款人资产负债率不得超过65%。",
      sourcePage: "6",
      evidence: "借款人资产负债率不得超过65%。",
    });
    await expect(
      extractOcrScenario({
        scenario: selected,
        stages,
        document,
        pages: [page("借款人资产负债率不得超过65%。")],
        request: async () => response([{ evidence: [{ line_start: 9999 }] }]),
      }),
    ).rejects.toThrow("超出");
  });

  it("借款长文汇总阶段可编辑并实际合并分段，不按页新增借款", async () => {
    const selected = await scenario("loan_general");
    const stages = getOcrPromptStages(selected);
    stages.push({ id: "consolidate", label: "旧保存汇总规则", prompt: "用户修改的整份主表合并规则" });
    const request = vi.fn(
      async ({ prompt, text }: { prompt: string; text: string }) =>
        response(
          text.includes("合同编号A001。")
            ? [
                {
                  contract_no: "A001",
                  excerpt: "合同编号A001。",
                  ...(prompt.startsWith(stages[1].prompt)
                    ? { auditor_summary: "已核对整份合同" }
                    : {}),
                },
              ]
            : [],
        ),
    );
    const result = await extractOcrScenario({
      scenario: selected,
      stages,
      document,
      pages: [page("合同编号A001。" + "普通说明。".repeat(5_000))],
      request,
    });
    expect(request.mock.calls.at(-1)![0].prompt).toContain(stages[1].prompt);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].auditor_summary).toBe("已核对整份合同");
  });

  it("校对后的表格单元格进入摘录上下文", async () => {
    const selected = await scenario("custom");
    const source = page("金额请见表格");
    source.tables = [
      {
        id: "t1",
        title: "金额",
        rows: [
          ["账号", "金额"],
          ["00123", "777.00"],
        ],
      },
    ];
    const request = vi.fn(async () => response([{ excerpt: "00123\t777.00" }]));
    const result = await extractOcrScenario({
      scenario: selected,
      stages: getOcrPromptStages(selected),
      document,
      pages: [source],
      request,
    });
    expect(result.rows[0].evidence).toBe("00123\t777.00");
  });

  it("既有 AudiPick 调用省略覆写参数时继续使用原有 prompt", async () => {
    const extract = vi.fn(async (_params: { prompt: string; text: string }) =>
      response([]),
    );
    await extractFinancialMetrics({
      documents: [{ ...document, text: "借款人资产负债率不得超过65%。" }],
      extract,
    });
    expect(extract.mock.calls[0][0].prompt).toContain(FINANCIAL_METRICS_PROMPT);
  });
});

it("命名财务契约场景仍走案例库和行号证据核验，且不会修改默认提示词", async () => {
  const { withSavedOcrScenarios } = await import("./ocrScenarios");
  const defaults = await loadOcrScenarios();
  const base = defaults.find((item) => item.id === "loan_covenant")!;
  const stages = getOcrPromptStages(base);
  stages[0].prompt = "用户保存的财务指标关注事项";
  const selected = withSavedOcrScenarios(defaults, [
    {
      id: "saved-financial",
      name: "我的财务契约",
      baseScenarioId: base.id,
      version: base.version,
      fields: base.fields,
      stages,
    },
  ]).find((item) => item.id === "saved-financial")!;
  const request = vi.fn(async ({ text }: { prompt: string; text: string }) => {
    const line = Number(
      text.match(/\[L(\d+)\]借款人资产负债率不得超过65%/)?.[1],
    );
    return response([
      {
        title: "资产负债率",
        evidence: [{ line_start: line, line_end: line, role: "obligation" }],
      },
    ]);
  });
  const result = await extractOcrScenario({
    scenario: selected,
    stages: getOcrPromptStages(selected),
    document,
    pages: [page("借款人资产负债率不得超过65%。", 6)],
    request,
  });
  expect(request.mock.calls[0][0].prompt).toContain("本轮启用案例库版本");
  expect(request.mock.calls[0][0].prompt).toContain(
    "用户保存的财务指标关注事项",
  );
  expect(result.rows[0]).toMatchObject({
    sourcePage: "6",
    excerpt: "借款人资产负债率不得超过65%。",
  });
  expect(base.internalPrompts![0].prompt).toBe(FINANCIAL_METRICS_PROMPT);
});
