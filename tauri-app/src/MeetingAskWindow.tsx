import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import {
  listenMeetingEvents,
  meetingAskChoice,
  meetingRecordStart,
  runningInDesktopApp,
} from "./api";
import "./meeting-minutes.css";

/** 会议询问小窗（窗口 label = meeting-ask）：检测到 Teams 会议时以
 *  无边框透明置顶小窗弹出，只问一件事——记不记录本次会议。
 *  决定通过 meeting-ask-choice 事件送回主窗口（「本次不记录」压制当前
 *  这场会），随后小窗自行关闭；会议结束时若还没作答也自动消失。 */
export default function MeetingAskWindow() {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const desktop = runningInDesktopApp();

  // 透明小窗：全局样式给 body 铺了底色，这里必须换成透明。
  useEffect(() => {
    document.body.classList.add("meeting-ask-body");
    return () => document.body.classList.remove("meeting-ask-body");
  }, []);

  // 会都开完了还没答：小窗没有存在意义，自动退场（Escape 同义于「本次不记录」）。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listenMeetingEvents((event) => {
      if (event.type === "call_ended") {
        void getCurrentWebviewWindow().close().catch(() => undefined);
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void decline();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  async function closeSelf() {
    await getCurrentWebviewWindow().close().catch(() => undefined);
  }

  async function accept() {
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      await meetingRecordStart();
      await meetingAskChoice(true);
      await closeSelf();
    } catch (e) {
      setError(errorText(e));
      setStarting(false);
    }
  }

  async function decline() {
    try {
      await meetingAskChoice(false);
    } catch {
      // 回传失败也得让用户摆脱小窗：主窗口那边本场压制可能没收到，
      // 但会议结束时会自动恢复询问，不至于卡死。
    } finally {
      await closeSelf();
    }
  }

  return (
    <main className="meeting-ask-window" aria-label="会议记录询问">
      <div className="meeting-ask-window-card">
        <div className="meeting-ask-window-head" data-tauri-drag-region>
          <h1 data-tauri-drag-region>检测到 Teams 会议</h1>
          <button
            type="button"
            className="meeting-ask-window-close"
            aria-label="关闭并选择本次不记录"
            onClick={() => void decline()}
          >
            ×
          </button>
        </div>
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
