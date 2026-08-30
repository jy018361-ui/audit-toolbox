import { DataTable } from "@/components/DataTable";

/**
 * 五个工具共用的字段映射面板。
 *
 * 此前汇兑损益、存款利息、借款利息、看账各写了一套，同一个交互修四遍。
 * 差异全部降级为参数：**角色清单**（按 TB / JE 传各自的）、**分组标题**、
 * **可多列的角色**、**被方案互斥锁定的角色**。
 *
 * 映射统一是「角色名 → 列名或列名数组」的字典——五个工具的映射结构与角色名
 * 已经统一到内核，这里不需要再为谁做适配。
 */
export type MappingDict = Record<string, string | string[] | undefined>;

export type MappingPanelProps = {
  /** 面板标题，如「序时账文件预览」。 */
  title: string;
  headers: string[];
  rows: string[][];
  mapping: MappingDict;
  /** 角色清单：`[角色名, 中文标签]`，顺序即下拉里的顺序。 */
  roles: [string, string][];
  /** 可选的分组标题。给了就按组渲染 `<optgroup>`，没给就平铺。 */
  groups?: { title: string; roles: string[] }[];
  /** 可以一个角色对应多列的角色（凭证识别字段、科目名称、辅助核算）。 */
  multi?: Set<string>;
  /** 被金额方案互斥锁定的角色——显示为「已停用」且不可选。 */
  isLocked?: (role: string) => boolean;
  /** 天然可以与别的角色共用一列的角色（币种线索文本写在科目名称里）。 */
  shareable?: Set<string>;
  /** 尚未映射的必填项，直接展示给用户。 */
  missing?: string[];
  /**
   * 表格上方的附加提示区：复核状态、大文件抽样警告、需要用户确认的选项等。
   *
   * 这些内容原先各自占一张卡片，与紧挨着的预览表分成两块，界面很碎。
   * 收进面板里跟着同一份数据走，用户不必在两张卡片之间来回对照。
   */
  banner?: React.ReactNode;
  /**
   * 某个角色在**当前命中的形态**下是必填还是选填。
   *
   * 借款台账的必填项随命中的型号变（类型1 要到期日、类型2 要期限、
   * 类型3／5 要期间发生额），不是一张固定清单，所以由调用方按型号回答，
   * 下拉里逐项标注。返回 `undefined` 表示与形态无关，不标注。
   */
  requirementOf?: (role: string) => "required" | "optional" | undefined;
  /** 形态判定结论，如「已识别为 A 型（起始日＋到期日）」。 */
  formNote?: React.ReactNode;
  /** 数据列之后追加的、由调用方逐行渲染控件的列（如逐行利率口径）。 */
  trailingColumns?: { key: string; title: React.ReactNode; render: (rowIndex: number) => React.ReactNode }[];
  onChange: (next: MappingDict) => void;
  /** 表头下拉右侧的附加控件，如列筛选漏斗。 */
  headerExtras?: (header: string) => React.ReactNode;
  /** 面板右上角的工具条，如 Sheet 选择、标题行、LLM 复核按钮。 */
  toolbar?: React.ReactNode;
  /** 行数与列数之外要补充的说明。 */
  note?: React.ReactNode;
  /**
   * 一列一个角色（`replace`，默认），还是点一下切换、允许一列叠加多个角色（`toggle`）。
   *
   * 汇兑损益要 `toggle`：账户币种常常就写在科目名称里（`银行存款-中行朝阳支行美元户`），
   * 那一列既是科目名称也是币种线索文本，强行按「一列一角色」会丢掉这个能力。
   */
  mode?: "replace" | "toggle";
  /** `toggle` 模式下这一列当前承担的全部角色。 */
  rolesOf?: (header: string) => string[];
  /** `toggle` 模式下点击某个角色时的切换动作。 */
  onToggle?: (header: string, role: string) => void;
  busy?: boolean;
  maxHeight?: number;
};

const asColumns = (value: string | string[] | undefined): string[] =>
  Array.isArray(value) ? value.filter(Boolean) : value?.trim() ? [value.trim()] : [];

