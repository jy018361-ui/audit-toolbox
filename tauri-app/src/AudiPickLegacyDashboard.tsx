import { useEffect, useMemo, useRef, useState } from "react";
import "./AudiPickLegacyDashboard.css";

export type AudiPickLegacyProjectStatus = "active" | "completed";
export type AudiPickLegacyPhaseTone =
  "gray" | "amber" | "blue" | "green" | "red";

export type AudiPickLegacyProjectProgress = {
  phase: string;
  tone: AudiPickLegacyPhaseTone;
  rootCount: number;
  extracted: number;
  reviewTotal: number;
  reviewed: number;
  percent: number;
  ready: boolean;
  stale?: boolean;
};

export type AudiPickLegacyProject = {
  id: string;
  name: string;
  client?: string;
  date?: string;
  status?: AudiPickLegacyProjectStatus;
  createdAt?: string | number;
  updatedAt?: string | number;
  fileCount: number;
  templateCount: number;
  defaultTemplateName?: string;
  progress: AudiPickLegacyProjectProgress;
};

export type AudiPickLegacyTemplateOption = {
  id: string;
  name: string;
};

export type AudiPickLegacyCreateProjectValues = {
  name: string;
  client: string;
  date: string;
  defaultTemplateId?: string;
};

export type AudiPickLegacyProjectFilter = "all" | AudiPickLegacyProjectStatus;

export type AudiPickLegacyProjectSort =
  | "updated_desc"
  | "updated_asc"
  | "created_desc"
  | "created_asc"
  | "date_desc"
  | "date_asc"
  | "name_asc"
  | "name_desc"
  | "status_asc"
  | "status_desc"
  | "progress_desc"
  | "progress_asc";

export type AudiPickLegacyDashboardPreferences = {
  search: string;
  status: AudiPickLegacyProjectFilter;
  sort: AudiPickLegacyProjectSort;
};

export type AudiPickLegacyDashboardProps = {
  projects: AudiPickLegacyProject[];
  templates: AudiPickLegacyTemplateOption[];
  busy?: boolean;
  createError?: string;
  initialTemplateId?: string;
  initialPreferences?: Partial<AudiPickLegacyDashboardPreferences>;
  onPreferencesChange?: (
    preferences: AudiPickLegacyDashboardPreferences,
  ) => void;
  onCreateProject: (
    values: AudiPickLegacyCreateProjectValues,
  ) => void | boolean | Promise<void | boolean>;
  onContinueProject: (project: AudiPickLegacyProject) => void;
  onDeleteProject: (project: AudiPickLegacyProject) => void | Promise<void>;
  onProjectStatusChange: (
    project: AudiPickLegacyProject,
    status: AudiPickLegacyProjectStatus,
  ) => void | Promise<void>;
};

export type AudiPickLegacyNewProjectModalProps = {
  open: boolean;
  templates: AudiPickLegacyTemplateOption[];
  initialTemplateId?: string;
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onCreate: (
    values: AudiPickLegacyCreateProjectValues,
  ) => void | boolean | Promise<void | boolean>;
};

const DEFAULT_PREFERENCES: AudiPickLegacyDashboardPreferences = {
  search: "",
  status: "all",
  sort: "updated_desc",
};

const SORT_OPTIONS: Array<{
  value: AudiPickLegacyProjectSort;
  label: string;
}> = [
  { value: "updated_desc", label: "最近更新：新到旧" },
  { value: "updated_asc", label: "最近更新：旧到新" },
  { value: "created_desc", label: "创建时间：新到旧" },
  { value: "created_asc", label: "创建时间：旧到新" },
  { value: "date_desc", label: "项目日期：新到旧" },
  { value: "date_asc", label: "项目日期：旧到新" },
  { value: "name_asc", label: "项目名称：A-Z" },
  { value: "name_desc", label: "项目名称：Z-A" },
  { value: "status_asc", label: "项目状态：进行中优先" },
  { value: "status_desc", label: "项目状态：已完成优先" },
  { value: "progress_desc", label: "完成度：高到低" },
  { value: "progress_asc", label: "完成度：低到高" },
];

