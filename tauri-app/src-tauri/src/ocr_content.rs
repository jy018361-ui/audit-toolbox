//! Provider output is diagnostic data, never the user's document body.
use regex::Regex;
use serde_json::{Value, json};

fn unfence(raw: &str) -> &str {
    let raw = raw.trim();
    if raw.starts_with("```") {
        raw.split_once('\n')
            .map(|(_, body)| body.strip_suffix("```").unwrap_or(body).trim())
            .unwrap_or(raw)
    } else {
        raw
    }
}

pub(crate) fn looks_like_ocr_payload(raw: &str) -> bool {
    let raw = unfence(raw);
    (raw.starts_with('{') || raw.starts_with('['))
        && ["\"text\"", "\"tables\"", "\"rotate_rect\"", "\"content\""]
            .iter()
            .any(|key| raw.contains(key))
}

fn push_text(out: &mut String, text: &str) {
    let text = text.trim();
    if !text.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(text);
    }
}

fn plain_html(raw: &str) -> String {
    let breaks = Regex::new(r"(?i)<\s*(?:br\s*/?|/p|/div|/tr)\s*>").unwrap();
    let tags = Regex::new(r"(?s)<[^>]*>").unwrap();
    let raw = breaks.replace_all(raw, "\n");
    let raw = tags.replace_all(&raw, "");
    let raw = raw.replace("&nbsp;", " ");
    quick_xml::escape::unescape(&raw)
        .map(|s| s.into_owned())
        .unwrap_or(raw)
        .trim()
        .to_owned()
}

fn cell_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Object(_) => value.get("text").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

fn walk(
    value: &Value,
    text: &mut String,
    tables: &mut Vec<Value>,
    warnings: &mut Vec<String>,
    depth: usize,
) {
    if depth > 16 {
        warnings.push("识别结果嵌套过深，部分内容未能还原，请重新识别。".into());
        return;
    }
    match value {
        Value::String(content) => {
            if looks_like_ocr_payload(content) {
                if let Ok(nested) = serde_json::from_str::<Value>(unfence(content)) {
                    walk(&nested, text, tables, warnings, depth + 1);
                } else {
                    salvage(content, text, warnings);
                }
            } else {
                push_text(text, content);
            }
        }
        Value::Array(values) => {
            for item in values {
                walk(item, text, tables, warnings, depth + 1);
            }
        }
        Value::Object(map) => {
            // The top-level text may only be a heading. Never discard text nested
            // in OCR blocks or table objects when a provider changes its schema.
            for key in ["text", "content", "tables"] {
                if let Some(value) = map.get(key) {
                    walk(value, text, tables, warnings, depth + 1);
                }
            }
            if let Some(items) = map.get("warnings").and_then(Value::as_array) {
                warnings.extend(items.iter().filter_map(Value::as_str).map(str::to_owned));
            }
            if let Some(rows) = map.get("rows").and_then(Value::as_array) {
                if let Some(title) = map.get("title").and_then(Value::as_str) {
                    push_text(text, title);
                }
                let grid = rows
                    .iter()
                    .map(|row| {
                        row.as_array().and_then(|cells| {
                            cells.iter().map(cell_text).collect::<Option<Vec<_>>>()
                        })
                    })
                    .collect::<Option<Vec<Vec<String>>>>();
                if let Some(rows) =
                    grid.filter(|rows| !rows.is_empty() && rows.iter().all(|row| !row.is_empty()))
                {
                    for row in &rows {
                        let declared_text = map.get("text").and_then(Value::as_str).unwrap_or("");
                        if !row.iter().all(|cell| {
                            cell.trim().is_empty() || declared_text.contains(cell.trim())
                        }) {
                            push_text(text, &row.join("\t"));
                        }
                    }
                    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
                    if rows.iter().any(|row| row.len() != width) {
                        warnings.push("表格行列不齐，未推测缺失单元格，请对照扫描件重试。".into());
                    } else {
                        tables.push(json!({"title":map.get("title").and_then(Value::as_str).unwrap_or(""),"rows":rows}));
                    }
                } else {
                    warnings.push(
                        "模型未返回可确认的表格行列，已保留可读取的文字，请重新识别本页。".into(),
                    );
                    walk(
                        &Value::Array(rows.clone()),
                        text,
                        &mut vec![],
                        warnings,
                        depth + 1,
                    );
                }
            }
            for (key, child) in map {
                if matches!(
                    key.as_str(),
                    "text" | "content" | "tables" | "rows" | "warnings" | "title" | "id" | "engine"
                ) {
                    continue;
                }
                // Coordinates can contain nested OCR blocks, but scalar numbers
                // and metadata strings must never become document text.
                if child.is_object() {
                    walk(child, text, tables, warnings, depth + 1);
                } else if let Some(items) = child.as_array() {
                    for item in items
                        .iter()
                        .filter(|item| item.is_array() || item.is_object())
                    {
                        walk(item, text, tables, warnings, depth + 1);
                    }
                }
            }
        }
        _ => {}
    }
}

