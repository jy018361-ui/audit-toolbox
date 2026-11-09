// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { meetingAsrTest } from "./api";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
});
afterEach(() => vi.unstubAllGlobals());

it("通用连接测试把当前地址、模型和临时密钥传给 Rust", async () => {
  await meetingAsrTest(" test-key ", {
    channel: "paraformer",
    baseUrl: "https://custom.example.cn",
    model: "custom-file-model",
  });
  expect(native.invoke).toHaveBeenCalledWith("meeting_asr_test", {
    apiKey: "test-key",
    baseUrl: "https://custom.example.cn",
    model: "custom-file-model",
  });
});

it("套餐连接测试使用独立参数，空密钥留给 Rust 读取已保存的套餐凭据", async () => {
  await meetingAsrTest(" ", {
    channel: "token_plan",
    baseUrl: "https://plan.example.cn",
    model: "realtime-model",
  });
  expect(native.invoke).toHaveBeenCalledWith("meeting_asr_test", {
    planApiKey: null,
    planBaseUrl: "https://plan.example.cn",
    planModel: "realtime-model",
  });
});
