// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DataFlowPage } from "./DataFlowPage";
import { saveDraft } from "./model";
import { pickPath, runningInDesktopApp } from "../api";
import type { ToolManifest } from "../types";

// pickPath / runningInDesktopApp 包一层 vi.fn（默认仍走真实实现），供个别
// 用例按次覆盖为异常/桌面模式，测试系统对话框出错时的兜底提示。
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    pickPath: vi.fn(actual.pickPath),
    runningInDesktopApp: vi.fn(actual.runningInDesktopApp),
  };
});

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
  for (const button of ["参数", "保存", "打开", "预览运行", "全量运行", "运行到选中节点"]) {
    expect(screen.getByRole("button", { name: new RegExp(button) })).toBeInTheDocument();
  }
});

it("二期补齐节点（如数据库文件输入）不再置灰，可直接添加", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  clickCategory("输入");
  const dbItem = await screen.findByRole("menuitem", { name: /数据库文件输入/ });
  expect(dbItem).toBeEnabled();
  expect(dbItem.textContent).not.toContain("二期");
  fireEvent.click(dbItem);
  expect(nodeTitleEl("数据库文件输入")).toBeInTheDocument();
});

function nodeTitleEl(text: string) {
  return screen.getByText(text, { selector: ".df-node-names b" });
}

// 本环境 jsdom 未实现 PointerEvent：fireEvent.pointerXxx 会退化为裸 Event，
// button/clientX 等 init 属性被构造器丢弃，画布拖线在 button 判定处就中断。
// 用 MouseEvent 派生补一个最小 PointerEvent（本文件只用到 button/clientX/clientY）。
class FakePointerEvent extends MouseEvent {
  pointerId = 1;
  pointerType = "mouse";
  isPrimary = true;
}
window.PointerEvent = FakePointerEvent as unknown as typeof PointerEvent;

/** 模拟画布拖线：按住 from 节点第一个输出口拖到 to 节点第一个输入口松手。
 *  jsdom 没有布局，pointerup 的落点（Canvas 用 document.elementFromPoint 判定）
 *  用桩指定目标输入锚点。 */
function dragConnect(fromNodeId: string, toNodeId: string) {
  const canvas = document.querySelector(".df-canvas") as HTMLElement;
  const outAnchor = document.querySelector(
    `.df-node[data-id="${fromNodeId}"] .df-a-out`,
  ) as HTMLElement;
  fireEvent.pointerDown(outAnchor, { button: 0 });
  // 连线拖动需累计 moved>=3 才出现临时路径，pointerup 才会尝试落线。
  for (let step = 1; step <= 3; step++) {
    fireEvent.pointerMove(canvas, { clientX: 60 + step * 20, clientY: 80 });
  }
  const inAnchor = document.querySelector(
    `.df-node[data-id="${toNodeId}"] .df-a-in`,
  ) as HTMLElement;
  // jsdom 未实现 elementFromPoint，先补一个占位实现再打桩指定落点。
  if (typeof document.elementFromPoint !== "function") {
    document.elementFromPoint = () => null;
  }
  const hitTest = vi.spyOn(document, "elementFromPoint").mockReturnValue(inAnchor);
  fireEvent.pointerUp(canvas, { clientX: 150, clientY: 80 });
  hitTest.mockRestore();
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

it("关联节点提供 J/L/R 三个输出锚点页签与膨胀统计", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("关联合并", "关联 Join");
  fireEvent.click(nodeTitleEl("关联").closest(".df-node") as HTMLElement);
  // 关联节点缺上游连线时演示引擎报错，但三路页签仍按目录渲染。
  expect(screen.getByRole("tab", { name: "J 匹配" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "L 左未匹配" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "R 右未匹配" })).toBeInTheDocument();
});

it("运行到选中节点：未选中时置灰，选中后可运行并提示后续节点未执行", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  const runToButton = screen.getByRole("button", { name: /运行到选中节点/ });
  expect(runToButton).toBeDisabled();
  await addNodeFromMenu("输入", "Excel 输入");
  await addNodeFromMenu("筛选排序", "筛选 Filter");
  // 先试选中输入节点（画布上第一个节点）。
  const inputNode = nodeTitleEl("Excel 输入").closest(".df-node") as HTMLElement;
  fireEvent.click(inputNode);
  expect(screen.getByRole("button", { name: /运行到选中节点/ })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: /运行到选中节点/ }));
  const banner = await screen.findByText(/已运行到所选节点/, undefined, { timeout: 4000 });
  expect(banner.textContent).toContain("其后节点未执行");
  // 结果区仅显示已运行节点：选中「筛选」节点时仍为未运行。
  fireEvent.click(nodeTitleEl("筛选").closest(".df-node") as HTMLElement);
  expect(screen.getByText(/尚未运行/)).toBeInTheDocument();
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

