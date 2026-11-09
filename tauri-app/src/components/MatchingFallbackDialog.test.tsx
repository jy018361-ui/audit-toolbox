// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {MatchingFallbackDialog} from "./MatchingFallbackDialog";

afterEach(cleanup);
it("必须明确选择，且缺有效日期或未选整码时禁用JE汇总", () => {
  const onChange = vi.fn();
  render(<MatchingFallbackDialog open groups={[{entity:"甲公司",accountCode:"2001",names:["银行甲","银行乙"],canUseJe:false}]} value="" onChange={onChange} onCancel={vi.fn()} onContinue={vi.fn()} />);
  expect(screen.getByRole("button",{name:"按所选口径继续"})).toBeDisabled();
  expect(screen.getByRole("radio",{name:/合并同码借款/})).toBeDisabled();
  fireEvent.click(screen.getByRole("radio",{name:/保留 TB 明细/}));
  expect(onChange).toHaveBeenCalledWith("tbAverage");
});
it("存款选择说明保持逐月口径并要求统一利率", () => {
  render(<MatchingFallbackDialog kind="deposit" open groups={[{entity:"甲公司",accountCode:"1002",names:["银行甲","银行乙"],canUseJe:true}]} value="accountJe" onChange={vi.fn()} onCancel={vi.fn()} onContinue={vi.fn()} />);
  expect(screen.getByRole("radio",{name:/合并同码存款，按 JE 还原逐月余额/})).toBeChecked();
  expect(screen.getByText(/合并后须统一填写利率/)).toBeVisible();
  expect(screen.queryByText(/实际日期逐日测算/)).toBeNull();
});
