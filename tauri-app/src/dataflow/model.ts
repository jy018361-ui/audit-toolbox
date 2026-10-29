/**
 * 数据流 DataFlow 工作流模型与纯函数层。
 *
 * 流程 JSON 结构与 Rust 引擎契约一致（camelCase）：
 * {"version":1,"name":"流程名","params":[...],"nodes":[...],"edges":[...],"notes":[]}
 * 这里集中负责：序列化/解析往返、参数占位替换、连线校验（禁自环/重复/环/
 * 输入口占用）、默认 config 生成与规整、localStorage 草稿、撤销/重做操作栈。
 */
import { z } from "zod";

import { anchorAcceptsMultiple, nodeSpec } from "./nodeSpecs";

export const WORKFLOW_VERSION = 1;

export type DataflowParamType = "text" | "number" | "date" | "path" | "folder";

export const DATAFLOW_PARAM_TYPES: { value: DataflowParamType; label: string }[] = [
  { value: "text", label: "文本（如期间）" },
  { value: "number", label: "数字（如金额门槛）" },
  { value: "date", label: "日期" },
  { value: "path", label: "文件路径" },
  { value: "folder", label: "文件夹路径" },
];

export interface DataflowParam {
  id: string;
  name: string;
  type: DataflowParamType;
  value: string;
}

export interface DataflowNode {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
}

export interface DataflowEdge {
  from: string;
  fromAnchor: string;
  to: string;
  toAnchor: string;
}

export interface DataflowNote {
  id: string;
  x: number;
  y: number;
  text: string;
}

export interface DataflowWorkflow {
  version: number;
  name: string;
  params: DataflowParam[];
  nodes: DataflowNode[];
  edges: DataflowEdge[];
  notes: DataflowNote[];
}

// ===== 流程创建与节点 =====

export function createEmptyWorkflow(name = "新建流程"): DataflowWorkflow {
  return {
    version: WORKFLOW_VERSION,
    name,
    params: [],
    nodes: [],
    edges: [],
    notes: [],
  };
}

/** 生成不与现有节点冲突的节点 id：n1、n2…（同名导入流程用前缀避让）。 */
export function nextNodeId(workflow: Pick<DataflowWorkflow, "nodes">): string {
  const used = new Set(workflow.nodes.map((node) => node.id));
  let index = workflow.nodes.length + 1;
  while (used.has(`n${index}`)) index += 1;
  return `n${index}`;
}

/** 新节点默认名：目录中文名 + 序号（如「Excel 输入 2」），可随时在配置区改。 */
export function defaultNodeName(
  workflow: Pick<DataflowWorkflow, "nodes">,
  type: string,
): string {
  const spec = nodeSpec(type);
  const sameType = workflow.nodes.filter((node) => node.type === type).length;
  return sameType === 0 ? (spec?.cn ?? type) : `${spec?.cn ?? type} ${sameType + 1}`;
}

// ===== 各节点 config 默认值（与引擎契约逐字段一致） =====

export interface SelectFieldConfig {
  source: string;
  keep: boolean;
  rename: string;
}

export interface CleanActionConfig {
  field: string;
  ops: string[];
  replaceFrom: string;
  replaceTo: string;
}

export interface FormulaConfig {
  target: string;
  expression: string;
}

export const FILTER_OPERATORS = [
  { value: "=", label: "等于" },
  { value: "!=", label: "不等于" },
  { value: ">", label: "大于" },
  { value: ">=", label: "大于等于" },
  { value: "<", label: "小于" },
  { value: "<=", label: "小于等于" },
  { value: "contains", label: "包含" },
  { value: "notContains", label: "不包含" },
  { value: "startsWith", label: "开头是" },
  { value: "endsWith", label: "结尾是" },
  { value: "isEmpty", label: "为空" },
  { value: "isNotEmpty", label: "不为空" },
] as const;

export interface FilterRuleConfig {
  field: string;
  operator: string;
  value: string;
}

export interface FilterConditionConfig {
  op: "and" | "or";
  rules: FilterRuleConfig[];
}

// ===== 二期节点 config 类型（契约见 DATAFLOW_NODE_SPECS.md 第八节裁定） =====

export interface JoinKeyPair {
  left: string;
  right: string;
}

export interface SortRuleConfig {
  field: string;
  direction: "asc" | "desc";
  nulls: "first" | "last";
}

/** 聚合函数键名必须与 Rust 引擎 func_display 白名单一致（aggregate.rs）。 */
export type SummarizeFunc =
  | "countAll"
  | "sum"
  | "countNonEmpty"
  | "distinctCount"
  | "avg"
  | "min"
  | "max";

