import { useEffect, useMemo, useRef, useState } from "react";
import type { JobEvent, ToolManifest } from "./types";
import { engineCall, jobCancel, jobStart, listenJobEvents, listenPositionedFileDrops, openOutput, pickPath } from "./api";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { MappingPanel, type MappingDict } from "@/components/MappingPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import "./fuzzy-match.css";

/** 命中测试：拖放坐标（CSS 像素）是否落在元素框内。导出供测试。 */
export function rectHit(x: number, y: number, el: HTMLElement | null): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/**
 * 两列模糊匹配。方法名与参数名和 Rust 侧 fuzzy 模块的接口契约一一对应，
 * 不得改名：fuzzy.inspect / fuzzy.match / fuzzy.export / fuzzy.get_results / fuzzy.save_confirm。
 */
type Kind = "a" | "b";
export type FuzzyMatchType = "company" | "person" | "address" | "generic";
export type ConfirmAction = "accept" | "reject";
export type Confirmation = {
  aIndex: number;
  bIndex: number | null;
  action: ConfirmAction;
  note?: string;
};
export type FuzzyCandidate = {
  bIndex: number;
  bValue: string;
  level: "auto" | "suspect";
  total: number;
  breakdown: { charSim: number; lcsSim: number; tokenOverlap: number };
  reasons: string[];
};
export type FuzzyResultRow = { aIndex: number; aValue: string; matches: FuzzyCandidate[] };
export type FuzzySummary = {
  rowsA: number;
  rowsB: number;
  autoCount: number;
  suspectCount: number;
  unmatchedCount: number;
  invalidCount: number;
  elapsedMs: number;
};
export type ScoreBand = "all" | "70-80" | "80-90";
type RowLevel = "auto" | "suspect" | "unmatched";
type Inspection = { headers: string[]; preview: string[][]; rowCount: number; sheet: string; sheets: string[] };
type SourceState = { path: string; headerRow: number; inspection?: Inspection; mapping: MappingDict };

/** 确认进度草稿的 sessionStorage 键；结构是 {jobId, confirmations[]}。 */
export const DRAFT_KEY = "fuzzy-match-draft.v1";
/** B 侧参与逐行精算的候选上限，与 Rust 侧口径一致，用于预估比对次数。 */
export const COMPARISON_CAP = 200;
/** 「相似度≥85 全部采纳」批量确认的默认分数线。 */
export const AUTO_ACCEPT_THRESHOLD = 85;
/** 预估比对次数超过该值时给出耗时警示。 */
export const COMPARISON_WARN_AT = 500_000;

export const MATCH_TYPE_OPTIONS: Array<[FuzzyMatchType, string, string]> = [
  ["company", "公司名称", "先清洗括号简称、行政区域与组织形式，再比对全称"],
  ["person", "人名", "忽略姓名中的空格与中英文姓名顺序差异后比对"],
  ["address", "地址", "按行政区域、路名门牌等分词的重叠度比对"],
  ["generic", "通用文本", "不做事前清洗，直接按字符相似度比对"],
];
export const MATCH_TYPE_LABEL: Record<FuzzyMatchType, string> = Object.fromEntries(
  MATCH_TYPE_OPTIONS.map(([value, label]) => [value, label]),
) as Record<FuzzyMatchType, string>;

/**
 * 预估候选比对次数：A 侧每行最多与 B 侧前 COMPARISON_CAP 行做精算比对。
 * 任一侧没有数据时无需比对。
 */
export function estimateComparisons(rowsA: number, rowsB: number): number {
  if (!Number.isFinite(rowsA) || !Number.isFinite(rowsB) || rowsA <= 0 || rowsB <= 0) return 0;
  return Math.round(rowsA * Math.min(rowsB, COMPARISON_CAP));
}

/** 阈值校验：0 < 疑似阈值 < 自动阈值 ≤ 100。返回空串表示通过。 */
export function validateThresholds(auto: number, suspect: number): string {
  if (!Number.isFinite(auto) || !Number.isFinite(suspect)) return "自动匹配阈值与疑似阈值必须为数字。";
  if (suspect <= 0) return "疑似阈值必须大于 0。";
  if (suspect >= auto) return "自动匹配阈值必须大于疑似阈值。";
  if (auto > 100) return "自动匹配阈值不能超过 100。";
  return "";
}

