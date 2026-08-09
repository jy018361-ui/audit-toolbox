export type FileListPreviewRow = {
  name: string;
  relativePath: string;
  fullPath: string;
  levels: string[];
};

export type FileListScan = {
  sourceDir: string;
  rootName: string;
  fileCount: number;
  maxDepth: number;
  preview: FileListPreviewRow[];
  previewLimit: number;
  outputPath: string;
  /// Directories the scan could not read.  They are skipped rather than
  /// aborting the run, so the list has to say which ones are missing.
  skippedPaths?: string[];
};

export function isFileListScan(value: unknown): value is FileListScan {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<FileListScan>;
  return (
    typeof item.sourceDir === "string" &&
    typeof item.fileCount === "number" &&
    typeof item.maxDepth === "number" &&
    typeof item.outputPath === "string" &&
    Array.isArray(item.preview)
  );
}

export function fileListCanExport(sourceDir: string, outputPath: string) {
  return Boolean(sourceDir.trim() && outputPath.trim());
}

