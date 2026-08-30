use reqwest::blocking::Client;
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use crate::AppError;

pub fn call(method: &str, params: Value, settings: Value) -> Result<Value, AppError> {
    match method {
        "audipick.config_status" => config_status(&settings),
        "audipick.extract" | "audipick.classify" => llm_text(&params, &settings),
        "audipick.ocr" => ocr(&params, &settings),
        "audipick.export" => export_workpaper(&params),
        _ => Err(error(
            "METHOD_NOT_ALLOWED",
            "不允许调用该 AudiPick 接口。",
            None,
        )),
    }
}

pub fn run_batch(
    params: Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: Arc<AtomicBool>,
    pause_path: &Path,
) -> Result<Value, AppError> {
    let settings = params.get("__settings").cloned().unwrap_or(json!({}));
    let prompt = params
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let rule_id = params
        .get("ruleId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let documents = params
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if prompt.is_empty() || documents.is_empty() {
        return Err(error(
            "AUDIPICK_BATCH_INVALID",
            "请选择合同并确认提取模板。",
            None,
        ));
    }
    let queue = Arc::new(Mutex::new(VecDeque::from(documents)));
    let (sender, receiver) = mpsc::channel::<Value>();
    let total = queue.lock().map(|rows| rows.len()).unwrap_or(0);
    let pause = pause_path.to_path_buf();
    thread::scope(|scope| {
        for _ in 0..3.min(total) {
            let queue = queue.clone();
            let sender = sender.clone();
            let cancel = cancel.clone();
            let settings = settings.clone();
            let prompt = prompt.clone();
            let pause = pause.clone();
            scope.spawn(move || loop {
                while pause.exists() && !cancel.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(150));
                }
                if cancel.load(Ordering::Relaxed) { break; }
                let document = queue.lock().ok().and_then(|mut rows| rows.pop_front());
                let Some(document) = document else { break; };
                let id = document.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
                let name = document.get("name").and_then(Value::as_str).unwrap_or(&id).to_owned();
                let path = document.get("textPath").and_then(Value::as_str).unwrap_or("");
                let result = match fs::read_to_string(path) {
                    Ok(text) if !text.trim().is_empty() => match request_llm(&settings["llm"], &prompt, &text, None) {
                        Ok(content) => json!({"id":id,"name":name,"ok":true,"content":content,"parsed":parse_json_content(&content)}),
                        Err(err) => json!({"id":id,"name":name,"ok":false,"error":{"code":err.code,"userMessage":err.user_message}}),
                    },
                    _ => json!({"id":id,"name":name,"ok":false,"error":{"code":"AUDIPICK_TEXT_MISSING","userMessage":"请先读取并保存合同文字。"}}),
                };
                let _ = sender.send(result);
            });
        }
        drop(sender);
        let mut completed = Vec::new();
        while completed.len() < total {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            match receiver.recv_timeout(Duration::from_millis(150)) {
                Ok(result) => {
                    completed.push(result);
                    progress("extract", completed.len(), total, "正在批量提取合同");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(error("JOB_CANCELLED", "任务已取消。", None));
        }
        Ok(
            json!({"ruleId":rule_id,"documents":completed,"completed":completed.len(),"total":total,"outputPaths":[]}),
        )
    })
}

fn export_workpaper(params: &Value) -> Result<Value, AppError> {
    let mut output = PathBuf::from(
        params
            .get("outputPath")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    if output.as_os_str().is_empty() {
        return Err(error("OUTPUT_REQUIRED", "请选择底稿输出文件。", None));
    }
    if output
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("xlsx"))
        != Some(true)
    {
        output.set_extension("xlsx");
    }
    let rows = params
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let rule_id = params.get("ruleId").and_then(Value::as_str).unwrap_or("");
    let mut workbook = Workbook::new();
    let header = Format::new()
        .set_bold()
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center)
        .set_background_color("#DCE6F1");
    if rule_id == "revenue_workpaper" {
        let intro = workbook.add_worksheet();
        intro.set_name("使用说明").map_err(xlsx_error)?;
        intro
            .write_string_with_format(0, 0, "收入合同审阅底稿填列清单", &header)
            .map_err(xlsx_error)?;
        intro
            .write_string(
                1,
                0,
                "本清单由 AudiPick 根据合同及补充资料生成，所有结论须由项目组人工复核。",
            )
            .map_err(xlsx_error)?;
        intro.set_column_width(0, 100).map_err(xlsx_error)?;
    }
    let sheet = workbook.add_worksheet();
    sheet
        .set_name(if rule_id == "revenue_workpaper" {
            "底稿填列清单"
        } else {
            "提取结果"
        })
        .map_err(xlsx_error)?;
    // The caller may dictate the column order.  The revenue checklist has to
    // keep the legacy layout — 工作表名称 / 底稿行号 / 回答目标单元格 … — because
    // that mapping is what makes the export transcribable back into the real
    // workpaper.  Sorting the raw keys alphabetically loses it.
    let requested = params
        .get("columns")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty());
    let columns: Vec<String> = requested.unwrap_or_else(|| {
        let mut keys = BTreeSet::new();
        for row in &rows {
            if let Some(object) = row.as_object() {
                for key in object.keys() {
                    if !matches!(key.as_str(), "id" | "contractId" | "fieldSetId") {
                        keys.insert(key.clone());
                    }
                }
            }
        }
        keys.into_iter().collect()
    });
    const WIDE_COLUMNS: &[&str] = &[
        "excerpt",
        "reason",
        "question",
        "问题描述",
        "建议回答",
        "合同依据",
        "意见",
        "合同条款摘录",
        "支持证据描述",
        "SOP定位",
    ];
    for (column, key) in columns.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, key, &header)
            .map_err(xlsx_error)?;
        sheet
            .set_column_width(
                column as u16,
                if WIDE_COLUMNS.iter().any(|needle| key.contains(needle)) {
                    60
                } else {
                    22
                },
            )
            .map_err(xlsx_error)?;
    }
    for (row_index, row) in rows.iter().enumerate() {
        for (column, key) in columns.iter().enumerate() {
            let value = row.get(key).cloned().unwrap_or(Value::Null);
            let text = match value {
                Value::Null => String::new(),
                Value::String(value) => value,
                other => other.to_string(),
            };
            sheet
                .write_string((row_index + 1) as u32, column as u16, &text)
                .map_err(xlsx_error)?;
        }
    }
    sheet.set_freeze_panes(1, 0).map_err(xlsx_error)?;
    if !columns.is_empty() {
        sheet
            .autofilter(
                0,
                0,
                rows.len() as u32,
                columns.len().saturating_sub(1) as u16,
            )
            .map_err(xlsx_error)?;
    }
    workbook.save(&output).map_err(xlsx_error)?;
    Ok(json!({"outputPaths":[output.to_string_lossy()],"rows":rows.len(),"ruleId":rule_id}))
}

fn config_status(settings: &Value) -> Result<Value, AppError> {
    let llm = settings.get("llm").cloned().unwrap_or(json!({}));
    let ocr = settings.get("ocr").cloned().unwrap_or(json!({}));
    let api_type = llm
        .get("api_type")
        .and_then(Value::as_str)
        .unwrap_or("openai");
    let llm_secret = secret(if api_type == "dify_chat" {
        "dify_api_key"
    } else {
        "llm_api_key"
    });
    let ocr_engine = ocr.get("engine").and_then(Value::as_str).unwrap_or("ai");
    let ocr_ready = match ocr_engine {
        "ai" => llm_secret.is_some(),
        "baidu" => secret("baidu_ocr_key").is_some() && secret("baidu_ocr_secret").is_some(),
        _ => false,
    };
    Ok(json!({
        "llm": {"ready": llm.get("enabled").and_then(Value::as_bool).unwrap_or(false) && llm_secret.is_some(),
                "apiType": api_type, "model": llm.get("model").cloned().unwrap_or(Value::Null)},
        "ocr": {"ready": ocr_ready, "engine": ocr_engine}
    }))
}

fn llm_text(params: &Value, settings: &Value) -> Result<Value, AppError> {
    let llm = settings
        .get("llm")
        .ok_or_else(|| error("LLM_NOT_CONFIGURED", "请先在工具箱设置中配置 LLM。", None))?;
    if !llm.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return Err(error("LLM_DISABLED", "工具箱中的 LLM 尚未启用。", None));
    }
    let prompt = params.get("prompt").and_then(Value::as_str).unwrap_or("");
    let text = params.get("text").and_then(Value::as_str).unwrap_or("");
    if prompt.is_empty() || text.is_empty() {
        return Err(error(
            "AUDIPICK_INPUT_REQUIRED",
            "提取模板和合同文字不能为空。",
            None,
        ));
    }
    let content = request_llm(llm, prompt, text, None)?;
    let parsed = parse_json_content(&content);
    Ok(json!({"content": content, "parsed": parsed}))
}

