/**
 * 数据流 DataFlow 节点目录。
 *
 * 全部 20 个首版设计节点（DATAFLOW_DESIGN.md 第 4 节）都在这里登记，
 * 第一期 8 个＋二期补齐的 12 个均已可拖入画布（phase2 = false）；
 * phase2 字段保留给后续候选节点置灰用。节点命名规范「中文＋英文」；
 * 锚点：输入口在节点左侧、输出口在右侧，多路输出垂直排列
 * （筛选 T/F、去重 U/D、关联 J/L/R、检查 P/NG），分支节点的多路输出必须保留。
 */

export type DataflowCategory =
  | "input"
  | "transform"
  | "filtersort"
  | "join"
  | "aggregate"
  | "check"
  | "output";

export interface DataflowCategorySpec {
  id: DataflowCategory;
  cn: string;
}

export interface DataflowAnchorSpec {
  /** 锚点键，进入流程 JSON 的 fromAnchor / toAnchor。 */
  key: string;
  /** 画布上锚点旁的短标签（多路输出时显示）。 */
  label: string;
}

export interface DataflowNodeSpec {
  type: string;
  cn: string;
  en: string;
  category: DataflowCategory;
  /** true = 二期节点，工具栏置灰不可加入画布。 */
  phase2: boolean;
  /** lucide-react 图标键（iconMap 渲染）。 */
  icon: string;
  inputs: DataflowAnchorSpec[];
  outputs: DataflowAnchorSpec[];
  /** 允许多条上游连线进入的输入锚点键（如 Excel 输出的 in、纵向合并的 in）。 */
  multiInputKeys?: string[];
}

/** 工具栏 7 个分类，顺序固定：输入/整理/筛选排序/关联合并/汇总变形/校验/输出。 */
export const DATAFLOW_CATEGORIES: DataflowCategorySpec[] = [
  { id: "input", cn: "输入" },
  { id: "transform", cn: "整理" },
  { id: "filtersort", cn: "筛选排序" },
  { id: "join", cn: "关联合并" },
  { id: "aggregate", cn: "汇总变形" },
  { id: "check", cn: "校验" },
  { id: "output", cn: "输出" },
];

const SINGLE_IN: DataflowAnchorSpec[] = [{ key: "in", label: "输入" }];
const SINGLE_OUT: DataflowAnchorSpec[] = [{ key: "out", label: "数据" }];

/** 当前可用节点的 type 集合（第一期 8 个＋二期补齐 12 个，与 Rust 引擎契约一致）。 */
export const DATAFLOW_AVAILABLE_TYPES = [
  "excel_in",
  "csv_in",
  "select_n",
  "clean",
  "formula",
  "filter_n",
  "excel_out",
  "csv_out",
  "join_n",
  "union_n",
  "unique_n",
  "sort_n",
  "summarize",
  "crosstab",
  "transpose",
  "split",
  "check_n",
  "manual_in",
  "db_in",
  "parquet_in",
] as const;

export type DataflowAvailableType = (typeof DATAFLOW_AVAILABLE_TYPES)[number];

