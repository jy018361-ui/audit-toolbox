import { useEffect, useMemo, useRef, useState } from "react";
import { meetingAudioClose, meetingAudioPlayback, meetingTranscriptSegments } from "../api";
import { meetingErrorText } from "../lib/errors";
import type { SpeakerNames } from "../meetingSpeakerNames";
import type { MeetingTranscriptSegment } from "../types";

type Segment = MeetingTranscriptSegment;

function legacySegments(transcript: string): Segment[] {
  const segments: Segment[] = [];
  for (const line of transcript.trimEnd().split("\n")) {
    const match = /^\[(\d{1,6}:[0-5]\d(?::[0-5]\d)?)\]\s*(?:说话人([1-9]\d{0,2})\s*[:：]\s*)?(.*)$/.exec(line);
    if (!match) {
      if (!segments.length) return [];
      segments[segments.length - 1].text += "\n" + line;
      continue;
    }
    const startMs = match[1].split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000;
    const previous = segments[segments.length - 1];
    if (previous?.startMs != null && previous.startMs < startMs) previous.endMs = startMs;
    segments.push({ startMs, speakerId: match[2] ? Number(match[2]) : undefined, text: match[3] });
  }
  return segments;
}

function formatPosition(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const clock = [Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${clock}` : clock;
}

export function MeetingTranscript({ transcript, path, audioPath, names, preview }: {
  transcript: string; path?: string; audioPath?: string | null; names: SpeakerNames; preview: boolean;
}) {
  const [structured, setStructured] = useState<MeetingTranscriptSegment[]>([]);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const token = useRef<string>(undefined);
  const selected = useRef<Segment>(undefined);
  const mounted = useRef(false);
  const awaitingSource = useRef(false);
  const legacy = useMemo(() => legacySegments(transcript), [transcript]);
  const segments = structured.length ? structured : legacy;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (token.current) void meetingAudioClose(token.current).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    const element = audio.current;
    return () => { element?.pause(); };
  }, [url]);

  useEffect(() => {
    if (!path || preview) return;
    let disposed = false;
    void meetingTranscriptSegments(path).then(rows => {
      if (!disposed) setStructured(rows);
    }).catch(() => { /* Legacy timestamps remain available. */ });
    return () => { disposed = true; };
  }, [path, preview]);

  function start() {
    const element = audio.current;
    const segment = selected.current;
    if (!element || segment?.startMs == null || element.readyState < 1) return;
    if (segment.startMs / 1000 >= element.duration) {
      setError("这段转写的时间超出了录音长度，请检查关联的录音。");
      return;
    }
    element.currentTime = segment.startMs / 1000;
    void element.play().catch(() => {
      if (mounted.current) setError("无法自动播放，请使用播放器的播放按钮。");
    });
  }

  async function listen(segment: Segment) {
    setError("");
    selected.current = segment;
    if (url) {
      audio.current?.pause();
      start();
      return;
    }
    if (!audioPath || awaitingSource.current) return;
    setLoading(true);
    awaitingSource.current = true;
    try {
      const source = await meetingAudioPlayback(audioPath);
      if (mounted.current) {
        token.current = source.token;
        setUrl(source.url);
      } else {
        void meetingAudioClose(source.token).catch(() => undefined);
      }
    } catch (problem) {
      if (mounted.current) setError(meetingErrorText(problem));
    } finally {
      awaitingSource.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  return <article className="meeting-transcript-content" aria-label="原始转写正文">
    {segments.length > 0 && !audioPath && <p className="meeting-watch-hint">这场会议无关联录音，仍可查看转写。</p>}
    {url && <audio ref={audio} src={url} controls preload="metadata" aria-label="会议录音"
      onLoadedMetadata={start}
      onTimeUpdate={event => {
        const element = event.currentTarget;
        const endMs = selected.current?.endMs;
        if (endMs != null && element.currentTime >= endMs / 1000) {
          element.pause();
          selected.current = undefined;
        }
      }}
      onError={() => setError("无法播放这份录音，请检查文件是否可读，或用系统播放器打开。")}
    />}
    {error && <p role="alert" className="meeting-ask-error">{error}</p>}
    {segments.length
      ? <ol className="meeting-transcript-segments">{segments.map((segment, index) => {
        const stamp = segment.startMs == null ? undefined : formatPosition(segment.startMs);
        const speaker = segment.speakerId ? names[String(segment.speakerId)] || `说话人${segment.speakerId}` : "";
        return <li key={index}>
          {stamp && audioPath && !preview
            ? <button type="button" className="meeting-segment-play" aria-label={`试听 ${stamp}，第 ${index + 1} 段`} disabled={loading}
                onClick={() => void listen(segment)}>{stamp}</button>
            : <span>{stamp && <time>{stamp}</time>}</span>}
          <span>{speaker && <strong>{speaker}：</strong>}{segment.text}</span>
        </li>;
      })}</ol>
      : <pre>{transcript || "转写稿暂无正文。"}</pre>}
  </article>;
}
