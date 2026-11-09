import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { z } from "zod";

const StatusSchema = z.object({
  enabled: z.boolean(), bytes: z.number(), files: z.number(), retentionDays: z.number(),
  maxBytes: z.number(), writeError: z.string().nullable(),
});
export type DiagnosticsStatus = z.infer<typeof StatusSchema>;
const LogEntrySchema = z.object({
  at: z.iso.datetime({ offset: true }),
  session: z.string(),
  pid: z.number(),
  version: z.string(),
  event: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type DiagnosticsLogEntry = z.infer<typeof LogEntrySchema>;
const desktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let installed = false;

export const diagnosticsStatus = async () => {
  if (!desktop()) throw new Error("浏览器预览模式不能读取诊断日志，请使用桌面应用。");
  return StatusSchema.parse(await nativeInvoke("diagnostics_status"));
};
export const diagnosticsSetEnabled = async (enabled: boolean) =>
  StatusSchema.parse(await nativeInvoke("diagnostics_set_enabled", { enabled }));
export const diagnosticsClear = async () => StatusSchema.parse(await nativeInvoke("diagnostics_clear"));
export const diagnosticsExport = (path: string) => nativeInvoke<void>("diagnostics_export", { path });
export const diagnosticsRecent = async () =>
  LogEntrySchema.array().parse(await nativeInvoke("diagnostics_recent"));

function record(event: string, data: Record<string, unknown>) {
  if (!installed || !desktop()) return;
  // Logging failures must not create more logging calls or break the user's operation.
  void nativeInvoke("diagnostics_frontend", { event, data }).catch(() => undefined);
}

export function diagnosticRoute(): string {
  const route = window.location.hash.slice(1).split("?")[0];
  return /^\/(?:settings|history|tools\/[a-zA-Z0-9_-]+)?$/.test(route) ? route || "/" : "/other";
}

const viewport = () => ({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, pixelRatio: window.devicePixelRatio });

export function reportFrontendError(error: unknown) {
  const value = error instanceof Error ? { name: error.name, message: error.message } : error;
  const stack = error instanceof Error ? (error.stack ?? "").split("\n").slice(1).join("\n") : "";
  // Preserve code locations only, stripping URL queries, user paths, and message text.
  const frames = [...stack.matchAll(/([A-Za-z0-9_.-]+\.(?:m?js|tsx?|jsx)):(\d+):(\d+)/g)]
    .slice(0, 40).map(match => `${match[1]}:${match[2]}:${match[3]}`);
  record("frontend_error", { route: diagnosticRoute(), error: value, frames });
}

/** API transport tracing, enabled once in the real application entry point. */
export async function diagnosticInvoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const forward = () => options !== undefined ? nativeInvoke<T>(command, args, options)
    : args !== undefined ? nativeInvoke<T>(command, args) : nativeInvoke<T>(command);
  if (!installed || command.startsWith("diagnostics_") || command === "telemetry_track") {
    return forward();
  }
  // Polling success is noise; failures still matter.
  const polling = command === "meeting_status" || command === "settings_get";
  const callId = crypto.randomUUID();
  const started = performance.now();
  const method = args && !(args instanceof ArrayBuffer) && !ArrayBuffer.isView(args)
    ? (args as Record<string, unknown>).method : undefined;
  const common = { command, callId, method, route: diagnosticRoute() };
  if (!polling) record("frontend_call", { ...common, action: "start" });
  try {
    const result = await forward();
    if (!polling) record("frontend_call", { ...common, ok: true, elapsedMs: Math.round(performance.now() - started),
      ...(command === "job_start" && typeof result === "string" ? { jobId: result } : {}) });
    return result;
  } catch (error) {
    const fields = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
    record("frontend_call", { ...common, ok: false, elapsedMs: Math.round(performance.now() - started),
      code: fields.code, diagnosticId: fields.diagnosticId, error });
    throw error;
  }
}

export function installFrontendDiagnostics() {
  if (installed || !desktop()) return;
  installed = true;
  window.addEventListener("error", event => reportFrontendError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", event => reportFrontendError(event.reason));
  window.addEventListener("hashchange", () => record("navigation", { route: diagnosticRoute() }));
  // Technical DOM positions locate controls without collecting labels, input values, or text.
  document.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest("button, a, input[type=checkbox]") : null;
    if (!button) return;
    const controls = [...document.querySelectorAll("button, a, input[type=checkbox]")];
    record("ui_action", { route: diagnosticRoute(), action: `click:${button.tagName.toLowerCase()}:${controls.indexOf(button)}` });
  }, true);
  document.addEventListener("change", event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) return;
    const controls = [...document.querySelectorAll("input, select, textarea")];
    record("ui_action", { route: diagnosticRoute(), action: `change:${control.tagName.toLowerCase()}:${controls.indexOf(control)}`,
      ...(control instanceof HTMLSelectElement ? { selectedIndex: control.selectedIndex } : {}),
      ...(control instanceof HTMLInputElement && control.type === "checkbox" ? { checked: control.checked } : {}) });
  }, true);
  let pointer: { id: number; x: number; y: number; at: number } | undefined;
  document.addEventListener("pointerdown", event => { pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() }; }, true);
  document.addEventListener("pointercancel", () => { pointer = undefined; }, true);
  document.addEventListener("pointerup", event => {
    const start = pointer; pointer = undefined;
    if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
    record("ui_action", { route: diagnosticRoute(), action: "drag", x: Math.round(start.x), y: Math.round(start.y),
      deltaX: Math.round(event.clientX - start.x), deltaY: Math.round(event.clientY - start.y), elapsedMs: Math.round(performance.now() - start.at), ...viewport() });
  }, true);
  let lastWheel = -Infinity;
  document.addEventListener("wheel", event => {
    if (performance.now() - lastWheel < 500) return;
    lastWheel = performance.now();
    record("ui_action", { route: diagnosticRoute(), action: "wheel", x: Math.round(event.clientX), y: Math.round(event.clientY),
      deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY), ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, ...viewport() });
  }, { capture: true, passive: true });
  let resizeTimer: ReturnType<typeof setTimeout>;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => record("ui_action", { route: diagnosticRoute(), action: "resize", ...viewport() }), 300);
  });
  record("navigation", { route: diagnosticRoute(), action: "window_start", ...viewport() });
}
