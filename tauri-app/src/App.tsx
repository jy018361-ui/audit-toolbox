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
  updateReleaseNotes,
} from "./api";
import type { ReleaseNotes } from "./updateNotes";
import { Button } from "@/components/ui/button";
import {
  TOOL_DEFINITIONS,
  type ActionDefinition,
  type FieldDefinition,
} from "./toolDefinitions";
import type { Bootstrap, JobEvent, ToolManifest } from "./types";
import { TsManagerParityPage } from "./TsManagerParityPage";
import ConfirmationProgressPage from "./ConfirmationProgressPage";
import FileListDirectoryPage from "./FileListDirectoryPage";
import PdfToExcelPage from "./PdfToExcelPage";
import { KanzhangParityPage } from "./KanzhangParityPage";
import { JeSignMarkPage } from "./JeSignMarkPage";
import { FaListPage } from "./FaListPage";
import { ExcelMergerPage } from "./ExcelMergerPage";
import { AudiPickPage } from "./AudiPickPage";
import { WpServicePage } from "./WpServicePage";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { WindowControls } from "@/components/WindowControls";
import { PersistentToolPages } from "@/components/PersistentToolPages";
import { StepIndicator } from "@/components/StepIndicator";
import { ResultView } from "@/components/ResultView";
import { RollForwardPage } from "./RollForwardPage";
import { FxAuditPage } from "./FxAuditPage";
import { LoanInterestPage } from "./LoanInterestPage";
import { DepositInterestPage } from "./DepositInterestPage";
import { FuzzyMatchPage } from "./FuzzyMatchPage";
import { FaDepCalcPage } from "./FaDepCalcPage";
import { FaPolicyComparePage } from "./FaPolicyComparePage";
import { applyReadableForegrounds } from "./theme";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

