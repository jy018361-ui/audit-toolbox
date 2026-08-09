import { useEffect, useMemo, useState } from "react";
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

type FilterRow = {
  id: number;
  field: string;
  value: string;
  keyword: string;
  values: string[];
  loading: boolean;
};

type TsDraft = {
  inputPath: string;
  sheet: string;
  headerRow: string;
  inspect?: TsInspect;
  filters: FilterRow[];
  exportRawData: boolean;
  outputPath: string;
  result?: unknown;
};

const DEFAULT_FILTER_FIELD = "Department Name";
const DEFAULT_FILTER_VALUE = "ASU Delivery Center ZZ-WP";
const DEPARTMENT_VALUES = [
  "FAAS-Financial&AccountingAdv",
  "ASU Delivery Center DL - WP",
  "ASU Delivery Center DL - AFS",
  "ASU Delivery Center JN - WP",
  "ASU Assurance support China",
  "ASU Delivery Center ZZ-WP",
  "ASU Delivery Center CD - FAAS",
  "ASU Delivery Center XA – WP",
  "ASU Delivery Center KM - WP",
  "ASU Delivery Center CS-WP",
  "ASU Delivery Center DL – Confirmation",
  "Assurance Development",
  "ASU Delivery Center DL - DDP",
  "ASU Delivery Center XA – DDP",
  "ASU Supp Resource&Produc Mgmt",
  "ASU Delivery Center DL",
  "ASU Delivery Center DL - Digital - Contractor",
  "ASU Delivery Center DL - CES",
  "ASU Delivery Center HZ - WP",
  "ASU Delivery Center DL - Lease",
  "ASU Delivery Center KM - ECL",
  "ASU Delivery Center KM - Lease",
  "ASU Delivery Center HZ - Digital",
  "ASU Delivery Center DL - Digital - Core",
  "Audit Assurance Digital",
  "Auto Digital",
  "FAAS Digital",
];
let nextFilterId = 2;
let draft: TsDraft = {
  inputPath: "",
  sheet: "",
  headerRow: "1",
  filters: [
    {
      id: 1,
      field: "",
      value: "",
      keyword: "",
      values: [],
      loading: false,
    },
  ],
  exportRawData: false,
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

function groupedFilters(rows: FilterRow[]) {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const field = row.field.trim();
    const value = row.value === "<空白>" ? "<空白>" : row.value.trim();
    if (!field || !value) continue;
    if (!grouped.has(field)) grouped.set(field, new Set());
    grouped.get(field)?.add(value);
  }
  return [...grouped].map(([field, values]) => ({
    field,
    values: [...values],
  }));
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

function filterLookupParams(state: TsDraft, row: FilterRow) {
  return {
    inputPath: state.inputPath,
    sheet: state.sheet || undefined,
    headerRow: Math.max(1, Number(state.headerRow) || 1),
    field: row.field,
    keyword: row.keyword.trim(),
    limit: 20000,
  };
}

export function TsManagerParityPage({ tool }: { tool: ToolManifest }) {
  const [state, setState] = useState<TsDraft>(() => draft);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobEvent>();
  const [error, setError] = useState("");
  const [dragHover, setDragHover] = useState(false);

  useEffect(() => {
    draft = state;
  }, [state]);

  useEffect(() => {
    let off = () => {};
    void listenJobEvents((event) => {
      if (event.toolId !== "ts_manager") return;
      setJob(event);
      if (event.result) {
        setState((current) => ({ ...current, result: event.result }));
        // 读取任务的结果就是表结构，回来后直接套用到界面。
        const payload = event.result as TsInspect | undefined;
        if (event.phase === "completed" && Array.isArray(payload?.headers))
          applyInspect(payload);
      }
      setBusy(!["completed", "failed", "cancelled"].includes(event.phase));
      if (event.phase === "failed") setError(event.message);
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
            patch({
              inputPath: payload.paths[0],
              sheet: "",
              inspect: undefined,
              filters: [{ id: nextFilterId++, field: "", value: "", keyword: "", values: [], loading: false }],
              outputPath: "",
              result: undefined,
            });
            setStep(1);
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
  const preview = state.inspect?.preview ?? [];
  const filters = useMemo(() => groupedFilters(state.filters), [state.filters]);

  function patch(value: Partial<TsDraft>) {
    setState((current) => ({ ...current, ...value }));
  }

  function patchFilter(id: number, value: Partial<FilterRow>) {
    setState((current) => ({
      ...current,
      filters: current.filters.map((row) =>
        row.id === id ? { ...row, ...value } : row,
      ),
    }));
  }

  async function chooseInput() {
    const selected = await pickPath("file", "选择 Timesheet 文件", [
      "xlsx",
      "xlsm",
      "xls",
      "csv",
      "txt",
    ]);
    if (typeof selected !== "string") return;
    patch({
      inputPath: selected,
      sheet: "",
      inspect: undefined,
      filters: [{ id: nextFilterId++, field: "", value: "", keyword: "", values: [], loading: false }],
      outputPath: "",
      result: undefined,
    });
    setStep(1);
  }

  async function inspect() {
    if (!state.inputPath) {
      setError("请先选择 Timesheet 文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // 读取走任务通道才有进度和取消：网络盘上的大工时表原本加载期间界面全无反馈。
      await jobStart("ts.inspect", {
        inputPath: state.inputPath,
        sheet: state.sheet || undefined,
        headerRow: Math.max(1, Number(state.headerRow) || 1),
      });
      return;
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
      return;
    }
  }

  function applyInspect(value: TsInspect) {
    const defaults = value.defaults ?? {};
      const defaultField = String(defaults.filterField ?? "");
      const defaultValue = String(defaults.filterValue ?? "");
      patch({
        inspect: value,
        sheet: value.selectedSheet ?? state.sheet,
        filters: [
          {
            id: nextFilterId++,
            field: defaultField,
            value: defaultValue,
            keyword: "",
            values: defaultField === DEFAULT_FILTER_FIELD ? DEPARTMENT_VALUES : [],
            loading: false,
          },
        ],
        result: value,
    });
  }

  async function loadFilterValues(row: FilterRow) {
    if (!row.field) return;
    patchFilter(row.id, { loading: true });
    setError("");
    try {
      const value = (await engineCall("ts.filter", filterLookupParams(state, row))) as { values?: string[] };
      patchFilter(row.id, { values: value.values ?? [], loading: false });
    } catch (caught) {
      patchFilter(row.id, { loading: false });
      setError(messageOf(caught));
    }
  }

  async function chooseOutput() {
    const selected = await pickPath("save", "保存 Timesheet 默认双 Sheet", ["xlsx"]);
    if (typeof selected === "string") patch({ outputPath: selected });
  }

  async function startExport() {
    if (!state.inputPath || !state.inspect || !(state.inspect.headers?.length)) {
      setError("请先加载 Timesheet 文件。");
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
        exportRawData: state.exportRawData,
        outputPath: state.outputPath || undefined,
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
      filters: [{ id: nextFilterId++, field: "", value: "", keyword: "", values: [], loading: false }],
      exportRawData: false,
      outputPath: "",
    };
    setState(draft);
    setJob(undefined);
    setError("");
    setStep(1);
  }

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
  return (
    <>
      <PageHeader
        eyebrow="Timesheet 透视"
        title={tool.name}
        detail="加载工时表，按字段组合筛选，导出 by经理 与 by项目 默认双 Sheet。"
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
                  ? "2. 条件筛选（字段 + 筛选信息）"
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
                        patch({
                          sheet: event.target.value,
                          inspect: switchSheetInspect(state.inspect, event.target.value),
                          filters: [{ id: nextFilterId++, field: "", value: "", keyword: "", values: [], loading: false }],
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
                      patch({ headerRow: event.target.value, inspect: undefined });
                      setStep(1);
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
                {state.filters.map((row, index) => (
                  <div className="form-grid" key={row.id}>
                    <Field label={`筛选字段 ${index + 1}`}>
                      <select value={row.field} disabled={!headers.length} onChange={(event) => patchFilter(row.id, { field: event.target.value, value: "", keyword: "", values: event.target.value === DEFAULT_FILTER_FIELD ? DEPARTMENT_VALUES : [] })}>
                        <option value="">（无筛选）</option>
                        {headers.map((header) => <option key={header}>{header}</option>)}
                      </select>
                    </Field>
                    <Field label="筛选信息">
                      <div className="form-grid">
                        <input value={row.keyword} disabled={!row.field} placeholder="关键词搜索（留空读取全部）" onChange={(event) => patchFilter(row.id, { keyword: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void loadFilterValues(row); } }} />
                      </div>
                      <div className="input-with-button">
                        <input list={`ts-filter-${row.id}`} value={row.value} disabled={!row.field} placeholder="选择或输入精确值" onChange={(event) => patchFilter(row.id, { value: event.target.value })} />
                        <datalist id={`ts-filter-${row.id}`}>
                          {row.values.map((value) => <option key={value} value={value} />)}
                        </datalist>
                        <Button type="button" variant="secondary" size="sm" disabled={!row.field || row.loading} onClick={() => void loadFilterValues(row)}>{row.loading ? "读取中" : "读取值"}</Button>
                        <Button type="button" variant="secondary" size="sm" disabled={state.filters.length === 1} onClick={() => patch({ filters: state.filters.filter((candidate) => candidate.id !== row.id) })}>删除</Button>
                      </div>
                    </Field>
                  </div>
                ))}
                <div className="actions">
                  <Button type="button" variant="secondary" size="sm" disabled={!headers.length} onClick={() => patch({ filters: [...state.filters, { id: nextFilterId++, field: "", value: "", keyword: "", values: [], loading: false }] })}>新增筛选条件</Button>
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
                    placeholder="默认保存到输入文件目录"
                    onBrowse={() => void chooseOutput()}
                    onClear={state.outputPath ? () => patch({ outputPath: "" }) : undefined}
                  />
                </Field>
                <label className="field checkbox-field">
                  <input type="checkbox" checked={state.exportRawData} onChange={(event) => patch({ exportRawData: event.target.checked })} />
                  <span>导出原始 data（另存同筛选口径的 UTF-8 BOM CSV，会额外多花约 1 分钟）</span>
                </label>
                <div className="actions">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setStep(2)}>上一步</Button>
                  {busy && job ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => void jobCancel(job.jobId)}>取消</Button>
                  ) : (
                    <Button type="button" variant="default" disabled={!headers.length} onClick={() => void startExport()}>导出默认双 Sheet</Button>
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
                  { label: "数据行", value: state.inspect.dimensions?.rows ?? 0 },
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
              <DataTable columns={headers} rows={preview} maxHeight={380} />
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
            {!state.inspect && !job && <div className="empty">加载文件后可核对表头、前 20 行和默认筛选。</div>}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export const tsManagerParity = { groupedFilters, switchSheetInspect, filterLookupParams };
