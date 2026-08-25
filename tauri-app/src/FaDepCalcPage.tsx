import { useEffect, useRef, useState } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenPositionedFileDrops,
  openOutput,
  pickPath,
} from "./api";
import type { ToolManifest } from "./types";
import { errorText } from "@/lib/errors";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Field } from "@/components/Field";
import { FileInput } from "@/components/FileInput";
import { FileDropInput } from "@/components/FileDropInput";
import { DataTable } from "@/components/DataTable";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LlmReview } from "@/components/LlmReview";
import { useJobEvents } from "@/hooks/useJobEvents";
import { faMappedRolesForColumn } from "./faListUi";
import {
  DEP_MAPPING_ROLES,
  depMissingOptionalRoles,
  depMissingRoles,
  faDepDefaultOutputName,
  faDepDefaultOutputPath,
  planDepLlmChanges,
  type DepMappingChange,
  type DepPendingSuggestion,
} from "./faSubtoolsUi";

type DepMapping = Record<string, string | undefined>;
type DepInspection = {
  headers: string[];
  preview: unknown[][];
  sheets: string[];
  selectedSheet?: string;
  displayName?: string;
  detectedHeaderRow?: number;
  dimensions?: { rows: number; columns: number };
  suggestedMapping?: DepMapping;
};
type FaLlmReview = {
  enabled: boolean;
  passed: boolean;
  failed?: boolean;
  message: string;
  detail?: string;
  autoApplied: unknown[];
  fieldReviews: unknown[];
};
type DepDraft = {
  path: string;
  sheet: string;
  headerRow: string;
  inspection?: DepInspection;
  mapping: DepMapping;
  balanceSheetDate: string;
  outputPath: string;
  outputPathTouched: boolean;
};

// 与 FaListPage 相同的模式：路由切换不丢向导状态。
let faDepDraftCache: DepDraft | undefined;

