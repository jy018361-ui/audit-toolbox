import { useEffect, useMemo, useRef, useState } from "react";
import { engineCall, jobCancel, jobStart, listenJobEvents, openOutput, pickPath } from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./kanzhang-parity.css";
import { FileDropInput } from "@/components/FileDropInput";
import { DataTable } from "@/components/DataTable";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StepIndicator } from "@/components/StepIndicator";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";

export type Mapping = { id: string[]; account: string[]; entity?: string; date?: string; summary?: string; amount?: string; direction?: string; debit?: string; credit?: string };
type Inspect = { headers: string[]; preview: string[][]; sheets?: string[]; selectedSheet?: string; suggestedMapping?: Mapping; accounts?: string[]; accountCount?: number; dimensions?: { rows: number; columns: number } };
export type Batch = { name: string; accounts: string[] };
export type KanzhangDraft = { inputPath: string; sheet: string; knownSheets:string[]; headerRow: number; inspect?: Inspect; mapping: Mapping; batches: Batch[]; activeBatch: number; excludes: string[]; outputPath: string; outputTouched: boolean; includePivot: boolean; includeVoucherTypes: boolean; markLossTransfer: boolean; enableJeMatching: boolean; llmAnalysis:boolean; pivotRows: string[]; pivotColumns: string[]; pivotValues: string[]; step: number };
type Review={role:keyof Mapping;currentColumn?:string;suggestedColumn:string;confidence?:number;reason?:string};
const EMPTY: KanzhangDraft = { inputPath:"",sheet:"",knownSheets:[],headerRow:1,mapping:{id:[],account:[]},batches:[{name:"批次1",accounts:[]}],activeBatch:0,excludes:[],outputPath:"",outputTouched:false,includePivot:true,includeVoucherTypes:true,markLossTransfer:true,enableJeMatching:true,llmAnalysis:true,pivotRows:[],pivotColumns:[],pivotValues:[],step:1 };
const CACHE="audit-toolbox.kanzhang.draft.v2";
const loadDraft=():KanzhangDraft=>{try{return {...EMPTY,...JSON.parse(sessionStorage.getItem(CACHE)||"{}")};}catch{return EMPTY;}};
export const kanzhangErrorText=(error:unknown)=>{if(error instanceof Error)return error.message;if(error&&typeof error==="object"){const value=error as Record<string,unknown>;return String(value.userMessage??value.message??value.detail??"操作失败，请查看日志诊断。");}return String(error);};
export function setKanzhangMapping(current:Mapping,key:keyof Mapping,value:string|string[]):Mapping{const next={...current,[key]:value||undefined};if(key==="amount"||key==="direction"){next.debit=undefined;next.credit=undefined;}if(key==="debit"||key==="credit"){next.amount=undefined;next.direction=undefined;}return next;}
export const validKanzhangBatches=(batches:Batch[])=>batches.filter(value=>value.name.trim()&&value.accounts.length);
// 完成态保留结果摘要即可。若继续把上一轮筛选/导出的 100% 进度条画出来，
// 用户刚进入导出页时会误以为本轮导出已经完成。
export const shouldShowKanzhangJobProgress=(phase?:string)=>Boolean(phase&&!['completed','failed','cancelled'].includes(phase));
export const invalidateKanzhangInspection=(current:KanzhangDraft,change:Partial<Pick<KanzhangDraft,"sheet"|"headerRow">>):KanzhangDraft=>({...current,...change,inspect:undefined,mapping:{id:[],account:[]},step:1});
export const effectiveVoucherKey=(mapping:Mapping)=>[mapping.entity,mapping.date,...mapping.id].filter((value):value is string=>Boolean(value));
// LLM 常把"建议列 = 当前列"的字段也放进 reviews，采纳与否结果一样，属于噪音；这里按采纳后的实际效果判断是否值得展示。
export function isRedundantKanzhangReview(mapping:Mapping,item:{role:keyof Mapping;suggestedColumn?:string}):boolean{
  const suggested=item.suggestedColumn?.trim();
  if(!suggested)return true;
  const current=mapping[item.role];
  if(Array.isArray(current))return current.length===1&&current[0]?.trim()===suggested;
  return typeof current==="string"&&current.trim()===suggested;
}
// 把握达到门槛的直接改（可撤销），不到门槛的不动手，交回用户决定。
export const AUTO_APPLY_MIN=0.6;
export const shouldAutoApply=(confidence?:number)=>confidence===undefined||confidence>=AUTO_APPLY_MIN;
export function kanzhangReviewSummary(applied:number,pending:number):string{
  const done=applied?`已自动调整 ${applied} 项，不合适可逐条撤销`:"";
  const ask=pending?`另有 ${pending} 项把握不足 ${Math.round(AUTO_APPLY_MIN*100)}%，未改动，请确认是否采纳`:"";
  if(done&&ask)return `LLM 复核完成：${done}；${ask}。`;
  if(done)return `LLM 复核完成：${done}。`;
  if(ask)return `LLM 复核完成：${ask}。`;
  return "LLM 复核完成：现有字段映射与 LLM 判断一致，未做改动。";
}
// LLM 判断该改就直接改，用户在变更清单里核对"改前→改后"，不认可再撤销。
export type MappingChangeSource="fill"|"replace"|"scheme";
export type MappingChange={role:keyof Mapping;before?:string|string[];after?:string|string[];source:MappingChangeSource;reason?:string;confidence?:number};
export const MAPPING_CHANGE_LABEL:Record<MappingChangeSource,string>={fill:"已自动补充",replace:"已自动修正",scheme:"已按方案清除"};
// 变更清单里显示中文角色名——原来直接打印 summary/direction 这种内部键名，用户看不懂。
export const KZ_ROLE_LABELS:Record<keyof Mapping,string>={id:"凭证编号",account:"科目名称",entity:"公司/主体",date:"日期",summary:"摘要",amount:"方案A-金额",direction:"方案A-方向",debit:"方案B-借方",credit:"方案B-贷方"};
const isMultiRole=(role:keyof Mapping)=>role==="id"||role==="account";
export const formatMappingValue=(value?:string|string[]):string=>{
  if(Array.isArray(value)){const items=value.map(item=>item?.trim()).filter(Boolean);return items.length?items.join("、"):"未映射";}
  return typeof value==="string"&&value.trim()?value.trim():"未映射";
};
export const isSameMappingValue=(a?:string|string[],b?:string|string[]):boolean=>formatMappingValue(a)===formatMappingValue(b);
// 金额口径二选一：方案A（金额+方向）和方案B（借方+贷方）只能生效一套。
// 一旦其中一套映射成功，另一套既不该让用户手动选，LLM 也不该再对它提建议——
// 它显示的"未映射"是方案取舍的结果，不是漏填。
const SCHEME_A_ROLES:(keyof Mapping)[]=["amount","direction"];
const SCHEME_B_ROLES:(keyof Mapping)[]=["debit","credit"];
const hasValue=(value?:string)=>Boolean(value&&value.trim());
export function activeAmountScheme(mapping:Mapping):"A"|"B"|undefined{
  const a=hasValue(mapping.amount)||hasValue(mapping.direction);
  const b=hasValue(mapping.debit)||hasValue(mapping.credit);
  if(b&&!a)return "B";
  if(a&&!b)return "A";
  return undefined;
}
export function isSchemeLockedRole(mapping:Mapping,role:keyof Mapping):boolean{
  const scheme=activeAmountScheme(mapping);
  if(scheme==="B")return SCHEME_A_ROLES.includes(role);
  if(scheme==="A")return SCHEME_B_ROLES.includes(role);
  return false;
}
// 既然改动是先斩后奏，"清除了原有映射"和"LLM 自己也没把握"这两类最该被用户重点核对。
export const LOW_CONFIDENCE=0.7;
export const needsAttention=(change:MappingChange):boolean=>change.source==="scheme"||(change.confidence!==undefined&&change.confidence<LOW_CONFIDENCE);
// 同一字段可能被连续改动（先补充又被方案清除），清单里只呈现最初值到最终值的净变化。
export function mergeMappingChanges(changes:MappingChange[]):MappingChange[]{
  const merged=new Map<keyof Mapping,MappingChange>();
  for(const change of changes){
    const previous=merged.get(change.role);
    merged.set(change.role,previous?{...change,before:previous.before}:change);
  }
  return [...merged.values()].filter(change=>!isSameMappingValue(change.before,change.after));
}
export function undoMappingChange(mapping:Mapping,change:MappingChange):Mapping{
  const multi=isMultiRole(change.role);
  const before=change.before;
  const wasEmpty=multi?!(Array.isArray(before)&&before.length):!(typeof before==="string"&&before.trim());
  // 撤销"补充"只需清掉该字段；走 setKanzhangMapping 会连带清空互斥字段，反而破坏其他映射。
  if(wasEmpty)return {...mapping,[change.role]:multi?[]:undefined};
  return setKanzhangMapping(mapping,change.role,before as string|string[]);
}
// 科目检索按旧版口径：在已载入的科目列表上即时过滤，不需要点"搜索"。
export const filterAccounts=(values:string[],keyword:string):string[]=>{
  const kw=keyword.trim().toLowerCase();
  return kw?values.filter(value=>value.toLowerCase().includes(kw)):values;
};
// 与旧版 _build_default_save_name 一致：看账导出_<源文件名>[_工作表<Sheet>]_<时间戳>.csv
export function defaultKanzhangOutputName(inputPath:string,sheet:string,now=new Date()):string{
  const stem=(inputPath.split(/[\\/]/).pop()??"").replace(/\.[^.]+$/,"").trim()||"未命名";
  const pad=(value:number)=>String(value).padStart(2,"0");
  const stamp=`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const parts=["看账导出",stem];
  if(sheet.trim())parts.push(`工作表${sheet.trim()}`);
  parts.push(stamp);
  return `${parts.join("_").replace(/[\\/:*?"<>|]+/g,"_").replace(/\s+/g,"_")}.csv`;
}
// 默认落点：凭证文件所在目录 + 上面那个默认文件名。后端留空时算的是同一个路径，
// 提前显示出来是为了让用户导出前就知道文件会写到哪，而不是等结果链接出现才知道。
export function defaultKanzhangOutputPath(inputPath:string,sheet:string,now=new Date()):string{
  const index=Math.max(inputPath.lastIndexOf("\\"),inputPath.lastIndexOf("/"));
  if(index<0)return "";
  const directory=index===2&&inputPath[1]===":"?inputPath.slice(0,3):inputPath.slice(0,index);
  const separator=directory.endsWith("\\")||directory.endsWith("/")?"":"\\";
  return `${directory}${separator}${defaultKanzhangOutputName(inputPath,sheet,now)}`;
}

// 净额不是源表里的列，是按金额方案算出来的伪列，但它是透视的默认值字段，
// 界面上必须能选到——否则想同时看净额和某个原始金额列就没办法了。
export const NET_VALUE_FIELD="#_净额(Net)";
// 科目穿梭的三个区，拖拽时靠它判断来源和落点。
export type ShuttleZone="source"|"target"|"exclude";
// 把一批科目从一个区移到另一个区；从哪来就从哪removal，落到哪就并进哪。
export function moveShuttleAccounts(
  state:{targets:string[];excludes:string[]},
  values:string[],
  from:ShuttleZone,
  to:ShuttleZone,
):{targets:string[];excludes:string[]}{
  if(from===to||!values.length)return state;
  const moving=new Set(values);
  let targets=from==="target"?state.targets.filter(value=>!moving.has(value)):state.targets;
  let excludes=from==="exclude"?state.excludes.filter(value=>!moving.has(value)):state.excludes;
  if(to==="target")targets=[...new Set([...targets,...values])];
  if(to==="exclude")excludes=[...new Set([...excludes,...values])];
  return {targets,excludes};
}

export function KanzhangParityPage({tool}:{tool:ToolManifest}){
  const [draft,setDraft]=useState<KanzhangDraft>(loadDraft);
  const [query,setQuery]=useState(""); const [accounts,setAccounts]=useState<string[]>(draft.inspect?.accounts??[]); const [accountTotal,setAccountTotal]=useState<number>(draft.inspect?.accountCount??0); const [searchResults,setSearchResults]=useState<string[]>([]); const [selectedAvailable,setSelectedAvailable]=useState<string[]>([]);
  const [selectedTarget,setSelectedTarget]=useState<string[]>([]); const [selectedExclude,setSelectedExclude]=useState<string[]>([]);
  const [accountsKey,setAccountsKey]=useState(""); const [accountsBusy,setAccountsBusy]=useState(false); const [showExcludes,setShowExcludes]=useState(true);
  const [changes,setChanges]=useState<MappingChange[]>([]);const [pending,setPending]=useState<Review[]>([]);const [llmStatus,setLlmStatus]=useState("");
  const [llmBusy,setLlmBusy]=useState(false);const [llmFailed,setLlmFailed]=useState(false);const llmGeneration=useRef(0);
  const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const [job,setJob]=useState<JobEvent>(); const [result,setResult]=useState<unknown>();
  const patch=(value:Partial<KanzhangDraft>)=>setDraft(current=>({...current,...value}));
  const clearAll=()=>{llmGeneration.current+=1;setDraft({...EMPTY,batches:[{name:"批次1",accounts:[]}]});setAccounts([]);setAccountTotal(0);setAccountsKey("");setSearchResults([]);setSelectedAvailable([]);setQuery("");setResult(undefined);setChanges([]);setPending([]);setLlmStatus("");setLlmBusy(false);setLlmFailed(false);};
  const [dragHover,setDragHover]=useState(false);
  useEffect(()=>{if(typeof window==="undefined"||!("__TAURI_INTERNALS__" in window))return;let off:()=>void=()=>{};void getCurrentWebview().onDragDropEvent((event)=>{const p=event.payload;if(p.type==="over"||p.type==="enter"){setDragHover(true);}else if(p.type==="drop"){setDragHover(false);if(p.paths.length)patch({inputPath:p.paths[0],inspect:undefined,knownSheets:[],sheet:"",step:1});}else if(p.type==="leave"){setDragHover(false);}}).then((fn)=>{off=fn;});return ()=>off();},[]);
  useEffect(()=>{sessionStorage.setItem(CACHE,JSON.stringify(draft));},[draft]);
  // 没手选过保存位置时，输出框跟着凭证文件和 Sheet 走，显示这次会写到哪。
  // 只在来源变化时重算——默认文件名带时间戳，每次渲染都算会把自己重新触发一遍。
  const autoOutputKey=useRef("");
  useEffect(()=>{
    if(draft.outputTouched)return;
    const key=`${draft.inputPath}|${draft.sheet}`;
    if(autoOutputKey.current===key&&draft.outputPath)return;
    autoOutputKey.current=key;
    patch({outputPath:draft.inputPath?defaultKanzhangOutputPath(draft.inputPath,draft.sheet):""});
  },[draft.inputPath,draft.sheet,draft.outputTouched,draft.outputPath]);
  useEffect(()=>{let off=()=>{};void listenJobEvents(event=>{if(event.toolId!=="kanzhang")return;setJob(event);if(event.result){setResult(event.result);const payload=event.result as Inspect|undefined;if(event.phase==="completed"&&Array.isArray(payload?.headers))applyInspect(payload);}const done=["completed","failed","cancelled"].includes(event.phase);setBusy(!done);if(event.phase==="failed")setError(event.message);}).then(value=>off=value);return()=>off();},[]);
  const batch=draft.batches[draft.activeBatch]??draft.batches[0];
  // 输入框一敲就过滤（旧版是 StringVar trace）；只有科目被截断时才需要回后端补捞。
  const pool=useMemo(()=>{
    const kw=query.trim();
    if(!kw)return accounts;
    const local=filterAccounts(accounts,kw);
    if(!searchResults.length)return local;
    return [...new Set([...local,...filterAccounts(searchResults,kw)])].sort((a,b)=>a.localeCompare(b,"zh-Hans-CN"));
  },[accounts,query,searchResults]);
  const available=useMemo(()=>pool.filter(value=>!batch.accounts.includes(value)&&!draft.excludes.includes(value)),[pool,batch.accounts,draft.excludes]);
  const truncated=accountTotal>accounts.length;
  const setMap=(key:keyof Mapping,value:string|string[])=>patch({mapping:setKanzhangMapping(draft.mapping,key,value)});
  async function chooseInput(){const value=await pickPath("file","选择凭证文件",["xlsx","xls","xlsm","csv","txt","parquet"]);if(typeof value==="string")patch({inputPath:value,inspect:undefined,knownSheets:[],sheet:"",step:1});}
  async function inspect(){if(!draft.inputPath){setError("请选择凭证文件。");return;}setBusy(true);setError("");try{await jobStart("kanzhang.inspect",{inputPath:draft.inputPath,sheet:draft.sheet||undefined,headerRow:draft.headerRow});return;}catch(e){setError(kanzhangErrorText(e));setBusy(false);}}
  // 读取任务回来后套用表结构；改走任务通道是为了让大凭证文件的读取能报进度、能取消。
  // 透视默认只按科目名称分行——旧版就是这个口径。之前把公司也塞进行字段，
  // 同一科目被拆成每家公司一行，210 行的透视表膨胀到 665 行，跟旧版对不上。
  function applyInspect(value:Inspect){const suggested=value.suggestedMapping??EMPTY.mapping;setAccounts(value.accounts??[]);setAccountTotal(value.accountCount??(value.accounts??[]).length);setAccountsKey("");setSearchResults([]);setSelectedAvailable([]);setSelectedTarget([]);setSelectedExclude([]);setQuery("");patch({inspect:value,knownSheets:value.sheets??draft.knownSheets,sheet:value.selectedSheet??draft.sheet,mapping:suggested,pivotRows:[...suggested.account],pivotColumns:suggested.date?[suggested.date]:[],step:1});setResult(undefined);
    // 脚本自动映射一出来就直接送 LLM 复核，不再要求用户额外点一次按钮。
    void reviewMapping(suggested,value);}
  // 进入科目筛选时按用户最终确认的科目映射重载全量科目；inspect 阶段那份是按自动映射截断的。
  const accountMappingKey=draft.mapping.account.join("|");
  useEffect(()=>{
    if(draft.step!==2||!draft.inspect||!accountMappingKey||accountsKey===accountMappingKey||accountsBusy)return;
    void loadAccounts(accountMappingKey);
  },[draft.step,draft.inspect,accountMappingKey,accountsKey,accountsBusy]);
  async function loadAccounts(key:string){
    setAccountsBusy(true);
    try{
      const value=await engineCall("kanzhang.accounts",{inputPath:draft.inputPath,sheet:draft.sheet||undefined,headerRow:draft.headerRow,mapping:draft.mapping,keyword:"",limit:20000}) as {values:string[];total?:number};
      setAccounts(value.values);setAccountTotal(value.total??value.values.length);setAccountsKey(key);setSearchResults([]);setSelectedAvailable([]);
    }catch(e){setError(kanzhangErrorText(e));setAccountsKey(key);}
    finally{setAccountsBusy(false);}
  }
  async function searchAccounts(){try{const value=await engineCall("kanzhang.accounts",{inputPath:draft.inputPath,sheet:draft.sheet||undefined,headerRow:draft.headerRow,mapping:draft.mapping,keyword:query,limit:20000}) as {values:string[]};setSearchResults(value.values);setSelectedAvailable([]);}catch(e){setError(kanzhangErrorText(e));}}
  function skipReview(){llmGeneration.current+=1;setLlmBusy(false);setLlmFailed(false);setLlmStatus("已跳过本次 LLM 复核，保留当前字段映射，可自行调整后继续。");}
  async function reviewMapping(baseMapping?:Mapping,baseInspect?:Inspect){
    const target=baseInspect??draft.inspect;
    if(!target)return;
    const source=baseMapping??draft.mapping;
    const generation=++llmGeneration.current;
    setLlmBusy(true);setLlmFailed(false);setLlmStatus("");setError("");setChanges([]);setPending([]);
    try{const value=await engineCall("kanzhang.llm_mapping",{mode:"mapping",payload:{headers:target.headers,samples:target.preview.slice(0,8),currentMapping:source}}) as {scheme?:string;schemeReason?:string;fills?:Review[];reviews?:Review[]};
      if(generation!==llmGeneration.current)return;
      let next={...source};const applied:MappingChange[]=[];
      // 补充和修正一视同仁：把握够就直接改（清单里可撤销），把握不足的留给用户定夺。
      const waiting:Review[]=[];
      for(const item of [...(value.fills??[]),...(value.reviews??[])]){
        if(!item?.role||!item.suggestedColumn?.trim()||isRedundantKanzhangReview(next,item))continue;
        // 另一套金额方案已经映射成功，对它的建议一律丢弃，不进清单也不提示。
        if(isSchemeLockedRole(next,item.role))continue;
        if(!shouldAutoApply(item.confidence)){waiting.push(item);continue;}
        const before=next[item.role];const after=isMultiRole(item.role)?[item.suggestedColumn.trim()]:item.suggestedColumn.trim();
        next={...next,[item.role]:after};
        applied.push({role:item.role,before,after,source:formatMappingValue(before)==="未映射"?"fill":"replace",reason:item.reason,confidence:item.confidence});
      }
      // 方案还没定下来时才听 LLM 的；已经有一套映射成功就不许它反过来清空。
      const dropped:(keyof Mapping)[]=activeAmountScheme(source)?[]:value.scheme==="A"?["debit","credit"]:value.scheme==="B"?["amount","direction"]:[];
      for(const role of dropped){const before=next[role];if(typeof before==="string"&&before.trim())applied.push({role,before,after:undefined,source:"scheme",reason:value.schemeReason?.trim()||`LLM 判定为方案${value.scheme}，已清除与之互斥的字段映射。`});next={...next,[role]:undefined};}
      const merged=mergeMappingChanges(applied);const rest=waiting.filter(item=>!isRedundantKanzhangReview(next,item)&&!isSchemeLockedRole(next,item.role));
      patch({mapping:next});setChanges(merged);setPending(rest);setLlmStatus(kanzhangReviewSummary(merged.length,rest.length));}
    catch(e){if(generation!==llmGeneration.current)return;setLlmFailed(true);setLlmStatus(`${kanzhangErrorText(e).replace(/[。.]+$/,"")}。脚本自动映射已完成，可直接核对后继续；LLM 复核只是可选的辅助检查。`);}
    finally{if(generation===llmGeneration.current)setLlmBusy(false);}
  }
  const undoChange=(target:MappingChange)=>{patch({mapping:undoMappingChange(draft.mapping,target)});setChanges(values=>values.filter(value=>value!==target));};
  // 采纳低把握建议后同样进变更清单，保留反悔的机会。
  const acceptPending=(item:Review)=>{const before=draft.mapping[item.role];const after=isMultiRole(item.role)?[item.suggestedColumn.trim()]:item.suggestedColumn.trim();setMap(item.role,after);setChanges(values=>[...values,{role:item.role,before,after,source:formatMappingValue(before)==="未映射"?"fill":"replace",reason:item.reason,confidence:item.confidence}]);setPending(values=>values.filter(value=>value!==item));};
  const updateBatch=(next:Partial<Batch>)=>patch({batches:draft.batches.map((value,index)=>index===draft.activeBatch?{...value,...next}:value)});
  // 拖拽状态提到页面这一层：三个穿梭区要能互相知道光标落在谁身上。
  const [drag,setDrag]=useState<ShuttleDrag>();
  const dragRef=useRef<ShuttleDrag|undefined>(undefined);
  const moveRef=useRef<(values:string[],from:ShuttleZone,to:ShuttleZone)=>void>(()=>{});
  function beginDrag(from:ShuttleZone,values:string[],x:number,y:number){
    const next:ShuttleDrag={from,values,x,y,over:shuttleZoneAt(x,y)};
    dragRef.current=next;setDrag(next);
  }
  const dragging=!!drag;
  useEffect(()=>{
    if(!dragging)return;
    const stop=()=>{dragRef.current=undefined;setDrag(undefined);};
    // 光标位置一变就重算落点；位置没动、只是页面被自动滚了，也要重算。
    const track=(x:number,y:number)=>{
      const current=dragRef.current;
      if(!current)return;
      const over=shuttleZoneAt(x,y);
      if(current.x===x&&current.y===y&&current.over===over)return;
      const next:ShuttleDrag={...current,x,y,over};
      dragRef.current=next;setDrag(next);
    };
    const move=(event:PointerEvent)=>track(event.clientX,event.clientY);
    const drop=(event:PointerEvent)=>{
      const current=dragRef.current;
      stop();
      if(!current)return;
      const to=shuttleZoneAt(event.clientX,event.clientY);
      if(to&&to!==current.from)moveRef.current(current.values,current.from,to);
    };
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape")stop();};
    // 待选区和目标区在窗口里是上下排的，一屏往往装不下两个列表。
    // 浏览器只会给原生 HTML5 拖放自动滚屏，指针拖拽得自己来：
    // 光标贴近视口上下边缘时，先滚光标所在的列表，滚不动了再滚页面。
    const pump=()=>{
      const current=dragRef.current;
      if(!current)return;
      const step=current.y<DRAG_EDGE?-DRAG_SCROLL_STEP:current.y>window.innerHeight-DRAG_EDGE?DRAG_SCROLL_STEP:0;
      if(!step)return;
      const element=document.elementFromPoint(current.x,current.y);
      const host=element instanceof Element?element.closest("[data-shuttle-zone]"):null;
      if(host instanceof HTMLElement){
        const before=host.scrollTop;
        host.scrollTop+=step;
        if(host.scrollTop!==before){track(current.x,current.y);return;}
      }
      window.scrollBy(0,step);
      track(current.x,current.y);
    };
    const timer=window.setInterval(pump,DRAG_SCROLL_TICK);
    window.addEventListener("pointermove",move);
    window.addEventListener("pointerup",drop);
    window.addEventListener("pointercancel",stop);
    window.addEventListener("keydown",key);
    return ()=>{
      window.clearInterval(timer);
      window.removeEventListener("pointermove",move);
      window.removeEventListener("pointerup",drop);
      window.removeEventListener("pointercancel",stop);
      window.removeEventListener("keydown",key);
    };
  },[dragging]);
  function moveAccounts(values:string[],from:ShuttleZone,to:ShuttleZone){
    const next=moveShuttleAccounts({targets:batch.accounts,excludes:draft.excludes},values,from,to);
    if(next.targets===batch.accounts&&next.excludes===draft.excludes)return;
    patch({
      batches:draft.batches.map((value,index)=>index===draft.activeBatch?{...value,accounts:next.targets}:value),
      excludes:next.excludes,
    });
    setSelectedAvailable([]);setSelectedTarget([]);setSelectedExclude([]);
    if(to==="exclude")setShowExcludes(true);
  }
  // 拖拽的 window 监听只在开始拖时注册一次，用 ref 拿到最新的 moveAccounts，
  // 免得落点用到的是上一次渲染的批次和剔除列表。
  moveRef.current=moveAccounts;
  const addBatch=()=>patch({batches:[...draft.batches,{name:`批次${draft.batches.length+1}`,accounts:[]}],activeBatch:draft.batches.length});
  const deleteBatch=()=>{if(draft.batches.length===1){updateBatch({accounts:[]});return;}const next=draft.batches.filter((_,index)=>index!==draft.activeBatch);patch({batches:next,activeBatch:Math.max(0,draft.activeBatch-1)});};
  async function chooseOutput(){const value=await pickPath("save","保存看账结果（可选 CSV 或 XLSX）",["csv","xlsx"],defaultKanzhangOutputName(draft.inputPath,draft.sheet));if(typeof value==="string")patch({outputPath:value,outputTouched:true});}
  // 恢复默认：回到"凭证文件旁 + 旧版默认命名"，时间戳按当前时间重算。
  function resetOutput(){autoOutputKey.current="";patch({outputTouched:false,outputPath:draft.inputPath?defaultKanzhangOutputPath(draft.inputPath,draft.sheet):""});}
  async function start(method:"kanzhang.filter"|"kanzhang.export"){const valid=validKanzhangBatches(draft.batches);if(!valid.length){setError("请至少为一个有效批次选择目标科目。若需分析全部科目，请在目标批次中全选科目。");patch({step:2});return;}setBusy(true);setError("");
    // 默认落点的时间戳按"开始导出"的时刻刷新，免得停留在选文件的时间。
    let target=draft.outputPath;
    if(method==="kanzhang.export"&&!draft.outputTouched&&draft.inputPath){
      target=defaultKanzhangOutputPath(draft.inputPath,draft.sheet);
      autoOutputKey.current=`${draft.inputPath}|${draft.sheet}`;
      patch({outputPath:target});
    }
    try{const jobId=await jobStart(method,{inputPath:draft.inputPath,sheet:draft.sheet||undefined,headerRow:draft.headerRow,mapping:draft.mapping,targetBatches:valid,excludeAccounts:draft.excludes,outputPath:target||undefined,
      // 套表和 LLM 分析在旧版里没有开关，一律生成；这里写死 true，
      // 顺带覆盖掉早期版本残留在 sessionStorage 草稿里的 false。
      includePivot:true,includeVoucherTypes:true,llmAnalysis:true,
      markLossTransfer:draft.markLossTransfer,enableJeMatching:draft.enableJeMatching,pivotRows:draft.pivotRows,pivotColumns:draft.pivotColumns,pivotValues:draft.pivotValues});setJob({jobId,toolId:"kanzhang",phase:"queued",current:0,total:1,message:"任务已进入队列",severity:"info",outputPaths:[]});}catch(e){setBusy(false);setError(kanzhangErrorText(e));}}
  const headers=draft.inspect?.headers??[];
  const scheme=activeAmountScheme(draft.mapping);
  const lockedHint=scheme==="B"?"不适用（已用方案B）":scheme==="A"?"不适用（已用方案A）":"未映射";
  const showReview=llmBusy||llmFailed||Boolean(llmStatus)||changes.length>0||pending.length>0;
  return <div className="kz-page">
    <PageHeader eyebrow="凭证映射与科目筛选" title={tool.name} detail="按旧版三步流程完成字段映射、科目穿梭、多批次、凭证类型、JE 匹配、损益结转与导出。" />
    <StepIndicator steps={[{key:"1",label:"加载与映射"},{key:"2",label:"科目筛选",disabled:!draft.inspect},{key:"3",label:"透视与导出",disabled:!draft.inspect}]} current={draft.step-1} onStepClick={(index)=>patch({step:index+1})} />
    {error&&<ErrorBox error={error} onDismiss={()=>setError("")} />}
    {draft.step===1&&<div className="fa-stack"><section className="kz-card"><h2>加载数据</h2><div className="kz-path"><FileDropInput value={draft.inputPath} placeholder="拖放或点击选择凭证文件" onBrowse={chooseInput} onClear={draft.inputPath?clearAll:undefined} onDragStateChange={()=>{}} highlight={dragHover}/></div><div className="kz-two"><label>Sheet<select value={draft.sheet} onChange={e=>setDraft(current=>invalidateKanzhangInspection(current,{sheet:e.target.value}))}><option value="">自动/首个 Sheet</option>{draft.knownSheets.map(value=><option key={value}>{value}</option>)}</select></label><label>标题行<input type="number" min={1} value={draft.headerRow} onChange={e=>setDraft(current=>invalidateKanzhangInspection(current,{headerRow:Number(e.target.value)||1}))}/></label></div>{!draft.inspect&&draft.knownSheets.length>0&&<p>Sheet 或标题行已变化，请重新读取以刷新预览和映射。</p>}<div className="kz-actions"><Button variant="default" disabled={busy} onClick={inspect}>读取并自动映射</Button>{busy&&job&&<Button variant="secondary" size="sm" onClick={()=>void jobCancel(job.jobId)}>停止</Button>}</div>
      {/* 读取几十万行凭证要几十秒，原来这一步只有按钮变灰，用户不知道是在跑还是卡死了。 */}
      {busy&&job&&<JobProgress job={job} onCancel={(jobId)=>void jobCancel(jobId)} cancelLabel="取消任务"/>}
      {draft.inspect&&<>
        {showReview&&<div className={`fa-llm-review ${llmFailed||pending.length?"warning":""}`}>
          <div className="section-title"><h3>LLM 映射复核</h3><span className={`pill ${llmBusy?"preview":llmFailed||pending.length?"warning":"ready"}`}>{llmBusy?"复核中":llmFailed?"失败（不阻塞）":pending.length?"需人工确认":"已完成"}</span></div>
          <p>{llmBusy?"正在复核字段映射；复核期间字段映射暂时锁定，避免你改到一半又被结果覆盖。":llmStatus}</p>
          {llmBusy&&<div className="actions compact"><Button variant="secondary" size="sm" onClick={skipReview}>跳过复核并继续</Button></div>}
          {changes.map((item,index)=><div className={`fa-review-item fa-change${needsAttention(item)?" attention":""}`} key={`${item.source}-${item.role}-${index}`}>
            <strong>{KZ_ROLE_LABELS[item.role]}<em>{MAPPING_CHANGE_LABEL[item.source]}</em></strong>
            <span className="fa-change-diff">{formatMappingValue(item.before)} → {formatMappingValue(item.after)}</span>
            {!!item.reason&&<span>{item.reason}{item.confidence?`（把握 ${Math.round(item.confidence*100)}%）`:""}</span>}
            <div className="actions compact"><Button variant="secondary" size="sm" disabled={llmBusy} onClick={()=>undoChange(item)}>撤销</Button></div>
          </div>)}
          {pending.map(item=><div className="fa-review-item fa-pending" key={`pending-${item.role}-${item.suggestedColumn}`}>
            <strong>{KZ_ROLE_LABELS[item.role]}<em>把握不足，未改动</em></strong>
            <span className="fa-change-diff">{formatMappingValue(draft.mapping[item.role])} → {item.suggestedColumn}</span>
            {!!item.reason&&<span>{item.reason}{item.confidence?`（把握 ${Math.round(item.confidence*100)}%）`:""}</span>}
            <div className="actions compact"><Button variant="secondary" size="sm" disabled={llmBusy} onClick={()=>acceptPending(item)}>采纳</Button><Button variant="secondary" size="sm" disabled={llmBusy} onClick={()=>setPending(values=>values.filter(value=>value!==item))}>保留当前</Button></div>
          </div>)}
        </div>}
        {scheme&&<p className="kz-hint">金额口径已按方案{scheme}成立，方案{scheme==="A"?"B":"A"}的字段已停用；如需切换，先清空当前方案的字段。</p>}
        <div className="kz-actions"><Button variant="secondary" size="sm" disabled={busy||llmBusy} onClick={()=>void reviewMapping()}>{llmBusy?"LLM 正在复核…":"重新进行 LLM 复核"}</Button><Button variant="default" disabled={llmBusy} onClick={()=>patch({step:2})}>下一步：科目筛选</Button></div>
      </>}
    </section><Preview inspect={draft.inspect} mapping={draft.mapping} setMap={setMap} llmBusy={llmBusy}/></div>}
    {draft.step===2&&<div className="kz-grid kz-filter-grid"><section className="kz-card"><h2>目标批次</h2><div className="kz-row"><Button variant="secondary" size="sm" onClick={addBatch}>新增批次</Button><Button variant="secondary" size="sm" onClick={deleteBatch}>删除批次</Button></div><div className="kz-tabs">{draft.batches.map((value,index)=><button className={index===draft.activeBatch?"active":""} onClick={()=>patch({activeBatch:index})} key={`${value.name}-${index}`}>{value.name} ({value.accounts.length})</button>)}</div><label>批次名称<input value={batch.name} onChange={e=>updateBatch({name:e.target.value})}/></label>
      <div className="kz-search"><input value={query} placeholder="输入关键词即时过滤科目" onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&truncated)void searchAccounts();}}/>{truncated&&<Button variant="secondary" size="sm" onClick={searchAccounts}>到全库检索</Button>}<Button variant="secondary" size="sm" onClick={()=>{setQuery("");setSearchResults([]);}}>清除</Button></div>
      <div className="kz-source-panel"><h3>待选科目 ({available.length}{truncated?` / 共 ${accountTotal}`:""})</h3>{accountsBusy&&<p className="kz-hint">正在载入全部科目…</p>}{truncated&&<p className="kz-hint">科目过多，仅载入前 {accounts.length} 个；未命中时回车或点"到全库检索"。</p>}
        <ShuttleList zone="source" values={available} selected={selectedAvailable} onSelect={setSelectedAvailable} onDragBegin={beginDrag} drag={drag} emptyText="没有匹配的科目。"/>
        <small>单击选中、Ctrl 加选、Shift 连选、Ctrl+A 全选；选好后直接拖到右侧任一列表，或用下面的按钮。</small>
        <div className="kz-source-actions"><Button variant="secondary" size="sm" disabled={!available.length} onClick={()=>setSelectedAvailable(available)}>全选当前结果</Button><Button variant="secondary" size="sm" disabled={!selectedAvailable.length} onClick={()=>setSelectedAvailable([])}>清除选择</Button><Button variant="default" disabled={!selectedAvailable.length} onClick={()=>moveAccounts(selectedAvailable,"source","target")}>加入目标批次</Button><Button variant="secondary" size="sm" disabled={!selectedAvailable.length} onClick={()=>moveAccounts(selectedAvailable,"source","exclude")}>加入剔除/例外</Button></div></div>
      <div className="kz-assigned-grid">
        <div><div className="kz-row"><h3>目标匹配（智能对冲） ({batch.accounts.length})</h3><Button variant="secondary" size="sm" disabled={!selectedTarget.length} onClick={()=>moveAccounts(selectedTarget,"target","source")}>移回待选</Button></div>
          <ShuttleList zone="target" values={batch.accounts} selected={selectedTarget} onSelect={setSelectedTarget} onDragBegin={beginDrag} drag={drag} emptyText="把待选科目拖进来。"/></div>
        <div><div className="kz-row"><h3>剔除/例外（独立导出） ({draft.excludes.length})</h3><Button variant="secondary" size="sm" disabled={!selectedExclude.length||!showExcludes} onClick={()=>moveAccounts(selectedExclude,"exclude","source")}>移回待选</Button><Button variant="secondary" size="sm" onClick={()=>setShowExcludes(value=>!value)}>{showExcludes?"折叠":"展开"}</Button></div>{showExcludes?<ShuttleList zone="exclude" values={draft.excludes} selected={selectedExclude} onSelect={setSelectedExclude} onDragBegin={beginDrag} drag={drag} emptyText="把不参与分析的科目拖进来。"/>:<p className="kz-hint">已选剔除项会保留，展开后可编辑或拖拽。</p>}</div>
      </div><p className="kz-note"><b>目标匹配</b>：命中该科目的整张凭证进入分析，并参与智能对冲。<b>剔除/例外</b>：不作为目标科目，单独输出例外明细供复核。</p><div className="kz-actions"><Button variant="secondary" size="sm" onClick={()=>patch({step:1})}>返回映射</Button><Button variant="secondary" size="sm" disabled={busy} onClick={()=>void start("kanzhang.filter")}>筛选预览</Button><Button variant="default" onClick={()=>patch({step:3})}>下一步：透视与导出</Button></div></section><Result job={job} result={result}/></div>}
    {draft.step===3&&<><div className="kz-export-grid"><section className="kz-card"><h2>透视设计</h2><div className="kz-two"><label>行字段（Ctrl 可多选）<select multiple value={draft.pivotRows} onChange={e=>patch({pivotRows:[...e.target.selectedOptions].map(option=>option.value)})}>{headers.map(value=><option key={value}>{value}</option>)}</select></label><label>列字段（日期自动转月份）<select multiple value={draft.pivotColumns} onChange={e=>patch({pivotColumns:[...e.target.selectedOptions].map(option=>option.value)})}>{headers.map(value=><option key={value}>{value}</option>)}</select></label><label>值字段（留空=净额，可多选）<select multiple value={draft.pivotValues} onChange={e=>patch({pivotValues:[...e.target.selectedOptions].map(option=>option.value)})}><option value={NET_VALUE_FIELD}>净额（{NET_VALUE_FIELD}）</option>{headers.map(value=><option key={value}>{value}</option>)}</select><small>净额按当前金额方案算出，不在源表列里；与原始金额列可以同时选，各占一列。</small></label></div></section><section className="kz-card"><h2>导出设置</h2>
      {/*
        旧版这里只有两个开关：启用正负数智能标记、标记损益结转凭证。
        套表（凭证/透视/凭证类型）和 LLM 分析都是无条件生成的，
        迁移版多出来的三个勾选项既不是旧行为，也只会让人犹豫该不该勾。
      */}
      <div className="kz-options"><Check label="启用正负数智能标记" value={draft.enableJeMatching} onChange={value=>patch({enableJeMatching:value})}/><Check label="标记损益结转凭证" value={draft.markLossTransfer} onChange={value=>patch({markLossTransfer:value})}/></div><label>输出文件<div className="kz-path"><input readOnly value={draft.outputPath} title={draft.outputPath} placeholder="选择凭证文件后自动填入默认保存位置"/><Button variant="secondary" size="sm" onClick={chooseOutput}>选择</Button>{draft.outputTouched&&<Button variant="secondary" size="sm" onClick={resetOutput}>恢复默认</Button>}</div></label><p className="kz-hint">{draft.outputTouched?"已指定保存位置，导出会以这个文件名为基准。":"默认保存到凭证文件所在目录，文件名为「看账导出_源文件名[_工作表]_<时间戳>.csv」（导出时按当前时间生成）。"}与旧版一致的两阶段导出：明细单独一个文件（选 .csv 出 CSV，选 .xlsx 出工作簿），凭证/透视/凭证类型另出一个「_套表.xlsx」；有剔除科目时再多一个剔除明细。</p><div className="kz-actions"><Button variant="secondary" size="sm" onClick={()=>patch({step:2})}>返回筛选</Button>{busy&&job?<Button variant="secondary" size="sm" onClick={()=>jobCancel(job.jobId)}>停止</Button>:<Button variant="default" onClick={()=>void start("kanzhang.export")}>导出结果</Button>}</div></section></div><Result job={job} result={result}/></>}
    {drag&&<div className="kz-drag-ghost" style={{left:drag.x,top:drag.y}}>{drag.values.length===1?drag.values[0]:`${drag.values.length} 个科目`}</div>}
  </div>;
}

