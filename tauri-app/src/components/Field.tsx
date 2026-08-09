import type { ReactNode } from "react";

export type FieldProps = {
  label: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
  className?: string;
};

/**
 * 统一的表单字段容器（标签 + 控件 + 提示）。取代各页面手写的 `<label class="field">` 结构。
 */
export function Field({ label, required, hint, children, className }: FieldProps) {
  return (
    <label className={`field ${className ?? ""}`}>
      <span className="field-label">
        {label}
        {required && <b className="field-required">*</b>}
      </span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}
