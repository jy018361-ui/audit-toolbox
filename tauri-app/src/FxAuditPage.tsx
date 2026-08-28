import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ToolManifest, JobEvent } from "./types";
import { engineCall, jobCancel, jobStart, listenPositionedFileDrops, listenJobEvents, openOutput, pickPath } from "./api";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { applyLedgerReviewToDict, missingGoldIdentity } from "@/ledgerMapping";
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
  accountRoleSuggestions?: Record<string,string>;
  accountRoleDetails?: Record<string,{role:string;confidence:number;needsConfirmation:boolean;reason:string;subtype?:string|null}>;
  accountCurrencyDetails?: Record<string,{detected:string;source:string;seen:string[];needsConfirmation:boolean}>;
};
// 下拉框的常备币种。检测到的币种会另行并进选项，所以这里只列常见的，
// 不求穷尽——真遇到冷门币种，检测结果本身就会把它带出来。
const CURRENCY_OPTIONS = ["CNY","USD","HKD","EUR","JPY","GBP","AUD","SGD","CHF","CAD","TWD","KRW","MYR","THB","NZD"];

type SourceClassification = {kind:"je"|"tb";confidence:number;needsLlm:boolean;scores:{je:number;tb:number};reasons:string[];headers:string[];preview:string[][];sheet:string;headerRow:number;headerDepth:number};
type VoucherClassification = "已实现汇兑损益"|"未实现汇兑损益"|"不构成汇兑事项";
type ClassificationControl = {voucherId:string;date?:string;voucherType?:string;systemCategory?:string;reviewReason?:string;bookedFxGainLoss?:number;classification:VoucherClassification;measurementStatus?:string;patternKey?:string;patternLabel?:string;debitAccounts?:string[];creditAccounts?:string[];summary?:string;classificationConflict?:string};
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
  ["monetary_asset","货币性资产"],["monetary_liability","货币性负债"],
  ["non_monetary","非货币性项目"],["fx_gain_loss","汇兑损益"],
  ["other_pnl","其他损益/成本科目"],
];

/** 合并 TB 与 JE 两侧对同一科目的币种识别结果，供「外币」列展示。 */
export function fxAccountCurrencyDetail(
  account:string,
  jeDetails:Record<string,{detected:string;source:string;seen:string[];needsConfirmation:boolean}>={},
  tbDetails:Record<string,{detected:string;source:string;seen:string[];needsConfirmation:boolean}>={},
){
  // JE 逐行读凭证货币，比只有一行的 TB 更能反映该科目实际用过哪些币种，
  // 所以主结论优先取 JE；seen 取两边并集，让下拉框把见过的币种都列出来。
  //
  // 精确名取不到就按科目编码取：TB 与 JE 的科目名拼法常常不同——4800 上
  // TB 写「1002010017 货币资金 货币资金-银行存款-建设银行」、JE 写
  // 「1002010017 银行存款-建行RMB3250-4800」，**两边全名完全相同的是 0 个**，
  // 按编码却能对上 54 个。只按全名查，JE 侧识别出的真实币种就传不到 TB 那一行，
  // 同一个科目会一行显示 HKD、另一行显示「USD（按本位币）」。
  // 与后端 `currency_for` 的覆盖回退是同一套规则。
  const pick=(details:Record<string,{detected:string;source:string;seen:string[];needsConfirmation:boolean}>)=>{
    const exact=details[account];
    if(exact)return exact;
    const code=account.trim().split(/\s+/)[0];
    return Object.entries(details).find(([candidate])=>candidate.trim().split(/\s+/)[0]===code)?.[1];
  };
  const je=pick(jeDetails);const tb=pick(tbDetails);
  const primary=je??tb;
  const seen=[...new Set([...(je?.seen??[]),...(tb?.seen??[])])];
  return {
    detected:primary?.detected??"",
    source:primary?.source??"",
    seen,
    // 两侧都没给出真凭据时才算「没识别出来」，界面标注「按本位币」。
    fellBack:primary?primary.needsConfirmation:true,
    // 同一科目下挂了多种币种：TB 往往只给这个科目一个**合计**余额，
    // 这时把它指定成单一币种，等于拿一种汇率去重估几种币种的合计数。
    // 实测 4800 的「过渡银行」有 CNY／HKD／JPY／USD 四种、合计恰好为零，
    // 指定成 CNY 后未实现从 -3,395 跳到 7,613 万——全是假数。
    multiCurrency:seen.length>1,
  };
}

/**
 * 只有用户真正选过的币种才作为覆盖传给后端。
 *
 * 留空表示「按系统识别的来」——**刻意不预填检测值**：一旦预填，就再也分不清
 * 「用户确认过 USD」和「系统猜了 USD」，日后改进识别逻辑也推不动已落盘的值。
 * 主体本位币那一处就是预填踩出来的坑（见下方 entityCurrencies 的注释）。
 */
export function fxAccountCurrencyOverrides(selections:Record<string,string>){
  return Object.fromEntries(
    Object.entries(selections)
      .map(([account,code])=>[account,code.trim().toUpperCase()] as const)
      .filter(([,code])=>code!==""),
  );
}

