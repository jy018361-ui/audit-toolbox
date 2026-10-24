//! 自动建议的公共收口；人工确认映射必须在调用后覆盖，辅助建议仍须跨表验证。
use super::*;
use serde_json::{Map, json};

pub(crate) type MappingCandidate = (String, f64, Vec<String>, Vec<String>);

/// 成组的 Entered/Accounted 是明确币种口径，不能被宽泛别名反向覆盖。
pub(crate) fn entered_accounted_tb_columns(headers: &[String]) -> Vec<(usize, &'static str)> {
    let find = |name: &str| {
        headers
            .iter()
            .position(|h| normalize_header(h) == normalize_header(name))
    };
    let balances = [
        ("openingForeignAmount", "Begin Balance (Entered)"),
        ("openingFunctionalAmount", "Begin Balance (Accounted)"),
        ("closingForeignAmount", "End Balance (Entered)"),
        ("closingFunctionalAmount", "End Balance (Accounted)"),
    ];
    if balances.iter().any(|(_, name)| find(name).is_none()) {
        return Vec::new();
    }
    balances
        .into_iter()
        .chain([
            ("entity", "Company"),
            ("accountCode", "Code Combination"),
            ("accountName", "Account Description"),
            ("currency", "Currency Code"),
            ("periodForeignDebit", "Period Net (Entered Dr)"),
            ("periodForeignCredit", "Period Net (Entered Cr)"),
            ("periodFunctionalDebit", "Period Net (Accounted Dr)"),
            ("periodFunctionalCredit", "Period Net (Accounted Cr)"),
        ])
        .filter_map(|(role, name)| find(name).map(|index| (index, role)))
        .collect()
}

pub(crate) fn complete_entered_accounted_tb_mapping(
    headers: &[String],
    rows: &[Vec<String>],
    mapping: &mut Map<String, Value>,
) {
    let columns = entered_accounted_tb_columns(headers);
    if columns.is_empty() {
        return;
    }
    let occupied: HashSet<&str> = columns
        .iter()
        .map(|(index, _)| headers[*index].as_str())
        .collect();
    // 删除旧的错误占位，包含数组的每一列；随后才写入成组结论。
    mapping.retain(|role, value| {
        if SHARED_COLUMN_ROLES.contains(&role.as_str()) {
            true
        } else {
            match value {
                Value::String(column) => !occupied.contains(column.as_str()),
                Value::Array(all) => {
                    all.retain(|column| !column.as_str().is_some_and(|c| occupied.contains(c)));
                    !all.is_empty()
                }
                _ => true,
            }
        }
    });
    for (index, role) in columns {
        if !rows.is_empty()
            && !rows
                .iter()
                .any(|row| row.get(index).is_some_and(|s| !s.trim().is_empty()))
        {
            continue;
        }
        let value = if role_of("tb", role).is_some_and(|r| r.multi) {
            json!([headers[index]])
        } else {
            json!(headers[index])
        };
        mapping.insert(role.into(), value);
    }
}

/// 全部冲突先移除再补选；数组的第二、第三列也属于已占用列。
pub(crate) fn resolve_mapping_column_conflicts(
    kind: &str,
    candidates: &BTreeMap<String, Vec<MappingCandidate>>,
    mapping: &mut Map<String, Value>,
) {
    let mut picks = Vec::new();
    for role in mapping.keys() {
        for column in mapped_column_names(mapping, role) {
            let score = candidates
                .get(role)
                .and_then(|all| all.iter().find(|c| c.0 == column))
                .map_or(0.0, |c| c.1);
            picks.push((role.clone(), column, score));
        }
    }
    let mut emptied = BTreeSet::new();
    for (role, column) in conflicting_roles(kind, &picks) {
        let empty = match mapping.get_mut(&role) {
            Some(Value::Array(all)) => {
                all.retain(|c| c.as_str() != Some(&column));
                all.is_empty()
            }
            _ => true,
        };
        if empty {
            mapping.remove(&role);
            emptied.insert(role);
        }
    }
    // 以候选置信度决定补选次序，同分按角色名，避免依赖 HashMap 顺序。
    let mut fallback = Vec::new();
    for role in emptied {
        if let Some(all) = candidates.get(&role) {
            for (rank, candidate) in all.iter().enumerate().filter(|(_, c)| c.1 >= 0.55) {
                fallback.push((role.clone(), rank, candidate));
            }
        }
    }
    fallback.sort_by(|a, b| {
        b.2.1
            .total_cmp(&a.2.1)
            .then(a.0.cmp(&b.0))
            .then(a.1.cmp(&b.1))
    });
    let mut used: HashSet<String> = mapping
        .keys()
        .filter(|r| !SHARED_COLUMN_ROLES.contains(&r.as_str()))
        .flat_map(|r| mapped_column_names(mapping, r))
        .collect();
    for (role, _, candidate) in fallback {
        if mapping.contains_key(&role) || used.contains(&candidate.0) {
            continue;
        }
        used.insert(candidate.0.clone());
        mapping.insert(
            role.clone(),
            if role_of(kind, &role).is_some_and(|r| r.multi) {
                json!([candidate.0])
            } else {
                json!(candidate.0)
            },
        );
    }
}

