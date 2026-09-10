//! 两列模糊匹配：把 A/B 两份 Excel 的指定列做归一化后逐行配对，
//! 产出「自动匹配 / 疑似匹配（人工确认）/ 未匹配 / 无效值」四级结果。
//!
//! 管线四步：
//! 1. 归一化 [`normalize`]——全半角（NFKC 子集）、顿号逗号统一、小写、
//!    去全部空白与零宽字符、间隔号变体归一、繁→简（OpenCC TS 词典）、
//!    公司后缀归一映射、人名称谓剥离；
//! 2. 公司名解析 [`parse_company`]——剥后缀 → 剥行政区划前缀 → 剥行业词，
//!    剩余即字号（brand，匹配主键）；
//! 3. 粗筛 [`CoarseIndex`]——对 B 侧建 bigram 倒排索引，A 行按「命中的不同
//!    bigram 数」取 top 200 候选 + 三倍长度过滤，避免 O(n²) 全量精算；
//! 4. 精算 [`score_pair`]——Levenshtein 比率 / LCS 比率 / bigram Dice 按
//!    0.40/0.35/0.25 加权，叠加「字号包含提分」与「行政区域不一致降级」两条
//!    规则，按阈值分级，每行保留 topK 候选供疑似确认。
//!
//! 词表资源全部内嵌自 `assets/fuzzy-match/`（与 roll-forward、wp 资源同构，
//! 来源与协议见该目录 SOURCES.md），加载点集中在 [`asset_texts`] 一处；
//! 文件解析失败时降级到本文件内的内置精简词表（见各 `FALLBACK_` 常量），不阻塞任务。

use crate::{AppError, excel_merger::PauseCheckpoint, storage::Storage};
use calamine::{Data, Reader, open_workbook_auto};
use chrono::{Local, Utc};
use rusqlite::{Connection, params};
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

/// 粗筛后进入精算的候选上限（规格约定 200）。
const CANDIDATE_LIMIT: usize = 200;
/// 粗筛长度过滤：两侧字符数相差超过 3 倍即跳过。
const LENGTH_RATIO_MAX: usize = 3;
/// 每多少行 A 检查一次取消标记（批间只查 cancel，阶段间才 pause）。
const CANCEL_BATCH: usize = 256;
/// 加权权重：字符相似 0.40 / 最长公共子序列 0.35 / 词组重叠 0.25。
const W_CHAR: f64 = 0.40;
const W_LCS: f64 = 0.35;
const W_TOKEN: f64 = 0.25;
/// 字号包含规则给到的保底分（≥ 默认自动阈值 90，仍受区域冲突降级约束）。
const BRAND_CONTAIN_SCORE: f64 = 93.0;

// ============================================================
// 对外入口（签名由接线任务依赖，勿改）
// ============================================================

/// 同步短方法：`fuzzy.inspect` 读文件返回表头/预览/建议列。
/// 其余方法（含 `fuzzy.history`——任务历史属接线层 Storage 职责）一律报
/// METHOD_NOT_FOUND，不允许静默回退。
pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "fuzzy.inspect" => inspect(&params),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到两列匹配业务方法。",
            Some(method.into()),
        )),
    }
}

/// 耗时任务：`fuzzy.match` 跑匹配管线，`fuzzy.export` 把接线层从库里取出的
/// 结果写成三张 Sheet 的 Excel。进度回调用法与借款利息一致（阶段、当前、
/// 总数、中文消息）。
pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    match method {
        "fuzzy.match" => {
            checkpoint(&cancel, pause)?;
            progress("load", 1, 4, "正在读取 A 侧数据…");
            let out = match_flow(&params, progress, &cancel, pause)?;
            checkpoint(&cancel, pause)?;
            persist_if_wired(&params, &out)?;
            progress("done", 4, 4, "两列匹配完成。");
            Ok(out)
        }
        "fuzzy.export" => {
            checkpoint(&cancel, pause)?;
            progress("export", 1, 1, "正在生成两列匹配结果 Excel…");
            export_flow(&params)
        }
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到两列匹配任务方法。",
            Some(method.into()),
        )),
    }
}

fn checkpoint(cancel: &AtomicBool, pause: &PauseCheckpoint) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    pause.wait()
}

// ============================================================
// 词表资源：include_str! 全部集中在此，后续把 assets 目录迁到
// tauri-app/assets/ 时只改这一个函数。
// ============================================================

/// 内嵌词表原文（编译期读入，改文件需重新编译 Rust）。
fn asset_texts() -> (&'static str, &'static str, &'static str, &'static str) {
    (
        include_str!("../../assets/fuzzy-match/company_suffix.json"),
        include_str!("../../assets/fuzzy-match/china_regions.json"),
        include_str!("../../assets/fuzzy-match/TSCharacters.txt"),
        include_str!("../../assets/fuzzy-match/TSPhrases.txt"),
    )
}

/// 内置兜底：公司后缀剥离词（长度降序）。assets 词表解析失败时使用。
const FALLBACK_STRIP_SUFFIXES: &[&str] = &[
    "控股集团有限公司",
    "有限责任公司",
    "股份有限公司",
    "特殊普通合伙企业",
    "普通合伙企业",
    "有限合伙企业",
    "个体工商户",
    "集团有限公司",
    "控股集团",
    "合伙企业",
    "研究所",
    "研究院",
    "集团公司",
    "代表处",
    "办事处",
    "分公司",
    "合作社",
    "事务所",
    "总公司",
    "有限公司",
    "大学",
    "学院",
    "医院",
    "银行",
    "分行",
    "支行",
    "商行",
    "商店",
    "超市",
    "集团",
    "中心",
    "公司",
    "分行",
    "餐厅",
    "厂",
    "店",
    "部",
    "馆",
    "坊",
];
/// 内置兜底：后缀归一映射（加载 assets 版时同样先经基础归一化预处理）。
const FALLBACK_NORMALIZE_MAP: &[(&str, &str)] = &[
    ("股份有限公司", "有限公司"),
    ("有限责任公司", "有限公司"),
    ("股份公司", "有限公司"),
    ("集团有限公司", "有限公司"),
    ("控股有限公司", "有限公司"),
    ("ltd.", "ltd"),
    ("co.", "co"),
    ("corp.", "corp"),
    ("inc.", "inc"),
];
/// 内置兜底：行政区划（省级 + 常见市级，含常用简称）。
const FALLBACK_REGIONS: &[&str] = &[
    "黑龙江省",
    "乌鲁木齐市",
    "呼和浩特市",
    "石家庄市",
    "哈尔滨市",
    "内蒙古自治区",
    "广西壮族自治区",
    "宁夏回族自治区",
    "新疆维吾尔自治区",
    "西藏自治区",
    "香港特别行政区",
    "澳门特别行政区",
    "石家庄",
    "哈尔滨",
    "乌鲁木齐",
    "呼和浩特",
    "山西",
    "辽宁",
    "吉林",
    "江苏",
    "浙江",
    "安徽",
    "福建",
    "江西",
    "山东",
    "河南",
    "湖北",
    "湖南",
    "广东",
    "海南",
    "四川",
    "贵州",
    "云南",
    "陕西",
    "甘肃",
    "青海",
    "台湾",
    "内蒙",
    "广西",
    "西藏",
    "宁夏",
    "新疆",
    "香港",
    "澳门",
    "河北",
    "太原",
    "沈阳",
    "长春",
    "南京",
    "杭州",
    "合肥",
    "福州",
    "南昌",
    "济南",
    "郑州",
    "武汉",
    "长沙",
    "广州",
    "海口",
    "成都",
    "贵阳",
    "昆明",
    "西安",
    "兰州",
    "西宁",
    "拉萨",
    "银川",
    "南宁",
    "深圳",
    "大连",
    "青岛",
    "宁波",
    "厦门",
    "苏州",
    "无锡",
    "佛山",
    "东莞",
    "珠海",
    "温州",
    "泉州",
    "烟台",
    "唐山",
    "北京市",
    "天津市",
    "上海市",
    "重庆市",
    "北京",
    "天津",
    "上海",
    "重庆",
];
/// 内置兜底：繁→简常用字对（正常路径走 OpenCC TSCharacters 全表）。
const FALLBACK_T2S_CHARS: &[(char, char)] = &[
    ('萬', '万'),
    ('華', '华'),
    ('東', '东'),
    ('車', '车'),
    ('馬', '马'),
    ('鳥', '鸟'),
    ('龍', '龙'),
    ('鳳', '凤'),
    ('龜', '龟'),
    ('門', '门'),
    ('問', '问'),
    ('開', '开'),
    ('關', '关'),
    ('長', '长'),
    ('烏', '乌'),
    ('魚', '鱼'),
    ('貝', '贝'),
    ('見', '见'),
    ('買', '买'),
    ('賣', '卖'),
    ('貸', '贷'),
    ('貿', '贸'),
    ('費', '费'),
    ('賀', '贺'),
    ('資', '资'),
    ('賬', '账'),
    ('質', '质'),
    ('領', '领'),
    ('頭', '头'),
    ('額', '额'),
    ('顧', '顾'),
    ('風', '风'),
    ('飛', '飞'),
    ('飯', '饭'),
    ('養', '养'),
    ('餘', '余'),
    ('館', '馆'),
    ('廠', '厂'),
    ('廢', '废'),
    ('區', '区'),
    ('產', '产'),
    ('礦', '矿'),
    ('於', '于'),
    ('會', '会'),
    ('個', '个'),
    ('們', '们'),
    ('億', '亿'),
    ('償', '偿'),
    ('儀', '仪'),
    ('備', '备'),
    ('債', '债'),
    ('傳', '传'),
    ('傷', '伤'),
    ('價', '价'),
    ('儲', '储'),
    ('兒', '儿'),
    ('內', '内'),
    ('兩', '两'),
    ('冊', '册'),
    ('來', '来'),
    ('況', '况'),
    ('刪', '删'),
    ('別', '别'),
    ('劃', '划'),
    ('劉', '刘'),
    ('則', '则'),
];
/// 内置兜底：繁→简词组对（正常路径走 OpenCC TSPhrases 全表）。
const FALLBACK_T2S_PHRASES: &[(&str, &str)] = &[
    ("聯想集團", "联想集团"),
    ("華為技術", "华为技术"),
    ("萬科企業", "万科企业"),
    ("騰訊科技", "腾讯科技"),
];
/// 行业词表（长度降序）：从字号后的剩余里剥行业词，剩余≥2 字才剥。
/// assets 目录暂无对应文件，此表为本模块内置。
const INDUSTRY_WORDS: &[&str] = &[
    "供应链管理",
    "资产管理",
    "房地产开发",
    "网络科技",
    "信息科技",
    "新能源科技",
    "实业发展",
    "科技发展",
    "投资管理",
    "企业管理",
    "文化传播",
    "商贸",
    "贸易",
    "实业",
    "投资",
    "科技",
    "技术",
    "信息",
    "网络",
    "数据",
    "智能",
    "软件",
    "通信",
    "通讯",
    "电子",
    "电气",
    "机械",
    "设备",
    "建材",
    "建筑",
    "装饰",
    "装修",
    "工程",
    "咨询",
    "服务",
    "传媒",
    "广告",
    "文化",
    "教育",
    "培训",
    "医疗",
    "医药",
    "生物",
    "能源",
    "环保",
    "物流",
    "运输",
    "仓储",
    "地产",
    "置业",
    "金融",
    "保险",
    "证券",
    "基金",
    "农业",
    "林业",
    "矿业",
    "化工",
    "纺织",
    "服饰",
    "食品",
    "餐饮",
    "酒店",
    "旅游",
    "娱乐",
    "零售",
    "批发",
    "航空",
    "航天",
    "船舶",
    "汽车",
    "交通",
    "安防",
    "光电",
    "照明",
];
/// 人名称谓后缀（长度降序）：person 类型归一化末尾剥离，剩余≥2 字才剥。
const PERSON_TITLES: &[&str] = &[
    "副总经理",
    "董事长",
    "总经理",
    "工程师",
    "会计师",
    "先生们",
    "先生",
    "女士",
    "小姐",
    "同志",
    "经理",
    "总监",
    "总裁",
    "博士",
    "教授",
    "老师",
    "律师",
    "医师",
    "大夫",
    "护士",
    "警官",
    "警察",
    "书记",
    "主任",
    "科长",
    "处长",
    "局长",
    "部长",
    "厂长",
    "委员",
    "代表",
    "董事",
    "监事",
    "主管",
    "职员",
    "员工",
    "师傅",
];

/// 行业词表预排序缓存（长度降序），避免逐行解析时重复分配。
fn industry_table() -> &'static Vec<String> {
    static TABLE: OnceLock<Vec<String>> = OnceLock::new();
    TABLE.get_or_init(|| sorted_by_len_desc(INDUSTRY_WORDS.iter().map(|s| (*s).into()).collect()))
}

/// 公司后缀词表：剥离词（长度降序）+ 归一映射（保持文件顺序）。
struct SuffixTable {
    strip: Vec<String>,
    normalize: Vec<(String, String)>,
}

fn suffix_table() -> &'static SuffixTable {
    static TABLE: OnceLock<SuffixTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        let (suffix_json, _, _, _) = asset_texts();
        #[derive(Deserialize)]
        struct FileShape {
            #[serde(default)]
            strip_words: Vec<String>,
            #[serde(default)]
            normalize_map: HashMap<String, String>,
        }
        let parsed: Option<FileShape> = serde_json::from_str(suffix_json).ok();
        match parsed {
            Some(f) if !f.strip_words.is_empty() => SuffixTable {
                // 词表文件本身按长度降序，这里再兜底排一次，防止后续被人为打乱。
                strip: sorted_by_len_desc(f.strip_words),
                normalize: f
                    .normalize_map
                    .into_iter()
                    .map(|(k, v)| (base_normalize(&k), base_normalize(&v)))
                    .collect(),
            },
            _ => {
                // 词表文件缺失/损坏：降级内置表（词组覆盖面小，但不阻塞任务）。
                SuffixTable {
                    strip: FALLBACK_STRIP_SUFFIXES
                        .iter()
                        .map(|s| (*s).into())
                        .collect(),
                    normalize: FALLBACK_NORMALIZE_MAP
                        .iter()
                        .map(|(k, v)| (base_normalize(k), base_normalize(v)))
                        .collect(),
                }
            }
        }
    })
}

