import { useEffect, useMemo, useRef, useState } from "react";
import {
  audipickPdfBytes,
  engineCall,
  jobCancel,
  jobStart,
  listenJobEvents,
  pickPath,
  settingsGet,
  settingsSet,
} from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { audipickAssetsReady, loadAudipickAssets } from "./audipickAssets";
import { useJobPause } from "@/components/JobDialog";
import { errorText } from "@/lib/errors";
import { ResultView } from "@/components/ResultView";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import {
  AudiPickLegacyShell,
  type AudiPickLegacyPage,
} from "./AudiPickLegacyShell";
import {
  AudiPickLegacyConfig,
  AudiPickLegacyGuide,
  AudiPickLegacyHome,
} from "./AudiPickLegacyAuxiliary";
import {
  AudiPickLegacyDashboard,
  type AudiPickLegacyCreateProjectValues,
  type AudiPickLegacyProject as LegacyDashboardProject,
  type AudiPickLegacyProjectStatus,
} from "./AudiPickLegacyDashboard";
import { AudiPickLegacyProject } from "./AudiPickLegacyProject";
import { AudiPickLegacyContract } from "./AudiPickLegacyContract";
import {
  AudiPickLegacyLoanAudit,
  buildAudiPickLoanAuditModel,
} from "./AudiPickLegacyLoanAudit";
import { AudiPickLegacyTour } from "./AudiPickLegacyTour";
import { setSavedTheme } from "./theme";
import {
  AudiPickLegacyTemplates,
  type AudiPickLegacyTemplateTab,
} from "./AudiPickLegacyTemplates";
import {
  audipickExportName,
  buildClassifyPrompt,
  buildRevenueBatchPrompt,
  buildRevenueQuestionBatches,
  classifySample,
  extractionCacheKey,
  groupRevenueDetailQuestions,
  latestFieldSetId,
  latestRowsByDocumentAndRule,
  matchEvidenceDocument,
  mergeRevenueAnswers,
  missingRevenueTargets,
  pickClassifiedRule,
  revenueMissingQuestionFallback,
  revenuePromptForQuestions,
  revenueQuestionKey,
  splitContractText,
  withRetry,
  revenueFactPrompt,
  type ClassifiedDocument,
  type RevenueTargetQuestion,
} from "./audipickUi";

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
  /// Field set and timestamp of the extraction that produced this row; both are
  /// written on save and decide which rows the panel still shows.
  fieldSetId?: string;
  extractAt?: string;
  extractRunId?: string;
};
type AudiPickProjectData = {
  project: {
    id: string;
    name: string;
    client?: string;
    date?: string;
    status?: string;
    t?: string;
    createdAt?: string;
    updatedAt?: string;
    loanReportDate?: string;
    defaultRuleId?: string;
    relationGroups?: AudiPickRelation[];
  };
  contracts?: AudiPickContractMeta[];
  results?: AudiPickResult[];
};
type AudiPickContractMeta = {
  id: string;
  ruleId?: string;
  ruleConfirmed?: boolean;
  detectedRuleId?: string;
  detectedConfidence?: "high" | "medium" | "low" | string;
  detectedLabel?: string;
  isScanned?: boolean;
  ocrPending?: boolean;
  ocrCompletedPages?: number;
  ocrTotalPages?: number;
};
type AudiPickDocument = {
  id: string;
  name: string;
  path: string;
  sha256: string;
  size: number;
  status: string;
};

function parseSavedPdfPages(text: string): Map<number, string> {
  const pages = new Map<number, string>();
  const pattern = /---PDF第(\d+)页---\n([\s\S]*?)(?=---PDF第\d+页---\n|$)/g;
  for (const match of text.matchAll(pattern)) {
    pages.set(Number(match[1]), match[2].trimEnd());
  }
  return pages;
}

function serializePdfPages(pages: Map<number, string>): string {
  return [...pages.entries()]
    .sort(([left], [right]) => left - right)
    .map(([page, text]) => `---PDF第${page}页---\n${text}\n`)
    .join("");
}

const RESULT_SYSTEM_KEYS = new Set([
  "id",
  "contractId",
  "ruleId",
  "ruleVersion",
  "fieldKeys",
  "fieldSetId",
  "extractAt",
  "extractRunId",
]);

function editableResult(row: AudiPickResult): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !RESULT_SYSTEM_KEYS.has(key)),
  );
}

/**
 * AudiPick 的 PDF 引擎与规则脚本不再随 index.html 同步加载（那会拖慢每个工具
 * 的首屏），改由这层外壳在进入页面时注入。正文里到处是 `window.RuleEngine?.`
 * 这类全局读取，就绪之前渲染会读到空规则列表，所以加载完成前不挂载正文。
 */
export function AudiPickPage({ tool }: { tool: ToolManifest }) {
  const [ready, setReady] = useState(audipickAssetsReady());
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    void loadAudipickAssets()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [ready]);
  if (loadError) {
    return (
      <>
        <PageHeader
          eyebrow="合同审阅管理"
          title={tool.name}
          detail="本地 PDF 组件加载失败。"
        />
        <section className="form-card">
          <div className="error-box">{loadError}</div>
          <p>请重新进入本页面重试；若反复失败，请重装工具箱。</p>
        </section>
      </>
    );
  }
  if (!ready) {
    return (
      <>
        <PageHeader
          eyebrow="合同审阅管理"
          title={tool.name}
          detail="正在加载本地 PDF 引擎与审计模板库…"
        />
        <section className="form-card">
          <p>首次进入本页面需要加载本地 PDF 组件，请稍候。</p>
        </section>
      </>
    );
  }
  return <AudiPickPageInner tool={tool} />;
}

