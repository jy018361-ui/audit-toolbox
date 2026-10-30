/**
 * 浏览器预览模式的数据流演示引擎。
 *
 * npm run dev（无 Tauri）时 dataflowPreview / dataflowRun 返回这里的内置
 * 中文审计示例数据，让画布状态色、结果区分页表格、参数替换、输出清单等
 * 全部界面状态可以离线体验。演示数据参考交互原型的序时账清洗合并场景。
 */
import {
  applyParamPlaceholders,
  parseWorkflowFile,
  topoOrder,
  type DataflowRunResult,
  type DataflowWorkflow,
} from "./model";

type Cell = string | number | boolean | null;

interface AnchorData {
  columns: string[];
  types: string[];
  rowCount: number;
  sample: Cell[][];
}

/** 序时账原始表（Excel 输入节点用）。 */
const JOURNAL_COLUMNS = [
  "来源文件", "凭证日期", "凭证号", "摘要", "科目编码", "借方", "贷方", "客商名称",
];
const JOURNAL_ROWS: Cell[][] = [
  ["2026-01.xlsx", "2026-01-03", "记-0012", "支付货款", "22020105", 86400, null, "汇金贸易有限公司"],
  ["2026-01.xlsx", "2026-01-05", "记-0018", "收到货款（华东区）", "11220101", null, 152000, "华信贸易有限公司 "],
  ["2026-02.xlsx", "2026-02-11", "记-0031", "报销差旅费", "66020501", 3218.5, null, ""],
  ["2026-02.xlsx", "2026-02-14", "记-0035", "付设备款", "16010101", 428000, null, "中恒机械设备有限公司"],
  ["2026-03.xlsx", "2026-03-02", "记-0044", "暂估入库", "22020200", null, 96500, "汇金贸易有限公司"],
  ["2026-03.xlsx", "2026-03-08", "记-0051", "付咨询费－年审", "66020100", 120000, null, "立信咨询（上海）有限公司"],
];

/** 字段选择后的统一表（来源列保留、金额字段重命名）。 */
const SELECTED_COLUMNS = [
  "来源文件", "凭证日期", "凭证号", "摘要", "科目编码", "借方金额", "贷方金额", "客商名称",
];
const SELECTED_ROWS: Cell[][] = [
  ["2026-01.xlsx", "2026-01-03", "记-0012", "支付货款", "22020105", 86400, null, "汇金贸易有限公司"],
  ["2026-01.xlsx", "2026-01-05", "记-0018", "收到货款（华东区）", "11220101", null, 152000, "华信贸易有限公司"],
  ["2026-02.xlsx", "2026-02-14", "记-0035", "付设备款", "16010101", 428000, null, "中恒机械设备有限公司"],
  ["2026-03.xlsx", "2026-03-08", "记-0051", "付咨询费－年审", "66020100", 120000, null, "立信咨询（上海）有限公司"],
];

/** 清洗后的表（全角已转半角、首尾空格已去）。 */
const CLEANED_COLUMNS = ["凭证日期", "凭证号", "摘要", "科目编码", "借方金额", "贷方金额", "客商名称"];
const CLEANED_ROWS: Cell[][] = [
  ["2026-01-03", "记-0012", "支付货款", "22020105", 86400, null, "汇金贸易有限公司"],
  ["2026-01-05", "记-0018", "收到货款(华东区)", "11220101", null, 152000, "华信贸易有限公司"],
  ["2026-02-14", "记-0035", "付设备款", "16010101", 428000, null, "中恒机械设备有限公司"],
];

/** 公式节点输出（新增净额与期间两列）。 */
const FORMULA_COLUMNS = [...CLEANED_COLUMNS, "净额", "期间"];
const FORMULA_ROWS: Cell[][] = CLEANED_ROWS.map((row) => {
  const debit = typeof row[4] === "number" ? row[4] : 0;
  const credit = typeof row[5] === "number" ? row[5] : 0;
  return [...row, Number((debit - credit).toFixed(2)), "202601"];
});

