// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AudiPickTaxWorkflow } from "./AudiPickTaxWorkflow";
import { buildTaxPageIndex } from "./audipickTax";
import type { AudiPickTaxWorkflowState } from "./audipickTaxPipeline";
const mocks=vi.hoisted(()=>({recognize:vi.fn()}));
vi.mock("./api",()=>({engineCall:vi.fn(),pickPath:vi.fn(),jobCancel:vi.fn(),jobPause:vi.fn()}));
vi.mock("./audipickExtractJob",()=>({runAudiPickExtractJob:vi.fn()}));
vi.mock("./audipickPdfPreparation",async()=>({...await vi.importActual("./audipickPdfPreparation"),recognizePdfPage:mocks.recognize}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function setup(onSave:(state:AudiPickTaxWorkflowState)=>Promise<void>) {
  const index=buildTaxPageIndex([{page:1,text:"增值税预缴税款表\n纳税人名称：测试有限公司\n税款所属期间：2020-05-01 至 2020-05-31"},{page:2,text:"申报回执"},{page:3,text:"看不清的页面"}],"样本.pdf");
  return render(<AudiPickTaxWorkflow documents={[{id:"a",name:"样本.pdf"}]} initialIndexes={{a:index}} loadPdf={vi.fn()} onSave={onSave} onClose={vi.fn()}/>);
}
it("只在页面目录确认，批量保存成功后显示确认并保留未知页复核",async()=>{
  let finish!:()=>void;
  const save=vi.fn((_state:AudiPickTaxWorkflowState)=>new Promise<void>(resolve=>{finish=resolve;}));
  const view=setup(save);
  expect(view.container.querySelector(".tax-review-groups,.tax-page-choice")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"一键确认识别结果"}));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("已人工确认")).not.toBeInTheDocument();
  expect(save.mock.calls[0][0].reviews?.a.map(group=>group.pages)).toEqual([[1],[2]]);
  finish();
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已一键确认 2 页。仍有 1 页需逐页复核"));
  expect(view.container.querySelector(".tax-review-groups,.tax-page-choice")).toBeNull();
  const row=screen.getByRole("button",{name:"样本.pdf 第 3 页 预览并确认"}).closest("tr")!;
  expect(within(row).getByText(/待复核/)).toBeInTheDocument();
  expect(screen.getByRole("checkbox",{name:/VAT_PREPAID/})).toBeChecked();
  expect(mocks.recognize).not.toHaveBeenCalled();
});
it("保存失败不显示确认，可直接重试",async()=>{
  const save=vi.fn().mockRejectedValueOnce(new Error("磁盘写入失败")).mockResolvedValue(undefined);
  setup(save);
  fireEvent.click(screen.getByRole("button",{name:"一键确认识别结果"}));
  await waitFor(()=>expect(screen.getByRole("alert")).toHaveTextContent("确认未保存：磁盘写入失败"));
  expect(screen.queryByText("已人工确认")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"一键确认识别结果"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已一键确认 2 页"));
  expect(save).toHaveBeenCalledTimes(2);
});