export function fxResolveAccountRoles(
  accounts:string[],
  jeSuggestions:Record<string,string>={},
  tbSuggestions:Record<string,string>={},
  current:Record<string,string>={},
  touched:Record<string,boolean>={},
){
  const exact={...jeSuggestions,...tbSuggestions};
  const byCode=new Map<string,string>();
  for(const [account,role] of Object.entries(jeSuggestions))byCode.set(account.trim().split(/\s+/)[0],role);
  // TB 是科目主数据，编码相同时优先使用 TB 的名称与分类结论。
  for(const [account,role] of Object.entries(tbSuggestions))byCode.set(account.trim().split(/\s+/)[0],role);
  return Object.fromEntries(accounts.map(account=>[
    account,
    touched[account]&&current[account]
      ?current[account]
      :exact[account]??byCode.get(account.trim().split(/\s+/)[0])??"non_monetary",
  ]));
}

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
/**
 * 未覆盖凭证的说明文字。**「待确认」已废止（分类二元化）**——带外币的
 * 凭证必落已实现/未实现之一；不构成汇兑事项的（本位币账户间划转、非货币
 * 性对手）单独披露。剩余未覆盖的只有「已分类但缺重算证据」一种。
 */
export function uncoveredDetail(summary:Record<string,unknown>):string{
  const total=Number(summary.pendingReviewCount??0);
  const unclassified=Number(summary.pendingUnclassifiedCount??0);
  const unmeasurable=Number(summary.pendingUnmeasurableCount??0);
  const notFx=Number(summary.notFxEventCount??0);
  if(!total)return "全部凭证均已纳入测算";
  // 旧结果没有拆分字段时退回总数，不假装知道构成。
  if(!unclassified&&!unmeasurable&&!notFx)return `${total} 张未纳入测算`;
  const parts=[];
  if(notFx)parts.push(`${notFx} 张不构成汇兑事项`);
  if(unclassified)parts.push(`${unclassified} 张待确认分类`);
  if(unmeasurable)parts.push(`${unmeasurable} 张已分类但缺重算证据`);
  return parts.join("；");
}
/** 未覆盖金额的「其中」拆分：不构成汇兑事项的金额张数在前，缺重算证据的余额在后。 */
export function uncoveredBreakdown(summary:Record<string,unknown>){
  const total=Number(summary.uncoveredTbFxGainLoss??0);
  const notFxCount=Number(summary.notFxEventCount??0);
  const notFxAmount=Number(summary.notFxEventAmount??0);
  const unmeasurable=Number(summary.pendingUnmeasurableCount??0);
  return {notFxCount,notFxAmount,unmeasurable,restAmount:total-notFxAmount};
}
export const NOT_FX_EVENT_HINT="这些凭证的货币性腿全部为本位币账户（如集团资金池美元↔美元划转），或对手科目为预付款、存货等非货币性项目——按准则不产生外币汇兑损益。账面汇差已从测算总体剔除，属客户科目使用问题，建议重分类复核；明细见底稿「不构成汇兑事项」页。";
export const UNMEASURABLE_HINT="这些凭证已明确归类为已实现/未实现，但缺少独立重算所需的原币余额、历史账面价值或汇率证据——常见原因是科目余额表未按币种拆分。审计金额暂未测出，账面金额挂在未覆盖里；需向客户补要资料后重跑。";
/** 「?」圆形图标：鼠标移上去（或键盘聚焦）显示口径注释。 */
export function InfoHint({text}:{text:string}){
  return <span className="fx-info-hint" tabIndex={0} role="note" aria-label={text}>?<span className="fx-info-hint-tip">{text}</span></span>;
}
/** 勾稽第 3 步「未覆盖账面金额」下的「其中」拆分行：不构成事项与缺重算证据
 *  各自成行、各带 ? 图标注释；两者都没有时退回纯文字说明。 */
