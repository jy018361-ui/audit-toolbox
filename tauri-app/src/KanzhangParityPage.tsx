import { useEffect, useMemo, useRef, useState } from "react";
import { engineCall, jobCancel, jobStart, listenJobEvents, openOutput, pickPath } from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./kanzhang-parity.css";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StepIndicator } from "@/components/StepIndicator";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { LedgerSourceCard } from "@/components/LedgerSourceCard";
import { LedgerLlmReview } from "@/components/LedgerLlmReview";
import { LedgerMappingPreview } from "@/components/LedgerMappingPreview";
import {
  accountColumns,
  activeAmountScheme,
  applyLedgerReviews,
  EMPTY_MAPPING,
  formatMappingValue,
  isMultiRole,
  isRedundantKanzhangReview,
  isSchemeLockedRole,
  kanzhangReviewSummary,
  ledgerErrorText,
  mergeMappingChanges,
  missingKanzhangRequiredRoles,
  setKanzhangMapping,
  shouldAutoApply,
  shouldShowKanzhangJobProgress,
  undoMappingChange,
  type Inspect,
  type LedgerReviewResponse,
  type Mapping,
  type MappingChange,
  type Review,
} from "./ledgerMapping";

// 字段映射相关的判定全部落在 ledgerMapping，正负数凭证标记与本页共用同一套口径。
// 这里继续导出是为了不打断既有引用方（含 KanzhangParityPage.test.ts）。
export {
  accountColumns,
  activeAmountScheme,
  applyLedgerReviews,
  AUTO_APPLY_MIN,
  effectiveVoucherKey,
  formatMappingValue,
  isMultiRole,
  isRedundantKanzhangReview,
  isSameMappingValue,
  isSchemeLockedRole,
  kanzhangReviewSummary,
  KZ_ROLE_LABELS,
  LEDGER_ROLES,
  LOW_CONFIDENCE,
  MAPPING_CHANGE_LABEL,
  mergeMappingChanges,
  normalizeLedgerRole,
  missingKanzhangRequiredRoles,
  needsAttention,
  setKanzhangMapping,
  shouldAutoApply,
  shouldShowKanzhangJobProgress,
  undoMappingChange,
} from "./ledgerMapping";
export type { Mapping, MappingChange, MappingChangeSource } from "./ledgerMapping";

export type Batch = { name: string; accounts: string[]; presetId?: string };
export type KanzhangDraft = { inputPath: string; sheet: string; knownSheets:string[]; headerRow: number; inspect?: Inspect; mapping: Mapping; batches: Batch[]; activeBatch: number; excludes: string[]; outputPath: string; outputTouched: boolean; includePivot: boolean; includeVoucherTypes: boolean; markLossTransfer: boolean; llmAnalysis:boolean; pivotRows: string[]; pivotColumns: string[]; pivotValues: string[]; step: number };
const EMPTY: KanzhangDraft = { inputPath:"",sheet:"",knownSheets:[],headerRow:1,mapping:EMPTY_MAPPING,batches:[{name:"批次1",accounts:[]}],activeBatch:0,excludes:[],outputPath:"",outputTouched:false,includePivot:true,includeVoucherTypes:true,markLossTransfer:true,llmAnalysis:true,pivotRows:[],pivotColumns:[],pivotValues:[],step:1 };
const CACHE="audit-toolbox.kanzhang.draft.v4";
const loadDraft=():KanzhangDraft=>{try{return {...EMPTY,...JSON.parse(sessionStorage.getItem(CACHE)||"{}")};}catch{return EMPTY;}};
export const kanzhangErrorText=ledgerErrorText;
export const validKanzhangBatches=(batches:Batch[])=>batches.filter(value=>value.name.trim()&&value.accounts.length);
export const invalidateKanzhangInspection=(current:KanzhangDraft,change:Partial<Pick<KanzhangDraft,"sheet"|"headerRow">>):KanzhangDraft=>({...current,...change,inspect:undefined,mapping:EMPTY_MAPPING,step:1});
// 科目检索按旧版口径：在已载入的科目列表上即时过滤，不需要点"搜索"。
export const filterAccounts=(values:string[],keyword:string):string[]=>{
  const kw=keyword.trim().toLowerCase();
  return kw?values.filter(value=>value.toLowerCase().includes(kw)):values;
};
// 用户输入的前缀串切成多个前缀，与 Rust 侧 `parse_code_prefixes` 同口径。
export const parseCodePrefixes=(raw:string):string[]=>
  raw.split(/[,，;；、\s]+/).map(value=>value.trim()).filter(Boolean);
