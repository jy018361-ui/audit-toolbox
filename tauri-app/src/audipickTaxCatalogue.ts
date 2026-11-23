import type { TaxForm, TaxType } from "./audipickTax";

export type TaxFormDefinition = Omit<TaxForm, "pages"> & { titleAliases: string[] };

/**
 * Form titles are matched independently of form numbers: some declarations
 * reuse appendix numbers across taxpayer types and pilot versions.
 * Official references (accessed 2026-11-10):
 * - https://12366.chinatax.gov.cn/bzds/009/009.html
 * - https://12366.chinatax.gov.cn/bzds/003/003.html
 * - https://12366.chinatax.gov.cn/bzds/124/124.html
 * - https://guangdong.chinatax.gov.cn/siteapps/webpage/gdtax/bszn/bdxz/content.jsp?code=95B76568FDCF1DB8E053D01F1296F105
 * - https://shanghai.chinatax.gov.cn/bsfw/xzzx/bgxz/sbzsl/202502/t475113.html
 * - https://shanghai.chinatax.gov.cn/zcfw/zcfgk/zzs/202606/t480523.html
 * - https://tianjin.chinatax.gov.cn/11200000000/0300/030004/03000402/20261103162117637.shtml
 * - https://zhejiang.chinatax.gov.cn/art/2026/4/8/art_26348_652806.html
 */
