import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolManifest, JobEvent } from "./types";
import { engineCall, jobCancel, jobStart, listenPositionedFileDrops, listenJobEvents, openOutput, pickPath } from "./api";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/DataTable";
import "./fx-audit.css";

type Mode = "realized" | "unrealized" | "combined";
type Inspection = {
  headers: string[]; sheet: string; sheets: string[]; headerRow: number; headerDepth: number;
  rowCount: number; preview: string[][]; entities: string[]; accounts: string[];
  suggestedMapping: Record<string, string>;
  mappingCandidates: Array<{role: string; candidates: Array<{column: string; confidence: number; conflictTerms: string[]}>}>;
  headerDetection: {needsConfirmation: boolean; candidates: Array<{row: number; score: number}>};
  dataYears: number[];
  suggestedBalanceSheetDate?: string;
};
type SourceClassification = {kind:"je"|"tb";confidence:number;needsLlm:boolean;scores:{je:number;tb:number};reasons:string[];headers:string[];preview:string[][];sheet:string;headerRow:number;headerDepth:number};

const JE_LABELS: Record<string, string> = {
  id:"凭证识别字段",voucherType:"凭证类型",entity:"公司/核算主体",date:"记账日期",account:"科目编码/名称",currency:"交易币种",
  summary:"摘要",auxiliary:"辅助核算",clearingId:"清账号",foreignAmount:"原币净额",
  foreignDirection:"原币借贷方向",foreignDebit:"原币借方",foreignCredit:"原币贷方",
  functionalAmount:"本位币净额",functionalDirection:"本位币借贷方向",
  functionalDebit:"本位币借方",functionalCredit:"本位币贷方",
};
const TB_LABELS: Record<string, string> = {
  entity:"公司/核算主体",account:"科目编码/名称",currency:"币种",auxiliary:"辅助核算",
  functionalCurrency:"本位币（选填）",openingForeignAmount:"年初原币净余额",
  openingForeignDebit:"年初原币借方余额",openingForeignCredit:"年初原币贷方余额",
  openingFunctionalAmount:"年初本位币净余额",openingFunctionalDebit:"年初本位币借方余额",
  openingFunctionalCredit:"年初本位币贷方余额",closingForeignAmount:"年末原币净余额",
  closingForeignDebit:"年末原币借方余额",closingForeignCredit:"年末原币贷方余额",
  closingFunctionalAmount:"年末本位币净余额",closingFunctionalDebit:"年末本位币借方余额",
  closingFunctionalCredit:"年末本位币贷方余额",
  periodFunctionalDebit:"本期本位币借方发生额",periodFunctionalCredit:"本期本位币贷方发生额",
};
const ROLE_OPTIONS = [
  ["cash","外币现金及银行"],["monetary_asset","应收/其他货币性资产"],
  ["monetary_liability","应付/借款/其他货币性负债"],["fx_gain_loss","汇兑损益"],
  ["non_monetary","非货币性项目"],["excluded","排除项目"],["review","待确认（预付/预收等）"],
  ["unassigned","未分配"],
];

