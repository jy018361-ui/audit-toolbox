import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactElement } from "react";
import { NavLink, Navigate, Route, Routes, useParams } from "react-router-dom";
import {
  appBootstrap,
  engineCall,
  historyGet,
  jobCancel,
  jobStart,
  legacyImport,
  listenJobEvents,
  llmTest,
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
import { TsManagerParityPage } from "./TsManagerParityPage";
import ConfirmationProgressPage from "./ConfirmationProgressPage";
import FileListDirectoryPage from "./FileListDirectoryPage";
import { KanzhangParityPage } from "./KanzhangParityPage";
import { FaListPage } from "./FaListPage";
import { ExcelMergerPage } from "./ExcelMergerPage";
import { AudiPickPage } from "./AudiPickPage";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { ResultView } from "@/components/ResultView";
import { RollForwardPage } from "./RollForwardPage";
import { applyReadableForegrounds } from "./theme";

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
          <h1>E点通工具箱</h1>
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
          {[
            { label: "审计工具", ids: ["fa_list", "kanzhang", "audipick", "audit_roll_forward"] },
            { label: "效率工具", ids: ["Excel_Merger", "file_list_directory"] },
            { label: "运营工具", ids: ["ts_manager", "confirmation_progress", "wp_service_generator"] },
          ].map((group) => {
            const tools = catalog.filter((t) => group.ids.includes(t.id));
            if (!tools.length) return null;
            return (
              <div key={group.label} className="tool-group">
                <div className="nav-caption">{group.label}</div>
                {tools.map((t) => (
                  <NavLink key={t.id} to={t.route}>
                    <span className="tool-badge">
                      {TOOL_BADGE[t.id] ?? t.name.slice(0, 1)}
                    </span>
                    {t.name}
                  </NavLink>
                ))}
              </div>
            );
          })}
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
      <PageHeader eyebrow="WP 服务单生成" title={tool.name} detail={def.intro} />
      <StepIndicator
        steps={[
          { key: "1", label: "任务配置", disabled: true },
          { key: "2", label: "检查输入", disabled: true },
          { key: "3", label: "生成结果", disabled: true },
        ]}
        current={0}
      />
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


function errorText(error: unknown) {
  if (error && typeof error === "object" && "userMessage" in error)
    return String((error as { userMessage: unknown }).userMessage);
  return error instanceof Error ? error.message : String(error);
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
  // 全局主题（data-theme 切换，默认深绿）
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset.theme ?? "green-dark",
  );
  const applyTheme = (id: string) => {
    document.documentElement.dataset.theme = id;
    // Text drawn on the theme's own colours is derived from those colours, so a
    // light brand does not keep the white label it was hand-paired with.
    applyReadableForegrounds();
    try {
      localStorage.setItem("audit-toolbox.theme", id);
    } catch {
      /* ignore */
    }
    setTheme(id);
  };
  useEffect(() => {
    const saved =
      document.documentElement.dataset.theme ??
      (() => {
        try {
          return localStorage.getItem("audit-toolbox.theme") ?? "green-dark";
        } catch {
          return "green-dark";
        }
      })();
    applyTheme(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
          <h2>界面主题</h2>
          <div className="theme-picker">
            {[
              { id: "green-dark", name: "深绿" },
              { id: "classic-dark", name: "经典黄黑" },
              { id: "yellow-light", name: "明亮黄白" },
              { id: "blue-white", name: "专业蓝白" },
              { id: "red-white", name: "利落红白" },
              { id: "yellow-blue", name: "醒目黄蓝" },
              { id: "red-yellow-ivory", name: "红黄米白" },
              { id: "yellow-green", name: "清新黄绿" },
              { id: "teal-dark", name: "深色青绿" },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                className={`theme-option ${theme === t.id ? "active" : ""}`}
                onClick={() => applyTheme(t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>
        </section>
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
