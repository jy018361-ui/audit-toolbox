const SENTENCE_PATTERN = /[^。！？；\n]+[。！？；]?/g;

/**
 * 合并同一行内连续或重复出现的完整句子，避免后端批量错误把同一句话
 * 重复十几次后直接淹没主要操作。不同文件/条目的换行结构会保留。
 */
export function dedupeRepeatedText(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  let duplicateCount = 0;
  const lines = normalized
    .split("\n")
    .map((line) => {
      const sentences = line.match(SENTENCE_PATTERN)?.map((item) => item.trim()).filter(Boolean);
      if (!sentences?.length) return line.trim();

      const seen = new Set<string>();
      const kept: string[] = [];
      for (const sentence of sentences) {
        const key = sentence
          .replace(/[。！？；]+$/u, "")
          .replace(/^[^：\n]{1,24}：/u, "")
          .replace(/\s+/g, " ")
          .trim();
        if (seen.has(key)) {
          duplicateCount += 1;
          continue;
        }
        seen.add(key);
        kept.push(sentence);
      }
      return kept.join("");
    })
    .filter(Boolean);

  if (duplicateCount) lines.push(`（已合并 ${duplicateCount} 条重复信息）`);
  return lines.join("\n");
}

export function isVerboseText(value: string, maxLength = 240, maxLines = 3): boolean {
  return value.length > maxLength || value.split("\n").length > maxLines;
}

export function textPreview(value: string, maxLength = 220): string {
  if (value.length <= maxLength) return value;
  const candidate = value.slice(0, maxLength);
  const punctuation = Math.max(
    candidate.lastIndexOf("。"),
    candidate.lastIndexOf("！"),
    candidate.lastIndexOf("？"),
    candidate.lastIndexOf("；"),
    candidate.lastIndexOf("\n"),
  );
  const end = punctuation >= Math.floor(maxLength * 0.55) ? punctuation + 1 : maxLength;
  return `${candidate.slice(0, end).trimEnd()}…`;
}
