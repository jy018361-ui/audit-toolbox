// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudiPickLegacyConfig } from "./AudiPickLegacyAuxiliary";
const api = vi.hoisted(() => ({ settingsGet: vi.fn(), settingsSet: vi.fn(), secretSet: vi.fn(), secretGet: vi.fn(), audipickOcrTest: vi.fn(), audipickLlmTest: vi.fn() }));
vi.mock("./api", () => api);
const status = { ocr: { engine: "baidu", ready: true }, credentials: { baiduApiKey: true, baiduSecretKey: true, llmApiKey: false } };
beforeEach(() => {
  vi.resetAllMocks();
  api.settingsGet.mockResolvedValue({ llm: { enabled: true, model: "keep" }, ocr: { engine: "baidu", custom: "keep" } });
  api.settingsSet.mockResolvedValue(undefined);
  api.secretSet.mockResolvedValue(undefined);
  api.audipickOcrTest.mockResolvedValue({ message: "测试成功", elapsedMs: 20 });
  api.audipickLlmTest.mockResolvedValue({ message: "AI测试成功", elapsedMs: 20 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn(), fillText: vi.fn() } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,dGVzdA==");
});
it("默认继承工具箱只读配置，进入不测试、不写配置，保存不会覆盖全局模型", async () => {
  await open();
  fireEvent.click(screen.getByText("AI模型"));
  expect(screen.getByLabelText("合同提取AI配置来源")).toHaveValue("inherit");
  expect(screen.getByText(/模型：keep/)).toBeInTheDocument();
  expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  expect(api.audipickLlmTest).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/配置已保存，AudiPick 继承/);
  expect(api.settingsSet).toHaveBeenCalledWith({ audipickLlm: expect.objectContaining({ mode: "inherit" }) });
  expect(api.secretSet).not.toHaveBeenCalled();
});
it("专用配置独立保存并测试；错误不切换来源，切回继承不发送专用草稿密钥", async () => {
  await open();
  fireEvent.click(screen.getByText("AI模型"));
  fireEvent.change(screen.getByLabelText("合同提取AI配置来源"), { target: { value: "dedicated" } });
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://dedicated.example/v1" } });
  fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "dedicated-model" } });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "dedicated-draft" } });
  fireEvent.click(screen.getByText("检测可用性"));
  await screen.findByText(/AI测试成功/);
  expect(api.audipickLlmTest).toHaveBeenCalledWith(expect.objectContaining({ mode: "dedicated", model: "dedicated-model" }), "dedicated-draft");
  expect(api.settingsSet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/仅 AudiPick 使用专用模型/);
  expect(api.secretSet).toHaveBeenCalledWith("audipick_llm_api_key", "dedicated-draft");
  expect(api.settingsSet).toHaveBeenCalledWith({ audipickLlm: expect.objectContaining({ mode: "dedicated", model: "dedicated-model" }) });
  expect(screen.getByLabelText("API Key")).toHaveValue("dedicated-draft");
  api.audipickLlmTest.mockRejectedValueOnce(new Error("专用模型鉴权失败，未切换模型"));
  fireEvent.click(screen.getByText("检测可用性"));
  await screen.findByText("专用模型鉴权失败，未切换模型");
  expect(screen.getByLabelText("合同提取AI配置来源")).toHaveValue("dedicated");
  fireEvent.change(screen.getByLabelText("合同提取AI配置来源"), { target: { value: "inherit" } });
  fireEvent.click(screen.getByText("检测可用性"));
  await screen.findByText(/AI测试成功/);
  expect(api.audipickLlmTest).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "inherit" }), "");
});
it("重入专用配置恢复非密钥字段，Dify 密钥保存到专用凭据而非全局", async () => {
  api.settingsGet.mockResolvedValue({ llm: { enabled: false }, audipickLlm: { mode: "dedicated", enabled: true, api_type: "dify_chat", base_url: "https://dify.example/v1", model: "app", auth_mode: "raw", thinking_enabled: true }, ocr: { engine: "baidu" } });
  await open();
  fireEvent.click(screen.getByText("AI模型"));
  expect(screen.getByLabelText("合同提取AI配置来源")).toHaveValue("dedicated");
  expect(screen.getByLabelText("启用 AI 模型")).toBeChecked();
  expect(screen.getByLabelText("鉴权方式")).toHaveValue("raw");
  expect(screen.getByLabelText("启用思考模式")).toBeChecked();
  expect(screen.getByLabelText("API Key")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "dify-draft" } });
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/仅 AudiPick 使用专用模型/);
  expect(api.secretSet).toHaveBeenCalledWith("audipick_dify_api_key", "dify-draft");
});

