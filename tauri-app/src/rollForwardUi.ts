export function rollForwardCraWriteRecords(
  records: Array<Record<string, unknown>>,
  enabled: boolean,
): Array<Record<string, unknown>> {
  if (!enabled) return [];
  return records.filter(
    (record) =>
      Boolean(record.apply) && String(record.match_status ?? "") === "将写入",
  );
}

export function parseRollForwardCraRatio(value: unknown): number | undefined {
  const text = String(value ?? "").trim();
  if (!text || ["N/A", "NA"].includes(text.toUpperCase())) return undefined;
  const numeric = Number(text.replaceAll("%", "").replaceAll(",", "").trim());
  if (!Number.isFinite(numeric)) return undefined;
  return text.includes("%") || numeric > 1 ? numeric / 100 : numeric;
}
