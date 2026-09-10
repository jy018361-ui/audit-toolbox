import { useEffect, useMemo, useState } from "react";
import "./AudiPickLegacyTemplates.css";

export type AudiPickLegacyTemplateTab =
  | "all"
  | "contract"
  | "voucher"
  | "report"
  | "custom";

export type AudiPickLegacyTemplateField = {
  key: string;
  label: string;
};

export type AudiPickLegacyTemplateExample = {
  category?: string;
  quote?: string;
  hint?: string;
};

/** Presentation model mapped from RuleEngine by AudiPickPage. */
export type AudiPickLegacyTemplateRule = {
  id: string;
  name: string;
  shortName?: string;
  description?: string;
  version?: string;
  category?: string;
  docKind?: "contract" | "table" | string;
  readonly?: boolean;
  isCustom?: boolean;
  baseRuleId?: string;
  useCase?: string;
  prompt?: string;
  fields: AudiPickLegacyTemplateField[];
  example?: AudiPickLegacyTemplateExample | null;
};

export type AudiPickLegacyTemplateActions = {
  onCreateRule: (input: {
    name: string;
    docKind: "contract" | "table";
  }) => void | Promise<void>;
  onCopyRule: (input: {
    sourceRuleId: string;
    name: string;
  }) => void | Promise<void>;
  onSavePrompt: (ruleId: string, prompt: string) => void | Promise<void>;
  onDeleteRule: (ruleId: string) => void | Promise<void>;
  onSelectRule?: (ruleId: string) => void;
  onTabChange?: (tab: AudiPickLegacyTemplateTab) => void;
  onSearchChange?: (search: string) => void;
  onEditRule?: (ruleId: string | null) => void;
};

export type AudiPickLegacyTemplatesProps = {
  rules: AudiPickLegacyTemplateRule[];
  selectedRuleId?: string;
  activeTab?: AudiPickLegacyTemplateTab;
  search?: string;
  editingRuleId?: string | null;
  busy?: boolean;
  message?: string;
  actions: AudiPickLegacyTemplateActions;
};

const TABS: Array<{ id: AudiPickLegacyTemplateTab; label: string }> = [
  { id: "all", label: "全部" },
  { id: "contract", label: "合同协议" },
  { id: "voucher", label: "单据票证" },
  { id: "report", label: "报告" },
  { id: "custom", label: "我的模板" },
];

function isCustomRule(rule: AudiPickLegacyTemplateRule) {
  return rule.isCustom ?? rule.readonly === false;
}

function kindLabel(rule: AudiPickLegacyTemplateRule) {
  return rule.docKind === "table" ? "表格型" : "条款型";
}

function belongsToTab(
  rule: AudiPickLegacyTemplateRule,
  tab: AudiPickLegacyTemplateTab,
) {
  if (tab === "custom") return isCustomRule(rule);
  if (isCustomRule(rule)) return false;
  if (tab === "all") return true;
  if (tab === "contract") {
    return ["loan", "revenue", "procurement", "agreement"].includes(
      rule.category ?? "",
    );
  }
  return rule.category === tab;
}

function fallbackExample(rule: AudiPickLegacyTemplateRule) {
  return rule.docKind === "table"
    ? {
        category: "明细行",
        quote: "（按表格逐行提取日期、金额等字段）",
        hint: "核对合计数与源文件一致",
      }
    : {
        category: "关键条款",
        quote: "（摘录与审计目标相关的原文段落）",
        hint: "结合底稿目标判断是否影响认定",
      };
}

function Modal({
  title,
  detail,
  children,
  onClose,
}: {
  title: string;
  detail: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="alt-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="alt-modal" role="dialog" aria-modal="true" aria-labelledby="alt-modal-title">
        <h3 id="alt-modal-title">{title}</h3>
        <p>{detail}</p>
        {children}
      </section>
    </div>
  );
}

