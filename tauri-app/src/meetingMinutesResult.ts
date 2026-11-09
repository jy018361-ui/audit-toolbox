import type { MeetingResult } from "./types";

// openOutput 对已授权文件打开其所在目录；保留文件路径，不反向授权父目录。
export function meetingOutputPath(result: MeetingResult | undefined): string | undefined {
  return result?.minutesVersions?.find((version) => version.minutesPath)?.minutesPath
    || result?.minutesPath || result?.transcriptPath || result?.audioPath || undefined;
}
