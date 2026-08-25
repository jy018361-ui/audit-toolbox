// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FuzzyMatchPage } from "./FuzzyMatchPage";
import type { JobEvent, ToolManifest } from "./types";

// listenJobEvents 的回调存在模块级数组里，测试用 act 手动派发任务事件。
const hooks = vi.hoisted(() => ({ listeners: [] as Array<(event: JobEvent) => void> }));

vi.mock("./api", () => ({
  engineCall: vi.fn(),
  jobCancel: vi.fn(),
  jobStart: vi.fn(async () => "job-1"),
  listenJobEvents: vi.fn(async (cb: (event: JobEvent) => void) => {
    hooks.listeners.push(cb);
    return () => undefined;
  }),
  openOutput: vi.fn(),
  pickPath: vi.fn(async () => null),
}));

const tool: ToolManifest = {
  id: "fuzzy_match",
  name: "两列模糊匹配",
  description: "",
  route: "/tools/fuzzy_match",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};

const inspection = {
  headers: ["公司名称", "备注"],
  preview: [["北京甲有限公司", "x"]],
  rowCount: 3,
  sheet: "Sheet1",
  sheets: ["Sheet1"],
};

/** completed 事件样例：自动 2 / 疑似 1 / 未匹配 1，疑似行带两个候选。 */
const doneEvent = (result: unknown): JobEvent => ({
  jobId: "job-1",
  toolId: "fuzzy_match",
  phase: "completed",
  current: 1,
  total: 1,
  message: "匹配完成",
  severity: "success",
  outputPaths: [],
  result,
} as JobEvent);

const matchResult = {
  summary: { rowsA: 3, rowsB: 3, autoCount: 2, suspectCount: 1, unmatchedCount: 1, invalidCount: 0, elapsedMs: 800 },
  rows: [
    {
      aIndex: 0,
      aValue: "北京甲有限公司",
      matches: [{
        bIndex: 0, bValue: "北京甲有限公司", level: "auto", total: 96,
        breakdown: { charSim: 1, lcsSim: 1, tokenOverlap: 1 }, reasons: ["清洗后完全一致"],
      }],
    },
    {
      aIndex: 1,
      aValue: "上海乙股份",
      matches: [
        {
          bIndex: 2, bValue: "上海乙股份有限公司", level: "suspect", total: 78,
          breakdown: { charSim: 0.78, lcsSim: 0.8, tokenOverlap: 0.7 }, reasons: ["疑似简称差异"],
        },
        {
          bIndex: 3, bValue: "上海乙集团有限公司", level: "suspect", total: 72,
          breakdown: { charSim: 0.72, lcsSim: 0.74, tokenOverlap: 0.6 }, reasons: ["疑似简称差异", "组织形式不同"],
        },
      ],
    },
    { aIndex: 2, aValue: "深圳丙", matches: [] },
  ],
};

/** 选好 A、B 两个来源并各选一列匹配列，返回开始按钮。 */
async function setupBothSources() {
  const { engineCall, pickPath } = await import("./api");
  vi.mocked(engineCall).mockImplementation(async (method: string) => {
    if (method === "fuzzy.inspect") return inspection;
    if (method === "fuzzy.get_results") throw new Error("该任务无本地结果");
    return { saved: true };
  });
  vi.mocked(pickPath).mockImplementation(async (_kind: unknown, title: string) =>
    String(title).includes("来源 A") ? "C:/tmp/a.xlsx" : "C:/tmp/b.xlsx",
  );
  render(<FuzzyMatchPage tool={tool} />);
  fireEvent.click(screen.getByRole("button", { name: "选择来源 A 文件" }));
  fireEvent.click(screen.getByRole("button", { name: "选择来源 B 文件" }));
  await waitFor(() => expect(screen.getByText("来源 A匹配列")).toBeInTheDocument());
  // 两份预览各把第一列表头选成「匹配列」：A、B 卡各渲染 2 个表头下拉。
  const selects = document.querySelectorAll(".dt-header-control select");
  expect(selects.length).toBe(4);
  fireEvent.change(selects[0], { target: { value: "column" } });
  fireEvent.change(selects[2], { target: { value: "column" } });
  return screen.getByRole("button", { name: "开始匹配" });
}