export function AudiPickLegacyTemplates({
  rules,
  selectedRuleId,
  activeTab,
  search,
  editingRuleId,
  busy = false,
  message,
  actions,
}: AudiPickLegacyTemplatesProps) {
  const [localTab, setLocalTab] = useState<AudiPickLegacyTemplateTab>(activeTab ?? "all");
  const [localSearch, setLocalSearch] = useState(search ?? "");
  const [localSelectedId, setLocalSelectedId] = useState(selectedRuleId ?? "");
  const [localEditingId, setLocalEditingId] = useState<string | null>(editingRuleId ?? null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createKind, setCreateKind] = useState<"contract" | "table">("contract");
  const [copySource, setCopySource] = useState<AudiPickLegacyTemplateRule | null>(null);
  const [copyName, setCopyName] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [localError, setLocalError] = useState("");

  const tab = activeTab ?? localTab;
  const searchText = search ?? localSearch;
  const selectedId = selectedRuleId ?? localSelectedId;
  const editId = editingRuleId === undefined ? localEditingId : editingRuleId;

  const filteredRules = useMemo(() => {
    const query = searchText.trim().toLocaleLowerCase("zh-CN");
    return rules.filter((rule) => {
      if (!belongsToTab(rule, tab)) return false;
      if (!query) return true;
      return [rule.name, rule.shortName, rule.description, rule.id]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(query);
    });
  }, [rules, searchText, tab]);

  const visibleSelectedId = filteredRules.some((rule) => rule.id === selectedId)
    ? selectedId
    : filteredRules[0]?.id ?? "";
  const selectedRule = rules.find((rule) => rule.id === visibleSelectedId);

  useEffect(() => {
    if (visibleSelectedId && visibleSelectedId !== selectedId) {
      if (selectedRuleId === undefined) setLocalSelectedId(visibleSelectedId);
      actions.onSelectRule?.(visibleSelectedId);
    }
  }, [actions, selectedId, selectedRuleId, visibleSelectedId]);

  useEffect(() => {
    if (selectedRule && editId === selectedRule.id) {
      setPromptDraft(selectedRule.prompt ?? "");
    }
  }, [editId, selectedRule]);

  const setTab = (next: AudiPickLegacyTemplateTab) => {
    if (activeTab === undefined) setLocalTab(next);
    if (editingRuleId === undefined) setLocalEditingId(null);
    actions.onEditRule?.(null);
    actions.onTabChange?.(next);
  };

  const setSearchText = (next: string) => {
    if (search === undefined) setLocalSearch(next);
    actions.onSearchChange?.(next);
  };

  const selectRule = (ruleId: string) => {
    if (selectedRuleId === undefined) setLocalSelectedId(ruleId);
    if (editingRuleId === undefined) setLocalEditingId(null);
    actions.onEditRule?.(null);
    actions.onSelectRule?.(ruleId);
  };

  const startEdit = (rule: AudiPickLegacyTemplateRule) => {
    setPromptDraft(rule.prompt ?? "");
    setLocalError("");
    if (editingRuleId === undefined) setLocalEditingId(rule.id);
    actions.onEditRule?.(rule.id);
  };

  const cancelEdit = () => {
    setLocalError("");
    if (editingRuleId === undefined) setLocalEditingId(null);
    actions.onEditRule?.(null);
  };

  const savePrompt = () => {
    const prompt = promptDraft.trim();
    if (!prompt) {
      setLocalError("提示词不能为空");
      return;
    }
    if (!prompt.includes("【字段定义】")) {
      setLocalError("提示词须包含【字段定义】区块");
      return;
    }
    setLocalError("");
    void Promise.resolve(actions.onSavePrompt(visibleSelectedId, prompt)).then(() => cancelEdit());
  };

  const createRule = () => {
    const name = createName.trim();
    if (!name) {
      setLocalError("请输入模板名称");
      return;
    }
    setLocalError("");
    void Promise.resolve(actions.onCreateRule({ name, docKind: createKind })).then(() => {
      setCreateOpen(false);
      setCreateName("");
      setCreateKind("contract");
    });
  };

  const copyRule = () => {
    const name = copyName.trim();
    if (!copySource || !name) {
      setLocalError("请输入模板名称");
      return;
    }
    setLocalError("");
    void Promise.resolve(actions.onCopyRule({ sourceRuleId: copySource.id, name })).then(() => {
      setCopySource(null);
      setCopyName("");
    });
  };

  const baseRule = selectedRule?.baseRuleId
    ? rules.find((rule) => rule.id === selectedRule.baseRuleId)
    : undefined;
  const presentation = selectedRule
    ? {
        useCase: selectedRule.useCase || selectedRule.description || baseRule?.useCase || baseRule?.description || "",
        example: selectedRule.example || baseRule?.example || fallbackExample(selectedRule),
      }
    : null;

  return (
    <div className="ap-legacy-templates">
      <header className="alt-page-header">
        <div>
          <h1>提取模板库</h1>
          <p>选择一个模板，系统会按预设字段从合同、单据或报告中提取关键信息。你也可以基于内置模板创建自己的模板。</p>
        </div>
        <button type="button" className="alt-button alt-button-primary" disabled={busy} onClick={() => {
          setLocalError("");
          setCreateOpen(true);
        }}>新增模板</button>
      </header>

      <section className="alt-filters">
        <div className="alt-tabs" role="tablist" aria-label="模板分类">
          {TABS.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`alt-tab${tab === item.id ? " is-active" : ""}`}
              key={item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="搜索模板，例如：借款合同、发票、征信报告"
          aria-label="搜索模板"
        />
      </section>

      <div className="alt-template-workspace">
        <aside className="alt-template-list">
          {tab === "custom" && rules.filter(isCustomRule).length === 0 ? (
            <div className="alt-empty-card">
              <strong>还没有我的模板</strong>
              <p>可以从空白骨架新增，也可以在内置模板上点击「复制并编辑」创建</p>
              <button type="button" className="alt-button alt-button-primary" disabled={busy} onClick={() => setCreateOpen(true)}>新增模板</button>
            </div>
          ) : filteredRules.length === 0 ? (
            <div className="alt-empty-card">未找到匹配的模板，请换个关键词或切换分类</div>
          ) : (
            <>
              <p className="alt-list-note">共 {filteredRules.length} 个模板 · 点击卡片查看右侧详情</p>
              <p className="alt-list-hint">不确定选哪个？可以先上传文件，系统会自动推荐模板。</p>
              {filteredRules.map((rule) => {
                const selected = rule.id === visibleSelectedId;
                return (
                  <button
                    type="button"
                    className={`alt-template-card${selected ? " is-selected" : ""}`}
                    key={rule.id}
                    onClick={() => selectRule(rule.id)}
                  >
                    <span className="alt-card-heading">
                      <strong>{rule.name}</strong>
                      <span className={`alt-kind${rule.docKind === "table" ? " is-table" : ""}`}>{kindLabel(rule)}</span>
                    </span>
                    <span className="alt-card-description">{rule.description || ""}</span>
                    {selected && <span className="alt-card-selected">已选中 · 详情见右侧</span>}
                  </button>
                );
              })}
            </>
          )}
        </aside>

        <main className="alt-detail-column">
          {!selectedRule || !presentation ? (
            <div className="alt-empty-card alt-detail-empty">
              <strong>请从左侧选择一个模板</strong>
              <p>点击模板卡片后，此处显示字段与说明</p>
            </div>
          ) : (
            <article className="alt-detail-card">
              <header className="alt-detail-header">
                <div>
                  <span>模板详情</span>
                  <h2>{selectedRule.name}</h2>
                  <p>版本 {selectedRule.version || "1.0"} · {kindLabel(selectedRule)} · {isCustomRule(selectedRule) ? "我的模板" : "内置模板"}</p>
                </div>
                <div className="alt-detail-actions">
                  {!isCustomRule(selectedRule) && selectedRule.readonly !== false && (
                    <button type="button" className="alt-button alt-button-primary" disabled={busy} onClick={() => {
                      setLocalError("");
                      setCopySource(selectedRule);
                      setCopyName(`${selectedRule.name}（我的模板）`);
                    }}>复制并编辑</button>
                  )}
                  {isCustomRule(selectedRule) && editId !== selectedRule.id && (
                    <button type="button" className="alt-button alt-button-primary" disabled={busy} onClick={() => startEdit(selectedRule)}>编辑</button>
                  )}
                  {isCustomRule(selectedRule) && (
                    <button
                      type="button"
                      className="alt-button alt-button-secondary is-danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm("确认删除该模板？已有提取结果不会自动删除。")) {
                          void actions.onDeleteRule(selectedRule.id);
                        }
                      }}
                    >删除</button>
                  )}
                </div>
              </header>

              <section className="alt-detail-section">
                <h3>适用场景</h3>
                <p>{presentation.useCase}</p>
              </section>

              <section className="alt-detail-section">
                <h3>可提取内容</h3>
                {selectedRule.fields.length > 0 ? (
                  <ul>{selectedRule.fields.map((field) => <li key={field.key}>{field.label || field.key}</li>)}</ul>
                ) : (
                  <p className="alt-faint">暂无字段定义</p>
                )}
              </section>

              <section className="alt-example-card">
                <span>示例结果</span>
                <p><em>条款类别：</em>{presentation.example.category || ""}</p>
                <p><em>原文摘录：</em>{presentation.example.quote || ""}</p>
                <p className="is-hint"><em>审计提示：</em>{presentation.example.hint || ""}</p>
              </section>

              {isCustomRule(selectedRule) && editId === selectedRule.id ? (
                <section className="alt-detail-section">
                  <h3>编辑提示词</h3>
                  <textarea
                    className="alt-prompt-editor"
                    value={promptDraft}
                    disabled={busy}
                    onChange={(event) => setPromptDraft(event.target.value)}
                  />
                  <div className="alt-detail-actions">
                    <button type="button" className="alt-button alt-button-primary" disabled={busy} onClick={savePrompt}>保存</button>
                    <button type="button" className="alt-button alt-button-secondary" disabled={busy} onClick={cancelEdit}>取消</button>
                  </div>
                  {localError && <div className="alt-inline-error">{localError}</div>}
                </section>
              ) : selectedRule.prompt ? (
                <details className="alt-advanced">
                  <summary>高级规则 / Prompt 与 JSON 结构</summary>
                  <pre>{selectedRule.prompt}</pre>
                  {!isCustomRule(selectedRule) && selectedRule.readonly !== false && (
                    <p>需要修改？请使用「复制并编辑」创建我的模板。</p>
                  )}
                </details>
              ) : null}

              {message && <div className="alt-inline-message">{message}</div>}
            </article>
          )}
        </main>
      </div>

      {createOpen && (
        <Modal title="新增模板" detail="从带基础字段结构的空白提示词开始创建，保存后可继续编辑。" onClose={() => setCreateOpen(false)}>
          <label className="alt-field">
            <span>模板名称</span>
            <input value={createName} autoFocus autoComplete="off" placeholder="例如：租赁合同审计模板" onChange={(event) => setCreateName(event.target.value)} />
          </label>
          <label className="alt-field">
            <span>文档类型</span>
            <select value={createKind} onChange={(event) => setCreateKind(event.target.value as "contract" | "table")}>
              <option value="contract">条款型：合同、协议、报告段落</option>
              <option value="table">表格型：发票、流水、明细清单</option>
            </select>
          </label>
          {localError && <div className="alt-inline-error">{localError}</div>}
          <div className="alt-modal-actions">
            <button type="button" className="alt-button alt-button-secondary" disabled={busy} onClick={() => setCreateOpen(false)}>取消</button>
            <button type="button" className="alt-button alt-button-primary" disabled={busy} onClick={createRule}>创建并编辑</button>
          </div>
        </Modal>
      )}

      {copySource && (
        <Modal title="复制并编辑" detail="基于此模板创建我的模板，之后可修改提示词与字段。" onClose={() => setCopySource(null)}>
          <label className="alt-field">
            <span>模板名称</span>
            <input value={copyName} autoFocus autoComplete="off" onChange={(event) => setCopyName(event.target.value)} />
          </label>
          {localError && <div className="alt-inline-error">{localError}</div>}
          <div className="alt-modal-actions">
            <button type="button" className="alt-button alt-button-secondary" disabled={busy} onClick={() => setCopySource(null)}>取消</button>
            <button type="button" className="alt-button alt-button-primary" disabled={busy} onClick={copyRule}>创建</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
