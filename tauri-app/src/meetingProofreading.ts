import type { MeetingVocabularyEntry } from "./types";

type Rule = { entry: MeetingVocabularyEntry; preferred: string };
export type ProofHit = Rule & { observed: string; node: Text; start: number; end: number; context: string };
export type ProofTask = Rule & { observed: string; key: string; contexts: string[] };

const fold = (value: string) => value.normalize("NFKC").toLowerCase();
const acronymKey = (value: string) => fold(value).replace(/[. \t]/g, "");
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = "[A-Za-z0-9_Ａ-Ｚａ-ｚ０-９＿]";
const wordCharacter = new RegExp(word, "u");
const boundary = (pattern: string) => `(?<!${word})(?:${pattern})(?!${word})`;

function acronymPattern(value: string) {
  const symbols = [...value].map(letter => `[${letter}${String.fromCharCode(letter.charCodeAt(0) + 0xfee0)}]`);
  return boundary(symbols.join("[.． \t　]*"));
}

export function proofMatcher(entries: MeetingVocabularyEntry[]) {
  const exact = new Map<string, Rule | null>();
  const acronyms = new Map<string, Rule | null>();
  const patterns: { pattern: string; length: number }[] = [];
  for (const entry of entries) {
    if (!entry.enabled) continue;
    for (const preferred of [entry.term, ...entry.aliases]) {
      const normalized = preferred.normalize("NFKC");
      if (/^[A-Z][A-Z0-9]{1,11}$/.test(normalized)) {
        const key = acronymKey(normalized);
        if (!acronyms.has(key)) patterns.push({ pattern: acronymPattern(normalized), length: normalized.length });
        acronyms.set(key, acronyms.has(key) ? null : { entry, preferred });
      }
    }
    for (const observed of [entry.term, ...entry.aliases, ...(entry.misspellings ?? [])]) {
      const normalized = fold(observed);
      const preferred = entry.misspellings?.includes(observed) ? entry.term : observed;
      if (!exact.has(normalized)) {
        const literal = [...normalized].map(letter => /[a-z0-9]/i.test(letter)
          ? `[${letter}${String.fromCharCode(letter.charCodeAt(0) + 0xfee0)}]` : escape(letter)).join("");
        patterns.push({ pattern: /^[a-z0-9]/.test(normalized) && /[a-z0-9]$/.test(normalized) ? boundary(literal) : literal,
          length: normalized.length });
      }
      exact.set(normalized, exact.has(normalized) ? null : { entry, preferred });
    }
  }
  const pattern = patterns.length ? new RegExp(patterns.sort((a, b) => b.length - a.length).map(item => item.pattern).join("|"), "giu") : undefined;
  return (root: Element): ProofHit[] => {
    if (!pattern) return [];
    const hits: ProofHit[] = [];
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.parentElement?.closest("[data-meeting-speaker],pre")) continue;
      for (const match of node.data.matchAll(pattern)) {
        let observed = match[0];
        const normalized = fold(observed);
        const known = exact.has(normalized);
        const rule = known ? exact.get(normalized) : acronyms.get(acronymKey(observed));
        if (!rule || observed === rule.preferred) continue;
        const start = match.index;
        const following = start + observed.length;
        if (!known && /[.．]/.test(observed) && /[.．]/.test(node.data[following] ?? "")) {
          if (wordCharacter.test(node.data[following + 1] ?? "")) continue;
          observed += node.data[following];
        }
        const end = start + observed.length;
        const text = node.parentElement?.closest("p,li,td,th,h1,h2,h3,h4,h5,h6");
        // Include nearby inline content when a standalone run contains only the term.
        const context = node.data.length > observed.length
          ? node.data.slice(Math.max(0, start - 22), end + 22).trim()
          : (text?.textContent ?? observed).trim().slice(0, 90);
        hits.push({ ...rule, node, start, end, observed, context });
      }
    }
    return hits;
  };
}

export function proofKey(hit: Pick<ProofHit, "entry" | "preferred" | "observed">) {
  return JSON.stringify([hit.entry.id, hit.preferred, hit.observed]);
}

export function proofTasks(hits: ProofHit[]): ProofTask[] {
  const tasks = new Map<string, ProofTask>();
  for (const hit of hits) {
    const key = proofKey(hit);
    const existing = tasks.get(key);
    if (existing) existing.contexts.push(hit.context);
    else tasks.set(key, { entry: hit.entry, preferred: hit.preferred, observed: hit.observed, key, contexts: [hit.context] });
  }
  return [...tasks.values()];
}

export function confirmationKey(task: ProofTask) {
  let hash = 2166136261;
  for (const character of JSON.stringify(task.contexts)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${task.key}:${hash >>> 0}`;
}
