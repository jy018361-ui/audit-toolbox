// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JeSignMarkPage } from "./JeSignMarkPage";
import { publishTaskRestore } from "./restore";
import type { ToolManifest } from "./types";

vi.mock("./api", () => ({
  engineCall: vi.fn().mockResolvedValue({ values: [], total: 0 }),
  jobCancel: vi.fn(),
  jobStart: vi.fn(),
  listenJobEvents: vi.fn().mockResolvedValue(() => undefined),
  openOutput: vi.fn(),
  pickPath: vi.fn().mockResolvedValue(null),
}));

const tool: ToolManifest = {
  id: "je_sign_mark",
  name: "正负数凭证标记",
  description: "",
  route: "/tools/je_sign_mark",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};

/** 预置一份「已读取凭证文件」的草稿，页面据此展开批次条与导出区。 */
function seedLoadedDraft() {
  sessionStorage.setItem(
    "audit-toolbox.je-sign-mark.draft.v2",
    JSON.stringify({
      inputPath: "C:/tmp/je.xlsx",
      sheet: "",
      knownSheets: [],
      headerRow: 1,
      inspect: {
        headers: ["凭证号", "科目", "金额"],
        preview: [["V1", "应付账款", "100"]],
        dimensions: { rows: 1, columns: 3 },
      },
      // 科目名称单独即可满足身份；摘要是选填，不应阻拦工具进入已加载状态。
      mapping: { id: ["凭证号"], accountName: ["科目"], date: "日期", functionalAmount: "金额" },
      batches: [{ name: "批次1", accounts: [] }],
      activeBatch: 0,
      columnFilters: {},
      outputPath: "",
      outputTouched: false,
    }),
  );
}

