import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  openOutput,
  pickPath,
} from "./api";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { faDropSlotAtPosition, type FaDropSlot } from "./faDropTarget";
import {
  type FaMappingChange,
  type FaPendingSuggestion,
  type FaSupplementChange,
  canApplyFaSupplements,
  faDefaultOutputName,
  faDefaultOutputPath,
  faMappedRolesForColumn,
  faMissingOptionalRoles,
  faOutputPathAfterSourceSelection,
  faReviewNarrative,
  faReviewReasons,
  faHeaderOption,
  faRolesForSide,
  isFaMatchDisabled,
  planFaLlmChanges,
  planFaSupplementChanges,
  sanitizeFaBeginMapping,
  shouldAutoPrefillFaAddition,
  shouldShowFaAdditionFields,
  shouldShowFaPreviewWorkspace,
} from "./faListUi";
import type { ToolManifest } from "./types";
import { errorText } from "@/lib/errors";
import { ResultView } from "@/components/ResultView";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Field } from "@/components/Field";
import { FileInput } from "@/components/FileInput";
import { FileDropInput } from "@/components/FileDropInput";
import { StepIndicator } from "@/components/StepIndicator";
import { StatGrid } from "@/components/StatGrid";
import { DataTable } from "@/components/DataTable";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useJobEvents } from "@/hooks/useJobEvents";
type FaMapping = {
  matchKey?: string;
  matchKeys?: string[];
  category?: string;
  name?: string;
  originalValue?: string;
  depreciation?: string;
  startDate?: string;
  life?: string;
  residualRate?: string;
  currentYearDep?: string;
  additionMethod?: string;
  additionDate?: string;
  disposalMethod?: string;
  disposalDate?: string;
  disposalOriginal?: string;
  disposalDepreciation?: string;
};
type FaInspectSide = {
  headers: string[];
  preview: unknown[][];
  sheets: string[];
  selectedSheet?: string;
  displayName?: string;
  detectedHeaderRow?: number;
  headerMode?: "auto" | "manual";
  dimensions?: { rows: number; columns: number };
};
type FaInspectResult = {
  begin: FaInspectSide;
  end: FaInspectSide;
  suggestedMapping: { begin: FaMapping; end: FaMapping };
};
type FaSupplementInspect = FaInspectSide & {
  suggestedMapping?: FaMapping & { matchKeysVerified?: boolean };
};
type FaLlmSuggestion = {
  role: string;
  file_side?: "file1" | "file2";
  suggested_column?: string;
  confidence?: number;
  action?: string;
  reason?: string;
  current_mapping?: Record<string, string>;
  suggested_mapping?: unknown;
};
type FaMatchReview = {
  status: string;
  confidence: number;
  action: string;
  reasons: string[];
  suggested_file1_columns: string[];
  suggested_file2_columns: string[];
  suggestion_reason: string;
};
type FaLlmReview = {
  enabled: boolean;
  passed: boolean;
  message: string;
  autoApplied: FaLlmSuggestion[];
  fieldReviews: FaLlmSuggestion[];
  matchReview?: FaMatchReview;
  localProfile?: unknown;
  failed?: boolean;
  /// Rust 的诊断详情（超时、DNS、代理等），面向排查而不是面向流程。
  detail?: string;
};
type FaSupplementConfig = {
  path: string;
  sheet: string;
  headerRow: string;
  keys: string[];
  matchKeysVerified: boolean;
  method: string;
  date: string;
  originalValue: string;
  depreciation: string;
};
const emptyFaSupplement = (): FaSupplementConfig => ({
  path: "",
  sheet: "",
  headerRow: "",
  keys: [],
  matchKeysVerified: false,
  method: "",
  date: "",
  originalValue: "",
  depreciation: "",
});

type FaListDraft = {
  step: 1 | 2 | 3;
  beginPath: string;
  endPath: string;
  beginSheet: string;
  endSheet: string;
  beginHeaderRow: string;
  endHeaderRow: string;
  inspection?: FaInspectResult;
  beginKeys: string[];
  endKeys: string[];
  beginMapping: FaMapping;
  endMapping: FaMapping;
  beginDisplayName: string;
  endDisplayName: string;
  balanceSheetDate: string;
  outputPath: string;
  outputPathTouched: boolean;
  addition: FaSupplementConfig;
  disposal: FaSupplementConfig;
  additionInspect?: FaSupplementInspect;
  disposalInspect?: FaSupplementInspect;
  result?: unknown;
  matchStats?: FaMatchStats;
  supplementAutoHandled: boolean;
};

type FaMatchStats = {
  rows?: number;
  both?: number;
  beginOnly?: number;
  endOnly?: number;
  unmatchedAddition?: number;
  unmatchedDisposal?: number;
};

function faMatchStatsFromResult(value: unknown): FaMatchStats | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("stats" in value) ||
    !value.stats ||
    typeof value.stats !== "object"
  )
    return undefined;
  return value.stats as FaMatchStats;
}

// Tool routes unmount when the user switches tools. Keep the unfinished FA
// wizard in memory for the lifetime of the app so returning to FA List does
// not force the user to select and map the files again.
let faListDraftCache: FaListDraft | undefined;

/// Legacy named the workbook FA_List_<yyyymmdd>_<hhmmss>.xlsx without asking.
/// The Rust build kept the save dialog but left the name blank, so every export
/// meant typing one by hand.
const defaultExportName = faDefaultOutputName;

