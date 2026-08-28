//! 合成账表锁住公共上传入口与规范金额的一致性，不读取客户样例或调用 LLM。
use crate::{deposit_interest, fx, ledger_mapping, tabular};
use rust_xlsxwriter::{Format, Workbook};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::atomic::AtomicBool};

struct Fixture(PathBuf);
impl Fixture {
    fn new(kind: &str, signed: bool) -> Self {
        let path =
            std::env::temp_dir().join(format!("ledger-parity-{}.xlsx", uuid::Uuid::new_v4()));
        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet().set_name("账表").unwrap();
        sheet
            .write_string(
                0,
                0,
                if kind == "je" {
                    "序时账"
                } else {
                    "科目余额表"
                },
            )
            .unwrap();
        let headers: Vec<&str> = if kind == "je" {
            vec![
                "公司代码",
                "记账日期",
                "凭证号",
                "科目编码",
                "科目名称",
                "摘要",
                "本位币金额",
                "借贷方向",
            ]
        } else {
            vec![
                "公司代码",
                "科目编码",
                "科目名称",
                "期初本位币余额",
                "期末本位币余额",
                "本年累计借方本位币发生额",
                "本年累计贷方本位币发生额",
            ]
        };
        for (column, header) in headers.iter().enumerate() {
            sheet.write_string(1, column as u16, *header).unwrap();
        }
        let rows: Vec<Vec<String>> = if kind == "je" {
            [
                [
                    "A",
                    "2025-01-01",
                    "001",
                    "1601",
                    "固定资产",
                    "购置",
                    "100",
                    "借",
                ],
                [
                    "A",
                    "2025-01-01",
                    "001",
                    "1002",
                    "银行存款",
                    "支付",
                    if signed { "-100" } else { "100" },
                    "贷",
                ],
                [
                    "B",
                    "2025-01-01",
                    "001",
                    "1601",
                    "固定资产",
                    "购置",
                    "75",
                    "借",
                ],
                [
                    "B",
                    "2025-01-01",
                    "001",
                    "1002",
                    "银行存款",
                    "支付",
                    if signed { "-75" } else { "75" },
                    "贷",
                ],
            ]
            .into_iter()
            .map(|row| row.into_iter().map(str::to_owned).collect())
            .collect()
        } else {
            [
                ["A", "1601", "固定资产", "1000", "1100", "100", "0"],
                ["A", "1002", "银行存款", "2000", "1900", "0", "100"],
            ]
            .into_iter()
            .map(|row| row.into_iter().map(str::to_owned).collect())
            .collect()
        };
        for (row, values) in rows.iter().enumerate() {
            for (column, value) in values.iter().enumerate() {
                sheet
                    .write_string(row as u32 + 2, column as u16, value)
                    .unwrap();
            }
        }
        workbook
            .add_worksheet()
            .set_name("说明")
            .unwrap()
            .merge_range(0, 0, 0, 2, "合成测试数据", &Format::new())
            .unwrap();
        workbook.save(&path).unwrap();
        Self(path)
    }
    fn source(&self) -> Value {
        json!({"inputPath":self.0})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn columns(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => vec![text.clone()],
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => vec![],
    }
}

#[test]
fn shared_upload_detection_and_mapping_agree_for_deposit_and_fa_sources() {
    for kind in ["tb", "je"] {
        let fixture = Fixture::new(kind, false);
        let params = json!({"source":fixture.source()});
        let common = fx::classify_source(&params).unwrap();
        let deposit = deposit_interest::call("deposit.classify_source", params.clone()).unwrap();
        // FA deliberately has no classify/inspect wrapper: its UI calls these same deposit methods.
        assert_eq!(common, deposit);
        assert_eq!(common["kind"], kind);
        let fx = fx::call(&format!("fx.inspect_{kind}"), params.clone()).unwrap();
        let deposit = deposit_interest::call(&format!("deposit.inspect_{kind}"), params).unwrap();
        for key in ["sheet", "sheets", "headerRow", "headerDepth", "headers"] {
            assert_eq!(fx[key], deposit[key], "{kind}: {key}");
        }
        let roles: &[&str] = if kind == "tb" {
            &[
                "entity",
                "accountCode",
                "accountName",
                "openingFunctionalAmount",
                "closingFunctionalAmount",
                "ytdFunctionalDebit",
                "ytdFunctionalCredit",
            ]
        } else {
            &[
                "entity",
                "accountCode",
                "accountName",
                "date",
                "id",
                "summary",
                "functionalAmount",
                "direction",
            ]
        };
        for role in roles {
            assert_eq!(
                columns(&fx["suggestedMapping"][role]),
                columns(&deposit["suggestedMapping"][role]),
                "{kind}: {role}"
            );
        }
    }
}

#[test]
fn confirmed_je_selection_has_identical_mapping_signs_and_net_amounts() {
    for signed in [false, true] {
        let fixture = Fixture::new("je", signed);
        let deposit =
            deposit_interest::call("deposit.inspect_je", json!({"source":fixture.source()}))
                .unwrap();
        let source = json!({"inputPath":fixture.0,"sheet":deposit["sheet"],"headerRow":deposit["headerRow"],"headerDepth":deposit["headerDepth"]});
        // 看账接收已确认的 Sheet/标题行；并不把手工标题行接口伪装成自动识别接口。
        let kanzhang = tabular::call("kanzhang.inspect", source.clone()).unwrap();
        assert_eq!(kanzhang["selectedSheet"], deposit["sheet"]);
        assert_eq!(kanzhang["headers"], deposit["headers"]);
        for role in [
            "entity",
            "accountCode",
            "accountName",
            "date",
            "id",
            "summary",
            "functionalAmount",
            "direction",
        ] {
            assert_eq!(
                columns(&kanzhang["suggestedMapping"][role]),
                columns(&deposit["suggestedMapping"][role]),
                "{role}"
            );
        }
        let table = fx::load_fx_table(&serde_json::from_value(source.clone()).unwrap()).unwrap();
        let map: tabular::LedgerMapping =
            serde_json::from_value(kanzhang["suggestedMapping"].clone()).unwrap();
        let shared = tabular::sign_evidence(&table.rows, &table.headers, &map, &[]);
        let fx_sign = fx::sign_probe_for_test(
            &json!({"source":source,"mapping":deposit["suggestedMapping"]}),
        )
        .unwrap();
        assert_eq!(
            fx_sign["convention"],
            json!(shared.convention.map(|c| c.as_str()))
        );
        assert_eq!(
            fx_sign["trustworthy"],
            ledger_mapping::sign_is_trustworthy(&shared)
        );
        assert_eq!(fx_sign["trustworthy"], true);
        let fa_view = tabular::net_zero_view(
            &table.rows,
            &table.headers,
            &map,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(fa_view.net, vec![100.0, -100.0, 75.0, -75.0]);
    }
}
