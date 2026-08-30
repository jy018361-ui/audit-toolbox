import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  applyLedgerReviewsTogether,
  type LedgerReviewOutcome,
  type LedgerReviewTarget,
} from "@/ledgerMapping";

/** 一键复核里单个文件的输入＋把应用后的映射写回页面 state 的回写函数。 */
export type LedgerReviewSlot = LedgerReviewTarget & {
  onApplied: (next: Record<string, string | string[]>) => void;
  /**
   * 复核结束后按**应用建议后的映射**重算仍缺的必填字段（中文标签）。
   * 画面上明明挂着"尚未映射"的红色清单时，结论不许说"当前映射无需
   * 调整"——那是在告诉用户一切正常，实际上不映射就测不了算。
   */
  missingAfter?: (mapping: Record<string, string | string[]>) => string[];
};

/**
 * 一键复核 TB＋JE 的共享状态与共享入口。引擎在 `applyLedgerReviewsTogether`
 * （`src/ledgerMapping.ts`），这里补上两个页面都要的状态管理：哪个文件在
 * 复核（复核期间锁定该文件的字段映射，与原先单独复核时的锁定语义一致）、
 * 各自的结果文案。存款利息与汇兑损益共用同一份实现，改引擎两处同时生效。
 */
export function useLedgerDictReviews(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  sourceKeys?: Partial<Record<"je" | "tb", string>>,
) {
  const [reviewing, setReviewing] = useState<Record<"je" | "tb", boolean>>({
    je: false,
    tb: false,
  });
  const [status, setStatus] = useState<Record<"je" | "tb", string>>({
    je: "",
    tb: "",
  });
  const generation = useRef({ je: 0, tb: 0 });
  const mounted = useRef(true);
  const previousSources = useRef(sourceKeys);
  /** 开始换文件/重新识别时即调用；旧请求仍可结束，但不得再回写。 */
  const clearReview = useCallback((kind: "je" | "tb") => {
    generation.current[kind] += 1;
    if (!mounted.current) return;
    setReviewing((current) => ({ ...current, [kind]: false }));
    setStatus((current) => ({ ...current, [kind]: "" }));
  }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current.je += 1;
      generation.current.tb += 1;
    };
  }, []);
  // 额外防线：由调用方提供路径/Sheet/表头组成的身份，移除及切换均自动失效。
  useLayoutEffect(() => {
    for (const kind of ["je", "tb"] as const) {
      if (previousSources.current?.[kind] !== sourceKeys?.[kind])
        clearReview(kind);
    }
    previousSources.current = sourceKeys;
  }, [sourceKeys?.je, sourceKeys?.tb, clearReview]);
  const reviewAll = useCallback(
    async (
      slots: Partial<Record<"je" | "tb", LedgerReviewSlot>>,
    ): Promise<Partial<Record<"je" | "tb", LedgerReviewOutcome>>> => {
      if (!mounted.current) return {};
      const kinds = (["je", "tb"] as const).filter((kind) => slots[kind]);
      const started = { ...generation.current };
      for (const kind of kinds) started[kind] = ++generation.current[kind];
      setReviewing((current) => ({
        ...current,
        ...Object.fromEntries(kinds.map((kind) => [kind, true])),
      }));
      setStatus((current) => ({
        ...current,
        ...Object.fromEntries(kinds.map((kind) => [kind, "正在复核字段映射…"])),
      }));
      const targets = Object.fromEntries(
        kinds.map((kind) => [kind, slots[kind]!]),
      ) as Partial<Record<"je" | "tb", LedgerReviewTarget>>;
      const outcomes = await applyLedgerReviewsTogether(call, targets);
      const currentOutcomes: Partial<Record<"je" | "tb", LedgerReviewOutcome>> =
        {};
      for (const kind of kinds) {
        if (!mounted.current || generation.current[kind] !== started[kind])
          continue;
        const outcome = outcomes[kind]!;
        currentOutcomes[kind] = outcome;
        if (!outcome.failed) slots[kind]!.onApplied(outcome.mapping);
        // 结论必须与画面上的"尚未映射"清单一致：还缺着必填字段时，
        // "无需调整"就是在替 LLM 拍胸脯，用户却被必填校验拦着测不了算。
        const missing = outcome.failed
          ? []
          : [...new Set(slots[kind]!.missingAfter?.(outcome.mapping) ?? [])];
        const missingNote = missing.length
          ? `仍有未映射：${missing.join("、")}，请手工指定。`
          : "";
        setStatus((current) => ({
          ...current,
          [kind]: outcome.failed
            ? `复核失败：${outcome.error} 可继续手工映射。`
            : outcome.appliedCount
              ? missingNote
                ? `复核完成，已应用 ${outcome.appliedCount} 项建议；${missingNote}`
                : `复核完成，已应用 ${outcome.appliedCount} 项建议。`
              : missingNote
                ? `复核完成，LLM 未提出调整建议；${missingNote}`
                : "复核完成，当前映射无需调整。",
        }));
        setReviewing((current) => ({ ...current, [kind]: false }));
      }
      // 调用方也会根据 outcome 更新确认状态，故过期结果不能仅跳过 onApplied。
      return currentOutcomes;
    },
    [call],
  );
  /** 复核后的异步跨表检查也必须沿用源版本，防止二次请求回写旧文件。 */
  const currentGuard = useCallback(() => {
    const snapshot = { ...generation.current };
    return () =>
      mounted.current &&
      snapshot.je === generation.current.je &&
      snapshot.tb === generation.current.tb;
  }, []);
  return { reviewing, status, reviewAll, clearReview, currentGuard };
}

/**
 * 「一键复核 TB＋JE」区块：一个按钮同时复核两个已上传文件的字段映射，
 * 两个文件各自的结果（已应用建议数、失败状态）分行展示。某个文件没上传
 * 就只复核已上传的；两个都没上传时整个区块不渲染（由调用方控制）。
 * 状态行复用 `.fx-review-all` 样式，存款利息页同样引入了 fx-audit.css。
 */
export function LedgerReviewAll(props: {
  /** 已上传的文件，顺序即状态行的展示顺序。 */
  present: Array<"je" | "tb">;
  /** 两个 kind 在本页面的叫法（序时账/JE、TB）。 */
  names: Record<"je" | "tb", string>;
  reviewing: Record<"je" | "tb", boolean>;
  status: Record<"je" | "tb", string>;
  /** 页面级忙碌（测算等任务进行中）时一并禁用。 */
  disabled?: boolean;
  onReviewAll: () => void;
}) {
  const reviewingAny = props.present.some((kind) => props.reviewing[kind]);
  const both = props.present.length > 1;
  const subject = props.present
    .map((kind) => props.names[kind])
    .join(both ? "＋" : "");
  return (
    <section className="fx-review-all" aria-label="字段映射一键复核">
      <div>
        <h2>字段映射一键复核</h2>
        <p>
          点击一次，
          {both
            ? `同时复核 ${subject} 两个文件的字段映射`
            : `复核 ${subject} 的字段映射`}
          。
        </p>
        <div className="fx-review-states" aria-live="polite">
          {props.present.map((kind) => (
            <span
              key={kind}
              className={props.reviewing[kind] ? "running" : undefined}
            >
              {props.names[kind]}：{props.status[kind] || "等待复核"}
            </span>
          ))}
        </div>
      </div>
      <Button
        disabled={props.disabled || reviewingAny}
        onClick={props.onReviewAll}
      >
        {reviewingAny ? "复核中…" : `一键复核 ${subject}`}
      </Button>
    </section>
  );
}
