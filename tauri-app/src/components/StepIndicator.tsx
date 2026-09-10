import { cn } from "@/lib/utils";
import { StepTourHint } from "./tour/StepTourHint";

export type Step = {
  key: string;
  label: string;
  disabled?: boolean;
};

export type StepIndicatorProps = {
  steps: Step[];
  /** 0-based 当前步 */
  current: number;
  onStepClick?: (index: number) => void;
  /** 模式导航不是顺序流程，切换到后项时不应把前项显示成已完成。 */
  showCompleted?: boolean;
  /** 辅助技术读出的流程名称。 */
  ariaLabel?: string;
  className?: string;
};

/**
 * 统一的步骤条（三态：active / done / disabled）。
 * 取代 FA 的 .fa-steps 与看账的 .kz-steps 两套重复实现。
 * 不用 ShadCN Tabs——Tabs 只有 active/inactive，缺少 done（已完成）三态。
 *
 * 禁用只由调用方传入的 step.disabled 决定：FA 的步骤 2/3 在匹配完成后
 * 应可点击进入，不能因"非当前步且未完成"被自动禁用。
 */
export function StepIndicator({
  steps,
  current,
  onStepClick,
  showCompleted = true,
  ariaLabel = "处理步骤",
  className,
}: StepIndicatorProps) {
  return (
    // data-tour：新手引导讲解"分步操作"时的挂点。
    <nav
      className={cn("step-indicator", className)}
      aria-label={ariaLabel}
      data-tour="step-indicator"
    >
      <ol className="step-indicator-list">
        {steps.map((step, index) => {
        const done = showCompleted && index < current;
        const active = index === current;
        // disabled 只由外部传入的 step.disabled 决定。
        // 不能用 (!done && !active) 自动禁用：FA 的步骤 2/3 的可用性由
        // 业务条件（如 !faStats）控制，匹配完成后应可点击进入。
        const disabled = Boolean(step.disabled);
          return (
            <li key={step.key}>
              <button
                type="button"
                className={cn(
                  "step-indicator-item",
                  active && "active",
                  done && "done",
                  disabled && "disabled",
                )}
                aria-current={active ? "step" : undefined}
                aria-label={`${index + 1} ${step.label}${done ? "（已完成）" : ""}`}
                disabled={disabled}
                onClick={() => onStepClick?.(index)}
              >
                <span className="step-indicator-index" aria-hidden="true">
                  {done ? (
                    <svg className="step-check" viewBox="0 0 16 16">
                      <path
                        d="M3 8.5 6.5 12 13 4.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        pathLength={24}
                      />
                    </svg>
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="step-indicator-label">{step.label}</span>
                {done ? <span className="sr-only">（已完成）</span> : null}
              </button>
          </li>
        );
        })}
      </ol>
      {/* 新手模式的分步提示：每切换一步弹出当前步的说明，挂在步骤条正下方。 */}
      <StepTourHint steps={steps} current={current} />
    </nav>
  );
}
