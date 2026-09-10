import {
  type CSSProperties,
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import "./AudiPickLegacyContract.css";

export type AudiPickLegacyContractView = "detail" | "workpaper";

export type AudiPickLegacyRuleOption = {
  id: string;
  name: string;
};

export type AudiPickLegacyResultColumn = {
  key: string;
  label: string;
  editable?: boolean;
  long?: boolean;
};

export type AudiPickLegacyResultRow = {
  id: string;
  reviewed?: boolean;
  values: Record<string, unknown>;
};

export type AudiPickLegacyResultVersion = {
  id: string;
  label: string;
  count?: number;
};

export type AudiPickLegacyFileFlow = {
  ruleId: string;
  rules: AudiPickLegacyRuleOption[];
  ruleName: string;
  detectedLabel?: string;
  detectedConfidence?: "high" | "medium" | "low";
  detectedReason?: string;
  ruleConfirmed: boolean;
  resultCount: number;
  versionCount?: number;
  appliedRuleCount: number;
  associationSummary?: string;
  associationNeedsRefresh?: boolean;
  extractDisabled?: boolean;
  onRuleChange: (ruleId: string) => void;
  onConfirmRule: (ruleId: string) => void;
  onManageAssociation?: () => void;
  onExtract: () => void;
  onExportCurrent: () => void;
  onExportAll: () => void;
};

export type AudiPickLegacyWorkpaper = {
  ruleId: string;
  rules: AudiPickLegacyRuleOption[];
  versions: AudiPickLegacyResultVersion[];
  versionId: string;
  filterText: string;
  columns: AudiPickLegacyResultColumn[];
  rows: AudiPickLegacyResultRow[];
  selectedRowId?: string;
  extra?: ReactNode;
  onRuleChange: (ruleId: string) => void;
  onVersionChange: (versionId: string) => void;
  onFilterChange: (value: string) => void;
  onSelectRow: (rowId: string) => void;
  onFieldChange: (rowId: string, key: string, value: string) => void;
  onSaveRow: (rowId: string) => void;
  onCopyRow: (rowId: string) => void;
  onToggleReviewed: (rowId: string) => void;
  onOpenEvidence: (rowId: string) => void;
};

export type AudiPickLegacyContractProps = {
  view: AudiPickLegacyContractView;
  projectName: string;
  contractName: string;
  clientName?: string;
  projectDate?: string;
  textLength: number;
  totalExtracted: number;
  isScanned: boolean;
  recognitionLabel?: string;
  aiReady: boolean;
  busy?: boolean;
  previewOpen: boolean;
  previewWidthPercent?: number;
  preview?: ReactNode;
  contractText?: string;
  fileFlow: AudiPickLegacyFileFlow;
  workpaper: AudiPickLegacyWorkpaper;
  onBackWorkbench: () => void;
  onBackProject: () => void;
  onViewChange: (view: AudiPickLegacyContractView) => void;
  onTogglePreview: () => void;
  onPreviewWidthChange?: (percent: number) => void;
  onContractTextChange?: (value: string) => void;
  onSaveContractText?: () => void;
  onCopyContractText?: () => void;
};

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function confidenceLabel(value?: "high" | "medium" | "low"): string {
  if (value === "high") return "高";
  if (value === "medium") return "中";
  return "低";
}

function Breadcrumbs({
  projectName,
  contractName,
  onBackWorkbench,
  onBackProject,
}: Pick<
  AudiPickLegacyContractProps,
  "projectName" | "contractName" | "onBackWorkbench" | "onBackProject"
>) {
  return (
    <nav className="aplc-breadcrumbs" aria-label="面包屑">
      <button type="button" onClick={onBackWorkbench}>
        工作台
      </button>
      <span>/</span>
      <button type="button" onClick={onBackProject}>
        {projectName}
      </button>
      <span>/</span>
      <span title={contractName}>{contractName}</span>
    </nav>
  );
}

function FileFlowCard({
  flow,
  busy,
  onOpenWorkpaper,
}: {
  flow: AudiPickLegacyFileFlow;
  busy: boolean;
  onOpenWorkpaper: () => void;
}) {
  const hasExtracted = flow.resultCount > 0;
  return (
    <section className="aplc-card aplc-flow-card">
      <header className="aplc-card-heading">
        <h2>当前文件处理流程</h2>
        <p>
          本模板 {flow.resultCount} 条
          {(flow.versionCount ?? 0) > 1 ? ` · ${flow.versionCount} 套底稿` : ""}
          {` · 已用 ${flow.appliedRuleCount} 种模板`}
        </p>
      </header>

      {flow.associationSummary && (
        <div
          className={`aplc-association ${flow.associationNeedsRefresh ? "warning" : ""}`}
        >
          <div>
            <strong>合同资料包</strong>
            <p>{flow.associationSummary}</p>
          </div>
          {flow.onManageAssociation && (
            <button
              type="button"
              className="aplc-button ghost"
              onClick={flow.onManageAssociation}
            >
              管理关联资料
            </button>
          )}
        </div>
      )}

      <div className="aplc-flow-step">
        <span className="aplc-step-number">1</span>
        <div className="aplc-step-body">
          <div className="aplc-step-copy">
            <div>
              <h3>模板确认</h3>
              <p>
                AI 判断：<strong>{flow.detectedLabel || flow.ruleName}</strong>
                {` · 置信度：`}
                <span
                  className={`aplc-confidence ${flow.detectedConfidence ?? "low"}`}
                >
                  {confidenceLabel(flow.detectedConfidence)}
                </span>
                {` · `}
                <span
                  className={flow.ruleConfirmed ? "aplc-good" : "aplc-warn"}
                >
                  {flow.ruleConfirmed ? "已确认" : "待确认"}
                </span>
              </p>
            </div>
            {flow.detectedReason && (
              <p className="aplc-reason">{flow.detectedReason}</p>
            )}
          </div>
          <div className="aplc-inline-actions">
            <span>{flow.ruleConfirmed ? "已使用模板" : "当前模板"}</span>
            <select
              aria-label="当前文件模板"
              value={flow.ruleId}
              disabled={busy}
              onChange={(event) => flow.onRuleChange(event.target.value)}
            >
              {flow.rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.name}
                </option>
              ))}
            </select>
            {!flow.ruleConfirmed ? (
              <button
                type="button"
                className="aplc-button outline"
                disabled={busy}
                onClick={() => flow.onConfirmRule(flow.ruleId)}
              >
                确认模板
              </button>
            ) : (
              <span className="aplc-confirmed">模板已确认</span>
            )}
          </div>
        </div>
      </div>

      <div className="aplc-flow-step">
        <span className="aplc-step-number">2</span>
        <div className="aplc-step-body horizontal">
          <div>
            <h3>字段选择与提取</h3>
            <p>
              模板：<strong>{flow.ruleName}</strong>
              。开始前会让你勾选本次要提取的字段。
            </p>
          </div>
          <button
            type="button"
            className="aplc-button primary"
            disabled={busy || flow.extractDisabled}
            onClick={flow.onExtract}
          >
            {hasExtracted ? "重新提取" : "选择字段并开始提取"}
          </button>
        </div>
      </div>

      <div className="aplc-flow-step">
        <span className="aplc-step-number">3</span>
        <div className="aplc-step-body horizontal">
          <div>
            <h3>底稿查看与导出</h3>
            <p>
              {hasExtracted
                ? `当前模板已有 ${flow.resultCount} 条结果。`
                : "提取完成后可查看底稿并导出 Excel。"}
            </p>
          </div>
          <div className="aplc-flow-actions">
            <button
              type="button"
              className={
                hasExtracted ? "aplc-button primary" : "aplc-button outline"
              }
              disabled={!hasExtracted || busy}
              onClick={onOpenWorkpaper}
            >
              {hasExtracted ? `查看底稿(${flow.resultCount})` : "查看底稿"}
            </button>
            <button
              type="button"
              className="aplc-button outline"
              disabled={!hasExtracted || busy}
              onClick={flow.onExportCurrent}
            >
              导出当前底稿
            </button>
            <button
              type="button"
              className="aplc-button outline"
              disabled={!hasExtracted || busy}
              onClick={flow.onExportAll}
            >
              导出全部底稿
            </button>
            <details className="aplc-more-menu">
              <summary>更多操作 ▾</summary>
              <div>
                {hasExtracted && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={flow.onExtract}
                  >
                    重新提取
                  </button>
                )}
                <button
                  type="button"
                  disabled={!hasExtracted || busy}
                  onClick={flow.onExportCurrent}
                >
                  导出当前底稿
                </button>
                <button
                  type="button"
                  disabled={!hasExtracted || busy}
                  onClick={flow.onExportAll}
                >
                  导出全部底稿
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>
    </section>
  );
}

