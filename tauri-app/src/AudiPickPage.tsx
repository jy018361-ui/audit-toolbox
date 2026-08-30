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
  audipickExportName,
  buildClassifyPrompt,
  buildRevenueBatchPrompt,
  buildRevenueQuestionBatches,
  classifySample,
  extractionCacheKey,
  groupRevenueDetailQuestions,
  latestFieldSetId,
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
};
type AudiPickProjectData = {
  project: {
    id: string;
    name: string;
    client?: string;
    date?: string;
    status?: string;
    relationGroups?: AudiPickRelation[];
  };
  contracts?: unknown[];
  results?: AudiPickResult[];
};
type AudiPickDocument = {
  id: string;
  name: string;
  path: string;
  sha256: string;
  size: number;
  status: string;
};

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
  // 模板库视图状态：分类 tab + 搜索词
  const [templateTab, setTemplateTab] = useState("all");
  const [templateSearch, setTemplateSearch] = useState("");
  const [customRulePrompt, setCustomRulePrompt] = useState("");
  const [ruleRevision, setRuleRevision] = useState(0);
  const [suggestedRule, setSuggestedRule] = useState<ClassifiedDocument>();
  const extractCache = useRef(
    new Map<string, Array<{ parsed?: { items?: unknown[] } }>>(),
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
  const [configStatus, setConfigStatus] = useState<{
    llm?: { ready: boolean };
    ocr?: { ready: boolean; engine: string };
  }>({});
  // 顶层视图：工作台 / 提取模板库 / 处理工作日志
  const [viewMode, setViewMode] = useState<"workbench" | "templates" | "worklog">(
    "workbench",
  );
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
  const visibleFieldSetId =
    latestFieldSetId(documentResults) ?? activeFieldSetId;
  const matchedResults = documentResults.filter(
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
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const value = (await engineCall("audipick.projects", {})) as {
        projects: AudiPickProjectData[];
      };
      setProjects(value.projects);
      if (!selectedId && value.projects[0])
        setSelectedId(value.projects[0].project.id);
      setResult(value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
    void engineCall("audipick.config_status", {})
      .then((value) => setConfigStatus(value as typeof configStatus))
      .catch(() => undefined);
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
      return;
    }
    void engineCall("audipick.documents", { projectId: selectedId })
      .then((value) =>
        setDocuments((value as { documents: AudiPickDocument[] }).documents),
      )
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
    let off = () => {};
    void listenJobEvents((event) => {
      if (event.toolId !== "audipick") return;
      setBatchJob(event);
      if (event.result) setResult(event.result);
      if (event.phase === "completed" && event.result && selected) {
        const payload = event.result as {
          documents?: Array<{
            id: string;
            ok: boolean;
            parsed?: { items?: unknown[] };
          }>;
        };
        const incoming = (payload.documents ?? []).flatMap((document) =>
          document.ok && Array.isArray(document.parsed?.items)
            ? document.parsed.items
                .filter((item): item is Record<string, unknown> =>
                  Boolean(item && typeof item === "object"),
                )
                .map((item, index) => ({
                  ...item,
                  id: `r_${Date.now().toString(36)}_${document.id}_${index}`,
                  contractId: document.id,
                  ruleId,
                  fieldKeys: activeFieldKeys,
                  fieldSetId: activeFieldSetId,
                  extractAt: new Date().toISOString(),
                  reviewed: false,
                }))
            : [],
        );
        const documentIds = new Set(
          (payload.documents ?? []).map((document) => document.id),
        );
        const saved = {
          ...selected,
          results: [
            ...(selected.results ?? []).filter(
              (row) =>
                !(
                  documentIds.has(String(row.contractId)) &&
                  row.ruleId === ruleId &&
                  row.fieldSetId === activeFieldSetId
                ),
            ),
            ...incoming,
          ],
        };
        void engineCall("audipick.project_save", saved).then(() =>
          setProjects((current) =>
            current.map((project) =>
              project.project.id === selectedId ? saved : project,
            ),
          ),
        );
      }
    }).then((value) => {
      off = value;
    });
    return () => off();
  }, [selectedId, ruleId, selected, fields]);
  async function create() {
    if (!name.trim()) {
      setError("请输入项目名称。");
      return;
    }
    const id = `p_${Date.now().toString(36)}`;
    const data: AudiPickProjectData = {
      project: {
        id,
        name: name.trim(),
        client: client.trim(),
        date: new Date().toISOString().slice(0, 10),
        status: "active",
      },
      contracts: [],
      results: [],
    };
    setBusy(true);
    try {
      await engineCall("audipick.project_save", data);
      setName("");
      setClient("");
      setSelectedId(id);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!selectedId) return;
    // Deleting a project also drops every PDF, extraction result and review
    // mark under it, and there is no undo.
    const project = projects.find((item) => item.project.id === selectedId);
    if (
      !window.confirm(
        `确认删除项目"${project?.project.name ?? selectedId}"？\n\n该项目下的全部合同 PDF、提取结果和复核标记会一并删除，且无法恢复。`,
      )
    )
      return;
    setBusy(true);
    try {
      await engineCall("audipick.project_delete", { id: selectedId });
      setSelectedId("");
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
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
      let text = "";
      let ocrPages = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let pageText = content.items
          .map((item: { str?: string }) => item.str ?? "")
          .join(" ");
        if (pageText.trim().length < 60 && configStatus.ocr?.ready) {
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
        }
        text += `---PDF第${number}页---\n${pageText}\n`;
      }
      await renderPdfPage(
        pdf,
        Math.min(pdf.numPages, Math.max(1, startPage)),
        "",
        pdfScale,
        pdfRotation,
      );
      setPdfText(text);
      setResult({
        documentId: id,
        pages: pdf.numPages,
        textLength: text.length,
        ocrPages,
        scanned: text.replace(/---PDF第\d+页---/g, "").trim().length < 60,
      });
      void suggestRule(id, text);
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
      setPdfText((current) =>
        current ? `${current}\n---OCR补充---\n${value.text}` : value.text,
      );
      setResult(value);
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
    const groups = (selected.project.relationGroups ?? []).filter(
      (group) => group.anchorFileId !== selectedDocument,
    );
    groups.push({
      id: `g_${Date.now().toString(36)}`,
      anchorFileId: selectedDocument,
      members: [{ fileId: associationTarget, role: associationRole }],
    });
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
  async function saveCustomRule() {
    if (!customRuleName.trim() || !customRulePrompt.includes("【字段定义】")) {
      setError("自定义模板需要名称，并且提示词必须包含【字段定义】。");
      return;
    }
    const created = window.RuleEngine?.createBlankCustomRule(
      customRuleName.trim(),
      "contract",
    );
    const id = String(created?.id ?? "");
    window.RuleEngine?.updateCustomRule(id, {
      prompt: customRulePrompt,
      description: "用户自定义审计提取模板",
    });
    window.RuleEngine?.resetFieldsCache(id);
    const allSettings = await settingsGet();
    const current = (allSettings.audipick ?? {}) as Record<string, unknown>;
    await settingsSet({
      audipick: {
        ...current,
        customRules: window.RuleEngine?.getCustomRules() ?? [],
      },
    });
    setCustomRuleName("");
    setCustomRulePrompt("");
    setRuleRevision((value) => value + 1);
    setRuleId(id);
    setResult({ customRuleSaved: true, id });
  }
  /// Persist one extraction run's items against the current contract/template.
  async function saveExtractedItems(items: Array<Record<string, unknown>>) {
    if (!selected) return;
    const retained = (selected.results ?? []).filter(
      (row) =>
        !(
          row.contractId === selectedDocument &&
          row.ruleId === ruleId &&
          row.fieldSetId === activeFieldSetId
        ),
    );
    const saved = {
      ...selected,
      results: [
        ...retained,
        ...items.map((item, index) => ({
          ...item,
          id: `r_${Date.now().toString(36)}_${index}`,
          contractId: selectedDocument,
          ruleId,
          ruleVersion:
            rules.find((rule) => rule.id === ruleId)?.version ?? "1.0",
          fieldKeys: activeFieldKeys,
          fieldSetId: activeFieldSetId,
          extractAt: new Date().toISOString(),
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
        const retained = (selected.results ?? []).filter(
          (row) =>
            !(
              row.contractId === selectedDocument &&
              row.ruleId === ruleId &&
              row.fieldSetId === activeFieldSetId
            ),
        );
        const saved = {
          ...selected,
          results: [
            ...retained,
            ...items.map((item, index) => ({
              ...item,
              id: `r_deep_${Date.now().toString(36)}_${index}`,
              contractId: selectedDocument,
              ruleId,
              fieldKeys: activeFieldKeys,
              fieldSetId: activeFieldSetId,
              extractAt: new Date().toISOString(),
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
        setResult({ deepReview: true, rows: items.length });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function startBatch() {
    if (!documents.length) {
      setError("项目中没有可提取的 PDF。");
      return;
    }
    const prompt = `${window.RuleEngine?.getRulePrompt(ruleId) ?? ""}\n\n本次仅返回这些字段：${activeFieldKeys.join(", ")}`;
    setError("");
    try {
      const jobId = await jobStart("audipick.batch_extract", {
        ruleId,
        fieldSetId: activeFieldSetId,
        fieldKeys: activeFieldKeys,
        prompt,
        documents: documents.map((document) => ({
          id: document.id,
          name: document.name,
        })),
      });
      addLog(
        `${documents.length} 份文档`,
        "批量提取",
        `按「${rules.find((r) => r.id === ruleId)?.name ?? ruleId}」模板启动`,
        "info",
      );
      setBatchJob({
        jobId,
        toolId: "audipick",
        phase: "queued",
        current: 0,
        total: documents.length,
        message: "批量任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
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
  async function exportResults() {
    const rows = (selected?.results ?? []).filter(
      (row: any) =>
        row?.contractId === selectedDocument && row?.ruleId === ruleId,
    );
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
  return (
    <>
      <PageHeader
        eyebrow="合同审阅管理"
        title={tool.name}
        detail="项目、PDF、本地预览和13个审计模板已接入；扫描页走OCR，文字层直接使用工具箱全局LLM。"
      />
      <div className="ap-views">
        <button className={viewMode === "workbench" ? "active" : ""} onClick={() => setViewMode("workbench")}>
          工作台
        </button>
        <button className={viewMode === "templates" ? "active" : ""} onClick={() => setViewMode("templates")}>
          提取模板库
        </button>
        <button className={viewMode === "worklog" ? "active" : ""} onClick={() => setViewMode("worklog")}>
          处理工作日志
        </button>
      </div>
      {viewMode === "workbench" && (
      <>
      <StepIndicator
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
      />
      <div className="workspace">
        <section id="ap-proj" className="form-card">
          <div className="section-title">
            <h2>项目</h2>
            <span className="pill preview">迁移进行中</span>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>项目名称</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>客户名称</span>
              <input
                value={client}
                onChange={(e) => setClient(e.target.value)}
              />
            </label>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void create()}
            >
              新建项目
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void refresh()}
            >
              刷新
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void exportBackup()}
            >
              导出迁移备份
            </button>
          </div>
          <div className="list-card">
            {projects.map((value) => (
              <button
                key={value.project.id}
                className={
                  value.project.id === selectedId ? "secondary" : "browse"
                }
                onClick={() => setSelectedId(value.project.id)}
              >
                {value.project.name}
                {value.project.client ? ` · ${value.project.client}` : ""}
              </button>
            ))}
          </div>
        </section>
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
              导入 PDF
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
              <h3>当前底稿结果（{currentResults.length}）</h3>
              {currentResults.map((row, index) => (
                <div className="task-row" key={String(row.id ?? index)}>
                  <div>
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
                  </div>
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
                <button className="secondary" onClick={() => setTemplateTab("mine")}>
                  我的模板
                </button>
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
            <small>
              {rules.find((rule) => rule.id === ruleId)?.description}
            </small>
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
                  保存自定义模板
                </button>
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
    </>
  );
}
