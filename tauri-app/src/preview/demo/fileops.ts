// 文件操作三件的浏览器预览演示数据：
//   1. 文件夹超链接清单（FileListDirectoryPage）：file_list.scan / file_list.export
//   2. 回函 PDF 转 Excel（PdfToExcelPage）：pdf2excel.convert
//   3. TS 工时透视（TsManagerParityPage）：ts.inspect / ts.filter / ts.export
// 返回值形状与各页面源码及对应 Rust 方法（file_list.rs / pdf_to_excel.rs / tabular.rs 的
// inspect_ts / ts_filter_values / ts_filter_preview / export_ts）的真实返回一一对应。
//
// PDF 转 Excel 页拖放/选文件夹时还会调 excel_merger.expand_paths，该方法已由
// utility.ts（Excel 批量合并）覆盖且行为一致，这里不重复注册。
// 仅浏览器预览 + 演示开关（localStorage audit-toolbox.demo-data = "1"）时生效。

type DemoParams = Record<string, unknown>;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** 从路径取文件名，兼容正反斜杠。 */
const fileNameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** 从路径取所在目录；根目录取不到时回退演示根目录。 */
const parentDirOf = (path: string): string => {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : "C:\\演示数据";
};

const DEMO_DIR = "C:\\演示数据";

// ────────────────────────────── 1. 文件夹超链接清单 ──────────────────────────────

const DEFAULT_SOURCE_DIR = `${DEMO_DIR}\\审计底稿`;

/** 扫描预览：目录层级（不含源目录本身）与文件名，覆盖 1～3 级深浅不一的形态。 */
const FILE_LIST_PREVIEW: Array<{ levels: string[]; name: string }> = [
  { levels: ["2025年报表", "凭证", "银行"], name: "1月银行日记账.xlsx" },
  { levels: ["2025年报表", "凭证", "银行"], name: "2月银行日记账.xlsx" },
  { levels: ["2025年报表", "凭证", "现金"], name: "现金盘点表.xlsx" },
  { levels: ["2025年报表", "序时账"], name: "记账凭证序时簿.xlsx" },
  { levels: ["2025年报表"], name: "科目余额表-2025年度.xlsx" },
  { levels: ["底稿", "货币资金"], name: "银行存款明细表.xlsx" },
  { levels: ["底稿", "货币资金"], name: "银行函证发出清单.xlsx" },
  { levels: ["底稿", "收入循环"], name: "收入截止性测试.xlsx" },
  { levels: ["底稿", "收入循环"], name: "前五大客户函证清单.xlsx" },
  { levels: ["底稿", "往来款项"], name: "应收账款账龄表.xlsx" },
  { levels: ["底稿", "往来款项"], name: "其他应收款明细表.xlsx" },
  { levels: ["底稿", "盘点", "存货"], name: "存货监盘记录.xlsx" },
  { levels: ["底稿", "盘点", "固定资产"], name: "固定资产盘点表.xlsx" },
  { levels: ["对外报送"], name: "管理层声明书-签署版.pdf" },
];

const FILE_LIST_SKIPPED = [`${DEFAULT_SOURCE_DIR}\\历史归档`];

/** 与 Rust scan 一致：fileCount 含未进预览的文件，previewLimit 50。 */
const FILE_LIST_SCAN_BASE = {
  fileCount: 18,
  maxDepth: 3,
  skippedPaths: FILE_LIST_SKIPPED,
  previewLimit: 50,
};

const fileListScan = (sourceDir: string) => {
  const rootName = fileNameOf(sourceDir) || "审计底稿";
  return {
    sourceDir,
    rootName,
    ...FILE_LIST_SCAN_BASE,
    preview: FILE_LIST_PREVIEW.map(({ levels, name }) => ({
      name,
      relativePath: [...levels, name].join("\\"),
      fullPath: [sourceDir, ...levels, name].join("\\"),
      levels,
    })),
    outputPath: `${parentDirOf(sourceDir)}\\${rootName}List-20260905_1426.xlsx`,
  };
};

// ────────────────────────────── 2. 回函 PDF 转 Excel ──────────────────────────────

/** 每份样例 PDF 的转换结果（2 成功 + 1 扫描件失败，让两种状态行都能被检查）。 */
const PDF_FILE_RESULTS: Record<
  string,
  { pages: number; textRows: number; tables: number; tableDataRows: number; error: string }
