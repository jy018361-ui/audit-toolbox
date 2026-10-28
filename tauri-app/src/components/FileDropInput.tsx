import { cn } from "@/lib/utils";
import { displayFileName } from "@/fileDisplay";
import { useId, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button";

export type FileDropInputProps = {
  /** 已选文件路径 */
  value: string;
  /** 多文件等场景的明确展示文案；不再把组合文案误当成本地路径截取文件名。 */
  displayValue?: ReactNode;
  /**
   * 已选文件时仅显示文件信息和清空操作。适合页面已在上方交代上传方式的
   * 汇总上传栏（或外层 Field 已带字段名），避免把“拖放或选择”这类引导语
   * 重复展示为文件槽标签。
   */
  hideFilledLabel?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** 空状态的图标与上传引导，仍使用同一个可点击、可聚焦的选择入口。 */
  emptyContent?: ReactNode;
  /** 点击选择文件 */
  onBrowse: () => void;
  /** 悬停状态由父组件的原生拖放监听同步；本框也提供 DOM 事件回调。 */
  onDragStateChange: (active: boolean) => void;
  /** 拖放悬停时是否高亮（父组件根据拖放位置判断） */
  highlight?: boolean;
  /** 清除已选 */
  onClear?: () => void;
  /** DOM ref used by multi-slot pages to hit-test the native drop coordinates. */
  containerRef?: Ref<HTMLDivElement>;
  description?: ReactNode;
  /** 与主文件选择入口同属一个拖放区域的辅助操作。 */
  actions?: ReactNode;
  invalid?: ReactNode;
  ariaLabel?: string;
  className?: string;
};

/**
 * 已选文件后的槽位标签：占位符是「怎么选」的引导句，直接沿用会让用户
 * 以为占位没消失；剥掉引导前缀只留名词（「Excel 函证清单」「输出文件夹」）。
 */
const GUIDE_PREFIXES = [
  "拖放或点击选择",
  "拖放或选择",
  "拖放或单击选择",
  "拖放并点击选择",
  "拖放文件到窗口",
  "选择",
];

function filledSlotLabel(placeholder?: string): string {
  const text = (placeholder ?? "").trim();
  if (!text) return "已选文件";
  for (const prefix of GUIDE_PREFIXES) {
    if (text.startsWith(prefix)) {
      return text.slice(prefix.length).trim() || "已选文件";
    }
  }
  const orClick = text.indexOf("或点击选择");
  if (orClick >= 0) {
    return text.slice(orClick + "或点击选择".length).trim() || "已选文件";
  }
  // 「导入已有录音（…），点击右侧浏览选择」这类长句：逗号前是名词主体。
  const cut = text.search(/[，,]\s*(?:点击|拖放)/);
  if (cut > 0) {
    return text.slice(0, cut).trim() || "已选文件";
  }
  return text;
}

/**
 * 拖拽 + 点击双通道文件输入框（单个槽位）。
 *
 * 参考 Excel 批量合并的 drop-zone：点击弹文件选择，或把文件拖到窗口。
 * 本组件不直接接收文件路径。单上传区可配合 useNativeFileDropZone 监听
 * Tauri 原生拖放；多槽页面由父组件按原生坐标分配。本框的 DOM 事件仅
 * 辅助反馈悬停，Windows WebView 接管文件拖放时不能依赖 DOM drop。
 */
export function FileDropInput({
  value,
  displayValue,
  hideFilledLabel,
  disabled,
  placeholder,
  emptyContent,
  onBrowse,
  onDragStateChange,
  highlight,
  onClear,
  containerRef,
  description,
  actions,
  invalid,
  ariaLabel,
  className,
}: FileDropInputProps) {
  const generatedId = useId();
  const helpId = description
    ? `file-drop-${generatedId}-description`
    : undefined;
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
        <div
          className={cn(
            "file-drop-slot filled",
            hideFilledLabel && "without-label",
          )}
        >
          {!hideFilledLabel && (
            <span className="file-drop-slot-label">
              {filledSlotLabel(placeholder)}
            </span>
          )}
          <button
            type="button"
            className="file-drop-slot-value"
            disabled={disabled}
            onClick={onBrowse}
            aria-label={ariaLabel ?? `重新选择文件：${displayFileName(value)}`}
            aria-describedby={describedBy}
            aria-invalid={Boolean(invalid) || undefined}
          >
            {displayValue ?? displayFileName(value)}
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
          {emptyContent ?? <strong>{placeholder ?? "拖放文件到窗口"}</strong>}
        </button>
      )}
      {actions ? <div className="file-drop-actions">{actions}</div> : null}
      {description ? (
        <p id={helpId} className="file-input-description">
          {description}
        </p>
      ) : null}
      {invalid ? (
        <p id={errorId} className="file-input-error" role="alert">
          {invalid}
        </p>
      ) : null}
    </div>
  );
}
