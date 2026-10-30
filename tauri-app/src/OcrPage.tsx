import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileScan,
  FolderOpen,
  ScanText,
  Download,
  Plus,
  Trash2,
  RotateCcw,
  UploadCloud,
} from "lucide-react";
import { jobCancel, jobPause, openOutput, pickPath } from "./api";
import { ocrCall, runOcrJob } from "./ocrApi";
import { openOcrExtractionCache, type OcrExtractionDiagnostic } from "./ocrExtractionResume";
import { OcrOperation, runOcrPool, OCR_CONCURRENCY } from "./ocrBatch";
import {
  useOcrScanProgressDialog,
  registerOcrScanJob,
  registerOcrOperationJob,
  type OcrScanProgress,
  type OcrTaskProgress,
  type OcrScanPageState,
} from "./ocrProgress";
import {
  OcrTimingPanel,
  type OcrPageTiming,
  type OcrTimingRun,
} from "./OcrTimingPanel";
import {
  extractOcrScenario,
  getOcrPromptStages,
  loadOcrScenarios,
  withSavedOcrScenarios,
  type OcrScenario,
} from "./ocrScenarios";
import { openOcrSource, type OcrSource, type OcrRotation } from "./ocrSource";
import { parseOcrScanRange } from "./ocrScanRange";
import type {
  OcrConfigStatus,
  OcrCustomScenario,
  OcrDocument,
  OcrDocumentDetail,
  OcrExtraction,
  OcrRecognitionResult,
  OcrProject,
  OcrPromptStage,
} from "./ocrTypes";
import type { ToolManifest } from "./types";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { useNativeFileDropZone } from "@/hooks/useNativeFileDropZone";
import { markToolPageLive } from "./toolPageActivity";
import { StepIndicator } from "@/components/StepIndicator";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { confirmDialog } from "@/components/ConfirmDialog";
import { errorText } from "@/lib/errors";
import { OcrReadingView } from "./OcrReadingView";
import "./ocr.css";

type Operation = OcrOperation;
const statusLabels: Record<string, string> = {
  pending: "待识别",
  imported: "待识别",
  processing: "识别中",
  completed: "已完成",
  needs_review: "待校对",
  partial: "部分完成",
  failed: "识别失败",
};

