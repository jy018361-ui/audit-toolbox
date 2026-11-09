// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { copyFormattedMinutes, formatMeetingMinutes } from "./meetingMinutesFormat";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("邮件标题去除版本标记、只附加一次会议纪要，正文保留标题列表表格及微软雅黑", () => {
  const formatted = formatMeetingMinutes("# 项目复核（按内容）\n\n## 讨论\n- **张三**负责复核\n- 李四补充资料\n\n|事项|责任人|\n|---|---|\n|复核|张三|\n\n<script>alert(1)</script>\n\n![私图](https://example.com/pixel)\n\n[外链](https://example.com)");
  expect(formatted.subject).toBe("项目复核_会议纪要");
  const document = new DOMParser().parseFromString(formatted.html, "text/html");
  expect(document.querySelectorAll("h1,h2,ul,table")).toHaveLength(4);
  expect(document.querySelector("td")?.getAttribute("style")).toContain("Microsoft YaHei");
  expect(document.querySelector("th")?.getAttribute("style")).toContain("background-color");
  expect(document.querySelectorAll("script,img,a")).toHaveLength(0);
  expect(formatted.text).toContain("• 张三负责复核");
  expect(formatted.text).toContain("复核\t张三");
  expect(formatted.text).not.toContain("**");
  expect(formatMeetingMinutes("# 项目复核_会议纪要（按时间）").subject).toBe("项目复核_会议纪要");
});

it("复制同时提供HTML及纯文本，支持Outlook和普通文本目标", async () => {
  const write = vi.fn(async () => undefined);
  const writeText = vi.fn();
  const items: Record<string, Blob>[] = [];
  vi.stubGlobal("ClipboardItem", class { constructor(data: Record<string, Blob>) { items.push(data); } });
  Object.defineProperty(navigator, "clipboard", {configurable:true,value:{write,writeText}});
  const formatted = formatMeetingMinutes("# 会议\n\n**正文**");
  expect(await copyFormattedMinutes(formatted)).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
  expect(items[0]["text/html"].type).toBe("text/html");
  expect(items[0]["text/plain"].type).toBe("text/plain");
  expect(writeText).not.toHaveBeenCalled();
});

it("ClipboardItem失败后通过copy事件保留两种格式，最终降级不假报富文本成功", async () => {
  const data = new Map<string,string>();
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {configurable:true,value:{writeText}});
  const execCommand = vi.fn(() => {
    const event = new Event("copy", {cancelable:true});
    Object.defineProperty(event,"clipboardData",{value:{setData:(type:string,value:string)=>data.set(type,value)}});
    document.dispatchEvent(event);
    return true;
  });
  Object.defineProperty(document, "execCommand", {configurable:true,value:execCommand});
  const formatted = formatMeetingMinutes("# 会议\n\n正文");
  expect(await copyFormattedMinutes(formatted)).toBe(true);
  expect(data.get("text/html")).toBe(formatted.html);
  expect(data.get("text/plain")).toBe(formatted.text);
  execCommand.mockReturnValue(false);
  expect(await copyFormattedMinutes(formatted)).toBe(false);
  expect(writeText).toHaveBeenCalledWith(formatted.text);
  delete (document as unknown as Record<string, unknown>).execCommand;
});
