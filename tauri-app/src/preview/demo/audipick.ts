// AudiPick 智能合同审阅工具的浏览器预览演示数据。
//
// 覆盖的同步 engineCall 方法（返回形状与 storage.rs / audipick.rs / lib.rs 逐字段对齐）：
// - audipick.projects         项目列表：2 个演示项目（含文档数、状态、关联资料、已保存的提取结果）
// - audipick.config_status    AI 服务 / OCR 就绪状态（演示恒为就绪，让提取按钮可点）
// - audipick.documents        项目下的合同 PDF 清单（项目一 3 份、项目二 1 份）
// - audipick.project_save     保存项目（回写本文件内的会话状态，返回保存后的数据）
// - audipick.project_delete   删除项目
// - audipick.document_import  导入 PDF（演示会话内新增一份文档元数据）
// - audipick.document_delete  删除文档
// - audipick.document_text    读取已保存的文字层（与演示提取结果引用的条款一一对应）
// - audipick.document_text_save 保存文字层（会话内生效，供后续提取使用）
// - audipick.ocr              文字识别回放：返回固定识别文本，不发送页面图像
// - audipick.classify         模板建议回放：按文件名关键词从提示词里的模板目录中挑选
// - audipick.extract          智能提取回放：按提示词要求的字段返回 2~3 条字段键值对，
//                             含 1 条低置信度「待复核」项（页码【页码未知】），
//                             收入底稿的事实提取轮按 parsed.facts 形状回放
// - audipick.export           导出底稿（outputPaths 指向 C:\演示数据）
// - audipick.backup_export    导出项目备份 zip
//
// 覆盖的任务方法（jobHandlers）：
// - audipick.batch_extract    批量提取：排队 → 逐份进行 → 完成；文字层缺失的扫描件
//                             按真实 worker 行返回 ok=false，用于检查批量失败清单布局
//
// 刻意无法覆盖、桌面应用才能走通的环节：
// - audipick_pdf_bytes 是独立 Tauri 命令（不走 engine_call 演示通道），浏览器预览读不到
//   本地 PDF，PDF 画布渲染、翻页与原文高亮不可用；
// - audipick.ocr / audipick.extract 只回放固定样例，不执行真实 OCR / LLM 调用，
//   对不同合同的响应差异（以及收入底稿两轮提取的多批次展开）不在回放范围内；
// - 处理工作日志存在 localStorage（页面自管），本文件仅在演示开关打开且日志为空时
//   预置若干条记录，让「处理工作日志」视图随时有数据可看。
// 仅浏览器预览 + 演示开关（localStorage audit-toolbox.demo-data = "1"）时被 demoRegistry 收拢生效。
// 注意：这里只能 type 导入 demoRegistry（DemoJobEvent）。demoRegistry 会在模块
// 初始化时经 import.meta.glob 同步加载本文件，若在顶层运行时调用它的导出，
// 循环导入会在 vitest 的模块 mock 场景下拿到未初始化的绑定而报错
// （其他 demo 文件同样只保留 type 导入）。演示开关因此在本文件内直接判断。
import type { DemoJobEvent } from "../demoRegistry";

type Dict = Record<string, unknown>;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 与页面 activeFieldSetId 同一算法：模板 id + 排序后的字段键。 */
const fieldSetIdOf = (ruleId: string, keys: string[]): string =>
  `${ruleId}:${[...keys].sort().join("|")}`;

const fileNameOf = (path: string): string =>
  path.split(/[\\/]/).pop() ?? path;

// ---------------------------------------------------------------------------
// 会话状态：项目 / 文档 / 文字层（演示通道在页面生命周期内保持可交互）
// ---------------------------------------------------------------------------

type DemoDocument = {
  id: string;
  projectId: string;
  name: string;
  path: string;
  sourcePath: string;
  sha256: string;
  size: number;
  status: string;
};

type DemoResultRow = Dict;

type DemoProject = {
  project: {
    id: string;
    name: string;
    client: string;
    date: string;
    status: string;
    relationGroups?: Array<{
      id: string;
      anchorFileId: string;
      members: Array<{ fileId: string; role: string }>;
    }>;
  };
  contracts: DemoDocument[];
  results: DemoResultRow[];
};

const DOC_LOAN = "8f14e45fceea167a5a36de3d";
const DOC_PROC = "c9f0f895fb98ab9159f51fd0";
const DOC_SCAN = "45c48cce2e2d7fbdea1afc51";
const DOC_REV = "6512bd43d9caa6e02c990b0a";

const PROJECT_A = "p_demo_huayuan2025";
const PROJECT_B = "p_demo_nanshan2026";

const SHA_LOAN =
  "3f7a1c9e2b64d8a05c1e4f7b9a2d6c8e0f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c";
