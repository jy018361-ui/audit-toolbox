//! TB 的完整行重放入口：样例仅展示，末级、符号和金额检查使用完整数据。
use super::*;
use crate::disk_table::DiskTable;
use crate::ledger_mapping::{TbLeafAnalysis, disk_tb::DiskTbAnalysis};
impl RowRecord<'_> {
    pub(crate) fn values(&self) -> &[String] {
        self.row
    }
}

pub(crate) struct FxTbRows {
    pub(crate) table: Arc<FxTable>,
    pub(crate) disk: Option<DiskTable>,
    pub(crate) analysis: Option<DiskTbAnalysis>,
}
impl FxTbRows {
    pub(crate) fn open(
        source: &SourceSpec,
        mapping: &Map<String, Value>,
        collect_context: bool,
    ) -> Result<Self, AppError> {
        Self::open_forced(source, mapping, collect_context, false)
    }
    pub(crate) fn open_forced(
        source: &SourceSpec,
        mapping: &Map<String, Value>,
        collect_context: bool,
        force: bool,
    ) -> Result<Self, AppError> {
        Self::open_controlled(source, mapping, collect_context, force, &replay_cancel())
    }
    pub(crate) fn open_controlled(
        source: &SourceSpec,
        mapping: &Map<String, Value>,
        collect_context: bool,
        force: bool,
        active: &AtomicBool,
    ) -> Result<Self, AppError> {
        let path = Path::new(&source.input_path);
        if !force && !crate::disk_table::should_use_disk(&[path], 4) {
            return Ok(Self {
                table: load_fx_table(source)?,
                disk: None,
                analysis: None,
            });
        }
        let wanted = (!source.sheet.trim().is_empty()).then_some(source.sheet.as_str());
        let (mut selected, sheets, mut prefix) = crate::disk_table::preview_source(
            path,
            wanted,
            source.header_row.saturating_add(32).max(200),
        )?;
        if wanted.is_none() && sheets.len() > 1 {
            let entries = if path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("xlsx") || e.eq_ignore_ascii_case("xlsm"))
            {
                xlsx_sheet_entries(path).ok()
            } else {
                None
            };
            let mut best = None;
            for name in &sheets {
                let (_, _, rows) = crate::disk_table::preview_source(
                    path,
                    Some(name),
                    source.header_row.saturating_add(32).max(200),
                )?;
                let header = (0..rows.len().min(30))
                    .map(|i| ledger_mapping::header_row_score(&rows, i))
                    .fold(0.0_f64, f64::max);
                let declared = entries
                    .as_ref()
                    .and_then(|entries| entries.iter().find(|(n, _)| n == name))
                    .and_then(|(_, entry)| xlsx_sheet_prefix(path, entry, 256).ok())
                    .map(|xml| xlsx_dimension(&xml).0)
                    .unwrap_or(rows.len());
                let score = ledger_mapping::sheet_score(header, declared, name);
                if best.as_ref().is_none_or(|(s, _, _)| score > *s) {
                    best = Some((score, name.clone(), rows));
                }
            }
            if let Some((_, name, rows)) = best {
                selected = name;
                prefix = rows;
            }
        }
        let (auto_row, auto_depth) = infer_public_header_layout(&prefix);
        let header_row = if source.header_row > 0 {
            source.header_row
        } else {
            auto_row
        };
        let header_depth = if source.header_depth > 0 {
            source.header_depth.clamp(1, 2)
        } else if source.header_row > 0 {
            usize::from(
                prefix
                    .get(header_row - 1)
                    .zip(prefix.get(header_row))
                    .is_some_and(|(a, b)| is_two_level_header_pair(a, b)),
            ) + 1
        } else {
            auto_depth
        };
        let disk = DiskTable::open(
            path,
            Some(&selected),
            header_row,
            header_depth,
            &|_, _, _, _| {},
            &active,
        )?;
        let width = disk.headers.len();
        let raw_headers = prefix
            .iter()
            .skip(header_row.saturating_sub(1))
            .take(header_depth)
            .map(|row| pad(row, width))
            .collect();
        let rows = prefix
            .into_iter()
            .skip(header_row.saturating_sub(1) + header_depth)
            .take(200)
            .map(|row| pad(&row, width))
            .collect();
        let table = Arc::new(FxTable {
            path: path.into(),
            sheet: disk.sheet.clone(),
            sheets: disk.sheets.clone(),
            header_row: disk.header_row,
            header_depth: disk.header_depth,
            raw_headers,
            headers: disk
                .headers
                .iter()
                .map(|h| merge_consistent_header(h))
                .collect(),
            rows,
            row_count: disk.row_count,
            header_candidates: Vec::new(),
            sampled: true,
        });
        let analysis = ledger_mapping::disk_tb::analyze(
            &disk,
            &|role| mapped_cols(mapping, role),
            collect_context,
            &|_, _, _, _| {},
            &active,
        )?;
        Ok(Self {
            table,
            disk: Some(disk),
            analysis: Some(analysis),
        })
    }
    pub(crate) fn visit(
        &self,
        cancel: &AtomicBool,
        mut visitor: impl FnMut(RowRecord<'_>, usize) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let active = replay_cancel();
        let index = Rc::new(
            self.table
                .headers
                .iter()
                .enumerate()
                .map(|(i, h)| (h.as_str(), i))
                .collect::<HashMap<_, _>>(),
        );
        let mut logical = 0usize;
        let mut emit = |values: &[String], source_row: usize| {
            if active.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                return Err(error("JOB_CANCELLED", "任务已取消。", None));
            }
            visitor(
                RowRecord {
                    source_row,
                    header_index: Rc::clone(&index),
                    row: values,
                },
                logical,
            )?;
            logical += 1;
            Ok(())
        };
        if let Some(disk) = &self.disk {
            disk.visit(&active, |row, source_row| emit(row, source_row))
        } else {
            for (i, row) in self.table.rows.iter().enumerate() {
                emit(row, self.table.header_row + self.table.header_depth + i)?;
            }
            Ok(())
        }
    }
    pub(crate) fn leaf_analysis(&self, mapping: &Map<String, Value>) -> TbLeafAnalysis {
        if let Some(analysis) = &self.analysis {
            TbLeafAnalysis {
                keep: analysis.analysis.keep.clone(),
                contexts: analysis.analysis.contexts.clone(),
                parent_names: analysis.analysis.parent_names.clone(),
            }
        } else {
            ledger_mapping::tb_classification_analysis(
                &self.table.headers,
                &self.table.rows,
                &|role| mapped_cols(mapping, role),
            )
        }
    }
    pub(crate) fn visit_leaf(
        &self,
        mapping: &Map<String, Value>,
        cancel: &AtomicBool,
        mut visitor: impl FnMut(RowRecord<'_>, usize) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let mask;
        let keep = if let Some(analysis) = &self.analysis {
            &analysis.analysis.keep
        } else {
            mask = ledger_mapping::tb_leaf_mask(&self.table.headers, &self.table.rows, &|role| {
                mapped_cols(mapping, role)
            });
            &mask
        };
        self.visit(cancel, |row, i| {
            if keep.get(i).copied().unwrap_or(false) {
                visitor(row, i)?;
            }
            Ok(())
        })
    }
    pub(crate) fn ensure_convention(
        &self,
        mapping: &mut Map<String, Value>,
    ) -> Result<(), AppError> {
        if let Some(analysis) = &self.analysis {
            // TB 的旧入口对不能确定的符号票采取 Unsigned；明确选择始终优先。
            if !mapping.contains_key(SIGN_CONVENTION_KEY) {
                mapping.insert(
                    SIGN_CONVENTION_KEY.into(),
                    json!(
                        analysis
                            .sign_evidence
                            .convention
                            .unwrap_or(ledger_mapping::SignConvention::Unsigned)
                            .as_str()
                    ),
                );
            }
            for (prefix, signed) in &analysis.self_signed {
                mapping
                    .entry(balance_sign_key(prefix))
                    .or_insert(json!(signed));
            }
            Ok(())
        } else {
            ensure_sign_convention(&self.table, mapping, "tb")
                .map_err(|message| error("SIGN_CONVENTION_UNCERTAIN", message, None))
        }
    }
    pub(crate) fn validate_amounts(
        &self,
        mapping: &Map<String, Value>,
        label: &str,
        keep: Option<&[bool]>,
    ) -> Result<(), AppError> {
        if self.disk.is_none() {
            return validate_mapped_amount_values(&self.table, mapping, "tb", label, keep);
        }
        let positions = ledger_mapping::roles("tb")
            .iter()
            .filter(|role| {
                let lower = role.name.to_ascii_lowercase();
                lower.contains("amount") || lower.contains("debit") || lower.contains("credit")
            })
            .flat_map(|role| {
                mapped_cols(mapping, role.name)
                    .into_iter()
                    .filter_map(|column| {
                        ledger_mapping::header_index(&self.table.headers, &column)
                            .map(|index| (role.label, column, index))
                    })
            })
            .collect::<Vec<_>>();
        let keep = keep.or_else(|| {
            self.analysis
                .as_ref()
                .map(|analysis| analysis.analysis.keep.as_slice())
        });
        let mut first = None;
        let mut details = Vec::new();
        let mut count = 0usize;
        self.visit(&AtomicBool::new(false), |row, index| {
            if keep.is_some_and(|mask| !mask.get(index).copied().unwrap_or(false)) {
                return Ok(());
            }
            for (role, column, index) in &positions {
                let raw = row.row.get(*index).map(String::as_str).unwrap_or("");
                let trimmed = raw.trim();
                if trimmed.is_empty()
                    || matches!(trimmed, "-" | "—" | "–")
                    || ledger_mapping::parse_amount(raw).is_ok_and(|v| v.is_some())
                {
                    continue;
                }
                count += 1;
                if first.is_none() {
                    first = Some((column.clone(), row.source_row, raw.to_owned()));
                }
                if details.len() < 20 {
                    details.push(format!("{column}（{role}）第{}行=“{raw}”", row.source_row));
                }
            }
            Ok(())
        })?;
        if let Some((column, row, raw)) = first {
            let mut detail = details.join("；");
            if count > 20 {
                detail.push_str(&format!("；另有{}处未列出。", count - 20));
            }
            return Err(error(
                "AMOUNT_VALUE_INVALID",
                format!(
                    "{label}金额列「{column}」第{row}行的值“{}”无法解析为数值，请修正后重试。",
                    raw.chars().take(80).collect::<String>()
                ),
                Some(detail),
            ));
        }
        Ok(())
    }
}

