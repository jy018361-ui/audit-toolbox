import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { useTaskRestore } from "./restore";
import { audipickAssetsReady, loadAudipickAssets } from "./audipickAssets";
import { useJobPause } from "@/components/JobDialog";
import { confirmDialog } from "@/components/ConfirmDialog";
import { errorText } from "@/lib/errors";
import { ResultView } from "@/components/ResultView";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { JobProgress } from "@/components/JobProgress";
import "./audipick.css";

import {
  AudiPickLegacyShell,
  type AudiPickLegacyPage,
} from "./AudiPickLegacyShell";
import {
  AudiPickLegacyConfig,
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
import { AudiPickAssociationDialog, type AssociationMember } from "./AudiPickAssociationDialog";
import {
  applyHighConfidenceAssociations,
  associationRoleForDocument,
  buildAssociationSuggestions,
  type AudiPickAssociationDocument,
  type AudiPickAssociationMember,
} from "./audipickAssociations";
import { PDF_OCR_LAYOUT_VERSION, pdfOcrRegions, preparePdfText, recognizePdfPage } from "./audipickPdfPreparation";
import type { AudiPickConfigStatus } from "./AudiPickLegacyAuxiliary";
import { covenantDiagnosticGroups, covenantExportRows, covenantUserView, filterCovenantScope, covenantScope, COVENANT_WORKPAPER_SCOPES, isFormalCovenantRow, FINANCIAL_METRIC_LABELS as COVENANT_LABELS, filterCovenantRows, procedureOverride, PROCEDURE_OVERRIDE_KEY, type CovenantScopeFilter, type ProcedureFilter } from "./audipickCovenant";
import { FINANCIAL_METRICS_VERSION as COVENANT_EXTRACTION_VERSION, extractFinancialMetrics as extractCovenantEvidence, type CovenantDocument } from "./audipickCovenantExtraction";
import { COVENANT_LABELS as LEGACY_COVENANT_LABELS } from "./audipickCovenant";
import { loadCaseLibraryState } from "./audipickCaseLibrary";
import CovenantCaseLibraryManager from "./CovenantCaseLibraryManager";
import {
  AudiPickFieldSelectionDialog,
  type AudiPickFieldSelectionGroup,
  type AudiPickFieldSelectionResult,
} from "./AudiPickFieldSelectionDialog";
import { beginAudiPickOperation, type AudiPickOperationHandle } from "./audipickOperation";
import { runAudiPickExtractJob } from "./audipickExtractJob";
import { documentsByRequestedOrder } from "./audipickDocumentOrder";
import {
  AudiPickLegacyLoanAudit,
  buildAudiPickLoanAuditModel,
} from "./AudiPickLegacyLoanAudit";
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

export function AudiPickResultStatus({ hasResult, missingCount }: { hasResult: boolean; missingCount: number }) {
  return (
    <Badge variant={missingCount ? "warning" : hasResult ? "info" : "neutral"}>
      {missingCount ? "需补充资料" : hasResult ? "已有处理结果 · 待人工复核" : "等待处理"}
    </Badge>
  );
}

type AudiPickRelation = {
  id: string;
  anchorFileId: string;
  members: AudiPickAssociationMember[];
};
type AudiPickResult = Record<string, unknown> & {
  id?: string;
  contractId?: string;
  ruleId?: string;
  ruleName?: string;
  ruleVersion?: string;
  reviewed?: boolean;
  /// Field set and timestamp of the extraction that produced this row; both are
  /// written on save and decide which rows the panel still shows.
  fieldSetId?: string;
  extractAt?: string;
  extractRunId?: string;
};
type AudiPickExtractionSnapshot = {
  ruleId: string;
  ruleName: string;
  ruleVersion: string;
  fieldKeys: string[];
  fieldSetId: string;
};
type AudiPickExtractionRequest = {
  projectId: string;
  documentId: string;
  snapshot: AudiPickExtractionSnapshot;
  text: string;
  openWorkpaperOnComplete?: boolean;
};
type AudiPickFieldDialogRequest = {
  mode: "single" | "batch";
  documentIds: string[];
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
    dismissedAssociations?: string[];
    fieldPrefs?: Record<string, string[]>;
  };
  contracts?: AudiPickContractMeta[];
  results?: AudiPickResult[];
};
type AudiPickContractMeta = {
  id: string;
  ruleId?: string;
  ruleSource?: "user" | "ai";
  ruleConfirmed?: boolean;
  detectedRuleId?: string;
  detectedConfidence?: "high" | "medium" | "low" | string;
  detectedLabel?: string;
  isScanned?: boolean;
  ocrPending?: boolean;
  ocrCompletedPages?: number;
  ocrTotalPages?: number;
  ocrLayoutVersion?: string;
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
  "ruleName",
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
          detail="正在准备合同预览与审阅模板…"
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
  const navigate = useNavigate();
  const [projects, setProjects] = useState<AudiPickProjectData[]>([]);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [selectedId, setSelectedId] = useState("");

  // 历史记录「继续任务」：AudiPick 的项目/文档/字段全部由引擎与规则库派生，
  // 项目本身就持久化在引擎里（页面加载时自动拉取）；这里只回填上次的审阅
  // 规则，字段清单会随规则自动带出。
  useTaskRestore(tool.id, (restore) => {
    const p = restore.params as { ruleId?: string };
    if (typeof p.ruleId === "string" && p.ruleId) setRuleId(p.ruleId);
  });
  const [documents, setDocuments] = useState<AudiPickDocument[]>([]);
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [projectDate, setProjectDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [defaultRuleId, setDefaultRuleId] = useState("loan_covenant");
  const [busy, setBusy] = useState(false);
  const preparingRef = useRef(false);
  const importingRef = useRef(false);
  const [preparationStatus, setPreparationStatus] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<unknown>();
  const selectedDocumentRef = useRef("");
  const [selectedDocument, setSelectedDocument] = useState("");
  selectedDocumentRef.current = selectedDocument;
  const [pdfText, setPdfText] = useState("");
  const [ruleId, setRuleId] = useState("loan_covenant");
  const [selectedFieldKeys, setSelectedFieldKeys] = useState<string[]>([]);
  const [associationTarget, setAssociationTarget] = useState("");
  const [associationAnchor, setAssociationAnchor] = useState("");
  const [associationSuggestion, setAssociationSuggestion] = useState<AssociationMember>();
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
  const [associationDocumentTexts, setAssociationDocumentTexts] = useState<
    Record<string, string>
  >({});
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const extractingDocumentIdsRef = useRef(new Set<string>());
  const [extractingDocumentIds, setExtractingDocumentIds] = useState<Set<string>>(
    new Set(),
  );
  const [fieldDialogRequest, setFieldDialogRequest] =
    useState<AudiPickFieldDialogRequest>();
  const [fieldDialogSubmitting, setFieldDialogSubmitting] = useState(false);
  const [customRulePrompt, setCustomRulePrompt] = useState("");
  const [ruleRevision, setRuleRevision] = useState(0);
  const [suggestedRule, setSuggestedRule] = useState<ClassifiedDocument>();
  const extractCache = useRef(
    new Map<string, Array<{ parsed?: { items?: unknown[] } }>>(),
  );
  const covenantCache = useRef(
    new Map<string, Awaited<ReturnType<typeof extractCovenantEvidence>>>(),
  );
  const batchRulePlans = useRef(
    new Map<
      string,
      { projectId: string; ruleId: string; ruleName: string; ruleVersion: string; fieldKeys: string[]; fieldSetId: string }
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
  const [procedureFilter, setProcedureFilter] = useState<ProcedureFilter>("all");
  const [procedureReviewOnly, setProcedureReviewOnly] = useState(false);
  const [covenantScopeFilter, setCovenantScopeFilter] = useState<CovenantScopeFilter>("repayment");
  useEffect(() => {
    setProcedureFilter("all");
    setCovenantScopeFilter("repayment");
    setProcedureReviewOnly(false);
    setWorkpaperFilter("");
    setSelectedWorkRowId("");
  }, [selectedDocument, ruleId, selectedResultRunId]);
  const [selectedWorkRowId, setSelectedWorkRowId] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
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
  const [configStatus, setConfigStatus] = useState<AudiPickConfigStatus>({});
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const ruleInteractionRevisionRef = useRef(new Map<string, number>());
  const classificationRequestRef = useRef(new Map<string, number>());
  const contractMetaSaveQueueRef = useRef(new Map<string, Promise<void>>());
  // 顶层视图：工作台 / 提取模板库 / 处理工作日志
  const [viewMode, setViewMode] = useState<AudiPickLegacyPage>("home");
  const [logOpen, setLogOpen] = useState(false);
  const [loanAuditOpen, setLoanAuditOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem("ap_split_ratio", String(previewWidthPercent));
    } catch {
      /* The splitter still works when browser storage is unavailable. */
    }
  }, [previewWidthPercent]);
  useEffect(() => {
    setPreviewOpen(false);
    setPdfSearch("");
    setPdfMatches([]);
  }, [selectedDocument]);
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
  function fieldKeysForRule(targetRuleId: string, projectId = selectedId) {
    const available = window.RuleEngine?.getFieldsForRule(targetRuleId) ?? [];
    if (targetRuleId === "revenue_workpaper") {
      return available.map((field) => field.key);
    }
    const known = new Set(available.map((field) => field.key));
    const preferred = projectsRef.current.find(
      (item) => item.project.id === projectId,
    )?.project.fieldPrefs?.[targetRuleId];
    const selected = (preferred?.length
      ? preferred.filter((key) => known.has(key))
      : available.map((field) => field.key));
    const pageKey = window.RuleEngine?.pageKeyForRule?.(targetRuleId);
    if (pageKey && known.has(pageKey) && !selected.includes(pageKey)) {
      selected.unshift(pageKey);
    }
    return selected;
  }
  function extractionSnapshot(
    targetRuleId: string,
    fieldKeys = activeFieldKeys,
  ): AudiPickExtractionSnapshot {
    const normalizedFields = [...fieldKeys].sort();
    const targetRule = rules.find((rule) => rule.id === targetRuleId);
    return {
      ruleId: targetRuleId,
      ruleName: targetRule?.name ?? targetRuleId,
      ruleVersion: targetRule?.version ?? "1.0",
      fieldKeys,
      fieldSetId: `${targetRuleId}:${normalizedFields.join("|")}`,
    };
  }
  function contractMetaFor(projectId: string, documentId: string): AudiPickContractMeta {
    return (
      projectsRef.current
        .find((item) => item.project.id === projectId)
        ?.contracts?.find((item) => item.id === documentId) ?? { id: documentId }
    );
  }
  function templateIsUserLocked(meta: AudiPickContractMeta) {
    return Boolean(meta.ruleConfirmed || meta.ruleSource === "user");
  }
  function bumpRuleInteraction(documentId: string) {
    const next = (ruleInteractionRevisionRef.current.get(documentId) ?? 0) + 1;
    ruleInteractionRevisionRef.current.set(documentId, next);
    return next;
  }
  const selected = projects.find((value) => value.project.id === selectedId);
  const associationDocuments = useMemo<AudiPickAssociationDocument[]>(
    () => documents.map((document) => {
      const meta = selected?.contracts?.find((item) => item.id === document.id);
      const targetRuleId = meta?.detectedRuleId ?? meta?.ruleId;
      return {
        id: document.id,
        name: document.name,
        text: associationDocumentTexts[document.id] ?? "",
        detectedLabel: meta?.detectedLabel,
        detectedRuleId: meta?.detectedRuleId,
        ruleId: meta?.ruleId,
        ruleName: rules.find((candidate) => candidate.id === targetRuleId)?.name,
      };
    }),
    [associationDocumentTexts, documents, rules, selected?.contracts],
  );
  const detectedAssociationSuggestions = useMemo(
    () => buildAssociationSuggestions(
      associationDocuments,
      selected?.project.relationGroups ?? [],
      selected?.project.dismissedAssociations ?? [],
    ),
    [associationDocuments, selected?.project.dismissedAssociations, selected?.project.relationGroups],
  );
  const pendingAssociationSuggestions = useMemo(
    () => detectedAssociationSuggestions.filter((suggestion) => suggestion.confidence === "medium"),
    [detectedAssociationSuggestions],
  );
  useEffect(() => {
    const highConfidence = detectedAssociationSuggestions.filter(
      (suggestion) => suggestion.confidence === "high",
    );
    if (!selectedId || !highConfidence.length) return;
    const target = projectsRef.current.find((item) => item.project.id === selectedId);
    if (!target) return;
    const previousGroups = target.project.relationGroups ?? [];
    const relationGroups = applyHighConfidenceAssociations(previousGroups, highConfidence);
    if (JSON.stringify(relationGroups) === JSON.stringify(previousGroups)) return;
    const saved: AudiPickProjectData = {
      ...target,
      project: {
        ...target.project,
        relationGroups,
        updatedAt: new Date().toISOString(),
      },
    };
    void engineCall("audipick.project_save", saved)
      .then(() => {
        projectsRef.current = projectsRef.current.map((item) =>
          item.project.id === selectedId ? saved : item,
        );
        setProjects(projectsRef.current);
      })
      .catch((cause) => setError(errorText(cause)));
  }, [detectedAssociationSuggestions, selectedId]);
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
  const activeResultSample = activeResultRun?.rows[0];
  const legacyCovenantResult = ruleId === "loan_covenant" && !!activeResultSample && activeResultSample._financial_metrics_only !== true;
  const activeResultRuleId = String(activeResultSample?.ruleId ?? ruleId);
  const activeResultRule = rules.find((rule) => rule.id === activeResultRuleId);
  const activeResultRuleName =
    activeResultSample?.ruleName ??
    activeResultRule?.name ??
    activeResultRuleId;
  const activeResultRuleVersion =
    activeResultSample?.ruleVersion ?? activeResultRule?.version;  const visibleFieldSetId =
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
      : ruleId === "loan_covenant"
        ? (legacyCovenantResult ? matchedResults : matchedResults.filter(row => row._financial_metrics_only === true && isFormalCovenantRow(row)))
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
      setAssociationDocumentTexts({});
      setSelectedDocumentIds([]);
      return;
    }
    let active = true;
    setAssociationDocumentTexts({});
    void engineCall("audipick.documents", { projectId: selectedId })
      .then(async (value) => {
        if (!active) return;
        const nextDocuments = (value as { documents: AudiPickDocument[] }).documents;
        setDocuments(nextDocuments);
        const contents = await Promise.all(
          nextDocuments.map(async (document) => {
            const stored = (await engineCall("audipick.document_text", {
              documentId: document.id,
            })) as { text?: string };
            return [document.id, stored.text ?? ""] as const;
          }),
        );
        if (active) {
          setDocumentTextLengths(Object.fromEntries(contents.map(([id, text]) => [id, text.length])));
          setAssociationDocumentTexts(Object.fromEntries(contents));
        }
      })
      .catch((e) => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [selectedId]);
  useEffect(() => {
    setSelectedFieldKeys(fieldKeysForRule(ruleId));
  }, [ruleId, ruleRevision, selectedId]);
  useEffect(() => {
    setSelectedResultRunId("latest");
    setEditingResult(undefined);
    setEditingResultJson("");
  }, [selectedDocument, ruleId]);
  useEffect(() => {
    let off = () => {};
    void listenJobEvents((event) => {
      if (event.toolId !== "audipick") return;
      if (!batchRulePlans.current.has(event.jobId)) return;
      setBatchJob(event);
      if (event.result) setResult(event.result);
      if (event.phase === "completed" && event.result) {
        const plan = batchRulePlans.current.get(event.jobId) ?? {
          projectId: selectedId,
          ruleName: rules.find((rule) => rule.id === ruleId)?.name ?? ruleId,
          ruleVersion: rules.find((rule) => rule.id === ruleId)?.version ?? "1.0",
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
                  ruleName: plan.ruleName,
                  ruleVersion: plan.ruleVersion,
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
            (project) => project.project.id === plan.projectId,
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
            project.project.id === plan.projectId ? saved : project,
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
      !(await confirmDialog({
        title: "确认删除项目",
        message: `确认删除项目"${project?.project.name ?? selectedId}"？\n\n该项目下的全部合同 PDF、提取结果和复核标记会一并删除，且无法恢复。`,
        tone: "danger",
      }))
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
  async function saveContractRuleSelection(
    documentId: string,
    targetRuleId: string,
    confirmed: boolean,
    projectId = selectedId,
  ) {
    bumpRuleInteraction(documentId);
    await saveContractMeta(
      documentId,
      { ruleId: targetRuleId, ruleConfirmed: confirmed, ruleSource: "user" },
      projectId,
    );
    if (
      projectId === selectedIdRef.current &&
      documentId === selectedDocumentRef.current
    ) {
      setRuleId(targetRuleId);
    }
  }
  async function saveContractMeta(
    documentId: string,
    patch: Partial<AudiPickContractMeta>,
    projectId = selectedId,
  ) {
    const queueKey = `${projectId}:${documentId}`;
    const previous =
      contractMetaSaveQueueRef.current.get(queueKey) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const target = projectsRef.current.find(
        (item) => item.project.id === projectId,
      );
      if (!target) throw new Error("项目已不存在，未保存识别进度。");
      const existing = target.contracts ?? [];
      const current = existing.find((item) => item.id === documentId) ?? {
        id: documentId,
      };
      const contracts = [
        ...existing.filter((item) => item.id !== documentId),
        { ...current, ...patch, id: documentId },
      ];
      const saved: AudiPickProjectData = {
        ...target,
        project: { ...target.project, updatedAt: new Date().toISOString() },
        contracts,
      };
      await engineCall("audipick.project_save", saved);
      projectsRef.current = projectsRef.current.map((item) =>
        item.project.id === projectId ? saved : item,
      );
      setProjects((items) =>
        items.map((item) =>
          item.project.id === projectId ? saved : item,
        ),
      );
    });
    contractMetaSaveQueueRef.current.set(queueKey, task);
    try {
      await task;
    } finally {
      if (contractMetaSaveQueueRef.current.get(queueKey) === task) {
        contractMetaSaveQueueRef.current.delete(queueKey);
      }
    }
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
  async function dismissAssociation(fileId: string, anchorId: string) {
    const target = projectsRef.current.find((item) => item.project.id === selectedId);
    if (!target) return;
    const pair = `${anchorId}>${fileId}`;
    const dismissedAssociations = [...new Set([
      ...(target.project.dismissedAssociations ?? []),
      pair,
    ])];
    const saved: AudiPickProjectData = {
      ...target,
      project: {
        ...target.project,
        dismissedAssociations,
        updatedAt: new Date().toISOString(),
      },
    };
    await engineCall("audipick.project_save", saved);
    projectsRef.current = projectsRef.current.map((item) =>
      item.project.id === selectedId ? saved : item,
    );
    setProjects(projectsRef.current);
  }
  async function exportBackup() {
    const outputPath = await pickPath(
      "save",
      "导出合同项目备份",
      ["zip"],
      audipickExportName(
        {
          projectName: selected?.project.name,
          clientName: selected?.project.client,
          typeLabel: "合同项目备份",
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
  async function importPaths(paths: string[]) {
    const projectId = selectedId;
    if (!projectId || !paths.length || importingRef.current || preparingRef.current) return;
    importingRef.current = true;
    setBusy(true); setError(""); setPreparationStatus("正在导入合同…");
    const imported: Array<{ id: string; name: string }> = [];
    const failures: string[] = [];
    try {
      for (const path of paths) {
        try {
          if (/\.pdf$/i.test(path)) {
            imported.push(await engineCall("audipick.document_import", { projectId, path }) as AudiPickDocument);
          } else {
            const folder = await engineCall("audipick.document_import_folder", { projectId, path }) as {
              documents?: AudiPickDocument[]; failures?: Array<{ path: string; error: string }>;
            };
            imported.push(...folder.documents ?? []);
            failures.push(...(folder.failures ?? []).map((item) => item.error));
          }
        } catch (cause) { failures.push(errorText(cause)); }
      }
      const value = await engineCall("audipick.documents", { projectId }) as { documents: AudiPickDocument[] };
      if (selectedIdRef.current === projectId) setDocuments(value.documents);
      setProjectDocumentCounts((current) => ({ ...current, [projectId]: value.documents.length }));
      const unique = [...new Map(imported.map((item) => [item.id, item])).values()];
      addLog(`${unique.length} 份 PDF`, "导入", "文件已导入，开始读取文字及扫描页", "done");
      await prepareDocuments(unique, projectId);
      if (failures.length) setError(`部分文件导入失败：${failures.join("；")}`);
    } catch (cause) { setError(errorText(cause)); }
    finally { importingRef.current = false; setBusy(false); }
  }
  async function importPdfs() {
    if (!selectedId) { setError("请先选择项目。"); return; }
    const paths = await pickPath("files", "导入合同 PDF", ["pdf"]);
    if (Array.isArray(paths)) await importPaths(paths);
  }
  async function importDroppedPaths(paths: string[]) { await importPaths(paths); }
  async function importPdfFolder() {
    if (!selectedId) { setError("请先选择项目。"); return; }
    const path = await pickPath("folder", "选择包含合同 PDF 的文件夹");
    if (typeof path === "string") await importPaths([path]);
  }
  async function deleteDocument(documentId: string) {
    const document = documents.find((item) => item.id === documentId);
    if (
      !(await confirmDialog({
        title: "确认删除文件",
        message: `确认删除"${document?.name ?? documentId}"？\n\n该文件的 PDF、已保存的文字层和提取结果会一并删除，且无法恢复。`,
        tone: "danger",
      }))
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
  async function loadPdf(id: string) {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error("PDF.js 本地组件未加载。");
    pdfjs.GlobalWorkerOptions.workerSrc = "/audipick-pdfjs/legacy/build/pdf.worker.min.js";
    return pdfjs.getDocument({
      data: new Uint8Array(await audipickPdfBytes(id)),
      cMapUrl: "/audipick-pdfjs/cmaps/", cMapPacked: true,
      standardFontDataUrl: "/audipick-pdfjs/standard_fonts/",
    }).promise;
  }
  async function readDocumentText(id: string, projectId: string, pdf: any, fileName: string, operation?: AudiPickOperationHandle) {
    // Refresh saved configuration at operation time, not from an old render closure.
    const status = await engineCall("audipick.config_status", {}) as AudiPickConfigStatus;
    setConfigStatus(status);
    const stored = await engineCall("audipick.document_text", { documentId: id }) as { text?: string };
    const reuseCachedOcr = contractMetaFor(projectId, id).ocrLayoutVersion === PDF_OCR_LAYOUT_VERSION;
    const prepared = await preparePdfText(pdf, stored.text ?? "", {
      operation,
      ocrReady: Boolean(status.ocr?.ready),
      reuseCachedOcr,
      save: async (text) => {
        await engineCall("audipick.document_text_save", { documentId: id, text });
        if (selectedIdRef.current === projectId) setDocumentTextLengths((current) => ({ ...current, [id]: text.length }));
      },
      progress: async (completed, total) => {
        operation?.update(`${fileName}：已保存 ${completed}/${total} 页`, completed, total);
        setPreparationStatus(`${fileName}：已保存 ${completed}/${total} 页，正在读取文字/识别扫描页或异常文字层…`);
        await saveContractMeta(id, { ocrPending: true, ocrCompletedPages: completed, ocrTotalPages: total }, projectId);
      },
      recognize: async (page, number) => {
        // Render OCR input above screen-preview resolution so small Chinese
        // glyphs and comparison signs survive rasterization.
        const viewport = page.getViewport({ scale: 2.5 });
        const image = document.createElement("canvas");
        image.width = viewport.width; image.height = viewport.height;
        try {
          const imageContext = image.getContext("2d");
          if (!imageContext) throw new Error("无法创建 PDF OCR 画布。");
          await page.render({ canvasContext: imageContext, viewport }).promise;
          const regions = pdfOcrRegions(image.width, image.height);
          const recognized: string[] = [];
          for (let index = 0; index < regions.length; index++) {
            await operation?.checkpoint();
            const region = regions[index];
            let target = image;
            if (region.label !== "full") {
              target = document.createElement("canvas");
              target.width = region.width; target.height = region.height;
              const targetContext = target.getContext("2d");
              if (!targetContext) throw new Error("无法创建双页 PDF OCR 分页画布。");
              targetContext.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
            }
            try {
              const text = await recognizePdfPage({ documentId: id, page: number, totalPages: pdf.numPages,
                pageRegion: region.label, regionIndex: index + 1, regionCount: regions.length,
                imageBase64: target.toDataURL("image/jpeg", 0.86).split(",")[1] }, operation);
              if (text.trim()) recognized.push(text.trim());
            } finally {
              if (target !== image) { target.width = 0; target.height = 0; }
            }
          }
          return recognized.join("\n");
        } finally { image.width = 0; image.height = 0; }
      },
    });
    await saveContractMeta(id, { isScanned: prepared.scanned, ocrPending: prepared.missing.length > 0,
      ocrCompletedPages: pdf.numPages - prepared.missing.length, ocrTotalPages: pdf.numPages,
      ocrLayoutVersion: prepared.missing.length ? undefined : PDF_OCR_LAYOUT_VERSION }, projectId);
    return prepared;
  }
  async function prepareDocuments(items: Array<{ id: string; name: string }>, projectId: string) {
    if (preparingRef.current || !items.length) return;
    preparingRef.current = true; setBusy(true); setError("");
    const operation = beginAudiPickOperation("合同文字读取 / OCR", true);
    let completed = 0;
    const preparedTexts: Record<string, string> = {};
    try {
      // Mark every accepted file before processing so interrupted batches can be resumed.
      for (const item of items) await saveContractMeta(item.id, { ocrPending: true }, projectId);
      for (const item of items) {
        await operation.checkpoint();
        setPreparationStatus(`正在处理 ${item.name}（${completed + 1}/${items.length}）…`);
        const pdf = await loadPdf(item.id);
        try {
          const prepared = await readDocumentText(item.id, projectId, pdf, item.name, operation);
          if (prepared.missing.length) throw new Error(`${item.name} 第 ${prepared.missing.join("、")} 页需要 OCR。请完成 OCR 配置后在合同列表点击“继续识别”。`);
          void suggestRule(item.id, prepared.text, projectId, item.name);
          preparedTexts[item.id] = prepared.text;
          completed++;
          addLog(item.name, "文字识别", `已保存 ${pdf.numPages} 页，其中 OCR ${prepared.ocrPages} 页，复用 ${prepared.resumedPages} 页`, "done");
        } finally { await pdf.destroy?.(); }
      }
      setPreparationStatus(`已完成 ${completed} 份合同的文字读取/识别，可选择模板开始提取。`);
      operation.finish("completed", `已保存 ${completed} 份合同的文字，可开始提取。`);
    } catch (cause) {
      const message = errorText(cause);
      operation.finish(/取消|停止/.test(message) ? "cancelled" : "failed", message);
      setError(message); setPreparationStatus(`已完成 ${completed}/${items.length} 份；其余保留为待继续识别。`);
      addLog("合同识别", "文字识别", message, "error");
    } finally {
      if (selectedIdRef.current === projectId && Object.keys(preparedTexts).length) {
        setAssociationDocumentTexts((current) => ({ ...current, ...preparedTexts }));
      }
      preparingRef.current = false; setBusy(false);
    }
  }
  async function openDocument(id: string) {
    if (preparingRef.current) return;
    preparingRef.current = true;
    setBusy(true); setError(""); setSelectedDocument(id); setPdfText("");
    selectedDocumentRef.current = id;
    const projectId = selectedId;
    const existingPdf = pdfDocument;
    setPdfDocument(undefined);
    setPdfPages(0);
    if (existingPdf) await existingPdf.destroy?.();
    let pdf: any;
    let operation: AudiPickOperationHandle | undefined;
    try {
      const stored = (await engineCall("audipick.document_text", {
        documentId: id,
      })) as { text?: string };
      if (
        stored.text?.trim() &&
        !contractMetaFor(projectId, id).ocrPending
      ) {
        if (selectedIdRef.current !== projectId) return;
        setPdfText(stored.text);
        setOcrRequiredPages([]);
        setResult({
          documentId: id,
          textLength: stored.text.length,
          source: "saved",
        });
        setAssociationDocumentTexts((current) => ({
          ...current,
          [id]: stored.text ?? "",
        }));
        void suggestRule(
          id,
          stored.text,
          projectId,
          documents.find((item) => item.id === id)?.name,
        );
        return;
      }
      operation = beginAudiPickOperation("读取合同文字", true);
      pdf = await loadPdf(id);
      const prepared = await readDocumentText(id, projectId, pdf, documents.find((item) => item.id === id)?.name ?? id, operation);
      if (selectedIdRef.current !== projectId) { await pdf.destroy?.(); return; }
      setPdfText(prepared.text); setOcrRequiredPages(prepared.missing);
      setResult({ documentId: id, pages: pdf.numPages, textLength: prepared.text.length, ocrPages: prepared.ocrPages });
      if (prepared.missing.length) { setError(`第 ${prepared.missing.join("、")} 页需要 OCR，请配置后继续识别。`); operation.finish("failed", "部分页面需要 OCR，请配置后继续识别。"); }
      else {
        operation.finish("completed", "合同文字已保存。");
        void suggestRule(id, prepared.text, projectId, documents.find((item) => item.id === id)?.name);
        if (selectedIdRef.current === projectId) {
          setAssociationDocumentTexts((current) => ({ ...current, [id]: prepared.text }));
        }
      }
      await pdf.destroy?.();
      pdf = undefined;
    } catch (cause) {
      await pdf?.destroy?.();
      const message = errorText(cause);
      operation?.finish(/取消|停止/.test(message) ? "cancelled" : "failed", message);
      setError(message);
    }
    finally { preparingRef.current = false; setBusy(false); }
  }
  /// Legacy classified every upload and asked the user to confirm the template.
  /// Without it the picker stays on 借款·限制性契约 for every document, and a
  /// wrong template silently produces meaningless extractions.
  async function suggestRule(
    documentId: string,
    text: string,
    projectId = selectedId,
    documentName?: string,
  ) {
    if (!configStatus?.llm?.ready || !text.trim()) return;
    const initialMeta = contractMetaFor(projectId, documentId);
    // A user-selected template is already authoritative.  Even when the user
    // has not pressed "confirm" yet, a late classifier result must not replace
    // the selection they made moments earlier.
    if (templateIsUserLocked(initialMeta)) return;
    const catalog = rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      docKind: (rule as { docKind?: string }).docKind,
    }));
    if (!catalog.length) return;
    const name = documentName ?? documents.find((item) => item.id === documentId)?.name ?? "";
    const requestId = (classificationRequestRef.current.get(documentId) ?? 0) + 1;
    classificationRequestRef.current.set(documentId, requestId);
    const interactionRevision =
      ruleInteractionRevisionRef.current.get(documentId) ?? 0;
    try {
      const value = (await engineCall("audipick.classify", {
        documentId,
        prompt: buildClassifyPrompt(catalog),
        text: classifySample(name, text),
      })) as { parsed?: unknown };
      if (classificationRequestRef.current.get(documentId) !== requestId) return;
      const picked = pickClassifiedRule(
        value.parsed,
        catalog.map((rule) => rule.id),
        initialMeta.ruleId ?? selected?.project.defaultRuleId ?? ruleId,
      );
      const latestMeta = contractMetaFor(projectId, documentId);
      const interactionChanged =
        (ruleInteractionRevisionRef.current.get(documentId) ?? 0) !==
        interactionRevision;
      // Re-check after the await: the classifier may finish after the user
      // selects/confirms a template.  In that case persist only the AI
      // suggestion metadata; the user's ruleId and confirmation stay intact.
      const preserveUserChoice =
        interactionChanged || templateIsUserLocked(latestMeta);
      const patch: Partial<AudiPickContractMeta> = {
        detectedRuleId: picked.ruleId,
        detectedConfidence: picked.confidence,
        detectedLabel: picked.docLabel,
      };
      if (!preserveUserChoice) {
        patch.ruleId = picked.ruleId;
        patch.ruleSource = "ai";
        patch.ruleConfirmed = false;
      }
      await saveContractMeta(documentId, patch, projectId);
      const effectiveRuleId = preserveUserChoice
        ? latestMeta.ruleId
        : picked.ruleId;
      if (
        !preserveUserChoice &&
        projectId === selectedIdRef.current &&
        selectedDocumentRef.current === documentId
      ) {
        setRuleId(picked.ruleId);
      }
      if (selectedDocumentRef.current === documentId) {
        setSuggestedRule(picked.ruleId === effectiveRuleId ? undefined : picked);
      }
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
  async function openPdfPreview(
    documentId = selectedDocumentRef.current,
    startPage = pdfPage,
  ) {
    if (!documentId) return;
    setError("");
    let document =
      documentId === selectedDocumentRef.current ? pdfDocument : undefined;
    try {
      if (!document) {
        document = await loadPdf(documentId);
        if (selectedDocumentRef.current !== documentId) {
          await document.destroy?.();
          return;
        }
        setPdfDocument(document);
        setPdfPages(document.numPages);
      }
      const page = Math.min(
        Math.max(1, Number(startPage) || 1),
        Math.max(1, document.numPages),
      );
      setPreviewOpen(true);
      // SplitPane mounts the canvas only after previewOpen changes.
      window.setTimeout(() => {
        void renderPdfPage(document, page, pdfSearch, pdfScale, pdfRotation);
      }, 0);
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  function closeDocument(returnToWorkbench = false) {
    const document = pdfDocument;
    setPreviewOpen(false);
    setPdfDocument(undefined);
    setPdfPages(0);
    setPdfMatches([]);
    setSelectedDocument("");
    selectedDocumentRef.current = "";
    if (returnToWorkbench) setSelectedId("");
    void document?.destroy?.();
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
    const directOwner = String(row.source_document_id ?? "");
    const owner = documents.some((item) => item.id === directOwner)
      ? directOwner
      : matchEvidenceDocument(
          String(row.source_documents ?? row.sourceDocuments ?? ""),
          documents.map((item) => ({ id: item.id, name: item.name })),
        );
    if (owner && owner !== selectedDocument) {
      await openDocument(owner);
      // Let the selected-document reset render before explicitly opening the
      // preview requested by the evidence link.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      await openPdfPreview(owner, Math.max(1, Number(match[0])));
      return;
    }
    await openPdfPreview(
      selectedDocument,
      Math.max(1, Number(match[0])),
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
      addLog("当前文档", "文字识别", "识别失败", "error");
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
  /// Persist one extraction run's items against the immutable launch snapshot.
  async function saveExtractedItemsFor(
    projectId: string,
    documentId: string,
    snapshot: AudiPickExtractionSnapshot,
    items: Array<Record<string, unknown>>,
  ) {
    const project = projectsRef.current.find((item) => item.project.id === projectId);
    if (!project) throw new Error("保存提取结果时找不到当前项目，请刷新后重试。");
    const extractAt = new Date().toISOString();
    const extractRunId = `run_${Date.now().toString(36)}`;
    const saved = {
      ...project,
      results: [
        ...(project.results ?? []),
        ...items.map((item, index) => ({
          ...item,
          id: `r_${extractRunId}_${index}`,
          contractId: documentId,
          ruleId: snapshot.ruleId,
          ruleName: snapshot.ruleName,
          ruleVersion: snapshot.ruleVersion,
          fieldKeys: snapshot.fieldKeys,
          fieldSetId: snapshot.fieldSetId,
          extractAt,
          extractRunId,
          reviewed: false,
        })),
      ],
    };
    await engineCall("audipick.project_save", saved);
    projectsRef.current = projectsRef.current.map((item) => item.project.id === projectId ? saved : item);
    setProjects(projectsRef.current);
    if (documentId === selectedDocument && documentId === selectedDocumentRef.current) {
      setSelectedResultRunId(extractRunId);
    }
  }
  async function saveExtractedItems(
    items: Array<Record<string, unknown>>,
    snapshot = extractionSnapshot(ruleId),
  ) {
    if (!selected) return;
    await saveExtractedItemsFor(selected.project.id, selectedDocument, snapshot, items);
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
    operation: AudiPickOperationHandle,
    snapshot: AudiPickExtractionSnapshot,
    target: { projectId: string; documentId: string },
  ) {
    const rules = window.RevenueWorkpaper as any;
    const questions = (rules?.questions ?? []) as Array<{
      sheet: string;
      row: number;
      questionNo: string;
      question: string;
    }>;
    if (!questions.length) {
      throw new Error("收入底稿问题矩阵未加载。");
    }
    const cacheKey = extractionCacheKey(
      target.documentId,
      snapshot.ruleId,
      snapshot.fieldSetId,
      context,
    );
    const cached = extractCache.current.get(cacheKey);
    const askOnce = (batchPrompt: string, text: string) =>
      withRetry(
        () =>
          runAudiPickExtractJob<Record<string, unknown>>({
            documentId: target.documentId,
            ruleId: snapshot.ruleId,
            ruleName: snapshot.ruleName,
            ruleVersion: snapshot.ruleVersion,
            fieldKeys: snapshot.fieldKeys,
            fieldSetId: snapshot.fieldSetId,
            prompt: batchPrompt,
            text,
          }, operation) as Promise<{ parsed?: Record<string, unknown> }>,
        3,
        2_000,
        (remaining) => operation.update(`调用失败，正在重试…还剩 ${remaining} 次`),
      );

    let responses: Array<{ parsed?: Record<string, unknown> }>;
    let facts: Array<Record<string, unknown>> = [];
    if (cached) {
      responses = cached as Array<{ parsed?: Record<string, unknown> }>;
    } else {
      // Pass 1 — objective facts per document.
      for (const [index, document] of bundle.entries()) {
        for (const chunk of splitContractText(document.text)) {
          operation.update(
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
          operation.update(`正在作答底稿问题：第 ${index + 1}/${batches.length} 批…`);
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
      operation.update(`已锁定 ${targets.length} 项履约义务，正在逐项判断收入确认时段/时点…`);
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
        operation.update(
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
      operation.update("检测到同类履约义务答案不一致，正在按相同指标统一复核…");
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
    await operation.checkpoint();
    await saveExtractedItemsFor(
      target.projectId,
      target.documentId,
      snapshot,
      withFacts,
    );
    setResult({
      items: withFacts.length,
      questions: questions.length,
      facts: facts.length,
      // Rows beyond the main pass come from the per-obligation and appendix
      // rounds, so surface them instead of leaving the count unexplained.
      followUpItems: Math.max(0, withFacts.length - mainAnswers),
    });
  }

  async function extract(request?: AudiPickExtractionRequest) {
    if (busy && !request) return;
    const targetProjectId = request?.projectId ?? selected?.project.id ?? "";
    const targetDocumentId = request?.documentId ?? selectedDocument;
    const sourceText = request?.text ?? pdfText;
    const targetProject = projectsRef.current.find(
      (item) => item.project.id === targetProjectId,
    );
    const targetDocument = documents.find(
      (item) => item.id === targetDocumentId,
    );
    if (!targetProjectId || !targetProject || !targetDocumentId) {
      setError("找不到待提取的合同，请返回项目后重试。");
      return;
    }
    if (extractingDocumentIdsRef.current.has(targetDocumentId)) return;
    if (contractMetaFor(targetProjectId, targetDocumentId).ocrPending) {
      setError("合同文字识别尚未完成，请先继续 OCR 后再提取。"); return;
    }
    if (!sourceText.trim()) {
      setError("请先读取 PDF 文字或识别扫描页面。");
      return;
    }
    const snapshot = request?.snapshot ?? extractionSnapshot(ruleId);
    const prompt = `${window.RuleEngine?.getRulePrompt(snapshot.ruleId) ?? ""}

本次仅返回这些字段：${snapshot.fieldKeys.join(", ")}`;
    extractingDocumentIdsRef.current.add(targetDocumentId);
    setExtractingDocumentIds(new Set(extractingDocumentIdsRef.current));
    setError("");
    const operation = beginAudiPickOperation(
      `${targetDocument?.name ?? "合同"} · 条款提取`,
      true,
    );
    try {
      let context = sourceText;
      const bundle: CovenantDocument[] = [
        {
          id: targetDocumentId,
          name: targetDocument?.name ?? "主合同",
          text: sourceText,
        },
      ];
      const group = targetProject.project.relationGroups?.find(
        (value) => value.anchorFileId === targetDocumentId,
      );
      for (const member of group?.members ?? []) {
        await operation.checkpoint();
        if (contractMetaFor(targetProjectId, member.fileId).ocrPending) throw new Error("关联资料尚未完成文字识别，请先继续 OCR 后再提取。");
        const value = (await engineCall("audipick.document_text", {
          documentId: member.fileId,
        })) as { text: string };
        if (!value.text?.trim()) throw new Error("关联资料没有可用文字，请先在合同列表读取文字 / OCR。");
        if (value.text) {
          context += `\n\n---关联资料：${member.role}---\n${value.text}`;
          bundle.push({
            id: member.fileId,
            name:
              documents.find((item) => item.id === member.fileId)?.name ??
              member.role,
            text: value.text,
          });
        }
      }
      if (snapshot.ruleId === "revenue_workpaper") {
        await extractRevenueWorkpaper(prompt, bundle, context, operation, snapshot, {
          projectId: targetProjectId,
          documentId: targetDocumentId,
        });
        operation.finish("completed", "底稿提取完成并已保存。");
        return;
      }
      if (snapshot.ruleId === "loan_covenant") {
        const { active: caseVersion } = await loadCaseLibraryState();
        const covenantCacheKey = extractionCacheKey(
          targetDocumentId,
          snapshot.ruleId,
          snapshot.fieldSetId,
          `${COVENANT_EXTRACTION_VERSION}\u0000${caseVersion.hash}\u0000${bundle.map((document) => `${document.id}\u0000${document.text}`).join("\u0001")}`,
        );
        let outcome = covenantCache.current.get(covenantCacheKey);
        if (outcome) {
          operation.update("合同文字和提取版本未变化，正在复用本次会话已核验结果…");
        } else {
          outcome = await extractCovenantEvidence({
            caseLibrary: caseVersion.library,
            documents: bundle,
            extract: ({ prompt: stagePrompt, text }) =>
              withRetry(
                () => runAudiPickExtractJob<{ parsed?: unknown; finish_reason?: string }>({
                  documentId: targetDocumentId,
                  ruleId: snapshot.ruleId,
                  ruleName: snapshot.ruleName,
                  ruleVersion: snapshot.ruleVersion,
                  fieldKeys: snapshot.fieldKeys,
                  fieldSetId: snapshot.fieldSetId,
                  prompt: stagePrompt,
                  text,
                }, operation),
                3,
                2_000,
                (remaining) => operation.update(`调用失败，正在重试，还剩 ${remaining} 次…`),
              ),
            onProgress: (message) => operation.update(message),
          });
          covenantCache.current.set(covenantCacheKey, outcome);
        }
        await operation.checkpoint();
        await saveExtractedItemsFor(
          targetProjectId,
          targetDocumentId,
          snapshot,
          outcome.items,
        );
        const repaymentItems = filterCovenantScope(outcome.items, "repayment").length;
        const supplementaryItems = filterCovenantScope(outcome.items, "supplementary").length;
        const diagnostic = outcome.unresolvedCount ? `（原始失败记录 ${outcome.unresolvedRecordCount} 条，原因见底稿诊断）` : "";
        const pendingCount = outcome.items.filter(row => row._covenant_pending_case === true).length;
        const message = `已保存财务契约 ${repaymentItems} 项${pendingCount ? `，待新增案例 ${pendingCount} 项` : ""}。${diagnostic}`;
        setResult({ items: outcome.items.length, repaymentItems, supplementaryItems, unresolvedItems: outcome.unresolvedCount });
        addLog(bundle[0].name, "契约关联提取", message, outcome.unresolvedCount ? "warn" : "done");
        operation.finish(outcome.unresolvedCount ? "failed" : "completed", message);
        if (
          (request?.openWorkpaperOnComplete ?? !request) &&
          selectedDocumentRef.current === targetDocumentId
        ) {
          setContractView("workpaper");
        }
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
        targetDocumentId,
        snapshot.ruleId,
        snapshot.fieldSetId,
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
            if (label) operation.update(`合同较长，正在分段提取：${label}…`);
            collected.push(
              await withRetry(
                () =>
                  runAudiPickExtractJob<{
                    parsed?: { items?: unknown[] };
                    content: string;
                  }>({
                    documentId: targetDocumentId,
                    ruleId: snapshot.ruleId,
                    ruleName: snapshot.ruleName,
                    ruleVersion: snapshot.ruleVersion,
                    fieldKeys: snapshot.fieldKeys,
                    fieldSetId: snapshot.fieldSetId,
                    prompt,
                    text: chunk,
                  }, operation),
                3,
                2_000,
                (remaining) => operation.update(
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
          Object.entries(item).filter(([key]) => snapshot.fieldKeys.includes(key)),
        ),
      );
      await operation.checkpoint();
      await saveExtractedItemsFor(
        targetProjectId,
        targetDocumentId,
        snapshot,
        items,
      );
      setResult({ items: items.length, chunks: chunks.length });
      operation.finish("completed", `提取完成并保存 ${items.length} 条。`);
      addLog(
        targetDocument?.name ?? "文档",
        "AI 提取",
        `提取 ${items.length} 条，分 ${chunks.length} 段处理`,
        "done",
      );
    } catch (e) {
      const message = errorText(e);
      const cancelled =
        (e instanceof Error && e.name === "AudiPickExtractCancelled") ||
        /取消|停止|终止/.test(message);
      operation.finish(cancelled ? "cancelled" : "failed", message);
      addLog(
        targetDocument?.name ?? "文档",
        "AI 提取",
        cancelled ? "提取已终止" : "提取失败",
        cancelled ? "warn" : "error",
      );
      if (!cancelled) setError(message);
    } finally {
      extractingDocumentIdsRef.current.delete(targetDocumentId);
      setExtractingDocumentIds(new Set(extractingDocumentIdsRef.current));
    }
  }
  async function deepReview() {
    if (getContractMeta(selectedDocument).ocrPending) {
      setError("合同文字识别尚未完成，请先继续 OCR 后再复核。"); return;
    }
    if (ruleId !== "revenue_workpaper" || !currentResults.length || !pdfText) {
      setError("深度复核仅适用于已有结果的收入合同审阅底稿。");
      return;
    }
    const snapshot = extractionSnapshot(ruleId);
    setBusy(true);
    const operation = beginAudiPickOperation("收入底稿深度复核", true);
    try {
      const prompt = `${window.RuleEngine?.getRulePrompt(snapshot.ruleId) ?? ""}\n\n请对现有回答进行第二轮深度复核，消除重复和冲突，保留证据页码，只返回完整JSON。`;
      const value = await runAudiPickExtractJob<{
        parsed?: { items?: unknown[] };
      }>(
        {
          documentId: selectedDocument,
          ruleId: snapshot.ruleId,
          ruleName: snapshot.ruleName,
          ruleVersion: snapshot.ruleVersion,
          fieldKeys: snapshot.fieldKeys,
          fieldSetId: snapshot.fieldSetId,
          prompt,
          text: `${pdfText}\n\n---现有底稿回答---\n${JSON.stringify(currentResults)}`,
        },
        operation,
      );
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
        await operation.checkpoint();
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
              ruleId: snapshot.ruleId,
              ruleName: snapshot.ruleName,
              ruleVersion: snapshot.ruleVersion,
              fieldKeys: snapshot.fieldKeys,
              fieldSetId: snapshot.fieldSetId,
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
      operation.finish("completed", `深度复核完成，已保存 ${items.length} 条。`);
    } catch (e) {
      const message = errorText(e);
      const cancelled =
        (e instanceof Error && e.name === "AudiPickExtractCancelled") ||
        /取消|停止|终止/.test(message);
      operation.finish(cancelled ? "cancelled" : "failed", message);
      if (!cancelled) setError(message);
    } finally {
      setBusy(false);
    }
  }  async function startBatch(
    documentIds = documents.map((document) => document.id),
    fieldKeysByRuleId?: Record<string, string[]>,
    skipExistingMatchingFieldSet = false,
  ) {
    const requestedDocuments = documentsByRequestedOrder(documents, documentIds);
    if (!requestedDocuments.length) {
      setError("项目中没有可提取的 PDF。");
      return;
    }
    const projectAtLaunch = selected;
    const projectId = selectedId;
    // Capture every file's rule, version and field list before any await.  The
    // worker/job may outlive the current UI selection; its results must still
    // be attributable to the template that was active when extraction started.
    let launchPlans = requestedDocuments.map((document) => {
      const meta = getContractMeta(document.id);
      const targetRuleId =
        meta.ruleId ?? projectAtLaunch?.project.defaultRuleId ?? ruleId;
      return {
        document,
        snapshot: extractionSnapshot(
          targetRuleId,
          fieldKeysByRuleId?.[targetRuleId] ?? fieldKeysForRule(targetRuleId),
        ),
      };
    });
    if (skipExistingMatchingFieldSet) {
      launchPlans = launchPlans.filter(({ document, snapshot }) =>
        !(projectAtLaunch?.results ?? []).some(
          (row) =>
            row.contractId === document.id &&
            row.ruleId === snapshot.ruleId &&
            row.fieldSetId === snapshot.fieldSetId,
        ),
      );
    }
    if (!launchPlans.length) {
      setError("所选文件均已有相同模板和字段组合的底稿。");
      return;
    }
    const targetDocuments = launchPlans.map((item) => item.document);
    const groups = new Map<
      string,
      { snapshot: AudiPickExtractionSnapshot; documents: AudiPickDocument[] }
    >();
    for (const item of launchPlans) {
      const current = groups.get(item.snapshot.ruleId);
      if (current) current.documents.push(item.document);
      else
        groups.set(item.snapshot.ruleId, {
          snapshot: item.snapshot,
          documents: [item.document],
        });
    }
    setError("");
    try {
      const textStates = await Promise.all(
        targetDocuments.map(async (document) => {
          const value = (await engineCall("audipick.document_text", {
            documentId: document.id,
          })) as { text?: string };
          return {
            document,
            ready:
              Boolean(value.text?.trim()) &&
              !getContractMeta(document.id).ocrPending,
          };
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
      for (const group of groups.values()) {
        const groupDocuments = group.documents;
        const snapshot = group.snapshot;
        const prompt = `${window.RuleEngine?.getRulePrompt(snapshot.ruleId) ?? ""}\n\n本次仅返回这些字段：${snapshot.fieldKeys.join(", ")}`;
        if (snapshot.ruleId === "loan_covenant") {
          const { active: caseVersion } = await loadCaseLibraryState();
          if (!projectAtLaunch) {
            throw new Error("批量提取时找不到当前项目，请刷新后重试。");
          }
          const operation = beginAudiPickOperation("批量限制性契约提取", true);
          const relations = projectAtLaunch.project.relationGroups ?? [];
          const relatedMembers = new Set(
            relations.flatMap((relation) =>
              relation.members.map((member) => member.fileId),
            ),
          );
          const anchors = groupDocuments.filter(
            (document) => !relatedMembers.has(document.id),
          );
          if (!anchors.length) {
            operation.finish(
              "failed",
              "所选文件都是关联资料，请同时选择其主合同后再提取。",
            );
            throw new Error("所选文件都是关联资料，请同时选择其主合同后再提取。");
          }
          anchors.forEach((document) =>
            extractingDocumentIdsRef.current.add(document.id),
          );
          setExtractingDocumentIds(new Set(extractingDocumentIdsRef.current));
          let completed = 0;
          try {
            for (const anchor of anchors) {
              await operation.checkpoint();
              operation.update(
                `正在准备 ${anchor.name} 的合同组…`,
                completed,
                anchors.length,
              );
              const anchorText = textStates.find(
                (item) => item.document.id === anchor.id,
              );
              if (!anchorText?.ready)
                throw new Error(`${anchor.name} 尚未生成完整文字层。`);
              const source = (await engineCall("audipick.document_text", {
                documentId: anchor.id,
              })) as { text?: string };
              if (!source.text?.trim())
                throw new Error(`${anchor.name} 没有可用文字。`);
              const bundle: CovenantDocument[] = [
                { id: anchor.id, name: anchor.name, text: source.text },
              ];
              const relation = relations.find(
                (item) => item.anchorFileId === anchor.id,
              );
              for (const member of relation?.members ?? []) {
                const document = documents.find(
                  (item) => item.id === member.fileId,
                );
                if (!document) continue;
                if (getContractMeta(document.id).ocrPending) {
                  throw new Error(
                    `${document.name} 尚未完成文字识别，请先继续 OCR。`,
                  );
                }
                const linked = (await engineCall("audipick.document_text", {
                  documentId: document.id,
                })) as { text?: string };
                if (!linked.text?.trim()) {
                  throw new Error(
                    `${document.name} 没有可用文字，请先读取文字 / OCR。`,
                  );
                }
                bundle.push({
                  id: document.id,
                  name: document.name,
                  text: linked.text,
                });
              }
              const covenantCacheKey = extractionCacheKey(
                anchor.id,
                snapshot.ruleId,
                snapshot.fieldSetId,
                `${COVENANT_EXTRACTION_VERSION}\u0000${caseVersion.hash}\u0000${bundle.map((document) => `${document.id}\u0000${document.text}`).join("\u0001")}`,
              );
              let outcome = covenantCache.current.get(covenantCacheKey);
              if (outcome) {
                operation.update(`${anchor.name}：文字和提取版本未变化，复用本次会话已核验结果…`, completed, anchors.length);
              } else {
                outcome = await extractCovenantEvidence({
                  caseLibrary: caseVersion.library,
                  documents: bundle,
                  extract: ({ prompt: stagePrompt, text }) =>
                    withRetry(
                      () =>
                        runAudiPickExtractJob<{
                          parsed?: unknown;
                          finish_reason?: string;
                        }>({
                          documentId: anchor.id,
                          ruleId: snapshot.ruleId,
                          ruleName: snapshot.ruleName,
                          ruleVersion: snapshot.ruleVersion,
                          fieldKeys: snapshot.fieldKeys,
                          fieldSetId: snapshot.fieldSetId,
                          prompt: stagePrompt,
                          text,
                        }, operation),
                      3,
                      2_000,
                      (remaining) =>
                        operation.update(
                          `${anchor.name} 调用失败，正在重试，还剩 ${remaining} 次…`,
                          completed,
                          anchors.length,
                        ),
                    ),
                  onProgress: (message) =>
                    operation.update(
                      `${anchor.name}：${message}`,
                      completed,
                      anchors.length,
                    ),
                });
                covenantCache.current.set(covenantCacheKey, outcome);
              }
              await operation.checkpoint();
              await saveExtractedItemsFor(
                projectAtLaunch.project.id,
                anchor.id,
                snapshot,
                outcome.items,
              );
              completed += 1;
              const repaymentItems = filterCovenantScope(
                outcome.items,
                "repayment",
              ).length;
              const supplementaryItems = filterCovenantScope(
                outcome.items,
                "supplementary",
              ).length;
              addLog(
                anchor.name,
                "批量契约关联提取",
                `已保存财务契约 ${repaymentItems} 项，待新增案例 ${outcome.items.filter(row => row._covenant_pending_case === true).length} 项${outcome.unresolvedCount ? `（原始失败记录 ${outcome.unresolvedRecordCount} 条，原因见底稿诊断）` : ""}`,
                outcome.unresolvedCount ? "warn" : "done",
              );
              if (outcome.unresolvedCount) throw new Error(`${anchor.name} 已保存可核实结果，但有 ${outcome.unresolvedCount} 组关联未完成（原始失败记录 ${outcome.unresolvedRecordCount} 条），请查看底稿诊断。`);
              operation.update(
                `${anchor.name} 已保存。`,
                completed,
                anchors.length,
              );
            }
            operation.finish(
              "completed",
              `批量提取完成，已保存 ${completed} 个合同组。`,
            );
          } catch (error) {
            const message = errorText(error);
            const cancelled =
              (error instanceof Error &&
                error.name === "AudiPickExtractCancelled") ||
              /取消|停止|终止/.test(message);
            operation.finish(
              cancelled ? "cancelled" : "failed",
              cancelled
                ? `批量提取已终止，已保存 ${completed} 个合同组。`
                : completed
                ? `已保存前 ${completed} 个合同组；当前合同组失败：${message}`
                : `批量提取失败：${message}`,
            );
            throw error;
          } finally {
            anchors.forEach((document) =>
              extractingDocumentIdsRef.current.delete(document.id),
            );
            setExtractingDocumentIds(new Set(extractingDocumentIdsRef.current));
          }
          continue;
        }
        const operation = beginAudiPickOperation(
          `批量提取 · ${snapshot.ruleName}`,
          true,
        );
        groupDocuments.forEach((document) =>
          extractingDocumentIdsRef.current.add(document.id),
        );
        setExtractingDocumentIds(new Set(extractingDocumentIdsRef.current));
        let completed = 0;
        let failed = 0;
        let cancelled = false;
        try {
          for (let offset = 0; offset < groupDocuments.length; offset += 3) {
            await operation.checkpoint();
            const batch = groupDocuments.slice(offset, offset + 3);
            operation.update(
              `正在提取 ${batch.map((document) => document.name).join("、")}`,
              completed,
              groupDocuments.length,
            );
            const settled = await Promise.allSettled(
              batch.map(async (document) => {
                const stored = (await engineCall("audipick.document_text", {
                  documentId: document.id,
                })) as { text?: string };
                if (!stored.text?.trim()) {
                  throw new Error(`${document.name} 没有可用文字。`);
                }
                const value = await withRetry(
                  () =>
                    runAudiPickExtractJob<{
                      parsed?: { items?: unknown[] };
                    }>(
                      {
                        documentId: document.id,
                        ruleId: snapshot.ruleId,
                        ruleName: snapshot.ruleName,
                        ruleVersion: snapshot.ruleVersion,
                        fieldKeys: snapshot.fieldKeys,
                        fieldSetId: snapshot.fieldSetId,
                        prompt,
                        text: stored.text,
                      },
                      operation,
                    ),
                  3,
                  2_000,
                  (remaining) =>
                    operation.update(
                      `${document.name} 调用失败，正在重试，还剩 ${remaining} 次…`,
                      completed,
                      groupDocuments.length,
                    ),
                );
                const items = (Array.isArray(value.parsed?.items)
                  ? value.parsed.items
                  : [])
                  .filter(
                    (item): item is Record<string, unknown> =>
                      Boolean(item && typeof item === "object"),
                  )
                  .map((item) =>
                    Object.fromEntries(
                      Object.entries(item).filter(([key]) =>
                        snapshot.fieldKeys.includes(key),
                      ),
                    ),
                  );
                return { document, items };
              }),
            );
            for (const outcome of settled) {
              if (outcome.status === "fulfilled") {
                await saveExtractedItemsFor(
                  projectAtLaunch?.project.id ?? projectId,
                  outcome.value.document.id,
                  snapshot,
                  outcome.value.items,
                );
                completed += 1;
                addLog(
                  outcome.value.document.name,
                  "批量提取",
                  `已保存 ${outcome.value.items.length} 条`,
                  "done",
                );
              } else {
                const message = errorText(outcome.reason);
                if (
                  (outcome.reason instanceof Error &&
                    outcome.reason.name === "AudiPickExtractCancelled") ||
                  /取消|停止|终止/.test(message)
                ) {
                  cancelled = true;
                } else {
                  failed += 1;
                  addLog("批量合同", "批量提取", message, "error");
                }
              }
            }
            operation.update(
              `已保存 ${completed} 份${failed ? `，${failed} 份失败` : ""}`,
              completed + failed,
              groupDocuments.length,
            );
            if (cancelled) break;
          }
          operation.finish(
            cancelled ? "cancelled" : failed ? "failed" : "completed",
            cancelled
              ? `批量提取已终止，已保存 ${completed} 份。`
              : `批量提取结束，已保存 ${completed} 份${failed ? `，${failed} 份失败` : ""}。`,
          );
        } catch (cause) {
          const message = errorText(cause);
          const stopped =
            (cause instanceof Error &&
              cause.name === "AudiPickExtractCancelled") ||
            /取消|停止|终止/.test(message);
          operation.finish(
            stopped ? "cancelled" : "failed",
            stopped
              ? `批量提取已终止，已保存 ${completed} 份。`
              : `批量提取失败：${message}`,
          );
          if (!stopped) throw cause;
        } finally {
          groupDocuments.forEach((document) =>
            extractingDocumentIdsRef.current.delete(document.id),
          );
          setExtractingDocumentIds(new Set(extractingDocumentIdsRef.current));
        }
      }
    } catch (e) {
      const message = errorText(e);
      if (!/取消|停止|终止/.test(message)) setError(message);
    }
  }
  async function saveFieldPreferences(
    fieldKeysByRuleId: Record<string, string[]>,
  ) {
    const target = projectsRef.current.find(
      (item) => item.project.id === selectedId,
    );
    if (!target) throw new Error("当前项目已不存在，请刷新后重试。");
    const saved: AudiPickProjectData = {
      ...target,
      project: {
        ...target.project,
        fieldPrefs: {
          ...(target.project.fieldPrefs ?? {}),
          ...fieldKeysByRuleId,
        },
        updatedAt: new Date().toISOString(),
      },
    };
    await engineCall("audipick.project_save", saved);
    projectsRef.current = projectsRef.current.map((item) =>
      item.project.id === selectedId ? saved : item,
    );
    setProjects(projectsRef.current);
  }
  async function confirmFieldSelection(
    selection: AudiPickFieldSelectionResult,
  ) {
    const request = fieldDialogRequest;
    if (!request || !selected) return;
    setFieldDialogSubmitting(true);
    try {
      await saveFieldPreferences(selection.fieldKeysByRuleId);
      if (selection.fieldKeysByRuleId[ruleId]) {
        setSelectedFieldKeys(selection.fieldKeysByRuleId[ruleId]);
      }
      setFieldDialogRequest(undefined);
      if (request.mode === "batch") {
        void startBatch(
          request.documentIds,
          selection.fieldKeysByRuleId,
          selection.skipExistingMatchingFieldSet,
        );
        return;
      }
      const documentId = request.documentIds[0];
      const targetMeta = getContractMeta(documentId);
      const targetRuleId =
        targetMeta.ruleId ?? selected.project.defaultRuleId ?? ruleId;
      const stored = (await engineCall("audipick.document_text", {
        documentId,
      })) as { text?: string };
      if (!stored.text?.trim()) {
        throw new Error("当前合同没有可用文字，请先完成文字读取或 OCR。");
      }
      void extract({
        projectId: selected.project.id,
        documentId,
        snapshot: extractionSnapshot(
          targetRuleId,
          selection.fieldKeysByRuleId[targetRuleId] ??
            fieldKeysForRule(targetRuleId),
        ),
        text: stored.text,
        openWorkpaperOnComplete: false,
      });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setFieldDialogSubmitting(false);
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
  async function saveProcedureLevel(rowId: string, value: string) {
    if (!selected || busy) return;
    const level = procedureOverride(value);
    if (value !== "auto" && level === undefined) return;
    const projectId = selected.project.id;
    const saved = {
      ...selected,
      results: (selected.results ?? []).map((row) => {
        if (String(row.id) !== rowId || row.ruleId !== "loan_covenant") return row;
        const next: AudiPickResult = { ...row, reviewed: false };
        if (level === undefined) delete next[PROCEDURE_OVERRIDE_KEY];
        else next[PROCEDURE_OVERRIDE_KEY] = level;
        return next;
      }),
    };
    setBusy(true);
    setError("");
    try {
      await engineCall("audipick.project_save", saved);
      setProjects((current) => current.map((project) => project.project.id === projectId ? saved : project));
      setResult({ procedureLevelSaved: true });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
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
  async function exportResults(filtered = false) {
    const rows = ruleId === "loan_covenant"
      ? (filtered ? workpaperRows : filterCovenantScope(currentResults, covenantScopeFilter))
        .filter((row) => ["repayment", "supplementary"].includes(covenantScope(row)))
      : currentResults;
    if (!rows.length) {
      setError(ruleId === "loan_covenant"
        ? "限制性契约暂无可导出的已核实结果；无明确后果的记录仅保留在待核实，不进入正式底稿。"
        : "当前合同和模板还没有提取结果。");
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
        typeLabel: filtered ? `${typeLabel}_筛选结果` : typeLabel,
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
      const covenantRows = ruleId === "loan_covenant" ? covenantExportRows(rows, (row) => documents.find((document) => document.id === row.contractId)?.name ?? String(row.contractId ?? "")) : undefined;
      const exportRows = covenantRows ?? checklist ?? rows;
      setResult(
        await engineCall("audipick.export", {
          ruleId,
          results: exportRows,
          columns: covenantRows ? [...new Set(covenantRows.flatMap((row) => Object.keys(row)))] : checklist?.length ? Object.keys(checklist[0]) : undefined,
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
        (row) =>
          (scope === "project" || row.contractId === selectedDocument) &&
          (row.ruleId !== "loan_covenant" ||
            isFormalCovenantRow(row)),
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
      const exportedRows = sheetRuleId === "loan_covenant" ? covenantExportRows(rows, (row) => documents.find((document) => document.id === row.contractId)?.name ?? String(row.contractId ?? "")) : rows.map((row) => ({
        文件名称:
          documents.find((document) => document.id === row.contractId)?.name ??
          String(row.contractId ?? ""),
        ...editableResult(row),
      }));
      const columns = sheetRuleId === "loan_covenant"
        ? Object.values(rows.every(row => row._financial_metrics_only === true) ? COVENANT_LABELS : LEGACY_COVENANT_LABELS)
        : [
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
  const fieldDialogGroups: AudiPickFieldSelectionGroup[] = (() => {
    if (!fieldDialogRequest || !selected) return [];
    const grouped = new Map<string, string[]>();
    for (const documentId of fieldDialogRequest.documentIds) {
      const meta = getContractMeta(documentId);
      const targetRuleId =
        meta.ruleId ?? selected.project.defaultRuleId ?? ruleId;
      const names = grouped.get(targetRuleId) ?? [];
      names.push(
        documents.find((document) => document.id === documentId)?.name ??
          documentId,
      );
      grouped.set(targetRuleId, names);
    }
    return [...grouped.entries()].map(([targetRuleId, documentNames]) => {
      const targetRule = rules.find((item) => item.id === targetRuleId);
      const pageKey = window.RuleEngine?.pageKeyForRule?.(targetRuleId);
      return {
        ruleId: targetRuleId,
        ruleName: targetRule?.name ?? targetRuleId,
        ruleVersion: targetRule?.version,
        fields: (window.RuleEngine?.getFieldsForRule(targetRuleId) ?? []).map(
          (field) => ({
            ...field,
            required: Boolean(pageKey && field.key === pageKey),
          }),
        ),
        selectedFieldKeys: fieldKeysForRule(targetRuleId),
        documentNames,
        allFieldsRequired: targetRuleId === "revenue_workpaper",
        description:
          targetRuleId === "revenue_workpaper"
            ? "收入底稿字段相互关联，本模板固定保留全部字段。"
            : "页码字段强制保留，其他字段可按本次需要勾选。",
      };
    });
  })();
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
  const inferredAssociationRoles = new Map(
    associationDocuments.map((document) => [document.id, associationRoleForDocument(document)] as const),
  );
  const legacyProjectDocuments = documents.map((document) => {
    const meta = getContractMeta(document.id);
    const rows = selected?.results?.filter((row) => row.contractId === document.id) ?? [];
    return {
      id: document.id,
      name: document.name,
      textLength: documentTextLengths[document.id] ?? 0,
      isScanned: meta.isScanned,
      ocrPending: meta.ocrPending,
      status: document.status,
      resultCount: rows.length,
      appliedRuleCount: new Set(rows.map((row) => String(row.ruleId ?? ""))).size,
      ruleId: meta.ruleId ?? selected?.project.defaultRuleId,
      ruleConfirmed: meta.ruleConfirmed,
      detectedRuleId: meta.detectedRuleId,
      detectedConfidence: meta.detectedConfidence,
      detectedLabel: meta.detectedLabel,
      associationRole: relationMemberRoles.get(document.id) ?? inferredAssociationRoles.get(document.id) ?? null,
      extracting: extractingDocumentIds.has(document.id),
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
  const keywordRows = currentResults.filter((row) => {
    const query = workpaperFilter.trim().toLocaleLowerCase("zh-CN");
    const content = editableResult(row);
    return !query || JSON.stringify(content).toLocaleLowerCase("zh-CN").includes(query);
  });
  const workpaperRows = ruleId === "loan_covenant"
    ? (legacyCovenantResult
      ? filterCovenantRows(filterCovenantScope(keywordRows, covenantScopeFilter), procedureFilter, procedureReviewOnly)
      : keywordRows.filter(row => row._financial_metrics_only === true))
    : keywordRows;
  const covenantScopeCounts = Object.fromEntries(
    Object.keys(COVENANT_WORKPAPER_SCOPES).map((scope) => [
      scope,
      filterCovenantScope(currentResults, scope as CovenantScopeFilter).length,
    ]),
  );
  const ocrDisplayLabel = configStatus.ocr?.engine === "baidu"
    ? "百度OCR"
    : configStatus.ocr?.engine === "local"
      ? "本机OCR"
      : "AI视觉";
  const logDrawer = (
    <div className="ap-legacy-log-panel">
      <div className="section-title"><h3>处理工作日志</h3><button className="secondary" onClick={() => setLogOpen(false)}>关闭</button></div>
      <div className="worklog-list">
        {workLog.length === 0 ? <p className="hint">暂无处理记录</p> : workLog.map((entry) => <div key={entry.id} className={`worklog-item worklog-${entry.status}`}><strong>{entry.fileName}</strong><span>{entry.step}</span><small>{entry.detail} · {entry.time}</small></div>)}
      </div>
      <div className="actions"><button className="secondary" onClick={clearLog}>清空</button><button className="secondary" disabled={!workLog.length} onClick={() => void exportWorkLog()}>导出</button></div>
    </div>
  );

  const useParityShell = true as boolean;
  if (useParityShell) return (
    <AudiPickLegacyShell
      activePage={viewMode}
      configReady={Boolean(configStatus.llm?.ready)}
      logCount={workLog.length}
      logOpen={logOpen}
      onNavigate={(page) => {
        setViewMode(page);
        setLoanAuditOpen(false);
        if (page !== "workbench") {
          setSelectedId("");
          setSelectedDocument("");
        }
      }}
      onBackToToolbox={() => navigate("/")}
      onToggleLog={() => setLogOpen((open) => !open)}
      logDrawer={logDrawer}
    >
      {viewMode === "home" && (
        <AudiPickLegacyHome
          onStart={() => setViewMode("workbench")}
          onConfig={() => setViewMode("config")}
        />
      )}
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
            busy={busy || extractingDocumentIds.has(selectedDocument)}
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
            associationSuggestions={pendingAssociationSuggestions}
            selectedDocumentIds={selectedDocumentIds}
            busy={busy}
            ocrLabel={ocrDisplayLabel}
            ocrTask={legacyOcrTask}
            uploadStatus={preparationStatus}
            showLoanAudit={(selected.results ?? []).some(
              (row) => row.ruleId === "loan_general",
            )}
            onSelectionChange={setSelectedDocumentIds}
            actions={{
              onBack: () => { setSelectedId(""); setSelectedDocument(""); },
              onBatchExtract: (ids) =>
                setFieldDialogRequest({ mode: "batch", documentIds: ids }),
              onOpenLoanAudit: () => setLoanAuditOpen(true),
              onExportProject: () => exportProjectResults("project"),
              onPickPdfs: importPdfs,
              onPickFolder: importPdfFolder,
              onResumeOcr: (id) => prepareDocuments([{ id, name: documents.find((item) => item.id === id)?.name ?? id }], selectedId),
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
              onRuleChange: async (id, nextRuleId) => { await saveContractRuleSelection(id, nextRuleId, false); },
              onConfirmRule: async (id, nextRuleId) => { await saveContractRuleSelection(id, nextRuleId, true); },
              onExtractDocument: (id) =>
                setFieldDialogRequest({ mode: "single", documentIds: [id] }),
              onViewWorkpaper: async (id, nextRuleId) => { setRuleId(nextRuleId ?? getContractMeta(id).ruleId ?? selected.project.defaultRuleId ?? "loan_covenant"); setContractView("workpaper"); await openDocument(id); },
              onManageAssociation: async (id) => { setAssociationSuggestion(undefined); setAssociationAnchor(id); },
              onRemoveAssociation: removeAssociation,
              onConfirmAssociation: async (fileId, anchorId, suggestion) => {
                setAssociationSuggestion({
                  fileId,
                  role: suggestion.role,
                  source: "ai-confirmed",
                  confidence: suggestion.confidence,
                  reason: suggestion.reason,
                });
                setAssociationAnchor(anchorId);
              },
              onDismissAssociation: dismissAssociation,
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
              ruleVersion: selectedRule?.version ?? "1.0",
              detectedLabel: activeMeta?.detectedLabel ?? suggestedRule?.docLabel,
              detectedConfidence: (activeMeta?.detectedConfidence ?? suggestedRule?.confidence) as "high" | "medium" | "low" | undefined,
              detectedReason: suggestedRule?.reason,
              ruleConfirmed: Boolean(activeMeta?.ruleConfirmed),
              resultCount: currentResults.length,
              versionCount: resultRuns.length,
              appliedRuleCount: new Set(activeDocumentAllRows.map((row) => String(row.ruleId ?? ""))).size,
              associationSummary: relationMemberRoles.has(selectedDocument) ? `已作为${relationMemberRoles.get(selectedDocument)}关联` : undefined,
              extractDisabled: !pdfText.trim() || !configStatus.llm?.ready || Boolean(activeMeta?.ocrPending),
              onRuleChange: (nextRuleId) => { setRuleId(nextRuleId); void saveContractRuleSelection(selectedDocument, nextRuleId, false); },
              onConfirmRule: (nextRuleId) => void saveContractRuleSelection(selectedDocument, nextRuleId, true),
              onManageAssociation: () => { setAssociationSuggestion(undefined); setAssociationAnchor(selectedDocument); },
              onExtract: () =>
                setFieldDialogRequest({
                  mode: "single",
                  documentIds: [selectedDocument],
                }),
              onExportCurrent: () => void exportResults(),
              onExportAll: () => void exportProjectResults("document"),
            }}
            workpaper={{
              ruleId,
              rules: ruleOptions,
              usedRuleName: activeResultRuleName,
              usedRuleVersion: activeResultRuleVersion,
              versions: resultRuns.map((run, index) => ({ id: run.id, label: `${index === 0 ? "最新 · " : ""}${run.extractAt ? new Date(run.extractAt).toLocaleString() : `版本 ${resultRuns.length - index}`}`, count: run.rows.length })),
              versionId: activeResultRun?.id ?? "latest",
              filterText: workpaperFilter,
              totalCount: legacyCovenantResult
                ? currentResults.filter(row => ["repayment", "supplementary"].includes(covenantScope(row))).length
                : currentResults.length,
              procedureFilter,
              procedureReviewOnly,
              covenantScopeFilter,
              covenantScopeCounts,
              covenantDiagnostics: ruleId === "loan_covenant" ? covenantDiagnosticGroups(matchedResults) : [],
              pendingCases: ruleId === "loan_covenant" ? matchedResults.filter(row => row._covenant_pending_case === true).map(row => ({ id: String(row.id), values: covenantUserView(row) })) : [],
              onCovenantScopeChange: setCovenantScopeFilter,
              onProcedureFilterChange: setProcedureFilter,
              onProcedureReviewChange: setProcedureReviewOnly,
              onProcedureLevelChange: (rowId, value) => void saveProcedureLevel(rowId, value),
              onExportFiltered: () => void exportResults(true),
              columns: (ruleId === "loan_covenant"
                ? Object.entries(legacyCovenantResult ? LEGACY_COVENANT_LABELS : COVENANT_LABELS).map(([key, label]) => ({ key, label }))
                : fields
              ).map((field) => ({
                key: field.key,
                label: field.label,
                editable: ruleId !== "loan_covenant" || !["procedure_level", "consequence_display", "audit_procedure"].includes(field.key),
                long: /原文|摘要|提示|说明|后果|审计程序/.test(field.label),
              })),
              rows: workpaperRows.map((row) => ({
                id: String(row.id),
                reviewed: Boolean(row.reviewed),
                values: ruleId === "loan_covenant" ? covenantUserView(editableResult(row)) : editableResult(row),
              })),
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
            onBackWorkbench={() => closeDocument(true)}
            onManageCaseLibrary={() => setViewMode("config")}
            onBackProject={() => closeDocument()}
            onViewChange={setContractView}
            onTogglePreview={() => {
              if (previewOpen) setPreviewOpen(false);
              else void openPdfPreview();
            }}
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
      {viewMode === "config" && <><AudiPickLegacyConfig status={configStatus} onSaved={() => void refreshConfigStatus()} /><CovenantCaseLibraryManager /></>}
      {associationAnchor && selected && <AudiPickAssociationDialog key={associationAnchor}
        anchorId={associationAnchor} documents={documents} groups={selected.project.relationGroups ?? []}
        suggestion={associationSuggestion} onClose={() => setAssociationAnchor("")}
        onSave={async (members) => {
          const target = projectsRef.current.find((item) => item.project.id === selectedId);
          if (!target) throw new Error("项目已不存在。");
          const previous = target.project.relationGroups ?? [];
          const existing = previous.find((group) => group.anchorFileId === associationAnchor);
          const groups = previous.filter((group) => group.anchorFileId !== associationAnchor);
          if (members.length) groups.push({ id: existing?.id ?? `g_${Date.now().toString(36)}`, anchorFileId: associationAnchor, members });
          const linkedPairs = new Set(members.map((member) => `${associationAnchor}>${member.fileId}`));
          const dismissedAssociations = (target.project.dismissedAssociations ?? []).filter((pair) => !linkedPairs.has(pair));
          const saved = { ...target, project: { ...target.project, relationGroups: groups, dismissedAssociations, updatedAt: new Date().toISOString() } };
          await engineCall("audipick.project_save", saved);
          projectsRef.current = projectsRef.current.map((item) => item.project.id === selectedId ? saved : item);
          setProjects(projectsRef.current);
        }}
      />}
      <AudiPickFieldSelectionDialog
        open={Boolean(fieldDialogRequest)}
        mode={fieldDialogRequest?.mode ?? "single"}
        groups={fieldDialogGroups}
        submitting={fieldDialogSubmitting}
        onClose={() => setFieldDialogRequest(undefined)}
        onConfirm={(selection) => void confirmFieldSelection(selection)}
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
            <Button
              variant="default"
              disabled={!selectedId || busy}
              onClick={() => void importPdfs()}
            >
              选择 PDF
            </Button>
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
              <strong title={value.name} className="block max-w-full truncate">{value.name}</strong>
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
              <Button
                variant="destructive"
                aria-label={`删除合同 ${value.name}`}
                onClick={() => void deleteDocument(value.id)}
              >
                删除
              </Button>
            </div>
          ))}
          {documents.length === 0 && <EmptyState compact title={selectedId ? "等待导入合同" : "请先选择项目"} description={selectedId ? "导入 PDF 后，可预览原文、识别文字并按模板提取信息。" : "新建或选择项目后，再导入需要审阅的 PDF。"} />}
          {error && <div className="error-box">{error}</div>}
        </section>
        <section className="form-card">
          <div className="section-title">
            <h2>模板与字段</h2>
            <span
              className={`pill ${configStatus.llm?.ready ? "ready" : "preview"}`}
            >
              AI 服务{configStatus.llm?.ready ? "已就绪" : "未配置"}
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
                <Button
                  variant="secondary"
                  onClick={() => {
                    setRuleId(suggestedRule.ruleId);
                    setSuggestedRule(undefined);
                  }}
                >
                  采用建议模板
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setSuggestedRule(undefined)}
                >
                  保留当前模板
                </Button>
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
          <Button
            variant="secondary"
            disabled={!selectedDocument || !associationTarget}
            onClick={() => void saveAssociation()}
          >
            保存关联
          </Button>
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
            <Button variant="secondary" onClick={() => void saveCustomRule()}>
              保存自定义模板
            </Button>
          </details>
          <div className="actions">
            <Button
              variant="secondary"
              disabled={busy || !selectedDocument}
              onClick={() => void runOcr()}
            >
              识别当前页文字
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !pdfText}
              onClick={() => void saveText()}
            >
              保存文字
            </Button>
            <Button
              variant="default"
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
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !selectedDocument}
              onClick={() => void exportResults()}
            >
              导出底稿
            </Button>
            <button
              className="secondary"
              disabled={busy || !selectedDocument}
              onClick={() => void exportProjectResults("document")}
            >
              导出本文件全部模板
            </button>
            {ruleId === "revenue_workpaper" && (
              <Button
                variant="secondary"
                disabled={busy || !currentResults.length}
                onClick={() => void deepReview()}
              >
                深度复核
              </Button>
            )}
            {!batchJob ||
            ["completed", "failed", "cancelled"].includes(batchJob.phase) ? (
              <Button
                variant="default"
                disabled={
                  !configStatus.llm?.ready ||
                  !documents.length ||
                  !activeFieldKeys.length
                }
                onClick={() => void startBatch()}
              >
                批量提取
              </Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  onClick={() => toggleJobPause(batchJob.jobId)}
                >
                  {isJobPaused(batchJob.jobId) ? "继续" : "暂停"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void jobCancel(batchJob.jobId)}
                >
                  停止
                </Button>
              </>
            )}
          </div>
          {batchJob && (
            <JobProgress job={batchJob} />
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
          <h2>合同原文与提取结果</h2>
          <AudiPickResultStatus hasResult={Boolean(result)} missingCount={revenueMissingTasks.length} />
          {pdfDocument && (
            <>
              <div className="pdf-toolbar">
                <Button
                  variant="secondary"
                  disabled={pdfPage <= 1}
                  onClick={() => void renderPdfPage(pdfDocument, pdfPage - 1)}
                >
                  上一页
                </Button>
                <span>
                  {pdfPage} / {pdfPages}
                </span>
                <Button
                  variant="secondary"
                  disabled={pdfPage >= pdfPages}
                  onClick={() => void renderPdfPage(pdfDocument, pdfPage + 1)}
                >
                  下一页
                </Button>
                <Button
                  variant="secondary"
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
                </Button>
                <Button
                  variant="secondary"
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
                </Button>
                <Button
                  variant="secondary"
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
                </Button>
              </div>
              <div className="input-with-button">
                <input
                  value={pdfSearch}
                  onChange={(e) => setPdfSearch(e.target.value)}
                  placeholder="搜索 PDF 原文"
                />
                <Button variant="outline" onClick={() => void searchPdf()}>
                  搜索
                </Button>
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
            <EmptyState compact title={selectedDocument ? "尚无处理结果" : "请先选择合同"} description={selectedDocument ? "读取合同文字，选择模板后开始提取；完成后请对照原文核对。" : "在合同列表中选择“读取/预览”，即可查看原文并继续处理。"} />
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
                  <Button
                    variant="secondary"
                    onClick={() => void jumpEvidence(row)}
                  >
                    证据页
                  </Button>
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
                AI 服务{configStatus.llm?.ready ? "已就绪" : "未配置"}
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
                <Button
                  variant="secondary"
                  onClick={() => void saveCustomRule()}
                >
                  {editingCustomRuleId ? "保存修改" : "保存自定义模板"}
                </Button>
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
            <EmptyState compact title="暂无处理记录" description="导入 PDF、文字识别和智能提取的处理记录会显示在这里。" />
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
            <p>点击“读取/预览”。正常文字层直接读取；扫描页或明显乱码的文字层会逐页自动 OCR，并在每页完成后保存进度。</p>
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
