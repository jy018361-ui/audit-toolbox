// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuxiliaryLinkStatusView } from "./AuxiliaryLinkStatus";
import type { AuxiliaryLinkResult } from "../ledgerMapping";

afterEach(cleanup);

function result(overrides: Partial<AuxiliaryLinkResult>): AuxiliaryLinkResult {
  return {
    tbAuxMapped: true,
    status: "verified",
    column: "部门",
    anchorHits: 3,
    anchorTotal: 3,
    coverage: 0.82,
    competingColumns: [],
    warnings: [],
    ...overrides,
  };
}

describe("AuxiliaryLinkStatusView 降级提示", () => {
  it("混合结果只提示退回数量，不逐主体科目列明细", () => {
    render(<AuxiliaryLinkStatusView result={result({
      groups: [
        { ...result({}), entity: "A", account: "1002" },
        { ...result({ status: "partialCoverage", anchorHits: 2 }), entity: "A", account: "2001" },
      ],
    })} />);
    expect(screen.getByText("TB/JE 辅助核算有 1 项无法匹配，已退回按主体＋科目计算；其余 1 项按辅助核算细分。")).toBeInTheDocument();
    expect(screen.queryByText(/A · 1002|A · 2001|覆盖不全/)).not.toBeInTheDocument();
  });

  it("全部退回时只显示一条直接的计算口径提示", () => {
    render(<AuxiliaryLinkStatusView result={result({
      groups: [
        { ...result({ status: "noMatch" }), entity: "A", account: "1002" },
        { ...result({ status: "ambiguous" }), entity: "B", account: "2001" },
      ],
    })} />);
    expect(screen.getAllByText("TB/JE 辅助核算无法匹配，已退回按主体＋科目计算。")).toHaveLength(1);
  });

  it("全部匹配成功时不增加提示", () => {
    const { container } = render(<AuxiliaryLinkStatusView result={result({
      groups: [
        { ...result({}), entity: "A", account: "1002" },
        { ...result({ column: "客户" }), entity: "A", account: "1122" },
      ],
    })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("TB 未映射辅助列时不渲染", () => {
    const { container } = render(
      <AuxiliaryLinkStatusView result={result({ tbAuxMapped: false })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("单一未匹配结果也显示简短降级口径", () => {
    render(<AuxiliaryLinkStatusView result={result({ status: "partialCoverage" })} />);
    expect(screen.getByText("TB/JE 辅助核算无法匹配，已退回按主体＋科目计算。")).toBeInTheDocument();
  });

  it("借款工具沿用同一提示并替换维度名称", () => {
    render(
      <AuxiliaryLinkStatusView
        result={result({ status: "noMatch", column: null })}
        dimensionLabel="借款明细"
      />,
    );
    expect(screen.getByText("TB/JE 借款明细无法匹配，已退回按主体＋科目计算。")).toBeInTheDocument();
  });
});
