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
import { within } from "@testing-library/react";
import {
  DepositInterestPage,
  depositCatalogMappingKey,
} from "./DepositInterestPage";
import { publishTaskRestore } from "./restore";
import type { JobEvent, ToolManifest } from "./types";
import * as ledgerMapping from "./ledgerMapping";

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
  mock.engineCall.mockImplementation(
    async (method: string, params?: unknown) => {
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
    },
  );
});
let auxiliarySpy: { mockRestore(): void } | undefined;
afterEach(() => { cleanup(); auxiliarySpy?.mockRestore(); auxiliarySpy = undefined; });

it("历史任务恢复后重新识别完整预览，返回输入文件不白屏", async () => {
  publishTaskRestore({
    jobId: "history-deposit",
    toolId: "deposit_interest",
    method: "deposit.calculate",
    params: {
      tbSource: {
        inputPath: "fixture-tb.xlsx",
        sheet: "TB",
        headerRow: 1,
        headerDepth: 1,
      },
      tbMapping: mapping,
      accountRoles: { [bank]: "deposit" },
      reportEnd: "2025-12-31",
    },
    missingPaths: [],
    authorizedPathCount: 1,
  });
  render(<DepositInterestPage tool={tool} />);
  await waitFor(() =>
    expect(mock.engineCall).toHaveBeenCalledWith(
      "deposit.inspect_tb",
      expect.objectContaining({
        source: {
          inputPath: "fixture-tb.xlsx",
          sheet: "TB",
          headerRow: 1,
          headerDepth: 1,
        },
      }),
    ),
  );
  expect(await screen.findByText("TB 文件预览与字段映射")).toBeVisible();
  expect(
    screen.getByText("历史任务源文件已重新识别，请复核映射后继续。"),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^2 科目与利率确认/ }));
  fireEvent.click(screen.getByRole("button", { name: /^1 上传与识别/ }));
  expect(screen.getByText("TB 文件预览与字段映射")).toBeVisible();
});

it("连续恢复两条历史任务时忽略先前较慢的识别结果", async () => {
  let finishFirst: ((value: typeof inspection) => void) | undefined;
  mock.engineCall.mockImplementation(
    async (method: string, params: unknown) => {
      if (method === "deposit.rate_tiers")
        return { categories: [], tiers: [], links: [], linkGroups: [] };
      if (method === "deposit.inspect_tb") {
        const path = (params as { source: { inputPath: string } }).source
          .inputPath;
        if (path === "old.xlsx")
          return new Promise<typeof inspection>((resolve) => {
            finishFirst = resolve;
          });
        return { ...inspection, sheet: "NEW", sheets: ["NEW"] };
      }
      throw new Error(`unexpected ${method}`);
    },
  );
  const restore = (path: string) => ({
    jobId: path,
    toolId: "deposit_interest",
    method: "deposit.calculate",
    params: {
      tbSource: { inputPath: path, sheet: "TB", headerRow: 1, headerDepth: 1 },
      tbMapping: mapping,
    },
    missingPaths: [],
    authorizedPathCount: 1,
  });
  publishTaskRestore(restore("old.xlsx"));
  render(<DepositInterestPage tool={tool} />);
  await waitFor(() => expect(finishFirst).toBeDefined());
  act(() => publishTaskRestore(restore("new.xlsx")));
  expect(await screen.findByRole("button", { name: "new.xlsx" })).toBeVisible();
  await act(async () => {
    finishFirst?.(inspection);
  });
  expect(screen.getByRole("button", { name: "new.xlsx" })).toBeVisible();
  expect(screen.queryByText("old.xlsx")).not.toBeInTheDocument();
});

/** 三步导引：科目与利率在第二步、测算按钮在第三步。步骤按钮的可访问名带序号
 *  （「2 科目与利率确认」），走完再回看时序号变成「✓」——两种都要认；
 *  按开头锚定是为了避开「下一步：测算与底稿」这类导航按钮（撞名会直接抛错）。 */
const STEP2 = /^(?:2|✓)\s*科目与利率确认/;
const STEP3 = /^3\s*测算与底稿/;
const STEP1 = /^1\s*上传与识别/;
const goToStep = (label: RegExp) =>
  fireEvent.click(screen.getByRole("button", { name: label }));

describe("快速任务完成早于启动返回", () => {
  async function enterCalculation() {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(screen.getByRole("button", {
      name: "拖放或选择 TB、序时账文件（可同时选择）",
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: STEP2 })).toBeEnabled());
    goToStep(STEP2);
    goToStep(STEP3);
  }

  it("预览完成后立即导出，提前到达的完成事件仍展示文件并停止转圈", async () => {
    mock.jobStart.mockResolvedValueOnce("preview-job");
    await enterCalculation();
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    act(() => mock.event?.({ ...complete, jobId: "preview-job", message: "旧预览完成" }));
    expect(screen.getByRole("button", { name: "生成 Excel 底稿" })).toBeEnabled();

    let resolveStart!: (id: string) => void;
    mock.jobStart.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveStart = resolve;
    }));
    fireEvent.click(screen.getByRole("button", { name: "生成 Excel 底稿" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledTimes(2));
    // 新任务不能继续显示上一轮的完成状态。
    expect(screen.queryByText("旧预览完成")).not.toBeInTheDocument();
    act(() => {
      mock.event?.({ ...complete, jobId: "other-job", message: "其他任务完成" });
      mock.event?.({
        ...complete, jobId: "export-job", message: "导出完成",
        result: { rows: [], outputPaths: ["C:/output/存款底稿.xlsx"] },
      });
      mock.event?.({ ...complete, jobId: "export-job", phase: "running", message: "迟到进度" });
      mock.event?.({ ...complete, jobId: "export-job", toolId: "loan_interest", message: "其他工具完成" });
    });
    expect(screen.getByRole("button", { name: "生成 Excel 底稿" })).toBeDisabled();
    await act(async () => resolveStart("export-job"));
    await waitFor(() => expect(screen.getByRole("button", { name: "生成 Excel 底稿" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "测算预览" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "打开 Excel 底稿" })).toBeVisible();
    expect(screen.getByText("导出完成")).toBeVisible();
    expect(screen.queryByText("其他任务完成")).not.toBeInTheDocument();
    expect(screen.queryByText("迟到进度")).not.toBeInTheDocument();
    expect(document.querySelector(".fx-actions .busy-spinner")).toBeNull();
  });

  it.each(["failed", "cancelled"])("启动返回前收到 %s 也恢复按钮", async (phase) => {
    await enterCalculation();
    mock.jobStart.mockImplementationOnce(async () => {
      mock.event?.({
        ...complete, jobId: "fast-terminal", phase,
        message: phase === "failed" ? "底稿生成失败" : "任务已取消",
        result: undefined,
      });
      return "fast-terminal";
    });
    fireEvent.click(screen.getByRole("button", { name: "生成 Excel 底稿" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "生成 Excel 底稿" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "测算预览" })).toBeEnabled();
    expect(document.querySelector(".fx-actions .busy-spinner")).toBeNull();
  });
});