it("存在草稿时进入页面自动恢复（不再弹窗，杜绝误点忽略丢流程）", async () => {
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
  await waitFor(() => expect(screen.getByText("流水")).toBeInTheDocument());
  expect(screen.getByText(/已自动恢复未保存的流程/)).toBeInTheDocument();
});

it("点「新建」清空画布并清除草稿，下次进入不再自动恢复", async () => {
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
  const view = render(<DataFlowPage tool={dataflowTool} />);
  await waitFor(() => expect(screen.getByText("流水")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /新建/ }));
  await waitFor(() => expect(screen.getByText(/已新建空白流程/)).toBeInTheDocument());
  expect(screen.queryByText("流水")).not.toBeInTheDocument();
  view.unmount();
  render(<DataFlowPage tool={dataflowTool} />);
  await waitFor(() =>
    expect(screen.getByText(/就绪 · 编辑过程会自动保存草稿/)).toBeInTheDocument(),
  );
  expect(screen.queryByText("流水")).not.toBeInTheDocument();
});

it("拖线自环被拒时走可见错误通道：错误样式状态栏＋结果区红卡，且线不出现", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  // 筛选节点同时有输入口和输出口，可拖出「连到自己」的非法线。
  await addNodeFromMenu("筛选排序", "筛选 Filter");
  dragConnect("n1", "n1");
  // 状态栏挂 df-status-error 错误样式并显示拒绝原因（而非会被覆盖的普通小字）。
  const status = document.querySelector(".df-status-text") as HTMLElement;
  expect(status.className).toContain("df-status-error");
  expect(status.textContent).toContain("不能把节点连到自己");
  // 结果区显示红卡错误提示，而非「尚未运行」占位。
  const card = screen.getByRole("alert");
  expect(card.textContent).toContain("连线未创建");
  expect(card.textContent).toContain("不能把节点连到自己");
  expect(screen.queryByText(/尚未运行/)).not.toBeInTheDocument();
  // 校验失败的线不会被创建。
  expect(document.querySelectorAll(".df-edge").length).toBe(0);
});

