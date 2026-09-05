// 固定资产族三个工具的浏览器预览演示数据：
//   1. FA List（FaListPage）——两期固定资产清单模式 + TB＋JE 变动表模式；
//   2. 折旧测算（FaDepCalcPage）；
//   3. 折旧政策对比（FaPolicyComparePage）。
// 仅在浏览器预览模式 + localStorage["audit-toolbox.demo-data"]="1" 时，
// 经 api.ts 的 demoLookup 回放；桌面应用完全不受影响。
//
// 设计目标：让「上传 → 识别（Sheet/标题行）→ 字段映射（含 LLM 复核的已改/
// 待确认态）→ 预览」每一步都有合法返回可走通。匹配/导出类 job 方法
// （fa.match / fa.export / fa.dep_export / fa.policy_export / fa.tbje_*）
// 走 jobStart 事件流，不在演示通道范围内。
//
// 数据口径：同一批固定资产种子贯穿三个工具——两期清单里既有两期完全一致的
// 行，也有寿命/残值率变更行与仅单期存在的新增、处置行；资产名称含 20 字以上
// 长中文、资产编号为纯数字、金额带千分位，方便检查表格与映射面板的真实布局。

/** 千分位金额字符串（保留两位小数，与清单导出口径一致）。 */
const money = (value: number): string =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const round2 = (value: number): number => Math.round(value * 100) / 100;

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// ---------------------------------------------------------------------------
// 固定资产种子数据（三个工具共用同一批资产）
// ---------------------------------------------------------------------------

type FaAssetSeed = {
  code: string;
  name: string;
  category: string;
  dept: string;
  start: string;
  life: number;
  residual: number;
  original: number;
  /** 期末口径覆盖值：制造两期政策差异行（寿命/残值率变更）。 */
  endLife?: number;
  endResidual?: number;
  /** 期末新增资产业务信息。 */
  additionMethod?: string;
  additionDate?: string;
  /** 仅期初存在：本期处置，期末清单不再出现。 */
  disposed?: boolean;
};