it("同码银行先选择JE汇总，再填写统一利率，参数与选择一致", async () => {
  const original = mock.engineCall.getMockImplementation()!;
  const groups = [{entity:"默认主体",accountCode:"1002",names:["银行甲","银行乙"],canUseJe:true}];
  const summaryAccount = "1002 存款科目汇总（明细无法衔接）";
  mock.pickPath.mockResolvedValue(["fixture-tb.xlsx","fixture-je.xlsx"]);
  mock.engineCall.mockImplementation(async(method:string, p:Record<string,unknown>) => {
    if (method === "deposit.classify_source") {
      const isJe = (p.source as {inputPath:string}).inputPath.endsWith("je.xlsx");
      return {...inspection, kind:isJe ? "je":"tb", confidence:1, scores:isJe?{tb:1,je:10}:{tb:10,je:1},sheet:isJe?"JE":"TB"};
    }
    if (method === "deposit.inspect_je") return {...inspection, sheet:"JE",sheets:["JE"],headers:["科目编码","科目名称","日期","借方","贷方","凭证号"],suggestedMapping:{accountCode:"科目编码",accountName:"科目名称",date:"日期",functionalDebit:"借方",functionalCredit:"贷方",id:"凭证号"}};
    if (method === "deposit.account_currencies") return {
      matchingFallbackCandidates:groups,
      rows:[{key:"汇总-key",entity:"默认主体",account:p.matchingFallbackMode === "accountJe" ? summaryAccount : bank,auxiliary:"",currency:"本位币合并",role:"deposit",openingBalance:300,closingBalance:400}],
    };
    if (method === "deposit.matching_fallback") return {matchingFallbackGroups:groups};
    return original(method,p);
  });
  render(<DepositInterestPage tool={tool}/>);
  fireEvent.click(screen.getByRole("button",{name:"拖放或选择 TB、序时账文件（可同时选择）"}));
  await screen.findByText("已识别：JE 序时账");
  await waitFor(()=>expect(screen.getByRole("button",{name:"下一步：科目与利率确认"})).toBeEnabled());
  fireEvent.click(screen.getByRole("button",{name:"下一步：科目与利率确认"}));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("button",{name:"按所选口径继续"})).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("radio",{name:/合并同码存款/}));
  fireEvent.click(within(dialog).getByRole("button",{name:"按所选口径继续"}));
  const rate = await screen.findByRole("spinbutton",{name:`默认主体 / ${summaryAccount}的统一年利率`});
  goToStep(STEP3);
  expect(screen.getByText("请先为存款科目汇总填写统一年利率。")).toBeVisible();
  expect(mock.jobStart).not.toHaveBeenCalled();
  fireEvent.change(rate,{target:{value:"3"}});
  goToStep(STEP3);
  fireEvent.click(screen.getByRole("button",{name:"测算预览"}));
  await waitFor(()=>expect(mock.jobStart).toHaveBeenCalledWith("deposit.preview",expect.objectContaining({matchingFallbackMode:"accountJe",matchingFallbackGroups:groups,requireMatchingFallbackChoice:true,rateOverrides:{"汇总-key":{annualRate:0.03}}})));
});

it("只有科目身份映射变化才需要重建科目目录", () => {
  expect(
    depositCatalogMappingKey({
      accountCode: "编码",
      closingFunctionalAmount: "期末",
    }),
  ).toBe(
    depositCatalogMappingKey({
      accountCode: "编码",
      closingFunctionalAmount: "期末余额",
    }),
  );
  expect(depositCatalogMappingKey({ accountCode: "编码" })).not.toBe(
    depositCatalogMappingKey({ accountCode: "科目编码" }),
  );
});

