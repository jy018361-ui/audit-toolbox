// 正负数凭证标记的可单测决策逻辑。页面交互在 JeSignMarkPage，
// 字段映射的判定与看账共用 ledgerMapping，这里只放本工具特有的部分。
import { accountColumns, type Mapping } from "./ledgerMapping";

export type JeMarkBatch = { name: string; accounts: string[] };

/** 漏斗挂在哪一列：科目由多列拼成时挂第一列，面板标题注明拼接来源。 */
export function accountFilterColumn(mapping: Mapping, headers: string[]): string | undefined {
  const mapped = accountColumns(mapping);
  return headers.find((header) => mapped.includes(header.trim()));
}

/** 科目由几列拼成，面板标题要说清楚，否则用户不明白列出来的为什么是组合值。 */
export function accountFilterTitle(mapping: Mapping): string {
  const mapped = accountColumns(mapping);
  if (mapped.length > 1) return `目标科目（由 ${mapped.join("、")} 拼接）`;
  return "目标科目";
}

/** 该列是不是科目列——科目走批次维度，其余列走全局数据过滤，两者不能混。 */
export function isAccountColumn(mapping: Mapping, header: string): boolean {
  return accountColumns(mapping).includes(header.trim());
}

export const newBatch = (index: number): JeMarkBatch => ({ name: `批次${index + 1}`, accounts: [] });

/** 新增批次后自动切过去，选择从空开始重新选。 */
export function addBatch(batches: JeMarkBatch[]): { batches: JeMarkBatch[]; activeBatch: number } {
  return { batches: [...batches, newBatch(batches.length)], activeBatch: batches.length };
}

/** 只剩一个批次时删除等于清空它，避免出现零批次的空状态。 */
export function removeBatch(
  batches: JeMarkBatch[],
  activeBatch: number,
): { batches: JeMarkBatch[]; activeBatch: number } {
  if (batches.length === 1) return { batches: [{ ...batches[0], accounts: [] }], activeBatch: 0 };
  return {
    batches: batches.filter((_, index) => index !== activeBatch),
    activeBatch: Math.max(0, activeBatch - 1),
  };
}

/** 某科目已经在别的批次里选过——面板上标一下，避免无意重复选。 */
export function batchesContaining(
  batches: JeMarkBatch[],
  activeBatch: number,
  account: string,
): string[] {
  return batches
    .filter((batch, index) => index !== activeBatch && batch.accounts.includes(account))
    .map((batch) => batch.name);
}

/** 空批次不导出；一个有效批次都没有时不该让用户点导出。 */
export const validJeMarkBatches = (batches: JeMarkBatch[]) =>
  batches.filter((batch) => batch.name.trim() && batch.accounts.length);

/**
 * 科目字段一变，已选的目标科目就可能对不上新口径，全部清空重选。
 * 留着旧选择比清空更危险：它看起来仍然有效，实际标不出东西。
 */
export function clearAccountsOnMappingChange(batches: JeMarkBatch[]): JeMarkBatch[] {
  return batches.map((batch) => ({ ...batch, accounts: [] }));
}

/** 科目映射的比较键；顺序变化也算变化，因为拼接值会跟着变。 */
export const accountMappingKey = (mapping: Mapping) => accountColumns(mapping).join("|");

/** 已生效的列筛选，供导出参数和界面摘要共用。 */
export function activeColumnFilters(
  selections: Record<string, string[]>,
): { field: string; values: string[] }[] {
  return Object.entries(selections)
    .map(([field, values]) => ({ field, values: [...new Set(values)] }))
    .filter((entry) => entry.field && entry.values.length);
}

/** 默认文件名：正负数标记_<源文件名>[_工作表<Sheet>]_<时间戳>.csv */
export function defaultJeMarkOutputName(inputPath: string, sheet: string, now = new Date()): string {
  const stem = (inputPath.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "").trim() || "未命名";
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const parts = ["正负数标记", stem];
  if (sheet.trim()) parts.push(`工作表${sheet.trim()}`);
  parts.push(stamp);
  return `${parts.join("_").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_")}.csv`;
}

/** 默认落点：凭证文件旁边，导出前就让用户知道会写到哪。 */
export function defaultJeMarkOutputPath(inputPath: string, sheet: string, now = new Date()): string {
  const index = Math.max(inputPath.lastIndexOf("\\"), inputPath.lastIndexOf("/"));
  if (index < 0) return "";
  const directory = index === 2 && inputPath[1] === ":" ? inputPath.slice(0, 3) : inputPath.slice(0, index);
  const separator = directory.endsWith("\\") || directory.endsWith("/") ? "" : "\\";
  return `${directory}${separator}${defaultJeMarkOutputName(inputPath, sheet, now)}`;
}
