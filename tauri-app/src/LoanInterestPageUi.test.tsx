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
  fireEvent.click(upload);
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
  // 科目清单渲染，借款科目按名称预选，应收账款默认排除。
  expect(await screen.findByText("确认借款科目")).toBeVisible();
  expect(
    screen.queryByRole("columnheader", { name: "辅助明细" }),
  ).not.toBeInTheDocument();
  const loanSelect = await screen.findByRole("combobox", { name: "2001 短期借款的科目类型" });
  expect((loanSelect as HTMLSelectElement).value).toBe("loan");
  const skipSelect = await screen.findByRole("combobox", { name: "1122 应收账款的科目类型" });
  expect((skipSelect as HTMLSelectElement).value).toBe("skip");
  const accountRows = screen.getAllByRole("row");
  expect(accountRows[1]).toHaveTextContent("短期借款");
  expect(accountRows[2]).toHaveTextContent("应收账款");
  expect(accountRows.length).toBeLessThanOrEqual(81);
  expect(screen.getByText("第 1 / 3 页")).toBeVisible();
  fireEvent.change(loanSelect, { target: { value: "skip" } });
  expect(screen.getByText("2001 短期借款已设为排除。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByText("第 2 / 3 页")).toBeVisible();
  expect(screen.getByText(/已切换到第 2 页/)).toBeVisible();
  expect(screen.getByText("设置借款利率")).toBeVisible();
  expect(screen.getByRole("region", { name: "等待生成利率明细" })).toBeVisible();
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
  expect(await screen.findByText("借款利率确认表")).toBeVisible();
  expect(screen.getAllByRole("columnheader", { name: "科目编码" }).at(-1)).toBeVisible();
  expect(screen.getAllByRole("columnheader", { name: "科目名称" }).at(-1)).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "辅助核算" })).toBeVisible();
  expect(screen.getByText("A银行")).toBeVisible();
  expect(
    screen.getByText("JE里无借款辅助明细，默认按科目维度进行利息测算"),
  ).toBeVisible();
  expect(
    screen.queryByText("未通过辅助验证的主体＋科目已合并；验证成功的其他科目仍按辅助核算拆分。请按各行匹配依据复核。"),
  ).not.toBeInTheDocument();
  // 手填固定执行利率 3.85。
  fireEvent.change(screen.getByRole("spinbutton", { name: "2001 短期借款的执行利率" }), {
    target: { value: "3.85" },
  });
  expect(screen.getByRole("spinbutton", { name: "2001 短期借款的执行利率" })).toHaveValue(3.85);
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