export function fxDefaultMode(hasJe: boolean, hasTb: boolean): Mode {
  if (hasJe && hasTb) return "combined";
  if (hasJe) return "realized";
  return "unrealized";
}
export function fxAllowedModes(hasJe: boolean, hasTb: boolean): Mode[] {
  return [...(hasJe ? ["realized" as Mode] : []), ...(hasTb ? ["unrealized" as Mode] : []), ...(hasJe && hasTb ? ["combined" as Mode] : [])];
}
export function fxReportStart(balanceSheetDate:string){return /^\d{4}-\d{2}-\d{2}$/.test(balanceSheetDate)?`${balanceSheetDate.slice(0,4)}-01-01`:""}
export function fxDropTargetAt(x:number,y:number,jeRect:Pick<DOMRect,"left"|"right"|"top"|"bottom">|undefined,tbRect:Pick<DOMRect,"left"|"right"|"top"|"bottom">|undefined):"je"|"tb"|undefined{const hit=(rect:typeof jeRect)=>Boolean(rect&&x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom);return hit(jeRect)?"je":hit(tbRect)?"tb":undefined}
export function fxMissingRequired(kind:"je"|"tb",mapping:Record<string,string|string[]>,hasJe:boolean,fixedEntity:string):string[]{const has=(role:string)=>{const value=mapping[role];return Array.isArray(value)?value.some(item=>item.trim()):Boolean(value?.trim())};const missing:string[]=[];if(!has("entity")&&!fixedEntity.trim())missing.push("公司/核算主体（或固定主体）");if(kind==="je"){if(!has("id"))missing.push("凭证识别字段");if(!has("date"))missing.push("记账日期");if(!has("account"))missing.push("科目编码/名称");if(!has("currency"))missing.push("交易币种");if(!(has("foreignAmount")||(has("foreignDebit")&&has("foreignCredit"))))missing.push("原币金额方案");if(!(has("functionalAmount")||(has("functionalDebit")&&has("functionalCredit"))))missing.push("本位币金额方案")}else{if(!has("account"))missing.push("科目编码/名称");if(!(has("closingFunctionalAmount")||(has("closingFunctionalDebit")&&has("closingFunctionalCredit"))))missing.push("期末本位币余额方案");if(!hasJe){if(!(has("openingFunctionalAmount")||(has("openingFunctionalDebit")&&has("openingFunctionalCredit"))))missing.push("年初本位币余额方案");if(!has("currency"))missing.push("币种");if(!(has("openingForeignAmount")||(has("openingForeignDebit")&&has("openingForeignCredit"))))missing.push("年初原币余额方案");if(!(has("closingForeignAmount")||(has("closingForeignDebit")&&has("closingForeignCredit"))))missing.push("年末原币余额方案")}}return missing}

