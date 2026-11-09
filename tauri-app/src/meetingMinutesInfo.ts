export const participantLine = /^\s*(?:[-*+]\s+|\|\s*)?(?:\*\*)?(?:参会人员|参会人|参会者|与会人员)(?:\*\*)?\s*[:：|]/;

export function meetingDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}（周${"日一二三四五六"[date.getDay()]}）${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
}

/** Fill legacy missing facts only from recording metadata; never from import/generation dates. */
export function withMeetingInfo(source: string, ids: string[], startedAt?: string, endedAt?: string) {
  if (!source.trim()) return source;
  const start = startedAt && meetingDateTime(startedAt);
  const end = endedAt && meetingDateTime(endedAt);
  const time = start ? `${start}${end ? ` 至 ${end}` : ""}（录音记录）` : undefined;
  let lines = source.split("\n");
  let timeFound = false;
  let participantsFound = false;
  lines = lines.map(line => {
    if (/^(?:\s*[-*+]\s+)?(?:\*\*)?会议时间(?:\*\*)?\s*[:：]/.test(line)) {
      timeFound = true;
      if (time && /未知|未提及|未提供|不详|未记录/.test(line)) return `会议时间：${time}`;
      if (!time && /未知|未提及|不详|未记录/.test(line)) return "会议时间：未提供（未保留录音日期）";
      // Add weekdays to explicit dates while preserving user-provided times and prose.
      return line.replace(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?!\d)(?![（(]?周|[（(]?星期)/g,
        (date, y, m, d) => {
          const parsed = new Date(Number(y), Number(m)-1, Number(d));
          return parsed.getFullYear()===Number(y) && parsed.getMonth()===Number(m)-1 && parsed.getDate()===Number(d)
            ? `${date}（周${"日一二三四五六"[parsed.getDay()]}）` : date;
        });
    }
    if (participantLine.test(line)) {
      participantsFound = true;
      if (ids.length && /[:：|]\s*(?:未知|未提及|未提供|不详)/.test(line)) return `参会人员：${ids.map(id=>`说话人${id}`).join("、")}（按转写识别，非完整名单）`;
    }
    return line;
  });
  // Keep the participant row a separate Markdown paragraph, even for old model output.
  lines = lines.flatMap(line=>participantLine.test(line) && !line.trimStart().startsWith("|") ? ["",line,""] : [line]);
  const additions = [!timeFound ? `会议时间：${time ?? "未提供（未保留录音日期）"}` : "",
    !participantsFound && ids.length ? `参会人员：${ids.map(id=>`说话人${id}`).join("、")}（按转写识别，非完整名单）` : ""].filter(Boolean);
  if (additions.length) {
    let at = lines.findIndex(line => /^##\s+(?:一[、.．]\s*)?会议信息\s*$/.test(line));
    if (at >= 0) lines.splice(at+1, 0, "", ...additions.flatMap(line=>[line, ""]));
    else {
      at = lines.findIndex(line=>/^#\s/.test(line));
      lines.splice(at>=0 ? at+1 : 0, 0, "", "## 一、会议信息", "", ...additions.flatMap(line=>[line, ""]));
    }
  }
  return lines.join("\n").replace(/\n{3,}/g,"\n\n");
}
