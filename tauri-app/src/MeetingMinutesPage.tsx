import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatCount } from "@/lib/numberFormat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBox } from "@/components/ErrorBox";
import { FileDropInput } from "@/components/FileDropInput";
import { NoticeStack } from "@/components/NoticeStack";
import { JobProgress, terminalJobError } from "@/components/JobProgress";
import { PageHeader } from "@/components/PageHeader";
import { SwitchInput } from "@/components/SwitchInput";
import { useJobEvents } from "@/hooks/useJobEvents";
import { meetingErrorText as errorText } from "@/lib/errors";
import {
  jobCancel,
  jobStart,
  meetingRecordStart,
  meetingRecordStop,
  meetingSetResident,
  meetingStatus,
  meetingReadMinutes,
  meetingHistoryList,
  meetingHistoryGet,
  meetingReadTranscript,
  openOutput,
  pickPath,
  runningInDesktopApp,
} from "./api";
import { markToolPageLive } from "./toolPageActivity";
import { meetingOutputPath } from "./meetingMinutesResult";
import {
  MeetingResultSchema,
  type MeetingResult,
  type MeetingStatus,
  type MeetingHistoryRow,
  type JobEvent,
  type ToolManifest,
} from "./types";
import "./fx-audit.css";
import "./meeting-minutes.css";

export type { MeetingResult } from "./types";

const AUDIO_EXTENSIONS = [
  "wav",
  "mp3",
  "m4a",
  "flac",
  "aac",
  "mp4",
  "webm",
  "mov",
];

const DETAIL_OPTIONS = [
  { label: "简要（关键要点）", value: "brief" },
  { label: "标准", value: "standard" },
  { label: "详细（充分展开）", value: "detailed" },
];

/** 文件名显示：完整路径只露出文件名，避免撑破布局。 */
export function displayAudioFileName(path: string) {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return name || path;
}

export function historyDateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未知";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function historyTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}

function historyDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", { hour12: false });
}

function historyStatus(status: string, active: boolean) {
  if (active) return "生成中";
  return (
    (
      {
        completed: "已完成",
        partial: "部分完成",
        failed: "失败",
        cancelled: "已取消",
      } as Record<string, string>
    )[status] ?? "未完成"
  );
}

