// 通用工具的浏览器预览演示数据，覆盖四个工具的同步 engineCall 方法：
//   1. Excel 批量合并（ExcelMergerPage）：excel_merger.expand_paths / scan_folder / inspect
//   2. 两列模糊匹配（FuzzyMatchPage）：fuzzy.inspect / get_results / save_confirm
//   3. TBJE 完整性核对（TbjeCheckPage）：deposit.classify_source / fx.inspect_tb / fx.inspect_je /
//      ledger.check_mapping_alignment / ledger.forms / ledger.review_mapping / ledger.review_pair_mapping
//   4. 正负数凭证标记（JeSignMarkPage）：kanzhang.mark_sign_report / llm_mapping / accounts / column_values
// 返回值形状与各页面源码及对应 Rust 方法（excel_merger.rs / fuzzy_match.rs / fx / ledger_mapping /
// kanzhang）的真实返回一一对应；job 类任务（合并执行、fuzzy.match、tbje_check.run_batch、
// kanzhang.mark_inspect / mark_export）走事件流，不在本文件范围内。
// 仅浏览器预览 + 演示开关（localStorage audit-toolbox.demo-data = "1"）时被 demoRegistry 收拢生效。

// ────────────────────────────── 小工具函数 ──────────────────────────────

type DemoParams = Record<string, unknown>;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** 从路径取文件名，兼容正反斜杠。 */
const fileNameOf = (path: string): string =>
  path.split(/[\\/]/).pop() ?? path;

const DEMO_DIR = "C:\\演示数据";

// ────────────────────────────── 1. Excel 批量合并 ──────────────────────────────

/** 文件名 → 检查结果；Sheet 名一律中文，与 Rust inspect 的 files 行结构一致。 */
const MERGER_FILE_TABLE: Record<
  string,
  { size: number; sheets: string[]; error?: string }
> = {
  "样例文件.xlsx": { size: 36_864, sheets: ["销售出库单", "回款登记"] },
  "1月销售明细.xlsx": { size: 48_213, sheets: ["销售出库单", "回款登记"] },
  "2月销售明细.xlsx": { size: 51_872, sheets: ["销售出库单", "回款登记"] },
  "3月销售明细.xlsx": {
    size: 55_410,
    sheets: ["销售出库单", "回款登记", "汇总核对"],
  },
  "往来账龄分析.xlsx": { size: 22_988, sheets: ["应收账龄", "应付账龄"] },
  "银行流水导出.csv": { size: 8_356, sheets: [] },
  "旧版报表备份.xls": {
    size: 39_424,
    sheets: [],
    error: "无法读取工作簿：文件格式无法识别",
  },
};

/** 未命中文件名表时的兜底结果，按扩展名区分分隔文本与工作簿。 */
const fallbackMergerEntry = (name: string): { size: number; sheets: string[] } =>
  /\.(csv|txt)$/i.test(name)
    ? { size: 12_640, sheets: [] }
    : { size: 32_768, sheets: ["序时账", "辅助明细"] };

type MergerFileRow = {
  path: string;
  name: string;
  size: number;
  sheets: string[];
  format: string;
  error: string | null;
};

const toMergerFile = (path: string): MergerFileRow => {
  const name = fileNameOf(path);
  const entry = MERGER_FILE_TABLE[name] ?? fallbackMergerEntry(name);
  const isText = /\.(csv|txt)$/i.test(name);
  return {
    path,
    name,
    size: entry.size,
    sheets: entry.sheets,
    format: entry.error ? "格式未识别" : isText ? "分隔文本" : "Excel 工作簿",
    error: entry.error ?? null,
  };
};

const DEFAULT_MERGER_PATHS = [
  `${DEMO_DIR}\\1月销售明细.xlsx`,
  `${DEMO_DIR}\\2月销售明细.xlsx`,
  `${DEMO_DIR}\\3月销售明细.xlsx`,
  `${DEMO_DIR}\\往来账龄分析.xlsx`,
  `${DEMO_DIR}\\银行流水导出.csv`,
  `${DEMO_DIR}\\旧版报表备份.xls`,
];

const mergerInspectResult = (paths: string[]) => {
  const files = (paths.length ? paths : DEFAULT_MERGER_PATHS).map(toMergerFile);
  const availableSheets: string[] = [];
  for (const file of files) {
    for (const sheet of file.sheets) {
      if (!availableSheets.includes(sheet)) availableSheets.push(sheet);
    }
  }
  return {
    fileCount: files.length,
    files,
    availableSheets,
    engine: "rust",
  };
};