export default function OcrPage({ tool }: { tool?: ToolManifest }) {
  const [projects, setProjects] = useState<OcrProject[]>([]);
  const [project, setProject] = useState<OcrProject>();
  const [projectName, setProjectName] = useState("");
  const [documents, setDocuments] = useState<OcrDocument[]>([]);
  const [detail, setDetail] = useState<OcrDocumentDetail>();
  const [pageNumber, setPageNumber] = useState(1);
  const [sourceImage, setSourceImage] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [scenarios, setScenarios] = useState<OcrScenario[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [promptSaveDialogOpen, setPromptSaveDialogOpen] = useState(false);
  const [savedScenarioName, setSavedScenarioName] = useState("");
  const [pendingExtractionExport, setPendingExtractionExport] = useState<{
    documentIds: string[];
    extractionIds: string[];
  }>();
  const [extractionFailures, setExtractionFailures] = useState<string[]>([]);
  const [extractionStats, setExtractionStats] = useState<OcrExtractionDiagnostic[]>([]);
  const [stages, setStages] = useState<OcrPromptStage[]>([]);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!documents.length) setStep(0);
  }, [documents.length]);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportMode, setExportMode] = useState<
    "single_sheet" | "per_document" | "individual"
  >("per_document");
  const selectedDocuments = documents.filter((document) =>
    selectedDocumentIds.includes(document.id),
  );
  const exportDocuments = selectedDocuments;
  const [detailCache, setDetailCache] = useState<
    Record<string, OcrDocumentDetail>
  >({});
  const [scanScope, setScanScope] = useState("all");
  const [scanPages, setScanPages] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const [exportDirectory, setExportDirectory] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const currentRotation: OcrRotation =
    detail?.pages.find((page) => page.page === pageNumber)?.metadata
      ?.autoRotation ?? 0;
  const documentPages = [...(detail?.pages ?? [])].sort(
    (a, b) => a.page - b.page,
  );
  const scopeDetails = selectedDocuments.map((document) => {
    const value =
      detail?.document.id === document.id ? detail : detailCache[document.id];
    return value
      ? {
          ...value,
          pages:
            detail?.document.id === document.id ? documentPages : value.pages,
        }
      : { document, pages: [], extractions: [] };
  });
  const hasResults = scopeDetails.some((value) => value.pages.length > 0);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"scan" | "other">("other");
  const [error, setError] = useState("");
  const [outputs, setOutputs] = useState<string[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [scanRuns, setScanRuns] = useState<Record<string, OcrTimingRun>>({});
  const [failedScanPages, setFailedScanPages] = useState<Record<string, number[]>>({});
  const selectedRuns = selectedDocumentIds.flatMap(id => scanRuns[id] ? [scanRuns[id]] : []);
  const latestScanStart = Math.max(...selectedRuns.map(value => value.started));
  const latestRuns = selectedRuns.filter(value => value.started === latestScanStart);
  const timingRun: OcrTimingRun | undefined = latestRuns.length ? {
    started: latestScanStart,
    ended: latestRuns.every(value => value.ended !== undefined)
      ? Math.max(...latestRuns.map(value => value.ended!)) : undefined,
    pages: latestRuns.flatMap(value => value.pages),
  } : undefined;
  const retryFailedCount = selectedDocumentIds.reduce((sum, id) => sum + (failedScanPages[id]?.length ?? 0), 0);
  const [controlling, setControlling] = useState(false);
  const [scanView, setScanView] =
    useState<
      Pick<
        OcrScanProgress,
        "fileName" | "fileIndex" | "fileCount" | "phase" | "pages"
      >
    >();
  const [scanControlError, setScanControlError] = useState("");
  const [taskView, setTaskView] =
    useState<
      Omit<
        OcrTaskProgress,
        "paused" | "stopping" | "controlling" | "error" | "onPause" | "onCancel"
      >
    >();
  const scanDialog = useOcrScanProgressDialog();
  const scanControls = useRef({ pause: () => {}, cancel: () => {} });
  const deferScanPage = useRef<(page: number) => Promise<void>>(async () => {});
  const controllingRef = useRef(false);
  const projectRef = useRef<string | undefined>(undefined);
  const documentRef = useRef<string | undefined>(undefined);
  const operation = useRef<Operation | undefined>(undefined);
  const promptDirty = useRef(false);
  const promptSnapshot = useRef<{
    project?: OcrProject;
    scenarioId: string;
    stages: OcrPromptStage[];
  }>({ scenarioId: "", stages: [] });
  const promptSavePending = useRef<Promise<unknown>>(Promise.resolve());
  const busyRef = useRef(false);
  const loadSequence = useRef(0);
  const mounted = useRef(true);
  const uploadRef = useRef<HTMLDivElement>(null);
  const availableScenarios = withSavedOcrScenarios(
    scenarios,
    project?.customScenarios,
  );
  const scenario = availableScenarios.find((item) => item.id === scenarioId);
  promptSnapshot.current = { project, scenarioId, stages };

  const run = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessageKind("other");
    setMessage("");
    setScanView(undefined);
    setTaskView(undefined);
    setScanControlError("");
    try {
      await action();
    } catch (reason) {
      if (mounted.current) setError(errorText(reason));
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        setPaused(false);
      }
      operation.current = undefined;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void Promise.all([
      ocrCall<{ projects: OcrProject[] }>("ocr.projects", {}),
      loadOcrScenarios(),
    ])
      .then(([saved, available]) => {
        if (!mounted.current) return;
        setProjects(saved.projects);
        setScenarios(available);
        if (saved.projects[0]) {
          projectRef.current = saved.projects[0].id;
          setProject(saved.projects[0]);
        }
      })
      .catch((reason) => {
        if (mounted.current) setError(errorText(reason));
      });
    return () => {
      mounted.current = false;
      const active = operation.current;
      if (active) {
        active.cancelled = true;
        active.wake?.();
        for (const id of active.jobIds) void jobCancel(id).catch(() => {});
      }
    };
  }, []);

  const refreshDocuments = useCallback(async (projectId: string) => {
    const result = await ocrCall<{ documents: OcrDocument[] }>(
      "ocr.documents",
      { projectId },
    );
    if (projectRef.current === projectId && mounted.current)
      setDocuments(result.documents);
    return result.documents;
  }, []);
  useEffect(() => {
    if (!project) return;
    setScanRuns({});
    setFailedScanPages({});
    setMessage("");
    setError("");
    setFilesExpanded(false);
    setDocuments([]);
    setDetailCache({});
    setDetail(undefined);
    documentRef.current = undefined;
    setSourceImage("");
    setOutputs([]);
    setStep(0);
    setScenarioId("");
    void refreshDocuments(project.id).catch((reason) =>
      setError(errorText(reason)),
    );
  }, [project?.id, refreshDocuments]);

  useEffect(
    () => () => {
      const snapshot = promptSnapshot.current;
      if (promptDirty.current && snapshot.project && snapshot.scenarioId) {
        const params = {
          id: snapshot.project.id,
          name: snapshot.project.name,
          prompts: {
            ...snapshot.project.prompts,
            [snapshot.scenarioId]: snapshot.stages,
          },
        };
        promptSavePending.current = promptSavePending.current
          .catch(() => {})
          .then(() => ocrCall("ocr.project_save", params));
        void promptSavePending.current.catch(() => {});
      }
    },
    [],
  );

  async function loadDocument(id: string, page = 1) {
    const sequence = ++loadSequence.current;
    const changed = documentRef.current !== id;
    if (changed) {
      setCopyNotice("");
    }
    documentRef.current = id;
    if (changed) {
      setDetail(undefined);
    }
    setPageNumber(page);
    const result = await ocrCall<OcrDocumentDetail>("ocr.document", {
      documentId: id,
    });
    if (
      sequence !== loadSequence.current ||
      documentRef.current !== id ||
      !mounted.current
    )
      return;
    setDetailCache((values) => ({ ...values, [id]: result }));
    setDetail(result);
  }
  async function selectPage(number: number) {
    setPageNumber(number);
  }
  async function changeStep(next: number) {
    await savePromptEdits();
    setStep(next);
  }

  useEffect(() => {
    if (!detail?.document) {
      setSourceImage("");
      return;
    }
    let active = true;
    let source: OcrSource | undefined;
    setSourceImage("");
    setSourceError("");
    void openOcrSource(detail.document)
      .then(async (opened) => {
        source = opened;
        const documentId = detail.document.id;
        if (!active || documentRef.current !== documentId) return;
        const image = await opened.render(pageNumber, currentRotation);
        if (!active || documentRef.current !== documentId) return;
        setSourceImage(image);
        // Import cannot count PDF/TIFF pages without opening the source. Persist
        // that count during preview so every page is available before paid OCR.
        if (detail.document.totalPages === 0 && opened.totalPages > 0) {
          const prepared = await ocrCall<OcrDocument>("ocr.document_prepare", {
            documentId,
            totalPages: opened.totalPages,
          });
          if (!active || documentRef.current !== documentId || !mounted.current)
            return;
          setDetail((current) =>
            current?.document.id === documentId
              ? {
                  ...current,
                  document: {
                    ...current.document,
                    totalPages: prepared.totalPages,
                  },
                }
              : current,
          );
          setDocuments((current) =>
            current.map((item) =>
              item.id === documentId
                ? { ...item, totalPages: prepared.totalPages }
                : item,
            ),
          );
        }
      })
      .catch((reason) => {
        if (active) setSourceError(errorText(reason));
      })
      .finally(() => {
        source?.dispose();
      });
    return () => {
      active = false;
    };
  }, [detail?.document.id, pageNumber, currentRotation]);

  async function importPaths(paths: string[], folder?: string) {
    const projectId = projectRef.current;
    if (!projectId) return;

    setMessage("正在导入文件…");
    const result = await ocrCall<{
      documents: OcrDocument[];
      failed: { name: string; message: string }[];
    }>("ocr.document_import", { projectId, paths, folder });
    await refreshDocuments(projectId);
    setMessage(
      `已导入 ${result.documents.length} 份文件。识别后即可导出 Excel。`,
    );
    if (result.failed.length)
      setError(
        result.failed.map((item) => `${item.name}：${item.message}`).join("\n"),
      );
    if (result.documents[0] && projectRef.current === projectId) {
      setSelectedDocumentIds(result.documents.map((item) => item.id));
      await loadDocument(result.documents[0].id);
    }
  }
  const uploadDrop = useNativeFileDropZone({
    containerRef: uploadRef,
    enabled: !!project && !busy,
    onDrop: (paths) => {
      markToolPageLive(tool?.id ?? "ocr");
      return run(() => importPaths(paths));
    },
    onError: (reason) => setError(errorText(reason)),
  });

  async function chooseImport(folder: boolean) {
    const paths = await pickPath(
      folder ? "folder" : "files",
      folder ? "选择扫描件文件夹（包含子文件夹）" : "选择 PDF 或扫描图片",
      ["pdf", "png", "jpg", "jpeg", "bmp", "tif", "tiff"],
    );
    if (paths)
      await importPaths(
        folder ? [] : Array.isArray(paths) ? paths : [paths],
        folder ? String(paths) : undefined,
      );
  }
  async function checkpoint(active: Operation) {
    await active.checkpoint();
  }
  function attachJob(active: Operation, id: string) {
    active.jobIds.add(id);
    if (active.cancelled)
      void jobCancel(id).catch((reason) => setError(errorText(reason)));
    else if (active.paused)
      void jobPause(id, true).catch((reason) => setError(errorText(reason)));
  }
  async function recognize(retryFailedOnly = false) {
    if (!selectedDocuments.length) return;
    // Validate syntax without enumerating unbounded user-supplied ranges.
    if (!retryFailedOnly && scanScope === "custom")
      parseOcrScanRange(
        scanPages,
        selectedDocuments.length === 1
          ? Math.max(1, selectedDocuments[0].totalPages)
          : 1,
        selectedDocuments.length > 1 || selectedDocuments[0].totalPages === 0,
      );

    setOutputs([]);
    setExportDirectory("");
    setCopyNotice("");
    const status = await ocrCall<OcrConfigStatus>("ocr.config_status", {});
    if (!status.ocr.ready)
      throw new Error("请先在设置中配置 OCR 服务；AI 识别使用统一 LLM 配置。");
    const retryPages = structuredClone(failedScanPages);
    const targets = selectedDocuments.filter(target => !retryFailedOnly || retryPages[target.id]?.length);
    if (!targets.length) return;
    if (!retryFailedOnly && scanScope === "custom") {
      const savedTargets = await Promise.all(
        targets.map((target) =>
          ocrCall<OcrDocumentDetail>("ocr.document", { documentId: target.id }),
        ),
      );
      const overwrites = savedTargets.some((value) =>
        value.pages.some((page) =>
          parseOcrScanRange(
            scanPages,
            Math.max(1, value.document.totalPages),
            true,
          ).includes(page.page),
        ),
      );
      if (
        overwrites &&
        !(await confirmDialog({
          title: "重新扫描所选页面？",
          message:
            "将替换所选文件范围内已有页面的识别正文及表格校对内容，并重新调用 OCR 服务。原扫描文件不受影响。",
          confirmLabel: "开始扫描",
        }))
      )
        return;
    }
    const active = new OcrOperation();
    setMessageKind("scan");
    operation.current = active;
    setProgress({ current: 0, total: 0 });
    setScanView({
      fileName: targets[0].name,
      fileIndex: 1,
      fileCount: targets.length,
      phase: "preparing",
      pages: [],
    });
    const started = performance.now();
    setScanRuns(values => ({ ...values, ...Object.fromEntries(targets.map(target => [target.id, { started, pages: [] }])) }));
    const failed: string[] = [];
    const skipped: string[] = [];
    let fileIndex = 0;
    try {
      for (const target of targets) {
        fileIndex++;
        await checkpoint(active);
        setScanView({
          fileName: target.name,
          fileIndex,
          fileCount: targets.length,
          phase: "preparing",
          pages: [],
        });
        setProgress({ current: 0, total: 0 });
        let source: OcrSource | undefined;
        try {
          source = await openOcrSource(target);
          await ocrCall("ocr.document_prepare", {
            documentId: target.id,
            totalPages: source.totalPages,
          });
          const saved = await ocrCall<OcrDocumentDetail>("ocr.document", {
            documentId: target.id,
          });
          const requested = retryFailedOnly
            ? (retryPages[target.id] ?? []).filter(page => page >= 1 && page <= source!.totalPages)
            : scanScope === "custom"
              ? parseOcrScanRange(
                  scanPages,
                  source.totalPages,
                  targets.length > 1,
                )
              : Array.from(
                  { length: source.totalPages },
                  (_, index) => index + 1,
                );
          const numbers =
            retryFailedOnly || scanScope === "custom"
              ? requested
              : requested.filter(
                  (number) => !saved.pages.some((item) => item.page === number),
                );
          if (!retryFailedOnly && scanScope === "custom" && targets.length > 1) {
            if (
              (scanPages.match(/\d+/g) ?? []).some(
                (number) => Number(number) > source!.totalPages,
              ) ||
              !requested.length
            )
              skipped.push(
                `${target.name}：仅扫描本文件存在的页码（共 ${source.totalPages} 页）。`,
              );
          }
          setProgress({ current: 0, total: numbers.length });
          setScanView({
            fileName: target.name,
            fileIndex,
            fileCount: targets.length,
            phase: "scanning",
            pages: [],
          });
          const updatePageState = (page: number, state: OcrScanPageState, message?: string, cancellable?: boolean) =>
            setScanView(
              (view) =>
                view && {
                  ...view,
                  pages: [
                    ...view.pages.filter((item) => item.page !== page),
                    {
                      ...view.pages.find((item) => item.page === page),
                      page, state,
                      startedAt: view.pages.find((item) => item.page === page)?.startedAt ?? performance.now(),
                      message,
                      ...(cancellable !== undefined ? { cancellable } : {}),
                      ...(["completed", "failed", "cancelled"].includes(state) ? { cancellable: false, cancelling: false } : {}),
                    },
                  ].sort((a, b) => a.page - b.page),
                },
            );
          let finished = 0;
          const pageJobs = new Map<number, string>();
          const deferredPages = new Set<number>();
          const deferPage = async (page: number) => {
            const jobId = pageJobs.get(page);
            if (!jobId || active.cancelled || active.paused || operation.current !== active || deferScanPage.current !== deferPage || deferredPages.has(page)) return;
            deferredPages.add(page);
            setScanControlError("");
            setScanView(view => view && ({ ...view, pages: view.pages.map(item => item.page === page ? { ...item, cancelling: true } : item) }));
            try {
              if (!(await jobCancel(jobId)) && pageJobs.get(page) === jobId)
                throw new Error(`第 ${page} 页未能取消，请重试。`);
            } catch (reason) {
              deferredPages.delete(page);
              if (mounted.current && operation.current === active && deferScanPage.current === deferPage) {
                setScanControlError(errorText(reason));
                setScanView(view => view && ({ ...view, pages: view.pages.map(item => item.page === page ? { ...item, cancelling: false } : item) }));
              }
            }
          };
          deferScanPage.current = deferPage;
          const inFlight = new Set<number>();
          const updateMessage = () =>
            setMessage(
              active.cancelled
                ? "正在取消，已完成内容会保留…"
                : `正在识别 ${fileIndex} / ${targets.length} 份 · ${target.name} · 已处理 ${finished} / ${numbers.length} 页 · 最多 ${OCR_CONCURRENCY} 页并发${inFlight.size ? ` · 在途页码 ${[...inFlight].sort((a, b) => a - b).join("、")}` : ""}`,
            );
          await runOcrPool(numbers, async (number) => {
            await checkpoint(active);
            inFlight.add(number);
            updatePageState(number, "preparing");
            updateMessage();
            const pageStarted = performance.now();
            const timing: OcrPageTiming = {
              documentId: target.id,
              documentName: target.name,
              page: number,
              status: "failed",
              renderMs: 0,
              totalMs: 0,
            };
            let id: string | undefined;
            try {
              const renderStarted = performance.now();
              let image: string;
              try {
                // The worker detects orientation from the original pixels once.
                image = await source!.render(number, 0);
              } finally {
                timing.renderMs = performance.now() - renderStarted;
              }
              await checkpoint(active);
              const taskStarted = performance.now();
              let result: OcrRecognitionResult;
              try {
                result = await runOcrJob<OcrRecognitionResult>(
                  "ocr.recognize_page",
                  {
                    documentId: target.id,
                    page: number,
                    imageBase64: image.replace(/^data:[^,]+,/, ""),
                    layout: "full",
                    expectedRevision:
                      saved.pages.find((item) => item.page === number)
                        ?.revision ?? 0,
                  },
                  (jobId) => {
                    id = jobId;
                    registerOcrScanJob(jobId);
                    attachJob(active, jobId);
                    pageJobs.set(number, jobId);
                    updatePageState(number, "running", undefined, true);
                  },
                  (event) => {
                    if (["queued", "memory_paused", "ocr_request", "ocr_save"].includes(event.phase))
                      updatePageState(number, event.phase as OcrScanPageState, event.message);
                    else if (
                      !["completed", "failed", "cancelled"].includes(
                        event.phase,
                      )
                    )
                      updatePageState(number, "running", event.message);
                  },
                  (jobTiming) => {
                    timing.startMs = jobTiming.startMs;
                  },
                );
              } finally {
                timing.taskMs = performance.now() - taskStarted;
              }
              timing.worker = result.timings;
              timing.status = "completed";
              setFailedScanPages(values => ({ ...values, [target.id]: (values[target.id] ?? []).filter(page => page !== number) }));
              updatePageState(number, "completed");
            } catch (reason) {
              if (active.cancelled) {
                timing.status = "cancelled";
                updatePageState(number, "cancelled");
                throw reason;
              }
              updatePageState(number, "failed");
              setFailedScanPages(values => ({ ...values, [target.id]: [...new Set([...(values[target.id] ?? []), number])].sort((a, b) => a - b) }));
              failed.push(
                `${target.name} 第 ${number} 页：${deferredPages.has(number) ? "已结束本次等待，可重试失败页补扫；若该页刚好已保存，将保留已保存结果。" : errorText(reason)}`,
              );
            } finally {
              if (id) active.jobIds.delete(id);
              pageJobs.delete(number);
              timing.totalMs = performance.now() - pageStarted;
              if (mounted.current) {
                setScanRuns(values => ({ ...values, [target.id]: {
                  ...values[target.id], pages: [...(values[target.id]?.pages ?? []), timing],
                } }));
                finished++;
                inFlight.delete(number);
                setProgress({ current: finished, total: numbers.length });
                updateMessage();
              }
            }
          });
          if (active.cancelled) await checkpoint(active);
          setScanView((view) => view && { ...view, phase: "saving" });
          const updated = await ocrCall<OcrDocumentDetail>("ocr.document", {
            documentId: target.id,
          });
          // Cancel can race a committed save and its terminal event. Re-read
          // revisions before offering retry, so a saved page is never discarded
          // or submitted again merely because the cancellation event arrived first.
          const savedDuringCancel = [...deferredPages].filter(number =>
            (updated.pages.find(page => page.page === number)?.revision ?? 0) >
            (saved.pages.find(page => page.page === number)?.revision ?? 0));
          if (mounted.current && savedDuringCancel.length) {
            setFailedScanPages(values => ({ ...values, [target.id]: (values[target.id] ?? []).filter(page => !savedDuringCancel.includes(page)) }));
            setScanRuns(values => ({ ...values, [target.id]: { ...values[target.id], pages: values[target.id].pages.map(page => savedDuringCancel.includes(page.page) ? { ...page, status: "completed" } : page) } }));
            for (const number of savedDuringCancel) {
              updatePageState(number, "completed");
              const prefix = `${target.name} 第 ${number} 页：`;
              for (let i = failed.length - 1; i >= 0; i--) if (failed[i].startsWith(prefix)) failed.splice(i, 1);
            }
          }
          if (mounted.current)
            setDetailCache((values) => ({ ...values, [target.id]: updated }));
        } catch (reason) {
          if (active.cancelled) throw reason;
          failed.push(`${target.name}：${errorText(reason)}`);
        } finally {
          deferScanPage.current = async () => {};
          source?.dispose();
        }
      }
    } finally {
      if (mounted.current) {
        const ended = performance.now();
        setScanRuns(values => ({ ...values, ...Object.fromEntries(targets.map(target => [target.id, { ...values[target.id], ended }])) }));
        if (projectRef.current) await refreshDocuments(projectRef.current);
        const refreshed = await Promise.all(
          targets.map((target) =>
            ocrCall<OcrDocumentDetail>("ocr.document", {
              documentId: target.id,
            }),
          ),
        );
        if (mounted.current)
          setDetailCache((values) => ({
            ...values,
            ...Object.fromEntries(
              refreshed.map((value) => [value.document.id, value]),
            ),
          }));
        const selected = documentRef.current;
        if (selected) await loadDocument(selected, pageNumber);
      }
    }
    setMessage(
      failed.length
        ? "识别完成，部分页面失败。已完成页已保存，可继续导出或场景摘录，也可重试失败页。"
        : "扫描完成。可导出文件、查看原文，或进入场景摘录。",
    );
    if (skipped.length)
      setMessage((value) => `${value}\n${skipped.join("\n")}`);
    if (failed.length) setError(failed.join("\n"));
  }
  async function setOperationPaused() {
    const active = operation.current;
    if (!active || active.cancelled || controllingRef.current) return;
    controllingRef.current = true;
    setControlling(true);
    const next = !active.paused;
    active.paused = next;
    setPaused(next);
    try {
      const results = await Promise.allSettled(
        [...active.jobIds].map(async (id) => {
          if (!(await jobPause(id, next)) && active.jobIds.has(id))
            throw new Error("暂停或继续未成功，请重试。");
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } catch (reason) {
      if (!active.cancelled) {
        active.paused = !next;
        setPaused(!next);
        await Promise.allSettled(
          [...active.jobIds].map((id) => jobPause(id, !next)),
        );
      }
      throw reason;
    } finally {
      active.wake?.();
      controllingRef.current = false;
      if (mounted.current) setControlling(false);
    }
  }
  async function cancelOperation() {
    const active = operation.current;
    if (!active) return;
    active.cancelled = true;
    active.paused = false;
    active.wake?.();
    setPaused(false);
    setMessage("正在取消，已完成内容会保留…");
    const results = await Promise.allSettled(
      [...active.jobIds].map((id) => jobCancel(id)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  scanControls.current = {
    pause: () => {
      setScanControlError("");
      void setOperationPaused().catch((reason) => {
        setScanControlError(errorText(reason));
        setError(errorText(reason));
      });
    },
    cancel: () => {
      setScanControlError("");
      void cancelOperation().catch((reason) => {
        setScanControlError(errorText(reason));
        setError(errorText(reason));
      });
    },
  };
  const presentScan = scanDialog.setProgress;
  useEffect(() => {
    const deferPage = deferScanPage.current;
    presentScan(
      busy && (scanView || taskView)
        ? {
            ...(taskView ?? {
              ...scanView!,
              ...progress,
              completed: progress.current,
            }),
            paused,
            controlling,
            stopping: Boolean(operation.current?.cancelled),
            error: scanControlError,
            onPause: () => scanControls.current.pause(),
            onCancel: () => scanControls.current.cancel(),
            ...(!taskView ? { onDeferPage: (page: number) => { void deferPage(page); } } : {}),
          }
        : undefined,
    );
  }, [
    presentScan,
    busy,
    scanView,
    taskView,
    progress,
    paused,
    controlling,
    scanControlError,
    message,
  ]);
  useEffect(() => () => presentScan(undefined), [presentScan]);
  async function persistPrompts(next: OcrPromptStage[]) {
    if (!project || !scenario) return;
    const pending = promptSavePending.current
      .catch(() => {})
      .then(() =>
        ocrCall<OcrProject>("ocr.project_save", {
          id: project.id,
          name: project.name,
          prompts: { ...project.prompts, [scenario.id]: next },
        }),
      );
    promptSavePending.current = pending;
    const updated = await pending;
    if (
      promptSnapshot.current.scenarioId === scenario.id &&
      JSON.stringify(promptSnapshot.current.stages) === JSON.stringify(next)
    )
      promptDirty.current = false;
    if (mounted.current) {
      if (projectRef.current === updated.id) setProject(updated);
      setProjects((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
    }
  }
  async function savePromptEdits() {
    if (promptDirty.current && scenario) await persistPrompts(stages);
  }
  async function chooseScenario(id: string) {
    await savePromptEdits();
    const next = availableScenarios.find((item) => item.id === id);
    setScenarioId(id);
    setPendingExtractionExport(undefined);
    setExtractionFailures([]);
    setStages(next ? getOcrPromptStages(next, project?.prompts) : []);
    promptDirty.current = false;
  }
  async function saveNamedScenario() {
    if (!project || !scenario) return;
    const name = savedScenarioName.trim();
    if (!name) throw new Error("请输入场景名称。");
    if (name.length > 80) throw new Error("场景名称不能超过 80 个字。");
    if (stages.some((stage) => stage.id !== "consolidate" && !stage.prompt.trim()))
      throw new Error("请填写摘录要求。");
    const existing = (project.customScenarios ?? []).find(
      (item) => item.id === scenario.id,
    );
    if (
      availableScenarios.some(
        (item) => item.name === name && item.id !== existing?.id,
      )
    )
      throw new Error("已有同名场景，请使用其他名称。");
    const saved: OcrCustomScenario = {
      id: existing?.id ?? `saved-${crypto.randomUUID()}`,
      name,
      baseScenarioId: scenario.baseScenarioId ?? scenario.id,
      version: scenario.version,
      fields: structuredClone(scenario.fields),
      stages: structuredClone(stages),
    };
    await promptSavePending.current.catch(() => {});
    const updated = await ocrCall<OcrProject>("ocr.project_save", {
      id: project.id,
      name: project.name,
      prompts: { ...project.prompts, [saved.id]: stages },
      customScenarios: [
        ...(project.customScenarios ?? []).filter(
          (item) => item.id !== saved.id,
        ),
        saved,
      ],
    });
    if (!mounted.current || projectRef.current !== updated.id) return;
    setProject(updated);
    setProjects((items) =>
      items.map((item) => (item.id === updated.id ? updated : item)),
    );
    setScenarioId(saved.id);
    promptDirty.current = false;
    setPromptSaveDialogOpen(false);
    setMessage(`场景“${name}”已保存，可从摘录场景下拉框选择。`);
  }
  async function extract() {
    setExtractionFailures([]);
    setExtractionStats([]);
    if (!selectedDocuments.length || !scenario) return;
    if (stages.some((item) => item.id !== "consolidate" && !item.prompt.trim()))
      throw new Error("请填写摘录要求。");

    const targets = [...selectedDocuments];
    setPendingExtractionExport(undefined);
    const promptStages = structuredClone(stages);
    const active = new OcrOperation();
    operation.current = active;
    setTaskView({
      kind: "task",
      phase: "preparing",
      fileName: scenario.name,
      fileIndex: 1,
      fileCount: targets.length,
      completed: 0,
      total: targets.length,
      message: "正在保存摘录要求并准备场景摘录…",
    });
    const failures: string[] = [];
    let completed = 0;
    const completedIds: string[] = [];
    const extractionIds: string[] = [];
    setOutputs([]);
    setExportDirectory("");
    try {
      await persistPrompts(stages);
      for (const [index, target] of targets.entries()) {
        await checkpoint(active);
        setTaskView(
          (view) =>
            view && {
              ...view,
              phase: "extracting",
              fileName: target.name,
              fileIndex: index + 1,
              message: "正在读取已扫描原文…",
              activity: undefined,
            },
        );
        try {
          const current = await ocrCall<OcrDocumentDetail>("ocr.document", {
            documentId: target.id,
          });
          if (!current.pages.length) {
            failures.push(`${target.name}：尚未扫描，已跳过。`);
            continue;
          }
          const cache = await openOcrExtractionCache(current.document.id);
          const runId = crypto.randomUUID();
          const diagnostics: OcrExtractionDiagnostic[] = [];
          let result: Awaited<ReturnType<typeof extractOcrScenario>>;
          try { result = await extractOcrScenario({
            scenario,
            stages: promptStages,
            document: current.document,
            pages: current.pages,
            cache,
            onDiagnostic: entry => {
              diagnostics.push(entry);
              if (mounted.current) setExtractionStats(values => [...values, entry]);
            },
            checkpoint: () => checkpoint(active),
            onProgress: (text) => {
              setMessage(
                `${index + 1} / ${targets.length} 份 · ${target.name} · ${text}`,
              );
              setTaskView((view) => view && { ...view, message: text });
            },
            onWorkProgress: (activity) =>
              setTaskView((view) => view && { ...view, activity }),
            request: async (params) => {
              await checkpoint(active);
              let jobId: string | undefined;
              try {
                return await runOcrJob("ocr.extract", params, (id) => {
                  jobId = id;
                  registerOcrOperationJob(id);
                  attachJob(active, id);
                });
              } finally {
                if (jobId) active.jobIds.delete(jobId);
              }
            },
          }); } finally {
            await ocrCall("ocr.extraction_diagnostics_save", { documentId: current.document.id, runId, entries: diagnostics }).catch(() => {});
          }
          await checkpoint(active);
          const latest = await openOcrExtractionCache(current.document.id);
          if (latest.contextKey !== cache.contextKey) throw new Error("原文或统一 LLM 配置已变化，请基于当前版本重新摘录；已核验分段仍按各自版本保存。");
          setTaskView(
            (view) =>
              view && {
                ...view,
                phase: "saving",
                message: "正在保存本文件摘录结果…",
              },
          );
          const extraction = await ocrCall<OcrExtraction>(
            "ocr.extraction_save",
            {
              documentId: current.document.id,
              scenarioId: scenario.id,
              scenarioVersion: scenario.version,
              prompts: promptStages,
              sourceRevision: current.document.revision,
              ...result,
            },
          );
          const updated = await ocrCall<OcrDocumentDetail>("ocr.document", {
            documentId: target.id,
          });
          if (mounted.current)
            setDetailCache((values) => ({ ...values, [target.id]: updated }));
          completed++;
          completedIds.push(target.id);
          extractionIds.push(extraction.id);
        } catch (reason) {
          if (active.cancelled) throw reason;
          failures.push(`${target.name}：${errorText(reason)}`);
        } finally {
          if (!active.cancelled)
            setTaskView((view) => view && { ...view, completed: index + 1 });
        }
      }
    } finally {
      if (mounted.current && documentRef.current)
        await loadDocument(documentRef.current, pageNumber);
    }
    await checkpoint(active);
    setExtractionFailures(failures);
    if (completedIds.length) {
      setPendingExtractionExport({ documentIds: completedIds, extractionIds });
      await exportExcel("single_sheet", completedIds, {
        active,
        extractionIds,
      });
      setMessage(
        `已完成 ${completed} 份文件的场景摘录，Excel 已保存到目标目录。`,
      );
    } else setMessage("");
  }
  function beginExport() {
    if (!selectedDocuments.length) return;
    setError("");
    setExportDialogOpen(true);
  }
  // Selection is the sole operation scope. Preview navigation never changes it.
  useEffect(() => {
    let active = true;
    setMessage("");
    if (messageKind === "scan") setError("");
    setPendingExtractionExport(undefined);
    const projectId = projectRef.current;
    void Promise.all(
      selectedDocumentIds.map(async (id) => {
        const value = await ocrCall<OcrDocumentDetail>("ocr.document", {
          documentId: id,
        });
        if (active && mounted.current && projectRef.current === projectId)
          setDetailCache((values) => ({ ...values, [id]: value }));
      }),
    ).catch((reason) => {
      if (active) setError(errorText(reason));
    });
    if (!selectedDocumentIds.includes(documentRef.current ?? "")) {
      void (async () => {
        if (!active) return;
        if (selectedDocumentIds[0]) await loadDocument(selectedDocumentIds[0]);
        else {
          ++loadSequence.current;
          documentRef.current = undefined;
          setDetail(undefined);
        }
      })().catch((reason) => {
        if (active) setError(errorText(reason));
      });
    }
    return () => {
      active = false;
    };
  }, [selectedDocumentIds, project?.id]);
  useEffect(
    () => setExtractionFailures([]),
    [selectedDocumentIds, project?.id],
  );
  useEffect(() => {
    if (detail)
      setDetailCache((values) => ({ ...values, [detail.document.id]: detail }));
  }, [detail]);
  async function deleteDocument(id: string) {
    if (
      !(await confirmDialog({
        title: "删除这份文件？",
        message: "将删除项目内的副本及其识别、摘录结果。原文件不受影响。",
        tone: "danger",
      }))
    )
      return;

    await ocrCall("ocr.document_delete", { documentId: id });
    setSelectedDocumentIds((ids) => ids.filter((value) => value !== id));
    setDetailCache((values) => {
      const next = { ...values };
      delete next[id];
      return next;
    });
    if (projectRef.current) await refreshDocuments(projectRef.current);
  }
  async function clearProjectFiles() {
    const targets = [...documents];
    if (
      !targets.length ||
      !(await confirmDialog({
        title: `清空项目内全部 ${targets.length} 份文件？`,
        message:
          "将删除当前项目中全部文件的导入副本、识别和摘录结果，包括未勾选文件。原始文件、项目及摘录要求保留。",
        confirmLabel: "清空文件",
        tone: "danger",
      }))
    )
      return;
    const removed = new Set<string>();
    const failures: string[] = [];
    for (const target of targets) {
      try {
        await ocrCall("ocr.document_delete", { documentId: target.id });
        removed.add(target.id);
      } catch (reason) {
        failures.push(`${target.name}：${errorText(reason)}`);
      }
    }
    setSelectedDocumentIds((ids) => ids.filter((id) => !removed.has(id)));
    setDetailCache((values) =>
      Object.fromEntries(
        Object.entries(values).filter(([id]) => !removed.has(id)),
      ),
    );
    if (removed.has(documentRef.current ?? "")) {
      ++loadSequence.current;
      documentRef.current = undefined;
      setDetail(undefined);
    }
    setOutputs([]);
    setExportDirectory("");
    setScanRuns({});
    setFailedScanPages({});
    setStep(0);
    if (projectRef.current) await refreshDocuments(projectRef.current);
    setMessage(
      failures.length
        ? `已清空 ${removed.size} 份文件，${failures.length} 份未删除，请重试。`
        : `已清空项目内 ${removed.size} 份文件。`,
    );
    if (failures.length) setError(failures.join("\n"));
  }
  useEffect(() => {
    setSelectedDocumentIds([]);
    setExportDialogOpen(false);
  }, [project?.id]);
  async function exportExcel(
    mode: "single_sheet" | "per_document" | "individual",
    ids: string[],
    extraction?: { active: Operation; extractionIds: string[] },
  ) {
    if (!project || !ids.length) throw new Error("请先选择需要导出的文件。");
    const active = extraction?.active ?? new OcrOperation();
    operation.current = active;
    setTaskView((view) => ({
      kind: "task",
      fileName: `${ids.length} 份文件`,
      fileIndex: ids.length,
      fileCount: ids.length,
      completed: 0,
      total: ids.length,
      ...(extraction ? view : undefined),
      phase: "exporting",
      message: "正在准备 Excel 导出目录…",
      activity: undefined,
    }));
    await checkpoint(active);
    const { outputDir } = await ocrCall<{ outputDir: string }>(
      "ocr.output_directory",
      { projectId: project.id },
    );
    setOutputs([]);
    setExportDirectory("");
    await checkpoint(active);
    let exportJobId: string | undefined;
    let result: { outputPaths: string[] };
    try {
      result = await runOcrJob<{ outputPaths: string[] }>(
        "ocr.export",
        {
          projectId: project.id,
          documentIds: ids,
          mode,
          outputDir,
          ...(extraction
            ? { extractionsOnly: true, extractionIds: extraction.extractionIds }
            : {}),
        },
        (id) => {
          exportJobId = id;
          registerOcrOperationJob(id);
          attachJob(active, id);
        },
        (event) => {
          setMessage(event.message);
          setTaskView(
            (view) =>
              view && {
                ...view,
                message: event.message,
                activity:
                  event.total > 0 &&
                  (event.current < event.total || event.phase === "completed")
                    ? {
                        completed: event.current,
                        total: event.total,
                      }
                    : undefined,
              },
          );
        },
      );
    } finally {
      if (exportJobId) active.jobIds.delete(exportJobId);
    }
    if (!result.outputPaths.length) throw new Error("未生成导出文件，请重试。");
    setOutputs(result.outputPaths);
    if (extraction) setPendingExtractionExport(undefined);
    setExportDirectory(outputDir);
    setMessage("");
    return true;
  }
  function renderTaskProgress() {
    if (step === 1 && messageKind === "scan") return null;
    if (busy && (scanView || taskView) && scanDialog.available) return null;
    return (
      message && (
        <div role="status" className="ocr-progress">
          <div>
            {message}
            {busy && progress.total > 0 && (
              <progress
                max={progress.total}
                value={progress.current}
                aria-label="识别进度"
              />
            )}
          </div>
          {busy && operation.current && (
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={controlling || operation.current.cancelled}
                onClick={() =>
                  void setOperationPaused().catch((reason) =>
                    setError(errorText(reason)),
                  )
                }
              >
                {paused ? "继续" : "暂停"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void cancelOperation().catch((reason) =>
                    setError(errorText(reason)),
                  )
                }
              >
                取消任务
              </Button>
            </div>
          )}
        </div>
      )
    );
  }
  function renderExportNotice() {
    if (!outputs.length) return null;
    return (
      <div className="ocr-export-notice" role="status" aria-label="导出结果">
        <strong>导出文件成功</strong>
        <span>
          导出目录：
          {exportDirectory
            .replace(/^\\\\\?\\UNC\\/, "\\\\")
            .replace(/^\\\\\?\\/, "")}
        </span>
        <Button
          size="sm"
          variant="link"
          onClick={() =>
            void openOutput(exportDirectory).catch((reason) =>
              setError(errorText(reason)),
            )
          }
        >
          打开导出目录
        </Button>
        {outputs.map((path) => (
          <Button
            key={path}
            size="sm"
            variant="link"
            onClick={() =>
              void openOutput(path).catch((reason) =>
                setError(errorText(reason)),
              )
            }
          >
            {path.split(/[\\/]/).at(-1)}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <div className="ocr-page">
      <PageHeader
        eyebrow="识别与整理"
        title={tool?.name ?? "OCR"}
        detail="把单证、合同和扫描表格转成可编辑的 Excel；需要时再做场景摘录。"
      />
      {error && (
        <div role="alert" className="ocr-alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => setError("")}>
            关闭提示
          </Button>
        </div>
      )}
      <StepIndicator
        className="ocr-steps"
        ariaLabel="OCR 处理步骤"
        current={step}
        showCompleted={false}
        steps={[
          { key: "recognize", label: "原文识别", disabled: busy },
          {
            key: "extract",
            label: "场景摘录",
            badge: "测试中 / 可试用",
            disabled: busy || !hasResults,
          },
        ]}
        onStepClick={(next) => void run(() => changeStep(next))}
      />
      {step === 0 && (
        <>
          <Card className="ocr-project-bar">
            <CardContent>
              <label>
                项目
                <select
                  aria-label="选择 OCR 项目"
                  value={project?.id ?? ""}
                  disabled={busy}
                  onChange={(event) => {
                    const id = event.target.value;
                    void run(async () => {
                      await savePromptEdits();
                      projectRef.current = id;
                      setProject(projects.find((item) => item.id === id));
                    });
                  }}
                >
                  <option value="" disabled>
                    选择或新建项目
                  </option>
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                aria-label="新项目名称"
                placeholder="新项目名称"
                value={projectName}
                disabled={busy}
                onChange={(event) => setProjectName(event.target.value)}
              />
              <Button
                variant="outline"
                disabled={busy || !projectName.trim()}
                onClick={() =>
                  void run(async () => {
                    await savePromptEdits();
                    const created = await ocrCall<OcrProject>(
                      "ocr.project_save",
                      {
                        name: projectName.trim(),
                      },
                    );
                    setProjects((items) => [created, ...items]);
                    projectRef.current = created.id;
                    setProject(created);
                    setProjectName("");
                  })
                }
              >
                <Plus />
                新建项目
              </Button>
              {project && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (
                        !(await confirmDialog({
                          title: "删除 OCR 项目？",
                          message:
                            "项目中的导入副本、识别和摘录结果将删除。原文件不受影响。",
                          tone: "danger",
                        }))
                      )
                        return;

                      await ocrCall("ocr.project_delete", { id: project.id });
                      const rest = projects.filter(
                        (item) => item.id !== project.id,
                      );
                      setProjects(rest);
                      projectRef.current = rest[0]?.id;
                      setProject(rest[0]);
                      setDetail(undefined);
                      setDocuments([]);
                    })
                  }
                >
                  删除项目
                </Button>
              )}
            </CardContent>
          </Card>
        </>
      )}
      {!project ? (
        <div className="ocr-empty">
          <FileScan size={44} />
          <h2>从一个项目开始</h2>
          <p>按批次整理扫描件，识别进度、校对和摘录要求会保存在项目中。</p>
        </div>
      ) : (
        <>
          {step === 0 && (
            <>
              <FileDropInput
                containerRef={uploadRef}
                className={`ocr-upload ${documents.length ? "has-files" : "is-empty"}`}
                value={documents[0]?.name ?? ""}
                displayValue={`已导入 ${documents.length} 份文件 · 点击继续添加`}
                hideFilledLabel
                ariaLabel="导入文件"
                placeholder="拖放或点击选择扫描件"
                emptyContent={
                  <>
                    <UploadCloud size={36} aria-hidden="true" />
                    <strong>拖入扫描件或文件夹</strong>
                    <span>或点击选择文件，支持多选</span>
                  </>
                }
                description="支持 PDF、PNG、JPEG、BMP、TIFF，可拖入多个文件或文件夹。"
                disabled={busy}
                highlight={uploadDrop.highlight}
                onDragStateChange={uploadDrop.onDragStateChange}
                onBrowse={() => void run(() => chooseImport(false))}
                actions={
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => chooseImport(true))}
                  >
                    <FolderOpen />
                    选择文件夹
                  </Button>
                }
              />
            </>
          )}
          {documents.length > 0 && (
            <div className="ocr-workspace">
              <aside className="ocr-document-list" aria-label="项目文件">
                <div className="ocr-files-heading">
                  <h2>
                    文件 <span>{documents.length}</span>
                  </h2>
                  <p className="ocr-muted">
                    {step === 0
                      ? "扫描、导出和场景摘录均针对勾选文件；当前查看文件仅切换预览。"
                      : "场景摘录针对勾选文件，完成后自动导出到目标目录。"}
                  </p>
                </div>
                <div className="ocr-file-selection">
                  <label>
                    <input
                      type="checkbox"
                      aria-label="全选项目文件"
                      disabled={busy || !documents.length}
                      checked={
                        documents.length > 0 &&
                        selectedDocuments.length === documents.length
                      }
                      ref={(element) => {
                        if (element)
                          element.indeterminate =
                            selectedDocuments.length > 0 &&
                            selectedDocuments.length < documents.length;
                      }}
                      onChange={(event) =>
                        setSelectedDocumentIds(
                          event.target.checked
                            ? documents.map((document) => document.id)
                            : [],
                        )
                      }
                    />
                    全选
                  </label>
                  <span className="ocr-muted" aria-live="polite">
                    已选 {selectedDocuments.length} / {documents.length} 份
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !documents.length}
                    onClick={() => void run(clearProjectFiles)}
                  >
                    清空文件
                  </Button>
                </div>
                {!detail && (
                  <div className="ocr-batch-status">
                    {renderExportNotice()}
                    {renderTaskProgress()}
                  </div>
                )}
                {!documents.length && (
                  <p className="ocr-muted">导入扫描件后开始识别。</p>
                )}
                <div className="ocr-document-grid" id="ocr-project-files">
                  {(filesExpanded ? documents : documents.slice(0, 9)).map(
                    (item) => (
                      <div className="ocr-document-card" key={item.id}>
                        <input
                          type="checkbox"
                          className="ocr-file-checkbox"
                          aria-label={`选择文件：${item.name}`}
                          disabled={busy}
                          checked={selectedDocumentIds.includes(item.id)}
                          onChange={(event) =>
                            setSelectedDocumentIds((ids) =>
                              event.target.checked
                                ? [...ids, item.id]
                                : ids.filter((id) => id !== item.id),
                            )
                          }
                        />
                        <button
                          disabled={busy}
                          className={`ocr-document ${detail?.document.id === item.id ? "is-selected" : ""}`}
                          title={item.name}
                          onClick={() =>
                            void run(async () => {
                              await savePromptEdits();
                              setSelectedDocumentIds([item.id]);
                              await loadDocument(item.id);
                            })
                          }
                        >
                          <FileScan size={18} />
                          <span>
                            <strong>{item.name}</strong>
                            <small>
                              {statusLabels[item.status] ?? "待处理"}
                              {item.totalPages > 0
                                ? ` · ${item.totalPages} 页`
                                : ""}
                            </small>
                          </span>
                        </button>
                        <Button
                          className="ocr-file-delete"
                          variant="ghost"
                          size="icon"
                          aria-label={`删除文件：${item.name}`}
                          disabled={busy}
                          onClick={() =>
                            void run(() => deleteDocument(item.id))
                          }
                        >
                          <Trash2 size={15} />
                        </Button>
                      </div>
                    ),
                  )}
                </div>
                {documents.length > 9 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={filesExpanded}
                    aria-controls="ocr-project-files"
                    onClick={() => setFilesExpanded((value) => !value)}
                  >
                    {filesExpanded
                      ? "收起文件"
                      : `展开全部 ${documents.length} 份文件`}
                  </Button>
                )}
              </aside>
              <main
                className={`ocr-document-workspace ${step === 1 ? "is-extraction" : ""}`}
              >
                {!detail || !selectedDocuments.length ? (
                  <div className="ocr-empty">
                    <ScanText size={36} />
                    <h2>选择需要处理的文件</h2>
                    <p>点击卡片处理单份文件，或勾选多份文件批量处理。</p>
                  </div>
                ) : (
                  <>
                    {step === 0 && (
                      <>
                        <div className="ocr-file-heading">
                          <div>
                            <h2>
                              {selectedDocuments.length > 1
                                ? `已选 ${selectedDocuments.length} 份文件`
                                : detail.document.name}
                            </h2>
                            <p>
                              {step === 0
                                ? "对照扫描件阅读初始原文；识别正文和表格可直接导出 Excel。"
                                : "按摘录要求整理内容，完成后自动导出到目标目录。"}
                            </p>
                          </div>
                        </div>
                      </>
                    )}
                    {step === 0 && (
                      <>
                        <section
                          className="ocr-operation-area"
                          aria-label="扫描操作"
                        >
                          <div className="ocr-scan-toolbar">
                            <div className="ocr-scan-settings">
                              <label>
                                扫描范围
                                <select
                                  aria-label="扫描范围"
                                  value={scanScope}
                                  disabled={busy}
                                  onChange={(event) =>
                                    setScanScope(event.target.value)
                                  }
                                >
                                  <option value="all">全部扫描</option>
                                  <option value="custom">自定义扫描页码</option>
                                </select>
                              </label>
                              {scanScope === "custom" && (
                                <label>
                                  扫描页码
                                  <Input
                                    aria-label="扫描页码"
                                    placeholder="例如：2-5 或 1,3-5"
                                    value={scanPages}
                                    disabled={busy}
                                    onChange={(event) =>
                                      setScanPages(event.target.value)
                                    }
                                  />
                                </label>
                              )}
                            </div>
                            <div className="ocr-operation-buttons">
                              <Button
                                disabled={busy}
                                onClick={() => void run(recognize)}
                              >
                                <ScanText />
                                开始扫描
                              </Button>
                              <Button
                                disabled={busy || !hasResults}
                                onClick={beginExport}
                              >
                                <Download />
                                导出文件
                              </Button>
                              {hasResults && (
                                <Button
                                  className="ocr-next-action"
                                  disabled={busy}
                                  onClick={() => void run(() => changeStep(1))}
                                >
                                  下一步：场景摘录
                                </Button>
                              )}
                            </div>
                          </div>
                          <span className="ocr-muted ocr-scan-hint">
                            {selectedDocuments.length > 1
                              ? `逐份应用范围 · 共 ${selectedDocuments.length} 份`
                              : `共 ${detail.document.totalPages || "待读取"} 页`}{" "}
                            ·
                            {scanScope === "custom"
                              ? "重扫所选页，覆盖前确认"
                              : "已完成页默认跳过"}
                          </span>
                          {renderExportNotice()}
                          {renderTaskProgress()}
                          {timingRun && <OcrTimingPanel run={timingRun}
                            retryFailedCount={retryFailedCount} retryDisabled={busy}
                            onRetryFailed={() => void run(() => recognize(true))} />}
                        </section>
                        {
                          <>
                            <div
                              className={`ocr-page-navigation ${selectedDocuments.length > 1 ? "has-file-selector" : ""}`}
                            >
                              {selectedDocuments.length > 1 && (
                                <label className="ocr-focus-selector">
                                  当前查看文件
                                  <select
                                    aria-label="当前查看文件"
                                    value={detail.document.id}
                                    disabled={busy}
                                    onChange={(event) => {
                                      const id = event.target.value;
                                      void run(async () => {
                                        await loadDocument(id);
                                      });
                                    }}
                                  >
                                    {selectedDocuments.map((item) => (
                                      <option key={item.id} value={item.id}>
                                        {item.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              )}

                              <div
                                className="ocr-pagination-controls"
                                role="group"
                                aria-label="分页导航"
                              >
                                <label>
                                  扫描件第
                                  <select
                                    aria-label="当前页"
                                    value={pageNumber}
                                    disabled={busy}
                                    onChange={(event) =>
                                      void run(() =>
                                        selectPage(Number(event.target.value)),
                                      )
                                    }
                                  >
                                    {Array.from(
                                      {
                                        length: Math.max(
                                          1,
                                          detail.document.totalPages,
                                        ),
                                      },
                                      (_, index) => (
                                        <option key={index} value={index + 1}>
                                          {index + 1}
                                        </option>
                                      ),
                                    )}
                                  </select>
                                  页 / {Math.max(1, detail.document.totalPages)}
                                </label>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy || pageNumber <= 1}
                                  onClick={() =>
                                    void run(() => selectPage(pageNumber - 1))
                                  }
                                >
                                  上一页
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={
                                    busy ||
                                    pageNumber >= detail.document.totalPages
                                  }
                                  onClick={() =>
                                    void run(() => selectPage(pageNumber + 1))
                                  }
                                >
                                  下一页
                                </Button>
                              </div>
                              <div
                                className="ocr-reading-modes"
                                role="group"
                                aria-label="阅读模式"
                              >
                                <button
                                  type="button"
                                  aria-pressed={showOriginal}
                                  onClick={() => setShowOriginal(true)}
                                >
                                  原文查看
                                </button>
                                <button
                                  type="button"
                                  aria-pressed={!showOriginal}
                                  onClick={() => setShowOriginal(false)}
                                >
                                  分页查看
                                </button>
                              </div>
                            </div>
                            <OcrReadingView
                              documents={scopeDetails}
                              current={{ ...detail, pages: documentPages }}
                              pageNumber={pageNumber}
                              sourceImage={sourceImage}
                              sourceError={sourceError}
                              fullText={showOriginal}
                              busy={busy}
                              onLocate={(id, page) =>
                                void run(async () => {
                                  await loadDocument(id, page);
                                  setShowOriginal(false);
                                })
                              }
                              onCopy={(text) =>
                                void navigator.clipboard.writeText(text).then(
                                  () =>
                                    setCopyNotice(
                                      showOriginal
                                        ? "已复制所选文件已扫描页的全部原文。"
                                        : "已复制本页原文。",
                                    ),
                                  (reason) => setError(errorText(reason)),
                                )
                              }
                            />
                            {copyNotice && (
                              <p role="status" className="ocr-copy-notice">
                                {copyNotice}
                              </p>
                            )}
                          </>
                        }
                      </>
                    )}
                    {step === 1 && (
                      <Card className="ocr-extraction">
                        <CardContent>
                          <label>
                            摘录场景
                            <select
                              aria-label="摘录场景"
                              value={scenarioId}
                              disabled={busy}
                              onChange={(event) => {
                                const id = event.target.value;
                                void run(() => chooseScenario(id));
                              }}
                            >
                              <option value="">请选择场景</option>
                              {availableScenarios.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          {scopeDetails.some(value => value.document.totalPages > value.pages.length) && (
                            <p className="ocr-muted" role="note" aria-label="摘录来源范围">
                              已扫描 {scopeDetails.reduce((sum, value) => sum + value.pages.length, 0)} / {scopeDetails.reduce((sum, value) => sum + value.document.totalPages, 0)} 页，
                              可继续使用已扫描原文摘录；缺失页可返回原文识别补扫或重试。
                            </p>
                          )}
                          {scenario && (
                            <>
                              <div className="ocr-prompt-heading">
                                <h3>摘录要求</h3>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() => (
                                    (promptDirty.current = true),
                                    setStages(getOcrPromptStages(scenario))
                                  )}
                                >
                                  <RotateCcw />
                                  恢复默认
                                </Button>
                              </div>
                              <p className="ocr-muted" id="ocr-requirements-help">
                                用自然语言说明想摘录什么；可指定列名和每行内容，未指定时自动安排合适的列并导出可编辑 Excel。
                              </p>
                              {stages.map((stage, index) => stage.id === "consolidate" ? null : (
                                <label
                                  className="ocr-prompt-stage"
                                  key={stage.id}
                                >
                                  {stage.label === "摘录要求" ? null : stage.label}
                                  <textarea
                                    aria-label={stage.label === "摘录要求" ? "摘录要求" : `${stage.label}摘录要求`}
                                    aria-describedby="ocr-requirements-help"
                                    placeholder="例如：整理每份合同的借款人、金额、期限和利率，每份合同一行；未明确的信息不要推测。"
                                    disabled={busy}
                                    value={stage.prompt}
                                    onChange={(event) => {
                                      promptDirty.current = true;
                                      setStages((items) =>
                                        items.map((item, stageIndex) =>
                                          stageIndex === index
                                            ? {
                                                ...item,
                                                prompt: event.target.value,
                                              }
                                            : item,
                                        ),
                                      );
                                    }}
                                  />
                                </label>
                              ))}
                              <div className="ocr-table-actions">
                                <Button
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => (
                                    setError(""),
                                    setSavedScenarioName(
                                      scenario.baseScenarioId
                                        ? scenario.name
                                        : "",
                                    ),
                                    setPromptSaveDialogOpen(true)
                                  )}
                                >
                                  保存为场景
                                </Button>
                                <Button
                                  disabled={busy || !hasResults}
                                  onClick={() => void run(extract)}
                                >
                                  开始摘录
                                </Button>
                              </div>
                            </>
                          )}
                          {renderTaskProgress()}
                          {renderExportNotice()}
                          {extractionStats.length > 0 && (
                            <p className="ocr-muted" aria-label="摘录请求统计">
                              已请求模型 {extractionStats.filter(entry => entry.status !== "cached").length} 次
                              · 复用 {extractionStats.filter(entry => entry.status === "cached").length} 段
                              · 校验未通过 {extractionStats.filter(entry => entry.status === "rejected").length} 次
                              · 请求累计 {(extractionStats.filter(entry => entry.status !== "cached").reduce((sum, entry) => sum + entry.elapsedMs, 0) / 1000).toFixed(1)} 秒（并行耗时有重叠）
                            </p>
                          )}
                          {extractionFailures.length > 0 && (
                            <div
                              className="ocr-extraction-failure"
                              role="alert"
                              aria-label="场景摘录失败详情"
                            >
                              <strong>
                                {outputs.length
                                  ? "部分文件未完成摘录"
                                  : "场景摘录未完成"}
                              </strong>
                              <ul>
                                {extractionFailures.map((failure, index) => (
                                  <li key={index}>{failure}</li>
                                ))}
                              </ul>
                              <p>已扫描的原文仍然保留，无需重新扫描。</p>
                              {extractionFailures.some((failure) =>
                                /网络|超时|连接/.test(failure),
                              ) && (
                                <p>
                                  请检查统一 LLM
                                  的连接及请求超时设置；长文摘录可延长超时时间后重试。
                                </p>
                              )}
                            </div>
                          )}
                          {pendingExtractionExport && (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await exportExcel(
                                    "single_sheet",
                                    pendingExtractionExport.documentIds,
                                    {
                                      active: new OcrOperation(),
                                      extractionIds:
                                        pendingExtractionExport.extractionIds,
                                    },
                                  );
                                  setMessage(
                                    "本次摘录 Excel 已保存到目标目录。",
                                  );
                                })
                              }
                            >
                              重试导出
                            </Button>
                          )}
                        </CardContent>
                      </Card>
                    )}
                  </>
                )}
              </main>
            </div>
          )}
        </>
      )}
      <Dialog
        open={promptSaveDialogOpen}
        onOpenChange={(open) => {
          if (!busy) setPromptSaveDialogOpen(open);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>保存为场景</DialogTitle>
            <DialogDescription>
              命名后可从当前项目的摘录场景下拉框直接选择。
            </DialogDescription>
          </DialogHeader>
          <label>
            场景名称
            <Input
              aria-label="场景名称"
              autoFocus
              maxLength={80}
              value={savedScenarioName}
              disabled={busy}
              placeholder="例如：银行借款限制性契约"
              onChange={(event) => setSavedScenarioName(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="ocr-warning">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setPromptSaveDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={busy || !savedScenarioName.trim()}
              onClick={() => void run(saveNamedScenario)}
            >
              保存场景
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={exportDialogOpen}
        onOpenChange={(open) => {
          if (!busy) setExportDialogOpen(open);
        }}
      >
        <DialogContent className="ocr-export-dialog" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>导出文件</DialogTitle>
            <DialogDescription>
              导出范围与文件区的勾选结果一致，请选择 Excel 排列方式。
            </DialogDescription>
          </DialogHeader>
          <p>本次导出：已选 {exportDocuments.length} 份文件</p>
          <div className="ocr-export-file-list" aria-label="本次导出文件">
            {exportDocuments.map((document) => (
              <div key={document.id}>{document.name}</div>
            ))}
          </div>
          <fieldset disabled={busy}>
            <legend>导出方式</legend>
            {(
              [
                [
                  "single_sheet",
                  "一个 Excel，一个 Sheet",
                  "按文件和页码分区，依次保留全文、表格和摘录；各表格保留原行列。",
                ],
                [
                  "per_document",
                  "一个 Excel，多个 Sheet",
                  "每份文件一个 Sheet，页内原文、表格和摘录按顺序排列。",
                ],
                [
                  "individual",
                  "多个 Excel",
                  "每份文件一个 Excel，原文、表格及摘录分别建工作表。",
                ],
              ] as const
            ).map(([value, label, description]) => (
              <label className="ocr-export-mode" key={value}>
                <input
                  type="radio"
                  name="ocr-export-mode"
                  value={value}
                  checked={exportMode === value}
                  onChange={() => setExportMode(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {exportDocuments.some(
            (document) => document.status !== "completed",
          ) && (
            <p className="ocr-muted">
              包含未完成扫描或待校对的文件，导出会保留相应提示；尚未扫描的页不会冒充识别结果。
            </p>
          )}
          {error && (
            <p role="alert" className="ocr-warning">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setExportDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={busy || !exportDocuments.length}
              onClick={() =>
                void run(async () => {
                  setExportDialogOpen(false);
                  if (
                    await exportExcel(
                      exportMode,
                      exportDocuments.map((document) => document.id),
                    )
                  )
                    setExportDialogOpen(false);
                })
              }
            >
              导出到目标目录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export { OcrPage };