export const SUMMARIZE_FUNCS: { value: SummarizeFunc; label: string }[] = [
  { value: "countAll", label: "总行数" },
  { value: "sum", label: "求和" },
  { value: "countNonEmpty", label: "非空计数" },
  { value: "distinctCount", label: "去重计数" },
  { value: "avg", label: "平均" },
  { value: "min", label: "最小" },
  { value: "max", label: "最大" },
];

/** 透视节点引擎只支持 3 种聚合方式（aggregate.rs run_crosstab 白名单）。 */
export const CROSSTAB_VALUE_FUNCS: { value: SummarizeFunc; label: string }[] = [
  { value: "sum", label: "求和" },
  { value: "countNonEmpty", label: "非空计数" },
  { value: "distinctCount", label: "去重计数" },
];

/** 旧版前端写出的错误键名 → 引擎键名（打开历史流程文件时迁移）。 */
const LEGACY_SUMMARIZE_FUNC_ALIASES: Record<string, SummarizeFunc> = {
  countNotNull: "countNonEmpty",
  countDistinct: "distinctCount",
};

/**
 * 聚合函数键名规整：引擎白名单内的原样返回；旧版前端的 countNotNull /
 * countDistinct 映射为引擎键名；无法识别返回 null（由调用方兜底）。
 */
export function canonicalSummarizeFunc(raw: unknown): SummarizeFunc | null {
  if (typeof raw !== "string") return null;
  const alias = LEGACY_SUMMARIZE_FUNC_ALIASES[raw];
  if (alias) return alias;
  return SUMMARIZE_FUNCS.some((fn) => fn.value === raw) ? (raw as SummarizeFunc) : null;
}

export interface SummarizeAggregation {
  field: string;
  func: SummarizeFunc;
  output: string;
}

export type CheckRuleType = "balance" | "notEmpty" | "unique" | "range" | "expression";

export const CHECK_RULE_TYPES: { value: CheckRuleType; label: string }[] = [
  { value: "balance", label: "借贷平衡" },
  { value: "notEmpty", label: "非空" },
  { value: "unique", label: "唯一" },
  { value: "range", label: "区间" },
  { value: "expression", label: "表达式" },
];

/**
 * 检查规则：type 判别＋各类型自己的字段（序列化时只保留该类型相关字段）。
 * 引擎侧同时兼容 type/kind 两种判别与 groupBy 单字符串/数组（见引擎
 * nodes/check.rs 的规则归一）；本侧打开文件时也兼容 kind 判别形态。
 */
export interface CheckRuleConfig {
  type: CheckRuleType;
  /** balance / unique：分组字段（空＝全表/全表唯一）。 */
  groupBy?: string[];
  /** balance。 */
  debitField?: string;
  creditField?: string;
  tolerance?: number;
  /** notEmpty。 */
  fields?: string[];
  /** unique / range。 */
  field?: string;
  /** range（null＝未设一边）。 */
  min?: number | null;
  max?: number | null;
  /** expression。 */
  expression?: string;
}

export function defaultCheckRule(type: CheckRuleType): CheckRuleConfig {
  switch (type) {
    case "balance":
      return { type, groupBy: [], debitField: "", creditField: "", tolerance: 0 };
    case "notEmpty":
      return { type, fields: [] };
    case "unique":
      return { type, field: "", groupBy: [] };
    case "range":
      return { type, field: "", min: null, max: null };
    case "expression":
      return { type, expression: "" };
  }
}

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/** 小表单元格：数字等原始值转成文本存储（null/undefined → 空串）。 */
const strCell = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
};

const strArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => str(item));
  // 手工编辑的流程文件可能把单值写成字符串：宽容地视为一项。
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
};

const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 规整检查规则：只保留该类型相关字段并纠正类型；无法识别的类型返回 null（丢弃）。 */
export function normalizeCheckRule(raw: unknown): CheckRuleConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  // 判别字段兼容 type（界面序列化）与 kind（手写流程文件/引擎历史形态）。
  const type = typeof item.type === "string" && item.type ? item.type : item.kind;
  switch (type) {
    case "balance":
      return {
        type,
        groupBy: strArray(item.groupBy),
        debitField: str(item.debitField),
        creditField: str(item.creditField),
        tolerance: numOrNull(item.tolerance) ?? 0,
      };
    case "notEmpty":
      return { type, fields: strArray(item.fields) };
    case "unique":
      return { type, field: str(item.field), groupBy: strArray(item.groupBy) };
    case "range":
      return { type, field: str(item.field), min: numOrNull(item.min), max: numOrNull(item.max) };
    case "expression":
      return { type, expression: str(item.expression) };
    default:
      return null;
  }
}

export interface ManualColumnConfig {
  name: string;
  type: "text" | "int" | "decimal" | "date";
}

export const MANUAL_COLUMN_TYPES: { value: ManualColumnConfig["type"]; label: string }[] = [
  { value: "text", label: "文本" },
  { value: "int", label: "整数" },
  { value: "decimal", label: "十进制小数" },
  { value: "date", label: "日期" },
];

