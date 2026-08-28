import { useId } from "react";

/**
 * 关键词匹配规则：按空白拆成多个词、全部命中才算匹配（与），
 * 大小写不敏感——「1002 建行」能一步定位编码和名称都对的科目行。
 * 空关键词放行所有行。
 */
export function keywordFilterPredicate(keyword: string): (text: string) => boolean {
  const tokens = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return () => true;
  return (text: string) => {
    const haystack = text.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  };
}

/**
 * 清单关键词筛选输入：输入即过滤，非空时出现清除按钮。
 * 存款利息与汇兑损益的「科目分类」共用（交互对齐 timesheet 的筛选：
 * 即时过滤、可清除、placeholder 说明用法）；样式是 fx-audit.css 里的
 * `.fx-list-filter`，两个页面都引入了这份样式。
 * 传入 matched/total 时，筛选中在右侧同步显示「命中数 / 总数」。
 */
export function KeywordFilter(props: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  placeholder?: string;
  matched?: number;
  total?: number;
}) {
  const id = useId();
  const filtering = props.value.trim() !== "";
  return (
    <div className="fx-list-filter">
      <input
        id={id}
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {filtering && props.matched != null && props.total != null && (
        <span className="fx-list-filter-count">
          {props.matched} / {props.total}
        </span>
      )}
      {filtering && (
        <button
          type="button"
          aria-label="清除筛选"
          title="清除筛选"
          onClick={() => props.onChange("")}
        >
          ×
        </button>
      )}
    </div>
  );
}