export function MappingPanel(props: MappingPanelProps) {
  const { headers, rows, mapping, roles, multi, shareable, busy } = props;
  const isMulti = (role: string) => Boolean(multi?.has(role));
  const locked = (role: string) => Boolean(props.isLocked?.(role));

  // 某一列当前落在哪个角色上。可共用一列的角色不参与判定——否则币种线索
  // 文本会把科目名称的标记抢走，用户看到的下拉就跟实际映射对不上。
  const roleOf = (column: string) =>
    roles.find(([role]) => !shareable?.has(role) && asColumns(mapping[role]).includes(column))?.[0] ?? "";

  const used = new Set(roles.filter(([role]) => asColumns(mapping[role]).length > 0).map(([role]) => role));

  const update = (column: string, role: string) => {
    const next: MappingDict = { ...mapping };
    // 先把这一列从原来的角色上摘下来，再挂到新角色上。
    for (const [key] of roles) {
      const columns = asColumns(next[key]);
      if (!columns.includes(column)) continue;
      const rest = columns.filter((item) => item !== column);
      next[key] = isMulti(key) ? rest : rest[0];
    }
    if (role) {
      next[role] = isMulti(role) ? [...asColumns(next[role]), column] : column;
    }
    props.onChange(next);
  };

  // 必填／选填的标注跟在标签后面。下拉的 <option> 没法上样式，只能用文字标。
  const mark = (role: string) => {
    const need = props.requirementOf?.(role);
    return need === "required" ? "＊" : need === "optional" ? "（选填）" : "";
  };

  const option = (role: string, label: string, current: string) => {
    const taken = used.has(role) && role !== current && !isMulti(role);
    const disabled = locked(role);
    const suffix = taken ? "（已用）" : disabled ? "（已停用）" : "";
    return (
      <option key={role} value={role} className={taken || disabled ? "dt-role-taken" : undefined}>
        {label}
        {mark(role)}
        {suffix}
      </option>
    );
  };

  const toggleMode = props.mode === "toggle";
  const labelOf = new Map(roles);

  // toggle 模式：合起来时显示这一列已承担的全部语义，展开后逐项勾选。
  const toggleOption = (role: string, label: string, held: string[]) => {
    const chosen = held.includes(role);
    const taken = used.has(role) && !chosen && !isMulti(role);
    const disabled = locked(role);
    return (
      <option key={role} value={role} className={taken || disabled ? "dt-role-taken" : undefined}>
        {chosen ? `✓ ${label}` : label}
        {mark(role)}
        {chosen ? "（再点取消）" : taken ? "（已用）" : disabled ? "（与已选记法冲突）" : ""}
      </option>
    );
  };

  const controls = headers.map((header) => {
    const column = header.trim();
    const held = toggleMode ? (props.rolesOf?.(header) ?? []) : [];
    const current = toggleMode ? "" : roleOf(column);
    const byRole = labelOf;
    const summary = held.length
      ? held.map((role) => labelOf.get(role) ?? role).join(" ＋ ")
      : "— 选择字段";
    const renderOption = toggleMode
      ? (role: string, label: string) => toggleOption(role, label, held)
      : (role: string, label: string) => option(role, label, current);
    return (
      <label className="dt-header-control" key={header}>
        <select
          className={toggleMode ? (held.length ? "mapped" : undefined) : current && !locked(current) ? "mapped" : undefined}
          disabled={busy || (!toggleMode && Boolean(current) && locked(current))}
          value={toggleMode ? "" : current}
          title={toggleMode && held.length ? summary : undefined}
          onChange={(e) => {
            const role = e.target.value;
            if (toggleMode) {
              if (role) props.onToggle?.(header, role);
              e.currentTarget.value = "";
            } else update(column, role);
          }}
        >
          <option value="">{toggleMode ? summary : "—"}</option>
          {props.groups
            ? props.groups.map((group) => (
                <optgroup key={group.title} label={group.title}>
                  {group.roles
                    .filter((role) => byRole.has(role))
                    .map((role) => renderOption(role, byRole.get(role) ?? role))}
                </optgroup>
              ))
            : roles.map(([role, label]) => renderOption(role, label))}
        </select>
        {props.headerExtras?.(header)}
      </label>
    );
  });

  return (
    <section className="kz-card kz-preview">
      <div className="loan-map-head">
        <div>
          <h2>{props.title}</h2>
          <p>
            {rows.length ? `${rows.length} 行预览 · ` : ""}
            {headers.length} 列
            {props.note ? <> · {props.note}</> : null}
          </p>
        </div>
        {props.toolbar ? <div className="mapping-panel-toolbar">{props.toolbar}</div> : null}
      </div>
      {props.formNote ? <p className="mapping-form-note">{props.formNote}</p> : null}
      {props.requirementOf ? (
        <p className="mapping-requirement-legend">
          ＊ 当前识别形态必填；（选填）为可补充字段；未标记字段不属于当前形态要求。
        </p>
      ) : null}
      {props.missing && props.missing.length > 0 && (
        <p className="fa-missing-hint">尚未映射：{props.missing.join("、")}</p>
      )}
      {props.banner}
      <DataTable
        columns={headers}
        rows={rows}
        headerControls={controls}
        trailingColumns={props.trailingColumns}
        maxHeight={props.maxHeight ?? 380}
      />
    </section>
  );
}
