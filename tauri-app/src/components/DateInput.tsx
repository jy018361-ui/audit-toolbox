import { forwardRef, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";

type NativeInputProps = Omit<
  ComponentProps<"input">,
  "defaultValue" | "inputMode" | "maxLength" | "onChange" | "pattern" | "type" | "value"
>;

export type DateInputProps = NativeInputProps & {
  /** ISO date used by page state and the Rust boundary. Partial input is kept locally. */
  value: string;
  onChange: (value: string) => void;
};

function dateDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 8);
}

export function formatDateDigits(digits: string): string {
  const safe = dateDigits(digits);
  if (safe.length <= 4) return safe;
  if (safe.length <= 6) return `${safe.slice(0, 4)}-${safe.slice(4)}`;
  return `${safe.slice(0, 4)}-${safe.slice(4, 6)}-${safe.slice(6)}`;
}

/** Keep edited year/month/day in their own slots when separators are present. */
export function formatDateEdit(raw: string): string {
  if (/^\d{0,4}-\d{0,2}(?:-\d{0,2})?$/.test(raw)) return raw;
  return formatDateDigits(raw);
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Eight-digit date entry for WebView2. Typing 20261231 continuously produces
 * 2026-12-31; editing one segment does not shift digits from another segment.
 * Callers only receive an empty string or a complete valid ISO date.
 */
export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(
  function DateInput({ value, onChange, onBlur, placeholder = "YYYYMMDD", ...props }, ref) {
    const [displayValue, setDisplayValue] = useState(() => formatDateDigits(value));
    const locallyEmitted = useRef<string | null>(null);

    useEffect(() => {
      if (locallyEmitted.current === value) {
        locallyEmitted.current = null;
        return;
      }
      setDisplayValue(formatDateDigits(value));
    }, [value]);

    const invalid = dateDigits(displayValue).length === 8 && !isValidIsoDate(displayValue);

    return (
      <Input
        {...props}
        ref={ref}
        type="text"
        inputMode="numeric"
        maxLength={10}
        placeholder={placeholder}
        value={displayValue}
        aria-invalid={props["aria-invalid"] ?? (invalid || undefined)}
        title={invalid ? "请输入有效日期（年份4位、月份2位、日期2位）" : props.title}
        onChange={(event) => {
          const nextValue = formatDateEdit(event.target.value);
          setDisplayValue(nextValue);
          const emitted = isValidIsoDate(nextValue) ? nextValue : "";
          locallyEmitted.current = emitted;
          onChange(emitted);
        }}
        onBlur={onBlur}
      />
    );
  },
);