impl FxTbRows {
    pub(crate) fn dimension_rows(
        &self,
        mapping: &Map<String, Value>,
        role: &str,
        column: Option<usize>,
    ) -> Result<Vec<ledger_mapping::TbDimensionRow>, AppError> {
        self.dimension_rows_controlled(mapping, role, column, &replay_cancel())
    }
    pub(crate) fn dimension_rows_controlled(
        &self,
        mapping: &Map<String, Value>,
        role: &str,
        column: Option<usize>,
        cancel: &AtomicBool,
    ) -> Result<Vec<ledger_mapping::TbDimensionRow>, AppError> {
        if cancel.load(Ordering::Relaxed) {
            return Err(error("JOB_CANCELLED", "任务已取消。", None));
        }
        if let Some(analysis) = &self.analysis {
            let mut output = Vec::new();
            analysis.visit_entity_groups(
                &self.table.headers,
                &|role| mapped_cols(mapping, role),
                cancel,
                |rows, ids, _, currency| {
                    for mut row in ledger_mapping::tb_dimension_rows_with_currency_mask(
                        &self.table.headers,
                        rows,
                        mapping,
                        role,
                        column,
                        &currency,
                    ) {
                        if let Some(id) = ids.get(row.index).filter(|id| **id > 0) {
                            row.index = *id - 1;
                            output.push(row);
                        }
                    }
                    Ok(())
                },
            )?;
            output.sort_by_key(|row| row.index);
            Ok(output)
        } else {
            Ok(ledger_mapping::tb_dimension_rows(
                &self.table.headers,
                &self.table.rows,
                mapping,
                role,
                column,
            ))
        }
    }
    pub(crate) fn catalog(&self, mapping: &Map<String, Value>) -> Result<Value, AppError> {
        let mut accounts = BTreeSet::new();
        let mut entities = BTreeSet::new();
        let mut currencies = BTreeSet::new();
        let mut combinations = BTreeSet::new();
        let mut years = BTreeSet::new();
        let mut tally = BTreeMap::new();
        let period = self
            .table
            .headers
            .iter()
            .enumerate()
            .filter(|(_, h)| normalize_header(h).contains("期间"))
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        self.visit(&replay_cancel(), |row, _| {
            let account = account_name(&row, mapping);
            let entity = cell(&row, mapping, "entity").trim();
            let currency = cell(&row, mapping, "currency").trim();
            if !entity.is_empty() {
                entities.insert(entity.to_owned());
            }
            if !currency.is_empty() {
                currencies.insert(currency.to_owned());
            }
            if !account.trim().is_empty() {
                if !is_summary_account(&account) {
                    accounts.insert(account.clone());
                }
                if !ledger_mapping::is_report_footer_value(&account) {
                    combinations.insert((
                        if entity.is_empty() {
                            DEFAULT_ENTITY.to_owned()
                        } else {
                            entity.to_owned()
                        },
                        account.clone(),
                    ));
                }
            }
            tally_account_currency(
                &mut tally,
                &account,
                currency,
                cell(&row, mapping, "functionalCurrency"),
            );
            for index in &period {
                if let Some(value) = row.row.get(*index) {
                    for token in value.split(|c: char| !c.is_ascii_digit()) {
                        if token.len() == 4 {
                            if let Ok(year) = token.parse::<i32>() {
                                if (1900..=2200).contains(&year) {
                                    years.insert(year);
                                }
                            }
                        }
                    }
                }
            }
            Ok(())
        })?;
        let mut leaves = BTreeSet::new();
        let mut review = Vec::new();
        let mut entity_currencies = BTreeMap::new();
        let mut collect =
            |rows: &[Vec<String>], analysis: TbLeafAnalysis, currency: Option<&[bool]>| {
                let mut table = (*self.table).clone();
                table.rows = rows.to_vec();
                table.row_count = rows.len();
                let analysis = ledger_mapping::tb_catalog_from_analysis(
                    &table.headers,
                    rows,
                    &|role| mapped_cols(mapping, role),
                    analysis,
                );
                for (row, keep) in records(&table).into_iter().zip(&analysis.keep) {
                    if *keep {
                        let account = account_name(&row, mapping);
                        if !account.trim().is_empty() && !is_summary_account(&account) {
                            leaves.insert(account);
                        }
                    }
                }
                review.extend(if let Some(currency) = currency {
                    crate::deposit_interest::distinct_review_accounts_with_global_currency(
                        &table,
                        mapping,
                        &analysis.keep,
                        &analysis.contexts,
                        &analysis.parent_names,
                        currency,
                    )
                } else {
                    crate::deposit_interest::distinct_review_accounts_with_mask(
                        &table,
                        mapping,
                        &analysis.keep,
                        &analysis.contexts,
                        &analysis.parent_names,
                    )
                });
                entity_currencies.extend(functional_currencies_by_entity(&table, mapping));
                for (entity, currency) in functional_currencies_from_amounts(&table, mapping) {
                    entity_currencies.entry(entity).or_insert(currency);
                }
                Ok(())
            };
        if let Some(analysis) = &self.analysis {
            analysis.visit_entity_groups(
                &self.table.headers,
                &|role| mapped_cols(mapping, role),
                &replay_cancel(),
                |rows, _, analysis, currency| collect(rows, analysis, Some(&currency)),
            )?;
        } else {
            collect(
                &self.table.rows,
                ledger_mapping::tb_classification_analysis(
                    &self.table.headers,
                    &self.table.rows,
                    &|role| mapped_cols(mapping, role),
                ),
                None,
            )?;
        }
        review.sort_by_key(|item| {
            ["entity", "account", "auxiliary", "currency"].map(|key| {
                item.get(key)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            })
        });
        let contexts = crate::deposit_interest::review_classification_texts(&review);
        let role_suggestions = accounts
            .iter()
            .map(|account| {
                (
                    account.clone(),
                    confirmation_account_role(contexts.get(account).unwrap_or(account)),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let role_details=accounts.iter().map(|account|{let suggestion=suggest_account_role_detail(contexts.get(account).unwrap_or(account));(account.clone(),json!({"role":confirmation_role(suggestion),"confidence":suggestion.confidence,"needsConfirmation":suggestion.needs_confirmation,"reason":suggestion.reason,"subtype":suggestion.subtype}))}).collect::<BTreeMap<_,_>>();
        Ok(
            json!({"rowCount":self.table.row_count,"accounts":accounts,"accountsLeaf":leaves,"entities":entities,"entityAccounts":combinations.into_iter().map(|(entity,account)|json!({"entity":entity,"account":account})).collect::<Vec<_>>(),"currencies":currencies,"accountCurrencyDetails":finish_account_currency_tally(tally),"dataYears":years,"reviewAccounts":review,"accountRoleSuggestions":role_suggestions,"accountRoleDetails":role_details,"entityCurrencies":entity_currencies,"metadataComplete":true,"sampledPreview":false}),
        )
    }
}

impl std::ops::Deref for FxTbRows {
    type Target = FxTable;
    fn deref(&self) -> &FxTable {
        &self.table
    }
}

impl FxTbRows {
    pub(crate) fn catalog_leaf_analysis(
        &self,
        mapping: &Map<String, Value>,
    ) -> Result<TbLeafAnalysis, AppError> {
        if let Some(analysis) = &self.analysis {
            let mut result = self.leaf_analysis(mapping);
            analysis.visit_entity_groups(
                &self.headers,
                &|r| mapped_cols(mapping, r),
                &replay_cancel(),
                |rows, ids, analysis, _| {
                    let group = ledger_mapping::tb_catalog_from_analysis(
                        &self.headers,
                        rows,
                        &|r| mapped_cols(mapping, r),
                        analysis,
                    );
                    for (i, id) in ids.iter().copied().enumerate() {
                        if id > 0 {
                            result.keep[id - 1] = group.keep[i];
                        }
                    }
                    Ok(())
                },
            )?;
            Ok(result)
        } else {
            Ok(ledger_mapping::tb_catalog_classification_analysis(
                &self.headers,
                &self.rows,
                &|r| mapped_cols(mapping, r),
            ))
        }
    }
    /// Complete per-column value domains for key reconciliation. This table has no
    /// row relationship and must never be used for amounts or hierarchy analysis.
    pub(crate) fn complete_domains(&self) -> Result<FxTable, AppError> {
        let mut sets = vec![BTreeSet::new(); self.headers.len()];
        let mut bytes = 0usize;
        let limit =
            (crate::resource_budget::budget()?.worker_bytes / 5).min(128 * 1024 * 1024) as usize;
        self.visit(&replay_cancel(), |r, _| {
            for (i, value) in r.row.iter().enumerate().take(sets.len()) {
                if !value.trim().is_empty() && sets[i].insert(value.clone()) {
                    bytes = bytes.saturating_add(value.len() + 96);
                    if bytes > limit {
                        return Err(error(
                            "TABLE_DOMAIN_BUDGET",
                            "账表匹配键的完整值域超过安全预算，请拆分独立账套后重试。",
                            None,
                        ));
                    }
                }
            }
            Ok(())
        })?;
        let width = sets.len();
        let len = sets.iter().map(BTreeSet::len).max().unwrap_or(0);
        if len.saturating_mul(width).saturating_mul(32) > limit {
            return Err(error(
                "TABLE_DOMAIN_BUDGET",
                "账表匹配键的完整值域超过安全预算，请拆分独立账套后重试。",
                None,
            ));
        }
        let mut rows = vec![vec![String::new(); width]; len];
        for (i, set) in sets.into_iter().enumerate() {
            for (j, value) in set.into_iter().enumerate() {
                rows[j][i] = value;
            }
        }
        let mut table = (*self.table).clone();
        table.rows = rows;
        table.row_count = len;
        table.sampled = false;
        Ok(table)
    }
}
