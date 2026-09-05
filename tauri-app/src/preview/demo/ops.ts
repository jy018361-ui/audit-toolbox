// 业务报告两件的浏览器预览演示数据：
//   1. 函证进度小能手（ConfirmationProgressPage）：confirmation.inspect / confirmation.process
//   2. WP 服务单生成工具（WpServicePage）：wp.validate / wp.generate
// 返回值形状与各页面源码及对应 Rust 方法（confirmation.rs 的 inspect / process、
// wp.rs 的 validate_call / WpGenerateResult，serde camelCase）的真实返回一一对应。
// 仅浏览器预览 + 演示开关（localStorage audit-toolbox.demo-data = "1"）时生效。

type DemoParams = Record<string, unknown>;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const fileNameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;

const DEMO_DIR = "C:\\演示数据";

// ────────────────────────────── 1. 函证进度小能手 ──────────────────────────────

const DEFAULT_CONFIRMATION_INPUT = `${DEMO_DIR}\\函证列表.xlsx`;

/** 台账表头与 12 行明细：银行 5（含 1 电子函证）+ 往来 7，发函/回函状态各态齐全，
 *  基准日跨年中和年末两个。表头含 Rust 侧 BANK_REQUIRED 的全部必需列。 */
const CONFIRMATION_HEADERS = [
  "项目名称",
  "函证类型",
  "函证编号",
  "发函单位名称",
  "函证状态",
  "函证基准日",
  "发函模版",
  "发函签收时间",
  "询证项回函结果",
];

const CONFIRMATION_ROWS: string[][] = [
  ["华东集团2025年报审计", "银行", "YZ-YH-2601", "中国工商银行上海市分行营业部", "已发函", "2025-12-31", "银行询证函（通用版）", "2026-01-05", "待回函"],
  ["华东集团2025年报审计", "银行", "YZ-YH-2602", "中国建设银行上海市分行徐汇支行", "已回函", "2025-12-31", "银行询证函（通用版）", "2026-01-06", "信息相符"],
  ["华东集团2025年报审计", "银行-电子函证", "YZ-YH-2603", "招商银行股份有限公司上海分行", "已回函", "2025-12-31", "银行询证函（电子版）", "2026-01-08", "信息相符"],
  ["华东集团2025年报审计", "银行", "YZ-YH-2604", "上海银行浦江支行", "已签收", "2025-12-31", "银行询证函（通用版）", "2026-01-09", "未回函"],
  ["华东集团2025年报审计", "银行", "YZ-YH-2605", "中国农业银行上海市分行静安支行", "未发函", "2025-12-31", "银行询证函（通用版）", "", "未回函"],
  ["华东集团2025年报审计", "往来", "YZ-WL-2611", "上海锦澄贸易有限公司", "已回函", "2025-12-31", "询证函-往来款项", "2026-01-07", "信息相符"],
  ["华东集团2025年报审计", "往来", "YZ-WL-2612", "苏州恒达精密制造有限公司", "已回函", "2025-12-31", "询证函-往来款项", "2026-01-10", "信息不符"],
  ["华东集团2025年报审计", "往来", "YZ-WL-2613", "宁波甬江供应链管理有限公司", "已发函", "2025-12-31", "询证函-往来款项", "2026-01-11", "待回函"],
  ["北方实业IPO尽职调查", "往来", "YZ-WL-2621", "武汉长江重工机械有限公司", "已回函", "2026-06-30", "询证函-往来款项", "2026-07-06", "信息相符"],
  ["北方实业IPO尽职调查", "往来", "YZ-WL-2622", "天津渤海化工集团有限公司", "已发函", "2026-06-30", "询证函-往来款项", "2026-07-08", "待回函"],
  ["北方实业IPO尽职调查", "往来", "YZ-WL-2623", "广州穗联贸易有限公司", "已签收", "2026-06-30", "询证函-往来款项", "2026-07-10", "未回函"],
  ["北方实业IPO尽职调查", "往来", "YZ-WL-2624", "杭州云栖信息技术有限公司", "未发函", "2026-06-30", "询证函-往来款项", "", "未回函"],
];

