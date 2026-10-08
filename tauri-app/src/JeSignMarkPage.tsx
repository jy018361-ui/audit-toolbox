import { useEffect, useRef, useState } from "react";
import { cancelJobWithFeedback } from "@/components/JobCommandNotice";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenJobEvents,
  openOutput,
  pickPath,
} from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./kanzhang-parity.css";
import "./je-sign-mark.css";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBox } from "@/components/ErrorBox";
import { JargonTip } from "@/components/JargonTip";
import { SwitchInput } from "@/components/SwitchInput";
import { CircleMinus, Equal, Search } from "lucide-react";
import { confirmDialog } from "@/components/ConfirmDialog";
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
  kanzhangReviewPayload,
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
  headerDepth: number;
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
  /** 是否识别损益结转凭证并从正负数配对中排除。 */
  markLossTransfer: boolean;
};

/** 后端 `kanzhang.mark_sign_report` 返回的口径检测报告。 */
type SignReport = {
  scheme: string;
  detected: "signed" | "unsigned" | null;
  basis: string;
  totalVouchers: number;
  balancedVouchers: number;
  unbalancedVouchers: number;
  oneSidedVouchers: number;
  filtered: boolean;
  keySuspect: boolean;
};

const EMPTY: JeMarkDraft = {
  inputPath: "",
  sheet: "",
  knownSheets: [],
  headerRow: 0,
  headerDepth: 0,
  mapping: EMPTY_MAPPING,
  batches: [newBatch(0)],
  activeBatch: 0,
  columnFilters: {},
  outputPath: "",
  outputTouched: false,
  signChoice: "auto",
  markLossTransfer: true,
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
  const [menu, setMenu] = useState<{ field: string; anchor: HTMLElement }>();
  const [valueCache, setValueCache] = useState<
    Record<string, ColumnFilterValues>
  >({});
  const [valuesLoading, setValuesLoading] = useState(false);
  const [signReport, setSignReport] = useState<SignReport>();
  const [signLoading, setSignLoading] = useState(false);
  const [signError, setSignError] = useState("");
  const signGeneration = useRef(0);
  const [renamingBatch, setRenamingBatch] = useState(false);
  const [batchNameDraft, setBatchNameDraft] = useState("");
  const batchNameInputRef = useRef<HTMLInputElement>(null);

  const patch = (value: Partial<JeMarkDraft>) =>
    setDraft((current) => ({ ...current, ...value }));
  const batch = draft.batches[draft.activeBatch] ?? draft.batches[0];
  const scheme = activeAmountScheme(draft.mapping);
  const missingRequired = missingKanzhangRequiredRoles(draft.mapping);
  const showReview =
    llmBusy ||
    llmFailed ||
    changes.length > 0 ||
    pending.length > 0;
  const ready = Boolean(draft.inspect) && missingRequired.length === 0;
  const validBatches = validJeMarkBatches(draft.batches);

  useEffect(() => {
    if (renamingBatch) batchNameInputRef.current?.focus();
  }, [renamingBatch, draft.activeBatch]);

  function saveBatchName() {
    const name = batchNameDraft.trim();
    if (!name) return;
    patch({
      batches: draft.batches.map((value, index) =>
        index === draft.activeBatch ? { ...value, name } : value,
      ),
    });
    setRenamingBatch(false);
  }

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

  // 历史恢复的映射/筛选暂存：读取完成（applyInspect）默认套用建议映射并
  // 清空列筛选，会把恢复成果冲掉；同一文件+Sheet 的读取完成后改用存档值
  // 顶回，一次性生效，且不再自动送 LLM 复核——那份映射用户确认过。
  const restoredDraftRef = useRef<{
    key: string;
    mapping: JeMarkDraft["mapping"];
    columnFilters: JeMarkDraft["columnFilters"];
  } | null>(null);
  const inspectKeyRef = useRef("");
  // 历史记录「继续任务」：用存档参数重建草稿（含映射/批次/筛选），并自动
  // 重新读取文件——批次/标记/导出都以读取结果为显示前提，不重读用户看到
  // 的还是空页；读取完成后 restoredDraftRef 把存档映射与列筛选顶回建议值。
  // 没有字段映射的存档（读取子步骤）不恢复，免得把现场覆盖成半成品。
  const autoReadKeyRef = useRef("");
  const [autoReadSeq, setAutoReadSeq] = useState(0);
  useTaskRestore(tool.id, (restore) => {
    const p = restore.params as {
      inputPath?: string;
      sheet?: string;
      headerRow?: number;
      headerDepth?: number;
      mapping?: JeMarkDraft["mapping"];
      targetBatches?: JeMarkDraft["batches"];
      columnFilters?: JeMarkDraft["columnFilters"];
      signConvention?: string;
      markLossTransfer?: boolean;
      outputPath?: string;
    };
    if (typeof p.inputPath !== "string" || !p.inputPath) return;
    const mapping =
      p.mapping && typeof p.mapping === "object" && Object.keys(p.mapping).length
        ? p.mapping
        : undefined;
    if (!mapping) return;
    const sheet = p.sheet ?? "";
    const columnFilters =
      p.columnFilters && typeof p.columnFilters === "object"
        ? p.columnFilters
        : {};
    restoredDraftRef.current = {
      key: `${p.inputPath}|${sheet.trim()}`,
      mapping,
      columnFilters,
    };
    autoReadKeyRef.current = `${p.inputPath}|${sheet.trim()}`;
    setAutoReadSeq((value) => value + 1);
    llmGeneration.current += 1;
    setDraft({
      ...EMPTY,
      inputPath: p.inputPath,
      sheet,
      headerRow: p.headerRow ?? 0,
      headerDepth: p.headerDepth ?? 1,
      mapping,
      batches:
        Array.isArray(p.targetBatches) && p.targetBatches.length
          ? p.targetBatches
          : [newBatch(0)],
      activeBatch: 0,
      columnFilters,
      outputPath: p.outputPath ?? "",
      outputTouched: Boolean(p.outputPath),
      signChoice:
        p.signConvention === "signed" || p.signConvention === "unsigned"
          ? p.signConvention
          : "auto",
      markLossTransfer: p.markLossTransfer ?? true,
    });
    setResult(undefined);
    setJob(undefined);
    setChanges([]);
    setPending([]);
    setLlmStatus("");
    setLlmBusy(false);
    setLlmFailed(false);
    setValueCache({});
    setMenu(undefined);
    setSignReport(undefined);
  });

  // 恢复的草稿提交到 state 后自动触发读取（setDraft 异步，恢复回调里直接
  // 调 inspect 读到的还是旧 draft；seq 触发器保证草稿恰好与恢复前相同时也
  // 会执行）。
  useEffect(() => {
    if (!autoReadKeyRef.current) return;
    const key = `${draft.inputPath}|${(draft.sheet || "").trim()}`;
    if (autoReadKeyRef.current !== key) return;
    autoReadKeyRef.current = "";
    void inspect();
  }, [autoReadSeq, draft.inputPath, draft.sheet]);

  // 没手选过保存位置时，输出框跟着凭证文件和 Sheet 走。只在来源变化时重算——
  // 默认文件名带时间戳，每次渲染都算会把自己重新触发一遍。
  const autoOutputKey = useRef("");
  useEffect(() => {
    if (draft.outputTouched) return;
    // 历史恢复挂载时本 effect 会先于恢复草稿提交跑一遍（闭包里还是空草稿），
    // 把恢复的输出路径清掉；恢复暂存未消费完时跳过。
    if (autoReadKeyRef.current) return;
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
      headerDepth: 0,
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
    change: Partial<Pick<JeMarkDraft, "sheet" | "headerRow" | "headerDepth">>,
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
    inspectKeyRef.current = `${draft.inputPath}|${(draft.sheet || "").trim()}`;
    try {
      await jobStart("kanzhang.mark_inspect", {
        inputPath: draft.inputPath,
        sheet: draft.sheet || undefined,
        headerRow: draft.headerRow,
        headerDepth: draft.headerDepth,
      });
    } catch (e) {
      setError(ledgerErrorText(e));
      setBusy(false);
    }
  }

  function applyInspect(value: Inspect) {
    // 历史恢复后用户重新读取同一文件+Sheet：用存档映射与列筛选顶回建议
    // 值，批次也不按"科目口径变化"清空——恢复的批次与映射本来配套。
    const restored = restoredDraftRef.current;
    const match =
      restored && restored.key === inspectKeyRef.current ? restored : null;
    if (match) restoredDraftRef.current = null;
    const suggested = value.suggestedMapping ?? EMPTY_MAPPING;
    const effective = match ? match.mapping : suggested;
    setValueCache({});
    setDraft((current) => ({
      ...current,
      inspect: value,
      knownSheets: value.sheets ?? current.knownSheets,
      sheet: value.selectedSheet ?? current.sheet,
      mapping: effective,
      batches: match
        ? current.batches
        : clearAccountsOnMappingChange(current.batches),
      columnFilters: match ? match.columnFilters : {},
    }));
    setResult(undefined);
    // 脚本自动映射一出来就直接送 LLM 复核，不再要求用户额外点一次按钮。
    // 恢复的映射已经用户确认过，跳过复核。
    if (match) return;
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
      headerDepth: draft.headerDepth,
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

  // 手动口径只服务于“所有凭证均为单边”的文件；一旦重新映射后检测到
  // 完整凭证，立即回到自动检测，避免隐藏的旧选择继续影响导出。
  const allVouchersOneSided = Boolean(
    signReport &&
      signReport.totalVouchers > 0 &&
      signReport.oneSidedVouchers === signReport.totalVouchers,
  );
  useEffect(() => {
    if (signReport && !allVouchersOneSided && draft.signChoice !== "auto") {
      patch({ signChoice: "auto" });
    }
  }, [allVouchersOneSided, signReport, draft.signChoice]);

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
        payload: kanzhangReviewPayload(target.headers, target.preview, source),
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
    const after = item.action === "clear"
      ? isMultiRole(item.role) ? [] : ""
      : isMultiRole(item.role)
        ? [item.suggestedColumn!.trim()]
        : item.suggestedColumn!.trim();
    if (item.action === "clear")
      patch({ mapping: { ...draft.mapping, [item.role]: undefined } });
    else setMap(item.role, after);
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
            headerDepth: draft.headerDepth,
            mapping: draft.mapping,
            keyword,
            limit: VALUE_LIMIT,
          }
        : {
            inputPath: draft.inputPath,
            sheet: draft.sheet || undefined,
            headerRow: draft.headerRow,
            headerDepth: draft.headerDepth,
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

  function openMenu(field: string, anchor: HTMLElement) {
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
        headerDepth: draft.headerDepth,
        mapping: draft.mapping,
        targetBatches: validBatches,
        columnFilters: activeColumnFilters(draft.columnFilters),
        signConvention:
          draft.signChoice === "auto" ? undefined : draft.signChoice,
        markLossTransfer: draft.markLossTransfer,
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
    allVouchersOneSided &&
    (signReport?.scheme === "A" || signReport?.scheme === "B");
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
        eyebrow="正负数凭证标记"
        title={tool.name}
        detail="加载凭证、确认字段映射，在预览表头按列筛选并按批次选定目标科目，导出带正负数智能匹配标记的完整凭证明细。"
      />
      {error && <ErrorBox error={error} onDismiss={() => setError("")} />}
      {job?.phase === "cancelled" && <div className="flex flex-wrap items-center gap-2" role="status"><Badge variant="warning">已取消</Badge><span className="hint">本次任务已停止；文件与批次设置仍保留，可重新读取或导出。</span></div>}

      <LedgerSourceCard
        className={draft.inspect ? "jm-source-loaded" : undefined}
        inputPath={draft.inputPath}
        sheet={draft.sheet}
        knownSheets={draft.knownSheets}
        headerRow={draft.headerRow}
        headerDepth={draft.headerDepth}
        detectedHeaderRow={draft.headerRow === 0 ? draft.inspect?.headerRow : undefined}
        dragHover={dragHover}
        busy={busy}
        job={job}
        needsReload={!draft.inspect && draft.knownSheets.length > 0}
        onBrowse={chooseInput}
        onClear={clearAll}
        onSheetChange={(value) => invalidate({ sheet: value, headerRow: 0, headerDepth: 0 })}
        onHeaderRowChange={(value) => invalidate({ headerRow: value })}
        onHeaderDepthChange={(value) => invalidate({ headerDepth: value })}
        onInspect={inspect}
        onCancel={(jobId) => jobCancel(jobId)}
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
                金额方案{scheme}已生效；切换前请先清空当前方案的字段。
                <JargonTip
                  term="金额方案"
                  text="金额记在一列并配借贷方向列（方案A），或分借方、贷方两列（方案B），二选一即可。"
                />
              </p>
            )}
            <div className="jm-source-footer">
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
                      <button
                        type="button"
                        className={draft.signChoice === "unsigned" ? "active" : ""}
                        aria-pressed={draft.signChoice === "unsigned"}
                        title="适用于借方、贷方金额都以正数记录，借贷方向由分列或方向字段区分的单边凭证文件。再次点击可恢复自动检测。"
                        onClick={() => patch({ signChoice: draft.signChoice === "unsigned" ? "auto" : "unsigned" })}
                      >
                        <Equal size={16} aria-hidden="true" />
                        借贷符号一样
                      </button>
                      <button
                        type="button"
                        className={draft.signChoice === "signed" ? "active" : ""}
                        aria-pressed={draft.signChoice === "signed"}
                        title="适用于金额本身已表达方向（借方为正、贷方为负）的单边凭证文件。再次点击可恢复自动检测。"
                        onClick={() => patch({ signChoice: draft.signChoice === "signed" ? "auto" : "signed" })}
                      >
                        <CircleMinus size={16} aria-hidden="true" />
                        已带符号
                      </button>
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
                  <details className="jm-sign-basis">
                    <summary>查看判定依据</summary>
                    <p>{signReport.basis}</p>
                  </details>
                )}
                {signWarnings.map((text) => (
                  <p key={text} className="jm-sign-warning">
                    {text}
                  </p>
                ))}
              </div>
            )}
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || llmBusy}
                onClick={() => void reviewMapping()}
                aria-label="重新进行 LLM 复核"
              >
                {llmBusy ? "复核中…" : "复核映射"}
              </Button>
            </div>
            {missingRequired.length > 0 && (
              <p className="fa-missing-hint">
                尚未映射：{missingRequired.join("、")}
                （请在各列顶部的下拉框中选择对应字段）
              </p>
            )}
          </>
        )}
      </LedgerSourceCard>

      {draft.inspect && (
        <section className="kz-card jm-batches">
          <h2>批次与目标科目</h2>
          <div className="jm-batch-row">
            <div className="kz-tabs" aria-label="标记批次">
              {draft.batches.map((value, index) => (
                <button
                  type="button"
                  key={`${value.name}-${index}`}
                  className={index === draft.activeBatch ? "active" : ""}
                  aria-pressed={index === draft.activeBatch}
                  onClick={() => {
                    setRenamingBatch(false);
                    patch({ activeBatch: index });
                  }}
                >
                  {value.name} · {value.accounts.length} 个科目
                </button>
              ))}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label="新增批次"
              onClick={() => {
                const next = addBatch(draft.batches);
                patch(next);
                setBatchNameDraft(next.batches[next.activeBatch].name);
                setRenamingBatch(true);
              }}
            >
              ＋ 新增批次
            </Button>
          </div>
          <div className="jm-batch-settings">
            {renamingBatch ? (
              <div className="jm-rename-row">
                <label className="jm-batch-name">
                  批次名称
                  <Input
                    ref={batchNameInputRef}
                    value={batchNameDraft}
                    onChange={(event) => setBatchNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveBatchName();
                      if (event.key === "Escape") setRenamingBatch(false);
                    }}
                    aria-invalid={!batchNameDraft.trim() || undefined}
                  />
                </label>
                <Button type="button" size="sm" onClick={saveBatchName} disabled={!batchNameDraft.trim()}>
                  保存名称
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setRenamingBatch(false)}>
                  取消
                </Button>
              </div>
            ) : (
              <div className="jm-current-batch">
                <span className="jm-current-batch-label">当前批次</span>
                <strong title={batch.name}>{batch.name}</strong>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setBatchNameDraft(batch.name);
                    setRenamingBatch(true);
                  }}
                >
                  重命名
                </Button>
              </div>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="jm-delete-batch"
              onClick={async () => {
                const onlyBatch = draft.batches.length === 1;
                const accepted = await confirmDialog({
                  title: onlyBatch ? `清空「${batch.name}」？` : `删除「${batch.name}」？`,
                  message: onlyBatch
                    ? `这会清空当前批次已选的 ${batch.accounts.length} 个目标科目，不会删除原始文件。`
                    : `这会移除当前批次及其已选的 ${batch.accounts.length} 个目标科目，不会删除原始文件。`,
                  confirmLabel: onlyBatch ? "清空批次" : "删除批次",
                  tone: "danger",
                });
                if (accepted) {
                  setRenamingBatch(false);
                  patch(removeBatch(draft.batches, draft.activeBatch));
                }
              }}
              disabled={draft.batches.length === 1 && batch.accounts.length === 0}
            >
              {draft.batches.length === 1 ? "清空批次" : "删除批次"}
            </Button>
          </div>
          <div className="jm-account-block">
            <span className="jm-account-label">目标科目</span>
            <div className="jm-account-row">
              <Button
                type="button"
                variant={batch.accounts.length ? "outline" : "default"}
                data-ts-filter-trigger=""
                className="jm-account-picker"
                disabled={llmBusy || missingRequired.length > 0}
                aria-expanded={menu?.field === ACCOUNT_MENU}
                onClick={(event) => {
                  if (menu?.field === ACCOUNT_MENU) {
                    setMenu(undefined);
                    return;
                  }
                  openMenu(ACCOUNT_MENU, event.currentTarget);
                }}
              >
                {llmBusy
                  ? "正在确定科目字段…"
                  : batch.accounts.length
                    ? "修改目标科目"
                    : "选择目标科目"}
                <Search size={16} aria-hidden="true" />
              </Button>
              <span className="jm-account-summary" title={batch.accounts.join("、")}>
                {batch.accounts.length
                  ? `已选 ${batch.accounts.length} 个：${batch.accounts.slice(0, 2).join("、")}${batch.accounts.length > 2 ? "…" : ""}`
                  : missingRequired.length > 0
                    ? "请先完成预览表中的科目字段映射"
                    : "尚未选择"}
              </span>
            </div>
            {filterCount > 0 && (
              <div className="jm-filter-note">
                另有 {filterCount} 列设了筛选条件，对所有批次一致生效
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => patch({ columnFilters: {} })}
                >
                  清除列筛选
                </Button>
              </div>
            )}
          </div>
          <p className="kz-note jm-rule-note">
            标记只应用于所选科目行；表头筛选对整张凭证生效。
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
              compact
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
          <div className="jm-export-options">
            <label>
              <SwitchInput
                checked={draft.markLossTransfer}
                onChange={(value) => patch({ markLossTransfer: value })}
                ariaLabel="标记损益结转凭证"
              />
              <span>
                <b>标记损益结转凭证</b>
                <small>命中本年利润或未分配利润的整张凭证会标记为“损益结转”，并不参与正负数配对。</small>
              </span>
            </label>
          </div>
          <label>
            输出文件
            <div className="kz-path">
              <Input
                readOnly
                value={displayFileName(draft.outputPath)}
                title={draft.outputPath}
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
          <details className="jm-export-help">
            <summary>导出文件格式与列说明</summary>
            <p className="kz-hint">
            {draft.outputTouched
              ? "已指定保存位置，导出会以这个文件名为基准。"
              : "默认保存到凭证文件所在目录，文件名为「正负数标记_源文件名[_工作表]_<时间戳>.csv」（导出时按当前时间生成）。"}
            每个批次单独出一个文件，选 .csv 出 CSV、选 .xlsx
            出工作簿；明细最前面是
            {draft.markLossTransfer ? "【损益结转】" : ""}
            【辅助_绝对值】【辅助_符号】【智能匹配状态】列，后接原始列。
            </p>
          </details>
          {!validBatches.length && (
            <p className="fa-missing-hint" role="status">
              请先在上方选择至少一个目标科目。
            </p>
          )}
          <div className="kz-actions">
            {busy && job ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void cancelJobWithFeedback(job.jobId)}
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
          defaultSelectAll={!isAccountMenu(menu.field)}
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
  // 读取文件也会产生 job/result，但只有标记导出才有值得展示的结果。
  // 失败或取消后上方已显示任务反馈，这里不再留下空白结果卡。
  if (!showProgress && !paths.length && !batches.length && !sign?.applied) return null;
  return (
    <Card variant="workspace" className="kz-result">
      <CardHeader>
        <CardTitle>标记结果</CardTitle>
      </CardHeader>
      <CardContent>
        {job && showProgress && (
          <JobProgress
            job={job}
            onCancel={(jobId) => jobCancel(jobId)}
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
                title={path}
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
                <span>损益结转 {String(item.lossTransferVouchers ?? 0)} 笔</span>
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
      </CardContent>
    </Card>
  );
}
