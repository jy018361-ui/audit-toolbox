/**
 * 借款台账的形态判定：台账四型与 TB 六型／JE 三型的槽位结构完全相同，
 * 判定逻辑已提升为共用的 [`ledgerForms`]，这里只保留台账侧的名字。
 *
 * 型号定义仍随 `loan.inspect` 从 Rust 下发（`ledger_mapping::loan_forms`），
 * 前端不抄第二份。
 */
import {
  describeForm,
  matchForms,
  resolveForm,
  roleRequirement,
  type LedgerForm,
  type LedgerFormMatch,
} from "@/ledgerForms";

export type LoanForm = LedgerForm;
export type LoanFormMatch = LedgerFormMatch;
export type LoanRole = { name: string; label: string };

/** 把已映射的角色套进各个形态，按匹配度排序返回。 */
export const matchLoanForms = (
  forms: LoanForm[],
  mapping: Record<string, string | string[] | undefined>,
) => matchForms("loan", forms, mapping);

/** 命中哪一型；都没完整命中时返回最接近的那个。 */
export const resolveLoanForm = (
  forms: LoanForm[],
  mapping: Record<string, string | string[] | undefined>,
) => resolveForm("loan", forms, mapping);

/** 当前这一型下，某个角色是必填、选填还是与形态无关。 */
export const loanRoleRequirement = roleRequirement;

/** 面板上那句「已识别为 台账-类型A（起始日＋到期日）」。 */
export const describeLoanForm = describeForm;