pub(crate) fn kanzhang_llm_call(params: &Value, settings: &Value) -> Result<Value, AppError> {
    let llm = settings
        .get("llm")
        .ok_or_else(|| error("LLM_NOT_CONFIGURED", "请先在工具箱设置中配置 LLM。", None))?;
    if !llm.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return Err(error("LLM_DISABLED", "工具箱中的 LLM 尚未启用。", None));
    }
    let mode = params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("mapping");
    let payload = params.get("payload").cloned().unwrap_or_else(|| json!({}));
    const ANALYSIS: &str = "你是审计看账分析助手。只依据输入的汇总数据，输出严格 JSON：{title:string,sections:[{heading:string,points:[{label:string,text:string}]}],review_notes:[string]}。范围仅限科目发生额、主要对方科目、凭证类型和月度波动；不得虚构凭证、金额或审计结论。";
    let mapping_prompt;
    let prompt: &str = if mode == "analysis" {
        ANALYSIS
    } else {
        mapping_prompt = kanzhang_mapping_prompt();
        &mapping_prompt
    };
    // 看账只读序时账，也不看原币口径——把能用的角色写进 payload，
    // 模型就不会建议 voucherType、foreignAmount 这些本工具消费不了的角色。
    let payload = if mode == "analysis" {
        payload
    } else {
        let mut value = payload;
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "availableRoles".into(),
                json!([
                    "id",
                    "accountCode",
                    "accountName",
                    "entity",
                    "date",
                    "summary",
                    "functionalAmount",
                    "direction",
                    "functionalDebit",
                    "functionalCredit"
                ]),
            );
        }
        inject_current_form(&mut value, "je");
        value
    };
    let content = request_llm(llm, prompt, &payload.to_string(), None)?;
    let mut value = parse_json_content(&content);
    if !value.is_object() {
        return Err(error(
            "LLM_RESPONSE_INVALID",
            "LLM 没有返回有效的结构化结果。",
            None,
        ));
    }
    if mode != "analysis" {
        // 与汇兑损益共用同一套卫生过滤，不再各写一份。
        sanitize_mapping_changes(&mut value, &payload, "je");
    }
    Ok(value)
}

/// 两张表共用的复核纪律。**只放对 TB 与 JE 都成立的规则**——
/// 各自的角色清单与形态规则分别放在 [`REVIEW_JE`] 与 [`REVIEW_TB`] 里，
/// 免得复核一张表时眼前摆着另一张表的规矩。
const REVIEW_COMMON: &str = "只能使用输入 availableRoles 中列出的角色——它是本工具启用的角色清单，没列出的角色即使表里有对应的列也不要提。输入的 currentForm 是脚本按整组匹配判出的账表形态。**complete 为 true 时，构成该形态的那些槽位已经成立，一律不要改动**——净额列里是正数还是自带正负号都不影响判定，借贷符号口径由数据配平判定，不由列名判定；表里另有一列看起来更像净额，也不构成改动理由。**两种映射都能成立时一律维持现状，不要为了让它更好看而改**。complete 只说明该形态自身的槽位成立，不代表整张表的映射已经完备——availableRoles 里本工具需要、currentMapping 还缺着的角色（比如原币币种、原币净额），仍必须照样补齐。complete 为 false 时，优先补齐 currentForm.missingSlots 里点名缺失的槽位。除此之外，必须主动补齐 currentMapping 中缺失、但可由 headers 与 sampleRows 判断出来的角色，不得仅复核已有映射。只能使用输入 headers 中真实存在的列，不得虚构列名。双语表头（如「科目描述 Description」「过账日期 Posting Date」）按其中的中文段判断角色。一列只承载一个语义，不能把同一列同时映射到两个角色——唯一的例外是下述「编码与名称写在同一格」的科目列。判断依据必须落在 sampleRows 的实际取值上：每提出一个 change，先从 sampleRows 里随意取三五行看该列的真实内容，若这几行取值与该角色应有的形态不符（科目编码列应是稳定的数字或字母数字编码，科目名称列应是可读文本，币种列应是三位 ISO 代码，金额列应是数值），就不要提出该 change。accountCode 与 accountName 是两个彼此独立的角色，不能互换：编码给 accountCode，名称/文本给 accountName。**编码与名称写在同一格**是例外情形（`1001010000:库存现金-人民币`、`1001/库存现金`、`1001_现金`，也有编码后面接反斜杠再接多级名称的写法——分隔符是斜杠、冒号、下划线、反斜杠、竖线之一，前半段是一串数字或字母数字编码）：这一列应**同时映射为 accountCode 与 accountName 两个角色**（脚本自动映射正是这么做的），既不要因为这列里有名称就改判成纯 accountName，也不要把其中任何一个角色挪走或删掉。务必与**层级名称拼接**区分开——`交易性金融资产_结构性存款`、`管理费用_研发费用_水电气费`，以及用反斜杠拼起来的「银行存款、在财务公司存款、活期」这种，前半段是上级科目名不是编码，这些整列属于 accountName。科目余额表与序时账是同一套账，同名角色必须同口径——两边的 accountCode 必须是同一种科目编码，accountName 同理。`抵销科目`、`统驭科目`、`对方科目`、`往来科目`、`预算科目` 记的是对手方或参考科目，取值同样是一串科目编码，跟本方科目长得一模一样，但它们绝不是 accountCode，也不是 accountName。entity 是记账主体（公司代码、核算主体、账套公司），绝不是交易对手方、往来单位（往來單位、Counterparty）、客户（客戶）、供应商（供應商）这类对手方字段，也不是制单人、录入人、审核人、过账人这类操作员；没有明确的主体列时让 entity 空缺，不得拿对手方字段凑数。集团货币／报告货币（Group Currency、集团货币金额）是第三套口径，既不是本位币也不是原币，对应的金额列与币种列一律不映射到任何角色。changes 数组只放需要修改或补充的条目：每条的 suggestedColumn 必须是输入 headers 中真实存在的列名，且与该角色当前的 currentColumn 不同（当前为空时是补缺）。只是确认现有映射正确、确认某列不存在、或没有实际变更的，一律不要输出该条——空缺本身就是正确状态，不要为了表态而造条目。suggestedColumn 为空或置信度低于 0.5 的条目没有意义，不要输出——拿不准就不输出。reason 与 suggestedColumn 必须指向同一个结论：reason 说该列不该映射，就不能输出把它映射上去的条目。同一列在 changes 里最多出现一次。『整列同值』的意思是全列每一行取值完全相同；只要出现两种以上取值，该列就在逐行区分交易或账户，绝不是本位币列。优先建议原始数据列：由其他列推算出的公式辅助列（如按方向列把金额改写成的「借正贷负」列、用日期与凭证号拼出的唯一码列）不要抢原始列的角色。不要计算金额、汇率或业务分类，只管映射。";

/// 序时账专属：16 个角色，一行是一条分录。
const REVIEW_JE: &str = "角色仅可为 entity、date、id、voucherType、accountCode、accountName、summary、currency、functionalCurrency、direction、functionalAmount、functionalDebit、functionalCredit、foreignAmount、foreignDebit、foreignCredit。id 与 accountName 可以映射多列：Oracle 的凭证键要 Batch＋JE Name 两列组合才唯一，少一列就串号；科目名称可能拆成一级、二级两列。其余角色各占一列。多列仅限上述两种真正的拆分：名称只组合科目名称自己的层级列（一级／二级／三级），凭证号只组合构成凭证键的列（如 Batch＋JE Name、凭证字＋凭证号）；冲销凭证号、被冲销凭证号记录的是「这张凭证冲掉了谁」，不是凭证键，预算科目、对方／往来科目也不是本方科目名称——这些列绝不并入多列。voucherType 只认独立成列的凭证类型（SAP 的 BLART、Document Type、凭证类别这类单独一列）；「凭证字＋号合成一列」（如 记-0001、记0001、记2025-0001）整列就是凭证识别字段 id，绝不要建议把这类合成列同时或改为映射 voucherType，也不要建议从中拆出类型。借贷方向只有 direction 一个角色，原币与本位币共用同一列——一条分录的借贷方向对两个口径必然相同，不存在原币记借方而本位币记贷方的情况。金额有三种记法，同一口径内只能成立一种：单列净额（借正贷负）、借方与贷方两列、净额加方向列。两个口径各自独立判定：原币可以是借贷分列而本位币是净额。借方与贷方两列已经成立时，不要再建议把借方或贷方列改映射为净额角色；净额列（无论正负号是否随方向列拆出）已经成立时，也不要建议把同一净额列同时映射为借方与贷方两个角色——三种记法互斥，多选反而破坏方案。币种**一律分两列判定，与科目余额表同口径**：currency 是原币币种，登记这笔分录按什么币记账（凭证货币、Document Currency Key、Enter Currency），逐行可变；functionalCurrency 是本位币币种，登记主体的记账本位币（公司代码货币、Company Code Currency Key、Ledger Currency），整列同值、不区分行。两者都是**币种代码列**（存 CNY／USD 这类三位代码），不是金额列，别跟本位币金额、原币金额混。两者都存在时不要互换。只有一列时先看列名：凭证货币命名的列（货币、凭证货币、交易币种、Document Currency、Enter Currency）就是 currency——整列只剩一种代码只是「整本账都是本币业务」的正常形态，不是本位币列的证据；本位币命名的列（本位币、本币、公司代码货币、总账货币、Ledger Currency、Company Code Currency）才是 functionalCurrency，整列同一个代码的「本币」「本币币种」列绝不能指给 currency。列名两头都不沾的，再按取值分布判：整列同一个代码且几乎不空的是 functionalCurrency，出现两种以上代码或大量空白的是 currency。常用表头示例：会计科目、总账科目、总帐科目（「帐」是「账」的异体字，两种写法都有）属于 accountCode，科目文本／科目全名／科目名称一级／科目名称二级属于 accountName，借贷标志（取值 S／H）属于 direction，唯一码（日期与凭证号已经拼好的一列）属于 id，凭证货币属于 currency，凭证金额、凭证货币金额属于 foreignAmount，本位币金额属于 functionalAmount，借贷属于 direction。列名只是线索、取值才是判据：「会计科目」「总账科目」命名的列在某些导出里放的是名称文本（如 库存现金-人民币），这时它是 accountName；取值是纯编码时才是 accountCode。过账代码（Posting Key，取值 40、50、01 这类数字过账码）不是借贷方向——统驭过账码没有借贷含义，绝不能映射为 direction。金额方案仅可为 signed、direction、debit_credit。";

