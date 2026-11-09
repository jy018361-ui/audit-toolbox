// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import {
  meetingVocabularyList,
  meetingVocabularySave,
  meetingVocabularyDelete,
} from "./api";
const entry = {
  id: "id",
  term: "函证",
  category: "industry" as const,
  aliases: [],
  definition: "",
  enabled: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  native.invoke.mockResolvedValue([entry]);
});
afterEach(() => vi.unstubAllGlobals());
it("词库增删改通过专用命令并校验返回结构", async () => {
  expect(await meetingVocabularyList()).toEqual([entry]);
  await meetingVocabularySave(entry);
  expect(native.invoke).toHaveBeenLastCalledWith("meeting_vocabulary_save", {
    entry,
  });
  await meetingVocabularyDelete("id");
  expect(native.invoke).toHaveBeenLastCalledWith("meeting_vocabulary_delete", {
    id: "id",
  });
  native.invoke.mockResolvedValue([{ ...entry, enabled: "true" }]);
  await expect(meetingVocabularyList()).rejects.toThrow();
});
it("无效词条不调用原生保存", async () => {
  await expect(meetingVocabularySave({ ...entry, term: "" })).rejects.toThrow();
  expect(native.invoke).not.toHaveBeenCalled();
});
it("预览模式不写本机且不伪造保存成功", async () => {
  vi.unstubAllGlobals();
  expect(await meetingVocabularyList()).toEqual([]);
  await expect(meetingVocabularySave(entry)).rejects.toThrow("预览模式");
  await expect(meetingVocabularyDelete("id")).rejects.toThrow("预览模式");
  expect(native.invoke).not.toHaveBeenCalled();
});
