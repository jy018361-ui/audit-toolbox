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

/** 三步导引：科目与利率在第二步、测算按钮在第三步。步骤按钮的可访问名带序号
 *  （「2 科目与利率确认」），走完再回看时序号变成「✓」——两种都要认；
 *  按开头锚定是为了避开「下一步：测算与底稿」这类导航按钮（撞名会直接抛错）。 */
const STEP2 = /^(?:2|✓)\s*科目与利率确认/;
const STEP3 = /^3\s*测算与底稿/;
const goToStep = (label: RegExp) =>
  fireEvent.click(screen.getByRole("button", { name: label }));

describe("存款科目手工分类请求", () => {
  it("披露识别与复核联网边界并提供必需资料说明", () => {
    render(<DepositInterestPage tool={tool} />);
    expect(
      screen.getByRole("complementary", { name: "测算默认在本机完成" }),
    ).toHaveAttribute("data-mode", "network-assisted");
    expect(
      screen.getByRole("region", { name: "准备存款利息资料" }),
    ).toBeVisible();
    expect(screen.getByText(/TB 必传；JE 选传/)).toBeVisible();
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
    await screen.findByRole("button", { name: "更换 Excel" });
    mock.pickPath.mockResolvedValueOnce("manual-tb.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "更换 Excel" }));
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
    const parentInput = await screen.findByRole("combobox", {
      name: `${parent}的分类`,
    });
    expect(mock.engineCall).toHaveBeenCalledWith(
      "deposit.classify_source_llm",
      expect.objectContaining({ payload: expect.any(Object) }),
    );
    const leafInput = screen.getByRole("combobox", { name: `${leaf}的分类` });
    expect(leafInput).toHaveValue("");
    fireEvent.change(parentInput, { target: { value: "interest_income" } });
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
      accountRoles: { [parent]: "interest_income", [leaf]: "excluded" },
      accountRoleOverrides: { [parent]: "interest_income" },
      accountTierOverrides: { [bank]: "term_1y" },
    });
    expect(
      mock.jobStart.mock.calls[0][1].accountRoleOverrides,
    ).not.toHaveProperty(leaf);
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
      [parent]: "interest_income",
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
    expect(mock.jobStart.mock.calls[2][1].accountRoleOverrides).toEqual({
      [parent]: "interest_income",
    });
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
