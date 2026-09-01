import { useEffect, useRef, useState } from "react";
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
import "./kanzhang-parity.css";
import "./je-sign-mark.css";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { LedgerSourceCard } from "@/components/LedgerSourceCard";
import { LedgerLlmReview } from "@/components/LedgerLlmReview";
import { LedgerMappingPreview } from "@/components/LedgerMappingPreview";
import { displayFileName } from "@/fileDisplay";
import {
  ColumnFilterMenu,
  ColumnFilterTrigger,
  VALUE_LIMIT,
  type ColumnFilterValues,
} from "@/components/ColumnFilterMenu";
import {
  activeAmountScheme,
  applyLedgerReviews,
  EMPTY_MAPPING,
  formatMappingValue,
  isMultiRole,
  kanzhangReviewSummary,
  ledgerErrorText,
  missingKanzhangRequiredRoles,
  setKanzhangMapping,
  shouldShowKanzhangJobProgress,
  undoMappingChange,
  type Inspect,
  type LedgerReviewResponse,
  type Mapping,
  type MappingChange,
  type Review,
} from "./ledgerMapping";
import {
  accountFilterTitle,
  accountMappingKey,
  activeColumnFilters,
  addBatch,
  batchesContaining,
  clearAccountsOnMappingChange,
  defaultJeMarkOutputName,
  defaultJeMarkOutputPath,
  isAccountColumn,
  newBatch,
  removeBatch,
  validJeMarkBatches,
  type JeMarkBatch,
} from "./jeSignMarkUi";

type JeMarkDraft = {
  inputPath: string;
  sheet: string;
  knownSheets: string[];
  headerRow: number;
  inspect?: Inspect;
  mapping: Mapping;
  batches: JeMarkBatch[];
  activeBatch: number;
  /** 非科目列的漏斗选择：同列多值取或，跨列取与，对所有批次一致生效。 */
  columnFilters: Record<string, string[]>;
  outputPath: string;
  outputTouched: boolean;
  /** 金额符号口径：auto=自动检测，unsigned=借贷符号一样，signed=已带符号。 */
  signChoice: "auto" | "unsigned" | "signed";
};

/** 后端 `kanzhang.mark_sign_report` 返回的口径检测报告。 */
type SignReport = {
  scheme: string;
  detected: "signed" | "unsigned" | null;
  basis: string;
  totalVouchers: number;
  balancedVouchers: number;
  unbalancedVouchers: number;
  filtered: boolean;
  keySuspect: boolean;
};

const EMPTY: JeMarkDraft = {
  inputPath: "",
  sheet: "",
  knownSheets: [],
  headerRow: 1,
  mapping: EMPTY_MAPPING,
  batches: [newBatch(0)],
  activeBatch: 0,
  columnFilters: {},
  outputPath: "",
  outputTouched: false,
  signChoice: "auto",
};
const CACHE = "audit-toolbox.je-sign-mark.draft.v2";
const loadDraft = (): JeMarkDraft => {
  try {
    return { ...EMPTY, ...JSON.parse(sessionStorage.getItem(CACHE) || "{}") };
  } catch {
    return EMPTY;
  }
};