const CONFIRMATION_TYPE_INDEX = 1;
const isBankRow = (row: string[]) =>
  row[CONFIRMATION_TYPE_INDEX] === "银行" ||
  row[CONFIRMATION_TYPE_INDEX] === "银行-电子函证";

/** 与 confirmation.rs 的 inspect_table 同口径统计。 */
const CONFIRMATION_STATISTICS = {
  total: CONFIRMATION_ROWS.length,
  bank: CONFIRMATION_ROWS.filter(isBankRow).length,
  trade: CONFIRMATION_ROWS.filter((row) => !isBankRow(row)).length,
  projects: new Set(CONFIRMATION_ROWS.map((row) => row[0])).size,
  units: new Set(CONFIRMATION_ROWS.map((row) => row[3])).size,
  baseDates: [...new Set(CONFIRMATION_ROWS.map((row) => row[5]))].sort(),
};

const BANK_REQUIRED = [
  "函证类型",
  "函证编号",
  "发函单位名称",
  "函证状态",
  "函证基准日",
  "发函模版",
  "发函签收时间",
  "询证项回函结果",
];
const TRADE_REQUIRED = [
  "函证类型",
  "函证编号",
  "发函单位名称",
  "函证状态",
  "发函签收时间",
  "询证项回函结果",
];

/** 必需列按模式取并集；演示表头齐全，missingColumns 恒为空（字段检查通过分支）。 */
const requiredColumnsOf = (mode: string): string[] => {
  const required = new Set(["函证类型"]);
  if (mode === "bank" || mode === "both") BANK_REQUIRED.forEach((v) => required.add(v));
  if (mode === "trade" || mode === "both") TRADE_REQUIRED.forEach((v) => required.add(v));
  return [...required];
};

const confirmationInspect = (params: DemoParams) => {
  const inputPath = asString(params.inputPath) || DEFAULT_CONFIRMATION_INPUT;
  const modeInput = asString(params.mode);
  const mode =
    modeInput === "bank" || modeInput === "trade" ? modeInput : "both";
  const required = requiredColumnsOf(mode);
  return {
    path: inputPath,
    kind: "excel",
    mode,
    headers: CONFIRMATION_HEADERS,
    preview: CONFIRMATION_ROWS.slice(0, 12),
    dimensions: {
      rows: CONFIRMATION_ROWS.length,
      columns: CONFIRMATION_HEADERS.length,
    },
    requiredColumns: required,
    requiredColumnsPresent: required,
    missingColumns: [] as string[],
    statistics: CONFIRMATION_STATISTICS,
    outputDirectory: `${DEMO_DIR}\\函证统计结果`,
    willGenerate: {
      bank: (mode === "bank" || mode === "both") && CONFIRMATION_STATISTICS.bank > 0,
      trade: (mode === "trade" || mode === "both") && CONFIRMATION_STATISTICS.trade > 0,
    },
    engine: "rust",
  };
};

/** 报告文件名与 confirmation.rs 的 write_report 命名一致：{stem}_{label}_进度报告_{stamp}。 */
const confirmationReportPath = (inputPath: string, label: string) =>
  `${DEMO_DIR}\\函证统计结果\\${fileNameOf(inputPath).replace(/\.[^.]+$/, "")}_${label}_进度报告_20260905_143210.xlsx`;

// ────────────────────────────── 2. WP 服务单生成工具 ──────────────────────────────

const WP_FOLDER = `${DEMO_DIR}\\WP服务单`;

