import { useEffect, useMemo, useRef, useState } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenPositionedFileDrops,
  pickPath,
} from "./api";
import type { Inspection } from "./DepositInterestPage";
import {
  depositDropTargetInside,
  JE_LABELS,
  TB_LABELS,
} from "./DepositInterestPage";
import { MappingPanel, type MappingDict } from "@/components/MappingPanel";
import {
  LedgerReviewAll,
  useLedgerDictReviews,
} from "@/components/LedgerReviewAll";
import { FileDropInput } from "@/components/FileDropInput";
import { FileInput } from "@/components/FileInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { ResultView } from "@/components/ResultView";
import { StepIndicator } from "@/components/StepIndicator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useJobEvents } from "@/hooks/useJobEvents";
import { errorText } from "@/lib/errors";
import {
  DEFAULT_ENTITY,
  resolveLedgerPairKinds,
  reviewLedgerSourceClassification,
} from "@/ledgerMapping";
import {
  describeForm,
  formGroups,
  resolveForm,
  roleRequirement,
  useLedgerForms,
} from "@/ledgerForms";
import "./fa-tbje.css";

type Kind = "tb" | "je";
type Mapping = Record<string, string | string[]>;
type AccountRole = "cost" | "depreciation" | "excluded";
type Assignment = {
  entity?: string;
  account: string;
  role: AccountRole;
  category: string;
};
type AssignmentFilter = "candidate" | AccountRole | "all";
type Classification = {
  kind: Kind;
  scores: { je: number; tb: number };
  headers: string[];
  preview: string[][];
  sheet: string;
  headerRow: number;
  headerDepth: number;
};

const MULTI = new Set(["id", "accountName", "account", "auxiliary"]);
const PAGE_SIZE = 50;

const hasMapped = (mapping: Mapping, role: string) => {
  const value = mapping[role];
  return Array.isArray(value) ? value.some(Boolean) : Boolean(value?.trim());
};

export function faTbJeMissingMappings(kind: Kind, mapping: Mapping): string[] {
  const missing: string[] = [];
  if (!hasMapped(mapping, "accountCode") && !hasMapped(mapping, "accountName"))
    missing.push("科目编码或科目名称");
  if (kind === "tb") {
    const opening =
      hasMapped(mapping, "openingFunctionalAmount") ||
      (hasMapped(mapping, "openingFunctionalDebit") &&
        hasMapped(mapping, "openingFunctionalCredit"));
    const closing =
      hasMapped(mapping, "closingFunctionalAmount") ||
      (hasMapped(mapping, "closingFunctionalDebit") &&
        hasMapped(mapping, "closingFunctionalCredit"));
    if (!opening) missing.push("期初余额");
    if (!closing) missing.push("期末余额");
  } else {
    if (!hasMapped(mapping, "id")) missing.push("凭证标识");
    if (!hasMapped(mapping, "date")) missing.push("记账日期");
    const amount =
      hasMapped(mapping, "functionalAmount") ||
      (hasMapped(mapping, "functionalDebit") &&
        hasMapped(mapping, "functionalCredit"));
    if (!amount) missing.push("本位币金额或借贷金额");
  }
  return missing;
}

export function suggestFaAccount(account: string): Assignment {
  const depreciation =
    /累计折旧|accumulated\s+depreciation|accum\.?\s*dep/i.test(account);
  const cost =
    !depreciation &&
    /固定资产|房屋|建筑物|机器|设备|运输工具|电子设备|办公设备|fixture|equipment|building|vehicle/i.test(
      account,
    );
  const role: AccountRole = depreciation
    ? "depreciation"
    : cost
      ? "cost"
      : "excluded";
  const category =
    account
      .replace(/^\s*\d+[\s._-]*/, "")
      .replace(
        /累计折旧|固定资产|accumulated\s+depreciation|property[,\s]*plant\s*(and|&)\s*equipment|ppe/gi,
        "",
      )
      .replace(/^[-—:：\s]+|[-—:：\s]+$/g, "") || "未分类";
  return { account, role, category };
}

export function faAssignmentsForEntities(
  accounts: string[],
  entities: string[],
  current: Assignment[],
): Assignment[] {
  return entities.flatMap((entity) =>
    accounts.map(
      (account) =>
        current.find(
          (item) => item.account === account && item.entity === entity,
        ) ?? { ...suggestFaAccount(account), entity },
    ),
  );
}