/// 科目余额表专属：一行是一个科目在某时点的余额。角色清单以传入的 hardcodedCandidates 为准。
const REVIEW_TB: &str = "角色共分七组：身份（entity、accountCode、accountName）；币种（currency 原币币种、currencyText 币种线索文本、functionalCurrency 本位币）；方向（openingDirection 期初方向、closingDirection 期末方向）；期初余额六件套（本位币净额/借方/贷方、原币净额/借方/贷方）；期末余额六件套（同上）；本年累计发生额（本位币借方/贷方、原币借方/贷方）；本期发生额（本位币净额/借方/贷方，次选口径）。accountName 可以映射多列（如科目名称一级＋二级），其余角色各占一列。多列仅限科目名称的层级列；预算科目、对方／往来、辅助核算等语义不同的列不得并入。余额有三种记法，期初与期末各自独立判定：单列净额（借正贷负）、借方与贷方两列、净额加方向列。没有方向列时净额必须自带正负号，不要为了凑形态硬给一个方向列。方向列的归属看位置：方向列紧邻在某个余额列的右侧（期初余额…方向 / 期末余额…方向）时属于那个余额，紧跟期初余额右侧的映射 openingDirection、紧跟期末余额右侧的映射 closingDirection；表里只有一列「方向」且不在任何余额列右侧时（常见于表头前部、科目信息旁边），它是余额方向，一律映射 closingDirection——即使它紧邻或位于期初余额列的左侧也不要映射为 openingDirection。发生额口径：`借方累计`／`贷方累计` 与 `本年累计借方`／`本年累计贷方` 是同一回事，只是词序不同，都属于本年累计；期末余额列可能写作 `累计余额`（配一个 `累计余额方向`）。列名没写明「本期」还是「本年」时一律按本年累计（审计取的是全年数）；若同一张表出现两列都叫「借方发生额」，金额合计大的是本年累计、小的是本期发生。币种列判定只看取值分布，与列名无关，按两条二选一，没有第三种情况：（1）整列几乎全填满（空白不到一成）且从头到尾只出现一种币种代码 → functionalCurrency，它登记的是主体本位币；（2）其余一切情形 → currency（原币币种列）。这包括出现两种以上币种代码，也包括「只标外币」写法——大部分行空白、只有外币科目行才填币种，空白行的含义是本位币，这恰恰是 currency 列的正常形态，绝不能因为空白多就把它判成本位币列。反例：某列八成行空白、只在美元户/欧元户行填 USD/EUR——它是 currency；整列二百多行全部填同一个币种代码、无一空白——才是 functionalCurrency。币种角色空缺是正常状态：判为原币币种列的只映射 currency，functionalCurrency 空着（很多表根本不单列本位币）；判为本位币列的只映射 functionalCurrency，currency 空着。绝不要因为某个角色还空着，就把已判给另一币种角色的列再塞给它。判定为 functionalCurrency 后，若某个文本列里逐行写着账户币种（如「美元户」「ICBC USD」「建行USD4150」），把该列映射为 currencyText 供下游抽取。挑哪一列**只看取值、不看列名**：要挑真抽得出币种的那一列——`科目级别描述` 这种整列都是 `1002_银行存款` 的一级科目名，哪怕列名里有「描述」二字也不是线索列。没有任何一列抽得出币种时让 currencyText 空着，不要硬填。但表里另有真正的多币种列（含空白或多币种）时，以那一列为准。可以用勾稽等式验证映射是否成立：期末余额 = 期初余额 + 本年累计借方 − 本年累计贷方。若按当前映射大面积对不上，多半是把某一列映射错了口径，应指出来。";

/// 把**脚本已经判出的账表形态**写进 payload。
///
/// 不给这个，模型就是在盲猜：实测「序时账-1」里它看到金额列全是正数、
/// 另有一列「借正贷负」带正负号，就建议把本位币净额改指过去——它不知道脚本
/// 已经判定 JE2（方向＋净额）完整成立，更不知道在 JE2 下净额列有没有正负号
/// 根本不影响结果（符号口径由数据判定，不由列名判定）。
///
/// 告诉它形态，它才能在「两种映射都成立」时选择不动。
fn inject_current_form(payload: &mut Value, kind: &str) {
    let Some(mapping) = payload.get("currentMapping").and_then(Value::as_object) else {
        return;
    };
    let filled = |value: &Value| match value {
        Value::String(one) => !one.trim().is_empty(),
        Value::Array(all) => all
            .iter()
            .any(|x| x.as_str().is_some_and(|v| !v.trim().is_empty())),
        _ => false,
    };
    let mapped: std::collections::HashSet<&'static str> = mapping
        .iter()
        .filter(|(_, value)| filled(value))
        .map(|(role, _)| crate::ledger_mapping::migrate_role_name(kind, role))
        .filter(|role| !role.is_empty())
        .collect();
    if mapped.is_empty() {
        return;
    }
    let (form, complete, missing) = match crate::ledger_mapping::resolve_form(kind, &mapped) {
        crate::ledger_mapping::FormVerdict::Matched(m) => (m, true, Vec::new()),
        crate::ledger_mapping::FormVerdict::Incomplete(m) => {
            let missing = m.missing.clone();
            (m, false, missing)
        }
    };
    let labels: Vec<&str> = missing
        .iter()
        .filter_map(|role| crate::ledger_mapping::role_of(kind, role).map(|r| r.label))
        .collect();
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "currentForm".into(),
            json!({
                "id": form.form,
                "label": form.label,
                "complete": complete,
                "missingSlots": labels,
            }),
        );
    }
}

/// 所有 TB/JE 工具共用的唯一映射复核入口。
/// 工具能用哪些角色由 payload 的 `availableRoles` 声明。
pub(crate) fn ledger_review_call(
    kind: &str,
    params: &Value,
    settings: &Value,
) -> Result<Value, AppError> {
    ledger_mapping_llm_call(kind, params, settings)
}

fn ledger_mapping_llm_call(
    kind: &str,
    params: &Value,
    settings: &Value,
) -> Result<Value, AppError> {
    let llm = settings
        .get("llm")
        .ok_or_else(|| error("LLM_NOT_CONFIGURED", "请先在工具箱设置中配置 LLM。", None))?;
    if !llm.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return Err(error("LLM_DISABLED", "工具箱中的 LLM 尚未启用。", None));
    }
    let is_tb = kind == "tb";
    let task = if is_tb {
        "ledger_tb_mapping"
    } else {
        "ledger_je_mapping"
    };
    let (table_name, specific) = if is_tb {
        ("科目余额表", REVIEW_TB)
    } else {
        ("序时账", REVIEW_JE)
    };
    let prompt = format!(
        "你是审计工具箱公共 TB/JE 引擎的{table_name}字段映射复核器，任务名为 {task}。\
         只输出严格 JSON：{{\"task\":\"{task}\",\"changes\":[{{\"role\":string,\
         \"currentColumn\":string,\"suggestedColumn\":string,\"confidence\":number,\
         \"reason\":string,\"scheme\":string}}]}}。{REVIEW_COMMON}{specific}"
    );
    let mut payload = params.get("payload").unwrap_or(params).clone();
    // 兼容旧版 FX 请求携带的 hardcodedCandidates。
    if payload.get("availableRoles").is_none() {
        if let Some(roles) = payload
            .get("hardcodedCandidates")
            .and_then(Value::as_array)
            .map(|all| {
                all.iter()
                    .filter_map(|item| item.get("role").and_then(Value::as_str))
                    .map(|role| Value::String(role.to_owned()))
                    .collect::<Vec<_>>()
            })
            .filter(|all| !all.is_empty())
        {
            if let Some(object) = payload.as_object_mut() {
                object.insert("availableRoles".into(), Value::Array(roles));
            }
        }
    }
    inject_current_form(&mut payload, if is_tb { "tb" } else { "je" });
    let payload = &payload;
    let content = request_llm(llm, &prompt, &payload.to_string(), None)?;
    let mut value = parse_json_content(&content);
    if !value.is_object() {
        return Err(error(
            "LLM_RESPONSE_INVALID",
            "LLM 没有返回有效的结构化结果。",
            None,
        ));
    }
    sanitize_mapping_changes(&mut value, payload, if is_tb { "tb" } else { "je" });
    Ok(value)
}

/// 复核结果的卫生过滤：模型偶尔会输出"确认行"——reason 说某列不该映射，
/// change 却仍把它指过去，或复述 currentMapping 里已有的映射。这类行一旦
/// 被前端当真应用，会把正确映射改坏。这里按 payload 里的 headers 与
/// currentMapping 做机器可判的兜底，剩余的才交给前端。
///
/// 第三轮实测里模型最常见的毛病不是判断错（reason 基本都判对了），
/// 而是接受不了"角色空缺是正常状态"：把已被 currency 占用的币种列
/// 硬塞给空缺的 functionalCurrency，把被 auxiliary 占用的往来列塞给 entity。
/// 所以核心规则是**目标列被谁占用**，以 currentMapping 为准，不信模型自报
/// 的 currentColumn（它时常把已有映射报成空）。
fn sanitize_mapping_changes(value: &mut Value, payload: &Value, kind: &str) {
    // 汇兑损益输出 `changes`，看账与正负数凭证标记输出 `fills`／`reviews`——
    // 结构不同，纪律相同，逐个字段过一遍同一套规则。
    for key in ["changes", "fills", "reviews"] {
        sanitize_change_list(value, payload, kind, key);
    }
}

