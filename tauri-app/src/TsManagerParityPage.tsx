import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenJobEvents,
  openOutput,
  pickPath,
} from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Field } from "@/components/Field";
import { FileDropInput } from "@/components/FileDropInput";
import { FileInput } from "@/components/FileInput";
import { DataTable } from "@/components/DataTable";
import { StatGrid } from "@/components/StatGrid";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type TsInspect = {
  headers?: string[];
  sheets?: string[];
  selectedSheet?: string;
  preview?: string[][];
  dimensions?: { rows?: number; columns?: number };
  defaults?: Record<string, unknown>;
  encoding?: string;
  delimiter?: string;
};

/** 一列取值的读取结果（引擎按关键词返回，超过上限会截断）。 */
type FilterValues = {
  values: string[];
  total: number;
  truncated: boolean;
  keyword: string;
};

type TsDraft = {
  inputPath: string;
  sheet: string;
  headerRow: string;
  inspect?: TsInspect;
  /** 每列勾选的筛选值：同列多值取「或」，跨列取「与」——与旧版口径一致。 */
  selections: Record<string, string[]>;
  /** 套用筛选后的行数与预览；无筛选时为空，预览回落到原始前 20 行。 */
  filtered?: { rows: number; preview: string[][] };
  outputPath: string;
  result?: unknown;
};

// TS 文件对话框默认打开项目组 FY27 网络共享目录。不在内网时该路径不可达，
// Rust 侧会忽略无效起始目录并让系统对话框回落到默认位置。
const LEGACY_DEFAULT_FOLDER =
  "\\\\Cnshausrfl025\\025sha00001\\G\\GTH Assurance\\!!! GDS Assurance\\3. RM\\Reporting相关\\Report Data\\Timesheet summary\\FY27";
const LAST_FOLDER_KEY = "audit-toolbox:ts-manager:last-folder:v1";

/** 引擎用这个字面量表示"该列为空"，勾选它等价于筛选空值行。 */
const BLANK_TOKEN = "<空白>";
/** 一次最多读回多少个不同取值；超过就截断并提示用关键词缩小范围。 */
const VALUE_LIMIT = 20000;

/** 取文件所在目录；同时兼容 Windows 反斜杠与正斜杠写法。 */
function parentDirectory(filePath: string) {
  const cut = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return cut > 0 ? filePath.slice(0, cut) : "";
}

/** 对话框起始目录：上次成功选过的目录 > 旧版默认共享目录 > 交给系统。 */
function pickerStartDirectory(lastFolder: string | null | undefined) {
  const remembered = (lastFolder ?? "").trim();
  return remembered || LEGACY_DEFAULT_FOLDER;
}

function readLastFolder() {
  try {
    return sessionStorage.getItem(LAST_FOLDER_KEY);
  } catch {
    return null;
  }
}

function rememberLastFolder(filePath: string) {
  const folder = parentDirectory(filePath);
  if (!folder) return;
  try {
    sessionStorage.setItem(LAST_FOLDER_KEY, folder);
  } catch {
    /* 记不住起始目录不影响选文件本身 */
  }
}

let draft: TsDraft = {
  inputPath: "",
  sheet: "",
  headerRow: "1",
  selections: {},
  outputPath: "",
};

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return String(value.userMessage ?? value.message ?? "处理失败。");
  }
  return "处理失败。";
}

/**
 * 勾选状态 → 引擎筛选条件。
 *
 * 空列直接丢掉；同列内去重后保持勾选顺序；列的先后按它在表里的位置排，
 * 这样导出参数和界面上从左到右的漏斗顺序一致，出问题时好对。
 */