async function openClassificationWorkspace(nativeRows = false, ambiguous = false) {
  auxiliarySpy = vi.spyOn(ledgerMapping, "verifyAuxiliaryLink").mockImplementation(async request => {
    try { return await mock.engineCall("ledger.auxiliary_link", request); }
    catch { return null; }
  });
  const original = mock.engineCall.getMockImplementation()!;
  const extra = Array.from({ length: 10 }, (_, i) => `199${i} 待分类账户${i}`);
  const accounts = [bank, ...extra];
  const roles = Object.fromEntries(accounts.map(account => [account, account === bank && !nativeRows ? "deposit" : "excluded"]));
  const tb = {
    ...inspection, accounts, accountsLeaf: accounts, suggestedAccountRoles: roles,
    headers: [...inspection.headers, "辅助核算"],
    preview: inspection.preview.map(row => [...row, ""]),
    suggestedMapping: { ...mapping, auxiliary: "辅助核算" },
    ...(nativeRows ? { reviewAccounts: accounts.map(account => ({
      entity: "默认主体", account, auxiliary: "", currency: "",
      suggestedDepositRole: account === bank ? "deposit" : "excluded",
    })) } : {}),
  };
  const je = { ...inspection, sheet: "JE", sheets: ["JE"], headers: ["科目编码", "科目名称", "日期", "借方", "贷方", "凭证号"], suggestedMapping: {
    accountCode: "科目编码", accountName: "科目名称", date: "日期",
    functionalDebit: "借方", functionalCredit: "贷方", id: "凭证号",
  } };
  const groups = ambiguous ? [{ entity: "默认主体", accountCode: "1002", names: ["银行甲", "银行乙"], canUseJe: true }] : [];
  mock.pickPath.mockResolvedValue(["tb.xlsx", "je.xlsx"]);
  mock.engineCall.mockImplementation(async (method: string, p: Record<string, unknown>) => {
    if (method === "ledger.forms") return [];
    if (method === "ledger.review_pair_mapping") return { tbChanges: [], jeChanges: [] };
    if (method === "deposit.classify_source") return {
      ...inspection, kind: (p.source as { inputPath: string }).inputPath.startsWith("je") ? "je" : "tb",
      scores: { tb: 10, je: 1 },
    };
    if (method === "deposit.inspect_tb") return tb;
    if (method === "deposit.inspect_je") return je;
    if (method === "ledger.currency_link") return { required: false, verified: true, missingCurrencies: [], affectedGroupCount: 0 };
    if (method === "ledger.auxiliary_link") return { tbAuxMapped: true, status: "verified", planKey: "initial-plan", groups: [], warnings: [] };
    if (method === "deposit.account_currencies") return { rows: p.matchingFallbackMode === "accountJe"
      ? [{ key: "summary-row", entity: "默认主体", account: "1002 存款科目汇总", auxiliary: "", currency: "", role: "deposit" }]
      : accounts.map(account => ({ key: `${account}-row`, entity: "默认主体", account, auxiliary: "", currency: "", role: account === bank ? "deposit" : "excluded" })),
    };
    if (method === "deposit.matching_fallback") return { matchingFallbackGroups: groups };
    return original(method, p);
  });
  render(<DepositInterestPage tool={tool} />);
  fireEvent.click(screen.getByRole("button", { name: "拖放或选择 TB、序时账文件（可同时选择）" }));
  await screen.findByText("已识别：JE 序时账");
  fireEvent.click(screen.getByRole("button", { name: "下一步：科目与利率确认" }));
  await screen.findByRole("combobox", { name: `${extra[0]}的分类` });
  await waitFor(() => expect(mock.engineCall).toHaveBeenCalledWith("deposit.account_currencies", expect.objectContaining({ auxiliaryPlan: expect.objectContaining({ planKey: "initial-plan" }) })));
  await act(async () => {});
  return { extra, groups };
}

