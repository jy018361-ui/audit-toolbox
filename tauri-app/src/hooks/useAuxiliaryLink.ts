import { useEffect, useRef, useState } from "react";
import { verifyAuxiliaryLink, type AuxiliaryLinkResult } from "../ledgerMapping";

/**
 * 语义映射不随验证变化；状态只属于最新输入，旧响应不得覆盖新范围。
 *
 * `key` 是重验触发键，由调用方只放进「数据源＋两侧辅助核算明细映射」；
 * 币种、金额、日期等其他角色的映射调整不改变既有联动结论，不触发
 * 整表重读的复核。验证请求本身仍发送完整参数，键变化时取当次最新值。
 */
export function useAuxiliaryLink(
  params: Record<string, unknown> | null,
  key: string | null,
) {
  const snapshotRef = useRef<string | null>(null);
  useEffect(() => {
    snapshotRef.current = params === null ? null : JSON.stringify(params);
  });
  const [state, setState] = useState<{
    key: string | null;
    result: AuxiliaryLinkResult | null;
  } | null>(null);
  useEffect(() => {
    if (key === null) return;
    const snapshot = snapshotRef.current;
    if (snapshot === null) return;
    let cancelled = false;
    void verifyAuxiliaryLink(JSON.parse(snapshot)).then((result) => {
      if (!cancelled) setState({ key, result });
    });
    return () => { cancelled = true; };
  }, [key]);
  return state?.key === key ? state.result : null;
}
