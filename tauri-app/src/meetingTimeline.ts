/** Remove recording-position labels, not actual meeting times or deadlines. */
export function withoutTimelineMarkers(markdown: string): string {
  const time = String.raw`\d{1,3}:[0-5]\d(?::[0-5]\d)?(?:[.,]\d{1,3})?`;
  const bracket = new RegExp(String.raw`[\[【]\s*${time}(?:\s*[-–—~至]\s*${time})?\s*[\]】][ \t]*`, "g");
  return markdown.split("\n").map(line => {
    const stripped = line.replace(bracket, "");
    return stripped.replace(new RegExp(String.raw`^((?:\s{0,3}#{1,6}\s+|\s*[-*+]\s+|\s*\d+[.)]\s+)?)(?:${time})(?:\s*[-–—~至]\s*${time})?[ \t]+(?=\S)`), "$1");
  }).join("\n");
}
