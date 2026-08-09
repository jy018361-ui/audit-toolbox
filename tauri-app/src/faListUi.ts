export function shouldShowFaAdditionFields(additionMethod?: string): boolean {
  return Boolean(additionMethod?.trim());
}

export function shouldAutoPrefillFaAddition(
  additionMethod: string | undefined,
  endOnlyRows: number,
  alreadyHandled: boolean,
): boolean {
  // A date-like column alone is not proof that the ending file is an addition
  // list. The legacy prefill is only safe once the addition-method mapping is
  // explicit and the merge actually contains ending-only rows.
  return (
    !alreadyHandled &&
    endOnlyRows > 0 &&
    shouldShowFaAdditionFields(additionMethod)
  );
}

/// Whether 步骤2 的「应用补充映射并继续」可以点。
///
/// A supplement does not have to be a separate workbook.  When file2 itself
/// carries 新增方式/新增日期, step 1 already mapped them and the 新增清单 is in
/// effect complete — requiring a browsed file path here left the primary button
/// greyed out and pushed the user onto 「无补充清单，跳过」, which *clears* that
/// mapping.  处置清单 stays genuinely optional: a period with no disposals is a
/// normal outcome, not a missing input.
export function canApplyFaSupplements(
  additionPath: string,
  disposalPath: string,
  endAdditionMethod?: string,
): boolean {
  return Boolean(
    additionPath ||
      disposalPath ||
      shouldShowFaAdditionFields(endAdditionMethod),
  );
}

export function isFaMatchDisabled(
  hasInspection: boolean,
  businessJobBusy: boolean,
): boolean {
  // LLM review is advisory and must never lock the deterministic merge path.
  return !hasInspection || businessJobBusy;
}

export function faOutputPathAfterSourceSelection(
  currentOutputPath: string,
  previousSourcePath: string,
  selectedSourcePath: string,
): string {
  // The save target is scoped to one pair of source workbooks. Carrying it to
  // another sample can overwrite (or, when Excel has it open, fail to replace)
  // the prior result. Re-selecting the same source is harmless and keeps the
  // user's explicit save choice.
  return previousSourcePath === selectedSourcePath ? currentOutputPath : "";
}

export function faParentDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (index < 0) return "";
  // "C:\file.xlsx" -> "C:\", not "C:".
  return index === 2 && path[1] === ":" ? path.slice(0, 3) : path.slice(0, index);
}

export function faDefaultOutputName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `FA_List_${stamp}.xlsx`;
}

/// The full path the export will write to when the user does not pick one.
///
/// Mirrors `fa::output_path` in Rust (period-end file's folder,
/// FA_List_<yyyymmdd>_<hhmmss>.xlsx).  Showing it up front is what lets the
/// export run without a save dialog while the user can still see — and change —
/// where the workbook lands.
export function faDefaultOutputPath(endPath: string, now = new Date()): string {
  const directory = faParentDirectory(endPath);
  if (!directory) return "";
  const separator = directory.endsWith("\\") || directory.endsWith("/") ? "" : "\\";
  return `${directory}${separator}${faDefaultOutputName(now)}`;
}

export function shouldShowFaPreviewWorkspace(
  step: 1 | 2 | 3,
  _hasMatchResult: boolean,
): boolean {
  // 文件配置和补充清单配置都需要随时对照原表。匹配完成不应把预览换走，
  // 否则用户在继续核对字段时会失去数据上下文；只有导出步骤展示结果区。
  return step === 1 || step === 2;
}

export function faHeaderOption(header: string): {
  value: string;
  label: string;
} {
  // Excel headers may legitimately contain leading/trailing spaces.  The raw
  // value must be preserved for the business engine, while the UI should show
  // the readable trimmed label.  Relying on an option's text as its implicit
  // value lets the browser collapse whitespace and breaks controlled selects.
  return {
    value: header,
    label: header.trim() || header,
  };
}

export function normalizeFaSuggestedMapping(
  value: unknown,
): Partial<Record<"file1" | "file2", string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const result: Partial<Record<"file1" | "file2", string>> = {};
  for (const side of ["file1", "file2"] as const) {
    const column = raw[side];
    if (typeof column === "string" && column.trim()) result[side] = column.trim();
  }
  return result;
}

