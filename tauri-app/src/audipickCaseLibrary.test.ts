import { describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ settingsGet: vi.fn(async () => ({})), settingsSet: vi.fn(async () => {}) }));
import { settingsGet, settingsSet } from "./api";
import { CASE_LIBRARY_SETTING, DEFAULT_CASE_LIBRARY, validateCaseLibrary, diffCaseLibraries, loadCaseLibraryState, makeCaseLibraryVersion } from "./audipickCaseLibrary";
describe("案例库结构和版本", () => {
  it("保留 1.2 基线", () => { const lib = validateCaseLibrary(DEFAULT_CASE_LIBRARY); expect(lib.categories).toHaveLength(5); expect(lib.positive_examples).toHaveLength(43); expect(lib.exclusions_and_support).toHaveLength(12); expect(lib.c300_regression).toHaveLength(17); });
  it("停用无量化门槛的旧正例并修正 C300 预期", () => {
    const lib = validateCaseLibrary(DEFAULT_CASE_LIBRARY);
    const disabled = lib.positive_examples.filter(example => example.status === "停用").map(example => example.case_id);
    expect(disabled).toEqual(["P020", "P026", "P027", "P028", "P029", "P032", "P033", "P042"]);
    expect(lib.positive_examples.filter(example => example.status !== "停用")).toHaveLength(35);
    for (const id of ["R001", "R002", "R011"]) {
      expect(lib.c300_regression.find(item => item.regression_id === id)?.expected_result).toBe("排除");
    }
  });
  it("旧内置案例库自动升级到当前版本", async () => {
    for (const legacyHash of [
      "d66879f70823bf7c4f25ec279e80036395df35ef581fafa87fe9cd14cfb59e1d",
      "a1dcf4089f946f33c693902a51895f6c571cba9992e61612483b59c354e073a1",
    ]) {
      const legacy = {active: {library: structuredClone(DEFAULT_CASE_LIBRARY), hash: legacyHash, activatedAt: "2026-09-21T00:00:00.000Z"}};
      vi.mocked(settingsGet).mockResolvedValueOnce({[CASE_LIBRARY_SETTING]: legacy});
      const state = await loadCaseLibraryState();
      expect(state.active.library.metadata.version).toBe("1.2-review");
      expect(state.previous?.hash).toBe(legacyHash);
      expect(settingsSet).toHaveBeenLastCalledWith({[CASE_LIBRARY_SETTING]: state});
    }
  });
  it("拒绝重复编号和不存在的分类", () => { const lib = structuredClone(DEFAULT_CASE_LIBRARY); lib.positive_examples.push(lib.positive_examples[0]); expect(() => validateCaseLibrary(lib)).toThrow(/重复/); lib.positive_examples.pop(); lib.positive_examples[0].category_id = "C99"; expect(() => validateCaseLibrary(lib)).toThrow(/分类/); });
  it("预览新增、删除及正文修改", () => { const lib = structuredClone(DEFAULT_CASE_LIBRARY); lib.positive_examples[0].excerpt += "修改"; lib.positive_examples.pop(); lib.positive_examples.push({ ...lib.positive_examples[1], case_id: "P999" }); const diff = diffCaseLibraries(DEFAULT_CASE_LIBRARY, lib); expect(diff.added).toContain("正例 P999"); expect(diff.removed).toContain("正例 P043"); expect(diff.changed).toContain("正例 P001"); });
  it("内容相同哈希稳定，修改内容改变哈希", async () => { const first = await makeCaseLibraryVersion(DEFAULT_CASE_LIBRARY); const second = await makeCaseLibraryVersion(structuredClone(DEFAULT_CASE_LIBRARY)); expect(first.hash).toBe(second.hash); expect(first.hash).toMatch(/^[a-f0-9]{64}$/); const lib = structuredClone(DEFAULT_CASE_LIBRARY); lib.positive_examples[0].excerpt += "修改"; expect((await makeCaseLibraryVersion(lib)).hash).not.toBe(first.hash); });
});