/// 行政区划表：省/市两级名称与常用别称（区县级不参与——同名区县与常见字号
/// 撞车，前缀剥离误伤字号的风险大于收益），长度降序便于最长前缀匹配。
fn region_table() -> &'static Vec<String> {
    static TABLE: OnceLock<Vec<String>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let (_, regions_json, _, _) = asset_texts();
        #[derive(Deserialize)]
        struct FileShape {
            #[serde(default)]
            provinces: Vec<Province>,
        }
        #[derive(Deserialize)]
        struct Province {
            #[serde(default)]
            name: String,
            #[serde(default)]
            aliases: Vec<String>,
            #[serde(default)]
            cities: Vec<City>,
        }
        #[derive(Deserialize)]
        struct City {
            #[serde(default)]
            name: String,
            #[serde(default)]
            aliases: Vec<String>,
        }
        let mut words: HashSet<String> = HashSet::new();
        if let Ok(f) = serde_json::from_str::<FileShape>(regions_json) {
            for p in &f.provinces {
                for w in once(&p.name).chain(p.aliases.iter()).chain(
                    p.cities
                        .iter()
                        .flat_map(|c| once(&c.name).chain(c.aliases.iter())),
                ) {
                    // 单字词（理论上没有）误伤字号，直接不收。
                    if w.chars().count() >= 2 {
                        words.insert(w.clone());
                    }
                }
            }
        }
        if words.is_empty() {
            words.extend(FALLBACK_REGIONS.iter().map(|s| (*s).to_string()));
        }
        sorted_by_len_desc(words.into_iter().collect())
    })
}

/// 繁→简词典：先词组级最长匹配，再逐字符替换（OpenCC 官方设计即以单字表为主、
/// 词组表做多音/异体修正）。
struct T2sTable {
    phrases: HashMap<String, String>,
    chars: HashMap<char, char>,
    max_phrase_chars: usize,
}

fn t2s() -> &'static T2sTable {
    static TABLE: OnceLock<T2sTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        let (_, _, chars_text, phrases_text) = asset_texts();
        // TSV：原文<TAB>转换结果（空格分隔多候选取第一个），前几行 # 注释。
        let mut chars = HashMap::new();
        if let Some(pairs) = parse_tsv_pairs(chars_text) {
            for (from, to) in pairs {
                // 只收「单字 → 单字」映射，多字符候选交给词组表处理。
                let f = from.chars().collect::<Vec<_>>();
                let t: Vec<char> = to.chars().collect();
                if f.len() == 1 && t.len() == 1 {
                    chars.entry(f[0]).or_insert(t[0]);
                }
            }
        }
        if chars.is_empty() {
            chars = FALLBACK_T2S_CHARS.iter().copied().collect();
        }
        let mut phrases = HashMap::new();
        if let Some(pairs) = parse_tsv_pairs(phrases_text) {
            for (from, to) in pairs {
                if !from.is_empty() && !to.is_empty() {
                    phrases.entry(from).or_insert(to);
                }
            }
        }
        if phrases.is_empty() {
            phrases = FALLBACK_T2S_PHRASES
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect();
        }
        let max_phrase_chars = phrases
            .keys()
            .map(|k| k.chars().count())
            .max()
            .unwrap_or(0)
            .min(12);
        T2sTable {
            phrases,
            chars,
            max_phrase_chars,
        }
    })
}

/// 解析 OpenCC TSV 词典；一行数据都没有（文件损坏）时返回 None 走兜底。
fn parse_tsv_pairs(text: &str) -> Option<Vec<(String, String)>> {
    let mut out = vec![];
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split('\t');
        let key = parts.next()?.trim();
        let value = parts.next()?.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        // 多候选（空格分隔）取第一个。
        let first = value.split(' ').next().unwrap_or(value);
        out.push((key.to_string(), first.to_string()));
    }
    (!out.is_empty()).then_some(out)
}

/// 按字符数降序排序（等长保持稳定），供最长匹配词表统一口径。
fn sorted_by_len_desc(mut words: Vec<String>) -> Vec<String> {
    words.sort_by(|a, b| {
        b.chars()
            .count()
            .cmp(&a.chars().count())
            .then_with(|| a.cmp(b))
    });
    words
}

fn once<T>(x: T) -> std::iter::Once<T> {
    std::iter::once(x)
}

// ============================================================
// 归一化
// ============================================================

/// 基础归一化（词表键预处理与值归一共用，不含繁简与后缀映射）：
/// 全角→半角（NFKC 的全角 ASCII 区）、全角空格、顿号统一为半角逗号、
/// 小写、去全部空白与零宽字符、间隔号变体统一为「·」。
fn base_normalize(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            // 全角 ASCII 区 U+FF01..=U+FF5E 平移到 U+0021..=U+007E：
            // 全角字母/数字/括号/逗号/句点等一次归一。
            '\u{FF01}'..='\u{FF5E}' => {
                let mapped = char::from_u32(c as u32 - 0xFEE0).unwrap_or(c);
                push_normalized_char(&mut out, mapped);
            }
            // 全角空格。
            '\u{3000}' => {}
            // 中文顿号统一为半角逗号（全角逗号 U+FF0C 已由平移归一）。
            '、' => out.push(','),
            // 常见带单位兼容字符（NFKC 子集）。
            '㎡' => out.push_str("m2"),
            '㎝' => out.push_str("cm"),
            '㎞' => out.push_str("km"),
            '㎏' => out.push_str("kg"),
            _ => push_normalized_char(&mut out, c),
        }
    }
    out
}

/// 单字符的过滤与映射：空白/零宽丢弃、间隔号变体归一、其余转小写。
fn push_normalized_char(out: &mut String, c: char) {
    // 零宽字符（含零宽空格/连接符/软连字符/BOM）全部视为空白丢弃。
    if c.is_whitespace()
        || matches!(
            c,
            '\u{200B}'..='\u{200F}' | '\u{FEFF}' | '\u{2060}' | '\u{00AD}'
        )
    {
        return;
    }
    // 间隔号变体（· • ‧ ． . 半角句点经平移后也是 .）统一为 U+00B7。
    if matches!(c, '\u{00B7}' | '\u{2022}' | '\u{2027}' | '\u{FF0E}' | '.') {
        out.push('\u{00B7}');
        return;
    }
    for lc in c.to_lowercase() {
        out.push(lc);
    }
}

/// 繁→简：对整串先做词组级最长匹配替换，再对剩余字符逐个查单字表。
fn traditional_to_simplified(text: &str) -> String {
    let table = t2s();
    if table.phrases.is_empty() && table.chars.is_empty() {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    'outer: while i < chars.len() {
        let remaining = chars.len() - i;
        // 词组最长匹配：从最长可能长度往下试，命中即整体替换前进。
        let mut len = table.max_phrase_chars.min(remaining);
        while len >= 2 {
            let cand: String = chars[i..i + len].iter().collect();
            if let Some(simple) = table.phrases.get(&cand) {
                out.push_str(simple);
                i += len;
                continue 'outer;
            }
            len -= 1;
        }
        // 单字替换：无映射的字符原样保留。
        let c = chars[i];
        out.push(table.chars.get(&c).copied().unwrap_or(c));
        i += 1;
    }
    out
}

/// 人名称谓剥离：尾部循环剥离（≤2 轮），剩余不足 2 字则不剥（保住「王先生」）。
fn strip_person_titles(norm: &str) -> String {
    let mut s = norm.to_string();
    for _ in 0..2 {
        let mut hit = false;
        for t in PERSON_TITLES {
            if s.ends_with(*t) && s.chars().count() >= t.chars().count() + 2 {
                let cut = s.len() - t.len();
                s.truncate(cut);
                hit = true;
                break;
            }
        }
        if !hit {
            break;
        }
    }
    s
}

/// 完整归一化管线（顺序敏感）：
/// 基础归一 → 繁→简 → 公司后缀归一映射 →（person）称谓剥离。
fn normalize(raw: &str, match_type: &str) -> String {
    let mut s = base_normalize(raw);
    s = traditional_to_simplified(&s);
    for (from, to) in &suffix_table().normalize {
        if !from.is_empty() && s.contains(from.as_str()) {
            s = s.replace(from.as_str(), to);
        }
    }
    if match_type == "person" {
        s = strip_person_titles(&s);
    }
    s
}

/// 无效值判定：归一化后为空、纯数字（含小数点/千分位逗号/间隔号变体）、
/// 单字符——这些行跳过比对，直接归「未匹配（无效值）」。
fn is_invalid_value(norm: &str) -> bool {
    let n = norm.chars().count();
    if n == 0 || n == 1 {
        return true;
    }
    norm.chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '\u{00B7}'))
}

// ============================================================
// 公司名解析
// ============================================================

/// 公司名结构：地名前缀 + 字号 + 行业词 + 后缀。brand（字号）是匹配主键。
#[derive(Clone, Default)]
struct CompanySegments {
    region: String,
    brand: String,
    industry: String,
    suffix: String,
}

/// 解析公司名：循环剥尾部后缀（≤3 轮）→ 循环剥行政区划前缀（≤2 轮）→
/// 剥一轮行业词，剩余即字号。每步都带「剩余≥2 字」保护，防止把字号剥空。
/// 解析不出字号（如纯后缀）返回 None，调用方退化为整串参与打分。
fn parse_company(norm: &str) -> Option<CompanySegments> {
    if norm.chars().count() < 2 {
        return None;
    }
    let mut seg = CompanySegments {
        brand: norm.to_string(),
        ..CompanySegments::default()
    };
    let mut rest = norm.to_string();
    // 1) 尾部后缀循环剥离（集团/控股/有限公司常堆叠出现）。
    for _ in 0..3 {
        match strip_longest_suffix(&rest, &suffix_table().strip) {
            Some(word) => {
                seg.suffix = format!("{word}{}", seg.suffix);
                rest.truncate(rest.len() - word.len());
            }
            None => break,
        }
    }
    // 2) 行政区划前缀剥离（省+市最多两层，如「河北省石家庄市」）。
    for _ in 0..2 {
        match strip_longest_prefix(&rest, region_table()) {
            Some(word) => {
                seg.region.push_str(&word);
                rest.replace_range(0..word.len(), "");
            }
            None => break,
        }
    }
    // 3) 行业词剥一轮。
    if let Some(word) = strip_longest_suffix(&rest, industry_table()) {
        seg.industry = word.clone();
        rest.truncate(rest.len() - word.len());
    }
    if rest.chars().count() < 2 {
        // 剥得过空（如名字只有后缀）：放弃解析，整串当字号。
        return Some(CompanySegments {
            brand: norm.to_string(),
            ..CompanySegments::default()
        });
    }
    seg.brand = rest;
    Some(seg)
}

/// 从尾部剥离最长匹配词；剩余不足 2 字（保字号）或未命中返回 None。
fn strip_longest_suffix(s: &str, words: &[String]) -> Option<String> {
    for w in words {
        if s.ends_with(w.as_str()) && s.chars().count() >= w.chars().count() + 2 {
            return Some(w.clone());
        }
    }
    None
}

/// 从头部剥离最长匹配词；剩余不足 2 字（保字号）或未命中返回 None。
fn strip_longest_prefix(s: &str, words: &[String]) -> Option<String> {
    for w in words {
        if s.starts_with(w.as_str()) && s.chars().count() >= w.chars().count() + 2 {
            return Some(w.clone());
        }
    }
    None
}

/// 行政区域冲突判定：两侧都解析出地名、串不同、且互不为对方的前缀/后缀
/// （「上海」与「上海市」、「石家庄市」与「河北省石家庄市」视为同地）。
fn region_conflict(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() || a == b {
        return false;
    }
    !(a.starts_with(b) || b.starts_with(a) || a.ends_with(b) || b.ends_with(a))
}

// ============================================================
// 相似度算法（不依赖外部 crate，均按字符级计算）
// ============================================================

