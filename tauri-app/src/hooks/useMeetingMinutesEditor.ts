import { useEffect, useRef, useSyncExternalStore } from "react";
import { confirmDialog } from "../components/ConfirmDialog";
import { MeetingMinutesAutoSave, type MinutesDocument } from "../meetingMinutesAutoSave";
import type { SpeakerNames } from "../meetingSpeakerNames";
import { useLocation } from "react-router-dom";

export function useMeetingMinutesEditor(document: MinutesDocument, names: SpeakerNames, enabled: boolean) {
  const { pathname } = useLocation();
  const storeRef = useRef<MeetingMinutesAutoSave>(null);
  storeRef.current ??= new MeetingMinutesAutoSave(enabled);
  const store = storeRef.current;
  useSyncExternalStore(store.subscribe, store.snapshot);
  const draft = store.get(document.key);
  useEffect(() => () => { void store.flush(); }, [store, document.key, pathname]);
  useEffect(() => {
    const flush = () => { if (window.document.visibilityState === "hidden") void store.flush(); };
    window.document.addEventListener("visibilitychange", flush);
    return () => window.document.removeEventListener("visibilitychange", flush);
  }, [store]);
  return {
    body: draft?.body ?? document.source,
    state: draft?.state,
    error: draft?.error,
    change: (body: string) => store.change(document, body, names),
    flush: () => { void store.flush(); },
    retry: () => { void store.flush(); },
    setNames: (meeting: string, next: SpeakerNames, documents: MinutesDocument[]) => store.setNames(meeting, next, documents),
    errorsFor: (documents: MinutesDocument[]) => documents.flatMap(doc => {
      const error = store.get(doc.key)?.error ?? store.loadErrors.get(doc.key);
      return error ? [error] : [];
    }),
    reload: async () => {
      if (!await confirmDialog({ title: "重新载入纪要文件？", message: "当前版本尚未保存的修改将被文件内容替换。", confirmLabel: "重新载入" })) return;
      return store.reload(document);
    },
  };
}