it("新配置的 OCR 来源默认独立继承工具箱，保存只写 AudiPick 来源标记", async () => {
  api.settingsGet.mockResolvedValue({ llm: { enabled: true, model: "global-model" }, ocr: { engine: "baidu", custom: "keep-global" } });
  await open();
  expect(screen.getByLabelText("OCR配置来源")).toHaveValue("inherit");
  expect(screen.getByText("继承工具箱 OCR（只读）")).toBeInTheDocument();
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/OCR来源已保存/);
  expect(api.settingsSet).toHaveBeenCalledWith({ audipickOcr: { mode: "inherit" } });
  expect(api.settingsSet).not.toHaveBeenCalledWith(expect.objectContaining({ ocr: expect.anything() }));
  expect(screen.getByLabelText("OCR配置来源").querySelectorAll("option")).toHaveLength(2);
});

it("旧版专用提取AI配置未选择OCR来源时维持旧AI视觉OCR行为", async () => {
  api.settingsGet.mockResolvedValue({ llm: { enabled: true, model: "toolbox-model" }, audipickLlm: { mode: "dedicated", enabled: true, model: "legacy-private" }, ocr: { engine: "ai" } });
  await open();
  expect(screen.getByLabelText("OCR配置来源")).toHaveValue("legacy");
  expect(screen.getByText("沿用旧版配置", { exact: true })).toBeInTheDocument();
  fireEvent.click(screen.getByText("测试 OCR 连接"));
  await screen.findByRole("status");
  expect(api.audipickOcrTest).toHaveBeenLastCalledWith("ai", "dGVzdA==", "", "", { source: "legacy" }, false);
  expect(api.settingsSet).not.toHaveBeenCalled();
});

it("OCR继承来源使用工具箱视觉模型，与专用合同提取AI来源分离", async () => {
  api.settingsGet.mockResolvedValue({
    llm: { enabled: true, model: "toolbox-model" },
    audipickLlm: { mode: "dedicated", enabled: true, model: "extract-model" },
    ocr: { engine: "ai" },
    audipickOcr: { mode: "inherit" },
  });
  await open();
  fireEvent.click(screen.getByText("测试 OCR 连接"));
  await screen.findByRole("status");
  expect(api.audipickOcrTest).toHaveBeenLastCalledWith("ai", "dGVzdA==", "", "", { source: "inherit" }, true);
  expect(api.audipickLlmTest).not.toHaveBeenCalled();
});

it("切回继承来源后使用工具箱当前 OCR 引擎测试，而不是专用引擎草稿", async () => {
  api.settingsGet.mockResolvedValue({
    llm: { enabled: true, model: "toolbox-model" },
    ocr: { engine: "local" },
    audipickOcr: { mode: "dedicated", engine: "baidu" },
  });
  await open();
  expect(screen.getByLabelText("OCR配置来源")).toHaveValue("dedicated");
  fireEvent.change(screen.getByLabelText("OCR配置来源"), { target: { value: "inherit" } });
  fireEvent.click(screen.getByText("测试 OCR 连接"));
  await screen.findByRole("status");
  expect(api.audipickOcrTest).toHaveBeenLastCalledWith("local", "dGVzdA==", "", "", { source: "inherit" }, true);
});

