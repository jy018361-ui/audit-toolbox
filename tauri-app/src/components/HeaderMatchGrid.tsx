import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ConfirmDialog";

export type HeaderMatchDetection = {
  headerRow: number;
  headerRowsCount: number;
  confidence: number;
  needsReview: boolean;
};

export type HeaderMatchPreview = {
  template: {
    path: string;
    name: string;
    headers: string[];
    detection: HeaderMatchDetection;
    external: boolean;
    rawRows: string[][];
  };
  rows: {
    path: string;
    name: string;
    sheet: string;
    headers: string[];
    detection: HeaderMatchDetection;
    matches: { target: number | null; confidence: number; reason: string }[];
    preview: string[][];
    rawRows: string[][];
  }[];
  aliases?: { source: string; target: string }[];
};

export type HeaderMatchingPlanJson = {
  templatePath: string;
  templateHeaders: string[];
  rememberAliases: [string, string][];
  assignments: {
    path: string;
    sheet: string;
    headerRow: number;
    headerRowsCount: number;
    headers: string[];
    columns: {
      source: number;
      target: number | null;
      discard: boolean;
      manual: boolean;
      reason: string;
    }[];
  }[];
};

type CellState = {
  target: number | null;
  discard: boolean;
  manual: boolean;
  machineTarget: number | null;
  confidence: number;
  reason: string;
};

type RowState = {
  path: string;
  name: string;
  sheet: string;
  headers: string[];
  detection: HeaderMatchDetection;
  cells: CellState[];
  preview: string[][];
  rawRows: string[][];
};

/** 两层表头拍平（与 Rust 同口径：父级向右填充，父子用「-」连接）。 */
export function flattenTwoLayerHeader(
  first: string[],
  second: string[],
): string[] {
  const width = Math.max(first.length, second.length);
  const out: string[] = [];
  let parent = "";
  for (let index = 0; index < width; index += 1) {
    const top = (first[index] ?? "").trim();
    if (top) parent = top;
    const child = (second[index] ?? "").trim();
    const name = !parent
      ? child
      : !child || child === parent
        ? parent
        : `${parent}-${child}`;
    out.push(name || `列${index + 1}`);
  }
  return out;
}

function toRowState(
  row: HeaderMatchPreview["rows"][number],
): RowState {
  return {
    path: row.path,
    name: row.name,
    sheet: row.sheet,
    headers: [...row.headers],
    detection: { ...row.detection },
    cells: row.matches.map((match) => ({
      target: match.target,
      discard: false,
      manual: false,
      machineTarget: match.target,
      confidence: match.confidence,
      reason: match.reason,
    })),
    preview: row.preview,
    rawRows: row.rawRows,
  };
}

const GREEN_THRESHOLD = 0.9;

function cellClass(cell: CellState): string {
  if (cell.discard) return "hmg-cell hmg-cell-discard";
  if (cell.manual) return "hmg-cell hmg-cell-manual";
  if (cell.target == null) return "hmg-cell hmg-cell-unmatched";
  return `hmg-cell ${cell.confidence >= GREEN_THRESHOLD ? "hmg-cell-green" : "hmg-cell-yellow"}`;
}

type MenuState = { row: number; col: number; x: number; y: number } | null;

