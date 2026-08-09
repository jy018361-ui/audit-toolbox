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
const FALLBACK_REVENUE_FACT_PROMPT = [
  "你是审计资料事实提取助手。只提取合同及补充资料中的客观事实，不要给出任何会计结论或准则判断。",
  "重点关注：付款条件与期限、交付与验收条款、退货与回购安排、返利与折扣、价格与变更机制、履约义务描述、是否引用其他文件（如工作说明书/SOW/订单）。",
  "只输出 JSON，不要解释。",
  "",
  '【输出格式】\n{"facts":[{"fact_type":"事实类别","fact_summary":"一句话事实","contract_excerpt":"原文摘录","qualifier":"限定条件或例外","pages":"【第N页】"}]}',
].join("\n");

/**
 * The rule bundle ships this prompt alongside the questions it must agree with
 * (fact ids, per-file sections), so read it from there rather than keeping a
 * copy that silently drifts whenever the rules are updated.  The literal above
 * only covers the rules failing to load.
 */
export function revenueFactPrompt(): string {
  const provided = (globalThis as { REVENUE_FACT_PROMPT?: unknown })
    .REVENUE_FACT_PROMPT;
  return typeof provided === "string" && provided.trim()
    ? provided
    : FALLBACK_REVENUE_FACT_PROMPT;
}

/** Questions per second-pass request. */
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

export type RevenueTargetQuestion = RevenueQuestion & {
  /** 已确认履约义务的上下文，随本批问题一起发给模型 */
  poContext?: string;
  po_no?: string;
};

/**
 * Identity of a workpaper question, used on both sides of the "did the model
 * answer everything" comparison.
 *
 * The question catalogue uses camelCase while model responses come back in the
 * snake_case shape the prompt asks for, so both spellings have to resolve to
 * the same key — otherwise every answered question looks missing and the whole
 * batch is asked again.
 */
export function revenueQuestionKey(item: Record<string, unknown>): string {
  const source = item ?? {};
  const sheet = String(source.workpaper_sheet ?? source.sheet ?? "").trim();
  const questionNo = String(source.question_no ?? source.questionNo ?? "").trim();
  return `${sheet}|${questionNo}`;
}

/**
 * Narrow the rule's prompt down to the questions of one batch.
 *
 * The rule prompt carries the full question catalogue between 【底稿问题目录】
 * and 【实务判断口径】; leaving it in place lets the model answer whichever
 * questions it likes and silently skip the ones actually asked for, so that
 * section is replaced by this batch's list. The practical-judgement guidance
 * after it must survive, hence splicing rather than rebuilding the prompt.
 *
 * `basePrompt` is passed in instead of read from the rule engine so this stays
 * a pure function.
 */
export function revenuePromptForQuestions(
  basePrompt: string,
  targets: RevenueTargetQuestion[],
): string {
  const prompt = basePrompt;
  const start = prompt.indexOf("【底稿问题目录】");
  const end = start >= 0 ? prompt.indexOf("【实务判断口径】", start) : -1;
  const lines = (targets || [])
    .map((q) => `${q.sheet} | 第${q.row}行 | ${q.questionNo} | ${q.question}`)
    .join("\n");
  const poContexts: string[] = [];
  for (const q of targets || []) {
    const context = String(q?.poContext ?? "").trim();
    if (context && !poContexts.includes(context)) poContexts.push(context);
  }
  const targetBlock =
    "【本批必须逐项回答的底稿问题】\n" +
    lines +
    "\n\n" +
    (poContexts.length
      ? "【已确认履约义务及一致性约束】\n" + poContexts.join("\n\n") + "\n\n"
      : "") +
    "本批只输出上述问题，每个问题至少输出一条，不得返回空数组。合同不适用的问题也要明确回答“否”或“不适用”并说明原因。\n" +
    (poContexts.length
      ? "已确认清单中的PO真实存在，严禁回答“不存在PO”“无此履约义务”或重新分配PO编号。同一控制权转移模式组的相同指标必须一致；只有明确列示了不同合同条款时才可不同，并须在answer_reason说明差异。\n"
      : "") +
    "为避免输出被截断，请保持精准简洁：contract_basis不超过120字，answer_reason不超过180字，contract_excerpt不超过240字，supporting_evidence和missing_information各不超过120字；数字、条件、方向、页码和来源文件不得省略。\n\n";
  if (start >= 0 && end > start)
    return prompt.slice(0, start) + targetBlock + prompt.slice(end);
  return prompt + "\n\n" + targetBlock;
}

/** Questions per group for the non-timing part of the detail pass. */
const REVENUE_DETAIL_GROUP_SIZE = 6;

/**
 * Group the per-performance-obligation detail questions into model requests.
 *
 * The 5.1.1 / 5.1.2 timing questions are asked once per PO, and the answers for
 * one question have to be consistent across POs. Mixing several of them into a
 * request makes the model drift between POs, so each question number gets its
 * own group with all of its POs together and in catalogue order. Everything
 * else is only length-limited.
 */
