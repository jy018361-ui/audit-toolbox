import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  FileScan,
  FolderOpen,
  ScanText,
  Download,
  Plus,
  Trash2,
  RotateCcw,
  Copy,
  ArrowRight,
} from "lucide-react";
import {
  jobCancel,
  jobPause,
  openOutput,
  pickPath,
} from "./api";
import { ocrCall, runOcrJob } from "./ocrApi";
import {
  extractOcrScenario,
  getOcrPromptStages,
  loadOcrScenarios,
  type OcrScenario,
} from "./ocrScenarios";
import { openOcrSource, type OcrSource } from "./ocrSource";
import type {
  OcrConfigStatus,
  OcrDocument,
  OcrDocumentDetail,
  OcrExtraction,
  OcrPageData,
  OcrProject,
  OcrPromptStage,
  OcrTable,
} from "./ocrTypes";
import type { ToolManifest } from "./types";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { useNativeFileDropZone } from "@/hooks/useNativeFileDropZone";
import { markToolPageLive } from "./toolPageActivity";
import { StepIndicator } from "@/components/StepIndicator";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { confirmDialog } from "@/components/ConfirmDialog";
import { errorText } from "@/lib/errors";
import "./ocr.css";

type Draft = {
  documentId: string;
  page: OcrPageData;
  generation: number;
  dirty: boolean;
};
type Operation = {
  cancelled: boolean;
  paused: boolean;
  jobId?: string;
  wake?: () => void;
};
const statusLabels: Record<string, string> = {
  pending: "待识别",
  imported: "待识别",
  processing: "识别中",
  completed: "已完成",
  needs_review: "待校对",
  partial: "部分完成",
  failed: "识别失败",
};

function readableValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value))
    return value.map(readableValue).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const labels: Record<string, string> = {
      text: "内容",
      value: "内容",
      evidence: "原文证据",
      sourcePage: "来源页码",
      sourceFile: "来源文件",
      description: "说明",
      label: "项目",
      name: "名称",
      page: "页码",
      quote: "原文证据",
      reason: "判断依据",
    };
    return Object.entries(value)
      .map(([key, item]) => `${labels[key] ?? key}：${readableValue(item)}`)
      .join("\n");
  }
  return String(value);
}

