// 凭证映射的共享逻辑：看账工具与正负数凭证标记共用同一套字段角色、
// 金额方案取舍和 LLM 复核判定，避免两个工具的口径各自漂移。
// 角色名与统一内核一致（`functionalAmount` 而不是 `amount`）——五个工具的映射
// 从此是同一个形状：角色名 → 列名或列名数组，通用面板可以直接消费。
export type Mapping = {
  id: string[];
  accountCode?: string;
  accountName: string[];
  entity?: string;
  date?: string;
  summary?: string;
  functionalAmount?: string;
  direction?: string;
  functionalDebit?: string;
  functionalCredit?: string;
};
export type Inspect = {
  lowMemory?: boolean;
  resourceNotice?: string;
  headers: string[];
  preview: string[][];
  sheets?: string[];
  selectedSheet?: string;
  suggestedMapping?: Mapping;
  accounts?: string[];
  accountCodes?: string[];
  accountCount?: number;
  dimensions?: { rows: number; columns: number };
};
export type Review = {
  role: keyof Mapping;
  currentColumn?: string;
  suggestedColumn: string;
  confidence?: number;
  reason?: string;
};
export const EMPTY_MAPPING: Mapping = { id: [], accountName: [] };

/**
 * 没有主体列时全表统一挂的主体名。
 *
 * 主体（`entity`）在金标里是**选填**角色：没映射也不拦，用这个名字兜底即可。
 * 它只是本位币与底稿封面的挂载点，与 Rust 侧 `fx::DEFAULT_ENTITY` 一致。
 */
export const DEFAULT_ENTITY = "默认主体";

export type LedgerSourceKind = "je" | "tb";
export type LedgerSourceClassification = {
  kind: LedgerSourceKind;
  scores: { je: number; tb: number };
};
/**
 * Resolve a two-file upload as a pair.  Independent classification may call both
 * files JE when one ambiguous TB loses a tie; assigning the pair jointly keeps
 * one stable JE slot and one stable TB slot using the engine's original scores.
 */
export function resolveLedgerPairKinds<T extends LedgerSourceClassification>(
  items: T[],
): LedgerSourceKind[] {
  if (items.length !== 2 || items[0].kind !== items[1].kind)
    return items.map((item) => item.kind);
  const jeThenTb = items[0].scores.je + items[1].scores.tb;
  const tbThenJe = items[0].scores.tb + items[1].scores.je;
  return jeThenTb >= tbThenJe ? ["je", "tb"] : ["tb", "je"];
}

/** Shared orchestration, not a shared prompt: every caller supplies its own
 * tool-specific backend method. LLM failure is advisory and falls back to the
 * deterministic result without losing the uploaded file. */
export async function reviewLedgerSourceClassification<
  T extends LedgerSourceClassification & {
    headers: string[];
    preview: string[][];
  },
