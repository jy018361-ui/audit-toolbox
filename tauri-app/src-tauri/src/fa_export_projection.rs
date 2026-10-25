//! Borrow merged detail cells without rebuilding a JSON object per row.

use super::{Cell, JoinedRow, MergeResult, cell};
use std::{borrow::Cow, collections::HashMap};

#[derive(Clone, Copy, Debug)]
enum Source {
    Begin(usize),
    End(usize),
    Origin,
    Match,
    Missing,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum MergedCell<'a> {
    Text(&'a str),
    Number(f64),
    Null,
    Missing,
}

impl<'a> MergedCell<'a> {
    pub(super) fn rendered(self) -> Cow<'a, str> {
        match self {
            Self::Text(value) => Cow::Borrowed(value),
            Self::Number(value) => Cow::Owned(serde_json::json!(value).to_string()),
            Self::Null | Self::Missing => Cow::Borrowed(""),
        }
    }
}

pub(super) struct MergedProjection {
    sources: Vec<Source>,
    positions: HashMap<String, Vec<usize>>,
}

impl MergedProjection {
    pub(super) fn new(result: &MergeResult, columns: &[String]) -> Self {
        // Keep row_json's last-insert-wins behavior, including duplicate headers.
        let mut sources = HashMap::new();
        for (i, header) in result.begin.headers.iter().enumerate() {
            sources.insert(format!("{header}_期初"), Source::Begin(i));
        }
        for (i, header) in result.end.headers.iter().enumerate() {
            sources.insert(format!("{header}_期末"), Source::End(i));
        }
        sources.insert("数据来源".into(), Source::Origin);
        sources.insert("匹配列".into(), Source::Match);
        let sources = columns.iter().map(|name| sources.get(name).copied().unwrap_or(Source::Missing)).collect();
        let mut positions: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, name) in columns.iter().enumerate() {
            positions.entry(name.clone()).or_default().push(i);
        }
        Self { sources, positions }
    }

    pub(super) fn project<'a>(&self, row: &'a JoinedRow) -> Vec<MergedCell<'a>> {
        let mut values = self.sources.iter().map(|source| match source {
            Source::Begin(i) => MergedCell::Text(row.begin.as_ref().map(|r| cell(r, *i)).unwrap_or("")),
            Source::End(i) => MergedCell::Text(row.end.as_ref().map(|r| cell(r, *i)).unwrap_or("")),
            Source::Origin => MergedCell::Text(row.source),
            Source::Match => MergedCell::Text(&row.match_value),
            Source::Missing => MergedCell::Missing,
        }).collect::<Vec<_>>();
        // Extras can override source columns and can collide after suffix
        // conversion. Iterate in the same BTreeMap order as row_json.
        for (key, value) in &row.extra {
            let name = key.replace("_文件1", "_期初").replace("_文件2", "_期末");
            if let Some(positions) = self.positions.get(&name) {
                let value = match value {
                    Cell::Text(text) => MergedCell::Text(text),
                    Cell::Number(number) if number.is_finite() => MergedCell::Number(*number),
                    Cell::Number(_) => MergedCell::Null,
                };
                for &position in positions { values[position] = value; }
            }
        }
        values
    }
}