// LLM 复核采用"先改后核"：判断该改就直接改，用户在变更清单里看到改前改后，
// 不认可再逐条撤销。以下逻辑负责算出改动结果和这份清单。
export const FA_LLM_ROLE_MAP: Record<string, string> = {
  original_value: "originalValue",
  depreciation: "depreciation",
  category: "category",
  name: "name",
  date: "startDate",
  life: "life",
  residual: "residualRate",
  current_year_dep: "currentYearDep",
  addition_method: "additionMethod",
  addition_date: "additionDate",
};
// 这三个字段描述本期/新增信息，只属于文件2（期末）。文件1即使列名相似也
// 不参与映射，避免脚本或 LLM 的旧建议重新把它们写回期初侧。
export const FA_FILE2_ONLY_MAPPING_KEYS = new Set([
  "currentYearDep",
  "additionMethod",
  "additionDate",
]);
export function sanitizeFaBeginMapping(mapping: FaMappingLike): FaMappingLike {
  const result = { ...mapping };
  for (const key of FA_FILE2_ONLY_MAPPING_KEYS) delete result[key];
  return result;
}
export const FA_LOW_CONFIDENCE = 0.7;
// 把握达到门槛才自动改，不到的原样留着，由用户决定是否采纳。
export const FA_AUTO_APPLY_MIN = 0.6;
export const shouldAutoApplyFa = (confidence?: number) =>
  confidence === undefined || confidence >= FA_AUTO_APPLY_MIN;
export type FaPendingSuggestion = {
  id: string;
  label: string;
  current: string;
  suggested: string;
  reason?: string;
  confidence?: number;
  apply: FaRestore | FaSupplementRestore;
};
export type FaSide = "begin" | "end";
export type FaRestore =
  | { kind: "mapping"; side: FaSide; key: string; value?: string }
  | { kind: "matchKeys"; begin: string[]; end: string[] };
export type FaMappingChange = {
  id: string;
  label: string;
  before: string;
  after: string;
  reason?: string;
  confidence?: number;
  attention: boolean;
  restore: FaRestore;
};
export type FaLlmSuggestionLike = {
  role: string;
  file_side?: "file1" | "file2";
  suggested_column?: string;
  confidence?: number;
  reason?: string;
  suggested_mapping?: unknown;
};
export type FaMatchReviewLike = {
  action?: string;
  confidence?: number;
  reasons?: string[];
  suggested_file1_columns?: string[];
  suggested_file2_columns?: string[];
  suggestion_reason?: string;
};
// FA 的映射对象里除了列名，还混着 matchKeys 这类数组字段，这里只改列名字段。
export type FaMappingLike = Record<string, string | string[] | undefined>;
export type FaLlmPlanInput = {
  beginMapping: FaMappingLike;
  endMapping: FaMappingLike;
  beginKeys: string[];
  endKeys: string[];
  autoApplied?: FaLlmSuggestionLike[];
  fieldReviews?: FaLlmSuggestionLike[];
  matchReview?: FaMatchReviewLike;
  roleLabels: Record<string, string>;
};
export type FaLlmPlan = {
  beginMapping: FaMappingLike;
  endMapping: FaMappingLike;
  beginKeys: string[];
  endKeys: string[];
  changes: FaMappingChange[];
  pending: FaPendingSuggestion[];
};

