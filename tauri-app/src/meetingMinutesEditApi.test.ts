// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { meetingCreateMailDraft, meetingSaveMinutes } from "./api";
import { replaceSpeakerNames, speakerIds } from "./meetingSpeakerNames";

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("__TAURI_INTERNALS__", {}); });
afterEach(() => vi.unstubAllGlobals());

it("正文与姓名通过原生命令保存并验证返回格式", async () => {
  native.invoke.mockResolvedValue({minutesPath:"C:/会议.md",minutesMarkdown:"张三",sourceMarkdown:"说话人1",speakerNames:{"1":"张三"}});
  expect((await meetingSaveMinutes("C:/会议.md", "说话人1", "原正文", {"1":"张三"})).speakerNames).toEqual({"1":"张三"});
  expect(native.invoke).toHaveBeenCalledWith("meeting_save_minutes", {path:"C:/会议.md",minutesMarkdown:"说话人1",expectedMarkdown:"原正文",speakerNames:{"1":"张三"}});
  native.invoke.mockResolvedValue({minutesMarkdown:123});
  await expect(meetingSaveMinutes("C:/会议.md", "正文", "原正文")).rejects.toThrow();
});
it("超大文本与无效编号不调用保存，浏览器预览不伪造落盘", async () => {
  await expect(meetingSaveMinutes("C:/会议.md", "中".repeat(800_000), "")).rejects.toThrow("2 MB");
  await expect(meetingSaveMinutes("C:/会议.md", "正文", "", {"0":"张三"})).rejects.toThrow();
  expect(native.invoke).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await expect(meetingSaveMinutes("C:/会议.md", "正文", "")).rejects.toThrow("预览模式");
});
it("按完整说话人编号替换，Markdown姓名按字面显示，未指定和普通姓名不变", () => {
  expect(speakerIds(["说话人1、说话人10、说话人 2、说话人1000", "说话人1"])).toEqual(["1", "2", "10"]);
  expect(replaceSpeakerNames("说话人1 说话人10 说话人1000 张三 说话人 2", {"1":"李|四", "2":"*王五*"}))
    .toBe("李\\|四 说话人10 说话人1000 张三 \\*王五\\*");
});

it("邮件接口只传标题和HTML，校验草稿结果与预览边界", async () => {
  native.invoke.mockResolvedValue({saved:true,displayed:true,message:"草稿已创建"});
  await meetingCreateMailDraft("项目会议纪要", "<p>正文</p>");
  expect(native.invoke).toHaveBeenLastCalledWith("meeting_create_mail_draft", {subject:"项目会议纪要",htmlBody:"<p>正文</p>"});
  native.invoke.mockClear();
  await expect(meetingCreateMailDraft("标题\r\n注入", "<p>正文</p>")).rejects.toThrow();
  expect(native.invoke).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await expect(meetingCreateMailDraft("标题", "<p>正文</p>")).rejects.toThrow("预览模式");
});