// 可拖拽的科目列表。原生 <select multiple> 的 <option> 不能作为拖放目标，
// 所以三个区统一用 div 渲染，自己实现单击 / Ctrl 加选 / Shift 连选 / Ctrl+A。
//
// 拖拽走的是 Pointer Events，不是 HTML5 的 draggable/drop。Tauri 在 Windows 上
// 默认开着窗口级的文件拖放（dragDropEnabled），WebView2 会把页面内的 dragover/drop
// 整个吞掉——条目拖得动、但永远落不下去，正是"不支持拖拽"的现象。关掉那个开关又会
// 让别的页面"拖文件进窗口"失效（它要的是本地绝对路径，HTML5 的 File 给不了），
// 所以这里改用指针事件自己实现，两边都不牺牲。
const SHUTTLE_LIMIT=2000;
const DRAG_THRESHOLD=5;
// 拖到离视口上下边缘多近开始自动滚屏，以及每帧滚多少像素。
const DRAG_EDGE=56;
const DRAG_SCROLL_STEP=14;
const DRAG_SCROLL_TICK=16;
export type ShuttleDrag={from:ShuttleZone;values:string[];x:number;y:number;over:ShuttleZone|null};

// data-shuttle-zone 是页面上的字符串，落点判断前先确认它确实是三个区之一。
export const asShuttleZone=(value?:string|null):ShuttleZone|null=>
  value==="source"||value==="target"||value==="exclude"?value:null;

