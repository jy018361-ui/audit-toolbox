import { cn } from "@/lib/utils";
import { displayFileName } from "@/fileDisplay";
import type { Ref } from "react";

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
}: FileDropInputProps) {
  return (
    <div
      ref={containerRef}
      className={cn("file-drop-input", highlight && "drag-hover")}
    >
      {value ? (
        <div className="file-drop-slot filled">
          <span className="file-drop-slot-label">
            {placeholder ?? "已选文件"}
          </span>
          <span className="file-drop-slot-value">{displayFileName(value)}</span>
          {onClear && (
            <button
              type="button"
              className="file-drop-clear"
              disabled={disabled}
              onClick={onClear}
            >
              清空
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          className={cn("file-drop-zone", "slot-mode")}
          disabled={disabled}
          onClick={onBrowse}
        >
          <strong>{placeholder ?? "拖放文件到窗口"}</strong>
        </button>
      )}
    </div>
  );
}