/** 两期均在（含 2 行政策变更）+ 2 行仅期初（处置）+ 2 行仅期末（新增）。 */
const ASSETS: FaAssetSeed[] = [
  { code: "10010001", name: "高压蒸汽轮机发电机组配套凝汽器成套装置设备", category: "机器设备", dept: "动力车间", start: "2018-06-20", life: 20, residual: 5, original: 4860000 },
  { code: "10010002", name: "数控五轴联动叶片加工中心机床成套附属设备", category: "机器设备", dept: "一分厂", start: "2021-03-15", life: 12, residual: 5, original: 860000 },
  { code: "10010003", name: "智能仓储自动化立体库货架输送分拣成套设备", category: "机器设备", dept: "物流中心", start: "2022-08-01", life: 10, endLife: 12, residual: 5, original: 1260000 },
  { code: "10010004", name: "桥式双梁钩门式起重机", category: "机器设备", dept: "二分厂", start: "2016-11-10", life: 15, residual: 5, original: 720000 },
  { code: "10010005", name: "中央空调冷水机组配套冷却塔系统", category: "机器设备", dept: "综合楼", start: "2019-05-30", life: 12, residual: 5, original: 540000 },
  { code: "10010006", name: "电梯轿厢变频控制及层门保护装置", category: "电子设备", dept: "综合楼", start: "2020-01-10", life: 10, residual: 5, original: 380000 },
  { code: "10010007", name: "污水处理曝气鼓风成套装置", category: "机器设备", dept: "环保站", start: "2017-09-01", life: 10, residual: 5, endResidual: 0, original: 260000 },
  { code: "10010008", name: "变配电系统干式变压器成套开关柜", category: "机器设备", dept: "动力车间", start: "2015-04-20", life: 20, residual: 5, original: 1150000 },
  { code: "10010009", name: "实验室恒温恒湿环境试验箱设备", category: "电子设备", dept: "质检中心", start: "2022-12-05", life: 8, residual: 5, original: 96000 },
  { code: "10010010", name: "多功能会议音响扩声录播系统设备", category: "电子设备", dept: "综合楼", start: "2023-06-18", life: 6, residual: 0, original: 88000 },
  { code: "10010011", name: "新能源纯电动职工通勤大型客车", category: "运输工具", dept: "行政部", start: "2023-03-25", life: 8, residual: 5, original: 320000 },
  { code: "10010012", name: "高精度三坐标测量检验成套设备", category: "电子设备", dept: "质检中心", start: "2021-10-12", life: 10, residual: 5, original: 460000 },
  { code: "10010013", name: "厨房冷冻冷藏保鲜成套不锈钢设备", category: "电子设备", dept: "后勤部", start: "2020-07-08", life: 8, residual: 5, original: 65000 },
  { code: "10010014", name: "数据中心模块化精密空调UPS成套机组", category: "电子设备", dept: "信息中心", start: "2023-11-20", life: 10, residual: 0, original: 240000 },
  // 仅期初存在：本期处置（对应处置补充清单）。
  { code: "10010015", name: "柴油发电机组应急供电切换开关成套装置设备", category: "机器设备", dept: "动力车间", start: "2012-02-15", life: 16, residual: 5, original: 1860000, disposed: true },
  { code: "10010016", name: "老式普通卧式车床加工设备", category: "机器设备", dept: "二分厂", start: "2008-05-10", life: 14, residual: 5, original: 180000, disposed: true },
  // 仅期末存在：本期新增（对应新增补充清单）。
  { code: "10010017", name: "新能源纯电动重型自卸载货汽车及充电桩配套设施", category: "运输工具", dept: "销售部", start: "2025-04-12", life: 8, residual: 5, original: 1280000, additionMethod: "购置", additionDate: "2025-04-12" },
  { code: "10010018", name: "智能会议桌椅及办公工位隔断成套办公家具设备", category: "办公设备", dept: "综合楼", start: "2025-07-22", life: 6, residual: 0, original: 156000, additionMethod: "在建工程转入", additionDate: "2025-07-22" },
];

/** 年折旧额 = 原值 × (1 − 残值率) ÷ 使用年限。 */
const annualDepreciation = (asset: { original: number; residual: number; life: number }): number =>
  (asset.original * (1 - asset.residual / 100)) / asset.life;

/** 自开始使用到 2024-12-31 的已使用月数（近似口径，够演示用）。 */
const monthsBeforeBegin = (start: string): number => {
  const [year, month] = start.split("-").map(Number);
  if (!year || !month) return 0;
  return (2024 - year) * 12 + (12 - month);
};

/** 自开始使用到 2025-12-31 的已使用月数。 */
const monthsBeforeEnd = (start: string): number => {
  const [year, month] = start.split("-").map(Number);
  if (!year || !month) return 0;
  return (2025 - year) * 12 + (12 - month);
};

type FaAmounts = {
  beginDep: number;
  yearDep: number;
  endDep: number;
  monthlyDep: number;
};

const amountsOf = (asset: FaAssetSeed): FaAmounts => {
  const cap = asset.original * (1 - asset.residual / 100);
  const annual = annualDepreciation(asset);
  const monthly = annual / 12;
  if (asset.start >= "2025-01-01") {
    // 期末新增：期末（年初）无折旧，按在用月数计提本年折旧。
    const monthsInService = Math.max(
      0,
      monthsBeforeEnd(asset.start) - monthsBeforeBegin(asset.start),
    );
    const yearDep = round2(Math.min(cap, monthly * monthsInService));
    return { beginDep: 0, yearDep, endDep: yearDep, monthlyDep: round2(monthly) };
  }
  const beginDep = round2(Math.min(cap, monthly * monthsBeforeBegin(asset.start)));
  const endDep = round2(Math.min(cap, beginDep + annual));
  return { beginDep, yearDep: round2(annual), endDep, monthlyDep: round2(monthly) };
};

