// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FxAuditPage } from "./FxAuditPage";
import type { ToolManifest } from "./types";

const mock = vi.hoisted(() => ({
  engineCall: vi.fn(),
  pickPath: vi.fn(),
  jobStart: vi.fn(),
  jobListener: undefined as undefined | ((event: Record<string, unknown>) => void),
}));
vi.mock("./api", () => ({
  engineCall: mock.engineCall,
  jobCancel: vi.fn(),
  jobStart: mock.jobStart,
  listenJobEvents: vi.fn(async (callback: (event: Record<string, unknown>) => void) => {
    mock.jobListener = callback;
    return () => undefined;
  }),
  listenPositionedFileDrops: vi.fn(async () => () => undefined),
  openOutput: vi.fn(),
  pickPath: mock.pickPath,
}));
afterEach(cleanup);
const tool: ToolManifest = {
  id: "fx_audit",
  name: "汇兑损益测算",
  description: "",
  route: "/tools/fx_audit",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};

const tbHeaders = ["主体", "科目编码", "科目名称", "币种", "期初余额", "期末余额", "本年累计借方", "本年累计贷方"];
const jeHeaders = ["主体", "记账日期", "凭证号", "科目编码", "科目名称", "摘要", "原币币种", "原币金额", "本币金额"];

/** 识别结果由用例通过改写 entities 控制（单主体/多主体两版）。 */
let inspectionEntities: string[] = [];
let inspectionAuxiliary = false;

const classify = (kind: "tb" | "je") => ({
  kind,
  scores: { je: kind === "je" ? 10 : 1, tb: kind === "tb" ? 10 : 1 },
  sheet: kind === "tb" ? "余额表" : "序时账",
  headerRow: 1,
  headerDepth: 1,
  headers: kind === "tb" ? tbHeaders : jeHeaders,
  preview: [(kind === "tb" ? tbHeaders : jeHeaders).map(() => "x")],
});
const inspect = (kind: "tb" | "je") => ({
  headers: kind === "tb" ? tbHeaders : jeHeaders,
  preview: [(kind === "tb" ? tbHeaders : jeHeaders).map(() => "x")],
  rowCount: 2,
  sheet: kind === "tb" ? "余额表" : "序时账",
  sheets: [kind === "tb" ? "余额表" : "序时账"],
  headerRow: 1,
  headerDepth: 1,
  entities: inspectionEntities,
  accounts: kind === "tb" ? ["1002 银行存款"] : ["1002 银行存款"],
  suggestedMapping:
    kind === "tb"
      ? {
          entity: "主体",
          accountCode: "科目编码",
          accountName: "科目名称",
          currency: "币种",
          openingForeignAmount: "期初余额",
          openingFunctionalAmount: "期初余额",
          closingForeignAmount: "期末余额",
          closingFunctionalAmount: "期末余额",
          ytdFunctionalDebit: "本年累计借方",
          ytdFunctionalCredit: "本年累计贷方",
          ...(inspectionAuxiliary ? { auxiliary: "科目名称" } : {}),
        }
      : {
          entity: "主体",
          date: "记账日期",
          id: "凭证号",
          accountCode: "科目编码",
          accountName: "科目名称",
          summary: "摘要",
          currency: "原币币种",
          foreignAmount: "原币金额",
          functionalAmount: "本币金额",
        },
});

