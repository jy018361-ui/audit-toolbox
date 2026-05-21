"""字段同义词、必需列定义、sheet 内容特征权重。"""

from ingest.models import SheetKind

# 按 sheet 类型区分的字段同义词；匹配时传入 sheet_kind 以排除误映射
FIELD_SYNONYMS: dict[str, list[str]] = {
    "asset_category": [
        "固定资产类别", "资产类别", "类别", "企业类别名称",
        "资产分类长描述", "报表披露分类", "旧系统分类",
    ],
    "asset_id": [
        "固定资产编号", "资产编号", "资产编码", "卡片编号", "卡片编码",
        "旧系统编码", "序列号", "编号",
    ],
    "asset_name": [
        "固定资产名称", "资产名称", "名称", "规格型号", "附加资产描述",
    ],
    "start_date": [
        "入账开始日期", "开始入账日期", "开始使用日期", "资本化日期",
        "启用日期", "入账日期", "首次购置日期",
    ],
    "useful_life_months": [
        "使用寿命(月)", "使用寿命（月）", "使用寿命", "使用年限(月)",
        "使用年限(年)", "预计使用期间数", "计划使用年限", "折旧年期",
    ],
    "salvage_rate": [
        "残值率", "预计净残值率", "净残值率", "预计残值", "残值(%)", "残值",
    ],
    "original_value": [
        "原值", "资产原值", "入账价值", "固定资产原值", "期初原值", "期末原值",
        "2025年末原值", "处置原值",
    ],
    "accumulated_depreciation": [
        "累计折旧", "累折", "期初累计折旧", "期末累计折旧", "处置累计折旧",
        "2025年末累计折旧",
    ],
    "impairment_provision": [
        "减值准备", "减值", "累计减值准备", "固定资产减值",
    ],
    "net_value": [
        "净值", "账面净值", "资产净值", "账面价值", "2025年末净值", "处置净值",
    ],
    "addition_method": ["新增方式", "增加方式", "变动方式", "卡片来源"],
    "disposal_date": ["处置日期", "报废日期", "减少日期", "业务日期"],
    "disposal_method": ["处置/报废", "减少方式", "处置方式", "报废方式"],
    "current_depreciation": [
        "本期计提折旧", "本期计提", "折旧费用", "本年折旧",
        "账面计提折旧费用", "本期应折旧金额",
    ],
    "fully_depreciated_flag": ["已提足折旧", "上年是否已提足折旧"],
    "fully_depreciated_date": ["提足折旧时间"],
    # lead / rollforward 辅助
    "te": ["可容忍误差", "te", "可容忍误差（te）"],
    "sad": ["名义金额", "sad", "名义金额（sad）"],
    "client_name": ["客户名称"],
    "period_end": ["期末"],
}

# 禁止作为 asset_id 的表头（处置清单等）
BLOCKED_ASSET_ID_HEADERS = {"单据编号", "单据类型", "单据状态", "卡片来源"}

# FA list 语义必需 / 建议（映射到标准字段即算满足）
FA_LIST_REQUIRED = [
    "original_value",
    "accumulated_depreciation",
    "net_value",
]
FA_LIST_REQUIRED_IDENTITY = ("asset_id", "asset_name")  # 至少其一
FA_LIST_RECOMMENDED = [
    "asset_category",
    "start_date",
    "useful_life_months",
    "salvage_rate",
]

REQUIRED_BY_KIND: dict[SheetKind, list[str]] = {
    SheetKind.FA_LIST: list(FA_LIST_REQUIRED),
    SheetKind.ADDITION_LIST: [
        "asset_category", "asset_id", "asset_name", "start_date",
        "original_value", "addition_method",
    ],
    SheetKind.DISPOSAL_LIST: [
        "asset_category", "asset_id", "asset_name", "original_value",
        "accumulated_depreciation", "net_value", "disposal_date", "disposal_method",
    ],
    SheetKind.DEPRECIATION_TOD: [
        "asset_category", "asset_id", "asset_name", "start_date",
        "useful_life_months", "salvage_rate", "original_value",
        "accumulated_depreciation", "net_value", "current_depreciation",
    ],
}

# 内容识别：某 sheet_kind 若映射到这些字段则加分
CONTENT_SIGNATURES: dict[SheetKind, set[str]] = {
    SheetKind.FA_LIST: {
        "asset_id", "asset_name", "original_value",
        "accumulated_depreciation", "net_value",
    },
    SheetKind.ADDITION_LIST: {"addition_method", "original_value", "asset_id", "asset_name"},
    SheetKind.DISPOSAL_LIST: {
        "disposal_date", "disposal_method", "net_value",
        "original_value", "accumulated_depreciation",
    },
    SheetKind.DEPRECIATION_TOD: {
        "current_depreciation", "original_value", "useful_life_months",
        "salvage_rate", "asset_id",
    },
    SheetKind.DEPRECIATION_TOD_SAMPLE: {"current_depreciation", "asset_id", "original_value"},
    SheetKind.LEAD: {"te", "sad", "client_name", "period_end"},
    SheetKind.ROLLFORWARD: {"original_value", "accumulated_depreciation", "net_value"},
    SheetKind.SAP: {"te"},
    SheetKind.DEPRECIATION_POLICY: set(),
}

SKIP_SHEET_PREFIXES = ("DS_INTERNAL_", "SkywindSettingSheet")
