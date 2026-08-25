// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JeSignMarkPage } from "./JeSignMarkPage";
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
      // 金标要求日期、凭证号、科目编码、科目名称、摘要齐备，缺一项流程就会被拦。
      mapping: { id: ["凭证号"], accountCode: "科目编码", accountName: ["科目"], date: "日期", summary: "摘要", functionalAmount: "金额" },
      batches: [{ name: "批次1", accounts: [] }],
      activeBatch: 0,
      columnFilters: {},
      outputPath: "",
      outputTouched: false,
    }),
  );
}

describe("JeSignMarkPage", () => {
  afterEach(() => {
    // vitest 未开全局 cleanup，不手动卸载的话上一条用例的 DOM 会留到下一条。
    cleanup();
    sessionStorage.clear();
  });

  it("shows only the loading card before a file is read", () => {
    render(<JeSignMarkPage tool={tool} />);
    expect(screen.getByText("正负数凭证标记")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "删除批次" })).toBeInTheDocument();
    expect(screen.getByText("点击选择目标科目")).toBeInTheDocument();
    expect(screen.getByText("标记与导出")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "标记并导出" })).toBeInTheDocument();

    // 看账的三步走在这里不该出现，尤其是被剪掉的「科目筛选」独立步骤。
    expect(screen.queryByText("科目筛选")).not.toBeInTheDocument();
    expect(screen.queryByText("透视与导出")).not.toBeInTheDocument();
  });

  // 损益结转整块已从本工具剪除：既没有开关，也不该有任何相关文案。
  it("has no profit-transfer switch or wording", () => {
    seedLoadedDraft();
    render(<JeSignMarkPage tool={tool} />);
    expect(screen.queryByText(/损益结转/)).not.toBeInTheDocument();
  });

  // 金额符号口径卡片：自动检测的结论与依据要亮出来，筛过的账要黄牌提醒，
  // 手动选择要在导出参数里生效。
  it("shows the sign convention card with basis and passes the manual choice to export", async () => {
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
        filtered: true,
        keySuspect: false,
      },
    });
    render(<JeSignMarkPage tool={tool} />);
    await waitFor(() =>
      expect(screen.getByText(/36 张借贷齐全的凭证/)).toBeInTheDocument(),
    );
    // 筛过的账：黄牌提醒必须出现，并且要点明成因是"按科目筛选后导出"，
    // 不能让人误以为是字段映射出了问题。
    expect(screen.getByText(/按科目筛选后导出/)).toBeInTheDocument();
    expect(screen.getByText(/这不是映射问题/)).toBeInTheDocument();
    // 三档选择切换到「已带符号」，导出参数要带上 signConvention。
    fireEvent.click(screen.getByRole("button", { name: "已带符号（借正贷负）" }));
    fireEvent.click(screen.getByRole("button", { name: "标记并导出" }));
    await waitFor(() => expect(jobStart).toHaveBeenCalled());
    const params = vi.mocked(jobStart).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.signConvention).toBe("signed");
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
        filtered: false,
        keySuspect: false,
      },
    });
    render(<JeSignMarkPage tool={tool} />);
    await waitFor(() =>
      expect(screen.getByText(/单一金额列必然已带符号/)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "借贷符号一样" }),
    ).not.toBeInTheDocument();
  });
});