function ContractDetail(props: AudiPickLegacyContractProps) {
  const recognition =
    props.recognitionLabel || (props.isScanned ? "OCR" : "文字");
  return (
    <div className="aplc-page-stack">
      <header className="aplc-contract-header">
        <Breadcrumbs {...props} />
        <div className="aplc-title-row">
          <div className="aplc-title-copy">
            <button
              type="button"
              className="aplc-back"
              onClick={props.onBackProject}
            >
              ⬅ 返回
            </button>
            <div>
              <h1>{props.contractName}</h1>
              <p>
                {props.textLength > 0 ? `${props.textLength}字 ` : ""}
                {props.isScanned ? `(${recognition}识别) ` : ""}· 累计提取{" "}
                {props.totalExtracted} 条
              </p>
            </div>
          </div>
          <div className="aplc-header-actions">
            <button
              type="button"
              className="aplc-button outline"
              onClick={props.onTogglePreview}
            >
              {props.previewOpen ? "关闭PDF" : "预览PDF"}
            </button>
            <span className={`aplc-ai-state ${props.aiReady ? "ready" : ""}`}>
              {props.aiReady ? "AI就绪" : "未配置"}
            </span>
          </div>
        </div>
      </header>

      <FileFlowCard
        flow={props.fileFlow}
        busy={Boolean(props.busy)}
        onOpenWorkpaper={() => props.onViewChange("workpaper")}
      />

      <section className="aplc-stat-grid" aria-label="合同处理统计">
        <div className="aplc-card">
          <span>当前模板条数</span>
          <strong>{props.fileFlow.resultCount}</strong>
        </div>
        <div className="aplc-card">
          <span>合同字数</span>
          <strong className="blue">{props.textLength}</strong>
        </div>
        <div className="aplc-card">
          <span>已用模板数</span>
          <strong className="accent">{props.fileFlow.appliedRuleCount}</strong>
        </div>
        <div className="aplc-card">
          <span>识别方式</span>
          <strong className="method">{recognition}</strong>
        </div>
      </section>

      {props.contractText !== undefined && props.contractText.length > 0 && (
        <details className="aplc-card aplc-contract-text">
          <summary>合同文本 / OCR文本（{props.textLength}字）</summary>
          <div>
            <textarea
              aria-label="合同文本或 OCR 文本"
              value={props.contractText}
              disabled={!props.onContractTextChange}
              onChange={(event) =>
                props.onContractTextChange?.(event.target.value)
              }
            />
            <div className="aplc-actions">
              <button
                type="button"
                className="aplc-button primary"
                disabled={!props.onSaveContractText || props.busy}
                onClick={props.onSaveContractText}
              >
                保存修改
              </button>
              <button
                type="button"
                className="aplc-button secondary"
                disabled={!props.onCopyContractText}
                onClick={props.onCopyContractText}
              >
                复制文本
              </button>
            </div>
          </div>
        </details>
      )}

      {props.contractText !== undefined && props.contractText.length === 0 && (
        <div className="aplc-empty">
          当前文件还没有可用文字。请先读取文字层或完成 OCR。
        </div>
      )}
    </div>
  );
}

