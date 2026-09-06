/**
 * 账表形态判定（前端侧）：TB 六型、JE 三型、借款台账四型共用一套。
 *
 * 型号与槽位的**唯一定义在 Rust**（`ledger_mapping::forms`）——TB/JE 由
 * `ledger.forms` 下发，台账随 `loan.inspect` 下发；这里只实现"把已映射的角色
 * 套进各个型、排出最接近的那个"的纯计算，与 Rust `match_forms` 同一套排序规则。
 * 这样用户每改一次下拉不必再往后端跑一趟，型号定义也不会两边各抄一份。
 *
 * 面向用户的型号名一律用 `display`（`TB-类型C`），`id`（`TB3`）只在代码与测试里用。
 */
import { useEffect, useState } from "react";
import { engineCall } from "@/api";
import { GOLD_IDENTITY } from "@/ledgerMapping";

export type LedgerFormKind = "tb" | "je" | "loan";

/** 一种表形态。字段名与 Rust `Form` 一一对应。 */
export type LedgerForm = {
  id: string;
  /** 用户可见型号名，如 `TB-类型C`。旧版下发没有这个字段时回退到 `id`。 */
  display?: string;
  label: string;
  /** 「任一即可」槽：组内至少一个到位即满足（台账起算额）。TB/JE 用不到。 */
  anyOf: string[][];
  /** 必填槽：组内全部到齐才算满足。 */
  required: string[][];
  /** 可选槽：整组给或整组不给，只给一半算无效。 */
  optional: string[][];
};

export type LedgerFormMatch = {
  form: LedgerForm;
  /** 必填槽缺失的角色。 */
  missing: string[];
  /** 「任一即可」槽一个都没给：整组列出来。 */
  missingAny: string[][];
  /** 可选槽只给了一半——这是错误不是缺省。 */
  partialOptional: string[];
  complete: boolean;
};

const filled = (value?: string | string[]) =>
  Array.isArray(value)
    ? value.some((x) => Boolean(x?.trim()))
    : Boolean(value?.trim());

/** 型号的用户可见名。 */
export const formName = (form: LedgerForm) => form.display || form.id;

/** 把已映射的角色集合套进各个形态，按匹配度排序返回。 */
export function matchForms(
  kind: LedgerFormKind,
  forms: LedgerForm[],
  mapping: Record<string, string | string[] | undefined>,
): LedgerFormMatch[] {
  const has = (role: string) => filled(mapping[role]);
  const ranked = forms.map((form, index) => {
    let missing = form.required.flatMap((slot) =>
      slot.filter((role) => !has(role)),
    );
    const missingAny = form.anyOf.filter((slot) => !slot.some(has));
    const partialOptional = form.optional.flatMap((slot) => {
      const miss = slot.filter((role) => !has(role));
      return miss.length && miss.length < slot.length ? miss : [];
    });
    const complete =
      !missing.length && !missingAny.length && !partialOptional.length;
    return {
      match: { form, missing, missingAny, partialOptional, complete },
      index,
    };
  });
  // 与 Rust 同序：完整命中在前；其次缺得少的在前；同分时**后定义的型优先**。
  ranked.sort((a, b) => {
    if (a.match.complete !== b.match.complete) return a.match.complete ? -1 : 1;
    const am = a.match.missing.length + a.match.missingAny.length;
    const bm = b.match.missing.length + b.match.missingAny.length;
    if (am !== bm) return am - bm;
    if (a.match.partialOptional.length !== b.match.partialOptional.length)
      return a.match.partialOptional.length - b.match.partialOptional.length;
    return b.index - a.index;
  });
  return ranked.map((x) => x.match);
}

/** 命中哪一型；都没完整命中时返回最接近的那个（`complete` 为 false）。 */
export function resolveForm(
  kind: LedgerFormKind,
  forms: LedgerForm[],
  mapping: Record<string, string | string[] | undefined>,
): LedgerFormMatch | undefined {
  return matchForms(kind, forms, mapping)[0];
}

/**
 * 当前这一型下，每个角色是必填、选填还是与形态无关。
 *
 * 依据的是**当前最接近的那一型**——用户还没映射到能判型的程度时，取排在最前的
 * 那个（缺得最少的），下拉里就已经能看出"这一型还要什么"。
 */
export function roleRequirement(
  match: LedgerFormMatch | undefined,
  role: string,
): "required" | "optional" | undefined {
  if (!match) return undefined;
  if (match.form.required.some((slot) => slot.includes(role)))
    return "required";
  if (match.form.anyOf.some((slot) => slot.includes(role))) return "required";
  if (match.form.optional.some((slot) => slot.includes(role)))
    return "optional";
  return undefined;
}

/** 面板上那句「已识别为 TB-类型C（本位币借贷分列）」/「最接近 …，还缺 …」。 */
export function describeForm(
  match: LedgerFormMatch | undefined,
  labelOf: (role: string) => string,
): string {
  if (!match) return "";
  const head = `${formName(match.form)}（${match.form.label}）`;
  if (match.complete) return `已识别为 ${head}`;
  const parts: string[] = [];
  if (match.missing.length)
    parts.push(`缺少「${match.missing.map(labelOf).join("」「")}」`);
  for (const slot of match.missingAny)
    parts.push(`「${slot.map(labelOf).join("」「")}」至少映射一个`);
  if (match.partialOptional.length)
    parts.push(
      `可选字段只映射了一半，「${match.partialOptional.map(labelOf).join("」「")}」也必须一并映射`,
    );
  return `最接近 ${head}：${parts.join("；")}`;
}

