// 看账工具（kanzhang）的浏览器预览演示数据。
//
// 覆盖两个同步 engineCall 方法（返回形状与 Rust 侧逐字段对齐）：
// - kanzhang.accounts     科目列表：载入 / 关键词检索 / 预设全量捞取共用同一份 27 条样例；
//                         values/codes/primaryNames 三条数组同序等长，与 tabular.rs 一致。
// - kanzhang.llm_mapping  LLM 字段复核：按传入 payload.headers 现挑建议列，
//                         含高把握自动采纳项与低把握待确认项，呼应 audipick.rs 的 kanzhang_llm_call。
//
// 刻意保留 6 条超过 24 个汉字的长科目名（1301/1313/1314/1316/1318/1322 号），用于检查
// 科目列表、穿梭框与批次标签的折行表现；关键词/编码段过滤无命中时返回空列表，
// 让「待选科目」「剔除/例外」的空态文案（含说明文字）也能被随时检查。
//
// kanzhang.inspect / kanzhang.filter / kanzhang.export 走 jobStart 任务通道，
// 预览模式不支持任务（api.ts 直接抛错），不在本文件覆盖范围；DEMO_INSPECT 导出的
// 是读取任务的完整返回样例（含 10 行凭证预览、借贷千分位金额、中文 Sheet 名），
// 供后续任务演示通道或手工核对 Inspect 布局时复用。
import type { Inspect } from "@/ledgerMapping";

type Dict = Record<string, unknown>;

const asRecord = (value: unknown): Dict =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : {};

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const toNonEmptyString = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : "";

// ---------------------------------------------------------------------------
// kanzhang.accounts
// ---------------------------------------------------------------------------

// 科目显示值 = 科目编码 + 各级名称按 "-" 拼接（编码在前、名称在后，与
// ledgerMapping.accountColumns 的口径一致）；第二个元素是一级科目名，
// 对应引擎返回的 primaryNames（供「按一级科目生成全科目批次」使用）。
const ACCOUNT_ROWS: Array<[value: string, primaryName: string]> = [
  ["1002010001-银行存款-工商银行-基本户-人民币存款", "银行存款"],
  ["1002010002-银行存款-建设银行-一般户-美元现汇账户", "银行存款"],
  ["1122010001-应收账款-境内客户-华东大区-赊销货款", "应收账款"],
  ["1122020001-应收账款-境外客户-北美大区-美元应收款项", "应收账款"],
  ["1221010001-其他应收款-员工备用金-销售部门-差旅借款", "其他应收款"],
  ["1403010001-原材料-国内采购-主要材料-钢板型材类", "原材料"],
  ["1405010001-库存商品-自制产成品-华东中心仓-成套设备", "库存商品"],
  ["1601010101-固定资产-机器设备-生产线设备-在用-组装车间", "固定资产"],
  ["1602010001-累计折旧-机器设备-生产线设备月度折旧", "累计折旧"],
  ["1701010001-无形资产-软件类-管理软件-ERP系统", "无形资产"],
  [
    "1801000001-长期待摊费用-租入固定资产改良支出-办公楼装修改造工程-分期摊销",
    "长期待摊费用",
  ],
  ["2001010001-短期借款-银行借款-流动资金贷款-人民币", "短期借款"],
  [
    "2202010101-应付账款-关联方往来-合并范围内-直接采购-暂估应付款项-待结算",
    "应付账款",
  ],
  [
    "2202010102-应付账款-非关联方-原材料供应商-已到票未付款-账期三十天",
    "应付账款",
  ],
  ["2202020001-应付账款-暂估应付款-月末暂估入库-次月初冲回", "应付账款"],
  [
    "2211010001-应付职工薪酬-工资薪金-应付职工工资-奖金津贴补贴-年终一次性奖金",
    "应付职工薪酬",
  ],
  ["2221010001-应交税费-增值税-进项税额-待抵扣进项税额", "应交税费"],
  [
    "2241010001-其他应付款-关联方资金往来-合并范围内-统借统还-资金拆借利息",
    "其他应付款",
  ],
  ["2501010001-长期借款-银行借款-固定资产贷款-人民币", "长期借款"],
  ["6001010001-主营业务收入-内销收入-成套设备销售-华东大区", "主营业务收入"],
  ["6601010001-销售费用-职工薪酬-销售人员工资-社保公积金", "销售费用"],
  [
    "6601020001-销售费用-业务经费-差旅费-国内出差-飞机高铁及市内交通费用",
    "销售费用",
  ],
  ["6602010001-管理费用-职工薪酬-管理人员工资-社保公积金", "管理费用"],
  ["6602030001-管理费用-办公费-办公用品-打印耗材-行政管理部门", "管理费用"],
  ["6602040001-管理费用-折旧费-管理用固定资产折旧-按月计提", "管理费用"],
  ["6603010001-财务费用-利息支出-银行手续费及借款利息费用", "财务费用"],
  ["6603020001-财务费用-汇兑损益-期末调汇-已实现汇兑损失", "财务费用"],
];

