import type { CovenantCaseLibrary } from "./audipickCaseLibrary";

const normalize = (text: string) => text.replace(/\s+/g, "").toLowerCase();
const prohibited = /贷款(?:用途|用于)|借款(?:用途|用于)|贷款资金.{0,15}(?:用于|不得)|受托支付|报送|提供.{0,8}(?:报表|资料)|保险|投保|公司章程|法定代表人|建设规模|项目交易合同权利/;
const ordinaryDebtService = /(?:计结息|利息计收|还本付息|支付利息|归还本金|付息日|还本日|利随本清|应付利息).{0,300}(?:结算账户|贷款余额|贷款利率)|(?:结算账户|贷款余额|贷款利率).{0,300}(?:计结息|还本付息|付息日|还本日|应付利息)/;
const ordinaryLoanTerms = /贷款期限|提款(?:日|金额|期|计划|条件|手续)|还款计划|偿还贷款本金|贷款利率|基准利率|LPR|利差|罚息利率|自愿提前还款|提前还款.{0,30}(?:申请|最低金额|拟还款日|倒序)|项目资本金/;
const accountOperations = /贷款金额.{0,20}100%.{0,20}结算|开立.{0,20}(?:贷款账户|结算账户)|销售资金监管账户|(?:收入|资金).{0,10}归集|归集.{0,12}(?:收入|资金)|提前.{0,8}工作日.{0,20}(?:备足|足额偿还)/;
const comparison = /(?:不(?:得)?(?:高于|低于|超过|少于)|不得少于|超过|达到|低于|高于|至少|以上|以下|上限|下限|[<>]=?|为负|正值|保持盈利|连续.{0,8}(?:亏损|为负)|同比(?:下降|增长))/i;
const amountOrRatio = /\d+(?:\.\d+)?(?:%|％|万元|亿元|元|倍)|百分之[一二三四五六七八九十百千万\d]+/i;
const comparisonNumericThreshold = /(?:不(?:得)?(?:高于|低于|超过|少于)|不得少于|超过|达到|低于|高于|至少|上限|下限).{0,24}\d+(?:\.\d+)?(?:%|％|倍|万元|亿元|元)?|\d+(?:\.\d+)?(?:%|％|倍|万元|亿元|元)?.{0,12}(?:以上|以下|上限|下限)/i;
const statementMetric = /资产负债率|流动比率|速动比率|现金比率|利息保障(?:倍数)?|利息覆盖率|偿债覆盖率|偿付覆盖率|DSCR|EBITDA|净杠杆率?|净债务|净资产|资产净值|流动资产|或有负债率?|信用评级|内部评级/i;
const trendMetric = /净利润|盈利|亏损|经营.{0,8}现金流|营业收入|收入.{0,12}(?:下降|增长)|(?:经营期)?项目实际收益|实际收益|不良率/;
const transaction = /分红|红利|利润分配|分配利润|股利|担保|投资|新增.{0,8}(?:债务|融资)|关联交易|资产.{0,15}(?:处置|处分|出售|转让)|(?:处置|处分|出售|转让).{0,15}资产|权利负担|债务优先|优先于|劣后|抵押|质押/;
const financialBasisThreshold = /(?:净资产|总资产|资产总额|净利润|未分配利润|营业收入|利润|信用余额敞口).{0,24}\d+(?:\.\d+)?(?:%|％|倍|万元|亿元|元)|\d+(?:\.\d+)?(?:%|％|倍|万元|亿元|元).{0,24}(?:净资产|总资产|资产总额|净利润|未分配利润|营业收入|利润|信用余额敞口)/;
const directTransactionThreshold = /(?:分红|红利|利润分配|股利|担保|投资|关联交易|资产.{0,8}(?:处置|处分|出售|转让)|新增.{0,8}(?:债务|融资)|信用余额敞口).{0,40}(?:不(?:得)?(?:超过|高于|低于)|超过|达到|至少|上限|下限).{0,20}\d+(?:\.\d+)?(?:%|％|倍|万元|亿元|元)/;
const riskEvent = /诉讼|仲裁|交叉违约|其他.{0,15}(?:债务|债权人)|关联方.{0,25}违约|查封|冻结|扣押|司法措施|股权质押/;
const accountBalanceThreshold = /(?:账户|保证金).{0,20}(?:余额|留存|保持).{0,20}(?:不(?:得)?低于|不少于|至少|达到).{0,20}\d+(?:\.\d+)?(?:%|％|万元|亿元|元)/;
const qualitativeStatementThreshold = /(?:信用评级|内部评级).{0,20}[A-D]{1,3}[+-]?|(?:净资产|资产净值).{0,20}(?:为负|正值)|(?:为负|正值).{0,20}(?:净资产|资产净值)/i;
const qualitativeTrendThreshold = /为负|正值|保持盈利|连续.{0,8}(?:亏损|为负)/;
const terms = (text: string) => new Set(normalize(text).match(/[\u4e00-\u9fff]{2}|[a-z]{2,}|\d+(?:\.\d+)?/g) ?? []);
function score(text: string, example: CovenantCaseLibrary["positive_examples"][number]): number {
 const source = normalize(text);
 const keys = terms(`${example.subtype} ${example.normalized_rule} ${example.excerpt} ${String(example.search_terms ?? "") + " " + String(example.keywords ?? "")}`);
 let total = 0;
 for (const key of keys) if (source.includes(key)) total += /\d/.test(key) ? 0.1 : 1;
 if (source.includes(normalize(example.excerpt))) total += 100;
 return total;
}
export function retrieveCovenantCases(text: string, library: CovenantCaseLibrary, limit = 4) {
 return library.positive_examples.filter(e => e.status !== "停用" && e.status !== "disabled")
 .map(example => ({example, score: score(text, example)})).filter(e => e.score > 0)
 .sort((a,b) => b.score-a.score || a.example.case_id.localeCompare(b.example.case_id)).slice(0, Math.min(6, Math.max(0,limit))).map(e=>e.example);
}
export function classifyCovenant(text: string, library: CovenantCaseLibrary): { decision: "include" | "exclude" | "pending"; categoryId?: string; category?: string; caseIds: string[]; reason?: string } {
 const value=normalize(text);
 const excluded = library.exclusions_and_support.find(rule => value === normalize(rule.excerpt));
 if (excluded) return {decision:"exclude",caseIds:[],reason:excluded.reason};
 if (/贷款.{0,8}用途|借款.{0,8}用途|专款专用|不得挪作他用/.test(value)) return {decision:"exclude",caseIds:[],reason:"贷款用途不属于财务契约"};
 if (ordinaryDebtService.test(value)) return {decision:"exclude",caseIds:[],reason:"常规还本付息或计结息安排"};
 if (ordinaryLoanTerms.test(value)) return {decision:"exclude",caseIds:[],reason:"贷款期限、提款、还款、利率或项目资本金属于普通合同条件"};
 if (accountOperations.test(value) && !accountBalanceThreshold.test(value)) return {decision:"exclude",caseIds:[],reason:"账户开立、贷款结算、收入归集或备款属于资金管理安排"};
 if (/(?:报送|提交|提供).{0,20}(?:报表|报告|资料)|(?:应|须|需要|按照).{0,15}(?:投保|购买保险)|(?:保险合同|保险单据).{0,12}(?:提交|提供)/.test(value)
   && !/资产负债率|净利润|净资产.{0,15}(?:超过|低于)|(?:担保金额|对外担保).{0,20}(?:超过|不超过)|账户.{0,12}余额/.test(value))
   return {decision:"exclude",caseIds:[],reason:"资料报送或保险义务"};
 const exact=library.positive_examples.find(e => e.status !== "停用" && e.status !== "disabled" && value.includes(normalize(e.excerpt)));
 const candidates=retrieveCovenantCases(text,library,6);
 const statementCondition=statementMetric.test(value) && comparison.test(value) && (comparisonNumericThreshold.test(value)||qualitativeStatementThreshold.test(value));
 const trendCondition=trendMetric.test(value) && comparison.test(value) && (comparisonNumericThreshold.test(value)||qualitativeTrendThreshold.test(value));
 const measuredTransaction=transaction.test(value) && comparison.test(value) && (financialBasisThreshold.test(value)||directTransactionThreshold.test(value));
 const measuredRisk=riskEvent.test(value) && comparison.test(value) && amountOrRatio.test(value);
 const measuredAccountBalance=accountBalanceThreshold.test(value);
 const hasFinancialRestriction=statementCondition||trendCondition||measuredTransaction||measuredRisk||measuredAccountBalance;
 if (prohibited.test(value) && !hasFinancialRestriction) return {decision:"exclude",caseIds:[],reason:"程序性义务、用途或治理事项"};
 if (transaction.test(value) && !measuredTransaction && !statementCondition && !trendCondition && !measuredRisk && !measuredAccountBalance) return {decision:"exclude",caseIds:[],reason:"交易或资产行为没有金额、比例或财务报表基数门槛"};
 if (riskEvent.test(value) && !measuredRisk && !statementCondition && !trendCondition && !measuredTransaction && !measuredAccountBalance) return {decision:"exclude",caseIds:[],reason:"风险事件没有金额或比例门槛"};
 const id=measuredRisk?"C05":measuredAccountBalance?"C04":measuredTransaction?"C03":trendCondition?"C02":statementCondition?"C01":undefined;
 if (id) {
  const matches=candidates.filter(e=>e.category_id===id);
  const category=library.categories.find(c=>c.category_id===id);
  if(category && (exact || matches.some(e=>score(text,e)>=1))) return {decision:"include",categoryId:id,category:category.category,caseIds:exact?[exact.case_id]:matches.slice(0,3).map(e=>e.case_id)};
 }
 if (/(?:周转率|覆盖率|集中度|储备|保证金|财务指标|余额|比率|额度)/.test(value) && comparison.test(value) && amountOrRatio.test(value)) return {decision:"pending",caseIds:[],reason:"具有可核验财务条件，但启用案例库尚无匹配案例"};
 return {decision:"exclude",caseIds:[],reason:"没有案例支持的具体财务条件，或仅为共同后果"};
}
