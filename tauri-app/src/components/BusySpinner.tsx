import { cn } from "@/lib/utils";

/**
 * 忙碌指示器：SVG 描边转圈，动画样式在 styles.css 的 .busy-spinner。
 * 只表示"进行中"，颜色随所在文字（currentColor），供忙碌态按钮等场景内联使用。
 */
export function BusySpinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("busy-spinner", className)}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" pathLength={360} />
    </svg>
  );
}
