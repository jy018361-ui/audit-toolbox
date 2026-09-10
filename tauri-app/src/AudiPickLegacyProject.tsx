import { useMemo, useState, type DragEvent } from "react";
import "./AudiPickLegacyProject.css";

export type AudiPickLegacyRuleOption = {
  id: string;
  name: string;
};

export type AudiPickLegacyRelationMember = {
  fileId: string;
  role: string;
  source?: "ai" | "ai-confirmed" | "manual" | string;
  confidence?: string;
  reason?: string;
};

export type AudiPickLegacyRelationGroup = {
  id: string;
  anchorFileId: string;
  members: AudiPickLegacyRelationMember[];
};

export type AudiPickLegacyAssociationSuggestion = {
  fileId: string;
  anchorFileId: string;
  anchorName: string;
  role: string;
  reason: string;
  confidence?: "high" | "medium" | "low" | string;
};

/**
 * This is deliberately a presentation model rather than the persisted
 * AudiPick document. The Tauri page remains responsible for translating its
 * Rust/SQLite records into these fields, so this component never recreates the
 * portable build's localStorage data layer.
 */
export type AudiPickLegacyProjectDocument = {
  id: string;
  name: string;
  textLength?: number;
  isScanned?: boolean;
  status?: string;
  resultCount?: number;
  appliedRuleCount?: number;
  ruleId?: string;
  ruleConfirmed?: boolean;
  detectedRuleId?: string;
  detectedConfidence?: "high" | "medium" | "low" | string;
  detectedLabel?: string;
  associationRole?: string | null;
  associationNeedsRefresh?: boolean;
  revenueNeedsRefresh?: boolean;
};

export type AudiPickLegacyProjectModel = {
  id: string;
  name: string;
  client?: string;
  date?: string;
  defaultRuleName?: string;
};

export type AudiPickLegacyOcrTask = {
  id: string;
  fileName?: string;
  completedPages: number;
  totalPages?: number;
  remainingCount?: number;
};

export type AudiPickLegacyProjectActions = {
  onBack: () => void;
  onBatchExtract: (documentIds: string[]) => void | Promise<void>;
  onOpenLoanAudit?: () => void;
  onExportProject: () => void | Promise<void>;
  onPickPdfs: () => void | Promise<void>;
  onPickFolder: () => void | Promise<void>;
  onDropFiles?: (files: File[]) => void | Promise<void>;
  onOpenDocument: (documentId: string) => void | Promise<void>;
  onDeleteDocument: (documentId: string) => void | Promise<void>;
  onRuleChange: (documentId: string, ruleId: string) => void | Promise<void>;
  onConfirmRule: (documentId: string, ruleId: string) => void | Promise<void>;
  onExtractDocument: (documentId: string) => void | Promise<void>;
  onViewWorkpaper: (documentId: string, ruleId?: string) => void | Promise<void>;
  onManageAssociation?: (documentId: string) => void | Promise<void>;
  onToggleAssociation?: (anchorId: string, expanded: boolean) => void;
  onRemoveAssociation: (anchorId: string, fileId: string) => void | Promise<void>;
  onConfirmAssociation: (
    fileId: string,
    anchorId: string,
    suggestion: AudiPickLegacyAssociationSuggestion,
  ) => void | Promise<void>;
  onDismissAssociation?: (
    fileId: string,
    anchorId: string,
  ) => void | Promise<void>;
  onResumeOcr?: (taskId: string) => void | Promise<void>;
  onDiscardOcr?: (taskId: string) => void | Promise<void>;
};

export type AudiPickLegacyProjectProps = {
  project: AudiPickLegacyProjectModel;
  documents: AudiPickLegacyProjectDocument[];
  rules: AudiPickLegacyRuleOption[];
  relationGroups?: AudiPickLegacyRelationGroup[];
  associationSuggestions?: AudiPickLegacyAssociationSuggestion[];
  selectedDocumentIds?: string[];
  ocrLabel?: string;
  ocrTask?: AudiPickLegacyOcrTask | null;
  busy?: boolean;
  uploadStatus?: string;
  showLoanAudit?: boolean;
  actions: AudiPickLegacyProjectActions;
  onSelectionChange?: (documentIds: string[]) => void;
};