>(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  method: string,
  path: string,
  scripted: T,
): Promise<{ classification: T; reviewed: boolean; reviewError?: string }> {
  try {
    const value = (await call(method, {
      payload: {
        path,
        headers: scripted.headers,
        sampleRows: scripted.preview,
        scriptKind: scripted.kind,
        scriptScores: scripted.scores,
      },
    })) as { kind?: LedgerSourceKind };
    if (value.kind === "je" || value.kind === "tb") {
      return {
        classification: { ...scripted, kind: value.kind },
        reviewed: true,
      };
    }
    return {
      classification: scripted,
      reviewed: false,
      reviewError: "LLM 未返回有效的 JE/TB 类型",
    };
  } catch (error) {
    return {
      classification: scripted,
      reviewed: false,
      reviewError:
        error instanceof Error
          ? error.message
          : String(
              (error as { userMessage?: unknown } | null)?.userMessage ??
                "LLM 复核不可用",
            ),
    };
  }
}
// 组成科目键的列，顺序固定：**编码在前、名称在后**。下游按这个顺序用 "-" 把几列
// 拼成一个科目值，顺序一变，用户已经选好的目标科目就全部对不上。
// Rust 侧 `LedgerMapping::account_columns` 必须保持同序。
export function accountColumns(mapping: Mapping): string[] {
  const out: string[] = [];
  for (const value of [mapping.accountCode, ...(mapping.accountName ?? [])]) {
    const item = value?.trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

// 金标（`汇兑损益测试资料/TB-4800.xlsx` 的 `je种类` / `tb种类` 两张表）要求的身份字段。
// 一份合格的账表应该有这些列，缺了就拦——与各工具自己声明的必填取并集。
// `entity` 不在其中：金标 2026-08-24 修订时把它降为可选，汇兑损益仍自己要求它。
// **Rust 侧 `ledger_mapping::identity_required` 是同一份，两边必须一致。**
export const GOLD_IDENTITY: Record<"je" | "tb", string[]> = {
  je: ["date", "id", "accountCode", "accountName", "summary"],
  tb: ["accountCode", "accountName"],
};
const GOLD_LABELS: Record<string, string> = {
  date: "记账日期",
  id: "凭证识别字段",
  accountCode: "科目编码",
  accountName: "科目名称",
  summary: "摘要",
};
/** 金标身份槽的缺失清单。传入判断某角色是否已映射的函数，兼容各工具不同的映射结构。 */
export function missingGoldIdentity(
  kind: "je" | "tb",
  has: (role: string) => boolean,
): string[] {
  return GOLD_IDENTITY[kind]
    .filter((role) => !has(role))
    .map((role) => GOLD_LABELS[role] ?? role);
}

/** 引擎随识别结果下发的角色标签：`name` 是统一内核的标准角色名，`label` 是中文标签。 */
export type EngineRoleLabels = Array<{ name: string; label: string }>;

/**
 * 统一的角色标签表：后端下发的 `roles` 优先（按 name 查 label），查不到回落
 * 页面本地表——五个账表工具的下拉、形态提示、复核提示从这里取标签，不再各抄一份。
 *
 * 角色清单与顺序仍以页面本地表为准：引擎下发的是**全量**标签表（各工具用不到的
 * 原币、币种线索角色也在里面，多了不碍事），每个工具只展示自己的角色子集；
 * 这里只把**文案来源**换成引擎，页面手里的手抄表退化为「引擎未下发时的回落」。
 * 两边都没有的角色不进表，由调用方兜底（通常直接显示角色名）。
 */
export function resolveRoleLabels(
  roles: EngineRoleLabels | undefined,
  local: Record<string, string>,
): Record<string, string> {
  const fromEngine = new Map<string, string>();
  for (const role of roles ?? []) {
    if (role?.name && role.label) fromEngine.set(role.name, role.label);
  }
  return Object.fromEntries(
    Object.entries(local).map(([role, label]) => [
      role,
      fromEngine.get(role) ?? label,
    ]),
  );
}

/** 统一复核入口返回的一条建议。 */
export type LedgerChange = {
  role: string;
  currentColumn?: string;
  suggestedColumn: string;
  confidence?: number;
  reason?: string;
};

export type LedgerPairFinding = {
  type?: string;
  confidence?: number;
  reason?: string;
};

export type LedgerPlannedChange = LedgerChange & {
  /** 页面展示与撤销使用实际映射值，不信任模型自报的 currentColumn。 */
  currentColumn: string;
  attention: boolean;
  beforeValue?: string | string[];
  label: string;
};

/**
 * 公共账表引擎中允许由多列共同组成的角色。
 *
 * `id` 尤其不能按单列覆盖：不少财务系统用“凭证字＋凭证号”共同构成
 * 凭证键。映射复核若只留下其中一列，会把不同凭证串在一起。
 * 这里供所有使用字典型映射的工具共用，不在 FA 页面另设口径。
 */
export const LEDGER_MULTI_COLUMN_ROLES = new Set([
  "id",
  "accountName",
  "auxiliary",
]);

const appendMappingColumn = (
  value: string | string[] | undefined,
  column: string,
): string[] => {
  const current = Array.isArray(value) ? value : value ? [value] : [];
  return [...current, column].filter(
    (item, index, all) => Boolean(item?.trim()) && all.indexOf(item) === index,
  );
};

/** 一段文本像不像科目编码（与 Rust 内核 looks_like_account_code 同口径）。 */
const looksLikeAccountCode = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 24 &&
  /[0-9]/.test(value) &&
  /^[0-9A-Za-z.-]+$/.test(value);

/**
 * 一列取值是否整体呈「编码＋名称混写」形态（如 `1001010000:库存现金-人民币`），
 * 与 Rust 内核 is_combined_account_column 同阈值。这种列允许科目编码与科目
 * 名称两个角色共用——映射复核把其中一个角色指到这种列上时不算「一列两语义」。
 */
export const isCombinedAccountValues = (values: string[]): boolean => {
  let total = 0;
  let split = 0;
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    total += 1;
    const at = value.search(/[/:_\\|]/);
    if (at > 0) {
      const code = value.slice(0, at).trim();
      const name = value.slice(at + 1).trim();
      if (looksLikeAccountCode(code) && name) split += 1;
    }
  }
  return total >= 4 && split * 4 >= total * 3;
};
/**
 * 调用共用的映射复核，把够把握的建议应用到通用字典型映射上。
 *
 * 汇兑损益、存款利息、借款利息用的都是「角色名 → 列名」的字典，与看账那套
 * 强类型结构不同，所以单独一个入口；纪律、卫生过滤在后端已经统一。
 * 后端已按冲突词、占用、置信度过滤过一轮，这里只做两件后端做不了的事：
 * 丢掉本工具不认识的角色，以及丢掉指向表里不存在的列的建议。
 */
export async function applyLedgerReviewToDict(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  kind: "je" | "tb",
  headers: string[],
  sampleRows: string[][],
  current: Record<string, string | string[]>,
  labels: Record<string, string>,
): Promise<{
  mapping: Record<string, string | string[]>;
  applied: LedgerPlannedChange[];
  pending: LedgerPlannedChange[];
}> {
  const response = (await call("ledger.review_mapping", {
    kind,
    payload: {
      headers,
      sampleRows: sampleRows.slice(0, 8),
      currentMapping: current,
      availableRoles: Object.keys(labels),
    },
  })) as { changes?: LedgerChange[] };
  return planLedgerChanges(headers, sampleRows, current, labels, response.changes ?? []);
}

const ledgerMappingText = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value.filter(Boolean).join("＋") : value?.trim() || "未映射";

/** 后端完成提示词与硬规则过滤后，前端统一执行 60% 应用、待确认与撤销计划。 */
export function planLedgerChanges(
  headers: string[],
  sampleRows: string[][],
  current: Record<string, string | string[]>,
  labels: Record<string, string>,
  changes: LedgerChange[],
): {
  mapping: Record<string, string | string[]>;
  applied: LedgerPlannedChange[];
  pending: LedgerPlannedChange[];
} {
  const next = { ...current };
  const applied: LedgerPlannedChange[] = [];
  const pending: LedgerPlannedChange[] = [];
  // 「编码＋名称混写」的列允许科目编码与科目名称共用（与后端同口径豁免）。
  const combinedOf = (column: string): boolean => {
    const index = headers.indexOf(column);
    return index >= 0 && isCombinedAccountValues(sampleRows.map((row) => row[index] ?? ""));
  };
  for (const change of changes) {
    const column = change?.suggestedColumn?.trim();
    if (!column || !(change.role in labels) || !headers.includes(column))
      continue;
    const beforeValue = next[change.role];
    const planned: LedgerPlannedChange = {
      ...change,
      suggestedColumn: column,
      currentColumn: ledgerMappingText(beforeValue),
      beforeValue: Array.isArray(beforeValue) ? [...beforeValue] : beforeValue,
      attention:
        change.confidence !== undefined && change.confidence < 0.7,
      label: labels[change.role] ?? change.role,
    };
    if (change.confidence === undefined || change.confidence < AUTO_APPLY_MIN) {
      pending.push(planned);
      continue;
    }
    // 同一列已被别的角色占用就跳过——一列只承载一个语义。
    if (
      Object.entries(next).some(
        ([role, value]) =>
          role !== change.role &&
          (Array.isArray(value) ? value.includes(column) : value === column) &&
          !(
            ((change.role === "accountName" && role === "accountCode") ||
              (change.role === "accountCode" && role === "accountName")) &&
            combinedOf(column)
          ),
      )
    )
      continue;
    // 多列角色是“追加组成键”，不是“建议一次覆盖一次”。例如目标 JE 的
    // 「凭证字」「凭证号」都属于 id；LLM 分两条返回时两列必须同时保留。
    next[change.role] = LEDGER_MULTI_COLUMN_ROLES.has(change.role)
      ? appendMappingColumn(next[change.role], column)
      : column;
    applied.push(planned);
  }
  return { mapping: next, applied, pending };
}

export const ledgerErrorText = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return String(
      value.userMessage ??
        value.message ??
        value.detail ??
        "操作失败，请检查输入后重试。",
    );
  }
  return String(error);
};