fn sanitize_change_list(value: &mut Value, payload: &Value, kind: &str, key: &str) {
    let Some(changes) = value.get_mut(key).and_then(Value::as_array_mut) else {
        return;
    };
    let headers: Vec<String> = payload
        .get("headers")
        .and_then(Value::as_array)
        .map(|all| {
            all.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let current_mapping = payload
        .get("currentMapping")
        .cloned()
        .unwrap_or(Value::Null);
    // 某角色当前映射到的列集合（multi 角色是多列）。
    let columns_of = |role: &str| -> Vec<String> {
        current_mapping
            .get(role)
            .map(|value| match value {
                Value::String(one) => vec![one.trim().to_owned()],
                Value::Array(all) => all
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                _ => Vec::new(),
            })
            .unwrap_or_default()
    };
    // 挪移链：预收集"谁从哪列挪到哪列"——目标列被占用时，只有占用者
    // 同时被挪去**另一列**，改指才成立（retain 闭包里不能再借用整个
    // 数组，先算好）。挪到空列是清除，不是挪移，构不成配套——实测模型
    // 会成对输出"currency 补货币列 + functionalCurrency 货币列→(空)"，
    // 两条其实都是在硬表达同一个确认，都得拦。
    let movers: Vec<(String, String)> = changes
        .iter()
        .filter_map(|change| {
            let role = change.get("role").and_then(Value::as_str)?;
            let from = change
                .get("currentColumn")
                .and_then(Value::as_str)
                .map(str::trim)?;
            let to = change
                .get("suggestedColumn")
                .and_then(Value::as_str)
                .map(str::trim)?;
            (!to.is_empty() && to != from).then(|| (role.to_owned(), from.to_owned()))
        })
        .collect();
    let sample_rows = sample_rows_of(payload);
    // 样例里判得出的「编码＋名称混写」列：这些列允许 accountCode 与
    // accountName 共用（见下方 occupied 检查的豁免）。
    let combined_account_columns = combined_account_headers(&headers, sample_rows.as_deref());
    let mut seen_columns: Vec<String> = Vec::new();
    changes.retain(|change| {
        let Some(suggested) = change.get("suggestedColumn").and_then(Value::as_str) else {
            return false;
        };
        let suggested = suggested.trim();
        let current = change
            .get("currentColumn")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let role = change
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let confidence = change
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        // 列名必须是表里真实存在的、置信够用、且全批里同一列只出现一次。
        // 实测模型会输出"reason 说不该映射、置信 0.1 却仍然映射"的自相矛盾行，
        // 低于 0.5 的建议没有应用价值，一并丢弃。
        if role.is_empty()
            || suggested.is_empty()
            || !(headers.is_empty() || headers.iter().any(|header| header.trim() == suggested))
            || confidence < 0.5
            || seen_columns.iter().any(|column| column == suggested)
        {
            return false;
        }
        // 复述现状的两种形态都丢弃：与自报 currentColumn 相同，
        // 或与 currentMapping 里该角色的现行列相同（模型自报常有偏差）。
        if suggested == current || columns_of(role).iter().any(|column| column == suggested) {
            return false;
        }
        // 别名库的冲突词是确定性否定：它已经明说这类列不属于该角色。
        // 提示词讲过的纪律模型照样会犯——「预算二级科目描述」指给科目名称
        // 是实测踩过的坑，拼进科目键会把同一个会计科目拆成好几行。
        // 例外：编码与名称混写的科目列，列名带「编码」正是它的常态
        // （03 号样例就叫「项目编码、文本/科目编码、文本」），冲突词挡的
        // 是「只有编码的列」，挡不住这一列同时挂两个角色。
        let combined_pair = matches!(role, "accountName" | "accountCode")
            && combined_account_columns
                .iter()
                .any(|column| column == suggested)
            && columns_of(if role == "accountName" {
                "accountCode"
            } else {
                "accountName"
            })
            .iter()
            .any(|column| column == suggested);
        if !combined_pair && crate::ledger_mapping::role_rejects_header(kind, role, suggested) {
            return false;
        }
        // 方向角色的取值形态校验：方向列写的应是 S/H、借/贷、Dr/Cr 这类方向
        // 标志。SAP 的过账代码（40/50/01）虽然也分借贷，但统驭过账码没有
        // 借贷含义——03 号样例就被模型指给过 direction。样例行里出现一个
        // 认不出的取值就不放行；整列样例全空时没有证据，维持原判。
        if role.contains("irection")
            && headers
                .iter()
                .position(|header| header.trim() == suggested)
                .zip(sample_rows.as_deref())
                .is_some_and(|(index, rows)| {
                    let values = rows
                        .iter()
                        .filter_map(|row| row.get(index).map(String::as_str));
                    direction_values_look_like_side(values) == Some(false)
                })
        {
            return false;
        }
        // reason 以否定结论收尾（"不应映射""暂不映射"）的条目仍是映射建议——
        // 实测四轮里这类行全是模型想表态"我确认过、维持空缺"的拧巴输出，
        // 从没出现过合法建议用否定句式写 reason 的，宁可错杀。
        let reason = change.get("reason").and_then(Value::as_str).unwrap_or("");
        if ["不映射", "不应映射", "不應映射", "不該映射"]
            .iter()
            .any(|mark| reason.contains(mark))
        {
            return false;
        }
        // 目标列已被其他角色占用、且没有人配套地把那个角色挪走 →
        // 应用它会造成一列两角色，丢弃。真要挪，得成对出现。
        // 例外：编码与名称混写的科目列本该同时挂 accountCode 与 accountName
        // 两个角色（提示词明确要求），这不算冲突。
        let combined = &combined_account_columns;
        let occupied_elsewhere = current_mapping.as_object().is_some_and(|mapping| {
            mapping.iter().any(|(other_role, other_value)| {
                let exempt = ((role == "accountName" && other_role == "accountCode")
                    || (role == "accountCode" && other_role == "accountName"))
                    && combined.iter().any(|column| column == suggested);
                other_role != role
                    && !exempt
                    && match other_value {
                        Value::String(one) => one.trim() == suggested,
                        Value::Array(all) => all
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|column| column.trim() == suggested),
                        _ => false,
                    }
                    && !movers.iter().any(|(mover_role, mover_from)| {
                        mover_role == other_role && mover_from == suggested
                    })
            })
        });
        if occupied_elsewhere {
            return false;
        }
        seen_columns.push(suggested.to_owned());
        true
    });
}

/// payload 里的样例行（每行与 headers 按下标对齐）。JSON 数组一律克隆出一份，
/// 让调用方持有，避免借用整个 payload。
fn sample_rows_of(payload: &Value) -> Option<Vec<Vec<String>>> {
    payload
        .get("sampleRows")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.as_array()
                        .map(|cells| {
                            cells
                                .iter()
                                .map(|cell| cell.as_str().unwrap_or_default().to_owned())
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .collect::<Vec<Vec<String>>>()
        })
        .filter(|rows| !rows.is_empty())
}

/// 按样例判「编码＋名称混写」的列名清单，与内核
/// `is_combined_account_column` 同阈值：四分之三以上非空取值能拆出
/// 编码前缀才算——零星几行能拆多半是巧合，不能据此放行共列。
fn combined_account_headers(headers: &[String], rows: Option<&[Vec<String>]>) -> Vec<String> {
    let Some(rows) = rows else {
        return Vec::new();
    };
    headers
        .iter()
        .enumerate()
        .filter(|(index, _)| {
            let (mut total, mut split) = (0usize, 0usize);
            for value in rows.iter().filter_map(|row| row.get(*index)) {
                let value = value.trim();
                if value.is_empty() {
                    continue;
                }
                total += 1;
                if crate::ledger_mapping::split_code_and_name(value).is_some() {
                    split += 1;
                }
            }
            total >= 4 && split * 4 >= total * 3
        })
        .map(|(_, header)| header.trim().to_owned())
        .collect()
}

/// 一列取值是否全部是借贷方向的标志写法。`None` 表示没有任何非空样本、
/// 判不了；`Some(false)` 表示至少一个取值不是方向标志。
fn direction_values_look_like_side<'a>(values: impl Iterator<Item = &'a str>) -> Option<bool> {
    let (mut checked, mut hits) = (0usize, 0usize);
    for raw in values {
        let value = raw
            .trim()
            .trim_end_matches('.')
            .replace([' ', '\u{a0}'], "")
            .to_uppercase();
        if value.is_empty() {
            continue;
        }
        checked += 1;
        if matches!(
            value.as_str(),
            "S" | "H"
                | "D"
                | "C"
                | "DR"
                | "CR"
                | "DB"
                | "借"
                | "贷"
                | "借方"
                | "贷方"
                | "借貸"
                | "貸方"
                | "DEBIT"
                | "CREDIT"
                | "DC"
                | "DR/CR"
                | "借贷"
        ) {
            hits += 1;
        }
    }
    (checked > 0).then(|| hits == checked)
}

