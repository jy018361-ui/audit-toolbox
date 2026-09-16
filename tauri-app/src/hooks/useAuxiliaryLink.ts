import { useEffect, useState } from "react";
import { verifyAuxiliaryLink, type AuxiliaryLinkResult } from "../ledgerMapping";

/** 语义映射不随验证变化；状态只属于最新输入，旧响应不得覆盖新范围。 */
export function useAuxiliaryLink(params: Record<string, unknown> | null) {
  const fingerprint = params === null ? null : JSON.stringify(params);
  const [state, setState] = useState<{
    fingerprint: string;
    result: AuxiliaryLinkResult | null;
  } | null>(null);
  useEffect(() => {
    if (fingerprint === null) return;
    let cancelled = false;
    void verifyAuxiliaryLink(JSON.parse(fingerprint)).then((result) => {
      if (!cancelled) setState({ fingerprint, result });
    });
    return () => { cancelled = true; };
  }, [fingerprint]);
  return state?.fingerprint === fingerprint ? state.result : null;
}
