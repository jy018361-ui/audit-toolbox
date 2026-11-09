import { useState } from "react";
import { openOutput } from "@/api";
import { displayFileName } from "@/fileDisplay";
import { formatCount } from "@/lib/numberFormat";
import { Button } from "@/components/ui/button";
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

/** 折叠时最多直出的条数：更多时给「展开全部」而不是无声截断。 */
const SUMMARY_LIST_PREVIEW = 8;

/**
 * 结果摘要里的长清单：默认只显示前几条，一键展开后完整列出并在
 * 固定高度内滚动。旧行为是硬截 20 条加一句「另有 N 项未显示」，
 * 用户既看不全也没有出口。展开按钮放在滚动区外——按钮在框内会
 * 随长清单滚出视野，等于没有出口。
 */
function SummaryList({
  title,
  items,
  renderItem,
}: {
  title: string;
  items: unknown[];
  renderItem: (item: unknown, index: number) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, SUMMARY_LIST_PREVIEW);
  const expandable = items.length > SUMMARY_LIST_PREVIEW;
  return (
    <div className="warning-box result-summary-list">
      <strong>{title}</strong>
      {expandable ? (
        <div className="result-summary-list-scroll">
          <ul>
            {visible.map((item, index) => (
              <li key={index}>{renderItem(item, index)}</li>
            ))}
          </ul>
        </div>
      ) : (
        <ul>
          {visible.map((item, index) => (
            <li key={index}>{renderItem(item, index)}</li>
          ))}
        </ul>
      )}
      {expandable && (
        <Button
          variant="secondary"
          size="xs"
          type="button"
          className="result-summary-list-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : `展开全部（共 ${formatCount(items.length)} 项）`}
        </Button>
      )}
    </div>
  );
}

/**
 * 通用的任务结果展示（输出链接 + 指标 + 警告 + 跳过路径）。
 * 从 App.tsx 抽出供 FaListPage 等页面共用，避免页面抽取时的循环依赖。
 *
 * 默认文案不宣称"处理完成"：本组件不知道展示的结果来自刚成功的任务，
 * 还是失败/取消后残留的上次结果（甚至是失败任务中途写出的部分产物）。
 * 有结果文件时不写概要句，让下面的文件链接自己说明；没有文件才说"运行结束"。
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
  const summaryText =
    message ??
    (valid === true
      ? "输入检查通过。"
      : valid === false
        ? "输入检查未通过。"
        : outputPaths.length
          ? null
          : "运行结束。");
  return (
    <div className="result-summary" role="status" aria-live="polite">
      {summaryText && <p>{summaryText}</p>}
      {stale && (
        <p className="result-stale-note" role="note">
          注意：最近一次任务未成功完成，以下结果可能不完整或来自上次成功运行，请核对后再使用。
        </p>
      )}
      {!!counts.length && (
        <div className="result-metrics">
          {counts.map((item) => (
            <span key={item.label}>
              <b>{formatCount(item.value)}</b>
              {item.label}
            </span>
          ))}
        </div>
      )}
      {!!warnings.length && (
        <SummaryList
          title={`需要注意（${formatCount(warnings.length)}）`}
          items={warnings}
          renderItem={(item) => displayFileName(String(item))}
        />
      )}
      {!!unmatched.length && (
        <SummaryList
          title={`未在 Section List 中匹配到的服务单（${formatCount(unmatched.length)}）`}
          items={unmatched}
          renderItem={(item) => String(item)}
        />
      )}
      {!!differences.length && (
        <SummaryList
          title={`Outlook Hours 核对不一致（${formatCount(differences.length)}）`}
          items={differences}
          renderItem={(item) => {
            const row = item as Record<string, unknown>;
            return `${String(row.serviceNumber ?? "")} ${String(row.engagementName ?? "")}： 方案 ${formatCount(
              row.calculated,
              { maxFractionDigits: 2 },
            )} / 源表 ${formatCount(row.source, { maxFractionDigits: 2 })}， 差额 ${formatCount(
              row.difference,
              { maxFractionDigits: 2 },
            )}`;
          }}
        />
      )}
      {!!skipped.length && (
        <SummaryList
          title={`无法访问、已跳过的路径（${formatCount(skipped.length)}）`}
          items={skipped}
          renderItem={(item) => String(item)}
        />
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
