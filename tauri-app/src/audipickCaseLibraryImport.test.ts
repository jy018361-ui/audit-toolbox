import { beforeEach, describe, expect, it, vi } from "vitest";
const saved = vi.hoisted(() => ({ value: {} as Record<string,unknown> }));
vi.mock("./api", () => ({ settingsGet: vi.fn(async () => saved.value), settingsSet: vi.fn(async (patch:Record<string,unknown>) => {saved.value = {...saved.value,...patch};}) }));
import sheets from "../tests/fixtures/covenant-cases-sheets.json";
import { activateCaseLibrary, caseLibraryFromSheets, DEFAULT_CASE_LIBRARY, loadActiveCaseLibrary, loadCaseLibraryState, rollbackCaseLibrary, CASE_LIBRARY_SETTING } from "./audipickCaseLibrary";
describe("Excel 导入和持久化", () => {
 beforeEach(() => {saved.value = {};});
 it("实际 1.2 Excel 五张表转换为内部 JSON", () => {const lib=caseLibraryFromSheets(sheets); expect(lib.categories).toHaveLength(5); expect(lib.positive_examples).toHaveLength(43); expect(lib.exclusions_and_support).toHaveLength(12); expect(lib.c300_regression).toHaveLength(17); expect(lib.positive_examples.map(x=>x.excerpt)).toEqual(DEFAULT_CASE_LIBRARY.positive_examples.map(x=>x.excerpt));});
 it("缺列、错误状态与重复编号拒绝导入", () => {const bad=structuredClone(sheets); bad['正例条款'][0][0]='错误列'; expect(()=>caseLibraryFromSheets(bad)).toThrow(/缺少列/); const other=structuredClone(sheets); const statusIndex=other['正例条款'][0].indexOf('状态'); other['正例条款'][1][statusIndex]='未知'; expect(()=>caseLibraryFromSheets(other)).toThrow(/结构校验/);});
 it("预览不保存，启用后重载及回滚正常", async () => {const imported=caseLibraryFromSheets(sheets); expect((await loadActiveCaseLibrary()).metadata.version).toBe(DEFAULT_CASE_LIBRARY.metadata.version); imported.metadata.version='2.0'; await activateCaseLibrary(imported); expect((await loadActiveCaseLibrary()).metadata.version).toBe('2.0'); expect((await loadCaseLibraryState()).previous?.library.metadata.version).toBe(DEFAULT_CASE_LIBRARY.metadata.version); await rollbackCaseLibrary(); expect((await loadActiveCaseLibrary()).metadata.version).toBe(DEFAULT_CASE_LIBRARY.metadata.version);});
 it("损坏的已保存版本明确报错", async () => {await activateCaseLibrary(caseLibraryFromSheets(sheets)); const state=saved.value[CASE_LIBRARY_SETTING] as {active:{hash:string}}; state.active.hash='损坏'; await expect(loadCaseLibraryState()).rejects.toThrow(/摘要校验失败/);});
});
