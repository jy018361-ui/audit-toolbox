import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ComponentType, ReactElement } from "react";
import {
  matchPath,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import "./app-shell.css";
import {
  appBootstrap,
  engineCall,
  historyGet,
  historyClear,
  historyRestore,
  invalidateHistoryCache,
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
import { historyRowCanResume, publishTaskRestore } from "./restore";
import type { ReleaseNotes } from "./updateNotes";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { useCountUp } from "./lib/useCountUp";
import { SwitchInput } from "@/components/SwitchInput";
import { demoDataEnabled } from "./preview/demoRegistry";
import {
  TOOL_DEFINITIONS,
  type ActionDefinition,
  type FieldDefinition,
} from "./toolDefinitions";
import type {
  Bootstrap,
  HistoryRow,
  JobEvent,
  ToolManifest,
} from "./types";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { RestoreBanner } from "@/components/RestoreBanner";
import { WindowControls } from "@/components/WindowControls";
import { PersistentToolPages } from "@/components/PersistentToolPages";
import { JobDialogProvider } from "@/components/JobDialog";
import { ConfirmDialogHost, confirmDialog } from "@/components/ConfirmDialog";
import { SyncBusyDialog } from "@/components/SyncBusyDialog";
import { StepIndicator } from "@/components/StepIndicator";
import { ResultView } from "@/components/ResultView";
import { EmptyState } from "@/components/EmptyState";
import { DataHandlingNotice } from "@/components/DataHandlingNotice";
import { BeginnerTour } from "@/components/tour/BeginnerTour";
import { SuccessNudge } from "@/components/tour/SuccessNudge";
import {
  buildToolTourSteps,
  workspaceTourSteps,
} from "@/components/tour/tourSteps";
import {
  isTauriRuntime,
  loadTourState,
  saveTourState,
} from "@/components/tour/tourState";
import { ToolTourProvider } from "@/components/tour/ToolTourContext";
import { NewbieModeToggle } from "@/components/tour/NewbieModeToggle";
import { Sparkles } from "lucide-react";
import { applyReadableForegrounds } from "./theme";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

const TsManagerParityPage = lazy(() =>
  import("./TsManagerParityPage").then((m) => ({
    default: m.TsManagerParityPage,
  })),
);
const TbjeCheckPage = lazy(() =>
  import("./TbjeCheckPage").then((m) => ({ default: m.TbjeCheckPage })),
);
const ConfirmationProgressPage = lazy(
  () => import("./ConfirmationProgressPage"),
);
const FileListDirectoryPage = lazy(() => import("./FileListDirectoryPage"));
const PdfToExcelPage = lazy(() => import("./PdfToExcelPage"));
const KanzhangParityPage = lazy(() =>
  import("./KanzhangParityPage").then((m) => ({
    default: m.KanzhangParityPage,
  })),
);
const JeSignMarkPage = lazy(() =>
  import("./JeSignMarkPage").then((m) => ({ default: m.JeSignMarkPage })),
);
const FaListPage = lazy(() =>
  import("./FaListPage").then((m) => ({ default: m.FaListPage })),
);
const ExcelMergerPage = lazy(() =>
  import("./ExcelMergerPage").then((m) => ({ default: m.ExcelMergerPage })),
);
const AudiPickPage = lazy(() =>
  import("./AudiPickPage").then((m) => ({ default: m.AudiPickPage })),
);
const WpServicePage = lazy(() =>
  import("./WpServicePage").then((m) => ({ default: m.WpServicePage })),
);
const RollForwardPage = lazy(() =>
  import("./RollForwardPage").then((m) => ({ default: m.RollForwardPage })),
);
const FxAuditPage = lazy(() =>
  import("./FxAuditPage").then((m) => ({ default: m.FxAuditPage })),
);
const LoanInterestPage = lazy(() =>
  import("./LoanInterestPage").then((m) => ({ default: m.LoanInterestPage })),
);
const DepositInterestPage = lazy(() =>
  import("./DepositInterestPage").then((m) => ({
    default: m.DepositInterestPage,
  })),
);
const FuzzyMatchPage = lazy(() =>
  import("./FuzzyMatchPage").then((m) => ({ default: m.FuzzyMatchPage })),
);
const FaDepCalcPage = lazy(() =>
  import("./FaDepCalcPage").then((m) => ({ default: m.FaDepCalcPage })),
);
const FaPolicyComparePage = lazy(() =>
  import("./FaPolicyComparePage").then((m) => ({
    default: m.FaPolicyComparePage,
  })),
);

const DEDICATED_TOOL_PAGES: Record<
  string,
  ComponentType<{ tool: ToolManifest }>
> = {
  Excel_Merger: ExcelMergerPage,
  wp_service_generator: WpServicePage,
  fa_list: FaListPage,
  audipick: AudiPickPage,
  ts_manager: TsManagerParityPage,
  tbje_check: TbjeCheckPage,
  confirmation_progress: ConfirmationProgressPage,
  file_list_directory: FileListDirectoryPage,
  pdf_to_excel: PdfToExcelPage,
  kanzhang: KanzhangParityPage,
  je_sign_mark: JeSignMarkPage,
  audit_roll_forward: RollForwardPage,
  fx_audit: FxAuditPage,
  loan_interest: LoanInterestPage,
  deposit_interest: DepositInterestPage,
  fuzzy_match: FuzzyMatchPage,
  fa_dep_calc: FaDepCalcPage,
  fa_policy_compare: FaPolicyComparePage,
};

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
  tbje_check: "核",
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

const TOOL_GROUPS = [
  {
    label: "审计工具",
    ids: [
      "tbje_check",
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
    ids: ["Excel_Merger", "file_list_directory", "pdf_to_excel", "fuzzy_match"],
  },
  {
    label: "运营工具",
    ids: ["ts_manager", "confirmation_progress", "wp_service_generator"],
  },
] as const;

function expandedToolIds(ids: readonly string[]) {
  return ids.flatMap((id) => TOOL_SUBGROUPS[id]?.ids ?? [id]);
}

const DEVELOPMENT_HINT = "试用功能，使用结果请复核。";

/**
 * 侧边栏工具入口统一消费清单里的 migrationStatus。
 * preview 工具仍可进入，但必须在点击前让用户知道它还在开发中；状态不写死
 * 在具体工具名上，后续工具转正只需修改 tool-catalog.json。
 */
function SidebarToolLink({
  tool,
  className,
}: {
  tool: ToolManifest;
  className?: string;
}) {
  const developing = tool.migrationStatus === "preview";
  const accessibleName = developing
    ? `${tool.name}，试用。${DEVELOPMENT_HINT}`
    : undefined;
  return (
    <NavLink
      to={tool.route}
      className={className}
      title={developing ? DEVELOPMENT_HINT : undefined}
      aria-label={accessibleName}
    >
      <span className="tool-badge">
        {TOOL_BADGE[tool.id] ?? tool.name.slice(0, 1)}
      </span>
      <span className="tool-nav-label">{tool.name}</span>
      {developing && (
        <span className="tool-status-badge" aria-hidden="true">
          试用
        </span>
      )}
    </NavLink>
  );
}

export default function App() {
  const location = useLocation();
  const [catalog, setCatalog] = useState<ToolManifest[]>([]);
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [jobs, setJobs] = useState<Record<string, JobEvent>>({});
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [startupReady, setStartupReady] = useState(false);
  const [startupError, setStartupError] = useState("");
  const automaticUpdateCheckStarted = useRef(false);
  const [toolDrawerOpen, setToolDrawerOpen] = useState(false);
  const toolDrawerButton = useRef<HTMLButtonElement>(null);
  const previousPath = useRef(location.pathname);
  // 侧边栏子分组默认展开：折叠头不是路由入口，收着会让高频工具"消失"。
  const [subgroupOpen, setSubgroupOpen] = useState<Record<string, boolean>>({
    fa: true,
    kanzhang: true,
  });
  // 新手模式：会话状态只记"当前在播哪条引导"；看过与否存 localStorage
  // （tourState.ts），首次启动与首次进工具时自动播放，之后可在设置里重播。
  const [tour, setTour] = useState<
    { kind: "workspace" } | { kind: "tool"; toolId: string } | null
  >(null);
  const activeToolId = matchPath("/tools/:toolId", location.pathname)?.params
    .toolId ?? null;
  const tourTool =
    tour?.kind === "tool"
      ? catalog.find((tool) => tool.id === tour.toolId)
      : undefined;
  const finishTour = () => {
    // 「看过」只在桌面端持久化：浏览器预览是开发/体验入口，
    // 每次进工具都重播导览，方便逐个检查剧本内容。
    if (isTauriRuntime()) {
      if (tour?.kind === "workspace") saveTourState({ workspaceDone: true });
      if (tour?.kind === "tool") {
        saveTourState({
          toolDone: { ...loadTourState().toolDone, [tour.toolId]: true },
        });
      }
    }
    setTour(null);
  };
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
    // 首次清理同样延后：它要遍历缓存目录删文件，和首屏抢磁盘。
    const first = setTimeout(() => void sweep(), 3000);
    const timer = setInterval(() => void sweep(), 60 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (previousPath.current !== location.pathname && toolDrawerOpen) {
      window.setTimeout(() => toolDrawerButton.current?.focus(), 0);
    }
    previousPath.current = location.pathname;
    setToolDrawerOpen(false);
    // Closing is driven by route changes; including the open flag would close
    // the drawer immediately after its trigger is pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);
  // 首次启动自动播放工作台导览。只在桌面端生效：浏览器预览是开发者视角，
  // 每次清缓存都会弹，打扰大于帮助；桌面用户只会在真正首次使用时遇到一次。
  useEffect(() => {
    if (!startupReady || !isTauriRuntime()) return;
    const state = loadTourState();
    if (state.newbieMode === false || state.workspaceDone) return;
    // 等首屏渲染完再弹，避免引导和启动画面抢注意力。
    const timer = setTimeout(
      () => setTour((current) => current ?? { kind: "workspace" }),
      1000,
    );
    return () => clearTimeout(timer);
  }, [startupReady]);
  // 第一次进入某个工具时自动播放该工具的上手引导；总开关关掉或看过就不再弹。
  useEffect(() => {
    if (!startupReady || !activeToolId || tour) return;
    const state = loadTourState();
    if (state.newbieMode === false) return;
    if (state.toolDone?.[activeToolId]) return;
    if (!catalog.some((tool) => tool.id === activeToolId)) return;
    // 延迟触发给懒加载页面留出首绘时间；引擎内部还会轮询等待目标元素。
    const timer = setTimeout(() => setTour({ kind: "tool", toolId: activeToolId }), 800);
    return () => clearTimeout(timer);
  }, [activeToolId, tour, catalog, startupReady]);
  useEffect(() => {
    if (!toolDrawerOpen) return;
    const sidebar = document.getElementById("app-sidebar");
    const focusable = () => Array.from(sidebar?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex="0"]',
    ) ?? []).filter((element) => getComputedStyle(element).display !== "none");
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || !sidebar?.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !sidebar?.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      setToolDrawerOpen(false);
      toolDrawerButton.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toolDrawerOpen]);
  useEffect(() => {
    void Promise.all([toolCatalog(), appBootstrap()])
      .then(([c, b]) => {
        setCatalog(c);
        setBootstrap(b);
      })
      .catch((error) => setStartupError(appErrorText(error)))
      .finally(() => setStartupReady(true));
    void listenJobEvents((e) => {
      invalidateHistoryCache();
      setJobs((v) => ({ ...v, [e.jobId]: e }));
    }).catch(() => undefined);
  }, []);
  // 开发窗口和安装版界面完全一样，开发环境保留一个低权重标记以免误测旧安装版。
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    document.title = "E点通工具箱（开发环境）";
    // 浏览器/测试环境没有原生窗口，只有 Tauri 里才改标题。
    if (!("__TAURI_INTERNALS__" in window)) return;
    void getCurrentWebviewWindow()
      .setTitle("E点通工具箱（开发环境）")
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (automaticUpdateCheckStarted.current) return;
    automaticUpdateCheckStarted.current = true;
    // 延后再查更新：这条要连 GitHub，国内网络经常一路等到超时，和首屏抢
    // 网络与 CPU 会让刚出来的界面发木。晚几秒不影响任何用户可见行为。
    const timer = setTimeout(() => {
      void check()
        .then((update) => setAvailableUpdate(update ?? null))
        .catch(() => {
          // 启动时的检查保持静默；断网不该打断用户工作，仍可在设置页手动重试。
        });
    }, 5000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <JobDialogProvider
      jobs={Object.values(jobs)}
      nameOf={(toolId) =>
        catalog.find((tool) => tool.id === toolId)?.name ?? toolId
      }
    >
      <SyncBusyDialog />
      <ConfirmDialogHost />
      <div className="app-shell">
        <a className="skip-navigation" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>跳过导航，进入工作区</a>
        <WindowControls />
        <aside
          id="app-sidebar"
          className={`sidebar${toolDrawerOpen ? " drawer-open" : ""}`}
        >
          {/* deep：整个品牌区（含文字周围的空白）都是拖拽手柄，双击最大化；
              里面的抽屉关闭按钮不带该属性，点击优先于拖拽 */}
          <div className="brand" data-tauri-drag-region="deep">
            <button
              type="button"
              className="sidebar-drawer-close"
              aria-label="关闭工具导航"
              onClick={() => {
                setToolDrawerOpen(false);
                toolDrawerButton.current?.focus();
              }}
            >
              ×
            </button>
            <h1>E点通工具箱</h1>
            <p>审计作业工作台</p>
          </div>
          <nav data-tour="sidebar-nav">
            {NAV.map((x) => (
              <NavLink
                key={x.to}
                to={x.to}
                end={x.to === "/"}
                data-tour={
                  x.to === "/history"
                    ? "nav-history"
                    : x.to === "/settings"
                      ? "nav-settings"
                      : undefined
                }
              >
                <span className="nav-icon">{NAV_ICON[x.to]}</span>
                <span>{x.label}</span>
                {x.to === "/settings" && availableUpdate && (
                  <span
                    className="nav-update-badge"
                    role="status"
                    aria-label={`发现新版本 ${availableUpdate.version}`}
                    title={`发现新版本 ${availableUpdate.version}`}
                  >
                    更新
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="tool-nav" data-tour="sidebar-tools">
            {TOOL_GROUPS.map((group) => {
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
                                <SidebarToolLink
                                  key={t.id}
                                  tool={t}
                                  className="tool-subgroup-link"
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    }
                    const tool = catalog.find((t) => t.id === entry);
                    if (!tool) return null;
                    return <SidebarToolLink key={tool.id} tool={tool} />;
                  })}
                </div>
              );
            })}
          </div>
          {/* 新手模式总开关：与导航行同款的一行小设置，常驻侧边栏底部。 */}
          <NewbieModeToggle />
          <div className="sidebar-footer">
            {demoDataEnabled() && (
              <span
                className="dev-build-badge"
                title="演示数据已开启：浏览器预览模式下用仓库内样例回放引擎返回，便于检查有数据的布局"
              >
                演示数据
              </span>
            )}
            {import.meta.env.DEV && (
              <span
                className="dev-build-badge"
                title="开发版窗口：运行的是本机最新代码，新功能先在这里出现"
              >
                开发环境
              </span>
            )}
            <span>v{bootstrap?.appVersion ?? "…"}</span>
          </div>
        </aside>
        <nav className="sidebar-rail" aria-label="紧凑导航">
          <button
            ref={toolDrawerButton}
            type="button"
            className="sidebar-rail-menu"
            aria-label="打开工具导航"
            aria-expanded={toolDrawerOpen}
            aria-controls="app-sidebar"
            onClick={() => setToolDrawerOpen(true)}
          >
            <span aria-hidden="true">ET</span>
          </button>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              aria-label={item.label}
              title={item.label}
            >
              {NAV_ICON[item.to]}
            </NavLink>
          ))}
        </nav>
        {toolDrawerOpen && (
          <button
            type="button"
            className="sidebar-drawer-backdrop"
            aria-label="关闭工具导航"
            onClick={() => {
              setToolDrawerOpen(false);
              toolDrawerButton.current?.focus();
            }}
          />
        )}
        {/* 裸 drag-region：只有直接点在 main 自身（顶部 44px 标题栏条带和
            四周留白）时才拖拽/双击最大化，卡片等子元素不受影响 */}
        <main
          className="main"
          id="main-content"
          tabIndex={-1}
          data-tauri-drag-region
        >
          {!startupReady ? (
            <AppLoading />
          ) : startupError ? (
            <SimplePage
              title="启动失败"
              text={`${startupError} 请刷新后重试。`}
            />
          ) : (
            <>
              <RestoreBanner catalog={catalog} />
              <Routes>
                <Route
                  path="/"
                  element={
                    <Dashboard
                      catalog={catalog}
                      jobs={Object.values(jobs)}
                      onStartWorkspaceTour={() =>
                        setTour({ kind: "workspace" })
                      }
                    />
                  }
                />
                {/* The visible tool is rendered by PersistentToolPages below so
                  route changes hide it instead of destroying its local state. */}
                <Route path="/tools/:toolId" element={null} />
                <Route
                  path="/history"
                  element={<History catalog={catalog} />}
                />
                <Route
                  path="/settings"
                  element={
                    <Settings
                      availableUpdate={availableUpdate}
                      onAvailableUpdateChange={setAvailableUpdate}
                      onReplayWorkspaceTour={() =>
                        setTour({ kind: "workspace" })
                      }
                    />
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              <PersistentToolPages
                keepAliveToolIds={Object.values(jobs)
                  .filter(
                    (job) =>
                      !["completed", "failed", "cancelled"].includes(job.phase),
                  )
                  .map((job) => job.toolId)}
                renderPage={(toolId) => (
                  <ToolTourProvider toolId={toolId}>
                    <ToolPage catalog={catalog} toolId={toolId} />
                  </ToolTourProvider>
                )}
              />
            </>
          )}
        </main>
      </div>
      {/* 新手引导浮层：挂在 JobDialogProvider 内、应用外壳之外，
          全屏 fixed 定位不参与布局。 */}
      {tour?.kind === "workspace" && (
        <BeginnerTour
          key="workspace"
          steps={workspaceTourSteps}
          onFinish={finishTour}
        />
      )}
      {tourTool && (
        <BeginnerTour
          key={`tool-${tourTool.id}`}
          steps={buildToolTourSteps(tourTool)}
          onFinish={finishTour}
        />
      )}
      {/* 任务完成的轻量反馈：与新手引导同层（外壳之外），只在新手模式开时出现。 */}
      <SuccessNudge
        jobs={Object.values(jobs)}
        toolNameOf={(toolId) =>
          catalog.find((t) => t.id === toolId)?.name ?? toolId
        }
      />
    </JobDialogProvider>
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

function ToolPageLoading() {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <span className="loading-dot" aria-hidden="true" />
      <div>
        <strong>正在打开工具…</strong>
        <p>首次使用时加载对应模块，之后会直接复用。</p>
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
  onStartWorkspaceTour,
}: {
  catalog: ToolManifest[];
  jobs: JobEvent[];
  onStartWorkspaceTour: () => void;
}) {
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    void historyGet()
      .then(setHistory)
      .catch(() => undefined);
  }, []);
  const running = jobs.filter(
    (job) => !["completed", "failed", "cancelled"].includes(job.phase),
  );
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const finishedToday = history.filter(
    (row) =>
      row.status === "completed" &&
      new Date(String(row.startedAt ?? "")).getTime() >= startOfToday,
  ).length;
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
        eyebrow="E点通工具箱 · 工作台"
        title="今天要处理什么？"
        detail="从最近使用继续，或按作业类型选择工具。"
        actions={
          <Button variant="outline" size="sm" onClick={onStartWorkspaceTour}>
            <Sparkles aria-hidden="true" />
            新手引导
          </Button>
        }
      />
      <DataHandlingNotice
        mode="network-assisted"
        className="dashboard-data-notice"
        title="数据处理边界"
        description="多数文件处理在本机完成；启用 AI 或云端 OCR 时，会按你在设置中的配置调用外部服务。"
        details="历史记录只保存任务状态、时间、输出路径和任务输入参数（用于「继续任务」恢复现场），不保存客户表格内容。"
      />
      <section className="metrics">
        <Metric label="进行中任务" value={String(running.length)} />
        <Metric label="今天完成" value={String(finishedToday)} />
        <Metric label="累计任务" value={String(history.length)} />
      </section>
      {recentTools.length > 0 && (
        <section
          className="recent-tools"
          aria-labelledby="recent-tools-title"
          data-tour="recent-tools"
        >
          <h2 id="recent-tools-title">最近使用</h2>
          <div>
            {recentTools.map((tool) => (
              <NavLink className="recent-chip" to={tool.route} key={tool.id}>
                {tool.name}
                <small>
                  {relativeTime(
                    String(
                      history.find((row) => row.toolId === tool.id)
                        ?.startedAt ?? "",
                    ),
                  )}
                </small>
              </NavLink>
            ))}
          </div>
        </section>
      )}
      <div className="dashboard-tool-groups" data-tour="dashboard-tool-groups">
        {TOOL_GROUPS.map((group) => {
          const tools = expandedToolIds(group.ids)
            .map((id) => catalog.find((tool) => tool.id === id))
            .filter((tool): tool is ToolManifest => Boolean(tool));
          if (!tools.length) return null;
          const headingId = `dashboard-${group.label}`;
          return (
            <section
              className="dashboard-tool-group"
              aria-labelledby={headingId}
              key={group.label}
            >
              <div className="dashboard-section-heading">
                <h2 id={headingId}>{group.label}</h2>
                <span>{tools.length} 个工具</span>
              </div>
              <div className="card-grid">
                {tools.map((tool) => {
                  const preview = tool.migrationStatus === "preview";
                  return (
                    <NavLink
                      className="tool-card"
                      to={tool.route}
                      key={tool.id}
                    >
                      <div className="tool-card-heading">
                        <span className="tool-card-badge" aria-hidden="true">
                          {TOOL_BADGE[tool.id] ?? tool.name.slice(0, 1)}
                        </span>
                        <h3>{tool.name}</h3>
                        {preview && (
                          <span className="tool-card-status">试用</span>
                        )}
                      </div>
                      <p>{tool.description}</p>
                      <strong>
                        打开工具 <span aria-hidden="true">→</span>
                      </strong>
                    </NavLink>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
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
        setError(payload?.error ? errorText(payload.error) : event.message);
      }
    });
    return () => {
      void stop.then((fn) => fn());
    };
  }, []);
  if (!tool || !def)
    return <SimplePage title="工具不存在" text="工具登记信息尚未加载。" />;
  const DedicatedPage = DEDICATED_TOOL_PAGES[tool.id];
  if (DedicatedPage)
    return (
      <>
      {tool.migrationStatus === "preview" && (
        <div className="tool-trial-notice" role="note">
          <strong>试用</strong><span>{DEVELOPMENT_HINT}</span>
        </div>
      )}
      <Suspense fallback={<ToolPageLoading />}>
        <DedicatedPage tool={tool} />
      </Suspense>
      </>
    );
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
        eyebrow="审计作业工具"
        title={tool.name}
        detail={def.intro}
      />
      <StepIndicator
        steps={[
          { key: "1", label: "任务配置", disabled: true },
          { key: "2", label: "检查输入", disabled: true },
          { key: "3", label: "生成结果", disabled: true },
        ]}
        current={busy || job || result ? 2 : missing.length ? 0 : 1}
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
              <Button
                disabled={busy}
                variant={a.tone === "primary" ? "default" : "secondary"}
                key={a.method}
                onClick={() => void run(a)}
              >
                {busy ? "处理中…" : a.label}
              </Button>
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
          ) : busy ? (
            <div className="skeleton-rows" role="status" aria-label="任务处理中">
              <i />
              <i />
              <i />
            </div>
          ) : (
            <EmptyState title="尚未生成结果" description="先检查输入，再启动任务。离开页面后任务仍在后台运行，可回到工具页查看进度。" />
          )}
        </section>
      </div>
    </>
  );
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
        <SwitchInput
          checked={Boolean(value)}
          onChange={onChange}
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

