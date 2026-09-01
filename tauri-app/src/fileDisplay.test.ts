import { describe, expect, it } from "vitest";
import { displayFileName } from "./fileDisplay";

describe("displayFileName", () => {
  it("只展示 Windows 或 POSIX 路径中的文件名", () => {
    expect(displayFileName("C:\\项目\\底稿\\汇兑损益.xlsx")).toBe(
      "汇兑损益.xlsx",
    );
    expect(displayFileName("/tmp/audit/ledger.csv")).toBe("ledger.csv");
  });

  it("去掉目录末尾的分隔符并保留普通标签", () => {
    expect(displayFileName("C:\\项目\\底稿\\")).toBe("底稿");
    expect(displayFileName("JE：凭证.xlsx；TB：余额表.xlsx")).toBe(
      "JE：凭证.xlsx；TB：余额表.xlsx",
    );
  });
});
