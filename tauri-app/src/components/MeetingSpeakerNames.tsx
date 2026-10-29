import { useEffect, useRef, useState } from "react";
import type { SpeakerNames } from "../meetingSpeakerNames";

function NameField({ id, name, disabled, onCommit }: {
  id: string; name: string; disabled: boolean; onCommit: (id: string, name: string) => void;
}) {
  const [value, setValue] = useState(name);
  const [composing, setComposing] = useState(false);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  useEffect(() => setValue(name), [name]);
  useEffect(() => {
    if (value.trim() === name || composing) return;
    const timer = setTimeout(() => commitRef.current(id, value.trim()), 450);
    return () => clearTimeout(timer);
  }, [value, name, id, composing]);
  const commit = () => {
    const trimmed = value.trim();
    setValue(trimmed);
    if (trimmed !== name) onCommit(id, trimmed);
  };
  return <label className="meeting-speaker-field">
    <span>说话人{id}</span>
    <input aria-label={`说话人${id}姓名`} value={value} maxLength={60} placeholder="填写姓名"
      disabled={disabled} onChange={event => setValue(event.target.value)} onBlur={commit}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={event => { setComposing(false); setValue(event.currentTarget.value); }}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }} />
  </label>;
}

export function MeetingSpeakerNames({ ids, names, disabled, onCommit }: {
  ids: string[]; names: SpeakerNames; disabled: boolean; onCommit: (id: string, name: string) => void;
}) {
  return <section className="meeting-speaker-names" aria-label="说话人姓名对应">
    <h3>说话人姓名</h3>
    <p className="meeting-watch-hint">填写后按回车或移出输入框，立即应用到两版纪要并自动保存。仅对应本次会议，清空姓名可恢复编号。</p>
    <div className="meeting-speaker-grid">{ids.map(id => <NameField key={id} id={id} name={names[id] ?? ""}
      disabled={disabled} onCommit={onCommit} />)}</div>
  </section>;
}
