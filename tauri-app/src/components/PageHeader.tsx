import type { ReactNode } from "react";

export type PageHeaderProps = {
  /** 面向用户的短标签（如 "固定资产清单匹配"），禁止暴露内部工程状态 */
  eyebrow: string;
  title: string;
  detail?: string;
  actions?: ReactNode;
};

/**
 * 统一的页头。取代此前 4 个独立页面手写 `<header class="page-header">` 的重复。
 * eyebrow 使用用户态文案，不再暴露 "Rust Polars 完整迁移工具" 这类内部状态。
 *
 * 无边框窗口下，整个页头都是窗口拖拽手柄（data-tauri-drag-region="deep"，
 * 点页头任意空白即可拖动，双击最大化）；actions 里的按钮自身不带该属性，
 * Tauri 会自动让按钮点击优先于拖拽。
 */
export function PageHeader({ eyebrow, title, detail, actions }: PageHeaderProps) {
  return (
    // data-tour：新手引导的工具页挂点（每个工具首次进入时高亮这里）。
    <header
      className="page-header"
      data-tauri-drag-region="deep"
      data-tour="page-header"
    >
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      {detail ? <p>{detail}</p> : null}
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
