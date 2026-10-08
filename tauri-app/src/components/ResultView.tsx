import { openOutput } from "@/api";
import { displayFileName } from "@/fileDisplay";
import "./task-state.css";

const RESULT_COUNT_LABELS: Record<string, string> = {
  rows: "处理行数",
  rowCount: "处理行数",
  matched: "匹配数量",
  unmatched: "未匹配数量",
  processed: "处理数量",
  exported: "导出数量",
  fileCount: "文件数量",
  sheetCount: "工作表数量",
  // WP 服务单 has no dedicated page, so its numbers have to land here.
  services: "服务方案",
  aud2026Rows: "AUD2026",
  aud2025Rows: "AUD2025",
  ipoRows: "IPO",
  ipoArchiveRows: "IPO archive",
  matchedSectionOrders: "匹配服务单",
  populatedSectionRows: "有数据 Section",
  outlookCompared: "可核对",
  outlookEqual: "核对一致",
  // FA TB＋JE 预览指标
  tbRows: "TB 科目行",
  jeRows: "JE 明细行",
  additions: "新增笔数",
  disposals: "处置笔数",
  reconciliationDifferences: "勾稽差异类别",
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * 通用的任务结果展示（输出链接 + 指标 + 警告 + 跳过路径）。
 * 从 App.tsx 抽出供 FaListPage 等页面共用，避免页面抽取时的循环依赖。
 *
 * 默认文案不宣称"处理完成"：本组件不知道展示的结果来自刚成功的任务，
 * 还是失败/取消后残留的上次结果（甚至是失败任务中途写出的部分产物），
 * 只有"结果文件已生成、可打开核对"是各种场景下都真实的中性表述。
 * 页面若知道最近一次任务未成功，传 stale 显示醒目提示。
 */
export function ResultView({
  value,
  stale = false,
}: {
  value: unknown;
  stale?: boolean;
}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return <p>{String(value)}</p>;
  const obj = value as Record<string, unknown>;
  const outputPaths = stringList(obj.outputPaths);
  if (
    typeof obj.outputPath === "string" &&
    !outputPaths.includes(obj.outputPath)
  )
    outputPaths.push(obj.outputPath);
  // splitFile 通常已包含在 outputPaths 里（WP 服务单的 Rust 侧与演示数据
  // 都两者同时下发），不去重会把同一个拆分文件渲染成两个同名链接。
  if (
    typeof obj.splitFile === "string" &&
    !outputPaths.includes(obj.splitFile)
  )
    outputPaths.push(obj.splitFile);
  const message = [obj.userMessage, obj.message, obj.statusMessage].find(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
  const counts = Object.entries(RESULT_COUNT_LABELS)
    .filter(([key]) => typeof obj[key] === "number")
    .map(([key, label]) => ({ label, value: Number(obj[key]) }));
  // The engine already computes these; leaving them unrendered is what let an
  // incomplete merge or a skipped report look like a clean success.
  const warnings = [...stringList(obj.warnings), ...stringList(obj.missing)];
  const skipped = stringList(obj.skippedPaths);
  const unmatched = stringList(obj.unmatchedSectionOrders);
  const differences = Array.isArray(obj.outlookDifferences)
    ? (obj.outlookDifferences as Array<Record<string, unknown>>)
    : [];
  const valid = typeof obj.valid === "boolean" ? obj.valid : undefined;
  const limited = (items: string[]) => items.slice(0, 20);
  return (
    <div className="result-summary" role="status" aria-live="polite">
      <p>
        {message ??
          (valid === true
            ? "输入检查通过。"
            : valid === false
              ? "输入检查未通过。"
              : outputPaths.length
                ? "以下为已生成的结果文件，可打开核对。"
                : "运行结束。")}
      </p>
      {stale && (
        <p className="result-stale-note" role="note">
          注意：最近一次任务未成功完成，以下结果可能不完整或来自上次成功运行，请核对后再使用。
        </p>
      )}
      {!!counts.length && (
        <div className="result-metrics">
          {counts.map((item) => (
            <span key={item.label}>
              <b>{item.value}</b>
              {item.label}
            </span>
          ))}
        </div>
      )}
      {!!warnings.length && (
        <div className="warning-box result-summary-list">
          <strong>需要注意（{warnings.length}）</strong>
          <ul>
            {limited(warnings).map((item, index) => (
              <li key={`${item}-${index}`}>{displayFileName(item)}</li>
            ))}
          </ul>
          {warnings.length > 20 && <p>另有 {warnings.length - 20} 项未显示。</p>}
        </div>
      )}
      {!!unmatched.length && (
        <div className="warning-box result-summary-list">
          <strong>
            未在 Section List 中匹配到的服务单（{unmatched.length}）
          </strong>
          <ul>
            {limited(unmatched).map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
          </ul>
          {unmatched.length > 20 && <p>另有 {unmatched.length - 20} 项未显示。</p>}
        </div>
      )}
      {!!differences.length && (
        <div className="warning-box result-summary-list">
          <strong>Outlook Hours 核对不一致（{differences.length}）</strong>
          <ul>
            {differences.slice(0, 20).map((item, index) => (
              <li key={`${String(item.serviceNumber ?? index)}`}>
                {String(item.serviceNumber ?? "")}{" "}
                {String(item.engagementName ?? "")}： 方案{" "}
                {String(item.calculated ?? "")} / 源表{" "}
                {String(item.source ?? "")}， 差额{" "}
                {String(item.difference ?? "")}
              </li>
            ))}
          </ul>
          {differences.length > 20 && <p>另有 {differences.length - 20} 项未显示。</p>}
        </div>
      )}
      {!!skipped.length && (
        <div className="warning-box result-summary-list">
          <strong>无法访问、已跳过的路径（{skipped.length}）</strong>
          <ul>
            {skipped.slice(0, 20).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {skipped.length > 20 && <p>另有 {skipped.length - 20} 项未显示。</p>}
        </div>
      )}
      {!!outputPaths.length && (
        <div className="result-output-list" aria-label="输出文件">
          {outputPaths.map((p, index) => (
            <button
              type="button"
              className="link-button"
              key={`${p}-${index}`}
              title={p}
              onClick={() => void openOutput(p)}
            >
              {displayFileName(p)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