function emitJob(event: JobEvent) {
  act(() => {
    hooks.listeners.forEach((cb) => cb(event));
  });
}

describe("FuzzyMatchPage", () => {
  beforeEach(() => {
    hooks.listeners.length = 0;
  });
  afterEach(() => {
    // vitest 未开全局 cleanup，不手动卸载的话上一条用例的 DOM 会留到下一条。
    cleanup();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("未选齐来源 A/B 时开始按钮禁用", () => {
    render(<FuzzyMatchPage tool={tool} />);
    expect(screen.getByRole("button", { name: "开始匹配" })).toBeDisabled();
  });

  it("数据类型切换后说明文案随之变化", async () => {
    const { engineCall } = await import("./api");
    vi.mocked(engineCall).mockResolvedValue({ saved: true });
    render(<FuzzyMatchPage tool={tool} />);
    expect(screen.getByText(/清洗括号简称/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("数据类型"), { target: { value: "person" } });
    expect(screen.getByText(/忽略姓名中的空格/)).toBeInTheDocument();
    expect(screen.queryByText(/清洗括号简称/)).not.toBeInTheDocument();
  });

  it("completed 事件后渲染总览四个指标与明细", async () => {
    const start = await setupBothSources();
    expect(start).toBeEnabled();
    fireEvent.click(start);
    const { jobStart } = await import("./api");
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith(
      "fuzzy.match",
      expect.objectContaining({ matchType: "company", autoThreshold: 90, suspectThreshold: 70, topK: 3 }),
    ));
    emitJob(doneEvent(matchResult));
    // 总览数字来自 summary：自动 2 / 疑似 1 / 未匹配 1（含 0 的无效值）。
    const pillValue = (label: string) => {
      const cell = screen.getAllByText(label).find((el) => el.closest(".fuzzy-pill"));
      return cell?.closest("button")?.textContent ?? "";
    };
    expect(pillValue("自动匹配")).toMatch(/2/);
    expect(pillValue("疑似待确认")).toMatch(/1/);
    expect(pillValue("未匹配")).toMatch(/1/);
    expect(pillValue("无效值")).toMatch(/0/);
    // 明细表三行都在：A 原文、最高分候选原文与理由。
    expect(screen.getAllByText("北京甲有限公司").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("清洗后完全一致")).toBeInTheDocument();
  });

  it("疑似确认卡：点候选后置灰、进度 +1、实时保存确认", async () => {
    const start = await setupBothSources();
    fireEvent.click(start);
    // 等 jobStart 的 promise 落定、activeJob 赋值后再派发事件，否则事件会被过滤。
    await waitFor(() => expect(sessionStorage.getItem("fuzzy-match-draft.v1")).toContain("job-1"));
    emitJob(doneEvent(matchResult));
    // 确认卡：A 原文 + 两个候选 + 拒绝按钮。
    const cardA = screen.getAllByText("上海乙股份").find((el) => el.closest(".fuzzy-confirm-card"));
    expect(cardA).toBeTruthy();
    const card = cardA!.closest(".fuzzy-confirm-card")!;
    expect(screen.getByRole("button", { name: /都不是（拒绝匹配）/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /上海乙股份有限公司/ }));
    expect(card).toHaveClass("done");
    expect(screen.getByText(/已确认/).textContent).toMatch("已确认 1 / 总数 1");
    const { engineCall } = await import("./api");
    await waitFor(() => expect(engineCall).toHaveBeenCalledWith("fuzzy.save_confirm", {
      jobId: "job-1",
      confirmations: [{ aIndex: 1, bIndex: 2, action: "accept" }],
    }));
    // 确认草稿落 sessionStorage，重挂载后可接续。
    expect(sessionStorage.getItem("fuzzy-match-draft.v1")).toContain('"aIndex":1');
  });
});
