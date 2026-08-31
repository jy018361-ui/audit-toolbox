//! TBJE 完整性核对的回归测试。
//!
//! 三条核对的样例都照着真实账的形态构造：余额已带符号、父子科目混排、
//! 序时账里混着合计行——这些都是十套实测样例里真实存在的写法。

use super::*;
use serde_json::json;
use std::sync::atomic::AtomicBool;

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
         2202,应付账款,-100,300,500,-300\n",
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
fn 认不出会计要素的科目单独列出不并入任何一类() {
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
    // 前两个科目本身是平的，但有一个科目没算进去——不能报「通过」。
    assert_eq!(result["equation"]["passed"], json!(false), "{result:#}");
    assert_eq!(result["equation"]["balancePassed"], json!(true));
    assert_eq!(result["equation"]["classificationComplete"], json!(false));
    assert_eq!(
        result["equation"]["closing"]["total"].as_f64().unwrap(),
        0.0
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
fn je正文有编码和金额但缺名称时明确报必要字段错误() {
    let dir = fixture("missing-account-name");
    平的账(&dir);
    std::fs::write(
        dir.join("je.csv"),
        "日期,凭证号,科目编码,科目名称,借方,贷方\n\
         2025-03-01,V1,1001,库存现金,500,0\n\
         2025-03-01,V1,2202,,0,500\n",
    )
    .unwrap();
    let error = run(&params(&dir, true), &AtomicBool::new(false)).unwrap_err();
    assert_eq!(error.code, "JE_REQUIRED_FIELD_MISSING");
    assert!(error.user_message.contains("缺少科目名称"));
    assert!(error.detail.as_deref().unwrap_or("").contains("源表行"));
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
fn tb按币种拆行而je无币种列时仅用tb本位币行核对() {
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
         2025-01-01,V1,1001,现金,14,100,0\n\
         2025-01-01,V1,2202,应付账款,14,0,100\n",
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
    assert_eq!(result["currencyScope"]["functionalCurrency"], json!("CNY"));
    assert_eq!(result["currencyScope"]["mode"], json!("functionalCurrency"));
    assert_eq!(result["currencyScope"]["excludedForeignRows"], json!(2));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn 情形c的je无币种和独立原币金额时tb按全部币种汇总() {
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
    assert_eq!(
        result["tbVsJe"]["currencyScope"],
        json!("allCurrenciesMixedJe")
    );
    assert_eq!(result["currencyScope"]["includedRows"], json!(4));
    assert_eq!(result["currencyScope"]["excludedForeignRows"], json!(0));
    assert!(
        result["tbVsJe"]["currencyScopeNote"]
            .as_str()
            .unwrap()
            .contains("情形C")
    );
    assert!(
        result["mappingWarnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning.as_str().unwrap_or("").contains("情形C"))
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn tb非完整自然年只提示且不自动切换发生额列() {
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
    // 如果系统擅自切到“本期”50/30，这里会通过；保持用户映射的本年累计
    // 500/300 才会如实报告差异。
    assert_eq!(result["tbVsJe"]["passed"], json!(false), "{result:#}");
    assert!(
        result["mappingWarnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| {
                let warning = warning.as_str().unwrap_or("");
                warning.contains("不是完整自然年") && warning.contains("不会自动切换")
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
    assert!(!tbje.get_cell((7, 7)).unwrap().get_formula().is_empty());
    for column in 11..=15 {
        assert!(
            !tbje.get_cell((column, 7)).unwrap().get_formula().is_empty(),
            "TBJE 新增净额及结论列必须保留公式，第 {column} 列为空"
        );
    }
    assert_eq!(tbje.get_cell((11, 6)).unwrap().get_value(), "TB净额");
    assert_eq!(tbje.get_cell((14, 6)).unwrap().get_value(), "净额结论");
    assert_eq!(
        equation.get_cell((3, 6)).unwrap().get_value(),
        "带符号归类金额"
    );
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
                    && (name.to_lowercase().contains("tb") || name.contains("科目余额"))
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
                "tbSource": source,
                "tbMapping": inspected["suggestedMapping"],
            });
            match run(&params, &AtomicBool::new(false)) {
                Ok(result) => {
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
