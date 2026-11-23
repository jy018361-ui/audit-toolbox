// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudiPickTaxWorkflow } from "./AudiPickTaxWorkflow";
import type { AudiPickTaxWorkflowState } from "./audipickTaxPipeline";

const mocks=vi.hoisted(()=>({recognize:vi.fn(),rotation:0}));
vi.mock("./api",()=>({engineCall:vi.fn(),pickPath:vi.fn(),jobCancel:vi.fn(),jobPause:vi.fn()}));
vi.mock("./audipickExtractJob",()=>({runAudiPickExtractJob:vi.fn()}));
vi.mock("./audipickPdfPreparation",async()=>({...await vi.importActual("./audipickPdfPreparation"),recognizePdfPage:mocks.recognize}));

function setup() {
  const page={rotate:0,getViewport:vi.fn(({rotation=0,scale=1}:{rotation?:number;scale?:number})=>({rotation,width:(rotation%180?2592:1944)*scale,height:(rotation%180?1944:2592)*scale})),getTextContent:async()=>({items:[]}),render:vi.fn(({viewport}:{viewport:{rotation:number}})=>{mocks.rotation=viewport.rotation;return {promise:Promise.resolve(),cancel:vi.fn()};}),cleanup:vi.fn()};
  const onSave=vi.fn(async(_state:AudiPickTaxWorkflowState)=>{});
  render(<AudiPickTaxWorkflow documents={[{id:"scan",name:"横置扫描.pdf"}]} loadPdf={async()=>({numPages:1,getPage:async()=>page,destroy:vi.fn()})} onSave={onSave} onClose={vi.fn()}/>);
  return {page,onSave};
}
beforeEach(()=>{vi.clearAllMocks();mocks.rotation=0;vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({} as CanvasRenderingContext2D);vi.spyOn(HTMLCanvasElement.prototype,"toDataURL").mockReturnValue("data:image/jpeg;base64,c2Nhbg==");});
afterEach(()=>{cleanup();vi.restoreAllMocks();});

it("横置扫描页顶部没有标题时尝试转向，持久化识别到预缴表的实际方向",async()=>{
  // Mirrors sample page 8: the title is on the right edge until rotating
  // counterclockwise 90 degrees (PDF.js clockwise rotation=270).
  mocks.recognize.mockImplementation(async()=>mocks.rotation===270?"增值税预缴税款表":"模糊的表格文字");
  const {page,onSave}=setup();
  fireEvent.click(screen.getByRole("button",{name:"1. 预检文件目录"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("目录预检完成"));
  expect(page.getViewport).toHaveBeenCalledWith(expect.objectContaining({rotation:270}));
  const saved=onSave.mock.calls.at(-1)![0];
  expect(saved.indexes.scan.pages[0]).toMatchObject({formKey:"vat_prepaid",confidence:"high",rotation:270});
  expect(mocks.recognize.mock.calls.every(([params])=>params.pageRegion==="tax_header"&&!params.taxTable)).toBe(true);
});

it("方向正常且标题清楚的扫描页只识别一次",async()=>{
  mocks.recognize.mockResolvedValue("增值税预缴税款表");
  const {onSave}=setup();
  fireEvent.click(screen.getByRole("button",{name:"1. 预检文件目录"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("目录预检完成"));
  expect(mocks.recognize).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls.at(-1)![0].indexes.scan.pages[0].formKey).toBe("vat_prepaid");
});

it("四个方向都未匹配时保留原始文字和待复核状态，不伪造匹配",async()=>{
  mocks.recognize.mockImplementation(async()=>`未匹配的原文 ${mocks.rotation}`);
  const {onSave}=setup();
  fireEvent.click(screen.getByRole("button",{name:"1. 预检文件目录"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("目录预检完成"));
  expect(mocks.recognize).toHaveBeenCalledTimes(4);
  expect(onSave.mock.calls.at(-1)![0].indexes.scan.pages[0]).toMatchObject({text:"未匹配的原文 0",kind:"unknown",confidence:"low"});
});