export const DATAFLOW_NODE_SPECS: DataflowNodeSpec[] = [
  // —— 输入类（5 个）——
  {
    type: "excel_in",
    cn: "Excel 输入",
    en: "Input",
    category: "input",
    phase2: false,
    icon: "fileSpreadsheet",
    inputs: [],
    outputs: SINGLE_OUT,
  },
  {
    type: "csv_in",
    cn: "CSV/文本输入",
    en: "Input",
    category: "input",
    phase2: false,
    icon: "fileText",
    inputs: [],
    outputs: SINGLE_OUT,
  },
  {
    type: "db_in",
    cn: "数据库文件输入",
    en: "Input",
    category: "input",
    phase2: false,
    icon: "database",
    inputs: [],
    outputs: SINGLE_OUT,
  },
  {
    type: "parquet_in",
    cn: "Parquet 输入",
    en: "Input",
    category: "input",
    phase2: false,
    icon: "database",
    inputs: [],
    outputs: SINGLE_OUT,
  },
  {
    type: "manual_in",
    cn: "手工输入",
    en: "Input",
    category: "input",
    phase2: false,
    icon: "table",
    inputs: [],
    outputs: SINGLE_OUT,
  },
  // —— 整理类（4 个）——
  {
    type: "select_n",
    cn: "字段选择",
    en: "Select",
    category: "transform",
    phase2: false,
    icon: "listChecks",
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  {
    type: "formula",
    cn: "公式",
    en: "Formula",
    category: "transform",
    phase2: false,
    icon: "sigma",
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  {
    type: "clean",
    cn: "字段清洗",
    en: "Clean",
    category: "transform",
    phase2: false,
    icon: "brush",
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  {
    type: "split",
    cn: "分列",
    en: "Split",
    category: "transform",
    phase2: false,
    icon: "columns",
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  // —— 筛选排序类（3 个）——
  {
    type: "filter_n",
    cn: "筛选",
    en: "Filter",
    category: "filtersort",
    phase2: false,
    icon: "filter",
    inputs: SINGLE_IN,
    outputs: [
      { key: "T", label: "T 符合" },
      { key: "F", label: "F 不符合" },
    ],
  },
  {
    type: "sort_n",
    cn: "排序",
    en: "Sort",
    category: "filtersort",
    phase2: false,
    icon: "arrowDownUp",
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  {
    type: "unique_n",
    cn: "去重",
    en: "Unique",
    category: "filtersort",
    phase2: false,
    icon: "copy",
    inputs: SINGLE_IN,
    outputs: [
      { key: "U", label: "U 保留" },
      { key: "D", label: "D 重复" },
    ],
  },
  // —— 关联合并类（2 个）——
  {
    type: "join_n",
    cn: "关联",
    en: "Join",
    category: "join",
    phase2: false,
    icon: "link",
    inputs: [
      { key: "inL", label: "左表" },
      { key: "inR", label: "右表" },
    ],
    outputs: [
      { key: "J", label: "J 匹配" },
      { key: "L", label: "L 左未匹配" },
      { key: "R", label: "R 右未匹配" },
    ],
  },
  {
    type: "union_n",
    cn: "纵向合并",
    en: "Union",
    category: "join",
    phase2: false,
    icon: "rows3",
    inputs: [{ key: "in", label: "输入（可多条）" }],
    outputs: SINGLE_OUT,
    multiInputKeys: ["in"],
  },
  // —— 汇总变形类（3 个）——
  {
    type: "summarize",
    cn: "汇总",
    en: "Summarize",
    category: "aggregate",
    phase2: false,
    icon: "sigma",
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  {
    type: "crosstab",
    cn: "透视",
    en: "Crosstab",
    category: "aggregate",
    phase2: false,
    icon: "grid3x3",
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  {
    type: "transpose",
    cn: "宽转长",
    en: "Transpose",
    category: "aggregate",
    phase2: false,
    icon: "flipHorizontal",
    inputs: SINGLE_IN,
    outputs: SINGLE_OUT,
  },
  // —— 校验类（1 个）——
  {
    type: "check_n",
    cn: "检查",
    en: "Check",
    category: "check",
    phase2: false,
    icon: "flag",
    inputs: SINGLE_IN,
    outputs: [
      { key: "P", label: "P 通过" },
      { key: "NG", label: "NG 未通过" },
    ],
  },
  // —— 输出类（2 个）——
  {
    type: "excel_out",
    cn: "Excel 输出",
    en: "Output",
    category: "output",
    phase2: false,
    icon: "save",
    inputs: SINGLE_IN,
    outputs: [],
    multiInputKeys: ["in"],
  },
  {
    type: "csv_out",
    cn: "CSV 输出",
    en: "Output",
    category: "output",
    phase2: false,
    icon: "save",
    inputs: SINGLE_IN,
    outputs: [],
  },
];

const SPEC_BY_TYPE = new Map(DATAFLOW_NODE_SPECS.map((spec) => [spec.type, spec]));

export function nodeSpec(type: string): DataflowNodeSpec | undefined {
  return SPEC_BY_TYPE.get(type);
}

export function categoryNodes(category: DataflowCategory): DataflowNodeSpec[] {
  return DATAFLOW_NODE_SPECS.filter((spec) => spec.category === category);
}

export function categoryCn(category: DataflowCategory): string {
  return DATAFLOW_CATEGORIES.find((item) => item.id === category)?.cn ?? category;
}

/** 节点锚点（键）是否允许接受多条上游连线。 */
export function anchorAcceptsMultiple(type: string, anchorKey: string): boolean {
  const spec = nodeSpec(type);
  return Boolean(spec?.multiInputKeys?.includes(anchorKey));
}
