import type { ReactNode } from "react";
import { FileDropInput } from "@/components/FileDropInput";
import { JobProgress } from "@/components/JobProgress";
import { SourceTableControls } from "@/components/SourceTableControls";
import { Button } from "@/components/ui/button";
import type { JobEvent } from "@/types";

/**
 * 凭证文件加载区：拖放/选择文件 + 读取并自动映射，读取设置随预览显示。
 * 看账工具与正负数凭证标记共用，两处的上传交互必须完全一致。
 * 标题行默认「自动识别」（0）：后端与存款/汇兑引擎同一打分口径探测；
 * 表头不在第 1 行的余额表（如带封面行/说明行）无需手选。
 * children 落在读取按钮和进度条之后，供各页面接自己的后续内容。
 */
export function LedgerSourceControls(props: {
  sheet:string;knownSheets:string[];headerRow:number;
  headerDepth?:number;
  busy?:boolean;
  onSheetChange:(value:string)=>void;onHeaderRowChange:(value:number)=>void;
  onHeaderDepthChange?:(value:number)=>void;
}) {
  return <SourceTableControls
    sheet={props.sheet} sheets={props.knownSheets} headerRow={props.headerRow}
    headerDepth={props.headerDepth} disabled={props.busy} automaticSheet automaticDepth
    headerRowChoices={[0, 1, 2, 3, 4, 5, 6, 8, 10, 12]}
    onSheetChange={props.onSheetChange}
    onHeaderRowChange={(row) => props.onHeaderRowChange(Number(row))}
    onHeaderDepthChange={props.onHeaderDepthChange}
  />;
}
export function LedgerSourceCard({inputPath,dragHover,busy,job,onBrowse,onClear,onInspect,onCancel,children,className}:{
  inputPath:string;
  dragHover?:boolean;busy?:boolean;job?:JobEvent;
  onBrowse:()=>void;onClear?:()=>void;
  onInspect:()=>void;onCancel?:(jobId:string)=>void;
  children?:ReactNode;
  className?:string;
}){
  return <section className={`kz-card${className?` ${className}`:""}`}>
    <h2>加载数据</h2>
    <div className="kz-path"><FileDropInput value={inputPath} placeholder="拖放或点击选择凭证文件" onBrowse={onBrowse} onClear={inputPath?onClear:undefined} onDragStateChange={()=>{}} highlight={dragHover} disabled={busy}/></div>
    <div className="kz-actions" data-button-size="default"><Button variant="default" disabled={busy} onClick={onInspect}>读取并自动映射</Button>{busy&&job&&onCancel&&<Button variant="secondary" size="default" onClick={()=>onCancel(job.jobId)}>停止</Button>}</div>
    {/* 读取几十万行凭证要几十秒，原来这一步只有按钮变灰，用户不知道是在跑还是卡死了。 */}
    {busy&&job&&onCancel&&<JobProgress job={job} onCancel={onCancel} cancelLabel="取消任务"/>}
    {children}
  </section>;
}
