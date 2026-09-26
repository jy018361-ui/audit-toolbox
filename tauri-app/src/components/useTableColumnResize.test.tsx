// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable } from "./DataTable";
import { useTableColumnResize } from "./useTableColumnResize";
import {
  clampWidth,
  columnWidthsStorageKey,
  normalizeHeaderLabel,
  readStoredWidths,
  writeStoredWidths,
} from "./useTableColumnResize";

function setCellWidths(table: HTMLTableElement, widths: number[]): void {
  const headers = Array.from(table.querySelectorAll("thead th"));
  headers.forEach((th, index) => {
    Object.defineProperty(th, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: widths[index] ?? 100, left: 0, right: widths[index] ?? 100 }),
    });
  });
}

function setCellScrollWidths(table: HTMLTableElement, widths: number[]): void {
  table.querySelectorAll("tr").forEach((row) => {
    Array.from(row.cells).forEach((cell, index) => {
      Object.defineProperty(cell, "scrollWidth", {
        configurable: true,
        get: () => widths[index] ?? 60,
      });
    });
  });
}

function storedPayload(storageKey: string): { labels: string[]; widths: number[] } | null {
  const raw = window.localStorage.getItem(columnWidthsStorageKey(storageKey));
  return raw ? (JSON.parse(raw) as { labels: string[]; widths: number[] }) : null;
}

/**
 * 测试库的 fireEvent.pointerDown 在 jsdom 里造出的是没有 button 字段的裸 Event，
 * 这里直接派发 MouseEvent 指定事件类型，带上真实浏览器 PointerEvent 携带的坐标与按键。
 */
function drag(handle: Element, fromX: number, toX: number): void {
  handle.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: fromX }),
  );
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: toX }));
  window.dispatchEvent(new MouseEvent("pointerup", {}));
}

describe("列宽调整纯逻辑", () => {
  it("表头文案规范化：折叠空白并去首尾", () => {
    expect(normalizeHeaderLabel("  借方\n  金额 ")).toBe("借方 金额");
    expect(normalizeHeaderLabel(null)).toBe("");
  });

  it("clampWidth 向上取最小宽度并对非法值兜底", () => {
    expect(clampWidth(120, 56)).toBe(120);
    expect(clampWidth(30.4, 56)).toBe(56);
    expect(clampWidth(Number.NaN, 56)).toBe(56);
  });

  it("记忆读写按表头校验：列名或列数不符时作废", () => {
    writeStoredWidths("unit.case", ["甲", "乙"], [100, 200]);
    expect(readStoredWidths("unit.case", ["甲", "乙"])).toEqual([100, 200]);
    expect(readStoredWidths("unit.case", ["甲", "丙"])).toBeNull();
    expect(readStoredWidths("unit.case", ["甲"])).toBeNull();
    window.localStorage.setItem(columnWidthsStorageKey("unit.bad"), "{oops");
    expect(readStoredWidths("unit.bad", ["甲"])).toBeNull();
  });
});

