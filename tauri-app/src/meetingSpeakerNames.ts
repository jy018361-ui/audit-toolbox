export type SpeakerNames = Record<string, string>;
const labelPattern = /说话人[ \t]*([1-9]\d{0,2})(?!\d)/g;

export function speakerIds(texts: (string | null | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? "").matchAll(labelPattern)) ids.add(match[1]);
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

export function replaceSpeakerNames(markdown: string, names: SpeakerNames): string {
  return markdown.replace(labelPattern, (label, id: string) => {
    const name = names[id]?.trim();
    // Names are literal text, including inside Markdown tables.
    return name ? name.replace(/[\\`*_{}\[\]()#+\-.!|>~<>]/g, "\\$&") : label;
  });
}
