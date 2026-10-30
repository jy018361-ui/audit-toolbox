import { describe, expect, it } from "vitest";
import { meetingSpeakerShares } from "./meetingSpeakerShares";

describe("说话人发言内容占比", () => {
  it("根据原始发言内容计数，忽略时间、标签、空格和标点，合并重复轮次", () => {
    const result = meetingSpeakerShares("[00:00] 说话人1：甲乙，丙丁。\n戊己！\n[01:00:05] 说话人10: A B\n[999:59] 说话人1：庚辛");
    expect(result).toEqual({percentages:{"1":"80%","10":"20%"},hasUnattributed:false});
  });
  it("未归属发言计入分母且不会延续上一个说话人的归属", () => {
    expect(meetingSpeakerShares("[00:00] 说话人1：甲乙\n[00:01] 丙丁\n戊己\n说话人2：庚辛")).toEqual({
      percentages:{"1":"25%","2":"25%"},hasUnattributed:true,
    });
  });
  it("发言中提及说话人不会被当作新的发言归属", () => {
    expect(meetingSpeakerShares("说话人1：他说话人2：你好").percentages).toEqual({"1":"100%"});
  });
  it("支持Unicode有效文字，微量发言不冒报为零或独占全部", () => {
    expect(meetingSpeakerShares(`说话人1：${"甲".repeat(2000)}\n说话人2：𠮷`).percentages).toEqual({"1":">99.9%","2":"<0.1%"});
  });
  it("多方占比最多保留一位小数，空正文及无标签文本不生成百分比", () => {
    expect(meetingSpeakerShares("说话人1：甲\n说话人2：乙\n说话人3：丙").percentages).toEqual({"1":"33.3%","2":"33.3%","3":"33.3%"});
    for (const text of [undefined,"","[00:00] 没有标签","[00:00] 说话人1：，！", "说话人1000：不支持的编号"]) {
      expect(meetingSpeakerShares(text).percentages).toEqual({});
    }
  });
});
