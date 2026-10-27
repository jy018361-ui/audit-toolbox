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
  };
  if (mode === "preview") {
    return type === "excel_in" || type === "csv_in" ? 1000 : 1000 - seq * 3;
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
  };
  return (base[type] ?? 3000) + seq * 137;
}

/**
 * 生成演示运行结果。按拓扑序给每个节点编造可解释的行数/耗时/消息；
 * 筛选节点给 T/F 两路；输出节点在预览模式不落盘、全量模式给出输出清单。
 */
export function dataflowDemoResult(
  mode: "preview" | "full",
  workflowInput: unknown,
  paramOverrides: Record<string, string> = {},
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
  const order = topoOrder(workflow);
  const outcomes: Record<string, NodeOutcome> = {};
  const outputs: DataflowRunResult["outputs"] = [];
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });

  order.forEach((nodeId, seq) => {
    const node = workflow.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const specInputs: Record<string, string[]> = {
      select_n: ["in"], clean: ["in"], formula: ["in"], filter_n: ["in"],
      excel_out: ["in"], csv_out: ["in"],
    };
    const needed = specInputs[node.type] ?? [];
    const hasUpstream = needed.every((key) =>
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
        outcome.anchors.out = anchorFromTable(table.columns, table.rows, rows);
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
        outcome.anchors.out = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 重命名 2 个字段：借方→借方金额、贷方→贷方金额；保留来源列`];
        outcome.stats = ["字段 8 个 · 全部保留", "进出行数相同"];
        break;
      }
      case "clean": {
        outcome.status = "warn";
        outcome.anchors.out = anchorFromTable(table.columns, table.rows, rows);
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
        outcome.anchors.out = anchorFromTable(table.columns, table.rows, rows);
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
        outcome.anchors.out = anchorFromTable(table.columns, table.rows, rows);
        const rawName =
          typeof config.fileName === "string" && config.fileName
            ? config.fileName
            : `${node.type === "excel_out" ? "输出结果" : "输出明细"}_{p1}.${node.type === "excel_out" ? "xlsx" : "csv"}`;
        const fileName = applyParamPlaceholders(rawName, workflow.params, paramOverrides);
        const sheet = typeof config.sheetName === "string" && config.sheetName ? config.sheetName : node.name;
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
      default: {
        // 二期节点（打开旧流程时可能出现）：给通用成功结果。
        outcome.anchors.out = anchorFromTable(table.columns, table.rows, rows);
        outcome.messages = [`${timestamp} 演示数据：该节点属于二期能力，按通用表返回。`];
        outcome.stats = [`行数 ${rows.toLocaleString("zh-CN")}`];
      }
    }
    outcomes[nodeId] = outcome;
  });

  return { mode, nodes: outcomes, outputs, error: null };
}