/** 每种节点的默认 config。字段与 Rust 侧契约必须完全一致（camelCase）。 */
export function defaultConfigFor(type: string): Record<string, unknown> {
  switch (type) {
    case "excel_in":
      return {
        sourceType: "file",
        path: "",
        filePattern: "*.xlsx;*.xls;*.csv",
        sheetMode: "firstData",
        sheetName: "",
        headerRow: 1,
        dataStartRow: 2,
        attachSourceColumns: true,
        onRowError: "stop",
        columnTypes: {},
      };
    case "csv_in":
      return {
        sourceType: "file",
        path: "",
        encoding: "auto",
        delimiter: "auto",
        headerRow: 1,
        attachSourceColumns: true,
        onRowError: "stop",
        columnTypes: {},
      };
    case "select_n":
      return {
        fields: [] as SelectFieldConfig[],
        passThroughNewFields: true,
      };
    case "clean":
      return {
        actions: [] as CleanActionConfig[],
        dropBlankRows: true,
        nullTextToNull: true,
      };
    case "formula":
      return {
        formulas: [] as FormulaConfig[],
      };
    case "filter_n":
      return {
        condition: {
          op: "and",
          rules: [{ field: "", operator: "=", value: "" }],
        } satisfies FilterConditionConfig,
      };
    case "excel_out":
      return {
        fileName: "",
        sheetName: "",
        overwrite: "error",
        splitMode: "sheet",
      };
    case "csv_out":
      return {
        fileName: "",
        encoding: "gbk",
        delimiter: "comma",
        splitRows: 0,
      };
    // —— 二期补齐节点（默认值＝DATAFLOW_NODE_SPECS.md 第八节裁定）——
    case "join_n":
      return {
        keys: [{ left: "", right: "" }] as JoinKeyPair[],
        leftFields: [] as string[],
        rightFields: [] as string[],
        sameNameSuffix: "_右",
      };
    case "union_n":
      return {
        align: "byName",
        extraFieldPolicy: "keep",
        typeConflictPolicy: "text",
        order: [] as string[],
      };
    case "unique_n":
      return {
        fields: [] as string[],
        keep: "first",
      };
    case "sort_n":
      return {
        rules: [{ field: "", direction: "asc", nulls: "last" }] as SortRuleConfig[],
      };
    case "summarize":
      return {
        groupBy: [] as string[],
        aggregations: [{ field: "", func: "countAll", output: "" }] as SummarizeAggregation[],
      };
    case "crosstab":
      return {
        rowField: "",
        columnField: "",
        valueField: "",
        valueFunc: "sum",
        fill: 0,
      };
    case "transpose":
      return {
        fixedFields: [] as string[],
        valueColumns: [] as string[],
        nameColumn: "项目",
        valueColumn: "数值",
      };
    case "split":
      return {
        field: "",
        mode: "delimiter",
        delimiter: "",
        widths: [] as number[],
        keepOriginal: false,
        columnPrefix: "",
      };
    case "check_n":
      return {
        rules: [] as CheckRuleConfig[],
      };
    case "manual_in":
      return {
        columns: [{ name: "列名", type: "text" }] as ManualColumnConfig[],
        rows: [[""]] as string[][],
        onRowError: "stop",
      };
    case "db_in":
      return {
        path: "",
        table: "",
        fields: [] as string[],
        onRowError: "stop",
      };
    case "parquet_in":
      return {
        path: "",
        fields: [] as string[],
      };
    default:
      // 尚未定契约的节点保持空对象占位，不进入流程文件。
      return {};
  }
}

const CONFIG_FIELDS_BY_TYPE: Record<string, string[]> = {
  excel_in: [
    "sourceType", "path", "filePattern", "sheetMode", "sheetName", "headerRow",
    "dataStartRow", "attachSourceColumns", "onRowError", "columnTypes",
  ],
  csv_in: [
    "sourceType", "path", "encoding", "delimiter", "headerRow",
    "attachSourceColumns", "onRowError", "columnTypes",
  ],
  select_n: ["fields", "passThroughNewFields"],
  clean: ["actions", "dropBlankRows", "nullTextToNull"],
  formula: ["formulas"],
  filter_n: ["condition"],
  excel_out: ["fileName", "sheetName", "overwrite", "splitMode"],
  csv_out: ["fileName", "encoding", "delimiter", "splitRows"],
  join_n: ["keys", "leftFields", "rightFields", "sameNameSuffix"],
  union_n: ["align", "extraFieldPolicy", "typeConflictPolicy", "order"],
  unique_n: ["fields", "keep"],
  sort_n: ["rules"],
  summarize: ["groupBy", "aggregations"],
  crosstab: ["rowField", "columnField", "valueField", "valueFunc", "fill"],
  transpose: ["fixedFields", "valueColumns", "nameColumn", "valueColumn"],
  split: ["field", "mode", "delimiter", "widths", "keepOriginal", "columnPrefix"],
  check_n: ["rules"],
  manual_in: ["columns", "rows", "onRowError"],
  db_in: ["path", "table", "fields", "onRowError"],
  parquet_in: ["path", "fields"],
};

