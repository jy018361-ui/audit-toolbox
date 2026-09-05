import { useEffect, useRef, useState } from "react";
import {
  engineCall,
  jobCancel,
  jobStart,
  listenPositionedFileDrops,
  openOutput,
  pickPath,
} from "./api";
import type { ToolManifest } from "./types";
import { useTaskRestore } from "./restore";
import { errorText } from "@/lib/errors";
import { PageHeader } from "@/components/PageHeader";
import { ErrorBox } from "@/components/ErrorBox";
import { JobProgress } from "@/components/JobProgress";
import { Field } from "@/components/Field";
import { FileInput } from "@/components/FileInput";
import { FileDropInput } from "@/components/FileDropInput";
import { DataTable } from "@/components/DataTable";
import { displayFileName } from "@/fileDisplay";
import { StepIndicator } from "@/components/StepIndicator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataHandlingNotice } from "@/components/DataHandlingNotice";
import { LlmReview } from "@/components/LlmReview";
import { useJobEvents } from "@/hooks/useJobEvents";
import {
  faMappedRolesForColumn,
  faRolesForSide,
  planFaLlmChanges,
  sanitizeFaBeginMapping,
  shouldShowFaAdditionFields,
  type FaMappingChange,
  type FaPendingSuggestion,
} from "./faListUi";
import {
  POLICY_MAPPING_ROLES,
  faPolicyDefaultOutputName,
  faPolicyDefaultOutputPath,
  policyMissingOptionalRoles,
  policyMissingRoles,
} from "./faSubtoolsUi";

type PolicyMapping = Record<string, string | string[] | undefined>;
type InspectSide = {
  headers: string[];
  preview: unknown[][];
  sheets: string[];
  selectedSheet?: string;
  displayName?: string;
  detectedHeaderRow?: number;
  dimensions?: { rows: number; columns: number };
};
type PolicyInspection = {
  begin: InspectSide;
  end: InspectSide;
  suggestedMapping: { begin: PolicyMapping; end: PolicyMapping };
};
type FaLlmReview = {
  enabled: boolean;
  passed: boolean;
  failed?: boolean;
  message: string;
  detail?: string;
  autoApplied: unknown[];
  fieldReviews: unknown[];
  matchReview?: {
    action?: string;
    confidence?: number;
    reasons?: string[];
    suggested_file1_columns?: string[];
    suggested_file2_columns?: string[];
    suggestion_reason?: string;
  };
};
type PolicyDraft = {
  step: 1 | 2;
  beginPath: string;
  endPath: string;
  beginSheet: string;
  endSheet: string;
  beginHeaderRow: string;
  endHeaderRow: string;
  inspection?: PolicyInspection;
  beginKeys: string[];
  endKeys: string[];
  beginMapping: PolicyMapping;
  endMapping: PolicyMapping;
  beginDisplayName: string;
  endDisplayName: string;
  outputPath: string;
  outputPathTouched: boolean;
};

let faPolicyDraftCache: PolicyDraft | undefined;

