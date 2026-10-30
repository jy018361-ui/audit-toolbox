import { useEffect, useRef, useState } from "react";
import { pickPath } from "../api";
import { errorText } from "@/lib/errors";
import { PageHeader } from "@/components/PageHeader";
import type { ToolManifest } from "../types";

import { DataflowCanvas, type DataflowSelection, type NodeRunStatus } from "./Canvas";
import { ConfigPanel } from "./ConfigPanel";
import { ParamsDialog } from "./ParamsDialog";
import { ResultsPanel } from "./ResultsPanel";
import { DataflowToolbar } from "./Toolbar";
import {
  DataflowRunResultSchema,
  WorkflowHistory,
  createEmptyWorkflow,
  defaultConfigFor,
  defaultNodeName,
  incompleteFilterRule,
  loadOutputDir,
  resolveOutputPaths,
  saveOutputDir,
  listDrafts,
  nextNodeId,
  parseWorkflowFile,
  removeDraft,
  repairWorkflowEdges,
  saveDraft,
  validateNewEdge,
  type DataflowEdge,
  type DataflowRunResult,
  type FilterRuleConfig,
  type DataflowWorkflow,
} from "./model";
import { pickWorkflowFile, saveWorkflowFile, type SaveWorkflowOutcome } from "./workflowFile";
import { dataflowPreview, dataflowRun } from "../api";
import "./dataflow.css";

function timeNow(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 数据流 DataFlow 工作区：顶部分类工具栏＋画布＋左侧配置区＋底部结果区。
 * 第一期 8 个节点＋二期补齐 12 个（关联/合并/去重/排序/汇总/透视/宽转长/分列/
 * 检查/手工输入/数据库输入/Parquet 输入）全部可用；预览/全量/运行到选中节点经
 * engine_call 的 dataflow_preview / dataflow_run 与 Rust 引擎交互。
 */
/** 面板尺寸记忆键：与草稿同前缀，便于统一清理。 */
const PANEL_SIZE_KEY = "audit-toolbox:dataflow:layout";

function loadPanelSize(field: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(PANEL_SIZE_KEY);
    if (!raw) return fallback;
    const value = Number((JSON.parse(raw) as Record<string, unknown>)?.[field]);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  } catch {
    return fallback;
  }
}

function savePanelSizes(configWidth: number, resultsHeight: number): void {
  try {
    window.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ configWidth, resultsHeight }));
  } catch {
    // 存储不可用时静默跳过：尺寸仍可用，只是不记忆。
  }
}

