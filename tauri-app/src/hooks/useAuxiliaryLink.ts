import { useEffect, useRef, useState } from "react";
import { verifyAuxiliaryLink, type AuxiliaryLinkResult } from "../ledgerMapping";

/**
 * 语义映射不随验证变化；状态只属于最新输入，旧响应不得覆盖新范围。
 *
 * `key` 是重验触发键，由调用方纳入会影响正文行、账户身份或锚点取值的
 * 数据源与映射；无关界面状态不放入。验证请求发送完整参数，键变化时取
 * 当次最新值。
 */
export function useAuxiliaryLink(
  params: Record<string, unknown> | null,
  key: string | null,
  onError?: (reason: unknown) => void,
) {
  const snapshotRef = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    snapshotRef.current = params === null ? null : JSON.stringify(params);
    onErrorRef.current = onError;
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
    void verifyAuxiliaryLink(JSON.parse(snapshot))
      .then((result) => {
        if (!cancelled) setState({ key, result });
      })
      .catch((reason) => {
        if (!cancelled) {
          setState({ key, result: null });
          onErrorRef.current?.(reason);
        }
      });
    return () => { cancelled = true; };
  }, [key]);
  return state?.key === key ? state.result : null;
}
