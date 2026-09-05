import { cn } from "@/lib/utils";
import { displayFileName } from "@/fileDisplay";
import { useId, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button";

export type FileDropInputProps = {
  /** 已选文件路径 */
  value: string;
  disabled?: boolean;
  placeholder?: string;
  /** 点击选择文件 */
  onBrowse: () => void;
  /** 拖入本框时回调（路径由父组件统一经 listenFileDrops 分发） */
  onDragStateChange: (active: boolean) => void;
  /** 拖放悬停时是否高亮（父组件根据拖放位置判断） */
  highlight?: boolean;
  /** 清除已选 */
  onClear?: () => void;
  /** DOM ref used by multi-slot pages to hit-test the native drop coordinates. */
  containerRef?: Ref<HTMLDivElement>;
  description?: ReactNode;
  invalid?: ReactNode;
  ariaLabel?: string;
  className?: string;
};

/**
 * 拖拽 + 点击双通道文件输入框（单个槽位）。
 *
 * 参考 Excel 批量合并的 drop-zone：点击弹文件选择，或把文件拖到窗口。
 * 本组件不直接监听拖放事件——拖放到窗口由 Tauri 的 listenFileDrops 统一
 * 接收（它拿不到 DOM 目标）；本组件通过原生 dragenter/dragleave 上报
 * 「当前是否悬停在本框」，由父组件据此把拖入的文件分配到正确的框。
 */
export function FileDropInput({
  value,
  disabled,
  placeholder,
  onBrowse,
  onDragStateChange,
  highlight,
  onClear,
  containerRef,
  description,
  invalid,
  ariaLabel,
  className,
}: FileDropInputProps) {
  const generatedId = useId();
  const helpId = description ? `file-drop-${generatedId}-description` : undefined;
  const errorId = invalid ? `file-drop-${generatedId}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div
      ref={containerRef}
      data-tour="tool-upload"
      className={cn(
        "file-drop-input",
        highlight && "drag-hover",
        invalid && "invalid",
        disabled && "disabled",
        className,
      )}
      onDragEnter={() => onDragStateChange(true)}
      onDragLeave={() => onDragStateChange(false)}
      onDrop={() => onDragStateChange(false)}
    >
      {value ? (
        <div className="file-drop-slot filled">
          <span className="file-drop-slot-label">
            {placeholder ?? "已选文件"}
          </span>
          <button
            type="button"
            className="file-drop-slot-value"
            disabled={disabled}
            onClick={onBrowse}
            aria-label={ariaLabel ?? `重新选择文件：${displayFileName(value)}`}
            aria-describedby={describedBy}
            aria-invalid={Boolean(invalid) || undefined}
          >
            {displayFileName(value)}
          </button>
          {onClear && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="file-drop-clear text-destructive"
              disabled={disabled}
              onClick={onClear}
            >
              清空
            </Button>
          )}
        </div>
      ) : (
        <button
          type="button"
          className={cn("file-drop-zone", "slot-mode")}
          disabled={disabled}
          onClick={onBrowse}
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          aria-invalid={Boolean(invalid) || undefined}
        >
          <strong>{placeholder ?? "拖放文件到窗口"}</strong>
        </button>
      )}
      {description ? <p id={helpId} className="file-input-description">{description}</p> : null}
      {invalid ? <p id={errorId} className="file-input-error" role="alert">{invalid}</p> : null}
    </div>
  );
}
