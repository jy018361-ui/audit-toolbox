// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TbjeCheckPage,
  tbjeCompleteAutomaticReviewKeys,
} from "./TbjeCheckPage";
import { pairingFileKey } from "./tbjePairing";
import { ConfirmDialogHost } from "./components/ConfirmDialog";
import type { ToolManifest } from "./types";

vi.mock("./api", () => ({
  engineCall: vi.fn(),
  jobCancel: vi.fn(),
  jobStart: vi.fn(async () => "job-1"),
  listenJobEvents: vi.fn(async () => () => undefined),
  listenPositionedFileDrops: vi.fn(async () => () => undefined),
  openOutput: vi.fn(),
  pickPath: vi.fn(async () => null),
}));

const tool: ToolManifest = {
  id: "tbje_check",
  name: "TB/JE 完整性检查",
  description: "",
  route: "/tools/tbje_check",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};

it("批量核对仅对完整组合生成自动复核身份，替换任一文件会生成新身份", () => {
  const tbA = { path: "C:/samples/TB-A.xlsx", kind: "tb" as const };
  const tbB = { path: "C:/samples/TB-B.xlsx", kind: "tb" as const };
  const jeA = { path: "C:/samples/JE-A.xlsx", kind: "je" as const };

  expect(tbjeCompleteAutomaticReviewKeys([{ tb: tbA }])).toEqual([]);
  expect(tbjeCompleteAutomaticReviewKeys([{ je: jeA }])).toEqual([]);

  const first = tbjeCompleteAutomaticReviewKeys([{ tb: tbA, je: jeA }]);
  const replaced = tbjeCompleteAutomaticReviewKeys([{ tb: tbB, je: jeA }]);
  expect(first).toEqual([
    JSON.stringify([pairingFileKey(tbA), pairingFileKey(jeA)]),
  ]);
  expect(replaced).toHaveLength(1);
  expect(replaced[0]).not.toBe(first[0]);
});

