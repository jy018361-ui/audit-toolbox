import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
};

/**
 * Shared empty state for pages, cards, and filtered result regions.
 *
 * The component owns presentation only. Callers provide the next action so an
 * empty result can explain both what happened and how to continue.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <section
      className={cn("empty-state", compact && "empty-state--compact", className)}
      aria-label={title}
    >
      <span className="empty-state-icon" aria-hidden="true">
        {icon ?? <Inbox />}
      </span>
      <div className="empty-state-copy">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </section>
  );
}
