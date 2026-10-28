//! Standalone general OCR: toolbox configuration, revision-safe pages and optional extracts.
use crate::{
    AppError,
    excel_merger::PauseCheckpoint,
    ocr_store::{Page, Store, Table, failure, io_error},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{DynamicImage, ImageDecoder};
use serde_json::{Value, json};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecognitionTimings {
    setup_ms: f64,
    image_ms: f64,
    recognition_ms: f64,
    structure_ms: f64,
    save_ms: f64,
    worker_ms: f64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    http_requests: Vec<Value>,
}
fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn required<'a>(p: &'a Value, key: &str) -> Result<&'a str, AppError> {
    p.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| failure("OCR_INPUT_REQUIRED", &format!("缺少必要参数：{key}。")))
}
fn to_value<T: serde::Serialize>(v: T) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|_| failure("OCR_DATA", "OCR 数据无法序列化。"))
}
fn u32_param(p: &Value, key: &str) -> Result<u32, AppError> {
    p[key]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0)
        .ok_or_else(|| failure("OCR_PAGE_INVALID", "页码和总页数必须为有效正整数。"))
}
fn revision(p: &Value) -> Result<u64, AppError> {
    p["expectedRevision"]
        .as_u64()
        .ok_or_else(|| failure("OCR_REVISION_REQUIRED", "缺少页面版本，请刷新后重试。"))
}

pub(crate) fn call(
    method: &str,
    params: Value,
    db_path: &Path,
    settings: &Value,
) -> Result<Value, AppError> {
    if method == "ocr.config_status" {
        return crate::audipick::toolbox_ocr_status(settings);
    }
    let mut store = Store::open(db_path)?;
    match method {
        "ocr.projects" => Ok(json!({"projects":store.projects()?})),
        "ocr.project_save" => store.save_project(&params),
        "ocr.output_directory" => {
            let fallback = directories::UserDirs::new()
                .and_then(|dirs| dirs.download_dir().or_else(|| dirs.document_dir()).map(Path::to_path_buf))
                .unwrap_or_else(|| db_path.parent().unwrap_or(Path::new(".")).to_path_buf())
                .join("审计工具箱").join("OCR");
            output_directory(&store, required(&params, "projectId")?, &fallback)
        }
        "ocr.project_delete" => store.delete_project(required(&params, "id")?),
        "ocr.documents" => {
            Ok(json!({"documents":store.documents(required(&params,"projectId")?)?}))
        }
        "ocr.document_import" => import_documents(&store, &params),
        "ocr.document" => {
            let id = required(&params, "documentId")?;
            Ok(
                json!({"document":store.document(id)?,"pages":store.pages(id)?,"extractions":store.extractions(id)?}),
            )
        }
        "ocr.document_delete" => store.delete_document(required(&params, "documentId")?),
        "ocr.document_prepare" => to_value(store.prepare(
            required(&params, "documentId")?,
            u32_param(&params, "totalPages")?,
        )?),
        "ocr.document_bytes" => {
            let id = required(&params, "documentId")?;
            let doc = store.document(id)?;
            let bytes = fs::read(store.source(id)?).map_err(io_error)?;
            Ok(json!({"mimeType":doc.mime_type,"dataBase64":STANDARD.encode(bytes)}))
        }
        "ocr.image_pages" => image_pages(&mut store, required(&params, "documentId")?),
        "ocr.page_save" => {
            let page: Page = serde_json::from_value(params["page"].clone())
                .map_err(|_| failure("OCR_PAGE_INVALID", "页面内容格式无效。"))?;
            to_value(store.save_page(
                required(&params, "documentId")?,
                page,
                revision(&params)?,
                false,
            )?)
        }
        "ocr.extraction_save" => store.save_extraction(&params),
        _ => Err(failure("METHOD_NOT_FOUND", "未找到对应的 OCR 接口。")),
    }
}

