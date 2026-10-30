/**
 * 数据流流程文件保存 / 打开。
 *
 * 打开：隐藏 file input 读取 JSON 文本（Tauri WebView2 与浏览器均可用，
 * 且不经 AllowedPaths 授权——读取流程文件不能反向授权其引用路径）。
 * 保存：桌面端先用 pickPath("save") 取得目标路径并登记授权，再交给引擎
 * dataflow_save_workflow 落盘；浏览器预览模式降级为下载。
 */
import { engineCall, pickPath, runningInDesktopApp } from "../api";
import { errorText } from "@/lib/errors";

import { serializeWorkflow, type DataflowWorkflow } from "./model";

export type SaveWorkflowOutcome = { ok: boolean; message: string };

function downloadWorkflowJson(content: string, fileName: string): void {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export async function saveWorkflowFile(workflow: DataflowWorkflow): Promise<SaveWorkflowOutcome> {
  const content = serializeWorkflow(workflow);
  const fileName = `${workflow.name?.trim() || "新建流程"}.json`;
  if (!runningInDesktopApp()) {
    downloadWorkflowJson(content, fileName);
    return { ok: true, message: "浏览器预览模式：流程文件已通过下载保存。" };
  }
  // 系统保存对话框出错（如 IPC 异常）不能让「保存」静默无反应：
  // 兜底转成失败结果，交给页面错误通道展示中文原因。
  let target: Awaited<ReturnType<typeof pickPath>>;
  try {
    target = await pickPath("save", "保存数据流流程文件", ["json"], fileName);
  } catch (error) {
    return { ok: false, message: `打开保存窗口失败：${errorText(error)}` };
  }
  if (typeof target !== "string" || !target) {
    return { ok: false, message: "已取消保存。" };
  }
  try {
    await engineCall("dataflow_save_workflow", { path: target, content });
    return { ok: true, message: `流程已保存：${target}` };
  } catch (error) {
    // 引擎尚未提供流程文件写入时兜底为浏览器下载，保证「保存」始终可用。
    downloadWorkflowJson(content, fileName);
    return {
      ok: false,
      message: `引擎暂不支持写入流程文件（${errorText(error)}），已改为浏览器下载保存。`,
    };
  }
}

export type OpenWorkflowOutcome =
  | { ok: true; fileName: string; text: string }
  | { ok: false; cancelled: boolean; message?: string };

/** 弹出文件选择框读取流程 JSON 文本。用户取消时 cancelled = true。 */
export function pickWorkflowFile(): Promise<OpenWorkflowOutcome> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    let settled = false;
    const finish = (outcome: OpenWorkflowOutcome) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(outcome);
    };
    input.addEventListener("cancel", () => finish({ ok: false, cancelled: true }));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish({ ok: false, cancelled: true });
        return;
      }
      file
        .text()
        .then((text) => finish({ ok: true, fileName: file.name, text }))
        .catch(() =>
          finish({ ok: false, cancelled: false, message: "流程文件读取失败，请重试。" }),
        );
    });
    document.body.appendChild(input);
    input.click();
  });
}