const HISTORY_STATUS: Record<
  string,
  { label: string; tone: "ready" | "danger" | "preview" }
> = {
  completed: { label: "已完成", tone: "ready" },
  success: { label: "已完成", tone: "ready" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "preview" },
  canceled: { label: "已取消", tone: "preview" },
  running: { label: "处理中", tone: "preview" },
  queued: { label: "等待中", tone: "preview" },
  paused: { label: "已暂停", tone: "preview" },
};

function History({ catalog }: { catalog: ToolManifest[] }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restoringJobId, setRestoringJobId] = useState("");
  const [restoreError, setRestoreError] = useState("");
  useEffect(() => {
    void historyGet()
      .then(setRows)
      .catch((reason) => setError(appErrorText(reason)))
      .finally(() => setLoading(false));
  }, []);
  async function resume(row: HistoryRow) {
    const tool = catalog.find((t) => t.id === row.toolId);
    if (!tool) {
      setRestoreError("该工具已不在工具箱中，无法恢复。");
      return;
    }
    setRestoreError("");
    setRestoringJobId(row.jobId);
    try {
      // Rust 侧同时把仍存在的原输入路径重新授权，回填后即可直接运行。
      const restore = await historyRestore(row.jobId);
      publishTaskRestore(restore);
      navigate(tool.route);
    } catch (reason) {
      setRestoreError(appErrorText(reason));
    } finally {
      setRestoringJobId("");
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="可追踪结果"
        title="历史记录"
        detail="记录任务状态、时间和输出路径；输入参数仅用于「继续任务」恢复现场，不保存客户表格内容。"
      />
      <Card className="history-card">
        <CardContent className="history-card-content">
          {loading ? (
            <div role="status" aria-live="polite">
              <EmptyState
                compact
                title="正在读取历史记录…"
                description="正在从本机任务记录中读取。"
              />
            </div>
          ) : error ? (
            <div className="error-box" role="alert">
              {error} 请稍后重试。
            </div>
          ) : rows.length ? (
            <>
              {restoreError && (
                <div className="error-box" role="alert">
                  {restoreError}
                </div>
              )}
              {rows.map((row, index) => {
                const toolId = String(row.toolId ?? "");
                const status =
                  HISTORY_STATUS[String(row.status ?? "")] ??
                  ({ label: "状态未知", tone: "preview" } as const);
                const outputCount = Array.isArray(row.outputPaths)
                  ? row.outputPaths.length
                  : 0;
                // 读取/筛选这类子步骤的存档只有部分配置，不给恢复按钮。
                const canResume = historyRowCanResume({
                  method: row.method,
                  params: row.params,
                });
                const restoring = restoringJobId === row.jobId;
                return (
                  <article className="task-row" key={String(row.jobId ?? index)}>
                    <div className="task-row-copy">
                      <strong>
                        {catalog.find((tool) => tool.id === toolId)?.name ||
                          "未知工具"}
                      </strong>
                      <p>{String(row.message ?? status.label)}</p>
                    </div>
                    <div className="task-row-meta">
                      <time dateTime={String(row.startedAt ?? "")}>
                        {formatHistoryTime(row.startedAt)}
                      </time>
                      <span>
                        {outputCount > 0
                          ? `输出 ${outputCount} 个文件`
                          : "无输出文件"}
                      </span>
                      {canResume && (
                        <Button
                          variant="secondary"
                          disabled={restoringJobId !== ""}
                          onClick={() => void resume(row)}
                        >
                          {restoring ? "恢复中…" : "继续任务"}
                        </Button>
                      )}
                    </div>
                    <span className={`pill ${status.tone}`}>{status.label}</span>
                  </article>
                );
              })}
            </>
          ) : (
            <EmptyState
              title="还没有任务记录"
              description="完成任务后，这里会显示处理状态、时间和输出文件数量。"
              action={
                <NavLink className="primary empty-state-link" to="/">
                  返回工作台
                </NavLink>
              }
            />
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

function settingsSignature(form: Record<string, unknown>, cacheMode: string) {
  return JSON.stringify({ form, cacheMode });
}

export function Settings({
  availableUpdate,
  onAvailableUpdateChange,
  onReplayWorkspaceTour,
}: {
  availableUpdate: Update | null;
  onAvailableUpdateChange: (update: Update | null) => void;
  onReplayWorkspaceTour: () => void;
}) {
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
  const [clearHistoryWithCache, setClearHistoryWithCache] = useState(false);
  const savedSettingsSignature = useRef<string | undefined>(undefined);
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
  // 更新说明全是空的时候，说明区直接收敛为一个提交记录块，不再渲染“未填写说明”相关的标题与提示。
  const allReleaseBodiesEmpty =
    !!releaseNotes &&
    releaseNotes.releases.length > 0 &&
    releaseNotes.releases.every((release) => !release.body);
  const [checkedUpdateVersion, setCheckedUpdateVersion] = useState<string>();
  const updateCheckLock = useRef(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    downloaded: number;
    total?: number;
  }>();
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
    setDownloadProgress(undefined);
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
      // 检查结束后的结论由标题区（徽章 + 版本行）表达，状态条只留给进行中的进度与失败信息，
      // 不再重复叙述“当前没有新版本 / 可升级到某版”。
      setUpdateStatus("");
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
    setDownloadProgress({ downloaded: 0 });
    setUpdateStatus("正在下载并安装更新，请不要关闭工具箱…");
    let downloadedBytes = 0;
    let totalBytes: number | undefined;
    try {
      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength;
          setDownloadProgress({ downloaded: 0, total: totalBytes });
          setUpdateStatus(
            totalBytes
              ? `准备下载更新：共 ${formatBytes(totalBytes)}`
              : "准备下载更新…",
          );
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setDownloadProgress({
            downloaded: downloadedBytes,
            total: totalBytes,
          });
          setUpdateStatus(formatUpdateProgress(downloadedBytes, totalBytes));
        } else if (event.event === "Finished") {
          setDownloadProgress({
            downloaded: totalBytes ?? downloadedBytes,
            total: totalBytes,
          });
          setUpdateStatus("更新下载完成，正在安装，请不要关闭工具箱…");
        }
      });
      setUpdateStatus("更新安装完成，正在重启工具箱…");
      await relaunch();
    } catch (e) {
      setInstallingUpdate(false);
      setDownloadProgress(undefined);
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
        setForm((x) => {
          const next = {
            ...x,
            enabled: Boolean(llm.enabled),
            apiType: String(llm.api_type ?? x.apiType),
            baseUrl: String(llm.base_url ?? x.baseUrl),
            model: String(llm.model ?? ""),
            authMode: String(llm.auth_mode ?? x.authMode),
            timeout: String(llm.timeout ?? x.timeout),
            thinkingEnabled: Boolean(llm.thinking_enabled),
            ocrEngine: String(ocr.engine ?? x.ocrEngine),
          };
          const cache = (value.cache ?? {}) as Record<string, unknown>;
          const mode = String(cache.cleanup ?? "weekly");
          const nextCacheMode =
            mode === "daily" || mode === "weekly" || mode === "off"
              ? mode
              : "weekly";
          savedSettingsSignature.current = settingsSignature(
            next,
            nextCacheMode,
          );
          return next;
        });
        const cache = (value.cache ?? {}) as Record<string, unknown>;
        const mode = String(cache.cleanup ?? "weekly");
        if (mode === "daily" || mode === "weekly" || mode === "off")
          setCacheMode(mode);
      })
      .catch(() => undefined);
  }, []);
  const dirty =
    savedSettingsSignature.current !== undefined &&
    settingsSignature(form, cacheMode) !== savedSettingsSignature.current;
  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const confirmLinkNavigation = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(
        "a[href]",
      );
      if (!link || !document.contains(link)) return;
      // 同意离开后由 confirmDialog 回调补发的合成点击：放行这一次，避免二次弹窗
      if (link.dataset.confirmBypass) {
        delete link.dataset.confirmBypass;
        return;
      }
      // 确认是异步的，必须在事件同步阶段先拦下原生跳转，再按结果决定是否补发
      event.preventDefault();
      event.stopPropagation();
      void confirmDialog({
        title: "放弃未保存的修改？",
        message: "设置尚未保存，确定离开并放弃这些修改吗？",
        confirmLabel: "离开",
        tone: "danger",
      }).then((ok) => {
        if (!ok) return;
        link.dataset.confirmBypass = "1";
        link.click();
      });
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("click", confirmLinkNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", confirmLinkNavigation, true);
    };
  }, [dirty]);
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
      const savedForm = {
        ...form,
        apiKey: "",
        ocrApiKey: "",
        ocrSecret: "",
      };
      savedSettingsSignature.current = settingsSignature(savedForm, cacheMode);
      setForm(savedForm);
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
            className={`settings-update-trigger${availableUpdate ? " has-update" : ""}`}
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
                  ? `发现新版本 v${availableUpdate.version}`
                  : "软件更新"}
          </Button>
        }
      />
      {updateOpen && (
        /*
         * UI v1：让用户先确认版本，再看状态，最后按需阅读说明。
         * 提交记录默认折叠，避免实现细节压过面向用户的更新内容。
         */
        <section
          className="list-card settings-update-panel"
          id="settings-update-panel"
          aria-labelledby="settings-update-title"
        >
          <div className="settings-update-heading">
            <div className="settings-update-title-block">
              <h2 id="settings-update-title">
                {availableUpdate
                  ? `可更新至 v${availableUpdate.version}`
                  : "软件更新"}
              </h2>
              <p className="settings-note">
                {availableUpdate
                  ? `当前 v${appVersion} → 新版 v${availableUpdate.version}`
                  : `当前版本：v${appVersion} · 来源：GitHub Releases`}
              </p>
            </div>
            <div className="settings-update-heading-actions">
              <span
                className={`settings-update-badge${availableUpdate ? " is-available" : ""}`}
              >
                {installingUpdate
                  ? "正在安装"
                  : checkingUpdate
                    ? "正在检查"
                    : availableUpdate
                      ? "可安装"
                      : "已是最新"}
              </span>
              <Button
                variant="ghost"
                disabled={installingUpdate}
                onClick={() => setUpdateOpen(false)}
              >
                收起
              </Button>
            </div>
          </div>
          {updateStatus && (
            <div
              role="status"
              aria-live="polite"
              className="settings-update-status"
            >
              <div className="settings-update-status-line">
                <span>{updateStatus}</span>
                {installingUpdate && downloadProgress?.total ? (
                  <strong>
                    {Math.min(
                      100,
                      Math.round(
                        (downloadProgress.downloaded / downloadProgress.total) *
                          100,
                      ),
                    )}
                    %
                  </strong>
                ) : null}
              </div>
              {installingUpdate && (
                <div
                  className="settings-update-progress"
                  role="progressbar"
                  aria-label="更新下载进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    downloadProgress?.total
                      ? Math.min(
                          100,
                          Math.round(
                            (downloadProgress.downloaded /
                              downloadProgress.total) *
                              100,
                          ),
                        )
                      : undefined
                  }
                >
                  <span
                    style={{
                      width: downloadProgress?.total
                        ? `${Math.min(
                            100,
                            (downloadProgress.downloaded /
                              downloadProgress.total) *
                              100,
                          )}%`
                        : "32%",
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {notesError && (
            <p role="alert" className="settings-test-result failed">
              {notesError}
            </p>
          )}
          {releaseNotes && (
            <div className="settings-release-notes">
              {releaseNotes.warnings.map((warning, i) => (
                <p className="settings-release-warning" key={i}>
                  {warning}
                </p>
              ))}
              {allReleaseBodiesEmpty && releaseNotes.commits.length > 0 ? (
                /* 说明全为空：不再有标题行/版本计数/“未填写说明”解释，只留一个自解释的提交块 */
                <details className="settings-release-commits" open>
                  <summary>
                    {releaseNotes.currentVersion === releaseNotes.targetVersion
                      ? "本版变更（相对上一版）"
                      : "升级区间提交记录"}
                    <span>{releaseNotes.commits.length} 条提交</span>
                  </summary>
                  <ul>
                    {releaseNotes.commits.map((message, i) => (
                      <li key={i}>{message}</li>
                    ))}
                  </ul>
                </details>
              ) : (
                <>
                  {releaseNotes.releases.length > 0 && (
                    <div className="settings-release-notes-heading">
                      <h3>
                        {releaseNotes.currentVersion ===
                        releaseNotes.targetVersion
                          ? "本版说明"
                          : "本次更新说明"}
                      </h3>
                      {releaseNotes.releases.length > 1 && (
                        <span>{releaseNotes.releases.length} 个版本</span>
                      )}
                    </div>
                  )}
                  {releaseNotes.releases.map((release) => (
                    <article
                      key={release.version}
                      className="settings-release-entry"
                    >
                      <h3>
                        {release.title === `E点通工具箱 v${release.version}`
                          ? `v${release.version}`
                          : `v${release.version} · ${release.title}`}
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
                    <details className="settings-release-commits">
                      <summary>
                        升级区间提交记录
                        <span>{releaseNotes.commits.length} 条</span>
                      </summary>
                      <ul>
                        {releaseNotes.commits.map((message, i) => (
                          <li key={i}>{message}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </div>
          )}
          {fallbackNotes && (
            <article className="settings-release-entry">
              <h3>更新包附带说明（仅目标版本，非完整区间）</h3>
              <div className="settings-release-body">{fallbackNotes}</div>
            </article>
          )}
          <div className="actions settings-update-actions">
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
      {/* 单页双栏：左栏放要填写的（LLM / OCR），右栏放要选择的（主题、新手模式、缓存）；窄窗口自动落回单栏 */}
      <div className="settings-columns">
        <div className="settings-col">
          <section className="list-card">
            <h2>统一 LLM 配置</h2>
            <p className="settings-note">
              供各工具的字段复核与智能分析共用。密钥留空表示保留已保存值。
            </p>
            <div className="form-grid">
              <label className="field settings-toggle">
                <span>启用 LLM</span>
                <SwitchInput
                  checked={form.enabled}
                  onChange={(c) => set("enabled", c)}
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
                  placeholder="填写模型名称，如 gpt-4o-mini"
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
                  <SwitchInput
                    checked={form.thinkingEnabled}
                    onChange={(c) => set("thinkingEnabled", c)}
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
        <div className="settings-col">
          <section className="list-card">
            <h2>界面主题</h2>
            <p className="settings-note">
              选择后立即生效并自动保存，无需再点击保存配置。
            </p>
            <div className="theme-picker">
              {[
                {
                  id: "green-dark",
                  name: "深绿",
                  colors: ["#14353a", "#ffffff", "#1e6267"],
                },
                {
                  id: "classic-dark",
                  name: "经典黄黑",
                  colors: ["#141617", "#1d1f20", "#c4933b"],
                },
                {
                  id: "yellow-light",
                  name: "明亮黄白",
                  colors: ["#433923", "#fffcf5", "#8f6819"],
                },
                {
                  id: "blue-white",
                  name: "专业蓝白",
                  colors: ["#20384c", "#fbfdfe", "#315d83"],
                },
                {
                  id: "red-white",
                  name: "利落红白",
                  colors: ["#49302f", "#fffdfb", "#9b4b45"],
                },
                {
                  id: "yellow-blue",
                  name: "醒目黄蓝",
                  colors: ["#1c3348", "#fcfdfc", "#a97925"],
                },
                {
                  id: "yellow-green",
                  name: "清新黄绿",
                  colors: ["#30483b", "#fbfdf8", "#68782d"],
                },
                {
                  id: "red-yellow-ivory",
                  name: "红黄米白",
                  colors: ["#67352f", "#fffaf0", "#a04a3f"],
                },
                {
                  id: "teal-dark",
                  name: "深色青绿",
                  colors: ["#0e2525", "#162b2b", "#5aa99b"],
                },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`theme-option ${theme === t.id ? "active" : ""}`}
                  aria-pressed={theme === t.id}
                  onClick={() => applyTheme(t.id)}
                >
                  <span className="theme-option-swatches" aria-hidden="true">
                    {t.colors.map((color) => (
                      <span key={color} style={{ background: color }} />
                    ))}
                  </span>
                  <span>{t.name}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="list-card">
            <h2>新手模式</h2>
            <p>
              用带动画的分步提示认识界面：首次打开软件会自动播放工作台导览，
              第一次使用某个工具时会播放该工具的简要上手说明，都可以随时跳过。
              总开关在左侧栏最底部，默认开启，重启后保持你的选择。
            </p>
            <div className="newbie-replay-row">
              <Button variant="outline" size="sm" onClick={onReplayWorkspaceTour}>
                <Sparkles aria-hidden="true" />
                重播工作台引导
              </Button>
              <small>总开关关闭时，也能从这里手动重播。</small>
            </div>
          </section>
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
            <label className="field checkbox-field">
              <span>清理范围</span>
              <span>
                <SwitchInput
                  checked={clearHistoryWithCache}
                  onChange={setClearHistoryWithCache}
                />{" "}
                同时清除历史记录
              </span>
            </label>
            <div className="actions">
              <button
                className="secondary"
                disabled={
                  cacheBusy ||
                  ((cacheStat?.bytes ?? 0) === 0 && !clearHistoryWithCache)
                }
                onClick={async () => {
                  const confirmed = await confirmDialog({
                    title: clearHistoryWithCache
                      ? "清理缓存并清除历史记录"
                      : "清理本机缓存",
                    message: clearHistoryWithCache
                      ? "确定清理本机缓存并永久清除全部历史记录吗？"
                      : "确定清理全部本机缓存吗？源文件和已生成文件不会被删除。",
                    confirmLabel: "清理",
                    tone: "danger",
                  });
                  if (!confirmed) return;
                  setCacheBusy(true);
                  setCacheMessage("");
                  void (async () => {
                    try {
                      let text = "";
                      if ((cacheStat?.bytes ?? 0) > 0) {
                        const r = (await engineCall("cache.clear", {})) as {
                          removed: number;
                          freed: number;
                          failed: number;
                        };
                        text =
                          `已清理 ${r.removed} 个缓存文件，释放 ${formatBytes(r.freed)}` +
                          (r.failed ? `；${r.failed} 个正在使用，未清理` : "");
                      }
                      if (clearHistoryWithCache) {
                        const history = await historyClear();
                        text += `${text ? "；" : ""}已清除 ${history.removed} 条历史记录`;
                      }
                      setCacheMessage(text || "没有需要清理的数据。");
                      await refreshCacheStat();
                    } catch (error) {
                      setCacheMessage(appErrorText(error));
                    } finally {
                      setCacheBusy(false);
                    }
                  })();
                }}
              >
                {cacheBusy
                  ? "清理中…"
                  : clearHistoryWithCache
                    ? `清理缓存和历史记录${cacheStat && cacheStat.bytes > 0 ? `（缓存 ${formatBytes(cacheStat.bytes)}）` : ""}`
                    : cacheStat && cacheStat.bytes > 0
                      ? `立刻清理全部缓存（${formatBytes(cacheStat.bytes)}）`
                      : "立刻清理全部缓存"}
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
      <div className={`settings-save-bar${dirty ? " is-dirty" : ""}`}>
        <span>
          {dirty
            ? "有未保存的配置修改；测试连接不会自动保存。"
            : "配置会保存到本机；界面主题在选择后立即生效。"}
        </span>
        <button
          className="primary"
          disabled={!dirty || saving || testingLlm}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "保存配置"}
        </button>
      </div>
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
  // 纯数字才滚动；带文字的值（如"3 项"）保持原样
  const numeric = /^\d+$/.test(value) ? Number(value) : null;
  const rolled = useCountUp(numeric ?? 0);
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{numeric === null ? value : rolled}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}