const ACCOUNT_VALUES = ACCOUNT_ROWS.map(([value]) => value);
const ACCOUNT_CODES = ACCOUNT_VALUES.map(value => value.slice(0, value.indexOf("-")));
const ACCOUNT_PRIMARY_NAMES = ACCOUNT_ROWS.map(([, name]) => name);

// 与 Rust 侧同参数口径：keyword 模糊匹配、codePrefixes 按编码段前缀、
// all=true 时不受 limit 保护（预设批次要全量）、truncated 标记截断。
function accountList(params: Dict): unknown {
  const keyword = toNonEmptyString(params.keyword).toLowerCase();
  // 与页面 parseCodePrefixes 相同的分隔符集合，兼容单串多前缀的传法。
  const prefixes = toStringArray(params.codePrefixes)
    .flatMap(raw => raw.split(/[,，;；、\s]+/))
    .map(raw => raw.trim().toLowerCase())
    .filter(Boolean);
  const all = params.all === true;
  const rawLimit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.trunc(params.limit)
      : 1000;
  const limit = Math.min(Math.max(rawLimit, 1), 20000);
  const indexes = ACCOUNT_CODES
    .map((_, index) => index)
    .filter(index =>
      prefixes.length
        ? prefixes.some(prefix =>
            ACCOUNT_CODES[index].toLowerCase().startsWith(prefix),
          )
        : true,
    )
    .filter(index =>
      keyword ? ACCOUNT_VALUES[index].toLowerCase().includes(keyword) : true,
    );
  const take = all ? indexes.length : Math.min(indexes.length, limit);
  const picked = indexes.slice(0, take);
  return {
    engine: "rust-polars",
    values: picked.map(index => ACCOUNT_VALUES[index]),
    codes: picked.map(index => ACCOUNT_CODES[index]),
    primaryNames: picked.map(index => ACCOUNT_PRIMARY_NAMES[index]),
    total: indexes.length,
    truncated: indexes.length > take,
  };
}

// ---------------------------------------------------------------------------
// kanzhang.llm_mapping（mode = "mapping"）
// ---------------------------------------------------------------------------

// 候选列按传入 headers 现挑：命中才提建议，与「只能使用真实存在的列」的复核纪律一致；
// headers 为空时退回第一候选，保证空态布局也有内容可看。
const MAPPING_SUGGESTIONS: Array<{
  role: string;
  columns: string[];
  confidence: number;
  reason: string;
}> = [
  {
    role: "id",
    columns: ["凭证编号", "凭证号", "凭证号数"],
    confidence: 0.95,
    reason: "取值为「记-0012」式的连续凭证号，判定为凭证识别字段。",
  },
  {
    role: "date",
    columns: ["记账日期", "凭证日期", "过账日期", "日期"],
    confidence: 0.94,
    reason: "取值为会计期间内的日期，判定为记账日期。",
  },
  {
    role: "entity",
    columns: ["公司", "核算主体", "公司代码", "主体"],
    confidence: 0.9,
    reason: "整列取值为同一家公司名称，判定为记账主体。",
  },
  {
    role: "accountCode",
    columns: ["科目编码", "科目代码", "会计科目"],
    confidence: 0.92,
    reason: "取值为稳定的数字科目编码，判定为科目编码。",
  },
  {
    role: "accountName",
    columns: ["科目名称", "科目文本", "科目名称一级", "科目全名"],
    confidence: 0.93,
    reason: "取值为可读的科目层级名称文本，判定为科目名称。",
  },
  {
    role: "summary",
    columns: ["摘要", "业务摘要", "摘要说明"],
    confidence: 0.45,
    reason: "列名指向摘要，但部分取值偏短、与科目名称易混，请人工确认后再采纳。",
  },
  {
    role: "functionalDebit",
    columns: ["借方金额", "借方发生额", "借方"],
    confidence: 0.9,
    reason: "取值全部为非负金额且列名含「借方」，判定为方案B借方金额。",
  },
  {
    role: "functionalCredit",
    columns: ["贷方金额", "贷方发生额", "贷方"],
    confidence: 0.9,
    reason: "取值全部为非负金额且列名含「贷方」，判定为方案B贷方金额。",
  },
  {
    role: "direction",
    columns: ["借贷方向", "方向", "借贷"],
    confidence: 0.88,
    reason: "取值为借/贷标志，判定为记账方向（与借贷分列互斥，按方案取舍）。",
  },
];

const isDebitColumn = (header: string) =>
  ["借方金额", "借方发生额", "借方"].includes(header);
