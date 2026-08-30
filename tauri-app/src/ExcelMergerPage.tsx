import { useEffect, useState } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenFileDrops,
  listenJobEvents,
  pickPath,
} from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { errorText } from "@/lib/errors";
import { formatSize, parentPath } from "@/lib/utils";
import { ResultView } from "@/components/ResultView";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";

type MergerFile = {
  path: string;
  name: string;
  size: number;
  sheets: string[];
  error?: string | null;
};

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
  useEffect(() => {
    setFiles([]);
    setAvailableSheets([]);
    setTargetSheets([]);
  }, [paths]);
  useEffect(() => {
    if (!outputDirectoryTouched)
      setOutputDirectory(paths[0] ? parentPath(paths[0]) : "");
  }, [paths, outputDirectoryTouched]);
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
  return (
    <>
      <PageHeader
        eyebrow="批量 Excel 合并"
        title={tool.name}
        detail="Rust 直接读取和写出表格；多 Sheet 模式通过 Excel 原生接口原样复制，不再调用 Python 合并库。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "文件源", disabled: true },
          { key: "2", label: "合并规则", disabled: true },
          { key: "3", label: "执行合并", disabled: true },
        ]}
        current={0}
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
          <div className="merger-toolbar">
            <button className="secondary" onClick={() => void chooseFiles()}>
              添加文件
            </button>
            <button className="secondary" onClick={() => void chooseFolder()}>
              扫描文件夹
            </button>
            <button
              className="ghost"
              disabled={!paths.length}
              onClick={() => setPaths([])}
            >
              清空列表
            </button>
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
                          ? `${formatSize(detail.size)} · ${detail.sheets.length ? detail.sheets.join("、") : "文本文件"}`
                          : path}
                      </span>
                      {detail?.error && <em>{detail.error}</em>}
                    </div>
                    <div>
                      <button
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        disabled={index === paths.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        onClick={() =>
                          setPaths((current) =>
                            current.filter((_, i) => i !== index),
                          )
                        }
                      >
                        移除
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="empty compact">尚未添加文件</div>
            )}
          </div>
          <div className="actions">
            <button
              className="secondary"
              disabled={busy || !paths.length}
              onClick={() => void inspect()}
            >
              检查文件与 Sheet
            </button>
          </div>
        </section>
        <section className="form-card merger-rules">
          <div className="section-title">
            <h2>2. 合并规则</h2>
            <span className="pill ready">Rust 原生引擎</span>
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
                <button onClick={() => setTargetSheets(availableSheets)}>
                  全选
                </button>
                <button onClick={() => setTargetSheets([])}>全不选</button>
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
                <p>请先执行"检查文件与 Sheet"。</p>
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
            />
            <button
              className="browse"
              onClick={() => void chooseOutputDirectory()}
            >
              选择目录
            </button>
            {outputDirectoryTouched && (
              <button
                className="browse"
                onClick={() => setOutputDirectoryTouched(false)}
              >
                恢复默认
              </button>
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
              <button
                className="secondary"
                onClick={() => void jobCancel(job.jobId)}
              >
                停止执行
              </button>
            ) : (
              <button
                className="primary"
                disabled={!paths.length}
                onClick={() => void start()}
              >
                开始合并
              </button>
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
            <progress
              max={Math.max(job.total, 1)}
              value={job.total ? job.current : 0}
            />
            {result && <ResultView value={result} />}
          </>
        ) : result ? (
          <ResultView value={result} />
        ) : (
          <div className="empty compact">检查结果和合并进度将在这里显示。</div>
        )}
      </section>
    </>
  );
}
