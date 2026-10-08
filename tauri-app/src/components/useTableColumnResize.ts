import { useCallback, useEffect, useRef } from "react";

/**
 * 表格列宽调整的统一能力（Excel 式）：
 *
 * - 拖动列边界调整宽度；双击边界按内容自适应（最长内容单行宽度）；
 *   右键边界重置整表列宽。
 * - 列宽按 `storageKey` 记在本机 localStorage，下次打开保持；
 *   表头列数或列名变化后旧记忆自动作废，回到自然布局。
 * - 句柄对读屏软件隐藏（aria-hidden）：带名称的句柄会混进表头单元格的
 *   可访问名（读成「科目 调整『科目』列宽」），列宽调整按 Excel 对等
 *   只走鼠标，表头语义保持干净。
 *
 * 接入方式：把返回的 `ref` 挂在**只包含一张表**的容器元素上
 * （容器即表格本身也可以）。表格可以晚于容器渲染（如空数据时不渲染表），
 * 内部会观察容器，表格出现后自动接管：
 *
 * ```tsx
 * const resize = useTableColumnResize({ storageKey: "fa-list.preview" });
 * <div ref={resize.ref}><table>…</table></div>
 * ```
 *
 * 已有 `<colgroup>` 的表（如账表核对结果表）直接复用其 `<col>`，
 * 列数与表头不符或表头有合并单元格（colspan/rowspan）时不接管，静默降级。
 * 接管后行内样式改写 `table-layout: fixed` 与表宽，重置时恢复原值。
 */

const STORAGE_PREFIX = "audit-toolbox.colwidths.";
export const TABLE_COLUMN_RESIZE_MIN_WIDTH = 56;
export const TABLE_COLUMN_RESIZE_MAX_FIT_WIDTH = 720;
/** 双击自适应时在量得的内容宽度上再加的余量（边框、句柄、取整） */
const AUTO_FIT_SLACK = 10;

export type TableColumnResizeOptions = {
  /** 记忆键：同一处表格跨会话共用；空串表示禁用 */
  storageKey: string;
  minWidth?: number;
  maxFitWidth?: number;
};

export type UseTableColumnResizeResult<T extends HTMLElement> = {
  ref: React.RefObject<T | null>;
  /** 清除本表记忆并恢复自然列宽 */
  reset: () => void;
};

type StoredPayload = { v: 1; labels: string[]; widths: number[] };

export function columnWidthsStorageKey(storageKey: string): string {
  return STORAGE_PREFIX + storageKey;
}

export function normalizeHeaderLabel(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

export function clampWidth(value: number, min: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.round(value));
}

