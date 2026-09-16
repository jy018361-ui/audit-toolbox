import type { AuxiliaryLinkResult } from "../ledgerMapping";

/**
 * 辅助核算联动验证的三态标注（公共组件）。只在 TB 映射了辅助列时出现；
 * 结论与降级原因必须让用户看得见——静默降级不等于无声无息。
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
    return (
      <div className="aux-link-groups">
        {result.groups.map((group) => (
          <div key={`${group.entity}\u001f${group.account}`}>
            <span>{group.entity} · {group.account}</span>
            <AuxiliaryLinkStatusView
              result={{ ...group, tbAuxMapped: true }}
              dimensionLabel={label}
            />
          </div>
        ))}
      </div>
    );
  }
  const pct = Math.round(result.coverage * 1000) / 10;
  let text: string;
  let warn = false;
  switch (result.status) {
    case "verified":
      text = `${label}已验证：JE「${result.column ?? ""}」与 TB 对应（${result.anchorHits}/${result.anchorTotal} 维度命中，覆盖率 ${pct}%），将按维度细分。`;
      break;
    case "partialCoverage":
      text = `JE ${label}列「${result.column ?? ""}」覆盖不全（${result.anchorHits}/${result.anchorTotal} 维度命中）；本主体科目按主体＋科目归集，不启用${label}键。`;
      warn = true;
      break;
    case "noMatch":
      text = `JE 无对应${label}列；保留字段映射，但本主体科目不启用${label}键，按主体＋科目归集。`;
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