/// Levenshtein 编辑距离（滚动单行 DP）。
fn levenshtein_distance(a: &[char], b: &[char]) -> usize {
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur: Vec<usize> = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Levenshtein 相似比率：1 - 距离/较长串长度。
fn levenshtein_ratio(a: &[char], b: &[char]) -> f64 {
    let max = a.len().max(b.len());
    if max == 0 {
        return 1.0;
    }
    1.0 - levenshtein_distance(a, b) as f64 / max as f64
}

/// 最长公共子序列长度（滚动单行 DP）。
fn lcs_length(a: &[char], b: &[char]) -> usize {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let mut prev: Vec<usize> = vec![0; b.len() + 1];
    let mut cur: Vec<usize> = vec![0; b.len() + 1];
    for ca in a {
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = if ca == cb {
                prev[j] + 1
            } else {
                prev[j + 1].max(cur[j])
            };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// 最长公共子序列比率：len(lcs) / max(len)。
fn lcs_ratio(a: &[char], b: &[char]) -> f64 {
    let max = a.len().max(b.len());
    if max == 0 {
        return 1.0;
    }
    lcs_length(a, b) as f64 / max as f64
}

/// bigram 集合（相邻两字符，去重）。
fn bigram_set(chars: &[char]) -> Vec<[char; 2]> {
    if chars.len() < 2 {
        return vec![];
    }
    let mut grams: Vec<[char; 2]> = chars.windows(2).map(|w| [w[0], w[1]]).collect();
    grams.sort_unstable();
    grams.dedup();
    grams
}

/// bigram Dice 系数：2×交集 / 两者之和（集合口径）。
fn bigram_dice(a: &[char], b: &[char]) -> f64 {
    let ga = bigram_set(a);
    let gb = bigram_set(b);
    if ga.is_empty() && gb.is_empty() {
        return 1.0;
    }
    if ga.is_empty() || gb.is_empty() {
        return 0.0;
    }
    let (mut i, mut j, mut common) = (0usize, 0usize, 0usize);
    while i < ga.len() && j < gb.len() {
        match ga[i].cmp(&gb[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                common += 1;
                i += 1;
                j += 1;
            }
        }
    }
    2.0 * common as f64 / (ga.len() + gb.len()) as f64
}

/// 简称豁免：长度比超限但短串（≥2 字）完整嵌在长串里（如「华为」在
/// 「华为技术有限公司」中）——这正是字号包含规则要提分的简称场景，
/// 粗筛不能按长度差滤掉。
fn shorter_embedded(a: &SideRow, b: &SideRow) -> bool {
    let (short, long) = if a.norm.chars().count() <= b.norm.chars().count() {
        (&a.norm, &b.norm)
    } else {
        (&b.norm, &a.norm)
    };
    short.chars().count() >= 2 && long.contains(short.as_str())
}

/// 打分明细：三项基础分 + 加权总分 + 命中原因（中文，供前端与导出展示）。
#[derive(Clone)]
struct ScoreBreakdown {
    char_sim: f64,
    lcs_sim: f64,
    token_overlap: f64,
    total: f64,
    reasons: Vec<String>,
}

impl ScoreBreakdown {
    fn to_json(&self) -> Value {
        json!({
            "charSim": round1(self.char_sim * 100.0),
            "lcsSim": round1(self.lcs_sim * 100.0),
            "tokenOverlap": round1(self.token_overlap * 100.0),
            "total": round1(self.total),
            "reasons": self.reasons,
        })
    }
}

/// 单对精算：三算法加权，叠加「字号包含提分」与「行政区域不一致降级」。
fn score_pair(
    a_norm: &str,
    a_chars: &[char],
    a_seg: Option<&CompanySegments>,
    b_norm: &str,
    b_chars: &[char],
    b_seg: Option<&CompanySegments>,
    opts: &MatchOptions,
) -> ScoreBreakdown {
    let char_sim = levenshtein_ratio(a_chars, b_chars);
    let lcs_sim = lcs_ratio(a_chars, b_chars);
    let token_overlap = bigram_dice(a_chars, b_chars);
    let mut total = 100.0 * (W_CHAR * char_sim + W_LCS * lcs_sim + W_TOKEN * token_overlap);
    let mut reasons: Vec<String> = vec![];
    if opts.match_type == "company" {
        let brand_a = a_seg.map(|s| s.brand.as_str()).unwrap_or(a_norm);
        let brand_b = b_seg.map(|s| s.brand.as_str()).unwrap_or(b_norm);
        // 字号包含：一方字号（≥2 字）被另一方完整包含（全串或字号），
        // 如「华为」vs「华为技术有限公司」。单字字号（「华」）不触发。
        let contains = (brand_a.chars().count() >= 2
            && (b_norm.contains(brand_a) || brand_b.contains(brand_a)))
            || (brand_b.chars().count() >= 2
                && (a_norm.contains(brand_b) || brand_a.contains(brand_b)));
        if contains && total < BRAND_CONTAIN_SCORE {
            total = BRAND_CONTAIN_SCORE;
            reasons.push("字号包含".into());
        }
        // 行政区域不一致：即使分数达到自动阈值也强制降为疑似。
        let region_a = a_seg.map(|s| s.region.as_str()).unwrap_or("");
        let region_b = b_seg.map(|s| s.region.as_str()).unwrap_or("");
        if region_conflict(region_a, region_b) && total >= opts.auto_threshold {
            total = opts.auto_threshold - 1.0;
            reasons.push("行政区域不一致，需人工确认".into());
        }
    }
    ScoreBreakdown {
        char_sim,
        lcs_sim,
        token_overlap,
        total: round1(total),
        reasons,
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

// ============================================================
// 数据准备与粗筛
// ============================================================

/// 一侧的一行：原始值、归一化值、字符数组、无效标记、公司结构（company 时）。
struct SideRow {
    value: String,
    norm: String,
    chars: Vec<char>,
    invalid: bool,
    segments: Option<CompanySegments>,
}

fn prepare_row(value: &str, opts: &MatchOptions) -> SideRow {
    let norm = normalize(value, &opts.match_type);
    let chars: Vec<char> = norm.chars().collect();
    let invalid = is_invalid_value(&norm);
    let segments = if opts.match_type == "company" && !invalid {
        parse_company(&norm)
    } else {
        None
    };
    SideRow {
        value: value.trim().to_string(),
        norm,
        chars,
        invalid,
        segments,
    }
}

/// B 侧 bigram 倒排索引（跳过无效行）。
struct CoarseIndex {
    map: HashMap<String, Vec<u32>>,
}

fn build_index(rows: &[SideRow]) -> CoarseIndex {
    let mut map: HashMap<String, Vec<u32>> = HashMap::new();
    for (j, row) in rows.iter().enumerate() {
        if row.invalid {
            continue;
        }
        for g in bigram_set(&row.chars) {
            let mut key = String::with_capacity(8);
            key.push(g[0]);
            key.push(g[1]);
            map.entry(key).or_default().push(j as u32);
        }
    }
    CoarseIndex { map }
}

/// 粗筛扫描器：counts 缓冲跨行复用，每行只清 touched 过的格子。
struct CoarseScanner {
    counts: Vec<u32>,
    touched: Vec<u32>,
}

impl CoarseScanner {
    fn new(b_rows: usize) -> Self {
        Self {
            counts: vec![0; b_rows],
            touched: vec![],
        }
    }

    /// A 行的候选：按「命中的不同 bigram 数」降序取 top [`CANDIDATE_LIMIT`]，
    /// 并应用三倍长度过滤。返回 (命中数, B 行下标)。
    fn scan(&mut self, a: &SideRow, index: &CoarseIndex, b_rows: &[SideRow]) -> Vec<(u32, u32)> {
        for &j in &self.touched {
            self.counts[j as usize] = 0;
        }
        self.touched.clear();
        for g in bigram_set(&a.chars) {
            let mut key = String::with_capacity(8);
            key.push(g[0]);
            key.push(g[1]);
            if let Some(rows) = index.map.get(key.as_str()) {
                for &j in rows {
                    let slot = &mut self.counts[j as usize];
                    if *slot == 0 {
                        self.touched.push(j);
                    }
                    *slot += 1;
                }
            }
        }
        let la = a.chars.len();
        let mut cands: Vec<(u32, u32)> = self
            .touched
            .iter()
            .map(|&j| (self.counts[j as usize], j))
            .filter(|&(_, j)| {
                let b = &b_rows[j as usize];
                let lb = b.chars.len();
                (la <= lb * LENGTH_RATIO_MAX && lb <= la * LENGTH_RATIO_MAX)
                    || shorter_embedded(a, b)
            })
            .collect();
        cands.sort_unstable_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(&y.1)));
        cands.truncate(CANDIDATE_LIMIT);
        cands
    }
}

// ============================================================
// 主流程：fuzzy.match
// ============================================================

struct MatchOptions {
    match_type: String,
    auto_threshold: f64,
    suspect_threshold: f64,
    top_k: usize,
}

fn match_options(params: &Value) -> Result<MatchOptions, AppError> {
    let match_type = params
        .get("matchType")
        .and_then(Value::as_str)
        .unwrap_or("generic")
        .to_string();
    if !matches!(
        match_type.as_str(),
        "company" | "person" | "address" | "generic"
    ) {
        return Err(error(
            "INVALID_PARAMS",
            "匹配类型只支持 company/person/address/generic。",
            Some(match_type),
        ));
    }
    let auto = params
        .get("autoThreshold")
        .and_then(Value::as_f64)
        .unwrap_or(90.0);
    let suspect = params
        .get("suspectThreshold")
        .and_then(Value::as_f64)
        .unwrap_or(70.0);
    if !(0.0..=100.0).contains(&auto) || !(0.0..=100.0).contains(&suspect) {
        return Err(error("INVALID_PARAMS", "阈值必须在 0 到 100 之间。", None));
    }
    if suspect >= auto {
        return Err(error("INVALID_PARAMS", "疑似阈值必须低于自动阈值。", None));
    }
    let top_k = params
        .get("topK")
        .and_then(Value::as_u64)
        .unwrap_or(3)
        .clamp(1, 10) as usize;
    Ok(MatchOptions {
        match_type,
        auto_threshold: auto,
        suspect_threshold: suspect,
        top_k,
    })
}

fn match_flow(
    params: &Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: &AtomicBool,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    let started = Instant::now();
    let opts = match_options(params)?;
    progress("load", 1, 4, "正在读取 A 侧数据…");
    let a_values = load_column(params, "sourceA")?;
    checkpoint(cancel, pause)?;
    progress("load", 2, 4, "正在读取 B 侧数据…");
    let b_values = load_column(params, "sourceB")?;
    checkpoint(cancel, pause)?;

    let a_rows: Vec<SideRow> = a_values.iter().map(|v| prepare_row(v, &opts)).collect();
    let b_rows: Vec<SideRow> = b_values.iter().map(|v| prepare_row(v, &opts)).collect();
    drop(a_values);
    drop(b_values);

    progress("match", 0, a_rows.len(), "正在建立索引并比对…");
    let index = build_index(&b_rows);
    let mut scanner = CoarseScanner::new(b_rows.len());
    let mut rows_out: Vec<Value> = Vec::with_capacity(a_rows.len());
    let (mut auto_count, mut suspect_count, mut unmatched_count, mut invalid_count) =
        (0usize, 0usize, 0usize, 0usize);
    // estimatedComparisons＝真正进入精算打分的对数（粗筛削减后的量）。
    let mut estimated_comparisons: u64 = 0;

    for (i, a) in a_rows.iter().enumerate() {
        if i % CANCEL_BATCH == 0 && i > 0 {
            if cancel.load(Ordering::Relaxed) {
                return Err(error("JOB_CANCELLED", "任务已取消。", None));
            }
            progress(
                "match",
                i,
                a_rows.len(),
                &format!("正在比对 A 列第 {}/{} 行…", i, a_rows.len()),
            );
        }
        if a.invalid {
            invalid_count += 1;
            rows_out.push(json!({
                "aIndex": i + 1,
                "aValue": a.value,
                "level": "invalid",
                "reasons": ["无效值（空值、纯数字或单字符）"],
                "matches": [],
            }));
            continue;
        }
        let cands = scanner.scan(a, &index, &b_rows);
        let mut scored: Vec<(u32, ScoreBreakdown)> = vec![];
        for (_, j) in cands {
            estimated_comparisons += 1;
            let b = &b_rows[j as usize];
            let sc = score_pair(
                &a.norm,
                &a.chars,
                a.segments.as_ref(),
                &b.norm,
                &b.chars,
                b.segments.as_ref(),
                &opts,
            );
            if sc.total >= opts.suspect_threshold {
                scored.push((j, sc));
            }
        }
        scored.sort_by(|x, y| {
            y.1.total
                .partial_cmp(&x.1.total)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(x.0.cmp(&y.0))
        });
        scored.truncate(opts.top_k);
        let level = scored
            .first()
            .map(|(_, sc)| {
                if sc.total >= opts.auto_threshold {
                    "auto"
                } else {
                    "suspect"
                }
            })
            .unwrap_or("unmatched");
        match level {
            "auto" => auto_count += 1,
            "suspect" => suspect_count += 1,
            _ => unmatched_count += 1,
        }
        let matches: Vec<Value> = scored
            .iter()
            .map(|(j, sc)| {
                let b = &b_rows[*j as usize];
                json!({
                    "bIndex": *j as usize + 1,
                    "bValue": b.value,
                    "level": if sc.total >= opts.auto_threshold { "auto" } else { "suspect" },
                    "total": sc.total,
                    "breakdown": sc.to_json(),
                    "reasons": sc.reasons,
                    "confirmed": Value::Null,
                })
            })
            .collect();
        rows_out.push(json!({
            "aIndex": i + 1,
            "aValue": a.value,
            "level": level,
            "reasons": [],
            "matches": matches,
        }));
    }
    checkpoint(cancel, pause)?;
    Ok(json!({
        "summary": {
            "rowsA": a_rows.len(),
            "rowsB": b_rows.len(),
            "autoCount": auto_count,
            "suspectCount": suspect_count,
            "unmatchedCount": unmatched_count,
            "invalidCount": invalid_count,
            "estimatedComparisons": estimated_comparisons,
            "elapsedMs": started.elapsed().as_millis() as u64,
        },
        "rows": rows_out,
    }))
}

// ============================================================
// fuzzy.inspect
// ============================================================

fn inspect(params: &Value) -> Result<Value, AppError> {
    let spec_value = params
        .get("source")
        .or_else(|| params.get("sourceA"))
        .cloned()
        .ok_or_else(|| error("MISSING_SOURCE", "缺少文件参数。", None))?;
    let spec: SourceSpec = serde_json::from_value(spec_value)
        .map_err(|e| error("INVALID_PARAMS", "文件参数不完整。", Some(e.to_string())))?;
    let table = load_table(&spec)?;
    let suggested = suggested_column(&table.headers)
        .map(|h| json!({"column": h}))
        .unwrap_or(Value::Null);
    Ok(json!({
        "sheets": table.sheets,
        "sheet": table.sheet,
        "headerRow": table.header_row,
        "headerDepth": 1,
        "headers": table.headers,
        "preview": table.rows.iter().take(8).collect::<Vec<_>>(),
        "rowCount": table.rows.len(),
        "suggestedMapping": suggested,
    }))
}

/// 建议匹配列：首个含名称类关键词的表头（公司/单位/客户/户名/姓名等）。
fn suggested_column(headers: &[String]) -> Option<String> {
    const KEYWORDS: &[&str] = &[
        "公司",
        "单位",
        "客户",
        "供应商",
        "名称",
        "户名",
        "姓名",
        "对手",
        "交易方",
        "vendor",
        "customer",
        "name",
        "counterparty",
    ];
    headers
        .iter()
        .find(|h| {
            let n = h.trim().to_lowercase();
            !n.is_empty() && KEYWORDS.iter().any(|k| n.contains(k))
        })
        .cloned()
}

// ============================================================
// fuzzy.export：三张 Sheet（constant memory 模式）
// ============================================================

fn export_flow(params: &Value) -> Result<Value, AppError> {
    let path = params
        .get("path")
        .or_else(|| params.get("outputPath"))
        .and_then(Value::as_str)
        .filter(|x| !x.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "两列模糊匹配结果_{}.xlsx",
                Local::now().format("%Y%m%d_%H%M%S")
            ))
        });
    // rows 直传（进程内调用与单测）优先；正常前端链路只传 jobId，靠接线层
    // 注入的 __dbPath 从本机结果库读回，并叠加人工确认状态。
    let rows_owned: Vec<Value>;
    let rows: &[Value] = match params.get("rows").and_then(Value::as_array) {
        Some(rows) => rows,
        None => {
            let job_id = required_job_id(params)?;
            let db = injected(params, "__dbPath").ok_or_else(|| {
                error(
                    "INVALID_PARAMS",
                    "缺少本机结果库路径，无法读取匹配结果。",
                    None,
                )
            })?;
            let conn = open_db(Path::new(db))?;
            let mut loaded = load_result_rows(&conn, &job_id)?;
            if loaded.is_empty() {
                return Err(error(
                    "RESULTS_NOT_FOUND",
                    "该任务在本机没有保存匹配结果，请先完成匹配再导出。",
                    Some(job_id),
                ));
            }
            let confirmations = load_confirmations(&conn, &job_id)?;
            apply_confirmations(&mut loaded, &confirmations);
            rows_owned = loaded;
            &rows_owned
        }
    };
    let out = export_workbook(rows, &path)?;
    // outputPaths 数组是 worker 事件协议的落点：monitor 靠它把产物加入
    // AllowedPaths，前端据此才能打开产物所在目录。
    Ok(json!({
        "outputPath": out.to_string_lossy(),
        "outputPaths": [out.to_string_lossy()],
    }))
}

