// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeetingMinutesAutoSave } from "./meetingMinutesAutoSave";
import { meetingReadMinutes, meetingSaveMinutes } from "./api";
import { replaceSpeakerNames } from "./meetingSpeakerNames";
vi.mock("./api", () => ({meetingSaveMinutes:vi.fn(),meetingReadMinutes:vi.fn()}));
const doc = {key:"content",path:"C:/content.md",source:"# 纪要\n说话人1发言",expected:"# 纪要\n说话人1发言"};
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(meetingSaveMinutes).mockImplementation(async (path,source,_expected,names={})=>({minutesPath:path,minutesMarkdown:replaceSpeakerNames(source,names)}));
});
afterEach(()=>{vi.clearAllMocks();vi.useRealTimers();});
it("输入合并保存，后续保存使用上次成功修订且空文本可保存",async()=>{
  const store=new MeetingMinutesAutoSave();
  store.change(doc,"a",{});store.change(doc,"b",{});
  expect(meetingSaveMinutes).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(450);
  expect(meetingSaveMinutes).toHaveBeenCalledTimes(1);
  expect(meetingSaveMinutes).toHaveBeenLastCalledWith(doc.path,"b",doc.expected,{});
  store.change(doc,"",{});await store.flush();
  expect(meetingSaveMinutes).toHaveBeenLastCalledWith(doc.path,"","b",{});
  expect(store.get(doc.key)?.state).toBe("saved");
});
it("保存期间继续输入不会被迟到响应覆盖且按顺序保存最新值",async()=>{
  let resolve!:(value:{minutesMarkdown:string})=>void;
  vi.mocked(meetingSaveMinutes).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
  const store=new MeetingMinutesAutoSave();
  store.change(doc,"first",{});
  const pending=store.flush(doc.key);
  store.change(doc,"latest",{});
  resolve({minutesMarkdown:"first"});await pending;
  expect(meetingSaveMinutes).toHaveBeenNthCalledWith(2,doc.path,"latest","first",{});
  expect(store.get(doc.key)?.body).toBe("latest");
  expect(store.get(doc.key)?.state).toBe("saved");
});
it("失败不丢草稿不自动死循环，重试保留初始修订防止覆盖外部修改",async()=>{
  vi.mocked(meetingSaveMinutes).mockRejectedValueOnce({userMessage:"文件冲突"});
  const store=new MeetingMinutesAutoSave();
  store.change(doc,"draft",{});await store.flush();
  expect(store.get(doc.key)?.error).toContain("文件冲突");
  await vi.advanceTimersByTimeAsync(60000);
  expect(meetingSaveMinutes).toHaveBeenCalledTimes(1);
  await store.flush();
  expect(meetingSaveMinutes).toHaveBeenLastCalledWith(doc.path,"draft",doc.expected,{});
  expect(store.get(doc.key)?.state).toBe("saved");
});
it("姓名更新保存两版含尚未载入文件，不交叉污染其他会议",async()=>{
  vi.mocked(meetingReadMinutes).mockResolvedValue({minutesMarkdown:"# 时间版\n说话人1补充"});
  const store=new MeetingMinutesAutoSave();
  const other={key:"timeline",path:"C:/timeline.md"};
  store.setNames("meeting",{"1":"张三"},[doc,other]);
  store.setNames("meeting",{"1":"李四"},[doc,other]);
  await store.flush();
  expect(meetingSaveMinutes).toHaveBeenCalledWith(doc.path,doc.source,doc.expected,{"1":"李四"});
  expect(meetingSaveMinutes).toHaveBeenCalledWith(other.path,"# 时间版\n说话人1补充","# 时间版\n说话人1补充",{"1":"李四"});
  expect(store.get("unrelated")).toBeUndefined();
});
it("预览不伪造保存，初次查看不写文件",async()=>{
  const store=new MeetingMinutesAutoSave(false);
  await store.flush();expect(meetingSaveMinutes).not.toHaveBeenCalled();
  store.change(doc,"修改",{});await store.flush();
  expect(store.get(doc.key)?.state).toBe("local");
  expect(meetingSaveMinutes).not.toHaveBeenCalled();
});
