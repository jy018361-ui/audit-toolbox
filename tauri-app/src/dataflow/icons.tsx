import type { ComponentType } from "react";
import {
  ArrowDownUp,
  Brush,
  Columns2,
  Copy,
  Database,
  FileSpreadsheet,
  FileText,
  Filter,
  Flag,
  FlipHorizontal,
  Grid3x3,
  Link,
  ListChecks,
  Rows3,
  Save,
  Sigma,
  Table,
} from "lucide-react";

/** 节点目录 icon 键 → lucide 图标。目录里未登记的键退回通用文档图标。 */
const DATAFLOW_ICONS: Record<string, ComponentType<{ size?: number | string }>> = {
  fileSpreadsheet: FileSpreadsheet,
  fileText: FileText,
  database: Database,
  table: Table,
  listChecks: ListChecks,
  sigma: Sigma,
  brush: Brush,
  columns: Columns2,
  filter: Filter,
  arrowDownUp: ArrowDownUp,
  copy: Copy,
  link: Link,
  rows3: Rows3,
  grid3x3: Grid3x3,
  flipHorizontal: FlipHorizontal,
  flag: Flag,
  save: Save,
};

export function DataflowIcon({ icon, size = 14 }: { icon: string; size?: number }) {
  const Component = DATAFLOW_ICONS[icon] ?? FileText;
  return <Component size={size} aria-hidden="true" />;
}