function WorkpaperView(props: AudiPickLegacyContractProps) {
  const { workpaper } = props;
  const selected =
    workpaper.rows.find((row) => row.id === workpaper.selectedRowId) ??
    workpaper.rows[0];
  return (
    <div className="aplc-page-stack">
      <header className="aplc-contract-header">
        <div className="aplc-title-row">
          <div className="aplc-title-copy">
            <button
              type="button"
              className="aplc-back"
              onClick={() => props.onViewChange("detail")}
            >
              ⬅ 返回
            </button>
            <div>
              <h1>工作底稿</h1>
              <p>{props.contractName}</p>
            </div>
          </div>
          <button
            type="button"
            className="aplc-button outline"
            onClick={props.onTogglePreview}
          >
            {props.previewOpen ? "关闭PDF" : "预览PDF"}
          </button>
        </div>
      </header>

      <section className="aplc-card aplc-work-controls">
        <div className="aplc-control-row">
          <label>
            <span>当前模板</span>
            <select
              value={workpaper.ruleId}
              onChange={(event) => workpaper.onRuleChange(event.target.value)}
            >
              {workpaper.rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>底稿版本</span>
            <select
              value={workpaper.versionId}
              onChange={(event) =>
                workpaper.onVersionChange(event.target.value)
              }
            >
              {workpaper.versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.label}
                  {version.count === undefined ? "" : `（${version.count}条）`}
                </option>
              ))}
            </select>
          </label>
          <span className="aplc-result-count">
            {workpaper.rows.length} 条结果
          </span>
          {workpaper.versions.length > 1 && (
            <span className="aplc-version-count">
              共 {workpaper.versions.length} 套底稿
            </span>
          )}
          <div className="aplc-control-actions">
            <button
              type="button"
              className="aplc-button outline"
              disabled={!workpaper.rows.length || props.busy}
              onClick={props.fileFlow.onExportCurrent}
            >
              导出当前底稿
            </button>
            <button
              type="button"
              className="aplc-button outline"
              disabled={!workpaper.rows.length || props.busy}
              onClick={props.fileFlow.onExportAll}
            >
              导出全部底稿
            </button>
          </div>
        </div>
        <label className="aplc-filter">
          <input
            type="search"
            value={workpaper.filterText}
            placeholder="筛选：输入关键词定位条款…"
            onChange={(event) => workpaper.onFilterChange(event.target.value)}
          />
          <span>{workpaper.rows.length} 条</span>
        </label>
      </section>

      {workpaper.rows.length === 0 ? (
        <div className="aplc-empty">
          当前模板和版本暂无底稿结果。请返回合同详情完成提取。
        </div>
      ) : (
        <div className="aplc-work-grid">
          <section className="aplc-card aplc-result-list">
            <header>条目列表</header>
            <div className="aplc-table-scroll">
              <table>
                <thead>
                  <tr>
                    {workpaper.columns.map((column) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                    <th>复核状态</th>
                  </tr>
                </thead>
                <tbody>
                  {workpaper.rows.map((row) => (
                    <tr
                      key={row.id}
                      className={row.id === selected?.id ? "selected" : ""}
                      onClick={() => workpaper.onSelectRow(row.id)}
                    >
                      {workpaper.columns.map((column) => (
                        <td key={column.key}>
                          {valueText(row.values[column.key]) || "—"}
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          className={
                            row.reviewed ? "aplc-reviewed" : "aplc-pending"
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            workpaper.onToggleReviewed(row.id);
                          }}
                        >
                          {row.reviewed ? "已复核" : "待复核"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="aplc-card aplc-result-detail">
            {selected ? (
              <>
                <header>
                  <div>
                    <span>条目详情</span>
                    <strong>{selected.reviewed ? "已复核" : "待复核"}</strong>
                  </div>
                </header>
                <div className="aplc-result-fields">
                  {workpaper.columns.map((column) => (
                    <label key={column.key}>
                      <span>{column.label}</span>
                      <textarea
                        rows={column.long ? 5 : 2}
                        value={valueText(selected.values[column.key])}
                        readOnly={!column.editable}
                        onChange={(event) =>
                          workpaper.onFieldChange(
                            selected.id,
                            column.key,
                            event.target.value,
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
                <div className="aplc-actions wrap">
                  <button
                    type="button"
                    className="aplc-button primary"
                    disabled={props.busy}
                    onClick={() => workpaper.onSaveRow(selected.id)}
                  >
                    保存修改
                  </button>
                  <button
                    type="button"
                    className="aplc-button secondary"
                    onClick={() => workpaper.onCopyRow(selected.id)}
                  >
                    复制条目
                  </button>
                  <button
                    type="button"
                    className="aplc-button outline"
                    onClick={() => workpaper.onOpenEvidence(selected.id)}
                  >
                    查看证据
                  </button>
                  <button
                    type="button"
                    className="aplc-button outline"
                    onClick={() => workpaper.onToggleReviewed(selected.id)}
                  >
                    {selected.reviewed ? "取消复核" : "标记已复核"}
                  </button>
                </div>
              </>
            ) : (
              <div className="aplc-empty compact">
                从左侧选择一个条目查看详情。
              </div>
            )}
          </section>
        </div>
      )}
      {workpaper.extra}
    </div>
  );
}

function SplitPane({
  children,
  props,
}: {
  children: ReactNode;
  props: AudiPickLegacyContractProps;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const width = Math.max(25, Math.min(65, props.previewWidthPercent ?? 42));

  function resize(clientX: number) {
    const pane = paneRef.current;
    if (!pane || !props.onPreviewWidthChange) return;
    const bounds = pane.getBoundingClientRect();
    const next = ((clientX - bounds.left) / Math.max(bounds.width, 1)) * 100;
    props.onPreviewWidthChange(
      Math.max(25, Math.min(65, Math.round(next * 10) / 10)),
    );
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!props.onPreviewWidthChange) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resize(event.clientX);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    resize(event.clientX);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      !props.onPreviewWidthChange ||
      !["ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    props.onPreviewWidthChange(
      Math.max(25, Math.min(65, width + (event.key === "ArrowLeft" ? -2 : 2))),
    );
  }

  if (!props.previewOpen) return <>{children}</>;
  return (
    <div className="aplc-split" ref={paneRef}>
      <section
        className="aplc-preview"
        style={{ "--aplc-preview-width": `${width}%` } as CSSProperties}
        aria-label="PDF 预览"
      >
        {props.preview ?? (
          <div className="aplc-empty compact">PDF 预览尚未就绪。</div>
        )}
      </section>
      <div
        className="aplc-split-handle"
        role="separator"
        aria-label="调整 PDF 预览宽度"
        aria-orientation="vertical"
        aria-valuemin={25}
        aria-valuemax={65}
        aria-valuenow={width}
        tabIndex={props.onPreviewWidthChange ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
      />
      <div className="aplc-split-content">{children}</div>
    </div>
  );
}

export function AudiPickLegacyContract(props: AudiPickLegacyContractProps) {
  return (
    <div className="aplc-contract">
      <div className="aplc-view-switch" aria-label="合同页面视图">
        <button
          type="button"
          className={props.view === "detail" ? "active" : ""}
          onClick={() => props.onViewChange("detail")}
        >
          合同详情
        </button>
        <button
          type="button"
          className={props.view === "workpaper" ? "active" : ""}
          disabled={!props.fileFlow.resultCount}
          onClick={() => props.onViewChange("workpaper")}
        >
          工作底稿
        </button>
      </div>
      <SplitPane props={props}>
        {props.view === "detail" ? (
          <ContractDetail {...props} />
        ) : (
          <WorkpaperView {...props} />
        )}
      </SplitPane>
    </div>
  );
}
