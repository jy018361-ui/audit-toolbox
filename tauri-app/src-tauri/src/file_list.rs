use chrono::Local;
use rust_xlsxwriter::{Format, FormatUnderline, Formula, Workbook};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use walkdir::WalkDir;

use crate::{AppError, excel_merger::PauseCheckpoint};

type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportParams {
    source_dir: String,
    #[serde(default)]
    output_path: String,
}

#[derive(Debug, Clone)]
struct FileEntry {
    path: PathBuf,
    relative_parent: PathBuf,
    name: String,
}

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "file_list.scan" => {
            let source = required_source(&params)?;
            scan(&source)
        }
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到文件清单方法。",
            Some(method.into()),
        )),
    }
}

pub(crate) fn export(
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    let params: ExportParams = serde_json::from_value(params).map_err(|e| {
        error(
            "INVALID_ARGUMENT",
            "文件清单参数不完整。",
            Some(e.to_string()),
        )
    })?;
    let source = validate_source(Path::new(&params.source_dir))?;
    pause.wait()?;
    check_cancel(&cancel)?;
    progress("scan", 0, 1, "正在扫描文件夹…");
    let SourceScan {
        files,
        depth,
        skipped,
    } = walk_source(&source, &cancel)?;
    check_cancel(&cancel)?;

    let output = if params.output_path.trim().is_empty() {
        default_output_path(&source)
    } else {
        ensure_xlsx(PathBuf::from(params.output_path.trim()))
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let partial = partial_path(&output);
    let write_result = write_workbook(&source, &files, depth, &partial, progress, &cancel);
    if let Err(err) = write_result {
        let _ = fs::remove_file(&partial);
        return Err(err);
    }
    pause.wait()?;
    check_cancel(&cancel).inspect_err(|_| {
        let _ = fs::remove_file(&partial);
    })?;
    if output.exists() {
        fs::remove_file(&output).map_err(|e| {
            error(
                "OUTPUT_REPLACE_FAILED",
                "无法替换已有输出文件，请确认文件未被 Excel 占用。",
                Some(e.to_string()),
            )
        })?;
    }
    fs::rename(&partial, &output).map_err(io_error)?;
    Ok(json!({
        "sourceDir": source.to_string_lossy(),
        "fileCount": files.len(),
        "maxDepth": depth,
        "skippedPaths": skipped,
        "outputPaths": [output.to_string_lossy()],
    }))
}

/// 扫描的任务版：与 `scan` 同样的结果，但会报进度、可中途取消。
///
/// 短任务通道没有这两样东西，选错一个大目录（`C:\`、共享盘根目录）之后
/// 用户只能等它扫完或强杀程序。
pub(crate) fn scan_job(
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    let source = required_source(&params)?;
    progress("scan", 0, 1, "正在扫描文件夹…");
    let value = scan_with_cancel(&source, &cancel)?;
    pause.wait()?;
    check_cancel(&cancel)?;
    progress("completed", 1, 1, "扫描完成");
    Ok(value)
}

fn scan(source: &Path) -> Result<Value, AppError> {
    scan_with_cancel(source, &AtomicBool::new(false))
}

fn scan_with_cancel(source: &Path, cancel: &AtomicBool) -> Result<Value, AppError> {
    let SourceScan {
        files,
        depth,
        skipped,
    } = walk_source(source, cancel)?;
    let preview = files.iter().take(50).map(|entry| json!({
        "name": entry.name,
        "relativePath": entry.path.strip_prefix(source).unwrap_or(&entry.path).to_string_lossy(),
        "fullPath": entry.path.to_string_lossy(),
        "levels": folder_levels(source, entry),
    })).collect::<Vec<_>>();
    Ok(json!({
        "sourceDir": source.to_string_lossy(),
        "rootName": source.file_name().unwrap_or_default().to_string_lossy(),
        "fileCount": files.len(),
        "maxDepth": depth,
        "skippedPaths": skipped,
        "preview": preview,
        "previewLimit": 50,
        "outputPath": default_output_path(source).to_string_lossy(),
    }))
}

fn required_source(params: &Value) -> Result<PathBuf, AppError> {
    let value = params
        .get("sourceDir")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if value.is_empty() {
        return Err(error("INVALID_ARGUMENT", "请选择要扫描的文件夹。", None));
    }
    validate_source(Path::new(value))
}

fn validate_source(source: &Path) -> Result<PathBuf, AppError> {
    let source = source.canonicalize().map_err(|e| {
        error(
            "SOURCE_NOT_FOUND",
            "选定的文件夹不存在或无法访问。",
            Some(e.to_string()),
        )
    })?;
    if !source.is_dir() {
        return Err(error(
            "SOURCE_NOT_DIRECTORY",
            "请选择文件夹，不是单个文件。",
            Some(source.display().to_string()),
        ));
    }
    Ok(clean_windows_path(source))
}

/// Everything one walk of the source tree produces.
struct SourceScan {
    files: Vec<FileEntry>,
    depth: usize,
    /// Directories the walker could not read.  Legacy skipped these silently;
    /// aborting the whole run instead makes the tool unusable on a share that
    /// contains a single private folder, so skip and report them.
    skipped: Vec<String>,
}

fn walk_source(source: &Path, cancel: &AtomicBool) -> Result<SourceScan, AppError> {
    let mut files = Vec::new();
    let mut depth = 0;
    let mut skipped = Vec::new();
    // Do not add an explicit sort: legacy os.walk exported the filesystem's
    // traversal order. Keeping that order also avoids an expensive global sort.
    for (visited, item) in WalkDir::new(source)
        .follow_links(false)
        .into_iter()
        .enumerate()
    {
        // 走一棵大目录树可能要几分钟，取消必须在遍历过程中生效，
        // 否则"取消"按钮要等整棵树扫完才响应。
        if visited % 512 == 0 {
            check_cancel(cancel)?;
        }
        let item = match item {
            Ok(item) => item,
            Err(err) => {
                let path = err
                    .path()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| source.display().to_string());
                if !skipped.contains(&path) {
                    skipped.push(path);
                }
                continue;
            }
        };
        if item.file_type().is_dir() {
            depth = depth.max(item.depth());
        }
        if !item.file_type().is_file() && !(item.file_type().is_symlink() && item.path().is_file())
        {
            continue;
        }
        let path = item.path().to_path_buf();
        let relative_parent = path
            .parent()
            .unwrap_or(source)
            .strip_prefix(source)
            .unwrap_or(Path::new(""))
            .to_path_buf();
        files.push(FileEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path,
            relative_parent,
        });
    }
    Ok(SourceScan {
        files,
        depth,
        skipped,
    })
}