/** 一键复核里单个文件需要的全部输入。 */
export type LedgerReviewTarget = {
  headers: string[];
  preview: string[][];
  mapping: Record<string, string | string[]>;
  labels: Record<string, string>;
  tool?: string;
  pairLabel?: string;
};
/** 一键复核里单个文件的结果：应用后的映射、采纳的建议数与失败原因。 */
export type LedgerReviewOutcome = {
  mapping: Record<string, string | string[]>;
  appliedCount: number;
  failed: boolean;
  error: string;
  applied: LedgerPlannedChange[];
  pending: LedgerPlannedChange[];
  pairFindings: LedgerPairFinding[];
};
/**
 * 一键复核 TB＋JE 的共享引擎。汇兑损益与存款利息此前各写一套复核入口，
 * 改一处漏一处；现在两个页面都调这里。已上传哪个文件就复核哪个，两边
 * 并行、结果各自汇报；单个文件失败只记在它自己的 outcome 里，不阻塞
 * 另一个文件，也不抛出——沿用「复核失败不阻塞」的既有口径。
 */
export async function applyLedgerReviewsTogether(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  targets: Partial<Record<"je" | "tb", LedgerReviewTarget>>,
): Promise<Partial<Record<"je" | "tb", LedgerReviewOutcome>>> {
  const kinds = (["je", "tb"] as const).filter((kind) => targets[kind]);
  if (kinds.length === 2) {
    try {
      const response = (await call("ledger.review_pair_mapping", {
        payload: {
          tool: targets.tb?.tool ?? targets.je?.tool ?? "ledger",
          pairLabel: targets.tb?.pairLabel ?? targets.je?.pairLabel,
          tb: {
            headers: targets.tb!.headers,
            sampleRows: targets.tb!.preview.slice(0, 8),
            currentMapping: targets.tb!.mapping,
            availableRoles: Object.keys(targets.tb!.labels),
          },
          je: {
            headers: targets.je!.headers,
            sampleRows: targets.je!.preview.slice(0, 8),
            currentMapping: targets.je!.mapping,
            availableRoles: Object.keys(targets.je!.labels),
          },
        },
      })) as {
        tbChanges?: LedgerChange[];
        jeChanges?: LedgerChange[];
        pairFindings?: LedgerPairFinding[];
      };
      const findings = response.pairFindings ?? [];
      return Object.fromEntries(
        kinds.map((kind) => {
          const target = targets[kind]!;
          const plan = planLedgerChanges(
            target.headers,
            target.preview,
            target.mapping,
            target.labels,
            kind === "tb" ? response.tbChanges ?? [] : response.jeChanges ?? [],
          );
          return [kind, {
            mapping: plan.mapping,
            appliedCount: plan.applied.length,
            failed: false,
            error: "",
            applied: plan.applied,
            pending: plan.pending,
            pairFindings: findings,
          }] as const;
        }),
      );
    } catch (e) {
      const error = ledgerErrorText(e);
      return Object.fromEntries(kinds.map((kind) => [kind, {
        mapping: targets[kind]!.mapping,
        appliedCount: 0,
        failed: true,
        error,
        applied: [],
        pending: [],
        pairFindings: [],
      }]));
    }
  }
  const kind = kinds[0];
  if (!kind) return {};
  const target = targets[kind]!;
  try {
    const { mapping, applied, pending } = await applyLedgerReviewToDict(
      call, kind, target.headers, target.preview, target.mapping, target.labels,
    );
    return { [kind]: {
      mapping,
      appliedCount: applied.length,
      failed: false,
      error: "",
      applied,
      pending,
      pairFindings: [],
    } };
  } catch (e) {
    return { [kind]: {
      mapping: target.mapping,
      appliedCount: 0,
      failed: true,
      error: ledgerErrorText(e),
      applied: [],
      pending: [],
      pairFindings: [],
    } };
  }
}

