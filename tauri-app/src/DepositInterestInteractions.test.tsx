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
import { publishTaskRestore } from "./restore";
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
  // 引擎目录末级掩码下发的清单：6603 是 66030101 的父级，不进确认界面。
  accountsLeaf: [bank, leaf],
  suggestedMapping: mapping,
  suggestedAccountRoles: {
    [bank]: "deposit",
    [parent]: "excluded",
    [leaf]: "excluded",
  },
  suggestedAccountTiers: { [bank]: "demand" },
  mappingCandidates: [],
  headerDetection: { needsConfirmation: false, candidates: [] },
  dataYears: [2025],
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.pickPath.mockResolvedValue("fixture-tb.xlsx");
  mock.jobStart.mockResolvedValue("deposit-job");
  mock.engineCall.mockImplementation(async (method: string) => {
    if (method === "deposit.rate_tiers")
      return {
        categories: [
          {
            key: "demand",
            label: "活期存款",
            terms: [{ key: "demand", label: "" }],
          },
          {
            key: "term",
            label: "定期存款",
            terms: [{ key: "term_1y", label: "1年" }],
          },
        ],
        tiers: [
          {
            key: "demand",
            category: "demand",
            categoryLabel: "活期存款",
            termLabel: "",
            label: "活期存款",
            autoApply: true,
            listedRate: 0.0005,
          },
          {
            key: "term_1y",
            category: "term",
            categoryLabel: "定期存款",
            termLabel: "1年",
            label: "定期存款（1年）",
            autoApply: false,
            listedRate: 0.0095,
          },
        ],
        ratesStale: false,
        links: [],
        linkGroups: [],
      };
    if (method === "deposit.classify_source")
      return {
        kind: "tb",
        scores: { je: 1, tb: 10 },
        headers: inspection.headers,
        preview: inspection.preview,
        sheet: "TB",
        headerRow: 1,
        headerDepth: 1,
      };
    if (method === "deposit.classify_source_llm") return { kind: "tb" };
    if (method === "deposit.inspect_tb") return inspection;
    throw new Error(`unexpected ${method}`);
  });
});
afterEach(cleanup);