describe("JeSignMarkPage", () => {
  it("restores a reading step without mapping and re-identifies the saved source", async () => {
    const { jobStart } = await import("./api");
    vi.mocked(jobStart).mockResolvedValueOnce("restored-read");
    publishTaskRestore({
      jobId: "old-read", toolId: tool.id, method: "kanzhang.mark_inspect",
      params: { inputPath: "C:/tmp/saved.xlsx", sheet: "凭证", headerRow: 2 },
      missingPaths: [], authorizedPathCount: 1,
    });
    render(<JeSignMarkPage tool={tool} />);
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("kanzhang.mark_inspect", {
      inputPath: "C:/tmp/saved.xlsx", sheet: "凭证", headerRow: 2, headerDepth: 1,
    }));
    const draft = JSON.parse(sessionStorage.getItem("audit-toolbox.je-sign-mark.draft.v2") ?? "{}");
    expect(draft.inputPath).toBe("C:/tmp/saved.xlsx");
    expect(draft.sheet).toBe("凭证");
  });
  it("取消后页首提供独立警示徽标和重试方向", async () => {
    const { listenJobEvents } = await import("./api");
    const { container } = render(<JeSignMarkPage tool={tool} />);
    const callback = vi.mocked(listenJobEvents).mock.calls.at(-1)?.[0];
    act(() => callback?.({ toolId: "je_sign_mark", jobId: "cancel-test", phase: "cancelled", current: 1, total: 2, message: "任务已取消", severity: "info", outputPaths: [] }));
    expect(screen.getByText("已取消")).toHaveAttribute("data-variant", "warning");
    expect(container.querySelector('[data-variant="warning"]')?.closest('[role="status"]')).toHaveTextContent("可重新读取或导出");
  });
  afterEach(() => {
    // vitest 未开全局 cleanup，不手动卸载的话上一条用例的 DOM 会留到下一条。
    cleanup();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("shows only the loading card before a file is read", () => {
    render(<JeSignMarkPage tool={tool} />);
    // 面包屑与标题已统一为侧栏名「正负数凭证标记」，同文案出现两处，按标题角色断言。
    expect(
      screen.getByRole("heading", { level: 1, name: "正负数凭证标记" }),
    ).toBeInTheDocument();
    expect(screen.getByText("拖放或点击选择凭证文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "读取并自动映射" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增批次" })).not.toBeInTheDocument();
  });

  // 这个工具是「单页到底」：加载、批次与目标科目、导出同屏，没有科目筛选那一步。
  // 骨架一旦被拆回多步或丢掉批次条，这里就会失败。
  it("puts loading, batches and export on one page after reading", () => {
    seedLoadedDraft();
    render(<JeSignMarkPage tool={tool} />);

    expect(screen.getByRole("button", { name: "读取并自动映射" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增批次" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空批次" })).toBeInTheDocument();
    expect(screen.getByText("选择目标科目")).toBeInTheDocument();
    expect(screen.getByText("标记与导出")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "标记并导出" })).toBeInTheDocument();
    expect(screen.getByText("导出文件格式与列说明")).toBeInTheDocument();
    expect(screen.getByText("请先在上方选择至少一个目标科目。")).toBeInTheDocument();
    expect(screen.queryByText("标记结果")).not.toBeInTheDocument();

    // 看账的三步走在这里不该出现，尤其是被剪掉的「科目筛选」独立步骤。
    expect(screen.queryByText("科目筛选")).not.toBeInTheDocument();
    expect(screen.queryByText("透视与导出")).not.toBeInTheDocument();

    // 文件预览必须走公共 DataTable（列按内容取宽 + data-more 滚动渐隐 +
    // 金额右对齐都在那套容器里）；退回自制表格会把右缘裁列问题带回来。
    expect(
      document.querySelector(".mapping-panel .data-table-frame .data-table-scroll table.data-table-table"),
    ).not.toBeNull();
  });

  it("keeps batch naming out of the default view and opens inline rename on demand", () => {
    seedLoadedDraft();
    render(<JeSignMarkPage tool={tool} />);

    expect(screen.queryByRole("textbox", { name: "批次名称" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "批次名称" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "费用复核" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    expect(screen.getByRole("button", { name: "费用复核 · 0 个科目" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "批次名称" })).not.toBeInTheDocument();
  });

  it("offers profit-transfer marking in the export card", () => {
    seedLoadedDraft();
    render(<JeSignMarkPage tool={tool} />);
    expect(screen.getByText("标记损益结转凭证")).toBeInTheDocument();
    expect(screen.getByText(/不参与正负数配对/)).toBeInTheDocument();
  });

  // 正常检测静默；单边文件保留用户选择，并确保选择传入导出。
  it("asks for a choice only for one-sided files and passes the manual choice to export", async () => {
    seedLoadedDraft();
    // 导出按钮需要有效批次：给种子草稿补一个已选科目的批次。
    const raw = JSON.parse(
      sessionStorage.getItem("audit-toolbox.je-sign-mark.draft.v2") ?? "{}",
    ) as Record<string, unknown>;
    raw.batches = [{ name: "批次1", accounts: ["管理费用"] }];
    sessionStorage.setItem("audit-toolbox.je-sign-mark.draft.v2", JSON.stringify(raw));
    const { engineCall, jobStart } = await import("./api");
    vi.mocked(engineCall).mockResolvedValue({
      signConvention: {
        scheme: "B",
        detected: "unsigned",
        basis: "36 张借贷齐全的凭证按「借贷符号一样」配平，取多数。",
        totalVouchers: 36,
        balancedVouchers: 36,
        unbalancedVouchers: 0,
        oneSidedVouchers: 36,
        filtered: true,
        keySuspect: false,
      },
    });
    render(<JeSignMarkPage tool={tool} />);
    await waitFor(() =>
      expect(screen.getByText("文件仅含单边分录，请确认金额记录方式。")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/36 张借贷齐全的凭证/)).not.toBeInTheDocument();
    expect(screen.queryByText("查看判定依据")).not.toBeInTheDocument();
    // 全部凭证均为单边时才显示两个人工口径；选择后要进入导出参数。
    fireEvent.click(screen.getByRole("button", { name: "已带符号" }));
    fireEvent.click(screen.getByRole("button", { name: "标记并导出" }));
    await waitFor(() => expect(jobStart).toHaveBeenCalled());
    const params = vi.mocked(jobStart).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.signConvention).toBe("signed");
    expect(params.markLossTransfer).toBe(true);
  });

  it("hides routine sign information and places review in the mapping panel", async () => {
    seedLoadedDraft();
    const { engineCall } = await import("./api");
    vi.mocked(engineCall).mockResolvedValue({
      signConvention: {
        scheme: "B",
        detected: "unsigned",
        basis: "12 张凭证均可按借贷分列配平。",
        totalVouchers: 12,
        balancedVouchers: 12,
        unbalancedVouchers: 0,
        oneSidedVouchers: 0,
        filtered: false,
        keySuspect: false,
      },
    });
    await act(async () => { render(<JeSignMarkPage tool={tool} />); });
    expect(screen.queryByText(/12 张凭证均可/)).not.toBeInTheDocument();
    expect(screen.queryByText("金额符号口径")).not.toBeInTheDocument();
    expect(screen.queryByText(/金额方案.*已生效/)).not.toBeInTheDocument();
    expect(screen.queryByText("查看判定依据")).not.toBeInTheDocument();
    const review = screen.getByRole("button", { name: "复核映射" });
    expect(review.closest(".mapping-panel")).toHaveTextContent("文件预览");
    expect(document.querySelector(".jm-sign")).toBeNull();
    expect(screen.queryByRole("button", { name: "借贷符号一样" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已带符号" })).not.toBeInTheDocument();
  });

  it("LLM 已复核但没有调整时仍在映射区显示结论", async () => {
    seedLoadedDraft();
    const { engineCall } = await import("./api");
    vi.mocked(engineCall).mockImplementation(async (method) => {
      if (method === "kanzhang.llm_mapping") return { reviews: [] };
      if (method === "kanzhang.mark_sign_report") return {
        signConvention: {
          scheme: "single", detected: "signed", basis: "单一金额列。",
          totalVouchers: 1, balancedVouchers: 0, unbalancedVouchers: 0,
          oneSidedVouchers: 1, filtered: false, keySuspect: false,
        },
      };
      return { values: [], total: 0 };
    });
    render(<JeSignMarkPage tool={tool} />);
    fireEvent.click(screen.getByRole("button", { name: "复核映射" }));
    expect(await screen.findByText("无调整")).toBeVisible();
    expect(screen.getByText(/现有字段映射与 LLM 判断一致，未做改动/)).toBeVisible();
  });

  it("omits the selector when a single amount column leaves no ambiguity", async () => {
    seedLoadedDraft();
    const { engineCall } = await import("./api");
    vi.mocked(engineCall).mockResolvedValue({
      signConvention: {
        scheme: "single",
        detected: "signed",
        basis: "单一金额列必然已带符号，否则凭证无法配平。",
        totalVouchers: 1,
        balancedVouchers: 0,
        unbalancedVouchers: 0,
        oneSidedVouchers: 1,
        filtered: false,
        keySuspect: false,
      },
    });
    await act(async () => { render(<JeSignMarkPage tool={tool} />); });
    expect(screen.queryByText(/单一金额列必然已带符号/)).not.toBeInTheDocument();
    expect(document.querySelector(".jm-sign")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "借贷符号一样" }),
    ).not.toBeInTheDocument();
  });

  // 科目的选择入口只留批次区那一个：预览表头的科目列不挂漏斗，
  // 其他列的数据筛选漏斗不受影响。科目面板把值拆成「编码 名称」两段展示。
  it("keeps account picking off preview headers and shows code with name", async () => {
    seedLoadedDraft();
    const { engineCall } = await import("./api");
    vi.mocked(engineCall).mockResolvedValue({
      // 编码与名称列分开映射时，科目值是「编码-名称」拼接串（与真实账一致）。
      values: ["6602050001-管理费用-办公费", "1122-应收账款"],
      codes: ["6602050001", "1122"],
      total: 2,
    });
    render(<JeSignMarkPage tool={tool} />);

    expect(
      screen.queryByRole("button", { name: "筛选 科目" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "筛选 金额" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("选择目标科目"));
    await waitFor(() =>
      expect(screen.getByText("6602050001")).toBeInTheDocument(),
    );
    // 编码段拆开后，名称段不再以编码开头；悬停提示仍是完整值。
    expect(screen.getByText("管理费用-办公费")).toBeInTheDocument();
    expect(screen.getByTitle("1122 应收账款")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索科目编码或名称")).toBeInTheDocument();
    expect(
      (screen.getByRole("checkbox", { name: "（全选）" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it("任务失败后保留错误反馈，不留下空结果卡", async () => {
    seedLoadedDraft();
    const { listenJobEvents } = await import("./api");
    let emit: ((event: never) => void) | undefined;
    vi.mocked(listenJobEvents).mockImplementationOnce(async (callback) => {
      emit = callback as (event: never) => void;
      return () => undefined;
    });
    render(<JeSignMarkPage tool={tool} />);
    await waitFor(() => expect(emit).toBeDefined());
    act(() => emit?.({ toolId: "je_sign_mark", jobId: "job-1", phase: "failed", message: "文件无法读取" } as never));
    expect(screen.getByText("文件无法读取")).toBeInTheDocument();
    expect(screen.queryByText("标记结果")).not.toBeInTheDocument();
  });

  // jsdom 环境下 import.meta.url 不是 file 协议，读不了文件；正负数的
  // 样式断言放在 node 环境的 KanzhangParityPage.test.ts（两页共用样式族）。
});
