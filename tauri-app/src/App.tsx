import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactElement } from "react";
import { NavLink, Navigate, Route, Routes, useParams } from "react-router-dom";
import {
  appBootstrap,
  audipickPdfBytes,
  engineCall,
  historyGet,
  jobCancel,
  jobPause,
  jobStart,
  legacyImport,
  listenFileDrops,
  listenJobEvents,
  llmTest,
  openOutput,
  pickPath,
  secretSet,
  settingsGet,
  settingsSet,
  toolCatalog,
} from "./api";
import {
  TOOL_DEFINITIONS,
  type ActionDefinition,
  type FieldDefinition,
} from "./toolDefinitions";
import type { Bootstrap, JobEvent, ToolManifest } from "./types";
import {
  buildClassifyPrompt,
  buildRevenueBatchPrompt,
  buildRevenueQuestionBatches,
  classifySample,
  extractionCacheKey,
  matchEvidenceDocument,
  mergeRevenueAnswers,
  pickClassifiedRule,
  splitContractText,
  withRetry,
  REVENUE_FACT_PROMPT,
  type ClassifiedDocument,
} from "./audipickUi";
import { TsManagerParityPage } from "./TsManagerParityPage";
import ConfirmationProgressPage from "./ConfirmationProgressPage";
import FileListDirectoryPage from "./FileListDirectoryPage";
import { KanzhangParityPage } from "./KanzhangParityPage";
import { FaListPage } from "./FaListPage";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { ResultView } from "@/components/ResultView";
import { formatSize, parentPath } from "@/lib/utils";
import {
  parseRollForwardCraRatio,
  rollForwardCraWriteRecords,
} from "./rollForwardUi";

const NAV = [
  { to: "/", label: "工作台" },
  { to: "/tasks", label: "任务中心" },
  { to: "/history", label: "历史记录" },
  { to: "/settings", label: "设置" },
  { to: "/diagnostics", label: "日志诊断" },
];

function IconHome() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  );
}
function IconTasks() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 5.5 5 7l2.5-2.5" />
      <path d="M3.5 11.5 5 13l2.5-2.5" />
      <path d="M3.5 17.5 5 19l2.5-2.5" />
      <path d="M11 6h10M11 12h10M11 18h10" />
    </svg>
  );
}
function IconHistory() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 2.6-6.3L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v6l4 2" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6h8M16 6h4M4 12h4M12 12h8M4 18h11M19 18h1" />
      <circle cx="14" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="15" cy="18" r="2" />
    </svg>
  );
}
function IconTerminal() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

const NAV_ICON: Record<string, ReactElement> = {
  "/": <IconHome />,
  "/tasks": <IconTasks />,
  "/history": <IconHistory />,
  "/settings": <IconSettings />,
  "/diagnostics": <IconTerminal />,
};

// 九个工具固定不变（见 public/tool-catalog.json），用两字徽标代替千篇一律的纯文字列表，
// 方便在侧边栏一眼定位；不逐个配色，避免走回文件顶部注释警惕过的"173 种颜色"老路。
const TOOL_BADGE: Record<string, string> = {
  fa_list: "FA",
  kanzhang: "账",
  ts_manager: "TS",
  confirmation_progress: "函",
  Excel_Merger: "合",
  file_list_directory: "夹",
  audipick: "AP",
  audit_roll_forward: "RF",
  wp_service_generator: "WP",
};