const SHA_PROC =
  "9c2e4a6b8d0f2a4c6e8a0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a";
const SHA_SCAN =
  "5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d";
const SHA_REV =
  "7e1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a";

const documentsByProject = new Map<string, DemoDocument[]>([
  [
    PROJECT_A,
    [
      {
        id: DOC_LOAN,
        projectId: PROJECT_A,
        name: "流动资金借款合同（华远集团-工行城南支行）.pdf",
        path: "C:\\演示数据\\华远集团\\流动资金借款合同.pdf",
        sourcePath: "C:\\演示数据\\华远集团\\流动资金借款合同.pdf",
        sha256: SHA_LOAN,
        size: 184_320,
        status: "imported",
      },
      {
        id: DOC_PROC,
        projectId: PROJECT_A,
        name: "采购框架协议（华远集团-中州重工）.pdf",
        path: "C:\\演示数据\\华远集团\\采购框架协议.pdf",
        sourcePath: "C:\\演示数据\\华远集团\\采购框架协议.pdf",
        sha256: SHA_PROC,
        size: 156_672,
        status: "imported",
      },
      {
        id: DOC_SCAN,
        projectId: PROJECT_A,
        name: "设备采购合同扫描件（华远集团-恒信贸易）.pdf",
        path: "C:\\演示数据\\华远集团\\设备采购合同扫描件.pdf",
        sourcePath: "C:\\演示数据\\华远集团\\设备采购合同扫描件.pdf",
        sha256: SHA_SCAN,
        size: 2_093_056,
        status: "imported",
      },
    ],
  ],
  [
    PROJECT_B,
    [
      {
        id: DOC_REV,
        projectId: PROJECT_B,
        name: "年度销售框架主协议（南山制造-华东经销）.pdf",
        path: "C:\\演示数据\\南山制造\\年度销售框架主协议.pdf",
        sourcePath: "C:\\演示数据\\南山制造\\年度销售框架主协议.pdf",
        sha256: SHA_REV,
        size: 213_504,
        status: "imported",
      },
    ],
  ],
]);

// ---------------------------------------------------------------------------
// 演示合同文字层：与预置提取结果、演示提取回放引用的条款一一对应。
// `---PDF第N页---` 标记与桌面端 openDocument 拼出的文本格式一致。
// ---------------------------------------------------------------------------

const DEMO_LOAN_TEXT = `---PDF第1页---
流动资金借款合同
合同编号：工银城南借字〔2026〕0187号
借款人：华远集团有限公司
贷款人：中国工商银行股份有限公司城南支行
借款金额：人民币伍仟万元整（¥50,000,000.00）
借款期限：12个月，自2026年3月18日起至2027年3月17日止。
---PDF第3页---
第4.2条 财务指标约束
借款期间，借款人合并报表口径的资产负债率不得超过70%；借款人连续两个会计季度超过前述标准的，贷款人有权要求借款人追加合法有效的担保，并有权停止发放尚未提取的借款。
---PDF第5页---
第9.1条 借款用途
本合同项下借款专款用于借款人日常生产经营流动资金周转，不得用于固定资产投资、股权投资，不得流入证券市场、房地产市场或用于民间借贷。
---PDF第6页---
第12.1条 信息披露与报备
借款人发生重大诉讼、仲裁、行政处罚或其他影响偿债能力的重大事项时，应于五个工作日内书面通知贷款人并提交相关材料。`;

const DEMO_PROC_TEXT = `---PDF第2页---
第4.2条 价格与调价机制
协议期内以届时的市场价格为基础确定结算单价；钢材市场价格较签约基准价波动超过±5%时，双方按附件三的调价公式对未执行部分重新议价。
---PDF第4页---
第7.3条 结算与支付
买方在收到增值税专用发票并验收合格后60日内支付当批货款的95%；其余5%作为质保金，于验收合格满12个月后无质量争议一次性付清。`;

const DEMO_REV_TEXT = `---PDF第1页---
年度销售框架主协议
甲方：南山智能制造股份有限公司
乙方：华东经销有限公司
甲方按订单向乙方交付智能制造成套设备，并负责安装调试、质保期维护及操作培训；
具体数量、单价与交付时间以双方确认的订单为准。`;

const OCR_DEMO_TEXT =
  "（演示数据）设备采购合同 第3页 甲方：华远集团有限公司 乙方：恒信贸易有限公司 " +
  "交付地点：华远集团华东中心仓；验收周期：货到后15个工作日内完成验收；" +
  "逾期交付的，每逾期一日按未交付部分货款的0.05%支付违约金。";

const textByDocument = new Map<string, string>([
  [DOC_LOAN, DEMO_LOAN_TEXT],
  [DOC_PROC, DEMO_PROC_TEXT],
  [DOC_REV, DEMO_REV_TEXT],
  // 扫描件尚未保存文字层：与批量提取对该文档返回 AUDIPICK_TEXT_MISSING 的口径一致。
  [DOC_SCAN, ""],
]);