/** 两期均在的资产：期初/期末清单的主体。 */
const BOTH = ASSETS.filter((asset) => !asset.additionMethod && !asset.disposed);
const ADDED = ASSETS.filter((asset) => Boolean(asset.additionMethod));

// ---------------------------------------------------------------------------
// 两期固定资产清单（fa.inspect，FA List 清单模式 + 折旧政策对比共用）
// ---------------------------------------------------------------------------

const BEGIN_HEADERS = [
  "资产编号",
  "资产名称",
  "资产类别",
  "使用部门",
  "开始使用日期",
  "使用年限(年)",
  "残值率(%)",
  "期初原值",
  "期初累计折旧",
];

const END_HEADERS = [
  "资产编号",
  "资产名称",
  "资产类别",
  "使用部门",
  "开始使用日期",
  "使用年限(年)",
  "残值率(%)",
  "期末原值",
  "期末累计折旧",
  "本年折旧",
  "新增方式",
  "新增日期",
  "期末净值",
];

const beginRows = (): unknown[][] =>
  BOTH.concat(ASSETS.filter((asset) => asset.disposed)).map((asset) => {
    const amounts = amountsOf(asset);
    return [
      asset.code,
      asset.name,
      asset.category,
      asset.dept,
      asset.start,
      String(asset.life),
      String(asset.residual),
      money(asset.original),
      money(amounts.beginDep),
    ];
  });

const endRows = (): unknown[][] =>
  BOTH.concat(ADDED).map((asset) => {
    const amounts = amountsOf(asset);
    return [
      asset.code,
      asset.name,
      asset.category,
      asset.dept,
      asset.start,
      String(asset.endLife ?? asset.life),
      String(asset.endResidual ?? asset.residual),
      money(asset.original),
      money(amounts.endDep),
      money(amounts.yearDep),
      asset.additionMethod ?? "",
      asset.additionDate ?? "",
      money(asset.original - amounts.endDep),
    ];
  });

const MAIN_SHEETS = ["封面", "固定资产清单"];

const mainSide = (
  params: Record<string, unknown>,
  sheetKey: string,
  displayName: string,
  headers: string[],
  rows: unknown[][],
): Record<string, unknown> => ({
  headers,
  preview: rows,
  sheets: MAIN_SHEETS,
  selectedSheet: str(params[sheetKey]) || "固定资产清单",
  displayName,
  detectedHeaderRow: 1,
  dimensions: { rows: rows.length, columns: headers.length },
});

const faInspect = (params: Record<string, unknown>): unknown => ({
  begin: mainSide(params, "beginSheet", "期初固定资产清单", BEGIN_HEADERS, beginRows()),
  end: mainSide(params, "endSheet", "期末固定资产清单", END_HEADERS, endRows()),
  suggestedMapping: {
    // 期初故意缺「开始使用日期 / 残值率(%)」，让 fa.review 的
    // 「已自动修改（重点核对）」与「待确认」两类建议都有戏可演。
    begin: {
      matchKey: "资产编号",
      matchKeys: ["资产编号"],
      category: "资产类别",
      name: "资产名称",
      originalValue: "期初原值",
      depreciation: "期初累计折旧",
      life: "使用年限(年)",
    },
    end: {
      matchKey: "资产编号",
      matchKeys: ["资产编号"],
      category: "资产类别",
      name: "资产名称",
      originalValue: "期末原值",
      depreciation: "期末累计折旧",
      startDate: "开始使用日期",
      life: "使用年限(年)",
      residualRate: "残值率(%)",
      currentYearDep: "本年折旧",
      additionMethod: "新增方式",
      additionDate: "新增日期",
    },
  },
});

// ---------------------------------------------------------------------------
// 主清单 LLM 复核（fa.review，清单模式与政策对比共用）
// 建议项刻意覆盖三种 UI 状态：
//   1. 已自动修改且把握 60%~70%（变更卡 + 「重点核对」角标）；
//   2. 把握不足 60%（「待确认」卡，采纳 / 保留当前）；
//   3. 匹配键维持原状（action = keep，只出结论）。
// ---------------------------------------------------------------------------

