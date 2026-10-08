import type { ReactNode } from "react";
import { useTableColumnResize } from "./useTableColumnResize";

export type DataTableProps = {
  columns: string[];
  rows: unknown[][];
  /** 折叠标题（对应原 `<summary>` 可折叠预览） */
  caption?: ReactNode;
  maxHeight?: number;
  emptyText?: string;
  /**
   * 列宽调整记忆键：传入即启用 Excel 式拖拽调宽（本机记忆）。
   * 同一处表格跨会话共用一个键；列结构变化后旧记忆自动作废。
   */
  resizeKey?: string;
  /** 每列表头上方渲染的控件（如映射下拉），长度须与 columns 一致 */
  headerControls?: ReactNode[];
  /**
   * 数据列之后追加的列：表格里**没有**这一列的数据，由调用方逐行渲染控件。
   *
   * 借款台账要在预览区逐行确认利率口径（固定/浮动、上浮下浮点数），
   * 那两列不来自台账文件，是用户填的。
   */
  trailingColumns?: { key: string; title: ReactNode; render: (rowIndex: number) => ReactNode }[];
};

/**
 * 统一的数据预览/结果表格：原生 table + 粘性表头 + 单元格省略。
 * 取代分散的 .fa-preview table / .table-scroll / .confirmation-table-scroll 三处样式。
 */
export function DataTable({
  columns,
  rows,
  caption,
  maxHeight = 430,
  emptyText = "暂无数据",
  resizeKey,
  headerControls,
  trailingColumns,
}: DataTableProps) {
  const resize = useTableColumnResize<HTMLDivElement>({ storageKey: resizeKey ?? "" });
  return (
    <div className="data-table">
      {caption != null && <div className="data-table-caption">{caption}</div>}
      <div className="data-table-scroll" style={{ maxHeight }} ref={resize.ref}>
        {rows.length === 0 && !headerControls?.length ? (
          <div className="empty">{emptyText}</div>
        ) : (
          <table className="data-table-table">
            <thead>
              <tr>
                {columns.map((col, index) => (
                  <th key={index}>
                    {headerControls?.[index]}
                    <span>{col}</span>
                  </th>
                ))}
                {trailingColumns?.map((col) => (
                  <th key={col.key} className="data-table-trailing">
                    <span>{col.title}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + (trailingColumns?.length ?? 0)}>{emptyText}</td>
                </tr>
              )}
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {columns.map((_, colIndex) => {
                    const cell = row[colIndex];
                    const text = cell == null ? "" : String(cell);
                    return (
                      <td key={colIndex} title={text}>
                        {text}
                      </td>
                    );
                  })}
                  {trailingColumns?.map((col) => (
                    <td key={col.key} className="data-table-trailing">
                      {col.render(rowIndex)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
