import { cn } from "@/lib/utils";

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
};

/**
 * 统一的步骤条（三态：active / done / disabled）。
 * 取代 FA 的 .fa-steps 与看账的 .kz-steps 两套重复实现。
 * 不用 ShadCN Tabs——Tabs 只有 active/inactive，缺少 done（已完成）三态。
 *
 * 禁用只由调用方传入的 step.disabled 决定：FA 的步骤 2/3 在匹配完成后
 * 应可点击进入，不能因"非当前步且未完成"被自动禁用。
 */
export function StepIndicator({ steps, current, onStepClick }: StepIndicatorProps) {
  return (
    <div className="step-indicator">
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        // disabled 只由外部传入的 step.disabled 决定。
        // 不能用 (!done && !active) 自动禁用：FA 的步骤 2/3 的可用性由
        // 业务条件（如 !faStats）控制，匹配完成后应可点击进入。
        const disabled = Boolean(step.disabled);
        return (
          <button
            key={step.key}
            type="button"
            className={cn(
              "step-indicator-item",
              active && "active",
              done && "done",
              disabled && "disabled",
            )}
            disabled={disabled}
            onClick={() => onStepClick?.(index)}
          >
            <span className="step-indicator-index">{done ? "✓" : index + 1}</span>
            <span className="step-indicator-label">{step.label}</span>
          </button>
        );
      })}
    </div>
  );
}
