import { describe, expect, it } from "vitest";

import { excelMergerClearPrompt, excelMergerStep } from "./ExcelMergerPage";

describe("Excel 合并步骤状态", () => {
  it("添加文件前停留在文件源", () => {
    expect(excelMergerStep(0, 0, false)).toBe(0);
  });

  it("添加但尚未检查时仍停留在文件源", () => {
    expect(excelMergerStep(3, 0, false)).toBe(0);
  });

  it("检查完成后进入合并规则", () => {
    expect(excelMergerStep(3, 3, false)).toBe(1);
  });

  it("任务开始后进入执行合并", () => {
    expect(excelMergerStep(3, 3, true)).toBe(2);
  });

  it("清空列表前说明不会删除原文件", () => {
    expect(excelMergerClearPrompt(3)).toBe(
      "确认清空当前 3 个待合并文件？只会清空本次列表，不会删除原文件。",
    );
  });
});
