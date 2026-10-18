//! 所选列逐行导入；B 侧倒排、粗筛聚合排序及结果全部由 SQLite 承载。
use super::*;

pub(super) const PAGE_SIZE: usize = 200;

fn sql(e: rusqlite::Error) -> AppError {
    error(
        "FUZZY_DISK_FAILED",
        "两列匹配磁盘处理失败，请检查磁盘剩余空间。",
        Some(e.to_string()),
    )
}

fn spec(params: &Value, key: &str) -> Result<SourceSpec, AppError> {
    serde_json::from_value(
        params
            .get(key)
            .cloned()
            .ok_or_else(|| error("MISSING_SOURCE", format!("缺少 {key} 数据源。"), None))?,
    )
    .map_err(|e| error("INVALID_PARAMS", "数据源参数不完整。", Some(e.to_string())))
}

pub(super) fn applies(params: &Value) -> Result<bool, AppError> {
    let a = spec(params, "sourceA")?;
    let b = spec(params, "sourceB")?;
    Ok(params
        .get("__forceDisk")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || crate::disk_table::should_use_disk(&[Path::new(&a.path), Path::new(&b.path)], 2))
}

pub(super) fn preview(spec: &SourceSpec) -> Result<Table, AppError> {
    let (sheet, sheets, all) = crate::disk_table::preview_source(
        Path::new(&spec.path),
        (!spec.sheet.is_empty()).then_some(spec.sheet.as_str()),
        64,
    )?;
    let (header_index, inferred_depth) = crate::header_detection::layout(
        &all,
        30,
        |r| r.iter().filter(|v| header_cell_hit(v)).count() as f64,
        header_cell_hit,
        (spec.header_row > 0).then(|| spec.header_row - 1),
    );
    let header_index = if spec.header_row == 0 && spec.header_depth == 1 {
        detect_header(&all) - 1
    } else {
        header_index
    };
    if header_index >= all.len() {
        return Err(error(
            "HEADER_ROW_INVALID",
            "标题行超出预览范围，请选择文件前部的标题行。",
            None,
        ));
    }
    let width = all.iter().map(Vec::len).max().unwrap_or(0);
    let depth = if spec.header_depth == 0 {
        inferred_depth
    } else {
        spec.header_depth.clamp(1, 2)
    };
    let mut headers = if depth > 1 {
        crate::fx::merge_headers(
            &all[header_index..(header_index + depth).min(all.len())],
            width,
        )
    } else {
        (0..width)
            .map(|i| all[header_index].get(i).cloned().unwrap_or_default())
            .collect()
    };
    for (i, h) in headers.iter_mut().enumerate() {
        if h.trim().is_empty() {
            *h = format!("未命名列{}", i + 1);
        }
    }
    let rows = all
        .into_iter()
        .skip(header_index + depth)
        .filter(|r| r.iter().any(|v| !v.trim().is_empty()))
        .collect();
    Ok(Table {
        sheet,
        sheets,
        header_row: header_index + 1,
        header_depth: depth,
        headers,
        rows,
    })
}

/// 空白整行跳过，与内存路径相同；选中列为空而其他列非空时保留为无效值。
fn visit_column(
    spec: &SourceSpec,
    cancel: &AtomicBool,
    mut visitor: impl FnMut(usize, String) -> Result<(), AppError>,
) -> Result<usize, AppError> {
    let table = preview(spec)?;
    let column = pick_column(spec, &table)?;
    let skip = table.header_row + table.header_depth - 1;
    let mut count = 0;
    crate::disk_table::for_each_source_row(
        Path::new(&spec.path),
        Some(&table.sheet),
        cancel,
        |row, physical| {
            if physical <= skip || !row.iter().any(|v| !v.trim().is_empty()) {
                return Ok(());
            }
            count += 1;
            visitor(
                count,
                row.get(column)
                    .map(|s| s.trim().to_owned())
                    .unwrap_or_default(),
            )
        },
    )?;
    Ok(count)
}

