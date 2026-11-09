//! 完整余额表双遍扫描的本期发生额提升，常驻内存不随正文行数增长。
use super::*;
impl tb_replay::FxTbRows {
    pub(crate) fn promote_period_movement(
        &self,
        mapping: &mut Map<String, Value>,
    ) -> Result<bool, AppError> {
        self.promote_period_movement_controlled(mapping, &replay_cancel())
    }
    pub(crate) fn promote_period_movement_controlled(
        &self,
        mapping: &mut Map<String, Value>,
        cancel: &AtomicBool,
    ) -> Result<bool, AppError> {
        if self.disk.is_none() {
            return Ok(promote_period_movement_rows(
                &self.headers,
                &self.rows,
                mapping,
            ));
        }
        let headers = &self.headers;
        let analysis = self.analysis.as_ref().ok_or_else(|| {
            error(
                "TB_DISK_ANALYSIS_MISSING",
                "余额表完整分析不可用，请重新读取。",
                None,
            )
        })?;
        if first_col(mapping, "ytdFunctionalDebit").is_some()
            || first_col(mapping, "ytdFunctionalCredit").is_some()
        {
            return Ok(false);
        }
        let (Some(debit_column), Some(credit_column)) = (
            first_col(mapping, "periodFunctionalDebit"),
            first_col(mapping, "periodFunctionalCredit"),
        ) else {
            return Ok(false);
        };
        if !amount_scheme_ok(mapping, "openingFunctional")
            || !amount_scheme_ok(mapping, "closingFunctional")
        {
            return Ok(false);
        }

        let column_of = |role: &str| mapped_cols(mapping, role);
        let index_of = |role: &str| {
            column_of(role)
                .into_iter()
                .find_map(|name| ledger_mapping::header_index(headers, &name))
        };
        let (Some(debit_index), Some(credit_index)) = (
            ledger_mapping::header_index(headers, &debit_column),
            ledger_mapping::header_index(headers, &credit_column),
        ) else {
            return Ok(false);
        };
        let opening_self_signed = analysis
            .self_signed
            .get("openingFunctional")
            .copied()
            .unwrap_or(false);
        let closing_self_signed = analysis
            .self_signed
            .get("closingFunctional")
            .copied()
            .unwrap_or(false);
        let balance_at = |row: &[String], prefix: &str, self_signed: bool| -> Result<f64, String> {
            if let (Some(debit), Some(credit)) = (
                index_of(&format!("{prefix}Debit")),
                index_of(&format!("{prefix}Credit")),
            ) {
                let debit =
                    ledger_mapping::parse_amount(row.get(debit).map(String::as_str).unwrap_or(""))?
                        .unwrap_or(0.0);
                let credit = ledger_mapping::parse_amount(
                    row.get(credit).map(String::as_str).unwrap_or(""),
                )?
                .unwrap_or(0.0);
                return Ok(debit - credit);
            }
            let Some(amount) = index_of(&format!("{prefix}Amount")) else {
                return Err("余额列未映射".into());
            };
            let amount =
                ledger_mapping::parse_amount(row.get(amount).map(String::as_str).unwrap_or(""))?
                    .unwrap_or(0.0);
            let base = prefix
                .strip_suffix("Functional")
                .or_else(|| prefix.strip_suffix("Foreign"))
                .unwrap_or(prefix);
            let direction = index_of(&format!("{base}Direction"))
                .or_else(|| index_of("direction"))
                .and_then(|index| row.get(index))
                .map(String::as_str)
                .unwrap_or("");
            if self_signed || direction.trim().is_empty() {
                Ok(amount)
            } else if ledger_mapping::is_credit_direction(direction) {
                Ok(-amount)
            } else {
                Ok(amount)
            }
        };
        let junk = analysis.junk_mask()?;
        // 只有一侧有方向列时，另一侧的净额可能需要逐行借方向。不要把
        // 期末方向整列复制给期初：科目余额可以在期间内从借方转到贷方。
        let opening_direction = index_of("openingDirection").or_else(|| index_of("direction"));
        let closing_direction = index_of("closingDirection").or_else(|| index_of("direction"));
        let missing_direction_side = match (opening_direction, closing_direction) {
            (None, Some(anchor))
                if !opening_self_signed && index_of("openingFunctionalAmount").is_some() =>
            {
                Some((true, anchor))
            }
            (Some(anchor), None)
                if !closing_self_signed && index_of("closingFunctionalAmount").is_some() =>
            {
                Some((false, anchor))
            }
            _ => None,
        };
        let candidate = |row: &[String], index: usize| {
            if !junk.get(index).copied().unwrap_or(true) {
                return None;
            }
            let (Ok(opening), Ok(closing), Ok(debit), Ok(credit)) = (
                balance_at(row, "openingFunctional", opening_self_signed),
                balance_at(row, "closingFunctional", closing_self_signed),
                ledger_mapping::parse_amount(
                    row.get(debit_index).map(String::as_str).unwrap_or(""),
                ),
                ledger_mapping::parse_amount(
                    row.get(credit_index).map(String::as_str).unwrap_or(""),
                ),
            ) else {
                return None;
            };
            // 借贷分列的空格表示该侧零发生额。剔除整行会把正常的单边发生额
            // 排除在勾稽样本之外，使少数真实差异被错误放大到 5% 门槛以上。
            let (debit, credit) = (debit.unwrap_or(0.0), credit.unwrap_or(0.0));
            if credit.abs() <= f64::EPSILON {
                return None;
            }
            // 先按原有取数投票确定整表贷方符号；推断只用于随后验证缺方向的
            // 余额符号，不参与逐行挑选借加贷或借减贷。
            let raw_missing_side = missing_direction_side.and_then(|(is_opening, anchor)| {
                let direction = row.get(anchor)?.trim();
                let known = ledger_mapping::is_credit_direction(direction)
                    || direction.contains('借')
                    || direction.eq_ignore_ascii_case("debit")
                    || matches!(
                        direction.to_ascii_lowercase().as_str(),
                        "d" | "dr" | "s" | "j" | "+"
                    );
                known.then_some((if is_opening { opening } else { closing }, is_opening))
            });
            Some((
                ledger_mapping::BalanceRow {
                    opening,
                    closing,
                    debit,
                    credit,
                },
                raw_missing_side,
            ))
        };
        let (mut signed, mut unsigned, mut positive, mut negative, mut eligible) =
            (0usize, 0usize, 0usize, 0usize, 0usize);
        self.visit(cancel, |row, index| {
            if let Some((balance, _)) = candidate(row.values(), index) {
                eligible += 1;
                let evidence = ledger_mapping::tb_sign_evidence(std::slice::from_ref(&balance));
                signed += evidence.signed_votes;
                unsigned += evidence.unsigned_votes;
                positive += usize::from(balance.credit > 0.0);
                negative += usize::from(balance.credit < 0.0);
            }
            Ok(())
        })?;
        // 同一张表只采用一种符号口径，复用公共 TB 勾稽投票；禁止逐行挑公式。
        // 投票只决定符号，是否可提升仍须满足下方严格的有效行数和成立率。
        let convention = if signed == 0 && unsigned == 0 {
            if positive > negative {
                Some(ledger_mapping::SignConvention::Unsigned)
            } else if negative > positive {
                Some(ledger_mapping::SignConvention::Signed)
            } else {
                None
            }
        } else if signed > unsigned {
            Some(ledger_mapping::SignConvention::Signed)
        } else if unsigned > signed {
            Some(ledger_mapping::SignConvention::Unsigned)
        } else {
            None
        };
        let Some(convention) = convention else {
            return Ok(false);
        };
        let mut passed = 0usize;
        self.visit(cancel, |record, index| {
            if let Some((row, raw_missing_side)) = candidate(record.values(), index) {
                let mut row = row;
                if let Some((raw, is_opening)) = raw_missing_side {
                    // 公共数学按「借减贷」求缺失余额；带符号贷方口径先归一，
                    // 推断值还须与原始净额的绝对值吻合，真差异不能被猜平。
                    let normalized_credit = -convention.credit_sign() * row.credit;
                    let anchor = if is_opening { row.closing } else { row.opening };
                    if let Some(inferred) = ledger_mapping::balance_sign_from_equation(
                        raw,
                        anchor,
                        Some((row.debit, normalized_credit)),
                        is_opening,
                    ) {
                        if is_opening {
                            row.opening = inferred;
                        } else {
                            row.closing = inferred;
                        }
                    }
                }
                let derived = row.opening + row.debit + convention.credit_sign() * row.credit;
                let difference = derived - row.closing;
                let scale = row
                    .opening
                    .abs()
                    .max(row.closing.abs())
                    .max(row.debit.abs())
                    .max(row.credit.abs())
                    .max(derived.abs());
                let tolerance = 0.01_f64.max(scale * 1e-8);
                passed += usize::from(difference.abs() <= tolerance);
            }
            Ok(())
        })?;
        let accepted = match eligible {
            0..=2 => false,
            3..=9 => passed == eligible,
            _ => passed * 100 >= eligible * 95,
        };
        if !accepted {
            return Ok(false);
        }
        mapping.insert("ytdFunctionalDebit".into(), Value::String(debit_column));
        mapping.insert("ytdFunctionalCredit".into(), Value::String(credit_column));
        mapping.remove("periodFunctionalDebit");
        mapping.remove("periodFunctionalCredit");
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_tb_period_promotion_matches_full_votes_threshold_and_missing_direction() {
        for signed in [false, true] {
            for invalid in [0usize, 1, 12, 13] {
                for direction in [false, true] {
                    let dir =
                        std::env::temp_dir().join(format!("tb-promotion-{}", uuid::Uuid::new_v4()));
                    std::fs::create_dir_all(&dir).unwrap();
                    let path = dir.join("tb.csv");
                    let mut data = String::from("编码,名称,期初,借方,贷方,期末,期末方向\n");
                    for i in 0..240 {
                        let credit = if signed { -10 } else { 10 };
                        // 末尾差异发生在预览之外；验证不得用前200条的100%结果替代全局95%门槛。
                        let closing = if i >= 240 - invalid {
                            if signed { 999 } else { 999 }
                        } else {
                            90
                        };
                        data.push_str(&format!("X{i:04},项目{i},100,,{credit},{closing},借\n"));
                    }
                    std::fs::write(&path, data).unwrap();
                    let source = SourceSpec {
                        input_path: path.to_string_lossy().into(),
                        sheet: String::new(),
                        header_row: 1,
                        header_depth: 1,
                    };
                    let mut mapping=json!({"accountCode":"编码","accountName":"名称","openingFunctionalAmount":"期初","periodFunctionalDebit":"借方","periodFunctionalCredit":"贷方","closingFunctionalAmount":"期末"}).as_object().unwrap().clone();
                    if direction {
                        mapping.insert("closingDirection".into(), json!("期末方向"));
                    }
                    let memory = load_fx_table(&source).unwrap();
                    let mut expected = mapping.clone();
                    let accepted =
                        promote_period_movement_rows(&memory.headers, &memory.rows, &mut expected);
                    let disk =
                        tb_replay::FxTbRows::open_forced(&source, &mapping, false, true).unwrap();
                    let actual = disk.promote_period_movement(&mut mapping).unwrap();
                    assert_eq!(
                        actual, accepted,
                        "signed={signed} invalid={invalid} direction={direction}"
                    );
                    assert_eq!(mapping, expected);
                    let _ = std::fs::remove_dir_all(dir);
                }
            }
        }
    }
}