function activeFilters(
  selections: Record<string, string[]>,
  headers: string[] = [],
) {
  const order = new Map(headers.map((header, index) => [header, index]));
  return Object.entries(selections)
    .map(([field, values]) => ({
      field: field.trim(),
      values: [...new Set(values.filter((value) => value !== ""))],
    }))
    .filter((entry) => entry.field && entry.values.length)
    .sort(
      (a, b) =>
        (order.get(a.field) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.field) ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * 把一列的勾选结果写回筛选条件。
 *
 * 全勾等于不筛选（和 Excel 一样不显示漏斗）；但取值被截断时"全勾"只是勾满了
 * 这一批，不能当成全选，此时按用户实际勾的写回。
 */
function nextSelections(
  selections: Record<string, string[]>,
  field: string,
  checked: string[],
  known: { total: number; truncated: boolean; keyword?: string },
) {
  const next = { ...selections };
  // 只有“未搜索时，完整取值列表全勾”才等于整列不筛选。
  // 搜索后的 total 只是命中关键词的取值数，把它当整列总数会导致用户
  // 勾完搜索结果点应用后，条件被误删。
  const selectsEverything =
    !(known.keyword ?? "").trim() &&
    !known.truncated &&
    known.total > 0 &&
    checked.length >= known.total;
  if (!checked.length || selectsEverything) delete next[field];
  else next[field] = checked;
  return next;
}

function switchSheetInspect(inspect: TsInspect | undefined, sheet: string) {
  if (!inspect) return undefined;
  return {
    ...inspect,
    selectedSheet: sheet,
    headers: [],
    preview: [],
    dimensions: undefined,
    defaults: undefined,
  } satisfies TsInspect;
}

function filterLookupParams(
  state: Pick<TsDraft, "inputPath" | "sheet" | "headerRow">,
  field: string,
  keyword: string,
) {
  return {
    inputPath: state.inputPath,
    sheet: state.sheet || undefined,
    headerRow: Math.max(1, Number(state.headerRow) || 1),
    field,
    keyword: keyword.trim(),
    limit: VALUE_LIMIT,
  };
}

function canStartTsExport(headers: string[], outputPath: string) {
  return headers.length > 0 && Boolean(outputPath.trim());
}

/**
 * Excel 式的列筛选面板：搜索 + 全选 + 逐值勾选。
 *
 * 用 portal 挂到 body 并按触发按钮定位——预览表是个 `overflow:auto` 的滚动
 * 容器，面板留在 `<th>` 里会被裁掉。
 */
function ColumnFilterMenu({
  field,
  anchor,
  loading,
  data,
  selected,
  onSearch,
  onApply,
  onClose,
}: {
  field: string;
  anchor: DOMRect;
  loading: boolean;
  data?: FilterValues;
  selected: string[];
  onSearch: (keyword: string) => void;
  onApply: (checked: string[]) => void;
  onClose: () => void;
}) {
  const [keyword, setKeyword] = useState(data?.keyword ?? "");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(selected));
  const panel = useRef<HTMLDivElement>(null);
  const initialized = useRef(selected.length > 0);

  // 无筛选时 Excel 默认显示「全选」。首次取值异步返回后补齐勾选；若结果被截断，
  // 则不能把眼前这一批冒充整列全选，否则直接应用会意外只保留前 VALUE_LIMIT 项。
  useEffect(() => {
    if (initialized.current || !data || data.truncated) return;
    initialized.current = true;
    setChecked(new Set(data.values));
  }, [data]);

  useEffect(() => {
    function pointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      // 点触发按钮时不在这里关：让按钮自己的 onClick 决定开还是合。
      if (target?.closest("[data-ts-filter-trigger]")) return;
      if (!panel.current?.contains(target as Node)) onClose();
    }
    function keyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("keydown", keyDown);
    return () => {
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("keydown", keyDown);
    };
  }, [onClose]);

  const values = data?.values ?? [];
  // 本批取值里已勾中的数量决定"（全选）"的三态；用户勾过、但不在本批里的值
  // （关键词换过）不算进来，但提交时要保留，否则搜一次就把别的勾选清了。
  const visibleChecked = values.filter((value) => checked.has(value));
  const allChecked = values.length > 0 && visibleChecked.length === values.length;
  const someChecked = visibleChecked.length > 0 && !allChecked;
  const hiddenChecked = [...checked].filter((value) => !values.includes(value));

  const width = 268;
  const left = Math.min(
    Math.max(8, anchor.left),
    Math.max(8, window.innerWidth - width - 8),
  );
  const top = Math.min(anchor.bottom + 4, Math.max(8, window.innerHeight - 340));

  function toggle(value: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  return createPortal(
    <div
      ref={panel}
      className="ts-filter-menu"
      style={{ left, top, width }}
      role="dialog"
      aria-label={`筛选 ${field}`}
    >
      <div className="ts-filter-menu-title" title={field}>
        {field}
      </div>
      <div className="ts-filter-menu-search">
        <input
          value={keyword}
          placeholder="搜索取值，回车重新读取"
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            onSearch(keyword);
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => onSearch(keyword)}
        >
          {loading ? "读取中" : "读取"}
        </Button>
      </div>
      <label className="ts-filter-all">
        <input
          type="checkbox"
          checked={allChecked}
          ref={(node) => {
            if (node) node.indeterminate = someChecked;
          }}
          disabled={!values.length}
          onChange={(event) =>
            setChecked((current) => {
              const next = new Set(current);
              for (const value of values) {
                if (event.target.checked) next.add(value);
                else next.delete(value);
              }
              return next;
            })
          }
        />
        <span>（全选）</span>
      </label>
      <div className="ts-filter-values">
        {loading && !values.length ? (
          <div className="ts-filter-empty">正在读取取值…</div>
        ) : !values.length ? (
          <div className="ts-filter-empty">没有匹配的取值</div>
        ) : (
          values.map((value) => (
            <label className="ts-filter-value" key={value} title={value}>
              <input
                type="checkbox"
                checked={checked.has(value)}
                onChange={() => toggle(value)}
              />
              <span className={value === BLANK_TOKEN ? "ts-filter-blank" : undefined}>
                {value}
              </span>
            </label>
          ))
        )}
      </div>
      {data?.truncated && (
        <div className="ts-filter-note">
          共 {data.total} 个取值，只列出前 {values.length} 个，请输入关键词后重新读取。
        </div>
      )}
      {hiddenChecked.length > 0 && (
        <div className="ts-filter-note">
          另有 {hiddenChecked.length} 个已选取值不在当前搜索结果里，会一并保留。
        </div>
      )}
      <div className="ts-filter-actions">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setChecked(new Set())}
        >
          清除
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          取消
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => onApply([...checked])}
        >
          应用
        </Button>
      </div>
    </div>,
    document.body,
  );
}