/** wp.validate 的返回：valid 分支（ResultView 显示「输入检查通过。」）。 */
const wpValidate = (params: DemoParams) => {
  const folder = asString(params.folder) || WP_FOLDER;
  return {
    folder,
    valid: true,
    missing: [] as string[],
    serviceOrderPath: `${folder}\\FY27+WP服务单.xlsx`,
    sectionListPath: `${folder}\\FY27 Section List.xlsx`,
    inputFiles: {
      wpServiceOrder: "FY27+WP服务单.xlsx",
      sectionList: "FY27 Section List.xlsx",
    },
    outputPath: `${folder}\\FY27+WP服务单汇总.xlsx`,
    engine: "rust",
  };
};

/** Outlook Hours 核对差异 8 条：ResultView 以「方案 X / 源表 Y，差额 Z」逐行列出。 */
const OUTLOOK_DIFFERENCES = [
  { serviceNumber: "S-FY27-0102", engagementName: "华东集团2025年报审计", calculated: 412, source: 420, difference: -8 },
  { serviceNumber: "S-FY27-0105", engagementName: "北方实业IPO尽职调查", calculated: 268, source: 260, difference: 8 },
  { serviceNumber: "S-FY27-0111", engagementName: "华瑞公司2026中期审阅", calculated: 156, source: 150, difference: 6 },
  { serviceNumber: "S-FY27-0118", engagementName: "恒信公司2025年报审计", calculated: 96, source: 104, difference: -8 },
  { serviceNumber: "S-FY27-0123", engagementName: "蓝天科技2025年报审计", calculated: 184, source: 180, difference: 4 },
  { serviceNumber: "S-FY27-0127", engagementName: "通达贸易专项审阅", calculated: 72, source: 80, difference: -8 },
  { serviceNumber: "S-FY27-0131", engagementName: "甬江制造2025年报审计", calculated: 240, source: 232, difference: 8 },
  { serviceNumber: "S-FY27-0136", engagementName: "云帆物流IPO尽职调查", calculated: 128, source: 132, difference: -4 },
];

/** wp.generate 的返回：WpGenerateResult（camelCase）+ 注入的 outputPaths。
 *  拆分四类行数与汇总行数一一对应，26 = AUD2026 12 + IPO 4 + IPO archive 3 + AUD2025 7。 */
const WP_GENERATE_RESULT = (folder: string) => ({
  outputPath: `${folder}\\FY27+WP服务单汇总.xlsx`,
  splitFile: `${folder}\\FY27+WP服务单_自动拆分.xlsx`,
  sheets: 6,
  services: 26,
  indexRows: 26,
  aud2026Rows: 12,
  ipoRows: 4,
  ipoArchiveRows: 3,
  aud2025Rows: 7,
  splitAud2026Rows: 12,
  splitIpoRows: 4,
  splitIpoArchiveRows: 3,
  splitAud2025Rows: 7,
  sectionListFound: true,
  matchedSectionOrders: 24,
  matchedSectionRows: 148,
  populatedSectionRows: 96,
  templateSectionRows: 52,
  populatedTemplateRows: 20,
  outlookCompared: 26,
  outlookEqual: 18,
  outlookDifferences: OUTLOOK_DIFFERENCES,
  unmatchedSectionOrders: ["S-FY27-0141", "S-FY27-0148"],
  excludedIpo: [
    {
      engagementName: "启明半导体IPO尽职调查",
      serviceNumber: "S-FY27-0087",
      startYears: [2024],
    },
  ],
  excludedOther: [
    { engagementName: "集团内部培训支持", serviceNumber: "S-FY27-0053" },
  ],
  ipoYears: [2024, 2025, 2026],
  outputPaths: [
    `${folder}\\FY27+WP服务单汇总.xlsx`,
    `${folder}\\FY27+WP服务单_自动拆分.xlsx`,
  ],
});

// ────────────────────────────── 同步 handler 注册表 ──────────────────────────────

export const handlers: Record<string, (params: DemoParams) => unknown> = {
  // 函证进度：检查函证清单（模式切换会重新触发 inspect，按 mode 给必需列与统计）
  "confirmation.inspect": (params) => confirmationInspect(params),

  // WP 服务单：输入文件检查
  "wp.validate": (params) => wpValidate(params),
};

