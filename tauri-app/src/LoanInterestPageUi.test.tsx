// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoanInterestPage, Results } from "./LoanInterestPage";
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
    if (method === "ledger.currency_link") {
      return {
        required: false,
        verified: true,
        missingCurrencies: [],
        affectedGroupCount: 0,
      };
    }
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
    if (method === "ledger.currency_link")
      return { required: false, verified: true, missingCurrencies: [], affectedGroupCount: 0 };
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

it("公共入口重建整组，待上传单侧入口只补充对应来源", async () => {
  const classify = (kind: "tb" | "je", path: string) => ({
    kind,
    scores: { je: kind === "je" ? 10 : 1, tb: kind === "tb" ? 10 : 1 },
    sheet: kind === "tb" ? "余额表" : "序时账",
    headerRow: 1,
    headerDepth: 1,
    headers: kind === "tb" ? ["科目编码", "期末余额"] : ["记账日期", "科目编码", "贷方金额"],
    preview: [[path]],
  });
  mock.pickPath
    .mockResolvedValueOnce(["tb.xlsx"])
    .mockResolvedValueOnce("je.xlsx")
    .mockResolvedValueOnce(["je-new.xlsx"]);
  mock.engineCall.mockImplementation(async (method: string, params: unknown) => {
    const p = params as { kind?: "tb" | "je"; source?: { inputPath?: string } };
    const kind = p.source?.inputPath?.includes("je") ? "je" : "tb";
    if (method === "ledger.forms") return [];
    if (method === "ledger.currency_link")
      return { required: false, verified: true, missingCurrencies: [], affectedGroupCount: 0 };
    if (method === "deposit.classify_source")
      return classify(kind, p.source?.inputPath ?? "");
    if (method === "loan.inspect") {
      const selected = p.kind ?? kind;
      return {
        ...classify(selected, p.source?.inputPath ?? ""),
        rowCount: 1,
        sheets: [selected === "tb" ? "余额表" : "序时账"],
        suggestedMapping: {},
      };
    }
    throw new Error(`unexpected ${method}`);
  });

  render(<LoanInterestPage tool={tool} />);
  fireEvent.click(screen.getByRole("button", { name: "TB＋JE" }));
  const upload = screen.getByRole("button", {
    name: "拖放或选择 TB、序时账文件（可同时选择）",
  });
  fireEvent.click(upload);
  expect((await screen.findAllByText("tb.xlsx"))[0]).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "补充上传 JE" }));
  expect((await screen.findAllByText("je.xlsx"))[0]).toBeVisible();
  expect(screen.getAllByText("tb.xlsx")[0]).toBeVisible();
  expect(screen.getByText("已识别：TB 科目余额表")).toBeVisible();
  expect(screen.getByText("已识别：JE 序时账")).toBeVisible();

  // 再走公共入口只选一份 JE：按“重新选择整组”语义，旧 TB 与旧 JE 都清空。
  fireEvent.click(
    screen.getByRole("button", { name: "重新选择文件：je.xlsx" }),
  );
  expect((await screen.findAllByText("je-new.xlsx"))[0]).toBeVisible();
  expect(screen.queryByText("tb.xlsx")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "补充上传 TB" })).toBeVisible();
});

/** 借款页一次联合复核 TB＋JE，并保持本页的单列映射交互。
 *  曾经把 accountName 的单个建议写成 string[]，随后 loanMissing 调用
 *  `.trim()` 直接把整个 React 界面打成白屏。 */
