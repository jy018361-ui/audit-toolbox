import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type CreditBalanceAccount = {
  key: string;
  account: string;
  currency: string;
  closingBalance: number;
};

/** 存款账户期末出现贷方余额（资产科目反常方向，常见于资金池归集／透支）：
    默认不纳入利息测算，避免负余额悄悄抵减测算结果；用户显式确认后才纳入。 */
export function CreditBalanceDialog({
  open,
  accounts,
  onCancel,
  onInclude,
}: {
  open: boolean;
  accounts: CreditBalanceAccount[];
  onCancel: () => void;
  onInclude: () => void;
}) {
  const amount = (value: number) =>
    new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value));
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {accounts.length} 个存款账户期末为贷方余额，默认未纳入测算
          </DialogTitle>
          <DialogDescription>
            存款账户的期末余额应正常在借方。下列账户期末为贷方余额（常见于资金池归集或透支），
            为避免负余额抵减测算利息，本次测算默认未将其纳入。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-56 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">银行账户／科目</th>
                <th className="px-3 py-2 text-left font-medium">币种</th>
                <th className="px-3 py-2 text-right font-medium">期末余额</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((item) => (
                <tr key={item.key} className="border-t">
                  <td className="px-3 py-2" title={item.account}>
                    {item.account}
                  </td>
                  <td className="px-3 py-2">{item.currency || "未标币种"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-600">
                    {amount(item.closingBalance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          若选择纳入，这些账户将按贷方余额参与测算，其利息会抵减测算利息合计；
          该口径会记录在测算结果与底稿中，重新测算前可随时改回。
        </p>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            保持不纳入（推荐）
          </Button>
          <Button onClick={onInclude}>纳入测算并重算</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
