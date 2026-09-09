// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoanInterestPage } from "./LoanInterestPage";
import type { ToolManifest } from "./types";

const mock = vi.hoisted(() => ({
  engineCall: vi.fn(),
  pickPath: vi.fn(),
  jobStart: vi.fn(),
  jobEvents: { callback: undefined as undefined | ((event: unknown) => void) },
}));
vi.mock("./api", () => ({
  engineCall: mock.engineCall,
  jobCancel: vi.fn(),
  jobStart: mock.jobStart,
  listenJobEvents: vi.fn(async (callback: unknown) => {
    mock.jobEvents.callback = callback as (event: unknown) => void;
    return () => undefined;
  }),
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
  // TB＋JE 模式下第二步更名为「确认科目与利率」。
  expect(
    screen.getByRole("button", { name: "下一步：确认科目与利率" }),
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

/** TB＋JE 第二步为「确认科目与利率」：科目清单预选借款科目；借款明细不再拦路。 */
it("确认科目与利率：预选借款科目，缺映射仍拦下一步但不提借款明细", async () => {
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
    // TB 故意只建议科目两列：金额缺，用来验证提示与拦门。
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
    if (method === "loan.tb_accounts") {
      return {
        accounts: [
          { key: "2001", code: "2001", name: "短期借款", account: "2001 短期借款", opening: 1000, closing: 900 },
          { key: "1122", code: "1122", name: "应收账款", account: "1122 应收账款", opening: 5, closing: 6 },
        ],
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
  fireEvent.click(screen.getByRole("button", { name: /下一步：确认科目与利率/ }));
  // 科目清单渲染，借款科目按名称预选，应收账款默认排除。
  expect(await screen.findByText("确认借款科目")).toBeVisible();
  const loanSelect = screen.getByRole("combobox", { name: "2001 短期借款的科目类型" });
  expect((loanSelect as HTMLSelectElement).value).toBe("loan");
  const skipSelect = screen.getByRole("combobox", { name: "1122 应收账款的科目类型" });
  expect((skipSelect as HTMLSelectElement).value).toBe("skip");
  // 金额映射没补齐：下一步仍拦，但不再出现「借款明细/辅助核算」的旧提示。
  expect(
    screen.getByRole("button", { name: "下一步：测算与底稿" }),
  ).toBeDisabled();
  expect(
    screen.queryByText(/尚未映射「借款明细\/辅助核算」/),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "生成借款利率表" })).toBeDisabled();
});

/** 映射齐全时生成借款利率表，手填年利率后下一步放行、测算带确认清单与利率。 */
it("生成借款利率表并手填利率后可进入测算", async () => {
  const tbHeaders = ["科目编码", "科目名称", "期初余额", "期末余额"];
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
  const fullMapping = {
    accountCode: "科目编码",
    accountName: "科目名称",
    openingFunctionalAmount: "期初余额",
    closingFunctionalAmount: "期末余额",
  };
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
        ? fullMapping
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
    if (method === "loan.tb_accounts") {
      return {
        accounts: [
          { key: "2001", code: "2001", name: "短期借款", account: "2001 短期借款", opening: 1000000, closing: 900000 },
        ],
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
  fireEvent.click(screen.getByRole("button", { name: /下一步：确认科目与利率/ }));
  expect(await screen.findByText("确认借款科目")).toBeVisible();
  mock.jobStart.mockResolvedValue("job-rates");
  fireEvent.change(screen.getByLabelText("资产负债表日"), {
    target: { value: "2025-12-31" },
  });
  const generate = await screen.findByRole("button", { name: "生成借款利率表" });
  await waitFor(() => expect(generate).toBeEnabled());
  fireEvent.click(generate);
  await waitFor(() => expect(mock.jobStart).toHaveBeenCalledWith(
    "loan.preview",
    expect.objectContaining({ loanAccounts: ["2001"] }),
  ));
  // preview 任务完成：借款行进入利率确认表。
  mock.jobEvents.callback?.({
    jobId: "job-rates",
    phase: "completed",
    result: {
      rows: [
        {
          loanId: "2001 短期借款",
          openingPrincipal: 1000000,
          closingPrincipal: 900000,
          matchStatus: "待复核",
          matchBasis: "匹配 2 条 JE（编码 2）",
        },
      ],
      summary: { loanCount: 1 },
    },
  });
  expect(await screen.findByText("借款利率确认表")).toBeVisible();
  // 手填固定执行利率 3.85。
  fireEvent.change(screen.getByRole("spinbutton", { name: "2001 短期借款的执行利率" }), {
    target: { value: "3.85" },
  });
  // 下一步放行。
  expect(
    screen.getByRole("button", { name: "下一步：测算与底稿" }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "下一步：测算与底稿" }));
  fireEvent.click(screen.getByRole("button", { name: "生成 Excel 底稿" }));
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenCalledWith(
      "loan.export",
      expect.objectContaining({
        loanAccounts: ["2001"],
        rateRows: [
          expect.objectContaining({
            loanId: "2001 短期借款",
            rateType: "fixed",
            fixedRate: 0.0385,
          }),
        ],
      }),
    ),
  );
});