async function uploadBothSources() {
  mock.pickPath.mockResolvedValue(["tb.xlsx", "je.xlsx"]);
  fireEvent.click(screen.getByRole("button", { name: "重新选择 JE、TB 文件" }));
  await screen.findByText("已识别：TB 科目余额表");
  await screen.findByText("已识别：JE 凭证明细");
  // 上传收口后自动联合复核一次；等它跑完再点下一步，避免 busy 拦住按钮。
  await waitFor(() =>
    expect(mock.engineCall).toHaveBeenCalledWith(
      "ledger.check_mapping_alignment",
      expect.anything(),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  inspectionEntities = [];
  inspectionAuxiliary = false;
  mock.pickPath.mockResolvedValue(null);
  mock.jobStart.mockResolvedValue("fx-job-1");
  mock.jobListener = undefined;
  mock.engineCall.mockImplementation(async (method: string) => {
    if (method === "ledger.forms") return [];
    if (method === "ledger.review_pair_mapping")
      return { tbChanges: [], jeChanges: [] };
    if (method === "ledger.check_mapping_alignment")
      return { errors: [], warnings: [], fix: null };
    if (method === "ledger.entity_scope_suggestions")
      return { anchors: [], candidates: [] };
    if (method === "ledger.auxiliary_link")
      return {
        tbAuxMapped: false,
        status: "unmapped",
        column: null,
        anchorHits: 0,
        anchorTotal: 0,
        coverage: 0,
        competingColumns: [],
        warnings: [],
      };
    if (method === "fx.classify_source") {
      // 统一上传框先选 TB 再选 JE：按调用序返回两份分类结论。
      const classified = classify("tb");
      const calls = mock.engineCall.mock.calls.filter(
        ([name]) => name === "fx.classify_source",
      ).length;
      return calls % 2 === 1 ? classified : classify("je");
    }
    if (method === "fx.inspect_tb") return inspect("tb");
    if (method === "fx.inspect_je") return inspect("je");
    throw new Error(`unexpected ${method}`);
  });
});

it.each([
  ["failed", "汇兑测算失败，请检查字段映射。"],
  ["cancelled", "汇兑测算已取消。"],
  ["completed", "系统未收到测算结果"],
] as const)("真实页面消费 %s 任务事件并保持终态说明", async (phase, message) => {
  render(<FxAuditPage tool={tool} />);
  await uploadBothSources();
  fireEvent.click(screen.getByRole("button", { name: "下一步：确认TB科目类型" }));
  fireEvent.click(await screen.findByRole("button", { name: "下一步：测算与底稿" }));
  fireEvent.change(await screen.findByLabelText("资产负债表日"), { target: { value: "20251231" } });
  fireEvent.click(await screen.findByRole("button", { name: "测算预览" }));
  await waitFor(() => expect(mock.jobStart).toHaveBeenCalledWith("fx.preview", expect.anything()));

  await act(async () => {
    mock.jobListener?.({
      jobId: "fx-job-1",
      toolId: "fx_audit",
      phase: "running",
      current: 45,
      total: 100,
      message: "正在计算汇兑损益…",
      severity: "info",
      outputPaths: [],
    });
  });
  expect(screen.getByText("正在计算汇兑损益…")).toBeVisible();
  // UI 审计 P3-3：只有被点击的「测算预览」进 loading 文案，
  // 「重新测算」保持普通禁用文案，两个按钮不得同时转圈。
  expect(screen.getByRole("button", { name: "测算中…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "重新测算" })).toBeDisabled();

  await act(async () => {
    mock.jobListener?.({
      jobId: "fx-job-1",
      toolId: "fx_audit",
      phase,
      current: 100,
      total: 100,
      message,
      severity: phase === "failed" ? "error" : phase === "completed" ? "success" : "warning",
      outputPaths: [],
    });
  });
  expect((await screen.findAllByText(new RegExp(message))).length).toBeGreaterThan(0);
});

it("测算结果列示客户与审计汇率并标明取得方式", async () => {
  render(<FxAuditPage tool={tool} />);
  await uploadBothSources();
  fireEvent.click(screen.getByRole("button", { name: "下一步：确认TB科目类型" }));
  fireEvent.click(await screen.findByRole("button", { name: "下一步：测算与底稿" }));
  fireEvent.change(await screen.findByLabelText("资产负债表日"), {
    target: { value: "20251231" },
  });
  fireEvent.click(await screen.findByRole("button", { name: "测算预览" }));
  await waitFor(() => expect(mock.jobStart).toHaveBeenCalledWith("fx.preview", expect.anything()));

  await act(async () => {
    mock.jobListener?.({
      jobId: "fx-job-1",
      toolId: "fx_audit",
      phase: "completed",
      current: 100,
      total: 100,
      message: "测算完成",
      severity: "success",
      outputPaths: [],
      result: {
        summary: {
          formalMeasurementAvailable: true,
          realizedGainLoss: 0,
          unrealizedAdjustment: 107.1,
          automaticMeasuredFxGainLoss: 107.1,
          diagnosticMeasuredFxGainLoss: 107.1,
          tbFxGainLoss: 0,
          difference: 107.1,
          differenceRatio: null,
        },
        unrealizedBalanceRollforward: [
          {
            monthEnd: "2025-12-31",
            account: "长期借款—欧元",
            currency: "EUR",
            customerRate: 7.7,
            customerRateBasis: "客户重估后账面本位币余额÷月末原币余额反推",
            customerRateReliability: "反推",
            officialRate: 8.2355,
            customerVsAuditRateDifference: -0.5355,
            customerVsAuditRateImpact: 107.1,
            suggestedAdjustment: 107.1,
          },
          {
            monthEnd: "2025-12-31",
            account: "金额不足账户",
            currency: "USD",
            customerRate: null,
            officialRate: 7.2,
            suggestedAdjustment: 0,
          },
        ],
      },
    });
  });

  const comparison = await screen.findByRole("region", { name: "客户与审计汇率比较" });
  expect(within(comparison).getByText("7.700000")).toBeVisible();
  expect(within(comparison).getByText("8.235500")).toBeVisible();
  expect(
    within(comparison).getByText("反推｜客户重估后账面本位币余额÷月末原币余额反推"),
  ).toBeVisible();
  expect(within(comparison).queryByText("金额不足账户")).not.toBeInTheDocument();
  expect(within(comparison).queryByText(/无法取得/)).not.toBeInTheDocument();
  expect(within(comparison).getByText(/仅用于解释差异，不参与审计测算/)).toBeVisible();
});

it("上传就绪不扫描JE，第一步下一步才生成并复用辅助计划", async () => {
  inspectionAuxiliary = true;
  render(<FxAuditPage tool={tool} />);
  await uploadBothSources();
  const auxiliaryCalls = () =>
    mock.engineCall.mock.calls.filter(
      ([method]) => method === "ledger.auxiliary_link",
    ).length;
  expect(auxiliaryCalls()).toBe(0);

  fireEvent.click(screen.getByRole("button", { name: "下一步：确认TB科目类型" }));
  await screen.findByRole("button", { name: "下一步：测算与底稿" });
  expect(auxiliaryCalls()).toBe(1);
  expect(
    mock.engineCall.mock.calls.some(
      ([method]) => method === "fx.validate_currency_mapping",
    ),
  ).toBe(false);

  // 底部「返回」再「下一步」：同一来源/映射计划直接复用。
  fireEvent.click(screen.getByRole("button", { name: "返回上传与识别" }));
  await screen.findByRole("button", { name: "下一步：确认TB科目类型" });
  fireEvent.click(screen.getByRole("button", { name: "下一步：确认TB科目类型" }));
  await screen.findByRole("button", { name: "下一步：测算与底稿" });

  // 步骤条导航 0→1→0→1：同样不再触发验证（已完成步的读法带「（已完成）」后缀）。
  fireEvent.click(screen.getByRole("button", { name: /1 上传与识别/ }));
  await screen.findByRole("button", { name: "下一步：确认TB科目类型" });
  fireEvent.click(screen.getByRole("button", { name: "2 TB科目类型确认" }));
  await screen.findByRole("button", { name: "下一步：测算与底稿" });
  expect(auxiliaryCalls()).toBe(1);
});

it("TB 未映射辅助字段时第一步下一步不调用辅助验证", async () => {
  render(<FxAuditPage tool={tool} />);
  await uploadBothSources();
  fireEvent.click(screen.getByRole("button", { name: "下一步：确认TB科目类型" }));
  await screen.findByRole("button", { name: "下一步：测算与底稿" });
  expect(
    mock.engineCall.mock.calls.some(
      ([method]) => method === "ledger.auxiliary_link",
    ),
  ).toBe(false);
});

/** 回归（用户反馈 B）：TB/JE 识别出多个实际主体时，第二步科目确认表必须
 *  带主体列；单主体账套维持原三列布局。 */
it("多主体账套第二步出现主体列，单主体不出现", async () => {
  inspectionEntities = ["甲公司", "乙公司"];
  render(<FxAuditPage tool={tool} />);
  await uploadBothSources();
  fireEvent.click(screen.getByRole("button", { name: "下一步：确认TB科目类型" }));
  await screen.findByRole("button", { name: "下一步：测算与底稿" });
  const multiHead = document.querySelector(".fx-accounts-head") as HTMLElement;
  expect(multiHead).toBeTruthy();
  expect(within(multiHead).getByText("主体")).toBeVisible();
  // 末级兜底行没有主体信息，主体列显示占位符 —。
  expect(document.querySelector(".fx-entity-cell")?.textContent).toBe("—");

  cleanup();
  inspectionEntities = ["甲公司"];
  render(<FxAuditPage tool={tool} />);
  await uploadBothSources();
  fireEvent.click(screen.getByRole("button", { name: "下一步：确认TB科目类型" }));
  await screen.findByRole("button", { name: "下一步：测算与底稿" });
  const singleHead = document.querySelector(".fx-accounts-head") as HTMLElement;
  expect(singleHead).toBeTruthy();
  expect(within(singleHead).queryByText("主体")).not.toBeInTheDocument();
  expect(document.querySelector(".fx-entity-cell")).toBeNull();
});

/** 上传两表并直达第三步（测算与底稿）。 */
async function gotoRatesStep() {
  fireEvent.click(screen.getByRole("button", { name: "下一步：确认TB科目类型" }));
  fireEvent.click(await screen.findByRole("button", { name: "下一步：测算与底稿" }));
  await screen.findByLabelText("资产负债表日");
}

/** 回归（汇率导出/导入）：第三步按钮行提供导出、导入与悬停说明。 */
it("第三步提供汇率导出导入按钮与功能说明提示", async () => {
  render(<FxAuditPage tool={tool} />);
  await uploadBothSources();
  await gotoRatesStep();
  expect(screen.getByRole("button", { name: "导出汇率" })).toBeVisible();
  expect(screen.getByRole("button", { name: "导入汇率" })).toBeVisible();
  expect(screen.getByText("汇率取自中国人民银行。")).toBeVisible();
  // 说明 icon：聚焦即出现气泡，讲清导出、导入与恢复官方三件事。
  fireEvent.focus(screen.getByRole("button", { name: "什么是汇率导出与导入" }));
  const tip = await screen.findByRole("tooltip");
  expect(tip).toHaveTextContent("导出汇率");
  expect(tip).toHaveTextContent("导入汇率");
  expect(tip).toHaveTextContent("恢复官方汇率");
});

/** 回归（汇率导入）：导入后测算注入自定义快照，恢复官方即回到现抓口径。 */
it("导入自定义汇率后按导入口径测算并可一键恢复官方", async () => {
  render(<FxAuditPage tool={tool} />);
  await uploadBothSources();
  await gotoRatesStep();
  fireEvent.change(screen.getByLabelText("资产负债表日"), {
    target: { value: "20251231" },
  });
  mock.pickPath.mockResolvedValue("C:/rates/修改后汇率.xlsx");
  mock.engineCall.mockImplementation(async (method: string) => {
    if (method === "fx.import_rates")
      return {
        rateSnapshot: {
          source: "用户导入：修改后汇率.xlsx（2026-09-25 10:00 导入）",
          responseHash: "custom-hash-1",
          startDate: "2024-11-27",
          endDate: "2025-12-31",
          rates: [],
        },
        summary: { currencyCount: 25, dateCount: 400 },
      };
    throw new Error(`unexpected ${method}`);
  });
  fireEvent.click(screen.getByRole("button", { name: "导入汇率" }));
  expect(await screen.findByText(/已导入自定义汇率：修改后汇率.xlsx/)).toBeVisible();
  expect(screen.getByText(/25个币种 × 400天/)).toBeVisible();
  expect(screen.getByRole("button", { name: "恢复官方汇率" })).toBeVisible();

  // 导入生效后的测算必须携带自定义快照（内容指纹进引擎缓存键的前提）。
  fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenCalledWith(
      "fx.preview",
      expect.objectContaining({
        rateSnapshot: expect.objectContaining({ responseHash: "custom-hash-1" }),
      }),
    ),
  );
  // 让这轮测算正常结束、页面退出 busy，才能继续验证恢复官方后的口径。
  await act(async () => {
    mock.jobListener?.({
      jobId: "fx-job-1",
      toolId: "fx_audit",
      phase: "completed",
      current: 100,
      total: 100,
      message: "测算完成",
      severity: "success",
      outputPaths: [],
      result: { summary: { formalMeasurementAvailable: true } },
    });
  });

  // 一键恢复官方：状态行回官方口径，测算不再携带快照。
  fireEvent.click(screen.getByRole("button", { name: "恢复官方汇率" }));
  expect(await screen.findByText("汇率取自中国人民银行。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "测算预览" }));
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenCalledWith("fx.preview", expect.anything()),
  );
  const lastCall = mock.jobStart.mock.calls.at(-1);
  expect(lastCall?.[1].rateSnapshot).toBeUndefined();
});

/** 回归（汇率导出）：走任务通道，完成后回报文件位置且不污染测算结果。 */
it("导出汇率走任务通道并回报文件位置", async () => {
  render(<FxAuditPage tool={tool} />);
  await uploadBothSources();
  await gotoRatesStep();
  fireEvent.change(screen.getByLabelText("资产负债表日"), {
    target: { value: "20251231" },
  });
  mock.pickPath.mockResolvedValue("C:/out/汇率中间价_20251231.xlsx");
  mock.jobStart.mockResolvedValue("rates-job-9");
  fireEvent.click(screen.getByRole("button", { name: "导出汇率" }));
  await waitFor(() =>
    expect(mock.jobStart).toHaveBeenCalledWith(
      "fx.export_rates",
      expect.objectContaining({
        outputPath: "C:/out/汇率中间价_20251231.xlsx",
        reportEnd: "2025-12-31",
      }),
    ),
  );
  await act(async () => {
    mock.jobListener?.({
      jobId: "rates-job-9",
      toolId: "fx_audit",
      phase: "completed",
      current: 2,
      total: 2,
      message: "汇率文件已生成。",
      severity: "success",
      outputPaths: [],
      result: { outputPath: "C:/out/汇率中间价_20251231.xlsx" },
    });
  });
  expect(await screen.findByText(/汇率已导出/)).toBeVisible();
  // 汇率导出的完成事件不得混进测算结果状态。
  expect(screen.queryByText("Excel底稿已生成；测算预览结果已保留在下方。")).not.toBeInTheDocument();
});
