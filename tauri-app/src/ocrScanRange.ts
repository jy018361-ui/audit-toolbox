/** 将用户输入的扫描页码转换为去重、升序的实际页码。 */
export function parseOcrScanRange(
  input: string,
  totalPages: number,
  clip = false,
): number[] {
  if (!Number.isSafeInteger(totalPages) || totalPages <= 0) {
    throw new Error("文件总页数尚未确定，请等待文件加载完成。");
  }

  let normalized = input.trim();
  if (!normalized) {
    throw new Error("请输入扫描页码，例如 2-5 或 1,3-5。");
  }
  normalized = normalized
    .replace(/[，、]/g, ",")
    .replace(/[‐‑‒–—―−﹣－]/g, "-")
    .replace(/^第\s*/, "")
    .replace(/\s*页$/, "")
    .trim();

  const ranges = normalized.split(",").map((token): [number, number] => {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token.trim());
    if (!match) {
      throw new Error(
        "页码格式不正确，请输入正整数页码或范围，例如 2-5 或 1,3-5。",
      );
    }
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start <= 0 ||
      end <= 0
    ) {
      throw new Error("页码必须是有效的正整数。");
    }
    if (start > end) {
      throw new Error("扫描页码范围的起始页不能大于结束页。");
    }
    if (end > totalPages && !clip) {
      throw new Error(`扫描页码超出文件范围，当前文件共 ${totalPages} 页。`);
    }
    return [start, end];
  });

  const pages = new Set<number>();
  for (const [start, end] of ranges) {
    for (let page = start; page <= Math.min(end, totalPages); page += 1) {
      pages.add(page);
    }
  }
  return [...pages].sort((left, right) => left - right);
}
