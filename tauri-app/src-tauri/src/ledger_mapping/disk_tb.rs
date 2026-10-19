//! 全表规则先扫描，完整主体/连续主体段分阶段分析；SQLite 保存原序和轮次。
//! 分组只限定内存工作集，不能改变全表符号、定长判据或相邻关系。
use super::*;
use crate::{
    AppError,
    disk_table::{DiskTable, Progress},
};
use rusqlite::{Connection, params};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

#[cfg(test)]
mod tests;

fn failure(message: &str, detail: impl ToString) -> AppError {
    AppError::new(
        "TB_DISK_ANALYSIS_FAILED",
        message,
        true,
        Some(detail.to_string()),
    )
}
fn sql(e: rusqlite::Error) -> AppError {
    failure("TB 磁盘分析失败，请检查磁盘剩余空间。", e)
}
fn check(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::new("JOB_CANCELLED", "任务已取消。", false, None));
    }
    crate::resource_budget::check_available_if_managed()
}
struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(crate) struct DiskTbAnalysis {
    pub(crate) analysis: TbLeafAnalysis,
    pub(crate) currency_warnings: Vec<String>,
    pub(crate) convention: SignConvention,
    pub(crate) opening_self_signed: bool,
    pub(crate) closing_self_signed: bool,
    pub(crate) self_signed: BTreeMap<String, bool>,
    pub(crate) sign_evidence: SignEvidence,
    pub(crate) balance_basis_self_signed: BTreeMap<String, bool>,
    pub(crate) posting_level: bool,
    store: Option<DiskTbStore>,
}

struct DiskTbStore {
    db: Connection,
    _temp: Temp,
    group_limit: usize,
}

impl DiskTbAnalysis {
    /// Complete entity groups preserve physical gaps through excluded blank sentinels.
    /// `ids` are body logical indexes + 1; 0 denotes a sentinel, never a source row.
    pub(crate) fn visit_entity_groups(
        &self,
        headers: &[String],
        column: &dyn Fn(&str) -> Vec<String>,
        cancel: &AtomicBool,
        mut visitor: impl FnMut(
            &[Vec<String>],
            &[usize],
            TbLeafAnalysis,
            Vec<bool>,
        ) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let Some(store) = &self.store else {
            return Ok(());
        };
        let basis = Basis {
            convention: self.convention,
            signed: self.self_signed.clone(),
        };
        each_entity(
            &store.db,
            headers,
            column,
            &basis,
            store.group_limit,
            cancel,
            |g| {
                let analysis = TbLeafAnalysis {
                    keep: g
                        .ids
                        .iter()
                        .map(|id| *id > 0 && self.analysis.keep[*id - 1])
                        .collect(),
                    contexts: if self.analysis.contexts.is_empty() {
                        vec![]
                    } else {
                        g.ids
                            .iter()
                            .map(|id| {
                                if *id > 0 {
                                    self.analysis.contexts[*id - 1].clone()
                                } else {
                                    String::new()
                                }
                            })
                            .collect()
                    },
                    parent_names: if self.analysis.parent_names.is_empty() {
                        vec![]
                    } else {
                        g.ids
                            .iter()
                            .map(|id| {
                                if *id > 0 {
                                    self.analysis.parent_names[*id - 1].clone()
                                } else {
                                    String::new()
                                }
                            })
                            .collect()
                    },
                };
                let mut currency = Vec::with_capacity(g.ids.len());
                for id in &g.ids {
                    currency.push(if *id == 0 {
                        false
                    } else {
                        store
                            .db
                            .query_row(
                                "SELECT currency_excluded FROM body WHERE id=?1",
                                [*id as i64],
                                |r| r.get::<_, bool>(0),
                            )
                            .map_err(sql)?
                    });
                }
                visitor(&g.rows, &g.ids, analysis, currency)
            },
        )
    }
    pub(crate) fn junk_mask(&self) -> Result<Vec<bool>, AppError> {
        let Some(store) = &self.store else {
            return Ok(vec![true; self.analysis.keep.len()]);
        };
        let mut statement = store
            .db
            .prepare("SELECT junk FROM body ORDER BY id")
            .map_err(sql)?;
        statement
            .query_map([], |r| r.get::<_, bool>(0))
            .map_err(sql)?
            .map(|r| r.map_err(sql))
            .collect()
    }
}