function today(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timestamp(value: string | number | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectStatus(
  project: AudiPickLegacyProject,
): AudiPickLegacyProjectStatus {
  return project.status === "completed" ? "completed" : "active";
}

function formatProjectTime(value: string | number | undefined): string {
  const parsed = timestamp(value);
  if (!parsed) return "暂无记录";
  const date = new Date(parsed);
  const now = new Date();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return `今天 ${hours}:${minutes}`;
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day} ${hours}:${minutes}`;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sortProjects(
  projects: AudiPickLegacyProject[],
  sort: AudiPickLegacyProjectSort,
): AudiPickLegacyProject[] {
  return projects
    .map((project, index) => ({ project, index }))
    .sort((left, right) => {
      let result = 0;
      if (sort.startsWith("name_")) {
        result = left.project.name.localeCompare(right.project.name, "zh-CN");
      } else if (sort.startsWith("created_")) {
        result =
          timestamp(left.project.createdAt) -
          timestamp(right.project.createdAt);
      } else if (sort.startsWith("date_")) {
        result = (left.project.date ?? "").localeCompare(
          right.project.date ?? "",
        );
      } else if (sort.startsWith("status_")) {
        result = projectStatus(left.project).localeCompare(
          projectStatus(right.project),
        );
      } else if (sort.startsWith("progress_")) {
        result = left.project.progress.percent - right.project.progress.percent;
      } else {
        result =
          timestamp(left.project.updatedAt) -
          timestamp(right.project.updatedAt);
      }
      if (sort.endsWith("_desc")) result = -result;
      return result || left.index - right.index;
    })
    .map(({ project }) => project);
}

export function AudiPickLegacyNewProjectModal({
  open,
  templates,
  initialTemplateId = "",
  busy = false,
  error = "",
  onClose,
  onCreate,
}: AudiPickLegacyNewProjectModalProps) {
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [date, setDate] = useState(today);
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const [validationError, setValidationError] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setClient("");
    setDate(today());
    setTemplateId(initialTemplateId);
    setValidationError("");
    const frame = requestAnimationFrame(() => nameInputRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, initialTemplateId, onClose, open]);

  if (!open) return null;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedClient = client.trim();
    if (!trimmedName || !trimmedClient) {
      setValidationError("请填写名称");
      (!trimmedName ? nameInputRef.current : null)?.focus();
      return;
    }
    setValidationError("");
    await onCreate({
      name: trimmedName,
      client: trimmedClient,
      date,
      defaultTemplateId: templateId || undefined,
    });
  };

  return (
    <div
      className="ap146-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        aria-labelledby="ap146-new-project-title"
        aria-modal="true"
        className="ap146-new-project-modal"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 id="ap146-new-project-title">新建项目</h3>
        <form onSubmit={(event) => void submit(event)}>
          <input
            ref={nameInputRef}
            autoComplete="off"
            disabled={busy}
            placeholder="项目名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            autoComplete="off"
            disabled={busy}
            placeholder="客户名称"
            value={client}
            onChange={(event) => setClient(event.target.value)}
          />
          <label>
            <span>批量提取首选模板（可选，单文件可单独选）</span>
            <select
              disabled={busy}
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              <option value="">未设置（上传后 AI 识别）</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          <input
            aria-label="项目日期"
            disabled={busy}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          {(validationError || error) && (
            <p className="ap146-modal-error" role="alert">
              {validationError || error}
            </p>
          )}
          <div className="ap146-modal-actions">
            <button
              className="ap146-cancel-button"
              disabled={busy}
              type="button"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="ap146-primary-button"
              disabled={busy}
              type="submit"
            >
              {busy ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function AudiPickLegacyDashboard({
  projects,
  templates,
  busy = false,
  createError = "",
  initialTemplateId = "",
  initialPreferences,
  onPreferencesChange,
  onCreateProject,
  onContinueProject,
  onDeleteProject,
  onProjectStatusChange,
}: AudiPickLegacyDashboardProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [preferences, setPreferences] =
    useState<AudiPickLegacyDashboardPreferences>({
      ...DEFAULT_PREFERENCES,
      ...initialPreferences,
    });

  const updatePreferences = (
    patch: Partial<AudiPickLegacyDashboardPreferences>,
  ) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    onPreferencesChange?.(next);
  };

  const activeCount = projects.filter(
    (project) => projectStatus(project) === "active",
  ).length;
  const completedCount = projects.length - activeCount;
  const visibleProjects = useMemo(() => {
    const query = preferences.search.trim().toLocaleLowerCase("zh-CN");
    const filtered = projects.filter((project) => {
      if (
        preferences.status !== "all" &&
        projectStatus(project) !== preferences.status
      ) {
        return false;
      }
      if (!query) return true;
      return `${project.name} ${project.client ?? ""}`
        .toLocaleLowerCase("zh-CN")
        .includes(query);
    });
    return sortProjects(filtered, preferences.sort);
  }, [preferences, projects]);

  const changeStatus = async (
    project: AudiPickLegacyProject,
    nextStatus: AudiPickLegacyProjectStatus,
  ) => {
    if (
      nextStatus === "completed" &&
      !project.progress.ready &&
      !window.confirm(
        "当前项目仍有待提取、待复核或需更新事项。是否仍标记为已完成？",
      )
    ) {
      return;
    }
    await onProjectStatusChange(project, nextStatus);
  };

  const deleteProject = async (project: AudiPickLegacyProject) => {
    if (
      !window.confirm(
        `确认删除项目「${project.name}」？\n将同时删除该项目下全部合同、补充资料、提取结果及PDF，不可恢复。`,
      )
    ) {
      return;
    }
    await onDeleteProject(project);
  };

  return (
    <section className="ap146-dashboard" aria-label="AudiPick 项目工作台">
      <header className="ap146-dashboard-header">
        <div>
          <h1>工作台</h1>
          <p>项目状态由用户管理，系统进度仅用于提示待提取和待复核事项。</p>
        </div>
        <button
          id="btn-new-proj"
          className="ap146-primary-button ap146-small-button"
          disabled={busy}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setCreateOpen(true)}
        >
          新建项目
        </button>
      </header>

      <div className="ap146-metrics">
        <button
          aria-pressed={preferences.status === "all"}
          className={preferences.status === "all" ? "selected" : ""}
          type="button"
          onClick={() => updatePreferences({ status: "all" })}
        >
          <span>项目总数</span>
          <strong>{projects.length}</strong>
        </button>
        <button
          aria-pressed={preferences.status === "active"}
          className={preferences.status === "active" ? "selected" : ""}
          type="button"
          onClick={() => updatePreferences({ status: "active" })}
        >
          <span>进行中</span>
          <strong className="active-count">{activeCount}</strong>
        </button>
        <button
          aria-pressed={preferences.status === "completed"}
          className={preferences.status === "completed" ? "selected" : ""}
          type="button"
          onClick={() => updatePreferences({ status: "completed" })}
        >
          <span>已完成</span>
          <strong className="completed-count">{completedCount}</strong>
        </button>
      </div>

      <div className="ap146-projects-section">
        <div className="ap146-projects-toolbar">
          <div>
            <h2>审计项目</h2>
            <p>
              当前显示 {visibleProjects.length}/{projects.length} 个项目
            </p>
          </div>
          <div className="ap146-project-filters">
            <input
              aria-label="搜索项目名称或客户"
              placeholder="搜索项目名称或客户"
              type="search"
              value={preferences.search}
              onChange={(event) =>
                updatePreferences({ search: event.target.value })
              }
            />
            <select
              aria-label="项目状态筛选"
              value={preferences.status}
              onChange={(event) =>
                updatePreferences({
                  status: event.target.value as AudiPickLegacyProjectFilter,
                })
              }
            >
              <option value="all">全部状态</option>
              <option value="active">进行中</option>
              <option value="completed">已完成</option>
            </select>
            <select
              aria-label="项目排序"
              value={preferences.sort}
              onChange={(event) =>
                updatePreferences({
                  sort: event.target.value as AudiPickLegacyProjectSort,
                })
              }
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="ap146-empty-projects">暂无项目</div>
        ) : visibleProjects.length === 0 ? (
          <div className="ap146-empty-projects">
            没有符合当前搜索或筛选条件的项目
          </div>
        ) : (
          <div className="ap146-project-list">
            {visibleProjects.map((project) => {
              const status = projectStatus(project);
              const percent = clampProgress(project.progress.percent);
              return (
                <article className="ap146-project-row" key={project.id}>
                  <div className="ap146-project-row-grid">
                    <button
                      className="ap146-project-summary"
                      type="button"
                      onClick={() => onContinueProject(project)}
                    >
                      <span className="ap146-project-title-line">
                        <strong>{project.name || "未命名项目"}</strong>
                        <span
                          className={`ap146-phase-badge ${project.progress.tone}`}
                        >
                          {project.progress.phase}
                        </span>
                        {project.progress.ready && status === "active" && (
                          <span className="ap146-ready-hint">
                            已满足完成条件
                          </span>
                        )}
                      </span>
                      <span className="ap146-project-subtitle">
                        {project.client || "未填写客户"} · 项目日期{" "}
                        {project.date || "未设置"}
                      </span>
                      <span className="ap146-project-stats">
                        {project.fileCount}份文件 · 已用{project.templateCount}
                        种模板 · 批量首选
                        {project.defaultTemplateName || "未设置"}
                      </span>
                    </button>

                    <label className="ap146-status-control">
                      <span>项目状态</span>
                      <select
                        className={status}
                        disabled={busy}
                        value={status}
                        onChange={(event) =>
                          void changeStatus(
                            project,
                            event.target.value as AudiPickLegacyProjectStatus,
                          )
                        }
                      >
                        <option value="active">进行中</option>
                        <option value="completed">已完成</option>
                      </select>
                    </label>

                    <div className="ap146-progress-block">
                      <div>
                        <span>
                          提取 {project.progress.extracted}/
                          {project.progress.rootCount} · 复核{" "}
                          {project.progress.reviewed}/
                          {project.progress.reviewTotal}
                        </span>
                        <span>{percent}%</span>
                      </div>
                      <div
                        aria-label={`项目完成度 ${percent}%`}
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={percent}
                        className="ap146-progress-track"
                        role="progressbar"
                      >
                        <span style={{ width: `${percent}%` }} />
                      </div>
                      {project.progress.stale && (
                        <p>关联资料已更新，需要重新提取</p>
                      )}
                    </div>

                    <div className="ap146-updated-at">
                      <span>最近更新</span>
                      <time>{formatProjectTime(project.updatedAt)}</time>
                    </div>

                    <div className="ap146-row-actions">
                      <button
                        className="ap146-outline-button ap146-small-button"
                        type="button"
                        onClick={() => onContinueProject(project)}
                      >
                        继续
                      </button>
                      <details>
                        <summary
                          aria-label={`管理项目 ${project.name}`}
                          title="更多操作"
                        >
                          •••
                        </summary>
                        <div>
                          <button
                            disabled={busy}
                            type="button"
                            onClick={() => void deleteProject(project)}
                          >
                            删除项目
                          </button>
                        </div>
                      </details>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <AudiPickLegacyNewProjectModal
        busy={busy}
        error={createError}
        initialTemplateId={initialTemplateId}
        open={createOpen}
        templates={templates}
        onClose={() => setCreateOpen(false)}
        onCreate={async (values) => {
          const created = await onCreateProject(values);
          if (created !== false) setCreateOpen(false);
        }}
      />
    </section>
  );
}
