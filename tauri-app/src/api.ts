import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ReleaseNotesSchema } from "./updateNotes";
import { version as appVersion } from "../package.json";
import { demoDataEnabled, demoJobLookup, demoLookup, demoPath,
  cancelDemoJob, emitDemoJobEvent, isDemoJobCancelled, subscribeDemoJobs } from "./preview/demoRegistry";
import "./preview/layoutAudit";
import {
  BootstrapSchema,
  HistoryRowSchema,
  JobEventSchema,
  TaskRestoreSchema,
  ToolManifestSchema,
  type HistoryRow,
  type JobEvent,
  type TaskRestore,
} from "./types";

const inTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Browser preview is a first-class UI review surface. Keep non-sensitive
// settings in memory so pages that persist draft UI state do not call Tauri's
// IPC bridge when it is unavailable. File, secret, and engine operations still
// fail with an actionable message instead of the opaque "undefined.invoke".
let previewSettings: Record<string, unknown> = {};

const previewUnavailable = (action: string) =>
  new Error(`浏览器预览模式不能${action}，请使用桌面应用。`);

export async function appBootstrap() {
  if (!inTauri())
    return BootstrapSchema.parse({
      appVersion,
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
  // 正式版继续读取 Rust 编译时内嵌的清单，保证离线可用且内容固定。
  // 开发版直接读取 Vite 的 public 文件，否则 include_str! 只有重编 Rust
  // 才会更新，前端热更新后仍会看到旧的 migrationStatus。
  const useLiveCatalog = import.meta.env.DEV || !inTauri();
  const data = useLiveCatalog
    ? await fetch("/tool-catalog.json", { cache: "no-store" }).then(
        (response) => {
          if (!response.ok) throw new Error("工具目录加载失败，请刷新后重试。");
          return response.json();
        },
      )
    : await invoke("tool_catalog");
  return ToolManifestSchema.array().parse(data);
}

// —— 同步调用的全局等待提示 ——
// engine_call 类操作（导入文档、OCR 识别、读取大表）没有事件流可听，各页面
// 只能在按钮上转圈，用户不知道要等多久、甚至以为卡死。这里把进行中的调用
// 集中广播出去，App 层统一弹「正在处理」等待窗（见 SyncBusyDialog）。
export type SyncBusyEntry = { id: number; method: string };

const syncBusyListeners = new Set<(entries: SyncBusyEntry[]) => void>();
let syncBusySeq = 0;
const syncBusyActive = new Map<number, string>();

function syncBusySnapshot(): SyncBusyEntry[] {
  return [...syncBusyActive].map(([id, method]) => ({ id, method }));
}

function notifySyncBusy() {
  for (const listener of syncBusyListeners) listener(syncBusySnapshot());
}

/** 订阅进行中的同步调用；返回退订函数。订阅时会立刻收到当前快照。 */
export function onSyncBusyChange(
  listener: (entries: SyncBusyEntry[]) => void,
): () => void {
  syncBusyListeners.add(listener);
  listener(syncBusySnapshot());
  return () => syncBusyListeners.delete(listener);
}

export async function engineCall(
  method: string,
  params: Record<string, unknown>,
) {
  if (!inTauri()) {
    // 演示数据通道：仅浏览器预览 + localStorage 开关打开时生效，
    // 用仓库内固定样例回放引擎返回，让"有数据之后"的布局可被随时检查。
    const handler = demoLookup(method);
    if (handler) return structuredClone(handler(params));
    throw new Error("浏览器预览模式不能处理本地文件，请使用 Tauri 应用。 ");
  }
  const id = ++syncBusySeq;
  syncBusyActive.set(id, method);
  notifySyncBusy();
  try {
    return await invoke<unknown>("engine_call", { method, params });
  } finally {
    syncBusyActive.delete(id);
    notifySyncBusy();
  }
}

let demoJobSeq = 0;

// 演示任务的 toolId：与 Rust 侧（excel_merger.rs 的 tool_id()）同一套
// 「方法前缀 → 工具 id」映射。页面按 toolId 过滤事件（如 Excel_Merger、
// je_sign_mark），直接取方法名第一段会对不上，演示事件会被页面当串台丢弃。
const DEMO_JOB_TOOL_ID_RULES: Array<[prefix: string, toolId: string]> = [
  ["wp.", "wp_service_generator"],
  ["confirmation.", "confirmation_progress"],
  ["file_list.", "file_list_directory"],
  ["ts.", "ts_manager"],
  ["kanzhang.mark_", "je_sign_mark"],
  ["kanzhang.", "kanzhang"],
  ["audipick.", "audipick"],
  ["tbje_check.", "tbje_check"],
  ["fa.dep_", "fa_dep_calc"],
  ["fa.policy_", "fa_policy_compare"],
  ["fa.", "fa_list"],
  ["roll_forward.", "audit_roll_forward"],
  ["fx.", "fx_audit"],
  ["deposit.", "deposit_interest"],
  ["loan.", "loan_interest"],
  ["pdf2excel.", "pdf_to_excel"],
  ["fuzzy.", "fuzzy_match"],
];

const demoJobToolId = (method: string): string =>
  DEMO_JOB_TOOL_ID_RULES.find(([prefix]) => method.startsWith(prefix))?.[1] ??
  "Excel_Merger";

export async function jobStart(
  method: string,
  params: Record<string, unknown>,
) {
  if (!inTauri()) {
    // 演示任务通道：按样例剧本回放"排队→进行→完成"事件流，让任务完成后的
    // 数据化布局（筛选结果、导出文件、批次摘要）在预览模式同样可达。
    const planner = demoJobLookup(method);
    if (!planner)
      throw new Error("浏览器预览模式不能启动任务，请使用 Tauri 应用。");
    const jobId = `demo-job-${++demoJobSeq}`;
    const toolId = demoJobToolId(method);
    const events = planner(params);
    events.forEach((event, index) => {
      window.setTimeout(() => {
        if (isDemoJobCancelled(jobId)) return;
        emitDemoJobEvent({ ...event, jobId, toolId });
      }, 260 * (index + 1));
    });
    return Promise.resolve(jobId);
  }
  return invoke<string>("job_start", { method, params });
}

export const jobCancel = (jobId: string) => {
  if (!inTauri()) return Promise.resolve(cancelDemoJob(jobId));
  return invoke<boolean>("job_cancel", { jobId });
};
export const jobPause = (jobId: string, paused: boolean) =>
  inTauri()
    ? invoke<boolean>("job_pause", { jobId, paused })
    : Promise.resolve(false);
/** 使用统计：静默上报，浏览器预览模式直接空操作。 */
export const telemetryTrack = (event: string, toolId?: string, toolName?: string) =>
  inTauri()
    ? invoke<void>("telemetry_track", {
        event,
        toolId: toolId ?? null,
        toolName: toolName ?? null,
      })
    : Promise.resolve();
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
let historyCache: HistoryRow[] | undefined;
let historyRequest: Promise<HistoryRow[]> | undefined;
let historyGeneration = 0;

/** Dashboard and History share one snapshot instead of repeating the same IPC query. */
export function historyGet(): Promise<HistoryRow[]> {
  if (!inTauri()) return Promise.resolve([]);
  if (historyCache) return Promise.resolve(historyCache);
  if (historyRequest) return historyRequest;
  const generation = historyGeneration;
  const request = invoke<unknown>("history_get")
    .then((rows) =>
      Promise.all(
        (Array.isArray(rows) ? rows : []).map((row) =>
          HistoryRowSchema.parse(row),
        ),
      ),
    )
    .then((rows) => {
      if (generation === historyGeneration) historyCache = rows;
      return rows;
    })
    .finally(() => {
      if (historyRequest === request) historyRequest = undefined;
    });
  historyRequest = request;
  return request;
}

export function invalidateHistoryCache() {
  historyGeneration += 1;
  historyCache = undefined;
  historyRequest = undefined;
}

export async function historyClear(): Promise<{ removed: number }> {
  if (!inTauri()) return { removed: 0 };
  const result = await invoke<{ removed: number }>("history_clear");
  invalidateHistoryCache();
  return result;
}

/** 「继续任务」：取回该任务的输入参数存档（Rust 侧会重新授权仍存在的
 * 原输入路径），前端据此跳到对应工具页回填表单。 */
export async function historyRestore(jobId: string): Promise<TaskRestore> {
  if (!inTauri()) throw previewUnavailable("恢复历史任务");
  return TaskRestoreSchema.parse(await invoke("history_restore", { jobId }));
}
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
  if (!inTauri()) {
    if (demoDataEnabled()) {
      return Promise.resolve(
        kind === "files" ? [demoPath("样例文件.xlsx")] : demoPath("样例文件"),
      );
    }
    return Promise.resolve(null);
  }
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
  if (!inTauri()) {
    if (demoDataEnabled()) return subscribeDemoJobs(callback);
    return () => undefined;
  }
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
