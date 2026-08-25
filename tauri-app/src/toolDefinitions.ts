export type FieldDefinition = {
  key: string; label: string; kind: "file" | "files" | "folder" | "save" | "text" | "date" | "select" | "boolean";
  required?: boolean; extensions?: string[]; options?: {label: string; value: string}[]; placeholder?: string;
};
export type ActionDefinition = { label: string; method: string; mode: "call" | "job"; tone?: "primary" | "secondary" };
export type ToolDefinition = { intro: string; fields: FieldDefinition[]; actions: ActionDefinition[] };

const excel = ["xlsx", "xls", "xlsm", "csv"];
export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  deposit_interest: {
    intro: "识别货币资金科目，按序时账还原逐月余额，以月均余额乘存款利率重算利息并与 TB 利息收入勾稽。",
    fields: [], actions: [{label:"生成Excel底稿",method:"deposit.export",mode:"job",tone:"primary"}]
  },
  loan_interest: {
    intro: "以完整借款台账或 TB＋JE 重建的本金变动表为基准，重新测算借款利息。",
    fields: [], actions: [{label:"生成Excel底稿",method:"loan.export",mode:"job",tone:"primary"}]
  },
  fuzzy_match: {
    intro: "对两列公司名称/人名/地址/通用文本做模糊匹配核对，高相似度自动采纳、疑似项人工确认后导出底稿。",
    fields: [], actions: [{label:"导出Excel",method:"fuzzy.export",mode:"job",tone:"primary"}]
  },
  fx_audit: {
    intro: "使用官方人民币汇率中间价重算已实现及未实现汇兑损益，并生成可追踪审计底稿。",
    fields: [], actions: [{label:"生成Excel底稿",method:"fx.export",mode:"job",tone:"primary"}]
  },
  file_list_directory: {
    intro: "扫描文件夹层级，生成包含完整路径和可点击超链接的 Excel 清单。",
    fields: [
      {key:"sourceDir",label:"源文件夹",kind:"folder",required:true},
      {key:"outputPath",label:"输出文件",kind:"save",required:true,extensions:["xlsx"]}
    ], actions: [
      {label:"扫描预览",method:"file_list.scan",mode:"call",tone:"secondary"},
      {label:"生成文件清单",method:"file_list.export",mode:"job",tone:"primary"}
    ]
  },
  pdf_to_excel: {
    intro: "批量把文字版回函 PDF 逐行转成 Excel，并自动提取回函中的表格。",
    fields: [
      {key:"pdfPaths",label:"回函 PDF",kind:"files",required:true,extensions:["pdf"]},
      {key:"outputDir",label:"输出文件夹",kind:"folder"}
    ], actions: [
      {label:"开始转换",method:"pdf2excel.convert",mode:"job",tone:"primary"}
    ]
  },
  wp_service_generator: {
    intro: "校验工作目录中的 FY27 WP 服务单与 Section List，并生成拆分及汇总文件。",
    fields: [{key:"folder",label:"工作目录",kind:"folder",required:true}],
    actions: [
      {label:"检查输入",method:"wp.validate",mode:"call",tone:"secondary"},
      {label:"生成服务方案",method:"wp.generate",mode:"job",tone:"primary"}
    ]
  },
  confirmation_progress: {
    intro: "读取函证清单，生成银行或往来函证的项目、发函单位与基准日统计。",
    fields: [
      {key:"inputPath",label:"函证清单",kind:"file",required:true,extensions:excel},
      {key:"mode",label:"统计类型",kind:"select",required:true,options:[{label:"银行函证",value:"bank"},{label:"往来函证",value:"trade"},{label:"两类都生成",value:"both"}]}
    ], actions: [
      {label:"检查数据",method:"confirmation.inspect",mode:"call",tone:"secondary"},
      {label:"生成进度报告",method:"confirmation.process",mode:"job",tone:"primary"}
    ]
  },
  Excel_Merger: {
    intro: "批量检查并合并 Excel/CSV；文件列表支持一次多选。",
    fields: [
      {key:"inputPaths",label:"输入文件",kind:"files",required:true,extensions:excel},
      {key:"outputPath",label:"输出文件",kind:"save",required:true,extensions:["xlsx","csv"]},
      {key:"mergeMode",label:"合并方式",kind:"select",options:[{label:"全部纵向堆叠",value:"all"},{label:"按 Sheet 名称",value:"sheet_name"}]}
    ], actions:[{label:"检查文件",method:"excel_merger.inspect",mode:"call",tone:"secondary"},{label:"开始合并",method:"excel_merger.merge",mode:"job",tone:"primary"}]
  },
  fa_list: {
    intro: "按组合键匹配期初、期末固定资产表，并生成 FA List、变动和汇总底稿。",
    fields: [
      {key:"beginPath",label:"期初文件",kind:"file",required:true,extensions:excel},
      {key:"endPath",label:"期末文件",kind:"file",required:true,extensions:excel},
      {key:"beginSheet",label:"期初 Sheet",kind:"text",placeholder:"留空自动选择"},
      {key:"endSheet",label:"期末 Sheet",kind:"text",placeholder:"留空自动选择"},
      {key:"beginKeys",label:"期初匹配列",kind:"text",required:true,placeholder:"多列用逗号分隔"},
      {key:"endKeys",label:"期末匹配列",kind:"text",required:true,placeholder:"多列用逗号分隔"},
      {key:"outputPath",label:"输出文件",kind:"save",extensions:["xlsx"]}
    ], actions:[{label:"读取结构",method:"fa.inspect",mode:"call",tone:"secondary"},{label:"匹配预览",method:"fa.match",mode:"job",tone:"primary"}]
  },
  fa_dep_calc: {
    intro: "上传期末固定资产清单，逐卡重算折旧并生成带活公式的折旧测算表。",
    fields: [], actions: [{label:"生成折旧测算表",method:"fa.dep_export",mode:"job",tone:"primary"}]
  },
  fa_policy_compare: {
    intro: "匹配期初与期末清单，对比两期折旧政策并附税法最低折旧年限参考。",
    fields: [], actions: [{label:"生成折旧政策对比",method:"fa.policy_export",mode:"job",tone:"primary"}]
  },
  ts_manager: {
    intro: "加载 Timesheet 数据，配置筛选条件并按经理、项目或自定义字段透视。",
    fields:[
      {key:"inputPath",label:"Timesheet 文件",kind:"file",required:true,extensions:excel},
      {key:"sheet",label:"Sheet",kind:"text"},{key:"headerRow",label:"标题行（从1开始）",kind:"text",placeholder:"1"},
      {key:"pivotMode",label:"透视模式",kind:"select",options:[{label:"按经理",value:"manager"},{label:"按项目",value:"project"},{label:"自定义",value:"custom"}]},
      {key:"outputPath",label:"输出文件",kind:"save",extensions:["xlsx"]}
    ], actions:[{label:"读取结构",method:"ts.inspect",mode:"call",tone:"secondary"},{label:"生成透视",method:"ts.pivot",mode:"job",tone:"primary"}]
  },
  kanzhang: {
    intro: "导入凭证，确认字段映射，筛选科目并按批次生成凭证与透视结果。",
    fields:[
      {key:"inputPath",label:"凭证文件",kind:"file",required:true,extensions:[...excel,"parquet","txt"]},
      {key:"sheet",label:"Sheet",kind:"text"},{key:"headerRow",label:"标题行（从1开始）",kind:"text",placeholder:"1"},
      {key:"outputDir",label:"输出目录",kind:"folder"}
    ], actions:[{label:"读取并自动映射",method:"kanzhang.inspect",mode:"call",tone:"secondary"},{label:"生成预览",method:"kanzhang.filter",mode:"job",tone:"primary"}]
  },
  je_sign_mark: {
    intro: "加载凭证、确认字段映射，按批次选定目标科目，导出带正负数智能匹配标记的完整凭证明细。",
    fields:[
      {key:"inputPath",label:"凭证文件",kind:"file",required:true,extensions:[...excel,"parquet","txt"]},
      {key:"sheet",label:"Sheet",kind:"text"},{key:"headerRow",label:"标题行（从1开始）",kind:"text",placeholder:"1"},
      {key:"outputPath",label:"输出文件",kind:"file"}
    ], actions:[{label:"读取并自动映射",method:"kanzhang.mark_inspect",mode:"job",tone:"secondary"},{label:"标记并导出",method:"kanzhang.mark_export",mode:"job",tone:"primary"}]
  },
  audit_roll_forward: {
    intro: "将上年度标准底稿结转到本年度，迁移期初、公式、措辞和 CRA 信息。",
    fields:[
      {key:"templateDir",label:"模板目录",kind:"folder",required:true},{key:"priorDir",label:"上年底稿目录",kind:"folder",required:true},
      {key:"pmtePath",label:"PMTE/CRA 文件",kind:"file",extensions:excel},{key:"outputDir",label:"输出目录",kind:"folder",required:true},
      {key:"subjectCodes",label:"科目代码",kind:"text",required:true,placeholder:"例如 C,J1,K1"},
      {key:"companyName",label:"公司名称",kind:"text",required:true},{key:"bsDate",label:"资产负债表日",kind:"date",required:true}
    ], actions:[{label:"检查模板与底稿",method:"roll_forward.validate",mode:"call",tone:"secondary"},{label:"开始结转",method:"roll_forward.process",mode:"job",tone:"primary"}]
  },
  audipick: {
    intro: "统一管理合同、PDF、OCR、条款规则、文件关联及收入合同审阅底稿。",
    fields:[
      {key:"projectName",label:"项目名称",kind:"text",required:true},{key:"pdfPaths",label:"合同 PDF",kind:"files",extensions:["pdf"]},
      {key:"ruleId",label:"审阅规则",kind:"select",options:[{label:"贷款契约",value:"loan_covenant"},{label:"收入合同底稿",value:"revenue_workpaper"}]}
    ], actions:[{label:"读取项目状态",method:"audipick.projects",mode:"call",tone:"primary"}]
  }
};
