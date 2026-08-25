import { Button } from "@/components/ui/button";
import { formatMappingValue, KZ_ROLE_LABELS, MAPPING_CHANGE_LABEL, needsAttention, type Mapping, type MappingChange, type Review } from "@/ledgerMapping";

/**
 * 凭证字段映射的 LLM 复核卡。看账工具与正负数凭证标记共用。
 * 与 components/LlmReview 的差别在于这里按"先斩后奏 + 可撤销"的变更清单呈现，
 * 不是 FA 那种"建议待采纳"清单，两者视觉相近但交互语义不同，故各自保留。
 */
export function LedgerLlmReview({busy,failed,status,mapping,changes,pending,onSkip,onUndo,onAccept,onKeep}:{
  busy:boolean;failed:boolean;status:string;mapping:Mapping;
  changes:MappingChange[];pending:Review[];
  onSkip:()=>void;onUndo:(change:MappingChange)=>void;onAccept:(item:Review)=>void;onKeep:(item:Review)=>void;
}){
  return <div className={`fa-llm-review ${failed||pending.length?"warning":""}`}>
    <div className="section-title"><h3>LLM 映射复核</h3><span className={`pill ${busy?"preview":failed||pending.length?"warning":"ready"}`}>{busy?"复核中":failed?"失败（不阻塞）":pending.length?"需人工确认":"已完成"}</span></div>
    <p>{busy?"正在复核字段映射；复核期间字段映射暂时锁定，避免你改到一半又被结果覆盖。":status}</p>
    {busy&&<div className="actions compact"><Button variant="secondary" size="sm" onClick={onSkip}>跳过复核并继续</Button></div>}
    {changes.map((item,index)=><div className={`fa-review-item fa-change${needsAttention(item)?" attention":""}`} key={`${item.source}-${item.role}-${index}`}>
      <strong>{KZ_ROLE_LABELS[item.role]}<em>{MAPPING_CHANGE_LABEL[item.source]}</em></strong>
      <span className="fa-change-diff">{formatMappingValue(item.before)} → {formatMappingValue(item.after)}</span>
      {!!item.reason&&<span>{item.reason}{item.confidence?`（把握 ${Math.round(item.confidence*100)}%）`:""}</span>}
      <div className="actions compact"><Button variant="secondary" size="sm" disabled={busy} onClick={()=>onUndo(item)}>撤销</Button></div>
    </div>)}
    {pending.map(item=><div className="fa-review-item fa-pending" key={`pending-${item.role}-${item.suggestedColumn}`}>
      <strong>{KZ_ROLE_LABELS[item.role]}<em>把握不足，未改动</em></strong>
      <span className="fa-change-diff">{formatMappingValue(mapping[item.role])} → {item.suggestedColumn}</span>
      {!!item.reason&&<span>{item.reason}{item.confidence?`（把握 ${Math.round(item.confidence*100)}%）`:""}</span>}
      <div className="actions compact"><Button variant="secondary" size="sm" disabled={busy} onClick={()=>onAccept(item)}>采纳</Button><Button variant="secondary" size="sm" disabled={busy} onClick={()=>onKeep(item)}>保留当前</Button></div>
    </div>)}
  </div>;
}