/**
 * 规整节点 config：按默认值补齐缺失字段并纠正基本类型
 * （打开旧文件、粘贴部分配置时兜底）。未知字段保留，便于后续版本升级。
 */
export function normalizeConfig(
  type: string,
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const defaults = defaultConfigFor(type);
  const merged: Record<string, unknown> = { ...defaults, ...(raw ?? {}) };
  const coerced: Record<string, unknown> = { ...merged };
  const numeric = new Set(["headerRow", "dataStartRow", "splitRows"]);
  for (const key of numeric) {
    if (key in coerced) {
      const value = Number(coerced[key]);
      coerced[key] = Number.isFinite(value) ? Math.trunc(value) : defaults[key];
    }
  }
  const booleans = new Set(["attachSourceColumns", "passThroughNewFields", "dropBlankRows", "nullTextToNull", "keepOriginal"]);
  for (const key of booleans) {
    if (key in coerced) coerced[key] = coerced[key] === true;
  }
  if (type === "excel_in" || type === "csv_in") {
    if (typeof coerced.columnTypes !== "object" || coerced.columnTypes === null || Array.isArray(coerced.columnTypes)) {
      coerced.columnTypes = {};
    }
  }
  if (type === "select_n" && !Array.isArray(coerced.fields)) coerced.fields = [];
  if (type === "clean" && !Array.isArray(coerced.actions)) coerced.actions = [];
  if (type === "formula" && !Array.isArray(coerced.formulas)) coerced.formulas = [];
  if (type === "filter_n") {
    const condition = coerced.condition;
    if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
      coerced.condition = defaults.condition;
    } else {
      const op = (condition as { op?: unknown }).op === "or" ? "or" : "and";
      const rules = Array.isArray((condition as { rules?: unknown }).rules)
        ? (condition as { rules: unknown[] }).rules
        : [];
      coerced.condition = {
        op,
        rules: rules.map((rule) => {
          const item = (rule ?? {}) as Record<string, unknown>;
          return {
            field: typeof item.field === "string" ? item.field : "",
            operator: typeof item.operator === "string" ? item.operator : "=",
            value: typeof item.value === "string" ? item.value : String(item.value ?? ""),
          };
        }),
      };
    }
  }
  // —— 二期补齐节点的数组/枚举/嵌套结构规整 ——
  if (type === "join_n") {
    coerced.keys = Array.isArray(coerced.keys)
      ? (coerced.keys as unknown[]).map((item) => {
          const pair = (item ?? {}) as Record<string, unknown>;
          return { left: str(pair.left), right: str(pair.right) };
        })
      : (defaults.keys as JoinKeyPair[]);
    coerced.leftFields = strArray(coerced.leftFields);
    coerced.rightFields = strArray(coerced.rightFields);
    if (typeof coerced.sameNameSuffix !== "string") {
      coerced.sameNameSuffix = defaults.sameNameSuffix;
    }
  }
  if (type === "union_n") {
    if (coerced.align !== "byName" && coerced.align !== "byPosition") coerced.align = defaults.align;
    if (coerced.extraFieldPolicy !== "keep" && coerced.extraFieldPolicy !== "drop") {
      coerced.extraFieldPolicy = defaults.extraFieldPolicy;
    }
    if (coerced.typeConflictPolicy !== "text" && coerced.typeConflictPolicy !== "stop") {
      coerced.typeConflictPolicy = defaults.typeConflictPolicy;
    }
    coerced.order = strArray(coerced.order);
  }
  if (type === "unique_n") {
    coerced.fields = strArray(coerced.fields);
    if (coerced.keep !== "first" && coerced.keep !== "last") coerced.keep = defaults.keep;
  }
  if (type === "sort_n") {
    coerced.rules = Array.isArray(coerced.rules)
      ? (coerced.rules as unknown[]).map((item) => {
          const rule = (item ?? {}) as Record<string, unknown>;
          return {
            field: str(rule.field),
            direction: rule.direction === "desc" ? ("desc" as const) : ("asc" as const),
            nulls: rule.nulls === "first" ? ("first" as const) : ("last" as const),
          };
        })
      : (defaults.rules as SortRuleConfig[]);
  }
  if (type === "summarize") {
    coerced.groupBy = strArray(coerced.groupBy);
    coerced.aggregations = Array.isArray(coerced.aggregations)
      ? (coerced.aggregations as unknown[]).map((item) => {
          const agg = (item ?? {}) as Record<string, unknown>;
          return {
            field: str(agg.field),
            // 旧版前端键名（countNotNull/countDistinct）在此迁移为引擎键名。
            func: (canonicalSummarizeFunc(agg.func) ?? "countAll") as SummarizeFunc,
            output: str(agg.output),
          };
        })
      : (defaults.aggregations as SummarizeAggregation[]);
  }
  if (type === "crosstab") {
    if (coerced.fill === null) coerced.fill = null;
    else if (typeof coerced.fill === "number" && Number.isFinite(coerced.fill)) {
      // 保留数值（含 0）。
    } else coerced.fill = defaults.fill;
    for (const key of ["rowField", "columnField", "valueField"]) {
      if (typeof coerced[key] !== "string") coerced[key] = "";
    }
    // 聚合方式先迁移旧键名，再按透视白名单（sum/countNonEmpty/distinctCount，
    // 引擎 run_crosstab 仅支持这 3 项）校验；不合法回落默认「求和」。
    const valueFunc = canonicalSummarizeFunc(coerced.valueFunc);
    if (!CROSSTAB_VALUE_FUNCS.some((fn) => fn.value === valueFunc)) {
      coerced.valueFunc = defaults.valueFunc;
    } else {
      coerced.valueFunc = valueFunc;
    }
  }
  if (type === "transpose") {
    coerced.fixedFields = strArray(coerced.fixedFields);
    coerced.valueColumns = strArray(coerced.valueColumns);
    if (typeof coerced.nameColumn !== "string" || !coerced.nameColumn) {
      coerced.nameColumn = defaults.nameColumn;
    }
    if (typeof coerced.valueColumn !== "string" || !coerced.valueColumn) {
      coerced.valueColumn = defaults.valueColumn;
    }
  }
  if (type === "split") {
    // 拆分方式与引擎契约对齐（split.rs 只认 delimiter / fixedWidth）；
    // 旧流程文件曾用 "width"，此处统一迁移为 fixedWidth，避免打开时退化为分隔符模式。
    if (coerced.mode === "width") coerced.mode = "fixedWidth";
    if (coerced.mode !== "delimiter" && coerced.mode !== "fixedWidth") coerced.mode = defaults.mode;
    coerced.widths = Array.isArray(coerced.widths)
      ? (coerced.widths as unknown[])
          .map((width) => Math.trunc(Number(width)))
          .filter((width) => Number.isFinite(width) && width > 0)
      : [];
    for (const key of ["field", "delimiter", "columnPrefix"]) {
      if (typeof coerced[key] !== "string") coerced[key] = "";
    }
  }
  if (type === "check_n") {
    const rules = Array.isArray(coerced.rules) ? (coerced.rules as unknown[]) : [];
    coerced.rules = rules
      .map((rule) => normalizeCheckRule(rule))
      .filter((rule): rule is CheckRuleConfig => rule !== null);
  }
  if (type === "manual_in") {
    const columnTypes = new Set(MANUAL_COLUMN_TYPES.map((item) => item.value));
    const columns = Array.isArray(coerced.columns) ? (coerced.columns as unknown[]) : [];
    coerced.columns = columns.map((item) => {
      const column = (item ?? {}) as Record<string, unknown>;
      return {
        name: str(column.name),
        type: (columnTypes.has(column.type as ManualColumnConfig["type"])
          ? column.type
          : "text") as ManualColumnConfig["type"],
      };
    });
    const rows = Array.isArray(coerced.rows) ? (coerced.rows as unknown[]) : [];
    coerced.rows = rows.map((row) =>
      Array.isArray(row) ? row.map((cell) => strCell(cell)) : [],
    );
    if (coerced.onRowError !== "stop" && coerced.onRowError !== "skip") {
      coerced.onRowError = "stop";
    }
  }
  if (type === "db_in") {
    for (const key of ["path", "table"]) {
      if (typeof coerced[key] !== "string") coerced[key] = "";
    }
    coerced.fields = strArray(coerced.fields);
    if (coerced.onRowError !== "stop" && coerced.onRowError !== "skip") {
      coerced.onRowError = "stop";
    }
  }
  if (type === "parquet_in") {
    if (typeof coerced.path !== "string") coerced.path = "";
    coerced.fields = strArray(coerced.fields);
  }
  return coerced;
}

