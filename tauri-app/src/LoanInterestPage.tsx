import { useEffect, useRef, useState } from "react";
import type { JobEvent, ToolManifest } from "./types";
import { engineCall, jobCancel, jobStart, listenJobEvents, openOutput, pickPath } from "./api";
import { PageHeader } from "@/components/PageHeader";
import { FileDropInput } from "@/components/FileDropInput";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { applyLedgerReviewToDict, missingGoldIdentity } from "@/ledgerMapping";
import { MappingPanel } from "@/components/MappingPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import "./loan-interest.css";

type Mode="ledger"|"tb"; type Kind="ledger"|"tb"|"je"|"rateLedger";
type Inspection={headers:string[];preview:string[][];rowCount:number;sheet:string;sheets:string[];headerRow:number;headerDepth:number;suggestedMapping:Record<string,string>};
type Source={path:string;inspection?:Inspection;mapping:Record<string,string>};
type LoanRow={loanId:string;openingPrincipal:number;additions:number;reductions:number;closingPrincipal:number;rateType:"fixed"|"floating";fixedRate?:number;benchmarkRate?:number;spreadBps?:number;calculatedInterest?:number;matchStatus?:string;matchBasis?:string};
const LABELS:Record<Kind,Record<string,string>>={
 ledger:{loanId:"借款唯一标识",lender:"贷款方",account:"借款科目",currency:"币种",openingPrincipal:"期初本金",drawdownDate:"新增借款日期",drawdownAmount:"本期新增本金",repaymentDate:"还款日期",repaymentAmount:"本期减少本金",closingPrincipal:"期末本金",startDate:"起息日",maturityDate:"到期日",rateType:"利率类型",fixedRate:"固定利率",benchmark:"浮动基准",benchmarkRate:"基准利率",spreadBps:"加/减点（BP）",resetDate:"重定价日",dayCount:"计息基础",bookInterest:"账面利息"},
 tb:{entity:"核算主体",accountCode:"借款科目编码",accountName:"借款科目名称",loanId:"借款明细/辅助核算",currency:"币种",openingDirection:"期初方向",closingDirection:"期末方向",openingFunctionalAmount:"期初余额（净额）",openingFunctionalDebit:"期初借方余额",openingFunctionalCredit:"期初贷方本金",closingFunctionalAmount:"期末余额（净额）",closingFunctionalDebit:"期末借方余额",closingFunctionalCredit:"期末贷方本金",ytdFunctionalDebit:"本年累计借方（还款）",ytdFunctionalCredit:"本年累计贷方（新增）"},
 je:{date:"记账日期",id:"凭证号",accountCode:"借款科目编码",accountName:"借款科目名称",loanId:"借款明细/辅助核算",summary:"摘要",functionalDebit:"借方金额",functionalCredit:"贷方金额",functionalAmount:"有符号金额",direction:"借贷方向"},
 rateLedger:{loanId:"借款唯一标识",lender:"贷款方",rateType:"利率类型",fixedRate:"固定利率",benchmark:"浮动基准",benchmarkRate:"基准利率",spreadBps:"加/减点（BP）",resetDate:"重定价日",dayCount:"计息基础"}
};
export function loanEffectiveRate(type:string,fixed=0,benchmark=0,bps=0){return type==="floating"?Number(benchmark)+Number(bps)/10000:Number(fixed)}
export function loanEquation(r:Pick<LoanRow,"openingPrincipal"|"additions"|"reductions"|"closingPrincipal">){return r.openingPrincipal+r.additions-r.reductions-r.closingPrincipal}
/** TB/JE 的余额与科目走统一角色名，同一语义有几种写法时任一到位即可。 */
const ANY_OF:Record<string,string[][]>={
 tb:[["accountCode","accountName","account"],["loanId"],["openingFunctionalAmount","openingFunctionalDebit","openingFunctionalCredit","openingPrincipal"],["closingFunctionalAmount","closingFunctionalDebit","closingFunctionalCredit","closingPrincipal"]],
 je:[["date"],["accountCode","accountName","account"]],
};
const ANY_OF_LABEL:Record<string,string[]>={tb:["借款科目","借款明细/辅助核算","期初余额","期末余额"],je:["记账日期","借款科目"]};
export function loanMissing(kind:Kind,m:Record<string,string>){
 const filled=(role:string)=>Boolean(m[role]?.trim());
 const groups=ANY_OF[kind];
 // TB/JE 走统一口径：金标身份槽 ∪ 本工具必填。借款台账与利率台账不是账表，不受金标约束。
 if(groups){
  const gold=missingGoldIdentity(kind==="tb"?"tb":"je",role=>role==="accountCode"||role==="accountName"?filled(role)||filled("account"):filled(role));
  const own=groups.map((g,i)=>g.some(filled)?"":ANY_OF_LABEL[kind][i]).filter(Boolean);
  // 借款科目在金标身份槽里已经报过，本工具的「借款科目」组不再重复报。
  return [...new Set([...gold,...own])];
 }
 const required=kind==="ledger"?["loanId","openingPrincipal","closingPrincipal","rateType"]:["loanId","rateType"];
 return required.filter(x=>!filled(x)).map(x=>LABELS[kind][x]);
}

