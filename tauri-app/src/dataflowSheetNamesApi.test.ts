// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { dataflowSheetNames } from "./api";

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("__TAURI_INTERNALS__", {}); });
afterEach(() => vi.unstubAllGlobals());

it("读取可见工作表清单，不运行流程或读取表头", async () => {
  native.invoke.mockResolvedValue(["TB", "JE"]);
  await expect(dataflowSheetNames("C:/客户.xlsx")).resolves.toEqual(["TB", "JE"]);
  expect(native.invoke).toHaveBeenCalledWith("engine_call", {
    method: "dataflow_sheet_names", params: { path: "C:/客户.xlsx", sourceType: "file", filePattern: "" },
  });
});

it("传递工作簿错误，拒绝异常接口响应", async () => {
  native.invoke.mockRejectedValueOnce(new Error("无法读取工作簿：文件损坏"));
  await expect(dataflowSheetNames("C:/损坏.xlsx")).rejects.toThrow("文件损坏");
  native.invoke.mockResolvedValueOnce({ availableSheets: "错误结构" });
  await expect(dataflowSheetNames("C:/客户.xlsx")).rejects.toThrow();
});

it("批量候选传递文件匹配模式", async () => {
  native.invoke.mockResolvedValue(["TB"]);
  await expect(dataflowSheetNames("C:/客户", "folder", "*TB*.xlsx")).resolves.toEqual(["TB"]);
  expect(native.invoke).toHaveBeenCalledWith("engine_call", {
    method: "dataflow_sheet_names", params: { path: "C:/客户", sourceType: "folder", filePattern: "*TB*.xlsx" },
  });
});
