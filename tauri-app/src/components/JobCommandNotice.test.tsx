// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const jobCancel = vi.fn((_jobId: string) => Promise.resolve(true));
vi.mock("@/api", () => ({ jobCancel: (jobId: string) => jobCancel(jobId) }));

import { cancelJobWithFeedback, JobCommandNotice } from "./JobCommandNotice";

afterEach(() => {
  cleanup();
  jobCancel.mockReset();
  jobCancel.mockResolvedValue(true);
});

it("独立停止按钮的取消失败会显示可关闭的全局提示", async () => {
  jobCancel.mockResolvedValueOnce(false);
  render(<JobCommandNotice />);
  expect(await cancelJobWithFeedback("job-1")).toBe(false);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("取消指令未被接受"));
  screen.getByRole("button", { name: "关闭" }).click();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("同一任务取消请求未结束时不会重复发送", async () => {
  let resolve!: (value: boolean) => void;
  jobCancel.mockImplementationOnce(() => new Promise<boolean>((done) => { resolve = done; }));
  const first = cancelJobWithFeedback("job-2");
  expect(await cancelJobWithFeedback("job-2")).toBe(false);
  expect(jobCancel).toHaveBeenCalledTimes(1);
  resolve(true);
  expect(await first).toBe(true);
});