/**
 * 槽位标题：按角色的期间前缀给一句人话。
 *
 * 分组标题不写死"必填"二字——同一个槽在不同型里必填与否不同，
 * 必填标记由面板逐项跟着当前型走（[`roleRequirement`]）。
 */
export function slotTitle(slot: string[]): string {
  const every = (prefix: string) =>
    slot.every((role) => role.startsWith(prefix));
  const some = (prefix: string) => slot.some((role) => role.startsWith(prefix));
  if (every("opening")) return "期初余额";
  if (every("closing")) return "期末余额";
  if (every("ytd")) return "本年累计发生额";
  if (every("period")) return "本期发生额";
  if (some("foreign")) return "原币金额";
  if (some("functional") || some("direction")) return "本位币金额";
  return "金额记法";
}

/**
 * 把角色清单按**当前命中的型**重排成下拉分组。
 *
 * 顺序：先身份类（不参与形态判定的角色），再按这一型的槽位逐组列出，
 * 最后把别的型才用得上的记法收进"其他记法"——它们不是漏填，是这一型不需要。
 */
export function formGroups(
  kind: LedgerFormKind,
  roles: [string, string][],
  forms: LedgerForm[],
  mapping: Record<string, string | string[] | undefined>,
): {
  title: string;
  roles: string[];
  required?: string[];
  optional?: string[];
  status?: "已适配" | "可适配" | "未适配";
}[] {
  const names = new Set(roles.map(([role]) => role));
  const inAnyForm = new Set(
    forms.flatMap((form) =>
      [...form.required, ...form.anyOf, ...form.optional].flat(),
    ),
  );
  // 本期发生额不进任何一型的槽（金标只写本年累计，它是次选口径），但它显然
  // 不是身份字段——按名字认出金额类角色，免得掉进"科目与主体"那一组里。
  // `functionalCurrency` 是币种代码列不是金额列，按后缀排除。
  const isAmountRole = (role: string) =>
    !/Currency$/.test(role) &&
    (/^(opening|closing|ytd|period|foreign|functional)/.test(role) ||
      role === "direction");
  const identity = roles
    .map(([role]) => role)
    .filter((role) => !inAnyForm.has(role) && !isAmountRole(role));
  const groups: {
    title: string;
    roles: string[];
    required?: string[];
    optional?: string[];
    status?: "已适配" | "可适配" | "未适配";
  }[] = [];
  const publicRequired = GOLD_IDENTITY[kind === "je" ? "je" : "tb"].filter(
    (role) => names.has(role),
  );
  if (publicRequired.length)
    groups.push({
      title: "公共必填字段",
      roles: publicRequired,
      required: publicRequired,
    });
  const publicOptional = identity.filter(
    (role) => !publicRequired.includes(role),
  );
  if (publicOptional.length)
    groups.push({ title: "公共选填字段", roles: publicOptional });

  const matches = new Map(
    matchForms(kind, forms, mapping).map((match) => [match.form.id, match]),
  );
  const mappedAmountRoles = roles
    .map(([role]) => role)
    .filter(
      (role) =>
        isAmountRole(role) &&
        filled(mapping[role]) &&
        !role.startsWith("period"),
    );
  for (const form of forms) {
    const formRoles = Array.from(
      new Set(
        [...form.required, ...form.anyOf, ...form.optional]
          .flat()
          .filter((role) => names.has(role)),
      ),
    );
    if (!formRoles.length) continue;
    const allowed = new Set(formRoles);
    const incompatible = mappedAmountRoles.some((role) => !allowed.has(role));
    const match = matches.get(form.id);
    const status = incompatible
      ? "未适配"
      : match?.complete
        ? "已适配"
        : "可适配";
    groups.push({
      title: `${formName(form)}（${form.label}）`,
      roles: formRoles,
      required: Array.from(new Set([...form.required, ...form.anyOf].flat())),
      optional: Array.from(new Set(form.optional.flat())),
      status,
    });
  }

  const period = roles
    .map(([role]) => role)
    .filter((role) => role.startsWith("period"));
  if (period.length)
    groups.push({ title: "本期发生额（通过勾稽后自动提升）", roles: period });
  if (!forms.length) {
    const amounts = roles
      .map(([role]) => role)
      .filter((role) => isAmountRole(role) && !role.startsWith("period"));
    if (amounts.length) groups.push({ title: "金额字段", roles: amounts });
  }
  return groups;
}

// ────────────────────────────── 形态定义的获取与缓存 ──────────────────────────────

/** 型号定义在进程内不会变，取一次缓存住；失败不阻塞映射，退回"不判型"。 */
const cache = new Map<string, Promise<LedgerForm[]>>();

export function fetchLedgerForms(kind: LedgerFormKind): Promise<LedgerForm[]> {
  const hit = cache.get(kind);
  if (hit) return hit;
  const task = Promise.resolve(engineCall("ledger.forms", { kind }))
    .then((data) => (Array.isArray(data) ? (data as LedgerForm[]) : []))
    .catch(() => {
      cache.delete(kind);
      return [] as LedgerForm[];
    });
  cache.set(kind, task);
  return task;
}

/** 取 TB/JE 的型号定义。浏览器预览模式下拿不到，返回空数组即"不判型"。 */
export function useLedgerForms(kind: LedgerFormKind): LedgerForm[] {
  const [forms, setForms] = useState<LedgerForm[]>([]);
  useEffect(() => {
    let alive = true;
    fetchLedgerForms(kind).then((list) => {
      if (alive) setForms(list);
    });
    return () => {
      alive = false;
    };
  }, [kind]);
  return forms;
}
