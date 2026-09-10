import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { displayFileName } from "@/fileDisplay";
import { cn } from "@/lib/utils";

export type FileInputProps = {
  value: string;
  placeholder?: string;
  readOnly?: boolean;
  onBrowse: () => void;
  onClear?: () => void;
  disabled?: boolean;
  browseLabel?: string;
  clearLabel?: string;
  /** 额外的按钮（如补充清单的"读取"），渲染在浏览按钮之后 */
  extraActions?: ReactNode;
  id?: string;
  name?: string;
  ariaLabel?: string;
  description?: ReactNode;
  invalid?: ReactNode;
  className?: string;
};

/**
 * 统一的文件选择行（输入框 + 浏览按钮 + 可选清空/附加按钮）。
 * 取代分散的 .input-with-button + .browse 组合、.kz-path 等 5 种写法。
 */
export function FileInput({
  value,
  placeholder,
  readOnly = true,
  onBrowse,
  onClear,
  disabled,
  browseLabel = "浏览",
  clearLabel = "清空",
  extraActions,
  id,
  name,
  ariaLabel,
  description,
  invalid,
  className,
}: FileInputProps) {
  const generatedId = useId();
  const inputId = id ?? `file-input-${generatedId}`;
  const helpId = description ? `${inputId}-description` : undefined;
  const errorId = invalid ? `${inputId}-error` : undefined;
  return (
    <div className={cn("file-input", className)}>
      <div className="input-with-button">
        <Input
          id={inputId}
          name={name}
          value={value ? displayFileName(value) : ""}
          placeholder={placeholder}
          readOnly={readOnly}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={Boolean(invalid) || undefined}
          aria-describedby={[helpId, errorId].filter(Boolean).join(" ") || undefined}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={onBrowse}
          disabled={disabled}
        >
          {browseLabel}
        </Button>
        {extraActions}
        {onClear && value && (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive"
            onClick={onClear}
            disabled={disabled}
          >
            {clearLabel}
          </Button>
        )}
      </div>
      {description ? <p id={helpId} className="file-input-description">{description}</p> : null}
      {invalid ? <p id={errorId} className="file-input-error" role="alert">{invalid}</p> : null}
    </div>
  );
}
