// 凭证映射的共享逻辑：看账工具与正负数凭证标记共用同一套字段角色、
// 金额方案取舍和 LLM 复核判定，避免两个工具的口径各自漂移。
// 角色名与统一内核一致（`functionalAmount` 而不是 `amount`）——五个工具的映射
// 从此是同一个形状：角色名 → 列名或列名数组，通用面板可以直接消费。
export type Mapping = { id: string[]; accountCode?: string; accountName: string[]; entity?: string; date?: string; summary?: string; functionalAmount?: string; direction?: string; functionalDebit?: string; functionalCredit?: string };
export type Inspect = { headers: string[]; preview: string[][]; sheets?: string[]; selectedSheet?: string; suggestedMapping?: Mapping; accounts?: string[]; accountCodes?: string[]; accountCount?: number; dimensions?: { rows: number; columns: number } };
export type Review = { role: keyof Mapping; currentColumn?: string; suggestedColumn: string; confidence?: number; reason?: string };
export const EMPTY_MAPPING: Mapping = { id: [], accountName: [] };
// 组成科目键的列，顺序固定：**编码在前、名称在后**。下游按这个顺序用 "-" 把几列
// 拼成一个科目值，顺序一变，用户已经选好的目标科目就全部对不上。
// Rust 侧 `LedgerMapping::account_columns` 必须保持同序。
export function accountColumns(mapping:Mapping):string[]{
  const out:string[]=[];
  for(const value of [mapping.accountCode,...(mapping.accountName??[])]){
    const item=value?.trim();
    if(item&&!out.includes(item))out.push(item);
  }
  return out;
}

// 金标（`汇兑损益测试资料/TB-4800.xlsx` 的 `je种类` / `tb种类` 两张表）要求的身份字段。
// 一份合格的账表应该有这些列，缺了就拦——与各工具自己声明的必填取并集。
// `entity` 不在其中：金标 2026-08-24 修订时把它降为可选，汇兑损益仍自己要求它。
// **Rust 侧 `ledger_mapping::identity_required` 是同一份，两边必须一致。**
export const GOLD_IDENTITY:Record<"je"|"tb",string[]>={
  je:["date","id","accountCode","accountName","summary"],
  tb:["accountCode","accountName"],
};
const GOLD_LABELS:Record<string,string>={date:"记账日期",id:"凭证识别字段",accountCode:"科目编码",accountName:"科目名称",summary:"摘要"};
/** 金标身份槽的缺失清单。传入判断某角色是否已映射的函数，兼容各工具不同的映射结构。 */
export function missingGoldIdentity(kind:"je"|"tb",has:(role:string)=>boolean):string[]{
  return GOLD_IDENTITY[kind].filter(role=>!has(role)).map(role=>GOLD_LABELS[role]??role);
}

/** 统一复核入口返回的一条建议。 */
export type LedgerChange={role:string;currentColumn?:string;suggestedColumn:string;confidence?:number;reason?:string};
/**
 * 调用共用的映射复核，把够把握的建议应用到通用字典型映射上。
 *
 * 汇兑损益、存款利息、借款利息用的都是「角色名 → 列名」的字典，与看账那套
 * 强类型结构不同，所以单独一个入口；纪律、卫生过滤在后端已经统一。
 * 后端已按冲突词、占用、置信度过滤过一轮，这里只做两件后端做不了的事：
 * 丢掉本工具不认识的角色，以及丢掉指向表里不存在的列的建议。
 */
export async function applyLedgerReviewToDict(
  call:(method:string,params:Record<string,unknown>)=>Promise<unknown>,
  kind:"je"|"tb",
  headers:string[],
  sampleRows:string[][],
  current:Record<string,string|string[]>,
  labels:Record<string,string>,
):Promise<{mapping:Record<string,string|string[]>;applied:LedgerChange[]}>{
  const response=await call("ledger.review_mapping",{kind,payload:{
    headers,sampleRows:sampleRows.slice(0,8),currentMapping:current,
    availableRoles:Object.keys(labels),
  }}) as {changes?:LedgerChange[]};
  const next={...current};
  const applied:LedgerChange[]=[];
  for(const change of response.changes??[]){
    const column=change?.suggestedColumn?.trim();
    if(!column||!(change.role in labels)||!headers.includes(column))continue;
    if((change.confidence??1)<AUTO_APPLY_MIN)continue;
    // 同一列已被别的角色占用就跳过——一列只承载一个语义。
    if(Object.entries(next).some(([role,value])=>role!==change.role&&(Array.isArray(value)?value.includes(column):value===column)))continue;
    next[change.role]=column;
    applied.push(change);
  }
  return {mapping:next,applied};
}

