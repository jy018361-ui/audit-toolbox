import type { ReactNode } from "react";

export type DataTableProps = {
  columns: string[];
  rows: unknown[][];
  /** 折叠标题（对应原 `<summary>` 可折叠预览） */
  caption?: ReactNode;
  maxHeight?: number;
  emptyText?: string;
  /** 每列表头上方渲染的控件（如映射下拉），长度须与 columns 一致 */
  headerControls?: ReactNode[];
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
  headerControls,
}: DataTableProps) {
  return (
    <div className="data-table">
      {caption != null && <div className="data-table-caption">{caption}</div>}
      <div className="data-table-scroll" style={{ maxHeight }}>
        {rows.length === 0 ? (
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
              </tr>
            </thead>
            <tbody>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
