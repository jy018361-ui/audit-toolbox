//! Exact column domains on disk. No all-column distinct matrix in RAM.
use super::*;
use crate::AppError;
use rusqlite::{Connection, params};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

pub(crate) type RowVisitor<'a> = dyn FnMut(&[String]) -> Result<(), AppError> + 'a;
pub(crate) type RowSource<'a> = Box<dyn FnMut(&mut RowVisitor<'_>) -> Result<(), AppError> + 'a>;
fn failure(e: impl ToString) -> AppError {
    AppError::new(
        "KEY_DOMAIN_CACHE",
        "无法读写匹配键磁盘索引，请检查缓存磁盘空间后重试。",
        true,
        Some(e.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source(rows: Vec<Vec<String>>) -> RowSource<'static> {
        Box::new(move |visitor| {
            for row in &rows {
                visitor(row)?;
            }
            Ok(())
        })
    }
    #[test]
    fn disk_domains_repairs_match_full_memory_rules_including_tail_hits() {
        let headers = vec![
            "主体".into(),
            "备用主体".into(),
            "辅助".into(),
            "备用辅助".into(),
            "摘要".into(),
        ];
        for mode in 0..5 {
            let tb = (0..450)
                .map(|i| {
                    vec![
                        format!("公司{i}"),
                        if mode == 1 {
                            format!("E{i}")
                        } else {
                            String::new()
                        },
                        format!("供应商{i}"),
                        String::new(),
                        format!("TB摘要{i}"),
                    ]
                })
                .collect::<Vec<_>>();
            let je = (0..450)
                .map(|i| {
                    vec![
                        if mode == 0 && i == 449 {
                            "公司449".into()
                        } else {
                            format!("E{i}")
                        },
                        if mode == 2 {
                            format!("公司{i}")
                        } else {
                            String::new()
                        },
                        if mode == 4 {
                            format!("供应商{i}")
                        } else {
                            format!("V{i}")
                        },
                        if mode == 3 {
                            format!("供应商{i}")
                        } else {
                            String::new()
                        },
                        format!("JE摘要{i}"),
                    ]
                })
                .collect::<Vec<_>>();
            let mut tm = json!({"entity":"主体","auxiliary":"辅助"})
                .as_object()
                .unwrap()
                .clone();
            let mut jm = tm.clone();
            let (mut expected_t, mut expected_j) = (tm.clone(), jm.clone());
            for role in ["entity", "auxiliary"] {
                reconcile_key_domains(
                    role,
                    &headers,
                    &tb,
                    &mut expected_t,
                    &headers,
                    &je,
                    &mut expected_j,
                );
            }
            let cancel = AtomicBool::new(false);
            let mut disk =
                DiskDomains::new(&headers, source(tb), &headers, source(je), &cancel).unwrap();
            for role in ["entity", "auxiliary"] {
                disk.reconcile(role, &mut tm, &mut jm).unwrap();
            }
            assert_eq!((tm, jm), (expected_t, expected_j), "case {mode}");
        }
    }
    #[test]
    fn disk_domains_never_collects_unrelated_large_unique_text() {
        let headers = vec!["编码".into(), "主体".into(), "摘要".into()];
        let generator = || -> RowSource<'static> {
            Box::new(|visitor| {
                for i in 0..35000 {
                    visitor(&[
                        "1002".into(),
                        "A".into(),
                        format!("{i}{}", "长摘要".repeat(700)),
                    ])?;
                }
                Ok(())
            })
        };
        let cancel = AtomicBool::new(false);
        let mut index =
            DiskDomains::new(&headers, generator(), &headers, generator(), &cancel).unwrap();
        let mut tb = json!({"accountCode":"编码","entity":"主体"})
            .as_object()
            .unwrap()
            .clone();
        let mut je = tb.clone();
        assert_eq!(index.account_overlap(&tb, &je).unwrap(), Some((1, 1, 1)));
        index.reconcile("entity", &mut tb, &mut je).unwrap();
        assert!(index.loaded.iter().all(|(_, col, _)| *col != 2));
        assert!(std::fs::metadata(&index.path).unwrap().len() < 1024 * 1024);
        let path = index.path.clone();
        drop(index);
        assert!(!path.exists());
    }
    #[test]
    fn disk_domains_full_account_overlap_includes_values_after_one_hundred_thousand() {
        let headers = vec!["编码".into()];
        let generator = |side| -> RowSource<'static> {
            Box::new(move |visitor| {
                for i in 0..100005 {
                    visitor(&[if i == 100004 {
                        "1122999".into()
                    } else {
                        format!("{side}{i:08}")
                    }])?;
                }
                Ok(())
            })
        };
        let cancel = AtomicBool::new(false);
        let mut index =
            DiskDomains::new(&headers, generator(1), &headers, generator(2), &cancel).unwrap();
        let map = json!({"accountCode":"编码"}).as_object().unwrap().clone();
        assert_eq!(
            index.account_overlap(&map, &map).unwrap(),
            Some((1, 100005, 100005))
        );
    }
    #[test]
    fn disk_domains_large_auxiliary_domain_has_no_fixed_size_rejection() {
        let headers = vec!["辅助".into()];
        let generator = || -> RowSource<'static> {
            Box::new(|visitor| {
                for i in 0..3000 {
                    visitor(&[format!("{i:06}{}", "X".repeat(20000))])?;
                }
                Ok(())
            })
        };
        let cancel = AtomicBool::new(false);
        let mut index =
            DiskDomains::new(&headers, generator(), &headers, generator(), &cancel).unwrap();
        let mut tb = json!({"auxiliary":"辅助"}).as_object().unwrap().clone();
        let mut je = tb.clone();
        index.reconcile("auxiliary", &mut tb, &mut je).unwrap();
        assert_eq!(index.count(0, 0, 0).unwrap(), 3000);
        assert_eq!(tb["auxiliary"], "辅助");
        assert!(std::fs::metadata(&index.path).unwrap().len() > 100 * 1024 * 1024);
    }
    #[test]
    fn disk_domains_cancellation_and_read_failure_never_return_partial_success() {
        let headers = vec!["编码".into()];
        let cancel = AtomicBool::new(true);
        let mut index = DiskDomains::new(
            &headers,
            source(vec![vec!["1002".into()]]),
            &headers,
            source(vec![]),
            &cancel,
        )
        .unwrap();
        let map = json!({"accountCode":"编码"}).as_object().unwrap().clone();
        assert_eq!(
            index.account_overlap(&map, &map).unwrap_err().code,
            "JOB_CANCELLED"
        );
        cancel.store(false, Ordering::Relaxed);
        index.sources[0] = Box::new(|visitor| {
            visitor(&["1002".into()])?;
            Err(failure("模拟来源损坏"))
        });
        assert_eq!(
            index.account_overlap(&map, &map).unwrap_err().code,
            "KEY_DOMAIN_CACHE"
        );
        assert!(!index.loaded.contains(&(0, 0, 1)));
    }
}
pub(crate) struct DiskDomains<'a> {
    db: Option<Connection>,
    path: PathBuf,
    headers: [Vec<String>; 2],
    sources: [RowSource<'a>; 2],
    loaded: HashSet<(usize, usize, u8)>,
    cancel: &'a AtomicBool,
}
impl Drop for DiskDomains<'_> {
    fn drop(&mut self) {
        self.db.take();
        let _ = std::fs::remove_file(&self.path);
    }
}
impl<'a> DiskDomains<'a> {
    pub(crate) fn new(
        tb_headers: &[String],
        tb: RowSource<'a>,
        je_headers: &[String],
        je: RowSource<'a>,
        cancel: &'a AtomicBool,
    ) -> Result<Self, AppError> {
        let root = crate::tabular::cache_root()?.join("key-domains");
        std::fs::create_dir_all(&root).map_err(failure)?;
        let path = root.join(format!("{}.sqlite", uuid::Uuid::new_v4()));
        let db = Connection::open(&path).map_err(failure)?;
        let index = Self {
            db: Some(db),
            path,
            headers: [tb_headers.to_vec(), je_headers.to_vec()],
            sources: [tb, je],
            loaded: HashSet::new(),
            cancel,
        };
        index
            .db()
            .execute_batch(
                "PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA journal_mode=OFF;
            CREATE TABLE domains(side INTEGER,col INTEGER,kind INTEGER,value TEXT COLLATE BINARY,
            PRIMARY KEY(side,col,kind,value)) WITHOUT ROWID;",
            )
            .map_err(failure)?;
        Ok(index)
    }
    fn db(&self) -> &Connection {
        self.db.as_ref().expect("匹配键索引仍打开")
    }
    fn check(&self) -> Result<(), AppError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(AppError::new("JOB_CANCELLED", "任务已取消。", false, None));
        }
        crate::resource_budget::check_available_if_managed()
    }
    fn column(
        &self,
        side: usize,
        map: &serde_json::Map<String, serde_json::Value>,
        role: &str,
    ) -> Option<usize> {
        let names = mapped_headers(map, role);
        self.headers[side]
            .iter()
            .position(|h| names.first() == Some(h))
    }
    // 0: normalized optional key; 1: account code; 2: raw unit evidence.
    fn ensure(&mut self, side: usize, columns: &[usize], kind: u8) -> Result<(), AppError> {
        let missing = columns
            .iter()
            .copied()
            .filter(|col| !self.loaded.contains(&(side, *col, kind)))
            .collect::<Vec<_>>();
        if missing.is_empty() {
            return Ok(());
        }
        self.check()?;
        let tx = self.db.as_mut().unwrap().transaction().map_err(failure)?;
        let mut statement = tx
            .prepare_cached("INSERT OR IGNORE INTO domains VALUES (?1,?2,?3,?4)")
            .map_err(failure)?;
        let cancel = self.cancel;
        let mut count = 0usize;
        (self.sources[side])(&mut |row| {
            count += 1;
            if count % 256 == 0 {
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::new("JOB_CANCELLED", "任务已取消。", false, None));
                }
                crate::resource_budget::check_available_if_managed()?;
            }
            for col in &missing {
                let Some(raw) = row.get(*col).filter(|v| !v.trim().is_empty()) else {
                    continue;
                };
                let value = match kind {
                    0 => crate::fa::normalize_join_key(raw),
                    1 => {
                        let value = account_code_of(raw).trim().to_uppercase();
                        if !(3..=24).contains(&value.len())
                            || !value.chars().any(|c| c.is_ascii_digit())
                            || !value
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
                        {
                            continue;
                        }
                        value
                    }
                    _ => raw.clone(),
                };
                if !value.is_empty() {
                    statement
                        .execute(params![side, col, kind, value])
                        .map_err(failure)?;
                }
            }
            Ok(())
        })?;
        drop(statement);
        tx.commit().map_err(failure)?;
        for col in missing {
            self.loaded.insert((side, col, kind));
        }
        self.check()
    }
    fn count(&self, side: usize, col: usize, kind: u8) -> Result<usize, AppError> {
        self.db()
            .query_row(
                "SELECT COUNT(*) FROM domains WHERE side=?1 AND col=?2 AND kind=?3",
                params![side, col, kind],
                |r| r.get(0),
            )
            .map_err(failure)
    }
    fn overlap(
        &self,
        a: usize,
        ac: usize,
        b: usize,
        bc: usize,
        kind: u8,
        count: bool,
    ) -> Result<usize, AppError> {
        self.check()?;
        let query = if count {
            "SELECT COUNT(*) FROM domains a JOIN domains b ON b.side=?3 AND b.col=?4 AND b.kind=a.kind AND b.value=a.value WHERE a.side=?1 AND a.col=?2 AND a.kind=?5"
        } else {
            "SELECT EXISTS(SELECT 1 FROM domains a JOIN domains b ON b.side=?3 AND b.col=?4 AND b.kind=a.kind AND b.value=a.value WHERE a.side=?1 AND a.col=?2 AND a.kind=?5)"
        };
        self.db()
            .query_row(query, params![a, ac, b, bc, kind], |r| r.get(0))
            .map_err(failure)
    }
    pub(crate) fn account_overlap(
        &mut self,
        tb: &serde_json::Map<String, serde_json::Value>,
        je: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<Option<(usize, usize, usize)>, AppError> {
        let (Some(tc), Some(jc)) = (
            self.column(0, tb, "accountCode"),
            self.column(1, je, "accountCode"),
        ) else {
            return Ok(None);
        };
        self.ensure(0, &[tc], 1)?;
        self.ensure(1, &[jc], 1)?;
        Ok(Some((
            self.overlap(0, tc, 1, jc, 1, true)?,
            self.count(1, jc, 1)?,
            self.count(0, tc, 1)?,
        )))
    }
    pub(crate) fn measurement_unit(
        &mut self,
        side: usize,
        map: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<bool, AppError> {
        for name in mapped_headers(map, "entity") {
            let Some(col) = self.headers[side].iter().position(|h| h == &name) else {
                continue;
            };
            self.ensure(side, &[col], 2)?;
            let mut query = self.db().prepare("SELECT value FROM domains WHERE side=?1 AND col=?2 AND kind=2 ORDER BY value LIMIT 10000").map_err(failure)?;
            let rows = query
                .query_map(params![side, col], |row| Ok(vec![row.get::<_, String>(0)?]))
                .map_err(failure)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(failure)?;
            if entity_column_is_measurement_unit(&[name], &rows, &self.headers[side][col]) {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(crate) fn reconcile(
        &mut self,
        role: &str,
        tb: &mut serde_json::Map<String, serde_json::Value>,
        je: &mut serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), AppError> {
        if super::has_manual_auxiliary_mapping(tb, role) { return Ok(()); }
        let (Some(tc), Some(jc)) = (self.column(0, tb, role), self.column(1, je, role)) else {
            return Ok(());
        };
        self.ensure(0, &[tc], 0)?;
        self.ensure(1, &[jc], 0)?;
        if self.count(0, tc, 0)? == 0
            || self.count(1, jc, 0)? == 0
            || self.overlap(0, tc, 1, jc, 0, false)? > 0
        {
            return Ok(());
        }
        // TB first, then JE; first candidate with an exact full-domain overlap.
        for (side, current, other) in [(0, tc, jc), (1, jc, tc)] {
            let excluded = mapped_headers(if side == 0 { tb } else { je }, role);
            let candidates = self.headers[side]
                .iter()
                .enumerate()
                .filter(|(_, h)| !excluded.contains(h))
                .map(|(col, _)| col)
                .collect::<Vec<_>>();
            self.ensure(side, &candidates, 0)?;
            for col in candidates {
                if col != current && self.overlap(side, col, 1 - side, other, 0, false)? > 0 {
                    let header = self.headers[side][col].clone();
                    (if side == 0 { tb } else { je })
                        .insert(role.into(), serde_json::Value::String(header));
                    return Ok(());
                }
            }
        }
        tb.remove(role);
        je.remove(role);
        Ok(())
    }
}
