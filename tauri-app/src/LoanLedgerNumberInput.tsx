import { useState } from "react";
import { Input } from "./components/ui/input";

export function loanLedgerNumber(value: number | null | undefined, percent = false): string {
  if (value == null || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("zh-CN", {
    useGrouping: !percent,
    minimumFractionDigits: percent ? 0 : 2,
    maximumFractionDigits: percent ? 8 : 2,
  }).format(percent ? value * 100 : value);
}

/** 编辑时保留小数草稿，失焦后恢复千位分隔／百分比显示。 */
export function LoanLedgerNumberInput({ label, value, onChange, percent = false, invalid, disabled }: {
  label: string;
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  percent?: boolean;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string>();
  const [badDraft, setBadDraft] = useState(false);
  return <Input
    aria-label={label}
    aria-invalid={invalid || badDraft}
    className="loan-ledger-number"
    type="text"
    inputMode="decimal"
    value={draft ?? loanLedgerNumber(value, percent)}
    disabled={disabled}
    onFocus={() => setDraft(value == null ? "" : percent ? loanLedgerNumber(value, true) : String(value))}
    onChange={event => {
      const raw = event.target.value;
      setDraft(raw);
      const clean = raw.trim().replaceAll(",", "").replaceAll("，", "").replace(/[％%]$/, "");
      const parsed = clean === "" ? null : Number(clean);
      const valid = raw.trim() === "" || (parsed != null && Number.isFinite(parsed));
      setBadDraft(!valid);
      // 无效草稿由主表校验拦住测算，不能被当作允许留空的期末余额。
      onChange(!valid ? NaN : parsed == null ? null : parsed / (percent ? 100 : 1));
    }}
    onBlur={() => { setDraft(undefined); setBadDraft(false); }}
  />;
}