/// 折旧政策对比：期初+期末两份清单（上传、匹配键、映射与 LLM 复核全部复用
/// FA 主工具的 fa.inspect / fa.review），导出单工作簿两页：折旧政策对比 +
/// 税法最低折旧年限参考。
export function FaPolicyComparePage({ tool }: { tool: ToolManifest }) {
  const draft = faPolicyDraftCache;
  const [step, setStep] = useState<1 | 2>(draft?.step ?? 1);
  const [beginPath, setBeginPath] = useState(draft?.beginPath ?? "");
  const [endPath, setEndPath] = useState(draft?.endPath ?? "");
  const [beginSheet, setBeginSheet] = useState(draft?.beginSheet ?? "");
  const [endSheet, setEndSheet] = useState(draft?.endSheet ?? "");
  const [beginHeaderRow, setBeginHeaderRow] = useState(
    draft?.beginHeaderRow ?? "",
  );
  const [endHeaderRow, setEndHeaderRow] = useState(draft?.endHeaderRow ?? "");
  const [inspection, setInspection] = useState<PolicyInspection | undefined>(
    draft?.inspection,
  );
  const [beginKeys, setBeginKeys] = useState<string[]>(draft?.beginKeys ?? []);
  const [endKeys, setEndKeys] = useState<string[]>(draft?.endKeys ?? []);
  const [beginMapping, setBeginMapping] = useState<PolicyMapping>(
    draft?.beginMapping ?? {},
  );
  const [endMapping, setEndMapping] = useState<PolicyMapping>(
    draft?.endMapping ?? {},
  );
  const [beginDisplayName, setBeginDisplayName] = useState(
    draft?.beginDisplayName ?? "期初",
  );
  const [endDisplayName, setEndDisplayName] = useState(
    draft?.endDisplayName ?? "期末",
  );
  const [outputPath, setOutputPath] = useState(draft?.outputPath ?? "");
  const [outputPathTouched, setOutputPathTouched] = useState(
    draft?.outputPathTouched ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmReview, setLlmReview] = useState<FaLlmReview>();
  const [llmChanges, setLlmChanges] = useState<FaMappingChange[]>([]);
  const [llmPending, setLlmPending] = useState<FaPendingSuggestion[]>([]);
  const [error, setError] = useState("");
  const reviewGeneration = useRef(0);
  const stateRef = useRef({ beginMapping, endMapping, beginKeys, endKeys });
  stateRef.current = { beginMapping, endMapping, beginKeys, endKeys };
  const { job, setJob } = useJobEvents({
    toolId: "fa_policy_compare",
    onEvent: (event) => {
      setBusy(!["completed", "failed", "cancelled"].includes(event.phase));
      if (event.phase === "failed") setError(event.message);
    },
  });
  // 双槽拖放：期初/期末两个上传框分别命中（落点坐标已换算成 CSS 像素）。
  const beginDropRef = useRef<HTMLDivElement>(null);
  const endDropRef = useRef<HTMLDivElement>(null);
  const [dragHover, setDragHover] = useState<"begin" | "end" | null>(null);
  const applyPathRef = useRef<(side: "begin" | "end", value: string) => void>(
    () => {},
  );
  applyPathRef.current = (side, value) => {
    // 换源时先废止仍在途的 LLM 复核，旧请求不得回写新文件。
    reviewGeneration.current += 1;
    setLlmBusy(false);
    if (side === "begin") {
      setBeginPath(value);
      setBeginSheet("");
      setBeginHeaderRow("");
    } else {
      setOutputPathTouched(false);
      setEndPath(value);
      setEndSheet("");
      setEndHeaderRow("");
    }
    setInspection(undefined);
    setBeginKeys([]);
    setEndKeys([]);
    setBeginMapping({});
    setEndMapping({});
    setLlmReview(undefined);
    setLlmChanges([]);
    setLlmPending([]);
    setError("");
    setJob(undefined);
    setStep(1);
    const nextBegin = side === "begin" ? value : beginPath;
    const nextEnd = side === "end" ? value : endPath;
    if (nextBegin && nextEnd)
      void inspect({ beginPath: nextBegin, endPath: nextEnd });
  };
  useEffect(() => {
    const inTauriEnv =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!inTauriEnv) return () => undefined;
    const stop = listenPositionedFileDrops((drop) => {
      if (!drop.paths.length) return;
      const hit = (ref: React.RefObject<HTMLDivElement | null>) => {
        const rect = ref.current?.getBoundingClientRect();
        return (
          rect &&
          drop.x >= rect.left &&
          drop.x <= rect.right &&
          drop.y >= rect.top &&
          drop.y <= rect.bottom
        );
      };
      setDragHover(null);
      if (hit(beginDropRef)) applyPathRef.current("begin", drop.paths[0]);
      else if (hit(endDropRef)) applyPathRef.current("end", drop.paths[0]);
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);
  useEffect(() => {
    faPolicyDraftCache = {
      step,
      beginPath,
      endPath,
      beginSheet,
      endSheet,
      beginHeaderRow,
      endHeaderRow,
      inspection,
      beginKeys,
      endKeys,
      beginMapping,
      endMapping,
      beginDisplayName,
      endDisplayName,
      outputPath,
      outputPathTouched,
    };
  });
  useEffect(() => {
    if (outputPathTouched) return;
    setOutputPath(endPath ? faPolicyDefaultOutputPath(endPath) : "");
  }, [endPath, outputPathTouched]);

  // 历史记录「继续任务」：回填期初/期末文件与全部配置（含匹配键与映射），
  // 不自动重新读取——重新读取同一对文件时用存档映射/匹配键顶回建议值
  // （见 inspect），换文件照旧。
  const restoredPolicyRef = useRef<{
    beginPath: string;
    endPath: string;
    beginMapping: PolicyMapping;
    endMapping: PolicyMapping;
    beginKeys: string[];
    endKeys: string[];
  } | null>(null);
  useTaskRestore(tool.id, (restore) => {
    const p = restore.params as {
      beginPath?: string;
      endPath?: string;
      beginSheet?: string;
      endSheet?: string;
      beginHeaderRow?: number;
      endHeaderRow?: number;
      beginKeys?: string[];
      endKeys?: string[];
      beginMapping?: PolicyMapping;
      endMapping?: PolicyMapping;
      beginDisplayName?: string;
      endDisplayName?: string;
      outputPath?: string;
    };
    if (typeof p.beginPath !== "string" || !p.beginPath) return;
    if (typeof p.endPath !== "string" || !p.endPath) return;
    const isMapping = (value: unknown): value is PolicyMapping =>
      Boolean(value && typeof value === "object");
    restoredPolicyRef.current =
      isMapping(p.beginMapping) && isMapping(p.endMapping)
        ? {
            beginPath: p.beginPath,
            endPath: p.endPath,
            beginMapping: p.beginMapping,
            endMapping: p.endMapping,
            beginKeys: Array.isArray(p.beginKeys) ? p.beginKeys : [],
            endKeys: Array.isArray(p.endKeys) ? p.endKeys : [],
          }
        : null;
    reviewGeneration.current += 1;
    setStep(2);
    setBeginPath(p.beginPath);
    setEndPath(p.endPath);
    setBeginSheet(p.beginSheet ?? "");
    setEndSheet(p.endSheet ?? "");
    setBeginHeaderRow(p.beginHeaderRow != null ? String(p.beginHeaderRow) : "");
    setEndHeaderRow(p.endHeaderRow != null ? String(p.endHeaderRow) : "");
    setInspection(undefined);
    setBeginKeys(Array.isArray(p.beginKeys) ? p.beginKeys : []);
    setEndKeys(Array.isArray(p.endKeys) ? p.endKeys : []);
    setBeginMapping(
      p.beginMapping && typeof p.beginMapping === "object"
        ? p.beginMapping
        : {},
    );
    setEndMapping(
      p.endMapping && typeof p.endMapping === "object" ? p.endMapping : {},
    );
    if (typeof p.beginDisplayName === "string" && p.beginDisplayName)
      setBeginDisplayName(p.beginDisplayName);
    if (typeof p.endDisplayName === "string" && p.endDisplayName)
      setEndDisplayName(p.endDisplayName);
    if (typeof p.outputPath === "string" && p.outputPath) {
      setOutputPath(p.outputPath);
      setOutputPathTouched(true);
    }
    setLlmReview(undefined);
    setLlmChanges([]);
    setLlmPending([]);
    setError("");
    setJob(undefined);
  });

  /// 两表检查直接复用 fa.inspect；建议映射裁剪到政策四要素 + 匹配键。
  async function inspect(overrides?: { beginPath?: string; endPath?: string }) {
    const bPath = overrides?.beginPath ?? beginPath;
    const ePath = overrides?.endPath ?? endPath;
    if (!bPath || !ePath) {
      setError("请选择期初和期末文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const value = (await engineCall("fa.inspect", {
        beginPath: bPath,
        endPath: ePath,
        beginSheet: beginSheet || undefined,
        endSheet: endSheet || undefined,
        beginHeaderRow: Number(beginHeaderRow) || undefined,
        endHeaderRow: Number(endHeaderRow) || undefined,
      })) as PolicyInspection;
      setInspection(value);
      setBeginSheet(value.begin.selectedSheet ?? beginSheet);
      setEndSheet(value.end.selectedSheet ?? endSheet);
      setBeginHeaderRow(String(value.begin.detectedHeaderRow ?? ""));
      setEndHeaderRow(String(value.end.detectedHeaderRow ?? ""));
      const trim = (mapping: PolicyMapping): PolicyMapping => {
        const next: PolicyMapping = {};
        for (const [key] of POLICY_MAPPING_ROLES) {
          next[key] = mapping[key];
        }
        return next;
      };
      // 期初建议与 FA 主工具同口径：文件2专属角色（本年折旧/新增方式/新增日期）
      // 不进入期初映射。
      const suggestedBegin = sanitizeFaBeginMapping(
        trim(value.suggestedMapping.begin ?? {}),
      ) as PolicyMapping;
      const suggestedEnd = trim(value.suggestedMapping.end ?? {});
      const asKeys = (value: string | string[] | undefined): string[] =>
        Array.isArray(value) ? value : [];
      const suggestedBeginKeys = asKeys(
        value.suggestedMapping.begin?.matchKeys,
      );
      const suggestedEndKeys = asKeys(value.suggestedMapping.end?.matchKeys);
      // 历史恢复后重新读取同一对文件：存档映射/匹配键顶回建议值（一次性
      // 消费，换文件照旧），且不再自动送 LLM 复核——那份映射已确认过。
      const stash = restoredPolicyRef.current;
      const samePath = (a: string, b: string) =>
        a.trim().toLowerCase() === b.trim().toLowerCase();
      const match =
        stash &&
        samePath(stash.beginPath, bPath) &&
        samePath(stash.endPath, ePath)
          ? stash
          : undefined;
      if (match) restoredPolicyRef.current = null;
      setBeginMapping(match ? match.beginMapping : suggestedBegin);
      setEndMapping(match ? match.endMapping : suggestedEnd);
      setBeginKeys(match ? match.beginKeys : suggestedBeginKeys);
      setEndKeys(match ? match.endKeys : suggestedEndKeys);
      setLlmChanges([]);
      setLlmPending([]);
      if (match) return;
      void review({
        beginPath: bPath,
        endPath: ePath,
        beginSheet: value.begin.selectedSheet,
        endSheet: value.end.selectedSheet,
        beginHeaderRow: value.begin.detectedHeaderRow,
        endHeaderRow: value.end.detectedHeaderRow,
        beginMapping: suggestedBegin,
        endMapping: suggestedEnd,
        beginKeys: suggestedBeginKeys,
        endKeys: suggestedEndKeys,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  /// LLM 复核复用 fa.review（两表场景），规划器沿用主工具 planFaLlmChanges；
  /// 失败不阻塞。beginPath/endPath 覆盖值与主工具同因：inspect 刚选完文件时
  /// 状态尚未提交，闭包里还是旧值（首次为空），不传就会静默跳过复核。
  async function review(
    override: Partial<{
      beginPath: string;
      endPath: string;
      beginSheet: string;
      endSheet: string;
      beginHeaderRow: number;
      endHeaderRow: number;
      beginMapping: PolicyMapping;
      endMapping: PolicyMapping;
      beginKeys: string[];
      endKeys: string[];
    }> = {},
  ) {
    const bPath = override.beginPath ?? beginPath;
    const ePath = override.endPath ?? endPath;
    if (!bPath || !ePath) return;
    const generation = ++reviewGeneration.current;
    setLlmBusy(true);
    setLlmChanges([]);
    setLlmPending([]);
    try {
      const value = (await engineCall("fa.review", {
        beginPath: bPath,
        endPath: ePath,
        beginSheet: override.beginSheet ?? beginSheet,
        endSheet: override.endSheet ?? endSheet,
        beginHeaderRow:
          override.beginHeaderRow ?? (Number(beginHeaderRow) || 1),
        endHeaderRow: override.endHeaderRow ?? (Number(endHeaderRow) || 1),
        beginMapping: sanitizeFaBeginMapping(
          override.beginMapping ?? beginMapping,
        ),
        endMapping: override.endMapping ?? endMapping,
        beginKeys: override.beginKeys ?? beginKeys,
        endKeys: override.endKeys ?? endKeys,
      })) as FaLlmReview;
      if (generation !== reviewGeneration.current) return;
      setLlmReview(value);
      const plan = planFaLlmChanges({
        beginMapping: sanitizeFaBeginMapping(
          override.beginMapping ?? stateRef.current.beginMapping,
        ) as PolicyMapping,
        endMapping: override.endMapping ?? stateRef.current.endMapping,
        beginKeys: override.beginKeys ?? stateRef.current.beginKeys,
        endKeys: override.endKeys ?? stateRef.current.endKeys,
        autoApplied: value.autoApplied as never,
        fieldReviews: value.fieldReviews as never,
        matchReview: value.matchReview,
        roleLabels: Object.fromEntries([
          ...POLICY_MAPPING_ROLES,
          ["matchKeys", "组合匹配键"],
        ]),
      });
      setBeginMapping({ ...plan.beginMapping, matchKeys: plan.beginKeys });
      setEndMapping({ ...plan.endMapping, matchKeys: plan.endKeys });
      setBeginKeys(plan.beginKeys);
      setEndKeys(plan.endKeys);
      setLlmChanges(plan.changes);
      setLlmPending(plan.pending);
    } catch (e) {
      if (generation !== reviewGeneration.current) return;
      const detail =
        e && typeof e === "object"
          ? String((e as Record<string, unknown>).detail ?? "")
          : "";
      setLlmReview({
        enabled: true,
        passed: false,
        failed: true,
        message: `${errorText(e).replace(/[。.]+$/, "")}。字段映射本身没有问题，脚本自动映射已完成，可直接核对后继续；LLM 复核只是可选的辅助检查。`,
        detail,
        autoApplied: [],
        fieldReviews: [],
      });
    } finally {
      if (generation === reviewGeneration.current) setLlmBusy(false);
    }
  }

  function acceptPending(item: FaPendingSuggestion) {
    const apply = item.apply;
    if (apply.kind === "matchKeys") {
      setLlmChanges((current) => [
        ...current,
        {
          id: item.id,
          label: item.label,
          before: item.current,
          after: item.suggested,
          reason: item.reason,
          confidence: item.confidence,
          attention: true,
          restore: {
            kind: "matchKeys",
            begin: stateRef.current.beginKeys,
            end: stateRef.current.endKeys,
          },
        },
      ]);
      setBeginKeys(apply.begin);
      setEndKeys(apply.end);
      setBeginMapping((current) => ({ ...current, matchKeys: apply.begin }));
      setEndMapping((current) => ({ ...current, matchKeys: apply.end }));
    } else if (apply.kind === "mapping") {
      const before =
        apply.side === "begin"
          ? stateRef.current.beginMapping[apply.key]
          : stateRef.current.endMapping[apply.key];
      setLlmChanges((current) => [
        ...current,
        {
          id: item.id,
          label: item.label,
          before: item.current,
          after: item.suggested,
          reason: item.reason,
          confidence: item.confidence,
          attention: true,
          restore: {
            kind: "mapping",
            side: apply.side,
            key: apply.key,
            value: typeof before === "string" ? before : undefined,
          },
        },
      ]);
      const update = (current: PolicyMapping): PolicyMapping => ({
        ...current,
        [apply.key]: apply.value ?? "",
      });
      if (apply.side === "begin") setBeginMapping(update);
      else setEndMapping(update);
    }
    setLlmPending((current) => current.filter((value) => value.id !== item.id));
  }

  function undoChange(change: FaMappingChange) {
    // 先把联合类型收进 const，回调闭包里才能保留类型收窄。
    const restore = change.restore;
    if (restore.kind === "matchKeys") {
      const { begin, end } = restore;
      setBeginKeys(begin);
      setEndKeys(end);
      setBeginMapping((current) => ({ ...current, matchKeys: begin }));
      setEndMapping((current) => ({ ...current, matchKeys: end }));
    } else {
      const key = restore.key;
      const value = restore.value ?? "";
      const update = (current: PolicyMapping): PolicyMapping => ({
        ...current,
        [key]: value,
      });
      if (restore.side === "begin") setBeginMapping(update);
      else setEndMapping(update);
    }
    setLlmChanges((current) => current.filter((item) => item.id !== change.id));
  }

  /// 设置映射。matchKeys 是数组角色，同时写映射对象与影子 keys 状态
  /// （Rust payload 契约读 beginKeys/endKeys）。
  function setMapping(
    side: "begin" | "end",
    key: string,
    value: string | string[],
  ) {
    if (side === "begin") {
      setBeginMapping((current) => ({ ...current, [key]: value || undefined }));
      if (key === "matchKeys") setBeginKeys(Array.isArray(value) ? value : []);
    } else {
      setEndMapping((current) => ({ ...current, [key]: value || undefined }));
      if (key === "matchKeys") setEndKeys(Array.isArray(value) ? value : []);
    }
  }

  /// 组合匹配键的选择（多选）。
  function toggleKey(side: "begin" | "end", column: string) {
    const keys = side === "begin" ? beginKeys : endKeys;
    const next = keys.includes(column)
      ? keys.filter((value) => value !== column)
      : [...keys, column];
    setMapping(side, "matchKeys", next);
  }

  async function choose(side: "begin" | "end") {
    const value = await pickPath(
      "file",
      side === "begin" ? "选择期初固定资产清单" : "选择期末固定资产清单",
      ["xlsx", "xls", "xlsm", "csv", "txt"],
    );
    if (typeof value === "string") applyPathRef.current(side, value);
  }

  async function chooseOutput() {
    const value = await pickPath(
      "save",
      "保存折旧政策对比",
      ["xlsx"],
      faPolicyDefaultOutputName(),
    );
    if (typeof value === "string") {
      setOutputPath(value);
      setOutputPathTouched(true);
    }
  }

  const missingRoles = (side: "begin" | "end"): string[] =>
    policyMissingRoles(side === "begin" ? beginMapping : endMapping);
  const optionalMissing = (side: "begin" | "end"): string[] =>
    policyMissingOptionalRoles(
      side,
      side === "begin" ? beginMapping : endMapping,
    );
  const readyToExport =
    Boolean(inspection) &&
    beginKeys.length > 0 &&
    beginKeys.length === endKeys.length &&
    missingRoles("begin").length === 0 &&
    missingRoles("end").length === 0;

  async function startExport() {
    if (!beginPath || !endPath) {
      setError("请选择期初和期末文件。");
      return;
    }
    if (!beginKeys.length || beginKeys.length !== endKeys.length) {
      setError("期初和期末必须选择数量相同的匹配列。");
      return;
    }
    if (missingRoles("begin").length || missingRoles("end").length) {
      setError("还有必填字段未映射，请在预览表头下拉中补全。");
      return;
    }
    let target = outputPath;
    if (!outputPathTouched) {
      target = faPolicyDefaultOutputPath(endPath);
      if (target) setOutputPath(target);
    }
    if (!target.trim()) {
      const picked = await pickPath(
        "save",
        "保存折旧政策对比",
        ["xlsx"],
        faPolicyDefaultOutputName(),
      );
      if (typeof picked !== "string" || !picked.trim()) return;
      target = picked;
      setOutputPath(picked);
      setOutputPathTouched(true);
    }
    setBusy(true);
    setError("");
    setJob(undefined);
    try {
      const jobId = await jobStart("fa.policy_export", {
        beginPath,
        endPath,
        beginSheet: beginSheet || undefined,
        endSheet: endSheet || undefined,
        beginHeaderRow: Number(beginHeaderRow) || 1,
        endHeaderRow: Number(endHeaderRow) || 1,
        beginKeys,
        endKeys,
        beginMapping,
        endMapping,
        beginDisplayName,
        endDisplayName,
        outputPath: target,
      });
      setJob({
        jobId,
        toolId: "fa_policy_compare",
        phase: "queued",
        current: 0,
        total: 1,
        message: "任务已进入队列",
        severity: "info",
        outputPaths: [],
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const sidePanel = (
    side: "begin" | "end",
    inspect: InspectSide,
    keys: string[],
    mapping: PolicyMapping,
  ) => {
    const headers = inspect.headers;
    // 与 FA 主工具同构：新增方式/新增日期仅在期末已识别新增方式列时出现；
    // 期初不出现文件2专属角色（本年折旧/新增方式/新增日期）。
    const visibleRoles = POLICY_MAPPING_ROLES.filter(
      ([key]) =>
        !["additionMethod", "additionDate"].includes(key) ||
        shouldShowFaAdditionFields(String(endMapping.additionMethod ?? "")),
    );
    const roleOptions: [string, string][] = [
      ["matchKeys", "组合匹配键"],
      ...faRolesForSide(side, visibleRoles),
    ];
    // 已被某列占用的角色集合（跨列感知，用于标记"已用"）
    const usedRoles = new Set<string>();
    for (const header of headers) {
      const colValue = header.trim();
      for (const [key] of roleOptions) {
        const current = mapping[key];
        const occupied = Array.isArray(current)
          ? current.includes(colValue)
          : String(current ?? "") === colValue;
        if (occupied) usedRoles.add(key);
      }
    }
    const controls = headers.map((header) => {
      const column = header.trim();
      // 同一列可以同时承担组合匹配键、资产名称等多个角色，保留全部关系合并展示。
      const mapped = faMappedRolesForColumn(column, roleOptions, mapping);
      const multipleValue = `__multiple__:${column}`;
      return (
        <label className="dt-header-control" key={header}>
          <select
            className={mapped.length ? "mapped" : undefined}
            disabled={llmBusy}
            title={mapped.map(([, label]) => label).join(" + ") || "未映射"}
            value={mapped.length > 1 ? multipleValue : (mapped[0]?.[0] ?? "")}
            onChange={(e) => {
              const role = e.target.value;
              // 先清掉本列占用的旧角色
              for (const [key] of roleOptions) {
                const current = mapping[key];
                if (Array.isArray(current) && current.includes(column)) {
                  setMapping(
                    side,
                    key,
                    current.filter((value) => value !== column),
                  );
                } else if (String(current ?? "") === column) {
                  setMapping(side, key, "");
                }
              }
              if (role === "matchKeys") {
                if (!keys.includes(column)) toggleKey(side, column);
              } else if (role && !role.startsWith("__multiple__:")) {
                setMapping(side, role, column);
              }
            }}
          >
            <option value="">—</option>
            {mapped.length > 1 && (
              <option value={multipleValue} disabled>
                {mapped.map(([, label]) => label).join(" + ")}
              </option>
            )}
            {roleOptions.map(([key, label]) => {
              const mappedHere = mapped.some(
                ([mappedKey]) => mappedKey === key,
              );
              const takenByOther = usedRoles.has(key) && !mappedHere;
              return (
                <option
                  key={key}
                  value={key}
                  className={takenByOther ? "dt-role-taken" : undefined}
                >
                  {label}
                  {takenByOther ? "（已用）" : ""}
                </option>
              );
            })}
          </select>
        </label>
      );
    });
    const missing = missingRoles(side);
    const optional = optionalMissing(side);
    return (
      <DataTable
        columns={headers}
        rows={inspect.preview}
        caption={
          <div className="fa-table-caption">
            <strong>
              {side === "begin" ? "期初" : "期末"} ·{" "}
              {inspect.displayName ?? inspect.selectedSheet ?? "数据预览"} ·{" "}
              {inspect.dimensions?.rows ?? 0} 行 ×{" "}
              {inspect.dimensions?.columns ?? 0} 列
            </strong>
            {missing.length > 0 && (
              <span className="fa-caption-missing">
                尚未映射：{missing.join("、")}
              </span>
            )}
            {optional.length > 0 && (
              <span
                className="fa-caption-optional"
                title="选填字段，留空不拦截导出，只是对应要素不参与政策对比测算，建议尽量映射。"
              >
                选填未映射：{optional.join("、")}
              </span>
            )}
          </div>
        }
        maxHeight={430}
        headerControls={controls}
      />
    );
  };

  const outputPaths =
    job?.phase === "completed" && Array.isArray(job.outputPaths)
      ? job.outputPaths
      : [];

  return (
    <>
      <PageHeader
        eyebrow="固定资产折旧政策对比"
        title={tool.name}
        detail="匹配期初与期末固定资产清单，对比两期折旧政策（类别、寿命、残值率）并测算影响，同时附税法最低折旧年限参考。"
      />
      <DataHandlingNotice
        mode="network-assisted"
        title="文件处理与智能复核"
        description="两期清单读取、政策比较和底稿生成在本机完成；使用 LLM 复核时，复核所需信息会按设置发送到对应服务。"
      />
      <StepIndicator
        steps={[
          { key: "1", label: "文件与匹配" },
          { key: "2", label: "导出" },
        ]}
        current={step - 1}
        onStepClick={(index) => setStep((index + 1) as 1 | 2)}
      />
      <div className="fa-stack">
        <Card variant="section">
          <CardHeader>
            <CardTitle>
              {step === 1 ? "1. 选择文件并配置" : "2. 保存并导出"}
            </CardTitle>
            <Badge variant={busy ? "info" : inspection ? "success" : "neutral"}>
              {busy ? "处理中" : inspection ? "已读取" : "等待文件"}
            </Badge>
          </CardHeader>
          <CardContent>
            <ErrorBox error={error} onDismiss={() => setError("")} />
            {job && job.phase !== "completed" && (
              <JobProgress
                job={job}
                onCancel={(jobId) => {
                  void jobCancel(jobId);
                  setBusy(false);
                }}
                cancelLabel="取消任务"
              />
            )}
            {step === 1 && (
              <>
                <div className="fa-sides">
                  {(["begin", "end"] as const).map((side) => (
                    <div className={`fa-side fa-side-${side}`} key={side}>
                      <h3 className="fa-side-title">
                        {side === "begin" ? "期初（年初）" : "期末（年末）"}
                      </h3>
                      <Field
                        label={side === "begin" ? "年初文件" : "年末文件"}
                        required
                      >
                        <div ref={side === "begin" ? beginDropRef : endDropRef}>
                          <FileDropInput
                            value={side === "begin" ? beginPath : endPath}
                            placeholder={
                              side === "begin"
                                ? "拖放或点击选择年初清单"
                                : "拖放或点击选择年末清单"
                            }
                            onBrowse={() => void choose(side)}
                            onDragStateChange={(active) =>
                              setDragHover(active ? side : null)
                            }
                            highlight={dragHover === side}
                            disabled={busy}
                            onClear={
                              (side === "begin" ? beginPath : endPath) && !busy
                                ? () => applyPathRef.current(side, "")
                                : undefined
                            }
                          />
                        </div>
                      </Field>
                      <Field label="Sheet">
                        {inspection?.[side].sheets.length ? (
                          <select
                            value={side === "begin" ? beginSheet : endSheet}
                            disabled={busy}
                            onChange={(e) => {
                              if (side === "begin")
                                setBeginSheet(e.target.value);
                              else setEndSheet(e.target.value);
                              if (side === "begin") setBeginHeaderRow("");
                              else setEndHeaderRow("");
                            }}
                          >
                            {inspection[side].sheets.map((value) => (
                              <option key={value}>{value}</option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            value={side === "begin" ? beginSheet : endSheet}
                            disabled={busy}
                            onChange={(e) => {
                              if (side === "begin")
                                setBeginSheet(e.target.value);
                              else setEndSheet(e.target.value);
                            }}
                          />
                        )}
                      </Field>
                      <Field label="标题行（留空自动识别）">
                        <Input
                          value={
                            side === "begin" ? beginHeaderRow : endHeaderRow
                          }
                          placeholder="自动"
                          disabled={busy}
                          onChange={(e) => {
                            if (side === "begin")
                              setBeginHeaderRow(e.target.value);
                            else setEndHeaderRow(e.target.value);
                          }}
                          onBlur={() => {
                            if (beginPath && endPath) void inspect();
                          }}
                        />
                      </Field>
                    </div>
                  ))}
                </div>
                <div className="actions fa-flow-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || !beginPath || !endPath}
                    onClick={() => void inspect()}
                  >
                    {busy ? "正在读取表格…" : "读取表格 + LLM 复核"}
                  </Button>
                  {inspection && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || llmBusy}
                      onClick={() => void review()}
                    >
                      {llmBusy ? "LLM 正在复核…" : "LLM 重新复核"}
                    </Button>
                  )}
                  <Button
                    variant="default"
                    disabled={!readyToExport}
                    onClick={() => setStep(2)}
                  >
                    下一步
                  </Button>
                </div>
                {(llmBusy || llmReview) && (
                  <LlmReview
                    title="LLM 映射复核"
                    busy={llmBusy}
                    passed={llmReview?.passed}
                    enabled={llmReview?.enabled}
                    failed={llmReview?.failed}
                    message={
                      llmReview && !llmBusy ? llmReview.message : undefined
                    }
                    detail={llmReview?.detail}
                    changes={llmChanges}
                    pending={llmPending}
                    onUndo={(change) => undoChange(change as FaMappingChange)}
                    onAccept={(item) =>
                      acceptPending(item as FaPendingSuggestion)
                    }
                    onKeep={(item) =>
                      setLlmPending((current) =>
                        current.filter((value) => value.id !== item.id),
                      )
                    }
                    onSkip={() => {
                      reviewGeneration.current += 1;
                      setLlmBusy(false);
                      setLlmReview((current) =>
                        current
                          ? {
                              ...current,
                              failed: false,
                              passed: true,
                              message:
                                "已按用户选择跳过本次 LLM 复核，保留当前字段和匹配 ID。",
                            }
                          : current,
                      );
                    }}
                  />
                )}
              </>
            )}
            {step === 2 && (
              <>
                <div className="form-grid">
                  <Field label="期初显示名称">
                    <Input
                      value={beginDisplayName}
                      onChange={(e) => setBeginDisplayName(e.target.value)}
                    />
                  </Field>
                  <Field label="期末显示名称">
                    <Input
                      value={endDisplayName}
                      onChange={(e) => setEndDisplayName(e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="输出文件">
                  <FileInput
                    value={outputPath}
                    placeholder="选择期末文件后自动填入默认保存位置"
                    onBrowse={() => void chooseOutput()}
                    onClear={
                      outputPathTouched
                        ? () => {
                            setOutputPathTouched(false);
                            setOutputPath(
                              endPath ? faPolicyDefaultOutputPath(endPath) : "",
                            );
                          }
                        : undefined
                    }
                    browseLabel="选择"
                    clearLabel="恢复默认"
                  />
                </Field>
                <p className="hint">
                  导出为一个 Excel：第 1
                  页折旧政策对比（类别/寿命/残值率两期对比、
                  判断结果与影响金额），第 2 页税法最低折旧年限参考。
                </p>
                <div className="actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setStep(1)}
                  >
                    返回上一步
                  </Button>
                  {busy && job ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void jobCancel(job.jobId)}
                    >
                      停止
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      disabled={!readyToExport}
                      onClick={() => void startExport()}
                    >
                      生成折旧政策对比
                    </Button>
                  )}
                </div>
              </>
            )}
            {!!outputPaths.length && (
              <div className="fa-result-summary">
                <strong>折旧政策对比已生成</strong>
                {outputPaths.map((output) => (
                  <Button
                    key={output}
                    variant="default"
                    onClick={() => void openOutput(output)}
                  >
                    打开结果：{displayFileName(output)}
                  </Button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        {step === 1 ? (
          <aside className="fa-preview-workspace" aria-label="文件预览工作区">
            <div className="fa-preview-workspace-title">
              <div>
                <h2>文件预览</h2>
                <p>预览区已锁定；各文件可独立纵向、横向滚动。</p>
              </div>
              <Badge variant="info">导入文件</Badge>
            </div>
            <div className="fa-preview-stack">
              {inspection ? (
                <>
                  {sidePanel(
                    "begin",
                    inspection.begin,
                    beginKeys,
                    beginMapping,
                  )}
                  {sidePanel("end", inspection.end, endKeys, endMapping)}
                </>
              ) : (
                <>
                  <section className="fa-preview fa-preview-empty-card">
                    <header>期初文件预览</header>
                    <EmptyState compact title="等待结果" description="选择期初文件并读取结构后，在此显示表格内容。" />
                  </section>
                  <section className="fa-preview fa-preview-empty-card">
                    <header>期末文件预览</header>
                    <EmptyState compact title="等待结果" description="选择期末文件并读取结构后，在此显示表格内容。" />
                  </section>
                </>
              )}
            </div>
          </aside>
        ) : (
          <Card variant="workspace" className="fa-result-workspace">
            <CardHeader>
              <CardTitle>导出结果</CardTitle>
            </CardHeader>
            <CardContent>
              {job && (
                <JobProgress
                  job={job}
                  onCancel={(jobId) => {
                    void jobCancel(jobId);
                    setBusy(false);
                  }}
                  cancelLabel="取消任务"
                />
              )}
              {!outputPaths.length && (
                <EmptyState compact title="等待结果" description="确认期初、期末映射无误后点击「生成折旧政策对比」。" />
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