/** 行级状态：存在自动匹配候选 → auto；只有疑似候选 → suspect；没有候选 → unmatched。 */
export function rowLevel(row: FuzzyResultRow): RowLevel {
  if (row.matches.some((m) => m.level === "auto")) return "auto";
  return row.matches.length > 0 ? "suspect" : "unmatched";
}

/** 最高分候选（不依赖返回顺序，直接取 total 最大者）。 */
export function bestCandidate(row: FuzzyResultRow): FuzzyCandidate | undefined {
  return row.matches.reduce<FuzzyCandidate | undefined>(
    (best, m) => (!best || m.total > best.total ? m : best),
    undefined,
  );
}

/** 疑似确认队列的进度统计：只统计疑似行，其余行不进入确认流程。 */
export function confirmStats(rows: FuzzyResultRow[], confirmations: Confirmation[]) {
  const suspects = rows.filter((r) => rowLevel(r) === "suspect");
  const done = new Map(confirmations.map((c) => [c.aIndex, c]));
  let accepted = 0;
  let rejected = 0;
  for (const row of suspects) {
    const c = done.get(row.aIndex);
    if (c?.action === "accept") accepted += 1;
    else if (c?.action === "reject") rejected += 1;
  }
  const confirmed = accepted + rejected;
  return { total: suspects.length, confirmed, accepted, rejected, pending: suspects.length - confirmed };
}

/** 确认列表按 aIndex 去重合并：patch 覆盖 base 中的同号确认。 */
export function mergeConfirmations(base: Confirmation[], patch: Confirmation[]): Confirmation[] {
  const next = [...base];
  for (const item of patch) {
    const index = next.findIndex((c) => c.aIndex === item.aIndex);
    if (index >= 0) next[index] = item;
    else next.push(item);
  }
  return next;
}

/** 解析 sessionStorage 草稿；结构不完整时返回 null，宁可丢草稿也不能把坏数据喂给渲染。 */
export function parseDraft(text: string | null): { jobId: string; confirmations: Confirmation[] } | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.jobId !== "string" || !raw.jobId) return null;
    if (!Array.isArray(raw.confirmations)) return null;
    const confirmations: Confirmation[] = [];
    for (const item of raw.confirmations) {
      const c = item as Record<string, unknown>;
      if (
        typeof c.aIndex !== "number" ||
        (c.bIndex !== null && typeof c.bIndex !== "number") ||
        (c.action !== "accept" && c.action !== "reject")
      )
        return null;
      confirmations.push({
        aIndex: c.aIndex,
        bIndex: c.bIndex ?? null,
        action: c.action,
        ...(typeof c.note === "string" && c.note ? { note: c.note } : {}),
      });
    }
    return { jobId: raw.jobId, confirmations };
  } catch {
    return null;
  }
}

export function draftToJson(jobId: string, confirmations: Confirmation[]): string {
  return JSON.stringify({ jobId, confirmations });
}

/** 疑似候选的分数区间筛选：区间左闭右开，与工具条文案一致。 */
export function inScoreBand(total: number, band: ScoreBand): boolean {
  if (band === "70-80") return total >= 70 && total < 80;
  if (band === "80-90") return total >= 80 && total < 90;
  return true;
}

/** 「相似度≥阈值 全部采纳」的候选清单：未确认且最高分达线的疑似行。 */
export function autoAcceptList(
  rows: FuzzyResultRow[],
  confirmations: Confirmation[],
  threshold = AUTO_ACCEPT_THRESHOLD,
): Confirmation[] {
  const done = new Set(confirmations.map((c) => c.aIndex));
  const items: Confirmation[] = [];
  for (const row of rows) {
    if (rowLevel(row) !== "suspect" || done.has(row.aIndex)) continue;
    const best = bestCandidate(row);
    if (best && best.total >= threshold) items.push({ aIndex: row.aIndex, bIndex: best.bIndex, action: "accept" });
  }
  return items;
}