it("历史任务恢复后重新识别完整预览，返回输入文件不白屏", async () => {
  publishTaskRestore({
    jobId: "history-deposit",
    toolId: "deposit_interest",
    method: "deposit.calculate",
    params: {
      tbSource: { inputPath: "fixture-tb.xlsx", sheet: "TB", headerRow: 1, headerDepth: 1 },
      tbMapping: mapping,
      accountRoles: { [bank]: "deposit" },
      reportEnd: "2025-12-31",
    },
    missingPaths: [],
    authorizedPathCount: 1,
  });
  render(<DepositInterestPage tool={tool} />);
  await waitFor(() =>
    expect(mock.engineCall).toHaveBeenCalledWith("deposit.inspect_tb", {
      source: { inputPath: "fixture-tb.xlsx", sheet: "TB", headerRow: 1, headerDepth: 1 },
    }),
  );
  expect(await screen.findByText("TB 文件预览与字段映射")).toBeVisible();
  expect(screen.getByText("历史任务源文件已重新识别，请复核映射后继续。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^2 科目与利率确认/ }));
  fireEvent.click(screen.getByRole("button", { name: /^1 上传与识别/ }));
  expect(screen.getByText("TB 文件预览与字段映射")).toBeVisible();
});

it("连续恢复两条历史任务时忽略先前较慢的识别结果", async () => {
  let finishFirst: ((value: typeof inspection) => void) | undefined;
  mock.engineCall.mockImplementation(async (method: string, params: unknown) => {
    if (method === "deposit.rate_tiers") return { categories: [], tiers: [], links: [], linkGroups: [] };
    if (method === "deposit.inspect_tb") {
      const path = (params as { source: { inputPath: string } }).source.inputPath;
      if (path === "old.xlsx")
        return new Promise<typeof inspection>((resolve) => { finishFirst = resolve; });
      return { ...inspection, sheet: "NEW", sheets: ["NEW"] };
    }
    throw new Error(`unexpected ${method}`);
  });
  const restore = (path: string) => ({
    jobId: path,
    toolId: "deposit_interest",
    method: "deposit.calculate",
    params: { tbSource: { inputPath: path, sheet: "TB", headerRow: 1, headerDepth: 1 }, tbMapping: mapping },
    missingPaths: [],
    authorizedPathCount: 1,
  });
  publishTaskRestore(restore("old.xlsx"));
  render(<DepositInterestPage tool={tool} />);
  await waitFor(() => expect(finishFirst).toBeDefined());
  act(() => publishTaskRestore(restore("new.xlsx")));
  expect(await screen.findByRole("button", { name: "new.xlsx" })).toBeVisible();
  await act(async () => { finishFirst?.(inspection); });
  expect(screen.getByRole("button", { name: "new.xlsx" })).toBeVisible();
  expect(screen.queryByText("old.xlsx")).not.toBeInTheDocument();
});

/** 三步导引：科目与利率在第二步、测算按钮在第三步。步骤按钮的可访问名带序号
 *  （「2 科目与利率确认」），走完再回看时序号变成「✓」——两种都要认；
 *  按开头锚定是为了避开「下一步：测算与底稿」这类导航按钮（撞名会直接抛错）。 */
const STEP2 = /^(?:2|✓)\s*科目与利率确认/;
const STEP3 = /^3\s*测算与底稿/;
const goToStep = (label: RegExp) =>
  fireEvent.click(screen.getByRole("button", { name: label }));

describe("存款科目手工分类请求", () => {
  it("未上传 TB 时给出明确状态且底部主按钮禁用", () => {
    render(<DepositInterestPage tool={tool} />);
    expect(
      screen.getByRole("region", { name: "准备存款利息资料" }),
    ).toBeVisible();
    // 底部主按钮设防：没上传 TB 时禁用并给出浅色提示；
    // 步骤条第二步不受影响（参考资料设计，允许直接点进去）。
    expect(
      screen.getByRole("button", { name: "下一步：科目与利率确认" }),
    ).toBeDisabled();
    expect(
      screen.getByText("先加入科目余额表（TB）后可继续下一步。"),
    ).toBeVisible();
  });
  it("自动匹配错误后可直接更换 TB Excel，并按 TB 重新自动识别", async () => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "拖放或选择 TB、序时账文件（可同时选择）",
      }),
    );
    await screen.findByRole("button", { name: "fixture-tb.xlsx" });
    mock.pickPath.mockResolvedValueOnce("manual-tb.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "fixture-tb.xlsx" }));
    await waitFor(() =>
      expect(mock.engineCall).toHaveBeenCalledWith("deposit.inspect_tb", {
        source: {
          inputPath: "manual-tb.xlsx",
          sheet: "",
          headerRow: 0,
          headerDepth: 0,
        },
      }),
    );
    expect(await screen.findByText("manual-tb.xlsx")).toBeVisible();
  });
  it("真实页面区分默认excluded和手工排除，并支持撤销手工选择", async () => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "拖放或选择 TB、序时账文件（可同时选择）",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: STEP2 })).not.toBeDisabled(),
    );
    expect(mock.engineCall).toHaveBeenCalledWith("deposit.inspect_tb", {
      source: {
        inputPath: "fixture-tb.xlsx",
        sheet: "TB",
        headerRow: 0,
        headerDepth: 0,
      },
    });
    goToStep(STEP2);
    const leafInput = await screen.findByRole("combobox", {
      name: `${leaf}的分类`,
    });
    expect(mock.engineCall).not.toHaveBeenCalledWith(
      "deposit.classify_source_llm",
      expect.anything(),
    );
    // 科目确认只列末级科目：父级 6603 不再出现，利息收入类末级直接可见。
    expect(
      screen.queryByRole("combobox", { name: `${parent}的分类` }),
    ).not.toBeInTheDocument();
    expect(leafInput).toHaveValue("");
    expect((leafInput as HTMLSelectElement).selectedOptions[0]).toHaveTextContent("不参与测算");
    expect((leafInput as HTMLSelectElement).selectedOptions[0]).not.toHaveTextContent("自动");
    // 存款类型与分类同卡内联展示。
    expect(
      screen.getByRole("combobox", { name: `${bank}的存款类型` }),
    ).toBeVisible();
    expect(screen.queryByText("内置挂牌利率可能已过期")).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("combobox", { name: `${bank}的分类` }),
      { target: { value: "cash_on_hand" } },
    );
    expect(screen.queryByRole("combobox", { name: `${bank}的存款类型` })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: `${bank}的分类` }).closest("label")?.querySelector(".deposit-account-na")).toHaveTextContent("不适用");
    fireEvent.change(
      screen.getByRole("combobox", { name: `${bank}的分类` }),
      { target: { value: "" } },
    );
    fireEvent.change(leafInput, { target: { value: "interest_income" } });
    fireEvent.change(
      screen.getByRole("combobox", { name: `${bank}的存款类型` }),
      {
        target: { value: "term" },
      },
    );
    goToStep(STEP3);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    expect(mock.jobStart.mock.calls[0][1]).toMatchObject({
      accountRoles: { [bank]: "deposit", [leaf]: "interest_income" },
      accountRoleOverrides: { [leaf]: "interest_income" },
      accountTierOverrides: { [bank]: "term_1y" },
    });
    expect(
      mock.jobStart.mock.calls[0][1].accountRoleOverrides,
    ).not.toHaveProperty(parent);
    act(() => mock.event?.(complete));
    goToStep(STEP2);
    // 切换步骤会卸载重挂这张卡片，先前抓的引用已脱离文档，必须重新查。
    fireEvent.change(screen.getByRole("combobox", { name: `${leaf}的分类` }), {
      target: { value: "excluded" },
    });
    goToStep(STEP3);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledTimes(2));
    expect(mock.jobStart.mock.calls[1][1].accountRoleOverrides).toEqual({
      [leaf]: "excluded",
    });
    act(() => mock.event?.(complete));
    goToStep(STEP2);
    fireEvent.change(screen.getByRole("combobox", { name: `${leaf}的分类` }), {
      target: { value: "" },
    });
    goToStep(STEP3);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledTimes(3));
    expect(mock.jobStart.mock.calls[2][1].accountRoleOverrides).toEqual({});
  });
});