export function FaListPage({ tool }: { tool: ToolManifest }) {
  const draft = faListDraftCache;
  const empty: FaMapping = {};
  const [step, setStep] = useState<1 | 2 | 3>(draft?.step ?? 1);
  const [beginPath, setBeginPath] = useState(draft?.beginPath ?? "");
  const [endPath, setEndPath] = useState(draft?.endPath ?? "");
  const [beginSheet, setBeginSheet] = useState(draft?.beginSheet ?? "");
  const [endSheet, setEndSheet] = useState(draft?.endSheet ?? "");
  const [beginHeaderRow, setBeginHeaderRow] = useState(
    draft?.beginHeaderRow ?? "",
  );
  const [endHeaderRow, setEndHeaderRow] = useState(draft?.endHeaderRow ?? "");
  const [inspection, setInspection] = useState<FaInspectResult | undefined>(
    draft?.inspection,
  );
  const [beginKeys, setBeginKeys] = useState<string[]>(draft?.beginKeys ?? []);
  const [endKeys, setEndKeys] = useState<string[]>(draft?.endKeys ?? []);
  const [beginMapping, setBeginMapping] = useState<FaMapping>(
    sanitizeFaBeginMapping(draft?.beginMapping ?? empty) as FaMapping,
  );
  const [endMapping, setEndMapping] = useState<FaMapping>(
    draft?.endMapping ?? empty,
  );
  const [beginDisplayName, setBeginDisplayName] = useState(
    draft?.beginDisplayName ?? "期初",
  );
  const [endDisplayName, setEndDisplayName] = useState(
    draft?.endDisplayName ?? "期末",
  );
  const [balanceSheetDate, setBalanceSheetDate] = useState(
    draft?.balanceSheetDate ?? "2025-12-31",
  );
  const [outputPath, setOutputPath] = useState(draft?.outputPath ?? "");
  // 用户自己选过保存位置后就不再自动改写它；否则输出框跟着期末文件走，
  // 始终显示这次导出真正会写到哪里。
  const [outputPathTouched, setOutputPathTouched] = useState(
    draft?.outputPathTouched ?? false,
  );
  const [addition, setAddition] = useState<FaSupplementConfig>(
    draft?.addition ?? emptyFaSupplement,
  );
  const [disposal, setDisposal] = useState<FaSupplementConfig>(
    draft?.disposal ?? emptyFaSupplement,
  );
  const [additionInspect, setAdditionInspect] = useState<
    FaSupplementInspect | undefined
  >(draft?.additionInspect);
  const [disposalInspect, setDisposalInspect] = useState<
    FaSupplementInspect | undefined
  >(draft?.disposalInspect);
  const [supplementAutoHandled, setSupplementAutoHandled] = useState(
    draft?.supplementAutoHandled ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmReview, setLlmReview] = useState<FaLlmReview>();
  const [llmChanges, setLlmChanges] = useState<FaMappingChange[]>([]);
  const [llmPending, setLlmPending] = useState<FaPendingSuggestion[]>([]);
  const [supplementLlmChanges, setSupplementLlmChanges] = useState<
    FaSupplementChange[]
  >([]);
  const [supplementLlmPending, setSupplementLlmPending] = useState<
    FaPendingSuggestion[]
  >([]);
  const [llmBypassed, setLlmBypassed] = useState(false);
  const llmReviewGeneration = useRef(0);
  const [supplementLlmBusy, setSupplementLlmBusy] = useState(false);
  const [supplementLlmReview, setSupplementLlmReview] = useState<FaLlmReview>();
  const [supplementLlmBypassed, setSupplementLlmBypassed] = useState(false);
  const supplementReviewGeneration = useRef(0);
  const autoSupplementReviewKey = useRef("");
  const { job, setJob, activeJobId } = useJobEvents({
    toolId: "fa_list",
    onEvent: (event) => {
      if (event.result) {
        setResult(event.result);
        const stats = faMatchStatsFromResult(event.result);
        if (stats) setMatchStats(stats);
      }
      setBusy(!["completed", "failed", "cancelled"].includes(event.phase));
      if (event.phase === "failed") setError(event.message);
    },
  });
  // Tauri 会拦截 DOM 文件拖放，因此仍监听窗口级事件；但落点必须
  // 命中实际上传框，不能用窗口左右/上下中线猜测。
  const dragTargetRef = useRef<FaDropSlot | null>(null);
  const [dragHover, setDragHover] = useState<FaDropSlot | null>(null);
  const applyPathRef = useRef<(side: FaDropSlot, value: string) => void>(() => {});
  const beginDropRef = useRef<HTMLDivElement>(null);
  const endDropRef = useRef<HTMLDivElement>(null);
  const additionDropRef = useRef<HTMLDivElement>(null);
  const disposalDropRef = useRef<HTMLDivElement>(null);
  const dragScaleFactorRef = useRef(1);
  applyPathRef.current = (slot, value) => {
    if (slot === "begin" || slot === "end") applyPath(slot, value);
    else applySupplementPath(slot, value);
  };
  useEffect(() => {
    let off: () => void = () => {};
    console.log("[fa] registering drag drop listener");
    // 浏览器预览模式没有 Tauri 环境，getCurrentWebview() 会抛错（读不到 metadata），
    // 拖放只在 Tauri 真机可用，预览模式直接跳过监听。
    const inTauriEnv =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!inTauriEnv) return () => undefined;
    void getCurrentWindow()
      .scaleFactor()
      .then((factor) => {
        dragScaleFactorRef.current = factor;
      })
      .catch(() => {
        dragScaleFactorRef.current = window.devicePixelRatio || 1;
      });
    const targetAt = (position: { x: number; y: number }) =>
      faDropSlotAtPosition(position, dragScaleFactorRef.current, [
        ["begin", beginDropRef.current?.getBoundingClientRect() ?? null],
        ["end", endDropRef.current?.getBoundingClientRect() ?? null],
        ["addition", additionDropRef.current?.getBoundingClientRect() ?? null],
        ["disposal", disposalDropRef.current?.getBoundingClientRect() ?? null],
      ]);
    // Tauri 官方 onDragDropEvent：监听 tauri://drag-* 系列，事件带 position 与 paths。
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        console.log("[fa] drag event:", JSON.stringify(event.payload));
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "enter") {
          const target = targetAt(payload.position);
          dragTargetRef.current = target;
          setDragHover(target);
        } else if (payload.type === "drop") {
          // drop 事件自带最终坐标，再命中一次，避免最后一次 over
          // 和松手位置不同时把文件发给旧目标。
          const target = targetAt(payload.position);
          if (target && payload.paths.length) {
            applyPathRef.current(target, payload.paths[0]);
          }
          dragTargetRef.current = null;
          setDragHover(null);
        } else if (payload.type === "leave") {
          dragTargetRef.current = null;
          setDragHover(null);
        }
      })
      .then((fn) => {
        off = fn;
        console.log("[fa] drag drop listener registered");
      })
      .catch((e) => console.error("[fa] drag listener error:", e));
    return () => off();
  }, []);
  const setDragTarget = (target: "begin" | "end", active: boolean) => {
    dragTargetRef.current = active ? target : null;
    setDragHover(active ? target : null);
  };
  const setSupplementDragTarget = (kind: "addition" | "disposal", active: boolean) => {
    dragTargetRef.current = active ? kind : null;
    setDragHover(active ? kind : null);
  };
  const [result, setResult] = useState<unknown>(draft?.result);
  // Export results intentionally contain no preview statistics. Keep the last
  // successful merge statistics separately so exporting does not lock step 2.
  const [matchStats, setMatchStats] = useState<FaMatchStats | undefined>(
    draft?.matchStats ?? faMatchStatsFromResult(draft?.result),
  );
  const [error, setError] = useState("");
  // LLM 复核是异步的。界面在等待期间会锁定手工映射；这里仍以最新状态应用，
  // 防止其他状态更新或后续流程调整被异步结果整体覆盖。
  const faStateRef = useRef({
    beginMapping,
    endMapping,
    beginKeys,
    endKeys,
    addition,
    disposal,
  });
  faStateRef.current = {
    beginMapping,
    endMapping,
    beginKeys,
    endKeys,
    addition,
    disposal,
  };
  useEffect(() => {
    faListDraftCache = {
      step,
      beginPath,
      endPath,
      beginSheet,
      endSheet,
      beginHeaderRow,
      endHeaderRow,
      inspection,
      beginKeys,
      endKeys,
      beginMapping,
      endMapping,
      beginDisplayName,
      endDisplayName,
      balanceSheetDate,
      outputPath,
      outputPathTouched,
      addition,
      disposal,
      additionInspect,
      disposalInspect,
      result,
      matchStats,
      supplementAutoHandled,
    };
  });
  // 默认落点与旧版一致（期末文件旁的 FA_List_<时间戳>.xlsx），但要在导出前就
  // 显示出来：用户看得见文件会写到哪里，不想要再点「选择」改。
  useEffect(() => {
    if (outputPathTouched) return;
    setOutputPath(endPath ? faDefaultOutputPath(endPath) : "");
  }, [endPath, outputPathTouched]);
  useEffect(() => {
    const inspectedSelectionIsReady = (
      config: FaSupplementConfig,
      info: FaSupplementInspect | undefined,
    ) =>
      Boolean(
        config.path &&
        info &&
        (!info.sheets.length ||
          (config.sheet && info.selectedSheet === config.sheet)),
      );
    // 自动复核只在新增、处置两张补充表都完成 Sheet 人工选择并读取后触发。
    // 单张表读取完不再抢跑，避免另一张表随后加入时重复复核、重复改映射。
    if (
      !inspectedSelectionIsReady(addition, additionInspect) ||
      !inspectedSelectionIsReady(disposal, disposalInspect)
    )
      return;
    const key = [
      addition.path,
      addition.sheet,
      addition.headerRow,
      disposal.path,
      disposal.sheet,
      disposal.headerRow,
    ].join("\u0000");
    if (autoSupplementReviewKey.current === key) return;
    autoSupplementReviewKey.current = key;
    void reviewSupplements(addition, disposal);
  }, [
    addition.path,
    addition.sheet,
    addition.headerRow,
    additionInspect,
    disposal.path,
    disposal.sheet,
    disposal.headerRow,
    disposalInspect,
  ]);
  const faStats = faMatchStatsFromResult(result) ?? matchStats;
  useEffect(() => {
    if (
      faStats &&
      shouldAutoPrefillFaAddition(
        endMapping.additionMethod,
        Number(faStats.endOnly || 0),
        supplementAutoHandled,
      )
    ) {
      setSupplementAutoHandled(true);
      if (!addition.path && inspection) {
        const prefilledAddition: FaSupplementConfig = {
          path: endPath,
          sheet: endSheet || inspection.end.selectedSheet || "",
          headerRow:
            endHeaderRow || String(inspection.end.detectedHeaderRow ?? ""),
          keys: [...endKeys],
          matchKeysVerified: true,
          method: endMapping.additionMethod ?? "",
          date: endMapping.additionDate ?? "",
          originalValue: "",
          depreciation: "",
        };
        setAddition(prefilledAddition);
        setAdditionInspect({
          ...inspection.end,
          suggestedMapping: endMapping,
        });
        setSupplementLlmBypassed(false);
      }
      setStep(2);
    }
  }, [
    faStats,
    supplementAutoHandled,
    endMapping.additionMethod,
    addition.path,
    inspection,
    endPath,
    endSheet,
    endHeaderRow,
    endKeys,
    endMapping,
    disposal,
  ]);
  // 把选中的路径应用到期初/期末（点击选择与拖拽上传共用）。
  function applyPath(side: "begin" | "end", value: string) {
    // 换了源文件就放弃上次手选的保存位置，让默认落点跟着新文件重新算。
    const previousSource = side === "begin" ? beginPath : endPath;
    if (previousSource !== value) setOutputPathTouched(false);
    const nextBegin = side === "begin" ? value : beginPath;
    const nextEnd = side === "end" ? value : endPath;
    if (side === "begin") {
      setOutputPath((current) =>
        faOutputPathAfterSourceSelection(current, beginPath, value),
      );
      setBeginPath(value);
      setBeginSheet("");
      setBeginHeaderRow("");
    } else {
      setOutputPath((current) =>
        faOutputPathAfterSourceSelection(current, endPath, value),
      );
      setEndPath(value);
      setEndSheet("");
      setEndHeaderRow("");
    }
    setInspection(undefined);
    setResult(undefined);
    setMatchStats(undefined);
    setStep(1);
    setSupplementAutoHandled(false);
    // 与补充清单一致：选完文件自动解析。主文件需要两个都选好才解析。
    if (nextBegin && nextEnd) {
      void inspect({ beginPath: nextBegin, endPath: nextEnd });
    }
  }
  async function choose(side: "begin" | "end") {
    const value = await pickPath(
      "file",
      side === "begin" ? "选择期初固定资产清单" : "选择期末固定资产清单",
      ["xlsx", "xls", "xlsm", "csv", "txt"],
    );
    if (typeof value === "string") {
      applyPath(side, value);
      setLlmReview(undefined);
      setSupplementLlmReview(undefined);
      setAddition(emptyFaSupplement());
      setDisposal(emptyFaSupplement());
      setAdditionInspect(undefined);
      setDisposalInspect(undefined);
    }
  }
  function clearMainFile(side: "begin" | "end") {
    if (side === "begin") {
      setBeginPath("");
      setBeginSheet("");
      setBeginHeaderRow("");
      setBeginDisplayName("期初");
    } else {
      setEndPath("");
      setEndSheet("");
      setEndHeaderRow("");
      setEndDisplayName("期末");
    }
    llmReviewGeneration.current += 1;
    supplementReviewGeneration.current += 1;
    setInspection(undefined);
    setBeginKeys([]);
    setEndKeys([]);
    setBeginMapping({});
    setEndMapping({});
    setAddition(emptyFaSupplement());
    setDisposal(emptyFaSupplement());
    setAdditionInspect(undefined);
    setDisposalInspect(undefined);
    setLlmReview(undefined);
    setSupplementLlmReview(undefined);
    setLlmBusy(false);
    setSupplementLlmBusy(false);
    setResult(undefined);
    setMatchStats(undefined);
    setOutputPath("");
    setOutputPathTouched(false);
    setJob(undefined);
    setError("");
    setSupplementAutoHandled(false);
    setStep(1);
  }
  async function inspect(overrides?: { beginPath?: string; endPath?: string }) {
    const bPath = overrides?.beginPath ?? beginPath;
    const ePath = overrides?.endPath ?? endPath;
    if (!bPath || !ePath) {
      setError("请选择期初和期末文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const value = (await engineCall("fa.inspect", {
        beginPath: bPath,
        endPath: ePath,
        beginSheet: beginSheet || undefined,
        endSheet: endSheet || undefined,
        beginHeaderRow: beginHeaderRow.trim()
          ? Number(beginHeaderRow)
          : undefined,
        endHeaderRow: endHeaderRow.trim() ? Number(endHeaderRow) : undefined,
      })) as FaInspectResult;
      setInspection(value);
      setSupplementAutoHandled(false);
      setLlmBypassed(false);
      setBeginSheet(value.begin.selectedSheet ?? beginSheet);
      setEndSheet(value.end.selectedSheet ?? endSheet);
      setBeginDisplayName(value.begin.displayName ?? "期初");
      setEndDisplayName(value.end.displayName ?? "期末");
      setBeginHeaderRow(String(value.begin.detectedHeaderRow ?? ""));
      setEndHeaderRow(String(value.end.detectedHeaderRow ?? ""));
      const suggestedBegin: FaMapping = {
        ...(value.suggestedMapping.begin ?? {}),
        currentYearDep: undefined,
        additionMethod: undefined,
        additionDate: undefined,
        disposalMethod: undefined,
        disposalDate: undefined,
        disposalOriginal: undefined,
        disposalDepreciation: undefined,
      };
      const suggestedEnd: FaMapping = {
        ...(value.suggestedMapping.end ?? {}),
        disposalMethod: undefined,
        disposalDate: undefined,
        disposalOriginal: undefined,
        disposalDepreciation: undefined,
      };
      const suggestedBeginKeys =
        value.suggestedMapping.begin?.matchKeys ??
        (value.suggestedMapping.begin?.matchKey
          ? [value.suggestedMapping.begin.matchKey]
          : []);
      const suggestedEndKeys =
        value.suggestedMapping.end?.matchKeys ??
        (value.suggestedMapping.end?.matchKey
          ? [value.suggestedMapping.end.matchKey]
          : []);
      // 建议映射可能已含 matchKeys；统一补上，保证 mapping 与 keys 影子 state 一致
      setBeginMapping({ ...suggestedBegin, matchKeys: suggestedBeginKeys });
      setEndMapping({ ...suggestedEnd, matchKeys: suggestedEndKeys });
      setBeginKeys(suggestedBeginKeys);
      setEndKeys(suggestedEndKeys);
      setResult(value);
      void reviewLlm({
        beginPath: bPath,
        endPath: ePath,
        beginSheet: value.begin.selectedSheet,
        endSheet: value.end.selectedSheet,
        beginHeaderRow: value.begin.detectedHeaderRow,
        endHeaderRow: value.end.detectedHeaderRow,
        beginMapping: suggestedBegin,
        endMapping: suggestedEnd,
        beginKeys: suggestedBeginKeys,
        endKeys: suggestedEndKeys,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  // LLM 认为该改就直接改，改动逐条进变更清单供核对，不认可可撤销。
  function applyLlmPlan(review: FaLlmReview) {
    const current = faStateRef.current;
    const plan = planFaLlmChanges({
      beginMapping: current.beginMapping,
      endMapping: current.endMapping,
      beginKeys: current.beginKeys,
      endKeys: current.endKeys,
      autoApplied: review.autoApplied,
      fieldReviews: review.fieldReviews,
      matchReview: review.matchReview,
      roleLabels: Object.fromEntries(mappingRoles),
    });
    setBeginMapping(plan.beginMapping as FaMapping);
    setEndMapping(plan.endMapping as FaMapping);
    setBeginKeys(plan.beginKeys);
    setEndKeys(plan.endKeys);
    setLlmChanges(plan.changes);
    setLlmPending(plan.pending);
    return plan.changes;
  }
  // 采纳低把握建议后同样进变更清单，保留反悔的机会。
  function acceptLlmPending(item: FaPendingSuggestion) {
    const apply = item.apply;
    if (apply.kind === "matchKeys") {
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
            kind: "matchKeys",
            begin: faStateRef.current.beginKeys,
            end: faStateRef.current.endKeys,
          },
        },
      ]);
      setBeginKeys(apply.begin);
      setEndKeys(apply.end);
    } else if (apply.kind === "mapping") {
      const before =
        apply.side === "begin"
          ? faStateRef.current.beginMapping[apply.key as keyof FaMapping]
          : faStateRef.current.endMapping[apply.key as keyof FaMapping];
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
            kind: "mapping",
            side: apply.side,
            key: apply.key,
            value: typeof before === "string" ? before : undefined,
          },
        },
      ]);
      setMapping(apply.side, apply.key as keyof FaMapping, apply.value ?? "");
    }
    setLlmPending((current) => current.filter((value) => value.id !== item.id));
  }
  function undoLlmChange(change: FaMappingChange) {
    if (change.restore.kind === "matchKeys") {
      setBeginKeys(change.restore.begin);
      setEndKeys(change.restore.end);
    } else {
      setMapping(
        change.restore.side,
        change.restore.key as keyof FaMapping,
        change.restore.value ?? "",
      );
    }
    setLlmChanges((current) => current.filter((item) => item.id !== change.id));
  }
  async function reviewLlm(
    override: Partial<{
      beginPath: string;
      endPath: string;
      beginSheet: string;
      endSheet: string;
      beginHeaderRow: number;
      endHeaderRow: number;
      beginMapping: FaMapping;
      endMapping: FaMapping;
      beginKeys: string[];
      endKeys: string[];
    }> = {},
  ) {
    const reviewBeginPath = override.beginPath ?? beginPath;
    const reviewEndPath = override.endPath ?? endPath;
    if (!reviewBeginPath || !reviewEndPath) return;
    const generation = ++llmReviewGeneration.current;
    setLlmBusy(true);
    setLlmBypassed(false);
    setLlmChanges([]);
    setLlmPending([]);
    try {
      const value = (await engineCall("fa.review", {
        beginPath: reviewBeginPath,
        endPath: reviewEndPath,
        beginSheet: override.beginSheet ?? beginSheet,
        endSheet: override.endSheet ?? endSheet,
        beginHeaderRow:
          override.beginHeaderRow ?? (Number(beginHeaderRow) || 1),
        endHeaderRow: override.endHeaderRow ?? (Number(endHeaderRow) || 1),
        beginMapping: sanitizeFaBeginMapping(
          override.beginMapping ?? beginMapping,
        ),
        endMapping: override.endMapping ?? endMapping,
        beginKeys: override.beginKeys ?? beginKeys,
        endKeys: override.endKeys ?? endKeys,
      })) as FaLlmReview;
      if (generation !== llmReviewGeneration.current) return;
      setLlmReview(value);
      applyLlmPlan(value);
    } catch (e) {
      if (generation !== llmReviewGeneration.current) return;
      // 说清三件事：失败的是哪一部分、脚本映射不受影响、以及技术原因（否则
      // 用户只能看到"网络请求失败"，无从判断是没配代理还是地址填错）。
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
      if (generation === llmReviewGeneration.current) setLlmBusy(false);
    }
  }
  // 把选中的补充清单路径应用到期初新增/期末处置（点击选择与拖拽共用）。
  function applySupplementPath(kind: "addition" | "disposal", value: string) {
    const setter = kind === "addition" ? setAddition : setDisposal;
    // A newly selected workbook must not inherit the previous workbook's
    // sheet/header/mapping.  Read it immediately so a multi-sheet workbook can
    // expose its sheet picker without an extra, easy-to-miss step.
    const selected = { ...emptyFaSupplement(), path: value };
    setter(selected);
    supplementReviewGeneration.current += 1;
    autoSupplementReviewKey.current = "";
    setSupplementLlmBusy(false);
    setSupplementLlmReview(undefined);
    setSupplementLlmBypassed(false);
    if (kind === "addition") setAdditionInspect(undefined);
    else setDisposalInspect(undefined);
    void inspectSupplement(kind, selected, true);
  }
  async function chooseSupplement(kind: "addition" | "disposal") {
    const value = await pickPath(
      "file",
      kind === "addition" ? "选择本期新增清单" : "选择本期处置清单",
      ["xlsx", "xls", "xlsm", "csv", "txt"],
    );
    if (typeof value !== "string") return;
    applySupplementPath(kind, value);
  }
  async function inspectSupplement(
    kind: "addition" | "disposal",
    overrides?: Partial<FaSupplementConfig>,
    requireSheetChoice = false,
  ) {
    const current = kind === "addition" ? addition : disposal;
    const config = { ...current, ...overrides };
    if (!config.path) return;
    setBusy(true);
    setError("");
    try {
      const value = (await engineCall("fa.supplement_inspect", {
        path: config.path,
        sheet: config.sheet || undefined,
        headerRow: config.headerRow.trim()
          ? Number(config.headerRow)
          : undefined,
        referenceKeys: kind === "addition" ? endKeys : beginKeys,
        // 新增清单必须能与期末（file2）卡片的既定匹配键逐值碰撞；
        // 处置清单则必须能与期初（file1）卡片碰撞。只传列名无法
        // 区分像 `coding` / `资产编码_2` 这类同义列，因此让 Rust 直接
        // 对两张表的真实样本值做精确匹配。
        referencePath: kind === "addition" ? endPath : beginPath,
        referenceSheet: kind === "addition" ? endSheet : beginSheet,
        referenceHeaderRow:
          kind === "addition"
            ? Number(endHeaderRow) || undefined
            : Number(beginHeaderRow) || undefined,
      })) as FaSupplementInspect;
      // For Excel supplements, browsing the workbook only discovers its sheet
      // names.  The user must explicitly choose a sheet before any header or
      // field mapping is accepted; silently taking the first sheet can map a
      // cover/summary tab as transaction detail.
      const awaitingSheet = requireSheetChoice && value.sheets.length > 0;
      const updated: FaSupplementConfig = awaitingSheet
        ? {
            ...config,
            sheet: "",
            headerRow: "",
            keys: [],
            matchKeysVerified: false,
            method: "",
            date: "",
            originalValue: "",
            depreciation: "",
          }
        : {
            ...config,
            sheet: value.selectedSheet ?? config.sheet,
            headerRow: String(value.detectedHeaderRow ?? ""),
            keys:
              value.suggestedMapping?.matchKeys ??
              (value.suggestedMapping?.matchKey
                ? [value.suggestedMapping.matchKey]
                : config.keys),
            matchKeysVerified:
              value.suggestedMapping?.matchKeysVerified ?? false,
            method:
              kind === "addition"
                ? (value.suggestedMapping?.additionMethod ?? config.method)
                : (value.suggestedMapping?.disposalMethod ?? config.method),
            date:
              kind === "addition"
                ? (value.suggestedMapping?.additionDate ?? config.date)
                : (value.suggestedMapping?.disposalDate ?? config.date),
            originalValue:
              kind === "disposal"
                ? (value.suggestedMapping?.disposalOriginal ??
                  value.suggestedMapping?.originalValue ??
                  config.originalValue)
                : "",
            depreciation:
              kind === "disposal"
                ? (value.suggestedMapping?.disposalDepreciation ??
                  value.suggestedMapping?.depreciation ??
                  config.depreciation)
                : "",
          };
      const setter = kind === "addition" ? setAddition : setDisposal;
      setter(updated);
      if (kind === "addition") setAdditionInspect(value);
      else setDisposalInspect(value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function clearSupplement(kind: "addition" | "disposal") {
    supplementReviewGeneration.current += 1;
    autoSupplementReviewKey.current = "";
    setSupplementLlmBusy(false);
    setSupplementLlmReview(undefined);
    setSupplementLlmBypassed(false);
    setSupplementLlmChanges([]);
    setSupplementLlmPending([]);
    setError("");
    setSupplementAutoHandled(true);
    if (kind === "addition") {
      setAddition(emptyFaSupplement());
      setAdditionInspect(undefined);
    } else {
      setDisposal(emptyFaSupplement());
      setDisposalInspect(undefined);
    }
  }
  // 与主流程一致：补充清单的 LLM 建议也是先改后核，改动进清单可撤销。
  function applySupplementLlmPlan(review: FaLlmReview) {
    const plan = planFaSupplementChanges({
      addition: faStateRef.current.addition,
      disposal: faStateRef.current.disposal,
      autoApplied: review.autoApplied,
      fieldReviews: review.fieldReviews,
      matchReview: review.matchReview,
    });
    setAddition(plan.addition as FaSupplementConfig);
    setDisposal(plan.disposal as FaSupplementConfig);
    setSupplementLlmChanges(plan.changes);
    setSupplementLlmPending(plan.pending);
    return plan.changes;
  }
  function acceptSupplementLlmPending(item: FaPendingSuggestion) {
    const apply = item.apply;
    if (apply.kind !== "supplement" && apply.kind !== "supplementKeys") return;
    const target = apply.target;
    const source =
      target === "addition"
        ? faStateRef.current.addition
        : faStateRef.current.disposal;
    setSupplementLlmChanges((current) => [
      ...current,
      {
        id: item.id,
        label: item.label,
        before: item.current,
        after: item.suggested,
        reason: item.reason,
        confidence: item.confidence,
        attention: true,
        restore:
          apply.kind === "supplementKeys"
            ? { kind: "supplementKeys", target, keys: source.keys }
            : {
                kind: "supplement",
                target,
                key: apply.key,
                value: source[apply.key as keyof FaSupplementConfig] as string,
              },
      },
    ]);
    const update = (current: FaSupplementConfig): FaSupplementConfig =>
      apply.kind === "supplementKeys"
        ? { ...current, keys: apply.keys }
        : { ...current, [apply.key]: apply.value ?? "" };
    if (target === "addition") setAddition(update);
    else setDisposal(update);
    setSupplementLlmPending((current) =>
      current.filter((value) => value.id !== item.id),
    );
  }
  function undoSupplementLlmChange(change: FaSupplementChange) {
    const update = (current: FaSupplementConfig): FaSupplementConfig =>
      change.restore.kind === "supplementKeys"
        ? { ...current, keys: change.restore.keys }
        : { ...current, [change.restore.key]: change.restore.value ?? "" };
    if (change.restore.target === "addition") setAddition(update);
    else setDisposal(update);
    setSupplementLlmChanges((current) =>
      current.filter((item) => item.id !== change.id),
    );
  }
  async function reviewSupplements(
    additionValue = addition,
    disposalValue = disposal,
  ) {
    if (!additionValue.path && !disposalValue.path) return;
    const generation = ++supplementReviewGeneration.current;
    setSupplementLlmBusy(true);
    setSupplementLlmBypassed(false);
    setSupplementLlmChanges([]);
    setSupplementLlmPending([]);
    try {
      const value = (await engineCall("fa.supplement_review", {
        addition: additionValue.path
          ? supplementPayload(additionValue)
          : undefined,
        disposal: disposalValue.path
          ? supplementPayload(disposalValue)
          : undefined,
        beginKeys,
        endKeys,
      })) as FaLlmReview;
      if (generation !== supplementReviewGeneration.current) return;
      setSupplementLlmReview(value);
      applySupplementLlmPlan(value);
    } catch (e) {
      if (generation !== supplementReviewGeneration.current) return;
      setSupplementLlmReview({
        enabled: true,
        passed: false,
        message: errorText(e),
        autoApplied: [],
        fieldReviews: [],
      });
    } finally {
      if (generation === supplementReviewGeneration.current)
        setSupplementLlmBusy(false);
    }
  }
  const supplementPayload = (value: FaSupplementConfig) =>
    value.path
      ? {
          path: value.path,
          sheet: value.sheet || undefined,
          headerRow: Number(value.headerRow) || 1,
          keys: value.keys,
          matchKeysVerified: value.matchKeysVerified,
          method: value.method || undefined,
          date: value.date || undefined,
          originalValue: value.originalValue || undefined,
          depreciation: value.depreciation || undefined,
        }
      : undefined;
  const payload = () => ({
    beginPath,
    endPath,
    beginSheet: beginSheet || undefined,
    endSheet: endSheet || undefined,
    beginHeaderRow: Number(beginHeaderRow) || 1,
    endHeaderRow: Number(endHeaderRow) || 1,
    beginKeys,
    endKeys,
    beginMapping,
    endMapping: {
      ...endMapping,
      additionDate: endMapping.additionMethod
        ? endMapping.additionDate
        : undefined,
    },
    beginOriginalValue: beginMapping.originalValue,
    endOriginalValue: endMapping.originalValue,
    beginDepreciation: beginMapping.depreciation,
    endDepreciation: endMapping.depreciation,
    endResidualRate: endMapping.residualRate,
    beginDisplayName,
    endDisplayName,
    balanceSheetDate: balanceSheetDate || undefined,
    additionSupplement: supplementPayload(addition),
    disposalSupplement: supplementPayload(disposal),
    outputPath: outputPath || undefined,
  });
  async function start(method: "fa.match" | "fa.export") {
    if (!beginPath || !endPath) {
      setError("请选择期初和期末文件。");
      return;
    }
    if (!beginKeys.length || beginKeys.length !== endKeys.length) {
      setError("期初和期末必须选择数量相同的匹配列。");
      return;
    }
    if (method === "fa.match" && llmBusy) {
      // LLM is advisory. Freeze the currently visible deterministic mapping
      // instead of letting a late response race with the merge payload.
      llmReviewGeneration.current += 1;
      setLlmBusy(false);
      setLlmBypassed(true);
    }
    if (method === "fa.match") {
      setSupplementAutoHandled(false);
      setMatchStats(undefined);
    }
    // 输出框里已经显示了这次会写到哪，所以不再弹保存对话框。默认落点是算出来的，
    // 时间戳要按「开始导出」的时刻刷新一次，否则文件名停留在选文件的时间。
    let target = outputPath;
    if (method === "fa.export" && !outputPathTouched) {
      target = faDefaultOutputPath(endPath);
      if (target) setOutputPath(target);
    }
    if (method === "fa.export" && !target.trim()) {
      const picked = await pickPath(
        "save",
        "保存 FA List 底稿",
        ["xlsx"],
        defaultExportName(),
      );
      if (typeof picked !== "string" || !picked.trim()) return;
      target = picked;
      setOutputPath(picked);
      setOutputPathTouched(true);
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const jobId = await jobStart(method, {
        ...payload(),
        outputPath: target || undefined,
      });
      setJob({
        jobId,
        toolId: "fa_list",
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
  async function chooseOutput() {
    const value = await pickPath(
      "save",
      "保存 FA List 底稿",
      ["xlsx", "csv"],
      defaultExportName(),
    );
    if (typeof value === "string") {
      setOutputPath(value);
      setOutputPathTouched(true);
    }
  }
  function resetOutputPath() {
    setOutputPathTouched(false);
    setOutputPath(endPath ? faDefaultOutputPath(endPath) : "");
  }
  // 设置字段映射。matchKeys 是数组角色（匹配列，多选），其余是单值 string。
  // matchKeys 作为权威数据源写入 mapping，同时同步影子 state beginKeys/endKeys
  // （LLM 复核、Rust payload 契约仍读 beginKeys/endKeys，保持双写一致）。
  const setMapping = (
    side: "begin" | "end",
    key: keyof FaMapping,
    value: string | string[],
  ) => {
    const isMatchKeys = key === "matchKeys";
    const arrayValue = isMatchKeys
      ? Array.isArray(value)
        ? value
        : value
          ? [value]
          : []
      : undefined;
    const scalarValue = isMatchKeys ? undefined : String(value || "");
    if (side === "begin") {
      setBeginMapping((current) => ({
        ...current,
        [key]: isMatchKeys ? arrayValue : scalarValue || undefined,
      }));
      if (isMatchKeys && arrayValue) setBeginKeys(arrayValue);
    } else {
      setEndMapping((current) => ({
        ...current,
        [key]: isMatchKeys ? arrayValue : scalarValue || undefined,
      }));
      if (isMatchKeys && arrayValue) setEndKeys(arrayValue);
    }
  };
  // FA 匹配必需的角色：必须完成映射才能进入下一步
  const REQUIRED_ROLES: [keyof FaMapping, string][] = [
    ["matchKeys", "组合匹配键"],
    ["category", "资产类别"],
    ["name", "资产名称"],
    ["originalValue", "原值"],
    ["depreciation", "累计折旧"],
  ];
  // 计算单侧文件未映射的必需角色（返回中文标签列表）
  const missingRoles = (side: "begin" | "end"): string[] => {
    const mapping = side === "begin" ? beginMapping : endMapping;
    const missing: string[] = [];
    for (const [key, label] of REQUIRED_ROLES) {
      const v = mapping[key];
      const has =
        Array.isArray(v) ? v.length > 0 : Boolean(v && String(v).trim());
      if (!has) missing.push(label);
    }
    return missing;
  };
  const mappingRoles: [keyof FaMapping, string][] = [
    ["category", "资产类别"],
    ["name", "资产名称"],
    ["originalValue", "原值"],
    ["depreciation", "累计折旧"],
    ["startDate", "开始使用日期"],
    ["life", "使用寿命"],
    ["residualRate", "残值率"],
    ["currentYearDep", "本年折旧"],
    ["additionMethod", "新增方式"],
    ["additionDate", "新增日期"],
  ];
  // Match the legacy wizard: the optional addition group is only visible
  // when an addition-method column has actually been identified.
  const visibleMappingRoles = mappingRoles.filter(
    ([key]) =>
      !["additionMethod", "additionDate"].includes(key) ||
      shouldShowFaAdditionFields(endMapping.additionMethod),
  );
  // 文件1 不出现只属于文件2的角色（本年折旧/新增方式/新增日期）。
  // 判定清单复用 faListUi 的 FA_FILE2_ONLY_MAPPING_KEYS，不另写一份。
  const rolesForSide = (side: "begin" | "end"): [keyof FaMapping, string][] =>
    faRolesForSide(side, visibleMappingRoles);
  const missingOptionalRoles = (side: "begin" | "end"): string[] =>
    faMissingOptionalRoles(
      side,
      visibleMappingRoles,
      REQUIRED_ROLES.map(([key]) => key),
      (side === "begin" ? beginMapping : endMapping) as Record<
        string,
        string | string[] | undefined
      >,
    );
  const multi = (event: ChangeEvent<HTMLSelectElement>) =>
    Array.from(event.target.selectedOptions).map((option) => option.value);
  // 单侧字段映射列表（参考看账 kz-map）：第一行「组合匹配键」多选，
  // 其余角色单选。每个下拉直接列该文件的全部表头。
  const faMapSide = (
    side: "begin" | "end",
    inspect: FaInspectSide,
    mapping: FaMapping,
  ) => {
    const headers = inspect.headers;
    const keys = side === "begin" ? beginKeys : endKeys;
    // 已用表头集合（步骤 4：颜色区分）
    const usedHeaders = new Set<string>();
    const used = (key: keyof FaMapping, value: string) => {
      if (value) usedHeaders.add(value);
      return value;
    };
    return (
      <div className="fa-map-fields">
        <Field label="组合匹配键（可多列）">
          <select
            multiple
            disabled={llmBusy}
            size={Math.min(6, Math.max(3, headers.length))}
            value={keys}
            onChange={(e) => setMapping(side, "matchKeys", multi(e))}
          >
            {headers.map((header, index) => {
              const option = faHeaderOption(header);
              return (
                <option
                  key={`${header}-${index}`}
                  value={option.value}
                  title={option.label}
                >
                  {option.label}
                </option>
              );
            })}
          </select>
        </Field>
        {rolesForSide(side).map(([key, label]) => {
          const currentValue = mapping[key];
          const currentText = used(key, String(currentValue ?? ""));
          return (
            <Field key={key} label={label}>
              <select
                disabled={llmBusy}
                value={currentText}
                onChange={(e) => {
                  const value = e.target.value;
                  setMapping(side, key, value);
                  if (key === "additionMethod" && !value) {
                    setMapping(side, "additionDate", "");
                  }
                }}
              >
                <option value="">不映射</option>
                {headers.map((header, index) => {
                  const option = faHeaderOption(header);
                  const isUsed = usedHeaders.has(option.value) && option.value !== currentValue;
                  return (
                    <option
                      key={`${header}-${index}`}
                      value={option.value}
                      title={option.label}
                      className={isUsed ? "fa-map-option-used" : undefined}
                    >
                      {option.label}
                    </option>
                  );
                })}
              </select>
            </Field>
          );
        })}
      </div>
    );
  };
  // 每列顶部一个角色映射下拉（参考看账/旧代码：列标题上方选映射）。
  // 返回每列的映射控件 + 是否已映射标记。
  const columnMappingControls = (
    side: "begin" | "end",
    inspect: FaInspectSide,
    mapping: FaMapping,
  ): { controls: React.ReactNode[]; mappedFlags: boolean[] } => {
    const roleOptions: [keyof FaMapping, string][] = [
      ["matchKeys", "组合匹配键"],
      ...rolesForSide(side),
    ];
    // 已被某列占用的角色集合（跨列感知，用于标记"已映射"）
    const usedRoles = new Set<string>();
    for (const header of inspect.headers) {
      const colValue = header.trim();
      for (const [key] of roleOptions) {
        const v = mapping[key];
        const occupied =
          Array.isArray(v) ? v.includes(colValue) : String(v ?? "") === colValue;
        if (occupied) usedRoles.add(key);
      }
    }
    const controls: React.ReactNode[] = [];
    const mappedFlags: boolean[] = [];
    for (const header of inspect.headers) {
      const colValue = header.trim();
      // 同一列可以同时承担组合匹配键、资产名称等多个角色。原先用 find
      // 只显示第一个，复核时看不到完整关系；这里保留全部角色并合并展示。
      const mappedRoles = faMappedRolesForColumn(colValue, roleOptions, mapping);
      const mappedRole = mappedRoles[0];
      const multipleValue = `__multiple__:${colValue}`;
      mappedFlags.push(mappedRoles.length > 0);
      controls.push(
        <label className="dt-header-control" key={header}>
          <select
            className={mappedRoles.length ? "mapped" : undefined}
            disabled={llmBusy}
            title={mappedRoles.map(([, label]) => label).join(" + ") || "未映射"}
            value={mappedRoles.length > 1 ? multipleValue : mappedRole ? mappedRole[0] : ""}
            onChange={(e) => {
              const role = e.target.value as keyof FaMapping;
              // 清除旧映射：先把该列从原角色移除（如果是多选且该角色值恰为此列）
              for (const [k] of roleOptions) {
                const v = mapping[k];
                if (Array.isArray(v) && v.includes(colValue)) {
                  setMapping(side, k, v.filter((x) => x !== colValue));
                } else if (String(v ?? "") === colValue) {
                  setMapping(side, k, "");
                }
              }
              // 设新映射
              if (role) {
                if (role === "matchKeys") {
                  const cur = side === "begin" ? beginKeys : endKeys;
                  if (!cur.includes(colValue)) {
                    setMapping(side, "matchKeys", [...cur, colValue]);
                  }
                } else {
                  setMapping(side, role, colValue);
                }
              }
            }}
          >
            <option value="">—</option>
            {mappedRoles.length > 1 && (
              <option value={multipleValue} disabled>
                {mappedRoles.map(([, label]) => label).join(" + ")}
              </option>
            )}
            {roleOptions.map(([key, label]) => {
              // 已被其他列占用的角色：标记"已用"，但当前列已选的除外
              const mappedHere = mappedRoles.some(([mappedKey]) => mappedKey === key);
              const takenByOther = usedRoles.has(key) && !mappedHere;
              return (
                <option key={key} value={key} className={takenByOther ? "dt-role-taken" : undefined}>
                  {label}
                  {takenByOther ? "（已用）" : ""}
                </option>
              );
            })}
          </select>
        </label>,
      );
    }
    return { controls, mappedFlags };
  };
  // 补充清单的列映射角色（addition/disposal 角色集不同）
  const supplementRoleOptions = (
    kind: "addition" | "disposal",
  ): { field: keyof FaSupplementConfig; label: string; multi?: boolean }[] => [
    { field: "keys", label: "组合匹配键", multi: true },
    { field: "method", label: kind === "addition" ? "新增方式" : "处置方式" },
    { field: "date", label: kind === "addition" ? "新增日期" : "处置日期" },
    ...(kind === "disposal"
      ? [
          { field: "originalValue" as const, label: "处置原值" },
          { field: "depreciation" as const, label: "处置折旧" },
        ]
      : []),
  ];
  // 补充清单每列顶部映射下拉，写回 FaSupplementConfig
  const supplementColumnControls = (
    kind: "addition" | "disposal",
    inspect: FaInspectSide,
    config: FaSupplementConfig,
    setter: React.Dispatch<React.SetStateAction<FaSupplementConfig>>,
  ): React.ReactNode[] => {
    const roles = supplementRoleOptions(kind);
    const controls: React.ReactNode[] = [];
    for (const header of inspect.headers) {
      const colValue = header.trim();
      const mappedRole = roles.find(({ field }) => {
        const v = config[field];
        if (Array.isArray(v)) return v.includes(colValue);
        return String(v ?? "") === colValue;
      });
      controls.push(
        <label className="dt-header-control" key={header}>
          <select
            className={mappedRole ? "mapped" : undefined}
            value={mappedRole ? String(mappedRole.field) : ""}
            onChange={(e) => {
              const field = e.target.value as keyof FaSupplementConfig;
              setter((current) => {
                const next: FaSupplementConfig = {
                  ...current,
                  keys: current.keys ? [...current.keys] : [],
                };
                // 清除旧映射（本列在其他角色的占用）
                for (const { field: f } of roles) {
                  const v = current[f];
                  if (Array.isArray(v) && v.includes(colValue)) {
                    next.keys = v.filter((x) => x !== colValue);
                  } else if (String(v ?? "") === colValue) {
                    (next as Record<string, unknown>)[f] = "";
                  }
                }
                if (field === "keys") {
                  if (!next.keys.includes(colValue)) next.keys = [...next.keys, colValue];
                } else if (field) {
                  (next as Record<string, unknown>)[field] = colValue;
                }
                return next;
              });
            }}
          >
            <option value="">—</option>
            {roles.map(({ field, label }) => (
              <option key={field} value={String(field)}>
                {label}
              </option>
            ))}
          </select>
        </label>,
      );
    }
    return controls;
  };
  const previewTable = (
    inspect: FaInspectSide,
    title: string,
    mapping?: FaMapping,
    side?: "begin" | "end",
    supplement?: { kind: "addition" | "disposal"; config: FaSupplementConfig; setter: React.Dispatch<React.SetStateAction<FaSupplementConfig>> },
  ) => {
    const hasControls = Boolean(mapping && side) || Boolean(supplement);
    let controls: React.ReactNode[] | undefined;
    if (mapping && side) {
      controls = columnMappingControls(side, inspect, mapping).controls;
    } else if (supplement) {
      controls = supplementColumnControls(supplement.kind, inspect, supplement.config, supplement.setter);
    }
    // 每个文件预览标题旁的"未映射"提示。分两档：
    // 必填缺失是红的、会拦住流程；选填缺失是黄的、只是告知，留空照样能合并。
    let missingHint: string | undefined;
    let optionalHint: string | undefined;
    if (mapping && side) {
      const m = missingRoles(side);
      if (m.length) missingHint = `尚未映射：${m.join("、")}`;
      const optional = missingOptionalRoles(side);
      if (optional.length) optionalHint = `选填未映射：${optional.join("、")}`;
    } else if (supplement) {
      const req = supplementRoleOptions(supplement.kind);
      const missing = req.filter(({ field }) => {
        const v = supplement.config[field];
        return Array.isArray(v) ? v.length === 0 : !String(v ?? "").trim();
      });
      if (missing.length) missingHint = `尚未映射：${missing.map((x) => x.label).join("、")}`;
    }
    return (
      <DataTable
        columns={inspect.headers}
        rows={inspect.preview}
        caption={
          <div className="fa-table-caption">
            <strong>
              {title} · {inspect.displayName ?? inspect.selectedSheet ?? "数据预览"} ·{" "}
              {inspect.dimensions?.rows ?? 0} 行 × {inspect.dimensions?.columns ?? 0} 列
            </strong>
            {missingHint && <span className="fa-caption-missing">{missingHint}</span>}
            {optionalHint && (
              <span
                className="fa-caption-optional"
                title="选填字段，留空不影响合并，只是对应的计算或分类不会生成。"
              >
                {optionalHint}
              </span>
            )}
          </div>
        }
        maxHeight={430}
        headerControls={controls}
      />
    );
  };
  const supplementEditor = (
    kind: "addition" | "disposal",
    config: FaSupplementConfig,
    info: FaSupplementInspect | undefined,
    setter: React.Dispatch<React.SetStateAction<FaSupplementConfig>>,
  ) => {
    const headers = info?.headers ?? [];
    const title = kind === "addition" ? "本期新增清单" : "本期处置清单";
    return (
      <div className="fa-side">
        <h3 className="fa-side-title">{title}</h3>
        <Field label={title}>
          <div ref={kind === "addition" ? additionDropRef : disposalDropRef}>
            <FileDropInput
              value={config.path}
              placeholder={title}
              onBrowse={() => void chooseSupplement(kind)}
              onClear={config.path && !busy && !supplementLlmBusy ? () => clearSupplement(kind) : undefined}
              onDragStateChange={(active) => setSupplementDragTarget(kind, active)}
              highlight={dragHover === kind}
              disabled={supplementLlmBusy}
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={
              !config.path ||
              busy ||
              supplementLlmBusy ||
              Boolean(info?.sheets.length && !config.sheet)
            }
            onClick={() => void inspectSupplement(kind)}
          >
            读取
          </Button>
        </Field>
        {info && (
          <div className="form-grid">
            {!!info.sheets.length && (
              <Field label="工作表（Sheet）">
                <select
                  disabled={busy || supplementLlmBusy}
                  value={config.sheet}
                  onChange={(e) => {
                    const next: FaSupplementConfig = {
                      ...config,
                      sheet: e.target.value,
                      headerRow: "",
                      keys: [],
                      matchKeysVerified: false,
                      method: "",
                      date: "",
                      originalValue: "",
                      depreciation: "",
                    };
                    supplementReviewGeneration.current += 1;
                    autoSupplementReviewKey.current = "";
                    setSupplementLlmBusy(false);
                    setter(next);
                    setSupplementLlmReview(undefined);
                    setSupplementLlmBypassed(false);
                    void inspectSupplement(kind, next);
                  }}
                >
                  <option value="" disabled>
                    请选择工作表
                  </option>
                  {info.sheets.map((sheet) => (
                    <option key={sheet} value={sheet}>
                      {sheet}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        )}
      </div>
    );
  };
  const renderFaResult = () => {
    if (!result || typeof result !== "object")
      return (
        <div className="empty">
          读取文件结构后，可核对组合键、字段映射和预览结果。
        </div>
      );
    const value = result as Record<string, unknown>;
    if (value.begin && value.end) {
      const begin = value.begin as FaInspectSide;
      const end = value.end as FaInspectSide;
      return (
        <div className="fa-result-summary">
          <strong>文件结构读取完成</strong>
          <span>
            期初：{begin.displayName ?? begin.selectedSheet}，标题在第{" "}
            {begin.detectedHeaderRow} 行，{begin.dimensions?.rows ?? 0} 条数据
          </span>
          <span>
            期末：{end.displayName ?? end.selectedSheet}，标题在第{" "}
            {end.detectedHeaderRow} 行，{end.dimensions?.rows ?? 0} 条数据
          </span>
          <span>请在左侧核对预览、组合匹配键和字段映射。</span>
        </div>
      );
    }
    if (value.stats && typeof value.stats === "object") {
      const stats = value.stats as {
        rows?: number;
        both?: number;
        beginOnly?: number;
        endOnly?: number;
        unmatchedAddition?: number;
        unmatchedDisposal?: number;
        duplicates?: {
          hasDuplicates?: boolean;
          duplicateValueCount?: number;
          duplicateRowCount?: number;
        };
      };
      const rows = Array.isArray(value.preview)
        ? (value.preview as Record<string, unknown>[])
        : [];
      const columns = Array.isArray(value.columns)
        ? (value.columns as string[])
        : [];
      return (
        <>
          <StatGrid
            items={[
              { label: "合并总行数", value: stats.rows ?? 0 },
              { label: "两期均有", value: stats.both ?? 0 },
              { label: "仅期初", value: stats.beginOnly ?? 0 },
              { label: "仅期末", value: stats.endOnly ?? 0 },
            ]}
            columns={4}
          />
          {/* The engine has always counted duplicate match keys; not showing
              them left users unaware that cards were paired by occurrence. */}
          {Boolean(stats.duplicates?.hasDuplicates) && (
            <div className="warning-box">
              匹配列存在重复值：{stats.duplicates?.duplicateValueCount ?? 0}{" "}
              个重复键、
              {stats.duplicates?.duplicateRowCount ?? 0}{" "}
              行；已按数据透视逻辑逐条配对，请确认匹配列是否唯一。
            </div>
          )}
          {(Number(stats.unmatchedAddition || 0) > 0 ||
            Number(stats.unmatchedDisposal || 0) > 0) && (
            <div className="warning-box">
              补充清单未匹配：新增 {stats.unmatchedAddition ?? 0} 条，处置{" "}
              {stats.unmatchedDisposal ?? 0} 条；导出时将另存未匹配清单。
            </div>
          )}
          {!!rows.length && (
            <details className="fa-preview" open>
              <summary>合并结果前 {rows.length} 行</summary>
              <div className="fa-preview-scroll">
                <table>
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {columns.map((column) => (
                          <td key={column} title={String(row[column] ?? "")}>
                            {String(row[column] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      );
    }
    if (Array.isArray(value.outputPaths)) {
      const message = String(value.exportMessage ?? value.message ?? "");
      const [mainMessage, warningText = ""] = message.split(
        "===CORRECTION_WARNINGS===",
      );
      const warnings = warningText
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      return (
        <div className="fa-result-summary">
          <strong>FA List 底稿已生成</strong>
          <span>{mainMessage.trim() || `共导出 ${value.rows ?? 0} 行。`}</span>
          {(value.outputPaths as string[]).map((path) => (
            <Button
              key={path}
              variant="default"
              onClick={() => void openOutput(path)}
            >
              打开结果：{path}
            </Button>
          ))}
          {warnings.map((warning) => (
            <div className="warning-box" key={warning}>
              {warning}
            </div>
          ))}
        </div>
      );
    }
    return <ResultView value={result} />;
  };
  const showPreviewWorkspace = shouldShowFaPreviewWorkspace(
    step,
    Boolean(faStats),
  );
  const supplementsReadyForReview = Boolean(
    addition.path &&
    disposal.path &&
    additionInspect &&
    disposalInspect &&
    (!additionInspect.sheets.length ||
      (addition.sheet && additionInspect.selectedSheet === addition.sheet)) &&
    (!disposalInspect.sheets.length ||
      (disposal.sheet && disposalInspect.selectedSheet === disposal.sheet)),
  );
  return (
    <>
      <PageHeader
        eyebrow="固定资产清单匹配"
        title={tool.name}
        detail="按期初、期末两份固定资产表按组合键匹配，生成 FA List、变动与汇总底稿。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "文件与匹配" },
          { key: "2", label: "补充清单", disabled: !faStats },
          { key: "3", label: "导出", disabled: !faStats },
        ]}
        current={step - 1}
        onStepClick={(index) => setStep((index + 1) as 1 | 2 | 3)}
      />
      <div className="fa-stack">
        <Card>
          <CardHeader>
            <CardTitle>
              {step === 1
                ? "1. 选择文件并配置"
                : step === 2
                  ? "2. 补充清单映射（可选）"
                  : "3. 保存并导出"}
            </CardTitle>
            <Badge className="badge-ready">已就绪</Badge>
          </CardHeader>
          <CardContent>
          <ErrorBox error={error} onDismiss={() => setError("")} />
          {/* The result pane only exists on step 3, so a merge started from
              step 1 used to run with no visible progress at all. */}
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
          {step === 1 && (
            <>
              <div className="fa-sides">
                <div className="fa-side fa-side-begin">
                  <h3 className="fa-side-title">期初（年初）</h3>
                  <Field label="年初文件" required>
                    <div ref={beginDropRef}>
                      <FileDropInput
                        value={beginPath}
                        placeholder="拖放或点击选择年初清单"
                        onBrowse={() => void choose("begin")}
                        onClear={beginPath && !busy ? () => clearMainFile("begin") : undefined}
                        onDragStateChange={(active) => setDragTarget("begin", active)}
                        highlight={dragHover === "begin"}
                        disabled={busy}
                      />
                    </div>
                  </Field>
                  <Field label="Sheet">
                    {inspection?.begin.sheets.length ? (
                      <select
                        value={beginSheet}
                        onChange={(e) => {
                          setBeginSheet(e.target.value);
                          setBeginHeaderRow("");
                        }}
                      >
                        {inspection.begin.sheets.map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={beginSheet}
                        onChange={(e) => {
                          setBeginSheet(e.target.value);
                          setBeginHeaderRow("");
                        }}
                      />
                    )}
                  </Field>
                  <Field label="标题行（留空自动识别）">
                    <input
                      value={beginHeaderRow}
                      placeholder="自动"
                      onChange={(e) => setBeginHeaderRow(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="fa-side fa-side-end">
                  <h3 className="fa-side-title">期末（年末）</h3>
                  <Field label="年末文件" required>
                    <div ref={endDropRef}>
                      <FileDropInput
                        value={endPath}
                        placeholder="拖放或点击选择年末清单"
                        onBrowse={() => void choose("end")}
                        onClear={endPath && !busy ? () => clearMainFile("end") : undefined}
                        onDragStateChange={(active) => setDragTarget("end", active)}
                        highlight={dragHover === "end"}
                        disabled={busy}
                      />
                    </div>
                  </Field>
                  <Field label="Sheet">
                    {inspection?.end.sheets.length ? (
                      <select
                        value={endSheet}
                        onChange={(e) => {
                          setEndSheet(e.target.value);
                          setEndHeaderRow("");
                        }}
                      >
                        {inspection.end.sheets.map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={endSheet}
                        onChange={(e) => {
                          setEndSheet(e.target.value);
                          setEndHeaderRow("");
                        }}
                      />
                    )}
                  </Field>
                  <Field label="标题行（留空自动识别）">
                    <input
                      value={endHeaderRow}
                      placeholder="自动"
                      onChange={(e) => setEndHeaderRow(e.target.value)}
                    />
                  </Field>
                </div>
              </div>
              <div className="actions fa-flow-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void inspect()}
                >
                  {busy ? "正在读取表格…" : "读取表格 + LLM 复核"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!inspection || busy || llmBusy}
                  onClick={() => void reviewLlm()}
                >
                  {llmBusy ? "LLM 正在复核…" : "LLM 重新复核"}
                </Button>
                {busy && job ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void jobCancel(job.jobId)}
                  >
                    停止
                  </Button>
                ) : !faStats ? (
                  <Button
                    variant="default"
                    disabled={
                      isFaMatchDisabled(Boolean(inspection), busy) ||
                      missingRoles("begin").length > 0 ||
                      missingRoles("end").length > 0
                    }
                    onClick={() => void start("fa.match")}
                  >
                    下一步
                  </Button>
                ) : (
                  <>
                    <Button variant="secondary" size="sm" onClick={() => setStep(2)}>
                      有，进入补充清单
                    </Button>
                    <Button variant="default" onClick={() => setStep(3)}>
                      没有，直接导出
                    </Button>
                  </>
                )}
              </div>
              {inspection && (
                <>
                  {(llmBusy || llmReview) && (
                    <div
                      className={`fa-llm-review ${
                        llmReview?.passed === false ? "warning" : ""
                      }`}
                    >
                      <div className="section-title">
                        <h3>LLM 映射复核</h3>
                        <span
                          className={`pill ${
                            llmBusy
                              ? "preview"
                              : llmReview?.passed === false
                                ? "warning"
                                : llmReview?.enabled
                                  ? "ready"
                                  : ""
                          }`}
                        >
                          {llmBusy
                            ? "复核中"
                            : llmReview?.failed
                              ? "失败（不阻塞）"
                              : llmReview?.passed === false
                                ? "需人工复核"
                                : llmReview?.enabled
                                  ? "已完成"
                                  : "未启用"}
                        </span>
                      </div>
                    {llmBusy && (
                      <p>复核期间匹配键与字段映射已暂时锁定。</p>
                    )}
                      {llmReview?.detail ? (
                        <details className="fa-llm-detail">
                          <summary>技术详情（排查用）</summary>
                          <p>{llmReview.detail}</p>
                        </details>
                      ) : null}
                      {llmReview && !llmBusy ? (
                        <div className="fa-review-conclusion" role="status">
                          <strong>复核结论</strong>
                          <p>
                            {faReviewNarrative(
                              llmReview.message,
                              llmChanges.length,
                              llmPending.length,
                            )}
                          </p>
                          {llmChanges.length === 0 &&
                            llmPending.length === 0 &&
                            faReviewReasons(
                              llmReview.autoApplied,
                              llmReview.fieldReviews,
                              llmReview.matchReview?.reasons,
                            ).length > 0 && (
                            <ul>
                              {faReviewReasons(
                                llmReview.autoApplied,
                                llmReview.fieldReviews,
                                llmReview.matchReview?.reasons,
                              ).map((reason) => <li key={reason}>{reason}</li>)}
                            </ul>
                          )}
                        </div>
                      ) : null}
                      {(llmBusy || llmReview?.failed) && (
                        <div className="actions compact">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              llmReviewGeneration.current += 1;
                              setLlmBusy(false);
                              setLlmBypassed(true);
                              setLlmReview((current) => ({
                                enabled: true,
                                passed: true,
                                message:
                                  "已按用户选择跳过本次 LLM 复核，保留当前字段和匹配 ID。",
                                autoApplied: current?.autoApplied ?? [],
                                fieldReviews: current?.fieldReviews ?? [],
                                matchReview: current?.matchReview,
                              }));
                            }}
                          >
                            {llmBusy ? "停止并继续主流程" : "关闭失败提示"}
                          </Button>
                        </div>
                      )}
                      {llmChanges.map((change) => (
                        <div
                          className={`fa-review-item fa-change${change.attention ? " attention" : ""}`}
                          key={change.id}
                        >
                          <strong>{change.label}</strong>
                          <span className="fa-change-diff">
                            {change.before} → {change.after}
                          </span>
                          {!!change.reason && (
                            <span>
                              {change.reason}
                              {change.confidence
                                ? `（把握 ${Math.round(change.confidence * 100)}%）`
                                : ""}
                            </span>
                          )}
                          <div className="actions compact">
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={llmBusy}
                              onClick={() => undoLlmChange(change)}
                            >
                              撤销
                            </Button>
                          </div>
                        </div>
                      ))}
                      {llmPending.map((item) => (
                        <div
                          className="fa-review-item fa-pending"
                          key={item.id}
                        >
                          <strong>
                            {item.label}
                            <em>把握不足，未改动</em>
                          </strong>
                          <span className="fa-change-diff">
                            {item.current} → {item.suggested}
                          </span>
                          {!!item.reason && (
                            <span>
                              {item.reason}
                              {item.confidence
                                ? `（把握 ${Math.round(item.confidence * 100)}%）`
                                : ""}
                            </span>
                          )}
                          <div className="actions compact">
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={llmBusy}
                              onClick={() => acceptLlmPending(item)}
                            >
                              采纳
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={llmBusy}
                              onClick={() =>
                                setLlmPending((current) =>
                                  current.filter(
                                    (value) => value.id !== item.id,
                                  ),
                                )
                              }
                            >
                              保留当前
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {faStats && (
                <div className="fa-next-choice">
                  <strong>
                    合并完成：共 {faStats.rows ?? 0} 行，期初期末均有{" "}
                    {faStats.both ?? 0} 行。
                  </strong>
                  <span>是否有新增清单或处置清单需要补充映射？</span>
                </div>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <h3>3. 本期变动清单</h3>
              {supplementLlmBusy && (
                <p className="hint">
                  补充清单 LLM
                  复核进行中，匹配键与字段映射已暂时锁定；复核结束或点下方"停止并继续主流程"后即可调整。
                </p>
              )}
              <div className="fa-sides">
                {supplementEditor(
                  "addition",
                  addition,
                  additionInspect,
                  setAddition,
                )}
                {supplementEditor(
                  "disposal",
                  disposal,
                  disposalInspect,
                  setDisposal,
                )}
              </div>
              {(addition.path || disposal.path) && (
                <div className="actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={supplementLlmBusy || !supplementsReadyForReview}
                    onClick={() => void reviewSupplements()}
                  >
                    {supplementLlmBusy
                      ? "补充清单 LLM 复核中…"
                      : "重新复核补充清单"}
                  </Button>
                </div>
              )}
              {(addition.path || disposal.path) &&
                !supplementsReadyForReview && (
                  <p className="hint">
                    请先分别选择新增清单、处置清单及其工作表；两张表都读取完成后，系统才会统一进行一次
                    LLM 复核。
                  </p>
                )}
              <div className="actions">
                <Button variant="secondary" size="sm" onClick={() => setStep(1)}>
                  返回上一步
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    supplementReviewGeneration.current += 1;
                    setSupplementLlmBusy(false);
                    setAddition(emptyFaSupplement());
                    setDisposal(emptyFaSupplement());
                    setAdditionInspect(undefined);
                    setDisposalInspect(undefined);
                    setSupplementLlmReview(undefined);
                    setSupplementLlmBypassed(false);
                    setSupplementAutoHandled(true);
                    setError("");
                    setStep(3);
                  }}
                >
                  无补充清单，跳过
                </Button>
                <Button
                  variant="default"
                  disabled={
                    supplementLlmBusy ||
                    !canApplyFaSupplements(
                      addition.path,
                      disposal.path,
                      endMapping.additionMethod,
                    )
                  }
                  onClick={() => setStep(3)}
                >
                  应用补充映射并继续
                </Button>
              </div>
              {(supplementLlmBusy || supplementLlmReview) && (
                <div
                  className={`fa-llm-review ${
                    supplementLlmReview?.passed === false ? "warning" : ""
                  }`}
                >
                  <div className="section-title">
                    <h3>LLM 复核</h3>
                    <span
                      className={`pill ${supplementLlmBusy ? "preview" : "ready"}`}
                    >
                      {supplementLlmBusy
                        ? "复核中"
                        : supplementLlmReview?.enabled
                          ? "已完成"
                          : "未启用"}
                    </span>
                  </div>
                  {supplementLlmBusy && (
                    <p>
                      正在核对补充清单字段和第一步匹配 ID 口径。
                    </p>
                  )}
                  {supplementLlmReview && !supplementLlmBusy ? (
                    <div className="fa-review-conclusion" role="status">
                      <strong>复核结论</strong>
                      <p>
                        {faReviewNarrative(
                          supplementLlmReview.message,
                          supplementLlmChanges.length,
                          supplementLlmPending.length,
                        )}
                      </p>
                      {supplementLlmChanges.length === 0 &&
                        supplementLlmPending.length === 0 &&
                        faReviewReasons(
                          supplementLlmReview.autoApplied,
                          supplementLlmReview.fieldReviews,
                          supplementLlmReview.matchReview?.reasons,
                        ).length > 0 && (
                        <ul>
                          {faReviewReasons(
                            supplementLlmReview.autoApplied,
                            supplementLlmReview.fieldReviews,
                            supplementLlmReview.matchReview?.reasons,
                          ).map((reason) => <li key={reason}>{reason}</li>)}
                        </ul>
                      )}
                    </div>
                  ) : null}
                  {supplementLlmChanges.map((change) => (
                    <div
                      className={`fa-review-item fa-change${change.attention ? " attention" : ""}`}
                      key={change.id}
                    >
                      <strong>{change.label}</strong>
                      <span className="fa-change-diff">
                        {change.before} → {change.after}
                      </span>
                      {!!change.reason && (
                        <span>
                          {change.reason}
                          {change.confidence
                            ? `（把握 ${Math.round(change.confidence * 100)}%）`
                            : ""}
                        </span>
                      )}
                      <div className="actions compact">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => undoSupplementLlmChange(change)}
                        >
                          撤销
                        </Button>
                      </div>
                    </div>
                  ))}
                  {supplementLlmPending.map((item) => (
                    <div className="fa-review-item fa-pending" key={item.id}>
                      <strong>
                        {item.label}
                        <em>把握不足，未改动</em>
                      </strong>
                      <span className="fa-change-diff">
                        {item.current} → {item.suggested}
                      </span>
                      {!!item.reason && (
                        <span>
                          {item.reason}
                          {item.confidence
                            ? `（把握 ${Math.round(item.confidence * 100)}%）`
                            : ""}
                        </span>
                      )}
                      <div className="actions compact">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => acceptSupplementLlmPending(item)}
                        >
                          采纳
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setSupplementLlmPending((current) =>
                              current.filter((value) => value.id !== item.id),
                            )
                          }
                        >
                          保留当前
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {step === 3 && (
            <>
              <h3>4. 输出</h3>
              <div className="form-grid">
                <Field label="期初显示名称">
                  <input
                    value={beginDisplayName}
                    onChange={(e) => setBeginDisplayName(e.target.value)}
                  />
                </Field>
                <Field label="期末显示名称">
                  <input
                    value={endDisplayName}
                    onChange={(e) => setEndDisplayName(e.target.value)}
                  />
                </Field>
                <Field label="资产负债表日">
                  <input
                    type="date"
                    value={balanceSheetDate}
                    onChange={(e) => setBalanceSheetDate(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="输出文件">
                <FileInput
                  value={outputPath}
                  placeholder="选择期末文件后自动填入默认保存位置"
                  onBrowse={() => void chooseOutput()}
                  onClear={outputPathTouched ? resetOutputPath : undefined}
                  browseLabel="选择"
                  clearLabel="恢复默认"
                />
              </Field>
              <p className="hint">
                {outputPathTouched
                  ? "已指定保存位置，导出会写入上面这个文件。"
                  : "默认保存到期末文件所在目录，文件名为 FA_List_<日期>_<时间>.xlsx（导出时按当前时间生成）。"}
              </p>
              <div className="actions">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setStep(2)}
                >
                  返回上一步
                </Button>
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
                    disabled={!inspection}
                    onClick={() => void start("fa.export")}
                  >
                    生成 FA List 底稿
                  </Button>
                )}
              </div>
            </>
          )}
          </CardContent>
        </Card>
        {showPreviewWorkspace ? (
          <aside className="fa-preview-workspace" aria-label="文件预览工作区">
            <div className="fa-preview-workspace-title">
              <div>
                <h2>文件预览</h2>
                <p>预览区已锁定；各文件可独立纵向、横向滚动。</p>
                {step === 1 && inspection && (
                  (() => {
                    const beginMissing = missingRoles("begin");
                    const endMissing = missingRoles("end");
                    const allMissing = [...new Set([...beginMissing, ...endMissing])];
                    if (!allMissing.length) return null;
                    return (
                      <p className="fa-missing-hint">
                        尚未映射：{allMissing.join("、")}（请在各列顶部的下拉框中选择对应字段）
                      </p>
                    );
                  })()
                )}
              </div>
              <Badge className="badge-preview">
                {step === 1 ? "导入文件" : "补充清单"}
              </Badge>
            </div>
            <div className="fa-preview-stack">
              {step === 1 && inspection ? (
                <>
                  {previewTable(inspection.begin, "期初文件预览", beginMapping, "begin")}
                  {previewTable(inspection.end, "期末文件预览", endMapping, "end")}
                </>
              ) : step === 1 ? (
                <>
                  <section className="fa-preview fa-preview-empty-card">
                    <header>期初文件预览</header>
                    <div className="empty">
                      选择期初文件并读取结构后，在此显示表格内容。
                    </div>
                  </section>
                  <section className="fa-preview fa-preview-empty-card">
                    <header>期末文件预览</header>
                    <div className="empty">
                      选择期末文件并读取结构后，在此显示表格内容。
                    </div>
                  </section>
                </>
              ) : (
                <>
                  {additionInspect &&
                  (!additionInspect.sheets.length || addition.sheet) ? (
                    previewTable(additionInspect, "新增清单预览", undefined, undefined, {
                      kind: "addition",
                      config: addition,
                      setter: setAddition,
                    })
                  ) : (
                    <section className="fa-preview fa-preview-empty-card">
                      <header>新增清单预览</header>
                      <div className="empty">
                        选择新增清单及工作表后，在此显示表格内容。
                      </div>
                    </section>
                  )}
                  {disposalInspect &&
                  (!disposalInspect.sheets.length || disposal.sheet) ? (
                    previewTable(disposalInspect, "处置清单预览", undefined, undefined, {
                      kind: "disposal",
                      config: disposal,
                      setter: setDisposal,
                    })
                  ) : (
                    <section className="fa-preview fa-preview-empty-card">
                      <header>处置清单预览</header>
                      <div className="empty">
                        选择处置清单及工作表后，在此显示表格内容。
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
          </aside>
        ) : (
          <Card className="fa-result-workspace">
            <CardHeader>
              <CardTitle>匹配与导出结果</CardTitle>
            </CardHeader>
            <CardContent>
              {job && (
                <JobProgress
                  job={job}
                  onCancel={(jobId) => {
                    void jobCancel(jobId);
                    setBusy(false);
                  }}
                  cancelLabel="取消任务"
                />
              )}
              {renderFaResult()}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