/// 银行账户／财务项目等歧义标题只提出有取值证据的候选，不等于辅助验证成功。
pub(crate) fn auxiliary_dimension_candidates(
    kind: &str,
    headers: &[String],
    rows: &[Vec<String>],
    assigned: &BTreeMap<usize, &'static str>,
) -> Vec<usize> {
    if !matches!(kind, "tb" | "je")
        || rows.is_empty()
        || !assigned
            .values()
            .any(|r| matches!(*r, "accountCode" | "accountName"))
    {
        return Vec::new();
    }
    headers
        .iter()
        .enumerate()
        .filter_map(|(index, header)| {
            if assigned
                .get(&index)
                .is_some_and(|role| !SHARED_COLUMN_ROLES.contains(role))
            {
                return None;
            }
            let normalized = normalize_header(header);
            let textual = matches!(normalized.as_str(), "文本" | "科目文本" | "账户文本");
            if !matches!(normalized.as_str(), "账户" | "财务项目") && !(kind == "tb" && textual)
            {
                return None;
            }
            if role_rejects_header(kind, "auxiliary", header) {
                return None;
            }
            let values: Vec<&str> = rows
                .iter()
                .filter_map(|r| r.get(index))
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .collect();
            if values.is_empty() {
                return None;
            }
            let valid = values
                .iter()
                .filter(|v| {
                    // 非金额的可辨文本，或长整数银行账号；日期、金额和方向不作维度证据。
                    let long_code = v.len() >= 8 && v.chars().all(|c| c.is_ascii_digit());
                    long_code
                        || (parse_amount(v).ok().flatten().is_none()
                            && v.chars().any(char::is_alphabetic)
                            && !matches!(**v, "借" | "贷" | "平" | "DR" | "CR")
                            && !v.chars().all(|c| c.is_ascii_digit() || "-/.: ".contains(c)))
                })
                .count();
            if valid * 4 < values.len() * 3 {
                return None;
            }
            // 裸“文本”须有独立科目名称，且不只是复写名称；同科目多维度也是证据。
            if textual {
                let identity = assigned
                    .iter()
                    .find_map(|(i, r)| (*r == "accountCode").then_some(*i))?;
                let mut dimensions: HashMap<&str, HashSet<&str>> = HashMap::new();
                for row in rows {
                    if let (Some(account), Some(value)) = (row.get(identity), row.get(index)) {
                        if !account.trim().is_empty() && !value.trim().is_empty() {
                            dimensions
                                .entry(account.trim())
                                .or_default()
                                .insert(value.trim());
                        }
                    }
                }
                let name_columns: Vec<_> = assigned
                    .iter()
                    .filter_map(|(i, r)| (*r == "accountName").then_some(*i))
                    .collect();
                let independent = !name_columns.is_empty()
                    && rows.iter().any(|row| {
                        row.get(index).is_some_and(|value| {
                            !value.trim().is_empty()
                                && name_columns.iter().all(|i| {
                                    row.get(*i).is_none_or(|name| name.trim() != value.trim())
                                })
                        })
                    });
                if !independent && !dimensions.values().any(|all| all.len() > 1) {
                    return None;
                }
            }
            Some(index)
        })
        .collect()
}
