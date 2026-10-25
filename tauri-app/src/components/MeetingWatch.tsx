import { useEffect, useRef, useState } from "react";
import {
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
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
  listenMeetingAskChoice,
  listenMeetingEvents,
  listenJobEvents,
  meetingRecordStart,
  meetingRecordStop,
  meetingStatus,
  openOutput,
} from "../api";
import { terminalJobError } from "./JobProgress";
import { meetingErrorText as errorText } from "@/lib/errors";
import type { JobEvent, MeetingEvent, MeetingRecordStart, MeetingRecordStop } from "../types";
import type { MeetingResult } from "../MeetingMinutesPage";
import "../meeting-minutes.css";

/** Teams 会议检测的全局交互：询问小窗、录音指示、结束后自动出纪要。
 *
 * 挂在 App 根部（不随页面切换卸载）——会议可能在任何页面时开始。
 * 「本次不记录」只压制当前这场会：通话结束即恢复询问。
 * 录音的开始/结束由 Rust 检测层统一广播（recording_started / stopped /
 * auto_finished），这里只消费事件，不再自己记账。 */

async function notifyDesktop(title: string, body: string) {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // 通知失败不影响主流程：询问小窗仍会照常出现。
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

/** 询问改用置顶小窗：不再把整个工具箱主窗口拉到用户面前。
 *  无边框 + 透明底，视觉只剩一张居中卡片；拖拽靠卡片标题区。
 *  小窗创建失败（权限/平台限制）时降级回应用内弹窗。 */
async function openAskWindow() {
  const existing = await WebviewWindow.getByLabel("meeting-ask");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }
  const ask = new WebviewWindow("meeting-ask", {
    url: "/#/meeting-ask",
    title: "会议记录询问",
    width: 440,
    height: 260,
    resizable: false,
    decorations: false,
    transparent: true,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    focus: true,
  });
  await new Promise<void>((resolve, reject) => {
    void ask.once("tauri://created", () => resolve());
    void ask.once("tauri://error", (event) => reject(event.payload));
  });
}

async function closeAskWindow() {
  try {
    const existing = await WebviewWindow.getByLabel("meeting-ask");
    await existing?.close();
  } catch {
    // 小窗可能已自行关闭。
  }
}

