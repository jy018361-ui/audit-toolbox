import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  jobStart,
  listenMeetingEvents,
  meetingRecordStart,
  meetingRecordStop,
} from "@/api";
import { errorText } from "@/lib/errors";
import type { MeetingRecordStart } from "@/types";
import "../meeting-minutes.css";

/** Teams 会议检测的全局交互：询问弹窗、录音指示、结束后自动出纪要。
 *
 * 挂在 App 根部（不随页面切换卸载）——会议可能在任何页面时开始。
 * 「本次不记录」只压制当前这场会：通话结束即恢复询问。 */

async function notifyDesktop(title: string, body: string) {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // 通知失败不影响主流程：应用内弹窗仍会照常出现。
  }
}

function focusMainWindow() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  // 后台常驻时窗口可能藏在托盘，先显示再聚焦。
  getCurrentWebviewWindow()
    .show()
    .catch(() => undefined);
  getCurrentWebviewWindow()
    .setFocus()
    .catch(() => undefined);
}

function elapsedText(startedAt: string) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function MeetingWatch() {
  const [askOpen, setAskOpen] = useState(false);
  const [askError, setAskError] = useState("");
  const [starting, setStarting] = useState(false);
  const [recording, setRecording] = useState<MeetingRecordStart>();
  const [stopping, setStopping] = useState(false);
  const [tick, setTick] = useState(0);
  // 「本次不记录」：通话结束前不再询问，结束后自动恢复。
  const suppressed = useRef(false);
  const recordingRef = useRef<MeetingRecordStart | undefined>(undefined);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listenMeetingEvents((event) => {
      if (event.type === "call_started") {
        if (recordingRef.current || suppressed.current) return;
        setAskError("");
        setAskOpen(true);
        focusMainWindow();
        void notifyDesktop(
          "检测到 Teams 会议",
          "工具箱已就绪，点击窗口确认是否开始记录会议纪要。",
        );
      } else if (event.type === "call_ended") {
        suppressed.current = false;
        const active = recordingRef.current;
        if (!active) return;
        // 会议结束：自动停止录音并直接进入转写与纪要生成。
        setStopping(true);
        void meetingRecordStop()
          .then((stopped) => {
            setRecording(undefined);
            void notifyDesktop(
              "会议结束，录音已保存",
              `时长约 ${Math.round(stopped.durationSec / 60)} 分钟，正在转写并生成纪要。`,
            );
            return jobStart("meeting.generate", {
              audioPath: stopped.audioPath,
              title: `Teams 会议 ${new Date(stopped.startedAt).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}`,
            });
          })
          .catch((error) => {
            setRecording(undefined);
            void notifyDesktop("会议纪要", `录音收尾出现问题：${errorText(error)}`);
          })
          .finally(() => setStopping(false));
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function startRecording() {
    if (starting) return;
    setStarting(true);
    setAskError("");
    try {
      const started = await meetingRecordStart();
      setRecording(started);
      setAskOpen(false);
      void notifyDesktop(
        "已开始录制会议",
        "录音将上传阿里云百炼转写，请确认已告知参会人；会议结束后自动生成纪要。",
      );
    } catch (error) {
      setAskError(errorText(error));
    } finally {
      setStarting(false);
    }
  }

  function declineThisCall() {
    suppressed.current = true;
    setAskOpen(false);
  }

  async function stopAndGenerate() {
    if (stopping) return;
    setStopping(true);
    try {
      const stopped = await meetingRecordStop();
      setRecording(undefined);
      await jobStart("meeting.generate", {
        audioPath: stopped.audioPath,
      });
    } catch (error) {
      setAskError(errorText(error));
    } finally {
      setStopping(false);
    }
  }

  return (
    <>
      <Dialog open={askOpen} onOpenChange={setAskOpen}>
        <DialogContent className="meeting-ask-dialog">
          <DialogHeader>
            <DialogTitle>检测到 Teams 会议</DialogTitle>
            <DialogDescription>
              是否开始记录会议纪要？录音将上传阿里云百炼进行语音转写，
              请确认已告知参会人本次会议将录音。
            </DialogDescription>
          </DialogHeader>
          {askError && (
            <p role="alert" className="meeting-ask-error">
              {askError}
            </p>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={declineThisCall}>
              本次不记录
            </Button>
            <Button onClick={() => void startRecording()} disabled={starting}>
              {starting ? "正在启动…" : "开始记录"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {recording && (
        <div
          className="meeting-recording-capsule"
          role="status"
          aria-live="polite"
          data-tick={tick}
        >
          <span className="meeting-recording-dot" aria-hidden="true" />
          <span className="meeting-recording-text">
            正在录制会议 {elapsedText(recording.startedAt) || "…"}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void stopAndGenerate()}
            disabled={stopping}
          >
            {stopping ? "正在收尾…" : "停止并生成纪要"}
          </Button>
        </div>
      )}
    </>
  );
}