it("专用百炼切换继承并保存重入后，仍可恢复原专用引擎、URL和模型", async () => {
  let stored: Record<string, unknown> = {
    ocr: { engine: "bailian", bailian_base_url: "https://global.example/v1", bailian_model: "global-ocr" },
    audipickOcr: { mode: "dedicated", engine: "bailian", bailian_base_url: "https://private.example/v1", bailian_model: "private-ocr", custom: "keep-private" },
  };
  api.settingsGet.mockImplementation(async () => structuredClone(stored));
  // The storage API replaces each top-level settings value rather than merging its fields.
  api.settingsSet.mockImplementation(async (value) => { stored = { ...stored, ...structuredClone(value) }; });
  await open();
  fireEvent.change(screen.getByLabelText("OCR配置来源"), { target: { value: "inherit" } });
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/OCR来源已保存/);
  cleanup();
  await open();
  fireEvent.change(screen.getByLabelText("OCR配置来源"), { target: { value: "dedicated" } });
  expect(screen.getByRole("radio", { name: /百炼OCR/ })).toBeChecked();
  expect(screen.getByLabelText("百炼 OCR URL")).toHaveValue("https://private.example/v1");
  expect(screen.getByLabelText("百炼 OCR 模型")).toHaveValue("private-ocr");
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/AudiPick专用OCR配置已保存/);
  expect(stored.audipickOcr).toEqual({ mode: "dedicated", engine: "bailian", bailian_base_url: "https://private.example/v1", bailian_model: "private-ocr", custom: "keep-private" });
  expect(stored.ocr).toEqual({ engine: "bailian", bailian_base_url: "https://global.example/v1", bailian_model: "global-ocr" });
  expect(api.secretSet).not.toHaveBeenCalled();
});

it("从继承模式重入后切回专用百炼，不将全局URL和模型写入专用配置", async () => {
  api.settingsGet.mockResolvedValue({
    ocr: { engine: "bailian", bailian_base_url: "https://global.example/v1", bailian_model: "global-ocr" },
    audipickOcr: { mode: "inherit", engine: "bailian", bailian_base_url: "https://private.example/v1", bailian_model: "private-ocr" },
  });
  await open();
  fireEvent.change(screen.getByLabelText("OCR配置来源"), { target: { value: "dedicated" } });
  expect(screen.getByLabelText("百炼 OCR URL")).toHaveValue("https://private.example/v1");
  expect(screen.getByLabelText("百炼 OCR 模型")).toHaveValue("private-ocr");
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/AudiPick专用OCR配置已保存/);
  expect(api.settingsSet).toHaveBeenCalledWith(expect.objectContaining({
    audipickOcr: expect.objectContaining({ mode: "dedicated", bailian_base_url: "https://private.example/v1", bailian_model: "private-ocr" }),
  }));
});

