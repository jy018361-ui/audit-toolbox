import { describe, expect, it } from "vitest";
import {
  leadingNumber,
  pairLedgerFiles,
  periodTag,
  reassignJe,
  type PairingFile,
} from "./tbjePairing";

/** 十套实测样例的真实文件名。 */
const 样例 = [
  "01科目余额表（TB）.xls",
  "01序时账 (JE).xlsx",
  "02科目余额表.xlsx",
  "02序时账 (2).xlsx",
  "03科目余额表.xlsx",
  "03序时账 (2).xlsx",
  "04TB.XLSX",
  "04JE.XLSX",
  "05科目余额表.XLSX",
  "05序时账 (2).XLSX",
  "06科目余额表_2024.1-3.xlsx",
  "06科目余额表_2024.4-12.xlsx",
  "06序时账-2024.1-3.xlsx",
  "06序时账-2024.4-12.xlsx",
  "07科目余额表.xls",
  "07序时账.xls",
  "08TB.xlsx",
  "08序时账 (2).xlsx",
  "09科目余额表-2025.xls",
  "09序时账-2025.xls",
  "10科目余额表.xlsx",
  "10序时账 (2).xlsx",
];

const 是余额表 = (name: string) =>
  /tb|科目余额/i.test(name) && !/序时/.test(name);

function 样例文件(): PairingFile[] {
  return 样例.map((name) => ({
    path: `C:\\samples\\${name}`,
    kind: 是余额表(name) ? "tb" : "je",
  }));
}

describe("文件名里的编号与期间", () => {
  it("只认开头的数字，不认账号和年份", () => {
    expect(leadingNumber("C:/x/04TB.XLSX")).toBe("4");
    expect(leadingNumber("C:/x/01科目余额表（TB）.xls")).toBe("1");
    // 中间的数字是账号不是编号。
    expect(leadingNumber("C:/x/银行存款3105016.xlsx")).toBeUndefined();
  });

  it("认得出分段导出的期间", () => {
    expect(periodTag("C:/x/06科目余额表_2024.1-3.xlsx")).toBe("2024.1-3");
    expect(periodTag("C:/x/06序时账-2024.4-12.xlsx")).toBe("2024.4-12");
    expect(periodTag("C:/x/09科目余额表-2025.xls")).toBe("2025");
    expect(periodTag("C:/x/04TB.XLSX")).toBeUndefined();
  });
});

describe("批量配对", () => {
  it("十套真实文件名全部配对成功，一份不剩", () => {
    const groups = pairLedgerFiles(样例文件());
    // 06 套一年拆两段，应当配成两组 —— 一共 11 组。
    expect(groups).toHaveLength(11);
    expect(groups.filter((group) => group.needsReview)).toHaveLength(0);
    expect(groups.every((group) => group.tb && group.je)).toBe(true);
  });

  it("06 套按期间分成两组，不会把 1-3 月的余额表配到 4-12 月的序时账", () => {
    const groups = pairLedgerFiles(样例文件()).filter((group) =>
      group.label.startsWith("6"),
    );
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(periodTag(group.tb!.path)).toBe(periodTag(group.je!.path));
      expect(group.reasons.join()).toContain("期间");
    }
  });

  it("配不上的余额表单独列出，不硬凑一个序时账", () => {
    const groups = pairLedgerFiles([
      { path: "C:/x/11科目余额表.xlsx", kind: "tb" },
      { path: "C:/x/12序时账.xlsx", kind: "je" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.needsReview)).toBe(true);
    expect(groups.find((group) => group.tb)?.je).toBeUndefined();
  });

  it("文件名没编号时退到主体交集", () => {
    const groups = pairLedgerFiles([
      { path: "C:/x/余额表.xlsx", kind: "tb", entities: ["3110"] },
      { path: "C:/x/凭证.xlsx", kind: "je", entities: ["3110", "3120"] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].je).toBeDefined();
    expect(groups[0].reasons.join()).toContain("主体 3110");
  });

  it("编号对上但两边主体不同时标为待确认", () => {
    const groups = pairLedgerFiles([
      { path: "C:/x/07余额表.xlsx", kind: "tb", entities: ["A"] },
      { path: "C:/x/07序时账.xlsx", kind: "je", entities: ["B"] },
    ]);
    expect(groups[0].needsReview).toBe(true);
    expect(groups[0].reasons.join()).toContain("两边主体不同");
  });

  it("待确认的排在前面", () => {
    const groups = pairLedgerFiles([
      ...样例文件(),
      { path: "C:/x/99科目余额表.xlsx", kind: "tb" },
    ]);
    expect(groups[0].needsReview).toBe(true);
    expect(groups[0].label).toBe("99");
  });
});

describe("改配对", () => {
  it("换成别组占着的序时账时两组对调，不让另一组凭空少文件", () => {
    const groups = pairLedgerFiles(样例文件());
    const 第四组 = groups.find((group) => group.label === "4")!;
    const 第五组 = groups.find((group) => group.label === "5")!;
    const 原四 = 第四组.je!.path;
    const 原五 = 第五组.je!.path;

    const next = reassignJe(groups, 第四组.id, 原五);
    const 新四 = next.find((group) => group.id === 第四组.id)!;
    const 新五 = next.find((group) => group.id === 第五组.id)!;
    expect(新四.je?.path).toBe(原五);
    expect(新五.je?.path).toBe(原四);
    // 对调后没有任何一份序时账掉队。
    const 全部 = next.flatMap((group) => (group.je ? [group.je.path] : []));
    expect(new Set(全部).size).toBe(全部.length);
    expect(全部).toContain(原四);
    expect(全部).toContain(原五);
  });

  it("选不配对时解除关系但保留原序时账", () => {
    const groups = pairLedgerFiles(样例文件());
    const 第四组 = groups.find((group) => group.label === "4")!;
    const next = reassignJe(groups, 第四组.id, undefined);
    const 新四 = next.find((group) => group.id === 第四组.id)!;
    expect(新四.je).toBeUndefined();
    expect(新四.needsReview).toBe(true);
    const 待配对 = next.find((group) => group.id === 第四组.je!.path)!;
    expect(待配对.je?.path).toBe(第四组.je!.path);
    expect(待配对.tb).toBeUndefined();
    expect(待配对.needsReview).toBe(true);
  });
});