// 按**科目编码段**做前缀匹配，不是拿整个拼接串模糊匹配——否则输入 6401
// 会把科目名称里恰好含 6401 的科目也拉进来。没有编码时退回比对显示值开头。
export function filterByCodePrefix(values:string[],codes:string[],prefixes:string[]):string[]{
  if(!prefixes.length)return values;
  const lower=prefixes.map(value=>value.toLowerCase());
  return values.filter((value,index)=>{
    const code=(codes[index]??"").trim();
    const target=(code||value).toLowerCase();
    return lower.some(prefix=>target.startsWith(prefix));
  });
}

// 与 TB 科目余额表调整的“名称词典优先、标准科目编码兜底”保持同一口径。
// 编码永远只读独立的科目编码列，不能在显示名称中猜数字，以免误把摘要式名称选进来。
export type AuditFocusPresetId="fixed_assets"|"intangible_assets"|"long_term_prepaid"|"administrative_expense"|"selling_expense"|"financial_expense"|"accounts_payable"|"short_term_loans";
type AuditFocusPreset={id:AuditFocusPresetId;name:string;pattern:RegExp;codePrefixes:string[]};
const CASH_PRESET_RULE={pattern:/货币资金|银行存款|库存现金|其他货币资金|存放中央银行|存放同业|\bcash\b|\bbank\b|\bbnk\b|\bboc\b|\bboa\b|\bhsbc\b|\bcmb\b|petty\s+cash/i,codePrefixes:["1001","1002","1003","1011","1012"]};
export const AUDIT_FOCUS_PRESETS:AuditFocusPreset[]=[
  {id:"fixed_assets",name:"预设｜固定资产",pattern:/固定资产|property\s*,?\s*plant|fixed\s*asset/i,codePrefixes:["1601","1602","1603","1604","1605"]},
  {id:"intangible_assets",name:"预设｜无形资产",pattern:/无形资产|intangible|accum\s*amort/i,codePrefixes:["1701","1702"]},
  {id:"long_term_prepaid",name:"预设｜长期待摊费用",pattern:/长期待摊|long[ -]?term\s+prepaid|prepaid\s+expense/i,codePrefixes:["1801"]},
  {id:"administrative_expense",name:"预设｜管理费用",pattern:/管理费用|administrative\s+expense|operating\s+expense/i,codePrefixes:["6602"]},
  {id:"selling_expense",name:"预设｜销售费用",pattern:/销售费用|selling\s+expense/i,codePrefixes:["6601"]},
  {id:"financial_expense",name:"预设｜财务费用",pattern:/财务费用|finance\s+expense|interest\s+expense/i,codePrefixes:["6603"]},
  {id:"accounts_payable",name:"预设｜应付账款",pattern:/应付账款|accounts?\s+payable|accts?\s+pay|\ba\/p\b|ap[ -]?trade/i,codePrefixes:["2202"]},
  {id:"short_term_loans",name:"预设｜短期借款",pattern:/短期借款|short[ -]?term\s+(loan|borrow)|short\s+borrowing/i,codePrefixes:["2001"]},
];
export type PresetMatch={preset:AuditFocusPreset;accounts:string[]};
export type PresetApplySummary={matches:PresetMatch[];skippedExcludes:string[];created:number;updated:number};
export const matchAuditFocusPresets=(values:string[],codes:string[]):PresetMatch[]=>AUDIT_FOCUS_PRESETS.map(preset=>({preset,accounts:values.filter((value,index)=>preset.pattern.test(value)||preset.codePrefixes.some(prefix=>(codes[index]??"").trim().startsWith(prefix)))}));
export function applyAuditFocusPresetBatches(batches:Batch[],values:string[],codes:string[],excludes:string[]):{batches:Batch[];summary:PresetApplySummary}{
  const excluded=new Set(excludes);
  const matches=matchAuditFocusPresets(values,codes);
  const skippedExcludes=[...new Set(matches.flatMap(match=>match.accounts.filter(account=>excluded.has(account))) )];
  let created=0;let updated=0;
  // 两种自动口径互斥；历史版本可能已留下 cash 预设，也在这里迁移掉。手工批次不动。
  const next=batches.filter(batch=>batch.presetId!=="cash"&&!batch.presetId?.startsWith("all_primary:"));
  for(const match of matches){
    const accounts=[...new Set(match.accounts.filter(account=>!excluded.has(account)))];
    const index=next.findIndex(batch=>batch.presetId===match.preset.id);
    if(index<0){next.push({name:match.preset.name,presetId:match.preset.id,accounts});created+=1;}
    else {next[index]={...next[index],name:match.preset.name,accounts};updated+=1;}
  }
  return {batches:next,summary:{matches,skippedExcludes,created,updated}};
}
export type PrimaryPresetSummary={groups:{name:string;accounts:string[]}[];skippedCash:string[];skippedExcludes:string[];created:number;updated:number;removed:number};
const primaryCode=(code:string)=>{const digits=code.trim().match(/^\d{4}/)?.[0];return digits??"";};
const primaryLabel=(value:string,code:string,primaryName:string)=>{
  const preferred=primaryName.trim();
  if(preferred)return preferred.split(/[-—–>／/|]/)[0].trim()||preferred;
  let display=value.trim();const exactCode=code.trim();
  if(exactCode&&display.startsWith(exactCode))display=display.slice(exactCode.length).replace(/^[-—–>／/|\s]+/,"");
  return display.split(/[-—–>／/|]/)[0].trim()||primaryCode(code)||"未命名科目";
};
export function applyAllPrimaryAccountBatches(batches:Batch[],values:string[],codes:string[],primaryNames:string[],excludes:string[]):{batches:Batch[];summary:PrimaryPresetSummary}{
  const excluded=new Set(excludes);const groups=new Map<string,{name:string;accounts:string[]}>();const skippedCash:string[]=[];const skippedExcludes:string[]=[];
  values.forEach((value,index)=>{
    const code=(codes[index]??"").trim();const name=primaryNames[index]??"";
    const cash=CASH_PRESET_RULE.pattern.test(`${name} ${value}`)||CASH_PRESET_RULE.codePrefixes.some(prefix=>code.startsWith(prefix));
    if(cash){skippedCash.push(value);return;}if(excluded.has(value)){skippedExcludes.push(value);return;}
    const label=primaryLabel(value,code,name);const key=name.trim()?label.toLowerCase():primaryCode(code)||label.toLowerCase();
    const current=groups.get(key)??{name:`全科目｜${label}`,accounts:[]};current.accounts.push(value);groups.set(key,current);
  });
  const auditIds=new Set<string>(AUDIT_FOCUS_PRESETS.map(preset=>preset.id));
  const managed=batches.filter(batch=>!batch.presetId||(!batch.presetId.startsWith("all_primary:")&&!auditIds.has(batch.presetId)&&batch.presetId!=="cash"));const previous=new Map(batches.filter(batch=>batch.presetId?.startsWith("all_primary:")).map(batch=>[batch.presetId,batch]));
  let created=0;let updated=0;const generated=[...groups.entries()].sort(([a],[b])=>a.localeCompare(b,"zh-Hans-CN")).map(([key,group])=>{const presetId=`all_primary:${key}`;if(previous.has(presetId))updated+=1;else created+=1;return{name:group.name,accounts:[...new Set(group.accounts)],presetId};});
  return {batches:[...managed,...generated],summary:{groups:generated,skippedCash:[...new Set(skippedCash)],skippedExcludes:[...new Set(skippedExcludes)],created,updated,removed:Math.max(0,previous.size-updated)}};
}
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
  // 科目编码与 accounts 同序一一对应，供按编码段做前缀匹配。
  const [accountCodes,setAccountCodes]=useState<string[]>(draft.inspect?.accountCodes??[]);
  const [codePrefix,setCodePrefix]=useState("");
  const [changes,setChanges]=useState<MappingChange[]>([]);const [pending,setPending]=useState<Review[]>([]);const [llmStatus,setLlmStatus]=useState("");
  const [llmBusy,setLlmBusy]=useState(false);const [llmFailed,setLlmFailed]=useState(false);const llmGeneration=useRef(0);
  const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const [job,setJob]=useState<JobEvent>(); const [result,setResult]=useState<unknown>();
  const [presetSummary,setPresetSummary]=useState<PresetApplySummary>();
  const [primaryPresetSummary,setPrimaryPresetSummary]=useState<PrimaryPresetSummary>();
  const patch=(value:Partial<KanzhangDraft>)=>setDraft(current=>({...current,...value}));
  const clearAll=()=>{llmGeneration.current+=1;setDraft({...EMPTY,batches:[{name:"批次1",accounts:[]}]});setAccounts([]);setAccountCodes([]);setCodePrefix("");setAccountTotal(0);setAccountsKey("");setSearchResults([]);setSelectedAvailable([]);setQuery("");setResult(undefined);setPresetSummary(undefined);setPrimaryPresetSummary(undefined);setChanges([]);setPending([]);setLlmStatus("");setLlmBusy(false);setLlmFailed(false);};
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
    // 先按科目编码前缀圈定范围（6401,6603 选出这两段下的全部明细），再按关键词过滤。
    const prefixes=parseCodePrefixes(codePrefix);
    const scoped=filterByCodePrefix(accounts,accountCodes,prefixes);
    const kw=query.trim();
    if(!kw)return scoped;
    const local=filterAccounts(scoped,kw);
    if(!searchResults.length)return local;
    return [...new Set([...local,...filterAccounts(searchResults,kw)])].sort((a,b)=>a.localeCompare(b,"zh-Hans-CN"));
  },[accounts,accountCodes,codePrefix,query,searchResults]);
  const available=useMemo(()=>pool.filter(value=>!batch.accounts.includes(value)&&!draft.excludes.includes(value)),[pool,batch.accounts,draft.excludes]);
  const truncated=accountTotal>accounts.length;
  const setMap=(key:keyof Mapping,value:string|string[])=>patch({mapping:setKanzhangMapping(draft.mapping,key,value)});
  async function chooseInput(){const value=await pickPath("file","选择凭证文件",["xlsx","xls","xlsm","csv","txt","parquet"]);if(typeof value==="string")patch({inputPath:value,inspect:undefined,knownSheets:[],sheet:"",step:1});}
  async function inspect(){if(!draft.inputPath){setError("请选择凭证文件。");return;}setBusy(true);setError("");try{await jobStart("kanzhang.inspect",{inputPath:draft.inputPath,sheet:draft.sheet||undefined,headerRow:draft.headerRow});return;}catch(e){setError(kanzhangErrorText(e));setBusy(false);}}
  // 读取任务回来后套用表结构；改走任务通道是为了让大凭证文件的读取能报进度、能取消。
  // 透视默认只按科目名称分行——旧版就是这个口径。之前把公司也塞进行字段，
  // 同一科目被拆成每家公司一行，210 行的透视表膨胀到 665 行，跟旧版对不上。
  function applyInspect(value:Inspect){const suggested=value.suggestedMapping??EMPTY.mapping;setAccounts(value.accounts??[]);setAccountCodes(value.accountCodes??[]);setCodePrefix("");setAccountTotal(value.accountCount??(value.accounts??[]).length);setAccountsKey("");setSearchResults([]);setSelectedAvailable([]);setSelectedTarget([]);setSelectedExclude([]);setQuery("");patch({inspect:value,knownSheets:value.sheets??draft.knownSheets,sheet:value.selectedSheet??draft.sheet,mapping:suggested,pivotRows:accountColumns(suggested),pivotColumns:suggested.date?[suggested.date]:[],step:1});setResult(undefined);
    // 脚本自动映射一出来就直接送 LLM 复核，不再要求用户额外点一次按钮。
    void reviewMapping(suggested,value);}
  // 进入科目筛选时按用户最终确认的科目映射重载全量科目；inspect 阶段那份是按自动映射截断的。
  const accountMappingKey=accountColumns(draft.mapping).join("|");
  useEffect(()=>{
    if(draft.step!==2||!draft.inspect||!accountMappingKey||accountsKey===accountMappingKey||accountsBusy)return;
    void loadAccounts(accountMappingKey);
  },[draft.step,draft.inspect,accountMappingKey,accountsKey,accountsBusy]);
  async function loadAccounts(key:string){
    setAccountsBusy(true);
    try{
      const value=await engineCall("kanzhang.accounts",{inputPath:draft.inputPath,sheet:draft.sheet||undefined,headerRow:draft.headerRow,mapping:draft.mapping,keyword:"",limit:20000}) as {values:string[];codes?:string[];total?:number};
      setAccounts(value.values);setAccountCodes(value.codes??[]);setAccountTotal(value.total??value.values.length);setAccountsKey(key);setSearchResults([]);setSelectedAvailable([]);
    }catch(e){setError(kanzhangErrorText(e));setAccountsKey(key);}
    finally{setAccountsBusy(false);}
  }
  async function searchAccounts(){try{const value=await engineCall("kanzhang.accounts",{inputPath:draft.inputPath,sheet:draft.sheet||undefined,headerRow:draft.headerRow,mapping:draft.mapping,keyword:query,codePrefixes:codePrefix,limit:20000}) as {values:string[]};setSearchResults(value.values);setSelectedAvailable([]);}catch(e){setError(kanzhangErrorText(e));}}
  function skipReview(){llmGeneration.current+=1;setLlmBusy(false);setLlmFailed(false);setLlmStatus("已跳过本次 LLM 复核，保留当前字段映射，可自行调整后继续。");}
  async function reviewMapping(baseMapping?:Mapping,baseInspect?:Inspect){
    const target=baseInspect??draft.inspect;
    if(!target)return;
    const source=baseMapping??draft.mapping;
    const generation=++llmGeneration.current;
    setLlmBusy(true);setLlmFailed(false);setLlmStatus("");setError("");setChanges([]);setPending([]);
    try{const value=await engineCall("kanzhang.llm_mapping",{mode:"mapping",payload:{headers:target.headers,samples:target.preview.slice(0,8),currentMapping:source}}) as LedgerReviewResponse;
      if(generation!==llmGeneration.current)return;
      const {mapping,changes:merged,pending:rest}=applyLedgerReviews(source,value);
      patch({mapping});setChanges(merged);setPending(rest);setLlmStatus(kanzhangReviewSummary(merged.length,rest.length));}
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
  async function applyAuditFocusPresets(){
    setAccountsBusy(true);setError("");
    try{
      // 列表界面可能为性能而截断；预设必须基于全量唯一科目，不可只套用前 20,000 项。
      const source=truncated?await engineCall("kanzhang.accounts",{inputPath:draft.inputPath,sheet:draft.sheet||undefined,headerRow:draft.headerRow,mapping:draft.mapping,keyword:"",limit:1,all:true}) as {values:string[];codes?:string[]}: {values:accounts,codes:accountCodes};
      const applied=applyAuditFocusPresetBatches(draft.batches,source.values,source.codes??[],draft.excludes);
      const firstPreset=applied.batches.findIndex(value=>value.presetId===AUDIT_FOCUS_PRESETS[0].id);
      const outputPath=!draft.outputTouched&&draft.inputPath?defaultKanzhangOutputPath(draft.inputPath,draft.sheet).replace(/\.csv$/i,".xlsx"):draft.outputPath;
      patch({batches:applied.batches,activeBatch:firstPreset>=0?firstPreset:draft.activeBatch,outputPath});
      setPresetSummary(applied.summary);setPrimaryPresetSummary(undefined);setSelectedAvailable([]);setSelectedTarget([]);setSelectedExclude([]);
    }catch(e){setError(kanzhangErrorText(e));}
    finally{setAccountsBusy(false);}
  }
  async function applyAllPrimaryAccounts(){
    setAccountsBusy(true);setError("");
    try{
      const source=await engineCall("kanzhang.accounts",{inputPath:draft.inputPath,sheet:draft.sheet||undefined,headerRow:draft.headerRow,mapping:draft.mapping,keyword:"",limit:1,all:true}) as {values:string[];codes?:string[];primaryNames?:string[]};
      const applied=applyAllPrimaryAccountBatches(draft.batches,source.values,source.codes??[],source.primaryNames??[],draft.excludes);
      const firstPreset=applied.batches.findIndex(value=>value.presetId?.startsWith("all_primary:"));
      const outputPath=!draft.outputTouched&&draft.inputPath?defaultKanzhangOutputPath(draft.inputPath,draft.sheet).replace(/\.csv$/i,".xlsx"):draft.outputPath;
      patch({batches:applied.batches,activeBatch:firstPreset>=0?firstPreset:draft.activeBatch,outputPath});
      setPrimaryPresetSummary(applied.summary);setPresetSummary(undefined);setSelectedAvailable([]);setSelectedTarget([]);setSelectedExclude([]);
    }catch(e){setError(kanzhangErrorText(e));}
    finally{setAccountsBusy(false);}
  }
  async function chooseOutput(){const value=await pickPath("save","保存看账结果（可选 CSV 或 XLSX）",["csv","xlsx"],defaultKanzhangOutputName(draft.inputPath,draft.sheet));if(typeof value==="string")patch({outputPath:value,outputTouched:true});}
  // 恢复默认：回到"凭证文件旁 + 旧版默认命名"，时间戳按当前时间重算。
  function resetOutput(){autoOutputKey.current="";let outputPath=draft.inputPath?defaultKanzhangOutputPath(draft.inputPath,draft.sheet):"";if(draft.batches.some(batch=>batch.presetId))outputPath=outputPath.replace(/\.csv$/i,".xlsx");patch({outputTouched:false,outputPath});}
  async function start(method:"kanzhang.filter"|"kanzhang.export"){const valid=validKanzhangBatches(draft.batches);if(!valid.length){setError("请至少为一个有效批次选择目标科目。若需分析全部科目，请在目标批次中全选科目。");patch({step:2});return;}setBusy(true);setError("");
    // 默认落点的时间戳按"开始导出"的时刻刷新，免得停留在选文件的时间。
    let target=draft.outputPath;
    if(method==="kanzhang.export"&&!draft.outputTouched&&draft.inputPath){
      target=defaultKanzhangOutputPath(draft.inputPath,draft.sheet);
      if(valid.some(batch=>batch.presetId))target=target.replace(/\.csv$/i,".xlsx");
      autoOutputKey.current=`${draft.inputPath}|${draft.sheet}`;
      patch({outputPath:target});
    }
    try{const jobId=await jobStart(method,{inputPath:draft.inputPath,sheet:draft.sheet||undefined,headerRow:draft.headerRow,mapping:draft.mapping,targetBatches:valid,excludeAccounts:draft.excludes,outputPath:target||undefined,
      // 套表和 LLM 分析在旧版里没有开关，一律生成；这里写死 true，
      // 顺带覆盖掉早期版本残留在 sessionStorage 草稿里的 false。
      includePivot:true,includeVoucherTypes:true,llmAnalysis:true,
      markLossTransfer:draft.markLossTransfer,pivotRows:draft.pivotRows,pivotColumns:draft.pivotColumns,pivotValues:draft.pivotValues});setJob({jobId,toolId:"kanzhang",phase:"queued",current:0,total:1,message:"任务已进入队列",severity:"info",outputPaths:[]});}catch(e){setBusy(false);setError(kanzhangErrorText(e));}}
  const headers=draft.inspect?.headers??[];
  const scheme=activeAmountScheme(draft.mapping);
  const lockedHint=scheme==="B"?"不适用（已用方案B）":scheme==="A"?"不适用（已用方案A）":"未映射";
  const missingRequired=missingKanzhangRequiredRoles(draft.mapping);
  const showReview=llmBusy||llmFailed||Boolean(llmStatus)||changes.length>0||pending.length>0;
  return <div className="kz-page">
    <PageHeader eyebrow="凭证映射与科目筛选" title={tool.name} detail="按旧版三步流程完成字段映射、科目穿梭、多批次、凭证类型、JE 匹配、损益结转与导出。" />
    <StepIndicator steps={[{key:"1",label:"加载与映射"},{key:"2",label:"科目筛选",disabled:!draft.inspect||missingRequired.length>0},{key:"3",label:"透视与导出",disabled:!draft.inspect||missingRequired.length>0}]} current={draft.step-1} onStepClick={(index)=>patch({step:index+1})} />
    {error&&<ErrorBox error={error} onDismiss={()=>setError("")} />}
    {draft.step===1&&<div className="fa-stack">
      <LedgerSourceCard
        inputPath={draft.inputPath} sheet={draft.sheet} knownSheets={draft.knownSheets} headerRow={draft.headerRow}
        dragHover={dragHover} busy={busy} job={job} needsReload={!draft.inspect&&draft.knownSheets.length>0}
        onBrowse={chooseInput} onClear={clearAll}
        onSheetChange={value=>setDraft(current=>invalidateKanzhangInspection(current,{sheet:value}))}
        onHeaderRowChange={value=>setDraft(current=>invalidateKanzhangInspection(current,{headerRow:value}))}
        onInspect={inspect} onCancel={(jobId)=>void jobCancel(jobId)}
      >
      {draft.inspect&&<>
        {showReview&&<LedgerLlmReview busy={llmBusy} failed={llmFailed} status={llmStatus} mapping={draft.mapping} changes={changes} pending={pending} onSkip={skipReview} onUndo={undoChange} onAccept={acceptPending} onKeep={item=>setPending(values=>values.filter(value=>value!==item))}/>}
        {scheme&&<p className="kz-hint">金额口径已按方案{scheme}成立，方案{scheme==="A"?"B":"A"}的字段已停用；如需切换，先清空当前方案的字段。</p>}
        {missingRequired.length>0&&<p className="fa-missing-hint">尚未映射：{missingRequired.join("、")}（请在各列顶部的下拉框中选择对应字段）</p>}
        <div className="kz-actions"><Button variant="secondary" size="sm" disabled={busy||llmBusy} onClick={()=>void reviewMapping()}>{llmBusy?"LLM 正在复核…":"重新进行 LLM 复核"}</Button><Button variant="default" disabled={llmBusy||missingRequired.length>0} onClick={()=>patch({step:2})}>下一步：科目筛选</Button></div>
      </>}
      </LedgerSourceCard>
      <LedgerMappingPreview inspect={draft.inspect} mapping={draft.mapping} setMap={setMap} llmBusy={llmBusy}/></div>}
    {draft.step===2&&<div className="kz-grid kz-filter-grid"><section className="kz-card"><h2>目标批次</h2><div className="kz-row"><Button variant="secondary" size="sm" disabled={accountsBusy||!accounts.length} onClick={()=>void applyAuditFocusPresets()}>{accountsBusy?"正在生成批次…":"套用审计关注科目预设（8类）"}</Button><Button variant="secondary" size="sm" disabled={accountsBusy||!accounts.length} onClick={()=>void applyAllPrimaryAccounts()}>按一级科目生成全科目批次（不含货币资金）</Button><Button variant="secondary" size="sm" onClick={addBatch}>新增批次</Button><Button variant="secondary" size="sm" onClick={deleteBatch}>删除批次</Button></div>{presetSummary&&<PresetSummary summary={presetSummary}/>} {primaryPresetSummary&&<PrimaryPresetSummary summary={primaryPresetSummary}/>}<div className="kz-tabs">{draft.batches.map((value,index)=><button className={index===draft.activeBatch?"active":""} onClick={()=>patch({activeBatch:index})} key={`${value.presetId??value.name}-${index}`}>{value.name} ({value.accounts.length})</button>)}</div><label>批次名称<input value={batch.name} onChange={e=>updateBatch({name:e.target.value})}/></label>
      <div className="kz-search"><input className="kz-code-prefix" value={codePrefix} placeholder="按科目编码段筛选，如 6401,660" title="按科目编码段筛选，如 6401,6603" onChange={e=>setCodePrefix(e.target.value)}/><input value={query} placeholder="输入关键词即时过滤科目" onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&truncated)void searchAccounts();}}/>{truncated&&<Button variant="secondary" size="sm" onClick={searchAccounts}>到全库检索</Button>}<Button variant="secondary" size="sm" onClick={()=>{setQuery("");setCodePrefix("");setSearchResults([]);}}>清除</Button></div>
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
        套表（凭证/透视/凭证类型）和 LLM 分析都是无条件生成的，
        迁移版多出来的勾选项既不是旧行为，也只会让人犹豫该不该勾。
        正负数凭证标记连同它的三列辅助列已剪到独立工具，这里不再有那个开关。
      */}
      <div className="kz-options"><Check label="标记损益结转凭证" value={draft.markLossTransfer} onChange={value=>patch({markLossTransfer:value})}/></div><label>输出文件<div className="kz-path"><input readOnly value={draft.outputPath} title={draft.outputPath} placeholder="选择凭证文件后自动填入默认保存位置"/><Button variant="secondary" size="sm" onClick={chooseOutput}>选择</Button>{draft.outputTouched&&<Button variant="secondary" size="sm" onClick={resetOutput}>恢复默认</Button>}</div></label><p className="kz-hint">{draft.outputTouched?"已指定保存位置，导出会以这个文件名为基准。":draft.batches.some(batch=>batch.presetId)?"预设批次默认导出为 XLSX；每个有效批次使用独立文件名。":"默认保存到凭证文件所在目录，文件名为「看账导出_源文件名[_工作表]_<时间戳>.csv」（导出时按当前时间生成）。"}两阶段导出中，每批次的明细单独一个文件，凭证/透视/凭证类型另出该批次对应的「_套表.xlsx」；有剔除科目时再输出剔除明细。需要正负数对冲标记请用「正负数凭证标记」工具。</p><div className="kz-actions"><Button variant="secondary" size="sm" onClick={()=>patch({step:2})}>返回筛选</Button>{busy&&job?<Button variant="secondary" size="sm" onClick={()=>jobCancel(job.jobId)}>停止</Button>:<Button variant="default" onClick={()=>void start("kanzhang.export")}>导出结果</Button>}</div></section></div><Result job={job} result={result}/></>}
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
function PresetSummary({summary}:{summary:PresetApplySummary}){const empty=summary.matches.filter(value=>!value.accounts.length);return <div className="kz-hint" role="status"><b>预设已套用：</b>新增 {summary.created} 个、更新 {summary.updated} 个预设批次。{summary.matches.map(value=><span key={value.preset.id}> {value.preset.name.replace("预设｜","")} {value.accounts.length} 个；</span>)}{empty.length>0&&<span>未命中：{empty.map(value=>value.preset.name.replace("预设｜","")).join("、")}。</span>}{summary.skippedExcludes.length>0&&<span> 已在剔除/例外中而未加入：{summary.skippedExcludes.join("、")}。</span>}</div>}
function PrimaryPresetSummary({summary}:{summary:PrimaryPresetSummary}){return <div className="kz-hint" role="status"><b>全科目批次已生成：</b>共 {summary.groups.length} 个一级科目；新增 {summary.created} 个、更新 {summary.updated} 个、移除 {summary.removed} 个旧的全科目预设批次。已排除货币资金 {summary.skippedCash.length} 个科目{summary.skippedExcludes.length>0&&`，另跳过剔除/例外 ${summary.skippedExcludes.length} 个科目`}。</div>}
function Result({job,result}:{job?:JobEvent;result?:unknown}){const object=result&&typeof result==="object"?result as Record<string,unknown>:undefined;const paths=[...new Set([...(job?.outputPaths??[]),...(Array.isArray(object?.outputPaths)?object.outputPaths.filter((value):value is string=>typeof value==="string"):[])])];const batches=Array.isArray(object?.batches)?object.batches as Record<string,unknown>[]:[];const rows=typeof object?.rows==="number"?object.rows:undefined;const showProgress=shouldShowKanzhangJobProgress(job?.phase);return <Card className="kz-result"><CardHeader><CardTitle>预览与结果</CardTitle></CardHeader><CardContent>{job&&showProgress&&<JobProgress job={job} onCancel={(jobId)=>void jobCancel(jobId)} cancelLabel="取消任务"/>}{rows!==undefined&&<p>筛选后共 <b>{rows}</b> 行，可继续调整科目或进入导出。</p>}{paths.length>0&&<div className="kz-outputs">{paths.map(path=><Button key={path} variant="secondary" size="sm" title={path} onClick={()=>void openOutput(path)}><span>打开：</span><span>{path.split(/[\\/]/).pop()}</span></Button>)}</div>}{batches.length>0&&<div className="kz-summary">{batches.map((batch,index)=><div key={index}><b>{String(batch.name??`批次${index+1}`)}</b><span>明细 {String(batch.rows??0)} 行</span><span>损益结转 {String(batch.lossTransferVouchers??0)} 笔</span></div>)}</div>}{!result&&!showProgress&&<p>执行筛选或导出后显示结果。</p>}</CardContent></Card>}
