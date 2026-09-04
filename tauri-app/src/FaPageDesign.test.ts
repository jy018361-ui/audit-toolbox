import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8");

describe("固定资产与凭证页视觉契约", () => {
  it.each(["FaListPage", "FaDepCalcPage", "FaPolicyComparePage", "KanzhangParityPage", "JeSignMarkPage"])(
    "%s 提供明确的数据处理说明",
    (name) => {
      expect(source(name)).toContain("<DataHandlingNotice");
      expect(source(name)).toContain('mode="network-assisted"');
    },
  );
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
});