const definitions: TaxFormDefinition[] = [
  { key: "vat_main_pilot_2026", formCode: "VAT_PILOT_2026_MAIN", formName: "增值税及附加税费申报表（试行）主表", taxType: "vat", titleAliases: ["增值税及附加税费申报表（试行）", "增值税及附加税费申报表主表（试行）", "增值税及附加税费申报表（试行）主表", "增值税及附加税费申报表主表"] },
  { key: "vat_pilot_2026_business_info", formCode: "VAT_PILOT_2026_BUSINESS_INFO", formName: "增值税及附加税费申报表业务信息表", taxType: "vat", titleAliases: ["增值税及附加税费申报表业务信息表"] },
  ...[
    ["一", "本期销售情况明细表"], ["二", "本期进项情况明细表"],
  ].map(([number, description]) => ({ key: `vat_pilot_2026_appendix_${number}`, formCode: `VAT_PILOT_2026_APPENDIX_${number}`, formName: `增值税及附加税费申报表附列资料（${number}）（${description}）`, taxType: "vat" as const, titleAliases: [`增值税及附加税费申报表（试行）附列资料（${number}）`, `增值税及附加税费申报表附列资料（${number}）（试行）`] })),
  { key: "vat_pilot_2026_appendix_1_attachment_1", formCode: "VAT_PILOT_2026_APPENDIX_1_ATTACHMENT_1", formName: "附列资料（一）附1：未开具发票销售情况明细", taxType: "vat", titleAliases: ["附列资料（一）附1未开具发票销售情况明细", "附列资料(一)附1未开具发票销售情况明细", "附1未开具发票销售情况明细"] },
  { key: "vat_pilot_2026_appendix_1_attachment_2", formCode: "VAT_PILOT_2026_APPENDIX_1_ATTACHMENT_2", formName: "附列资料（一）附2：扣除项目明细", taxType: "vat", titleAliases: ["附列资料（一）附2扣除项目明细", "附列资料(一)附2扣除项目明细", "附2扣除项目明细"] },
  { key: "vat_pilot_2026_appendix_1_attachment_3", formCode: "VAT_PILOT_2026_APPENDIX_1_ATTACHMENT_3", formName: "附列资料（一）附3：简易计税明细", taxType: "vat", titleAliases: ["附列资料（一）附3简易计税明细", "附列资料(一)附3简易计税明细", "附3简易计税明细"] },
  { key: "vat_pilot_2026_appendix_2_attachment_1", formCode: "VAT_PILOT_2026_APPENDIX_2_ATTACHMENT_1", formName: "附列资料（二）附1：本期加计抵减情况明细", taxType: "vat", titleAliases: ["附列资料（二）附1本期加计抵减情况明细", "附列资料(二)附1本期加计抵减情况明细", "附1本期加计抵减情况明细"] },
  { key: "vat_pilot_2026_appendix_3_small", formCode: "VAT_PILOT_2026_APPENDIX_3_SMALL", formName: "增值税及附加税费申报表附列资料（三）（附加税费情况表，小规模纳税人适用）", taxType: "vat", titleAliases: ["增值税及附加税费申报表附列资料（三）（附加税费情况表（小规模纳税人适用））", "附加税费情况表（小规模纳税人适用）"] },
  { key: "vat_pilot_2026_appendix_3_general", formCode: "VAT_PILOT_2026_APPENDIX_3_GENERAL", formName: "增值税及附加税费申报表附列资料（三）（附加税费情况表，一般纳税人适用）", taxType: "vat", titleAliases: ["增值税及附加税费申报表附列资料（三）（附加税费情况表（一般纳税人适用））", "附加税费情况表（一般纳税人适用）"] },
  { key: "vat_pilot_2026_relief", formCode: "VAT_PILOT_2026_RELIEF", formName: "增值税减免税申报明细表（试行）", taxType: "vat", titleAliases: ["增值税减免税申报明细表（试行）"] },
  { key: "vat_main", formCode: "VAT_MAIN", formName: "增值税及附加税费申报表（一般纳税人适用）", taxType: "vat", titleAliases: ["增值税及附加税费申报表（一般纳税人适用）", "增值税及附加税费申报表(一般纳税人适用)", "增值税纳税申报表（一般纳税人适用）", "增值税纳税申报表(一般纳税人适用)"] },
  { key: "vat_main_small", formCode: "VAT_MAIN_SMALL", formName: "增值税及附加税费申报表（小规模纳税人适用）", taxType: "vat", titleAliases: ["增值税及附加税费申报表（小规模纳税人适用）", "增值税及附加税费申报表(小规模纳税人适用)", "增值税纳税申报表（小规模纳税人适用）", "增值税纳税申报表(小规模纳税人适用)"] },
  { key: "vat_small_appendix_1", formCode: "VAT_SMALL_APPENDIX_1", formName: "增值税及附加税费申报表（小规模纳税人适用）附列资料（一）", taxType: "vat", titleAliases: ["增值税及附加税费申报表（小规模纳税人适用）附列资料（一）", "增值税及附加税费申报表(小规模纳税人适用)附列资料(一)", "增值税纳税申报表（小规模纳税人适用）附列资料（一）"] },
  ...[
    ["一", "销售情况明细"], ["二", "进项税额明细"], ["三", "服务、不动产和无形资产扣除项目明细"],
    ["四", "税额抵减情况表"], ["五", "附加税费情况表"],
  ].map(([number, description], i) => ({ key: `vat_appendix_${i + 1}`, formCode: `VAT_APPENDIX_${i + 1}`, formName: `增值税及附加税费申报表附列资料（${number}）（${description}）`, taxType: "vat" as const, titleAliases: [`增值税及附加税费申报表附列资料（${number}）`, `增值税及附加税费申报表附列资料(${number})`, `附列资料（${number}）`, ...(number === "二" ? ["增值税纳税申报表附列资料（表二）", "增值税纳税申报表附列资料(表二)"] : [])] })),
  { key: "vat_small_appendix_2", formCode: "VAT_SMALL_APPENDIX_2", formName: "增值税及附加税费申报表（小规模纳税人适用）附列资料（二）（附加税费情况表）", taxType: "vat", titleAliases: ["增值税及附加税费申报表（小规模纳税人适用）附列资料（二）", "增值税及附加税费申报表(小规模纳税人适用)附列资料(二)"] },
  { key: "vat_historical_real_estate_deduction", formCode: "VAT_HISTORICAL_REAL_ESTATE_DEDUCTION", formName: "不动产分期抵扣计算表（历史表单）", taxType: "vat", titleAliases: ["不动产分期抵扣计算表"] },
  { key: "vat_prepaid", formCode: "VAT_PREPAID", formName: "增值税及附加税费预缴表", taxType: "vat", titleAliases: ["增值税及附加税费预缴表", "增值税预缴税款表"] },
  { key: "vat_prepaid_appendix", formCode: "VAT_PREPAID_APPENDIX", formName: "增值税及附加税费预缴表附列资料", taxType: "vat", titleAliases: ["增值税及附加税费预缴表附列资料", "增值税预缴税款表附列资料"] },
  { key: "vat_relief", formCode: "VAT_RELIEF", formName: "增值税减免税申报明细表", taxType: "vat", titleAliases: ["增值税减免税申报明细表"] },
  { key: "surcharge", formCode: "SURCHARGE", formName: "城市维护建设税及教育费附加申报表", taxType: "surcharge", titleAliases: ["城市维护建设税及教育费附加申报表", "城市维护建设税和教育费附加申报表", "附加税申报表"] },
  { key: "land_appreciation_prepaid_source", formCode: "LAND_APPRECIATION_PREPAID_SOURCE", formName: "土地增值税税源明细表（从事房地产开发的纳税人预缴适用）", taxType: "land_appreciation", titleAliases: ["土地增值税税源明细表（从事房地产开发的纳税人预缴适用）", "土地增值税税源明细表(从事房地产开发的纳税人预缴适用)"] },
  { key: "land_appreciation_declaration", formCode: "LAND_APPRECIATION_DECLARATION", formName: "土地增值税纳税申报表（一）", taxType: "land_appreciation", titleAliases: ["土地增值税纳税申报表（一）"] },
  { key: "land_appreciation_prepaid_declaration", formCode: "LAND_APPRECIATION_PREPAID_DECLARATION", formName: "土地增值税预征申报", taxType: "land_appreciation", titleAliases: ["土地增值税预征申报"] },
  { key: "property_behavior_main", formCode: "PROPERTY_BEHAVIOR_MAIN", formName: "财产和行为税纳税申报表", taxType: "property_behavior", titleAliases: ["财产和行为税纳税申报表"] },
  { key: "property_behavior_appendix", formCode: "PROPERTY_BEHAVIOR_APPENDIX", formName: "财产和行为税纳税申报表附表", taxType: "property_behavior", titleAliases: ["财产和行为税纳税申报表附表", "财产和行为税纳税申报表附表（税源明细）", "财产和行为税纳税申报表及附表", "财产和行为税税源明细表"] },
  { key: "stamp_source", formCode: "STAMP_SOURCE", formName: "印花税税源明细表", taxType: "stamp", titleAliases: ["印花税税源明细表"] },
  { key: "stamp_declaration", formCode: "STAMP_DECLARATION", formName: "印花税纳税申报表", taxType: "stamp", titleAliases: ["印花税纳税申报（报告）表", "印花税申报（报告）表", "印花税纳税申报表", "印花税申报表"] },
];