export function setKanzhangMapping(
  current: Mapping,
  key: keyof Mapping,
  value: string | string[],
): Mapping {
  const next = { ...current, [key]: value || undefined };
  if (key === "functionalAmount" || key === "direction") {
    next.functionalDebit = undefined;
    next.functionalCredit = undefined;
  }
  if (key === "functionalDebit" || key === "functionalCredit") {
    next.functionalAmount = undefined;
    next.direction = undefined;
  }
  return next;
}

// 完成态保留结果摘要即可。若继续把上一轮筛选/导出的 100% 进度条画出来，
// 用户刚进入导出页时会误以为本轮导出已经完成。
export const shouldShowKanzhangJobProgress = (phase?: string) =>
  Boolean(phase && !["completed", "failed", "cancelled"].includes(phase));

export const effectiveVoucherKey = (mapping: Mapping) =>
  [mapping.entity, mapping.date, ...mapping.id].filter(
    (value): value is string => Boolean(value),
  );

// LLM 常把"建议列 = 当前列"的字段也放进 reviews，采纳与否结果一样，属于噪音；这里按采纳后的实际效果判断是否值得展示。
export function isRedundantKanzhangReview(
  mapping: Mapping,
  item: { role: keyof Mapping; suggestedColumn?: string },
): boolean {
  const suggested = item.suggestedColumn?.trim();
  if (!suggested) return true;
  const current = mapping[item.role];
  if (Array.isArray(current))
    return current.length === 1 && current[0]?.trim() === suggested;
  return typeof current === "string" && current.trim() === suggested;
}
// 把握达到门槛的直接改（可撤销），不到门槛的不动手，交回用户决定。
export const AUTO_APPLY_MIN = 0.6;
export const shouldAutoApply = (confidence?: number) =>
  confidence === undefined || confidence >= AUTO_APPLY_MIN;
