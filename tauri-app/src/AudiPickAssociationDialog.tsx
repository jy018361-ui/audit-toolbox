import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./components/ui/dialog";
import { errorText } from "./lib/errors";

export type AssociationMember = { fileId: string; role: string; [key: string]: unknown };
export type AssociationGroup = { id: string; anchorFileId: string; members: AssociationMember[] };
const roles = ["补充协议/变更", "框架协议", "订单/采购订单", "发票/结算资料", "验收/交付资料", "担保/抵质押资料", "提款/放款资料", "技术附件", "信用资料", "其他支持文件"];

export function AudiPickAssociationDialog({ anchorId, documents, groups, suggestion, onClose, onSave }: {
  anchorId: string;
  documents: { id: string; name: string }[];
  groups: AssociationGroup[];
  suggestion?: AssociationMember;
  onClose: () => void;
  onSave: (members: AssociationMember[]) => Promise<void>;
}) {
  const existing = groups.find((group) => group.anchorFileId === anchorId)?.members ?? [];
  const [members, setMembers] = useState<AssociationMember[]>(() => suggestion
    ? [...existing.filter((item) => item.fileId !== suggestion.fileId), suggestion] : existing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const isOccupied = (id: string) => groups.some((group) => group.anchorFileId !== anchorId &&
    (group.anchorFileId === id || group.members.some((member) => member.fileId === id)));
  const anchorOccupied = groups.some((group) => group.members.some((member) => member.fileId === anchorId));
  const occupiedIds = new Set(documents.filter((item) => item.id !== anchorId && isOccupied(item.id)).map((item) => item.id));
  const candidates = documents
    .filter((item) => item.id !== anchorId && !occupiedIds.has(item.id))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
  const visibleCandidates = candidates.filter((item) => !normalizedSearch || item.name.toLocaleLowerCase("zh-CN").includes(normalizedSearch));
  async function save() {
    setBusy(true); setError("");
    try {
      if (anchorOccupied || members.some((member) => isOccupied(member.fileId) || member.fileId === anchorId || !documents.some((item) => item.id === member.fileId))) {
        throw new Error("文件已属于其他关联组，请先解除原关联。");
      }
      await onSave(members); onClose();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy} className="max-w-3xl grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] overflow-hidden">
      <DialogTitle>管理关联资料</DialogTitle>
      <DialogDescription>主文件：{documents.find((item) => item.id === anchorId)?.name}。已选 {members.length} 份，取消勾选可解除关联。</DialogDescription>
      <div className="grid gap-2">
        <input
          type="search"
          value={search}
          disabled={busy}
          placeholder="搜索可关联文件"
          aria-label="搜索可关联文件"
          onChange={(event) => setSearch(event.target.value)}
          className="h-10 w-full rounded-md border border-[var(--control-border)] bg-[var(--surface-sunken)] px-3 text-sm text-[var(--ink-strong)]"
        />
        {occupiedIds.size > 0 && <p className="m-0 text-xs text-muted-foreground">已隐藏 {occupiedIds.size} 份已归入其他合同组的文件</p>}
        {anchorOccupied && <p role="alert" className="m-0 text-xs text-[var(--danger-fg)]">当前文件已是其他合同的关联资料，请先解除原关联。</p>}
      </div>
      <div role="list" aria-label="可关联文件" className="min-h-0 max-h-[52vh] overflow-y-auto rounded-lg border border-[var(--border-soft)]">
        {visibleCandidates.map((item) => {
          const member = members.find((value) => value.fileId === item.id);
          const checkboxId = `association-${anchorId}-${item.id}`;
          return <div role="listitem" key={item.id} className="grid min-h-14 grid-cols-[20px_minmax(0,1fr)_minmax(150px,220px)] items-center gap-3 border-b border-[var(--border-soft)] px-3 py-2 last:border-b-0">
            <input
              id={checkboxId}
              className="size-4 justify-self-center"
              type="checkbox"
              aria-label={`选择${item.name}`}
              checked={Boolean(member)}
              disabled={busy || anchorOccupied}
              onChange={(event) => setMembers((current) => event.target.checked
                ? [...current, { fileId: item.id, role: roles[0], source: "manual" }]
                : current.filter((value) => value.fileId !== item.id))}
            />
            <label htmlFor={checkboxId} className="min-w-0 cursor-pointer truncate text-sm" title={item.name}>{item.name}</label>
            {member ? <select
              aria-label={`${item.name}的资料角色`}
              value={member.role}
              disabled={busy || anchorOccupied}
              className="h-9 min-w-0 rounded-md border border-[var(--control-border)] bg-[var(--surface-sunken)] px-2 text-sm"
              onChange={(event) => setMembers((current) => current.map((value) => value.fileId === item.id ? { ...value, role: event.target.value } : value))}
            >
              {[...new Set([...roles, member.role])].map((role) => <option key={role}>{role}</option>)}
            </select> : <span className="text-right text-xs text-muted-foreground">勾选后选择角色</span>}
          </div>;
        })}
        {documents.length < 2 && <p className="m-0 p-5 text-center text-sm text-muted-foreground">请先上传需要关联的其他文件。</p>}
        {documents.length >= 2 && visibleCandidates.length === 0 && <p className="m-0 p-5 text-center text-sm text-muted-foreground">
          {search.trim() ? "没有匹配的文件。" : "没有尚未归组的可关联文件。"}
        </p>}
      </div>
      <div className="border-t border-[var(--border-soft)] pt-3">
        {error && <p role="alert" className="error-box">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2"><button className="ghost" disabled={busy} onClick={onClose}>取消</button><button className="primary min-h-10 rounded-md px-4" disabled={busy || anchorOccupied} onClick={() => void save()}>{busy ? "保存中…" : "保存关联"}</button></div>
      </div>
    </DialogContent>
  </Dialog>;
}