export function groupRevenueDetailQuestions(
  questions: RevenueTargetQuestion[],
): RevenueTargetQuestion[][] {
  const timingBuckets = new Map<string, RevenueTargetQuestion[]>();
  const other: RevenueTargetQuestion[] = [];
  for (const question of questions || []) {
    const questionNo = String(question?.questionNo ?? "");
    const isPoTiming = Boolean(question?.po_no) && /^5\.1\.[12]-/.test(questionNo);
    if (!isPoTiming) {
      other.push(question);
      continue;
    }
    const timingType = /^5\.1\.1-/.test(questionNo) ? "5.1.1" : "5.1.2";
    const key = `${timingType}|${questionNo}`;
    const bucket = timingBuckets.get(key);
    if (bucket) bucket.push(question);
    else timingBuckets.set(key, [question]);
  }
  const groups = [...timingBuckets.keys()]
    .sort()
    .map((key) => timingBuckets.get(key) as RevenueTargetQuestion[]);
  for (let index = 0; index < other.length; index += REVENUE_DETAIL_GROUP_SIZE)
    groups.push(other.slice(index, index + REVENUE_DETAIL_GROUP_SIZE));
  return groups;
}

/**
 * Which of `targets` the model never answered.
 *
 * Convention: the caller normalises `items` first (the legacy version did that
 * inside, which dragged the whole workpaper module in as a global dependency).
 * This only compares `revenueQuestionKey`, so un-normalised items whose sheet
 * or question number has not been canonicalised will look missing.
 */
export function missingRevenueTargets(
  items: Array<Record<string, unknown>>,
  targets: RevenueTargetQuestion[],
): RevenueTargetQuestion[] {
  const seen = new Set<string>();
  for (const item of items || [])
    seen.add(revenueQuestionKey(item as Record<string, unknown>));
  return (targets || []).filter(
    (question) =>
      !seen.has(revenueQuestionKey(question as unknown as Record<string, unknown>)),
  );
}

/**
 * Placeholder row for a question the model never returned, even after the
 * per-question retry.
 *
 * Dropping the row would leave a silent hole in the workpaper, so the row is
 * kept with the answer blank and flagged for manual review; `technical_fallback`
 * lets the UI tell these apart from a genuine "资料不足" answer.
 */
export function revenueMissingQuestionFallback(
  question: RevenueTargetQuestion,
): Record<string, unknown> {
  return {
    workpaper_sheet: question.sheet,
    workpaper_row: String(question.row || ""),
    question_no: question.questionNo,
    question_description: question.question,
    suggested_answer: "",
    contract_basis: "",
    sop_basis: "SOP未明确涉及该具体情形",
    answer_reason:
      "模型在分组回答及逐题补答后仍未返回本问题，系统已保留该底稿行并标记人工复核。",
    contract_excerpt: "",
    source_documents: "",
    supporting_evidence: "请人工核对合同及相关支持文件。",
    missing_information: "重新提取或人工核对本问题",
    triggered_sheet: "无",
    appendix_status: "未触发",
    performance_obligations: "[]",
    appendix_subjects: "[]",
    over_time_criteria: "[]",
    fill_readiness: "资料不足",
    pages: "【页码未知】",
    confidence: "低",
    review_status: "需人工复核",
    technical_fallback: true,
    evidence_fact_ids: "[]",
  };
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

/**
 * Field set of the most recent extraction among `rows`, or `undefined` when
 * none of them records one.
 *
 * Mirrors `FieldSet.latestFieldSetId` in the rule bundle: results stay visible
 * after a rule changes its field list, instead of being hidden because their
 * stored field set no longer equals the current checkbox selection.
 */
export function latestFieldSetId(
  rows: Array<{ fieldSetId?: unknown; extractAt?: unknown }>,
): string | undefined {
  let latest: { id: string; at: string } | undefined;
  for (const row of rows) {
    if (typeof row.fieldSetId !== "string" || !row.fieldSetId) continue;
    const at = typeof row.extractAt === "string" ? row.extractAt : "";
    if (!latest || at > latest.at) latest = { id: row.fieldSetId, at };
  }
  return latest?.id;
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

/// Windows rejects these as file names regardless of extension.
const RESERVED_FILE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function sanitizeNamePart(value: unknown): string {
  return String(value ?? "")
    .replace(/[<>:"/\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

/**
 * Suggested file name for an AudiPick export.
 *
 * The save dialog opened with an empty name field, so every export had to be
 * named by hand and landed wherever the user last saved — the exports were hard
 * to tell apart afterwards.  Build the legacy name instead: what was analysed,
 * what kind of output it is, and the date.
 *
 * Sanitising is not cosmetic here: contract names routinely contain `/` and `:`
 * from dates and entity names, which Windows refuses outright.
 */
export function audipickExportName(
  options: {
    fileName?: string;
    projectName?: string;
    clientName?: string;
    scopeLabel?: string;
    typeLabel?: string;
    date?: Date | number | string;
  } = {},
  extension = "xlsx",
): string {
  const parts: string[] = [];
  if (options.fileName) {
    parts.push(String(options.fileName).replace(/\.[^.\/]+$/, ""));
  } else {
    if (options.projectName) parts.push(options.projectName);
    if (options.clientName && options.clientName !== options.projectName)
      parts.push(options.clientName);
    if (options.scopeLabel) parts.push(options.scopeLabel);
  }
  if (options.typeLabel) parts.push(options.typeLabel);
  const raw =
    options.date instanceof Date ? options.date : new Date(options.date ?? Date.now());
  const stamp = Number.isFinite(raw.getTime()) ? raw : new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  parts.push(
    `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`,
  );
  let name = sanitizeNamePart(
    parts.map(sanitizeNamePart).filter(Boolean).join("_"),
  ).replace(/_+/g, "_");
  if (!name) name = "AudiPick_导出结果";
  if (RESERVED_FILE_NAMES.test(name)) name = `_${name}`;
  return `${name.slice(0, 180).replace(/[. ]+$/g, "")}.${extension}`;
}