const faReview = (): unknown => ({
  enabled: true,
  passed: true,
  message: "LLM 映射复核完成。",
  autoApplied: [
    {
      role: "date",
      file_side: "file1",
      suggested_column: "开始使用日期",
      confidence: 0.65,
      reason:
        "「开始使用日期」与入账日期口径一致，已自动补上映射；日期格式建议重点核对。",
    },
  ],
  fieldReviews: [
    {
      role: "residual",
      suggested_mapping: { file1: "残值率(%)" },
      confidence: 0.45,
      reason: "期初清单的残值率列疑似以小数存储，采纳前请先抽查数值。",
    },
  ],
  matchReview: {
    action: "keep",
    confidence: 0.86,
    reasons: ["「资产编号」在两期清单中均未发现重复，维持当前组合匹配键。"],
  },
});

// ---------------------------------------------------------------------------
// 补充清单（fa.supplement_inspect / fa.supplement_review）
// 演示通道无法区分「新增 / 处置」两张表（预览模式的文件选择器两个槽位返回
// 同一个演示路径，参数里也没有 kind 标识），因此回放同一张通用变动清单：
// 建议映射同时带新增与处置两组角色，页面按各槽位自行取用。
// ---------------------------------------------------------------------------

const SUPPLEMENT_HEADERS = [
  "资产编号",
  "资产名称",
  "变动方式",
  "变动日期",
  "变动原值",
  "累计折旧",
  "备注",
];

type SupplementSeed = {
  code: string;
  name: string;
  method: string;
  date: string;
  original: number;
  depreciation: number;
  note: string;
};

const SUPPLEMENT_ROWS: SupplementSeed[] = [
  { code: "10010017", name: "新能源纯电动重型自卸载货汽车及充电桩配套设施", method: "购置", date: "2025-04-12", original: 1280000, depreciation: 0, note: "含充电桩安装费" },
  { code: "10010018", name: "智能会议桌椅及办公工位隔断成套办公家具设备", method: "在建工程转入", date: "2025-07-22", original: 156000, depreciation: 0, note: "竣工决算转固" },
  { code: "30010001", name: "数控五轴联动叶片加工中心机床成套附属设备", method: "融资租入", date: "2025-02-18", original: 660000, depreciation: 0, note: "租赁期 5 年" },
  { code: "30010002", name: "立式加工中心刀库机械手成套装置", method: "购置", date: "2025-03-06", original: 285000, depreciation: 0, note: "" },
  { code: "30010003", name: "多功能投影显示与视频会议成套设备", method: "股东投入", date: "2025-05-09", original: 96000, depreciation: 0, note: "评估报告附后" },
  { code: "30010004", name: "实验台通风柜及净化成套设施", method: "自行建造", date: "2025-08-25", original: 188000, depreciation: 0, note: "" },
  { code: "30010005", name: "仓储高位货架及叉车充电成套设备", method: "购置", date: "2025-09-14", original: 132000, depreciation: 0, note: "分两批到货" },
  { code: "30010006", name: "食堂燃气灶具与排烟成套设备", method: "购置", date: "2025-10-21", original: 46000, depreciation: 0, note: "" },
  { code: "10010015", name: "柴油发电机组应急供电切换开关成套装置设备", method: "报废处置", date: "2025-06-30", original: 1860000, depreciation: 1418484.38, note: "事故损坏，已报批" },
  { code: "10010016", name: "老式普通卧式车床加工设备", method: "对外出售", date: "2025-05-28", original: 180000, depreciation: 171000, note: "已开票" },
  { code: "30020001", name: "窗式空调机组（老办公楼）", method: "报废处置", date: "2025-04-30", original: 32000, depreciation: 30400, note: "" },
  { code: "30020002", name: "针式打印机及配套耗材柜", method: "毁损核销", date: "2025-07-15", original: 8500, depreciation: 8075, note: "水淹受损" },
  { code: "30020003", name: "铁皮档案柜（一批六组）", method: "盘亏", date: "2025-09-30", original: 12800, depreciation: 12160, note: "待继续追查" },
  { code: "30020004", name: "台式计算机（一批十二台）", method: "对外出售", date: "2025-10-12", original: 96000, depreciation: 86400, note: "批量处置" },
  { code: "30020005", name: "电动叉车（3 吨）", method: "交换转出", date: "2025-11-06", original: 158000, depreciation: 118500, note: "非货币性资产交换" },
  { code: "30020006", name: "淋浴热水器（宿舍楼）", method: "报废处置", date: "2025-12-18", original: 21500, depreciation: 20325, note: "" },
];

