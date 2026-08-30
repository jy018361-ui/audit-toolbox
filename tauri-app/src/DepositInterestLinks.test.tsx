// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DepositInterestPage } from "./DepositInterestPage";
import type { ToolManifest } from "./types";

const openReferenceUrl = vi.fn().mockResolvedValue(undefined);
const engineCall = vi.fn();

vi.mock("./api", () => ({
  engineCall: (...args: unknown[]) => engineCall(...args),
  jobCancel: vi.fn(),
  jobStart: vi.fn(),
  listenJobEvents: vi.fn().mockResolvedValue(() => undefined),
  listenPositionedFileDrops: vi.fn().mockResolvedValue(() => undefined),
  openOutput: vi.fn(),
  openReferenceUrl: (...args: unknown[]) => openReferenceUrl(...args),
  pickPath: vi.fn().mockResolvedValue(null),
}));

const tiers = {
  benchmarkDate: "2015-10-24", listedDate: "2025-05-20",
  benchmarkSource: "央行来源说明", listedSource: "挂牌来源说明",
  practiceSource: "实务区间说明", authority: "审计依据说明",
  autoApplyPolicy: "只有活期自动套用默认利率。",
  listedRateDate: "2025-05-20", rateAgeMonths: 15, ratesStale: true,
  staleMessage: "内置挂牌利率最后更新于 2025-05-20，请核对最新挂牌利率。",
  linkGroups: [
    {key: "official", label: "官方发布渠道", hint: "权威出处"},
    {key: "bank", label: "各行挂牌利率表", hint: "实际计息参照"},
  ],
  links: [
    {label: "中国人民银行", url: "http://www.pbc.gov.cn/", hint: "利率政策栏目", group: "official"},
    {label: "中国货币网（全国银行间同业拆借中心）", url: "https://www.chinamoney.com.cn/", hint: "自律机制公告", group: "official"},
    {label: "国家外汇管理局", url: "https://www.safe.gov.cn/", hint: "外币存款政策", group: "official"},
    {label: "中国工商银行", url: "https://www.icbc.com.cn/", hint: "挂牌利率表", group: "bank"},
  ],
  categories: [{key: "demand", label: "活期存款", terms: [{key: "demand", label: ""}]}],
  tiers: [{
    key: "demand", category: "demand", categoryLabel: "活期存款", termLabel: "", label: "活期存款",
    benchmarkRate: 0.0035, listedRate: 0.0005, autoApply: true,
    practiceLow: 0.0005, practiceHigh: 0.0035, practiceNote: "对公活期没有议价空间。",
  }],
};

const tool: ToolManifest = {
  id: "deposit_interest", name: "存款利息收入测算", description: "",
  route: "/tools/deposit_interest", version: "test", capabilities: [], migrationStatus: "ready",
};

/** 利率档位与官方查询入口在第二步「科目与利率确认」里，渲染后先切过去。 */
function openRunStep() {
  // 步骤按钮的可访问名带序号（「2 科目与利率确认」），按序号锚定匹配。
  fireEvent.click(screen.getByRole("button", { name: /^2\s*科目与利率确认/ }));
}

describe("官方利率查询入口", () => {
  // 这个文件里多次 render 同一个页面，不清理会出现重名元素。
  afterEach(cleanup);
  it("首行只露出官方渠道，其余收进折叠区", async () => {
    engineCall.mockResolvedValue(tiers);
    render(<DepositInterestPage tool={tool} />);
    openRunStep();
    const section = await screen.findByRole("region", {name: "官方利率查询入口"});
    // 首行 = 标题 + 3 个官方渠道按钮，没有别的。
    const row = section.querySelector(".deposit-link-row") as HTMLElement;
    const primary = within(row).getAllByRole("button");
    expect(primary.map((b) => b.textContent?.replace("↗", ""))).toEqual([
      "中国人民银行", "中国货币网（全国银行间同业拆借中心）", "国家外汇管理局",
    ]);
    // 银行那一组默认折叠，链接仍在 DOM 里但父级 details 是收起的。
    const details = section.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText(/各行挂牌利率表（1 家）/)).toBeInTheDocument();
    expect(within(details).getByRole("button", {name: /中国工商银行/})).toBeInTheDocument();
  });

  it("点击后交给白名单命令打开系统浏览器", async () => {
    engineCall.mockResolvedValue(tiers);
    openReferenceUrl.mockClear().mockResolvedValue(undefined);
    render(<DepositInterestPage tool={tool} />);
    openRunStep();
    const button = await screen.findByRole("button", {name: /中国货币网/});
    fireEvent.click(button);
    await waitFor(() => expect(openReferenceUrl).toHaveBeenCalledWith("https://www.chinamoney.com.cn/"));
  });

  it("打不开浏览器时把网址退回剪贴板，不让用户卡住", async () => {
    engineCall.mockResolvedValue(tiers);
    openReferenceUrl.mockClear().mockRejectedValue(new Error("no browser"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {clipboard: {writeText}});
    render(<DepositInterestPage tool={tool} />);
    openRunStep();
    fireEvent.click(await screen.findByRole("button", {name: /中国人民银行/}));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("http://www.pbc.gov.cn/"));
    expect(await screen.findByText(/已把网址复制到剪贴板/)).toBeInTheDocument();
  });

  it("引擎不可用时给出说明而不是空白", async () => {
    engineCall.mockRejectedValue(new Error("预览模式"));
    render(<DepositInterestPage tool={tool} />);
    openRunStep();
    expect(await screen.findByText(/浏览器预览模式下不可用/)).toBeInTheDocument();
  });
});