const isCreditColumn = (header: string) =>
  ["贷方金额", "贷方发生额", "贷方"].includes(header);

function llmMapping(params: Dict): unknown {
  const payload = asRecord(params.payload);
  const headers = toStringArray(payload.headers);
  const current = asRecord(payload.currentMapping);
  const mapped = (role: string): string => {
    const value = current[role];
    if (Array.isArray(value))
      return value
        .filter(item => typeof item === "string" && item.trim())
        .join("、");
    return typeof value === "string" ? value.trim() : "";
  };
  if (params.mode === "analysis") {
    // 页面暂不消费 analysis 模式，这里按 audipick.rs 提示词约定的 JSON 形状给出，
    // 保证该模式在演示通道下也不会返回错误的结构。
    return {
      title: "看账分析（演示数据）",
      sections: [
        {
          heading: "科目发生额",
          points: [
            {
              label: "发生额最大",
              text: "应付账款（2202）本期贷方发生额 8,842,100.00 元，占全部科目发生的 42.6%，集中在非关联方原材料供应商。",
            },
            {
              label: "波动明显",
              text: "管理费用（6602）8 月发生额较 7 月上升 18.4%，主要为办公楼装修改造工程的分期摊销进入当期。",
            },
          ],
        },
        {
          heading: "主要对方科目与凭证类型",
          points: [
            {
              label: "主要对方科目",
              text: "银行存款（1002）与应付账款（2202）互为高频对方科目，付款类凭证占比最高。",
            },
            {
              label: "凭证类型",
              text: "记字凭证占 86.2%，收字凭证占 9.8%，转字凭证占 4.0%。",
            },
          ],
        },
      ],
      review_notes: [
        "演示数据仅用于界面布局检查，金额与占比均为样例，不构成审计结论。",
      ],
    };
  }
  const suggestions = MAPPING_SUGGESTIONS.flatMap(item => {
    const column =
      headers.find(header => item.columns.includes(header)) ??
      (headers.length ? "" : item.columns[0]);
    if (!column) return [];
    return [
      {
        role: item.role,
        suggestedColumn: column,
        confidence: item.confidence,
        reason: item.reason,
      },
    ];
  });
  // 已指向同一列的建议不重复输出（与「只是确认现状的不输出」的纪律一致）；
  // 指向其他列的照常给出，前端会以「改前 → 改后」的形式呈现在变更清单里。
  const changed = suggestions.filter(
    item => mapped(item.role) !== item.suggestedColumn,
  );
  const hasDebit = headers.some(isDebitColumn);
  const hasCredit = headers.some(isCreditColumn);
  return {
    ...(hasDebit && hasCredit
      ? {
          scheme: "B",
          schemeReason:
            "表内同时存在借方与贷方金额两列且逐行配平，按方案B（借贷分列）成立。",
        }
      : {}),
    fills: changed
      .filter(item => item.confidence >= 0.6)
      .map(({ role, suggestedColumn, confidence, reason }) => ({
        role,
        suggestedColumn,
        confidence,
        reason,
      })),
    reviews: changed
      .filter(item => item.confidence < 0.6)
      .map(({ role, suggestedColumn, confidence, reason }) => ({
        role,
        suggestedColumn,
        confidence,
        reason,
      })),
  };
}

// ---------------------------------------------------------------------------
// kanzhang.inspect 的返回样例（任务通道，仅供布局核对/后续复用，不经演示通道返回）
// ---------------------------------------------------------------------------

const DEMO_ENTITY = "上海宏远机械制造有限公司";

// 10 行凭证预览：借/贷金额为千分位字符串（与文本型源表一致），整表借贷配平。
const VOUCHER_PREVIEW: string[][] = [
  ["记-0012", "2026-08-02", DEMO_ENTITY, "1403010001", "原材料-国内采购-主要材料-钢板型材类", "采购Q3生产用钢板入库", "1,258,400.00", ""],
  ["记-0012", "2026-08-02", DEMO_ENTITY, "2221010001", "应交税费-增值税-进项税额-待抵扣进项税额", "采购Q3生产用钢板进项税", "163,592.00", ""],
  ["记-0012", "2026-08-02", DEMO_ENTITY, "2202010102", "应付账款-非关联方-原材料供应商-已到票未付款-账期三十天", "宝山钢铁采购款挂账", "", "1,421,992.00"],
  ["记-0013", "2026-08-05", DEMO_ENTITY, "6602010001", "管理费用-职工薪酬-管理人员工资-社保公积金", "计提8月管理人员工资", "486,200.00", ""],
  ["记-0013", "2026-08-05", DEMO_ENTITY, "6601010001", "销售费用-职工薪酬-销售人员工资-社保公积金", "计提8月销售人员工资", "312,750.00", ""],
  ["记-0013", "2026-08-05", DEMO_ENTITY, "2211010001", "应付职工薪酬-工资薪金-应付职工工资-奖金津贴补贴-年终一次性奖金", "计提8月职工工资", "", "798,950.00"],
  ["收-0021", "2026-08-09", DEMO_ENTITY, "1002010001", "银行存款-工商银行-基本户-人民币存款", "收回华东大区赊销货款", "956,000.00", ""],
  ["收-0021", "2026-08-09", DEMO_ENTITY, "1122010001", "应收账款-境内客户-华东大区-赊销货款", "收回江苏汇鸿设备款", "", "956,000.00"],
  ["记-0030", "2026-08-31", DEMO_ENTITY, "6602040001", "管理费用-折旧费-管理用固定资产折旧-按月计提", "计提8月折旧", "96,318.50", ""],
  ["记-0030", "2026-08-31", DEMO_ENTITY, "1602010001", "累计折旧-机器设备-生产线设备月度折旧", "计提8月生产线折旧", "", "96,318.50"],
];

