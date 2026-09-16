import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type CurrencyFallbackMode = "functional" | "twoPointByCurrency";

export function CurrencyFallbackDialog({
  open,
  affectedGroupCount,
  missingCurrencies,
  value,
  onChange,
  onCancel,
  onContinue,
}: {
  open: boolean;
  affectedGroupCount: number;
  missingCurrencies: string[];
  value: CurrencyFallbackMode | "";
  onChange: (value: CurrencyFallbackMode) => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const facts = [
    affectedGroupCount > 0 ? `涉及 ${affectedGroupCount} 个多币种账户` : "存在多币种账户",
    missingCurrencies.length > 0
      ? `JE 未匹配币种：${missingCurrencies.join("、")}`
      : "JE 未找到对应外币币种",
  ].join("；");
  const option = (
    mode: CurrencyFallbackMode,
    title: string,
    description: string,
  ) => (
    <label
      className={`grid cursor-pointer grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border p-3 transition-colors ${
        value === mode
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/50"
      }`}
    >
      <input
        type="radio"
        name="currency-fallback-mode"
        value={mode}
        checked={value === mode}
        onChange={() => onChange(mode)}
        className="mt-1"
      />
      <strong>{title}</strong>
      <span className="col-start-2 text-sm leading-relaxed text-muted-foreground">
        {description}
      </span>
    </label>
  );
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>请选择多币种账户的测算方式</DialogTitle>
          <DialogDescription>
            TB 中发现同一账户包含多个币种，但 JE 无法支持全部外币按币种还原逐月余额。请选择本次测算口径。
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">{facts}</p>
        <div className="grid gap-3">
          {option(
            "functional",
            "统一使用本位币匡算",
            "合并各币种的本位币余额，使用 JE 本位币发生额还原逐月余额，并统一填写利率。",
          )}
          {option(
            "twoPointByCurrency",
            "按币种使用年初、年末平均值",
            "保留 TB 的币种明细并分别填写利率；不使用 JE 还原逐月余额，按各币种年初、年末余额的平均值匡算。",
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          所选口径将记录在测算底稿中，重新测算时可以修改。
        </p>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>取消</Button>
          <Button disabled={!value} onClick={onContinue}>按所选口径继续</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