it("借款 TB＋JE 一键联合复核并按单列映射写回，不会白屏", async () => {
  const tbHeaders = ["科目编码", "科目名称", "期初余额", "期末余额"];
  const jeHeaders = ["记账日期", "凭证号", "文本", "会计科目", "总账科目", "本币金额"];
  const classify = (kind: "tb" | "je", headers: string[]) => ({
    kind,
    scores: { je: kind === "je" ? 10 : 1, tb: kind === "tb" ? 10 : 1 },
    sheet: "Sheet1",
    headerRow: 1,
    headerDepth: 1,
    headers,
    preview: [headers.map(() => "x")],
  });
  const inspect = (kind: "tb" | "je", headers: string[]) => ({
    headers,
    preview:
      kind === "je"
        ? [["2025-01-31", "1", "摘要", "库存现金-人民币", "1001010000", "100"]]
        : [["1001", "库存现金", "0", "100"]],
    rowCount: 2,
    sheet: "Sheet1",
    sheets: ["Sheet1"],
    headerRow: 1,
    headerDepth: 1,
    suggestedMapping:
      kind === "je"
        ? { date: "记账日期", id: "凭证号", accountCode: "总账科目" }
        : {
            accountCode: "科目编码",
            accountName: "科目名称",
            openingFunctionalAmount: "期初余额",
            closingFunctionalAmount: "期末余额",
          },
  });
  mock.pickPath.mockResolvedValue(["tb.xlsx", "03序时账.xlsx"]);
  mock.engineCall.mockImplementation(async (method: string, params: unknown) => {
    const p = params as {
      kind?: "tb" | "je";
      source?: { inputPath?: string };
      payload?: {
        tool?: string;
        tb?: { currentMapping?: Record<string, unknown> };
        je?: { currentMapping?: Record<string, unknown> };
      };
    };
    if (method === "ledger.forms") return [];
    if (method === "ledger.currency_link")
      return { required: false, verified: true, missingCurrencies: [], affectedGroupCount: 0 };
    if (method === "deposit.classify_source") {
      return p.source?.inputPath?.includes("03")
        ? classify("je", jeHeaders)
        : classify("tb", tbHeaders);
    }
    if (method === "loan.inspect") {
      return p.kind === "je"
        ? inspect("je", jeHeaders)
        : inspect("tb", tbHeaders);
    }
    if (method === "ledger.review_pair_mapping") {
      expect(p.payload?.tool).toBe("loan_interest");
      expect(p.payload?.tb?.currentMapping).toBeTruthy();
      expect(p.payload?.je?.currentMapping).toBeTruthy();
      return {
        tbChanges: [],
        jeChanges: [
          {
            role: "accountName",
            suggestedColumn: "会计科目",
            confidence: 1,
            reason: "样例值为科目名称",
            engineVerified: true,
          },
        ],
      };
    }
    if (method === "loan.tb_accounts") {
      return {
        accounts: [
          { key: "2001", code: "2001", name: "短期借款", account: "2001 短期借款", opening: 100, closing: 100, suggestedType: "loan" },
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
  await screen.findByText("已识别：JE 序时账");
  fireEvent.click(
    await screen.findByRole("button", {
      name: "一键复核 TB＋JE",
    }),
  );

  await waitFor(() =>
    expect(mock.engineCall).toHaveBeenCalledWith(
      "ledger.review_pair_mapping",
      expect.any(Object),
      // 第三个参数是给等待弹窗的明细（来自 pairLabel），不进引擎参数。
      "借款利息测算 TB＋JE",
    ),
  );

  expect(
    (await screen.findAllByText(/已复核 · 已自动调整 1 项/))[0],
  ).toBeVisible();
  expect(screen.getByText(/已生效/)).toBeVisible();
  expect(screen.getByRole("button", { name: "撤销" })).toBeVisible();
  expect(
    screen
      .getAllByRole("combobox")
      .some((element) => (element as HTMLSelectElement).value === "accountName"),
  ).toBe(true);
  expect(screen.queryByText("尚未映射：科目名称")).not.toBeInTheDocument();

  const reviewCallsBeforeReturn = mock.engineCall.mock.calls.filter(
    ([method]) => method === "ledger.review_pair_mapping",
  ).length;
  fireEvent.click(screen.getByRole("button", { name: "下一步：确认科目与利率" }));
  expect(await screen.findByText("确认借款及利息支出科目并设置利率")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "返回上传与识别" }));
  expect(await screen.findByRole("button", { name: "一键复核 TB＋JE" })).toBeVisible();
  await waitFor(() =>
    expect(
      mock.engineCall.mock.calls.filter(
        ([method]) => method === "ledger.review_pair_mapping",
      ).length,
    ).toBe(reviewCallsBeforeReturn),
  );
});

it("本金无差异与计息口径分开显示，并列示利息支出差异", () => {
  render(
    <Results
      editRate={() => undefined}
      rows={[
        {
          entity: "甲公司",
          loanId: "2001 短期借款",
          openingPrincipal: 100,
          additions: 20,
          reductions: 10,
          closingPrincipal: 110,
          ledgerClosing: 110,
          rateType: "fixed",
          calculatedInterest: 8,
          matchStatus: "待复核",
          matchBasis: "无利率",
        },
      ]}
      result={{
        summary: {
          hasInterestExpenseAccount: true,
          bookedInterestExpense: 6,
          interestExpenseDifference: 2,
        },
      }}
    />,
  );
  expect(screen.getByText("本金已勾稽")).toBeVisible();
  expect(screen.getByText("待填利率")).toBeVisible();
  expect(screen.queryByText("1 笔待复核")).not.toBeInTheDocument();
  expect(screen.getByText("TB 利息支出")).toBeVisible();
  expect(screen.getByText("差异（测算－TB）")).toBeVisible();
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
    if (method === "ledger.currency_link")
      return { required: false, verified: true, missingCurrencies: [], affectedGroupCount: 0 };
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
          { key: "1122", code: "1122", name: "应收账款", account: "1122 应收账款", opening: 5, closing: 6, suggestedType: "skip", suggestionReason: "资产类科目" },
          { key: "2001", code: "2001", name: "短期借款", account: "2001 短期借款", opening: 1000, closing: 900, suggestedType: "loan", suggestionReason: "负债类借款科目" },
          { key: "66030001", code: "66030001", name: "财务费用-利息支出", account: "66030001 财务费用-利息支出", opening: 0, closing: 0, suggestedType: "interest_expense" },
          ...Array.from({ length: 160 }, (_, index) => ({ key: `5${index + 10000}`, code: `5${index + 10000}`, name: `其他科目${index}`, account: `5${index + 10000} 其他科目${index}`, opening: 0, closing: 0, suggestedType: "skip" as const, suggestionReason: "其他科目" })),
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
  // 科目清单渲染，借款科目按名称预选，应收账款默认排除；科目与利率已合并为一张表。
  expect(await screen.findByText("确认借款及利息支出科目并设置利率")).toBeVisible();
  expect(screen.queryByRole("columnheader", { name: "系统建议" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "恢复系统建议" })).not.toBeInTheDocument();
  // 单一主体、无辅助核算的账套：主体列与辅助核算列都不出现。
  expect(
    screen.queryByRole("columnheader", { name: "辅助明细" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("columnheader", { name: "辅助核算" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("columnheader", { name: "主体" }),
  ).not.toBeInTheDocument();
  // 合并后利率列已并入科目表：表头一次带全科目与利率两组列。
  expect(screen.getByRole("columnheader", { name: "科目类型" })).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "执行利率（%）" })).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "匹配依据" })).toBeVisible();
  const loanSelect = await screen.findByRole("combobox", { name: "2001 短期借款的科目类型" });
  expect((loanSelect as HTMLSelectElement).value).toBe("loan");
  const skipSelect = await screen.findByRole("combobox", { name: "1122 应收账款的科目类型" });
  expect((skipSelect as HTMLSelectElement).value).toBe("skip");
  const expenseSelect = await screen.findByRole("combobox", { name: "66030001 财务费用-利息支出的科目类型" });
  expect((expenseSelect as HTMLSelectElement).value).toBe("interest_expense");
  const accountRows = screen.getAllByRole("row");
  expect(accountRows[1]).toHaveTextContent("短期借款");
  expect(accountRows[2]).toHaveTextContent("利息支出");
  expect(accountRows.length).toBeLessThanOrEqual(81);
  expect(screen.getByText("第 1 / 3 页")).toBeVisible();
  fireEvent.change(loanSelect, { target: { value: "skip" } });
  expect(screen.getByText("2001 短期借款已设为排除。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByText("第 2 / 3 页")).toBeVisible();
  expect(screen.getByText(/已切换到第 2 页/)).toBeVisible();
  // 「第 2 项 设置借款利率」卡已并入同一张表：生成利率表已全自动化，按钮删除，
  // 映射缺失时只显示等待空态（回第一步补齐映射后再进入本步骤会自动生成）。
  expect(
    screen.queryByRole("button", { name: "生成借款利率表" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "重新生成借款利率表" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "等待生成利率明细" })).toBeVisible();
  // 金额映射没补齐：下一步仍拦，但不再出现「借款明细/辅助核算」的旧提示。
  expect(
    screen.getByRole("button", { name: "下一步：测算与底稿" }),
  ).toBeDisabled();
  expect(
    screen.queryByText(/尚未映射「借款明细\/辅助核算」/),
  ).not.toBeInTheDocument();
});

/** 映射齐全时进入第二步自动生成利率表；手填年利率后直接「下一步」，进入第三步
 *  即自动用当前利率重算（携带 rateRows），测算利息不再停留在旧快照的 0。 */
it("手填利率后直接下一步：自动用当前利率重算，测算利息非 0", async () => {
  const tbHeaders = ["科目编码", "科目名称", "辅助核算", "期初余额", "期末余额"];
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
    auxiliary: "辅助核算",
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
    if (method === "ledger.currency_link")
      return { required: false, verified: true, missingCurrencies: [], affectedGroupCount: 0 };
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
          { key: "66030001", code: "66030001", name: "财务费用-利息支出", account: "66030001 财务费用-利息支出", opening: 0, closing: 0, suggestedType: "interest_expense" },
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
  // 表日只在第三步维护：第二步不再出现日期字段。
  mock.jobStart.mockResolvedValue("job-rates");
  fireEvent.click(screen.getByRole("button", { name: /下一步：确认科目与利率/ }));
  expect(await screen.findByText("确认借款及利息支出科目并设置利率")).toBeVisible();
  expect(screen.queryByLabelText("资产负债表日")).not.toBeInTheDocument();
  // 映射齐全即自动生成利率确认表，不再让用户手动点「生成借款利率表」。
  await waitFor(() => expect(mock.jobStart).toHaveBeenCalledWith(
    "loan.preview",
    expect.objectContaining({
      loanAccounts: ["2001"],
      interestExpenseAccounts: ["66030001"],
    }),
  ));
  // preview 任务完成：借款明细并入合并表（单一明细直接在科目行利率列编辑）。
  mock.jobEvents.callback?.({
    jobId: "job-rates",
    phase: "completed",
    result: {
      rows: [
        {
          entity: "浙江沪杭甬高速公路股份有限公司",
          accountCode: "200101",
          accountName: "短期借款_银行借款",
          auxiliary: "A银行",
          loanId: "2001 短期借款",
          openingPrincipal: 1000000,
          closingPrincipal: 900000,
          matchStatus: "待复核",
          matchBasis: "匹配 2 条 JE（编码 2）",
        },
      ],
      summary: { loanCount: 1 },
      mappingWarnings: ["JE里无借款辅助明细，默认按科目维度进行利息测算"],
    },
  });
  expect(
    await screen.findByRole("columnheader", { name: "辅助核算" }),
  ).toBeVisible();
  expect(screen.queryByText(/共 1 笔借款明细，已填利率 0 笔/)).not.toBeInTheDocument();
  // 科目与利率合并为一张表：科目列与利率列同在这一张表头里。
  expect(screen.getByRole("columnheader", { name: "科目编码" })).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "科目名称" })).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "执行利率（%）" })).toBeVisible();
  const loanRateInput = await screen.findByRole("spinbutton", {
    name: "2001 短期借款的执行利率",
  });
  expect(loanRateInput).toHaveValue(3);
  expect(loanRateInput).toHaveClass("loan-manual-number");
  expect(screen.queryByRole("button", { name: "导出利率确认表" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "回读已填利率表" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下载科目确认表" })).toBeVisible();
  const rateTip = screen.getByRole("button", { name: "什么是执行利率" });
  fireEvent.mouseEnter(rateTip);
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    "工具会默认写入利率，用户应就据实修改",
  );
  fireEvent.mouseLeave(rateTip);
  // 借款行利率可编辑，单一明细的辅助核算就地显示在科目行的辅助核算列。
  expect(loanRateInput).toBeEnabled();
  const loanRow = loanRateInput.closest("tr")!;
  expect(within(loanRow).getByText("A银行")).toBeVisible();
  expect(within(loanRow).getByText("匹配 2 条 JE（编码 2）")).toBeVisible();
  // 利息支出行利率列不可编辑：只有「—」，没有利率输入与利率类型下拉。
  const expenseRow = screen
    .getByRole("combobox", { name: "66030001 财务费用-利息支出的科目类型" })
    .closest("tr")!;
  expect(within(expenseRow).queryAllByRole("spinbutton")).toHaveLength(0);
  expect(
    within(expenseRow).queryByRole("combobox", { name: /的利率类型/ }),
  ).not.toBeInTheDocument();
  expect(within(expenseRow).getAllByText("—").length).toBeGreaterThanOrEqual(6);
  expect(
    screen.getByText("JE里无借款辅助明细，默认按科目维度进行利息测算"),
  ).toBeVisible();
  expect(
    screen.queryByText("未通过辅助验证的主体＋科目已合并；验证成功的其他科目仍按辅助核算拆分。请按各行匹配依据复核。"),
  ).not.toBeInTheDocument();
  // 手填固定执行利率 3.85。
  fireEvent.change(loanRateInput, {
    target: { value: "3.85" },
  });
  expect(screen.getByRole("spinbutton", { name: "2001 短期借款的执行利率" })).toHaveValue(3.85);
  expect(screen.queryByText(/已填利率 1 笔/)).not.toBeInTheDocument();
  // 下一步放行。
  expect(
    screen.getByRole("button", { name: "下一步：测算与底稿" }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "下一步：测算与底稿" }));
  // 缺陷回归：进入第三步即用当前已填利率自动重算（loan.preview 携带 rateRows），
  // 不再要求先点「重新生成借款利率表」。
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenLastCalledWith(
      "loan.preview",
      expect.objectContaining({
        loanAccounts: ["2001"],
        interestExpenseAccounts: ["66030001"],
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
  // 重算完成：结果表带出非 0 的测算利息（旧快照生成于填利率之前，利息为 0）。
  mock.jobEvents.callback?.({
    jobId: "job-rates",
    phase: "completed",
    result: {
      rows: [
        {
          entity: "浙江沪杭甬高速公路股份有限公司",
          accountCode: "200101",
          accountName: "短期借款_银行借款",
          auxiliary: "A银行",
          loanId: "2001 短期借款",
          openingPrincipal: 1000000,
          closingPrincipal: 900000,
          rateType: "fixed",
          fixedRate: 0.0385,
          calculatedInterest: 38500,
          matchStatus: "已匹配",
          matchBasis: "匹配 2 条 JE（编码 2）",
        },
      ],
      summary: { loanCount: 1 },
    },
  });
  expect(await screen.findByText("38,500")).toBeVisible();
  // 导出底稿沿用同一份确认清单与利率。
  fireEvent.click(screen.getByRole("button", { name: "生成 Excel 底稿" }));
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenCalledWith(
      "loan.export",
      expect.objectContaining({
        loanAccounts: ["2001"],
        interestExpenseAccounts: ["66030001"],
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

/** 本位币选择（TB 模式）：默认人民币口径不传 functionalCurrency；海外主体
 *  选择美元后，利率明细快照过期并自动按新口径重跑 loan.preview、携带
 *  functionalCurrency——引擎据此把币种留空的 TB 行与逐行标 USD 的 JE
 *  分录归入同一币种桶（诺桥美国样例）。 */
it("选择本位币后利率明细按新口径自动重算并携带 functionalCurrency", async () => {
  const tbHeaders = ["科目编码", "科目名称", "辅助核算", "期初余额", "期末余额"];
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
    auxiliary: "辅助核算",
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
    if (method === "ledger.currency_link")
      return { required: false, verified: true, missingCurrencies: [], affectedGroupCount: 0 };
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
          { key: "241000", code: "241000", name: "长期借款-美洲银行", account: "241000 长期借款-美洲银行", opening: 8000000, closing: 6400000 },
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
  mock.jobStart.mockResolvedValue("job-rates");
  fireEvent.click(screen.getByRole("button", { name: /下一步：确认科目与利率/ }));
  expect(await screen.findByText("确认借款及利息支出科目并设置利率")).toBeVisible();
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenCalledWith(
      "loan.preview",
      expect.objectContaining({ loanAccounts: ["241000"] }),
    ),
  );
  // 默认人民币口径：payload 不携带本位币参数。
  const previewCalls = mock.jobStart.mock.calls.filter(
    ([method]) => method === "loan.preview",
  );
  const defaultPreview = previewCalls[previewCalls.length - 1][1] as Record<
    string,
    unknown
  >;
  expect(defaultPreview.functionalCurrency).toBeUndefined();
  mock.jobEvents.callback?.({
    jobId: "job-rates",
    phase: "completed",
    result: {
      rows: [
        {
          entity: "诺桥美国",
          accountCode: "241000",
          accountName: "长期借款-美洲银行",
          auxiliary: "",
          loanId: "241000 长期借款-美洲银行",
          openingPrincipal: 8000000,
          closingPrincipal: 6400000,
          matchStatus: "待复核",
          matchBasis: "未匹配 JE，采用 TB 发生额（编码汇总口径）",
        },
      ],
      summary: { loanCount: 1 },
    },
  });
  expect(await screen.findByText("长期借款-美洲银行")).toBeVisible();
  // 海外主体切换本位币为美元：利率明细自动按新口径重跑并携带参数。
  fireEvent.change(screen.getByRole("combobox", { name: "本位币" }), {
    target: { value: "USD" },
  });
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenLastCalledWith(
      "loan.preview",
      expect.objectContaining({ functionalCurrency: "USD" }),
    ),
  );
  mock.jobEvents.callback?.({
    jobId: "job-rates",
    phase: "completed",
    result: {
      rows: [
        {
          entity: "诺桥美国",
          accountCode: "241000",
          accountName: "长期借款-美洲银行",
          auxiliary: "",
          loanId: "241000 长期借款-美洲银行",
          openingPrincipal: 8000000,
          closingPrincipal: 6400000,
          matchStatus: "已匹配",
          matchBasis: "匹配 1 条 JE（编码 1）",
        },
      ],
      summary: { loanCount: 1 },
    },
  });
  expect(await screen.findByText("匹配 1 条 JE（编码 1）")).toBeVisible();
});

/** 缺陷回归：手动把某行科目类型改成「借款科目」后，无需点「重新生成借款利率表」，
 *  页面自动按新选择重跑 loan.preview，利率输入随新明细立即可编辑；改回
 *  「排除」时利率输入随之消失。 */
it("科目类型改为借款后利率输入立即可编辑（自动重生成）", async () => {
  const tbHeaders = ["科目编码", "科目名称", "辅助核算", "期初余额", "期末余额"];
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
    auxiliary: "辅助核算",
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
    if (method === "ledger.currency_link")
      return { required: false, verified: true, missingCurrencies: [], affectedGroupCount: 0 };
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
          // 2202 初始建议排除：预选只有 2001，首张利率表没有它的利率输入。
          { key: "2202", code: "2202", name: "长期借款", account: "2202 长期借款", opening: 500000, closing: 500000, suggestedType: "skip", suggestionReason: "初始建议排除" },
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
  mock.jobStart.mockResolvedValue("job-auto");
  fireEvent.click(screen.getByRole("button", { name: /下一步：确认科目与利率/ }));
  expect(await screen.findByText("确认借款及利息支出科目并设置利率")).toBeVisible();
  // 进入第二步自动生成：只含预选的 2001。
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenCalledWith(
      "loan.preview",
      expect.objectContaining({ loanAccounts: ["2001"] }),
    ),
  );
  mock.jobEvents.callback?.({
    jobId: "job-auto",
    phase: "completed",
    result: {
      rows: [
        {
          rowKey: "tb\u001f默认主体\u001f2001\u001fA银行",
          accountCode: "2001",
          accountName: "短期借款",
          auxiliary: "A银行",
          loanId: "A银行借款",
          openingPrincipal: 1000000,
          closingPrincipal: 900000,
          matchStatus: "待复核",
          matchBasis: "匹配 2 条 JE（编码 2）",
        },
      ],
      summary: { loanCount: 1 },
    },
  });
  expect(
    await screen.findByRole("spinbutton", { name: "A银行借款的执行利率" }),
  ).toBeEnabled();
  // 2202 还是排除：利率栏全是「—」，没有输入框。
  const skipRow = screen
    .getByRole("combobox", { name: "2202 长期借款的科目类型" })
    .closest("tr")!;
  expect((skipRow.querySelector("select") as HTMLSelectElement).value).toBe("skip");
  expect(within(skipRow).queryAllByRole("spinbutton")).toHaveLength(0);
  // 手动改成「借款科目」：无需任何按钮，自动按新选择重跑 loan.preview。
  fireEvent.change(
    screen.getByRole("combobox", { name: "2202 长期借款的科目类型" }),
    { target: { value: "loan" } },
  );
  expect(screen.getByText("2202 长期借款已设为借款科目。")).toBeVisible();
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenLastCalledWith(
      "loan.preview",
      expect.objectContaining({ loanAccounts: ["2001", "2202"] }),
    ),
  );
  mock.jobEvents.callback?.({
    jobId: "job-auto",
    phase: "completed",
    result: {
      rows: [
        {
          rowKey: "tb\u001f默认主体\u001f2001\u001fA银行",
          accountCode: "2001",
          accountName: "短期借款",
          auxiliary: "A银行",
          loanId: "A银行借款",
          openingPrincipal: 1000000,
          closingPrincipal: 900000,
          matchStatus: "待复核",
          matchBasis: "匹配 2 条 JE（编码 2）",
        },
        {
          rowKey: "tb\u001f默认主体\u001f2202\u001fC银行",
          accountCode: "2202",
          accountName: "长期借款",
          auxiliary: "C银行",
          loanId: "C银行借款",
          openingPrincipal: 500000,
          closingPrincipal: 500000,
          matchStatus: "待复核",
          matchBasis: "匹配 1 条 JE（编码 2）",
        },
      ],
      summary: { loanCount: 2 },
    },
  });
  // 新科目的利率输入随重生成结果立即可编辑。
  const newRate = await screen.findByRole("spinbutton", {
    name: "C银行借款的执行利率",
  });
  expect(newRate).toBeEnabled();
  fireEvent.change(newRate, { target: { value: "3.10" } });
  expect(newRate).toHaveValue(3.1);
  // 改回「排除」：利率输入立即消失，恢复为「—」。
  fireEvent.change(
    screen.getByRole("combobox", { name: "2202 长期借款的科目类型" }),
    { target: { value: "skip" } },
  );
  expect(
    screen.queryByRole("spinbutton", { name: "C银行借款的执行利率" }),
  ).not.toBeInTheDocument();
});

/** 同一借款科目按辅助核算拆成多笔明细：科目行只汇总「N 笔明细」，明细在
 *  科目行下方展开为子行逐笔设置利率；改科目类型隐藏子行但不丢已填利率，
 *  切回借款即恢复，手填利率按 rowKey 进入测算 payload。 */
it("同一科目多笔借款明细展开为子行逐笔设置利率，改类型不丢已填利率", async () => {
  const tbHeaders = ["科目编码", "科目名称", "辅助核算", "期初余额", "期末余额"];
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
    auxiliary: "辅助核算",
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
    if (method === "ledger.currency_link")
      return { required: false, verified: true, missingCurrencies: [], affectedGroupCount: 0 };
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
          { key: "66030001", code: "66030001", name: "财务费用-利息支出", account: "66030001 财务费用-利息支出", opening: 0, closing: 0, suggestedType: "interest_expense" },
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
  mock.jobStart.mockResolvedValue("job-split");
  fireEvent.click(screen.getByRole("button", { name: /下一步：确认科目与利率/ }));
  expect(await screen.findByText("确认借款及利息支出科目并设置利率")).toBeVisible();
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenCalledWith(
      "loan.preview",
      expect.objectContaining({ loanAccounts: ["2001"] }),
    ),
  );
  // 同一科目按辅助核算拆出两笔：科目行汇总，子行展开（各带主体与辅助核算）。
  mock.jobEvents.callback?.({
    jobId: "job-split",
    phase: "completed",
    result: {
      rows: [
        {
          entity: "甲公司",
          rowKey: "tb\u001f甲公司\u001f2001\u001fA银行",
          accountCode: "2001",
          accountName: "短期借款",
          auxiliary: "A银行",
          loanId: "A银行借款",
          openingPrincipal: 600000,
          closingPrincipal: 500000,
          matchStatus: "已匹配",
          matchBasis: "匹配 2 条 JE（编码 2）",
        },
        {
          entity: "甲公司",
          rowKey: "tb\u001f甲公司\u001f2001\u001fB银行",
          accountCode: "2001",
          accountName: "短期借款",
          auxiliary: "B银行",
          loanId: "B银行借款",
          openingPrincipal: 400000,
          closingPrincipal: 400000,
          matchStatus: "待复核",
          matchBasis: "未匹配 JE，采用 TB 发生额（编码汇总口径）",
        },
      ],
      summary: { loanCount: 2 },
    },
  });
  expect(await screen.findByText("2 笔明细")).toBeVisible();
  const rateA = await screen.findByRole("spinbutton", {
    name: "A银行借款的执行利率",
  });
  const rateB = screen.getByRole("spinbutton", { name: "B银行借款的执行利率" });
  expect(rateA).toBeEnabled();
  expect(rateB).toBeEnabled();
  expect(
    screen.getByText("未匹配 JE，采用 TB 发生额（编码汇总口径）"),
  ).toBeVisible();
  fireEvent.change(rateA, { target: { value: "3.85" } });
  // 科目类型改为排除：利率子行整体隐藏；切回借款，已填利率原样恢复。
  const roleSelect = screen.getByRole("combobox", {
    name: "2001 短期借款的科目类型",
  });
  fireEvent.change(roleSelect, { target: { value: "skip" } });
  expect(
    screen.queryByRole("spinbutton", { name: "A银行借款的执行利率" }),
  ).not.toBeInTheDocument();
  fireEvent.change(roleSelect, { target: { value: "loan" } });
  expect(
    screen.getByRole("spinbutton", { name: "A银行借款的执行利率" }),
  ).toHaveValue(3.85);
  // 手填利率按明细 rowKey 进入测算 payload。下一步自动重算：先等 preview
  // 任务带利率发起并完成，再点导出（任务运行中导出按钮禁用）。
  fireEvent.click(screen.getByRole("button", { name: "下一步：测算与底稿" }));
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenLastCalledWith(
      "loan.preview",
      expect.objectContaining({
        loanAccounts: ["2001"],
        rateRows: expect.arrayContaining([
          expect.objectContaining({
            rowKey: "tb\u001f甲公司\u001f2001\u001fA银行",
            rateType: "fixed",
            fixedRate: 0.0385,
          }),
        ]),
      }),
    ),
  );
  mock.jobEvents.callback?.({
    jobId: "job-split",
    phase: "completed",
    result: {
      rows: [
        {
          entity: "甲公司",
          rowKey: "tb\u001f甲公司\u001f2001\u001fA银行",
          accountCode: "2001",
          accountName: "短期借款",
          auxiliary: "A银行",
          loanId: "A银行借款",
          openingPrincipal: 600000,
          closingPrincipal: 500000,
          matchStatus: "已匹配",
          matchBasis: "匹配 2 条 JE（编码 2）",
        },
        {
          entity: "甲公司",
          rowKey: "tb\u001f甲公司\u001f2001\u001fB银行",
          accountCode: "2001",
          accountName: "短期借款",
          auxiliary: "B银行",
          loanId: "B银行借款",
          openingPrincipal: 400000,
          closingPrincipal: 400000,
          matchStatus: "待复核",
          matchBasis: "未匹配 JE，采用 TB 发生额（编码汇总口径）",
        },
      ],
      summary: { loanCount: 2 },
    },
  });
  // 重算完成（导出按钮随 busy 复位解禁）后再导出。
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "生成 Excel 底稿" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "生成 Excel 底稿" }));
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenCalledWith(
      "loan.export",
      expect.objectContaining({
        loanAccounts: ["2001"],
        rateRows: expect.arrayContaining([
          expect.objectContaining({
            rowKey: "tb\u001f甲公司\u001f2001\u001fA银行",
            rateType: "fixed",
            fixedRate: 0.0385,
          }),
        ]),
      }),
    ),
  );
});

