import type { ReactNode } from "react";
import { FileDropInput } from "@/components/FileDropInput";
import { JobProgress } from "@/components/JobProgress";
import { Button } from "@/components/ui/button";
import type { JobEvent } from "@/types";

/**
 * 凭证文件加载区：拖放/选择文件 + Sheet + 标题行 + 读取并自动映射。
 * 看账工具与正负数凭证标记共用，两处的上传交互必须完全一致。
 * 标题行默认「自动识别」（0）：后端与存款/汇兑引擎同一打分口径探测；
 * 表头不在第 1 行的余额表（如带封面行/说明行）无需手选。
 * children 落在读取按钮和进度条之后，供各页面接自己的后续内容。
 */
const HEADER_ROW_CHOICES = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12];
export function LedgerSourceCard({inputPath,sheet,knownSheets,headerRow,detectedHeaderRow,dragHover,busy,job,needsReload,onBrowse,onClear,onSheetChange,onHeaderRowChange,onInspect,onCancel,children}:{
  inputPath:string;sheet:string;knownSheets:string[];headerRow:number;
  detectedHeaderRow?:number;
  dragHover?:boolean;busy?:boolean;job?:JobEvent;needsReload?:boolean;
  onBrowse:()=>void;onClear?:()=>void;
  onSheetChange:(value:string)=>void;onHeaderRowChange:(value:number)=>void;
  onInspect:()=>void;onCancel?:(jobId:string)=>void;
  children?:ReactNode;
}){
  return <section className="kz-card">
    <h2>加载数据</h2>
    <div className="kz-path"><FileDropInput value={inputPath} placeholder="拖放或点击选择凭证文件" onBrowse={onBrowse} onClear={inputPath?onClear:undefined} onDragStateChange={()=>{}} highlight={dragHover}/></div>
    <div className="kz-two">
      <label>Sheet<select value={sheet} onChange={e=>onSheetChange(e.target.value)}><option value="">自动/首个 Sheet</option>{knownSheets.map(value=><option key={value}>{value}</option>)}</select></label>
      <label>标题行<select value={String(headerRow)} onChange={e=>onHeaderRowChange(Number(e.target.value))}>
        {HEADER_ROW_CHOICES.map(value=><option key={value} value={String(value)}>{value===0?"自动识别":`第 ${value} 行`}</option>)}
      </select></label>
    </div>
    {headerRow===0&&detectedHeaderRow!==undefined&&<p className="kz-hint">已自动按第 {detectedHeaderRow} 行识别表头。</p>}
    {needsReload&&<p>Sheet 或标题行已变化，请重新读取以刷新预览和映射。</p>}
    <div className="kz-actions"><Button variant="default" disabled={busy} onClick={onInspect}>读取并自动映射</Button>{busy&&job&&onCancel&&<Button variant="secondary" size="sm" onClick={()=>onCancel(job.jobId)}>停止</Button>}</div>
    {/* 读取几十万行凭证要几十秒，原来这一步只有按钮变灰，用户不知道是在跑还是卡死了。 */}
    {busy&&job&&onCancel&&<JobProgress job={job} onCancel={onCancel} cancelLabel="取消任务"/>}
    {children}
  </section>;
}
