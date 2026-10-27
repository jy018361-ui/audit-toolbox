import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import {
  DATAFLOW_PARAM_TYPES,
  type DataflowParam,
  type DataflowParamType,
} from "./model";

export interface ParamsDialogProps {
  /** edit＝编辑参数定义（id/名称/类型/默认值）；confirm＝打开流程后的参数确认（只改值）。 */
  mode: "edit" | "confirm";
  params: DataflowParam[];
  onCancel: () => void;
  onApply: (params: DataflowParam[]) => void;
}

function newParamId(params: DataflowParam[]): string {
  const used = new Set(params.map((param) => param.id));
  let index = params.length + 1;
  while (used.has(`p${index}`)) index += 1;
  return `p${index}`;
}

/**
 * 参数弹窗。两种形态：
 * - 参数确认页（打开流程时）：列出全部参数与当前值，改完再运行；
 * - 参数定义编辑（工具栏「参数」）：可增删改 id/名称/类型/默认值。
 */
export function ParamsDialog({ mode, params, onCancel, onApply }: ParamsDialogProps) {
  const [draft, setDraft] = useState<DataflowParam[]>(() => params.map((param) => ({ ...param })));
  const [error, setError] = useState("");

  function applyEdits() {
    if (mode === "confirm") {
      onApply(draft);
      return;
    }
    const ids = new Set<string>();
    for (const param of draft) {
      const id = param.id.trim();
      if (!id || !param.name.trim()) {
        setError("参数的 id 与名称均不能为空。");
        return;
      }
      if (ids.has(id)) {
        setError(`参数 id「${id}」重复，请修改后保存。`);
        return;
      }
      ids.add(id);
    }
    onApply(
      draft.map((param) => ({
        id: param.id.trim(),
        name: param.name.trim(),
        type: param.type,
        value: param.value,
      })),
    );
  }

  return (
    <div className="df-mask" role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <div className="df-modal" role="dialog" aria-modal="true" aria-label="数据流参数">
        <h3 className="df-modal-title">
          {mode === "confirm" ? "参数确认 · 核对参数值后再运行" : "参数定义 · 保存前可维护参数"}
        </h3>
        <p className="df-modal-sub">
          参数用于「换一批数据重跑」：输入路径、期间、金额门槛等运行参数与流程逻辑分离。
          路径与输出文件名可用 <code>{"{参数id}"}</code> 占位（如 大额客商_{"{p1}"}.xlsx），
          运行前在此确认取值。
        </p>
        {mode === "edit" ? (
          <>
            <div className="df-param-grid">
              <span className="df-param-head">id</span>
              <span className="df-param-head">名称</span>
              <span className="df-param-head">类型</span>
              <span className="df-param-head">默认值</span>
              <span />
            </div>
            {draft.map((param, index) => (
              <div className="df-param-grid" key={index}>
                <input
                  className="df-in"
                  value={param.id}
                  aria-label={`参数 ${index + 1} id`}
                  onChange={(event) =>
                    setDraft(
                      draft.map((item, i) =>
                        i === index ? { ...item, id: event.target.value } : item,
                      ),
                    )
                  }
                />
                <input
                  className="df-in"
                  value={param.name}
                  aria-label={`参数 ${index + 1} 名称`}
                  onChange={(event) =>
                    setDraft(
                      draft.map((item, i) =>
                        i === index ? { ...item, name: event.target.value } : item,
                      ),
                    )
                  }
                />
                <select
                  className="df-in"
                  value={param.type}
                  aria-label={`参数 ${index + 1} 类型`}
                  onChange={(event) =>
                    setDraft(
                      draft.map((item, i) =>
                        i === index
                          ? { ...item, type: event.target.value as DataflowParamType }
                          : item,
                      ),
                    )
                  }
                >
                  {DATAFLOW_PARAM_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
                <input
                  className="df-in"
                  value={param.value}
                  aria-label={`参数 ${index + 1} 默认值`}
                  onChange={(event) =>
                    setDraft(
                      draft.map((item, i) =>
                        i === index ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="df-collapse-btn"
                  aria-label={`删除参数 ${param.name || param.id}`}
                  onClick={() => setDraft(draft.filter((_, i) => i !== index))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="df-btn-sm"
                onClick={() =>
                  setDraft([
                    ...draft,
                    { id: newParamId(draft), name: "", type: "text", value: "" },
                  ])
                }
              >
                <Plus size={12} style={{ verticalAlign: "-2px" }} /> 新增参数
              </button>
            </div>
            {error && <p className="df-param-error">{error}</p>}
          </>
        ) : (
          <>
            {draft.length === 0 && (
              <div className="df-placeholder">该流程没有定义参数，直接确定即可。</div>
            )}
            {draft.map((param, index) => (
              <div className="df-f" key={param.id || index}>
                <label>
                  {param.name || param.id}（{param.id} ·{" "}
                  {DATAFLOW_PARAM_TYPES.find((type) => type.value === param.type)?.label ?? param.type}）
                </label>
                <input
                  className="df-in"
                  value={param.value}
                  aria-label={`参数 ${param.name || param.id} 的值`}
                  onChange={(event) =>
                    setDraft(
                      draft.map((item, i) =>
                        i === index ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </>
        )}
        <div className="df-modal-btns">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="df-modal-primary" onClick={applyEdits}>
            {mode === "confirm" ? "确定" : "保存参数定义"}
          </button>
        </div>
      </div>
    </div>
  );
}
