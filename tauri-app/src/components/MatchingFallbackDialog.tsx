import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type MatchingFallbackMode = "accountJe" | "tbAverage";
export type MatchingFallbackGroup = { entity: string; accountCode: string; names: string[]; canUseJe: boolean };

export function MatchingFallbackDialog({ open, groups, value, onChange, onCancel, onContinue, kind = "loan" }: {
  open: boolean;
  groups: MatchingFallbackGroup[];
  value: MatchingFallbackMode | "";
  onChange: (mode: MatchingFallbackMode) => void;
  onCancel: () => void;
  onContinue: () => void;
  kind?: "loan" | "deposit";
}) {
  const canUseJe = groups.length > 0 && groups.every(group => group.canUseJe);
  const option = (mode: MatchingFallbackMode, title: string, description: string, disabled = false) => (
    <label className={`grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border p-3 ${value === mode ? "border-primary bg-primary/5" : "border-border"} ${disabled ? "opacity-60" : "cursor-pointer hover:bg-muted/50"}`}>
      <input type="radio" name="matching-fallback-mode" value={mode} checked={value === mode} disabled={disabled} onChange={() => onChange(mode)} className="mt-1" />
      <strong>{title}</strong>
      <span className="col-start-2 text-sm leading-relaxed text-muted-foreground">{description}</span>
    </label>
  );
  return (
    <Dialog open={open} onOpenChange={next => !next && onCancel()}>
      <DialogContent className="max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>请选择{kind === "loan" ? "借款" : "存款"}明细无法衔接时的测算方式</DialogTitle>
          <DialogDescription>TB 中同一科目编码包含多家银行，但 JE 无法按名称或已验证辅助完整分配到各家银行。请选择这些科目的测算口径。</DialogDescription>
        </DialogHeader>
        <div className="max-h-40 overflow-auto rounded-md bg-muted px-3 py-2 text-sm">
          {groups.map(group => <p key={`${group.entity}\u001f${group.accountCode}`} className="break-words">{group.entity} / {group.accountCode}：{group.names.join("、")}</p>)}
        </div>
        <div className="grid gap-3">
          {option("accountJe", kind === "loan" ? "合并同码借款，按 JE 日期测算" : "合并同码存款，按 JE 还原逐月余额", kind === "loan" ? "合并所涉科目的全部 TB 银行明细，使用本位币 JE 发生额和实际日期逐日测算；合并后须统一确认利率，结果代表科目汇总匡算。" : "合并所涉科目的全部 TB 银行明细，使用本位币 JE 按日期还原逐月余额，按现有月均余额口径测算；合并后须统一填写利率，结果代表科目汇总匡算。", !canUseJe)}
          {option("tbAverage", "保留 TB 明细，按年初年末平均测算", "保留各银行的 TB 余额和各自利率；按（年初余额＋年末余额）÷2 测算，不使用 JE 日期。")}
        </div>
        {!canUseJe && <p className="text-sm text-muted-foreground">部分科目缺少期内有效日期的 JE，或同码明细未全部纳入测算。补齐资料并确认整码范围后，才能选择 JE 汇总。</p>}
        <p className="text-xs text-muted-foreground">口径将记录在底稿中。若各笔利率不同且需要精算，请先补齐银行或合同明细的对应关系。</p>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>取消</Button>
          <Button disabled={!value || (value === "accountJe" && !canUseJe)} onClick={onContinue}>按所选口径继续</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
