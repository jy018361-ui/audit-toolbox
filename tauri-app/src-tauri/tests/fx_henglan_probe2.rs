//! 只读诊断：对比自动识别（headerRow=0）与确认（headerRow=2）两条路径
//! 返回的表头与建议映射形态。
use serde_json::json;

const JE: &str = "C:/Users/lenovo/Downloads/TBJE黄金测试/汇兑损益_外币TBJE测试集/03_恒澜重工/04-恒澜重工_JE序时账.xlsx";

#[test]
#[ignore]
fn probe_auto_vs_confirmed_inspect() {
    for header_row in [0usize, 2] {
        let inspected = audit_toolbox_lib::engine_call_for_test(
            "fx.inspect_je",
            json!({"source": {"inputPath": JE, "sheet": if header_row == 0 {""} else {"JE"}, "headerRow": header_row, "headerDepth": if header_row == 0 {0} else {1}}}),
        )
        .expect("inspect 应当成功");
        println!(
            "headerRow={} → sheet={} headerRow={} depth={}",
            header_row, inspected["sheet"], inspected["headerRow"], inspected["headerDepth"]
        );
        println!(
            "  headers = {}",
            serde_json::to_string(&inspected["headers"]).unwrap()
        );
        println!(
            "  suggested.accountCode = {}",
            serde_json::to_string(&inspected["suggestedMapping"]["accountCode"]).unwrap()
        );
    }
}
