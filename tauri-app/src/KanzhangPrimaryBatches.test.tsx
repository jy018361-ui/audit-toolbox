// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanzhangParityPage } from "./KanzhangParityPage";
import { engineCall } from "./api";
import type { ToolManifest } from "./types";

vi.mock("./api", () => ({
  engineCall: vi.fn(), jobCancel: vi.fn(), jobStart: vi.fn(),
  listenJobEvents: vi.fn().mockResolvedValue(() => undefined),
  openOutput: vi.fn(), pickPath: vi.fn(),
}));

const tool: ToolManifest = {
  id: "kanzhang", name: "看账工具", description: "", route: "/tools/kanzhang",
  version: "test", capabilities: [], migrationStatus: "ready",
};
const cache = "audit-toolbox.kanzhang.draft.v4";
const source = {
  values: ["16010101-机器", "16010201-车辆", "16010102-设备"],
  codes: ["16010101", "16010201", "16010102"],
  primaryNames: ["机器", "车辆", "设备"], total: 3,
};

function seed(accountCode = "科目编码") {
  sessionStorage.setItem(cache, JSON.stringify({
    inputPath: "C:/test/je.xlsx", step: 2,
    mapping: { id: ["凭证号"], date: "日期", accountCode, accountName: ["科目名称"], functionalAmount: "金额" },
    inspect: { accounts: source.values, accountCodes: source.codes, accountCount: 3, headers: [], preview: [] },
    batches: [{ name: "人工", accounts: ["自选"] }],
  }));
}

async function openDialog() {
  const button = screen.getByRole("button", { name: "生成全科目批次（不含货币资金）" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  return screen.getByRole("dialog");
}

describe("看账按编码位数生成批次", () => {
  beforeEach(() => {
    vi.mocked(engineCall).mockResolvedValue(source);
    seed();
  });
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.clearAllMocks(); });

  it("先选择位数，取消不生成，确认后以所选位数分组并记住设置", async () => {
    render(<KanzhangParityPage tool={tool}/>);
    let dialog = await openDialog();
    expect(within(dialog).getByRole("spinbutton")).toHaveValue(4);
    const calls = vi.mocked(engineCall).mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(engineCall).toHaveBeenCalledTimes(calls);
    dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "6" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "生成批次" }));
    await screen.findByText(/已生成 2 个全科目批次：按编码前 6 位 2 个，按名称首段 0 个/);
    expect(screen.getByRole("button", { name: "全科目｜160101 机器 (2)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "人工 (1)" })).toBeInTheDocument();
    expect(engineCall).toHaveBeenLastCalledWith("kanzhang.accounts", expect.objectContaining({ all: true }));
    dialog = await openDialog();
    expect(within(dialog).getByRole("spinbutton")).toHaveValue(6);
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "0" } });
    expect(within(dialog).getByRole("button", { name: "生成批次" })).toBeDisabled();
  });

  it("未映射编码列时允许按名称首段生成", async () => {
    seed("");
    vi.mocked(engineCall).mockResolvedValue({ values: ["固定资产/机器", "固定资产-车辆"], codes: [], total: 2 });
    render(<KanzhangParityPage tool={tool}/>);
    const dialog = await openDialog();
    expect(within(dialog).getByText("未映射科目编码列，将按名称首段分组。")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "生成批次" }));
    await screen.findByText(/按名称首段 1 个/);
    expect(screen.getByRole("button", { name: "全科目｜名称 固定资产 (2)" })).toBeInTheDocument();
  });

  it("部分编码不足时报告跳过数量，全部不足时保留原有批次", async () => {
    vi.mocked(engineCall).mockResolvedValue({ ...source, codes: ["16", "16010201", "1"] });
    render(<KanzhangParityPage tool={tool}/>);
    let dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "生成批次" }));
    await screen.findByText(/跳过编码不足 4 位的科目 2 个/);
    vi.mocked(engineCall).mockResolvedValue({ ...source, codes: ["1", "2", "3"] });
    dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "生成批次" }));
    await screen.findByText(/没有可分组的科目/);
    expect(screen.getByRole("button", { name: "全科目｜1601 车辆 (1)" })).toBeInTheDocument();
  });
});
