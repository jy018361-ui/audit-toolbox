//! Task-local reuse of completed, read-only TB analysis and its disk store.
use super::*;
use std::{cell::RefCell, collections::{HashMap, VecDeque}, rc::Rc};

struct Entry {
    source: (PathBuf, Vec<String>, usize),
    context: bool,
    columns: HashMap<String, Vec<String>>,
    result: Rc<DiskTbAnalysis>,
}

thread_local! {
    static CACHE: RefCell<Option<VecDeque<Entry>>> = const { RefCell::new(None) };
}

/// Nested business helpers share their caller's scope. No analysis survives a
/// worker request or synchronous command, including error/unwind exits.
pub(crate) struct AnalysisScope(bool);
impl AnalysisScope {
    pub(crate) fn begin() -> Self {
        Self(CACHE.with(|cache| {
            let mut cache = cache.borrow_mut();
            if cache.is_some() { false } else { *cache = Some(VecDeque::new()); true }
        }))
    }
}
impl Drop for AnalysisScope {
    fn drop(&mut self) {
        if self.0 { CACHE.with(|cache| *cache.borrow_mut() = None); }
    }
}

pub(crate) fn analyze_shared(
    source: &DiskTable,
    column: &dyn Fn(&str) -> Vec<String>,
    collect_context: bool,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Rc<DiskTbAnalysis>, AppError> {
    check(cancel)?;
    // The immutable source cache name includes original path/size/mtime,
    // sheet, header layout and parser version; distinguish FA-style caches too.
    let identity = (source.cache_path.clone(), source.headers.clone(), source.row_count);
    let hit = CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let entries = cache.as_mut()?;
        let at = entries.iter().position(|entry| entry.source == identity
            && entry.context == collect_context
            && entry.columns.iter().all(|(role, previous)| column(role) == *previous))?;
        let entry = entries.remove(at)?;
        let result = Rc::clone(&entry.result);
        entries.push_back(entry);
        Some(result)
    });
    if let Some(result) = hit {
        check(cancel)?;
        if std::env::var_os("AUDIT_TB_REUSE_PERF").is_some() { eprintln!("TB分析复用：跳过完整重建"); }
        return Ok(result);
    }

    // Record the roles actually consumed, including legacy/private aliases.
    // Memoizing their resolution also avoids rebuilding mapping vectors inside
    // the analysis loops. An input that changes any consumed role cannot hit.
    let columns = RefCell::new(HashMap::<String, Vec<String>>::new());
    let resolve = |role: &str| {
        if let Some(value) = columns.borrow().get(role) { return value.clone(); }
        let value = column(role);
        columns.borrow_mut().insert(role.to_owned(), value.clone());
        value
    };
    let started = std::time::Instant::now();
    let result = Rc::new(analyze(source, &resolve, collect_context, progress, cancel)?);
    check(cancel)?;
    if std::env::var_os("AUDIT_TB_REUSE_PERF").is_some() { eprintln!("TB分析构建：{:.3}s", started.elapsed().as_secs_f64()); }
    CACHE.with(|cache| {
        if let Some(entries) = cache.borrow_mut().as_mut() {
            // Bound retained masks/context and temporary disk stores per task.
            if entries.len() == 3 { entries.pop_front(); }
            entries.push_back(Entry { source: identity, context: collect_context,
                columns: columns.into_inner(), result: Rc::clone(&result) });
        }
    });
    Ok(result)
}

#[cfg(test)]
#[test]
#[ignore = "合成大表性能探针，显式运行"]
fn shared_tb_analysis_synthetic_bench() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("TB.csv");
    let mut writer = csv::Writer::from_path(&path).unwrap();
    writer.write_record(["主体", "科目编码", "科目名称", "期初余额", "期末余额"]).unwrap();
    for index in 0..2000 {
        writer.write_record(["A".to_owned(), format!("{index:08}"), "银行存款".to_owned(), "100".to_owned(), "200".to_owned()]).unwrap();
    }
    writer.flush().unwrap();
    let cancel = AtomicBool::new(false);
    let source = DiskTable::open(&path,None,1,1,&|_,_,_,_|{},&cancel).unwrap();
    let column = |role: &str| match role {
        "entity" => vec!["主体".into()], "accountCode" => vec!["科目编码".into()],
        "accountName" => vec!["科目名称".into()], "openingFunctionalAmount" => vec!["期初余额".into()],
        "closingFunctionalAmount" => vec!["期末余额".into()], _ => Vec::new(),
    };
    let started = std::time::Instant::now();
    let mut expected = Vec::new();
    for _ in 0..3 { expected = analyze(&source,&column,false,&|_,_,_,_|{},&cancel).unwrap().analysis.keep; }
    let before = started.elapsed().as_secs_f64();
    let _scope = AnalysisScope::begin();
    let started = std::time::Instant::now();
    let first = analyze_shared(&source,&column,false,&|_,_,_,_|{},&cancel).unwrap();
    assert_eq!(first.analysis.keep,expected);
    for _ in 0..2 { assert!(Rc::ptr_eq(&first,&analyze_shared(&source,&column,false,&|_,_,_,_|{},&cancel).unwrap())); }
    println!("TB合成探针：2000行，3次访问；原完整构建3次 {:.3}s，共享后构建1次 {:.3}s（Debug局部探针）",before,started.elapsed().as_secs_f64());
}
