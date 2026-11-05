// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { diagnosticsClear, diagnosticsExport, diagnosticsSetEnabled, diagnosticsStatus } from "../diagnostics";
import { pickPath, runningInDesktopApp } from "../api";
import { confirmDialog } from "./ConfirmDialog";

const status = { enabled: true, bytes: 1024, files: 1, retentionDays: 7, maxBytes: 24 * 1024 * 1024, writeError: null };
vi.mock("../diagnostics", () => ({ diagnosticsStatus: vi.fn(), diagnosticsSetEnabled: vi.fn(), diagnosticsClear: vi.fn(), diagnosticsExport: vi.fn() }));
vi.mock("../api", () => ({ pickPath: vi.fn(), openOutput: vi.fn(), runningInDesktopApp: vi.fn() }));
vi.mock("./ConfirmDialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runningInDesktopApp).mockReturnValue(true);
  vi.mocked(diagnosticsStatus).mockResolvedValue(status);
});
afterEach(cleanup);

it("records successful operations too and preserves existing logs when disabled", async () => {
  vi.mocked(diagnosticsSetEnabled).mockResolvedValue({ ...status, enabled: false });
  render(<DiagnosticsSettings />);
  const toggle = await screen.findByRole("checkbox", { name: "记录本地诊断日志" });
  await waitFor(() => expect(toggle).toBeChecked());
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(diagnosticsSetEnabled).toHaveBeenCalledWith(false);
  expect(screen.getByText("已关闭日志记录。")).toBeInTheDocument();
  expect(diagnosticsClear).not.toHaveBeenCalled();
});

it("exports only after choosing a path and keeps errors recoverable", async () => {
  vi.mocked(pickPath).mockResolvedValueOnce(null).mockResolvedValue("C:\\诊断.zip");
  vi.mocked(diagnosticsExport).mockRejectedValueOnce(new Error("磁盘写入失败")).mockResolvedValue(undefined);
  render(<DiagnosticsSettings />);
  const button = screen.getByRole("button", { name: "导出诊断包" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(pickPath).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(button).toBeEnabled());
  expect(diagnosticsExport).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("磁盘写入失败");
  fireEvent.click(button);
  expect(await screen.findByText(/诊断包已导出/)).toBeInTheDocument();
  expect(diagnosticsExport).toHaveBeenLastCalledWith("C:\\诊断.zip");
});

it("requires clear confirmation and explains browser preview", async () => {
  vi.mocked(confirmDialog).mockResolvedValueOnce(false).mockResolvedValue(true);
  vi.mocked(diagnosticsClear).mockResolvedValue({ ...status, files: 0, bytes: 0 });
  const view = render(<DiagnosticsSettings />);
  const button = screen.getByRole("button", { name: "清空日志" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(button).toBeEnabled());
  expect(diagnosticsClear).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(diagnosticsClear).toHaveBeenCalledTimes(1));
  expect(await screen.findByText("日志已清空。")).toBeInTheDocument();
  view.unmount();
  vi.mocked(runningInDesktopApp).mockReturnValue(false);
  render(<DiagnosticsSettings />);
  expect(screen.getByText("仅桌面版可用。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "导出诊断包" })).not.toBeInTheDocument();
});
