import { useEffect, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import { DataflowIcon } from "./icons";
import type {
  DataflowEdge,
  DataflowNode,
  DataflowNodeResult,
  DataflowWorkflow,
} from "./model";
import { nodeSpec, type DataflowNodeSpec } from "./nodeSpecs";

/** 画布几何常量：节点宽度与默认高度，锚点纵向分布按此计算。 */
const NODE_W = 156;
const NODE_H = 78;

export type NodeRunStatus = "idle" | "run" | "ok" | "warn" | "error";

export type DataflowSelection =
  | { kind: "node"; id: string }
  | { kind: "edge"; edge: DataflowEdge }
  | null;

export function anchorOffsetY(count: number, index: number): number {
  return NODE_H * (0.28 + (0.44 * index) / Math.max(1, count - 1));
}

function anchorPos(
  node: DataflowNode,
  spec: DataflowNodeSpec,
  side: "in" | "out",
  key: string,
): { x: number; y: number } {
  const anchors = side === "in" ? spec.inputs : spec.outputs;
  const index = Math.max(0, anchors.findIndex((anchor) => anchor.key === key));
  return {
    x: node.x + (side === "in" ? 0 : NODE_W),
    y: node.y + anchorOffsetY(anchors.length, index),
  };
}

/** 当前版本不认识的节点类型没有锚点定义，连线端点退化为节点中心。 */
function nodeCenter(node: DataflowNode): { x: number; y: number } {
  return { x: node.x + NODE_W / 2, y: node.y + NODE_H / 2 };
}

function bezierPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.min(120, Math.max(40, Math.abs(b.x - a.x) * 0.5));
  return `M${a.x} ${a.y} C${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** 节点分类色（画布与配置区共用；色值定义在 dataflow.css .df-shell）。 */
export const CATEGORY_COLOR: Record<string, string> = {
  input: "var(--df-cat-input)",
  transform: "var(--df-cat-transform)",
  filtersort: "var(--df-cat-filtersort)",
  join: "var(--df-cat-join)",
  aggregate: "var(--df-cat-aggregate)",
  check: "var(--df-cat-check)",
  output: "var(--df-cat-output)",
};

function statusClass(status: NodeRunStatus): string {
  if (status === "error") return "err";
  return status;
}

function badgeText(spec: DataflowNodeSpec, result: DataflowNodeResult | undefined): string {
  if (!result) return "";
  if (spec.outputs.length > 1) {
    return spec.outputs
      .map((anchor) => {
        const rows = result.anchors[anchor.key]?.rowCount;
        return `${anchor.key} ${rows !== undefined ? rows.toLocaleString("zh-CN") : "—"}`;
      })
      .join(" · ");
  }
  const elapsed =
    result.ms >= 1000 ? `${(result.ms / 1000).toFixed(1)} 秒` : `${result.ms} 毫秒`;
  return `${result.rows.toLocaleString("zh-CN")} 行 · ${elapsed}`;
}

type DragState =
  | { mode: "pan"; moved: number; lastX: number; lastY: number }
  | {
      mode: "node";
      id: string;
      dx: number;
      dy: number;
      moved: number;
      snapshotted: boolean;
    }
  | { mode: "connect"; from: string; fromAnchor: string; moved: number }
  | null;

export interface DataflowCanvasProps {
  workflow: DataflowWorkflow;
  selection: DataflowSelection;
  statusOf: (nodeId: string) => NodeRunStatus;
  resultOf: (nodeId: string) => DataflowNodeResult | undefined;
  onSelect: (selection: DataflowSelection) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  /** 节点真正开始被拖动前调用一次（撤销栈快照）。 */
  onNodeDragStart: () => void;
  onConnect: (edge: DataflowEdge) => void;
  /** 最近新增节点的 id：若它落在当前视野外（视角曾被拖远），自动把视角对准它。 */
  focusNodeId?: string | null;
  /** 请求「适配视图」的令牌：恢复草稿/打开流程时递增，画布把全部节点缩放进视野。 */
  fitKey?: number;
}

/** 数据流画布：拖动/连线/平移/缩放/点选，原生 DOM + SVG 实现。 */
export function DataflowCanvas({
  workflow,
  selection,
  statusOf,
  resultOf,
  onSelect,
  onMoveNode,
  onNodeDragStart,
  onConnect,
  focusNodeId,
  fitKey,
}: DataflowCanvasProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [camera, setCamera] = useState({ x: 24, y: 16, zoom: 1 });
  const dragRef = useRef<DragState>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  // 连线临时路径：渲染用 state、判定用 ref——快速拖动时 pointerup 可能先于
  // React 重渲染到达，读 state 会拿到旧值而丢线。
  const [tempEdge, setTempEdge] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const tempEdgeRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  const capturePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 合成指针事件没有活动指针 id，捕获失败不阻断拖动逻辑。
    }
  };

  // 滚轮/触摸板手势（用户裁定 2026-10-30）：双指滚动（含鼠标滚轮）＝
  // 平移窗口；双指捏合（浏览器派发为 ctrl+wheel）＝以指针为锚点缩放，
  // clamp 0.35–2.2。需要 non-passive 才能阻止页面滚动。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = cameraRef.current;
      if (event.ctrlKey) {
        const rect = canvas.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        // 捏合的 delta 很小、Ctrl+滚轮的 delta 约 ±100：指数因子对两者都平滑。
        const factor = Math.exp(-event.deltaY * 0.005);
        const nextZoom = Math.max(0.35, Math.min(2.2, current.zoom * factor));
        setCamera({
          zoom: nextZoom,
          x: mx - ((mx - current.x) * nextZoom) / current.zoom,
          y: my - ((my - current.y) * nextZoom) / current.zoom,
        });
      } else {
        setCamera((camera) => ({
          ...camera,
          x: camera.x - event.deltaX,
          y: camera.y - event.deltaY,
        }));
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // 新增节点必须落在视野内：节点坐标固定在原点附近，视角一旦被拖远
  // （旧版拖动画布带文字选择假象时尤其容易反复拖），新节点全部画在
  // 视野外，用户看到的就是「点了添加，画框里什么都没有」。这里在
  // 新节点完整落于视野外时把视角平移到对准它（缩放保持不变）。
  useEffect(() => {
    if (!focusNodeId) return;
    const node = workflow.nodes.find((item) => item.id === focusNodeId);
    const canvas = canvasRef.current;
    if (!node || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cameraNow = cameraRef.current;
    const screenX = cameraNow.x + node.x * cameraNow.zoom;
    const screenY = cameraNow.y + node.y * cameraNow.zoom;
    const w = NODE_W * cameraNow.zoom;
    const h = NODE_H * cameraNow.zoom;
    const visible =
      screenX >= 0 && screenY >= 0 && screenX + w <= rect.width && screenY + h <= rect.height;
    if (visible) return;
    setCamera({
      zoom: cameraNow.zoom,
      x: rect.width / 2 - (node.x + NODE_W / 2) * cameraNow.zoom,
      y: rect.height / 2 - (node.y + NODE_H / 2) * cameraNow.zoom,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId]);

  /** 适配视图：把全部节点缩放进画布并居中。旧坐标可能来自更宽的窗口
   *  （真实案例：节点横坐标 603/809/1026，当前画布仅约 670 宽），原先的
   *  「重置视图」只把缩放平移归一，内容在视野外的问题原样保留——用户
   *  看到的仍是空画布，点多少次重置都没用。空画布时恢复默认视角。 */
  function fitToContent() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!workflow.nodes.length) {
      setCamera({ x: 24, y: 16, zoom: 1 });
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const minX = Math.min(...workflow.nodes.map((node) => node.x));
    const minY = Math.min(...workflow.nodes.map((node) => node.y));
    const maxX = Math.max(...workflow.nodes.map((node) => node.x + NODE_W));
    const maxY = Math.max(...workflow.nodes.map((node) => node.y + NODE_H));
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const padding = 36;
    const zoom = Math.max(
      0.35,
      Math.min(
        1.5,
        Math.min((rect.width - padding * 2) / w, (rect.height - padding * 2) / h),
      ),
    );
    setCamera({
      zoom,
      x: (rect.width - w * zoom) / 2 - minX * zoom,
      y: (rect.height - h * zoom) / 2 - minY * zoom,
    });
  }

  useEffect(() => {
    if (!fitKey) return;
    fitToContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  function worldFromEvent(event: React.PointerEvent): { x: number; y: number } {
    const rect = (canvasRef.current as HTMLDivElement).getBoundingClientRect();
    const cameraNow = cameraRef.current;
    return {
      x: (event.clientX - rect.left - cameraNow.x) / cameraNow.zoom,
      y: (event.clientY - rect.top - cameraNow.y) / cameraNow.zoom,
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const outAnchor = target.closest(".df-a-out") as HTMLElement | null;
    if (outAnchor) {
      const nodeEl = outAnchor.closest(".df-node") as HTMLElement | null;
      if (nodeEl) {
        // 阻止指针按下衍生的默认行为（文字框选等），连线拖动才干净。
        event.preventDefault();
        dragRef.current = {
          mode: "connect",
          from: nodeEl.dataset.id ?? "",
          fromAnchor: outAnchor.dataset.key ?? "output",
          moved: 0,
        };
        capturePointer(event);
        return;
      }
    }
    const edgeEl = target.closest(".df-edge") as HTMLElement | null;
    if (edgeEl) {
      onSelect({
        kind: "edge",
        edge: {
          from: edgeEl.dataset.from ?? "",
          fromAnchor: edgeEl.dataset.fromAnchor ?? "",
          to: edgeEl.dataset.to ?? "",
          toAnchor: edgeEl.dataset.toAnchor ?? "",
        },
      });
      return;
    }
    const nodeEl = target.closest(".df-node") as HTMLElement | null;
    if (nodeEl && nodeEl.dataset.id) {
      const node = workflow.nodes.find((item) => item.id === nodeEl.dataset.id);
      if (node) {
        const world = worldFromEvent(event);
        dragRef.current = {
          mode: "node",
          id: node.id,
          dx: world.x - node.x,
          dy: world.y - node.y,
          moved: 0,
          snapshotted: false,
        };
        capturePointer(event);
        return;
      }
    }
    // 空白处按下即进入平移：掐掉浏览器默认的文字框选，否则拖动时
    // 蓝色选区盖在画布上，用户看到的不是平移而是「选中了一堆文字」。
    event.preventDefault();
    dragRef.current = { mode: "pan", moved: 0, lastX: event.clientX, lastY: event.clientY };
    capturePointer(event);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "pan") {
      drag.moved += 1;
      setCamera((current) => ({
        ...current,
        x: current.x + (event.clientX - drag.lastX),
        y: current.y + (event.clientY - drag.lastY),
      }));
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      return;
    }
    if (drag.mode === "node") {
      drag.moved += 1;
      if (!drag.snapshotted && drag.moved >= 3) {
        drag.snapshotted = true;
        onNodeDragStart();
      }
      if (!drag.snapshotted) return;
      const world = worldFromEvent(event);
      onMoveNode(
        drag.id,
        Math.max(4, Math.min(4600, world.x - drag.dx)),
        Math.max(4, Math.min(3600, world.y - drag.dy)),
      );
      return;
    }
    // 连线拖动：临时虚线跟随指针。ref 同步写，保证快速拖动时 pointerup
    // 立即可读到最新路径。
    drag.moved += 1;
    if (drag.moved < 3) return;
    const fromNode = workflow.nodes.find((item) => item.id === drag.from);
    const fromSpec = fromNode ? nodeSpec(fromNode.type) : undefined;
    if (!fromNode || !fromSpec) return;
    const start = anchorPos(fromNode, fromSpec, "out", drag.fromAnchor);
    const world = worldFromEvent(event);
    const next = { x1: start.x, y1: start.y, x2: world.x, y2: world.y };
    tempEdgeRef.current = next;
    setTempEdge(next);
  }

  function finishDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.mode === "connect") {
      if (tempEdgeRef.current) {
        const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
        const inAnchor = element?.closest(".df-a-in") as HTMLElement | null;
        const targetNode = inAnchor?.closest(".df-node") as HTMLElement | null;
        if (inAnchor && targetNode?.dataset.id) {
          onConnect({
            from: drag.from,
            fromAnchor: drag.fromAnchor,
            to: targetNode.dataset.id,
            toAnchor: inAnchor.dataset.key ?? "in",
          });
        }
      }
      setTempEdge(null);
      tempEdgeRef.current = null;
      return;
    }
    if (drag.mode === "node" && drag.moved < 3) {
      onSelect({ kind: "node", id: drag.id });
      return;
    }
    if (drag.mode === "pan" && drag.moved < 3) {
      onSelect(null);
    }
  }

  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  // 未知类型节点（新版本工具保存/手工编辑的流程文件里出现，parseWorkflowFile 不拦截）：
  // 此前静默不渲染，状态栏计数却含它们，运行报「节点类型未实现」时用户无从定位。
  // 这里改为灰色占位块＋画布顶部明示，连线以虚线接到占位块中心。
  const unknownNodes = workflow.nodes.filter((node) => !nodeSpec(node.type));

  return (
    <div className="df-canvas-wrap">
      <div
        className="df-canvas"
        ref={canvasRef}
        data-tour="dataflow-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={() => {
          dragRef.current = null;
          setTempEdge(null);
        }}
      >
        <div
          className="df-world"
          style={{
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
          }}
        >
          <svg className="df-edges" aria-hidden="true">
            <defs>
              <marker
                id="df-edge-arrow"
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 0L10 5L0 10z" fill="context-stroke" />
              </marker>
            </defs>
            {workflow.edges.map((edge) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (!from || !to) return null;
              const fromSpec = nodeSpec(from.type);
              const toSpec = nodeSpec(to.type);
              // 任一端是未知类型：仍渲染（虚线），端点退化为占位块中心，保证拓扑可见。
              const unknownEnd = !fromSpec || !toSpec;
              const selected =
                selection?.kind === "edge" &&
                selection.edge.from === edge.from &&
                selection.edge.fromAnchor === edge.fromAnchor &&
                selection.edge.to === edge.to &&
                selection.edge.toAnchor === edge.toAnchor;
              return (
                <path
                  key={`${edge.from}:${edge.fromAnchor}->${edge.to}:${edge.toAnchor}`}
                  className={`df-edge${unknownEnd ? " df-edge-unknown" : ""}${
                    selected ? " df-edge-selected" : ""
                  }`}
                  d={bezierPath(
                    fromSpec
                      ? anchorPos(from, fromSpec, "out", edge.fromAnchor)
                      : nodeCenter(from),
                    toSpec ? anchorPos(to, toSpec, "in", edge.toAnchor) : nodeCenter(to),
                  )}
                  markerEnd="url(#df-edge-arrow)"
                  strokeDasharray={unknownEnd ? "6 4" : undefined}
                  data-from={edge.from}
                  data-from-anchor={edge.fromAnchor}
                  data-to={edge.to}
                  data-to-anchor={edge.toAnchor}
                />
              );
            })}
            {tempEdge && (
              <path
                className="df-temp-edge"
                d={`M${tempEdge.x1} ${tempEdge.y1} L${tempEdge.x2} ${tempEdge.y2}`}
              />
            )}
          </svg>
          {workflow.nodes.map((node) => {
            const spec = nodeSpec(node.type);
            const status = statusOf(node.id);
            const selected = selection?.kind === "node" && selection.id === node.id;
            if (!spec) {
              // 未知类型占位块：保留名称/位置/选中/拖动与运行错误状态，让用户能定位
              // 「节点类型未实现」的出错节点；无锚点，不可从它发起连线。
              const badge =
                status === "run" ? "运行中…" : status === "error" ? "类型未实现" : "";
              return (
                <div
                  key={node.id}
                  className={`df-node df-node-unknown${selected ? " df-selected" : ""}${
                    status !== "idle" ? ` df-st-${statusClass(status)}` : ""
                  }`}
                  data-id={node.id}
                  title={`节点类型「${node.type}」当前版本不支持`}
                  onClick={() => onSelect({ kind: "node", id: node.id })}
                  style={{
                    left: node.x,
                    top: node.y,
                    borderLeft: "4px dashed var(--muted-soft)",
                  }}
                >
                  <div className="df-node-head">
                    <DataflowIcon icon="flag" />
                    <div className="df-node-names">
                      <b>{node.name}</b>
                      <span>未知类型：{node.type}</span>
                    </div>
                  </div>
                  <div
                    className={`df-node-badge df-b-${statusClass(status)}${
                      badge ? " df-badge-show" : ""
                    }`}
                  >
                    {badge}
                  </div>
                </div>
              );
            }
            const result = resultOf(node.id);
            const badge = status === "run" ? "运行中…" : badgeText(spec, result);
            return (
              <div
                key={node.id}
                className={`df-node${selected ? " df-selected" : ""}${
                  status !== "idle" ? ` df-st-${statusClass(status)}` : ""
                }`}
                data-id={node.id}
                onClick={() => onSelect({ kind: "node", id: node.id })}
                style={{
                  left: node.x,
                  top: node.y,
                  ["--df-cat" as string]: CATEGORY_COLOR[spec.category],
                }}
              >
                <div className="df-node-head">
                  <DataflowIcon icon={spec.icon} />
                  <div className="df-node-names">
                    <b>{node.name}</b>
                    <span>
                      {spec.cn} {spec.en}
                    </span>
                  </div>
                </div>
                <div
                  className={`df-node-badge df-b-${statusClass(status)}${
                    badge ? " df-badge-show" : ""
                  }`}
                >
                  {badge}
                </div>
                {spec.inputs.map((anchor, index) => (
                  <span key={anchor.key}>
                    <span
                      className="df-a df-a-in"
                      data-key={anchor.key}
                      style={{ top: anchorOffsetY(spec.inputs.length, index) - 5.5 }}
                    />
                    {spec.inputs.length > 1 && (
                      <span
                        className="df-a-lbl df-a-lbl-in"
                        style={{ top: anchorOffsetY(spec.inputs.length, index) - 7 }}
                      >
                        {anchor.label}
                      </span>
                    )}
                  </span>
                ))}
                {spec.outputs.map((anchor, index) => (
                  <span key={anchor.key}>
                    <span
                      className="df-a df-a-out"
                      data-key={anchor.key}
                      style={{ top: anchorOffsetY(spec.outputs.length, index) - 5.5 }}
                    />
                    {spec.outputs.length > 1 && (
                      <span
                        className="df-a-lbl df-a-lbl-out"
                        style={{ top: anchorOffsetY(spec.outputs.length, index) - 7 }}
                      >
                        {anchor.label}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
        {unknownNodes.length > 0 && (
          <div
            className="df-note df-note-warn"
            role="status"
            style={{
              position: "absolute",
              top: "var(--sp-2)",
              left: "var(--sp-2)",
              right: "140px",
              zIndex: 30,
              margin: 0,
            }}
          >
            检测到 {unknownNodes.length} 个节点类型当前版本不支持：
            {[...new Set(unknownNodes.map((node) => node.type))].join("、")}
            。已用灰色占位块显示在画布上（可选中、拖动定位），运行将报「节点类型未实现」。
          </div>
        )}
        {!workflow.nodes.length && (
          <div className="df-canvas-empty">
            <DataflowIcon icon="grid3x3" size={30} />
            <b>画布还是空的</b>
            <span>从上方分类菜单添加第一个节点</span>
            <span className="df-canvas-empty-hint">
              连线：从节点右侧圆点拖到左侧圆点 · Delete 删除选中
            </span>
          </div>
        )}
        <div className="df-canvas-tools">
          <button
            type="button"
            className="df-tool"
            aria-label="放大"
            onClick={() =>
              setCamera((current) => ({ ...current, zoom: Math.min(2.2, current.zoom * 1.15) }))
            }
          >
            <ZoomIn size={13} />
          </button>
          <button
            type="button"
            className="df-tool"
            aria-label="缩小"
            onClick={() =>
              setCamera((current) => ({ ...current, zoom: Math.max(0.35, current.zoom / 1.15) }))
            }
          >
            <ZoomOut size={13} />
          </button>
          <button
            type="button"
            className="df-tool"
            title="把全部节点缩放进视野并居中（找不到内容时点这里）"
            onClick={fitToContent}
          >
            <RotateCcw size={13} />
            适配视图
          </button>
        </div>
        <span className="df-hint">
          空白处按住左键拖动或双指滚动＝平移 · 双指捏合（Ctrl+滚轮）＝缩放 · 从右侧圆点拖到左侧圆点连线 · Delete 删除选中
        </span>
      </div>
    </div>
  );
}