fn level_cn(level: &str) -> &'static str {
    match level {
        "auto" => "自动匹配",
        "suspect" => "疑似匹配",
        "invalid" => "无效值",
        _ => "未匹配",
    }
}

fn confirmed_cn(v: &Value) -> &'static str {
    match v.as_bool() {
        Some(true) => "已确认",
        Some(false) => "已否决",
        None => "未确认",
    }
}

fn export_workbook(rows: &[Value], path: &Path) -> Result<PathBuf, AppError> {
    let mut wb = Workbook::new();
    let header = Format::new()
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_border(FormatBorder::Thin)
        .set_background_color("#D9EAD3");
    // Sheet1 全部结果：每个候选一行；无候选的行也占一行（匹配对象留空）。
    {
        let ws = wb.add_worksheet_with_constant_memory();
        ws.set_name("全部结果").map_err(xlsx)?;
        let headers = [
            "序号",
            "A行号",
            "A列原始值",
            "B行号",
            "B列匹配值",
            "匹配级别",
            "总分",
            "字符相似",
            "最长公共子序列",
            "词组重叠",
            "判定原因",
            "确认标记",
        ];
        for (c, h) in headers.iter().enumerate() {
            ws.write_string_with_format(0, c as u16, *h, &header)
                .map_err(xlsx)?;
        }
        // 常量内存模式不支持 autofit，手动设列宽。
        let widths = [6, 8, 30, 8, 30, 10, 8, 10, 16, 10, 28, 10];
        for (c, w) in widths.iter().enumerate() {
            ws.set_column_width(c as u16, *w).map_err(xlsx)?;
        }
        let mut y = 1u32;
        let mut seq = 0u64;
        for row in rows {
            let a_index = row.get("aIndex").and_then(Value::as_u64).unwrap_or(0);
            let a_value = row.get("aValue").and_then(Value::as_str).unwrap_or("");
            let level = row.get("level").and_then(Value::as_str).unwrap_or("");
            let matches = row
                .get("matches")
                .and_then(Value::as_array)
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            if matches.is_empty() {
                seq += 1;
                let reasons = row
                    .get("reasons")
                    .and_then(Value::as_array)
                    .map(|r| {
                        r.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("；")
                    })
                    .unwrap_or_default();
                write_match_row(
                    ws, y, seq, a_index, a_value, 0, "", level, None, &reasons, "",
                )?;
                y += 1;
                continue;
            }
            for m in matches {
                seq += 1;
                write_match_row(
                    ws,
                    y,
                    seq,
                    a_index,
                    a_value,
                    m.get("bIndex").and_then(Value::as_u64).unwrap_or(0),
                    m.get("bValue").and_then(Value::as_str).unwrap_or(""),
                    m.get("level").and_then(Value::as_str).unwrap_or(""),
                    m.get("breakdown"),
                    &m.get("reasons")
                        .and_then(Value::as_array)
                        .map(|r| {
                            r.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("；")
                        })
                        .unwrap_or_default(),
                    m.get("confirmed").map(confirmed_cn).unwrap_or("未确认"),
                )?;
                y += 1;
            }
        }
    }
    // Sheet2 疑似确认记录：只列 suspect 行的全部 topK 候选（列布局与 Sheet1
    // 一致，便于并排核对；confirmed 列即确认操作落点）。
    {
        let ws = wb.add_worksheet_with_constant_memory();
        ws.set_name("疑似确认记录").map_err(xlsx)?;
        let headers = [
            "序号",
            "A行号",
            "A列原始值",
            "B行号",
            "B列匹配值",
            "匹配级别",
            "总分",
            "字符相似",
            "最长公共子序列",
            "词组重叠",
            "判定原因",
            "确认标记",
        ];
        for (c, h) in headers.iter().enumerate() {
            ws.write_string_with_format(0, c as u16, *h, &header)
                .map_err(xlsx)?;
        }
        let widths = [6, 8, 30, 8, 30, 10, 8, 10, 16, 10, 28, 10];
        for (c, w) in widths.iter().enumerate() {
            ws.set_column_width(c as u16, *w).map_err(xlsx)?;
        }
        let mut y = 1u32;
        let mut seq = 0u64;
        for row in rows {
            if row.get("level").and_then(Value::as_str) != Some("suspect") {
                continue;
            }
            let a_index = row.get("aIndex").and_then(Value::as_u64).unwrap_or(0);
            let a_value = row.get("aValue").and_then(Value::as_str).unwrap_or("");
            let matches = row
                .get("matches")
                .and_then(Value::as_array)
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            for m in matches {
                seq += 1;
                write_match_row(
                    ws,
                    y,
                    seq,
                    a_index,
                    a_value,
                    m.get("bIndex").and_then(Value::as_u64).unwrap_or(0),
                    m.get("bValue").and_then(Value::as_str).unwrap_or(""),
                    "suspect",
                    m.get("breakdown"),
                    &m.get("reasons")
                        .and_then(Value::as_array)
                        .map(|r| {
                            r.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("；")
                        })
                        .unwrap_or_default(),
                    m.get("confirmed").map(confirmed_cn).unwrap_or("未确认"),
                )?;
                y += 1;
            }
        }
    }
    // Sheet3 未匹配清单：unmatched + invalid 行。
    {
        let ws = wb.add_worksheet_with_constant_memory();
        ws.set_name("未匹配清单").map_err(xlsx)?;
        let headers = ["序号", "A行号", "A列原始值", "级别", "原因"];
        for (c, h) in headers.iter().enumerate() {
            ws.write_string_with_format(0, c as u16, *h, &header)
                .map_err(xlsx)?;
        }
        let widths = [6, 8, 40, 10, 32];
        for (c, w) in widths.iter().enumerate() {
            ws.set_column_width(c as u16, *w).map_err(xlsx)?;
        }
        let mut y = 1u32;
        let mut seq = 0u64;
        for row in rows {
            let level = row.get("level").and_then(Value::as_str).unwrap_or("");
            if matches!(level, "auto" | "suspect") {
                continue;
            }
            seq += 1;
            let reasons = row
                .get("reasons")
                .and_then(Value::as_array)
                .map(|r| {
                    r.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("；")
                })
                .unwrap_or_default();
            ws.write_number(y, 0, seq as f64).map_err(xlsx)?;
            ws.write_number(
                y,
                1,
                row.get("aIndex").and_then(Value::as_u64).unwrap_or(0) as f64,
            )
            .map_err(xlsx)?;
            ws.write_string(
                y,
                2,
                row.get("aValue").and_then(Value::as_str).unwrap_or(""),
            )
            .map_err(xlsx)?;
            ws.write_string(y, 3, level_cn(level)).map_err(xlsx)?;
            ws.write_string(y, 4, &reasons).map_err(xlsx)?;
            y += 1;
        }
    }
    wb.save(path).map_err(xlsx)?;
    Ok(path.to_path_buf())
}

#[allow(clippy::too_many_arguments)]
fn write_match_row(
    ws: &mut rust_xlsxwriter::Worksheet,
    y: u32,
    seq: u64,
    a_index: u64,
    a_value: &str,
    b_index: u64,
    b_value: &str,
    level: &str,
    breakdown: Option<&Value>,
    reasons: &str,
    confirmed: &str,
) -> Result<(), AppError> {
    let bd = breakdown.cloned().unwrap_or(Value::Null);
    let num = |v: &Value| v.as_f64().unwrap_or(0.0);
    ws.write_number(y, 0, seq as f64).map_err(xlsx)?;
    ws.write_number(y, 1, a_index as f64).map_err(xlsx)?;
    ws.write_string(y, 2, a_value).map_err(xlsx)?;
    ws.write_number(y, 3, b_index as f64).map_err(xlsx)?;
    ws.write_string(y, 4, b_value).map_err(xlsx)?;
    if !level.is_empty() {
        ws.write_string(y, 5, level_cn(level)).map_err(xlsx)?;
    } else {
        ws.write_string(y, 5, "疑似匹配").map_err(xlsx)?;
    }
    ws.write_number(y, 6, num(&bd["total"])).map_err(xlsx)?;
    ws.write_number(y, 7, num(&bd["charSim"])).map_err(xlsx)?;
    ws.write_number(y, 8, num(&bd["lcsSim"])).map_err(xlsx)?;
    ws.write_number(y, 9, num(&bd["tokenOverlap"]))
        .map_err(xlsx)?;
    ws.write_string(y, 10, reasons).map_err(xlsx)?;
    if !confirmed.is_empty() {
        ws.write_string(y, 11, confirmed).map_err(xlsx)?;
    }
    Ok(())
}

// ============================================================
// 接线层：结果落库、取回与确认（engine_call 与 worker 共用）
// ============================================================

/// engine_call 入口的 Storage 方法：`fuzzy.get_results`（跨会话恢复）与
/// `fuzzy.save_confirm`（确认落库）。其余方法一律 METHOD_NOT_FOUND
/// （`fuzzy.inspect` 无状态，走 [`call`]）。
pub(crate) fn call_with_storage(
    storage: &Storage,
    method: &str,
    params: Value,
) -> Result<Value, AppError> {
    if !matches!(method, "fuzzy.get_results" | "fuzzy.save_confirm") {
        return Err(error(
            "METHOD_NOT_FOUND",
            "未找到两列匹配存储方法。",
            Some(method.into()),
        ));
    }
    // 不占 Storage 的全局连接锁：恢复场景要一次读回数万行，期间父进程还要
    // 继续 UPSERT task_history；WAL 模式下按库文件自开连接即可并发读写。
    storage_call(&storage.db_path(), method, params)
}

/// 按库文件路径分发存储方法。集成测试入口（engine_call_for_test）也走这里，
/// 测试用 params.__dbPath 指向全新临时库；该入口不经前端，__dbPath 不会
/// 成为外部可控参数。
pub(crate) fn storage_call(db_path: &Path, method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "fuzzy.get_results" => get_results(db_path, &params),
        "fuzzy.save_confirm" => save_confirm(db_path, &params),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到两列匹配存储方法。",
            Some(method.into()),
        )),
    }
}

/// 集成测试直连入口：同进程内跑任务方法，不启动 worker 子进程（tests/ 下
/// 没有 worker 级先例，进程内直连即可覆盖 落库→取回→确认→导出 全链路）。
#[doc(hidden)]
pub fn run_job_for_test(method: &str, params: Value) -> Result<Value, AppError> {
    let cancel = Arc::new(AtomicBool::new(false));
    let pause = PauseCheckpoint::unpaused(cancel.clone());
    run_job(method, params, &|_, _, _, _| {}, cancel, &pause)
}

/// 接线层注入参数（__dbPath / __jobId）取值：空白视为未注入。
fn injected<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
}

/// fuzzy.match 成功后按注入的 `__dbPath`/`__jobId` 落库（两者齐备才写；
/// 单测直调不注入则跳过）。保存失败让任务失败：导出与跨会话恢复都依赖
/// 这份行级结果，静默跳过只会让后续步骤报更难懂的错。
fn persist_if_wired(params: &Value, result: &Value) -> Result<(), AppError> {
    let (Some(db), Some(job)) = (injected(params, "__dbPath"), injected(params, "__jobId")) else {
        return Ok(());
    };
    persist_results(Path::new(db), job, result)
}

/// 打开与 Storage 同库文件的独立连接。两张 fuzzy 表的 DDL 与 storage.rs
/// 建库保持一致，这里 IF NOT EXISTS 兜底（集成测试用全新临时库时靠它建表；
/// 生产库在应用启动时已由 Storage 建好）。busy_timeout 与 storage.rs 同源：
/// worker 落库与父进程 UPSERT task_history 并发写时等待而不是立刻报错。
fn open_db(db_path: &Path) -> Result<Connection, AppError> {
    let open_error = |e: rusqlite::Error| {
        error(
            "STORAGE_ERROR",
            "本机数据存储操作失败。",
            Some(e.to_string()),
        )
    };
    let conn = Connection::open(db_path).map_err(open_error)?;
    conn.execute_batch(
        "PRAGMA busy_timeout=5000;
         CREATE TABLE IF NOT EXISTS fuzzy_match_results(job_id TEXT NOT NULL,a_index INTEGER NOT NULL,a_value TEXT NOT NULL,level TEXT NOT NULL,match_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(job_id,a_index));
         CREATE TABLE IF NOT EXISTS fuzzy_match_confirmations(job_id TEXT NOT NULL,a_index INTEGER NOT NULL,b_index INTEGER,action TEXT NOT NULL,note TEXT,confirmed_at TEXT NOT NULL,PRIMARY KEY(job_id,a_index));",
    )
    .map_err(open_error)?;
    Ok(conn)
}

fn required_job_id(params: &Value) -> Result<String, AppError> {
    params
        .get("jobId")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error("INVALID_PARAMS", "缺少任务编号（jobId）。", None))
}

