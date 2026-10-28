import { useEffect, useState } from "react";
import type { OcrWorkerTiming } from "./ocrTypes";
import { OCR_CONCURRENCY } from "./ocrBatch";
import "./OcrTimingPanel.css";

export type OcrPageTiming = {
  documentId: string;
  documentName: string;
  page: number;
  status: "completed" | "failed" | "cancelled";
  renderMs: number;
  taskMs?: number;
  startMs?: number;
  totalMs: number;
  worker?: OcrWorkerTiming;
};
export type OcrTimingRun = {
  started: number;
  ended?: number;
  pages: OcrPageTiming[];
};
const seconds = (ms?: number) =>
  ms === undefined ? "—" : `${(ms / 1000).toFixed(2)} 秒`;

export function OcrTimingPanel({ run }: { run: OcrTimingRun }) {
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    if (run.ended !== undefined) return;
    const timer = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(timer);
  }, [run.started, run.ended]);
  const succeeded = run.pages.filter(
    (page) => page.status === "completed",
  ).length;
  const failed = run.pages.filter((page) => page.status === "failed").length;
  const cancelled = run.pages.filter(
    (page) => page.status === "cancelled",
  ).length;
  return (
    <details className="ocr-timings">
      <summary>
        本次识别耗时 · 总耗时{" "}
        {seconds(Math.max(0, (run.ended ?? now) - run.started))}
        {` · 成功 ${succeeded} 页 · 失败 ${failed} 页`}
        {cancelled > 0 && ` · 取消 ${cancelled} 页`}
      </summary>
      <p className="ocr-muted">
        最多同时处理 {OCR_CONCURRENCY}{" "}
        页；总耗时为实际经过时间，包含暂停。各页耗时会重叠，不能相加作为总耗时。
        任务往返包含后台排队、提交、进程启动和后端处理；后台排队与后端识别分开计时，任务提交与后端阶段也可能重叠。表格处理可能包含额外的
        AI 请求。失败或旧版后端未返回的阶段显示“—”。
        百炼接口诊断中的“等待响应头”包含建连、上传、网络往返和服务处理，不能直接当作服务端计算时间。
      </p>
      <div className="ocr-timing-scroll">
        <table aria-label="逐页识别耗时">
          <thead>
            <tr>
              {[
                "文件 / 页码",
                "结果",
                "页面总耗时",
                "渲染",
                "任务往返",
                "任务提交",
                "后台排队",
                "准备数据",
                "图片处理",
                "识别请求及解析",
                "表格处理",
                "保存",
                "接口诊断",
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.pages.map((page) => (
              <tr key={`${page.documentId}-${page.page}`}>
                <th scope="row">
                  {page.documentName} · 第 {page.page} 页
                </th>
                <td>
                  {
                    {
                      completed: "已保存",
                      failed: "失败",
                      cancelled: "已取消",
                    }[page.status]
                  }
                </td>
                <td>{seconds(page.totalMs)}</td>
                <td>{seconds(page.renderMs)}</td>
                <td>{seconds(page.taskMs)}</td>
                <td>{seconds(page.startMs)}</td>
                <td>{seconds(page.worker?.queueMs)}</td>
                <td>{seconds(page.worker?.setupMs)}</td>
                <td>{seconds(page.worker?.imageMs)}</td>
                <td>{seconds(page.worker?.recognitionMs)}</td>
                <td>{seconds(page.worker?.structureMs)}</td>
                <td>{seconds(page.worker?.saveMs)}</td>
                <td>
                  {page.worker?.httpRequests?.length ? (
                    <details className="ocr-http-timing">
                      <summary>查看请求</summary>
                      {page.worker.httpRequests.map((request, index) => (
                        <div key={index}>
                          <p>{request.model} · {request.host} · HTTP {request.httpStatus}</p>
                          <p>准备请求：{seconds(request.prepareMs)}；等待响应头：{seconds(request.headersMs)}；接收响应：{seconds(request.bodyMs)}；JSON 解析：{seconds(request.parseMs)}</p>
                          <p>请求体：{(request.requestBytes / 1024).toFixed(1)} KB；响应体：{(request.responseBytes / 1024).toFixed(1)} KB</p>
                          <p>服务请求编号：{request.requestId ?? "未返回"}</p>
                        </div>
                      ))}
                    </details>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