/** kanzhang.inspect 任务完成事件的 result 样例，形状即页面的 Inspect。 */
export const DEMO_INSPECT: Inspect = {
  lowMemory: false,
  headers: ["凭证编号", "记账日期", "公司", "科目编码", "科目名称", "摘要", "借方金额", "贷方金额"],
  preview: VOUCHER_PREVIEW,
  sheets: ["凭证序时簿", "科目余额表", "外币凭证明细"],
  selectedSheet: "凭证序时簿",
  suggestedMapping: {
    id: ["凭证编号"],
    accountCode: "科目编码",
    accountName: ["科目名称"],
    entity: "公司",
    date: "记账日期",
    summary: "摘要",
    functionalDebit: "借方金额",
    functionalCredit: "贷方金额",
  },
  accounts: ACCOUNT_VALUES,
  accountCodes: ACCOUNT_CODES,
  accountCount: ACCOUNT_VALUES.length,
  dimensions: { rows: 1286, columns: 8 },
};

export const handlers: Record<string, (params: Dict) => unknown> = {
  "kanzhang.accounts": accountList,
  "kanzhang.llm_mapping": llmMapping,
};

// ---------------------------------------------------------------------------
// 任务剧本：读取 / 筛选预览 / 导出（api.ts 演示任务通道按序回放事件流）
// ---------------------------------------------------------------------------

import type { DemoJobEvent } from "../demoRegistry";

const DEMO_EXPORT_PATHS = [
  "C:\演示数据\看账导出_凭证序时簿_明细_批次1.csv",
  "C:\演示数据\看账导出_凭证序时簿_套表.xlsx",
];

export const jobHandlers: Record<string, (params: Dict) => DemoJobEvent[]> = {
  "kanzhang.inspect": () => [
    { phase: "queued", current: 0, total: 0, message: "排队读取凭证文件…", severity: "info", outputPaths: [] },
    { phase: "running", current: 30, total: 100, message: "正在解析「凭证序时簿」…", severity: "info", outputPaths: [] },
    { phase: "running", current: 82, total: 100, message: "正在识别科目与建议映射…", severity: "info", outputPaths: [] },
    { phase: "completed", current: 100, total: 100, message: "读取完成：1,286 行凭证，27 个科目。", severity: "success", outputPaths: [], result: DEMO_INSPECT },
  ],
  "kanzhang.filter": () => [
    { phase: "queued", current: 0, total: 0, message: "排队执行科目筛选…", severity: "info", outputPaths: [] },
    { phase: "running", current: 55, total: 100, message: "正在按目标匹配展开整张凭证…", severity: "info", outputPaths: [] },
    { phase: "completed", current: 100, total: 100, message: "筛选完成：968 行凭证进入分析。", severity: "success", outputPaths: [], result: { rows: 968, batches: [{ name: "目标匹配批次1", rows: 968, lossTransferVouchers: 12 }] } },
  ],
  "kanzhang.export": () => [
    { phase: "queued", current: 0, total: 0, message: "排队导出看账结果…", severity: "info", outputPaths: [] },
    { phase: "running", current: 48, total: 100, message: "正在写出具明细批次 CSV…", severity: "info", outputPaths: [] },
    { phase: "running", current: 86, total: 100, message: "正在写出具套表 XLSX…", severity: "info", outputPaths: [] },
    { phase: "completed", current: 100, total: 100, message: "导出完成：明细与套表均已生成。", severity: "success", outputPaths: DEMO_EXPORT_PATHS, result: { rows: 968, outputPaths: DEMO_EXPORT_PATHS, batches: [{ name: "目标匹配批次1", rows: 968, lossTransferVouchers: 12 }] } },
  ],
};
