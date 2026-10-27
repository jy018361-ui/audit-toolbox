//! 数据流（DataFlow）执行引擎入口：拓扑排序执行工作流并按响应契约返回结果。
//!
//! - `run_workflow("dataflow_preview", 工作流JSON)`：预览运行，每个输入节点
//!   只取前 1000 行，输出节点不写文件（锚点正常返回）；
//! - `run_workflow("dataflow_run", 工作流JSON)`：全量运行并写输出文件；
//! - 结构性错误（文件缺失、字段缺失、配置无效）停止整次运行：已执行节点的
//!   状态保留在 `nodes`，失败信息写入 `error`（中文 userMessage）；
//! - 行级错误（转换失败、除零）按节点 onRowError 停止（默认）或跳过并记录。

use crate::AppError;
use crate::dataflow::model::RunRequest;
use crate::dataflow::nodes::input;
use crate::dataflow::nodes::output;
use crate::dataflow::nodes::transform;
use crate::dataflow::nodes::{
    sample_json, NodeOutcome, RunContext, RunMode, Table, ANCHOR_SAMPLE_ROWS, PREVIEW_ROWS,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

/// 引擎入口。method 只接受 "dataflow_preview" / "dataflow_run"，
/// params 为完整工作流 JSON（顶层 {version,name,params,nodes,edges,notes}，
/// 可选 paramOverrides 覆盖参数默认值）。
pub(crate) fn run_workflow(method: &str, params: Value) -> Result<Value, AppError> {
    let mode = match method {
        "dataflow_preview" => RunMode::Preview,
        "dataflow_run" => RunMode::Full,
        other => {
            return Err(AppError::new(
                "METHOD_NOT_FOUND",
                format!("未知的数据流方法：{other}"),
                false,
                None,
            ));
        }
    };
    // lib.rs engine_call 注入的已授权路径；未注入（单元测试直调）不启用授权门。
    let allowed_paths: Option<Vec<PathBuf>> = params
        .get("__allowedPaths")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str())
                .map(PathBuf::from)
                .collect()
        });
    let request: RunRequest = serde_json::from_value(params).map_err(|error| {
        AppError::new(
            "DATAFLOW_WORKFLOW_INVALID",
            format!("数据流配置无法解析：{error}"),
            false,
            None,
        )
    })?;
    if request.nodes.is_empty() {
        return Err(AppError::new(
            "DATAFLOW_WORKFLOW_INVALID",
            "工作流没有任何节点。",
            false,
            None,
        ));
    }

    // 参数取值：默认值 + paramOverrides（回落规则：未覆盖时用 params 默认 value）。
    let mut param_values: HashMap<String, String> = HashMap::new();
    for param in &request.params {
        if let Some(value) = stringify_param(param.value.as_ref()) {
            param_values.insert(param.id.clone(), value);
        }
    }
    for (id, value) in &request.param_overrides {
        if let Some(value) = stringify_param(Some(value)) {
            param_values.insert(id.clone(), value);
        }
    }

    let context = RunContext {
        mode,
        today: chrono::Local::now().date_naive(),
        param_values,
        preview_rows: PREVIEW_ROWS,
        allowed_paths,
    };

    let order = topological_order(&request)?;
    let node_name = |id: &str| -> String {
        request
            .nodes
            .iter()
            .find(|node| node.id == id)
            .and_then(|node| node.name.clone())
            .unwrap_or_else(|| id.to_owned())
    };

    let mut anchors: HashMap<(String, String), Table> = HashMap::new();
    let mut nodes_json = serde_json::Map::new();
    let mut outputs: Vec<Value> = Vec::new();
    let mut failure: Option<AppError> = None;

    for node_id in &order {
        let node = request
            .nodes
            .iter()
            .find(|node| &node.id == node_id)
            .expect("拓扑序中的节点必然存在");
        let display_name = node_name(node_id);
        let incoming: Vec<&crate::dataflow::model::Edge> =
            request.edges.iter().filter(|edge| edge.to == node.id).collect();
        let started = Instant::now();

        let outcome: Result<NodeOutcome, AppError> = match node.kind.as_str() {
            "excel_in" | "csv_in" => {
                if !incoming.is_empty() {
                    Err(AppError::new(
                        "DATAFLOW_CONFIG_INVALID",
                        format!("输入节点「{display_name}」不应有输入连线。"),
                        false,
                        None,
                    ))
                } else if node.kind == "excel_in" {
                    input::run_excel_in(&display_name, &node.config, &context)
                } else {
                    input::run_csv_in(&display_name, &node.config, &context)
                }
            }
            "select" | "select_n" => single_input(&incoming, &anchors, &display_name, "字段选择", |table| {
                transform::run_select(&display_name, &node.config, table)
            }),
            "clean" => single_input(&incoming, &anchors, &display_name, "字段清洗", |table| {
                transform::run_clean(&display_name, &node.config, table)
            }),
            "formula" => single_input(&incoming, &anchors, &display_name, "公式", |table| {
                transform::run_formula(&display_name, &node.config, table, &context)
            }),
            "filter" | "filter_n" => single_input(&incoming, &anchors, &display_name, "筛选", |table| {
                transform::run_filter(&display_name, &node.config, table)
            }),
            "excel_out" | "csv_out" => {
                let tables = collect_inputs(&incoming, &anchors, &|id| node_name(id), &display_name);
                match tables {
                    Ok(tables) if tables.is_empty() => Err(AppError::new(
                        "DATAFLOW_CONFIG_INVALID",
                        format!("输出节点「{display_name}」缺少输入连线。"),
                        false,
                        None,
                    )),
                    Ok(tables) if node.kind == "excel_out" => {
                        output::run_excel_out(&display_name, &node.config, &tables, &context)
                    }
                    Ok(tables) => output::run_csv_out(&display_name, &node.config, &tables, &context),
                    Err(error) => Err(error),
                }
            }
            other => Err(AppError::new(
                "DATAFLOW_NODE_UNKNOWN",
                format!("节点「{display_name}」的类型“{other}”未实现（第一期支持 8 类节点）。"),
                false,
                None,
            )),
        };

        match outcome {
            Ok(outcome) => {
                for (anchor, table) in &outcome.anchors {
                    anchors.insert((node_id.clone(), anchor.clone()), table.clone());
                }
                for file in &outcome.written {
                    outputs.push(json!({
                        "nodeId": node_id,
                        "path": file.path.to_string_lossy(),
                        "sheet": file.sheet,
                        "rows": file.rows,
                    }));
                }
                let status = if outcome.has_warnings { "warn" } else { "ok" };
                nodes_json.insert(
                    node_id.clone(),
                    node_status_json(status, outcome, started),
                );
            }
            Err(error) => {
                // 结构性错误：停止本次运行，已完成的节点结果保留。
                let mut failed = NodeOutcome {
                    anchors: Vec::new(),
                    messages: vec![error.user_message.clone()],
                    stats: Vec::new(),
                    written: Vec::new(),
                    rows: 0,
                    has_warnings: false,
                };
                failed.messages.push(format!("错误代码：{}", error.code));
                nodes_json.insert(node_id.clone(), node_status_json("error", failed, started));
                failure = Some(error);
                break;
            }
        }
    }

    let error_json = match &failure {
        None => Value::Null,
        Some(error) => json!({
            "code": error.code,
            "userMessage": error.user_message,
        }),
    };
    Ok(json!({
        "mode": mode.key(),
        "nodes": Value::Object(nodes_json),
        "outputs": outputs,
        "error": error_json,
    }))
}