// ---------------------------------------------------------------------------
// 预置提取结果：字段键与真实模板提示词的【字段定义】一致。
// 借款·限制性契约（loan_covenant）/ 采购合同（procurement）各预置若干条，
// 其中 1 条低置信度「待复核」项（页码【页码未知】、review_status 需人工复核），
// 用于检查结果面板的复核按钮与警示布局。
// ---------------------------------------------------------------------------

const LOAN_FIELD_KEYS = [
  "clause_ref",
  "pages",
  "covenant_category",
  "contract_classification",
  "is_financial",
  "title",
  "excerpt",
  "auditor_summary",
];

const PROC_FIELD_KEYS = [
  "clause_ref",
  "pages",
  "clause_category",
  "risk_flag",
  "title",
  "excerpt",
  "auditor_summary",
];

const LOAN_FIELD_SET = fieldSetIdOf("loan_covenant", LOAN_FIELD_KEYS);
const PROC_FIELD_SET = fieldSetIdOf("procurement", PROC_FIELD_KEYS);

const LOAN_SEED_ROWS: DemoResultRow[] = [
  {
    id: "r_demo_loan_1",
    contractId: DOC_LOAN,
    ruleId: "loan_covenant",
    ruleVersion: "1.0",
    fieldKeys: [...LOAN_FIELD_KEYS],
    fieldSetId: LOAN_FIELD_SET,
    extractAt: "2026-09-01T01:24:00.000Z",
    clause_ref: "第4.2条",
    pages: "【第3页】",
    covenant_category: "财务类",
    contract_classification: "指标类",
    is_financial: "是",
    title: "资产负债率不得超过70%",
    excerpt:
      "借款期间，借款人合并报表口径的资产负债率不得超过70%；连续两个会计季度超过的，贷款人有权要求追加担保并停止发放尚未提取的借款。",
    auditor_summary:
      "实质性测试宜使用经审定财务数据，而非未审管理层报表；限制内容为资产负债率上限70%，违约将触发追加担保、停发未提取借款。",
    reviewed: true,
  },
  {
    id: "r_demo_loan_2",
    contractId: DOC_LOAN,
    ruleId: "loan_covenant",
    ruleVersion: "1.0",
    fieldKeys: [...LOAN_FIELD_KEYS],
    fieldSetId: LOAN_FIELD_SET,
    extractAt: "2026-09-01T01:24:00.000Z",
    clause_ref: "第9.1条",
    pages: "【第5页】",
    covenant_category: "直接违约条款_用途与资金",
    contract_classification: "非指标类",
    is_financial: "否",
    title: "借款专款专用禁止流入楼市股市",
    excerpt:
      "本合同项下借款专款用于借款人日常生产经营流动资金周转，不得用于固定资产投资、股权投资，不得流入证券市场、房地产市场或用于民间借贷。",
    auditor_summary:
      "需结合付款审批与资金流向判断用途违约风险；擅改用途将构成直接违约，贷款人可宣布借款提前到期。",
    reviewed: true,
  },
  // 低置信度「待复核」样例：条款号与页码无法对应，提示复核后再纳入底稿。
  {
    id: "r_demo_loan_3",
    contractId: DOC_LOAN,
    ruleId: "loan_covenant",
    ruleVersion: "1.0",
    fieldKeys: [...LOAN_FIELD_KEYS],
    fieldSetId: LOAN_FIELD_SET,
    extractAt: "2026-09-01T01:24:00.000Z",
    clause_ref: "",
    pages: "【页码未知】",
    covenant_category: "其他保护类",
    contract_classification: "非指标类",
    is_financial: "否",
    title: "重大事项报备（原文位置待核实）",
    excerpt:
      "借款人发生重大诉讼、仲裁、行政处罚或其他影响偿债能力的重大事项时，应于五个工作日内书面通知贷款人并提交相关材料。",
    auditor_summary:
      "偏通知报备型条款，把握较低：未能定位条款号与页码，请人工核对原文后再纳入底稿。",
    review_status: "需人工复核",
    confidence: "低",
    reviewed: false,
  },
];

