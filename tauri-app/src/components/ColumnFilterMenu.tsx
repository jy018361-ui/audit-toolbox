import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

/** 引擎用这个字面量表示"该列为空"，勾选它等价于筛选空值行。 */
export const BLANK_TOKEN = "<空白>";
/** 一次最多读回多少个不同取值；超过就截断并提示用关键词缩小范围。 */
export const VALUE_LIMIT = 20000;

/** 一列取值的读取结果（引擎按关键词返回，超过上限会截断）。 */
export type ColumnFilterValues = {
  values: string[];
  /** 科目清单专用：与 values 同序一一对应的科目编码，用于「编码 名称」展示。 */
  codes?: string[];
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
  searchPlaceholder,
  splitCode,
}: {
  field: string;
  anchor: HTMLElement;
  loading: boolean;
  data?: ColumnFilterValues;
  selected: string[];
  onSearch: (keyword: string) => void;
  onApply: (checked: string[]) => void;
  onClose: () => void;
  /** 给单个取值挂一句灰字说明，例如"已在批次1"。返回空则不显示。 */
  valueNote?: (value: string) => string | undefined;
  /** 搜索框提示语，默认「搜索取值，回车重新读取」；科目面板传"可搜编码或名称"。 */
  searchPlaceholder?: string;
  /** 科目面板专用：把「编码-名称」拼接串拆成两段展示；其余列不拆。 */
  splitCode?: boolean;
}) {
  const [keyword, setKeyword] = useState(data?.keyword ?? "");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(selected));
  const panel = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const initialized = useRef(selected.length > 0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeAndRestoreFocus = () => {
    onCloseRef.current();
    if (anchor.isConnected) anchor.focus();
  };
  const closeAndRestoreFocusRef = useRef(closeAndRestoreFocus);
  closeAndRestoreFocusRef.current = closeAndRestoreFocus;
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  }>();

  // 无筛选时 Excel 默认显示「全选」。首次取值异步返回后补齐勾选；若结果被截断，
  // 则不能把眼前这一批冒充整列全选，否则直接应用会意外只保留前 VALUE_LIMIT 项。
  useEffect(() => {
    // Portal 初次挂载后让浏览器完成当前点击/焦点事件，再移入菜单。
    const frame = window.requestAnimationFrame(() => searchInput.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

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
      if (!panel.current?.contains(target as Node)) onCloseRef.current();
    }
    function keyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // 上层确认框拥有当前键盘交互；先关闭确认框，勿连带关闭底下的筛选。
        if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;
        event.preventDefault();
        closeAndRestoreFocusRef.current();
      }
    }
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("keydown", keyDown);
    return () => {
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("keydown", keyDown);
    };
  }, []);

  // 触发器可能位于横向预览表或长页面里。始终读取它的当前视口坐标，
  // 页面/表格滚动后即时重排；弹层放不下时翻到上方，操作按钮仍留在视口内。
  useLayoutEffect(() => {
    const place = () => {
      if (!anchor.isConnected) {
        onCloseRef.current();
        return;
      }
      const edge = 8;
      const gap = 6;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(360, Math.max(240, window.innerWidth - edge * 2));
      const maxHeight = Math.max(220, window.innerHeight - edge * 2);
      const height = Math.min(panel.current?.scrollHeight ?? 420, maxHeight);
      const below = window.innerHeight - rect.bottom - edge - gap;
      const above = rect.top - edge - gap;
      const top = below >= Math.min(height, 320) || below >= above
        ? rect.bottom + gap
        : rect.top - height - gap;
      const preferredLeft = rect.left + rect.width / 2 - width / 2;
      setPosition({
        left: Math.min(Math.max(preferredLeft, edge), window.innerWidth - width - edge),
        top: Math.min(Math.max(top, edge), window.innerHeight - height - edge),
        width,
        maxHeight,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (panel.current) observer?.observe(panel.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer?.disconnect();
    };
  }, [anchor, data?.values.length, data?.truncated, loading]);

  const values = data?.values ?? [];
  // 本批取值里已勾中的数量决定"（全选）"的三态；用户勾过、但不在本批里的值
  // （关键词换过）不算进来，但提交时要保留，否则搜一次就把别的勾选清了。
  const visibleChecked = values.filter((value) => checked.has(value));
  const allChecked = values.length > 0 && visibleChecked.length === values.length;
  const someChecked = visibleChecked.length > 0 && !allChecked;
  const visibleValues = new Set(values);
  const hiddenChecked = [...checked].filter((value) => !visibleValues.has(value));

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
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        width: position?.width ?? 360,
        maxHeight: position?.maxHeight,
        visibility: position ? "visible" : "hidden",
      }}
      role="dialog"
      aria-modal="false"
      aria-label={`筛选 ${field}`}
    >
      <div className="ts-filter-menu-title" title={field}>
        {field}
      </div>
      <div className="ts-filter-menu-search">
        <input
          ref={searchInput}
          value={keyword}
          placeholder={searchPlaceholder ?? "搜索取值，回车重新读取…"}
          aria-label={`搜索${field}`}
          name={`column-filter-${field}`}
          autoComplete="off"
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
          {loading ? "读取中…" : "读取"}
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
          values.map((value, index) => {
            // 科目面板把值拆成「编码 名称」两段：拼接串按首段编码拆开；值里没有
            // 编码（纯名称）而引擎另给了编码时补在前面。编码只作展示，勾选提交的
            // 仍是原值，后端按原值匹配，口径不变。
            const split = splitCode ? splitAccountCode(value) : undefined;
            const fallback = split ? "" : (data?.codes?.[index]?.trim() ?? "");
            const code = split?.code || (fallback && fallback !== value ? fallback : "");
            const name = split ? split.name : value;
            return (
              <label
                className="ts-filter-value"
                key={value}
                title={code ? `${code} ${name}` : value}
              >
                <input
                  type="checkbox"
                  checked={checked.has(value)}
                  onChange={() => toggle(value)}
                />
                {code && <span className="ts-filter-code">{code}</span>}
                <span className={value === BLANK_TOKEN ? "ts-filter-blank" : undefined}>
                  {name}
                </span>
                {(() => {
                  const note = valueNote?.(value);
                  return note ? <span className="jm-value-note">{note}</span> : null;
                })()}
              </label>
            );
          })
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
        <Button type="button" variant="secondary" size="sm" onClick={closeAndRestoreFocus}>
          取消
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => {
            onApply([...checked]);
            if (anchor.isConnected) anchor.focus();
          }}
        >
          确认选择
        </Button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 「编码-名称」拼接串（如 `1403.01-原材料 - 原材料`）拆成两段供展示。
 * 首段只认数字/字母/点组成的编码样式，名称自带的连字符（`原材料-原材料`）
 * 不会被误拆。拆不开返回 undefined。
 */
function splitAccountCode(value: string): { code: string; name: string } | undefined {
  const dash = value.indexOf("-");
  if (dash <= 0 || dash === value.length - 1) return undefined;
  const code = value.slice(0, dash).trim();
  const name = value.slice(dash + 1).trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._]*$/.test(code) || !name) return undefined;
  return { code, name };
}

/** 预览表头里的漏斗按钮：已筛选的显示勾中个数，再次点击收起面板。 */
export function ColumnFilterTrigger({field,chosen,expanded,onToggle}:{
  field:string;chosen:string[];expanded:boolean;onToggle:(anchor:HTMLElement|undefined)=>void;
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
        onToggle(event.currentTarget);
      }}
    >
      <span className="ts-filter-icon">▼</span>
      {chosen.length > 0 && (
        <span className="ts-filter-badge">{chosen.length}</span>
      )}
    </button>
  );
}
