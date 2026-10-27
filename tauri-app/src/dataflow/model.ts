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
    default:
      // 二期节点尚未定契约，先给空对象占位，不进入第一期流程文件。
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
  const booleans = new Set(["attachSourceColumns", "passThroughNewFields", "dropBlankRows", "nullTextToNull"]);
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