/// 折旧测算：只上传期末清单。上传、Sheet/标题行、逐列映射与 LLM 复核的
/// 交互均复制 FA 主工具；导出为单页"折旧测算"Excel（活公式，可审计）。
export function FaDepCalcPage({ tool }: { tool: ToolManifest }) {
  const draft = faDepDraftCache;
  const [path, setPath] = useState(draft?.path ?? "");
  const [sheet, setSheet] = useState(draft?.sheet ?? "");
  const [headerRow, setHeaderRow] = useState(draft?.headerRow ?? "");
  const [inspection, setInspection] = useState<DepInspection | undefined>(
    draft?.inspection,
  );
  const [mapping, setMapping] = useState<DepMapping>(draft?.mapping ?? {});
  const [balanceSheetDate, setBalanceSheetDate] = useState(
    draft?.balanceSheetDate ?? "2025-12-31",
  );
  const [outputPath, setOutputPath] = useState(draft?.outputPath ?? "");
  const [outputPathTouched, setOutputPathTouched] = useState(
    draft?.outputPathTouched ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmReview, setLlmReview] = useState<FaLlmReview>();
  const [llmChanges, setLlmChanges] = useState<DepMappingChange[]>([]);
  const [llmPending, setLlmPending] = useState<DepPendingSuggestion[]>([]);
  const [error, setError] = useState("");
  const reviewGeneration = useRef(0);
  const stateRef = useRef({ mapping, balanceSheetDate });
  stateRef.current = { mapping, balanceSheetDate };
  const { job, setJob } = useJobEvents({
    toolId: "fa_dep_calc",
    onEvent: (event) => {
      setBusy(!["completed", "failed", "cancelled"].includes(event.phase));
      if (event.phase === "failed") setError(event.message);
    },
  });
  // 单槽拖放：落点必须命中上传框（Fx 页模式：api 层已把物理像素换算成 CSS 像素）。
  const uploadDropRef = useRef<HTMLDivElement>(null);
  const [dragHover, setDragHover] = useState(false);
  const applyPathRef = useRef<(value: string) => void>(() => {});
  applyPathRef.current = (value: string) => {
    setOutputPathTouched(false);
    setPath(value);
    setSheet("");
    setHeaderRow("");
    setInspection(undefined);
    setMapping({});
    setLlmReview(undefined);
    setLlmChanges([]);
    setLlmPending([]);
    setError("");
    setJob(undefined);
    // 清空（value 为空串）时只重置状态，不触发读取。
    if (value) void inspect({ path: value });
  };
  useEffect(() => {
    const inTauriEnv =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!inTauriEnv) return () => undefined;
    const stop = listenPositionedFileDrops((drop) => {
      const rect = uploadDropRef.current?.getBoundingClientRect();
      const hit =
        rect &&
        drop.x >= rect.left &&
        drop.x <= rect.right &&
        drop.y >= rect.top &&
        drop.y <= rect.bottom;
      setDragHover(false);
      if (hit && drop.paths.length) applyPathRef.current(drop.paths[0]);
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);
  useEffect(() => {
    faDepDraftCache = {
      path,
      sheet,
      headerRow,
      inspection,
      mapping,
      balanceSheetDate,
      outputPath,
      outputPathTouched,
    };
  });
  // 默认落点跟着源文件走；用户自选后不再改写。
  useEffect(() => {
    if (outputPathTouched) return;
    setOutputPath(path ? faDepDefaultOutputPath(path) : "");
  }, [path, outputPathTouched]);

  async function inspect(overrides?: { path?: string; sheet?: string; headerRow?: string }) {
    const target = overrides?.path ?? path;
    if (!target) {
      setError("请先选择期末固定资产清单。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const value = (await engineCall("fa.dep_inspect", {
        path: target,
        sheet: (overrides?.sheet ?? sheet) || undefined,
        headerRow: Number(overrides?.headerRow ?? headerRow) || undefined,
      })) as DepInspection;
      setInspection(value);
      setSheet(value.selectedSheet ?? (overrides?.sheet ?? sheet));
      setHeaderRow(String(value.detectedHeaderRow ?? ""));
      const suggested: DepMapping = {};
      for (const [key] of DEP_MAPPING_ROLES) {
        suggested[key] = value.suggestedMapping?.[key];
      }
      setMapping(suggested);
      setLlmChanges([]);
      setLlmPending([]);
      void review(
        suggested,
        value.selectedSheet ?? "",
        value.detectedHeaderRow,
        target,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  /// LLM 复核：建议先改后核，失败不阻塞（与主工具口径一致）。
  /// pathOverride：inspect 刚选完文件时 path 状态尚未提交，必须显式传值，
  /// 否则首次选文件会带着空路径请求，后端报"缺少参数：path"。
  async function review(
    mappingOverride?: DepMapping,
    sheetOverride?: string,
    headerRowOverride?: number,
    pathOverride?: string,
  ) {
    const reviewPath = pathOverride ?? path;
    if (!reviewPath && !mappingOverride) return;
    const generation = ++reviewGeneration.current;
    setLlmBusy(true);
    setLlmChanges([]);
    setLlmPending([]);
    try {
      const value = (await engineCall("fa.dep_review", {
        path: reviewPath,
        sheet: (sheetOverride || sheet) || undefined,
        headerRow: headerRowOverride ?? (Number(headerRow) || 1),
        mapping: mappingOverride ?? mapping,
      })) as FaLlmReview;
      if (generation !== reviewGeneration.current) return;
      setLlmReview(value);
      const plan = planDepLlmChanges({
        mapping: mappingOverride ?? stateRef.current.mapping,
        autoApplied: value.autoApplied as never,
        fieldReviews: value.fieldReviews as never,
      });
      // 规划器只会写字符串角色值，收窄回单文件映射的类型。
      setMapping(plan.mapping as DepMapping);
      setLlmChanges(plan.changes);
      setLlmPending(plan.pending);
    } catch (e) {
      if (generation !== reviewGeneration.current) return;
      const detail =
        e && typeof e === "object"
          ? String((e as Record<string, unknown>).detail ?? "")
          : "";
      setLlmReview({
        enabled: true,
        passed: false,
        failed: true,
        message: `${errorText(e).replace(/[。.]+$/, "")}。字段映射本身没有问题，脚本自动映射已完成，可直接核对后继续；LLM 复核只是可选的辅助检查。`,
        detail,
        autoApplied: [],
        fieldReviews: [],
      });
    } finally {
      if (generation === reviewGeneration.current) setLlmBusy(false);
    }
  }

  function acceptPending(item: DepPendingSuggestion) {
    const before = stateRef.current.mapping[item.apply.key];
    setLlmChanges((current) => [
      ...current,
      {
        id: item.id,
        label: item.label,
        before: item.current,
        after: item.suggested,
        reason: item.reason,
        confidence: item.confidence,
        attention: true,
        restore: {
          key: item.apply.key,
          value: typeof before === "string" ? before : undefined,
        },
      },
    ]);
    setMapping((current) => ({ ...current, [item.apply.key]: item.apply.value }));
    setLlmPending((current) => current.filter((value) => value.id !== item.id));
  }

  function undoChange(change: DepMappingChange) {
    setMapping((current) => ({ ...current, [change.restore.key]: change.restore.value }));
    setLlmChanges((current) => current.filter((item) => item.id !== change.id));
  }

  /// 换列即换映射：先把占用该列的旧角色清掉，再赋新角色。
  function setColumnRole(header: string, key: string) {
    const column = header.trim();
    setMapping((current) => {
      const next = { ...current };
      for (const [role] of DEP_MAPPING_ROLES) {
        if (next[role] === column) next[role] = undefined;
      }
      if (key) next[key] = column;
      return next;
    });
  }

  async function chooseFile() {
    const value = await pickPath("file", "选择期末固定资产清单", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
    ]);
    if (typeof value === "string") applyPathRef.current(value);
  }

  async function chooseOutput() {
    const value = await pickPath(
      "save",
      "保存折旧测算表",
      ["xlsx"],
      faDepDefaultOutputName(),
    );
    if (typeof value === "string") {
      setOutputPath(value);
      setOutputPathTouched(true);
    }
  }

  async function startExport() {
    if (!path || !inspection) {
      setError("请先选择并读取期末清单。");
      return;
    }
    if (depMissingRoles(mapping).length) {
      setError("还有必填字段未映射，请在预览表头下拉中补全。");
      return;
    }
    let target = outputPath;
    if (!outputPathTouched) {
      target = faDepDefaultOutputPath(path);
      if (target) setOutputPath(target);
    }
    if (!target.trim()) {
      const picked = await pickPath(
        "save",
        "保存折旧测算表",
        ["xlsx"],
        faDepDefaultOutputName(),
      );
      if (typeof picked !== "string" || !picked.trim()) return;
      target = picked;
      setOutputPath(picked);
      setOutputPathTouched(true);
    }
    setBusy(true);
    setError("");
    setJob(undefined);
    try {
      const jobId = await jobStart("fa.dep_export", {
        path,
        sheet: sheet || undefined,
        headerRow: Number(headerRow) || 1,
        mapping,
        balanceSheetDate: balanceSheetDate || undefined,
        outputPath: target,
      });
      setJob({
        jobId,
        toolId: "fa_dep_calc",
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

  const missing = depMissingRoles(mapping);
  const optionalMissing = inspection ? depMissingOptionalRoles(mapping) : [];
  // 每列顶部的角色映射下拉（复制 FA 主工具的列头映射交互）。
  const columnControls = inspection
    ? inspection.headers.map((header) => {
        const column = header.trim();
        const mapped = faMappedRolesForColumn(column, DEP_MAPPING_ROLES, mapping);
        const usedRoles = new Set(
          DEP_MAPPING_ROLES.filter(([key]) =>
            Boolean(String(mapping[key] ?? "").trim()),
          ).map(([key]) => key),
        );
        return (
          <label className="dt-header-control" key={header}>
            <select
              className={mapped.length ? "mapped" : undefined}
              disabled={llmBusy}
              title={mapped.map(([, label]) => label).join(" + ") || "未映射"}
              value={mapped.length === 1 ? mapped[0][0] : ""}
              onChange={(e) => setColumnRole(header, e.target.value)}
            >
              <option value="">—</option>
              {DEP_MAPPING_ROLES.map(([key, label]) => {
                const taken = usedRoles.has(key) && !mapped.some(([k]) => k === key);
                return (
                  <option
                    key={key}
                    value={key}
                    className={taken ? "dt-role-taken" : undefined}
                  >
                    {label}
                    {taken ? "（已用）" : ""}
                  </option>
                );
              })}
            </select>
          </label>
        );
      })
    : [];
  const outputPaths =
    job?.phase === "completed" && Array.isArray(job.outputPaths)
      ? job.outputPaths
      : [];

  return (
    <>
      <PageHeader
        eyebrow="固定资产折旧测算"
        title={tool.name}
        detail="上传期末固定资产清单，逐卡重算月折旧额、当年与累计折旧，并输出带活公式的折旧测算表。"
      />
      <div className="fa-stack">
        <Card>
          <CardHeader>
            <CardTitle>1. 上传期末清单并映射</CardTitle>
            <Badge className="badge-ready">已就绪</Badge>
          </CardHeader>
          <CardContent>
            <ErrorBox error={error} onDismiss={() => setError("")} />
            {job && job.phase !== "completed" && (
              <JobProgress
                job={job}
                onCancel={(jobId) => {
                  void jobCancel(jobId);
                  setBusy(false);
                }}
                cancelLabel="取消任务"
              />
            )}
            <div className="form-grid">
              <Field label="期末清单" required>
                <div ref={uploadDropRef}>
                  <FileDropInput
                    value={path}
                    placeholder="拖放或点击选择期末固定资产清单"
                    onBrowse={() => void chooseFile()}
                    onDragStateChange={setDragHover}
                    highlight={dragHover}
                    disabled={busy}
                    onClear={
                      path && !busy
                        ? () => applyPathRef.current("")
                        : undefined
                    }
                  />
                </div>
              </Field>
              <Field label="Sheet">
                {inspection?.sheets.length ? (
                  <select
                    value={sheet}
                    disabled={busy}
                    onChange={(e) => {
                      setSheet(e.target.value);
                      setHeaderRow("");
                      void inspect({ sheet: e.target.value, headerRow: "" });
                    }}
                  >
                    {inspection.sheets.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={sheet}
                    disabled={busy}
                    onChange={(e) => setSheet(e.target.value)}
                  />
                )}
              </Field>
              <Field label="标题行（留空自动识别）">
                <input
                  value={headerRow}
                  placeholder="自动"
                  disabled={busy}
                  onChange={(e) => setHeaderRow(e.target.value)}
                  onBlur={() => {
                    if (path && inspection) void inspect();
                  }}
                />
              </Field>
            </div>
            <div className="actions">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !path}
                onClick={() => void inspect()}
              >
                {busy ? "正在读取表格…" : "读取表格 + LLM 复核"}
              </Button>
              {inspection && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || llmBusy || !path}
                  onClick={() => void review()}
                >
                  {llmBusy ? "LLM 正在复核…" : "LLM 重新复核"}
                </Button>
              )}
            </div>
            {(llmBusy || llmReview) && (
              <LlmReview
                title="LLM 映射复核"
                busy={llmBusy}
                passed={llmReview?.passed}
                enabled={llmReview?.enabled}
                failed={llmReview?.failed}
                message={llmReview && !llmBusy ? llmReview.message : undefined}
                detail={llmReview?.detail}
                changes={llmChanges}
                pending={llmPending}
                onUndo={(change) => undoChange(change as DepMappingChange)}
                onAccept={(item) => acceptPending(item as DepPendingSuggestion)}
                onKeep={(item) =>
                  setLlmPending((current) =>
                    current.filter((value) => value.id !== item.id),
                  )
                }
                onSkip={() => {
                  reviewGeneration.current += 1;
                  setLlmBusy(false);
                  setLlmReview((current) =>
                    current
                      ? {
                          ...current,
                          failed: false,
                          passed: true,
                          message:
                            "已按用户选择跳过本次 LLM 复核，保留当前字段映射。",
                        }
                      : current,
                  );
                }}
              />
            )}
          </CardContent>
        </Card>
        {inspection && (
          <Card>
            <CardHeader>
              <CardTitle>2. 导出设置</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="form-grid">
                <Field label="资产负债表日" required>
                  <input
                    type="date"
                    value={balanceSheetDate}
                    onChange={(e) => setBalanceSheetDate(e.target.value)}
                  />
                </Field>
                <Field label="输出文件">
                  <FileInput
                    value={outputPath}
                    placeholder="选择清单后自动填入默认保存位置"
                    onBrowse={() => void chooseOutput()}
                    onClear={
                      outputPathTouched
                        ? () => {
                            setOutputPathTouched(false);
                            setOutputPath(path ? faDepDefaultOutputPath(path) : "");
                          }
                        : undefined
                    }
                    browseLabel="选择"
                    clearLabel="恢复默认"
                  />
                </Field>
              </div>
              <p className="hint">
                {outputPathTouched
                  ? "已指定保存位置，导出会写入上面这个文件。"
                  : "默认保存到清单所在目录，文件名为 折旧测算_<日期>_<时间>.xlsx（导出时按当前时间生成）。"}
              </p>
              {!!outputPaths.length && (
                <div className="fa-result-summary">
                  <strong>折旧测算表已生成</strong>
                  {outputPaths.map((output) => (
                    <Button
                      key={output}
                      variant="default"
                      onClick={() => void openOutput(output)}
                    >
                      打开结果：{output}
                    </Button>
                  ))}
                </div>
              )}
              <div className="actions">
                {busy && job ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void jobCancel(job.jobId)}
                  >
                    停止
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    disabled={!inspection || Boolean(missing.length)}
                    onClick={() => void startExport()}
                  >
                    生成折旧测算表
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}
        {inspection ? (
          <Card className="fa-result-workspace">
            <CardHeader>
              <CardTitle>清单预览与字段映射</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={inspection.headers}
                rows={inspection.preview}
                caption={
                  <div className="fa-table-caption">
                    <strong>
                      {inspection.displayName ?? inspection.selectedSheet ?? "清单"} ·{" "}
                      {inspection.dimensions?.rows ?? 0} 行 ×{" "}
                      {inspection.dimensions?.columns ?? 0} 列
                    </strong>
                    {missing.length > 0 && (
                      <span className="fa-caption-missing">
                        尚未映射：{missing.join("、")}
                      </span>
                    )}
                    {optionalMissing.length > 0 && (
                      <span
                        className="fa-caption-optional"
                        title="选填字段，留空不影响导出，对应的列会输出为空。"
                      >
                        选填未映射：{optionalMissing.join("、")}
                      </span>
                    )}
                  </div>
                }
                maxHeight={430}
                headerControls={columnControls}
              />
            </CardContent>
          </Card>
        ) : (
          <Card className="fa-result-workspace">
            <CardHeader>
              <CardTitle>清单预览与字段映射</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="empty">
                选择期末清单并读取结构后，在此显示表格内容，并在各列顶部下拉中选择对应字段。
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