fn write_workbook(
    source: &Path,
    files: &[FileEntry],
    depth: usize,
    output: &Path,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    // The legacy workbook used Excel's default Sheet1 name.
    sheet.set_name("Sheet1").map_err(xlsx_error)?;
    let link = Format::new()
        .set_font_color("#0000FF")
        .set_underline(FormatUnderline::Single);
    for column in 0..=depth {
        sheet
            .write_string(0, column as u16, format!("{}级文件夹", column + 1))
            .map_err(xlsx_error)?;
    }
    let file_col = depth + 1;
    sheet
        .write_string(0, file_col as u16, "文件名称")
        .map_err(xlsx_error)?;
    sheet
        .write_string(0, (file_col + 1) as u16, "超链接")
        .map_err(xlsx_error)?;
    sheet
        .write_string(0, (file_col + 2) as u16, "文件路径")
        .map_err(xlsx_error)?;

    let total = files.len();
    for (index, entry) in files.iter().enumerate() {
        if index % 100 == 0 {
            check_cancel(cancel)?;
        }
        let row = (index + 1) as u32;
        for (column, value) in folder_levels(source, entry).iter().enumerate() {
            sheet
                .write_string(row, column as u16, value)
                .map_err(xlsx_error)?;
        }
        sheet
            .write_string(row, file_col as u16, &entry.name)
            .map_err(xlsx_error)?;
        let formula = hyperlink_formula(&entry.path, &entry.name);
        if sheet
            .write_formula_with_format(
                row,
                (file_col + 1) as u16,
                Formula::new(formula).set_result(&entry.name),
                &link,
            )
            .is_err()
        {
            // Legacy code deliberately fell back to plain text when Excel
            // rejected an overlong or otherwise invalid hyperlink.
            sheet
                .write_string(row, (file_col + 1) as u16, &entry.name)
                .map_err(xlsx_error)?;
        }
        sheet
            .write_string(row, (file_col + 2) as u16, entry.path.to_string_lossy())
            .map_err(xlsx_error)?;
        if index + 1 == total || (index + 1) % 100 == 0 {
            progress(
                "export",
                index + 1,
                total.max(1),
                &format!("正在写入 {}/{}", index + 1, total),
            );
        }
    }
    workbook.save(output).map_err(xlsx_error)
}

fn folder_levels(source: &Path, entry: &FileEntry) -> Vec<String> {
    let mut levels = vec![
        source
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    ];
    levels.extend(
        entry
            .relative_parent
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned()),
    );
    levels
}

