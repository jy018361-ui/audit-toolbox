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
  listDrafts,
  nextNodeId,
  parseWorkflowFile,
  removeDraft,
  saveDraft,
  validateNewEdge,
  type DataflowDraft,
  type DataflowEdge,
  type DataflowRunResult,
  type DataflowWorkflow,
} from "./model";
import { pickWorkflowFile, saveWorkflowFile } from "./workflowFile";
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
export function DataFlowPage({ tool }: { tool: ToolManifest }) {
  const [workflow, setWorkflow] = useState<DataflowWorkflow>(() => createEmptyWorkflow());
  const workflowRef = useRef(workflow);
  const historyRef = useRef(new WorkflowHistory());
  const [historyTick, setHistoryTick] = useState(0);
  const [selection, setSelection] = useState<DataflowSelection>(null);
  const [runResult, setRunResult] = useState<DataflowRunResult | null>(null);
  const [lastRunMode, setLastRunMode] = useState<"preview" | "full" | null>(null);
  /** 「运行到选中节点」时记录目标节点 id，其余运行方式为 null。 */
  const [ranUpTo, setRanUpTo] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState("就绪 · 编辑过程会自动保存草稿到本机。");
  const [error, setError] = useState("");
  const [paramsDialog, setParamsDialog] = useState<null | "edit" | "confirm">(null);
  const [draftPrompt, setDraftPrompt] = useState<DataflowDraft | null>(null);
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

  // 打开页面时检查未保存草稿，异常关闭后提示恢复。
  useEffect(() => {
    const drafts = listDrafts();
    if (drafts.length && drafts[0].workflow.nodes.length) setDraftPrompt(drafts[0]);
  }, []);

  // 自动保存草稿（键含流程名）；空流程不落草稿，避免自触发恢复提示。
  useEffect(() => {
    const empty =
      !workflow.nodes.length && !workflow.params.length && workflow.name === "新建流程";
    if (empty) return;
    const timer = window.setTimeout(() => {
      if (saveDraft(workflow)) setAutosaveNote(`已自动保存 ${timeNow()}`);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [workflow]);

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
      setStatusText(check.reason);
      return;
    }
    commit((current) => ({ ...current, edges: [...current.edges, check.edge] }));
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

  async function runFlow(mode: "preview" | "full", uptoNodeId?: string) {
    if (running) return;
    const wf = workflowRef.current;
    if (!wf.nodes.length) {
      setStatusText("画布还没有节点，请先从上方分类菜单添加。");
      return;
    }
    if (uptoNodeId && !wf.nodes.some((node) => node.id === uptoNodeId)) return;
    setRunning(true);
    setError("");
    setRanUpTo(null);
    setStatusText(
      uptoNodeId
        ? `正在运行到所选节点（全量数据，只执行到该节点为止）…`
        : mode === "preview"
          ? "正在预览运行（样本数据）…"
          : "正在全量运行…",
    );
    const overrides = Object.fromEntries(wf.params.map((param) => [param.id, param.value]));
    try {
      const raw =
        mode === "preview"
          ? await dataflowPreview(wf, overrides)
          : await dataflowRun(wf, overrides, uptoNodeId);
      const parsed = DataflowRunResultSchema.safeParse(raw);
      if (!parsed.success) {
        setError("引擎返回的数据不符合数据流契约，请更新应用后重试。");
        setStatusText("运行失败。");
        return;
      }
      setRunResult(parsed.data);
      setLastRunMode(mode);
      if (uptoNodeId) setRanUpTo(uptoNodeId);
      if (parsed.data.error) setError(errorText(parsed.data.error));
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
      setError(errorText(caught));
      setStatusText("运行失败，详见左下提示。");
    } finally {
      setRunning(false);
    }
  }

  async function handleSave() {
    const outcome = await saveWorkflowFile(workflowRef.current);
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
    replaceWorkflow(parsed.workflow, true);
    setSelection(null);
    setRunResult(null);
    setLastRunMode(null);
    setRanUpTo(null);
    setError("");
    setStatusText(`已打开流程《${parsed.workflow.name}》（来自 ${picked.fileName}）。`);
    if (parsed.workflow.params.length) setParamsDialog("confirm");
  }

  async function handlePickPath(
    kind: "file" | "folder",
    extensions: string[],
    apply: (path: string) => void,
  ) {
    const value = await pickPath(
      kind,
      kind === "folder" ? "选择数据文件夹" : "选择数据文件",
      extensions,
    );
    if (typeof value === "string" && value) apply(value);
  }

  function restoreDraft() {
    if (!draftPrompt) return;
    replaceWorkflow(draftPrompt.workflow, true);
    setSelection(null);
    setRunResult(null);
    setLastRunMode(null);
    setRanUpTo(null);
    setStatusText(`已恢复草稿《${draftPrompt.name}》（保存于 ${draftPrompt.savedAt.replace("T", " ").slice(0, 19)}）。`);
    setDraftPrompt(null);
  }

  function dismissDraft() {
    if (!draftPrompt) return;
    removeDraft(draftPrompt.name);
    setDraftPrompt(null);
    setStatusText("已忽略并清除该草稿。");
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
    <>
      <PageHeader
        eyebrow="数据流"
        title={tool.name}
        detail="拖拽节点搭建数据处理流程：读取、整理、筛选、输出，保存流程文件后换一批数据改参数重跑。"
      />
      {draftPrompt && (
        <div className="df-draft-bar" role="status">
          <span>
            检测到未保存的草稿《{draftPrompt.name}
            》（保存于 {draftPrompt.savedAt.replace("T", " ").slice(0, 19)}），是否恢复？
          </span>
          <button type="button" className="df-btn-sm" onClick={restoreDraft}>
            恢复草稿
          </button>
          <button type="button" className="df-btn-sm" onClick={dismissDraft}>
            忽略并清除
          </button>
        </div>
      )}
      <div className="df-shell" data-history-tick={historyTick}>
        <DataflowToolbar
          flowName={workflow.name}
          onFlowNameChange={(name) =>
            commit((current) => ({ ...current, name: name || "未命名流程" }))
          }
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
          />
        </div>
        <ResultsPanel
          node={selectedNode}
          result={selectedNode ? resultOf(selectedNode.id) : undefined}
          nodeStatus={selectedNode ? statusOf(selectedNode.id) : "idle"}
          lastRunMode={lastRunMode}
          outputs={runResult?.outputs ?? []}
          collapsed={resultsCollapsed}
          onToggleCollapse={() => setResultsCollapsed((value) => !value)}
        />
        <div className="df-statusbar">
          <span className={error ? "df-status-error" : undefined} title={error || statusText}>
            {error || statusText}
          </span>
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
            <span>{workflow.nodes.length} 个节点 · {workflow.edges.length} 条连线</span>
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
    </>
  );
}
