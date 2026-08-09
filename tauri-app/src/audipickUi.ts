/** Helpers shared by the AudiPick extraction flow. */

export type ClassifiableRule = { id: string; name: string; docKind?: string };

export type RevenueQuestion = {
  sheet: string;
  row: number;
  questionNo: string;
  question: string;
};

/**
 * Prompt for the first pass over a revenue bundle.
 *
 * Facts are gathered without any accounting conclusion so the same extraction
 * can serve every question in the second pass, and so a supplement that
 * modifies the master agreement is visible to questions raised elsewhere.
 */
export const REVENUE_FACT_PROMPT = [
  "你是审计资料事实提取助手。只提取合同及补充资料中的客观事实，不要给出任何会计结论或准则判断。",
  "重点关注：付款条件与期限、交付与验收条款、退货与回购安排、返利与折扣、价格与变更机制、履约义务描述、是否引用其他文件（如工作说明书/SOW/订单）。",
  "只输出 JSON，不要解释。",
  "",
  '【输出格式】\n{"facts":[{"fact_type":"事实类别","fact_summary":"一句话事实","contract_excerpt":"原文摘录","qualifier":"限定条件或例外","pages":"【第N页】"}]}',
].join("\n");

/** Questions per second-pass request; 43 questions land in five batches. */
const REVENUE_BATCH_SIZE = 9;

export function buildRevenueQuestionBatches(
  questions: RevenueQuestion[],
  size = REVENUE_BATCH_SIZE,
): RevenueQuestion[][] {
  const batches: RevenueQuestion[][] = [];
  for (let index = 0; index < questions.length; index += size)
    batches.push(questions.slice(index, index + size));
  return batches;
}

/**
 * Prompt for one batch of workpaper questions.
 *
 * Asking for all 43 answers at once overruns the model's stable output length,
 * so answers get dropped or truncated with no sign that anything is missing.
 * Each batch states exactly which questions it must return and where each one
 * lives in the workpaper.
 */