// ────────────────────────────── 2. 两列模糊匹配 ──────────────────────────────

type FuzzySourceDemo = {
  sheet: string;
  sheets: string[];
  headers: string[];
  rows: string[][];
};

/** 来源 A：待核对清单（客户往来名称）；来源 B：基准清单（工商登记名称）。 */
const FUZZY_SOURCE_A: FuzzySourceDemo = {
  sheet: "客户往来",
  sheets: ["客户往来", "预收明细"],
  headers: ["客户名称", "往来余额", "备注"],
  rows: [
    ["北京华信科技有限公司", "356200.00", "华东区域"],
    ["中恒建设集团有限责任公司", "1285000.00", ""],
    ["广州穗联贸易有限公司", "98760.50", "月结30天"],
    ["深圳市恒信达电子有限公司", "223400.00", ""],
    ["杭州云栖信息技术有限公司", "15800.00", "预付"],
    ["川南重型装备制造公司", "866000.00", ""],
    ["武汉长江重工机械公司", "512300.00", "账龄1-2年"],
    ["天津渤海化工集团", "2095000.00", ""],
    ["西安秦源建材经营部", "43200.00", "现金结算"],
    ["海南椰岛贸易商行", "76900.00", ""],
  ],
};

const FUZZY_SOURCE_B: FuzzySourceDemo = {
  sheet: "工商登记",
  sheets: ["工商登记", "变更记录"],
  headers: ["单位名称", "统一社会信用代码", "登记状态"],
  rows: [
    ["北京华信科技有限公司", "91110108MA01X8A71K", "存续"],
    ["中恒建设集团有限公司", "91440101MA99B2J45L", "存续"],
    ["广州穗联贸易有限公司", "91440106MA52C6Q30X", "存续"],
    ["深圳恒信达电子科技有限公司", "91440300MA5F8K2M7B", "存续"],
    ["杭州云栖信息科技有限公司", "91330106MA2H8P9Q4F", "存续"],
    ["川南重型装备制造股份有限公司", "91510100MA6C2T8R9A", "存续"],
    ["武汉长江重工机械有限公司", "91420100MA4K9D3E2C", "存续"],
    ["武汉长江重工机械股份有限公司", "91420100MA4K9D3F3D", "存续"],
    ["天津渤海化工股份有限公司", "91120116MA07J5K06W", "存续"],
    ["陕西秦源水泥股份有限公司", "91610100MA6X2V1H5P", "存续"],
  ],
};

type FuzzyCandidateDemo = {
  bIndex: number;
  bValue: string;
  level: "auto" | "suspect";
  total: number;
  breakdown: { charSim: number; lcsSim: number; tokenOverlap: number };
  reasons: string[];
};

/** 与 Rust fuzzy_match.rs 同口径：分数与分项都是 0–100、保留一位小数。 */
const fuzzyCandidate = (
  bIndex: number,
  level: "auto" | "suspect",
  total: number,
  charSim: number,
  lcsSim: number,
  tokenOverlap: number,
  reasons: string[],
): FuzzyCandidateDemo => ({
  bIndex,
  bValue: FUZZY_SOURCE_B.rows[bIndex][0],
  level,
  total,
  breakdown: { charSim, lcsSim, tokenOverlap },
  reasons,
});

