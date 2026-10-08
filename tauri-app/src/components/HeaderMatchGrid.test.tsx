// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ConfirmDialog", () => ({
  confirmDialog: vi.fn(async () => true),
}));

import {
  HeaderMatchGrid,
  flattenTwoLayerHeader,
  type HeaderMatchPreview,
  type HeaderMatchingPlanJson,
} from "./HeaderMatchGrid";

function makePreview(): HeaderMatchPreview {
  return {
    template: {
      path: "C:/tmp/A.xlsx",
      name: "A.xlsx",
      external: false,
      headers: ["日期", "凭证号", "金额"],
      detection: { headerRow: 0, headerRowsCount: 1, confidence: 0.95, needsReview: false },
      rawRows: [["日期", "凭证号", "金额"], ["2026-01-01", "记-1", "100"]],
    },
    rows: [
      {
        path: "C:/tmp/A.xlsx",
        name: "A.xlsx",
        sheet: "Sheet1",
        headers: ["日期", "凭证号", "金额"],
        detection: { headerRow: 0, headerRowsCount: 1, confidence: 0.95, needsReview: false },
        matches: [
          { target: 0, confidence: 1, reason: "名称一致" },
          { target: 1, confidence: 1, reason: "名称一致" },
          { target: 2, confidence: 1, reason: "名称一致" },
        ],
        preview: [["2026-01-01", "记-1", "100"]],
        rawRows: [["日期", "凭证号", "金额"], ["2026-01-01", "记-1", "100"]],
      },
      {
        path: "C:/tmp/B.xlsx",
        name: "B.xlsx",
        sheet: "Sheet1",
        headers: ["记账日期", "单据编号", "备注"],
        detection: { headerRow: 1, headerRowsCount: 1, confidence: 0.8, needsReview: false },
        matches: [
          { target: 0, confidence: 0.92, reason: "常见同义写法" },
          { target: 1, confidence: 0.75, reason: "相似度 75%" },
          { target: null, confidence: 0, reason: "" },
        ],
        preview: [["2026-02-01", "D-1", "回单"]],
        rawRows: [
          ["标题行"],
          ["记账日期", "单据编号", "备注"],
          ["2026-02-01", "D-1", "回单"],
        ],
      },
    ],
    aliases: [],
  };
}

function setup(
  preview = makePreview(),
  extra: Partial<Parameters<typeof HeaderMatchGrid>[0]> = {},
) {
  const onConfirm = vi.fn();
  const onTemplateChange = vi.fn();
  const onExternalTemplate = vi.fn();
  const onCancel = vi.fn();
  const onRematch = vi.fn(
    async (
      _templateHeaders: string[],
      headers: string[],
      _hints?: [string, string][],
    ) =>
      headers.map((header) => {
        const index = preview.template.headers.indexOf(header);
        return {
          target: index >= 0 ? index : null,
          confidence: index >= 0 ? 1 : 0,
          reason: index >= 0 ? "名称一致" : "",
        };
      }),
  );
  render(
    <HeaderMatchGrid
      preview={preview}
      files={[
        { path: "C:/tmp/A.xlsx", name: "A.xlsx" },
        { path: "C:/tmp/B.xlsx", name: "B.xlsx" },
      ]}
      onTemplateChange={onTemplateChange}
      onExternalTemplate={onExternalTemplate}
      onRematch={onRematch}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...extra}
    />,
  );
  return { onConfirm, onTemplateChange, onExternalTemplate, onCancel, onRematch };
}

const statOf = (key: string) =>
  document.querySelector(`[data-stat="${key}"]`)?.textContent ?? "";

it("操作说明默认折叠，关键动作仍可操作且保留键盘帮助", () => {
  setup();
  const summary = screen.getByText("操作说明");
  expect(summary.closest("details")?.open).toBe(false);
  expect(screen.getByRole("button", { name: /开始合并/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "下一处待确认" })).toBeTruthy();
  expect(summary.closest("details")?.textContent).toContain("键盘 Tab 定位格子，Enter 确认建议");
  cleanup();
});