fn salvage(raw: &str, text: &mut String, warnings: &mut Vec<String>) {
    // Recover only fully quoted, independently valid JSON strings. Malformed
    // coordinates and truncated strings are not repaired or guessed.
    let re = Regex::new(r#""(?:text|content|title)"\s*:\s*("(?:\\.|[^"\\])*")"#).unwrap();
    for captures in re.captures_iter(raw) {
        if let Ok(value) = serde_json::from_str::<String>(&captures[1]) {
            if looks_like_ocr_payload(&value) {
                let nested = readable_ocr_content(&value);
                push_text(text, nested["text"].as_str().unwrap_or(""));
            } else {
                push_text(text, &value);
            }
        }
    }
    warnings
        .push("模型返回的结构不完整，仅恢复可确认的文字；本页可能缺少内容，请重新识别。".into());
}

fn html_tables(raw: &str, tables: &mut Vec<Value>, warnings: &mut Vec<String>) -> String {
    let table_re = Regex::new(r"(?is)<table\b[^>]*>.*?</table\s*>").unwrap();
    let openings = Regex::new(r"(?i)<table\b").unwrap().find_iter(raw).count();
    if openings != table_re.find_iter(raw).count() {
        warnings.push("表格标记不完整，已保留可读取文字，请重新识别本页。".into());
    }
    let row_re = Regex::new(r"(?is)<tr\b[^>]*>(.*?)</tr\s*>").unwrap();
    let caption_re = Regex::new(r"(?is)<caption\b[^>]*>(.*?)</caption\s*>").unwrap();
    let cell_re = Regex::new(r"(?is)<t[dh]\b([^>]*)>(.*?)</t[dh]\s*>").unwrap();
    let row_open_re = Regex::new(r"(?i)<tr\b").unwrap();
    let cell_open_re = Regex::new(r"(?i)<t[dh]\b").unwrap();
    let span_re = Regex::new(r#"(?i)\b(rowspan|colspan)\s*=\s*["']?(\d+)"#).unwrap();
    let mut body = String::new();
    let mut previous = 0;
    for found in table_re.find_iter(raw) {
        body.push_str(&plain_html(&raw[previous..found.start()]));
        body.push('\n');
        previous = found.end();
        let title = caption_re
            .captures_iter(found.as_str())
            .map(|caption| plain_html(&caption[1]))
            .filter(|caption| !caption.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let mut grid: Vec<Vec<String>> = vec![];
        let mut occupied: Vec<Vec<bool>> = vec![];
        let mut invalid = row_open_re.find_iter(found.as_str()).count()
            != row_re.captures_iter(found.as_str()).count();
        let mut merged = false;
        for (r, row) in row_re.captures_iter(found.as_str()).enumerate() {
            if cell_open_re.find_iter(&row[1]).count() != cell_re.captures_iter(&row[1]).count() {
                invalid = true;
                break;
            }
            if r >= 10000 {
                invalid = true;
                break;
            }
            while grid.len() <= r {
                grid.push(vec![]);
                occupied.push(vec![]);
            }
            let mut col = 0;
            for cell in cell_re.captures_iter(&row[1]) {
                while occupied[r].get(col).copied().unwrap_or(false) {
                    col += 1;
                }
                let (mut rowspan, mut colspan) = (1usize, 1usize);
                for span in span_re.captures_iter(&cell[1]) {
                    let size = span[2].parse::<usize>().unwrap_or(0);
                    if span[1].eq_ignore_ascii_case("rowspan") {
                        rowspan = size;
                    } else {
                        colspan = size;
                    }
                }
                if rowspan == 0 || colspan == 0 || r + rowspan > 10000 || col + colspan > 1000 {
                    invalid = true;
                    break;
                }
                merged |= rowspan > 1 || colspan > 1;
                while grid.len() < r + rowspan {
                    grid.push(vec![]);
                    occupied.push(vec![]);
                }
                for rr in r..r + rowspan {
                    let grid_width = grid[rr].len().max(col + colspan);
                    let occupied_width = occupied[rr].len().max(col + colspan);
                    grid[rr].resize(grid_width, String::new());
                    occupied[rr].resize(occupied_width, false);
                    for cc in col..col + colspan {
                        if occupied[rr][cc] {
                            invalid = true;
                        }
                        occupied[rr][cc] = true;
                    }
                }
                grid[r][col] = plain_html(&cell[2]);
                col += colspan;
            }
            if invalid {
                break;
            }
        }
        if invalid || grid.is_empty() || grid.iter().all(Vec::is_empty) {
            body.push_str(&plain_html(found.as_str()));
            warnings.push("表格结构无法确认，已保留文字，请对照扫描件重新识别。".into());
        } else {
            if !title.is_empty() {
                body.push_str(&title);
                body.push('\n');
            }
            let width = grid.iter().map(Vec::len).max().unwrap_or(0);
            for row in &mut grid {
                row.resize(width, String::new());
                body.push_str(&row.join("\t"));
                body.push('\n');
            }
            tables.push(json!({"title":title,"rows":grid}));
            if merged {
                warnings.push(
                    "表格合并单元格已展开为原行列位置，文字保留在左上格；请核对合并区域。".into(),
                );
            }
        }
    }
    body.push_str(&plain_html(&raw[previous..]));
    body.trim().to_owned()
}

fn markdown_tables(raw: &str, tables: &mut Vec<Value>) -> String {
    fn cells(line: &str) -> Vec<String> {
        let mut cells = vec![];
        let mut current = String::new();
        let mut escaped = false;
        for c in line.trim().trim_matches('|').chars() {
            if escaped {
                current.push(c);
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '|' {
                cells.push(current.trim().to_owned());
                current.clear();
            } else {
                current.push(c);
            }
        }
        if escaped {
            current.push('\\');
        }
        cells.push(current.trim().to_owned());
        cells
    }
    let lines: Vec<_> = raw.lines().collect();
    let mut body = vec![];
    let mut i = 0;
    while i < lines.len() {
        let separator = lines.get(i + 1).map(|s| cells(s)).unwrap_or_default();
        if lines[i].contains('|')
            && separator.len() >= 2
            && separator.iter().all(|s| {
                s.trim_matches(':').len() >= 3 && s.trim_matches(':').chars().all(|c| c == '-')
            })
        {
            let mut rows = vec![cells(lines[i])];
            i += 2;
            while i < lines.len()
                && lines[i].contains('|')
                && cells(lines[i]).len() == rows[0].len()
            {
                rows.push(cells(lines[i]));
                i += 1;
            }
            for row in &rows {
                body.push(row.join("\t"));
            }
            tables.push(json!({"title":"","rows":rows}));
        } else {
            body.push(lines[i].to_owned());
            i += 1;
        }
    }
    body.join("\n")
}

pub(crate) fn readable_ocr_content(raw: &str) -> Value {
    let clean = unfence(raw);
    let mut text = String::new();
    let mut tables = vec![];
    let mut warnings = vec![];
    let structured = looks_like_ocr_payload(raw);
    if structured {
        match serde_json::from_str::<Value>(clean) {
            Ok(value) => walk(&value, &mut text, &mut tables, &mut warnings, 0),
            Err(_) => salvage(clean, &mut text, &mut warnings),
        }
    } else {
        text = clean.to_owned();
    }
    if text.to_ascii_lowercase().contains("<table") {
        text = html_tables(&text, &mut tables, &mut warnings);
    } else if Regex::new(r"(?i)<(?:html|body|p|div|br|h[1-6]|section)\b")
        .unwrap()
        .is_match(&text)
    {
        text = plain_html(&text);
    } else if !structured {
        text = markdown_tables(&text, &mut tables);
    }
    if text.contains("［无法辨认］") || text.contains("[无法辨认]") {
        warnings.push("本页包含无法辨认的文字，请对照扫描件核对。".into());
    }
    if text.contains("公式") || text.contains("\\frac") {
        warnings.push("本页涉及公式，请对照扫描件核对上下标、分数线和运算符；识别文字不作为可计算公式。".into());
    }
    warnings.sort();
    warnings.dedup();
    json!({"text":text,"tables":tables,"warnings":warnings})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formulas_are_preserved_verbatim_and_flagged_for_visual_review() {
        let raw = "还款公式：每期本息=本金 × (1+期利率)还款期数\n(1+期利率)还款期数 - 1";
        let result = readable_ocr_content(raw);
        assert_eq!(result["text"], raw);
        assert!(result["warnings"][0].as_str().unwrap().contains("上下标"));
    }
    #[test]
    fn html_caption_is_kept_in_document_body_and_table_title() {
        let result = readable_ocr_content(
            "合同正文<table><caption><strong>还款计划</strong> &amp; 附件</caption><tr><td>00123</td><td>6.00</td></tr></table>合同尾页",
        );
        assert_eq!(result["tables"][0]["title"], "还款计划 & 附件");
        assert_eq!(result["tables"][0]["rows"], json!([["00123", "6.00"]]));
        assert_eq!(
            result["text"],
            "合同正文\n还款计划 & 附件\n00123\t6.00\n合同尾页"
        );
        assert!(result["warnings"].as_array().unwrap().is_empty());
    }
    #[test]
    fn incomplete_html_table_is_not_claimed_as_complete() {
        let result = readable_ocr_content("正文<table><tr><td>00123</td></tr>");
        assert!(result["text"].as_str().unwrap().contains("00123"));
        assert!(result["tables"].as_array().unwrap().is_empty());
        assert!(result["warnings"][0].as_str().unwrap().contains("不完整"));
    }
    #[test]
    fn incomplete_html_cells_and_rows_keep_all_readable_text() {
        for raw in [
            "<table><tr><td>A</td><td>B</tr></table>",
            "<table><tr><td>A</td></tr><tr><td>B</td></table>",
        ] {
            let result = readable_ocr_content(raw);
            let text = result["text"].as_str().unwrap();
            assert!(text.contains('A') && text.contains('B'));
            assert!(result["tables"].as_array().unwrap().is_empty());
            assert!(!result["warnings"].as_array().unwrap().is_empty());
        }
    }
    #[test]
    fn nested_blocks_and_invalid_row_objects_keep_every_text_without_coordinates() {
        let result = readable_ocr_content(
            r#"```json
{"text":"标题","tables":[{"rows":[{"text":"第一条 00123"},{"text":"第二条 3.5%"}]}],"rotate_rect":[{"text":"第三条","pos_list":[1,2,3]}]}
```"#,
        );
        assert_eq!(
            result["text"],
            "标题\n\n第一条 00123\n\n第二条 3.5%\n\n第三条"
        );
        assert_eq!(result["tables"], json!([]));
        assert!(!result["warnings"].as_array().unwrap().is_empty());
    }
    #[test]
    fn malformed_coordinates_are_not_document_body() {
        let result = readable_ocr_content(
            r#"```json
{"text":"合同原文","rotate_rect":[498><890><73,707,90],"rows":[{"text":"后续条款\\内容"}],"content":"末页"}
```"#,
        );
        assert_eq!(result["text"], "合同原文\n\n后续条款\\内容\n\n末页");
        assert!(result["warnings"][0].as_str().unwrap().contains("不完整"));
        let truncated = readable_ocr_content("```json\n{\"text\":\"可确认原文\",\"text\":\"未结束");
        assert_eq!(truncated["text"], "可确认原文");
    }
    #[test]
    fn html_spans_keep_original_cell_positions_without_executing_markup() {
        let result = readable_ocr_content(
            "借款合同\n<table><tr><th rowspan='2'>账号</th><th colspan=2>金额</th></tr><tr><td>00123</td><td>6.00</td></tr></table>尾页",
        );
        assert_eq!(
            result["tables"][0]["rows"],
            json!([["账号", "金额", ""], ["", "00123", "6.00"]])
        );
        assert!(result["text"].as_str().unwrap().contains("尾页"));
        assert!(!result["text"].as_str().unwrap().contains("<td>"));
    }
    #[test]
    fn markdown_and_serialized_text_are_readable() {
        let result = readable_ocr_content("正文\n|项目|金额|\n|---|---|\n|A\\|B|00123|");
        assert_eq!(result["tables"][0]["rows"][1], json!(["A|B", "00123"]));
        let nested = json!({"text":json!({"text":"全文","tables":[{"rows":[["账号","0001"]]}]}).to_string()});
        let parsed = readable_ocr_content(&nested.to_string());
        assert!(parsed["text"].as_str().unwrap().contains("0001"));
        assert_eq!(parsed["tables"][0]["rows"][0][1], "0001");
    }
    #[test]
    fn repeated_clauses_and_cells_remain_in_source_order() {
        let result =
            readable_ocr_content(r#"[{"text":"收到"},{"text":"收到"},{"text":"收到款项"}]"#);
        assert_eq!(result["text"], "收到\n\n收到\n\n收到款项");
        let result = readable_ocr_content(
            r#"{"tables":[{"rows":[["同一值","同一值"],["同一值","同一值"]]}]}"#,
        );
        assert_eq!(result["text"], "同一值\t同一值\n\n同一值\t同一值");
        assert_eq!(result["tables"][0]["rows"].as_array().unwrap().len(), 2);
        let html = readable_ocr_content("<div>第一段</div><p>第二段<br>续行</p>");
        assert_eq!(html["text"], "第一段\n第二段\n续行");
    }
    #[test]
    fn table_heading_is_not_lost_when_top_level_text_only_contains_number() {
        let result = readable_ocr_content(
            r#"{"text":"编号001","tables":[{"title":"借款合同","rows":[{"text":"合同原文"}]}]}"#,
        );
        assert_eq!(result["text"], "编号001\n\n借款合同\n\n合同原文");
        let malformed =
            readable_ocr_content(r#"{"text":"编号001","tables":[{"title":"借款合同","rows":]bad}"#);
        assert_eq!(malformed["text"], "编号001\n\n借款合同");
    }
}
