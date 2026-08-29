import { MappingPanel, type MappingDict } from "@/components/MappingPanel";
import { isMultiRole, isSchemeLockedRole, LEDGER_ROLES, missingKanzhangRequiredRoles, type Inspect, type Mapping } from "@/ledgerMapping";
import { describeForm, formGroups, resolveForm, roleRequirement, useLedgerForms } from "@/ledgerForms";

/**
 * 凭证文件预览表：表头下方内嵌字段角色下拉，用户可直接改映射。
 *
 * 看账与正负数凭证标记共用，两处的映射交互必须完全一致——现在连组件都共用：
 * 这里只把本工具的角色清单、多列角色和方案互斥规则喂给通用的 [`MappingPanel`]。
 */
const MULTI = new Set(LEDGER_ROLES.map(([key]) => key).filter((key) => isMultiRole(key)));

export function LedgerMappingPreview({inspect,mapping,setMap,llmBusy,headerExtras,maxHeight=380}:{inspect?:Inspect;mapping?:Mapping;setMap?:(key:keyof Mapping,value:string|string[])=>void;llmBusy?:boolean;headerExtras?:(header:string)=>React.ReactNode;maxHeight?:number}){
  // 序时账三型的判定：下拉分组与必填标记跟着当前命中的型走。
  // hook 必须在提前 return 之前调用。
  const forms=useLedgerForms("je");
  const roles:[string,string][]=LEDGER_ROLES.map(([key,label])=>[key,label]);
  const labelOf=new Map(roles);
  const match=forms.length&&mapping?resolveForm("je",forms,mapping as Record<string,string|string[]|undefined>):undefined;
  if(!inspect)return <section className="kz-card kz-preview"><h2>文件预览</h2><p>读取后显示前 50 行。</p></section>;
  const editable=Boolean(mapping&&setMap);
  return <MappingPanel
    title="文件预览"
    note={`${inspect.dimensions?.rows??0} 行 × ${inspect.dimensions?.columns??0} 列`}
    headers={inspect.headers}
    rows={inspect.preview}
    mapping={(mapping??{}) as MappingDict}
    roles={roles}
    groups={formGroups("je",roles,forms,match)}
    requirementOf={role=>roleRequirement(match,role)}
    formNote={describeForm(match,role=>labelOf.get(role)??role)}
    multi={MULTI}
    isLocked={role=>mapping?isSchemeLockedRole(mapping,role as keyof Mapping):false}
    missing={mapping?missingKanzhangRequiredRoles(mapping):[]}
    busy={llmBusy}
    headerExtras={headerExtras}
    maxHeight={maxHeight}
    onChange={next=>{
      if(!editable||!mapping||!setMap)return;
      // 逐个角色比对差异后回写——setMap 带着方案互斥的副作用，必须走它。
      for(const [role] of LEDGER_ROLES){
        const before=mapping[role as keyof Mapping];
        const after=next[role];
        const same=Array.isArray(before)&&Array.isArray(after)
          ? before.length===after.length&&before.every((item,index)=>item===after[index])
          : String(before??"")===String(after??"");
        if(!same)setMap(role as keyof Mapping,(after??(Array.isArray(before)?[]:"")) as string|string[]);
      }
    }}
  />;
}