describe("useTableColumnResize + DataTable 接入", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("不传 resizeKey 时不注入调整句柄", () => {
    const { container } = render(
      <DataTable columns={["列A", "列B"]} rows={[["1", "2"]]} />,
    );
    expect(container.querySelectorAll(".tcr-handle")).toHaveLength(0);
  });

  it("拖动列边界调整宽度并写入本机记忆", () => {
    const { container } = render(
      <DataTable resizeKey="demo.drag" columns={["列A", "列B"]} rows={[["1", "2"]]} />,
    );
    const table = container.querySelector("table")!;
    setCellWidths(table, [100, 100]);
    const [firstHandle] = Array.from(container.querySelectorAll<HTMLDivElement>(".tcr-handle"));

    drag(firstHandle, 200, 245);

    const cols = table.querySelectorAll("colgroup col");
    expect(cols).toHaveLength(2);
    expect((cols[0] as HTMLElement).style.width).toBe("145px");
    expect((cols[1] as HTMLElement).style.width).toBe("100px");
    expect(table.style.width).toBe("245px");
    expect(table.style.tableLayout).toBe("fixed");
    expect(storedPayload("demo.drag")).toEqual({
      v: 1,
      labels: ["列A", "列B"],
      widths: [145, 100],
    });
  });

  it("拖动不允许低于最小列宽", () => {
    const { container } = render(
      <DataTable resizeKey="demo.min" columns={["列A", "列B"]} rows={[["1", "2"]]} />,
    );
    const table = container.querySelector("table")!;
    setCellWidths(table, [100, 100]);
    const [firstHandle] = Array.from(container.querySelectorAll<HTMLDivElement>(".tcr-handle"));

    drag(firstHandle, 200, -500);

    expect((table.querySelectorAll("colgroup col")[0] as HTMLElement).style.width).toBe("56px");
  });

  it("重新挂载后按记忆恢复列宽", () => {
    writeStoredWidths("demo.restore", ["列A", "列B"], [180, 120]);
    const { container } = render(
      <DataTable resizeKey="demo.restore" columns={["列A", "列B"]} rows={[["1", "2"]]} />,
    );
    const table = container.querySelector("table")!;
    const cols = table.querySelectorAll("colgroup col");
    expect((cols[0] as HTMLElement).style.width).toBe("180px");
    expect((cols[1] as HTMLElement).style.width).toBe("120px");
    expect(table.style.tableLayout).toBe("fixed");
  });

  it("列结构变化后旧记忆作废，回到自然布局", async () => {
    writeStoredWidths("demo.rebuild", ["列A", "列B"], [180, 120]);
    const view = render(
      <DataTable resizeKey="demo.rebuild" columns={["列A", "列B"]} rows={[["1", "2"]]} />,
    );
    expect(view.container.querySelector("table")!.style.tableLayout).toBe("fixed");

    view.rerender(
      <DataTable resizeKey="demo.rebuild" columns={["新甲", "新乙", "新丙"]} rows={[["1", "2", "3"]]} />,
    );
    await act(async () => {});
    const table = view.container.querySelector("table")!;
    expect(table.style.tableLayout).toBe("");
    // 新表头重新出现句柄，且记忆未套用
    expect(view.container.querySelectorAll(".tcr-handle")).toHaveLength(3);
    expect(table.querySelector("colgroup")).toBeNull();
  });

  it("双击句柄按内容自适应列宽", () => {
    const { container } = render(
      <DataTable resizeKey="demo.fit" columns={["列A", "列B"]} rows={[["很长的内容", "2"]]} />,
    );
    const table = container.querySelector("table")!;
    setCellWidths(table, [100, 100]);
    setCellScrollWidths(table, [480, 60]);
    const [firstHandle] = Array.from(container.querySelectorAll<HTMLDivElement>(".tcr-handle"));

    fireEvent.dblClick(firstHandle);

    const cols = table.querySelectorAll("colgroup col");
    expect((cols[0] as HTMLElement).style.width).toBe("490px");
    expect((cols[1] as HTMLElement).style.width).toBe("100px");
    expect(storedPayload("demo.fit")?.widths).toEqual([490, 100]);
  });

  it("双击自适应对超宽列会收回（Excel 精确贴合语义）", () => {
    // 先用记忆把第一列撑到 400，再双击收回内容宽
    writeStoredWidths("demo.shrink", ["列A", "列B"], [400, 120]);
    const { container } = render(
      <DataTable resizeKey="demo.shrink" columns={["列A", "列B"]} rows={[["内容", "2"]]} />,
    );
    const table = container.querySelector("table")!;
    setCellScrollWidths(table, [110, 60]);
    const [firstHandle] = Array.from(container.querySelectorAll<HTMLDivElement>(".tcr-handle"));

    fireEvent.dblClick(firstHandle);

    const cols = table.querySelectorAll("colgroup col");
    expect((cols[0] as HTMLElement).style.width).toBe("120px");
    expect((cols[1] as HTMLElement).style.width).toBe("120px");
  });

  it("双击自适应有上限，避免超长路径把表格撑爆", () => {
    const { container } = render(
      <DataTable resizeKey="demo.cap" columns={["路径"]} rows={[["x"]]} />,
    );
    const table = container.querySelector("table")!;
    setCellWidths(table, [100]);
    setCellScrollWidths(table, [5000]);
    const [handle] = Array.from(container.querySelectorAll<HTMLDivElement>(".tcr-handle"));

    fireEvent.dblClick(handle);

    expect((table.querySelectorAll("colgroup col")[0] as HTMLElement).style.width).toBe("720px");
  });

  it("右键句柄重置整表列宽并清除记忆", () => {
    writeStoredWidths("demo.reset", ["列A", "列B"], [180, 120]);
    const { container } = render(
      <DataTable resizeKey="demo.reset" columns={["列A", "列B"]} rows={[["1", "2"]]} />,
    );
    const table = container.querySelector("table")!;
    const [firstHandle] = Array.from(container.querySelectorAll<HTMLDivElement>(".tcr-handle"));

    fireEvent.contextMenu(firstHandle);

    expect(window.localStorage.getItem(columnWidthsStorageKey("demo.reset"))).toBeNull();
    expect(table.style.tableLayout).toBe("");
    expect(table.querySelector("colgroup")).toBeNull();
    expect(container.querySelectorAll(".tcr-handle")).toHaveLength(2);
  });

  it("键盘方向键可调宽，Shift 微调", () => {
    const { container } = render(
      <DataTable resizeKey="demo.key" columns={["列A"]} rows={[["1"]]} />,
    );
    const table = container.querySelector("table")!;
    setCellWidths(table, [100]);
    const [handle] = Array.from(container.querySelectorAll<HTMLDivElement>(".tcr-handle"));

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect((table.querySelectorAll("colgroup col")[0] as HTMLElement).style.width).toBe("116px");

    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect((table.querySelectorAll("colgroup col")[0] as HTMLElement).style.width).toBe("114px");
  });

  it("表结构未就绪时（空数据无表格）出现表格后自动接管", async () => {
    const view = render(
      <DataTable resizeKey="demo.late" columns={["列A"]} rows={[]} />,
    );
    expect(view.container.querySelector("table")).toBeNull();

    view.rerender(<DataTable resizeKey="demo.late" columns={["列A"]} rows={[["1"]]} />);
    await waitFor(() => {
      expect(view.container.querySelectorAll(".tcr-handle")).toHaveLength(1);
    });
  });

  it("合并表头（colspan）不接管，静默降级", () => {
    function MergedHeaderTable() {
      const resize = useTableColumnResize<HTMLDivElement>({ storageKey: "demo.merged" });
      return (
        <div ref={resize.ref}>
          <table>
            <thead>
              <tr>
                <th colSpan={2}>合并表头</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1</td>
                <td>2</td>
              </tr>
            </tbody>
          </table>
        </div>
      );
    }
    const { container } = render(<MergedHeaderTable />);
    expect(container.querySelectorAll(".tcr-handle")).toHaveLength(0);
  });
});
