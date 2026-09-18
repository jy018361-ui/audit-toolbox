/**
 * 科目清单的层级筛选：多层级 TB 的科目分类界面只列一级科目，利率/存款类型
 * 确认只列末级科目。判定只认「首词是纯数字编码」的科目，且用严格的编码前缀
 * 关系（更短编码是更长编码的前缀）——分段编码（1002.01）、无编码、补零混写
 * 这些推断不出层级的形态一律原样保留，宁可多列也不误藏科目。
 * 与引擎 `inherited_role_by_code_prefix` 的纯数字口径保持一致。
 */
export function accountHierarchyCode(account: string): string {
  const first = account.trim().split(/\s+/)[0] ?? "";
  return /^\d{2,}$/.test(first) ? first : "";
}

function strictPrefixParent(code: string, codes: string[]): string | undefined {
  return codes.find(
    (other) => other.length < code.length && code.startsWith(other),
  );
}

/** 一级科目：编码没有更短前缀编码的科目；推断不出编码的科目原样保留。 */
export function accountTopLevel(accounts: string[]): string[] {
  const codes = accounts
    .map((account) => accountHierarchyCode(account))
    .filter(Boolean);
  if (!codes.length) return accounts;
  return accounts.filter((account) => {
    const code = accountHierarchyCode(account);
    return !code || !strictPrefixParent(code, codes);
  });
}

/** 末级科目：编码不是任何其他科目编码前缀的科目；推断不出编码的科目原样保留。 */
export function accountLeafAccounts(accounts: string[]): string[] {
  const codes = accounts
    .map((account) => accountHierarchyCode(account))
    .filter(Boolean);
  if (!codes.length) return accounts;
  return accounts.filter((account) => {
    const code = accountHierarchyCode(account);
    return (
      !code ||
      !codes.some((other) => other.length > code.length && other.startsWith(code))
    );
  });
}

/** 找编码最长的严格前缀上级（一级科目的人工指定对末级的继承口径）。 */
export function accountNearestParent(
  account: string,
  candidates: string[],
): string | undefined {
  const code = accountHierarchyCode(account);
  if (!code) return undefined;
  let best: string | undefined;
  let bestLength = 0;
  for (const candidate of candidates) {
    const parent = accountHierarchyCode(candidate);
    if (
      parent &&
      parent.length < code.length &&
      code.startsWith(parent) &&
      parent.length > bestLength
    ) {
      best = candidate;
      bestLength = parent.length;
    }
  }
  return best;
}
