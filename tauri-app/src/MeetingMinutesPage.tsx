import { useCallback, useEffect, useRef, useState } from "react";
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
import { StepIndicator } from "@/components/StepIndicator";
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
  openOutput,
  pickPath,
  runningInDesktopApp,
} from "./api";
import { markToolPageLive } from "./toolPageActivity";
import {
  MeetingResultSchema,
  type MeetingResult,
  type MeetingStatus,
  type ToolManifest,
} from "./types";
import "./fx-audit.css";
import "./meeting-minutes.css";

export type { MeetingResult } from "./types";

const AUDIO_EXTENSIONS = ["wav", "mp3", "m4a", "flac", "aac", "mp4", "webm", "mov"];

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

export function MeetingMinutesPage({ tool }: { tool: ToolManifest }) {
  const [status, setStatus] = useState<MeetingStatus>();
  const [error, setError] = useState("");
  const [recordWarning, setRecordWarning] = useState("");
  const [recordBusy, setRecordBusy] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [detailLevel, setDetailLevel] = useState("standard");
  const [result, setResult] = useState<MeetingResult>();
  const [selectedKind, setSelectedKind] = useState<"content" | "timeline">();
  const [previewError, setPreviewError] = useState("");
  const [readingMinutes, setReadingMinutes] = useState(false);
  const [resident, setResident] = useState(false);
  const jobVersion = useRef(0);
  // 用户主动换录音/清空录音后置位：后台「最近一次任务」快照属于上一份录音，
  // 不得再回灌成当前结果；直到用户重新发起生成才解除。
  const manualResetRef = useRef(false);

  const onJobEvent = useCallback((event: { phase: string; result?: unknown }) => {
    jobVersion.current += 1;
    if (event.phase === "completed" && event.result) {
      const parsed = MeetingResultSchema.safeParse(event.result);
      if (parsed.success) {
        setResult((previous) => ({
          ...parsed.data,
          minutesMarkdown: parsed.data.minutesMarkdown ??
            (previous?.minutesPath === parsed.data.minutesPath ? previous?.minutesMarkdown : undefined),
          minutesVersions: parsed.data.minutesVersions?.map((version) => ({
            ...version,
            minutesMarkdown: version.minutesMarkdown ?? previous?.minutesVersions?.find(
              (old) => old.kind === version.kind && old.minutesPath === version.minutesPath,
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
  }, []);
  const { job, setJob, activeJobId } = useJobEvents({
    toolId: tool.id,
    onEvent: onJobEvent,
  });
  const busy = !!job && !["completed", "failed", "cancelled"].includes(job.phase);

  // 兼容升级前的任务快照：旧结果只有文件路径，按已授权路径补读正文。
  const versions = result?.minutesVersions;
  const activeVersion = versions?.find((version) => version.kind === selectedKind)
    ?? versions?.find((version) => version.minutesMarkdown || version.minutesPath)
    ?? versions?.[0];
  const minutesPath = activeVersion ? activeVersion.minutesPath : result?.minutesPath;
  const minutesMarkdown = activeVersion ? activeVersion.minutesMarkdown : result?.minutesMarkdown;
  const previewKind = activeVersion?.kind;
  useEffect(() => {
    setPreviewError("");
    if (!minutesPath || minutesMarkdown != null) return;
    let disposed = false;
    void meetingReadMinutes(minutesPath)
      .then((loaded) => {
        if (!disposed) {
          setResult((previous) => {
            if (previewKind) {
              return previous ? { ...previous, minutesVersions: previous.minutesVersions?.map((version) =>
                version.kind === previewKind && version.minutesPath === minutesPath
                  ? { ...version, minutesMarkdown: loaded.minutesMarkdown } : version) } : previous;
            }
            return previous?.minutesPath === minutesPath
              ? { ...previous, minutesMarkdown: loaded.minutesMarkdown } : previous;
          });
        }
      })
      .catch((e) => {
        if (!disposed) setPreviewError(errorText(e));
      });
    return () => { disposed = true; };
  }, [minutesPath, minutesMarkdown, previewKind]);

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
        if (!manualResetRef.current && version === jobVersion.current) {
          if (value.latestJob) {
            setJob(value.latestJob);
            onJobEvent(value.latestJob);
          }
          if (value.processingError) setError(value.processingError);
        }
      })
      .catch(() => undefined);
  }, [setJob, onJobEvent]);

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

  async function startGenerate(extra: { audioPath?: string; transcriptPath?: string }) {
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
      await jobStart(
        extra.transcriptPath ? "meeting.summarize" : "meeting.generate",
        params,
      );
      markToolPageLive(tool.id);
    } catch (e) {
      setError(errorText(e));
    }
  }

  /** 换/清录音＝换输入数据：上一轮纪要与转写稿不再属于当前录音，连同
   * 完成横幅一起撤下，并拦住后台快照把它刷回来。 */
  function resetForNewAudio() {
    manualResetRef.current = true;
    jobVersion.current += 1;
    setResult(undefined);
    setSelectedKind(undefined);
    setJob(undefined);
    setError("");
  }

  function browseAudio() {
    void pickPath("file", "选择会议录音文件", AUDIO_EXTENSIONS).then((value) => {
      if (typeof value === "string" && value) {
        if (value !== importPath) resetForNewAudio();
        setImportPath(value);
      }
    });
  }

  async function browseMinutes() {
    setError("");
    setReadingMinutes(true);
    try {
      const path = await pickPath("file", "选择已有会议纪要", ["md"]);
      if (typeof path !== "string" || !path) return;
      resetForNewAudio();
      const version = jobVersion.current;
      const loaded = await meetingReadMinutes(path);
      if (version === jobVersion.current) setResult(loaded);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setReadingMinutes(false);
    }
  }

  const recording = status?.recording;
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
      <StepIndicator
        steps={[
          { key: "record", label: "会议记录" },
          { key: "minutes", label: "纪要选项" },
          { key: "result", label: "结果" },
        ]}
        current={busy ? 1 : result ? 2 : 0}
      />
      {error && (
        <ErrorBox error={error} onDismiss={() => setError("")} />
      )}
      {recordWarning && (
        <ErrorBox error={recordWarning} onDismiss={() => setRecordWarning("")} />
      )}
      {job && (
        <JobProgress
          job={job}
          detail={terminalJobError(job)}
          onCancel={busy && activeJobId ? (id) => void jobCancel(id) : undefined}
        />
      )}
      {previewMode && (
        <div className="tool-trial-notice" role="note">
          <strong>预览模式</strong>
          <span>当前在浏览器中预览界面，Teams 检测、录音与生成纪要需在桌面应用中使用。</span>
        </div>
      )}

      <section className="meeting-section" aria-labelledby="meeting-record-title">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 id="meeting-record-title" className="meeting-section-title">
                1. 会议记录
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="meeting-status-grid">
              <div className="meeting-status-item">
                <dt>自动检测</dt>
                <dd>
                  {status?.watchEnabled ? (
                    <Badge variant="outline" className="badge-ready">已开启</Badge>
                  ) : (
                    <Badge variant="outline" className="badge-neutral">已关闭</Badge>
                  )}
                </dd>
              </div>
              <div className="meeting-status-item">
                <dt>当前状态</dt>
                <dd>{recording ? "正在录制会议" : status?.inCall ? "会议进行中（未记录）" : "空闲"}</dd>
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
            {!previewMode && <p className="meeting-watch-hint" role="status">{watchHint}</p>}
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
          </CardContent>
        </Card>
      </section>

      <section className="meeting-section" aria-labelledby="meeting-options-title">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 id="meeting-options-title" className="meeting-section-title">
                2. 纪要选项
              </h2>
            </CardTitle>
            <CardDescription>
              一次生成按内容、按时间两个版本，共用所选详细度；标题根据会议内容自动生成。
            </CardDescription>
          </CardHeader>
          <CardContent>
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
                从导入录音生成纪要
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="meeting-section" aria-labelledby="meeting-result-title">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 id="meeting-result-title" className="meeting-section-title">
                3. 结果
              </h2>
            </CardTitle>
            <CardDescription>
              生成后可切换查看按内容、按时间两个版本，文件分别保存在会议文件夹。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="meeting-result-actions">
              <Button variant="ghost" disabled={busy || readingMinutes || previewMode}
                onClick={() => void browseMinutes()}>
                {readingMinutes ? "正在读取纪要…" : "查看已有纪要"}
              </Button>
            </div>
            {result ? (
              <div className="meeting-result-card">
                {versions && versions.length > 0 && (
                  <div className="meeting-version-switch" role="group" aria-label="纪要版本">
                    {versions.map((version) => (
                      <Button key={version.kind}
                        variant={activeVersion?.kind === version.kind ? "default" : "secondary"}
                        aria-pressed={activeVersion?.kind === version.kind}
                        onClick={() => setSelectedKind(version.kind)}>
                        {version.label}{!version.minutesMarkdown && !version.minutesPath ? "（未生成）" : ""}
                      </Button>
                    ))}
                  </div>
                )}
                <div className="meeting-result-meta">
                  {!minutesMarkdown && <span>{activeVersion ? activeVersion.title || `${activeVersion.label}版会议纪要` : result.title || "会议纪要"}</span>}
                  {typeof result.speakerCount === "number" && result.speakerCount > 0 && (
                    <span>识别出 {formatCount(result.speakerCount)} 位说话人</span>
                  )}
                </div>
                {result.minutesError && !activeVersion && (
                  <p role="alert" className="meeting-ask-error">
                    {result.minutesError}
                  </p>
                )}
                {activeVersion?.minutesError && (
                  <p role="alert" className="meeting-ask-error">{activeVersion.minutesError}</p>
                )}
                {versions?.some((version) => version.minutesError) && (
                  <p className="meeting-watch-hint">部分版本生成或保存未完成，可切换查看原因，或从转写稿重新生成两个版本。</p>
                )}
                {previewError && <p role="alert" className="meeting-ask-error">{previewError}</p>}
                {minutesMarkdown ? (
                  <article className="meeting-minutes-content" aria-label="会议纪要正文">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
                      h1: ({ children }) => <h3 className="meeting-minutes-title">{children}</h3>,
                      h2: ({ children }) => <h4>{children}</h4>,
                      h3: ({ children }) => <h5>{children}</h5>,
                      h4: ({ children }) => <h6>{children}</h6>,
                      a: ({ children }) => <span>{children}</span>,
                      img: () => null,
                      table: ({ children }) => <div className="meeting-minutes-table"><table>{children}</table></div>,
                    }}>
                      {minutesMarkdown}
                    </ReactMarkdown>
                  </article>
                ) : minutesMarkdown === "" ? (
                  <p role="status">纪要文件暂无正文。</p>
                ) : minutesPath && !previewError ? (
                  <p role="status">正在读取纪要正文…</p>
                ) : null}
                <div className="meeting-result-actions">
                  {minutesPath && (
                    <Button
                      variant="secondary"
                      onClick={() => void openOutput(minutesPath)}
                    >
                      {activeVersion ? `打开${activeVersion.label}版纪要` : "打开会议纪要"}
                    </Button>
                  )}
                  {result.transcriptPath && (
                    <Button
                      variant="secondary"
                      onClick={() => void openOutput(result.transcriptPath as string)}
                    >
                      打开转写稿
                    </Button>
                  )}
                  {result.transcriptPath && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void startGenerate({ transcriptPath: result.transcriptPath })
                      }
                    >
                      {versions ? "从转写稿重新生成两个版本" : "从转写稿重新生成"}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <EmptyState
                compact
                title="还没有会议纪要"
                description="结束录音或导入音频后可生成纪要。"
              />
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
