import { Input } from "@/components/ui/input";

type SourceTableControlsProps = {
  sheet: string;
  sheets: string[];
  headerRow: number | string;
  headerDepth?: number;
  disabled?: boolean;
  namePrefix?: string;
  automaticSheet?: boolean;
  sheetPlaceholder?: string;
  sheetLabel?: string;
  sheetDisabled?: boolean;
  editableSheet?: boolean;
  headerRowChoices?: number[];
  automaticDepth?: boolean;
  headerDepthDisabled?: boolean;
  headerRowMax?: number;
  onSheetChange: (sheet: string) => void;
  onSheetBlur?: () => void;
  onHeaderRowChange: (row: string) => void;
  onHeaderRowBlur?: () => void;
  onHeaderDepthChange?: (depth: number) => void;
};

/** 读取设置随对应的预览显示；页面保留各自的重读和失效规则。 */
export function SourceTableControls(props: SourceTableControlsProps) {
  const name = (field: string) =>
    props.namePrefix ? `${props.namePrefix}-${field}` : undefined;
  return (
    <fieldset
      className="mapping-source-controls"
      aria-label="表格读取设置"
      disabled={props.disabled}
    >
      <label>
        Sheet
        {props.editableSheet && !props.sheets.length ? (
          <Input
            controlSize="sm"
            name={name("sheet")}
            value={props.sheet}
            placeholder="自动选择"
            onChange={(event) => props.onSheetChange(event.target.value)}
            onBlur={props.onSheetBlur}
          />
        ) : (
          <select
            name={name("sheet")}
            value={props.sheet}
            aria-label={props.sheetLabel}
            disabled={props.sheetDisabled}
            onChange={(event) => props.onSheetChange(event.target.value)}
          >
            {props.automaticSheet && <option value="">自动/首个 Sheet</option>}
            {props.sheetPlaceholder && (
              <option value="" disabled>
                {props.sheetPlaceholder}
              </option>
            )}
            {(props.sheets.length
              ? props.sheets
              : props.sheet
                ? [props.sheet]
                : []
            ).map((sheet) => (
              <option key={sheet} value={sheet}>
                {sheet}
              </option>
            ))}
          </select>
        )}
      </label>
      <label>
        标题行
        {props.headerRowChoices ? (
          <select
            name={name("header-row")}
            value={String(props.headerRow)}
            onChange={(event) => props.onHeaderRowChange(event.target.value)}
          >
            {Array.from(
              new Set([...props.headerRowChoices, Number(props.headerRow)]),
            ).map((row) => (
              <option key={row} value={row}>
                {row === 0 ? "自动识别" : `第 ${row} 行`}
              </option>
            ))}
          </select>
        ) : (
          <Input
            controlSize="sm"
            name={name("header-row")}
            type="number"
            min={1}
            max={props.headerRowMax}
            value={props.headerRow}
            placeholder="自动识别"
            onChange={(event) => props.onHeaderRowChange(event.target.value)}
            onBlur={props.onHeaderRowBlur}
          />
        )}
      </label>
      {props.onHeaderDepthChange && (
        <label>
          表头层数
          <select
            name={name("header-depth")}
            value={props.headerDepth ?? 0}
            disabled={props.headerDepthDisabled}
            onChange={(event) =>
              props.onHeaderDepthChange?.(Number(event.target.value))
            }
          >
            {props.automaticDepth && <option value={0}>自动识别</option>}
            <option value={1}>1层</option>
            <option value={2}>2层</option>
          </select>
        </label>
      )}
    </fieldset>
  );
}
