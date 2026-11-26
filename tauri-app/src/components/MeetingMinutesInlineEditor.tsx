import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { editableMinutesHtml, minutesElementToMarkdown, pastedMinutesHtml, updateMinutesSpeakerDisplays } from "../meetingMinutesEditing";
import type { SpeakerNames } from "../meetingSpeakerNames";
import { proofKey, type proofMatcher } from "../meetingProofreading";

export type MeetingProofEditor = {
  locate: (match: ReturnType<typeof proofMatcher>, key: string, index: number) => void;
  replace: (match: ReturnType<typeof proofMatcher>, key: string) => string | undefined;
};

export function MeetingMinutesInlineEditor({ source, names, shares, onChange, onBlur, readOnly, proofRef }: {
  source: string; names: SpeakerNames; shares: Record<string, string>; onChange: (source: string) => void; onBlur: () => void;
  readOnly?: boolean; proofRef?: Ref<MeetingProofEditor>;
}) {
  const editor = useRef<HTMLElement>(null);
  const lastSource = useRef<string>(undefined);
  const composing = useRef(false);
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element || composing.current) return;
    if (lastSource.current !== source) {
      element.innerHTML = editableMinutesHtml(source, names, shares);
      lastSource.current = source;
    } else {
      updateMinutesSpeakerDisplays(element, names, shares);
    }
  }, [source, names, shares]);
  const input = () => {
    if (!editor.current || composing.current) return;
    const markdown = minutesElementToMarkdown(editor.current);
    lastSource.current = markdown;
    onChange(markdown);
  };
  useImperativeHandle(proofRef, () => ({
    locate(match, key, index) {
      const element = editor.current;
      if (!element) return;
      const hit = match(element).filter(item => proofKey(item) === key)[index];
      if (!hit) return;
      element.focus({ preventScroll: true });
      hit.node.parentElement?.scrollIntoView?.({ block: "center" });
      const range = element.ownerDocument.createRange();
      range.setStart(hit.node, hit.start);
      range.setEnd(hit.node, hit.end);
      const selection = element.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    replace(match, key) {
      const element = editor.current;
      if (!element || composing.current || readOnly) return;
      const hits = match(element).filter(item => proofKey(item) === key);
      if (!hits.length) return;
      for (const hit of hits.reverse()) hit.node.replaceData(hit.start, hit.end - hit.start, hit.preferred);
      const markdown = minutesElementToMarkdown(element);
      lastSource.current = markdown;
      onChange(markdown);
      return markdown;
    },
  }), [onChange, readOnly]);
  return <article ref={editor} className="meeting-minutes-content meeting-inline-editor"
    aria-label="会议纪要正文" aria-description="可直接编辑，修改自动保存" aria-multiline="true"
    tabIndex={0} contentEditable={!readOnly} suppressContentEditableWarning
    onInput={input} onBlur={onBlur}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => {
      composing.current = false;
      if (editor.current) updateMinutesSpeakerDisplays(editor.current, names, shares);
      input();
    }}
    onPaste={event => {
      event.preventDefault();
      if (readOnly) return;
      const html = pastedMinutesHtml(event.clipboardData.getData("text/html"), event.clipboardData.getData("text/plain"));
      if (!window.document.execCommand?.("insertHTML", false, html)) {
        const selection = window.getSelection();
        if (selection?.rangeCount && editor.current?.contains(selection.anchorNode)) {
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const fragment = range.createContextualFragment(html);
          const last = fragment.lastChild;
          range.insertNode(fragment);
          if (last) { range.setStartAfter(last); range.collapse(true); }
        }
      }
      input();
    }} />;
}