> = {
  "工商银行询证函回函.pdf": {
    pages: 2,
    textRows: 46,
    tables: 1,
    tableDataRows: 12,
    error: "",
  },
  "建设银行询证函回函.pdf": {
    pages: 3,
    textRows: 68,
    tables: 2,
    tableDataRows: 26,
    error: "",
  },
  "华信客户回函扫描件.pdf": {
    pages: 1,
    textRows: 0,
    tables: 0,
    tableDataRows: 0,
    error: "这个 PDF 提取不到文字，可能是扫描件/图片版。",
  },
};

const fallbackPdfResult = (name: string) =>
  /扫描|scan/i.test(name)
    ? PDF_FILE_RESULTS["华信客户回函扫描件.pdf"]
    : { pages: 2, textRows: 52, tables: 1, tableDataRows: 14, error: "" };

// ────────────────────────────── 3. TS 工时透视 ──────────────────────────────

/** 12 行工时明细：9 行 ASU 部门 + 3 行 GDS 部门，默认按部门筛选后命中 9 行。 */
const TS_HEADERS = [
  "Employee GPN",
  "Employee Name",
  "Employee Rank Name",
  "COE Manager",
  "Department Name",
  "Engagement Code",
  "Engagement Name",
  "Engagement Type",
  "Time Type Desc",
  "Transaction Cycle Date",
  "Hours",
];

const TS_ROWS: string[][] = [
  ["50123456", "王晓彤", "Senior Associate", "李明哲", "ASU Delivery Center ZZ-WP", "E12345", "华东集团2025年报审计", "AUD", "Regular Hours", "2026-08-01", "7.5"],
  ["50123456", "王晓彤", "Senior Associate", "李明哲", "ASU Delivery Center ZZ-WP", "E12346", "北方实业IPO尽职调查", "Due Diligence", "Regular Hours", "2026-08-01", "2.5"],
  ["50210873", "陈志远", "Associate", "李明哲", "ASU Delivery Center ZZ-WP", "E12345", "华东集团2025年报审计", "AUD", "Regular Hours", "2026-08-01", "8"],
  ["50210873", "陈志远", "Associate", "李明哲", "ASU Delivery Center ZZ-WP", "E12345", "华东集团2025年报审计", "AUD", "Overtime Hours", "2026-08-01", "3"],
  ["50334219", "林芳如", "Senior", "周文彬", "ASU Delivery Center ZZ-WP", "E12346", "北方实业IPO尽职调查", "Due Diligence", "Regular Hours", "2026-08-01", "7.5"],
  ["50334219", "林芳如", "Senior", "周文彬", "ASU Delivery Center ZZ-WP", "E12346", "北方实业IPO尽职调查", "Due Diligence", "Public Holiday Hours", "2026-08-01", "4"],
  ["50445102", "赵一鸣", "Manager", "周文彬", "GDS Consulting Center SH-01", "E12348", "华瑞公司2026中期审阅", "Review", "Regular Hours", "2026-08-01", "6"],
  ["50558830", "孙启文", "Senior Associate", "李明哲", "ASU Delivery Center ZZ-WP", "E12345", "华东集团2025年报审计", "AUD", "Regular Hours", "2026-08-01", "7.5"],
  ["50558830", "孙启文", "Senior Associate", "李明哲", "ASU Delivery Center ZZ-WP", "E12347", "恒信公司2025年报审计", "AUD", "Regular Hours", "2026-08-01", "5"],
  ["50662147", "何嘉怡", "Associate", "周文彬", "GDS Consulting Center SH-01", "E12348", "华瑞公司2026中期审阅", "Review", "Regular Hours", "2026-08-01", "8"],
  ["50662147", "何嘉怡", "Associate", "周文彬", "GDS Consulting Center SH-01", "E12348", "华瑞公司2026中期审阅", "Review", "Overtime Hours", "2026-08-01", "2"],
  ["50779563", "郑博文", "Senior", "周文彬", "ASU Delivery Center ZZ-WP", "E12346", "北方实业IPO尽职调查", "Due Diligence", "Regular Hours", "2026-08-01", "7.5"],
];

