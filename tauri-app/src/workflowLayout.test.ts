import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shared = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const kanzhang = readFileSync(
  new URL("./kanzhang-parity.css", import.meta.url),
  "utf8",
);
const audit = readFileSync(
  new URL("../TAURI_UI_STATE_AUDIT.md", import.meta.url),
  "utf8",
);
const catalog = JSON.parse(
  readFileSync(new URL("../public/tool-catalog.json", import.meta.url), "utf8"),
) as Array<{ id: string }>;

describe("任务型页面纵向布局契约", () => {
  it("页面网格统一接管直接子状态组件的间距", () => {
    expect(shared).toContain(".confirmation-page,");
    expect(shared).toContain(".ts-manager-page,");
    expect(shared).toContain(".fa-tbje-page");
    expect(shared).toContain(
      "> :is(.step-indicator, .error-box, .job-progress, .fa-stack, .workspace)",
    );
    expect(shared).toContain(
      ".step-indicator + :is(.fa-stack, .workspace, .merger-layout)",
    );
    expect(shared).toContain(
      '> :is(.error-box, .job-progress):first-child',
    );
    expect(shared).toMatch(/\.fa-stack\s*\{[^}]*margin-top:\s*0;/s);
  });

  it("看账及正负数标记页面使用同一层网格节奏", () => {
    expect(kanzhang).toMatch(
      /\.kz-page\s*\{[^}]*display:\s*grid;[^}]*gap:\s*var\(--sp-4\);/s,
    );
  });

  it("审查矩阵逐项覆盖 catalog 的全部工具", () => {
    expect(catalog).toHaveLength(18);
    for (const tool of catalog) expect(audit).toContain(`\`${tool.id}\``);
  });

  it("非标准输出路径也只渲染文件名", () => {
    for (const file of [
      "./DepositInterestPage.tsx",
      "./LoanInterestPage.tsx",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).toContain("value={displayFileName(outputPath)}");
    }
    const fileList = readFileSync(
      new URL("./FileListDirectoryPage.tsx", import.meta.url),
      "utf8",
    );
    expect(fileList).toContain("<FileInput");
    expect(fileList).not.toContain("title={outputPath}");

    const rollForward = readFileSync(
      new URL("./RollForwardPage.tsx", import.meta.url),
      "utf8",
    );
    expect(rollForward).toContain("<FileInput");
    expect(rollForward).not.toContain("<Input title={value} value={value}");

    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    expect(app).toContain("value={displayFileName(backupPath)}");
  });
});