/** 10 行结果：3 自动（高分）、5 疑似待确认（85 / 88 高分、81-84 中分、73 / 70 低分）、2 未匹配。 */
const FUZZY_RESULT_ROWS: Array<{
  aIndex: number;
  aValue: string;
  matches: FuzzyCandidateDemo[];
}> = [
  {
    aIndex: 0,
    aValue: FUZZY_SOURCE_A.rows[0][0],
    matches: [fuzzyCandidate(0, "auto", 100, 100, 100, 100, [])],
  },
  {
    aIndex: 1,
    aValue: FUZZY_SOURCE_A.rows[1][0],
    matches: [fuzzyCandidate(1, "auto", 94.2, 92.3, 95.7, 94.1, [])],
  },
  {
    aIndex: 2,
    aValue: FUZZY_SOURCE_A.rows[2][0],
    matches: [fuzzyCandidate(2, "auto", 100, 100, 100, 100, [])],
  },
  {
    aIndex: 3,
    aValue: FUZZY_SOURCE_A.rows[3][0],
    matches: [
      fuzzyCandidate(3, "suspect", 88.4, 86.2, 90.9, 87.5, [
        "行政区域不一致，需人工确认",
      ]),
    ],
  },
  {
    aIndex: 4,
    aValue: FUZZY_SOURCE_A.rows[4][0],
    matches: [fuzzyCandidate(4, "suspect", 81.7, 80.0, 84.2, 81.1, [])],
  },
  {
    aIndex: 5,
    aValue: FUZZY_SOURCE_A.rows[5][0],
    matches: [fuzzyCandidate(5, "suspect", 85.2, 88.9, 86.7, 82.4, [])],
  },
  {
    aIndex: 6,
    aValue: FUZZY_SOURCE_A.rows[6][0],
    matches: [
      fuzzyCandidate(6, "suspect", 84.6, 88.2, 86.4, 81.9, []),
      fuzzyCandidate(7, "suspect", 73.1, 71.4, 76.2, 71.5, ["字号包含"]),
    ],
  },
  {
    aIndex: 7,
    aValue: FUZZY_SOURCE_A.rows[7][0],
    matches: [
      fuzzyCandidate(8, "suspect", 72.8, 70.6, 75.8, 71.2, [
        "字号包含",
        "行政区域不一致，需人工确认",
      ]),
    ],
  },
  { aIndex: 8, aValue: FUZZY_SOURCE_A.rows[8][0], matches: [] },
  { aIndex: 9, aValue: FUZZY_SOURCE_A.rows[9][0], matches: [] },
];

const FUZZY_MATCH_RESULT = {
  summary: {
    rowsA: 10,
    rowsB: 10,
    autoCount: 3,
    suspectCount: 5,
    unmatchedCount: 2,
    invalidCount: 0,
    elapsedMs: 1268,
  },
  rows: FUZZY_RESULT_ROWS,
  confirmations: [] as Array<unknown>,
};

const fuzzyInspectResult = (kind: unknown, source: unknown) => {
  const demo = kind === "b" ? FUZZY_SOURCE_B : FUZZY_SOURCE_A;
  const requested = asString(asRecord(source).sheet);
  const sheet = demo.sheets.includes(requested) ? requested : demo.sheet;
  return {
    headers: demo.headers,
    preview: demo.rows,
    rowCount: demo.rows.length,
    sheet,
    sheets: demo.sheets,
  };
};

// ────────────────────────────── 3. TBJE 完整性核对 ──────────────────────────────

const DEMO_ENTITY = "华北机械制造有限公司";

/** TB 科目余额表预览：14 个科目分组，长中文名（编码＋名称＋四个金额列）。 */
const TB_PREVIEW: string[][] = [
  ["1002", "银行存款—中国工商银行北京分行营业部", "2860000.00", "5210350.00", "4790000.00", "3280350.00"],
  ["1122", "应收账款—华东区域销售客户往来", "1246800.00", "3550000.00", "3062000.00", "1734800.00"],
  ["1221", "其他应收款—备用金及员工差旅借支", "86500.00", "142000.00", "128500.00", "100000.00"],
  ["1403", "原材料—钢材及辅助材料采购", "954200.00", "1876000.00", "1653000.00", "1177200.00"],
  ["1601", "固定资产—机器设备与电子办公设备", "5820000.00", "460000.00", "0.00", "6280000.00"],
  ["1602", "累计折旧—机器设备折旧计提", "-1360000.00", "0.00", "315000.00", "-1675000.00"],
  ["2001", "短期借款—银行流动资金贷款", "2000000.00", "1200000.00", "800000.00", "1600000.00"],
  ["2202", "应付账款—基础设施建设分包商", "1654300.00", "2380000.00", "2654300.00", "1928600.00"],
  ["2211", "应付职工薪酬—工资、奖金与社会保险费", "486200.00", "1650000.00", "1620500.00", "515700.00"],
  ["2221", "应交税费—应交增值税（进项税额）", "126800.00", "316500.00", "289300.00", "154000.00"],
  ["2221", "应交税费—应交增值税（销项税额）", "204600.00", "598700.00", "542100.00", "261200.00"],
  ["6001", "主营业务收入—机电设备销售收入", "0.00", "0.00", "12600000.00", "0.00"],
  ["6401", "主营业务成本—机电设备销售成本", "0.00", "9860000.00", "0.00", "0.00"],
  ["6602", "管理费用—办公费、差旅费与业务招待费", "0.00", "742300.00", "0.00", "0.00"],
];