/** config 是否只含契约内字段（保存前自检，防未知字段混入第一期契约）。 */
export function configKeysWithinContract(type: string, config: Record<string, unknown>): boolean {
  const allowed = CONFIG_FIELDS_BY_TYPE[type];
  if (!allowed) return Object.keys(config).length === 0;
  return Object.keys(config).every((key) => allowed.includes(key));
}

// ===== 序列化 / 解析 =====

const WORKFLOW_KEYS_ORDER: (keyof DataflowWorkflow)[] = [
  "version", "name", "params", "nodes", "edges", "notes",
];

/** 保存为流程 JSON 文本（固定键序，便于 diff 与人工核对）。 */
export function serializeWorkflow(workflow: DataflowWorkflow): string {
  const ordered: Record<string, unknown> = {};
  for (const key of WORKFLOW_KEYS_ORDER) ordered[key] = workflow[key];
  return JSON.stringify(ordered, null, 2);
}

export type ParseWorkflowResult =
  | { ok: true; workflow: DataflowWorkflow }
  | { ok: false; error: string };

/**
 * 组装运行请求体：工作流本体平铺＋runMode＋paramOverrides；
 * 「运行到选中节点」时附 uptoNodeId（与 paramOverrides 平级），
 * 引擎只执行到该节点（含其全部上游）为止。
 */