/** 与 tabular.rs 的 ts_defaults 同口径（本表不含 COE Senior，按现有列给出）。 */
const TS_DEFAULTS = {
  filterField: "Department Name",
  filterValue: "ASU Delivery Center ZZ-WP",
  valueField: "Hours",
  columnField: "Transaction Cycle Date",
  managerRowFields: [
    "COE Manager",
    "Employee Name",
    "Employee Rank Name",
    "Engagement Name",
    "Engagement Code",
    "Engagement Type",
    "Time Type Desc",
    "Employee GPN",
  ],
  projectRowFields: [
    "Engagement Name",
    "Employee Name",
    "COE Manager",
    "Employee Rank Name",
    "Engagement Code",
    "Engagement Type",
    "Time Type Desc",
    "Employee GPN",
  ],
};

const tsInspectResult = (inputPath: string, sheet: string) => ({
  engine: "rust-polars",
  sourceFingerprint: `demo:${inputPath}`,
  path: inputPath,
  sheets: sheet === "" ? ["FY27 Timesheet", "说明页"] : [sheet || "FY27 Timesheet"],
  selectedSheet: sheet || "FY27 Timesheet",
  headers: TS_HEADERS,
  preview: TS_ROWS.slice(0, 20),
  dimensions: { rows: TS_ROWS.length, columns: TS_HEADERS.length },
  encoding: "xlsx",
  delimiter: null,
  defaults: TS_DEFAULTS,
  cacheHit: false,
  cachePath: "",
  timings: { readMs: 320 },
});

const TS_FIELD_INDEX = new Map(TS_HEADERS.map((header, index) => [header, index]));

/** 空单元格按引擎口径显示为「<空白>」，参与筛选与取值清单。 */
const cellValue = (row: string[], index: number) =>
  row[index]?.trim() ? row[index].trim() : "<空白>";

/** ts.filter 取值清单：BTreeSet 去重排序 + 关键词包含 + limit 截断，与引擎一致。 */
const tsFilterValues = (params: DemoParams) => {
  const field = asString(params.field);
  const keyword = asString(params.keyword).toLowerCase();
  const limitRaw = typeof params.limit === "number" && Number.isFinite(params.limit)
    ? Math.trunc(params.limit)
    : 1000;
  const limit = Math.min(Math.max(limitRaw, 1), 20000);
  const index = TS_FIELD_INDEX.get(field);
  const values = index === undefined
    ? []
    : [...new Set(TS_ROWS.map((row) => cellValue(row, index)))]
        .filter((value) => (keyword ? value.toLowerCase().includes(keyword) : true))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const total = values.length;
  return {
    engine: "rust-polars",
    values: values.slice(0, limit),
    total,
    truncated: total > limit,
    cacheHit: false,
  };
};

type TsFilter = { field: string; values: string[] };

const tsFiltersOf = (params: DemoParams): TsFilter[] =>
  (Array.isArray(params.filters) ? params.filters : []).flatMap((item) => {
    const record = asRecord(item);
    const field = asString(record.field);
    const values = asStringArray(record.values);
    return field && values.length ? [{ field, values }] : [];
  });

/** 与引擎 apply_filters 同口径：同列多值「或」、跨列「且」。 */
const applyTsFilters = (filters: TsFilter[]) =>
  TS_ROWS.filter((row) =>
    filters.every(({ field, values }) => {
      const index = TS_FIELD_INDEX.get(field);
      return index === undefined
        ? true
        : values.includes(cellValue(row, index));
    }),
  );

/** 透视行数：按行字段组合去重（与 pivot_rows 的可见行数同义）。 */
const pivotRowCount = (rows: string[][], fields: string[]) =>
  new Set(
    rows.map((row) =>
      fields
        .map((field) => cellValue(row, TS_FIELD_INDEX.get(field) ?? -1))
        .join("\u0001"),
    ),
  ).size;

// ────────────────────────────── 同步 handler 注册表 ──────────────────────────────

export const handlers: Record<string, (params: DemoParams) => unknown> = {
  // TS 筛选取值清单（ColumnFilterMenu 的搜索与勾选都走这里）
  "ts.filter": (params) => tsFilterValues(params),
};

// ────────────────────────────── 任务剧本（jobHandlers）──────────────────────────────
// api.ts 演示任务通道按序回放事件序列，jobId / toolId 由 api 层统一填充
// （file_list.* → file_list_directory、pdf2excel.* → pdf_to_excel、ts.* → ts_manager，
// 与页面监听过滤器一致）。completed 的 result 按"页面消费什么就给什么"逐字段给出。

import type { DemoJobEvent } from "../demoRegistry";