export function JeSignMarkPage({ tool }: { tool: ToolManifest }) {
  const [draft, setDraft] = useState<JeMarkDraft>(loadDraft);
  const [changes, setChanges] = useState<MappingChange[]>([]);
  const [pending, setPending] = useState<Review[]>([]);
  const [llmStatus, setLlmStatus] = useState("");
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmFailed, setLlmFailed] = useState(false);
  const llmGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<JobEvent>();
  const [result, setResult] = useState<unknown>();
  const [dragHover, setDragHover] = useState(false);
  const [menu, setMenu] = useState<{ field: string; anchor: DOMRect }>();
  const [valueCache, setValueCache] = useState<
    Record<string, ColumnFilterValues>
  >({});
  const [valuesLoading, setValuesLoading] = useState(false);
  const [signReport, setSignReport] = useState<SignReport>();
  const [signLoading, setSignLoading] = useState(false);
  const [signError, setSignError] = useState("");
  const signGeneration = useRef(0);

  const patch = (value: Partial<JeMarkDraft>) =>
    setDraft((current) => ({ ...current, ...value }));
  const batch = draft.batches[draft.activeBatch] ?? draft.batches[0];
  const scheme = activeAmountScheme(draft.mapping);
  const missingRequired = missingKanzhangRequiredRoles(draft.mapping);
  const showReview =
    llmBusy ||
    llmFailed ||
    Boolean(llmStatus) ||
    changes.length > 0 ||
    pending.length > 0;
  const ready = Boolean(draft.inspect) && missingRequired.length === 0;
  const validBatches = validJeMarkBatches(draft.batches);

  function clearAll() {
    llmGeneration.current += 1;
    setDraft({ ...EMPTY, batches: [newBatch(0)] });
    setResult(undefined);
    setChanges([]);
    setPending([]);
    setLlmStatus("");
    setLlmBusy(false);
    setLlmFailed(false);
    setValueCache({});
    setMenu(undefined);
  }

  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
      return;
    let off: () => void = () => {};
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "enter")
          setDragHover(true);
        else if (payload.type === "drop") {
          setDragHover(false);
          if (payload.paths.length) resetSource(payload.paths[0]);
        } else if (payload.type === "leave") setDragHover(false);
      })
      .then((fn) => {
        off = fn;
      });
    return () => off();
  }, []);

  useEffect(() => {
    sessionStorage.setItem(CACHE, JSON.stringify(draft));
  }, [draft]);

  // 没手选过保存位置时，输出框跟着凭证文件和 Sheet 走。只在来源变化时重算——
  // 默认文件名带时间戳，每次渲染都算会把自己重新触发一遍。
  const autoOutputKey = useRef("");
  useEffect(() => {
    if (draft.outputTouched) return;
    const key = `${draft.inputPath}|${draft.sheet}`;
    if (autoOutputKey.current === key && draft.outputPath) return;
    autoOutputKey.current = key;
    patch({
      outputPath: draft.inputPath
        ? defaultJeMarkOutputPath(draft.inputPath, draft.sheet)
        : "",
    });
  }, [draft.inputPath, draft.sheet, draft.outputTouched, draft.outputPath]);

  useEffect(() => {
    let off = () => {};
    void listenJobEvents((event) => {
      if (event.toolId !== "je_sign_mark") return;
      setJob(event);
      if (event.result) {
        setResult(event.result);
        const payload = event.result as Inspect | undefined;
        if (event.phase === "completed" && Array.isArray(payload?.headers))
          applyInspect(payload);
      }
      const done = ["completed", "failed", "cancelled"].includes(event.phase);
      setBusy(!done);
      if (event.phase === "failed") setError(event.message);
    }).then((value) => (off = value));
    return () => off();
  }, []);

  function resetSource(path: string) {
    llmGeneration.current += 1;
    signGeneration.current += 1;
    setLlmBusy(false);
    setLlmFailed(false);
    setLlmStatus("");
    setChanges([]);
    setPending([]);
    setResult(undefined);
    setJob(undefined);
    setSignReport(undefined);
    setSignLoading(false);
    setSignError("");
    setError("");
    setValueCache({});
    setMenu(undefined);
    patch({
      inputPath: path,
      inspect: undefined,
      knownSheets: [],
      sheet: "",
      headerRow: 0,
      mapping: EMPTY_MAPPING,
      batches: clearAccountsOnMappingChange(draft.batches),
      columnFilters: {},
      outputPath: "",
      outputTouched: false,
    });
  }

  async function chooseInput() {
    const value = await pickPath("file", "选择凭证文件", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
      "parquet",
    ]);
    if (typeof value === "string") resetSource(value);
  }

  function invalidate(
    change: Partial<Pick<JeMarkDraft, "sheet" | "headerRow">>,
  ) {
    setValueCache({});
    setMenu(undefined);
    setDraft((current) => ({
      ...current,
      ...change,
      inspect: undefined,
      mapping: EMPTY_MAPPING,
      batches: clearAccountsOnMappingChange(current.batches),
      columnFilters: {},
    }));
  }

  async function inspect() {
    if (!draft.inputPath) {
      setError("请选择凭证文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await jobStart("kanzhang.mark_inspect", {
        inputPath: draft.inputPath,
        sheet: draft.sheet || undefined,
        headerRow: draft.headerRow,
      });
    } catch (e) {
      setError(ledgerErrorText(e));
      setBusy(false);
    }
  }

  function applyInspect(value: Inspect) {
    const suggested = value.suggestedMapping ?? EMPTY_MAPPING;
    setValueCache({});
    setDraft((current) => ({
      ...current,
      inspect: value,
      knownSheets: value.sheets ?? current.knownSheets,
      sheet: value.selectedSheet ?? current.sheet,
      mapping: suggested,
      batches: clearAccountsOnMappingChange(current.batches),
      columnFilters: {},
    }));
    setResult(undefined);
    // 脚本自动映射一出来就直接送 LLM 复核，不再要求用户额外点一次按钮。
    void reviewMapping(suggested, value);
  }

  // 科目字段一变，已选目标科目就可能对不上新口径，清空重选并提示。
  const accountKey = accountMappingKey(draft.mapping);
  const lastAccountKey = useRef(accountKey);
  useEffect(() => {
    if (lastAccountKey.current === accountKey) return;
    lastAccountKey.current = accountKey;
    if (!draft.inspect) return;
    const chosen = draft.batches.some((item) => item.accounts.length);
    setValueCache((current) => {
      const next = { ...current };
      for (const key of Object.keys(next))
        if (key.startsWith("#account")) delete next[key];
      return next;
    });
    if (!chosen) return;
    patch({ batches: clearAccountsOnMappingChange(draft.batches) });
    setError("科目字段已变更，各批次的目标科目已清空，请重新选择。");
  }, [accountKey, draft.inspect, draft.batches]);

  const setMap = (key: keyof Mapping, value: string | string[]) =>
    patch({ mapping: setKanzhangMapping(draft.mapping, key, value) });

  // 金额符号口径报告：读完文件、金额/凭证相关映射一变就重查。
  // 报告与导出走同一套后端检测，看到的口径就是实际采用的口径。
  const signKey = draft.inspect
    ? JSON.stringify([
        draft.inputPath,
        draft.sheet,
        draft.headerRow,
        draft.mapping.id,
        draft.mapping.functionalAmount,
        draft.mapping.direction,
        draft.mapping.functionalDebit,
        draft.mapping.functionalCredit,
      ])
    : "";
  useEffect(() => {
    if (!draft.inspect) {
      signGeneration.current += 1;
      setSignReport(undefined);
      setSignError("");
      setSignLoading(false);
      return;
    }
    const generation = ++signGeneration.current;
    setSignLoading(true);
    void engineCall("kanzhang.mark_sign_report", {
      inputPath: draft.inputPath,
      sheet: draft.sheet || undefined,
      headerRow: draft.headerRow,
      mapping: draft.mapping,
    })
      .then((value) => {
        if (generation !== signGeneration.current) return;
        const report = (value as { signConvention?: SignReport })
          .signConvention;
        if (report && typeof report.basis === "string") {
          setSignReport(report);
          setSignError("");
        } else {
          setSignError("符号口径报告格式不正确。");
        }
      })
      .catch((e) => {
        if (generation !== signGeneration.current) return;
        setSignReport(undefined);
        setSignError(ledgerErrorText(e));
      })
      .finally(() => {
        if (generation === signGeneration.current) setSignLoading(false);
      });
  }, [signKey, draft.inspect]);

  function skipReview() {
    llmGeneration.current += 1;
    setLlmBusy(false);
    setLlmFailed(false);
    setLlmStatus("已跳过本次 LLM 复核，保留当前字段映射，可自行调整后继续。");
  }

  async function reviewMapping(baseMapping?: Mapping, baseInspect?: Inspect) {
    const target = baseInspect ?? draft.inspect;
    if (!target) return;
    const source = baseMapping ?? draft.mapping;
    const generation = ++llmGeneration.current;
    setLlmBusy(true);
    setLlmFailed(false);
    setLlmStatus("");
    setError("");
    setChanges([]);
    setPending([]);
    try {
      const value = (await engineCall("kanzhang.llm_mapping", {
        mode: "mapping",
        payload: {
          headers: target.headers,
          samples: target.preview.slice(0, 8),
          currentMapping: source,
        },
      })) as LedgerReviewResponse;
      if (generation !== llmGeneration.current) return;
      const {
        mapping,
        changes: merged,
        pending: rest,
      } = applyLedgerReviews(source, value);
      patch({ mapping });
      setChanges(merged);
      setPending(rest);
      setLlmStatus(kanzhangReviewSummary(merged.length, rest.length));
    } catch (e) {
      if (generation !== llmGeneration.current) return;
      setLlmFailed(true);
      setLlmStatus(
        `${ledgerErrorText(e).replace(/[。.]+$/, "")}。脚本自动映射已完成，可直接核对后继续；LLM 复核只是可选的辅助检查。`,
      );
    } finally {
      if (generation === llmGeneration.current) setLlmBusy(false);
    }
  }

  const undoChange = (target: MappingChange) => {
    patch({ mapping: undoMappingChange(draft.mapping, target) });
    setChanges((values) => values.filter((value) => value !== target));
  };
  const acceptPending = (item: Review) => {
    const before = draft.mapping[item.role];
    const after = isMultiRole(item.role)
      ? [item.suggestedColumn.trim()]
      : item.suggestedColumn.trim();
    setMap(item.role, after);
    setChanges((values) => [
      ...values,
      {
        role: item.role,
        before,
        after,
        source: formatMappingValue(before) === "未映射" ? "fill" : "replace",
        reason: item.reason,
        confidence: item.confidence,
      },
    ]);
    setPending((values) => values.filter((value) => value !== item));
  };

  // 科目列的取值是拼接后的完整科目，走看账现成的科目通道；其余列按列取值。
  const ACCOUNT_MENU = "#account";
  const isAccountMenu = (field: string) => field === ACCOUNT_MENU;
  async function loadValues(field: string, keyword: string) {
    if (!draft.inputPath) return;
    setValuesLoading(true);
    try {
      const method = isAccountMenu(field)
        ? "kanzhang.accounts"
        : "kanzhang.column_values";
      const params = isAccountMenu(field)
        ? {
            inputPath: draft.inputPath,
            sheet: draft.sheet || undefined,
            headerRow: draft.headerRow,
            mapping: draft.mapping,
            keyword,
            limit: VALUE_LIMIT,
          }
        : {
            inputPath: draft.inputPath,
            sheet: draft.sheet || undefined,
            headerRow: draft.headerRow,
            field,
            keyword,
            limit: VALUE_LIMIT,
          };
      const value = (await engineCall(method, params)) as {
        values: string[];
        codes?: string[];
        total?: number;
        truncated?: boolean;
      };
      const total = value.total ?? value.values.length;
      setValueCache((current) => ({
        ...current,
        [field]: {
          values: value.values,
          // 科目清单带编码（与取值同序），面板据此显示「编码 名称」。
          ...(isAccountMenu(field) && Array.isArray(value.codes)
            ? { codes: value.codes }
            : {}),
          total,
          truncated: value.truncated ?? total > value.values.length,
          keyword,
        },
      }));
    } catch (e) {
      setError(ledgerErrorText(e));
    } finally {
      setValuesLoading(false);
    }
  }

  function openMenu(field: string, anchor: DOMRect) {
    setMenu({ field, anchor });
    if (!valueCache[field]) void loadValues(field, "");
  }

  function applyMenu(field: string, checked: string[]) {
    if (isAccountMenu(field)) {
      patch({
        batches: draft.batches.map((item, index) =>
          index === draft.activeBatch ? { ...item, accounts: checked } : item,
        ),
      });
    } else {
      const next = { ...draft.columnFilters };
      if (checked.length) next[field] = checked;
      else delete next[field];
      patch({ columnFilters: next });
    }
    setMenu(undefined);
  }

  const menuSelected = menu
    ? isAccountMenu(menu.field)
      ? batch.accounts
      : (draft.columnFilters[menu.field] ?? [])
    : [];

  async function chooseOutput() {
    const value = await pickPath(
      "save",
      "保存标记结果（可选 CSV 或 XLSX）",
      ["csv", "xlsx"],
      defaultJeMarkOutputName(draft.inputPath, draft.sheet),
    );
    if (typeof value === "string")
      patch({ outputPath: value, outputTouched: true });
  }
  function resetOutput() {
    autoOutputKey.current = "";
    patch({
      outputTouched: false,
      outputPath: draft.inputPath
        ? defaultJeMarkOutputPath(draft.inputPath, draft.sheet)
        : "",
    });
  }

  async function start() {
    if (!validBatches.length) {
      setError("请至少为一个批次选择目标科目。");
      return;
    }
    setBusy(true);
    setError("");
    let target = draft.outputPath;
    if (!draft.outputTouched && draft.inputPath) {
      target = defaultJeMarkOutputPath(draft.inputPath, draft.sheet);
      autoOutputKey.current = `${draft.inputPath}|${draft.sheet}`;
      patch({ outputPath: target });
    }
    try {
      const jobId = await jobStart("kanzhang.mark_export", {
        inputPath: draft.inputPath,
        sheet: draft.sheet || undefined,
        headerRow: draft.headerRow,
        mapping: draft.mapping,
        targetBatches: validBatches,
        columnFilters: activeColumnFilters(draft.columnFilters),
        signConvention:
          draft.signChoice === "auto" ? undefined : draft.signChoice,
        outputPath: target || undefined,
      });
      setJob({
        jobId,
        toolId: "je_sign_mark",
        phase: "queued",
        current: 0,
        total: 1,
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setBusy(false);
      setError(ledgerErrorText(e));
    }
  }

  const filterCount = activeColumnFilters(draft.columnFilters).length;

  // 金额符号口径：选择器只在有歧义的格式（方案 A/B）出现；
  // 单一金额列天然已带符号，不提供选择。
  const signLabels: Record<"auto" | "unsigned" | "signed", string> = {
    auto: "自动检测",
    unsigned: "借贷符号一样",
    signed: "已带符号（借正贷负）",
  };
  const signAllowsChoice =
    signReport?.scheme === "A" || signReport?.scheme === "B";
  const signApplied =
    draft.signChoice === "auto"
      ? signReport?.detected === "signed"
        ? "已带符号（借正贷负）"
        : signReport?.detected === "unsigned"
          ? "借贷符号一样（正数）"
          : "无法自动判定，导出将按「借贷符号一样」处理"
      : `${signLabels[draft.signChoice]}（已手动指定）`;
  const signWarnings = [
    signReport?.keySuspect
      ? "多数凭证在两种口径下都无法配平——凭证识别字段可能组错了（比如缺公司或日期），请检查字段映射。"
      : "",
    signReport?.filtered
      ? "多数凭证只有借方或只有贷方——这本账多半是按科目筛选后导出的，另一半分录不在文件里。这不是映射问题；口径按下方依据推断，请确认或手动指定。"
      : "",
    draft.signChoice === "auto" && signReport && signReport.detected === null
      ? "数据无法自动判定符号口径，建议手动指定。"
      : "",
  ].filter(Boolean);

  return (
    <div className="kz-page jm-page">
      <PageHeader
        eyebrow="凭证对冲标记"
        title={tool.name}
        detail="加载凭证、确认字段映射，在预览表头按列筛选并按批次选定目标科目，导出带正负数智能匹配标记的完整凭证明细。"
      />
      {error && <ErrorBox error={error} onDismiss={() => setError("")} />}

      <LedgerSourceCard
        inputPath={draft.inputPath}
        sheet={draft.sheet}
        knownSheets={draft.knownSheets}
        headerRow={draft.headerRow}
        dragHover={dragHover}
        busy={busy}
        job={job}
        needsReload={!draft.inspect && draft.knownSheets.length > 0}
        onBrowse={chooseInput}
        onClear={clearAll}
        onSheetChange={(value) => invalidate({ sheet: value })}
        onHeaderRowChange={(value) => invalidate({ headerRow: value })}
        onInspect={inspect}
        onCancel={(jobId) => void jobCancel(jobId)}
      >
        {draft.inspect && (
          <>
            {showReview && (
              <LedgerLlmReview
                busy={llmBusy}
                failed={llmFailed}
                status={llmStatus}
                mapping={draft.mapping}
                changes={changes}
                pending={pending}
                onSkip={skipReview}
                onUndo={undoChange}
                onAccept={acceptPending}
                onKeep={(item) =>
                  setPending((values) =>
                    values.filter((value) => value !== item),
                  )
                }
              />
            )}
            {scheme && (
              <p className="kz-hint">
                金额口径已按方案{scheme}成立，方案{scheme === "A" ? "B" : "A"}
                的字段已停用；如需切换，先清空当前方案的字段。
              </p>
            )}
            {(signReport || signError || signLoading) && (
              <div className={`jm-sign${signWarnings.length ? " warn" : ""}`}>
                <div className="jm-sign-head">
                  <span className="jm-sign-title">金额符号口径</span>
                  {signAllowsChoice && (
                    <span
                      className="jm-sign-choices"
                      role="group"
                      aria-label="金额符号口径选择"
                    >
                      {(["auto", "unsigned", "signed"] as const).map(
                        (value) => (
                          <button
                            key={value}
                            type="button"
                            className={
                              draft.signChoice === value ? "active" : ""
                            }
                            onClick={() => patch({ signChoice: value })}
                          >
                            {signLabels[value]}
                          </button>
                        ),
                      )}
                    </span>
                  )}
                </div>
                <p className="jm-sign-applied">
                  {signLoading
                    ? "正在检测金额符号口径…"
                    : signError
                      ? signError
                      : signApplied}
                </p>
                {!signLoading && !signError && signReport && (
                  <p className="jm-sign-basis">依据：{signReport.basis}</p>
                )}
                {signWarnings.map((text) => (
                  <p key={text} className="jm-sign-warning">
                    {text}
                  </p>
                ))}
              </div>
            )}
            {missingRequired.length > 0 && (
              <p className="fa-missing-hint">
                尚未映射：{missingRequired.join("、")}
                （请在各列顶部的下拉框中选择对应字段）
              </p>
            )}
            <div className="kz-actions">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || llmBusy}
                onClick={() => void reviewMapping()}
              >
                {llmBusy ? "LLM 正在复核…" : "重新进行 LLM 复核"}
              </Button>
            </div>
          </>
        )}
      </LedgerSourceCard>

      {draft.inspect && (
        <section className="kz-card jm-batches">
          <div className="jm-batch-row">
            <div className="kz-tabs">
              {draft.batches.map((value, index) => (
                <button
                  key={`${value.name}-${index}`}
                  className={index === draft.activeBatch ? "active" : ""}
                  onClick={() => patch({ activeBatch: index })}
                >
                  {value.name} ({value.accounts.length})
                </button>
              ))}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const next = addBatch(draft.batches);
                patch(next);
              }}
            >
              新增批次
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                patch(removeBatch(draft.batches, draft.activeBatch))
              }
            >
              删除批次
            </Button>
            <label className="jm-batch-name">
              批次名称
              <input
                value={batch.name}
                onChange={(e) =>
                  patch({
                    batches: draft.batches.map((value, index) =>
                      index === draft.activeBatch
                        ? { ...value, name: e.target.value }
                        : value,
                    ),
                  })
                }
              />
            </label>
          </div>
          <div className="jm-account-row">
            <span className="jm-account-label">
              {accountFilterTitle(draft.mapping)}
            </span>
            <button
              type="button"
              data-ts-filter-trigger=""
              className={`jm-account-picker${batch.accounts.length ? " active" : ""}`}
              disabled={llmBusy || missingRequired.length > 0}
              aria-expanded={menu?.field === ACCOUNT_MENU}
              onClick={(event) => {
                if (menu?.field === ACCOUNT_MENU) {
                  setMenu(undefined);
                  return;
                }
                openMenu(
                  ACCOUNT_MENU,
                  event.currentTarget.getBoundingClientRect(),
                );
              }}
            >
              {llmBusy
                ? "正在确定科目字段…"
                : batch.accounts.length
                  ? `已选 ${batch.accounts.length} 个`
                  : "点击选择目标科目"}
              <span className="ts-filter-icon">▼</span>
            </button>
            {filterCount > 0 && (
              <span className="jm-filter-note">
                另有 {filterCount} 列设了筛选条件，对所有批次一致生效
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => patch({ columnFilters: {} })}
                >
                  清除列筛选
                </Button>
              </span>
            )}
          </div>
          <p className="kz-note">
            <b>目标科目</b>决定哪些行打标记，按批次各选一套；<b>其他列的漏斗</b>
            是数据过滤，按凭证生效——
            凭证里只要有一行命中，整张凭证保留，标记只落在目标科目行上。
          </p>
        </section>
      )}

      <LedgerMappingPreview
        inspect={draft.inspect}
        mapping={draft.mapping}
        setMap={setMap}
        llmBusy={llmBusy}
        headerExtras={(header) => {
          // 科目的选择入口只留批次区上方那一个按钮；预览表头的科目列
          // 不再重复挂漏斗，避免两个入口指到同一个面板。
          if (isAccountColumn(draft.mapping, header)) return null;
          const chosen = draft.columnFilters[header] ?? [];
          return (
            <ColumnFilterTrigger
              field={header}
              chosen={chosen}
              expanded={menu?.field === header}
              onToggle={(anchor) => {
                if (!anchor) {
                  setMenu(undefined);
                  return;
                }
                openMenu(header, anchor);
              }}
            />
          );
        }}
      />

      {draft.inspect && (
        <section className="kz-card">
          <h2>标记与导出</h2>
          <label>
            输出文件
            <div className="kz-path">
              <input
                readOnly
                value={displayFileName(draft.outputPath)}
                placeholder="选择凭证文件后自动填入默认保存位置"
              />
              <Button variant="secondary" size="sm" onClick={chooseOutput}>
                选择
              </Button>
              {draft.outputTouched && (
                <Button variant="secondary" size="sm" onClick={resetOutput}>
                  恢复默认
                </Button>
              )}
            </div>
          </label>
          <p className="kz-hint">
            {draft.outputTouched
              ? "已指定保存位置，导出会以这个文件名为基准。"
              : "默认保存到凭证文件所在目录，文件名为「正负数标记_源文件名[_工作表]_<时间戳>.csv」（导出时按当前时间生成）。"}
            每个批次单独出一个文件，选 .csv 出 CSV、选 .xlsx
            出工作簿；明细最前面是
            【辅助_绝对值】【辅助_符号】【智能匹配状态】三列，后接原始列。
          </p>
          <div className="kz-actions">
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
                disabled={!ready || !validBatches.length}
                onClick={() => void start()}
              >
                标记并导出
              </Button>
            )}
          </div>
          {!validBatches.length && (
            <p className="fa-missing-hint">
              还没有为任何批次选择目标科目，导出前请先选。
            </p>
          )}
          <Result job={job} result={result} />
        </section>
      )}

      {menu && (
        <ColumnFilterMenu
          key={menu.field}
          field={
            isAccountMenu(menu.field)
              ? accountFilterTitle(draft.mapping)
              : menu.field
          }
          anchor={menu.anchor}
          loading={valuesLoading}
          data={valueCache[menu.field]}
          selected={menuSelected}
          onSearch={(keyword) => void loadValues(menu.field, keyword)}
          onApply={(checked) => applyMenu(menu.field, checked)}
          onClose={() => setMenu(undefined)}
          searchPlaceholder={
            isAccountMenu(menu.field) ? "搜索科目编码或名称" : undefined
          }
          splitCode={isAccountMenu(menu.field)}
          valueNote={
            isAccountMenu(menu.field)
              ? (value) => {
                  const others = batchesContaining(
                    draft.batches,
                    draft.activeBatch,
                    value,
                  );
                  return others.length ? `已在${others.join("、")}` : undefined;
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function Result({ job, result }: { job?: JobEvent; result?: unknown }) {
  const object =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : undefined;
  const paths = [
    ...new Set([
      ...(job?.outputPaths ?? []),
      ...(Array.isArray(object?.outputPaths)
        ? object.outputPaths.filter(
            (value): value is string => typeof value === "string",
          )
        : []),
    ]),
  ];
  const batches = Array.isArray(object?.batches)
    ? (object.batches as Record<string, unknown>[])
    : [];
  const sign =
    object?.signConvention && typeof object.signConvention === "object"
      ? (object.signConvention as {
          applied?: string;
          basis?: string;
          choice?: string;
        })
      : undefined;
  const showProgress = shouldShowKanzhangJobProgress(job?.phase);
  return (
    <Card className="kz-result">
      <CardHeader>
        <CardTitle>标记结果</CardTitle>
      </CardHeader>
      <CardContent>
        {job && showProgress && (
          <JobProgress
            job={job}
            onCancel={(jobId) => void jobCancel(jobId)}
            cancelLabel="取消任务"
          />
        )}
        {paths.length > 0 && (
          <div className="kz-outputs">
            {paths.map((path) => (
              <Button
                key={path}
                variant="secondary"
                size="sm"
                onClick={() => void openOutput(path)}
              >
                <span>打开：</span>
                <span>{displayFileName(path)}</span>
              </Button>
            ))}
          </div>
        )}
        {batches.length > 0 && (
          <div className="kz-summary">
            {batches.map((item, index) => (
              <div key={index}>
                <b>{String(item.name ?? `批次${index + 1}`)}</b>
                <span>明细 {String(item.rows ?? 0)} 行</span>
                <span>直接匹配 {String(item.matchedPairs ?? 0)} 对</span>
                <span>跨凭证匹配 {String(item.crossMatchedPairs ?? 0)} 对</span>
                <span>未匹配 {String(item.unmatchedRows ?? 0)} 行</span>
              </div>
            ))}
          </div>
        )}
        {sign?.applied && (
          <p className="kz-hint">
            本次导出金额符号口径：
            {sign.applied === "signed"
              ? "已带符号（借正贷负）"
              : "借贷符号一样（正数）"}
            {sign.choice && sign.choice !== "auto" ? "（手动指定）" : ""}
            {sign.basis ? `。依据：${sign.basis}` : ""}
          </p>
        )}
        {!result && !showProgress && <p>选好目标科目后点「标记并导出」。</p>}
      </CardContent>
    </Card>
  );
}
