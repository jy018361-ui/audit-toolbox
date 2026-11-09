// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ secretGet: vi.fn() }));
vi.mock("../api", () => api);
import { SecretInput } from "./SecretInput";

beforeEach(() => {
  vi.clearAllMocks();
  api.secretGet.mockResolvedValue("stored-test-key");
});
afterEach(cleanup);
function field(value = "", onChange = vi.fn()) {
  return (
    <label>
      密钥
      <SecretInput
        label="密钥"
        credentialName="bailian_asr_key"
        value={value}
        onChange={onChange}
      />
    </label>
  );
}

it("点击显示才读取已保存密钥，隐藏时清除读取值，查看不触发编辑", async () => {
  const onChange = vi.fn();
  render(field("", onChange));
  expect(screen.getByLabelText("密钥")).toHaveAttribute("type", "password");
  expect(api.secretGet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));
  await waitFor(() =>
    expect(screen.getByLabelText("密钥")).toHaveValue("stored-test-key"),
  );
  expect(api.secretGet).toHaveBeenCalledWith("bailian_asr_key");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "隐藏密钥" }));
  expect(screen.getByLabelText("密钥")).toHaveValue("");
  expect(screen.getByLabelText("密钥")).toHaveAttribute("type", "password");
});

it("显示和隐藏当前草稿均保留内容，不读取或覆盖已保存凭据", () => {
  const onChange = vi.fn();
  render(field("draft-test-key", onChange));
  fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));
  expect(screen.getByLabelText("密钥")).toHaveAttribute("type", "text");
  expect(screen.getByLabelText("密钥")).toHaveValue("draft-test-key");
  fireEvent.click(screen.getByRole("button", { name: "隐藏密钥" }));
  expect(screen.getByLabelText("密钥")).toHaveValue("draft-test-key");
  expect(api.secretGet).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
});

it("已保存密钥可以编辑为新草稿", async () => {
  const onChange = vi.fn();
  render(field("", onChange));
  fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));
  await waitFor(() =>
    expect(screen.getByLabelText("密钥")).toHaveValue("stored-test-key"),
  );
  fireEvent.change(screen.getByLabelText("密钥"), {
    target: { value: "replacement-key" },
  });
  expect(onChange).toHaveBeenCalledWith("replacement-key");
});

it("读取期间的新输入不被迟到的已保存密钥覆盖", async () => {
  let finish!: (value: string) => void;
  api.secretGet.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
  );
  const onChange = vi.fn();
  const view = render(field("", onChange));
  fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));
  fireEvent.change(screen.getByLabelText("密钥"), {
    target: { value: "new-draft" },
  });
  view.rerender(field("new-draft", onChange));
  await act(async () => {
    finish("old-key");
  });
  expect(screen.getByLabelText("密钥")).toHaveValue("new-draft");
  expect(screen.getByRole("button", { name: "隐藏密钥" })).toBeEnabled();
});

it("无已保存密钥或读取失败时明确提示，并允许输入", async () => {
  api.secretGet.mockResolvedValueOnce(null);
  const view = render(field());
  fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));
  await screen.findByText("尚未保存该密钥，请填写后保存。");
  expect(screen.getByLabelText("密钥")).toBeEnabled();
  view.unmount();
  api.secretGet.mockRejectedValueOnce({ userMessage: "凭据读取失败" });
  render(field());
  fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));
  await screen.findByText("凭据读取失败");
});
