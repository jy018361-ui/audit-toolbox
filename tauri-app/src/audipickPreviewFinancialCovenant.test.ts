import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { covenantExportRows } from "./audipickCovenant";
import { extractFinancialMetrics } from "./audipickCovenantExtraction";
import { handlers } from "./preview/demo/audipick";

describe("AudiPick 财务契约浏览器预览", () => {
  it("模板详情只显示正式四列，不再回退为 c1-c10", () => {
    const window: Record<string, unknown> = {};
    const context = vm.createContext({ window });
    for (const path of [
      "../assets/audipick/rules/prompts/loan_covenant.js",
      "../assets/audipick/rules/registry.js",
    ]) {
      vm.runInContext(readFileSync(new URL(path, import.meta.url), "utf8"), context);
    }
    const engine = (window.RuleEngine ?? {}) as {
      getFieldsForRule: (ruleId: string) => Array<{ key: string; label: string }>;
    };
    expect(engine.getFieldsForRule("loan_covenant")).toEqual([
      { key: "covenant_category", label: "财务契约类型" },
      { key: "trigger_standard", label: "限制或触发标准" },
      { key: "excerpt", label: "合同原文摘录" },
      { key: "source_reference", label: "原文引用出处" },
    ]);
  });

  it("预置结果以四列展示，并把待新增案例隔离在正式结果之外", () => {
    const response = handlers["audipick.projects"]({}) as {
      projects: Array<{ results: Array<Record<string, unknown>> }>;
    };
    const rows = response.projects[0].results.filter(
      (row) => row.ruleId === "loan_covenant",
    );
    const pending = rows.filter((row) => row._covenant_pending_case === true);
    const exported = covenantExportRows(rows, () => "华远集团流动资金借款合同.pdf");
    expect(exported).toHaveLength(2);
    expect(pending).toHaveLength(1);
    expect(Object.keys(exported[0])).toEqual([
      "财务契约类型",
      "限制或触发标准",
      "合同原文摘录",
      "原文引用出处",
    ]);
    expect(exported.every((row) => !String(row.合同原文摘录).includes("第3页"))).toBe(true);
    expect(exported.every((row) => String(row.原文引用出处).includes("文件："))).toBe(true);
  });

  it("演示提取回放也走案例库分类并保留一条待新增案例", async () => {
    const projects = handlers["audipick.projects"]({}) as {
      projects: Array<{ project: { id: string } }>;
    };
    const documents = handlers["audipick.documents"]({
      projectId: projects.projects[0].project.id,
    }) as { documents: Array<{ id: string; name: string }> };
    const document = documents.documents.find((item) => item.name.includes("借款"));
    expect(document).toBeDefined();
    const source = handlers["audipick.document_text"]({
      documentId: document!.id,
    }) as { text: string };
    const outcome = await extractFinancialMetrics({
      documents: [{ id: document!.id, name: document!.name, text: source.text }],
      extract: async ({ prompt, text }) =>
        handlers["audipick.extract"]({
          ruleId: "loan_covenant",
          prompt,
          text,
        }) as { parsed?: unknown },
    });
    expect(covenantExportRows(outcome.items, () => document!.name)).toHaveLength(2);
    expect(outcome.items.filter((row) => row._covenant_pending_case === true)).toHaveLength(1);
    expect(outcome.items.some((row) => row.covenant_category === "财务报表指标")).toBe(true);
    expect(outcome.items.filter((row) => row.covenant_category === "财务行为与交易限制")).toHaveLength(1);
  });
});