export const ledgerErrorText=(error:unknown)=>{if(error instanceof Error)return error.message;if(error&&typeof error==="object"){const value=error as Record<string,unknown>;return String(value.userMessage??value.message??value.detail??"操作失败，请查看日志诊断。");}return String(error);};

export function setKanzhangMapping(current:Mapping,key:keyof Mapping,value:string|string[]):Mapping{const next={...current,[key]:value||undefined};if(key==="functionalAmount"||key==="direction"){next.functionalDebit=undefined;next.functionalCredit=undefined;}if(key==="functionalDebit"||key==="functionalCredit"){next.functionalAmount=undefined;next.direction=undefined;}return next;}

// 完成态保留结果摘要即可。若继续把上一轮筛选/导出的 100% 进度条画出来，
// 用户刚进入导出页时会误以为本轮导出已经完成。
export const shouldShowKanzhangJobProgress=(phase?:string)=>Boolean(phase&&!['completed','failed','cancelled'].includes(phase));

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
export const KZ_ROLE_LABELS:Record<keyof Mapping,string>={id:"凭证编号",accountCode:"科目编码",accountName:"科目名称",entity:"公司/核算主体",date:"日期",summary:"摘要",functionalAmount:"方案A-金额",direction:"方案A-方向",functionalDebit:"方案B-借方",functionalCredit:"方案B-贷方"};
export const isMultiRole=(role:keyof Mapping):role is "id"|"accountName"=>role==="id"||role==="accountName";
// 预览表头下拉里的角色顺序，两个工具共用同一份，必填项标 true。
// 科目编码与科目名称各自标 false：单独看谁都不是必填，但两者至少要映射一列，
// 这条口径由 missingKanzhangRequiredRoles 统一判。
export const LEDGER_ROLES:([keyof Mapping,string,boolean])[]=[["id","凭证编号",true],["accountCode","科目编码",false],["accountName","科目名称",false],["entity","公司/主体",false],["date","日期",false],["summary","摘要",false],["functionalAmount","方案A-金额",false],["direction","方案A-方向",false],["functionalDebit","方案B-借方",false],["functionalCredit","方案B-贷方",false]];
// LLM 回来的 role 要翻译成本页面用的键。复核提示词与汇兑损益共用同一份纪律，
// 那份用的是统一内核的标准角色名（functionalAmount、functionalDebit…），
// 而这两个工具的映射结构沿用简写（amount、debit…）；科目原先还是单一的 account。
// 认不出的整条丢弃——否则会往 mapping 里写进一个界面既显示不出、也撤销不掉的野字段。
const LEDGER_ROLE_KEYS=new Set<string>(LEDGER_ROLES.map(([key])=>key));
// 角色名已与内核统一，这里只剩「旧名 → 标准名」的历史兼容。
const ROLE_ALIASES:Record<string,keyof Mapping>={
  account:"accountCode",
  amount:"functionalAmount",
  debit:"functionalDebit",
  credit:"functionalCredit",
};
export function normalizeLedgerRole(role?:string):keyof Mapping|undefined{
  const key=role?.trim();
  if(!key)return undefined;
  const alias=ROLE_ALIASES[key];
  if(alias)return alias;
  return LEDGER_ROLE_KEYS.has(key)?key as keyof Mapping:undefined;
}
// 与 Rust `validate_kanzhang_mapping` 保持同一必填口径：**金标身份槽 ∪ 本工具必填**。
// 本工具自己要的是凭证 ID，以及方案 A 的金额列或方案 B 的借贷两列（方向列是选填）；
// 金标另要求记账日期、科目编码、科目名称、摘要——缺了同样拦，只是理由不同。
export function missingKanzhangRequiredRoles(mapping:Mapping):string[]{
  const has=(role:string)=>{
    if(role==="id")return mapping.id.some(value=>Boolean(value?.trim()));
    if(role==="accountCode")return Boolean(mapping.accountCode?.trim());
    if(role==="accountName")return mapping.accountName.some(value=>Boolean(value?.trim()));
    return Boolean(String(mapping[role as keyof Mapping]??"").trim());
  };
  // 凭证识别字段已在金标身份槽里，不再用「唯一识别码 (ID)」这个旧叫法重复报一次。
  const missing:string[]=missingGoldIdentity("je",has);
  const hasAmount=Boolean(mapping.functionalAmount?.trim());
  const hasDebitCredit=Boolean(mapping.functionalDebit?.trim()&&mapping.functionalCredit?.trim());
  if(!hasAmount&&!hasDebitCredit)missing.push("金额字段（方案A-金额，或方案B-借方和贷方）");
  return [...new Set(missing)];
}
export const formatMappingValue=(value?:string|string[]):string=>{
  if(Array.isArray(value)){const items=value.map(item=>item?.trim()).filter(Boolean);return items.length?items.join("、"):"未映射";}
  return typeof value==="string"&&value.trim()?value.trim():"未映射";
};
export const isSameMappingValue=(a?:string|string[],b?:string|string[]):boolean=>formatMappingValue(a)===formatMappingValue(b);
// 金额口径二选一：方案A（金额+方向）和方案B（借方+贷方）只能生效一套。
// 一旦其中一套映射成功，另一套既不该让用户手动选，LLM 也不该再对它提建议——
// 它显示的"未映射"是方案取舍的结果，不是漏填。
const SCHEME_A_ROLES:(keyof Mapping)[]=["functionalAmount","direction"];
const SCHEME_B_ROLES:(keyof Mapping)[]=["functionalDebit","functionalCredit"];
const hasValue=(value?:string)=>Boolean(value&&value.trim());
export function activeAmountScheme(mapping:Mapping):"A"|"B"|undefined{
  const a=hasValue(mapping.functionalAmount)||hasValue(mapping.direction);
  const b=hasValue(mapping.functionalDebit)||hasValue(mapping.functionalCredit);
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
// LLM 复核结果的应用：把握够的直接改（进变更清单，可撤销），把握不足的交回用户。
// 看账与正负数凭证标记必须完全一致，所以放在这里由两个页面共用。
export type LedgerReviewResponse={scheme?:string;schemeReason?:string;fills?:Review[];reviews?:Review[]};
export function applyLedgerReviews(source:Mapping,value:LedgerReviewResponse):{mapping:Mapping;changes:MappingChange[];pending:Review[]}{
  let next={...source};
  const applied:MappingChange[]=[];
  const waiting:Review[]=[];
  for(const raw of [...(value.fills??[]),...(value.reviews??[])]){
    const role=normalizeLedgerRole(raw?.role);
    const column=raw?.suggestedColumn?.trim();
    if(!role||!column)continue;
    const item:Review={...raw,role,suggestedColumn:column};
    // 另一套金额方案已经映射成功，对它的建议一律丢弃，不进清单也不提示。
    if(isRedundantKanzhangReview(next,item)||isSchemeLockedRole(next,role))continue;
    if(!shouldAutoApply(item.confidence)){waiting.push(item);continue;}
    const before=next[role];const after=isMultiRole(role)?[column]:column;
    next={...next,[role]:after};
    applied.push({role,before,after,source:formatMappingValue(before)==="未映射"?"fill":"replace",reason:item.reason,confidence:item.confidence});
  }
  // 方案还没定下来时才听 LLM 的；已经有一套映射成功就不许它反过来清空。
  const dropped:(keyof Mapping)[]=activeAmountScheme(source)?[]:value.scheme==="A"?["functionalDebit","functionalCredit"]:value.scheme==="B"?["functionalAmount","direction"]:[];
  for(const role of dropped){
    const before=next[role];
    if(typeof before==="string"&&before.trim())applied.push({role,before,after:undefined,source:"scheme",reason:value.schemeReason?.trim()||`LLM 判定为方案${value.scheme}，已清除与之互斥的字段映射。`});
    next={...next,[role]:undefined};
  }
  const pending=waiting.filter(item=>!isRedundantKanzhangReview(next,item)&&!isSchemeLockedRole(next,item.role));
  return {mapping:next,changes:mergeMappingChanges(applied),pending};
}
export function undoMappingChange(mapping:Mapping,change:MappingChange):Mapping{
  const multi=isMultiRole(change.role);
  const before=change.before;
  const wasEmpty=multi?!(Array.isArray(before)&&before.length):!(typeof before==="string"&&before.trim());
  // 撤销"补充"只需清掉该字段；走 setKanzhangMapping 会连带清空互斥字段，反而破坏其他映射。
  if(wasEmpty)return {...mapping,[change.role]:multi?[]:undefined};
  return setKanzhangMapping(mapping,change.role,before as string|string[]);
}