describe("TbjeCheckPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("uses the shared page header and three-step workflow", () => {
    const { container } = render(<TbjeCheckPage tool={tool} />);

    expect(
      screen.getByRole("heading", { level: 1, name: tool.name }),
    ).toBeInTheDocument();
    expect(container.querySelector(".fx-head")).toBeNull();
    expect(screen.getByRole("region", { name: "准备核对资料" })).toBeVisible();

    const steps = container.querySelector(".step-indicator");
    expect(steps).not.toBeNull();
    const buttons = within(steps as HTMLElement).getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveTextContent("添加文件");
    expect(buttons[1]).toBeDisabled();
    expect(buttons[2]).toBeDisabled();
    expect(
      screen.getByRole("heading", { level: 2, name: "1. 添加 TB 与 JE 文件" }),
    ).toBeInTheDocument();
  });

  it("enables pairing and gives every JE selector an accessible name", async () => {
    const { engineCall, pickPath } = await import("./api");
    vi.mocked(pickPath).mockResolvedValue([
      "C:/samples/01TB.xlsx",
      "C:/samples/01JE.xlsx",
    ]);
    vi.mocked(engineCall).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "ledger.forms") return [];
        if (method === "ledger.check_mapping_alignment")
          return { aligned: true, warnings: [] };
        const source = (params as { source: { inputPath: string } }).source;
        const isTb = source.inputPath.includes("TB");
        if (method === "deposit.classify_source") {
          return {
            kind: isTb ? "tb" : "je",
            sheet: "Sheet1",
            headerRow: 1,
            headerDepth: 1,
          };
        }
        return {
          sheet: "Sheet1",
          headerRow: 1,
          headerDepth: 1,
          headers: isTb ? ["科目编码", "期末余额"] : ["科目编码", "借方金额"],
          preview: [],
          entities: ["主体 A"],
          suggestedMapping: {},
        };
      },
    );

    const { container } = render(<TbjeCheckPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 2, name: /2\. 确认配对与字段/ }),
      ).toBeInTheDocument(),
    );
    const pairingList = container.querySelector(".tbje-pairing-list");
    expect(pairingList).not.toBeNull();
    expect(
      screen.queryByRole("heading", {
        level: 2,
        name: "1. 添加 TB 与 JE 文件",
      }),
    ).not.toBeInTheDocument();
    expect(pairingList).toHaveTextContent("科目余额表 TB");
    expect(pairingList).not.toHaveTextContent("配对依据");
    expect(pairingList).toHaveTextContent("序时账 JE");
    expect(container.querySelectorAll(".tbje-group-row")).toHaveLength(1);
    expect(screen.getByLabelText("为第 1 组选择序时账")).toBeInTheDocument();
    expect(screen.getByLabelText("为第 1 组选择序时账")).toHaveAttribute(
      "title",
      "C:/samples/01JE.xlsx",
    );
    expect(screen.getByRole("button", { name: "01TB.xlsx" })).toHaveAttribute(
      "title",
      "C:/samples/01TB.xlsx（点击更换）",
    );
    const tbMapping = screen.getByRole("button", {
      name: "查看并调整 TB 映射",
    });
    const jeMapping = screen.getByRole("button", {
      name: "查看并调整 JE 映射",
    });
    expect(tbMapping).toBeEnabled();
    expect(jeMapping).toBeEnabled();
    expect(screen.queryByText("科目余额表字段映射")).not.toBeInTheDocument();
    expect(screen.queryByText("序时账字段映射")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /TB 缺少 .*必填映射/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /JE 缺少 .*必填映射/ }),
    ).toBeVisible();
    fireEvent.click(tbMapping);
    expect(screen.getByText("科目余额表字段映射")).toBeVisible();
    expect(container.querySelector(".tbje-group")).toHaveAttribute(
      "data-ui-state",
      "expanded",
    );
    fireEvent.click(jeMapping);
    expect(screen.getByText("序时账字段映射")).toBeVisible();
    expect(screen.queryByText("科目余额表字段映射")).not.toBeInTheDocument();
    const steps = container.querySelector(".step-indicator") as HTMLElement;
    expect(
      within(steps).getByRole("button", { name: /确认配对/ }),
    ).toBeEnabled();
    fireEvent.click(within(steps).getByRole("button", { name: /添加文件/ }));
    expect(
      screen.getByRole("heading", { level: 2, name: "1. 添加 TB 与 JE 文件" }),
    ).toBeVisible();
    // 配对区在第一步原样保留，用户回来时仍能看到并管理已导入的文件。
    expect(
      screen.getByRole("heading", { level: 2, name: /2\. 确认配对与字段/ }),
    ).toBeVisible();
  });

  it("keeps the imported groups visible when returning to the add-files step", async () => {
    const { engineCall, pickPath } = await import("./api");
    vi.mocked(pickPath).mockResolvedValue([
      "C:/samples/01TB.xlsx",
      "C:/samples/01JE.xlsx",
    ]);
    vi.mocked(engineCall).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "ledger.forms") return [];
        const source = (params as { source: { inputPath: string } }).source;
        const isTb = source.inputPath.includes("TB");
        if (method === "deposit.classify_source") {
          return {
            kind: isTb ? "tb" : "je",
            sheet: "Sheet1",
            headerRow: 1,
            headerDepth: 1,
          };
        }
        return {
          sheet: "Sheet1",
          headerRow: 1,
          headerDepth: 1,
          headers: isTb ? ["科目编码", "期末余额"] : ["科目编码", "借方金额"],
          preview: [],
          entities: ["主体 A"],
          suggestedMapping: {},
        };
      },
    );

    const { container } = render(<TbjeCheckPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 2, name: /2\. 确认配对与字段/ }),
      ).toBeInTheDocument(),
    );

    // 回到第一步：配对区原样保留在下方，文件可见、可换、能直接移除本组。
    const steps = container.querySelector(".step-indicator") as HTMLElement;
    fireEvent.click(
      within(steps).getByRole("button", { name: /添加文件/ }),
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "1. 添加 TB 与 JE 文件" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "01TB.xlsx" })).toBeVisible();
    expect(screen.getByRole("button", { name: "01JE.xlsx" })).toBeVisible();
    expect(screen.getByRole("button", { name: "移除本组" })).toBeVisible();

    fireEvent.click(
      within(steps).getByRole("button", { name: /确认配对/ }),
    );
    expect(
      screen.queryByRole("heading", {
        level: 2,
        name: "1. 添加 TB 与 JE 文件",
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps a signed functional amount mapping after a no-op pair review", async () => {
    const { engineCall, jobStart, pickPath } = await import("./api");
    vi.mocked(pickPath).mockResolvedValue([
      "C:/samples/03科目余额表.xlsx",
      "C:/samples/03序时账 (2).xlsx",
    ]);
    vi.mocked(engineCall).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "ledger.forms") return [];
        if (method === "ledger.review_pair_mapping")
          return { tbChanges: [], jeChanges: [], pairFindings: [] };
        if (method === "ledger.check_mapping_alignment")
          return { aligned: true, warnings: [] };
        const source = (params as { source: { inputPath: string } }).source;
        const isTb = source.inputPath.includes("科目余额表");
        if (method === "deposit.classify_source") {
          return {
            kind: isTb ? "tb" : "je",
            sheet: "Sheet1",
            headerRow: isTb ? 2 : 5,
            headerDepth: 1,
          };
        }
        return {
          sheet: "Sheet1",
          headerRow: isTb ? 2 : 5,
          headerDepth: 1,
          headers: isTb
            ? [
                "项目编码、文本/科目编码、文本",
                "本年金额-期初",
                "本年金额-借方发生",
                "本年金额-贷方发生",
                "期末余额",
              ]
            : ["凭证编号", "凭证日期", "本币金额", "总账科目", "会计科目"],
          preview: [],
          entities: [],
          suggestedMapping: isTb
            ? {
                accountCode: "项目编码、文本/科目编码、文本",
                accountName: ["项目编码、文本/科目编码、文本"],
                openingFunctionalAmount: "本年金额-期初",
                ytdFunctionalDebit: "本年金额-借方发生",
                ytdFunctionalCredit: "本年金额-贷方发生",
                closingFunctionalAmount: "期末余额",
              }
            : {
                id: ["凭证编号"],
                date: "凭证日期",
                functionalAmount: "本币金额",
                accountCode: "总账科目",
                accountName: ["会计科目"],
              },
        };
      },
    );

    const { container } = render(<TbjeCheckPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );
    await screen.findByText("03科目余额表.xlsx");
    fireEvent.click(
      screen.getByRole("button", { name: "LLM 一键联合复核 1 组" }),
    );
    await screen.findByText("联合复核完成：已复核 1 组。");
    expect(screen.getByText("已复核 · 无需调整")).toBeVisible();
    expect(
      vi.mocked(engineCall).mock.calls.some(([method]) => method === "ledger.auxiliary_link"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "开始核对 1 组" }));

    await waitFor(() =>
      expect(jobStart).toHaveBeenCalledWith(
        "tbje_check.run_batch",
        expect.objectContaining({
          groups: [
            expect.objectContaining({
              jeMapping: expect.objectContaining({
                functionalAmount: "本币金额",
              }),
            }),
          ],
        }),
      ),
    );
    expect(
      vi.mocked(engineCall).mock.calls.some(([method]) => method === "ledger.auxiliary_link"),
    ).toBe(true);
  });

  it("allows LLM review to compose the TBJE voucher date from month and day columns", async () => {
    const { engineCall, jobStart, pickPath } = await import("./api");
    vi.mocked(pickPath).mockResolvedValue([
      "C:/samples/09科目余额表.xlsx",
      "C:/samples/09序时账.xlsx",
    ]);
    vi.mocked(engineCall).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "ledger.forms") return [];
        if (method === "ledger.check_mapping_alignment")
          return { aligned: true, warnings: [] };
        if (method === "ledger.review_pair_mapping")
          return {
            tbChanges: [],
            jeChanges: [
              {
                role: "date",
                currentColumn: "",
                suggestedColumn: "年-月",
                confidence: 0.9,
                reason: "月份组成列",
              },
              {
                role: "date",
                currentColumn: "",
                suggestedColumn: "年-日",
                confidence: 0.9,
                reason: "日期组成列",
              },
            ],
            pairFindings: [],
          };
        const source = (params as { source: { inputPath: string } }).source;
        const isTb = source.inputPath.includes("科目余额表");
        if (method === "deposit.classify_source")
          return {
            kind: isTb ? "tb" : "je",
            sheet: "Sheet1",
            headerRow: 1,
            headerDepth: 1,
          };
        return {
          sheet: "Sheet1",
          headerRow: 1,
          headerDepth: 1,
          headers: isTb
            ? ["科目编码", "科目名称", "期末余额"]
            : [
                "年-月",
                "年-日",
                "凭证号",
                "科目编码",
                "科目名称",
                "摘要",
                "借方",
                "贷方",
              ],
          preview: isTb
            ? [["1001", "库存现金", "10"]]
            : [["1", "9", "0001", "1001", "库存现金", "收款", "10", ""]],
          entities: [],
          suggestedMapping: isTb
            ? {
                accountCode: "科目编码",
                accountName: ["科目名称"],
                closingFunctionalAmount: "期末余额",
              }
            : {
                id: ["凭证号"],
                accountCode: "科目编码",
                accountName: ["科目名称"],
                summary: "摘要",
                functionalDebit: "借方",
                functionalCredit: "贷方",
              },
        };
      },
    );

    const { container } = render(<TbjeCheckPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );
    await screen.findByText("09科目余额表.xlsx");
    expect(screen.getByRole("button", { name: /JE 缺少 1 项必填映射/ })).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "LLM 一键联合复核 1 组" }),
    );
    await screen.findByText("联合复核完成：已复核 1 组。");
    expect(screen.getAllByText("已复核 · 2 项建议待确认")).not.toHaveLength(0);
    fireEvent.click(screen.getAllByRole("button", { name: "采纳" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "采纳" })[0]);
    expect(
      screen.queryByRole("button", { name: /JE 缺少 .*必填映射/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始核对 1 组" }));
    await waitFor(() =>
      expect(jobStart).toHaveBeenCalledWith(
        "tbje_check.run_batch",
        expect.objectContaining({
          groups: [
            expect.objectContaining({
              jeMapping: expect.objectContaining({
                date: ["年-月", "年-日"],
              }),
            }),
          ],
        }),
      ),
    );
  });

  it("names the failed group and still checks the rest when alignment fails", async () => {
    const { engineCall, jobStart, pickPath } = await import("./api");
    vi.mocked(pickPath).mockResolvedValue([
      "C:/samples/01科目余额表.xlsx",
      "C:/samples/01序时账.xlsx",
      "C:/samples/02科目余额表.xlsx",
      "C:/samples/02序时账.xlsx",
    ]);
    vi.mocked(engineCall).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "ledger.forms") return [];
        if (method === "ledger.check_mapping_alignment") {
          const failed = (params as { tbSource?: { inputPath?: string } })
            .tbSource?.inputPath?.includes("01科目余额表");
          return failed
            ? {
                aligned: false,
                errors: ["科目字段无法对齐的错误说明。"],
                warnings: [],
              }
            : { aligned: true, warnings: [] };
        }
        const source = (params as { source: { inputPath: string } }).source;
        const isTb = source.inputPath.includes("科目余额表");
        if (method === "deposit.classify_source") {
          return {
            kind: isTb ? "tb" : "je",
            sheet: "Sheet1",
            headerRow: 1,
            headerDepth: 1,
          };
        }
        return {
          sheet: "Sheet1",
          headerRow: 1,
          headerDepth: 1,
          headers: isTb
            ? ["科目编码", "科目名称", "本年累计借方", "本年累计贷方"]
            : ["日期", "凭证号", "科目编码", "科目名称", "借方", "贷方"],
          preview: [],
          entities: [],
          suggestedMapping: isTb
            ? {
                accountCode: "科目编码",
                accountName: ["科目名称"],
                ytdFunctionalDebit: "本年累计借方",
                ytdFunctionalCredit: "本年累计贷方",
              }
            : {
                date: "日期",
                id: ["凭证号"],
                accountCode: "科目编码",
                accountName: ["科目名称"],
                functionalDebit: "借方",
                functionalCredit: "贷方",
              },
        };
      },
    );

    render(<TbjeCheckPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );
    await screen.findByText("02科目余额表.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "开始核对 2 组" }));

    await waitFor(() =>
      expect(jobStart).toHaveBeenCalledWith(
        "tbje_check.run_batch",
        expect.objectContaining({
          groups: [
            expect.objectContaining({
              tbSource: expect.objectContaining({
                inputPath: "C:/samples/02科目余额表.xlsx",
              }),
            }),
          ],
        }),
      ),
    );
    const banner = await screen.findByText(/已跳过/, { exact: false });
    expect(banner.textContent).toContain(
      "「1」组（01科目余额表.xlsx × 01序时账.xlsx）：科目字段无法对齐的错误说明。",
    );
  });

  it("keeps result columns aligned and explains a zero balance with unclassified accounts", async () => {
    const { listenJobEvents } = await import("./api");
    vi.mocked(listenJobEvents).mockImplementation(async (callback) => {
      callback({
        jobId: "job-result",
        toolId: "tbje_check",
        phase: "done",
        current: 1,
        total: 1,
        message: "核对完成",
        severity: "success",
        outputPaths: [],
        result: {
          groups: [
            {
              label: "5",
              ok: true,
              result: {
                rollforward: {
                  performed: true,
                  passed: true,
                  checked: 12,
                  mismatched: 0,
                },
                tbVsJe: {
                  performed: true,
                  passed: false,
                  sidePassed: false,
                  netPassed: true,
                  accounts: 383,
                  mismatched: 175,
                  netMismatched: 0,
                },
                equation: {
                  performed: true,
                  passed: false,
                  balancePassed: true,
                  classificationComplete: false,
                  closing: { byCategory: [], total: 0, balanced: true },
                  unclassified: Array.from({ length: 6 }, (_, index) => ({
                    sourceRow: index + 1,
                    code: `X${index}`,
                    name: "自定义科目",
                    opening: 0,
                    closing: 0,
                  })),
                },
              },
            },
          ],
        },
      });
      return () => undefined;
    });

    const { container } = render(<TbjeCheckPage tool={tool} />);

    await screen.findByRole("heading", { level: 2, name: "3. 查看核对结果" });
    const table = screen.getByRole("table", { name: "TB/JE 完整性核对结果" });
    expect(screen.getByText(/结果表可左右滚动/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "核对结果表，可横向滚动" })).toHaveAttribute("tabindex", "0");
    expect(table.querySelectorAll("colgroup col")).toHaveLength(5);
    for (const name of [
      "TB 发生额与余额勾稽",
      "TB 与 JE 发生额勾稽",
      "BS 与 PL 勾稽",
    ]) {
      expect(within(table).getByRole("columnheader", { name })).toBeVisible();
    }
    expect(within(table).getByText("分类待确认")).toBeVisible();
    expect(within(table).getByText("净额通过，单边发生额有差异")).toBeVisible();
    expect(
      within(table).getByText("全部方向可靠科目合计 0.00 · 6 个科目待补分类"),
    ).toBeVisible();
    const preview = within(table).getByRole("button", { name: "预览明细" });
    expect(preview).toHaveAttribute("data-variant", "default");
    expect(container).not.toHaveTextContent("① 勾稽");

    const search = screen.getByRole("textbox", { name: "搜索核对结果" });
    fireEvent.change(search, { target: { value: "不存在的科目" } });
    expect(screen.getByText("显示 0 / 1 组")).toBeVisible();
    expect(within(table).queryByText("分类待确认")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "X1" } });
    expect(screen.getByText("显示 1 / 1 组")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "只看需复核" }));
    expect(screen.getByText("显示 1 / 1 组")).toBeVisible();
  });

  it("exports every successful result with one folder selection", async () => {
    const { engineCall, jobStart, listenJobEvents, pickPath } =
      await import("./api");
    vi.mocked(pickPath)
      .mockResolvedValueOnce(["C:/samples/01TB.xlsx", "C:/samples/01JE.xlsx"])
      .mockResolvedValueOnce("C:/exports/tbje");
    vi.mocked(engineCall).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "ledger.forms") return [];
        if (method === "ledger.check_mapping_alignment")
          return { aligned: true, warnings: [] };
        const source = (params as { source: { inputPath: string } }).source;
        const isTb = source.inputPath.includes("TB");
        if (method === "deposit.classify_source") {
          return {
            kind: isTb ? "tb" : "je",
            sheet: "Sheet1",
            headerRow: 1,
            headerDepth: 1,
          };
        }
        return {
          sheet: "Sheet1",
          headerRow: 1,
          headerDepth: 1,
          headers: ["科目编码"],
          preview: [],
          entities: ["主体 A"],
          suggestedMapping: { accountCode: "科目编码" },
        };
      },
    );
    let emit: ((event: never) => void) | undefined;
    vi.mocked(listenJobEvents).mockImplementation(async (callback) => {
      emit = callback as (event: never) => void;
      return () => undefined;
    });

    const { container } = render(<TbjeCheckPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );
    await screen.findByText("01TB.xlsx");
    await waitFor(() => expect(emit).toBeTypeOf("function"));
    act(() => {
      emit?.({
        jobId: "__inputs_changed__",
        toolId: "tbje_check",
        phase: "completed",
        current: 1,
        total: 1,
        message: "核对完成",
        severity: "success",
        outputPaths: [],
        result: {
          groups: [
            {
              label: "1",
              ok: true,
              result: {
                rollforward: { performed: true, passed: true },
                tbVsJe: { performed: true, passed: true },
                equation: { performed: true, passed: true },
              },
            },
          ],
        },
      } as never);
    });
    const button = await screen.findByRole("button", {
      name: "导出全部结果",
    });
    expect(screen.getByText("全部核对通过")).toBeVisible();
    fireEvent.click(button);

    await waitFor(() =>
      expect(jobStart).toHaveBeenCalledWith("tbje_check.export_batch", expect.objectContaining({
        groups: [
          {
            label: "1",
            tbSource: {
              inputPath: "C:/samples/01TB.xlsx",
              sheet: "Sheet1",
              headerRow: 1,
              headerDepth: 1,
            },
            tbMapping: { accountCode: "科目编码" },
            jeSource: {
              inputPath: "C:/samples/01JE.xlsx",
              sheet: "Sheet1",
              headerRow: 1,
              headerDepth: 1,
            },
            jeMapping: { accountCode: "科目编码" },
            entityScope: { mode: "strict", mappings: [] },
          },
        ],
        outputDirectory: "C:/exports/tbje",
        __restoreSnapshot: expect.objectContaining({ version: 1 }),
      })),
    );

    // 参数变化后不删掉上一版结果：可回看，但明确标为待重算并禁止导出。
    act(() => {
      emit?.({
        jobId: "job-1",
        toolId: "tbje_check",
        phase: "completed",
        current: 1,
        total: 1,
        message: "导出完成",
        severity: "success",
        outputPaths: [],
        result: { outputDirectory: "C:/exports/tbje" },
      } as never);
    });
    fireEvent.click(screen.getByRole("button", { name: "检查映射" }));
    fireEvent.change(screen.getByLabelText("为第 1 组选择序时账"), {
      target: { value: "" },
    });
    const steps = container.querySelector(".step-indicator") as HTMLElement;
    fireEvent.click(within(steps).getByRole("button", { name: /查看结果/ }));
    expect(screen.getByText("结果待重算")).toBeVisible();
    expect(screen.getByRole("button", { name: "导出全部结果" })).toBeDisabled();
    expect(screen.getByRole("table", { name: "TB/JE 完整性核对结果" })).toBeVisible();
  });

  it("removes all groups with one action without deleting the source files", async () => {
    const { engineCall, pickPath } = await import("./api");
    vi.mocked(pickPath).mockResolvedValue([
      "C:/samples/01TB.xlsx",
      "C:/samples/01JE.xlsx",
    ]);
    vi.mocked(engineCall).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "ledger.forms") return [];
        if (method === "ledger.check_mapping_alignment")
          return { aligned: true, warnings: [] };
        const source = (params as { source: { inputPath: string } }).source;
        const isTb = source.inputPath.includes("TB");
        if (method === "deposit.classify_source") {
          return {
            kind: isTb ? "tb" : "je",
            sheet: "Sheet1",
            headerRow: 1,
            headerDepth: 1,
          };
        }
        return {
          sheet: "Sheet1",
          headerRow: 1,
          headerDepth: 1,
          headers: ["科目编码"],
          preview: [],
          entities: ["主体 A"],
          suggestedMapping: {},
        };
      },
    );
    render(
      <>
        <TbjeCheckPage tool={tool} />
        <ConfirmDialogHost />
      </>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );
    await screen.findByRole("button", { name: "移除全部" });

    // 取消路径：对话框出现后点「取消」，分组保持原样。
    fireEvent.click(screen.getByRole("button", { name: "移除全部" }));
    expect(
      await screen.findByText(
        "确认移除全部 1 组？只会清空本次核对，不会删除原文件。",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("01TB.xlsx")).toBeInTheDocument();

    // 确认路径：再点「移除全部」并点「移除」，分组被清空且原文件不受影响。
    fireEvent.click(screen.getByRole("button", { name: "移除全部" }));
    await screen.findByText(
      "确认移除全部 1 组？只会清空本次核对，不会删除原文件。",
    );
    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    await waitFor(() =>
      expect(screen.queryByText("01TB.xlsx")).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("heading", { level: 2, name: /确认配对/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps manual pairing decisions when files are added a second time", async () => {
    const { engineCall, pickPath } = await import("./api");
    vi.mocked(pickPath)
      .mockResolvedValueOnce(["C:/samples/01TB.xlsx", "C:/samples/05JE.xlsx"])
      .mockResolvedValueOnce(["C:/samples/02TB.xlsx", "C:/samples/02JE.xlsx"]);
    vi.mocked(engineCall).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "ledger.forms") return [];
        if (method === "ledger.check_mapping_alignment")
          return { aligned: true, warnings: [] };
        const source = (params as { source: { inputPath: string } }).source;
        const isTb = source.inputPath.includes("TB");
        if (method === "deposit.classify_source") {
          return {
            kind: isTb ? "tb" : "je",
            sheet: "Sheet1",
            headerRow: 1,
            headerDepth: 1,
          };
        }
        return {
          sheet: "Sheet1",
          headerRow: 1,
          headerDepth: 1,
          headers: isTb ? ["科目编码", "期末余额"] : ["科目编码", "借方金额"],
          preview: [],
          entities: ["主体 A"],
          suggestedMapping: {},
        };
      },
    );

    const { container } = render(<TbjeCheckPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 2, name: /2\. 确认配对与字段/ }),
      ).toBeInTheDocument(),
    );
    expect(container.querySelectorAll(".tbje-group-row")).toHaveLength(1);

    // 05JE 没有 TB 也必须显示空槽位，用户才知道下一步需要补什么。
    fireEvent.change(screen.getByLabelText("为第 1 组选择序时账"), {
      target: { value: "" },
    });
    expect(container.querySelectorAll(".tbje-group-row")).toHaveLength(2);

    // 回到第 1 步，二次添加另一组文件。
    const steps = container.querySelector(".step-indicator") as HTMLElement;
    fireEvent.click(within(steps).getByRole("button", { name: /添加文件/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );

    await waitFor(() =>
      expect(container.querySelectorAll(".tbje-group-row")).toHaveLength(3),
    );
    // 第 1 组仍保持「不配对」，5 号序时账也没被强行塞回去。
    expect(screen.getByLabelText("为第 1 组选择序时账")).toHaveValue("");
    expect(screen.getByLabelText("为第 5 组选择序时账")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("为第 1 组选择序时账")).getByRole(
        "option",
        { name: /05JE\.xlsx/ },
      ),
    ).toBeInTheDocument();
    // 新加的 2 号文件自动配成新组，二次添加仍具备跨批次配对能力。
    expect(screen.getByLabelText("为第 2 组选择序时账")).toHaveValue(
      pairingFileKey({ path: "C:/samples/02JE.xlsx", sheet: "Sheet1" }),
    );
    expect(
      screen.getByRole("heading", { level: 2, name: /2\. 确认配对与字段/ }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /查看并调整 JE 映射/ }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("科目余额表字段映射")).not.toBeInTheDocument();
  });

  it("显示孤立 JE，并允许手工选择两侧 Excel 与 Sheet 建组", async () => {
    const { engineCall, pickPath } = await import("./api");
    vi.mocked(pickPath)
      .mockResolvedValueOnce("C:/samples/TB-4800.xlsx")
      .mockResolvedValueOnce("C:/samples/4800_JE.xlsx");
    vi.mocked(engineCall).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "ledger.forms") return [];
        const source = (params as { source?: { inputPath?: string; sheet?: string } })
          .source;
        if (method === "fx.inspect_tb")
          return {
            sheet: source?.sheet || "Sheet1",
            sheets: ["Sheet1", "tb种类"],
            headerRow: 3,
            headerDepth: 2,
            headers: ["科目编码", "期末余额"],
            preview: [["1001010000 库存现金", "100"]],
            entities: [],
            suggestedMapping: {},
          };
        if (method === "fx.inspect_je")
          return {
            sheet: source?.sheet || "JE",
            sheets: ["JE", "je种类"],
            headerRow: 2,
            headerDepth: 1,
            headers: ["凭证号", "借方金额"],
            preview: [["记-1", "100"]],
            entities: [],
            suggestedMapping: {},
          };
        throw new Error(`unexpected ${method}`);
      },
    );

    render(<TbjeCheckPage tool={tool} />);
    fireEvent.click(screen.getByRole("button", { name: "手动添加 TB 组" }));
    await screen.findByRole("button", { name: "TB-4800.xlsx" });
    expect(screen.getByLabelText("余额表使用的工作表")).toHaveValue("Sheet1");
    fireEvent.change(screen.getByLabelText("余额表使用的工作表"), {
      target: { value: "tb种类" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("余额表使用的工作表")).toHaveValue("tb种类"),
    );
    expect(engineCall).toHaveBeenCalledWith(
      "fx.inspect_tb",
      {
        source: { inputPath: "C:/samples/TB-4800.xlsx", sheet: "tb种类", headerRow: 0, headerDepth: 0 },
      },
      // 第三个参数是给等待弹窗的明细（文件名 / Sheet），不进引擎参数。
      "TB-4800.xlsx / tb种类",
    );
    fireEvent.click(screen.getByRole("button", { name: "查看并调整 TB 映射" }));
    const tbPanel = screen.getByText("科目余额表字段映射").closest("section")!;
    const subjectSelect = () => tbPanel.querySelector(".dt-header-control select") as HTMLSelectElement;
    fireEvent.change(subjectSelect(), { target: { value: "accountCode" } });
    fireEvent.change(subjectSelect(), { target: { value: "accountName" } });
    expect(subjectSelect().querySelector("option")?.textContent).toBe("科目编码 ＋ 科目名称");
    fireEvent.click(screen.getByRole("button", { name: "选择 JE Excel" }));
    await screen.findByRole("button", { name: "4800_JE.xlsx" });
    expect(screen.getByLabelText("序时账使用的工作表")).toHaveValue("JE");
    expect(
      screen.queryByRole("button", { name: "更换 Excel" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("（缺科目余额表）")).not.toBeInTheDocument();
  });

  it("单 Sheet 的 TB 与 JE 都显示同样的工作表控件", async () => {
    const { engineCall, pickPath } = await import("./api");
    vi.mocked(pickPath)
      .mockResolvedValueOnce("C:/samples/01TB.xlsx")
      .mockResolvedValueOnce("C:/samples/01JE.xlsx");
    vi.mocked(engineCall).mockImplementation(async (method: string, params: unknown) => {
      if (method === "ledger.forms") return [];
      return {
        sheet: "Sheet1", sheets: ["Sheet1"], headerRow: 1, headerDepth: 1,
        headers: ["科目编码"], preview: [], entities: [], suggestedMapping: {},
      };
    });
    render(<TbjeCheckPage tool={tool} />);
    fireEvent.click(screen.getByRole("button", { name: "手动添加 TB 组" }));
    const tb = await screen.findByLabelText("余额表使用的工作表");
    fireEvent.click(screen.getByRole("button", { name: "选择 JE Excel" }));
    const je = await screen.findByLabelText("序时账使用的工作表");
    expect(tb).toBeDisabled();
    expect(je).toBeDisabled();
  });

  it("re-picking an already added file keeps its inspection and mapping untouched", async () => {
    const { engineCall, pickPath } = await import("./api");
    vi.mocked(pickPath)
      .mockResolvedValueOnce(["C:/samples/01TB.xlsx", "C:/samples/01JE.xlsx"])
      .mockResolvedValueOnce(["C:/samples/01TB.xlsx"]);
    const classifyCalls: string[] = [];
    vi.mocked(engineCall).mockImplementation(
      async (method: string, params: unknown) => {
        if (method === "ledger.forms") return [];
        if (method === "ledger.check_mapping_alignment")
          return { aligned: true, warnings: [] };
        const source = (params as { source: { inputPath: string } }).source;
        const isTb = source.inputPath.includes("TB");
        if (method === "deposit.classify_source") {
          classifyCalls.push(source.inputPath);
          return {
            kind: isTb ? "tb" : "je",
            sheet: "Sheet1",
            headerRow: 1,
            headerDepth: 1,
          };
        }
        return {
          sheet: "Sheet1",
          headerRow: 1,
          headerDepth: 1,
          headers: ["科目编码"],
          preview: [],
          entities: ["主体 A"],
          suggestedMapping: {},
        };
      },
    );

    const { container } = render(<TbjeCheckPage tool={tool} />);
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".tbje-group-row")).toHaveLength(1),
    );
    expect(classifyCalls).toEqual([
      "C:/samples/01TB.xlsx",
      "C:/samples/01JE.xlsx",
    ]);

    // 重复选入同一份 TB：不再重新识别，配对原样保留。
    const steps = container.querySelector(".step-indicator") as HTMLElement;
    fireEvent.click(within(steps).getByRole("button", { name: /添加文件/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /把多组 TB 与 JE 一起拖进来/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 2, name: /2\. 确认配对与字段/ }),
      ).toBeInTheDocument(),
    );
    expect(classifyCalls).toEqual([
      "C:/samples/01TB.xlsx",
      "C:/samples/01JE.xlsx",
    ]);
    expect(container.querySelectorAll(".tbje-group-row")).toHaveLength(1);
    expect(screen.getByLabelText("为第 1 组选择序时账")).toHaveValue(
      pairingFileKey({ path: "C:/samples/01JE.xlsx", sheet: "Sheet1" }),
    );
  });
});