/// Only persisted, previously validated export locations or the fixed
/// application-owned fallback are returned; source-file parents are unrelated.
fn output_directory(store: &Store, project: &str, fallback: &Path) -> Result<Value, AppError> {
    let directory = store.previous_output_directory(project)?.unwrap_or_else(|| fallback.to_path_buf());
    fs::create_dir_all(&directory).map_err(io_error)?;
    Ok(json!({"outputDir":directory.canonicalize().map_err(io_error)?.to_string_lossy()}))
}
fn is_reparse(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        fs::symlink_metadata(path)
            .map(|m| m.file_attributes() & 0x400 != 0)
            .unwrap_or(true)
    }
    #[cfg(not(windows))]
    {
        fs::symlink_metadata(path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true)
    }
}
fn collect_import_folder(
    folder: &Path,
    paths: &mut Vec<PathBuf>,
    failed: &mut Vec<Value>,
) -> Result<(), AppError> {
    if is_reparse(folder) {
        return Err(failure(
            "OCR_IMPORT_FOLDER",
            "无法导入链接或重解析点文件夹，请选择实际文件夹。",
        ));
    }
    let root = folder.canonicalize().map_err(io_error)?;
    if !root.is_dir() {
        return Err(failure("OCR_IMPORT_FOLDER", "请选择有效的导入文件夹。"));
    }
    let before = paths.len();
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_reparse(e.path()))
    {
        match entry {
            Ok(entry) if entry.file_type().is_file() => {
                let ext = entry
                    .path()
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if matches!(ext.as_str(), "pdf" | "png" | "jpg" | "jpeg" | "bmp" | "tif" | "tiff") {
                    if let Ok(canonical) = entry.path().canonicalize() {
                        if canonical.starts_with(&root) {
                            paths.push(canonical);
                        }
                    }
                }
            }
            Err(_) => failed.push(json!({"name":folder.to_string_lossy(),"message":"部分子目录无法读取，已继续处理其他文件。"})),
            _ => {}
        }
    }
    if paths.len() == before {
        failed.push(json!({"name":folder.to_string_lossy(),"message":"文件夹内没有可导入的 PDF、PNG、JPEG、BMP 或 TIFF 文件。"}));
    }
    Ok(())
}
fn import_documents(store: &Store, p: &Value) -> Result<Value, AppError> {
    let project = required(p, "projectId")?;
    store.project(project)?;
    let mut inputs: Vec<PathBuf> = p["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .collect();
    inputs.sort();
    inputs.dedup();
    let mut paths = vec![];
    let mut failed = vec![];
    for input in inputs {
        let result = if is_reparse(&input) {
            Err(failure(
                "OCR_IMPORT_PATH",
                "无法导入链接、重解析点或不可读取的路径，请选择实际文件或文件夹。",
            ))
        } else if input.is_dir() {
            collect_import_folder(&input, &mut paths, &mut failed)
        } else {
            input
                .canonicalize()
                .map(|path| paths.push(path))
                .map_err(io_error)
        };
        if let Err(error) = result {
            failed.push(json!({"name":input.to_string_lossy(),"message":error.user_message}));
        }
    }
    if let Some(folder) = p["folder"].as_str().filter(|v| !v.is_empty()) {
        collect_import_folder(Path::new(folder), &mut paths, &mut failed)?;
    }
    paths.sort();
    paths.dedup();
    let mut docs = vec![];
    for path in paths {
        match store.import(project,&path){Ok(doc)=>docs.push(doc),Err(e)=>failed.push(json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"message":e.user_message}))}
    }
    Ok(json!({"documents":docs,"failed":failed}))
}
fn image_error(_: impl std::fmt::Display) -> AppError {
    failure(
        "OCR_IMAGE_DECODE",
        "图片无法解码或格式不受支持，请转换为 PNG/JPEG 后重试。",
    )
}
fn png(image: &DynamicImage) -> Result<String, AppError> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    let mut output = Vec::new();
    // `write_to(Png)` uses Fast compression. These full-resolution scans are
    // uploaded over the same connection bandwidth by several workers, so use
    // balanced DEFLATE compression. Dimensions, channels and every decoded
    // pixel remain unchanged; do not trade OCR detail for smaller JPEGs.
    image
        .write_with_encoder(PngEncoder::new_with_quality(
            &mut output, CompressionType::Default, FilterType::Adaptive,
        ))
        .map_err(image_error)?;
    Ok(STANDARD.encode(output))
}
fn decode_base64(data: &str) -> Result<Vec<u8>, AppError> {
    STANDARD
        .decode(data.split_once(",").map_or(data, |(_, b)| b))
        .map_err(|_| failure("OCR_IMAGE_INVALID", "页面图片编码无效。"))
}
fn decode_image(bytes: &[u8]) -> Result<DynamicImage, AppError> {
    let mut decoder = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(image_error)?
        .into_decoder()
        .map_err(image_error)?;
    let orientation = decoder.orientation().map_err(image_error)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(image_error)?;
    image.apply_orientation(orientation);
    Ok(image)
}
fn image_pages(store: &mut Store, id: &str) -> Result<Value, AppError> {
    let doc = store.document(id)?;
    let bytes = fs::read(store.source(id)?).map_err(io_error)?;
    if doc.mime_type == "application/pdf" {
        return Err(failure(
            "OCR_PDF_RENDER",
            "PDF 页面请使用内置预览渲染后识别。",
        ));
    }
    let images = if doc.mime_type == "image/tiff" {
        decode_tiff(&bytes)?
    } else {
        vec![decode_image(&bytes)?]
    };
    let pages = images
        .iter()
        .enumerate()
        .map(|(index, image)| Ok(json!({"page":index+1,"imageBase64":png(image)?})))
        .collect::<Result<Vec<_>, AppError>>()?;
    store.prepare(
        id,
        pages
            .len()
            .try_into()
            .map_err(|_| failure("OCR_PAGE_COUNT", "图片页数过多。"))?,
    )?;
    Ok(json!({"pages":pages}))
}
fn decode_tiff(bytes: &[u8]) -> Result<Vec<DynamicImage>, AppError> {
    use tiff::ColorType;
    use tiff::decoder::{Decoder, DecodingResult};
    let mut decoder = Decoder::new(Cursor::new(bytes)).map_err(image_error)?;
    let mut pages = vec![];
    loop {
        let (width, height) = decoder.dimensions().map_err(image_error)?;
        let color = decoder.colortype().map_err(image_error)?;
        let orientation = decoder
            .get_tag_unsigned::<u8>(tiff::tags::Tag::Orientation)
            .unwrap_or(1);
        let data = decoder.read_image().map_err(image_error)?;
        let pixels: Vec<u8> = match data {
            DecodingResult::U8(v) => v,
            DecodingResult::U16(v) => v.into_iter().map(|n| (n >> 8) as u8).collect(),
            DecodingResult::F32(v) => v
                .into_iter()
                .map(|n| (n.clamp(0.0, 1.0) * 255.0).round() as u8)
                .collect(),
            _ => {
                return Err(failure(
                    "OCR_TIFF_FORMAT",
                    "TIFF 像素格式不受支持，请转换为 PNG 后重试。",
                ));
            }
        };
        let pixels = match color {
            ColorType::Gray(bits) if bits < 8 => unpack_gray(&pixels, width, height, bits)?,
            _ => pixels,
        };
        let mut image = match color {
            ColorType::Gray(_) => {
                image::GrayImage::from_raw(width, height, pixels).map(DynamicImage::ImageLuma8)
            }
            ColorType::GrayA(_) => image::GrayAlphaImage::from_raw(width, height, pixels)
                .map(DynamicImage::ImageLumaA8),
            ColorType::RGB(_) => {
                image::RgbImage::from_raw(width, height, pixels).map(DynamicImage::ImageRgb8)
            }
            ColorType::RGBA(_) => {
                image::RgbaImage::from_raw(width, height, pixels).map(DynamicImage::ImageRgba8)
            }
            ColorType::CMYK(_) => {
                let rgb = pixels
                    .chunks_exact(4)
                    .flat_map(|v| {
                        let k = v[3] as u16;
                        [
                            (((255 - v[0] as u16) * (255 - k)) / 255) as u8,
                            (((255 - v[1] as u16) * (255 - k)) / 255) as u8,
                            (((255 - v[2] as u16) * (255 - k)) / 255) as u8,
                        ]
                    })
                    .collect();
                image::RgbImage::from_raw(width, height, rgb).map(DynamicImage::ImageRgb8)
            }
            _ => {
                return Err(failure(
                    "OCR_TIFF_FORMAT",
                    "TIFF 颜色格式不受支持，请转换为 PNG 后重试。",
                ));
            }
        }
        .ok_or_else(|| failure("OCR_TIFF_FORMAT", "TIFF 页面像素数据不完整。"))?;
        if let Some(orientation) = image::metadata::Orientation::from_exif(orientation) {
            image.apply_orientation(orientation);
        }
        pages.push(image);
        if !decoder.more_images() {
            break;
        }
        decoder.next_image().map_err(image_error)?;
    }
    Ok(pages)
}
fn unpack_gray(packed: &[u8], width: u32, height: u32, bits: u8) -> Result<Vec<u8>, AppError> {
    if !matches!(bits, 1 | 2 | 4) {
        return Err(failure(
            "OCR_TIFF_FORMAT",
            "TIFF 灰度位深不受支持，请转换为 PNG 后重试。",
        ));
    }
    let stride = (width as usize * bits as usize).div_ceil(8);
    if packed.len() != stride * height as usize {
        return Err(failure("OCR_TIFF_FORMAT", "TIFF 灰度像素数据不完整。"));
    }
    let max = (1u16 << bits) - 1;
    let mut pixels = Vec::with_capacity(width as usize * height as usize);
    for row in packed.chunks_exact(stride) {
        for x in 0..width as usize {
            let shift = 8 - bits as usize - (x * bits as usize % 8);
            let value = ((row[x * bits as usize / 8] as u16) >> shift) & max;
            pixels.push((value * 255 / max) as u8);
        }
    }
    Ok(pixels)
}
fn parse_json(raw: &str) -> Result<Value, AppError> {
    let clean = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(clean).map_err(|_| {
        failure(
            "OCR_STRUCTURE_INVALID",
            "模型未返回完整的表格结构，原文已保留，请校对或重试。",
        )
    })
}
fn parse_tables(v: &Value, tag: &str) -> Result<Vec<Table>, AppError> {
    let tables = v["tables"].as_array().ok_or_else(|| {
        failure(
            "OCR_STRUCTURE_INVALID",
            "结构结果缺少表格列表，原文已保留。",
        )
    })?;
    tables
        .iter()
        .enumerate()
        .map(|(index, t)| {
            let rows = t["rows"]
                .as_array()
                .ok_or_else(|| failure("OCR_STRUCTURE_INVALID", "表格行数据无效，原文已保留。"))?;
            let rows = rows
                .iter()
                .map(|row| {
                    row.as_array()
                        .ok_or_else(|| {
                            failure("OCR_STRUCTURE_INVALID", "表格单元格数据无效，原文已保留。")
                        })?
                        .iter()
                        .map(|cell| {
                            cell.as_str().map(str::to_owned).ok_or_else(|| {
                                failure(
                                    "OCR_STRUCTURE_INVALID",
                                    "表格单元格必须是原始文本，原文已保留。",
                                )
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .collect::<Result<Vec<_>, AppError>>()?;
            Ok(Table {
                id: format!("{tag}-{}", index + 1),
                title: t["title"].as_str().unwrap_or("").into(),
                rows,
            })
        })
        .collect()
}
const STRUCTURE_PROMPT: &str = "你是扫描件表格还原器。逐格读取图片中的全部表格，保持原始行列顺序，合并单元格文字只写入左上格，其余保留空串。不要概括、补写、改写数字、日期、账号或金额，所有单元格均为字符串。无表格返回空 tables。仅输出完整 JSON：{\"tables\":[{\"title\":\"原表名\",\"rows\":[[\"单元格\"]]}],\"warnings\":[\"无法确认的内容及位置\"]}。参考 OCR 原文用于校验，不能将原文中的不同位置拼成新表格。";
fn recognize_part(
    image: &str,
    settings: &Value,
    tag: &str,
    pause: &PauseCheckpoint,
    timings: &mut RecognitionTimings,
) -> Result<(String, Vec<Table>, Vec<String>, Option<String>), AppError> {
    pause.wait()?;
    let recognition_started = Instant::now();
    let result = crate::audipick::toolbox_ocr_page(&json!({"imageBase64":image}), settings)?;
    timings.recognition_ms += elapsed_ms(recognition_started);
    if let Some(http) = result.get("httpTiming").filter(|v| v.is_object()) {
        timings.http_requests.push(http.clone());
    }
    let diagnostic = result["diagnosticResponse"].as_str().map(str::to_owned);
    let text = result["text"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| failure("OCR_EMPTY", "服务未返回识别文字，该页尚未完成，请重试。"))?
        .to_owned();
    pause.wait()?;
    if let Some(message) = result["structureError"].as_str() {
        return Ok((text, vec![], vec![message.into()], diagnostic));
    }
    let structure_started = Instant::now();
    // Preserve a provider's native cell grid if present; otherwise restore from the
    // image using only the global vision model. Failed layout never erases OCR text.
    let structure = if result["tables"].is_array() {
        Ok(result.clone())
    } else {
        crate::audipick::toolbox_llm_request(STRUCTURE_PROMPT, &text, Some(image), settings)
            .and_then(|raw| parse_json(&raw))
    };
    let result = match structure.and_then(|v| {
        Ok((
            parse_tables(&v, tag)?,
            v["warnings"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>(),
        ))
    }) {
        Ok((tables, warnings)) => Ok((text, tables, warnings, diagnostic)),
        Err(e) => Ok((
            text,
            vec![],
            vec![format!("表格结构尚待校对：{}", e.user_message)],
            diagnostic,
        )),
    };
    timings.structure_ms += elapsed_ms(structure_started);
    result
}

// A local count is a warning signal only, never alternative contract evidence.
// Restrict it to very sparse cloud output: intentional watermark suppression
// and ordinary OCR differences must not trigger a fabricated accuracy score.
fn sparse_recognition_warning(text: &str, local_characters: usize) -> Option<String> {
    let count = text.chars().filter(|c| !c.is_whitespace()).count();
    (local_characters >= 80 && count < 40 && count.saturating_mul(4) < local_characters)
        .then(|| "本页识别文字明显少于本机检测到的文字，可能遗漏标题或正文；请对照扫描件重新识别，不能仅以请求成功判断内容完整。".into())
}
pub(crate) fn worker_params(mut params: Value, db_path: &Path, settings: Value) -> Result<Value, AppError> {
    let object = params.as_object_mut().ok_or_else(|| failure("INVALID_ARGUMENT", "OCR 任务参数不完整。"))?;
    object.insert("__dbPath".into(), json!(db_path));
    object.insert("__settings".into(), settings);
    Ok(params)
}

pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    _cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    let settings = params.get("__settings").cloned().unwrap_or(json!({}));
    match method {
        "ocr.recognize_page" => {
            let worker_started = Instant::now();
            let mut timings = RecognitionTimings::default();
            let db = Path::new(required(&params, "__dbPath")?);
            let mut store = Store::open(db)?;
            let id = required(&params, "documentId")?;
            let number = u32_param(&params, "page")?;
            let expected = revision(&params)?;
            let doc = store.document(id)?;
            let old = store.pages(id)?.into_iter().find(|p| p.page == number);
            if old.as_ref().map_or(0, |p| p.revision) != expected {
                return Err(failure(
                    "OCR_REVISION_CONFLICT",
                    "页面已修改，请刷新后重试。",
                ));
            }
            progress(
                "ocr",
                number.saturating_sub(1) as usize,
                doc.total_pages as usize,
                &format!("正在识别第 {number} 页并还原表格"),
            );
            timings.setup_ms = elapsed_ms(worker_started);
            let image_started = Instant::now();
            let input = required(&params, "imageBase64")?;
            let bytes = decode_base64(input)?;
            let decoded = decode_image(&bytes)?;
            let correction = crate::ocr_orientation::correct(&decoded);
            let image = correction.image;
            pause.wait()?;
            let segments = match params["layout"].as_str().unwrap_or("full") {
                "full" => vec![png(&image)?],
                "spread" => {
                    if image.width() < 2 {
                        return Err(failure(
                            "OCR_IMAGE_INVALID",
                            "图片宽度不足，无法拆分左右页。",
                        ));
                    }
                    let half = image.width() / 2;
                    vec![
                        png(&image.crop_imm(0, 0, half, image.height()))?,
                        png(&image.crop_imm(half, 0, image.width() - half, image.height()))?,
                    ]
                }
                _ => return Err(failure("OCR_LAYOUT_INVALID", "请选择整页或左右双页。")),
            };
            timings.image_ms = elapsed_ms(image_started);
            let mut text = vec![];
            let mut tables = vec![];
            let mut warnings: Vec<String> = correction.warning.into_iter().collect();
            let mut diagnostics = vec![];
            for (index, segment) in segments.iter().enumerate() {
                let image = format!("data:image/png;base64,{segment}");
                let (part, mut part_tables, mut part_warnings, diagnostic) = recognize_part(
                    &image,
                    &settings,
                    &format!("p{number}-s{}", index + 1),
                    pause,
                    &mut timings,
                )?;
                text.push(part);
                tables.append(&mut part_tables);
                warnings.append(&mut part_warnings);
                if let Some(raw) = diagnostic { diagnostics.push(raw); }
            }
            pause.wait()?;
            let full_text = text.join("\n\n");
            if let Some(warning) = sparse_recognition_warning(&full_text, correction.reference_characters) {
                warnings.push(warning);
            }
            let page = Page {
                page: number,
                text: full_text,
                original_text: String::new(),
                tables,
                original_tables: vec![],
                revision: 0,
                status: if warnings.is_empty() {
                    "completed"
                } else {
                    "needs_review"
                }
                .into(),
                warnings,
                metadata: correction.metadata,
            };
            let save_started = Instant::now();
            let saved = store.save_page(id, page, expected, true)?;
            store.save_recognition_diagnostics(id, number, saved.revision, &diagnostics)?;
            timings.save_ms = elapsed_ms(save_started);
            timings.worker_ms = elapsed_ms(worker_started);
            progress(
                "ocr",
                number as usize,
                doc.total_pages as usize,
                "页面识别结果已保存",
            );
            let mut result = to_value(saved)?;
            result["timings"] = to_value(timings)?;
            Ok(result)
        }
        "ocr.extract" => {
            progress("extract", 0, 1, "正在按当前提示词摘录");
            let prompt = required(&params, "prompt")?;
            let text = required(&params, "text")?;
            let raw = crate::audipick::toolbox_llm_request(prompt, text, None, &settings)?;
            pause.wait()?;
            let parsed = parse_json(&raw).ok();
            progress("extract", 1, 1, "本阶段摘录完成");
            Ok(json!({"parsed":parsed,"raw":raw}))
        }
        "ocr.export" => {
            let store = Store::open(Path::new(required(&params, "__dbPath")?))?;
            crate::ocr_export::export(&store, &params, progress, pause)
        }
        _ => Err(failure("JOB_NOT_FOUND", "未找到对应的 OCR 任务。")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sparse_cloud_text_gets_review_warning_without_guessing_missing_content() {
        assert!(super::sparse_recognition_warning("编号：ABC000123", 180).is_some());
        assert!(super::sparse_recognition_warning("编号：ABC000123", 0).is_none());
        assert!(super::sparse_recognition_warning("编号：ABC000123", 15).is_none());
        assert!(super::sparse_recognition_warning(&"正文".repeat(50), 1200).is_none());
    }
    use super::*;
    #[test]
    fn upload_png_preserves_scan_dimensions_channels_and_pixels() {
        let rgb = DynamicImage::ImageRgb8(image::RgbImage::from_fn(123, 75, |x, y| {
            image::Rgb([(x * 3) as u8, (y * 5) as u8, (x ^ y) as u8])
        }));
        let rgba = DynamicImage::ImageRgba8(image::RgbaImage::from_fn(71, 47, |x, y| {
            image::Rgba([x as u8, y as u8, 241, ((x * 7 + y) % 256) as u8])
        }));
        let gray16 = DynamicImage::ImageLuma16(image::ImageBuffer::from_fn(17, 29, |x, y| {
            image::Luma([((x * 257 + y * 123) % 65536) as u16])
        }));
        for input in [rgb, rgba, gray16] {
            let encoded = STANDARD.decode(png(&input).unwrap()).unwrap();
            let decoded = image::load_from_memory(&encoded).unwrap();
            assert_eq!(decoded.width(), input.width());
            assert_eq!(decoded.height(), input.height());
            assert_eq!(decoded.color(), input.color());
            assert_eq!(decoded.as_bytes(), input.as_bytes());
        }
    }

    #[test]
    #[ignore = "手动上传优化验收，需要 OCR_PNG_BENCH_IMAGE 指向本机样本；不联网"]
    fn benchmark_lossless_upload_png_on_local_scan() {
        use image::ImageFormat;
        let path = std::env::var_os("OCR_PNG_BENCH_IMAGE").expect("请设置 OCR_PNG_BENCH_IMAGE");
        let input = decode_image(&fs::read(PathBuf::from(path)).unwrap()).unwrap();
        let fast_started = Instant::now();
        let mut fast = Cursor::new(Vec::new());
        input.write_to(&mut fast, ImageFormat::Png).unwrap();
        let fast_ms = elapsed_ms(fast_started);
        let balanced_started = Instant::now();
        let balanced = STANDARD.decode(png(&input).unwrap()).unwrap();
        let balanced_ms = elapsed_ms(balanced_started);
        assert_eq!(image::load_from_memory(&balanced).unwrap().as_bytes(), input.as_bytes());
        if let Some(output) = std::env::var_os("OCR_PNG_BENCH_OUTPUT") {
            use std::io::Write;
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(PathBuf::from(output)).unwrap();
            file.write_all(&balanced).unwrap();
        }
        eprintln!("{}", json!({"fastBytes":fast.get_ref().len(),"balancedBytes":balanced.len(),
            "fastMs":fast_ms,"balancedMs":balanced_ms,"pixelsEqual":true,
            "width":input.width(),"height":input.height()}));
    }
    #[test]
    fn output_directory_reuses_successful_export_without_source_parent_grants() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        let project = store.save_project(&json!({"name":"目录"})).unwrap();
        let id = project["id"].as_str().unwrap();
        let fallback = dir.path().join("default-ocr");
        assert_eq!(output_directory(&store, id, &fallback).unwrap()["outputDir"], json!(fallback.canonicalize().unwrap().to_string_lossy()));
        let selected = dir.path().join("authorized-target");
        fs::create_dir_all(&selected).unwrap();
        store.remember_output_directory(id, &selected).unwrap();
        store.save_project(&json!({"id":id,"name":"改名","outputDirectory":dir.path()})).unwrap();
        assert_eq!(output_directory(&store, id, &fallback).unwrap()["outputDir"], json!(selected.canonicalize().unwrap().to_string_lossy()));
    }
    #[test]
    fn worker_settings_survive_transport_and_unified_llm_enabled_is_respected() {
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        for (enabled, expected) in [(true, "LLM_URL_INVALID"), (false, "LLM_DISABLED")] {
            let params = worker_params(json!({"prompt":"提示","text":"原文","__settings":{"llm":{"enabled":!enabled}}}), Path::new("synthetic.db"),
                json!({"llm":{"enabled":enabled,"base_url":"invalid-unified-url"},"audipickLlm":{"mode":"dedicated","enabled":!enabled}})).unwrap();
            let transported: Value = serde_json::from_str(&serde_json::to_string(&params).unwrap()).unwrap();
            assert_eq!(transported["__settings"]["llm"]["enabled"], enabled);
            let error = run_job("ocr.extract", transported, &|_,_,_,_|{}, cancel.clone(), &pause).unwrap_err();
            assert_eq!(error.code, expected);
        }
    }
    #[test]
    fn import_mixed_directories_and_files_filters_formats_and_deduplicates() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("data.sqlite")).unwrap();
        let project = store.save_project(&json!({"name":"混合拖放"})).unwrap();
        let first = dir.path().join("first");
        let nested = first.join("nested");
        let second = dir.path().join("second");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&second).unwrap();
        for extension in ["PDF", "png", "jpg", "jpeg", "bmp", "tif", "tiff"] {
            fs::write(nested.join(format!("sample.{extension}")), b"synthetic").unwrap();
        }
        fs::write(nested.join("ignored.docx"), b"ignored").unwrap();
        fs::write(second.join("other.pdf"), b"synthetic").unwrap();
        let loose = dir.path().join("loose.png");
        fs::write(&loose, b"synthetic").unwrap();
        let result = import_documents(
            &store,
            &json!({
                "projectId":project["id"],
                "paths":[first, second, loose, first, nested.join("sample.PDF")],
                "folder":nested
            }),
        )
        .unwrap();
        let documents = result["documents"].as_array().unwrap();
        assert_eq!(documents.len(), 9);
        assert_eq!(result["failed"], json!([]));
        assert!(documents.iter().all(|doc| doc["name"] != "ignored.docx"));
        assert_eq!(
            store
                .documents(project["id"].as_str().unwrap())
                .unwrap()
                .len(),
            9
        );
    }
    #[test]
    fn import_empty_directory_reports_reason_and_continues_with_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("data.sqlite")).unwrap();
        let project = store.save_project(&json!({"name":"空目录"})).unwrap();
        let empty = dir.path().join("empty");
        fs::create_dir(&empty).unwrap();
        fs::write(empty.join("unsupported.mp4"), b"ignored").unwrap();
        let valid = dir.path().join("valid.pdf");
        fs::write(&valid, b"synthetic").unwrap();
        let result = import_documents(
            &store,
            &json!({"projectId":project["id"],"paths":[empty,valid]}),
        )
        .unwrap();
        assert_eq!(result["documents"].as_array().unwrap().len(), 1);
        assert_eq!(result["failed"].as_array().unwrap().len(), 1);
        assert!(
            result["failed"][0]["message"]
                .as_str()
                .unwrap()
                .contains("没有可导入")
        );
        let folder_result =
            import_documents(&store, &json!({"projectId":project["id"],"folder":empty})).unwrap();
        assert_eq!(folder_result["documents"], json!([]));
        assert!(
            folder_result["failed"][0]["message"]
                .as_str()
                .unwrap()
                .contains("没有可导入")
        );
    }
    #[cfg(windows)]
    #[test]
    fn import_directory_never_follows_junctions_or_accepts_junction_roots() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("data.sqlite")).unwrap();
        let project = store.save_project(&json!({"name":"重解析点边界"})).unwrap();
        let selected = dir.path().join("selected");
        let outside = dir.path().join("outside");
        fs::create_dir(&selected).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(selected.join("allowed.pdf"), b"synthetic").unwrap();
        fs::write(outside.join("forbidden.pdf"), b"synthetic").unwrap();
        let junction = selected.join("linked");
        let output = std::process::Command::new("pwsh")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$null = New-Item -ItemType Junction -Path $env:OCR_TEST_LINK -Target $env:OCR_TEST_TARGET -ErrorAction Stop"])
            .env("OCR_TEST_LINK", &junction)
            .env("OCR_TEST_TARGET", &outside)
            .output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(is_reparse(&junction));
        let result = import_documents(
            &store,
            &json!({"projectId":project["id"],"paths":[selected,junction]}),
        )
        .unwrap();
        assert_eq!(result["documents"].as_array().unwrap().len(), 1);
        assert_eq!(result["documents"][0]["name"], "allowed.pdf");
        assert_eq!(result["failed"].as_array().unwrap().len(), 1);
        assert!(
            result["failed"][0]["message"]
                .as_str()
                .unwrap()
                .contains("重解析点")
        );
        let folder_error = import_documents(
            &store,
            &json!({"projectId":project["id"],"folder":junction}),
        )
        .unwrap_err();
        assert_eq!(folder_error.code, "OCR_IMPORT_FOLDER");
        fs::remove_dir(&junction).unwrap();
    }
    #[test]
    fn structure_preserves_text_and_rejects_numeric_cells() {
        let table=parse_tables(&json!({"tables":[{"title":"票据","rows":[["001234567890123456789","2026-01-02","1,234.00"]]}]}),"p1").unwrap();
        assert_eq!(table[0].rows[0][0], "001234567890123456789");
        assert!(parse_tables(&json!({"tables":[{"rows":[[123]]}]}), "p1").is_err());
    }
    #[test]
    fn tiff_decodes_every_frame_in_order() {
        use tiff::encoder::{TiffEncoder, colortype};
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut encoder = TiffEncoder::new(&mut cursor).unwrap();
            encoder
                .write_image::<colortype::RGB8>(1, 1, &[255, 0, 0])
                .unwrap();
            encoder
                .write_image::<colortype::RGB8>(1, 1, &[0, 255, 0])
                .unwrap();
        }
        let pages = decode_tiff(&cursor.into_inner()).unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].to_rgb8().get_pixel(0, 0).0, [255, 0, 0]);
        assert_eq!(pages[1].to_rgb8().get_pixel(0, 0).0, [0, 255, 0]);
    }
    #[test]
    fn packed_fax_grayscale_preserves_row_padding_and_black_white() {
        assert_eq!(
            unpack_gray(&[0b10100000, 0b01000000], 3, 2, 1).unwrap(),
            vec![255, 0, 255, 0, 255, 0]
        );
        assert_eq!(
            unpack_gray(&[0b00011011], 4, 1, 2).unwrap(),
            vec![0, 85, 170, 255]
        );
        assert!(unpack_gray(&[], 8, 1, 1).is_err());
    }
    #[test]
    fn unrecognized_methods_fail_before_network() {
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        assert!(
            run_job(
                "ocr.unknown",
                json!({}),
                &|_, _, _, _| {},
                Arc::new(AtomicBool::new(false)),
                &pause
            )
            .is_err()
        );
    }
}
