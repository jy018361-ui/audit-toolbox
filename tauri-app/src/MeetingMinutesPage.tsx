import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBox } from "@/components/ErrorBox";
import { FileDropInput } from "@/components/FileDropInput";
import { JobProgress } from "@/components/JobProgress";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { SwitchInput } from "@/components/SwitchInput";
import { useJobEvents } from "@/hooks/useJobEvents";
import { errorText } from "@/lib/errors";
import {
  jobCancel,
  jobStart,
  meetingRecordStart,
  meetingRecordStop,
  meetingSetResident,
  meetingStatus,
  openOutput,
  pickPath,
} from "./api";
import { markToolPageLive } from "./toolPageActivity";
import type { MeetingStatus, ToolManifest } from "./types";
import "./fx-audit.css";
import "./meeting-minutes.css";

/** 会议纪要结果（meeting.generate / meeting.summarize 任务返回）。 */
export type MeetingResult = {
  title?: string;
  minutesPath?: string | null;
  transcriptPath?: string;
  audioPath?: string | null;
  speakerCount?: number;
  minutesError?: string | null;
};

const AUDIO_EXTENSIONS = ["wav", "mp3", "m4a", "flac", "aac", "mp4", "webm", "mov"];

const DETAIL_OPTIONS = [
  { label: "简要（结论与待办）", value: "brief" },
  { label: "标准", value: "standard" },
  { label: "详细（分议题展开）", value: "detailed" },
];

/** 文件名显示：完整路径只露出文件名，避免撑破布局。 */
export function displayAudioFileName(path: string) {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return name || path;
}

export function MeetingMinutesPage({ tool }: { tool: ToolManifest }) {
  const [status, setStatus] = useState<MeetingStatus>();
  const [error, setError] = useState("");
  const [recordBusy, setRecordBusy] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [title, setTitle] = useState("");
  const [participants, setParticipants] = useState("");
  const [detailLevel, setDetailLevel] = useState("standard");
  const [result, setResult] = useState<MeetingResult>();
  const [resident, setResident] = useState(false);
  const generateParams = useRef<Record<string, unknown>>({});

  const onJobEvent = useCallback((event: { phase: string; result?: unknown }) => {
    if (event.phase === "completed" && event.result) {
      setResult(event.result as MeetingResult);
    }
  }, []);
  const { job, setJob, activeJobId } = useJobEvents({
    toolId: tool.id,
    onEvent: onJobEvent,
  });
  const busy = !!job && !["completed", "failed", "cancelled"].includes(job.phase);

  useEffect(() => {
    markToolPageLive(tool.id);
  }, [tool.id]);

  const refreshStatus = useCallback(() => {
    meetingStatus()
      .then((value) => {
        setStatus(value);
        setResident(value.resident);
      })
      .catch(() => undefined);
  }, []);

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
    try {
      await meetingRecordStart();
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
    const params: Record<string, unknown> = {
      ...extra,
      detailLevel,
    };
    if (title.trim()) params.title = title.trim();
    if (participants.trim()) params.participants = participants.trim();
    generateParams.current = params;
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

  function browseAudio() {
    void pickPath("file", "选择会议录音文件", AUDIO_EXTENSIONS).then((value) => {
      if (typeof value === "string" && value) setImportPath(value);
    });
  }

  const recording = status?.recording;
  const watchHint = !status
    ? "正在读取状态…"
    : !status.logFound
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
        detail="检测 Teams 会议并询问记录；录音上传阿里云百炼转写（区分说话人）后由统一大模型生成结构化纪要。"
      />
      <StepIndicator
        steps={[
          { key: "record", label: "会议记录" },
          { key: "minutes", label: "纪要生成" },
          { key: "result", label: "结果" },
        ]}
        current={busy ? 1 : result ? 2 : 0}
      />
      {error && (
        <ErrorBox error={error} onDismiss={() => setError("")} />
      )}
      {job && (
        <JobProgress
          job={job}
          onCancel={busy && activeJobId ? (id) => void jobCancel(id) : undefined}
        />
      )}

      <section className="meeting-section" aria-labelledby="meeting-record-title">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 id="meeting-record-title" className="meeting-section-title">
                1. 会议记录
              </h2>
            </CardTitle>
            <CardDescription>
              加入 Teams 会议后工具箱会自动询问；也可以在这里手动控制，或导入已有录音。
            </CardDescription>
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
              <div className="meeting-status-item">
                <dt>说明</dt>
                <dd>{watchHint}</dd>
              </div>
              <div className="meeting-status-item">
                <dt>后台常驻</dt>
                <dd className="meeting-resident-cell">
                  <SwitchInput
                    checked={resident}
                    onChange={changeResident}
                    ariaLabel="后台常驻"
                  />
                  <span>
                    {resident
                      ? "关窗后驻留系统托盘继续监控，真正退出请用托盘菜单「退出」。"
                      : "关窗即退出工具箱，监控同时停止。"}
                  </span>
                </dd>
              </div>
            </dl>
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
                  disabled={recordBusy || busy}
                >
                  手动开始记录
                </Button>
              )}
            </div>
            <p className="meeting-import-note" role="note">
              录音包含系统声音与麦克风两轨，停止时自动混音；录音将上传阿里云百炼转写，请先告知参会人。
            </p>
            <FileDropInput
              value={importPath ? displayAudioFileName(importPath) : ""}
              placeholder="导入已有录音（wav / mp3 / m4a 等），点击右侧浏览选择"
              disabled={busy}
              onBrowse={browseAudio}
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
              标题与参会人名单可帮助纪要把「说话人N」对应到真实姓名；详细度影响纪要篇幅。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="meeting-options-grid">
              <label>
                会议标题（可选）
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="留空自动按时间命名"
                />
              </label>
              <label>
                参会人名单（可选，逗号分隔）
                <Input
                  value={participants}
                  onChange={(e) => setParticipants(e.target.value)}
                  placeholder="如：张三，李四，王五"
                />
              </label>
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
                disabled={!importPath || busy || recording}
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
              会议结束后自动转写并生成；转写与纪要保存在同一会议文件夹。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {result ? (
              <div className="meeting-result-card">
                <div className="meeting-result-meta">
                  <span>{result.title || "会议纪要"}</span>
                  {typeof result.speakerCount === "number" && result.speakerCount > 0 && (
                    <span>识别出 {result.speakerCount} 位说话人</span>
                  )}
                </div>
                {result.minutesError && (
                  <p role="alert" className="meeting-ask-error">
                    {result.minutesError}
                  </p>
                )}
                <div className="meeting-result-actions">
                  {result.minutesPath && (
                    <Button
                      variant="secondary"
                      onClick={() => void openOutput(result.minutesPath as string)}
                    >
                      打开会议纪要
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
                      从转写稿重新生成
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <EmptyState
                compact
                title="还没有会议纪要"
                description="结束一场被记录的会议，或从上方导入录音后生成；历史记录页可查看过往任务。"
              />
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