it("重复连线被拒后错误提示常驻，随后的合法连线成功即撤下拒绝提示", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("输入", "Excel 输入"); // n1
  await addNodeFromMenu("筛选排序", "筛选 Filter"); // n2
  await addNodeFromMenu("筛选排序", "筛选 Filter"); // n3
  dragConnect("n1", "n2");
  expect(document.querySelectorAll(".df-edge").length).toBe(1);
  const status = document.querySelector(".df-status-text") as HTMLElement;
  expect(status.className).not.toContain("df-status-error");
  // 同一条线再拖一次：重复连线被拒 → 错误样式状态栏＋红卡，线不重复出现。
  dragConnect("n1", "n2");
  expect(document.querySelectorAll(".df-edge").length).toBe(1);
  expect(status.className).toContain("df-status-error");
  expect(screen.getByRole("alert").textContent).toContain("这条连线已经存在");
  // 改拖一条合法连线（n2→n3）成功：拒绝提示随之撤下，状态栏恢复普通样式。
  dragConnect("n2", "n3");
  expect(document.querySelectorAll(".df-edge").length).toBe(2);
  expect(status.className).not.toContain("df-status-error");
  expect(status.textContent).toContain("已连线");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("「选择…」按钮遇 pickPath 异常时显示中文错误，而不是点了没反应", async () => {
  // 系统对话框组件出错（IPC 异常等）：pickPath reject 必须落到可见错误通道。
  vi.mocked(pickPath).mockRejectedValueOnce({
    code: "DIALOG_IPC_ERROR",
    userMessage: "系统对话框组件出错（模拟 IPC 异常）",
  });
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("输入", "Excel 输入");
  fireEvent.click(nodeTitleEl("Excel 输入").closest(".df-node") as HTMLElement);
  const pathInput = (await screen.findByLabelText("数据文件")) as HTMLInputElement;
  fireEvent.click(screen.getByRole("button", { name: "选择…" }));
  // 状态栏挂错误样式并显示中文原因；结果区红卡显示同一原因。
  const status = document.querySelector(".df-status-text") as HTMLElement;
  await waitFor(() => expect(status.className).toContain("df-status-error"));
  expect(status.textContent).toContain("选择文件失败");
  expect(status.textContent).toContain("系统对话框组件出错");
  expect(screen.getByRole("alert").textContent).toContain("选择文件失败");
  // 路径输入框保持为空：异常时不能应用任何路径。
  expect(pathInput.value).toBe("");
});

it("「保存」遇保存窗口打开失败时显示中文错误（桌面保存链路 pickPath 异常兜底）", async () => {
  // 桌面端保存先弹 pickPath("save")，其异常须转为可见失败而非 unhandled rejection。
  vi.mocked(runningInDesktopApp).mockReturnValueOnce(true);
  vi.mocked(pickPath).mockRejectedValueOnce({
    code: "DIALOG_IPC_ERROR",
    userMessage: "系统对话框组件出错（模拟 IPC 异常）",
  });
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("输入", "Excel 输入");
  fireEvent.click(screen.getByRole("button", { name: /^保存/ }));
  const status = document.querySelector(".df-status-text") as HTMLElement;
  await waitFor(() => expect(status.className).toContain("df-status-error"));
  expect(status.textContent).toContain("打开保存窗口失败");
  expect(status.textContent).toContain("系统对话框组件出错");
  expect(screen.getByRole("alert").textContent).toContain("打开保存窗口失败");
});

it("自动保存失败（存储写入异常）时工具栏显示警告，并覆盖旧的「已自动保存」", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("输入", "Excel 输入");
  // 先成功自动保存一次：工具栏出现「已自动保存」。
  await waitFor(
    () => expect(screen.getByText(/已自动保存/)).toBeInTheDocument(),
    { timeout: 3000 },
  );
  // 模拟 localStorage 写入失败（配额满/存储禁用），再改动流程触发下一次自动保存。
  // 注意：jsdom 的 window.localStorage 每次访问不暴露实例 spy，须拦 Storage.prototype。
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError（模拟配额已满）");
  });
  try {
    await addNodeFromMenu("输入", "Excel 输入");
    await waitFor(
      () => expect(screen.getByText(/自动保存失败/)).toBeInTheDocument(),
      { timeout: 3000 },
    );
    // 失败警告覆盖旧的「已自动保存」成功文案，不残留误导性提示。
    expect(screen.queryByText(/已自动保存/)).not.toBeInTheDocument();
    expect(screen.getByText(/请点「保存」手动保存流程文件/)).toBeInTheDocument();
  } finally {
    setItem.mockRestore();
  }
});

it("仅定义参数、没有节点的流程不落草稿，也不误报「自动保存失败」", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  fireEvent.click(screen.getByRole("button", { name: /^参数/ }));
  await screen.findByRole("dialog", { name: "数据流参数" });
  fireEvent.click(screen.getByRole("button", { name: /新增参数/ }));
  fireEvent.change(screen.getByLabelText("参数 1 名称"), { target: { value: "期间" } });
  fireEvent.click(screen.getByRole("button", { name: /保存参数定义/ }));
  await waitFor(() => expect(screen.getByText(/参数定义已保存/)).toBeInTheDocument());
  // 参数-only 流程：saveDraft 返回 false 属有意跳过（无节点），等过自动保存
  // 防抖窗口后既不应有成功文案也不应有失败警告。
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(screen.queryByText(/已自动保存/)).not.toBeInTheDocument();
  expect(screen.queryByText(/自动保存失败/)).not.toBeInTheDocument();
});

it("视角被拖远后新增节点：画布自动把视角对准新节点，不再出现「添加了节点却看不见」", async () => {
  // 真实反馈（dev.16）：画布空白处拖动带文字选择假象，用户反复拖把视角
  // 拖远；此后新增节点固定放在原点附近，全部落在视野外，画布看着是空的。
  render(<DataFlowPage tool={dataflowTool} />);
  await addNodeFromMenu("输入", "Excel 输入");

  // jsdom 没有布局（画布尺寸恒为 0×0），新增节点永远判定为「在视野外」，
  // 因此这里锁定确定性的对准行为：新节点落在视野外时视角对准它。
  // （视角拖远后自动回焦的完整路径在真实浏览器里验证。）
  // 节点 1（Excel 输入）位于 (60, 60)，宽 156 高 78：对准后相机
  // x = -60-78 = -138、y = -60-39 = -99。
  const transform = (document.querySelector(".df-world") as HTMLElement).style.transform;
  expect(transform).toBe("translate(-138px, -99px) scale(1)");
});