it("切换到继承时不把专用百炼参数显示为已生效，也不发送其测试草稿", async () => {
  api.settingsGet.mockResolvedValue({
    llm: { enabled: true },
    ocr: { engine: "bailian", bailian_base_url: "https://global.example/v1", bailian_model: "global-ocr" },
    audipickOcr: { mode: "dedicated", engine: "bailian", bailian_base_url: "https://private.example/v1", bailian_model: "private-ocr" },
  });
  render(<AudiPickLegacyConfig status={{ ...status, ocr: { engine: "bailian", ready: true, source: "dedicated", effectiveModel: "private-ocr" } }} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("OCR配置来源"), { target: { value: "inherit" } });
  expect(screen.getByText(/当前选择（保存后生效）：/)).toHaveTextContent("当前选择（保存后生效）：工具箱 OCR");
  expect(screen.getByText(/已保存的实际 OCR 来源：AudiPick 专用 OCR · 百炼OCR · private-ocr/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("测试 OCR 连接"));
  await screen.findByRole("status");
  expect(api.audipickOcrTest).toHaveBeenLastCalledWith("bailian", "dGVzdA==", "", "", { source: "inherit" }, true);
});

it("专用OCR AI视觉模型密钥和设置独立保存，不改写合同提取profile及工具箱设置", async () => {
  api.settingsGet.mockResolvedValue({
    llm: { enabled: true, model: "toolbox-model" },
    audipickLlm: { mode: "dedicated", enabled: true, model: "extract-model" },
    ocr: { engine: "ai", custom: "keep-global" },
    audipickOcr: { mode: "dedicated", engine: "ai" },
  });
  await open();
  fireEvent.change(screen.getByLabelText("OCR AI模型 Base URL"), { target: { value: "https://vision.example/v1" } });
  fireEvent.change(screen.getByLabelText("OCR AI模型名称"), { target: { value: "vision-model" } });
  fireEvent.change(screen.getByLabelText("OCR AI API Key"), { target: { value: "vision-draft" } });
  fireEvent.click(screen.getByText("测试 OCR 连接"));
  await screen.findByRole("status");
  expect(api.audipickOcrTest).toHaveBeenLastCalledWith("ai", "dGVzdA==", "vision-draft", "", {
    source: "dedicated", profile: expect.objectContaining({ mode: "dedicated", base_url: "https://vision.example/v1", model: "vision-model" }),
  }, false);
  expect(api.settingsSet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/AudiPick专用OCR配置已保存/);
  expect(api.secretSet).toHaveBeenCalledWith("audipick_ocr_llm_api_key", "vision-draft");
  expect(api.settingsSet).toHaveBeenCalledWith({
    audipickOcr: expect.objectContaining({ mode: "dedicated", engine: "ai" }),
    audipickOcrLlm: expect.objectContaining({ mode: "dedicated", base_url: "https://vision.example/v1", model: "vision-model" }),
  });
  expect(api.settingsSet).not.toHaveBeenCalledWith(expect.objectContaining({ ocr: expect.anything(), audipickLlm: expect.anything(), llm: expect.anything() }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function open() {
  render(<AudiPickLegacyConfig status={status} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled());
}
it("保存 OCR 后保留本次输入，空值不删密钥且不写 AI 设置", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("OCR配置来源"), { target: { value: "dedicated" } });
  fireEvent.click(screen.getByRole("radio", { name: /百度OCR/ }));
  fireEvent.change(screen.getByLabelText("百度 API Key"), { target: { value: "test-key" } });
  fireEvent.change(screen.getByLabelText("百度 Secret Key"), { target: { value: "test-secret" } });
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/本次输入已保留/);
  expect(screen.getByLabelText("百度 API Key")).toHaveValue("test-key");
  expect(screen.getByLabelText("百度 Secret Key")).toHaveValue("test-secret");
  expect(api.settingsSet).toHaveBeenCalledWith(expect.objectContaining({ audipickOcr: expect.objectContaining({ mode: "dedicated", engine: "baidu" }) }));
  expect(api.settingsSet).not.toHaveBeenCalledWith(expect.objectContaining({ ocr: expect.anything() }));
  expect(api.secretSet).toHaveBeenCalledTimes(2);
  cleanup(); api.secretSet.mockClear();
  api.settingsGet.mockResolvedValue({ llm: { enabled: true, model: "keep" }, ocr: { engine: "baidu", custom: "keep" }, audipickOcr: { mode: "dedicated", engine: "baidu" } });
  render(<AudiPickLegacyConfig status={{ ...status, ocr: { engine: "baidu", ready: true, source: "dedicated" }, credentials: { ...status.credentials, audipickOcrBaiduApiKey: true, audipickOcrBaiduSecretKey: true } }} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled());
  fireEvent.click(screen.getByRole("radio", { name: /百度OCR/ }));
  expect(screen.getByText(/API Key：•••••• 已保存/)).toBeInTheDocument();
  expect(screen.getByLabelText("百度 API Key")).toHaveValue("");
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/AudiPick专用OCR配置已保存/);
  expect(api.secretSet).not.toHaveBeenCalled();
});
it("保存失败不清空输入、不冒报成功", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("OCR配置来源"), { target: { value: "dedicated" } });
  fireEvent.click(screen.getByRole("radio", { name: /百度OCR/ }));
  api.secretSet.mockRejectedValue(new Error("凭据保存失败"));
  fireEvent.change(screen.getByLabelText("百度 API Key"), { target: { value: "draft" } });
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText("凭据保存失败");
  expect(screen.getByLabelText("百度 API Key")).toHaveValue("draft");
  expect(api.settingsSet).not.toHaveBeenCalled();
  expect(screen.queryByText(/OCR配置已保存/)).not.toBeInTheDocument();
});
it("测试使用草稿密钥和内置图片，不保存草稿；修改后撤销旧测试结论", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("OCR配置来源"), { target: { value: "dedicated" } });
  fireEvent.click(screen.getByRole("radio", { name: /百度OCR/ }));
  fireEvent.change(screen.getByLabelText("百度 API Key"), { target: { value: "draft" } });
  fireEvent.click(screen.getByText("测试 OCR 连接"));
  expect(await screen.findByRole("status")).toHaveTextContent("测试成功");
  expect(api.audipickOcrTest).toHaveBeenCalledWith("baidu", "dGVzdA==", "draft", "", { source: "dedicated" }, false);
  expect(api.secretSet).not.toHaveBeenCalled();
  expect(api.settingsSet).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("百度 API Key"), { target: { value: "changed" } });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  api.audipickOcrTest.mockRejectedValue(new Error("鉴权失败"));
  fireEvent.click(screen.getByText("测试 OCR 连接"));
  await screen.findByText("鉴权失败");
});

