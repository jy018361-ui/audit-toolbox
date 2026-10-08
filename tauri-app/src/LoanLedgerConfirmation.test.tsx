// @vitest-environment jsdom
import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blankDetailRow,
  LoanLedgerConfirmation,
  ledgerInformationErrors,
  splitDetailRows,
  zipDetailRows,
  type LedgerInformation,
} from "./LoanLedgerConfirmation";
const row: LedgerInformation = {
  rowKey: "a",
  loanId: "借款甲",
  entity: "甲公司",
  opening: 0,
  added: 10000000,
  reduced: 2000000,
  closing: 8000000,
  originalClosing: 8000000,
  rateType: "fixed",
  spreadBps: 0,
  fixedRate: 0.04,
  contractStart: "2025-04-01",
  contractEnd: "2026-03-31",
  additions: [
    { date: "2025-04-01", amount: 5000000, basis: "按合同开始日默认" },
    { date: "2025-05-01", amount: 5000000 },
  ],
  repayments: [{ date: "2025-06-01", amount: 2000000, basis: "台账提取" }],
};
/** 带状态的父组件：onEdit 回写状态，交互像真实使用一样串联。 */
function Harness({
  initial,
  onEdit,
}: {
  initial: LedgerInformation;
  onEdit: (row: LedgerInformation) => void;
}) {
  const [current, setCurrent] = useState(initial);
  return (
    <LoanLedgerConfirmation
      rows={[current]}
      start="2025-01-01"
      end="2025-12-31"
      busy={false}
      onEdit={(r) => {
        onEdit(r);
        setCurrent(r);
      }}
    />
  );
}
describe("台账信息确认", () => {
  afterEach(cleanup);

  it("允许多笔新增和还款，并校验汇总而不重复叠加", () => {
    expect(ledgerInformationErrors(row, "2025-01-01", "2025-12-31")).toEqual(
      [],
    );
    expect(
      ledgerInformationErrors(
        { ...row, added: 20000000 },
        "2025-01-01",
        "2025-12-31",
      ),
    ).toContain("新增明细少填 10,000,000.00");
  });
  it("空白期末只通过不平路径提示，手填期外日期具体说明截止日", () => {
    const errors = ledgerInformationErrors(
      {
        ...row,
        closing: null,
        repayments: [{ date: "2026-03-31", amount: 2000000 }],
      },
      "2025-01-01",
      "2025-12-31",
    );
    expect(errors).toContain("余额不平，差额 8,000,000.00");
    expect(errors).toContain("第 1 笔还款日期超过测算截止日 2025-12-31");
  });
  it("拒绝本金为负和不存在的日期", () => {
    expect(
      ledgerInformationErrors(
        { ...row, repayments: [{ date: "2025-02-30", amount: 2000000 }] },
        "2025-01-01",
        "2025-12-31",
      ),
    ).toContain("第 1 笔还款日期无效");
    expect(
      ledgerInformationErrors(
        { ...row, repayments: [{ date: "2025-01-02", amount: 2000000 }] },
        "2025-01-01",
        "2025-12-31",
      ),
    ).toContain("还款后本金为负，请检查日期和金额");
  });
  it("一行一笔渲染主表，金额与利率内联编辑，明细默认折叠", () => {
    const edit = vi.fn();
    render(<Harness initial={row} onEdit={edit} />);
    fireEvent.change(screen.getByLabelText("借款甲年初余额"), {
      target: { value: "100" },
    });
    expect(edit.mock.lastCall?.[0].opening).toBe(100);
    fireEvent.change(screen.getByLabelText("借款甲执行利率"), {
      target: { value: "0.05" },
    });
    expect(edit.mock.lastCall?.[0].fixedRate).toBe(0.05);
    expect(screen.queryByLabelText("借款甲新增日期1")).not.toBeInTheDocument();
  });
  it("行首＋展开明细，既有事件按行并排成四格", () => {
    const edit = vi.fn();
    render(<Harness initial={row} onEdit={edit} />);
    fireEvent.click(screen.getByLabelText("展开借款甲明细"));
    // 第1行：新增与还款并排；第2行：只有新增，还款侧留空。
    expect(screen.getByLabelText("借款甲新增日期1")).toHaveValue("2025-04-01");
    expect(screen.getByLabelText("借款甲还款日期1")).toHaveValue("2025-06-01");
    expect(screen.getByLabelText("借款甲新增日期2")).toHaveValue("2025-05-01");
    expect(screen.getByLabelText("借款甲还款日期2")).toHaveValue("");
    // 默认日期带来源提示，提示用户复核。
    expect(screen.getByText("按合同开始日默认")).toBeInTheDocument();
    expect(edit).not.toHaveBeenCalled();
  });
  it("展开且无明细时自动给一条空行，可无限添加且空行不产生事件", () => {
    const edit = vi.fn();
    render(
      <Harness initial={{ ...row, additions: [], repayments: [] }} onEdit={edit} />,
    );
    fireEvent.click(screen.getByLabelText("展开借款甲明细"));
    // 点＋即新增一条四格明细行。
    expect(edit.mock.lastCall?.[0].detailRows).toHaveLength(1);
    expect(screen.getByLabelText("借款甲新增日期1")).toHaveValue("");
    fireEvent.click(screen.getByText("＋ 添加明细"));
    expect(edit.mock.lastCall?.[0].detailRows).toHaveLength(2);
    // 空行不产生事件，引擎拿到的仍是空数组。
    expect(edit.mock.lastCall?.[0].additions).toHaveLength(0);
    expect(edit.mock.lastCall?.[0].repayments).toHaveLength(0);
    // 只填金额不填日期：事件保留，交给校验提示补日期。
    fireEvent.change(screen.getByLabelText("借款甲还款金额2"), {
      target: { value: "500" },
    });
    const payload = edit.mock.lastCall?.[0];
    expect(payload.repayments).toHaveLength(1);
    expect(payload.repayments[0]).toMatchObject({ date: "", amount: 500 });
    expect(
      ledgerInformationErrors(payload, "2025-01-01", "2025-12-31"),
    ).toContain("第 1 笔请填写还款日期");
  });
  it("编辑某一格只刷新该侧来源说明，删除明细整行移除", () => {
    const edit = vi.fn();
    render(<Harness initial={row} onEdit={edit} />);
    fireEvent.click(screen.getByLabelText("展开借款甲明细"));
    fireEvent.change(screen.getByLabelText("借款甲新增日期1"), {
      target: { value: "2025-04-02" },
    });
    let payload = edit.mock.lastCall?.[0];
    expect(payload.additions[0]).toMatchObject({
      date: "2025-04-02",
      basis: "人工修改",
    });
    // 未动过的还款侧保留引擎原始来源，不标人工。
    expect(payload.repayments[0]).toMatchObject({
      date: "2025-06-01",
      basis: "台账提取",
    });
    fireEvent.click(screen.getByRole("button", { name: "删除借款甲明细1" }));
    payload = edit.mock.lastCall?.[0];
    // 第1行两侧一起移除：剩下第2行的新增。
    expect(payload.additions).toHaveLength(1);
    expect(payload.additions[0].date).toBe("2025-05-01");
    expect(payload.repayments).toHaveLength(0);
    expect(payload.detailRows).toHaveLength(1);
  });
  it("界面明细行与引擎事件数组互转：空行不产生事件，半填的一侧保留待校验", () => {
    const details = [
      blankDetailRow(),
      { ...blankDetailRow(), addAmount: 500 },
      { ...blankDetailRow(), repayDate: "2025-06-01", repayAmount: 2000000 },
    ];
    const split = splitDetailRows(details);
    expect(split.additions).toEqual([
      { date: "", amount: 500, basis: "人工补充" },
    ]);
    expect(split.repayments).toEqual([
      { date: "2025-06-01", amount: 2000000, basis: "人工补充" },
    ]);
    // 引擎下发的行没有界面行序时按行号并排。
    expect(zipDetailRows({ ...row, detailRows: undefined })).toHaveLength(2);
    expect(zipDetailRows(row)[0].addBasis).toBe("按合同开始日默认");
  });

  it("期末空白但四栏平衡不红字，完全空白的新明细不改变通过状态", () => {
    const edit = vi.fn();
    const settled = { ...row, opening: 2000000, added: 0, reduced: 2000000, closing: null,
      additions: [], repayments: [{date:"2025-06-01", amount:2000000}] };
    render(<Harness initial={settled} onEdit={edit} />);
    expect(screen.getByText("通过")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("展开借款甲明细"));
    fireEvent.click(screen.getByText("＋ 添加明细"));
    expect(ledgerInformationErrors(edit.mock.lastCall?.[0], "2025-01-01", "2025-12-31")).toEqual([]);
    expect(screen.queryByText(/待处理 \d+ 项/)).not.toBeInTheDocument();
  });

  it("四列标题区分来源且无原始期末第五列；子行金额仍在对应主金额列", () => {
    const edit = vi.fn();
    const sourced: LedgerInformation = {...row, amountSources:{opening:"PBC",added:"推算",reduced:"推算",closing:"PBC"}};
    const {container} = render(<Harness initial={sourced} onEdit={edit} />);
    expect(screen.getByRole("columnheader", {name:"年初余额（PBC）"})).toBeInTheDocument();
    expect(screen.getByRole("columnheader", {name:"本期新增（推算）"})).toBeInTheDocument();
    expect(screen.getByRole("columnheader", {name:"期末余额（PBC）"})).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", {name:/台账原始期末/})).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("展开借款甲明细"));
    const main=container.querySelector(".loan-ledger-row")!;
    const detail=container.querySelector(".loan-ledger-details-row")!;
    expect(Array.from(main.children).indexOf(main.querySelector('[data-amount-field="added"]')!)).toBe(Array.from(detail.children).indexOf(detail.querySelector('[data-detail-field="added"]')!));
    expect(Array.from(main.children).indexOf(main.querySelector('[data-amount-field="reduced"]')!)).toBe(Array.from(detail.children).indexOf(detail.querySelector('[data-detail-field="reduced"]')!));
    expect(container.querySelectorAll("table")).toHaveLength(1);
  });

  it("编辑后具体错误红字显示在对应金额并标红缺失日期", () => {
    const edit=vi.fn();
    const {container}=render(<Harness initial={row} onEdit={edit} />);
    fireEvent.click(screen.getByLabelText("展开借款甲明细"));
    fireEvent.change(screen.getByLabelText("借款甲新增金额1"), {target:{value:"4000000"}});
    expect(container.querySelector('[data-amount-field="added"]')).toHaveTextContent("新增明细少填 1,000,000.00");
    expect(screen.getByRole("button",{name:/借款甲待处理/})).toHaveClass("bad");
    fireEvent.change(screen.getByLabelText("借款甲还款日期1"), {target:{value:""}});
    expect(screen.getByLabelText("借款甲还款日期1")).toHaveAttribute("aria-invalid","true");
    expect(container.querySelector('[data-amount-field="reduced"]')).toHaveTextContent("第 1 笔请填写还款日期");
  });
});
