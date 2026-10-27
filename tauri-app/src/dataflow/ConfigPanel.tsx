import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { SwitchInput } from "@/components/SwitchInput";
import {
  FILTER_OPERATORS,
  type CleanActionConfig,
  type DataflowNode,
  type DataflowParam,
  type FilterConditionConfig,
  type FormulaConfig,
  type SelectFieldConfig,
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

/** 左侧配置区：按节点目录渲染 8 种第一期节点的配置表单，节点名称可改。 */
export function ConfigPanel({
  node,
  params,
  collapsed,
  onToggleCollapse,
  onRename,
  onConfigChange,
  onDelete,
  onPickPath,
}: ConfigPanelProps) {
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
            <Note>未锁定列。账号、编号等易被误判为数字的列建议锁定「文本」，超 15 位整数默认按文本。</Note>
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

  let form: ReactNode = <Note warn>该节点为二期能力，第一期不可配置。</Note>;
  switch (node.type) {
    case "excel_in": {
      const sheetMode = String(config.sheetMode ?? "firstData");
      const headerRow = Number(config.headerRow ?? 1);
      const dataStartRow = Number(config.dataStartRow ?? 2);
      form = (
        <>
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
              <Note>重跑时会在结果区报告文件清单变化：新增/缺失文件逐项列出。</Note>
            </>
          )}
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
          {columnTypesField()}
          {onRowErrorField()}
        </>
      );
      break;
    }
    case "csv_in": {
      form = (
        <>
          {sourceTypeField()}
          {pathField(["csv", "txt", "tsv"])}
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
          <Note>文本编号保留前导零；超 15 位整数默认按文本（保底规则）。</Note>
          {columnTypesField()}
          {onRowErrorField()}
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
          <Note>后面的公式可引用前面生成的新字段；普通运算遇空值得空值，除零按行级异常处理。</Note>
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
                <div className="df-list-row" key={index}>
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
    default:
      form = <Note warn>该节点为二期能力，第一期暂不提供配置。</Note>;
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
      <p className="df-type-line">
        {spec ? `${spec.cn} ${spec.en} · ${categoryCn(spec.category)} · ${node.id}` : node.type}
      </p>
      {form}
      <div className="df-cfg-foot">
        {node.type === "excel_in" || node.type === "csv_in" ? null : (
          <Note>行级异常策略由输入节点的「异常处理」设置决定；结构性错误一律停止。</Note>
        )}
        <button type="button" className="df-btn-danger" onClick={onDelete}>
          删除节点
        </button>
      </div>
    </aside>
  );
}