const PROC_SEED_ROWS: DemoResultRow[] = [
  {
    id: "r_demo_proc_1",
    contractId: DOC_PROC,
    ruleId: "procurement",
    ruleVersion: "1.0",
    fieldKeys: [...PROC_FIELD_KEYS],
    fieldSetId: PROC_FIELD_SET,
    extractAt: "2026-09-02T02:10:00.000Z",
    clause_ref: "第4.2条",
    pages: "【第2页】",
    clause_category: "定价与调价机制",
    risk_flag: "暂估风险",
    title: "钢价波动超±5%按公式调价",
    excerpt:
      "钢材市场价格较签约基准价波动超过±5%时，双方按附件三的调价公式对未执行部分重新议价。",
    auditor_summary:
      "暂估余额复核重点：需结合期后实际结算单或最新市价复核期末暂估单价的准确性。",
    reviewed: false,
  },
  {
    id: "r_demo_proc_2",
    contractId: DOC_PROC,
    ruleId: "procurement",
    ruleVersion: "1.0",
    fieldKeys: [...PROC_FIELD_KEYS],
    fieldSetId: PROC_FIELD_SET,
    extractAt: "2026-09-02T02:10:00.000Z",
    clause_ref: "第7.3条",
    pages: "【第4页】",
    clause_category: "结算与信用期",
    risk_flag: "无显著异常",
    title: "到票验收后60日付款质保金5%",
    excerpt:
      "买方在收到增值税专用发票并验收合格后60日内支付当批货款的95%；其余5%作为质保金，验收合格满12个月后无质量争议一次性付清。",
    auditor_summary:
      "结合应付账款账龄分析，关注长期未付的质保金及商业信用到期情况。",
    reviewed: false,
  },
];

const projectsStore: DemoProject[] = [
  {
    project: {
      id: PROJECT_A,
      name: "华远集团 2025 年度采购合同审阅",
      client: "华远集团有限公司",
      date: "2026-08-12",
      status: "active",
      relationGroups: [
        {
          id: "g_demo_proc1",
          anchorFileId: DOC_PROC,
          members: [{ fileId: DOC_SCAN, role: "订单/采购订单" }],
        },
      ],
    },
    contracts: clone(documentsByProject.get(PROJECT_A) ?? []),
    results: [...LOAN_SEED_ROWS, ...PROC_SEED_ROWS],
  },
  {
    project: {
      id: PROJECT_B,
      name: "南山制造 2026 年度收入合同审阅",
      client: "南山智能制造股份有限公司",
      date: "2026-08-28",
      status: "active",
    },
    contracts: clone(documentsByProject.get(PROJECT_B) ?? []),
    // 项目二无提取结果：用于检查「尚无处理结果」空态布局。
    results: [],
  },
];

let importedSeq = 0;

// ---------------------------------------------------------------------------
// 提取回放：两套演示模板（模板名 + 字段清单）+ 通用字段值库
// ---------------------------------------------------------------------------

// 演示模板一：借款·限制性契约（loan_covenant），字段含条款编号、页码、契约分类等。
const LOAN_DEMO_ITEMS: Array<Dict> = [
  {
    clause_ref: "第4.2条",
    pages: "【第3页】",
    covenant_category: "财务类",
    contract_classification: "指标类",
    is_financial: "是",
    title: "资产负债率不得超过70%",
    excerpt:
      "借款期间，借款人合并报表口径的资产负债率不得超过70%；连续两个会计季度超过的，贷款人有权要求追加担保并停止发放尚未提取的借款。",
    auditor_summary:
      "实质性测试宜使用经审定财务数据，而非未审管理层报表；违约将触发追加担保、停发未提取借款。",
  },
  {
    clause_ref: "第9.1条",
    pages: "【第5页】",
    covenant_category: "直接违约条款_用途与资金",
    contract_classification: "非指标类",
    is_financial: "否",
    title: "借款专款专用禁止流入楼市股市",
    excerpt:
      "本合同项下借款专款用于借款人日常生产经营流动资金周转，不得用于固定资产投资、股权投资，不得流入证券市场、房地产市场或用于民间借贷。",
    auditor_summary:
      "需结合付款审批与资金流向判断用途违约风险；擅改用途将构成直接违约，借款提前到期。",
  },
  // 低置信度「待复核」项：无法定位条款号与页码。
  {
    clause_ref: "",
    pages: "【页码未知】",
    covenant_category: "其他保护类",
    contract_classification: "非指标类",
    is_financial: "否",
    title: "重大事项报备（原文位置待核实）",
    excerpt:
      "借款人发生重大诉讼、仲裁、行政处罚或其他影响偿债能力的重大事项时，应于五个工作日内书面通知贷款人并提交相关材料。",
    auditor_summary: "偏通知报备型条款，把握较低，请人工核对原文页码后再纳入底稿。",
  },
];

