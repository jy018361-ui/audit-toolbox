//! FA 合并明细的可重复磁盘游标；每批只解码有限行，不把整张清单重新装入内存。
use super::{AppError, JoinedRow};
use rusqlite::{Connection, params};
use std::{
    borrow::Cow,
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Debug)]
pub(crate) struct DiskLease(PathBuf);
impl Drop for DiskLease {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Clone, Debug)]
pub(crate) enum JoinedRows {
    Memory(Vec<JoinedRow>),
    Disk {
        path: PathBuf,
        count: usize,
        error: Arc<Mutex<Option<String>>>,
        _lease: Arc<DiskLease>,
    },
}
impl Default for JoinedRows {
    fn default() -> Self {
        Self::Memory(Vec::new())
    }
}
impl From<Vec<JoinedRow>> for JoinedRows {
    fn from(rows: Vec<JoinedRow>) -> Self {
        Self::Memory(rows)
    }
}
impl FromIterator<JoinedRow> for JoinedRows {
    fn from_iter<T: IntoIterator<Item = JoinedRow>>(rows: T) -> Self {
        Self::Memory(rows.into_iter().collect())
    }
}
impl std::ops::Index<usize> for JoinedRows {
    type Output = JoinedRow;
    fn index(&self, index: usize) -> &JoinedRow {
        match self {
            Self::Memory(rows) => &rows[index],
            Self::Disk { .. } => panic!("磁盘明细必须经游标读取"),
        }
    }
}
impl JoinedRows {
    pub(crate) fn open(path: PathBuf) -> Result<Self, AppError> {
        let conn = Connection::open(&path).map_err(db_error)?;
        let count = conn
            .query_row("SELECT COUNT(*) FROM joined", [], |r| r.get::<_, usize>(0))
            .map_err(db_error)?;
        let lease = Arc::new(DiskLease(path.clone()));
        Ok(Self::Disk {
            path,
            count,
            error: Arc::new(Mutex::new(None)),
            _lease: lease,
        })
    }
    pub(crate) fn path(&self) -> Option<&Path> {
        match self {
            Self::Disk { path, .. } => Some(path),
            _ => None,
        }
    }
    pub(crate) fn len(&self) -> usize {
        match self {
            Self::Memory(rows) => rows.len(),
            Self::Disk { count, .. } => *count,
        }
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub(crate) fn iter(&self) -> RowsIter<'_> {
        match self {
            Self::Memory(rows) => RowsIter::Memory(rows.iter()),
            Self::Disk { path, error, .. } => {
                let conn = Connection::open(path)
                    .map_err(|e| {
                        *error.lock().unwrap() = Some(e.to_string());
                    })
                    .ok();
                RowsIter::Disk {
                    conn,
                    after: 0,
                    buffer: VecDeque::new(),
                    error: Arc::clone(error),
                    done: false,
                }
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn iter_mut(&mut self) -> std::slice::IterMut<'_, JoinedRow> {
        match self {
            Self::Memory(rows) => rows.iter_mut(),
            _ => panic!("磁盘明细使用 edit"),
        }
    }
    pub(crate) fn record_error(&self, message: String) {
        if let Self::Disk { error, .. } = self {
            *error.lock().unwrap() = Some(message);
        }
    }
    pub(crate) fn record_resource_error(&self, error: &AppError) {
        self.record_error(format!("RESOURCE_ERROR:{}\n{}", error.code, error.user_message));
    }
    pub(crate) fn check(&self) -> Result<(), AppError> {
        if let Self::Disk { error, .. } = self {
            if let Some(detail) = error.lock().unwrap().as_ref() {
                if let Some((code,message)) = detail.strip_prefix("RESOURCE_ERROR:").and_then(|value| value.split_once('\n')) {
                    return Err(super::error(code, message, None));
                }
                if let Some(message) = detail.strip_prefix("MEMORY_PROTECTION:") {
                    return Err(super::error("MEMORY_PROTECTION", message, None));
                }
                return Err(super::error(
                    "FA_DISK_READ_FAILED",
                    "磁盘匹配结果读取失败，请重新匹配。",
                    Some(detail.clone()),
                ));
            }
        }
        Ok(())
    }
    pub(crate) fn edit(&mut self, mut edit: impl FnMut(&mut JoinedRow)) -> Result<(), AppError> {
        self.try_edit(|row| {
            edit(row);
            Ok(())
        })
    }
    pub(crate) fn try_edit(
        &mut self,
        mut edit: impl FnMut(&mut JoinedRow) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        match self {
            Self::Memory(rows) => {
                for row in rows {
                    edit(row)?;
                }
            }
            Self::Disk { path, .. } => {
                edit_disk_rows(path, |_, row| edit(row))?;
            }
        }
        Ok(())
    }
}

/// 辅助表读取必须复用写事务的连接；缓存溢写持有排他锁时，第二个连接会锁住自身。
pub(crate) fn edit_disk_rows(
    path: &Path,
    mut edit: impl FnMut(&Connection, &mut JoinedRow) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut conn = Connection::open(path).map_err(db_error)?;
    let tx = conn.transaction().map_err(db_error)?;
    let mut after = 0i64;
    loop {
        let batch = read_batch(&tx, after)?;
        if batch.is_empty() {
            break;
        }
        for (id, mut row) in batch {
            edit(&tx, &mut row)?;
            let data = serde_json::to_string(&row).map_err(json_error)?;
            tx.execute("UPDATE joined SET data=? WHERE id=?", params![data, id])
                .map_err(db_error)?;
            after = id;
        }
    }
    tx.commit().map_err(db_error)?;
    Ok(())
}
pub(crate) enum RowsIter<'a> {
    Memory(std::slice::Iter<'a, JoinedRow>),
    Disk {
        conn: Option<Connection>,
        after: i64,
        buffer: VecDeque<(i64, JoinedRow)>,
        error: Arc<Mutex<Option<String>>>,
        done: bool,
    },
}
impl<'a> Iterator for RowsIter<'a> {
    type Item = Cow<'a, JoinedRow>;
    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Memory(rows) => rows.next().map(Cow::Borrowed),
            Self::Disk {
                conn,
                after,
                buffer,
                error,
                done,
            } => {
                if buffer.is_empty() && !*done {
                    match conn.as_ref().map(|conn| read_batch(conn, *after)) {
                        Some(Ok(batch)) => {
                            *done = batch.is_empty();
                            buffer.extend(batch);
                        }
                        Some(Err(e)) => {
                            *error.lock().unwrap() = Some(if e.code == "JOB_CANCELLED" {
                                format!("RESOURCE_ERROR:{}\n{}",e.code,e.user_message)
                            } else if e.code == "MEMORY_PROTECTION" {
                                format!("MEMORY_PROTECTION:{}", e.user_message)
                            } else {
                                e.user_message.clone()
                            });
                            *done = true;
                        }
                        None => *done = true,
                    }
                }
                buffer.pop_front().map(|(id, row)| {
                    *after = id;
                    Cow::Owned(row)
                })
            }
        }
    }
}
impl<'a> IntoIterator for &'a JoinedRows {
    type Item = Cow<'a, JoinedRow>;
    type IntoIter = RowsIter<'a>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}
fn read_batch(conn: &Connection, after: i64) -> Result<Vec<(i64, JoinedRow)>, AppError> {
    let limit = crate::resource_budget::budget()?.batch_bytes / 4;
    read_batch_limited(conn, after, limit)
}
fn read_batch_limited(
    conn: &Connection,
    after: i64,
    limit: u64,
) -> Result<Vec<(i64, JoinedRow)>, AppError> {
    let mut stmt = conn
        .prepare("SELECT id,data FROM joined WHERE id>? ORDER BY id LIMIT 256")
        .map_err(db_error)?;
    let mut rows = stmt.query([after]).map_err(db_error)?;
    let mut output = Vec::new();
    let mut bytes = 0u64;
    while let Some(row) = rows.next().map_err(db_error)? {
        let data: String = row.get(1).map_err(db_error)?;
        // JSON 字符串、反序列化明细及本批缓存同时存活，预留三份空间。
        let estimated = (data.len() as u64).saturating_mul(3).saturating_add(512);
        if bytes.saturating_add(estimated) > limit && !output.is_empty() { break; }
        if output.is_empty() { crate::resource_budget::check_available_if_managed()?; }
        bytes += estimated;
        output.push((
            row.get(0).map_err(db_error)?,
            serde_json::from_str(&data).map_err(json_error)?,
        ));
    }
    Ok(output)
}
pub(crate) fn db_error(e: rusqlite::Error) -> AppError {
    super::error(
        "FA_DISK_FAILED",
        "固定资产磁盘计算失败。",
        Some(e.to_string()),
    )
}
fn json_error(e: serde_json::Error) -> AppError {
    super::error(
        "FA_DISK_DATA_INVALID",
        "固定资产磁盘数据损坏，请重新匹配。",
        Some(e.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_result_resource_checkpoint_keeps_cancellation_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cancel.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE joined(id INTEGER PRIMARY KEY,data TEXT)").unwrap();
        drop(conn);
        let rows = JoinedRows::open(path).unwrap();
        rows.record_resource_error(&super::super::error("JOB_CANCELLED", "任务已取消。", None));
        assert_eq!(rows.check().unwrap_err().code, "JOB_CANCELLED");
    }
    #[test]
    fn disk_cursor_byte_batches_resume_without_skipping_the_deferred_row() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE joined(id INTEGER PRIMARY KEY,data TEXT)")
            .unwrap();
        for id in 1..=7 {
            let row = JoinedRow {
                begin: Some(vec!["长文本".repeat(100)]),
                end: None,
                source: "仅文件1",
                match_value: id.to_string(),
                extra: Default::default(),
            };
            db.execute(
                "INSERT INTO joined VALUES(?,?)",
                params![id, serde_json::to_string(&row).unwrap()],
            )
            .unwrap();
        }
        let mut ids = Vec::new();
        let mut after = 0;
        loop {
            let batch = read_batch_limited(&db, after, 8000).unwrap();
            if batch.is_empty() {
                break;
            }
            assert!(batch.len() < 7);
            for (id, _) in batch {
                ids.push(id);
                after = id;
            }
        }
        assert_eq!(ids, vec![1, 2, 3, 4, 5, 6, 7]);
        let single = read_batch_limited(&db, 0, 10).unwrap();
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].0, 1);
    }
    #[test]
    fn corrupt_disk_cursor_records_failure_instead_of_accepting_truncated_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("corrupt.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE joined(id INTEGER PRIMARY KEY,data TEXT);INSERT INTO joined VALUES(1,'{broken');").unwrap();
        drop(conn);
        let rows = JoinedRows::open(path.clone()).unwrap();
        assert_eq!(rows.iter().count(), 0);
        assert_eq!(rows.check().unwrap_err().code, "FA_DISK_READ_FAILED");
        let second = rows.clone();
        drop(rows);
        assert!(path.exists());
        drop(second);
        assert!(!path.exists());
    }
}