#[derive(Default)]
struct SignedCounter {
    credit: usize,
    negative: usize,
    amount_positive: usize,
    amount_negative: usize,
}
impl SignedCounter {
    fn push(
        &mut self,
        headers: &[String],
        row: &[String],
        column: &dyn Fn(&str) -> Vec<String>,
        prefix: &str,
    ) {
        let idx = |role: &str| column(role).iter().find_map(|v| header_index(headers, v));
        let Some(amount) = idx(&format!("{prefix}Amount")) else {
            return;
        };
        if let Some(v) = row.get(amount).and_then(|s| parse_amount(s).ok().flatten()) {
            self.amount_positive += usize::from(v > 0.0);
            self.amount_negative += usize::from(v < 0.0);
        }
        if idx(&format!("{prefix}Debit")).is_some() {
            return;
        }
        let base = prefix
            .strip_suffix("Functional")
            .or_else(|| prefix.strip_suffix("Foreign"))
            .unwrap_or(prefix);
        let Some(direction) = idx(&format!("{base}Direction")).or_else(|| idx("direction")) else {
            return;
        };
        if !row
            .get(direction)
            .is_some_and(|s| !s.trim().is_empty() && is_credit_direction(s))
        {
            return;
        }
        if let Some(v) = row
            .get(amount)
            .and_then(|s| parse_amount(s).ok().flatten())
            .filter(|v| *v != 0.0)
        {
            self.credit += 1;
            self.negative += usize::from(v < 0.0);
        }
    }
    fn signed(&self) -> bool {
        self.credit > 0 && self.negative * 2 > self.credit
    }
}

fn indices(headers: &[String], column: &dyn Fn(&str) -> Vec<String>, role: &str) -> Vec<usize> {
    column(role)
        .iter()
        .filter_map(|s| header_index(headers, s))
        .collect()
}
fn join(row: &[String], positions: &[usize]) -> String {
    positions
        .iter()
        .filter_map(|i| row.get(*i))
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join("\u{1f}")
        .to_uppercase()
}

struct Group {
    ids: Vec<usize>,
    rows: Vec<Vec<String>>,
    identities: Vec<(String, String)>,
    names: Vec<String>,
    aux: Vec<String>,
    currencies: Vec<String>,
    levels: Vec<Option<u32>>,
    values: Vec<Vec<f64>>,
    excluded: Vec<bool>,
}
impl Group {
    fn from_rows(
        ids: Vec<usize>,
        rows: Vec<Vec<String>>,
        excluded: Vec<bool>,
        headers: &[String],
        column: &dyn Fn(&str) -> Vec<String>,
        basis: &Basis,
    ) -> Self {
        let mut codes = indices(headers, column, "accountCode");
        if codes.is_empty() {
            codes = indices(headers, column, "account");
            codes.truncate(1);
        }
        let entities = indices(headers, column, "entity");
        let names = indices(headers, column, "accountName");
        let aux = indices(headers, column, "auxiliary");
        let mut currencies = indices(headers, column, "currency");
        currencies.extend(indices(headers, column, "functionalCurrency"));
        currencies.sort_unstable();
        currencies.dedup();
        let level = headers.iter().position(|h| {
            matches!(
                normalize_header(h).as_str(),
                "级次" | "科目级次" | "层级" | "科目层级" | "级别" | "科目级别"
            )
        });
        let values =
            rollup_value_columns_with_basis(headers, &rows, column, basis.convention, &|p| {
                basis.self_signed(p)
            });
        Self {
            ids,
            identities: rows
                .iter()
                .map(|r| (join(r, &entities), account_code_of(&join(r, &codes))))
                .collect(),
            names: rows.iter().map(|r| join(r, &names)).collect(),
            aux: rows.iter().map(|r| join(r, &aux)).collect(),
            currencies: rows.iter().map(|r| join(r, &currencies)).collect(),
            levels: rows
                .iter()
                .map(|r| {
                    level
                        .and_then(|i| r.get(i))
                        .and_then(|v| v.trim().parse().ok())
                })
                .collect(),
            rows,
            values,
            excluded,
        }
    }
}

