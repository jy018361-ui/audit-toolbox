import { useState, type MouseEvent } from "react";
import { openReferenceUrl, runningInDesktopApp } from "./api";
import type { ToolManifest } from "./types";
import { ErrorBox } from "@/components/ErrorBox";
import { errorText } from "@/lib/errors";
import downloadUrl from "../assets/roll-forward/download-url.txt?raw";
import "./roll-forward.css";

export function RollForwardPage(_props: { tool: ToolManifest }) {
  const [error, setError] = useState("");

  async function openDownload(event: MouseEvent<HTMLAnchorElement>) {
    if (!runningInDesktopApp()) return;
    event.preventDefault();
    setError("");
    try {
      await openReferenceUrl(downloadUrl.trim());
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="roll-forward-download">
      <a href={downloadUrl.trim()} target="_blank" rel="noopener noreferrer" onClick={openDownload}>
        点击获取RollForward小工具
      </a>
      <p>有疑问请联系Dana D Li</p>
      {error && <ErrorBox error={error} onDismiss={() => setError("")} />}
    </div>
  );
}
