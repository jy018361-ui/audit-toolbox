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

pub(crate) fn has_latex_layout(raw: &str) -> bool {
    [r"\text", r"\boxed", r"\begin{", r"\mbox", r"\displaylines", r"\underline", r"\%", r"\(", r"\["].iter().any(|tag| raw.contains(tag))
}

pub(crate) fn has_markdown_heading(raw: &str) -> bool {
    Regex::new(r"(?m)^ {0,3}#{1,6}[\t ]+[^\r\n]+").unwrap().is_match(raw)
}

pub(crate) fn has_image_markup(raw: &str) -> bool {
    raw.contains("![")
}

// Document parsing returns cropped figures as Markdown images whose targets
// may contain signed transport credentials. They are not recognized document
// text. Keep descriptive alt text, but do not expose generated hash filenames.
// Ordinary links and URLs in the business text are deliberately untouched.
fn readable_images(raw: &str) -> String {
    if !has_image_markup(raw) { return raw.to_owned(); }
    let starts = Regex::new(r"!\[((?:\\.|[^\]\\\r\n])*)\]\(").unwrap();
    let generated = Regex::new(r"(?i)^[a-f0-9]{16,64}\.(?:jpe?g|png|gif|bmp|tiff?|webp)$").unwrap();
    let mut out = String::new();
    let mut previous = 0;
    for capture in starts.captures_iter(raw) {
        let found = capture.get(0).unwrap();
        if found.start() < previous { continue; }
        let mut depth = 1usize;
        let mut escaped = false;
        let mut end = None;
        for (offset, ch) in raw[found.end()..].char_indices() {
            if matches!(ch, '\r' | '\n') { break; }
            if escaped { escaped = false; continue; }
            if ch == '\\' { escaped = true; continue; }
            if ch == '(' { depth += 1; }
            if ch == ')' {
                depth -= 1;
                if depth == 0 { end = Some(found.end() + offset + 1); break; }
            }
        }
        let Some(end) = end else { continue; };
        out.push_str(&raw[previous..found.start()]);
        let alt = capture[1].trim();
        if !generated.is_match(alt) { out.push_str(alt); }
        previous = end;
    }
    out.push_str(&raw[previous..]);
    out.trim().to_owned()
}

// Decode only complete prose wrappers. This is deliberately not a TeX renderer:
// unknown commands, mathematical expressions and multi-column arrays survive
// verbatim, so cleaning layout can never silently erase a financial formula.
fn prose_layout(raw: &str, depth: usize) -> Option<String> {
    layout_sequence(raw, depth, false)
}

fn layout_sequence(raw: &str, depth: usize, literal_text: bool) -> Option<String> {
    if depth > 32 { return None; }
    fn group(raw: &str) -> Option<(&str, &str)> {
        let raw = raw.trim_start().strip_prefix('{')?;
        let mut depth = 1usize;
        let mut escaped = false;
        for (index, ch) in raw.char_indices() {
            if escaped { escaped = false; continue; }
            if ch == '\\' { escaped = true; continue; }
            if ch == '{' { depth += 1; }
            if ch == '}' { depth -= 1; }
            if depth == 0 { return Some((&raw[..index], &raw[index + 1..])); }
        }
        None
    }
    let mut remaining = raw.trim();
    let mut out = String::new();
    let mut found = false;
    while !remaining.is_empty() {
        if let Some(array) = remaining.strip_prefix(r"\begin{array}") {
            let (alignment, array) = group(array)?;
            if !matches!(alignment.trim(), "l" | "c" | "r") { return None; }
            let body = array.trim_end().strip_suffix(r"\end{array}")?;
            out.push_str(&prose_layout(body, depth + 1)?);
            remaining = "";
        } else if let Some(rest) = remaining.strip_prefix(r"\\") {
            out.push('\n');
            remaining = if literal_text { rest } else { rest.trim_start() };
        } else if remaining.starts_with('\\') && remaining.chars().nth(1).is_some_and(|c| {
            (literal_text && "%&#_${}".contains(c)) || (found && c == '%')
        }) {
            // TeX's escaped printable characters carry no mathematical
            // operation; retain their literal character in prose leaves.
            let escaped = remaining.chars().nth(1)?;
            out.push(escaped);
            remaining = &remaining[1 + escaped.len_utf8()..];
        } else if remaining.starts_with('\\') {
            let command = [r"\textbf", r"\textrm", r"\text", r"\mbox", r"\boxed", r"\underline"]
                .into_iter().find(|command| remaining.starts_with(command))?;
            let (body, rest) = group(&remaining[command.len()..])?;
            // Each known formatting wrapper may contain more wrappers. Only
            // their literal text leaves are emitted; unknown commands or math
            // make the whole expression survive verbatim, not a partial edit.
            out.push_str(&layout_sequence(body, depth + 1, command != r"\boxed")?);
            remaining = if literal_text { rest } else { rest.trim_start() };
        } else if literal_text {
            let end = remaining.find('\\').unwrap_or(remaining.len());
            let literal = &remaining[..end];
            if literal.contains(['{', '}', '$', '^', '_']) { return None; }
            out.push_str(literal);
            remaining = &remaining[end..];
        } else {
            return None;
        }
        found = true;
    }
    found.then(|| out.trim().to_owned())
}

