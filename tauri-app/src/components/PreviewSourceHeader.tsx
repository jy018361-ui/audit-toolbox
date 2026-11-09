import type { ReactNode } from "react";

export function PreviewSourceHeader({ children, toolbar }: { children: ReactNode; toolbar?: ReactNode }) {
  return (
    <div className="preview-source-head">
      <div className="preview-source-identity">{children}</div>
      {toolbar && <div className="mapping-panel-toolbar">{toolbar}</div>}
    </div>
  );
}