export function HeaderMatchGrid(props: {
  preview: HeaderMatchPreview;
  files: { path: string; name: string }[];
  busy?: boolean;
  onTemplateChange: (path: string) => void;
  onExternalTemplate: () => void;
  onCancel: () => void;
  onConfirm: (plan: HeaderMatchingPlanJson) => void;
}) {
  const { preview, files, busy } = props;
  const [template, setTemplate] = useState(() => ({
    headers: [...preview.template.headers],
    detection: { ...preview.template.detection },
    rawRows: preview.template.rawRows,
  }));
  const [rows, setRows] = useState<RowState[]>(() => preview.rows.map(toRowState));
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [remember, setRemember] = useState(false);
  const [menu, setMenu] = useState<MenuState>(null);
  const [headerMenu, setHeaderMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const [toast, setToast] = useState("");
  const dragRef = useRef<{ row: number; col: number } | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setTemplate({
      headers: [...preview.template.headers],
      detection: { ...preview.template.detection },
      rawRows: preview.template.rawRows,
    });
    setRows(preview.rows.map(toRowState));
    setExcluded(new Set());
    setExpanded(new Set());
  }, [preview]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const stats = useMemo(() => {
    let green = 0;
    let yellow = 0;
    let unmatched = 0;
    for (const row of rows) {
      for (const cell of row.cells) {
        if (cell.discard) continue;
        if (cell.manual) green += 1;
        else if (cell.target == null) unmatched += 1;
        else if (cell.confidence >= GREEN_THRESHOLD) green += 1;
        else yellow += 1;
      }
    }
    return { green, yellow, unmatched };
  }, [rows]);

  function closeMenus() {
    setMenu(null);
    setHeaderMenu(null);
  }

  /** 把 (row, col) 的格子安置到 target 列；目标列已被占用时直接交换。 */
  function assign(row: number, col: number, target: number | null, discard = false) {
    setRows((current) =>
      current.map((state, index) => {
        if (index !== row) return state;
        const cells = [...state.cells];
        const previous = cells[col].target;
        if (target != null) {
          const occupant = cells.findIndex(
            (cell, i) => i !== col && cell.target === target,
          );
          if (occupant >= 0) {
            cells[occupant] = {
              ...cells[occupant],
              target: previous,
              discard: false,
              manual: true,
              reason: "人工调整",
            };
            setToast(
              `已与「${state.headers[occupant]}」交换，可再次拖拽改回`,
            );
          }
        }
        cells[col] = {
          ...cells[col],
          target,
          discard,
          manual: true,
          reason: discard ? "人工调整（丢弃）" : "人工调整",
        };
        return { ...state, cells };
      }),
    );
  }

  function resetAll() {
    setRows((current) =>
      current.map((state) => ({
        ...state,
        cells: state.cells.map((cell) => ({
          ...cell,
          target: cell.machineTarget,
          discard: false,
          manual: false,
        })),
      })),
    );
    setExcluded(new Set());
    setToast("已重置全部手动修改");
  }

  function acceptAll() {
    setRows((current) =>
      current.map((state) => ({
        ...state,
        cells: state.cells.map((cell) =>
          cell.target != null && cell.confidence < GREEN_THRESHOLD
            ? { ...cell, manual: true, reason: "已确认建议" }
            : cell,
        ),
      })),
    );
  }

  function confirmCell(row: number, col: number) {
    setRows((current) =>
      current.map((state, index) =>
        index === row
          ? {
              ...state,
              cells: state.cells.map((cell, i) =>
                i === col && cell.target != null && !cell.manual
                  ? { ...cell, manual: true, reason: "已确认建议" }
                  : cell,
              ),
            }
          : state,
      ),
    );
  }

  function jumpNextPending() {
    for (let index = 0; index < rows.length; index += 1) {
      const col = rows[index].cells.findIndex(
        (cell) =>
          !cell.manual &&
          !cell.discard &&
          cell.target != null &&
          cell.confidence < GREEN_THRESHOLD,
      );
      if (col >= 0) {
        const cellNode = gridRef.current?.querySelector<HTMLDivElement>(
          `[data-cell="${index}-${col}"]`,
        );
        cellNode?.scrollIntoView?.({ block: "center", inline: "center" });
        cellNode?.focus();
        cellNode?.animate?.(
          [
            { boxShadow: "0 0 0 3px rgba(234,179,8,.9)" },
            { boxShadow: "0 0 0 3px rgba(234,179,8,0)" },
          ],
          { duration: 1200 },
        );
        return;
      }
    }
    setToast("没有待确认的黄色格子了");
  }

  function excludeColumn(col: number) {
    setExcluded((current) => new Set(current).add(col));
    setRows((currentRows) =>
      currentRows.map((state) => ({
        ...state,
        cells: state.cells.map((cell) =>
          cell.target === col
            ? { ...cell, target: null, manual: true, reason: "标准列已剔除" }
            : cell,
        ),
      })),
    );
  }

  /** 人工修正表头行/层数：本地重新拍平表头，匹配结果重置为未匹配。 */
  function applyDetectionEdit(
    isTemplate: boolean,
    row: number,
    headerRow: number,
    headerRowsCount: number,
  ) {
    const reflatten = (raw: string[][]) => {
      if (headerRowsCount >= 2) {
        return flattenTwoLayerHeader(raw[headerRow] ?? [], raw[headerRow + 1] ?? []);
      }
      return [...(raw[headerRow] ?? [])];
    };
    if (isTemplate) {
      const headers = reflatten(template.rawRows);
      setTemplate((current) => ({
        ...current,
        headers,
        detection: { ...current.detection, headerRow, headerRowsCount },
      }));
      setExcluded(new Set());
      setRows((currentRows) =>
        currentRows.map((state) => ({
          ...state,
          cells: state.cells.map(() => ({
            target: null,
            discard: false,
            manual: false,
            machineTarget: null,
            confidence: 0,
            reason: "",
          })),
        })),
      );
      setToast("模板表头已更新，请重新确认各文件的映射");
      return;
    }
    setRows((current) =>
      current.map((state, index) => {
        if (index !== row) return state;
        const headers = reflatten(state.rawRows);
        return {
          ...state,
          headers,
          detection: { ...state.detection, headerRow, headerRowsCount },
          cells: headers.map(() => ({
            target: null,
            discard: false,
            manual: false,
            machineTarget: null,
            confidence: 0,
            reason: "",
          })),
        };
      }),
    );
    setToast("表头已重新拍平，该文件的映射已重置");
  }

  async function buildPlan(): Promise<HeaderMatchingPlanJson | null> {
    if (stats.yellow > 0) {
      const ok = await confirmDialog({
        title: "还有未确认的黄色建议",
        message: `还有 ${stats.yellow} 项黄色建议未确认，将直接按建议执行，确定开始合并吗？`,
        confirmLabel: "按建议合并",
        tone: "danger",
      });
      if (!ok) return null;
    }
    const active = template.headers
      .map((header, index) => ({ header, index }))
      .filter(({ index }) => !excluded.has(index));
    const remap = new Map<number, number>();
    active.forEach(({ index }, position) => remap.set(index, position));
    const templateHeaders = active.map(({ header }) => header);
    const rememberAliases: [string, string][] = remember
      ? rows.flatMap((state) =>
          state.cells
            .filter(
              (cell) =>
                cell.manual &&
                !cell.discard &&
                cell.target != null &&
                remap.has(cell.target),
            )
            .map((cell): [string, string] => [
              state.headers[state.cells.indexOf(cell)] ?? "",
              templateHeaders[remap.get(cell.target!) ?? 0] ?? "",
            ])
            .filter(([source, target]) => Boolean(source) && Boolean(target)),
        )
      : [];
    return {
      templatePath: preview.template.path,
      templateHeaders,
      rememberAliases,
      assignments: rows.map((state) => ({
        path: state.path,
        sheet: state.sheet,
        headerRow: state.detection.headerRow,
        headerRowsCount: state.detection.headerRowsCount,
        headers: state.headers,
        columns: state.cells.map((cell, source) => ({
          source,
          target: cell.target != null ? remap.get(cell.target) ?? null : null,
          discard: cell.discard,
          manual: cell.manual,
          reason: cell.manual ? "人工调整" : cell.reason,
        })),
      })),
    };
  }

  async function handleConfirm() {
    const plan = await buildPlan();
    if (plan) props.onConfirm(plan);
  }

  const dragProps = (row: number, col: number) => ({
    draggable: true,
    "data-cell": `${row}-${col}`,
    tabIndex: 0,
    "aria-label": `表头格子 ${rows[row].headers[col] ?? ""}，回车确认建议`,
    onDragStart() {
      dragRef.current = { row, col };
    },
    onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
      if (event.key === "Enter") confirmCell(row, col);
    },
    onContextMenu(event: React.MouseEvent) {
      event.preventDefault();
      closeMenus();
      setMenu({ row, col, x: event.clientX, y: event.clientY });
    },
  });

  const dropProps = (target: number | null) => ({
    onDragOver(event: React.DragEvent) {
      event.preventDefault();
    },
    onDrop(event: React.DragEvent) {
      event.preventDefault();
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      if (target != null && excluded.has(target)) return;
      assign(drag.row, drag.col, target);
    },
  });

  const menuCell = menu ? rows[menu.row]?.cells[menu.col] : null;

  return (
    <div
      className="hmg-overlay"
      onClick={closeMenus}
      onContextMenu={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          closeMenus();
        }
      }}
    >
      <div className="hmg-panel">
        <div className="hmg-topbar">
          <div className="hmg-title">
            <strong>表头匹配</strong>
            <span className="hmg-stats">
              <span className="hmg-stat" data-stat="green">
                <span className="hmg-dot hmg-dot-green" />
                {stats.green} 匹配
              </span>
              <span className="hmg-stat" data-stat="yellow">
                <span className="hmg-dot hmg-dot-yellow" />
                {stats.yellow} 待确认
              </span>
              <span className="hmg-stat" data-stat="unmatched">
                <span className="hmg-dot hmg-dot-red" />
                {stats.unmatched} 未匹配
              </span>
            </span>
          </div>
          <div className="hmg-template">
            <label>
              模板：
              <select
                value={preview.template.path}
                disabled={busy}
                onChange={(event) => props.onTemplateChange(event.target.value)}
              >
                {files.map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.name}
                  </option>
                ))}
                {preview.template.external && (
                  <option value={preview.template.path}>
                    {preview.template.name}（外部）
                  </option>
                )}
              </select>
            </label>
            <Button variant="secondary" size="sm" disabled={busy} onClick={props.onExternalTemplate}>
              上传外部模板
            </Button>
          </div>
        </div>

        <div className="hmg-actions">
          <Button variant="secondary" size="sm" disabled={!stats.yellow || busy} onClick={acceptAll}>
            全部按建议执行（{stats.yellow}）
          </Button>
          <Button variant="secondary" size="sm" onClick={jumpNextPending}>
            下一处待确认
          </Button>
          <Button variant="ghost" size="sm" onClick={resetAll}>
            ↺ 重置手动调整
          </Button>
        </div>

        <div className="hmg-grid-wrap" ref={gridRef}>
          <table className="hmg-grid">
            <thead>
              <tr>
                <th className="hmg-file-col">文件</th>
                {template.headers.map((header, col) => (
                  <th
                    key={col}
                    data-column={col}
                    className={excluded.has(col) ? "hmg-th hmg-th-excluded" : "hmg-th"}
                    {...dropProps(col)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      closeMenus();
                      setHeaderMenu({ col, x: event.clientX, y: event.clientY });
                    }}
                    title={excluded.has(col) ? `${header}（已剔除，不参与输出）` : header}
                  >
                    {header}
                  </th>
                ))}
                <th className="hmg-th hmg-unmatched-col" {...dropProps(null)}>
                  ⟶ 未匹配区（拖拽到列可安置 / 拖到下方 🗑 丢弃）
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="hmg-template-row">
                <td className="hmg-file-cell">
                  <span className="hmg-badge">基准</span>
                  {preview.template.name}
                  <span className="hmg-sheet-tag">{preview.template.external ? "外部模板" : ""}</span>
                </td>
                {template.headers.map((header, col) => (
                  <td key={col} className="hmg-slot" {...dropProps(col)}>
                    <div
                      className={
                        excluded.has(col)
                          ? "hmg-cell hmg-cell-template hmg-cell-discard"
                          : "hmg-cell hmg-cell-template"
                      }
                      title={header}
                    >
                      {header}
                    </div>
                  </td>
                ))}
                <td className="hmg-slot hmg-unmatched-slot" {...dropProps(null)} />
              </tr>
              {rows.map((state, row) => {
                const isExpanded = expanded.has(row);
                const slots = new Map<number, number>();
                state.cells.forEach((cell, col) => {
                  if (cell.target != null && !cell.discard) slots.set(cell.target, col);
                });
                const unmatched = state.cells
                  .map((cell, col) => ({ cell, col }))
                  .filter(({ cell }) => cell.target == null);
                return (
                  <Fragment key={`${state.path}-${state.sheet}`}>
                    <tr>
                      <td className="hmg-file-cell">
                        <button
                          type="button"
                          className="hmg-expand"
                          aria-label={isExpanded ? "折叠数据预览" : "展开数据预览"}
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(row)) next.delete(row);
                              else next.add(row);
                              return next;
                            })
                          }
                        >
                          {isExpanded ? "▼" : "▶"}
                        </button>
                        {state.detection.needsReview && (
                          <span className="hmg-review-dot" title="表头行识别拿不准，请展开确认" />
                        )}
                        <span title={`${state.path} / ${state.sheet}`}>{state.name}</span>
                        <span className="hmg-sheet-tag">{state.sheet}</span>
                      </td>
                      {template.headers.map((_, col) => {
                        const occupant = slots.get(col);
                        if (occupant == null) {
                          return (
                            <td key={col} className="hmg-slot hmg-slot-empty" {...dropProps(col)}>
                              <div className="hmg-empty-mark" />
                            </td>
                          );
                        }
                        const cell = state.cells[occupant];
                        return (
                          <td key={col} className="hmg-slot" {...dropProps(col)}>
                            <div
                              className={cellClass(cell)}
                              title={
                                cell.reason
                                  ? `${state.headers[occupant]} · ${cell.reason}${cell.manual ? "（人工调整）" : ""}`
                                  : state.headers[occupant]
                              }
                              {...dragProps(row, occupant)}
                            >
                              {cell.manual && <span className="hmg-manual-mark">✎</span>}
                              {state.headers[occupant]}
                            </div>
                          </td>
                        );
                      })}
                      <td className="hmg-slot hmg-unmatched-slot" {...dropProps(null)}>
                        <div className="hmg-unmatched-list">
                          {unmatched.map(({ cell, col }) => (
                            <div
                              key={col}
                              className={cellClass(cell)}
                              title={cell.discard ? "已丢弃" : "未匹配，默认保留为独立列"}
                              {...dragProps(row, col)}
                            >
                              {cell.manual && <span className="hmg-manual-mark">✎</span>}
                              {cell.discard ? <s>{state.headers[col]}</s> : state.headers[col]}
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="hmg-preview-row">
                        <td colSpan={template.headers.length + 2}>
                          <div className="hmg-preview">
                            <div className="hmg-preview-cols">
                              {state.headers.map((header, col) => (
                                <div key={col} className="hmg-preview-col">
                                  <strong title={header}>{header}</strong>
                                  {state.preview.slice(0, 3).map((values, index) => (
                                    <span key={index}>{values[col] ?? ""}</span>
                                  ))}
                                </div>
                              ))}
                            </div>
                            <DetectionEditor
                              detection={state.detection}
                              onApply={(headerRow, count) =>
                                applyDetectionEdit(false, row, headerRow, count)
                              }
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="hmg-bottombar">
          <label className="hmg-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            记住本次手动对应关系，以后自动匹配
          </label>
          <div className="hmg-discard-zone">
            <span
              className="hmg-trash"
              {...dropProps(null)}
              onDrop={(event) => {
                event.preventDefault();
                const drag = dragRef.current;
                dragRef.current = null;
                if (!drag) return;
                assign(drag.row, drag.col, null, true);
              }}
              role="button"
              aria-label="拖到此处丢弃此列"
            >
              🗑 丢弃此列
            </span>
          </div>
          <div className="hmg-main-actions">
            <Button variant="secondary" onClick={props.onCancel} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void handleConfirm()} disabled={busy}>
              开始合并
              {stats.yellow > 0 ? `（${stats.yellow} 项黄色将按建议执行）` : ""}
            </Button>
          </div>
        </div>

        {template.detection.needsReview && (
          <div className="hmg-template-review">
            模板「{preview.template.name}」的表头行识别拿不准，请
            <DetectionEditor
              detection={template.detection}
              onApply={(headerRow, count) => applyDetectionEdit(true, 0, headerRow, count)}
              compact
            />
          </div>
        )}

        {toast && <div className="hmg-toast">{toast}</div>}

        {menu && menuCell && (
          <div
            className="hmg-menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="hmg-menu-title">
              {rows[menu.row].headers[menu.col]}
            </div>
            {menuCell.target != null && !menuCell.discard && (
              <button
                type="button"
                onClick={() => {
                  assign(menu.row, menu.col, null);
                  closeMenus();
                }}
              >
                移至未匹配区
              </button>
            )}
            {!menuCell.discard && (
              <button
                type="button"
                onClick={() => {
                  assign(menu.row, menu.col, null, true);
                  closeMenus();
                }}
              >
                丢弃此列（不合并）
              </button>
            )}
            {menuCell.discard && (
              <button
                type="button"
                onClick={() => {
                  assign(menu.row, menu.col, null);
                  closeMenus();
                }}
              >
                撤销丢弃
              </button>
            )}
            {menuCell.manual && (
              <button
                type="button"
                onClick={() => {
                  setRows((current) =>
                    current.map((state, index) =>
                      index === menu.row
                        ? {
                            ...state,
                            cells: state.cells.map((cell, i) =>
                              i === menu.col
                                ? {
                                    ...cell,
                                    target: cell.machineTarget,
                                    discard: false,
                                    manual: false,
                                  }
                                : cell,
                            ),
                          }
                        : state,
                    ),
                  );
                  closeMenus();
                }}
              >
                ↺ 恢复机器建议
              </button>
            )}
            <div className="hmg-menu-sep">并入标准列：</div>
            {template.headers.map((header, col) =>
              col === menuCell.target || excluded.has(col) ? null : (
                <button
                  key={col}
                  type="button"
                  onClick={() => {
                    assign(menu.row, menu.col, col);
                    closeMenus();
                  }}
                >
                  {header}
                </button>
              ),
            )}
          </div>
        )}

        {headerMenu && (
          <div
            className="hmg-menu"
            style={{ left: headerMenu.x, top: headerMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="hmg-menu-title">{template.headers[headerMenu.col]}</div>
            {excluded.has(headerMenu.col) ? (
              <button
                type="button"
                onClick={() => {
                  setExcluded((current) => {
                    const next = new Set(current);
                    next.delete(headerMenu.col);
                    return next;
                  });
                  closeMenus();
                }}
              >
                恢复此标准列
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  excludeColumn(headerMenu.col);
                  closeMenus();
                }}
              >
                此列全部不合并
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DetectionEditor(props: {
  detection: HeaderMatchDetection;
  onApply: (headerRow: number, headerRowsCount: number) => void;
  compact?: boolean;
}) {
  const { detection, onApply, compact } = props;
  const [row, setRow] = useState(String(detection.headerRow + 1));
  const [count, setCount] = useState(String(detection.headerRowsCount));
  useEffect(() => {
    setRow(String(detection.headerRow + 1));
    setCount(String(detection.headerRowsCount));
  }, [detection]);
  return (
    <span className={compact ? "hmg-detect-edit hmg-detect-edit-compact" : "hmg-detect-edit"}>
      表头识别于第
      <input
        value={row}
        aria-label="表头所在行号"
        onChange={(event) => setRow(event.target.value.replace(/[^0-9]/g, ""))}
        className="hmg-detect-input"
      />
      行 ·
      <select
        value={count}
        aria-label="表头层数"
        onChange={(event) => setCount(event.target.value)}
      >
        <option value="1">单层</option>
        <option value="2">两层</option>
      </select>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => {
          const headerRow = Math.max(1, Number.parseInt(row, 10) || 1) - 1;
          const headerRowsCount = count === "2" ? 2 : 1;
          onApply(headerRow, headerRowsCount);
        }}
      >
        ✎ 修改
      </Button>
    </span>
  );
}
