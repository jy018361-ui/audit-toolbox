import { useLayoutEffect, useRef } from "react";
import { editableMinutesHtml, minutesElementToMarkdown, pastedMinutesHtml } from "../meetingMinutesEditing";
import type { SpeakerNames } from "../meetingSpeakerNames";

export function MeetingMinutesInlineEditor({ source, names, onChange, onBlur }: {
  source: string; names: SpeakerNames; onChange: (source: string) => void; onBlur: () => void;
}) {
  const editor = useRef<HTMLElement>(null);
  const lastSource = useRef<string>(undefined);
  const composing = useRef(false);
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element || composing.current) return;
    if (lastSource.current !== source) {
      element.innerHTML = editableMinutesHtml(source, names);
      lastSource.current = source;
    } else {
      element.querySelectorAll<HTMLElement>("[data-meeting-speaker]").forEach(span => {
        if (span.textContent !== span.dataset.speakerDisplay) return;
        const display = names[span.dataset.meetingSpeaker!] || span.dataset.speakerLabel || "";
        if (span.textContent !== display) span.textContent = display;
        span.dataset.speakerDisplay = display;
      });
    }
  }, [source, names]);
  const input = () => {
    if (!editor.current || composing.current) return;
    const markdown = minutesElementToMarkdown(editor.current);
    lastSource.current = markdown;
    onChange(markdown);
  };
  return <article ref={editor} className="meeting-minutes-content meeting-inline-editor"
    aria-label="会议纪要正文" aria-description="可直接编辑，修改自动保存" aria-multiline="true"
    tabIndex={0} contentEditable suppressContentEditableWarning
    onInput={input} onBlur={onBlur}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; input(); }}
    onPaste={event => {
      event.preventDefault();
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
