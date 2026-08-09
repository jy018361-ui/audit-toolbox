import { openOutput } from "@/api";

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
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * 通用的任务结果展示（输出链接 + 指标 + 警告 + 跳过路径）。
 * 从 App.tsx 抽出供 FaListPage 等页面共用，避免页面抽取时的循环依赖。
 */
export function ResultView({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return <p>{String(value)}</p>;
  const obj = value as Record<string, unknown>;
  const outputPaths = stringList(obj.outputPaths);
  if (
    typeof obj.outputPath === "string" &&
    !outputPaths.includes(obj.outputPath)
  )
    outputPaths.push(obj.outputPath);
  if (typeof obj.splitFile === "string") outputPaths.push(obj.splitFile);
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
  return (
    <div className="result-summary">
      <p>
        {message ??
          (valid === true
            ? "输入检查通过。"
            : valid === false
              ? "输入检查未通过。"
              : outputPaths.length
                ? "处理完成，可打开下方结果文件。"
                : "处理完成。")}
      </p>
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
        <div className="warning-box">
          <strong>需要注意（{warnings.length}）</strong>
          <ul>
            {warnings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {!!unmatched.length && (
        <div className="warning-box">
          <strong>
            未在 Section List 中匹配到的服务单（{unmatched.length}）
          </strong>
          <ul>
            {unmatched.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {!!differences.length && (
        <div className="warning-box">
          <strong>Outlook Hours 核对不一致（{differences.length}）</strong>
          <ul>
            {differences.map((item, index) => (
              <li key={`${String(item.serviceNumber ?? index)}`}>
                {String(item.serviceNumber ?? "")}{" "}
                {String(item.engagementName ?? "")}： 方案{" "}
                {String(item.calculated ?? "")} / 源表{" "}
                {String(item.source ?? "")}， 差额{" "}
                {String(item.difference ?? "")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!skipped.length && (
        <div className="warning-box">
          <strong>无法访问、已跳过的路径（{skipped.length}）</strong>
          <ul>
            {skipped.slice(0, 20).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {skipped.length > 20 && <p>另有 {skipped.length - 20} 项未显示。</p>}
        </div>
      )}
      {outputPaths.map((p) => (
        <button
          className="link-button"
          key={p}
          onClick={() => void openOutput(p)}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
