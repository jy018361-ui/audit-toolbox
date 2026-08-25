/// 回函 PDF 转 Excel：页面与测试共用的纯函数和任务结果契约。
/// 结果形状与 Rust 侧 pdf2excel.convert 的返回（camelCase JSON）一一对应。

export type PdfConvertFileResult = {
  name: string;
  status: string;
  pages: number;
  textRows: number;
  tables: number;
  tableDataRows: number;
  outputPath: string;
  error: string;
};

export type PdfConvertResult = {
  files: PdfConvertFileResult[];
  manifestPath: string;
  successCount: number;
  failCount: number;
  outputPaths: string[];
};

export type PdfFileResultsSummary = {
  total: number;
  successCount: number;
  failCount: number;
  totalPages: number;
  totalTextRows: number;
  totalTables: number;
  totalTableDataRows: number;
};

/// 大小写不敏感的 .pdf 判定；对完整路径同样成立（路径后缀即文件名后缀）。
export function isPdfFile(name: string): boolean {
  return name.trim().toLocaleLowerCase().endsWith(".pdf");
}

/// Windows 路径不区分大小写：去重按小写比较，保留首次出现的顺序。
export function dedupePdfPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = path.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

/// 文件夹展开（excel_merger.expand_paths）返回的是全部文件：只留 PDF 并去重。
export function filterPdfPaths(paths: string[]): string[] {
  return dedupePdfPaths(paths.filter((path) => isPdfFile(path)));
}

/// 从完整路径取文件名，兼容 Windows 反斜杠与正斜杠。
export function pdfFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/// 后端契约 status 为 "成功"/"失败"；失败行会同时带 error 文案。
/// 以 error 为准做二次判定，避免后端状态词波动时把失败行染成成功色。
export function isSuccessfulFileResult(row: PdfConvertFileResult): boolean {
  return (
    !String(row.error ?? "").trim() &&
    row.status !== "失败" &&
    row.status !== "failed"
  );
}

export function fileStatusLabel(row: PdfConvertFileResult): string {
  return isSuccessfulFileResult(row) ? "成功" : "失败";
}

/// 结果表状态列的 pill 语义 class（对应 styles.css 的 .pill.ready / .pill.danger）。
export function fileStatusPill(row: PdfConvertFileResult): string {
  return isSuccessfulFileResult(row) ? "pill ready" : "pill danger";
}

/// 数字字段做 Number 兜底：个别行缺字段时汇总不产生 NaN。
export function summarizeFileResults(
  files: PdfConvertFileResult[],
): PdfFileResultsSummary {
  const summary: PdfFileResultsSummary = {
    total: files.length,
    successCount: 0,
    failCount: 0,
    totalPages: 0,
    totalTextRows: 0,
    totalTables: 0,
    totalTableDataRows: 0,
  };
  for (const row of files) {
    if (isSuccessfulFileResult(row)) summary.successCount += 1;
    else summary.failCount += 1;
    summary.totalPages += Number(row.pages ?? 0) || 0;
    summary.totalTextRows += Number(row.textRows ?? 0) || 0;
    summary.totalTables += Number(row.tables ?? 0) || 0;
    summary.totalTableDataRows += Number(row.tableDataRows ?? 0) || 0;
  }
  return summary;
}

export function summarizeFileResultsText(summary: PdfFileResultsSummary): string {
  return (
    `共 ${summary.total} 份：成功 ${summary.successCount}、失败 ${summary.failCount}` +
    ` · 合计 ${summary.totalPages} 页、正文 ${summary.totalTextRows} 行` +
    `、表格 ${summary.totalTables} 个（${summary.totalTableDataRows} 行数据）`
  );
}

/// 任务 completed 事件的 result 守卫：形状不对就不当结果渲染。
export function isPdfConvertResult(value: unknown): value is PdfConvertResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PdfConvertResult>;
  return Array.isArray(item.files) && typeof item.manifestPath === "string";
}