describe("存款科目手工分类请求", () => {
  it.each([false, true])("连续分类不读取账表，第三步统一使用最新分类与原利率（明细行：%s）", async nativeRows => {
    const { extra } = await openClassificationWorkspace(nativeRows);
    const rate = screen.getByRole("spinbutton", { name: `${bank}的年利率` });
    fireEvent.change(rate, { target: { value: "1.25" } });
    fireEvent.blur(rate);
    const before = mock.engineCall.mock.calls.length;
    for (const [i, account] of extra.entries()) {
      await act(async () => fireEvent.change(screen.getByRole("combobox", { name: `${account}的分类` }), { target: { value: i === 9 ? "interest_income" : "deposit" } }));
      expect(mock.engineCall.mock.calls).toHaveLength(before);
    }
    expect(screen.getByText("计息科目 10")).toBeVisible();
    expect(screen.getByText("科目分类已记录，将在下一步测算时生效。")).toBeVisible();
    expect(mock.jobStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "下一步：测算与底稿" }));
    expect(mock.engineCall.mock.calls).toHaveLength(before);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    expect(mock.engineCall.mock.calls.filter(([method]) => method === "deposit.matching_fallback")).toHaveLength(1);
    const request = mock.jobStart.mock.calls[0][1];
    expect(request).not.toHaveProperty("auxiliaryPlan");
    expect(request.rateOverrides).toEqual({ [`${bank}-row`]: { annualRate: 0.0125 } });
    for (const [i, account] of extra.entries()) {
      const key = nativeRows ? JSON.stringify(["", account, "", ""]) : account;
      expect(request.accountReviewRoles[key]).toBe(i === 9 ? "interest_income" : "deposit");
    }
  });

  it("测算阶段衔接检查失败可重试，旧分类不会启动任务", async () => {
    const { extra } = await openClassificationWorkspace();
    fireEvent.change(screen.getByRole("combobox", { name: `${extra[0]}的分类` }), { target: { value: "deposit" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步：测算与底稿" }));
    mock.engineCall.mockRejectedValueOnce(new Error("检查失败，请重试"));
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await screen.findByText("检查失败，请重试");
    expect(mock.jobStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
  });

  it("确认表回传分类和利率仅记录，测算时才检查并使用回传值", async () => {
    const { extra } = await openClassificationWorkspace(true);
    const original = mock.engineCall.getMockImplementation()!;
    const key = JSON.stringify(["", extra[0], "", ""]);
    mock.engineCall.mockImplementation(async (method: string, request: Record<string, unknown>) => {
      if (method === "account_confirmation.import") return { rows: [{
        key, values: [extra[0], "银行存款（计息）", "活期存款", "", "1.5"],
      }] };
      return original(method, request);
    });
    mock.pickPath.mockResolvedValueOnce("确认表.xlsx");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const before = mock.engineCall.mock.calls.length;
    try {
      fireEvent.click(screen.getByRole("button", { name: "回传科目确认表" }));
      await screen.findByText("已回传 1 行，页面已更新；请继续检查并测算。");
    } finally { confirm.mockRestore(); }
    expect(mock.engineCall.mock.calls.slice(before).map(([method]) => method)).toEqual(["account_confirmation.import"]);
    expect(mock.jobStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "下一步：测算与底稿" }));
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledWith("deposit.preview", expect.objectContaining({
      accountReviewRoles: expect.objectContaining({ [key]: "deposit" }),
      accountRateOverrides: { [extra[0]]: 0.015 },
    })));
  });

  it.each(["accountJe", "tbAverage"])("新增分类的衔接口径及%s利率在第三步处理", async choice => {
    const { extra, groups } = await openClassificationWorkspace(false, true);
    fireEvent.change(screen.getByRole("combobox", { name: `${extra[0]}的分类` }), { target: { value: "deposit" } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一步：测算与底稿" }));
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    const dialog = await screen.findByRole("dialog");
    expect(mock.jobStart).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("radio", { name: choice === "accountJe" ? /合并同码存款/ : /保留 TB 明细/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "按所选口径继续" }));
    expect(screen.getByRole("button", { name: "测算预览" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    if (choice === "accountJe") {
      const rate = await screen.findByRole("spinbutton", { name: "默认主体 / 1002 存款科目汇总的统一年利率" });
      expect(mock.jobStart).not.toHaveBeenCalled();
      fireEvent.change(rate, { target: { value: "3" } });
      fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    }
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledWith("deposit.preview", expect.objectContaining({ matchingFallbackMode: choice, matchingFallbackGroups: groups })));
  });

  it("利率档位加载失败不再静默，会显示可恢复警告", async () => {
    mock.engineCall.mockRejectedValueOnce(new Error("网络不可用"));
    render(<DepositInterestPage tool={tool} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "存款利率档位暂时加载失败",
    );
  });

  it("未上传 TB 时保留空状态、删除重复提示且底部主按钮禁用", () => {
    render(<DepositInterestPage tool={tool} />);
    expect(
      screen.getByRole("region", { name: "准备存款利息资料" }),
    ).toBeVisible();
    // 底部主按钮设防：没上传 TB 时禁用；空状态已经说明上传入口，
    // 不再在按钮旁重复一遍门禁提示。
    // 步骤条第二步不受影响（参考资料设计，允许直接点进去）。
    expect(
      screen.getByRole("button", { name: "下一步：科目与利率确认" }),
    ).toBeDisabled();
    expect(screen.queryByText(/先加入科目余额表/)).not.toBeInTheDocument();
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
  it("人工补正科目映射后按确认映射刷新完整科目目录", async () => {
    const added = "100201 新补出的银行账户";
    mock.engineCall.mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "deposit.rate_tiers")
          return { categories: [], tiers: [], links: [], linkGroups: [] };
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
        if (method === "deposit.inspect_tb") {
          const confirmed = (params as { mapping?: typeof mapping }).mapping;
          if (confirmed?.accountCode === "科目编码") {
            return {
              ...inspection,
              accounts: [...inspection.accounts, added],
              accountsLeaf: [...inspection.accountsLeaf, added],
              suggestedMapping: confirmed,
              suggestedAccountRoles: {
                ...inspection.suggestedAccountRoles,
                [added]: "deposit",
              },
            };
          }
          return inspection;
        }
        throw new Error(`unexpected ${method}`);
      },
    );
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "拖放或选择 TB、序时账文件（可同时选择）",
      }),
    );
    await screen.findByText("TB 文件预览与字段映射");

    const accountCodeSelect = screen
      .getAllByRole("combobox")
      .find(
        (element) => (element as HTMLSelectElement).value === "accountCode",
      );
    expect(accountCodeSelect).toBeDefined();
    fireEvent.change(accountCodeSelect!, { target: { value: "" } });
    await waitFor(() =>
      expect(mock.engineCall).toHaveBeenCalledWith(
        "deposit.inspect_tb",
        expect.objectContaining({
          mapping: expect.not.objectContaining({ accountCode: "科目编码" }),
        }),
      ),
    );
    const clearedSelect = screen
      .getAllByRole("combobox")
      .find((element) =>
        Array.from((element as HTMLSelectElement).options).some(
          (option) => option.value === "accountCode",
        ),
      );
    fireEvent.change(clearedSelect!, { target: { value: "accountCode" } });
    await waitFor(() =>
      expect(mock.engineCall).toHaveBeenCalledWith(
        "deposit.inspect_tb",
        expect.objectContaining({
          mapping: expect.objectContaining({ accountCode: "科目编码" }),
        }),
      ),
    );

    goToStep(STEP2);
    expect(
      await screen.findByRole("combobox", { name: `${added}的分类` }),
    ).toBeVisible();
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
    }, "fixture-tb.xlsx / TB");
    goToStep(STEP2);
    const leafInput = await screen.findByRole("combobox", {
      name: `${leaf}的分类`,
    });
    expect(mock.engineCall).not.toHaveBeenCalledWith(
      "deposit.classify_source_llm",
      expect.anything(),
    );
    expect(mock.engineCall).not.toHaveBeenCalledWith(
      "ledger.review_mapping",
      expect.anything(),
      expect.anything(),
    );
    // 科目确认只列末级科目：父级 6603 不再出现，利息收入类末级直接可见。
    expect(
      screen.queryByRole("combobox", { name: `${parent}的分类` }),
    ).not.toBeInTheDocument();
    expect(leafInput).toHaveValue("");
    expect(
      (leafInput as HTMLSelectElement).selectedOptions[0],
    ).toHaveTextContent("不参与测算");
    expect(
      (leafInput as HTMLSelectElement).selectedOptions[0],
    ).not.toHaveTextContent("自动");
    // 存款类型与分类同卡内联展示。
    expect(
      screen.getByRole("combobox", { name: `${bank}的存款类型` }),
    ).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "科目" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "分类" })).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: "存款类型" }),
    ).toBeVisible();
    expect(
      screen.queryByText("内置挂牌利率可能已过期"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("计息科目 1")).toBeVisible();
    expect(
      screen.getByText(/页面上限为 20%/),
    ).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: `${bank}的分类` }), {
      target: { value: "cash_on_hand" },
    });
    expect(
      screen.queryByRole("combobox", { name: `${bank}的存款类型` }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByRole("combobox", { name: `${bank}的分类` })
        .closest("tr")
        ?.querySelector(".deposit-account-na"),
    ).toHaveTextContent("不适用");
    fireEvent.change(screen.getByRole("combobox", { name: `${bank}的分类` }), {
      target: { value: "" },
    });
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

/** 第二步直接列示余额：逐户行按主体/币种各显各的期初与期末；
 *  TB 没有年初列的户期初显示「—」（测算阶段倒推），界面不得编造 0。 */
describe("第二步余额列示", () => {
  it("余额列按户显示期初与期末，缺年初列时留空", async () => {
    mock.engineCall.mockImplementation(async (method: string) => {
      if (method === "deposit.rate_tiers")
        return {
          categories: [
            { key: "demand", label: "活期存款", terms: [{ key: "demand", label: "" }] },
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
          ],
          ratesStale: false,
          links: [],
          linkGroups: [],
        };
      if (method === "deposit.account_currencies")
        return {
          rows: [
            {
              key: "2000 | 1002",
              entity: "2000",
              account: bank,
              auxiliary: "",
              currency: "本位币合并",
              role: "deposit",
              openingBalance: 1000,
              closingBalance: 2000,
            },
            {
              key: "2002 | 1002",
              entity: "2002",
              account: bank,
              auxiliary: "",
              currency: "本位币合并",
              role: "deposit",
              openingBalance: null,
              closingBalance: 3000,
            },
          ],
          multiCurrencyAccounts: [],
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
      if (method === "deposit.inspect_tb")
        return {
          ...inspection,
          accountMetrics: {
            [bank]: { opening: 4000, closing: 5000, occurrence: 0 },
          },
        };
      throw new Error(`unexpected ${method}`);
    });
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
    // 轻量逐户清单会替换刚进入页面时的科目级兜底行；等待清单余额出现，
    // 避免抓到随后被卸载的旧 select 节点。
    expect(await screen.findByRole("cell", { name: "1,000" })).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: /^期初余额/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: /^期末余额/ }),
    ).toBeVisible();
    // 有逐户行时按户拆示：2000 户期初 1,000、期末 2,000；2002 户没有
    // 年初列，期初显示「—」，期末 3,000。
    expect(screen.getByRole("cell", { name: "2,000" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "3,000" })).toBeVisible();
    expect(
      screen.getAllByRole("cell", { name: "—" }).length,
    ).toBeGreaterThan(0);
  });
});