it("百炼 OCR 使用独立草稿 URL、模型和密钥测试，切换引擎保留草稿且不串密钥", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("OCR配置来源"), { target: { value: "dedicated" } });
  fireEvent.click(screen.getByRole("radio", { name: /百炼OCR/ }));
  expect(screen.getByLabelText("百炼 OCR 模型")).toHaveValue("qwen3.5-ocr");
  expect(screen.getByLabelText("百炼 OCR URL")).toHaveValue("https://dashscope.aliyuncs.com/compatible-mode/v1");
  fireEvent.change(screen.getByLabelText("百炼 OCR URL"), { target: { value: "https://workspace.example/compatible-mode/v1" } });
  fireEvent.change(screen.getByLabelText("百炼 OCR 模型"), { target: { value: "custom-ocr" } });
  fireEvent.change(screen.getByLabelText("百炼 OCR API Key"), { target: { value: "bailian-draft" } });
  fireEvent.click(screen.getByText("测试 OCR 连接"));
  await screen.findByRole("status");
  expect(api.audipickOcrTest).toHaveBeenLastCalledWith("bailian", "dGVzdA==", "bailian-draft", "", { source: "dedicated", bailian_base_url: "https://workspace.example/compatible-mode/v1", bailian_model: "custom-ocr" }, false);
  expect(api.settingsSet).not.toHaveBeenCalled();
  expect(api.secretSet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: /AI视觉识别/ }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("OCR AI模型 Base URL"), { target: { value: "https://vision.example/v1" } });
  fireEvent.change(screen.getByLabelText("OCR AI模型名称"), { target: { value: "vision-model" } });
  fireEvent.click(screen.getByText("测试 OCR 连接"));
  await screen.findByRole("status");
  expect(api.audipickOcrTest).toHaveBeenLastCalledWith("ai", "dGVzdA==", "", "", { source: "dedicated", profile: expect.objectContaining({ base_url: "https://vision.example/v1", model: "vision-model" }) }, false);
  fireEvent.click(screen.getByRole("radio", { name: /百炼OCR/ }));
  expect(screen.getByLabelText("百炼 OCR API Key")).toHaveValue("bailian-draft");
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/本次输入已保留/);
  expect(api.secretSet).toHaveBeenCalledWith("audipick_ocr_bailian_key", "bailian-draft");
  expect(api.settingsSet).toHaveBeenCalledWith(expect.objectContaining({ audipickOcr: expect.objectContaining({ mode: "dedicated", engine: "bailian", bailian_base_url: "https://workspace.example/compatible-mode/v1", bailian_model: "custom-ocr" }) }));
  expect(api.settingsSet).not.toHaveBeenCalledWith(expect.objectContaining({ ocr: expect.anything() }));
});

it("重入百炼 OCR 恢复 URL、模型和凭据状态，空白密钥继续使用已保存值", async () => {
  api.settingsGet.mockResolvedValue({ audipickOcr: { mode: "dedicated", engine: "bailian", bailian_base_url: "https://saved.example/v1", bailian_model: "qwen3.5-ocr" } });
  render(<AudiPickLegacyConfig status={{ ...status, ocr: { engine: "bailian", ready: true, source: "dedicated" }, credentials: { ...status.credentials, audipickOcrBailianKey: true } }} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled());
  expect(screen.getByLabelText("百炼 OCR URL")).toHaveValue("https://saved.example/v1");
  expect(screen.getByText(/百炼 OCR API Key：•••••• 已保存/)).toBeInTheDocument();
  expect(api.secretGet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("测试 OCR 连接"));
  await screen.findByRole("status");
  expect(api.audipickOcrTest).toHaveBeenLastCalledWith("bailian", "dGVzdA==", "", "", { source: "dedicated", bailian_base_url: "https://saved.example/v1", bailian_model: "qwen3.5-ocr" }, false);
  fireEvent.click(screen.getByText("保存设置"));
  await screen.findByText(/本次输入已保留/);
  expect(api.secretSet).not.toHaveBeenCalled();
});
