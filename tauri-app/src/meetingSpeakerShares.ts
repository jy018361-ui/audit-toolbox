/** Content share uses the original transcript, never the condensed/editable minutes. */
export function meetingSpeakerShares(transcript: string | undefined) {
  const counts: Record<string, number> = {};
  let total = 0;
  let unattributed = 0;
  let currentSpeaker: string | undefined;
  for (const line of (transcript ?? "").split(/\r?\n/)) {
    // Native ASR writes one turn per line, with continuation lines belonging to that turn.
    // Only a turn header assigns a speaker; quoted labels within speech are ordinary content.
    const turn = line.match(/^\s*(?:\[\d+:\d{2}(?::\d{2})?\]\s*)?说话人[ \t]*([1-9]\d{0,2})(?!\d)\s*[:：]\s*/);
    if (turn) currentSpeaker = turn[1];
    else if (/^\s*\[\d+:\d{2}(?::\d{2})?\]/.test(line)) currentSpeaker = undefined;
    const content = (turn ? line.slice(turn[0].length) : line).replace(/^\s*\[\d+:\d{2}(?::\d{2})?\]\s*/, "");
    // Unicode letters/numbers only: punctuation, whitespace, timestamps and labels do not count.
    const length = content.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    total += length;
    if (currentSpeaker) counts[currentSpeaker] = (counts[currentSpeaker] ?? 0) + length;
    else unattributed += length;
  }
  const percentages: Record<string, string> = {};
  if (total) for (const [id, count] of Object.entries(counts)) {
    if (!count) continue;
    const percent = count / total * 100;
    percentages[id] = percent < 0.1 ? "<0.1%" : percent > 99.9 && percent < 100 ? ">99.9%" : `${Math.round(percent * 10) / 10}%`;
  }
  return { percentages, hasUnattributed: unattributed > 0 };
}
