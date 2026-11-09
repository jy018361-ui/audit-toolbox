// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { diagnosticInvoke, installFrontendDiagnostics, reportFrontendError } from "./diagnostics";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("traces success, state changes and errors without forwarding command credentials", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  window.location.hash = "#/settings";
  vi.mocked(invoke).mockImplementation(async command => command === "secret_set" ? undefined : null);
  installFrontendDiagnostics();
  await diagnosticInvoke("secret_set", { name: "llm_api_key", value: "sk-private-key" });
  const calls = vi.mocked(invoke).mock.calls.filter(([name]) => name === "diagnostics_frontend");
  expect(calls.some(([, args]) => JSON.stringify(args).includes('"ok":true'))).toBe(true);
  expect(JSON.stringify(calls)).not.toContain("sk-private-key");

  document.body.innerHTML = '<select><option>a</option><option>b</option></select>';
  const select = document.querySelector("select")!;
  select.selectedIndex = 1;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(invoke).toHaveBeenCalledWith("diagnostics_frontend", expect.objectContaining({ event: "ui_action", data: expect.objectContaining({ selectedIndex: 1 }) }));

  const error = Object.assign(new Error("失败"), { stack: "Error: 失败\n at save (http://localhost:1420/src/private/user/file.ts:12:34)" });
  reportFrontendError(error);
  expect(invoke).toHaveBeenCalledWith("diagnostics_frontend", expect.objectContaining({ data: expect.objectContaining({ frames: ["file.ts:12:34"] }) }));
  vi.mocked(invoke).mockImplementation(async command => { if (command === "bad_call") throw { code: "BROKEN", diagnosticId: "abc123" }; return null; });
  await expect(diagnosticInvoke("bad_call")).rejects.toMatchObject({ code: "BROKEN" });
  expect(invoke).toHaveBeenCalledWith("diagnostics_frontend", expect.objectContaining({ data: expect.objectContaining({ ok: false, diagnosticId: "abc123" }) }));
  vi.mocked(invoke).mockRejectedValue(new Error("日志不可写"));
  expect(() => reportFrontendError(error)).not.toThrow();
  await Promise.resolve();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