export function readStoredWidths(storageKey: string, labels: string[]): number[] | null {
  if (!storageKey) return null;
  try {
    const raw = window.localStorage.getItem(columnWidthsStorageKey(storageKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPayload;
    if (parsed?.v !== 1) return null;
    if (!Array.isArray(parsed.labels) || !Array.isArray(parsed.widths)) return null;
    if (parsed.labels.length !== labels.length || parsed.widths.length !== labels.length) return null;
    for (let i = 0; i < labels.length; i += 1) {
      if (parsed.labels[i] !== labels[i]) return null;
      if (!Number.isFinite(parsed.widths[i])) return null;
    }
    return parsed.widths.map((w) => Math.max(0, Math.round(w)));
  } catch {
    return null;
  }
}

export function writeStoredWidths(storageKey: string, labels: string[], widths: number[]): void {
  if (!storageKey) return;
  try {
    const payload: StoredPayload = { v: 1, labels, widths };
    window.localStorage.setItem(columnWidthsStorageKey(storageKey), JSON.stringify(payload));
  } catch {
    // localStorage 不可用（隐私模式等）时只放弃记忆，不影响当次调整
  }
}

export function clearStoredWidths(storageKey: string): void {
  if (!storageKey) return;
  try {
    window.localStorage.removeItem(columnWidthsStorageKey(storageKey));
  } catch {
    // 同上，静默
  }
}

type ControllerConfig = { storageKey: string; minWidth: number; maxFitWidth: number };

type DragState = {
  index: number;
  startX: number;
  widths: number[];
  handle: HTMLDivElement;
};

/** 命令式控制器：不依赖 React 生命周期之外的状态，便于页面级表格直接接入 */
class TableColumnResizeController {
  private readonly container: HTMLElement;
  private readonly config: ControllerConfig;
  private table: HTMLTableElement | null = null;
  private containerObserver: MutationObserver | null = null;
  private tableObserver: MutationObserver | null = null;
  private handles: { th: HTMLTableCellElement; handle: HTMLDivElement }[] = [];
  private currentLabels: string[] = [];
  private currentWidths: number[] | null = null;
  private owned = false;
  private createdColgroup = false;
  private originalInline: { layout: string; width: string; minWidth: string } | null = null;
  private drag: DragState | null = null;
  private applying = 0;
  private syncScheduled = false;

  constructor(container: HTMLElement, config: ControllerConfig) {
    this.container = container;
    this.config = config;
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
  }

  connect(): void {
    this.containerObserver = new MutationObserver(() => this.scheduleSync());
    this.containerObserver.observe(this.container, { childList: true, subtree: true });
    this.bindTable(this.container.querySelector("table"));
  }

  disconnect(): void {
    this.endDrag(true);
    this.containerObserver?.disconnect();
    this.tableObserver?.disconnect();
    this.removeHandles();
    this.restoreInline();
    this.containerObserver = null;
    this.tableObserver = null;
    this.table = null;
  }

  resetAll(): void {
    clearStoredWidths(this.config.storageKey);
    this.restoreInline();
  }

  // ---- 绑定与结构同步 ----

  private bindTable(table: Element | null): void {
    this.tableObserver?.disconnect();
    this.tableObserver = null;
    this.removeHandles();
    this.restoreInline();
    this.table = table instanceof HTMLTableElement ? table : null;
    if (!this.table) return;
    this.tableObserver = new MutationObserver(() => this.scheduleSync());
    this.tableObserver.observe(this.table, { childList: true, subtree: true });
    this.sync();
  }

  private scheduleSync(): void {
    if (this.syncScheduled || this.applying > 0) return;
    this.syncScheduled = true;
    queueMicrotask(() => {
      this.syncScheduled = false;
      this.sync();
    });
  }

  private headerRow(): HTMLTableRowElement | null {
    const rows = this.table?.tHead?.rows;
    if (!rows || rows.length !== 1) return null;
    const row = rows[0];
    const cells = Array.from(row.cells);
    if (cells.some((cell) => cell.colSpan > 1 || cell.rowSpan > 1)) return null;
    const colgroup = this.table?.querySelector(":scope > colgroup");
    if (colgroup && colgroup.children.length !== cells.length) return null;
    return row;
  }

  private sync(): void {
    const nextTable = this.container.querySelector("table");
    if (nextTable !== this.table) {
      this.bindTable(nextTable);
      return;
    }
    const row = this.headerRow();
    if (!row) {
      this.removeHandles();
      this.restoreInline();
      this.currentLabels = [];
      return;
    }
    const labels = Array.from(row.cells).map((cell) => normalizeHeaderLabel(cell.textContent));
    if (labels.join("\u0000") !== this.currentLabels.join("\u0000")) {
      this.currentLabels = labels;
      // 列结构变化：回到自然布局，按新表头重建句柄；旧记忆若对新表头有效则沿用
      this.restoreInline();
      this.rebuildHandles(row);
      const stored = readStoredWidths(this.config.storageKey, labels);
      if (stored) this.applyWidths(stored);
      return;
    }
    if (this.owned && this.currentWidths) {
      // React 重渲染可能重建 <col>，行内宽度丢失后重新落一遍
      this.applyWidths(this.currentWidths);
    }
  }

  private rebuildHandles(row: HTMLTableRowElement): void {
    this.removeHandles();
    Array.from(row.cells).forEach((th) => {
      if (getComputedStyle(th).position === "static") {
        th.dataset.tcrPositioned = "1";
        th.style.position = "relative";
      }
      const handle = document.createElement("div");
      handle.className = "tcr-handle";
      handle.setAttribute("aria-hidden", "true");
      handle.title = "拖动调整列宽；双击自适应内容；右键重置整表列宽";
      const index = th.cellIndex;
      handle.addEventListener("pointerdown", (event) => this.onPointerDown(event, index, handle));
      handle.addEventListener("dblclick", () => this.autoFit(index));
      handle.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.resetAll();
      });
      th.appendChild(handle);
      this.handles.push({ th, handle });
    });
  }

  private removeHandles(): void {
    this.handles.forEach(({ th, handle }) => {
      handle.remove();
      if (th.dataset.tcrPositioned === "1") {
        delete th.dataset.tcrPositioned;
        th.style.position = "";
      }
    });
    this.handles = [];
  }

  // ---- 宽度接管 ----

  private withSelfChange(action: () => void): void {
    this.applying += 1;
    try {
      action();
    } finally {
      this.applying -= 1;
    }
  }

  private colElements(): HTMLTableColElement[] {
    const colgroup = this.table?.querySelector(":scope > colgroup");
    return colgroup ? (Array.from(colgroup.children) as HTMLTableColElement[]) : [];
  }

  private applyWidths(widths: number[]): void {
    const table = this.table;
    if (!table || widths.length === 0) return;
    let colgroup = table.querySelector(":scope > colgroup") as HTMLTableColElement | null;
    if (colgroup && colgroup.children.length !== widths.length) return;
    const targetColgroup: HTMLTableColElement = colgroup ?? document.createElement("colgroup");
    this.withSelfChange(() => {
      if (!colgroup) {
        targetColgroup.className = "tcr-colgroup";
        widths.forEach(() => {
          targetColgroup.appendChild(document.createElement("col"));
        });
        table.insertBefore(targetColgroup, table.firstChild);
        this.createdColgroup = true;
      }
      const cols = Array.from(targetColgroup.children) as HTMLTableColElement[];
      widths.forEach((width, index) => {
        cols[index].style.width = `${width}px`;
      });
      if (!this.owned) {
        this.originalInline = {
          layout: table.style.tableLayout,
          width: table.style.width,
          minWidth: table.style.minWidth,
        };
        this.owned = true;
      }
      table.style.tableLayout = "fixed";
      const total = widths.reduce((sum, width) => sum + width, 0);
      table.style.width = `${total}px`;
      table.style.minWidth = "auto";
      this.currentWidths = widths.slice();
    });
  }

  private restoreInline(): void {
    const table = this.table;
    if (!table || !this.owned) return;
    this.withSelfChange(() => {
      const original = this.originalInline ?? { layout: "", width: "", minWidth: "" };
      table.style.tableLayout = original.layout;
      table.style.width = original.width;
      table.style.minWidth = original.minWidth;
      const colgroup = table.querySelector(":scope > colgroup");
      if (colgroup) {
        if (this.createdColgroup) {
          colgroup.remove();
        } else {
          Array.from(colgroup.children).forEach((col) => {
            (col as HTMLTableColElement).style.width = "";
          });
        }
      }
      this.owned = false;
      this.createdColgroup = false;
      this.currentWidths = null;
      this.originalInline = null;
    });
  }

  private captureCurrentWidths(): number[] {
    if (this.currentWidths) return this.currentWidths.slice();
    const row = this.headerRow();
    if (!row) return [];
    return Array.from(row.cells).map((cell) =>
      clampWidth(cell.getBoundingClientRect().width, this.config.minWidth),
    );
  }

  private persist(): void {
    if (!this.currentWidths || this.currentLabels.length === 0) return;
    writeStoredWidths(this.config.storageKey, this.currentLabels, this.currentWidths);
  }

  /**
   * 最长内容按单行展示的宽度（Excel 双击自适应的口径）。
   * 接管成 fixed 布局后 scrollWidth 会被当前列宽掩盖（内容不溢出），
   * 量测前把该列临时压到最小宽度，逼内容溢出，读完再还原。
   */
  private measureNaturalWidth(index: number): number {
    const table = this.table;
    if (!table) return 0;
    const cols = this.colElements();
    const col = cols[index];
    const previousWidth = col ? col.style.width : "";
    this.withSelfChange(() => {
      if (col && this.owned) col.style.width = `${this.config.minWidth}px`;
    });
    let max = 0;
    try {
      Array.from(table.rows).forEach((row) => {
        const cell = row.cells[index];
        if (!cell || cell.colSpan > 1) return;
        const previous = cell.style.whiteSpace;
        cell.style.whiteSpace = "nowrap";
        max = Math.max(max, cell.scrollWidth, cell.getBoundingClientRect().width);
        cell.style.whiteSpace = previous;
      });
    } finally {
      this.withSelfChange(() => {
        if (col) col.style.width = previousWidth;
      });
    }
    return max;
  }

  private autoFit(index: number): void {
    const current = this.captureCurrentWidths();
    if (current.length === 0) return;
    const natural = this.measureNaturalWidth(index);
    const fitted = clampWidth(
      Math.min(natural + AUTO_FIT_SLACK, this.config.maxFitWidth),
      this.config.minWidth,
    );
    const next = current.slice();
    // Excel 语义：双击即精确贴合内容，超宽的列也会收回
    next[index] = fitted;
    this.applyWidths(next);
    this.persist();
  }

  // ---- 拖动与键盘 ----

  private onPointerDown(event: PointerEvent, index: number, handle: HTMLDivElement): void {
    if (this.drag || event.button !== 0) return;
    event.preventDefault();
    const base = this.captureCurrentWidths();
    if (base.length === 0) return;
    this.applyWidths(base);
    this.drag = { index, startX: event.clientX, widths: base, handle };
    handle.dataset.dragging = "1";
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {
      // 指针捕获失败不影响 window 级监听
    }
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    document.documentElement.classList.add("tcr-dragging");
    document.body.style.userSelect = "none";
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    const next = drag.widths.slice();
    next[drag.index] = clampWidth(next[drag.index] + delta, this.config.minWidth);
    drag.widths = next;
    const table = this.table;
    const cols = this.colElements();
    this.withSelfChange(() => {
      if (cols[drag.index]) cols[drag.index].style.width = `${next[drag.index]}px`;
      if (table) {
        table.style.width = `${next.reduce((sum, width) => sum + width, 0)}px`;
      }
    });
    this.currentWidths = next.slice();
  }

  private onPointerUp(): void {
    this.endDrag(false);
  }

  private endDrag(silent: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    delete drag.handle.dataset.dragging;
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    document.documentElement.classList.remove("tcr-dragging");
    document.body.style.userSelect = "";
    if (!silent && this.currentWidths) {
      this.applyWidths(this.currentWidths);
      this.persist();
    }
  }
}

export function useTableColumnResize<T extends HTMLElement = HTMLDivElement>(
  options: TableColumnResizeOptions,
): UseTableColumnResizeResult<T> {
  const ref = useRef<T | null>(null);
  const controllerRef = useRef<TableColumnResizeController | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const { storageKey } = optionsRef.current;
    if (!storageKey) return;
    const element = ref.current;
    if (!element) return;
    const controller = new TableColumnResizeController(element, {
      storageKey,
      minWidth: optionsRef.current.minWidth ?? TABLE_COLUMN_RESIZE_MIN_WIDTH,
      maxFitWidth: optionsRef.current.maxFitWidth ?? TABLE_COLUMN_RESIZE_MAX_FIT_WIDTH,
    });
    controllerRef.current = controller;
    controller.connect();
    return () => {
      controllerRef.current = null;
      controller.disconnect();
    };
  }, [options.storageKey]);

  const reset = useCallback(() => controllerRef.current?.resetAll(), []);

  return { ref, reset };
}