/** 模板第 col 列的表头单元格（drop 目标）。 */
const columnHeader = (col: number) =>
  document.querySelector(`th[data-column="${col}"]`) as HTMLElement;

/** 未匹配区第 row 行第 slot 个槽位（drop 目标）。 */
const unmatchedSlot = (row: number, slot: number) =>
  document.querySelector(`[data-drop="unm:${row}:${slot}"]`) as HTMLElement;

const confirmButton = () =>
  screen.getByRole("button", { name: /开始合并/ }) as HTMLButtonElement;

const rematchButton = () =>
  screen.getByRole("button", { name: /重新匹配/ }) as HTMLButtonElement;

/** 指针拖拽：mock elementFromPoint 命中目标格，模拟按下-移动-抬起。
 * 打包版窗口里 HTML5 DnD 被文件拖放接管吞掉，网格拖拽走指针事件，
 * 测试也必须走同一条路才测得出真实行为。 */
function pointerDrag(chip: HTMLElement, target: HTMLElement) {
  // jsdom 没有实现 elementFromPoint，先补一个占位再打桩。
  if (typeof document.elementFromPoint !== "function") {
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => null,
    });
  }
  const spy = vi
    .spyOn(document, "elementFromPoint")
    .mockReturnValue(target as Element);
  try {
    fireEvent.pointerDown(chip, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(chip, { pointerId: 7, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(chip, { pointerId: 7, clientX: 60, clientY: 40 });
  } finally {
    spy.mockRestore();
  }
}

describe("两层表头拍平（前端本地口径）", () => {
  it("父级向右填充，父子用连字符连接", () => {
    expect(
      flattenTwoLayerHeader(["日期", "金额", "", "余额"], ["", "借方", "贷方", ""]),
    ).toEqual(["日期", "金额-借方", "金额-贷方", "余额"]);
  });
});

describe("表头匹配网格", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it("模板行置顶并按绿黄红统计格子", () => {
    setup();
    expect(screen.getByText("基准")).toBeTruthy();
    // A 行 3 绿 + B 行 1 绿（别名 0.92）= 4；B 行 1 黄（0.75）；1 红（备注）。
    expect(statOf("green")).toBe("4 匹配");
    expect(statOf("yellow")).toBe("1 待确认");
    expect(statOf("unmatched")).toBe("1 未匹配");
  });

  it("未匹配区的格子拖到列上即建立映射，人工配对始终进对照表", async () => {
    const { onConfirm } = setup();
    const note = screen.getByText("备注").closest("[data-cell]") as HTMLElement;
    pointerDrag(note, columnHeader(2));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const plan = onConfirm.mock.calls[0][0] as HeaderMatchingPlanJson;
    const bColumns = plan.assignments[1].columns;
    expect(bColumns[2].target).toBe(2);
    expect(bColumns[2].manual).toBe(true);
    // 对照表隐身化：没有勾选，人工配对默认随计划带回。
    expect(plan.rememberAliases).toContainEqual(["备注", "金额"]);
  });

  it("拖到已占用列直接交换而不是报错", async () => {
    const { onConfirm } = setup();
    const voucher = screen.getByText("单据编号").closest("[data-cell]") as HTMLElement;
    pointerDrag(voucher, columnHeader(0));
    await waitFor(() => screen.getByText(/已与「记账日期」交换/));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const plan = onConfirm.mock.calls[0][0] as HeaderMatchingPlanJson;
    const bColumns = plan.assignments[1].columns;
    expect(bColumns[0].target).toBe(1);
    expect(bColumns[1].target).toBe(0);
  });

  it("未匹配列在本行内拖动排序，排序即输出顺序", async () => {
    const preview = makePreview();
    preview.rows[1].headers = ["记账日期", "单据编号", "备注", "附注"];
    preview.rows[1].matches = [
      { target: 0, confidence: 0.92, reason: "常见同义写法" },
      { target: 1, confidence: 0.75, reason: "相似度 75%" },
      { target: null, confidence: 0, reason: "" },
      { target: null, confidence: 0, reason: "" },
    ];
    const { onConfirm } = setup(preview);
    // 把第 4 列「附注」拖到未匹配区第 0 格（备注前面）。
    const note2 = screen.getByText("附注").closest("[data-cell]") as HTMLElement;
    pointerDrag(note2, unmatchedSlot(1, 0));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const plan = onConfirm.mock.calls[0][0] as HeaderMatchingPlanJson;
    expect(plan.assignments[1].independentOrder).toEqual([3, 2]);
  });

  it("跨行拖入未匹配区不生效（排序只在本行内）", async () => {
    const preview = makePreview();
    preview.rows[1].headers = ["记账日期", "单据编号", "备注", "附注"];
    preview.rows[1].matches = [
      { target: 0, confidence: 0.92, reason: "常见同义写法" },
      { target: 1, confidence: 0.75, reason: "相似度 75%" },
      { target: null, confidence: 0, reason: "" },
      { target: null, confidence: 0, reason: "" },
    ];
    setup(preview);
    const note2 = screen.getByText("附注").closest("[data-cell]") as HTMLElement;
    // A 行（row 0）的未匹配槽位：B 行的格子拖过去应当无效。
    pointerDrag(note2, unmatchedSlot(0, 0));
    expect(statOf("unmatched")).toBe("2 未匹配");
  });

  it("右键菜单可移至未匹配区与丢弃", async () => {
    const { onConfirm } = setup();
    fireEvent.contextMenu(
      screen.getByText("记账日期").closest("[data-cell]") as HTMLElement,
    );
    fireEvent.click(screen.getByText("移至未匹配区"));
    fireEvent.contextMenu(
      screen.getByText("备注").closest("[data-cell]") as HTMLElement,
    );
    fireEvent.click(screen.getByText("丢弃此列（不合并）"));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const plan = onConfirm.mock.calls[0][0] as HeaderMatchingPlanJson;
    const bColumns = plan.assignments[1].columns;
    expect(bColumns[0].target).toBeNull();
    expect(bColumns[0].discard).toBe(false);
    expect(bColumns[2].discard).toBe(true);
  });

  it("全部按建议执行后黄色清零且按钮不再提示", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /全部按建议执行/ }));
    expect(statOf("yellow")).toBe("0 待确认");
    expect(confirmButton().textContent).toBe("开始合并");
  });

  it("确认时生成带表头识别信息与独立列顺序的合并计划", async () => {
    const { onConfirm } = setup();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const plan = onConfirm.mock.calls[0][0] as HeaderMatchingPlanJson;
    expect(plan.templatePath).toBe("C:/tmp/A.xlsx");
    expect(plan.templateHeaders).toEqual(["日期", "凭证号", "金额"]);
    expect(plan.rememberAliases).toEqual([]);
    const b = plan.assignments[1];
    expect(b.path).toBe("C:/tmp/B.xlsx");
    expect(b.headerRow).toBe(1);
    expect(b.headerRowsCount).toBe(1);
    expect(b.headers).toEqual(["记账日期", "单据编号", "备注"]);
    expect(b.independentOrder).toEqual([2]);
    expect(b.columns[0]).toMatchObject({ source: 0, target: 0 });
    expect(b.columns[2]).toMatchObject({ source: 2, target: null, discard: false });
  });

  it("移出模板列延迟清除：格子先不动，重新匹配后才清走", async () => {
    const { onConfirm } = setup();
    fireEvent.contextMenu(columnHeader(2));
    fireEvent.click(screen.getByText("移出此模板列（重新匹配后生效）"));
    // A 行配在「金额」上的格子原地不动，统计仍是 4 绿。
    expect(statOf("green")).toBe("4 匹配");
    fireEvent.click(rematchButton());
    await waitFor(() => expect(statOf("green")).toBe("3 匹配"));
    expect(statOf("unmatched")).toBe("2 未匹配");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const plan = onConfirm.mock.calls[0][0] as HeaderMatchingPlanJson;
    expect(plan.templateHeaders).toEqual(["日期", "凭证号"]);
    expect(plan.assignments[0].columns[2].target).toBeNull();
    expect(plan.assignments[0].independentOrder).toEqual([2]);
  });

  it("重新匹配以人工配对为教材，只补未匹配列", async () => {
    const { onRematch } = setup();
    // 教材：把 B 的「备注」人工拖到金额列。
    const note = screen.getByText("备注").closest("[data-cell]") as HTMLElement;
    pointerDrag(note, columnHeader(2));
    expect(statOf("unmatched")).toBe("0 未匹配");
    // 再把 A 的「金额」移到未匹配区，制造一个待补列。
    fireEvent.contextMenu(
      document.querySelector('[data-cell="0-2"]') as HTMLElement,
    );
    fireEvent.click(screen.getByText("移至未匹配区"));
    expect(statOf("green")).toBe("4 匹配");
    fireEvent.click(rematchButton());
    await waitFor(() => expect(statOf("green")).toBe("5 匹配"));
    // 教材提示逐行下发；A 的金额按名称一致补回，B 的备注维持人工配对。
    expect(onRematch).toHaveBeenNthCalledWith(
      1,
      ["日期", "凭证号", "金额"],
      ["日期", "凭证号", "金额"],
      [["备注", "金额"]],
    );
  });

  it("展开数据预览并人工修正表头行后自动重跑机器匹配", async () => {
    const { onRematch } = setup();
    fireEvent.click(screen.getAllByRole("button", { name: "展开数据预览" })[1]);
    expect(screen.getByText("回单")).toBeTruthy();
    const input = screen.getByLabelText("表头所在行号") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getAllByText("✎ 修改")[0]);
    await waitFor(() =>
      expect(screen.getByText(/机器匹配已按新表头重跑/)).toBeTruthy(),
    );
    expect(onRematch).toHaveBeenCalledWith(
      ["日期", "凭证号", "金额"],
      ["2026-02-01", "D-1", "回单"],
      [],
    );
    // 新表头三列与模板无同名，重跑后全部回到未匹配。
    expect(statOf("unmatched")).toBe("3 未匹配");
  });

  it("手动移入未匹配区的列计入未匹配而不是匹配", async () => {
    setup();
    fireEvent.contextMenu(
      screen.getByText("记账日期").closest("[data-cell]") as HTMLElement,
    );
    fireEvent.click(screen.getByText("移至未匹配区"));
    // 记账日期原是机器绿：移走后绿 4→3，未匹配 1→2，核对时不被匹配数误导。
    expect(statOf("green")).toBe("3 匹配");
    expect(statOf("unmatched")).toBe("2 未匹配");
  });

  it("一键展开与收起全部", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(screen.getAllByText("回单").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
    expect(screen.queryByText("回单")).toBeNull();
  });

  it("文件名右键可直接设为模板", () => {
    const { onTemplateChange } = setup();
    const fileCells = document.querySelectorAll(".hmg-file-cell");
    fireEvent.contextMenu(fileCells[2] as HTMLElement);
    fireEvent.click(screen.getByText("设为模板"));
    expect(onTemplateChange).toHaveBeenCalledWith("C:/tmp/B.xlsx");
  });

  it("模板下拉选择外部文件入口", () => {
    const { onExternalTemplate } = setup();
    const select = document.querySelector(".hmg-template select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "__pick_external__" } });
    expect(onExternalTemplate).toHaveBeenCalled();
  });

  it("导入对照表后展示结果提示", async () => {
    setup(makePreview(), {
      onImportAliases: vi.fn(async () => "已导入 3 条对照；点「重新匹配」即可按新对照生效"),
    });
    fireEvent.click(screen.getByRole("button", { name: /导入对照表/ }));
    await waitFor(() =>
      expect(screen.getByText(/已导入 3 条对照/)).toBeTruthy(),
    );
  });

  it("模板列头拖到未匹配区即移出该列", async () => {
    setup();
    pointerDrag(columnHeader(2), unmatchedSlot(1, 0));
    expect(statOf("green")).toBe("4 匹配");
    await waitFor(() =>
      expect(screen.getByText(/模板列已移出/)).toBeTruthy(),
    );
  });
});
