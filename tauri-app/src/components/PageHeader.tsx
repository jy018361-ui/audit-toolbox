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
 * 无边框窗口下，页头文字同时是窗口拖拽手柄（data-tauri-drag-region，
 * 双击最大化）；actions 里是按钮，不能进拖拽区。
 */
export function PageHeader({ eyebrow, title, detail, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <span data-tauri-drag-region>{eyebrow}</span>
      <h1 data-tauri-drag-region>{title}</h1>
      {detail ? <p data-tauri-drag-region>{detail}</p> : null}
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