// 演示模板二：采购合同（procurement），字段含条款类型、审计风险点等。
const PROC_DEMO_ITEMS: Array<Dict> = [
  {
    clause_ref: "第4.2条",
    pages: "【第2页】",
    clause_category: "定价与调价机制",
    risk_flag: "暂估风险",
    title: "钢价波动超±5%按公式调价",
    excerpt:
      "钢材市场价格较签约基准价波动超过±5%时，双方按附件三的调价公式对未执行部分重新议价。",
    auditor_summary:
      "暂估余额复核重点：结合期后实际结算单或最新市价复核期末暂估单价的准确性。",
  },
  {
    clause_ref: "第7.3条",
    pages: "【第4页】",
    clause_category: "结算与信用期",
    risk_flag: "无显著异常",
    title: "到票验收后60日付款质保金5%",
    excerpt:
      "买方在收到增值税专用发票并验收合格后60日内支付当批货款的95%；其余5%作为质保金，验收合格满12个月后一次性付清。",
    auditor_summary: "结合应付账款账龄分析，关注长期未付的质保金及商业信用到期情况。",
  },
  {
    clause_ref: "",
    pages: "【页码未知】",
    clause_category: "交付与风险转移",
    risk_flag: "跨期风险",
    title: "风险转移节点（原文位置待核实）",
    excerpt: "货物运抵买方指定仓库并完成入库验收后，毁损灭失风险转移至买方。",
    auditor_summary: "截止性测试重点：把握较低，请人工核对原文页码后再纳入底稿。",
  },
];

// 通用字段值库：覆盖收入底稿、发票、借款主表等模板的常见字段
// （金额、日期、对方当事人等）；未收录的键给出带键名的演示占位值。
const FIELD_VALUE_BANK: Record<string, string> = {
  clause_ref: "第4.2条",
  pages: "【第3页】",
  title: "定价与调价机制条款",
  excerpt: "钢材市场价格较签约基准价波动超过±5%时，双方按调价公式重新议价。",
  auditor_summary: "演示提示：请结合合同原文复核本条提取结果。",
  // 借款合同主表（loan_general）常见字段
  contract_no: "工银城南借字〔2026〕0187号",
  borrower: "华远集团有限公司",
  lender: "中国工商银行股份有限公司城南支行",
  counterparty: "中州重工股份有限公司",
  currency: "人民币",
  facility_limit: "50,000,000.00",
  contract_principal: "50,000,000.00",
  amount: "4,365,200.00",
  tax: "567,476.00",
  loan_purpose: "日常生产经营流动资金周转（专款专用）",
  signing_date: "2026-03-18",
  loan_start_date: "2026-03-18",
  maturity_date: "2027-03-17",
  contract_term: "12 个月",
  interest_rate: "3.85%（LPR+0.45%）",
  interest_rate_type: "浮动利率",
  repayment_method: "按季付息、到期一次还本",
  guarantor: "华远控股集团有限公司",
  // 发票常见字段
  invoice_type: "增值税专用发票",
  invoice_no: "24312000000123456",
  invoice_date: "2026-07-06",
  buyer_name: "华远集团有限公司",
  seller_name: "中州重工股份有限公司",
  goods_name: "成套设备（Q3 采购）",
  // 收入底稿常见字段
  question_no: "2.1",
  question: "合同是否识别为单项履约义务？",
  suggested_answer: "单项履约义务——单项商品或服务",
  workpaper_sheet: "收入底稿",
  answer_reason: "演示理由：设备交付与安装调试高度关联，合并为单项履约义务。",
  confidence: "中",
  review_status: "待复核",
};

const requestedKeysFromPrompt = (prompt: string): string[] => {
  const marker = "本次仅返回这些字段：";
  const start = prompt.indexOf(marker);
  if (start < 0) return [];
  return prompt
    .slice(start + marker.length)
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
};

const itemForKeys = (source: Dict, keys: string[], index: number): Dict => {
  const item: Dict = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      // 页码轮换只为让不同条目落到不同页；「页码未知」是低置信度待复核标记，保持原样。
      item[key] =
        key === "pages" && index > 0 && value !== "【页码未知】"
          ? `【第${3 + index * 2}页】`
          : value;
    } else {
      item[key] = FIELD_VALUE_BANK[key] ?? `（演示）${key}`;
    }
  }
  return item;
};

const dedicatedItemsFor = (ruleId: string, keys: string[]): Array<Dict> | undefined => {
  const source =
    ruleId === "procurement"
      ? PROC_DEMO_ITEMS
      : ruleId === "loan_covenant" || keys.includes("covenant_category")
        ? // 自定义模板沿用借款模板字段时（键有交集）也回放借款样例。
          LOAN_DEMO_ITEMS
        : undefined;
  if (!source) return undefined;
  return source.map((item, index) => itemForKeys(item, keys, index));
};

/** 通用模板的演示条目：2 条，第 2 条页码未知（待复核布局检查用）。 */
const genericItemsFor = (keys: string[]): Array<Dict> => {
  const base: Dict = {};
  for (const key of keys) base[key] = FIELD_VALUE_BANK[key] ?? `（演示）${key}`;
  const first = { ...base };
  const second: Dict = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === "pages") second[key] = "【页码未知】";
    else if (key === "question_no") second[key] = "3.1";
    else second[key] = value;
  }
  return [first, second];
};

