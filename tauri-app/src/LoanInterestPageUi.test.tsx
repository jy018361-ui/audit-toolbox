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

it("按资料模式显示空态和可访问的选中状态", () => {
  render(<LoanInterestPage tool={tool} />);
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

/** TB＋JE 的利率确认：文件上传已改为粘贴匹配；映射没补齐时明说卡在哪。 */
it("利率确认改为粘贴匹配，TB 缺借款明细时明说缺口并拦下一步", async () => {
  const tbHeaders = ["科目编码", "科目名称", "借款明细", "期初余额", "期末余额"];
  const jeHeaders = ["记账日期", "凭证号", "科目编码", "科目名称", "摘要", "贷方金额"];
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
    // TB 故意只建议科目两列：借款明细与金额都缺，用来验证提示与拦门。
    suggestedMapping:
      kind === "tb"
        ? { accountCode: "科目编码", accountName: "科目名称" }
        : {
            date: "记账日期",
            id: "凭证号",
            accountCode: "科目编码",
            accountName: "科目名称",
            summary: "摘要",
          },
  });
  mock.pickPath.mockResolvedValue(["tb.xlsx", "je.xlsx"]);
  mock.engineCall.mockImplementation(async (method: string, params: unknown) => {
    const p = params as { kind?: string; source?: { inputPath?: string } };
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
  await screen.findByText("已识别：TB 科目余额表");
  await screen.findByText("已识别：JE 序时账");
  fireEvent.click(screen.getByRole("button", { name: "下一步：利率确认" }));
  // 文件上传入口已移除，改为粘贴区。
  expect(
    screen.getByRole("textbox", { name: "粘贴借款利率区域" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "选择借款利率台账文件" }),
  ).not.toBeInTheDocument();
  // TB 没映射借款明细：匹配按钮禁用并说明原因；下一步也明说缺什么。
  expect(screen.getByRole("button", { name: "解析并匹配利率" })).toBeDisabled();
  expect(
    screen.getByText(/TB 尚未映射「借款明细\/辅助核算」/),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "下一步：测算与底稿" }),
  ).toBeDisabled();
  expect(screen.getByText(/TB：借款明细\/辅助核算/)).toBeVisible();
  expect(screen.getByRole("button", { name: "返回补齐映射" })).toBeVisible();
});

/** 映射齐全时粘贴原文交引擎模糊匹配，逐笔结果入表、下一步放行。 */
it("粘贴利率匹配出逐笔结果并可进入测算", async () => {
  const tbHeaders = ["科目编码", "科目名称", "借款明细", "期初余额", "期末余额"];
  const jeHeaders = ["记账日期", "凭证号", "科目编码", "科目名称", "摘要", "贷方金额"];
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
        ? {
            accountCode: "科目编码",
            accountName: "科目名称",
            loanId: "借款明细",
            openingFunctionalAmount: "期初余额",
            closingFunctionalAmount: "期末余额",
          }
        : {
            date: "记账日期",
            id: "凭证号",
            accountCode: "科目编码",
            accountName: "科目名称",
            summary: "摘要",
          },
  });
  const paste = "合同名称\t执行利率\n工行短期借款\t3.85%";
  mock.pickPath.mockResolvedValue(["tb.xlsx", "je.xlsx"]);
  mock.engineCall.mockImplementation(async (method: string, params: unknown) => {
    const p = params as { kind?: string; source?: { inputPath?: string } };
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
    if (method === "loan.match_rates") {
      return {
        rows: [
          {
            loanId: "工行短期借款",
            rateType: "fixed",
            fixedRate: 0.0385,
            benchmarkRate: null,
            spreadBps: null,
            matchStatus: "精确匹配",
            matchBasis: "与粘贴行「工行短期借款」一致",
          },
        ],
        note: "已按表头识别列：名称=「合同名称」、利率=「执行利率」，共1行数据、1笔借款（精确1笔、模糊0笔）。",
      };
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
  await screen.findByText("已识别：TB 科目余额表");
  await screen.findByText("已识别：JE 序时账");
  fireEvent.click(screen.getByRole("button", { name: "下一步：利率确认" }));
  fireEvent.change(screen.getByRole("textbox", { name: "粘贴借款利率区域" }), {
    target: { value: paste },
  });
  fireEvent.click(screen.getByRole("button", { name: "解析并匹配利率" }));
  expect(await screen.findByText("借款利率匹配结果")).toBeVisible();
  expect(await screen.findByText("工行短期借款")).toBeVisible();
  // 匹配请求带上粘贴原文与 TB 来源；映射齐全后下一步放行。
  await waitFor(() =>
    expect(mock.engineCall).toHaveBeenCalledWith(
      "loan.match_rates",
      expect.objectContaining({ rateText: paste }),
    ),
  );
  expect(
    screen.getByRole("button", { name: "下一步：测算与底稿" }),
  ).toBeEnabled();
});
