import { cn } from "@/lib/utils";

export type StatItem = {
  label: string;
  value: string | number;
  hint?: string;
};

export type StatGridProps = {
  items: StatItem[];
  columns?: 2 | 3 | 4;
};

/**
 * 统一的指标网格。取代分散的 .fa-stat-grid / .summary-grid / .confirmation-metrics / .result-metrics。
 */
export function StatGrid({ items, columns = 4 }: StatGridProps) {
  return (
    <div className={cn("stat-grid", `stat-grid--${columns}`)}>
      {items.map((item, index) => (
        <div className="stat-cell" key={`${item.label}-${index}`}>
          <span className="stat-label">{item.label}</span>
          <strong className="stat-value">{item.value}</strong>
          {item.hint && <small className="stat-hint">{item.hint}</small>}
        </div>
      ))}
    </div>
  );
}
