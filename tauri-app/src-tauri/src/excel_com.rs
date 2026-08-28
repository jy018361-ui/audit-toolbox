#![cfg(windows)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::{
    mem::ManuallyDrop,
    path::{Path, PathBuf},
    ptr,
};
use windows::{
    Win32::{
        Foundation::DISP_E_PARAMNOTFOUND,
        System::{
            Com::{
                CLSCTX_LOCAL_SERVER, CLSIDFromProgID, COINIT_APARTMENTTHREADED, CoCreateInstance,
                CoInitializeEx, CoUninitialize, DISPATCH_METHOD, DISPATCH_PROPERTYGET,
                DISPATCH_PROPERTYPUT, DISPPARAMS, IDispatch,
            },
            Ole::DISPID_PROPERTYPUT,
            Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_ERROR},
        },
    },
    core::{GUID, PCWSTR},
};

use crate::AppError;

/// Excel 的 COM 接口（Workbooks.Open / SaveAs）不接受 Windows 规范化路径
/// 自带的 `\\?\` 前缀，原样传入会报 0x800A03EC「找不到文件」。
/// 规范化只为消掉 `.`/`..` 拿到绝对路径，传给 Excel 前必须剥掉前缀。
fn excel_friendly_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
    }
}

#[derive(Debug, Clone)]
pub struct CopySheet {
    pub source_path: PathBuf,
    pub source_sheet: String,
    pub output_sheet: String,
    pub source_file: String,
}

pub fn copy_sheets_exact(
    plans: &[CopySheet],
    output: &Path,
    add_hyperlinks: bool,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancelled: &dyn Fn() -> Result<(), AppError>,
) -> Result<(), AppError> {
    if plans.is_empty() {
        return Err(com_error("没有读取到有效 Sheet。", None));
    }
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| com_error("无法初始化 Excel 自动化环境。", Some(e.to_string())))?;
        let result = run_copy(plans, output, add_hyperlinks, progress, cancelled);
        CoUninitialize();
        result
    }
}

unsafe fn run_copy(
    plans: &[CopySheet],
    output: &Path,
    add_hyperlinks: bool,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancelled: &dyn Fn() -> Result<(), AppError>,
) -> Result<(), AppError> {
    let clsid = CLSIDFromProgID(PCWSTR(wide("Excel.Application").as_ptr())).map_err(|e| {
        com_error(
            "本机未检测到可用的 Microsoft Excel，无法执行多 Sheet 原样复制。",
            Some(e.to_string()),
        )
    })?;
    let excel: IDispatch = CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER)
        .map_err(|e| com_error("Microsoft Excel 启动失败。", Some(e.to_string())))?;
    let _ = put(&excel, "Visible", false.into());
    let _ = put(&excel, "DisplayAlerts", false.into());
    let _ = put(&excel, "ScreenUpdating", false.into());
    let _ = put(&excel, "EnableEvents", false.into());

    let operation = (|| -> Result<IDispatch, AppError> {
        let workbooks = get_object(&excel, "Workbooks")?;
        let mut destination = None::<IDispatch>;
        for (reverse_index, plan) in plans.iter().rev().enumerate() {
            cancelled()?;
            progress(
                "copy",
                reverse_index,
                plans.len(),
                &format!("正在原样复制：{} / {}", plan.source_file, plan.source_sheet),
            );
            let source_path = plan
                .source_path
                .canonicalize()
                .unwrap_or_else(|_| plan.source_path.clone());
            let source = object_method(
                &workbooks,
                "Open",
                vec![excel_friendly_path(&source_path).as_str().into()],
            )?;
            let copy_result = (|| -> Result<(), AppError> {
                let worksheets = get_object(&source, "Worksheets")?;
                let sheet_key: VARIANT = if plan.source_sheet.is_empty() {
                    1i32.into()
                } else {
                    plan.source_sheet.as_str().into()
                };
                let sheet = object_method(&worksheets, "Item", vec![sheet_key])?;
                if let Some(book) = &destination {
                    let target_sheets = get_object(book, "Worksheets")?;
                    let first = object_method(&target_sheets, "Item", vec![1i32.into()])?;
                    invoke(&sheet, "Copy", DISPATCH_METHOD, vec![first.into()])?;
                } else {
                    invoke(&sheet, "Copy", DISPATCH_METHOD, Vec::new())?;
                    destination = Some(get_object(&excel, "ActiveWorkbook")?);
                }
                let active = get_object(&excel, "ActiveSheet")?;
                put(&active, "Name", plan.output_sheet.as_str().into())?;
                Ok(())
            })();
            let _ = invoke(&source, "Close", DISPATCH_METHOD, vec![false.into()]);
            copy_result?;
        }
        let destination = destination.ok_or_else(|| com_error("没有成功复制任何 Sheet。", None))?;
        add_reference(&destination, plans, add_hyperlinks)?;
        let output = output
            .canonicalize()
            .unwrap_or_else(|_| output.to_path_buf());
        invoke(
            &destination,
            "SaveAs",
            DISPATCH_METHOD,
            vec![excel_friendly_path(&output).as_str().into(), 51i32.into()],
        )?;
        Ok(destination)
    })();

    if let Ok(destination) = &operation {
        let _ = invoke(destination, "Close", DISPATCH_METHOD, vec![false.into()]);
    }
    let _ = invoke(&excel, "Quit", DISPATCH_METHOD, Vec::new());
    operation.map(|_| ())
}