export function TsManagerParityPage({ tool }: { tool: ToolManifest }) {
  const [state, setState] = useState<TsDraft>(() => draft);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobEvent>();
  const [error, setError] = useState("");
  const [dragHover, setDragHover] = useState(false);
  const [menu, setMenu] = useState<{ field: string; anchor: DOMRect }>();
  const [valueCache, setValueCache] = useState<Record<string, FilterValues>>({});
  const [valuesLoading, setValuesLoading] = useState(false);

  useEffect(() => {
    draft = state;
  }, [state]);

  useEffect(() => {
    let off = () => {};
    void listenJobEvents((event) => {
      if (event.toolId !== "ts_manager") return;
      setJob(event);
      setBusy(!["completed", "failed", "cancelled"].includes(event.phase));
      if (event.phase === "failed") setError(event.message);
      if (event.phase !== "completed" || !event.result) return;
      const payload = event.result as Record<string, unknown>;
      // 读取和筛选预览都带 headers/preview，靠 sheets/defaults 区分：
      // 只有 ts.inspect 会返回工作表清单和默认字段。
      if (Array.isArray(payload.sheets) || payload.defaults) {
        applyInspect(payload as TsInspect);
      } else if (Array.isArray(payload.preview) && typeof payload.rows === "number") {
        setState((current) => ({
          ...current,
          filtered: {
            rows: payload.rows as number,
            preview: payload.preview as string[][],
          },
        }));
      } else {
        setState((current) => ({ ...current, result: event.result }));
      }
    }).then((unlisten) => {
      off = unlisten;
    });
    return () => off();
  }, []);

  // 拖放上传：Tauri 窗口级拖放事件，文件落下时直接写入目标文件路径。
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
      return;
    let off: () => void = () => {};
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "enter") {
          setDragHover(true);
        } else if (payload.type === "drop") {
          setDragHover(false);
          if (payload.paths.length) {
            resetForNewSource({ inputPath: payload.paths[0], sheet: "" });
          }
        } else if (payload.type === "leave") {
          setDragHover(false);
        }
      })
      .then((fn) => {
        off = fn;
      })
      .catch((e) => console.error("[ts] drag listener error:", e));
    return () => off();
  }, []);

  const headers = state.inspect?.headers ?? [];
  const basePreview = state.inspect?.preview ?? [];
  const preview = state.filtered?.preview ?? basePreview;
  const filters = useMemo(
    () => activeFilters(state.selections, headers),
    [state.selections, headers],
  );

  function patch(value: Partial<TsDraft>) {
    setState((current) => ({ ...current, ...value }));
  }

  /** 换文件/换 Sheet/换标题行：取值缓存和已选条件都不再成立，一起清掉。 */
  function resetForNewSource(value: Partial<TsDraft>) {
    setMenu(undefined);
    setValueCache({});
    setState((current) => ({
      ...current,
      inspect: undefined,
      selections: {},
      filtered: undefined,
      outputPath: "",
      result: undefined,
      ...value,
    }));
    setStep(1);
  }

  async function chooseInput() {
    const selected = await pickPath(
      "file",
      "选择 Timesheet 文件",
      ["xlsx", "xlsm", "xls", "csv", "txt"],
      undefined,
      pickerStartDirectory(readLastFolder()),
    );
    if (typeof selected !== "string") return;
    rememberLastFolder(selected);
    resetForNewSource({ inputPath: selected, sheet: "" });
    // 旧版选完文件就直接开始读取（_confirm_selected_file），不需要再点一次「加载文件」。
    await inspect(selected);
  }

  async function inspect(overridePath?: string) {
    const inputPath = overridePath ?? state.inputPath;
    // 刚选的新文件还没确定 Sheet，沿用上一份文件的 Sheet 名会直接读不到。
    const sheet = overridePath ? "" : state.sheet;
    if (!inputPath) {
      setError("请先选择 Timesheet 文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // 读取走任务通道才有进度和取消：网络盘上的大工时表原本加载期间界面全无反馈。
      await jobStart("ts.inspect", {
        inputPath,
        sheet: sheet || undefined,
        headerRow: Math.max(1, Number(state.headerRow) || 1),
      });
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  }

  function applyInspect(value: TsInspect) {
    const defaults = value.defaults ?? {};
    const defaultField = String(defaults.filterField ?? "").trim();
    const defaultValue = String(defaults.filterValue ?? "").trim();
    setValueCache({});
    setState((current) => ({
      ...current,
      inspect: value,
      sheet: value.selectedSheet ?? current.sheet,
      selections:
        defaultField && defaultValue ? { [defaultField]: [defaultValue] } : {},
      filtered: undefined,
    }));
  }

  const loadValues = useCallback(
    async (field: string, keyword: string) => {
      if (!field || !state.inputPath) return;
      setValuesLoading(true);
      setError("");
      try {
        const value = (await engineCall(
          "ts.filter",
          filterLookupParams(state, field, keyword),
        )) as { values?: string[]; total?: number; truncated?: boolean };
        const values = value.values ?? [];
        setValueCache((current) => ({
          ...current,
          [field]: {
            values,
            total: value.total ?? values.length,
            truncated: Boolean(value.truncated),
            keyword,
          },
        }));
      } catch (caught) {
        setError(messageOf(caught));
      } finally {
        setValuesLoading(false);
      }
    },
    [state.inputPath, state.sheet, state.headerRow],
  );

  function openFilterMenu(field: string, anchor: DOMRect) {
    setMenu({ field, anchor });
    if (!valueCache[field]) void loadValues(field, "");
  }

  /** 套用筛选后刷新预览：引擎按同一口径过滤，顺带给出命中行数。 */
  async function refreshPreview(selections: Record<string, string[]>) {
    const applied = activeFilters(selections, headers);
    if (!state.inputPath || !state.inspect) return;
    if (!applied.length) {
      patch({ filtered: undefined });
      return;
    }
    setBusy(true);
    setError("");
    try {
      await jobStart("ts.filter", {
        inputPath: state.inputPath,
        sheet: state.sheet || undefined,
        headerRow: Math.max(1, Number(state.headerRow) || 1),
        filters: applied,
      });
    } catch (caught) {
      setBusy(false);
      setError(messageOf(caught));
    }
  }

  function applyFilter(field: string, checked: string[]) {
    const known = valueCache[field];
    const next = nextSelections(state.selections, field, checked, {
      total: known?.total ?? 0,
      truncated: known?.truncated ?? false,
      keyword: known?.keyword,
    });
    setMenu(undefined);
    patch({ selections: next });
    void refreshPreview(next);
  }

  function clearFilter(field: string) {
    const next = { ...state.selections };
    delete next[field];
    patch({ selections: next });
    void refreshPreview(next);
  }

  function clearAllFilters() {
    patch({ selections: {} });
    void refreshPreview({});
  }

  async function chooseOutput() {
    const selected = await pickPath("save", "保存 Timesheet 默认双 Sheet", ["xlsx"]);
    if (typeof selected === "string") patch({ outputPath: selected });
  }

  async function startExport() {
    if (!state.inputPath || !state.inspect || !headers.length) {
      setError("请先加载 Timesheet 文件。");
      return;
    }
    if (!state.outputPath.trim()) {
      setError("请选择 TS 导出文件的保存路径。");
      return;
    }
    setBusy(true);
    setError("");
    patch({ result: undefined });
    try {
      const jobId = await jobStart("ts.export", {
        inputPath: state.inputPath,
        sheet: state.sheet || undefined,
        headerRow: Math.max(1, Number(state.headerRow) || 1),
        pivotMode: "dual_default",
        filters,
        outputPath: state.outputPath,
      });
      setJob({
        jobId,
        toolId: "ts_manager",
        phase: "queued",
        current: 0,
        total: 1,
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (caught) {
      setBusy(false);
      setError(messageOf(caught));
    }
  }

  function clearAll() {
    draft = {
      inputPath: "",
      sheet: "",
      headerRow: "1",
      selections: {},
      outputPath: "",
    };
    setState(draft);
    setValueCache({});
    setMenu(undefined);
    setJob(undefined);
    setError("");
    setStep(1);
  }

  // 预览表头第一行的漏斗按钮：每列一个，已筛选的显示勾中个数。
  const headerControls = headers.map((header) => {
    const chosen = state.selections[header] ?? [];
    return (
      <span className="dt-header-control" key={header}>
        <button
          type="button"
          data-ts-filter-trigger=""
          className={`ts-filter-trigger${chosen.length ? " active" : ""}`}
          aria-label={`筛选 ${header}${chosen.length ? `，已选 ${chosen.length} 项` : ""}`}
          aria-expanded={menu?.field === header}
          title={
            chosen.length
              ? `已选 ${chosen.length} 个取值：${chosen.slice(0, 5).join("、")}${chosen.length > 5 ? "…" : ""}`
              : `筛选「${header}」`
          }
          onClick={(event) => {
            if (menu?.field === header) {
              setMenu(undefined);
              return;
            }
            openFilterMenu(header, event.currentTarget.getBoundingClientRect());
          }}
        >
          <span className="ts-filter-icon">▼</span>
          {chosen.length > 0 && (
            <span className="ts-filter-badge">{chosen.length}</span>
          )}
        </button>
      </span>
    );
  });

  const outputPaths = job?.outputPaths ?? [];
  const exportResult = (state.result ?? {}) as Record<string, unknown>;
  const exportSummary: Array<{ label: string; value: number }> = (
    [
      ["by经理行数", exportResult.rowsManager],
      ["by项目行数", exportResult.rowsProject],
      ["明细行数", exportResult.rawRows],
    ] as Array<[string, unknown]>
  )
    .filter(([, value]) => typeof value === "number")
    .map(([label, value]) => ({ label, value: Number(value) }));
  const elapsed = (exportResult.timings as { totalMs?: number } | undefined)?.totalMs;
  if (typeof elapsed === "number")
    exportSummary.push({ label: "耗时(秒)", value: Math.round(elapsed / 100) / 10 });
  const totalRows = state.inspect?.dimensions?.rows ?? 0;
  const shownRows = state.filtered?.rows ?? totalRows;
  return (
    <>
      <PageHeader
        eyebrow="Timesheet 透视"
        title={tool.name}
        detail="加载工时表，在预览表头按列勾选筛选值，导出 by经理 与 by项目 默认双 Sheet。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "文件与加载" },
          { key: "2", label: "条件筛选", disabled: !state.inspect },
          { key: "3", label: "导出", disabled: !headers.length },
        ]}
        current={step - 1}
        onStepClick={(index) => setStep((index + 1) as 1 | 2 | 3)}
      />
      <div className="fa-stack">
        <Card>
          <CardHeader>
            <CardTitle>
              {step === 1
                ? "1. 目标文件选择"
                : step === 2
                  ? "2. 条件筛选（在预览表头按列勾选）"
                  : "3. 输出与导出"}
            </CardTitle>
            <Badge className="badge-ready">已就绪</Badge>
          </CardHeader>
          <CardContent>
            <ErrorBox error={error} onDismiss={() => setError("")} />
            {job && !["completed", "failed", "cancelled"].includes(job.phase) && (
              <JobProgress
                job={job}
                onCancel={(jobId) => void jobCancel(jobId)}
                cancelLabel="取消任务"
              />
            )}
            {step === 1 && (
              <>
                <Field label="目标文件" required>
                  <FileDropInput
                    value={state.inputPath}
                    placeholder="拖放或点击选择 Timesheet 文件"
                    onBrowse={() => void chooseInput()}
                    onClear={state.inputPath && !busy ? clearAll : undefined}
                    onDragStateChange={() => {}}
                    highlight={dragHover}
                    disabled={busy}
                  />
                </Field>
                <div className="form-grid">
                  <Field label="Sheet">
                    {state.inspect?.sheets?.length ? (
                      <select value={state.sheet} onChange={(event) => {
                        const sheet = event.target.value;
                        setMenu(undefined);
                        setValueCache({});
                        patch({
                          sheet,
                          inspect: switchSheetInspect(state.inspect, sheet),
                          selections: {},
                          filtered: undefined,
                          result: undefined,
                        });
                        setStep(1);
                      }}>
                        {state.inspect.sheets.map((name) => <option key={name}>{name}</option>)}
                      </select>
                    ) : (
                      <input value={state.sheet} onChange={(event) => {
                        patch({ sheet: event.target.value });
                        setStep(1);
                      }} />
                    )}
                  </Field>
                  <Field label="标题行（默认 1）">
                    <input type="number" min={1} max={50} value={state.headerRow} onChange={(event) => {
                      resetForNewSource({ headerRow: event.target.value });
                    }} />
                  </Field>
                </div>
                <div className="actions">
                  <Button type="button" variant="secondary" size="sm" disabled={busy || !state.inputPath} onClick={() => void inspect()}>
                    加载文件
                  </Button>
                  <Button type="button" variant="default" disabled={!state.inspect} onClick={() => setStep(2)}>
                    下一步：条件筛选
                  </Button>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <p className="hint">
                  筛选在下方「文件预览」里做：点表头第一行的 ▼ 打开取值清单，勾选后点「应用」。
                  同一列勾多个取值是「或」，不同列之间是「且」——和 Excel 的自动筛选一致。
                </p>
                {filters.length === 0 ? (
                  <div className="empty">当前没有筛选条件，导出会包含全部 {totalRows} 行。</div>
                ) : (
                  <>
                    <div className="chip-list">
                      {filters.map((entry) => (
                        <span className="ts-filter-chip" key={entry.field}>
                          <strong title={entry.field}>{entry.field}</strong>
                          <span title={entry.values.join("、")}>
                            {entry.values.length > 2
                              ? `${entry.values.slice(0, 2).join("、")} 等 ${entry.values.length} 项`
                              : entry.values.join("、")}
                          </span>
                          <button
                            type="button"
                            aria-label={`清除 ${entry.field} 的筛选`}
                            onClick={() => clearFilter(entry.field)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <p className="hint">
                      命中 {shownRows} 行 / 共 {totalRows} 行。
                    </p>
                  </>
                )}
                <div className="actions">
                  <Button type="button" variant="secondary" size="sm" disabled={!filters.length} onClick={clearAllFilters}>清除全部筛选</Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setStep(1)}>上一步</Button>
                  <Button type="button" variant="default" disabled={!headers.length} onClick={() => setStep(3)}>下一步：导出</Button>
                </div>
              </>
            )}
            {step === 3 && (
              <>
                <Field label="输出文件">
                  <FileInput
                    value={state.outputPath}
                    placeholder="请选择导出文件的保存路径"
                    onBrowse={() => void chooseOutput()}
                    onClear={state.outputPath ? () => patch({ outputPath: "" }) : undefined}
                  />
                </Field>
                <p className="hint">
                  将按 {filters.length} 个筛选条件导出，命中 {shownRows} 行。
                </p>
                <div className="actions">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setStep(2)}>上一步</Button>
                  {busy && job ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => void jobCancel(job.jobId)}>取消</Button>
                  ) : (
                    <Button type="button" variant="default" disabled={!canStartTsExport(headers, state.outputPath)} onClick={() => void startExport()}>导出默认双 Sheet</Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>文件预览与任务结果</CardTitle>
          </CardHeader>
          <CardContent>
            {state.inspect && (
              <StatGrid
                columns={4}
                items={[
                  {
                    label: "数据行",
                    value: filters.length ? `${shownRows} / ${totalRows}` : totalRows,
                  },
                  { label: "字段数", value: state.inspect.dimensions?.columns ?? headers.length },
                  { label: "Sheet", value: state.sheet || "CSV" },
                  { label: "有效筛选", value: filters.length },
                ]}
              />
            )}
            {/* Legacy forced a sheet picker before loading; silently taking the
                first sheet reads a cover page as if it were the data. */}
            {(state.inspect?.sheets?.length ?? 0) > 1 && (
              <div className="warning-box">
                该工作簿共有 {state.inspect?.sheets?.length} 个工作表，当前使用「{state.sheet || state.inspect?.selectedSheet}」。
                如果数据不在这一张，请在上方切换 Sheet 后重新加载。
              </div>
            )}
            {preview.length > 0 && (
              <DataTable
                columns={headers}
                rows={preview}
                caption={
                  <div className="fa-table-caption">
                    <strong>
                      {state.filtered ? "筛选后预览" : "原始预览"} ·{" "}
                      {state.filtered
                        ? `命中 ${shownRows} 行，列出前 ${preview.length} 行`
                        : `前 ${preview.length} 行`}
                    </strong>
                    <span className="fa-caption-optional">
                      点表头 ▼ 按列筛选
                    </span>
                  </div>
                }
                maxHeight={380}
                headerControls={headerControls}
              />
            )}
            {/* The export already returns these counts; legacy showed them in a
                completion dialog so the run could be reconciled afterwards. */}
            {exportSummary.length > 0 && (
              <StatGrid
                columns={3}
                items={exportSummary.map((item) => ({ label: item.label, value: item.value }))}
              />
            )}
            {outputPaths.length > 0 && (
              <div className="output-list">
                {outputPaths.map((path) => (
                  <Button type="button" variant="secondary" size="sm" key={path} onClick={() => void openOutput(path)}>
                    打开：{path}
                  </Button>
                ))}
              </div>
            )}
            {!state.inspect && !job && <div className="empty">加载文件后可核对表头、前 20 行，并在表头按列筛选。</div>}
          </CardContent>
        </Card>
      </div>
      {menu && (
        <ColumnFilterMenu
          key={menu.field}
          field={menu.field}
          anchor={menu.anchor}
          loading={valuesLoading}
          data={valueCache[menu.field]}
          selected={state.selections[menu.field] ?? []}
          onSearch={(keyword) => void loadValues(menu.field, keyword)}
          onApply={(checked) => applyFilter(menu.field, checked)}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}

export const tsManagerParity = {
  activeFilters,
  nextSelections,
  switchSheetInspect,
  filterLookupParams,
  parentDirectory,
  pickerStartDirectory,
  canStartTsExport,
  BLANK_TOKEN,
  LEGACY_DEFAULT_FOLDER,
};