/** 汇总口径表（筛选上游通常是汇总结果）。 */
const SUMMARY_COLUMNS = ["客商名称", "凭证笔数", "借方合计", "贷方合计"];
const SUMMARY_ROWS: Cell[][] = [
  ["汇金贸易有限公司", 18, 1284600, 96500],
  ["中恒机械设备有限公司", 4, 1982000, null],
  ["立信咨询（上海）有限公司", 6, 720000, null],
  ["华信贸易有限公司", 9, 468200, 1540000],
  ["立瑞贸易有限公司", 5, 402150, null],
  ["（空）", 7, 286400, null],
];

// ===== 二期节点演示数据（行数少，够界面体验即可） =====

/** 手工输入 / db_in / parquet_in：科目对照小表。 */
const MAPPING_COLUMNS = ["科目编码", "科目名称", "科目层级"];
const MAPPING_ROWS: Cell[][] = [
  ["1002", "银行存款", 1],
  ["1122", "应收账款", 1],
  ["2202", "应付账款", 1],
  ["6602", "管理费用", 1],
  ["22020105", "应付账款－暂估货款", 2],
];

/** 关联 Join：左＝序时账、右＝科目对照。 */
const JOIN_J_COLUMNS = ["凭证号", "摘要", "科目编码", "借方金额", "科目名称", "科目层级"];
const JOIN_J_ROWS: Cell[][] = [
  ["记-0012", "支付货款", "22020105", 86400, "应付账款－暂估货款", 2],
  ["记-0018", "收到货款（华东区）", "11220101", null, "应收账款－华东区", 2],
  ["记-0035", "付设备款", "16010101", 428000, "固定资产－设备", 2],
];
const JOIN_L_COLUMNS = ["凭证号", "摘要", "科目编码", "借方金额"];
const JOIN_L_ROWS: Cell[][] = [
  ["记-0031", "报销差旅费", "66020501", 3218.5],
  ["记-0051", "付咨询费－年审", "66020100", 120000],
];
const JOIN_R_COLUMNS = ["科目编码", "科目名称", "科目层级"];
const JOIN_R_ROWS: Cell[][] = [
  ["10020101", "银行存款－工行基本户", 2],
  ["66020200", "管理费用－中介服务费", 2],
];

/** 纵向合并：上下拼接后的表（附来源列语义）。 */
const UNION_COLUMNS = ["来源", "凭证日期", "凭证号", "借方金额", "贷方金额"];
const UNION_ROWS: Cell[][] = [
  ["2026 上半年", "2026-01-03", "记-0012", 86400, null],
  ["2026 上半年", "2026-01-05", "记-0018", null, 152000],
  ["2026 下半年", "2026-07-02", "记-0101", 230500, null],
  ["2026 下半年", "2026-08-14", "记-0118", null, 230500],
];

/** 去重 Unique：U 保留 / D 重复 两路。 */
const UNIQUE_U_COLUMNS = ["凭证号", "客商名称", "金额"];
const UNIQUE_U_ROWS: Cell[][] = [
  ["记-0012", "汇金贸易有限公司", 86400],
  ["记-0018", "华信贸易有限公司", 152000],
];
const UNIQUE_D_COLUMNS = ["凭证号", "客商名称", "金额"];
const UNIQUE_D_ROWS: Cell[][] = [
  ["记-0012", "汇金贸易有限公司", 86400],
  ["记-0035", "中恒机械设备有限公司", 428000],
];

/** 排序 Sort：按金额降序后的表。 */
const SORTED_COLUMNS = ["凭证号", "摘要", "借方金额"];
const SORTED_ROWS: Cell[][] = [
  ["记-0035", "付设备款", 428000],
  ["记-0051", "付咨询费－年审", 120000],
  ["记-0018", "收到货款（华东区）", null],
];

