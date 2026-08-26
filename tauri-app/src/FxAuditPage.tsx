import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolManifest, JobEvent } from "./types";
import { engineCall, jobCancel, jobStart, listenPositionedFileDrops, listenJobEvents, openOutput, pickPath } from "./api";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { missingGoldIdentity } from "@/ledgerMapping";
import { MappingPanel } from "@/components/MappingPanel";
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
  foreignCurrencyNeedsConfirmation?: boolean;
  foreignCurrencyCandidates?: Array<{column:string;confidence:number;foreignCurrencies:string[]}>;
  uniformCurrency?: string|null;
  sampledPreview?: boolean;
};
type SourceClassification = {kind:"je"|"tb";confidence:number;needsLlm:boolean;scores:{je:number;tb:number};reasons:string[];headers:string[];preview:string[][];sheet:string;headerRow:number;headerDepth:number};
type VoucherClassification = "已实现汇兑损益"|"未实现汇兑损益"|"待确认";
type ClassificationControl = {voucherId:string;date?:string;voucherType?:string;systemCategory?:string;reviewReason?:string;bookedFxGainLoss?:number;classification:VoucherClassification;measurementStatus?:string;patternKey?:string;patternLabel?:string;debitAccounts?:string[];creditAccounts?:string[];summary?:string};
type VoucherDetail = {accountCode?:string;accountNameOriginal?:string;accountNameChinese?:string};

const JE_LABELS: Record<string, string> = {
  id:"凭证识别字段",voucherType:"凭证类型",entity:"公司/核算主体",date:"记账日期",
  accountCode:"科目编码",accountName:"科目名称",
  // 币种分两列，与科目余额表同口径：原币币种逐行可变，本位币币种整列同值。
  currency:"原币币种",functionalCurrency:"本位币币种",
  summary:"摘要",auxiliary:"辅助核算",
  direction:"借贷方向（原币与本位币共用）",
  foreignAmount:"原币净额",foreignDebit:"原币借方",foreignCredit:"原币贷方",
  functionalAmount:"本位币净额",functionalDebit:"本位币借方",functionalCredit:"本位币贷方",
};
const TB_LABELS: Record<string, string> = {
  entity:"公司/核算主体",accountCode:"科目编码",accountName:"科目名称",
  currency:"原币币种列",currencyText:"币种线索文本",
  auxiliary:"辅助核算",functionalCurrency:"本位币币种",
  openingDirection:"期初方向",closingDirection:"期末方向",
  openingFunctionalAmount:"期初本位币净额",openingFunctionalDebit:"期初本位币借方",
  openingFunctionalCredit:"期初本位币贷方",
  openingForeignAmount:"期初原币净额",openingForeignDebit:"期初原币借方",
  openingForeignCredit:"期初原币贷方",
  closingFunctionalAmount:"期末本位币净额",closingFunctionalDebit:"期末本位币借方",
  closingFunctionalCredit:"期末本位币贷方",
  closingForeignAmount:"期末原币净额",closingForeignDebit:"期末原币借方",
  closingForeignCredit:"期末原币贷方",
  ytdFunctionalDebit:"本年累计本位币借方",ytdFunctionalCredit:"本年累计本位币贷方",
  ytdForeignDebit:"本年累计原币借方",ytdForeignCredit:"本年累计原币贷方",
  periodFunctionalDebit:"本期本位币借方",periodFunctionalCredit:"本期本位币贷方",
};

/**
 * 下拉框的分组。必填还是可选、要不要选一种记法，由**组标题**统一交代——
 * 原先每一项后面都挂「（二选一）」，满屏括号反而看不出哪几项是一伙的。
 *
 * 分组与 TB 六型／JE 三型对应：期初、期末各是一个槽，槽内几种记法任选其一。
 */