export function FxAuditPage({ tool }: { tool: ToolManifest }) {
  const [jePath,setJePath] = useState(""); const [tbPath,setTbPath] = useState("");
  const [mode,setMode] = useState<Mode>("unrealized");
  const [reportEnd,setReportEnd] = useState("");
  const [je,setJe] = useState<Inspection>(); const [tb,setTb] = useState<Inspection>();
  const [jeMapping,setJeMapping] = useState<Record<string,string|string[]>>({});
  const [tbMapping,setTbMapping] = useState<Record<string,string|string[]>>({});
  const [entityCurrencies,setEntityCurrencies] = useState<Record<string,string>>({});
  const [fixedEntity,setFixedEntity] = useState("默认主体");
  const [accountRoles,setAccountRoles] = useState<Record<string,string>>({});
  const [busy,setBusy] = useState(false); const [error,setError] = useState("");
  const [reviewing,setReviewing] = useState<"je"|"tb"|null>(null);
  const [reviewStatus,setReviewStatus] = useState<Record<string,string>>({});
  const [job,setJob] = useState<JobEvent>(); const [result,setResult] = useState<Record<string,unknown>>();
  const [outputPath,setOutputPath] = useState(""); const [sourceStatus,setSourceStatus]=useState(""); const activeJob=useRef(""); const uploadDropRef=useRef<HTMLDivElement>(null);
  const allowedModes=fxAllowedModes(Boolean(jePath),Boolean(tbPath));
  const entities=useMemo(()=>[...new Set([...(je?.entities??[]),...(tb?.entities??[])])],[je,tb]);
  const accounts=useMemo(()=>[...new Set([...(je?.accounts??[]),...(tb?.accounts??[])])],[je,tb]);

  useEffect(()=>setMode(fxDefaultMode(Boolean(jePath),Boolean(tbPath))),[jePath,tbPath]);
  useEffect(()=>setEntityCurrencies(v=>Object.fromEntries(entities.map(e=>[e,v[e]??"CNY"]))),[entities]);
  useEffect(()=>{if(entities.length===1)setFixedEntity(entities[0])},[entities]);
  useEffect(()=>setAccountRoles(v=>Object.fromEntries(accounts.map(account=>{const direct=suggestRole(account);const code=account.trim().split(/\s+/)[0];const related=direct==="unassigned"?accounts.map(suggestRole).find((role,index)=>role!=="unassigned"&&accounts[index].trim().split(/\s+/)[0]===code):undefined;return[account,v[account]??related??direct]}))),[accounts]);
  useEffect(()=>{
    const drops=listenPositionedFileDrops(({paths,x,y})=>{const rect=uploadDropRef.current?.getBoundingClientRect();if(!rect||x<rect.left||x>rect.right||y<rect.top||y>rect.bottom)return;void classifyAndInspect(paths);});
    const jobs=listenJobEvents(event=>{if(event.jobId!==activeJob.current)return;setJob(event);if(event.phase==="completed"){setBusy(false);setResult(event.result as Record<string,unknown>)}else if(event.phase==="failed"||event.phase==="cancelled"){setBusy(false);const p=event.result as {error?:{userMessage?:string}}|undefined;setError(p?.error?.userMessage??event.message)}});
    return()=>{void drops.then(x=>x());void jobs.then(x=>x())};
  },[]);

  async function browse(){const picked=await pickPath("files","选择JE或TB文件",["xlsx","xls","xlsm","csv","txt","tsv","parquet"]);if(!picked)return;void classifyAndInspect(Array.isArray(picked)?picked:[picked])}
  async function classifyAndInspect(paths:string[]){const files=paths.filter(p=>/\.(xlsx?|xlsm|csv|txt|tsv|parquet)$/i.test(p));if(!files.length)return;setBusy(true);setError("");setSourceStatus("正在识别文件类型、表头和字段…");const failures:string[]=[];try{for(const path of files){try{const scripted=await engineCall("fx.classify_source",{source:{inputPath:path,sheet:"",headerRow:0,headerDepth:0}}) as SourceClassification;let kind=scripted.kind;let source="脚本";if(scripted.needsLlm){const llm=await engineCall("fx.classify_source_llm",{payload:{path,headers:scripted.headers,sampleRows:scripted.preview,scriptScores:scripted.scores}}) as {kind?:"je"|"tb"};if(llm.kind)kind=llm.kind;source="脚本无法确定，已由LLM"}const response=await engineCall("fx.inspect_"+kind,{source:{inputPath:path,sheet:scripted.sheet,headerRow:scripted.headerRow,headerDepth:scripted.headerDepth}}) as Inspection;applyInspection(kind,path,response);setSourceStatus(`${files.length} 个文件已识别；${kind.toUpperCase()} 由${source}判定。`)}catch(e){failures.push(`${fileName(path)}：${errorText(e)}`)}}if(failures.length)setError(failures.join("；"))}finally{setBusy(false)}}
  function applyInspection(kind:"je"|"tb",path:string,response:Inspection){if(response.suggestedBalanceSheetDate)setReportEnd(response.suggestedBalanceSheetDate);else if(response.dataYears?.length===1)setReportEnd(`${response.dataYears[0]}-12-31`);if(kind==="je"){setJePath(path);setJe(response);setJeMapping(response.suggestedMapping)}else{setTbPath(path);setTb(response);setTbMapping(response.suggestedMapping)}}
  async function inspect(kind:"je"|"tb",over?:Partial<{sheet:string;headerRow:number;headerDepth:number}>){
    setBusy(true);setError("");try{const current=kind==="je"?je:tb;const response=await engineCall("fx.inspect_"+kind,{source:{inputPath:kind==="je"?jePath:tbPath,sheet:over?.sheet??current?.sheet??"",headerRow:over?.headerRow??current?.headerRow??0,headerDepth:over?.headerDepth??current?.headerDepth??0}}) as Inspection;
      applyInspection(kind,kind==="je"?jePath:tbPath,response)
    }catch(e){setError(errorText(e))}finally{setBusy(false)}
  }
  async function review(kind:"je"|"tb"){const inspection=kind==="je"?je:tb;if(!inspection)return;setBusy(true);setReviewing(kind);setReviewStatus(v=>({...v,[kind]:"正在复核字段映射…"}));setError("");try{const response=await engineCall("fx.review_"+kind+"_mapping",{payload:{headers:inspection.headers,sampleRows:inspection.preview,hardcodedCandidates:inspection.mappingCandidates,currentMapping:kind==="je"?jeMapping:tbMapping}}) as {changes?:Array<{role:string;suggestedColumn:string;confidence:number}>};const labels=kind==="je"?JE_LABELS:TB_LABELS;const setter=kind==="je"?setJeMapping:setTbMapping;let applied=0;setter(current=>{const next={...current};for(const c of response.changes??[]){const candidate=inspection.mappingCandidates.find(x=>x.role===c.role)?.candidates.find(x=>x.column===c.suggestedColumn);const duplicate=Object.entries(next).some(([role,column])=>role!==c.role&&column===c.suggestedColumn);if(c.confidence>=.6&&c.role in labels&&inspection.headers.includes(c.suggestedColumn)&&(candidate?.conflictTerms.length??0)===0&&!duplicate){next[c.role]=c.suggestedColumn;applied+=1}}return next});setReviewStatus(v=>({...v,[kind]:applied?`复核完成，已应用 ${applied} 项建议。`:"复核完成，当前映射无需调整。"}))}catch(e){setReviewStatus(v=>({...v,[kind]:"复核失败，可继续手工映射。"}));setError(errorText(e)+" 可继续手工映射。")}finally{setBusy(false);setReviewing(null)}}
  function payload(){const effectiveEntities=entities.length?entityCurrencies:{[fixedEntity]:"CNY"};return{mode,reportStart:fxReportStart(reportEnd),reportEnd,fixedEntity,...(je?{jeSource:{inputPath:jePath,sheet:je.sheet,headerRow:je.headerRow,headerDepth:je.headerDepth},jeMapping}:{}),...(tb?{tbSource:{inputPath:tbPath,sheet:tb.sheet,headerRow:tb.headerRow,headerDepth:tb.headerDepth},tbMapping}:{}),entityCurrencies:effectiveEntities,accountRoles,...(outputPath?{outputPath}:{})}}
  async function run(method:"fx.preview"|"fx.export"){setError("");setResult(undefined);if(!reportEnd)return setError("请选择资产负债表日。");if((mode==="realized"||mode==="combined")&&!je)return setError("已实现测算需先上传并识别JE。");if((mode==="unrealized"||mode==="combined")&&!tb)return setError("未实现测算需先上传并识别TB。");const jeMissing=je&&mode!=="unrealized"?fxMissingRequired("je",jeMapping,true,fixedEntity):[];if(jeMissing.length)return setError(`JE尚未映射：${jeMissing.join("、")}。请先在预览表头完成字段映射。`);const tbMissing=tb&&mode!=="realized"?fxMissingRequired("tb",tbMapping,Boolean(je),fixedEntity):[];if(tbMissing.length)return setError(`TB尚未映射：${tbMissing.join("、")}。请先在预览表头完成字段映射。`);if(entities.some(e=>!entityCurrencies[e]))return setError("请为每个公司选择ISO本位币。");setBusy(true);try{activeJob.current=await jobStart(method,payload())}catch(e){setBusy(false);setError(errorText(e))}}

  return <main className="tool-page fx-page">
    <PageHeader eyebrow="外币审计" title={tool.name} detail="按凭证识别结算事件，按官方人民币汇率中间价重算，并生成可追踪Excel底稿。" />
    <ErrorBox error={error} onDismiss={()=>setError("")}/>
    <section className="fx-mode-bar">{([["realized","仅已实现"],["unrealized","仅未实现"],["combined","已实现＋未实现"]] as Array<[Mode,string]>).map(([value,label])=><button key={value} type="button" className={mode===value?"active":""} disabled={!allowedModes.includes(value)} onClick={()=>setMode(value)}>{label}</button>)}</section>
    <Card><CardHeader><CardTitle>上传审计数据</CardTitle></CardHeader><CardContent><p className="fx-hint">JE和TB使用同一入口；系统先按表格结构自动识别，无法确定时再调用LLM。</p><FileDropInput containerRef={uploadDropRef} value={[jePath&&`JE：${fileName(jePath)}`,tbPath&&`TB：${fileName(tbPath)}`].filter(Boolean).join("；")} disabled={busy} placeholder="拖放或选择JE、TB文件（可同时选择）" onBrowse={()=>void browse()} onDragStateChange={()=>{}} onClear={()=>{setJePath("");setTbPath("");setJe(undefined);setTb(undefined);setJeMapping({});setTbMapping({});setSourceStatus("")}}/>{sourceStatus&&<p className="fx-source-status">{sourceStatus}</p>}</CardContent></Card>
    <div className="fx-source-grid">
      {jePath&&<SourceCard title="已识别：JE 凭证明细" hint="已实现测算及月度未实现重估识别的数据源" path={jePath} inspection={je} disabled={busy} onClear={()=>{setJePath("");setJe(undefined);setJeMapping({})}} onInspect={()=>void inspect("je")} onHeaderChange={(headerRow,headerDepth,sheet)=>void inspect("je",{headerRow,headerDepth,sheet})}/>} 
      {tbPath&&<SourceCard title="已识别：TB 科目余额表" hint="未实现测算和财务费用—汇兑损益勾稽的数据源" path={tbPath} inspection={tb} disabled={busy} onClear={()=>{setTbPath("");setTb(undefined);setTbMapping({})}} onInspect={()=>void inspect("tb")} onHeaderChange={(headerRow,headerDepth,sheet)=>void inspect("tb",{headerRow,headerDepth,sheet})}/>} 
    </div>
    <div className="fx-preview-stack">
      {je&&<><section className="kz-card"><h2>JE 字段映射复核</h2><p>{reviewing==="je"?"正在复核字段映射；复核期间字段映射暂时锁定。":reviewStatus.je||"脚本已自动映射，可直接核对或使用LLM复核。"}</p><div className="kz-actions"><Button variant="secondary" disabled={reviewing==="je"} onClick={()=>void review("je")}>{reviewing==="je"?"LLM复核中…":"LLM复核"}</Button></div></section><FxPreview title="JE 文件预览" inspection={je} mapping={jeMapping} labels={JE_LABELS} missing={fxMissingRequired("je",jeMapping,true,fixedEntity)} onMappingChange={setJeMapping} reviewBusy={reviewing==="je"}/></>}
      {tb&&<><section className="kz-card"><h2>TB 字段映射复核</h2><p>{reviewing==="tb"?"正在复核字段映射；复核期间字段映射暂时锁定。":reviewStatus.tb||"脚本已自动映射，可直接核对或使用LLM复核。"}</p><div className="kz-actions"><Button variant="secondary" disabled={reviewing==="tb"} onClick={()=>void review("tb")}>{reviewing==="tb"?"LLM复核中…":"LLM复核"}</Button></div></section><FxPreview title="TB 文件预览" inspection={tb} mapping={tbMapping} labels={TB_LABELS} missing={fxMissingRequired("tb",tbMapping,Boolean(je),fixedEntity)} onMappingChange={setTbMapping} reviewBusy={reviewing==="tb"}/></>}
    </div>
    {(je||tb)&&<div className="fx-source-grid">
      <Card><CardHeader><CardTitle>公司本位币</CardTitle></CardHeader><CardContent className="fx-list">{entities.length?entities.map(entity=><label key={entity}><span>{entity}</span><input value={entityCurrencies[entity]??"CNY"} maxLength={3} onChange={e=>setEntityCurrencies(v=>({...v,[entity]:e.target.value.toUpperCase()}))}/></label>):<><label><span>文件无主体列，固定主体</span><input value={fixedEntity} onChange={e=>setFixedEntity(e.target.value)}/></label><label><span>本位币</span><input value="CNY" readOnly/></label></>}</CardContent></Card>
      <Card><CardHeader><CardTitle>高级设置</CardTitle></CardHeader><CardContent><details><summary>科目分类（通常无需修改）</summary><div className="fx-list fx-accounts">{accounts.map(account=><label key={account}><span title={account}>{account}</span><select value={accountRoles[account]??"unassigned"} onChange={e=>setAccountRoles(v=>({...v,[account]:e.target.value}))}>{ROLE_OPTIONS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>)}</div></details></CardContent></Card>
    </div>}
    <Card><CardHeader><CardTitle>测算与底稿</CardTitle></CardHeader><CardContent>
      <div className="fx-run-grid"><label>资产负债表日<input type="date" value={reportEnd} onChange={e=>setReportEnd(e.target.value)}/></label><label>输出文件<input value={outputPath} readOnly placeholder="默认保存到源文件目录"/></label><Button variant="secondary" onClick={async()=>{const path=await pickPath("save","保存审计底稿",["xlsx"],"汇兑损益审计测算.xlsx");if(typeof path==="string")setOutputPath(path)}}>选择位置</Button></div>
      <p className="fx-rate-note">汇率由系统从官方来源获取，非公布日向前取最近公布日；用户不可手工改写。</p>
      <div className="fx-actions"><Button variant="secondary" disabled={busy} onClick={()=>void run("fx.preview")}>测算预览</Button><Button disabled={busy} onClick={()=>void run("fx.export")}>生成Excel底稿</Button></div>
      {job&&<JobProgress job={job} onCancel={busy?(id)=>void jobCancel(id):undefined}/>}
      {result&&<FxResult result={result}/>}
    </CardContent></Card>
  </main>;
}

function SourceCard(props:{title:string;hint:string;path:string;inspection?:Inspection;disabled:boolean;onClear:()=>void;onInspect:()=>void;onHeaderChange:(row:number,depth:number,sheet:string)=>void}){
  return <Card><CardHeader><CardTitle>{props.title}</CardTitle></CardHeader><CardContent><p className="fx-hint">{props.hint}</p><div className="fx-detected-file"><span title={props.path}>{props.path}</span><button type="button" disabled={props.disabled} onClick={props.onClear}>移除</button></div>
    {props.path&&!props.inspection&&<Button variant="secondary" disabled={props.disabled} onClick={props.onInspect}>自动识别表头和字段</Button>}
    {props.inspection&&<div className="fx-source-meta"><span>{props.inspection.rowCount.toLocaleString()} 行</span><label>Sheet<select value={props.inspection.sheet} onChange={e=>props.onHeaderChange(0,0,e.target.value)}>{props.inspection.sheets.length?props.inspection.sheets.map(s=><option key={s}>{s}</option>):<option>{props.inspection.sheet}</option>}</select></label><label>标题行<input type="number" min={1} value={props.inspection.headerRow} onChange={e=>props.onHeaderChange(Number(e.target.value),props.inspection!.headerDepth,props.inspection!.sheet)}/></label><label>表头层数<select value={props.inspection.headerDepth} onChange={e=>props.onHeaderChange(props.inspection!.headerRow,Number(e.target.value),props.inspection!.sheet)}><option value={1}>1层</option><option value={2}>2层</option></select></label>{props.inspection.headerDetection.needsConfirmation&&<strong className="fx-warning">标题候选得分接近，请确认标题行</strong>}</div>}
  </CardContent></Card>;
}
function FxPreview(props:{title:string;inspection:Inspection;mapping:Record<string,string|string[]>;labels:Record<string,string>;missing:string[];onMappingChange:React.Dispatch<React.SetStateAction<Record<string,string|string[]>>>;reviewBusy:boolean}){
  const roles=Object.entries(props.labels); const multi=new Set(["id","account","auxiliary"]);
  const mappedRole=(header:string)=>roles.find(([role])=>{const value=props.mapping[role];return Array.isArray(value)?value.includes(header):String(value??"")===header;})?.[0]??"";
  const update=(header:string,role:string)=>props.onMappingChange(current=>{const next={...current};for(const [key,value] of Object.entries(next)){if(Array.isArray(value)&&value.includes(header))next[key]=value.filter(x=>x!==header);else if(value===header)next[key]="";}if(role){if(multi.has(role)){const currentValue=Array.isArray(next[role])?next[role]:next[role]?[String(next[role])]:[];next[role]=[...currentValue,header];}else next[role]=header;}return next});
  const usedRoles=new Set(roles.filter(([role])=>{const value=props.mapping[role];return Array.isArray(value)?value.length>0:Boolean(value&&String(value).trim())}).map(([role])=>role));
  const schemeGroups=[["foreignAmount","foreignDirection"],["foreignDebit","foreignCredit"],["functionalAmount","functionalDirection"],["functionalDebit","functionalCredit"],["openingForeignAmount"],["openingForeignDebit","openingForeignCredit"],["openingFunctionalAmount"],["openingFunctionalDebit","openingFunctionalCredit"],["closingForeignAmount"],["closingForeignDebit","closingForeignCredit"],["closingFunctionalAmount"],["closingFunctionalDebit","closingFunctionalCredit"]];
  const locked=(role:string)=>schemeGroups.some(group=>group.includes(role)&&schemeGroups.some(other=>other!==group&&group.some(value=>value.startsWith("openingForeign")?other.some(x=>x.startsWith("openingForeign")):value.startsWith("openingFunctional")?other.some(x=>x.startsWith("openingFunctional")):value.startsWith("closingForeign")?other.some(x=>x.startsWith("closingForeign")):value.startsWith("closingFunctional")?other.some(x=>x.startsWith("closingFunctional")):value.startsWith("foreign")?other.some(x=>x.startsWith("foreign")):value.startsWith("functional")?other.some(x=>x.startsWith("functional")):false)&&other.some(value=>usedRoles.has(value))));
  const controls=props.inspection.headers.map(header=>{const current=mappedRole(header);return <label className="dt-header-control" key={header}><select className={current&&!locked(current)?"mapped":undefined} disabled={props.reviewBusy||Boolean(current&&locked(current))} value={current} onChange={e=>update(header,e.target.value)}><option value="">—</option>{roles.map(([role,label])=>{const taken=usedRoles.has(role)&&role!==current;const roleLocked=locked(role);return <option key={role} value={role} className={taken||roleLocked?"dt-role-taken":undefined}>{label}{taken?"（已用）":roleLocked?"（已停用）":""}</option>})}</select></label>});
  return <section className="kz-card kz-preview"><h2>{props.title}</h2><p>{props.inspection.rowCount} 行 × {props.inspection.headers.length} 列</p>{props.missing.length>0&&<p className="fa-missing-hint">尚未映射：{props.missing.join("、")}</p>}<DataTable columns={props.inspection.headers} rows={props.inspection.preview} headerControls={controls} maxHeight={380}/></section>;
}
function FxResult({result}:{result:Record<string,unknown>}){const summary=(result.summary??{}) as Record<string,unknown>;const outputs=(result.outputPaths??[]) as string[];const amount=(value:unknown)=>{const number=Number(value??0);return (Object.is(number,-0)||Math.abs(number)<0.005?0:number).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2})};return <>{summary.needsZeroResultReview&&<p className="fa-missing-hint">已读取外币凭证，但没有事件进入自动测算；相关金额已归入待复核项目，不会再被当作正常“0”。</p>}<div className="fx-result"><div><span>自动测算合计</span><strong>{amount(summary.automaticMeasuredFxGainLoss)}</strong></div><div><span>待复核项目</span><strong>{amount(summary.pendingReviewAmount)}</strong></div><div><span>暂估审计汇兑损益</span><strong>{amount(summary.auditFxGainLoss)}</strong></div><div><span>TB财务费用－汇兑损益</span><strong>{summary.tbFxGainLoss==null?"未识别":amount(summary.tbFxGainLoss)}</strong></div><div><span>测算与TB差异</span><strong>{summary.difference==null?"无法比较":amount(summary.difference)}</strong></div><div><span>已实现／未实现／待复核</span><strong>{amount(summary.realizedGainLoss)}／{amount(summary.unrealizedAdjustment)}／{String(summary.pendingReviewCount??0)}项</strong></div>{outputs.map(path=><Button key={path} variant="secondary" onClick={()=>void openOutput(path)}>打开Excel底稿</Button>)}</div></>}
function suggestRole(account:string){if(/银行|现金|bank|cash|\b(boc|boa|hsbc|cmb)\b/i.test(account))return"cash";if(/应收|receivable|accts?\s*rec|a\/r|interco cust/i.test(account))return"monetary_asset";if(/应付|借款|payable|accts?\s*pay|a\/p|loan|interco vend/i.test(account))return"monetary_liability";if(/汇兑|汇率|exchange\s*(gain|loss)|fx\s*(gain|loss)|cur\s*remeasur\s*g\/l|currency\s*remeasur|fx\s*transl\s*cogs|foreign\s*exch|forex\s*g\/l/i.test(account))return"fx_gain_loss";if(/预付|预收|prepaid|advance/i.test(account))return"review";return"unassigned"}
function fileName(path:string){return path.split(/[\\/]/).pop()??path}
function errorText(value:unknown){if(typeof value==="string")return value;if(value&&typeof value==="object"){const v=value as Record<string,unknown>;return String(v.userMessage??v.message??v.detail??"处理失败，请重试。")}return"处理失败，请重试。"}