fn ledger_source_classification_prompt(tool: &str) -> &'static str {
    match tool {
        "deposit_interest" => {
            r#"你是存款利息收入测算工具的账表分类复核员。输入包含脚本初判、候选Sheet、自动识别后的完整表头和样例行。判断文件属于JE序时账还是TB科目余额表。JE应是逐笔凭证明细，通常含日期、凭证号、摘要、科目以及借贷或发生金额；TB应是按科目/银行账户/辅助核算汇总的余额表，重点识别期初余额、期末余额、本期或本年累计借贷发生额。文件里出现银行存款或利息收入科目不能单独证明它是JE；以行粒度和余额结构为准。脚本结论仅供参考，必须独立复核。只输出严格JSON：{"kind":"je"|"tb","confidence":number,"reason":string}。不得计算利息或金额。"#
        }
        "fa_tbje" => {
            r#"你是固定资产底稿生成工具的账表分类复核员。输入包含脚本初判、候选Sheet、完整表头和样例行。判断文件属于JE序时账还是TB科目余额表。JE是逐笔凭证明细，用于识别固定资产新增、处置、折旧等变动，通常含日期、凭证号、摘要、科目和借贷发生额；TB是按科目及辅助核算汇总的余额表，通常包含期初、期末、本期或累计借贷余额/发生额。出现固定资产或累计折旧科目不能单独决定类型，必须依据数据粒度和余额结构判断。脚本结论仅供参考，必须独立复核。只输出严格JSON：{"kind":"je"|"tb","confidence":number,"reason":string}。不得进行资产分类或金额计算。"#
        }
        _ => {
            r#"你是汇兑损益测算工具的账表分类复核员。输入包含脚本初判、候选Sheet、完整表头和样例行。判断文件属于JE凭证明细还是TB科目余额表。JE是逐笔凭证明细，通常含记账日期、凭证号、摘要、科目、币种、原币金额及本位币借贷发生额；TB是按科目、主体、币种或辅助核算汇总的余额表，通常包含期初、期末、本期或YTD借贷余额/发生额。币种列在JE和TB中都可能存在，不能单独决定类型；以行粒度和余额结构为准。脚本结论仅供参考，必须独立复核。只输出严格JSON：{"kind":"je"|"tb","confidence":number,"reason":string}。不得计算汇兑损益或金额。"#
        }
    }
}

pub(crate) fn ledger_source_llm_call(
    tool: &str,
    params: &Value,
    settings: &Value,
) -> Result<Value, AppError> {
    let llm = settings
        .get("llm")
        .ok_or_else(|| error("LLM_NOT_CONFIGURED", "请先在工具箱设置中配置 LLM。", None))?;
    if !llm.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return Err(error("LLM_DISABLED", "工具箱中的 LLM 尚未启用。", None));
    }
    let prompt = ledger_source_classification_prompt(tool);
    let payload = params.get("payload").unwrap_or(params);
    let content = request_llm(llm, prompt, &payload.to_string(), None)?;
    let value = parse_json_content(&content);
    let valid = value
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| matches!(kind, "je" | "tb"));
    if !valid {
        return Err(error(
            "LLM_RESPONSE_INVALID",
            "LLM 没有返回有效的JE/TB分类结果。",
            None,
        ));
    }
    Ok(value)
}

pub(crate) fn fx_account_translation_llm_call(
    accounts: &[(String, String)],
    settings: &Value,
) -> Result<BTreeMap<String, String>, AppError> {
    let llm = settings
        .get("llm")
        .ok_or_else(|| error("LLM_NOT_CONFIGURED", "请先在工具箱设置中配置 LLM。", None))?;
    if !llm.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return Err(error("LLM_DISABLED", "工具箱中的 LLM 尚未启用。", None));
    }
    if accounts.is_empty() {
        return Ok(BTreeMap::new());
    }
    let prompt = r#"你是审计底稿的会计科目翻译助手。把输入中的英文会计科目名称准确、简洁地翻译成中文，保留必要的产品名、主体名和缩写含义。只输出严格JSON：{"translations":[{"code":string,"originalName":string,"chineseName":string}]}。code和originalName必须逐字使用输入值，不得新增、删除或合并科目；不得计算金额、判断科目角色或修改原文。"#;
    let payload = json!({"accounts": accounts.iter().map(|(code, name)| json!({
        "code": code, "originalName": name
    })).collect::<Vec<_>>()});
    let content = request_llm(llm, prompt, &payload.to_string(), None)?;
    let value = parse_json_content(&content);
    let allowed = accounts.iter().cloned().collect::<BTreeMap<_, _>>();
    let mut output = BTreeMap::new();
    for item in value
        .get("translations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let code = item
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let original = item
            .get("originalName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let chinese = item
            .get("chineseName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if allowed
            .get(code)
            .is_some_and(|expected| expected.trim() == original)
            && chinese
                .chars()
                .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
        {
            output.insert(code.to_owned(), chinese.to_owned());
        }
    }
    if output.is_empty() {
        return Err(error(
            "LLM_RESPONSE_INVALID",
            "LLM 未返回有效的中文科目翻译。",
            None,
        ));
    }
    Ok(output)
}

/// 看账与正负数凭证标记的复核提示词。
///
/// **规则文本不自带**——纪律取自 [`REVIEW_COMMON`] ＋ [`REVIEW_JE`]，与汇兑损益同一份。
/// 差别只有两处：输出结构是 `fills`／`reviews`（这两个工具的前端按它消费），
/// 以及金额方案用 A／B 表述。本工具能用哪些角色由 payload 的 `availableRoles` 声明。
fn kanzhang_mapping_prompt() -> String {
    format!(
        "你是会计凭证字段映射复核助手。输出严格 JSON：\
         {{scheme:\"A\"|\"B\"|\"\",schemeReason:string,\
         fills:[{{role:string,suggestedColumn:string,confidence:number,reason:string}}],\
         reviews:[{{role:string,currentColumn:string,suggestedColumn:string,confidence:number,reason:string}}]}}。\
         方案A＝净额列（可加方向列）；方案B＝借方与贷方两列，二者互斥。\
         {REVIEW_COMMON}{REVIEW_JE}"
    )
}

fn ocr(params: &Value, settings: &Value) -> Result<Value, AppError> {
    let image = params
        .get("imageBase64")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_start_matches("data:image/jpeg;base64,")
        .trim_start_matches("data:image/png;base64,");
    if image.is_empty() {
        return Err(error(
            "OCR_IMAGE_REQUIRED",
            "没有收到需要识别的页面图片。",
            None,
        ));
    }
    let engine = settings
        .get("ocr")
        .and_then(|v| v.get("engine"))
        .and_then(Value::as_str)
        .unwrap_or("ai");
    if engine == "baidu" {
        return baidu_ocr(image);
    }
    if engine != "ai" {
        return Err(error(
            "OCR_ENGINE_UNAVAILABLE",
            "当前仅支持统一 AI 视觉或百度 OCR。",
            None,
        ));
    }
    let llm = settings
        .get("llm")
        .ok_or_else(|| error("LLM_NOT_CONFIGURED", "AI 视觉需要先配置工具箱 LLM。", None))?;
    let content = request_llm(
        llm,
        "请逐字识别图片中的中文和数字，只返回识别文字，不要解释。",
        "",
        Some(image),
    )?;
    Ok(json!({"text": content, "engine": "ai"}))
}

fn request_llm(
    config: &Value,
    prompt: &str,
    text: &str,
    image: Option<&str>,
) -> Result<String, AppError> {
    request_llm_with_key(config, prompt, text, image, None)
}

pub(crate) fn test_llm_connection(
    config: &Value,
    api_key: Option<&str>,
) -> Result<Value, AppError> {
    let started = std::time::Instant::now();
    let content = request_llm_with_key(
        config,
        "这是连接测试。请只回复 OK。",
        "OK",
        None,
        api_key.filter(|value| !value.trim().is_empty()),
    )?;
    if content.trim().is_empty() {
        return Err(error(
            "LLM_EMPTY_RESPONSE",
            "连接成功，但模型返回了空内容。请检查模型名称或服务配置。",
            None,
        ));
    }
    Ok(json!({
        "ok": true,
        "message": "LLM 连接测试成功。",
        "apiType": config.get("api_type").and_then(Value::as_str).unwrap_or("openai"),
        "model": config.get("model").and_then(Value::as_str).unwrap_or(""),
        "elapsedMs": started.elapsed().as_millis()
    }))
}

fn request_llm_with_key(
    config: &Value,
    prompt: &str,
    text: &str,
    image: Option<&str>,
    api_key: Option<&str>,
) -> Result<String, AppError> {
    let api_type = config
        .get("api_type")
        .and_then(Value::as_str)
        .unwrap_or("openai");
    let base = config
        .get("base_url")
        .and_then(Value::as_str)
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(error(
            "LLM_URL_INVALID",
            "LLM Base URL 必须使用 HTTP 或 HTTPS。",
            None,
        ));
    }
    let timeout = config
        .get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(60)
        .clamp(10, 300);
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(network_error)?;
    if api_type == "dify_chat" {
        let key = api_key
            .map(str::to_owned)
            .or_else(|| secret("dify_api_key"))
            .ok_or_else(|| error("LLM_KEY_MISSING", "未找到 Dify API Key。", None))?;
        let url = if base.ends_with("/chat-messages") {
            base.to_string()
        } else {
            format!("{base}/chat-messages")
        };
        let query = format!("{prompt}\n\n{text}");
        let response = client.post(url).bearer_auth(key).json(&json!({"inputs":{},"query":query,"response_mode":"blocking","user":"audit-toolbox"})).send().map_err(network_error)?;
        let value = read_llm_response(response, "Dify 提取请求失败。")?;
        return Ok(value
            .get("answer")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string());
    }
    let key = api_key
        .map(str::to_owned)
        .or_else(|| secret("llm_api_key"))
        .ok_or_else(|| error("LLM_KEY_MISSING", "未找到 LLM API Key。", None))?;
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    };
    let user_content = if let Some(data) = image {
        json!([{"type":"text","text":prompt},{"type":"image_url","image_url":{"url":format!("data:image/jpeg;base64,{data}")}}])
    } else {
        Value::String(text.to_string())
    };
    let mut request = client.post(url);
    if config.get("auth_mode").and_then(Value::as_str) == Some("raw") {
        request = request.header("Authorization", key);
    } else {
        request = request.bearer_auth(key);
    }
    // 同 fa.rs：旧版每次调用都关闭思维链、对 DeepSeek 打开 JSON 输出模式，
    // 迁移时两个参数都漏了。
    let json_prompt = json_response_prompt(base, prompt);
    let system_prompt = json_prompt.as_deref().unwrap_or(prompt);
    let mut body = json!({
        "model": config.get("model").and_then(Value::as_str).unwrap_or(""),
        "temperature": 0,
        "messages": [{"role":"system","content":system_prompt},{"role":"user","content":user_content}],
        "thinking": {"type": if thinking_enabled(config) { "enabled" } else { "disabled" }},
    });
    if json_prompt.is_some() {
        body["response_format"] = json!({"type": "json_object"});
    }
    let response = request.json(&body).send().map_err(network_error)?;
    let value = read_llm_response(response, "LLM 提取请求失败。")?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or("");
    if content.trim().is_empty() {
        return Err(empty_content_error(&value));
    }
    Ok(content.to_string())
}

