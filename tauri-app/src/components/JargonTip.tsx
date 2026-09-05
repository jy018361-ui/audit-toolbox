import { useId, useState } from "react";
import { CircleHelp } from "lucide-react";
import "./jargon-tip.css";

export type JargonTipProps = {
  /** 术语名：进 aria-label（“什么是×××”），也用于测试定位。 */
  term: string;
  /** 悬停／聚焦时气泡里的一句话解释。 */
  text: string;
  className?: string;
};

/**
 * 行话问号微提示：一行内联的小问号，平时零存在，悬停或键盘聚焦时
 * 浮出一句大白话解释，移开即消失。给审计新人第一次见到的行话兜底。
 *
 * 键盘可达：Tab 聚焦到问号上气泡同样出现；气泡用 role="tooltip"
 * 并经 aria-describedby 关联到按钮。
 */
export function JargonTip({ term, text, className }: JargonTipProps) {
  const [open, setOpen] = useState(false);
  // 靠近视口右缘时改为右对齐，防止气泡被截断；仅在展开那一刻量一次。
  const [alignRight, setAlignRight] = useState(false);
  const tipId = useId();

  const show = (target: Element) => {
    const remaining = window.innerWidth - target.getBoundingClientRect().right;
    setAlignRight(remaining < 280);
    setOpen(true);
  };
  const hide = () => setOpen(false);

  return (
    <span
      className={`jargon-tip${alignRight ? " jargon-tip-right" : ""}${className ? ` ${className}` : ""}`}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={hide}
    >
      {/* 触发器用 role="button" 的 span 而非原生 button：原生 button 是
          labelable 元素，放进 <label> 会抢走其隐式控件（如下拉失去标签）。 */}
      <span
        role="button"
        tabIndex={0}
        className="jargon-tip-button"
        aria-label={`什么是${term}`}
        aria-describedby={open ? tipId : undefined}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={hide}
        onClick={(e) => {
          // 本组件没有点击动作；阻止冒泡也避免 label 把点击转发给控件。
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <CircleHelp size={14} strokeWidth={2} aria-hidden="true" />
      </span>
      {open && (
        <span role="tooltip" id={tipId} className="jargon-tip-bubble">
          {text}
        </span>
      )}
    </span>
  );
}
