import { useEffect, useState } from "react";
import { PanelBottomClose, PanelBottomOpen } from "lucide-react";

import type {
  DataflowNode,
  DataflowNodeResult,
  DataflowRunResult,
} from "./model";
import { nodeSpec } from "./nodeSpecs";

const PAGE_SIZE = 100;

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  idle: { label: "未运行", cls: "" },
  run: { label: "运行中", cls: "df-chip-run" },
  ok: { label: "成功", cls: "df-chip-ok" },
  warn: { label: "成功（有警告）", cls: "df-chip-warn" },
  error: { label: "失败", cls: "df-chip-err" },
};

type SampleCell = string | number | boolean | null;

function formatCell(value: SampleCell): { text: string; empty: boolean } {
  if (value === null || value === undefined || value === "") return { text: "空", empty: true };
  if (typeof value === "boolean") return { text: value ? "是" : "否", empty: false };
  if (typeof value === "number") {
    return {
      text: Number.isInteger(value) ? value.toLocaleString("zh-CN") : String(value),
      empty: false,
    };
  }
  return { text: value, empty: false };
}

const NUMERIC_NAME_HINT = /金额|合计|借方|贷方|行数|笔数|数$|值$|净额|期间|计数|比分/;

function columnNumeric(
  index: number,
  column: string,
  types: string[] | undefined,
): boolean {
  const type = types?.[index] ?? "";
  if (/int|decimal|number|float|numeric/i.test(type)) return true;
  return NUMERIC_NAME_HINT.test(column);
}

