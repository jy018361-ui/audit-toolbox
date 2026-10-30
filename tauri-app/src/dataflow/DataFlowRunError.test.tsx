// @vitest-environment jsdom
// 运行失败的可见性回归：整体失败（如路径未授权）时，结果区必须显示失败原因，
// 不能停留在「尚未运行」占位——否则用户以为点了运行没反应（真实反馈于 2026-10）。
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    dataflowPreview: vi.fn(async () => {
      throw { code: "PATH_NOT_PERMITTED", userMessage: "路径未授权：C:\\凭证明细.csv", retryable: true };
    }),
  };
});

import { DataFlowPage } from "./DataFlowPage";
import { dataflowPreview } from "../api";
import { createEmptyWorkflow, saveDraft } from "./model";
import type { ToolManifest } from "../types";

const dataflowTool: ToolManifest = {
  id: "dataflow",
  name: "数据流 DataFlow",
  description: "可视化数据处理工作流",
  route: "/tools/dataflow",
  version: "1.0",
  capabilities: ["preview", "run", "save", "open"],
  migrationStatus: "preview",
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  // mock 调用计数跨用例累计（实现保留），逐例断言 not.toHaveBeenCalled 才准。
  vi.mocked(dataflowPreview).mockClear();
});

function clickCategory(name: string) {
  fireEvent.click(screen.getAllByText(name)[0].closest("button") ?? screen.getAllByText(name)[0]);
}

async function addNodeFromMenu(category: string, item: string) {
  clickCategory(category);
  const option = await screen.findByRole("menuitem", { name: new RegExp(item) });
  fireEvent.click(option);
}

it("预览运行整体失败时，结果区显示「运行失败」与原因，而不是「尚未运行」", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  fireEvent.click(screen.getAllByText("输入")[0].closest("button") ?? screen.getAllByText("输入")[0]);
  const option = await screen.findByRole("menuitem", { name: /Excel 输入/ });
  fireEvent.click(option);
  fireEvent.click(screen.getByRole("button", { name: /预览运行/ }));

  const card = await screen.findByRole("alert");
  expect(card.textContent).toContain("运行失败");
  expect(card.textContent).toContain("路径未授权");
  expect(screen.queryByText(/尚未运行/)).not.toBeInTheDocument();
  // 状态栏同步显示失败。
  expect(screen.getByText(/运行失败/)).toBeInTheDocument();
});

it("空画布点预览运行，结果区显示「画布还没有节点」错误卡而非静默无反应", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  fireEvent.click(screen.getByRole("button", { name: /预览运行/ }));
  const card = await screen.findByRole("alert");
  expect(card.textContent).toContain("画布还没有节点");
  expect(screen.queryByText(/尚未运行/)).not.toBeInTheDocument();
});

it("筛选条件行没填完整时运行被拦下：错误卡指出节点与第几条，且不真正调用引擎", async () => {
  // 真实反馈：第二行条件只填了一半，运行报「引用了字段“”」无从定位——
  // 运行前自检应直接拦下并指明「筛选」第 2 条条件。
  const wf = createEmptyWorkflow();
  wf.nodes.push(
    { id: "n1", type: "excel_in", name: "Excel输入", x: 40, y: 40, config: {} },
    {
      id: "n2",
      type: "filter_n",
      name: "筛选",
      x: 260,
      y: 40,
      config: {
        condition: {
          op: "and",
          rules: [
            { field: "年度", operator: "contains", value: "2016" },
            { field: "", operator: "=", value: "" },
          ],
        },
      },
    },
  );
  wf.edges.push({ from: "n1", to: "n2", fromAnchor: "output", toAnchor: "in" });
  saveDraft(wf);
  render(<DataFlowPage tool={dataflowTool} />);
  fireEvent.click(screen.getByRole("button", { name: /预览运行/ }));

  const card = await screen.findByRole("alert");
  expect(card.textContent).toContain("筛选");
  expect(card.textContent).toContain("第 2 条条件");
  expect(card.textContent).toContain("还没填完整");
  // 引擎未被调用：拦截发生在真正运行之前。
  expect(dataflowPreview).not.toHaveBeenCalled();
});