export function kanzhangReviewSummary(
  applied: number,
  pending: number,
): string {
  const done = applied ? `已自动调整 ${applied} 项，不合适可逐条撤销` : "";
  const ask = pending
    ? `另有 ${pending} 项把握不足 ${Math.round(AUTO_APPLY_MIN * 100)}%，未改动，请确认是否采纳`
    : "";
  if (done && ask) return `LLM 复核完成：${done}；${ask}。`;
  if (done) return `LLM 复核完成：${done}。`;
  if (ask) return `LLM 复核完成：${ask}。`;
  return "LLM 复核完成：现有字段映射与 LLM 判断一致，未做改动。";
}
// LLM 判断该改就直接改，用户在变更清单里核对"改前→改后"，不认可再撤销。
export type MappingChangeSource = "fill" | "replace" | "scheme";
export type MappingChange = {
  role: keyof Mapping;
  before?: string | string[];
  after?: string | string[];
  source: MappingChangeSource;
  reason?: string;
  confidence?: number;
};
export const MAPPING_CHANGE_LABEL: Record<MappingChangeSource, string> = {
  fill: "已自动补充",
  replace: "已自动修正",
  scheme: "已按方案清除",
};
// 变更清单里显示中文角色名——原来直接打印 summary/direction 这种内部键名，用户看不懂。
export const KZ_ROLE_LABELS: Record<keyof Mapping, string> = {
  id: "凭证编号",
  accountCode: "科目编码",
  accountName: "科目名称",
  entity: "公司/核算主体",
  date: "日期",
  summary: "摘要",
  functionalAmount: "方案A-金额",
  direction: "方案A-方向",
  functionalDebit: "方案B-借方",
  functionalCredit: "方案B-贷方",
};
export const isMultiRole = (
  role: keyof Mapping,
): role is "id" | "accountName" => role === "id" || role === "accountName";
// 预览表头下拉里的角色顺序，两个工具共用同一份，必填项标 true。
// 科目编码与科目名称各自标 false：单独看谁都不是必填，但两者至少要映射一列，
// 这条口径由 missingKanzhangRequiredRoles 统一判。
export const LEDGER_ROLES: [keyof Mapping, string, boolean][] = [
  ["id", "凭证编号", true],
  ["accountCode", "科目编码", false],
  ["accountName", "科目名称", false],
  ["entity", "公司/主体", false],
  ["date", "日期", false],
  ["summary", "摘要", false],
  ["functionalAmount", "方案A-金额", false],
  ["direction", "方案A-方向", false],
  ["functionalDebit", "方案B-借方", false],
  ["functionalCredit", "方案B-贷方", false],
];
// LLM 回来的 role 要翻译成本页面用的键。复核提示词与汇兑损益共用同一份纪律，
// 那份用的是统一内核的标准角色名（functionalAmount、functionalDebit…），
// 而这两个工具的映射结构沿用简写（amount、debit…）；科目原先还是单一的 account。
// 认不出的整条丢弃——否则会往 mapping 里写进一个界面既显示不出、也撤销不掉的野字段。
const LEDGER_ROLE_KEYS = new Set<string>(LEDGER_ROLES.map(([key]) => key));
// 角色名已与内核统一，这里只剩「旧名 → 标准名」的历史兼容。
const ROLE_ALIASES: Record<string, keyof Mapping> = {
  account: "accountCode",
  amount: "functionalAmount",
  debit: "functionalDebit",
  credit: "functionalCredit",
};
export function normalizeLedgerRole(role?: string): keyof Mapping | undefined {
  const key = role?.trim();
  if (!key) return undefined;
  const alias = ROLE_ALIASES[key];
  if (alias) return alias;
  return LEDGER_ROLE_KEYS.has(key) ? (key as keyof Mapping) : undefined;
}
// 与 Rust `validate_kanzhang_mapping` 保持同一必填口径：**金标身份槽 ∪ 本工具必填**。
// 本工具自己要的是凭证 ID，以及方案 A 的金额列或方案 B 的借贷两列（方向列是选填）；
// 金标另要求记账日期、科目编码、科目名称、摘要——缺了同样拦，只是理由不同。
export function missingKanzhangRequiredRoles(mapping: Mapping): string[] {
  const has = (role: string) => {
    if (role === "id")
      return mapping.id.some((value) => Boolean(value?.trim()));
    if (role === "accountCode") return Boolean(mapping.accountCode?.trim());
    if (role === "accountName")
      return mapping.accountName.some((value) => Boolean(value?.trim()));
    return Boolean(String(mapping[role as keyof Mapping] ?? "").trim());
  };
  // 凭证识别字段已在金标身份槽里，不再用「唯一识别码 (ID)」这个旧叫法重复报一次。
  const missing: string[] = missingGoldIdentity("je", has);
  const hasAmount = Boolean(mapping.functionalAmount?.trim());
  const hasDebitCredit = Boolean(
    mapping.functionalDebit?.trim() && mapping.functionalCredit?.trim(),
  );
  if (!hasAmount && !hasDebitCredit)
    missing.push("金额字段（方案A-金额，或方案B-借方和贷方）");
  return [...new Set(missing)];
}
export const formatMappingValue = (value?: string | string[]): string => {
  if (Array.isArray(value)) {
    const items = value.map((item) => item?.trim()).filter(Boolean);
    return items.length ? items.join("、") : "未映射";
  }
  return typeof value === "string" && value.trim() ? value.trim() : "未映射";
};
export const isSameMappingValue = (
  a?: string | string[],
  b?: string | string[],
): boolean => formatMappingValue(a) === formatMappingValue(b);
// 金额口径二选一：方案A（金额+方向）和方案B（借方+贷方）只能生效一套。
// 一旦其中一套映射成功，另一套既不该让用户手动选，LLM 也不该再对它提建议——
// 它显示的"未映射"是方案取舍的结果，不是漏填。
const SCHEME_A_ROLES: (keyof Mapping)[] = ["functionalAmount", "direction"];
const SCHEME_B_ROLES: (keyof Mapping)[] = [
  "functionalDebit",
  "functionalCredit",
];
const hasValue = (value?: string) => Boolean(value && value.trim());
export function activeAmountScheme(mapping: Mapping): "A" | "B" | undefined {
  const a = hasValue(mapping.functionalAmount) || hasValue(mapping.direction);
  const b =
    hasValue(mapping.functionalDebit) || hasValue(mapping.functionalCredit);
  if (b && !a) return "B";
  if (a && !b) return "A";
  return undefined;
}
export function isSchemeLockedRole(
  mapping: Mapping,
  role: keyof Mapping,
): boolean {
  const scheme = activeAmountScheme(mapping);
  if (scheme === "B") return SCHEME_A_ROLES.includes(role);
  if (scheme === "A") return SCHEME_B_ROLES.includes(role);
  return false;
}
// 既然改动是先斩后奏，"清除了原有映射"和"LLM 自己也没把握"这两类最该被用户重点核对。
export const LOW_CONFIDENCE = 0.7;
export const needsAttention = (change: MappingChange): boolean =>
  change.source === "scheme" ||
  (change.confidence !== undefined && change.confidence < LOW_CONFIDENCE);
