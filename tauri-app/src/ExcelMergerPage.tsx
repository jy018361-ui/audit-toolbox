import { useEffect, useRef, useState } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenFileDrops,
  listenJobEvents,
  pickPath,
} from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import { errorText } from "@/lib/errors";
import { formatSize, parentPath } from "@/lib/utils";
import { ResultView } from "@/components/ResultView";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ConfirmDialog";
import { DataHandlingNotice } from "@/components/DataHandlingNotice";
import { EmptyState } from "@/components/EmptyState";

type MergerFile = {
  path: string;
  name: string;
  size: number;
  sheets: string[];
  format?: string;
  error?: string | null;
};

export function excelMergerStep(
  pathCount: number,
  inspectedCount: number,
  hasJob: boolean,
): number {
  if (hasJob) return 2;
  if (pathCount > 0 && inspectedCount > 0) return 1;
  return 0;
}

export function excelMergerClearPrompt(pathCount: number): string {
  return `确认清空当前 ${pathCount} 个待合并文件？只会清空本次列表，不会删除原文件。`;
}

export function ExcelMergerPage({ tool }: { tool: ToolManifest }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [files, setFiles] = useState<MergerFile[]>([]);
  const [availableSheets, setAvailableSheets] = useState<string[]>([]);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [outputDirectoryTouched, setOutputDirectoryTouched] = useState(false);
  const [outputFormat, setOutputFormat] = useState("xlsx");
  const [outputMode, setOutputMode] = useState("one_sheet");
  const [direction, setDirection] = useState("vertical");
  // Legacy always opened a sheet picker with every sheet pre-checked, so the
  // default merge covered all sheets.  Defaulting to "first sheet only" quietly
  // dropped data for anyone who kept their old habits.
  const [sheetAction, setSheetAction] = useState("merge_all");
  const [targetSheets, setTargetSheets] = useState<string[]>([]);
  const [addHyperlinks, setAddHyperlinks] = useState(true);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobEvent>();
  const [error, setError] = useState("");
  const [result, setResult] = useState<unknown>();
  const activeJobId = useRef("");
  const addPaths = (incoming: string[]) =>
    setPaths((current) => [
      ...current,
      ...incoming.filter(
        (path) =>
          !current.some(
            (old) => old.toLocaleLowerCase() === path.toLocaleLowerCase(),
          ),
      ),
    ]);
  useEffect(() => {
    let off: () => void = () => {};
    void listenFileDrops((incoming) => {
      void engineCall("excel_merger.expand_paths", { paths: incoming })
        .then((value) =>
          addPaths((value as { inputPaths?: string[] }).inputPaths ?? []),
        )
        .catch((e) => setError(errorText(e)));
    }).then((value) => {
      off = value;
    });
    return () => off();
  }, []);
  useEffect(() => {
    let off: () => void = () => {};
    void listenJobEvents((event) => {
      if (event.toolId === "Excel_Merger") {
        if (!activeJobId.current || event.jobId !== activeJobId.current) return;
        setJob(event);
        // A failed job also carries a result payload; rendering it produced a
        // green "处理完成。" directly under the red failure banner.
        if (event.phase === "failed" || event.phase === "cancelled") {
          setResult(undefined);
          const payload = event.result as
            { error?: { userMessage?: string } } | undefined;
          setError(payload?.error ? errorText(payload.error) : event.message);
        } else if (event.result) {
          setResult(event.result);
        }
        setBusy(!["completed", "failed", "cancelled"].includes(event.phase));
      }
    }).then((value) => {
      off = value;
    });
    return () => off();
  }, []);
  // 历史恢复暂存的目标 Sheet：paths 变化的副作用会清空 targetSheets，
  // 恢复的自定义 Sheet 子集要等副作用跑完再补回。
  const pendingTargetSheets = useRef<string[] | null>(null);
  useEffect(() => {
    setFiles([]);
    setAvailableSheets([]);
    setTargetSheets(pendingTargetSheets.current ?? []);
    pendingTargetSheets.current = null;
    setResult(undefined);
    setJob(undefined);
    activeJobId.current = "";
  }, [paths]);
  useEffect(() => {
    if (!outputDirectoryTouched)
      setOutputDirectory(paths[0] ? parentPath(paths[0]) : "");
  }, [paths, outputDirectoryTouched]);

  // 历史记录「继续任务」：回填文件列表与全部合并选项，不自动检查文件
  // （检查会用实际 Sheet 清单覆盖自定义 Sheet 子集）。
  useTaskRestore(tool.id, (restore) => {
    const p = restore.params as {
      inputPaths?: string[];
      outputDirectory?: string;
      outputFormat?: string;
      outputMode?: string;
      direction?: string;
      sheetAction?: string;
      targetSheets?: string[];
      addHyperlinks?: boolean;
    };
    if (!Array.isArray(p.inputPaths) || !p.inputPaths.length) return;
    const restoredSheets = Array.isArray(p.targetSheets)
      ? p.targetSheets
      : null;
    const samePaths =
      p.inputPaths.length === paths.length &&
      p.inputPaths.every((value, index) => value === paths[index]);
    if (samePaths) {
      setTargetSheets(restoredSheets ?? []);
      pendingTargetSheets.current = null;
    } else {
      pendingTargetSheets.current = restoredSheets;
      setPaths(p.inputPaths);
    }
    if (typeof p.outputDirectory === "string" && p.outputDirectory) {
      setOutputDirectory(p.outputDirectory);
      setOutputDirectoryTouched(true);
    }
    if (typeof p.outputFormat === "string" && p.outputFormat)
      setOutputFormat(p.outputFormat);
    if (typeof p.outputMode === "string" && p.outputMode)
      setOutputMode(p.outputMode);
    if (typeof p.direction === "string" && p.direction)
      setDirection(p.direction);
    if (typeof p.sheetAction === "string" && p.sheetAction)
      setSheetAction(p.sheetAction);
    if (typeof p.addHyperlinks === "boolean")
      setAddHyperlinks(p.addHyperlinks);
    setError("");
    setResult(undefined);
    setJob(undefined);
  });
  async function chooseFiles() {
    const value = await pickPath("files", "添加 Excel、CSV 或 TXT", [
      "xlsx",
      "xls",
      "xlsm",
      "csv",
      "txt",
    ]);
    if (Array.isArray(value)) addPaths(value);
  }
  async function chooseFolder() {
    const folder = await pickPath("folder", "扫描包含表格的文件夹", []);
    if (typeof folder !== "string") return;
    setError("");
    try {
      const value = (await engineCall("excel_merger.scan_folder", {
        folder,
      })) as { inputPaths?: string[] };
      addPaths(value.inputPaths ?? []);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function inspect() {
    if (!paths.length) {
      setError("请先添加需要合并的文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const value = (await engineCall("excel_merger.inspect", {
        inputPaths: paths,
      })) as { files: MergerFile[]; availableSheets: string[] };
      setFiles(value.files);
      setAvailableSheets(value.availableSheets);
      setTargetSheets(value.availableSheets);
      setResult(value);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function chooseOutputDirectory() {
    const value = await pickPath("folder", "选择输出目录", []);
    if (typeof value === "string") {
      setOutputDirectory(value);
      setOutputDirectoryTouched(true);
    }
  }
  async function start() {
    if (!paths.length) {
      setError("请先添加输入文件。");
      return;
    }
    if (sheetAction === "match_selected" && !targetSheets.length) {
      setError("按名称匹配时请至少选择一个 Sheet。");
      return;
    }
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const jobId = await jobStart("excel_merger.merge", {
        inputPaths: paths,
        outputDirectory,
        outputFormat: outputMode === "one_workbook" ? "xlsx" : outputFormat,
        outputMode,
        direction,
        sheetAction,
        targetSheets,
        addHyperlinks,
      });
      activeJobId.current = jobId;
      setJob({
        jobId,
        toolId: "Excel_Merger",
        phase: "queued",
        current: 0,
        total: 1,
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  function move(index: number, delta: number) {
    const next = index + delta;
    if (next < 0 || next >= paths.length) return;
    setPaths((current) => {
      const copy = [...current];
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
  }
  function toggleSheet(name: string) {
    setTargetSheets((current) =>
      current.includes(name)
        ? current.filter((value) => value !== name)
        : [...current, name],
    );
  }
  const currentStep = excelMergerStep(paths.length, files.length, Boolean(job));
  const clearFiles = async () => {
    if (!paths.length) return;
    if (
      !(await confirmDialog({
        title: "确认清空列表",
        message: excelMergerClearPrompt(paths.length),
        confirmLabel: "清空",
        tone: "danger",
      }))
    )
      return;
    setPaths([]);
  };
  return (
    <>
      <PageHeader
        eyebrow="批量 Excel 合并"
        title={tool.name}
        detail="批量合并 Excel、CSV 与 TXT，可按 Sheet 范围和拼接方向生成结果。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "文件源", disabled: true },
          { key: "2", label: "合并规则", disabled: true },
          { key: "3", label: "执行合并", disabled: true },
        ]}
        current={currentStep}
      />
      <div className="merger-layout">
        <section className="form-card merger-source">
          <div className="section-title">
            <h2>1. 文件源</h2>
            <span>{paths.length} 个文件</span>
          </div>
          <button
            type="button"
            className="drop-zone"
            onClick={() => void chooseFiles()}
          >
            <strong>拖放文件或文件夹到窗口</strong>
            <span>支持 XLSX、XLS、XLSM、CSV、TXT，也可点击添加文件</span>
          </button>
          <DataHandlingNotice
            mode="local"
            title="文件仅在本机处理"
            description="文件读取、合并和结果写出均在当前电脑完成，不会上传表格内容。"
            className="merger-data-notice"
          />
          <div className="merger-toolbar">
            <Button variant="secondary" onClick={() => void chooseFiles()}>
              添加文件
            </Button>
            <Button variant="secondary" onClick={() => void chooseFolder()}>
              扫描文件夹
            </Button>
            <Button
              variant="destructive"
              disabled={!paths.length}
              onClick={clearFiles}
            >
              清空列表
            </Button>
          </div>
          <div className="file-queue">
            {paths.length ? (
              paths.map((path, index) => {
                const detail = files.find((item) => item.path === path);
                return (
                  <div className="file-item" key={path}>
                    <div>
                      <strong>
                        {detail?.name ?? path.split(/[\\/]/).pop()}
                      </strong>
                      <span>
                        {detail
                          ? `${formatSize(detail.size)} · ${detail.error ? "读取失败" : detail.sheets.length ? detail.sheets.join("、") : detail.format ?? "无工作表"}`
                          : path}
                      </span>
                      {detail?.error && <em>{detail.error}</em>}
                    </div>
                    <div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`上移 ${detail?.name ?? path.split(/[\\/]/).pop() ?? "文件"}`}
                        title="上移"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`下移 ${detail?.name ?? path.split(/[\\/]/).pop() ?? "文件"}`}
                        title="下移"
                        disabled={index === paths.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`移除 ${detail?.name ?? path.split(/[\\/]/).pop() ?? "文件"}`}
                        onClick={() =>
                          setPaths((current) =>
                            current.filter((_, i) => i !== index),
                          )
                        }
                      >
                        移除
                      </Button>
                    </div>
                  </div>
                );
              })
            ) : (
              <EmptyState
                compact
                title="尚未添加文件"
                description="添加文件或扫描文件夹后，可检查 Sheet 并设置合并顺序。"
              />
            )}
          </div>
          <div className="actions">
            <Button
              variant="secondary"
              disabled={busy || !paths.length}
              onClick={() => void inspect()}
            >
              检查文件与 Sheet
            </Button>
          </div>
        </section>
        <section className="form-card merger-rules">
          <div className="section-title">
            <h2>2. 合并规则</h2>
            <span>
              {files.length
                ? `已检查 ${files.length} 个文件`
                : "检查后配置规则"}
            </span>
          </div>
          <fieldset>
            <legend>输出目标</legend>
            <label>
              <input
                type="radio"
                checked={outputMode === "one_sheet"}
                onChange={() => setOutputMode("one_sheet")}
              />{" "}
              合并成一张大表（One Sheet）
            </label>
            <label>
              <input
                type="radio"
                checked={outputMode === "one_workbook"}
                onChange={() => setOutputMode("one_workbook")}
              />{" "}
              合并成一个工作簿（多 Sheet）
            </label>
          </fieldset>
          <fieldset disabled={outputMode === "one_workbook"}>
            <legend>拼接方向</legend>
            <label>
              <input
                type="radio"
                checked={direction === "vertical"}
                onChange={() => setDirection("vertical")}
              />{" "}
              纵向堆叠（上下拼）
            </label>
            <label>
              <input
                type="radio"
                checked={direction === "horizontal"}
                onChange={() => setDirection("horizontal")}
              />{" "}
              横向拼接（左右拼）
            </label>
          </fieldset>
          <fieldset>
            <legend>Sheet 范围</legend>
            <label>
              <input
                type="radio"
                checked={sheetAction === "default"}
                onChange={() => setSheetAction("default")}
              />{" "}
              每个文件仅取第一个 Sheet
            </label>
            <label>
              <input
                type="radio"
                checked={sheetAction === "match_selected"}
                onChange={() => setSheetAction("match_selected")}
              />{" "}
              按名称匹配所选 Sheet
            </label>
            <label>
              <input
                type="radio"
                checked={sheetAction === "merge_all"}
                onChange={() => setSheetAction("merge_all")}
              />{" "}
              合并所有 Sheet
            </label>
          </fieldset>
          {sheetAction === "match_selected" && (
            <div className="sheet-picker">
              <div>
                <span>目标 Sheet</span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setTargetSheets(availableSheets)}
                >
                  全选
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setTargetSheets([])}
                >
                  全不选
                </Button>
              </div>
              {availableSheets.length ? (
                availableSheets.map((name) => (
                  <label key={name}>
                    <input
                      type="checkbox"
                      checked={targetSheets.includes(name)}
                      onChange={() => toggleSheet(name)}
                    />
                    {name}
                  </label>
                ))
              ) : (
                <p>请先执行「检查文件与 Sheet」。</p>
              )}
            </div>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={addHyperlinks}
              onChange={(e) => setAddHyperlinks(e.target.checked)}
            />
            加入源文件超链接（大文件会降低导出速度）
          </label>
          <div className="format-row">
            <span>输出格式</span>
            <label>
              <input
                type="radio"
                checked={outputFormat === "xlsx"}
                onChange={() => setOutputFormat("xlsx")}
              />{" "}
              XLSX
            </label>
            <label>
              <input
                type="radio"
                disabled={outputMode === "one_workbook"}
                checked={
                  outputMode !== "one_workbook" && outputFormat === "csv"
                }
                onChange={() => setOutputFormat("csv")}
              />{" "}
              CSV
            </label>
          </div>
          <div className="output-row">
            <input
              value={outputDirectory}
              readOnly
              title={outputDirectory}
              placeholder="添加文件后自动填入默认保存目录"
              aria-label="输出目录"
            />
            <Button
              variant="secondary"
              className="browse"
              onClick={() => void chooseOutputDirectory()}
            >
              选择目录
            </Button>
            {outputDirectoryTouched && (
              <Button
                variant="secondary"
                className="browse"
                onClick={() => setOutputDirectoryTouched(false)}
              >
                恢复默认
              </Button>
            )}
          </div>
          <p className="output-hint">
            {outputDirectoryTouched
              ? "已指定输出目录。"
              : "默认保存到第一个输入文件所在目录。"}
            文件名自动生成：Excel合并结果_日期_时间.
            {outputMode === "one_workbook" ? "xlsx" : outputFormat}
          </p>
          {error && <div className="error-box">{error}</div>}
          <div className="actions">
            {busy && job ? (
              <Button
                variant="secondary"
                onClick={() => void jobCancel(job.jobId)}
              >
                停止执行
              </Button>
            ) : (
              <Button disabled={!paths.length} onClick={() => void start()}>
                开始合并
              </Button>
            )}
          </div>
        </section>
      </div>
      <section className="result-card merger-progress">
        <h2>进度与结果</h2>
        {job ? (
          <>
            <div className={`job-banner ${job.severity}`}>
              <strong>{job.message}</strong>
            </div>
            {!["failed", "cancelled"].includes(job.phase) && (
              <progress
                max={Math.max(job.total, 1)}
                value={job.total ? job.current : 0}
              />
            )}
            {result && <ResultView value={result} />}
          </>
        ) : result ? (
          <ResultView value={result} />
        ) : (
          <EmptyState
            compact
            title={
              !paths.length
                ? "等待添加文件"
                : !files.length
                  ? "等待检查文件结构"
                  : "可以开始合并"
            }
            description={
              !paths.length
                ? "添加文件或扫描文件夹后，可在这里查看检查结果与合并进度。"
                : !files.length
                  ? "先检查文件与 Sheet，确认结构后再设置合并规则。"
                  : "规则已就绪，开始合并后可在这里查看进度与输出结果。"
            }
          />
        )}
      </section>
    </>
  );
}