function defaultOutput(input: string) {
  const slash = Math.max(input.lastIndexOf("\\"), input.lastIndexOf("/"));
  const dir = slash >= 0 ? input.slice(0, slash + 1) : "";
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  return `${dir}FA_TBJE_${stamp}.xlsx`;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function FaTbJePage() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [paths, setPaths] = useState<Record<Kind, string>>({ tb: "", je: "" });
  const [inspects, setInspects] = useState<Partial<Record<Kind, Inspection>>>(
    {},
  );
  const [mappings, setMappings] = useState<Record<Kind, Mapping>>({
    tb: {},
    je: {},
  });
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [reportEnd, setReportEnd] = useState(
    `${new Date().getFullYear()}-12-31`,
  );
  const [tbFixedEntity, setTbFixedEntity] = useState("");
  const [jeFixedEntity, setJeFixedEntity] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sourceStatus, setSourceStatus] = useState("");
  const [result, setResult] = useState<unknown>();
  const [accountQuery, setAccountQuery] = useState("");
  const [assignmentFilter, setAssignmentFilter] =
    useState<AssignmentFilter>("candidate");
  const [assignmentPage, setAssignmentPage] = useState(0);
  const [bulkCategory, setBulkCategory] = useState("");
  const uploadDropRef = useRef<HTMLDivElement>(null);
  const reviews = useLedgerDictReviews(engineCall, {
    tb: JSON.stringify([
      paths.tb,
      inspects.tb?.sheet,
      inspects.tb?.headerRow,
      inspects.tb?.headerDepth,
    ]),
    je: JSON.stringify([
      paths.je,
      inspects.je?.sheet,
      inspects.je?.headerRow,
      inspects.je?.headerDepth,
    ]),
  });
  const reviewing = Boolean(reviews.reviewing.tb || reviews.reviewing.je);
  const { job, setJob, activeJobId } = useJobEvents({
    toolId: "fa_list",
    onEvent: (event) => {
      if (event.result) setResult(event.result);
      if (["completed", "failed", "cancelled"].includes(event.phase))
        setBusy(false);
      if (event.phase === "failed") setError(event.message);
    },
  });

  const accounts = useMemo(
    () => [
      ...new Set([
        ...(inspects.tb?.accounts ?? []),
        ...(inspects.je?.accounts ?? []),
      ]),
    ],
    [inspects],
  );
  const needsTbFixedEntity = Boolean(
    inspects.tb && inspects.tb.entities.length === 0,
  );
  const needsJeFixedEntity = Boolean(
    inspects.je && inspects.je.entities.length === 0,
  );
  // 主体列缺失时允许按公共默认主体继续，手工填写只是覆盖默认值。
  const entitiesReady = Boolean(inspects.tb && inspects.je);
  const entities = useMemo(
    () =>
      [
        ...new Set([
          ...(inspects.tb?.entities ?? []),
          ...(inspects.je?.entities ?? []),
          tbFixedEntity.trim(),
          jeFixedEntity.trim(),
        ]),
      ].filter(Boolean),
    [inspects, tbFixedEntity, jeFixedEntity],
  );
  const missingMappings = {
    tb: faTbJeMissingMappings("tb", mappings.tb),
    je: faTbJeMissingMappings("je", mappings.je),
  };
  const mappingsReady =
    Boolean(inspects.tb && inspects.je) &&
    missingMappings.tb.length === 0 &&
    missingMappings.je.length === 0;
  const includedAssignments = assignments.filter(
    (item) => item.role !== "excluded",
  );
  const unresolvedAssignments = includedAssignments.filter(
    (item) => !item.category.trim() || item.category === "未分类",
  );
  const assignmentsReady =
    includedAssignments.some((item) => item.role === "cost") &&
    unresolvedAssignments.length === 0;
  const filteredAssignments = useMemo(() => {
    const query = accountQuery.trim().toLowerCase();
    return assignments
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        if (assignmentFilter === "candidate" && item.role === "excluded")
          return false;
        if (
          assignmentFilter !== "candidate" &&
          assignmentFilter !== "all" &&
          item.role !== assignmentFilter
        )
          return false;
        return (
          !query ||
          item.account.toLowerCase().includes(query) ||
          (item.entity ?? "").toLowerCase().includes(query) ||
          item.category.toLowerCase().includes(query)
        );
      });
  }, [accountQuery, assignmentFilter, assignments]);
  const pageCount = Math.max(
    1,
    Math.ceil(filteredAssignments.length / PAGE_SIZE),
  );
  const pagedAssignments = filteredAssignments.slice(
    assignmentPage * PAGE_SIZE,
    (assignmentPage + 1) * PAGE_SIZE,
  );
  const roleCounts = assignments.reduce(
    (counts, item) => ({ ...counts, [item.role]: counts[item.role] + 1 }),
    { cost: 0, depreciation: 0, excluded: 0 } as Record<AccountRole, number>,
  );
  useEffect(() => {
    setAssignments((current) =>
      faAssignmentsForEntities(accounts, entities, current),
    );
  }, [accounts, entities]);
  useEffect(() => setAssignmentPage(0), [accountQuery, assignmentFilter]);
  useEffect(() => {
    setAssignmentPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);
  useEffect(() => {
    const drops = listenPositionedFileDrops(({ paths: dropped, x, y }) => {
      if (
        !depositDropTargetInside(
          x,
          y,
          uploadDropRef.current?.getBoundingClientRect(),
        )
      )
        return;
      void classifyAndInspect(dropped);
    });
    return () => {
      void drops.then((unlisten) => unlisten());
    };
  }, []);

  async function browse() {
    const picked = await pickPath("files", "选择 TB 或 JE 文件", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
      "tsv",
      "parquet",
    ]);
    if (!picked) return;
    void classifyAndInspect(Array.isArray(picked) ? picked : [picked]);
  }

  async function classifyAndInspect(selected: string[]) {
    const files = selected.filter((path) =>
      /\.(xlsx?|xlsm|csv|txt|tsv|parquet)$/i.test(path),
    );
    if (!files.length) return;
    reviews.clearReview("tb");
    reviews.clearReview("je");
    setStep(1);
    setBusy(true);
    setError("");
    setSourceStatus("正在识别文件类型、Sheet、表头和字段…");
    const failures: string[] = [];
    let llmFallbacks = 0;
    const classifiedFiles: {
      path: string;
      classification: Classification;
    }[] = [];
    try {
      for (const path of files) {
        try {
          const classified = (await engineCall("deposit.classify_source", {
            source: {
              inputPath: path,
              sheet: "",
              headerRow: 0,
              headerDepth: 0,
            },
          })) as Classification;
          const reviewed = await reviewLedgerSourceClassification(
            engineCall,
            "fa_tbje.classify_source_llm",
            path,
            classified,
          );
          if (!reviewed.reviewed) llmFallbacks += 1;
          classifiedFiles.push({
            path,
            classification: reviewed.classification,
          });
        } catch (e) {
          failures.push(`${fileName(path)}：${errorText(e)}`);
        }
      }
      const resolvedKinds = resolveLedgerPairKinds(
        classifiedFiles.map((item) => item.classification),
      );
      const recognized: {
        kind: Kind;
        path: string;
        inspected: Inspection;
      }[] = [];
      for (const [index, item] of classifiedFiles.entries()) {
        const kind = resolvedKinds[index];
        try {
          const inspected = (await engineCall(`deposit.inspect_${kind}`, {
            source: {
              inputPath: item.path,
              sheet: item.classification.sheet,
              headerRow: item.classification.headerRow,
              headerDepth: item.classification.headerDepth,
            },
          })) as Inspection;
          recognized.push({ kind, path: item.path, inspected });
        } catch (e) {
          failures.push(`${fileName(item.path)}：${errorText(e)}`);
        }
      }
      for (const item of recognized) {
        setPaths((current) => ({ ...current, [item.kind]: item.path }));
        setInspects((current) => ({
          ...current,
          [item.kind]: item.inspected,
        }));
        setMappings((current) => ({
          ...current,
          [item.kind]: item.inspected.suggestedMapping,
        }));
        reviews.clearReview(item.kind);
        if (item.inspected.entities?.length) {
          if (item.kind === "tb") setTbFixedEntity("");
          else setJeFixedEntity("");
        }
        if (item.kind === "je")
          setOutputPath((current) => current || defaultOutput(item.path));
      }
      setSourceStatus(
        recognized.length
          ? `${recognized.length} 个文件完成脚本识别与${llmFallbacks ? "可用时的" : "固定资产专用"} LLM 复核：${recognized
              .map(
                ({ kind, path }) =>
                  `${kind.toUpperCase()}「${fileName(path)}」`,
              )
              .join("；")}。`
          : "没有文件识别成功，请检查文件内容后重试。",
      );
      if (failures.length) setError(failures.join("；"));
    } finally {
      setBusy(false);
    }
  }

  function clearSource(kind: Kind) {
    reviews.clearReview(kind);
    setPaths((current) => ({ ...current, [kind]: "" }));
    setInspects((current) => ({ ...current, [kind]: undefined }));
    setMappings((current) => ({ ...current, [kind]: {} }));
    if (kind === "tb") setTbFixedEntity("");
    else setJeFixedEntity("");
    setAssignments([]);
    setResult(undefined);
    setSourceStatus(`${kind.toUpperCase()} 已清除，请重新上传。`);
    setStep(1);
  }

  async function reinspect(
    kind: Kind,
    over: Partial<Pick<Inspection, "sheet" | "headerRow" | "headerDepth">>,
  ) {
    const current = inspects[kind];
    if (!current || !paths[kind]) return;
    reviews.clearReview(kind);
    setBusy(true);
    setError("");
    try {
      const inspected = (await engineCall(`deposit.inspect_${kind}`, {
        source: {
          inputPath: paths[kind],
          sheet: over.sheet ?? current.sheet,
          headerRow: over.headerRow ?? current.headerRow,
          headerDepth: over.headerDepth ?? current.headerDepth,
        },
      })) as Inspection;
      setInspects((value) => ({ ...value, [kind]: inspected }));
      setMappings((value) => ({
        ...value,
        [kind]: inspected.suggestedMapping,
      }));
      reviews.clearReview(kind);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function source(kind: Kind) {
    const inspected = inspects[kind];
    return {
      inputPath: paths[kind],
      sheet: inspected?.sheet ?? "",
      headerRow: inspected?.headerRow ?? 0,
      headerDepth: inspected?.headerDepth ?? 0,
    };
  }
  function payload() {
    return {
      tbSource: source("tb"),
      jeSource: source("je"),
      tbMapping: mappings.tb,
      jeMapping: mappings.je,
      accountAssignments: assignments,
      reportEnd,
      tbFixedEntity: tbFixedEntity.trim() || DEFAULT_ENTITY,
      jeFixedEntity: jeFixedEntity.trim() || DEFAULT_ENTITY,
      outputPath,
    };
  }
  async function run(method: "fa.tbje_preview" | "fa.tbje_export") {
    if (reviewing) {
      setError("映射复核尚未结束，请等待复核完成后再生成底稿。");
      return;
    }
    if (!paths.tb || !paths.je) {
      setError("请同时上传 TB 和完整期间 JE。");
      return;
    }
    if (!mappingsReady) {
      setError("TB 或 JE 仍有必填字段未映射，请返回字段映射步骤处理。");
      setStep(2);
      return;
    }
    if (!includedAssignments.some((x) => x.role === "cost")) {
      setError("请至少确认一个固定资产原值科目。");
      setStep(3);
      return;
    }
    if (unresolvedAssignments.length) {
      setError("仍有已纳入科目未确认资产类别，请返回科目分类步骤处理。");
      setStep(3);
      return;
    }
    if (method.endsWith("export") && !outputPath) {
      setError("请选择输出路径。");
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const id = await jobStart(method, payload());
      activeJobId.current = id;
      setJob({
        jobId: id,
        toolId: "fa_list",
        phase: "queued",
        current: 0,
        total: 1,
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
    }
  }

  function updateAssignment(index: number, patch: Partial<Assignment>) {
    setAssignments((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );
  }

  function applyRoleToFiltered(role: AccountRole) {
    const indexes = new Set(filteredAssignments.map(({ index }) => index));
    setAssignments((rows) =>
      rows.map((row, index) => (indexes.has(index) ? { ...row, role } : row)),
    );
  }

  function applyCategoryToFiltered() {
    const category = bulkCategory.trim();
    if (!category) return;
    const indexes = new Set(filteredAssignments.map(({ index }) => index));
    setAssignments((rows) =>
      rows.map((row, index) =>
        indexes.has(index) && row.role !== "excluded"
          ? { ...row, category }
          : row,
      ),
    );
  }

  return (
    <div className="fa-tbje-page">
      <StepIndicator
        steps={[
          { key: "source", label: "上传与识别" },
          {
            key: "mapping",
            label: "字段映射",
            disabled: !paths.tb || !paths.je || !entitiesReady,
          },
          {
            key: "accounts",
            label: "科目分类",
            disabled: !mappingsReady || !entitiesReady,
          },
          { key: "output", label: "预览与导出", disabled: !assignmentsReady },
        ]}
        current={step - 1}
        onStepClick={(index) => setStep((index + 1) as 1 | 2 | 3 | 4)}
      />
      <ErrorBox error={error} onDismiss={() => setError("")} />

      {step === 1 && (
        <Card>
          <CardHeader className="fa-tbje-card-head">
            <div>
              <CardTitle>上传并确认账表来源</CardTitle>
              <p>
                可同时拖入 1 份 TB 和 1 份完整期间
                JE，公共引擎自动识别文件类型。
              </p>
            </div>
            <Badge variant={paths.tb && paths.je ? "default" : "outline"}>
              {[paths.tb, paths.je].filter(Boolean).length}/2 已就绪
            </Badge>
          </CardHeader>
          <CardContent className="form-stack">
            <FileDropInput
              containerRef={uploadDropRef}
              value=""
              disabled={busy}
              placeholder={
                busy ? "正在识别文件…" : "拖放或选择 TB、JE 文件（可同时选择）"
              }
              onBrowse={() => void browse()}
              onDragStateChange={() => {}}
            />
            {sourceStatus && (
              <p className="fa-tbje-live-status" aria-live="polite">
                {sourceStatus}
              </p>
            )}
            {(paths.tb || paths.je) && (
              <div className="fa-tbje-source-grid">
                {(["tb", "je"] as const)
                  .filter((kind) => paths[kind] && inspects[kind])
                  .map((kind) => {
                    const inspected = inspects[kind];
                    const path = paths[kind];
                    const needsFixed =
                      kind === "tb" ? needsTbFixedEntity : needsJeFixedEntity;
                    const fixedValue =
                      kind === "tb" ? tbFixedEntity : jeFixedEntity;
                    return (
                      <section
                        className={`fa-tbje-source-card ${path ? "ready" : ""}`}
                        key={kind}
                      >
                        <div className="fa-tbje-source-title">
                          <div>
                            <span>{kind.toUpperCase()}</span>
                            <strong>
                              {kind === "tb" ? "科目余额表" : "序时账"}
                            </strong>
                          </div>
                          <Badge variant={path ? "secondary" : "outline"}>
                            {path ? "已识别" : "待上传"}
                          </Badge>
                        </div>
                        {path && inspected ? (
                          <>
                            <p className="fa-tbje-file-name" title={path}>
                              {fileName(path)}
                            </p>
                            <div className="fa-tbje-source-facts">
                              <span>
                                {inspected.rowCount.toLocaleString("zh-CN")} 行
                              </span>
                              <span>{inspected.headers.length} 列</span>
                              <span>
                                {inspected.entities.length
                                  ? `${inspected.entities.length} 个主体`
                                  : "无主体列"}
                              </span>
                            </div>
                            <div className="fa-tbje-source-controls">
                              <label>
                                Sheet
                                <select
                                  name={`${kind}-sheet`}
                                  autoComplete="off"
                                  disabled={busy}
                                  value={inspected.sheet}
                                  onChange={(event) =>
                                    void reinspect(kind, {
                                      sheet: event.target.value,
                                      headerRow: 0,
                                      headerDepth: 0,
                                    })
                                  }
                                >
                                  {(inspected.sheets.length
                                    ? inspected.sheets
                                    : [inspected.sheet]
                                  ).map((sheet) => (
                                    <option key={sheet}>{sheet}</option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                标题行
                                <input
                                  name={`${kind}-header-row`}
                                  autoComplete="off"
                                  disabled={busy}
                                  type="number"
                                  min={1}
                                  value={inspected.headerRow}
                                  onChange={(event) =>
                                    void reinspect(kind, {
                                      headerRow: Number(event.target.value),
                                    })
                                  }
                                />
                              </label>
                              <label>
                                表头层数
                                <select
                                  name={`${kind}-header-depth`}
                                  autoComplete="off"
                                  disabled={busy}
                                  value={inspected.headerDepth}
                                  onChange={(event) =>
                                    void reinspect(kind, {
                                      headerDepth: Number(event.target.value),
                                    })
                                  }
                                >
                                  <option value={1}>1 层</option>
                                  <option value={2}>2 层</option>
                                </select>
                              </label>
                            </div>
                            {inspected.headerDetection.needsConfirmation && (
                              <p className="fa-tbje-inline-warning">
                                标题候选得分接近，请核对标题行。
                              </p>
                            )}
                            {needsFixed ? (
                              <label className="fa-tbje-fixed-entity">
                                固定主体名称（选填）
                                <input
                                  name={`${kind}-fixed-entity`}
                                  autoComplete="organization"
                                  value={fixedValue}
                                  placeholder="例如：上海示例公司…"
                                  onChange={(event) =>
                                    kind === "tb"
                                      ? setTbFixedEntity(event.target.value)
                                      : setJeFixedEntity(event.target.value)
                                  }
                                />
                                <small>
                                  该账表没有主体列。主体是选填项，留空按「
                                  {DEFAULT_ENTITY}」处理。
                                </small>
                              </label>
                            ) : (
                              <p className="fa-tbje-entity-note">
                                主体：{inspected.entities.join("、")}
                              </p>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => clearSource(kind)}
                            >
                              清除并重选
                            </Button>
                          </>
                        ) : (
                          <p className="fa-tbje-empty-source">
                            尚未识别到{kind.toUpperCase()}
                            ，可继续拖入或选择文件。
                          </p>
                        )}
                      </section>
                    );
                  })}
              </div>
            )}
            {needsTbFixedEntity && needsJeFixedEntity && (
              <Button
                type="button"
                variant="secondary"
                disabled={!tbFixedEntity.trim()}
                onClick={() => setJeFixedEntity(tbFixedEntity)}
              >
                TB 与 JE 使用同一主体
              </Button>
            )}
            <div className="fa-tbje-step-actions">
              <span>
                {!paths.tb || !paths.je
                  ? "请补齐 TB 与 JE。"
                  : !entitiesReady
                    ? "请确认无主体列账表的固定主体。"
                    : "文件与主体已就绪。"}
              </span>
              <Button
                disabled={!paths.tb || !paths.je || !entitiesReady || busy}
                onClick={() => setStep(2)}
              >
                继续核对字段
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <div className="fa-tbje-step-stack">
          <LedgerReviewAll
            present={
              inspects.tb && inspects.je
                ? ["tb", "je"]
                : inspects.tb
                  ? ["tb"]
                  : ["je"]
            }
            names={{ tb: "TB", je: "JE" }}
            reviewing={reviews.reviewing}
            status={reviews.status}
            disabled={busy}
            onReviewAll={() =>
              void reviews.reviewAll({
                tb: inspects.tb
                  ? {
                      headers: inspects.tb.headers,
                      preview: inspects.tb.preview,
                      mapping: mappings.tb,
                      labels: TB_LABELS,
                      onApplied: (next) =>
                        setMappings((value) => ({ ...value, tb: next })),
                    }
                  : undefined,
                je: inspects.je
                  ? {
                      headers: inspects.je.headers,
                      preview: inspects.je.preview,
                      mapping: mappings.je,
                      labels: JE_LABELS,
                      onApplied: (next) =>
                        setMappings((value) => ({ ...value, je: next })),
                    }
                  : undefined,
              })
            }
          />
          {(["tb", "je"] as const).map(
            (kind) =>
              inspects[kind] && (
                <FaTbJeMappingPanel
                  key={kind}
                  kind={kind}
                  headers={inspects[kind]!.headers}
                  rows={inspects[kind]!.preview}
                  mapping={mappings[kind]}
                  missing={missingMappings[kind]}
                  busy={reviews.reviewing[kind] || busy}
                  note={`${inspects[kind]!.rowCount.toLocaleString("zh-CN")} 行 × ${inspects[kind]!.headers.length} 列`}
                  onChange={(next) =>
                    setMappings((current) => ({
                      ...current,
                      [kind]: next as Mapping,
                    }))
                  }
                />
              ),
          )}
          <div className="fa-tbje-step-actions">
            <Button variant="secondary" onClick={() => setStep(1)}>
              返回上传
            </Button>
            <span>
              {mappingsReady
                ? "TB 与 JE 必填字段均已映射。"
                : "请处理上方标出的未映射字段。"}
            </span>
            <Button
              disabled={!mappingsReady || reviewing || busy}
              onClick={() => setStep(3)}
            >
              继续确认科目
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <Card>
          <CardHeader className="fa-tbje-card-head">
            <div>
              <CardTitle>确认固定资产科目与资产类别</CardTitle>
              <p>
                默认只显示公共引擎识别后的固定资产候选；可搜索或切换筛选查看全部科目。
              </p>
            </div>
            <div className="fa-tbje-counts">
              <Badge>原值 {roleCounts.cost}</Badge>
              <Badge variant="secondary">
                累计折旧 {roleCounts.depreciation}
              </Badge>
              <Badge
                variant={
                  unresolvedAssignments.length ? "destructive" : "outline"
                }
              >
                待确认类别 {unresolvedAssignments.length}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="form-stack">
            <div className="fa-tbje-account-toolbar">
              <label>
                搜索科目
                <input
                  name="fa-account-search"
                  autoComplete="off"
                  type="search"
                  value={accountQuery}
                  placeholder="输入科目编码、名称或类别…"
                  onChange={(event) => setAccountQuery(event.target.value)}
                />
              </label>
              <label>
                显示范围
                <select
                  name="fa-account-filter"
                  autoComplete="off"
                  value={assignmentFilter}
                  onChange={(event) =>
                    setAssignmentFilter(event.target.value as AssignmentFilter)
                  }
                >
                  <option value="candidate">固定资产候选</option>
                  <option value="cost">固定资产原值</option>
                  <option value="depreciation">累计折旧</option>
                  <option value="excluded">已排除</option>
                  <option value="all">全部科目</option>
                </select>
              </label>
              <div
                className="fa-tbje-bulk-actions"
                aria-label="批量设置当前筛选结果"
              >
                <span>
                  当前筛选共{" "}
                  {filteredAssignments.length.toLocaleString("zh-CN")} 项
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => applyRoleToFiltered("cost")}
                >
                  设为原值
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => applyRoleToFiltered("depreciation")}
                >
                  设为折旧
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => applyRoleToFiltered("excluded")}
                >
                  全部排除
                </Button>
              </div>
              <div className="fa-tbje-bulk-category">
                <label>
                  批量资产类别
                  <input
                    name="fa-bulk-category"
                    autoComplete="off"
                    value={bulkCategory}
                    placeholder="例如：机器设备…"
                    onChange={(event) => setBulkCategory(event.target.value)}
                  />
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!bulkCategory.trim()}
                  onClick={applyCategoryToFiltered}
                >
                  应用到当前筛选
                </Button>
              </div>
            </div>
            <div className="fa-tbje-account-table-wrap">
              <table className="fa-tbje-account-table">
                <thead>
                  <tr>
                    <th>主体</th>
                    <th>科目</th>
                    <th>角色</th>
                    <th>资产类别</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedAssignments.map(({ item, index }) => (
                    <tr key={JSON.stringify([item.entity, item.account])}>
                      <td>
                        <Badge variant="outline">{item.entity}</Badge>
                      </td>
                      <td className="fa-tbje-account-name" title={item.account}>
                        {item.account}
                      </td>
                      <td>
                        <select
                          aria-label={`${item.account}的科目角色`}
                          name={`role-${index}`}
                          autoComplete="off"
                          value={item.role}
                          disabled={busy}
                          onChange={(event) =>
                            updateAssignment(index, {
                              role: event.target.value as AccountRole,
                            })
                          }
                        >
                          <option value="excluded">排除</option>
                          <option value="cost">固定资产原值</option>
                          <option value="depreciation">累计折旧</option>
                        </select>
                      </td>
                      <td>
                        <input
                          aria-label={`${item.account}的资产类别`}
                          name={`category-${index}`}
                          autoComplete="off"
                          value={item.category}
                          disabled={busy || item.role === "excluded"}
                          onChange={(event) =>
                            updateAssignment(index, {
                              category: event.target.value,
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                  {!pagedAssignments.length && (
                    <tr>
                      <td colSpan={4} className="fa-tbje-empty-table">
                        当前筛选没有科目。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="fa-tbje-pagination">
              <span>
                第 {assignmentPage + 1}/{pageCount} 页，每页最多 {PAGE_SIZE} 项
              </span>
              <div>
                <Button
                  variant="ghost"
                  disabled={assignmentPage === 0}
                  onClick={() =>
                    setAssignmentPage((value) => Math.max(0, value - 1))
                  }
                >
                  上一页
                </Button>
                <Button
                  variant="ghost"
                  disabled={assignmentPage + 1 >= pageCount}
                  onClick={() =>
                    setAssignmentPage((value) =>
                      Math.min(pageCount - 1, value + 1),
                    )
                  }
                >
                  下一页
                </Button>
              </div>
            </div>
            <div className="fa-tbje-step-actions">
              <Button variant="secondary" onClick={() => setStep(2)}>
                返回字段映射
              </Button>
              <span>
                {!includedAssignments.some((item) => item.role === "cost")
                  ? "至少需要 1 个固定资产原值科目。"
                  : unresolvedAssignments.length
                    ? `还有 ${unresolvedAssignments.length} 个已纳入科目未确认资产类别。`
                    : "科目角色与类别已就绪。"}
              </span>
              <Button
                disabled={!assignmentsReady || busy}
                onClick={() => setStep(4)}
              >
                继续预览与导出
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 4 && (
        <div className="fa-tbje-step-stack">
          <Card>
            <CardHeader className="fa-tbje-card-head">
              <div>
                <CardTitle>生成预览并导出五表</CardTitle>
                <p>先核对输入摘要，再生成预览或正式 Excel。</p>
              </div>
              <Badge>全部就绪</Badge>
            </CardHeader>
            <CardContent className="form-stack">
              <div className="fa-tbje-readiness-grid">
                <div>
                  <span>TB</span>
                  <strong>{fileName(paths.tb)}</strong>
                  <small>
                    {inspects.tb?.rowCount.toLocaleString("zh-CN")} 行
                  </small>
                </div>
                <div>
                  <span>JE</span>
                  <strong>{fileName(paths.je)}</strong>
                  <small>
                    {inspects.je?.rowCount.toLocaleString("zh-CN")} 行
                  </small>
                </div>
                <div>
                  <span>科目分类</span>
                  <strong>
                    {roleCounts.cost} 个原值 · {roleCounts.depreciation} 个折旧
                  </strong>
                  <small>{entities.length} 个主体</small>
                </div>
                <div>
                  <span>输出内容</span>
                  <strong>5 张业务表＋1 张隐藏 TB 页</strong>
                  <small>保留公式与缓存结果</small>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  报告截止日
                  <input
                    name="fa-report-end"
                    autoComplete="off"
                    type="date"
                    value={reportEnd}
                    onChange={(event) => setReportEnd(event.target.value)}
                  />
                </label>
              </div>
              <label>
                输出路径
                <FileInput
                  value={outputPath}
                  onBrowse={async () => {
                    const value = await pickPath(
                      "save",
                      "保存固定资产 TB＋JE 底稿",
                      ["xlsx"],
                      "FA_TBJE.xlsx",
                    );
                    if (typeof value === "string") setOutputPath(value);
                  }}
                  disabled={busy}
                />
              </label>
              <div className="fa-tbje-step-actions">
                <Button variant="secondary" onClick={() => setStep(3)}>
                  返回科目分类
                </Button>
                <span>
                  {outputPath
                    ? "输出路径已确认。"
                    : "预览无需输出路径；导出前请选择保存位置。"}
                </span>
                <Button
                  variant="secondary"
                  disabled={busy || reviewing}
                  onClick={() => void run("fa.tbje_preview")}
                >
                  生成预览
                </Button>
                <Button
                  disabled={busy || reviewing || !outputPath}
                  onClick={() => void run("fa.tbje_export")}
                >
                  生成五表 Excel
                </Button>
                {busy && activeJobId.current && (
                  <Button
                    variant="destructive"
                    onClick={() => void jobCancel(activeJobId.current!)}
                  >
                    取消
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
          {job && <JobProgress job={job} />}
          <ResultView value={result} />
        </div>
      )}
    </div>
  );
}

/**
 * TB／JE 字段映射面板：下拉分组与必填标记都跟着**当前命中的型**走
 * （TB 六型／JE 三型，定义在 Rust，由 `ledger.forms` 下发）。
 */
function FaTbJeMappingPanel(props: {
  kind: Kind;
  headers: string[];
  rows: string[][];
  mapping: Mapping;
  missing: string[];
  busy: boolean;
  note: string;
  onChange: (next: MappingDict) => void;
}) {
  const labels = props.kind === "tb" ? TB_LABELS : JE_LABELS;
  const roles = Object.entries(labels);
  const forms = useLedgerForms(props.kind);
  const match = forms.length
    ? resolveForm(props.kind, forms, props.mapping)
    : undefined;
  return (
    <MappingPanel
      title={`${props.kind.toUpperCase()} 字段映射`}
      headers={props.headers}
      rows={props.rows}
      mapping={props.mapping}
      roles={roles}
      groups={formGroups(props.kind, roles, forms, match)}
      requirementOf={(role) => roleRequirement(match, role)}
      formNote={describeForm(match, (role) => labels[role] ?? role)}
      multi={MULTI}
      missing={props.missing}
      busy={props.busy}
      note={props.note}
      onChange={props.onChange}
    />
  );
}