it("未发生失败时，结果区仍显示「尚未运行」占位，不出现错误卡", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  fireEvent.click(screen.getAllByText("输入")[0].closest("button") ?? screen.getAllByText("输入")[0]);
  const option = await screen.findByRole("menuitem", { name: /Excel 输入/ });
  fireEvent.click(option);
  expect(await screen.findByText(/尚未运行/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("引擎节点级失败（HTTP 成功＋error 字段＋保留已完成节点）：错误卡显示原因，成功节点结果不丢", async () => {
  // 引擎契约（src-tauri/src/dataflow/engine.rs:274-304）：节点级失败时保留已完成
  // 节点的结果，失败信息以 error{code,userMessage} 随调用成功（200）返回而非抛
  // 异常——这条「带部分结果的失败」通道此前只有 reject 通道的测试。
  vi.mocked(dataflowPreview).mockResolvedValueOnce({
    mode: "preview",
    nodes: {
      // n1 Excel 输入：已成功。
      n1: {
        status: "ok",
        rows: 12,
        ms: 30,
        messages: [],
        stats: ["读取 12 行"],
        anchors: {
          output: {
            columns: ["凭证号", "科目"],
            types: ["str", "str"],
            rowCount: 12,
            sample: [
              ["1001", "银行存款"],
              ["1002", "库存现金"],
            ],
          },
        },
      },
      // n2 Excel 输出：节点级失败（如目标文件已存在）。
      n2: {
        status: "error",
        rows: 0,
        ms: 8,
        messages: ["目标文件已存在：D:\\结果\\序时账.xlsx"],
        stats: [],
        anchors: {},
      },
      // n3 在失败点之后，引擎未执行到、无结果条目。
    },
    outputs: [],
    error: {
      code: "OUTPUT_FILE_EXISTS",
      userMessage: "目标文件已存在：D:\\结果\\序时账.xlsx，请删除或改名后重试。",
    },
  });
  // 输出文件名解析需要「输出位置」：预置记住值，模拟用户已选过一次。
  window.localStorage.setItem("audit-toolbox:dataflow:output-dir", "D:\\审计底稿");
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("输入", "Excel 输入"); // n1 成功
  await addNodeFromMenu("输出", "Excel 输出"); // n2 失败
  await addNodeFromMenu("筛选排序", "筛选 Filter"); // n3 未执行到（当前选中）
  fireEvent.click(screen.getByRole("button", { name: /预览运行/ }));

  // 结果区红卡显示引擎 userMessage（选中的 n3 无结果 → 走错误卡分支）。
  const card = await screen.findByRole("alert");
  expect(card.textContent).toContain("目标文件已存在");
  expect(card.textContent).toContain("请删除或改名后重试");
  // 状态栏挂错误样式并显示同一失败原因（error 非空时优先于「上次运行」摘要）。
  const status = document.querySelector(".df-status-text") as HTMLElement;
  expect(status.className).toContain("df-status-error");
  expect(status.textContent).toContain("目标文件已存在");
  // 部分结果已提交：预览横幅照常出现，没有被失败整体吞掉。
  expect(screen.getByText(/预览模式 · 样本数据/)).toBeInTheDocument();

  // 点选上游成功节点 n1：样本数据仍在（部分成功不丢），角标「成功」。
  fireEvent.click(document.querySelector('.df-node[data-id="n1"]') as HTMLElement);
  await waitFor(() => expect(document.querySelector(".df-chip")?.textContent).toBe("成功"));
  expect(screen.getByText("凭证号")).toBeInTheDocument();
  expect(screen.getByText("银行存款")).toBeInTheDocument();

  // 点选失败节点 n2：角标「失败」，「消息」页签可见引擎给出的失败原因。
  fireEvent.click(document.querySelector('.df-node[data-id="n2"]') as HTMLElement);
  await waitFor(() => expect(document.querySelector(".df-chip")?.textContent).toBe("失败"));
  fireEvent.click(screen.getByRole("tab", { name: "消息" }));
  expect(document.querySelector(".df-msg li")?.textContent).toContain("目标文件已存在");
});

it("引擎返回不符合契约的数据（status 非法枚举）时显示「不符合数据流契约」错误卡且不崩溃", async () => {
  // status 是 schema 里没有 .catch 兜底的枚举字段（model.ts
  // DataflowNodeResultSchema），传枚举外的 \"running\" 会让 safeParse 失败，
  // 命中 DataFlowPage 的防御分支；anchors/outputs 等 catch 字段的坏数据
  // 会被静默吞掉走不到该分支（见 F14），故必须用非 catch 字段触发。
  vi.mocked(dataflowPreview).mockResolvedValueOnce({
    mode: "preview",
    nodes: {
      n1: { status: "running", rows: 12, ms: 30, messages: [], stats: [], anchors: {} },
    },
    outputs: [],
    error: null,
  });
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("输入", "Excel 输入");
  fireEvent.click(screen.getByRole("button", { name: /预览运行/ }));

  // 结果区红卡显示契约错误提示（页面不崩溃、防御分支生效）。
  const card = await screen.findByRole("alert");
  expect(card.textContent).toContain("不符合数据流契约");
  expect(card.textContent).toContain("请更新应用后重试");
  // 状态栏同步挂错误样式并显示同一提示。
  const status = document.querySelector(".df-status-text") as HTMLElement;
  expect(status.className).toContain("df-status-error");
  expect(status.textContent).toContain("不符合数据流契约");
  // 运行结果未提交：预览横幅不出现、节点仍在画布上（无半成品状态）。
  expect(screen.queryByText(/预览模式 · 样本数据/)).not.toBeInTheDocument();
  expect(screen.getByText("Excel 输入", { selector: ".df-node-names b" })).toBeInTheDocument();
});