const faSupplementInspect = (params: Record<string, unknown>): unknown => ({
  headers: SUPPLEMENT_HEADERS,
  preview: SUPPLEMENT_ROWS.map((row) => [
    row.code,
    row.name,
    row.method,
    row.date,
    money(row.original),
    money(row.depreciation),
    row.note,
  ]),
  // 返回两张 Sheet，让页面走「必须人工选 Sheet」分支；选中后 selectedSheet
  // 必须与参数一致，复核触发判断依赖这一点。
  sheets: ["Sheet1", "变动清单"],
  selectedSheet: str(params.sheet) || "变动清单",
  displayName: "变动清单",
  detectedHeaderRow: 1,
  dimensions: { rows: SUPPLEMENT_ROWS.length, columns: SUPPLEMENT_HEADERS.length },
  suggestedMapping: {
    matchKey: "资产编号",
    matchKeys: ["资产编号"],
    matchKeysVerified: true,
    additionMethod: "变动方式",
    additionDate: "变动日期",
    disposalMethod: "变动方式",
    disposalDate: "变动日期",
    // 处置原值/处置折旧故意留待 LLM 复核补齐：原值由 fa.supplement_review
    // 自动补上映射（变更卡），折旧把握不足留在「待确认」。
  },
});

const faSupplementReview = (): unknown => ({
  enabled: true,
  passed: true,
  message: "补充清单 LLM 复核完成。",
  autoApplied: [
    {
      role: "addition_method",
      suggested_column: "变动方式",
      confidence: 0.9,
      reason: "「变动方式」列同时承载新增与处置方式，两张补充表口径一致。",
    },
    {
      role: "disposal_orig",
      suggested_column: "变动原值",
      confidence: 0.82,
      reason: "处置原值取自「变动原值」列，与期末清单原值口径核对一致。",
    },
  ],
  fieldReviews: [
    {
      role: "disposal_dep",
      suggested_column: "累计折旧",
      confidence: 0.5,
      reason: "「累计折旧」列可能是期初口径而非处置时点口径，请确认后再采纳。",
    },
  ],
  matchReview: {
    action: "keep",
    confidence: 0.9,
    reasons: ["补充清单的「资产编号」与第一步组合匹配键逐值碰撞通过。"],
  },
});

// ---------------------------------------------------------------------------
// 折旧测算（fa.dep_inspect / fa.dep_review，单期末清单）
// ---------------------------------------------------------------------------

const DEP_HEADERS = [
  "资产编号",
  "资产名称",
  "资产类别",
  "使用部门",
  "开始使用日期",
  "使用年限(年)",
  "残值率(%)",
  "原值",
  "月初累计折旧",
  "本月折旧",
  "本年累计折旧",
  "期末净值",
];