export function dataflowRunRequest(
  workflow: unknown,
  runMode: "preview" | "full",
  paramOverrides: Record<string, string>,
  uptoNodeId?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...(workflow as Record<string, unknown>),
    runMode,
    paramOverrides,
  };
  if (uptoNodeId) payload.uptoNodeId = uptoNodeId;
  return payload;
}

/** 解析流程文件文本。版本不识别时明确报错，绝不静默打开。 */
export function parseWorkflowFile(text: string): ParseWorkflowResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "流程文件不是有效的 JSON，无法打开。" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "流程文件结构不正确，无法打开。" };
  }
  const value = raw as Record<string, unknown>;
  const version = value.version;
  if (version !== WORKFLOW_VERSION) {
    return {
      ok: false,
      error: `流程文件版本为 ${String(version)}，当前工具支持版本 ${WORKFLOW_VERSION}，请升级工具后重试。`,
    };
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return { ok: false, error: "流程文件缺少节点或连线数据，无法打开。" };
  }
  const params = Array.isArray(value.params)
    ? value.params.map((item) => {
        const param = (item ?? {}) as Record<string, unknown>;
        return {
          id: typeof param.id === "string" ? param.id : "",
          name: typeof param.name === "string" ? param.name : "",
          type: (DATAFLOW_PARAM_TYPES.some((t) => t.value === param.type)
            ? param.type
            : "text") as DataflowParamType,
          value: typeof param.value === "string" ? param.value : "",
        };
      })
    : [];
  const nodes = value.nodes.map((item) => {
    const node = (item ?? {}) as Record<string, unknown>;
    const type = typeof node.type === "string" ? node.type : "";
    return {
      id: typeof node.id === "string" ? node.id : "",
      type,
      name: typeof node.name === "string" ? node.name : (nodeSpec(type)?.cn ?? type),
      x: Number.isFinite(Number(node.x)) ? Number(node.x) : 0,
      y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0,
      config: normalizeConfig(
        type,
        typeof node.config === "object" && node.config !== null
          ? (node.config as Record<string, unknown>)
          : undefined,
      ),
    };
  });
  const edges = value.edges
    .map((item) => {
      const edge = (item ?? {}) as Record<string, unknown>;
      return {
        from: typeof edge.from === "string" ? edge.from : "",
        fromAnchor: typeof edge.fromAnchor === "string" ? edge.fromAnchor : "",
        to: typeof edge.to === "string" ? edge.to : "",
        toAnchor: typeof edge.toAnchor === "string" ? edge.toAnchor : "",
      };
    })
    .filter((edge) => edge.from && edge.to);
  const notes = Array.isArray(value.notes)
    ? value.notes.map((item) => {
        const note = (item ?? {}) as Record<string, unknown>;
        return {
          id: typeof note.id === "string" ? note.id : "",
          x: Number.isFinite(Number(note.x)) ? Number(note.x) : 0,
          y: Number.isFinite(Number(note.y)) ? Number(note.y) : 0,
          text: typeof note.text === "string" ? note.text : "",
        };
      })
    : [];
  return {
    ok: true,
    workflow: {
      version: WORKFLOW_VERSION,
      name: typeof value.name === "string" && value.name ? value.name : "未命名流程",
      params,
      nodes,
      edges,
      notes,
    },
  };
}

// ===== 连线校验 =====

export type EdgeCheckResult =
  | { ok: true; edge: DataflowEdge }
  | { ok: false; reason: string };

/**
 * 修正跨版本流程里的过期锚点名：旧版搭的流程（草稿/流程文件）可能带着
 * 上游节点已不存在的出口名（如筛选节点上旧的 output），画布按第一出口
 * 画线看不出异常，运行时引擎才报「该锚点不存在」。恢复/打开/运行前统一
 * 把无效出口改接到上游第一个出口，并返回修正说明供状态栏提示。
 */
