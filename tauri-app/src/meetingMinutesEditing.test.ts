// @vitest-environment jsdom
import { expect,it } from "vitest";
import {editableMinutesHtml,minutesElementToMarkdown,pastedMinutesHtml} from "./meetingMinutesEditing";
import {withoutTimelineMarkers} from "./meetingTimeline";
it("富文本标题列表表格往返保持结构，姓名保留编号来源且不反替换普通同名文字",()=>{
  const source="# 会议\n\n**说话人1**与张三讨论。\n\n- 第一项\n- 第二项\n\n|事项|责任人|\n|---|---|\n|复核|说话人1|";
  const div=document.createElement("div");div.innerHTML=editableMinutesHtml(source,{"1":"张三"});
  expect(div.textContent).not.toContain("说话人1");
  const markdown=minutesElementToMarkdown(div);
  expect(markdown).toContain("**说话人1**与张三讨论。");
  expect(markdown).toContain("- 第一项");expect(markdown).toContain("| 复核 | 说话人1 |");
  const named=div.querySelector("[data-meeting-speaker]")!;named.textContent="王五";
  expect(minutesElementToMarkdown(div)).toContain("**王五**与张三讨论");
});
it("粘贴过滤脚本图片和不可信姓名身份属性",()=>{
  const html=pastedMinutesHtml('<p onclick="bad()">正文</p><script>bad()</script><img src="https://bad"><span data-meeting-speaker="1" data-speaker-display="张三">张三</span>',"");
  expect(html).not.toMatch(/<script|<img|onclick|data-meeting-speaker/);
  expect(html).toContain("张三");
});
it("去掉录音时间轴保留先后顺序、实际会议时间和截止日期",()=>{
  const text="# 标题（按时间）\n\n### [00:01–02:30] 开场\n[02:30] 讨论\n- 03:10 补充\n会议时间：10:00–11:00\n截止时间：周五18:00\n[2026-10-29] 资料交付";
  const clean=withoutTimelineMarkers(text);
  expect(clean).toContain("### 开场");expect(clean).toContain("- 补充");
  expect(clean).not.toMatch(/00:01|02:30|03:10/);
  expect(clean).toContain("10:00–11:00");expect(clean).toContain("周五18:00");expect(clean).toContain("[2026-10-29]");
});
