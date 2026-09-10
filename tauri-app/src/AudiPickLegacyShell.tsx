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
  themeLabel: string;
  onNavigate: (page: AudiPickLegacyPage) => void;
  onToggleLog: () => void;
  onOpenTheme: () => void;
  children: ReactNode;
  logDrawer: ReactNode;
};

function Icon({ name }: { name: "grid" | "file" | "key" | "log" | "palette" | "info" }) {
  if (name === "grid") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm10 0a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V6ZM4 16a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2Zm10 0a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-2Z" /></svg>;
  }
  if (name === "file") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>;
  }
  if (name === "key") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8a6 6 0 0 1-7.74 5.74L11 16H9v2H7v2H4a1 1 0 0 1-1-1v-2.59a1 1 0 0 1 .29-.7l5.97-5.97A6 6 0 1 1 21 8Z" /><path d="M17 7h.01" /></svg>;
  }
  if (name === "palette") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a10 10 0 1 1 10-10 4 4 0 0 1-4 4h-1.5a2.5 2.5 0 0 0-2.5 2.5v.5a3 3 0 0 1-3 3h-1Z" /><path d="M7.5 10.5h.01M10.5 7.5h.01M14.5 7.5h.01" /></svg>;
  }
  if (name === "info") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 12h6M9 16h6M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></svg>;
}

export function AudiPickLegacyShell({
  activePage,
  configReady,
  logCount,
  logOpen,
  themeLabel,
  onNavigate,
  onToggleLog,
  onOpenTheme,
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
        <nav className="apl-nav" aria-label="AudiPick 功能导航">
          <button id="nav-dash" className={activePage === "workbench" ? "active" : ""} type="button" onClick={() => onNavigate("workbench")}><Icon name="grid" />工作台</button>
          <button className={activePage === "templates" ? "active" : ""} type="button" onClick={() => onNavigate("templates")}><Icon name="file" />提取模板库</button>
          <button id="nav-cfg" className={activePage === "config" ? "active" : ""} type="button" onClick={() => onNavigate("config")}><Icon name="key" />配置<span className={`apl-config-badge ${configReady ? "ready" : ""}`}>{configReady ? "已配置" : "未配置"}</span></button>
        </nav>
        <div className="apl-sidebar-actions">
          <button type="button" onClick={onToggleLog}><Icon name="log" />处理工作日志{logCount > 0 && <span className="apl-unread" />}</button>
          <button type="button" onClick={onOpenTheme}><Icon name="palette" />主题设置<small>{themeLabel}</small></button>
          <button type="button" onClick={() => onNavigate("guide")}><Icon name="info" />新手引导</button>
        </div>
        <div className="apl-local-note"><strong>数据仅存本地</strong><span>For questions, contact Dana D Li.</span></div>
      </aside>
      <main className="apl-main">{children}</main>
      <aside className={`apl-log-drawer ${logOpen ? "open" : ""}`} aria-hidden={!logOpen}>{logDrawer}</aside>
    </div>
  );
}