export function LoanInterestPage({tool}:{tool:ToolManifest}){
 const empty=():Source=>({path:"",mapping:{}}); const [mode,setMode]=useState<Mode>("ledger"); const [sources,setSources]=useState<Record<Kind,Source>>({ledger:empty(),tb:empty(),je:empty(),rateLedger:empty()});
 const [reportStart,setReportStart]=useState("");const [reportEnd,setReportEnd]=useState("");const [outputPath,setOutputPath]=useState("");const [rows,setRows]=useState<LoanRow[]>([]);const [result,setResult]=useState<Record<string,unknown>>();const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [job,setJob]=useState<JobEvent>();const activeJob=useRef("");
 useEffect(()=>{const stop=listenJobEvents(e=>{if(e.jobId!==activeJob.current)return;setJob(e);if(e.phase==="completed"){setBusy(false);const next=e.result as Record<string,unknown>;setResult(next);setRows((next.rows??[]) as LoanRow[])}else if(e.phase==="failed"||e.phase==="cancelled"){setBusy(false);const p=e.result as {error?:{userMessage?:string}}|undefined;setError(p?.error?.userMessage??e.message)}});return()=>{void stop.then(x=>x())}},[]);
 const setSource=(kind:Kind,next:Partial<Source>)=>setSources(v=>({...v,[kind]:{...v[kind],...next}}));
 const activeKinds:Kind[]=mode==="ledger"?["ledger"]:["tb","je"];
 async function browse(kind:Kind){const picked=await pickPath("file","选择表格文件",["xlsx","xls","xlsm","csv","txt","tsv"]);if(typeof picked!=="string")return;setSource(kind,{path:picked,inspection:undefined,mapping:{}});await inspect(kind,picked)}
 async function inspect(kind:Kind,path=sources[kind].path,over?:Partial<Inspection>){setBusy(true);setError("");try{const old=sources[kind].inspection;const x=await engineCall("loan.inspect",{kind,source:{inputPath:path,sheet:over?.sheet??old?.sheet??"",headerRow:over?.headerRow??old?.headerRow??0,headerDepth:1}}) as Inspection;setSource(kind,{path,inspection:x,mapping:x.suggestedMapping})}catch(e){setError(errorText(e))}finally{setBusy(false)}}
 function source(kind:Kind){const x=sources[kind];return x.path?{source:{inputPath:x.path,sheet:x.inspection?.sheet??"",headerRow:x.inspection?.headerRow??1,headerDepth:1},mapping:x.mapping}:undefined}
 function payload(){return{mode,reportStart,reportEnd,ledgerSource:source("ledger"),tbSource:source("tb"),jeSource:source("je"),rateLedgerSource:source("rateLedger"),rateOverrides:Object.fromEntries(rows.map(r=>[r.loanId,{rateType:r.rateType,fixedRate:r.fixedRate,benchmarkRate:r.benchmarkRate,spreadBps:r.spreadBps}])),...(outputPath?{outputPath}:{})}}
 async function run(method:"loan.preview"|"loan.export"){setError("");if(!reportStart||!reportEnd)return setError("请选择测算期间。");for(const kind of activeKinds){if(!sources[kind].inspection)return setError(`请先上传并识别${kind.toUpperCase()}。`);const missing=loanMissing(kind,sources[kind].mapping);if(missing.length)return setError(`${kind.toUpperCase()}尚未映射：${missing.join("、")}。`)}setBusy(true);try{activeJob.current=await jobStart(method,payload())}catch(e){setBusy(false);setError(errorText(e))}}
 return <main className="tool-page fx-page loan-page"><PageHeader eyebrow="借款审计" title={tool.name} detail="从完整借款台账直接重算，或以 TB＋JE 模糊还原逐笔本金变动后测算利息。"/><ErrorBox error={error} onDismiss={()=>setError("")}/>
 <section className="fx-mode-bar"><button className={mode==="ledger"?"active":""} onClick={()=>{setMode("ledger");setRows([])}}>以借款台账为基准</button><button className={mode==="tb"?"active":""} onClick={()=>{setMode("tb");setRows([])}}>以 TB 为基准</button></section>
 {mode==="tb"&&<section className="loan-warning"><strong>TB＋JE 生成的是待复核的推算台账</strong><span>系统按借款科目、辅助明细、摘要和记账日期模糊匹配本金新增/减少；请核对匹配依据、日期和勾稽差异。</span></section>}
 <Card><CardHeader><CardTitle>{mode==="ledger"?"上传完整借款台账":"上传 TB 与 JE"}</CardTitle></CardHeader><CardContent><p className="fx-hint">上传、表头识别和字段映射沿用汇兑损益测算的交互方式。</p><div className="loan-upload-grid">{activeKinds.map(k=><Upload key={k} kind={k} source={sources[k]} busy={busy} browse={()=>void browse(k)} clear={()=>setSource(k,empty())}/>)}</div></CardContent></Card>
 {activeKinds.map(k=>sources[k].inspection&&<Mapping key={k} kind={k} source={sources[k]} busy={busy} change={mapping=>setSource(k,{mapping})} header={(sheet,row)=>void inspect(k,undefined,{sheet,headerRow:row})}/>) }
 {mode==="tb"&&<Card><CardHeader><CardTitle>补充借款利率（可选）</CardTitle></CardHeader><CardContent><p className="fx-hint">可上传客户借款台账自动补充；未匹配利率可在变动表中逐笔手工填写。</p><Upload kind="rateLedger" source={sources.rateLedger} busy={busy} browse={()=>void browse("rateLedger")} clear={()=>setSource("rateLedger",empty())}/></CardContent></Card>}
 {sources.rateLedger.inspection&&<Mapping kind="rateLedger" source={sources.rateLedger} busy={busy} change={mapping=>setSource("rateLedger",{mapping})} header={(sheet,row)=>void inspect("rateLedger",undefined,{sheet,headerRow:row})}/>}
 <Card><CardHeader><CardTitle>测算与底稿</CardTitle></CardHeader><CardContent><div className="loan-run-grid"><label>期间开始<input type="date" value={reportStart} onChange={e=>setReportStart(e.target.value)}/></label><label>期间结束<input type="date" value={reportEnd} onChange={e=>setReportEnd(e.target.value)}/></label><label>输出文件<input value={outputPath} readOnly placeholder="默认保存到源文件目录"/></label><Button variant="secondary" onClick={async()=>{const p=await pickPath("save","保存底稿",["xlsx"],"借款利息审计测算.xlsx");if(typeof p==="string")setOutputPath(p)}}>选择位置</Button></div><p className="fx-rate-note">浮动利率按“基准利率＋加/减点（BP÷10,000）”自动换算有效年利率。</p><div className="fx-actions"><Button variant="secondary" disabled={busy} onClick={()=>void run("loan.preview")}>{mode==="tb"?"生成并复核借款变动表":"测算预览"}</Button><Button disabled={busy} onClick={()=>void run("loan.export")}>生成 Excel 底稿</Button></div>{job&&<JobProgress job={job} onCancel={busy?id=>void jobCancel(id):undefined}/>}</CardContent></Card>
 {rows.length>0&&<Results rows={rows} setRows={setRows} result={result}/>}</main>
}
function Upload({kind,source,busy,browse,clear}:{kind:Kind;source:Source;busy:boolean;browse:()=>void;clear:()=>void}){const name=kind==="ledger"?"完整借款台账":kind==="rateLedger"?"借款利率台账":kind.toUpperCase();return <div className="loan-upload"><b>{name}</b><FileDropInput value={source.path} disabled={busy} placeholder={`选择${name}文件`} onBrowse={browse} onClear={clear} onDragStateChange={()=>{}}/>{source.inspection&&<small>已识别 {source.inspection.rowCount} 行 · {source.inspection.sheet}</small>}</div>}
function Mapping({kind,source,busy,change,header}:{kind:Kind;source:Source;busy:boolean;change:(m:Record<string,string>)=>void;header:(s:string,r:number)=>void}){
 const x=source.inspection!;
 // TB/JE 走共用的映射复核；借款台账与利率台账不是账表，没有对应的复核规则。
 const [review,setReview]=useState("");const [reviewing,setReviewing]=useState(false);
 const reviewable=kind==="tb"||kind==="je";
 async function runReview(){
  setReviewing(true);setReview("正在复核字段映射…");
  try{
   const {mapping,applied}=await applyLedgerReviewToDict(engineCall,kind as "je"|"tb",x.headers,x.preview,source.mapping,LABELS[kind]);
   change(mapping as Record<string,string>);
   setReview(applied.length?`复核完成，已应用 ${applied.length} 项建议。`:"复核完成，当前映射无需调整。");
  }catch(e){setReview(`${errorText(e)} 可继续手工映射。`);}
  finally{setReviewing(false);}
 }
 const name=kind==="ledger"?"借款台账":kind==="rateLedger"?"利率台账":kind.toUpperCase();
 return <>
  <MappingPanel
   title={`${name}字段映射`}
   note={`${x.rowCount} 行 × ${x.headers.length} 列`}
   headers={x.headers}
   rows={x.preview}
   mapping={source.mapping}
   roles={Object.entries(LABELS[kind])}
   missing={loanMissing(kind,source.mapping)}
   busy={busy||reviewing}
   maxHeight={360}
   toolbar={<>
    <label>Sheet<select value={x.sheet} onChange={e=>header(e.target.value,0)}>{x.sheets.map(s=><option key={s}>{s}</option>)}</select></label>
    <label>标题行<input type="number" min={1} value={x.headerRow} onChange={e=>header(x.sheet,Number(e.target.value))}/></label>
    {reviewable&&<Button variant="secondary" size="sm" disabled={busy||reviewing} onClick={()=>void runReview()}>{reviewing?"复核中…":"LLM 复核映射"}</Button>}
   </>}
   onChange={next=>change(next as Record<string,string>)}
  />
  {review&&<p className="fx-hint">{review}</p>}
 </>;
}
function Results({rows,setRows,result}:{rows:LoanRow[];setRows:React.Dispatch<React.SetStateAction<LoanRow[]>>;result?:Record<string,unknown>}){const total=rows.reduce((s,r)=>s+Number(r.calculatedInterest??0),0);return <section className="loan-results"><div className="fx-result-heading"><div><h3>借款本金变动与利息测算</h3><p>期初＋本期增加－本期减少＝期末；请优先处理待复核行。</p></div>{((result?.outputPaths??[])as string[]).map(p=><Button key={p} variant="secondary" onClick={()=>void openOutput(p)}>打开 Excel 底稿</Button>)}</div><div className="loan-summary"><span>借款笔数<strong>{rows.length}</strong></span><span>测算利息合计<strong>{total.toLocaleString("zh-CN",{minimumFractionDigits:2})}</strong></span><span>待复核<strong>{rows.filter(r=>r.matchStatus!=="已匹配").length}</strong></span></div><div className="loan-rate-table"><table><thead><tr><th>借款标识</th><th>期初</th><th>增加</th><th>减少</th><th>期末</th><th>勾稽差异</th><th>利率类型</th><th>固定/基准利率</th><th>加点 BP</th><th>有效利率</th><th>测算利息</th><th>匹配状态</th></tr></thead><tbody>{rows.map((r,i)=><tr key={`${r.loanId}-${i}`}><td title={r.matchBasis}>{r.loanId}</td>{[r.openingPrincipal,r.additions,r.reductions,r.closingPrincipal,loanEquation(r)].map((n,j)=><td key={j}>{Number(n).toLocaleString()}</td>)}<td><select value={r.rateType} onChange={e=>setRows(v=>v.map((x,j)=>j===i?{...x,rateType:e.target.value as LoanRow["rateType"]}:x))}><option value="fixed">固定</option><option value="floating">浮动</option></select></td><td><input type="number" step=".0001" value={r.rateType==="fixed"?r.fixedRate??"":r.benchmarkRate??""} onChange={e=>setRows(v=>v.map((x,j)=>j===i?{...x,...(x.rateType==="fixed"?{fixedRate:Number(e.target.value)}:{benchmarkRate:Number(e.target.value)})}:x))}/></td><td><input type="number" disabled={r.rateType!=="floating"} value={r.spreadBps??0} onChange={e=>setRows(v=>v.map((x,j)=>j===i?{...x,spreadBps:Number(e.target.value)}:x))}/></td><td>{(loanEffectiveRate(r.rateType,r.fixedRate,r.benchmarkRate,r.spreadBps)*100).toFixed(4)}%</td><td>{Number(r.calculatedInterest??0).toLocaleString()}</td><td><span className={r.matchStatus==="已匹配"?"loan-ok":"loan-review"}>{r.matchStatus??"—"}</span></td></tr>)}</tbody></table></div><p className="fx-rate-note">修改利率后请再次测算，利息将按新利率更新。</p></section>}
function errorText(v:unknown){if(v instanceof Error)return v.message;if(typeof v==="string")return v;if(v&&typeof v==="object"){const x=v as Record<string,unknown>;return String(x.userMessage??x.message??x.detail??"处理失败。")}return"处理失败。"}