unsafe fn add_reference(
    destination: &IDispatch,
    plans: &[CopySheet],
    add_hyperlinks: bool,
) -> Result<(), AppError> {
    let worksheets = get_object(destination, "Worksheets")?;
    let first = object_method(&worksheets, "Item", vec![1i32.into()])?;
    let reference = object_method(&worksheets, "Add", vec![first.into()])?;
    put(&reference, "Name", "Reference".into())?;
    set_cell(&reference, 1, 1, "Source File Name".into())?;
    set_cell(&reference, 1, 2, "Target Sheet Link".into())?;
    for (index, plan) in plans.iter().enumerate() {
        let row = (index + 2) as i32;
        set_cell(&reference, row, 1, plan.source_file.as_str().into())?;
        if add_hyperlinks {
            let escaped_name = plan.output_sheet.replace('\'', "''");
            let anchor = cell_object(&reference, row, 2)?;
            let hyperlinks = get_object(&reference, "Hyperlinks")?;
            invoke(
                &hyperlinks,
                "Add",
                DISPATCH_METHOD,
                vec![
                    anchor.into(),
                    "".into(),
                    format!("'{escaped_name}'!A1").as_str().into(),
                    missing_variant(),
                    plan.output_sheet.as_str().into(),
                ],
            )?;
        } else {
            set_cell(&reference, row, 2, plan.output_sheet.as_str().into())?;
        }
    }
    if let Ok(header) = object_method(&reference, "Range", vec!["A1:B1".into()]) {
        if let Ok(font) = get_object(&header, "Font") {
            let _ = put(&font, "Bold", true.into());
        }
    }
    if let Ok(columns) = get_object(&reference, "Columns") {
        for index in [1i32, 2i32] {
            if let Ok(column) = object_method(&columns, "Item", vec![index.into()]) {
                let _ = put(&column, "ColumnWidth", 40f64.into());
            }
        }
    }
    let _ = invoke(&reference, "Activate", DISPATCH_METHOD, Vec::new());
    Ok(())
}

unsafe fn set_cell(sheet: &IDispatch, row: i32, col: i32, value: VARIANT) -> Result<(), AppError> {
    set_cell_property(sheet, row, col, "Value", value)
}

unsafe fn set_cell_property(
    sheet: &IDispatch,
    row: i32,
    col: i32,
    property: &str,
    value: VARIANT,
) -> Result<(), AppError> {
    let cell = cell_object(sheet, row, col)?;
    put(&cell, property, value)
}

