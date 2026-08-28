/**
 * 借款台账的形态判定（前端侧）。
 *
 * 型号与槽位的**唯一定义在 Rust**（`ledger_mapping::loan_forms`），随 `loan.inspect`
 * 一起下发；这里只实现"把已映射的角色套进各个型、排出最接近的那个"的纯计算，
 * 与 Rust `ledger_mapping::match_forms` 同一套排序规则。这样用户每改一次下拉
 * 不必再往后端跑一趟，型号定义也不会两边各抄一份、各自漂移。
 */

/** 一种台账形态。字段名与 Rust `Form` 一一对应。 */
export type LoanForm = {
  id: string;
  label: string;
  /** 「任一即可」槽：组内至少一个到位即满足（起算额：本金｜期初余额｜期末余额）。 */
  anyOf: string[][];
  /** 必填槽：组内全部到齐才算满足。 */
  required: string[][];
  /** 可选槽：整组给或整组不给，只给一半算无效。 */
  optional: string[][];
};

export type LoanRole = { name: string; label: string };

export type LoanFormMatch = {
  form: LoanForm;
  /** 必填槽缺失的角色。 */
  missing: string[];
  /** 「任一即可」槽一个都没给：整组列出来。 */
  missingAny: string[][];
  /** 可选槽只给了一半——这是错误不是缺省。 */
  partialOptional: string[];
  complete: boolean;
};

const filled = (value?: string | string[]) =>
  Array.isArray(value) ? value.some((x) => Boolean(x?.trim())) : Boolean(value?.trim());

/** 把已映射的角色集合套进各个形态，按匹配度排序返回。 */
export function matchLoanForms(
  forms: LoanForm[],
  mapping: Record<string, string | string[] | undefined>,
): LoanFormMatch[] {
  const has = (role: string) => filled(mapping[role]);
  const ranked = forms.map((form, index) => {
    const missing = form.required.flatMap((slot) => slot.filter((role) => !has(role)));
    const missingAny = form.anyOf.filter((slot) => !slot.some(has));
    const partialOptional = form.optional.flatMap((slot) => {
      const miss = slot.filter((role) => !has(role));
      return miss.length && miss.length < slot.length ? miss : [];
    });
    const complete = !missing.length && !missingAny.length && !partialOptional.length;
    return { match: { form, missing, missingAny, partialOptional, complete }, index };
  });
  // 与 Rust 同序：完整命中在前；其次缺得少的在前；同分时**后定义的型优先**。
  // 数组顺序从弱到强，所以类型1 ＞ 类型2 ＞ 类型3 ＞ 类型5。
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
export function resolveLoanForm(
  forms: LoanForm[],
  mapping: Record<string, string | string[] | undefined>,
): LoanFormMatch | undefined {
  return matchLoanForms(forms, mapping)[0];
}

/**
 * 当前这一型下，每个角色是必填、选填还是与形态无关。
 *
 * 依据的是**当前最接近的那一型**——用户还没映射到能判型的程度时，取排在最前的
 * 那个（缺得最少的），下拉里就已经能看出"这一型还要什么"。
 */
export function loanRoleRequirement(
  match: LoanFormMatch | undefined,
  role: string,
): "required" | "optional" | undefined {
  if (!match) return undefined;
  if (match.form.required.some((slot) => slot.includes(role))) return "required";
  if (match.form.anyOf.some((slot) => slot.includes(role))) return "required";
  if (match.form.optional.some((slot) => slot.includes(role))) return "optional";
  return undefined;
}

/** 面板上那句「已识别为 类型1（起始日＋到期日）」/「最接近 …，还缺 …」。 */
export function describeLoanForm(
  match: LoanFormMatch | undefined,
  labelOf: (role: string) => string,
): string {
  if (!match) return "";
  const head = `${match.form.id}（${match.form.label}）`;
  if (match.complete) return `已识别为 ${head}`;
  const parts: string[] = [];
  if (match.missing.length) parts.push(`缺少「${match.missing.map(labelOf).join("」「")}」`);
  for (const slot of match.missingAny)
    parts.push(`「${slot.map(labelOf).join("」「")}」至少映射一个`);
  if (match.partialOptional.length)
    parts.push(`可选字段只映射了一半，「${match.partialOptional.map(labelOf).join("」「")}」也必须一并映射`);
  return `最接近 ${head}：${parts.join("；")}`;
}