const TB_HEADERS = [
  "科目编码",
  "科目名称",
  "年初余额",
  "本年累计借方发生",
  "本年累计贷方发生",
  "期末余额",
];

const TB_SHEETS = ["科目余额表", "辅助余额表"];

/** 序时账预览：12 行凭证分录，借贷金额逐张凭证配平。 */
const JE_PREVIEW: string[][] = [
  ["2025-12-01", "记-0001", "记", "赊销机电设备一批，货款未收", "1122", "应收账款—华东区域销售客户往来", "1135000.00", ""],
  ["2025-12-01", "记-0001", "记", "结转机电设备销售收入", "6001", "主营业务收入—机电设备销售收入", "", "1000000.00"],
  ["2025-12-01", "记-0001", "记", "计提销项税额", "2221", "应交税费—应交增值税（销项税额）", "", "135000.00"],
  ["2025-12-05", "记-0002", "记", "收到华东客户部分货款", "1002", "银行存款—中国工商银行北京分行营业部", "800000.00", ""],
  ["2025-12-05", "记-0002", "记", "冲减应收账款", "1122", "应收账款—华东区域销售客户往来", "", "800000.00"],
  ["2025-12-12", "记-0003", "记", "赊购钢材及辅助材料", "1403", "原材料—钢材及辅助材料采购", "460000.00", ""],
  ["2025-12-12", "记-0003", "记", "抵扣进项税额", "2221", "应交税费—应交增值税（进项税额）", "59800.00", ""],
  ["2025-12-12", "记-0003", "记", "应付分包商货款挂账", "2202", "应付账款—基础设施建设分包商", "", "519800.00"],
  ["2025-12-20", "记-0004", "记", "计提本月工资及社保", "6602", "管理费用—办公费、差旅费与业务招待费", "286500.00", ""],
  ["2025-12-20", "记-0004", "记", "应付职工薪酬贷方计提", "2211", "应付职工薪酬—工资、奖金与社会保险费", "", "286500.00"],
  ["2025-12-26", "记-0005", "记", "计提本月设备折旧", "6602", "管理费用—办公费、差旅费与业务招待费", "58400.00", ""],
  ["2025-12-26", "记-0005", "记", "累计折旧贷方计提", "1602", "累计折旧—机器设备折旧计提", "", "58400.00"],
];

const JE_HEADERS = [
  "凭证日期",
  "凭证号",
  "凭证字",
  "摘要",
  "科目编码",
  "科目名称",
  "借方金额",
  "贷方金额",
];

const JE_SHEETS = ["序时账", "银行日记账"];

const tbInspectResult = (source: unknown) => {
  const requested = asString(asRecord(source).sheet);
  return {
    headers: TB_HEADERS,
    sheet: TB_SHEETS.includes(requested) ? requested : TB_SHEETS[0],
    sheets: TB_SHEETS,
    headerRow: 1,
    headerDepth: 1,
    rowCount: TB_PREVIEW.length,
    preview: TB_PREVIEW,
    entities: [DEMO_ENTITY],
    accounts: TB_PREVIEW.map((row) => `${row[0]} ${row[1]}`),
    suggestedMapping: {
      accountCode: "科目编码",
      accountName: ["科目名称"],
      openingFunctionalAmount: "年初余额",
      ytdFunctionalDebit: "本年累计借方发生",
      ytdFunctionalCredit: "本年累计贷方发生",
      closingFunctionalAmount: "期末余额",
    },
    suggestedAccountRoles: {},
    mappingCandidates: [] as Array<unknown>,
    headerDetection: { needsConfirmation: false, candidates: [] as Array<unknown> },
    dataYears: [2025],
  };
};