const faDepInspect = (params: Record<string, unknown>): unknown => ({
  headers: DEP_HEADERS,
  preview: BOTH.concat(ADDED).map((asset) => {
    const amounts = amountsOf(asset);
    return [
      asset.code,
      asset.name,
      asset.category,
      asset.dept,
      asset.start,
      String(asset.life),
      String(asset.residual),
      money(asset.original),
      money(amounts.beginDep),
      money(amounts.monthlyDep),
      money(amounts.yearDep),
      money(asset.original - amounts.endDep),
    ];
  }),
  sheets: ["固定资产清单"],
  selectedSheet: str(params.sheet) || "固定资产清单",
  displayName: "期末固定资产清单",
  detectedHeaderRow: 1,
  dimensions: { rows: BOTH.length + ADDED.length, columns: DEP_HEADERS.length },
  suggestedMapping: {
    category: "资产类别",
    name: "资产名称",
    originalValue: "原值",
    depreciation: "月初累计折旧",
    startDate: "开始使用日期",
    life: "使用年限(年)",
    residualRate: "残值率(%)",
    currentYearDep: "本年累计折旧",
  },
});

const faDepReview = (): unknown => ({
  enabled: true,
  passed: true,
  message: "LLM 映射复核完成。",
  autoApplied: [
    {
      role: "life",
      suggested_column: "使用年限(年)",
      confidence: 0.94,
      reason: "列名已含年限单位，判定为使用寿命。",
    },
  ],
  fieldReviews: [
    {
      role: "current_year_dep",
      suggested_column: "本月折旧",
      confidence: 0.5,
      reason: "「本月折旧」与「本年累计折旧」口径易混，请确认本年数应取哪一列。",
    },
  ],
});

// ---------------------------------------------------------------------------
// TB＋JE 变动表（FaTbJePage，与公共账表引擎共用方法名）
// 演示为一个工作簿两张 Sheet：「序时账」(JE) + 「科目余额表」(TB)。
// ---------------------------------------------------------------------------

const JE_SHEET = "序时账";
const TB_SHEET = "科目余额表";
const WORKBOOK_SHEETS = [JE_SHEET, TB_SHEET];

const JE_HEADERS = [
  "凭证日期",
  "凭证字",
  "凭证号",
  "科目编码",
  "科目名称",
  "摘要",
  "核算单位",
  "借方金额",
  "贷方金额",
];

const JE_PREVIEW: string[][] = [
  ["2025-03-08", "记", "0021", "1601030001", "固定资产-机器设备", "购入数控五轴联动叶片加工中心机床成套附属设备", "示例集团有限公司", "860,000.00", ""],
  ["2025-03-08", "记", "0021", "1002", "银行存款", "付数控机床采购款", "示例集团有限公司", "", "860,000.00"],
  ["2025-04-12", "记", "0107", "1601050002", "固定资产-运输工具", "购入新能源纯电动重型自卸载货汽车及充电桩配套设施", "示例集团有限公司", "1,280,000.00", ""],
  ["2025-04-12", "记", "0107", "220202", "应付账款", "新能源汽车款未付", "示例集团有限公司", "", "1,280,000.00"],
  ["2025-06-30", "记", "0189", "1601150002", "累计折旧-机器设备", "柴油发电机组报废转出累计折旧", "示例集团有限公司", "1,418,484.38", ""],
  ["2025-06-30", "记", "0189", "1601030001", "固定资产-机器设备", "柴油发电机组报废转出原值", "示例集团有限公司", "", "1,860,000.00"],
  ["2025-12-31", "记", "0451", "6601090401", "折旧费-固定资产-机器设备", "计提本年固定资产折旧", "示例集团有限公司", "4,120,580.00", ""],
  ["2025-12-31", "记", "0451", "1602", "累计折旧", "计提本年固定资产折旧", "示例集团有限公司", "", "4,120,580.00"],
];

const JE_ACCOUNTS = [
  "1601030001 固定资产-机器设备",
  "1601050002 固定资产-运输工具",
  "1601150002 累计折旧-机器设备",
  "1002 银行存款",
  "220202 应付账款",
  "6601090401 折旧费-固定资产-机器设备",
];

const TB_HEADERS = [
  "科目编码",
  "科目名称",
  "期初余额",
  "本年借方",
  "本年贷方",
  "期末余额",
];

