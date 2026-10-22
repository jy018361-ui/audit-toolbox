//! 按完整结构选取金额层；不搜索能凑成父金额的任意局部区间。
use super::*;

fn tolerance(a: f64, b: f64) -> bool {
    a.is_finite() && b.is_finite() && (a - b).abs() <= 0.0100001
}

pub(super) fn analyze(
    headers: &[String],
    rows: &[Vec<String>],
    column: &dyn Fn(&str) -> Vec<String>,
    values: &[Vec<f64>],
    excluded: &mut [bool],
) -> Vec<(usize, usize)> {
    let n = rows.len();
    if n == 0 || values.len() < 2 {
        return vec![];
    }
    let idx = |role: &str| {
        column(role)
            .iter()
            .filter_map(|h| header_index(headers, h))
            .collect::<Vec<_>>()
    };
    let mut ac = idx("accountCode");
    if ac.is_empty() {
        ac = idx("account");
        ac.truncate(1);
    }
    let en = idx("entity");
    let na = idx("accountName");
    let cu = idx("currency");
    let ai = tb_rollup_auxiliary_indexes(headers, column);
    let join = |r: &[String], ii: &[usize]| {
        ii.iter()
            .filter_map(|i| r.get(*i))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\u{1f}")
            .to_uppercase()
    };
    let entities = rows.iter().map(|r| join(r, &en)).collect::<Vec<_>>();
    let names = rows.iter().map(|r| join(r, &na)).collect::<Vec<_>>();
    let mut currency = rows
        .iter()
        .map(|r| {
            let raw = join(r, &cu);
            normalize_currency_code(&raw)
                .map(str::to_owned)
                .unwrap_or(raw)
        })
        .collect::<Vec<_>>();
    let auxiliary = rows
        .iter()
        .map(|r| tb_rollup_auxiliary_key(r, &ai))
        .collect::<Vec<_>>();
    let level = headers.iter().position(|h| {
        matches!(
            normalize_header(h).as_str(),
            "级次" | "科目级次" | "层级" | "科目层级" | "级别" | "科目级别"
        )
    });
    let mut codes = rows
        .iter()
        .map(|r| account_code_of(&join(r, &ac)))
        .collect::<Vec<_>>();
    // 部分 ERP 把科目级别/汇总编码放在另一列，明细编码仅在末级填写。
    let alternative = headers
        .iter()
        .enumerate()
        .filter_map(|(i, h)| {
            matches!(
                normalize_header(h).as_str(),
                "科目级别" | "科目编码" | "科目代码"
            )
            .then_some(i)
        })
        .collect::<Vec<_>>();
    for (i, r) in rows.iter().enumerate() {
        if codes[i].is_empty() {
            for j in &alternative {
                let raw = r.get(*j).map(String::as_str).unwrap_or("");
                let c = account_code_of(raw);
                if looks_like_account_code(&c) {
                    codes[i] = c;
                    break;
                }
            }
        }
    }
    let own_code = codes.iter().map(|c| !c.is_empty()).collect::<Vec<_>>();
    // 只有带具体辅助的无编码续行可继承；空行/页脚不跨越继承。
    let mut previous = None;
    for i in 0..n {
        if rows[i].iter().all(|s| s.trim().is_empty()) {
            previous = None;
            continue;
        }
        if !codes[i].is_empty() {
            previous = Some(i);
        } else if !auxiliary[i].is_empty()
            && let Some(p) = previous
        {
            if entities[i] == entities[p] {
                codes[i] = codes[p].clone();
            }
        }
    }
    let amount_idx = TB_AMOUNT_ROLES
        .iter()
        .filter(|r| r.contains("Functional"))
        .flat_map(|r| idx(r))
        .collect::<BTreeSet<_>>();
    let valid = (0..n)
        .map(|i| {
            amount_idx
                .iter()
                .all(|j| rows[i].get(*j).is_none_or(|s| parse_amount(s).is_ok()))
        })
        .collect::<Vec<_>>();
    let has_value = (0..n)
        .map(|i| {
            amount_idx.iter().any(|j| {
                rows[i]
                    .get(*j)
                    .is_some_and(|s| parse_amount(s).ok().flatten().is_some())
            })
        })
        .collect::<Vec<_>>();
    let foreign_idx = TB_AMOUNT_ROLES
        .iter()
        .filter(|r| r.contains("Foreign"))
        .flat_map(|r| idx(r))
        .collect::<BTreeSet<_>>();
    for i in 0..n {
        if currency[i].is_empty() {
            let explicit = foreign_idx
                .iter()
                .filter_map(|j| rows[i].get(*j))
                .filter_map(|s| {
                    let s = s.trim();
                    (s.len() > 3 && s.is_char_boundary(3))
                        .then(|| normalize_currency_code(&s[..3]))
                        .flatten()
                })
                .collect::<BTreeSet<_>>();
            if explicit.len() == 1 {
                currency[i] = explicit.first().unwrap().to_string();
            }
        }
    }
    let foreign_rows = if foreign_idx.is_empty() {
        vec![]
    } else {
        rows.iter()
            .map(|r| {
                let mut r = r.clone();
                for i in &foreign_idx {
                    if let Some(s) = r.get_mut(*i) {
                        let raw = s.trim();
                        if raw.len() > 3
                            && raw.is_char_boundary(3)
                            && normalize_currency_code(&raw[..3]).is_some()
                        {
                            *s = raw[3..].trim().to_owned();
                        }
                    }
                }
                r
            })
            .collect::<Vec<_>>()
    };
    let foreign_columns = |role: &str| column(&role.replace("Functional", "Foreign"));
    let foreign = if foreign_idx.is_empty() {
        vec![]
    } else {
        rollup_value_columns(headers, &foreign_rows, &foreign_columns)
    };
    let foreign_valid = (0..n)
        .map(|i| {
            foreign_idx.iter().all(|j| {
                foreign_rows
                    .get(i)
                    .and_then(|r| r.get(*j))
                    .is_none_or(|s| parse_amount(s).is_ok())
            })
        })
        .collect::<Vec<_>>();
    let foreign_available = (0..n)
        .map(|i| {
            foreign_idx.iter().any(|j| {
                foreign_rows
                    .get(i)
                    .and_then(|r| r.get(*j))
                    .is_some_and(|s| parse_amount(s).ok().flatten().is_some())
            })
        })
        .collect::<Vec<_>>();
    let matches = |p: usize, ch: &[usize]| {
        !ch.is_empty()
            && valid[p]
            && has_value[p]
            && ch.iter().all(|i| valid[*i])
            && values
                .iter()
                .all(|v| tolerance(v[p], ch.iter().map(|i| v[*i]).sum()))
            && (foreign.is_empty()
                || !foreign_available[p]
                || currency[p].is_empty()
                || ch.iter().any(|i| currency[*i] != currency[p])
                || (foreign_valid[p]
                    && ch.iter().all(|i| foreign_valid[*i])
                    && foreign
                        .iter()
                        .all(|v| tolerance(v[p], ch.iter().map(|i| v[*i]).sum()))))
    };
    // 先利用完整跨组织总项佐证同组织的空辅助重复列示，避免这些重复代表
    // 阻断后续上级科目树；同额二行本身仍不足以触发剔除。
    let mut proof = CrossEntityRollups::new(headers, column);
    proof.collect(headers, rows, column, values, excluded, None);
    proof.observe(headers, rows, column, values, excluded, None);
    for i in proof.blank_pair_exclusions() {
        excluded[i] = true;
    }
    // 图只保存直接子层；显式级次/缩进优先于编码推导，辅助分层先于跨科目层。
    let mut graph = BTreeMap::<usize, Vec<usize>>::new();
    let mut bycode = BTreeMap::<(String, String, String), Vec<usize>>::new();
    for i in 0..n {
        // 已剔除的小计不能再次成为同编码代表，否则会挡住组首汇总的编码树。
        if !codes[i].is_empty() && !excluded[i] {
            bycode
                .entry((entities[i].clone(), codes[i].clone(), currency[i].clone()))
                .or_default()
                .push(i);
        }
    }
    let lengths = codes
        .iter()
        .filter(|s| !s.is_empty())
        .map(String::len)
        .collect::<BTreeSet<_>>();
    let fixed = lengths.len() == 1;
    let mut pair_candidates = Vec::new();
    let mut templates = BTreeSet::new();
    for ((entity, _, cur), group) in &bycode {
        if group.len() < 2 {
            continue;
        }
        if group
            .iter()
            .any(|i| excluded[*i] && is_rollup_label(&names[*i]))
        {
            continue;
        }
        let mut candidates = Vec::new();
        for p in group {
            // 同编码的任意内部非零切片不能成为锚点；仅接受完整组边界或显式小计。
            if Some(p) != group.first() && Some(p) != group.last() && !is_rollup_label(&names[*p]) {
                continue;
            }
            let ch = group.iter().copied().filter(|i| i != p).collect::<Vec<_>>();
            let meaningful = ch
                .iter()
                .any(|i| values.iter().any(|v| v[*i].abs() > 0.005));
            // 完整组允许一条未分配到具体辅助对象的残余明细；至少另一条须实际细化。
            let dims = ch.iter().all(|i| {
                auxiliary[*p] == auxiliary[*i]
                    || auxiliary_parent_of(&auxiliary[*p], &auxiliary[*i])
            }) && ch
                .iter()
                .any(|i| auxiliary_parent_of(&auxiliary[*p], &auxiliary[*i]));
            let name_group = ai.is_empty() && ch.iter().any(|i| names[*i] != names[*p]);
            if meaningful && (dims || name_group) && matches(*p, &ch) {
                candidates.push((*p, ch));
            }
        }
        // 数值相等的多个候选即使位于不同边界也不任意择一。
        if candidates.len() != 1 {
            continue;
        }
        let (p, ch) = candidates.pop().unwrap();
        if ch.len() >= 2 || is_rollup_label(&names[p]) {
            templates.insert((entity.clone(), cur.clone()));
            graph.insert(p, ch);
        } else {
            pair_candidates.push((entity.clone(), cur.clone(), p, ch));
        }
    }
    // 一对一关系不自证格式，仅复用同主体、同币种已有完整多明细组的结构证据。
    let mut requires_cover = BTreeSet::new();
    for (e, c, p, ch) in pair_candidates {
        if templates.contains(&(e, c)) {
            graph.insert(p, ch);
        } else {
            // 先作为候选参与更短编码的完整上层验证；没有上层佐证则不采纳。
            requires_cover.insert(p);
            graph.insert(p, ch);
        }
    }
    for ((e, _, c), group) in &bycode {
        if group.len() == 2
            && ai.is_empty()
            && templates.contains(&(e.clone(), c.clone()))
            && names[group[0]] != names[group[1]]
            && matches(group[0], &group[1..])
        {
            graph.insert(group[0], group[1..].to_vec());
        }
    }
    // 完整组中唯一的空辅助层可作为范围候选；是否采用仍交由全部金额验证。
    for group in bycode.values() {
        let roots = group
            .iter()
            .copied()
            .filter(|i| auxiliary[*i].is_empty())
            .collect::<Vec<_>>();
        if roots.len() == 1 && group.len() >= 3 {
            let p = roots[0];
            let ch = group
                .iter()
                .copied()
                .filter(|i| *i != p)
                .collect::<Vec<_>>();
            if ch
                .iter()
                .all(|i| auxiliary_parent_of(&auxiliary[p], &auxiliary[*i]))
            {
                graph.entry(p).or_insert(ch);
            }
        }
    }
    let mut account_groups = BTreeMap::<(String, String), Vec<usize>>::new();
    for ((e, c, _), g) in &bycode {
        account_groups
            .entry((e.clone(), c.clone()))
            .or_default()
            .extend(g);
    }
    for g in account_groups.values() {
        let roots = g
            .iter()
            .copied()
            .filter(|i| currency[*i].is_empty() && auxiliary[*i].is_empty())
            .collect::<Vec<_>>();
        if roots.len() == 1 && g.len() >= 3 {
            let p = roots[0];
            let ch = g.iter().copied().filter(|i| *i != p).collect::<Vec<_>>();
            if ch
                .iter()
                .all(|i| auxiliary_parent_of(&auxiliary[p], &auxiliary[*i]))
            {
                graph.entry(p).or_insert(ch);
            }
        }
    }

    let explicit_levels = rows
        .iter()
        .map(|r| {
            level
                .and_then(|j| r.get(j))
                .and_then(|s| s.trim().parse::<u32>().ok())
        })
        .collect::<Vec<_>>();
    let indent_index = na
        .iter()
        .copied()
        .chain(ai.iter().copied().filter(|i| headers[*i].contains("名称")))
        .chain(headers.iter().enumerate().filter_map(|(i, h)| {
            (normalize_header(h).contains("辅助名称") || normalize_header(h) == "核算项目名称")
                .then_some(i)
        }))
        .max_by_key(|j| {
            rows.iter()
                .filter(|r| {
                    r.get(*j)
                        .is_some_and(|s| s.starts_with(' ') || s.starts_with('\u{3000}'))
                })
                .count()
        });
    let mut indents = rows
        .iter()
        .map(|r| {
            indent_index
                .and_then(|j| r.get(j))
                .map(|s| {
                    s.chars()
                        .take_while(|c| c.is_whitespace())
                        .map(|c| if c == '\u{3000}' { 2 } else { 1 })
                        .sum::<u32>()
                })
                .unwrap_or(0)
        })
        .collect::<Vec<_>>();
    // 数值型辅助名称在Excel中丢失空格，完整复合编码仍能还原其相对层级。
    let base_indents = codes
        .iter()
        .zip(&indents)
        .filter(|(c, _)| !c.contains('-'))
        .map(|(c, d)| (c.clone(), *d))
        .collect::<BTreeMap<_, _>>();
    for i in 0..n {
        if indents[i] == 0
            && let Some((base, _)) = codes[i].split_once('-')
            && let Some(depth) = base_indents.get(base)
        {
            indents[i] = depth + 2 * codes[i].matches('-').count() as u32;
        }
    }
    let indent_levels = indents.iter().copied().collect::<BTreeSet<_>>();
    let use_indent = indent_levels.len() > 1 && indents.iter().filter(|i| **i > 0).count() > 1;
    let mut stack = Vec::<usize>::new();
    let mut levels_graph = BTreeMap::<usize, Vec<usize>>::new();
    let auxiliary_children = graph.values().flatten().copied().collect::<BTreeSet<_>>();
    for i in 0..n {
        // 主体切换即终止物理连续范围，即使切换行恰好是辅助明细也一样。
        if i > 0 && entities[i] != entities[i - 1] {
            stack.clear();
        }
        // 名称列混写的部门/客商不应重开科目缩进栈，避免挂错后续兄弟科目。
        if auxiliary_children.contains(&i) || (!own_code[i] && !auxiliary[i].is_empty()) {
            continue;
        }
        if codes[i].is_empty() || rows[i].is_empty() {
            stack.clear();
            continue;
        }
        let li = explicit_levels[i].or_else(|| use_indent.then_some(indents[i]));
        let Some(li) = li else {
            continue;
        };
        while let Some(p) = stack.last().copied() {
            let lp = explicit_levels[p]
                .or_else(|| use_indent.then_some(indents[p]))
                .unwrap_or(0);
            let incompatible_composite = codes[i].contains('-')
                && (codes[p].contains('-') || codes[p].len() <= 15)
                && !is_ancestor_code(&codes[p], &codes[i]);
            if entities[p] != entities[i] || lp >= li || incompatible_composite {
                stack.pop();
            } else {
                break;
            }
        }
        if let Some(p) = stack.last().copied() {
            levels_graph.entry(p).or_default().push(i);
        }
        stack.push(i);
    }
    // 级别列可能是“科目编码”而非数字深度，只有有限的小整数才作深度。
    let actual_levels = explicit_levels.iter().flatten().all(|v| *v <= 64);
    if actual_levels || level.is_none() {
        for (p, ch) in levels_graph {
            graph.insert(p, ch);
        }
    }

    // 非连续编码层：先选每个编码现有的汇总代表，避免重复加中间汇总和辅助行。
    let mut code_rows = BTreeMap::<(String, String), Vec<usize>>::new();
    let same_code_children = graph
        .iter()
        .flat_map(|(p, ch)| {
            ch.iter()
                .copied()
                .filter(|c| codes[*p] == codes[*c] && entities[*p] == entities[*c])
        })
        .collect::<BTreeSet<_>>();
    for ((e, c, _), group) in &bycode {
        code_rows.entry((e.clone(), c.clone())).or_default().extend(
            group
                .iter()
                .copied()
                .filter(|i| !same_code_children.contains(i)),
        );
    }
    let mut code_children = BTreeMap::<(String, String), Vec<String>>::new();
    for (entity, code) in code_rows.keys() {
        for (cut, _) in code.char_indices().rev().filter(|(i, _)| *i > 0) {
            let parent = &code[..cut];
            if parent.len() > 15 && parent.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if code_rows.contains_key(&(entity.clone(), parent.to_owned()))
                && is_ancestor_code(parent, code)
            {
                code_children
                    .entry((entity.clone(), parent.to_owned()))
                    .or_default()
                    .push(code.clone());
                break;
            }
        }
    }
    for ((e, c), child_codes) in code_children {
        let ps = &code_rows[&(e.clone(), c)];
        let ch = child_codes
            .iter()
            .flat_map(|c| {
                code_rows
                    .get(&(e.clone(), c.clone()))
                    .into_iter()
                    .flatten()
                    .copied()
            })
            .collect::<Vec<_>>();
        for p in ps {
            if graph.contains_key(p) {
                continue;
            }
            let relevant = ch
                .iter()
                .copied()
                .filter(|i| ps.len() == 1 || currency[*p] == currency[*i])
                .collect::<Vec<_>>();
            if !relevant.is_empty() {
                graph.insert(*p, relevant);
            }
        }
    }
    // 无编码明细无法独立形成跨表匹配键，完整金额成立时取有编码的覆盖层。
    for p in 0..n {
        if codes[p].is_empty() {
            continue;
        }
        let mut ch = Vec::new();
        for i in p + 1..n {
            if entities[i] != entities[p]
                || !codes[i].is_empty()
                || rows[i].iter().all(|s| s.trim().is_empty())
            {
                break;
            }
            if !names[i].is_empty() {
                ch.push(i);
            }
        }
        if matches(p, &ch) {
            for i in ch {
                excluded[i] = true;
            }
        }
    }
    if fixed {
        for i in 0..n {
            if codes[i].is_empty() {
                excluded[i] = true;
            }
        }
    }
    // 有明确下级的全零父行不承载金额，保留原有目录/计算口径。
    for p in graph.keys() {
        if valid[*p] && has_value[*p] && values.iter().all(|v| v[*p].abs() <= 0.005) {
            excluded[*p] = true;
        }
    }
    let raw_verified = graph
        .iter()
        .filter_map(|(p, ch)| matches(*p, ch).then_some(*p))
        .collect::<BTreeSet<_>>();
    let mut verified = raw_verified
        .difference(&requires_cover)
        .copied()
        .collect::<BTreeSet<_>>();
    loop {
        let before = verified.len();
        let children = verified
            .iter()
            .flat_map(|p| graph[p].iter().copied())
            .collect::<Vec<_>>();
        for child in children {
            if raw_verified.contains(&child) {
                verified.insert(child);
            }
        }
        if before == verified.len() {
            break;
        }
    }
    // 仅完整金额成立的关系向下展开。已验证上层下面的残缺分支使用该分支汇总。
    let mut semantic = Vec::new();
    let mut claimed = BTreeMap::<usize, BTreeSet<usize>>::new();
    for p in &verified {
        for c in &graph[p] {
            claimed.entry(*c).or_default().insert(*p);
        }
    }
    let ambiguous = claimed
        .iter()
        .filter_map(|(c, ps)| (ps.len() > 1).then_some(*c))
        .collect::<BTreeSet<_>>();
    let accepted = verified
        .into_iter()
        .filter(|p| !graph[p].iter().any(|c| ambiguous.contains(c)))
        .collect::<BTreeSet<_>>();
    for p in &accepted {
        if graph[&p].iter().any(|c| ambiguous.contains(c)) {
            continue;
        }
        excluded[*p] = true;
        for c in &graph[&p] {
            semantic.push((*c, *p));
        }
    }
    // 上层已经完整验证时，下一层若无法继续完整展开，用其汇总覆盖残缺子层。
    // 无已验证覆盖层的失败组仍原样保留，不能凭猜测删记录。
    let mut covered = BTreeSet::new();
    for p in &accepted {
        covered.extend(graph[p].iter().copied());
    }
    for node in covered {
        if accepted.contains(&node) || !graph.contains_key(&node) {
            continue;
        }
        let mut pending = graph[&node].clone();
        let mut seen = BTreeSet::from([node]);
        while let Some(child) = pending.pop() {
            if !seen.insert(child) {
                continue;
            }
            if !ambiguous.contains(&child) {
                excluded[child] = true;
                if let Some(ch) = graph.get(&child) {
                    pending.extend(ch);
                }
            }
        }
        excluded[node] = false;
    }
    let mut cross = CrossEntityRollups::new(headers, column);
    cross.collect(headers, rows, column, values, excluded, None);
    cross.observe(headers, rows, column, values, excluded, None);
    for i in cross.exclusions() {
        excluded[i] = true;
    }
    semantic
}

