import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Eye,
  FolderOpen,
  Play,
  Redo2,
  Save,
  Settings2,
  Undo2,
} from "lucide-react";

import { DataflowIcon } from "./icons";
import {
  DATAFLOW_CATEGORIES,
  categoryNodes,
  type DataflowCategory,
} from "./nodeSpecs";

export interface DataflowToolbarProps {
  flowName: string;
  onFlowNameChange: (name: string) => void;
  autosaveNote: string;
  onAddNode: (type: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onParams: () => void;
  onSave: () => void;
  onOpen: () => void;
  onPreviewRun: () => void;
  onFullRun: () => void;
  running: boolean;
}

/** 顶部工具栏：7 个分类菜单（第一期 8 节点可选，其余置灰标「二期」）＋右侧操作按钮。 */
export function DataflowToolbar({
  flowName,
  onFlowNameChange,
  autosaveNote,
  onAddNode,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onParams,
  onSave,
  onOpen,
  onPreviewRun,
  onFullRun,
  running,
}: DataflowToolbarProps) {
  const [openCategory, setOpenCategory] = useState<DataflowCategory | null>(null);
  const catsRef = useRef<HTMLDivElement | null>(null);

  // 点击分类区以外任意位置收起菜单。
  useEffect(() => {
    if (!openCategory) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!catsRef.current?.contains(event.target as Node)) setOpenCategory(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openCategory]);

  function addNode(type: string) {
    onAddNode(type);
    setOpenCategory(null);
  }

  return (
    <div className="df-toolbar">
      <span className="df-flow-name">
        <input
          value={flowName}
          aria-label="流程名称"
          title={flowName}
          onChange={(event) => onFlowNameChange(event.target.value)}
        />
        {autosaveNote && <span className="df-autosave">{autosaveNote}</span>}
      </span>
      <div className="df-cats" ref={catsRef}>
        {DATAFLOW_CATEGORIES.map((category) => (
          <div className="df-cat" key={category.id}>
            <button
              type="button"
              className="df-cat-btn"
              aria-expanded={openCategory === category.id}
              aria-haspopup="true"
              onClick={() =>
                setOpenCategory((current) => (current === category.id ? null : category.id))
              }
            >
              {category.cn}
              <ChevronDown size={12} />
            </button>
            {openCategory === category.id && (
              <div className="df-menu" role="menu">
                {categoryNodes(category.id).map((spec) =>
                  spec.phase2 ? (
                    <button key={spec.type} type="button" role="menuitem" disabled>
                      <DataflowIcon icon={spec.icon} />
                      {spec.cn} {spec.en}
                      <span className="df-menu-tag">二期</span>
                    </button>
                  ) : (
                    <button
                      key={spec.type}
                      type="button"
                      role="menuitem"
                      onClick={() => addNode(spec.type)}
                    >
                      <DataflowIcon icon={spec.icon} />
                      {spec.cn} {spec.en}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="df-tb-right">
        <button
          type="button"
          className="df-tool"
          aria-label="撤销"
          title="撤销（Ctrl+Z）"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 size={13} />
        </button>
        <button
          type="button"
          className="df-tool"
          aria-label="重做"
          title="重做（Ctrl+Y）"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 size={13} />
        </button>
        <span className="df-vr" aria-hidden="true" />
        <button type="button" className="df-tool" onClick={onParams}>
          <Settings2 size={13} />
          参数
        </button>
        <button type="button" className="df-tool" onClick={onSave}>
          <Save size={13} />
          保存
        </button>
        <button type="button" className="df-tool" onClick={onOpen}>
          <FolderOpen size={13} />
          打开
        </button>
        <span className="df-vr" aria-hidden="true" />
        <button type="button" className="df-tool" disabled={running} onClick={onPreviewRun}>
          <Eye size={13} />
          预览运行
        </button>
        <button type="button" className="df-tool" disabled={running} onClick={onFullRun}>
          <Play size={13} />
          全量运行
        </button>
      </div>
    </div>
  );
}
