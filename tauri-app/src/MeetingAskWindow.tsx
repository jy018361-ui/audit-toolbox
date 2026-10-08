import { useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { meetingAskChoice, meetingRecordStart, runningInDesktopApp } from "./api";
import "./meeting-minutes.css";

/** 会议询问小窗（窗口 label = meeting-ask）：检测到 Teams 会议时置顶弹出，
 *  只问一件事——记不记录本次会议。决定通过 meeting-ask-choice 事件送回
 *  主窗口（「本次不记录」压制当前这场会），随后小窗自行关闭。 */
export default function MeetingAskWindow() {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const desktop = runningInDesktopApp();

  async function accept() {
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      await meetingRecordStart();
      await meetingAskChoice(true);
      await getCurrentWebviewWindow().close();
    } catch (e) {
      setError(errorText(e));
      setStarting(false);
    }
  }

  async function decline() {
    try {
      await meetingAskChoice(false);
    } finally {
      await getCurrentWebviewWindow().close();
    }
  }

  return (
    <main className="meeting-ask-window">
      <div className="meeting-ask-window-card">
        <h1>检测到 Teams 会议</h1>
        <p>
          是否开始记录会议纪要？录音将上传阿里云百炼进行语音转写，
          请确认已告知参会人本次会议将录音。
        </p>
        {error && (
          <p role="alert" className="meeting-ask-error">
            {error}
          </p>
        )}
        {!desktop && (
          <p role="note" className="meeting-ask-window-note">
            浏览器预览模式：此窗口仅供查看，实际询问请在桌面应用中进行。
          </p>
        )}
        <div className="meeting-ask-window-actions">
          <Button variant="secondary" onClick={() => void decline()}>
            本次不记录
          </Button>
          <Button onClick={() => void accept()} disabled={starting || !desktop}>
            {starting ? "正在启动…" : "开始记录"}
          </Button>
        </div>
      </div>
    </main>
  );
}