fn readable_latex(raw: &str, warnings: &mut Vec<String>) -> String {
    if !has_latex_layout(raw) { return raw.to_owned(); }
    let spans = Regex::new(r"(?s)\$\$((?:\\.|[^$\\])+)\$\$|\$((?:\\.|[^$\\])+)\$|\\\((.*?)\\\)|\\\[(.*?)\\\]").unwrap();
    let result = spans.replace_all(raw, |captures: &regex::Captures<'_>| {
        let body = (1..=4).find_map(|i| captures.get(i)).unwrap().as_str();
        prose_layout(body, 0).or_else(|| percent_layout(body)).unwrap_or_else(|| captures[0].to_owned())
    }).into_owned();
    if has_latex_layout(&result) {
        warnings.push("本页含未能安全还原的排版或公式标记，已保留原内容，请对照扫描件核对。".into());
    }
    result
}

// Render only the escaped percent token and a complete numeric subscript.
// In particular, OCR's `\%_{0}` stays %₀ rather than being guessed to mean ‰;
// this projection must not change a unit or repair the model's numeric value.
fn percent_layout(raw: &str) -> Option<String> {
    let rest = raw.trim().strip_prefix(r"\%")?.trim();
    if rest.is_empty() { return Some("%".into()); }
    let subscript = rest.strip_prefix("_{")?.strip_suffix('}')?;
    if subscript.is_empty() { return None; }
    let mut out = String::from("%");
    for digit in subscript.chars() {
        out.push(match digit {
            '0' => '₀', '1' => '₁', '2' => '₂', '3' => '₃', '4' => '₄',
            '5' => '₅', '6' => '₆', '7' => '₇', '8' => '₈', '9' => '₉',
            _ => return None,
        });
    }
    Some(out)
}

fn readable_headings(raw: &str) -> String {
    // Recognize only standard, line-leading Markdown headings. An account's
    // literal '#', C# or a price containing '#' must not change.
    Regex::new(r"(?m)^ {0,3}#{1,6}[\t ]+([^\r\n]+)").unwrap()
        .replace_all(raw, "$1").into_owned()
}

