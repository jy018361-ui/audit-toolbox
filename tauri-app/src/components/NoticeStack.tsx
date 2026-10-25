import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./notice-stack.css";

export type NoticeItem = {
  tone: "info" | "warning" | "danger" | "success";
  children: ReactNode;
  /**
   * 行动级提示：需要用户马上处理的那条（每屏至多一条），聚合时保持展开；
   * 其余（口径解释、非警告说明）默认折叠进「其他 N 条提示」。
   */
  actionable?: boolean;
};

/**
 * 提示条聚合：黄色一色曾同时承担错误/待办/口径解释/门禁/加载失败五种语义，
 * 结果页四连黄连成一面墙、劫持视线。这里约定——每屏只有 actionable 的一条
 * 保持展开，其余默认折叠；语义色与全局 token 一一对应：
 * danger=错误、warning=待办/例外、info=口径与说明、success=完成。
 */
export function NoticeStack({ items }: { items: NoticeItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const primary = items.find((item) => item.actionable) ?? items[0];
  const rest = items.filter((item) => item !== primary);
  return (
    <div className="notice-stack">
      <div className={cn("notice-banner", `notice-${primary.tone}`)}>{primary.children}</div>
      {rest.length > 0 && !expanded && (
        <button
          type="button"
          className="notice-stack-toggle"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          其他 {rest.length} 条提示 ▾
        </button>
      )}
      {rest.length > 0 && expanded && (
        <div className="notice-stack-rest">
          {rest.map((item, index) => (
            <div key={index} className={cn("notice-banner", `notice-${item.tone}`)}>
              {item.children}
            </div>
          ))}
          <button
            type="button"
            className="notice-stack-toggle"
            aria-expanded={true}
            onClick={() => setExpanded(false)}
          >
            收起 ▴
          </button>
        </div>
      )}
    </div>
  );
}
