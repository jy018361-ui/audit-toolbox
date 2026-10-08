import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { settingsGet, settingsSet } from "./api";
import defaultData from "./data/covenant-cases-v1.json";
const required = z.string().trim().min(1, "必填内容不能为空");
const optionalFields = { status: z.enum(["启用", "停用", "enabled", "disabled"]).optional(), keywords: z.string().optional(), search_terms: z.string().optional() };
const schema = z.object({
 metadata: z.object({ name: required, version: required, scope: z.string().default(""), formal_output_rule: z.string().default(""), date: z.string().optional(), version_notes: z.string().optional() }).passthrough(),
 categories: z.array(z.object({ category_id: required, category: required, include: required, examples: z.string(), exclude: z.string() })).min(1),
 positive_examples: z.array(z.object({ case_id: required, category_id: required, category: required, subtype: required, normalized_rule: required, excerpt: required, data_basis: required, key_elements: z.string(), ...optionalFields }).passthrough()).min(1),
 exclusions_and_support: z.array(z.object({ case_id: required, type: z.enum(["排除", "支持性"]), topic: required, excerpt: required, reason: required, handling: required, ...optionalFields }).passthrough()).min(1),
 c300_regression: z.array(z.object({ regression_id: required, category_id: z.string(), clause_ref: required, expected_behavior: required, expected_result: z.enum(["应收录", "排除", "不得独立成条"]) })),
});
export type CovenantCaseLibrary = z.infer<typeof schema>;
export type CovenantCase = CovenantCaseLibrary["positive_examples"][number];
export function validateCaseLibrary(input: unknown): CovenantCaseLibrary {
 const result = schema.safeParse(input);
 if (!result.success) throw new Error(`案例库结构校验失败：${result.error.issues.map(i => `${i.path.join(".")} ${i.message}`).join("；")}`);
 const lib = result.data;
 const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) throw new Error("案例库存在重复编号"); };
 unique(lib.categories.map(x => x.category_id)); unique([...lib.positive_examples, ...lib.exclusions_and_support].map(x => x.case_id)); unique(lib.c300_regression.map(x => x.regression_id));
 const categories = new Map(lib.categories.map(x => [x.category_id, x.category]));
 for (const row of lib.positive_examples) if (categories.get(row.category_id) !== row.category) throw new Error(`案例 ${row.case_id} 的分类编号或名称不匹配`);
 for (const row of lib.c300_regression) if (row.category_id && !categories.has(row.category_id)) throw new Error(`回归 ${row.regression_id} 的分类不存在`);
 return lib;
}
export const DEFAULT_CASE_LIBRARY = validateCaseLibrary(defaultData);
export interface CaseLibraryVersion { library: CovenantCaseLibrary; hash: string; activatedAt: string }
export interface CaseLibraryState { active: CaseLibraryVersion; previous?: CaseLibraryVersion }
export const CASE_LIBRARY_SETTING = "audipick_covenant_case_library";
const LEGACY_BUNDLED_CASE_LIBRARY_HASHES = new Set([
 "d66879f70823bf7c4f25ec279e80036395df35ef581fafa87fe9cd14cfb59e1d",
 "a1dcf4089f946f33c693902a51895f6c571cba9992e61612483b59c354e073a1",
]);
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`; return JSON.stringify(value); }
export async function makeCaseLibraryVersion(input: unknown): Promise<CaseLibraryVersion> {
 const library = validateCaseLibrary(input);
 const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(library)));
 return { library, hash: Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2,"0")).join(""), activatedAt: new Date().toISOString() };
}
export async function loadCaseLibraryState(): Promise<CaseLibraryState> {
 const settings = await settingsGet(); const saved = settings[CASE_LIBRARY_SETTING] as CaseLibraryState | undefined;
 if (!saved) return { active: await makeCaseLibraryVersion(DEFAULT_CASE_LIBRARY) };
 if (LEGACY_BUNDLED_CASE_LIBRARY_HASHES.has(saved.active.hash)) {
  const next = {active: await makeCaseLibraryVersion(DEFAULT_CASE_LIBRARY), previous: saved.active};
  await settingsSet({[CASE_LIBRARY_SETTING]: next});
  return next;
 }
 const verify = async (version: CaseLibraryVersion) => { const checked = await makeCaseLibraryVersion(version.library); if (checked.hash !== version.hash) throw new Error("案例库摘要校验失败，请重新导入 Excel"); return { ...checked, activatedAt: version.activatedAt }; };
 return { active: await verify(saved.active), ...(saved.previous ? {previous: await verify(saved.previous)} : {}) };
}
export async function loadActiveCaseLibrary(): Promise<CovenantCaseLibrary> { return (await loadCaseLibraryState()).active.library; }
export async function activateCaseLibrary(library: CovenantCaseLibrary): Promise<CaseLibraryState> { const current = await loadCaseLibraryState(); const active = await makeCaseLibraryVersion(library); if (active.hash === current.active.hash) return current; const next = {active, previous: current.active}; await settingsSet({[CASE_LIBRARY_SETTING]: next}); return next; }
export async function rollbackCaseLibrary(): Promise<CaseLibraryState> { const current = await loadCaseLibraryState(); if (!current.previous) throw new Error("没有可回滚的上一版本"); const next = {active: current.previous, previous: current.active}; await settingsSet({[CASE_LIBRARY_SETTING]: next}); return next; }
export function diffCaseLibraries(before: CovenantCaseLibrary, after: CovenantCaseLibrary) {
 const rows = (lib: CovenantCaseLibrary) => new Map<string, unknown>([
 ["版本与说明",lib.metadata], ...lib.categories.map(x => [`分类 ${x.category_id}`,x] as [string, unknown]), ...lib.positive_examples.map(x => [`正例 ${x.case_id}`,x] as [string, unknown]), ...lib.exclusions_and_support.map(x => [`规则 ${x.case_id}`,x] as [string, unknown]), ...lib.c300_regression.map(x => [`回归 ${x.regression_id}`,x] as [string, unknown])]);
 const old = rows(before), next = rows(after); return { added: [...next.keys()].filter(k => !old.has(k)), removed: [...old.keys()].filter(k => !next.has(k)), changed: [...next.keys()].filter(k => old.has(k) && canonical(old.get(k)) !== canonical(next.get(k))) };
}
export async function importCaseLibraryExcel(file: File): Promise<CovenantCaseLibrary> {
 if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("请选择 .xlsx 案例库工作簿");
 if (file.size > 8 * 1024 * 1024) throw new Error("案例库工作簿不能超过 8 MB");
 if (!("__TAURI_INTERNALS__" in window)) throw new Error("请在桌面应用中导入 Excel 案例库");
 return caseLibraryFromSheets(await invoke<Record<string,string[][]>>("covenant_case_workbook", {bytes: Array.from(new Uint8Array(await file.arrayBuffer()))}));
}
export function caseLibraryFromSheets(sheets: Record<string, string[][]>): CovenantCaseLibrary {
 const table = (name: string, columns: Record<string,string>) => {
  const rows = sheets[name]; if (!rows?.length) throw new Error(`缺少工作表：${name}`);
  const headers = rows[0]; if (new Set(headers).size !== headers.length) throw new Error(`${name} 存在重复列名`);
  for (const label of Object.values(columns)) if (!headers.includes(label)) throw new Error(`${name} 缺少列：${label}`);
  return rows.slice(1).filter(row => row.some(v => v.trim())).map(row => Object.fromEntries([...Object.entries(columns), ["status","状态"], ["keywords","同义词/检索词"]].filter(([, label]) => headers.includes(label)).map(([key,label]) => [key,row[headers.indexOf(label)]?.trim() || (key === "status" ? "启用" : "")])));
 };
 const instructions = sheets["使用说明"]; if (!instructions) throw new Error("缺少工作表：使用说明");
 const info = Object.fromEntries(instructions.slice(1).map(row => [row[0],row[1] || ""]));
 return validateCaseLibrary({metadata: {name:"限制性契约案例库", version:info["版本"], scope:info["收录范围"] || "", formal_output_rule: [info["正式结果粒度"],info["共同后果"]].filter(Boolean).join("；"), version_notes: info["版本说明"] || ""},
 categories: table("分类规则",{category_id:"分类编号",category:"分类",include:"收录标准",examples:"案例类型",exclude:"排除边界"}),
 positive_examples: table("正例条款",{case_id:"案例编号",category_id:"分类编号",category:"一级分类",subtype:"二级类型",normalized_rule:"标准化判断规则",excerpt:"合同原文摘录",data_basis:"可核验数据",key_elements:"必须保留的要素",source_workbook:"来源工作簿",source_sheet:"来源工作表",source_location:"来源位置",source_type:"来源形式",notes:"备注"}),
 exclusions_and_support: table("排除与支持",{case_id:"案例编号",type:"处理类型",topic:"主题",excerpt:"示例原文",reason:"原因",handling:"处理方式",source:"来源"}),
 c300_regression: table("C300回归",{regression_id:"回归编号",category_id:"分类编号",clause_ref:"合同条款",expected_behavior:"预期识别内容",expected_result:"预期结果"}) });
}