const NAV = [
  { to: "/", label: "工作台" },
  { to: "/history", label: "历史记录" },
  { to: "/settings", label: "设置" },
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
const NAV_ICON: Record<string, ReactElement> = {
  "/": <IconHome />,
  "/history": <IconHistory />,
  "/settings": <IconSettings />,
};

// 工具清单以 public/tool-catalog.json 为准，用简短徽标代替千篇一律的纯文字列表，
// 方便在侧边栏一眼定位；不逐个配色，避免走回文件顶部注释警惕过的"173 种颜色"老路。
const TOOL_BADGE: Record<string, string> = {
  fa_list: "FA",
  fa_dep_calc: "折",
  fa_policy_compare: "政",
  kanzhang: "账",
  je_sign_mark: "±",
  ts_manager: "TS",
  confirmation_progress: "函",
  Excel_Merger: "合",
  file_list_directory: "夹",
  pdf_to_excel: "PDF",
  audipick: "AP",
  audit_roll_forward: "RF",
  wp_service_generator: "WP",
  fx_audit: "汇",
  loan_interest: "息",
  deposit_interest: "存",
  fuzzy_match: "模",
};

// 侧边栏可折叠子分组：分组头只是展开/收起的开关（不走路由），
// 子项挂在竖线缩进下。新增子分组在这里登记，再往下面分组 ids 里放占位符。
const TOOL_SUBGROUPS: Record<
  string,
  { key: string; label: string; badge: string; ids: string[] }
> = {
  __FA_GROUP__: {
    key: "fa",
    label: "FA底稿生成",
    badge: "FA",
    ids: ["fa_list", "fa_dep_calc", "fa_policy_compare"],
  },
  __KANZHANG_GROUP__: {
    key: "kanzhang",
    label: "看账工具",
    badge: "账",
    ids: ["kanzhang", "je_sign_mark"],
  },
};

export default function App() {
  const [catalog, setCatalog] = useState<ToolManifest[]>([]);
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [jobs, setJobs] = useState<Record<string, JobEvent>>({});
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [startupReady, setStartupReady] = useState(false);
  const [startupError, setStartupError] = useState("");
  const automaticUpdateCheckStarted = useRef(false);
  // 侧边栏子分组默认展开：折叠头不是路由入口，收着会让高频工具"消失"。
  const [subgroupOpen, setSubgroupOpen] = useState<Record<string, boolean>>({
    fa: true,
    kanzhang: true,
  });
  // 缓存自动清理：启动时问一次，之后每小时问一次。
  // 「够不够一个周期」由后端判断——那条判断只该有一处，散在两边迟早对不上。
  useEffect(() => {
    const sweep = async () => {
      try {
        const settings = await settingsGet();
        const cache = (settings.cache ?? {}) as Record<string, unknown>;
        const mode = String(cache.cleanup ?? "weekly");
        if (mode === "off") return;
        const result = (await engineCall("cache.sweep", {
          mode,
          lastCleanup: cache.lastCleanup ?? null,
        })) as { skipped?: boolean; cleanedAt?: number };
        // 真清理过才写回时间戳，跳过时不动——否则永远差一点到期。
        if (!result.skipped && result.cleanedAt) {
          await settingsSet({
            cache: { cleanup: mode, lastCleanup: result.cleanedAt },
          });
        }
      } catch {
        // 清理失败不该影响启动，缓存留着最多是占点磁盘。
      }
    };
    void sweep();
    const timer = setInterval(() => void sweep(), 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
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
  useEffect(() => {
    if (automaticUpdateCheckStarted.current) return;
    automaticUpdateCheckStarted.current = true;
    void check()
      .then((update) => setAvailableUpdate(update ?? null))
      .catch(() => {
        // 启动时的检查保持静默；断网不该打断用户工作，仍可在设置页手动重试。
      });
  }, []);
  return (
    <div className="app-shell">
      <WindowControls />
      <aside className="sidebar">
        <div className="brand" data-tauri-drag-region>
          {/* drag-region 只对本元素生效、不继承，所以每个文字节点都要带上 */}
          <span data-tauri-drag-region>AUDIT TOOLKIT</span>
          <h1 data-tauri-drag-region>E点通工具箱</h1>
          <p data-tauri-drag-region>统一、安全、可追踪的审计作业工作台</p>
        </div>
        <nav>
          {NAV.map((x) => (
            <NavLink key={x.to} to={x.to} end={x.to === "/"}>
              <span className="nav-icon">{NAV_ICON[x.to]}</span>
              <span>{x.label}</span>
              {x.to === "/settings" && availableUpdate && (
                <span
                  className="nav-update-dot"
                  role="status"
                  aria-label={`发现新版本 ${availableUpdate.version}`}
                  title={`发现新版本 ${availableUpdate.version}`}
                />
              )}
            </NavLink>
          ))}
        </nav>
        <div className="tool-nav">
          {[
            // __*_GROUP__ 占位（见 TOOL_SUBGROUPS）：主工具在原位置展开为可折叠子分组，
            // 看账与正负数凭证标记两个入口同组呈现。
            {
              label: "审计工具",
              ids: [
                "fx_audit",
                "deposit_interest",
                "loan_interest",
                "__FA_GROUP__",
                "__KANZHANG_GROUP__",
                "audipick",
                "audit_roll_forward",
              ],
            },
            {
              label: "效率工具",
              ids: [
                "Excel_Merger",
                "file_list_directory",
                "pdf_to_excel",
                "fuzzy_match",
              ],
            },
            {
              label: "运营工具",
              ids: [
                "ts_manager",
                "confirmation_progress",
                "wp_service_generator",
              ],
            },
          ].map((group) => {
            const entries = group.ids
              .map((id) =>
                TOOL_SUBGROUPS[id]
                  ? id
                  : (catalog.find((t) => t.id === id)?.id ?? null),
              )
              .filter((id): id is string => Boolean(id));
            if (!entries.length) return null;
            return (
              <div key={group.label} className="tool-group">
                <div className="nav-caption">{group.label}</div>
                {entries.map((entry) => {
                  const subgroup = TOOL_SUBGROUPS[entry];
                  if (subgroup) {
                    const tools = subgroup.ids
                      .map((id) => catalog.find((t) => t.id === id))
                      .filter((t): t is ToolManifest => Boolean(t));
                    if (!tools.length) return null;
                    const open = subgroupOpen[subgroup.key] ?? false;
                    return (
                      <div key={entry} className="tool-subgroup">
                        <button
                          type="button"
                          className="tool-subgroup-toggle"
                          aria-expanded={open}
                          onClick={() =>
                            setSubgroupOpen((v) => ({
                              ...v,
                              [subgroup.key]: !open,
                            }))
                          }
                        >
                          <span className="tool-badge">{subgroup.badge}</span>
                          {subgroup.label}
                          <span
                            className={`tool-subgroup-chevron${open ? " open" : ""}`}
                            aria-hidden="true"
                          >
                            ▸
                          </span>
                        </button>
                        {open && (
                          <div className="tool-subgroup-items">
                            {tools.map((t) => (
                              <NavLink
                                key={t.id}
                                to={t.route}
                                className="tool-subgroup-link"
                              >
                                <span className="tool-badge">
                                  {TOOL_BADGE[t.id] ?? t.name.slice(0, 1)}
                                </span>
                                {t.name}
                              </NavLink>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }
                  const tool = catalog.find((t) => t.id === entry);
                  if (!tool) return null;
                  return (
                    <NavLink key={tool.id} to={tool.route}>
                      <span className="tool-badge">
                        {TOOL_BADGE[tool.id] ?? tool.name.slice(0, 1)}
                      </span>
                      {tool.name}
                    </NavLink>
                  );
                })}
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
          <>
            <Routes>
              <Route
                path="/"
                element={
                  <Dashboard catalog={catalog} jobs={Object.values(jobs)} />
                }
              />
              {/* The visible tool is rendered by PersistentToolPages below so
                  route changes hide it instead of destroying its local state. */}
              <Route path="/tools/:toolId" element={null} />
              <Route path="/history" element={<History />} />
              <Route
                path="/settings"
                element={
                  <Settings
                    availableUpdate={availableUpdate}
                    onAvailableUpdateChange={setAvailableUpdate}
                  />
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <PersistentToolPages
              renderPage={(toolId) => (
                <ToolPage catalog={catalog} toolId={toolId} />
              )}
            />
          </>
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
        "操作失败，请检查输入后重试。",
    );
  }
  return "操作失败，请检查输入后重试。";
}

function ToolPage({
  catalog,
  toolId: explicitToolId,
}: {
  catalog: ToolManifest[];
  toolId?: string;
}) {
  const { toolId: routeToolId = "" } = useParams();
  const toolId = explicitToolId ?? routeToolId;
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
  if (tool.id === "wp_service_generator") return <WpServicePage tool={tool} />;
  if (tool.id === "fa_list") return <FaListPage tool={tool} />;
  if (tool.id === "audipick") return <AudiPickPage tool={tool} />;
  if (tool.id === "ts_manager") return <TsManagerParityPage tool={tool} />;
  if (tool.id === "confirmation_progress")
    return <ConfirmationProgressPage tool={tool} />;
  if (tool.id === "file_list_directory")
    return <FileListDirectoryPage tool={tool} />;
  if (tool.id === "pdf_to_excel") return <PdfToExcelPage tool={tool} />;
  if (tool.id === "kanzhang") return <KanzhangParityPage tool={tool} />;
  if (tool.id === "je_sign_mark") return <JeSignMarkPage tool={tool} />;
  if (tool.id === "audit_roll_forward") return <RollForwardPage tool={tool} />;
  if (tool.id === "fx_audit") return <FxAuditPage tool={tool} />;
  if (tool.id === "loan_interest") return <LoanInterestPage tool={tool} />;
  if (tool.id === "deposit_interest")
    return <DepositInterestPage tool={tool} />;
  if (tool.id === "fuzzy_match") return <FuzzyMatchPage tool={tool} />;
  if (tool.id === "fa_dep_calc") return <FaDepCalcPage tool={tool} />;
  if (tool.id === "fa_policy_compare")
    return <FaPolicyComparePage tool={tool} />;
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
      <PageHeader
        eyebrow="WP 服务单生成"
        title={tool.name}
        detail={def.intro}
      />
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
              先检查输入，再启动任务。离开页面后任务仍在后台运行，可回到工具页查看进度。
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
              {error} 请稍后重试。
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
/** 字节数按 KB/MB/GB 显示，缓存占用给人看的时候没人想数零。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function formatUpdateProgress(
  downloaded: number,
  total?: number,
): string {
  if (!total || !Number.isFinite(total) || total <= 0) {
    return `正在下载更新：已下载 ${formatBytes(downloaded)}`;
  }
  const percentage = Math.min(100, Math.round((downloaded / total) * 100));
  return `正在下载更新：${formatBytes(downloaded)} / ${formatBytes(total)}（${percentage}%）`;
}

export function Settings({
  availableUpdate,
  onAvailableUpdateChange,
}: {
  availableUpdate: Update | null;
  onAvailableUpdateChange: (update: Update | null) => void;
}) {
  const [section, setSection] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
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
  // 本地缓存：大表读一次就存一份 Parquet，之后每步都命中缓存。
  // 它只增不减，所以要给用户一个看得见、清得掉的入口。
  const [cacheStat, setCacheStat] = useState<{
    files: number;
    bytes: number;
    oldestDays: number;
    path: string;
  }>();
  const [cacheMode, setCacheMode] = useState<"daily" | "weekly" | "off">(
    "weekly",
  );
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheMessage, setCacheMessage] = useState("");
  const [cacheStatError, setCacheStatError] = useState("");
  const refreshCacheStat = () =>
    engineCall("cache.stat", {})
      .then((v) => {
        setCacheStat(v as typeof cacheStat);
        setCacheStatError("");
      })
      .catch((e) => {
        setCacheStat(undefined);
        setCacheStatError(String(e));
      });
  const [appVersion, setAppVersion] = useState("读取中…");
  useEffect(() => {
    void refreshCacheStat();
  }, []);
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateOpen, setUpdateOpen] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNotes>();
  const [notesError, setNotesError] = useState("");
  const [fallbackNotes, setFallbackNotes] = useState("");
  const [checkedUpdateVersion, setCheckedUpdateVersion] = useState<string>();
  const updateCheckLock = useRef(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
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
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion("未知"));
  }, []);
  async function checkForUpdates() {
    if (updateCheckLock.current || installingUpdate) return;
    updateCheckLock.current = true;
    setUpdateOpen(true);
    setCheckingUpdate(true);
    setReleaseNotes(undefined);
    setNotesError("");
    setFallbackNotes("");
    setCheckedUpdateVersion(undefined);
    setUpdateStatus("正在检查 GitHub Release…");
    try {
      const update = await check({ timeout: 15000 });
      onAvailableUpdateChange(update ?? null);
      setUpdateStatus(
        update
          ? `发现新版本 v${update.version}，正在读取跨版本更新说明…`
          : "当前没有可安装的新版本，正在读取本版更新说明…",
      );
      try {
        const notes = await updateReleaseNotes(update?.version);
        setReleaseNotes(notes);
        setAppVersion(notes.currentVersion);
        if (notes.releases.length === 0 && update?.body)
          setFallbackNotes(update.body);
      } catch (e) {
        setNotesError(
          `更新说明读取失败：${appErrorText(e)}。可以重新检查；未将读取失败视为没有变更。`,
        );
        setFallbackNotes(update?.body ?? "");
      }
      setCheckedUpdateVersion(update?.version);
      setUpdateStatus(
        update
          ? `可从当前版本升级到 v${update.version}。请先查看下方更新内容，再确认安装。`
          : "当前没有可安装的新版本。以下展示本版发布说明（如有）。",
      );
    } catch (e) {
      setUpdateStatus(
        typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)
          ? "浏览器预览模式不能检查或安装更新，请在桌面应用中使用软件更新。"
          : `检查更新失败：${appErrorText(e)}`,
      );
    } finally {
      setCheckingUpdate(false);
      updateCheckLock.current = false;
    }
  }
  async function installUpdate() {
    if (
      !availableUpdate ||
      checkingUpdate ||
      installingUpdate ||
      checkedUpdateVersion !== availableUpdate.version
    )
      return;
    setInstallingUpdate(true);
    setUpdateStatus("正在下载并安装更新，请不要关闭工具箱…");
    let downloadedBytes = 0;
    let totalBytes: number | undefined;
    try {
      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength;
          setUpdateStatus(
            totalBytes
              ? `准备下载更新：共 ${formatBytes(totalBytes)}`
              : "准备下载更新…",
          );
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setUpdateStatus(formatUpdateProgress(downloadedBytes, totalBytes));
        } else if (event.event === "Finished") {
          setUpdateStatus("更新下载完成，正在安装，请不要关闭工具箱…");
        }
      });
      setUpdateStatus("更新安装完成，正在重启工具箱…");
      await relaunch();
    } catch (e) {
      setInstallingUpdate(false);
      setUpdateStatus(
        `安装更新失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
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
        const cache = (value.cache ?? {}) as Record<string, unknown>;
        const mode = String(cache.cleanup ?? "weekly");
        if (mode === "daily" || mode === "weekly" || mode === "off")
          setCacheMode(mode);
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
    if (saving) return;
    setSaving(true);
    setSaveFailed(false);
    setMessage("");
    try {
      await settingsSet({
        llm: {
          ...llmSettings(),
        },
        ocr: { engine: form.ocrEngine },
        cache: { cleanup: cacheMode },
      });
      if (form.apiKey)
        await secretSet(
          form.apiType === "dify_chat" ? "dify_api_key" : "llm_api_key",
          form.apiKey,
        );
      if (form.ocrApiKey) await secretSet("baidu_ocr_key", form.ocrApiKey);
      if (form.ocrSecret) await secretSet("baidu_ocr_secret", form.ocrSecret);
      setForm((x) => ({ ...x, apiKey: "", ocrApiKey: "", ocrSecret: "" }));
      setMessage("配置已保存，相关工具会使用这些设置。");
    } catch (e) {
      setSaveFailed(true);
      setMessage(appErrorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="settings-page">
      <PageHeader
        eyebrow="本机配置"
        title="设置"
        detail="按用途管理工具箱配置；密钥保存在本机凭据管理器。"
        actions={
          <Button
            variant="secondary"
            onClick={() => void checkForUpdates()}
            disabled={checkingUpdate || installingUpdate}
            aria-expanded={updateOpen}
            aria-controls="settings-update-panel"
          >
            {checkingUpdate
              ? "检查中…"
              : installingUpdate
                ? "安装中…"
                : availableUpdate
                  ? `软件更新 · v${availableUpdate.version}`
                  : "软件更新"}
          </Button>
        }
      />
      {updateOpen && (
        <section
          className="list-card settings-update-panel"
          id="settings-update-panel"
          aria-labelledby="settings-update-title"
        >
          <div className="settings-update-heading">
            <div>
              <h2 id="settings-update-title">软件更新</h2>
              <p className="settings-note">
                当前版本：v{appVersion} · 来源：GitHub Releases
              </p>
            </div>
            <Button
              variant="ghost"
              disabled={installingUpdate}
              onClick={() => setUpdateOpen(false)}
            >
              收起
            </Button>
          </div>
          <p role="status" aria-live="polite">
            {updateStatus}
          </p>
          {notesError && (
            <p role="alert" className="settings-test-result failed">
              {notesError}
            </p>
          )}
          {releaseNotes && (
            <div className="settings-release-notes">
              <p>
                {releaseNotes.currentVersion === releaseNotes.targetVersion
                  ? `本版说明 · v${releaseNotes.currentVersion}`
                  : `更新范围：v${releaseNotes.currentVersion} → v${releaseNotes.targetVersion}`}
              </p>
              {releaseNotes.warnings.map((warning, i) => (
                <p className="settings-note" key={i}>
                  {warning}
                </p>
              ))}
              {releaseNotes.releases.map((release) => (
                <article
                  key={release.version}
                  className="settings-release-entry"
                >
                  <h3>
                    v{release.version} · {release.title}
                  </h3>
                  {release.publishedAt && (
                    <p className="settings-note">
                      发布时间：{release.publishedAt.slice(0, 10)}
                    </p>
                  )}
                  <div className="settings-release-body">
                    {release.body || "此版本未填写更新说明。"}
                  </div>
                </article>
              ))}
              {releaseNotes.commits.length > 0 && (
                <article className="settings-release-entry">
                  <h3>升级区间提交记录</h3>
                  <ul>
                    {releaseNotes.commits.map((message, i) => (
                      <li key={i}>{message}</li>
                    ))}
                  </ul>
                </article>
              )}
            </div>
          )}
          {fallbackNotes && (
            <article className="settings-release-entry">
              <h3>更新包附带说明（仅目标版本，非完整区间）</h3>
              <div className="settings-release-body">{fallbackNotes}</div>
            </article>
          )}
          <div className="actions">
            <Button
              variant="secondary"
              disabled={checkingUpdate || installingUpdate}
              onClick={() => void checkForUpdates()}
            >
              重新检查
            </Button>
            {availableUpdate &&
              checkedUpdateVersion === availableUpdate.version && (
                <Button
                  disabled={checkingUpdate || installingUpdate}
                  onClick={() => void installUpdate()}
                >
                  {installingUpdate
                    ? "安装中…"
                    : `确认更新到 v${availableUpdate.version}`}
                </Button>
              )}
          </div>
        </section>
      )}
      <StepIndicator
        steps={[
          { key: "ai", label: "AI 与 OCR" },
          { key: "theme", label: "界面主题" },
          { key: "data", label: "缓存清理" },
        ]}
        current={section}
        onStepClick={setSection}
        showCompleted={false}
      />
      <div className="settings-panels">
        <div hidden={section !== 0} className="settings-group">
          <section className="list-card">
            <h2>统一 LLM 配置</h2>
            <p className="settings-note">
              供各工具的字段复核与智能分析共用。密钥留空表示保留已保存值。
            </p>
            <div className="form-grid">
              <label className="field settings-toggle">
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
            </div>
            <details className="settings-advanced">
              <summary>高级连接选项</summary>
              <div className="form-grid">
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
                  <small>字段复核可能耗时较长，建议设置为 120 秒以上。</small>
                </label>
                <label className="field settings-toggle">
                  <span>思考模式</span>
                  <input
                    type="checkbox"
                    checked={form.thinkingEnabled}
                    onChange={(e) => set("thinkingEnabled", e.target.checked)}
                  />
                </label>
              </div>
            </details>
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
            <p className="settings-note">
              仅用于 AudiPick 扫描件文字识别，按所选引擎显示配置。
            </p>
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
              {form.ocrEngine === "baidu" && (
                <>
                  {" "}
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
                </>
              )}
            </div>
            {form.ocrEngine === "ai" && (
              <p className="settings-note">
                沿用上方统一 LLM 配置，无需额外密钥。
              </p>
            )}
            {form.ocrEngine === "local" && (
              <p className="settings-note">请先启动已配置的本机 OCR 服务。</p>
            )}
          </section>
        </div>
        <div hidden={section !== 1} className="settings-group">
          <section className="list-card">
            <h2>界面主题</h2>
            <p className="settings-note">
              选择后立即生效并自动保存，无需再点击保存配置。
            </p>
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
                  aria-pressed={theme === t.id}
                  onClick={() => applyTheme(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </section>
        </div>
        <div hidden={section !== 2} className="settings-group">
          <section className="list-card">
            <h2>本地缓存</h2>
            <p>
              缓存读过的科目余额表与序时账，再次打开同一份文件直接命中，不必重新解析。
            </p>
            <p className="cache-usage">
              {cacheStat
                ? `已缓存 ${formatBytes(cacheStat.bytes)}`
                : cacheStatError
                  ? "占用读取失败"
                  : "读取中…"}
            </p>
            <label className="field">
              <span>自动清理</span>
              <select
                value={cacheMode}
                onChange={(e) =>
                  setCacheMode(e.target.value as typeof cacheMode)
                }
              >
                {/* 说明写进选项本身：选「每天」不是每天清空，是每天清掉没再用过的。 */}
                <option value="daily">每天清理未使用的缓存</option>
                <option value="weekly">每周清理未使用的缓存</option>
                <option value="off">不自动清理</option>
              </select>
            </label>
            <div className="actions">
              <button
                className="secondary"
                disabled={cacheBusy || cacheStat?.bytes === 0}
                onClick={() => {
                  setCacheBusy(true);
                  setCacheMessage("");
                  void engineCall("cache.clear", {})
                    .then((v) => {
                      const r = v as {
                        removed: number;
                        freed: number;
                        failed: number;
                      };
                      setCacheMessage(
                        `已清理 ${r.removed} 个文件，释放 ${formatBytes(r.freed)}` +
                          (r.failed ? `；${r.failed} 个正在使用，未清理` : ""),
                      );
                      return refreshCacheStat();
                    })
                    .catch((e) => setCacheMessage(String(e)))
                    .finally(() => setCacheBusy(false));
                }}
              >
                {cacheBusy
                  ? "清理中…"
                  : cacheStat && cacheStat.bytes > 0
                    ? `立刻清理全部（${formatBytes(cacheStat.bytes)}）`
                    : "立刻清理全部"}
              </button>
            </div>
            {cacheMessage && <p className="cache-result">{cacheMessage}</p>}
          </section>
          <details className="list-card settings-advanced">
            <summary>AudiPick 旧数据迁移（按需使用）</summary>
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
                  void pickPath("file", "选择 AudiPick 迁移备份", [
                    "json",
                  ]).then((v) => setBackupPath(typeof v === "string" ? v : ""))
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
                    .then((r) => {
                      setSaveFailed(false);
                      setMessage(JSON.stringify(r));
                    })
                    .catch((e) => {
                      setSaveFailed(true);
                      setMessage(appErrorText(e));
                    })
                }
              >
                导入并校验
              </button>
            </div>
          </details>
        </div>
      </div>
      {message && (
        <div
          role={saveFailed ? "alert" : "status"}
          className={`settings-test-result ${saveFailed ? "failed" : "success"}`}
        >
          {message}
        </div>
      )}
      {(section === 0 || section === 2) && (
        <div className="settings-save-bar">
          <span>配置修改后需保存；测试连接不会自动保存。</span>
          <button
            className="primary"
            disabled={saving || testingLlm}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      )}
    </div>
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
