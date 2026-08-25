import { describe, expect, it } from "vitest";
import {
  accountFilterColumn,
  accountFilterTitle,
  accountMappingKey,
  activeColumnFilters,
  addBatch,
  batchesContaining,
  clearAccountsOnMappingChange,
  defaultJeMarkOutputName,
  defaultJeMarkOutputPath,
  isAccountColumn,
  removeBatch,
  validJeMarkBatches,
  type JeMarkBatch,
} from "./jeSignMarkUi";
import type { Mapping } from "./ledgerMapping";

const mapping = (account: string[]): Mapping => ({ id: ["凭证号"], accountName: account });

describe("科目列定位", () => {
  it("单列科目时漏斗挂在该列上", () => {
    expect(accountFilterColumn(mapping(["科目名称"]), ["凭证号", "科目名称", "金额"])).toBe("科目名称");
  });
  it("科目由多列拼成时挂在第一列，标题写明拼接来源", () => {
    const value = mapping(["一级科目", "明细科目"]);
    expect(accountFilterColumn(value, ["凭证号", "一级科目", "明细科目"])).toBe("一级科目");
    expect(accountFilterTitle(value)).toBe("目标科目（由 一级科目、明细科目 拼接）");
  });
  it("单列科目不啰嗦拼接来源", () => {
    expect(accountFilterTitle(mapping(["科目名称"]))).toBe("目标科目");
  });
  it("科目列走批次维度，其余列走全局过滤", () => {
    const value = mapping(["一级科目", "明细科目"]);
    expect(isAccountColumn(value, "明细科目")).toBe(true);
    expect(isAccountColumn(value, "部门")).toBe(false);
  });
});

describe("批次", () => {
  const batches: JeMarkBatch[] = [
    { name: "批次1", accounts: ["管理费用-差旅费"] },
    { name: "批次2", accounts: [] },
  ];
  it("新增批次后自动切过去，且从空选择开始", () => {
    const next = addBatch(batches);
    expect(next.activeBatch).toBe(2);
    expect(next.batches[2]).toEqual({ name: "批次3", accounts: [] });
  });
  it("只剩一个批次时删除等于清空，不会出现零批次", () => {
    const next = removeBatch([batches[0]], 0);
    expect(next.batches).toHaveLength(1);
    expect(next.batches[0].accounts).toEqual([]);
  });
  it("删除后回到前一个批次", () => {
    expect(removeBatch(batches, 1)).toEqual({ batches: [batches[0]], activeBatch: 0 });
  });
  it("空批次不参与导出", () => {
    expect(validJeMarkBatches(batches)).toEqual([batches[0]]);
  });
  it("提示某科目已在别的批次选过，当前批次自己不算", () => {
    expect(batchesContaining(batches, 1, "管理费用-差旅费")).toEqual(["批次1"]);
    expect(batchesContaining(batches, 0, "管理费用-差旅费")).toEqual([]);
  });
});

describe("科目字段变更", () => {
  it("换了科目列就清空所有批次的已选科目", () => {
    const cleared = clearAccountsOnMappingChange([
      { name: "批次1", accounts: ["A"] },
      { name: "批次2", accounts: ["B", "C"] },
    ]);
    expect(cleared.map((batch) => batch.accounts)).toEqual([[], []]);
    expect(cleared.map((batch) => batch.name)).toEqual(["批次1", "批次2"]);
  });
  it("科目列顺序变化也算变化——拼接值会跟着变", () => {
    expect(accountMappingKey(mapping(["一级科目", "明细科目"]))).not.toBe(
      accountMappingKey(mapping(["明细科目", "一级科目"])),
    );
  });
});

describe("列筛选", () => {
  it("空选择不进导出参数，重复值去重", () => {
    expect(activeColumnFilters({ 部门: ["生产部", "生产部"], 项目: [] })).toEqual([
      { field: "部门", values: ["生产部"] },
    ]);
  });
});

describe("默认输出", () => {
  const now = new Date(2026, 7, 21, 9, 5, 3);
  it("命名为 正负数标记_源文件名_工作表_时间戳", () => {
    expect(defaultJeMarkOutputName("C:\\凭证\\总账.xlsx", "2026", now)).toBe(
      "正负数标记_总账_工作表2026_20260821_090503.csv",
    );
  });
  it("没有工作表时不加工作表段", () => {
    expect(defaultJeMarkOutputName("C:\\凭证\\总账.xlsx", "", now)).toBe(
      "正负数标记_总账_20260821_090503.csv",
    );
  });
  it("默认落在凭证文件所在目录", () => {
    expect(defaultJeMarkOutputPath("C:\\凭证\\总账.xlsx", "", now)).toBe(
      "C:\\凭证\\正负数标记_总账_20260821_090503.csv",
    );
  });
  it("盘符根目录下不会多出一个分隔符", () => {
    expect(defaultJeMarkOutputPath("C:\\总账.xlsx", "", now)).toBe(
      "C:\\正负数标记_总账_20260821_090503.csv",
    );
  });
});
