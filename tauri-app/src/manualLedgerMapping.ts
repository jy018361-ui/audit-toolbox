type Mapping = Record<string, unknown>;
const KEY = "__manualAuxiliary";
const ROLES = ["auxiliary", "loanId"] as const;
const columns = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()) :
    typeof value === "string" && value.trim() ? [value] : [];

function confirmations(mapping: Mapping): Record<string, string[]> {
  try {
    const value = JSON.parse(String(mapping[KEY] ?? "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function manualAuxiliaryColumns(mapping: Mapping, role = "auxiliary"): string[] {
  const confirmed = columns(confirmations(mapping)[role]);
  return columns(mapping[role]).filter((column) => confirmed.includes(column));
}

/** 只在实际手选时记录；自动识别、LLM 自动建议不会取得人工确认。 */
export function recordManualLedgerMapping<T extends Mapping>(
  previous: Mapping, next: T, column: string, role: string,
): T {
  const confirmed: Record<string, string[]> = {};
  for (const tracked of ROLES) {
    const selected = columns(next[tracked]);
    const held = manualAuxiliaryColumns(previous, tracked).filter((v) => selected.includes(v));
    if (role === tracked && selected.includes(column) && !held.includes(column)) held.push(column);
    if (held.length) confirmed[tracked] = held;
  }
  const result = { ...next } as Mapping;
  if (Object.keys(confirmed).length) result[KEY] = JSON.stringify(confirmed);
  else delete result[KEY];
  return result as T;
}