unsafe fn cell_object(sheet: &IDispatch, row: i32, col: i32) -> Result<IDispatch, AppError> {
    let cells = get_object(sheet, "Cells")?;
    object_method(&cells, "Item", vec![row.into(), col.into()])
}

unsafe fn get_object(object: &IDispatch, name: &str) -> Result<IDispatch, AppError> {
    let value = invoke(object, name, DISPATCH_PROPERTYGET, Vec::new())?;
    IDispatch::try_from(&value)
        .map_err(|e| com_error("Excel 返回了无法识别的对象。", Some(format!("{name}: {e}"))))
}

unsafe fn object_method(
    object: &IDispatch,
    name: &str,
    args: Vec<VARIANT>,
) -> Result<IDispatch, AppError> {
    let value = invoke(object, name, DISPATCH_METHOD | DISPATCH_PROPERTYGET, args)?;
    IDispatch::try_from(&value)
        .map_err(|e| com_error("Excel 返回了无法识别的对象。", Some(format!("{name}: {e}"))))
}

unsafe fn put(object: &IDispatch, name: &str, value: VARIANT) -> Result<(), AppError> {
    invoke(object, name, DISPATCH_PROPERTYPUT, vec![value]).map(|_| ())
}

unsafe fn invoke(
    object: &IDispatch,
    name: &str,
    flags: windows::Win32::System::Com::DISPATCH_FLAGS,
    mut args: Vec<VARIANT>,
) -> Result<VARIANT, AppError> {
    let name_wide = wide(name);
    let name_pointer = PCWSTR(name_wide.as_ptr());
    let mut dispid = 0i32;
    object
        .GetIDsOfNames(&GUID::zeroed(), &name_pointer, 1, 0x0409, &mut dispid)
        .map_err(|e| com_error("Excel 自动化成员不可用。", Some(format!("{name}: {e}"))))?;
    args.reverse();
    let mut property_id = DISPID_PROPERTYPUT;
    let params = DISPPARAMS {
        rgvarg: if args.is_empty() {
            ptr::null_mut()
        } else {
            args.as_mut_ptr()
        },
        rgdispidNamedArgs: if flags == DISPATCH_PROPERTYPUT {
            &mut property_id
        } else {
            ptr::null_mut()
        },
        cArgs: args.len() as u32,
        cNamedArgs: if flags == DISPATCH_PROPERTYPUT { 1 } else { 0 },
    };
    let mut result = VARIANT::default();
    object
        .Invoke(
            dispid,
            &GUID::zeroed(),
            0x0409,
            flags,
            &params,
            Some(&mut result),
            None,
            None,
        )
        .map_err(|e| com_error("Excel 自动化调用失败。", Some(format!("{name}: {e}"))))?;
    Ok(result)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn missing_variant() -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_ERROR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 {
                    scode: DISP_E_PARAMNOTFOUND.0,
                },
            }),
        },
    }
}

fn com_error(message: &str, detail: Option<String>) -> AppError {
    AppError::new("EXCEL_COM_FAILED", message, true, detail)
}

#[cfg(test)]
mod tests {
    use super::excel_friendly_path;
    use std::path::Path;

    #[test]
    fn excel_paths_strip_verbatim_prefix() {
        // std::fs::canonicalize 在 Windows 上返回 `\\?\` 前缀路径，
        // Excel COM 原样打开会报 0x800A03EC，必须剥掉前缀再传。
        assert_eq!(
            excel_friendly_path(Path::new(r"\\?\C:\Users\lenovo\AppData\Local\Temp\甲.xlsx")),
            r"C:\Users\lenovo\AppData\Local\Temp\甲.xlsx"
        );
        assert_eq!(
            excel_friendly_path(Path::new(r"\\?\UNC\server\share\乙.xlsx")),
            r"\\server\share\乙.xlsx"
        );
        assert_eq!(
            excel_friendly_path(Path::new(r"C:\普通路径.xlsx")),
            r"C:\普通路径.xlsx"
        );
    }
}
