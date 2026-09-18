//! TBJE 完整性核对的回归测试。
//!
//! 三条核对的样例都照着真实账的形态构造：余额已带符号、父子科目混排、
//! 序时账里混着合计行——这些都是十套实测样例里真实存在的写法。

use super::*;
use serde_json::json;
use std::sync::atomic::AtomicBool;

#[test]
fn 主体归集只改写用户勾选的一侧匹配键() {
    let table = FxTable {
        path: std::path::PathBuf::new(),
        sheet: "Sheet1".into(),
        sheets: vec!["Sheet1".into()],
        header_row: 1,
        header_depth: 1,
        raw_headers: vec![],
        headers: vec!["主体".into(), "科目编码".into(), "科目名称".into()],
        rows: vec![vec![
            "浙江沪杭甬高速公路股份有限公司杭州管理处".into(),
            "1001".into(),
            "库存现金".into(),
        ]],
        row_count: 1,
        header_candidates: vec![],
        sampled: false,
    };
    let map = serde_json::from_value::<Map<String, Value>>(json!({
        "entity": "主体", "accountCode": "科目编码", "accountName": "科目名称"
    }))
    .unwrap();
    let scope: ledger_mapping::EntityScope = serde_json::from_value(json!({
        "mode": "aggregate",
        "mappings": [{
            "side": "tb",
            "source": "浙江沪杭甬高速公路股份有限公司杭州管理处",
            "target": "浙江沪杭甬高速公路股份有限公司"
        }]
    }))
    .unwrap();

    assert_eq!(
        scoped_identity_parts(
            &table,
            &table.rows[0],
            &map,
            ledger_mapping::DEFAULT_ENTITY,
            ledger_mapping::EntitySide::Tb,
            &scope,
        )
        .0,
        "浙江沪杭甬高速公路股份有限公司"
    );
    assert_eq!(
        scoped_identity_parts(
            &table,
            &table.rows[0],
            &map,
            ledger_mapping::DEFAULT_ENTITY,
            ledger_mapping::EntitySide::Je,
            &scope,
        )
        .0,
        "浙江沪杭甬高速公路股份有限公司杭州管理处",
        "TB 的选择不得误改 JE 主体"
    );
}

fn fixture(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tbje-check-{}-{}", std::process::id(), name));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn tb_mapping() -> Value {
    json!({
        "accountCode": "科目编码",
        "accountName": "科目名称",
        "openingFunctionalAmount": "期初余额",
        "ytdFunctionalDebit": "本年借方",
        "ytdFunctionalCredit": "本年贷方",
        "closingFunctionalAmount": "期末余额",
    })
}

fn je_mapping() -> Value {
    json!({
        "id": "凭证号",
        "date": "日期",
        "accountCode": "科目编码",
        "accountName": "科目名称",
        "functionalDebit": "借方",
        "functionalCredit": "贷方",
    })
}

fn params(dir: &std::path::Path, with_je: bool) -> Value {
    let mut value = json!({
        "tbSource": {"inputPath": dir.join("tb.csv"), "sheet": "", "headerRow": 0, "headerDepth": 0},
        "tbMapping": tb_mapping(),
    });
    if with_je {
        value["jeSource"] =
            json!({"inputPath": dir.join("je.csv"), "sheet": "", "headerRow": 0, "headerDepth": 0});
        value["jeMapping"] = je_mapping();
    }
    value
}

/// 一套自洽的账：勾稽成立、恒等式成立、TB 与 JE 完全对得上。
fn 平的账(dir: &std::path::Path) {
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,100,500,300,300\n\
         2202,应付账款,-100,300,500,-300\n\
         ,资产负债汇总,0,800,800,0\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,应付账款,0,500\n\
         2025-06-01,V2,2202,应付账款,300,0\n\
         2025-06-01,V2,1001,库存现金,0,300\n",
    )
    .unwrap();
}