// ────────────────────────────── 1. 文件夹超链接清单 ──────────────────────────────
// FileListDirectoryPage：completed 后按结果形状分流——含 preview 数组即当扫描结果
// （isFileListScan），否则只取事件级 outputPaths 显示「打开结果」。

export const jobHandlers: Record<
  string,
  (params: DemoParams) => DemoJobEvent[]
> = {
  "file_list.scan": (params) => {
    const sourceDir = asString(params.sourceDir) || DEFAULT_SOURCE_DIR;
    const scan = fileListScan(sourceDir);
    return [
      {
        phase: "queued",
        current: 0,
        total: 1,
        message: "排队扫描文件夹…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 0,
        total: 1,
        message: `正在遍历「${scan.rootName}」下的全部子目录…`,
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 1,
        total: 1,
        message: "正在汇总目录层级并生成预览…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "completed",
        current: 1,
        total: 1,
        message: `扫描完成：${scan.fileCount} 个文件，最深 ${scan.maxDepth} 级目录。`,
        severity: "success",
        outputPaths: [],
        result: scan,
      },
    ];
  },
  "file_list.export": (params) => {
    const sourceDir = asString(params.sourceDir) || DEFAULT_SOURCE_DIR;
    const outputPath =
      asString(params.outputPath).trim() || fileListScan(sourceDir).outputPath;
    return [
      {
        phase: "queued",
        current: 0,
        total: 1,
        message: "排队生成文件清单…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 0,
        total: 1,
        message: `正在按 ${FILE_LIST_SCAN_BASE.maxDepth + 1} 级目录列展开 ${FILE_LIST_SCAN_BASE.fileCount} 个文件…`,
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 1,
        total: 1,
        message: "正在写入 Excel 清单并生成可点击超链接…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "completed",
        current: 1,
        total: 1,
        message: `清单已生成：${FILE_LIST_SCAN_BASE.fileCount} 个文件写入 ${fileNameOf(outputPath)}。`,
        severity: "success",
        outputPaths: [outputPath],
        result: {
          sourceDir,
          fileCount: FILE_LIST_SCAN_BASE.fileCount,
          maxDepth: FILE_LIST_SCAN_BASE.maxDepth,
          skippedPaths: FILE_LIST_SKIPPED,
          outputPaths: [outputPath],
        },
      },
    ];
  },

  // ────────────────────────────── 2. 回函 PDF 转 Excel ──────────────────────────────
  // PdfToExcelPage：completed 消费 isPdfConvertResult(event.result)——files 表格逐行渲染，
  // manifestPath / outputPaths 供「打开输出」；失败行靠 error 文案染红。

  "pdf2excel.convert": (params) => {
    const pdfPaths = asStringArray(params.pdfPaths).length
      ? asStringArray(params.pdfPaths)
      : [
          `${DEMO_DIR}\\回函PDF\\工商银行询证函回函.pdf`,
          `${DEMO_DIR}\\回函PDF\\建设银行询证函回函.pdf`,
          `${DEMO_DIR}\\回函PDF\\华信客户回函扫描件.pdf`,
        ];
    const outputDir = asString(params.outputDir).trim() || parentDirOf(pdfPaths[0]);
    const files = pdfPaths.map((path) => {
      const name = fileNameOf(path);
      const stats = PDF_FILE_RESULTS[name] ?? fallbackPdfResult(name);
      const failed = stats.error !== "";
      return {
        name,
        status: failed ? "失败" : "成功",
        pages: stats.pages,
        textRows: stats.textRows,
        tables: stats.tables,
        tableDataRows: stats.tableDataRows,
        outputPath: failed ? "" : `${outputDir}\\${name.replace(/\.pdf$/i, ".xlsx")}`,
        error: stats.error,
      };
    });
    const successCount = files.filter((file) => file.error === "").length;
    const failCount = files.length - successCount;
    const outputPaths = [
      ...files.filter((file) => file.outputPath).map((file) => file.outputPath),
      `${outputDir}\\处理清单.xlsx`,
    ];
    const manifestPath = `${outputDir}\\处理清单.xlsx`;
    const total = files.length;
    return [
      {
        phase: "queued",
        current: 0,
        total,
        message: `排队转换 ${total} 份回函 PDF…`,
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 1,
        total,
        message: `正在转换 ${fileNameOf(pdfPaths[0])}（第 1/2 页）…`,
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: Math.min(2, total),
        total,
        message: `正在转换 ${fileNameOf(pdfPaths[1] ?? pdfPaths[0])}（第 1/3 页）…`,
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: total,
        total,
        message: "正在汇总处理清单（含失败原因）…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "completed",
        current: total,
        total,
        message:
          failCount > 0
            ? `转换完成：成功 ${successCount} 份、失败 ${failCount} 份，处理清单已生成。`
            : `转换完成：${successCount} 份回函全部转成 Excel。`,
        severity: "success",
        outputPaths,
        result: {
          outputDir,
          manifestPath,
          files,
          successCount,
          failCount,
          outputPaths,
        },
      },
    ];
  },

  // ────────────────────────────── 3. TS 工时透视 ──────────────────────────────
  // TsManagerParityPage：completed 按 result 形状分流——含 sheets/defaults 即 inspect；
  // 含 preview+rows 即筛选预览；其余当导出结果（rowsManager / rowsProject / rawRows 指标）。

  "ts.inspect": (params) => {
    const inputPath = asString(params.inputPath) || `${DEMO_DIR}\\FY27 Timesheet.xlsx`;
    const sheet = asString(params.sheet);
    const inspect = tsInspectResult(inputPath, sheet);
    return [
      {
        phase: "queued",
        current: 0,
        total: 3,
        message: "排队读取 Timesheet 文件…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 1,
        total: 3,
        message: `正在读取「${fileNameOf(inputPath)}」（Sheet：${inspect.selectedSheet}）…`,
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 2,
        total: 3,
        message: "正在识别表头并生成默认透视字段…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "completed",
        current: 3,
        total: 3,
        message: `读取完成：${TS_ROWS.length} 行工时明细、${TS_HEADERS.length} 列。`,
        severity: "success",
        outputPaths: [],
        result: inspect,
      },
    ];
  },
  "ts.filter": (params) => {
    const filters = tsFiltersOf(params);
    const rows = applyTsFilters(filters);
    const describe = filters
      .map(({ field, values }) => `${field}：${values.join("、")}`)
      .join("；");
    return [
      {
        phase: "queued",
        current: 0,
        total: 2,
        message: "排队执行筛选…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 1,
        total: 2,
        message: `正在按条件筛选（${describe}）…`,
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 2,
        total: 2,
        message: "正在刷新预览行…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "completed",
        current: 2,
        total: 2,
        message: `筛选完成：命中 ${rows.length} 行 / 共 ${TS_ROWS.length} 行。`,
        severity: "success",
        outputPaths: [],
        result: {
          engine: "rust-polars",
          rows: rows.length,
          columns: TS_HEADERS.length,
          headers: TS_HEADERS,
          preview: rows.slice(0, 50),
          cacheHit: false,
          outputPaths: [],
        },
      },
    ];
  },
  "ts.export": (params) => {
    const filters = tsFiltersOf(params);
    const rows = applyTsFilters(filters);
    const outputPath =
      asString(params.outputPath).trim() || `${DEMO_DIR}\\Timesheet_Default_Dual.xlsx`;
    const rawPath = `${outputPath.replace(/\.xlsx$/i, "")}_data.csv`;
    return [
      {
        phase: "queued",
        current: 0,
        total: 5,
        message: "排队导出 Timesheet 默认双 Sheet…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 1,
        total: 5,
        message: "正在读取工时数据并应用筛选…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 2,
        total: 5,
        message: "Rust Polars 正在计算 by经理 / by项目 透视…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "running",
        current: 4,
        total: 5,
        message: "正在写出透视工作簿与对应明细 CSV…",
        severity: "info",
        outputPaths: [],
      },
      {
        phase: "completed",
        current: 5,
        total: 5,
        message: `导出完成：命中 ${rows.length} 行明细，by经理与 by项目 双 Sheet 已写出。`,
        severity: "success",
        outputPaths: [outputPath, rawPath],
        result: {
          engine: "rust-polars",
          outputPaths: [outputPath, rawPath],
          rowsManager: pivotRowCount(rows, TS_DEFAULTS.managerRowFields),
          rowsProject: pivotRowCount(rows, TS_DEFAULTS.projectRowFields),
          rawRows: rows.length,
          cacheHit: false,
          cachePath: "",
          timings: { totalMs: 1480 },
        },
      },
    ];
  },
};
