import { describe, expect, it } from "vitest";
import { errorText, meetingErrorText } from "./errors";

describe("meetingErrorText", () => {
  it("保留云端与网络详情，不改变其他工具的默认文案", () => {
    const error = { userMessage: "转写失败", detail: "InvalidApiKey；请求编号：req" };
    expect(meetingErrorText(error)).toBe("转写失败 详细原因：InvalidApiKey；请求编号：req");
    expect(errorText(error)).toBe("转写失败");
  });
  it("兼容没有详情的旧事件且不重复追加详情", () => {
    expect(meetingErrorText("失败")).toBe("失败");
    expect(meetingErrorText(null)).toBe("操作失败，请检查输入后重试。");
    expect(meetingErrorText({ userMessage: "失败", detail: " " })).toBe("失败");
    expect(meetingErrorText({ detail: "连接中断" })).toBe("连接中断");
    expect(meetingErrorText({ userMessage: "失败：密钥无效", detail: "密钥无效" })).toBe("失败：密钥无效");
  });
});