#[test]
fn 三条核对都通过时不报任何差异() {
    let dir = fixture("clean");
    平的账(&dir);
    let result = run(&params(&dir, true), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["rollforward"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["equation"]["passed"], json!(true), "{result:#}");
    assert_eq!(
        result["equation"]["opening"]["total"].as_f64().unwrap(),
        0.0
    );
    assert_eq!(
        result["equation"]["closing"]["total"].as_f64().unwrap(),
        0.0
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn tb缺少科目编码时按双侧唯一科目名称严格回退() {
    let dir = fixture("validated-name-fallback");
    std::fs::write(
        dir.join("tb.csv"),
        "科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         库存现金,100,500,300,300\n\
         应付账款,-100,300,500,-300\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,应付账款,0,500\n\
         2025-06-01,V2,2202,应付账款,300,0\n\
         2025-06-01,V2,1001,库存现金,0,300\n",
    )
    .unwrap();
    let mut input = params(&dir, true);
    input["tbMapping"]
        .as_object_mut()
        .unwrap()
        .remove("accountCode");
    let result = run(&input, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["performed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(
        result["tbVsJe"]["accountMatchMode"],
        json!("validatedNameFallback")
    );
    assert_eq!(result["tbVsJe"]["validatedNameFallbackAccounts"], json!(2));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 科目名称不能唯一对应时拒绝无编码回退() {
    let dir = fixture("rejected-name-fallback");
    std::fs::write(
        dir.join("tb.csv"),
        "科目名称,期初余额,本年借方,本年贷方,期末余额\n库存现金,0,100,0,100\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,50,0\n\
         2025-03-01,V2,1002,库存现金,50,0\n",
    )
    .unwrap();
    let mut input = params(&dir, true);
    input["tbMapping"]
        .as_object_mut()
        .unwrap()
        .remove("accountCode");
    let result = run(&input, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["performed"], json!(false), "{result:#}");
    assert!(
        result["tbVsJe"]["reason"]
            .as_str()
            .is_some_and(|text| text.contains("无法安全按科目名称回退匹配"))
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 定长tb修正同时作用于发生额与bspl勾稽() {
    let dir = fixture("fixed-width-leaf-shared");
    // 费用科目按核算维度拆成 5 行，200 恰好等于后面的 50 + 150。
    // 公共末级行规则应保留全部 5 行，总借方/期末均为 700；负债行把
    // 期末配平，用来证明 BS 与 PL 勾稽读取的是同一份修正后行集合。
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         6601000000,职工薪酬-A,0,150,0,150\n\
         6601000000,职工薪酬-B,0,200,0,200\n\
         6601000000,职工薪酬-C,0,50,0,50\n\
         6601000000,职工薪酬-D,0,150,0,150\n\
         6601000000,职工薪酬-E,0,150,0,150\n\
         2202000000,应付账款,0,0,700,-700\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,6601000000,职工薪酬,700,0\n\
         2025-03-01,V1,2202000000,应付账款,0,700\n",
    )
    .unwrap();

    let result = run(&params(&dir, true), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["rollforward"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["accounts"], json!(2), "{result:#}");
    assert_eq!(result["equation"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["equation"]["accounts"], json!(6), "{result:#}");
    assert_eq!(
        result["equation"]["closing"]["total"].as_f64().unwrap(),
        0.0,
        "{result:#}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 未分类科目有可靠符号时纳入恒等式总额但分类仍待补充() {
    let dir = fixture("equation-unclassified-signed");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,100,0,0,100\n\
         AAVX001360,结算待支付,-100,0,0,-100\n",
    )
    .unwrap();

    let result = run(&params(&dir, false), &AtomicBool::new(false)).unwrap();
    let equation = &result["equation"];
    assert_eq!(equation["passed"], json!(true), "{result:#}");
    assert_eq!(equation["balancePassed"], json!(true), "{result:#}");
    assert_eq!(equation["coverageComplete"], json!(true), "{result:#}");
    assert_eq!(
        equation["classificationComplete"],
        json!(false),
        "{result:#}"
    );
    assert_eq!(equation["accounts"], json!(2), "{result:#}");
    assert_eq!(equation["classifiedAccounts"], json!(1), "{result:#}");
    assert_eq!(equation["unclassifiedAccounts"], json!(1), "{result:#}");
    assert_eq!(equation["opening"]["total"], json!(0.0), "{result:#}");
    assert_eq!(equation["closing"]["total"], json!(0.0), "{result:#}");
    assert_eq!(
        equation["opening"]["byCategory"][0]["amount"],
        json!(100.0),
        "分类小计只用于解释，不能把未分类余额塞进任一类别：{result:#}"
    );
    assert_eq!(equation["unclassified"][0]["openingIncluded"], json!(true));
    assert_eq!(equation["unclassified"][0]["closingIncluded"], json!(true));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 单列全正且无方向时恒等式返回覆盖不足而非金额不平() {
    let dir = fixture("equation-unsigned-ambiguous");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,100,0,0,100\n\
         AAVX001360,结算待支付,100,0,0,100\n",
    )
    .unwrap();

    let result = run(&params(&dir, false), &AtomicBool::new(false)).unwrap();
    let equation = &result["equation"];
    assert!(equation["performed"].as_bool().unwrap(), "{result:#}");
    assert_eq!(equation["coverageComplete"], json!(false), "{result:#}");
    assert_eq!(equation["conclusive"], json!(false), "{result:#}");
    assert!(equation["passed"].is_null(), "{result:#}");
    assert!(equation["balancePassed"].is_null(), "{result:#}");
    assert!(equation["opening"]["balanced"].is_null(), "{result:#}");
    assert!(equation["closing"]["balanced"].is_null(), "{result:#}");
    assert_eq!(equation["ambiguousAccounts"], json!(2), "{result:#}");
    assert_eq!(equation["opening"]["includedAccounts"], json!(0));
    assert_eq!(equation["opening"]["ambiguousAccounts"], json!(2));
    assert!(
        equation["reason"]
            .as_str()
            .unwrap()
            .contains("无法完整执行")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 单列全正但逐行方向完整时未分类科目照常参与恒等式() {
    let dir = fixture("equation-direction-column");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初方向,期初余额,本年借方,本年贷方,期末方向,期末余额\n\
         1001,库存现金,借,100,0,0,借,100\n\
         AAVX001360,结算待支付,贷,100,0,0,贷,100\n",
    )
    .unwrap();
    let mut input = params(&dir, false);
    input["tbMapping"]["openingDirection"] = json!("期初方向");
    input["tbMapping"]["closingDirection"] = json!("期末方向");

    let result = run(&input, &AtomicBool::new(false)).unwrap();
    let equation = &result["equation"];
    assert_eq!(equation["passed"], json!(true), "{result:#}");
    assert_eq!(equation["coverageComplete"], json!(true), "{result:#}");
    assert_eq!(
        equation["classificationComplete"],
        json!(false),
        "{result:#}"
    );
    assert_eq!(equation["opening"]["total"], json!(0.0), "{result:#}");
    assert_eq!(equation["closing"]["total"], json!(0.0), "{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 方向列个别非零行为空时只把该行标为无法判断() {
    let dir = fixture("equation-partial-direction");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初方向,期初余额,本年借方,本年贷方,期末方向,期末余额\n\
         1001,库存现金,借,100,0,0,借,100\n\
         AAVX001360,结算待支付,,100,0,0,,100\n",
    )
    .unwrap();
    let mut input = params(&dir, false);
    input["tbMapping"]["openingDirection"] = json!("期初方向");
    input["tbMapping"]["closingDirection"] = json!("期末方向");

    let result = run(&input, &AtomicBool::new(false)).unwrap();
    let equation = &result["equation"];
    assert_eq!(equation["coverageComplete"], json!(false), "{result:#}");
    assert_eq!(equation["ambiguousAccounts"], json!(1), "{result:#}");
    assert_eq!(equation["opening"]["includedAccounts"], json!(1));
    assert_eq!(equation["opening"]["ambiguousAccounts"], json!(1));
    assert_eq!(equation["ambiguous"][0]["code"], json!("AAVX001360"));
    assert_eq!(equation["ambiguous"][0]["openingBasis"], json!("ambiguous"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 分段明细账由公共引擎补全后进入tbje核对() {
    let dir = fixture("sectioned-ledger");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,100,500,300,300\n\
         2202,应付账款,-100,300,500,-300\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,摘要,借方,贷方\n\
         ,,1001,库存现金,期初余额,0,0\n\
         2025-03-01,V1,,,收款,500,0\n\
         2025-03-31,,,,本月合计,500,0\n\
         2025-06-01,V2,,,付款,0,300\n\
         ,,2202,应付账款,期初余额,0,0\n\
         2025-03-01,V1,,,采购,0,500\n\
         2025-03-31,,,,本年累计,0,500\n\
         2025-06-01,V2,,,还款,300,0\n",
    )
    .unwrap();
    let mut input = params(&dir, true);
    input["jeMapping"]["summary"] = json!("摘要");
    let result = run(&input, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["accounts"], json!(2), "{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
#[ignore = "需要通过 LEDGER_SAMPLES 指定本机 TBJE 样例目录"]
fn 一至三月真实分段明细账进入完整性核对() {
    let root = std::path::PathBuf::from(
        std::env::var("LEDGER_SAMPLES").expect("请设置 LEDGER_SAMPLES 为 TBJE 样例目录"),
    );
    let input = json!({
        "tbSource": {
            "inputPath": root.join("2025 1-3月余额表.xlsx"),
            "sheet": "Sheet1", "headerRow": 11, "headerDepth": 1
        },
        "jeSource": {
            "inputPath": root.join("2025 1-3月明细账.xlsx"),
            "sheet": "Sheet1", "headerRow": 5, "headerDepth": 1
        },
        "tbMapping": {
            "accountCode": "帐号", "accountName": ["账号描述"],
            "openingFunctionalAmount": "(FP)-LC1",
            "ytdFunctionalDebit": "借方余额-LC1",
            "ytdFunctionalCredit": "贷方余额-LC1",
            "closingFunctionalAmount": "累计差额-LC1",
            "currency": "交易货币", "functionalCurrency": "LC1货币"
        },
        "jeMapping": {
            "accountCode": "总账科目", "accountName": ["科目名称"],
            "date": "过账日期", "id": ["凭证编号"], "summary": "摘要",
            "entity": "公司", "direction": "方向",
            "functionalDebit": "借方/本币", "functionalCredit": "贷方/本币",
            "currency": "外币", "functionalCurrency": "本币"
        }
    });
    let je_spec: SourceSpec = serde_json::from_value(input["jeSource"].clone()).unwrap();
    let raw_je = load_fx_table(&je_spec).unwrap();
    let je_map = mapping_of(&input, "jeMapping");
    assert!(
        ledger_mapping::is_sectioned_ledger(&raw_je.headers, &raw_je.rows, &|role| {
            fx::mapped_cols(&je_map, role)
        }),
        "headers={:?}",
        raw_je.headers
    );
    let prepared = prepare(&input).unwrap();
    assert_eq!(prepared.je.as_ref().unwrap().table.rows.len(), 12_265);
    let result = evaluate(&prepared, &AtomicBool::new(false), true).unwrap();
    assert_eq!(result["tbVsJe"]["mismatched"], json!(0), "{result:#}");
    assert_eq!(result["tbVsJe"]["accounts"], json!(234), "{result:#}");
    let items = result["tbVsJe"]["items"].as_array().unwrap();
    let maternity = items
        .iter()
        .find(|item| item["code"] == json!("8131002884"))
        .expect("结果中应包含 8131002884");
    assert_eq!(maternity["tbIncludedRows"], json!(5), "{maternity:#}");
    assert_eq!(maternity["tbDebit"], json!(700.0), "{maternity:#}");
    assert_eq!(maternity["jeDebit"], json!(700.0), "{maternity:#}");
    // BS/PL 必须同步使用同一份修正后的 leaf mask；旧口径只纳入 335 行，
    // 定长平级规则生效后应纳入 366 条可归类 TB 明细。
    assert_eq!(result["equation"]["accounts"], json!(366), "{result:#}");
    assert!(
        (result["equation"]["closing"]["total"].as_f64().unwrap() - (-26_524_503.44)).abs() < 0.01,
        "{result:#}"
    );
    let je_debit = items
        .iter()
        .map(|item| item["jeDebit"].as_f64().unwrap_or(0.0))
        .sum::<f64>();
    let je_credit = items
        .iter()
        .map(|item| item["jeCredit"].as_f64().unwrap_or(0.0))
        .sum::<f64>();
    assert!((je_debit - 946_205_700.78).abs() < 0.01, "{result:#}");
    assert!((je_credit - 946_205_700.78).abs() < 0.01, "{result:#}");
}

fn add_entity_mappings(value: &mut Value, both_sides: bool) {
    value["tbMapping"]["entity"] = json!("主体");
    if both_sides {
        value["jeMapping"]["entity"] = json!("主体");
    }
}

#[test]
fn 双侧映射主体后同科目不得跨主体抵销差异() {
    let dir = fixture("entity-key-both");
    std::fs::write(
        dir.join("tb.csv"),
        "主体,科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         A,1001,库存现金,0,100,0,100\n\
         B,1001,库存现金,0,200,0,200\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "主体,日期,凭证号,科目编码,科目名称,借方,贷方\n\
         A,2025-01-01,V1,1001,库存现金,200,0\n\
         B,2025-01-01,V2,1001,库存现金,100,0\n",
    )
    .unwrap();
    let mut input = params(&dir, true);
    add_entity_mappings(&mut input, true);
    let result = run(&input, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(false), "{result:#}");
    assert_eq!(result["tbVsJe"]["mismatched"], json!(2), "{result:#}");
    let entities = result["tbVsJe"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["entity"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(entities, ["A", "B"].into_iter().collect());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 单侧映射主体时双方统一归入默认主体() {
    let dir = fixture("entity-key-single-side");
    std::fs::write(
        dir.join("tb.csv"),
        "主体,科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         A,1001,库存现金,0,100,0,100\n\
         B,1001,库存现金,0,200,0,200\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-01-01,V1,1001,库存现金,300,0\n",
    )
    .unwrap();
    let mut input = params(&dir, true);
    add_entity_mappings(&mut input, false);
    let result = run(&input, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert!(
        result["mappingWarnings"][0]
            .as_str()
            .unwrap()
            .contains("默认主体")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 双侧主体空值按默认主体参与匹配() {
    let dir = fixture("entity-key-blank");
    std::fs::write(
        dir.join("tb.csv"),
        "主体,科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         ,1001,库存现金,0,100,0,100\n\
         A,1001,库存现金,0,200,0,200\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "主体,日期,凭证号,科目编码,科目名称,借方,贷方\n\
         ,2025-01-01,V1,1001,库存现金,100,0\n\
         A,2025-01-01,V2,1001,库存现金,200,0\n",
    )
    .unwrap();
    let mut input = params(&dir, true);
    add_entity_mappings(&mut input, true);
    let result = run(&input, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["accounts"], json!(2), "{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn tb科目编码名称混写而je分列时按拆分后的科目身份对齐() {
    let dir = fixture("combined-account-vs-split");
    std::fs::write(
        dir.join("tb.csv"),
        "科目,期初余额,本年借方,本年贷方,期末余额\n\
         1001:库存现金,100,500,300,300\n\
         2202/应付账款,-100,300,500,-300\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,应付账款,0,500\n\
         2025-06-01,V2,2202,应付账款,300,0\n\
         2025-06-01,V2,1001,库存现金,0,300\n",
    )
    .unwrap();

    let params = json!({
        "tbSource": {
            "inputPath": dir.join("tb.csv"),
            "sheet": "",
            "headerRow": 0,
            "headerDepth": 0
        },
        "tbMapping": {
            // 只有科目编码和科目名称允许共用一个物理列；下游必须分别拆出身份字段。
            "accountCode": "科目",
            "accountName": "科目",
            "openingFunctionalAmount": "期初余额",
            "ytdFunctionalDebit": "本年借方",
            "ytdFunctionalCredit": "本年贷方",
            "closingFunctionalAmount": "期末余额"
        },
        "jeSource": {
            "inputPath": dir.join("je.csv"),
            "sheet": "",
            "headerRow": 0,
            "headerDepth": 0
        },
        "jeMapping": je_mapping()
    });

    let result = run(&params, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["rollforward"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["accounts"], json!(2), "{result:#}");
    assert_eq!(result["tbVsJe"]["mismatched"], json!(0), "{result:#}");
    assert_eq!(result["equation"]["passed"], json!(true), "{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 期末余额被改动时勾稽报出那一行() {
    let dir = fixture("rollforward");
    平的账(&dir);
    // 把库存现金的期末改成 400——期初 100 ＋ 借 500 − 贷 300 应当是 300。
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,100,500,300,400\n\
         2202,应付账款,-100,300,500,-300\n",
    )
    .unwrap();
    let result = run(&params(&dir, false), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["rollforward"]["passed"], json!(false));
    assert_eq!(result["rollforward"]["mismatched"], json!(1));
    let item = &result["rollforward"]["units"][0]["items"][0];
    assert_eq!(item["difference"].as_f64().unwrap(), -100.0);
    assert!(item["account"].as_str().unwrap().contains("库存现金"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 借贷两侧分开比才抓得住双向虚增() {
    let dir = fixture("bothsides");
    平的账(&dir);
    // 序时账多记一笔一借一贷的对倒：净额没变，借贷两侧各多 1000。
    // 只比净额（期初＋JE净额＝期末）这一笔完全查不出来。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,应付账款,0,500\n\
         2025-06-01,V2,2202,应付账款,300,0\n\
         2025-06-01,V2,1001,库存现金,0,300\n\
         2025-09-01,V3,1001,库存现金,1000,0\n\
         2025-09-01,V3,1001,库存现金,0,1000\n",
    )
    .unwrap();
    let result = run(&params(&dir, true), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(false), "{result:#}");
    assert_eq!(result["tbVsJe"]["sidePassed"], json!(false));
    assert_eq!(result["tbVsJe"]["netPassed"], json!(true));
    assert_eq!(result["tbVsJe"]["netMismatched"], json!(0));
    let item = &result["tbVsJe"]["items"][0];
    assert_eq!(item["code"], json!("1001"));
    assert_eq!(item["debitDifference"].as_f64().unwrap(), -1000.0);
    assert_eq!(item["creditDifference"].as_f64().unwrap(), -1000.0);
    assert_eq!(item["tbNet"].as_f64().unwrap(), 200.0);
    assert_eq!(item["jeNet"].as_f64().unwrap(), 200.0);
    assert_eq!(item["netDifference"].as_f64().unwrap(), 0.0);
    assert_eq!(item["netPassed"], json!(true));
    assert_eq!(item["overallVerdict"], json!("净额通过，单边发生额有差异"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 合计行后的人手草稿不得拼出幻影科目() {
    // 10 号样例实测：序时账合计行下面被粘贴了一块无形资产摊销测算草稿，
    // 金额 2556.54 错位进了科目编码列，说明文字写在摘要/凭证号列。旧口径
    // 把这些行恢复进正文又向下填充补齐名称，凭空造出净差 5.5 亿的假科目。
    // 用 xlsx 构造（整行空白必须保留成行），与真实文件同一路径。
    let dir = fixture("tail-draft");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,0,500,300,200\n\
         2202,应付账款,0,300,500,-200\n",
    )
    .unwrap();
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name("Sheet1").unwrap();
    let header = [
        "日期",
        "凭证号",
        "摘要",
        "科目编码",
        "科目全名",
        "借方金额",
        "贷方金额",
    ];
    for (column, text) in header.iter().enumerate() {
        sheet.write(0, column as u16, *text).unwrap();
    }
    let real_rows: [[&str; 7]; 4] = [
        ["2025-03-01", "V1", "提现", "1001", "库存现金", "500", "0"],
        ["2025-03-01", "V1", "提现", "2202", "应付账款", "0", "500"],
        ["2025-06-01", "V2", "付款", "2202", "应付账款", "300", "0"],
        ["2025-06-01", "V2", "付款", "1001", "库存现金", "0", "300"],
    ];
    for (offset, row) in real_rows.iter().enumerate() {
        for (column, cell) in row.iter().enumerate() {
            sheet
                .write((offset + 1) as u32, column as u16, *cell)
                .unwrap();
        }
    }
    // 合计行之后两行整行空白，再进入草稿区——与 10 号样例同形。
    sheet.write(5, 0, "合计").unwrap();
    sheet.write(5, 5, 800).unwrap();
    sheet.write(5, 6, 800).unwrap();
    let draft_rows: [[&str; 7]; 4] = [
        ["", "账面摊销", "管理费用", "2556.54", "", "2556.54", ""],
        ["", "", "累计摊销", "", "2556.54", "", "276936736.69"],
        ["", "原调整冲回", "", "", "", "-276934180.15", ""],
        ["", "", "", "", "", "#REF!", ""],
    ];
    for (offset, row) in draft_rows.iter().enumerate() {
        for (column, cell) in row.iter().enumerate() {
            if !cell.is_empty() {
                sheet
                    .write((offset + 8) as u32, column as u16, *cell)
                    .unwrap();
            }
        }
    }
    workbook.save(dir.join("je.xlsx")).unwrap();
    let mut input = params(&dir, true);
    input["jeSource"]["inputPath"] = dir.join("je.xlsx").to_string_lossy().to_string().into();
    input["jeMapping"] = json!({
        "id": "凭证号",
        "date": "日期",
        "summary": "摘要",
        "accountCode": "科目编码",
        "accountName": "科目全名",
        "functionalDebit": "借方金额",
        "functionalCredit": "贷方金额",
    });
    let result = run(&input, &AtomicBool::new(false)).unwrap();
    let items = result["tbVsJe"]["items"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        items
            .iter()
            .all(|item| !item["code"].as_str().unwrap_or("").contains("2556")),
        "草稿金额不得成为科目：{result:#}"
    );
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["mismatched"], json!(0), "{result:#}");
    assert_eq!(result["tbVsJe"]["netMismatched"], json!(0), "{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 红字冲销留在本侧不翻到对面() {
    let dir = fixture("redletter");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,0,500,300,200\n\
         2202,应付账款,0,300,500,-200\n",
    )
    .unwrap();
    // 序时账里有一对红字：贷 −70 冲掉之前多记的贷 370、借 −70 冲平对方科目。
    // 余额表按列直加（1001 贷方 370−70=300），核对必须同口径——
    // 按净额符号归侧会把 −70 翻进对面，两侧各虚增 70（08 号样例实测差 467.02×2）。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,应付账款,0,500\n\
         2025-06-01,V2,1001,库存现金,0,370\n\
         2025-06-01,V2,2202,应付账款,370,0\n\
         2025-06-02,V3,1001,库存现金,0,-70\n\
         2025-06-02,V3,2202,应付账款,-70,0\n",
    )
    .unwrap();
    let result = run(&params(&dir, true), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 已带符号的je贷方先统一方向再与tb比较() {
    let dir = fixture("signed-credit");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,0,500,300,200\n\
         2202,应付账款,0,300,500,-200\n",
    )
    .unwrap();
    // 04 号样例的口径：JE 借方为正、贷方为负。贷方不能直接拿负数与
    // TB 的正数贷方相减，否则 500 - (-500) 会被错误叠加成 1,000。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,应付账款,0,-500\n\
         2025-06-01,V2,2202,应付账款,300,0\n\
         2025-06-01,V2,1001,库存现金,0,-300\n",
    )
    .unwrap();
    let result = run(&params(&dir, true), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["mismatched"], json!(0), "{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 大csv磁盘路径与内存路径输出完全一致() {
    let dir = fixture("disk-memory-parity");
    平的账(&dir);
    let mut input = params(&dir, true);
    input["jeSource"]["headerRow"] = json!(1);
    input["jeSource"]["headerDepth"] = json!(1);
    let memory = run(&input, &AtomicBool::new(false)).unwrap();
    input["__testForceDiskLedger"] = json!(true);
    let disk = run(&input, &AtomicBool::new(false)).unwrap();
    assert_eq!(disk, memory);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 大csv磁盘路径保持已带符号贷方和红字的原侧语义() {
    let dir = fixture("disk-signed-redletter");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,0,500,300,200\n\
         2202,应付账款,0,300,500,-200\n",
    )
    .unwrap();
    // 借正贷负口径下，贷方 +70 是红字；规范化后仍在贷方冲减 70。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,应付账款,0,-500\n\
         2025-06-01,V2,1001,库存现金,0,-370\n\
         2025-06-01,V2,2202,应付账款,370,0\n\
         2025-06-02,V3,1001,库存现金,0,70\n\
         2025-06-02,V3,2202,应付账款,-70,0\n",
    )
    .unwrap();
    let mut input = params(&dir, true);
    input["jeSource"]["headerRow"] = json!(1);
    input["jeSource"]["headerDepth"] = json!(1);
    let memory = run(&input, &AtomicBool::new(false)).unwrap();
    assert_eq!(memory["tbVsJe"]["passed"], json!(true), "{memory:#}");
    input["__testForceDiskLedger"] = json!(true);
    let disk = run(&input, &AtomicBool::new(false)).unwrap();
    assert_eq!(disk, memory);
    assert_eq!(disk["tbVsJe"]["passed"], json!(true), "{disk:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 三三零零口径按原始方向汇总且红字不跨侧() {
    let dir = fixture("3300-signed-redletter");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1002030016,银行存款,18874512.24,168732359.09,184631853.23,2975018.10\n\
         9999,对方科目,-18874512.24,184631853.23,168732359.09,-2975018.10\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,方向,本位币金额\n\
         2025-01-01,V1,1002030016,银行存款,S,178835062.87\n\
         2025-01-01,V1,9999,对方科目,H,-178835062.87\n\
         2025-02-01,V2,1002030016,银行存款,S,-10102703.78\n\
         2025-02-01,V2,9999,对方科目,H,10102703.78\n\
         2025-03-01,V3,1002030016,银行存款,H,-184664743.69\n\
         2025-03-01,V3,9999,对方科目,S,184664743.69\n\
         2025-04-01,V4,1002030016,银行存款,H,32890.46\n\
         2025-04-01,V4,9999,对方科目,S,-32890.46\n",
    )
    .unwrap();
    let mut value = params(&dir, true);
    value["jeMapping"] = json!({
        "id": "凭证号",
        "date": "日期",
        "accountCode": "科目编码",
        "accountName": "科目名称",
        "direction": "方向",
        "functionalAmount": "本位币金额",
    });

    let result = run(&value, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["mismatched"], json!(0), "{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
#[ignore = "读取仓库内 23 万行真实样例，按需回归"]
fn 真实三三零零科目一零零二零三零零一六精确对上tb() {
    let sample_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("汇兑损益测试资料");
    let tb_source = json!({"inputPath": sample_dir.join("TB-3300.xlsx")});
    let je_source = json!({"inputPath": sample_dir.join("3300_JE_2025.01-12.xlsx")});
    let tb_inspection = fx::call("fx.inspect_tb", json!({"source": tb_source.clone()})).unwrap();
    let je_inspection = fx::call("fx.inspect_je", json!({"source": je_source.clone()})).unwrap();
    let tb_headers = tb_inspection["headers"].as_array().unwrap();
    let je_headers = je_inspection["headers"].as_array().unwrap();
    let tb_header = |index: usize| tb_headers[index].as_str().unwrap();
    let je_header = |index: usize| je_headers[index].as_str().unwrap();
    let value = json!({
        "tbSource": tb_source,
        "tbMapping": {
            "accountCode": tb_header(2),
            "entity": tb_header(3),
            "accountName": tb_header(5),
            "openingFunctionalAmount": tb_header(8),
            "ytdFunctionalDebit": tb_header(9),
            "ytdFunctionalCredit": tb_header(10),
            "closingFunctionalAmount": tb_header(11),
        },
        "tbFixedEntity": "3300",
        "jeSource": je_source,
        "jeMapping": {
            "entity": je_header(1),
            "id": je_header(3),
            "date": je_header(10),
            "accountCode": je_header(15),
            "accountName": je_header(16),
            "direction": je_header(25),
            "functionalAmount": je_header(28),
        },
        "jeFixedEntity": "3300",
    });

    let prepared = prepare(&value).unwrap();
    let result = evaluate(&prepared, &AtomicBool::new(false), true).unwrap();
    let items = result["tbVsJe"]["items"].as_array().unwrap();
    let sample_codes = items
        .iter()
        .take(8)
        .map(|item| item["code"].clone())
        .collect::<Vec<_>>();
    let item = items
        .iter()
        .find(|item| item["code"] == json!("1002030016"))
        .unwrap_or_else(|| {
            panic!(
                "真实 3300 结果中应包含科目 1002030016；账户数={}，样例编码={sample_codes:?}，核对结果={}",
                items.len(),
                result["tbVsJe"]
            )
        });
    let close = |actual: f64, expected: f64| (actual - expected).abs() < 0.005;
    assert!(
        close(item["jeDebit"].as_f64().unwrap(), 168_732_359.09),
        "{item:#}"
    );
    assert!(
        close(item["jeCredit"].as_f64().unwrap(), 184_631_853.23),
        "{item:#}"
    );
    assert!(
        close(item["debitDifference"].as_f64().unwrap(), 0.0),
        "{item:#}"
    );
    assert!(
        close(item["creditDifference"].as_f64().unwrap(), 0.0),
        "{item:#}"
    );
}

#[test]
#[ignore = "读取本机TBJEPBC第一组真实样例，按需回归"]
fn 真实第一组关键同编码汇总不重复累计() {
    let sample_dir = std::path::PathBuf::from(r"C:\Users\lenovo\Downloads\TBJEPBC");
    let tb_source = json!({"inputPath": sample_dir.join("01科目余额表（TB）.xls")});
    let je_source = json!({"inputPath": sample_dir.join("01序时账 (JE).xlsx")});
    let tb_inspection = fx::call("fx.inspect_tb", json!({"source": tb_source.clone()})).unwrap();
    let je_inspection = fx::call("fx.inspect_je", json!({"source": je_source.clone()})).unwrap();
    let value = json!({
        "tbSource": tb_source,
        "tbMapping": tb_inspection["suggestedMapping"],
        "jeSource": je_source,
        "jeMapping": je_inspection["suggestedMapping"],
    });
    let prepared = prepare(&value).unwrap();
    let result = evaluate(&prepared, &AtomicBool::new(false), true).unwrap();
    let item = result["tbVsJe"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["code"] == json!("2241.06.09"))
        .unwrap();
    assert!(
        (item["debitDifference"].as_f64().unwrap()).abs() < 0.005,
        "{item:#}"
    );
    assert!(
        (item["creditDifference"].as_f64().unwrap()).abs() < 0.005,
        "{item:#}"
    );
}

#[test]
#[ignore = "读取本机TBJEPBC第三组大文件，验证轻量预览与正式读取表头一致"]
fn 真实第三组本位币净额映射进入正式核对() {
    let sample_dir = std::path::PathBuf::from(r"C:\Users\lenovo\Downloads\TBJEPBC");
    let je_path = sample_dir.join("03序时账 (2).xlsx");
    let je_inspection =
        fx::call("fx.inspect_je", json!({"source": {"inputPath": je_path}})).unwrap();
    assert_eq!(je_inspection["headerRow"], json!(6));
    assert_eq!(
        je_inspection["suggestedMapping"]["functionalAmount"],
        json!("本币金额")
    );
    let source = |path: &std::path::Path, inspection: &Value| {
        json!({
            "inputPath": path,
            "sheet": inspection["sheet"],
            "headerRow": inspection["headerRow"],
            "headerDepth": inspection["headerDepth"],
        })
    };
    let je_source = source(&je_path, &je_inspection);
    let je_spec: SourceSpec = serde_json::from_value(je_source).unwrap();
    let je_table = load_fx_table(&je_spec).unwrap();
    assert!(je_table.headers.iter().any(|header| header == "本币金额"));
    assert!(!je_table.headers.iter().any(|header| header == "Column_1"));
    let mut je_mapping = je_inspection["suggestedMapping"]
        .as_object()
        .cloned()
        .unwrap();
    fx::ensure_sign_convention(&je_table, &mut je_mapping, "je").unwrap();
    assert_eq!(je_mapping["__signConvention"], json!("signed"));
}

#[test]
fn 绝大多数科目不一致时只提示大范围差异不猜测期间原因() {
    let dir = fixture("systematic");
    // 六个科目中绝大多数对不上；没有TB期间字段作为直接证据时，只能客观
    // 标记差异覆盖面，不能把映射、口径等其他原因擅自解释为期间不匹配。
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,0,200,100,100\n\
         1002,银行存款,0,200,100,100\n\
         1122,应收账款,0,200,100,100\n\
         2202,应付账款,0,100,200,-100\n\
         2241,其他应付款,0,100,200,-100\n\
         6602,管理费用,0,100,200,-100\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-01-01,V1,1001,库存现金,100,0\n\
         2025-01-01,V1,2202,应付账款,0,100\n",
    )
    .unwrap();
    let result = run(&params(&dir, true), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["widespread"], json!(true), "{result:#}");
    assert!(result["tbVsJe"].get("systematic").is_none(), "{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 损益类未结转时恒等式仍然成立() {
    let dir = fixture("equation");
    // 04 号样例的形态：年末损益类还没结转到未分配利润，
    // 资产 − 负债 − 权益 差出来的正是损益类的余额。
    // 按「资产＝负债＋权益」会把这套平的账报成不平；全类别加总才是 0。
    // 损益类要留下**净额不为零**的余额（本年利润未结转），否则演示不出问题：
    // 收入 500 贷方、费用 200 借方，净留 300 的贷方余额。
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,700,300,0,1000\n\
         2202,应付账款,-400,0,0,-400\n\
         4001,实收资本,-300,0,0,-300\n\
         6001,主营业务收入,0,0,500,-500\n\
         6601,销售费用,0,200,0,200\n",
    )
    .unwrap();
    let result = run(&params(&dir, false), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["equation"]["passed"], json!(true), "{result:#}");
    assert_eq!(
        result["equation"]["closing"]["total"].as_f64().unwrap(),
        0.0
    );
    // 资产减负债减权益并不为零——正是这一点让「资产＝负债＋权益」不能用。
    let by: std::collections::BTreeMap<String, f64> = result["equation"]["closing"]["byCategory"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["category"].as_str().unwrap().to_owned(),
                item["amount"].as_f64().unwrap(),
            )
        })
        .collect();
    let bs = by["资产"] + by["负债"] + by["所有者权益"];
    assert_ne!(bs, 0.0, "损益未结转时资产−负债−权益本就不为零：{by:?}");
    assert_eq!(bs + by["损益"], 0.0);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 父子科目混排时只算末级() {
    let dir = fixture("leaf");
    // 08 号样例的形态：父行与子行并列，父行金额是子行之和。
    // 不做末级过滤，全类别加总会差出一整个父行的量级。
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1002,银行存款,1000,0,0,1000\n\
         100201,银行存款-基本户,600,0,0,600\n\
         100202,银行存款-一般户,400,0,0,400\n\
         2202,应付账款,-1000,0,0,-1000\n",
    )
    .unwrap();
    let result = run(&params(&dir, false), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["equation"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["equation"]["accounts"], json!(3), "父行不该计入");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 认不出会计要素的科目不猜类别但方向可靠时仍纳入总额() {
    let dir = fixture("unclassified");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,1000,0,0,1000\n\
         2202,应付账款,-1000,0,0,-1000\n\
         X001,自定义科目,500,0,0,500\n",
    )
    .unwrap();
    let result = run(&params(&dir, false), &AtomicBool::new(false)).unwrap();
    // 未分类只影响解释完整性，不再把方向可靠的金额排除在勾稽之外。
    assert_eq!(result["equation"]["passed"], json!(false), "{result:#}");
    assert_eq!(result["equation"]["balancePassed"], json!(false));
    assert_eq!(result["equation"]["classificationComplete"], json!(false));
    assert_eq!(
        result["equation"]["closing"]["total"].as_f64().unwrap(),
        500.0
    );
    let unclassified = result["equation"]["unclassified"].as_array().unwrap();
    assert_eq!(unclassified.len(), 1);
    assert_eq!(unclassified[0]["code"], json!("X001"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 序时账的合计行不计入发生额() {
    let dir = fixture("junk");
    平的账(&dir);
    // 10 号样例的形态：合计行没有凭证号、没有科目，只有金额；
    // 后面还跟着手工草稿。收进来会让所有科目都对不上。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,应付账款,0,500\n\
         2025-06-01,V2,2202,应付账款,300,0\n\
         2025-06-01,V2,1001,库存现金,0,300\n\
         合计,,,,800,800\n",
    )
    .unwrap();
    let result = run(&params(&dir, true), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn je业务行按映射后的编码名称金额三项识别() {
    let dir = fixture("missing-account-name");
    平的账(&dir);
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,,0,500\n\
         2025-06-01,V2,2202,,300,0\n\
         2025-06-01,V2,1001,库存现金,0,300\n",
    )
    .unwrap();
    let result = run(&params(&dir, true), &AtomicBool::new(false)).unwrap();
    // 已有可靠科目编码与金额时，空科目名称不能把真实分录排除。
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["accounts"], json!(2));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn tbje入口会拦截金额列中的非数值() {
    let dir = fixture("invalid-amount");
    平的账(&dir);
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,应付账款,0,待确认\n\
         2025-06-01,V2,2202,应付账款,300,0\n\
         2025-06-01,V2,1001,库存现金,0,300\n",
    )
    .unwrap();
    let error = run(&params(&dir, true), &AtomicBool::new(false)).unwrap_err();
    assert_eq!(error.code, "AMOUNT_VALUE_INVALID");
    assert!(error.user_message.contains("无法解析为数值"));
    assert!(error.detail.as_deref().unwrap_or("").contains("待确认"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn je计量单位误映射为主体时移除后再判方向() {
    let dir = fixture("unit-as-entity");
    std::fs::write(
        dir.join("tb.csv"),
        "公司,科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         A公司,1001,库存现金,100,500,300,300\n\
         A公司,2202,应付账款,-100,300,500,-300\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,单位,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,KG,500,0\n\
         2025-03-01,V1,2202,应付账款,EA,0,-500\n\
         2025-06-01,V2,2202,应付账款,BOX,300,0\n\
         2025-06-01,V2,1001,库存现金,COL,0,-300\n",
    )
    .unwrap();
    let mut value = params(&dir, true);
    value["tbMapping"]["entity"] = json!("公司");
    value["jeMapping"]["entity"] = json!("单位");
    let result = run(&value, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert!(
        result["mappingWarnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().unwrap_or("").contains("计量单位"))
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 未上传序时账时第二条明确跳过而不是报不平() {
    let dir = fixture("nojr");
    平的账(&dir);
    let result = run(&params(&dir, false), &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["performed"], json!(false));
    assert!(
        result["tbVsJe"]["reason"]
            .as_str()
            .unwrap()
            .contains("未上传序时账")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn tb按币种拆行时仍保留全部行核对() {
    let dir = fixture("functional-currency-scope");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,币种,期初余额,本年借方,本年贷方,期末余额\n\
         1001,现金,CNY,0,100,0,100\n\
         1001,现金,USD,0,20,0,20\n\
         2202,应付账款,CNY,0,0,100,-100\n\
         2202,应付账款,USD,0,0,20,-20\n",
    )
    .unwrap();
    // JE同时可以另有原币金额，但TBJE本位币核对只读取这里映射的本位币借贷；
    // 缺少币种列不代表JE“只有本位币”。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,原币金额,借方,贷方\n\
         2025-01-01,V1,1001,现金,14,120,0\n\
         2025-01-01,V1,2202,应付账款,14,0,120\n",
    )
    .unwrap();
    let value = json!({
        "tbSource": {"inputPath": dir.join("tb.csv")},
        "tbMapping": {
            "accountCode": "科目编码", "accountName": "科目名称", "currencyText": "币种",
            "openingFunctionalAmount": "期初余额", "ytdFunctionalDebit": "本年借方",
            "ytdFunctionalCredit": "本年贷方", "closingFunctionalAmount": "期末余额"
        },
        "jeSource": {"inputPath": dir.join("je.csv")},
        "jeMapping": {
            "date": "日期", "id": "凭证号", "accountCode": "科目编码",
            "accountName": "科目名称", "foreignAmount": "原币金额",
            "functionalDebit": "借方", "functionalCredit": "贷方"
        }
    });
    let result = run(&value, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    // TB 自勾稽按币种拆行逐行检查，不只保留推断出的 CNY 行。
    assert_eq!(result["rollforward"]["checked"], json!(4));
    assert_eq!(result["currencyScope"]["functionalCurrency"], Value::Null);
    assert_eq!(result["currencyScope"]["mode"], json!("allRows"));
    assert_eq!(result["currencyScope"]["includedRows"], json!(4));
    assert_eq!(result["currencyScope"]["excludedForeignRows"], json!(0));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn je无币种和独立原币金额时tb仍按全部行汇总() {
    let dir = fixture("mixed-currency-scope");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,币种,期初余额,本年借方,本年贷方,期末余额\n\
         1001,现金,CNY,0,100,0,100\n\
         1001,现金,USD,0,20,0,20\n\
         2202,应付账款,CNY,0,0,100,-100\n\
         2202,应付账款,USD,0,0,20,-20\n",
    )
    .unwrap();
    // JE 没有币种，也没有独立原币金额列；同一个金额口径中已经同时包含
    // 本位币与原币行。按 CNY 单独比较会差 20，情形 C 应汇总 TB 全币种。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-01-01,V1,1001,现金,120,0\n\
         2025-01-01,V1,2202,应付账款,0,120\n",
    )
    .unwrap();
    let value = json!({
        "tbSource": {"inputPath": dir.join("tb.csv")},
        "tbMapping": {
            "accountCode": "科目编码", "accountName": "科目名称", "currencyText": "币种",
            "openingFunctionalAmount": "期初余额", "ytdFunctionalDebit": "本年借方",
            "ytdFunctionalCredit": "本年贷方", "closingFunctionalAmount": "期末余额"
        },
        "jeSource": {"inputPath": dir.join("je.csv")},
        "jeMapping": {
            "date": "日期", "id": "凭证号", "accountCode": "科目编码",
            "accountName": "科目名称", "functionalDebit": "借方",
            "functionalCredit": "贷方"
        }
    });
    let result = run(&value, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["currencyScope"], json!("allRows"));
    assert_eq!(result["currencyScope"]["includedRows"], json!(4));
    assert_eq!(result["currencyScope"]["excludedForeignRows"], json!(0));
    assert!(
        result["tbVsJe"]["currencyScopeNote"]
            .as_str()
            .unwrap()
            .contains("不按币种过滤行")
    );
    assert!(result["mappingWarnings"].as_array().unwrap().is_empty());
    let prepared = prepare(&value).unwrap();
    let all = evaluate(&prepared, &AtomicBool::new(false), true).unwrap();
    let cash = all["tbVsJe"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["code"] == json!("1001"))
        .unwrap();
    assert_eq!(cash["tbIncludedCurrencies"], json!("CNY、USD"));
    assert_eq!(cash["tbIncludedRows"], json!(2));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn tb非完整自然年按通过率自动选用发生额列并如实报差异() {
    let dir = fixture("partial-period-warning");
    let tb_path = dir.join("TB_2024.4-12.csv");
    std::fs::write(
        &tb_path,
        "科目编码,科目名称,期初余额,本期借方,本期贷方,本年借方,本年贷方,期末余额\n\
         1001,现金,0,50,30,500,300,200\n\
         2202,应付账款,0,30,50,300,500,-200\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2024-04-01,V1,1001,现金,50,0\n\
         2024-04-01,V1,2202,应付账款,0,50\n\
         2024-05-01,V2,2202,应付账款,30,0\n\
         2024-05-01,V2,1001,现金,0,30\n",
    )
    .unwrap();
    let value = json!({
        "tbSource": {"inputPath": tb_path},
        "tbMapping": {
            "accountCode": "科目编码", "accountName": "科目名称",
            "openingFunctionalAmount": "期初余额",
            "periodFunctionalDebit": "本期借方", "periodFunctionalCredit": "本期贷方",
            "ytdFunctionalDebit": "本年借方", "ytdFunctionalCredit": "本年贷方",
            "closingFunctionalAmount": "期末余额"
        },
        "jeSource": {"inputPath": dir.join("je.csv")},
        "jeMapping": je_mapping()
    });
    let result = run(&value, &AtomicBool::new(false)).unwrap();
    // 仲裁只看数据：这套账 期初＋本年累计＝期末 成立（500-300=200），本期列
    // 反而不平（50-30=20≠200），通过率不高过本年累计就不切换。序时账只覆盖
    // 4-12 期、与本期列一致，因此按本年累计核对如实报告差异。
    assert_eq!(result["tbVsJe"]["passed"], json!(false), "{result:#}");
    assert!(
        result["mappingWarnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| {
                let warning = warning.as_str().unwrap_or("");
                warning.contains("不是完整自然年") && warning.contains("自动选用")
            })
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 导出的工作簿固定三页并保留全量行与公式() {
    let dir = fixture("export");
    平的账(&dir);
    let mut value = params(&dir, true);
    value["outputPath"] = json!(dir.join("核对.xlsx").to_string_lossy());
    let prepared = prepare(&value).unwrap();
    let result = evaluate(&prepared, &AtomicBool::new(false), true).unwrap();
    let path = export(&value, &result, &prepared).unwrap();
    assert!(path.exists());
    let book = umya_spreadsheet::reader::xlsx::read(&path).unwrap();
    let names: Vec<String> = book
        .get_sheet_collection()
        .iter()
        .map(|sheet| sheet.get_name().to_owned())
        .collect();
    assert_eq!(
        names,
        vec!["TB发生额与余额勾稽", "TB与JE发生额勾稽", "BS与PL勾稽"]
    );
    let rollforward = book.get_sheet_by_name("TB发生额与余额勾稽").unwrap();
    let tbje = book.get_sheet_by_name("TB与JE发生额勾稽").unwrap();
    let equation = book.get_sheet_by_name("BS与PL勾稽").unwrap();
    // 平账也必须导出证据行，不能再只剩表头。
    assert!(rollforward.get_highest_row() >= 8);
    assert!(tbje.get_highest_row() >= 8);
    assert!(equation.get_highest_row() >= 20);
    assert!(
        !rollforward
            .get_cell((8, 7))
            .unwrap()
            .get_formula()
            .is_empty()
    );
    assert!(!tbje.get_cell((8, 7)).unwrap().get_formula().is_empty());
    assert!(!tbje.get_cell((11, 7)).unwrap().get_formula().is_empty());
    for column in 12..=16 {
        assert!(
            !tbje.get_cell((column, 7)).unwrap().get_formula().is_empty(),
            "TBJE 新增净额及结论列必须保留公式，第 {column} 列为空"
        );
    }
    assert_eq!(tbje.get_cell((5, 6)).unwrap().get_value(), "TB纳入币种");
    assert_eq!(tbje.get_cell((12, 6)).unwrap().get_value(), "TB净额");
    assert_eq!(tbje.get_cell((15, 6)).unwrap().get_value(), "净额结论");
    assert_eq!(equation.get_cell((3, 6)).unwrap().get_value(), "带符号金额");
    assert_ne!(equation.get_cell((4, 6)).unwrap().get_value(), "平衡差异");
    assert!(!equation.get_cell((3, 7)).unwrap().get_formula().is_empty());
    if let Ok(output) = std::env::var("TBJE_EXPORT_TEST_OUTPUT") {
        std::fs::copy(&path, output).unwrap();
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 发生额余额勾稽的界面与导出采用同一行范围() {
    let dir = fixture("rollforward-same-scope");
    let tb_path = dir.join("tb.csv");
    std::fs::write(
        &tb_path,
        "科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         1001,库存现金,10,100,50,60\n\
         100101,库存现金明细,5,20,10,15\n\
         下·,固定资产_已使用固定资产,0,10,0,10\n",
    )
    .unwrap();
    let value = json!({
        "tbSource": {"inputPath": tb_path},
        "tbMapping": {
            "accountCode": "科目编码", "accountName": "科目名称",
            "openingFunctionalAmount": "期初余额",
            "ytdFunctionalDebit": "本年借方", "ytdFunctionalCredit": "本年贷方",
            "closingFunctionalAmount": "期末余额"
        },
        "outputPath": dir.join("核对.xlsx")
    });
    let prepared = prepare(&value).unwrap();
    let result = evaluate(&prepared, &AtomicBool::new(false), true).unwrap();
    assert_eq!(result["rollforward"]["checked"], json!(2), "{result:#}");
    assert!(
        result["mappingWarnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().unwrap_or("").contains("下·"))
    );

    let path = export(&value, &result, &prepared).unwrap();
    let book = umya_spreadsheet::reader::xlsx::read(&path).unwrap();
    let sheet = book.get_sheet_by_name("TB发生额与余额勾稽").unwrap();
    let exported = (7..=sheet.get_highest_row())
        .filter(|row| {
            sheet
                .get_cell((2, *row))
                .is_some_and(|cell| !cell.get_value().trim().is_empty())
        })
        .count();
    assert_eq!(exported, 2, "导出必须与界面 checked 行数一致");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 导出的发生额余额勾稽按主体映射增减主体列() {
    let dir = fixture("rollforward-entity-column");
    let tb_path = dir.join("tb.csv");
    std::fs::write(
        &tb_path,
        "主体,科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\n\
         甲公司,1001,库存现金,100,500,300,300\n\
         乙公司,1001,库存现金,50,200,100,150\n",
    )
    .unwrap();
    let mut mapping = tb_mapping();
    mapping["entity"] = json!("主体");
    let value = json!({
        "tbSource": {"inputPath": tb_path},
        "tbMapping": mapping,
        "outputPath": dir.join("带主体.xlsx")
    });
    let prepared = prepare(&value).unwrap();
    let result = evaluate(&prepared, &AtomicBool::new(false), true).unwrap();
    assert_eq!(result["rollforward"]["checked"], json!(2), "{result:#}");
    let path = export(&value, &result, &prepared).unwrap();
    let book = umya_spreadsheet::reader::xlsx::read(&path).unwrap();
    let sheet = book.get_sheet_by_name("TB发生额与余额勾稽").unwrap();
    // 主体列在最前，其余列整体右移一位。
    assert_eq!(sheet.get_cell((1, 6)).unwrap().get_value(), "主体");
    assert_eq!(sheet.get_cell((2, 6)).unwrap().get_value(), "TB纳入币种");
    assert_eq!(sheet.get_cell((3, 6)).unwrap().get_value(), "源表行号");
    assert_eq!(sheet.get_cell((6, 6)).unwrap().get_value(), "期初余额");
    // 数据行的主体值逐行保留，合并余额表才能分清行属于哪个主体。
    assert_eq!(sheet.get_cell((1, 7)).unwrap().get_value(), "甲公司");
    assert_eq!(sheet.get_cell((1, 8)).unwrap().get_value(), "乙公司");
    assert_eq!(sheet.get_cell((4, 7)).unwrap().get_value(), "1001");
    // 公式随列平移：公式期末＝期初＋借－贷落在 I 列，差异与结论引用新列。
    assert_eq!(sheet.get_cell((9, 7)).unwrap().get_formula(), "F7+G7-H7");
    assert_eq!(sheet.get_cell((11, 7)).unwrap().get_formula(), "I7-J7");
    let verdict = sheet.get_cell((12, 7)).unwrap().get_formula();
    assert!(verdict.contains("ABS(K7)"), "{verdict}");

    // 未映射主体时整表回到旧布局，第一列仍是币种，公式列不变。
    let plain = json!({
        "tbSource": {"inputPath": tb_path},
        "tbMapping": tb_mapping(),
        "outputPath": dir.join("无主体.xlsx")
    });
    let prepared = prepare(&plain).unwrap();
    let result = evaluate(&prepared, &AtomicBool::new(false), true).unwrap();
    let path = export(&plain, &result, &prepared).unwrap();
    let book = umya_spreadsheet::reader::xlsx::read(&path).unwrap();
    let sheet = book.get_sheet_by_name("TB发生额与余额勾稽").unwrap();
    assert_eq!(sheet.get_cell((1, 6)).unwrap().get_value(), "TB纳入币种");
    assert_eq!(sheet.get_cell((8, 7)).unwrap().get_formula(), "E7+F7-G7");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 一键导出全部结果时每组生成独立工作簿() {
    let dir = fixture("export-batch");
    平的账(&dir);
    let mut first = params(&dir, true);
    first["label"] = json!("1");
    let mut second = params(&dir, true);
    second["label"] = json!("2");
    let output = dir.join("全部结果");
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let pause = PauseCheckpoint::unpaused(cancel.clone());
    let result = run_job(
        "tbje_check.export_batch",
        json!({
            "groups": [first, second],
            "outputDirectory": output,
        }),
        &|_, _, _, _| {},
        cancel,
        &pause,
    )
    .unwrap();

    let paths = result["outputPaths"].as_array().unwrap();
    assert_eq!(paths.len(), 2, "{result:#}");
    assert!(output.join("第1组_完整性核对.xlsx").is_file());
    assert!(output.join("第2组_完整性核对.xlsx").is_file());
    assert_eq!(result["exports"][0]["ok"], json!(true));
    assert_eq!(result["exports"][1]["ok"], json!(true));
    let _ = std::fs::remove_dir_all(dir);
}

/// 对本机真实样例跑三条核对，把结论打印出来供人工验收。
///
/// 与映射调查同属**调查用**测试，默认不跑：
///
/// ```text
/// LEDGER_SAMPLES=<目录> cargo test --manifest-path src-tauri/Cargo.toml --lib 真实样例的三条核对 -- --ignored --nocapture
/// ```
#[test]
#[ignore = "依赖本机样例目录"]
fn 真实样例的三条核对() {
    let Ok(dirs) = std::env::var("LEDGER_SAMPLES") else {
        println!("未设置 LEDGER_SAMPLES，跳过");
        return;
    };
    for dir in dirs.split(';') {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut files: Vec<std::path::PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| matches!(x.to_ascii_lowercase().as_str(), "xlsx" | "xls"))
            })
            .filter(|p| {
                let name = p.file_name().unwrap_or_default().to_string_lossy();
                !name.starts_with("~$")
                    && !name.contains("完整性核对")
                    && !name.starts_with("FA_")
                    && (name.to_lowercase().contains("tb") || name.contains("余额表"))
            })
            .collect();
        files.sort();
        for tb_path in files {
            let name = tb_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let source = json!({"inputPath": tb_path.to_string_lossy(), "sheet":"", "headerRow":0, "headerDepth":0});
            let Ok(inspected) =
                crate::engine_call_for_test("fx.inspect_tb", json!({ "source": source }))
            else {
                println!("\n══════ {name}：识别失败");
                continue;
            };
            let params = json!({
                "tbSource": {"inputPath": tb_path.to_string_lossy(), "sheet": inspected["sheet"], "headerRow": inspected["headerRow"], "headerDepth": inspected["headerDepth"]},
                "tbMapping": inspected["suggestedMapping"],
            });
            match run(&params, &AtomicBool::new(false)) {
                Ok(result) => {
                    if let Ok(output) = std::env::var("TB_STRUCTURE_REPORT_DIR") {
                        let directory = std::path::PathBuf::from(output);
                        std::fs::create_dir_all(&directory).unwrap();
                        std::fs::write(
                            directory.join(format!("{name}.checks.json")),
                            serde_json::to_vec_pretty(&json!({"params": params, "result": result}))
                                .unwrap(),
                        )
                        .unwrap();
                    }
                    let verdict = |key: &str| {
                        let node = &result[key];
                        if node["performed"].as_bool() != Some(true) {
                            format!("跳过（{}）", node["reason"].as_str().unwrap_or(""))
                        } else if node["passed"].as_bool() == Some(true) {
                            "通过".to_owned()
                        } else {
                            format!(
                                "有差异 {}/{}",
                                node["mismatched"].as_i64().unwrap_or(0),
                                node["checked"]
                                    .as_i64()
                                    .or_else(|| node["accounts"].as_i64())
                                    .unwrap_or(0)
                            )
                        }
                    };
                    println!("\n══════ {name}");
                    println!("  ①勾稽    {}", verdict("rollforward"));
                    println!("  ③恒等式  {}", verdict("equation"));
                    for (label, key) in [("年初", "opening"), ("年末", "closing")] {
                        if let Some(total) = result["equation"][key]["total"].as_f64() {
                            println!("      {label}全类别合计 {total:>18.2}");
                        }
                    }
                    println!(
                        "      符号口径  {}",
                        result["equation"]["signConvention"].as_str().unwrap_or("?")
                    );
                    if let Some(cats) = result["equation"]["closing"]["byCategory"].as_array() {
                        let line = cats
                            .iter()
                            .map(|c| {
                                format!(
                                    "{}={:.0}",
                                    c["category"].as_str().unwrap_or(""),
                                    c["amount"].as_f64().unwrap_or(0.0)
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("  ");
                        println!("      年末分类  {line}");
                    }
                    let unclassified = result["equation"]["unclassified"]
                        .as_array()
                        .map(Vec::len)
                        .unwrap_or(0);
                    if unclassified > 0 {
                        println!("      认不出会计要素的科目 {unclassified} 个");
                    }
                }
                Err(e) => println!("\n══════ {name}：{}", e.user_message),
            }
        }
    }
}

/// 全量调查不因某组识别/核对失败而中断；固定原始15份TB，避免输出工作簿混入。
#[test]
#[ignore = "依赖本机 TBJEPBC 样本目录"]
fn 十三组十五份tb完整样本异常调查() {
    let root =
        std::path::PathBuf::from(std::env::var("TBJEPBC_ROOT").expect("请设置 TBJEPBC_ROOT"));
    let pairs = [
        ("01科目余额表（TB）.xls", "01序时账 (JE).xlsx"),
        ("02科目余额表.xlsx", "02序时账 (2).xlsx"),
        ("03科目余额表.xlsx", "03序时账 (2).xlsx"),
        ("04TB.XLSX", "04JE.XLSX"),
        ("05科目余额表.XLSX", "05序时账 (2).XLSX"),
        ("06科目余额表_2024.1-3.xlsx", "06序时账-2024.1-3.xlsx"),
        ("06科目余额表_2024.4-12.xlsx", "06序时账-2024.4-12.xlsx"),
        ("07科目余额表.xls", "07序时账.xls"),
        ("08TB.xlsx", "08序时账 (2).xlsx"),
        ("09科目余额表-2025.xls", "09序时账-2025.xls"),
        ("10科目余额表.xlsx", "10序时账 (2).xlsx"),
        ("TBJE/2000&2002公司TB.xlsx", "TBJE/2002公司JE.XLSX"),
        ("TBJE/2025 1-3月余额表.xlsx", "TBJE/2025 1-3月明细账.xlsx"),
        ("TBJE/2025 4-12月余额表.xlsx", "TBJE/2025 4-12月明细账.xlsx"),
        (
            "TBJE/科目余额表-20251231 0115最新.xlsx",
            "TBJE/浙江沪杭甬高速公路股份有限公司.xlsx",
        ),
    ];
    let mut reports = Vec::new();
    for (tb, je) in pairs {
        let analyze = || -> Result<Value, AppError> {
            let inspect = |name: &str, kind: &str| {
                crate::engine_call_for_test(
                    &format!("fx.inspect_{kind}"),
                    json!({"source": {"inputPath": root.join(name)}}),
                )
            };
            let tb_inspect = inspect(tb, "tb")?;
            let je_inspect = inspect(je, "je")?;
            let source = |name, inspected: &Value| json!({"inputPath": root.join(name), "sheet": inspected["sheet"], "headerRow": inspected["headerRow"], "headerDepth": inspected["headerDepth"]});
            let mut params = json!({"tbSource": source(tb, &tb_inspect), "jeSource": source(je, &je_inspect), "tbMapping": tb_inspect["suggestedMapping"], "jeMapping": je_inspect["suggestedMapping"]});
            // 真实样本调查要隔离“自动建议是否命中”与“TB 解析是否正确”。
            // 这些覆盖来自样本的实际表头，相当于用户已在界面手工完成映射。
            match tb {
                "02科目余额表.xlsx" => {
                    params["tbMapping"]["accountCode"] = json!("总账科目");
                    params["jeMapping"]["accountCode"] = json!("总帐科目");
                }
                "03科目余额表.xlsx" => {
                    params["jeMapping"]["accountCode"] = json!("总账科目");
                }
                "04TB.XLSX" | "05科目余额表.XLSX" => {
                    params["tbMapping"]["accountCode"] = json!("科目");
                    params["jeMapping"]["accountCode"] = json!("总帐科目");
                }
                "TBJE/2025 4-12月余额表.xlsx" => {
                    params["tbMapping"]["accountCode"] = json!("帐号");
                    params["tbMapping"]["accountName"] = json!(["账号描述"]);
                    params["tbMapping"]["auxiliary"] = json!(["成本中心"]);
                    params["tbMapping"]["closingFunctionalAmount"] = json!("累计差额-LC1");
                    params["tbMapping"]["openingFunctionalAmount"] = json!("(FP)-LC1");
                    params["tbMapping"]["ytdFunctionalDebit"] = json!("借方余额-LC1");
                    params["tbMapping"]["ytdFunctionalCredit"] = json!("贷方余额-LC1");
                    params["jeMapping"] = json!({
                        "accountCode": "科目名称", "accountName": ["科目名称"],
                        "auxiliary": ["成本中心"], "date": "过账日期", "entity": "公司",
                        "functionalDebit": "借/本币", "functionalCredit": "贷/本币",
                        "functionalCurrency": "本币", "id": ["凭证编号"], "summary": "摘要"
                    });
                }
                _ => {}
            }
            let result = run(&params, &AtomicBool::new(false))?;
            Ok(json!({"tb": tb, "je": je, "params": params, "result": result}))
        };
        let report = match analyze() {
            Ok(report) => {
                println!(
                    "样本 {tb}: rollforward={} equation={} tbVsJe={} mismatched={}",
                    report["result"]["rollforward"]["passed"],
                    report["result"]["equation"]["passed"],
                    report["result"]["tbVsJe"]["passed"],
                    report["result"]["tbVsJe"]["mismatched"]
                );
                report
            }
            Err(error) => {
                println!("样本 {tb}: 错误 {error:?}");
                json!({"tb": tb, "je": je, "error": format!("{error:?}")})
            }
        };
        reports.push(report);
    }
    if let Ok(output) = std::env::var("TB_STRUCTURE_REPORT_DIR") {
        let directory = std::path::PathBuf::from(output);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("all-15-manual-mapped-tbje-checks.json"),
            serde_json::to_vec_pretty(&reports).unwrap(),
        )
        .unwrap();
    }
    assert_eq!(reports.len(), 15);
}

/// 真实样例的②发生额核对：按文件名开头的编号把余额表和序时账配成对。
///
/// ```text
/// LEDGER_SAMPLES=<目录> cargo test --manifest-path src-tauri/Cargo.toml --lib 真实样例的发生额核对 -- --ignored --nocapture
/// ```
#[test]
#[ignore = "依赖本机样例目录"]
fn 真实样例的发生额核对() {
    let Ok(dirs) = std::env::var("LEDGER_SAMPLES") else {
        println!("未设置 LEDGER_SAMPLES，跳过");
        return;
    };
    let leading =
        |name: &str| -> String { name.chars().take_while(|c| c.is_ascii_digit()).collect() };
    for dir in dirs.split(';') {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut tbs = Vec::new();
        let mut jes = Vec::new();
        for entry in entries.filter_map(|e| e.ok().map(|e| e.path())) {
            let name = entry
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if name.starts_with("~$")
                || name.contains("完整性核对")
                || !matches!(name.rsplit('.').next(), Some("xlsx" | "xls"))
            {
                continue;
            }
            if name.contains("tb") || name.contains("科目余额") {
                tbs.push(entry);
            } else if name.contains("序时账") || name.contains("je") {
                jes.push(entry);
            }
        }
        for tb_path in tbs {
            let tb_name = tb_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if std::env::var("LEDGER_SAMPLE_PREFIX")
                .ok()
                .is_some_and(|prefix| leading(&tb_name) != prefix)
            {
                continue;
            }
            let Some(je_path) = jes
                .iter()
                .find(|p| {
                    leading(&p.file_name().unwrap_or_default().to_string_lossy())
                        == leading(&tb_name)
                        && !leading(&tb_name).is_empty()
                })
                .cloned()
            else {
                continue;
            };
            let source = |path: &std::path::Path| json!({"inputPath": path.to_string_lossy(), "sheet":"", "headerRow":0, "headerDepth":0});
            let Ok(tb_inspect) =
                crate::engine_call_for_test("fx.inspect_tb", json!({ "source": source(&tb_path) }))
            else {
                println!("\n══════ {tb_name}：识别失败");
                continue;
            };
            let Ok(je_inspect) =
                crate::engine_call_for_test("fx.inspect_je", json!({ "source": source(&je_path) }))
            else {
                println!("\n══════ {tb_name}：序时账识别失败");
                continue;
            };
            let params = json!({
                "tbSource": source(&tb_path),
                "tbMapping": tb_inspect["suggestedMapping"],
                "jeSource": source(&je_path),
                "jeMapping": je_inspect["suggestedMapping"],
            });
            match run(&params, &AtomicBool::new(false)) {
                Ok(result) => {
                    let node = &result["tbVsJe"];
                    let accounts = node["accounts"].as_i64().unwrap_or(0);
                    let mismatched = node["mismatched"].as_i64().unwrap_or(0);
                    let net_mismatched = node["netMismatched"].as_i64().unwrap_or(0);
                    println!(
                        "\n══════ {tb_name} ↔ {}",
                        je_path.file_name().unwrap_or_default().to_string_lossy()
                    );
                    println!(
                        "  ②发生额  单边有差异 {mismatched}/{accounts}；净额不通过 {net_mismatched}/{accounts}（sheet：TB={}，JE={}）",
                        tb_inspect["sheet"].as_str().unwrap_or("?"),
                        je_inspect["sheet"].as_str().unwrap_or("?"),
                    );
                    println!("      币种范围  {}", result["currencyScope"]);
                    if !result["mappingWarnings"]
                        .as_array()
                        .is_none_or(Vec::is_empty)
                    {
                        println!("      映射提示  {}", result["mappingWarnings"]);
                    }
                    for item in node["items"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                        if item["netPassed"].as_bool() == Some(true) {
                            continue;
                        }
                        println!(
                            "      {}  TB借{:.2} JE借{:.2}  TB贷{:.2} JE贷{:.2}  净额差{:.2}",
                            item["code"].as_str().unwrap_or("?"),
                            item["tbDebit"].as_f64().unwrap_or(0.0),
                            item["jeDebit"].as_f64().unwrap_or(0.0),
                            item["tbCredit"].as_f64().unwrap_or(0.0),
                            item["jeCredit"].as_f64().unwrap_or(0.0),
                            item["netDifference"].as_f64().unwrap_or(0.0),
                        );
                    }
                }
                Err(e) => println!(
                    "\n══════ {tb_name}：{}{}",
                    e.user_message,
                    e.detail
                        .as_deref()
                        .map(|detail| format!("（{detail}）"))
                        .unwrap_or_default()
                ),
            }
        }
    }
}

/// 针对 2000&2002 TB 与 2002 JE 这组不同文件名前缀的本机样例。
///
/// ```text
/// LEDGER_SAMPLES=<TBJE目录> cargo test --manifest-path src-tauri/Cargo.toml --lib 2002真实样例的主体与本位币口径 -- --ignored --nocapture
/// ```
#[test]
#[ignore = "依赖本机 2002 TBJE 样例"]
fn 二零零二真实样例的主体与本位币口径() {
    let root = std::path::PathBuf::from(
        std::env::var("LEDGER_SAMPLES").expect("请设置 LEDGER_SAMPLES 为 TBJE 样例目录"),
    );
    let tb_path = root.join("2000&2002公司TB.xlsx");
    let je_path = root.join("2002公司JE.XLSX");
    let source = |path: &std::path::Path| json!({"inputPath": path, "sheet": "", "headerRow": 0, "headerDepth": 0});
    let tb = crate::engine_call_for_test("fx.inspect_tb", json!({"source": source(&tb_path)}))
        .expect("2002 TB 应可识别");
    let je = crate::engine_call_for_test("fx.inspect_je", json!({"source": source(&je_path)}))
        .expect("2002 JE 应可识别");

    println!("TB 工作表={} 映射={}", tb["sheet"], tb["suggestedMapping"]);
    println!("JE 工作表={} 映射={}", je["sheet"], je["suggestedMapping"]);
    assert!(tb.pointer("/suggestedMapping/entity").is_some(), "{tb:#}");
    assert!(je.pointer("/suggestedMapping/entity").is_some(), "{je:#}");
    assert_eq!(
        tb.pointer("/suggestedMapping/openingFunctionalAmount"),
        Some(&json!("Begin Amt.")),
        "{tb:#}"
    );
    assert_eq!(
        tb.pointer("/suggestedMapping/ytdFunctionalDebit"),
        Some(&json!("Debit Amount")),
        "{tb:#}"
    );
    assert_eq!(
        tb.pointer("/suggestedMapping/ytdFunctionalCredit"),
        Some(&json!("Credit Amount")),
        "{tb:#}"
    );
    assert!(
        je.pointer("/suggestedMapping/functionalAmount").is_some()
            || (je.pointer("/suggestedMapping/functionalDebit").is_some()
                && je.pointer("/suggestedMapping/functionalCredit").is_some()),
        "{je:#}"
    );

    let result = run(
        &json!({
            "tbSource": source(&tb_path),
            "tbMapping": tb["suggestedMapping"],
            "jeSource": source(&je_path),
            "jeMapping": je["suggestedMapping"],
        }),
        &AtomicBool::new(false),
    )
    .expect("2002 TBJE 应能完成核对");
    println!(
        "2002 TBJE 核对：主体口径={} 币种口径={} TB勾稽={}/{} TBJE差异={}/{}",
        result["entityScope"]["mode"],
        result["currencyScope"]["mode"],
        result["rollforward"]["mismatched"],
        result["rollforward"]["checked"],
        result["tbVsJe"]["mismatched"],
        result["tbVsJe"]["accounts"],
    );
    assert_eq!(
        result.pointer("/entityScope/mode"),
        Some(&json!("entity")),
        "双侧都映射主体时必须启用主体键：{result:#}"
    );
    assert_eq!(
        result.pointer("/currencyScope/mode"),
        Some(&json!("allRows")),
        "币种不得过滤行：{result:#}"
    );
}

/// 流水级导出回归：真实 2000&2002 合并 TB 上，同科目流水的金额巧合不得
/// 触发「汇总行折叠」。修复前 1405000000 的 TB 贷方被删 460,629.03
/// （工具显示 27,355,374.18，真值 27,816,003.21＝JE 贷方），BS/PL 已归类
/// 科目合计假性不平 -916,849.94。
///
/// ```text
/// LEDGER_SAMPLES=<TBJE目录> cargo test --manifest-path src-tauri/Cargo.toml --lib 二零零二真实样例的流水级导出不折叠 -- --ignored --nocapture
/// ```
#[test]
#[ignore = "依赖本机 2002 TBJE 样例"]
fn 二零零二真实样例的流水级导出不折叠() {
    let root = std::path::PathBuf::from(
        std::env::var("LEDGER_SAMPLES").expect("请设置 LEDGER_SAMPLES 为 TBJE 样例目录"),
    );
    let tb_path = root.join("2000&2002公司TB.xlsx");
    let je_path = root.join("2002公司JE.XLSX");
    let source = |path: &std::path::Path| json!({"inputPath": path, "sheet": "", "headerRow": 0, "headerDepth": 0});
    let tb = crate::engine_call_for_test("fx.inspect_tb", json!({"source": source(&tb_path)}))
        .expect("2002 TB 应可识别");
    let je = crate::engine_call_for_test("fx.inspect_je", json!({"source": source(&je_path)}))
        .expect("2002 JE 应可识别");
    let value = json!({
        "tbSource": source(&tb_path),
        "tbMapping": tb["suggestedMapping"],
        "jeSource": source(&je_path),
        "jeMapping": je["suggestedMapping"],
    });
    let prepared = prepare(&value).unwrap();
    let result = evaluate(&prepared, &AtomicBool::new(false), true).unwrap();

    // 口径提示必须带上：核对范围与旧结果不同，用户需要知道原因。
    assert!(
        result["mappingWarnings"]
            .as_array()
            .is_some_and(|warnings| warnings.iter().any(|warning| warning
                .as_str()
                .is_some_and(|text| text.contains("流水级导出")))),
        "应提示已识别流水级导出并跳过汇总勾稽折叠：{result:#}"
    );

    // 1405000000：TB 与 JE 的借贷发生额必须分毫一致（真值均为
    // 借 28,132,424.67 / 贷 27,816,003.21）。
    let item = result["tbVsJe"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == json!("2002") && item["code"] == json!("1405000000"))
        .expect("全科目模式下必须包含 2002/1405000000");
    let close = |actual: f64| actual.abs() < 0.005;
    assert!(
        close(item["debitDifference"].as_f64().unwrap()),
        "借方不得再少算：{item:#}"
    );
    assert!(
        close(item["creditDifference"].as_f64().unwrap()),
        "贷方不得再少算（修复前少 460,629.03）：{item:#}"
    );
    assert!(
        close(item["tbCredit"].as_f64().unwrap() - 27_816_003.21),
        "TB 贷方合计应为原始流水真值：{item:#}"
    );

    // BS/PL 假性不平消除：两家公司各自账面自平，全表合计应归零。
    assert!(
        result["equation"]["balancePassed"].as_bool().unwrap(),
        "修复前已归类科目合计 -916,849.94：{result:#}"
    );
    let closing_total = result["equation"]["closing"]["total"].as_f64().unwrap();
    assert!(close(closing_total), "期末合计应归零：{closing_total}");
}

#[test]
#[ignore = "仅用于导出本机真实样例"]
fn 导出真实样例前三组() {
    let source_dir = std::path::PathBuf::from(std::env::var("LEDGER_SAMPLES").unwrap());
    let output_dir = std::path::PathBuf::from(std::env::var("TBJE_REAL_EXPORT_DIR").unwrap());
    let leading =
        |name: &str| -> String { name.chars().take_while(|c| c.is_ascii_digit()).collect() };
    let mut files = std::fs::read_dir(&source_dir)
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "xls" | "xlsx"))
        })
        .collect::<Vec<_>>();
    files.sort();
    let mut groups = Vec::new();
    for number in ["01", "02", "03"] {
        let tb = files
            .iter()
            .find(|path| {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                leading(&name) == number
                    && (name.to_ascii_lowercase().contains("tb") || name.contains("科目余额"))
            })
            .unwrap();
        let je = files
            .iter()
            .find(|path| {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                leading(&name) == number
                    && (name.to_ascii_lowercase().contains("je") || name.contains("序时账"))
            })
            .unwrap();
        let source = |path: &std::path::Path| {
            json!({
                "inputPath": path.to_string_lossy(), "sheet": "", "headerRow": 0, "headerDepth": 0
            })
        };
        let tb_inspection =
            crate::engine_call_for_test("fx.inspect_tb", json!({"source": source(tb)})).unwrap();
        let je_inspection =
            crate::engine_call_for_test("fx.inspect_je", json!({"source": source(je)})).unwrap();
        groups.push(json!({
            "label": number.trim_start_matches('0'),
            "tbSource": source(tb),
            "tbMapping": tb_inspection["suggestedMapping"],
            "jeSource": source(je),
            "jeMapping": je_inspection["suggestedMapping"],
        }));
    }
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    let pause = PauseCheckpoint::unpaused(cancel.clone());
    let result = run_job(
        "tbje_check.export_batch",
        json!({"groups": groups, "outputDirectory": output_dir}),
        &|_, _, _, _| {},
        cancel,
        &pause,
    )
    .unwrap();
    println!("{result:#}");
    assert_eq!(result["outputPaths"].as_array().map(Vec::len), Some(3));
}

// ---------------------------------------------------------------------------
// 辅助核算条件匹配键（公共锚点反查）
// ---------------------------------------------------------------------------

/// 辅助参数：TB 映射辅助核算列；`je_aux` 控制 JE 侧是否映射辅助列。
fn auxiliary_params(dir: &std::path::Path, je_aux: Option<&str>) -> Value {
    let mut value = json!({
        "tbSource": {"inputPath": dir.join("tb.csv"), "sheet": "", "headerRow": 0, "headerDepth": 0},
        "jeSource": {"inputPath": dir.join("je.csv"), "sheet": "", "headerRow": 0, "headerDepth": 0},
        "tbMapping": {
            "accountCode": "科目编码",
            "accountName": "科目名称",
            "auxiliary": "辅助核算",
            "openingFunctionalAmount": "期初余额",
            "ytdFunctionalDebit": "本年借方",
            "ytdFunctionalCredit": "本年贷方",
            "closingFunctionalAmount": "期末余额",
        },
        "jeMapping": {
            "id": "凭证号",
            "date": "日期",
            "accountCode": "科目编码",
            "accountName": "科目名称",
            "functionalDebit": "借方",
            "functionalCredit": "贷方",
        },
    });
    if let Some(column) = je_aux {
        value["jeMapping"]["auxiliary"] = json!(column);
    }
    value
}

#[test]
fn 辅助核算锚点认定成功时勾稽细化到维度() {
    let dir = fixture("aux-verified");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,辅助核算,期初余额,本年借方,本年贷方,期末余额\n\
         1002,银行存款,A部门,0,100,0,100\n\
         1002,银行存款,B部门,0,50,0,50\n",
    )
    .unwrap();
    // 科目合计两侧都是 150（A 80＋B 70）：旧口径（主体＋科目）判通过；
    // 维度口径应暴露 A 记 100、JE 只有 80 的串维度差异——这正是细分的价值。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,部门,借方,贷方\n\
         2025-03-01,V1,1002,银行存款,A部门,80,0\n\
         2025-03-01,V1,1002,银行存款,B部门,70,0\n",
    )
    .unwrap();
    let result = run(&auxiliary_params(&dir, None), &AtomicBool::new(false)).unwrap();
    let tb_vs_je = &result["tbVsJe"];
    assert_eq!(tb_vs_je["auxiliaryRefined"], json!(true), "{result:#?}");
    assert_eq!(tb_vs_je["auxiliaryMatch"]["status"], json!("verified"));
    assert_eq!(tb_vs_je["accounts"], json!(2), "{result:#?}");
    let items = tb_vs_je["items"].as_array().unwrap();
    let row_a = items
        .iter()
        .find(|item| item["auxiliary"] == json!("A部门"))
        .unwrap_or_else(|| panic!("缺 A 部门维度行: {items:?}"));
    assert_eq!(row_a["tbDebit"], json!(100.0));
    assert_eq!(row_a["jeDebit"], json!(80.0));
    assert_eq!(row_a["overallVerdict"], json!("不通过"));
    assert!(
        items
            .iter()
            .any(|item| item["auxiliary"] == json!("B部门") && item["tbDebit"] == json!(50.0))
    );
    assert_eq!(tb_vs_je["passed"], json!(false), "{result:#?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 辅助验证逐科目成功细分失败整体回退且映射范围可限定() {
    let dir = fixture("aux-group-verified-only");
    std::fs::write(dir.join("tb.csv"), "科目编码,科目名称,辅助核算,期初余额,本年借方,本年贷方,期末余额\n1002,银行存款,A,0,10,0,10\n1002,银行存款,B,0,20,0,20\n1003,其他货币,C,0,10,0,10\n1003,其他货币,D,0,20,0,20\n").unwrap();
    // JE 日期不限制锚点验证；1003 仅 C 命中，不可细分一半。
    std::fs::write(dir.join("je.csv"), "日期,凭证号,科目编码,科目名称,部门,借方,贷方\n2024-01-01,V1,1002,银行存款,A,10,0\n2026-01-01,V2,1002,银行存款,B,20,0\n2025-01-01,V3,1003,其他货币,C,30,0\n").unwrap();
    let mut params = auxiliary_params(&dir, Some("部门"));
    params["includeAllAccounts"] = json!(true);
    let result = run(&params, &AtomicBool::new(false)).unwrap();
    let groups = result["tbVsJe"]["auxiliaryMatch"]["groups"]
        .as_array()
        .unwrap();
    assert!(
        groups
            .iter()
            .any(|group| group["account"] == "1002" && group["status"] == "verified")
    );
    assert!(
        groups
            .iter()
            .any(|group| group["account"] == "1003" && group["status"] == "partialCoverage")
    );
    assert_eq!(result["tbVsJe"]["accounts"], json!(3), "{result:#?}");
    params["selectedAccounts"] = json!([{ "account": "1002 银行存款" }]);
    let mapping = fx::auxiliary_link_check(&params).unwrap();
    assert_eq!(mapping["status"], "verified", "{mapping:#?}");
    assert_eq!(mapping["groups"].as_array().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn je辅助列为空的分录归未分维度桶() {
    let dir = fixture("aux-unassigned");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,辅助核算,期初余额,本年借方,本年贷方,期末余额\n\
         1002,银行存款,A部门,0,100,0,100\n",
    )
    .unwrap();
    // 科目层两侧都是 100；A 维度只有 60，空格的 40 归未分维度行。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,部门,借方,贷方\n\
         2025-03-01,V1,1002,银行存款,A部门,60,0\n\
         2025-03-02,V2,1002,银行存款,,40,0\n",
    )
    .unwrap();
    let result = run(&auxiliary_params(&dir, None), &AtomicBool::new(false)).unwrap();
    let tb_vs_je = &result["tbVsJe"];
    assert_eq!(tb_vs_je["auxiliaryRefined"], json!(true), "{result:#?}");
    let items = tb_vs_je["items"].as_array().unwrap();
    assert!(
        items
            .iter()
            .any(|item| item["auxiliary"] == json!("") && item["jeDebit"] == json!(40.0)),
        "空格分录应归未分维度行: {items:?}"
    );
    let warnings = result["mappingWarnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|warning| warning.as_str().unwrap_or("").contains("未分维度行")),
        "应提示未分维度归集: {warnings:?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn je无对应辅助列时静默降级并提示() {
    let dir = fixture("aux-degrade");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,辅助核算,期初余额,本年借方,本年贷方,期末余额\n\
         1002,银行存款,A部门,0,100,0,100\n\
         1002,银行存款,B部门,0,50,0,50\n",
    )
    .unwrap();
    // JE 没有任何列含 A部门/B部门：降级按主体＋科目，科目层两侧一致应通过。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,摘要,借方,贷方\n\
         2025-03-01,V1,1002,银行存款,收往来款,150,0\n",
    )
    .unwrap();
    let result = run(&auxiliary_params(&dir, None), &AtomicBool::new(false)).unwrap();
    let tb_vs_je = &result["tbVsJe"];
    assert_eq!(tb_vs_je["auxiliaryRefined"], json!(false), "{result:#?}");
    assert_eq!(tb_vs_je["accounts"], json!(1), "{result:#?}");
    assert_eq!(tb_vs_je["passed"], json!(true), "{result:#?}");
    let warnings = result["mappingWarnings"].as_array().unwrap();
    assert!(
        warnings.iter().any(|warning| warning
            .as_str()
            .unwrap_or("")
            .contains("已按主体＋科目勾稽")),
        "降级必须带提示: {warnings:?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 手选je辅助列对不上按无匹配降级不换列() {
    let dir = fixture("aux-manual-wrong");
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,辅助核算,期初余额,本年借方,本年贷方,期末余额\n\
         1002,银行存款,A部门,0,100,0,100\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,部门,摘要,借方,贷方\n\
         2025-03-01,V1,1002,银行存款,A部门,日常收付,100,0\n",
    )
    .unwrap();
    // 用户手选摘要列当辅助列：值对不上，必须 noMatch 降级——即使「部门」
    // 列本来能对上也不许悄悄换列，用户才知道自己的选择没生效。
    let result = run(
        &auxiliary_params(&dir, Some("摘要")),
        &AtomicBool::new(false),
    )
    .unwrap();
    let tb_vs_je = &result["tbVsJe"];
    assert_eq!(
        tb_vs_je["auxiliaryMatch"]["status"],
        json!("noMatch"),
        "{result:#?}"
    );
    assert_eq!(tb_vs_je["auxiliaryRefined"], json!(false));
    let warnings = result["mappingWarnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|warning| warning.as_str().unwrap_or("").contains("JE 无对应列")),
        "对不上要有降级提示: {warnings:?}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn sap空编码维度明细行继承父行科目并按维度细分勾稽() {
    let dir = fixture("aux-sap-empty-code");
    // 06 号样例形态：父行带编码、维度为空；明细行维度有值、编码留空。
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,核算维度编码,核算维度名称,期初余额,本年借方,本年贷方,期末余额\n\
         1002,银行存款,,,0,150,150,0\n\
         ,,DIM-A,A银行,,100,100,0\n\
         ,,DIM-B,B银行,,50,50,0\n\
         2202,应付账款,,,0,150,0,-150\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,核算维度,借方,贷方\n\
         2025-03-01,V1,1002,银行存款,DIM-A,80,0\n\
         2025-03-01,V1,1002,银行存款,DIM-B,70,0\n\
         2025-03-01,V1,2202,应付账款,,150,0\n",
    )
    .unwrap();
    let mut params = auxiliary_params(&dir, None);
    params["tbMapping"]["auxiliary"] = json!(["核算维度编码", "核算维度名称"]);
    let result = run(&params, &AtomicBool::new(false)).unwrap();
    let tb_vs_je = &result["tbVsJe"];
    assert_eq!(tb_vs_je["auxiliaryRefined"], json!(true), "{result:#?}");
    // 编码＋名称是可选表示；编码列完全验证后才细分，不要求 JE 另有名称列。
    assert_eq!(
        tb_vs_je["auxiliaryMatch"]["status"],
        json!("verified"),
        "{result:#?}"
    );
    // 两个维度行＋一个无维度科目；父行必须被明细取代，不得再出一条空维度合计。
    assert_eq!(tb_vs_je["accounts"], json!(3), "{result:#?}");
    let items = tb_vs_je["items"].as_array().unwrap();
    let row_a = items
        .iter()
        .find(|item| item["auxiliary"] == json!("DIM-A"))
        .unwrap_or_else(|| panic!("缺 DIM-A 维度行: {items:?}"));
    assert_eq!(row_a["code"], json!("1002"), "明细行应继承父行科目编码");
    assert_eq!(row_a["tbDebit"], json!(100.0));
    assert_eq!(row_a["jeDebit"], json!(80.0));
    assert!(
        !items
            .iter()
            .any(|item| item["auxiliary"] == json!("") && item["code"] == json!("1002")),
        "父行金额是明细之和，不得与明细同计: {items:?}"
    );
    // 2202 无维度科目两侧一致（150 对 150），不出现在差异明细里＝照常按科目参与。
    assert_eq!(tb_vs_je["mismatched"], json!(2), "{result:#?}");
    let _ = std::fs::remove_dir_all(dir);
}

/// 真实 06 样例（SAP 空编码维度明细形态）端到端探针：文件在才跑。
#[test]
#[ignore]
fn 真实06样例辅助核算联动探针() {
    let tb_path = r"C:\Users\lenovo\Downloads\TBJEPBC\06科目余额表_2024.1-3.xlsx";
    let je_path = r"C:\Users\lenovo\Downloads\TBJEPBC\06序时账-2024.1-3.xlsx";
    if !std::path::Path::new(tb_path).exists() || !std::path::Path::new(je_path).exists() {
        return;
    }
    let mut params = json!({
        "reportStart": "2024-01-01", "reportEnd": "2024-03-31",
        "tbSource": {"inputPath": tb_path, "sheet": "", "headerRow": 1, "headerDepth": 2},
        "jeSource": {"inputPath": je_path, "sheet": "", "headerRow": 0, "headerDepth": 1},
    });
    let tb = crate::engine_call_for_test(
        "fx.inspect_tb",
        json!({"source": params["tbSource"].clone()}),
    )
    .unwrap();
    let je = crate::engine_call_for_test(
        "fx.inspect_je",
        json!({"source": params["jeSource"].clone()}),
    )
    .unwrap();
    params["tbMapping"] = tb["suggestedMapping"].clone();
    params["jeMapping"] = je["suggestedMapping"].clone();
    let link = crate::fx::auxiliary_link_check(&json!({
        "tbSource": params["tbSource"].clone(),
        "tbMapping": params["tbMapping"].clone(),
        "jeSource": params["jeSource"].clone(),
        "jeMapping": params["jeMapping"].clone(),
    }))
    .unwrap();
    println!("06 联动认定: {link:#?}");
    let result = run(&params, &AtomicBool::new(false)).unwrap();
    println!(
        "06 tbVsJe 辅助结论: refined={} match={:?} accounts={} mismatched={} warnings={:?}",
        result["tbVsJe"]["auxiliaryRefined"],
        result["tbVsJe"]["auxiliaryMatch"],
        result["tbVsJe"]["accounts"],
        result["tbVsJe"]["mismatched"],
        result["mappingWarnings"]
    );
}

// ────────────────── 发生额口径仲裁（本期 ↔ 本年累计） ──────────────────

/// 2024.4-12 形态的中期表：一季度（期初之前）的发生额只进本年累计列。
fn 中期表(dir: &std::path::Path) {
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本期借方,本期贷方,本年借方,本年贷方,期末余额\n\
         1001,库存现金,100,500,300,1500,300,300\n\
         2202,应付账款,-100,300,500,300,700,-300\n",
    )
    .unwrap();
    // 序时账只覆盖 4-12 期，与本期发生列一致。
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-04-01,V1,1001,库存现金,500,0\n\
         2025-04-01,V1,2202,应付账款,0,500\n\
         2025-06-01,V2,2202,应付账款,300,0\n\
         2025-06-01,V2,1001,库存现金,0,300\n",
    )
    .unwrap();
}

fn 加本期映射(value: &mut Value) {
    value["tbMapping"]["periodFunctionalDebit"] = json!("本期借方");
    value["tbMapping"]["periodFunctionalCredit"] = json!("本期贷方");
}

#[test]
fn 中期表同时映射本期与本年累计时按通过率整表选用本期() {
    let dir = fixture("period-arbitration-midyear");
    中期表(&dir);
    let mut value = params(&dir, true);
    加本期映射(&mut value);
    let result = run(&value, &AtomicBool::new(false)).unwrap();
    // 本期列逐行全过：切换后 TB 自身勾稽与 TB/JE 勾稽双双通过。
    assert_eq!(result["rollforward"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    let warnings = result["mappingWarnings"].as_array().unwrap();
    let note = warnings
        .iter()
        .filter_map(Value::as_str)
        .find(|text| text.contains("已整表统一采用「本期发生」"))
        .expect("应输出口径切换说明")
        .to_owned();
    assert!(note.contains("本期发生通过 2/2"), "{note}");
    assert!(note.contains("本年累计通过 0/2"), "{note}");
    // TB 侧发生额确为本期列的值（1001 借 500），不是本年累计的 1500。
    // run() 只返回有差异的科目，全对平时用 include_all 展开验证取数口径。
    let prepared = prepare(&value).unwrap();
    let all = evaluate(&prepared, &AtomicBool::new(false), true).unwrap();
    let items = all["tbVsJe"]["items"].as_array().unwrap();
    let cash = items
        .iter()
        .find(|item| item["code"] == json!("1001"))
        .expect("结果应包含科目 1001");
    assert_eq!(cash["tbDebit"], json!(500.0), "{cash:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 全年表两组发生额并列且全通过时维持本年累计() {
    let dir = fixture("period-arbitration-annual");
    // 全年账：本期＝本年累计，两组逐行全过 → 打平维持本年累计，不提示切换。
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本期借方,本期贷方,本年借方,本年贷方,期末余额\n\
         1001,库存现金,100,500,300,500,300,300\n\
         2202,应付账款,-100,300,500,300,500,-300\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,应付账款,0,500\n\
         2025-06-01,V2,2202,应付账款,300,0\n\
         2025-06-01,V2,1001,库存现金,0,300\n",
    )
    .unwrap();
    let mut value = params(&dir, true);
    加本期映射(&mut value);
    let result = run(&value, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["rollforward"]["passed"], json!(true), "{result:#}");
    assert_eq!(result["tbVsJe"]["passed"], json!(true), "{result:#}");
    let switched = result["mappingWarnings"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .any(|text| text.contains("已整表统一采用"));
    assert!(!switched, "打平时不应切换口径：{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 本期列不平时不切换仍用本年累计() {
    let dir = fixture("period-arbitration-keep-ytd");
    // 本期列借贷颠倒必挂，本年累计列勾稽成立 → 通过率不高过本年累计就不动。
    std::fs::write(
        dir.join("tb.csv"),
        "科目编码,科目名称,期初余额,本期借方,本期贷方,本年借方,本年贷方,期末余额\n\
         1001,库存现金,100,300,500,500,300,300\n\
         2202,应付账款,-100,500,300,300,500,-300\n",
    )
    .unwrap();
    let mut value = params(&dir, false);
    加本期映射(&mut value);
    let result = run(&value, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["rollforward"]["passed"], json!(true), "{result:#}");
    let switched = result["mappingWarnings"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .any(|text| text.contains("已整表统一采用"));
    assert!(!switched, "本期列更差时不得切换：{result:#}");
    let _ = std::fs::remove_dir_all(dir);
}
