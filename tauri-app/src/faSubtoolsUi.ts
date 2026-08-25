import {
  FA_LLM_ROLE_MAP,
  FA_LOW_CONFIDENCE,
  faMissingOptionalRoles,
  faParentDirectory,
  normalizeFaSuggestedMapping,
  shouldAutoApplyFa,
  type FaLlmSuggestionLike,
  type FaMappingLike,
  type FaSide,
} from "./faListUi";

/// FA 子工具（折旧测算 / 折旧政策对比）共用的纯函数助手。
/// 页面交互在 FaDepCalcPage / FaPolicyComparePage，这里只放可单测的决策逻辑，
/// 与 faListUi.ts 的分工一致。

// ---------------------------------------------------------------------------
// 折旧测算（单文件）
// ---------------------------------------------------------------------------

/// 折旧测算的映射角色。必填集合与 Rust 侧 `DEP_REQUIRED_ROLES` 一致——
/// 公式块依赖这六列，缺一列导出就会被后端拒绝，前端提前拦住。
export const DEP_MAPPING_ROLES: [string, string][] = [
  ["category", "资产类别"],
  ["name", "资产名称"],
  ["originalValue", "原值"],
  ["depreciation", "累计折旧"],
  ["startDate", "开始使用日期"],
  ["life", "使用寿命"],
  ["residualRate", "残值率"],
  ["currentYearDep", "本年折旧"],
];

export const DEP_REQUIRED_ROLE_KEYS = [
  "originalValue",
  "depreciation",
  "startDate",
  "life",
  "residualRate",
  "currentYearDep",
];

export const depRoleLabel = (key: string): string =>
  DEP_MAPPING_ROLES.find(([role]) => role === key)?.[1] ?? key;

/// 未映射的必填角色（返回中文标签列表，用于红色拦截提示）。
export const depMissingRoles = (mapping: FaMappingLike): string[] =>
  DEP_REQUIRED_ROLE_KEYS.filter((key) => !String(mapping[key] ?? "").trim()).map(
    depRoleLabel,
  );

/// 未映射的选填角色（黄色提示：类别/名称，留空仍可导出）。
export const depMissingOptionalRoles = (mapping: FaMappingLike): string[] =>
  (["category", "name"] as const)
    .filter((key) => !String(mapping[key] ?? "").trim())
    .map(depRoleLabel);

// ---------------------------------------------------------------------------
// 折旧政策对比（双文件）
// ---------------------------------------------------------------------------

/// 政策对比的映射角色与 FA 主工具（FaListPage.mappingRoles）完全一致：
/// 同样的十个角色、同样的中文名。导出侧（fa_subtools.rs）只消费其中
/// 类别/原值/寿命/残值率四要素，但映射界面保持同构，用户在两个工具间
/// 不需要切换心智模型。
export const POLICY_MAPPING_ROLES: [string, string][] = [
  ["category", "资产类别"],
  ["name", "资产名称"],
  ["originalValue", "原值"],
  ["depreciation", "累计折旧"],
  ["startDate", "开始使用日期"],
  ["life", "使用寿命"],
  ["residualRate", "残值率"],
  ["currentYearDep", "本年折旧"],
  ["additionMethod", "新增方式"],
  ["additionDate", "新增日期"],
];

/// 必填集合与 FA 主工具 REQUIRED_ROLES 一致（组合匹配键在该页面单独校验，
/// 这里不重复列）。
export const POLICY_REQUIRED_ROLE_KEYS = [
  "category",
  "name",
  "originalValue",
  "depreciation",
];

export const policyRoleLabel = (key: string): string =>
  key === "matchKeys"
    ? "组合匹配键"
    : (POLICY_MAPPING_ROLES.find(([role]) => role === key)?.[1] ?? key);

export const policyMissingRoles = (mapping: FaMappingLike): string[] =>
  POLICY_REQUIRED_ROLE_KEYS.filter((key) => !String(mapping[key] ?? "").trim()).map(
    policyRoleLabel,
  );

/// 选填未映射提示与 FA 同口径：按侧过滤（期初不出现文件2专属角色）、
/// 新增方式/新增日期仅在已识别新增方式列时才提醒。
export const policyMissingOptionalRoles = (
  side: FaSide,
  mapping: FaMappingLike,
): string[] =>
  faMissingOptionalRoles(side, POLICY_MAPPING_ROLES, POLICY_REQUIRED_ROLE_KEYS, mapping);

// ---------------------------------------------------------------------------
// 默认输出路径（与 Rust 侧 subtool_output_path 同口径）
// ---------------------------------------------------------------------------

const stamped = (prefix: string, now: Date): string =>
  `${prefix}_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate(),
  ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
    now.getMinutes(),
  ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}.xlsx`;