const TB_PREVIEW: string[][] = [
  ["1002", "银行存款", "12,000,000.00", "8,300,000.00", "7,900,000.00", "12,400,000.00"],
  ["1601", "固定资产", "48,600,000.00", "3,860,000.00", "1,240,000.00", "51,220,000.00"],
  ["1602", "累计折旧", "18,640,000.00", "1,418,484.38", "4,120,580.00", "21,342,095.62"],
  ["1604", "在建工程", "2,300,000.00", "980,000.00", "1,500,000.00", "1,780,000.00"],
  ["1801", "长期待摊费用", "560,000.00", "120,000.00", "200,000.00", "480,000.00"],
];

const TB_ACCOUNTS = [
  "1002 银行存款",
  "1601 固定资产",
  "1602 累计折旧",
  "1604 在建工程",
  "1801 长期待摊费用",
];

/** deposit.classify_source：按入参 Sheet 返回公共分类器的判定结果。 */
const depositClassifySource = (params: Record<string, unknown>): unknown => {
  const source = record(params.source);
  const sheet = str(source.sheet);
  if (sheet === TB_SHEET) {
    return {
      kind: "tb",
      scores: { je: 0, tb: 12 },
      confidence: 0.88,
      needsLlm: false,
      sheet: TB_SHEET,
      sheets: WORKBOOK_SHEETS,
      headerRow: 1,
      headerDepth: 1,
      headers: TB_HEADERS,
      preview: TB_PREVIEW.slice(0, 4),
      reasons: ["检测到科目编码与期初/期末余额列，未见凭证日期与借贷发生额。"],
    };
  }
  return {
    kind: "je",
    scores: { je: 14, tb: 0 },
    confidence: 0.91,
    needsLlm: false,
    sheet: JE_SHEET,
    sheets: WORKBOOK_SHEETS,
    headerRow: 1,
    headerDepth: 1,
    headers: JE_HEADERS,
    preview: JE_PREVIEW.slice(0, 4),
    reasons: ["检测到凭证字/凭证号、记账日期与借贷金额列。"],
  };
};

/** fa_tbje.classify_source_llm：复核确认脚本判型（演示回放脚本结果）。 */
const faTbjeClassifySourceLlm = (params: Record<string, unknown>): unknown => {
  const payload = record(params.payload);
  const scriptKind = str(payload.scriptKind);
  return { kind: scriptKind === "tb" ? "tb" : "je" };
};

const ledgerInspection = (kind: "tb" | "je"): unknown => {
  if (kind === "tb") {
    return {
      headers: TB_HEADERS,
      sheet: TB_SHEET,
      sheets: WORKBOOK_SHEETS,
      headerRow: 1,
      headerDepth: 1,
      rowCount: 42,
      preview: TB_PREVIEW,
      entities: [],
      accounts: TB_ACCOUNTS,
      suggestedMapping: {
        accountCode: "科目编码",
        accountName: "科目名称",
        openingFunctionalAmount: "期初余额",
        closingFunctionalAmount: "期末余额",
      },
      suggestedAccountRoles: {},
      suggestedAccountTiers: {},
      mappingCandidates: [
        {
          role: "openingFunctionalAmount",
          candidates: [{ column: "期初余额", confidence: 0.95, conflictTerms: [] }],
        },
        {
          role: "closingFunctionalAmount",
          candidates: [{ column: "期末余额", confidence: 0.93, conflictTerms: [] }],
        },
      ],
      headerDetection: { needsConfirmation: false, candidates: [{ row: 1, score: 18 }] },
      dataYears: [],
    };
  }
  return {
    headers: JE_HEADERS,
    sheet: JE_SHEET,
    sheets: WORKBOOK_SHEETS,
    headerRow: 1,
    headerDepth: 1,
    rowCount: 126,
    preview: JE_PREVIEW,
    entities: [],
    accounts: JE_ACCOUNTS,
    suggestedMapping: {
      id: ["凭证字", "凭证号"],
      date: "凭证日期",
      accountCode: "科目编码",
      accountName: "科目名称",
      summary: "摘要",
      functionalDebit: "借方金额",
      functionalCredit: "贷方金额",
    },
    suggestedAccountRoles: {},
    suggestedAccountTiers: {},
    mappingCandidates: [
      {
        role: "functionalDebit",
        candidates: [{ column: "借方金额", confidence: 0.96, conflictTerms: [] }],
      },
      {
        role: "functionalCredit",
        candidates: [{ column: "贷方金额", confidence: 0.96, conflictTerms: [] }],
      },
    ],
    headerDetection: { needsConfirmation: false, candidates: [{ row: 1, score: 26 }] },
    dataYears: [2025],
    suggestedBalanceSheetDate: "2025-12-31",
  };
};