function SampleTable({
  columns,
  types,
  rows,
}: {
  columns: string[];
  types?: string[];
  rows: SampleCell[][];
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const slice = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  if (!rows.length) {
    return <div className="df-placeholder">样本数据为空。</div>;
  }
  return (
    <>
      <div className="df-table-wrap">
        <table className="df-table">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  key={column + index}
                  className={columnNumeric(index, column, types) ? "df-num" : undefined}
                  scope="col"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => {
                  const { text, empty } = formatCell(
                    cell ?? null,
                  );
                  return (
                    <td
                      key={cellIndex}
                      className={
                        columnNumeric(cellIndex, columns[cellIndex] ?? "", types)
                          ? "df-num"
                          : undefined
                      }
                    >
                      {empty ? <span className="df-cell-empty">{text}</span> : text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="df-pager">
          <button type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            上一页
          </button>
          <span>
            第 {safePage + 1} / {pageCount} 页 · 每页 {PAGE_SIZE} 行
          </span>
          <button
            type="button"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </>
  );
}

/** 运行整体失败（引擎报错/路径未授权）时结果区的显眼错误卡，取代「尚未运行」占位。 */
function RunErrorCard({ message }: { message: string }) {
  return (
    <div className="df-run-error" role="alert">
      <b>运行失败</b>
      <span>{message}</span>
      <span className="df-run-error-hint">完整错误同时显示在左下角状态栏；处理后再点「预览运行」或「全量运行」。</span>
    </div>
  );
}

export interface ResultsPanelProps {
  node: DataflowNode | null;
  /** 引擎返回的该节点结果；undefined 表示尚未运行过。 */
  result: DataflowNodeResult | undefined;
  nodeStatus: "idle" | "run" | "ok" | "warn" | "error";
  lastRunMode: "preview" | "full" | null;
  outputs: DataflowRunResult["outputs"];
  /** 本次运行的整体失败信息（路径未授权等）：失败原因必须出现在结果区，
   *  只写在状态栏小字里，用户会以为点了没反应。 */
  runError?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * 底部结果区：按选中节点显示各输出锚点页签（筛选 T/F 两页签）＋消息＋统计，
 * 数据表格分页展示引擎返回的 sample（每页 100 行）。
 */
export function ResultsPanel({
  node,
  result,
  nodeStatus,
  lastRunMode,
  outputs,
  runError,
  collapsed,
  onToggleCollapse,
}: ResultsPanelProps) {
  const [activeTab, setActiveTab] = useState<string>("");
  const spec = node ? nodeSpec(node.type) : undefined;

  // 切换节点时回到第一个页签。
  useEffect(() => {
    setActiveTab("");
  }, [node?.id]);

  if (collapsed) {
    return (
      <section className="df-results df-collapsed" aria-label="结果区（已折叠）">
        <div className="df-results-head">
          <span className="df-results-title">结果</span>
          <button
            type="button"
            className="df-collapse-btn"
            aria-label="展开结果区"
            title="展开结果区"
            onClick={onToggleCollapse}
          >
            <PanelBottomOpen size={14} />
          </button>
        </div>
      </section>
    );
  }

  if (!node || !spec) {
    return (
      <section className="df-results" aria-label="结果区">
        <div className="df-results-head">
          <span className="df-results-title">结果</span>
          <button
            type="button"
            className="df-collapse-btn"
            aria-label="折叠结果区"
            title="折叠结果区"
            onClick={onToggleCollapse}
          >
            <PanelBottomClose size={14} />
          </button>
        </div>
        <div className="df-results-body">
          {runError ? (
            <RunErrorCard message={runError} />
          ) : (
            <div className="df-placeholder">点击画布中的节点查看运行结果。</div>
          )}
        </div>
      </section>
    );
  }

  const tabs: { key: string; label: string }[] = spec.outputs.length
    ? spec.outputs.map((anchor) =>
        spec.outputs.length === 1
          ? { key: anchor.key, label: "输出数据" }
          : { key: anchor.key, label: anchor.label },
      )
    : [{ key: "__write", label: "写入结果" }];
  tabs.push({ key: "__msg", label: "消息" }, { key: "__stat", label: "统计" });
  const current = activeTab && tabs.some((tab) => tab.key === activeTab) ? activeTab : tabs[0].key;
  const chip = STATUS_CHIP[nodeStatus] ?? STATUS_CHIP.idle;
  const nodeOutputs = outputs.filter((item) => item.nodeId === node.id);

  return (
    <section className="df-results" aria-label="结果区">
      <div className="df-results-head">
        <span className="df-results-title">{node.name}</span>
        <span className={`df-chip ${chip.cls}`}>{chip.label}</span>
        <div className="df-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={current === tab.key}
              className={`df-tab${current === tab.key ? " df-tab-active" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="df-collapse-btn"
          aria-label="折叠结果区"
          title="折叠结果区"
          onClick={onToggleCollapse}
        >
          <PanelBottomClose size={14} />
        </button>
      </div>
      <div className="df-results-body">
        {!result ? (
          runError ? (
            <RunErrorCard message={runError} />
          ) : (
            <div className="df-placeholder">
              尚未运行——点击工具栏「预览运行」用样本数据试跑，或「全量运行」处理完整数据。
            </div>
          )
        ) : current === "__msg" ? (
          result.messages.length ? (
            <ul className="df-msg">
              {result.messages.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          ) : (
            <div className="df-placeholder">本次运行没有消息。</div>
          )
        ) : current === "__stat" ? (
          result.stats.length ? (
            <ul className="df-msg">
              {result.stats.map((stat, index) => (
                <li key={index}>{stat}</li>
              ))}
            </ul>
          ) : (
            <div className="df-placeholder">本次运行没有统计。</div>
          )
        ) : current === "__write" ? (
          <>
            {lastRunMode === "preview" && (
              <div className="df-note df-note-warn">预览运行不写输出文件，以下为样本预览。</div>
            )}
            {nodeOutputs.length ? (
              <div className="df-table-wrap">
                <table className="df-table">
                  <thead>
                    <tr>
                      <th scope="col">写入文件</th>
                      <th scope="col">Sheet</th>
                      <th scope="col" className="df-num">
                        行数
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodeOutputs.map((item, index) => (
                      <tr key={index}>
                        <td>{item.path}</td>
                        <td>{item.sheet || "—"}</td>
                        <td className="df-num">{item.rows.toLocaleString("zh-CN")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : lastRunMode === "preview" ? (
              result.anchors.out ? (
                <SampleTable
                  columns={result.anchors.out.columns}
                  types={result.anchors.out.types}
                  rows={result.anchors.out.sample}
                />
              ) : (
                <div className="df-placeholder">预览模式：未写入文件。</div>
              )
            ) : (
              <div className="df-placeholder">本次运行没有写入文件。</div>
            )}
          </>
        ) : (
          <SampleTable
            columns={result.anchors[current]?.columns ?? []}
            types={result.anchors[current]?.types}
            rows={result.anchors[current]?.sample ?? []}
          />
        )}
      </div>
    </section>
  );
}
