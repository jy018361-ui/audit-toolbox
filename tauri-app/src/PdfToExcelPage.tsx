import { useEffect, useState } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenFileDrops,
  openOutput,
  pickPath,
} from "./api";
import type { ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import { errorText } from "@/lib/errors";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Field } from "@/components/Field";
import { FileDropInput } from "@/components/FileDropInput";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ConfirmDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useJobEvents } from "@/hooks/useJobEvents";
import { DataHandlingNotice } from "@/components/DataHandlingNotice";
import { EmptyState } from "@/components/EmptyState";
import {
  dedupePdfPaths,
  fileStatusLabel,
  fileStatusPill,
  filterPdfPaths,
  isPdfConvertResult,
  pdfFileName,
  summarizeFileResults,
  summarizeFileResultsText,
  type PdfConvertResult,
} from "./pdfToExcelUi";

export function pdfToExcelStep(
  fileCount: number,
  hasJob: boolean,
  hasResult: boolean,
): number {
  if (hasResult || hasJob) return 2;
  return fileCount > 0 ? 1 : 0;
}

/// 回函 PDF 转 Excel：批量把文字版回函逐行转成 Excel 并自动提取表格。
/// 结构对齐 FileListDirectoryPage（效率工具同组）：文件准备 → 输出位置 → 进度与结果。
export default function PdfToExcelPage({ tool }: { tool: ToolManifest }) {
  const [pdfPaths, setPdfPaths] = useState<string[]>([]);
  const [outputDir, setOutputDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PdfConvertResult>();
  const { job, setJob, activeJobId } = useJobEvents({
    toolId: "pdf_to_excel",
    onEvent: (event) => {
      setBusy(!["completed", "failed", "cancelled"].includes(event.phase));
      if (event.phase === "completed" && isPdfConvertResult(event.result)) {
        setResult(event.result);
      }
      if (event.phase === "failed" || event.phase === "cancelled") {
        const payload = event.result as
          { error?: { userMessage?: string } } | undefined;
        setError(payload?.error ? errorText(payload.error) : event.message);
      }
    },
  });

  // 批量输入集合发生任何变化时，旧转换结果已不再对应当前列表。
  // 同时用哨兵 jobId 拒绝已失效任务的迟到事件。
  useEffect(() => {
    setResult(undefined);
    setJob(undefined);
    activeJobId.current = "__input_changed__";
  }, [pdfPaths, setJob, activeJobId]);

  // 历史记录「继续任务」：回填上次的 PDF 列表与输出目录，不自动转换。
  useTaskRestore(tool.id, (restore) => {
    const params = restore.params as {
      pdfPaths?: string[];
      outputDir?: string;
    };
    if (Array.isArray(params.pdfPaths) && params.pdfPaths.length)
      setPdfPaths(dedupePdfPaths(params.pdfPaths));
    if (typeof params.outputDir === "string") setOutputDir(params.outputDir);
  });

  // 拖放：一次可拖入多份 PDF 或整个文件夹，展开后只保留 PDF。
  useEffect(() => {
    let off: () => void = () => undefined;
    void listenFileDrops((incoming) => {
      if (!incoming.length) return;
      void expandAndAdd(incoming);
    }).then((fn) => {
      off = fn;
    });
    return () => off();
  }, []);

  async function expandAndAdd(incoming: string[]) {
    setError("");
    try {
      const value = (await engineCall("excel_merger.expand_paths", {
        paths: incoming,
      })) as { inputPaths?: string[] };
      const pdfs = filterPdfPaths(value.inputPaths ?? incoming);
      if (!pdfs.length) {
        setError(
          "拖入的内容里没有 PDF 文件，请拖入回函 PDF 或包含回函的文件夹。",
        );
        return;
      }
      setPdfPaths((current) => dedupePdfPaths([...current, ...pdfs]));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function chooseFiles() {
    const value = await pickPath("files", "选择回函 PDF 文件", ["pdf"]);
    if (Array.isArray(value))
      setPdfPaths((current) => dedupePdfPaths([...current, ...value]));
  }

  async function chooseFolder() {
    const folder = await pickPath("folder", "选择包含回函 PDF 的文件夹", []);
    if (typeof folder === "string") await expandAndAdd([folder]);
  }

  async function chooseOutputDir() {
    const value = await pickPath("folder", "选择输出文件夹（可选）", []);
    if (typeof value === "string") setOutputDir(value);
  }

  async function start() {
    if (!pdfPaths.length) {
      setError("请先添加要转换的回函 PDF。");
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const jobId = await jobStart("pdf2excel.convert", {
        pdfPaths,
        outputDir: outputDir.trim(),
      });
      activeJobId.current = jobId;
      setJob({
        jobId,
        toolId: "pdf_to_excel",
        phase: "queued",
        current: 0,
        total: pdfPaths.length,
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const summary = result ? summarizeFileResults(result.files) : undefined;
  // 打开输出的落点：优先处理清单（汇总了全部输出），其次统一输出文件夹，最后第一份输出文件。
  const openTarget =
    result?.manifestPath ||
    (result ? outputDir.trim() : "") ||
    result?.outputPaths[0] ||
    "";
  const currentStep = pdfToExcelStep(
    pdfPaths.length,
    Boolean(job),
    Boolean(result),
  );

  return (
    <>
      <PageHeader
        eyebrow="PDF 整理"
        title={tool.name}
        detail="把文字版回函逐行转成 Excel，自动提取回函中的表格，支持批量处理。"
      />
      <DataHandlingNotice
        mode="local"
        title="回函文件仅在本机处理"
        description="PDF 读取、文字与表格提取、Excel 写出均在当前电脑完成，不会上传回函内容。"
        details="当前仅支持带文字层的 PDF；扫描件不会调用外部 OCR。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "选择文件", disabled: true },
          { key: "2", label: "开始转换", disabled: true },
          { key: "3", label: "查看结果", disabled: true },
        ]}
        current={currentStep}
      />
      <div className="fa-stack">
        <Card>
          <CardHeader>
            <CardTitle>1. 选择回函 PDF</CardTitle>
            <Badge
              className={pdfPaths.length ? "badge-ready" : "badge-neutral"}
            >
              {pdfPaths.length ? `已添加 ${pdfPaths.length} 份` : "待添加"}
            </Badge>
          </CardHeader>
          <CardContent>
            <ErrorBox error={error} onDismiss={() => setError("")} />
            <button
              type="button"
              className="drop-zone"
              disabled={busy}
              onClick={() => void chooseFiles()}
            >
              <strong>拖放回函 PDF 或文件夹到窗口</strong>
              <span>
                可一次拖入多份；拖入文件夹会自动找出其中的全部
                PDF，也可点击选择文件
              </span>
            </button>
            <div className="merger-toolbar">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void chooseFiles()}
              >
                选择文件
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void chooseFolder()}
              >
                选择文件夹
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy || !pdfPaths.length}
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: "确认清空列表",
                      message: `确认清空当前 ${pdfPaths.length} 份 PDF？只会清空本次列表，不会删除原文件。`,
                      confirmLabel: "清空",
                      tone: "danger",
                    })
                  )
                    setPdfPaths([]);
                }}
              >
                清空列表
              </Button>
            </div>
            <div className="file-queue">
              {pdfPaths.length ? (
                pdfPaths.map((path, index) => (
                  <div className="file-item" key={path}>
                    <div>
                      <strong>{pdfFileName(path)}</strong>
                      <span title={path}>{path}</span>
                    </div>
                    <div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`移除 ${pdfFileName(path)}`}
                        disabled={busy}
                        onClick={() =>
                          setPdfPaths((current) =>
                            current.filter((_, i) => i !== index),
                          )
                        }
                      >
                        移除
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <EmptyState
                  compact
                  title="尚未添加 PDF 文件"
                  description="选择回函 PDF 或文件夹后，可在此确认待处理列表。"
                />
              )}
            </div>
            <p className="hint">
              已添加 {pdfPaths.length} 份 PDF；重复拖入的同一份只保留一次。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. 输出位置与开始转换</CardTitle>
          </CardHeader>
          <CardContent>
            <Field label="输出文件夹（可选）">
              <div title={outputDir || undefined}>
                <FileDropInput
                  value={outputDir}
                  placeholder="拖放或点击选择输出文件夹"
                  onBrowse={() => void chooseOutputDir()}
                  onClear={outputDir ? () => setOutputDir("") : undefined}
                  onDragStateChange={() => {}}
                  disabled={busy}
                />
              </div>
            </Field>
            <p className="hint">
              留空则输出到每份 PDF
              所在文件夹，文件名自动生成；另会生成一份“处理清单”汇总全部结果。
            </p>
            <div className="actions">
              {busy && job ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void jobCancel(job.jobId)}
                >
                  取消任务
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="default"
                  disabled={!pdfPaths.length}
                  onClick={() => void start()}
                >
                  开始转换
                </Button>
              )}
            </div>
            {!pdfPaths.length && (
              <p className="hint">请先添加回函 PDF，再开始转换。</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. 进度与结果</CardTitle>
          </CardHeader>
          <CardContent>
            {job && job.phase !== "completed" && (
              <JobProgress
                job={job}
                onCancel={(jobId) => void jobCancel(jobId)}
                cancelLabel="取消任务"
              />
            )}
            {result && summary ? (
              <>
                <p className="hint">{summarizeFileResultsText(summary)}</p>
                <div className="data-table">
                  <div className="data-table-scroll">
                    <table className="data-table-table">
                      <thead>
                        <tr>
                          <th>文件名</th>
                          <th>状态</th>
                          <th>页数</th>
                          <th>正文行数</th>
                          <th>表格数</th>
                          <th>表格数据行</th>
                          <th>失败原因</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.files.map((row, index) => (
                          <tr key={`${row.outputPath || row.name}#${index}`}>
                            <td title={row.name}>{row.name}</td>
                            <td>
                              <span className={fileStatusPill(row)}>
                                {fileStatusLabel(row)}
                              </span>
                            </td>
                            <td>{row.pages}</td>
                            <td>{row.textRows}</td>
                            <td>{row.tables}</td>
                            <td>{row.tableDataRows}</td>
                            <td title={row.error}>{row.error}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                {openTarget && (
                  <div className="actions">
                    <Button
                      type="button"
                      variant="default"
                      title={openTarget}
                      onClick={() => void openOutput(openTarget)}
                    >
                      打开输出
                    </Button>
                  </div>
                )}
              </>
            ) : (
              !job && (
                <EmptyState
                  title="等待转换结果"
                  description={
                    pdfPaths.length
                      ? "开始转换后，这里会显示总体进度和每份回函的处理结果。"
                      : "先添加回函 PDF，再开始转换。"
                  }
                />
              )
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
