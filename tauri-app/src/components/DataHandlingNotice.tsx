import type { ReactNode } from "react";
import { BarChart3, CloudCog, HardDrive } from "lucide-react";

import { cn } from "@/lib/utils";

export type DataHandlingNoticeProps = {
  mode: "local" | "network-assisted" | "telemetry";
  title: string;
  description: ReactNode;
  details?: ReactNode;
  className?: string;
};

/**
 * Consistent disclosure for file handling, local storage, and optional
 * external processing. Copy is required because each tool has different data
 * boundaries; the component must never imply that a network-backed task is
 * local-only.
 */
export function DataHandlingNotice({
  mode,
  title,
  description,
  details,
  className,
}: DataHandlingNoticeProps) {
  const Icon =
    mode === "local" ? HardDrive : mode === "network-assisted" ? CloudCog : BarChart3;

  return (
    <aside
      className={cn(
        "data-handling-notice",
        `data-handling-notice--${mode}`,
        className,
      )}
      data-mode={mode}
      aria-label={title}
    >
      <Icon className="data-handling-notice-icon" aria-hidden="true" />
      <div className="data-handling-notice-copy">
        <strong>{title}</strong>
        <p>{description}</p>
        {details ? (
          <div className="data-handling-notice-details">{details}</div>
        ) : null}
      </div>
    </aside>
  );
}
