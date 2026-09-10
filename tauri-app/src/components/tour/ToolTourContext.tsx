import { createContext, useContext } from "react";
import type { ReactNode } from "react";

/**
 * 当前工具 id 的上下文：App 在渲染工具页时包一层，工具页内部的共享组件
 * （如 StepTourHint）借此知道"现在在哪个工具里"，从而取出针对性的提示文案。
 */
const ToolTourContext = createContext<string | undefined>(undefined);

export function ToolTourProvider({
  toolId,
  children,
}: {
  toolId: string;
  children: ReactNode;
}) {
  return (
    <ToolTourContext.Provider value={toolId}>
      {children}
    </ToolTourContext.Provider>
  );
}

export function useCurrentToolId(): string | undefined {
  return useContext(ToolTourContext);
}