// ────────────────────────────── 任务剧本（jobHandlers）──────────────────────────────
// api.ts 演示任务通道按序回放事件序列，jobId / toolId 由 api 层统一填充
// （confirmation.* → confirmation_progress、wp.* → wp_service_generator，
// 与页面监听过滤器一致）。completed 的 result 按"页面消费什么就给什么"逐字段给出。

import type { DemoJobEvent } from "../demoRegistry";

export const jobHandlers: Record<
  string,
  (params: DemoParams) => DemoJobEvent[]
> = {
  // ConfirmationProgressPage：completed 消费 result.outputPaths 与 result.reports
  // （status = completed / skipped，报告区按类型逐行列出，含 summaryRows）。
  "confirmation.process": (params) => {
    const inputPath = asString(params.inputPath) || DEFAULT_CONFIRMATION_INPUT;
    const modeInput = asString(params.mode);
    const mode =
      modeInput === "bank" || modeInput === "trade" ? modeInput : "both";
    const modes = mode === "both" ? ["bank", "trade"] : [mode];
    const labelOf = (item: string) => (item === "bank" ? "银行函证" : "往来函证");
    const countOf = (item: string) =>
      item === "bank" ? CONFIRMATION_STATISTICS.bank : CONFIRMATION_STATISTICS.trade;
    const reports = modes.map((item) => ({
      type: item,
      label: labelOf(item),
      status: "completed",
      summaryRows: countOf(item),
      outputPath: confirmationReportPath(inputPath, labelOf(item)),
    }));
    const outputPaths = reports.map((report) => report.outputPath);
    const total = modes.length;
    return [
      {
        phase: "queued",
        current: 0,
        total,
        message: "排队生成函证进度报告…",
        severity: "info",
        outputPaths: [],
      },
      ...modes.map((item, index) => ({
        phase: "running" as const,
        current: index,
        total,
        message: `正在生成${labelOf(item)}报告（${countOf(item)} 条函证）…`,
        severity: "info" as const,
        outputPaths: [] as string[],
      })),
      {
        phase: "completed",
        current: total,
        total,
        message:
          mode === "both"
            ? `进度报告生成完成：银行函证 ${CONFIRMATION_STATISTICS.bank} 条、往来函证 ${CONFIRMATION_STATISTICS.trade} 条，共 ${total} 份报告。`
            : `进度报告生成完成：${labelOf(mode)} ${countOf(mode)} 条，报告已保存到「函证统计结果」。`,
        severity: "success",
        outputPaths,
        result: {
          mode,
          inputPath,
          statistics: CONFIRMATION_STATISTICS,
          reports,
          outputDirectory: `${DEMO_DIR}\\函证统计结果`,
          outputPaths,
          engine: "rust",
        },
      },
    ];
  },

  // WpServicePage：completed 的 result 直接交给通用 ResultView——消费 outputPaths /
  // outputPath / splitFile（结果文件按钮）、services / aud2026Rows 等数字指标、
  // unmatchedSectionOrders（未匹配服务单）、outlookDifferences（工时核对不一致清单）。
  "wp.generate": (params) => {
    const folder = asString(params.folder) || WP_FOLDER;
    const result = WP_GENERATE_RESULT(folder);
    return [
      {
        phase: "queued",
        current: 0,
        total: 3,
        message: "排队生成 WP 服务方案…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 1,
        total: 3,
        message: "输入文件检查通过（WP 服务单 + Section List）…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 2,
        total: 3,
        message: "正在匹配 Section List 并生成服务方案和汇总文件…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 3,
        total: 3,
        message: "正在写出四类自动拆分工作簿并核对 Outlook 工时…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "completed",
        current: 3,
        total: 3,
        message: `生成完成：${result.services} 个服务方案已汇总并拆分，工时核对一致 ${result.outlookEqual} / ${result.outlookCompared} 项。`,
        severity: "success",
        outputPaths: result.outputPaths,
        result,
      },
    ];
  },
};