const jeInspectResult = (source: unknown) => {
  const requested = asString(asRecord(source).sheet);
  return {
    headers: JE_HEADERS,
    sheet: JE_SHEETS.includes(requested) ? requested : JE_SHEETS[0],
    sheets: JE_SHEETS,
    headerRow: 1,
    headerDepth: 1,
    rowCount: JE_PREVIEW.length,
    preview: JE_PREVIEW,
    entities: [DEMO_ENTITY],
    accounts: JE_PREVIEW.map((row) => `${row[4]} ${row[5]}`),
    suggestedMapping: {
      id: ["凭证号"],
      date: "凭证日期",
      summary: "摘要",
      accountCode: "科目编码",
      accountName: ["科目名称"],
      functionalDebit: "借方金额",
      functionalCredit: "贷方金额",
    },
    suggestedAccountRoles: {},
    mappingCandidates: [] as Array<unknown>,
    headerDetection: { needsConfirmation: false, candidates: [] as Array<unknown> },
    dataYears: [2025],
  };
};

/** 按路径判 TB/JE：分类得分必须过 5 分的可见线，否则页面会把 Sheet 当低置信度隐藏。 */
const classifyLedgerSource = (params: DemoParams) => {
  const source = asRecord(params.source);
  const path = asString(source.inputPath);
  const isJe = /序时账|明细账|日记账|JE/i.test(path);
  const isTb = /余额表|TB/i.test(path);
  const kind = isJe && !isTb ? "je" : "tb";
  const sheets = kind === "je" ? JE_SHEETS : TB_SHEETS;
  const requested = asString(source.sheet);
  return {
    kind,
    scores: kind === "je" ? { je: 12, tb: 0 } : { je: 0, tb: 12 },
    confidence: 0.92,
    needsLlm: false,
    sheet: sheets.includes(requested) ? requested : sheets[0],
    sheets,
    headerRow: 1,
    headerDepth: 1,
    headers: kind === "je" ? JE_HEADERS : TB_HEADERS,
    preview: [] as string[][],
  };
};

/** 账表形态定义（与 Rust ledger_mapping::forms 下发的形状一致，演示取代表性几型）。 */
const LEDGER_FORMS: Record<string, Array<Record<string, unknown>>> = {
  tb: [
    {
      id: "TB1",
      display: "TB-类型A",
      label: "本位币净额",
      anyOf: [],
      required: [
        ["openingFunctionalAmount"],
        ["closingFunctionalAmount"],
        ["ytdFunctionalDebit", "ytdFunctionalCredit"],
      ],
      optional: [["ytdForeignDebit", "ytdForeignCredit"]],
    },
    {
      id: "TB3",
      display: "TB-类型C",
      label: "本位币借贷分列",
      anyOf: [],
      required: [
        ["openingFunctionalDebit", "openingFunctionalCredit"],
        ["closingFunctionalDebit", "closingFunctionalCredit"],
        ["ytdFunctionalDebit", "ytdFunctionalCredit"],
      ],
      optional: [["ytdForeignDebit", "ytdForeignCredit"]],
    },
  ],
  je: [
    {
      id: "JE1",
      display: "JE-类型A",
      label: "借贷分列",
      anyOf: [],
      required: [["functionalDebit", "functionalCredit"]],
      optional: [["direction", "currency"]],
    },
    {
      id: "JE2",
      display: "JE-类型B",
      label: "本位币有符号金额",
      anyOf: [],
      required: [["functionalAmount"]],
      optional: [["currency"]],
    },
  ],
};

/** LLM 复核演示：按表头关键字给映射建议，页面对同列建议会自动判为"无需改动"。 */
const KANZHANG_ROLE_KEYWORDS: Array<[string, RegExp]> = [
  ["date", /日期|期间$/],
  ["id", /凭证号|凭证编号|单据号/],
  ["summary", /摘要|事由|说明/],
  ["accountCode", /科目编码|科目代码|科目编号/],
  ["accountName", /科目名称|^科目$|科目全称/],
  ["functionalDebit", /借方/],
  ["functionalCredit", /贷方/],
  ["direction", /方向/],
];

const kanzhangLlmMapping = (params: DemoParams) => {
  const payload = asRecord(params.payload);
  const headers = asStringArray(payload.headers);
  const fills = headers
    .map((header) => {
      const role = KANZHANG_ROLE_KEYWORDS.find(([, pattern]) =>
        pattern.test(header),
      );
      return role
        ? {
            role: role[0],
            suggestedColumn: header,
            confidence: 0.95,
            reason: "按表头关键字匹配（演示数据）",
          }
        : undefined;
    })
    .filter((item) => item !== undefined);
  return { fills };
};

// ────────────────────────────── 4. 正负数凭证标记 ──────────────────────────────