/// fuzzy.match 结果整包落库：行级结果全量写 fuzzy_match_results（match_json
/// 存该行 matches 数组序列化），同 jobId 重跑时先清旧行与旧确认。
fn persist_results(db_path: &Path, job_id: &str, result: &Value) -> Result<(), AppError> {
    let write_error = |e: rusqlite::Error| {
        error(
            "STORAGE_ERROR",
            "匹配结果保存到本机失败。",
            Some(e.to_string()),
        )
    };
    let rows = result
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                "STORAGE_ERROR",
                "匹配结果缺少行数据，无法保存到本机。",
                None,
            )
        })?;
    let mut conn = open_db(db_path)?;
    let tx = conn.transaction().map_err(write_error)?;
    let now = Utc::now().to_rfc3339();
    tx.execute(
        "DELETE FROM fuzzy_match_results WHERE job_id=?1",
        params![job_id],
    )
    .map_err(write_error)?;
    tx.execute(
        "DELETE FROM fuzzy_match_confirmations WHERE job_id=?1",
        params![job_id],
    )
    .map_err(write_error)?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO fuzzy_match_results(job_id,a_index,a_value,level,match_json,created_at)
                 VALUES(?1,?2,?3,?4,?5,?6)",
            )
            .map_err(write_error)?;
        for row in rows {
            stmt.execute(params![
                job_id,
                row.get("aIndex").and_then(Value::as_i64).unwrap_or(0),
                row.get("aValue").and_then(Value::as_str).unwrap_or(""),
                row.get("level").and_then(Value::as_str).unwrap_or(""),
                row.get("matches")
                    .cloned()
                    .unwrap_or_else(|| json!([]))
                    .to_string(),
                now,
            ])
            .map_err(write_error)?;
        }
    }
    tx.commit().map_err(write_error)?;
    Ok(())
}

/// `fuzzy.get_results {jobId}` → `{summary, rows, confirmations}`：
/// 行级结果与确认全部从库读回，summary 优先取 task_history 完成事件里
/// monitor 存的完整口径（含 rowsB/elapsedMs），取不到再按行级统计重建
/// （rowsB/elapsedMs 无法从行级还原，以 0 兜底——前端类型要求 number）。
fn get_results(db_path: &Path, params: &Value) -> Result<Value, AppError> {
    let job_id = required_job_id(params)?;
    let conn = open_db(db_path)?;
    let rows = load_result_rows(&conn, &job_id)?;
    if rows.is_empty() {
        return Err(error(
            "RESULTS_NOT_FOUND",
            "该任务在本机没有保存匹配结果，请重新运行匹配。",
            Some(job_id),
        ));
    }
    let confirmations = load_confirmations(&conn, &job_id)?;
    let summary = summary_from_history(&conn, &job_id).unwrap_or_else(|| rebuild_summary(&rows));
    Ok(json!({"summary": summary, "rows": rows, "confirmations": confirmations}))
}

/// 逐行读回 fuzzy_match_results：match_json 反序列化回 matches；行级
/// reasons 库里没存，invalid 行的文案是固定的，读回时按 level 重建。
fn load_result_rows(conn: &Connection, job_id: &str) -> Result<Vec<Value>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT a_index,a_value,level,match_json FROM fuzzy_match_results
             WHERE job_id=?1 ORDER BY a_index",
        )
        .map_err(|e| {
            error(
                "STORAGE_ERROR",
                "本机数据存储操作失败。",
                Some(e.to_string()),
            )
        })?;
    let queried = stmt
        .query_map([job_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| {
            error(
                "STORAGE_ERROR",
                "本机数据存储操作失败。",
                Some(e.to_string()),
            )
        })?;
    let mut out = Vec::new();
    for row in queried {
        let (a_index, a_value, level, match_json) = row.map_err(|e| {
            error(
                "STORAGE_ERROR",
                "本机数据存储操作失败。",
                Some(e.to_string()),
            )
        })?;
        let matches: Value = serde_json::from_str(&match_json).unwrap_or_else(|_| json!([]));
        let reasons = if level == "invalid" {
            json!(["无效值（空值、纯数字或单字符）"])
        } else {
            json!([])
        };
        out.push(json!({
            "aIndex": a_index,
            "aValue": a_value,
            "level": level,
            "reasons": reasons,
            "matches": matches,
        }));
    }
    Ok(out)
}

/// 确认记录全量读回（bIndex null 表示「确认该行确无匹配」的整行否决）。
fn load_confirmations(conn: &Connection, job_id: &str) -> Result<Vec<Value>, AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT a_index,b_index,action,note FROM fuzzy_match_confirmations
             WHERE job_id=?1 ORDER BY a_index",
        )
        .map_err(|e| {
            error(
                "STORAGE_ERROR",
                "本机数据存储操作失败。",
                Some(e.to_string()),
            )
        })?;
    let queried = stmt
        .query_map([job_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| {
            error(
                "STORAGE_ERROR",
                "本机数据存储操作失败。",
                Some(e.to_string()),
            )
        })?;
    let mut out = Vec::new();
    for row in queried {
        let (a_index, b_index, action, note) = row.map_err(|e| {
            error(
                "STORAGE_ERROR",
                "本机数据存储操作失败。",
                Some(e.to_string()),
            )
        })?;
        out.push(json!({
            "aIndex": a_index,
            "bIndex": b_index.map(Value::from).unwrap_or(Value::Null),
            "action": action,
            "note": note.map(Value::from).unwrap_or(Value::Null),
        }));
    }
    Ok(out)
}

/// `fuzzy.save_confirm {jobId, confirmations:[{aIndex,bIndex|null,action,note?}]}`
/// → `{saved:true}`。同 aIndex 覆盖（UPSERT），对齐前端 mergeConfirmations
/// 的「后写覆盖」语义。
fn save_confirm(db_path: &Path, params: &Value) -> Result<Value, AppError> {
    let job_id = required_job_id(params)?;
    let items = params
        .get("confirmations")
        .and_then(Value::as_array)
        .ok_or_else(|| error("INVALID_PARAMS", "缺少确认列表（confirmations）。", None))?;
    if items.is_empty() {
        return Err(error("INVALID_PARAMS", "确认列表不能为空。", None));
    }
    let mut conn = open_db(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|e| error("STORAGE_ERROR", "确认保存失败。", Some(e.to_string())))?;
    let now = Utc::now().to_rfc3339();
    for item in items {
        let a_index = item
            .get("aIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| error("INVALID_PARAMS", "确认项缺少 aIndex。", None))?;
        let action = item.get("action").and_then(Value::as_str).unwrap_or("");
        if !matches!(action, "accept" | "reject") {
            return Err(error(
                "INVALID_PARAMS",
                "确认动作只支持 accept 或 reject。",
                Some(action.into()),
            ));
        }
        let b_index = item.get("bIndex").and_then(Value::as_u64).map(|v| v as i64);
        let note = item
            .get("note")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty());
        tx.execute(
            "INSERT INTO fuzzy_match_confirmations(job_id,a_index,b_index,action,note,confirmed_at)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(job_id,a_index) DO UPDATE SET
               b_index=excluded.b_index, action=excluded.action,
               note=excluded.note, confirmed_at=excluded.confirmed_at",
            params![job_id, a_index as i64, b_index, action, note, now],
        )
        .map_err(|e| error("STORAGE_ERROR", "确认保存失败。", Some(e.to_string())))?;
    }
    tx.commit()
        .map_err(|e| error("STORAGE_ERROR", "确认保存失败。", Some(e.to_string())))?;
    Ok(json!({"saved": true}))
}

/// 从 task_history 的完成事件取回完整 summary：monitor 把 run_job 返回值
/// 原样存进事件的 result 字段（record_job_event 的 summary_json）。
/// 任何环节形状对不上（含全新临时库没建 task_history）都返回 None 走重建。
fn summary_from_history(conn: &Connection, job_id: &str) -> Option<Value> {
    let text: String = conn
        .query_row(
            "SELECT summary_json FROM task_history WHERE job_id=?1",
            [job_id],
            |r| r.get(0),
        )
        .ok()?;
    let event: Value = serde_json::from_str(&text).ok()?;
    let summary = event.get("result")?.get("summary")?.clone();
    (summary.get("rowsA").and_then(Value::as_u64).unwrap_or(0) > 0).then_some(summary)
}

/// 行级统计重建 summary（rowsB/elapsedMs/estimatedComparisons 无法从行级
/// 还原，以 0 兜底；前端 FuzzySummary 类型要求这些字段是 number）。
fn rebuild_summary(rows: &[Value]) -> Value {
    let mut counts = HashMap::new();
    for row in rows {
        let level = row.get("level").and_then(Value::as_str).unwrap_or("");
        *counts.entry(level).or_insert(0u64) += 1;
    }
    let count = |level: &str| counts.get(level).copied().unwrap_or(0);
    json!({
        "rowsA": rows.len(),
        "rowsB": 0,
        "autoCount": count("auto"),
        "suspectCount": count("suspect"),
        "unmatchedCount": count("unmatched"),
        "invalidCount": count("invalid"),
        "estimatedComparisons": 0,
        "elapsedMs": 0,
    })
}

/// 把确认状态合并进导出行（写进每个候选的 confirmed 字段，Sheet1/Sheet2 的
/// 「确认标记」列读它）。口径对齐前端：
/// - accept 且 bIndex 指向某候选 → 该候选 true、同行其余候选 false（topK
///   里选了一个，其余视为落选）；
/// - reject（bIndex 为 null 的整行否决）→ 该行全部候选 false；
/// - 未确认 → null（导出显示「未确认」）。
fn apply_confirmations(rows: &mut [Value], confirmations: &[Value]) {
    for row in rows.iter_mut() {
        let a_index = row.get("aIndex").and_then(Value::as_u64);
        let Some(a_index) = a_index else { continue };
        let decision = confirmations
            .iter()
            .find(|c| c.get("aIndex").and_then(Value::as_u64) == Some(a_index));
        let Some(decision) = decision else { continue };
        let accept_target = match decision.get("action").and_then(Value::as_str) {
            Some("accept") => decision.get("bIndex").and_then(Value::as_u64),
            // reject：整行否决，没有可采纳候选。
            _ => None,
        };
        let reject_row = decision.get("action").and_then(Value::as_str) == Some("reject");
        if let Some(matches) = row.get_mut("matches").and_then(Value::as_array_mut) {
            for m in matches.iter_mut() {
                let b_index = m.get("bIndex").and_then(Value::as_u64);
                let confirmed = if reject_row {
                    Value::Bool(false)
                } else {
                    match accept_target {
                        Some(target) => Value::Bool(b_index == Some(target)),
                        // accept 却没带 bIndex：视为整行采纳缺失，保留未确认。
                        None => Value::Null,
                    }
                };
                if let Some(object) = m.as_object_mut() {
                    object.insert("confirmed".into(), confirmed);
                }
            }
        }
    }
}

// ============================================================
// 表加载（口径抄自 loan_interest 的台账读取：open_workbook_auto +
// 表头探测 + 文本表格兜底；不跨模块引用，便于各自演进）
// ============================================================

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceSpec {
    /// 兼容旧字段名 inputPath。
    #[serde(default, alias = "inputPath")]
    path: String,
    #[serde(default)]
    sheet: String,
    #[serde(default)]
    header_row: usize,
    #[serde(default = "one")]
    header_depth: usize,
    /// 匹配列：表头名或 1 起的列号；留空则取建议列。
    #[serde(default)]
    column: String,
}

fn one() -> usize {
    1
}