/// Formatting-only projection for saved business fields. Unlike the provider
/// parser this never interprets JSON containers or changes their field keys.
pub(crate) fn readable_ocr_text(raw: &str) -> String {
    readable_headings(&readable_latex(&readable_images(raw), &mut vec![]))
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
                if let Some(mut rows) =
                    grid.filter(|rows| !rows.is_empty() && rows.iter().all(|row| !row.is_empty()))
                {
                    if normalize_markdown_totals(&mut rows) {
                        warnings.push("表格重复的合计标签已按汇总行整理，数字未改写；请核对原表合并区域。".into());
                    }
                    let mut body_tables = vec![];
                    if has_markdown_table(text) { markdown_tables(text, &mut body_tables, &mut vec![]); }
                    let covered = body_tables.iter().filter(|table| table["rows"] == json!(rows)).count()
                        > tables.iter().filter(|table| table["rows"] == json!(rows)).count();
                    for row in &rows {
                        let declared_text = map.get("text").and_then(Value::as_str).unwrap_or("");
                        if !covered && !row.iter().all(|cell| {
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

fn markdown_cells(line: &str) -> Vec<String> {
        let mut cells = vec![];
        let mut current = String::new();
        // Only the outer border is syntax. Every additional pipe represents
        // an actual empty cell, including the last cells of a sparse row.
        let line = line.trim();
        let mut chars = line.strip_prefix('|').unwrap_or(line).chars().peekable();
        let mut ended_with_border = false;
        while let Some(c) = chars.next() {
            ended_with_border = false;
            if c == '\\' && matches!(chars.peek(), Some('|' | '\\')) {
                current.push(chars.next().unwrap());
            } else if c == '|' {
                cells.push(current.trim().to_owned());
                current.clear();
                ended_with_border = chars.peek().is_none();
            } else {
                current.push(c);
            }
        }
        if !ended_with_border { cells.push(current.trim().to_owned()); }
        cells
}

fn markdown_separator(line: &str) -> bool {
    let cells = markdown_cells(line);
    cells.len() >= 2 && cells.iter().all(|s| {
        let s = s.trim_matches(':');
        s.len() >= 3 && s.chars().all(|c| c == '-')
    })
}

fn markdown_header(lines: &[&str], start: usize) -> Option<(usize, Vec<String>)> {
    if !lines[start].contains('|') { return None; }
    // Some document parsers put signature/address cells on multiple physical
    // lines before their separator. Require the complete row's column count;
    // never discard those line breaks or combine arbitrary prose into cells.
    let mut size = lines[start].len();
    for separator in start + 1..lines.len().min(start + 201) {
        if separator > start + 1 && !lines[start].trim_start().starts_with('|') { return None; }
        size += lines[separator].len();
        if size > 64_000 { return None; }
        if markdown_separator(lines[separator]) {
            let header = markdown_cells(&lines[start..separator].join("\n"));
            return (header.len() == markdown_cells(lines[separator]).len()).then_some((separator, header));
        }
    }
    None
}

pub(crate) fn has_markdown_table(raw: &str) -> bool {
    let lines = raw.lines().collect::<Vec<_>>();
    (0..lines.len()).any(|i| markdown_header(&lines, i).is_some())
}

fn normalize_markdown_totals(rows: &mut [Vec<String>]) -> bool {
    let Some(header) = rows.first().cloned() else { return false; };
    let mut changed = false;
    for row in rows.iter_mut().skip(1) {
        // The provider can repeat the same merged summary caption into every
        // column. Restrict recovery to explicit totals, never ordinary values.
        let full_caption = row.len() >= 3 && !row[0].is_empty()
            && (row[0].starts_with("合计人民币金额") || row[0].starts_with("价税合计（大写）") || row[0].starts_with("价税合计(大写)"))
            && row.iter().all(|cell| cell == &row[0]);
        let prefix = row.iter().take_while(|cell| matches!(cell.as_str(), "合计" | "合计：" | "合计:" | "总计" | "总计：" | "总计:")).count();
        let remaining = row.iter().enumerate().skip(prefix).filter(|(_, cell)| !cell.is_empty()).collect::<Vec<_>>();
        let total_prefix = prefix >= 3 && remaining.len() == 1
            && header.get(remaining[0].0).is_some_and(|label| label.contains("金额") || label.contains("总价"))
            && remaining[0].1.chars().all(|c| c.is_ascii_digit() || ",.，￥¥ ".contains(c));
        if full_caption || total_prefix {
            let end = if full_caption { row.len() } else { prefix };
            for cell in &mut row[1..end] { cell.clear(); }
            changed = true;
        }
    }
    changed
}

fn markdown_tables(raw: &str, tables: &mut Vec<Value>, warnings: &mut Vec<String>) -> String {
    let lines: Vec<_> = raw.lines().collect();
    let mut body = vec![];
    let mut i = 0;
    while i < lines.len() {
        if let Some((separator, header)) = markdown_header(&lines, i) {
            let mut rows = vec![header];
            i = separator + 1;
            while i < lines.len()
                && lines[i].contains('|')
                && markdown_cells(lines[i]).len() == rows[0].len()
            {
                rows.push(markdown_cells(lines[i]));
                i += 1;
            }
            if lines.get(i).is_some_and(|line| line.trim_start().starts_with('|')) {
                warnings.push("表格行列不齐，未推测缺失单元格，已保留剩余原文供核对。".into());
            }
            if normalize_markdown_totals(&mut rows) {
                warnings.push("表格重复的合计标签已按汇总行整理，数字未改写；请核对原表合并区域。".into());
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
    text = readable_images(&text);
    if text.to_ascii_lowercase().contains("<table") {
        text = html_tables(&text, &mut tables, &mut warnings);
    } else if Regex::new(r"(?i)<(?:html|body|p|div|br|h[1-6]|section)\b")
        .unwrap()
        .is_match(&text)
    {
        text = plain_html(&text);
    }
    // A JSON envelope may itself contain Markdown; the envelope is not a
    // reason to bypass table decoding. Match native grids by occurrence so a
    // text/native duplicate is not exported twice, while repeated real tables
    // remain distinct.
    let native = tables.clone();
    let mut recovered = vec![];
    text = markdown_tables(&text, &mut recovered, &mut warnings);
    let mut matched = vec![false; native.len()];
    for table in recovered {
        if let Some(index) = native.iter().enumerate().position(|(index, existing)| !matched[index] && existing["rows"] == table["rows"]) {
            matched[index] = true;
        } else { tables.push(table); }
    }
    text = readable_headings(&readable_latex(&text, &mut warnings));
    for table in &mut tables {
        if let Some(title) = table.get("title").and_then(Value::as_str).map(str::to_owned) {
            table["title"] = json!(readable_headings(&readable_latex(&readable_images(&title), &mut warnings)));
        }
        if let Some(rows) = table.get_mut("rows").and_then(Value::as_array_mut) {
            for cell in rows.iter_mut().filter_map(Value::as_array_mut).flatten() {
                if let Some(raw) = cell.as_str() { *cell = json!(readable_headings(&readable_latex(&readable_images(raw), &mut warnings))); }
            }
        }
    }
    if text.contains('\u{fffd}') {
        warnings.push("本页含无法解码的字符，未猜测替换，请重新识别并核对原扫描件。".into());
    }
    if text.contains("［无法辨认］") || text.contains("[无法辨认]") {
        warnings.push("本页包含无法辨认的文字，请对照扫描件核对。".into());
    }
    if text.contains("公式") || text.contains("\\frac") || text.contains(r"\(") || text.contains(r"\[") {
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
    fn escaped_percent_subscript_is_readable_without_guessing_unit_or_value() {
        let raw = r"提前还款金额 × 剩余借款期限（月数）× 1 \(\%_{0}\)，剩余借款月数";
        let expected = "提前还款金额 × 剩余借款期限（月数）× 1 %₀，剩余借款月数";
        assert_eq!(readable_ocr_content(raw)["text"], expected);
        assert_eq!(readable_ocr_text(raw), expected);
        assert_eq!(readable_ocr_text(expected), expected);
        for (raw, expected) in [(r"$\%$", "%"), (r"$$\%_{0123456789}$$", "%₀₁₂₃₄₅₆₇₈₉")] {
            assert_eq!(readable_ocr_text(raw), expected);
        }
        for raw in [r"\(\%_{x}\)", r"\(\%_{}\)", r"\(\%_{0}+x\)", r"\(\%_{0\)", r"\(\%_{0}\unknown{a}\)"] {
            assert_eq!(readable_ocr_text(raw), raw);
        }
        let table = readable_ocr_content(&json!({"tables":[{"rows":[[raw]]}]}).to_string());
        assert_eq!(table["tables"][0]["rows"][0][0], expected);
    }
    #[test]
    fn numeric_underline_with_escaped_percentage_is_readable_but_math_survives() {
        let raw = r"一、本合同项下委托贷款年利率为\(\underline{4.35}\%\)。账号\(\underline{00123}\)，期限\(\underline{15}\)日。";
        let expected = "一、本合同项下委托贷款年利率为4.35%。账号00123，期限15日。";
        let parsed = readable_ocr_content(raw);
        assert_eq!(parsed["text"], expected);
        assert_eq!(parsed["warnings"], json!([]));
        assert_eq!(readable_ocr_text(raw), expected);
        for math in [r"\(\underline{x^2}\%\)", r"\(\underline{4.35}\%+x\)", r"\(\underline{4.35}\frac{1}{2}\)"] {
            assert_eq!(readable_ocr_text(math), math);
        }
        let parsed = readable_ocr_content(&json!({"tables":[{"title":raw,"rows":[[raw]]}]}).to_string());
        assert_eq!(parsed["tables"][0]["title"], expected);
        assert_eq!(parsed["tables"][0]["rows"][0][0], expected);
    }
    #[test]
    fn cropped_image_assets_do_not_become_business_text_or_drop_descriptive_alts() {
        // Minimal shape captured from Dev service report page 1; identifiers
        // and all signed resource values are synthetic, never live secrets.
        let image = "![f45ea213decf917ad56fbd384140eb47.jpeg](http://docmind-api-cn-hangzhou.oss-cn-hangzhou.aliyuncs.com/publicDocStreamStructure/sample/0.png?security-token=SYNTHETIC%2BVALUE&Signature=SYNTHETIC)";
        let raw = format!("{image}  \n\n{image}  \n\n服务请求报告\nSR编号：S000271646\n币种：CNY\n[业务网址](https://example.com/query?token=00123)\nhttps://example.com/contract/00123\n![合同还款计划（单位：元）](https://example.com/image(1).png)\n![合同签署页.png](relative/page.png)");
        let expected = "服务请求报告\nSR编号：S000271646\n币种：CNY\n[业务网址](https://example.com/query?token=00123)\nhttps://example.com/contract/00123\n合同还款计划（单位：元）\n合同签署页.png";
        assert_eq!(readable_ocr_content(&raw)["text"], expected);
        assert_eq!(readable_ocr_text(&raw), expected);
        assert_eq!(readable_ocr_text(expected), expected);
        assert_eq!(readable_ocr_text("![未闭合](https://example.com/x"), "![未闭合](https://example.com/x");
        let parsed = readable_ocr_content(&json!({"tables":[{"title":image,"rows":[[image,"00123"]]}]}).to_string());
        assert_eq!(parsed["tables"][0]["title"], "");
        assert_eq!(parsed["tables"][0]["rows"][0], json!(["", "00123"]));
    }
    #[test]
    fn nested_prose_styles_keep_amounts_dates_and_internal_word_spacing() {
        for (raw, expected) in [
            (r"鉴于\(\underline{\text{甲方项目（一期）建设需要}}\)，订立合同。", "鉴于甲方项目（一期）建设需要，订立合同。"),
            (r"金额\(\underline{\text{壹亿伍仟伍佰万元整}}\)。", "金额壹亿伍仟伍佰万元整。"),
            (r"\(\underline{\text{玖拾肆个月}}\)，从\(\text{\underline{2022年9月5}}\)日起。", "玖拾肆个月，从2022年9月5日起。"),
            (r"$\text{Borrower \textbf{Alpha} Company}$", "Borrower Alpha Company"),
            (r"$\text{利率\underline{3.5}\%，账号\textbf{00123}}$", "利率3.5%，账号00123"),
            (r"$\text{实付\$100，A\&B，编号\#001，路径A\_B}$", "实付$100，A&B，编号#001，路径A_B"),
        ] {
            let parsed = readable_ocr_content(raw);
            assert_eq!(parsed["text"], expected);
            assert_eq!(parsed["warnings"], json!([]));
            assert_eq!(readable_ocr_content(expected)["text"], expected);
        }
        let table = readable_ocr_content(r#"{"text":"正文","tables":[{"rows":[["\\(\\underline{\\text{00123}}\\)","\\(\\text{\\underline{50000}}\\)"]]}]}"#);
        assert_eq!(table["tables"][0]["rows"][0], json!(["00123", "50000"]));
    }
    #[test]
    fn headings_are_plain_text_without_touching_contract_hash_characters() {
        let raw = "# 第一条 借款金额\n\n## 账号#001\nC#项目：#001\n####### 非标题\n金额为#100";
        assert_eq!(readable_ocr_content(raw)["text"], "第一条 借款金额\n\n账号#001\nC#项目：#001\n####### 非标题\n金额为#100");
        assert!(has_markdown_heading(raw));
        assert!(!has_markdown_heading("C#项目：#001"));
    }
    #[test]
    fn nested_formula_and_unbalanced_wrappers_survive_whole() {
        for raw in [r"\(\underline{\text{利率}\frac{1}{2}}\)", r"\(\text{\underline{x^2}}\)",
            r"\(\underline{\text{未闭合}\)", r"\(\underline{\text{正文}\unknown{内容}}\)"] {
            let parsed = readable_ocr_content(raw);
            assert_eq!(parsed["text"], raw);
            assert!(!parsed["warnings"].as_array().unwrap().is_empty());
        }
        let nested = format!("\\({}文字{}\\)", r"\underline{".repeat(40), "}".repeat(40));
        assert_eq!(readable_ocr_content(&nested)["text"], nested);
    }
    #[test]
    fn prose_latex_wrappers_are_readable_without_altering_contract_symbols() {
        let raw = r"$\text { 编号：000123 }$

$\boxed{\begin{array}{l}\text { 重要提示 } \\\text { 先决条件：负债率≤65%，金额1,000.00元。 } \\\text { 同意后方可转让▲▲。 }\end{array}}$";
        let result = readable_ocr_content(raw);
        assert_eq!(result["text"], "编号：000123\n\n重要提示\n先决条件：负债率≤65%，金额1,000.00元。\n同意后方可转让▲▲。");
        assert_eq!(result["warnings"], json!([]));
        assert_eq!(readable_ocr_content(r"\(\text{标题}\)")["text"], "标题");
        assert_eq!(readable_ocr_content(r"$$\boxed{\text{条款}}$$")["text"], "条款");
        assert_eq!(readable_ocr_content(r"投资限额人民币\(\underline{50000}\)万元，\(\underline{15}\)日内报送。")["text"], "投资限额人民币50000万元，15日内报送。");
    }
    #[test]
    fn mathematical_and_ambiguous_latex_is_not_deleted_or_guessed() {
        for raw in [r"$\frac{1}{2}\text{万元}$", r"$\text{利率}x^2$", r"$\text{未闭合$",
            r"$\boxed{\begin{array}{lr}\text{A}&\text{B}\end{array}}$",
            r"$\text{嵌套{括号}}$", r"$\unknown{未知内容}$", r"\(\underline{x^2}\)", r"\(\therefore(2i)^{6}i\)"] {
            let result = readable_ocr_content(raw);
            assert_eq!(result["text"], raw);
        }
        let malformed = readable_ocr_content(r"$\text{未闭合$");
        assert!(malformed["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("排版")));
        assert_eq!(readable_ocr_content("保费$100，余额$200；原文{A}\\路径")["text"], "保费$100，余额$200；原文{A}\\路径");
    }
    #[test]
    fn table_text_and_plain_text_use_identical_layout_decoding() {
        let result = readable_ocr_content(r#"{"text":"$\\text{金额}$","tables":[{"title":"$\\text{还款表}$","rows":[["$\\text{000123}$","$\\frac{1}{2}$"]]}]}"#);
        assert!(result["text"].as_str().unwrap().starts_with("金额"));
        assert_eq!(result["tables"][0]["title"], "还款表");
        assert_eq!(result["tables"][0]["rows"][0][0], "000123");
        assert_eq!(result["tables"][0]["rows"][0][1], r"$\frac{1}{2}$");
        assert!(!readable_ocr_content("无法解码：\u{fffd}")["warnings"].as_array().unwrap().is_empty());
    }
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
    fn sparse_markdown_keeps_every_empty_cell_and_decodes_json_text() {
        let raw = "电\n|序号|标的名称|备注|规格型号|生产厂家|计量单位|数量|单价|金额|交货时间|\n|---|---|---|---|---|---|---|---|---|---|\n|1|电力|||||1.401.048.00|0.57|801.175.29||\n|2||||||||||\n|3||||||||||\n|合计：|合计：|合计：|合计：|合计：|合计：|合计：|合计：|801，175.29||\n|合计人民币金额(大写)：捌拾万元|合计人民币金额(大写)：捌拾万元|合计人民币金额(大写)：捌拾万元|合计人民币金额(大写)：捌拾万元|合计人民币金额(大写)：捌拾万元|合计人民币金额(大写)：捌拾万元|合计人民币金额(大写)：捌拾万元|合计人民币金额(大写)：捌拾万元|合计人民币金额(大写)：捌拾万元|合计人民币金额(大写)：捌拾万元|\n合同正文";
        for source in [raw.to_owned(), json!({"text":raw,"tables":[]}).to_string()] {
            let parsed = readable_ocr_content(&source);
            let rows = parsed["tables"][0]["rows"].as_array().unwrap();
            assert_eq!(rows.len(), 6);
            assert!(rows.iter().all(|row| row.as_array().unwrap().len() == 10));
            assert_eq!(rows[1][6], "1.401.048.00"); // No numeric guess or arithmetic correction.
            assert_eq!(rows[1][9], "");
            assert_eq!(rows[2], json!(["2","","","","","","","","",""]));
            assert_eq!(rows[4], json!(["合计：","","","","","","","","801，175.29",""]));
            assert_eq!(rows[5][0], "合计人民币金额(大写)：捌拾万元");
            assert_eq!(rows[5].as_array().unwrap().iter().filter(|v| *v != "").count(), 1);
            assert!(!parsed["text"].as_str().unwrap().contains("|---"));
            assert!(parsed["text"].as_str().unwrap().ends_with("合同正文"));
        }
        assert_eq!(markdown_cells(r"|A\|B|\(\underline{00123}\)|"), vec!["A|B", r"\(\underline{00123}\)"]);
        assert!(has_markdown_table(raw));
        assert!(!has_markdown_table("合同编号A|B\n普通正文"));
    }
    #[test]
    fn json_markdown_and_native_grid_share_one_table_but_keep_real_repetitions() {
        let raw = "|名称|金额|\n|---|---|\n|相同值|相同值|\n|相同值|相同值|";
        let grid = json!([["名称","金额"],["相同值","相同值"],["相同值","相同值"]]);
        let parsed = readable_ocr_content(&json!({"text":raw,"tables":[{"rows":grid}]}).to_string());
        assert_eq!(parsed["tables"].as_array().unwrap().len(), 1);
        assert_eq!(parsed["tables"][0]["rows"], grid);
        assert_eq!(parsed["text"].as_str().unwrap().matches("相同值\t相同值").count(), 2);
        let repeated = readable_ocr_content(&format!("{raw}\n\n{raw}"));
        assert_eq!(repeated["tables"].as_array().unwrap().len(), 2);
        let malformed = readable_ocr_content("|名称|金额|\n|---|---|\n|不能确定|三|列|\n合同尾部");
        assert!(malformed["text"].as_str().unwrap().contains("不能确定|三|列"));
        assert!(!malformed["warnings"].as_array().unwrap().is_empty());
    }
    #[test]
    fn multiline_markdown_signature_cells_keep_addresses_and_paragraph_order() {
        let raw = "合同正文\n|出卖人：甲公司\n住所：甲地址\n账号：00123|买受人：乙公司\n住所：乙地址\n经办人：|鉴证机关：\n经办人：\n年 月 日|\n|---|---|---|\n\n合同尾部";
        assert!(has_markdown_table(raw));
        let parsed = readable_ocr_content(&json!({"text":raw,"tables":[]}).to_string());
        assert_eq!(parsed["tables"][0]["rows"], json!([["出卖人：甲公司\n住所：甲地址\n账号：00123","买受人：乙公司\n住所：乙地址\n经办人：","鉴证机关：\n经办人：\n年 月 日"]]));
        assert!(!parsed["text"].as_str().unwrap().contains('|'));
        assert!(parsed["text"].as_str().unwrap().starts_with("合同正文"));
        assert!(parsed["text"].as_str().unwrap().ends_with("合同尾部"));
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
