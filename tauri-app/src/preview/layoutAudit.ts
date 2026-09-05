// 布局守卫审计器：在真实浏览器里量测"注数据之后"的常见布局问题。
// jsdom 拿不到真实布局，所以这套检查必须在浏览器里跑：
// 预览模式下自动挂到 window.__layoutAudit()，返回问题清单（也打印成表格）。
// 检查项：横向滚动、单行溢出、数据行折行、并排列表"一满一空"、按钮可用态混排。

export type LayoutIssue = {
  kind:
    | "横向滚动"
    | "单行溢出"
    | "数据行折行"
    | "空列表占大面积"
    | "并排列表一满一空"
    | "按钮可用态混排";
  severity: "warn" | "info";
  detail: string;
};

const LINE_HEIGHT_FALLBACK = 20;

function describe(el: Element): string {
  const cls = String(el.className).split(/\s+/).slice(0, 3).join(".");
  const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
  return `<${el.tagName.toLowerCase()}${cls ? ` .${cls}` : ""}> ${text}`;
}

/** 侧栏/导航/页头页脚是固定框架，不是数据区，折行与溢出检查跳过它们。 */
function inChrome(el: Element): boolean {
  return el.closest("aside, nav, header, footer, [class*=sidebar], .brand") !== null;
}

export function collectLayoutIssues(): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));

  // 1) 横向滚动：页面级与任何可滚动容器
  const doc = document.scrollingElement;
  if (doc && doc.scrollWidth > window.innerWidth + 2) {
    issues.push({
      kind: "横向滚动",
      severity: "warn",
      detail: `页面出现横向滚动（scrollWidth ${doc.scrollWidth} > 视口 ${window.innerWidth}）`,
    });
  }
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2) {
      issues.push({
        kind: "横向滚动",
        severity: "warn",
        detail: `容器横向溢出 ${describe(el)} (${el.scrollWidth}/${el.clientWidth})`,
      });
    }
  }

  for (const el of all) {
    if (!el.clientWidth || inChrome(el)) continue;
    const cs = getComputedStyle(el);

    // 2) 单行溢出：宽出容器且没有用省略号兜底
    if (
      el.scrollHeight <= el.clientHeight + 2 &&
      el.scrollWidth > el.clientWidth + 2 &&
      cs.textOverflow !== "ellipsis" &&
      el.children.length === 0
    ) {
      issues.push({
        kind: "单行溢出",
        severity: "warn",
        detail: `文字宽出未截断 ${describe(el)} (${el.scrollWidth}/${el.clientWidth})`,
      });
    }

    // 3) 数据行折行：可滚动列表里的条目高度超过两倍行高（列表至少 4 条才算"列表"）
    const parent = el.parentElement;
    const parentCs = parent ? getComputedStyle(parent) : null;
    const inScrollList =
      parent !== null &&
      parentCs !== null &&
      /(auto|scroll)/.test(parentCs.overflowY) &&
      parent.children.length >= 4;
    if (
      inScrollList &&
      el.children.length <= 3 &&
      el.clientHeight > LINE_HEIGHT_FALLBACK * 1.9 &&
      (el.textContent || "").trim().length > 10
    ) {
      issues.push({
        kind: "数据行折行",
        severity: "info",
        detail: `列表条目折成多行 ${describe(el)} (高 ${el.clientHeight}px)`,
      });
    }

    // 3b) 空列表占大面积：滚动容器里只剩一条空态提示，却撑着 180px 以上的版面
    if (
      /(auto|scroll)/.test(cs.overflowY) &&
      el.children.length <= 1 &&
      el.clientHeight > 180 &&
      (el.textContent || "").trim().length < 40
    ) {
      issues.push({
        kind: "空列表占大面积",
        severity: "warn",
        detail: `空列表占 ${el.clientHeight}px 高 ${describe(el)}`,
      });
    }
  }

  // 4) 并排列表"一满一空"：同排两个高容器，一个在滚动、另一个内容寥寥
  const seen = new Set<Element>();
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (!/(grid|flex)/.test(cs.display) || seen.has(el)) continue;
    const kids = Array.from(el.children).filter(
      (k): k is HTMLElement => k instanceof HTMLElement,
    );
    if (kids.length < 2) continue;
    const tall = kids.filter((k) => k.clientHeight > 150);
    if (tall.length < 2) continue;
    const full = tall.filter(
      (k) => k.scrollHeight > k.clientHeight + 8 || k.querySelector("[style*=overflow], .scroll-list"),
    );
    const empty = tall.filter(
      (k) =>
        (k.textContent || "").trim().length < 30 &&
        k.scrollHeight <= k.clientHeight + 8,
    );
    if (full.length >= 1 && empty.length >= 1) {
      for (const k of tall) seen.add(k);
      issues.push({
        kind: "并排列表一满一空",
        severity: "warn",
        detail: `同排容器内容悬殊：满 ${describe(full[0])} vs 空 ${describe(empty[0])}`,
      });
    }
  }

  // 5) 按钮可用态混排：同一行内禁用与可用按钮并存（信息级，可能合理）
  for (const el of all) {
    const buttons = Array.from(el.querySelectorAll(":scope > button, :scope > * > button"));
    if (buttons.length < 2) continue;
    const rect = el.getBoundingClientRect();
    const sameRow = buttons.every(
      (b) => Math.abs(b.getBoundingClientRect().top - rect.top) < rect.height,
    );
    if (!sameRow) continue;
    const states = new Set(
      buttons.map((b) => (b instanceof HTMLButtonElement && b.disabled ? "禁用" : "可用")),
    );
    if (states.size === 2) {
      issues.push({
        kind: "按钮可用态混排",
        severity: "info",
        detail: `同排按钮可用/禁用并存 ${describe(el)}`,
      });
    }
  }

  return issues;
}

// 预览模式自动挂载；桌面应用不注入任何全局。
if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
  (window as unknown as Record<string, unknown>).__layoutAudit = () => {
    const issues = collectLayoutIssues();
    console.table(issues);
    return issues;
  };
}

