use calamine::{Reader, Xlsx};
use std::collections::BTreeMap;
use std::io::Cursor;

use crate::AppError;

#[tauri::command]
pub fn covenant_case_workbook(
    bytes: Vec<u8>,
) -> Result<BTreeMap<String, Vec<Vec<String>>>, AppError> {
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(AppError::new(
            "CASE_LIBRARY_INVALID",
            "案例库工作簿不能超过 8 MB",
            false,
            None,
        ));
    }
    let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(bytes)).map_err(|e| {
        AppError::new(
            "CASE_LIBRARY_INVALID",
            "无法读取案例库 Excel，请检查工作簿格式",
            false,
            Some(e.to_string()),
        )
    })?;
    let mut sheets = BTreeMap::new();
    for name in ["使用说明", "分类规则", "正例条款", "排除与支持", "C300回归"] {
        let range = workbook.worksheet_range(name).map_err(|e| {
            AppError::new(
                "CASE_LIBRARY_INVALID",
                format!("无法读取工作表：{name}"),
                false,
                Some(e.to_string()),
            )
        })?;
        if range.height() > 10000 || range.width() > 100 {
            return Err(AppError::new(
                "CASE_LIBRARY_INVALID",
                format!("工作表 {name} 超出案例库规模限制"),
                false,
                None,
            ));
        }
        sheets.insert(
            name.to_string(),
            range
                .rows()
                .map(|row| row.iter().map(ToString::to_string).collect())
                .collect(),
        );
    }
    Ok(sheets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_workbook_is_rejected() {
        assert!(covenant_case_workbook(b"not an excel file".to_vec()).is_err());
    }
    #[test]
    fn oversized_workbook_is_rejected() {
        assert!(covenant_case_workbook(vec![0; 8 * 1024 * 1024 + 1]).is_err());
    }
    #[test]
    fn imports_review_workbook() {
        let sheets = covenant_case_workbook(
            include_bytes!("../../tests/fixtures/covenant-cases-v1.xlsx").to_vec(),
        )
        .unwrap();
        assert_eq!(sheets["正例条款"].len(), 44);
        assert_eq!(sheets["排除与支持"].len(), 13);
        assert_eq!(sheets["C300回归"].len(), 18);
        assert_eq!(sheets["正例条款"][1][0], "P001");
    }
}