struct Basis {
    convention: SignConvention,
    signed: BTreeMap<String, bool>,
}
impl Basis {
    fn self_signed(&self, prefix: &str) -> bool {
        self.signed.get(prefix).copied().unwrap_or(false)
    }
}

/// Stream balance-sign votes with exactly the predicates used by tb_sign_evidence.
fn convention(
    db: &Connection,
    headers: &[String],
    column: &dyn Fn(&str) -> Vec<String>,
    signed: &BTreeMap<String, bool>,
    cancel: &AtomicBool,
) -> Result<SignEvidence, AppError> {
    let idx = |role: &str| column(role).iter().find_map(|v| header_index(headers, v));
    let available = |prefix: &str| {
        idx(&format!("{prefix}Amount")).is_some()
            || (idx(&format!("{prefix}Debit")).is_some()
                && idx(&format!("{prefix}Credit")).is_some())
    };
    let unit = ["Functional", "Foreign"].into_iter().find(|u| {
        available(&format!("opening{u}"))
            && available(&format!("closing{u}"))
            && idx(&format!("ytd{u}Debit")).is_some()
            && idx(&format!("ytd{u}Credit")).is_some()
    });
    let Some(unit) = unit else {
        return Ok(detect_tb_sign_convention(headers, &[], column));
    };
    let balance = |row: &[String], prefix: &str| {
        let number = |r: &str| {
            idx(r)
                .and_then(|i| row.get(i))
                .and_then(|v| parse_amount(v).ok().flatten())
        };
        let base = prefix
            .strip_suffix("Functional")
            .or_else(|| prefix.strip_suffix("Foreign"))
            .unwrap_or(prefix);
        let direction = idx(&format!("{base}Direction"))
            .or_else(|| idx("direction"))
            .and_then(|i| row.get(i))
            .cloned();
        signed_balance(
            &AmountInputs {
                amount: number(&format!("{prefix}Amount")),
                debit: number(&format!("{prefix}Debit")),
                credit: number(&format!("{prefix}Credit")),
                direction,
            },
            SignConvention::Unsigned,
            signed.get(prefix).copied().unwrap_or(false),
        )
    };
    let mut evidence = SignEvidence::blank("tb");
    let (mut positive, mut negative) = (0, 0);
    visit_raw(db, cancel, |_, row| {
        let n = |r: &str| {
            idx(r)
                .and_then(|i| row.get(i))
                .and_then(|v| parse_amount(v).ok().flatten())
                .unwrap_or(0.0)
        };
        let r = BalanceRow {
            opening: balance(&row, &format!("opening{unit}")),
            closing: balance(&row, &format!("closing{unit}")),
            debit: n(&format!("ytd{unit}Debit")),
            credit: n(&format!("ytd{unit}Credit")),
        };
        if !(r.opening.abs() > 0.0
            || r.debit.abs() > 0.0
            || r.credit.abs() > 0.0
            || r.closing.abs() > 0.0)
        {
            return Ok(());
        }
        positive += usize::from(r.credit > 0.0);
        negative += usize::from(r.credit < 0.0);
        evidence.total_vouchers += 1;
        if r.credit.abs() != 0.0 {
            match (holds(&r, -1.0), holds(&r, 1.0)) {
                (true, false) => evidence.unsigned_votes += 1,
                (false, true) => evidence.signed_votes += 1,
                (true, true) => evidence.one_sided += 1,
                (false, false) => evidence.unbalanced += 1,
            }
        } else {
            evidence.one_sided += 1;
        }
        Ok(())
    })?;
    if evidence.total_vouchers == 0 {
        evidence.note = Some("科目余额表没有可用于勾稽的数据行。".into());
        return Ok(evidence);
    }
    match tally_votes(evidence.signed_votes, evidence.unsigned_votes) {
        VoteOutcome::Decided(c) => evidence.convention = Some(c),
        VoteOutcome::Tie => {
            evidence.note = Some("勾稽等式对两种口径的成立行数打平，无法自动判定。".into())
        }
        VoteOutcome::NoVotes => fallback_by_credit_counts(&mut evidence, positive, negative),
    }
    Ok(evidence)
}

