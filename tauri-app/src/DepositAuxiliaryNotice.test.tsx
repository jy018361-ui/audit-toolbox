// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Results } from "./DepositInterestPage";

afterEach(cleanup);
const props = { rows: [], expanded: "", onExpand: vi.fn(), onOverride: vi.fn(), onRecalculate: vi.fn(), busy: false };

describe("存款辅助核算降级明细", () => {
  it("默认折叠，展开后显示实际受影响账户、辅助明细和原因，可再次收起", () => {
    render(<Results {...props} result={{ summary: {
      auxiliaryWarnings: ["TB 已映射辅助核算，但 JE 无对应列。"],
      auxiliaryFallbackAccounts: [
        { key: "bank", entity: "默认主体", account: "1002 银行存款", currency: "本位币合并", auxiliaries: ["工行001", "建行002"], reason: "未找到已验证的 JE 对应辅助列。" },
        { key: "deposit", entity: "甲公司", account: "1012.02 存出保证金", currency: "CNY", auxiliaries: ["保证金003"], reason: "JE 辅助列未完整覆盖 TB 辅助明细。" },
      ],
    } }} />);
    const notice = screen.getByLabelText("辅助核算联动");
    const summary = notice.querySelector("summary")!;
    expect(summary).toHaveTextContent("2 个账户未按辅助核算拆分");
    expect(notice).not.toHaveAttribute("open");
    expect(screen.getByText(/未区分主体 \/ 1002 银行存款/)).not.toBeVisible();
    fireEvent.click(summary);
    expect(notice).toHaveAttribute("open");
    expect(screen.getByText(/未区分主体 \/ 1002 银行存款/)).toBeVisible();
    expect(screen.getByText("TB 辅助明细（2 项）：工行001、建行002")).toBeVisible();
    expect(screen.getByText("未拆分原因：JE 辅助列未完整覆盖 TB 辅助明细。")).toBeVisible();
    fireEvent.click(summary);
    expect(notice).not.toHaveAttribute("open");
  });

  it("历史结果只有通用告警时保留原因并说明需重算，不编造账户清单", () => {
    render(<Results {...props} result={{ summary: { auxiliaryWarnings: ["JE 无对应辅助列"] } }} />);
    const notice = screen.getByLabelText("辅助核算联动");
    fireEvent.click(notice.querySelector("summary")!);
    expect(screen.getByText("JE 无对应辅助列")).toBeVisible();
    expect(screen.getByText("此历史结果未记录受影响账户，请重新测算查看明细。")).toBeVisible();
    expect(notice).not.toHaveTextContent("以下账户");
  });

  it("没有辅助降级的结果不显示告警区", () => {
    render(<Results {...props} result={{ summary: { auxiliaryFallbackAccounts: [], auxiliaryWarnings: [] } }} />);
    expect(screen.queryByLabelText("辅助核算联动")).not.toBeInTheDocument();
  });
});