/// Error for a response whose assistant message carried no text.
///
/// An empty body used to fall through as `""`, parse into zero items and reach
/// the user as "extracted 0 rows" — indistinguishable from a contract that
/// genuinely says nothing.  The usual causes are the model spending its output
/// budget on reasoning tokens or hitting the length limit, so name them.
fn empty_content_error(value: &Value) -> AppError {
    let finish = value
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        .unwrap_or("");
    let reasoning = value
        .pointer("/choices/0/message/reasoning_content")
        .and_then(Value::as_str)
        .map(str::len)
        .unwrap_or(0);
    let mut detail = Vec::new();
    if !finish.is_empty() {
        detail.push(format!("finish_reason={finish}"));
    }
    if reasoning > 0 {
        detail.push(format!("思维内容{reasoning}字"));
    }
    if finish == "length" {
        detail.push("输出额度已用尽".into());
    }
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!("（{}）", detail.join("，"))
    };
    error(
        "EMPTY_ASSISTANT_CONTENT",
        &format!(
            "模型返回正文为空{suffix}。程序已请求关闭思维模式，但当前模型或接口可能未执行；\
             请改用较短的资料重试，或在设置中更换模型。"
        ),
        None,
    )
}

fn baidu_ocr(image: &str) -> Result<Value, AppError> {
    let ak = secret("baidu_ocr_key")
        .ok_or_else(|| error("OCR_KEY_MISSING", "未找到百度 OCR API Key。", None))?;
    let sk = secret("baidu_ocr_secret")
        .ok_or_else(|| error("OCR_KEY_MISSING", "未找到百度 OCR Secret Key。", None))?;
    let client = Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(network_error)?;
    let token: Value = client
        .post("https://aip.baidubce.com/oauth/2.0/token")
        .query(&[
            ("grant_type", "client_credentials"),
            ("client_id", ak.as_str()),
            ("client_secret", sk.as_str()),
        ])
        .send()
        .map_err(network_error)?
        .json()
        .map_err(network_error)?;
    let access = token
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            error(
                "OCR_TOKEN_FAILED",
                "百度 OCR 鉴权失败。",
                Some(safe_error(&token)),
            )
        })?;
    let value: Value = client
        .post("https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic")
        .query(&[("access_token", access)])
        .form(&[("image", image), ("paragraph", "true")])
        .send()
        .map_err(network_error)?
        .json()
        .map_err(network_error)?;
    if value.get("error_code").is_some() {
        return Err(error(
            "OCR_REQUEST_FAILED",
            "百度 OCR 识别失败。",
            Some(safe_error(&value)),
        ));
    }
    let text = value
        .get("words_result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| row.get("words").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(json!({"text":text,"engine":"baidu"}))
}

fn secret(name: &str) -> Option<String> {
    keyring::Entry::new("AuditToolbox", name)
        .ok()?
        .get_password()
        .ok()
        .filter(|value| !value.is_empty())
}
fn parse_json_content(content: &str) -> Value {
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(cleaned).unwrap_or_else(|_| json!({"items":[],"raw":content}))
}
fn safe_error(value: &Value) -> String {
    value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .unwrap_or("远程服务返回错误")
        .chars()
        .take(300)
        .collect()
}
/// 见 `fa.rs` 同名函数：结构化任务默认关闭思维链。
fn thinking_enabled(config: &Value) -> bool {
    config
        .get("thinking_enabled")
        .or_else(|| config.get("thinkingEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn wants_json_response(base: &str) -> bool {
    base.to_ascii_lowercase().contains("api.deepseek.com")
}

/// DeepSeek 的兼容接口只有在提示词明确包含小写 `json` 时才接受
/// `response_format=json_object`。同时，连接测试、OCR 等纯文本任务不能被
/// 强行切到 JSON 模式。所有使用公共 LLM 请求器的工具统一从这里决定。
pub(crate) fn json_response_prompt(base: &str, prompt: &str) -> Option<String> {
    (wants_json_response(base) && prompt.to_ascii_lowercase().contains("json"))
        .then(|| format!("{prompt}\n\n返回内容必须是一个有效的 json 对象。"))
}

fn body_snippet(body: &str) -> String {
    let text: String = body.trim().chars().take(300).collect();
    if text.is_empty() {
        "响应体为空".into()
    } else {
        text
    }
}

/// 先取文本，再判状态，最后解析 JSON——理由同 `fa.rs` 的同名函数：
/// 直接 `.json()` 会把网关的 HTML 错误页和被截断的响应都变成
/// "error decoding response body"，真正的服务端信息全部丢失。
fn read_llm_response(
    response: reqwest::blocking::Response,
    label: &str,
) -> Result<Value, AppError> {
    let status = response.status();
    let body = response.text().map_err(network_error)?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&body)
            .as_ref()
            .map(safe_error)
            .unwrap_or_else(|_| body_snippet(&body));
        return Err(error(
            "LLM_REQUEST_FAILED",
            label,
            Some(format!("HTTP {status}：{detail}")),
        ));
    }
    serde_json::from_str(&body).map_err(|e| {
        error(
            "LLM_RESPONSE_INVALID",
            "LLM 返回的内容不是有效 JSON，可能被网关、代理或安全设备改写。",
            Some(format!("{e}；响应开头：{}", body_snippet(&body))),
        )
    })
}