// ---------------------------------------------------------------------------
// 公共账表映射复核（ledger.review_mapping / ledger.review_pair_mapping）
// TB 给一条把握不足的「待确认」建议，JE 给一条直接应用的主体列建议，
// 与 FA 主工具的复核面板共同覆盖「已应用 / 待确认」两种布局。
// ---------------------------------------------------------------------------

type LedgerReviewSuggestion = {
  role: string;
  column: string;
  confidence: number;
  reason: string;
};

const LEDGER_REVIEW_SUGGESTIONS: Record<"tb" | "je", LedgerReviewSuggestion[]> = {
  tb: [
    {
      role: "openingFunctionalDebit",
      column: "本年借方",
      confidence: 0.52,
      reason: "「本年借方」更像本年发生额而非期初余额，未自动改动，请确认。",
    },
  ],
  je: [
    {
      role: "entity",
      column: "核算单位",
      confidence: 0.86,
      reason: "「核算单位」列取值稳定，判定为公司主体列。",
    },
  ],
};

const ledgerChangesFor = (
  kind: string,
  part: Record<string, unknown>,
): unknown[] => {
  const headers = Array.isArray(part.headers) ? (part.headers as string[]) : [];
  const availableRoles = Array.isArray(part.availableRoles)
    ? (part.availableRoles as string[])
    : [];
  const suggestions =
    LEDGER_REVIEW_SUGGESTIONS[kind === "tb" ? "tb" : "je"] ?? [];
  return suggestions
    .filter(
      (item) =>
        headers.includes(item.column) &&
        (availableRoles.length === 0 || availableRoles.includes(item.role)),
    )
    .map(({ role, column, confidence, reason }) => ({
      role,
      suggestedColumn: column,
      confidence,
      reason,
    }));
};

const ledgerReviewSingle = (params: Record<string, unknown>): unknown => ({
  changes: ledgerChangesFor(str(params.kind), record(params.payload)),
});

const ledgerReviewPair = (params: Record<string, unknown>): unknown => {
  const payload = record(params.payload);
  return {
    tbChanges: ledgerChangesFor("tb", record(payload.tb)),
    jeChanges: ledgerChangesFor("je", record(payload.je)),
    pairFindings: [],
  };
};

// ---------------------------------------------------------------------------

export const handlers: Record<
  string,
  (params: Record<string, unknown>) => unknown
> = {
  // FA List 两期清单 + 折旧政策对比
  "fa.inspect": faInspect,
  "fa.review": faReview,
  "fa.supplement_inspect": faSupplementInspect,
  "fa.supplement_review": faSupplementReview,
  // 折旧测算
  "fa.dep_inspect": faDepInspect,
  "fa.dep_review": faDepReview,
  // FA List TB＋JE 变动表（复用公共账表引擎方法）
  "deposit.classify_source": depositClassifySource,
  "fa_tbje.classify_source_llm": faTbjeClassifySourceLlm,
  "deposit.inspect_tb": () => ledgerInspection("tb"),
  "deposit.inspect_je": () => ledgerInspection("je"),
  "ledger.review_mapping": ledgerReviewSingle,
  "ledger.review_pair_mapping": ledgerReviewPair,
};
