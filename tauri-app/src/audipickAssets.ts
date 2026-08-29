/**
 * AudiPick 的 PDF 引擎与规则脚本按需加载。
 *
 * 这些脚本原先写在 index.html 的 <head> 之后、主程序之前，是一串同步 <script>：
 * 浏览器内核必须把 pdf.min.js（377KB）和十几个规则/提示词文件全部执行完，
 * React 才开始画第一帧。而它们只有 AudiPick 一个工具用得上，其余十六个工具
 * 白等一次。改为进入 AudiPick 页面时才加载。
 *
 * 顺序不能动——它就是 index.html 里原来的顺序：
 * revenue_workpaper.js 先发布 REVENUE_WORKPAPER_QUESTIONS，
 * prompts/revenue_workpaper.js 在自己加载时就要读它来拼底稿问题清单；
 * registry.js / fieldset.js 收尾，依赖前面所有 prompts 已注册。
 * 传统脚本（非 module）之间靠执行顺序传递全局，所以这里必须串行 await，
 * 不能并行注入——动态创建的 <script> 默认 async，并行会打乱顺序。
 */
const SCRIPTS = [
  "/audipick-pdfjs/legacy/build/pdf.min.js",
  "/audipick-rules/revenue_workpaper.js",
  "/audipick-rules/prompts/loan_covenant.js",
  "/audipick-rules/prompts/loan_general.js",
  "/audipick-rules/prompts/revenue.js",
  "/audipick-rules/prompts/revenue_workpaper.js",
  "/audipick-rules/prompts/procurement.js",
  "/audipick-rules/prompts/invoicing_agreement.js",
  "/audipick-rules/prompts/statement.js",
  "/audipick-rules/prompts/invoice.js",
  "/audipick-rules/prompts/warehouse_io.js",
  "/audipick-rules/prompts/account_opening.js",
  "/audipick-rules/prompts/tax_declaration.js",
  "/audipick-rules/prompts/credit_report.js",
  "/audipick-rules/prompts/tax_audit_report.js",
  "/audipick-rules/registry.js",
  "/audipick-rules/fieldset.js",
];

let pending: Promise<void> | undefined;
let ready = false;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-audipick-asset="${src}"]`,
    );
    if (existing) {
      resolve();
      return;
    }
    const element = document.createElement("script");
    element.src = src;
    element.async = false;
    element.dataset.audipickAsset = src;
    element.addEventListener("load", () => resolve());
    element.addEventListener("error", () =>
      reject(new Error(`加载 AudiPick 组件失败：${src}`)),
    );
    document.head.appendChild(element);
  });
}

/** 已加载完毕时为 true——用于让页面首次渲染就跳过加载态。 */
export function audipickAssetsReady(): boolean {
  return ready;
}

/**
 * 加载 AudiPick 所需的全部本地脚本。多次调用共享同一个 Promise；
 * 失败后清空缓存，让用户重新进入页面时可以再试一次。
 */
export function loadAudipickAssets(): Promise<void> {
  if (ready) return Promise.resolve();
  if (!pending) {
    pending = (async () => {
      for (const src of SCRIPTS) {
        await loadScript(src);
      }
      ready = true;
    })().catch((error) => {
      pending = undefined;
      throw error;
    });
  }
  return pending;
}
