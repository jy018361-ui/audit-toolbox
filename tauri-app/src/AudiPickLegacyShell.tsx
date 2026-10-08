import type { ReactNode } from "react";
import "./AudiPickLegacyShell.css";

export type AudiPickLegacyPage =
  | "home"
  | "workbench"
  | "templates"
  | "config"
  | "worklog"
  | "guide";

type Props = {
  activePage: AudiPickLegacyPage;
  configReady: boolean;
  logCount: number;
  logOpen: boolean;
  onNavigate: (page: AudiPickLegacyPage) => void;
  onBackToToolbox: () => void;
  onToggleLog: () => void;
  children: ReactNode;
  logDrawer: ReactNode;
};

function Icon({ name }: { name: "back" | "grid" | "file" | "key" | "log" }) {
  if (name === "back") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /><path d="M9 12h11" /></svg>;
  }
  if (name === "grid") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm10 0a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V6ZM4 16a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2Zm10 0a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2Z" /></svg>;
  }
  if (name === "file") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>;
  }
  if (name === "key") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8a6 6 0 0 1-7.74 5.74L11 16H9v2H7v2H4a1 1 0 0 1-1-1v-2.59a1 1 0 0 1 .29-.7l5.97-5.97A6 6 0 1 1 21 8Z" /><path d="M17 7h.01" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 12h6M9 16h6M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></svg>;
}

export function AudiPickLegacyShell({
  activePage,
  configReady,
  logCount,
  logOpen,
  onNavigate,
  onBackToToolbox,
  onToggleLog,
  children,
  logDrawer,
}: Props) {
  return (
    <div className="apl-shell">
      <aside className="apl-sidebar">
        <button className="apl-brand" type="button" onClick={() => onNavigate("home")}>
          <span className="apl-brand-mark">A</span>
          <span><strong>AudiPick</strong><small>Smart Contract Audit</small></span>
        </button>
        <button className="apl-back-button" type="button" onClick={onBackToToolbox}>
          <Icon name="back" />
          返回工具箱
        </button>
        <nav className="apl-nav" aria-label="AudiPick 功能导航">
          <button id="nav-dash" className={activePage === "workbench" ? "active" : ""} type="button" onClick={() => onNavigate("workbench")}><Icon name="grid" />工作台</button>
          <button className={activePage === "templates" ? "active" : ""} type="button" onClick={() => onNavigate("templates")}><Icon name="file" />提取模板库</button>
          <button id="nav-cfg" className={activePage === "config" ? "active" : ""} type="button" onClick={() => onNavigate("config")}><Icon name="key" />配置<span className={`apl-config-badge ${configReady ? "ready" : ""}`}>{configReady ? "已配置" : "未配置"}</span></button>
        </nav>
        <div className="apl-sidebar-actions">
          <button type="button" onClick={onToggleLog}><Icon name="log" />处理工作日志{logCount > 0 && <span className="apl-unread" />}</button>
        </div>
        <div className="apl-local-note">
          <strong><span className={`apl-status-dot ${configReady ? "ready" : ""}`} />AI {configReady ? "已配置" : "未配置"}</strong>
          <span>项目与审阅数据仅存本地</span>
        </div>
      </aside>
      <main className="apl-main">{children}</main>
      <aside className={`apl-log-drawer ${logOpen ? "open" : ""}`} aria-hidden={!logOpen}>{logDrawer}</aside>
    </div>
  );
}
