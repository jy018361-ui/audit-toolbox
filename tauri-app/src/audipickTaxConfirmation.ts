import { canProcessTaxType, type TaxDocumentIndex, type TaxForm, type TaxPage } from "./audipickTax";
import { isTaxReviewCurrent, validateTaxReviewGroup, validateTaxReviewGroupsStructure, type TaxReviewGroup } from "./audipickTaxReview";

/** Accept the visible predictions without guessing unknown pages or changing manual ownership. */
export function buildTaxReviewConfirmation(index:TaxDocumentIndex, existing:TaxReviewGroup[], catalogue:TaxForm[], createId:()=>string) {
  validateTaxReviewGroupsStructure(index,existing);
  const groups=[...existing], addedFormKeys=new Set<string>(), confirmed=new Set<number>();
  const supporting=(page:TaxPage)=>["receipt","cover","directory"].includes(page.kind);
  const compatible=(key:string)=>catalogue.some(form=>form.key===key&&canProcessTaxType(form.taxType)&&(index.taxType==="mixed"||index.taxType===form.taxType));
  const exactForm=(key:string,pages:number[])=>index.forms.some(form=>form.key===key&&form.pages.length===pages.length&&form.pages.every(number=>pages.includes(number)))&&pages.every(number=>index.pages.some(page=>page.page===number&&page.formKey===key&&page.confidence==="high"&&(page.kind==="form"||page.kind==="continuation")));
  function accept(group:TaxReviewGroup) {
    const stamped=validateTaxReviewGroup(index,group,groups);
    const position=groups.findIndex(item=>item.id===group.id);
    if(position<0) groups.push(stamped);else groups[position]=stamped;
    stamped.pages.forEach(number=>confirmed.add(number));
    if(stamped.status==="confirmed") addedFormKeys.add(stamped.formKey);
  }
  for(const group of existing) {
    if(isTaxReviewCurrent(index,group)) continue;
    const matches=group.status==="excluded"
      ?group.pages.every(number=>index.pages.some(page=>page.page===number&&supporting(page)))
      :compatible(group.formKey)&&exactForm(group.formKey,group.pages);
    if(matches) accept(group);
  }
  const occupied=new Set(existing.flatMap(group=>group.pages));
  for(const form of index.forms) {
    if(!index.companyName.trim()||!index.period.trim()||!compatible(form.key)||form.pages.some(number=>occupied.has(number))||!exactForm(form.key,form.pages)) continue;
    accept({id:createId(),formKey:form.key,companyName:index.companyName,period:index.period,pages:[...form.pages],status:"confirmed"});
    form.pages.forEach(number=>occupied.add(number));
  }
  const excluded=index.pages.filter(page=>!occupied.has(page.page)&&supporting(page)).map(page=>page.page);
  if(excluded.length) accept({id:createId(),formKey:"",companyName:index.companyName,period:index.period,pages:excluded,status:"excluded"});
  return {groups,addedFormKeys:[...addedFormKeys],confirmedPages:confirmed.size,skippedPages:index.pages.length-confirmed.size};
}
