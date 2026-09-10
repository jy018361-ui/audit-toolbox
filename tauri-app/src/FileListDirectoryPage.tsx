import { useEffect, useState } from "react";
import {
  jobCancel,
  jobStart,
  listenJobEvents,
  openOutput,
  pickPath,
} from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  fileListCanExport,
  isFileListScan,
  type FileListScan,
} from "./fileListUi";
import "./file-list.css";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { displayFileName } from "@/fileDisplay";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Field } from "@/components/Field";
import { FileDropInput } from "@/components/FileDropInput";
import { FileInput } from "@/components/FileInput";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ConfirmDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";

const CACHE_KEY = "audit-toolbox:file-list-directory:v1";

function messageOf(error: unknown) {
  if (error && typeof error === "object" && "userMessage" in error) {
    return String((error as { userMessage: unknown }).userMessage);
  }
  return error instanceof Error ? error.message : String(error);
}

export default function FileListDirectoryPage({
  tool,
}: {
  tool: ToolManifest;
}) {
  const [sourceDir, setSourceDir] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [scan, setScan] = useState<FileListScan>();
  const [job, setJob] = useState<JobEvent>();
  const [activeJobId, setActiveJobId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState<1 | 2>(1);
  const [dragHover, setDragHover] = useState(false);

  useEffect(() => {
    try {
      const cached = JSON.parse(
        sessionStorage.getItem(CACHE_KEY) ?? "null",
      ) as {
        sourceDir?: string;
        outputPath?: string;
        scan?: unknown;
      } | null;
      if (cached?.sourceDir) setSourceDir(cached.sourceDir);
      if (cached?.outputPath) setOutputPath(cached.outputPath);
      if (isFileListScan(cached?.scan)) setScan(cached.scan);
    } catch {
      sessionStorage.removeItem(CACHE_KEY);
    }
  }, []);

  useEffect(() => {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ sourceDir, outputPath, scan }),
    );
  }, [sourceDir, outputPath, scan]);

  // 历史记录「继续任务」：回填扫描目录与输出路径。不自动重扫——
  // 扫描是任务通道，恢复瞬间弹进度窗反而吓人，用户点「扫描」即可。
  useTaskRestore(tool.id, (restore) => {
    const params = restore.params as {
      sourceDir?: string;
      outputPath?: string;
    };
    if (typeof params.sourceDir === "string" && params.sourceDir)
      setSourceDir(params.sourceDir);
    if (typeof params.outputPath === "string" && params.outputPath)
      setOutputPath(params.outputPath);
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listenJobEvents((event) => {
      if (event.toolId !== "file_list_directory") return;
      if (activeJobId && event.jobId !== activeJobId) return;
      setJob(event);
      // 扫描和导出共用同一条任务通道，靠结果形状区分：扫描回来的是预览数据。
      const payload = event.result;
      if (event.phase === "completed" && isFileListScan(payload)) {
        setScan(payload);
        setOutputPath((current) => current || payload.outputPath);
      }
      if (["completed", "failed", "cancelled"].includes(event.phase)) {
        setBusy(false);
      }
    }).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, [activeJobId]);

  // 拖放上传：把文件夹拖进窗口即选择扫描范围，并自动开始扫描。
  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
      return;
    let off: () => void = () => {};
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "enter") {
          setDragHover(true);
        } else if (payload.type === "drop") {
          setDragHover(false);
          if (payload.paths.length) {
            setActiveJobId("__source_changed__");
            setSourceDir(payload.paths[0]);
            setOutputPath("");
            setScan(undefined);
            setJob(undefined);
            setStep(1);
            void inspect(payload.paths[0]);
          }
        } else if (payload.type === "leave") {
          setDragHover(false);
        }
      })
      .then((fn) => {
        off = fn;
      })
      .catch((e) => console.error("[file-list] drag listener error:", e));
    return () => off();
  }, []);

  async function inspect(path = sourceDir) {
    if (!path.trim()) {
      setError("请先选择要扫描的文件夹。");
      return;
    }
    setBusy(true);
    setError("");
    setJob(undefined);
    try {
      // 扫描改走任务通道：大目录（共享盘根目录、误选的 C:\）原本没有进度、
      // 也无法取消，用户只能干等或强杀程序。
      setActiveJobId(await jobStart("file_list.scan", { sourceDir: path }));
    } catch (reason) {
      setError(messageOf(reason));
      setScan(undefined);
      setBusy(false);
    }
  }

  async function chooseSource() {
    const value = await pickPath("folder", "选择要生成清单的文件夹", []);
    if (typeof value !== "string") return;
    setActiveJobId("__source_changed__");
    setSourceDir(value);
    setOutputPath("");
    setScan(undefined);
    setJob(undefined);
    setStep(1);
    await inspect(value);
  }

  async function chooseOutput() {
    const value = await pickPath("save", "保存 Excel 文件清单", ["xlsx"]);
    if (typeof value === "string") setOutputPath(value);
  }

  function clear() {
    setSourceDir("");
    setOutputPath("");
    setScan(undefined);
    setJob(undefined);
    setActiveJobId("");
    setError("");
    setStep(1);
    sessionStorage.removeItem(CACHE_KEY);
  }

  async function start() {
    if (!fileListCanExport(sourceDir, outputPath)) {
      setError("请先选择源文件夹并确认输出文件。");
      return;
    }
    // The output path is pre-filled, so the legacy "另存为" dialog — and with it
    // Windows' own overwrite prompt — never appears.  A clean re-run would
    // silently discard any review notes added to the previous list.
    if (
      outputPath === scan?.outputPath &&
      !(await confirmDialog({
        title: "确认覆盖文件",
        message: `将覆盖文件“${displayFileName(outputPath)}”，其中的手工批注会丢失。是否继续？`,
        confirmLabel: "继续",
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    setError("");
    setJob(undefined);
    try {
      const id = await jobStart("file_list.export", { sourceDir, outputPath });
      setActiveJobId(id);
    } catch (reason) {
      setBusy(false);
      setError(messageOf(reason));
    }
  }

  const terminal =
    job && ["completed", "failed", "cancelled"].includes(job.phase);
  return (
    <>
      <PageHeader
        eyebrow="文件夹清单生成"
        title={tool.name}
        detail="递归扫描文件夹，按层级导出文件名、可点击超链接与完整路径。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "选择文件夹" },
          { key: "2", label: "确认并生成", disabled: !scan },
        ]}
        current={step - 1}
        onStepClick={(index) => setStep((index + 1) as 1 | 2)}
      />
      <div className="fa-stack">
        <Card>
          <CardHeader>
            <CardTitle>
              {step === 1 ? "1. 选择扫描范围" : "2. 确认输出并生成"}
            </CardTitle>
            <Badge className={scan ? "badge-ready" : "badge-neutral"}>
              {busy && !scan ? "扫描中" : scan ? "扫描完成" : "待选择"}
            </Badge>
          </CardHeader>
          <CardContent>
            <ErrorBox error={error} onDismiss={() => setError("")} />
            {step === 1 && (
              <>
                <Field label="源文件夹" required>
                  <div title={sourceDir || undefined}>
                    <FileDropInput
                      value={sourceDir}
                      placeholder="拖放或点击选择要扫描的文件夹"
                      onBrowse={() => void chooseSource()}
                      onClear={sourceDir ? clear : undefined}
                      onDragStateChange={() => {}}
                      highlight={dragHover}
                      disabled={busy}
                    />
                  </div>
                </Field>
                <p className="hint">
                  选择文件夹后会自动扫描；大目录扫描需要几分钟，可随时取消。
                </p>
                <div className="actions">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy || !sourceDir}
                    onClick={() => void inspect()}
                  >
                    {busy && !scan ? "正在扫描…" : "重新扫描"}
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    disabled={!scan || busy}
                    onClick={() => setStep(2)}
                  >
                    下一步：输出文件
                  </Button>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <Field label="输出 Excel 文件" required>
                  <FileInput
                    value={outputPath}
                    placeholder="默认保存到源文件夹的上一级目录"
                    ariaLabel="输出 Excel 文件"
                    browseLabel="选择"
                    onBrowse={() => void chooseOutput()}
                  />
                </Field>
                <p className="hint">
                  默认文件名与旧版一致：“文件夹名List-年月日时分.xlsx”。文件数量多时导出需要几分钟，中途可随时取消。
                </p>
                <div className="actions">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setStep(1)}
                  >
                    上一步
                  </Button>
                  {busy && activeJobId && !terminal ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void jobCancel(activeJobId)}
                    >
                      取消{job?.phase === "scan" || !scan ? "扫描" : "导出"}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="default"
                      disabled={!fileListCanExport(sourceDir, outputPath)}
                      onClick={() => void start()}
                    >
                      生成文件清单
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>扫描预览</CardTitle>
          </CardHeader>
          <CardContent>
            {!scan ? (
              <EmptyState
                title="等待扫描文件夹"
                description="选择文件夹后，这里会显示前 50 个文件及目录层级。"
                action={
                  <Button
                    variant="secondary"
                    onClick={() => void chooseSource()}
                  >
                    选择文件夹
                  </Button>
                }
              />
            ) : scan.fileCount === 0 ? (
              <EmptyState
                title="文件夹中没有可列出的文件"
                description="仍可继续生成一份只含标题的 Excel 清单。"
              />
            ) : (
              <>
                <p className="hint">
                  {scan.fileCount} 个文件 · {scan.maxDepth + 1} 级目录列
                </p>
                <div className="file-list-table-wrap">
                  <table className="file-list-table">
                    <thead>
                      <tr>
                        {Array.from(
                          { length: scan.maxDepth + 1 },
                          (_, index) => (
                            <th key={index}>{index + 1}级文件夹</th>
                          ),
                        )}
                        <th>文件名称</th>
                        <th>相对路径</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scan.preview.map((row) => (
                        <tr key={row.fullPath}>
                          {Array.from(
                            { length: scan.maxDepth + 1 },
                            (_, index) => (
                              <td key={index} title={row.levels[index] ?? ""}>
                                {row.levels[index] ?? ""}
                              </td>
                            ),
                          )}
                          <td title={row.name}>{row.name}</td>
                          <td title={row.relativePath}>
                            {displayFileName(row.relativePath)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {scan && scan.fileCount > scan.preview.length && (
              <p className="hint">
                预览仅显示前 {scan.preview.length} 项；导出会包含全部{" "}
                {scan.fileCount} 个文件。
              </p>
            )}
            {!!scan?.skippedPaths?.length && (
              <div className="warning-box">
                <strong>
                  以下 {scan.skippedPaths.length}{" "}
                  个路径无法访问，已跳过（清单中不含其内容）
                </strong>
                <ul>
                  {scan.skippedPaths.slice(0, 20).map((path) => (
                    <li key={path} title={path}>
                      {displayFileName(path)}
                    </li>
                  ))}
                </ul>
                {scan.skippedPaths.length > 20 && (
                  <p>另有 {scan.skippedPaths.length - 20} 项未显示。</p>
                )}
              </div>
            )}
            {job && (
              <JobProgress
                job={job}
                onCancel={() => void jobCancel(activeJobId)}
                cancelLabel="取消任务"
              />
            )}
            {job && job.outputPaths.length > 0 && (
              <div className="output-list">
                {job.outputPaths.map((path) => (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    key={path}
                    title={path}
                    onClick={() => void openOutput(path)}
                  >
                    打开结果：{displayFileName(path)}
                  </Button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
