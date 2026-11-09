import { useEffect, useRef, useState, type ReactNode } from "react";
import { parseTaxPageSelection, type TaxDocumentIndex, type TaxForm } from "./audipickTax";
import type { TaxReviewGroup } from "./audipickTaxReview";

type Props = {
  index: TaxDocumentIndex;
  catalogue: TaxForm[];
  group: TaxReviewGroup;
  groups: TaxReviewGroup[];
  page: number;
  busy: boolean;
  error?: string;
  preview: (page: number) => ReactNode;
  onSave: (group: TaxReviewGroup, next: boolean) => Promise<void>;
  onRecognize: (page: number) => Promise<void>;
  onClose: () => void;
};

export function AudiPickTaxReviewDialog(props: Props) {
  const [draft, setDraft] = useState(props.group);
  const [pages, setPages] = useState(props.group.pages.join(","));
  const [page, setPage] = useState(props.page);
  const [localError, setLocalError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);
  let selectedPages: number[] = [];
  try { selectedPages = parseTaxPageSelection(pages, props.index.pages.length); } catch { /* A draft may be incomplete while typing; saving validates it. */ }
  async function submit(next: boolean) {
    try {
      setLocalError("");
      const selected = parseTaxPageSelection(pages, props.index.pages.length);
      if (!selected.length) throw new Error("请至少选择一页。");
      await props.onSave({ ...draft, pages: selected }, next);
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
  }
  return <div className="tax-source-backdrop"><div ref={dialog} role="dialog" aria-modal="true" aria-label="税表人工复核" className="tax-source-dialog tax-review-dialog" onKeyDown={event => {
    if (event.key === "Escape" && !props.busy) props.onClose();
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex='0']") ?? []);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <header><strong>税表人工复核 · {props.index.fileName}</strong><button disabled={props.busy} onClick={props.onClose}>取消</button></header>
    <div className="tax-review-columns">
      <section className="tax-review-original" aria-label="原页核对"><div className="tax-actions"><button disabled={props.busy || page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>PDF 第 {page} 页 / 共 {props.index.pages.length} 页</span><button disabled={props.busy || page >= props.index.pages.length} onClick={() => setPage(page + 1)}>下一页</button><button disabled={props.busy} onClick={() => void props.onRecognize(page)}>重新识别此页</button></div>{props.preview(page)}</section>
      <section className="tax-review-fields" aria-label="复核设置">
        <p>把本表首页和续页选在同一组；不同所属期的同名表，请分别确认。保存后可再次修改。</p>
        <label><input type="checkbox" checked={draft.status === "excluded"} disabled={props.busy} onChange={event => setDraft({ ...draft, status: event.target.checked ? "excluded" : "confirmed" })}/>无需提取</label>
        <label>表单类型<select value={draft.formKey} disabled={props.busy || draft.status === "excluded"} onChange={event => setDraft({ ...draft, formKey: event.target.value })}><option value="">请选择表单</option>{props.catalogue.map(form => <option key={form.key} value={form.key}>{form.formName} {form.formCode}</option>)}</select></label>
        <label>公司名称<input disabled={props.busy || draft.status === "excluded"} value={draft.companyName} onChange={event => setDraft({ ...draft, companyName: event.target.value })}/></label>
        <label>所属期<input disabled={props.busy || draft.status === "excluded"} value={draft.period} onChange={event => setDraft({ ...draft, period: event.target.value })}/></label>
        <label>PDF 页码（含续页）<input disabled={props.busy} value={pages} placeholder="例如 1-2,4" onChange={event => setPages(event.target.value)}/></label>
        <div className="tax-review-pages" aria-label="选择首页和续页">{props.index.pages.map(item => {
          const assigned = props.groups.find(group => group.id !== draft.id && group.pages.includes(item.page));
          return <div key={item.page}><label><input type="checkbox" disabled={props.busy || Boolean(assigned)} checked={selectedPages.includes(item.page)} onChange={event => setPages((event.target.checked ? [...selectedPages, item.page] : selectedPages.filter(number => number !== item.page)).sort((a,b) => a-b).join(","))}/>PDF 第 {item.page} 页 · {item.formName || item.reason || "未匹配"}{assigned ? "（已分配至其他复核组）" : ""}</label><button disabled={props.busy} onClick={() => setPage(item.page)}>查看第 {item.page} 页</button></div>;
        })}</div>
        {(localError || props.error) && <p role="alert">{localError || props.error}</p>}
        <div className="tax-actions"><button disabled={props.busy} onClick={() => void submit(false)}>确认并保存</button><button disabled={props.busy} onClick={() => void submit(true)}>保存并查看下一项</button></div>
      </section>
    </div>
  </div></div>;
}
