import { meetingReadMinutes, meetingSaveMinutes } from "./api";
import { meetingErrorText } from "./lib/errors";
import { replaceSpeakerNames, type SpeakerNames } from "./meetingSpeakerNames";
import { withoutTimelineMarkers } from "./meetingTimeline";

export type MinutesDocument = {
  key: string; path?: string | null; source?: string | null; expected?: string | null;
  names?: SpeakerNames;
  timeline?: boolean;
};
export type MinutesDraft = {
  document: MinutesDocument; body: string; expected: string; names: SpeakerNames;
  savedBody: string; savedNames: SpeakerNames;
  state: "pending" | "saving" | "saved" | "error" | "local";
  error?: string; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>;
};
const sameNames = (a: SpeakerNames, b: SpeakerNames) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Serial writes per exact file; an IPC completion never replaces newer input. */
export class MeetingMinutesAutoSave {
  private drafts = new Map<string, MinutesDraft>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private meetingNames = new Map<string, SpeakerNames>();
  private loading = new Map<string, Promise<void>>();
  readonly loadErrors = new Map<string, string>();
  constructor(private enabled = true, private delay = 450) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private notify() { this.revision++; this.listeners.forEach(listener => listener()); }
  get(key: string) { return this.drafts.get(key); }
  private dirty(draft: MinutesDraft) { return draft.body !== draft.savedBody || !sameNames(draft.names, draft.savedNames); }
  private ensure(document: MinutesDocument): MinutesDraft {
    let draft = this.drafts.get(document.key);
    if (!draft) {
      const body = document.source ?? "";
      draft = { document, body, expected: document.expected ?? body, names: { ...document.names },
        savedBody: body, savedNames: { ...document.names }, state: "saved" };
      this.drafts.set(document.key, draft);
    }
    return draft;
  }
  private schedule(draft: MinutesDraft) {
    clearTimeout(draft.timer);
    draft.error = undefined;
    draft.state = !this.enabled || !draft.document.path ? "local" : this.dirty(draft) ? "pending" : "saved";
    this.notify();
    if (draft.state === "pending") draft.timer = setTimeout(() => { void this.flush(draft.document.key); }, this.delay);
  }
  change(document: MinutesDocument, body: string, names: SpeakerNames) {
    const draft = this.ensure(document);
    draft.body = body;
    draft.names = { ...names };
    this.schedule(draft);
  }
  setNames(meeting: string, names: SpeakerNames, documents: MinutesDocument[]) {
    this.meetingNames.set(meeting, { ...names });
    for (const document of documents) {
      if (document.source != null || this.drafts.has(document.key)) {
        const draft = this.ensure(document);
        draft.names = { ...names };
        this.schedule(draft);
      } else if (document.path && this.enabled && !this.loading.has(document.key)) {
        const loading = (async () => {
          try {
            const loaded = await meetingReadMinutes(document.path!);
            if (loaded.minutesMarkdown == null) throw new Error("纪要文件未返回正文。");
            const source = loaded.sourceMarkdown ?? loaded.minutesMarkdown;
            const draft = this.ensure({ ...document, source: document.timeline ? withoutTimelineMarkers(source) : source,
              expected: loaded.minutesMarkdown, names: loaded.speakerNames });
            draft.names = { ...this.meetingNames.get(meeting) };
            this.loadErrors.delete(document.key);
            this.schedule(draft);
          } catch (error) {
            this.loadErrors.set(document.key, meetingErrorText(error));
            this.notify();
          } finally { this.loading.delete(document.key); }
        })();
        this.loading.set(document.key, loading);
      }
    }
  }
  async flush(key?: string): Promise<void> {
    if (!key) {
      await Promise.all([...this.loading.values()]);
      await Promise.all([...this.drafts.keys()].map(key => this.flush(key)));
      return;
    }
    const draft = this.drafts.get(key);
    if (!draft) return;
    clearTimeout(draft.timer);
    if (draft.running) return draft.running;
    if (!this.enabled || !draft.document.path || !this.dirty(draft)) return;
    draft.running = (async () => {
      while (this.dirty(draft)) {
        draft.state = "saving";
        draft.error = undefined;
        this.notify();
        const body = draft.body;
        const names = { ...draft.names };
        try {
          const saved = await meetingSaveMinutes(draft.document.path!, body, draft.expected, names);
          draft.expected = saved.minutesMarkdown ?? replaceSpeakerNames(body, names);
          draft.savedBody = body;
          draft.savedNames = names;
        } catch (error) {
          draft.state = "error";
          draft.error = meetingErrorText(error);
          this.notify();
          return;
        }
      }
      draft.state = "saved";
      this.notify();
    })().finally(() => { draft.running = undefined; });
    return draft.running;
  }
  async reload(document: MinutesDocument) {
    const draft = this.drafts.get(document.key);
    if (!document.path || draft?.running) return undefined;
    if (draft) clearTimeout(draft.timer);
    const loaded = await meetingReadMinutes(document.path);
    this.drafts.delete(document.key);
    const source = loaded.sourceMarkdown ?? loaded.minutesMarkdown;
    this.ensure({ ...document, source: source != null && document.timeline ? withoutTimelineMarkers(source) : source, expected: loaded.minutesMarkdown, names: loaded.speakerNames });
    this.notify();
    return loaded.speakerNames ?? {};
  }
}