/** 手填利率的回归：受控输入若每敲一个字符就"数字→文本"来回转，
 *  敲到「0.0」时会被改写回「0」，小数点连着后面的位数一起被吞，
 *  用户永远填不进 0.05%。编辑期间必须原样保留用户敲的文本。 */
describe("分类前利息发生额", () => {
  it.each([
    [923800.5, "923,800.5"],
    [0, "0"],
    [null, "—"],
  ] as const)("不参与测算时仍展示源发生额 %s，不用余额0替代", async (occurrence, displayed) => {
    const interest = "66030002 财务费用-利息";
    const basis = "已结转·红字冲减费用，按收入计入";
    const original = mock.engineCall.getMockImplementation()!;
    mock.engineCall.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "deposit.inspect_tb") return {
        ...inspection,
        accounts: [bank, interest], accountsLeaf: [bank, interest],
        suggestedAccountRoles: { [bank]: "deposit", [interest]: "excluded" },
        accountMetrics: { [interest]: { opening: 0, closing: 0, occurrence, occurrenceBasis: basis } },
      };
      return original(method, params);
    });
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(screen.getByRole("button", { name: "拖放或选择 TB、序时账文件（可同时选择）" }));
    await waitFor(() => expect(screen.getByRole("button", { name: STEP2 })).not.toBeDisabled());
    goToStep(STEP2);
    const classification = await screen.findByRole("combobox", { name: `${interest}的分类` });
    const sourceCell = () => within(classification.closest("tr")!).getByTitle(basis);
    expect(sourceCell()).toHaveTextContent(displayed);
    expect(classification).toHaveValue("");
    fireEvent.change(classification, { target: { value: "interest_income" } });
    expect(sourceCell()).toHaveTextContent(displayed);
    fireEvent.change(classification, { target: { value: "excluded" } });
    expect(sourceCell()).toHaveTextContent(displayed);
    expect(mock.jobStart).not.toHaveBeenCalled();
  });
});