export function uncoveredMetricDetail(summary:Record<string,unknown>,amount:(value:unknown)=>string):ReactNode{
  const {notFxCount,notFxAmount,unmeasurable,restAmount}=uncoveredBreakdown(summary);
  if(!notFxCount&&!unmeasurable)return uncoveredDetail(summary);
  return <>{notFxCount>0&&<span className="fx-metric-line">其中：不构成汇兑事项 {amount(notFxAmount)}（{notFxCount} 张）<InfoHint text={NOT_FX_EVENT_HINT}/></span>}
  {unmeasurable>0&&<span className="fx-metric-line">已分类但缺重算证据 {amount(restAmount)}（{unmeasurable} 张）<InfoHint text={UNMEASURABLE_HINT}/></span>}</>;
}

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
  const [accountRolesTouched,setAccountRolesTouched] = useState<Record<string,boolean>>({});
  // 币种覆盖刻意**不预填**：空字符串就是「按系统识别的来」，只有用户手工选过的
  // 才进 payload。主体本位币那一处预填踩过时序的坑（见下方注释），这里不重蹈。
  const [accountCurrencies,setAccountCurrencies] = useState<Record<string,string>>({});
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
  // 只有用户手工改过的主体才不许自动预填覆盖。
  // 之前这里写的是 `v[e] ?? uniformCurrency ?? "CNY"`：JE 比 TB 先解析完时，
  // entities 已经有值而 tb 还是空，先被填成 CNY；等 TB 的 uniformCurrency 到了，
  // `v[e] ??` 发现已有值就跳过——**一旦落成 CNY 就再也改不回来**，
  // 4800 这种本位币是 USD 的账会把全表科目都当成外币。
  const [currencyTouched,setCurrencyTouched]=useState<Record<string,boolean>>({});
  const setEntityCurrency=(entity:string,value:string)=>{
    setCurrencyTouched(v=>({...v,[entity]:true}));
    setEntityCurrencies(v=>({...v,[entity]:value.toUpperCase()}));
  };
  useEffect(()=>{
    const detected=tb?.uniformCurrency;
    setEntityCurrencies(v=>Object.fromEntries(entities.map(entity=>[
      entity,
      currencyTouched[entity]?(v[entity]??"CNY"):(detected??v[entity]??"CNY"),
    ])));
  },[entities,tb,currencyTouched]);
  useEffect(()=>{if(entities.length===1)setFixedEntity(entities[0])},[entities]);
  useEffect(()=>setAccountRoles(current=>fxResolveAccountRoles(
    accounts,je?.accountRoleSuggestions,tb?.accountRoleSuggestions,current,accountRolesTouched,
  )),[accounts,je?.accountRoleSuggestions,tb?.accountRoleSuggestions,accountRolesTouched]);
  useEffect(()=>{
    const drops=listenPositionedFileDrops(({paths,x,y})=>{const rect=uploadDropRef.current?.getBoundingClientRect();if(!rect||x<rect.left||x>rect.right||y<rect.top||y>rect.bottom)return;void classifyAndInspect(paths);});
    const jobs=listenJobEvents(event=>{if(event.jobId!==activeJob.current)return;setJob(event);if(event.result)setResult(current=>fxApplyJobResult(current,event.result,activeJobMethod.current));if(event.phase==="completed"){setBusy(false);setActiveStage(undefined);if(event.result)setCompletedStage(activeJobMethod.current);else{setCompletedStage(undefined);setError("任务进程已结束，但系统未收到测算结果。请重新测算；若再次出现，结果传输诊断会保留此异常。")}}else if(event.phase==="failed"||event.phase==="cancelled"){setBusy(false);setActiveStage(undefined);setCompletedStage(undefined);const p=event.result as {error?:{userMessage?:string}}|undefined;setError(p?.error?.userMessage??event.message)}});
    return()=>{void drops.then(x=>x());void jobs.then(x=>x())};
  },[]);

  async function browse(){const picked=await pickPath("files","选择JE或TB文件",["xlsx","xls","xlsm","csv","txt","tsv","parquet"]);if(!picked)return;void classifyAndInspect(Array.isArray(picked)?picked:[picked])}
  async function classifyAndInspect(paths:string[]){const files=paths.filter(p=>/\.(xlsx?|xlsm|csv|txt|tsv|parquet)$/i.test(p));if(!files.length)return;setBusy(true);setError("");setSourceStatus("正在识别文件类型、表头和字段…");const failures:string[]=[];try{for(const path of files){try{const scripted=await engineCall("fx.classify_source",{source:{inputPath:path,sheet:"",headerRow:0,headerDepth:0}}) as SourceClassification;let kind=scripted.kind;let source="脚本";if(scripted.needsLlm){const llm=await engineCall("fx.classify_source_llm",{payload:{path,headers:scripted.headers,sampleRows:scripted.preview,scriptScores:scripted.scores}}) as {kind?:"je"|"tb"};if(llm.kind)kind=llm.kind;source="脚本无法确定，已由LLM"}const response=await engineCall("fx.inspect_"+kind,{source:{inputPath:path,sheet:scripted.sheet,headerRow:scripted.headerRow,headerDepth:scripted.headerDepth}}) as Inspection;applyInspection(kind,path,response);setSourceStatus(`${files.length} 个文件已识别；${kind.toUpperCase()} 由${source}判定。`)}catch(e){failures.push(`${fileName(path)}：${errorText(e)}`)}}if(failures.length)setError(failures.join("；"))}finally{setBusy(false)}}
  function applyInspection(kind:"je"|"tb",path:string,response:Inspection){if(response.suggestedBalanceSheetDate)setReportEnd(response.suggestedBalanceSheetDate);else if(response.dataYears?.length===1)setReportEnd(`${response.dataYears[0]}-12-31`);setReviewStatus(v=>({...v,[kind]:""}));setAccountRoles({});setAccountRolesTouched({});if(kind==="je"){setManualClassifications({});setClassificationDrafts({});setJePath(path);setJe(response);setJeMapping(response.suggestedMapping)}else{setTbPath(path);setTb(response);setTbMapping(response.suggestedMapping);setTbCurrencyConfirmed(!response.foreignCurrencyNeedsConfirmation)}}
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
      const labels=kind==="je"?JE_LABELS:TB_LABELS;const setter=kind==="je"?setJeMapping:setTbMapping;
      const {mapping:next,applied}=await applyLedgerReviewToDict(engineCall,kind,inspection.headers,inspection.preview,base,labels);
      setter(next);
      setReviewStatus(v=>({...v,[kind]:applied.length?`复核完成，已应用 ${applied.length} 项建议。`:"复核完成，当前映射无需调整。"}));
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

  function payload(method:"fx.preview"|"fx.export",overrides=manualClassifications){const effectiveEntities=entities.length?entityCurrencies:{[fixedEntity]:entityCurrencies[fixedEntity]??defaultFunctionalCurrency};const start=fxReportStart(reportEnd);const snapshot=result?.rateSnapshot as {startDate?:string;endDate?:string}|undefined;const reusableSnapshot=snapshot?.startDate===start&&snapshot?.endDate===reportEnd?snapshot:undefined;const cachedTranslations=(result?.accountTranslations??{}) as Record<string,string>;const previewToken=fxPreviewTokenFor(method,result);return{mode,reportStart:start,reportEnd,fixedEntity,tbForeignCurrencyConfirmed:!tb?.foreignCurrencyNeedsConfirmation||tbCurrencyConfirmed,...(je?{jeSource:{inputPath:jePath,sheet:je.sheet,headerRow:je.headerRow,headerDepth:je.headerDepth},jeMapping}:{}),...(tb?{tbSource:{inputPath:tbPath,sheet:tb.sheet,headerRow:tb.headerRow,headerDepth:tb.headerDepth},tbMapping}:{}),entityCurrencies:effectiveEntities,accountRoles,accountCurrencies:fxAccountCurrencyOverrides(accountCurrencies),manualClassifications:overrides,translateTbAccountNames:true,...(Object.keys(cachedTranslations).length?{accountTranslations:cachedTranslations}:{}),...(reusableSnapshot?{rateSnapshot:reusableSnapshot}:{}),...(previewToken?{previewToken}:{}),...(outputPath?{outputPath}:{})}}
  async function run(method:"fx.preview"|"fx.export",overrides=manualClassifications){setError("");if(!reportEnd)return setError("请选择资产负债表日。");if((mode==="realized"||mode==="combined")&&!je)return setError("已实现测算需先上传并识别JE。");if((mode==="unrealized"||mode==="combined")&&!tb)return setError("未实现测算需先上传并识别TB。");const jeMissing=je&&mode!=="unrealized"?fxMissingRequired("je",jeMapping,true,fixedEntity):[];if(jeMissing.length)return setError(`JE尚未映射：${jeMissing.join("、")}。请先在预览表头完成字段映射。`);const tbMissing=tb&&mode!=="realized"?fxMissingRequired("tb",tbMapping,Boolean(je),fixedEntity):[];if(tbMissing.length)return setError(`TB尚未映射：${tbMissing.join("、")}。请先在预览表头完成字段映射。`);if(currencyConfirmationMissing)return setError("TB检测到多个外币币种候选，请确认系统预选的外币币种列。");if(entities.some(e=>!entityCurrencies[e]))return setError("请为每个公司选择ISO本位币。");setBusy(true);setJob(undefined);setCompletedStage(undefined);setActiveStage(method);activeJobMethod.current=method;try{activeJob.current=await jobStart(method,payload(method,overrides))}catch(e){setBusy(false);setActiveStage(undefined);setError(errorText(e))}}
  function stageVoucherClassifications(voucherIds:string[],classification:VoucherClassification){setClassificationDrafts(current=>{const next={...current};for(const voucherId of voucherIds)next[voucherId]=classification;return next})}
  async function recalculateClassifications(){const next={...manualClassifications,...classificationDrafts};setManualClassifications(next);await run("fx.preview",next)}

  return <main className="tool-page fx-page">
    <PageHeader eyebrow="外币审计" title={tool.name} detail="按凭证识别结算事件，按官方人民币汇率中间价重算，并生成可追踪Excel底稿。" />
    <ErrorBox error={error} onDismiss={()=>setError("")}/>
    <section className="fx-mode-bar">{([["realized","仅已实现"],["unrealized","仅未实现"],["combined","已实现＋未实现"]] as Array<[Mode,string]>).map(([value,label])=><button key={value} type="button" className={mode===value?"active":""} disabled={!allowedModes.includes(value)} onClick={()=>setMode(value)}>{label}</button>)}</section>
    <Card><CardHeader><CardTitle>上传审计数据</CardTitle></CardHeader><CardContent><p className="fx-hint">JE和TB使用同一入口；系统先按表格结构自动识别，无法确定时再调用LLM。</p><FileDropInput containerRef={uploadDropRef} value={[jePath&&`JE：${fileName(jePath)}`,tbPath&&`TB：${fileName(tbPath)}`].filter(Boolean).join("；")} disabled={busy||reviewingAny} placeholder="拖放或选择JE、TB文件（可同时选择）" onBrowse={()=>void browse()} onDragStateChange={()=>{}} onClear={()=>{setJePath("");setTbPath("");setJe(undefined);setTb(undefined);setJeMapping({});setTbMapping({});setAccountRoles({});setAccountRolesTouched({});setManualClassifications({});setClassificationDrafts({});setSourceStatus("")}}/>{sourceStatus&&<p className="fx-source-status" aria-live="polite">{sourceStatus}</p>}</CardContent></Card>
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
      <Card><CardHeader><CardTitle>公司本位币</CardTitle></CardHeader><CardContent className="fx-list">{tb?.uniformCurrency&&<p className="fx-hint">TB 的币种列整列都是 {tb.uniformCurrency}，已按主体本位币预填；账户币种改从科目名称/文本识别。若该列确实是交易币种，请在此改回。</p>}{entities.length?entities.map(entity=><label key={entity}><span>{entity}</span><input value={entityCurrencies[entity]??defaultFunctionalCurrency} maxLength={3} onChange={e=>setEntityCurrency(entity,e.target.value)}/></label>):<><label><span>文件无主体列，固定主体</span><input value={fixedEntity} onChange={e=>setFixedEntity(e.target.value)}/></label><label><span>本位币</span><input value={entityCurrencies[fixedEntity]??defaultFunctionalCurrency} maxLength={3} onChange={e=>setEntityCurrency(fixedEntity,e.target.value)}/></label></>}</CardContent></Card>
      <Card><CardHeader><CardTitle>高级设置</CardTitle></CardHeader><CardContent><details><summary>科目分类（通常无需修改）</summary><p className="fx-hint">系统按统一词典和科目编码归入五类；低置信项目仍有默认类别，仅提示复核，不会显示“未分配”。<br/>「外币」列是系统识别出的账户币种。TB 只有一列货币且整列同值时，它登记的是<strong>主体本位币</strong>而不是账户币种，这类科目标注为「按本位币」——若该科目实际持有外币，请在这里手工指定，否则测算时会因缺少外币余额基础而被隔离。</p><div className="fx-list fx-accounts">{accounts.map(account=>{const detail=tb?.accountRoleDetails?.[account]??je?.accountRoleDetails?.[account];
        // 两边都看：JE 逐行读凭证货币，比只有一行的 TB 更能反映该科目实际用过哪些币种。
        const {detected,source,seen,fellBack,multiCurrency}=fxAccountCurrencyDetail(account,je?.accountCurrencyDetails,tb?.accountCurrencyDetails);
        // 多币种科目被指定成单一币种：TB 多半只有一个合计余额，这么重估必然是假数。
        const currencyRisk=multiCurrency&&Boolean(accountCurrencies[account]);
        return <label key={account}><span title={detail?`${account}\n${detail.reason}（置信度 ${Math.round(detail.confidence*100)}%）`:account}>{account}{detail?.needsConfirmation&&<small> 建议复核</small>}{multiCurrency&&<small title={`该科目出现过 ${seen.join("、")}`}> {seen.length}种币种</small>}</span><select value={accountRoles[account]??"non_monetary"} onChange={e=>{setAccountRolesTouched(v=>({...v,[account]:true}));setAccountRoles(v=>({...v,[account]:e.target.value}))}}>{ROLE_OPTIONS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><select className={currencyRisk?"fx-currency-risky":accountCurrencies[account]?"fx-currency-override":undefined} title={currencyRisk?`该科目在数据里出现过 ${seen.join("、")} 共 ${seen.length} 种币种。
科目余额表若只给出这个科目的合计余额，指定单一币种等于拿一种汇率去重估几种币种的合计数，结果不可用。
正确做法是改用按币种拆分的科目余额表。`:detected?`系统识别：${detected}（依据${source}）${seen.length>1?`
该科目出现过：${seen.join("、")}`:""}`:"系统未识别到该科目的币种，请手工指定"} value={accountCurrencies[account]??""} onChange={e=>setAccountCurrencies(v=>({...v,[account]:e.target.value}))}><option value="">{detected?`自动：${detected}${fellBack?"（按本位币）":""}`:"自动：未识别"}</option>{[...new Set([...seen,...CURRENCY_OPTIONS])].map(code=><option key={code} value={code}>{code}</option>)}</select></label>})}</div></details></CardContent></Card>
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
/** 凭证组分两类：**不构成汇兑事项（披露即可）** 和 **已定分类但算不出金额**。
 *
 *  这两件事性质完全不同：前者是二元分类的口径结论（本位币账户间划转、
 *  非货币性对手），后者要么补资料要么修工具。分类已二元化，「待确认」
 *  不再作为分类值出现。 */
export function splitClassificationGroups<T extends {voucherId:string;classification:string;measurementStatus?:string}>(
  groups:Array<{key:string;label:string;items:T[]}>,
  drafts:Record<string,string>,
){
  const undecided:typeof groups=[];const unmeasurable:typeof groups=[];
  for(const group of groups){
    const pending=group.items.some(item=>(drafts[item.voucherId]??item.classification)==="不构成汇兑事项");
    (pending?undecided:unmeasurable).push(group);
  }
  return {undecided,unmeasurable};
}
/** 逐行数据质量按「问题类型 ＋ 严重度」归并，同类几百行不必逐条铺开。 */
export function summarizeQuality(items:Array<Record<string,unknown>>){
  const order:Record<string,number>={阻断:0,隔离:1,重要提示:2,待复核:3,合并:4,提示:5};
  const groups=new Map<string,{type:string;severity:string;count:number;detail:string;rows:number[]}>();
  for(const item of items){
    const type=String(item.type??"未分类");
    const severity=String(item.severity??"提示");
    const key=`${severity} ${type}`;
    const group=groups.get(key)??{type,severity,count:0,detail:"",rows:[]};
    group.count+=1;
    if(!group.detail&&item.detail)group.detail=String(item.detail);
    const row=Number(item.row??item.sourceRow??NaN);
    if(Number.isFinite(row)&&group.rows.length<5)group.rows.push(row);
    groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>
    (order[a.severity]??9)-(order[b.severity]??9)||b.count-a.count);
}
/** 测算跑完后的全部检查结论。
 *
 *  这些结论一直都在算，但以前只写进 Excel 底稿的「数据质量 / 异常与限制 /
 *  TB勾稽」几个 Sheet，界面上一个字都不显示——用户看到一个对不上的差异率，
 *  却没有任何线索说明哪一步没通过、被隔离了多少行、TB 那个数是从哪几个
 *  科目取的。这里把三块摊开：校验提示、逐行数据质量、TB 汇兑损益取数。 */
function FxChecks({result}:{result:Record<string,unknown>}){
  const validation=(result.validation??{}) as Record<string,unknown>;
  const warnings=(validation.warnings??[]) as string[];
  const quality=(result.dataQuality??[]) as Array<Record<string,unknown>>;
  const reconciliation=(result.reconciliation??{}) as Record<string,unknown>;
  const tbRows=(reconciliation.tbRows??[]) as Array<Record<string,unknown>>;
  const groups=summarizeQuality(quality);
  if(!warnings.length&&!groups.length&&!tbRows.length)return null;
  const money=(value:unknown)=>new Intl.NumberFormat("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value??0));
  const isolated=groups.filter(g=>g.severity==="隔离"||g.severity==="阻断")
    .reduce((sum,g)=>sum+g.count,0);
  const headline=[
    warnings.length?`${warnings.length} 项校验提示`:"",
    isolated?`${isolated} 行被隔离`:"",
    tbRows.length?`TB 取数 ${tbRows.length} 个科目`:"",
  ].filter(Boolean).join(" · ")||"全部检查通过";
  return <details className="fx-checks">
    <summary><strong>检查与勾稽</strong><span>{headline}</span></summary>
    <div className="fx-checks-body">
      {warnings.length>0&&<section>
        <h5>映射与数据质量校验</h5>
        <p>测算前跑的校验。出现错误会直接拦下测算；下面这些是<b>通过但需要你知道</b>的提示。</p>
        <ul className="fx-checks-list">{warnings.map((text,index)=><li key={index}>{text}</li>)}</ul>
      </section>}
      {groups.length>0&&<section>
        <h5>逐行数据质量</h5>
        <p>测算过程中逐行记录的问题。<b>隔离</b>表示该行没有进入测算结果，
          <b>合并</b>表示已并入其他行，<b>提示</b>不影响结果。</p>
        <div className="fx-checks-table"><table>
          <thead><tr><th>严重度</th><th>问题</th><th>行数</th><th>示例行号</th><th>说明</th></tr></thead>
          <tbody>{groups.map((group,index)=><tr key={index}>
            <td><span className={`fx-severity ${group.severity==="隔离"||group.severity==="阻断"?"blocking":""}`}>{group.severity}</span></td>
            <td>{group.type}</td>
            <td className="fx-checks-number">{group.count}</td>
            <td>{group.rows.length?group.rows.join("、"):"—"}</td>
            <td>{group.detail||"—"}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}
      {tbRows.length>0&&<section>
        <h5>TB 汇兑损益取数</h5>
        <p>用来和测算结果比较的那个「TB汇兑损益」，是从下面这几个科目取的。
          序时账同口径合计 {money(reconciliation.jeFxGainLossAfterTransferExclusion)}，
          与 TB 相差 {money(reconciliation.jeTbDifference)}。</p>
        <div className="fx-checks-table"><table>
          <thead><tr><th>科目</th><th>金额</th><th>取数口径</th><th>源文件行</th></tr></thead>
          <tbody>{tbRows.map((row,index)=><tr key={index}>
            <td>{String(row.account??"")}</td>
            <td className="fx-checks-number">{money(row.amount)}</td>
            <td>{String(row.basis??"")}</td>
            <td className="fx-checks-number">{String(row.sourceRow??"")}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}
    </div>
  </details>;
}
/** 一句话说清这条隔离属于哪种粒度问题，用户不必读完整段 detail。 */
export function granularityLabel(type:unknown):string{
  switch(String(type??"")){
    case "科目余额混合本位币与外币":return "科目余额里既有本位币又有外币，拆不开";
    case "同一科目存在多种外币敞口":return "同一科目持有多种外币，TB 只有合计数";
    case "无外币敞口的评估调整科目":return "评估调整科目，本身不持有外币";
    default:return "TB 未提供可唯一对应的原币币种";
  }
}
/** TB 粒度不足：外币敞口是「科目×币种」粒度，TB 只给到科目粒度就测不了。
 *  这类科目会整块掉出测算结果，必须显式告诉用户原因和该补什么资料——
 *  以前只写进底稿的「数据质量」Sheet，界面上什么都不显示，用户只会
 *  看到一个对不上的差异率，误以为是工具算错了。 */
function TbGranularityNotice({items}:{items:Array<Record<string,unknown>>}){
  const [open,setOpen]=useState(false);
  if(!items.length)return null;
  return <section className="fx-granularity-notice">
    <div className="fx-granularity-head">
      <div>
        <strong>TB 粒度不足：{items.length} 个科目无法测算未实现汇兑损益</strong>
        <small>外币敞口要按「科目 ＋ 币种」才算得出来，而当前这份科目余额表只给到「科目」一级。
          这些科目的余额里混了多种币别或本位币，工具无法拆分，已整块排除在测算之外——
          它们的账面金额会出现在上面的「未覆盖账面金额」里。</small>
        <div className="fx-granularity-action">
          <b>要做什么：</b>请客户从 ERP 重新导出<b>按币种拆分</b>的科目余额表
          （SAP 一般是在余额表里加上「货币」维度，使同一科目的不同币别各占一行），
          替换当前 TB 后重新测算。
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={()=>setOpen(v=>!v)}>
        {open?"收起科目":"查看科目"}
      </Button>
    </div>
    {open&&<div className="fx-granularity-table"><table>
      <thead><tr><th>科目</th><th>币种</th><th>原因</th><th>说明</th></tr></thead>
      <tbody>{items.map((item,index)=>{
        const currencies=item.currencies;
        const shown=Array.isArray(currencies)?currencies.join("、"):String(currencies??"—");
        return <tr key={index}>
          <td>{String(item.account??"")}</td>
          <td>{shown||"—"}</td>
          <td>{granularityLabel(item.type)}</td>
          <td>{String(item.detail??"")}</td>
        </tr>})}</tbody>
    </table></div>}
  </section>;
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
  const {undecided,unmeasurable}=splitClassificationGroups(groups,classificationDrafts);
  const accountNames=details.reduce<Record<string,{english:Set<string>;chinese:Set<string>}>>((all,item)=>{const code=String(item.accountCode??"").trim().toUpperCase();if(!code)return all;const names=all[code]??{english:new Set<string>(),chinese:new Set<string>()};const original=String(item.accountNameOriginal??"").trim();const chinese=String(item.accountNameChinese??"").trim();if(original){if(/[\u4e00-\u9fff]/.test(original))names.chinese.add(original);else names.english.add(original)}if(chinese)names.chinese.add(chinese);all[code]=names;return all},{});
  const accountSide=(title:string,codes:string[]|undefined)=><div className="fx-pattern-side"><strong>{title}</strong><div>{(codes??[]).map(code=>{const names=accountNames[code.trim().toUpperCase()];const english=names?[...names.english].join(" / "):"";const chinese=names?[...names.chinese].join(" / "):"";return <span key={code}><b>{code}</b><small>英文：{english||"—"}</small><small>中文：{chinese||"—"}</small></span>})}</div></div>;
  const amount=(value:unknown)=>{const number=Number(value??0);return new Intl.NumberFormat("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Object.is(number,-0)||Math.abs(number)<0.005?0:number)};
  const percent=(value:unknown)=>value==null?"无法计算":new Intl.NumberFormat("zh-CN",{style:"percent",minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value));
  const renderGroup=(group:{key:string;label:string;items:ClassificationControl[]})=>{
    const selected=[...new Set(group.items.map(item=>classificationDrafts[item.voucherId]??item.classification))];
    const value=selected.length===1?selected[0]:"不构成汇兑事项";
    const booked=group.items.reduce((sum,item)=>sum+Number(item.bookedFxGainLoss??0),0);
    const failed=group.items.filter(item=>item.measurementStatus?.startsWith("无法测算")).length;
    const conflicts=group.items.filter(item=>item.classificationConflict);
    const first=group.items[0];
    return <label key={group.key}>
      <span>
        <b>{group.label}</b>
        <div className="fx-pattern-names">{accountSide("借方科目",first.debitAccounts)}{accountSide("贷方科目",first.creditAccounts)}</div>
        <small>{group.items.length} 张凭证；账面汇兑损益 {booked.toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2})}{failed?`；${failed} 张缺少重算证据`:""}</small>
        {conflicts.length>0&&<small className="fx-conflict-hint">分类冲突（{conflicts.length} 张）：{conflicts[0].classificationConflict}</small>}
      </span>
      <select disabled={busy} value={value} onChange={e=>onClassificationChange(group.items.map(item=>item.voucherId),e.target.value as VoucherClassification)}>
        <option>已实现汇兑损益</option><option>未实现汇兑损益</option><option>不构成汇兑事项</option>
      </select>
    </label>;
  };
  const tbKnown=summary.tbFxGainLoss!=null;const passed=summary.reconciliationPassed===true;
  const metric=(label:string,value:unknown,detail?:ReactNode,tone="")=><div className={`fx-bridge-metric ${tone}`.trim()}><span>{label}</span><strong>{typeof value==="string"?value:amount(value)}</strong>{detail!=null&&detail!==""&&<small>{detail}</small>}</div>;
  return <section className="fx-result" aria-labelledby="fx-result-title">
    <div className="fx-result-heading"><div><h3 id="fx-result-title">汇兑损益测算结果</h3><p>按计算顺序查看金额如何形成，并与TB完成比较。</p></div>{outputs.map(path=><Button key={path} variant="secondary" onClick={()=>void openOutput(path)}>打开Excel底稿</Button>)}</div>
    {Boolean(summary.needsZeroResultReview)&&<p className="fa-missing-hint">已读取外币凭证，但没有事件进入自动测算；相关金额已归入待复核项目，不会再被当作正常“0”。</p>}
    <TbGranularityNotice items={(result.tbGranularityBlocked??[]) as Array<Record<string,unknown>>}/>
    <RollforwardIssues validation={result.balanceRollforwardValidation as Record<string,unknown>|undefined}/>
    {summary.unrealizedBalanceBasisComplete===false&&<p className="fa-missing-hint">未实现测算余额基础不完整：{String(summary.unrealizedMissingBalanceKeys??0)} 个账户币种余额键未取得可唯一对应的TB端点，已隔离且未按零期初测算。当前结果属于受限结果。</p>}
    <div className="fx-bridge-step"><div className="fx-step-label"><b>1</b><span>形成自动测算</span></div><div className="fx-bridge-equation">{metric("已实现汇兑损益",summary.realizedGainLoss)}<span className="fx-operator" aria-hidden="true">＋</span>{metric("未实现汇兑损益",summary.unrealizedAdjustment)}<span className="fx-operator" aria-hidden="true">＝</span>{metric("自动测算合计",summary.automaticMeasuredFxGainLoss,undefined,"total")}</div></div>
    <div className="fx-bridge-step"><div className="fx-step-label"><b>2</b><span>先比较已覆盖项目</span></div><div className="fx-bridge-equation">{metric("自动测算合计",summary.automaticMeasuredFxGainLoss)}<span className="fx-operator compare" aria-hidden="true">对比</span>{metric("已覆盖凭证账面金额",summary.coveredBookFxGainLoss,`已实现差异 ${amount(summary.realizedMeasurementDifference)}；未实现差异 ${amount(summary.unrealizedMeasurementDifference)}`)}<span className="fx-operator" aria-hidden="true">＝</span>{metric("已覆盖项目测算差异",summary.coveredMeasurementDifference,undefined,"total")}</div></div>
    <div className="fx-bridge-step comparison"><div className="fx-step-label"><b>3</b><span>解释完整TB差异</span></div><div className="fx-bridge-equation">{metric("已覆盖项目测算差异",summary.coveredMeasurementDifference)}<span className="fx-operator" aria-hidden="true">－</span>{metric("未覆盖账面金额",summary.uncoveredTbFxGainLoss,uncoveredMetricDetail(summary,amount))}<span className="fx-operator" aria-hidden="true">＝</span>{metric("完整TB总差异",tbKnown?(summary.difference??0):"无法比较",tbKnown?`TB汇兑损益 ${amount(summary.tbFxGainLoss)}；差异率 ${percent(summary.differenceRatio)}`:undefined,tbKnown?(passed?"pass":"warning"):"warning")}</div></div>
    <FxChecks result={result}/>
    {rollforward.length>0&&<section className="fx-unrealized-module"><div><h4>外币货币性项目余额滚动与未实现损益测算</h4><p>期初余额＋正常业务JE发生额－客户已入账未实现损益及其冲回＝计算前余额；月末原币余额×官方汇率形成审计余额。被分类为“未实现汇兑损益”的凭证只用于账面比较，不作为审计测算金额。</p></div><div className="fx-unrealized-metrics">{metric("月度账户测算行",rollforward.length)}{metric("已识别未实现类凭证",clientRevaluations.length)}{metric("审计未实现汇兑损益",summary.unrealizedAdjustment)}{metric("与客户入账差异",unrealizedComparisonDifference,undefined,"warning")}</div></section>}
    {groups.length>0&&<div className="fx-classification-review">
      <div className="fx-classification-heading">
        <div>
          <h4>凭证分类复核</h4>
          <p>分类只有“已实现汇兑损益”“未实现汇兑损益”两种（外加结构判定的“不构成汇兑事项”）。未实现类凭证会从正常JE发生额中剔除，
            并在账户余额测算完成后与审计结果比较；不会直接采用该凭证金额作为测算结果。
            借贷科目组合相同的凭证归成一组，可一次性改一整组。</p>
        </div>
        <Button disabled={busy} onClick={()=>void onRecalculate()}>{busy?"重新测算中…":"重新测算"}</Button>
      </div>
      {undecided.length>0&&<section className="fx-classification-section">
        <h5>不构成汇兑事项（{undecided.reduce((n,g)=>n+g.items.length,0)} 张）</h5>
        <p>这些凭证的货币性腿全部为本位币账户（如集团资金池美元↔美元划转），或对手科目为
          预付款等非货币性项目——结构上不产生外币汇兑损益，账面汇差已从测算总体剔除并计入
          「未覆盖账面金额」。若你判断其中某组确属已实现/未实现，仍可在这里改，选完点「重新测算」。</p>
        <div className="fx-classification-list">{undecided.map(renderGroup)}</div>
      </section>}
      {unmeasurable.length>0&&<section className="fx-classification-section">
        <h5>已分好类，但工具算不出审计金额（{unmeasurable.reduce((n,g)=>n+g.items.length,0)} 张）</h5>
        <p>这些凭证的分类已经确定，<b>不需要你再确认</b>。
          它们没进测算结果，是因为缺少重算所需的原币余额或汇率证据——账面金额已计入上面的
          「未覆盖账面金额」。<b>常见原因是科目余额表粒度不够</b>，参见页首的提示。
          如果你认为某一组的分类判错了，仍可在这里改。</p>
        <div className="fx-classification-list">{unmeasurable.map(renderGroup)}</div>
      </section>}
    </div>}
  </section>
}
function fileName(path:string){return path.split(/[\\/]/).pop()??path}
function outputsFrom(value:Record<string,unknown>|undefined){return(value?.outputPaths??[]) as string[]}
/** 校验未通过时，把后端塞在 detail 里的那段 JSON 拆成人话。
 *
 *  `MAPPING_INVALID` 的 detail 是 validate_mapping 的完整结果，直接显示就是
 *  一串花括号。用户实测遇到过：界面只说「字段映射或数据质量校验未通过」，
 *  到底哪一条不通过要靠猜——而后端其实已经把原因写得很清楚了。 */
export function validationDetail(detail:unknown):string{
  if(typeof detail!=="string"||!detail.includes("errors"))return"";
  try{
    const parsed=JSON.parse(detail) as {errors?:unknown};
    const texts=((parsed.errors??[]) as unknown[]).filter((x):x is string=>typeof x==="string");
    if(!texts.length)return"";
    return `具体是：${texts.map((text,index)=>`${index+1}. ${text}`).join("；")}`;
  }catch{return""}
}
function errorText(value:unknown){
  if(typeof value==="string")return value;
  if(value&&typeof value==="object"){
    const v=value as Record<string,unknown>;
    const detailed=validationDetail(v.detail);
    if(detailed)return `${String(v.userMessage??"校验未通过。")}${detailed}`;
    return String(v.userMessage??v.message??v.detail??"处理失败，请重试。");
  }
  return"处理失败，请重试。";
}
