// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoanInterestPage } from "./LoanInterestPage";
import type { ToolManifest } from "./types";

const mock = vi.hoisted(() => ({
  engineCall: vi.fn(),
  pickPath: vi.fn(),
}));
vi.mock("./api", () => ({
  engineCall: mock.engineCall,
  jobCancel: vi.fn(),
  jobStart: vi.fn(),
  listenJobEvents: vi.fn(async () => () => undefined),
  listenPositionedFileDrops: vi.fn(async () => () => undefined),
  openOutput: vi.fn(),
  pickPath: mock.pickPath,
}));
afterEach(cleanup);
const tool: ToolManifest = {
  id: "loan_interest",
  name: "借款利息测算",
  description: "",
  route: "/tools/loan_interest",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};

beforeEach(() => {
  vi.clearAllMocks();
  mock.pickPath.mockResolvedValue(null);
  mock.engineCall.mockImplementation(async (method: string) => {
    if (method === "ledger.forms") return [];
    throw new Error(`unexpected ${method}`);
  });
});

it("按资料模式显示空态、联网边界和可访问的选中状态", () => {
  render(<LoanInterestPage tool={tool} />);
  expect(
    screen.getByRole("complementary", { name: "测算默认在本机完成" }),
  ).toHaveAttribute("data-mode", "network-assisted");
  expect(
    screen.getByRole("region", { name: "准备完整借款台账" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "完整借款台账" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "TB＋JE" }));
  expect(screen.getByRole("button", { name: "TB＋JE" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("region", { name: "准备 TB 与 JE" })).toBeVisible();
  expect(screen.getByText(/TB 与 JE 均需上传/)).toBeVisible();
  // TB＋JE 与其他账表工具一致：一个统一上传入口，不再分 TB/JE 两个上传框。
  expect(
    screen.getByRole("button", {
      name: "拖放或选择 TB、序时账文件（可同时选择）",
    }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "一次选择 TB 与 JE（自动识别 Sheet）" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "下一步：利率确认" }),
  ).toBeDisabled();
});

/** TB＋JE 统一上传：公共分类器先定 TB/JE，来源卡上一键更正类型时按
 *  correctLedgerSourceKinds 的编排对调并全部按新类型重新识别。 */
it("统一上传自动分类出 TB 与 JE 来源卡，并可一键更正类型", async () => {
  const tbHeaders = ["科目编码", "科目名称", "期初余额", "期末余额"];
  const jeHeaders = ["记账日期", "凭证号", "科目编码", "贷方金额"];
  const classify = (kind: "tb" | "je", sheet: string, headers: string[]) => ({
    kind,
    scores: { je: kind === "je" ? 10 : 1, tb: kind === "tb" ? 10 : 1 },
    sheet,
    headerRow: 1,
    headerDepth: 1,
    headers,
    preview: [headers.map(() => "x")],
  });
  const inspect = (kind: "tb" | "je", sheet: string, headers: string[]) => ({
    headers,
    preview: [headers.map(() => "x")],
    rowCount: 2,
    sheet,
    sheets: [sheet],
    headerRow: 1,
    headerDepth: 1,
    suggestedMapping:
      kind === "tb"
        ? { accountCode: "科目编码", accountName: "科目名称" }
        : { date: "记账日期", accountCode: "科目编码" },
  });
  mock.pickPath.mockResolvedValue(["tb.xlsx", "je.xlsx"]);
  mock.engineCall.mockImplementation(async (method: string, params: unknown) => {
    const p = params as {
      kind?: string;
      source?: { inputPath?: string };
    };
    if (method === "ledger.forms") return [];
    if (method === "deposit.classify_source") {
      return p.source?.inputPath?.endsWith("je.xlsx")
        ? classify("je", "序时账", jeHeaders)
        : classify("tb", "余额表", tbHeaders);
    }
    if (method === "loan.inspect") {
      return p.kind === "je"
        ? inspect("je", "序时账", jeHeaders)
        : inspect("tb", "余额表", tbHeaders);
    }
    throw new Error(`unexpected ${method}`);
  });
  render(<LoanInterestPage tool={tool} />);
  fireEvent.click(screen.getByRole("button", { name: "TB＋JE" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "拖放或选择 TB、序时账文件（可同时选择）",
    }),
  );
  expect(
    await screen.findByText("已识别：TB 科目余额表"),
  ).toBeVisible();
  expect(await screen.findByText("已识别：JE 序时账")).toBeVisible();
  // 分类结论里的 Sheet 原样传给正式识别，标题行/层数交给引擎重判。
  await waitFor(() =>
    expect(mock.engineCall).toHaveBeenCalledWith("loan.inspect", {
      kind: "tb",
      source: {
        inputPath: "tb.xlsx",
        sheet: "余额表",
        headerRow: 0,
        headerDepth: 0,
      },
    }),
  );
  // 一键更正：TB 侧改判为 JE；目标槽已有 JE 时整体交换并按新类型重识别两侧。
  fireEvent.click(screen.getByRole("button", { name: "更正为 JE" }));
  await waitFor(() =>
    expect(mock.engineCall).toHaveBeenCalledWith("loan.inspect", {
      kind: "je",
      source: {
        inputPath: "tb.xlsx",
        sheet: "余额表",
        headerRow: 0,
        headerDepth: 0,
      },
    }),
  );
  await waitFor(() =>
    expect(mock.engineCall).toHaveBeenCalledWith("loan.inspect", {
      kind: "tb",
      source: {
        inputPath: "je.xlsx",
        sheet: "序时账",
        headerRow: 0,
        headerDepth: 0,
      },
    }),
  );
  expect(
    await screen.findByText("TB 与 JE 来源已交换，并按新类型重新识别。"),
  ).toBeVisible();
});