/** 金额符号口径报告：方案 B（借贷分列）成立，自动检测结论与依据一并下发。 */
const MARK_SIGN_REPORT = {
  signConvention: {
    scheme: "B",
    detected: "unsigned",
    basis: "48 张借贷齐全的凭证按「借贷符号一样」配平，取多数。",
    totalVouchers: 48,
    balancedVouchers: 47,
    unbalancedVouchers: 1,
    filtered: false,
    keySuspect: false,
  },
};

/** 科目通道：与取值同序的编码数组，值为「编码-名称」拼接串。 */
const kanzhangAccounts = () => ({
  values: TB_PREVIEW.map((row) => `${row[0]}-${row[1]}`),
  codes: TB_PREVIEW.map((row) => row[0]),
  total: TB_PREVIEW.length,
  truncated: false,
});

/** 列取值演示：按字段名关键字挑一组贴近业务的取值（≥12 个）。 */
const columnValuesPool = (field: string): string[] => {
  if (/日期|期间/.test(field))
    return [
      "2025-12-01", "2025-12-05", "2025-12-08", "2025-12-12", "2025-12-15",
      "2025-12-18", "2025-12-20", "2025-12-22", "2025-12-25", "2025-12-26",
      "2025-12-30", "2025-12-31",
    ];
  if (/凭证号|凭证编号|单据号/.test(field))
    return Array.from({ length: 12 }, (_, index) => `记-${String(index + 1).padStart(4, "0")}`);
  if (/凭证字|凭证类型|类型/.test(field)) return ["记", "收", "付", "转"];
  if (/借方|贷方|金额|余额/.test(field))
    return [
      "1135000.00", "1000000.00", "135000.00", "800000.00", "460000.00",
      "59800.00", "519800.00", "286500.00", "58400.00", "234000.00",
      "156800.00", "92000.00",
    ];
  if (/科目/.test(field)) return TB_PREVIEW.map((row) => row[1]);
  return [...new Set(JE_PREVIEW.map((row) => row[3]))];
};

const kanzhangColumnValues = (params: DemoParams) => {
  const keyword = asString(params.keyword);
  const pool = columnValuesPool(asString(params.field));
  const values = keyword ? pool.filter((value) => value.includes(keyword)) : pool;
  return { values, total: values.length, truncated: false };
};

// ────────────────────────────── 注册表 ──────────────────────────────

export const handlers: Record<string, (params: DemoParams) => unknown> = {
  // Excel 批量合并
  "excel_merger.expand_paths": (params) => {
    const paths = asStringArray(params.paths);
    return { inputPaths: paths, fileCount: paths.length };
  },
  "excel_merger.scan_folder": (params) => {
    const folder = asString(params.folder) || `${DEMO_DIR}\\销售台账`;
    const inputPaths = [
      `${folder}\\1月销售明细.xlsx`,
      `${folder}\\2月销售明细.xlsx`,
      `${folder}\\3月销售明细.xlsx`,
    ];
    return { folder, inputPaths, fileCount: inputPaths.length };
  },
  "excel_merger.inspect": (params) =>
    mergerInspectResult(asStringArray(params.inputPaths)),

  // 两列模糊匹配
  "fuzzy.inspect": (params) => fuzzyInspectResult(params.kind, params.source),
  "fuzzy.get_results": () => FUZZY_MATCH_RESULT,
  "fuzzy.save_confirm": () => ({ saved: true }),

  // TBJE 完整性核对
  "deposit.classify_source": (params) => classifyLedgerSource(params),
  "fx.inspect_tb": (params) => tbInspectResult(params.source),
  "fx.inspect_je": (params) => jeInspectResult(params.source),
  "ledger.check_mapping_alignment": () => ({ aligned: true, warnings: [] }),
  "ledger.forms": (params) => LEDGER_FORMS[asString(params.kind)] ?? [],
  "ledger.review_mapping": () => ({ changes: [] }),
  "ledger.review_pair_mapping": () => ({
    tbChanges: [],
    jeChanges: [],
    pairFindings: [],
  }),

  // 正负数凭证标记
  "kanzhang.mark_sign_report": () => MARK_SIGN_REPORT,
  "kanzhang.llm_mapping": (params) => kanzhangLlmMapping(params),
  "kanzhang.accounts": () => kanzhangAccounts(),
  "kanzhang.column_values": (params) => kanzhangColumnValues(params),
};