describe("利率手工填写", () => {
  it("逐字符敲 0.05 不会被输入框吞掉小数位，并按 0.0005 提交", async () => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "拖放或选择 TB、序时账文件（可同时选择）",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: STEP3 })).not.toBeDisabled(),
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
  it.each([false, true])("账面收入基准是否已确认 %s，缺失与真实零值分别展示", async (hasIncome) => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(screen.getByRole("button", { name: "拖放或选择 TB、序时账文件（可同时选择）" }));
    await waitFor(() => expect(screen.getByRole("button", { name: STEP2 })).not.toBeDisabled());
    goToStep(STEP2);
    goToStep(STEP3);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    act(() => mock.event?.({ ...complete, result: { rows: [{
      key: "zero-baseline-bank", entity: "默认主体", account: bank, auxiliary: "", currency: "CNY",
      role: "deposit", tier: "demand", tierLabel: "活期存款", category: "demand", termLabel: "",
      annualRate: 0.005, rateResolved: true, rateProvisional: false,
      openingBalance: 24600, tbClosingBalance: 24600, derivedClosingBalance: 24600,
      reconciliationDiff: 0, averageBalance: 24600, calculatedInterest: 123,
      months: [], status: "已勾稽", note: "",
    }], summary: {
      hasInterestIncomeAccount: hasIncome, bookedInterestIncome: hasIncome ? 0 : null,
      calculatedInterest: 123, difference: hasIncome ? 123 : null, differenceRatio: null,
      reconciliationPassed: false,
    } } }));
    if (hasIncome) {
      expect(await screen.findByText("账面收入为零，差异率不适用")).toBeVisible();
    } else {
      expect(await screen.findByText("无法比较")).toBeVisible();
      expect(screen.getByText("TB 中未识别到利息收入科目")).toBeVisible();
    }
    expect(screen.queryByText("差异率 0.00%")).not.toBeInTheDocument();
  });
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
          outputPaths: ["C:\\output\\存款利息测算.xlsx"],
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
              rateSource: "市场中枢暂估值",
              annualRate: 0.0005,
              rateResolved: true,
              rateProvisional: true,
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
    const resultSearch = screen.getByRole("textbox", {
      name: "搜索科目、辅助户、主体或币种",
    });
    fireEvent.change(resultSearch, { target: { value: "不存在的科目" } });
    expect(screen.getByText("没有符合当前筛选条件的账户。")).toBeVisible();
    fireEvent.change(resultSearch, { target: { value: "1002013636" } });
    expect(screen.queryByText("没有符合当前筛选条件的账户。")).not.toBeInTheDocument();
    const openWorkbook = screen.getByRole("button", {
      name: "打开 Excel 底稿",
    });
    expect(openWorkbook.closest(".deposit-export-done")).not.toBeNull();
    expect(screen.getByText(/黄色“年利率”单元格可直接改写/)).toBeVisible();
  });
});

/** 第二步利率列的行为：默认带出挂牌利率；改写后随测算提交；
 *  换存款类型自动回到新档位默认（本夹具的定期档没有自动利率，应显示待填）。 */
describe("第二步逐户利率列", () => {
  it("默认带出活期挂牌利率，改写提交，换类型后回到新档位默认", async () => {
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

    const rate = (await screen.findByRole("spinbutton", {
      name: `${bank}的年利率`,
    })) as HTMLInputElement;
    expect(rate.value).toBe("0.05");

    // 改写成协议利率 1.25%，测算参数应带上逐户改写（小数口径）。
    fireEvent.change(rate, { target: { value: "1.25" } });
    fireEvent.blur(rate);
    goToStep(STEP3);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    expect(mock.jobStart.mock.calls[0][1]).toMatchObject({
      accountRateOverrides: { [bank]: 0.0125 },
    });
    act(() => mock.event?.(complete));

    // 换成定期存款：手改利率被清掉，利率列回到新档位默认（定期档须手填）。
    goToStep(STEP2);
    // 回到第二步后表格重新挂载，输入框要重新取引用。
    const rateAgain = screen.getByRole("spinbutton", {
      name: `${bank}的年利率`,
    }) as HTMLInputElement;
    expect(rateAgain.value).toBe("1.25");
    fireEvent.change(
      screen.getByRole("combobox", { name: `${bank}的存款类型` }),
      { target: { value: "term" } },
    );
    expect(rateAgain.value).toBe("");
    goToStep(STEP3);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledTimes(2));
    expect(mock.jobStart.mock.calls[1][1]).toMatchObject({
      accountRateOverrides: {},
      accountTierOverrides: { [bank]: "term_1y" },
    });
  });
});

/** 导航栏步骤切换是纯视图跳转：同一输入的币种衔接验证只跑一次，
 *  底部“下一步”与导航入口共用缓存，来回切步骤不再重跑引擎调用。 */
