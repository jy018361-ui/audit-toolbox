// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudiPickTaxWorkflow } from "./AudiPickTaxWorkflow";
import { buildTaxPageIndex, type TaxDocumentIndex } from "./audipickTax";
import { stampTaxReviewGroup } from "./audipickTaxReview";
import { TAX_PAGE_READER_VERSION } from "./audipickTaxPipeline";

const mocks = vi.hoisted(() => ({ engineCall: vi.fn(), pickPath: vi.fn(), recognize: vi.fn(), extract: vi.fn() }));
vi.mock("./api", () => ({ engineCall: mocks.engineCall, pickPath: mocks.pickPath, jobCancel: vi.fn(async () => {}), jobPause: vi.fn(async () => {}) }));
vi.mock("./audipickExtractJob", () => ({ runAudiPickExtractJob: mocks.extract }));
vi.mock("./audipickPdfPreparation", async () => ({ ...await vi.importActual("./audipickPdfPreparation"), recognizePdfPage: mocks.recognize }));

const form = { key: "A105000", formCode: "A105000", formName: "纳税调整项目明细表", taxType: "corporate_income" as const, pages: [1, 2] };
function index(): TaxDocumentIndex {
  const value=buildTaxPageIndex([1,2].map(page=>({page,text:"A105000 纳税调整项目明细表\n行次 项目 金额\n1 收入项目 100 200\n"+"本页为待核对申报资料，请确认所属期及页面归属。".repeat(4)})),"甲公司.pdf");
  return {...value,companyName:"甲公司",period:"2025年度"};
}
function fakePdf() {
  return { numPages: 2, destroy: vi.fn(async () => {}), getPage: vi.fn(async () => ({
    getViewport: () => ({ width: 800, height: 1000 }),
    getTextContent: async () => ({ items: [] }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    cleanup: vi.fn(),
  })) };
}
const doc = { id: "a", name: "甲公司.pdf" };
const commonProps = () => ({ documents: [doc], initialIndexes: { a: index() }, loadPdf: vi.fn(async () => fakePdf()), onSave: vi.fn(async (_state: unknown) => {}), onClose: vi.fn() });
const reviewButton = (page: number) => screen.getByRole("button", { name: `甲公司.pdf 第 ${page} 页 预览并确认` });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,dGVzdA==");
  mocks.recognize.mockResolvedValue("");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("税表人工复核", () => {
  it("逐页打开复核对话框，默认本文件表单并可搜索全部表单库", async () => {
    const props = commonProps();
    render(<AudiPickTaxWorkflow {...props} />);
    fireEvent.click(reviewButton(1));

    const dialog = await screen.findByRole("dialog", { name: "税表人工复核" });
    expect(within(dialog).getByLabelText(/公司名称/)).toHaveValue("甲公司");
    expect(within(dialog).getByLabelText(/所属期/)).toHaveValue("2025年度");
    expect(within(dialog).getByLabelText(/表单类型/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/PDF\s*页码/)).toHaveValue("1");
    expect(within(dialog).getByRole("button", { name: "确认并保存" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "保存并查看下一项" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("无需提取")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "本文件表单" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "全部表单库" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索表单" }), { target: { value: "A106000" } });
    expect(screen.getByText(/企业所得税弥补亏损明细表/)).toBeVisible();
  });

  it("成功保存复核后显示已确认，重新打开可恢复复核组", async () => {
    const props = commonProps();
    const saved: { reviews?: unknown } = {};
    props.onSave.mockImplementation(async state => { saved.reviews = (state as { reviews?: unknown }).reviews; });
    const view = render(<AudiPickTaxWorkflow {...props} />);
    fireEvent.click(reviewButton(1));
    const dialog = await screen.findByRole("dialog", { name: "税表人工复核" });
    fireEvent.click(within(dialog).getByLabelText("无需提取"));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认并保存" }));

    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(reviewButton(1)).toHaveTextContent("已人工确认");
    expect(saved.reviews).toBeDefined();

    view.unmount();
    render(<AudiPickTaxWorkflow {...props} initialReviews={saved.reviews as never} />);
    expect(reviewButton(1)).toHaveTextContent("已人工确认");
  });

  it("保存失败时不得把页面标记为已人工确认", async () => {
    const props = commonProps();
    props.onSave.mockRejectedValue(new Error("复核保存失败"));
    render(<AudiPickTaxWorkflow {...props} />);
    fireEvent.click(reviewButton(1));
    const dialog = await screen.findByRole("dialog", { name: "税表人工复核" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认并保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("复核保存失败");
    expect(reviewButton(1)).not.toHaveTextContent("已人工确认");
  });

  it("同文件同表单不同所属期分别保存，并在目录重预检后保留已确认组", async () => {
    const props = commonProps();
    const view = render(<AudiPickTaxWorkflow {...props} />);

    fireEvent.click(reviewButton(1));
    let dialog = await screen.findByRole("dialog", { name: "税表人工复核" });
    fireEvent.change(within(dialog).getByLabelText(/所属期/), { target: { value: "2025年度" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认并保存" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());

    fireEvent.click(reviewButton(2));
    dialog = await screen.findByRole("dialog", { name: "税表人工复核" });
    fireEvent.change(within(dialog).getByLabelText(/所属期/), { target: { value: "2024年度" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认并保存" }));
    await waitFor(() => expect(props.onSave.mock.calls.length).toBeGreaterThanOrEqual(2));
    const finalState = props.onSave.mock.calls.at(-1)?.[0] as { reviews?: Record<string, { period: string; formKey: string }[]> };
    expect(finalState.reviews?.a?.filter(group => group.formKey === form.key).map(group => group.period).sort()).toEqual(["2024年度", "2025年度"]);

    fireEvent.click(screen.getByRole("button", { name: "1. 预检文件目录" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("目录预检完成"));
    const afterPreflight = props.onSave.mock.calls.at(-1)?.[0] as { reviews?: Record<string, unknown[]> };
    expect(afterPreflight.reviews?.a).toHaveLength(2);
    expect(reviewButton(1)).toHaveTextContent("已人工确认");
    expect(reviewButton(2)).toHaveTextContent("已人工确认");
    view.unmount();
  });

  it("保存完成前保持待复核，失败后可在同一窗口重试", async () => {
    const props=commonProps();
    let fail: (error:Error)=>void=()=>{};
    props.onSave.mockImplementationOnce(()=>new Promise<void>((_resolve,reject)=>{fail=reject;}));
    render(<AudiPickTaxWorkflow {...props}/>);
    fireEvent.click(reviewButton(1));
    const dialog=screen.getByRole("dialog",{name:"税表人工复核"});
    fireEvent.click(within(dialog).getByRole("button",{name:"确认并保存"}));
    await waitFor(()=>expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(reviewButton(1)).not.toHaveTextContent("已人工确认");
    expect(within(dialog).getByRole("button",{name:"取消"})).toBeDisabled();
    fail(new Error("磁盘暂不可用"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("磁盘暂不可用");
    fireEvent.click(within(dialog).getByRole("button",{name:"确认并保存"}));
    await waitFor(()=>expect(reviewButton(1)).toHaveTextContent("已人工确认"));
    expect(props.onSave).toHaveBeenCalledTimes(2);
  });

  it("两份不同期间的同名表分别提取、预览并一起传给Excel导出", async () => {
    const props=commonProps(),ownIndex=index();
    const groups=[stampTaxReviewGroup(ownIndex,{id:"may",formKey:form.key,companyName:"甲公司",period:"2020年5月",pages:[1],status:"confirmed"}),stampTaxReviewGroup(ownIndex,{id:"june",formKey:form.key,companyName:"甲公司",period:"2020年6月",pages:[2],status:"confirmed"})];
    mocks.pickPath.mockResolvedValue("D:/税表.xlsx");mocks.engineCall.mockResolvedValue({sheetCount:2});
    render(<AudiPickTaxWorkflow {...props} initialIndexes={{a:ownIndex}} initialReviews={{a:groups}} initialSelectedFormKeys={[form.key]} initialPageTexts={{a:{1:'<table><tr><td>金额</td><td>100</td></tr></table>',2:'<table><tr><td>金额</td><td>200</td></tr></table>'}}} initialPageTextVersions={{a:{1:TAX_PAGE_READER_VERSION,2:TAX_PAGE_READER_VERSION}}}/>);
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("已完成 2 张表"));
    expect(screen.getByRole("button",{name:/甲公司 · 纳税调整项目明细表 · 2020年5月/})).toBeInTheDocument();
    expect(screen.getByRole("button",{name:/甲公司 · 纳税调整项目明细表 · 2020年6月/})).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"3. 导出 Excel"}));
    await waitFor(()=>expect(mocks.engineCall).toHaveBeenCalledWith("audipick.tax_export",expect.objectContaining({tables:[expect.objectContaining({instanceId:"may",period:"2020年5月",pages:[1]}),expect.objectContaining({instanceId:"june",period:"2020年6月",pages:[2]})]})));
    expect(mocks.recognize).not.toHaveBeenCalled();expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("保存后跳转下一待复核页，越界页码不会写入项目", async () => {
    const props=commonProps();
    render(<AudiPickTaxWorkflow {...props}/>);
    fireEvent.click(reviewButton(1));
    let dialog=screen.getByRole("dialog",{name:"税表人工复核"});
    fireEvent.change(within(dialog).getByLabelText(/PDF\s*页码/),{target:{value:"3"}});
    fireEvent.click(within(dialog).getByRole("button",{name:"确认并保存"}));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("页码必须在 1 至 2 之间");
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/PDF\s*页码/),{target:{value:"1"}});
    fireEvent.click(within(dialog).getByRole("button",{name:"保存并查看下一项"}));
    await waitFor(()=>expect(within(screen.getByRole("dialog",{name:"税表人工复核"})).getByLabelText(/PDF\s*页码/)).toHaveValue("2"));
    expect(reviewButton(1)).toHaveTextContent("已人工确认");
    expect(reviewButton(2)).not.toHaveTextContent("已人工确认");
  });

  it("仅对当前复核页扩大识别范围，目录变化后旧确认失效且保留记录", async () => {
    const props=commonProps(),ownIndex=index(),heights:number[]=[];
    const group=stampTaxReviewGroup(ownIndex,{id:"old",formKey:form.key,companyName:"甲公司",period:"2025年度",pages:[1],status:"confirmed"});
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation(function(this:HTMLCanvasElement){heights.push(this.height);return "data:image/jpeg;base64,dGVzdA==";});
    mocks.recognize.mockResolvedValue("A106000 企业所得税弥补亏损明细表\n行次 项目 金额\n1 本期亏损 100 200");
    render(<AudiPickTaxWorkflow {...props} initialIndexes={{a:ownIndex}} initialReviews={{a:[group]}}/>);
    fireEvent.click(reviewButton(2));
    const dialog=screen.getByRole("dialog",{name:"税表人工复核"});
    fireEvent.click(within(dialog).getByRole("button",{name:"重新识别此页"}));
    await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("第 2 页已扩大至整页重新识别"));
    expect(mocks.recognize).toHaveBeenCalledTimes(1);
    expect(mocks.recognize).toHaveBeenCalledWith(expect.objectContaining({documentId:"a",page:2,taxTable:false}),expect.anything());
    expect(heights).toEqual([1000]);
    expect(reviewButton(1)).not.toHaveTextContent("已人工确认");
    expect((props.onSave.mock.calls.at(-1)?.[0] as {reviews?:Record<string,unknown[]>}).reviews?.a).toHaveLength(1);
  });

  it("排除一页不能掩盖同名表剩余待复核页", async () => {
    const props=commonProps(),ownIndex=index();
    const excluded=stampTaxReviewGroup(ownIndex,{id:"excluded",formKey:form.key,companyName:"",period:"",pages:[1],status:"excluded"});
    render(<AudiPickTaxWorkflow {...props} initialIndexes={{a:ownIndex}} initialReviews={{a:[excluded]}} initialSelectedFormKeys={[form.key]}/>);
    fireEvent.click(screen.getByRole("button",{name:"2. 提取所选表单"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("未找到可提取的已确认页码");
    expect(screen.getByRole("status")).toHaveTextContent("1 页待复核");
    expect(mocks.extract).not.toHaveBeenCalled();
  });
});
