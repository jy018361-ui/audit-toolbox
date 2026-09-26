import { useEffect, useMemo, useRef, useState } from "react";
import { cancelJobWithFeedback } from "@/components/JobCommandNotice";
import {
  engineCall,
  jobStart,
  listenPositionedFileDrops,
  openOutput,
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
  completeLedgerPairReviewKey,
  LedgerReviewAll,
  useLedgerDictReviews,
} from "@/components/LedgerReviewAll";
import { FileDropInput } from "@/components/FileDropInput";
import { FileInput } from "@/components/FileInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import {
  KeywordFilter,
  keywordFilterPredicate,
} from "@/components/KeywordFilter";
import { StepIndicator } from "@/components/StepIndicator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { confirmDialog } from "@/components/ConfirmDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useJobEvents } from "@/hooks/useJobEvents";
import { AuxiliaryLinkStatusView } from "@/components/AuxiliaryLinkStatus";
import { useEntityScopeConfirmation } from "@/components/EntityScopeConfirmation";
import { useTaskRestore } from "./restore";
import type { EntityScopeSelection } from "./entityScope";
import { errorText } from "@/lib/errors";
import {
  correctLedgerSourceKinds,
  DEFAULT_ENTITY,
  dropUnlinkedTbAuxiliary,
  ledgerEntityKeyEnabled,
  resolveRoleLabels,
  scanLedgerUploadSources,
  selectLedgerSourcePair,
  verifyAuxiliaryLink,
  type AuxiliaryLinkResult,
  type EngineRoleLabels,
  type LedgerWorkbookSheetClassification,
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
import { AccountConfirmationActions } from "./AccountConfirmationActions";
import { markToolPageLive } from "./toolPageActivity";

type Kind = "tb" | "je";
type Mapping = Record<string, string | string[]>;
type AccountRole = "cost" | "depreciation" | "excluded";
type Assignment = {
  entity?: string;
  account: string;
  auxiliary?: string;
  currency?: string;
  role: AccountRole;
  category: string;
};
type Classification = LedgerWorkbookSheetClassification;

function isRestoreInspection(value: unknown): value is Inspection {
  if (!value || typeof value !== "object") return false;
  const inspection = value as Partial<Inspection>;
  return (
    Array.isArray(inspection.headers) &&
    Array.isArray(inspection.preview) &&
    Array.isArray(inspection.sheets) &&
    Array.isArray(inspection.entities) &&
    Array.isArray(inspection.accounts) &&
    typeof inspection.rowCount === "number" &&
    Boolean(inspection.headerDetection)
  );
}

type FaTbJeDraft = {
  step: 1 | 2 | 3;
  paths: Record<Kind, string>;
  inspects: Partial<Record<Kind, Inspection>>;
  mappings: Record<Kind, Mapping>;
  assignments: Assignment[];
  outputPath: string;
  sourceStatus: string;
  result?: unknown;
  resultStale?: boolean;
  accountsReviewed: boolean;
  assignmentPage: number;
  accountQuery: string;
  entityScope: EntityScopeSelection;
};

// 两个 FA 子工具是条件渲染，切换时组件会卸载。保留 TB+JE 草稿，切回来时
// 恢复上传、映射、复核和输出设置；显式重新选文件/清除来源仍按原逻辑重置。
let faTbJeDraftCache: FaTbJeDraft | undefined;

const MULTI = new Set(["id", "accountName", "account", "auxiliary", "date"]);
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

/**
 * 把「16020002 机械设备」「16010004-数据处理设备」拆成编码与名称。
 *
 * 编码在串**首**或串**尾**都要认得：科目串由映射到的科目列按列序拼成，
 * SAP 型余额表的列序是「名称一级 名称二级 代码」，编码落在最后
 * （`固定资产 固定资产-累计折旧-计算机及硬件设备 1601140001`）。认不出编码，
 * 编码就会被当成名称的一部分带进资产类别——原值那侧带 1601040001、累计折旧
 * 那侧带 1601140001，两个类别永远配不上对，整片折旧都会报「无法归属到原值类别」。
 *
 * 编码必须含数字，否则整串按名称处理——`Accumulated Depreciation` 这种
 * 纯英文名不能把首个单词当成科目编码。
 */
export function splitFaAccount(account: string): {
  code: string;
  name: string;
} {
  const value = account.trim();
  // 分段编码中的连字符属于编码本身；优先用空格切完整 token。
  const head = /^([0-9A-Za-z][0-9A-Za-z._-]*)\s+(.+)$/.exec(value);
  if (head && /\d/.test(head[1]))
    return { code: head[1], name: head[2].trim() };
  const compact = /^([0-9A-Za-z][0-9A-Za-z._-]*[0-9A-Za-z._])\s*[-:：—/\\|]\s*(.+)$/.exec(value);
  if (compact && /\d/.test(compact[1]) && !/^[0-9A-Za-z._-]+$/.test(compact[2]))
    return { code: compact[1], name: compact[2].trim() };
  if (/^[0-9A-Za-z._-]+$/.test(value) && /\d/.test(value))
    return { code: value, name: "" };
  const tail = /^(.*?)\s*[\s:：\-—/\\|]\s*([0-9][0-9A-Za-z._-]*)$/.exec(value);
  if (tail && tail[1].trim()) return { code: tail[2], name: tail[1].trim() };
  return { code: "", name: value };
}

/**
 * 一级科目编码 → 科目是否进本表、以及默认角色。
 *
 * 1603 减值准备／1604 在建工程／1605 工程物资或使用权资产／1606 固定资产清理都不进本表口径；
 * 1602 整支是累计折旧；1601 整支进表，原值还是折旧再由科目名称定（见 `suggestFaAccounts`）。
 *
 * **非 1601/1602 的数字编码**不再一律排除：自身或按编码前缀回查到的上级科目名
 * **明确**写着「固定资产／累计折旧」时进表（旧制度 1501/1502、自定义编码的账套）。
 * 宽词（房屋／设备）不参与这一层——名称里带「房屋」的费用或存款科目
 * （`6601090401 折旧费-固定资产-…`、`1002016871 银行存款-汉口银行(房屋积金)`）
 * 只看宽词必然被当成原值捞进来。字母开头的自定义编码（`FA01`）不适用本规则，
 * 继续按名称判。
 */
function roleFromCode(code: string): AccountRole | undefined {
  if (/^1601/.test(code)) return "cost";
  if (/^1602/.test(code)) return "depreciation";
  return undefined;
}

const SAYS_DEPRECIATION =
  /累计折旧|累計折舊|accumulated\s+depreciation|accum\.?\s*dep/i;
/** 名称一出现就整枝出局（优先于折旧词）：使用权资产与 SAP 技术性清账科目不是固定资产本体。 */
const SAYS_NOT_IN_SCOPE = /使用权|使用權|清账|清賬|right[-\s]?of[-\s]?use/i;
/** 名称一出现就不是原值：减值准备、清理清算过渡户、折旧费／摊销／租赁费等费用科目。 */
const SAYS_NOT_COST =
  /减值准备|減值準備|impairment|清理|清算|折旧费|折舊費|摊销|攤銷|租赁费|租賃費|固定资产.*(?:处置|损失)|固定資產.*(?:處置|損失)|(?:处置|损失).*固定资产|(?:處置|損失).*固定資產/i;
/** 非标准数字编码进表的唯一窄门：名称**明确**写出「固定资产」。
 *  1601/1602 不适用时靠自身或上级科目名匹配（用户定的口径），宽词一律不算。 */
const SAYS_FA_EXPLICIT = /固定资产|固定資產/i;
const SAYS_FIXED_ASSET =
  /固定资产|固定資產|房屋|建筑物|建築物|机器|機器|机械|機械|设备|設備|运输工具|運輸工具|电子设备|办公设备|fixture|equipment|building|vehicle/i;

function roleFromName(name: string): AccountRole {
  if (SAYS_NOT_IN_SCOPE.test(name)) return "excluded";
  if (SAYS_DEPRECIATION.test(name)) return "depreciation";
  if (SAYS_NOT_COST.test(name)) return "excluded";
  return SAYS_FIXED_ASSET.test(name) ? "cost" : "excluded";
}

export function normalizeFaCategory(value: string): string {
  // 英文词之间的下划线转为空格；中文路径分隔符直接移除。
  return value
    .replace(/(?<=[A-Za-z])_+(?=[A-Za-z])/g, " ")
    .replace(/_/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAssignmentCategory(assignment: Assignment): Assignment {
  return {
    ...assignment,
    category: normalizeFaCategory(assignment.category),
  };
}

function faCategory(name: string): string {
  return (
    normalizeFaCategory(
      name
        // SAP 型科目串的名称部分还带着一份编码（`160101\固定资产\房屋建筑物`），
        // 类别列先剥掉它，08 号样例的类别才不会显示成「160101\房屋建筑物」。
        .replace(/^[0-9][0-9A-Za-z._]*[\s:：\-—/\\|]+/, "")
        .replace(
          /累计折旧|累計折舊|固定资产|固定資產|accumulated\s+depreciation|property[,\s]*plant\s*(and|&)\s*equipment|ppe/gi,
          "",
        )
        .replace(/^[-—:：\s\\/|]+|[-—:：\s\\/|]+$/g, ""),
    ) || "固定资产"
  );
}

/** 在科目表里找 `code` 最近的上级科目编码（真前缀，长的优先）。 */
function nearestParent(chart: Map<string, string>, code: string): string {
  for (let length = code.length - 1; length > 0; length -= 1) {
    const prefix = code.slice(0, length);
    if (chart.has(prefix)) return prefix;
  }
  return "";
}

/**
 * 整张科目表一起分类。逐个科目单看名称是分不清的——`机械设备` 既可能挂在
 * 1601 原值下，也可能挂在 1602 累计折旧下，`直接投入-仪器设备维护费` 更是
 * 研发费用。
 *
 * 两层判定，顺序不能反：
 *
 * 1. **在不在本表口径内**，由「上级科目 → 一级编码 → 名称关键词」决定，上级科目的
 *    结论一路继承给下级。`1604 在建工程`、`1605 使用权资产`、`5301 研发支出`、
 *    `6601 运营费用` 整枝排除。**非 1601/1602 的数字编码**不据此出局：自身或
 *    上级科目名明确写出「固定资产／累计折旧」的照常进表（旧制度 1501/1502、
 *    自定义编码账套）；上级行不存在时以自身名称为准，宽词不算。
 * 2. **在口径内的再分原值还是折旧**，科目名称写了「累计折旧」就是折旧——
 *    SAP 型科目表把累计折旧挂在 1601 底下，只认编码会整片判成原值；
 *    国标科目表（1602 整支折旧）则靠编码，因为明细科目只写「机械设备」不写折旧。
 *    名称写了「减值准备」「清理」「折旧费」的一律排除，不能混进原值。
 *
 * **结论按科目编码归一**：同一个科目在 TB 与 JE 里可能拼出两种科目串
 * （列序不同、名称取的列也不同），角色按信息最全的那个名称判，资产类别取
 * 首次出现的那个（科目串按 TB 在前、JE 在后传入，即以余额表的科目名为准）。
 * 不归一的话，同一科目的两条分类会带着不同的资产类别送进引擎，
 * 轻则原值与累计折旧配不上对，重则直接触发科目分类冲突。
 */
export function suggestFaAccounts(accounts: string[]): Assignment[] {
  const parts = accounts.map((account) => ({
    account,
    ...splitFaAccount(account),
  }));
  const chart = new Map<string, string>();
  const firstName = new Map<string, string>();
  for (const { code, name } of parts) {
    if (!code) continue;
    if (!firstName.has(code)) firstName.set(code, name);
    if ((chart.get(code) ?? "").length < name.length) chart.set(code, name);
  }
  const resolved = new Map<string, AccountRole>();
  /** 一级根节点的口径判定：1601/1602 走编码；其余数字编码只有名称**明确**
   *  写出「固定资产／累计折旧」才进表（旧制度 1501/1502、自定义编码账套）；
   *  宽词（房屋／设备）不参与，挡住「银行存款-汉口银行(房屋积金)」式误配。 */
  const rootRole = (code: string, name: string): AccountRole => {
    const byCode = roleFromCode(code);
    if (byCode) return byCode;
    if (/^\d/.test(code)) {
      if (SAYS_NOT_IN_SCOPE.test(name)) return "excluded";
      if (SAYS_DEPRECIATION.test(name)) return "depreciation";
      if (SAYS_NOT_COST.test(name)) return "excluded";
      return SAYS_FA_EXPLICIT.test(name) ? "cost" : "excluded";
    }
    return roleFromName(name);
  };
  const roleOf = (code: string, name: string, depth: number): AccountRole => {
    const cacheKey = `${code}\u001f${name}`;
    const cached = resolved.get(cacheKey);
    if (cached) return cached;
    const parent = depth < 32 ? nearestParent(chart, code) : "";
    const base = parent
      ? roleOf(parent, chart.get(parent) ?? "", depth + 1)
      : rootRole(code, name || code);
    let role = base;
    // 名称修正对整枝生效（含继承为「排除」的枝）：累计折旧提为折旧，
    // 清理／折旧费／使用权压回排除；被排除的数字编码若自身名称明确写出
    // 「固定资产」则提为原值——上级名不含语义、子级写明的账套也能进表。
    if (SAYS_NOT_IN_SCOPE.test(name)) role = "excluded";
    else if (SAYS_DEPRECIATION.test(name)) role = "depreciation";
    else if (SAYS_NOT_COST.test(name)) role = "excluded";
    else if (
      base === "excluded" &&
      /^\d/.test(code) &&
      SAYS_FA_EXPLICIT.test(name)
    ) {
      role = "cost";
    }
    resolved.set(cacheKey, role);
    return role;
  };
  return parts.map(({ account, code, name }) => ({
    account,
    role: code ? roleOf(code, name || chart.get(code) || "", 0) : roleFromName(name),
    category: faCategory(name || (code ? firstName.get(code) : "") || account),
  }));
}

export function suggestFaAccount(account: string): Assignment {
  return suggestFaAccounts([account])[0];
}

/** 显示顺序：原值 → 累计折旧 → 其余科目垫底，按自动分类排，用户改角色后不跳行。 */
const ROLE_ORDER: Record<AccountRole, number> = {
  cost: 0,
  depreciation: 1,
  excluded: 2,
};

export function faAssignmentsForEntities(
  accounts: string[],
  entities: string[],
  current: Assignment[],
): Assignment[] {
  const effectiveEntities = entities.length ? entities : [DEFAULT_ENTITY];
  const suggested = new Map(
    suggestFaAccounts(accounts).map((item) => [item.account, item]),
  );
  const ordered = [...accounts].sort(
    (a, b) =>
      ROLE_ORDER[suggested.get(a)?.role ?? "excluded"] -
      ROLE_ORDER[suggested.get(b)?.role ?? "excluded"],
  );
  return effectiveEntities.flatMap((entity) =>
    ordered.map((account) => {
      const previous = current.find(
        (item) => item.account === account && item.entity === entity,
      );
      return previous
        ? normalizeAssignmentCategory(previous)
        : {
            ...(suggested.get(account) ?? suggestFaAccount(account)),
            entity,
          };
    }),
  );
}

/** 账里真实存在的「主体×科目」组合（inspect_* 的 entityAccounts 项）。 */
export type EntityAccountPair = { entity: string; account: string; auxiliary?: string; currency?: string };

const faAssignmentIdentity = (row: Pick<Assignment, "entity" | "account" | "auxiliary" | "currency">) => {
  const { code, name } = splitFaAccount(row.account);
  return JSON.stringify([
    row.entity || DEFAULT_ENTITY,
    code || "",
    name || (code ? "" : row.account.trim()),
    row.auxiliary ?? "",
    row.currency ?? "",
  ]);
};

/** TB 在前、JE 在后合并两侧真实组合，按「主体＋科目串」去重（TB 写法优先保留）。 */
export function unionEntityAccounts(
  tb: EntityAccountPair[] | undefined,
  je: EntityAccountPair[] | undefined,
): EntityAccountPair[] {
  const seen = new Set<string>();
  const pairs: EntityAccountPair[] = [];
  for (const pair of [...(tb ?? []), ...(je ?? [])]) {
    const entity = pair.entity?.trim() || DEFAULT_ENTITY;
    const account = pair.account?.trim() ?? "";
    if (!account) continue;
    const key = faAssignmentIdentity({ entity, account, auxiliary: pair.auxiliary, currency: pair.currency });
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ entity, account, ...(pair.auxiliary ? { auxiliary: pair.auxiliary } : {}), ...(pair.currency ? { currency: pair.currency } : {}) });
  }
  return pairs;
}

/** 固定资产科目复核只以 TB 为范围；JE 只用于匹配变动与保留整张凭证。 */
export function faReviewEntityAccounts(
  tb: EntityAccountPair[] | undefined,
  entityKeyEnabled = true,
): EntityAccountPair[] {
  return unionEntityAccounts(
    tb?.map((pair) => ({
      ...pair,
      entity: entityKeyEnabled ? pair.entity : DEFAULT_ENTITY,
    })),
    undefined,
  );
}

/**
 * 按账里真实存在的「主体×科目」组合铺科目复核清单。
 * 旧口径 faAssignmentsForEntities 是「检测到的主体 × 全部科目」的笛卡尔积，
 * 会造出数据里不存在的幻影组合（主体 A 名下列出只有主体 B 才用的科目，
 * 数量还翻倍）。所有主体统一按原值、折旧、排除排序，避免前一主体的大量
 * 排除科目把后一主体的固定资产科目挤到后页；同一角色内保留 TB 首次出现顺序。
 * 用户确认过的行按「主体＋科目串」原样保留。
 */
export function faAssignmentsForEntityAccounts(
  pairs: EntityAccountPair[],
  current: Assignment[],
): Assignment[] {
  const suggested = new Map(
    suggestFaAccounts([...new Set(pairs.map((pair) => pair.account))]).map(
      (item) => [item.account, item],
    ),
  );
  const orderOf = (account: string) =>
    ROLE_ORDER[suggested.get(account)?.role ?? "excluded"];
  return pairs
    .map(({ entity, account, auxiliary, currency }, index) => ({ entity, account, auxiliary, currency, index }))
    .sort(
      (a, b) => orderOf(a.account) - orderOf(b.account) || a.index - b.index,
    )
    .map(({ entity, account, auxiliary, currency }) => {
      const previous = current.find(
        (item) => faAssignmentIdentity(item) === faAssignmentIdentity({ entity, account, auxiliary, currency }),
      );
      return previous
        ? normalizeAssignmentCategory(previous)
        : {
            ...(suggested.get(account) ?? suggestFaAccount(account)),
            entity,
            auxiliary,
            currency,
          };
    });
}

/** 科目复核表的一行（显示层）：同一「主体＋科目编码」的 TB/JE 两种写法合并。 */
export type AssignmentView = {
  entity: string;
  auxiliary?: string;
  currency?: string;
  /** 分组键：科目编码；认不出编码时用科目串本身。 */
  key: string;
  /** 展示用科目串：优先带名称的写法，否则纯编码写法。 */
  label: string;
  /** 组内原始科目串的来源侧（TB／JE），空数组表示无从判断（回退口径）。 */
  sources: Kind[];
  /** 组内全部原始科目串——payload 逐条使用，缺一不可。 */
  accounts: string[];
  /** 组首行在 assignments 里的下标；改角色/类别经 updateAssignment 同步整组。 */
  index: number;
  role: AccountRole;
  category: string;
};

/**
 * payload 级分配行 → 显示行：按（主体, splitFaAccount(account).code）分组
 * （code 为空时按科目串本身分组），每组只渲染一行。
 * 发给引擎的 accountAssignments 仍逐条使用 entityAccounts 里的原始科目串
 * （两种写法各自成行），这里只是显示层的合并——引擎按这些串逐侧匹配。
 */
export function groupAssignmentViews(
  assignments: Assignment[],
  sourcesOf: (entity: string, account: string) => Kind[] = () => [],
): AssignmentView[] {
  const groups = new Map<
    string,
    { entity: string; rows: { row: Assignment; index: number }[] }
  >();
  assignments.forEach((row, index) => {
    const entity = row.entity ?? DEFAULT_ENTITY;
    const key = faAssignmentIdentity(row);
    const group = groups.get(key) ?? { entity, rows: [] };
    group.rows.push({ row, index });
    groups.set(key, group);
  });
  return [...groups.values()].map((group) => {
    const sourceSet = new Set<Kind>();
    for (const { row } of group.rows) {
      for (const kind of sourcesOf(row.entity ?? DEFAULT_ENTITY, row.account)) {
        sourceSet.add(kind);
      }
    }
    const accounts = group.rows.map(({ row }) => row.account);
    const first = group.rows[0];
    return {
      entity: group.entity,
      key: faAssignmentIdentity(first.row),
      auxiliary: first.row.auxiliary,
      currency: first.row.currency,
      label:
        accounts.find((account) => splitFaAccount(account).name) ?? accounts[0],
      sources: (["tb", "je"] as const).filter((kind) => sourceSet.has(kind)),
      accounts,
      index: first.index,
      // 组内各行已按「主体＋科目编码」同步（updateAssignment / 自动归一），
      // 取首行的角色与类别即可代表整组。
      role: first.row.role,
      category: first.row.category,
    };
  });
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
  // 草稿缓存非空说明本页此前有现场：登记后不参与 LRU 淘汰，
  // 保活到应用退出（避免重挂载后再次被清）。
  if (faTbJeDraftCache) markToolPageLive("fa_list");
  const [step, setStep] = useState<1 | 2 | 3>(
    () => faTbJeDraftCache?.step ?? 1,
  );
  const [paths, setPaths] = useState<Record<Kind, string>>(
    () => faTbJeDraftCache?.paths ?? { tb: "", je: "" },
  );
  const [inspects, setInspects] = useState<Partial<Record<Kind, Inspection>>>(
    () => faTbJeDraftCache?.inspects ?? {},
  );
  const [mappings, setMappings] = useState<Record<Kind, Mapping>>(
    () => faTbJeDraftCache?.mappings ?? { tb: {}, je: {} },
  );
  const [assignments, setAssignments] = useState<Assignment[]>(
    () => faTbJeDraftCache?.assignments ?? [],
  );
  const [outputPath, setOutputPath] = useState(
    () => faTbJeDraftCache?.outputPath ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sourceStatus, setSourceStatus] = useState(
    () => faTbJeDraftCache?.sourceStatus ?? "",
  );
  const [result, setResult] = useState<unknown>(() => faTbJeDraftCache?.result);
  const [resultStale, setResultStale] = useState(
    () => faTbJeDraftCache?.resultStale ?? false,
  );
  // 科目复核是必经步骤，用户在第 2 步按过「确认复核并继续」才算复核过。
  const [accountsReviewed, setAccountsReviewed] = useState(
    () => faTbJeDraftCache?.accountsReviewed ?? false,
  );
  const [assignmentPage, setAssignmentPage] = useState(
    () => faTbJeDraftCache?.assignmentPage ?? 0,
  );
  const [accountQuery, setAccountQuery] = useState(
    () => faTbJeDraftCache?.accountQuery ?? "",
  );
  const [auxiliaryLink, setAuxiliaryLink] = useState<AuxiliaryLinkResult | null>(null);
  const restoredDraftOnMount = useRef(Boolean(faTbJeDraftCache));
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
  const ledgerReviewOwner = useRef({});
  const reviewing = Boolean(reviews.reviewing.tb || reviews.reviewing.je);
  const { job, setJob, activeJobId } = useJobEvents({
    toolId: "fa_list",
    onEvent: (event) => {
      if (event.phase === "completed" && event.result) {
        setResult(event.result);
        setResultStale(false);
      }
      if (["completed", "failed", "cancelled"].includes(event.phase))
        setBusy(false);
    },
  });
  const invalidateResult = () => {
    if (result) setResultStale(true);
    activeJobId.current = "";
    setJob(undefined);
  };

  // 历史记录「继续任务」：保留已确认映射与科目分类，但必须重新读取完整
  // Inspection。仅用存档中的 Sheet/标题行伪造 Inspection，会缺 rowCount、
  // headers 等渲染必需字段，进入页面时抛错并使整个 WebView 白屏。
  // restore key 用 "fa_list:tbje" 与清单对比子页区分（见 restore.ts）。
  const restoreGeneration = useRef(0);
  const restoredTbjeMappings = useRef<
    Partial<Record<Kind, { path: string; mapping: Mapping }>>
  >({});
  useTaskRestore("fa_list:tbje", (restore) => {
    type SourceParams = {
      inputPath?: string;
      sheet?: string;
      headerRow?: number;
      headerDepth?: number;
    };
    const p = restore.params as {
      tbSource?: SourceParams;
      jeSource?: SourceParams;
      tbMapping?: Mapping;
      jeMapping?: Mapping;
      accountAssignments?: Assignment[];
      outputPath?: string;
    };
    const isMapping = (value: unknown): value is Mapping =>
      Boolean(value && typeof value === "object");
    restoredTbjeMappings.current = {
      tb:
        typeof p.tbSource?.inputPath === "string" && isMapping(p.tbMapping)
          ? { path: p.tbSource.inputPath, mapping: p.tbMapping }
          : undefined,
      je:
        typeof p.jeSource?.inputPath === "string" && isMapping(p.jeMapping)
          ? { path: p.jeSource.inputPath, mapping: p.jeMapping }
          : undefined,
    };
    const tbPath =
      typeof p.tbSource?.inputPath === "string" ? p.tbSource.inputPath : "";
    const jePath =
      typeof p.jeSource?.inputPath === "string" ? p.jeSource.inputPath : "";
    if (!tbPath && !jePath) return;
    const generation = ++restoreGeneration.current;
    const snapshot = restore.snapshot as
      | { inspects?: Partial<Record<Kind, unknown>> }
      | null;
    const cachedInspects: Partial<Record<Kind, Inspection>> = {};
    if (restore.snapshotStatus === "valid" && snapshot?.inspects) {
      if (isRestoreInspection(snapshot.inspects.tb))
        cachedInspects.tb = snapshot.inspects.tb;
      if (isRestoreInspection(snapshot.inspects.je))
        cachedInspects.je = snapshot.inspects.je;
    }
    const snapshotComplete =
      (!tbPath || Boolean(cachedInspects.tb)) &&
      (!jePath || Boolean(cachedInspects.je));
    setPaths({ tb: tbPath, je: jePath });
    setInspects(snapshotComplete ? cachedInspects : {});
    setMappings({
      tb:
        p.tbMapping && typeof p.tbMapping === "object"
          ? (p.tbMapping as Mapping)
          : {},
      je:
        p.jeMapping && typeof p.jeMapping === "object"
          ? (p.jeMapping as Mapping)
          : {},
    });
    if (Array.isArray(p.accountAssignments))
      setAssignments(p.accountAssignments as Assignment[]);
    if (typeof p.outputPath === "string") setOutputPath(p.outputPath);
    // 字段映射已并入第 1 步，直接落回「上传与映射」。
    setStep(1);
    setAccountsReviewed(false);
    setError("");
    setResult(undefined);
    setJob(undefined);
    if (snapshotComplete) {
      setBusy(false);
      setSourceStatus("已从历史快照恢复 TB/JE 源信息，请复核映射与科目分类后继续。");
      return;
    }
    setBusy(true);
    setSourceStatus("正在重新识别历史任务的 TB/JE 源文件…");
    void (async () => {
      const sources: Array<{ kind: Kind; path: string; source: SourceParams }> =
        [];
      if (tbPath)
        sources.push({ kind: "tb", path: tbPath, source: p.tbSource! });
      if (jePath)
        sources.push({ kind: "je", path: jePath, source: p.jeSource! });
      const results = await Promise.all(
        sources.map(async ({ kind, path, source }) => {
          try {
            const inspection = (await engineCall(`deposit.inspect_${kind}`, {
              source: {
                inputPath: path,
                sheet: source.sheet ?? "",
                headerRow: source.headerRow ?? 0,
                headerDepth: source.headerDepth ?? 0,
              },
            }, `${kind.toUpperCase()} ${fileName(path)}`)) as Inspection;
            if (!isRestoreInspection(inspection)) {
              throw new Error("源文件识别结果不完整，请重新选择文件。");
            }
            return { kind, inspection, error: "" };
          } catch (reason) {
            return {
              kind,
              inspection: undefined,
              error: `${kind.toUpperCase()}：${errorText(reason)}`,
            };
          }
        }),
      );
      if (generation !== restoreGeneration.current) return;
      const restored: Partial<Record<Kind, Inspection>> = {};
      for (const item of results) {
        if (item.inspection) restored[item.kind] = item.inspection;
      }
      setInspects(restored);
      const failures = results.map((item) => item.error).filter(Boolean);
      setSourceStatus(
        failures.length
          ? "历史任务有源文件未能重新识别，请重新选择后继续。"
          : "历史任务源文件已重新识别，请复核映射与科目分类后继续。",
      );
      setError(failures.join("；"));
      setBusy(false);
    })();
  });

  const accounts = useMemo(
    () => [...new Set(inspects.tb?.accounts ?? [])],
    [inspects.tb],
  );
  // 主体是公共映射字段；源表没有主体列时由引擎统一使用默认主体。
  const entitiesReady = Boolean(inspects.tb && inspects.je);
  const entityKeyEnabled = ledgerEntityKeyEnabled(mappings.tb, mappings.je);
  const entities = useMemo(() => {
    if (!entityKeyEnabled) return [DEFAULT_ENTITY];
    const detected = [...new Set(inspects.tb?.entities ?? [])].filter(Boolean);
    return detected.length ? detected : [DEFAULT_ENTITY];
  }, [inspects.tb, entityKeyEnabled]);
  // 科目复核只以 TB 中真实存在的「主体×科目」为范围。JE 是变动明细来源，
  // 其中的对方科目不能进入固定资产科目分类。旧后端／浏览器预览没有
  // entityAccounts 时，回退为 TB 主体 × TB 科目。
  const entityAccountPairs = useMemo(
    () => {
      const raw = inspects.tb?.reviewAccounts ?? inspects.tb?.entityAccounts;
      const verified = auxiliaryLink?.status === "verified";
      const effective = raw?.map((pair) => ({
        ...pair,
        auxiliary: verified && "auxiliary" in pair && typeof pair.auxiliary === "string"
          ? pair.auxiliary : undefined,
      }));
      return faReviewEntityAccounts(effective, entityKeyEnabled);
    },
    [inspects.tb?.reviewAccounts, inspects.tb?.entityAccounts, entityKeyEnabled, auxiliaryLink?.status],
  );
  const entityScope = useEntityScopeConfirmation({
    tbEntities: entityKeyEnabled ? (inspects.tb?.entities ?? []) : [],
    jeEntities: entityKeyEnabled ? (inspects.je?.entities ?? []) : [],
    initialSelection: faTbJeDraftCache?.entityScope,
    onInvalidate: () => {
      invalidateResult();
    },
  });
  const missingMappings = {
    tb: faTbJeMissingMappings("tb", mappings.tb),
    je: faTbJeMissingMappings("je", mappings.je),
  };
  const mappingsReady =
    Boolean(inspects.tb && inspects.je) &&
    missingMappings.tb.length === 0 &&
    missingMappings.je.length === 0;
  // 来源或辅助映射变化只让旧计划失效；真正的 TB→JE 验证由用户确认
  // 第一步、进入科目复核时显式触发，不能在页面停留期间后台扫 JE。
  const auxiliaryLinkKey = inspects.tb && inspects.je
    ? JSON.stringify({
        tb: [source("tb"), mappings.tb.auxiliary ?? null],
        je: [source("je"), mappings.je.auxiliary ?? null],
      })
    : null;
  useEffect(() => {
    setAuxiliaryLink(null);
  }, [auxiliaryLinkKey]);
  // 确认行按主体、编码、名称、有效辅助值和币种区分；只有完整身份相同才合并。
  const assignmentViews = useMemo(
    () => groupAssignmentViews(assignments),
    [assignments],
  );
  const includedViews = assignmentViews.filter(
    (view) => view.role !== "excluded",
  );
  const unresolvedViews = includedViews.filter(
    (view) => !view.category.trim() || view.category === "未分类",
  );
  const assignmentsReady =
    assignmentViews.some((view) => view.role === "cost") &&
    unresolvedViews.length === 0;
  // 科目复核铺开全部科目：只列固定资产候选的话，被自动分类漏判的科目
  // 连露面的机会都没有；科目已按角色降序分组，分页浏览即可，不再需要检索。
  const filteredAssignmentViews = useMemo(() => {
    const matches = keywordFilterPredicate(accountQuery);
    return assignmentViews.filter((view) =>
      matches([view.label, ...view.accounts].join(" ")),
    );
  }, [assignmentViews, accountQuery]);
  const pageCount = Math.max(
    1,
    Math.ceil(filteredAssignmentViews.length / PAGE_SIZE),
  );
  const visibleAssignmentPage = Math.min(assignmentPage, pageCount - 1);
  const pagedViews = filteredAssignmentViews
    .map((view, index) => ({ view, index }))
    .slice(
      visibleAssignmentPage * PAGE_SIZE,
      (visibleAssignmentPage + 1) * PAGE_SIZE,
    );
  const roleCounts = assignmentViews.reduce(
    (counts, view) => ({ ...counts, [view.role]: counts[view.role] + 1 }),
    { cost: 0, depreciation: 0, excluded: 0 } as Record<AccountRole, number>,
  );
  useEffect(() => {
    if (restoredDraftOnMount.current) {
      restoredDraftOnMount.current = false;
      return;
    }
    setAssignments((current) =>
      entityAccountPairs.length
        ? faAssignmentsForEntityAccounts(entityAccountPairs, current)
        : faAssignmentsForEntities(accounts, entities, current),
    );
    setAccountsReviewed(false);
  }, [entityAccountPairs, accounts, entities]);
  useEffect(() => {
    faTbJeDraftCache = {
      step,
      paths,
      inspects,
      mappings,
      assignments,
      outputPath,
      sourceStatus,
      result,
      resultStale,
      accountsReviewed,
      assignmentPage,
      accountQuery,
      entityScope: entityScope.selection,
    };
  }, [
    step,
    paths,
    inspects,
    mappings,
    assignments,
    outputPath,
    sourceStatus,
    result,
    resultStale,
    accountsReviewed,
    assignmentPage,
    accountQuery,
    entityScope.selection,
  ]);
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
    if (
      (paths.tb || paths.je) &&
      !(await confirmDialog({
        title: "重新选择整组文件？",
        message:
          "这会清空当前 TB、JE、字段映射和科目分类。若只缺一侧文件，请使用下方对应卡片的“补充上传”。",
        confirmLabel: "重新选择",
        tone: "danger",
      }))
    )
      return;
    restoreGeneration.current += 1;
    // 公共入口代表重新选择整组；分批补齐走下方待上传单侧卡片。
    reviews.clearReview("tb");
    reviews.clearReview("je");
    setPaths({ tb: "", je: "" });
    setInspects({});
    setMappings({ tb: {}, je: {} });
    setAssignments([]);
    setAccountsReviewed(false);
    setAssignmentPage(0);
    setAccountQuery("");
    setResult(undefined);
    setResultStale(false);
    setOutputPath("");
    setStep(1);
    setBusy(true);
    setError("");
    setSourceStatus("正在识别文件类型、Sheet、表头和字段…");
    const failures: string[] = [];
    try {
      const scan = await scanLedgerUploadSources<Classification>(
        engineCall,
        files,
        {
          llmMethod: "fa_tbje.classify_source_llm",
          onWorkbookStart: (path, index, total) =>
            setSourceStatus(
              `正在识别第 ${index + 1}/${total} 份：${fileName(path)}`,
            ),
        },
      );
      failures.push(
        ...scan.failures.map(
          (failure) => `${fileName(failure.path)}：${errorText(failure.error)}`,
        ),
      );
      const selected = selectLedgerSourcePair(scan.sources);
      let inspectedCount = 0;
      const inspectedResults = await Promise.all(
        selected.map(async (item, index) => {
          const kind = item.kind;
          setSourceStatus(
            `正在读取第 ${index + 1}/${selected.length} 份 ${kind.toUpperCase()}：${fileName(item.path)}`,
          );
          try {
            const inspected = (await engineCall(`deposit.inspect_${kind}`, {
              source: {
                inputPath: item.path,
                sheet: item.classification.sheet,
                headerRow: 0,
                headerDepth: 0,
              },
            }, `${kind.toUpperCase()} ${fileName(item.path)}`)) as Inspection;
            inspectedCount += 1;
            setSourceStatus(
              `已读取 ${inspectedCount}/${selected.length} 份，正在整理字段映射…`,
            );
            return { kind, path: item.path, inspected };
          } catch (e) {
            failures.push(`${fileName(item.path)}：${errorText(e)}`);
            return undefined;
          }
        }),
      );
      const recognized = inspectedResults.filter(
        (item): item is { kind: Kind; path: string; inspected: Inspection } =>
          Boolean(item),
      );
      for (const item of recognized) {
        setPaths((current) => ({ ...current, [item.kind]: item.path }));
        setInspects((current) => ({
          ...current,
          [item.kind]: item.inspected,
        }));
        // 历史恢复后重新识别同一文件：存档映射顶回建议映射（逐侧一次性
        // 消费，换文件照旧用建议值）。
        const stash = restoredTbjeMappings.current[item.kind];
        const samePath = (a: string, b: string) =>
          a.trim().toLowerCase() === b.trim().toLowerCase();
        const mapping =
          stash && samePath(stash.path, item.path)
            ? stash.mapping
            : (item.inspected.suggestedMapping ?? {});
        if (stash && samePath(stash.path, item.path))
          restoredTbjeMappings.current[item.kind] = undefined;
        setMappings((current) => ({
          ...current,
          [item.kind]: mapping,
        }));
        reviews.clearReview(item.kind);
        if (item.kind === "je") {
          setOutputPath((current) => current || defaultOutput(item.path));
        }
      }
      setSourceStatus(
        recognized.length
          ? scan.hiddenSheets
            ? `${scan.hiddenSheets} 张低置信度 Sheet 已忽略，请核对已选工作表。`
            : ""
          : "没有文件识别成功，请检查文件内容后重试。",
      );
      if (failures.length) setError(failures.join("；"));
    } finally {
      setBusy(false);
    }
  }

  function clearSource(kind: Kind) {
    restoreGeneration.current += 1;
    reviews.clearReview(kind);
    setPaths((current) => ({ ...current, [kind]: "" }));
    setInspects((current) => ({ ...current, [kind]: undefined }));
    setMappings((current) => ({ ...current, [kind]: {} }));
    setAssignments([]);
    invalidateResult();
    setSourceStatus(`${kind.toUpperCase()} 已清除，请重新上传。`);
    setStep(1);
  }

  async function replaceSource(kind: Kind) {
    const picked = await pickPath(
      "file",
      kind === "tb" ? "更换 TB 科目余额表" : "更换 JE 序时账",
      ["xlsx", "xls", "xlsm", "csv"],
    );
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    restoreGeneration.current += 1;
    reviews.clearReview(kind);
    setBusy(true);
    setError("");
    setSourceStatus(`正在按 ${kind.toUpperCase()} 读取 ${fileName(path)}…`);
    try {
      const inspected = (await engineCall(`deposit.inspect_${kind}`, {
        source: { inputPath: path, sheet: "", headerRow: 0, headerDepth: 0 },
      }, `${kind.toUpperCase()} ${fileName(path)}`)) as Inspection;
      setPaths((current) => ({ ...current, [kind]: path }));
      setInspects((current) => ({ ...current, [kind]: inspected }));
      setMappings((current) => ({
        ...current,
        [kind]: inspected.suggestedMapping ?? {},
      }));
      setAssignments([]);
      setAccountsReviewed(false);
      invalidateResult();
      setSourceStatus(
        `${kind.toUpperCase()} 已更换为 ${fileName(path)} / ${inspected.sheet}。`,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeSourceKind(from: Kind, to: Kind) {
    const current = inspects[from];
    const occupied = inspects[to];
    if (!paths[from] || !current) return;
    setBusy(true);
    setError("");
    try {
      const changed = await correctLedgerSourceKinds(
        from,
        to,
        { path: paths[from], inspection: current },
        paths[to] && occupied
          ? { path: paths[to], inspection: occupied }
          : undefined,
        async (kind, source) =>
          (await engineCall(`deposit.inspect_${kind}`, {
            source: {
              inputPath: source.path,
              sheet: source.inspection.sheet,
              headerRow: 0,
              headerDepth: 0,
            },
          }, `${kind.toUpperCase()} ${fileName(source.path)}`)) as Inspection,
      );
      setPaths({ tb: "", je: "" });
      setInspects({});
      setMappings({ tb: {}, je: {} });
      for (const item of changed) {
        setPaths((value) => ({ ...value, [item.kind]: item.path }));
        setInspects((value) => ({ ...value, [item.kind]: item.inspection }));
        setMappings((value) => ({
          ...value,
          [item.kind]: item.inspection.suggestedMapping ?? {},
        }));
      }
      setAssignments([]);
      setAccountsReviewed(false);
      invalidateResult();
      setSourceStatus(
        changed.length > 1
          ? "JE 与 TB 来源已交换，并按新类型重新识别。"
          : `${fileName(paths[from])} 已更正为 ${to.toUpperCase()}。`,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function reinspect(
    kind: Kind,
    over: Partial<Pick<Inspection, "sheet" | "headerRow" | "headerDepth">>,
  ) {
    const current = inspects[kind];
    if (!current || !paths[kind]) return;
    if (
      (assignments.length || result) &&
      !(await confirmDialog({
        title: `重新读取 ${kind.toUpperCase()}？`,
        message:
          "Sheet 或标题行变化后，现有结果会标记为待重算。新表头中仍存在的人工字段映射及同一主体＋科目的分类会尽量保留；无法对应的项目需重新确认。",
        confirmLabel: "重新读取",
      }))
    )
      return;
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
      }, `${kind.toUpperCase()} ${fileName(paths[kind])}`)) as Inspection;
      setInspects((value) => ({ ...value, [kind]: inspected }));
      setMappings((value) => ({
        ...value,
        [kind]: Object.fromEntries(
          Object.entries({
            ...(inspected.suggestedMapping ?? {}),
            ...value[kind],
          }).filter(([, mapped]) =>
            Array.isArray(mapped)
              ? mapped.every((column) => inspected.headers.includes(column))
              : !mapped || inspected.headers.includes(mapped),
          ),
        ) as Mapping,
      }));
      setAccountsReviewed(false);
      if (result) setResultStale(true);
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
      auxiliaryPlan:
        auxiliaryLink?.planKey && auxiliaryLink.status === "verified"
          ? {
              planKey: auxiliaryLink.planKey,
              groups: (auxiliaryLink.groups ?? []).map((item) => ({
                entity: item.entity,
                account: item.account,
                tbColumn: item.tbColumn,
                jeColumn: item.column,
                anchorHits: item.anchorHits,
                anchorTotal: item.anchorTotal,
              })),
            }
          : undefined,
      accountAssignments: assignments.map((assignment) => ({
        ...assignment,
        category: normalizeFaCategory(assignment.category),
      })),
      tbFixedEntity: DEFAULT_ENTITY,
      jeFixedEntity: DEFAULT_ENTITY,
      entityScope: entityScope.selection,
      outputPath,
      __restoreSnapshot: {
        version: 1,
        sources: ([paths.tb, paths.je] as string[]).filter(Boolean),
        data: { inspects },
      },
    };
  }

  async function openAccountReview() {
    if (!mappingsReady) return;
    setBusy(true);
    setError("");
    setSourceStatus("正在确认映射口径并刷新 TB 科目清单…");
    try {
      // 辅助核算属于映射口径，不依赖第二步才确认的固定资产目标科目。
      // 后端会在 TB 未映射辅助字段或没有有效锚点时直接返回，不读取 JE。
      const verified = await verifyAuxiliaryLink({
        tbSource: source("tb"),
        jeSource: source("je"),
        tbMapping: mappings.tb,
        jeMapping: mappings.je,
        entityScope: entityScope.selection,
      });
      setAuxiliaryLink(verified);
      const tbMapping = dropUnlinkedTbAuxiliary(mappings.tb, verified);
      if (tbMapping !== mappings.tb) {
        setMappings((current) => ({ ...current, tb: tbMapping }));
      }
      // 科目分类只以 TB 中真实存在的主体×科目为范围；JE 不在这里重读。
      const refreshedTb = (await engineCall("deposit.inspect_tb", {
        source: source("tb"),
        mapping: tbMapping,
      }, `TB ${fileName(paths.tb)}`)) as Inspection;
      setInspects((current) => ({
        ...current,
        tb: refreshedTb,
      }));
      setAccountsReviewed(false);
      setAssignmentPage(0);
      setSourceStatus("映射口径已确认；已按 TB 刷新主体与科目清单，请复核分类。");
      setStep(2);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
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
      setError("TB 或 JE 仍有必填字段未映射，请返回「上传与映射」步骤处理。");
      setStep(1);
      return;
    }
    if (!assignmentViews.some((view) => view.role === "cost")) {
      setError("请至少确认一个固定资产原值科目。");
      setStep(2);
      return;
    }
    if (unresolvedViews.length) {
      setError("仍有已纳入科目未确认资产类别，请返回科目复核步骤处理。");
      setStep(2);
      return;
    }
    if (!accountsReviewed) {
      setError("请先完成科目复核：确认每个科目的角色与资产类别后再生成底稿。");
      setStep(2);
      return;
    }
    if (method === "fa.tbje_export" && resultStale) {
      setError("输入或分类已变化，请先重新生成预览，再导出最新底稿。");
      return;
    }
    if (method.endsWith("export") && !outputPath) {
      setError("请选择输出路径。");
      return;
    }
    setBusy(true);
    setError("");
    // 重算期间保留上一版，便于对照；任务完成后由事件替换并清除待重算状态。
    if (result) setResultStale(true);
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

  // 同一个科目在 TB 与 JE 里可能拼成两种科目串（列序不同，编码一头一尾），
  // 两行分别参与两侧匹配、缺一不可。用户只改其中一行的话，引擎会按
  // FA_TBJE_ACCOUNT_ASSIGNMENT_CONFLICT 拒绝导出——所以改动按「主体＋科目编码」同步。
  // 复核表把这两种写法合并成一行显示（见 groupAssignmentViews），本函数的
  // 同步范围恰好就是该行背后的整组原始串，改一处即整组生效。
  function updateAssignment(index: number, patch: Partial<Assignment>) {
    invalidateResult();
    setAccountsReviewed(false);
    const normalizedPatch =
      typeof patch.category === "string"
        ? { ...patch, category: normalizeFaCategory(patch.category) }
        : patch;
    setAssignments((rows) => {
      const target = rows[index];
      if (!target) return rows;
      const identity = faAssignmentIdentity(target);
      return rows.map((row, rowIndex) =>
        rowIndex === index ||
        faAssignmentIdentity(row) === identity
          ? { ...row, ...normalizedPatch }
          : row,
      );
    });
  }

  function applyRoleToAll(role: AccountRole) {
    invalidateResult();
    setAccountsReviewed(false);
    setAssignments((rows) => rows.map((row) => ({ ...row, role })));
  }

  return (
    <div className="fa-tbje-page">
      <StepIndicator
        steps={[
          { key: "source", label: "上传与映射" },
          {
            key: "accounts",
            label: "科目复核",
            disabled: !mappingsReady || !entitiesReady,
          },
          {
            key: "output",
            label: "预览与导出",
            disabled: !assignmentsReady || !accountsReviewed,
          },
        ]}
        current={step - 1}
        onStepClick={(index) => {
          if (index === 1 && step === 1) {
            void openAccountReview();
            return;
          }
          setStep((index + 1) as 1 | 2 | 3);
        }}
      />
      <ErrorBox error={error} onDismiss={() => setError("")} />

      {step === 1 && (
        <div className="fa-tbje-step-stack">
          <Card variant="section">
            <CardHeader>
              <CardTitle>上传审计数据并核对字段映射</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="fx-source-requirements" aria-label="所需审计资料">
                <strong>当前模式所需资料</strong>
                <span className={paths.je ? "ready" : "required"}>
                  JE 序时账{paths.je ? "（已添加）" : "（必需）"}
                </span>
                <span className={paths.tb ? "ready" : "required"}>
                  TB 科目余额表{paths.tb ? "（已添加）" : "（必需）"}
                </span>
              </div>
              <FileDropInput
                containerRef={uploadDropRef}
                value={paths.je || paths.tb}
                displayValue={(["je", "tb"] as const)
                  .filter((kind) => paths[kind])
                  .map((kind) => {
                    const inspection = inspects[kind];
                    return `${kind.toUpperCase()}：${fileName(paths[kind])}${inspection?.sheet ? ` / ${inspection.sheet}` : ""}`;
                  })
                  .join("；")}
                hideFilledLabel
                disabled={busy}
                placeholder={
                  busy
                    ? "正在识别文件…"
                    : "拖放或选择 TB、JE 文件（可同时选择）"
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
                <div
                  className={`fx-source-slot fx-source-slot-${kind}`}
                  key={kind}
                >
                  {paths[kind] && inspects[kind] ? (
                    <FaLedgerSourceCard
                      kind={kind}
                      path={paths[kind]}
                      inspection={inspects[kind]!}
                      disabled={busy}
                      onReplace={() => void replaceSource(kind)}
                      onClear={() => clearSource(kind)}
                      onKindChange={() =>
                        void changeSourceKind(kind, kind === "tb" ? "je" : "tb")
                      }
                      onHeaderChange={(over) => void reinspect(kind, over)}
                    />
                  ) : (
                    <Card variant="subtle" className="fx-source-empty">
                      <CardHeader>
                        <CardTitle>
                          {kind === "tb" ? "TB 科目余额表" : "JE 序时账"}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p>未识别到 {kind.toUpperCase()}，请继续上传。</p>
                        <Button
                          type="button"
                          variant="secondary"
                          className="fx-side-upload"
                          disabled={busy}
                          onClick={() => void replaceSource(kind)}
                        >
                          补充上传 {kind.toUpperCase()}
                        </Button>
                      </CardContent>
                    </Card>
                  )}
                </div>
              ))}
            </div>
          )}
          {(inspects.tb || inspects.je) && (
            <LedgerReviewAll
              showDescription={false}
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
              results={reviews.results}
              disabled={busy}
              autoReviewKey={busy ? "" : completeLedgerPairReviewKey(
                inspects.tb && [paths.tb, inspects.tb.sheet, inspects.tb.headerRow, inspects.tb.headerDepth],
                inspects.je && [paths.je, inspects.je.sheet, inspects.je.headerRow, inspects.je.headerDepth],
              )}
              autoReviewOwner={ledgerReviewOwner.current}
              onReviewAll={() =>
                void reviews.reviewAll({
                  tb: inspects.tb
                    ? {
                        headers: inspects.tb.headers,
                        preview: inspects.tb.preview,
                        mapping: mappings.tb,
                        labels: resolveRoleLabels(inspects.tb.roles, TB_LABELS),
                        tool: "fa_tbje",
                        onApplied: (next) => {
                          invalidateResult();
                          setAccountsReviewed(false);
                          setMappings((value) => ({ ...value, tb: next }));
                        },
                        missingAfter: (mapping) =>
                          faTbJeMissingMappings("tb", mapping),
                      }
                    : undefined,
                  je: inspects.je
                    ? {
                        headers: inspects.je.headers,
                        preview: inspects.je.preview,
                        mapping: mappings.je,
                        labels: resolveRoleLabels(inspects.je.roles, JE_LABELS),
                        tool: "fa_tbje",
                        onApplied: (next) => {
                          invalidateResult();
                          setAccountsReviewed(false);
                          setMappings((value) => ({ ...value, je: next }));
                        },
                        missingAfter: (mapping) =>
                          faTbJeMissingMappings("je", mapping),
                      }
                    : undefined,
                })
              }
              onUndo={reviews.undoChange}
              onAccept={reviews.acceptPending}
            />
          )}
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
                  onChange={(next) => {
                    invalidateResult();
                    setAccountsReviewed(false);
                    setMappings((current) => ({
                      ...current,
                      [kind]: next as Mapping,
                    }));
                  }}
                />
              ),
          )}
          {paths.tb && paths.je && <Card variant="section">
            <CardContent>
              <AuxiliaryLinkStatusView result={auxiliaryLink} />
              <div className="fa-tbje-step-actions">
                {paths.tb && paths.je && (
                  <span>
                    {mappingsReady
                      ? "TB 与 JE 必填字段均已映射。"
                      : "请处理上方标出的未映射字段。"}
                  </span>
                )}
                <Button
                  disabled={!mappingsReady || reviewing || busy}
                  onClick={() => void openAccountReview()}
                >
                  下一步：复核科目分类
                </Button>
              </div>
            </CardContent>
          </Card>}
        </div>
      )}

      {step === 2 && (
        <Card variant="section">
          <CardHeader className="fa-tbje-card-head">
            <CardTitle>复核固定资产科目与资产类别</CardTitle>
            <div className="fa-tbje-counts">
              <Badge variant="info">原值 {roleCounts.cost}</Badge>
              <Badge variant="secondary">
                累计折旧 {roleCounts.depreciation}
              </Badge>
              <Badge variant="outline">排除 {roleCounts.excluded}</Badge>
              <Badge
                variant={unresolvedViews.length ? "destructive" : "outline"}
              >
                待确认类别 {unresolvedViews.length}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="form-stack">
            <div className="fa-tbje-account-toolbar">
              <Button
                type="button"
                variant="secondary"
                onClick={() => applyRoleToAll("cost")}
              >
                设为原值
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => applyRoleToAll("depreciation")}
              >
                设为折旧
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => applyRoleToAll("excluded")}
              >
                全部排除
              </Button>
              <KeywordFilter
                value={accountQuery}
                onChange={(value) => {
                  setAccountQuery(value);
                  setAssignmentPage(0);
                }}
                ariaLabel="筛选科目"
                placeholder="输入科目编码或名称"
                matched={filteredAssignmentViews.length}
                total={assignmentViews.length}
              />
            </div>
            <div className="fa-tbje-account-table-wrap">
              <table className="fa-tbje-account-table fa-tbje-review-table">
                <thead>
                  <tr>
                    <th>主体</th>
                    <th>科目</th>
                    <th>辅助字段</th>
                    <th>币种</th>
                    <th>角色</th>
                    <th>资产类别</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedViews.map(({ view, index }) => (
                    <tr key={JSON.stringify([view.entity, view.key])}>
                      <td>
                        <Badge variant="outline">{view.entity}</Badge>
                      </td>
                      <td title={view.accounts.join("；")}>
                        <div className="fa-tbje-account-cell">
                          <span className="fa-tbje-account-name">
                            {view.label}
                          </span>
                        </div>
                      </td>
                      <td>{view.auxiliary || "—"}</td>
                      <td>{view.currency || "—"}</td>
                      <td>
                        <select
                          aria-label={`${view.label}的科目角色`}
                          name={`role-${index}`}
                          autoComplete="off"
                          value={view.role}
                          disabled={busy}
                          onChange={(event) =>
                            updateAssignment(view.index, {
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
                        {view.role === "excluded" ? (
                          <span className="fa-tbje-category-na">—</span>
                        ) : (
                          <Input
                            aria-label={`${view.label}的资产类别`}
                            name={`category-${index}`}
                            autoComplete="off"
                            value={view.category}
                            disabled={busy}
                            onChange={(event) =>
                              updateAssignment(view.index, {
                                category: event.target.value,
                              })
                            }
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                  {!pagedViews.length && (
                    <tr>
                      <td colSpan={6} className="fa-tbje-empty-table">
                        {accountQuery.trim()
                          ? "没有匹配的科目。"
                          : "没有可复核的 TB 科目。"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="fa-tbje-confirm-footer">
              <div className="fa-tbje-pagination">
                <span>
                  第 {visibleAssignmentPage + 1}/{pageCount} 页，每页最多{" "}
                  {PAGE_SIZE} 项
                </span>
                <div>
                  <Button
                    variant="ghost"
                    disabled={visibleAssignmentPage === 0}
                    onClick={() =>
                      setAssignmentPage((value) => Math.max(0, value - 1))
                    }
                  >
                    上一页
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={visibleAssignmentPage + 1 >= pageCount}
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
              <AccountConfirmationActions
                tool="fa_tbje"
                title="固定资产TBJE"
                context={JSON.stringify([paths, mappings, assignmentViews.map((view) => [view.entity, view.key])])}
                columns={[
                  { key: "entity", title: "主体" },
                  { key: "account", title: "科目" },
                  { key: "auxiliary", title: "辅助字段" },
                  { key: "currency", title: "币种" },
                  { key: "role", title: "角色", editable: true, options: ["排除", "固定资产原值", "累计折旧"] },
                  { key: "category", title: "资产类别", editable: true },
                ]}
                rows={assignmentViews.map((view) => ({
                  key: JSON.stringify([view.entity, view.key]),
                  values: [view.entity, view.label, view.auxiliary ?? "", view.currency ?? "",
                    view.role === "cost" ? "固定资产原值" : view.role === "depreciation" ? "累计折旧" : "排除",
                    view.category],
                }))}
                disabled={busy}
                onImport={(changed) => {
                  invalidateResult();
                  const byKey = new Map(assignmentViews.map((view) => [JSON.stringify([view.entity, view.key]), view]));
                  const updates = new Map(changed.map((row) => {
                    const view = byKey.get(row.key)!;
                    const role: AccountRole = row.values[4] === "固定资产原值" ? "cost" : row.values[4] === "累计折旧" ? "depreciation" : "excluded";
                    if (role !== "excluded" && !row.values[5].trim())
                      throw new Error(`${view.label}：固定资产原值或累计折旧科目必须填写资产类别。`);
                    return [row.key, { role, category: normalizeFaCategory(row.values[5]) }] as const;
                  }));
                  setAssignments((current) => current.map((row) => {
                    const key = JSON.stringify([row.entity ?? DEFAULT_ENTITY, faAssignmentIdentity(row)]);
                    return updates.has(key) ? { ...row, ...updates.get(key)! } : row;
                  }));
                  setAccountsReviewed(false);
                }}
              />
            </div>
            <div className="fa-tbje-step-actions">
              <span>
                {!includedViews.some((view) => view.role === "cost")
                  ? "至少需要 1 个固定资产原值科目。"
                  : unresolvedViews.length
                    ? `还有 ${unresolvedViews.length} 个已纳入科目未确认资产类别。`
                    : "科目角色与类别已就绪。"}
              </span>
              <Button
                disabled={!assignmentsReady || busy}
                onClick={() => {
                  setAccountsReviewed(true);
                  setStep(3);
                }}
              >
                确认复核并继续
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && (
        <div className="fa-tbje-step-stack">
          {entityScope.panel}
          <Card variant="section">
            <CardHeader className="fa-tbje-card-head">
              <CardTitle>生成预览并导出五表</CardTitle>
              <Badge variant={resultStale ? "warning" : "success"}>
                {resultStale ? "结果待重算" : "全部就绪"}
              </Badge>
            </CardHeader>
            <CardContent className="form-stack">
              {resultStale && (
                <div className="fa-tbje-inline-warning" role="status">
                  输入、映射或科目分类已变化。下方仍保留上一次结果供对照，请重新生成预览后再导出。
                </div>
              )}
              <div className="fa-tbje-readiness-grid">
                <div>
                  <span>TB</span>
                  <strong title={paths.tb}>{fileName(paths.tb)}</strong>
                  <small>
                    {inspects.tb?.rowCount.toLocaleString("zh-CN")} 行
                  </small>
                </div>
                <div>
                  <span>JE</span>
                  <strong title={paths.je}>{fileName(paths.je)}</strong>
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
                  disabled={busy || reviewing || !outputPath || resultStale}
                  onClick={() => void run("fa.tbje_export")}
                >
                  生成五表 Excel
                </Button>
                {busy && activeJobId.current && (
                  <Button
                    variant="destructive"
                    onClick={() => void cancelJobWithFeedback(activeJobId.current!)}
                  >
                    取消
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
          {/* 任务完成后的进度横幅由结果卡片接管，跑动中才显示进度条。 */}
          {job && job.phase !== "completed" && <JobProgress job={job} />}
          <FaTbJeResultCard value={result} />
          <FaTbJeSummaryPreview value={result} />
          <FaTbJeCounterpartPreview value={result} />
        </div>
      )}
    </div>
  );
}

/** 生成预览的汇总变动表：与导出 Excel 共用同一份行定义（零行过滤一致），
    前端看到什么、导出的底稿里就是什么。表头也是同一套：空段列＋变动项目＋合计＋类别列。
    段名在切换时显示，模拟合并单元格。 */
function FaTbJeSummaryPreview({ value }: { value: unknown }) {
  const summary = (value as { summaryTable?: unknown } | null | undefined)
    ?.summaryTable as { columns?: unknown; rows?: unknown } | undefined;
  if (
    !summary ||
    !Array.isArray(summary.columns) ||
    !Array.isArray(summary.rows)
  ) {
    return null;
  }
  const columns = summary.columns as string[];
  const rows = summary.rows as FaSummaryRow[];
  if (rows.length === 0) return null;
  return (
    <Card variant="section">
      <CardHeader className="fa-tbje-card-head">
        <CardTitle>固定资产汇总变动表（预览）</CardTitle>
      </CardHeader>
      <CardContent>
        <FaSummaryTable columns={columns} rows={rows} />
      </CardContent>
    </Card>
  );
}

export type FaSummaryRow = {
  section?: string;
  item?: string;
  values?: unknown[];
};

/** 汇总变动表的表体：两期清单模式的合并预览与 TB＋JE 的生成预览共用，
    保证两个入口看到的版式、千分位与子项缩进完全一致。 */
export function FaSummaryTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: FaSummaryRow[];
}) {
  const [query, setQuery] = useState("");
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const matches = keywordFilterPredicate(query);
  const visibleRows = rows.filter((row) => {
    const values = Array.isArray(row.values) ? row.values : [];
    if (
      differencesOnly &&
      (row.section !== "勾稽差异" ||
        !values.some((value) => Math.abs(Number(value) || 0) >= 0.005))
    )
      return false;
    return matches(`${row.section ?? ""} ${row.item ?? ""}`);
  });
  let lastSection: string | null = null;
  return (
    <div className="fa-tbje-summary-shell">
      <div className="fa-tbje-summary-toolbar">
        <KeywordFilter
          value={query}
          onChange={setQuery}
          ariaLabel="搜索变动项目"
          placeholder="搜索变动项目"
          matched={visibleRows.length}
          total={rows.length}
        />
        <Button
          type="button"
          size="sm"
          variant={differencesOnly ? "default" : "secondary"}
          onClick={() => setDifferencesOnly((value) => !value)}
          aria-pressed={differencesOnly}
        >
          {differencesOnly ? "正在只看有差异" : "只看有差异"}
        </Button>
      </div>
      <div className="fa-tbje-account-table-wrap fa-tbje-summary-preview">
        <table className="fa-tbje-account-table">
        <thead>
          <tr>
            <th aria-label="分类" />
            <th>变动项目</th>
            <th>合计</th>
            {columns.map((column) => (
              <th key={column} title={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, index) => {
            const section =
              row.section && row.section !== lastSection ? row.section : "";
            lastSection = row.section ?? lastSection;
            const values = Array.isArray(row.values) ? row.values : [];
            const total = values.reduce<number>(
              (sum, item) => sum + (Number(item) || 0),
              0,
            );
            const isDiff = row.section === "勾稽差异";
            // "——其中-××"子项去前缀缩进展示，主干行加粗，避免长项目名折成多行。
            const item = row.item ?? "";
            const isSub = item.startsWith("——");
            return (
              <tr
                key={index}
                className={isDiff ? "fa-tbje-summary-diff" : undefined}
              >
                <td className="fa-tbje-summary-section">{section}</td>
                <td
                  className={
                    isSub
                      ? "fa-tbje-summary-item fa-tbje-summary-item-sub"
                      : "fa-tbje-summary-item"
                  }
                  title={item}
                >
                  {isSub ? item.replace(/^——/, "") : item}
                </td>
                <td className="fa-tbje-num fa-tbje-summary-total">
                  {formatPreviewAmount(total)}
                </td>
                {values.map((cell, cellIndex) => (
                  <td key={cellIndex} className="fa-tbje-num">
                    {formatPreviewAmount(cell)}
                  </td>
                ))}
              </tr>
            );
          })}
          {!visibleRows.length && (
            <tr>
              <td colSpan={columns.length + 3} className="fa-tbje-empty-table">
                没有符合当前筛选条件的变动项目。
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** 对方科目预览：与导出文件里的「原值透视表」「累计折旧透视表」同一套聚合
    与版式（主体｜科目｜借方金额｜贷方金额＋合计行），预览阶段即可核对方科目的
    借贷构成，确认后再生成正式 Excel。 */
function FaTbJeCounterpartPreview({ value }: { value: unknown }) {
  const pivots = (value as { counterpartPivots?: unknown } | null | undefined)
    ?.counterpartPivots as
    { cost?: CounterpartRow[]; depreciation?: CounterpartRow[] } | undefined;
  if (!pivots) return null;
  const cost = Array.isArray(pivots.cost) ? pivots.cost : [];
  const depreciation = Array.isArray(pivots.depreciation)
    ? pivots.depreciation
    : [];
  if (!cost.length && !depreciation.length) return null;
  return (
    <Card variant="section">
      <CardHeader className="fa-tbje-card-head">
        <div>
          <CardTitle>对方科目预览</CardTitle>
          <p>
            出现原值／折旧变动的凭证，其全部科目按借贷净额列示，与导出文件的两张透视表一致。
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <div className="fa-tbje-pivot-grid">
          <FaPivotTable title="原值对方科目" rows={cost} />
          <FaPivotTable title="累计折旧对方科目" rows={depreciation} />
        </div>
      </CardContent>
    </Card>
  );
}

type CounterpartRow = {
  entity?: unknown;
  account?: unknown;
  debit?: unknown;
  credit?: unknown;
};

export function FaPivotTable({
  title,
  rows,
}: {
  title: string;
  rows: CounterpartRow[];
}) {
  const totals = rows.reduce<{ debit: number; credit: number }>(
    (acc, row) => ({
      debit: acc.debit + (Number(row.debit) || 0),
      credit: acc.credit + (Number(row.credit) || 0),
    }),
    { debit: 0, credit: 0 },
  );
  return (
    <div className="fa-tbje-pivot-block">
      <h4>{title}</h4>
      <div className="fa-tbje-account-table-wrap">
        <table className="fa-tbje-account-table fa-tbje-pivot-preview">
          <colgroup>
            <col className="fa-tbje-pivot-col-entity" />
            <col className="fa-tbje-pivot-col-account" />
            <col className="fa-tbje-pivot-col-amount" />
            <col className="fa-tbje-pivot-col-amount" />
          </colgroup>
          <thead>
            <tr>
              <th>主体</th>
              <th>科目</th>
              <th>借方金额</th>
              <th>贷方金额</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td title={String(row.entity ?? "")}>
                  {String(row.entity ?? "")}
                </td>
                <td
                  className="fa-tbje-pivot-account"
                  title={String(row.account ?? "")}
                >
                  {String(row.account ?? "")}
                </td>
                <td className="fa-tbje-num">{formatPivotAmount(row.debit)}</td>
                <td className="fa-tbje-num">{formatPivotAmount(row.credit)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={4} className="fa-tbje-empty-table">
                  期间内没有相关凭证。
                </td>
              </tr>
            )}
            <tr className="fa-tbje-pivot-total">
              <td colSpan={2}>合计</td>
              <td className="fa-tbje-num">{formatPivotAmount(totals.debit)}</td>
              <td className="fa-tbje-num">
                {formatPivotAmount(totals.credit)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 与导出格式 `#,##0.00;[Red]-#,##0.00;-` 对齐：零值显示短横线。 */
function formatPivotAmount(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num) || Math.abs(num) < 0.005) return "-";
  return num.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 任务结果卡片：完成状态、关键指标、输出文件与告警集中在一处，
    替代原先横幅＋平铺链接的完成态。 */
function FaTbJeResultCard({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const outputPaths = Array.isArray(obj.outputPaths)
    ? obj.outputPaths.filter((item): item is string => typeof item === "string")
    : [];
  const warnings = Array.isArray(obj.warnings)
    ? obj.warnings.filter((item): item is string => typeof item === "string")
    : [];
  const metrics = (
    [
      ["TB 科目行", obj.tbRows],
      ["JE 明细行", obj.jeRows],
      ["新增笔数", obj.additions],
      ["处置笔数", obj.disposals],
      ["勾稽差异类别", obj.reconciliationDifferences],
    ] as Array<[string, unknown]>
  ).filter(([, v]) => typeof v === "number");
  const exported = outputPaths.length > 0;
  return (
    <Card variant="section" className="fa-tbje-result-card">
      <CardContent className="form-stack">
        <div className="fa-tbje-result-head">
          <span className="fa-tbje-result-check" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <path
                d="M3 8.5 6.5 12 13 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div className="fa-tbje-result-title">
            <strong>{exported ? "固定资产底稿已生成" : "预览已生成"}</strong>
            <p>
              {exported
                ? "五张业务表导出完成，核对指标后打开文件复核。"
                : "预览数据与导出文件一致，确认后可生成正式 Excel。"}
            </p>
          </div>
          {exported && <span className="fa-tbje-result-badge">已完成</span>}
        </div>
        {!!metrics.length && (
          <div className="fa-tbje-result-metrics">
            {metrics.map(([label, count]) => (
              <span key={label}>
                <b>{Number(count).toLocaleString("zh-CN")}</b>
                {label}
              </span>
            ))}
          </div>
        )}
        {outputPaths.map((path) => (
          <div className="fa-tbje-result-file" key={path}>
            <span className="fa-tbje-result-filename" title={path}>
              {fileName(path)}
            </span>
            <Button type="button" onClick={() => void openOutput(path)}>
              打开文件
            </Button>
          </div>
        ))}
        {!!warnings.length && (
          <div className="warning-box fa-tbje-result-warnings">
            <strong>需要注意（{warnings.length}）</strong>
            <ul>
              {warnings.slice(0, 20).map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
              {warnings.length > 20 && (
                <li>另有 {warnings.length - 20} 项未显示。</li>
              )}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatPreviewAmount(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function FaLedgerSourceCard(props: {
  kind: Kind;
  path: string;
  inspection: Inspection;
  disabled: boolean;
  onReplace: () => void;
  onClear: () => void;
  onKindChange: () => void;
  onHeaderChange: (
    over: Partial<Pick<Inspection, "sheet" | "headerRow" | "headerDepth">>,
  ) => void;
}) {
  const { kind, inspection } = props;
  return (
    <Card variant="section">
      <CardHeader>
        <CardTitle>
          已识别：{kind === "tb" ? "TB 科目余额表" : "JE 序时账"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="fx-detected-file">
          <button
            className="fx-file-name-button"
            type="button"
            title={`${props.path}（点击更换）`}
            disabled={props.disabled}
            onClick={props.onReplace}
          >
            {fileName(props.path)}
          </button>
          <button
            type="button"
            disabled={props.disabled}
            onClick={props.onClear}
          >
            移除
          </button>
          <button
            type="button"
            disabled={props.disabled}
            onClick={props.onKindChange}
          >
            更正为 {kind === "tb" ? "JE" : "TB"}
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
              {(inspection.sheets.length
                ? inspection.sheets
                : [inspection.sheet]
              ).map((sheet) => (
                <option key={sheet}>{sheet}</option>
              ))}
            </select>
          </label>
          <label>
            标题行
            <Input
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
                props.onHeaderChange({
                  headerDepth: Number(event.target.value),
                })
              }
            >
              <option value={1}>1层</option>
              <option value={2}>2层</option>
            </select>
          </label>
        </div>
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
      groups={formGroups(props.kind, roles, forms, props.mapping)}
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
