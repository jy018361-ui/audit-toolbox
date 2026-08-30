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
  resolveRoleLabels,
  reviewLedgerSourceClassification,
  type EngineRoleLabels,
} from "@/ledgerMapping";
import {
  describeForm,
  formGroups,
  resolveForm,
  roleRequirement,
  useLedgerForms,
} from "@/ledgerForms";
import "./fx-audit.css";
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
      .replace(/^[-—:：\s]+|[-—:：\s]+$/g, "") ||
    (role === "excluded" ? "" : "固定资产");
  return { account, role, category };
}

export function faAssignmentsForEntities(
  accounts: string[],
  entities: string[],
  current: Assignment[],
): Assignment[] {
  const effectiveEntities = entities.length ? entities : [DEFAULT_ENTITY];
  return effectiveEntities.flatMap((entity) =>
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
  // 主体是公共映射字段；源表没有主体列时由引擎统一使用默认主体。
  const entitiesReady = Boolean(inspects.tb && inspects.je);
  const entities = useMemo(
    () => {
      const detected = [
        ...new Set([
          ...(inspects.tb?.entities ?? []),
          ...(inspects.je?.entities ?? []),
        ]),
      ].filter(Boolean);
      return detected.length ? detected : [DEFAULT_ENTITY];
    },
    [inspects],
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
        if (item.kind === "je")
          setOutputPath((current) => current || defaultOutput(item.path));
      }
      setSourceStatus(
        recognized.length
          ? `${recognized.length} 个文件完成公共账表引擎识别与${llmFallbacks ? "可用时的" : ""} LLM 复核：${recognized
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
      tbFixedEntity: DEFAULT_ENTITY,
      jeFixedEntity: DEFAULT_ENTITY,
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
            label: "科目复核（可选）",
            disabled: !mappingsReady || !entitiesReady,
          },
          { key: "output", label: "预览与导出", disabled: !assignmentsReady },
        ]}
        current={step - 1}
        onStepClick={(index) => setStep((index + 1) as 1 | 2 | 3 | 4)}
      />
      <ErrorBox error={error} onDismiss={() => setError("")} />

      {step === 1 && (
        <div className="fa-tbje-step-stack">
          <Card>
            <CardHeader>
              <CardTitle>上传审计数据</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="fx-hint">
                TB 和序时账使用同一入口，可一次拖入两个文件；公共账表引擎自动判定类型、标题行和字段映射。
              </p>
            <FileDropInput
              containerRef={uploadDropRef}
              value={(["tb", "je"] as const)
                .filter((kind) => paths[kind])
                .map((kind) => `${kind.toUpperCase()}：${fileName(paths[kind])}`)
                .join("；")}
              disabled={busy}
              placeholder={
                busy ? "正在识别文件…" : "拖放或选择 TB、JE 文件（可同时选择）"
              }
              onBrowse={() => void browse()}
              onDragStateChange={() => {}}
              onClear={() => {
                clearSource("tb");
                clearSource("je");
                setSourceStatus("");
              }}
            />
            {sourceStatus && (
              <p className="fx-source-status" aria-live="polite">
                {sourceStatus}
              </p>
            )}
            </CardContent>
          </Card>
          {(paths.tb || paths.je) && (
            <div className="fx-source-grid">
              {(["je", "tb"] as const).map((kind) => (
                <div className={`fx-source-slot fx-source-slot-${kind}`} key={kind}>
                  {paths[kind] && inspects[kind] ? (
                    <FaLedgerSourceCard
                      kind={kind}
                      path={paths[kind]}
                      inspection={inspects[kind]!}
                      disabled={busy}
                      onClear={() => clearSource(kind)}
                      onHeaderChange={(over) => void reinspect(kind, over)}
                    />
                  ) : (
                    <Card className="fx-source-empty">
                      <CardHeader>
                        <CardTitle>
                          {kind === "tb" ? "TB 科目余额表" : "JE 序时账"}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p>未识别到 {kind.toUpperCase()}，请继续上传。</p>
                      </CardContent>
                    </Card>
                  )}
                </div>
              ))}
            </div>
          )}
          <Card>
            <CardContent>
            <div className="fa-tbje-step-actions">
              <span>
                {!paths.tb || !paths.je
                  ? "请补齐 TB 与 JE。"
                  : "文件已就绪，主体按映射字段自动读取。"}
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
        </div>
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
                      labels: resolveRoleLabels(
                        inspects.tb.roles,
                        TB_LABELS,
                      ),
                      onApplied: (next) =>
                        setMappings((value) => ({ ...value, tb: next })),
                      missingAfter: (mapping) =>
                        faTbJeMissingMappings("tb", mapping),
                    }
                  : undefined,
                je: inspects.je
                  ? {
                      headers: inspects.je.headers,
                      preview: inspects.je.preview,
                      mapping: mappings.je,
                      labels: resolveRoleLabels(
                        inspects.je.roles,
                        JE_LABELS,
                      ),
                      onApplied: (next) =>
                        setMappings((value) => ({ ...value, je: next })),
                      missingAfter: (mapping) =>
                        faTbJeMissingMappings("je", mapping),
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
                  engineRoles={inspects[kind]!.roles}
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
              onClick={() => setStep(assignmentsReady ? 4 : 3)}
            >
              {assignmentsReady ? "使用自动分类并继续" : "复核科目分类"}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <Card>
          <CardHeader className="fa-tbje-card-head">
            <div>
              <CardTitle>复核固定资产科目与资产类别</CardTitle>
              <p>
                系统已根据映射后的科目编码和名称自动分类。本步仅用于调整例外，默认只显示固定资产候选。
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
                  <span>自动科目分类</span>
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
                  返回科目复核
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

function FaLedgerSourceCard(props: {
  kind: Kind;
  path: string;
  inspection: Inspection;
  disabled: boolean;
  onClear: () => void;
  onHeaderChange: (
    over: Partial<Pick<Inspection, "sheet" | "headerRow" | "headerDepth">>,
  ) => void;
}) {
  const { kind, inspection } = props;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          已识别：{kind === "tb" ? "TB 科目余额表" : "JE 序时账"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="fx-hint">
          {kind === "tb"
            ? "期初、期末余额和年末勾稽的数据源"
            : "新增、处置、折旧及对方科目的完整期间数据源"}
        </p>
        <div className="fx-detected-file">
          <span title={props.path}>{props.path}</span>
          <button type="button" disabled={props.disabled} onClick={props.onClear}>
            移除
          </button>
        </div>
        <div className="fx-source-meta">
          <span>{inspection.rowCount.toLocaleString("zh-CN")} 行</span>
          <label>
            Sheet
            <select
              name={`${kind}-sheet`}
              autoComplete="off"
              disabled={props.disabled}
              value={inspection.sheet}
              onChange={(event) =>
                props.onHeaderChange({
                  sheet: event.target.value,
                  headerRow: 0,
                  headerDepth: 0,
                })
              }
            >
              {(inspection.sheets.length ? inspection.sheets : [inspection.sheet]).map(
                (sheet) => <option key={sheet}>{sheet}</option>,
              )}
            </select>
          </label>
          <label>
            标题行
            <input
              name={`${kind}-header-row`}
              autoComplete="off"
              disabled={props.disabled}
              type="number"
              min={1}
              value={inspection.headerRow}
              onChange={(event) =>
                props.onHeaderChange({ headerRow: Number(event.target.value) })
              }
            />
          </label>
          <label>
            表头层数
            <select
              name={`${kind}-header-depth`}
              autoComplete="off"
              disabled={props.disabled}
              value={inspection.headerDepth}
              onChange={(event) =>
                props.onHeaderChange({ headerDepth: Number(event.target.value) })
              }
            >
              <option value={1}>1层</option>
              <option value={2}>2层</option>
            </select>
          </label>
          {inspection.headerDetection.needsConfirmation && (
            <strong className="fx-warning">标题候选得分接近，请确认标题行</strong>
          )}
        </div>
        <p className="fa-tbje-entity-note">
          {inspection.entities.length
            ? `主体：${inspection.entities.join("、")}`
            : `未检出主体列，按公共引擎的「${DEFAULT_ENTITY}」处理。`}
        </p>
      </CardContent>
    </Card>
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
  /** 引擎随识别结果下发的角色标签（deposit.inspect_* 响应）；未下发时回落本地标签表。 */
  engineRoles?: EngineRoleLabels;
  mapping: Mapping;
  missing: string[];
  busy: boolean;
  note: string;
  onChange: (next: MappingDict) => void;
}) {
  const labels = resolveRoleLabels(
    props.engineRoles,
    props.kind === "tb" ? TB_LABELS : JE_LABELS,
  );
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
