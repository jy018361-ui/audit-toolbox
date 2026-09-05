import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  if (!error) return null;
  return (
    <Alert variant="destructive" className="error-box">
      <AlertTitle className="error-box-title">
        <span className="error-box-message">{error}</span>
        <span className="error-box-actions">
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