/** 透视 Crosstab：客商 × 月份宽表。 */
const CROSSTAB_COLUMNS = ["客商名称", "202601", "202602", "202603"];
const CROSSTAB_ROWS: Cell[][] = [
  ["汇金贸易有限公司", 86400, 0, 96500],
  ["中恒机械设备有限公司", 0, 428000, 0],
  ["立信咨询（上海）有限公司", 0, 0, 120000],
];

/** 宽转长 Transpose：科目余额 → 项目/数值长表。 */
const TRANSPOSE_COLUMNS = ["科目编码", "项目", "数值"];
const TRANSPOSE_ROWS: Cell[][] = [
  ["1002", "期初余额", 1250000],
  ["1002", "期末余额", 1312500],
  ["1122", "期初余额", 468200],
  ["1122", "期末余额", 512400],
];

/** 分列 Split：科目编码拆为一级/二级。 */
const SPLIT_COLUMNS = ["凭证号", "科目编码", "科目编码_1", "科目编码_2"];
const SPLIT_ROWS: Cell[][] = [
  ["记-0012", "22020105", "2202", "0105"],
  ["记-0018", "11220101", "1122", "0101"],
  ["记-0035", "16010101", "1601", "0101"],
];

/** 检查 Check：P 通过 / NG 未通过 两路（NG 附违规原因列）。 */
const CHECK_P_COLUMNS = ["凭证号", "摘要", "借方金额", "贷方金额"];
const CHECK_P_ROWS: Cell[][] = [
  ["记-0012", "支付货款", 86400, 86400],
  ["记-0018", "收到货款（华东区）", 152000, 152000],
];
const CHECK_NG_COLUMNS = ["凭证号", "摘要", "借方金额", "贷方金额", "违规原因"];
const CHECK_NG_ROWS: Cell[][] = [
  ["记-0031", "报销差旅费", 3218.5, 3218.45, "借贷平衡：差额 0.05 超出容差 0.01（按凭证号分组）"],
  ["记-0044", "暂估入库", null, null, "关键字段非空：借方金额、贷方金额 均为空值"],
];

function numericTypes(columns: string[], count: number): string[] {
  const numericHint = /金额|合计|借方|贷方|行数|笔数|数$|值$|净额|期间/;
  return Array.from({ length: count }, (_, index) =>
    numericHint.test(columns[index] ?? "") ? "decimal" : "text",
  );
}

function anchor(data: { columns: string[]; rows: Cell[][]; rowCount: number }): AnchorData {
  return {
    columns: data.columns,
    types: numericTypes(data.columns, data.columns.length),
    rowCount: data.rowCount,
    sample: data.rows,
  };
}

function anchorFromTable(columns: string[], rows: Cell[][], rowCount: number): AnchorData {
  return anchor({ columns, rows, rowCount });
}

interface NodeOutcome {
  status: "ok" | "warn" | "error";
  rows: number;
  ms: number;
  messages: string[];
  stats: string[];
  anchors: Record<string, AnchorData>;
}

