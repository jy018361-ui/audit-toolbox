import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8");

describe("固定资产与凭证页视觉契约", () => {
  it.each(["FaListPage", "FaDepCalcPage", "FaPolicyComparePage", "FaTbJePage", "JeSignMarkPage"])(
    "%s 使用共享输入框",
    (name) => {
      expect(source(name)).toContain("<Input");
      expect(source(name)).not.toMatch(/<input\b/);
    },
  );
  it.each(["FaListPage", "FaPolicyComparePage"])(
    "%s 提供结果空状态",
    (name) => expect(source(name)).toContain("<EmptyState"),
  );
  it.each(["KanzhangParityPage", "JeSignMarkPage"])(
    "%s 无有效结果时隐藏结果卡，保留任务与输出展示",
    (name) => {
      const page = source(name);
      expect(page).not.toContain("<EmptyState");
      expect(page).toContain("return null;");
      expect(page).toContain("showProgress");
      expect(page).toContain("paths.length");
    },
  );
  it("FA TB+JE 工作区不重复展示静态灰色操作说明", () => {
    const page = source("FaTbJePage");
    expect(page).toContain("showDescription={false}");
    expect(page).not.toContain("系统按「上级科目 → 一级编码 → 名称」自动分类");
    expect(page).not.toContain("和序时账使用同一入口，可一次拖入两个文件");
  });

  it("FA 两期清单明确任务动作、三步编号与待重算门禁", () => {
    const page = source("FaListPage");
    expect(page).toContain('"开始匹配"');
    expect(page).toContain('"2. 补充清单（可选）"');
    expect(page).not.toContain('<h3>2. 本期变动清单（可选）</h3>');
    expect(page).toContain('<h3>3. 输出</h3>');
    expect(page).toContain('disabled={!inspection || resultStale}');
    expect(page).not.toContain('autoApply: false');
    expect(page).toContain('__restoreSnapshot');
    expect(page).toContain('期初 ${displayFileName(bPath)} ＋ 期末 ${displayFileName(ePath)}');
    expect(page).toContain('已从历史快照恢复两期清单，请复核文件、匹配 ID 与字段映射后继续。');
    expect(page).toContain('preserveMappings: Boolean(faStats)');
  });

  it("FA TB+JE 显示逐文件识别进度并阻止导出旧结果", () => {
    const page = source("FaTbJePage");
    expect(page).toContain("onWorkbookStart:");
    expect(page).toContain("正在识别第 ${index + 1}/${total} 份");
    expect(page).toContain("const inspectedResults = await Promise.all(");
    expect(page).toContain("正在读取第 ${index + 1}/${selected.length} 份");
    expect(page).toContain('`${kind.toUpperCase()} ${fileName(item.path)}`');
    expect(page).toContain('method === "fa.tbje_export" && resultStale');
    expect(page).toContain("只看有差异");
  });

  it("FA TB+JE 只在确认第一步时验证辅助字段，且科目清单只重读 TB", () => {
    const page = source("FaTbJePage");
    expect(page).not.toContain("useAuxiliaryLink");
    expect(page).toContain("const verified = await verifyAuxiliaryLink");
    expect(page).not.toContain("selectedAccounts:");
    expect(page).toContain('engineCall("deposit.inspect_tb"');
    expect(page).not.toContain('engineCall("deposit.inspect_je"');
    expect(page).toContain("auxiliaryPlan:");
  });

  it("FA 建议卡按实际状态措辞、文件槽回显文件名、回退按钮统一上一步", () => {
    const page = source("FaListPage");
    const policy = source("FaPolicyComparePage");
    // UI 审计 P3-8：待采纳建议的理由不得残留「已自动补上映射」式旧口径，
    // 与同卡「尚未改动，请逐条核对」的结论自相矛盾。
    expect(page).toContain("pendingReasonText(item.reason)");
    expect(page).toContain("已自动(?=补上|调整|修正)");
    // UI 审计 P2-6：选中文件后文件名以灰色胶囊回显（样式收在 fa-list.css）。
    expect(page).toContain('import "./fa-list.css"');
    expect(policy).toContain('import "./fa-list.css"');
    expect(policy).toContain('className="fa-file-slot"');
    // UI 审计 P3-1：与函证页一致，回退按钮统一叫「上一步」。
    expect(page).not.toContain("返回上一步");
    expect(policy).not.toContain("返回上一步");
  });
});
