// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DepositInterestPage } from "./DepositInterestPage";
import type { JobEvent, ToolManifest } from "./types";

const mock = vi.hoisted(() => ({
  engineCall: vi.fn(),
  jobStart: vi.fn(),
  pickPath: vi.fn(),
  event: undefined as undefined | ((event: JobEvent) => void),
}));
vi.mock("./api", () => ({
  engineCall: mock.engineCall,
  jobStart: mock.jobStart,
  pickPath: mock.pickPath,
  jobCancel: vi.fn(),
  openOutput: vi.fn(),
  openReferenceUrl: vi.fn(),
  listenJobEvents: vi.fn(async (handler) => {
    mock.event = handler;
    return () => undefined;
  }),
  listenPositionedFileDrops: vi.fn().mockResolvedValue(() => undefined),
}));
const tool: ToolManifest = {
  id: "deposit_interest",
  name: "存款利息收入测算",
  description: "",
  route: "/tools/deposit_interest",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};
const parent = "6603 财务费用",
  leaf = "66030101 财务费用-其他",
  bank = "1002 银行存款";
const mapping = {
  accountCode: "科目编码",
  accountName: "科目名称",
  openingFunctionalAmount: "期初余额",
  closingFunctionalAmount: "期末余额",
};
const complete: JobEvent = {
  jobId: "deposit-job",
  toolId: "deposit_interest",
  phase: "completed",
  current: 1,
  total: 1,
  message: "完成",
  severity: "success",
  outputPaths: [],
  result: { rows: [] },
};
const inspection = {
  headers: Object.values(mapping),
  sheet: "TB",
  sheets: ["TB"],
  headerRow: 1,
  headerDepth: 1,
  rowCount: 3,
  preview: [
    ["1002", "银行存款", "100", "100"],
    ["6603", "财务费用", "0", "0"],
    ["66030101", "财务费用-其他", "0", "0"],
  ],
  entities: [],
  accounts: [bank, parent, leaf],
  suggestedMapping: mapping,
  suggestedAccountRoles: {
    [bank]: "deposit",
    [parent]: "excluded",
    [leaf]: "excluded",
  },
  mappingCandidates: [],
  headerDetection: { needsConfirmation: false, candidates: [] },
  dataYears: [2025],
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.pickPath.mockResolvedValue("fixture-tb.xlsx");
  mock.jobStart.mockResolvedValue("deposit-job");
  mock.engineCall.mockImplementation(async (method: string) => {
    if (method === "deposit.rate_tiers") return undefined;
    if (method === "deposit.classify_source")
      return { kind: "tb", sheet: "TB", headerRow: 1, headerDepth: 1 };
    if (method === "deposit.inspect_tb") return inspection;
    throw new Error(`unexpected ${method}`);
  });
});
afterEach(cleanup);

describe("存款科目手工分类请求", () => {
  it("真实页面区分默认excluded和手工排除，并支持撤销手工选择", async () => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "拖放或选择 TB、序时账文件（可同时选择）",
      }),
    );
    const parentInput = await screen.findByRole("combobox", {
      name: `${parent}的分类`,
    });
    const leafInput = screen.getByRole("combobox", { name: `${leaf}的分类` });
    expect(leafInput).toHaveValue("");
    fireEvent.change(parentInput, { target: { value: "interest_income" } });
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    expect(mock.jobStart.mock.calls[0][1]).toMatchObject({
      accountRoles: { [parent]: "interest_income", [leaf]: "excluded" },
      accountRoleOverrides: { [parent]: "interest_income" },
    });
    expect(
      mock.jobStart.mock.calls[0][1].accountRoleOverrides,
    ).not.toHaveProperty(leaf);
    act(() => mock.event?.(complete));
    fireEvent.change(leafInput, { target: { value: "excluded" } });
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledTimes(2));
    expect(mock.jobStart.mock.calls[1][1].accountRoleOverrides).toEqual({
      [parent]: "interest_income",
      [leaf]: "excluded",
    });
    act(() => mock.event?.(complete));
    fireEvent.change(leafInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledTimes(3));
    expect(mock.jobStart.mock.calls[2][1].accountRoleOverrides).toEqual({
      [parent]: "interest_income",
    });
  });
});