// 同一字段可能被连续改动（先补充又被方案清除），清单里只呈现最初值到最终值的净变化。
export function mergeMappingChanges(changes: MappingChange[]): MappingChange[] {
  const merged = new Map<keyof Mapping, MappingChange>();
  for (const change of changes) {
    const previous = merged.get(change.role);
    merged.set(
      change.role,
      previous ? { ...change, before: previous.before } : change,
    );
  }
  return [...merged.values()].filter(
    (change) => !isSameMappingValue(change.before, change.after),
  );
}
// LLM 复核结果的应用：把握够的直接改（进变更清单，可撤销），把握不足的交回用户。
// 看账与正负数凭证标记必须完全一致，所以放在这里由两个页面共用。
export type LedgerReviewResponse = {
  scheme?: string;
  schemeReason?: string;
  fills?: Review[];
  reviews?: Review[];
};
export function applyLedgerReviews(
  source: Mapping,
  value: LedgerReviewResponse,
): { mapping: Mapping; changes: MappingChange[]; pending: Review[] } {
  let next = { ...source };
  const applied: MappingChange[] = [];
  const waiting: Review[] = [];
  for (const raw of [...(value.fills ?? []), ...(value.reviews ?? [])]) {
    const role = normalizeLedgerRole(raw?.role);
    const column = raw?.suggestedColumn?.trim();
    if (!role || !column) continue;
    const item: Review = { ...raw, role, suggestedColumn: column };
    // 另一套金额方案已经映射成功，对它的建议一律丢弃，不进清单也不提示。
    if (isRedundantKanzhangReview(next, item) || isSchemeLockedRole(next, role))
      continue;
    if (!shouldAutoApply(item.confidence)) {
      waiting.push(item);
      continue;
    }
    const before = next[role];
    const after = isMultiRole(role) ? [column] : column;
    next = { ...next, [role]: after };
    applied.push({
      role,
      before,
      after,
      source: formatMappingValue(before) === "未映射" ? "fill" : "replace",
      reason: item.reason,
      confidence: item.confidence,
    });
  }
  // 方案还没定下来时才听 LLM 的；已经有一套映射成功就不许它反过来清空。
  const dropped: (keyof Mapping)[] = activeAmountScheme(source)
    ? []
    : value.scheme === "A"
      ? ["functionalDebit", "functionalCredit"]
      : value.scheme === "B"
        ? ["functionalAmount", "direction"]
        : [];
  for (const role of dropped) {
    const before = next[role];
    if (typeof before === "string" && before.trim())
      applied.push({
        role,
        before,
        after: undefined,
        source: "scheme",
        reason:
          value.schemeReason?.trim() ||
          `LLM 判定为方案${value.scheme}，已清除与之互斥的字段映射。`,
      });
    next = { ...next, [role]: undefined };
  }
  const pending = waiting.filter(
    (item) =>
      !isRedundantKanzhangReview(next, item) &&
      !isSchemeLockedRole(next, item.role),
  );
  return { mapping: next, changes: mergeMappingChanges(applied), pending };
}
export function undoMappingChange(
  mapping: Mapping,
  change: MappingChange,
): Mapping {
  const multi = isMultiRole(change.role);
  const before = change.before;
  const wasEmpty = multi
    ? !(Array.isArray(before) && before.length)
    : !(typeof before === "string" && before.trim());
  // 撤销"补充"只需清掉该字段；走 setKanzhangMapping 会连带清空互斥字段，反而破坏其他映射。
  if (wasEmpty) return { ...mapping, [change.role]: multi ? [] : undefined };
  return setKanzhangMapping(mapping, change.role, before as string | string[]);
}