export default function OcrPage({ tool }: { tool?: ToolManifest }) {
  const [projects, setProjects] = useState<OcrProject[]>([]);
  const [project, setProject] = useState<OcrProject>();
  const [projectName, setProjectName] = useState("");
  const [documents, setDocuments] = useState<OcrDocument[]>([]);
  const [detail, setDetail] = useState<OcrDocumentDetail>();
  const [pageNumber, setPageNumber] = useState(1);
  const [draft, setDraft] = useState<OcrPageData>();
  const [saveState, setSaveState] = useState("");
  const [sourceImage, setSourceImage] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [config, setConfig] = useState<OcrConfigStatus>();
  const [scenarios, setScenarios] = useState<OcrScenario[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [stages, setStages] = useState<OcrPromptStage[]>([]);
  const [step, setStep] = useState(0);
  const [layout, setLayout] = useState<"full" | "spread">("full");
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [outputs, setOutputs] = useState<string[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const projectRef = useRef<string | undefined>(undefined);
  const documentRef = useRef<string | undefined>(undefined);
  const draftRef = useRef<Draft | undefined>(undefined);
  const savePending = useRef<Promise<void> | undefined>(undefined);
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
  const scenario = scenarios.find((item) => item.id === scenarioId);
  promptSnapshot.current = { project, scenarioId, stages };

  const run = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
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
      ocrCall<OcrConfigStatus>("ocr.config_status", {}),
      loadOcrScenarios(),
    ])
      .then(([saved, status, available]) => {
        if (!mounted.current) return;
        setProjects(saved.projects);
        setConfig(status);
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
        if (active.jobId) void jobCancel(active.jobId).catch(() => {});
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
    setDocuments([]);
    setDetail(undefined);
    setDraft(undefined);
    draftRef.current = undefined;
    documentRef.current = undefined;
    setSourceImage("");
    setOutputs([]);
    setStep(0);
    setScenarioId("");
    void refreshDocuments(project.id).catch((reason) =>
      setError(errorText(reason)),
    );
  }, [project?.id, refreshDocuments]);

  const saveCurrent = useCallback(async () => {
    if (savePending.current) return savePending.current;
    const pending = (async () => {
      while (draftRef.current?.dirty) {
        const snapshot = draftRef.current;
        if (mounted.current) setSaveState("正在保存…");
        const saved = await ocrCall<OcrPageData>("ocr.page_save", {
          documentId: snapshot.documentId,
          page: snapshot.page,
          expectedRevision: snapshot.page.revision,
        });
        const current = draftRef.current;
        if (
          current?.documentId === snapshot.documentId &&
          current.page.page === snapshot.page.page
        ) {
          const unchanged = current.generation === snapshot.generation;
          draftRef.current = {
            ...current,
            page: unchanged
              ? saved
              : { ...current.page, revision: saved.revision },
            dirty: !unchanged,
          };
          if (mounted.current) {
            setDraft(draftRef.current.page);
            setDetail((value) =>
              value?.document.id === snapshot.documentId
                ? {
                    ...value,
                    document: {
                      ...value.document,
                      revision: value.document.revision + 1,
                    },
                    pages: value.pages.map((page) =>
                      page.page === saved.page ? saved : page,
                    ),
                    extractions: value.extractions.map((item) => ({
                      ...item,
                      stale: true,
                    })),
                  }
                : value,
            );
          }
        }
        if (mounted.current) setSaveState("已自动保存");
      }
    })();
    savePending.current = pending;
    try {
      await pending;
    } catch (reason) {
      if (mounted.current) setSaveState("保存失败，修改仍在此页");
      throw reason;
    } finally {
      savePending.current = undefined;
    }
  }, []);
  useEffect(() => {
    if (!draftRef.current?.dirty) return;
    const timer = window.setTimeout(() => {
      void saveCurrent().catch((reason) => setError(errorText(reason)));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, saveCurrent]);
  useEffect(
    () => () => {
      void saveCurrent().catch(() => {});
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
    [saveCurrent],
  );

  function setPageDraft(page?: OcrPageData, documentId = documentRef.current) {
    draftRef.current =
      page && documentId
        ? { documentId, page, generation: 0, dirty: false }
        : undefined;
    setDraft(page);
    setSaveState("");
  }
  function editPage(update: (page: OcrPageData) => OcrPageData) {
    const current = draftRef.current;
    if (!current) return;
    const page = update(current.page);
    draftRef.current = {
      ...current,
      page,
      generation: current.generation + 1,
      dirty: true,
    };
    setDraft(page);
    setSaveState("等待保存…");
  }
  async function loadDocument(id: string, page = 1) {
    const sequence = ++loadSequence.current;
    documentRef.current = id;
    setDetail(undefined);
    setPageDraft(undefined);
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
    setDetail(result);
    setPageDraft(
      result.pages.find((item) => item.page === page),
      id,
    );
  }
  async function selectPage(number: number) {
    await saveCurrent();
    setPageNumber(number);
    setPageDraft(detail?.pages.find((item) => item.page === number));
  }
  async function changeStep(next: number) {
    await saveCurrent();
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
        const image = await opened.render(pageNumber);
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
  }, [detail?.document.id, pageNumber]);

  async function importPaths(paths: string[], folder?: string) {
    const projectId = projectRef.current;
    if (!projectId) return;
    await saveCurrent();
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
    if (result.documents[0] && projectRef.current === projectId)
      await loadDocument(result.documents[0].id);
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
    if (active.cancelled)
      throw new Error("任务已取消，已完成内容已保存，可稍后继续。");
    while (active.paused && !active.cancelled)
      await new Promise<void>((resolve) => {
        active.wake = resolve;
      });
    if (active.cancelled)
      throw new Error("任务已取消，已完成内容已保存，可稍后继续。");
  }
  function attachJob(active: Operation, id: string) {
    active.jobId = id;
    if (active.cancelled)
      void jobCancel(id).catch((reason) => setError(errorText(reason)));
    else if (active.paused)
      void jobPause(id, true).catch((reason) => setError(errorText(reason)));
  }
  async function recognize(
    onlyCurrent = false,
    allDocuments = false,
    forceAllDocument = false,
  ) {
    if (
      forceAllDocument &&
      !(await confirmDialog({
        title: "重新识别全文？",
        message:
          "将重新识别当前文件的全部页面，替换现有识别正文及表格校对内容，并重新调用 OCR 服务。原扫描文件不受影响。",
        confirmLabel: "重新识别全文",
      }))
    )
      return;
    await saveCurrent();
    const status = await ocrCall<OcrConfigStatus>("ocr.config_status", {});
    setConfig(status);
    if (!status.ocr.ready) throw new Error("请先在全局设置中配置 OCR 服务。");
    const targets = forceAllDocument
      ? detail
        ? [detail.document]
        : []
      : allDocuments
        ? documents
        : detail
          ? [detail.document]
          : [];
    const active: Operation = { cancelled: false, paused: false };
    operation.current = active;
    const failed: string[] = [];
    try {
      for (const target of targets) {
        await checkpoint(active);
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
          const numbers = onlyCurrent
            ? [pageNumber]
            : Array.from(
                { length: source.totalPages },
                (_, index) => index + 1,
              ).filter(
                (number) =>
                  forceAllDocument ||
                  !saved.pages.some((item) => item.page === number),
              );
          setProgress({ current: 0, total: numbers.length });
          for (let index = 0; index < numbers.length; index++) {
            await checkpoint(active);
            const number = numbers[index];
            setMessage(
              `正在识别 ${target.name} · 第 ${number} / ${source.totalPages} 页`,
            );
            try {
              const image = await source.render(number);
              await checkpoint(active);
              await runOcrJob<OcrPageData>(
                "ocr.recognize_page",
                {
                  documentId: target.id,
                  page: number,
                  imageBase64: image.replace(/^data:[^,]+,/, ""),
                  layout,
                  expectedRevision:
                    saved.pages.find((item) => item.page === number)
                      ?.revision ?? 0,
                },
                (id) => attachJob(active, id),
              );
            } catch (reason) {
              if (active.cancelled) throw reason;
              failed.push(
                `${target.name} 第 ${number} 页：${errorText(reason)}`,
              );
            } finally {
              active.jobId = undefined;
            }
            setProgress({ current: index + 1, total: numbers.length });
          }
        } catch (reason) {
          if (active.cancelled) throw reason;
          failed.push(`${target.name}：${errorText(reason)}`);
        } finally {
          source?.dispose();
        }
      }
    } finally {
      if (mounted.current) {
        if (projectRef.current) await refreshDocuments(projectRef.current);
        const selected = documentRef.current;
        if (selected) await loadDocument(selected, pageNumber);
      }
    }
    setMessage(
      failed.length
        ? "识别完成，部分页面失败。已完成页已保存，可继续识别或重试本页。"
        : "识别完成。校对后即可导出 Excel，也可以按需摘录。",
    );
    if (failed.length) setError(failed.join("\n"));
  }
  async function setOperationPaused() {
    const active = operation.current;
    if (!active) return;
    const next = !active.paused;
    active.paused = next;
    setPaused(next);
    try {
      if (active.jobId && !(await jobPause(active.jobId, next)))
        throw new Error("暂停或继续未成功，请重试。");
    } catch (reason) {
      active.paused = !next;
      setPaused(!next);
      throw reason;
    } finally {
      active.wake?.();
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
    if (active.jobId) await jobCancel(active.jobId);
  }
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
    const next = scenarios.find((item) => item.id === id);
    setScenarioId(id);
    setStages(next ? getOcrPromptStages(next, project?.prompts) : []);
    promptDirty.current = false;
  }
  async function extract() {
    if (!detail || !scenario) return;
    if (stages.some((item) => !item.prompt.trim()))
      throw new Error("请填写每个阶段的提示词。");
    await saveCurrent();
    await persistPrompts(stages);
    const current = await ocrCall<OcrDocumentDetail>("ocr.document", {
      documentId: detail.document.id,
    });
    if (!current.pages.length) throw new Error("请先识别文件，再执行摘录。");
    const active: Operation = { cancelled: false, paused: false };
    operation.current = active;
    const result = await extractOcrScenario({
      scenario,
      stages,
      document: current.document,
      pages: current.pages,
      checkpoint: () => checkpoint(active),
      onProgress: (text) => setMessage(text),
      request: async (params) => {
        await checkpoint(active);
        try {
          return await runOcrJob("ocr.extract", params, (id) =>
            attachJob(active, id),
          );
        } finally {
          active.jobId = undefined;
        }
      },
    });
    await checkpoint(active);
    await ocrCall<OcrExtraction>("ocr.extraction_save", {
      documentId: current.document.id,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      prompts: stages,
      sourceRevision: current.document.revision,
      ...result,
    });
    if (documentRef.current === current.document.id)
      await loadDocument(current.document.id, pageNumber);
    setMessage("摘录已保存。可查看原文证据，或导出 Excel。");
  }
  async function exportExcel(
    mode: "individual" | "combined",
    currentOnly = false,
  ) {
    if (!project) return;
    await saveCurrent();
    const outputDir = await pickPath("folder", "选择 Excel 输出文件夹");
    if (!outputDir || Array.isArray(outputDir)) return;
    const active: Operation = { cancelled: false, paused: false };
    operation.current = active;
    const result = await runOcrJob<{ outputPaths: string[] }>(
      "ocr.export",
      {
        projectId: project.id,
        documentIds: currentOnly && detail ? [detail.document.id] : undefined,
        mode,
        outputDir,
      },
      (id) => attachJob(active, id),
      (event) => setMessage(event.message),
    );
    setOutputs(result.outputPaths);
    setMessage("Excel 已导出，目录中列出了未完成文件和页面。");
  }
  function editTable(id: string, update: (table: OcrTable) => OcrTable) {
    editPage((page) => ({
      ...page,
      tables: page.tables.map((table) =>
        table.id === id ? update(table) : table,
      ),
    }));
  }
  function extractionCell(key: string, value: unknown) {
    if (
      key === "sourcePage" &&
      typeof value === "string" &&
      /^[\d、,，;；\s]+$/.test(value)
    ) {
      const pages = [
        ...new Set((value.match(/\d+/g) ?? []).map(Number)),
      ].filter(
        (number) => number >= 1 && number <= (detail?.document.totalPages ?? 0),
      );
      if (pages.length)
        return (
          <span className="ocr-evidence-pages">
            {pages.map((number) => (
              <button
                key={number}
                className="ocr-page-link"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await selectPage(number);
                    await changeStep(0);
                  })
                }
              >
                第 {number} 页
              </button>
            ))}
          </span>
        );
    }
    return readableValue(value);
  }

  return (
    <div className="ocr-page">
      <PageHeader
        eyebrow="识别与整理"
        title={tool?.name ?? "OCR"}
        detail="把单证、合同和扫描表格转成可编辑的 Excel；需要时再做场景摘录。"
      />
      <div className="ocr-service-bar">
        <span>
          OCR：
          {config
            ? config.ocr.ready
              ? `已配置 ${config.ocr.engine}`
              : "未配置"
            : "检查中"}
        </span>
        <span>
          AI：{config ? (config.llm.ready ? "已配置" : "未配置") : "检查中"}
        </span>
        <Link to="/settings">全局设置</Link>
        <span className="ocr-muted">
          结构恢复可能使用全局 AI；单纯识别无需选择场景。
        </span>
      </div>
      {error && (
        <div role="alert" className="ocr-alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => setError("")}>
            关闭提示
          </Button>
        </div>
      )}
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
                  await saveCurrent();
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
                await saveCurrent();
                await savePromptEdits();
                const created = await ocrCall<OcrProject>("ocr.project_save", {
                  name: projectName.trim(),
                });
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
                  await saveCurrent();
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
      {!project ? (
        <div className="ocr-empty">
          <FileScan size={44} />
          <h2>从一个项目开始</h2>
          <p>按批次整理扫描件，识别进度、校对和提示词会保存在项目中。</p>
        </div>
      ) : (
        <>
          <StepIndicator
            className="ocr-steps"
            ariaLabel="OCR 处理步骤"
            current={step}
            showCompleted={false}
            steps={[
              { key: "recognize", label: "原文识别", disabled: busy },
              {
                key: "extract",
                label: "判断摘录",
                disabled: busy || !detail?.pages.length,
              },
            ]}
            onStepClick={(next) => void run(() => changeStep(next))}
          />
          {step === 0 && (
            <>
              <FileDropInput
                containerRef={uploadRef}
                className="ocr-upload"
                value={documents[0]?.name ?? ""}
                displayValue={`已导入 ${documents.length} 份文件 · 点击继续添加`}
                hideFilledLabel
                ariaLabel="导入文件"
                placeholder="拖放或点击选择扫描件"
                description="支持 PDF、PNG、JPEG、BMP、TIFF，可拖入多个文件或文件夹。"
                disabled={busy}
                highlight={uploadDrop.highlight}
                onDragStateChange={uploadDrop.onDragStateChange}
                onBrowse={() => void run(() => chooseImport(false))}
              />
              <div className="ocr-import-bar">
                <div>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => chooseImport(true))}
                  >
                    <FolderOpen />
                    导入文件夹
                  </Button>
                </div>
                <div>
                  <Button
                    variant="outline"
                    disabled={busy || !documents.length}
                    onClick={() => void run(() => recognize(false, true))}
                  >
                    <ScanText />
                    识别全部未完成页
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !documents.length}
                    onClick={() => void run(() => exportExcel("individual"))}
                  >
                    逐文件导出
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !documents.length}
                    onClick={() => void run(() => exportExcel("combined"))}
                  >
                    项目合并导出
                  </Button>
                </div>
              </div>
            </>
          )}
          {message && (
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
          )}
          <div className="ocr-workspace">
            <aside className="ocr-document-list" aria-label="项目文件">
              <h2>
                文件 <span>{documents.length}</span>
              </h2>
              {!documents.length && (
                <p className="ocr-muted">导入扫描件后开始识别。</p>
              )}
              {documents.map((item) => (
                <button
                  key={item.id}
                  disabled={busy}
                  className={`ocr-document ${detail?.document.id === item.id ? "is-selected" : ""}`}
                  title={item.name}
                  onClick={() =>
                    void run(async () => {
                      await saveCurrent();
                      await savePromptEdits();
                      await loadDocument(item.id);
                      setStep(0);
                    })
                  }
                >
                  <FileScan size={18} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {statusLabels[item.status] ?? "待处理"}
                      {item.totalPages > 0 ? ` · ${item.totalPages} 页` : ""}
                    </small>
                  </span>
                </button>
              ))}
            </aside>
            <main className="ocr-document-workspace">
              {!detail ? (
                <div className="ocr-empty">
                  <ScanText size={36} />
                  <h2>选择一份文件</h2>
                  <p>左侧选择文件，识别后对照扫描件校对正文和表格。</p>
                </div>
              ) : (
                <>
                  <div className="ocr-file-heading">
                    <div>
                      <h2>{detail.document.name}</h2>
                      <p>
                        {step === 0
                          ? "对照扫描件阅读初始原文，校对识别表格；可直接导出 Excel。"
                          : "按场景判断和摘录内容，提示词可修改并保存在当前项目。"}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label="删除当前文件"
                      onClick={() =>
                        void run(async () => {
                          if (
                            !(await confirmDialog({
                              title: "删除这份文件？",
                              message: "将删除项目内的副本及其识别、摘录结果。",
                              tone: "danger",
                            }))
                          )
                            return;
                          await saveCurrent();
                          await ocrCall("ocr.document_delete", {
                            documentId: detail.document.id,
                          });
                          documentRef.current = undefined;
                          setDetail(undefined);
                          setPageDraft(undefined);
                          await refreshDocuments(project.id);
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  {step === 0 && (
                    <>
                      <div className="ocr-document-toolbar">
                        <label>
                          扫描布局
                          <select
                            aria-label="扫描布局"
                            value={layout}
                            disabled={busy}
                            onChange={(event) =>
                              setLayout(event.target.value as "full" | "spread")
                            }
                          >
                            <option value="full">整页（含横向表格）</option>
                            <option value="spread">左右双页</option>
                          </select>
                        </label>
                        <Button
                          disabled={busy}
                          onClick={() => void run(() => recognize())}
                        >
                          <ScanText />
                          {detail.pages.length ? "继续识别" : "开始识别"}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => void run(() => recognize(true))}
                        >
                          重试本页
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy || !detail.pages.length}
                          onClick={() =>
                            void run(() => recognize(false, false, true))
                          }
                        >
                          重新识别全文
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy || !detail.pages.length}
                          onClick={() =>
                            void run(() => exportExcel("individual", true))
                          }
                        >
                          <Download />
                          导出本文件
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy || !detail.pages.length}
                          onClick={() => void run(() => changeStep(1))}
                        >
                          下一步：判断摘录 <ArrowRight />
                        </Button>
                      </div>
                      <div className="ocr-page-navigation">
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
                        <label>
                          第
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
                                length: Math.max(1, detail.document.totalPages),
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
                          disabled={
                            busy || pageNumber >= detail.document.totalPages
                          }
                          onClick={() =>
                            void run(() => selectPage(pageNumber + 1))
                          }
                        >
                          下一页
                        </Button>
                        <span className="ocr-muted" aria-live="polite">
                          {saveState}
                        </span>
                        {saveState.startsWith("保存失败") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void saveCurrent().catch((reason) =>
                                setError(errorText(reason)),
                              )
                            }
                          >
                            重试保存
                          </Button>
                        )}
                      </div>
                      <div className="ocr-comparison">
                        <section className="ocr-source">
                          <div className="ocr-pane-heading">
                            <h3>原扫描件</h3>
                            <span>第 {pageNumber} 页</span>
                          </div>
                          <div className="ocr-pane-body">
                            {sourceImage ? (
                              <img
                                src={sourceImage}
                                alt={`${detail.document.name} 第 ${pageNumber} 页`}
                              />
                            ) : (
                              <p className="ocr-muted">
                                {sourceError || "正在加载扫描页…"}
                              </p>
                            )}
                          </div>
                        </section>
                        <section className="ocr-original">
                          <div className="ocr-pane-heading">
                            <h3>初始原文</h3>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!draft}
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(draft?.originalText ?? "")
                                  .then(
                                    () => setMessage("已复制本页初始原文。"),
                                    (reason) => setError(errorText(reason)),
                                  )
                              }
                            >
                              <Copy />
                              复制原文
                            </Button>
                          </div>
                          <div className="ocr-pane-body">
                            {!draft ? (
                              <div className="ocr-empty">
                                <p>
                                  本页尚未识别。点击「开始识别」，或继续处理未完成页。
                                </p>
                              </div>
                            ) : (
                              <>
                                <div
                                  className="ocr-original-text"
                                  role="region"
                                  aria-label="本页初始原文"
                                  tabIndex={0}
                                >
                                  {draft.originalText || "本页未识别到正文。"}
                                </div>
                                {draft.warnings.map((warning, index) => (
                                  <p className="ocr-warning" key={index}>
                                    {warning}
                                  </p>
                                ))}
                                {draft.text !== draft.originalText && (
                                  <details className="ocr-corrected-text">
                                    <summary>
                                      查看此前保存的校对正文（导出和摘录继续使用此版本）
                                    </summary>
                                    <div className="ocr-original-text">
                                      {draft.text}
                                    </div>
                                  </details>
                                )}
                              </>
                            )}
                          </div>
                        </section>
                      </div>
                      {draft && (
                        <section
                          className="ocr-tables"
                          aria-label="已识别表格校对"
                        >
                          <div className="ocr-table-heading">
                            <h3>表格 · {draft.tables.length}</h3>
                            <span className="ocr-muted">
                              仅校对已识别表格；修改自动保存
                            </span>
                          </div>
                          {draft.tables.map((table, tableIndex) => (
                            <div className="ocr-edit-table" key={table.id}>
                              <Input
                                aria-label={`表格 ${tableIndex + 1} 名称`}
                                disabled={busy}
                                value={table.title}
                                onChange={(event) =>
                                  editTable(table.id, (item) => ({
                                    ...item,
                                    title: event.target.value,
                                  }))
                                }
                              />
                              <div className="ocr-table-scroll">
                                <table>
                                  <thead>
                                    <tr>
                                      {Array.from(
                                        {
                                          length: Math.max(
                                            1,
                                            ...table.rows.map(
                                              (row) => row.length,
                                            ),
                                          ),
                                        },
                                        (_, column) => (
                                          <th key={column}>
                                            第 {column + 1} 列{" "}
                                            <button
                                              disabled={busy}
                                              aria-label={`表格 ${tableIndex + 1} 删除第 ${column + 1} 列`}
                                              onClick={() =>
                                                editTable(table.id, (item) => ({
                                                  ...item,
                                                  rows: item.rows.map((row) =>
                                                    row.filter(
                                                      (_, index) =>
                                                        index !== column,
                                                    ),
                                                  ),
                                                }))
                                              }
                                            >
                                              ×
                                            </button>
                                          </th>
                                        ),
                                      )}
                                      <th>行操作</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {table.rows.map((row, rowIndex) => (
                                      <tr key={rowIndex}>
                                        {row.map((cell, columnIndex) => (
                                          <td key={columnIndex}>
                                            <textarea
                                              rows={2}
                                              disabled={busy}
                                              aria-label={`表格 ${tableIndex + 1} 第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`}
                                              value={cell}
                                              onChange={(event) =>
                                                editTable(table.id, (item) => ({
                                                  ...item,
                                                  rows: item.rows.map(
                                                    (values, index) =>
                                                      index === rowIndex
                                                        ? values.map(
                                                            (value, column) =>
                                                              column ===
                                                              columnIndex
                                                                ? event.target
                                                                    .value
                                                                : value,
                                                          )
                                                        : values,
                                                  ),
                                                }))
                                              }
                                            />
                                          </td>
                                        ))}
                                        <td>
                                          <Button
                                            size="xs"
                                            variant="ghost"
                                            disabled={busy}
                                            aria-label={`表格 ${tableIndex + 1} 删除第 ${rowIndex + 1} 行`}
                                            onClick={() =>
                                              editTable(table.id, (item) => ({
                                                ...item,
                                                rows: item.rows.filter(
                                                  (_, index) =>
                                                    index !== rowIndex,
                                                ),
                                              }))
                                            }
                                          >
                                            删行
                                          </Button>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <div className="ocr-table-actions">
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    editTable(table.id, (item) => ({
                                      ...item,
                                      rows: [
                                        ...item.rows,
                                        Array(
                                          Math.max(
                                            1,
                                            ...item.rows.map(
                                              (row) => row.length,
                                            ),
                                          ),
                                        ).fill(""),
                                      ],
                                    }))
                                  }
                                >
                                  添加行
                                </Button>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    editTable(table.id, (item) => ({
                                      ...item,
                                      rows: item.rows.length
                                        ? item.rows.map((row) => [...row, ""])
                                        : [[""]],
                                    }))
                                  }
                                >
                                  添加列
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    editPage((page) => ({
                                      ...page,
                                      tables: page.tables.filter(
                                        (item) => item.id !== table.id,
                                      ),
                                    }))
                                  }
                                >
                                  删除表格
                                </Button>
                              </div>
                            </div>
                          ))}
                          {!draft.tables.length && (
                            <p className="ocr-muted">本页未识别到表格。</p>
                          )}
                        </section>
                      )}
                    </>
                  )}
                  {step === 1 && (
                    <Card className="ocr-extraction">
                      <CardHeader>
                        <CardTitle>判断摘录</CardTitle>
                        <div className="ocr-extraction-toolbar">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => void run(() => changeStep(0))}
                          >
                            返回原文识别
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || !detail.pages.length}
                            onClick={() =>
                              void run(() => exportExcel("individual", true))
                            }
                          >
                            <Download />
                            导出本文件
                          </Button>
                        </div>
                        <p className="ocr-muted">
                          选择场景，查看并编辑完整提示词。修改只在当前项目保存。
                        </p>
                      </CardHeader>
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
                            {scenarios.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        {scenario && (
                          <>
                            <div className="ocr-prompt-heading">
                              <h3>提示词</h3>
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
                            {stages.map((stage, index) => (
                              <label
                                className="ocr-prompt-stage"
                                key={stage.id}
                              >
                                {stage.label}
                                <textarea
                                  aria-label={`${stage.label}提示词`}
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
                                onClick={() =>
                                  void run(async () => {
                                    await persistPrompts(stages);
                                    setMessage("提示词已保存到当前项目。");
                                  })
                                }
                              >
                                保存提示词
                              </Button>
                              <Button
                                disabled={busy || !detail.pages.length}
                                onClick={() => void run(extract)}
                              >
                                开始摘录
                              </Button>
                            </div>
                          </>
                        )}
                        {detail.extractions.map((item) => (
                          <section
                            className="ocr-extraction-result"
                            key={item.id}
                          >
                            <h3>
                              {scenarios.find(
                                (value) => value.id === item.scenarioId,
                              )?.name ?? item.scenarioId}{" "}
                              <span>
                                {item.stale ||
                                item.sourceRevision !== detail.document.revision
                                  ? "原文已修改，需要重新摘录"
                                  : "已保存"}
                              </span>
                            </h3>
                            <details>
                              <summary>查看本次使用的提示词</summary>
                              {item.prompts.map((stage) => (
                                <div key={stage.id}>
                                  <h4>{stage.label}</h4>
                                  <pre>{stage.prompt}</pre>
                                </div>
                              ))}
                            </details>
                            <div className="ocr-table-scroll">
                              <table>
                                <thead>
                                  <tr>
                                    {item.columns.map((column) => (
                                      <th key={column.key}>{column.label}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {item.rows.map((row, index) => (
                                    <tr key={index}>
                                      {item.columns.map((column) => (
                                        <td key={column.key}>
                                          {extractionCell(
                                            column.key,
                                            row[column.key],
                                          )}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            {!item.rows.length && (
                              <p className="ocr-muted">
                                未找到符合本次提示词的内容。
                              </p>
                            )}
                          </section>
                        ))}
                      </CardContent>
                    </Card>
                  )}
                </>
              )}
            </main>
          </div>
          {outputs.length > 0 && (
            <Card className="ocr-outputs">
              <CardContent>
                <h3>导出文件</h3>
                {outputs.map((path) => (
                  <Button
                    key={path}
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
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

export { OcrPage };