const ROLE_GROUPS: Record<"je"|"tb", Array<{title:string; roles:string[]}>> = {
  je: [
    {title:"科目与主体　科目编码必填", roles:["entity","accountCode","accountName","summary","auxiliary","voucherType"]},
    {title:"凭证与日期　必填", roles:["id","date"]},
    {title:"币种　原币币种必填，本位币币种可选", roles:["currency","functionalCurrency"]},
    {title:"本位币金额　必填，三种记法选一种", roles:["functionalAmount","functionalDebit","functionalCredit","direction"]},
    {title:"原币金额　必填，三种记法选一种", roles:["foreignAmount","foreignDebit","foreignCredit"]},
  ],
  tb: [
    {title:"科目与主体　科目编码必填", roles:["entity","accountCode","accountName","auxiliary"]},
    {title:"币种　币种列与线索文本至少给一个", roles:["currency","currencyText","functionalCurrency"]},
    {title:"期初余额　必填，三种记法选一种", roles:["openingFunctionalAmount","openingFunctionalDebit","openingFunctionalCredit","openingDirection","openingForeignAmount","openingForeignDebit","openingForeignCredit"]},
    {title:"期末余额　必填，三种记法选一种", roles:["closingFunctionalAmount","closingFunctionalDebit","closingFunctionalCredit","closingDirection","closingForeignAmount","closingForeignDebit","closingForeignCredit"]},
    {title:"本年累计发生额　本位币借贷必填", roles:["ytdFunctionalDebit","ytdFunctionalCredit","ytdForeignDebit","ytdForeignCredit"]},
    {title:"本期发生额　可选，表里只给本期时用", roles:["periodFunctionalDebit","periodFunctionalCredit"]},
  ],
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
export async function fxRunMappingReviews<T>(run:(kind:"je"|"tb")=>Promise<T>):Promise<[T,T]>{const [je,tb]=await Promise.all([run("je"),run("tb")]);return [je,tb]}
export function fxMergeJobResult(current:Record<string,unknown>|undefined,next:Record<string,unknown>){return{...current,...next}}
export function fxApplyJobResult(current:Record<string,unknown>|undefined,next:unknown,method:"fx.preview"|"fx.export"){
  if(!next||typeof next!=="object"||Array.isArray(next))return current;
  return method==="fx.export"?fxMergeJobResult(current,next as Record<string,unknown>):next as Record<string,unknown>;
}
export function fxPreviewTokenFor(method:"fx.preview"|"fx.export",result:Record<string,unknown>|undefined){
  const token=result?.previewToken;
  return method==="fx.export"&&typeof token==="string"&&token.trim()?token:undefined;
}
export function fxMissingRequired(kind:"je"|"tb",mapping:Record<string,string|string[]>,_hasJe:boolean,fixedEntity:string):string[]{return [...new Set(fxMissingRaw(kind,mapping,_hasJe,fixedEntity))]}
function fxMissingRaw(kind:"je"|"tb",mapping:Record<string,string|string[]>,_hasJe:boolean,fixedEntity:string):string[]{const has=(role:string)=>{const value=mapping[role];return Array.isArray(value)?value.some(item=>item.trim()):Boolean(value?.trim())};const scheme=(prefix:string)=>has(`${prefix}Amount`)||(has(`${prefix}Debit`)&&has(`${prefix}Credit`))||(has(`${prefix}Amount`)&&(has("direction")||has(`${prefix}Direction`)));const missing:string[]=missingGoldIdentity(kind,role=>role==="accountCode"||role==="accountName"?has(role)||has("account"):has(role));if(!has("entity")&&!fixedEntity.trim())missing.push("公司/核算主体（或固定主体）");if(kind==="je"){if(!has("currency"))missing.push("原币币种");if(!scheme("foreign"))missing.push("原币金额方案");if(!scheme("functional"))missing.push("本位币金额方案")}else{if(!has("currency")&&!has("currencyText"))missing.push("币种列或币种线索文本");if(!scheme("openingForeign")&&!scheme("openingFunctional"))missing.push("期初原币或本位币余额");if(!scheme("closingForeign")&&!scheme("closingFunctional"))missing.push("期末原币或本位币余额");
// 本年累计借/贷是 TB 六型的必填组（整组匹配缺一不可）；表里只有本期
// 发生时本期借/贷作次选兜底，两组都不齐就提示。
const ytdOk=has("ytdFunctionalDebit")&&has("ytdFunctionalCredit");const periodOk=has("periodFunctionalDebit")&&has("periodFunctionalCredit");if(!ytdOk&&!periodOk)missing.push("本年累计（或本期）借/贷方发生额")}return missing}

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
  const [manualClassifications,setManualClassifications] = useState<Record<string,VoucherClassification>>({});
  const [classificationDrafts,setClassificationDrafts] = useState<Record<string,VoucherClassification>>({});
  const [tbCurrencyConfirmed,setTbCurrencyConfirmed] = useState(false);
  const [alignment,setAlignment] = useState<string[]>([]);
  const [busy,setBusy] = useState(false); const [error,setError] = useState("");
  const [reviewing,setReviewing] = useState<Record<"je"|"tb",boolean>>({je:false,tb:false});
  const [reviewStatus,setReviewStatus] = useState<Record<string,string>>({});
  const [job,setJob] = useState<JobEvent>(); const [result,setResult] = useState<Record<string,unknown>>();
  const [outputPath,setOutputPath] = useState(""); const [sourceStatus,setSourceStatus]=useState(""); const [activeStage,setActiveStage]=useState<"fx.preview"|"fx.export">(); const [completedStage,setCompletedStage]=useState<"fx.preview"|"fx.export">(); const activeJob=useRef(""); const activeJobMethod=useRef<"fx.preview"|"fx.export">("fx.preview"); const uploadDropRef=useRef<HTMLDivElement>(null);
  const allowedModes=fxAllowedModes(Boolean(jePath),Boolean(tbPath));
  const entities=useMemo(()=>[...new Set([...(je?.entities??[]),...(tb?.entities??[])])],[je,tb]);
  const accounts=useMemo(()=>[...new Set([...(je?.accounts??[]),...(tb?.accounts??[])])],[je,tb]);
  const reviewingAny=reviewing.je||reviewing.tb;
  const requiredMappingsMissing=[...(je&&mode!=="unrealized"?fxMissingRequired("je",jeMapping,true,fixedEntity):[]),...(tb&&mode!=="realized"?fxMissingRequired("tb",tbMapping,Boolean(je),fixedEntity):[])];
  const defaultFunctionalCurrency=tb?.uniformCurrency||"CNY";
  const currencyConfirmationMissing=Boolean(tb&&mode!=="realized"&&tb.foreignCurrencyNeedsConfirmation&&!tbCurrencyConfirmed);

  useEffect(()=>setMode(fxDefaultMode(Boolean(jePath),Boolean(tbPath))),[jePath,tbPath]);
  useEffect(()=>setEntityCurrencies(v=>Object.fromEntries(entities.map(e=>[e,v[e]??tb?.uniformCurrency??"CNY"]))),[entities,tb]);
  useEffect(()=>{if(entities.length===1)setFixedEntity(entities[0])},[entities]);
  useEffect(()=>setAccountRoles(v=>Object.fromEntries(accounts.map(account=>{const direct=suggestRole(account);const code=account.trim().split(/\s+/)[0];const related=direct==="unassigned"?accounts.map(suggestRole).find((role,index)=>role!=="unassigned"&&accounts[index].trim().split(/\s+/)[0]===code):undefined;return[account,v[account]??related??direct]}))),[accounts]);
  useEffect(()=>{
    const drops=listenPositionedFileDrops(({paths,x,y})=>{const rect=uploadDropRef.current?.getBoundingClientRect();if(!rect||x<rect.left||x>rect.right||y<rect.top||y>rect.bottom)return;void classifyAndInspect(paths);});
    const jobs=listenJobEvents(event=>{if(event.jobId!==activeJob.current)return;setJob(event);if(event.result)setResult(current=>fxApplyJobResult(current,event.result,activeJobMethod.current));if(event.phase==="completed"){setBusy(false);setActiveStage(undefined);if(event.result)setCompletedStage(activeJobMethod.current);else{setCompletedStage(undefined);setError("任务进程已结束，但系统未收到测算结果。请重新测算；若再次出现，结果传输诊断会保留此异常。")}}else if(event.phase==="failed"||event.phase==="cancelled"){setBusy(false);setActiveStage(undefined);setCompletedStage(undefined);const p=event.result as {error?:{userMessage?:string}}|undefined;setError(p?.error?.userMessage??event.message)}});
    return()=>{void drops.then(x=>x());void jobs.then(x=>x())};
  },[]);

  async function browse(){const picked=await pickPath("files","选择JE或TB文件",["xlsx","xls","xlsm","csv","txt","tsv","parquet"]);if(!picked)return;void classifyAndInspect(Array.isArray(picked)?picked:[picked])}
  async function classifyAndInspect(paths:string[]){const files=paths.filter(p=>/\.(xlsx?|xlsm|csv|txt|tsv|parquet)$/i.test(p));if(!files.length)return;setBusy(true);setError("");setSourceStatus("正在识别文件类型、表头和字段…");const failures:string[]=[];try{for(const path of files){try{const scripted=await engineCall("fx.classify_source",{source:{inputPath:path,sheet:"",headerRow:0,headerDepth:0}}) as SourceClassification;let kind=scripted.kind;let source="脚本";if(scripted.needsLlm){const llm=await engineCall("fx.classify_source_llm",{payload:{path,headers:scripted.headers,sampleRows:scripted.preview,scriptScores:scripted.scores}}) as {kind?:"je"|"tb"};if(llm.kind)kind=llm.kind;source="脚本无法确定，已由LLM"}const response=await engineCall("fx.inspect_"+kind,{source:{inputPath:path,sheet:scripted.sheet,headerRow:scripted.headerRow,headerDepth:scripted.headerDepth}}) as Inspection;applyInspection(kind,path,response);setSourceStatus(`${files.length} 个文件已识别；${kind.toUpperCase()} 由${source}判定。`)}catch(e){failures.push(`${fileName(path)}：${errorText(e)}`)}}if(failures.length)setError(failures.join("；"))}finally{setBusy(false)}}
  function applyInspection(kind:"je"|"tb",path:string,response:Inspection){if(response.suggestedBalanceSheetDate)setReportEnd(response.suggestedBalanceSheetDate);else if(response.dataYears?.length===1)setReportEnd(`${response.dataYears[0]}-12-31`);setReviewStatus(v=>({...v,[kind]:""}));if(kind==="je"){setManualClassifications({});setClassificationDrafts({});setJePath(path);setJe(response);setJeMapping(response.suggestedMapping)}else{setTbPath(path);setTb(response);setTbMapping(response.suggestedMapping);setTbCurrencyConfirmed(!response.foreignCurrencyNeedsConfirmation)}}
  async function inspect(kind:"je"|"tb",over?:Partial<{sheet:string;headerRow:number;headerDepth:number}>){
    setBusy(true);setError("");try{const current=kind==="je"?je:tb;const response=await engineCall("fx.inspect_"+kind,{source:{inputPath:kind==="je"?jePath:tbPath,sheet:over?.sheet??current?.sheet??"",headerRow:over?.headerRow??current?.headerRow??0,headerDepth:over?.headerDepth??current?.headerDepth??0}}) as Inspection;
      applyInspection(kind,kind==="je"?jePath:tbPath,response)
    }catch(e){setError(errorText(e))}finally{setBusy(false)}
  }
  async function review(kind:"je"|"tb",clearError=true):Promise<Record<string,string|string[]>>{
    const inspection=kind==="je"?je:tb;const base=kind==="je"?jeMapping:tbMapping;
    if(!inspection)return base;
    if(clearError)setError("");
    setReviewing(v=>({...v,[kind]:true}));setReviewStatus(v=>({...v,[kind]:"正在复核字段映射…"}));
    try{
      const response=await engineCall("fx.review_"+kind+"_mapping",{payload:{headers:inspection.headers,sampleRows:inspection.preview,hardcodedCandidates:inspection.mappingCandidates,currentMapping:base}}) as {changes?:Array<{role:string;suggestedColumn:string;confidence:number}>};
      const labels=kind==="je"?JE_LABELS:TB_LABELS;const setter=kind==="je"?setJeMapping:setTbMapping;
      const next={...base};let applied=0;
      for(const c of response.changes??[]){
        const candidate=inspection.mappingCandidates.find(x=>x.role===c.role)?.candidates.find(x=>x.column===c.suggestedColumn);
        const duplicate=Object.entries(next).some(([role,column])=>role!==c.role&&column===c.suggestedColumn);
        if(c.confidence>=.6&&c.role in labels&&inspection.headers.includes(c.suggestedColumn)&&(candidate?.conflictTerms.length??0)===0&&!duplicate){next[c.role]=c.suggestedColumn;applied+=1}
      }
      setter(next);
      setReviewStatus(v=>({...v,[kind]:applied?`复核完成，已应用 ${applied} 项建议。`:"复核完成，当前映射无需调整。"}));
      return next;
    }catch(e){
      setReviewStatus(v=>({...v,[kind]:"复核失败，可继续手工映射。"}));
      setError(current=>[current,errorText(e)+" 可继续手工映射。"].filter(Boolean).join("；"));
      return base;
    }finally{setReviewing(v=>({...v,[kind]:false}))}
  }

  async function reviewOne(kind:"je"|"tb"){
    setAlignment([]);
    const next=await review(kind);
    if(je&&tb)await checkAlignment(kind==="je"?next:jeMapping,kind==="tb"?next:tbMapping);
  }
  async function reviewBoth(){
    if(!je||!tb)return;setError("");setAlignment([]);
    const [nextJe,nextTb]=await fxRunMappingReviews(kind=>review(kind,false));
    await checkAlignment(nextJe,nextTb);
  }
  // 脚本和LLM都可能把TB的科目编码映射到科目名称列。复核结束后立刻拿两边的
  // 真实取值交叉核对，把“口径对不上”当场摆出来，而不是等到测算失败。
  async function checkAlignment(nextJe:Record<string,string|string[]>,nextTb:Record<string,string|string[]>){
    if(!je||!tb)return;
    try{
      const response=await engineCall("fx.check_mapping_alignment",{
        jeSource:{inputPath:jePath,sheet:je.sheet,headerRow:je.headerRow,headerDepth:je.headerDepth},jeMapping:nextJe,
        tbSource:{inputPath:tbPath,sheet:tb.sheet,headerRow:tb.headerRow,headerDepth:tb.headerDepth},tbMapping:nextTb
      }) as {errors?:string[];warnings?:string[];fix?:{jeMapping?:Record<string,string>;tbMapping?:Record<string,string>}|null};
      const jeFix=response.fix?.jeMapping;const tbFix=response.fix?.tbMapping;
      if(jeFix&&Object.keys(jeFix).length)setJeMapping(current=>({...current,...jeFix}));
      // 科目名称改用原本当币种线索的那一列时，两个角色共用这一列即可——
      // 科目名称里写着账户币种正是币种线索的来源，删掉线索角色反而会让
      // 「尚未映射：币种列或币种线索文本」凭空冒出来。
      if(tbFix&&Object.keys(tbFix).length)setTbMapping(current=>({...current,...tbFix}));
      setAlignment([...(response.errors??[]),...(response.warnings??[])]);
    }catch(e){setAlignment([`口径核对未能完成：${errorText(e)}`])}
  }

  function payload(method:"fx.preview"|"fx.export",overrides=manualClassifications){const effectiveEntities=entities.length?entityCurrencies:{[fixedEntity]:entityCurrencies[fixedEntity]??defaultFunctionalCurrency};const start=fxReportStart(reportEnd);const snapshot=result?.rateSnapshot as {startDate?:string;endDate?:string}|undefined;const reusableSnapshot=snapshot?.startDate===start&&snapshot?.endDate===reportEnd?snapshot:undefined;const cachedTranslations=(result?.accountTranslations??{}) as Record<string,string>;const previewToken=fxPreviewTokenFor(method,result);return{mode,reportStart:start,reportEnd,fixedEntity,tbForeignCurrencyConfirmed:!tb?.foreignCurrencyNeedsConfirmation||tbCurrencyConfirmed,...(je?{jeSource:{inputPath:jePath,sheet:je.sheet,headerRow:je.headerRow,headerDepth:je.headerDepth},jeMapping}:{}),...(tb?{tbSource:{inputPath:tbPath,sheet:tb.sheet,headerRow:tb.headerRow,headerDepth:tb.headerDepth},tbMapping}:{}),entityCurrencies:effectiveEntities,accountRoles,manualClassifications:overrides,translateTbAccountNames:true,...(Object.keys(cachedTranslations).length?{accountTranslations:cachedTranslations}:{}),...(reusableSnapshot?{rateSnapshot:reusableSnapshot}:{}),...(previewToken?{previewToken}:{}),...(outputPath?{outputPath}:{})}}
  async function run(method:"fx.preview"|"fx.export",overrides=manualClassifications){setError("");if(!reportEnd)return setError("请选择资产负债表日。");if((mode==="realized"||mode==="combined")&&!je)return setError("已实现测算需先上传并识别JE。");if((mode==="unrealized"||mode==="combined")&&!tb)return setError("未实现测算需先上传并识别TB。");const jeMissing=je&&mode!=="unrealized"?fxMissingRequired("je",jeMapping,true,fixedEntity):[];if(jeMissing.length)return setError(`JE尚未映射：${jeMissing.join("、")}。请先在预览表头完成字段映射。`);const tbMissing=tb&&mode!=="realized"?fxMissingRequired("tb",tbMapping,Boolean(je),fixedEntity):[];if(tbMissing.length)return setError(`TB尚未映射：${tbMissing.join("、")}。请先在预览表头完成字段映射。`);if(currencyConfirmationMissing)return setError("TB检测到多个外币币种候选，请确认系统预选的外币币种列。");if(entities.some(e=>!entityCurrencies[e]))return setError("请为每个公司选择ISO本位币。");setBusy(true);setJob(undefined);setCompletedStage(undefined);setActiveStage(method);activeJobMethod.current=method;try{activeJob.current=await jobStart(method,payload(method,overrides))}catch(e){setBusy(false);setActiveStage(undefined);setError(errorText(e))}}
  function stageVoucherClassifications(voucherIds:string[],classification:VoucherClassification){setClassificationDrafts(current=>{const next={...current};for(const voucherId of voucherIds)next[voucherId]=classification;return next})}
  async function recalculateClassifications(){const next={...manualClassifications,...classificationDrafts};setManualClassifications(next);await run("fx.preview",next)}

  return <main className="tool-page fx-page">
    <PageHeader eyebrow="外币审计" title={tool.name} detail="按凭证识别结算事件，按官方人民币汇率中间价重算，并生成可追踪Excel底稿。" />
    <ErrorBox error={error} onDismiss={()=>setError("")}/>
    <section className="fx-mode-bar">{([["realized","仅已实现"],["unrealized","仅未实现"],["combined","已实现＋未实现"]] as Array<[Mode,string]>).map(([value,label])=><button key={value} type="button" className={mode===value?"active":""} disabled={!allowedModes.includes(value)} onClick={()=>setMode(value)}>{label}</button>)}</section>
    <Card><CardHeader><CardTitle>上传审计数据</CardTitle></CardHeader><CardContent><p className="fx-hint">JE和TB使用同一入口；系统先按表格结构自动识别，无法确定时再调用LLM。</p><FileDropInput containerRef={uploadDropRef} value={[jePath&&`JE：${fileName(jePath)}`,tbPath&&`TB：${fileName(tbPath)}`].filter(Boolean).join("；")} disabled={busy||reviewingAny} placeholder="拖放或选择JE、TB文件（可同时选择）" onBrowse={()=>void browse()} onDragStateChange={()=>{}} onClear={()=>{setJePath("");setTbPath("");setJe(undefined);setTb(undefined);setJeMapping({});setTbMapping({});setManualClassifications({});setClassificationDrafts({});setSourceStatus("")}}/>{sourceStatus&&<p className="fx-source-status" aria-live="polite">{sourceStatus}</p>}</CardContent></Card>
    <div className="fx-source-grid">
      {jePath&&<SourceCard title="已识别：JE 凭证明细" hint="已实现测算及月度未实现重估识别的数据源" path={jePath} inspection={je} disabled={busy||reviewingAny} onClear={()=>{setJePath("");setJe(undefined);setJeMapping({})}} onInspect={()=>void inspect("je")} onHeaderChange={(headerRow,headerDepth,sheet)=>void inspect("je",{headerRow,headerDepth,sheet})}/>}
      {tbPath&&<SourceCard title="已识别：TB 科目余额表" hint="未实现测算和财务费用—汇兑损益勾稽的数据源" path={tbPath} inspection={tb} disabled={busy||reviewingAny} onClear={()=>{setTbPath("");setTb(undefined);setTbMapping({})}} onInspect={()=>void inspect("tb")} onHeaderChange={(headerRow,headerDepth,sheet)=>void inspect("tb",{headerRow,headerDepth,sheet})}/>}
    </div>
    {je&&tb&&<section className="fx-review-all" aria-labelledby="fx-review-all-title"><div><h2 id="fx-review-all-title">字段映射联合复核</h2><p>点击一次，同时启动JE和TB两个独立LLM复核任务。</p><div className="fx-review-states" aria-live="polite"><span className={reviewing.je?"running":""}>JE：{reviewStatus.je||"等待复核"}</span><span className={reviewing.tb?"running":""}>TB：{reviewStatus.tb||"等待复核"}</span></div></div><Button disabled={busy||reviewingAny} onClick={()=>void reviewBoth()}>{reviewingAny?"JE与TB复核中…":"同时复核 JE 与 TB"}</Button></section>}
    {je&&tb&&alignment.length>0&&<section className="kz-card fx-alignment" aria-live="polite"><h2>TB 与 JE 口径核对</h2><ul>{alignment.map(item=><li key={item}>{item}</li>)}</ul></section>}
    <div className="fx-preview-stack">
      {je&&<><section className="kz-card"><h2>JE 字段映射复核</h2><p aria-live="polite">{reviewing.je?"正在复核字段映射；复核期间字段映射暂时锁定。":reviewStatus.je||"脚本已自动映射，可直接核对或使用LLM复核。"}</p>{je.sampledPreview&&<p className="fx-warning">文件较大，字段识别只读取了开头若干行；资产负债表日不再自动带出，请手工确认。正式测算仍读取全部数据。</p>}<div className="kz-actions"><Button variant="secondary" disabled={busy||reviewing.je} onClick={()=>void reviewOne("je")}>{reviewing.je?"LLM复核中…":"单独复核 JE"}</Button></div></section><FxPreview title="JE 文件预览" kind="je" inspection={je} mapping={jeMapping} labels={JE_LABELS} missing={fxMissingRequired("je",jeMapping,true,fixedEntity)} onMappingChange={setJeMapping} reviewBusy={reviewing.je}/></>}
      {tb&&<><section className="kz-card"><h2>TB 字段映射复核</h2><p aria-live="polite">{reviewing.tb?"正在复核字段映射；复核期间字段映射暂时锁定。":reviewStatus.tb||"脚本已自动映射，可直接核对或使用LLM复核。"}</p>{tb.foreignCurrencyNeedsConfirmation&&<div className="fx-currency-confirm"><div><strong>检测到多个外币币种候选</strong><p>系统已预选“{String(tbMapping.currency??"—")}”。候选：{(tb.foreignCurrencyCandidates??[]).map(item=>`${item.column}（${item.foreignCurrencies.join("/")}）`).join("、")}。请核对预览后确认。</p></div><Button variant="secondary" disabled={busy||reviewing.tb||tbCurrencyConfirmed} onClick={()=>setTbCurrencyConfirmed(true)}>{tbCurrencyConfirmed?"已确认外币列":"确认当前外币列"}</Button></div>}<div className="kz-actions"><Button variant="secondary" disabled={busy||reviewing.tb} onClick={()=>void reviewOne("tb")}>{reviewing.tb?"LLM复核中…":"单独复核 TB"}</Button></div></section><FxPreview title="TB 文件预览" kind="tb" inspection={tb} mapping={tbMapping} labels={TB_LABELS} missing={fxMissingRequired("tb",tbMapping,Boolean(je),fixedEntity)} onMappingChange={action=>{setTbCurrencyConfirmed(false);setTbMapping(action)}} reviewBusy={reviewing.tb}/></>}
    </div>
    {(je||tb)&&<div className="fx-source-grid">
      <Card><CardHeader><CardTitle>公司本位币</CardTitle></CardHeader><CardContent className="fx-list">{tb?.uniformCurrency&&<p className="fx-hint">TB 的币种列整列都是 {tb.uniformCurrency}，已按主体本位币预填；账户币种改从科目名称/文本识别。若该列确实是交易币种，请在此改回。</p>}{entities.length?entities.map(entity=><label key={entity}><span>{entity}</span><input value={entityCurrencies[entity]??defaultFunctionalCurrency} maxLength={3} onChange={e=>setEntityCurrencies(v=>({...v,[entity]:e.target.value.toUpperCase()}))}/></label>):<><label><span>文件无主体列，固定主体</span><input value={fixedEntity} onChange={e=>setFixedEntity(e.target.value)}/></label><label><span>本位币</span><input value={entityCurrencies[fixedEntity]??defaultFunctionalCurrency} maxLength={3} onChange={e=>setEntityCurrencies(v=>({...v,[fixedEntity]:e.target.value.toUpperCase()}))}/></label></>}</CardContent></Card>
      <Card><CardHeader><CardTitle>高级设置</CardTitle></CardHeader><CardContent><details><summary>科目分类（通常无需修改）</summary><div className="fx-list fx-accounts">{accounts.map(account=><label key={account}><span title={account}>{account}</span><select value={accountRoles[account]??"unassigned"} onChange={e=>setAccountRoles(v=>({...v,[account]:e.target.value}))}>{ROLE_OPTIONS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>)}</div></details></CardContent></Card>
    </div>}
    <Card><CardHeader><CardTitle>测算与底稿</CardTitle></CardHeader><CardContent>
      <div className="fx-run-grid"><label>资产负债表日<input type="date" value={reportEnd} onChange={e=>setReportEnd(e.target.value)}/></label><label>输出文件<input value={outputPath} readOnly placeholder="默认保存到源文件目录"/></label><Button variant="secondary" onClick={async()=>{const path=await pickPath("save","保存审计底稿",["xlsx"],"汇兑损益测算.xlsx");if(typeof path==="string")setOutputPath(path)}}>选择位置</Button></div>
      <p className="fx-rate-note">汇率由系统从官方来源获取，非公布日向前取最近公布日；用户不可手工改写。</p>
      <p className="fx-rate-note">全局LLM启用时，仅发送TB科目代码和英文科目名称用于中文翻译；底稿同时保留原始名称。未启用或翻译失败时只输出原始名称。</p>
      <p className="fx-stage-note">“测算预览”会执行完整汇兑损益测算并在下方展示结果；修改凭证分类后点击“重新测算”。“生成Excel底稿”只生成并保存当前口径的底稿，不会清空已显示的预览结果。</p>
      <div className="fx-actions"><Button variant="secondary" disabled={busy||reviewingAny||requiredMappingsMissing.length>0||currencyConfirmationMissing} onClick={()=>void run("fx.preview")}>{activeStage==="fx.preview"?"测算中…":"测算预览"}</Button><Button variant="secondary" disabled={busy||reviewingAny||!je||!result||requiredMappingsMissing.length>0||currencyConfirmationMissing} onClick={()=>void recalculateClassifications()}>{activeStage==="fx.preview"&&busy?"重新测算中…":"重新测算"}</Button><Button disabled={busy||reviewingAny||!result||requiredMappingsMissing.length>0||currencyConfirmationMissing} onClick={()=>void run("fx.export")}>{activeStage==="fx.export"?"正在生成底稿…":"生成Excel底稿"}</Button></div>
      {activeJobMethod.current==="fx.export"?(busy?<div className="fx-export-stage" role="status"><strong>正在生成Excel底稿</strong><span>测算预览已经完成；当前步骤仅整理并保存底稿，页面上的测算结果会继续保留。</span></div>:completedStage==="fx.export"&&outputsFrom(result).length>0&&<p className="fx-export-complete" role="status">Excel底稿已生成；测算预览结果已保留在下方。</p>):job&&<JobProgress job={job} onCancel={busy?(id)=>void jobCancel(id):undefined}/>}
      {result&&<FxResult result={result} busy={busy} classificationDrafts={classificationDrafts} onClassificationChange={stageVoucherClassifications} onRecalculate={recalculateClassifications}/>}
    </CardContent></Card>
  </main>;
}

function SourceCard(props:{title:string;hint:string;path:string;inspection?:Inspection;disabled:boolean;onClear:()=>void;onInspect:()=>void;onHeaderChange:(row:number,depth:number,sheet:string)=>void}){
  return <Card><CardHeader><CardTitle>{props.title}</CardTitle></CardHeader><CardContent><p className="fx-hint">{props.hint}</p><div className="fx-detected-file"><span title={props.path}>{props.path}</span><button type="button" disabled={props.disabled} onClick={props.onClear}>移除</button></div>
    {props.path&&!props.inspection&&<Button variant="secondary" disabled={props.disabled} onClick={props.onInspect}>自动识别表头和字段</Button>}
    {props.inspection&&<div className="fx-source-meta"><span>{props.inspection.rowCount.toLocaleString()} 行</span><label>Sheet<select value={props.inspection.sheet} onChange={e=>props.onHeaderChange(0,0,e.target.value)}>{props.inspection.sheets.length?props.inspection.sheets.map(s=><option key={s}>{s}</option>):<option>{props.inspection.sheet}</option>}</select></label><label>标题行<input type="number" min={1} value={props.inspection.headerRow} onChange={e=>props.onHeaderChange(Number(e.target.value),props.inspection!.headerDepth,props.inspection!.sheet)}/></label><label>表头层数<select value={props.inspection.headerDepth} onChange={e=>props.onHeaderChange(props.inspection!.headerRow,Number(e.target.value),props.inspection!.sheet)}><option value={1}>1层</option><option value={2}>2层</option></select></label>{props.inspection.headerDetection.needsConfirmation&&<strong className="fx-warning">标题候选得分接近，请确认标题行</strong>}</div>}
  </CardContent></Card>;
}
/** 唯一可以与别的角色共用一列的角色：科目名称里常常就写着账户币种。 */
export const CURRENCY_TEXT="currencyText";
/** 可以一个角色对应多列的角色。 */
const MULTI_COLUMN_ROLES=new Set(["id","accountName","auxiliary"]);

/**
 * 给某一列加上一个角色标记，返回新的映射。
 *
 * **一列只能承担一个正经语义，只有「币种线索文本」可以额外叠加**——
 * 科目名称里写着账户币种（`银行存款-中行朝阳支行美元户`）是实务常态，
 * 那一列既是科目名称也是币种线索；除此之外没有哪两个角色该共用一列，
 * 所以加别的角色时先把这一列原有的正经角色摘掉，只留住币种线索。
 */
export function fxAttachRole(
  mapping:Record<string,string|string[]>,
  header:string,
  role:string,
):Record<string,string|string[]>{
  const next={...mapping};
  if(!role)return next;
  if(role!==CURRENCY_TEXT){
    for(const [key,value] of Object.entries(next)){
      if(key===CURRENCY_TEXT)continue;
      if(Array.isArray(value)){if(value.includes(header))next[key]=value.filter(x=>x!==header);}
      else if(value===header)next[key]="";
    }
  }
  if(!MULTI_COLUMN_ROLES.has(role)){next[role]=header;return next;}
  const held=Array.isArray(next[role])?next[role]:next[role]?[String(next[role])]:[];
  if(!held.includes(header))next[role]=[...held,header];
  return next;
}

/** 摘掉某一列的某个角色标记。 */
export function fxDetachRole(
  mapping:Record<string,string|string[]>,
  header:string,
  role:string,
):Record<string,string|string[]>{
  const next={...mapping};
  const value=next[role];
  if(Array.isArray(value))next[role]=value.filter(x=>x!==header);
  else if(value===header)next[role]="";
  return next;
}

function FxPreview(props:{title:string;kind:"je"|"tb";inspection:Inspection;mapping:Record<string,string|string[]>;labels:Record<string,string>;missing:string[];onMappingChange:React.Dispatch<React.SetStateAction<Record<string,string|string[]>>>;reviewBusy:boolean}){
  const roles=Object.entries(props.labels);
  // 一列可以同时承担多个语义：科目名称里往往就写着账户币种
  // （`银行存款-中行朝阳支行美元户`），它既是科目名称也是币种线索文本。
  const mappedRoles=(header:string)=>roles.filter(([role])=>{const value=props.mapping[role];return Array.isArray(value)?value.includes(header):String(value??"")===header;}).map(([role])=>role);
  const attach=(header:string,role:string)=>props.onMappingChange(current=>fxAttachRole(current,header,role));
  const detach=(header:string,role:string)=>props.onMappingChange(current=>fxDetachRole(current,header,role));
  const usedRoles=new Set(roles.filter(([role])=>{const value=props.mapping[role];return Array.isArray(value)?value.length>0:Boolean(value&&String(value).trim())}).map(([role])=>role));
  const schemeGroups=[["foreignAmount","direction"],["foreignDebit","foreignCredit"],["functionalAmount","direction"],["functionalDebit","functionalCredit"],["openingForeignAmount"],["openingForeignDebit","openingForeignCredit"],["openingFunctionalAmount"],["openingFunctionalDebit","openingFunctionalCredit"],["closingForeignAmount"],["closingForeignDebit","closingForeignCredit"],["closingFunctionalAmount"],["closingFunctionalDebit","closingFunctionalCredit"]];
  const locked=(role:string)=>schemeGroups.some(group=>group.includes(role)&&schemeGroups.some(other=>other!==group&&group.some(value=>value.startsWith("openingForeign")?other.some(x=>x.startsWith("openingForeign")):value.startsWith("openingFunctional")?other.some(x=>x.startsWith("openingFunctional")):value.startsWith("closingForeign")?other.some(x=>x.startsWith("closingForeign")):value.startsWith("closingFunctional")?other.some(x=>x.startsWith("closingFunctional")):value.startsWith("foreign")?other.some(x=>x.startsWith("foreign")):value.startsWith("functional")?other.some(x=>x.startsWith("functional")):false)&&other.some(value=>usedRoles.has(value))));
  const groups=ROLE_GROUPS[props.kind];
  const grouped=new Set(groups.flatMap(group=>group.roles));
  const rest=roles.filter(([role])=>!grouped.has(role));
  /** 点一下就切换：没选上就加上，已选上就摘掉。 */
  const toggle=(header:string,role:string)=>{
    if(!role)return;
    if(mappedRoles(header).includes(role))detach(header,role);
    else attach(header,role);
  };
  const option=(role:string,label:string,held:string[])=>{
    const chosen=held.includes(role);
    const taken=usedRoles.has(role)&&!chosen;
    const roleLocked=locked(role);
    return <option key={role} value={role} className={taken||roleLocked?"dt-role-taken":undefined}>
      {chosen?`✓ ${label}`:label}
      {chosen?"（再点取消）":taken?"（已用）":roleLocked?"（与已选记法冲突）":""}
    </option>;
  };
  // 渲染交给共用面板；本工具的叠加规则（fxAttachRole/fxDetachRole）与
  // 记法冲突锁定留在这里，面板只负责把它们呈现出来。
  return <MappingPanel
    title={props.title}
    note={`${props.inspection.rowCount} 行 × ${props.inspection.headers.length} 列`}
    headers={props.inspection.headers}
    rows={props.inspection.preview}
    mapping={props.mapping}
    roles={roles}
    groups={[...groups,...(rest.length?[{title:"其他",roles:rest.map(([role])=>role)}]:[])]}
    multi={MULTI_COLUMN_ROLES}
    isLocked={locked}
    missing={props.missing}
    busy={props.reviewBusy}
    mode="toggle"
    rolesOf={mappedRoles}
    onToggle={toggle}
    onChange={()=>{/* toggle 模式下改动全部走 onToggle */}}
  />;
}
/** TB＋JE 余额滚动失配清单：**提示但不阻断**，逐条列出差在哪，用户自己判断。 */
function RollforwardIssues({validation}:{validation?:Record<string,unknown>}){
  const [open,setOpen]=useState(false);
  const issues=(validation?.issues??[]) as Array<Record<string,unknown>>;
  if(!issues.length)return null;
  const money=(value:unknown)=>new Intl.NumberFormat("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value??0));
  const unit=String(validation?.unit??"本位币");
  return <section className="fx-rollforward-issues">
    <div className="fx-rollforward-head">
      <div>
        <strong>TB ＋ JE 余额滚动有 {issues.length} 个账户对不上</strong>
        <small>按「期初 ＋ JE 发生额 ＝ 期末」逐个账户核对（{unit}口径）。测算照常完成，
          但按月推算余额依赖 JE 的完整性，这部分结果需要你自行判断可用性。</small>
      </div>
      <Button variant="secondary" size="sm" onClick={()=>setOpen(v=>!v)}>
        {open?"收起明细":"查看明细"}
      </Button>
    </div>
    {open&&<div className="fx-rollforward-table"><table>
      <thead><tr>
        <th>主体</th><th>科目</th><th>币种</th>
        <th>期初</th><th>JE 发生额</th><th>推算期末</th><th>TB 期末</th><th>差异</th>
      </tr></thead>
      <tbody>{issues.map((item,index)=><tr key={index}>
        <td>{String(item.entity??"")}</td>
        <td title={String(item.account??"")}>{String(item.account??"")}</td>
        <td>{String(item.currency??"")}</td>
        <td>{item.type?"—":money(item.opening)}</td>
        <td>{money(item.jeMovement)}</td>
        <td>{item.type?"—":money(item.derivedClosing)}</td>
        <td>{item.type?"—":money(item.tbClosing)}</td>
        <td className="fx-rollforward-diff">{item.type?String(item.type):money(item.difference)}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

function FxResult({result,busy,classificationDrafts,onClassificationChange,onRecalculate}:{result:Record<string,unknown>;busy:boolean;classificationDrafts:Record<string,VoucherClassification>;onClassificationChange:(voucherIds:string[],classification:VoucherClassification)=>void;onRecalculate:()=>Promise<void>}){
  const summary=(result.summary??{}) as Record<string,unknown>;const outputs=(result.outputPaths??[]) as string[];
  const controls=(result.classificationControls??[]) as ClassificationControl[];
  const details=(result.accountNameCatalog??result.voucherDetail??[]) as VoucherDetail[];
  const rollforward=(result.unrealizedBalanceRollforward??[]) as Array<Record<string,unknown>>;
  const clientRevaluations=(result.clientRevaluationVouchers??[]) as Array<Record<string,unknown>>;
  const unrealizedComparisonDifference=rollforward.reduce((sum,item)=>sum+Number(item.suggestedAdjustment??0),0);
  const groups=Object.values(controls.reduce<Record<string,{key:string;label:string;items:ClassificationControl[]}>>((all,item)=>{const key=item.patternKey||item.voucherId;const group=all[key]??{key,label:item.patternLabel||key,items:[]};group.items.push(item);all[key]=group;return all},{}));
  const accountNames=details.reduce<Record<string,{english:Set<string>;chinese:Set<string>}>>((all,item)=>{const code=String(item.accountCode??"").trim().toUpperCase();if(!code)return all;const names=all[code]??{english:new Set<string>(),chinese:new Set<string>()};const original=String(item.accountNameOriginal??"").trim();const chinese=String(item.accountNameChinese??"").trim();if(original){if(/[\u4e00-\u9fff]/.test(original))names.chinese.add(original);else names.english.add(original)}if(chinese)names.chinese.add(chinese);all[code]=names;return all},{});
  const accountSide=(title:string,codes:string[]|undefined)=><div className="fx-pattern-side"><strong>{title}</strong><div>{(codes??[]).map(code=>{const names=accountNames[code.trim().toUpperCase()];const english=names?[...names.english].join(" / "):"";const chinese=names?[...names.chinese].join(" / "):"";return <span key={code}><b>{code}</b><small>英文：{english||"—"}</small><small>中文：{chinese||"—"}</small></span>})}</div></div>;
  const amount=(value:unknown)=>{const number=Number(value??0);return new Intl.NumberFormat("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Object.is(number,-0)||Math.abs(number)<0.005?0:number)};
  const percent=(value:unknown)=>value==null?"无法计算":new Intl.NumberFormat("zh-CN",{style:"percent",minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value));
  const tbKnown=summary.tbFxGainLoss!=null;const passed=summary.reconciliationPassed===true;
  const metric=(label:string,value:unknown,detail?:string,tone="")=><div className={`fx-bridge-metric ${tone}`.trim()}><span>{label}</span><strong>{typeof value==="string"?value:amount(value)}</strong>{detail&&<small>{detail}</small>}</div>;
  return <section className="fx-result" aria-labelledby="fx-result-title">
    <div className="fx-result-heading"><div><h3 id="fx-result-title">汇兑损益测算结果</h3><p>按计算顺序查看金额如何形成，并与TB完成比较。</p></div>{outputs.map(path=><Button key={path} variant="secondary" onClick={()=>void openOutput(path)}>打开Excel底稿</Button>)}</div>
    {Boolean(summary.needsZeroResultReview)&&<p className="fa-missing-hint">已读取外币凭证，但没有事件进入自动测算；相关金额已归入待复核项目，不会再被当作正常“0”。</p>}
    <RollforwardIssues validation={result.balanceRollforwardValidation as Record<string,unknown>|undefined}/>
    {summary.unrealizedBalanceBasisComplete===false&&<p className="fa-missing-hint">未实现测算余额基础不完整：{String(summary.unrealizedMissingBalanceKeys??0)} 个账户币种余额键未取得可唯一对应的TB端点，已隔离且未按零期初测算。当前结果属于受限结果。</p>}
    <div className="fx-bridge-step"><div className="fx-step-label"><b>1</b><span>形成自动测算</span></div><div className="fx-bridge-equation">{metric("已实现汇兑损益",summary.realizedGainLoss)}<span className="fx-operator" aria-hidden="true">＋</span>{metric("未实现汇兑损益",summary.unrealizedAdjustment)}<span className="fx-operator" aria-hidden="true">＝</span>{metric("自动测算合计",summary.automaticMeasuredFxGainLoss,undefined,"total")}</div></div>
    <div className="fx-bridge-step"><div className="fx-step-label"><b>2</b><span>先比较已覆盖项目</span></div><div className="fx-bridge-equation">{metric("自动测算合计",summary.automaticMeasuredFxGainLoss)}<span className="fx-operator compare" aria-hidden="true">对比</span>{metric("已覆盖凭证账面金额",summary.coveredBookFxGainLoss,`已实现差异 ${amount(summary.realizedMeasurementDifference)}；未实现差异 ${amount(summary.unrealizedMeasurementDifference)}`)}<span className="fx-operator" aria-hidden="true">＝</span>{metric("已覆盖项目测算差异",summary.coveredMeasurementDifference,undefined,"total")}</div></div>
    <div className="fx-bridge-step comparison"><div className="fx-step-label"><b>3</b><span>解释完整TB差异</span></div><div className="fx-bridge-equation">{metric("已覆盖项目测算差异",summary.coveredMeasurementDifference)}<span className="fx-operator" aria-hidden="true">－</span>{metric("未覆盖账面金额",summary.uncoveredTbFxGainLoss,`${String(summary.pendingReviewCount??0)} 张待确认或无法测算凭证`)}<span className="fx-operator" aria-hidden="true">＝</span>{metric("完整TB总差异",tbKnown?(summary.difference??0):"无法比较",tbKnown?`TB汇兑损益 ${amount(summary.tbFxGainLoss)}；差异率 ${percent(summary.differenceRatio)}`:undefined,tbKnown?(passed?"pass":"warning"):"warning")}</div></div>
    {rollforward.length>0&&<section className="fx-unrealized-module"><div><h4>外币货币性项目余额滚动与未实现损益测算</h4><p>期初余额＋正常业务JE发生额－客户已入账未实现损益及其冲回＝计算前余额；月末原币余额×官方汇率形成审计余额。被分类为“未实现汇兑损益”的凭证只用于账面比较，不作为审计测算金额。</p></div><div className="fx-unrealized-metrics">{metric("月度账户测算行",rollforward.length)}{metric("已识别未实现类凭证",clientRevaluations.length)}{metric("审计未实现汇兑损益",summary.unrealizedAdjustment)}{metric("与客户入账差异",unrealizedComparisonDifference,undefined,"warning")}</div></section>}
    {groups.length>0&&<div className="fx-classification-review"><div className="fx-classification-heading"><div><h4>按借贷科目组合批量确认</h4><p>分类仍只有“已实现汇兑损益”“未实现汇兑损益”和“待确认”。未实现类凭证会从正常JE发生额中剔除，并在账户余额测算完成后与审计结果比较；不会直接采用该凭证金额作为测算结果。</p></div><Button disabled={busy} onClick={()=>void onRecalculate()}>{busy?"重新测算中…":"重新测算"}</Button></div><div className="fx-classification-list">{groups.map(group=>{const selected=[...new Set(group.items.map(item=>classificationDrafts[item.voucherId]??item.classification))];const value=selected.length===1?selected[0]:"待确认";const amount=group.items.reduce((sum,item)=>sum+Number(item.bookedFxGainLoss??0),0);const failed=group.items.filter(item=>item.measurementStatus?.startsWith("无法测算")).length;const first=group.items[0];return <label key={group.key}><span><b>{group.label}</b><div className="fx-pattern-names">{accountSide("借方科目",first.debitAccounts)}{accountSide("贷方科目",first.creditAccounts)}</div><small>{group.items.length} 张凭证；账面汇兑损益 {amount.toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2})}{failed?`；${failed} 张缺少重算证据`:""}</small></span><select disabled={busy} value={value} onChange={e=>onClassificationChange(group.items.map(item=>item.voucherId),e.target.value as VoucherClassification)}><option>已实现汇兑损益</option><option>未实现汇兑损益</option><option>待确认</option></select></label>})}</div></div>}
  </section>
}
function suggestRole(account:string){if(/银行|现金|bank|cash|\b(boc|boa|hsbc|cmb)\b/i.test(account))return"cash";if(/应收|receivable|accts?\s*rec|a\/r|interco cust/i.test(account))return"monetary_asset";if(/应付|借款|payable|accts?\s*pay|a\/p|loan|interco vend/i.test(account))return"monetary_liability";if(/汇兑|汇率|exchange\s*(gain|loss)|fx\s*(gain|loss)|cur\s*remeasur\s*g\/l|currency\s*remeasur|fx\s*transl\s*cogs|foreign\s*exch|forex\s*g\/l/i.test(account))return"fx_gain_loss";if(/预付|预收|prepaid|advance/i.test(account))return"review";return"unassigned"}
function fileName(path:string){return path.split(/[\\/]/).pop()??path}
function outputsFrom(value:Record<string,unknown>|undefined){return(value?.outputPaths??[]) as string[]}
function errorText(value:unknown){if(typeof value==="string")return value;if(value&&typeof value==="object"){const v=value as Record<string,unknown>;return String(v.userMessage??v.message??v.detail??"处理失败，请重试。")}return"处理失败，请重试。"}
