// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ settingsGet: vi.fn(async () => ({})), settingsSet: vi.fn(async () => {}) }));
vi.mock("./audipickCaseLibrary", async importOriginal => {const actual=await importOriginal<typeof import('./audipickCaseLibrary')>(); return {...actual, importCaseLibraryExcel:vi.fn(async()=>({...actual.DEFAULT_CASE_LIBRARY,metadata:{...actual.DEFAULT_CASE_LIBRARY.metadata,version:'2.0'}})), activateCaseLibrary:vi.fn(async(library)=>({active:{library,hash:'newhash',activatedAt:'today'}}))};});
import CovenantCaseLibraryManager from "./CovenantCaseLibraryManager";
import { activateCaseLibrary } from "./audipickCaseLibrary";
afterEach(cleanup);
describe('案例库管理入口',()=>{
 it('可以展开查看正例与排除规则',async()=>{
  render(<CovenantCaseLibraryManager/>);
  await screen.findByText(/当前版本/);
  fireEvent.click(screen.getByRole('button',{name:'查看案例'}));
  expect(screen.getByRole('region',{name:'案例库内容'})).toBeTruthy();
  expect(screen.getByText('P001')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab',{name:/排除与支持/}));
  expect(screen.getByText('N001')).toBeTruthy();
 });
 it('导入先显示差异，点击启用才保存',async()=>{render(<CovenantCaseLibraryManager/>); await screen.findByText(/当前版本/); fireEvent.change(screen.getByLabelText('导入案例库 Excel'),{target:{files:[new File(['test'],'cases.xlsx')]}}); await screen.findByText(/待启用版本：2.0/); expect(activateCaseLibrary).not.toHaveBeenCalled(); fireEvent.click(screen.getByText('启用此版本')); await waitFor(()=>expect(activateCaseLibrary).toHaveBeenCalledTimes(1)); await screen.findByText(/新版本已启用/);});
});
