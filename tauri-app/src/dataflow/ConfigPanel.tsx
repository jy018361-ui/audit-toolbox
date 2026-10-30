import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { SwitchInput } from "@/components/SwitchInput";
import { errorText } from "@/lib/errors";
import { dataflowDbTables } from "../api";
import { CATEGORY_COLOR } from "./Canvas";
import {
  CHECK_RULE_TYPES,
  CROSSTAB_VALUE_FUNCS,
  FILTER_OPERATORS,
  MANUAL_COLUMN_TYPES,
  SUMMARIZE_FUNCS,
  defaultCheckRule,
  incompleteFilterRule,
  type CheckRuleConfig,
  type CheckRuleType,
  type CleanActionConfig,
  type DataflowNode,
  type DataflowParam,
  type FilterConditionConfig,
  type FormulaConfig,
  type JoinKeyPair,
  type ManualColumnConfig,
  type SelectFieldConfig,
  type SortRuleConfig,
  type SummarizeAggregation,
  type SummarizeFunc,
} from "./model";
import { categoryCn, nodeSpec } from "./nodeSpecs";

const COLUMN_TYPE_OPTIONS = [
  { value: "text", label: "文本" },
  { value: "integer", label: "整数" },
  { value: "decimal", label: "十进制小数" },
  { value: "boolean", label: "布尔值" },
  { value: "date", label: "日期" },
  { value: "datetime", label: "日期时间" },
];

const CLEAN_OPS: { value: string; label: string }[] = [
  { value: "trim", label: "去空格" },
  { value: "toHalfWidth", label: "全角转半角" },
  { value: "stripInvisible", label: "去不可见字符" },
  { value: "replace", label: "文本替换" },
];