/// 输出节点按连线顺序收集输入表（锚点缺失为结构性错误）。
fn collect_inputs(
    incoming: &[&crate::dataflow::model::Edge],
    anchors: &HashMap<(String, String), Table>,
    node_name: &dyn Fn(&str) -> String,
    display_name: &str,
) -> Result<Vec<(String, Table)>, AppError> {
    let mut tables = Vec::new();
    for edge in incoming {
        let anchor = edge.from_anchor.as_deref().unwrap_or("output");
        match anchors.get(&(edge.from.clone(), anchor.to_owned())) {
            Some(table) => tables.push((node_name(&edge.from), table.clone())),
            None => {
                return Err(AppError::new(
                    "DATAFLOW_ANCHOR_MISSING",
                    format!(
                        "节点「{display_name}」的输入连线引用了上游“{}”的锚点“{anchor}”，该锚点不存在。",
                        node_name(&edge.from)
                    ),
                    false,
                    None,
                ));
            }
        }
    }
    Ok(tables)
}

fn stringify_param(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn node_status_json(status: &str, outcome: NodeOutcome, started: Instant) -> Value {
    let mut anchors = serde_json::Map::new();
    for (key, table) in &outcome.anchors {
        let sample: Vec<Value> = table
            .rows
            .iter()
            .take(ANCHOR_SAMPLE_ROWS)
            .map(|row| Value::Array(row.iter().map(sample_json).collect()))
            .collect();
        anchors.insert(
            key.clone(),
            json!({
                "columns": table.columns,
                "types": table.types.iter().map(|kind| kind.key()).collect::<Vec<_>>(),
                "rowCount": table.rows.len(),
                "sample": sample,
            }),
        );
    }
    json!({
        "status": status,
        "rows": outcome.rows,
        "ms": started.elapsed().as_millis() as u64,
        "messages": outcome.messages,
        "stats": outcome.stats,
        "anchors": Value::Object(anchors),
    })
}

fn single_input(
    incoming: &[&crate::dataflow::model::Edge],
    anchors: &HashMap<(String, String), Table>,
    display_name: &str,
    kind: &str,
    run: impl FnOnce(&Table) -> Result<NodeOutcome, AppError>,
) -> Result<NodeOutcome, AppError> {
    if incoming.len() != 1 {
        return Err(AppError::new(
            "DATAFLOW_CONFIG_INVALID",
            format!("节点「{display_name}」（{kind}）需要恰好 1 条输入连线（当前 {} 条）。", incoming.len()),
            false,
            None,
        ));
    }
    let edge = incoming[0];
    let anchor = edge.from_anchor.as_deref().unwrap_or("output");
    let table = anchors.get(&(edge.from.clone(), anchor.to_owned())).ok_or_else(|| {
        AppError::new(
            "DATAFLOW_ANCHOR_MISSING",
            format!(
                "节点「{display_name}」的输入连线引用了上游“{}”的锚点“{anchor}”，该锚点不存在。",
                edge.from
            ),
            false,
            None,
        )
    })?;
    run(table)
}

/// 拓扑排序（Kahn，按节点在 nodes 数组中的先后保持稳定次序）；
/// 存在环或连线端点不存在时返回中文错误。
fn topological_order(request: &RunRequest) -> Result<Vec<String>, AppError> {
    let mut known: HashMap<&str, usize> = HashMap::new();
    for (index, node) in request.nodes.iter().enumerate() {
        if known.insert(node.id.as_str(), index).is_some() {
            return Err(AppError::new(
                "DATAFLOW_WORKFLOW_INVALID",
                format!("节点 id“{}”重复。", node.id),
                false,
                None,
            ));
        }
    }
    for edge in &request.edges {
        if !known.contains_key(edge.from.as_str()) {
            return Err(AppError::new(
                "DATAFLOW_WORKFLOW_INVALID",
                format!("连线引用的上游节点“{}”不存在。", edge.from),
                false,
                None,
            ));
        }
        if !known.contains_key(edge.to.as_str()) {
            return Err(AppError::new(
                "DATAFLOW_WORKFLOW_INVALID",
                format!("连线引用的下游节点“{}”不存在。", edge.to),
                false,
                None,
            ));
        }
    }
    let mut indegree = vec![0usize; request.nodes.len()];
    let mut downstream: Vec<Vec<usize>> = vec![Vec::new(); request.nodes.len()];
    for edge in &request.edges {
        let from = known[edge.from.as_str()];
        let to = known[edge.to.as_str()];
        if from == to {
            return Err(AppError::new(
                "DATAFLOW_WORKFLOW_INVALID",
                format!("节点“{}”存在指向自身的连线。", edge.from),
                false,
                None,
            ));
        }
        downstream[from].push(to);
        indegree[to] += 1;
    }
    let mut order = Vec::with_capacity(request.nodes.len());
    let mut ready: Vec<usize> = (0..request.nodes.len()).filter(|index| indegree[*index] == 0).collect();
    while let Some(current) = ready.first().copied() {
        ready.remove(0);
        order.push(request.nodes[current].id.clone());
        for &next in &downstream[current] {
            indegree[next] -= 1;
            if indegree[next] == 0 {
                // 保持稳定次序：插入到合适位置（简单起见排序）。
                let position = ready
                    .iter()
                    .position(|existing| *existing > next)
                    .unwrap_or(ready.len());
                ready.insert(position, next);
            }
        }
    }
    if order.len() != request.nodes.len() {
        return Err(AppError::new(
            "DATAFLOW_CYCLE",
            "工作流存在环，无法确定执行顺序，请检查连线。",
            false,
            None,
        ));
    }
    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::GBK;
    use std::fs;
    use std::path::PathBuf;

    // ---------- 测试辅助 ----------

    fn workflow(nodes: Value, edges: Value) -> Value {
        json!({"version": 1, "name": "测试流程", "nodes": nodes, "edges": edges})
    }

    fn run(method: &str, flow: Value) -> Value {
        run_workflow(method, flow).expect("工作流应可执行")
    }

    /// 取某节点某锚点第 row 行第 col 列的样例值。
    fn cell(result: &Value, node: &str, anchor: &str, row: usize, column: usize) -> Value {
        result
            .pointer(&format!("/nodes/{node}/anchors/{anchor}/sample/{row}/{column}"))
            .cloned()
            .expect("样例单元格应存在")
    }

    fn row_count(result: &Value, node: &str, anchor: &str) -> usize {
        result
            .pointer(&format!("/nodes/{node}/anchors/{anchor}/rowCount"))
            .and_then(Value::as_u64)
            .expect("行数应存在") as usize
    }

    fn types(result: &Value, node: &str, anchor: &str) -> Vec<String> {
        result
            .pointer(&format!("/nodes/{node}/anchors/{anchor}/types"))
            .and_then(Value::as_array)
            .expect("类型应存在")
            .iter()
            .map(|value| value.as_str().unwrap_or_default().to_owned())
            .collect()
    }

    fn node_status(result: &Value, node: &str) -> String {
        result
            .pointer(&format!("/nodes/{node}/status"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    fn csv_in_node(id: &str, path: &PathBuf, extra: Value) -> Value {
        // 测试默认不附加来源列，保持列索引可预期；来源列有专门测试。
        let mut config = json!({"path": path.to_string_lossy(), "attachSourceColumns": false});
        if let (Some(base), Some(overlay)) = (config.as_object_mut(), extra.as_object()) {
            for (key, value) in overlay {
                base.insert(key.clone(), value.clone());
            }
        }
        json!({"id": id, "type": "csv_in", "name": "CSV输入", "config": config})
    }

    fn write_gbk(path: &PathBuf, text: &str) {
        fs::write(path, GBK.encode(text).0.as_ref()).unwrap();
    }

    // ---------- 编码读取：GBK / UTF-8 / UTF-8 BOM ----------

    #[test]
    fn reads_gbk_utf8_and_bom_files() {
        let root = tempfile::tempdir().unwrap();
        let gbk_file = root.path().join("gbk.csv");
        write_gbk(&gbk_file, "客商,金额\n北京公司,1200.5\n");
        let plain = root.path().join("plain.csv");
        fs::write(&plain, "客商,金额\n上海公司,7.25\n").unwrap();
        let mut bom = b"\xEF\xBB\xBF".to_vec();
        bom.extend_from_slice(b"\xe5\xb9\xbf\xe5\xb7\x9e\xe5\x85\xac\xe5\x8f\xb8,\xe9\x87\x91\xe9\xa2\x9d\n30.5,40.75\n");
        let bom_file = root.path().join("bom.csv");
        fs::write(&bom_file, &bom).unwrap();
        // 上面 BOM 文件把列名写反了，重写成规整的：
        let mut bom = b"\xEF\xBB\xBF".to_vec();
        bom.extend_from_slice("客商,金额\n广州公司,40.75\n".as_bytes());
        fs::write(&bom_file, &bom).unwrap();

        for (file, name, amount) in [
            (&gbk_file, "北京公司", "1200.5"),
            (&plain, "上海公司", "7.25"),
            (&bom_file, "广州公司", "40.75"),
        ] {
            let flow = workflow(
                json!([csv_in_node("in", file, json!({}))]),
                json!([]),
            );
            let result = run("dataflow_preview", flow);
            assert_eq!(node_status(&result, "in"), "ok", "文件 {name} 应读取成功");
            assert_eq!(cell(&result, "in", "output", 0, 0), json!(name));
            assert_eq!(cell(&result, "in", "output", 0, 1), json!(amount));
            assert_eq!(types(&result, "in", "output"), ["text", "decimal"]);
        }
    }

    #[test]
    fn reads_manual_gbk_encoding_and_pipe_delimiter() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("manual.csv");
        write_gbk(&file, "客商|金额\n深圳公司|90.5\n");
        let flow = workflow(
            json!([csv_in_node("in", &file, json!({
                "encoding": "gbk", "delimiter": "pipe"
            }))]),
            json!([]),
        );
        let result = run("dataflow_preview", flow);
        assert_eq!(cell(&result, "in", "output", 0, 0), json!("深圳公司"));
        assert_eq!(cell(&result, "in", "output", 0, 1), json!("90.5"));
    }

    // ---------- 伪 xls 文本（后缀 .xls 的分隔文本，走既有识别层） ----------

    #[test]
    fn reads_pseudo_xls_text_via_unified_layer() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("台账.xls");
        write_gbk(&file, "编号,金额\n001,456.50\n");
        let flow = workflow(
            json!([{
                "id": "in", "type": "excel_in", "name": "Excel输入",
                "config": {"path": file.to_string_lossy(), "attachSourceColumns": false}
            }]),
            json!([]),
        );
        let result = run("dataflow_preview", flow);
        assert_eq!(node_status(&result, "in"), "ok");
        // 前导零编号保持文本。
        assert_eq!(cell(&result, "in", "output", 0, 0), json!("001"));
        assert_eq!(cell(&result, "in", "output", 0, 1), json!("456.5"));
        assert_eq!(types(&result, "in", "output"), ["text", "decimal"]);
    }

    #[test]
    fn source_columns_attached_by_request() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("src.csv");
        fs::write(&file, "编号\nA1\n").unwrap();
        let flow = workflow(
            json!([{
                "id": "in", "type": "csv_in", "name": "CSV输入",
                "config": {"path": file.to_string_lossy(), "attachSourceColumns": true}
            }]),
            json!([]),
        );
        let result = run("dataflow_preview", flow);
        assert_eq!(
            types(&result, "in", "output"),
            ["text", "text", "text", "integer"],
            "应附加来源文件、Sheet、原始行号三列"
        );
        assert_eq!(cell(&result, "in", "output", 0, 0), json!("A1"));
        assert_eq!(cell(&result, "in", "output", 0, 1), json!("src.csv"));
        assert_eq!(cell(&result, "in", "output", 0, 2), json!("CSV"));
        assert_eq!(cell(&result, "in", "output", 0, 3), json!(2), "原始行号为物理行号");
    }

    // ---------- 千分位金额、前导零、18 位编号按文本 ----------

    #[test]
    fn thousand_separator_leading_zero_and_long_id_rules() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("rules.csv");
        fs::write(
            &file,
            "编号,账号,金额\n0012,123456789012345678,\"1,234.56\"\n",
        )
        .unwrap();
        let flow = workflow(json!([csv_in_node("in", &file, json!({}))]), json!([]));
        let result = run("dataflow_preview", flow);
        assert_eq!(cell(&result, "in", "output", 0, 0), json!("0012"));
        assert_eq!(cell(&result, "in", "output", 0, 1), json!("123456789012345678"));
        assert_eq!(cell(&result, "in", "output", 0, 2), json!("1234.56"));
        assert_eq!(
            types(&result, "in", "output"),
            ["text", "text", "decimal"]
        );
        let stats = result
            .pointer("/nodes/in/stats")
            .and_then(Value::as_array)
            .unwrap();
        assert!(
            stats.iter().any(|stat| stat.as_str().unwrap_or("").contains("超过 15 位")),
            "18 位编号应有保底文本提示：{stats:?}"
        );
    }

    // ---------- 去空格 / 全角转半角 ----------

    #[test]
    fn clean_trims_spaces_and_converts_full_width() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("dirty.csv");
        fs::write(&file, "名称\n\"  张三 \"\nＡＢＣ１２３\n").unwrap();
        let flow = workflow(
            json!([
                csv_in_node("in", &file, json!({})),
                {"id": "cl", "type": "clean", "name": "清洗",
                 "config": {"actions": [{"field": "名称", "ops": ["trim", "toHalfWidth"]}]}}
            ]),
            json!([{"from": "in", "to": "cl"}]),
        );
        let result = run("dataflow_preview", flow);
        assert_eq!(cell(&result, "cl", "output", 0, 0), json!("张三"));
        assert_eq!(cell(&result, "cl", "output", 1, 0), json!("ABC123"));
    }

    // ---------- 公式：0.1+0.2 精确十进制、IF 短路、除零跳过并记录 ----------

    #[test]
    fn formula_decimal_precision_if_short_circuit_and_division_rules() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("calc.csv");
        fs::write(&file, "被除数,除数\n0.1,0.2\n10,0\n7,2\n").unwrap();
        let flow = workflow(
            json!([
                csv_in_node("in", &file, json!({})),
                {"id": "f", "type": "formula", "name": "公式",
                 "config": {
                    "formulas": [
                        {"target": "常量", "expression": "0.1 + 0.2"},
                        {"target": "商", "expression": "[被除数] / [除数]"},
                        {"target": "十倍", "expression": "IF([被除数] > 100, 1 / 0, [被除数] * 10)"},
                        {"target": "年度", "expression": "YEAR(TODAY())"}
                    ],
                    "onRowError": "skip"
                 }}
            ]),
            json!([{"from": "in", "to": "f"}]),
        );
        let result = run("dataflow_preview", flow);
        assert_eq!(node_status(&result, "f"), "warn", "有跳过记录的运行应标警告");
        // 除零行被跳过，剩 2 行。
        assert_eq!(row_count(&result, "f", "output"), 2);
        // 0.1 + 0.2 = 0.3（精确十进制，非二进制浮点）。
        assert_eq!(cell(&result, "f", "output", 0, 2), json!("0.3"));
        // 第一行 0.1 / 0.2 = 0.5；第三行 7 / 2 = 3.5。
        assert_eq!(cell(&result, "f", "output", 0, 3), json!("0.5"));
        assert_eq!(cell(&result, "f", "output", 1, 3), json!("3.5"));
        // IF 短路：被除数 <= 100 时不会触发 1/0。
        assert_eq!(cell(&result, "f", "output", 0, 4), json!("1"));
        assert_eq!(cell(&result, "f", "output", 1, 4), json!("70"));
        let stats = result.pointer("/nodes/f/stats").and_then(Value::as_array).unwrap();
        assert!(stats.iter().any(|s| s.as_str().unwrap_or("").contains("跳过行数：1")));
        assert!(stats.iter().any(|s| s.as_str().unwrap_or("").contains("业务日期")));
    }

    #[test]
    fn division_by_zero_with_stop_policy_fails_the_run() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("div.csv");
        fs::write(&file, "被除数,除数\n10,0\n").unwrap();
        let flow = workflow(
            json!([
                csv_in_node("in", &file, json!({})),
                {"id": "f", "type": "formula", "name": "公式",
                 "config": {"formulas": [{"target": "商", "expression": "[被除数] / [除数]"}]}}
            ]),
            json!([{"from": "in", "to": "f"}]),
        );
        let result = run("dataflow_preview", flow);
        assert_eq!(
            result.pointer("/error/code").and_then(Value::as_str),
            Some("DATAFLOW_ROW_ERROR")
        );
        assert_eq!(node_status(&result, "f"), "error");
    }

    // ---------- 筛选 T/F 行数守恒、空值进 F 路 ----------

    #[test]
    fn filter_conserves_rows_and_nulls_go_to_f() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("amounts.csv");
        fs::write(&file, "金额\n500\n50\n\n300\n").unwrap();
        let flow = workflow(
            json!([
                csv_in_node("in", &file, json!({})),
                {"id": "fl", "type": "filter", "name": "筛选",
                 "config": {"condition": {"op": "and", "rules": [
                    {"field": "金额", "operator": ">=", "value": 100}
                 ]}}}
            ]),
            json!([{"from": "in", "to": "fl"}]),
        );
        let result = run("dataflow_preview", flow);
        // 3 条数据行（500、50、空）+ 300 = 4 行；空值行与 50 进 F 路。
        assert_eq!(row_count(&result, "fl", "T"), 2);
        assert_eq!(row_count(&result, "fl", "F"), 2);
        assert_eq!(row_count(&result, "fl", "T") + row_count(&result, "fl", "F"), 4);
        assert_eq!(result.pointer("/nodes/fl/rows").and_then(Value::as_u64), Some(4));
    }

    // ---------- 预览不写输出文件 ----------

    #[test]
    fn preview_does_not_write_output_files() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("in.csv");
        fs::write(&input, "金额\n1\n2\n").unwrap();
        let target = root.path().join("结果.xlsx");
        let flow = workflow(
            json!([
                csv_in_node("in", &input, json!({})),
                {"id": "out", "type": "excel_out", "name": "Excel输出",
                 "config": {"fileName": target.to_string_lossy()}}
            ]),
            json!([{"from": "in", "to": "out"}]),
        );
        let result = run("dataflow_preview", flow);
        assert!(!target.exists(), "预览运行不得写输出文件");
        assert_eq!(
            result.pointer("/outputs").and_then(Value::as_array).map(Vec::len),
            Some(0)
        );
        assert_eq!(node_status(&result, "out"), "ok");
        assert_eq!(row_count(&result, "out", "sheet:CSV输入"), 2);
    }

    // ---------- 覆盖保护三策略 ----------

    fn excel_out_flow(root: &tempfile::TempDir, overwrite: &str) -> (Value, PathBuf) {
        let input = root.path().join("in.csv");
        if !input.exists() {
            fs::write(&input, "金额\n1\n2\n").unwrap();
        }
        let target = root.path().join("结果.xlsx");
        let flow = workflow(
            json!([
                csv_in_node("in", &input, json!({})),
                {"id": "out", "type": "excel_out", "name": "Excel输出",
                 "config": {"fileName": target.to_string_lossy(), "overwrite": overwrite}}
            ]),
            json!([{"from": "in", "to": "out"}]),
        );
        (flow, target)
    }

    #[test]
    fn overwrite_strategies_error_timestamp_replace() {
        // 默认（error）：目标已存在即中文报错。
        let root = tempfile::tempdir().unwrap();
        let (flow, target) = excel_out_flow(&root, "error");
        run("dataflow_run", flow.clone());
        assert!(target.exists());
        let second = run("dataflow_run", flow);
        assert_eq!(
            second.pointer("/error/code").and_then(Value::as_str),
            Some("DATAFLOW_OUTPUT_EXISTS")
        );
        assert!(
            second.pointer("/error/userMessage")
                .and_then(Value::as_str)
                .unwrap()
                .contains("目标文件已存在")
        );

        // timestamp：自动加时间戳，原文件保留。
        let root2 = tempfile::tempdir().unwrap();
        let (flow2, target2) = excel_out_flow(&root2, "timestamp");
        run("dataflow_run", flow2.clone());
        let stamped = run("dataflow_run", flow2);
        assert!(target2.exists(), "原文件应保留");
        let stamped_path = stamped
            .pointer("/outputs/0/path")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned();
        assert_ne!(stamped_path, target2.to_string_lossy(), "第二次运行应写入时间戳文件");
        assert!(PathBuf::from(&stamped_path).exists());

        // replace：直接覆盖，且不留临时文件。
        let root3 = tempfile::tempdir().unwrap();
        let (flow3, target3) = excel_out_flow(&root3, "replace");
        run("dataflow_run", flow3.clone());
        let replaced = run("dataflow_run", flow3);
        assert!(replaced.pointer("/error").unwrap().is_null(), "覆盖策略应成功");
        assert!(target3.exists());
        let leftovers: Vec<_> = fs::read_dir(root3.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".dataflow-tmp-")
            })
            .collect();
        assert!(leftovers.is_empty(), "不应残留未提交的临时文件");
    }

    // ---------- 参数占位替换 ----------

    #[test]
    fn parameter_placeholders_apply_to_path_and_file_name() {
        let root = tempfile::tempdir().unwrap();
        let period_dir = root.path().join("202611");
        fs::create_dir_all(&period_dir).unwrap();
        let input = period_dir.join("data.csv");
        fs::write(&input, "金额\n9\n").unwrap();
        let target = root.path().join("{期间}_输出.csv");
        let mut flow = workflow(
            json!([
                csv_in_node("in", &root.path().join("{期间}").join("data.csv"), json!({})),
                {"id": "out", "type": "csv_out", "name": "CSV输出",
                 "config": {"fileName": target.to_string_lossy(), "encoding": "utf8"}}
            ]),
            json!([{"from": "in", "to": "out"}]),
        );
        // 参数默认值 202610；覆盖为 202611。
        flow["params"] = json!([{"id": "期间", "name": "期间", "type": "text", "value": "202610"}]);
        flow["paramOverrides"] = json!({"期间": "202611"});
        let result = run("dataflow_run", flow);
        assert!(result.pointer("/error").unwrap().is_null());
        assert!(root.path().join("202611_输出.csv").exists(), "文件名应代入覆盖后的参数");
    }

    // ---------- CSV 分文件与 GBK 不可表示字符 ----------

    #[test]
    fn csv_split_rows_produce_complete_file_set() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("in.csv");
        fs::write(&input, "金额\n1\n2\n3\n4\n5\n").unwrap();
        let flow = workflow(
            json!([
                csv_in_node("in", &input, json!({})),
                {"id": "out", "type": "csv_out", "name": "CSV输出",
                 "config": {
                    "fileName": root.path().join("分片.csv").to_string_lossy(),
                    "encoding": "utf8", "splitRows": 2
                 }}
            ]),
            json!([{"from": "in", "to": "out"}]),
        );
        let result = run("dataflow_run", flow);
        assert!(result.pointer("/error").unwrap().is_null());
        let outputs = result.pointer("/outputs").and_then(Value::as_array).unwrap();
        assert_eq!(outputs.len(), 3, "5 行按每文件 2 行应分 3 个文件");
        let total: u64 = outputs
            .iter()
            .map(|entry| entry.pointer("/rows").and_then(Value::as_u64).unwrap_or(0))
            .sum();
        assert_eq!(total, 5, "分片不截断记录，合计行数与节点结果一致");
        for entry in outputs {
            assert!(PathBuf::from(entry.pointer("/path").and_then(Value::as_str).unwrap()).exists());
        }
    }

    #[test]
    fn gbk_unrepresentable_characters_fail_clearly() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("in.csv");
        fs::write(&input, "名称\n含表情😀的文本\n").unwrap();
        let flow = workflow(
            json!([
                csv_in_node("in", &input, json!({})),
                {"id": "out", "type": "csv_out", "name": "CSV输出",
                 "config": {"fileName": root.path().join("gbk.csv").to_string_lossy(), "encoding": "gbk"}}
            ]),
            json!([{"from": "in", "to": "out"}]),
        );
        let result = run("dataflow_run", flow);
        assert_eq!(
            result.pointer("/error/code").and_then(Value::as_str),
            Some("DATAFLOW_ENCODING_UNREPRESENTABLE")
        );
        let message = result
            .pointer("/error/userMessage")
            .and_then(Value::as_str)
            .unwrap();
        assert!(message.contains("GBK"), "错误信息应说明编码问题：{message}");
    }

    // ---------- 行级错误策略与字段引用校验 ----------

    #[test]
    fn locked_type_row_errors_stop_or_skip() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("typed.csv");
        fs::write(&file, "数量\n12\nabc\n30\n").unwrap();
        // 停止（默认）。
        let stop_flow = workflow(
            json!([csv_in_node("in", &file, json!({"columnTypes": {"数量": "integer"}}))]),
            json!([]),
        );
        let stopped = run("dataflow_preview", stop_flow);
        assert_eq!(
            stopped.pointer("/error/code").and_then(Value::as_str),
            Some("DATAFLOW_ROW_ERROR")
        );
        // 跳过并记录。
        let skip_flow = workflow(
            json!([csv_in_node("in", &file, json!({
                "columnTypes": {"数量": "integer"}, "onRowError": "skip"
            }))]),
            json!([]),
        );
        let skipped = run("dataflow_preview", skip_flow);
        assert!(skipped.pointer("/error").unwrap().is_null());
        assert_eq!(row_count(&skipped, "in", "output"), 2);
        assert_eq!(node_status(&skipped, "in"), "warn");
    }

    #[test]
    fn missing_field_reference_is_structural_error() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("in.csv");
        fs::write(&file, "金额\n1\n").unwrap();
        let flow = workflow(
            json!([
                csv_in_node("in", &file, json!({})),
                {"id": "f", "type": "formula", "name": "公式",
                 "config": {"formulas": [{"target": "y", "expression": "[不存在字段] + 1"}]}}
            ]),
            json!([{"from": "in", "to": "f"}]),
        );
        let result = run("dataflow_preview", flow);
        assert_eq!(
            result.pointer("/error/code").and_then(Value::as_str),
            Some("DATAFLOW_FIELD_MISSING")
        );
    }

    // ---------- 方法名与环检测 ----------

    #[test]
    fn unknown_method_rejected_and_cycles_detected() {
        let error = run_workflow("dataflow_other", json!({})).unwrap_err();
        assert_eq!(error.code, "METHOD_NOT_FOUND");
        let flow = workflow(
            json!([
                {"id": "a", "type": "clean", "name": "A", "config": {"actions": []}},
                {"id": "b", "type": "clean", "name": "B", "config": {"actions": []}}
            ]),
            json!([{"from": "a", "to": "b"}, {"from": "b", "to": "a"}]),
        );
        let error = run_workflow("dataflow_preview", flow).unwrap_err();
        assert_eq!(error.code, "DATAFLOW_CYCLE");
    }
}

