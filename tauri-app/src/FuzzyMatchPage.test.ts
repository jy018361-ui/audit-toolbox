import { describe, expect, it } from "vitest";
import {
  DRAFT_KEY,
  autoAcceptList,
  bestCandidate,
  confirmStats,
  draftToJson,
  estimateComparisons,
  inScoreBand,
  mergeConfirmations,
  parseDraft,
  rowLevel,
  validateThresholds,
  type Confirmation,
  type FuzzyResultRow,
} from "./FuzzyMatchPage";

const candidate = (bIndex: number, bValue: string, level: "auto" | "suspect", total: number) => ({
  bIndex,
  bValue,
  level,
  total,
  breakdown: { charSim: total / 100, lcsSim: total / 100, tokenOverlap: total / 100 },
  reasons: ["理由"],
});
const row = (aIndex: number, aValue: string, matches: FuzzyResultRow["matches"]): FuzzyResultRow => ({ aIndex, aValue, matches });

describe("两列模糊匹配纯函数", () => {
  it("预估比对次数：B 侧超过 200 行封顶，任一侧为 0 直接为 0", () => {
    expect(estimateComparisons(100, 300)).toBe(100 * 200);
    expect(estimateComparisons(50, 80)).toBe(50 * 80);
    expect(estimateComparisons(0, 100)).toBe(0);
    expect(estimateComparisons(100, 0)).toBe(0);
  });

  it("阈值校验：0 < 疑似 < 自动 ≤ 100", () => {
    expect(validateThresholds(90, 70)).toBe("");
    expect(validateThresholds(100, 99)).toBe("");
    // 疑似压到自动之上、非正数、超过 100、非数字都要拦。
    expect(validateThresholds(70, 90)).toBe("自动匹配阈值必须大于疑似阈值。");
    expect(validateThresholds(90, 0)).toBe("疑似阈值必须大于 0。");
    expect(validateThresholds(101, 70)).toBe("自动匹配阈值不能超过 100。");
    expect(validateThresholds(Number.NaN, 70)).toBe("自动匹配阈值与疑似阈值必须为数字。");
  });

  it("行级状态按候选级别归类：有 auto 即 auto，只剩 suspect 为 suspect，无候选未匹配", () => {
    expect(rowLevel(row(0, "甲", [candidate(0, "甲", "auto", 96)]))).toBe("auto");
    expect(rowLevel(row(1, "乙", [candidate(2, "乙股份", "suspect", 78)]))).toBe("suspect");
    expect(rowLevel(row(2, "丙", []))).toBe("unmatched");
  });

  it("最高分候选不依赖返回顺序", () => {
    const r = row(1, "乙", [candidate(3, "低分", "suspect", 72), candidate(2, "高分", "suspect", 88)]);
    expect(bestCandidate(r)?.bIndex).toBe(2);
    expect(bestCandidate(row(2, "丙", []))).toBeUndefined();
  });

  it("确认进度只统计疑似行：采纳、拒绝、待确认分开计数", () => {
    const rows = [
      row(0, "甲", [candidate(0, "甲", "auto", 96)]),
      row(1, "乙", [candidate(2, "乙股份", "suspect", 78)]),
      row(2, "丙", [candidate(5, "丙有限", "suspect", 82)]),
      row(3, "丁", [candidate(6, "丁有限", "suspect", 71)]),
    ];
    const confirmations: Confirmation[] = [
      { aIndex: 1, bIndex: 2, action: "accept" },
      { aIndex: 2, bIndex: null, action: "reject" },
    ];
    expect(confirmStats(rows, confirmations)).toEqual({ total: 3, confirmed: 2, accepted: 1, rejected: 1, pending: 1 });
    // 自动匹配行上的确认（脏数据）不计入确认队列进度。
    expect(confirmStats(rows, [{ aIndex: 0, bIndex: 0, action: "accept" }]).confirmed).toBe(0);
  });

  it("确认合并按 aIndex 覆盖：重选后旧确认被替换", () => {
    const base: Confirmation[] = [{ aIndex: 1, bIndex: 2, action: "accept" }];
    const merged = mergeConfirmations(base, [{ aIndex: 1, bIndex: null, action: "reject" }]);
    expect(merged).toEqual([{ aIndex: 1, bIndex: null, action: "reject" }]);
    expect(mergeConfirmations(base, [{ aIndex: 3, bIndex: 9, action: "accept" }])).toHaveLength(2);
  });

  it("草稿序列化 roundtrip，坏结构返回 null", () => {
    const confirmations: Confirmation[] = [
      { aIndex: 1, bIndex: 2, action: "accept", note: "x" },
      { aIndex: 4, bIndex: null, action: "reject" },
    ];
    expect(parseDraft(draftToJson("job-1", confirmations))).toEqual({ jobId: "job-1", confirmations });
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("not-json")).toBeNull();
    expect(parseDraft('{"jobId":1,"confirmations":[]}')).toBeNull();
    expect(parseDraft('{"jobId":"j","confirmations":[{"aIndex":"x","bIndex":1,"action":"accept"}]}')).toBeNull();
  });

  it("分数区间左闭右开", () => {
    expect(inScoreBand(75, "70-80")).toBe(true);
    expect(inScoreBand(80, "70-80")).toBe(false);
    expect(inScoreBand(80, "80-90")).toBe(true);
    expect(inScoreBand(90, "80-90")).toBe(false);
    expect(inScoreBand(95, "all")).toBe(true);
  });

  it("批量采纳只收未确认且最高分达线的疑似行", () => {
    const rows = [
      row(0, "甲", [candidate(0, "甲", "auto", 96)]), // 自动行不进确认
      row(1, "乙", [candidate(2, "乙股份", "suspect", 88)]), // 达线采纳
      row(2, "丙", [candidate(5, "丙有限", "suspect", 82)]), // 未达线
      row(3, "丁", [candidate(6, "丁有限", "suspect", 90)]), // 已确认，跳过
    ];
    const confirmed: Confirmation[] = [{ aIndex: 3, bIndex: 6, action: "accept" }];
    expect(autoAcceptList(rows, confirmed, 85)).toEqual([{ aIndex: 1, bIndex: 2, action: "accept" }]);
  });

  it("草稿键名与规格一致", () => {
    expect(DRAFT_KEY).toBe("fuzzy-match-draft.v1");
  });
});
