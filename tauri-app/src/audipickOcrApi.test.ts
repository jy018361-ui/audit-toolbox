// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({ message: "测试成功", elapsedMs: 1 }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { audipickOcrTest } from "./api";

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("__TAURI_INTERNALS__", {}); });
afterEach(() => vi.unstubAllGlobals());

it("百炼 OCR 测试将 URL、模型、临时密钥传给 Rust，未提交的草稿不保存", async () => {
  await audipickOcrTest("bailian", "synthetic-image", " draft-key ", "", {
    bailian_base_url: "https://workspace.example/compatible-mode/v1",
    bailian_model: "qwen3.5-ocr",
  });
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("audipick_ocr_test", {
    engine: "bailian", imageBase64: "synthetic-image", apiKey: "draft-key", secretKey: null,
    ocrConfig: { bailian_base_url: "https://workspace.example/compatible-mode/v1", bailian_model: "qwen3.5-ocr" },
  });
});

it("空白草稿密钥传 null，由 Rust 读取百炼专用凭据", async () => {
  await audipickOcrTest("bailian", "synthetic-image", " ");
  expect(native.invoke).toHaveBeenCalledWith("audipick_ocr_test", {
    engine: "bailian", imageBase64: "synthetic-image", apiKey: null, secretKey: null, ocrConfig: null,
  });
});