function Chevron({ down = false }: { down?: boolean }) {
  return (
    <svg
      className={`alp-chevron${down ? " is-down" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="m9 5 7 7-7 7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg className="alp-upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path
        d="M7 16a4 4 0 0 1-.88-7.9A5 5 0 0 1 15.9 6H16a5 5 0 0 1 1 9.9M15 13l-3-3m0 0-3 3m3-3v12"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function confidenceText(value?: string) {
  if (value === "high") return "高";
  if (value === "medium") return "中";
  return "低";
}

function resolvedRuleId(
  document: AudiPickLegacyProjectDocument,
  rules: AudiPickLegacyRuleOption[],
) {
  return document.ruleId ?? document.detectedRuleId ?? rules[0]?.id ?? "";
}

function LegacyDocumentMeta({
  document,
  rules,
  grouped,
  hideAssociation,
  disabled,
  actions,
}: {
  document: AudiPickLegacyProjectDocument;
  rules: AudiPickLegacyRuleOption[];
  grouped?: boolean;
  hideAssociation?: boolean;
  disabled?: boolean;
  actions: AudiPickLegacyProjectActions;
}) {
  const textLength = document.textLength ?? 0;
  const resultCount = document.resultCount ?? 0;
  const appliedRuleCount = document.appliedRuleCount ?? (resultCount > 0 ? 1 : 0);
  const ruleId = resolvedRuleId(document, rules);

  return (
    <div className="alp-file-meta">
      <div className="alp-file-badges">
        {document.isScanned ? (
          resultCount > 0 ? (
            <span className="alp-badge is-success">已提取{resultCount}条/{appliedRuleCount}模板</span>
          ) : (
            <span className="alp-badge is-purple">扫描件({textLength}字)</span>
          )
        ) : textLength > 0 ? (
          <span className="alp-badge is-blue">
            {textLength}字{resultCount > 0 ? ` | 已提${resultCount}条` : ""}
          </span>
        ) : (
          <span className="alp-badge is-neutral">处理中</span>
        )}
        {(document.detectedRuleId || document.detectedLabel) && (
          <span className={`alp-ai-label confidence-${document.detectedConfidence ?? "low"}`}>
            AI:{document.detectedLabel ?? rules.find((rule) => rule.id === ruleId)?.name ?? "未识别"}
            ({confidenceText(document.detectedConfidence)})·{document.ruleConfirmed ? "已确认" : "待确认"}
          </span>
        )}
        {(document.associationNeedsRefresh || document.revenueNeedsRefresh) && (
          <span className="alp-stale-label">关联资料已更新，需重新提取</span>
        )}
      </div>
      <div className="alp-file-controls" onClick={(event) => event.stopPropagation()}>
        <span className="alp-control-label">模板</span>
        <select
          aria-label={`${document.name}的提取模板`}
          value={ruleId}
          disabled={disabled || rules.length === 0}
          onChange={(event) => void actions.onRuleChange(document.id, event.target.value)}
        >
          {rules.map((rule) => (
            <option value={rule.id} key={rule.id}>{rule.name}</option>
          ))}
        </select>
        {document.ruleConfirmed ? (
          <span className="alp-rule-confirmed">✓ 模板已确认</span>
        ) : (
          <button
            type="button"
            className="alp-button alp-button-outline alp-button-tiny"
            disabled={disabled || !ruleId}
            onClick={() => void actions.onConfirmRule(document.id, ruleId)}
          >
            确认模板
          </button>
        )}
        {textLength > 0 && (
          <button
            type="button"
            className={`alp-link-button${resultCount > 0 ? "" : " is-accent"}`}
            disabled={disabled}
            onClick={() => void actions.onExtractDocument(document.id)}
          >
            {resultCount > 0 ? "重新提取" : "开始提取"}
          </button>
        )}
        {resultCount > 0 && (
          <button
            type="button"
            className="alp-link-button"
            disabled={disabled}
            onClick={() => void actions.onViewWorkpaper(document.id, ruleId)}
          >
            查看底稿
          </button>
        )}
        {!hideAssociation && actions.onManageAssociation && (
          <button
            type="button"
            className="alp-link-button"
            disabled={disabled}
            onClick={() => void actions.onManageAssociation?.(document.id)}
          >
            {grouped ? "管理资料" : "关联资料"}
          </button>
        )}
      </div>
    </div>
  );
}

function DocumentCheckbox({
  document,
  selected,
  disabled,
  onChange,
}: {
  document: AudiPickLegacyProjectDocument;
  selected: boolean;
  disabled?: boolean;
  onChange: (selected: boolean) => void;
}) {
  const canExtract = (document.textLength ?? 0) > 0 && (document.resultCount ?? 0) === 0;
  return (
    <input
      className="alp-checkbox"
      type="checkbox"
      aria-label={`选择${document.name}`}
      checked={canExtract && selected}
      disabled={disabled || !canExtract}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function DocumentCard({
  document,
  members,
  documentMap,
  rules,
  selectedIds,
  expanded,
  disabled,
  actions,
  onSelected,
  onExpanded,
}: {
  document: AudiPickLegacyProjectDocument;
  members: AudiPickLegacyRelationMember[];
  documentMap: Map<string, AudiPickLegacyProjectDocument>;
  rules: AudiPickLegacyRuleOption[];
  selectedIds: Set<string>;
  expanded: boolean;
  disabled?: boolean;
  actions: AudiPickLegacyProjectActions;
  onSelected: (documentId: string, selected: boolean) => void;
  onExpanded: (anchorId: string, expanded: boolean) => void;
}) {
  return (
    <article className="alp-file-card">
      <div className="alp-file-row">
        <div className="alp-checkbox-slot">
          <DocumentCheckbox
            document={document}
            selected={selectedIds.has(document.id)}
            disabled={disabled}
            onChange={(selected) => onSelected(document.id, selected)}
          />
        </div>
        <div className="alp-file-content">
          <div className="alp-file-heading">
            <button
              type="button"
              className="alp-file-name"
              disabled={disabled}
              onClick={() => void actions.onOpenDocument(document.id)}
            >
              {document.name}
            </button>
            <div className="alp-file-heading-actions">
              {members.length > 0 && (
                <button
                  type="button"
                  className="alp-group-toggle"
                  disabled={disabled}
                  aria-expanded={expanded}
                  onClick={() => onExpanded(document.id, !expanded)}
                >
                  已关联 {members.length} 份 <Chevron down={expanded} />
                </button>
              )}
              <button
                type="button"
                className="alp-chevron-button"
                aria-label={`打开${document.name}`}
                disabled={disabled}
                onClick={() => void actions.onOpenDocument(document.id)}
              >
                <Chevron />
              </button>
            </div>
          </div>
          <LegacyDocumentMeta
            document={document}
            rules={rules}
            grouped={members.length > 0}
            disabled={disabled}
            actions={actions}
          />
        </div>
        <button
          type="button"
          className="alp-delete-button"
          disabled={disabled}
          onClick={() => void actions.onDeleteDocument(document.id)}
        >
          删除
        </button>
      </div>
      {members.length > 0 && expanded && (
        <div className="alp-association-children">
          {members.map((member) => {
            const child = documentMap.get(member.fileId);
            if (!child) return null;
            return (
              <div className="alp-child-row" key={member.fileId}>
                <div className="alp-child-prefix">
                  <span>└</span>
                  <DocumentCheckbox
                    document={child}
                    selected={selectedIds.has(child.id)}
                    disabled={disabled}
                    onChange={(selected) => onSelected(child.id, selected)}
                  />
                </div>
                <div className="alp-file-content">
                  <div className="alp-file-heading">
                    <button
                      type="button"
                      className="alp-child-name"
                      disabled={disabled}
                      onClick={() => void actions.onOpenDocument(child.id)}
                    >
                      <span className="alp-role-badge">{member.role || "关联资料"}</span>
                      <span className="alp-truncate" title={child.name}>{child.name}</span>
                      {member.source === "ai" && <span className="alp-source-badge is-ai" title={member.reason}>AI自动关联</span>}
                      {member.source === "ai-confirmed" && <span className="alp-source-badge">AI建议已确认</span>}
                    </button>
                    <Chevron />
                  </div>
                  <LegacyDocumentMeta
                    document={child}
                    rules={rules}
                    hideAssociation
                    disabled={disabled}
                    actions={actions}
                  />
                </div>
                <div className="alp-child-actions">
                  <button
                    type="button"
                    className="alp-link-button"
                    disabled={disabled}
                    title="解除后文件回到待归属资料"
                    onClick={() => void actions.onRemoveAssociation(document.id, child.id)}
                  >
                    解除关联
                  </button>
                  <button
                    type="button"
                    className="alp-delete-button"
                    disabled={disabled}
                    onClick={() => void actions.onDeleteDocument(child.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

export function AudiPickLegacyProject({
  project,
  documents,
  rules,
  relationGroups = [],
  associationSuggestions = [],
  selectedDocumentIds = [],
  ocrLabel = "AI视觉",
  ocrTask,
  busy = false,
  uploadStatus,
  showLoanAudit = false,
  actions,
  onSelectionChange,
}: AudiPickLegacyProjectProps) {
  const [localSelection, setLocalSelection] = useState<string[]>(selectedDocumentIds);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);

  const selection = onSelectionChange ? selectedDocumentIds : localSelection;
  const selectedIds = useMemo(() => new Set(selection), [selection]);
  const documentMap = useMemo(
    () => new Map(documents.map((document) => [document.id, document])),
    [documents],
  );
  const groupMap = useMemo(
    () => new Map(relationGroups.map((group) => [group.anchorFileId, group])),
    [relationGroups],
  );
  const memberIds = useMemo(
    () => new Set(relationGroups.flatMap((group) => group.members.map((member) => member.fileId))),
    [relationGroups],
  );
  const suggestionMap = useMemo(
    () => new Map(associationSuggestions.map((suggestion) => [suggestion.fileId, suggestion])),
    [associationSuggestions],
  );
  const rootDocuments = documents.filter((document) => !memberIds.has(document.id));
  const contractGroups = rootDocuments.filter(
    (document) => !document.associationRole || groupMap.has(document.id),
  );
  const suggestedDocuments = rootDocuments.filter((document) => suggestionMap.has(document.id));
  const unassignedDocuments = rootDocuments.filter(
    (document) => Boolean(document.associationRole) && !suggestionMap.has(document.id) && !groupMap.has(document.id),
  );
  const extractableIds = documents
    .filter((document) => (document.textLength ?? 0) > 0 && (document.resultCount ?? 0) === 0)
    .map((document) => document.id);
  const pendingCount = extractableIds.length;
  const confirmedCount = documents.filter((document) => document.ruleConfirmed).length;
  const extractedCount = documents.filter((document) => (document.resultCount ?? 0) > 0).length;
  const hasResults = extractedCount > 0;
  const allExtractableSelected = extractableIds.length > 0 && extractableIds.every((id) => selectedIds.has(id));

  const publishSelection = (next: string[]) => {
    const unique = [...new Set(next)];
    if (onSelectionChange) onSelectionChange(unique);
    else setLocalSelection(unique);
  };

  const toggleSelected = (documentId: string, selected: boolean) => {
    publishSelection(selected
      ? [...selection, documentId]
      : selection.filter((id) => id !== documentId));
  };

  const toggleExpanded = (anchorId: string, expanded: boolean) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (expanded) next.add(anchorId);
      else next.delete(anchorId);
      return next;
    });
    actions.onToggleAssociation?.(anchorId, expanded);
  };

  const acceptDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void actions.onDropFiles?.(files);
  };

  const renderDocumentCard = (document: AudiPickLegacyProjectDocument) => {
    const group = groupMap.get(document.id);
    return (
      <DocumentCard
        key={document.id}
        document={document}
        members={group?.members ?? []}
        documentMap={documentMap}
        rules={rules}
        selectedIds={selectedIds}
        expanded={expandedGroups.has(document.id)}
        disabled={busy}
        actions={actions}
        onSelected={toggleSelected}
        onExpanded={toggleExpanded}
      />
    );
  };

  return (
    <div className="ap-legacy-project">
      <header className="alp-project-header">
        <div className="alp-project-title">
          <button type="button" className="alp-back" onClick={actions.onBack}>返回</button>
          <h1>{project.name}</h1>
          <p>{project.client || "未填写客户"} | {project.date || "未设置日期"}</p>
          <small>批量提取首选：{project.defaultRuleName || "未设置（上传后AI识别）"} · 每个文件可单独选模板</small>
        </div>
        <div className="alp-header-actions">
          <button
            type="button"
            className="alp-button alp-button-primary"
            disabled={busy || selectedIds.size === 0}
            onClick={() => void actions.onBatchExtract([...selectedIds])}
          >
            开始提取
          </button>
          {showLoanAudit && actions.onOpenLoanAudit && (
            <button type="button" className="alp-button alp-button-outline" disabled={busy} onClick={actions.onOpenLoanAudit}>
              借款审计中心
            </button>
          )}
          <button
            type="button"
            className="alp-button alp-button-outline"
            disabled={busy || !hasResults}
            title={hasResults ? undefined : "提取完成后可导出"}
            onClick={() => void actions.onExportProject()}
          >
            导出结果
          </button>
          {!hasResults && <span className="alp-export-hint">提取完成后可导出</span>}
        </div>
      </header>

      {ocrTask && (
        <section className="alp-ocr-banner">
          <div>
            <strong>发现未完成的合同识别</strong>
            <p>
              {ocrTask.fileName || "PDF"} · 已保存 {ocrTask.completedPages}/{ocrTask.totalPages ?? "?"} 页
              {(ocrTask.remainingCount ?? 0) > 0 ? ` · 另有 ${ocrTask.remainingCount} 个任务` : ""}
            </p>
          </div>
          <div className="alp-inline-actions">
            {actions.onDiscardOcr && <button type="button" className="alp-button alp-button-secondary" disabled={busy} onClick={() => void actions.onDiscardOcr?.(ocrTask.id)}>放弃任务</button>}
            {actions.onResumeOcr && <button type="button" className="alp-button alp-button-primary" disabled={busy} onClick={() => void actions.onResumeOcr?.(ocrTask.id)}>继续识别</button>}
          </div>
        </section>
      )}

      <section className="alp-stat-grid" aria-label="项目文件统计">
        <div className="alp-card"><span>文件总数</span><strong>{documents.length}</strong></div>
        <div className="alp-card is-success"><span>模板已确认</span><strong>{confirmedCount}</strong></div>
        <div className="alp-card is-accent"><span>待提取</span><strong>{pendingCount}</strong></div>
        <div className="alp-card is-blue"><span>已提取</span><strong>{extractedCount}</strong></div>
      </section>

      <section className={`alp-upload-card${documents.length === 0 ? " is-empty" : ""}`}>
        <div className="alp-upload-heading">
          <div>
            <h2>上传PDF/扫描件</h2>
            <p>
              {documents.length === 0
                ? <>合同、对账单、发票、出入库单等；文字PDF直接提取，扫描件使用<span>{ocrLabel}</span>识别</>
                : <>文字PDF直接提取，扫描件使用<span>{ocrLabel}</span>识别；也可以把文件拖到这里追加。</>}
            </p>
          </div>
          <div className="alp-inline-actions">
            <button type="button" className="alp-button alp-button-primary" disabled={busy} onClick={() => void actions.onPickPdfs()}>选择PDF</button>
            <button type="button" className="alp-button alp-button-secondary" disabled={busy} onClick={() => void actions.onPickFolder()}>选择文件夹</button>
          </div>
        </div>
        <div
          className={`alp-dropzone${dragging ? " is-dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={acceptDrop}
        >
          {documents.length === 0 && <UploadIcon />}
          <strong>{documents.length === 0 ? "拖拽PDF或文件夹到此处" : "拖拽PDF或文件夹到此处继续添加"}</strong>
          {documents.length === 0 && <small>扫描件使用{ocrLabel}识别</small>}
        </div>
        {uploadStatus && <div className="alp-upload-status">{uploadStatus}</div>}
      </section>

      <section className="alp-file-list">
        <div className="alp-file-list-header">
          <h2>文件列表 ({documents.length}){pendingCount > 0 ? ` · ${pendingCount}份待提取` : ""}</h2>
          {documents.length > 0 && (
            <label className="alp-select-all">
              <input
                type="checkbox"
                className="alp-checkbox"
                checked={allExtractableSelected}
                disabled={busy || extractableIds.length === 0}
                onChange={(event) => publishSelection(event.target.checked ? extractableIds : [])}
              />
              全选待提取
            </label>
          )}
        </div>

        {documents.length === 0 ? (
          <div className="alp-empty-card">暂无文件，请上传PDF</div>
        ) : (
          <div className="alp-sections">
            {contractGroups.length > 0 && (
              <div className="alp-file-section">
                <div className="alp-section-heading"><h3>合同组</h3><span>{contractGroups.length}组</span></div>
                <div className="alp-card-stack">{contractGroups.map(renderDocumentCard)}</div>
              </div>
            )}

            {suggestedDocuments.length > 0 && (
              <div className="alp-file-section">
                <div className="alp-section-heading is-warning"><h3>待确认关联</h3><span>{suggestedDocuments.length}份</span></div>
                <div className="alp-card-stack">
                  {suggestedDocuments.map((document) => {
                    const suggestion = suggestionMap.get(document.id)!;
                    return (
                      <article className="alp-file-card" key={document.id}>
                        <div className="alp-suggestion-header">
                          <div>
                            <p><span>AI建议关联至：</span>{suggestion.anchorName}</p>
                            <small>{suggestion.reason}</small>
                          </div>
                          <div className="alp-inline-actions">
                            {actions.onDismissAssociation && (
                              <button type="button" className="alp-link-button" disabled={busy} onClick={() => void actions.onDismissAssociation?.(document.id, suggestion.anchorFileId)}>忽略</button>
                            )}
                            <button type="button" className="alp-button alp-button-outline" disabled={busy} onClick={() => void actions.onConfirmAssociation(document.id, suggestion.anchorFileId, suggestion)}>确认关联</button>
                          </div>
                        </div>
                        <div className="alp-file-row">
                          <div className="alp-checkbox-slot"><DocumentCheckbox document={document} selected={selectedIds.has(document.id)} disabled={busy} onChange={(selected) => toggleSelected(document.id, selected)} /></div>
                          <div className="alp-file-content">
                            <div className="alp-file-heading">
                              <button type="button" className="alp-file-name" disabled={busy} onClick={() => void actions.onOpenDocument(document.id)}>{document.name}</button>
                              <Chevron />
                            </div>
                            <LegacyDocumentMeta document={document} rules={rules} disabled={busy} actions={actions} />
                          </div>
                          <button type="button" className="alp-delete-button" disabled={busy} onClick={() => void actions.onDeleteDocument(document.id)}>删除</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}

            {unassignedDocuments.length > 0 && (
              <div className="alp-file-section">
                <div className="alp-section-heading"><h3>待归属资料</h3><span>{unassignedDocuments.length}份 · AI暂未找到可靠的主合同</span></div>
                <div className="alp-card-stack">{unassignedDocuments.map(renderDocumentCard)}</div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