function tableForNode(
  type: string,
  seq: number,
): { columns: string[]; rows: Cell[][] } {
  switch (type) {
    case "excel_in":
      return { columns: JOURNAL_COLUMNS, rows: JOURNAL_ROWS };
    case "csv_in":
      return {
        columns: JOURNAL_COLUMNS,
        rows: JOURNAL_ROWS.map((row) => [
          String(row[0] ?? "").replace(/\.xlsx$/, ".csv"),
          ...row.slice(1),
        ]),
      };
    case "select_n":
      return { columns: SELECTED_COLUMNS, rows: SELECTED_ROWS };
    case "clean":
      return { columns: CLEANED_COLUMNS, rows: CLEANED_ROWS };
    case "formula":
      return { columns: FORMULA_COLUMNS, rows: FORMULA_ROWS };
    case "filter_n":
      return { columns: SUMMARY_COLUMNS, rows: SUMMARY_ROWS };
    case "manual_in":
    case "db_in":
    case "parquet_in":
      return { columns: MAPPING_COLUMNS, rows: MAPPING_ROWS };
    case "join_n":
      return { columns: JOIN_J_COLUMNS, rows: JOIN_J_ROWS };
    case "union_n":
      return { columns: UNION_COLUMNS, rows: UNION_ROWS };
    case "sort_n":
      return { columns: SORTED_COLUMNS, rows: SORTED_ROWS };
    case "summarize":
      return { columns: SUMMARY_COLUMNS, rows: SUMMARY_ROWS };
    case "crosstab":
      return { columns: CROSSTAB_COLUMNS, rows: CROSSTAB_ROWS };
    case "transpose":
      return { columns: TRANSPOSE_COLUMNS, rows: TRANSPOSE_ROWS };
    case "split":
      return { columns: SPLIT_COLUMNS, rows: SPLIT_ROWS };
    case "check_n":
      return { columns: CHECK_P_COLUMNS, rows: CHECK_P_ROWS };
    default:
      return {
        columns: ["字段 1", "字段 2", "字段 3"],
        rows: [
          ["示例 " + (seq + 1), 156, "演示数据"],
          ["示例 " + (seq + 2), 208, "演示数据"],
        ],
      };
  }
}

function rowCountFor(type: string, mode: "preview" | "full", seq: number): number {
  const full: Record<string, number> = {
    excel_in: 2847392,
    csv_in: 12840000,
    select_n: 2847392,
    clean: 2847301,
    formula: 2847301,
    filter_n: 3912,
    excel_out: 156,
    csv_out: 156,
    join_n: 2841256,
    union_n: 5694604,
    unique_n: 12481,
    sort_n: 2847301,
    summarize: 6,
    crosstab: 42,
    transpose: 1692,
    split: 2847301,
    check_n: 2847289,
    manual_in: 5,
    db_in: 5214882,
    parquet_in: 2847392,
  };
  if (mode === "preview") {
    if (type === "excel_in" || type === "csv_in" || type === "db_in") return 1000;
    if (type === "manual_in") return 5;
    return 1000 - seq * 3;
  }
  return (full[type] ?? 1000 + seq * 7) - seq * 13;
}

function msFor(type: string, mode: "preview" | "full", seq: number): number {
  if (mode === "preview") return 120 + seq * 60 + (type.length * 7) % 90;
  const base: Record<string, number> = {
    excel_in: 41000,
    csv_in: 58000,
    select_n: 3100,
    clean: 4200,
    formula: 5100,
    filter_n: 2400,
    excel_out: 400,
    csv_out: 350,
    join_n: 26000,
    union_n: 4600,
    unique_n: 9800,
    sort_n: 15400,
    summarize: 6200,
    crosstab: 5100,
    transpose: 2600,
    split: 3100,
    check_n: 7400,
    manual_in: 40,
    db_in: 49000,
    parquet_in: 3600,
  };
  return (base[type] ?? 3000) + seq * 137;
}