#[derive(Clone)]
struct Table {
    sheet: String,
    sheets: Vec<String>,
    header_row: usize,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

/// 读取 fuzzy.match 的某一侧：sourceA / sourceB → 选列 → 返回该列全部值。
fn load_column(params: &Value, key: &str) -> Result<Vec<String>, AppError> {
    let spec_value = params
        .get(key)
        .cloned()
        .ok_or_else(|| error("MISSING_SOURCE", format!("缺少 {} 数据源。", key), None))?;
    let spec: SourceSpec = serde_json::from_value(spec_value)
        .map_err(|e| error("INVALID_PARAMS", "数据源参数不完整。", Some(e.to_string())))?;
    let table = load_table(&spec)?;
    let idx = pick_column(&spec, &table)?;
    // 该列为空的行也保留（行序即 aIndex/bIndex 口径：跳过表头后的第 N 个
    // 数据行）——空值由 prepare_row 归入「无效值」，不能在这里悄悄丢行。
    Ok(table
        .rows
        .iter()
        .map(|r| r.get(idx).cloned().unwrap_or_default().trim().to_string())
        .collect())
}

/// 选列：先按表头名精确匹配，再按 1 起的列号，缺省取建议列。
fn pick_column(spec: &SourceSpec, table: &Table) -> Result<usize, AppError> {
    let col = spec.column.trim();
    if col.is_empty() {
        return suggested_column(&table.headers)
            .and_then(|h| table.headers.iter().position(|x| x == &h))
            .ok_or_else(|| error("NO_COLUMN", "未能自动识别匹配列，请手动选择。", None));
    }
    if let Some(i) = table.headers.iter().position(|h| h == col) {
        return Ok(i);
    }
    if let Ok(n) = col.parse::<usize>() {
        if (1..=table.headers.len()).contains(&n) {
            return Ok(n - 1);
        }
    }
    Err(error("NO_COLUMN", format!("未找到匹配列「{col}」。"), None))
}

fn load_table(spec: &SourceSpec) -> Result<Table, AppError> {
    let path = PathBuf::from(&spec.path);
    if !path.is_file() {
        return Err(error(
            "PATH_NOT_FOUND",
            "找不到输入文件。",
            Some(spec.path.clone()),
        ));
    }
    let (sheet, sheets, all) = if crate::spreadsheet_input::is_text(path.as_ref()) {
        ("CSV".into(), vec!["CSV".into()], read_text(&path)?)
    } else {
        let mut book = open_workbook_auto(&path).map_err(|e| {
            error(
                "WORKBOOK_READ_FAILED",
                "无法读取工作簿。",
                Some(e.to_string()),
            )
        })?;
        let sheets = book.sheet_names().to_vec();
        let selected = if !spec.sheet.is_empty() && sheets.contains(&spec.sheet) {
            spec.sheet.clone()
        } else {
            sheets
                .first()
                .cloned()
                .ok_or_else(|| error("SOURCE_EMPTY", "工作簿没有 Sheet。", None))?
        };
        let range = book.worksheet_range(&selected).map_err(|e| {
            error(
                "WORKBOOK_READ_FAILED",
                "无法读取 Sheet。",
                Some(e.to_string()),
            )
        })?;
        (
            selected,
            sheets,
            range
                .rows()
                .map(|r| r.iter().map(data_text).collect())
                .collect(),
        )
    };
    let header_row = if spec.header_row > 0 {
        spec.header_row
    } else {
        detect_header(&all)
    };
    if header_row == 0 || header_row > all.len() {
        return Err(error("HEADER_ROW_INVALID", "标题行超出数据范围。", None));
    }
    let width = all.iter().map(Vec::len).max().unwrap_or(0);
    let mut headers = (0..width)
        .map(|i| all[header_row - 1].get(i).cloned().unwrap_or_default())
        .collect::<Vec<_>>();
    for (i, h) in headers.iter_mut().enumerate() {
        if h.trim().is_empty() {
            *h = format!("未命名列{}", i + 1);
        }
    }
    let rows = all
        .into_iter()
        .skip(header_row + spec.header_depth.saturating_sub(1))
        .filter(|r| r.iter().any(|v| !v.trim().is_empty()))
        .map(|mut r| {
            r.resize(width, String::new());
            r
        })
        .collect();
    Ok(Table {
        sheet,
        sheets,
        header_row,
        headers,
        rows,
    })
}

fn read_text(path: &Path) -> Result<Vec<Vec<String>>, AppError> {
    crate::spreadsheet_input::read_rows(path)
}

/// 表头行特征：多数单元格是含名称类关键词的短文本（数据行的编号/金额/长
/// 机构名不满足）。
fn detect_header(rows: &[Vec<String>]) -> usize {
    let score = |r: &Vec<String>| r.iter().filter(|v| header_cell_hit(v)).count();
    rows.iter()
        .take(30)
        .enumerate()
        .max_by_key(|(i, r)| (score(r), std::cmp::Reverse(*i)))
        .map(|(i, _)| i + 1)
        .unwrap_or(1)
}

fn header_cell_hit(v: &str) -> bool {
    const KEYWORDS: &[&str] = &[
        "名称",
        "公司",
        "单位",
        "客户",
        "供应商",
        "编号",
        "序号",
        "户名",
        "姓名",
        "地址",
        "金额",
        "数量",
        "日期",
        "备注",
        "对手",
        "code",
        "name",
        "no",
        "id",
    ];
    let s = v.trim().to_lowercase();
    !s.is_empty() && s.chars().count() <= 12 && KEYWORDS.iter().any(|k| s.contains(k))
}

fn data_text(v: &Data) -> String {
    match v {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(n) => {
            if n.fract() == 0.0 {
                format!("{n:.0}")
            } else {
                n.to_string()
            }
        }
        Data::Int(n) => n.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{e:?}"),
    }
}

fn xlsx(e: rust_xlsxwriter::XlsxError) -> AppError {
    error(
        "EXPORT_FAILED",
        "无法生成 Excel 结果文件。",
        Some(e.to_string()),
    )
}

fn error(code: &str, message: impl Into<String>, detail: Option<String>) -> AppError {
    AppError::new(code, message, false, detail)
}

// ============================================================
// 测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(match_type: &str) -> MatchOptions {
        MatchOptions {
            match_type: match_type.into(),
            auto_threshold: 90.0,
            suspect_threshold: 70.0,
            top_k: 3,
        }
    }

    fn noop_progress() -> impl Fn(&str, usize, usize, &str) {
        |_: &str, _: usize, _: usize, _: &str| {}
    }

    fn no_cancel() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    /// 与 run_job("fuzzy.match") 等价的核心路径，用内存列代替读文件。
    fn match_columns(a: Vec<&str>, b: Vec<&str>, options: &MatchOptions) -> Value {
        let a_rows: Vec<SideRow> = a.iter().map(|v| prepare_row(v, options)).collect();
        let b_rows: Vec<SideRow> = b.iter().map(|v| prepare_row(v, options)).collect();
        let index = build_index(&b_rows);
        let mut scanner = CoarseScanner::new(b_rows.len());
        let (mut auto_count, mut suspect_count, mut unmatched_count, mut invalid_count) =
            (0usize, 0usize, 0usize, 0usize);
        let mut estimated: u64 = 0;
        let mut rows_out = vec![];
        for (i, row) in a_rows.iter().enumerate() {
            if row.invalid {
                invalid_count += 1;
                rows_out.push(json!({
                    "aIndex": i + 1, "aValue": row.value, "level": "invalid",
                    "reasons": ["无效值（空值、纯数字或单字符）"], "matches": [],
                }));
                continue;
            }
            let cands = scanner.scan(row, &index, &b_rows);
            estimated += cands.len() as u64;
            let mut scored: Vec<(u32, ScoreBreakdown)> = vec![];
            for (_, j) in cands {
                let b = &b_rows[j as usize];
                let sc = score_pair(
                    &row.norm,
                    &row.chars,
                    row.segments.as_ref(),
                    &b.norm,
                    &b.chars,
                    b.segments.as_ref(),
                    options,
                );
                if sc.total >= options.suspect_threshold {
                    scored.push((j, sc));
                }
            }
            scored.sort_by(|x, y| {
                y.1.total
                    .partial_cmp(&x.1.total)
                    .unwrap()
                    .then(x.0.cmp(&y.0))
            });
            scored.truncate(options.top_k);
            let level = scored
                .first()
                .map(|(_, sc)| {
                    if sc.total >= options.auto_threshold {
                        "auto"
                    } else {
                        "suspect"
                    }
                })
                .unwrap_or("unmatched");
            match level {
                "auto" => auto_count += 1,
                "suspect" => suspect_count += 1,
                _ => unmatched_count += 1,
            }
            let matches: Vec<Value> = scored
                .iter()
                .map(|(j, sc)| {
                    let b = &b_rows[*j as usize];
                    json!({
                        "bIndex": *j as usize + 1, "bValue": b.value,
                        "level": if sc.total >= options.auto_threshold { "auto" } else { "suspect" },
                        "total": sc.total, "breakdown": sc.to_json(),
                        "reasons": sc.reasons, "confirmed": Value::Null,
                    })
                })
                .collect();
            rows_out.push(json!({
                "aIndex": i + 1, "aValue": row.value, "level": level,
                "reasons": [], "matches": matches,
            }));
        }
        json!({
            "summary": {
                "rowsA": a_rows.len(), "rowsB": b_rows.len(),
                "autoCount": auto_count, "suspectCount": suspect_count,
                "unmatchedCount": unmatched_count, "invalidCount": invalid_count,
                "estimatedComparisons": estimated,
            },
            "rows": rows_out,
        })
    }

    fn first_level(result: &Value, i: usize) -> &str {
        result["rows"][i]["level"].as_str().unwrap()
    }

    // ---------- 归一化 ----------

    #[test]
    fn 全半角归一后完全一致() {
        assert_eq!(
            base_normalize("ＡＢＣ（上海）有限公司"),
            base_normalize("ABC(上海)有限公司")
        );
    }

    #[test]
    fn 顿号逗号空白与零宽统一() {
        assert_eq!(
            normalize("上海市、浦东新区", "generic"),
            normalize("上海市，浦东新区", "generic")
        );
        assert_eq!(normalize("张 三", "person"), normalize("张三", "person"));
        // 零宽空格（U+200B）与 BOM 视为空白丢弃。
        assert_eq!(
            normalize("张\u{200B}三", "person"),
            normalize("张三", "person")
        );
        assert_eq!(
            normalize("华\u{FEFF}为", "company"),
            normalize("华为", "company")
        );
    }

    #[test]
    fn 间隔号变体统一() {
        // · U+00B7、• U+2022、‧ U+2027、．全角句点、. 半角句点全部归一。
        assert_eq!(
            normalize("买买提·艾力", "person"),
            normalize("买买提•艾力", "person")
        );
        assert_eq!(
            normalize("买买提·艾力", "person"),
            normalize("买买提‧艾力", "person")
        );
        assert_eq!(
            normalize("买买提·艾力", "person"),
            normalize("买买提．艾力", "person")
        );
        assert_eq!(
            normalize("买买提·艾力", "person"),
            normalize("买买提.艾力", "person")
        );
    }

    #[test]
    fn 繁体转简体() {
        assert_eq!(traditional_to_simplified("聯想集團"), "联想集团");
        assert_eq!(traditional_to_simplified("萬科企業"), "万科企业");
        assert_eq!(
            normalize("華為技術有限公司", "company"),
            normalize("华为技术有限公司", "company")
        );
    }

    #[test]
    fn 人名称谓剥离() {
        assert_eq!(strip_person_titles("张三先生"), "张三");
        assert_eq!(strip_person_titles("李四总经理"), "李四");
        // 剥完不足 2 字（王先生→王）则保护性不剥。
        assert_eq!(strip_person_titles("王先生"), "王先生");
    }

    #[test]
    fn 无效值判定() {
        assert!(is_invalid_value(""));
        assert!(is_invalid_value("12345"));
        assert!(is_invalid_value("1,234·5"));
        assert!(is_invalid_value("华"));
        assert!(!is_invalid_value("华为"));
        assert!(!is_invalid_value("3m公司"));
    }

    // ---------- 公司解析 ----------

    #[test]
    fn 公司解析_地名字号行业后缀() {
        let seg = parse_company("上海华为技术有限公司").unwrap();
        assert_eq!(seg.region, "上海");
        assert_eq!(seg.brand, "华为");
        assert_eq!(seg.industry, "技术");
        assert!(seg.suffix.contains("有限公司"));
    }

    #[test]
    fn 公司解析_集团后缀堆叠剥离() {
        let seg = parse_company("华辰集团").unwrap();
        assert_eq!(seg.brand, "华辰");
        assert!(seg.suffix.contains("集团"));
        let seg2 = parse_company("星衡控股集团有限公司").unwrap();
        assert_eq!(seg2.brand, "星衡");
    }

    #[test]
    fn 公司解析_省市两级前缀() {
        let seg = parse_company("河北省石家庄市华辰商贸有限公司").unwrap();
        assert!(seg.region.contains("河北省"));
        assert!(seg.region.contains("石家庄"));
        assert_eq!(seg.brand, "华辰");
    }

    #[test]
    fn 行政区划冲突判定() {
        assert!(region_conflict("北京", "上海"));
        assert!(region_conflict("唐山市", "石家庄市"));
        // 同地不同写法不冲突。
        assert!(!region_conflict("上海", "上海市"));
        assert!(!region_conflict("石家庄市", "河北省石家庄市"));
        assert!(!region_conflict("", "北京"));
    }

    // ---------- 三算法 ----------

    #[test]
    fn levenshtein比率() {
        let a: Vec<char> = "abcd".chars().collect();
        let b: Vec<char> = "abed".chars().collect();
        assert!((levenshtein_ratio(&a, &b) - 0.75).abs() < 1e-9);
        assert!((levenshtein_ratio(&a, &a) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn lcs比率() {
        let a: Vec<char> = "ABCBDAB".chars().collect();
        let b: Vec<char> = "BDCABA".chars().collect();
        assert_eq!(lcs_length(&a, &b), 4);
        assert!((lcs_ratio(&a, &b) - 4.0 / 7.0).abs() < 1e-9);
    }

    #[test]
    fn bigram_dice系数() {
        let a: Vec<char> = "night".chars().collect();
        let b: Vec<char> = "nacht".chars().collect();
        assert!((bigram_dice(&a, &b) - 0.25).abs() < 1e-9);
        assert!((bigram_dice(&a, &a) - 1.0).abs() < 1e-9);
    }

    // ---------- 集成：规格用例 ----------

    #[test]
    fn 全半角差异匹配为自动() {
        let result = match_columns(
            vec!["ＡＢＣ（上海）有限公司"],
            vec!["ABC(上海)有限公司"],
            &opts("company"),
        );
        assert_eq!(first_level(&result, 0), "auto");
        let total = result["rows"][0]["matches"][0]["total"].as_f64().unwrap();
        assert!(total >= 99.5, "应完全一致，实际 {total}");
    }

    #[test]
    fn 简称包含提分且单字不误报() {
        let result = match_columns(
            vec!["华为技术有限公司"],
            vec!["华为", "华"],
            &opts("company"),
        );
        let row = &result["rows"][0];
        assert_eq!(row["level"].as_str().unwrap(), "auto");
        let m = &row["matches"][0];
        assert_eq!(m["bValue"].as_str().unwrap(), "华为");
        let total = m["total"].as_f64().unwrap();
        assert!(total >= 93.0, "字号包含应保底 93，实际 {total}");
        // 「华」单字号行是无效值（单字符），绝不能进入匹配候选。
        let values: Vec<&str> = row["matches"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["bValue"].as_str())
            .collect();
        assert!(!values.contains(&"华"), "单字字号不得误报：{values:?}");
        // 无效值行计数在 B 侧行内不参与（rowsB 仍统计原始行数）。
        assert_eq!(result["summary"]["rowsB"].as_u64().unwrap(), 2);
    }

    #[test]
    fn 后缀归一消除组织形式差异() {
        let result = match_columns(
            vec!["华辰有限责任公司", "华辰有限公司"],
            vec!["华辰有限公司"],
            &opts("company"),
        );
        assert_eq!(first_level(&result, 0), "auto");
        assert_eq!(first_level(&result, 1), "auto");
    }

    #[test]
    fn 错别字一字之差落在疑似档() {
        // generic 类型（无公司字号提分规则），编辑距离敏感：7 字差 1 字约 77 分。
        let result = match_columns(
            vec!["内蒙古能源集团"],
            vec!["内蒙占能源集团"],
            &opts("generic"),
        );
        let row = &result["rows"][0];
        assert_eq!(row["level"].as_str().unwrap(), "suspect");
        let total = row["matches"][0]["total"].as_f64().unwrap();
        assert!(
            (70.0..90.0).contains(&total),
            "一字之差应落在疑似档，实际 {total}"
        );
    }

    #[test]
    fn 同字号不同城市强制疑似() {
        let result = match_columns(vec!["北京华辰科技"], vec!["上海华辰科技"], &opts("company"));
        let row = &result["rows"][0];
        assert_eq!(row["level"].as_str().unwrap(), "suspect");
        let m = &row["matches"][0];
        let total = m["total"].as_f64().unwrap();
        assert!(total < 90.0, "区域冲突应压到自动阈值之下，实际 {total}");
        let reasons: Vec<&str> = m["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(
            reasons.iter().any(|r| r.contains("行政区域不一致")),
            "应记录区域冲突原因：{reasons:?}"
        );
    }

    #[test]
    fn 人名空格与间隔号变体匹配() {
        let result = match_columns(
            vec!["张 三", "买买提·艾力", "李四先生"],
            vec!["张三", "买买提•艾力", "李四"],
            &opts("person"),
        );
        for i in 0..3 {
            assert_eq!(
                first_level(&result, i),
                "auto",
                "第 {} 行应为自动匹配",
                i + 1
            );
        }
    }

    #[test]
    fn 无效值跳过比对() {
        let result = match_columns(vec!["", "12345", "华为"], vec!["华为"], &opts("company"));
        assert_eq!(first_level(&result, 0), "invalid");
        assert_eq!(first_level(&result, 1), "invalid");
        assert_eq!(first_level(&result, 2), "auto");
        assert_eq!(result["summary"]["invalidCount"].as_u64().unwrap(), 2);
        assert_eq!(result["summary"]["autoCount"].as_u64().unwrap(), 1);
    }

    #[test]
    fn 阈值参数化生效() {
        // 93 分对（字号包含保底）：默认 90 下 auto，95 下 suspect。
        let mut strict = opts("company");
        strict.auto_threshold = 95.0;
        strict.suspect_threshold = 80.0;
        let default = match_columns(vec!["华为技术有限公司"], vec!["华为"], &opts("company"));
        let strict_result = match_columns(vec!["华为技术有限公司"], vec!["华为"], &strict);
        assert_eq!(first_level(&default, 0), "auto");
        assert_eq!(first_level(&strict_result, 0), "suspect");

        // 约 74 分对（generic 两字之差、9 字名）：默认疑似阈值 70 下 suspect，
        // 80 下未匹配。
        let mut high_suspect = opts("generic");
        high_suspect.auto_threshold = 95.0;
        high_suspect.suspect_threshold = 80.0;
        let loose = match_columns(
            vec!["审计工具箱开发小组"],
            vec!["审计工具箱测试小组"],
            &opts("generic"),
        );
        let tight = match_columns(
            vec!["审计工具箱开发小组"],
            vec!["审计工具箱测试小组"],
            &high_suspect,
        );
        let loose_total = loose["rows"][0]["matches"][0]["total"].as_f64().unwrap();
        assert!(
            (70.0..80.0).contains(&loose_total),
            "该用例应落在 70-80 区间用于跨阈值断言，实际 {loose_total}"
        );
        assert_eq!(first_level(&loose, 0), "suspect");
        assert_eq!(first_level(&tight, 0), "unmatched");
    }

    #[test]
    fn 疑似阈值不低于自动阈值时报错() {
        let params = json!({
            "sourceA": {"path": "a.xlsx"}, "sourceB": {"path": "b.xlsx"},
            "autoThreshold": 80, "suspectThreshold": 90,
        });
        assert!(match_options(&params).is_err());
    }

    #[test]
    fn topk保留多个候选() {
        let mut o = opts("company");
        o.top_k = 3;
        let result = match_columns(
            vec!["华辰科技有限公司"],
            vec!["华辰科技", "华辰科技发展", "上海华辰科技", "无关行名称"],
            &o,
        );
        let matches = result["rows"][0]["matches"].as_array().unwrap();
        assert!(
            matches.len() >= 2,
            "疑似确认应展示多个候选，实际 {matches:?}"
        );
        // 候选按总分降序。
        let totals: Vec<f64> = matches.iter().filter_map(|m| m["total"].as_f64()).collect();
        let mut sorted = totals.clone();
        sorted.sort_by(|x, y| y.partial_cmp(x).unwrap());
        assert_eq!(totals, sorted);
    }

    // ---------- 词表加载 ----------

    #[test]
    fn assets词表正常加载() {
        let suffixes = suffix_table();
        assert!(
            suffixes.strip.len() >= 100,
            "公司后缀词表应加载 assets 完整版"
        );
        assert!(suffixes.normalize.len() >= 40);
        assert!(suffixes.strip.iter().any(|w| w == "有限公司"));
        let regions = region_table();
        assert!(
            regions.len() >= 300,
            "行政区划应含省市两级全量，实际 {len}",
            len = regions.len()
        );
        assert!(regions.iter().any(|w| w == "上海"));
        assert!(regions.iter().any(|w| w == "石家庄"));
        let t = t2s();
        assert!(
            t.chars.len() >= 4000,
            "繁简单字表应加载 OpenCC 全量，实际 {len}",
            len = t.chars.len()
        );
        assert!(!t.phrases.is_empty());
        assert!(t.max_phrase_chars >= 2);
    }

    // ---------- run_job 包装 ----------

    #[test]
    fn run_job未知方法报错() {
        let err = run_job(
            "fuzzy.unknown",
            json!({}),
            &noop_progress(),
            no_cancel(),
            &PauseCheckpoint::unpaused(no_cancel()),
        )
        .unwrap_err();
        assert_eq!(err.code, "METHOD_NOT_FOUND");
        let err2 = call("fuzzy.history", json!({})).unwrap_err();
        assert_eq!(err2.code, "METHOD_NOT_FOUND");
    }

    #[test]
    fn run_job取消立即返回() {
        // 写临时 xlsx 供读取（路径错误也无妨：取消检查在读文件之前）。
        let params = json!({
            "sourceA": {"path": "不存在的文件.xlsx"},
            "sourceB": {"path": "不存在的文件.xlsx"},
        });
        let cancel = Arc::new(AtomicBool::new(true));
        let err = run_job(
            "fuzzy.match",
            params,
            &noop_progress(),
            cancel,
            &PauseCheckpoint::unpaused(no_cancel()),
        )
        .unwrap_err();
        assert_eq!(err.code, "JOB_CANCELLED");
    }

    #[test]
    fn run_job端到端匹配() {
        // 生成临时 xlsx：A/B 各一列。
        let dir = std::env::temp_dir().join("fuzzy_match_tests");
        fs::create_dir_all(&dir).unwrap();
        let a_path = dir.join("a侧.xlsx");
        let b_path = dir.join("b侧.xlsx");
        write_fixture(
            &a_path,
            &["公司名称"],
            &[&["华为技术有限公司"], &["北京华辰科技"]],
        );
        write_fixture(
            &b_path,
            &["公司名称"],
            &[&["华为"], &["上海华辰科技"], &["12345"]],
        );
        let params = json!({
            "sourceA": {"path": a_path.to_string_lossy(), "column": "公司名称"},
            "sourceB": {"path": b_path.to_string_lossy(), "column": "公司名称"},
            "matchType": "company",
        });
        let result = run_job(
            "fuzzy.match",
            params,
            &noop_progress(),
            no_cancel(),
            &PauseCheckpoint::unpaused(no_cancel()),
        )
        .unwrap();
        let rows = result["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["level"].as_str().unwrap(), "auto");
        assert_eq!(rows[1]["level"].as_str().unwrap(), "suspect");
        let summary = &result["summary"];
        assert_eq!(summary["rowsA"].as_u64().unwrap(), 2);
        assert_eq!(summary["rowsB"].as_u64().unwrap(), 3);
        assert!(summary["elapsedMs"].as_u64().is_some());
        assert!(summary["estimatedComparisons"].as_u64().is_some());
    }

    fn write_fixture(path: &Path, headers: &[&str], rows: &[&[&str]]) {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        for (c, h) in headers.iter().enumerate() {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        for (r, row) in rows.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                ws.write_string((r + 1) as u32, c as u16, *v).unwrap();
            }
        }
        wb.save(path).unwrap();
    }

    #[test]
    fn inspect读取文件并建议列() {
        let dir = std::env::temp_dir().join("fuzzy_match_tests");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("inspect样例.xlsx");
        write_fixture(
            &path,
            &["序号", "公司名称", "金额"],
            &[&["1", "华为技术有限公司", "100"], &["2", "华辰集团", "200"]],
        );
        let v = call(
            "fuzzy.inspect",
            json!({"source": {"path": path.to_string_lossy()}}),
        )
        .unwrap();
        let headers: Vec<&str> = v["headers"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(headers, vec!["序号", "公司名称", "金额"]);
        assert_eq!(
            v["suggestedMapping"]["column"].as_str().unwrap(),
            "公司名称"
        );
        assert_eq!(v["rowCount"].as_u64().unwrap(), 2);
        assert_eq!(v["headerRow"].as_u64().unwrap(), 1);
        // 参数不完整应报中文错误。
        let err = call("fuzzy.inspect", json!({})).unwrap_err();
        assert_eq!(err.code, "MISSING_SOURCE");
    }

    #[test]
    fn export写出三张表() {
        let match_result = match_columns(
            vec!["华为技术有限公司", "北京华辰科技", "无关行", "", "123"],
            vec!["华为", "上海华辰科技"],
            &opts("company"),
        );
        let rows = match_result["rows"].clone();
        let dir = std::env::temp_dir().join("fuzzy_match_tests");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("导出结果.xlsx");
        let out = run_job(
            "fuzzy.export",
            json!({"path": path.to_string_lossy(), "rows": rows}),
            &noop_progress(),
            no_cancel(),
            &PauseCheckpoint::unpaused(no_cancel()),
        )
        .unwrap();
        assert_eq!(out["outputPath"].as_str().unwrap(), path.to_string_lossy());
        // 读回验证三张 Sheet 与行数。
        let mut book = open_workbook_auto(&path).unwrap();
        let names = book.sheet_names().to_vec();
        assert_eq!(names, vec!["全部结果", "疑似确认记录", "未匹配清单"]);
        let all: Vec<Vec<String>> = book
            .worksheet_range("全部结果")
            .unwrap()
            .rows()
            .map(|r| r.iter().map(data_text).collect())
            .collect();
        // 表头 1 行 + 华为 1 候选 + 华辰 1 候选 + 无关行 1 + 空值 1 + 纯数字 1 = 6。
        assert_eq!(all.len(), 6);
        let suspect: Vec<Vec<String>> = book
            .worksheet_range("疑似确认记录")
            .unwrap()
            .rows()
            .map(|r| r.iter().map(data_text).collect())
            .collect();
        assert_eq!(suspect.len(), 2); // 表头 + 北京华辰科技
        let unmatched: Vec<Vec<String>> = book
            .worksheet_range("未匹配清单")
            .unwrap()
            .rows()
            .map(|r| r.iter().map(data_text).collect())
            .collect();
        assert_eq!(unmatched.len(), 4); // 表头 + 未匹配 1 + 无效 2
        // 全部结果表头。
        assert_eq!(all[0][2], "A列原始值");
        assert_eq!(all[0][5], "匹配级别");
        // 疑似行原因列应含行政区域不一致，且级别列正确。
        assert_eq!(suspect[1][5], "疑似匹配");
        assert!(
            suspect[1][10].contains("行政区域不一致"),
            "实际：{:?}",
            suspect[1]
        );
    }

    // ---------- 粗筛正确性 ----------

    #[test]
    fn 粗筛长度过滤与top限制() {
        let options = opts("generic");
        // b0 与 a 共享 bigram「ab」但超 3 倍长且互不包含，应被长度过滤。
        let b: Vec<SideRow> = ["abzzzzzzzzzzzz", "ab", "abcd", "无关内容行"]
            .iter()
            .map(|v| prepare_row(v, &options))
            .collect();
        let index = build_index(&b);
        let mut scanner = CoarseScanner::new(b.len());
        let a = prepare_row("abcd", &options);
        let cands = scanner.scan(&a, &index, &b);
        let hits: Vec<u32> = cands.iter().map(|(_, j)| *j).collect();
        assert!(hits.contains(&2), "应命中完全相同行，实际 {hits:?}");
        assert!(!hits.contains(&0), "超 3 倍长度差应被过滤，实际 {hits:?}");
        assert_eq!(hits.first(), Some(&2), "命中数最多的候选应排最前");
    }

    #[test]
    fn 粗筛简称豁免() {
        let options = opts("company");
        let b: Vec<SideRow> = ["华为技术有限公司"]
            .iter()
            .map(|v| prepare_row(v, &options))
            .collect();
        let index = build_index(&b);
        let mut scanner = CoarseScanner::new(b.len());
        let a = prepare_row("华为", &options);
        let cands = scanner.scan(&a, &index, &b);
        // 2 字 vs 8 字超出 3 倍，但「华为」完整嵌在长串里，简称场景必须保留。
        assert_eq!(cands.len(), 1, "简称候选不应被长度过滤掉");
    }

    // ---------- 性能冒烟 ----------

    /// 固定种子 LCG（不引入 rand crate）。
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            ((self.next() >> 33) as usize) % n
        }
    }

    /// 性能冒烟：构造 2000×2000 随机公司名（规格原定 5000×5000；cargo test 的
    /// dev 档无优化，5000 档在 CI 上会超 60 秒预算，按规格允许降规模并在此
    /// 标注。release 档 5000×5000 粗筛+精算同为秒级）。
    #[test]
    fn 性能冒烟_2000乘2000() {
        const POOL: &[&str] = &[
            "华", "辰", "星", "衡", "鑫", "达", "瑞", "泰", "恒", "信", "中", "和", "嘉", "润",
            "宏", "远", "天", "正", "德", "同", "金", "海", "川", "林", "森", "宇", "宸", "烨",
            "霖", "锋", "航", "拓", "睿", "坤", "旭", "晟", "昊", "彦", "骏", "麟", "涛", "维",
            "诚", "源", "悦", "启", "明", "蔚", "临", "歌",
        ];
        const SUFFIXES: &[&str] = &["有限公司", "股份有限公司", "有限责任公司", "集团"];
        const N: usize = 2000;
        let mut rng = Lcg(20260825);
        let mut used: HashSet<String> = HashSet::new();
        let mut base_names: Vec<String> = Vec::with_capacity(N);
        while base_names.len() < N {
            let brand_len = 3 + rng.below(2); // 3-4 字字号，保证 2000 个不撞
            let brand: String = (0..brand_len)
                .map(|_| POOL[rng.below(POOL.len())])
                .collect();
            if !used.insert(brand.clone()) {
                continue;
            }
            let suffix = SUFFIXES[rng.below(SUFFIXES.len())];
            base_names.push(format!("{brand}{suffix}"));
        }
        // A 侧：一半注入字号内的错别字（第 2 字换成「囧」——不在字池，保证
        // 扰动后字号仍唯一，且不会触发字号包含提分）。
        let a: Vec<String> = base_names
            .iter()
            .enumerate()
            .map(|(i, name)| {
                if i % 2 == 0 {
                    let mut cs: Vec<char> = name.chars().collect();
                    cs[1] = '囧';
                    cs.into_iter().collect()
                } else {
                    name.clone()
                }
            })
            .collect();
        let started = Instant::now();
        let result = match_columns(
            a.iter().map(|s| s.as_str()).collect(),
            base_names.iter().map(|s| s.as_str()).collect(),
            &opts("company"),
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed.as_secs() < 60,
            "2000×2000 匹配应在 60 秒内完成，实际 {elapsed:?}"
        );
        let summary = &result["summary"];
        assert_eq!(summary["rowsA"].as_u64().unwrap(), N as u64);
        assert_eq!(summary["rowsB"].as_u64().unwrap(), N as u64);
        // 粗筛起效：精算对数被结构性截在 N×候选上限（2000×200=40 万），
        // 远小于全量 N*N（400 万对）。
        let estimated = summary["estimatedComparisons"].as_u64().unwrap();
        assert!(
            estimated <= (N * CANDIDATE_LIMIT) as u64 && estimated < (N * N) as u64 / 5,
            "粗筛+top截断应把精算量压到 N×200 以内，实际 {estimated}"
        );
        // 正确性抽查：未扰动行 exact 匹配自己（auto），扰动行最优候选是对应原行。
        let rows = result["rows"].as_array().unwrap();
        for i in [1usize, 3, 5, 7, 9] {
            let row = &rows[i];
            assert_eq!(
                row["level"].as_str().unwrap(),
                "auto",
                "未扰动行 {i} 应自动匹配"
            );
            assert_eq!(
                row["matches"][0]["bIndex"].as_u64().unwrap(),
                (i + 1) as u64,
                "未扰动行 {i} 应匹配到同序 B 行"
            );
        }
        for i in [0usize, 2, 4, 6, 8] {
            let row = &rows[i];
            let level = row["level"].as_str().unwrap();
            assert!(
                matches!(level, "auto" | "suspect"),
                "扰动行 {i} 应至少疑似匹配，实际 {level}"
            );
            assert_eq!(
                row["matches"][0]["bIndex"].as_u64().unwrap(),
                (i + 1) as u64,
                "扰动行 {i} 最优候选应是原行"
            );
        }
        // 扰动行字号已变（囧），不应触发字号包含提分到 93。
        let disturbed_total = rows[0]["matches"][0]["total"].as_f64().unwrap();
        assert!(
            disturbed_total < 90.0,
            "字号错别字不应自动匹配，实际 {disturbed_total}"
        );
    }

    // ---------- 接线层：落库、取回与确认 ----------

    fn temp_db(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("fuzzy_db_{tag}_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        (dir.join("test.db"), dir)
    }

    fn wired_match_params(db: &Path, job_id: &str) -> Value {
        // 文件名带 jobId：本辅助函数被多个测试并行调用，固定名会在「一个测试
        // 还在写 xlsx、另一个已开读」的瞬间交出半个 zip（EOCD 缺失）。
        let dir = std::env::temp_dir().join("fuzzy_match_tests");
        fs::create_dir_all(&dir).unwrap();
        let a_path = dir.join(format!("接线a侧-{job_id}.xlsx"));
        let b_path = dir.join(format!("接线b侧-{job_id}.xlsx"));
        write_fixture(
            &a_path,
            &["公司名称"],
            &[
                &["ＡＢＣ（上海）有限公司"],
                &["华为技术有限公司"],
                &["北京华辰科技"],
                &["完全无关的名称行"],
            ],
        );
        write_fixture(
            &b_path,
            &["公司名称"],
            &[&["ABC(上海)有限公司"], &["华为"], &["上海华辰科技"]],
        );
        json!({
            "sourceA": {"path": a_path.to_string_lossy(), "column": "公司名称"},
            "sourceB": {"path": b_path.to_string_lossy(), "column": "公司名称"},
            "matchType": "company",
            "__dbPath": db.to_string_lossy(),
            "__jobId": job_id,
        })
    }

    #[test]
    fn 匹配结果落库与确认取回roundtrip() {
        let (db, dir) = temp_db("roundtrip");
        let params = wired_match_params(&db, "job-r1");
        let result = run_job(
            "fuzzy.match",
            params,
            &noop_progress(),
            no_cancel(),
            &PauseCheckpoint::unpaused(no_cancel()),
        )
        .unwrap();
        let expected_levels: Vec<&str> = result["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["level"].as_str().unwrap())
            .collect();
        assert_eq!(
            expected_levels,
            vec!["auto", "auto", "suspect", "unmatched"]
        );

        // 临时库没有 task_history → summary 走行级统计重建路径。
        let back = storage_call(&db, "fuzzy.get_results", json!({"jobId": "job-r1"})).unwrap();
        assert_eq!(
            back["rows"].as_array().unwrap().len(),
            result["rows"].as_array().unwrap().len()
        );
        assert_eq!(back["summary"]["rowsA"], 4);
        assert_eq!(back["summary"]["autoCount"], 2);
        assert_eq!(back["summary"]["suspectCount"], 1);
        assert_eq!(back["summary"]["unmatchedCount"], 1);
        assert_eq!(back["confirmations"].as_array().unwrap().len(), 0);
        // 行级数据反序列化回 matches，候选结构完整。
        let suspect = &back["rows"][2];
        assert_eq!(suspect["aValue"].as_str().unwrap(), "北京华辰科技");
        let matches = suspect["matches"].as_array().unwrap();
        assert!(!matches.is_empty());
        assert_eq!(matches[0]["bValue"].as_str().unwrap(), "上海华辰科技");

        // save_confirm：先 accept 再 reject 覆盖（对齐前端 mergeConfirmations）。
        storage_call(
            &db,
            "fuzzy.save_confirm",
            json!({"jobId": "job-r1", "confirmations": [
                {"aIndex": 3, "bIndex": 3, "action": "accept"},
                {"aIndex": 4, "bIndex": null, "action": "reject"},
            ]}),
        )
        .unwrap();
        storage_call(
            &db,
            "fuzzy.save_confirm",
            json!({"jobId": "job-r1", "confirmations": [
                {"aIndex": 3, "bIndex": null, "action": "reject", "note": "非同一主体"},
            ]}),
        )
        .unwrap();
        let back2 = storage_call(&db, "fuzzy.get_results", json!({"jobId": "job-r1"})).unwrap();
        let confirms = back2["confirmations"].as_array().unwrap();
        assert_eq!(
            confirms.len(),
            2,
            "同 aIndex 应覆盖而不是追加：{confirms:?}"
        );
        let row3 = confirms.iter().find(|c| c["aIndex"] == 3).unwrap();
        assert_eq!(row3["action"], "reject");
        assert_eq!(row3["bIndex"], Value::Null);
        assert_eq!(row3["note"].as_str().unwrap(), "非同一主体");

        // 参数与数据缺失的中文错误。
        let err = storage_call(&db, "fuzzy.get_results", json!({})).unwrap_err();
        assert_eq!(err.code, "INVALID_PARAMS");
        let err = storage_call(&db, "fuzzy.get_results", json!({"jobId": "nope"})).unwrap_err();
        assert_eq!(err.code, "RESULTS_NOT_FOUND");
        let err = storage_call(
            &db,
            "fuzzy.save_confirm",
            json!({"jobId": "job-r1", "confirmations": [
                {"aIndex": 1, "bIndex": 1, "action": "maybe"},
            ]}),
        )
        .unwrap_err();
        assert_eq!(err.code, "INVALID_PARAMS");
        let err = storage_call(
            &db,
            "fuzzy.save_confirm",
            json!({"jobId": "job-r1", "confirmations": []}),
        )
        .unwrap_err();
        assert_eq!(err.code, "INVALID_PARAMS");

        // 未注入 __dbPath/__jobId 的直调不落库、不报错。
        let mut bare = wired_match_params(&db, "job-bare");
        if let Value::Object(map) = &mut bare {
            map.remove("__dbPath");
            map.remove("__jobId");
        }
        run_job(
            "fuzzy.match",
            bare,
            &noop_progress(),
            no_cancel(),
            &PauseCheckpoint::unpaused(no_cancel()),
        )
        .unwrap();
        let err = storage_call(&db, "fuzzy.get_results", json!({"jobId": "job-bare"})).unwrap_err();
        assert_eq!(err.code, "RESULTS_NOT_FOUND");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn 库导出叠加确认标记() {
        let (db, dir) = temp_db("export");
        let params = wired_match_params(&db, "job-e1");
        run_job(
            "fuzzy.match",
            params,
            &noop_progress(),
            no_cancel(),
            &PauseCheckpoint::unpaused(no_cancel()),
        )
        .unwrap();
        // 采纳第 3 行（北京华辰科技）的候选；拒绝第 4 行。
        storage_call(
            &db,
            "fuzzy.save_confirm",
            json!({"jobId": "job-e1", "confirmations": [
                {"aIndex": 3, "bIndex": 3, "action": "accept"},
                {"aIndex": 4, "bIndex": null, "action": "reject"},
            ]}),
        )
        .unwrap();
        let out_path = dir.join("导出.xlsx");
        let out = run_job(
            "fuzzy.export",
            json!({
                "jobId": "job-e1",
                "outputPath": out_path.to_string_lossy(),
                "__dbPath": db.to_string_lossy(),
            }),
            &noop_progress(),
            no_cancel(),
            &PauseCheckpoint::unpaused(no_cancel()),
        )
        .unwrap();
        // worker 事件协议要 outputPaths 数组（AllowedPaths 与 open_output 靠它）。
        assert_eq!(out["outputPaths"].as_array().unwrap().len(), 1);

        let mut book = open_workbook_auto(&out_path).unwrap();
        let all: Vec<Vec<String>> = book
            .worksheet_range("全部结果")
            .unwrap()
            .rows()
            .map(|r| r.iter().map(data_text).collect())
            .collect();
        // 第 3 行（suspect，已 accept）：确认标记 = 已确认。
        let row3 = all.iter().find(|r| r[1] == "3").unwrap();
        assert_eq!(row3[11], "已确认", "accept 的候选应标已确认：{row3:?}");
        // 第 1 行（auto，未确认）：确认标记 = 未确认。
        let row1 = all.iter().find(|r| r[1] == "1").unwrap();
        assert_eq!(row1[11], "未确认");
        // 库里没有该 jobId 时给中文错误。
        let err = run_job(
            "fuzzy.export",
            json!({
                "jobId": "job-不存在",
                "outputPath": dir.join("x.xlsx").to_string_lossy(),
                "__dbPath": db.to_string_lossy(),
            }),
            &noop_progress(),
            no_cancel(),
            &PauseCheckpoint::unpaused(no_cancel()),
        )
        .unwrap_err();
        assert_eq!(err.code, "RESULTS_NOT_FOUND");
        let _ = fs::remove_dir_all(dir);
    }

    /// 5 万行结果落库再整包取回的耗时基线（跨会话恢复路径）。
    /// 打印实际耗时（--nocapture 可见）；断言只设防挂死的宽上限，
    /// 是否需要 onlySuspect 按实测数字在接线报告里给结论。
    #[test]
    fn 五万行get_results耗时基线() {
        let (db, dir) = temp_db("perf");
        const N: usize = 50_000;
        let rows: Vec<Value> = (0..N)
            .map(|i| {
                // 混合三档：auto / suspect（带 3 个候选）/ unmatched，贴近真实分布。
                let level = match i % 10 {
                    0..=5 => "auto",
                    6..=7 => "suspect",
                    _ => "unmatched",
                };
                let matches = match level {
                    "auto" => vec![json!({
                        "bIndex": i + 1, "bValue": format!("某某公司{i}"), "level": "auto",
                        "total": 98.5,
                        "breakdown": {"charSim": 100.0, "lcsSim": 100.0, "tokenOverlap": 95.2, "total": 98.5},
                        "reasons": [],
                    })],
                    "suspect" => (0..3)
                        .map(|k| json!({
                            "bIndex": i + 1 + k, "bValue": format!("相似公司{i}_{k}"),
                            "level": "suspect", "total": 75.0 + k as f64,
                            "breakdown": {"charSim": 80.0, "lcsSim": 72.1, "tokenOverlap": 70.4, "total": 75.0 + k as f64},
                            "reasons": ["行政区域不一致，需人工确认"],
                        }))
                        .collect(),
                    _ => vec![],
                };
                json!({
                    "aIndex": i + 1,
                    "aValue": format!("第{i}行公司名称"),
                    "level": level,
                    "reasons": [],
                    "matches": matches,
                })
            })
            .collect();
        let t0 = Instant::now();
        persist_results(&db, "job-perf", &json!({"rows": rows})).unwrap();
        let write_elapsed = t0.elapsed();

        let t1 = Instant::now();
        let back = storage_call(&db, "fuzzy.get_results", json!({"jobId": "job-perf"})).unwrap();
        let read_elapsed = t1.elapsed();
        assert_eq!(back["rows"].as_array().unwrap().len(), N);
        assert_eq!(back["summary"]["rowsA"], N);
        println!("fuzzy.get_results 5万行：写库 {write_elapsed:?}，读回+重建 {read_elapsed:?}");
        assert!(
            read_elapsed.as_secs() < 30,
            "5 万行读回异常缓慢：{read_elapsed:?}"
        );
        let _ = fs::remove_dir_all(dir);
    }
}