function elapsedText(startedAt: string) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function MeetingWatch() {
  // 应用内弹窗只作为小窗创建失败的降级形态。
  const [askOpen, setAskOpen] = useState(false);
  const [askError, setAskError] = useState("");
  const [starting, setStarting] = useState(false);
  const [recording, setRecording] = useState<MeetingRecordStart>();
  const [stopping, setStopping] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [tick, setTick] = useState(0);
  const [latestJob, setLatestJob] = useState<JobEvent>();
  const [processingError, setProcessingError] = useState("");
  // 「本次不记录」：通话结束前不再询问，结束后自动恢复。
  const suppressed = useRef(false);
  const recordingRef = useRef<MeetingRecordStart | undefined>(undefined);
  const askGeneration = useRef(0);
  const jobVersion = useRef(0);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenJobEvents((event) => {
      if (disposed || event.toolId !== "meeting_minutes") return;
      setFinalizing(false);
      jobVersion.current += 1;
      setLatestJob(event);
      setProcessingError("");
      if (event.phase === "completed") {
        const result = event.result as MeetingResult | undefined;
        void notifyDesktop(
          result?.minutesPath ? "会议纪要已生成" : "会议纪要需要处理",
          result?.minutesError || (result?.minutesPath ? (result.minutesVersions ? "按内容、按时间两个版本及转写稿已保存，可在工具箱中查看。" : "会议纪要和转写稿已保存，可在工具箱中打开。") : "任务结束但未返回会议纪要，请查看任务结果。"),
        );
      } else if (event.phase === "failed" || event.phase === "cancelled") {
        void notifyDesktop("会议纪要未生成", terminalJobError(event));
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, []);

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
    let receivedEvent = false;
    const handleEvent = (event: MeetingEvent) => {
      if (disposed) return;
      receivedEvent = true;
      if (event.type === "call_started") {
        if (recordingRef.current || suppressed.current) return;
        const generation = ++askGeneration.current;
        setAskError("");
        void notifyDesktop(
          "检测到 Teams 会议",
          "工具箱已就绪，请在弹出的询问窗口确认是否开始记录会议纪要。",
        );
        openAskWindow().then(() => {
          if (disposed || generation !== askGeneration.current) void closeAskWindow();
        }).catch(() => {
          if (disposed || generation !== askGeneration.current) return;
          // 降级：应用内弹窗 + 拉起主窗口，功能不能因为小窗失败而丢失。
          setAskOpen(true);
          focusMainWindow();
        });
      } else if (event.type === "call_ended") {
        askGeneration.current += 1;
        suppressed.current = false;
        setAskOpen(false);
        // 询问还没答，会议就结束了：小窗一并收掉。
        void closeAskWindow();
        if (recordingRef.current) {
          recordingRef.current = undefined;
          setRecording(undefined);
          setFinalizing(true);
        }
        // 录音收尾由 Rust 检测层完成（recording_auto_finished），
        // 无论录音从询问小窗还是工具页开始都会被照顾到。
      } else if (event.type === "recording_started") {
        setFinalizing(false);
        const parsed = pickStartSummary(event.summary);
        if (parsed) {
          recordingRef.current = parsed;
          setRecording(parsed);
          setProcessingError("");
          // 开录即提示设备疑点（如退回默认设备、麦克风换了非默认设备）：
          // 等会议结束才发现没录到声音就晚了，中途还有机会调整设备。
          for (const warning of parsed.warnings) {
            void notifyDesktop("录音质量提醒", warning);
          }
        }
      } else if (event.type === "recording_stopped") {
        setFinalizing(false);
        recordingRef.current = undefined;
        setRecording(undefined);
      } else if (event.type === "recording_auto_finished") {
        setFinalizing(false);
        recordingRef.current = undefined;
        setRecording(undefined);
        const stopped = pickStopSummary(event.summary);
        if (!stopped) return;
        void notifyDesktop(
          "会议结束，录音已保存",
          `时长约 ${Math.round(stopped.durationSec / 60)} 分钟，正在转写并生成纪要。`,
        );
        // 空录体检有疑点时单独再提醒一次：转写多半要空手而归，先讲清原因。
        for (const warning of stopped.warnings) {
          void notifyDesktop("录音质量提醒", warning);
        }
        // 后台已负责启动任务；这里再启动会重复上传、重复计费。
      } else if (event.type === "recording_failed") {
        setFinalizing(false);
        recordingRef.current = undefined;
        setRecording(undefined);
        setProcessingError(event.message ?? "录音收尾出现问题");
        void notifyDesktop(
          "会议纪要",
          event.message ?? "录音收尾出现问题",
        );
      }
    };
    void listenMeetingEvents(handleEvent)
      .then((fn) => {
        if (disposed) fn();
        else {
          unlisten = fn;
          // Rust 检测线程早于 React 挂载。先订阅再读快照，补回启动时
          // 已在会中的状态；期间收到新事件则以事件为准，避免过期快照。
          const version = jobVersion.current;
          void meetingStatus().then((status) => {
            if (disposed) return;
            if (!receivedEvent && status.recordingSummary) {
              recordingRef.current = status.recordingSummary;
              setRecording(status.recordingSummary);
            }
            if (!receivedEvent && version === jobVersion.current) {
              setLatestJob(status.latestJob ?? undefined);
              setProcessingError(status.processingError ?? "");
            }
            if (!disposed && !receivedEvent && status.watchEnabled && status.inCall && !status.recording) {
              handleEvent({ type: "call_started", at: new Date().toISOString() });
            }
          }).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 询问小窗的「本次不记录」。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listenMeetingAskChoice((accepted) => {
      if (!accepted) suppressed.current = true;
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
      setProcessingError(errorText(error));
    } finally {
      setStopping(false);
    }
  }

  const finished = latestJob && ["completed", "failed", "cancelled"].includes(latestJob.phase);
  const result = latestJob?.phase === "completed" ? latestJob.result as MeetingResult | undefined : undefined;
  const resultError = processingError || terminalJobError(latestJob) || result?.minutesError;
  async function openResult(path: string) {
    try { await openOutput(path); }
    catch (error) { setProcessingError(errorText(error)); }
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
          {processingError && <span role="alert">{processingError}</span>}
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
      {finalizing && (
        <div className="meeting-processing-card" role="status" aria-live="polite">
          <strong>会议已结束，正在保存录音…</strong>
        </div>
      )}
      {!recording && !finalizing && (processingError || finished) && (
        <div className="meeting-processing-card" role={resultError ? "alert" : "status"}>
          <strong>{result?.minutesPath ? "会议纪要已生成" : "会议纪要未生成"}</strong>
          {resultError && <p>{resultError}</p>}
          <div className="meeting-result-actions">
            {result?.minutesVersions ? result.minutesVersions.filter((version) => version.minutesPath).map((version) => (
              <Button key={version.kind} size="sm" onClick={() => void openResult(version.minutesPath!)}>打开{version.label}版纪要</Button>
            )) : result?.minutesPath && <Button size="sm" onClick={() => void openResult(result.minutesPath!)}>打开会议纪要</Button>}
            {result?.transcriptPath && <Button size="sm" variant="secondary" onClick={() => void openResult(result.transcriptPath!)}>打开转写稿</Button>}
            <Button size="sm" variant="ghost" onClick={() => { setLatestJob(undefined); setProcessingError(""); }}>关闭提示</Button>
          </div>
        </div>
      )}
    </>
  );
}

function pickStartSummary(
  summary: Record<string, unknown> | undefined,
): MeetingRecordStart | undefined {
  if (!summary) return undefined;
  const startedAt = typeof summary.startedAt === "string" ? summary.startedAt : "";
  if (!startedAt) return undefined;
  return {
    startedAt,
    recordDir: typeof summary.recordDir === "string" ? summary.recordDir : "",
    systemOk: summary.systemOk === true,
    micOk: summary.micOk === true,
    warnings: Array.isArray(summary.warnings)
      ? summary.warnings.filter((w): w is string => typeof w === "string")
      : [],
  };
}

function pickStopSummary(
  summary: Record<string, unknown> | undefined,
): MeetingRecordStop | undefined {
  if (!summary) return undefined;
  const audioPath = typeof summary.audioPath === "string" ? summary.audioPath : "";
  const durationSec = typeof summary.durationSec === "number" ? summary.durationSec : NaN;
  const startedAt = typeof summary.startedAt === "string" ? summary.startedAt : "";
  if (!audioPath || !Number.isFinite(durationSec) || !startedAt) return undefined;
  return {
    audioPath,
    recordDir: typeof summary.recordDir === "string" ? summary.recordDir : "",
    durationSec,
    sizeBytes: typeof summary.sizeBytes === "number" ? summary.sizeBytes : 0,
    startedAt,
    warnings: Array.isArray(summary.warnings)
      ? summary.warnings.filter((w): w is string => typeof w === "string")
      : [],
  };
}