/** TB＋JE 第二步进入口（底部「下一步」与步骤条导航共用）的币种衔接验证：
 *  同一验证输入已通过后，反复进出第二步不得重复请求 ledger.currency_link。 */
function renderLoanTbJeWorkspace(entities: string[]) {
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
    entities,
    // TB 故意只建议科目两列：金额缺失拦住自动生成利率表，专注导航行为本身。
    suggestedMapping:
      kind === "tb"
        ? { accountCode: "科目编码", accountName: "科目名称" }
        : { date: "记账日期", accountCode: "科目编码" },
  });
  mock.pickPath.mockResolvedValue(["tb.xlsx", "je.xlsx"]);
  mock.engineCall.mockImplementation(async (method: string, params: unknown) => {
    const p = params as { kind?: string; source?: { inputPath?: string } };
    if (method === "ledger.forms") return [];
    if (method === "ledger.currency_link")
      return { required: false, verified: true, missingCurrencies: [], affectedGroupCount: 0 };
    if (method === "ledger.entity_scope_suggestions")
      return { anchors: [], candidates: [] };
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
          { key: "2001", code: "2001", name: "短期借款", account: "2001 短期借款", opening: 1000, closing: 900, suggestedType: "loan" },
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
}

it("同一输入下来回进出第二步不重复验证币种衔接", async () => {
  renderLoanTbJeWorkspace([]);
  await screen.findByText("已识别：TB 科目余额表");
  await screen.findByText("已识别：JE 序时账");
  const linkCalls = () =>
    mock.engineCall.mock.calls.filter(
      ([method]) => method === "ledger.currency_link",
    ).length;

  fireEvent.click(screen.getByRole("button", { name: /下一步：确认科目与利率/ }));
  expect(
    await screen.findByText("确认借款及利息支出科目并设置利率"),
  ).toBeVisible();
  expect(linkCalls()).toBe(1);

  // 底部「返回」再「下一步」：进入第二步后借款科目已从空清单预选为 2001，
  // 验证输入变了，重新验证一次。
  fireEvent.click(screen.getByRole("button", { name: "返回上传与识别" }));
  await screen.findByRole("button", { name: "一键复核 TB＋JE" });
  fireEvent.click(screen.getByRole("button", { name: /下一步：确认科目与利率/ }));
  expect(
    await screen.findByText("确认借款及利息支出科目并设置利率"),
  ).toBeVisible();
  expect(linkCalls()).toBe(2);

  // 步骤条导航 0→1→0→1（已完成步的读法带「（已完成）」后缀）：同一验证
  // 输入已通过，直接跳步，不再触发验证。
  fireEvent.click(screen.getByRole("button", { name: /1 上传与识别/ }));
  await screen.findByRole("button", { name: "一键复核 TB＋JE" });
  fireEvent.click(screen.getByRole("button", { name: "2 确认科目与利率" }));
  expect(
    await screen.findByText("确认借款及利息支出科目并设置利率"),
  ).toBeVisible();
  expect(linkCalls()).toBe(2);
});

/** TB/JE 识别出多个实际主体（「默认主体」占位不算）时，第二步合并表必须
 *  带主体列；单主体账套维持原有布局（见上方「预选借款科目」用例）。 */
it("多主体账套第二步合并表显示主体列", async () => {
  renderLoanTbJeWorkspace(["甲公司", "乙公司"]);
  await screen.findByText("已识别：TB 科目余额表");
  await screen.findByText("已识别：JE 序时账");
  fireEvent.click(screen.getByRole("button", { name: /下一步：确认科目与利率/ }));
  expect(
    await screen.findByRole("columnheader", { name: "主体" }),
  ).toBeVisible();
  // 科目行由全表汇总而来、无单一主体：主体列显示占位符 —。
  const loanRow = await screen
    .findByRole("combobox", { name: "2001 短期借款的科目类型" })
    .then((element) => element.closest("tr")!);
  expect(loanRow.querySelector("td")?.textContent).toBe("—");
});
