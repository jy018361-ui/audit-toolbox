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

describe("OCR 场景默认提示词与逐字来源", () => {
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
      all.find((item) => item.id === "loan_covenant")!.defaultPrompts[0].prompt,
    ).toBe(FINANCIAL_METRICS_PROMPT);
    expect(
      all.find((item) => item.id === "invoice")!.defaultPrompts[0].prompt,
    ).toContain("invoice_no: 发票号码");
    expect(
      all.find((item) => item.id === "loan_general")!.defaultPrompts,
    ).toHaveLength(2);
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
      "通用单证摘录助手",
    );
    expect(selected.defaultPrompts[0].prompt).toContain("通用单证摘录助手");
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
    expect((await scenario("loan_covenant")).defaultPrompts[0].prompt).toBe(
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
    stages[1].prompt = "用户修改的整份主表合并规则";
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
  expect(base.defaultPrompts[0].prompt).toBe(FINANCIAL_METRICS_PROMPT);
});