export interface ConfigPanelProps {
  node: DataflowNode | null;
  params: DataflowParam[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onRename: (name: string) => void;
  onConfigChange: (next: Record<string, unknown>) => void;
  onDelete: () => void;
  onPickPath: (
    kind: "file" | "folder",
    extensions: string[],
    apply: (path: string) => void,
  ) => void;
  /** 输出位置（记住的默认输出文件夹）；输出文件名留空/只填名字时自动保存到这里。 */
  outputDir: string;
  onPickOutputDir: () => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  // label 直接包裹控件，保证读屏与 getByLabelText 能正确关联。
  return (
    <div className="df-f">
      <label>
        <span className="df-f-label">{label}</span>
        {children}
      </label>
    </div>
  );
}

function TextIn({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="df-in"
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function NumIn({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <input
      className="df-in"
      type="number"
      value={Number.isFinite(value) ? value : 0}
      onChange={(event) => onChange(Math.trunc(Number(event.target.value)) || 0)}
    />
  );
}

/** 小数数字输入（如借贷容差 0.01），不截断小数位。 */
function DecIn({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <input
      className="df-in"
      type="number"
      step="any"
      value={Number.isFinite(value) ? value : 0}
      onChange={(event) => {
        const parsed = Number(event.target.value);
        onChange(Number.isFinite(parsed) ? parsed : 0);
      }}
    />
  );
}

function Sel({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <select className="df-in" value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function Chk({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="df-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** 多字段名输入：显示时用「、」连接，输入按逗号/顿号/分号拆分为 string[]。 */
function TokenIn({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="df-in"
      type="text"
      value={value.join("、")}
      placeholder={placeholder}
      onChange={(event) =>
        onChange(
          event.target.value
            .split(/[,，、;；\n]+/)
            .map((item) => item.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

/** 可空数字输入（如区间下限/上限）：留空＝null（未设该边）。 */
function NumOptIn({
  value,
  onChange,
  placeholder,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="df-in"
      type="number"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(event) => {
        const raw = event.target.value;
        if (raw === "") return onChange(null);
        const parsed = Number(raw);
        onChange(Number.isFinite(parsed) ? parsed : null);
      }}
    />
  );
}

/**
 * db_in 的数据表下拉：路径变化后调 dataflowDbTables(path) 拉表名清单，
 * 加载中/失败态明确；非 SQLite／加密／损坏文件展示引擎中文诊断并允许重试。
 */
function DbTableSelect({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange: (table: string) => void;
}) {
  const [tables, setTables] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!path) {
      setTables(null);
      setLoading(false);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    dataflowDbTables(path).then(
      (list) => {
        if (cancelled) return;
        setTables(list);
        setLoading(false);
      },
      (caught) => {
        if (cancelled) return;
        setTables(null);
        setLoading(false);
        setError(errorText(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, reloadTick]);

  if (!path) {
    return (
      <Note>请先选择 .db 文件，选择后会自动列出其中的数据表。</Note>
    );
  }
  if (loading) {
    return (
      <Field label="数据表">
        <div className="df-db-status" role="status">
          正在读取表清单…
        </div>
      </Field>
    );
  }
  if (error) {
    return (
      <>
        <Field label="数据表">
          <div className="df-db-status df-db-err" role="alert">
            读取表清单失败：{error}
          </div>
        </Field>
        <button type="button" className="df-btn-sm" onClick={() => setReloadTick((tick) => tick + 1)}>
          重试
        </button>
      </>
    );
  }
  const options = tables ?? [];
  // 当前已选表不在清单（旧流程带入）时保留为选项，避免显示值丢失。
  const withCurrent =
    value && !options.includes(value) ? [value, ...options] : options;
  return (
    <Field label="数据表">
      <Sel
        value={value}
        options={[
          { value: "", label: "请选择数据表" },
          ...withCurrent.map((table) => ({ value: table, label: table })),
        ]}
        onChange={onChange}
      />
    </Field>
  );
}

function Swt({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="df-check">
      <SwitchInput checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

function Note({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return <div className={`df-note${warn ? " df-note-warn" : ""}`}>{children}</div>;
}

/** 背景说明的折叠版：默认只占一行「说明」小字，点开才显示原文。
    输入节点的类型规则说明较长，整段铺开时配置区被灰字占满，
    下方预览区被挤出可视范围（用户反馈），需要时再展开阅读。 */
function NoteFold({ children }: { children: ReactNode }) {
  return (
    <details className="df-note-fold">
      <summary>说明</summary>
      <div className="df-note">{children}</div>
    </details>
  );
}

/** 字段列表行工具：上移/下移/删除。 */
function RowTools({
  onUp,
  onDown,
  onRemove,
  upDisabled,
  downDisabled,
  removeDisabled,
}: {
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  upDisabled?: boolean;
  downDisabled?: boolean;
  removeDisabled?: boolean;
}) {
  return (
    <span className="df-list-tools">
      <button type="button" aria-label="上移" title="上移" disabled={upDisabled} onClick={onUp}>
        ↑
      </button>
      <button type="button" aria-label="下移" title="下移" disabled={downDisabled} onClick={onDown}>
        ↓
      </button>
      <button
        type="button"
        aria-label="删除此行"
        title="删除此行"
        disabled={removeDisabled}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}

function moveItem<T>(list: T[], index: number, delta: number): T[] {
  const next = index + delta;
  if (next < 0 || next >= list.length) return list;
  const copy = [...list];
  [copy[index], copy[next]] = [copy[next], copy[index]];
  return copy;
}

function paramHint(params: DataflowParam[]): ReactNode | null {
  if (!params.length) return null;
  return (
    <Note>
      可用参数占位：
      {params.map((param) => `{${param.id}}（${param.name}）`).join("、")}
      ，运行前在「参数」中确认取值。
    </Note>
  );
}

/** 左侧配置区：按节点目录渲染 20 种节点的配置表单，节点名称可改。 */
export function ConfigPanel({
  node,
  params,
  collapsed,
  onToggleCollapse,
  onRename,
  onConfigChange,
  onDelete,
  onPickPath,
  outputDir,
  onPickOutputDir,
}: ConfigPanelProps) {
  // 检查规则编辑器「新增规则类型」的记忆值；hook 须位于所有提前 return 之前。
  const [newCheckRuleType, setNewCheckRuleType] = useState<CheckRuleType>("balance");
  if (collapsed) {
    return (
      <aside className="df-config df-collapsed" aria-label="节点配置（已折叠）">
        <button
          type="button"
          className="df-collapse-btn"
          aria-label="展开配置区"
          title="展开配置区"
          onClick={onToggleCollapse}
        >
          <PanelLeftOpen size={14} />
        </button>
      </aside>
    );
  }
  if (!node) {
    return (
      <aside className="df-config" aria-label="节点配置">
        <div className="df-panel-title">
          <h3>配置</h3>
          <button
            type="button"
            className="df-collapse-btn"
            aria-label="折叠配置区"
            title="折叠配置区"
            onClick={onToggleCollapse}
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
        <div className="df-placeholder">
          点击画布中的节点查看配置
          <br />
          或从上方分类菜单添加节点
        </div>
      </aside>
    );
  }
  const spec = nodeSpec(node.type);
  const config = node.config;
  const setKey = (key: string, value: unknown) => onConfigChange({ ...config, [key]: value });

  const pathField = (extensions: string[]) => {
    const sourceType = String(config.sourceType ?? "file");
    return (
      <Field label={sourceType === "folder" ? "数据文件夹" : "数据文件"}>
        <div className="df-row2">
          <TextIn
            value={String(config.path ?? "")}
            placeholder={sourceType === "folder" ? "选择或输入文件夹路径，支持 {参数id}" : "选择或输入文件路径，支持 {参数id}"}
            onChange={(value) => setKey("path", value)}
          />
          <button
            type="button"
            className="df-btn-sm"
            onClick={() =>
              onPickPath(sourceType === "folder" ? "folder" : "file", extensions, (path) =>
                setKey("path", path),
              )
            }
          >
            选择…
          </button>
        </div>
      </Field>
    );
  };

  const sourceTypeField = () => (
    <Field label="读取方式">
      <Sel
        value={String(config.sourceType ?? "file")}
        options={[
          { value: "file", label: "单文件" },
          { value: "folder", label: "文件夹批量" },
        ]}
        onChange={(value) => setKey("sourceType", value)}
      />
    </Field>
  );

  const columnTypesField = () => {
    const entries = Object.entries(
      (config.columnTypes ?? {}) as Record<string, string>,
    );
    const rows = entries.map(([name, type]) => ({ name, type }));
    const rebuild = (next: { name: string; type: string }[]) => {
      const map: Record<string, string> = {};
      for (const row of next) {
        if (row.name.trim()) map[row.name.trim()] = row.type;
      }
      setKey("columnTypes", map);
    };
    return (
      <Field label="列类型锁定（选「自动」以外即锁定该列）">
        <div className="df-list-head">
          {rows.length === 0 && (
            <NoteFold>未锁定列。账号、编号等易被误判为数字的列建议锁定「文本」，超 15 位整数默认按文本。</NoteFold>
          )}
          {rows.map((row, index) => (
            <div className="df-list-row" key={index}>
              <TextIn
                value={row.name}
                placeholder="列名"
                onChange={(value) =>
                  rebuild(rows.map((item, i) => (i === index ? { ...item, name: value } : item)))
                }
              />
              <Sel
                value={row.type}
                options={COLUMN_TYPE_OPTIONS}
                onChange={(value) =>
                  rebuild(rows.map((item, i) => (i === index ? { ...item, type: value } : item)))
                }
              />
              <RowTools
                onUp={() => rebuild(moveItem(rows, index, -1))}
                onDown={() => rebuild(moveItem(rows, index, 1))}
                onRemove={() => rebuild(rows.filter((_, i) => i !== index))}
                removeDisabled={rows.length <= 1}
              />
            </div>
          ))}
          <button
            type="button"
            className="df-btn-sm"
            onClick={() => rebuild([...rows, { name: "", type: "text" }])}
          >
            添加列类型
          </button>
        </div>
      </Field>
    );
  };

  const onRowErrorField = () => (
    <Field label="异常处理（行级错误）">
      <Sel
        value={String(config.onRowError ?? "stop")}
        options={[
          { value: "stop", label: "停止并报告（默认）" },
          { value: "skip", label: "跳过整行并记录" },
        ]}
        onChange={(value) => setKey("onRowError", value)}
      />
    </Field>
  );

  let form: ReactNode = <Note warn>该节点类型暂未提供配置表单，请更新应用。</Note>;
  switch (node.type) {
    case "excel_in": {
      const sheetMode = String(config.sheetMode ?? "firstData");
      const headerRow = Number(config.headerRow ?? 1);
      const dataStartRow = Number(config.dataStartRow ?? 2);
      form = (
        <>
          <div className="df-group">
            {sourceTypeField()}
            {pathField(["xlsx", "xls", "xlsm", "xlsb", "ods", "csv"])}
            {config.sourceType === "folder" && (
              <>
                <Field label="文件匹配模式">
                  <TextIn
                    value={String(config.filePattern ?? "")}
                    onChange={(value) => setKey("filePattern", value)}
                  />
                </Field>
                <NoteFold>重跑时会在结果区报告文件清单变化：新增/缺失文件逐项列出。</NoteFold>
              </>
            )}
          </div>
          <div className="df-group">
            <Field label="Sheet">
              <Sel
                value={sheetMode}
                options={[
                  { value: "firstData", label: "自动：每个文件第一个有数据的 Sheet" },
                  { value: "byName", label: "按名称指定" },
                ]}
                onChange={(value) => setKey("sheetMode", value)}
              />
            </Field>
            {sheetMode === "byName" && (
              <Field label="Sheet 名称">
                <TextIn
                  value={String(config.sheetName ?? "")}
                  onChange={(value) => setKey("sheetName", value)}
                />
              </Field>
            )}
            <div className="df-row2">
              <Field label="表头行">
                <NumIn value={headerRow} onChange={(value) => setKey("headerRow", value)} />
              </Field>
              <Field label="数据起始行">
                <NumIn value={dataStartRow} onChange={(value) => setKey("dataStartRow", value)} />
              </Field>
            </div>
            {dataStartRow <= headerRow && (
              <Note warn>数据起始行须位于表头行之后。</Note>
            )}
            <Swt
              checked={config.attachSourceColumns === true}
              onChange={(value) => setKey("attachSourceColumns", value)}
              label="附加来源列（来源文件/Sheet/行号）"
            />
          </div>
          <div className="df-group">
            {columnTypesField()}
            {onRowErrorField()}
          </div>
        </>
      );
      break;
    }
    case "csv_in": {
      form = (
        <>
          <div className="df-group">
            {sourceTypeField()}
            {pathField(["csv", "txt", "tsv"])}
          </div>
          <div className="df-group">
            <Field label="编码">
              <Sel
                value={String(config.encoding ?? "auto")}
                options={[
                  { value: "auto", label: "自动识别（默认）" },
                  { value: "gbk", label: "GBK" },
                  { value: "utf8", label: "UTF-8" },
                  { value: "utf8bom", label: "UTF-8（带 BOM）" },
                  { value: "utf16", label: "UTF-16" },
                ]}
                onChange={(value) => setKey("encoding", value)}
              />
            </Field>
            <Field label="分隔符">
              <Sel
                value={String(config.delimiter ?? "auto")}
                options={[
                  { value: "auto", label: "自动识别（默认）" },
                  { value: "comma", label: "逗号" },
                  { value: "tab", label: "Tab" },
                  { value: "semicolon", label: "分号" },
                  { value: "pipe", label: "竖线" },
                ]}
                onChange={(value) => setKey("delimiter", value)}
              />
            </Field>
            <Field label="表头行（首行为表头填 1）">
              <NumIn
                value={Number(config.headerRow ?? 1)}
                onChange={(value) => setKey("headerRow", value)}
              />
            </Field>
            <Swt
              checked={config.attachSourceColumns === true}
              onChange={(value) => setKey("attachSourceColumns", value)}
              label="附加来源列（来源文件/记录序号）"
            />
            <NoteFold>文本编号保留前导零；超 15 位整数默认按文本（保底规则）。</NoteFold>
          </div>
          <div className="df-group">
            {columnTypesField()}
            {onRowErrorField()}
          </div>
        </>
      );
      break;
    }
    case "select_n": {
      const fields = (config.fields ?? []) as SelectFieldConfig[];
      const setFields = (next: SelectFieldConfig[]) => setKey("fields", next);
      form = (
        <>
          <Field label="字段清单（勾选保留，可重命名）">
            <div className="df-list-head">
              {fields.length === 0 && (
                <Note>
                  尚未配置字段。运行后引擎会按上游字段给出建议清单；也可先手工填写字段名。
                </Note>
              )}
              {fields.map((fieldRow, index) => (
                <div className="df-list-row" key={index}>
                  <Chk
                    checked={fieldRow.keep !== false}
                    onChange={(value) =>
                      setFields(
                        fields.map((item, i) => (i === index ? { ...item, keep: value } : item)),
                      )
                    }
                    label=""
                  />
                  <TextIn
                    value={fieldRow.source}
                    placeholder="原字段名"
                    onChange={(value) =>
                      setFields(
                        fields.map((item, i) => (i === index ? { ...item, source: value } : item)),
                      )
                    }
                  />
                  <TextIn
                    value={fieldRow.rename ?? ""}
                    placeholder="重命名为（可空）"
                    onChange={(value) =>
                      setFields(
                        fields.map((item, i) => (i === index ? { ...item, rename: value } : item)),
                      )
                    }
                  />
                  <RowTools
                    onUp={() => setFields(moveItem(fields, index, -1))}
                    onDown={() => setFields(moveItem(fields, index, 1))}
                    onRemove={() => setFields(fields.filter((_, i) => i !== index))}
                    removeDisabled={fields.length <= 1}
                  />
                </div>
              ))}
              <button
                type="button"
                className="df-btn-sm"
                onClick={() => setFields([...fields, { source: "", keep: true, rename: "" }])}
              >
                添加字段
              </button>
            </div>
          </Field>
          <Swt
            checked={config.passThroughNewFields !== false}
            onChange={(value) => setKey("passThroughNewFields", value)}
            label="输入新增字段自动传递到下游"
          />
        </>
      );
      break;
    }
    case "clean": {
      const actions = (config.actions ?? []) as CleanActionConfig[];
      const setActions = (next: CleanActionConfig[]) => setKey("actions", next);
      const patchAction = (index: number, patch: Partial<CleanActionConfig>) =>
        setActions(actions.map((item, i) => (i === index ? { ...item, ...patch } : item)));
      form = (
        <>
          <Field label="清理动作（按字段勾选）">
            <div className="df-list-head">
              {actions.length === 0 && <Note>尚未配置动作。至少为一个字段勾选一个动作。</Note>}
              {actions.map((action, index) => (
                <div className="df-list-head" key={index} style={{ padding: "4px 0", borderBottom: "1px solid var(--border-soft)" }}>
                  <div className="df-list-row">
                    <TextIn
                      value={action.field}
                      placeholder="字段名"
                      onChange={(value) => patchAction(index, { field: value })}
                    />
                    <RowTools
                      onUp={() => setActions(moveItem(actions, index, -1))}
                      onDown={() => setActions(moveItem(actions, index, 1))}
                      onRemove={() => setActions(actions.filter((_, i) => i !== index))}
                      removeDisabled={actions.length <= 1}
                    />
                  </div>
                  {CLEAN_OPS.map((op) => (
                    <Chk
                      key={op.value}
                      checked={action.ops?.includes(op.value) ?? false}
                      onChange={(value) =>
                        patchAction(index, {
                          ops: value
                            ? [...(action.ops ?? []), op.value]
                            : (action.ops ?? []).filter((item) => item !== op.value),
                        })
                      }
                      label={op.label}
                    />
                  ))}
                  {action.ops?.includes("replace") && (
                    <div className="df-row2">
                      <TextIn
                        value={action.replaceFrom ?? ""}
                        placeholder="查找内容"
                        onChange={(value) => patchAction(index, { replaceFrom: value })}
                      />
                      <TextIn
                        value={action.replaceTo ?? ""}
                        placeholder="替换为"
                        onChange={(value) => patchAction(index, { replaceTo: value })}
                      />
                    </div>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="df-btn-sm"
                onClick={() =>
                  setActions([...actions, { field: "", ops: ["trim"], replaceFrom: "", replaceTo: "" }])
                }
              >
                添加字段动作
              </button>
            </div>
          </Field>
          <Swt
            checked={config.dropBlankRows === true}
            onChange={(value) => setKey("dropBlankRows", value)}
            label="删除整行空记录"
          />
          <Swt
            checked={config.nullTextToNull === true}
            onChange={(value) => setKey("nullTextToNull", value)}
            label="空文本（含纯空格）转为空值"
          />
          <Note>未开启空值转换时不改变关联/去重含义（空文本与空值仍视为不同值）。</Note>
        </>
      );
      break;
    }
    case "formula": {
      const formulas = (config.formulas ?? []) as FormulaConfig[];
      const setFormulas = (next: FormulaConfig[]) => setKey("formulas", next);
      form = (
        <>
          <Field label="公式清单（按顺序计算）">
            <div className="df-list-head">
              {formulas.map((formula, index) => (
                <div className="df-list-head" key={index}>
                  <div className="df-list-row">
                    <TextIn
                      value={formula.target}
                      placeholder="目标字段（新列名或现有列名）"
                      onChange={(value) =>
                        setFormulas(
                          formulas.map((item, i) => (i === index ? { ...item, target: value } : item)),
                        )
                      }
                    />
                    <RowTools
                      onUp={() => setFormulas(moveItem(formulas, index, -1))}
                      onDown={() => setFormulas(moveItem(formulas, index, 1))}
                      onRemove={() => setFormulas(formulas.filter((_, i) => i !== index))}
                      removeDisabled={formulas.length <= 1}
                    />
                  </div>
                  <textarea
                    className="df-in"
                    rows={2}
                    value={formula.expression}
                    placeholder="表达式，如 借方金额 － 贷方金额"
                    onChange={(event) =>
                      setFormulas(
                        formulas.map((item, i) =>
                          i === index ? { ...item, expression: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </div>
              ))}
              <button
                type="button"
                className="df-btn-sm"
                onClick={() => setFormulas([...formulas, { target: "", expression: "" }])}
              >
                添加公式
              </button>
            </div>
          </Field>
          {onRowErrorField()}
          <Note>后面的公式可引用前面生成的新字段；普通运算遇空值得空值，除零等行级异常按上方「异常处理」设置处理（默认停止）。</Note>
        </>
      );
      break;
    }
    case "filter_n": {
      const condition = (config.condition ?? { op: "and", rules: [] }) as FilterConditionConfig;
      const setCondition = (next: FilterConditionConfig) => setKey("condition", next);
      const rules = condition.rules?.length
        ? condition.rules
        : [{ field: "", operator: "=", value: "" }];
      form = (
        <>
          <Field label="条件组合">
            <Sel
              value={condition.op === "or" ? "or" : "and"}
              options={[
                { value: "and", label: "全部满足（且）" },
                { value: "or", label: "任一满足（或）" },
              ]}
              onChange={(value) => setCondition({ ...condition, op: value as "and" | "or" })}
            />
          </Field>
          <Field label="条件（字段＋运算符＋值）">
            <div className="df-list-head">
              {rules.map((rule, index) => (
                <div
                  className={`df-list-row${incompleteFilterRule(rule) ? " df-row-incomplete" : ""}`}
                  key={index}
                  title={
                    incompleteFilterRule(rule)
                      ? "这条条件还没填完整（字段或值）：运行前请补全，或删除这一行。"
                      : undefined
                  }
                >
                  <TextIn
                    value={rule.field}
                    placeholder="字段"
                    onChange={(value) =>
                      setCondition({
                        ...condition,
                        rules: rules.map((item, i) => (i === index ? { ...item, field: value } : item)),
                      })
                    }
                  />
                  <Sel
                    value={rule.operator}
                    options={FILTER_OPERATORS.map((op) => ({ value: op.value, label: op.label }))}
                    onChange={(value) =>
                      setCondition({
                        ...condition,
                        rules: rules.map((item, i) =>
                          i === index ? { ...item, operator: value } : item,
                        ),
                      })
                    }
                  />
                  <TextIn
                    value={rule.value}
                    placeholder="值（为空/不为空时无需填）"
                    onChange={(value) =>
                      setCondition({
                        ...condition,
                        rules: rules.map((item, i) => (i === index ? { ...item, value } : item)),
                      })
                    }
                  />
                  <RowTools
                    onUp={() =>
                      setCondition({ ...condition, rules: moveItem(rules, index, -1) })
                    }
                    onDown={() => setCondition({ ...condition, rules: moveItem(rules, index, 1) })}
                    onRemove={() =>
                      setCondition({
                        ...condition,
                        rules: rules.length > 1 ? rules.filter((_, i) => i !== index) : rules,
                      })
                    }
                    removeDisabled={rules.length <= 1}
                  />
                </div>
              ))}
              <button
                type="button"
                className="df-btn-sm"
                onClick={() =>
                  setCondition({
                    ...condition,
                    rules: [...rules, { field: "", operator: "=", value: "" }],
                  })
                }
              >
                添加条件
              </button>
            </div>
          </Field>
          <Note>符合 → T 路；不符合（含空值）→ F 路。空值须用「为空/不为空」显式判断。</Note>
        </>
      );
      break;
    }
    case "excel_out": {
      form = (
        <>
          <Field label="输出位置（文件名留空时自动按时间戳命名）">
            <div className="df-outdir">
              <span className="df-outdir-path" title={outputDir || undefined}>
                {outputDir || "未设置：运行时会请您选择一次并记住"}
              </span>
              <button type="button" className="df-btn-sm" onClick={onPickOutputDir}>
                选择…
              </button>
            </div>
          </Field>
          <NoteFold>文件名可只填名字或留空：留空＝自动命名（流程名_节点名_时间戳），都会保存到上方「输出位置」；填了扩展名会自动补齐；需要存到别处时再填含盘符的完整路径。</NoteFold>
          <Field label="输出文件名（可代入参数）">
            <TextIn
              value={String(config.fileName ?? "")}
              placeholder="如 大额客商_{参数id}.xlsx"
              onChange={(value) => setKey("fileName", value)}
            />
          </Field>
          {paramHint(params)}
          <Field label="Sheet 名（默认＝上游节点名）">
            <TextIn
              value={String(config.sheetName ?? "")}
              onChange={(value) => setKey("sheetName", value)}
            />
          </Field>
          <Field label="覆盖保护">
            <Sel
              value={String(config.overwrite ?? "error")}
              options={[
                { value: "error", label: "已存在：报错并提示（默认）" },
                { value: "timestamp", label: "已存在：自动加时间戳" },
                { value: "replace", label: "已存在：直接覆盖" },
              ]}
              onChange={(value) => setKey("overwrite", value)}
            />
          </Field>
          <Field label="行数超量处理">
            <Sel
              value={String(config.splitMode ?? "sheet")}
              options={[
                { value: "sheet", label: "自动分 Sheet（默认）" },
                { value: "file", label: "自动分文件" },
                { value: "error", label: "报错" },
              ]}
              onChange={(value) => setKey("splitMode", value)}
            />
          </Field>
          <Note warn>预览运行不写输出文件，只在结果区展示样本。</Note>
        </>
      );
      break;
    }
    case "csv_out": {
      form = (
        <>
          <Field label="输出位置（文件名留空时自动按时间戳命名）">
            <div className="df-outdir">
              <span className="df-outdir-path" title={outputDir || undefined}>
                {outputDir || "未设置：运行时会请您选择一次并记住"}
              </span>
              <button type="button" className="df-btn-sm" onClick={onPickOutputDir}>
                选择…
              </button>
            </div>
          </Field>
          <NoteFold>文件名可只填名字或留空：留空＝自动命名（流程名_节点名_时间戳），都会保存到上方「输出位置」；填了扩展名会自动补齐；需要存到别处时再填含盘符的完整路径。</NoteFold>
          <Field label="输出文件名（可代入参数）">
            <TextIn
              value={String(config.fileName ?? "")}
              placeholder="如 明细_{参数id}.csv"
              onChange={(value) => setKey("fileName", value)}
            />
          </Field>
          {paramHint(params)}
          <Field label="编码">
            <Sel
              value={String(config.encoding ?? "gbk")}
              options={[
                { value: "gbk", label: "GBK（默认）" },
                { value: "utf8bom", label: "UTF-8（带 BOM）" },
                { value: "utf8", label: "UTF-8" },
              ]}
              onChange={(value) => setKey("encoding", value)}
            />
          </Field>
          <Field label="分隔符">
            <Sel
              value={String(config.delimiter ?? "comma")}
              options={[
                { value: "comma", label: "逗号（默认）" },
                { value: "tab", label: "Tab" },
                { value: "semicolon", label: "分号" },
                { value: "pipe", label: "竖线" },
              ]}
              onChange={(value) => setKey("delimiter", value)}
            />
          </Field>
          <Field label="覆盖保护">
            <Sel
              value={String(config.overwrite ?? "error")}
              options={[
                { value: "error", label: "已存在：报错并提示（默认）" },
                { value: "timestamp", label: "已存在：自动加时间戳" },
                { value: "replace", label: "已存在：直接覆盖" },
              ]}
              onChange={(value) => setKey("overwrite", value)}
            />
          </Field>
          <Field label="按行数分文件（0＝不分）">
            <NumIn
              value={Number(config.splitRows ?? 0)}
              onChange={(value) => setKey("splitRows", Math.max(0, value))}
            />
          </Field>
          <Note warn>预览运行不写输出文件，只在结果区展示样本。</Note>
        </>
      );
      break;
    }
    case "join_n": {
      const keys = (config.keys ?? []) as JoinKeyPair[];
      const setKeys = (next: JoinKeyPair[]) => setKey("keys", next);
      form = (
        <>
          <Field label="关联字段配对（左 ↔ 右，多行＝复合键）">
            <div className="df-list-head">
              {keys.map((pair, index) => (
                <div className="df-list-row" key={index}>
                  <TextIn
                    value={pair.left}
                    placeholder="左表字段名"
                    onChange={(value) =>
                      setKeys(keys.map((item, i) => (i === index ? { ...item, left: value } : item)))
                    }
                  />
                  <TextIn
                    value={pair.right}
                    placeholder="右表字段名"
                    onChange={(value) =>
                      setKeys(keys.map((item, i) => (i === index ? { ...item, right: value } : item)))
                    }
                  />
                  <RowTools
                    onUp={() => setKeys(moveItem(keys, index, -1))}
                    onDown={() => setKeys(moveItem(keys, index, 1))}
                    onRemove={() => setKeys(keys.filter((_, i) => i !== index))}
                    removeDisabled={keys.length <= 1}
                  />
                </div>
              ))}
              <button
                type="button"
                className="df-btn-sm"
                onClick={() => setKeys([...keys, { left: "", right: "" }])}
              >
                添加配对
              </button>
            </div>
          </Field>
          <Note>两侧字段类型须一致（文本键与数字键不静默互转）；复合键任一字段为空值时不匹配；空文本按具体值参与。</Note>
          <Field label="J 路左表输出字段（留空＝全部保留）">
            <TokenIn
              value={(config.leftFields ?? []) as string[]}
              placeholder="左表字段名，多个用「、」分隔"
              onChange={(value) => setKey("leftFields", value)}
            />
          </Field>
          <Field label="J 路右表输出字段（留空＝全部保留）">
            <TokenIn
              value={(config.rightFields ?? []) as string[]}
              placeholder="右表字段名，多个用「、」分隔"
              onChange={(value) => setKey("rightFields", value)}
            />
          </Field>
          <Field label="右表同名字段后缀">
            <TextIn
              value={String(config.sameNameSuffix ?? "_右")}
              onChange={(value) => setKey("sameNameSuffix", value)}
            />
          </Field>
          <Note>
            固定 J/L/R 三路：内关联取 J；左/右/全关联用 J＋L/R 经「字段选择＋纵向合并」组合。
            多对多按组合展开（同一键左 3 条×右 4 条＝12 条），不自动去重，膨胀统计见结果区「统计」。
          </Note>
        </>
      );
      break;
    }
    case "union_n": {
      form = (
        <>
          <Field label="对齐方式">
            <Sel
              value={String(config.align ?? "byName")}
              options={[
                { value: "byName", label: "按字段名对齐（默认）" },
                { value: "byPosition", label: "按位置对齐" },
              ]}
              onChange={(value) => setKey("align", value)}
            />
          </Field>
          <Field label="多出字段处理">
            <Sel
              value={String(config.extraFieldPolicy ?? "keep")}
              options={[
                { value: "keep", label: "保留（字段取并集，缺失侧补空值）（默认）" },
                { value: "drop", label: "丢弃（只保留两侧共有字段）" },
              ]}
              onChange={(value) => setKey("extraFieldPolicy", value)}
            />
          </Field>
          <Field label="类型冲突处理">
            <Sel
              value={String(config.typeConflictPolicy ?? "text")}
              options={[
                { value: "text", label: "统一为文本并提示（默认）" },
                { value: "stop", label: "停止并报告" },
              ]}
              onChange={(value) => setKey("typeConflictPolicy", value)}
            />
          </Field>
          <Note>可接入多条上游连线；拼接次序按连线添加顺序；字段差异报告在结果区「统计」完整显示。</Note>
        </>
      );
      break;
    }
    case "unique_n": {
      form = (
        <>
          <Field label="去重字段（至少 1 个）">
            <TokenIn
              value={(config.fields ?? []) as string[]}
              placeholder="字段名，多个用「、」分隔"
              onChange={(value) => setKey("fields", value)}
            />
          </Field>
          <Field label="保留规则">
            <Sel
              value={String(config.keep ?? "first")}
              options={[
                { value: "first", label: "首次出现（默认）" },
                { value: "last", label: "最后一次" },
              ]}
              onChange={(value) => setKey("keep", value)}
            />
          </Field>
          <Note>同位置的空值视为同一分组键、空文本仍是另一值；首次/末次依据输入顺序，结果区显示 U/D 两路行数守恒。</Note>
        </>
      );
      break;
    }
    case "sort_n": {
      const rules = (config.rules ?? []) as SortRuleConfig[];
      const setRules = (next: SortRuleConfig[]) => setKey("rules", next);
      const patchRule = (index: number, patch: Partial<SortRuleConfig>) =>
        setRules(rules.map((item, i) => (i === index ? { ...item, ...patch } : item)));
      form = (
        <>
          <Field label="排序字段（行序即优先级）">
            <div className="df-list-head">
              {rules.map((rule, index) => (
                <div className="df-list-row" key={index}>
                  <TextIn
                    value={rule.field}
                    placeholder="字段名"
                    onChange={(value) => patchRule(index, { field: value })}
                  />
                  <Sel
                    value={rule.direction}
                    options={[
                      { value: "asc", label: "升序" },
                      { value: "desc", label: "降序" },
                    ]}
                    onChange={(value) =>
                      patchRule(index, { direction: value as "asc" | "desc" })
                    }
                  />
                  <Sel
                    value={rule.nulls}
                    options={[
                      { value: "last", label: "空值排最后（默认）" },
                      { value: "first", label: "空值排最前" },
                    ]}
                    onChange={(value) =>
                      patchRule(index, { nulls: value as "first" | "last" })
                    }
                  />
                  <RowTools
                    onUp={() => setRules(moveItem(rules, index, -1))}
                    onDown={() => setRules(moveItem(rules, index, 1))}
                    onRemove={() => setRules(rules.filter((_, i) => i !== index))}
                    removeDisabled={rules.length <= 1}
                  />
                </div>
              ))}
              <button
                type="button"
                className="df-btn-sm"
                onClick={() => setRules([...rules, { field: "", direction: "asc", nulls: "last" }])}
              >
                添加排序字段
              </button>
            </div>
          </Field>
          <Note>全局排序；相同排序键按输入到达顺序保持相对次序（稳定排序）。</Note>
        </>
      );
      break;
    }
    case "summarize": {
      const aggregations = (config.aggregations ?? []) as SummarizeAggregation[];
      const setAggregations = (next: SummarizeAggregation[]) => setKey("aggregations", next);
      form = (
        <>
          <Field label="分组字段（留空＝全表作为一组）">
            <TokenIn
              value={(config.groupBy ?? []) as string[]}
              placeholder="字段名，多个用「、」分隔"
              onChange={(value) => setKey("groupBy", value)}
            />
          </Field>
          <Field label="聚合配置（输出名留空＝字段_聚合方式）">
            <div className="df-list-head">
              {aggregations.map((agg, index) => (
                <div className="df-list-row" key={index}>
                  <TextIn
                    value={agg.field}
                    placeholder="字段（总行数可留空）"
                    onChange={(value) =>
                      setAggregations(
                        aggregations.map((item, i) => (i === index ? { ...item, field: value } : item)),
                      )
                    }
                  />
                  <Sel
                    value={agg.func}
                    options={SUMMARIZE_FUNCS.map((fn) => ({ value: fn.value, label: fn.label }))}
                    onChange={(value) =>
                      setAggregations(
                        aggregations.map((item, i) =>
                          i === index ? { ...item, func: value as SummarizeFunc } : item,
                        ),
                      )
                    }
                  />
                  <TextIn
                    value={agg.output}
                    placeholder="输出字段名（可空）"
                    onChange={(value) =>
                      setAggregations(
                        aggregations.map((item, i) => (i === index ? { ...item, output: value } : item)),
                      )
                    }
                  />
                  <RowTools
                    onUp={() => setAggregations(moveItem(aggregations, index, -1))}
                    onDown={() => setAggregations(moveItem(aggregations, index, 1))}
                    onRemove={() => setAggregations(aggregations.filter((_, i) => i !== index))}
                    removeDisabled={aggregations.length <= 1}
                  />
                </div>
              ))}
              <button
                type="button"
                className="df-btn-sm"
                onClick={() =>
                  setAggregations([...aggregations, { field: "", func: "countAll", output: "" }])
                }
              >
                添加聚合
              </button>
            </div>
          </Field>
          <Note>求和/平均/最小/最大跳过空值，无有效值时返回空值；平均以有效值数量为分母，不无提示补零。</Note>
        </>
      );
      break;
    }
    case "crosstab": {
      form = (
        <>
          <div className="df-row2">
            <Field label="行字段">
              <TextIn
                value={String(config.rowField ?? "")}
                placeholder="如 客商名称"
                onChange={(value) => setKey("rowField", value)}
              />
            </Field>
            <Field label="列字段（首版 1 个）">
              <TextIn
                value={String(config.columnField ?? "")}
                placeholder="如 期间"
                onChange={(value) => setKey("columnField", value)}
              />
            </Field>
          </div>
          <div className="df-row2">
            <Field label="值字段">
              <TextIn
                value={String(config.valueField ?? "")}
                placeholder="如 借方金额"
                onChange={(value) => setKey("valueField", value)}
              />
            </Field>
            <Field label="聚合方式">
              {/* 透视引擎仅支持求和/非空计数/去重计数（aggregate.rs 白名单），不能复用汇总的全量枚举。 */}
              <Sel
                value={String(config.valueFunc ?? "sum")}
                options={CROSSTAB_VALUE_FUNCS.map((fn) => ({ value: fn.value, label: fn.label }))}
                onChange={(value) => setKey("valueFunc", value)}
              />
            </Field>
          </div>
          <Field label="缺失组合填充">
            <Sel
              value={config.fill === null ? "null" : String(config.fill ?? 0)}
              options={[
                { value: "0", label: "0（默认）" },
                { value: "null", label: "空值" },
              ]}
              onChange={(value) => setKey("fill", value === "null" ? null : 0)}
            />
          </Field>
          <Note>动态生成列名＝列字段原值；列数/资源超出边界时明确失败，不静默丢列。</Note>
        </>
      );
      break;
    }
    case "transpose": {
      form = (
        <>
          <Field label="保持不变的列（固定列）">
            <TokenIn
              value={(config.fixedFields ?? []) as string[]}
              placeholder="字段名，多个用「、」分隔"
              onChange={(value) => setKey("fixedFields", value)}
            />
          </Field>
          <Field label="转入行的列（转置列，至少 1 个）">
            <TokenIn
              value={(config.valueColumns ?? []) as string[]}
              placeholder="字段名，多个用「、」分隔"
              onChange={(value) => setKey("valueColumns", value)}
            />
          </Field>
          <div className="df-row2">
            <Field label="原列名新列名">
              <TextIn
                value={String(config.nameColumn ?? "项目")}
                onChange={(value) => setKey("nameColumn", value)}
              />
            </Field>
            <Field label="取值新列名">
              <TextIn
                value={String(config.valueColumn ?? "数值")}
                onChange={(value) => setKey("valueColumn", value)}
              />
            </Field>
          </div>
          <Note>转置列与固定列不得重叠；输出行数＝输入行数 × 转置列数（结果区有核对展示）。</Note>
        </>
      );
      break;
    }
    case "split": {
      const mode = String(config.mode ?? "delimiter");
      const widths = (config.widths ?? []) as number[];
      const setWidths = (next: number[]) => setKey("widths", next);
      form = (
        <>
          <Field label="源列">
            <TextIn
              value={String(config.field ?? "")}
              placeholder="要拆分的字段名"
              onChange={(value) => setKey("field", value)}
            />
          </Field>
          <Field label="拆分方式">
            <Sel
              value={mode}
              options={[
                { value: "delimiter", label: "按分隔符" },
                { value: "fixedWidth", label: "按固定宽度" },
              ]}
              onChange={(value) => setKey("mode", value)}
            />
          </Field>
          {mode === "delimiter" ? (
            <Field label="分隔符">
              <TextIn
                value={String(config.delimiter ?? "")}
                placeholder="如 - 或 ，"
                onChange={(value) => setKey("delimiter", value)}
              />
            </Field>
          ) : (
            <Field label="固定宽度（逐段宽度，字符数）">
              <div className="df-list-head">
                {widths.map((width, index) => (
                  <div className="df-list-row" key={index}>
                    <NumIn
                      value={width}
                      onChange={(value) =>
                        setWidths(widths.map((item, i) => (i === index ? Math.max(1, value) : item)))
                      }
                    />
                    <RowTools
                      onUp={() => setWidths(moveItem(widths, index, -1))}
                      onDown={() => setWidths(moveItem(widths, index, 1))}
                      onRemove={() => setWidths(widths.filter((_, i) => i !== index))}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="df-btn-sm"
                  onClick={() => setWidths([...widths, 4])}
                >
                  添加宽度
                </button>
              </div>
            </Field>
          )}
          <Field label="拆出列前缀（留空＝源列名）">
            <TextIn
              value={String(config.columnPrefix ?? "")}
              placeholder="如 科目编码"
              onChange={(value) => setKey("columnPrefix", value)}
            />
          </Field>
          <Swt
            checked={config.keepOriginal === true}
            onChange={(value) => setKey("keepOriginal", value)}
            label="保留原列"
          />
          <Note>段不足补空值；超出部分并入最后一段（不丢内容）；拆出列数上限 20。</Note>
        </>
      );
      break;
    }
    case "check_n": {
      const rules = (config.rules ?? []) as CheckRuleConfig[];
      const setRules = (next: CheckRuleConfig[]) => setKey("rules", next);
      const patchRule = (index: number, patch: Partial<CheckRuleConfig>) =>
        setRules(rules.map((item, i) => (i === index ? { ...item, ...patch } : item)));
      form = (
        <>
          <Field label="检查规则（可多条，全部通过才进 P 路）">
            <div className="df-list-head">
              {rules.length === 0 && <Note>尚未配置规则。至少添加一条规则后节点才有校验意义。</Note>}
              {rules.map((rule, index) => (
                <div
                  className="df-list-head"
                  key={index}
                  style={{ padding: "4px 0", borderBottom: "1px solid var(--border-soft)" }}
                >
                  <div className="df-list-row">
                    <Sel
                      value={rule.type}
                      options={CHECK_RULE_TYPES.map((item) => ({ value: item.value, label: item.label }))}
                      onChange={(value) =>
                        // 切换类型＝整条重建，避免残留旧类型的字段。
                        setRules(
                          rules.map((item, i) =>
                            i === index ? defaultCheckRule(value as CheckRuleType) : item,
                          ),
                        )
                      }
                    />
                    <RowTools
                      onUp={() => setRules(moveItem(rules, index, -1))}
                      onDown={() => setRules(moveItem(rules, index, 1))}
                      onRemove={() => setRules(rules.filter((_, i) => i !== index))}
                    />
                  </div>
                  {rule.type === "balance" && (
                    <div className="df-list-head">
                      <TokenIn
                        value={rule.groupBy ?? []}
                        placeholder="分组字段（留空＝全表），如 凭证号"
                        onChange={(value) => patchRule(index, { groupBy: value })}
                      />
                      <div className="df-row2">
                        <TextIn
                          value={rule.debitField ?? ""}
                          placeholder="借方金额字段"
                          onChange={(value) => patchRule(index, { debitField: value })}
                        />
                        <TextIn
                          value={rule.creditField ?? ""}
                          placeholder="贷方金额字段"
                          onChange={(value) => patchRule(index, { creditField: value })}
                        />
                        <DecIn
                          value={rule.tolerance ?? 0}
                          onChange={(value) => patchRule(index, { tolerance: value })}
                        />
                      </div>
                      <span className="df-db-status">最右侧数字＝容差（须显式填写，默认 0＝精确相等）</span>
                    </div>
                  )}
                  {rule.type === "notEmpty" && (
                    <TokenIn
                      value={rule.fields ?? []}
                      placeholder="非空字段，多个用「、」分隔"
                      onChange={(value) => patchRule(index, { fields: value })}
                    />
                  )}
                  {rule.type === "unique" && (
                    <div className="df-list-head">
                      <TextIn
                        value={rule.field ?? ""}
                        placeholder="唯一性字段（如 凭证号）"
                        onChange={(value) => patchRule(index, { field: value })}
                      />
                      <TokenIn
                        value={rule.groupBy ?? []}
                        placeholder="分组内唯一（留空＝全表唯一）"
                        onChange={(value) => patchRule(index, { groupBy: value })}
                      />
                    </div>
                  )}
                  {rule.type === "range" && (
                    <div className="df-row2">
                      <TextIn
                        value={rule.field ?? ""}
                        placeholder="数值字段"
                        onChange={(value) => patchRule(index, { field: value })}
                      />
                      <NumOptIn
                        value={rule.min ?? null}
                        placeholder="下限（≥）"
                        onChange={(value) => patchRule(index, { min: value })}
                      />
                      <NumOptIn
                        value={rule.max ?? null}
                        placeholder="上限（≤）"
                        onChange={(value) => patchRule(index, { max: value })}
                      />
                    </div>
                  )}
                  {rule.type === "expression" && (
                    <textarea
                      className="df-in"
                      rows={2}
                      value={rule.expression ?? ""}
                      placeholder="行级条件表达式，条件成立视为通过"
                      onChange={(event) => patchRule(index, { expression: event.target.value })}
                    />
                  )}
                </div>
              ))}
              <div className="df-row2">
                <Sel
                  value={newCheckRuleType}
                  options={CHECK_RULE_TYPES.map((item) => ({ value: item.value, label: item.label }))}
                  onChange={(value) => setNewCheckRuleType(value as CheckRuleType)}
                />
                <button
                  type="button"
                  className="df-btn-sm"
                  onClick={() => setRules([...rules, defaultCheckRule(newCheckRuleType)])}
                >
                  添加规则
                </button>
              </div>
            </div>
          </Field>
          <Note>非空判定从严：空值与纯空格文本都算空；数值区间为闭区间、空值判未通过并标注；重复编号整组进未通过路。空输入等情况写入规则执行摘要，不等同于检查通过。</Note>
        </>
      );
      break;
    }
    case "manual_in": {
      const columns = (config.columns ?? []) as ManualColumnConfig[];
      const rows = (config.rows ?? []) as string[][];
      /**
       * 列结构变化时按 sourceIndexes 重排单元格：
       * sourceIndexes[k]＝新第 k 列取旧列哪个下标的单元格（-1＝新列补空），
       * 加列/删列/改序后每行单元格与列保持对齐。
       */
      const applyColumns = (next: ManualColumnConfig[], sourceIndexes: number[]) => {
        const nextRows = rows.map((row) =>
          sourceIndexes.map((index) => (index >= 0 ? row[index] ?? "" : "")),
        );
        onConfigChange({ ...config, columns: next, rows: nextRows });
      };
      const identityIndexes = columns.map((_, index) => index);
      const setRows = (next: string[][]) => setKey("rows", next);
      form = (
        <>
          <Note>小表随流程文件保存，分享时会一并发出。</Note>
          <Field label="列定义（列名＋类型）">
            <div className="df-list-head">
              {columns.map((column, index) => (
                <div className="df-list-row" key={index}>
                  <TextIn
                    value={column.name}
                    placeholder="列名"
                    onChange={(value) =>
                      applyColumns(
                        columns.map((item, i) => (i === index ? { ...item, name: value } : item)),
                        identityIndexes,
                      )
                    }
                  />
                  <Sel
                    value={column.type}
                    options={MANUAL_COLUMN_TYPES.map((item) => ({ value: item.value, label: item.label }))}
                    onChange={(value) =>
                      applyColumns(
                        columns.map((item, i) =>
                          i === index ? { ...item, type: value as ManualColumnConfig["type"] } : item,
                        ),
                        identityIndexes,
                      )
                    }
                  />
                  <RowTools
                    onUp={() =>
                      applyColumns(moveItem(columns, index, -1), moveItem(identityIndexes, index, -1))
                    }
                    onDown={() =>
                      applyColumns(moveItem(columns, index, 1), moveItem(identityIndexes, index, 1))
                    }
                    onRemove={() =>
                      applyColumns(
                        columns.filter((_, i) => i !== index),
                        identityIndexes.filter((i) => i !== index),
                      )
                    }
                    removeDisabled={columns.length <= 1}
                  />
                </div>
              ))}
              <button
                type="button"
                className="df-btn-sm"
                onClick={() => applyColumns([...columns, { name: "列名", type: "text" }], [...identityIndexes, -1])}
              >
                添加列
              </button>
            </div>
          </Field>
          <Field label={`小表数据（${columns.length} 列 × ${rows.length} 行）`}>
            <div className="df-mini-grid">
              {rows.map((row, rowIndex) => (
                <div className="df-mini-row" key={rowIndex}>
                  {columns.map((column, colIndex) => (
                    <input
                      key={colIndex}
                      className="df-in"
                      type="text"
                      aria-label={`单元格 ${rowIndex + 1} 行 ${colIndex + 1} 列（${column.name || "未命名"}）`}
                      value={row[colIndex] ?? ""}
                      onChange={(event) =>
                        setRows(
                          rows.map((item, i) => {
                            if (i !== rowIndex) return item;
                            const cells = item.slice();
                            while (cells.length < columns.length) cells.push("");
                            cells[colIndex] = event.target.value;
                            return cells;
                          }),
                        )
                      }
                    />
                  ))}
                  <RowTools
                    onUp={() => setRows(moveItem(rows, rowIndex, -1))}
                    onDown={() => setRows(moveItem(rows, rowIndex, 1))}
                    onRemove={() => setRows(rows.filter((_, i) => i !== rowIndex))}
                  />
                </div>
              ))}
              <button
                type="button"
                className="df-btn-sm"
                onClick={() => setRows([...rows, columns.map(() => "")])}
              >
                添加行
              </button>
            </div>
          </Field>
          {onRowErrorField()}
          <Note>值与所设列类型不符时按行级异常处理；超过内嵌容量上限会提示改用外部文件输入。</Note>
        </>
      );
      break;
    }
    case "db_in": {
      const path = String(config.path ?? "");
      form = (
        <>
          <Field label="数据库文件（.db）">
            <div className="df-row2">
              <TextIn
                value={path}
                placeholder="选择或输入 .db 文件路径，支持 {参数id}"
                onChange={(value) => setKey("path", value)}
              />
              <button
                type="button"
                className="df-btn-sm"
                onClick={() => onPickPath("file", ["db", "sqlite", "sqlite3", "db3"], (picked) => setKey("path", picked))}
              >
                选择…
              </button>
            </div>
          </Field>
          <DbTableSelect
            path={path}
            value={String(config.table ?? "")}
            onChange={(table) => setKey("table", table)}
          />
          <Field label="读取字段（留空＝全部字段）">
            <TokenIn
              value={(config.fields ?? []) as string[]}
              placeholder="字段名，多个用「、」分隔"
              onChange={(value) => setKey("fields", value)}
            />
          </Field>
          <Note>记录以表名与可用主键标识；类型按表结构保留。未知、加密或损坏文件会给出明确中文诊断。</Note>
        </>
      );
      break;
    }
    case "parquet_in": {
      form = (
        <>
          <Field label="Parquet 文件">
            <div className="df-row2">
              <TextIn
                value={String(config.path ?? "")}
                placeholder="选择或输入 .parquet 文件路径，支持 {参数id}"
                onChange={(value) => setKey("path", value)}
              />
              <button
                type="button"
                className="df-btn-sm"
                onClick={() => onPickPath("file", ["parquet"], (picked) => setKey("path", picked))}
              >
                选择…
              </button>
            </div>
          </Field>
          <Field label="读取字段（留空＝全部字段）">
            <TokenIn
              value={(config.fields ?? []) as string[]}
              placeholder="字段名，多个用「、」分隔"
              onChange={(value) => setKey("fields", value)}
            />
          </Field>
          <Note>类型与精度按文件结构保留；多文件结构须兼容，浮点字段不静默当作精确十进制。</Note>
        </>
      );
      break;
    }
    default:
      form = <Note warn>该节点类型暂未提供配置表单，请更新应用。</Note>;
  }

  return (
    <aside className="df-config" aria-label="节点配置">
      <div className="df-panel-title">
        <h3>配置</h3>
        <button
          type="button"
          className="df-collapse-btn"
          aria-label="折叠配置区"
          title="折叠配置区"
          onClick={onToggleCollapse}
        >
          <PanelLeftClose size={14} />
        </button>
      </div>
      <Field label="节点名称">
        <TextIn value={node.name} onChange={(value) => onRename(value || node.name)} />
      </Field>
      <p
        className="df-type-line"
        style={spec ? ({ ["--df-cat" as string]: CATEGORY_COLOR[spec.category] } as CSSProperties) : undefined}
      >
        <i className="df-type-dot" aria-hidden="true" />
        <span className="df-type-text">
          {spec
            ? `${spec.cn} ${spec.en} · ${categoryCn(spec.category)} · ${node.id}`
            : node.type}
        </span>
      </p>
      {form}
      <div className="df-cfg-foot">
        {node.type === "excel_in" || node.type === "csv_in" ? null : node.type === "formula" ? (
          <Note>行级异常（除零、转换失败等）按本节点「异常处理」设置独立生效，与输入节点的设置无关；结构性错误一律停止。</Note>
        ) : (
          <Note>行级异常策略由输入节点的「异常处理」设置决定；结构性错误一律停止。</Note>
        )}
        <button type="button" className="df-btn-danger" onClick={onDelete}>
          删除节点
        </button>
      </div>
    </aside>
  );
}
