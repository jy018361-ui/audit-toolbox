import type { AuxiliaryLinkResult } from "../ledgerMapping";

/**
 * 辅助核算联动验证的公共降级提示。成功时不反复提示，失败时只说明
 * 实际计算口径；逐组判定仍保留在结果中，不在上传区铺开。
 * `dimensionLabel` 可由业务页覆盖，其余默认“辅助核算”。
 */
export function AuxiliaryLinkStatusView(props: {
  result: AuxiliaryLinkResult | null;
  dimensionLabel?: string;
}) {
  const { result } = props;
  const label = props.dimensionLabel ?? "辅助核算";
  if (!result || !result.tbAuxMapped) return null;
  if (result.groups?.length) {
    const verifiedCount = result.groups.filter(
      (group) => group.status === "verified",
    ).length;
    const fallbackCount = result.groups.length - verifiedCount;
    if (fallbackCount === 0) return null;
    const text = verifiedCount
      ? `TB/JE ${label}有 ${fallbackCount} 项无法匹配，已退回按主体＋科目计算；其余 ${verifiedCount} 项按${label}细分。`
      : `TB/JE ${label}无法匹配，已退回按主体＋科目计算。`;
    return <p className="aux-link-status aux-link-status--warn" aria-live="polite">{text}</p>;
  }
  if (result.status === "verified") return null;
  return (
    <p className="aux-link-status aux-link-status--warn" aria-live="polite">
      TB/JE {label}无法匹配，已退回按主体＋科目计算。
    </p>
  );
}
