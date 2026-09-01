/**
 * 界面只展示文件名，完整路径仍留在状态中供读取、导出和打开文件使用。
 * 同时兼容 Windows、POSIX 路径与末尾多余的分隔符。
 */
export function displayFileName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized;
}
