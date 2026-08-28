import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ReleaseNotesSchema } from "./updateNotes";
import {
  BootstrapSchema,
  JobEventSchema,
  ToolManifestSchema,
  type JobEvent,
} from "./types";

const inTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Browser preview is a first-class UI review surface. Keep non-sensitive
// settings in memory so pages that persist draft UI state do not call Tauri's
// IPC bridge when it is unavailable. File, secret, and engine operations still
// fail with an actionable message instead of the opaque "undefined.invoke".
let previewSettings: Record<string, unknown> = {};

const previewUnavailable = (action: string) =>
  new Error(`浏览器预览模式不能${action}，请使用 Tauri 应用。`);

export async function appBootstrap() {
  if (!inTauri())
    return BootstrapSchema.parse({
      appVersion: "web-preview",
      platform: "windows",
      arch: "x64",
      webview2: true,
      engine: { available: false, version: null, mode: "browser-preview" },
      dataDir: "预览模式",
      migrationRequired: false,
    });
  return BootstrapSchema.parse(await invoke("app_bootstrap"));
}

export async function toolCatalog() {
  const data = inTauri()
    ? await invoke("tool_catalog")
    : await fetch("/tool-catalog.json").then((response) => {
        if (!response.ok) throw new Error("工具目录加载失败，请刷新后重试。");
        return response.json();
      });
  return ToolManifestSchema.array().parse(data);
}

export async function engineCall(
  method: string,
  params: Record<string, unknown>,
) {
  if (!inTauri())
    throw new Error("浏览器预览模式不能处理本地文件，请使用 Tauri 应用。 ");
  return invoke<unknown>("engine_call", { method, params });
}

export async function jobStart(
  method: string,
  params: Record<string, unknown>,
) {
  if (!inTauri())
    throw new Error("浏览器预览模式不能启动任务，请使用 Tauri 应用。");
  return invoke<string>("job_start", { method, params });
}

export const jobCancel = (jobId: string) =>
  inTauri() ? invoke<boolean>("job_cancel", { jobId }) : Promise.resolve(false);
export const jobPause = (jobId: string, paused: boolean) =>
  inTauri()
    ? invoke<boolean>("job_pause", { jobId, paused })
    : Promise.resolve(false);
export const openOutput = (path: string) =>
  inTauri()
    ? invoke<void>("open_output", { path })
    : Promise.reject(previewUnavailable("打开本地输出文件"));
export const openReferenceUrl = (url: string) =>
  inTauri()
    ? invoke<void>("open_reference_url", { url })
    : Promise.reject(previewUnavailable("打开官方网站"));
export const settingsGet = () =>
  inTauri()
    ? invoke<Record<string, unknown>>("settings_get")
    : Promise.resolve({ ...previewSettings });
export async function updateReleaseNotes(targetVersion?: string) {
  if (!inTauri()) throw previewUnavailable("读取版本更新说明");
  return ReleaseNotesSchema.parse(
    await invoke("update_release_notes", { targetVersion }),
  );
}
export const historyGet = () =>
  inTauri()
    ? invoke<Array<Record<string, unknown>>>("history_get")
    : Promise.resolve([]);
export const settingsSet = (settings: Record<string, unknown>) => {
  if (inTauri()) return invoke<void>("settings_set", { settings });
  previewSettings = { ...previewSettings, ...settings };
  return Promise.resolve();
};
export const llmTest = (settings: Record<string, unknown>, apiKey?: string) =>
  inTauri()
    ? invoke<{
        ok: boolean;
        message: string;
        apiType: string;
        model: string;
        elapsedMs: number;
      }>("llm_test", {
        settings,
        apiKey: apiKey?.trim() || null,
      })
    : Promise.reject(previewUnavailable("测试 LLM 连接"));
export const secretSet = (name: string, value: string) =>
  inTauri()
    ? invoke<void>("secret_set", { name, value })
    : Promise.reject(previewUnavailable("保存密钥"));
export const secretDelete = (name: string) =>
  inTauri()
    ? invoke<void>("secret_delete", { name })
    : Promise.reject(previewUnavailable("删除密钥"));
export const audipickPdfBytes = (documentId: string) =>
  inTauri()
    ? invoke<ArrayBuffer>("audipick_pdf_bytes", { documentId })
    : Promise.reject(previewUnavailable("读取本地 PDF"));
export const legacyImport = (path: string) =>
  inTauri()
    ? invoke("legacy_import", { path })
    : Promise.reject(previewUnavailable("导入迁移备份"));
// `defaultDirectory` only decides where the dialog opens. An unreachable path
// (typically a corporate UNC share reached from outside the intranet) is not an
// error: the system dialog silently falls back to its own default folder.
export const pickPath = (
  kind: "file" | "files" | "folder" | "save",
  title: string,
  extensions: string[] = [],
  defaultName?: string,
  defaultDirectory?: string,
) => {
  if (!inTauri()) return Promise.resolve(null);
  return invoke<string | string[] | null>("pick_path", {
    kind,
    title,
    extensions,
    defaultName,
    defaultDirectory,
  });
};

export async function listenJobEvents(
  callback: (event: JobEvent) => void,
): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen("job-event", (e) => callback(JobEventSchema.parse(e.payload)));
}

export async function listenFileDrops(
  callback: (paths: string[]) => void,
): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  return listen<{ paths?: string[] }>("tauri://drag-drop", (event) =>
    callback(event.payload.paths ?? []),
  );
}

export type PositionedFileDrop = {
  paths: string[];
  /** Logical CSS-pixel coordinates relative to the webview. */
  x: number;
  y: number;
};

export async function listenPositionedFileDrops(
  callback: (drop: PositionedFileDrop) => void,
): Promise<UnlistenFn> {
  if (!inTauri()) return () => undefined;
  const scale = window.devicePixelRatio || 1;
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    callback({
      paths: event.payload.paths,
      x: event.payload.position.x / scale,
      y: event.payload.position.y / scale,
    });
  });
}