/// 光标位置落在哪个穿梭区上。
function shuttleZoneAt(x:number,y:number):ShuttleZone|null{
  const element=document.elementFromPoint(x,y);
  const host=element instanceof Element?element.closest("[data-shuttle-zone]"):null;
  return asShuttleZone(host instanceof HTMLElement?host.dataset.shuttleZone:null);
}

function ShuttleList({zone,values,selected,onSelect,onDragBegin,drag,emptyText}:{
  zone:ShuttleZone;values:string[];selected:string[];
  onSelect:(values:string[])=>void;
  onDragBegin:(from:ShuttleZone,values:string[],x:number,y:number)=>void;
  drag?:ShuttleDrag;
  emptyText:string;
}){
  const anchor=useRef(-1);
  const dragged=useRef(false);
  const shown=useMemo(()=>values.slice(0,SHUTTLE_LIMIT),[values]);
  const selectedSet=useMemo(()=>new Set(selected),[selected]);
  const over=!!drag&&drag.over===zone&&drag.from!==zone;
  function click(event:React.MouseEvent,index:number){
    // 刚刚是一次拖拽而不是点击，不要把选择重置掉。
    if(dragged.current){dragged.current=false;return;}
    const value=shown[index];
    if(event.shiftKey&&anchor.current>=0){
      const from=Math.min(anchor.current,index);const to=Math.max(anchor.current,index);
      onSelect([...new Set([...selected,...shown.slice(from,to+1)])]);
      return;
    }
    anchor.current=index;
    if(event.ctrlKey||event.metaKey){onSelect(selectedSet.has(value)?selected.filter(item=>item!==value):[...selected,value]);return;}
    onSelect([value]);
  }
  // 按下后把"是否算拖拽"的判定挂到 window 上：只监听条目自己的 pointermove 的话，
  // 光标一下子甩出条目边界就再也收不到事件，快速拖动会整个失效。
  function pointerDown(event:React.PointerEvent,index:number){
    if(event.button!==0)return;
    dragged.current=false;
    const startX=event.clientX;const startY=event.clientY;
    const value=shown[index];
    const cleanup=()=>{
      window.removeEventListener("pointermove",move);
      window.removeEventListener("pointerup",cleanup);
      window.removeEventListener("pointercancel",cleanup);
    };
    function move(moveEvent:PointerEvent){
      if(Math.abs(moveEvent.clientX-startX)+Math.abs(moveEvent.clientY-startY)<DRAG_THRESHOLD)return;
      cleanup();
      dragged.current=true;
      // 拖一个未选中的条目时按"只拖它"处理，符合资源管理器的直觉。
      const payload=selectedSet.has(value)?selected:[value];
      if(!selectedSet.has(value))onSelect(payload);
      onDragBegin(zone,payload,moveEvent.clientX,moveEvent.clientY);
    }
    window.addEventListener("pointermove",move);
    window.addEventListener("pointerup",cleanup);
    window.addEventListener("pointercancel",cleanup);
  }
  return <div
    className={`kz-shuttle-list${over?" drop-active":""}`}
    data-shuttle-zone={zone}
    tabIndex={0}
    onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="a"){event.preventDefault();onSelect(shown);}}}
  >
    {!shown.length&&<div className="kz-shuttle-empty">{emptyText}</div>}
    {shown.map((value,index)=><div
      key={value}
      className={`kz-shuttle-item${selectedSet.has(value)?" selected":""}`}
      onPointerDown={event=>pointerDown(event,index)}
      onClick={event=>click(event,index)}
    >{value}</div>)}
    {values.length>shown.length&&<div className="kz-shuttle-more">另有 {values.length-shown.length} 个未显示，请用搜索缩小范围。</div>}
  </div>;
}
function Check({label,value,onChange}:{label:string;value:boolean;onChange:(value:boolean)=>void}){return <label><input type="checkbox" checked={value} onChange={e=>onChange(e.target.checked)}/>{label}</label>}
function Preview({inspect,mapping,setMap,llmBusy}:{inspect?:Inspect;mapping?:Mapping;setMap?:(key:keyof Mapping,value:string|string[])=>void;llmBusy?:boolean}){if(!inspect)return <section className="kz-card kz-preview"><h2>文件预览</h2><p>读取后显示前 50 行。</p></section>;const roles:([keyof Mapping,string,boolean])[]=[["id","凭证编号",true],["account","科目名称",true],["entity","公司/主体",false],["date","日期",false],["summary","摘要",false],["amount","方案A-金额",false],["direction","方案A-方向",false],["debit","方案B-借方",false],["credit","方案B-贷方",false]];const usedRoles=new Set<string>();if(mapping)for(const [key] of roles){const v=mapping[key];const occ=Array.isArray(v)?v.length>0:Boolean(v&&v.trim());if(occ)usedRoles.add(key);}const controls=mapping&&setMap?inspect.headers.map(header=>{const col=header.trim();const mappedRole=roles.find(([key])=>{const v=mapping[key];if(Array.isArray(v))return v.includes(col);return String(v??"")===col;});const locked=mappedRole?isSchemeLockedRole(mapping,mappedRole[0]):false;return <label className="dt-header-control" key={header}><select className={mappedRole&&!locked?"mapped":undefined} disabled={llmBusy||locked} value={mappedRole?mappedRole[0]:""} onChange={e=>{const role=e.target.value as keyof Mapping;for(const [k] of roles){const v=mapping[k];if(Array.isArray(v)&&v.includes(col))setMap(k,v.filter(x=>x!==col));else if(String(v??"")===col)setMap(k,"");}if(role){if(role==="id"||role==="account"){const cur=mapping[role]??[];if(!cur.includes(col))setMap(role,[...cur,col]);}else setMap(role,col);}}}><option value="">—</option>{roles.map(([key,label])=>{const taken=usedRoles.has(key)&&key!==mappedRole?.[0];const roleLocked=isSchemeLockedRole(mapping,key);return <option key={key} value={key} className={taken||roleLocked?"dt-role-taken":undefined}>{label}{taken?"（已用）":roleLocked?"（已停用）":""}</option>;})}</select></label>;}):undefined;return <section className="kz-card kz-preview"><h2>文件预览</h2><p>{inspect.dimensions?.rows??0} 行 × {inspect.dimensions?.columns??0} 列</p><DataTable columns={inspect.headers} rows={inspect.preview} headerControls={controls} maxHeight={380}/></section>;}
function Result({job,result}:{job?:JobEvent;result?:unknown}){const object=result&&typeof result==="object"?result as Record<string,unknown>:undefined;const paths=[...new Set([...(job?.outputPaths??[]),...(Array.isArray(object?.outputPaths)?object.outputPaths.filter((value):value is string=>typeof value==="string"):[])])];const batches=Array.isArray(object?.batches)?object.batches as Record<string,unknown>[]:[];const rows=typeof object?.rows==="number"?object.rows:undefined;const showProgress=shouldShowKanzhangJobProgress(job?.phase);return <Card className="kz-result"><CardHeader><CardTitle>预览与结果</CardTitle></CardHeader><CardContent>{job&&showProgress&&<JobProgress job={job} onCancel={(jobId)=>void jobCancel(jobId)} cancelLabel="取消任务"/>}{rows!==undefined&&<p>筛选后共 <b>{rows}</b> 行，可继续调整科目或进入导出。</p>}{paths.length>0&&<div className="kz-outputs">{paths.map(path=><Button key={path} variant="secondary" size="sm" title={path} onClick={()=>void openOutput(path)}><span>打开：</span><span>{path.split(/[\\/]/).pop()}</span></Button>)}</div>}{batches.length>0&&<div className="kz-summary">{batches.map((batch,index)=><div key={index}><b>{String(batch.name??`批次${index+1}`)}</b><span>明细 {String(batch.rows??0)} 行</span><span>损益结转 {String(batch.lossTransferVouchers??0)} 笔</span><span>JE 直接/跨行 {String(batch.jeMatchedPairs??0)} / {String(batch.jeCrossMatchedPairs??0)} 对</span></div>)}</div>}{!result&&!showProgress&&<p>执行筛选或导出后显示结果。</p>}</CardContent></Card>}