const itemsForRequest = (ruleId: string, keys: string[]): Array<Dict> =>
  dedicatedItemsFor(ruleId, keys) ?? genericItemsFor(keys.length ? keys : Object.keys(FIELD_VALUE_BANK));

// 收入底稿事实提取轮（revenueFactPrompt）的回放：按 parsed.facts 形状返回。
const REVENUE_FACTS: Array<Dict> = [
  {
    fact_type: "付款条件",
    fact_summary: "验收合格后 60 日内支付当批货款的 95%，质保金 5% 于验收后 12 个月支付。",
    contract_excerpt:
      "买方在收到增值税专用发票并验收合格后60日内支付当批货款的95%；其余5%作为质保金。",
    qualifier: "以买方收到增值税专用发票为付款前提",
    pages: "【第4页】",
  },
  {
    fact_type: "价格调整机制",
    fact_summary: "钢材市价较签约基准价波动超过 ±5% 时，对未执行部分按调价公式重新议价。",
    contract_excerpt:
      "市场价格较签约基准价波动超过±5%时，双方按附件三的调价公式对未执行部分重新议价。",
    qualifier: "仅适用于尚未执行完毕的订单部分",
    pages: "【第2页】",
  },
  {
    fact_type: "履约义务描述",
    fact_summary: "卖方负责设备交付、安装调试、质保期维护及操作培训。",
    contract_excerpt:
      "甲方按订单向乙方交付智能制造成套设备，并负责安装调试、质保期维护及操作培训。",
    qualifier: "数量、单价与交付时间以双方确认的订单为准",
    pages: "【第1页】",
  },
];

const isFactPrompt = (prompt: string): boolean =>
  prompt.includes("客观事实") && prompt.includes("facts");

// ---------------------------------------------------------------------------
// 模板建议回放（audipick.classify）：从提示词中的模板目录解析可选 rule_id，
// 再按文件名关键词挑选，保持与真实分类提示一致的输出形状。
// ---------------------------------------------------------------------------

const CLASSIFY_KEYWORDS: Array<[RegExp, string, string]> = [
  [/借款|贷款|授信/, "loan_covenant", "借款合同"],
  [/采购|框架协议|供应商/, "procurement", "采购合同"],
  [/收入|销售|履约/, "revenue", "收入合同"],
  [/底稿/, "revenue_workpaper", "收入合同审阅底稿"],
  [/承兑|开票协议/, "invoicing_agreement", "银行承兑汇票开票协议"],
  [/对账单|询证/, "statement", "对账单"],
  [/发票/, "invoice", "发票"],
  [/出入库|入库单|出库单/, "warehouse_io", "出入库单"],
  [/开户/, "account_opening", "开户清单"],
  [/征信/, "credit_report", "征信报告"],
  [/纳税|申报表/, "tax_declaration", "纳税申报表"],
  [/税审/, "tax_audit_report", "税审报告"],
];