export default function App() {
  const [catalog, setCatalog] = useState<ToolManifest[]>([]);
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [jobs, setJobs] = useState<Record<string, JobEvent>>({});
  const [startupReady, setStartupReady] = useState(false);
  const [startupError, setStartupError] = useState("");
  useEffect(() => {
    void Promise.all([toolCatalog(), appBootstrap()])
      .then(([c, b]) => {
        setCatalog(c);
        setBootstrap(b);
      })
      .catch((error) => setStartupError(appErrorText(error)))
      .finally(() => setStartupReady(true));
    void listenJobEvents((e) => setJobs((v) => ({ ...v, [e.jobId]: e }))).catch(
      () => undefined,
    );
  }, []);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span>AUDIT TOOLKIT</span>
          <h1>审计工具箱</h1>
          <p>统一、安全、可追踪的审计作业工作台</p>
        </div>
        <nav>
          {NAV.map((x) => (
            <NavLink key={x.to} to={x.to} end={x.to === "/"}>
              <span className="nav-icon">{NAV_ICON[x.to]}</span>
              {x.label}
            </NavLink>
          ))}
        </nav>
        <div className="tool-nav">
          <div className="nav-caption">工具</div>
          {catalog.map((t) => (
            <NavLink key={t.id} to={t.route}>
              <span className="tool-badge">
                {TOOL_BADGE[t.id] ?? t.name.slice(0, 1)}
              </span>
              {t.name}
            </NavLink>
          ))}
        </div>
        <div className="sidebar-footer">
          <span>v{bootstrap?.appVersion ?? "…"}</span>
          <span>
            {bootstrap?.engine.available ? "Rust 核心正常" : "Rust 核心待连接"}
          </span>
        </div>
      </aside>
      <main className="main">
        {!startupReady ? (
          <AppLoading />
        ) : startupError ? (
          <SimplePage
            title="启动失败"
            text={`${startupError} 请刷新后重试。`}
          />
        ) : (
          <Routes>
            <Route
              path="/"
              element={
                <Dashboard catalog={catalog} jobs={Object.values(jobs)} />
              }
            />
            <Route
              path="/tools/:toolId"
              element={<ToolPage catalog={catalog} />}
            />
            <Route
              path="/tasks"
              element={<TaskCenter jobs={Object.values(jobs)} />}
            />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="/diagnostics"
              element={
                <SimplePage
                  title="日志诊断"
                  text="日志仅包含阶段、耗时和诊断编号，不记录客户数据或密钥。"
                />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

function AppLoading() {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <span className="loading-dot" aria-hidden="true" />
      <div>
        <strong>正在准备审计工具箱…</strong>
        <p>正在连接工具目录与本地运行环境。</p>
      </div>
    </div>
  );
}

/// Relative time, because "3 小时前" answers "is this still relevant" and a raw
/// timestamp does not.
function relativeTime(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / (60 * 24))} 天前`;
}

function Dashboard({
  catalog,
  jobs,
}: {
  catalog: ToolManifest[];
  jobs: JobEvent[];
}) {
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    void historyGet()
      .then(setHistory)
      .catch(() => undefined);
  }, []);
  const nameOf = (toolId: string) =>
    catalog.find((tool) => tool.id === toolId)?.name ?? toolId;
  const running = jobs.filter(
    (job) => !["completed", "failed", "cancelled"].includes(job.phase),
  );
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const finishedToday = history.filter(
    (row) =>
      row.status === "completed" &&
      new Date(String(row.startedAt ?? "")).getTime() >= startOfToday,
  ).length;
  const latest = history[0];
  // Most recently used tools, de-duplicated, newest first.
  const recentTools = [
    ...new Set(history.map((row) => String(row.toolId ?? "")).filter(Boolean)),
  ]
    .map((id) => catalog.find((tool) => tool.id === id))
    .filter((tool): tool is ToolManifest => Boolean(tool))
    .slice(0, 4);
  return (
    <>
      <PageHeader
        eyebrow="作业中枢"
        title="选择一个工具开始处理"
        detail="所有任务共享同一套文件、进度、错误和结果体验。"
      />
      {/*
        These four used to report 已登记工具 9 / Tauri 已就绪 9-9 / Rust 核心 正常 /
        平台 Windows x64 — the program describing itself. None of it helps an
        auditor decide what to do next, and it occupied the most prominent strip
        on the landing page.
      */}
      <section className="metrics">
        <Metric label="进行中任务" value={String(running.length)} />
        <Metric label="今天完成" value={String(finishedToday)} />
        <Metric
          label="最近一次"
          value={latest ? nameOf(String(latest.toolId ?? "")) : "—"}
          detail={
            latest ? relativeTime(String(latest.startedAt ?? "")) : "尚无记录"
          }
        />
        <Metric label="累计任务" value={String(history.length)} />
      </section>
      {recentTools.length > 0 && (
        <section className="recent-tools">
          <span className="nav-caption">最近使用</span>
          <div>
            {recentTools.map((tool) => (
              <NavLink className="recent-chip" to={tool.route} key={tool.id}>
                {tool.name}
              </NavLink>
            ))}
          </div>
        </section>
      )}
      <section className="card-grid">
        {catalog.map((t) => (
          <NavLink className="tool-card" to={t.route} key={t.id}>
            <div>
              {/* The migration-status badge said "已接入" on all nine cards: no
                  information, top billing. */}
              <h2>{t.name}</h2>
              <p>{t.description}</p>
            </div>
            <strong>打开工具 →</strong>
          </NavLink>
        ))}
      </section>
    </>
  );
}

/// Rust rejects with a plain `AppError` object rather than an `Error`, so
/// `String(e)` renders `[object Object]`.  Every dedicated page has its own copy
/// of this; the generic page needs one too.
function appErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return String(
      value.userMessage ??
        value.message ??
        value.detail ??
        "操作失败，请查看日志诊断。",
    );
  }
  return "操作失败，请查看日志诊断。";
}

function ToolPage({ catalog }: { catalog: ToolManifest[] }) {
  const { toolId = "" } = useParams();
  const tool = catalog.find((t) => t.id === toolId);
  const def = TOOL_DEFINITIONS[toolId];
  const [values, setValues] = useState<Record<string, unknown>>({
    mode: "bank",
    mergeMode: "all",
    pivotMode: "manager",
    ruleId: "loan_covenant",
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>();
  const [job, setJob] = useState<JobEvent>();
  const [error, setError] = useState("");
  const activeJob = useRef("");
  const missing = useMemo(
    () =>
      def?.fields
        .filter((f) => f.required && !String(values[f.key] ?? "").trim())
        .map((f) => f.label) ?? [],
    [def, values],
  );
  // Long jobs used to leave this page showing the placeholder `{ jobId }` for
  // ever, so tools without a dedicated page (WP 服务单) never surfaced a single
  // number the engine had computed.
  useEffect(() => {
    const stop = listenJobEvents((event) => {
      if (event.jobId !== activeJob.current) return;
      setJob(event);
      if (event.phase === "completed") {
        setBusy(false);
        if (event.result && typeof event.result === "object")
          setResult(event.result);
      } else if (event.phase === "failed" || event.phase === "cancelled") {
        setBusy(false);
        setResult(undefined);
        const payload = event.result as
          { error?: { userMessage?: string } } | undefined;
        setError(payload?.error?.userMessage ?? event.message);
      }
    });
    return () => {
      void stop.then((fn) => fn());
    };
  }, []);
  if (!tool || !def)
    return <SimplePage title="工具不存在" text="工具登记信息尚未加载。" />;
  if (tool.id === "Excel_Merger") return <ExcelMergerPage tool={tool} />;
  if (tool.id === "fa_list") return <FaListPage tool={tool} />;
  if (tool.id === "audipick") return <AudiPickPage tool={tool} />;
  if (tool.id === "ts_manager") return <TsManagerParityPage tool={tool} />;
  if (tool.id === "confirmation_progress")
    return <ConfirmationProgressPage tool={tool} />;
  if (tool.id === "file_list_directory")
    return <FileListDirectoryPage tool={tool} />;
  if (tool.id === "kanzhang") return <KanzhangParityPage tool={tool} />;
  if (tool.id === "audit_roll_forward") return <RollForwardPage tool={tool} />;
  async function run(action: ActionDefinition) {
    setError("");
    setResult(undefined);
    setJob(undefined);
    if (missing.length) {
      setError(`请先填写：${missing.join("、")}`);
      return;
    }
    setBusy(true);
    try {
      const payload = normalizeValues(values);
      if (action.mode === "job") {
        activeJob.current = await jobStart(action.method, payload);
        return;
      }
      activeJob.current = "";
      setResult(await engineCall(action.method, payload));
      setBusy(false);
    } catch (e) {
      // Rust returns a plain object, not an `Error`; without this the page used
      // to print `[object Object]` instead of the Chinese message.
      setError(appErrorText(e));
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader eyebrow="统一工具" title={tool.name} detail={def.intro} />
      <div className="workspace">
        <section className="form-card">
          <div className="section-title">
            <h2>任务配置</h2>
          </div>
          <div className="form-grid">
            {def.fields.map((f) => (
              <Field
                key={f.key}
                field={f}
                value={values[f.key]}
                onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))}
              />
            ))}
          </div>
          {error && <div className="error-box">{error}</div>}
          <div className="actions">
            {def.actions.map((a) => (
              <button
                disabled={busy}
                className={a.tone === "primary" ? "primary" : "secondary"}
                key={a.method}
                onClick={() => void run(a)}
              >
                {busy ? "处理中…" : a.label}
              </button>
            ))}
          </div>
        </section>
        <section className="result-card">
          <h2>检查与结果</h2>
          {job && job.phase !== "completed" && (
            <div className="job-progress">
              <progress value={job.current} max={Math.max(job.total, 1)} />
              <span>{job.message}</span>
            </div>
          )}
          {result ? (
            <ResultView value={result} />
          ) : (
            <div className="empty">
              先检查输入，再启动任务。任务离开页面后仍会在任务中心运行。
            </div>
          )}
        </section>
      </div>
    </>
  );
}

type AudiPickRelation = {
  id: string;
  anchorFileId: string;
  members: Array<{ fileId: string; role: string }>;
};
type AudiPickResult = Record<string, unknown> & {
  id?: string;
  contractId?: string;
  ruleId?: string;
  reviewed?: boolean;
};
type AudiPickProjectData = {
  project: {
    id: string;
    name: string;
    client?: string;
    date?: string;
    status?: string;
    relationGroups?: AudiPickRelation[];
  };
  contracts?: unknown[];
  results?: AudiPickResult[];
};
type AudiPickDocument = {
  id: string;
  name: string;
  path: string;
  sha256: string;
  size: number;
  status: string;
};
function AudiPickPage({ tool }: { tool: ToolManifest }) {
  const [projects, setProjects] = useState<AudiPickProjectData[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [documents, setDocuments] = useState<AudiPickDocument[]>([]);
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<unknown>();
  const [selectedDocument, setSelectedDocument] = useState("");
  const [pdfText, setPdfText] = useState("");
  const [ruleId, setRuleId] = useState("loan_covenant");
  const [selectedFieldKeys, setSelectedFieldKeys] = useState<string[]>([]);
  const [associationTarget, setAssociationTarget] = useState("");
  const [associationRole, setAssociationRole] = useState("补充协议/变更");
  const [customRuleName, setCustomRuleName] = useState("");
  const [customRulePrompt, setCustomRulePrompt] = useState("");
  const [ruleRevision, setRuleRevision] = useState(0);
  const [suggestedRule, setSuggestedRule] = useState<ClassifiedDocument>();
  const extractCache = useRef(
    new Map<string, Array<{ parsed?: { items?: unknown[] } }>>(),
  );
  const revenueFacts = useRef(
    new Map<string, Array<Record<string, unknown>>>(),
  );
  const [batchJob, setBatchJob] = useState<JobEvent>();
  const [batchPaused, setBatchPaused] = useState(false);
  const [pdfDocument, setPdfDocument] = useState<any>();
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
  const [pdfSearch, setPdfSearch] = useState("");
  const [pdfMatches, setPdfMatches] = useState<number[]>([]);
  const [pdfScale, setPdfScale] = useState(1.25);
  const [pdfRotation, setPdfRotation] = useState(0);
  const [configStatus, setConfigStatus] = useState<{
    llm?: { ready: boolean };
    ocr?: { ready: boolean; engine: string };
  }>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rules = useMemo(
    () => window.RuleEngine?.getAllSelectableRules() ?? [],
    [ruleRevision],
  );
  const fields = window.RuleEngine?.getFieldsForRule(ruleId) ?? [];
  const activeFieldKeys = selectedFieldKeys;
  const activeFieldSetId = `${ruleId}:${[...activeFieldKeys].sort().join("|")}`;
  const selected = projects.find((value) => value.project.id === selectedId);
  const matchedResults = (selected?.results ?? []).filter(
    (row) =>
      row.contractId === selectedDocument &&
      row.ruleId === ruleId &&
      (!row.fieldSetId || row.fieldSetId === activeFieldSetId),
  );
  // The revenue rules mark questions that the contract makes inapplicable (no
  // repurchase clause -> its two sub-questions drop out).  Showing and
  // exporting them anyway puts rows into the checklist that must not be filled
  // back into the workpaper.
  const currentResults =
    ruleId === "revenue_workpaper" &&
    typeof (window.RevenueWorkpaper as any)?.visibleItems === "function"
      ? ((window.RevenueWorkpaper as any).visibleItems(
          matchedResults,
        ) as AudiPickResult[])
      : matchedResults;
  const batchDocuments = Array.isArray(
    (batchJob?.result as { documents?: unknown })?.documents,
  )
    ? (batchJob?.result as { documents: Array<Record<string, any>> }).documents
    : [];
  const batchFailures = batchDocuments.filter((item) => !item.ok);
  const batchSuccessCount = batchDocuments.length - batchFailures.length;
  const revenueMissingTasks =
    ruleId === "revenue_workpaper" &&
    typeof (window.RevenueWorkpaper as any)?.buildMissingTasks === "function"
      ? (window.RevenueWorkpaper as any).buildMissingTasks(currentResults)
      : [];
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const value = (await engineCall("audipick.projects", {})) as {
        projects: AudiPickProjectData[];
      };
      setProjects(value.projects);
      if (!selectedId && value.projects[0])
        setSelectedId(value.projects[0].project.id);
      setResult(value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
    void engineCall("audipick.config_status", {})
      .then((value) => setConfigStatus(value as typeof configStatus))
      .catch(() => undefined);
    void settingsGet()
      .then((value) => {
        const audipick = (value.audipick ?? {}) as {
          customRules?: Array<Record<string, unknown>>;
        };
        window.RuleEngine?.setCustomRules(audipick.customRules ?? []);
        setRuleRevision((current) => current + 1);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!selectedId) {
      setDocuments([]);
      return;
    }
    void engineCall("audipick.documents", { projectId: selectedId })
      .then((value) =>
        setDocuments((value as { documents: AudiPickDocument[] }).documents),
      )
      .catch((e) => setError(errorText(e)));
  }, [selectedId]);
  useEffect(() => {
    setSelectedFieldKeys(
      (window.RuleEngine?.getFieldsForRule(ruleId) ?? []).map(
        (field) => field.key,
      ),
    );
  }, [ruleId, ruleRevision]);
  useEffect(() => {
    let off = () => {};
    void listenJobEvents((event) => {
      if (event.toolId !== "audipick") return;
      setBatchJob(event);
      if (event.result) setResult(event.result);
      if (event.phase === "completed" && event.result && selected) {
        const payload = event.result as {
          documents?: Array<{
            id: string;
            ok: boolean;
            parsed?: { items?: unknown[] };
          }>;
        };
        const incoming = (payload.documents ?? []).flatMap((document) =>
          document.ok && Array.isArray(document.parsed?.items)
            ? document.parsed.items
                .filter((item): item is Record<string, unknown> =>
                  Boolean(item && typeof item === "object"),
                )
                .map((item, index) => ({
                  ...item,
                  id: `r_${Date.now().toString(36)}_${document.id}_${index}`,
                  contractId: document.id,
                  ruleId,
                  fieldKeys: activeFieldKeys,
                  fieldSetId: activeFieldSetId,
                  extractAt: new Date().toISOString(),
                  reviewed: false,
                }))
            : [],
        );
        const documentIds = new Set(
          (payload.documents ?? []).map((document) => document.id),
        );
        const saved = {
          ...selected,
          results: [
            ...(selected.results ?? []).filter(
              (row) =>
                !(
                  documentIds.has(String(row.contractId)) &&
                  row.ruleId === ruleId &&
                  row.fieldSetId === activeFieldSetId
                ),
            ),
            ...incoming,
          ],
        };
        void engineCall("audipick.project_save", saved).then(() =>
          setProjects((current) =>
            current.map((project) =>
              project.project.id === selectedId ? saved : project,
            ),
          ),
        );
      }
    }).then((value) => {
      off = value;
    });
    return () => off();
  }, [selectedId, ruleId, selected, fields]);
  async function create() {
    if (!name.trim()) {
      setError("请输入项目名称。");
      return;
    }
    const id = `p_${Date.now().toString(36)}`;
    const data: AudiPickProjectData = {
      project: {
        id,
        name: name.trim(),
        client: client.trim(),
        date: new Date().toISOString().slice(0, 10),
        status: "active",
      },
      contracts: [],
      results: [],
    };
    setBusy(true);
    try {
      await engineCall("audipick.project_save", data);
      setName("");
      setClient("");
      setSelectedId(id);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!selectedId) return;
    // Deleting a project also drops every PDF, extraction result and review
    // mark under it, and there is no undo.
    const project = projects.find((item) => item.project.id === selectedId);
    if (
      !window.confirm(
        `确认删除项目“${project?.project.name ?? selectedId}”？\n\n该项目下的全部合同 PDF、提取结果和复核标记会一并删除，且无法恢复。`,
      )
    )
      return;
    setBusy(true);
    try {
      await engineCall("audipick.project_delete", { id: selectedId });
      setSelectedId("");
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function exportBackup() {
    const outputPath = await pickPath("save", "导出 AudiPick 迁移备份", [
      "zip",
    ]);
    if (typeof outputPath !== "string") return;
    setBusy(true);
    try {
      setResult(await engineCall("audipick.backup_export", { outputPath }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function importPdfs() {
    if (!selectedId) {
      setError("请先选择项目。");
      return;
    }
    const paths = await pickPath("files", "导入合同 PDF", ["pdf"]);
    if (!Array.isArray(paths)) return;
    setBusy(true);
    setError("");
    try {
      for (const path of paths)
        await engineCall("audipick.document_import", {
          projectId: selectedId,
          path,
        });
      const value = (await engineCall("audipick.documents", {
        projectId: selectedId,
      })) as { documents: AudiPickDocument[] };
      setDocuments(value.documents);
      setResult(value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function deleteDocument(documentId: string) {
    const document = documents.find((item) => item.id === documentId);
    if (
      !window.confirm(
        `确认删除“${document?.name ?? documentId}”？\n\n该文件的 PDF、已保存的文字层和提取结果会一并删除，且无法恢复。`,
      )
    )
      return;
    setBusy(true);
    try {
      await engineCall("audipick.document_delete", { documentId });
      setDocuments((current) =>
        current.filter((value) => value.id !== documentId),
      );
      if (selectedDocument === documentId) {
        setSelectedDocument("");
        setPdfText("");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function openDocument(id: string, startPage = 1) {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) {
      setError("PDF.js 本地组件未加载。");
      return;
    }
    setBusy(true);
    setError("");
    setSelectedDocument(id);
    try {
      pdfjs.GlobalWorkerOptions.workerSrc =
        "/audipick-pdfjs/legacy/build/pdf.worker.min.js";
      const bytes = await audipickPdfBytes(id);
      const pdf = await pdfjs.getDocument({
        data: new Uint8Array(bytes),
        cMapUrl: "/audipick-pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/audipick-pdfjs/standard_fonts/",
      }).promise;
      setPdfDocument(pdf);
      setPdfPages(pdf.numPages);
      setPdfPage(1);
      let text = "";
      let ocrPages = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let pageText = content.items
          .map((item: { str?: string }) => item.str ?? "")
          .join(" ");
        if (pageText.trim().length < 60 && configStatus.ocr?.ready) {
          const viewport = page.getViewport({ scale: 1.5 });
          const image = document.createElement("canvas");
          image.width = viewport.width;
          image.height = viewport.height;
          await page.render({
            canvasContext: image.getContext("2d"),
            viewport,
          }).promise;
          const ocr = (await engineCall("audipick.ocr", {
            documentId: id,
            page: number,
            imageBase64: image.toDataURL("image/jpeg", 0.78).split(",")[1],
          })) as { text: string };
          pageText = ocr.text;
          ocrPages += 1;
        }
        text += `---PDF第${number}页---\n${pageText}\n`;
      }
      await renderPdfPage(
        pdf,
        Math.min(pdf.numPages, Math.max(1, startPage)),
        "",
        pdfScale,
        pdfRotation,
      );
      setPdfText(text);
      setResult({
        documentId: id,
        pages: pdf.numPages,
        textLength: text.length,
        ocrPages,
        scanned: text.replace(/---PDF第\d+页---/g, "").trim().length < 60,
      });
      void suggestRule(id, text);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  /// Legacy classified every upload and asked the user to confirm the template.
  /// Without it the picker stays on 借款·限制性契约 for every document, and a
  /// wrong template silently produces meaningless extractions.
  async function suggestRule(documentId: string, text: string) {
    if (!configStatus?.llm?.ready || !text.trim()) return;
    const catalog = rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      docKind: (rule as { docKind?: string }).docKind,
    }));
    if (!catalog.length) return;
    const name = documents.find((item) => item.id === documentId)?.name ?? "";
    try {
      const value = (await engineCall("audipick.classify", {
        documentId,
        prompt: buildClassifyPrompt(catalog),
        text: classifySample(name, text),
      })) as { parsed?: unknown };
      const picked = pickClassifiedRule(
        value.parsed,
        catalog.map((rule) => rule.id),
        ruleId,
      );
      setSuggestedRule(picked.ruleId === ruleId ? undefined : picked);
    } catch {
      // Classification is advisory; a failure must never block extraction.
      setSuggestedRule(undefined);
    }
  }
  async function renderPdfPage(
    document: any,
    number: number,
    query = pdfSearch,
    scale = pdfScale,
    rotation = pdfRotation,
  ) {
    if (!document || !canvasRef.current) return;
    const page = await document.getPage(number);
    const viewport = page.getViewport({ scale, rotation });
    const canvas = canvasRef.current;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    await page.render({ canvasContext: context, viewport }).promise;
    if (query.trim()) {
      const content = await page.getTextContent();
      context.fillStyle = "rgba(255, 213, 0, .38)";
      for (const item of content.items as Array<{
        str?: string;
        transform?: number[];
        width?: number;
        height?: number;
      }>) {
        if (
          !String(item.str ?? "")
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()) ||
          !item.transform
        )
          continue;
        const x = item.transform[4] * scale;
        const height = Math.max(
          10,
          Math.abs(item.height ?? item.transform[3]) * scale,
        );
        const y = viewport.height - item.transform[5] * scale - height;
        context.fillRect(
          x,
          y,
          Math.max(12, (item.width ?? 10) * scale),
          height,
        );
      }
    }
    setPdfPage(number);
  }
  async function searchPdf() {
    if (!pdfDocument || !pdfSearch.trim()) {
      setPdfMatches([]);
      return;
    }
    const matches: number[] = [];
    for (let number = 1; number <= pdfPages; number++) {
      const page = await pdfDocument.getPage(number);
      const content = await page.getTextContent();
      if (
        content.items.some((item: { str?: string }) =>
          String(item.str ?? "")
            .toLocaleLowerCase()
            .includes(pdfSearch.trim().toLocaleLowerCase()),
        )
      )
        matches.push(number);
    }
    setPdfMatches(matches);
    if (matches[0]) await renderPdfPage(pdfDocument, matches[0], pdfSearch);
  }
  async function jumpEvidence(row: AudiPickResult) {
    const value = String(row.pages ?? row.page ?? row.evidence_page ?? "");
    const match = value.match(/\d+/);
    if (!match) return;
    // With a document bundle the evidence often sits in a supplement, not the
    // contract on screen.  Jumping to that page of whatever happens to be open
    // shows an unrelated page and looks like the model invented the citation.
    const owner = matchEvidenceDocument(
      String(row.source_documents ?? row.sourceDocuments ?? ""),
      documents.map((item) => ({ id: item.id, name: item.name })),
    );
    if (owner && owner !== selectedDocument) {
      await openDocument(owner, Math.max(1, Number(match[0])));
      return;
    }
    if (pdfDocument)
      await renderPdfPage(
        pdfDocument,
        Math.min(pdfPages, Math.max(1, Number(match[0]))),
      );
  }
  async function runOcr() {
    if (!canvasRef.current || !selectedDocument) {
      setError("请先读取 PDF。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = canvasRef.current
        .toDataURL("image/jpeg", 0.82)
        .split(",")[1];
      const value = (await engineCall("audipick.ocr", {
        documentId: selectedDocument,
        imageBase64: data,
      })) as { text: string; engine: string };
      setPdfText((current) =>
        current ? `${current}\n---OCR补充---\n${value.text}` : value.text,
      );
      setResult(value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveText() {
    if (!selectedDocument) return;
    setBusy(true);
    try {
      setResult(
        await engineCall("audipick.document_text_save", {
          documentId: selectedDocument,
          text: pdfText,
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveAssociation() {
    if (
      !selected ||
      !selectedDocument ||
      !associationTarget ||
      associationTarget === selectedDocument
    ) {
      setError("请选择不同的关联文件。");
      return;
    }
    const groups = (selected.project.relationGroups ?? []).filter(
      (group) => group.anchorFileId !== selectedDocument,
    );
    groups.push({
      id: `g_${Date.now().toString(36)}`,
      anchorFileId: selectedDocument,
      members: [{ fileId: associationTarget, role: associationRole }],
    });
    const saved = {
      ...selected,
      project: { ...selected.project, relationGroups: groups },
    };
    await engineCall("audipick.project_save", saved);
    setProjects((current) =>
      current.map((project) =>
        project.project.id === selectedId ? saved : project,
      ),
    );
    setResult({
      associationSaved: true,
      anchorFileId: selectedDocument,
      fileId: associationTarget,
      role: associationRole,
    });
  }
  async function saveCustomRule() {
    if (!customRuleName.trim() || !customRulePrompt.includes("【字段定义】")) {
      setError("自定义模板需要名称，并且提示词必须包含【字段定义】。");
      return;
    }
    const created = window.RuleEngine?.createBlankCustomRule(
      customRuleName.trim(),
      "contract",
    );
    const id = String(created?.id ?? "");
    window.RuleEngine?.updateCustomRule(id, {
      prompt: customRulePrompt,
      description: "用户自定义审计提取模板",
    });
    window.RuleEngine?.resetFieldsCache(id);
    const allSettings = await settingsGet();
    const current = (allSettings.audipick ?? {}) as Record<string, unknown>;
    await settingsSet({
      audipick: {
        ...current,
        customRules: window.RuleEngine?.getCustomRules() ?? [],
      },
    });
    setCustomRuleName("");
    setCustomRulePrompt("");
    setRuleRevision((value) => value + 1);
    setRuleId(id);
    setResult({ customRuleSaved: true, id });
  }
  /// Persist one extraction run's items against the current contract/template.
  async function saveExtractedItems(items: Array<Record<string, unknown>>) {
    if (!selected) return;
    const retained = (selected.results ?? []).filter(
      (row) =>
        !(
          row.contractId === selectedDocument &&
          row.ruleId === ruleId &&
          row.fieldSetId === activeFieldSetId
        ),
    );
    const saved = {
      ...selected,
      results: [
        ...retained,
        ...items.map((item, index) => ({
          ...item,
          id: `r_${Date.now().toString(36)}_${index}`,
          contractId: selectedDocument,
          ruleId,
          ruleVersion:
            rules.find((rule) => rule.id === ruleId)?.version ?? "1.0",
          fieldKeys: activeFieldKeys,
          fieldSetId: activeFieldSetId,
          extractAt: new Date().toISOString(),
          reviewed: false,
        })),
      ],
    };
    await engineCall("audipick.project_save", saved);
    setProjects((current) =>
      current.map((project) =>
        project.project.id === selectedId ? saved : project,
      ),
    );
  }

  /// Two-pass extraction for the revenue workpaper.
  ///
  /// The workpaper asks 43 questions across a bundle of documents. Sending all
  /// of them in one request overruns the model's stable output length, so
  /// answers come back missing or truncated with no indication anything was
  /// dropped, and nothing cross-checks a supplement against the master
  /// agreement. Gather objective facts from every document first, then answer
  /// the questions in batches with those facts in hand.
  async function extractRevenueWorkpaper(
    prompt: string,
    bundle: Array<{ name: string; text: string }>,
    context: string,
  ) {
    const rules = window.RevenueWorkpaper as any;
    const questions = (rules?.questions ?? []) as Array<{
      sheet: string;
      row: number;
      questionNo: string;
      question: string;
    }>;
    if (!questions.length) {
      setError("收入底稿问题矩阵未加载。");
      setBusy(false);
      return;
    }
    const cacheKey = extractionCacheKey(
      selectedDocument,
      ruleId,
      activeFieldSetId,
      context,
    );
    const cached = extractCache.current.get(cacheKey);
    const askOnce = (batchPrompt: string, text: string) =>
      withRetry(
        () =>
          engineCall("audipick.extract", {
            documentId: selectedDocument,
            ruleId,
            prompt: batchPrompt,
            text,
          }) as Promise<{ parsed?: Record<string, unknown> }>,
        3,
        2_000,
        (remaining) => setError(`调用失败，正在重试…还剩 ${remaining} 次`),
      );

    let responses: Array<{ parsed?: Record<string, unknown> }>;
    let facts: Array<Record<string, unknown>> = [];
    if (cached) {
      responses = cached as Array<{ parsed?: Record<string, unknown> }>;
    } else {
      // Pass 1 — objective facts per document.
      for (const [index, document] of bundle.entries()) {
        for (const chunk of splitContractText(document.text)) {
          setError(
            `正在提取资料事实：${document.name}（${index + 1}/${bundle.length}）…`,
          );
          const value = await askOnce(REVENUE_FACT_PROMPT, chunk);
          const list = Array.isArray((value.parsed as any)?.facts)
            ? ((value.parsed as any).facts as Array<Record<string, unknown>>)
            : [];
          facts.push(
            ...list.map((fact) => ({
              ...fact,
              source_document: document.name,
            })),
          );
        }
      }
      // Pass 2 — answer the workpaper in batches, with the facts in hand.
      const batches = buildRevenueQuestionBatches(questions);
      responses = [];
      for (const [index, batch] of batches.entries()) {
        const batchPrompt = buildRevenueBatchPrompt(prompt, batch, facts);
        for (const chunk of splitContractText(context)) {
          setError(`正在作答底稿问题：第 ${index + 1}/${batches.length} 批…`);
          responses.push(await askOnce(batchPrompt, chunk));
        }
      }
      extractCache.current.set(cacheKey, responses as any);
      revenueFacts.current.set(cacheKey, facts);
    }
    facts = revenueFacts.current.get(cacheKey) ?? facts;
    setError("");
    const merged = mergeRevenueAnswers(
      responses.flatMap((value) =>
        Array.isArray((value.parsed as any)?.items)
          ? ((value.parsed as any).items as Array<Record<string, unknown>>)
          : [],
      ),
    );
    const withFacts =
      typeof rules?.applySharedFacts === "function"
        ? (rules.applySharedFacts(merged, facts) as Array<
            Record<string, unknown>
          >)
        : merged;
    await saveExtractedItems(withFacts);
    setResult({
      items: withFacts.length,
      questions: questions.length,
      facts: facts.length,
    });
    setBusy(false);
  }

  async function extract() {
    if (!selectedDocument || !pdfText.trim()) {
      setError("请先读取 PDF 文字或执行 OCR。");
      return;
    }
    const prompt = `${window.RuleEngine?.getRulePrompt(ruleId) ?? ""}\n\n本次仅返回这些字段：${activeFieldKeys.join(", ")}`;
    setBusy(true);
    setError("");
    try {
      let context = pdfText;
      const bundle: Array<{ name: string; text: string }> = [
        {
          name:
            documents.find((item) => item.id === selectedDocument)?.name ??
            "主合同",
          text: pdfText,
        },
      ];
      const group = selected?.project.relationGroups?.find(
        (value) => value.anchorFileId === selectedDocument,
      );
      for (const member of group?.members ?? []) {
        const value = (await engineCall("audipick.document_text", {
          documentId: member.fileId,
        })) as { text: string };
        if (value.text) {
          context += `\n\n---关联资料：${member.role}---\n${value.text}`;
          bundle.push({
            name:
              documents.find((item) => item.id === member.fileId)?.name ??
              member.role,
            text: value.text,
          });
        }
      }
      if (ruleId === "revenue_workpaper") {
        await extractRevenueWorkpaper(prompt, bundle, context);
        return;
      }
      // A long contract sent as one request either overflows the model's
      // context or comes back truncated, and both failures look like a normal
      // "extracted N items" result — the second half of the contract is simply
      // never read.  Split it the way the legacy tool did.
      const chunks = splitContractText(context);
      // Re-running the same contract with the same template and field selection
      // costs another full round of tokens and, because the model is not
      // deterministic, returns slightly different text each time.
      const cacheKey = extractionCacheKey(
        selectedDocument,
        ruleId,
        activeFieldSetId,
        context,
      );
      const cached = extractCache.current.get(cacheKey);
      const responses: Array<{ parsed?: { items?: unknown[] } }> =
        cached ??
        (await (async () => {
          const collected: Array<{ parsed?: { items?: unknown[] } }> = [];
          for (const [index, chunk] of chunks.entries()) {
            const label =
              chunks.length > 1 ? `第 ${index + 1}/${chunks.length} 段` : "";
            if (label) setError(`合同较长，正在分段提取：${label}…`);
            collected.push(
              await withRetry(
                () =>
                  engineCall("audipick.extract", {
                    documentId: selectedDocument,
                    ruleId,
                    prompt,
                    text: chunk,
                  }) as Promise<{
                    parsed?: { items?: unknown[] };
                    content: string;
                  }>,
                3,
                2_000,
                (remaining) =>
                  setError(
                    `调用失败，正在重试${label ? `（${label}）` : ""}…还剩 ${remaining} 次`,
                  ),
              ),
            );
          }
          return collected;
        })());
      extractCache.current.set(cacheKey, responses);
      setError("");
      let items = responses
        .flatMap((value) =>
          Array.isArray(value.parsed?.items) ? value.parsed.items : [],
        )
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object"),
        );
      items = items.map((item) =>
        Object.fromEntries(
          Object.entries(item).filter(([key]) => activeFieldKeys.includes(key)),
        ),
      );
      await saveExtractedItems(items);
      setResult({ items: items.length, chunks: chunks.length });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function deepReview() {
    if (ruleId !== "revenue_workpaper" || !currentResults.length || !pdfText) {
      setError("深度复核仅适用于已有结果的收入合同审阅底稿。");
      return;
    }
    setBusy(true);
    try {
      const prompt = `${window.RuleEngine?.getRulePrompt(ruleId) ?? ""}\n\n请对现有回答进行第二轮深度复核，消除重复和冲突，保留证据页码，只返回完整JSON。`;
      const value = (await engineCall("audipick.extract", {
        documentId: selectedDocument,
        ruleId,
        prompt,
        text: `${pdfText}\n\n---现有底稿回答---\n${JSON.stringify(currentResults)}`,
      })) as { parsed?: { items?: unknown[] } };
      let items = (
        Array.isArray(value.parsed?.items) ? value.parsed.items : []
      ).filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
      );
      if (
        typeof (window.RevenueWorkpaper as any)?.normalizeResults === "function"
      )
        items = (window.RevenueWorkpaper as any).normalizeResults(items);
      if (selected) {
        const retained = (selected.results ?? []).filter(
          (row) =>
            !(
              row.contractId === selectedDocument &&
              row.ruleId === ruleId &&
              row.fieldSetId === activeFieldSetId
            ),
        );
        const saved = {
          ...selected,
          results: [
            ...retained,
            ...items.map((item, index) => ({
              ...item,
              id: `r_deep_${Date.now().toString(36)}_${index}`,
              contractId: selectedDocument,
              ruleId,
              fieldKeys: activeFieldKeys,
              fieldSetId: activeFieldSetId,
              extractAt: new Date().toISOString(),
              deepReviewed: true,
              reviewed: false,
            })),
          ],
        };
        await engineCall("audipick.project_save", saved);
        setProjects((current) =>
          current.map((project) =>
            project.project.id === selectedId ? saved : project,
          ),
        );
        setResult({ deepReview: true, rows: items.length });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function startBatch() {
    if (!documents.length) {
      setError("项目中没有可提取的 PDF。");
      return;
    }
    const prompt = `${window.RuleEngine?.getRulePrompt(ruleId) ?? ""}\n\n本次仅返回这些字段：${activeFieldKeys.join(", ")}`;
    setError("");
    setBatchPaused(false);
    try {
      const jobId = await jobStart("audipick.batch_extract", {
        ruleId,
        fieldSetId: activeFieldSetId,
        fieldKeys: activeFieldKeys,
        prompt,
        documents: documents.map((document) => ({
          id: document.id,
          name: document.name,
        })),
      });
      setBatchJob({
        jobId,
        toolId: "audipick",
        phase: "queued",
        current: 0,
        total: documents.length,
        message: "批量任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function toggleReviewed(id: string) {
    if (!selected) return;
    const saved = {
      ...selected,
      results: (selected.results ?? []).map((row) =>
        row.id === id ? { ...row, reviewed: !row.reviewed } : row,
      ),
    };
    await engineCall("audipick.project_save", saved);
    setProjects((current) =>
      current.map((project) =>
        project.project.id === selectedId ? saved : project,
      ),
    );
  }
  async function exportResults() {
    const rows = (selected?.results ?? []).filter(
      (row: any) =>
        row?.contractId === selectedDocument && row?.ruleId === ruleId,
    );
    if (!rows.length) {
      setError("当前合同和模板还没有提取结果。");
      return;
    }
    const output = await pickPath(
      "save",
      ruleId === "revenue_workpaper"
        ? "保存收入底稿填列清单"
        : "保存 AudiPick 底稿",
      ["xlsx"],
    );
    if (typeof output !== "string") return;
    setBusy(true);
    try {
      // The revenue rules build the legacy 25-column checklist, including which
      // worksheet, row and D/E/F cell each answer belongs in.  Exporting the raw
      // result keys instead left the user to locate all 43 questions by hand.
      const checklist =
        ruleId === "revenue_workpaper" &&
        typeof (window.RevenueWorkpaper as any)?.buildChecklistRows ===
          "function"
          ? ((window.RevenueWorkpaper as any).buildChecklistRows(
              documents.find((item) => item.id === selectedDocument)
                ? {
                    file: documents.find((item) => item.id === selectedDocument)
                      ?.name,
                  }
                : null,
              rows,
            ) as Array<Record<string, unknown>>)
          : undefined;
      setResult(
        await engineCall("audipick.export", {
          ruleId,
          results: checklist ?? rows,
          columns: checklist?.length ? Object.keys(checklist[0]) : undefined,
          outputPath: output,
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="AudiPick Tauri 迁移"
        title={tool.name}
        detail="项目、PDF、本地预览和13个审计模板已接入；扫描页走OCR，文字层直接使用工具箱全局LLM。"
      />
      <div className="workspace">
        <section className="form-card">
          <div className="section-title">
            <h2>项目</h2>
            <span className="pill preview">迁移进行中</span>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>项目名称</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>客户名称</span>
              <input
                value={client}
                onChange={(e) => setClient(e.target.value)}
              />
            </label>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void create()}
            >
              新建项目
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void refresh()}
            >
              刷新
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void exportBackup()}
            >
              导出迁移备份
            </button>
          </div>
          <div className="list-card">
            {projects.map((value) => (
              <button
                key={value.project.id}
                className={
                  value.project.id === selectedId ? "secondary" : "browse"
                }
                onClick={() => setSelectedId(value.project.id)}
              >
                {value.project.name}
                {value.project.client ? ` · ${value.project.client}` : ""}
              </button>
            ))}
          </div>
        </section>
        <section className="form-card">
          <div className="section-title">
            <h2>{selected?.project.name ?? "合同文件"}</h2>
            <span>{documents.length} 份 PDF</span>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={!selectedId || busy}
              onClick={() => void importPdfs()}
            >
              导入 PDF
            </button>
            <button
              className="secondary"
              disabled={!selectedId || busy}
              onClick={() => void remove()}
            >
              删除项目
            </button>
          </div>
          {documents.map((value) => (
            <div className="task-row" key={value.id}>
              <div>
                <strong>{value.name}</strong>
                <p>
                  {Math.ceil(value.size / 1024)} KB ·{" "}
                  {value.sha256.slice(0, 12)}
                </p>
              </div>
              <button
                className={
                  selectedDocument === value.id ? "primary" : "secondary"
                }
                onClick={() => void openDocument(value.id)}
              >
                读取/预览
              </button>
              <button
                className="secondary"
                onClick={() => void deleteDocument(value.id)}
              >
                删除
              </button>
            </div>
          ))}
          {error && <div className="error-box">{error}</div>}
        </section>
        <section className="form-card">
          <div className="section-title">
            <h2>模板与字段</h2>
            <span
              className={`pill ${configStatus.llm?.ready ? "ready" : "preview"}`}
            >
              LLM {configStatus.llm?.ready ? "已就绪" : "未配置"}
            </span>
          </div>
          <label className="field">
            <span>提取模板</span>
            <select value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
              {rules.map((rule) => (
                <option value={rule.id} key={rule.id}>
                  {rule.name}
                </option>
              ))}
            </select>
          </label>
          {suggestedRule && (
            <div className="warning-box">
              <strong>
                根据文档内容建议使用「
                {rules.find((rule) => rule.id === suggestedRule.ruleId)?.name ??
                  suggestedRule.ruleId}
                」
                {suggestedRule.docLabel
                  ? `（识别为${suggestedRule.docLabel}）`
                  : ""}
                {suggestedRule.confidence === "high"
                  ? "，把握较大"
                  : suggestedRule.confidence === "medium"
                    ? "，把握一般"
                    : "，把握较低"}
              </strong>
              {suggestedRule.reason && <p>{suggestedRule.reason}</p>}
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() => {
                    setRuleId(suggestedRule.ruleId);
                    setSuggestedRule(undefined);
                  }}
                >
                  采用建议模板
                </button>
                <button
                  className="browse"
                  onClick={() => setSuggestedRule(undefined)}
                >
                  保留当前模板
                </button>
              </div>
            </div>
          )}
          <div className="chip-list">
            {fields.map((field) => (
              <label className="pill ready" key={field.key}>
                <input
                  type="checkbox"
                  checked={activeFieldKeys.includes(field.key)}
                  onChange={(event) =>
                    setSelectedFieldKeys((current) =>
                      event.target.checked
                        ? [...new Set([...current, field.key])]
                        : current.filter((key) => key !== field.key),
                    )
                  }
                />
                {field.label}
              </label>
            ))}
          </div>
          <small>{rules.find((rule) => rule.id === ruleId)?.description}</small>
          <h3>关联资料</h3>
          <div className="form-grid">
            <label className="field">
              <span>关联文件</span>
              <select
                value={associationTarget}
                onChange={(e) => setAssociationTarget(e.target.value)}
              >
                <option value="">不关联</option>
                {documents
                  .filter((value) => value.id !== selectedDocument)
                  .map((value) => (
                    <option value={value.id} key={value.id}>
                      {value.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>资料角色</span>
              <select
                value={associationRole}
                onChange={(e) => setAssociationRole(e.target.value)}
              >
                {[
                  "补充协议/变更",
                  "框架协议",
                  "订单/采购订单",
                  "技术附件",
                  "信用资料",
                  "验收/交付资料",
                  "其他支持文件",
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>
          <button
            className="secondary"
            disabled={!selectedDocument || !associationTarget}
            onClick={() => void saveAssociation()}
          >
            保存关联
          </button>
          <details>
            <summary>新建自定义模板</summary>
            <div className="form-grid">
              <label className="field">
                <span>模板名称</span>
                <input
                  value={customRuleName}
                  onChange={(e) => setCustomRuleName(e.target.value)}
                />
              </label>
              <label className="field wide">
                <span>提示词</span>
                <textarea
                  value={customRulePrompt}
                  onChange={(e) => setCustomRulePrompt(e.target.value)}
                  placeholder={
                    "【字段定义】\npage: 页码\nexcerpt: 原文摘录\n\n【输出要求】\n只输出JSON"
                  }
                />
              </label>
            </div>
            <button className="secondary" onClick={() => void saveCustomRule()}>
              保存自定义模板
            </button>
          </details>
          <div className="actions">
            <button
              className="secondary"
              disabled={busy || !selectedDocument}
              onClick={() => void runOcr()}
            >
              OCR 当前页
            </button>
            <button
              className="secondary"
              disabled={busy || !pdfText}
              onClick={() => void saveText()}
            >
              保存文字
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !configStatus.llm?.ready ||
                !pdfText ||
                !activeFieldKeys.length
              }
              onClick={() => void extract()}
            >
              AI 提取并保存
            </button>
            <button
              className="secondary"
              disabled={busy || !selectedDocument}
              onClick={() => void exportResults()}
            >
              导出底稿
            </button>
            {ruleId === "revenue_workpaper" && (
              <button
                className="secondary"
                disabled={busy || !currentResults.length}
                onClick={() => void deepReview()}
              >
                深度复核
              </button>
            )}
            {!batchJob ||
            ["completed", "failed", "cancelled"].includes(batchJob.phase) ? (
              <button
                className="primary"
                disabled={
                  !configStatus.llm?.ready ||
                  !documents.length ||
                  !activeFieldKeys.length
                }
                onClick={() => void startBatch()}
              >
                批量提取
              </button>
            ) : (
              <>
                <button
                  className="secondary"
                  onClick={() => {
                    void jobPause(batchJob.jobId, !batchPaused);
                    setBatchPaused(!batchPaused);
                  }}
                >
                  {batchPaused ? "继续" : "暂停"}
                </button>
                <button
                  className="secondary"
                  onClick={() => void jobCancel(batchJob.jobId)}
                >
                  停止
                </button>
              </>
            )}
          </div>
          {batchJob && (
            <div className={`job-banner ${batchJob.severity}`}>
              <strong>{batchJob.message}</strong>
              <progress
                max={Math.max(batchJob.total, 1)}
                value={batchJob.current}
              />
            </div>
          )}
          {/* The worker reports every document's outcome; without this a batch
              where a third of the files failed still ended on a plain
              "完成" and the missed contracts were never noticed. */}
          {batchFailures.length > 0 && (
            <div className="error-box">
              <strong>
                批量提取失败 {batchFailures.length} 份（成功 {batchSuccessCount}{" "}
                份）
              </strong>
              {batchFailures.slice(0, 10).map((item, index) => (
                <p key={String(item.id ?? index)}>
                  {String(item.name ?? item.id ?? "")}：
                  {String(item.error?.userMessage ?? "提取失败")}
                </p>
              ))}
              {batchFailures.length > 10 && (
                <p>另有 {batchFailures.length - 10} 份未显示。</p>
              )}
            </div>
          )}
        </section>
        <section className="result-card">
          <h2>PDF、文字层与结果</h2>
          {pdfDocument && (
            <>
              <div className="pdf-toolbar">
                <button
                  className="secondary"
                  disabled={pdfPage <= 1}
                  onClick={() => void renderPdfPage(pdfDocument, pdfPage - 1)}
                >
                  上一页
                </button>
                <span>
                  {pdfPage} / {pdfPages}
                </span>
                <button
                  className="secondary"
                  disabled={pdfPage >= pdfPages}
                  onClick={() => void renderPdfPage(pdfDocument, pdfPage + 1)}
                >
                  下一页
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    const value = Math.max(0.6, pdfScale - 0.15);
                    setPdfScale(value);
                    void renderPdfPage(
                      pdfDocument,
                      pdfPage,
                      pdfSearch,
                      value,
                      pdfRotation,
                    );
                  }}
                >
                  缩小
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    const value = Math.min(2.5, pdfScale + 0.15);
                    setPdfScale(value);
                    void renderPdfPage(
                      pdfDocument,
                      pdfPage,
                      pdfSearch,
                      value,
                      pdfRotation,
                    );
                  }}
                >
                  放大
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    const value = (pdfRotation + 90) % 360;
                    setPdfRotation(value);
                    void renderPdfPage(
                      pdfDocument,
                      pdfPage,
                      pdfSearch,
                      pdfScale,
                      value,
                    );
                  }}
                >
                  旋转
                </button>
              </div>
              <div className="input-with-button">
                <input
                  value={pdfSearch}
                  onChange={(e) => setPdfSearch(e.target.value)}
                  placeholder="搜索 PDF 原文"
                />
                <button className="browse" onClick={() => void searchPdf()}>
                  搜索
                </button>
              </div>
              {pdfSearch && (
                <small>
                  命中页：{pdfMatches.length ? pdfMatches.join("、") : "无"}
                </small>
              )}
            </>
          )}
          <canvas ref={canvasRef} className="pdf-canvas" />
          {pdfText && (
            <textarea
              className="pdf-text"
              value={pdfText}
              onChange={(e) => setPdfText(e.target.value)}
            />
          )}{" "}
          {result ? (
            <ResultView value={result} />
          ) : (
            <div className="empty">选择合同后读取本地PDF文字层。</div>
          )}
          {revenueMissingTasks.length > 0 && (
            <div className="error-box">
              <strong>收入底稿待补资料（{revenueMissingTasks.length}）</strong>
              {/* The rule module reports `text` / `questionNos` / `blocking`.
                  Reading `title` first meant every row fell through to the
                  placeholder, so the panel never said what was missing. */}
              {revenueMissingTasks
                .slice(0, 8)
                .map((task: any, index: number) => (
                  <p key={String(task.id ?? index)}>
                    {task.blocking ? "【阻塞】" : ""}
                    {String(
                      task.text ??
                        task.title ??
                        task.question ??
                        task.message ??
                        "需要补充支持资料",
                    )}
                    {Array.isArray(task.questionNos) && task.questionNos.length
                      ? `（涉及第 ${task.questionNos.join("、")} 题）`
                      : ""}
                  </p>
                ))}
            </div>
          )}
          {currentResults.length > 0 && (
            <>
              <h3>当前底稿结果（{currentResults.length}）</h3>
              {currentResults.map((row, index) => (
                <div className="task-row" key={String(row.id ?? index)}>
                  <div>
                    <strong>
                      {String(
                        row.title ??
                          row.questionNo ??
                          row.category ??
                          `结果 ${index + 1}`,
                      )}
                    </strong>
                    <p>
                      {String(
                        row.excerpt ?? row.answer ?? row.summary ?? "",
                      ).slice(0, 180)}
                    </p>
                  </div>
                  <button
                    className={row.reviewed ? "primary" : "secondary"}
                    onClick={() => void toggleReviewed(String(row.id))}
                  >
                    {row.reviewed ? "已复核" : "标记复核"}
                  </button>
                  <button
                    className="secondary"
                    onClick={() => void jumpEvidence(row)}
                  >
                    证据页
                  </button>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </>
  );
}

type RollSubject = {
  code: string;
  name: string;
  templateFile: string;
};
type RollCompany = {
  id: string;
  name: string;
  bs_date: string;
  functional_currency: string;
  accounting_standard: string;
  pm: string;
  te: string;
  sad: string;
  prior_path: string;
  output_dir: string;
  subjects: string[];
  roll_wording: boolean;
  generate_summary: boolean;
  cra_text: string;
  cra_table_records: Array<Record<string, unknown>>;
  cra_header_preference: string;
  apply_cra: boolean;
  cra_skip_confirmed: boolean;
  llm_enhanced: boolean;
  llm_wording_revision: boolean;
  status?: string;
  generated?: number;
  failed?: number;
  last_message?: string;
};
type RollProject = {
  id: string;
  project_name: string;
  project_year: string;
  companies: RollCompany[];
  updated_at?: string;
};
let rollForwardInMemoryCache:
  | {
      projects: RollProject[];
      templateDir: string;
      pmtePath: string;
      projectIndex: number;
      companyIndex: number;
    }
  | undefined;

const newRollCompany = (name = "A公司"): RollCompany => ({
  id: crypto.randomUUID(),
  name,
  bs_date: "",
  functional_currency: "人民币",
  accounting_standard: "企业会计准则",
  pm: "",
  te: "",
  sad: "",
  prior_path: "",
  output_dir: "",
  subjects: [],
  roll_wording: false,
  generate_summary: true,
  cra_text: "",
  cra_table_records: [],
  cra_header_preference: "",
  apply_cra: false,
  cra_skip_confirmed: false,
  llm_enhanced: false,
  llm_wording_revision: false,
  status: "未处理",
  generated: 0,
  failed: 0,
  last_message: "",
});

function normalizeRollProjects(value: unknown): RollProject[] {
  const root =
    value && typeof value === "object"
      ? (value as { projects?: unknown }).projects
      : undefined;
  if (!Array.isArray(root)) return [];
  return root.map((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const companies = Array.isArray(row.companies) ? row.companies : [];
    return {
      id: String(row.id || crypto.randomUUID()),
      project_name: String(row.project_name || `项目${index + 1}`),
      project_year: String(row.project_year || ""),
      updated_at: String(row.updated_at || ""),
      companies: companies.map((entry, companyIndex) => {
        const company = (entry ?? {}) as Record<string, unknown>;
        return {
          ...newRollCompany(String(company.name || `公司${companyIndex + 1}`)),
          ...company,
          id: String(company.id || crypto.randomUUID()),
          subjects: Array.isArray(company.subjects)
            ? company.subjects.map(String)
            : [],
          cra_table_records: Array.isArray(company.cra_table_records)
            ? (company.cra_table_records as Array<Record<string, unknown>>)
            : [],
          cra_canvas_token: undefined,
        } as RollCompany;
      }),
    };
  });
}

function RollForwardPage({ tool }: { tool: ToolManifest }) {
  const [subjects, setSubjects] = useState<RollSubject[]>([]);
  const [projects, setProjects] = useState<RollProject[]>([]);
  const [projectIndex, setProjectIndex] = useState(0);
  const [companyIndex, setCompanyIndex] = useState(0);
  const [templateDir, setTemplateDir] = useState("");
  const [pmtePath, setPmtePath] = useState("");
  const [craHeaderOptions, setCraHeaderOptions] = useState<string[]>([]);
  const [craSearch, setCraSearch] = useState("");
  const [craStatusFilter, setCraStatusFilter] = useState("all");
  const [craSubjectFilter, setCraSubjectFilter] = useState("all");
  const [craExceptionOnly, setCraExceptionOnly] = useState(false);
  const [rollPreferences, setRollPreferences] = useState({
    defaultPriorDir: "",
    defaultOutputDir: "",
    openOutputAfterSuccess: false,
    rememberLastProject: true,
  });
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [job, setJob] = useState<JobEvent>();
  const [validation, setValidation] = useState<unknown>();
  const [error, setError] = useState("");
  const jobCompanyRef = useRef<
    { projectId: string; companyId?: string } | undefined
  >(undefined);
  const loadedRef = useRef(false);
  const preferencesRef = useRef(rollPreferences);
  const project = projects[projectIndex];
  const company = project?.companies[companyIndex];

  useEffect(() => {
    void Promise.all([engineCall("roll_forward.catalog", {}), settingsGet()])
      .then(([catalog, settings]) => {
        setSubjects((catalog as { subjects?: RollSubject[] }).subjects ?? []);
        const defaults = (settings.rollForward ?? {}) as Record<
          string,
          unknown
        >;
        const cache = rollForwardInMemoryCache;
        const loaded =
          cache?.projects ??
          normalizeRollProjects(settings.rollForwardProjects);
        setProjects(loaded);
        setTemplateDir(
          cache?.templateDir ??
            String(defaults.template_dir || defaults.templateDir || ""),
        );
        setPmtePath(
          cache?.pmtePath ??
            String(defaults.pmte_path || defaults.pmtePath || ""),
        );
        const rememberLastProject = Boolean(
          defaults.remember_last_project ??
          defaults.rememberLastProject ??
          true,
        );
        const requestedProjectIndex =
          cache?.projectIndex ??
          (rememberLastProject
            ? Number(
                defaults.last_project_index ?? defaults.lastProjectIndex ?? 0,
              )
            : 0);
        const safeProjectIndex = Math.max(
          0,
          Math.min(
            Number.isFinite(requestedProjectIndex) ? requestedProjectIndex : 0,
            Math.max(loaded.length - 1, 0),
          ),
        );
        const requestedCompanyIndex =
          cache?.companyIndex ??
          (rememberLastProject
            ? Number(
                defaults.last_company_index ?? defaults.lastCompanyIndex ?? 0,
              )
            : 0);
        const safeCompanyIndex = Math.max(
          0,
          Math.min(
            Number.isFinite(requestedCompanyIndex) ? requestedCompanyIndex : 0,
            Math.max((loaded[safeProjectIndex]?.companies.length ?? 1) - 1, 0),
          ),
        );
        setProjectIndex(safeProjectIndex);
        setCompanyIndex(safeCompanyIndex);
        const loadedPreferences = {
          defaultPriorDir: String(
            defaults.default_prior_dir || defaults.defaultPriorDir || "",
          ),
          defaultOutputDir: String(
            defaults.default_output_dir || defaults.defaultOutputDir || "",
          ),
          openOutputAfterSuccess: Boolean(
            defaults.open_output_after_success ??
            defaults.openOutputAfterSuccess ??
            false,
          ),
          rememberLastProject,
        };
        setRollPreferences(loadedPreferences);
        preferencesRef.current = loadedPreferences;
        loadedRef.current = true;
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    preferencesRef.current = rollPreferences;
  }, [rollPreferences]);
  useEffect(() => {
    if (!loadedRef.current) return;
    rollForwardInMemoryCache = {
      projects,
      templateDir,
      pmtePath,
      projectIndex,
      companyIndex,
    };
    const timer = window.setTimeout(() => {
      void saveProjects().catch((e) => setError(errorText(e)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    projects,
    templateDir,
    pmtePath,
    projectIndex,
    companyIndex,
    rollPreferences,
  ]);
  useEffect(() => {
    let off: () => void = () => {};
    void listenJobEvents((event) => {
      if (event.toolId !== "audit_roll_forward") return;
      setJob(event);
      if (event.result) setValidation(event.result);
      setBusy(!["completed", "failed", "cancelled"].includes(event.phase));
      if (["completed", "failed", "cancelled"].includes(event.phase)) {
        setPaused(false);
        const target = jobCompanyRef.current;
        if (target) {
          const status =
            event.phase === "completed"
              ? "已完成"
              : event.phase === "cancelled"
                ? "已终止"
                : "部分失败";
          setProjects((current) =>
            current.map((p) =>
              p.id !== target.projectId
                ? p
                : {
                    ...p,
                    companies: p.companies.map((c) => {
                      if (target.companyId && c.id !== target.companyId)
                        return c;
                      const root = (event.result ?? {}) as Record<
                        string,
                        unknown
                      >;
                      const directRows = Array.isArray(root.results)
                        ? root.results
                        : [];
                      const companyRows = Array.isArray(root.companies)
                        ? (root.companies.find(
                            (row) =>
                              String(
                                (row as Record<string, unknown>).companyName ??
                                  "",
                              ) === c.name,
                          ) as Record<string, unknown> | undefined)
                        : undefined;
                      const rows = directRows.length
                        ? directRows
                        : Array.isArray(companyRows?.results)
                          ? companyRows.results
                          : [];
                      const generated = rows.filter((row) =>
                        Boolean((row as Record<string, unknown>).success),
                      ).length;
                      const failed = rows.length - generated;
                      return {
                        ...c,
                        status,
                        generated,
                        failed,
                        last_message: rows.length
                          ? `${generated}/${rows.length}`
                          : event.message,
                      };
                    }),
                  },
            ),
          );
          if (
            event.phase === "completed" &&
            preferencesRef.current.openOutputAfterSuccess &&
            event.outputPaths[0]
          ) {
            void openOutput(event.outputPaths[0]);
          }
        }
      }
    }).then((value) => {
      off = value;
    });
    return () => off();
  }, []);

  function updateCompany(patch: Partial<RollCompany>) {
    setProjects((current) =>
      current.map((p, pi) =>
        pi !== projectIndex
          ? p
          : {
              ...p,
              updated_at: new Date().toISOString(),
              companies: p.companies.map((c, ci) =>
                ci === companyIndex ? { ...c, ...patch } : c,
              ),
            },
      ),
    );
  }
  async function saveProjects(next = projects) {
    await settingsSet({
      rollForwardProjects: { version: 2, projects: next },
      rollForward: {
        templateDir,
        pmtePath,
        defaultPriorDir: rollPreferences.defaultPriorDir,
        defaultOutputDir: rollPreferences.defaultOutputDir,
        openOutputAfterSuccess: rollPreferences.openOutputAfterSuccess,
        rememberLastProject: rollPreferences.rememberLastProject,
        lastProjectIndex: projectIndex,
        lastCompanyIndex: companyIndex,
      },
    });
  }
  function addProject() {
    const firstCompany = {
      ...newRollCompany(),
      prior_path: rollPreferences.defaultPriorDir,
      output_dir: rollPreferences.defaultOutputDir,
    };
    const next: RollProject[] = [
      ...projects,
      {
        id: crypto.randomUUID(),
        project_name: `项目${projects.length + 1}`,
        project_year: String(new Date().getFullYear()),
        companies: [firstCompany],
      },
    ];
    setProjects(next);
    setProjectIndex(next.length - 1);
    setCompanyIndex(0);
    void saveProjects(next);
  }
  function addCompany() {
    if (!project) return;
    const next = projects.map((p, index) =>
      index === projectIndex
        ? {
            ...p,
            companies: [
              ...p.companies,
              {
                ...newRollCompany(`公司${p.companies.length + 1}`),
                prior_path: rollPreferences.defaultPriorDir,
                output_dir: rollPreferences.defaultOutputDir,
              },
            ],
          }
        : p,
    );
    setProjects(next);
    setCompanyIndex(project.companies.length);
    void saveProjects(next);
  }
  function deleteProject() {
    if (projects.length <= 1) {
      setError("工作台中至少保留一个项目。");
      return;
    }
    if (
      !project ||
      !window.confirm(`确认删除项目“${project.project_name}”及其公司配置？`)
    )
      return;
    const next = projects.filter((_, index) => index !== projectIndex);
    setProjects(next);
    setProjectIndex(Math.max(0, Math.min(projectIndex, next.length - 1)));
    setCompanyIndex(0);
    void saveProjects(next);
  }
  function deleteCompany() {
    if ((project?.companies.length ?? 0) <= 1) {
      setError("项目中至少保留一个公司。");
      return;
    }
    if (
      !project ||
      !company ||
      !window.confirm(`确认删除公司“${company.name}”？`)
    )
      return;
    const next = projects.map((p, index) =>
      index !== projectIndex
        ? p
        : {
            ...p,
            companies: p.companies.filter((_, ci) => ci !== companyIndex),
          },
    );
    setProjects(next);
    setCompanyIndex(
      Math.max(0, Math.min(companyIndex, project.companies.length - 2)),
    );
    void saveProjects(next);
  }
  function paramsFor(target?: RollCompany) {
    if (!target) return {};
    return {
      templateDir,
      priorDir: target.prior_path,
      pmtePath,
      outputDir: target.output_dir,
      subjectCodes: target.subjects,
      companyName: target.name,
      bsDate: target.bs_date,
      functionalCurrency: target.functional_currency,
      accountingStandard: target.accounting_standard,
      pmValue: target.pm,
      teValue: target.te,
      sadValue: target.sad,
      rollForwardWording: target.roll_wording,
      generateSummary: target.generate_summary,
      craRecords: rollForwardCraWriteRecords(
        target.cra_table_records,
        target.apply_cra,
      ),
      llmEnhanced: target.llm_enhanced,
      llmWordingRevision: target.llm_wording_revision,
    };
  }
  const params = () => paramsFor(company);
  async function validate() {
    if (!company) return;
    setError("");
    try {
      const result = await engineCall("roll_forward.validate", params());
      setValidation(result);
      await saveProjects();
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function parseCra() {
    if (!company?.cra_text.trim()) return;
    setError("");
    try {
      const result = (await engineCall("roll_forward.cra.parse", {
        text: company.cra_text,
        subjectCodes: company.subjects,
        headerPreference: company.cra_header_preference,
      })) as {
        records?: Array<Record<string, unknown>>;
        headerOptions?: string[];
      };
      setCraHeaderOptions(result.headerOptions ?? []);
      // The engine reports the per-row decision as `match_status` and never
      // emits `apply`.  Without seeding it here every row's checkbox stayed
      // unchecked next to the words "将写入", the filtered list handed to the
      // engine came back empty, and the run reported success with no CRA
      // written to the workbook at all.
      updateCompany({
        cra_table_records: (result.records ?? []).map((record) => ({
          ...record,
          apply: record.apply ?? String(record.match_status ?? "") === "将写入",
        })),
        apply_cra: Boolean(result.records?.length),
        cra_skip_confirmed: false,
      });
      setValidation(result);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function detectSubjects() {
    if (!company?.prior_path.trim()) return;
    setError("");
    try {
      const result = (await engineCall("roll_forward.detect_subjects", {
        priorPath: company.prior_path,
      })) as { subjects?: string[]; message?: string };
      updateCompany({ subjects: result.subjects ?? [] });
      setValidation(result);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function exportProject() {
    if (!project) return;
    const outputPath = await pickPath("save", "导出 Audit Roll Forward 项目", [
      "auditproj",
      "json",
    ]);
    if (typeof outputPath !== "string") return;
    try {
      const result = await engineCall("roll_forward.project_export", {
        outputPath,
        project,
      });
      setValidation(result);
      await saveProjects();
    } catch (e) {
      setError(errorText(e));
    }
  }
  function updateCraRecord(index: number, patch: Record<string, unknown>) {
    updateCompany({
      cra_table_records: (company?.cra_table_records ?? []).map(
        (record, row) => (row === index ? { ...record, ...patch } : record),
      ),
    });
  }
  async function start() {
    if (!company) return;
    if (!ensureCraReady([company])) return;
    setError("");
    setBusy(true);
    try {
      await saveProjects();
      const check = (await engineCall("roll_forward.validate", params())) as {
        valid?: boolean;
      };
      setValidation(check);
      if (!check.valid)
        throw new Error("运行前检查未通过，请核对下方逐科目结果。");
      const jobId = await jobStart("roll_forward.process", params());
      jobCompanyRef.current = { projectId: project.id, companyId: company.id };
      setJob({
        jobId,
        toolId: "audit_roll_forward",
        phase: "queued",
        current: 0,
        total: Math.max(company.subjects.length, 1),
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  async function startAllCompanies() {
    if (!project) return;
    if (!ensureCraReady(project.companies)) return;
    setError("");
    setBusy(true);
    try {
      await saveProjects();
      for (const target of project.companies) {
        const check = (await engineCall(
          "roll_forward.validate",
          paramsFor(target),
        )) as { valid?: boolean };
        if (!check.valid)
          throw new Error(`${target.name} 的运行前检查未通过。`);
      }
      const jobId = await jobStart("roll_forward.process_companies", {
        templateDir,
        pmtePath,
        companies: project.companies.map(paramsFor),
      });
      jobCompanyRef.current = { projectId: project.id };
      setJob({
        jobId,
        toolId: "audit_roll_forward",
        phase: "queued",
        current: 0,
        total: project.companies.length,
        message: "多公司任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  function ensureCraReady(targets: RollCompany[]) {
    const unresolved = targets.filter((target) => {
      if (target.cra_skip_confirmed) return false;
      return !(target.cra_table_records.length && target.apply_cra);
    });
    if (!unresolved.length) return true;
    const detail = unresolved
      .map((target) => {
        if (target.cra_text.trim() && !target.cra_table_records.length)
          return `${target.name}：CRA 已粘贴但尚未解析`;
        if (target.cra_table_records.length && !target.apply_cra)
          return `${target.name}：CRA 已解析但未启用写入`;
        return `${target.name}：尚未提供 CRA`;
      })
      .join("\n");
    const confirmed = window.confirm(
      `执行前 CRA 确认\n\n${detail}\n\n确定本次不使用这些 CRA 并继续吗？`,
    );
    if (!confirmed)
      setError("已取消执行。请解析并启用 CRA，或明确选择本次不使用 CRA。");
    if (confirmed) {
      setProjects((current) =>
        current.map((p) =>
          p.id !== project?.id
            ? p
            : {
                ...p,
                companies: p.companies.map((c) =>
                  unresolved.some((row) => row.id === c.id)
                    ? { ...c, cra_skip_confirmed: true }
                    : c,
                ),
              },
        ),
      );
    }
    return confirmed;
  }
  if (!projects.length) {
    return (
      <>
        <PageHeader
          eyebrow="完整迁移工具"
          title={tool.name}
          detail="项目、公司、科目、CRA 与处理任务统一保存在工具箱中。"
        />
        <section className="list-card">
          <div className="empty">还没有 Roll Forward 项目。</div>
          <div className="actions">
            <button className="primary" onClick={addProject}>
              新建项目
            </button>
          </div>
        </section>
      </>
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="完整迁移工具"
        title={tool.name}
        detail="Rust 原生结转内核统一管理项目、CRA、进度、安全暂停与取消。"
      />
      {error && <div className="error-box">{error}</div>}
      <div className="merger-layout">
        <section className="form-card">
          <div className="section-title">
            <h2>1. 项目与公司</h2>
            <div className="actions compact-actions">
              <button className="secondary" onClick={addProject}>
                新建项目
              </button>
              <button className="danger" onClick={deleteProject}>
                删除项目
              </button>
            </div>
          </div>
          <label className="field">
            <span>项目</span>
            <select
              value={projectIndex}
              onChange={(e) => {
                setProjectIndex(Number(e.target.value));
                setCompanyIndex(0);
              }}
            >
              {projects.map((p, index) => (
                <option key={p.id} value={index}>
                  {p.project_name} · {p.project_year}
                </option>
              ))}
            </select>
          </label>
          <div className="field-grid">
            <label className="field">
              <span>项目名称</span>
              <input
                value={project.project_name}
                onChange={(e) =>
                  setProjects((current) =>
                    current.map((p, index) =>
                      index === projectIndex
                        ? { ...p, project_name: e.target.value }
                        : p,
                    ),
                  )
                }
              />
            </label>
            <label className="field">
              <span>年度</span>
              <input
                value={project.project_year}
                onChange={(e) =>
                  setProjects((current) =>
                    current.map((p, index) =>
                      index === projectIndex
                        ? { ...p, project_year: e.target.value }
                        : p,
                    ),
                  )
                }
              />
            </label>
          </div>
          <label className="field">
            <span>公司</span>
            <div className="input-with-button">
              <select
                value={companyIndex}
                onChange={(e) => setCompanyIndex(Number(e.target.value))}
              >
                {project.companies.map((c, index) => (
                  <option key={c.id} value={index}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button className="browse" onClick={addCompany}>
                添加公司
              </button>
              <button className="danger" onClick={deleteCompany}>
                删除公司
              </button>
            </div>
          </label>
          {company && (
            <>
              <div className="metrics roll-company-metrics">
                <div>
                  <span>已选科目</span>
                  <strong>{company.subjects.length}</strong>
                </div>
                <div>
                  <span>状态</span>
                  <strong>{company.status || "未处理"}</strong>
                </div>
                <div>
                  <span>已生成</span>
                  <strong>{company.generated ?? 0}</strong>
                </div>
                <div>
                  <span>失败</span>
                  <strong>{company.failed ?? 0}</strong>
                </div>
              </div>
              <label className="field">
                <span>公司名称</span>
                <input
                  value={company.name}
                  onChange={(e) => updateCompany({ name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>资产负债表日</span>
                <input
                  value={company.bs_date}
                  placeholder="例如：2026/12/31 或 20261231"
                  onChange={(e) => updateCompany({ bs_date: e.target.value })}
                />
              </label>
              <div className="field-grid">
                <label className="field">
                  <span>记账本位币</span>
                  <input
                    value={company.functional_currency}
                    onChange={(e) =>
                      updateCompany({ functional_currency: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>适用会计准则</span>
                  <input
                    value={company.accounting_standard}
                    onChange={(e) =>
                      updateCompany({ accounting_standard: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>PM</span>
                  <input
                    value={company.pm}
                    onChange={(e) => updateCompany({ pm: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>TE</span>
                  <input
                    value={company.te}
                    onChange={(e) => updateCompany({ te: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>SAD</span>
                  <input
                    value={company.sad}
                    onChange={(e) => updateCompany({ sad: e.target.value })}
                  />
                </label>
              </div>
            </>
          )}
        </section>
        <section className="form-card">
          <h2>2. 文件与科目</h2>
          <PathField
            label="标准模板目录"
            value={templateDir}
            onChange={setTemplateDir}
            kind="folder"
          />
          <PathField
            label="上年底稿目录或单个 XLSX"
            value={company?.prior_path ?? ""}
            onChange={(value) => updateCompany({ prior_path: value })}
            kind="folder"
            allowFile
          />
          <div className="actions">
            <button
              className="secondary"
              disabled={!company?.prior_path.trim()}
              onClick={() => void detectSubjects()}
            >
              从文件名自动识别科目
            </button>
            <button
              className="ghost"
              onClick={() => updateCompany({ prior_path: "", subjects: [] })}
            >
              清空上年底稿
            </button>
          </div>
          <PathField
            label="输出目录"
            value={company?.output_dir ?? ""}
            onChange={(value) => updateCompany({ output_dir: value })}
            kind="folder"
          />
          <PathField
            label="PMTE/CRA 文件（可选）"
            value={pmtePath}
            onChange={setPmtePath}
            kind="file"
          />
          <details className="roll-preferences">
            <summary>默认路径与完成行为</summary>
            <PathField
              label="新公司默认上年底稿目录"
              value={rollPreferences.defaultPriorDir}
              onChange={(value) =>
                setRollPreferences((current) => ({
                  ...current,
                  defaultPriorDir: value,
                }))
              }
              kind="folder"
            />
            <PathField
              label="新公司默认输出目录"
              value={rollPreferences.defaultOutputDir}
              onChange={(value) =>
                setRollPreferences((current) => ({
                  ...current,
                  defaultOutputDir: value,
                }))
              }
              kind="folder"
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={rollPreferences.rememberLastProject}
                onChange={(e) =>
                  setRollPreferences((current) => ({
                    ...current,
                    rememberLastProject: e.target.checked,
                  }))
                }
              />
              记住最后选择的项目与公司
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={rollPreferences.openOutputAfterSuccess}
                onChange={(e) =>
                  setRollPreferences((current) => ({
                    ...current,
                    openOutputAfterSuccess: e.target.checked,
                  }))
                }
              />
              成功后自动打开第一个输出文件
            </label>
          </details>
          <div className="checkbox-grid">
            {subjects.map((subject) => (
              <label key={subject.code} className="check-row">
                <input
                  type="checkbox"
                  checked={company?.subjects.includes(subject.code) ?? false}
                  onChange={() =>
                    updateCompany({
                      subjects: company?.subjects.includes(subject.code)
                        ? company.subjects.filter(
                            (code) => code !== subject.code,
                          )
                        : [...(company?.subjects ?? []), subject.code],
                    })
                  }
                />
                <span>
                  <strong>{subject.code}</strong> {subject.name}
                </span>
              </label>
            ))}
          </div>
          <div className="actions">
            <button
              className="ghost"
              onClick={() =>
                updateCompany({ subjects: subjects.map((item) => item.code) })
              }
            >
              全选科目
            </button>
            <button
              className="ghost"
              onClick={() => updateCompany({ subjects: [] })}
            >
              清空科目
            </button>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={company?.roll_wording ?? false}
              onChange={(e) =>
                updateCompany({ roll_wording: e.target.checked })
              }
            />
            结转 wording / 分析说明 / 调整分录汇总
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={company?.generate_summary ?? true}
              onChange={(e) =>
                updateCompany({ generate_summary: e.target.checked })
              }
            />
            生成 Roll Forward Summary
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={company?.llm_enhanced ?? false}
              onChange={(e) =>
                updateCompany({ llm_enhanced: e.target.checked })
              }
            />
            启用全局 LLM 增强预检与 Review
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={company?.llm_wording_revision ?? false}
              onChange={(e) =>
                updateCompany({
                  llm_wording_revision: e.target.checked,
                  llm_enhanced:
                    e.target.checked || company?.llm_enhanced || false,
                })
              }
            />
            允许 LLM 修订已标黄 wording
          </label>
          {(company?.llm_enhanced || company?.llm_wording_revision) && (
            <small className="muted-copy">
              使用工具箱“设置”中的全局 LLM 配置；不会在项目数据中保存密钥。
            </small>
          )}
        </section>
      </div>
      <section className="form-card" style={{ marginTop: 18 }}>
        <h2>3. CRA 解析与确认</h2>
        <textarea
          rows={6}
          value={company?.cra_text ?? ""}
          placeholder={"粘贴 CRA 内容，例如：科目名称\\t认定\\tCRA\\t比例"}
          onChange={(e) =>
            updateCompany({
              cra_text: e.target.value,
              cra_table_records: [],
              apply_cra: false,
              cra_skip_confirmed: false,
            })
          }
        />
        <div className="actions">
          <button
            className="secondary"
            disabled={!company?.cra_text.trim()}
            onClick={() => void parseCra()}
          >
            解析 CRA
          </button>
          <button
            className="ghost"
            disabled={!company?.cra_text && !company?.cra_table_records.length}
            onClick={() => {
              updateCompany({
                cra_text: "",
                cra_table_records: [],
                cra_header_preference: "",
                apply_cra: false,
                cra_skip_confirmed: false,
              });
              setCraHeaderOptions([]);
            }}
          >
            清空 CRA
          </button>
          <label className="check-row">
            <input
              type="checkbox"
              disabled={!company?.cra_table_records.length}
              checked={company?.apply_cra ?? false}
              onChange={(e) =>
                updateCompany({
                  apply_cra: e.target.checked,
                  cra_skip_confirmed: false,
                })
              }
            />
            将 {company?.cra_table_records.length ?? 0} 条确认记录写入底稿
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={company?.cra_skip_confirmed ?? false}
              onChange={(e) =>
                updateCompany({
                  cra_skip_confirmed: e.target.checked,
                  apply_cra: e.target.checked
                    ? false
                    : (company?.apply_cra ?? false),
                })
              }
            />
            明确本次不使用 CRA
          </label>
        </div>
        {!!craHeaderOptions.length && (
          <label className="field">
            <span>CRA 列（多公司表）</span>
            <select
              value={company?.cra_header_preference ?? ""}
              onChange={(e) =>
                updateCompany({ cra_header_preference: e.target.value })
              }
            >
              <option value="">自动识别</option>
              {craHeaderOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        )}
        {!!company?.cra_table_records.length && (
          <div className="field-grid">
            <label className="field">
              <span>搜索</span>
              <input
                value={craSearch}
                placeholder="科目、认定或备注"
                onChange={(e) => setCraSearch(e.target.value)}
              />
            </label>
            <label className="field">
              <span>底稿科目</span>
              <select
                value={craSubjectFilter}
                onChange={(e) => setCraSubjectFilter(e.target.value)}
              >
                <option value="all">全部底稿科目</option>
                {[
                  ...new Set(
                    company.cra_table_records.map((record) =>
                      String(record.subject_code ?? ""),
                    ),
                  ),
                ].map((code) => (
                  <option key={code} value={code}>
                    {code || "未匹配科目"}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>匹配状态</span>
              <select
                value={craStatusFilter}
                onChange={(e) => setCraStatusFilter(e.target.value)}
              >
                <option value="all">全部</option>
                <option value="write">将写入</option>
                <option value="confirm">需确认</option>
                <option value="skip">不写入</option>
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={craExceptionOnly}
                onChange={(e) => setCraExceptionOnly(e.target.checked)}
              />
              仅看异常/需确认
            </label>
          </div>
        )}
        {!!company?.cra_table_records.length && (
          <div className="mapping-table">
            <div className="mapping-row mapping-head roll-cra-row">
              <span>写入</span>
              <span>底稿科目</span>
              <span>认定</span>
              <span>CRA / 比例</span>
            </div>
            {company.cra_table_records
              .map((record, index) => ({ record, index }))
              .filter(({ record }) => {
                const status = String(record.match_status ?? "");
                const subjectCode = String(record.subject_code ?? "");
                const ratioStatus = String(record.ratio_status ?? "");
                const rangeStatus = String(record.range_status ?? "");
                const haystack =
                  `${subjectCode} ${record.account_name ?? ""} ${record.assertion ?? ""} ${record.note ?? ""}`.toLocaleLowerCase();
                const searchOk =
                  !craSearch.trim() ||
                  haystack.includes(craSearch.trim().toLocaleLowerCase());
                const subjectOk =
                  craSubjectFilter === "all" ||
                  subjectCode === craSubjectFilter;
                const statusOk =
                  craStatusFilter === "all" ||
                  (craStatusFilter === "write" && status === "将写入") ||
                  (craStatusFilter === "confirm" &&
                    status.startsWith("需确认")) ||
                  (craStatusFilter === "skip" && status.startsWith("不写入"));
                const exceptionOk =
                  !craExceptionOnly ||
                  status !== "将写入" ||
                  rangeStatus.startsWith("超出") ||
                  ratioStatus.includes("未识别") ||
                  ratioStatus.includes("区间");
                return searchOk && subjectOk && statusOk && exceptionOk;
              })
              .map(({ record, index }) => (
                <div
                  className="mapping-row roll-cra-row"
                  key={`${String(record.subject_code)}-${index}`}
                >
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={Boolean(record.apply)}
                      onChange={(e) =>
                        updateCraRecord(index, {
                          apply: e.target.checked,
                          match_status: e.target.checked ? "将写入" : "不写入",
                        })
                      }
                    />
                    <span>{String(record.match_status ?? "")}</span>
                  </label>
                  <div className="input-with-button">
                    <select
                      value={String(record.subject_code ?? "")}
                      onChange={(e) =>
                        updateCraRecord(index, { subject_code: e.target.value })
                      }
                    >
                      <option value="">未匹配</option>
                      {subjects.map((subject) => (
                        <option key={subject.code} value={subject.code}>
                          {subject.code}
                        </option>
                      ))}
                    </select>
                    <input
                      value={String(record.account_name ?? "")}
                      onChange={(e) =>
                        updateCraRecord(index, { account_name: e.target.value })
                      }
                    />
                  </div>
                  <input
                    value={String(record.assertion ?? "")}
                    onChange={(e) =>
                      updateCraRecord(index, { assertion: e.target.value })
                    }
                  />
                  <div className="input-with-button">
                    <input
                      value={String(record.cra_level ?? "")}
                      onChange={(e) =>
                        updateCraRecord(index, { cra_level: e.target.value })
                      }
                    />
                    <input
                      value={String(record.ratio_text ?? record.ratio ?? "")}
                      onChange={(e) =>
                        updateCraRecord(index, {
                          ratio_text: e.target.value,
                          ratio: parseRollForwardCraRatio(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
      <section className="result-card merger-progress">
        <div className="section-title">
          <h2>4. 运行检查与结果</h2>
          <span>{company?.status}</span>
        </div>
        <div className="actions">
          <button
            className="secondary"
            onClick={() =>
              void saveProjects().catch((e) => setError(errorText(e)))
            }
          >
            保存项目
          </button>
          <button className="secondary" onClick={() => void exportProject()}>
            导出项目
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void validate()}
          >
            运行前检查
          </button>
          <button
            className="primary"
            disabled={busy || !company?.subjects.length}
            onClick={() => void start()}
          >
            开始结转
          </button>
          <button
            className="primary"
            disabled={
              busy || project.companies.some((item) => !item.subjects.length)
            }
            onClick={() => void startAllCompanies()}
          >
            处理全部公司
          </button>
          {job && busy && (
            <button
              className="secondary"
              onClick={() => {
                const next = !paused;
                void jobPause(job.jobId, next).then(() => setPaused(next));
              }}
            >
              {paused ? "继续" : "安全暂停"}
            </button>
          )}
          {job && busy && (
            <button
              className="danger"
              onClick={() => void jobCancel(job.jobId)}
            >
              取消任务
            </button>
          )}
        </div>
        {job && (
          <>
            <div className={`job-banner ${job.severity}`}>
              <strong>{job.message}</strong>
              <span>{job.phase}</span>
            </div>
            <progress max={Math.max(job.total, 1)} value={job.current} />
            {job.outputPaths.map((path) => (
              <button
                key={path}
                className="ghost"
                onClick={() => void openOutput(path)}
              >
                {path}
              </button>
            ))}
          </>
        )}
        {validation !== undefined && <RollForwardResult value={validation} />}
      </section>
    </>
  );
}

function RollForwardResult({ value }: { value: unknown }) {
  const root = (value ?? {}) as Record<string, unknown>;
  const validationRows = Array.isArray(root.details)
    ? (root.details as Array<Record<string, unknown>>)
    : [];
  const directRows = Array.isArray(root.results)
    ? (root.results as Array<Record<string, unknown>>)
    : [];
  const companies = Array.isArray(root.companies)
    ? (root.companies as Array<Record<string, unknown>>)
    : [];
  if (validationRows.length) {
    return (
      <div className="roll-result-list">
        <div className={`job-banner ${root.valid ? "success" : "warning"}`}>
          <strong>{root.valid ? "运行前检查通过" : "运行前检查未通过"}</strong>
          <span>{String(root.llmMessage ?? "")}</span>
        </div>
        {validationRows.map((row) => (
          <div className="roll-result-row" key={String(row.code)}>
            <strong>
              {String(row.code)} · {String(row.name)}
            </strong>
            <span>{row.templateReady ? "模板就绪" : "缺少模板"}</span>
            <span>{row.priorReady ? "已匹配上年底稿" : "未找到上年底稿"}</span>
            <small>{String(row.priorPath ?? "")}</small>
          </div>
        ))}
      </div>
    );
  }
  const rows: Array<Record<string, unknown>> = directRows.length
    ? directRows
    : companies.flatMap((company) =>
        (Array.isArray(company.results) ? company.results : []).map(
          (row): Record<string, unknown> => ({
            ...(row as Record<string, unknown>),
            companyName: company.companyName,
          }),
        ),
      );
  if (rows.length) {
    return (
      <div className="roll-result-list">
        {rows.map((row, index) => {
          // The engine reports which prior-year workbook it matched and how much
          // it rewrote. Hiding that left no way to catch a subject bound to the
          // wrong prior file, which produces a perfectly normal-looking result.
          const meta = (row.metadata ?? {}) as Record<string, unknown>;
          const diff = (meta.workbookDiff ?? {}) as Record<string, unknown>;
          const priorPath = String(meta.priorPath ?? "");
          const priorSize = Number(meta.priorSize ?? 0);
          const counters = [
            ["复制单元格", meta.copiedCells],
            ["标黄", meta.highlightedCells],
            ["CRA 写入", meta.craWriteCount],
            ["变更", diff.changedCells],
            ["公式变化", diff.formulaChanges],
          ].filter(([, value]) => typeof value === "number") as Array<
            [string, number]
          >;
          return (
            <div
              className={`roll-result-row ${row.success ? "success" : "failed"}`}
              key={`${String(row.companyName ?? "")}-${String(row.subjectCode ?? index)}`}
            >
              <strong>
                {row.companyName ? `${String(row.companyName)} · ` : ""}
                {String(row.subjectCode ?? "")}
              </strong>
              <span>{row.success ? "成功" : "失败"}</span>
              <span>{String(row.message ?? "")}</span>
              {row.outputPath ? (
                <button
                  className="link-button"
                  onClick={() => void openOutput(String(row.outputPath))}
                >
                  打开输出文件
                </button>
              ) : null}
              {priorPath ? (
                <small>
                  使用上年底稿：{priorPath}
                  {priorSize > 0
                    ? `（${(priorSize / 1024 / 1024).toFixed(1)} MB）`
                    : ""}
                </small>
              ) : null}
              {counters.length ? (
                <small>
                  {counters
                    .map(([label, value]) => `${label} ${value}`)
                    .join(" · ")}
                </small>
              ) : null}
              {Array.isArray(row.warnings) && row.warnings.length ? (
                <small>{row.warnings.map(String).join("；")}</small>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }
  return <ResultView value={value} />;
}

function PathField({
  label,
  value,
  onChange,
  kind,
  allowFile = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  kind: "file" | "folder";
  allowFile?: boolean;
}) {
  async function browse(target: "file" | "folder" = kind) {
    const result = await pickPath(
      target,
      label,
      target === "file" ? ["xlsx"] : [],
    );
    if (typeof result === "string") onChange(result);
  }
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-with-button">
        <input value={value} onChange={(e) => onChange(e.target.value)} />
        <button className="browse" onClick={() => void browse()}>
          浏览
        </button>
        {allowFile && (
          <button className="browse" onClick={() => void browse("file")}>
            单文件
          </button>
        )}
      </div>
    </label>
  );
}

type MergerFile = {
  path: string;
  name: string;
  size: number;
  sheets: string[];
  error?: string | null;
};

function ExcelMergerPage({ tool }: { tool: ToolManifest }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [files, setFiles] = useState<MergerFile[]>([]);
  const [availableSheets, setAvailableSheets] = useState<string[]>([]);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [outputDirectoryTouched, setOutputDirectoryTouched] = useState(false);
  const [outputFormat, setOutputFormat] = useState("xlsx");
  const [outputMode, setOutputMode] = useState("one_sheet");
  const [direction, setDirection] = useState("vertical");
  // Legacy always opened a sheet picker with every sheet pre-checked, so the
  // default merge covered all sheets.  Defaulting to "first sheet only" quietly
  // dropped data for anyone who kept their old habits.
  const [sheetAction, setSheetAction] = useState("merge_all");
  const [targetSheets, setTargetSheets] = useState<string[]>([]);
  const [addHyperlinks, setAddHyperlinks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobEvent>();
  const [error, setError] = useState("");
  const [result, setResult] = useState<unknown>();
  const addPaths = (incoming: string[]) =>
    setPaths((current) => [
      ...current,
      ...incoming.filter(
        (path) =>
          !current.some(
            (old) => old.toLocaleLowerCase() === path.toLocaleLowerCase(),
          ),
      ),
    ]);
  useEffect(() => {
    let off: () => void = () => {};
    void listenFileDrops((incoming) => {
      void engineCall("excel_merger.expand_paths", { paths: incoming })
        .then((value) =>
          addPaths((value as { inputPaths?: string[] }).inputPaths ?? []),
        )
        .catch((e) => setError(errorText(e)));
    }).then((value) => {
      off = value;
    });
    return () => off();
  }, []);
  useEffect(() => {
    let off: () => void = () => {};
    void listenJobEvents((event) => {
      if (event.toolId === "Excel_Merger") {
        setJob(event);
        // A failed job also carries a result payload; rendering it produced a
        // green "处理完成。" directly under the red failure banner.
        if (event.phase === "failed" || event.phase === "cancelled") {
          setResult(undefined);
          const payload = event.result as
            { error?: { userMessage?: string } } | undefined;
          setError(payload?.error?.userMessage ?? event.message);
        } else if (event.result) {
          setResult(event.result);
        }
        setBusy(!["completed", "failed", "cancelled"].includes(event.phase));
      }
    }).then((value) => {
      off = value;
    });
    return () => off();
  }, []);
  useEffect(() => {
    setFiles([]);
    setAvailableSheets([]);
    setTargetSheets([]);
  }, [paths]);
  useEffect(() => {
    if (!outputDirectoryTouched)
      setOutputDirectory(paths[0] ? parentPath(paths[0]) : "");
  }, [paths, outputDirectoryTouched]);
  async function chooseFiles() {
    const value = await pickPath("files", "添加 Excel、CSV 或 TXT", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
    ]);
    if (Array.isArray(value)) addPaths(value);
  }
  async function chooseFolder() {
    const folder = await pickPath("folder", "扫描包含表格的文件夹", []);
    if (typeof folder !== "string") return;
    setError("");
    try {
      const value = (await engineCall("excel_merger.scan_folder", {
        folder,
      })) as { inputPaths?: string[] };
      addPaths(value.inputPaths ?? []);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function inspect() {
    if (!paths.length) {
      setError("请先添加需要合并的文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const value = (await engineCall("excel_merger.inspect", {
        inputPaths: paths,
      })) as { files: MergerFile[]; availableSheets: string[] };
      setFiles(value.files);
      setAvailableSheets(value.availableSheets);
      setTargetSheets(value.availableSheets);
      setResult(value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function chooseOutputDirectory() {
    const value = await pickPath("folder", "选择输出目录", []);
    if (typeof value === "string") {
      setOutputDirectory(value);
      setOutputDirectoryTouched(true);
    }
  }
  async function start() {
    if (!paths.length) {
      setError("请先添加输入文件。");
      return;
    }
    if (sheetAction === "match_selected" && !targetSheets.length) {
      setError("按名称匹配时请至少选择一个 Sheet。");
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const jobId = await jobStart("excel_merger.merge", {
        inputPaths: paths,
        outputDirectory,
        outputFormat: outputMode === "one_workbook" ? "xlsx" : outputFormat,
        outputMode,
        direction,
        sheetAction,
        targetSheets,
        addHyperlinks,
      });
      setJob({
        jobId,
        toolId: "Excel_Merger",
        phase: "queued",
        current: 0,
        total: 1,
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  function move(index: number, delta: number) {
    const next = index + delta;
    if (next < 0 || next >= paths.length) return;
    setPaths((current) => {
      const copy = [...current];
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
  }
  function toggleSheet(name: string) {
    setTargetSheets((current) =>
      current.includes(name)
        ? current.filter((value) => value !== name)
        : [...current, name],
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="批量 Excel 合并"
        title={tool.name}
        detail="Rust 直接读取和写出表格；多 Sheet 模式通过 Excel 原生接口原样复制，不再调用 Python 合并库。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "文件源", disabled: true },
          { key: "2", label: "合并规则", disabled: true },
          { key: "3", label: "执行合并", disabled: true },
        ]}
        current={0}
      />
      <div className="merger-layout">
        <section className="form-card merger-source">
          <div className="section-title">
            <h2>1. 文件源</h2>
            <span>{paths.length} 个文件</span>
          </div>
          <button
            type="button"
            className="drop-zone"
            onClick={() => void chooseFiles()}
          >
            <strong>拖放文件或文件夹到窗口</strong>
            <span>支持 XLSX、XLS、XLSM、CSV、TXT，也可点击添加文件</span>
          </button>
          <div className="merger-toolbar">
            <button className="secondary" onClick={() => void chooseFiles()}>
              添加文件
            </button>
            <button className="secondary" onClick={() => void chooseFolder()}>
              扫描文件夹
            </button>
            <button
              className="ghost"
              disabled={!paths.length}
              onClick={() => setPaths([])}
            >
              清空列表
            </button>
          </div>
          <div className="file-queue">
            {paths.length ? (
              paths.map((path, index) => {
                const detail = files.find((item) => item.path === path);
                return (
                  <div className="file-item" key={path}>
                    <div>
                      <strong>
                        {detail?.name ?? path.split(/[\\/]/).pop()}
                      </strong>
                      <span>
                        {detail
                          ? `${formatSize(detail.size)} · ${detail.sheets.length ? detail.sheets.join("、") : "文本文件"}`
                          : path}
                      </span>
                      {detail?.error && <em>{detail.error}</em>}
                    </div>
                    <div>
                      <button
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        disabled={index === paths.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        onClick={() =>
                          setPaths((current) =>
                            current.filter((_, i) => i !== index),
                          )
                        }
                      >
                        移除
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="empty compact">尚未添加文件</div>
            )}
          </div>
          <div className="actions">
            <button
              className="secondary"
              disabled={busy || !paths.length}
              onClick={() => void inspect()}
            >
              检查文件与 Sheet
            </button>
          </div>
        </section>
        <section className="form-card merger-rules">
          <div className="section-title">
            <h2>2. 合并规则</h2>
            <span className="pill ready">Rust 原生引擎</span>
          </div>
          <fieldset>
            <legend>输出目标</legend>
            <label>
              <input
                type="radio"
                checked={outputMode === "one_sheet"}
                onChange={() => setOutputMode("one_sheet")}
              />{" "}
              合并成一张大表（One Sheet）
            </label>
            <label>
              <input
                type="radio"
                checked={outputMode === "one_workbook"}
                onChange={() => setOutputMode("one_workbook")}
              />{" "}
              合并成一个工作簿（多 Sheet）
            </label>
          </fieldset>
          <fieldset disabled={outputMode === "one_workbook"}>
            <legend>拼接方向</legend>
            <label>
              <input
                type="radio"
                checked={direction === "vertical"}
                onChange={() => setDirection("vertical")}
              />{" "}
              纵向堆叠（上下拼）
            </label>
            <label>
              <input
                type="radio"
                checked={direction === "horizontal"}
                onChange={() => setDirection("horizontal")}
              />{" "}
              横向拼接（左右拼）
            </label>
          </fieldset>
          <fieldset>
            <legend>Sheet 范围</legend>
            <label>
              <input
                type="radio"
                checked={sheetAction === "default"}
                onChange={() => setSheetAction("default")}
              />{" "}
              每个文件仅取第一个 Sheet
            </label>
            <label>
              <input
                type="radio"
                checked={sheetAction === "match_selected"}
                onChange={() => setSheetAction("match_selected")}
              />{" "}
              按名称匹配所选 Sheet
            </label>
            <label>
              <input
                type="radio"
                checked={sheetAction === "merge_all"}
                onChange={() => setSheetAction("merge_all")}
              />{" "}
              合并所有 Sheet
            </label>
          </fieldset>
          {sheetAction === "match_selected" && (
            <div className="sheet-picker">
              <div>
                <span>目标 Sheet</span>
                <button onClick={() => setTargetSheets(availableSheets)}>
                  全选
                </button>
                <button onClick={() => setTargetSheets([])}>全不选</button>
              </div>
              {availableSheets.length ? (
                availableSheets.map((name) => (
                  <label key={name}>
                    <input
                      type="checkbox"
                      checked={targetSheets.includes(name)}
                      onChange={() => toggleSheet(name)}
                    />
                    {name}
                  </label>
                ))
              ) : (
                <p>请先执行“检查文件与 Sheet”。</p>
              )}
            </div>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={addHyperlinks}
              onChange={(e) => setAddHyperlinks(e.target.checked)}
            />
            加入源文件超链接（大文件会降低导出速度）
          </label>
          <div className="format-row">
            <span>输出格式</span>
            <label>
              <input
                type="radio"
                checked={outputFormat === "xlsx"}
                onChange={() => setOutputFormat("xlsx")}
              />{" "}
              XLSX
            </label>
            <label>
              <input
                type="radio"
                disabled={outputMode === "one_workbook"}
                checked={
                  outputMode !== "one_workbook" && outputFormat === "csv"
                }
                onChange={() => setOutputFormat("csv")}
              />{" "}
              CSV
            </label>
          </div>
          <div className="output-row">
            <input
              value={outputDirectory}
              readOnly
              title={outputDirectory}
              placeholder="添加文件后自动填入默认保存目录"
            />
            <button
              className="browse"
              onClick={() => void chooseOutputDirectory()}
            >
              选择目录
            </button>
            {outputDirectoryTouched && (
              <button
                className="browse"
                onClick={() => setOutputDirectoryTouched(false)}
              >
                恢复默认
              </button>
            )}
          </div>
          <p className="output-hint">
            {outputDirectoryTouched
              ? "已指定输出目录。"
              : "默认保存到第一个输入文件所在目录。"}
            文件名自动生成：Excel合并结果_日期_时间.
            {outputMode === "one_workbook" ? "xlsx" : outputFormat}
          </p>
          {error && <div className="error-box">{error}</div>}
          <div className="actions">
            {busy && job ? (
              <button
                className="secondary"
                onClick={() => void jobCancel(job.jobId)}
              >
                停止执行
              </button>
            ) : (
              <button
                className="primary"
                disabled={!paths.length}
                onClick={() => void start()}
              >
                开始合并
              </button>
            )}
          </div>
        </section>
      </div>
      <section className="result-card merger-progress">
        <h2>进度与结果</h2>
        {job ? (
          <>
            <div className={`job-banner ${job.severity}`}>
              <strong>{job.message}</strong>
              <span>{job.phase}</span>
            </div>
            <progress
              max={Math.max(job.total, 1)}
              value={job.total ? job.current : 0}
            />
            {result && <ResultView value={result} />}
          </>
        ) : result ? (
          <ResultView value={result} />
        ) : (
          <div className="empty compact">检查结果和合并进度将在这里显示。</div>
        )}
      </section>
    </>
  );
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "userMessage" in error)
    return String((error as { userMessage: unknown }).userMessage);
  return error instanceof Error ? error.message : String(error);
}
function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function parentPath(path: string) {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (index < 0) return "";
  return index === 2 && path[1] === ":"
    ? path.slice(0, 3)
    : path.slice(0, index);
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FieldDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  async function browse() {
    const v = await pickPath(
      field.kind as "file" | "files" | "folder" | "save",
      field.label,
      field.extensions,
    );
    if (v != null) onChange(v);
  }
  return (
    <label className="field">
      <span>
        {field.label}
        {field.required && <b>*</b>}
      </span>
      {field.kind === "select" ? (
        <select value={text} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.kind === "boolean" ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : (
        <div className="input-with-button">
          <input
            type={field.kind === "date" ? "date" : "text"}
            value={text}
            placeholder={field.placeholder}
            onChange={(e) =>
              onChange(
                field.kind === "files"
                  ? e.target.value
                      .split(";")
                      .map((x) => x.trim())
                      .filter(Boolean)
                  : e.target.value,
              )
            }
          />
          {["file", "files", "folder", "save"].includes(field.kind) && (
            <button
              type="button"
              className="browse"
              onClick={() => void browse()}
            >
              浏览
            </button>
          )}
        </div>
      )}
    </label>
  );
}

function normalizeValues(values: Record<string, unknown>) {
  const out = { ...values };
  for (const key of ["beginKeys", "endKeys", "subjectCodes"]) {
    if (typeof out[key] === "string")
      out[key] = (out[key] as string)
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
  }
  return out;
}
import { ResultView } from "./components/ResultView";

function TaskCenter({ jobs }: { jobs: JobEvent[] }) {
  return (
    <>
      <PageHeader
        eyebrow="运行状态"
        title="任务中心"
        detail="长任务可离开工具页面继续运行。"
      />
      <div className="list-card">
        {jobs.length ? (
          jobs.map((j) => (
            <div className="task-row" key={j.jobId}>
              <div>
                <strong>{j.toolId}</strong>
                <p>{j.message}</p>
              </div>
              <progress max={Math.max(j.total, 1)} value={j.current} />
              {j.severity === "info" && (
                <button
                  className="secondary"
                  onClick={() => void jobCancel(j.jobId)}
                >
                  取消
                </button>
              )}
            </div>
          ))
        ) : (
          <div className="empty">当前没有运行中的任务。</div>
        )}
      </div>
    </>
  );
}
function History() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    void historyGet()
      .then(setRows)
      .catch((reason) => setError(appErrorText(reason)))
      .finally(() => setLoading(false));
  }, []);
  return (
    <>
      <PageHeader
        eyebrow="可追踪结果"
        title="历史记录"
        detail="记录任务状态、时间和输出路径，不保存客户表格内容。"
      />
      <Card className="history-card">
        <CardContent className="history-card-content">
          {loading ? (
            <div className="empty" role="status" aria-live="polite">
              正在读取历史记录…
            </div>
          ) : error ? (
            <div className="error-box" role="alert">
              {error} 请前往“日志诊断”查看详情后重试。
            </div>
          ) : rows.length ? (
            rows.map((row, index) => (
              <div className="task-row" key={String(row.jobId ?? index)}>
                <div>
                  <strong>{String(row.toolId ?? "")}</strong>
                  <p>{String(row.message ?? row.status ?? "")}</p>
                </div>
                <time dateTime={String(row.startedAt ?? "")}>
                  {formatHistoryTime(row.startedAt)}
                </time>
                <span
                  className={`pill ${
                    row.status === "completed"
                      ? "ready"
                      : row.status === "failed"
                        ? "danger"
                        : "preview"
                  }`}
                >
                  {String(row.status ?? "")}
                </span>
              </div>
            ))
          ) : (
            <div className="empty" role="status">
              尚无历史任务。
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

const historyDateFormat = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatHistoryTime(value: unknown): string {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : historyDateFormat.format(date);
}
function Settings() {
  const [form, setForm] = useState({
    enabled: false,
    apiType: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    authMode: "bearer",
    timeout: "30",
    thinkingEnabled: false,
    apiKey: "",
    ocrEngine: "ai",
    ocrApiKey: "",
    ocrSecret: "",
  });
  const [message, setMessage] = useState("");
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{
    ok: boolean;
    text: string;
  }>();
  const [backupPath, setBackupPath] = useState("");
  useEffect(() => {
    void settingsGet()
      .then((value) => {
        const llm = (value.llm ?? {}) as Record<string, unknown>;
        const ocr = (value.ocr ?? {}) as Record<string, unknown>;
        setForm((x) => ({
          ...x,
          enabled: Boolean(llm.enabled),
          apiType: String(llm.api_type ?? x.apiType),
          baseUrl: String(llm.base_url ?? x.baseUrl),
          model: String(llm.model ?? ""),
          authMode: String(llm.auth_mode ?? x.authMode),
          timeout: String(llm.timeout ?? x.timeout),
          thinkingEnabled: Boolean(llm.thinking_enabled),
          ocrEngine: String(ocr.engine ?? x.ocrEngine),
        }));
      })
      .catch(() => undefined);
  }, []);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((x) => ({ ...x, [key]: value }));
  const llmSettings = () => ({
    enabled: form.enabled,
    api_type: form.apiType,
    base_url: form.baseUrl.trim(),
    model: form.model.trim(),
    auth_mode: form.authMode,
    timeout: Number(form.timeout) || 30,
    thinking_enabled: form.thinkingEnabled,
  });
  async function testConnection() {
    setLlmTestResult(undefined);
    if (!form.baseUrl.trim()) {
      setLlmTestResult({ ok: false, text: "请先填写 Base URL。" });
      return;
    }
    if (form.apiType !== "dify_chat" && !form.model.trim()) {
      setLlmTestResult({
        ok: false,
        text: "OpenAI 兼容接口需要填写模型名称。",
      });
      return;
    }
    setTestingLlm(true);
    try {
      const result = await llmTest({ llm: llmSettings() }, form.apiKey);
      setLlmTestResult({
        ok: true,
        text: `${result.message} 响应耗时 ${result.elapsedMs} 毫秒。`,
      });
    } catch (e) {
      const value =
        e && typeof e === "object" ? (e as Record<string, unknown>) : undefined;
      const userMessage = value?.userMessage ?? value?.message;
      const detail = typeof value?.detail === "string" ? value.detail : "";
      const text =
        typeof userMessage === "string"
          ? `${userMessage}${detail ? `（${detail}）` : ""}`
          : e instanceof Error
            ? e.message
            : String(e);
      setLlmTestResult({ ok: false, text });
    } finally {
      setTestingLlm(false);
    }
  }
  async function save() {
    setMessage("");
    try {
      await settingsSet({
        llm: {
          ...llmSettings(),
        },
        ocr: { engine: form.ocrEngine },
      });
      if (form.apiKey)
        await secretSet(
          form.apiType === "dify_chat" ? "dify_api_key" : "llm_api_key",
          form.apiKey,
        );
      if (form.ocrApiKey) await secretSet("baidu_ocr_key", form.ocrApiKey);
      if (form.ocrSecret) await secretSet("baidu_ocr_secret", form.ocrSecret);
      setForm((x) => ({ ...x, apiKey: "", ocrApiKey: "", ocrSecret: "" }));
      setMessage("配置已保存。AudiPick 会直接使用这里的 LLM 配置。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="本机配置"
        title="设置"
        detail="LLM 与 OCR 密钥由 Windows 凭据管理器保存，不写入 SQLite 或日志。"
      />
      <div className="settings-grid">
        <section className="list-card">
          <h2>统一 LLM 配置</h2>
          <div className="form-grid">
            <label className="field">
              <span>启用 LLM</span>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
              />
            </label>
            <label className="field">
              <span>接口类型</span>
              <select
                value={form.apiType}
                onChange={(e) => set("apiType", e.target.value)}
              >
                <option value="openai">OpenAI 兼容接口</option>
                <option value="dify_chat">Dify Chat App</option>
              </select>
            </label>
            <label className="field">
              <span>Base URL</span>
              <input
                value={form.baseUrl}
                onChange={(e) => set("baseUrl", e.target.value)}
              />
            </label>
            <label className="field">
              <span>模型</span>
              <input
                value={form.model}
                onChange={(e) => set("model", e.target.value)}
                placeholder="Dify 可留空"
              />
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                value={form.apiKey}
                onChange={(e) => set("apiKey", e.target.value)}
                placeholder="留空表示不修改"
              />
            </label>
            <label className="field">
              <span>鉴权方式</span>
              <select
                value={form.authMode}
                onChange={(e) => set("authMode", e.target.value)}
              >
                <option value="bearer">Bearer Token</option>
                <option value="raw">直接使用 API Key</option>
              </select>
            </label>
            <label className="field">
              <span>超时秒数</span>
              <input
                value={form.timeout}
                onChange={(e) => set("timeout", e.target.value)}
              />
              <small>
                连接测试只发一句话，很快就能返回；FA List
                的字段映射复核要把所有列名和样例值发给模型，慢得多。 建议 120
                秒以上，改完记得点下方保存。
              </small>
            </label>
            <label className="field">
              <span>思考模式</span>
              <input
                type="checkbox"
                checked={form.thinkingEnabled}
                onChange={(e) => set("thinkingEnabled", e.target.checked)}
              />
            </label>
          </div>
          <div className="settings-test-row">
            <button
              className="secondary"
              disabled={testingLlm}
              onClick={() => void testConnection()}
            >
              {testingLlm ? "正在测试…" : "测试 LLM 连接"}
            </button>
            <span>
              API Key
              留空时使用已保存的密钥；测试成功后仍需点击页面底部“保存配置”。
            </span>
          </div>
          {llmTestResult && (
            <div
              className={`settings-test-result ${llmTestResult.ok ? "success" : "failed"}`}
            >
              {llmTestResult.text}
            </div>
          )}
        </section>
        <section className="list-card">
          <h2>AudiPick OCR 配置</h2>
          <div className="form-grid">
            <label className="field">
              <span>OCR 引擎</span>
              <select
                value={form.ocrEngine}
                onChange={(e) => set("ocrEngine", e.target.value)}
              >
                <option value="ai">使用统一 AI</option>
                <option value="baidu">百度 OCR</option>
                <option value="local">本机 OCR 服务</option>
              </select>
            </label>
            <label className="field">
              <span>百度 API Key</span>
              <input
                type="password"
                value={form.ocrApiKey}
                onChange={(e) => set("ocrApiKey", e.target.value)}
                placeholder="留空表示不修改"
              />
            </label>
            <label className="field">
              <span>百度 Secret Key</span>
              <input
                type="password"
                value={form.ocrSecret}
                onChange={(e) => set("ocrSecret", e.target.value)}
                placeholder="留空表示不修改"
              />
            </label>
          </div>
        </section>
      </div>
      <section className="list-card" style={{ marginTop: 18 }}>
        <h2>AudiPick 旧数据迁移</h2>
        <p>
          先在旧 AudiPick 配置页导出迁移备份，再在这里导入。导入按项目 ID
          去重，不会删除旧数据。
        </p>
        <div className="input-with-button">
          <input
            value={backupPath}
            readOnly
            placeholder="选择 AudiPick迁移备份.json"
          />
          <button
            className="browse"
            onClick={() =>
              void pickPath("file", "选择 AudiPick 迁移备份", ["json"]).then(
                (v) => setBackupPath(typeof v === "string" ? v : ""),
              )
            }
          >
            浏览
          </button>
        </div>
        <div className="actions">
          <button
            className="secondary"
            disabled={!backupPath}
            onClick={() =>
              void legacyImport(backupPath)
                .then((r) => setMessage(JSON.stringify(r)))
                .catch((e) => setMessage(String(e)))
            }
          >
            导入并校验
          </button>
        </div>
      </section>
      {message && <div className="error-box">{message}</div>}
      <div className="actions">
        <button className="primary" onClick={() => void save()}>
          保存配置
        </button>
      </div>
    </>
  );
}
function SimplePage({ title, text }: { title: string; text: string }) {
  return (
    <>
      <PageHeader eyebrow="审计工具箱" title={title} detail={text} />
      <div className="list-card">
        <div className="empty">{text}</div>
      </div>
    </>
  );
}
function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}
