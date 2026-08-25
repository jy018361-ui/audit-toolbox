import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

/** 引擎用这个字面量表示"该列为空"，勾选它等价于筛选空值行。 */
export const BLANK_TOKEN = "<空白>";
/** 一次最多读回多少个不同取值；超过就截断并提示用关键词缩小范围。 */
export const VALUE_LIMIT = 20000;

/** 一列取值的读取结果（引擎按关键词返回，超过上限会截断）。 */
export type ColumnFilterValues = {
  values: string[];
  total: number;
  truncated: boolean;
  keyword: string;
};

/**
 * Excel 式列筛选：搜索、（全选）三态、复选清单、截断提示、清除/取消/应用。
 * TS 管理与正负数凭证标记共用，样式沿用 styles.css 里的 ts-filter-* 类。
 *
 * 用 portal 挂到 body 并按触发按钮定位——预览表是个 `overflow:auto` 的滚动
 * 容器，面板留在 `<th>` 里会被裁掉。
 */
export function ColumnFilterMenu({
  field,
  anchor,
  loading,
  data,
  selected,
  onSearch,
  onApply,
  onClose,
  valueNote,
}: {
  field: string;
  anchor: DOMRect;
  loading: boolean;
  data?: ColumnFilterValues;
  selected: string[];
  onSearch: (keyword: string) => void;
  onApply: (checked: string[]) => void;
  onClose: () => void;
  /** 给单个取值挂一句灰字说明，例如"已在批次1"。返回空则不显示。 */
  valueNote?: (value: string) => string | undefined;
}) {
  const [keyword, setKeyword] = useState(data?.keyword ?? "");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(selected));
  const panel = useRef<HTMLDivElement>(null);
  const initialized = useRef(selected.length > 0);

  // 无筛选时 Excel 默认显示「全选」。首次取值异步返回后补齐勾选；若结果被截断，
  // 则不能把眼前这一批冒充整列全选，否则直接应用会意外只保留前 VALUE_LIMIT 项。
  useEffect(() => {
    if (initialized.current || !data || data.truncated) return;
    initialized.current = true;
    setChecked(new Set(data.values));
  }, [data]);

  useEffect(() => {
    function pointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      // 点触发按钮时不在这里关：让按钮自己的 onClick 决定开还是合。
      if (target?.closest("[data-ts-filter-trigger]")) return;
      if (!panel.current?.contains(target as Node)) onClose();
    }
    function keyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("keydown", keyDown);
    return () => {
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("keydown", keyDown);
    };
  }, [onClose]);

  const values = data?.values ?? [];
  // 本批取值里已勾中的数量决定"（全选）"的三态；用户勾过、但不在本批里的值
  // （关键词换过）不算进来，但提交时要保留，否则搜一次就把别的勾选清了。
  const visibleChecked = values.filter((value) => checked.has(value));
  const allChecked = values.length > 0 && visibleChecked.length === values.length;
  const someChecked = visibleChecked.length > 0 && !allChecked;
  const hiddenChecked = [...checked].filter((value) => !values.includes(value));

  const width = 268;
  const left = Math.min(
    Math.max(8, anchor.left),
    Math.max(8, window.innerWidth - width - 8),
  );
  const top = Math.min(anchor.bottom + 4, Math.max(8, window.innerHeight - 340));

  function toggle(value: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  return createPortal(
    <div
      ref={panel}
      className="ts-filter-menu"
      style={{ left, top, width }}
      role="dialog"
      aria-label={`筛选 ${field}`}
    >
      <div className="ts-filter-menu-title" title={field}>
        {field}
      </div>
      <div className="ts-filter-menu-search">
        <input
          value={keyword}
          placeholder="搜索取值，回车重新读取"
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            onSearch(keyword);
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => onSearch(keyword)}
        >
          {loading ? "读取中" : "读取"}
        </Button>
      </div>
      <label className="ts-filter-all">
        <input
          type="checkbox"
          checked={allChecked}
          ref={(node) => {
            if (node) node.indeterminate = someChecked;
          }}
          disabled={!values.length}
          onChange={(event) =>
            setChecked((current) => {
              const next = new Set(current);
              for (const value of values) {
                if (event.target.checked) next.add(value);
                else next.delete(value);
              }
              return next;
            })
          }
        />
        <span>（全选）</span>
      </label>
      <div className="ts-filter-values">
        {loading && !values.length ? (
          <div className="ts-filter-empty">正在读取取值…</div>
        ) : !values.length ? (
          <div className="ts-filter-empty">没有匹配的取值</div>
        ) : (
          values.map((value) => (
            <label className="ts-filter-value" key={value} title={value}>
              <input
                type="checkbox"
                checked={checked.has(value)}
                onChange={() => toggle(value)}
              />
              <span className={value === BLANK_TOKEN ? "ts-filter-blank" : undefined}>
                {value}
              </span>
              {(() => {
                const note = valueNote?.(value);
                return note ? <span className="jm-value-note">{note}</span> : null;
              })()}
            </label>
          ))
        )}
      </div>
      {data?.truncated && (
        <div className="ts-filter-note">
          共 {data.total} 个取值，只列出前 {values.length} 个，请输入关键词后重新读取。
        </div>
      )}
      {hiddenChecked.length > 0 && (
        <div className="ts-filter-note">
          另有 {hiddenChecked.length} 个已选取值不在当前搜索结果里，会一并保留。
        </div>
      )}
      <div className="ts-filter-actions">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setChecked(new Set())}
        >
          清除
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          取消
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => onApply([...checked])}
        >
          应用
        </Button>
      </div>
    </div>,
    document.body,
  );
}

/** 预览表头里的漏斗按钮：已筛选的显示勾中个数，再次点击收起面板。 */
export function ColumnFilterTrigger({field,chosen,expanded,onToggle}:{
  field:string;chosen:string[];expanded:boolean;onToggle:(anchor:DOMRect|undefined)=>void;
}){
  return (
    <button
      type="button"
      data-ts-filter-trigger=""
      className={`ts-filter-trigger${chosen.length ? " active" : ""}`}
      aria-label={`筛选 ${field}${chosen.length ? `，已选 ${chosen.length} 项` : ""}`}
      aria-expanded={expanded}
      title={
        chosen.length
          ? `已选 ${chosen.length} 个取值：${chosen.slice(0, 5).join("、")}${chosen.length > 5 ? "…" : ""}`
          : `筛选「${field}」`
      }
      onClick={(event) => {
        if (expanded) {
          onToggle(undefined);
          return;
        }
        onToggle(event.currentTarget.getBoundingClientRect());
      }}
    >
      <span className="ts-filter-icon">▼</span>
      {chosen.length > 0 && (
        <span className="ts-filter-badge">{chosen.length}</span>
      )}
    </button>
  );
}