export function MeetingMinutesPage({ tool }: { tool: ToolManifest }) {
  const location = useLocation();
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const pendingResultFocus = useRef(false);
  const [status, setStatus] = useState<MeetingStatus>();
  const [error, setError] = useState("");
  const [recordWarning, setRecordWarning] = useState("");
  const [recordBusy, setRecordBusy] = useState(false);
  const [generationStarting, setGenerationStarting] = useState(false);
  const generationStartingRef = useRef(false);
  const [importPath, setImportPath] = useState("");
  const [detailLevel, setDetailLevel] = useState("standard");
  const [result, setResult] = useState<MeetingResult>();
  const [selectedKind, setSelectedKind] = useState<
    "content" | "timeline" | "transcript"
  >();
  const [previewError, setPreviewError] = useState("");
  const [readingMinutes, setReadingMinutes] = useState(false);
  const [resident, setResident] = useState(false);
  const [history, setHistory] = useState<MeetingHistoryRow[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string>();
  const [historyResultError, setHistoryResultError] = useState("");
  const [transcript, setTranscript] = useState<string>();
  const [transcriptError, setTranscriptError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const viewingHistoryRef = useRef(false);
  const autoRestoreRef = useRef(true);
  const selectionVersion = useRef(0);
  const historyRequest = useRef(0);
  const jobVersion = useRef(0);
  // 用户主动换录音/清空录音后置位：后台「最近一次任务」快照属于上一份录音，
  // 不得再回灌成当前结果；直到用户重新发起生成才解除。
  const manualResetRef = useRef(false);

  const onJobEvent = useCallback(
    (event: { phase: string; result?: unknown }) => {
      jobVersion.current += 1;
      // 任务进度照常推进；用户正在阅读的历史会议不被后台结果抢占。
      if (viewingHistoryRef.current) return;
      if (event.phase === "completed" && event.result) {
        const parsed = MeetingResultSchema.safeParse(event.result);
        if (parsed.success) {
          setResult((previous) => ({
            ...parsed.data,
            minutesMarkdown:
              parsed.data.minutesMarkdown ??
              (previous?.minutesPath === parsed.data.minutesPath
                ? previous?.minutesMarkdown
                : undefined),
            minutesVersions: parsed.data.minutesVersions?.map((version) => ({
              ...version,
              minutesMarkdown:
                version.minutesMarkdown ??
                previous?.minutesVersions?.find(
                  (old) =>
                    old.kind === version.kind &&
                    old.minutesPath === version.minutesPath,
                )?.minutesMarkdown,
            })),
          }));
        } else {
          setResult(undefined);
          setError("会议纪要结果格式异常，请从任务历史打开输出文件。");
        }
      } else if (event.phase !== "completed") {
        setResult(undefined);
      }
    },
    [],
  );
  const { job, setJob, activeJobId } = useJobEvents({
    toolId: tool.id,
    onEvent: onJobEvent,
  });
  const busy =
    generationStarting ||
    (!!job && !["completed", "failed", "cancelled"].includes(job.phase));

  async function selectHistory(row: MeetingHistoryRow) {
    autoRestoreRef.current = false;
    viewingHistoryRef.current = true;
    const version = ++selectionVersion.current;
    setSelectedHistoryId(row.id);
    setResult(undefined);
    setSelectedKind(undefined);
    setHistoryResultError("");
    setReadingMinutes(true);
    try {
      const loaded = await meetingHistoryGet(row.id);
      if (selectionVersion.current === version) setResult(loaded);
    } catch (e) {
      if (selectionVersion.current === version)
        setHistoryResultError(errorText(e));
    } finally {
      if (selectionVersion.current === version) setReadingMinutes(false);
    }
  }

  const refreshHistory = useCallback(async () => {
    const request = ++historyRequest.current;
    try {
      const rows = await meetingHistoryList();
      if (request !== historyRequest.current) return;
      setHistory(rows);
      setHistoryError("");
    } catch (e) {
      if (request === historyRequest.current) setHistoryError(errorText(e));
    } finally {
      if (request === historyRequest.current) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshHistory();
    return () => {
      historyRequest.current += 1;
    };
  }, [refreshHistory, job?.jobId, job?.phase]);

  // 重启后没有进程内快照时，默认打开最新一场；选择与新输入优先于自动恢复。
  useEffect(() => {
    if (
      !autoRestoreRef.current ||
      !status ||
      status.latestJob ||
      result ||
      readingMinutes ||
      manualResetRef.current ||
      viewingHistoryRef.current
    )
      return;
    if (history[0]) void selectHistory(history[0]);
  }, [history, status, result, readingMinutes]);

  // 完成提示携带同一任务结果进入工具页，也适用于已保活、没有重新挂载的页面。
  useEffect(() => {
    if (location.pathname !== tool.route) return;
    const kind = new URLSearchParams(location.search).get("version");
    if (kind !== "content" && kind !== "timeline") return;
    const incoming = (location.state as { meetingJob?: JobEvent } | null)
      ?.meetingJob;
    if (incoming?.toolId === tool.id && incoming.phase === "completed") {
      autoRestoreRef.current = false;
      viewingHistoryRef.current = false;
      selectionVersion.current += 1;
      setSelectedHistoryId(undefined);
      manualResetRef.current = false;
      setJob(incoming);
      onJobEvent(incoming);
    }
    setSelectedKind(kind);
    pendingResultFocus.current = true;
  }, [location, tool.id, tool.route, setJob, onJobEvent]);

  useEffect(() => {
    if (
      !pendingResultFocus.current ||
      !result ||
      location.pathname !== tool.route
    )
      return;
    const frame = requestAnimationFrame(() => {
      resultHeading.current?.scrollIntoView?.({ block: "start" });
      resultHeading.current?.focus({ preventScroll: true });
      pendingResultFocus.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [result, selectedKind, location]);

  // 兼容升级前的任务快照：旧结果只有文件路径，按已授权路径补读正文。
  const versions = result?.minutesVersions;
  const activeVersion =
    versions?.find((version) => version.kind === selectedKind) ??
    versions?.find(
      (version) => version.minutesMarkdown || version.minutesPath,
    ) ??
    versions?.[0];
  const minutesPath = activeVersion
    ? activeVersion.minutesPath
    : result?.minutesPath;
  const minutesMarkdown = activeVersion
    ? activeVersion.minutesMarkdown
    : result?.minutesMarkdown;
  const outputPath =
    selectedKind === "transcript"
      ? result?.transcriptPath
      : meetingOutputPath(result);
  const previewKind = activeVersion?.kind;
  useEffect(() => {
    setPreviewError("");
    if (
      selectedKind === "transcript" ||
      !minutesPath ||
      minutesMarkdown != null
    )
      return;
    let disposed = false;
    void meetingReadMinutes(minutesPath)
      .then((loaded) => {
        if (!disposed) {
          setResult((previous) => {
            if (previewKind) {
              return previous
                ? {
                    ...previous,
                    minutesVersions: previous.minutesVersions?.map((version) =>
                      version.kind === previewKind &&
                      version.minutesPath === minutesPath
                        ? {
                            ...version,
                            minutesMarkdown: loaded.minutesMarkdown,
                          }
                        : version,
                    ),
                  }
                : previous;
            }
            return previous?.minutesPath === minutesPath
              ? { ...previous, minutesMarkdown: loaded.minutesMarkdown }
              : previous;
          });
        }
      })
      .catch((e) => {
        if (!disposed) setPreviewError(errorText(e));
      });
    return () => {
      disposed = true;
    };
  }, [minutesPath, minutesMarkdown, previewKind, selectedKind]);

  useEffect(() => {
    setTranscript(undefined);
    setTranscriptError("");
    setCopyStatus("");
  }, [result?.transcriptPath, selectedHistoryId]);

  useEffect(() => {
    setCopyStatus("");
  }, [selectedKind, minutesPath]);

  useEffect(() => {
    if (
      selectedKind !== "transcript" ||
      !result?.transcriptPath ||
      transcript !== undefined
    )
      return;
    let disposed = false;
    void meetingReadTranscript(result.transcriptPath)
      .then((text) => {
        if (!disposed) setTranscript(text);
      })
      .catch((e) => {
        if (!disposed) setTranscriptError(errorText(e));
      });
    return () => {
      disposed = true;
    };
  }, [selectedKind, result?.transcriptPath, transcript]);

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(
        selectedKind === "transcript"
          ? (transcript ?? "")
          : (minutesMarkdown ?? ""),
      );
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败，请选中正文后复制。");
    }
  }

  useEffect(() => {
    markToolPageLive(tool.id);
  }, [tool.id]);

  const refreshStatus = useCallback(() => {
    const version = jobVersion.current;
    meetingStatus()
      .then((value) => {
        setStatus(value);
        setResident(value.resident);
        // 自动任务可能在本页首次打开前已经完成；快照补回结果，新的事件优先。
        // manualResetRef 置位期间跳过：那是上一份录音的结果，补回就是旧信息冒充新结果。
        if (
          !generationStartingRef.current &&
          !manualResetRef.current &&
          version === jobVersion.current
        ) {
          if (
            value.latestJob &&
            (!activeJobId.current ||
              value.latestJob.jobId === activeJobId.current)
          ) {
            setJob(value.latestJob);
            onJobEvent(value.latestJob);
          }
          if (value.processingError) setError(value.processingError);
        }
      })
      .catch(() => undefined);
  }, [setJob, onJobEvent, activeJobId]);

  useEffect(() => {
    refreshStatus();
    const timer = window.setInterval(refreshStatus, 5000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  function changeResident(enabled: boolean) {
    // 乐观更新：失败时下一轮状态轮询会纠正回来。
    setResident(enabled);
    meetingSetResident(enabled).catch((e) => setError(errorText(e)));
  }

  async function startRecording() {
    if (recordBusy) return;
    setRecordBusy(true);
    setError("");
    setRecordWarning("");
    try {
      const started = await meetingRecordStart();
      // 开录即亮设备疑点（退回默认设备/换了非默认麦克风），会议中还有机会调整。
      if (started.warnings.length) {
        setRecordWarning(started.warnings.join("；"));
      }
      refreshStatus();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRecordBusy(false);
    }
  }

  /** 手动停止录音后立即进入转写与纪要生成。 */
  async function stopRecordingAndGenerate() {
    if (recordBusy) return;
    setRecordBusy(true);
    setError("");
    try {
      const stopped = await meetingRecordStop();
      refreshStatus();
      // 空录体检的疑点先亮出来：转写大概率没有内容，让用户知道原因和出路。
      setRecordWarning(stopped.warnings.join("；"));
      await startGenerate({ audioPath: stopped.audioPath });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRecordBusy(false);
    }
  }

  async function startGenerate(extra: {
    audioPath?: string;
    transcriptPath?: string;
  }) {
    if (busy || generationStartingRef.current) return;
    generationStartingRef.current = true;
    setGenerationStarting(true);
    jobVersion.current += 1;
    autoRestoreRef.current = false;
    viewingHistoryRef.current = false;
    selectionVersion.current += 1;
    setReadingMinutes(false);
    setSelectedHistoryId(undefined);
    setHistoryResultError("");
    setError("");
    setResult(undefined);
    setSelectedKind(undefined);
    // 新一轮生成开始：此后后台快照与事件都属于当前输入，恢复回灌。
    manualResetRef.current = false;
    const params: Record<string, unknown> = {
      ...extra,
      detailLevel,
    };
    try {
      const jobId = await jobStart(
        extra.transcriptPath ? "meeting.summarize" : "meeting.generate",
        params,
      );
      setJob((current) =>
        current?.jobId === jobId
          ? current
          : {
              jobId,
              toolId: tool.id,
              phase: "queued",
              current: 0,
              total: 5,
              message: "等待生成会议纪要…",
              severity: "info",
              outputPaths: [],
            },
      );
      markToolPageLive(tool.id);
      void refreshHistory();
    } catch (e) {
      setError(errorText(e));
    } finally {
      generationStartingRef.current = false;
      setGenerationStarting(false);
    }
  }

  /** 换/清录音＝换输入数据：上一轮纪要与转写稿不再属于当前录音，连同
   * 完成横幅一起撤下，并拦住后台快照把它刷回来。 */
  function resetForNewAudio() {
    autoRestoreRef.current = false;
    viewingHistoryRef.current = false;
    selectionVersion.current += 1;
    setReadingMinutes(false);
    setSelectedHistoryId(undefined);
    setHistoryResultError("");
    manualResetRef.current = true;
    jobVersion.current += 1;
    setResult(undefined);
    setSelectedKind(undefined);
    setJob(undefined);
    setError("");
  }

  function browseAudio() {
    void pickPath("file", "选择会议录音文件", AUDIO_EXTENSIONS).then(
      (value) => {
        if (typeof value === "string" && value) {
          if (value !== importPath) resetForNewAudio();
          setImportPath(value);
        }
      },
    );
  }

  async function browseMinutes() {
    let selection = selectionVersion.current;
    setError("");
    setReadingMinutes(true);
    try {
      const path = await pickPath("file", "选择已有会议纪要", ["md"]);
      if (typeof path !== "string" || !path) return;
      autoRestoreRef.current = false;
      viewingHistoryRef.current = true;
      selection = ++selectionVersion.current;
      setSelectedHistoryId(undefined);
      setSelectedKind(undefined);
      setResult(undefined);
      setHistoryResultError("");
      const loaded = await meetingReadMinutes(path);
      if (selection === selectionVersion.current) setResult(loaded);
    } catch (e) {
      if (selection === selectionVersion.current) setError(errorText(e));
    } finally {
      if (selection === selectionVersion.current) setReadingMinutes(false);
    }
  }

  const recording = status?.recording;
  const selectedHistory =
    history.find((row) => row.id === selectedHistoryId) ??
    (!viewingHistoryRef.current
      ? history.find((row) => row.jobId === job?.jobId)
      : undefined);
  const visibleHistory = history.filter((row) =>
    row.title
      .toLocaleLowerCase()
      .includes(historyQuery.trim().toLocaleLowerCase()),
  );
  const historyGroups = new Map<string, MeetingHistoryRow[]>();
  for (const row of visibleHistory) {
    const group = historyDateLabel(row.startedAt);
    historyGroups.set(group, [...(historyGroups.get(group) ?? []), row]);
  }
  const previewMode = !runningInDesktopApp();
  const watchHint = previewMode
    ? "浏览器预览模式：界面仅供查看，会议检测与录音请在桌面应用中使用。"
    : !status
      ? "正在读取状态…"
      : !status.logFound && !status.audioDetectionAvailable
        ? "未找到新版 Teams 日志（未安装或未启动 Teams 时无法自动检测，可手动记录或导入录音）。"
        : status.watchEnabled
          ? status.inCall
            ? "检测到会议进行中。"
            : "自动检测已开启，正在等待会议开始。"
          : "自动检测已在设置页关闭，可手动记录或导入录音。";

  return (
    <main className="tool-page fx-page meeting-page">
      <PageHeader
        eyebrow="运营支持"
        title={tool.name}
        detail="记录会议或导入录音，转写后生成结构化纪要。"
      />
      {error && <ErrorBox error={error} onDismiss={() => setError("")} />}
      {recordWarning && (
        <ErrorBox
          error={recordWarning}
          onDismiss={() => setRecordWarning("")}
        />
      )}
      {previewMode && (
        <div className="tool-trial-notice" role="note">
          <strong>预览模式</strong>
          <span>
            当前在浏览器中预览界面，Teams
            检测、录音与生成纪要需在桌面应用中使用。
          </span>
        </div>
      )}

      <section
        className="meeting-section"
        aria-labelledby="meeting-record-title"
      >
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 id="meeting-record-title" className="meeting-section-title">
                会议记录配置
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="meeting-configuration-summary">
              <dl className="meeting-status-grid">
                <div className="meeting-status-item">
                  <dt>自动检测</dt>
                  <dd>
                    {status?.watchEnabled ? (
                      <Badge variant="outline" className="badge-ready">
                        已开启
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="badge-neutral">
                        已关闭
                      </Badge>
                    )}
                  </dd>
                </div>
                <div className="meeting-status-item">
                  <dt>当前状态</dt>
                  <dd>
                    {recording
                      ? "正在录制会议"
                      : status?.inCall
                        ? "会议进行中（未记录）"
                        : "空闲"}
                  </dd>
                </div>
              </dl>
              {/* 「后台常驻」是设置不是状态：开关曾挤在状态砖里，移出砖排单独一行。 */}
              <div className="meeting-resident-row">
                <SwitchInput
                  checked={resident}
                  onChange={changeResident}
                  ariaLabel="后台常驻"
                />
                <strong>后台常驻</strong>
                <span>
                  {resident
                    ? "关窗后驻留系统托盘继续监控，真正退出请用托盘菜单「退出」。"
                    : "关窗即退出工具箱，监控同时停止。"}
                </span>
              </div>
            </div>
            {/* 隐私告知升级为琥珀提示条：录音要上传云端转写，属于会前必须
                交代的事项，普通正文曾经毫无提示力（UI 审核）。 */}
            <div className="meeting-import-note">
              <NoticeStack
                items={[
                  {
                    tone: "warning",
                    children: (
                      <span>
                        录音包含系统声音与麦克风两轨，停止时自动混音；录音将上传阿里云百炼转写，请先告知参会人。
                      </span>
                    ),
                  },
                ]}
              />
            </div>
            <div className="meeting-input-layout">
              <div className="meeting-record-source">
                {!previewMode && (
                  <p className="meeting-watch-hint" role="status">
                    {watchHint}
                  </p>
                )}
                <div className="meeting-actions-row">
                  {recording ? (
                    <Button
                      variant="default"
                      onClick={() => void stopRecordingAndGenerate()}
                      disabled={recordBusy || busy}
                    >
                      停止并生成纪要
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      onClick={() => void startRecording()}
                      disabled={recordBusy || busy || previewMode}
                    >
                      手动开始记录
                    </Button>
                  )}
                </div>
              </div>
              <div className="meeting-import-source">
                {/* hideFilledLabel：选中后只留文件名，「已有录音（wav / mp3 / m4a 等）」
                的格式说明只属于空态占位；清空按钮随槽位出现。 */}
                <FileDropInput
                  value={importPath ? displayAudioFileName(importPath) : ""}
                  placeholder="拖放或点击选择已有录音（wav / mp3 / m4a 等）"
                  hideFilledLabel
                  disabled={busy}
                  onBrowse={browseAudio}
                  onClear={
                    importPath && !busy
                      ? () => {
                          resetForNewAudio();
                          setImportPath("");
                        }
                      : undefined
                  }
                  onDragStateChange={() => undefined}
                />
              </div>
            </div>
            <div className="meeting-generation-controls">
              <div className="meeting-options-grid">
                <label>
                  纪要详细度
                  <select
                    value={detailLevel}
                    onChange={(e) => setDetailLevel(e.target.value)}
                  >
                    {DETAIL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="meeting-actions-row">
                <Button
                  variant="secondary"
                  disabled={!importPath || busy || recording || previewMode}
                  onClick={() => void startGenerate({ audioPath: importPath })}
                >
                  生成纪要
                </Button>
              </div>
            </div>
            <p className="meeting-watch-hint">
              一次生成按内容、按时间两个版本，共用所选详细度；标题根据会议内容自动生成。
            </p>
            {job && (
              <JobProgress
                job={job}
                detail={terminalJobError(job)}
                onCancel={
                  busy && activeJobId ? (id) => void jobCancel(id) : undefined
                }
              />
            )}
          </CardContent>
        </Card>
      </section>

      <div className="meeting-workspace">
        <section
          className="meeting-section meeting-history"
          aria-labelledby="meeting-history-title"
        >
          <Card>
            <CardHeader>
              <CardTitle>
                <h2
                  id="meeting-history-title"
                  className="meeting-section-title"
                >
                  历史记录
                </h2>
              </CardTitle>
              <CardDescription>
                按时间查找会议，点击查看对应结果。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <label className="meeting-history-search">
                <span className="sr-only">搜索会议标题</span>
                <input
                  type="search"
                  placeholder="搜索会议标题"
                  value={historyQuery}
                  onChange={(event) => setHistoryQuery(event.target.value)}
                />
              </label>
              {historyError && (
                <div role="alert" className="meeting-ask-error">
                  {historyError}
                  <Button variant="ghost" onClick={() => void refreshHistory()}>
                    重试加载
                  </Button>
                </div>
              )}
              <div
                className="meeting-history-list"
                aria-label="会议历史列表"
                aria-busy={historyLoading}
              >
                {historyLoading ? (
                  <p role="status">正在加载历史记录…</p>
                ) : visibleHistory.length ? (
                  [...historyGroups].map(([date, rows]) => (
                    <div className="meeting-history-day" key={date}>
                      <h3>{date}</h3>
                      <ul>
                        {rows.map((row) => (
                          <li key={row.id}>
                            <button
                              type="button"
                              className="meeting-history-item"
                              aria-current={
                                selectedHistory?.id === row.id
                                  ? "true"
                                  : undefined
                              }
                              onClick={() => void selectHistory(row)}
                            >
                              <span className="meeting-history-time">
                                <time dateTime={row.startedAt}>
                                  {historyTime(row.startedAt)}
                                </time>
                                <span>
                                  {historyStatus(
                                    row.status,
                                    busy && job?.jobId === row.jobId,
                                  )}
                                </span>
                              </span>
                              <strong>{row.title}</strong>
                              <span className="meeting-history-time-label">
                                {row.timeLabel}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                ) : (
                  <EmptyState
                    compact
                    title={historyQuery ? "没有匹配的会议" : "还没有会议记录"}
                    description={
                      historyQuery
                        ? "试试其他标题关键词。"
                        : "生成会议纪要后，会在这里保留记录。"
                    }
                  />
                )}
              </div>
            </CardContent>
          </Card>
        </section>
        <section
          className="meeting-section meeting-reader"
          aria-labelledby="meeting-result-title"
        >
          <Card>
            <CardHeader>
              <CardTitle>
                <h2
                  id="meeting-result-title"
                  className="meeting-section-title"
                  ref={resultHeading}
                  tabIndex={-1}
                >
                  会议结果
                </h2>
              </CardTitle>
              <CardDescription>
                {selectedHistory
                  ? `${selectedHistory.title} · ${selectedHistory.timeLabel} ${historyDateTime(selectedHistory.startedAt)}`
                  : result?.title || "选择历史会议记录，或生成新的会议纪要。"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="meeting-result-actions">
                <Button
                  variant="ghost"
                  disabled={readingMinutes || previewMode}
                  onClick={() => void browseMinutes()}
                >
                  {readingMinutes ? "正在读取纪要…" : "查看已有纪要"}
                </Button>
              </div>
              {selectedHistory &&
                selectedHistory.status !== "completed" &&
                selectedHistory.message && (
                  <p className="meeting-watch-hint" role="status">
                    {selectedHistory.message}
                  </p>
                )}
              {historyResultError && (
                <p role="alert" className="meeting-ask-error">
                  {historyResultError}
                </p>
              )}
              {readingMinutes && !result && (
                <p role="status">正在读取会议结果…</p>
              )}
              {result ? (
                <div className="meeting-result-card">
                  {((versions && versions.length > 0) ||
                    result.transcriptPath) && (
                    <div
                      className="meeting-version-switch"
                      role="group"
                      aria-label="纪要版本"
                    >
                      {!versions?.length &&
                        (result.minutesMarkdown || result.minutesPath) && (
                          <Button
                            variant={
                              selectedKind !== "transcript"
                                ? "default"
                                : "secondary"
                            }
                            aria-pressed={selectedKind !== "transcript"}
                            onClick={() => setSelectedKind("content")}
                          >
                            会议纪要
                          </Button>
                        )}
                      {versions?.map((version) => (
                        <Button
                          key={version.kind}
                          variant={
                            selectedKind !== "transcript" &&
                            activeVersion?.kind === version.kind
                              ? "default"
                              : "secondary"
                          }
                          aria-pressed={
                            selectedKind !== "transcript" &&
                            activeVersion?.kind === version.kind
                          }
                          onClick={() => setSelectedKind(version.kind)}
                        >
                          {version.label}
                          {!version.minutesMarkdown && !version.minutesPath
                            ? "（未生成）"
                            : ""}
                        </Button>
                      ))}
                      {result.transcriptPath && (
                        <Button
                          variant={
                            selectedKind === "transcript"
                              ? "default"
                              : "secondary"
                          }
                          aria-pressed={selectedKind === "transcript"}
                          onClick={() => setSelectedKind("transcript")}
                        >
                          原始转写
                        </Button>
                      )}
                    </div>
                  )}
                  <div className="meeting-result-meta">
                    {!minutesMarkdown && (
                      <span>
                        {activeVersion
                          ? activeVersion.title ||
                            `${activeVersion.label}版会议纪要`
                          : result.title || "会议纪要"}
                      </span>
                    )}
                    {typeof result.speakerCount === "number" &&
                      result.speakerCount > 0 && (
                        <span>
                          识别出 {formatCount(result.speakerCount)} 位说话人
                        </span>
                      )}
                  </div>
                  {!minutesPath &&
                    !minutesMarkdown &&
                    !result.transcriptPath &&
                    !result.minutesError &&
                    !activeVersion?.minutesError && (
                      <EmptyState
                        compact
                        title="尚无可阅读的纪要"
                        description="这场会议尚未完成转写和纪要生成，可查看处理状态，或使用保留的录音重新生成。"
                      />
                    )}
                  {selectedKind !== "transcript" &&
                    result.minutesError &&
                    !activeVersion && (
                      <p role="alert" className="meeting-ask-error">
                        {result.minutesError}
                      </p>
                    )}
                  {selectedKind !== "transcript" &&
                    activeVersion?.minutesError && (
                      <p role="alert" className="meeting-ask-error">
                        {activeVersion.minutesError}
                      </p>
                    )}
                  {versions?.some((version) => version.minutesError) && (
                    <p className="meeting-watch-hint">
                      部分版本生成或保存未完成，可切换查看原因，或从转写稿重新生成两个版本。
                    </p>
                  )}
                  {selectedKind !== "transcript" && previewError && (
                    <p role="alert" className="meeting-ask-error">
                      {previewError}
                    </p>
                  )}
                  {selectedKind === "transcript" ? (
                    transcriptError ? (
                      <p role="alert" className="meeting-ask-error">
                        {transcriptError}
                      </p>
                    ) : transcript === undefined ? (
                      <p role="status">正在读取转写稿…</p>
                    ) : (
                      <article
                        className="meeting-transcript-content"
                        aria-label="原始转写正文"
                      >
                        <pre>{transcript || "转写稿暂无正文。"}</pre>
                      </article>
                    )
                  ) : minutesMarkdown ? (
                    <article
                      className="meeting-minutes-content"
                      aria-label="会议纪要正文"
                    >
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        skipHtml
                        components={{
                          h1: ({ children }) => (
                            <h3 className="meeting-minutes-title">
                              {children}
                            </h3>
                          ),
                          h2: ({ children }) => <h4>{children}</h4>,
                          h3: ({ children }) => <h5>{children}</h5>,
                          h4: ({ children }) => <h6>{children}</h6>,
                          a: ({ children }) => <span>{children}</span>,
                          img: () => null,
                          table: ({ children }) => (
                            <div className="meeting-minutes-table">
                              <table>{children}</table>
                            </div>
                          ),
                        }}
                      >
                        {minutesMarkdown}
                      </ReactMarkdown>
                    </article>
                  ) : minutesMarkdown === "" ? (
                    <p role="status">纪要文件暂无正文。</p>
                  ) : minutesPath && !previewError ? (
                    <p role="status">正在读取纪要正文…</p>
                  ) : null}
                  <div className="meeting-result-actions">
                    <Button
                      variant="secondary"
                      onClick={() => void copyBody()}
                      disabled={
                        !(selectedKind === "transcript"
                          ? transcript
                          : minutesMarkdown)
                      }
                    >
                      复制正文
                    </Button>
                    {copyStatus && <span role="status">{copyStatus}</span>}
                    {outputPath && (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          void openOutput(outputPath).catch((e) =>
                            setError(errorText(e)),
                          )
                        }
                      >
                        打开输出文件夹
                      </Button>
                    )}
                    {result.transcriptPath && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void startGenerate({
                            transcriptPath: result.transcriptPath,
                          })
                        }
                      >
                        {versions
                          ? "从转写稿重新生成两个版本"
                          : "从转写稿重新生成"}
                      </Button>
                    )}
                    {!result.transcriptPath && result.audioPath && (
                      <Button
                        variant="ghost"
                        disabled={busy || previewMode}
                        onClick={() =>
                          void startGenerate({
                            audioPath: result.audioPath || undefined,
                          })
                        }
                      >
                        从录音重新生成
                      </Button>
                    )}
                  </div>
                </div>
              ) : !readingMinutes && !historyResultError ? (
                <EmptyState
                  compact
                  title="还没有会议纪要"
                  description={
                    selectedHistory
                      ? "这场会议尚未生成可阅读的结果，请查看处理状态或重新导入录音。"
                      : "从左侧选择历史会议，或在上方记录、导入录音生成纪要。"
                  }
                />
              ) : null}
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}