const catalogIdsFromPrompt = (prompt: string): string[] => {
  const ids: string[] = [];
  for (const match of prompt.matchAll(/^\s*-\s*([a-z_]+)\s*\|/gm)) {
    if (match[1] && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
};

function classifyDocument(params: Dict): unknown {
  const prompt = asString(params.prompt);
  const sample = asString(params.text);
  const fileName = fileNameOf(
    sample.match(/^【文件名】\s*\n(.+)$/m)?.[1]?.trim() ?? "",
  );
  const catalog = catalogIdsFromPrompt(prompt);
  const hit = CLASSIFY_KEYWORDS.find(
    ([pattern]) => pattern.test(fileName) || pattern.test(sample.slice(0, 400)),
  );
  const wanted = hit?.[1] ?? catalog[0] ?? "loan_covenant";
  const ruleId = catalog.includes(wanted) ? wanted : (catalog[0] ?? wanted);
  const docLabel = hit?.[2] ?? "合同文件";
  const known = catalog.includes(ruleId);
  const parsed = {
    rule_id: ruleId,
    doc_label: docLabel,
    confidence: known && hit ? "high" : "medium",
    reason: hit
      ? `文件名与正文指向${docLabel}，按「${ruleId}」模板提取把握较大。`
      : "未识别出明确的文档类型关键词，建议人工确认模板后再提取。",
  };
  return { content: JSON.stringify(parsed), parsed };
}

// ---------------------------------------------------------------------------
// handlers（同步 engineCall 回放）
// ---------------------------------------------------------------------------

export const handlers: Record<string, (params: Dict) => unknown> = {
  "audipick.projects": () => ({
    projects: clone(projectsStore),
    storage: "tauri-sqlite",
    migrationRequired: false,
  }),

  "audipick.config_status": () => ({
    // 演示恒为就绪，让「AI 提取并保存」「批量提取」按钮与「AI 服务已就绪」标签可达。
    llm: { ready: true, apiType: "openai", model: "演示模型（本地样例，不调用外部服务）" },
    ocr: { ready: true, engine: "ai" },
  }),

  "audipick.documents": (params) => {
    const projectId = asString(params.projectId);
    return {
      projectId,
      documents: clone(documentsByProject.get(projectId) ?? []),
    };
  },

  "audipick.project_save": (params) => {
    const data = clone(params) as unknown as DemoProject;
    const id = asString(data.project?.id);
    const index = projectsStore.findIndex((item) => item.project.id === id);
    if (index >= 0) projectsStore[index] = data;
    else projectsStore.unshift(data);
    if (!documentsByProject.has(id)) documentsByProject.set(id, []);
    return clone(params);
  },

  "audipick.project_delete": (params) => {
    const id = asString(params.id);
    const index = projectsStore.findIndex((item) => item.project.id === id);
    const deleted = index >= 0;
    if (deleted) projectsStore.splice(index, 1);
    documentsByProject.delete(id);
    return { deleted, id };
  },

  "audipick.document_import": (params) => {
    const projectId = asString(params.projectId);
    const path = asString(params.path);
    const baseName = fileNameOf(path).replace(/\.pdf$/i, "") || "新建合同";
    importedSeq += 1;
    const id = `demo${String(importedSeq).padStart(4, "0")}pdfimport`;
    const metadata: DemoDocument = {
      id,
      projectId,
      name: `${baseName}.pdf`,
      path: `C:\\演示数据\\${baseName}.pdf`,
      sourcePath: path || `C:\\演示数据\\${baseName}.pdf`,
      sha256: SHA_REV.slice(0, 32).padEnd(64, "0"),
      size: 158_720,
      status: "imported",
    };
    const list = documentsByProject.get(projectId) ?? [];
    list.push(metadata);
    documentsByProject.set(projectId, list);
    if (!textByDocument.has(id)) textByDocument.set(id, "");
    return clone(metadata);
  },

  "audipick.document_delete": (params) => {
    const id = asString(params.documentId);
    let deleted = false;
    for (const [projectId, list] of documentsByProject) {
      const index = list.findIndex((item) => item.id === id);
      if (index >= 0) {
        list.splice(index, 1);
        deleted = true;
        if (!list.length) documentsByProject.delete(projectId);
        break;
      }
    }
    textByDocument.delete(id);
    return { deleted, documentId: id };
  },

  "audipick.document_text": (params) => {
    const id = asString(params.documentId);
    return { documentId: id, text: textByDocument.get(id) ?? "" };
  },

  "audipick.document_text_save": (params) => {
    const id = asString(params.documentId);
    const text = asString(params.text);
    textByDocument.set(id, text);
    return {
      documentId: id,
      textLength: [...text].length,
      saved: true,
    };
  },

  "audipick.ocr": () => ({
    // 固定回放一段识别文本，不发送页面图像到真实 OCR 服务。
    text: OCR_DEMO_TEXT,
    engine: "ai",
  }),

  "audipick.classify": classifyDocument,

  "audipick.extract": (params) => {
    const prompt = asString(params.prompt);
    if (isFactPrompt(prompt)) {
      // 收入底稿第一轮：客观事实提取。
      const parsed = { facts: clone(REVENUE_FACTS) };
      return { content: JSON.stringify(parsed), parsed };
    }
    const ruleId = asString(params.ruleId);
    const keys = requestedKeysFromPrompt(prompt);
    const items = itemsForRequest(ruleId, keys);
    const parsed = { items };
    return { content: JSON.stringify(parsed), parsed };
  },

  "audipick.export": (params) => {
    const rows = Array.isArray(params.results) ? params.results : [];
    const output = asString(params.outputPath) || "C:\\演示数据\\合同审阅底稿";
    const withExtension = output.replace(/\.xlsx$/i, "") + ".xlsx";
    return {
      outputPaths: [withExtension],
      rows: rows.length,
      ruleId: asString(params.ruleId),
    };
  },

  "audipick.backup_export": (params) => {
    const output = asString(params.outputPath) || "C:\\演示数据\\合同项目备份";
    const withExtension = output.replace(/\.zip$/i, "") + ".zip";
    const documents = [...documentsByProject.values()].reduce(
      (sum, list) => sum + list.length,
      0,
    );
    return {
      outputPaths: [withExtension],
      version: 2,
      projects: projectsStore.length,
      documents,
      verified: true,
    };
  },
};

// ---------------------------------------------------------------------------
// 任务剧本：audipick.batch_extract（排队 → 逐份进行 → 完成）
// completed 事件的 result 与 audipick.rs run_batch 逐字段对齐：
// { ruleId, documents: [{id,name,ok,content?,parsed?,error?}], completed, total, outputPaths }
// 文件名含「扫描件」的文档按真实 worker 行返回 ok=false（文字层缺失），
// 用于检查「批量提取失败 N 份」错误清单布局。
// ---------------------------------------------------------------------------

const documentItems = (name: string, ruleId: string, keys: string[]): Array<Dict> => {
  if (name.includes("借款")) return dedicatedItemsFor("loan_covenant", keys) ?? genericItemsFor(keys);
  if (name.includes("采购") || name.includes("框架"))
    return dedicatedItemsFor("procurement", keys) ?? genericItemsFor(keys);
  return itemsForRequest(ruleId, keys);
};

export const jobHandlers: Record<string, (params: Dict) => DemoJobEvent[]> = {
  "audipick.batch_extract": (params) => {
    const documents = Array.isArray(params.documents)
      ? (params.documents as Array<Dict>)
      : [];
    const ruleId = asString(params.ruleId);
    const keys = toStringArray(params.fieldKeys);
    const total = documents.length;
    const running: DemoJobEvent[] = documents.map((document, index) => ({
      phase: "running",
      current: index + 1,
      total,
      message: `正在批量提取合同（${index + 1}/${total}）：${asString(document.name)}`,
      severity: "info",
      outputPaths: [],
    }));
    const results = documents.map((document) => {
      const id = asString(document.id);
      const name = asString(document.name) || id;
      if (name.includes("扫描件")) {
        return {
          id,
          name,
          ok: false,
          error: {
            code: "AUDIPICK_TEXT_MISSING",
            userMessage: "请先读取并保存合同文字。",
          },
        };
      }
      const items = documentItems(name, ruleId, keys);
      const content = JSON.stringify({ items });
      return { id, name, ok: true, content, parsed: { items } };
    });
    const failures = results.filter((item) => !item.ok).length;
    return [
      {
        phase: "queued",
        current: 0,
        total,
        message: "批量提取任务已进入队列…",
        severity: "info",
        outputPaths: [],
      },
      ...running,
      {
        phase: "completed",
        current: total,
        total,
        message: failures
          ? `批量提取完成：成功 ${total - failures} 份，失败 ${failures} 份，请核对失败清单。`
          : `批量提取完成：成功提取 ${total} 份合同，请逐条复核。`,
        severity: failures ? "warning" : "success",
        outputPaths: [],
        result: {
          ruleId,
          documents: results,
          completed: total,
          total,
          outputPaths: [],
        },
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// 处理工作日志预置：日志由页面自管在 localStorage，这里仅在演示开关打开且
// 日志为空时写入若干条，让「处理工作日志」视图随时有数据可看。
// ---------------------------------------------------------------------------

const WORK_LOG_KEY = "audit-toolbox.audipick.log";

const WORK_LOG_SEED = [
  {
    id: 1,
    fileName: "流动资金借款合同（华远集团-工行城南支行）.pdf",
    step: "导入",
    detail: "PDF 文件已导入",
    status: "done",
    time: "09:12:40",
  },
  {
    id: 2,
    fileName: "采购框架协议（华远集团-中州重工）.pdf",
    step: "导入",
    detail: "PDF 文件已导入",
    status: "done",
    time: "09:13:05",
  },
  {
    id: 3,
    fileName: "设备采购合同扫描件（华远集团-恒信贸易）.pdf",
    step: "文字识别",
    detail: "识别扫描件第 1-6 页",
    status: "warn",
    time: "09:15:22",
  },
  {
    id: 4,
    fileName: "流动资金借款合同（华远集团-工行城南支行）.pdf",
    step: "AI 提取",
    detail: "提取 3 条，分 1 段处理",
    status: "done",
    time: "09:18:56",
  },
  {
    id: 5,
    fileName: "设备采购合同扫描件（华远集团-恒信贸易）.pdf",
    step: "AI 提取",
    detail: "提取失败",
    status: "error",
    time: "09:21:10",
  },
  {
    id: 6,
    fileName: "3 份文档",
    step: "批量提取",
    detail: "按「借款·限制性契约」模板启动",
    status: "info",
    time: "09:22:00",
  },
];

if (
  typeof localStorage !== "undefined" &&
  localStorage.getItem("audit-toolbox.demo-data") === "1" &&
  !localStorage.getItem(WORK_LOG_KEY)
) {
  try {
    localStorage.setItem(WORK_LOG_KEY, JSON.stringify(WORK_LOG_SEED));
  } catch {
    /* 忽略：预览环境可能禁用 localStorage */
  }
}