describe("导航步骤切换不重复验证", () => {
  const withBothSources = () => {
    mock.engineCall.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === "deposit.rate_tiers")
          return { categories: [], tiers: [], ratesStale: false, links: [], linkGroups: [] };
        if (method === "deposit.account_currencies")
          return { rows: [], multiCurrencyAccounts: [] };
        if (method === "deposit.classify_source")
          return { kind: "tb", scores: { je: 1, tb: 10 }, headers: inspection.headers, preview: inspection.preview, sheet: "TB", headerRow: 1, headerDepth: 1 };
        if (method === "deposit.classify_source_llm") return { kind: "tb" };
        if (method === "deposit.inspect_tb" || method === "deposit.inspect_je")
          return inspection;
        if (method === "ledger.auxiliary_link")
          return { tbAuxMapped: true, status: "ok", column: null, competingColumns: [], warnings: [], groups: [] };
        if (method === "ledger.currency_link")
          return { status: "ok", required: false, verified: true, affectedGroupCount: 0, missingCurrencies: [] };
        throw new Error(`unexpected ${method}: ${JSON.stringify(params ?? "")}`);
      },
    );
    const currencyMapping = { ...mapping, currency: "币种" };
    publishTaskRestore({
      jobId: "nav-history",
      toolId: "deposit_interest",
      method: "deposit.calculate",
      params: {
        tbSource: { inputPath: "fixture-tb.xlsx", sheet: "TB", headerRow: 1, headerDepth: 1 },
        tbMapping: currencyMapping,
        jeSource: { inputPath: "fixture-je.xlsx", sheet: "TB", headerRow: 1, headerDepth: 1 },
        jeMapping: currencyMapping,
        accountRoles: { [bank]: "deposit" },
        reportEnd: "2025-12-31",
      },
      missingPaths: [],
      authorizedPathCount: 1,
    });
  };
  const currencyLinkCalls = () =>
    mock.engineCall.mock.calls.filter(([m]) => m === "ledger.currency_link")
      .length;

  it("停止币种验证不会报映射错误或放行，重试成功才进入第二步", async () => {
    withBothSources();
    render(<DepositInterestPage tool={tool} />);
    await waitFor(() => expect(mock.engineCall).toHaveBeenCalledWith("deposit.inspect_tb", expect.anything()));
    const original = mock.engineCall.getMockImplementation()!;
    let stop = true;
    mock.engineCall.mockImplementation(async (method, params) => {
      if (method === "ledger.currency_link" && stop) throw Object.assign(new Error("已停止等待：界面已恢复。"), { code: "SYNC_BUSY_ABORTED" });
      return original(method, params);
    });
    goToStep(STEP2);
    expect(await screen.findByText("已停止币种衔接验证，当前映射已保留。")).toBeVisible();
    expect(screen.queryByText(/验证失败|暂时无法验证/)).not.toBeInTheDocument();
    expect(screen.queryByText("逐个核对科目分类（末级明细）")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: STEP2 })).toBeEnabled();
    stop = false;
    goToStep(STEP2);
    expect(await screen.findByText("逐个核对科目分类（末级明细）")).toBeVisible();
    expect(currencyLinkCalls()).toBe(2);
    expect(screen.queryByText(/已停止币种衔接验证/)).not.toBeInTheDocument();
  });

  it("第一步不后台生成账户清单，进入第二步才做轻量准备且不启动测算", async () => {
    withBothSources();
    render(<DepositInterestPage tool={tool} />);
    await waitFor(() =>
      expect(mock.engineCall).toHaveBeenCalledWith(
        "deposit.inspect_tb",
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: STEP2 })).not.toBeDisabled(),
    );
    expect(
      mock.engineCall.mock.calls.some(
        ([method]) => method === "ledger.auxiliary_link",
      ),
    ).toBe(false);
    expect(
      mock.engineCall.mock.calls.filter(
        ([method]) => method === "deposit.account_currencies",
      ),
    ).toHaveLength(0);

    goToStep(STEP2);
    await waitFor(() =>
      expect(
        mock.engineCall.mock.calls.filter(
          ([method]) => method === "deposit.account_currencies",
        ),
      ).toHaveLength(1),
    );
    expect(mock.jobStart).not.toHaveBeenCalled();
  });

  it("来回切换步骤不重跑币种衔接验证", async () => {
    withBothSources();
    render(<DepositInterestPage tool={tool} />);
    await waitFor(() =>
      expect(mock.engineCall).toHaveBeenCalledWith(
        "deposit.inspect_tb",
        expect.anything(),
      ),
    );
    goToStep(STEP2);
    await waitFor(() => expect(currencyLinkCalls()).toBe(1));
    goToStep(STEP1);
    goToStep(STEP2);
    goToStep(STEP1);
    goToStep(STEP2);
    await waitFor(() =>
      expect(screen.getByText("逐个核对科目分类（末级明细）")).toBeVisible(),
    );
    expect(currencyLinkCalls()).toBe(1);
  });
});

/** 引擎下发测算行清单后，第二步按币种拆行，逐币种利率落在引擎行键上，
 *  与第三步逐户改价同键联动。 */
describe("第二步按币种拆行", () => {
  it("多币种账户按 CNY/USD 拆两行，利率改写按引擎行键提交", async () => {
    mock.engineCall.mockImplementation(async (method: string) => {
      if (method === "deposit.rate_tiers") return {
        categories: [
          { key: "demand", label: "活期存款", terms: [{ key: "demand", label: "" }] },
        ],
        tiers: [
          { key: "demand", category: "demand", categoryLabel: "活期存款", termLabel: "", label: "活期存款", autoApply: true, listedRate: 0.0005 },
        ],
        ratesStale: false, links: [], linkGroups: [],
      };
      if (method === "deposit.account_currencies") return {
        rows: [
          { key: "K-CNY", entity: "默认主体", account: bank, auxiliary: "", currency: "CNY", role: "deposit" },
          { key: "K-USD", entity: "默认主体", account: bank, auxiliary: "", currency: "USD", role: "deposit" },
        ],
        multiCurrencyAccounts: [{ account: bank, currencies: ["CNY", "USD"] }],
      };
      if (method === "deposit.classify_source")
        return { kind: "tb", scores: { je: 1, tb: 10 }, headers: inspection.headers, preview: inspection.preview, sheet: "TB", headerRow: 1, headerDepth: 1 };
      if (method === "deposit.classify_source_llm") return { kind: "tb" };
      if (method === "deposit.inspect_tb") return inspection;
      throw new Error(`unexpected ${method}`);
    });
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: "拖放或选择 TB、序时账文件（可同时选择）" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: STEP2 })).not.toBeDisabled());
    goToStep(STEP2);
    const cny = await screen.findByRole("spinbutton", { name: `${bank}（CNY）的年利率` });
    expect(screen.queryByRole("columnheader", { name: "币种" })).not.toBeInTheDocument();
    const usd = screen.getByRole("spinbutton", { name: `${bank}（USD）的年利率` });
    expect(cny).toHaveValue(0.05);
    expect(usd).toHaveValue(0.05);
    fireEvent.change(cny, { target: { value: "1.25" } });
    fireEvent.blur(cny);
    goToStep(STEP3);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    expect(mock.jobStart.mock.calls[0][1]).toMatchObject({
      rateOverrides: { "K-CNY": { annualRate: 0.0125 } },
    });
  });
});