fn default_output_path(source: &Path) -> PathBuf {
    let root = source.file_name().unwrap_or_default().to_string_lossy();
    let name = format!("{}List-{}.xlsx", root, Local::now().format("%Y%m%d%H%M"));
    source.parent().unwrap_or(source).join(name)
}

fn ensure_xlsx(mut path: PathBuf) -> PathBuf {
    if path
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| !v.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(true)
    {
        path.set_extension("xlsx");
    }
    path
}

fn partial_path(output: &Path) -> PathBuf {
    let mut name = output.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    output.with_file_name(name)
}

fn hyperlink_formula(path: &Path, display: &str) -> String {
    let target = path.to_string_lossy().replace('"', "\"\"");
    let label = display.replace('"', "\"\"");
    format!("=HYPERLINK(\"{target}\",\"{label}\")")
}

fn clean_windows_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(error("JOB_CANCELLED", "任务已取消。", None))
    } else {
        Ok(())
    }
}

fn io_error(err: std::io::Error) -> AppError {
    error(
        "FILE_IO_FAILED",
        "无法读写文件，请检查路径权限和文件占用状态。",
        Some(err.to_string()),
    )
}

fn xlsx_error(err: rust_xlsxwriter::XlsxError) -> AppError {
    error(
        "WORKBOOK_WRITE_FAILED",
        "无法生成 Excel 文件，请确认输出文件未被占用。",
        Some(err.to_string()),
    )
}

fn error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, false, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{Reader, open_workbook_auto};
    use std::io::{Read, Write};

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "audit-toolbox-file-list-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn scans_nested_unicode_files_and_reports_legacy_depth() {
        let root = temp_root("scan").join("中文目录");
        fs::create_dir_all(root.join("一级").join("二级")).unwrap();
        fs::create_dir_all(root.join("空目录").join("更深").join("三级")).unwrap();
        fs::write(root.join("根目录.txt"), b"root").unwrap();
        fs::write(root.join("一级").join("二级").join("样例.txt"), b"sample").unwrap();
        let value = call("file_list.scan", json!({"sourceDir":root})).unwrap();
        assert_eq!(value["fileCount"], 2);
        assert_eq!(value["maxDepth"], 3);
        let nested = value["preview"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == "样例.txt")
            .unwrap();
        assert_eq!(nested["levels"], json!(["中文目录", "一级", "二级"]));
    }

    #[test]
    fn exports_dynamic_hierarchy_and_real_hyperlinks() {
        let base = temp_root("export");
        let root = base.join("客户资料");
        fs::create_dir_all(root.join("A").join("B")).unwrap();
        fs::write(root.join("根.txt"), b"root").unwrap();
        let mut file =
            fs::File::create(root.join("A").join("B").join("含空格 与 中文.txt")).unwrap();
        writeln!(file, "sample").unwrap();
        let output = base.join("清单.xlsx");
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = export(
            json!({"sourceDir":root,"outputPath":output}),
            &|_, _, _, _| {},
            cancel,
            &pause,
        )
        .unwrap();
        assert_eq!(result["fileCount"], 2);
        let mut workbook = open_workbook_auto(&output).unwrap();
        let range = workbook.worksheet_range("Sheet1").unwrap();
        assert_eq!(range.get_value((0, 0)).unwrap().to_string(), "1级文件夹");
        assert_eq!(range.get_value((0, 2)).unwrap().to_string(), "3级文件夹");
        assert_eq!(range.get_value((0, 3)).unwrap().to_string(), "文件名称");
        let mut archive = zip::ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
        let mut worksheet_xml = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut worksheet_xml)
            .unwrap();
        assert!(worksheet_xml.contains("HYPERLINK("));
        assert!(worksheet_xml.contains("<c r=\"E"));
        assert!(worksheet_xml.contains("含空格 与 中文.txt"));
        assert!(!worksheet_xml.contains("<autoFilter"));
        assert!(!worksheet_xml.contains("<pane"));
        assert!(
            archive
                .by_name("xl/worksheets/_rels/sheet1.xml.rels")
                .is_err()
        );
    }

    #[test]
    fn cancellation_does_not_leave_partial_output() {
        let base = temp_root("cancel");
        let root = base.join("source");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), b"a").unwrap();
        let output = base.join("cancelled.xlsx");
        let cancel = Arc::new(AtomicBool::new(true));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = export(
            json!({"sourceDir":root,"outputPath":output}),
            &|_, _, _, _| {},
            cancel,
            &pause,
        );
        assert!(result.is_err());
        assert!(!output.exists());
        assert!(!partial_path(&output).exists());
    }
}