export function buildRevenueBatchPrompt(
  basePrompt: string,
  batch: RevenueQuestion[],
  facts: Array<Record<string, unknown>> = [],
): string {
  const list = batch
    .map(
      (item) =>
        `- 题号 ${item.questionNo}（${item.sheet} 第 ${item.row} 行）：${item.question.replace(/\s+/g, " ").slice(0, 200)}`,
    )
    .join("\n");
  const factLines = facts
    .slice(0, 40)
    .map(
      (fact) =>
        `- ${String(fact.fact_type ?? "")}：${String(fact.fact_summary ?? "")}｜来源 ${String(fact.source_document ?? "")} ${String(fact.pages ?? "")}`,
    )
    .join("\n");
  return [
    basePrompt,
    "",
    `【本批必须逐题作答，共 ${batch.length} 题，缺一不可】`,
    list,
    factLines ? `\n【资料包已确认的客观事实，可直接引用】\n${factLines}` : "",
    "",
    "每题返回一个对象，question_no 必须与上面一致。contract_excerpt 不超过 300 字，answer_reason 不超过 200 字。",
    "只输出 JSON，不要解释。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Merge the per-batch, per-chunk answers into one answer per question.
 *
 * The same question can come back from several chunks; keep the response that
 * actually cites contract text rather than whichever arrived last.
 */
export function mergeRevenueAnswers(
  responses: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const best = new Map<string, Record<string, unknown>>();
  const weight = (item: Record<string, unknown>) =>
    String(item.contract_excerpt ?? "").length +
    String(item.answer_reason ?? "").length;
  for (const item of responses) {
    const key = String(item.question_no ?? item.questionNo ?? "");
    if (!key) continue;
    const current = best.get(key);
    if (!current || weight(item) > weight(current)) best.set(key, item);
  }
  return [...best.values()];
}

export type ClassifiedDocument = {
  ruleId: string;
  docLabel: string;
  confidence: "high" | "medium" | "low";
  reason: string;
};

/** How much of a document the classifier looks at, matching the legacy limit. */
const CLASSIFY_SAMPLE = 12_000;

/**
 * Which uploaded document a result's evidence citation refers to.
 *
 * Results extracted from a bundle carry the originating file name; matching it
 * back to a document id lets the evidence link open the right PDF instead of
 * jumping to that page number of whatever is currently on screen.
 */
export function matchEvidenceDocument(
  sourceDocuments: string,
  documents: Array<{ id: string; name: string }>,
): string | undefined {
  const haystack = sourceDocuments.trim().toLowerCase();
  if (!haystack) return undefined;
  const hit = documents
    .filter((item) => item.name.trim().length > 0)
    // Prefer the longest name so "合同.pdf" cannot shadow "合同补充协议.pdf".
    .sort((a, b) => b.name.length - a.name.length)
    .find((item) => {
      const name = item.name.toLowerCase();
      const stem = name.replace(/\.[^.]+$/, "");
      return haystack.includes(name) || (stem.length > 1 && haystack.includes(stem));
    });
  return hit?.id;
}

/** Stable key for one extraction request, used to skip repeated model calls. */
export function extractionCacheKey(
  documentId: string,
  ruleId: string,
  fieldSetId: string,
  context: string,
): string {
  let hash = 5381;
  for (let index = 0; index < context.length; index += 1)
    hash = ((hash << 5) + hash + context.charCodeAt(index)) | 0;
  return `${documentId}|${ruleId}|${fieldSetId}|${context.length}|${hash >>> 0}`;
}

/**
 * Retry a transient model call.
 *
 * A rate-limited or briefly unreachable endpoint used to fail the whole
 * extraction, which during a batch meant hunting down which contracts to redo.
 */
export async function withRetry<T>(
  run: () => Promise<T>,
  attempts = 3,
  delayMs = 2_000,
  onRetry?: (remaining: number, error: unknown) => void,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      onRetry?.(attempts - attempt - 1, error);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export function buildClassifyPrompt(rules: ClassifiableRule[]): string {
  const catalog = rules
    .map((rule) => `- ${rule.id} | ${rule.name} | ${rule.docKind === "table" ? "表格" : "条款"}`)
    .join("\n");
  return [
    "你是审计文档分类助手。只能从下面的 rule_id 列表中选择 exactly 一项作为 rule_id。只输出 JSON，不要解释。",
    "",
    "【可选 rule_id 列表（id | 名称 | 类型）】",
    catalog,
    "",
    '【输出格式】\n{"rule_id":"列表中的id","doc_label":"文档类型中文名","confidence":"high或medium或low","reason":"一句话理由"}',
  ].join("\n");
}

export function classifySample(fileName: string, text: string): string {
  return `【文件名】\n${fileName}\n\n【文档文本节选】\n${text.slice(0, CLASSIFY_SAMPLE)}`;
}

/**
 * Turn a model response into a usable recommendation.
 *
 * The model is asked to pick from a fixed list but does not always comply, so
 * anything outside the catalogue falls back to the project's preferred template
 * rather than silently selecting a rule that does not exist.
 */
export function pickClassifiedRule(
  parsed: unknown,
  ruleIds: string[],
  fallback: string,
): ClassifiedDocument {
  const value = (parsed ?? {}) as Record<string, unknown>;
  const suggested = String(value.rule_id ?? value.ruleId ?? "");
  const known = ruleIds.includes(suggested);
  const rawConfidence = String(value.confidence ?? "").toLowerCase();
  const confidence: ClassifiedDocument["confidence"] =
    rawConfidence === "high" || rawConfidence === "高"
      ? "high"
      : rawConfidence === "medium" || rawConfidence === "中"
        ? "medium"
        : "low";
  return {
    ruleId: known ? suggested : fallback,
    docLabel: String(value.doc_label ?? value.docLabel ?? ""),
    confidence: known ? confidence : "low",
    reason: known
      ? String(value.reason ?? "")
      : `模型返回的模板“${suggested || "空"}”不在可选列表中，已保留当前模板。`,
  };
}


const MAX_SINGLE_REQUEST = 10_000;
const CHUNK_SIZE = 8_000;
const PAGE_MARKER = /---PDF第(\d+)页---/g;

/** The page marker in effect at `offset`, so a chunk still reports page numbers. */
function markerBefore(text: string, offset: number): string {
  PAGE_MARKER.lastIndex = 0;
  let current = "";
  for (let match = PAGE_MARKER.exec(text); match; match = PAGE_MARKER.exec(text)) {
    if (match.index >= offset) break;
    current = match[0];
  }
  return current;
}

/**
 * Split a contract (plus any related documents) into request-sized pieces.
 *
 * Sending a long contract as a single request either exceeds the model's
 * context window or returns truncated JSON; both surface as a successful
 * extraction that quietly omits everything after the cut. Chunks break on a
 * line boundary where possible and repeat the page marker they start inside so
 * evidence page numbers stay correct.
 */
export function splitContractText(text: string): string[] {
  if (text.length <= MAX_SINGLE_REQUEST) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n", end);
      if (boundary > start + CHUNK_SIZE / 2) end = boundary + 1;
    }
    const marker = start === 0 ? "" : markerBefore(text, start);
    chunks.push(marker ? `${marker}\n${text.slice(start, end)}` : text.slice(start, end));
    start = end;
  }
  return chunks;
}
