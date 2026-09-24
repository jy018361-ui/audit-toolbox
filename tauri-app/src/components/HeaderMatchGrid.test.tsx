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

function setup(preview = makePreview()) {
  const onConfirm = vi.fn();
  const onTemplateChange = vi.fn();
  const onExternalTemplate = vi.fn();
  const onCancel = vi.fn();
  const onRematch = vi.fn(async (_templateHeaders: string[], headers: string[]) =>
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
    />,
  );
  return { onConfirm, onTemplateChange, onExternalTemplate, onCancel, onRematch };
}

const statOf = (key: string) =>
  document.querySelector(`[data-stat="${key}"]`)?.textContent ?? "";

/** 模板第 col 列的表头单元格（drop 目标）。 */
const columnHeader = (col: number) =>
  document.querySelector(`th[data-column="${col}"]`) as HTMLElement;

const confirmButton = () =>
  screen.getByRole("button", { name: /开始合并/ }) as HTMLButtonElement;

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

  it("未匹配区的格子拖到列上即建立映射", async () => {
    const { onConfirm } = setup();
    const note = screen.getByText("备注").closest("[data-cell]") as HTMLElement;
    fireEvent.dragStart(note);
    fireEvent.drop(columnHeader(2));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const plan = onConfirm.mock.calls[0][0] as HeaderMatchingPlanJson;
    const bColumns = plan.assignments[1].columns;
    expect(bColumns[2].target).toBe(2);
    expect(bColumns[2].manual).toBe(true);
  });

  it("拖到已占用列直接交换而不是报错", async () => {
    const { onConfirm } = setup();
    const voucher = screen.getByText("单据编号").closest("[data-cell]") as HTMLElement;
    fireEvent.dragStart(voucher);
    fireEvent.drop(columnHeader(0));
    await waitFor(() => screen.getByText(/已与「记账日期」交换/));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const plan = onConfirm.mock.calls[0][0] as HeaderMatchingPlanJson;
    const bColumns = plan.assignments[1].columns;
    expect(bColumns[0].target).toBe(1);
    expect(bColumns[1].target).toBe(0);
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

  it("确认时生成带表头识别信息的合并计划", async () => {
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
    expect(b.columns[0]).toMatchObject({ source: 0, target: 0 });
    expect(b.columns[2]).toMatchObject({ source: 2, target: null, discard: false });
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
    );
    // 新表头三列与模板无同名，重跑后全部回到未匹配。
    expect(statOf("unmatched")).toBe("3 未匹配");
  });

  it("勾选记住对照表后人工配对进入计划", async () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByText("记住本次手动对应关系，以后自动匹配"));
    const note = screen.getByText("备注").closest("[data-cell]") as HTMLElement;
    fireEvent.dragStart(note);
    fireEvent.drop(columnHeader(2));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const plan = onConfirm.mock.calls[0][0] as HeaderMatchingPlanJson;
    expect(plan.rememberAliases).toContainEqual(["备注", "金额"]);
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

  it("列头菜单可整列剔除且剔除列不进输出", async () => {
    const { onConfirm } = setup();
    fireEvent.contextMenu(columnHeader(2));
    fireEvent.click(screen.getByText("此列全部不合并"));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const plan = onConfirm.mock.calls[0][0] as HeaderMatchingPlanJson;
    expect(plan.templateHeaders).toEqual(["日期", "凭证号"]);
    // A 文件原第 3 列（金额）随标准列剔除而失去目标，target 重编号后仍指向正确列。
    expect(plan.assignments[0].columns[0].target).toBe(0);
    expect(plan.assignments[0].columns[2].target).toBeNull();
  });
});