fn visit_raw(
    db: &Connection,
    cancel: &AtomicBool,
    mut visit: impl FnMut(usize, Vec<String>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut stmt = db
        .prepare("SELECT id,raw FROM body ORDER BY id")
        .map_err(sql)?;
    let mut rows = stmt.query([]).map_err(sql)?;
    while let Some(r) = rows.next().map_err(sql)? {
        let id = r.get::<_, i64>(0).map_err(sql)? as usize;
        if id % 256 == 0 {
            check(cancel)?;
        }
        let raw = r.get::<_, String>(1).map_err(sql)?;
        visit(
            id,
            serde_json::from_str(&raw)
                .map_err(|e| failure("TB 缓存记录损坏，请重新读取文件。", e))?,
        )?;
    }
    Ok(())
}

/// `source` body is already disk-backed; only a full semantic group can be loaded.
/// Complete hierarchy groups retain their semantics; size estimates never reject them.
pub(crate) fn analyze(
    source: &DiskTable,
    column: &dyn Fn(&str) -> Vec<String>,
    collect_context: bool,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<DiskTbAnalysis, AppError> {
    analyze_with_limit(source, column, collect_context, progress, cancel, None)
}

fn analyze_with_limit(
    source: &DiskTable,
    column: &dyn Fn(&str) -> Vec<String>,
    collect_context: bool,
    progress: Progress<'_>,
    cancel: &AtomicBool,
    limit: Option<usize>,
) -> Result<DiskTbAnalysis, AppError> {
    check(cancel)?;
    let group_limit = limit.unwrap_or(usize::MAX);
    let temp = Temp(
        std::env::temp_dir().join(format!("audit_tb_{}.sqlite", uuid::Uuid::new_v4().simple())),
    );
    let db = Connection::open(&temp.0).map_err(sql)?;
    db.execute_batch("PRAGMA journal_mode=OFF; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;
        CREATE TABLE body(id INTEGER PRIMARY KEY,entity TEXT NOT NULL,raw TEXT NOT NULL,excluded INTEGER NOT NULL DEFAULT 0,junk INTEGER NOT NULL DEFAULT 1,currency_excluded INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX body_entity ON body(entity,id);
        CREATE TABLE parents(child INTEGER NOT NULL,parent INTEGER NOT NULL);
        CREATE TABLE candidates(segment INTEGER NOT NULL,payload TEXT NOT NULL,strong INTEGER NOT NULL);
        BEGIN;").map_err(sql)?;
    let headers = &source.headers;
    let any_account = !indices(headers, column, "accountCode").is_empty()
        || !indices(headers, column, "account").is_empty();
    let any_amount = TB_AMOUNT_ROLES
        .iter()
        .any(|p| !indices(headers, column, p).is_empty());
    if !any_account && !any_amount {
        return Ok(DiskTbAnalysis {
            analysis: TbLeafAnalysis {
                keep: vec![true; source.row_count],
                contexts: if collect_context {
                    vec![String::new(); source.row_count]
                } else {
                    vec![]
                },
                parent_names: if collect_context {
                    vec![String::new(); source.row_count]
                } else {
                    vec![]
                },
            },
            currency_warnings: vec![],
            convention: SignConvention::Unsigned,
            opening_self_signed: false,
            closing_self_signed: false,
            self_signed: BTreeMap::new(),
            sign_evidence: detect_tb_sign_convention(headers, &[], column),
            balance_basis_self_signed: BTreeMap::new(),
            posting_level: false,
            store: None,
        });
    }
    let entity = indices(headers, column, "entity");
    let rule = LedgerBodyRule::new(headers, column);
    let mut counters: BTreeMap<String, SignedCounter> = [
        "openingFunctional",
        "closingFunctional",
        "openingForeign",
        "closingForeign",
    ]
    .into_iter()
    .map(|p| (p.to_owned(), SignedCounter::default()))
    .collect();
    let (mut code_alive, mut name_alive, mut last_identity, mut has_label) =
        (false, false, 0usize, false);
    let mut label_positions = indices(headers, column, "accountCode");
    label_positions.extend(indices(headers, column, "accountName"));
    label_positions.extend(indices(headers, column, "account"));
    let mut body_count = 0;
    // Source visits retain physical IDs; body mask output indexes follow visit order.
    source.visit(cancel, |row, _| {
        body_count += 1;
        code_alive |= rule.has_field(row, &rule.code);
        name_alive |= rule.has_field(row, &rule.name);
        if rule.has_identity(row) {
            last_identity = body_count;
        }
        has_label |= label_positions
            .iter()
            .filter_map(|i| row.get(*i))
            .any(|v| is_rollup_label(v));
        for (p, c) in &mut counters {
            c.push(headers, row, column, p);
        }
        db.execute(
            "INSERT INTO body(id,entity,raw) VALUES(?1,?2,?3)",
            params![
                body_count as i64,
                join(row, &entity),
                serde_json::to_string(row).unwrap()
            ],
        )
        .map_err(sql)?;
        Ok(())
    })?;
    db.execute_batch("COMMIT;").map_err(sql)?;
    let balance_basis_self_signed = counters
        .iter()
        .map(|(p, c)| {
            let base = p
                .strip_suffix("Functional")
                .or_else(|| p.strip_suffix("Foreign"))
                .unwrap_or(p);
            let no_direction = indices(headers, column, &format!("{base}Direction")).is_empty()
                && indices(headers, column, "direction").is_empty()
                && indices(headers, column, &format!("{p}Direction")).is_empty();
            (
                p.clone(),
                c.signed() || (no_direction && c.amount_positive > 0 && c.amount_negative > 0),
            )
        })
        .collect();
    let signed: BTreeMap<String, bool> =
        counters.into_iter().map(|(p, c)| (p, c.signed())).collect();
    let sign_evidence = convention(&db, headers, column, &signed, cancel)?;
    let basis = Basis {
        convention: sign_evidence.convention.unwrap_or(SignConvention::Unsigned),
        signed,
    };
    let mut strict = false;
    visit_raw(&db, cancel, |id, row| {
        let blank = row.iter().all(|v| v.trim().is_empty());
        if blank {
            strict = true;
        }
        let mut keep = if rule.identity.is_empty() {
            true
        } else if blank {
            false
        } else if strict && rule.boundary {
            let identity = if code_alive && name_alive {
                rule.has_field(&row, &rule.code) && rule.has_field(&row, &rule.name)
            } else if code_alive {
                rule.has_field(&row, &rule.code)
            } else {
                rule.has_field(&row, &rule.name)
            };
            identity && rule.has_parseable_je_amount(&row)
        } else {
            rule.is_body(&row)
        };
        if !rule.identity.is_empty() && id > last_identity {
            keep = false;
        }
        if keep && let Some(i) = rule.code.first() {
            let raw = row.get(*i).map(|s| s.trim()).unwrap_or("");
            if !raw.is_empty()
                && !is_rollup_label(raw)
                && !is_formula_error(raw)
                && !looks_like_account_code(&account_code_of(raw))
            {
                keep = false;
            }
        }
        db.execute(
            "UPDATE body SET junk=?1 WHERE id=?2",
            params![keep, id as i64],
        )
        .map_err(sql)?;
        if label_positions
            .iter()
            .filter_map(|i| row.get(*i))
            .any(|v| is_rollup_label(v))
        {
            keep = false;
        }
        db.execute(
            "UPDATE body SET excluded=?1 WHERE id=?2",
            params![!keep, id as i64],
        )
        .map_err(sql)?;
        Ok(())
    })?;
    let mut warnings = Vec::new();
    progress("tb_disk", 0, body_count, "正在验证 TB 跨币种总分结构…");
    each_entity(&db, headers, column, &basis, group_limit, cancel, |g| {
        // Dummy blank separators preserve the original nearest-account inheritance.
        let (excluded, w) =
            tb_currency_rollup_analysis_with_values(headers, &g.rows, column, &g.values);
        warnings.extend(w);
        for (i, yes) in excluded.into_iter().enumerate() {
            if yes && g.ids[i] > 0 {
                db.execute(
                    "UPDATE body SET excluded=1,currency_excluded=1 WHERE id=?1",
                    [g.ids[i] as i64],
                )
                .map_err(sql)?;
            }
        }
        Ok(())
    })?;
    let mut lengths = BTreeSet::new();
    let mut account = indices(headers, column, "accountCode");
    if account.is_empty() {
        account = indices(headers, column, "account");
        account.truncate(1);
    }
    let mut amounts = TB_AMOUNT_ROLES
        .iter()
        .flat_map(|p| indices(headers, column, p))
        .collect::<Vec<_>>();
    amounts.sort_unstable();
    amounts.dedup();
    visit_raw(&db, cancel, |id, row| {
        let excluded: bool = db
            .query_row("SELECT excluded FROM body WHERE id=?1", [id as i64], |r| {
                r.get(0)
            })
            .map_err(sql)?;
        let code = account_code_of(&join(&row, &account));
        if !excluded && !code.is_empty() {
            lengths.insert(code.chars().count());
        }
        Ok(())
    })?;
    let fixed = lengths.len() == 1;
    if fixed {
        visit_raw(&db, cancel, |id, row| {
            if account_code_of(&join(&row, &account)).is_empty() {
                db.execute("UPDATE body SET excluded=1 WHERE id=?1", [id as i64])
                    .map_err(sql)?;
            }
            Ok(())
        })?;
    }
    // Posting table classification depends on headers and the presence of any label.
    let posting = !has_label && tb_is_posting_level_export(headers, &[], column);
    let semantic_count =
        rollup_value_columns_with_basis(headers, &[], column, basis.convention, &|p| {
            basis.self_signed(p)
        })
        .len();
    if amounts.len() >= 2 && semantic_count >= 2 && !posting {
        each_segment(
            &db,
            false,
            headers,
            column,
            &basis,
            group_limit,
            cancel,
            |mut g| {
                if g.values.len() >= 2 {
                    mark_zero_value_parents(
                        &g.identities,
                        &g.currencies,
                        &g.levels,
                        &g.values,
                        &mut g.excluded,
                    );
                    save_mask(&db, &g)?;
                }
                Ok(())
            },
        )?;
        if !fixed {
            non_contiguous(&db, headers, column, &basis, group_limit, cancel)?;
        }
        adjacent(
            &db,
            false,
            headers,
            column,
            &basis,
            group_limit,
            fixed,
            collect_context,
            cancel,
        )?;
        for round in 0..4 {
            let before: usize = db
                .query_row("SELECT count(*) FROM body WHERE excluded=0", [], |r| {
                    r.get(0)
                })
                .map_err(sql)?;
            if before < 2 {
                break;
            }
            progress(
                "tb_disk",
                round + 1,
                4,
                "正在按完整原序逐轮验证 TB 末级科目…",
            );
            adjacent(
                &db,
                true,
                headers,
                column,
                &basis,
                group_limit,
                fixed,
                collect_context,
                cancel,
            )?;
            let after: usize = db
                .query_row("SELECT count(*) FROM body WHERE excluded=0", [], |r| {
                    r.get(0)
                })
                .map_err(sql)?;
            if before == after {
                break;
            }
        }
        non_contiguous(&db, headers, column, &basis, group_limit, cancel)?;
    }
    let mut analysis = TbLeafAnalysis {
        keep: vec![true; body_count],
        contexts: if collect_context {
            vec![String::new(); body_count]
        } else {
            vec![]
        },
        parent_names: if collect_context {
            vec![String::new(); body_count]
        } else {
            vec![]
        },
    };
    let mut mask = db
        .prepare("SELECT id,excluded FROM body ORDER BY id")
        .map_err(sql)?;
    for row in mask
        .query_map([], |r| Ok((r.get::<_, usize>(0)?, r.get::<_, bool>(1)?)))
        .map_err(sql)?
    {
        let (id, excluded) = row.map_err(sql)?;
        analysis.keep[id - 1] = !excluded;
    }
    if collect_context {
        each_entity(&db, headers, column, &basis, group_limit, cancel, |g| {
            let local: HashMap<usize, usize> = g
                .ids
                .iter()
                .enumerate()
                .filter(|(_, id)| **id > 0)
                .map(|(i, id)| (*id, i))
                .collect();
            let mut parents = Vec::new();
            let mut statement=db.prepare("SELECT child,parent FROM parents WHERE child IN (SELECT id FROM body WHERE entity=?1)").map_err(sql)?;
            let entity = g
                .identities
                .iter()
                .find(|(e, _)| !e.is_empty())
                .map(|(e, _)| e.clone())
                .unwrap_or_default();
            for row in statement
                .query_map([entity], |r| {
                    Ok((r.get::<_, usize>(0)?, r.get::<_, usize>(1)?))
                })
                .map_err(sql)?
            {
                let (c, p) = row.map_err(sql)?;
                if let (Some(c), Some(p)) = (local.get(&c), local.get(&p)) {
                    parents.push((*c, *p));
                }
            }
            let a = tb_leaf_context(headers, &g.rows, column, true, g.excluded.clone(), parents);
            for (i, id) in g.ids.iter().copied().enumerate() {
                if id > 0 {
                    if i % 256 == 0 { check(cancel)?; }
                    analysis.contexts[id - 1] = a.contexts[i].clone();
                    analysis.parent_names[id - 1] = a.parent_names[i].clone();
                }
            }
            Ok(())
        })?;
    }
    check(cancel)?;
    drop(mask);
    Ok(DiskTbAnalysis {
        analysis,
        currency_warnings: warnings,
        convention: basis.convention,
        opening_self_signed: basis.self_signed("openingFunctional"),
        closing_self_signed: basis.self_signed("closingFunctional"),
        self_signed: basis.signed,
        sign_evidence,
        balance_basis_self_signed,
        posting_level: posting,
        store: Some(DiskTbStore {
            db,
            _temp: temp,
            group_limit,
        }),
    })
}

fn save_mask(db: &Connection, g: &Group) -> Result<(), AppError> {
    for (i, id) in g.ids.iter().copied().enumerate() {
        if id > 0 && g.excluded[i] {
            db.execute("UPDATE body SET excluded=1 WHERE id=?1", [id as i64])
                .map_err(sql)?;
        }
    }
    Ok(())
}

fn guard(_bytes: usize, _limit: usize) -> Result<(), AppError> {
    crate::resource_budget::check_available_if_managed()
}

fn each_entity(
    db: &Connection,
    headers: &[String],
    column: &dyn Fn(&str) -> Vec<String>,
    basis: &Basis,
    limit: usize,
    cancel: &AtomicBool,
    mut visit: impl FnMut(Group) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut entities = db
        .prepare("SELECT entity FROM body GROUP BY entity ORDER BY entity")
        .map_err(sql)?;
    let names = entities
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql)?;
    for name in names {
        check(cancel)?;
        let name = name.map_err(sql)?;
        let mut query = db
            .prepare("SELECT id,raw,excluded FROM body WHERE entity=?1 ORDER BY id")
            .map_err(sql)?;
        let mut records = query.query([name]).map_err(sql)?;
        let (mut ids, mut rows, mut excluded, mut bytes, mut previous) =
            (Vec::new(), Vec::new(), Vec::new(), 0usize, 0usize);
        while let Some(r) = records.next().map_err(sql)? {
            let id = r.get::<_, usize>(0).map_err(sql)?;
            let raw = r.get::<_, String>(1).map_err(sql)?;
            bytes = bytes.saturating_add(raw.len().saturating_mul(12) + 512);
            guard(bytes, limit)?;
            if previous > 0 && id != previous + 1 {
                ids.push(0);
                rows.push(Vec::new());
                excluded.push(true);
            }
            previous = id;
            ids.push(id);
            rows.push(serde_json::from_str(&raw).map_err(|e| failure("TB 缓存记录损坏。", e))?);
            excluded.push(r.get::<_, bool>(2).map_err(sql)?);
        }
        visit(Group::from_rows(
            ids, rows, excluded, headers, column, basis,
        ))?;
    }
    Ok(())
}

fn each_segment(
    db: &Connection,
    compact: bool,
    headers: &[String],
    column: &dyn Fn(&str) -> Vec<String>,
    basis: &Basis,
    limit: usize,
    cancel: &AtomicBool,
    mut visit: impl FnMut(Group) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut statement = db
        .prepare(if compact {
            "SELECT id,entity,raw,excluded FROM body WHERE excluded=0 ORDER BY id"
        } else {
            "SELECT id,entity,raw,excluded FROM body ORDER BY id"
        })
        .map_err(sql)?;
    let mut records = statement.query([]).map_err(sql)?;
    let (mut ids, mut rows, mut excluded, mut bytes, mut entity) =
        (Vec::new(), Vec::new(), Vec::new(), 0usize, None::<String>);
    while let Some(r) = records.next().map_err(sql)? {
        check(cancel)?;
        let e = r.get::<_, String>(1).map_err(sql)?;
        if entity.as_ref().is_some_and(|old| old != &e) {
            visit(Group::from_rows(
                std::mem::take(&mut ids),
                std::mem::take(&mut rows),
                std::mem::take(&mut excluded),
                headers,
                column,
                basis,
            ))?;
            bytes = 0;
        }
        entity = Some(e);
        let raw = r.get::<_, String>(2).map_err(sql)?;
        bytes = bytes.saturating_add(raw.len().saturating_mul(12) + 512);
        guard(bytes, limit)?;
        ids.push(r.get::<_, usize>(0).map_err(sql)?);
        rows.push(serde_json::from_str(&raw).map_err(|e| failure("TB 缓存记录损坏。", e))?);
        excluded.push(r.get::<_, bool>(3).map_err(sql)?);
    }
    if !ids.is_empty() {
        visit(Group::from_rows(
            ids, rows, excluded, headers, column, basis,
        ))?;
    }
    Ok(())
}

fn non_contiguous(
    db: &Connection,
    headers: &[String],
    column: &dyn Fn(&str) -> Vec<String>,
    basis: &Basis,
    limit: usize,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    each_entity(db, headers, column, basis, limit, cancel, |mut g| {
        mark_non_contiguous_code_rollups(&g.identities, &g.values, &mut g.excluded);
        save_mask(db, &g)
    })
}

fn adjacent(
    db: &Connection,
    compact: bool,
    headers: &[String],
    column: &dyn Fn(&str) -> Vec<String>,
    basis: &Basis,
    limit: usize,
    fixed: bool,
    context: bool,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    db.execute("DELETE FROM candidates", []).map_err(sql)?;
    each_segment(db, compact, headers, column, basis, limit, cancel, |g| {
        let candidates = collect_rollup_candidates(
            &g.identities,
            &g.names,
            &g.aux,
            &g.currencies,
            &g.levels,
            &g.values,
            &g.excluded,
            fixed,
        );
        for c in candidates {
            let payload = serde_json::json!({"anchor":c.anchor,"start":c.members.start,"end":c.members.end,"same":c.same_code,"single":c.single_same_code});
            db.execute(
                "INSERT INTO candidates VALUES(?1,?2,?3)",
                params![
                    g.ids[0] as i64,
                    payload.to_string(),
                    c.same_code && c.members.len() >= 2
                ],
            )
            .map_err(sql)?;
        }
        Ok(())
    })?;
    let strong: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM candidates WHERE strong=1)",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    each_segment(
        db,
        compact,
        headers,
        column,
        basis,
        limit,
        cancel,
        |mut g| {
            let mut candidates = Vec::new();
            let mut query = db
                .prepare("SELECT payload FROM candidates WHERE segment=?1")
                .map_err(sql)?;
            for row in query
                .query_map([g.ids[0] as i64], |r| r.get::<_, String>(0))
                .map_err(sql)?
            {
                let value: Value = serde_json::from_str(&row.map_err(sql)?)
                    .map_err(|e| failure("TB 候选缓存损坏。", e))?;
                candidates.push(RollupCandidate {
                    anchor: value["anchor"].as_u64().unwrap() as usize,
                    members: (value["start"].as_u64().unwrap() as usize)
                        ..(value["end"].as_u64().unwrap() as usize),
                    same_code: value["same"].as_bool().unwrap(),
                    single_same_code: value["single"].as_bool().unwrap(),
                });
            }
            let mut parents = Vec::new();
            apply_rollup_candidates(
                &g.identities,
                &g.names,
                &g.aux,
                &mut g.excluded,
                candidates,
                strong,
                context.then_some(&mut parents),
            );
            save_mask(db, &g)?;
            for (c, p) in parents {
                db.execute(
                    "INSERT INTO parents VALUES(?1,?2)",
                    params![g.ids[c] as i64, g.ids[p] as i64],
                )
                .map_err(sql)?;
            }
            Ok(())
        },
    )
}