const SOURCE_LABEL: Record<Kind, string> = { a: "来源 A", b: "来源 B" };
const SOURCE_HINT: Record<Kind, string> = {
  a: "待核对的一列文本，例如账面记录的公司名称。",
  b: "作为基准的一列文本，例如函证清单或工商清单中的公司名称。",
};
const ROW_LEVEL_LABEL: Record<RowLevel | "invalid", string> = {
  auto: "自动匹配",
  suspect: "疑似待确认",
  unmatched: "未匹配",
  invalid: "无效值",
};
const formatScore = (value: number) => (Number.isFinite(value) ? String(Math.round(value)) : "—");
const formatCount = (value: number) => value.toLocaleString("zh-CN");

export function FuzzyMatchPage({ tool }: { tool: ToolManifest }) {
  const emptySource = (): SourceState => ({ path: "", headerRow: 1, mapping: {} });
  const [sources, setSources] = useState<Record<Kind, SourceState>>({ a: emptySource(), b: emptySource() });
  const [matchType, setMatchType] = useState<FuzzyMatchType>("company");
  const [autoThreshold, setAutoThreshold] = useState(90);
  const [suspectThreshold, setSuspectThreshold] = useState(70);
  const [topK, setTopK] = useState(3);
  const [busy, setBusyState] = useState(false);
  // 拖放回调在 effect 闭包里读不到最新 busy state，用 ref 镜像一份。
  const busyRef = useRef(false);
  const setBusy = (v: boolean) => {
    busyRef.current = v;
    setBusyState(v);
  };
  const [error, setError] = useState("");
  const [job, setJob] = useState<JobEvent>();
  const [jobKind, setJobKind] = useState<"match" | "export">("match");
  const [jobId, setJobId] = useState("");
  const [summary, setSummary] = useState<FuzzySummary>();
  const [rows, setRows] = useState<FuzzyResultRow[]>([]);
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [statusFilter, setStatusFilter] = useState<RowLevel | "invalid" | "all">("all");
  const [band, setBand] = useState<ScoreBand>("all");
  const [onlyPending, setOnlyPending] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [restoreNote, setRestoreNote] = useState("");
  const [exportOutputs, setExportOutputs] = useState<string[]>([]);
  // 双来源卡内容区的 DOM ref：拖放坐标命中测试（同存款利息的 uploadDropRef 模式）。
  const cardRefs = useRef<Record<Kind, HTMLElement | null>>({ a: null, b: null });
  const activeJob = useRef("");
  const activeMethod = useRef<"match" | "export">("match");

  const thresholdProblem = validateThresholds(autoThreshold, suspectThreshold);
  const columnOf = (s: SourceState) => (typeof s.mapping.column === "string" ? s.mapping.column.trim() : "");
  const aReady = Boolean(sources.a.inspection) && Boolean(columnOf(sources.a));
  const bReady = Boolean(sources.b.inspection) && Boolean(columnOf(sources.b));
  const rowsA = sources.a.inspection?.rowCount ?? 0;
  const rowsB = sources.b.inspection?.rowCount ?? 0;
  const estimate = estimateComparisons(rowsA, rowsB);

  const confirmMap = useMemo(() => new Map(confirmations.map((c) => [c.aIndex, c])), [confirmations]);
  const stats = useMemo(() => confirmStats(rows, confirmations), [rows, confirmations]);
  const batch = useMemo(() => autoAcceptList(rows, confirmations), [rows, confirmations]);

  // 任务事件：匹配与导出共用一条事件流，靠当前 jobId 过滤。
  useEffect(() => {
    const stop = listenJobEvents((e) => {
      if (e.jobId !== activeJob.current) return;
      setJob(e);
      if (e.phase === "completed") {
        setBusy(false);
        const r = (e.result ?? {}) as { summary?: FuzzySummary; rows?: FuzzyResultRow[]; outputPaths?: string[] };
        if (r.summary) {
          setSummary(r.summary);
          setRows(r.rows ?? []);
          setJobId(e.jobId);
          setStatusFilter("all");
        }
        const outputs = [...(e.outputPaths ?? []), ...(r.outputPaths ?? [])];
        if (outputs.length) {
          setExportOutputs(outputs);
          for (const p of outputs) void openOutput(p);
        }
      } else if (e.phase === "failed" || e.phase === "cancelled") {
        setBusy(false);
        const p = e.result as { error?: { userMessage?: string } } | undefined;
        setError(p?.error?.userMessage ?? e.message);
      }
    });
    return () => {
      void stop.then((x) => x());
    };
  }, []);

  // 跨会话恢复：sessionStorage 里只有确认草稿，明细要靠 fuzzy.get_results 找回；
  // Rust 侧没有该任务的结果时就提示重跑，不当作错误弹层。
  useEffect(() => {
    const draft = parseDraft(sessionStorage.getItem(DRAFT_KEY));
    if (!draft) return;
    setJobId(draft.jobId);
    setConfirmations(draft.confirmations);
    void engineCall("fuzzy.get_results", { jobId: draft.jobId })
      .then((r) => {
        const x = (r ?? {}) as { summary?: FuzzySummary; rows?: FuzzyResultRow[]; confirmations?: Confirmation[] };
        if (x.summary) setSummary(x.summary);
        if (x.rows) setRows(x.rows);
        setConfirmations(mergeConfirmations(x.confirmations ?? [], draft.confirmations));
      })
      .catch(() => setRestoreNote(`上次任务 ${draft.jobId} 在本机没有可恢复的匹配结果，请重新运行匹配后继续确认。`));
  }, []);

  // 确认进度草稿：jobId 与确认列表任一变化就落一份，页面重挂载即可接续。
  useEffect(() => {
    if (!jobId) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, draftToJson(jobId, confirmations));
    } catch {
      // sessionStorage 被禁用或超限时静默跳过，草稿只是体验增强。
    }
  }, [jobId, confirmations]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const setSource = (kind: Kind, next: Partial<SourceState>) =>
    setSources((v) => ({ ...v, [kind]: { ...v[kind], ...next } }));

  async function inspect(kind: Kind, over: { path?: string; sheet?: string; headerRow?: number }) {
    const current = sources[kind];
    const path = over.path ?? current.path;
    if (!path) return;
    const sheet = over.sheet ?? current.inspection?.sheet ?? "";
    const headerRow = over.headerRow ?? current.headerRow ?? 1;
    setBusy(true);
    setError("");
    try {
      const x = (await engineCall("fuzzy.inspect", {
        kind,
        source: { inputPath: path, sheet, headerRow, headerDepth: 1 },
      })) as Inspection;
      setSource(kind, { path, headerRow, inspection: x, mapping: {} });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function browse(kind: Kind) {
    const picked = await pickPath("file", `选择${SOURCE_LABEL[kind]}表格文件`, ["xlsx", "xls", "csv"]);
    if (typeof picked !== "string") return;
    setSource(kind, { path: picked, inspection: undefined, mapping: {} });
    await inspect(kind, { path: picked, sheet: "", headerRow: 1 });
  }

  /** 拖放落地：取第一个表格类文件投给命中的来源卡，非表格文件忽略。 */
  async function dropInto(kind: Kind, paths: string[]) {
    const file = paths.find((p) => /\.(xlsx?|csv)$/i.test(p));
    if (!file) return;
    setSource(kind, { path: file, inspection: undefined, mapping: {} });
    await inspect(kind, { path: file, sheet: "", headerRow: 1 });
  }

  useEffect(() => {
    // 拖放到窗口由 Tauri 统一接收（FileDropInput 本身不监听拖放）：按坐标
    // 命中 A/B 卡片的内容区；两张卡都不命中则忽略——宁可让用户再拖一次，
    // 也不投错清单。读取进行中（busyRef）不接受新拖放，避免两次 inspect 交叉。
    const stop = listenPositionedFileDrops(({ paths, x, y }) => {
      if (busyRef.current) return;
      for (const kind of ["a", "b"] as Kind[]) {
        if (rectHit(x, y, cardRefs.current[kind])) {
          void dropInto(kind, paths);
          return;
        }
      }
    });
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  async function start() {
    setError("");
    if (!sources.a.inspection || !sources.b.inspection) return setError("请先选择并读取来源 A、来源 B 两个表格文件。");
    if (!columnOf(sources.a)) return setError("请先在来源 A 预览表头里选择匹配列。");
    if (!columnOf(sources.b)) return setError("请先在来源 B 预览表头里选择匹配列。");
    const problem = validateThresholds(autoThreshold, suspectThreshold);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const id = await jobStart("fuzzy.match", {
        sourceA: {
          inputPath: sources.a.path,
          sheet: sources.a.inspection.sheet,
          headerRow: sources.a.headerRow,
          column: columnOf(sources.a),
        },
        sourceB: {
          inputPath: sources.b.path,
          sheet: sources.b.inspection.sheet,
          headerRow: sources.b.headerRow,
          column: columnOf(sources.b),
        },
        matchType,
        autoThreshold,
        suspectThreshold,
        topK,
      });
      activeJob.current = id;
      activeMethod.current = "match";
      setJobKind("match");
      setJob(undefined);
      setJobId(id);
      setConfirmations([]);
      setSummary(undefined);
      setRows([]);
      setExportOutputs([]);
      setStatusFilter("all");
      setRestoreNote("");
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
    }
  }

  /** 确认先落本地与草稿，再异步保存；保存失败只提示，不阻塞确认流程。 */
  function commitConfirmations(items: Confirmation[]) {
    if (!items.length) return;
    setConfirmations((current) => mergeConfirmations(current, items));
    const id = jobId;
    if (!id) return;
    void engineCall("fuzzy.save_confirm", { jobId: id, confirmations: items }).catch(() =>
      setNotice("确认已在本页生效，但保存到任务记录失败，稍后会随下一次确认重试。"),
    );
  }

  function undoConfirmation(aIndex: number) {
    setConfirmations((current) => current.filter((c) => c.aIndex !== aIndex));
  }

  async function exportExcel() {
    if (!jobId) return setError("请先完成一次匹配，再导出结果。");
    const path = await pickPath("save", "保存匹配结果", ["xlsx"], "模糊匹配结果.xlsx");
    if (typeof path !== "string") return;
    setError("");
    setBusy(true);
    try {
      activeJob.current = await jobStart("fuzzy.export", { jobId, outputPath: path });
      activeMethod.current = "export";
      setJobKind("export");
      setJob(undefined);
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
    }
  }

  const typeIntro = MATCH_TYPE_OPTIONS.find(([value]) => value === matchType)?.[2] ?? "";

  return (
    <main className="tool-page fx-page fuzzy-page">
      <PageHeader
        eyebrow="审计核对"
        title={tool.name}
        detail="对两列公司名称、人名、地址或通用文本做模糊匹配：高相似度自动采纳，疑似项逐条人工确认，确认进度可续作并导出底稿。"
      />
      <ErrorBox error={error} onDismiss={() => setError("")} />
      {restoreNote && <p className="fa-missing-hint">{restoreNote}</p>}

      <div className="fuzzy-sources">
        {(["a", "b"] as Kind[]).map((kind) => {
          const s = sources[kind];
          return (
            <Card key={kind} className="fuzzy-source-card">
              <CardHeader>
                <CardTitle>{SOURCE_LABEL[kind]}{kind === "a" ? "（待核对清单）" : "（基准清单）"}</CardTitle>
              </CardHeader>
              <CardContent>
                <div
                  ref={(el) => {
                    cardRefs.current[kind] = el;
                  }}
                >
                <p className="fx-hint">{SOURCE_HINT[kind]}</p>
                <FileDropInput
                  value={s.path}
                  disabled={busy}
                  placeholder={`选择${SOURCE_LABEL[kind]} 文件`}
                  onBrowse={() => void browse(kind)}
                  onDragStateChange={() => {}}
                  onClear={() => setSource(kind, emptySource())}
                />
                {s.inspection && (
                  <div className="fuzzy-source-meta">
                    <span>
                      已识别 {formatCount(s.inspection.rowCount)} 行 · {s.inspection.sheet}
                    </span>
                    <label>
                      Sheet
                      <select
                        value={s.inspection.sheet}
                        disabled={busy}
                        onChange={(e) => void inspect(kind, { sheet: e.target.value })}
                      >
                        {s.inspection.sheets.length
                          ? s.inspection.sheets.map((x) => <option key={x}>{x}</option>)
                          : <option>{s.inspection.sheet}</option>}
                      </select>
                    </label>
                    <label>
                      表头行
                      <input
                        type="number"
                        min={1}
                        disabled={busy}
                        value={s.headerRow}
                        onChange={(e) => void inspect(kind, { headerRow: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                )}
                {s.inspection && (
                  <MappingPanel
                    title={`${SOURCE_LABEL[kind]}匹配列`}
                    note={`${formatCount(s.inspection.rowCount)} 行 × ${s.inspection.headers.length} 列`}
                    headers={s.inspection.headers}
                    rows={s.inspection.preview}
                    mapping={s.mapping}
                    roles={[["column", "匹配列"]]}
                    missing={columnOf(s) ? [] : ["匹配列"]}
                    busy={busy}
                    maxHeight={260}
                    onChange={(next) => setSource(kind, { mapping: next })}
                  />
                )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>匹配设置</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="fuzzy-settings-grid">
            <label>
              数据类型
              <select
                aria-label="数据类型"
                value={matchType}
                disabled={busy}
                onChange={(e) => setMatchType(e.target.value as FuzzyMatchType)}
              >
                {MATCH_TYPE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <p className="fx-hint">{typeIntro}</p>
          </div>
          <details className="fuzzy-advanced">
            <summary>高级设置</summary>
            <div className="fuzzy-advanced-grid">
              <label>
                自动匹配阈值（≥ 此分直接采纳）
                <input type="number" min={1} max={100} value={Number.isFinite(autoThreshold) ? autoThreshold : ""} onChange={(e) => setAutoThreshold(Number(e.target.value))} />
              </label>
              <label>
                疑似阈值（≥ 此分进入人工确认）
                <input type="number" min={1} max={100} value={Number.isFinite(suspectThreshold) ? suspectThreshold : ""} onChange={(e) => setSuspectThreshold(Number(e.target.value))} />
              </label>
              <label>
                每行候选数 topK
                <input type="number" min={1} max={10} value={Number.isFinite(topK) ? topK : ""} onChange={(e) => setTopK(Number(e.target.value))} />
              </label>
            </div>
            {thresholdProblem && <p className="fa-missing-hint">{thresholdProblem}</p>}
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>预估与启动</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="fuzzy-estimate">
            <p>
              A 侧 {formatCount(rowsA)} 行 / B 侧 {formatCount(rowsB)} 行，预计候选比对约{" "}
              <b>{formatCount(estimate)}</b> 次（A 每行最多与 B 侧前 {COMPARISON_CAP} 行精算比对）。
            </p>
            {estimate > COMPARISON_WARN_AT && (
              <p className="fuzzy-estimate-warn">
                预计比对次数超过 50 万，匹配可能耗时较长；建议先按 Sheet 或期间拆分文件、分批核对。
              </p>
            )}
            <div className="fx-actions">
              <Button disabled={busy || !aReady || !bReady || Boolean(thresholdProblem)} onClick={() => void start()}>
                开始匹配
              </Button>
            </div>
            {jobKind === "match" && job && <JobProgress job={job} onCancel={busy ? (id) => void jobCancel(id) : undefined} />}
            <p className="fx-hint">离开本页后任务仍在后台运行，可在任务中心查看进度；完成后回到本页继续确认。</p>
          </div>
        </CardContent>
      </Card>

      {summary && (
        <section className="fuzzy-result">
          <div className="fx-result-heading">
            <div>
              <h3>匹配结果</h3>
              <p>
                A 侧 {formatCount(summary.rowsA)} 行、B 侧 {formatCount(summary.rowsB)} 行，耗时{" "}
                {(summary.elapsedMs / 1000).toFixed(1)} 秒；点击指标可筛选明细。
              </p>
            </div>
          </div>
          <div className="fuzzy-pills">
            {(["auto", "suspect", "unmatched", "invalid"] as const).map((level) => {
              const value =
                level === "auto" ? summary.autoCount
                  : level === "suspect" ? summary.suspectCount
                  : level === "unmatched" ? summary.unmatchedCount
                  : summary.invalidCount;
              return (
                <button
                  key={level}
                  type="button"
                  className={`fuzzy-pill${statusFilter === level ? " active" : ""}`}
                  onClick={() => setStatusFilter(statusFilter === level ? "all" : level)}
                >
                  <span>{ROW_LEVEL_LABEL[level]}</span>
                  <strong>{formatCount(value)}</strong>
                </button>
              );
            })}
          </div>
          <div className="fuzzy-table">
            <table>
              <thead>
                <tr>
                  <th>A 原文</th>
                  <th>匹配对象</th>
                  <th>状态</th>
                  <th>总分</th>
                  <th>理由</th>
                  <th>确认状态</th>
                </tr>
              </thead>
              <tbody>
                {statusFilter === "invalid" ? (
                  <tr>
                    <td colSpan={6} className="fuzzy-empty">空白等无效值不参与匹配，导出底稿中会单独列示。</td>
                  </tr>
                ) : rows.filter((r) => statusFilter === "all" || rowLevel(r) === statusFilter).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="fuzzy-empty">当前分类下没有明细行。</td>
                  </tr>
                ) : (
                  rows
                    .filter((r) => statusFilter === "all" || rowLevel(r) === statusFilter)
                    .map((r) => {
                      const best = bestCandidate(r);
                      const level = rowLevel(r);
                      const c = confirmMap.get(r.aIndex);
                      const accepted = r.matches.find((m) => m.bIndex === c?.bIndex);
                      const confirmState = !c
                        ? level === "suspect" ? "待确认" : "—"
                        : c.action === "accept"
                          ? `已采纳（${accepted?.bValue ?? `B#${c.bIndex}`}）`
                          : "已拒绝（都不是）";
                      return (
                        <tr key={r.aIndex}>
                          <td title={r.aValue}>{r.aValue}</td>
                          <td title={best?.bValue}>{best?.bValue ?? "—"}</td>
                          <td><span className={`fuzzy-level fuzzy-level-${level}`}>{ROW_LEVEL_LABEL[level]}</span></td>
                          <td>{best ? formatScore(best.total) : "—"}</td>
                          <td title={best?.reasons.join("，")}>{best?.reasons.join("，") || "—"}</td>
                          <td>{confirmState}</td>
                        </tr>
                      );
                    })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {summary && (
        <ConfirmQueue
          rows={rows}
          confirmations={confirmations}
          band={band}
          onlyPending={onlyPending}
          onBand={setBand}
          onOnlyPending={setOnlyPending}
          onAccept={(row, candidate) => commitConfirmations([{ aIndex: row.aIndex, bIndex: candidate.bIndex, action: "accept" }])}
          onReject={(row) => commitConfirmations([{ aIndex: row.aIndex, bIndex: null, action: "reject" }])}
          onUndo={undoConfirmation}
          onBatch={() => setBatchOpen(true)}
          batchCount={batch.length}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>导出底稿</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="fx-hint">
            导出的 Excel 包含自动匹配、疑似项（含人工确认结果）、未匹配与无效值全部明细；确认进度会随导出一并写入。
          </p>
          <div className="fx-actions">
            <Button disabled={busy || !jobId} onClick={() => void exportExcel()}>导出 Excel</Button>
            {exportOutputs.map((p) => (
              <Button key={p} variant="secondary" onClick={() => void openOutput(p)}>打开导出文件</Button>
            ))}
          </div>
          {jobKind === "export" && job && <JobProgress job={job} onCancel={busy ? (id) => void jobCancel(id) : undefined} />}
        </CardContent>
      </Card>

      {batchOpen && (
        <div className="fuzzy-modal-mask" role="presentation" onClick={() => setBatchOpen(false)}>
          <div className="fuzzy-modal" role="dialog" aria-label="批量采纳确认" onClick={(e) => e.stopPropagation()}>
            <h4>批量采纳相似度≥{AUTO_ACCEPT_THRESHOLD} 的候选</h4>
            <p>
              将对 {batch.length} 条未确认且最高分达到 {AUTO_ACCEPT_THRESHOLD} 分的疑似行自动采纳最高分候选。
              此操作逐条落库，采纳后仍可在卡片上重新选择。
            </p>
            <div className="fuzzy-modal-actions">
              <Button variant="secondary" onClick={() => setBatchOpen(false)}>取消</Button>
              <Button
                disabled={!batch.length}
                onClick={() => {
                  commitConfirmations(batch);
                  setBatchOpen(false);
                }}
              >
                全部采纳
              </Button>
            </div>
          </div>
        </div>
      )}

      {notice && <div className="fuzzy-notice" role="status">{notice}</div>}
    </main>
  );
}

function ConfirmQueue(props: {
  rows: FuzzyResultRow[];
  confirmations: Confirmation[];
  band: ScoreBand;
  onlyPending: boolean;
  onBand: (band: ScoreBand) => void;
  onOnlyPending: (value: boolean) => void;
  onAccept: (row: FuzzyResultRow, candidate: FuzzyCandidate) => void;
  onReject: (row: FuzzyResultRow) => void;
  onUndo: (aIndex: number) => void;
  onBatch: () => void;
  batchCount: number;
}) {
  const { rows, confirmations } = props;
  const stats = confirmStats(rows, confirmations);
  const done = new Map(confirmations.map((c) => [c.aIndex, c]));
  const suspects = rows.filter((r) => rowLevel(r) === "suspect");
  const visible = suspects.filter((r) => {
    if (props.onlyPending && done.has(r.aIndex)) return false;
    const best = bestCandidate(r);
    return best ? inScoreBand(best.total, props.band) : props.band === "all";
  });

  if (!suspects.length)
    return (
      <section className="fuzzy-result">
        <div className="fx-result-heading">
          <div>
            <h3>疑似确认</h3>
            <p>本次匹配没有需要人工确认的疑似行。</p>
          </div>
        </div>
      </section>
    );

  return (
    <section className="fuzzy-result">
      <div className="fx-result-heading">
        <div>
          <h3>疑似确认</h3>
          <p>逐条核对候选：点选右侧任一候选即采纳，「都不是」表示拒绝匹配。</p>
        </div>
      </div>
      <div className="fuzzy-confirm-toolbar">
        <span>
          已确认 <b>{stats.confirmed}</b> / 总数 {stats.total}
          （采纳 {stats.accepted}、拒绝 {stats.rejected}、待确认 {stats.pending}）
        </span>
        <span className="fuzzy-toolbar-spacer" />
        <label>
          分数区间
          <select aria-label="分数区间" value={props.band} onChange={(e) => props.onBand(e.target.value as ScoreBand)}>
            <option value="all">全部</option>
            <option value="70-80">70–80 分</option>
            <option value="80-90">80–90 分</option>
          </select>
        </label>
        <label className="fuzzy-check">
          <input type="checkbox" checked={props.onlyPending} onChange={(e) => props.onOnlyPending(e.target.checked)} />
          仅看未确认
        </label>
        <Button variant="secondary" disabled={!props.batchCount} onClick={props.onBatch}>
          相似度≥{AUTO_ACCEPT_THRESHOLD} 全部采纳（{props.batchCount}）
        </Button>
      </div>
      <div className="fuzzy-cards">
        {visible.map((row) => {
          const c = done.get(row.aIndex);
          const accepted = row.matches.find((m) => m.bIndex === c?.bIndex);
          return (
            <div key={row.aIndex} className={`fuzzy-confirm-card${c ? " done" : ""}`}>
              <div className="fuzzy-confirm-a">
                <span className="fuzzy-confirm-index">A#{row.aIndex + 1}</span>
                <b title={row.aValue}>{row.aValue}</b>
                {c && (
                  <span className="fuzzy-done-row">
                    {c.action === "accept" ? `已采纳：${accepted?.bValue ?? `B#${c.bIndex}`}` : "已拒绝（都不是）"}
                    <button type="button" className="fuzzy-redo" onClick={() => props.onUndo(row.aIndex)}>
                      重选
                    </button>
                  </span>
                )}
              </div>
              <div className="fuzzy-candidates">
                {row.matches.map((m) => (
                  <button key={m.bIndex} type="button" className="fuzzy-candidate" onClick={() => props.onAccept(row, m)}>
                    <span className="fuzzy-candidate-head">
                      <b title={m.bValue}>{m.bValue}</b>
                      <span className="fuzzy-candidate-score">{formatScore(m.total)} 分</span>
                    </span>
                    {m.reasons.length > 0 && <small>{m.reasons.join("，")}</small>}
                    <small className="fuzzy-breakdown">
                      <span>字面相似 {formatScore(m.breakdown.charSim)}</span>
                      <span>公共子串 {formatScore(m.breakdown.lcsSim)}</span>
                      <span>词元重叠 {formatScore(m.breakdown.tokenOverlap)}</span>
                    </small>
                  </button>
                ))}
                <button type="button" className="fuzzy-reject" onClick={() => props.onReject(row)}>
                  都不是（拒绝匹配）
                </button>
              </div>
            </div>
          );
        })}
        {!visible.length && <p className="fuzzy-empty">当前筛选下没有待确认的疑似行。</p>}
      </div>
    </section>
  );
}

function errorText(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return String(v.userMessage ?? v.message ?? v.detail ?? "处理失败，请重试。");
  }
  return "处理失败，请重试。";
}
