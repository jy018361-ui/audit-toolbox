import { describe, expect, it } from "vitest";

import { excelMergerClearPrompt, excelMergerStep, filterExcelMergerPaths } from "./ExcelMergerPage";

describe("Excel 临时锁文件过滤", () => {
  it("添加文件和历史恢复时排除锁文件，兼容两种路径分隔符及大写扩展名", () => {
    const inputs = ["C:\\账表\\~$明细.XLSX", "C:/账表/~$明细.xls", "~$宏表.xlsm", "~$~预算.xlsx"];
    expect(filterExcelMergerPaths(inputs)).toEqual([]);
  });

  it("只匹配文件名的锁前缀，保留正常波浪号、美元符号及同名前缀目录", () => {
    const inputs = ["C:/~$归档/正式.xlsx", "C:\\账表\\~预算.xlsx", "预算$明细.xlsx", "C:/账表/正常.xlsx"];
    expect(filterExcelMergerPaths(inputs)).toEqual(inputs);
  });
});

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