const faValueText = (value?: string | string[] | boolean): string => {
  if (Array.isArray(value)) {
    const items = value.map((item) => item?.trim()).filter(Boolean);
    return items.length ? items.join(" + ") : "未映射";
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  return value?.trim() ? value.trim() : "未映射";
};
const sideLabel = (side: FaSide) => (side === "begin" ? "期初" : "期末");

export function planFaLlmChanges(input: FaLlmPlanInput): FaLlmPlan {
  const mappings: Record<FaSide, FaMappingLike> = {
    begin: sanitizeFaBeginMapping(input.beginMapping),
    end: { ...input.endMapping },
  };
  // 同一字段可能被 autoApplied 和 fieldReviews 接连改动，按字段累计后只呈现净变化。
  const collected = new Map<string, FaMappingChange>();
  const record = (
    side: FaSide,
    key: string,
    column: string,
    item: { confidence?: number; reason?: string },
  ) => {
    const before = mappings[side][key];
    if (faValueText(before) === faValueText(column)) return;
    mappings[side][key] = column;
    const id = `${side}.${key}`;
    const existing = collected.get(id);
    collected.set(id, {
      id,
      label: `${sideLabel(side)} ${input.roleLabels[key] ?? key}`,
      before: existing ? existing.before : faValueText(before),
      after: faValueText(column),
      reason: item.reason,
      confidence: item.confidence,
      attention:
        item.confidence !== undefined && item.confidence < FA_LOW_CONFIDENCE,
      restore: existing
        ? existing.restore
        : {
            kind: "mapping",
            side,
            key,
            value: typeof before === "string" ? before : undefined,
          },
    });
  };

  const pending: FaPendingSuggestion[] = [];
  const consider = (
    side: FaSide,
    key: string,
    column: string,
    item: { confidence?: number; reason?: string },
  ) => {
    if (side === "begin" && FA_FILE2_ONLY_MAPPING_KEYS.has(key)) return;
    const before = mappings[side][key];
    if (faValueText(before) === faValueText(column)) return;
    if (shouldAutoApplyFa(item.confidence)) {
      record(side, key, column, item);
      return;
    }
    pending.push({
      id: `${side}.${key}`,
      label: `${sideLabel(side)} ${input.roleLabels[key] ?? key}`,
      current: faValueText(before),
      suggested: faValueText(column),
      reason: item.reason,
      confidence: item.confidence,
      apply: { kind: "mapping", side, key, value: column },
    });
  };

  for (const item of [
    ...(input.autoApplied ?? []),
    ...(input.fieldReviews ?? []),
  ]) {
    const key = FA_LLM_ROLE_MAP[item.role];
    if (!key) continue;
    // suggestions 用 file_side + suggested_column，fieldReviews 用 suggested_mapping 对象
    if (item.suggested_column?.trim() && item.file_side) {
      consider(
        item.file_side === "file1" ? "begin" : "end",
        key,
        item.suggested_column.trim(),
        item,
      );
    }
    const suggested = normalizeFaSuggestedMapping(item.suggested_mapping);
    if (suggested.file1) consider("begin", key, suggested.file1, item);
    if (suggested.file2) consider("end", key, suggested.file2, item);
  }

  let beginKeys = input.beginKeys;
  let endKeys = input.endKeys;
  const match = input.matchReview;
  const suggestedBegin = match?.suggested_file1_columns ?? [];
  const suggestedEnd = match?.suggested_file2_columns ?? [];
  // 匹配键必须两侧等长才成对，否则整条建议无法执行。
  const matchApplicable =
    !!match &&
    match.action !== "keep" &&
    suggestedBegin.length > 0 &&
    suggestedBegin.length === suggestedEnd.length;
  const matchChanged =
    matchApplicable &&
    (faValueText(beginKeys) !== faValueText(suggestedBegin) ||
      faValueText(endKeys) !== faValueText(suggestedEnd));
  if (matchChanged && !shouldAutoApplyFa(match?.confidence)) {
    pending.push({
      id: "matchKeys",
      label: "匹配 ID",
      current: `期初 ${faValueText(beginKeys)}；期末 ${faValueText(endKeys)}`,
      suggested: `期初 ${faValueText(suggestedBegin)}；期末 ${faValueText(suggestedEnd)}`,
      reason: match?.reasons?.join("；") || match?.suggestion_reason,
      confidence: match?.confidence,
      apply: { kind: "matchKeys", begin: suggestedBegin, end: suggestedEnd },
    });
  } else if (matchChanged) {
    collected.set("matchKeys", {
      id: "matchKeys",
      label: "匹配 ID",
      before: `期初 ${faValueText(beginKeys)}；期末 ${faValueText(endKeys)}`,
      after: `期初 ${faValueText(suggestedBegin)}；期末 ${faValueText(suggestedEnd)}`,
      reason: match?.reasons?.join("；") || match?.suggestion_reason,
      confidence: match?.confidence,
      // 匹配键决定整张表怎么对上，改错影响面最大，一律提示重点核对。
      attention: true,
      restore: { kind: "matchKeys", begin: beginKeys, end: endKeys },
    });
    beginKeys = suggestedBegin;
    endKeys = suggestedEnd;
  }

  return {
    beginMapping: mappings.begin,
    endMapping: mappings.end,
    beginKeys,
    endKeys,
    changes: [...collected.values()].filter(
      (change) => change.before !== change.after,
    ),
    // 后续的自动改动可能已经把某条待定建议变成现状，那就不必再问用户
    pending: pending.filter((item) =>
      item.apply.kind === "mapping"
        ? faValueText(mappings[item.apply.side][item.apply.key]) !==
          item.suggested
        : true,
    ),
  };
}

// 补充清单是另一套结构：新增/处置两张表各有自己的字段和匹配键。
export type FaSupplementTarget = "addition" | "disposal";
export const FA_SUPPLEMENT_ROLES: Record<
  string,
  { target: FaSupplementTarget; key: string; label: string }
> = {
  addition_method: { target: "addition", key: "method", label: "新增清单 变动方式" },
  addition_date: { target: "addition", key: "date", label: "新增清单 变动日期" },
  disposal_method: { target: "disposal", key: "method", label: "处置清单 变动方式" },
  disposal_date: { target: "disposal", key: "date", label: "处置清单 变动日期" },
  disposal_orig: { target: "disposal", key: "originalValue", label: "处置清单 原值" },
  disposal_dep: { target: "disposal", key: "depreciation", label: "处置清单 累计折旧" },
};
export type FaSupplementRestore =
  | { kind: "supplement"; target: FaSupplementTarget; key: string; value?: string }
  | { kind: "supplementKeys"; target: FaSupplementTarget; keys: string[] };
export type FaSupplementChange = Omit<FaMappingChange, "restore"> & {
  restore: FaSupplementRestore;
};
export type FaSupplementSideState = Record<
  string,
  string | string[] | boolean | undefined
> & {
  keys?: string[];
  matchKeysVerified?: boolean;
};
export type FaSupplementPlanInput = {
  addition: FaSupplementSideState;
  disposal: FaSupplementSideState;
  autoApplied?: FaLlmSuggestionLike[];
  fieldReviews?: FaLlmSuggestionLike[];
  matchReview?: FaMatchReviewLike;
};
export type FaSupplementPlan = {
  addition: FaSupplementSideState;
  disposal: FaSupplementSideState;
  changes: FaSupplementChange[];
  pending: FaPendingSuggestion[];
};

export function planFaSupplementChanges(
  input: FaSupplementPlanInput,
): FaSupplementPlan {
  const sides: Record<FaSupplementTarget, FaSupplementSideState> = {
    addition: { ...input.addition },
    disposal: { ...input.disposal },
  };
  const collected = new Map<string, FaSupplementChange>();
  const record = (
    role: string,
    column: string,
    item: { confidence?: number; reason?: string },
  ) => {
    const spec = FA_SUPPLEMENT_ROLES[role];
    if (!spec) return;
    const before = sides[spec.target][spec.key];
    if (faValueText(before) === faValueText(column)) return;
    sides[spec.target][spec.key] = column;
    const id = `${spec.target}.${spec.key}`;
    const existing = collected.get(id);
    collected.set(id, {
      id,
      label: spec.label,
      before: existing ? existing.before : faValueText(before),
      after: faValueText(column),
      reason: item.reason,
      confidence: item.confidence,
      attention:
        item.confidence !== undefined && item.confidence < FA_LOW_CONFIDENCE,
      restore: existing
        ? existing.restore
        : {
            kind: "supplement",
            target: spec.target,
            key: spec.key,
            value: typeof before === "string" ? before : undefined,
          },
    });
  };

  const pending: FaPendingSuggestion[] = [];
  const consider = (
    role: string,
    column: string,
    item: { confidence?: number; reason?: string },
  ) => {
    const spec = FA_SUPPLEMENT_ROLES[role];
    if (!spec) return;
    const before = sides[spec.target][spec.key];
    if (faValueText(before) === faValueText(column)) return;
    if (shouldAutoApplyFa(item.confidence)) {
      record(role, column, item);
      return;
    }
    pending.push({
      id: `${spec.target}.${spec.key}`,
      label: spec.label,
      current: faValueText(before),
      suggested: faValueText(column),
      reason: item.reason,
      confidence: item.confidence,
      apply: {
        kind: "supplement",
        target: spec.target,
        key: spec.key,
        value: column,
      },
    });
  };

  for (const item of [
    ...(input.autoApplied ?? []),
    ...(input.fieldReviews ?? []),
  ]) {
    if (item.suggested_column?.trim())
      consider(item.role, item.suggested_column.trim(), item);
    const suggested = normalizeFaSuggestedMapping(item.suggested_mapping);
    // 补充清单按角色前缀归属，不看 file_side
    const column = item.role.startsWith("addition_")
      ? suggested.file1
      : suggested.file2 ?? suggested.file1;
    if (column) consider(item.role, column, item);
  }

  const match = input.matchReview;
  if (match && match.action !== "keep") {
    const pairs: [FaSupplementTarget, string[]][] = [
      ["addition", match.suggested_file1_columns ?? []],
      ["disposal", match.suggested_file2_columns ?? []],
    ];
    for (const [target, suggestedKeys] of pairs) {
      // A three-row value collision against the configured primary-ledger keys
      // is stronger evidence than a language-model header guess.  Keep the
      // deterministic result; a user edit clears this flag and re-opens review.
      if (sides[target].matchKeysVerified === true) continue;
      const current = sides[target].keys ?? [];
      if (!suggestedKeys.length) continue;
      if (faValueText(current) === faValueText(suggestedKeys)) continue;
      if (!shouldAutoApplyFa(match.confidence)) {
        pending.push({
          id: `${target}.keys`,
          label: target === "addition" ? "新增清单 匹配 ID" : "处置清单 匹配 ID",
          current: faValueText(current),
          suggested: faValueText(suggestedKeys),
          reason: match.reasons?.join("；") || match.suggestion_reason,
          confidence: match.confidence,
          apply: { kind: "supplementKeys", target, keys: suggestedKeys },
        });
        continue;
      }
      collected.set(`${target}.keys`, {
        id: `${target}.keys`,
        label: target === "addition" ? "新增清单 匹配 ID" : "处置清单 匹配 ID",
        before: faValueText(current),
        after: faValueText(suggestedKeys),
        reason:
          match.reasons?.join("；") ||
          match.suggestion_reason ||
          "需要与第一步匹配 ID 保持同一口径",
        confidence: match.confidence,
        attention: true,
        restore: { kind: "supplementKeys", target, keys: current },
      });
      sides[target].keys = suggestedKeys;
    }
  }

  // 同一字段可能同时出现在 autoApplied 与 fieldReviews。已应用项通过 Map
  // 天然去重，低把握项此前直接 push，导致界面把同一条建议显示两遍。
  const uniquePending = new Map<string, FaPendingSuggestion>();
  for (const item of pending) uniquePending.set(item.id, item);

  return {
    addition: sides.addition,
    disposal: sides.disposal,
    changes: [...collected.values()].filter(
      (change) => change.before !== change.after,
    ),
    pending: [...uniquePending.values()].filter((item) =>
      item.apply.kind === "supplement"
        ? faValueText(sides[item.apply.target][item.apply.key]) !==
          item.suggested
        : true,
    ),
  };
}

export function faReviewSummary(applied: number, pending = 0): string {
  const done = applied ? `已自动调整 ${applied} 项，不合适可逐条撤销` : "";
  const ask = pending
    ? `另有 ${pending} 项把握不足 ${Math.round(FA_AUTO_APPLY_MIN * 100)}%，未改动，请确认是否采纳`
    : "";
  if (done && ask) return `LLM 复核完成：${done}；${ask}。`;
  if (done) return `LLM 复核完成：${done}。`;
  if (ask) return `LLM 复核完成：${ask}。`;
  return "LLM 复核完成：现有映射与 LLM 判断一致，未做改动。";
}
