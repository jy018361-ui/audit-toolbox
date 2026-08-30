import { useState } from "react";

/**
 * 数字输入框：编辑期间原样保留用户敲的文本。
 *
 * 受控输入若每敲一个字符就把文本转成数字、再由数字转回文本塞回格子，
 * 用户根本没法把小数敲完整——敲到「0.」「0.0」时数字都是 0，格子被改写回
 * 「0」，小数点连着后面的位数一起被吞，0.05 永远填不进去（往往还会变成 5）。
 * 所以正在编辑时按用户敲的原文显示，失焦后才交回上层规范化后的值。
 *
 * `onCommit` 收到的是格子里的**原始文本**（不是数字），由调用方按自己的口径
 * 解析：百分数要除以 100，空串该当成"没填"还是 0 也各页自己决定。
 * 注意 `type="number"` 的浏览器会把敲到一半的「0.」当成空串给出来，
 * 空串既可能是"清空了"也可能是"小数还没敲完"，两者按同一条路径处理即可。
 */
export function NumberInput({
  value,
  onCommit,
  label,
  className,
  placeholder,
  step,
  min,
  max,
  disabled,
}: {
  value: string | number;
  onCommit: (text: string) => void;
  label?: string;
  className?: string;
  placeholder?: string;
  step?: string | number;
  min?: string | number;
  max?: string | number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string>();
  return (
    <input
      type="number"
      aria-label={label}
      className={className}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      placeholder={placeholder}
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value);
        onCommit(e.target.value);
      }}
      onBlur={() => setDraft(undefined)}
    />
  );
}