export function repairWorkflowEdges(
  workflow: DataflowWorkflow,
): { workflow: DataflowWorkflow; fixes: string[] } {
  const fixes: string[] = [];
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const edges = workflow.edges.map((edge) => {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    let next = edge;
    const fromSpec = from ? nodeSpec(from.type) : undefined;
    if (from && fromSpec?.outputs.length && !fromSpec.outputs.some((a) => a.key === next.fromAnchor)) {
      const target = fromSpec.outputs[0];
      fixes.push(
        `「${from.name}」到「${to?.name ?? edge.to}」的连线出口「${next.fromAnchor}」已不存在，已改接「${target.label}」。`,
      );
      next = { ...next, fromAnchor: target.key };
    }
    const toSpec = to ? nodeSpec(to.type) : undefined;
    if (to && toSpec?.inputs.length && !toSpec.inputs.some((a) => a.key === next.toAnchor)) {
      const target = toSpec.inputs[0];
      fixes.push(`「${to.name}」的输入口「${next.toAnchor}」已不存在，已改接「${target.label}」。`);
      next = { ...next, toAnchor: target.key };
    }
    return next;
  });
  return { workflow: fixes.length ? { ...workflow, edges } : workflow, fixes };
}

/**
 * 校验一条新连线：锚点存在、禁自环、禁重复、禁成环、
 * 单输入口（除 Excel 输出/纵向合并等多入口）不重复占用。
 */
export function validateNewEdge(
  workflow: Pick<DataflowWorkflow, "nodes" | "edges">,
  candidate: DataflowEdge,
): EdgeCheckResult {
  const { from, fromAnchor, to, toAnchor } = candidate;
  const fromNode = workflow.nodes.find((node) => node.id === from);
  const toNode = workflow.nodes.find((node) => node.id === to);
  if (!fromNode) return { ok: false, reason: "连线的起点节点不存在。" };
  if (!toNode) return { ok: false, reason: "连线的终点节点不存在。" };
  const fromSpec = nodeSpec(fromNode.type);
  const toSpec = nodeSpec(toNode.type);
  if (!fromSpec?.outputs.some((anchor) => anchor.key === fromAnchor)) {
    return { ok: false, reason: "起点节点没有这个输出口。" };
  }
  if (!toSpec?.inputs.some((anchor) => anchor.key === toAnchor)) {
    return { ok: false, reason: "终点节点没有这个输入口。" };
  }
  if (from === to) {
    return { ok: false, reason: "不能把节点连到自己（自环）。" };
  }
  const duplicate = workflow.edges.some(
    (edge) =>
      edge.from === from &&
      edge.fromAnchor === fromAnchor &&
      edge.to === to &&
      edge.toAnchor === toAnchor,
  );
  if (duplicate) return { ok: false, reason: "这条连线已经存在，不能重复连接。" };
  const anchorTaken =
    !anchorAcceptsMultiple(toNode.type, toAnchor) &&
    workflow.edges.some((edge) => edge.to === to && edge.toAnchor === toAnchor);
  if (anchorTaken) {
    return { ok: false, reason: "该输入口已有连线，不能重复接入。" };
  }
  if (wouldCreateCycle(workflow, from, to)) {
    return { ok: false, reason: "这条连线会形成环路，数据流不能绕回。" };
  }
  return { ok: true, edge: candidate };
}

/** 深度优先判断 from→to 是否会让 to 的后代回到 from（成环）。 */
export function wouldCreateCycle(
  workflow: Pick<DataflowWorkflow, "edges">,
  from: string,
  to: string,
): boolean {
  // 加边 from→to 之前，若从 to 出发沿现有边能回到 from，则成环。
  const downstream = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const list = downstream.get(edge.from) ?? [];
    list.push(edge.to);
    downstream.set(edge.from, list);
  }
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const current = stack.pop() as string;
    if (current === from) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of downstream.get(current) ?? []) stack.push(next);
  }
  return false;
}

/** 拓扑序（无依赖的排最前；有环时剩余节点按原顺序兜底 appended）。 */
export function topoOrder(workflow: Pick<DataflowWorkflow, "nodes" | "edges">): string[] {
  const indegree = new Map<string, number>();
  for (const node of workflow.nodes) indegree.set(node.id, 0);
  for (const edge of workflow.edges) {
    if (indegree.has(edge.to)) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = workflow.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    order.push(id);
    for (const edge of workflow.edges) {
      if (edge.from !== id) continue;
      const next = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, next);
      if (next === 0) queue.push(edge.to);
    }
  }
  for (const node of workflow.nodes) {
    if (!order.includes(node.id)) order.push(node.id);
  }
  return order;
}

// ===== 参数占位替换 =====

