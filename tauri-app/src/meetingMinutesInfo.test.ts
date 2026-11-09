import { expect, it } from "vitest";
import { meetingDateTime, withMeetingInfo } from "./meetingMinutesInfo";
import { meetingSpeakerShares } from "./meetingSpeakerShares";

it("旧纪要缺失时间由录音开始结束记录补全并带星期，反复渲染不重复",()=>{
  const source="# 项目会\n\n## 一、会议信息\n会议时间：未知\n参会人员：未提及\n\n## 讨论\n说话人1发言。";
  const result=withMeetingInfo(source,["1","2"],"2026-11-02T10:00:00+08:00","2026-11-02T11:00:00+08:00");
  expect(result).toContain("2026-11-02（周一）");
  expect(result).toContain("参会人员：说话人1、说话人2");
  expect(result).not.toContain("未知");
  expect(withMeetingInfo(result,["1","2"],"2026-11-02T10:00:00+08:00","2026-11-02T11:00:00+08:00")).toBe(result);
  expect(meetingDateTime("2026-11-01T12:00:00+08:00")).toContain("周日");
  expect(withMeetingInfo("",["1"],"2026-11-02T10:00:00+08:00")).toBe("");
});
it("导入或旧会议无可靠日期时不拿生成时间顶替，保留人工时间并补星期",()=>{
  expect(withMeetingInfo("# 导入会议\n会议时间：未知",[])).toContain("未提供（未保留录音日期）");
  const explicit=withMeetingInfo("# 会议\n会议时间：2026年11月2日 10:00",[],"2026-11-03T10:00:00+08:00");
  expect(explicit).toContain("2026年11月2日（周一） 10:00");
  expect(explicit).not.toContain("周二");
});
it("时长占比使用逐句有效发言毫秒数而非文字量和计费时长",()=>{
  expect(meetingSpeakerShares("说话人1：甲\n说话人2：乙丙丁",{"1":8000,"2":2000}).percentages).toEqual({"1":"80%","2":"20%"});
});
