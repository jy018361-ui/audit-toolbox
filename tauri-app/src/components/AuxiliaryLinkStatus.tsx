import type { AuxiliaryLinkResult } from "../ledgerMapping";

/**
 * 辅助核算联动验证的三态标注（公共组件）。只在 TB 映射了辅助列时出现；
 * 结论与降级原因必须让用户看得见——静默降级不等于无声无息。
 * `dimensionLabel`：借款工具传“借款明细”，其余默认“辅助核算”。
 */
export function AuxiliaryLinkStatusView(props: {
  result: AuxiliaryLinkResult | null;
  dimensionLabel?: string;
}) {
  const { result } = props;
  const label = props.dimensionLabel ?? "辅助核算";
  if (!result || !result.tbAuxMapped) return null;
  const pct = Math.round(result.coverage * 1000) / 10;
  let text: string;
  let warn = false;
  switch (result.status) {
    case "verified":
      text = `${label}已验证：JE「${result.column ?? ""}」与 TB 对应（${result.anchorHits}/${result.anchorTotal} 维度命中，覆盖率 ${pct}%），将按维度细分。`;
      break;
    case "partialCoverage":
      text = `JE ${label}列「${result.column ?? ""}」覆盖不全（${result.anchorHits}/${result.anchorTotal} 维度命中），空格分录将归入未分维度行，维度差异请结合复核。`;
      warn = true;
      break;
    case "noMatch":
      text = `JE 无对应${label}列，已取消 TB 的${label}映射；计算继续按主体＋科目归集。`;
      warn = true;
      break;
    case "ambiguous":
      text = `JE 中有多列疑似${label}列（${result.competingColumns.join("、")}），请手动指定其一；未指定前按主体＋科目归集。`;
      warn = true;
      break;
    default:
      text = `TB ${label}列暂无可验证的当期发生额行，按主体＋科目归集。`;
      warn = true;
  }
  return (
    <p className={warn ? "aux-link-status aux-link-status--warn" : "aux-link-status"}>
      {text}
    </p>
  );
}