const compact = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");

export function taxFormDefinitions(): TaxFormDefinition[] {
  return definitions.map((definition) => ({ ...definition, titleAliases: [...definition.titleAliases] }));
}

export function matchTaxCatalogueForm(text: string, options: { vatPilotContext?: boolean } = {}): Omit<TaxForm, "pages"> | undefined {
  const normalized = compact(text);
  const matches = definitions
    .flatMap((definition) => definition.titleAliases.map((alias) => ({ definition, alias: compact(alias) })))
    .filter(({ definition }) => !definition.key.startsWith("vat_pilot_2026_") || options.vatPilotContext || normalized.includes("试行") || definition.key === "vat_pilot_2026_business_info")
    .filter(({ definition, alias }) => definition.key !== "surcharge" || alias !== "附加税申报表" || ["征收项目", "税率", "税额"].filter((label) => normalized.includes(label)).length >= 2)
    .filter(({ alias }) => alias && normalized.includes(alias))
    .sort((a, b) => b.alias.length - a.alias.length);
  const match = matches[0];
  if (!match) return undefined;
  // Preserve the historical/printed title from the PDF whenever available.
  const sourceTitle = text.split(/\r?\n/).map((line) => line.trim()).find((line) => compact(line).includes(match.alias));
  return { key: match.definition.key, formCode: match.definition.formCode, formName: sourceTitle || match.definition.formName, taxType: match.definition.taxType };
}

export const taxTypeName: Record<TaxType, string> = {
  vat: "增值税及附加税费", corporate_income: "企业所得税", land_appreciation: "土地增值税",
  stamp: "印花税", property_behavior: "财产和行为税", surcharge: "附加税费", mixed: "混合税种", unknown: "未识别税种",
};

export const taxTypeOptions: { value: TaxType; label: string }[] = Object.entries(taxTypeName)
  .filter(([value]) => value !== "unknown" && value !== "mixed")
  .map(([value, label]) => ({ value: value as TaxType, label }));

/** Extraction is available only when at least one concrete tax type was classified. */
export function canProcessTaxType(type: TaxType): boolean {
  return type !== "unknown" && type !== "mixed";
}
