import { useEffect, useMemo, useRef, useState } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenJobEvents,
  openOutput,
  pickPath,
  settingsGet,
  settingsSet,
} from "./api";
import type { JobEvent, ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import { errorText } from "@/lib/errors";
import { useJobPause } from "@/components/JobDialog";
import { confirmDialog } from "@/components/ConfirmDialog";
import {
  parseRollForwardCraRatio,
  rollForwardCraWriteRecords,
} from "./rollForwardUi";
import { displayFileName } from "@/fileDisplay";
import { PageHeader } from "@/components/PageHeader";
import { StepIndicator } from "@/components/StepIndicator";
import { ErrorBox } from "@/components/ErrorBox";
import { ResultView } from "@/components/ResultView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { SwitchInput } from "@/components/SwitchInput";
import { DataHandlingNotice } from "@/components/DataHandlingNotice";
import { JobProgress } from "@/components/JobProgress";
import { Card } from "@/components/ui/card";
import "./roll-forward.css";
type RollSubject = {
  code: string;
  name: string;
  templateFile: string;
};
type RollCompany = {
  id: string;
  name: string;
  bs_date: string;
  functional_currency: string;
  accounting_standard: string;
  pm: string;
  te: string;
  sad: string;
  prior_path: string;
  output_dir: string;
  subjects: string[];
  roll_wording: boolean;
  generate_summary: boolean;
  cra_text: string;
  cra_table_records: Array<Record<string, unknown>>;
  cra_header_preference: string;
  apply_cra: boolean;
  cra_skip_confirmed: boolean;
  llm_enhanced: boolean;
  llm_wording_revision: boolean;
  status?: string;
  generated?: number;
  failed?: number;
  last_message?: string;
};
type RollProject = {
  id: string;
  project_name: string;
  project_year: string;
  companies: RollCompany[];
  updated_at?: string;
};
let rollForwardInMemoryCache:
  | {
      projects: RollProject[];
      templateDir: string;
      pmtePath: string;
      projectIndex: number;
      companyIndex: number;
    }
  | undefined;

const newRollCompany = (name = "A公司"): RollCompany => ({
  id: crypto.randomUUID(),
  name,
  bs_date: "",
  functional_currency: "人民币",
  accounting_standard: "企业会计准则",
  pm: "",
  te: "",
  sad: "",
  prior_path: "",
  output_dir: "",
  subjects: [],
  roll_wording: false,
  generate_summary: true,
  cra_text: "",
  cra_table_records: [],
  cra_header_preference: "",
  apply_cra: false,
  cra_skip_confirmed: false,
  llm_enhanced: false,
  llm_wording_revision: false,
  status: "未处理",
  generated: 0,
  failed: 0,
  last_message: "",
});

function normalizeRollProjects(value: unknown): RollProject[] {
  const root =
    value && typeof value === "object"
      ? (value as { projects?: unknown }).projects
      : undefined;
  if (!Array.isArray(root)) return [];
  return root.map((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const companies = Array.isArray(row.companies) ? row.companies : [];
    return {
      id: String(row.id || crypto.randomUUID()),
      project_name: String(row.project_name || `项目${index + 1}`),
      project_year: String(row.project_year || ""),
      updated_at: String(row.updated_at || ""),
      companies: companies.map((entry, companyIndex) => {
        const company = (entry ?? {}) as Record<string, unknown>;
        return {
          ...newRollCompany(String(company.name || `公司${companyIndex + 1}`)),
          ...company,
          id: String(company.id || crypto.randomUUID()),
          subjects: Array.isArray(company.subjects)
            ? company.subjects.map(String)
            : [],
          cra_table_records: Array.isArray(company.cra_table_records)
            ? (company.cra_table_records as Array<Record<string, unknown>>)
            : [],
          cra_canvas_token: undefined,
        } as RollCompany;
      }),
    };
  });
}

export function RollForwardPage({ tool }: { tool: ToolManifest }) {
  const [subjects, setSubjects] = useState<RollSubject[]>([]);
  const [projects, setProjects] = useState<RollProject[]>([]);
  const [projectIndex, setProjectIndex] = useState(0);
  const [companyIndex, setCompanyIndex] = useState(0);
  const [templateDir, setTemplateDir] = useState("");
  const [pmtePath, setPmtePath] = useState("");
  const [craHeaderOptions, setCraHeaderOptions] = useState<string[]>([]);
  const [craSearch, setCraSearch] = useState("");
  const [craStatusFilter, setCraStatusFilter] = useState("all");
  const [craSubjectFilter, setCraSubjectFilter] = useState("all");
  const [craExceptionOnly, setCraExceptionOnly] = useState(false);
  const [rollPreferences, setRollPreferences] = useState({
    defaultPriorDir: "",
    defaultOutputDir: "",
    openOutputAfterSuccess: false,
    rememberLastProject: true,
  });
  const [busy, setBusy] = useState(false);
  // 暂停状态取自全局进度弹窗：这里和弹窗里的按钮是同一个开关，
  // 各记各的会出现「弹窗里暂停了、页面按钮还写着暂停」。
  const { isPaused, togglePause } = useJobPause();
  const [job, setJob] = useState<JobEvent>();
  const [validation, setValidation] = useState<unknown>();
  const [error, setError] = useState("");
  const jobCompanyRef = useRef<
    { projectId: string; companyId?: string } | undefined
  >(undefined);
  const loadedRef = useRef(false);
  const preferencesRef = useRef(rollPreferences);
  const project = projects[projectIndex];
  const company = project?.companies[companyIndex];

  useEffect(() => {
    void Promise.all([engineCall("roll_forward.catalog", {}), settingsGet()])
      .then(([catalog, settings]) => {
        setSubjects((catalog as { subjects?: RollSubject[] }).subjects ?? []);
        const defaults = (settings.rollForward ?? {}) as Record<
          string,
          unknown
        >;
        const cache = rollForwardInMemoryCache;
        const loaded =
          cache?.projects ??
          normalizeRollProjects(settings.rollForwardProjects);
        setProjects(loaded);
        setTemplateDir(
          cache?.templateDir ??
            String(defaults.template_dir || defaults.templateDir || ""),
        );
        setPmtePath(
          cache?.pmtePath ??
            String(defaults.pmte_path || defaults.pmtePath || ""),
        );
        const rememberLastProject = Boolean(
          defaults.remember_last_project ??
          defaults.rememberLastProject ??
          true,
        );
        const requestedProjectIndex =
          cache?.projectIndex ??
          (rememberLastProject
            ? Number(
                defaults.last_project_index ?? defaults.lastProjectIndex ?? 0,
              )
            : 0);
        const safeProjectIndex = Math.max(
          0,
          Math.min(
            Number.isFinite(requestedProjectIndex) ? requestedProjectIndex : 0,
            Math.max(loaded.length - 1, 0),
          ),
        );
        const requestedCompanyIndex =
          cache?.companyIndex ??
          (rememberLastProject
            ? Number(
                defaults.last_company_index ?? defaults.lastCompanyIndex ?? 0,
              )
            : 0);
        const safeCompanyIndex = Math.max(
          0,
          Math.min(
            Number.isFinite(requestedCompanyIndex) ? requestedCompanyIndex : 0,
            Math.max((loaded[safeProjectIndex]?.companies.length ?? 1) - 1, 0),
          ),
        );
        setProjectIndex(safeProjectIndex);
        setCompanyIndex(safeCompanyIndex);
        const loadedPreferences = {
          defaultPriorDir: String(
            defaults.default_prior_dir || defaults.defaultPriorDir || "",
          ),
          defaultOutputDir: String(
            defaults.default_output_dir || defaults.defaultOutputDir || "",
          ),
          openOutputAfterSuccess: Boolean(
            defaults.open_output_after_success ??
            defaults.openOutputAfterSuccess ??
            false,
          ),
          rememberLastProject,
        };
        setRollPreferences(loadedPreferences);
        preferencesRef.current = loadedPreferences;
        loadedRef.current = true;
        // 挂载期间到达的历史恢复排队到这里执行，避免被刚加载的项目列表覆盖。
        const pendingRestore = pendingRestoreRef.current;
        if (pendingRestore) {
          pendingRestoreRef.current = null;
          if (pendingRestore.templateDir)
            setTemplateDir(pendingRestore.templateDir);
          if (pendingRestore.pmtePath) setPmtePath(pendingRestore.pmtePath);
          setProjects([...loaded, pendingRestore.project]);
          setProjectIndex(loaded.length);
          setCompanyIndex(0);
          void saveProjects([...loaded, pendingRestore.project]);
        }
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    preferencesRef.current = rollPreferences;
  }, [rollPreferences]);
  useEffect(() => {
    if (!loadedRef.current) return;
    rollForwardInMemoryCache = {
      projects,
      templateDir,
      pmtePath,
      projectIndex,
      companyIndex,
    };
    const timer = window.setTimeout(() => {
      void saveProjects().catch((e) => setError(errorText(e)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    projects,
    templateDir,
    pmtePath,
    projectIndex,
    companyIndex,
    rollPreferences,
  ]);
  useEffect(() => {
    let off: () => void = () => {};
    void listenJobEvents((event) => {
      if (event.toolId !== "audit_roll_forward") return;
      setJob(event);
      if (event.result) setValidation(event.result);
      setBusy(!["completed", "failed", "cancelled"].includes(event.phase));
      if (["completed", "failed", "cancelled"].includes(event.phase)) {
        const target = jobCompanyRef.current;
        if (target) {
          const status =
            event.phase === "completed"
              ? "已完成"
              : event.phase === "cancelled"
                ? "已终止"
                : "部分失败";
          setProjects((current) =>
            current.map((p) =>
              p.id !== target.projectId
                ? p
                : {
                    ...p,
                    companies: p.companies.map((c) => {
                      if (target.companyId && c.id !== target.companyId)
                        return c;
                      const root = (event.result ?? {}) as Record<
                        string,
                        unknown
                      >;
                      const directRows = Array.isArray(root.results)
                        ? root.results
                        : [];
                      const companyRows = Array.isArray(root.companies)
                        ? (root.companies.find(
                            (row) =>
                              String(
                                (row as Record<string, unknown>).companyName ??
                                  "",
                              ) === c.name,
                          ) as Record<string, unknown> | undefined)
                        : undefined;
                      const rows = directRows.length
                        ? directRows
                        : Array.isArray(companyRows?.results)
                          ? companyRows.results
                          : [];
                      const generated = rows.filter((row) =>
                        Boolean((row as Record<string, unknown>).success),
                      ).length;
                      const failed = rows.length - generated;
                      return {
                        ...c,
                        status,
                        generated,
                        failed,
                        last_message: rows.length
                          ? `${generated}/${rows.length}`
                          : event.message,
                      };
                    }),
                  },
            ),
          );
          if (
            event.phase === "completed" &&
            preferencesRef.current.openOutputAfterSuccess &&
            event.outputPaths[0]
          ) {
            void openOutput(event.outputPaths[0]);
          }
        }
      }
    }).then((value) => {
      off = value;
    });
    return () => off();
  }, []);

  function updateCompany(patch: Partial<RollCompany>) {
    setProjects((current) =>
      current.map((p, pi) =>
        pi !== projectIndex
          ? p
          : {
              ...p,
              updated_at: new Date().toISOString(),
              companies: p.companies.map((c, ci) =>
                ci === companyIndex ? { ...c, ...patch } : c,
              ),
            },
      ),
    );
  }
  async function saveProjects(next = projects) {
    await settingsSet({
      rollForwardProjects: { version: 2, projects: next },
      rollForward: {
        templateDir,
        pmtePath,
        defaultPriorDir: rollPreferences.defaultPriorDir,
        defaultOutputDir: rollPreferences.defaultOutputDir,
        openOutputAfterSuccess: rollPreferences.openOutputAfterSuccess,
        rememberLastProject: rollPreferences.rememberLastProject,
        lastProjectIndex: projectIndex,
        lastCompanyIndex: companyIndex,
      },
    });
  }
  function addProject() {
    const firstCompany = {
      ...newRollCompany(),
      prior_path: rollPreferences.defaultPriorDir,
      output_dir: rollPreferences.defaultOutputDir,
    };
    const next: RollProject[] = [
      ...projects,
      {
        id: crypto.randomUUID(),
        project_name: `项目${projects.length + 1}`,
        project_year: String(new Date().getFullYear()),
        companies: [firstCompany],
      },
    ];
    setProjects(next);
    setProjectIndex(next.length - 1);
    setCompanyIndex(0);
    void saveProjects(next);
  }
  function addCompany() {
    if (!project) return;
    const next = projects.map((p, index) =>
      index === projectIndex
        ? {
            ...p,
            companies: [
              ...p.companies,
              {
                ...newRollCompany(`公司${p.companies.length + 1}`),
                prior_path: rollPreferences.defaultPriorDir,
                output_dir: rollPreferences.defaultOutputDir,
              },
            ],
          }
        : p,
    );
    setProjects(next);
    setCompanyIndex(project.companies.length);
    void saveProjects(next);
  }
  async function deleteProject() {
    if (projects.length <= 1) {
      setError("工作台中至少保留一个项目。");
      return;
    }
    if (
      !project ||
      !(await confirmDialog({
        title: "确认删除项目",
        message: `确认删除项目“${project.project_name}”及其公司配置？`,
        tone: "danger",
      }))
    )
      return;
    const next = projects.filter((_, index) => index !== projectIndex);
    setProjects(next);
    setProjectIndex(Math.max(0, Math.min(projectIndex, next.length - 1)));
    setCompanyIndex(0);
    void saveProjects(next);
  }
  async function deleteCompany() {
    if ((project?.companies.length ?? 0) <= 1) {
      setError("项目中至少保留一个公司。");
      return;
    }
    if (
      !project ||
      !company ||
      !(await confirmDialog({
        title: "确认删除公司",
        message: `确认删除公司“${company.name}”？`,
        tone: "danger",
      }))
    )
      return;
    const next = projects.map((p, index) =>
      index !== projectIndex
        ? p
        : {
            ...p,
            companies: p.companies.filter((_, ci) => ci !== companyIndex),
          },
    );
    setProjects(next);
    setCompanyIndex(
      Math.max(0, Math.min(companyIndex, project.companies.length - 2)),
    );
    void saveProjects(next);
  }
  function paramsFor(target?: RollCompany) {
    if (!target) return {};
    return {
      templateDir,
      priorDir: target.prior_path,
      pmtePath,
      outputDir: target.output_dir,
      subjectCodes: target.subjects,
      companyName: target.name,
      bsDate: target.bs_date,
      functionalCurrency: target.functional_currency,
      accountingStandard: target.accounting_standard,
      pmValue: target.pm,
      teValue: target.te,
      sadValue: target.sad,
      rollForwardWording: target.roll_wording,
      generateSummary: target.generate_summary,
      craRecords: rollForwardCraWriteRecords(
        target.cra_table_records,
        target.apply_cra,
      ),
      llmEnhanced: target.llm_enhanced,
      llmWordingRevision: target.llm_wording_revision,
    };
  }

  // 历史记录「继续任务」：把存档的公司参数逆向还原成一个新项目（不动现有
  // 项目——它们持久化在设置里，覆盖等于毁掉用户现行工作）。模板目录与
  // PMTE 路径直接回填页面；新建项目自动保存，不用了可整项删除。页面挂载时
  // 项目列表还在异步加载，恢复必须排队到加载完成之后，否则会被覆盖。
  const pendingRestoreRef = useRef<{
    project: RollProject;
    templateDir?: string;
    pmtePath?: string;
  } | null>(null);
  const applyRestoredProject = (restored: {
    project: RollProject;
    templateDir?: string;
    pmtePath?: string;
  }) => {
    if (restored.templateDir) setTemplateDir(restored.templateDir);
    if (restored.pmtePath) setPmtePath(restored.pmtePath);
    setProjects((current) => {
      const next = [...current, restored.project];
      void saveProjects(next);
      return next;
    });
    setProjectIndex(projects.length);
    setCompanyIndex(0);
    setError("");
    setValidation(undefined);
  };
  useTaskRestore(tool.id, (restore) => {
    const companyOfParams = (raw: unknown): RollCompany | undefined => {
      const p = (raw && typeof raw === "object" ? raw : {}) as Record<
        string,
        unknown
      >;
      const priorDir = typeof p.priorDir === "string" ? p.priorDir : "";
      if (!priorDir) return undefined;
      const craRecords = Array.isArray(p.craRecords)
        ? (p.craRecords as Array<Record<string, unknown>>)
        : [];
      return {
        ...newRollCompany(
          typeof p.companyName === "string" && p.companyName
            ? p.companyName
            : "恢复的公司",
        ),
        prior_path: priorDir,
        output_dir: typeof p.outputDir === "string" ? p.outputDir : "",
        subjects: Array.isArray(p.subjectCodes)
          ? p.subjectCodes.map(String)
          : [],
        bs_date: typeof p.bsDate === "string" ? p.bsDate : "",
        functional_currency:
          typeof p.functionalCurrency === "string"
            ? p.functionalCurrency
            : "人民币",
        accounting_standard:
          typeof p.accountingStandard === "string"
            ? p.accountingStandard
            : "企业会计准则",
        pm: typeof p.pmValue === "string" ? p.pmValue : "",
        te: typeof p.teValue === "string" ? p.teValue : "",
        sad: typeof p.sadValue === "string" ? p.sadValue : "",
        roll_wording: Boolean(p.rollForwardWording),
        generate_summary: p.generate_summary !== false,
        cra_table_records: craRecords,
        apply_cra: craRecords.length > 0,
        llm_enhanced: Boolean(p.llmEnhanced),
        llm_wording_revision: Boolean(p.llmWordingRevision),
      };
    };
    const single = companyOfParams(restore.params);
    const batch = Array.isArray(restore.params.companies)
      ? (restore.params.companies as unknown[])
          .map(companyOfParams)
          .filter((c): c is RollCompany => Boolean(c))
      : [];
    const companies = single ? [single] : batch;
    if (!companies.length) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const restored = {
      project: {
        id: crypto.randomUUID(),
        project_name: `恢复-${companies[0]?.name ?? "项目"}-${stamp}`,
        project_year: companies[0]?.bs_date?.slice(0, 4) ?? "",
        companies,
        updated_at: new Date().toISOString(),
      } as RollProject,
      templateDir:
        typeof restore.params.templateDir === "string" &&
        restore.params.templateDir
          ? restore.params.templateDir
          : undefined,
      pmtePath:
        typeof restore.params.pmtePath === "string" && restore.params.pmtePath
          ? restore.params.pmtePath
          : undefined,
    };
    if (loadedRef.current) applyRestoredProject(restored);
    else pendingRestoreRef.current = restored;
  });
  const params = () => paramsFor(company);
  async function validate() {
    if (!company) return;
    setError("");
    try {
      const result = await engineCall("roll_forward.validate", params());
      setValidation(result);
      await saveProjects();
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function parseCra() {
    if (!company?.cra_text.trim()) return;
    setError("");
    try {
      const result = (await engineCall("roll_forward.cra.parse", {
        text: company.cra_text,
        subjectCodes: company.subjects,
        headerPreference: company.cra_header_preference,
      })) as {
        records?: Array<Record<string, unknown>>;
        headerOptions?: string[];
      };
      setCraHeaderOptions(result.headerOptions ?? []);
      // The engine reports the per-row decision as `match_status` and never
      // emits `apply`.  Without seeding it here every row's checkbox stayed
      // unchecked next to the words "将写入", the filtered list handed to the
      // engine came back empty, and the run reported success with no CRA
      // written to the workbook at all.
      updateCompany({
        cra_table_records: (result.records ?? []).map((record) => ({
          ...record,
          apply: record.apply ?? String(record.match_status ?? "") === "将写入",
        })),
        apply_cra: Boolean(result.records?.length),
        cra_skip_confirmed: false,
      });
      setValidation(result);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function detectSubjects() {
    if (!company?.prior_path.trim()) return;
    setError("");
    try {
      const result = (await engineCall("roll_forward.detect_subjects", {
        priorPath: company.prior_path,
      })) as { subjects?: string[]; message?: string };
      updateCompany({ subjects: result.subjects ?? [] });
      setValidation(result);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function exportProject() {
    if (!project) return;
    const outputPath = await pickPath("save", "导出 WP Roll Forward 项目", [
      "auditproj",
      "json",
    ]);
    if (typeof outputPath !== "string") return;
    try {
      const result = await engineCall("roll_forward.project_export", {
        outputPath,
        project,
      });
      setValidation(result);
      await saveProjects();
    } catch (e) {
      setError(errorText(e));
    }
  }
  function updateCraRecord(index: number, patch: Record<string, unknown>) {
    updateCompany({
      cra_table_records: (company?.cra_table_records ?? []).map(
        (record, row) => (row === index ? { ...record, ...patch } : record),
      ),
    });
  }
  async function start() {
    if (!company) return;
    if (!(await ensureCraReady([company]))) return;
    setError("");
    setBusy(true);
    try {
      await saveProjects();
      const check = (await engineCall("roll_forward.validate", params())) as {
        valid?: boolean;
      };
      setValidation(check);
      if (!check.valid)
        throw new Error("运行前检查未通过，请核对下方逐科目结果。");
      const jobId = await jobStart("roll_forward.process", params());
      jobCompanyRef.current = { projectId: project.id, companyId: company.id };
      setJob({
        jobId,
        toolId: "audit_roll_forward",
        phase: "queued",
        current: 0,
        total: Math.max(company.subjects.length, 1),
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  async function startAllCompanies() {
    if (!project) return;
    if (!(await ensureCraReady(project.companies))) return;
    setError("");
    setBusy(true);
    try {
      await saveProjects();
      for (const target of project.companies) {
        const check = (await engineCall(
          "roll_forward.validate",
          paramsFor(target),
        )) as { valid?: boolean };
        if (!check.valid)
          throw new Error(`${target.name} 的运行前检查未通过。`);
      }
      const jobId = await jobStart("roll_forward.process_companies", {
        templateDir,
        pmtePath,
        companies: project.companies.map(paramsFor),
      });
      jobCompanyRef.current = { projectId: project.id };
      setJob({
        jobId,
        toolId: "audit_roll_forward",
        phase: "queued",
        current: 0,
        total: project.companies.length,
        message: "多公司任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  async function ensureCraReady(targets: RollCompany[]) {
    const unresolved = targets.filter((target) => {
      if (target.cra_skip_confirmed) return false;
      return !(target.cra_table_records.length && target.apply_cra);
    });
    if (!unresolved.length) return true;
    const detail = unresolved
      .map((target) => {
        if (target.cra_text.trim() && !target.cra_table_records.length)
          return `${target.name}：CRA 已粘贴但尚未解析`;
        if (target.cra_table_records.length && !target.apply_cra)
          return `${target.name}：CRA 已解析但未启用写入`;
        return `${target.name}：尚未提供 CRA`;
      })
      .join("\n");
    const confirmed = await confirmDialog({
      title: "执行前 CRA 确认",
      message: `${detail}\n\n确定本次不使用这些 CRA 并继续吗？`,
    });
    if (!confirmed)
      setError("已取消执行。请解析并启用 CRA，或明确选择本次不使用 CRA。");
    if (confirmed) {
      setProjects((current) =>
        current.map((p) =>
          p.id !== project?.id
            ? p
            : {
                ...p,
                companies: p.companies.map((c) =>
                  unresolved.some((row) => row.id === c.id)
                    ? { ...c, cra_skip_confirmed: true }
                    : c,
                ),
              },
        ),
      );
    }
    return confirmed;
  }
  if (!projects.length) {
    return (
      <>
        <PageHeader
          eyebrow="底稿年度结转"
          title={tool.name}
          detail="项目、公司、科目、CRA 与处理任务统一保存在工具箱中。"
        />
        <Card className="list-card" variant="section">
          <EmptyState title="还没有年度结转项目" description="先创建项目与公司，再选择上年底稿、输出位置和需要结转的科目。" />
          <div className="actions">
            <Button variant="default" onClick={addProject}>
              新建项目
            </Button>
          </div>
        </Card>
      </>
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="底稿年度结转"
        title={tool.name}
        detail="按公司选择上年底稿与科目，确认风险评估信息，检查后生成本年度底稿。"
      />
      <DataHandlingNotice
        mode={company?.llm_enhanced || company?.llm_wording_revision ? "network-assisted" : "local"}
        title="本机结转 · 智能辅助可选"
        description="项目与底稿结转在本机处理。启用智能检查或表述修订后，相关底稿内容会发送至设置中配置的 AI 服务。"
        details="请确认客户资料允许发送至该服务；生成的底稿和智能建议均需人工复核。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "项目与公司", disabled: true },
          { key: "2", label: "文件与科目", disabled: true },
          { key: "3", label: "CRA 解析与确认", disabled: true },
          { key: "4", label: "运行检查与结果", disabled: true },
        ]}
        current={job || validation !== undefined ? 3 : company?.subjects.length && company.prior_path ? 2 : company ? 1 : 0}
      />
      <ErrorBox error={error} onDismiss={() => setError("")} />
      <div className="merger-layout">
        <section className="form-card">
          <div className="section-title">
            <h2>1. 项目与公司</h2>
            <div className="actions compact-actions">
              <Button variant="secondary" onClick={addProject}>
                新建项目
              </Button>
              <Button variant="destructive" onClick={deleteProject}>
                删除项目
              </Button>
            </div>
          </div>
          <label className="field">
            <span>项目</span>
            <select
              value={projectIndex}
              onChange={(e) => {
                setProjectIndex(Number(e.target.value));
                setCompanyIndex(0);
              }}
            >
              {projects.map((p, index) => (
                <option key={p.id} value={index}>
                  {p.project_name} · {p.project_year}
                </option>
              ))}
            </select>
          </label>
          <div className="field-grid">
            <label className="field">
              <span>项目名称</span>
              <input
                value={project.project_name}
                onChange={(e) =>
                  setProjects((current) =>
                    current.map((p, index) =>
                      index === projectIndex
                        ? { ...p, project_name: e.target.value }
                        : p,
                    ),
                  )
                }
              />
            </label>
            <label className="field">
              <span>年度</span>
              <input
                value={project.project_year}
                onChange={(e) =>
                  setProjects((current) =>
                    current.map((p, index) =>
                      index === projectIndex
                        ? { ...p, project_year: e.target.value }
                        : p,
                    ),
                  )
                }
              />
            </label>
          </div>
          <label className="field">
            <span>公司</span>
            <div className="input-with-button">
              <select
                value={companyIndex}
                onChange={(e) => setCompanyIndex(Number(e.target.value))}
              >
                {project.companies.map((c, index) => (
                  <option key={c.id} value={index}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Button variant="outline" onClick={addCompany}>
                添加公司
              </Button>
              <Button variant="destructive" onClick={deleteCompany}>
                删除公司
              </Button>
            </div>
          </label>
          {company && (
            <>
              <div className="metrics roll-company-metrics">
                <div>
                  <span>已选科目</span>
                  <strong>{company.subjects.length}</strong>
                </div>
                <div>
                  <span>状态</span>
                  <strong>{company.status || "未处理"}</strong>
                </div>
                <div>
                  <span>已生成</span>
                  <strong>{company.generated ?? 0}</strong>
                </div>
                <div>
                  <span>失败</span>
                  <strong>{company.failed ?? 0}</strong>
                </div>
              </div>
              <label className="field">
                <span>公司名称</span>
                <input
                  value={company.name}
                  onChange={(e) => updateCompany({ name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>资产负债表日</span>
                <input
                  value={company.bs_date}
                  placeholder="例如：2026/12/31 或 20261231"
                  onChange={(e) => updateCompany({ bs_date: e.target.value })}
                />
              </label>
              <div className="field-grid">
                <label className="field">
                  <span>记账本位币</span>
                  <input
                    value={company.functional_currency}
                    onChange={(e) =>
                      updateCompany({ functional_currency: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>适用会计准则</span>
                  <input
                    value={company.accounting_standard}
                    onChange={(e) =>
                      updateCompany({ accounting_standard: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>PM</span>
                  <input
                    value={company.pm}
                    onChange={(e) => updateCompany({ pm: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>TE</span>
                  <input
                    value={company.te}
                    onChange={(e) => updateCompany({ te: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>SAD</span>
                  <input
                    value={company.sad}
                    onChange={(e) => updateCompany({ sad: e.target.value })}
                  />
                </label>
              </div>
            </>
          )}
        </section>
        <section className="form-card">
          <h2>2. 文件与科目</h2>
          <PathField
            label="标准模板目录"
            value={templateDir}
            onChange={setTemplateDir}
            kind="folder"
          />
          <PathField
            label="上年底稿目录或单个 XLSX / XLS"
            value={company?.prior_path ?? ""}
            onChange={(value) => updateCompany({ prior_path: value })}
            kind="folder"
            allowFile
          />
          <div className="actions">
            <Button
              variant="secondary"
              disabled={!company?.prior_path.trim()}
              onClick={() => void detectSubjects()}
            >
              从文件名自动识别科目
            </Button>
            <Button
              variant="ghost"
              onClick={() => updateCompany({ prior_path: "", subjects: [] })}
            >
              清空上年底稿
            </Button>
          </div>
          <PathField
            label="输出目录"
            value={company?.output_dir ?? ""}
            onChange={(value) => updateCompany({ output_dir: value })}
            kind="folder"
          />
          <PathField
            label="PMTE/CRA 文件（可选）"
            value={pmtePath}
            onChange={setPmtePath}
            kind="file"
          />
          <details className="roll-preferences">
            <summary>默认路径与完成行为</summary>
            <PathField
              label="新公司默认上年底稿目录"
              value={rollPreferences.defaultPriorDir}
              onChange={(value) =>
                setRollPreferences((current) => ({
                  ...current,
                  defaultPriorDir: value,
                }))
              }
              kind="folder"
            />
            <PathField
              label="新公司默认输出目录"
              value={rollPreferences.defaultOutputDir}
              onChange={(value) =>
                setRollPreferences((current) => ({
                  ...current,
                  defaultOutputDir: value,
                }))
              }
              kind="folder"
            />
            <label className="check-row">
              <SwitchInput
                checked={rollPreferences.rememberLastProject}
                onChange={(c) =>
                  setRollPreferences((current) => ({
                    ...current,
                    rememberLastProject: c,
                  }))
                }
              />
              记住最后选择的项目与公司
            </label>
            <label className="check-row">
              <SwitchInput
                checked={rollPreferences.openOutputAfterSuccess}
                onChange={(c) =>
                  setRollPreferences((current) => ({
                    ...current,
                    openOutputAfterSuccess: c,
                  }))
                }
              />
              成功后自动打开第一个输出文件
            </label>
          </details>
          <div className="checkbox-grid">
            {subjects.map((subject) => (
              <label key={subject.code} className="check-row">
                <input
                  type="checkbox"
                  checked={company?.subjects.includes(subject.code) ?? false}
                  onChange={() =>
                    updateCompany({
                      subjects: company?.subjects.includes(subject.code)
                        ? company.subjects.filter(
                            (code) => code !== subject.code,
                          )
                        : [...(company?.subjects ?? []), subject.code],
                    })
                  }
                />
                <span>
                  <strong>{subject.code}</strong> {subject.name}
                </span>
              </label>
            ))}
          </div>
          <div className="actions">
            <Button
              variant="ghost"
              onClick={() =>
                updateCompany({ subjects: subjects.map((item) => item.code) })
              }
            >
              全选科目
            </Button>
            <Button
              variant="ghost"
              onClick={() => updateCompany({ subjects: [] })}
            >
              清空科目
            </Button>
          </div>
          <label className="check-row">
            <SwitchInput
              checked={company?.roll_wording ?? false}
              onChange={(c) => updateCompany({ roll_wording: c })}
            />
            结转 wording / 分析说明 / 调整分录汇总
          </label>
          <label className="check-row">
            <SwitchInput
              checked={company?.generate_summary ?? true}
              onChange={(c) => updateCompany({ generate_summary: c })}
            />
            生成 Roll Forward Summary
          </label>
          <label className="check-row">
            <SwitchInput
              checked={company?.llm_enhanced ?? false}
              onChange={(c) => updateCompany({ llm_enhanced: c })}
            />
            启用 AI 辅助运行前检查与复核
          </label>
          <label className="check-row">
            <SwitchInput
              checked={company?.llm_wording_revision ?? false}
              onChange={(c) =>
                updateCompany({
                  llm_wording_revision: c,
                  llm_enhanced: c || company?.llm_enhanced || false,
                })
              }
            />
            允许 AI 修订已标黄的底稿表述
          </label>
          {(company?.llm_enhanced || company?.llm_wording_revision) && (
            <small className="muted-copy">
              使用工具箱“设置”中的 AI 服务配置；相关底稿内容会发送至该服务，项目数据不保存服务密钥。
            </small>
          )}
        </section>
      </div>
      <section className="form-card" style={{ marginTop: 18 }}>
        <h2>3. CRA 解析与确认</h2>
        <textarea
          rows={6}
          value={company?.cra_text ?? ""}
          placeholder={"粘贴 CRA 内容，例如：科目名称\\t认定\\tCRA\\t比例"}
          onChange={(e) =>
            updateCompany({
              cra_text: e.target.value,
              cra_table_records: [],
              apply_cra: false,
              cra_skip_confirmed: false,
            })
          }
        />
        <div className="actions">
          <Button
            variant="secondary"
            disabled={!company?.cra_text.trim()}
            onClick={() => void parseCra()}
          >
            解析 CRA
          </Button>
          <Button
            variant="ghost"
            disabled={!company?.cra_text && !company?.cra_table_records.length}
            onClick={() => {
              updateCompany({
                cra_text: "",
                cra_table_records: [],
                cra_header_preference: "",
                apply_cra: false,
                cra_skip_confirmed: false,
              });
              setCraHeaderOptions([]);
            }}
          >
            清空 CRA
          </Button>
          <label className="check-row">
            <SwitchInput
              disabled={!company?.cra_table_records.length}
              checked={company?.apply_cra ?? false}
              onChange={(c) =>
                updateCompany({
                  apply_cra: c,
                  cra_skip_confirmed: false,
                })
              }
            />
            将 {company?.cra_table_records.length ?? 0} 条确认记录写入底稿
          </label>
          <label className="check-row">
            <SwitchInput
              checked={company?.cra_skip_confirmed ?? false}
              onChange={(c) =>
                updateCompany({
                  cra_skip_confirmed: c,
                  apply_cra: c ? false : (company?.apply_cra ?? false),
                })
              }
            />
            明确本次不使用 CRA
          </label>
        </div>
        {!!craHeaderOptions.length && (
          <label className="field">
            <span>CRA 列（多公司表）</span>
            <select
              value={company?.cra_header_preference ?? ""}
              onChange={(e) =>
                updateCompany({ cra_header_preference: e.target.value })
              }
            >
              <option value="">自动识别</option>
              {craHeaderOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        )}
        {!!company?.cra_table_records.length && (
          <div className="field-grid">
            <label className="field">
              <span>搜索</span>
              <input
                value={craSearch}
                placeholder="科目、认定或备注"
                onChange={(e) => setCraSearch(e.target.value)}
              />
            </label>
            <label className="field">
              <span>底稿科目</span>
              <select
                value={craSubjectFilter}
                onChange={(e) => setCraSubjectFilter(e.target.value)}
              >
                <option value="all">全部底稿科目</option>
                {[
                  ...new Set(
                    company.cra_table_records.map((record) =>
                      String(record.subject_code ?? ""),
                    ),
                  ),
                ].map((code) => (
                  <option key={code} value={code}>
                    {code || "未匹配科目"}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>匹配状态</span>
              <select
                value={craStatusFilter}
                onChange={(e) => setCraStatusFilter(e.target.value)}
              >
                <option value="all">全部</option>
                <option value="write">将写入</option>
                <option value="confirm">需确认</option>
                <option value="skip">不写入</option>
              </select>
            </label>
            <label className="check-row">
              <SwitchInput
                checked={craExceptionOnly}
                onChange={setCraExceptionOnly}
              />
              仅看异常/需确认
            </label>
          </div>
        )}
        {!!company?.cra_table_records.length && (
          <div className="mapping-table roll-cra-scroll" tabIndex={0} role="region" aria-label="风险评估记录，可横向滚动">
            <div className="mapping-row mapping-head roll-cra-row">
              <span>写入</span>
              <span>底稿科目</span>
              <span>认定</span>
              <span>CRA / 比例</span>
            </div>
            {company.cra_table_records
              .map((record, index) => ({ record, index }))
              .filter(({ record }) => {
                const status = String(record.match_status ?? "");
                const subjectCode = String(record.subject_code ?? "");
                const ratioStatus = String(record.ratio_status ?? "");
                const rangeStatus = String(record.range_status ?? "");
                const haystack =
                  `${subjectCode} ${record.account_name ?? ""} ${record.assertion ?? ""} ${record.note ?? ""}`.toLocaleLowerCase();
                const searchOk =
                  !craSearch.trim() ||
                  haystack.includes(craSearch.trim().toLocaleLowerCase());
                const subjectOk =
                  craSubjectFilter === "all" ||
                  subjectCode === craSubjectFilter;
                const statusOk =
                  craStatusFilter === "all" ||
                  (craStatusFilter === "write" && status === "将写入") ||
                  (craStatusFilter === "confirm" &&
                    status.startsWith("需确认")) ||
                  (craStatusFilter === "skip" && status.startsWith("不写入"));
                const exceptionOk =
                  !craExceptionOnly ||
                  status !== "将写入" ||
                  rangeStatus.startsWith("超出") ||
                  ratioStatus.includes("未识别") ||
                  ratioStatus.includes("区间");
                return searchOk && subjectOk && statusOk && exceptionOk;
              })
              .map(({ record, index }) => (
                <div
                  className="mapping-row roll-cra-row"
                  key={`${String(record.subject_code)}-${index}`}
                >
                  <label className="check-row">
                    <SwitchInput
                      checked={Boolean(record.apply)}
                      onChange={(c) =>
                        updateCraRecord(index, {
                          apply: c,
                          match_status: c ? "将写入" : "不写入",
                        })
                      }
                    />
                    <span>{String(record.match_status ?? "")}</span>
                  </label>
                  <div className="input-with-button">
                    <select
                      value={String(record.subject_code ?? "")}
                      onChange={(e) =>
                        updateCraRecord(index, { subject_code: e.target.value })
                      }
                    >
                      <option value="">未匹配</option>
                      {subjects.map((subject) => (
                        <option key={subject.code} value={subject.code}>
                          {subject.code}
                        </option>
                      ))}
                    </select>
                    <input
                      value={String(record.account_name ?? "")}
                      onChange={(e) =>
                        updateCraRecord(index, { account_name: e.target.value })
                      }
                    />
                  </div>
                  <input
                    value={String(record.assertion ?? "")}
                    onChange={(e) =>
                      updateCraRecord(index, { assertion: e.target.value })
                    }
                  />
                  <div className="input-with-button">
                    <input
                      value={String(record.cra_level ?? "")}
                      onChange={(e) =>
                        updateCraRecord(index, { cra_level: e.target.value })
                      }
                    />
                    <input
                      value={String(record.ratio_text ?? record.ratio ?? "")}
                      onChange={(e) =>
                        updateCraRecord(index, {
                          ratio_text: e.target.value,
                          ratio: parseRollForwardCraRatio(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
      <section className="result-card merger-progress">
        <div className="section-title">
          <h2>4. 运行检查与结果</h2>
          <span>{company?.status}</span>
        </div>
        <div className="actions">
          <Button
            variant="secondary"
            onClick={() =>
              void saveProjects().catch((e) => setError(errorText(e)))
            }
          >
            保存项目
          </Button>
          <Button variant="secondary" onClick={() => void exportProject()}>
            导出项目
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void validate()}
          >
            运行前检查
          </Button>
          <Button
            variant="default"
            disabled={busy || !company?.subjects.length}
            onClick={() => void start()}
          >
            开始结转
          </Button>
          <Button
            variant="default"
            disabled={
              busy || project.companies.some((item) => !item.subjects.length)
            }
            onClick={() => void startAllCompanies()}
          >
            处理全部公司
          </Button>
          {job && busy && (
            <Button
              variant="secondary"
              onClick={() => togglePause(job.jobId)}
            >
              {isPaused(job.jobId) ? "继续" : "安全暂停"}
            </Button>
          )}
          {job && busy && (
            <Button
              variant="destructive"
              onClick={() => void jobCancel(job.jobId)}
            >
              取消任务
            </Button>
          )}
        </div>
        {job && (
          <>
            <JobProgress job={job} />
            {job.outputPaths.map((path) => (
              <Button
                key={path}
                variant="ghost"
                title={path}
                onClick={() => void openOutput(path)}
              >
                {displayFileName(path)}
              </Button>
            ))}
          </>
        )}
        {validation !== undefined && <RollForwardResult value={validation} />}
        {!job && validation === undefined && <EmptyState compact title="尚未运行检查" description="选择文件与科目并确认风险评估信息后，先运行检查，再开始结转。" />}
      </section>
    </>
  );
}

export function RollForwardResult({ value }: { value: unknown }) {
  const root = (value ?? {}) as Record<string, unknown>;
  const validationRows = Array.isArray(root.details)
    ? (root.details as Array<Record<string, unknown>>)
    : [];
  const directRows = Array.isArray(root.results)
    ? (root.results as Array<Record<string, unknown>>)
    : [];
  const companies = Array.isArray(root.companies)
    ? (root.companies as Array<Record<string, unknown>>)
    : [];
  if (validationRows.length) {
    return (
      <div className="roll-result-list">
        <div className={`job-banner ${root.valid ? "success" : "warning"}`}>
          <strong>{root.valid ? "运行前检查通过" : "运行前检查未通过"}</strong>
          <span>{String(root.llmMessage ?? "")}</span>
        </div>
        {validationRows.map((row) => (
          <div className="roll-result-row" key={String(row.code)}>
            <strong>
              {String(row.code)} · {String(row.name)}
            </strong>
            <span>{row.templateReady ? "模板就绪" : "缺少模板"}</span>
            <span>{row.priorReady ? "已匹配上年底稿" : "未找到上年底稿"}</span>
            <small title={String(row.priorPath ?? "")}>{displayFileName(String(row.priorPath ?? ""))}</small>
          </div>
        ))}
      </div>
    );
  }
  const rows: Array<Record<string, unknown>> = directRows.length
    ? directRows
    : companies.flatMap((company) =>
        (Array.isArray(company.results) ? company.results : []).map(
          (row): Record<string, unknown> => ({
            ...(row as Record<string, unknown>),
            companyName: company.companyName,
          }),
        ),
      );
  if (rows.length) {
    const failed = rows.filter((row) => !row.success).length;
    const warned = rows.some((row) => Array.isArray(row.warnings) && row.warnings.length > 0);
    return (
      <div className="roll-result-list">
        <div role="status">
          <Badge variant={failed || warned ? "warning" : "success"}>
            {failed ? `需处理：${failed} 项未完成` : warned ? "已生成 · 有待复核提示" : "已生成 · 请复核底稿"}
          </Badge>
          <p className="hint">{failed ? "查看下方失败原因，修正资料或配置后重试对应科目。" : "打开输出文件，核对上年来源、风险评估与标黄变更后再使用。"}</p>
        </div>
        {rows.map((row, index) => {
          // The engine reports which prior-year workbook it matched and how much
          // it rewrote. Hiding that left no way to catch a subject bound to the
          // wrong prior file, which produces a perfectly normal-looking result.
          const meta = (row.metadata ?? {}) as Record<string, unknown>;
          const diff = (meta.workbookDiff ?? {}) as Record<string, unknown>;
          const priorPath = String(meta.priorPath ?? "");
          const priorSize = Number(meta.priorSize ?? 0);
          const counters = [
            ["复制单元格", meta.copiedCells],
            ["标黄", meta.highlightedCells],
            ["CRA 写入", meta.craWriteCount],
            ["变更", diff.changedCells],
            ["公式变化", diff.formulaChanges],
          ].filter(([, value]) => typeof value === "number") as Array<
            [string, number]
          >;
          return (
            <div
              className={`roll-result-row ${row.success ? "success" : "failed"}`}
              key={`${String(row.companyName ?? "")}-${String(row.subjectCode ?? index)}`}
            >
              <strong>
                {row.companyName ? `${String(row.companyName)} · ` : ""}
                {String(row.subjectCode ?? "")}
              </strong>
              <span>{row.success ? "成功" : "失败"}</span>
              <span>{String(row.message ?? "")}</span>
              {row.outputPath ? (
                <Button
                  variant="link"
                  title={String(row.outputPath)}
                  onClick={() => void openOutput(String(row.outputPath))}
                >
                  打开输出文件
                </Button>
              ) : null}
              {priorPath ? (
                <small title={priorPath}>
                  使用上年底稿：{displayFileName(priorPath)}
                  {priorSize > 0
                    ? `（${(priorSize / 1024 / 1024).toFixed(1)} MB）`
                    : ""}
                </small>
              ) : null}
              {counters.length ? (
                <small>
                  {counters
                    .map(([label, value]) => `${label} ${value}`)
                    .join(" · ")}
                </small>
              ) : null}
              {Array.isArray(row.warnings) && row.warnings.length ? (
                <small>{row.warnings.map(String).join("；")}</small>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }
  return <ResultView value={value} />;
}

function PathField({
  label,
  value,
  onChange,
  kind,
  allowFile = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  kind: "file" | "folder";
  allowFile?: boolean;
}) {
  async function browse(target: "file" | "folder" = kind) {
    const result = await pickPath(
      target,
      label,
      target === "file" ? ["xlsx", "xls"] : [],
    );
    if (typeof result === "string") onChange(result);
  }
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-with-button">
        <Input title={value} value={value} onChange={(e) => onChange(e.target.value)} />
        <Button variant="outline" onClick={() => void browse()}>
          浏览
        </Button>
        {allowFile && (
          <Button variant="outline" onClick={() => void browse("file")}>
            单文件
          </Button>
        )}
      </div>
    </label>
  );
}