struct WorkFile(PathBuf);
impl Drop for WorkFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(super) fn match_flow(
    params: &Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: &AtomicBool,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    let started = Instant::now();
    let opts = match_options(params)?;
    let a_spec = spec(params, "sourceA")?;
    let b_spec = spec(params, "sourceB")?;
    let db_path = injected(params, "__dbPath")
        .ok_or_else(|| error("INVALID_PARAMS", "大文件匹配需要本机结果库路径。", None))?;
    let job = injected(params, "__jobId")
        .ok_or_else(|| error("INVALID_PARAMS", "大文件匹配需要任务编号。", None))?;
    let temp = WorkFile(std::env::temp_dir().join(format!(
        "audit_fuzzy_{}.sqlite",
        uuid::Uuid::new_v4().simple()
    )));
    let work = Connection::open(&temp.0).map_err(sql)?;
    work.execute_batch("PRAGMA journal_mode=OFF; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE;
        CREATE TABLE b_rows(id INTEGER PRIMARY KEY,value TEXT NOT NULL,norm TEXT NOT NULL,length INTEGER NOT NULL);
        CREATE TABLE grams(gram TEXT NOT NULL,b_id INTEGER NOT NULL,PRIMARY KEY(gram,b_id)) WITHOUT ROWID;
        CREATE TEMP TABLE a_grams(gram TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE results(a_index INTEGER PRIMARY KEY,a_value TEXT NOT NULL,level TEXT NOT NULL,match_json TEXT NOT NULL);
        BEGIN;").map_err(sql)?;
    progress("load", 2, 4, "正在将 B 列和粗筛索引写入磁盘…");
    let rows_b = visit_column(&b_spec, cancel, |index, value| {
        if index % CANCEL_BATCH == 0 {
            checkpoint(cancel, pause)?;
        }
        let row = prepare_row(&value, &opts);
        if row.invalid {
            return Ok(());
        }
        work.execute(
            "INSERT INTO b_rows VALUES(?1,?2,?3,?4)",
            params![index as i64, row.value, row.norm, row.chars.len() as i64],
        )
        .map_err(sql)?;
        let mut insert = work
            .prepare_cached("INSERT INTO grams VALUES(?1,?2)")
            .map_err(sql)?;
        for gram in bigram_set(&row.chars) {
            insert
                .execute(params![gram.iter().collect::<String>(), index as i64])
                .map_err(sql)?;
        }
        Ok(())
    })?;
    work.execute_batch("COMMIT; BEGIN;").map_err(sql)?;
    let mut counts = [0usize; 4];
    let mut comparisons = 0u64;
    progress("match", 0, 0, "正在分批读取 A 列并进行磁盘匹配…");
    let rows_a = visit_column(&a_spec, cancel, |index, value| {
        if index % CANCEL_BATCH == 0 {
            checkpoint(cancel, pause)?;
            progress("match", index, 0, &format!("正在比对 A 列第 {index} 行…"));
        }
        let a = prepare_row(&value, &opts);
        let mut scored: Vec<(usize, String, ScoreBreakdown)> = Vec::new();
        if !a.invalid {
            work.execute("DELETE FROM a_grams", []).map_err(sql)?;
            for gram in bigram_set(&a.chars) {
                work.execute(
                    "INSERT INTO a_grams VALUES(?1)",
                    [gram.iter().collect::<String>()],
                )
                .map_err(sql)?;
            }
            // 先按命中数和原 B 行号排序，再过滤长度并截 200，保持 CoarseScanner 语义。
            // 聚合与排序使用磁盘临时页；Rust 每次只保留当前候选和最终 topK。
            let mut query = work.prepare_cached("SELECT b.id,b.value FROM grams g JOIN a_grams a ON a.gram=g.gram JOIN b_rows b ON b.id=g.b_id GROUP BY b.id ORDER BY count(*) DESC,b.id ASC").map_err(sql)?;
            let mut candidates = query.query([]).map_err(sql)?;
            let mut accepted = 0;
            while let Some(candidate) = candidates.next().map_err(sql)? {
                let j = candidate.get::<_, i64>(0).map_err(sql)? as usize;
                let b = prepare_row(&candidate.get::<_, String>(1).map_err(sql)?, &opts);
                let (la, lb) = (a.chars.len(), b.chars.len());
                if !((la <= lb * LENGTH_RATIO_MAX && lb <= la * LENGTH_RATIO_MAX)
                    || shorter_embedded(&a, &b))
                {
                    continue;
                }
                accepted += 1;
                comparisons += 1;
                let score = score_pair(
                    &a.norm,
                    &a.chars,
                    a.segments.as_ref(),
                    &b.norm,
                    &b.chars,
                    b.segments.as_ref(),
                    &opts,
                );
                if score.total >= opts.suspect_threshold {
                    scored.push((j, b.value, score));
                }
                if accepted == CANDIDATE_LIMIT {
                    break;
                }
            }
        }
        scored.sort_by(|x, y| {
            y.2.total
                .partial_cmp(&x.2.total)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(x.0.cmp(&y.0))
        });
        scored.truncate(opts.top_k);
        let level = if a.invalid {
            "invalid"
        } else if let Some((_, _, s)) = scored.first() {
            if s.total >= opts.auto_threshold {
                "auto"
            } else {
                "suspect"
            }
        } else {
            "unmatched"
        };
        counts[match level {
            "auto" => 0,
            "suspect" => 1,
            "unmatched" => 2,
            _ => 3,
        }] += 1;
        let matches:Vec<Value> = scored.iter().map(|(j,value,s)| json!({"bIndex":j,"bValue":value,"level":if s.total>=opts.auto_threshold {"auto"}else{"suspect"},"total":s.total,"breakdown":s.to_json(),"reasons":s.reasons,"confirmed":Value::Null})).collect();
        work.execute(
            "INSERT INTO results VALUES(?1,?2,?3,?4)",
            params![
                index as i64,
                a.value,
                level,
                serde_json::to_string(&matches).unwrap()
            ],
        )
        .map_err(sql)?;
        if index % CANCEL_BATCH == 0 {
            work.execute_batch("COMMIT; BEGIN;").map_err(sql)?;
        }
        Ok(())
    })?;
    checkpoint(cancel, pause)?;
    work.execute_batch("COMMIT;").map_err(sql)?;
    let summary = json!({"rowsA":rows_a,"rowsB":rows_b,"autoCount":counts[0],"suspectCount":counts[1],"unmatchedCount":counts[2],"invalidCount":counts[3],"estimatedComparisons":comparisons,"elapsedMs":started.elapsed().as_millis() as u64});
    // 成功后才替换正式结果，取消或失败不留下可被当成完整结果的半成品。
    let mut conn = open_db(Path::new(db_path))?;
    conn.execute(
        "ATTACH DATABASE ?1 AS fuzzy_work",
        [temp.0.to_string_lossy().as_ref()],
    )
    .map_err(sql)?;
    let tx = conn.transaction().map_err(sql)?;
    tx.execute("DELETE FROM fuzzy_match_results WHERE job_id=?1", [job])
        .map_err(sql)?;
    tx.execute(
        "DELETE FROM fuzzy_match_confirmations WHERE job_id=?1",
        [job],
    )
    .map_err(sql)?;
    tx.execute("INSERT INTO fuzzy_match_results SELECT ?1,a_index,a_value,level,match_json,?2 FROM fuzzy_work.results",params![job,Utc::now().to_rfc3339()]).map_err(sql)?;
    tx.execute(
        "INSERT OR REPLACE INTO fuzzy_match_summaries(job_id,summary_json) VALUES(?1,?2)",
        params![job, summary.to_string()],
    )
    .map_err(sql)?;
    tx.commit().map_err(sql)?;
    conn.execute_batch("DETACH DATABASE fuzzy_work")
        .map_err(sql)?;
    drop(work);
    let mut result = get_results(
        Path::new(db_path),
        &json!({"jobId":job,"offset":0,"limit":PAGE_SIZE}),
    )?;
    result["processingMode"] = json!("disk");
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(path: &Path, values: &[&str], xlsx_file: bool) {
        if xlsx_file {
            let mut book = Workbook::new();
            let sheet = book.add_worksheet();
            sheet.write_string(0, 0, "公司名称").unwrap();
            sheet.write_string(0, 1, "其他列").unwrap();
            for (i, value) in values.iter().enumerate() {
                sheet.write_string((i + 1) as u32, 0, *value).unwrap();
                sheet.write_string((i + 1) as u32, 1, "保留行").unwrap();
            }
            book.save(path).unwrap();
        } else {
            let mut writer = csv::Writer::from_path(path).unwrap();
            writer.write_record(["公司名称", "其他列"]).unwrap();
            for value in values {
                writer.write_record([*value, "保留行"]).unwrap();
            }
            writer.flush().unwrap();
        }
    }

    fn params(dir: &Path, xlsx: bool) -> Value {
        let ext = if xlsx { "xlsx" } else { "csv" };
        let a = dir.join(format!("a.{ext}"));
        let b = dir.join(format!("b.{ext}"));
        fixture(
            &a,
            &[
                "ＡＢＣ（上海）有限公司",
                "华为",
                "北京华辰科技",
                "",
                "12345",
                "完全无关名字",
                "abcdef",
                "多字节繁體會計事務所",
            ],
            xlsx,
        );
        fixture(
            &b,
            &[
                "ABC(上海)有限公司",
                "华为技术有限公司",
                "上海华辰科技",
                "华为",
                "abcdef",
                "多字节繁体会计事务所",
                "",
            ],
            xlsx,
        );
        json!({"sourceA":{"path":a,"column":"公司名称"},"sourceB":{"path":b,"column":"公司名称"},"__dbPath":dir.join("results.db"),"__jobId":"disk-test","__forceDisk":true,"matchType":"company"})
    }

    #[test]
    fn 磁盘文本与xlsx匹配逐候选等价() {
        for xlsx in [false, true] {
            let dir = std::env::temp_dir().join(format!(
                "audit_fuzzy_equivalent_{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&dir).unwrap();
            let mut p = params(&dir, xlsx);
            for kind in ["company", "generic", "address", "person"] {
                p["matchType"] = json!(kind);
                let cancel = AtomicBool::new(false);
                let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
                let memory =
                    super::super::match_flow(&p, &|_, _, _, _| {}, &cancel, &pause).unwrap();
                let disk = super::match_flow(&p, &|_, _, _, _| {}, &cancel, &pause).unwrap();
                assert_eq!(disk["rows"], memory["rows"], "format={xlsx}, kind={kind}");
                for key in [
                    "rowsA",
                    "rowsB",
                    "autoCount",
                    "suspectCount",
                    "unmatchedCount",
                    "invalidCount",
                    "estimatedComparisons",
                ] {
                    assert_eq!(disk["summary"][key], memory["summary"][key], "{key}");
                }
            }
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn 候选同分排序与二百上限保持且分页导出完整() {
        let dir = std::env::temp_dir().join(format!(
            "audit_fuzzy_pages_{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let mut p = params(&dir, false);
        let names: Vec<String> = (0..240).map(|i| format!("abcdef公司{i:03}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        fixture(
            Path::new(p["sourceA"]["path"].as_str().unwrap()),
            &refs,
            false,
        );
        fixture(
            Path::new(p["sourceB"]["path"].as_str().unwrap()),
            &refs,
            false,
        );
        p["matchType"] = json!("generic");
        let cancel = AtomicBool::new(false);
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let memory = super::super::match_flow(&p, &|_, _, _, _| {}, &cancel, &pause).unwrap();
        let result = run_job(
            "fuzzy.match",
            p.clone(),
            &|_, _, _, _| {},
            Arc::new(AtomicBool::new(false)),
            &pause,
        )
        .unwrap();
        assert_eq!(result["rows"].as_array().unwrap().len(), PAGE_SIZE);
        assert_eq!(
            result["rows"],
            json!(&memory["rows"].as_array().unwrap()[..PAGE_SIZE])
        );
        assert_eq!(
            result["summary"]["estimatedComparisons"],
            memory["summary"]["estimatedComparisons"]
        );
        assert!(
            result["summary"]["estimatedComparisons"].as_u64().unwrap()
                <= 240 * CANDIDATE_LIMIT as u64
        );
        let db = Path::new(p["__dbPath"].as_str().unwrap());
        let tail = get_results(
            db,
            &json!({"jobId":"disk-test","offset":PAGE_SIZE,"limit":PAGE_SIZE}),
        )
        .unwrap();
        assert_eq!(tail["rows"].as_array().unwrap().len(), 40);
        assert_eq!(tail["hasMore"], false);
        save_confirm(db,&json!({"jobId":"disk-test","confirmations":[{"aIndex":240,"bIndex":240,"action":"accept"}]})).unwrap();
        let path = dir.join("导出.xlsx");
        export_flow(&json!({"jobId":"disk-test","__dbPath":db,"outputPath":path})).unwrap();
        let mut book = open_workbook_auto(&path).unwrap();
        let range = book.worksheet_range("全部结果").unwrap();
        let tail_rows: Vec<_> = range.rows().filter(|r| data_text(&r[1]) == "240").collect();
        assert!(!tail_rows.is_empty());
        assert!(tail_rows.iter().any(|r| data_text(&r[11]) == "已确认"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn 已取消任务不覆盖既有结果() {
        let dir = std::env::temp_dir().join(format!(
            "audit_fuzzy_cancel_{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let p = params(&dir, false);
        let cancel = AtomicBool::new(true);
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let err = super::match_flow(&p, &|_, _, _, _| {}, &cancel, &pause).unwrap_err();
        assert_eq!(err.code, "JOB_CANCELLED");
        assert!(!dir.join("results.db").exists());
        let _ = fs::remove_dir_all(dir);
    }
}