/// 跨组织总项必须由全体具体组织的已选金额层证明；不把空组织单独当作删除依据。
#[derive(Default)]
pub(super) struct CrossEntityRollups {
    enabled: bool,
    targets: BTreeMap<(String, String), Vec<(usize, Vec<f64>)>>,
    totals: BTreeMap<(String, String), (Vec<f64>, BTreeSet<String>)>,
    foreign_targets: BTreeMap<usize, Vec<f64>>,
    foreign_totals: BTreeMap<(String, String), (Vec<f64>, bool)>,
    root_totals: BTreeMap<(String, String), (Vec<f64>, BTreeSet<String>)>,
    root_foreign_totals: BTreeMap<(String, String), (Vec<f64>, bool)>,
    roots_seen: BTreeSet<(String, String, String, String)>,
    blank_pairs: BTreeMap<(String, String), Vec<usize>>,
}
impl CrossEntityRollups {
    pub(super) fn new(_headers: &[String], column: &dyn Fn(&str) -> Vec<String>) -> Self {
        Self {
            enabled: !column("entity").is_empty(),
            ..Self::default()
        }
    }
    fn identity(
        headers: &[String],
        row: &[String],
        column: &dyn Fn(&str) -> Vec<String>,
        role: &str,
    ) -> String {
        column(role)
            .iter()
            .filter_map(|h| header_index(headers, h))
            .filter_map(|j| row.get(j))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\u{1f}")
            .to_uppercase()
    }
    fn foreign(
        headers: &[String],
        rows: &[Vec<String>],
        column: &dyn Fn(&str) -> Vec<String>,
    ) -> (Vec<Vec<f64>>, Vec<bool>, Vec<bool>) {
        let indexes = TB_AMOUNT_ROLES
            .iter()
            .filter(|r| r.contains("Functional"))
            .flat_map(|r| column(&r.replace("Functional", "Foreign")))
            .filter_map(|h| header_index(headers, &h))
            .collect::<BTreeSet<_>>();
        if indexes.is_empty() {
            return (vec![], vec![false; rows.len()], vec![true; rows.len()]);
        }
        let mut clean = rows.to_vec();
        for r in &mut clean {
            for j in &indexes {
                if let Some(s) = r.get_mut(*j) {
                    let raw = s.trim();
                    if raw.len() > 3
                        && raw.is_char_boundary(3)
                        && normalize_currency_code(&raw[..3]).is_some()
                    {
                        *s = raw[3..].trim().to_owned();
                    }
                }
            }
        }
        let available = clean
            .iter()
            .map(|r| {
                indexes.iter().any(|j| {
                    r.get(*j)
                        .is_some_and(|s| parse_amount(s).ok().flatten().is_some())
                })
            })
            .collect();
        let valid = clean
            .iter()
            .map(|r| {
                indexes
                    .iter()
                    .all(|j| r.get(*j).is_none_or(|s| parse_amount(s).is_ok()))
            })
            .collect();
        (
            rollup_value_columns(headers, &clean, &|role| {
                column(&role.replace("Functional", "Foreign"))
            }),
            available,
            valid,
        )
    }
    fn functional_available(
        headers: &[String],
        row: &[String],
        column: &dyn Fn(&str) -> Vec<String>,
    ) -> Vec<bool> {
        let indexes = |role: &str| column(role).iter().find_map(|h| header_index(headers, h));
        let mut out = Vec::new();
        for p in [
            "openingFunctional",
            "closingFunctional",
            "ytdFunctional",
            "periodFunctional",
        ] {
            let ii = ["Debit", "Credit", "Amount"].map(|side| indexes(&format!("{p}{side}")));
            if ii.iter().all(Option::is_none) {
                continue;
            }
            let present = ii.iter().flatten().any(|j| {
                row.get(*j)
                    .is_some_and(|s| parse_amount(s).ok().flatten().is_some())
            });
            out.push(present);
            if p.starts_with("ytd") || p.starts_with("period") {
                out.push(present);
            }
        }
        out
    }
    pub(super) fn collect(
        &mut self,
        headers: &[String],
        rows: &[Vec<String>],
        column: &dyn Fn(&str) -> Vec<String>,
        values: &[Vec<f64>],
        excluded: &[bool],
        ids: Option<&[usize]>,
    ) {
        if !self.enabled {
            return;
        }
        if !rows
            .iter()
            .any(|r| Self::identity(headers, r, column, "entity").is_empty())
        {
            return;
        }
        let ai = tb_rollup_auxiliary_indexes(headers, column);
        let (foreign, available, valid) = Self::foreign(headers, rows, column);
        for (i, r) in rows.iter().enumerate() {
            if excluded[i]
                || !Self::identity(headers, r, column, "entity").is_empty()
                || !tb_rollup_auxiliary_key(r, &ai).is_empty()
            {
                continue;
            }
            let code = account_code_of(&Self::identity(headers, r, column, "accountCode"));
            if code.is_empty() {
                continue;
            }
            let cur = Self::identity(headers, r, column, "currency");
            let cur = normalize_currency_code(&cur).unwrap_or(&cur).to_owned();
            let id = ids.map_or(i, |ids| ids[i]);
            if !cur.is_empty() && available[i] {
                self.foreign_targets.insert(
                    id,
                    foreign
                        .iter()
                        .map(|v| if valid[i] { v[i] } else { f64::NAN })
                        .collect(),
                );
            }
            let availability = Self::functional_available(headers, r, column);
            let expected = values
                .iter()
                .enumerate()
                .map(|(j, v)| {
                    if availability.get(j) == Some(&true) {
                        v[i]
                    } else {
                        f64::NAN
                    }
                })
                .collect();
            self.targets
                .entry((code, cur))
                .or_default()
                .push((id, expected));
        }
    }
    pub(super) fn observe(
        &mut self,
        headers: &[String],
        rows: &[Vec<String>],
        column: &dyn Fn(&str) -> Vec<String>,
        values: &[Vec<f64>],
        excluded: &[bool],
        ids: Option<&[usize]>,
    ) {
        if self.targets.is_empty() {
            return;
        }
        let (foreign, _, valid) = Self::foreign(headers, rows, column);
        let ai = tb_rollup_auxiliary_indexes(headers, column);
        let mut groups = BTreeMap::<(String, String, String), Vec<usize>>::new();
        for (i, r) in rows.iter().enumerate() {
            let e = Self::identity(headers, r, column, "entity");
            if e.is_empty() {
                continue;
            }
            let code = account_code_of(&Self::identity(headers, r, column, "accountCode"));
            let cur = Self::identity(headers, r, column, "currency");
            let cur = normalize_currency_code(&cur).unwrap_or(&cur).to_owned();
            groups.entry((code, cur, e)).or_default().push(i);
        }
        for ((code, cur, _), g) in groups {
            if g.len() != 2
                || g[1] != g[0] + 1
                || g.iter().any(|i| {
                    excluded[*i]
                        || !tb_rollup_auxiliary_key(&rows[*i], &ai).is_empty()
                        || !valid[*i]
                })
            {
                continue;
            }
            if values
                .iter()
                .chain(foreign.iter())
                .all(|v| tolerance(v[g[0]], v[g[1]]))
            {
                self.blank_pairs
                    .entry((code, cur))
                    .or_default()
                    .push(ids.map_or(g[0], |ids| ids[g[0]]));
            }
        }
        for (i, r) in rows.iter().enumerate() {
            let entity = Self::identity(headers, r, column, "entity");
            if entity.is_empty() {
                continue;
            }
            let code = account_code_of(&Self::identity(headers, r, column, "accountCode"));
            let cur = Self::identity(headers, r, column, "currency");
            let cur = normalize_currency_code(&cur).unwrap_or(&cur).to_owned();
            // 原始组织总项可能已被更高科目覆盖；仍可作为跨组织关系的直接子项证据。
            if tb_rollup_auxiliary_key(r, &ai).is_empty() {
                for c in [cur.as_str(), ""].into_iter().collect::<BTreeSet<_>>() {
                    let key = (code.clone(), c.to_owned());
                    if self.targets.contains_key(&key)
                        && self.roots_seen.insert((
                            code.clone(),
                            c.to_owned(),
                            cur.clone(),
                            entity.clone(),
                        ))
                    {
                        let (sums, entities) = self
                            .root_totals
                            .entry(key.clone())
                            .or_insert_with(|| (vec![0.; values.len()], BTreeSet::new()));
                        entities.insert(entity.clone());
                        for (j, v) in values.iter().enumerate() {
                            sums[j] += v[i];
                        }
                        let (fsums, all_valid) = self
                            .root_foreign_totals
                            .entry(key)
                            .or_insert_with(|| (vec![0.; foreign.len()], true));
                        *all_valid &= valid[i];
                        for (j, v) in foreign.iter().enumerate() {
                            fsums[j] += v[i];
                        }
                    }
                }
            }
            if excluded[i] {
                continue;
            }
            for cut in code
                .char_indices()
                .map(|(j, _)| j)
                .chain(std::iter::once(code.len()))
                .filter(|j| *j > 0)
            {
                let p = &code[..cut];
                if p != code
                    && (!is_ancestor_code(p, &code)
                        || (p.len() > 15 && p.chars().all(|c| c.is_ascii_digit())))
                {
                    continue;
                }
                for c in [cur.as_str(), ""].into_iter().collect::<BTreeSet<_>>() {
                    let key = (p.to_owned(), c.to_owned());
                    if !self.targets.contains_key(&key) {
                        continue;
                    }
                    let (sums, entities) = self
                        .totals
                        .entry(key.clone())
                        .or_insert_with(|| (vec![0.; values.len()], BTreeSet::new()));
                    entities.insert(entity.clone());
                    for (j, v) in values.iter().enumerate() {
                        sums[j] += v[i];
                    }
                    let (fsums, all_valid) = self
                        .foreign_totals
                        .entry(key)
                        .or_insert_with(|| (vec![0.; foreign.len()], true));
                    *all_valid &= valid[i];
                    for (j, v) in foreign.iter().enumerate() {
                        fsums[j] += v[i];
                    }
                }
            }
        }
    }
    pub(super) fn exclusions(&self) -> Vec<usize> {
        #[cfg(test)]
        if let Ok(code) = std::env::var("TB_STRUCTURE_DEBUG_CROSS") {
            for (key, ps) in self.targets.iter().filter(|(k, _)| k.0 == code) {
                eprintln!(
                    "跨组织诊断 {key:?} 候选{ps:?} 本币{:?} 原币目标{:?} 原币合计{:?}",
                    self.totals.get(key),
                    ps.iter()
                        .map(|(id, _)| self.foreign_targets.get(id))
                        .collect::<Vec<_>>(),
                    self.foreign_totals.get(key)
                );
            }
        }
        let matched = self
            .targets
            .iter()
            .filter_map(|(key, ps)| {
                let compatible =
                    |(sums, entities): &(Vec<f64>, BTreeSet<String>),
                     foreign: Option<&(Vec<f64>, bool)>| {
                        if ps.len() != 1
                            || sums.is_empty()
                            || !(ps[0].1.iter().any(|v| v.is_finite() && v.abs() > 0.005)
                                || self.foreign_targets.get(&ps[0].0).is_some_and(|v| {
                                    v.iter().any(|v| v.is_finite() && v.abs() > 0.005)
                                }))
                            || !ps[0]
                                .1
                                .iter()
                                .zip(sums)
                                .all(|(p, s)| p.is_nan() || tolerance(*p, *s))
                        {
                            return None;
                        }
                        if let Some(expected) = self.foreign_targets.get(&ps[0].0) {
                            let (observed, valid) = foreign?;
                            if !valid
                                || expected.len() != observed.len()
                                || !expected
                                    .iter()
                                    .zip(observed)
                                    .all(|(p, s)| tolerance(*p, *s))
                            {
                                return None;
                            }
                        }
                        Some(entities.len())
                    };
                let root_entities = self
                    .root_totals
                    .get(key)
                    .and_then(|v| compatible(v, self.root_foreign_totals.get(key)));
                let entities = self
                    .totals
                    .get(key)
                    .and_then(|v| compatible(v, self.foreign_totals.get(key)))
                    .or(root_entities)?;
                Some((key.clone(), ps[0].0, entities, root_entities.is_some()))
            })
            .collect::<Vec<_>>();
        let template = matched.iter().any(|(_, _, n, _)| *n >= 2);
        let mut result = Vec::new();
        for (key, i, n, root_proven) in matched {
            if n >= 2 || (n == 1 && template) {
                result.push(i);
                // 同额二行不自证汇总：只有跨组织原始块首总项的完整金额已通过，才采用此格式证据。
                if root_proven && let Some(pairs) = self.blank_pairs.get(&key) {
                    result.extend(pairs);
                }
            }
        }
        result
    }
    pub(super) fn has_targets(&self) -> bool {
        !self.targets.is_empty()
    }
    pub(super) fn blank_pair_exclusions(&self) -> Vec<usize> {
        let globals = self
            .targets
            .values()
            .flatten()
            .map(|(id, _)| *id)
            .collect::<BTreeSet<_>>();
        self.exclusions()
            .into_iter()
            .filter(|id| !globals.contains(id))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(
        lines: &[&[&str]],
    ) -> (
        Vec<String>,
        Vec<Vec<String>>,
        serde_json::Map<String, Value>,
    ) {
        let h = [
            "科目编码",
            "科目名称",
            "辅助",
            "币种",
            "期初",
            "借方",
            "贷方",
            "期末",
        ]
        .map(str::to_owned)
        .to_vec();
        let r = lines
            .iter()
            .map(|r| r.iter().map(|s| s.to_string()).collect())
            .collect();
        let m=serde_json::json!({"accountCode":"科目编码","accountName":"科目名称","auxiliary":"辅助","currency":"币种",
            "openingFunctionalAmount":"期初","ytdFunctionalDebit":"借方","ytdFunctionalCredit":"贷方","closingFunctionalAmount":"期末"}).as_object().unwrap().clone();
        (h, r, m)
    }
    #[test]
    fn one_detail_pair_requires_verified_upper_code_cover() {
        let (h, r, m) = fixture(&[
            &["1002", "银行存款", "", "HKD", "30", "100", "10", "120"],
            &["100201", "活期", "", "HKD", "20", "60", "5", "75"],
            &["10020101", "具体科目", "", "HKD", "20", "60", "5", "75"],
            &[
                "10020101",
                "具体科目",
                "账户甲",
                "HKD",
                "20",
                "60",
                "5",
                "75",
            ],
            &["100202", "其他", "", "HKD", "10", "40", "5", "45"],
            &["100202", "其他", "账户乙", "HKD", "10", "40", "5", "45"],
        ]);
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, false, false, true, false, true]
        );
        assert_eq!(
            tb_leaf_mask(&h, &r[2..4], &|role| mapped_column_names(&m, role)),
            vec![true, true]
        );
    }
    #[test]
    fn inherited_auxiliary_rows_do_not_break_upper_account_tree() {
        let (h, r, m) = fixture(&[
            &["1221", "其他应收款", "", "CNY", "30", "100", "10", "120"],
            &["1221.02", "个人", "", "CNY", "10", "40", "5", "45"],
            &["", "", "甲", "CNY", "10", "40", "5", "45"],
            &["1221.03", "单位", "", "CNY", "20", "60", "5", "75"],
            &["", "", "乙", "CNY", "20", "60", "5", "75"],
        ]);
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true, false, true, false]
        );
    }
    #[test]
    fn three_fixes_unmapped_explicit_auxiliary_columns_preserve_account_tree_without_confirming_je_mapping() {
        let (mut h, r, mut m) = fixture(&[
            &["1221", "其他应收款", "", "CNY", "30", "100", "10", "120"],
            &["1221.02", "个人", "", "CNY", "10", "40", "5", "45"],
            &["", "", "    甲", "CNY", "10", "40", "5", "45"],
            &["1221.03", "单位", "", "CNY", "20", "60", "5", "75"],
            &["", "", "    乙", "CNY", "20", "60", "5", "75"],
        ]);
        h[2] = "核算维度名称".into();
        m.remove("auxiliary");
        let keep = tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role));
        assert!(!keep[0], "完整父子应只保留一个金额层：{keep:?}");
        assert!(mapped_column_names(&m, "auxiliary").is_empty(), "结构证据不得确认跨表辅助映射");
        for j in 4..8 {
            let selected: f64 = r.iter().zip(&keep).filter(|(_,k)| **k).map(|(r,_)| parse_amount(&r[j]).unwrap().unwrap_or(0.0)).sum();
            assert!((selected - parse_amount(&r[0][j]).unwrap().unwrap()).abs() < 0.01, "金额列 {j} 不守恒");
        }
        let mut broken = r.clone();
        broken[0][5] = "101".into();
        assert!(tb_leaf_mask(&h, &broken, &|role| mapped_column_names(&m, role))[0], "不勾稽不能认定父子并删除父项");
    }
    #[test]
    fn complete_auxiliary_group_can_include_unallocated_residual() {
        let (h, r, m) = fixture(&[
            &["1002", "银行", "", "CNY", "30", "100", "10", "120"],
            &["1002", "银行", "", "CNY", "10", "40", "5", "45"],
            &["1002", "银行", "银行甲", "CNY", "20", "60", "5", "75"],
        ]);
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true, true]
        );
        let mut mismatch = r.clone();
        mismatch[2][5] = "59".into();
        assert_eq!(
            tb_leaf_mask(&h, &mismatch, &|role| mapped_column_names(&m, role)),
            vec![true, true, true]
        );
        let mut peers = r.clone();
        peers[2][2].clear();
        assert_eq!(
            tb_leaf_mask(&h, &peers, &|role| mapped_column_names(&m, role)),
            vec![true, true, true]
        );
    }
    #[test]
    fn chinese_auxiliary_suffix_requires_independent_auxiliary_evidence() {
        let (h, r, m) = fixture(&[
            &["2241002", "个人", "", "CNY", "-200", "500", "400", "-100"],
            &[
                "2241002-吴子鉴",
                "吴子鉴",
                "吴子鉴",
                "CNY",
                "-200",
                "500",
                "400",
                "-100",
            ],
        ]);
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true]
        );
        assert!(ledger_validation_mask(&h, &r, &|role| mapped_column_names(&m, role))[1]);
        let mut wrong = r.clone();
        wrong[1][2] = "另一人".into();
        assert!(!ledger_junk_mask(&h, &wrong, &|role| mapped_column_names(&m, role))[1]);
    }
    #[test]
    fn single_credit_balance_columns_participate_in_full_group_validation() {
        let (h, r, mut m) = fixture(&[
            &["2001", "短期借款", "", "CNY", "300", "0", "100", "400"],
            &["2001", "银行甲", "", "CNY", "100", "0", "0", "100"],
            &["2001", "银行乙", "", "CNY", "200", "0", "100", "300"],
        ]);
        m.remove("auxiliary");
        m.remove("openingFunctionalAmount");
        m.remove("closingFunctionalAmount");
        m.insert("openingFunctionalCredit".into(), serde_json::json!("期初"));
        m.insert("closingFunctionalCredit".into(), serde_json::json!("期末"));
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true, true]
        );
    }
    #[test]
    fn long_composite_codes_are_body_and_segment_peers_are_not_parents() {
        assert!(looks_like_account_code("1122001001-N00100-010000300259"));
        assert!(!is_ancestor_code(
            "5101001001001-21-713-3",
            "5101001001001-21-713-31"
        ));
        assert!(is_ancestor_code("1221001007", "1221001007-N00483"));
    }
    #[test]
    fn complete_group_not_local_sum_and_counterexample_does_not_veto_other_group() {
        let (h, r, m) = fixture(&[
            &["1002", "银行", "", "CNY", "0", "100", "0", "100"],
            &["1002", "银行", "甲", "CNY", "0", "40", "0", "40"],
            &["1002", "银行", "乙", "CNY", "0", "60", "0", "60"],
            &[
                "5500010104",
                "费用",
                "部门甲",
                "CNY",
                "0",
                "15510",
                "0",
                "15510",
            ],
            &[
                "5500010104",
                "费用",
                "部门乙",
                "CNY",
                "0",
                "19800",
                "0",
                "19800",
            ],
            &[
                "5500010104",
                "费用",
                "部门丙",
                "CNY",
                "0",
                "35310",
                "0",
                "35310",
            ],
        ]);
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true, true, true, true, true]
        );
    }
    #[test]
    fn verified_upper_layer_uses_summary_for_incomplete_lower_branch() {
        let (h, r, m) = fixture(&[
            &["1002", "银行", "", "CNY", "0", "100", "0", "100"],
            &["100201", "人民币", "", "CNY", "0", "60", "0", "60"],
            &["10020101", "账户甲", "", "CNY", "0", "10", "0", "10"],
            &["10020102", "账户乙", "", "CNY", "0", "20", "0", "20"],
            &["100202", "美元", "", "USD", "0", "40", "0", "40"],
        ]);
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true, false, false, true]
        );
    }
    #[test]
    fn trailing_subtotal_must_not_hide_duplicate_opening_summary() {
        let (h, r, m) = fixture(&[
            &["1101", "交易性金融资产", "", "CNY", "40", "30", "57", "13"],
            &["1101.01", "结构性存款", "", "CNY", "40", "30", "57", "13"],
            &[
                "1101",
                "交易性金融资产-小计",
                "",
                "CNY",
                "40",
                "30",
                "57",
                "13",
            ],
        ]);
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true, false]
        );
    }
    #[test]
    fn cross_organization_total_uses_complete_selected_layer() {
        let (mut h, mut r, mut m) = fixture(&[
            &["1002", "银行", "", "CNY", "30", "100", "10", "120"],
            &["1002", "银行", "银行甲", "CNY", "10", "40", "5", "45"],
            &["1002", "银行", "银行乙", "CNY", "20", "60", "5", "75"],
        ]);
        h.push("主体".into());
        m.insert("entity".into(), serde_json::json!("主体"));
        for (row, e) in r.iter_mut().zip(["", "甲公司", "乙公司"]) {
            row.push(e.into());
        }
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true, true]
        );
        r[2][5] = "59".into();
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![true, true, true]
        );
    }
    #[test]
    fn numeric_auxiliary_name_preserves_complete_composite_hierarchy() {
        let (h, r, m) = fixture(&[
            &["5101", "费用", "", "CNY", "0", "100", "0", "100"],
            &["5101001", "  管理费", "", "CNY", "0", "100", "0", "100"],
            &[
                "5101001-21",
                "    部门",
                "21",
                "CNY",
                "0",
                "100",
                "0",
                "100",
            ],
            &["5101001-21-1", "1", "21-1", "CNY", "0", "100", "0", "100"],
        ]);
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, false, false, true]
        );
    }
    #[test]
    fn cross_organization_foreign_counterexample_prevents_exclusion() {
        let (mut h, mut r, mut m) = fixture(&[
            &["1002", "银行", "", "USD", "30", "100", "10", "120"],
            &["1002", "银行", "甲行", "USD", "10", "40", "5", "45"],
            &["1002", "银行", "乙行", "USD", "20", "60", "5", "75"],
        ]);
        h.extend(["主体".into(), "原币借方".into()]);
        m.insert("entity".into(), serde_json::json!("主体"));
        m.insert("ytdForeignDebit".into(), serde_json::json!("原币借方"));
        for (row, (e, v)) in r
            .iter_mut()
            .zip([("", "10"), ("甲公司", "4"), ("乙公司", "7")])
        {
            row.extend([e.into(), v.into()]);
        }
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![true, true, true]
        );
        r[2][9] = "6".into();
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true, true]
        );
    }
    #[test]
    fn same_currency_organization_total_can_supply_only_original_amounts() {
        let (mut h, mut r, mut m) = fixture(&[
            &["1002", "银行", "", "USD", "", "", "", ""],
            &["1002", "银行", "甲行", "USD", "10", "40", "5", "45"],
            &["1002", "银行", "乙行", "USD", "20", "60", "5", "75"],
        ]);
        h.extend(["主体".into(), "原币借方".into()]);
        m.insert("entity".into(), serde_json::json!("主体"));
        m.insert("ytdForeignDebit".into(), serde_json::json!("原币借方"));
        for (row, (e, v)) in r
            .iter_mut()
            .zip([("", "10"), ("甲公司", "4"), ("乙公司", "6")])
        {
            row.extend([e.into(), v.into()]);
        }
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true, true]
        );
        r[0][9] = "11".into();
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![true, true, true]
        );
    }
    #[test]
    fn organization_total_remains_verifiable_when_one_branch_uses_upper_cover() {
        let (mut h, mut r, mut m) = fixture(&[
            &[
                "10020101",
                "全体组织账户甲",
                "",
                "CNY",
                "0",
                "30",
                "0",
                "30",
            ],
            &["1002", "银行", "", "CNY", "0", "100", "0", "100"],
            &["100201", "人民币", "", "CNY", "0", "60", "0", "60"],
            &["10020101", "账户甲", "", "CNY", "0", "10", "0", "10"],
            &["10020102", "账户乙", "", "CNY", "0", "20", "0", "20"],
            &["100202", "其他户", "", "CNY", "0", "40", "0", "40"],
            &["10020101", "账户甲", "", "CNY", "0", "20", "0", "20"],
        ]);
        h.push("主体".into());
        m.insert("entity".into(), serde_json::json!("主体"));
        for (row, e) in r.iter_mut().zip([
            "",
            "甲公司",
            "甲公司",
            "甲公司",
            "甲公司",
            "甲公司",
            "乙公司",
        ]) {
            row.push(e.into());
        }
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, false, true, false, false, true, true]
        );
    }
    #[test]
    fn identical_blank_auxiliary_pair_needs_complete_organization_total_proof() {
        let (mut h, mut r, mut m) = fixture(&[
            &["4002", "资本公积", "", "CNY", "0", "40", "0", "40"],
            &["4002", "资本公积", "", "CNY", "0", "20", "0", "20"],
            &["4002", "资本公积", "", "CNY", "0", "20", "0", "20"],
            &["4002", "资本公积", "", "CNY", "0", "20", "0", "20"],
        ]);
        h.push("主体".into());
        m.insert("entity".into(), serde_json::json!("主体"));
        for (row, e) in r.iter_mut().zip(["", "甲公司", "甲公司", "乙公司"]) {
            row.push(e.into());
        }
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, false, true, true]
        );
        r[0][5] = "60".into();
        r[0][7] = "60".into();
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, true, true, true]
        );
    }
    #[test]
    fn organization_pair_proof_precedes_upper_account_validation() {
        let (mut h, mut r, mut m) = fixture(&[
            &["400201", "全组织资本公积", "", "CNY", "0", "30", "0", "30"],
            &["4002", "资本公积", "", "CNY", "0", "20", "0", "20"],
            &["400201", "资本溢价", "", "CNY", "0", "20", "0", "20"],
            &["400201", "资本溢价", "", "CNY", "0", "20", "0", "20"],
            &["400201", "资本溢价", "", "CNY", "0", "10", "0", "10"],
        ]);
        h.push("主体".into());
        m.insert("entity".into(), serde_json::json!("主体"));
        for (row, e) in r
            .iter_mut()
            .zip(["", "甲公司", "甲公司", "甲公司", "乙公司"])
        {
            row.push(e.into());
        }
        assert_eq!(
            tb_leaf_mask(&h, &r, &|role| mapped_column_names(&m, role)),
            vec![false, false, false, true, true]
        );
    }
    #[test]
    #[ignore = "需要 TB_STRUCTURE_CASES、TB_STRUCTURE_ORACLE 和 TB_STRUCTURE_OUTPUT 指向独立原件关系及输出"]
    fn structure_reverse_native_samples() {
        assert!(
            std::env::var_os("TB_STRUCTURE_ORACLE").is_some(),
            "必须指定独立结构关系，不能从程序掩码反推真值"
        );
        use sha2::{Digest, Sha256};
        let oracle: Value = serde_json::from_slice(
            &std::fs::read(std::env::var("TB_STRUCTURE_ORACLE").unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(oracle["locked"], true, "独立结构真值必须先锁定");
        let sources = oracle["sources"].as_array().expect("独立原件哈希清单");
        assert!(!sources.is_empty(), "不能用空原件清单验收");
        for source in sources {
            let path = source["path"].as_str().unwrap();
            let hash = format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()));
            assert_eq!(
                hash,
                source["sha256"].as_str().unwrap(),
                "原件已变化，必须重新独立生成关系：{path}"
            );
        }
        structure_all_native_samples();
    }
    #[test]
    #[ignore = "需要 TB_STRUCTURE_CASES 指向本机完整样本映射清单"]
    fn structure_all_native_samples() {
        let input = std::env::var("TB_STRUCTURE_CASES").expect("设置样本清单");
        let doc: Value = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
        let oracle: Option<Value> = std::env::var("TB_STRUCTURE_ORACLE")
            .ok()
            .map(|p| serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap());
        let mut results = Vec::new();
        let mut total_reverse_failures = 0usize;
        for item in doc["sheets"].as_array().unwrap() {
            if item["mapping"].get("accountCode").is_none() {
                continue;
            }
            let path = item["path"].as_str().unwrap();
            if let Ok(filter) = std::env::var("TB_STRUCTURE_FILTER") {
                if !path.contains(&filter) {
                    continue;
                }
            }
            let sheet = item["sheet"].as_str().unwrap();
            let source = crate::fx::SourceSpec {
                input_path: path.into(),
                sheet: sheet.into(),
                header_row: 0,
                header_depth: 0,
            };
            let table = crate::fx::load_fx_table(&source).unwrap();
            let mut mapping = serde_json::Map::new();
            for (role, positions) in item["mapping"].as_object().unwrap() {
                let names = positions
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|i| table.headers.get(i.as_u64().unwrap() as usize))
                    .cloned()
                    .collect::<Vec<_>>();
                mapping.insert(
                    role.replace("Original", "Foreign"),
                    serde_json::json!(names),
                );
            }
            let col = |role: &str| mapped_column_names(&mapping, role);
            let a = tb_classification_analysis(&table.headers, &table.rows, &col);
            let mut reverse_checks = 0usize;
            let mut reverse_failures = Vec::new();
            if let Some(oracle) = &oracle {
                let mut graph = BTreeMap::<usize, BTreeSet<usize>>::new();
                for s in oracle["sheets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|s| s["path"] == path && s["sheet"] == sheet)
                {
                    for r in s["relations"].as_array().unwrap() {
                        graph
                            .entry(r["parent"].as_u64().unwrap() as usize)
                            .or_default()
                            .extend(
                                r["children"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .map(|c| c.as_u64().unwrap() as usize),
                            );
                    }
                }
                let kept = |physical: usize| {
                    physical
                        .checked_sub(table.header_row + table.header_depth)
                        .and_then(|i| a.keep.get(i))
                        .copied()
                        .unwrap_or(false)
                };
                let amount_indexes = TB_AMOUNT_ROLES
                    .iter()
                    .flat_map(|role| col(role))
                    .filter_map(|h| header_index(&table.headers, &h))
                    .collect::<BTreeSet<_>>();
                let has_money = |physical: usize| {
                    physical
                        .checked_sub(table.header_row + table.header_depth)
                        .and_then(|i| table.rows.get(i))
                        .is_some_and(|r| {
                            amount_indexes.iter().any(|j| {
                                r.get(*j).is_some_and(|s| {
                                    parse_amount(s)
                                        .ok()
                                        .flatten()
                                        .is_some_and(|v| v.abs() > 0.005)
                                })
                            })
                        })
                };
                for (&p, ch) in &graph {
                    reverse_checks += 1;
                    if !kept(p) || !has_money(p) {
                        continue;
                    }
                    let mut pending = ch.iter().copied().collect::<Vec<_>>();
                    let mut seen = BTreeSet::from([p]);
                    while let Some(c) = pending.pop() {
                        if !seen.insert(c) {
                            continue;
                        }
                        if kept(c) && has_money(c) {
                            reverse_failures.push((p, c));
                        }
                        if let Some(next) = graph.get(&c) {
                            pending.extend(next);
                        }
                    }
                }
                total_reverse_failures += reverse_failures.len();
                if !reverse_failures.is_empty() {
                    eprintln!(
                        "漏识别汇总 {path}/{sheet} 共{}对，前30对 {:?}",
                        reverse_failures.len(),
                        &reverse_failures[..reverse_failures.len().min(30)]
                    );
                }
            }
            if std::env::var_os("TB_STRUCTURE_DEBUG").is_some() {
                eprintln!(
                    "表头行={} 层数={} 映射={mapping:?}",
                    table.header_row, table.header_depth
                );
                for (i, r) in table.rows.iter().enumerate().take(8) {
                    eprintln!(
                        "行{} 保留={} {r:?}",
                        i + table.header_row + table.header_depth,
                        a.keep[i]
                    );
                }
            }
            let mut checks = Vec::new();
            let mut check_row = |physical: usize, expected: bool| {
                let logical = physical - table.header_row - table.header_depth;
                assert_eq!(a.keep[logical], expected, "{path}/{sheet}/源行{physical}");
                checks.push(serde_json::json!({"row":physical,"keep":a.keep[logical]}));
            };
            if path.contains("3080-") {
                assert!(a.keep.iter().all(|v| *v), "3080真实切片不得删除");
            }
            if path.contains("FX2 2025科目余额表") {
                for r in [10, 11] {
                    check_row(r, false);
                }
                for r in [12, 13, 14] {
                    check_row(r, true);
                }
            }
            if path.ends_with("10科目余额表.xlsx") {
                check_row(62, false);
                let shift = usize::from(sheet == "EY 修改");
                check_row(324 + shift, false);
                for r in 325 + shift..=330 + shift {
                    check_row(r, true);
                }
            }
            if path.contains("君屹") || path.ends_with("科目余额表202606_微信版.xls") {
                check_row(23115, false);
                check_row(23116, true);
                check_row(23117, true);
                check_row(34696, true);
                for r in 43885..=43887 {
                    check_row(r, true);
                }
            }
            if path.ends_with("TBJE-科目余额表-20251231 0115最新.xlsx")
                && matches!(sheet, "sheet1" | "sheet1 (2)" | "副本")
            {
                for r in [61, 125, 419, 630, 839, 842, 845] {
                    check_row(r, false);
                }
                for r in [420, 631] {
                    check_row(r, true);
                }
            }
            let cancel = std::sync::atomic::AtomicBool::new(false);
            let disk = crate::disk_table::DiskTable::open(
                std::path::Path::new(path),
                Some(sheet),
                table.header_row,
                table.header_depth,
                &|_, _, _, _| {},
                &cancel,
            )
            .unwrap();
            let b = disk_tb::analyze(&disk, &col, true, &|_, _, _, _| {}, &cancel).unwrap();
            assert!(
                b.analysis.keep.len() >= a.keep.len(),
                "磁盘正文不足 {path}/{sheet}"
            );
            let differences = a
                .keep
                .iter()
                .zip(&b.analysis.keep)
                .enumerate()
                .filter_map(|(i, (x, y))| {
                    (x != y).then_some(i + table.header_row + table.header_depth)
                })
                .collect::<Vec<_>>();
            assert!(
                differences.is_empty(),
                "内存磁盘掩码 {path}/{sheet}: {differences:?}"
            );
            assert!(
                b.analysis.keep[a.keep.len()..].iter().all(|k| !*k),
                "格式化尾部空行不能计入 {path}/{sheet}"
            );
            assert_eq!(
                a.contexts,
                &b.analysis.contexts[..a.contexts.len()],
                "内存磁盘分类 {path}/{sheet}"
            );
            results.push(serde_json::json!({"path":path,"sheet":sheet,"rows":table.rows.len(),"excluded":a.keep.iter().filter(|v|!**v).count(),"excludedRows":a.keep.iter().enumerate().filter_map(|(i,k)|(!k).then_some(i+table.header_row+table.header_depth)).collect::<Vec<_>>(),"checks":checks,"diskEquivalent":true,"reverseRelationsChecked":reverse_checks,"reverseViolations":reverse_failures}));
            eprintln!("样本通过 {path}/{sheet}");
            if let Ok(output) = std::env::var("TB_STRUCTURE_OUTPUT") {
                std::fs::write(output, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
            }
        }
        let output = std::env::var("TB_STRUCTURE_OUTPUT").expect("设置报告路径");
        std::fs::write(output, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
        assert_eq!(
            total_reverse_failures, 0,
            "独立结构关系中仍存在非零金额的父子重复保留，逐表行号见输出报告"
        );
    }
}
