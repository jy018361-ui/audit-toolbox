import { useEffect, useMemo, useState } from "react";
import {
  activateCaseLibrary,
  diffCaseLibraries,
  importCaseLibraryExcel,
  loadCaseLibraryState,
  makeCaseLibraryVersion,
  rollbackCaseLibrary,
  type CaseLibraryState,
  type CaseLibraryVersion,
} from "./audipickCaseLibrary";
import "./CovenantCaseLibraryManager.css";

type LibraryView = "positive" | "categories" | "exclusions";

function matchesSearch(row: object, query: string) {
  if (!query) return true;
  return Object.values(row).some((value) => String(value ?? "").toLocaleLowerCase().includes(query));
}

export default function CovenantCaseLibraryManager() {
  const [state, setState] = useState<CaseLibraryState>();
  const [preview, setPreview] = useState<CaseLibraryVersion>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<LibraryView>("positive");
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("all");

  useEffect(() => {
    loadCaseLibraryState().then(setState).catch((loadError) => setError(String(loadError)));
  }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (workError) {
      setError(workError instanceof Error ? workError.message : String(workError));
    } finally {
      setBusy(false);
    }
  };

  const library = state?.active.library;
  const activePositiveExamples = useMemo(
    () => library?.positive_examples.filter((row) => row.status !== "停用" && row.status !== "disabled") ?? [],
    [library],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const positiveRows = useMemo(
    () => activePositiveExamples.filter((row) => (categoryId === "all" || row.category_id === categoryId) && matchesSearch(row, normalizedQuery)),
    [activePositiveExamples, categoryId, normalizedQuery],
  );
  const categoryRows = useMemo(
    () => library?.categories.filter((row) => matchesSearch(row, normalizedQuery)) ?? [],
    [library, normalizedQuery],
  );
  const exclusionRows = useMemo(
    () => library?.exclusions_and_support.filter((row) => matchesSearch(row, normalizedQuery)) ?? [],
    [library, normalizedQuery],
  );
  const diff = state && preview ? diffCaseLibraries(state.active.library, preview.library) : undefined;

  return (
    <section aria-label="限制性契约案例库" className="apl-page apl-config-page apl-case-library">
      <div className="clm-heading">
        <div>
          <h2>限制性契约案例库</h2>
          <p>用于判断哪些合同条款应收录，并为提取提供分类标准、正例和排除规则。</p>
        </div>
        <button
          type="button"
          className="primary"
          aria-expanded={open}
          aria-controls="covenant-case-library-content"
          disabled={!state}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "收起案例" : "查看案例"}
        </button>
      </div>

      {state && (
        <>
          <div className="clm-stats" aria-label="案例库摘要">
            <span><strong>{state.active.library.categories.length}</strong> 个分类</span>
            <span><strong>{activePositiveExamples.length}</strong> 条启用正例</span>
            <span><strong>{state.active.library.exclusions_and_support.length}</strong> 条排除与支持规则</span>
            <span><strong>{state.active.library.metadata.version}</strong> 当前版本</span>
          </div>
          <details className="clm-version-details">
            <summary>版本详情</summary>
            <p>启用时间：{new Date(state.active.activatedAt).toLocaleString()}</p>
            <p>摘要 SHA-256：<code>{state.active.hash}</code></p>
          </details>
        </>
      )}

      {open && library && (
        <div id="covenant-case-library-content" className="clm-browser" role="region" aria-label="案例库内容">
          <div className="clm-browser-toolbar">
            <div className="clm-tabs" role="tablist" aria-label="案例库内容类型">
              <button type="button" role="tab" aria-selected={view === "positive"} className={view === "positive" ? "active" : ""} onClick={() => setView("positive")}>启用正例（{activePositiveExamples.length}）</button>
              <button type="button" role="tab" aria-selected={view === "categories"} className={view === "categories" ? "active" : ""} onClick={() => setView("categories")}>分类标准（{library.categories.length}）</button>
              <button type="button" role="tab" aria-selected={view === "exclusions"} className={view === "exclusions" ? "active" : ""} onClick={() => setView("exclusions")}>排除与支持（{library.exclusions_and_support.length}）</button>
            </div>
            <div className="clm-filters">
              <label>搜索案例<input aria-label="搜索案例" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="编号、类型、规则或原文" /></label>
              {view === "positive" && <label>分类<select aria-label="筛选分类" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="all">全部分类</option>{library.categories.map((item) => <option value={item.category_id} key={item.category_id}>{item.category_id} {item.category}</option>)}</select></label>}
            </div>
          </div>

          <div className="clm-table-wrap">
            {view === "positive" && <table><caption>正例案例，共显示 {positiveRows.length} 条</caption><thead><tr><th>编号</th><th>分类与类型</th><th>判断标准</th><th>合同原文示例</th><th>核验数据</th></tr></thead><tbody>{positiveRows.map((row) => <tr key={row.case_id}><td><strong>{row.case_id}</strong></td><td>{row.category}<small>{row.subtype}</small></td><td>{row.normalized_rule}</td><td className="clm-excerpt">{row.excerpt}</td><td>{row.data_basis}</td></tr>)}</tbody></table>}
            {view === "categories" && <table><caption>分类标准，共显示 {categoryRows.length} 条</caption><thead><tr><th>编号</th><th>分类</th><th>收录标准</th><th>常见案例</th><th>排除边界</th></tr></thead><tbody>{categoryRows.map((row) => <tr key={row.category_id}><td><strong>{row.category_id}</strong></td><td>{row.category}</td><td>{row.include}</td><td>{row.examples}</td><td>{row.exclude}</td></tr>)}</tbody></table>}
            {view === "exclusions" && <table><caption>排除与支持规则，共显示 {exclusionRows.length} 条</caption><thead><tr><th>编号</th><th>处理类型</th><th>主题</th><th>示例原文</th><th>处理方式</th></tr></thead><tbody>{exclusionRows.map((row) => <tr key={row.case_id}><td><strong>{row.case_id}</strong></td><td><span className={`clm-type clm-type-${row.type === "排除" ? "exclude" : "support"}`}>{row.type}</span></td><td>{row.topic}</td><td className="clm-excerpt">{row.excerpt}</td><td>{row.handling}</td></tr>)}</tbody></table>}
          </div>
        </div>
      )}

      <div className="clm-maintenance">
        <div>
          <h3>更新案例库</h3>
          <p>仅在需要调整规则时使用。导入后先查看差异，再启用新版本；历史结果会保持不变，直到重新提取。</p>
        </div>
        <div className="clm-actions">
          <label className={`clm-file-button ${busy || !state ? "disabled" : ""}`} htmlFor="covenant-case-library-file">导入 Excel 更新</label>
          <input
            id="covenant-case-library-file"
            className="clm-file-input"
            aria-label="导入案例库 Excel"
            type="file"
            accept=".xlsx"
            disabled={busy || !state}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                setPreview(undefined);
                void run(async () => setPreview(await makeCaseLibraryVersion(await importCaseLibraryExcel(file))));
              }
            }}
          />
          <button type="button" disabled={busy || !state?.previous} onClick={() => void run(async () => {
            setState(await rollbackCaseLibrary());
            setPreview(undefined);
            setMessage("已回滚上一版本；历史结果保持不变。");
          })}>回滚上一版本</button>
          {!state?.previous && <span className="clm-action-note">启用新版本后才可回滚</span>}
        </div>
        <p className="clm-help">Excel 需保留原工作簿的五个工作表和必填列。</p>
      </div>

      {preview && diff && <div className="clm-import-preview" aria-label="案例库变更预览"><h3>导入检查通过</h3><p>待启用版本：{preview.library.metadata.version}</p>{([['新增', diff.added], ['删除', diff.removed], ['修改', diff.changed]] as const).map(([label, items]) => <p key={label}><strong>{label} {items.length} 项：</strong>{items.join('、') || '无'}</p>)}<div className="clm-actions"><button type="button" className="primary" disabled={busy || preview.hash === state?.active.hash} onClick={() => void run(async () => { setState(await activateCaseLibrary(preview.library)); setPreview(undefined); setMessage("新版本已启用；重新提取后应用新规则。"); })}>启用此版本</button><button type="button" disabled={busy} onClick={() => setPreview(undefined)}>取消导入</button></div></div>}
      {error && <p className="clm-message clm-error" role="alert">{error}</p>}
      {message && <p className="clm-message clm-success" role="status">{message}</p>}
    </section>
  );
}