/** 贷方余额弹窗已整体下线：负余额改按月度余额判断计息（引擎侧口径），
 *  界面不再就该口径打扰用户，旧汇总字段下发也不再触发任何弹窗。 */
describe("贷方余额弹窗已下线", () => {
  it("测算完成后不弹贷方余额确认窗", async () => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: "拖放或选择 TB、序时账文件（可同时选择）" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: STEP2 })).not.toBeDisabled());
    goToStep(STEP2);
    goToStep(STEP3);
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    act(() =>
      mock.event?.({
        ...complete,
        result: {
          rows: [],
          summary: {
            creditBalanceCount: 1,
            creditBalanceAccounts: [
              { key: "K1", account: bank, currency: "CNY", closingBalance: -12345.67 },
            ],
          },
        },
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("存款步骤门禁与来源状态", () => {
  it("资产负债表日为空时仍可进入第三步填写，测算时才提示补齐", async () => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "拖放或选择 TB、序时账文件（可同时选择）",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: STEP3 })).not.toBeDisabled(),
    );
    goToStep(STEP2);
    goToStep(STEP3);
    fireEvent.change(screen.getByLabelText("资产负债表日"), {
      target: { value: "" },
    });
    goToStep(STEP2);
    goToStep(STEP3);
    expect(screen.getByLabelText("资产负债表日")).toHaveValue("");
    expect(screen.queryByText("请先确认资产负债表日。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    expect(screen.getByText("请选择资产负债表日。")).toBeVisible();
    expect(mock.jobStart).not.toHaveBeenCalled();
  });

  it("从上传页点击第三步只进入确认页，不能绕过科目与利率确认", async () => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "拖放或选择 TB、序时账文件（可同时选择）",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: STEP3 })).not.toBeDisabled(),
    );
    goToStep(STEP3);
    expect(
      await screen.findByText("请先复核科目分类与利率，再进入测算与底稿。"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: STEP2 })).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(
      screen.queryByRole("button", { name: "测算预览" }),
    ).not.toBeInTheDocument();
  });

  it("更换文件会清空旧科目覆盖，但保留用户手改的资产负债表日", async () => {
    const detailKey = `默认主体\u001f${bank}\u001f旧辅助户`;
    publishTaskRestore({
      jobId: "history-with-detail-overrides",
      toolId: "deposit_interest",
      method: "deposit.calculate",
      params: {
        tbSource: {
          inputPath: "fixture-tb.xlsx",
          sheet: "TB",
          headerRow: 1,
          headerDepth: 1,
        },
        tbMapping: mapping,
        accountRoles: { [bank]: "deposit" },
        accountRoleOverrides: { [leaf]: "interest_income" },
        accountTierOverrides: { [bank]: "term_1y" },
        accountDetailRoleOverrides: { [detailKey]: "other_monetary" },
        accountDetailTierOverrides: { [detailKey]: "term_1y" },
        rateOverrides: { "old-engine-row": { annualRate: 0.0125 } },
        accountRateOverrides: { [detailKey]: 0.0125 },
        reportEnd: "2025-12-31",
      },
      missingPaths: [],
      authorizedPathCount: 1,
    });
    render(<DepositInterestPage tool={tool} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: STEP2 })).not.toBeDisabled(),
    );
    goToStep(STEP2);
    goToStep(STEP3);
    fireEvent.change(screen.getByLabelText("资产负债表日"), {
      target: { value: "2024-09-30" },
    });
    goToStep(STEP1);
    mock.pickPath.mockResolvedValueOnce("replacement-tb.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "fixture-tb.xlsx" }));
    expect(await screen.findByText("replacement-tb.xlsx")).toBeVisible();
    goToStep(STEP2);
    goToStep(STEP3);
    expect(screen.getByLabelText("资产负债表日")).toHaveValue("2024-09-30");
    fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
    await waitFor(() => expect(mock.jobStart).toHaveBeenCalledOnce());
    expect(mock.jobStart.mock.calls[0][1]).toMatchObject({
      accountRoleOverrides: {},
      accountDetailRoleOverrides: {},
      accountTierOverrides: {},
      accountDetailTierOverrides: {},
      rateOverrides: {},
      accountRateOverrides: {},
      reportEnd: "2024-09-30",
    });
  });
});

/** 第二步利率档位表在上方、科目分类表在下方；档位利率单向联动下行：
 *  改档位利率后该类型各户利率跟着改（含清掉手改值），下行手改不回写档位。 */
describe("利率档位单向联动", () => {
  it("改档位利率后对应类型各户利率跟着改，档位表排在科目分类表上方", async () => {
    render(<DepositInterestPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: "拖放或选择 TB、序时账文件（可同时选择）" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: STEP2 })).not.toBeDisabled());
    goToStep(STEP2);
    const rowRate = await screen.findByRole("spinbutton", {
      name: `${bank}的年利率`,
    });
    expect(rowRate).toHaveValue(0.05);
    // 下行手改利率：不影响上方档位。
    fireEvent.change(rowRate, { target: { value: "1.25" } });
    fireEvent.blur(rowRate);
    expect(rowRate).toHaveValue(1.25);
    const tierRate = screen.getByRole("spinbutton", {
      name: "活期存款的采用利率",
    });
    expect(tierRate).toHaveValue(0.05);
    // 改上方档位利率：下行该类型各户（含手改过的）全部跟到新档位利率。
    fireEvent.change(tierRate, { target: { value: "0.1" } });
    fireEvent.blur(tierRate);
    expect(rowRate).toHaveValue(0.1);
    expect(tierRate).toHaveValue(0.1);
    // 档位表在科目分类表上方。
    const tierHeading = screen.getByText("存款利率档位");
    const accountSummary = screen.getByText("逐个核对科目分类（末级明细）");
    expect(
      tierHeading.compareDocumentPosition(accountSummary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