export function DataFlowPage({ tool }: { tool: ToolManifest }) {
  const [workflow, setWorkflow] = useState<DataflowWorkflow>(() => createEmptyWorkflow());
  const workflowRef = useRef(workflow);
  const historyRef = useRef(new WorkflowHistory());
  /** 最近一次「连线被拒」写入错误通道的文案：连线成功即撤下，避免拒绝提示长期占着错误通道。 */
  const connectRejectedRef = useRef("");
  const [historyTick, setHistoryTick] = useState(0);
  const [selection, setSelection] = useState<DataflowSelection>(null);
  // 最近新增节点：交给画布保证落在视野内（视角被拖远时自动对准）。
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  // 「适配视图」请求令牌：恢复草稿/打开流程后递增，画布把全部节点缩放进视野
  // （旧流程的节点坐标可能超出当前窗口的画布范围，不适配就"打开即看不见"）。
  const [fitKey, setFitKey] = useState(0);
  const [runResult, setRunResult] = useState<DataflowRunResult | null>(null);
  const [lastRunMode, setLastRunMode] = useState<"preview" | "full" | null>(null);
  /** 「运行到选中节点」时记录目标节点 id，其余运行方式为 null。 */
  const [ranUpTo, setRanUpTo] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runSeconds, setRunSeconds] = useState(0);
  const [statusText, setStatusText] = useState("就绪 · 编辑过程会自动保存草稿到本机。");
  const [error, setError] = useState("");
  // 面板尺寸（用户可用鼠标拖分隔条调整）：记忆在本机，双击分隔条恢复默认。
  const [configWidth, setConfigWidth] = useState<number>(() => loadPanelSize("configWidth", 288, 232, 560));
  const [resultsHeight, setResultsHeight] = useState<number>(() => loadPanelSize("resultsHeight", 236, 120, 640));
  const configWidthRef = useRef(configWidth);
  configWidthRef.current = configWidth;
  const resultsHeightRef = useRef(resultsHeight);
  resultsHeightRef.current = resultsHeight;
  // 输出位置：用户设定一次即记住，输出文件名留空/只填名字时自动保存到这里。
  const [outputDir, setOutputDir] = useState<string>(() => loadOutputDir());
  const outputDirRef = useRef(outputDir);
  outputDirRef.current = outputDir;
  const [paramsDialog, setParamsDialog] = useState<null | "edit" | "confirm">(null);
  const [autosaveNote, setAutosaveNote] = useState("");
  const [configCollapsed, setConfigCollapsed] = useState(false);
  const [resultsCollapsed, setResultsCollapsed] = useState(false);

  /** 带撤销快照的修改：先记录「修改前」，再写入新状态。 */
  function commit(updater: (wf: DataflowWorkflow) => DataflowWorkflow) {
    const current = workflowRef.current;
    const next = updater(current);
    historyRef.current.snapshot(current);
    workflowRef.current = next;
    setWorkflow(next);
    setHistoryTick((tick) => tick + 1);
  }

  /** 不进撤销栈的直接替换（拖动节点、载入流程、恢复草稿）。 */
  function replaceWorkflow(next: DataflowWorkflow, resetHistory: boolean) {
    if (resetHistory) historyRef.current.reset();
    workflowRef.current = next;
    setWorkflow(next);
    setHistoryTick((tick) => tick + 1);
  }

  // 打开页面时自动恢复最近一份含节点的草稿：工具页切换会重建组件，
  // 画布状态随之丢失，草稿是唯一兜底（设计文档：自动保存草稿）。
  // 恢复不再弹窗确认——「忽略并清除」式的二选一曾让用户误删整个流程；
  // 要重新开始请点工具栏「新建」（显式清除当前流程名的草稿）。
  useEffect(() => {
    const draft = listDrafts().find((item) => item.workflow.nodes.length);
    if (!draft) return;
    // 跨版本草稿可能带过期锚点名，恢复时即修正，别等运行才炸。
    const { workflow, fixes } = repairWorkflowEdges(draft.workflow);
    replaceWorkflow(workflow, true);
    // 草稿里的节点坐标可能落在当前画布视野外（换窗口/换机器后常见），
    // 恢复后立即适配，保证「恢复即看得见」。
    setFitKey((key) => key + 1);
    setAutosaveNote(`恢复自草稿 ${draft.savedAt.replace("T", " ").slice(11, 16)}`);
    setStatusText(
      `已自动恢复未保存的流程《${draft.name}》（${workflow.nodes.length} 个节点，保存于 ${draft.savedAt.replace("T", " ").slice(0, 19)}）。${fixes.length ? ` 已修正 ${fixes.length} 条过期连线：${fixes.join(" ")}` : "" }如需重新开始请点「新建」。`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动保存草稿（键含流程名）；空流程不落草稿，避免自触发恢复提示。
  useEffect(() => {
    const empty =
      !workflow.nodes.length && !workflow.params.length && workflow.name === "新建流程";
    if (empty) return;
    const timer = window.setTimeout(() => {
      // saveDraft 返回 false 有两种含义：无节点流程有意跳过（model.ts 的
      // 设计），以及 localStorage 写入失败（配额满/存储禁用）。只有带节点的
      // 流程写不进草稿才是真失败——此时「切页靠草稿兜底」已无声失效，必须
      // 明说并用警告覆盖旧的「已自动保存」成功文案，否则用户误信已保存。
      if (saveDraft(workflow)) {
        setAutosaveNote(`已自动保存 ${timeNow()}`);
      } else if (workflow.nodes.length) {
        setAutosaveNote(
          "自动保存失败（本机存储不可用或已满）：切换工具页后画布将无法自动恢复，请点「保存」手动保存流程文件。",
        );
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [workflow]);

  /** 面板分隔条拖拽：axis 决定调整配置区宽度（左右）还是结果区高度（上下），
      拖完记忆尺寸；双击分隔条恢复默认。折叠状态下面板尺寸固定，忽略拖拽。 */
  function startPanelResize(
    axis: "config" | "results",
    event: React.PointerEvent<HTMLDivElement>,
  ) {
    if (axis === "config" ? configCollapsed : resultsCollapsed) return;
    event.preventDefault();
    const start = axis === "config" ? event.clientX : event.clientY;
    const startSize = axis === "config" ? configWidth : resultsHeight;
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // 合成指针事件没有活动指针 id，捕获失败不阻断拖动。
    }
    const onMove = (moveEvent: PointerEvent) => {
      const delta = (axis === "config" ? moveEvent.clientX : moveEvent.clientY) - start;
      // ref 同步写：pointerup 可能先于 React 重渲染到达，松手保存时必须
      // 读到最新值（否则存下的是拖动前的旧尺寸）。
      if (axis === "config") {
        const next = Math.max(232, Math.min(560, startSize + delta));
        configWidthRef.current = next;
        setConfigWidth(next);
      } else {
        const next = Math.max(120, Math.min(640, startSize - delta));
        resultsHeightRef.current = next;
        setResultsHeight(next);
      }
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      savePanelSizes(configWidthRef.current, resultsHeightRef.current);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  function resetPanelSize(axis: "config" | "results") {
    if (axis === "config") setConfigWidth(288);
    else setResultsHeight(236);
    savePanelSizes(
      axis === "config" ? 288 : configWidthRef.current,
      axis === "results" ? 236 : resultsHeightRef.current,
    );
  }

  function addNode(type: string) {
    const wf = workflowRef.current;
    const count = wf.nodes.length;
    const node = {
      id: nextNodeId(wf),
      type,
      name: defaultNodeName(wf, type),
      x: 60 + (count % 6) * 190,
      y: 60 + Math.floor(count / 6) * 150,
      config: defaultConfigFor(type),
    };
    commit((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelection({ kind: "node", id: node.id });
    setFocusNodeId(node.id);
    // 添加节点是用户对错误提示的典型响应，先清掉上次的失败卡。
    setError("");
    setStatusText(`已添加「${node.name}」节点。`);
  }

  function moveNode(id: string, x: number, y: number) {
    const next: DataflowWorkflow = {
      ...workflowRef.current,
      nodes: workflowRef.current.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)),
    };
    workflowRef.current = next;
    setWorkflow(next);
  }

  function snapshotForDrag() {
    historyRef.current.snapshot(workflowRef.current);
    setHistoryTick((tick) => tick + 1);
  }

  function connect(edge: DataflowEdge) {
    const check = validateNewEdge(workflowRef.current, edge);
    if (!check.ok) {
      // 连线被拒也必须走可见错误通道（错误样式状态栏＋结果区红卡）：
      // 只写状态栏小字会被后续任意操作覆盖，且线没出现，用户会以为
      // 连线成功了，直到运行才报「需要恰好 1 条输入连线」——与 runFlow
      // 空画布路径同款双通道处理。
      const message = `连线未创建：${check.reason}`;
      setError(message);
      setStatusText(check.reason);
      connectRejectedRef.current = message;
      return;
    }
    commit((current) => ({ ...current, edges: [...current.edges, check.edge] }));
    // 连线成功即撤下上一次「连线被拒」的提示；只清自己写入的文案，
    // 不误清运行失败、路径未授权等其他来源的错误。
    if (connectRejectedRef.current && error === connectRejectedRef.current) setError("");
    connectRejectedRef.current = "";
    setStatusText("已连线。");
  }

  function deleteSelection() {
    if (!selection) return;
    if (selection.kind === "node") {
      const id = selection.id;
      commit((current) => ({
        ...current,
        nodes: current.nodes.filter((node) => node.id !== id),
        edges: current.edges.filter((edge) => edge.from !== id && edge.to !== id),
      }));
      setSelection(null);
      setStatusText("已删除节点及其连线。");
      return;
    }
    const target = selection.edge;
    commit((current) => ({
      ...current,
      edges: current.edges.filter(
        (edge) =>
          !(
            edge.from === target.from &&
            edge.fromAnchor === target.fromAnchor &&
            edge.to === target.to &&
            edge.toAnchor === target.toAnchor
          ),
      ),
    }));
    setSelection(null);
    setStatusText("已删除连线。");
  }

  function undo() {
    const next = historyRef.current.undo(workflowRef.current);
    if (!next) return;
    workflowRef.current = next;
    setWorkflow(next);
    setHistoryTick((tick) => tick + 1);
    setStatusText("已撤销一步。");
  }

  function redo() {
    const next = historyRef.current.redo(workflowRef.current);
    if (!next) return;
    workflowRef.current = next;
    setWorkflow(next);
    setHistoryTick((tick) => tick + 1);
    setStatusText("已重做一步。");
  }

  // 画布快捷键：Delete 删除选中、Ctrl+Z/Y 撤销重做；输入控件内不拦截。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (paramsDialog) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable)
        return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        (key === "y" || (key === "z" && event.shiftKey))
      ) {
        event.preventDefault();
        redo();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        if (!selection) return;
        event.preventDefault();
        deleteSelection();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // 运行计时：同步引擎调用没有进度事件，至少让用户知道已运行多久。
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setRunSeconds(0);
    const timer = window.setInterval(() => {
      setRunSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  /** 路径未授权是安全设计的预期拦截（恢复/分享的流程不自动获得文件访问权），
   *  报错时附上怎么办，而不是让用户猜。 */
  function withPathHint(message: string): string {
    return message.includes("路径未授权")
      ? `${message}（安全设计：恢复或打开的流程不会自动获得文件访问权，请在对应输入节点的配置里重新选择一次文件或文件夹。）`
      : message;
  }

  async function runFlow(mode: "preview" | "full", uptoNodeId?: string) {
    if (running) return;
    const wf = workflowRef.current;
    if (!wf.nodes.length) {
      // 空画布点运行也必须走可见错误通道：只写状态栏会让用户以为点了没反应。
      setError("画布还没有节点：请先从上方分类菜单添加输入节点并选择数据文件，再点运行。");
      setStatusText("画布还没有节点，请先从上方分类菜单添加。");
      return;
    }
    if (uptoNodeId && !wf.nodes.some((node) => node.id === uptoNodeId)) return;
    // 运行前自检筛选条件：没选字段/没填值的空条件行直接拦下，并指出
    // 是哪个节点第几条——引擎只会报「引用了字段“”」，用户无从定位。
    const wiredIds = new Set(wf.edges.flatMap((edge) => [edge.from, edge.to]));
    const incomplete: string[] = [];
    for (const node of wf.nodes) {
      if (node.type !== "filter_n" || !wiredIds.has(node.id)) continue;
      const rules =
        ((node.config as Record<string, unknown> | undefined)?.condition as
          | { rules?: Partial<FilterRuleConfig>[] }
          | undefined)?.rules ?? [];
      rules.forEach((rule, index) => {
        if (incompleteFilterRule(rule)) {
          incomplete.push(`「${node.name}」第 ${index + 1} 条条件`);
        }
      });
    }
    if (incomplete.length) {
      setError(
        `有 ${incomplete.length} 条筛选条件还没填完整（${incomplete.join("、")}）：请补上字段和值，或删掉不需要的条件行，再点运行。`,
      );
      setStatusText("筛选条件未填完整，已拦下本次运行。");
      return;
    }
    // 运行前兜底修正过期连线（手工编辑流程文件等来源），保证引擎拿到合法锚点。
    const repaired = repairWorkflowEdges(wf);
    if (repaired.fixes.length) {
      workflowRef.current = repaired.workflow;
      setWorkflow(repaired.workflow);
      setStatusText(`已自动修正 ${repaired.fixes.length} 条过期连线后运行：${repaired.fixes[0]}`);
    }
    // 输出文件名解析：留空＝自动命名（含时间戳）、只填名字＝放进输出位置，
    // 都不需要用户写完整路径（真实反馈 2026-10-30）。目录未设置时先让用户
    // 选一次文件夹并记住，之后零操作。
    let resolved = resolveOutputPaths(repaired.workflow, outputDirRef.current);
    if (resolved.needsDir) {
      const picked = await pickPath("folder", "选择输出文件夹（输出文件将自动保存到这里，只需设置一次）");
      if (typeof picked === "string" && picked) {
        outputDirRef.current = picked;
        setOutputDir(picked);
        saveOutputDir(picked);
        resolved = resolveOutputPaths(repaired.workflow, picked);
      } else {
        setError(
          "输出文件还没有落脚的文件夹：请点输出节点的「选择输出位置」选一次（会记住），或把文件名写成含盘符的完整路径。",
        );
        setStatusText("未设置输出位置，已拦下本次运行。");
        return;
      }
    }
    const runWf = resolved.workflow;
    setRunning(true);
    setError("");
    setRanUpTo(null);
    const resolveNote = resolved.notes.length ? `${resolved.notes.join("；")}。` : "";
    setStatusText(
      `${resolveNote}${
        uptoNodeId
          ? "正在运行到所选节点（全量数据，大文件可能需要数分钟且暂无进度显示）…"
          : mode === "preview"
            ? "正在预览运行（样本数据）…"
            : "正在全量运行（大文件可能需要数分钟且暂无进度显示；探索数据建议先用预览运行）…"
      }`,
    );
    const overrides = Object.fromEntries(wf.params.map((param) => [param.id, param.value]));
    try {
      const raw =
        mode === "preview"
          ? await dataflowPreview(runWf, overrides)
          : await dataflowRun(runWf, overrides, uptoNodeId);
      const parsed = DataflowRunResultSchema.safeParse(raw);
      if (!parsed.success) {
        setError("引擎返回的数据不符合数据流契约，请更新应用后重试。");
        setStatusText("运行失败。");
        return;
      }
      setRunResult(parsed.data);
      setLastRunMode(mode);
      if (uptoNodeId) setRanUpTo(uptoNodeId);
      if (parsed.data.error) setError(withPathHint(errorText(parsed.data.error)));
      const statuses = Object.values(parsed.data.nodes);
      const warns = statuses.filter((item) => item.status === "warn").length;
      const errors = statuses.filter((item) => item.status === "error").length;
      setStatusText(
        uptoNodeId
          ? `上次运行：全量运行到「${wf.nodes.find((node) => node.id === uptoNodeId)?.name ?? uptoNodeId}」· 警告 ${warns} 项、失败 ${errors} 项`
          : mode === "preview"
            ? `上次运行：预览运行（样本数据）· 警告 ${warns} 项、失败 ${errors} 项`
            : `上次运行：全量运行 · 警告 ${warns} 项、失败 ${errors} 项、输出 ${parsed.data.outputs.length} 个文件`,
      );
    } catch (caught) {
      setError(withPathHint(errorText(caught)));
      setStatusText("运行失败，详见左下提示。");
    } finally {
      setRunning(false);
    }
  }

  async function handleSave() {
    let outcome: SaveWorkflowOutcome;
    try {
      outcome = await saveWorkflowFile(workflowRef.current);
    } catch (caught) {
      // 保存链路的意外异常兜底成可见错误：不能变成 unhandled rejection，
      // 让用户点了「保存」毫无反应。
      setError(`保存流程失败：${errorText(caught)}`);
      setStatusText("保存失败，详见左下提示。");
      return;
    }
    if (!outcome.ok && outcome.message === "已取消保存。") {
      setStatusText(outcome.message);
      return;
    }
    if (outcome.ok) {
      setStatusText(outcome.message);
      removeDraft(workflowRef.current.name);
      setAutosaveNote("");
    } else {
      setError(outcome.message);
    }
  }

  /** 选择默认输出文件夹（设定一次即记住）：输出文件名留空/只填名字时自动保存到这里。 */
  async function handlePickOutputDir() {
    const picked = await pickPath("folder", "选择输出文件夹（输出文件将自动保存到这里）");
    if (typeof picked === "string" && picked) {
      outputDirRef.current = picked;
      setOutputDir(picked);
      saveOutputDir(picked);
      setStatusText(`输出位置已设为 ${picked}。`);
    }
  }

  async function handleOpen() {
    const picked = await pickWorkflowFile();
    if (!picked.ok) {
      if (picked.message) setError(picked.message);
      return;
    }
    const parsed = parseWorkflowFile(picked.text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const { workflow, fixes } = repairWorkflowEdges(parsed.workflow);
    replaceWorkflow(workflow, true);
    // 流程文件的节点坐标可能超出当前画布（保存时的窗口更大/更宽），
    // 打开后立即适配，保证「打开即看得见」。
    setFitKey((key) => key + 1);
    setSelection(null);
    setRunResult(null);
    setLastRunMode(null);
    setRanUpTo(null);
    setError("");
    setStatusText(
      `已打开流程《${workflow.name}》（来自 ${picked.fileName}）。${fixes.length ? ` 已修正 ${fixes.length} 条过期连线：${fixes.join(" ")}` : ""}`,
    );
    if (workflow.params.length) setParamsDialog("confirm");
  }

  /** 新建空白流程：显式清掉当前流程名的草稿，避免下次进页面又被自动恢复。 */
  function startNewFlow() {
    removeDraft(workflowRef.current.name);
    replaceWorkflow(createEmptyWorkflow(), true);
    setSelection(null);
    setRunResult(null);
    setLastRunMode(null);
    setRanUpTo(null);
    setError("");
    setAutosaveNote("");
    setStatusText("已新建空白流程（原草稿已清除）。");
  }

  async function handlePickPath(
    kind: "file" | "folder",
    extensions: string[],
    apply: (path: string) => void,
  ) {
    try {
      const value = await pickPath(
        kind,
        kind === "folder" ? "选择数据文件夹" : "选择数据文件",
        extensions,
      );
      if (typeof value === "string" && value) apply(value);
    } catch (caught) {
      // 系统对话框组件出错（IPC 异常等）时兜底为可见的中文错误，参照
      // DbTableSelect 的错误通道：不能让「选择…」成为 unhandled rejection，
      // 用户点了毫无反应。
      const what = kind === "folder" ? "文件夹" : "文件";
      setError(`选择${what}失败：${errorText(caught)}`);
      setStatusText(`选择${what}失败，详见左下提示。`);
    }
  }

  const selectedNode =
    selection?.kind === "node"
      ? (workflow.nodes.find((node) => node.id === selection.id) ?? null)
      : null;

  function statusOf(nodeId: string): NodeRunStatus {
    if (running) return "run";
    const status = runResult?.nodes[nodeId]?.status;
    return status ?? "idle";
  }

  function resultOf(nodeId: string) {
    return runResult?.nodes[nodeId];
  }

  return (
    <div className="df-page">
      <PageHeader
        eyebrow="数据流"
        title={tool.name}
        detail="拖拽节点搭建数据处理流程：读取、整理、筛选、输出，保存流程文件后换一批数据改参数重跑。"
      />
      <div
        className="df-shell"
        data-history-tick={historyTick}
        style={{
          ["--df-config-w" as string]: `${configWidth}px`,
          ["--df-results-h" as string]: `${resultsHeight}px`,
        }}
      >
        <DataflowToolbar
          flowName={workflow.name}
          onFlowNameChange={(name) =>
            commit((current) => ({ ...current, name: name || "未命名流程" }))
          }
          onNew={startNewFlow}
          autosaveNote={autosaveNote}
          onAddNode={addNode}
          canUndo={historyRef.current.canUndo}
          canRedo={historyRef.current.canRedo}
          onUndo={undo}
          onRedo={redo}
          onParams={() => setParamsDialog("edit")}
          onSave={() => void handleSave()}
          onOpen={() => void handleOpen()}
          onPreviewRun={() => void runFlow("preview")}
          onFullRun={() => void runFlow("full")}
          onRunToNode={() => {
            if (selection?.kind === "node") void runFlow("full", selection.id);
          }}
          canRunToNode={selection?.kind === "node"}
          running={running}
        />
        <div className="df-main">
          <ConfigPanel
            node={selectedNode}
            params={workflow.params}
            collapsed={configCollapsed}
            onToggleCollapse={() => setConfigCollapsed((value) => !value)}
            onRename={(name) => {
              if (!selectedNode) return;
              const id = selectedNode.id;
              commit((current) => ({
                ...current,
                nodes: current.nodes.map((node) =>
                  node.id === id ? { ...node, name } : node,
                ),
              }));
            }}
            onConfigChange={(next) => {
              if (!selectedNode) return;
              const id = selectedNode.id;
              commit((current) => ({
                ...current,
                nodes: current.nodes.map((node) =>
                  node.id === id ? { ...node, config: next } : node,
                ),
              }));
            }}
            onDelete={deleteSelection}
            onPickPath={(kind, extensions, apply) => void handlePickPath(kind, extensions, apply)}
            outputDir={outputDir}
            onPickOutputDir={() => void handlePickOutputDir()}
          />
          <div
            className="df-split df-split-v"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整配置区宽度（双击恢复默认）"
            title="拖动调整配置区宽度 · 双击恢复默认"
            onPointerDown={(event) => startPanelResize("config", event)}
            onDoubleClick={() => resetPanelSize("config")}
          />
          {runResult && lastRunMode && (
            <div
              className={`df-banner ${
                lastRunMode === "preview" && !ranUpTo ? "df-banner-preview" : "df-banner-full"
              }`}
              role="status"
            >
              {ranUpTo
                ? `已运行到所选节点「${
                    workflow.nodes.find((node) => node.id === ranUpTo)?.name ?? ranUpTo
                  }」，其后节点未执行`
                : lastRunMode === "preview"
                  ? "预览模式 · 样本数据（每输入前 1,000 行）——预览不写输出文件，结果不代表全量"
                  : "全量运行完成 · 输出已写入文件（详见输出节点与消息页签）"}
            </div>
          )}
          <DataflowCanvas
            workflow={workflow}
            selection={selection}
            statusOf={statusOf}
            resultOf={resultOf}
            onSelect={setSelection}
            onMoveNode={moveNode}
            onNodeDragStart={snapshotForDrag}
            onConnect={connect}
            focusNodeId={focusNodeId}
            fitKey={fitKey}
          />
        </div>
        <div
          className="df-split df-split-h"
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整结果区高度（双击恢复默认）"
          title="拖动调整结果区高度 · 双击恢复默认"
          onPointerDown={(event) => startPanelResize("results", event)}
          onDoubleClick={() => resetPanelSize("results")}
        />
        <ResultsPanel
          node={selectedNode}
          result={selectedNode ? resultOf(selectedNode.id) : undefined}
          nodeStatus={selectedNode ? statusOf(selectedNode.id) : "idle"}
          lastRunMode={lastRunMode}
          outputs={runResult?.outputs ?? []}
          runError={error}
          collapsed={resultsCollapsed}
          onToggleCollapse={() => setResultsCollapsed((value) => !value)}
        />
        <div className="df-statusbar">
          <span
            className={`df-status-text${error ? " df-status-error" : ""}`}
            title={error || statusText}
          >
            {error || statusText}
            {running ? ` · 已运行 ${runSeconds} 秒` : ""}
          </span>
          <span className="df-status-meta">
            <span>
              {workflow.nodes.length} 个节点 · {workflow.edges.length} 条连线
            </span>
            {runResult && (
              <>
                <span className="df-vr" aria-hidden="true" />
                <span className="df-legend" aria-hidden="true">
                  <span>
                    <i className="df-dot" />未运行
                  </span>
                  <span>
                    <i className="df-dot df-dot-run" />运行中
                  </span>
                  <span>
                    <i className="df-dot df-dot-ok" />成功
                  </span>
                  <span>
                    <i className="df-dot df-dot-warn" />警告
                  </span>
                  <span>
                    <i className="df-dot df-dot-err" />失败
                  </span>
                </span>
              </>
            )}
          </span>
        </div>
      </div>
      {paramsDialog && (
        <ParamsDialog
          mode={paramsDialog}
          params={workflow.params}
          onCancel={() => setParamsDialog(null)}
          onApply={(params) => {
            commit((current) => ({ ...current, params }));
            setParamsDialog(null);
            setStatusText(
              paramsDialog === "confirm" ? "参数已确认，可以开始运行。" : "参数定义已保存。",
            );
          }}
        />
      )}
    </div>
  );
}
