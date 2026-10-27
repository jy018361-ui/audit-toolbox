// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { DataFlowPage } from "./DataFlowPage";
import { saveDraft } from "./model";
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
});

function clickCategory(name: string) {
  fireEvent.click(screen.getAllByText(name)[0].closest("button") ?? screen.getAllByText(name)[0]);
}

async function addNodeFromMenu(category: string, item: string) {
  clickCategory(category);
  const option = await screen.findByRole("menuitem", { name: new RegExp(item) });
  fireEvent.click(option);
}

it("渲染工具栏七个分类与右侧操作按钮", () => {
  render(<DataFlowPage tool={dataflowTool} />);
  for (const category of ["输入", "整理", "筛选排序", "关联合并", "汇总变形", "校验", "输出"]) {
    expect(screen.getAllByText(category).length).toBeGreaterThan(0);
  }
  for (const button of ["参数", "保存", "打开", "预览运行", "全量运行"]) {
    expect(screen.getByRole("button", { name: new RegExp(button) })).toBeInTheDocument();
  }
});

it("二期节点在菜单中置灰并标注「二期」", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  clickCategory("输入");
  const dbItem = await screen.findByRole("menuitem", { name: /数据库文件输入/ });
  expect(dbItem).toBeDisabled();
  expect(dbItem.textContent).toContain("二期");
});

function nodeTitleEl(text: string) {
  return screen.getByText(text, { selector: ".df-node-names b" });
}

it("从菜单添加节点，画布出现节点并可在配置区改名", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("输入", "Excel 输入");
  const node = nodeTitleEl("Excel 输入");
  expect(node).toBeInTheDocument();
  // 点击节点名选中（画布节点点击 → 配置区展示表单）。
  fireEvent.click(node.closest(".df-node") as HTMLElement);
  const nameInput = await screen.findByLabelText("节点名称");
  expect(nameInput).toBeInTheDocument();
  fireEvent.change(nameInput, { target: { value: "全年序时账" } });
  await waitFor(() =>
    expect(nodeTitleEl("全年序时账")).toBeInTheDocument(),
  );
  // 异常处理下拉属于输入节点表单。
  expect(screen.getByLabelText("异常处理（行级错误）")).toBeInTheDocument();
});

it("预览运行（浏览器演示数据）显示预览横幅、状态角标与结果页签", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("输入", "Excel 输入");
  fireEvent.click(nodeTitleEl("Excel 输入").closest(".df-node") as HTMLElement);
  fireEvent.click(screen.getByRole("button", { name: /预览运行/ }));
  const banner = await screen.findByText(/预览模式 · 样本数据/, undefined, { timeout: 4000 });
  expect(banner).toBeInTheDocument();
  // 节点角标显示行数。
  await waitFor(() => {
    const badge = document.querySelector(".df-node-badge");
    expect(badge?.textContent).toMatch(/行/);
  });
  // 结果区出现输出数据/消息/统计页签。
  for (const tab of ["输出数据", "消息", "统计"]) {
    expect(screen.getByRole("tab", { name: tab })).toBeInTheDocument();
  }
});

it("筛选节点提供 T/F 两个输出锚点页签", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("输入", "Excel 输入");
  await addNodeFromMenu("筛选排序", "筛选 Filter");
  fireEvent.click(nodeTitleEl("筛选").closest(".df-node") as HTMLElement);
  fireEvent.click(screen.getByRole("button", { name: /预览运行/ }));
  await screen.findByText(/预览模式 · 样本数据/, undefined, { timeout: 4000 });
  expect(screen.getByRole("tab", { name: "T 符合" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "F 不符合" })).toBeInTheDocument();
});

it("参数弹窗可新增参数并保存定义", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  fireEvent.click(screen.getByRole("button", { name: /^参数/ }));
  const dialog = await screen.findByRole("dialog", { name: "数据流参数" });
  expect(dialog).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /新增参数/ }));
  const nameInput = screen.getByLabelText("参数 1 名称");
  fireEvent.change(nameInput, { target: { value: "期间" } });
  fireEvent.change(screen.getByLabelText("参数 1 默认值"), { target: { value: "2026" } });
  fireEvent.click(screen.getByRole("button", { name: "保存参数定义" }));
  await waitFor(() =>
    expect(screen.getByText(/参数定义已保存/)).toBeInTheDocument(),
  );
});

it("存在草稿时提示恢复", async () => {
  saveDraft({
    version: 1,
    name: "草稿流程",
    params: [],
    nodes: [
      { id: "n1", type: "csv_in", name: "流水", x: 0, y: 0, config: { path: "" } },
    ],
    edges: [],
    notes: [],
  });
  render(<DataFlowPage tool={dataflowTool} />);
  const prompt = await screen.findByText(/检测到未保存的草稿/);
  expect(prompt).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "恢复草稿" }));
  await waitFor(() => expect(screen.getByText("流水")).toBeInTheDocument());
});
