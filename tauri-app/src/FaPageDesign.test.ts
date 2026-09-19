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
  it.each(["FaListPage", "FaPolicyComparePage", "KanzhangParityPage", "JeSignMarkPage"])(
    "%s 提供结果空状态",
    (name) => expect(source(name)).toContain("<EmptyState"),
  );
  it("FA TB+JE 工作区不重复展示静态灰色操作说明", () => {
    const page = source("FaTbJePage");
    expect(page).toContain("showDescription={false}");
    expect(page).not.toContain("系统按「上级科目 → 一级编码 → 名称」自动分类");
    expect(page).not.toContain("和序时账使用同一入口，可一次拖入两个文件");
  });
});
