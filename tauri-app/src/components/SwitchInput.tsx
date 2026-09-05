import { cn } from "@/lib/utils";

/**
 * 滑动开关：原生勾选框 + switch-input 外观（styles.css）。
 * 仅用于"开/关"型选项；多选列表与确认勾选仍用普通勾选框。
 * 语义保持勾选框，读屏与测试的 checked 契约不变。
 */
export function SwitchInput({
  checked,
  onChange,
  className,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <input
      type="checkbox"
      className={cn("switch-input", className)}
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