/** 手填利率的回归：受控输入若每敲一个字符就"数字→文本"来回转，
 *  敲到「0.0」时会被改写回「0」，小数点连着后面的位数一起被吞，
 *  用户永远填不进 0.05%。编辑期间必须原样保留用户敲的文本。 */
describe("利率手工填写", () => {
  it("逐字符敲 0.05 不会被输入框吞掉小数位，并按 0.0005 提交", async () => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "拖放或选择 TB、序时账文件（可同时选择）",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: STEP2 })).not.toBeDisabled(),
    );
    goToStep(STEP2);
    const box = await screen.findByRole("spinbutton", {
      name: "活期存款的采用利率",
    });
    for (const text of ["0", "0.0", "0.05"]) {
      fireEvent.change(box, { target: { value: text } });
      expect(box).toHaveValue(Number(text));
      expect((box as HTMLInputElement).value).toBe(text);
    }
    goToStep(STEP3);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    expect(mock.jobStart.mock.calls[0][1]).toMatchObject({
      tierRates: { demand: 0.0005 },
    });
  });
});

describe("JE 币种资料提示", () => {
  it("在结果顶部说明 JE 发生额无法按币种分配", async () => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "拖放或选择 TB、序时账文件（可同时选择）",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: STEP2 })).not.toBeDisabled(),
    );
    goToStep(STEP2);
    goToStep(STEP3);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());

    act(() =>
      mock.event?.({
        ...complete,
        result: {
          rows: [
            {
              key: "3110 | 1002013636 银行存款 | ",
              entity: "3110",
              account: "1002013636 银行存款",
              auxiliary: "",
              currency: "USD",
              role: "deposit",
              tier: "demand",
              tierLabel: "活期存款",
              category: "demand",
              termLabel: "",
              tierMatchedBy: "默认按活期",
              rateSource: "活期挂牌默认值",
              annualRate: 0.0005,
              rateResolved: true,
              rateWarning: "",
              openingBalance: 100,
              tbClosingBalance: 100,
              derivedClosingBalance: 100,
              reconciliationDiff: 0,
              averageBalance: 100,
              calculatedInterest: 0.05,
              months: [],
              status: "待复核",
              note: "",
            },
          ],
          summary: {
            jeCurrencyAllocationWarning:
              "JE 未提供或未映射币种字段，分币种的年末余额（JE推导）仅供参考。",
          },
        },
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "JE 发生额无法按币种分配",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "分币种的年末余额（JE推导）仅供参考",
    );
  });
});