function AudiPickPageInner({ tool }: { tool: ToolManifest }) {
  const [projects, setProjects] = useState<AudiPickProjectData[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [documents, setDocuments] = useState<AudiPickDocument[]>([]);
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [projectDate, setProjectDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [defaultRuleId, setDefaultRuleId] = useState("loan_covenant");
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
  const [editingCustomRuleId, setEditingCustomRuleId] = useState("");
  // 模板库视图状态：分类 tab + 搜索词
  const [templateTab, setTemplateTab] = useState("all");
  const [templateSearch, setTemplateSearch] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [projectStatusFilter, setProjectStatusFilter] = useState("all");
  const [projectSort, setProjectSort] = useState("date_desc");
  const [projectDocumentCounts, setProjectDocumentCounts] = useState<
    Record<string, number>
  >({});
  const [documentTextLengths, setDocumentTextLengths] = useState<
    Record<string, number>
  >({});
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [pendingExtractDocumentId, setPendingExtractDocumentId] = useState("");
  const [customRulePrompt, setCustomRulePrompt] = useState("");
  const [ruleRevision, setRuleRevision] = useState(0);
  const [suggestedRule, setSuggestedRule] = useState<ClassifiedDocument>();
  const extractCache = useRef(
    new Map<string, Array<{ parsed?: { items?: unknown[] } }>>(),
  );
  const batchRulePlans = useRef(
    new Map<
      string,
      { ruleId: string; fieldKeys: string[]; fieldSetId: string }
    >(),
  );
  const revenueFacts = useRef(
    new Map<string, Array<Record<string, unknown>>>(),
  );
  const [batchJob, setBatchJob] = useState<JobEvent>();
  // 暂停开关与全局进度弹窗共用一份状态，避免两处各记各的对不上。
  const { isPaused: isJobPaused, togglePause: toggleJobPause } = useJobPause();
  const [pdfDocument, setPdfDocument] = useState<any>();
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPages, setPdfPages] = useState(0);
  const [pdfSearch, setPdfSearch] = useState("");
  const [pdfMatches, setPdfMatches] = useState<number[]>([]);
  const [pdfScale, setPdfScale] = useState(1.25);
  const [pdfRotation, setPdfRotation] = useState(0);
  const [ocrRequiredPages, setOcrRequiredPages] = useState<number[]>([]);
  const [selectedResultRunId, setSelectedResultRunId] = useState("latest");
  const [contractView, setContractView] = useState<"detail" | "workpaper">(
    "detail",
  );
  const [workpaperFilter, setWorkpaperFilter] = useState("");
  const [selectedWorkRowId, setSelectedWorkRowId] = useState("");
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewWidthPercent, setPreviewWidthPercent] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("ap_split_ratio"));
      return Number.isFinite(saved) && saved >= 25 && saved <= 65 ? saved : 42;
    } catch {
      return 42;
    }
  });
  const [editingResult, setEditingResult] = useState<AudiPickResult>();
  const [editingResultJson, setEditingResultJson] = useState("");
  const [configStatus, setConfigStatus] = useState<{
    llm?: { ready: boolean };
    ocr?: { ready: boolean; engine: string };
  }>({});
  // 顶层视图：工作台 / 提取模板库 / 处理工作日志
  const [viewMode, setViewMode] = useState<AudiPickLegacyPage>("home");
  const [logOpen, setLogOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [themeRevision, setThemeRevision] = useState(0);
  const [tourOpen, setTourOpen] = useState(false);
  const [loanAuditOpen, setLoanAuditOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem("ap_split_ratio", String(previewWidthPercent));
    } catch {
      /* The splitter still works when browser storage is unavailable. */
    }
  }, [previewWidthPercent]);
  // 处理工作日志（参考旧版 workLog：记录每步处理操作）
  type WorkLogEntry = {
    id: number;
    fileName: string;
    step: string;
    detail: string;
    status: "done" | "error" | "warn" | "info";
    time: string;
  };
  const [workLog, setWorkLog] = useState<WorkLogEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("audit-toolbox.audipick.log") ?? "[]");
    } catch {
      return [];
    }
  });
  const addLog = (
    fileName: string,
    step: string,
    detail: string,
    status: WorkLogEntry["status"] = "info",
  ) => {
    setWorkLog((current) => {
      const next: WorkLogEntry[] = [
        { id: Date.now(), fileName, step, detail, status, time: new Date().toLocaleTimeString() },
        ...current,
      ].slice(0, 100);
      try {
        localStorage.setItem("audit-toolbox.audipick.log", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const clearLog = () => {
    setWorkLog([]);
    try {
      localStorage.removeItem("audit-toolbox.audipick.log");
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    if (
      !selectedId ||
      viewMode !== "workbench" ||
      !("__TAURI_INTERNALS__" in window)
    )
      return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            void importDroppedPaths(event.payload.paths);
          }
        }),
      )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((dragError) => setError(errorText(dragError)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [selectedId, viewMode]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rules = useMemo(
    () => window.RuleEngine?.getAllSelectableRules() ?? [],
    [ruleRevision],
  );
  const fields = window.RuleEngine?.getFieldsForRule(ruleId) ?? [];
  const activeFieldKeys = selectedFieldKeys;
  const activeFieldSetId = `${ruleId}:${[...activeFieldKeys].sort().join("|")}`;
  const selected = projects.find((value) => value.project.id === selectedId);
  const documentResults = (selected?.results ?? []).filter(
    (row) => row.contractId === selectedDocument && row.ruleId === ruleId,
  );
  // Rows record the field set they were extracted with.  Pinning the view to
  // the *current* checkbox selection empties the panel whenever a rule gains or
  // loses a field, because every stored row then carries a stale id -- an
  // AudiPick rule update makes past extractions look lost even though they are
  // still in the database.  Legacy shows the newest field set recorded for this
  // contract and rule instead, so follow that and fall back to the current one
  // only when nothing has been extracted yet.
  const resultRuns = Object.values(
    documentResults.reduce<
      Record<string, { id: string; extractAt: string; rows: AudiPickResult[] }>
    >((runs, row) => {
      const id = row.extractRunId ?? `legacy:${row.fieldSetId ?? "default"}`;
      const run = runs[id] ?? { id, extractAt: "", rows: [] };
      run.rows.push(row);
      if (String(row.extractAt ?? "") > run.extractAt) {
        run.extractAt = String(row.extractAt ?? "");
      }
      runs[id] = run;
      return runs;
    }, {}),
  ).sort((left, right) => right.extractAt.localeCompare(left.extractAt));
  const activeResultRun =
    resultRuns.find((run) => run.id === selectedResultRunId) ?? resultRuns[0];
  const visibleFieldSetId =
    latestFieldSetId(activeResultRun?.rows ?? documentResults) ?? activeFieldSetId;
  const matchedResults = (activeResultRun?.rows ?? []).filter(
    (row) => !row.fieldSetId || row.fieldSetId === visibleFieldSetId,
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
  async function refreshConfigStatus() {
    try {
      const value = await engineCall("audipick.config_status", {});
      setConfigStatus(value as typeof configStatus);
    } catch {
      // The page remains usable for project management without configured AI.
    }
  }
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const value = (await engineCall("audipick.projects", {})) as {
        projects: AudiPickProjectData[];
      };
      setProjects(value.projects);
      setResult(value);
      void Promise.all(
        value.projects.map(async (project) => {
          const response = (await engineCall("audipick.documents", {
            projectId: project.project.id,
          })) as { documents?: AudiPickDocument[] };
          return [project.project.id, response.documents?.length ?? 0] as const;
        }),
      )
        .then((entries) => setProjectDocumentCounts(Object.fromEntries(entries)))
        .catch(() => undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
    void refreshConfigStatus();
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
      setDocumentTextLengths({});
      setSelectedDocumentIds([]);
      return;
    }
    void engineCall("audipick.documents", { projectId: selectedId })
      .then(async (value) => {
        const nextDocuments = (value as { documents: AudiPickDocument[] }).documents;
        setDocuments(nextDocuments);
        const lengths = await Promise.all(
          nextDocuments.map(async (document) => {
            const stored = (await engineCall("audipick.document_text", {
              documentId: document.id,
            })) as { text?: string };
            return [document.id, stored.text?.length ?? 0] as const;
          }),
        );
        setDocumentTextLengths(Object.fromEntries(lengths));
      })
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
    setSelectedResultRunId("latest");
    setEditingResult(undefined);
    setEditingResultJson("");
  }, [selectedDocument, ruleId]);
  useEffect(() => {
    if (
      !pendingExtractDocumentId ||
      selectedDocument !== pendingExtractDocumentId ||
      !pdfText.trim() ||
      busy
    )
      return;
    setPendingExtractDocumentId("");
    void extract().catch((cause) => {
      setError(errorText(cause));
    });
  }, [pendingExtractDocumentId, selectedDocument, pdfText, busy]);
  useEffect(() => {
    let off = () => {};
    void listenJobEvents((event) => {
      if (event.toolId !== "audipick") return;
      setBatchJob(event);
      if (event.result) setResult(event.result);
      if (event.phase === "completed" && event.result && selected) {
        const plan = batchRulePlans.current.get(event.jobId) ?? {
          ruleId,
          fieldKeys: activeFieldKeys,
          fieldSetId: activeFieldSetId,
        };
        const payload = event.result as {
          documents?: Array<{
            id: string;
            ok: boolean;
            parsed?: { items?: unknown[] };
          }>;
        };
        const completedAt = new Date().toISOString();
        const incoming = (payload.documents ?? []).flatMap((document) => {
          const extractRunId = `run_${Date.now().toString(36)}_${document.id}`;
          return document.ok && Array.isArray(document.parsed?.items)
            ? document.parsed.items
                .filter((item): item is Record<string, unknown> =>
                  Boolean(item && typeof item === "object"),
                )
                .map((item, index) => ({
                  ...item,
                  id: `r_${Date.now().toString(36)}_${document.id}_${index}`,
                  contractId: document.id,
                  ruleId: plan.ruleId,
                  fieldKeys: plan.fieldKeys,
                  fieldSetId: plan.fieldSetId,
                  extractAt: completedAt,
                  extractRunId,
                  reviewed: false,
                }))
            : [];
        });
        setProjects((current) => {
          const target = current.find(
            (project) => project.project.id === selectedId,
          );
          if (!target) return current;
          const saved = {
            ...target,
            project: {
              ...target.project,
              updatedAt: completedAt,
            },
            results: [...(target.results ?? []), ...incoming],
          };
          void engineCall("audipick.project_save", saved).catch((saveError) =>
            setError(errorText(saveError)),
          );
          return current.map((project) =>
            project.project.id === selectedId ? saved : project,
          );
        });
        batchRulePlans.current.delete(event.jobId);
      }
    }).then((value) => {
      off = value;
    });
    return () => off();
  }, [selectedId, ruleId, selected, fields]);
  async function create(values?: AudiPickLegacyCreateProjectValues) {
    const nextName = values?.name ?? name;
    const nextClient = values?.client ?? client;
    const nextDate = values?.date ?? projectDate;
    const nextDefaultRuleId = values?.defaultTemplateId ?? defaultRuleId;
    if (!nextName.trim()) {
      setError("请输入项目名称。");
      return;
    }
    const id = `p_${Date.now().toString(36)}`;
    const createdAt = new Date().toISOString();
    const data: AudiPickProjectData = {
      project: {
        id,
        name: nextName.trim(),
        client: nextClient.trim(),
        date: nextDate,
        status: "active",
        defaultRuleId: nextDefaultRuleId,
        t: createdAt,
        createdAt,
        updatedAt: createdAt,
      },
      contracts: [],
      results: [],
    };
    setBusy(true);
    try {
      await engineCall("audipick.project_save", data);
      setName("");
      setClient("");
      setProjectDate(new Date().toISOString().slice(0, 10));
      if (!values) {
        setSelectedId(id);
        setRuleId(nextDefaultRuleId);
      } else {
        setSelectedId("");
      }
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(projectId = selectedId) {
    if (!projectId) return;
    // Deleting a project also drops every PDF, extraction result and review
    // mark under it, and there is no undo.
    const project = projects.find((item) => item.project.id === projectId);
    if (
      !window.confirm(
        `确认删除项目"${project?.project.name ?? projectId}"？\n\n该项目下的全部合同 PDF、提取结果和复核标记会一并删除，且无法恢复。`,
      )
    )
      return;
    setBusy(true);
    try {
      await engineCall("audipick.project_delete", { id: projectId });
      if (selectedId === projectId) setSelectedId("");
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function updateProjectStatus(
    status: string,
    target: AudiPickProjectData | undefined = selected,
  ) {
    if (!target) return;
    const saved: AudiPickProjectData = {
      ...target,
      project: { ...target.project, status },
    };
    setBusy(true);
    try {
      await engineCall("audipick.project_save", saved);
      setProjects((current) =>
        current.map((project) =>
          project.project.id === target.project.id ? saved : project,
        ),
      );
      addLog(target.project.name, "项目状态", status === "completed" ? "已完成" : "进行中", "done");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function updateLoanReportDate(reportDate: string) {
    if (!selected) return;
    const saved: AudiPickProjectData = {
      ...selected,
      project: {
        ...selected.project,
        loanReportDate: reportDate,
        updatedAt: new Date().toISOString(),
      },
    };
    try {
      await engineCall("audipick.project_save", saved);
      setProjects((current) =>
        current.map((project) =>
          project.project.id === selected.project.id ? saved : project,
        ),
      );
    } catch (e) {
      setError(errorText(e));
    }
  }
  function getContractMeta(documentId: string): AudiPickContractMeta {
    return selected?.contracts?.find((item) => item.id === documentId) ?? {
      id: documentId,
    };
  }
  async function saveContractMeta(
    documentId: string,
    patch: Partial<AudiPickContractMeta>,
  ) {
    if (!selected) return;
    const existing = selected.contracts ?? [];
    const current = existing.find((item) => item.id === documentId) ?? {
      id: documentId,
    };
    const contracts = [
      ...existing.filter((item) => item.id !== documentId),
      { ...current, ...patch, id: documentId },
    ];
    const saved: AudiPickProjectData = {
      ...selected,
      project: { ...selected.project, updatedAt: new Date().toISOString() },
      contracts,
    };
    await engineCall("audipick.project_save", saved);
    setProjects((items) =>
      items.map((item) =>
        item.project.id === selected.project.id ? saved : item,
      ),
    );
  }
  async function removeAssociation(anchorId: string, fileId: string) {
    if (!selected) return;
    const relationGroups = (selected.project.relationGroups ?? [])
      .map((group) =>
        group.anchorFileId === anchorId
          ? {
              ...group,
              members: group.members.filter((member) => member.fileId !== fileId),
            }
          : group,
      )
      .filter((group) => group.members.length > 0);
    const saved: AudiPickProjectData = {
      ...selected,
      project: {
        ...selected.project,
        relationGroups,
        updatedAt: new Date().toISOString(),
      },
    };
    await engineCall("audipick.project_save", saved);
    setProjects((items) =>
      items.map((item) =>
        item.project.id === selected.project.id ? saved : item,
      ),
    );
  }
  async function exportBackup() {
    const outputPath = await pickPath(
      "save",
      "导出 AudiPick 迁移备份",
      ["zip"],
      audipickExportName(
        {
          projectName: selected?.project.name,
          clientName: selected?.project.client,
          typeLabel: "AudiPick迁移备份",
        },
        "zip",
      ),
    );
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
      for (const path of paths) {
        await engineCall("audipick.document_import", {
          projectId: selectedId,
          path,
        });
        addLog(path.split(/[\\/]/).pop() ?? path, "导入", "PDF 文件已导入", "done");
      }
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
  async function importDroppedPaths(paths: string[]) {
    if (!selectedId || !paths.length) return;
    setBusy(true);
    setError("");
    try {
      let importedCount = 0;
      let skippedCount = 0;
      for (const path of paths) {
        if (/\.pdf$/i.test(path)) {
          await engineCall("audipick.document_import", {
            projectId: selectedId,
            path,
          });
          importedCount += 1;
        } else {
          const imported = (await engineCall(
            "audipick.document_import_folder",
            { projectId: selectedId, path },
          )) as { imported?: number; skipped?: number };
          importedCount += imported.imported ?? 0;
          skippedCount += imported.skipped ?? 0;
        }
      }
      const value = (await engineCall("audipick.documents", {
        projectId: selectedId,
      })) as { documents: AudiPickDocument[] };
      setDocuments(value.documents);
      setProjectDocumentCounts((current) => ({
        ...current,
        [selectedId]: value.documents.length,
      }));
      addLog(
        `${paths.length} 个拖放项目`,
        "拖放导入",
        `已导入 ${importedCount} 份 PDF${skippedCount ? `，跳过 ${skippedCount} 份` : ""}`,
        "done",
      );
      setResult({ imported: importedCount, skipped: skippedCount });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function importPdfFolder() {
    if (!selectedId) {
      setError("请先选择项目。");
      return;
    }
    const path = await pickPath("folder", "选择包含合同 PDF 的文件夹");
    if (typeof path !== "string") return;
    setBusy(true);
    setError("");
    try {
      const imported = (await engineCall("audipick.document_import_folder", {
        projectId: selectedId,
        path,
      })) as { imported?: number; skipped?: number };
      const value = (await engineCall("audipick.documents", {
        projectId: selectedId,
      })) as { documents: AudiPickDocument[] };
      setDocuments(value.documents);
      setProjectDocumentCounts((current) => ({
        ...current,
        [selectedId]: value.documents.length,
      }));
      addLog(
        path.split(/[\\/]/).pop() ?? path,
        "文件夹导入",
        `已导入 ${imported.imported ?? 0} 份 PDF${imported.skipped ? `，跳过 ${imported.skipped} 份` : ""}`,
        "done",
      );
      setResult(imported);
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
        `确认删除"${document?.name ?? documentId}"？\n\n该文件的 PDF、已保存的文字层和提取结果会一并删除，且无法恢复。`,
      )
    )
      return;
    setBusy(true);
    try {
      await engineCall("audipick.document_delete", { documentId });
      if (selected) {
        const relationGroups = (selected.project.relationGroups ?? [])
          .filter((group) => group.anchorFileId !== documentId)
          .map((group) => ({
            ...group,
            members: group.members.filter(
              (member) => member.fileId !== documentId,
            ),
          }))
          .filter((group) => group.members.length > 0);
        const saved: AudiPickProjectData = {
          ...selected,
          project: {
            ...selected.project,
            relationGroups,
            updatedAt: new Date().toISOString(),
          },
          contracts: (selected.contracts ?? []).filter(
            (item) => item.id !== documentId,
          ),
          results: (selected.results ?? []).filter(
            (row) => row.contractId !== documentId,
          ),
        };
        await engineCall("audipick.project_save", saved);
        setProjects((items) =>
          items.map((item) =>
            item.project.id === selected.project.id ? saved : item,
          ),
        );
      }
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
    setPdfText("");
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
      addLog(
        documents.find((d) => d.id === id)?.name ?? "文档",
        "打开",
        `已加载 PDF，共 ${pdf.numPages} 页`,
        "done",
      );
      const stored = (await engineCall("audipick.document_text", {
        documentId: id,
      })) as { text?: string };
      const savedPages = parseSavedPdfPages(stored.text ?? "");
      const pageTexts = new Map<number, string>();
      let ocrPages = 0;
      let resumedPages = 0;
      const unreadablePages: number[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let pageText = content.items
          .map((item: { str?: string }) => item.str ?? "")
          .join(" ");
        const cachedText = savedPages.get(number)?.trim() ?? "";
        if (
          pageText.trim().length < 60 &&
          cachedText.length >= 60 &&
          !cachedText.includes("需要先配置 OCR")
        ) {
          pageText = cachedText;
          resumedPages += 1;
        } else if (pageText.trim().length < 60 && configStatus.ocr?.ready) {
          await saveContractMeta(id, {
            ocrPending: true,
            ocrCompletedPages: number - 1,
            ocrTotalPages: pdf.numPages,
          });
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
          savedPages.set(number, pageText);
          await engineCall("audipick.document_text_save", {
            documentId: id,
            text: serializePdfPages(savedPages),
          });
          await saveContractMeta(id, {
            ocrPending: number < pdf.numPages,
            ocrCompletedPages: number,
            ocrTotalPages: pdf.numPages,
          });
        } else if (pageText.trim().length < 60) {
          unreadablePages.push(number);
          pageText = "【本页文字层过少，需要先配置 OCR 后识别】";
        }
        pageTexts.set(number, pageText);
      }
      const text = serializePdfPages(pageTexts);
      if (!unreadablePages.length) {
        await engineCall("audipick.document_text_save", {
          documentId: id,
          text,
        });
      }
      await renderPdfPage(
        pdf,
        Math.min(pdf.numPages, Math.max(1, startPage)),
        "",
        pdfScale,
        pdfRotation,
      );
      setPdfText(text);
      setDocumentTextLengths((current) => ({ ...current, [id]: text.length }));
      setOcrRequiredPages(unreadablePages);
      const isScanned = ocrPages > 0 || resumedPages > 0;
      await saveContractMeta(id, {
        isScanned,
        ocrPending: false,
        ocrCompletedPages: pdf.numPages,
        ocrTotalPages: pdf.numPages,
      });
      setResult({
        documentId: id,
        pages: pdf.numPages,
        textLength: text.length,
        ocrPages,
        resumedPages,
        scanned: isScanned,
      });
      if (unreadablePages.length) {
        setError(
          `第 ${unreadablePages.join("、")} 页需要 OCR，但当前 OCR 未就绪。请到工具箱设置完成配置后重新读取文档。`,
        );
      } else {
        void suggestRule(id, text);
      }
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
      await saveContractMeta(documentId, {
        ruleId: picked.ruleId,
        detectedRuleId: picked.ruleId,
        detectedConfidence: picked.confidence,
        detectedLabel: picked.docLabel,
        ruleConfirmed: picked.confidence === "high",
      });
      setRuleId(picked.ruleId);
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
  async function jumpPdfMatch(offset: -1 | 1) {
    if (!pdfDocument || !pdfMatches.length) return;
    const currentIndex = pdfMatches.indexOf(pdfPage);
    const nextIndex =
      currentIndex < 0
        ? offset > 0
          ? 0
          : pdfMatches.length - 1
        : (currentIndex + offset + pdfMatches.length) % pdfMatches.length;
    await renderPdfPage(pdfDocument, pdfMatches[nextIndex], pdfSearch);
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
      const pages = parseSavedPdfPages(pdfText);
      pages.set(pdfPage, value.text);
      const nextText = serializePdfPages(pages);
      setPdfText(nextText);
      setDocumentTextLengths((current) => ({
        ...current,
        [selectedDocument]: nextText.length,
      }));
      await engineCall("audipick.document_text_save", {
        documentId: selectedDocument,
        text: nextText,
      });
      setResult(value);
      setOcrRequiredPages((current) => current.filter((page) => page !== pdfPage));
      addLog("当前文档", "OCR", `${value.engine} 引擎识别完成`, "done");
    } catch (e) {
      addLog("当前文档", "OCR", "识别失败", "error");
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
      setDocumentTextLengths((current) => ({
        ...current,
        [selectedDocument]: pdfText.length,
      }));
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
    const previousGroups = selected.project.relationGroups ?? [];
    const currentGroup = previousGroups.find(
      (group) => group.anchorFileId === selectedDocument,
    );
    const nextGroup = {
      id: currentGroup?.id ?? `g_${Date.now().toString(36)}`,
      anchorFileId: selectedDocument,
      members: [
        ...(currentGroup?.members ?? []).filter(
          (member) => member.fileId !== associationTarget,
        ),
        { fileId: associationTarget, role: associationRole },
      ],
    };
    const groups = [
      ...previousGroups.filter(
        (group) => group.anchorFileId !== selectedDocument,
      ),
      nextGroup,
    ];
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
  async function persistCustomRules() {
    const allSettings = await settingsGet();
    const current = (allSettings.audipick ?? {}) as Record<string, unknown>;
    await settingsSet({
      audipick: {
        ...current,
        customRules: window.RuleEngine?.getCustomRules() ?? [],
      },
    });
  }
  async function saveCustomRule() {
    if (!customRuleName.trim() || !customRulePrompt.includes("【字段定义】")) {
      setError("自定义模板需要名称，并且提示词必须包含【字段定义】。");
      return;
    }
    const created = editingCustomRuleId
      ? undefined
      : window.RuleEngine?.createBlankCustomRule(
          customRuleName.trim(),
          "contract",
        );
    const id = editingCustomRuleId || String(created?.id ?? "");
    window.RuleEngine?.updateCustomRule(id, {
      name: customRuleName.trim(),
      shortName: customRuleName.trim(),
      prompt: customRulePrompt,
      description: "用户自定义审计提取模板",
    });
    window.RuleEngine?.resetFieldsCache(id);
    await persistCustomRules();
    setCustomRuleName("");
    setCustomRulePrompt("");
    setEditingCustomRuleId("");
    setRuleRevision((value) => value + 1);
    setRuleId(id);
    setResult({ customRuleSaved: true, id });
  }
  async function copySelectedRule() {
    const current = rules.find((rule) => rule.id === ruleId);
    if (!current) return;
    const created = window.RuleEngine?.copyBuiltinAsCustom?.(
      ruleId,
      `${current.name}（我的模板）`,
    );
    if (!created) return;
    await persistCustomRules();
    const id = String(created.id ?? "");
    setRuleRevision((value) => value + 1);
    setRuleId(id);
    setTemplateTab("mine");
    setEditingCustomRuleId(id);
    setCustomRuleName(String(created.name ?? ""));
    setCustomRulePrompt(String(created.prompt ?? ""));
  }
  function editSelectedRule() {
    const current = rules.find((rule) => rule.id === ruleId) as
      | (typeof rules)[number] & { prompt?: string }
      | undefined;
    if (!current || current.readonly !== false) return;
    setEditingCustomRuleId(current.id);
    setCustomRuleName(current.name);
    setCustomRulePrompt(
      current.prompt ?? window.RuleEngine?.getRulePrompt(current.id) ?? "",
    );
  }
  async function deleteSelectedRule() {
    const current = rules.find((rule) => rule.id === ruleId);
    if (!current || current.readonly !== false) return;
    if (!window.confirm(`确认删除模板“${current.name}”？已有提取结果不会删除。`))
      return;
    window.RuleEngine?.deleteCustomRule(current.id);
    await persistCustomRules();
    const next = rules.find((rule) => rule.readonly !== false)?.id ?? "loan_covenant";
    setRuleId(next);
    setEditingCustomRuleId("");
    setCustomRuleName("");
    setCustomRulePrompt("");
    setRuleRevision((value) => value + 1);
  }
  async function createLegacyRule(input: {
    name: string;
    docKind: "contract" | "table";
  }) {
    const created = window.RuleEngine?.createBlankCustomRule(
      input.name,
      input.docKind,
    );
    if (!created) return;
    await persistCustomRules();
    setRuleRevision((value) => value + 1);
    setRuleId(String(created.id));
    setTemplateTab("mine");
  }
  async function copyLegacyRule(input: {
    sourceRuleId: string;
    name: string;
  }) {
    const created = window.RuleEngine?.copyBuiltinAsCustom?.(
      input.sourceRuleId,
      input.name,
    );
    if (!created) return;
    await persistCustomRules();
    setRuleRevision((value) => value + 1);
    setRuleId(String(created.id));
    setTemplateTab("mine");
  }
  async function saveLegacyRulePrompt(targetRuleId: string, prompt: string) {
    window.RuleEngine?.updateCustomRule(targetRuleId, { prompt });
    window.RuleEngine?.resetFieldsCache(targetRuleId);
    await persistCustomRules();
    setRuleRevision((value) => value + 1);
  }
  async function deleteLegacyRule(targetRuleId: string) {
    const target = rules.find((item) => item.id === targetRuleId);
    if (!target || target.readonly !== false) return;
    if (!window.confirm(`确认删除模板“${target.name}”？已有提取结果不会删除。`)) return;
    window.RuleEngine?.deleteCustomRule(targetRuleId);
    await persistCustomRules();
    setRuleId(rules.find((item) => item.readonly !== false)?.id ?? "loan_covenant");
    setEditingCustomRuleId("");
    setRuleRevision((value) => value + 1);
  }
  /// Persist one extraction run's items against the current contract/template.
  async function saveExtractedItems(items: Array<Record<string, unknown>>) {
    if (!selected) return;
    const extractAt = new Date().toISOString();
    const extractRunId = `run_${Date.now().toString(36)}`;
    const saved = {
      ...selected,
      results: [
        ...(selected.results ?? []),
        ...items.map((item, index) => ({
          ...item,
          id: `r_${extractRunId}_${index}`,
          contractId: selectedDocument,
          ruleId,
          ruleVersion:
            rules.find((rule) => rule.id === ruleId)?.version ?? "1.0",
          fieldKeys: activeFieldKeys,
          fieldSetId: activeFieldSetId,
          extractAt,
          extractRunId,
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
    setSelectedResultRunId(extractRunId);
  }

  /// Two-pass extraction for the revenue workpaper.
  ///
  /// The workpaper asks dozens of questions across a bundle of documents (the
  /// rule bundle owns the exact list, so it grows between AudiPick releases).
  /// Sending all
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
          const value = await askOnce(revenueFactPrompt(), chunk);
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
    const itemsOf = (value: { parsed?: Record<string, unknown> }) =>
      Array.isArray((value.parsed as any)?.items)
        ? ((value.parsed as any).items as Array<Record<string, unknown>>)
        : [];
    const normalize = (list: Array<Record<string, unknown>>) =>
      typeof rules?.normalizeResults === "function"
        ? (rules.normalizeResults(list) as Array<Record<string, unknown>>)
        : list;
    const withSharedFacts = (list: Array<Record<string, unknown>>) =>
      typeof rules?.applySharedFacts === "function"
        ? (rules.applySharedFacts(list, facts) as Array<Record<string, unknown>>)
        : list;
    // The follow-up rounds answer against the shared fact table rather than the
    // contract text: the facts already carry their source file and pages, and
    // re-sending a whole bundle to ask a handful of questions is what makes a
    // long resolution round overrun the request budget.
    let factText = `【同一合同资料包的共享事实表】\n所有底稿问题必须共同使用以下事实；不得说已列示的事实未明确。\n${JSON.stringify({ facts })}`;
    if (factText.length > 70_000)
      factText = `${factText.slice(0, 70_000)}\n【事实表已按长度截断】`;

    /// Ask one group of questions, then chase whatever the model left out.
    ///
    /// A skipped question used to leave a hole in the workpaper that nothing
    /// reported, so misses are retried in small groups and anything still
    /// absent becomes an explicit placeholder row marked for manual review.
    const answerGroup = async (targets: RevenueTargetQuestion[]) => {
      let answered = normalize(
        itemsOf(
          await askOnce(revenuePromptForQuestions(prompt, targets), factText),
        ),
      );
      const missed = missingRevenueTargets(answered, targets);
      for (let index = 0; index < missed.length; index += 3) {
        try {
          answered = normalize([
            ...answered,
            ...itemsOf(
              await askOnce(
                revenuePromptForQuestions(
                  prompt,
                  missed.slice(index, index + 3),
                ),
                factText,
              ),
            ),
          ]);
        } catch {
          // Keep the batch: the placeholder pass below records what never came.
        }
      }
      const stillMissing = missingRevenueTargets(answered, targets);
      return stillMissing.length
        ? normalize([
            ...answered,
            ...stillMissing.map(revenueMissingQuestionFallback),
          ])
        : answered;
    };

    /// Step 5a asks its timing question once per performance obligation, which
    /// only becomes answerable once the main pass has identified them.
    const answerPoTiming = async (current: Array<Record<string, unknown>>) => {
      const targets =
        typeof rules?.buildPerformanceObligationTimingQuestions === "function"
          ? (rules.buildPerformanceObligationTimingQuestions(
              current,
            ) as RevenueTargetQuestion[])
          : [];
      if (!targets.length) return current;
      setError(`已锁定 ${targets.length} 项履约义务，正在逐项判断收入确认时段/时点…`);
      const answered = await answerGroup(targets);
      // The generic 5.1 row is superseded by the per-obligation answers.
      const kept = current.filter(
        (item) =>
          !(
            String(item.question_no ?? "").trim() === "5.1" &&
            /第5a步（PO#\d+）/.test(String(item.workpaper_sheet ?? ""))
          ),
      );
      return withSharedFacts(normalize([...kept, ...answered]));
    };

    /// An appendix answer can trigger further appendix questions, so keep going
    /// until a round produces none.  The cap stops answers that contradict each
    /// other from looping forever.
    const answerTriggeredAppendix = async (
      current: Array<Record<string, unknown>>,
      round: number,
    ): Promise<Array<Record<string, unknown>>> => {
      const normalized = normalize(current);
      const targets =
        typeof rules?.buildTriggeredDetailQuestions === "function"
          ? (rules.buildTriggeredDetailQuestions(
              normalized,
            ) as RevenueTargetQuestion[])
          : [];
      if (!targets.length) return normalized;
      if (round >= 8)
        throw new Error(
          "附表条件问题超过最大展开层级，请检查附表回答是否存在循环或冲突",
        );
      const groups = groupRevenueDetailQuestions(targets);
      const collected: Array<Record<string, unknown>> = [];
      for (const [index, group] of groups.entries()) {
        setError(
          `正在按底稿跳转回答附表第 ${round + 1} 轮：${index + 1}/${groups.length}（本轮共 ${targets.length} 个问题）…`,
        );
        collected.push(...(await answerGroup(group)));
      }
      return answerTriggeredAppendix([...normalized, ...collected], round + 1);
    };

    /// Obligations that transfer control the same way must reach the same
    /// answer; this pass re-asks the ones that disagree so the workpaper does
    /// not ship a contradiction for the reviewer to find.
    const reviewPoConsistency = async (
      current: Array<Record<string, unknown>>,
    ) => {
      const normalized = normalize(current);
      const targets =
        typeof rules?.buildPoConsistencyReviewQuestions === "function"
          ? (rules.buildPoConsistencyReviewQuestions(
              normalized,
            ) as RevenueTargetQuestion[])
          : [];
      if (!targets.length) return normalized;
      setError("检测到同类履约义务答案不一致，正在按相同指标统一复核…");
      const reviewed: Array<Record<string, unknown>> = [];
      for (const group of groupRevenueDetailQuestions(targets))
        reviewed.push(...(await answerGroup(group)));
      const replaced = new Set(reviewed.map(revenueQuestionKey));
      return normalize([
        ...normalized.filter((item) => !replaced.has(revenueQuestionKey(item))),
        ...reviewed,
      ]);
    };

    const merged = mergeRevenueAnswers(responses.flatMap(itemsOf));
    let items = withSharedFacts(normalize(merged));
    const mainAnswers = items.length;
    items = await answerPoTiming(items);
    items = await answerTriggeredAppendix(items, 0);
    items = await reviewPoConsistency(items);
    const withFacts = withSharedFacts(normalize(items));
    setError("");
    await saveExtractedItems(withFacts);
    setResult({
      items: withFacts.length,
      questions: questions.length,
      facts: facts.length,
      // Rows beyond the main pass come from the per-obligation and appendix
      // rounds, so surface them instead of leaving the count unexplained.
      followUpItems: Math.max(0, withFacts.length - mainAnswers),
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
      addLog(
        documents.find((d) => d.id === selectedDocument)?.name ?? "文档",
        "AI 提取",
        `提取 ${items.length} 条，分 ${chunks.length} 段处理`,
        "done",
      );
    } catch (e) {
      addLog(
        documents.find((d) => d.id === selectedDocument)?.name ?? "文档",
        "AI 提取",
        "提取失败",
        "error",
      );
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
      // The second pass answers the workpaper questions and does not restate
      // the general contract information, so without this the five 第1部分
      // rows are dropped from the reviewed checklist.  Legacy folds them back
      // in from the pre-review answers.
      if (
        typeof (window.RevenueWorkpaper as any)?.preserveGeneralInformation ===
        "function"
      )
        items = (window.RevenueWorkpaper as any).preserveGeneralInformation(
          currentResults,
          items,
        );
      if (selected) {
        const extractAt = new Date().toISOString();
        const extractRunId = `run_deep_${Date.now().toString(36)}`;
        const saved = {
          ...selected,
          results: [
            ...(selected.results ?? []),
            ...items.map((item, index) => ({
              ...item,
              id: `r_${extractRunId}_${index}`,
              contractId: selectedDocument,
              ruleId,
              fieldKeys: activeFieldKeys,
              fieldSetId: activeFieldSetId,
              extractAt,
              extractRunId,
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
        setSelectedResultRunId(extractRunId);
        setResult({ deepReview: true, rows: items.length });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function startBatch(documentIds = documents.map((document) => document.id)) {
    const targetDocuments = documents.filter((document) =>
      documentIds.includes(document.id),
    );
    if (!targetDocuments.length) {
      setError("项目中没有可提取的 PDF。");
      return;
    }
    setError("");
    try {
      const textStates = await Promise.all(
        targetDocuments.map(async (document) => {
          const value = (await engineCall("audipick.document_text", {
            documentId: document.id,
          })) as { text?: string };
          return { document, ready: Boolean(value.text?.trim()) };
        }),
      );
      const missing = textStates.filter((item) => !item.ready);
      if (missing.length) {
        setError(
          `以下 ${missing.length} 份文件尚未生成文字层，请先逐份点击“读取/预览”（扫描件会自动 OCR 并续存进度）：${missing
            .slice(0, 6)
            .map((item) => item.document.name)
            .join("、")}${missing.length > 6 ? "等" : ""}`,
        );
        return;
      }
      const groups = new Map<string, AudiPickDocument[]>();
      for (const document of targetDocuments) {
        const documentRuleId =
          getContractMeta(document.id).ruleId ??
          selected?.project.defaultRuleId ??
          ruleId;
        groups.set(documentRuleId, [
          ...(groups.get(documentRuleId) ?? []),
          document,
        ]);
      }
      for (const [groupRuleId, groupDocuments] of groups) {
        const groupFieldKeys = (
          window.RuleEngine?.getFieldsForRule(groupRuleId) ?? []
        ).map((field) => field.key);
        const groupFieldSetId = `${groupRuleId}:${[...groupFieldKeys]
          .sort()
          .join("|")}`;
        const prompt = `${window.RuleEngine?.getRulePrompt(groupRuleId) ?? ""}\n\n本次仅返回这些字段：${groupFieldKeys.join(", ")}`;
        const jobId = await jobStart("audipick.batch_extract", {
          ruleId: groupRuleId,
          fieldSetId: groupFieldSetId,
          fieldKeys: groupFieldKeys,
          prompt,
          documents: groupDocuments.map((document) => ({
            id: document.id,
            name: document.name,
          })),
        });
        batchRulePlans.current.set(jobId, {
          ruleId: groupRuleId,
          fieldKeys: groupFieldKeys,
          fieldSetId: groupFieldSetId,
        });
        addLog(
          `${groupDocuments.length} 份文档`,
          "批量提取",
          `按「${rules.find((candidate) => candidate.id === groupRuleId)?.name ?? groupRuleId}」模板启动`,
          "info",
        );
        setBatchJob({
          jobId,
          toolId: "audipick",
          phase: "queued",
          current: 0,
          total: groupDocuments.length,
          message:
            groups.size > 1
              ? `已按单文件模板拆分为 ${groups.size} 个批次`
              : "批量任务已进入队列",
          severity: "info",
          outputPaths: [],
        });
      }
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
  function updateResultField(rowId: string, key: string, value: string) {
    setProjects((current) =>
      current.map((project) =>
        project.project.id === selectedId
          ? {
              ...project,
              results: (project.results ?? []).map((row) =>
                String(row.id) === rowId ? { ...row, [key]: value } : row,
              ),
            }
          : project,
      ),
    );
  }
  async function saveResultRow() {
    const latest = projects.find((project) => project.project.id === selectedId);
    if (!latest) return;
    await engineCall("audipick.project_save", latest);
    setResult({ resultSaved: true });
  }
  async function copyResultRow(rowId: string) {
    const row = currentResults.find((item) => String(item.id) === rowId);
    if (!row) return;
    await navigator.clipboard.writeText(
      JSON.stringify(editableResult(row), null, 2),
    );
  }
  function beginEditResult(row: AudiPickResult) {
    setEditingResult(row);
    setEditingResultJson(JSON.stringify(editableResult(row), null, 2));
  }
  async function saveEditedResult() {
    if (!selected || !editingResult) return;
    let fields: unknown;
    try {
      fields = JSON.parse(editingResultJson);
    } catch {
      setError("结果内容不是有效的 JSON，请检查逗号、引号和括号。");
      return;
    }
    if (!fields || Array.isArray(fields) || typeof fields !== "object") {
      setError("结果内容必须是一个 JSON 对象。");
      return;
    }
    const saved = {
      ...selected,
      results: (selected.results ?? []).map((row) =>
        row === editingResult ||
        (editingResult.id && row.id === editingResult.id)
          ? {
              ...row,
              ...(fields as Record<string, unknown>),
              id: row.id,
              contractId: row.contractId,
              ruleId: row.ruleId,
              ruleVersion: row.ruleVersion,
              fieldKeys: row.fieldKeys,
              fieldSetId: row.fieldSetId,
              extractAt: row.extractAt,
              extractRunId: row.extractRunId,
            }
          : row,
      ),
    };
    setBusy(true);
    setError("");
    try {
      await engineCall("audipick.project_save", saved);
      setProjects((current) =>
        current.map((project) =>
          project.project.id === selectedId ? saved : project,
        ),
      );
      setEditingResult(undefined);
      setEditingResultJson("");
      addLog(
        documents.find((item) => item.id === selectedDocument)?.name ?? "文档",
        "结果修订",
        "已保存人工修改，历史提取版本仍保留",
        "done",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function exportResults() {
    const rows = currentResults;
    if (!rows.length) {
      setError("当前合同和模板还没有提取结果。");
      return;
    }
    const typeLabel =
      ruleId === "revenue_workpaper"
        ? "收入底稿填列清单"
        : (rules.find((rule) => rule.id === ruleId)?.shortName ??
          rules.find((rule) => rule.id === ruleId)?.name ??
          "底稿");
    const output = await pickPath(
      "save",
      ruleId === "revenue_workpaper"
        ? "保存收入底稿填列清单"
        : "保存 AudiPick 底稿",
      ["xlsx"],
      audipickExportName({
        fileName: documents.find((item) => item.id === selectedDocument)?.name,
        projectName: selected?.project.name,
        clientName: selected?.project.client,
        typeLabel,
      }),
    );
    if (typeof output !== "string") return;
    setBusy(true);
    try {
      // The revenue rules build the legacy checklist, including which
      // worksheet, row and D/E/F cell each answer belongs in.  Exporting the raw
      // result keys instead left the user to locate every question by hand.
      // Columns come from the rows themselves, so a rule update that adds one
      // (1.4.6 added 底稿章节) flows through without touching this page.
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
  async function exportProjectResults(scope: "project" | "document" = "project") {
    if (!selected) return;
    const source = latestRowsByDocumentAndRule(
      (selected.results ?? []).filter(
        (row) => scope === "project" || row.contractId === selectedDocument,
      ),
    );
    if (!source.length) {
      setError(scope === "project" ? "当前项目还没有提取结果。" : "当前文件还没有提取结果。");
      return;
    }
    const grouped = new Map<string, AudiPickResult[]>();
    for (const row of source) {
      const key = String(row.ruleId ?? "未分类");
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    const sheets = [...grouped.entries()].map(([sheetRuleId, rows]) => {
      const exportedRows = rows.map((row) => ({
        文件名称:
          documents.find((document) => document.id === row.contractId)?.name ??
          String(row.contractId ?? ""),
        ...editableResult(row),
      }));
      const columns = [
        "文件名称",
        ...new Set(exportedRows.flatMap((row) => Object.keys(row))),
      ].filter((key, index, all) => all.indexOf(key) === index);
      return {
        name:
          rules.find((candidate) => candidate.id === sheetRuleId)?.shortName ??
          rules.find((candidate) => candidate.id === sheetRuleId)?.name ??
          sheetRuleId,
        rows: exportedRows,
        columns,
      };
    });
    const outputPath = await pickPath(
      "save",
      scope === "project" ? "导出项目全部结果" : "导出当前文件全部模板结果",
      ["xlsx"],
      audipickExportName({
        projectName: selected.project.name,
        clientName: selected.project.client,
        fileName:
          scope === "document"
            ? documents.find((item) => item.id === selectedDocument)?.name
            : undefined,
        typeLabel: scope === "project" ? "项目提取结果" : "文件提取结果",
      }),
    );
    if (typeof outputPath !== "string") return;
    setBusy(true);
    setError("");
    try {
      setResult(
        await engineCall("audipick.export_bundle", { outputPath, sheets }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function exportLoanAudit() {
    if (!selected) return;
    const model = buildAudiPickLoanAuditModel({
      project: selected.project,
      contracts: documents.map((document) => {
        const meta = getContractMeta(document.id);
        return {
          id: document.id,
          name: document.name,
          file: document.path,
          ruleId: meta.ruleId,
          detectedRuleId: meta.detectedRuleId,
        };
      }),
      results: selected.results ?? [],
      relationGroups: selected.project.relationGroups ?? [],
      reportDate:
        selected.project.loanReportDate ?? selected.project.date ?? "",
    });
    if (!model.debts.length) {
      setError("当前项目还没有可汇总的借款合同提取结果。");
      return;
    }
    const asText = (value: unknown) =>
      value === null || value === undefined ? "" : String(value);
    const dashboardRows = [
      { 指标: "报告日", 结果: model.reportDate },
      { 指标: "独立债项数", 结果: model.counts.debtCount },
      { 指标: "主合同文件数", 结果: model.counts.contractCount },
      { 指标: "本年新签", 结果: model.counts.newSigned },
      { 指标: "本年生效", 结果: model.counts.newEffective },
      { 指标: "未来12个月有还款的债项", 结果: model.counts.futureTwelveMonthDebtCount },
      { 指标: "未来12个月整笔到期债项", 结果: model.counts.maturityWithinTwelveCount },
      { 指标: "浮动利率债项", 结果: model.counts.floatingRateCount },
      { 指标: "存在担保债项", 结果: model.counts.securedCount },
      { 指标: "存在限制条款债项", 结果: model.counts.restrictionCount },
      { 指标: "利率调整日临近债项", 结果: model.counts.rateResetSoonCount },
      { 指标: "还款计划待明确债项", 结果: model.counts.pendingRepayment },
    ];
    const debtRows = model.debts.map((debt) => ({
      主文件: debt.contractName,
      合同编号: debt.contractNo,
      借款人: debt.borrower,
      贷款人: debt.lender,
      币种: debt.currency,
      合同本金: debt.principal,
      金额原文: debt.principalText,
      签约日: debt.signingDate?.iso ?? "",
      本年新签: debt.newSigned ? "是" : "否",
      起始日: debt.startDate?.iso ?? "",
      本年生效: debt.newEffective ? "是" : "否",
      到期日: debt.maturityDate?.iso ?? "",
      报告日列报测算: debt.computedStatementClassification,
      利率类型: asText(debt.raw.interest_rate_type),
      执行利率: asText(debt.raw.interest_rate),
      利率调整频率: asText(debt.raw.interest_rate_adjustment_frequency),
      下次利率调整日: asText(debt.raw.next_interest_rate_adjustment_date),
      还本方式: asText(debt.raw.repayment_method),
      本金还款计划: asText(debt.raw.repayment_schedule),
      借款性质: asText(debt.raw.loan_nature),
      保证人: asText(debt.raw.guarantor),
      担保摘要: asText(debt.raw.security_summary),
      提前还款限制状态: asText(debt.raw.prepayment_restriction_status),
      财务指标约束状态: asText(debt.raw.financial_covenant_status),
      加速到期或重大违约触发状态: asText(
        debt.raw.acceleration_or_material_default_trigger_status,
      ),
      限制性契约: asText(debt.raw.covenant_summary),
      风险标签: debt.risks.map((risk) => risk.label).join("；"),
      关联资料: debt.relatedFiles
        .map((file) => `${file.name}（${file.role}）`)
        .join("；"),
      审计提示: asText(debt.raw.auditor_summary),
    }));
    const currencyRows = model.currencyStats.map((entry) => ({
      币种代码: entry.currency,
      币种: entry.currencyName,
      债项数: entry.debtCount,
      合同金额合计: entry.amount,
      未来12个月合同约定还本:
        model.futureTwelveMonthTotals[entry.currency] ?? "",
    }));
    const repaymentRows = model.repaymentPlan.map((row) => ({
      合同编号: row.contractNo,
      还款日: row.date,
      币种: row.currency,
      本金金额: row.amount,
      金额说明: row.amountText,
      解析口径: row.source,
      状态: row.status,
    }));
    const validationRows = model.validations.map((item) => ({
      级别: item.level === "error" ? "错误" : "提示",
      代码: item.code,
      合同或债项: item.debtId ?? "",
      校验提示: item.message,
    }));
    const sheets: Array<{
      name: string;
      rows: Array<Record<string, unknown>>;
      columns?: string[];
    }> = [
      { name: "驾驶舱", rows: dashboardRows },
      { name: "借款清单", rows: debtRows },
      { name: "分币种汇总", rows: currencyRows },
      { name: "还款明细", rows: repaymentRows },
      { name: "校验提示", rows: validationRows },
    ];
    const currencies = [...new Set(model.debts.map((debt) => debt.currency))].sort();
    for (const currency of currencies) {
      const currencyDebts = model.debts.filter((debt) => debt.currency === currency);
      const rows = model.monthlyMatrix.months.map((month) => {
        const row: Record<string, unknown> = { 还款月份: month };
        for (const debt of currencyDebts) {
          const cell = model.monthlyMatrix.rowByDebtId[debt.id]?.cells[month];
          row[debt.displayName] = !cell
            ? ""
            : cell.amount === null
              ? "待明确"
              : cell.amount;
        }
        row.当月合计 = model.monthlyMatrix.totalsByCurrency[currency]?.[month] ?? "";
        return row;
      });
      sheets.push({
        name: `还款计划-${currency}`.slice(0, 31),
        rows,
      });
    }
    const outputPath = await pickPath(
      "save",
      "导出借款审计 Excel",
      ["xlsx"],
      audipickExportName({
        projectName: selected.project.name,
        clientName: selected.project.client,
        typeLabel: "借款审计底稿",
      }),
    );
    if (typeof outputPath !== "string") return;
    setBusy(true);
    setError("");
    try {
      setResult(
        await engineCall("audipick.export_bundle", { outputPath, sheets }),
      );
      addLog(selected.project.name, "借款审计", "借款审计 Excel 已导出", "done");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function exportWorkLog() {
    if (!workLog.length) {
      setError("当前没有可导出的处理日志。");
      return;
    }
    const outputPath = await pickPath(
      "save",
      "导出 AudiPick 处理日志",
      ["xlsx"],
      audipickExportName({ typeLabel: "AudiPick处理日志" }),
    );
    if (typeof outputPath !== "string") return;
    setBusy(true);
    try {
      setResult(
        await engineCall("audipick.export", {
          ruleId: "worklog",
          results: workLog.map((entry) => ({
            文件或项目: entry.fileName,
            处理步骤: entry.step,
            处理详情: entry.detail,
            状态:
              entry.status === "done"
                ? "完成"
                : entry.status === "error"
                  ? "失败"
                  : entry.status === "warn"
                    ? "警告"
                    : "信息",
            时间: entry.time,
          })),
          columns: ["文件或项目", "处理步骤", "处理详情", "状态", "时间"],
          outputPath,
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const projectStats = {
    total: projects.length,
    active: projects.filter((item) => item.project.status !== "completed").length,
    completed: projects.filter((item) => item.project.status === "completed").length,
    documents: Object.values(projectDocumentCounts).reduce(
      (sum, count) => sum + count,
      0,
    ),
  };
  const visibleProjects = [...projects]
    .filter((item) => {
      const query = projectSearch.trim().toLowerCase();
      const matchesSearch = !query ||
        `${item.project.name} ${item.project.client ?? ""}`.toLowerCase().includes(query);
      const status = item.project.status ?? "active";
      return matchesSearch &&
        (projectStatusFilter === "all" || status === projectStatusFilter);
    })
    .sort((left, right) => {
      const leftDate = left.project.date ?? "";
      const rightDate = right.project.date ?? "";
      if (projectSort === "date_asc") return leftDate.localeCompare(rightDate);
      if (projectSort === "name_asc") return left.project.name.localeCompare(right.project.name, "zh-CN");
      if (projectSort === "client_asc") return (left.project.client ?? "").localeCompare(right.project.client ?? "", "zh-CN");
      if (projectSort === "results_desc") return (right.results?.length ?? 0) - (left.results?.length ?? 0);
      if (projectSort === "documents_desc") return (projectDocumentCounts[right.project.id] ?? 0) - (projectDocumentCounts[left.project.id] ?? 0);
      return rightDate.localeCompare(leftDate);
    });
  const selectedRule = rules.find((rule) => rule.id === ruleId) as
    | (typeof rules)[number] & {
        docKind?: string;
        useCase?: string;
        example?: { category?: string; quote?: string; hint?: string };
        prompt?: string;
      }
    | undefined;
  const ruleOptions = rules.map((item) => ({ id: item.id, name: item.name }));
  const dashboardProjects: LegacyDashboardProject[] = projects.map((item) => {
    const fileCount = projectDocumentCounts[item.project.id] ?? 0;
    const extractedIds = new Set((item.results ?? []).map((row) => String(row.contractId ?? "")));
    const reviewTotal = item.results?.length ?? 0;
    const reviewed = (item.results ?? []).filter((row) => row.reviewed).length;
    const extracted = extractedIds.size;
    const complete = item.project.status === "completed";
    const percent = fileCount === 0
      ? 0
      : Math.min(100, Math.round((extracted / fileCount) * 75 + (reviewTotal ? reviewed / reviewTotal : 0) * 25));
    const phase = complete
      ? { phase: "已完成", tone: "green" as const }
      : fileCount === 0
        ? { phase: "准备材料", tone: "gray" as const }
        : extracted === 0
          ? { phase: "待提取", tone: "amber" as const }
          : reviewed < reviewTotal
            ? { phase: "待复核", tone: "blue" as const }
            : { phase: "可完成", tone: "green" as const };
    const updatedAt = item.project.updatedAt ?? item.project.date ?? item.project.createdAt ?? item.project.t;
    return {
      id: item.project.id,
      name: item.project.name,
      client: item.project.client,
      date: item.project.date,
      status: complete ? "completed" : "active",
      createdAt: item.project.createdAt ?? item.project.t ?? item.project.date,
      updatedAt,
      fileCount,
      templateCount: new Set((item.results ?? []).map((row) => String(row.ruleId ?? ""))).size,
      defaultTemplateName: rules.find((candidate) => candidate.id === item.project.defaultRuleId)?.name,
      progress: {
        ...phase,
        rootCount: fileCount,
        extracted,
        reviewTotal,
        reviewed,
        percent,
        ready: fileCount > 0 && extracted === fileCount && reviewed === reviewTotal,
        stale: !complete && Boolean(updatedAt) && Date.now() - new Date(String(updatedAt)).getTime() > 30 * 86400000,
      },
    };
  });
  const dashboardById = new Map(projects.map((item) => [item.project.id, item]));
  const relationMemberRoles = new Map(
    (selected?.project.relationGroups ?? []).flatMap((group) =>
      group.members.map((member) => [member.fileId, member.role] as const),
    ),
  );
  const legacyProjectDocuments = documents.map((document) => {
    const meta = getContractMeta(document.id);
    const rows = selected?.results?.filter((row) => row.contractId === document.id) ?? [];
    return {
      id: document.id,
      name: document.name,
      textLength: documentTextLengths[document.id] ?? 0,
      isScanned: meta.isScanned,
      status: document.status,
      resultCount: rows.length,
      appliedRuleCount: new Set(rows.map((row) => String(row.ruleId ?? ""))).size,
      ruleId: meta.ruleId ?? selected?.project.defaultRuleId,
      ruleConfirmed: meta.ruleConfirmed,
      detectedRuleId: meta.detectedRuleId,
      detectedConfidence: meta.detectedConfidence,
      detectedLabel: meta.detectedLabel,
      associationRole: relationMemberRoles.get(document.id) ?? null,
    };
  });
  const pendingOcrMetas = (selected?.contracts ?? []).filter(
    (meta) => meta.ocrPending,
  );
  const pendingOcrMeta = pendingOcrMetas[0];
  const legacyOcrTask = pendingOcrMeta
    ? {
        id: pendingOcrMeta.id,
        fileName:
          documents.find((document) => document.id === pendingOcrMeta.id)?.name ??
          pendingOcrMeta.id,
        completedPages: pendingOcrMeta.ocrCompletedPages ?? 0,
        totalPages: pendingOcrMeta.ocrTotalPages,
        remainingCount: Math.max(0, pendingOcrMetas.length - 1),
      }
    : null;
  const activeDocument = documents.find((document) => document.id === selectedDocument);
  const activeMeta = selectedDocument ? getContractMeta(selectedDocument) : undefined;
  const activeDocumentAllRows = selected?.results?.filter((row) => row.contractId === selectedDocument) ?? [];
  const workpaperRows = currentResults.filter((row) => {
    const query = workpaperFilter.trim().toLocaleLowerCase("zh-CN");
    return !query || JSON.stringify(editableResult(row)).toLocaleLowerCase("zh-CN").includes(query);
  });
  const currentTheme = document.documentElement.dataset.theme ?? "classic-dark";
  const ocrDisplayLabel = configStatus.ocr?.engine === "baidu"
    ? "百度OCR"
    : configStatus.ocr?.engine === "local"
      ? "本机OCR"
      : "AI视觉";
  void themeRevision;
  const themeNames: Record<string, string> = {
    "green-dark": "深绿",
    "classic-dark": "黄黑",
    "yellow-light": "黄白",
    "blue-white": "蓝白",
    "red-white": "红白",
    "purple-light": "紫白",
    "gray-light": "灰白",
    "dark-blue": "深蓝",
  };
  const logDrawer = (
    <div className="ap-legacy-log-panel">
      <div className="section-title"><h3>处理工作日志</h3><button className="secondary" onClick={() => setLogOpen(false)}>关闭</button></div>
      <div className="worklog-list">
        {workLog.length === 0 ? <p className="hint">暂无处理记录</p> : workLog.map((entry) => <div key={entry.id} className={`worklog-item worklog-${entry.status}`}><strong>{entry.fileName}</strong><span>{entry.step}</span><small>{entry.detail} · {entry.time}</small></div>)}
      </div>
      <div className="actions"><button className="secondary" onClick={clearLog}>清空</button><button className="secondary" disabled={!workLog.length} onClick={() => void exportWorkLog()}>导出</button></div>
    </div>
  );

  if (viewMode === "home") {
    return (
      <AudiPickLegacyHome
        onStart={() => {
          setViewMode("workbench");
          try {
            if (!localStorage.getItem("ap_tour_done")) setTourOpen(true);
          } catch {
            setTourOpen(true);
          }
        }}
        onConfig={() => setViewMode("config")}
      />
    );
  }
  const useParityShell = true as boolean;
  if (useParityShell) return (
    <AudiPickLegacyShell
      activePage={viewMode}
      configReady={Boolean(configStatus.llm?.ready)}
      logCount={workLog.length}
      logOpen={logOpen}
      themeLabel={themeNames[currentTheme] ?? currentTheme}
      onNavigate={(page) => {
        if (page === "guide") {
          setViewMode("workbench");
          setSelectedId("");
          setSelectedDocument("");
          setLoanAuditOpen(false);
          setTourOpen(true);
          return;
        }
        setViewMode(page);
        setLoanAuditOpen(false);
        if (page !== "workbench") {
          setSelectedId("");
          setSelectedDocument("");
        }
      }}
      onToggleLog={() => setLogOpen((open) => !open)}
      onOpenTheme={() => setThemePickerOpen(true)}
      logDrawer={logDrawer}
    >
      {viewMode === "workbench" && !selectedId && (
        <AudiPickLegacyDashboard
          projects={dashboardProjects}
          templates={ruleOptions}
          busy={busy}
          createError=""
          initialTemplateId={defaultRuleId}
          onCreateProject={(values) => create(values)}
          onContinueProject={(project) => {
            const source = dashboardById.get(project.id);
            setSelectedId(project.id);
            setSelectedDocument("");
            setRuleId(source?.project.defaultRuleId ?? "loan_covenant");
          }}
          onDeleteProject={(project) => remove(project.id)}
          onProjectStatusChange={(project, status: AudiPickLegacyProjectStatus) => updateProjectStatus(status, dashboardById.get(project.id))}
        />
      )}
      {viewMode === "workbench" && selected && loanAuditOpen && (
        <>
          {error && <div className="error-box">{error}</div>}
          <AudiPickLegacyLoanAudit
            project={selected.project}
            contracts={documents.map((document) => {
              const meta = getContractMeta(document.id);
              return {
                id: document.id,
                name: document.name,
                file: document.path,
                ruleId: meta.ruleId,
                detectedRuleId: meta.detectedRuleId,
              };
            })}
            results={selected.results ?? []}
            relationGroups={selected.project.relationGroups ?? []}
            reportDate={
              selected.project.loanReportDate ?? selected.project.date ?? ""
            }
            busy={busy}
            actions={{
              onBack: () => setLoanAuditOpen(false),
              onReportDateChange: updateLoanReportDate,
              onExport: exportLoanAudit,
              onOpenWorkpaper: async (contractId) => {
                setLoanAuditOpen(false);
                setRuleId("loan_general");
                setContractView("workpaper");
                await openDocument(contractId);
              },
            }}
          />
        </>
      )}
      {viewMode === "workbench" && selected && !selectedDocument && !loanAuditOpen && (
        <>
          {error && <div className="error-box">{error}</div>}
          <AudiPickLegacyProject
            project={{ id: selected.project.id, name: selected.project.name, client: selected.project.client, date: selected.project.date, defaultRuleName: rules.find((item) => item.id === selected.project.defaultRuleId)?.name }}
            documents={legacyProjectDocuments}
            rules={ruleOptions}
            relationGroups={selected.project.relationGroups ?? []}
            selectedDocumentIds={selectedDocumentIds}
            busy={busy}
            ocrLabel={ocrDisplayLabel}
            ocrTask={legacyOcrTask}
            showLoanAudit={(selected.results ?? []).some(
              (row) => row.ruleId === "loan_general",
            )}
            onSelectionChange={setSelectedDocumentIds}
            actions={{
              onBack: () => { setSelectedId(""); setSelectedDocument(""); },
              onBatchExtract: (ids) => startBatch(ids),
              onOpenLoanAudit: () => setLoanAuditOpen(true),
              onExportProject: () => exportProjectResults("project"),
              onPickPdfs: importPdfs,
              onPickFolder: importPdfFolder,
              onResumeOcr: (id) => openDocument(id),
              onDiscardOcr: async (id) => {
                await engineCall("audipick.document_text_save", {
                  documentId: id,
                  text: "",
                });
                await saveContractMeta(id, {
                  ocrPending: false,
                  ocrCompletedPages: 0,
                });
                setDocumentTextLengths((current) => ({ ...current, [id]: 0 }));
              },
              onOpenDocument: async (id) => { const meta = getContractMeta(id); setRuleId(meta.ruleId ?? selected.project.defaultRuleId ?? "loan_covenant"); setContractView("detail"); await openDocument(id); },
              onDeleteDocument: deleteDocument,
              onRuleChange: async (id, nextRuleId) => { await saveContractMeta(id, { ruleId: nextRuleId, ruleConfirmed: false }); },
              onConfirmRule: async (id, nextRuleId) => { await saveContractMeta(id, { ruleId: nextRuleId, ruleConfirmed: true }); },
              onExtractDocument: async (id) => { const meta = getContractMeta(id); setRuleId(meta.ruleId ?? selected.project.defaultRuleId ?? "loan_covenant"); setPendingExtractDocumentId(id); setContractView("detail"); await openDocument(id); },
              onViewWorkpaper: async (id, nextRuleId) => { setRuleId(nextRuleId ?? getContractMeta(id).ruleId ?? selected.project.defaultRuleId ?? "loan_covenant"); setContractView("workpaper"); await openDocument(id); },
              onManageAssociation: async (id) => { setSelectedDocument(id); setAssociationTarget(documents.find((item) => item.id !== id)?.id ?? ""); },
              onRemoveAssociation: removeAssociation,
              onConfirmAssociation: async (fileId, anchorId, suggestion) => { setSelectedDocument(anchorId); setAssociationTarget(fileId); setAssociationRole(suggestion.role); },
            }}
          />
        </>
      )}
      {viewMode === "workbench" && selected && selectedDocument && activeDocument && !loanAuditOpen && (
        <>
          {error && <div className="error-box">{error}</div>}
          <AudiPickLegacyContract
            view={contractView}
            projectName={selected.project.name}
            contractName={activeDocument.name}
            clientName={selected.project.client}
            projectDate={selected.project.date}
            textLength={pdfText.length}
            totalExtracted={activeDocumentAllRows.length}
            isScanned={Boolean(activeMeta?.isScanned)}
            recognitionLabel={activeMeta?.isScanned ? ocrDisplayLabel : "文字PDF"}
            aiReady={Boolean(configStatus.llm?.ready)}
            busy={busy}
            previewOpen={previewOpen}
            previewWidthPercent={previewWidthPercent}
            preview={
              <div className="pdf-panel">
                <div className="pdf-toolbar">
                  <button
                    className="secondary"
                    disabled={!pdfDocument || pdfPage <= 1}
                    onClick={() =>
                      void renderPdfPage(pdfDocument, pdfPage - 1)
                    }
                  >
                    上一页
                  </button>
                  <label className="aplc-pdf-page-jump">
                    <input
                      aria-label="PDF 页码"
                      type="number"
                      min={1}
                      max={Math.max(1, pdfPages)}
                      value={pdfPage}
                      disabled={!pdfDocument}
                      onChange={(event) => {
                        const nextPage = Math.min(
                          Math.max(1, Number(event.target.value) || 1),
                          Math.max(1, pdfPages),
                        );
                        void renderPdfPage(pdfDocument, nextPage);
                      }}
                    />
                    <span>/ {pdfPages || "-"}</span>
                  </label>
                  <button
                    className="secondary"
                    disabled={!pdfDocument || pdfPage >= pdfPages}
                    onClick={() =>
                      void renderPdfPage(pdfDocument, pdfPage + 1)
                    }
                  >
                    下一页
                  </button>
                  <button
                    className="secondary"
                    disabled={!pdfDocument}
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
                    disabled={!pdfDocument}
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
                    disabled={!pdfDocument}
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
                <div className="aplc-pdf-search">
                  <input
                    value={pdfSearch}
                    placeholder="搜索 PDF 原文"
                    aria-label="搜索 PDF 原文"
                    onChange={(event) => setPdfSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void searchPdf();
                    }}
                  />
                  <button
                    className="secondary"
                    disabled={!pdfDocument || !pdfSearch.trim()}
                    onClick={() => void searchPdf()}
                  >
                    搜索
                  </button>
                  <button
                    className="secondary"
                    disabled={!pdfMatches.length}
                    onClick={() => void jumpPdfMatch(-1)}
                  >
                    上一个
                  </button>
                  <button
                    className="secondary"
                    disabled={!pdfMatches.length}
                    onClick={() => void jumpPdfMatch(1)}
                  >
                    下一个
                  </button>
                  {pdfSearch && (
                    <small>
                      命中页：{pdfMatches.length ? pdfMatches.join("、") : "无"}
                    </small>
                  )}
                </div>
                <canvas ref={canvasRef} />
              </div>
            }
            contractText={pdfText}
            fileFlow={{
              ruleId,
              rules: ruleOptions,
              ruleName: selectedRule?.name ?? ruleId,
              detectedLabel: activeMeta?.detectedLabel ?? suggestedRule?.docLabel,
              detectedConfidence: (activeMeta?.detectedConfidence ?? suggestedRule?.confidence) as "high" | "medium" | "low" | undefined,
              detectedReason: suggestedRule?.reason,
              ruleConfirmed: Boolean(activeMeta?.ruleConfirmed),
              resultCount: currentResults.length,
              versionCount: resultRuns.length,
              appliedRuleCount: new Set(activeDocumentAllRows.map((row) => String(row.ruleId ?? ""))).size,
              associationSummary: relationMemberRoles.has(selectedDocument) ? `已作为${relationMemberRoles.get(selectedDocument)}关联` : undefined,
              extractDisabled: !pdfText.trim() || !configStatus.llm?.ready,
              onRuleChange: (nextRuleId) => { setRuleId(nextRuleId); void saveContractMeta(selectedDocument, { ruleId: nextRuleId, ruleConfirmed: false }); },
              onConfirmRule: (nextRuleId) => void saveContractMeta(selectedDocument, { ruleId: nextRuleId, ruleConfirmed: true }),
              onManageAssociation: () => setAssociationTarget(documents.find((item) => item.id !== selectedDocument)?.id ?? ""),
              onExtract: () => void extract(),
              onExportCurrent: () => void exportResults(),
              onExportAll: () => void exportProjectResults("document"),
            }}
            workpaper={{
              ruleId,
              rules: ruleOptions,
              versions: resultRuns.map((run, index) => ({ id: run.id, label: `${index === 0 ? "最新 · " : ""}${run.extractAt ? new Date(run.extractAt).toLocaleString() : `版本 ${resultRuns.length - index}`}`, count: run.rows.length })),
              versionId: activeResultRun?.id ?? "latest",
              filterText: workpaperFilter,
              columns: fields.map((field) => ({ key: field.key, label: field.label, editable: true, long: /原文|摘要|提示|说明/.test(field.label) })),
              rows: workpaperRows.map((row) => ({ id: String(row.id), reviewed: Boolean(row.reviewed), values: editableResult(row) })),
              selectedRowId: selectedWorkRowId,
              extra:
                revenueMissingTasks.length > 0 ? (
                  <div className="error-box aplc-revenue-missing">
                    <strong>
                      收入底稿待补资料（{revenueMissingTasks.length}）
                    </strong>
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
                          {Array.isArray(task.questionNos) &&
                          task.questionNos.length
                            ? `（涉及第 ${task.questionNos.join("、")}题）`
                            : ""}
                        </p>
                      ))}
                  </div>
                ) : undefined,
              onRuleChange: setRuleId,
              onVersionChange: setSelectedResultRunId,
              onFilterChange: setWorkpaperFilter,
              onSelectRow: setSelectedWorkRowId,
              onFieldChange: updateResultField,
              onSaveRow: () => void saveResultRow(),
              onCopyRow: (rowId) => void copyResultRow(rowId),
              onToggleReviewed: (rowId) => void toggleReviewed(rowId),
              onOpenEvidence: (rowId) => { const row = currentResults.find((item) => String(item.id) === rowId); if (row) void jumpEvidence(row); },
            }}
            onBackWorkbench={() => { setSelectedDocument(""); setSelectedId(""); }}
            onBackProject={() => setSelectedDocument("")}
            onViewChange={setContractView}
            onTogglePreview={() => setPreviewOpen((open) => !open)}
            onPreviewWidthChange={setPreviewWidthPercent}
            onContractTextChange={setPdfText}
            onSaveContractText={() => void saveText()}
            onCopyContractText={() => void navigator.clipboard.writeText(pdfText)}
          />
        </>
      )}
      {viewMode === "templates" && (
        <AudiPickLegacyTemplates
          rules={rules.map((item) => { const source = item as typeof item & { shortName?: string; description?: string; category?: string; docKind?: string; useCase?: string; prompt?: string; example?: { category?: string; quote?: string; hint?: string } }; return { ...source, fields: window.RuleEngine?.getFieldsForRule(item.id) ?? [], prompt: source.prompt ?? window.RuleEngine?.getRulePrompt(item.id), docKind: source.docKind ?? "contract", isCustom: item.readonly === false }; })}
          selectedRuleId={ruleId}
          activeTab={(templateTab === "mine" ? "custom" : templateTab) as AudiPickLegacyTemplateTab}
          search={templateSearch}
          editingRuleId={editingCustomRuleId || null}
          busy={busy}
          message=""
          actions={{ onCreateRule: createLegacyRule, onCopyRule: copyLegacyRule, onSavePrompt: saveLegacyRulePrompt, onDeleteRule: deleteLegacyRule, onSelectRule: setRuleId, onTabChange: (tab) => setTemplateTab(tab === "custom" ? "mine" : tab), onSearchChange: setTemplateSearch, onEditRule: (id) => setEditingCustomRuleId(id ?? "") }}
        />
      )}
      {viewMode === "config" && <AudiPickLegacyConfig status={configStatus} onSaved={() => void refreshConfigStatus()} />}
      {viewMode === "guide" && <AudiPickLegacyGuide onClose={() => setViewMode("workbench")} />}
      {associationTarget && selectedDocument && <div className="ap-legacy-theme-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setAssociationTarget(""); }}><section className="ap-legacy-theme-modal"><div className="section-title"><h3>管理关联资料</h3><button className="secondary" onClick={() => setAssociationTarget("")}>关闭</button></div><p className="hint">主文件：{documents.find((item) => item.id === selectedDocument)?.name}</p><label className="field"><span>关联文件</span><select value={associationTarget} onChange={(event) => setAssociationTarget(event.target.value)}>{documents.filter((item) => item.id !== selectedDocument).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field"><span>资料角色</span><select value={associationRole} onChange={(event) => setAssociationRole(event.target.value)}><option value="补充协议/变更">补充协议/变更</option><option value="订单/结算单">订单/结算单</option><option value="验收/签收资料">验收/签收资料</option><option value="发票/回款资料">发票/回款资料</option><option value="其他支持资料">其他支持资料</option></select></label><div className="actions"><button className="primary" disabled={busy} onClick={() => void saveAssociation().then(() => setAssociationTarget(""))}>保存关联</button></div></section></div>}
      {themePickerOpen && <div className="ap-legacy-theme-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setThemePickerOpen(false); }}><section className="ap-legacy-theme-modal"><div className="section-title"><h3>主题设置</h3><button className="secondary" onClick={() => setThemePickerOpen(false)}>关闭</button></div><p className="hint">颜色与工具箱保持同步，AudiPick 页面布局不变。</p><div className="ap-legacy-theme-grid">{Object.entries(themeNames).map(([id, label]) => <button key={id} className={currentTheme === id ? "primary" : "secondary"} onClick={() => { setSavedTheme(id); setThemeRevision((value) => value + 1); }}>{label}</button>)}</div></section></div>}
      <AudiPickLegacyTour
        open={tourOpen}
        onRequestClose={(reason) => {
          setTourOpen(false);
          if (reason === "complete" || reason === "skip") {
            try {
              localStorage.setItem("ap_tour_done", "1");
            } catch {
              /* Browser storage can be disabled without blocking the tour. */
            }
          }
        }}
      />
    </AudiPickLegacyShell>
  );

  /* The legacy JSX below is intentionally unreachable while the parity shell is
     integrated incrementally. It remains in this patch as a short-term safety
     net for moving specialized revenue-workpaper controls into the new slots. */
  return (
    <div className="ap-product-shell">
      <aside className="ap-product-sidebar">
        <div className="ap-product-brand">
          <span className="ap-product-mark">AP</span>
          <div>
            <strong>AudiPick</strong>
            <small>合同摘录与审阅</small>
          </div>
        </div>
        <nav className="ap-product-nav" aria-label="AudiPick 功能导航">
          <button
            className={viewMode === "workbench" ? "active" : ""}
            onClick={() => {
              setViewMode("workbench");
              setSelectedId("");
              setSelectedDocument("");
            }}
          >
            <span>⌂</span>项目工作台
          </button>
          <button
            className={viewMode === "templates" ? "active" : ""}
            onClick={() => setViewMode("templates")}
          >
            <span>▦</span>提取模板库
          </button>
          <button
            className={viewMode === "worklog" ? "active" : ""}
            onClick={() => setViewMode("worklog")}
          >
            <span>≡</span>处理工作日志
          </button>
          <button
            className={viewMode === "guide" ? "active" : ""}
            onClick={() => setViewMode("guide")}
          >
            <span>?</span>使用指南
          </button>
        </nav>
        <div className="ap-product-status">
          <span className={configStatus.llm?.ready ? "ready" : ""} />
          <div>
            <strong>{configStatus.llm?.ready ? "AI 已就绪" : "AI 尚未配置"}</strong>
            <small>数据由工具箱 Rust / SQLite 管理</small>
          </div>
        </div>
        <p className="ap-theme-note">配色实时跟随工具箱主题</p>
      </aside>
      <div className="ap-product-main">
        <PageHeader
          eyebrow="合同审阅管理"
          title={viewMode === "templates" ? "提取模板库" : viewMode === "worklog" ? "处理工作日志" : viewMode === "guide" ? "使用指南" : selected?.project.name ?? tool.name}
          detail="沿用独立版 AudiPick 的操作布局，文件、结果和设置仍由工具箱统一安全管理。"
        />
      {viewMode === "workbench" && (
      <>
      {selectedId && <StepIndicator
        steps={[
          { key: "1", label: "项目", disabled: false },
          { key: "2", label: "合同文件", disabled: !selectedId },
          { key: "3", label: "提取与结果", disabled: !selectedDocument },
        ]}
        current={selectedDocument ? 2 : selectedId ? 1 : 0}
        onStepClick={(index) => {
          if (index === 0) {
            document.getElementById("ap-proj")?.scrollIntoView({ behavior: "smooth" });
          } else if (index === 1) {
            document.getElementById("ap-contract")?.scrollIntoView({ behavior: "smooth" });
          } else {
            document.getElementById("ap-extract")?.scrollIntoView({ behavior: "smooth" });
          }
        }}
      />}
      <div className={`workspace ${!selectedId ? "ap-dashboard-workspace" : ""}`}>
        {!selectedId ? (
          <section id="ap-proj" className="ap-dashboard">
            <div className="ap-stat-grid">
              <div><span>全部项目</span><strong>{projectStats.total}</strong></div>
              <div><span>进行中</span><strong>{projectStats.active}</strong></div>
              <div><span>已完成</span><strong>{projectStats.completed}</strong></div>
              <div><span>合同文件</span><strong>{projectStats.documents}</strong></div>
            </div>
            <div className="form-card ap-dashboard-card">
              <div className="section-title">
                <div>
                  <h2>项目工作台</h2>
                  <p className="hint">查找项目、查看处理进度或新建摘录任务。</p>
                </div>
                <div className="actions compact">
                  <button className="secondary" disabled={busy} onClick={() => void refresh()}>刷新</button>
                  <button className="secondary" disabled={busy} onClick={() => void exportBackup()}>导出备份</button>
                </div>
              </div>
              <div className="ap-dashboard-filters">
                <input
                  value={projectSearch}
                  onChange={(event) => setProjectSearch(event.target.value)}
                  placeholder="搜索项目或客户名称"
                />
                <select value={projectStatusFilter} onChange={(event) => setProjectStatusFilter(event.target.value)}>
                  <option value="all">全部状态</option>
                  <option value="active">进行中</option>
                  <option value="completed">已完成</option>
                </select>
                <select value={projectSort} onChange={(event) => setProjectSort(event.target.value)}>
                  <option value="date_desc">日期：从新到旧</option>
                  <option value="date_asc">日期：从旧到新</option>
                  <option value="name_asc">项目名称</option>
                  <option value="client_asc">客户名称</option>
                  <option value="documents_desc">文件数量</option>
                  <option value="results_desc">结果数量</option>
                </select>
              </div>
              <details className="ap-create-project" open={projects.length === 0}>
                <summary>＋ 新建项目</summary>
                <div className="form-grid">
                  <label className="field"><span>项目名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
                  <label className="field"><span>客户名称</span><input value={client} onChange={(event) => setClient(event.target.value)} /></label>
                  <label className="field"><span>项目日期</span><input type="date" value={projectDate} onChange={(event) => setProjectDate(event.target.value)} /></label>
                  <label className="field"><span>默认提取模板</span><select value={defaultRuleId} onChange={(event) => setDefaultRuleId(event.target.value)}>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></label>
                </div>
                <div className="actions"><button className="primary" disabled={busy} onClick={() => void create()}>创建并进入项目</button></div>
              </details>
              {error && <div className="error-box">{error}</div>}
              <div className="ap-project-grid">
                {visibleProjects.map((value) => {
                  const resultCount = value.results?.length ?? 0;
                  const documentCount = projectDocumentCounts[value.project.id] ?? 0;
                  const stale = value.project.status !== "completed" && value.project.date && Date.now() - new Date(value.project.date).getTime() > 30 * 86400000;
                  return (
                    <button key={value.project.id} className="ap-project-card" onClick={() => {
                      setSelectedId(value.project.id);
                      setRuleId(value.project.defaultRuleId ?? "loan_covenant");
                    }}>
                      <span className={`ap-project-status ${value.project.status === "completed" ? "completed" : "active"}`}>{value.project.status === "completed" ? "已完成" : "进行中"}</span>
                      <strong>{value.project.name}</strong>
                      <span>{value.project.client || "未填写客户"}</span>
                      <div><span>{documentCount} 份文件</span><span>{resultCount} 条结果</span><span>{value.project.date || "未填写日期"}</span></div>
                      {stale && <em>超过 30 天未完成，请确认状态</em>}
                    </button>
                  );
                })}
                {visibleProjects.length === 0 && <div className="empty">没有符合筛选条件的项目。</div>}
              </div>
            </div>
          </section>
        ) : (
          <section id="ap-proj" className="form-card ap-project-overview">
            <div className="section-title">
              <div>
                <button className="ap-back-link" onClick={() => { setSelectedId(""); setSelectedDocument(""); }}>← 返回项目工作台</button>
                <h2>{selected?.project.name}</h2>
                <p className="hint">{selected?.project.client || "未填写客户"} · {selected?.project.date || "未填写日期"}</p>
              </div>
              <div className="ap-project-overview-actions">
                <button className="secondary" disabled={busy || !(selected?.results?.length)} onClick={() => void exportProjectResults("project")}>导出项目结果</button>
                <label className="field ap-status-field"><span>项目状态</span><select value={selected?.project.status ?? "active"} disabled={busy} onChange={(event) => void updateProjectStatus(event.target.value)}><option value="active">进行中</option><option value="completed">已完成</option></select></label>
              </div>
            </div>
          </section>
        )}
        {selectedId && <>
        <section id="ap-contract" className="form-card">
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
              选择 PDF
            </button>
            <button
              className="secondary"
              disabled={!selectedId || busy}
              onClick={() => void importPdfFolder()}
            >
              选择文件夹
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
                ocrRequiredPages.length > 0 ||
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
            <button
              className="secondary"
              disabled={busy || !selectedDocument}
              onClick={() => void exportProjectResults("document")}
            >
              导出本文件全部模板
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
                  onClick={() => toggleJobPause(batchJob.jobId)}
                >
                  {isJobPaused(batchJob.jobId) ? "继续" : "暂停"}
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
                  {item.error ? errorText(item.error) : "提取失败"}
                </p>
              ))}
              {batchFailures.length > 10 && (
                <p>另有 {batchFailures.length - 10} 份未显示。</p>
              )}
            </div>
          )}
        </section>
        <section id="ap-extract" className="result-card">
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
              <div className="ap-result-heading">
                <div>
                  <h3>当前底稿结果（{currentResults.length}）</h3>
                  <small>重新提取不会覆盖历史版本；人工修改只作用于当前版本。</small>
                </div>
                {resultRuns.length > 0 && (
                  <label className="field ap-result-version">
                    <span>结果版本</span>
                    <select
                      value={activeResultRun?.id ?? ""}
                      onChange={(event) => setSelectedResultRunId(event.target.value)}
                    >
                      {resultRuns.map((run, index) => (
                        <option key={run.id} value={run.id}>
                          {index === 0 ? "最新 · " : "历史 · "}
                          {run.extractAt
                            ? new Date(run.extractAt).toLocaleString()
                            : "旧版导入结果"}
                          {run.rows.some((row) => row.deepReviewed)
                            ? " · 深度复核"
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {currentResults.map((row, index) => (
                <div className="task-row" key={String(row.id ?? index)}>
                  <div className="ap-result-content">
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
                    {editingResult === row ||
                    (editingResult?.id && editingResult.id === row.id) ? (
                      <div className="ap-result-editor">
                        <textarea
                          value={editingResultJson}
                          onChange={(event) => setEditingResultJson(event.target.value)}
                          aria-label="编辑提取结果 JSON"
                        />
                        <div className="actions compact">
                          <button className="primary" disabled={busy} onClick={() => void saveEditedResult()}>保存修改</button>
                          <button className="secondary" disabled={busy} onClick={() => { setEditingResult(undefined); setEditingResultJson(""); }}>取消</button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <button className="secondary" onClick={() => beginEditResult(row)}>编辑</button>
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
        </>}
      </div>
      </>
      )}
      {viewMode === "templates" && (
        <div className="ap-template-shell">
          <div className="ap-template-lib">
          <section className="form-card">
            <div className="section-title">
              <h2>提取模板库</h2>
              <span
                className={`pill ${configStatus.llm?.ready ? "ready" : "preview"}`}
              >
                LLM {configStatus.llm?.ready ? "已就绪" : "未配置"}
              </span>
            </div>
            <p className="hint">
              选择一个模板，系统会按预设字段从合同、单据或报告中提取关键信息。你也可以基于内置模板创建自己的模板。
            </p>
            <div className="ap-template-tabs">
              {[
                { id: "all", label: "全部" },
                { id: "contract", label: "合同协议" },
                { id: "voucher", label: "单据票证" },
                { id: "report", label: "报告" },
                { id: "mine", label: "我的模板" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  className={templateTab === tab.id ? "active" : ""}
                  onClick={() => setTemplateTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <label className="field">
              <span>搜索模板</span>
              <input
                value={templateSearch}
                placeholder="例如：借款合同、发票、征信报告"
                onChange={(e) => setTemplateSearch(e.target.value)}
              />
            </label>
            <p className="hint">
              共 {rules.length} 个模板 · 点击卡片查看右侧详情
            </p>
            <div className="ap-template-list">
              {rules
                .filter((rule) => {
                  const r = rule as unknown as {
                    category?: string;
                    name?: string;
                    description?: string;
                  };
                  if (templateTab === "contract") {
                    if (!["loan", "revenue", "procurement", "agreement"].includes(r.category ?? ""))
                      return false;
                  } else if (templateTab === "voucher") {
                    if (r.category !== "voucher") return false;
                  } else if (templateTab === "report") {
                    if (r.category !== "report") return false;
                  } else if (templateTab === "mine") {
                    const r2 = rule as unknown as { readonly?: boolean };
                    if (r2.readonly !== false) return false;
                  }
                  if (templateSearch) {
                    const q = templateSearch.toLowerCase();
                    if (!`${r.name ?? ""} ${r.description ?? ""} ${rule.id}`.toLowerCase().includes(q))
                      return false;
                  }
                  return true;
                })
                .map((rule) => {
                  const r = rule as unknown as {
                    id: string;
                    name: string;
                    category?: string;
                    docKind?: string;
                    description?: string;
                    readonly?: boolean;
                  };
                  const selected = rule.id === ruleId;
                  return (
                    <button
                      key={rule.id}
                      className={`ap-template-card ${selected ? "selected" : ""}`}
                      onClick={() => setRuleId(rule.id)}
                    >
                      <strong>{r.name}</strong>
                      <span className="ap-template-kind">
                        {r.docKind === "table" ? "表格型" : "条款型"}
                      </span>
                      <span className="ap-template-desc">{r.description}</span>
                      {selected && <em>已选中 · 详情见右侧</em>}
                    </button>
                  );
                })}
            </div>
          </section>
          <section className="form-card">
            <div className="section-title">
              <h2>模板详情</h2>
              <div className="actions compact">
                {selectedRule?.readonly === false ? (
                  <>
                    <button className="secondary" onClick={editSelectedRule}>编辑</button>
                    <button className="secondary" onClick={() => void deleteSelectedRule()}>删除</button>
                  </>
                ) : (
                  <button className="primary" onClick={() => void copySelectedRule()}>
                    复制并编辑
                  </button>
                )}
              </div>
            </div>
            <label className="field">
              <span>当前模板</span>
              <select value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
                {rules.map((rule) => (
                  <option value={rule.id} key={rule.id}>
                    {rule.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="ap-template-meta">
              <span>版本 {selectedRule?.version ?? "1.0"}</span>
              <span>{selectedRule?.docKind === "table" ? "表格型" : "条款型"}</span>
              <span>{selectedRule?.readonly === false ? "我的模板" : "内置模板"}</span>
            </div>
            <p className="hint">{selectedRule?.description}</p>
            <h3>适用场景</h3>
            <p className="hint">{selectedRule?.useCase || selectedRule?.description || "适用于按所选字段提取和复核文档内容。"}</p>
            <h3>提取字段</h3>
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
            {selectedRule?.example && (
              <div className="ap-template-example">
                <strong>示例结果</strong>
                <p>{selectedRule.example.category}</p>
                <p>{selectedRule.example.quote}</p>
                <p>{selectedRule.example.hint}</p>
              </div>
            )}
            <details className="ap-template-advanced">
              <summary>高级规则 / Prompt 与 JSON 结构</summary>
              <pre>{selectedRule?.prompt ?? (selectedRule ? window.RuleEngine?.getRulePrompt(selectedRule.id) : "")}</pre>
            </details>
            <details open={Boolean(editingCustomRuleId)}>
              <summary>{editingCustomRuleId ? "编辑我的模板" : "新增自定义模板"}</summary>
              <div className="form-grid">
                <label className="field">
                  <span>模板名称</span>
                  <input
                    value={customRuleName}
                    onChange={(e) => setCustomRuleName(e.target.value)}
                  />
                </label>
              </div>
              <label className="field">
                <span>提示词（必须包含【字段定义】）</span>
                <textarea
                  value={customRulePrompt}
                  onChange={(e) => setCustomRulePrompt(e.target.value)}
                />
              </label>
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() => void saveCustomRule()}
                >
                  {editingCustomRuleId ? "保存修改" : "保存自定义模板"}
                </button>
                {editingCustomRuleId && (
                  <button className="secondary" onClick={() => {
                    setEditingCustomRuleId("");
                    setCustomRuleName("");
                    setCustomRulePrompt("");
                  }}>取消</button>
                )}
              </div>
            </details>
            <p className="hint">
              在模板库选好模板与字段后，工作台的提取会使用当前选中的模板。
            </p>
          </section>
          </div>
        </div>
      )}
      {viewMode === "worklog" && (
        <section className="form-card">
          <div className="section-title">
            <h2>处理工作日志</h2>
            <div className="actions compact">
              <button className="secondary" disabled={!workLog.length || busy} onClick={() => void exportWorkLog()}>
                导出 Excel
              </button>
              <button className="secondary" onClick={clearLog}>
                清空日志
              </button>
            </div>
          </div>
          {workLog.length === 0 ? (
            <p className="hint">
              暂无处理日志。导入 PDF、OCR、AI 提取等操作会记录在这里。
            </p>
          ) : (
            <div className="worklog-list">
              {workLog.map((entry) => (
                <div
                  key={entry.id}
                  className={`worklog-item worklog-${entry.status}`}
                >
                  <strong>{entry.fileName}</strong>
                  <span className="worklog-step">{entry.step}</span>
                  <span className="worklog-detail">{entry.detail}</span>
                  <span className="worklog-time">{entry.time}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {viewMode === "guide" && (
        <div className="ap-guide-grid">
          <section className="form-card">
            <span className="ap-guide-step">1</span>
            <h2>建立项目并导入 PDF</h2>
            <p>在项目工作台填写客户、日期和默认模板。可选择多个 PDF，也可递归导入整个文件夹。</p>
          </section>
          <section className="form-card">
            <span className="ap-guide-step">2</span>
            <h2>读取文字并选择模板</h2>
            <p>点击“读取/预览”。普通 PDF 直接读取文字层；扫描页自动 OCR，并在每页完成后保存进度。</p>
          </section>
          <section className="form-card">
            <span className="ap-guide-step">3</span>
            <h2>提取、复核与导出</h2>
            <p>AI 结果可人工编辑、标记复核并保留多个历史版本。既可导出单一底稿，也可导出项目多工作表结果。</p>
          </section>
          <section className="form-card ap-guide-note">
            <h2>与工具箱保持一致</h2>
            <p>AudiPick 使用工具箱的 Rust 命令、SQLite 项目数据、AI/OCR 设置和主题。独立弹窗只是操作界面，不会产生第二套数据。</p>
          </section>
        </div>
      )}
      </div>
    </div>
  );
}
