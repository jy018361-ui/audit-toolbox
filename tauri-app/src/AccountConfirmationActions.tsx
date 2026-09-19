import { useState } from "react";
import { displayFileName } from "./fileDisplay";
import { engineCall, openOutput, pickPath } from "./api";
import { Button } from "./components/ui/button";
import "./account-confirmation.css";

export type ConfirmationColumn = {
  key: string;
  title: string;
  editable?: boolean;
  options?: string[];
};
export type ConfirmationRow = { key: string; values: string[]; editable?: boolean[] };

type Props = {
  tool: "deposit" | "fx" | "loan" | "fa_tbje";
  title: string;
  context: string;
  columns: ConfirmationColumn[];
  rows: ConfirmationRow[];
  disabled?: boolean;
  onImport: (rows: ConfirmationRow[]) => void;
};

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "userMessage" in error)
    return String(error.userMessage);
  return error instanceof Error ? error.message : String(error);
}

/** One workbook per current review list. Import never trusts row order or editable cells blindly. */
export function AccountConfirmationActions({
  tool, title, context, columns, rows, disabled, onImport,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [downloadPath, setDownloadPath] = useState("");

  async function download() {
    const outputPath = await pickPath("save", "保存科目确认表", ["xlsx"], `${title}科目确认表.xlsx`);
    if (typeof outputPath !== "string") return;
    setBusy(true);
    setNote("");
    setDownloadPath("");
    try {
      await engineCall("account_confirmation.export", { tool, context, columns, rows, outputPath });
      setNote(`已下载 ${rows.length} 行科目确认表。`);
      setDownloadPath(outputPath);
    } catch (error) {
      setNote(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    const inputPath = await pickPath("file", "回传科目确认表", ["xlsx"]);
    if (typeof inputPath !== "string") return;
    setBusy(true);
    setNote("");
    setDownloadPath("");
    try {
      const response = await engineCall("account_confirmation.import", {
        tool, context, keys: rows.map((row) => row.key), inputPath,
      }) as { rows: ConfirmationRow[] };
      const current = new Map(rows.map((row) => [row.key, row]));
      const checked = response.rows.map((row) => {
        const original = current.get(row.key);
        if (!original || row.values.length !== columns.length)
          throw new Error(`科目 ${row.key} 的列数与当前页面不一致。`);
        const values = columns.map((column, index) => {
          const value = row.values[index].trim();
          if (!column.editable || original.editable?.[index] === false) return original.values[index];
          if (column.options?.length && value && !column.options.includes(value))
            throw new Error(`科目 ${row.key} 的「${column.title}」不是下拉框允许的值。`);
          return value;
        });
        return { key: row.key, values };
      });
      const changed = checked.filter((row) =>
        row.values.some((value, index) => value !== current.get(row.key)?.values[index]),
      );
      if (!changed.length) {
        setNote("确认表没有修改，页面保持原样。");
        return;
      }
      if (!window.confirm(`将回传 ${changed.length} 行修改到当前页面，继续吗？`)) return;
      onImport(changed);
      setNote(`已回传 ${changed.length} 行，页面已更新；请继续检查并测算。`);
    } catch (error) {
      setNote(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-confirmation-actions">
      <div className="account-confirmation-buttons">
        <Button type="button" variant="secondary" disabled={disabled || busy || !rows.length} onClick={() => void download()}>下载科目确认表</Button>
        <Button type="button" variant="secondary" disabled={disabled || busy || !rows.length} onClick={() => void upload()}>回传科目确认表</Button>
      </div>
      {note && <span role="status">{note}</span>}
      {downloadPath && (
        <button
          type="button"
          className="link-button account-confirmation-open"
          title={downloadPath}
          onClick={() => void openOutput(downloadPath)}
        >
          打开所在文件夹（{displayFileName(downloadPath)}）
        </button>
      )}
    </div>
  );
}