/** 参数 id → 生效值（覆盖优先，其次定义默认值）。 */
export function effectiveParams(
  params: DataflowParam[],
  overrides: Record<string, string> = {},
): Map<string, string> {
  const map = new Map<string, string>();
  for (const param of params) map.set(param.id, overrides[param.id] ?? param.value);
  return map;
}

/**
 * 替换文本中的 {参数id} 占位（也兼容 {参数名}）。
 * 路径、输出 fileName 均支持；未定义的占位保持原样，便于发现拼写问题。
 */
export function applyParamPlaceholders(
  text: string,
  params: DataflowParam[],
  overrides: Record<string, string> = {},
): string {
  const byId = effectiveParams(params, overrides);
  const byName = new Map<string, string>();
  for (const param of params) {
    const value = byId.get(param.id) ?? param.value;
    if (param.name && !byName.has(param.name)) byName.set(param.name, value);
  }
  return text.replace(/\{([^{}]+)\}/g, (whole, key: string) => {
    const trimmed = key.trim();
    if (byId.has(trimmed)) return byId.get(trimmed) as string;
    if (byName.has(trimmed)) return byName.get(trimmed) as string;
    return whole;
  });
}

// ===== 草稿（localStorage，键含流程名） =====

const DRAFT_PREFIX = "audit-toolbox:dataflow:draft:";

export interface DataflowDraft {
  name: string;
  savedAt: string;
  workflow: DataflowWorkflow;
}

function draftKey(name: string): string {
  return `${DRAFT_PREFIX}${name}`;
}

export function saveDraft(workflow: DataflowWorkflow): boolean {
  // 空流程不落草稿：没有恢复价值，且会按时间排在最前，
  // 把含节点的草稿顶出自动恢复位（页面切换后画布靠草稿兜底）。
  if (!workflow.nodes.length) return false;
  try {
    const payload = JSON.stringify({
      name: workflow.name,
      savedAt: new Date().toISOString(),
      workflow,
    });
    window.localStorage.setItem(draftKey(workflow.name), payload);
    return true;
  } catch {
    return false;
  }
}

export function listDrafts(): DataflowDraft[] {
  const drafts: DataflowDraft[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith(DRAFT_PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { name?: string; savedAt?: string; workflow?: unknown };
        const workflow = parseWorkflowFile(JSON.stringify(parsed.workflow ?? {}));
        if (!workflow.ok) continue;
        drafts.push({
          name: parsed.name ?? workflow.workflow.name,
          savedAt: parsed.savedAt ?? "",
          workflow: workflow.workflow,
        });
      } catch {
        // 单条草稿损坏时跳过，不影响其余草稿。
      }
    }
  } catch {
    return drafts;
  }
  return drafts.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

export function removeDraft(name: string): void {
  try {
    window.localStorage.removeItem(draftKey(name));
  } catch {
    // 忽略：草稿清理失败不影响主流程。
  }
}

// ===== 撤销 / 重做（简单操作栈） =====

/** 每次修改前把「修改前」的快照压栈；undo/redo 在 past/future 间移动。 */
export class WorkflowHistory {
  private past: DataflowWorkflow[] = [];
  private future: DataflowWorkflow[] = [];

  constructor(private readonly limit = 100) {}

  /** 修改发生前调用：记录当前状态。 */
  snapshot(current: DataflowWorkflow): void {
    this.past.push(current);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: DataflowWorkflow): DataflowWorkflow | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(current);
    return previous;
  }

  redo(current: DataflowWorkflow): DataflowWorkflow | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  reset(): void {
    this.past = [];
    this.future = [];
  }
}

// ===== 引擎返回结果（zod 校验，与响应契约一致） =====

export const DataflowAnchorResultSchema = z.object({
  columns: z.array(z.string()),
  types: z.array(z.string()).catch([]),
  rowCount: z.number(),
  sample: z
    .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .catch([]),
});

export const DataflowNodeResultSchema = z.object({
  status: z.enum(["ok", "warn", "error"]),
  rows: z.number(),
  ms: z.number(),
  messages: z.array(z.string()).catch([]),
  stats: z.array(z.string()).catch([]),
  anchors: z.record(z.string(), DataflowAnchorResultSchema).catch({}),
});

export const DataflowRunResultSchema = z.object({
  mode: z.enum(["preview", "full"]),
  nodes: z.record(z.string(), DataflowNodeResultSchema),
  outputs: z
    .array(
      z.object({
        nodeId: z.string(),
        path: z.string(),
        sheet: z.string().catch(""),
        rows: z.number(),
      }),
    )
    .catch([]),
  error: z.unknown().nullable().default(null),
});

export type DataflowAnchorResult = z.infer<typeof DataflowAnchorResultSchema>;
export type DataflowNodeResult = z.infer<typeof DataflowNodeResultSchema>;
export type DataflowRunResult = z.infer<typeof DataflowRunResultSchema>;
