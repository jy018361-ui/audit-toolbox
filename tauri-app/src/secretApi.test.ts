// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { secretGet } from "./api";
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("__TAURI_INTERNALS__", {}); });
afterEach(() => vi.unstubAllGlobals());

it("按指定凭据名读取字符串或空值，拒绝异常响应", async () => {
  native.invoke.mockResolvedValueOnce("example-test-key");
  await expect(secretGet("bailian_asr_key")).resolves.toBe("example-test-key");
  expect(native.invoke).toHaveBeenCalledWith("secret_get", { name: "bailian_asr_key" });
  native.invoke.mockResolvedValueOnce(null);
  await expect(secretGet("bailian_plan_asr_key")).resolves.toBeNull();
  native.invoke.mockResolvedValueOnce({ unexpected: true });
  await expect(secretGet("llm_api_key")).rejects.toThrow();
});