export const faDepDefaultOutputName = (now: Date = new Date()): string =>
  stamped("折旧测算", now);

export const faPolicyDefaultOutputName = (now: Date = new Date()): string =>
  stamped("折旧政策对比", now);

/// 目录解析与拼接规则逐字复用 faDefaultOutputPath（含盘符根目录保留斜杠、
/// 混用分隔符的口径），仅替换文件名前缀。
const defaultOutputPath = (prefix: string, source: string, now: Date): string => {
  const directory = faParentDirectory(source);
  if (!directory) return "";
  const separator = directory.endsWith("\\") || directory.endsWith("/") ? "" : "\\";
  return `${directory}${separator}${stamped(prefix, now)}`;
};

export const faDepDefaultOutputPath = (
  sourcePath: string,
  now: Date = new Date(),
): string => defaultOutputPath("折旧测算", sourcePath, now);

export const faPolicyDefaultOutputPath = (
  endPath: string,
  now: Date = new Date(),
): string => defaultOutputPath("折旧政策对比", endPath, now);

// ---------------------------------------------------------------------------
// 折旧测算的单文件 LLM 复核规划器（faListUi.planFaLlmChanges 的单文件版）
// ---------------------------------------------------------------------------

export type DepMappingChange = {
  id: string;
  label: string;
  before: string;
  after: string;
  reason?: string;
  confidence?: number;
  attention: boolean;
  restore: { key: string; value?: string };
};

export type DepPendingSuggestion = {
  id: string;
  label: string;
  current: string;
  suggested: string;
  reason?: string;
  confidence?: number;
  apply: { key: string; value: string };
};

export type DepLlmPlanInput = {
  mapping: FaMappingLike;
  autoApplied?: FaLlmSuggestionLike[];
  fieldReviews?: FaLlmSuggestionLike[];
};

export type DepLlmPlan = {
  mapping: FaMappingLike;
  changes: DepMappingChange[];
  pending: DepPendingSuggestion[];
};

const depValueText = (value?: string | string[]): string => {
  if (Array.isArray(value)) {
    const items = value.map((item) => item?.trim()).filter(Boolean);
    return items.length ? items.join(" + ") : "未映射";
  }
  return value?.trim() ? value.trim() : "未映射";
};

/// 先改后核：高把握建议直接改 mapping 并进变更清单（可撤销），低把握进待定
/// 清单由用户采纳——与主工具 planFaLlmChanges 同一套规则，只是没有 file1/匹配键。
export function planDepLlmChanges(input: DepLlmPlanInput): DepLlmPlan {
  const mapping: FaMappingLike = { ...input.mapping };
  const collected = new Map<string, DepMappingChange>();
  const pending: DepPendingSuggestion[] = [];
  const depKeys = new Set(DEP_MAPPING_ROLES.map(([key]) => key));
  const record = (
    key: string,
    column: string,
    item: { confidence?: number; reason?: string },
  ) => {
    const before = mapping[key];
    if (depValueText(before as string | string[]) === column) return;
    mapping[key] = column;
    const id = key;
    const existing = collected.get(id);
    collected.set(id, {
      id,
      label: depRoleLabel(key),
      before: existing ? existing.before : depValueText(before as string | string[]),
      after: column,
      reason: item.reason,
      confidence: item.confidence,
      attention:
        item.confidence !== undefined && item.confidence < FA_LOW_CONFIDENCE,
      restore: existing
        ? existing.restore
        : {
            key,
            value: typeof before === "string" ? before : undefined,
          },
    });
  };
  const consider = (
    key: string,
    column: string,
    item: { confidence?: number; reason?: string },
  ) => {
    if (!depKeys.has(key)) return;
    const before = mapping[key];
    if (depValueText(before as string | string[]) === column) return;
    if (shouldAutoApplyFa(item.confidence)) {
      record(key, column, item);
      return;
    }
    pending.push({
      id: key,
      label: depRoleLabel(key),
      current: depValueText(before as string | string[]),
      suggested: column,
      reason: item.reason,
      confidence: item.confidence,
      apply: { key, value: column },
    });
  };
  for (const item of [
    ...(input.autoApplied ?? []),
    ...(input.fieldReviews ?? []),
  ]) {
    const key = FA_LLM_ROLE_MAP[item.role];
    if (!key) continue;
    // 单文件复核里 file_side 固定为 file2（后端已归一/过滤）。
    if (item.suggested_column?.trim()) {
      consider(key, item.suggested_column.trim(), item);
      continue;
    }
    const suggested = normalizeFaSuggestedMapping(item.suggested_mapping);
    if (suggested.file2) consider(key, suggested.file2, item);
  }
  return { mapping, changes: [...collected.values()], pending };
}
