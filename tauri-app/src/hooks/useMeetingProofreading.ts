import { useEffect, useMemo, useState } from "react";
import { meetingVocabularyList, meetingVocabularyRemember } from "../api";
import { meetingErrorText } from "../lib/errors";
import { editableMinutesHtml } from "../meetingMinutesEditing";
import { confirmationKey, proofMatcher, proofTasks, type ProofTask } from "../meetingProofreading";
import type { MeetingVocabularyEntry } from "../types";

function readConfirmations(key: string) {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (Array.isArray(values)) return values.filter((value): value is string => typeof value === "string");
  } catch { /* Browser storage may be unavailable. */ }
  return [];
}

export function useMeetingProofreading(documentKey: string, source: string | null | undefined, enabled: boolean, pathname: string) {
  const [entries, setEntries] = useState<MeetingVocabularyEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, string[]>>({});
  const key = `meeting-proofreading-v1:${documentKey}`;
  const confirmed = useMemo(() => decisions[key] ?? readConfirmations(key), [decisions, key]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setError("");
    setLoading(true);
    void meetingVocabularyList().then(items => {
      if (!disposed) setEntries(items);
    }).catch(problem => {
      if (!disposed) setError(meetingErrorText(problem));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, [enabled, pathname]);

  const match = useMemo(() => proofMatcher(entries), [entries]);
  const tasks = useMemo(() => {
    if (!source || !entries.length || !enabled) return [];
    const root = new DOMParser().parseFromString(editableMinutesHtml(source, {}), "text/html").body;
    return proofTasks(match(root));
  }, [source, entries, enabled, match]);
  const pending = tasks.filter(task => !confirmed.includes(confirmationKey(task))).length;

  function confirm(task: ProofTask, resolved: boolean) {
    const id = confirmationKey(task);
    const current = confirmed.filter(value => value !== id);
    const next = resolved ? [...current, id].slice(-2000) : current;
    setDecisions(previous => ({ ...previous, [key]: next }));
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep the current page usable. */ }
  }

  async function remember(task: ProofTask) {
    const items = await meetingVocabularyRemember(task.entry.id, task.observed);
    setEntries(items);
  }

  return { match, tasks, pending, confirmed, confirm, remember, loading, error };
}