fn network_error(error: impl std::fmt::Display) -> AppError {
    self::error(
        "NETWORK_ERROR",
        "网络请求失败，请检查地址、代理和网络连接。",
        Some(error.to_string()),
    )
}
fn xlsx_error(error: impl std::fmt::Display) -> AppError {
    self::error(
        "AUDIPICK_EXPORT_FAILED",
        "AudiPick 底稿导出失败。",
        Some(error.to_string()),
    )
}
fn error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// An empty assistant message must surface as an error rather than as a
    /// successful extraction of nothing.
    #[test]
    fn empty_content_names_the_reason() {
        let value = json!({"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"abc"}}]});
        let error = empty_content_error(&value);
        let text = serde_json::to_string(&error).unwrap();
        assert!(text.contains("EMPTY_ASSISTANT_CONTENT"), "{text}");
        assert!(text.contains("finish_reason=length"), "{text}");
        assert!(text.contains("输出额度已用尽"), "{text}");
    }

    #[test]
    fn empty_content_without_diagnostics_still_explains_itself() {
        let error = empty_content_error(&json!({"choices":[{"message":{"content":""}}]}));
        let text = serde_json::to_string(&error).unwrap();
        assert!(text.contains("模型返回正文为空"), "{text}");
    }

    #[test]
    fn parses_fenced_json() {
        assert_eq!(
            parse_json_content("```json\n{\"items\":[{\"a\":1}]}\n```")["items"][0]["a"],
            1
        );
    }
    #[test]
    fn 卫生过滤对三种输出结构一视同仁() {
        // 汇兑损益输出 changes，看账与正负数标记输出 fills／reviews。
        // 结构不同、纪律相同，此前看账那条链路只有冲突词一条规则。
        let payload = json!({
            "headers": ["会计科目", "科目文本", "预算二级科目描述", "本位币金额"],
            "currentMapping": {"accountCode": "会计科目", "accountName": "科目文本"},
        });
        let mut value = json!({
            "fills": [
                // 冲突词否定：预算科目不是科目名称，实测踩过的坑。
                {"role": "accountName", "currentColumn": "", "suggestedColumn": "预算二级科目描述",
                 "confidence": 0.9, "reason": "看着像科目描述"},
                // 正常补充：本位币金额此前未映射。
                {"role": "functionalAmount", "currentColumn": "", "suggestedColumn": "本位币金额",
                 "confidence": 0.9, "reason": "净额列"},
            ],
            "reviews": [
                // 复述现状：与 currentMapping 相同，没有可执行内容。
                {"role": "accountCode", "currentColumn": "会计科目", "suggestedColumn": "会计科目",
                 "confidence": 0.95, "reason": "确认正确"},
                // 抢已占用的列：科目文本已归 accountName。
                {"role": "summary", "currentColumn": "", "suggestedColumn": "科目文本",
                 "confidence": 0.9, "reason": "当摘要用"},
            ],
        });
        sanitize_mapping_changes(&mut value, &payload, "je");
        let fills = value["fills"].as_array().expect("fills 还在");
        assert_eq!(fills.len(), 1, "{fills:?}");
        assert_eq!(fills[0]["suggestedColumn"], "本位币金额");
        assert!(
            value["reviews"]
                .as_array()
                .expect("reviews 还在")
                .is_empty()
        );
    }

    #[test]
    fn 形态已完整成立时把结论告诉模型() {
        // 「序时账-1」的真实映射：方向 ＋ 金额，脚本判定 JE2 完整成立。
        // 不告诉模型这一点，它就会盯着「金额列全是正数」自由发挥，
        // 建议改指到旁边那列客户自己用公式算出来的「借正贷负」。
        let mut payload = json!({
            "headers": ["方向", "金额", "借正贷负"],
            "currentMapping": {
                "direction": "方向",
                "functionalAmount": "金额",
                "id": "凭证号数",
                "accountCode": "科目编码",
            },
        });
        inject_current_form(&mut payload, "je");
        let form = &payload["currentForm"];
        assert_eq!(form["id"], "JE2");
        assert_eq!(form["complete"], true);
        assert!(
            form["missingSlots"]
                .as_array()
                .expect("有该字段")
                .is_empty()
        );
    }

    #[test]
    fn 形态没凑齐时点名缺哪个槽() {
        // 只映射了净额、没有方向列也不是借贷分列——JE3 本该成立，
        // 但这里连净额都没给，脚本要能说清差在哪，模型才知道该补什么。
        let mut payload = json!({
            "headers": ["借方金额", "贷方金额"],
            "currentMapping": {"functionalDebit": "借方金额"},
        });
        inject_current_form(&mut payload, "je");
        let form = &payload["currentForm"];
        assert_eq!(form["complete"], false);
        let missing = form["missingSlots"].as_array().expect("有该字段");
        assert!(!missing.is_empty(), "{form}");
    }

    #[test]
    fn 复核建议把方向指给过账代码时按取值拦下() {
        // 03 号样例实测：模型把「过账代码」（取值 40/50）指给借贷方向。
        // 列名冲突词拦一道，样例取值再拦一道——取值不是 S/H、借/贷这类
        // 方向标志的列不能放行。取值真像方向列时不能误伤。
        let headers = [
            "凭证编号",
            "过账代码",
            "借贷标志",
            "本币",
            "总账科目",
            "会计科目",
        ];
        let sample = [
            [
                "6000000028",
                "50",
                "S",
                "CNY",
                "1001010000",
                "库存现金-人民币",
            ],
            [
                "6000000029",
                "50",
                "H",
                "CNY",
                "1001010000",
                "库存现金-人民币",
            ],
            [
                "6000000037",
                "40",
                "S",
                "CNY",
                "1001010000",
                "库存现金-人民币",
            ],
        ];
        let payload = json!({
            "headers": headers,
            "currentMapping": {"accountCode": "总账科目", "accountName": "会计科目", "functionalCurrency": "本币"},
            "sampleRows": sample,
        });
        let mut review = json!({"changes": [
            {"role":"direction","currentColumn":"","suggestedColumn":"过账代码","confidence":0.9,"reason":"40为借50为贷"},
            {"role":"direction","currentColumn":"","suggestedColumn":"借贷标志","confidence":0.9,"reason":"S/H即借贷"},
            {"role":"currency","currentColumn":"","suggestedColumn":"本币","confidence":0.9,"reason":"整列CNY即本位币"},
        ]});
        sanitize_change_list(&mut review, &payload, "je", "changes");
        let changes = review["changes"].as_array().expect("changes");
        assert_eq!(
            changes.len(),
            1,
            "过账代码与被占用的本币列都要拦：{review:#}"
        );
        assert_eq!(changes[0]["suggestedColumn"], "借贷标志");
    }

    #[test]
    fn 复核建议允许科目编码与名称共用混写列() {
        // 03 号样例实测：科目编码与名称混写在一格，脚本已把该列挂到
        // accountCode；模型建议 accountName 也指同一列时，按「一列一语义」
        // 会误拦——这列本该两个角色共用。
        let combined = "项目编码、文本/科目编码、文本";
        let payload = json!({
            "headers": [combined, "货币", "期初", "借方发生", "贷方发生", "期末余额"],
            "currentMapping": {"accountCode": combined},
            "sampleRows": [
                ["1001/库存现金", "CNY", "984.3", "76361.92", "-77346.22", "-984.3"],
                ["1001010000:库存现金-人民币", "CNY", "984.3", "76361.92", "-77346.22", "-984.3"],
                ["1002/银行存款", "CNY", "22222745.07", "2441878816.3", "-2450603520.07", "-8724703.77"],
                ["1002101001:银行存款-建行新乡", "CNY", "14075.88", "493160280.87", "-493132095.14", "28185.73"],
            ],
        });
        let mut review = json!({"changes": [
            {"role":"accountName","currentColumn":"","suggestedColumn":combined,"confidence":0.9,"reason":"编码与名称混写"}
        ]});
        sanitize_change_list(&mut review, &payload, "tb", "changes");
        let changes = review["changes"].as_array().expect("changes");
        assert_eq!(
            changes.len(),
            1,
            "混写列上编码与名称共列不算冲突：{review:#}"
        );
    }

    #[test]
    fn 一个角色都没映射时不注入形态() {
        // 刚读进文件、还没开始映射，报一个"最接近某型"只会误导模型。
        let mut payload = json!({"headers": ["A"], "currentMapping": {}});
        inject_current_form(&mut payload, "je");
        assert!(payload.get("currentForm").is_none());
    }

    #[test]
    fn 看账复核用共用纪律而不是自带一份() {
        let prompt = kanzhang_mapping_prompt();
        // 纪律整段取自共用的两份，不再自带——改一处，五个工具同时生效。
        // 此前看账那份是库里第三份抄本，措辞与汇兑损益的两份各不相同。
        assert!(prompt.contains(REVIEW_COMMON), "{prompt}");
        assert!(prompt.contains(REVIEW_JE), "{prompt}");
        // entity 认成交易对手方是实测里模型最常犯的一条，确认纪律确实带到了。
        assert!(prompt.contains("绝不是交易对手方"), "{prompt}");
        assert!(prompt.contains("空缺"), "{prompt}");
        // 只有输出结构与金额方案的表述是本工具自己的。
        assert!(prompt.contains("fills"), "{prompt}");
        assert!(prompt.contains("方案A"), "{prompt}");
    }
    #[test]
    fn rejects_missing_ocr_image() {
        assert_eq!(
            ocr(&json!({}), &json!({})).unwrap_err().code,
            "OCR_IMAGE_REQUIRED"
        );
    }
    #[test]
    fn llm_connection_test_validates_url_before_network() {
        let error = test_llm_connection(
            &json!({
                "api_type": "openai",
                "base_url": "ftp://invalid.example",
                "model": "test-model",
                "timeout": 10
            }),
            Some("temporary-test-key"),
        )
        .unwrap_err();
        assert_eq!(error.code, "LLM_URL_INVALID");
    }

    #[test]
    fn deepseek_json_mode_requires_a_structured_prompt_and_adds_lowercase_keyword() {
        let base = "https://api.deepseek.com";
        assert!(json_response_prompt(base, "这是连接测试。请只回复 OK。").is_none());

        let prompt = json_response_prompt(base, "只输出严格 JSON：{\"ok\":true}")
            .expect("结构化任务应启用 JSON 输出模式");
        assert!(prompt.contains("json"), "{prompt}");
        assert!(prompt.contains("有效的 json 对象"), "{prompt}");

        assert!(
            json_response_prompt("https://example.com/v1", "只输出严格 JSON").is_none(),
            "未知兼容端点不得贸然发送 response_format"
        );
    }
    #[test]
    fn batch_keeps_per_document_failures() {
        let cancel = Arc::new(AtomicBool::new(false));
        let result = run_batch(
            json!({
                "__settings":{"llm":{"enabled":false}},
                "prompt":"【字段定义】\npage: 页码",
                "ruleId":"loan_covenant",
                "documents":[{"id":"d1","name":"missing.pdf","textPath":"Z:/definitely-missing-audipick.txt"}]
            }),
            &|_, _, _, _| {},
            cancel,
            Path::new("Z:/definitely-missing-audipick.pause"),
        ).unwrap();
        assert_eq!(result["completed"], 1);
        assert_eq!(result["documents"][0]["ok"], false);
        assert_eq!(
            result["documents"][0]["error"]["code"],
            "AUDIPICK_TEXT_MISSING"
        );
    }
}

#[cfg(test)]
mod mapping_prompt_tests {
    use super::*;

    #[test]
    fn 各工具账表分类提示词保持独立业务口径() {
        let fx = ledger_source_classification_prompt("fx");
        let deposit = ledger_source_classification_prompt("deposit_interest");
        let fa = ledger_source_classification_prompt("fa_tbje");
        assert!(fx.contains("汇兑损益") && fx.contains("原币金额"));
        assert!(deposit.contains("存款利息") && deposit.contains("银行账户"));
        assert!(fa.contains("固定资产") && fa.contains("累计折旧"));
        assert_ne!(fx, deposit);
        assert_ne!(deposit, fa);
        assert_ne!(fa, fx);
    }

    /// 两张表的复核提示词必须各管各的。
    ///
    /// 拆开之前是一整段同时讲 TB 与 JE，复核任一张表都要读另一张表的规矩——
    /// 序时账的凭证类型、余额表的期初期末混在一起，既是干扰也容易串用角色。
    #[test]
    fn 两段提示词互不掺杂() {
        assert!(
            !REVIEW_JE.contains("期初") && !REVIEW_JE.contains("本年累计"),
            "序时账段不该出现余额表的期初期末与本年累计"
        );
        assert!(
            !REVIEW_TB.contains("voucherType") && !REVIEW_TB.contains("凭证键"),
            "余额表段不该出现序时账的凭证类型与凭证键"
        );
    }

    /// 共同段只放对两张表都成立的纪律，别把某一张表的规则漏写进去。
    #[test]
    fn 共同段不含任一表的专属规则() {
        for word in [
            "期初",
            "期末",
            "凭证类型",
            "本年累计",
            "hardcodedCandidates",
        ] {
            assert!(
                !REVIEW_COMMON.contains(word),
                "共同段出现了专属规则「{word}」，应移到对应的分段里"
            );
        }
    }

    /// 角色名必须和统一映射内核对得上——提示词里写了内核没有的角色，
    /// 模型提出来的建议下游就落不了地。
    #[test]
    fn 提示词里的角色名都真实存在() {
        for (kind, text) in [("je", REVIEW_JE), ("tb", REVIEW_TB)] {
            for word in text.split(|c: char| !c.is_ascii_alphanumeric()) {
                // 驼峰英文单词才可能是角色名；中文与短词跳过。
                if word.len() < 6 || !word.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
                    continue;
                }
                if !word.chars().any(|c| c.is_ascii_uppercase()) {
                    continue;
                }
                assert!(
                    crate::ledger_mapping::role_of(kind, word).is_some()
                        || matches!(
                            word,
                            "currentMapping" | "sampleRows" | "hardcodedCandidates"
                        ),
                    "{kind} 提示词里的「{word}」不是内核里的角色名"
                );
            }
        }
    }

    /// 复核结果的卫生过滤是前端应用建议前的最后一道闸，
    /// 每条丢弃规则都对应真实样本里见过的模型行为。
    #[test]
    fn 复核建议的卫生过滤() {
        let payload = json!({
            "headers": ["科目编码", "科目名称", "币种", "方向"],
        });
        let mut value = json!({
            "task": "fx_tb_mapping",
            "changes": [
                // 正常建议：保留。
                {"role": "currency", "currentColumn": "", "suggestedColumn": "币种",
                 "confidence": 0.9, "reason": "多币种取值", "scheme": ""},
                // 复述现状：reason 在确认而不是变更，丢弃。
                {"role": "currency", "currentColumn": "币种", "suggestedColumn": "币种",
                 "confidence": 0.95, "reason": "该列是原币币种列", "scheme": ""},
                // 虚构列名：表里没有，丢弃。
                {"role": "accountCode", "currentColumn": "", "suggestedColumn": "科目代码",
                 "confidence": 0.8, "reason": "应为编码", "scheme": ""},
                // 零置信：模型自己都不信，丢弃。
                {"role": "functionalCurrency", "currentColumn": "", "suggestedColumn": "科目编码",
                 "confidence": 0.0, "reason": "没有本位币列", "scheme": ""},
                // 与第三条同列的重复建议：一列一个语义，丢弃。
                {"role": "accountName", "currentColumn": "", "suggestedColumn": "科目名称",
                 "confidence": 0.7, "reason": "名称", "scheme": ""},
                {"role": "closingDirection", "currentColumn": "", "suggestedColumn": "科目名称",
                 "confidence": 0.7, "reason": "重复占列", "scheme": ""},
            ],
        });
        sanitize_mapping_changes(&mut value, &payload, "tb");
        let changes = value["changes"].as_array().unwrap();
        // 留下 currency→币种 与 accountName→科目名称；同列的 closingDirection
        // 在 accountName 之后出现，被"一列一次"规则丢弃。
        let kept: Vec<(String, String)> = changes
            .iter()
            .map(|change| {
                (
                    change["role"].as_str().unwrap_or("").to_owned(),
                    change["suggestedColumn"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect();
        assert_eq!(
            kept,
            vec![
                ("currency".to_owned(), "币种".to_owned()),
                ("accountName".to_owned(), "科目名称".to_owned()),
            ],
            "{changes:?}"
        );
    }

    /// headers 缺失（异常调用）时只做不依赖列名单的过滤，别把整包结果清空。
    #[test]
    fn 复核建议过滤在没有表头时仍保守() {
        let mut value = json!({
            "changes": [
                {"role": "currency", "currentColumn": "旧列", "suggestedColumn": "新列",
                 "confidence": 0.9, "reason": "", "scheme": ""},
                {"role": "currency", "currentColumn": "同列", "suggestedColumn": "同列",
                 "confidence": 0.9, "reason": "", "scheme": ""},
            ],
        });
        sanitize_mapping_changes(&mut value, &json!({}), "tb");
        assert_eq!(value["changes"].as_array().unwrap().len(), 1);
    }

    /// 拿真实复核最常见的坑当样例：模型给空缺角色硬塞已被占用的列。
    /// 三轮实测里 functionalCurrency←币种列、entity←往来列全是这个形态。
    #[test]
    fn 复核建议不抢已占用的列() {
        let payload = json!({
            "headers": ["科目编码", "科目名称", "币种", "往來單位"],
            "currentMapping": {
                "accountCode": "科目编码",
                "accountName": "科目名称",
                "currency": "币种",
                "auxiliary": "往來單位",
            },
        });
        let mut value = json!({
            "changes": [
                // 硬凑空缺：currency 已占币种列，functionalCurrency 再指过去=一列两角色。
                {"role": "functionalCurrency", "currentColumn": "", "suggestedColumn": "币种",
                 "confidence": 0.95, "reason": "整列同值", "scheme": ""},
                // 幻觉抢列：往來單位明明是 auxiliary，却说它是 entity。
                {"role": "entity", "currentColumn": "", "suggestedColumn": "往來單位",
                 "confidence": 0.9, "reason": "counterparty names", "scheme": ""},
                // 半截改指：想给 accountCode 换列，但没人把占用者挪走。
                {"role": "accountName", "currentColumn": "科目名称", "suggestedColumn": "科目编码",
                 "confidence": 0.8, "reason": "", "scheme": ""},
            ],
        });
        sanitize_mapping_changes(&mut value, &payload, "tb");
        assert!(
            value["changes"].as_array().unwrap().is_empty(),
            "三条都该拦：{value:?}"
        );
    }

    /// TB-3300 实测场景：currency 角色空缺、functionalCurrency 已占货币列，
    /// 模型 reason 判对了货币列性质，却成对输出"currency 补货币列 +
    /// functionalCurrency 从货币列挪去(空)"——两条都是同一句确认的拧巴
    /// 表达，挪去空列不是挪移，构不成配套，两条都得拦。
    #[test]
    fn 复核建议不硬凑反向币种角色() {
        let payload = json!({
            "headers": ["科目代码", "货币", "文本"],
            "currentMapping": {
                "accountCode": "科目代码",
                "functionalCurrency": "货币",
                "currencyText": "文本",
            },
        });
        let mut value = json!({
            "changes": [
                {"role": "currency", "currentColumn": "", "suggestedColumn": "货币",
                 "confidence": 0.95, "reason": "符合本位币列特征",
                 "scheme": "将货币列从currency改为functionalCurrency"},
                {"role": "functionalCurrency", "currentColumn": "货币", "suggestedColumn": "",
                 "confidence": 0.95, "reason": "符合本位币列特征", "scheme": ""},
                {"role": "currencyText", "currentColumn": "文本", "suggestedColumn": "文本",
                 "confidence": 0.9, "reason": "保留文本列映射为currencyText", "scheme": ""},
            ],
        });
        sanitize_mapping_changes(&mut value, &payload, "tb");
        assert!(
            value["changes"].as_array().unwrap().is_empty(),
            "货币列已被 functionalCurrency 占用：{value:?}"
        );
    }

    /// 09 实测场景：reason 明说"暂不映射"，change 却仍把该列映射上去。
    #[test]
    fn 复核建议reason否定即弃() {
        let payload = json!({
            "headers": ["凭证号", "制单人"],
            "currentMapping": {"id": "凭证号"},
        });
        let mut value = json!({
            "changes": [
                {"role": "entity", "currentColumn": "", "suggestedColumn": "制单人",
                 "confidence": 0.6, "reason": "制单人列为操作员姓名，无其他主体列，暂不映射",
                 "scheme": ""},
            ],
        });
        sanitize_mapping_changes(&mut value, &payload, "tb");
        assert!(value["changes"].as_array().unwrap().is_empty(), "{value:?}");
    }

    /// 成对挪移是合法修复：占用者同时被挪走时，改指应当放行。
    /// 模型谎报 currentColumn（把已有映射报成空）也要靠 currentMapping 拦住。
    #[test]
    fn 复核建议放行成对挪移并识破谎报现状() {
        let payload = json!({
            "headers": ["科目编码", "科目名称", "科目描述"],
            "currentMapping": {
                "accountCode": "科目名称",   // coding 判反了
                "accountName": "",
            },
        });
        let mut value = json!({
            "changes": [
                // 谎报现状：模型把已有映射报成空，建议仍是现行列。
                // 排在最前，确保拦它的是 currentMapping 对照而非同列去重。
                {"role": "accountCode", "currentColumn": "", "suggestedColumn": "科目名称",
                 "confidence": 0.95, "reason": "紧邻期初余额", "scheme": ""},
                // 修复链：accountCode 挪去科目编码，accountName 补上科目名称。
                {"role": "accountCode", "currentColumn": "科目名称", "suggestedColumn": "科目编码",
                 "confidence": 0.9, "reason": "", "scheme": ""},
                {"role": "accountName", "currentColumn": "", "suggestedColumn": "科目名称",
                 "confidence": 0.9, "reason": "", "scheme": ""},
            ],
        });
        sanitize_mapping_changes(&mut value, &payload, "tb");
        let changes = value["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 2, "只留成对挪移的两条：{changes:?}");
        assert!(
            changes.iter().all(
                |change| change["suggestedColumn"].as_str() != Some("科目名称")
                    || change["role"].as_str() == Some("accountName")
            )
        );
    }
}
