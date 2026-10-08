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
    /** 未匹配（独立）列的输出顺序：源列下标按用户在未匹配区的排序。 */
    independentOrder: number[];
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
  /** 未匹配列的用户排序（源列下标，非丢弃）；未列出的按源顺序垫后。 */
  unmatchedOrder: number[];
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

function unmatchedColumnsOf(cells: CellState[]): number[] {
  return cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => cell.target == null && !cell.discard)
    .map(({ index }) => index);
}

function toRowState(
  row: HeaderMatchPreview["rows"][number],
): RowState {
  const cells = row.matches.map((match) => ({
    target: match.target,
    discard: false,
    manual: false,
    machineTarget: match.target,
    confidence: match.confidence,
    reason: match.reason,
  }));
  return {
    path: row.path,
    name: row.name,
    sheet: row.sheet,
    headers: [...row.headers],
    detection: { ...row.detection },
    cells,
    unmatchedOrder: unmatchedColumnsOf(cells),
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

/** 指针拖拽的当前抓手：数据格子，或模板列头（拖出＝移出该模板列）。 */
type DragInfo =
  | { kind: "cell"; row: number; col: number; label: string }
  | { kind: "template"; col: number; label: string };

const EXTERNAL_PICK = "__pick_external__";

export function HeaderMatchGrid(props: {
  preview: HeaderMatchPreview;
  files: { path: string; name: string }[];
  busy?: boolean;
  onTemplateChange: (path: string) => void;
  onExternalTemplate: () => void;
  /** 导入对照表：返回给用户看的结果文案；用户取消返回 null。 */
  onImportAliases?: () => Promise<string | null>;
  /** 重跑机器匹配；hints 为网格里的人工配对，作为本次匹配的额外对照。 */
  onRematch: (
    templateHeaders: string[],
    headers: string[],
    hints?: [string, string][],
  ) => Promise<HeaderMatchPreview["rows"][number]["matches"]>;
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
  const [menu, setMenu] = useState<MenuState>(null);
  const [headerMenu, setHeaderMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const [fileMenu, setFileMenu] = useState<{ row: number; x: number; y: number } | null>(null);
  const [toast, setToast] = useState("");
  const [rematchBusy, setRematchBusy] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // 指针拖拽：按下记录抓手，移动超阈值后显示跟手幽灵并探测落点，
  // 抬起时按落点执行。打包版窗口的系统文件拖放接管会吞掉 HTML5 DnD
  // 事件，网格内拖拽必须自实现指针交互才在真机上可用。
  const dragRef = useRef<{
    info: DragInfo;
    startX: number;
    startY: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const [hoverDrop, setHoverDrop] = useState<string | null>(null);

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
        // 人工移入未匹配区的列按「未匹配」计——核对待办时不能被匹配数误导。
        if (cell.target == null) {
          unmatched += 1;
        } else if (cell.manual || cell.confidence >= GREEN_THRESHOLD) {
          green += 1;
        } else {
          yellow += 1;
        }
      }
    }
    return { green, yellow, unmatched };
  }, [rows]);

  /** 未匹配区的槽位数：按未匹配（含丢弃）最多的一行取宽，各行右侧留空。 */
  const unmatchedSlots = useMemo(
    () =>
      Math.max(
        1,
        ...rows.map((state) => state.cells.filter((cell) => cell.target == null).length),
      ),
    [rows],
  );

  /** 源列下标 → Excel 列字母（0→A、25→Z、26→AA）：重名列靠它区分。 */
  function columnLetter(index: number): string {
    let value = index;
    let label = "";
    do {
      label = String.fromCharCode(65 + (value % 26)) + label;
      value = Math.floor(value / 26) - 1;
    } while (value >= 0);
    return label;
  }

  function closeMenus() {
    setMenu(null);
    setHeaderMenu(null);
    setFileMenu(null);
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

  /** 未匹配区内调序：把 col 插到本行第 position 个槽位（超界钳到末尾）。 */
  function reorderUnmatched(row: number, col: number, position: number) {
    setRows((current) =>
      current.map((state, index) => {
        if (index !== row) return state;
        const order = state.unmatchedOrder.filter((value) => value !== col);
        const clamped = Math.max(0, Math.min(position, order.length));
        order.splice(clamped, 0, col);
        return { ...state, unmatchedOrder: order };
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
        unmatchedOrder: unmatchedColumnsOf(
          state.cells.map((cell) => ({
            ...cell,
            target: cell.machineTarget,
            discard: false,
          })),
        ),
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

  /** 移出模板列（延迟生效）：格子原地不动，点「重新匹配」才批量清到未匹配区。 */
  function excludeColumn(col: number) {
    setExcluded((current) => new Set(current).add(col));
    setToast(
      "模板列已移出；各文件的格子暂未变动，点「重新匹配」后统一清到未匹配区",
    );
  }

  /** 「重新匹配」：拖拽是局部动作，这里才全局生效——
   * 1) 清掉已移出模板列上的悬空格子；2) 拿当前人工配对当教材（hints），
   * 只给各文件仍处于未匹配的列重跑机器匹配，已配好的一律不动。 */
  async function rematchAll() {
    if (busy || rematchBusy) return;
    setRematchBusy(true);
    try {
      let cleared = 0;
      let filled = 0;
      setRows((current) =>
        current.map((state) => ({
          ...state,
          cells: state.cells.map((cell) => {
            if (cell.target != null && excluded.has(cell.target)) {
              cleared += 1;
              return { ...cell, target: null, manual: true, reason: "模板列已移出" };
            }
            return cell;
          }),
        })),
      );
      const hints: [string, string][] = [];
      rows.forEach((state) => {
        state.cells.forEach((cell, index) => {
          if (
            cell.manual &&
            !cell.discard &&
            cell.target != null &&
            !excluded.has(cell.target)
          ) {
            const source = state.headers[index] ?? "";
            const target = template.headers[cell.target] ?? "";
            if (source && target) hints.push([source, target]);
          }
        });
      });
      for (let row = 0; row < rows.length; row += 1) {
        const state = rows[row];
        const matches = await props.onRematch(template.headers, state.headers, hints);
        setRows((current) =>
          current.map((item, index) => {
            if (index !== row) return item;
            const cells = item.cells.map((cell, i) => {
              const match = matches[i];
              if (!match || cell.target != null || cell.discard) return cell;
              // 已移出的模板列不回填：清出来的格子不能又落回被移出的列。
              if (match.target == null || excluded.has(match.target)) return cell;
              filled += 1;
              return {
                ...cell,
                target: match.target,
                machineTarget: match.target,
                confidence: match.confidence,
                reason: match.reason,
                manual: false,
              };
            });
            return { ...item, cells };
          }),
        );
      }
      const parts = [`重新匹配完成：新配上 ${filled} 列`];
      if (cleared > 0) parts.push(`清理移出模板列的格子 ${cleared} 个`);
      if (hints.length > 0) parts.push(`以 ${hints.length} 条人工配对为教材`);
      setToast(parts.join("，"));
    } finally {
      setRematchBusy(false);
    }
  }

  async function handleImportAliases() {
    if (!props.onImportAliases) return;
    const message = await props.onImportAliases();
    if (message) setToast(message);
  }

  /** 人工修正表头行/层数：本地重新拍平表头后按新表头重跑机器匹配；
   * 之前人工拖过的配对按「源列名→目标列名」能对上的自动恢复，
   * 不让用户从白纸重连。 */
  async function applyDetectionEdit(
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
    // 修改前的人工配对快照（源列名 → 目标列名），重跑后按名字恢复。
    const manualPairs = new Map<string, string>();
    const collectManual = (state: RowState) => {
      state.cells.forEach((cell, index) => {
        if (cell.manual && !cell.discard && cell.target != null) {
          manualPairs.set(
            state.headers[index] ?? "",
            template.headers[cell.target] ?? "",
          );
        }
      });
    };
    const rebuildCells = (
      headers: string[],
      matches: { target: number | null; confidence: number; reason: string }[],
      nextTemplate: string[],
    ): CellState[] => {
      const taken = new Set<number>();
      return matches.map((match, index) => {
        const manualTarget = (() => {
          const targetName = manualPairs.get(headers[index] ?? "") ?? "";
          if (!targetName) return null;
          const target = nextTemplate.indexOf(targetName);
          if (target < 0 || taken.has(target)) return null;
          taken.add(target);
          return target;
        })();
        return {
          target: manualTarget ?? match.target,
          discard: false,
          manual: manualTarget != null,
          machineTarget: match.target,
          confidence: manualTarget != null ? 1 : match.confidence,
          reason: manualTarget != null ? "人工调整" : match.reason,
        };
      });
    };
    if (isTemplate) {
      const headers = reflatten(template.rawRows);
      const nextTemplate = headers;
      const before = rows;
      before.forEach(collectManual);
      const nextRows: RowState[] = [];
      for (const state of before) {
        const rowHeaders = reflatten(state.rawRows);
        const matches = await props.onRematch(nextTemplate, rowHeaders, []);
        const cells = rebuildCells(rowHeaders, matches, nextTemplate);
        nextRows.push({
          ...state,
          headers: rowHeaders,
          cells,
          unmatchedOrder: unmatchedColumnsOf(cells),
        });
      }
      setTemplate((current) => ({
        ...current,
        headers,
        detection: { ...current.detection, headerRow, headerRowsCount },
      }));
      setExcluded(new Set());
      setRows(nextRows);
      setToast("模板表头已更新，已按新模板重新匹配（人工配对尽量保留）");
      return;
    }
    const state = rows[row];
    if (!state) return;
    collectManual(state);
    const rowHeaders = reflatten(state.rawRows);
    const matches = await props.onRematch(template.headers, rowHeaders, []);
    const cells = rebuildCells(rowHeaders, matches, template.headers);
    setRows((current) =>
      current.map((item, index) =>
        index === row
          ? {
              ...item,
              headers: rowHeaders,
              detection: { ...item.detection, headerRow, headerRowsCount },
              cells,
              unmatchedOrder: unmatchedColumnsOf(cells),
            }
          : item,
      ),
    );
    setToast("表头已重新拍平，机器匹配已按新表头重跑（人工配对尽量保留）");
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
    // 对照表隐身化：不再有勾选，人工配对始终随计划带回，合并成功后落库。
    const rememberAliases: [string, string][] = rows.flatMap((state) =>
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
    );
    return {
      templatePath: preview.template.path,
      templateHeaders,
      rememberAliases,
      assignments: rows.map((state) => {
        const unmatchedNow = unmatchedColumnsOf(state.cells);
        const listed = state.unmatchedOrder.filter((col) =>
          unmatchedNow.includes(col),
        );
        const listedSet = new Set(listed);
        const rest = unmatchedNow.filter((col) => !listedSet.has(col));
        return {
          path: state.path,
          sheet: state.sheet,
          headerRow: state.detection.headerRow,
          headerRowsCount: state.detection.headerRowsCount,
          headers: state.headers,
          independentOrder: [...listed, ...rest],
          columns: state.cells.map((cell, source) => ({
            source,
            target: cell.target != null ? remap.get(cell.target) ?? null : null,
            discard: cell.discard,
            manual: cell.manual,
            reason: cell.manual ? "人工调整" : cell.reason,
          })),
        };
      }),
    };
  }

  async function handleConfirm() {
    const plan = await buildPlan();
    if (plan) props.onConfirm(plan);
  }

  // ───────────────────────── 指针拖拽（替代 HTML5 DnD） ─────────────────────────

  function dropTargetAt(x: number, y: number): string | null {
    const element = document.elementFromPoint(x, y);
    return element?.closest("[data-drop]")?.getAttribute("data-drop") ?? null;
  }

  function canDrop(info: DragInfo, id: string | null): boolean {
    if (!id) return false;
    if (info.kind === "template") {
      // 模板列头只认「拖到未匹配区 / 丢弃区」＝移出该模板列。
      return id.startsWith("unm:") || id === "trash";
    }
    if (id === "trash") return true;
    if (id.startsWith("col:")) {
      return !excluded.has(Number(id.slice(4)));
    }
    if (id.startsWith("unm:")) {
      // 未匹配列的排序只在本行内有效。
      return Number(id.split(":")[1]) === info.row;
    }
    return false;
  }

  function performDrop(info: DragInfo, id: string | null) {
    if (!canDrop(info, id) || !id) return;
    if (info.kind === "template") {
      excludeColumn(info.col);
      return;
    }
    if (id === "trash") {
      assign(info.row, info.col, null, true);
      return;
    }
    if (id.startsWith("col:")) {
      assign(info.row, info.col, Number(id.slice(4)));
      return;
    }
    const position = Number(id.split(":")[2]);
    if (rows[info.row]?.cells[info.col]?.target != null) {
      assign(info.row, info.col, null);
    }
    reorderUnmatched(info.row, info.col, position);
  }

  function beginDrag(info: DragInfo) {
    return (event: React.PointerEvent<HTMLElement>) => {
      // button 在个别测试环境里读不到，按主键处理；真机恒为 0。
      if ((event.button ?? 0) !== 0 || busy) return;
      dragRef.current = {
        info,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        pointerId: event.pointerId ?? -1,
      };
      closeMenus();
      try {
        // jsdom 等环境没有指针捕获时静默忽略；事件仍派发在抓手元素上。
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        /* 指针捕获不可用 */
      }
    };
  }

  function dragMove(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== (event.pointerId ?? -1)) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    setGhost({ x: event.clientX, y: event.clientY, label: drag.info.label });
    const id = dropTargetAt(event.clientX, event.clientY);
    setHoverDrop(canDrop(drag.info, id) ? id : null);
  }

  function dragEnd(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== (event.pointerId ?? -1)) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* 指针捕获不可用 */
    }
    setGhost(null);
    setHoverDrop(null);
    if (!drag.moved) return;
    performDrop(drag.info, dropTargetAt(event.clientX, event.clientY));
  }

  const dropClass = (id: string) => (hoverDrop === id ? " hmg-drop-hover" : "");

  const cellDragProps = (row: number, col: number) => ({
    "data-cell": `${row}-${col}`,
    tabIndex: 0,
    "aria-label": `表头格子 ${rows[row].headers[col] ?? ""}，回车确认建议`,
    onPointerDown: beginDrag({
      kind: "cell",
      row,
      col,
      label: rows[row].headers[col] ?? "",
    }),
    onPointerMove: dragMove,
    onPointerUp: dragEnd,
    onPointerCancel: () => {
      dragRef.current = null;
      setGhost(null);
      setHoverDrop(null);
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
                onChange={(event) => {
                  if (event.target.value === EXTERNAL_PICK) {
                    props.onExternalTemplate();
                    return;
                  }
                  props.onTemplateChange(event.target.value);
                }}
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
                <option value={EXTERNAL_PICK}>从外部文件选择…</option>
              </select>
            </label>
            {props.onImportAliases && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void handleImportAliases()}
              >
                导入对照表
              </Button>
            )}
          </div>
        </div>

        <div className="hmg-actions">
          <details className="hmg-help">
            <summary>操作说明</summary>
            <p className="hmg-hint">
              左键拖拽格子到目标列；未匹配列可在本行内排序，顺序即输出顺序。
              右键格子、列头或文件名打开菜单；拖入丢弃区可移除列，模板列头拖到未匹配区可移出。
              键盘 Tab 定位格子，Enter 确认建议。
            </p>
          </details>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || rematchBusy}
            onClick={() => void rematchAll()}
          >
            {rematchBusy ? "正在重新匹配…" : "重新匹配（只补未匹配列）"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(new Set(rows.map((_, index) => index)))}
          >
            全部展开
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(new Set())}>
            全部收起
          </Button>
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
                    data-drop={`col:${col}`}
                    className={
                      "hmg-th" +
                      (excluded.has(col) ? " hmg-th-excluded" : "") +
                      dropClass(`col:${col}`)
                    }
                    onPointerDown={beginDrag({ kind: "template", col, label: header })}
                    onPointerMove={dragMove}
                    onPointerUp={dragEnd}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      closeMenus();
                      setHeaderMenu({ col, x: event.clientX, y: event.clientY });
                    }}
                    title={
                      excluded.has(col)
                        ? `${header}（已移出，不参与输出；右键可恢复）`
                        : `${header}（拖到未匹配区＝移出此模板列）`
                    }
                  >
                    {header}
                  </th>
                ))}
                <th
                  className="hmg-th hmg-unmatched-col"
                  colSpan={unmatchedSlots}
                >
                  ⟶ 未匹配区（独立列 · 本行内拖动排序 · 拖到 🗑 丢弃）
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
                  <td
                    key={col}
                    data-drop={`col:${col}`}
                    className={"hmg-slot" + dropClass(`col:${col}`)}
                  >
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
                {Array.from({ length: unmatchedSlots }, (_, slot) => (
                  <td key={slot} className="hmg-slot hmg-slot-unmatched" />
                ))}
              </tr>
              {rows.map((state, row) => {
                const isExpanded = expanded.has(row);
                const slots = new Map<number, number>();
                state.cells.forEach((cell, col) => {
                  if (cell.target != null && !cell.discard) slots.set(cell.target, col);
                });
                const listed = state.unmatchedOrder.filter(
                  (col) =>
                    col < state.cells.length &&
                    state.cells[col].target == null &&
                    !state.cells[col].discard,
                );
                const listedSet = new Set(listed);
                const orderedUnmatched = [
                  ...listed,
                  ...state.cells
                    .map((_, col) => col)
                    .filter(
                      (col) =>
                        !listedSet.has(col) &&
                        state.cells[col].target == null &&
                        !state.cells[col].discard,
                    ),
                ];
                const discarded = state.cells
                  .map((cell, col) => ({ cell, col }))
                  .filter(({ cell }) => cell.discard)
                  .map(({ col }) => col);
                const zone = [...orderedUnmatched, ...discarded];
                return (
                  <Fragment key={`${state.path}-${state.sheet}`}>
                    <tr>
                      <td
                        className="hmg-file-cell"
                        onContextMenu={(event) => {
                          event.preventDefault();
                          closeMenus();
                          setFileMenu({ row, x: event.clientX, y: event.clientY });
                        }}
                      >
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
                            <td
                              key={col}
                              data-drop={`col:${col}`}
                              className={
                                "hmg-slot hmg-slot-empty" + dropClass(`col:${col}`)
                              }
                            >
                              <div className="hmg-empty-mark" />
                            </td>
                          );
                        }
                        const cell = state.cells[occupant];
                        const pendingClear =
                          cell.target != null && excluded.has(cell.target);
                        return (
                          <td
                            key={col}
                            data-drop={`col:${col}`}
                            className={"hmg-slot" + dropClass(`col:${col}`)}
                          >
                            <div
                              className={
                                cellClass(cell) +
                                (pendingClear ? " hmg-cell-pending-clear" : "")
                              }
                              title={
                                cell.reason
                                  ? `${state.headers[occupant]}（${columnLetter(occupant)}列） · ${cell.reason}${cell.manual ? "（人工调整）" : ""}${pendingClear ? " · 模板列已移出，点「重新匹配」后移入未匹配区" : ""}`
                                  : `${state.headers[occupant]}（${columnLetter(occupant)}列）`
                              }
                              {...cellDragProps(row, occupant)}
                            >
                              {cell.manual && <span className="hmg-manual-mark">✎</span>}
                              {state.headers[occupant]}
                              <span className="hmg-col-tag">{columnLetter(occupant)}</span>
                            </div>
                          </td>
                        );
                      })}
                      {Array.from({ length: unmatchedSlots }, (_, slot) => {
                        const col = zone[slot];
                        const dropId = `unm:${row}:${slot}`;
                        if (col == null) {
                          return (
                            <td
                              key={slot}
                              data-drop={dropId}
                              className={
                                "hmg-slot hmg-slot-unmatched" + dropClass(dropId)
                              }
                            >
                              <div className="hmg-empty-mark" />
                            </td>
                          );
                        }
                        const cell = state.cells[col];
                        return (
                          <td
                            key={slot}
                            data-drop={dropId}
                            className={"hmg-slot hmg-slot-unmatched" + dropClass(dropId)}
                          >
                            <div
                              className={cellClass(cell)}
                              title={
                                cell.discard
                                  ? `${state.headers[col]}（${columnLetter(col)}列）已丢弃`
                                  : `${state.headers[col]}（${columnLetter(col)}列）未匹配，保留为独立列；本行内可拖动排序`
                              }
                              {...cellDragProps(row, col)}
                            >
                              {cell.manual && <span className="hmg-manual-mark">✎</span>}
                              {cell.discard ? <s>{state.headers[col]}</s> : state.headers[col]}
                              <span className="hmg-col-tag">{columnLetter(col)}</span>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                    {isExpanded && (
                      <tr className="hmg-preview-row">
                        <td colSpan={template.headers.length + unmatchedSlots + 1}>
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
          <div className="hmg-discard-zone">
            <span
              className="hmg-trash"
              data-drop="trash"
              title="拖到此处丢弃此列（不合并）"
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
        {ghost && (
          <div className="hmg-ghost" style={{ left: ghost.x + 10, top: ghost.y + 10 }}>
            {ghost.label}
          </div>
        )}

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
                恢复此模板列
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  excludeColumn(headerMenu.col);
                  closeMenus();
                }}
              >
                移出此模板列（重新匹配后生效）
              </button>
            )}
          </div>
        )}

        {fileMenu && rows[fileMenu.row] && (
          <div
            className="hmg-menu"
            style={{ left: fileMenu.x, top: fileMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="hmg-menu-title">
              {rows[fileMenu.row].name} / {rows[fileMenu.row].sheet}
            </div>
            {!(
              rows[fileMenu.row].path === preview.template.path &&
              !preview.template.external
            ) && (
              <button
                type="button"
                onClick={() => {
                  props.onTemplateChange(rows[fileMenu.row].path);
                  closeMenus();
                }}
              >
                设为模板
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(fileMenu.row)) next.delete(fileMenu.row);
                  else next.add(fileMenu.row);
                  return next;
                });
                closeMenus();
              }}
            >
              {expanded.has(fileMenu.row) ? "折叠数据预览" : "展开数据预览"}
            </button>
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
