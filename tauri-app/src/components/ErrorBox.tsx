import { useEffect, useMemo, useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { dedupeRepeatedText, isVerboseText, textPreview } from "@/lib/presentationText";
import { cn } from "@/lib/utils";
import "./task-state.css";

export type ErrorBoxProps = {
  error: string;
  onDismiss?: () => void;
  onRetry?: () => void;
};

/**
 * 统一的错误提示框。取代分散的 .error-box / .confirmation-error / .kz-error。
 * 文案提取统一走 src/lib/errors.ts 的 errorText()。
 */
export function ErrorBox({ error, onDismiss, onRetry }: ErrorBoxProps) {
  const normalizedError = useMemo(() => dedupeRepeatedText(error), [error]);
  const verbose = isVerboseText(normalizedError);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => setExpanded(false), [normalizedError]);

  if (!error) return null;
  return (
    <Alert variant="destructive" className="error-box">
      <AlertTitle className="error-box-title">
        <span
          className={cn(
            "error-box-message",
            expanded && "error-box-message--expanded",
          )}
        >
          {verbose && !expanded ? textPreview(normalizedError) : normalizedError}
        </span>
        <span className="error-box-actions">
          {verbose && (
            <Button
              variant="ghost"
              size="xs"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "收起详情" : "查看详情"}
            </Button>
          )}
          {onRetry && (
            <Button
              variant="ghost"
              size="xs"
              type="button"
              onClick={onRetry}
            >
              重试
            </Button>
          )}
          {onDismiss && (
            <Button
              variant="ghost"
              size="xs"
              type="button"
              onClick={onDismiss}
            >
              关闭
            </Button>
          )}
        </span>
      </AlertTitle>
    </Alert>
  );
}
