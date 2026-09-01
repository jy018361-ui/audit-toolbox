import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { displayFileName } from "@/fileDisplay";

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
}: FileInputProps) {
  return (
    <div className="input-with-button">
      <Input
        value={value ? displayFileName(value) : ""}
        placeholder={placeholder}
        readOnly={readOnly}
        disabled={disabled}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
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
          size="sm"
          className="text-destructive"
          onClick={onClear}
          disabled={disabled}
        >
          {clearLabel}
        </Button>
      )}
    </div>
  );
}