/** uptoNodeId 的上游闭包：目标节点＋其全部（传递）上游。 */
function upstreamClosure(workflow: DataflowWorkflow, targetId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge.from);
    incoming.set(edge.to, list);
  }
  const seen = new Set<string>([targetId]);
  const stack = [targetId];
  while (stack.length) {
    const current = stack.pop() as string;
    for (const parent of incoming.get(current) ?? []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return seen;
}

/**
 * 生成演示运行结果。按拓扑序给每个节点编造可解释的行数/耗时/消息；
 * 筛选 T/F、去重 U/D、关联 J/L/R、检查 P/NG 多路锚点齐全；
 * 输出节点在预览模式不落盘、全量模式给出输出清单。
 * uptoNodeId＝「运行到选中节点」：只返回该节点及其上游的结果，其后节点不出现；
 * 目标节点不在流程中时与真实引擎一致（engine.rs upstream_closure）返回
 * DATAFLOW_UPTO_NODE_MISSING 错误结果，而不是静默全量执行。
 */
export function dataflowDemoResult(
  mode: "preview" | "full",
  workflowInput: unknown,
  paramOverrides: Record<string, string> = {},
  uptoNodeId?: string,
): DataflowRunResult {
  const parsed = parseWorkflowFile(JSON.stringify(workflowInput ?? {}));
  if (!parsed.ok) {
    return {
      mode,
      nodes: {},
      outputs: [],
      error: { code: "DATAFLOW_DEMO_INVALID", userMessage: `演示数据无法解析该流程：${parsed.error}` },
    };
  }
  const workflow: DataflowWorkflow = parsed.workflow;
  // 与真实引擎对齐：未知目标节点报错，不再「兜底全量执行」——同一请求在浏览器
  // 演示与 Tauri 下结局一致（此前浏览器静默全跑、Tauri 报中文错误）。
  if (uptoNodeId && !workflow.nodes.some((node) => node.id === uptoNodeId)) {
    return {
      mode,
      nodes: {},
      outputs: [],
      error: {
        code: "DATAFLOW_UPTO_NODE_MISSING",
        userMessage: `「运行到选中节点」的目标节点“${uptoNodeId}”不存在，请检查节点 id。`,
      },
    };
  }
  const order = topoOrder(workflow);
  const allowed = uptoNodeId ? upstreamClosure(workflow, uptoNodeId) : null;
  const outcomes: Record<string, NodeOutcome> = {};
  const outputs: DataflowRunResult["outputs"] = [];
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });

  order.forEach((nodeId, seq) => {
    if (allowed && !allowed.has(nodeId)) return;
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const specInputs: Record<string, string[]> = {
      select_n: ["in"], clean: ["in"], formula: ["in"], filter_n: ["in"],
      sort_n: ["in"], unique_n: ["in"], summarize: ["in"], crosstab: ["in"],
      transpose: ["in"], split: ["in"], check_n: ["in"], join_n: ["inL", "inR"],
      excel_out: ["in"], csv_out: ["in"],
    };
    // 纵向合并允许多条连线，至少要有一条上游。
    const needsAnyIncoming = node.type === "union_n";
    const needed = specInputs[node.type] ?? [];
    const hasUpstream = needsAnyIncoming
      ? workflow.edges.some((edge) => edge.to === nodeId)
      : needed.every((key) =>
          workflow.edges.some((edge) => edge.to === nodeId && edge.toAnchor === key),
        );
    if (!hasUpstream) {
      outcomes[nodeId] = {
        status: "error",
        rows: 0,
        ms: 0,
        messages: [`${timestamp} 运行失败：该节点缺少上游连线，请从上游节点的输出口连过来。`],
        stats: [],
        anchors: {},
      };
      return;
    }

    const table = tableForNode(node.type, seq);
    const rows = rowCountFor(node.type, mode, seq);
    const ms = msFor(node.type, mode, seq);
    const config = node.config as Record<string, unknown>;
    const outcome: NodeOutcome = { status: "ok", rows, ms, messages: [], stats: [], anchors: {} };

    switch (node.type) {
      case "excel_in":
      case "csv_in": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [
          `${timestamp} 读取 12 个文件（xlsx×8、xls×2、csv×2）`,
          `${timestamp} 2 个文件为 GBK 编码，已自动识别`,
          mode === "full"
            ? `${timestamp} 全量读取完成：${rows.toLocaleString("zh-CN")} 行`
            : `${timestamp} 预览样本：每个输入取前 1,000 行`,
        ];
        outcome.stats = [
          "输入文件 12 个",
          `读取行数 ${rows.toLocaleString("zh-CN")}`,
          mode === "preview" ? "预览样本：每输入前 1,000 行" : "编码与分隔符识别结果见消息",
        ];
        break;
      }
      case "select_n": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 重命名 2 个字段：借方→借方金额、贷方→贷方金额；保留来源列`];
        outcome.stats = ["字段 8 个 · 全部保留", "进出行数相同"];
        break;
      }
      case "clean": {
        outcome.status = "warn";
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [
          `${timestamp} 去除首尾空格 41 处；全角转半角 12 处`,
          `${timestamp} 跳过 3 行：金额列含无法识别字符（可导出异常清单）`,
        ];
        outcome.stats = [
          `输入 ${rows + 3} → 输出 ${rows}`,
          "跳过 3 行（异常清单可导出）",
          "删除整行空记录 2 行",
        ];
        break;
      }
      case "formula": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 计算 2 条公式：净额＝借方金额－贷方金额；期间＝年月(凭证日期)`];
        outcome.stats = ["新增字段 2 个：净额、期间", "除零与空值按行级异常策略处理"];
        break;
      }
      case "filter_n": {
        const tRows = mode === "preview" ? 12 : 156;
        const fRows = mode === "full" ? 3756 : 202;
        outcome.anchors.T = anchorFromTable(table.columns, table.rows.slice(0, 3), tRows);
        outcome.anchors.F = anchorFromTable(table.columns, table.rows.slice(3), fRows);
        outcome.messages = [
          `${timestamp} 条件：借方合计 ≥ 500,000（引用参数：金额门槛）`,
          `${timestamp} 符合 ${tRows} 行进 T 路，其余 ${fRows} 行进 F 路`,
        ];
        outcome.stats = [
          `T ${tRows} · F ${fRows}（合计＝输入）`,
          "空值记录按规则进入 F 路",
        ];
        break;
      }
      case "excel_out":
      case "csv_out": {
        const rawName =
          typeof config.fileName === "string" && config.fileName
            ? config.fileName
            : `${node.type === "excel_out" ? "输出结果" : "输出明细"}_{p1}.${node.type === "excel_out" ? "xlsx" : "csv"}`;
        // 运行前解析可能已把文件名补成绝对路径（输出位置自动补全），演示层
        // 只取文件名部分再拼自己的样例目录，避免出现双盘符拼接。
        const fileName = applyParamPlaceholders(
          rawName.split(/[\\/]/).pop() ?? rawName,
          workflow.params,
          paramOverrides,
        );
        // 锚点键对齐真实引擎（nodes/output.rs）：Excel 输出用「sheet:名」——第 1 条连线
        // 用配置 Sheet 名（缺省＝上游节点名），其余连线用各自上游节点名；CSV 输出用
        // 「file:名.扩展名」，多输入时文件名 _2/_3 递增。
        const incoming = workflow.edges
          .filter((edge) => edge.to === nodeId && edge.toAnchor === "in")
          .map((edge) => workflow.nodes.find((item) => item.id === edge.from)?.name ?? "上游数据");
        const configuredSheet =
          typeof config.sheetName === "string" && config.sheetName ? config.sheetName : "";
        const sheetBases = incoming.map((upstream, position) =>
          position === 0 && configuredSheet ? configuredSheet : upstream,
        );
        const sheet = sheetBases[0] ?? node.name;
        if (node.type === "excel_out") {
          const seen = new Set<string>();
          for (const base of sheetBases) {
            if (seen.has(base)) continue;
            seen.add(base);
            outcome.anchors[`sheet:${base}`] = anchorFromTable(table.columns, table.rows, rows);
          }
        } else {
          const dot = fileName.lastIndexOf(".");
          const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
          const ext = dot > 0 ? fileName.slice(dot + 1) : "csv";
          const seen = new Set<string>();
          incoming.forEach((_, position) => {
            const base = position === 0 ? stem : `${stem}_${position + 1}`;
            if (seen.has(base)) return;
            seen.add(base);
            outcome.anchors[`file:${base}.${ext}`] = anchorFromTable(table.columns, table.rows, rows);
          });
        }
        if (mode === "preview") {
          outcome.messages = [
            `${timestamp} 预览运行不写输出文件，仅在结果区展示样本`,
            `${timestamp} 全量运行将写入：D:\\审计输出\\${fileName}`,
          ];
          outcome.stats = ["预览模式：未写入文件", `拟写入行数 ${rows.toLocaleString("zh-CN")}`];
        } else {
          outputs.push({
            nodeId,
            path: `D:\\审计输出\\${fileName}`,
            sheet: node.type === "excel_out" ? sheet : "",
            rows,
          });
          outcome.messages = [`${timestamp} 写入 D:\\审计输出\\${fileName}${node.type === "excel_out" ? `（Sheet：${sheet}）` : ""}`];
          outcome.stats = [`写入 ${rows.toLocaleString("zh-CN")} 行`];
        }
        break;
      }
      case "join_n": {
        const leftRows = mode === "preview" ? 1000 : 2847301;
        const rightRows = mode === "preview" ? 60 : 1842;
        const lRows = mode === "preview" ? 42 : 6045;
        const rRows = mode === "preview" ? 3 : 31;
        outcome.anchors.J = anchorFromTable(JOIN_J_COLUMNS, JOIN_J_ROWS, rows);
        outcome.anchors.L = anchorFromTable(JOIN_L_COLUMNS, JOIN_L_ROWS, lRows);
        outcome.anchors.R = anchorFromTable(JOIN_R_COLUMNS, JOIN_R_ROWS, rRows);
        outcome.messages = [
          `${timestamp} 按 1 组关联字段匹配：左 ${leftRows.toLocaleString("zh-CN")} 行 × 右 ${rightRows.toLocaleString("zh-CN")} 行`,
          mode === "preview"
            ? `${timestamp} 预览样本：各输入独立截样可能遗漏匹配，J 行数不代表全量`
            : `${timestamp} 匹配完成：J ${rows.toLocaleString("zh-CN")} 行`,
        ];
        outcome.stats = [
          `左输入 ${leftRows.toLocaleString("zh-CN")} 行 · 右输入 ${rightRows.toLocaleString("zh-CN")} 行`,
          `J ${rows.toLocaleString("zh-CN")} · L ${lRows.toLocaleString("zh-CN")} · R ${rRows.toLocaleString("zh-CN")}`,
          `行数膨胀提示：左表存在重复键（同一键左 3 条×右 4 条＝12 条组合），J 行数 ${rows.toLocaleString("zh-CN")} ＞ 左输入中参与匹配的行数，属多对多正常组合，未自动去重`,
        ];
        break;
      }
      case "union_n": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 按字段名对齐拼接 2 个上游表；多出字段「来源」缺失侧已补空值`];
        outcome.stats = [
          `输入 2,847,302 + 2,847,302 行 → 合并 ${rows.toLocaleString("zh-CN")} 行（守恒核对通过）`,
          "差异报告：表 2 多出字段「来源」；「借方金额」类型不一致，已按配置统一为文本",
        ];
        break;
      }
      case "unique_n": {
        const dRows = mode === "preview" ? 208 : 3206;
        outcome.anchors.U = anchorFromTable(UNIQUE_U_COLUMNS, UNIQUE_U_ROWS, rows);
        outcome.anchors.D = anchorFromTable(UNIQUE_D_COLUMNS, UNIQUE_D_ROWS, dRows);
        outcome.messages = [`${timestamp} 按「凭证号＋客商名称」去重，保留首次出现`];
        outcome.stats = [
          `U ${rows.toLocaleString("zh-CN")} · D ${dRows.toLocaleString("zh-CN")}（合计＝输入 ${(rows + dRows).toLocaleString("zh-CN")}）`,
          "空值与空文本视为不同值；依据输入顺序取首次出现",
        ];
        break;
      }
      case "sort_n": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 全局排序完成：借方金额 降序，空值排最后`];
        outcome.stats = ["进出行数相同", "相同排序键按输入到达顺序保持相对次序（稳定排序）"];
        break;
      }
      case "summarize": {
        outcome.anchors.output = anchorFromTable(SUMMARY_COLUMNS, SUMMARY_ROWS, rows);
        outcome.messages = [`${timestamp} 按客商名称分组：求和 2 项、总行数 1 项`];
        outcome.stats = [
          `输入 ${(rows * 474567).toLocaleString("zh-CN")} 行 → 分组 ${rows.toLocaleString("zh-CN")} 组`,
          "求和/平均/最小/最大跳过空值；平均以有效值数量为分母",
        ];
        break;
      }
      case "crosstab": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 透视完成：行＝客商名称，列＝期间（202601–202612）`];
        outcome.stats = [
          `输出 ${rows.toLocaleString("zh-CN")} 行 × ${CROSSTAB_COLUMNS.length} 列（动态生成 12 列）`,
          "缺失组合填充 0；动态列名＝列字段原值",
        ];
        break;
      }
      case "transpose": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 宽转长：期初余额/期末余额 两列转入行（项目/数值）`];
        outcome.stats = [`输出 ${rows.toLocaleString("zh-CN")} 行 ＝ 输入行数 × 转入列数`, "输出列：科目编码、项目、数值"];
        break;
      }
      case "split": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 按固定宽度拆分「科目编码」：前 4 位/后 4 位两列，保留原列`];
        outcome.stats = ["进出行数相同", "拆出 2 列：科目编码_1、科目编码_2；段不足补空值"];
        break;
      }
      case "check_n": {
        const ngRows = mode === "preview" ? 18 : 12893;
        outcome.anchors.P = anchorFromTable(CHECK_P_COLUMNS, CHECK_P_ROWS, rows);
        outcome.anchors.NG = anchorFromTable(CHECK_NG_COLUMNS, CHECK_NG_ROWS, ngRows);
        outcome.status = "warn";
        outcome.messages = [
          `${timestamp} 规则 1 借贷平衡（按凭证号分组，容差 0.01）：未通过 12 组`,
          `${timestamp} 规则 2 关键字段非空（借方金额、贷方金额）：空值行已进未通过路`,
        ];
        outcome.stats = [
          `P ${rows.toLocaleString("zh-CN")} · NG ${ngRows.toLocaleString("zh-CN")}`,
          "规则执行摘要：借贷平衡检查 2,847 组，未通过 12 组（容差 0.01）；非空检查未通过 12,881 行；空值遇区间规则判未通过并标注「空值」",
          "未通过路附违规原因列（规则与实际/预期值）",
        ];
        break;
      }
      case "manual_in": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 内嵌小表读取完成：${rows.toLocaleString("zh-CN")} 行 × 3 列（随流程文件保存）`];
        outcome.stats = [`行数 ${rows.toLocaleString("zh-CN")} · 列数 3`, "列类型：文本、文本、整数"];
        break;
      }
      case "db_in": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        const table2 = typeof config.table === "string" && config.table ? config.table : "序时账_2026";
        outcome.messages = [
          `${timestamp} 识别为 SQLite 数据库，读取表「${table2}」`,
          `${timestamp} 记录以表名与主键标识；类型按表结构保留`,
        ];
        outcome.stats = [
          `表 ${table2} · ${rows.toLocaleString("zh-CN")} 行`,
          mode === "preview" ? "预览样本：前 1,000 行" : "全量读取完成",
        ];
        break;
      }
      case "parquet_in": {
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 读取 2 个 Parquet 文件，结构兼容`];
        outcome.stats = [`文件 2 个 · ${rows.toLocaleString("zh-CN")} 行`, "精度、空值与日期类型保持一致"];
        break;
      }
      default: {
        // 二期节点（打开旧流程时可能出现）：给通用成功结果。
        outcome.anchors.output = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 演示数据：该节点属于二期能力，按通用表返回。`];
        outcome.stats = [`行数 ${rows.toLocaleString("zh-CN")}`];
      }
    }
    outcomes[nodeId] = outcome;
  });

  return { mode, nodes: outcomes, outputs, error: null };
}
