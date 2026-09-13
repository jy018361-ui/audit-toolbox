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

describe("AuxiliaryLinkStatusView 三态标注", () => {
  it("TB 未映射辅助列时不渲染", () => {
    const { container } = render(
      <AuxiliaryLinkStatusView result={result({ tbAuxMapped: false })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("验证通过显示命中数与覆盖率", () => {
    render(<AuxiliaryLinkStatusView result={result({})} />);
    expect(screen.getByText(/已验证：JE「部门」/)).toBeInTheDocument();
    expect(screen.getByText(/3\/3 维度命中，覆盖率 82%/)).toBeInTheDocument();
  });

  it("对不上时按降级口径提示且不换列", () => {
    render(
      <AuxiliaryLinkStatusView
        result={result({ status: "noMatch", column: null, anchorHits: 0 })}
      />,
    );
    expect(screen.getByText(/JE 无对应辅助核算列/)).toBeInTheDocument();
    expect(screen.getByText(/按主体＋科目归集/)).toBeInTheDocument();
  });

  it("覆盖不全提示结合未分维度行复核", () => {
    render(
      <AuxiliaryLinkStatusView
        result={result({ status: "partialCoverage", anchorHits: 2 })}
      />,
    );
    expect(screen.getByText(/覆盖不全（2\/3 维度命中）/)).toBeInTheDocument();
    expect(screen.getByText(/未分维度行/)).toBeInTheDocument();
  });

  it("多列候选提示手动指定", () => {
    render(
      <AuxiliaryLinkStatusView
        result={result({ status: "ambiguous", competingColumns: ["部门编码", "部门名称"] })}
      />,
    );
    expect(screen.getByText(/多列疑似辅助核算列（部门编码、部门名称）/)).toBeInTheDocument();
  });

  it("借款工具自定义维度标签", () => {
    render(
      <AuxiliaryLinkStatusView
        result={result({ status: "noMatch", column: null })}
        dimensionLabel="借款明细"
      />,
    );
    expect(screen.getByText(/JE 无对应借款明细列/)).toBeInTheDocument();
  });
});
