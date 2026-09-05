const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/*
 * Static geometry gate for every top-level page.
 *
 * Run against `npx vite preview --host 127.0.0.1 --port 1422`.
 * The effective widths intentionally include every shared breakpoint boundary
 * and the CSS viewport produced by common 125% / 150% desktop zoom levels.
 * Dialogs and task-driven overlays are covered by their own state audit.
 */
const baseUrl = process.env.STATIC_AUDIT_URL || "http://127.0.0.1:1422";
const catalog = JSON.parse(fs.readFileSync("public/tool-catalog.json", "utf8"));
const routes = ["/", "/history", "/settings", ...catalog.map((tool) => tool.route)];
const viewports = [
  { width: 1600, height: 900, label: "1600@100%" },
  { width: 1440, height: 900, label: "1440@100%" },
  { width: 1280, height: 800, label: "1280@100%" },
  { width: 1279, height: 800, label: "1279-boundary" },
  { width: 1180, height: 760, label: "1180-boundary" },
  { width: 1179, height: 760, label: "1179-boundary" },
  { width: 1152, height: 720, label: "1440@125%" },
  { width: 1067, height: 640, label: "1600@150%" },
  { width: 1000, height: 680, label: "1000-compact" },
  { width: 960, height: 640, label: "960-compact" },
  { width: 900, height: 640, label: "900-compact" },
];

const geometryAudit = () => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      !element.closest("[hidden], [inert], [role=dialog], .dialog-overlay")
    );
  };
  const root = document.querySelector("main, .main");
  const issues = [];
  if (!root) return [{ kind: "missing-main", selector: "body" }];
  const elements = [...root.querySelectorAll("*")].filter(visible);
  const selector = (element) => {
    if (element.id) return `#${element.id}`;
    const classes = [...element.classList].slice(0, 3).join(".");
    return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
  };
  const rect = (element) => element.getBoundingClientRect();
  const rounded = (value) => Math.round(value * 10) / 10;
  const add = (kind, element, detail) =>
    issues.push({ kind, selector: selector(element), detail });

  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    add("page-overflow", root, {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    });
  }

  for (const element of elements) {
    const style = getComputedStyle(element);
    const box = rect(element);
    const overflowX = style.overflowX;
    const overflowY = style.overflowY;
    const scrollX = element.scrollWidth > element.clientWidth + 2;
    const scrollY = element.scrollHeight > element.clientHeight + 2;
    const scrollAllowedX = /(auto|scroll)/.test(overflowX);
    const scrollAllowedY = /(auto|scroll)/.test(overflowY);

    if (
      scrollX &&
      !scrollAllowedX &&
      style.textOverflow !== "ellipsis" &&
      !["TABLE", "THEAD", "TBODY", "TR"].includes(element.tagName)
    ) {
      add("child-overflow-x", element, {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        overflowX,
      });
    }
    if (
      scrollY &&
      element.scrollHeight > element.clientHeight + 4 &&
      !scrollAllowedY &&
      /(hidden|clip)/.test(overflowY)
    ) {
      add("clipped-y", element, {
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY,
      });
    }

    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(element.tagName)) {
      const rootBox = rect(root);
      if (box.left < rootBox.left - 1 || box.right > rootBox.right + 1) {
        add("control-outside-main", element, {
          left: rounded(box.left),
          right: rounded(box.right),
          mainLeft: rounded(rootBox.left),
          mainRight: rounded(rootBox.right),
        });
      }
      const label = element.closest("label");
      const labelBox = label?.getBoundingClientRect();
      const hasLabelHitArea = labelBox && labelBox.width >= 24 && labelBox.height >= 24;
      if (
        (box.width < 24 || box.height < 24) &&
        !hasLabelHitArea &&
        !["checkbox", "radio"].includes(element.type)
      ) {
        add("small-control", element, {
          width: rounded(box.width),
          height: rounded(box.height),
        });
      }
    }
  }

  for (const parent of [root, ...elements]) {
    const parentStyle = getComputedStyle(parent);
    if (
      ["contents", "inline"].includes(parentStyle.display) ||
      parent.closest("svg, .theme-option-swatches")
    )
      continue;
    const children = [...parent.children].filter(visible).filter((child) => {
      const style = getComputedStyle(child);
      return !["absolute", "fixed", "sticky"].includes(style.position) && style.float === "none";
    });
    for (let i = 0; i < children.length; i += 1) {
      const a = children[i];
      const aBox = rect(a);
      for (let j = i + 1; j < children.length; j += 1) {
        const b = children[j];
        const bBox = rect(b);
        const overlapX = Math.min(aBox.right, bBox.right) - Math.max(aBox.left, bBox.left);
        const overlapY = Math.min(aBox.bottom, bBox.bottom) - Math.max(aBox.top, bBox.top);
        if (overlapX > 2 && overlapY > 2) {
          add("sibling-overlap", b, {
            with: selector(a),
            overlapX: rounded(overlapX),
            overlapY: rounded(overlapY),
            parent: selector(parent),
          });
        }
      }
    }
  }

  return issues;
};

(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-proxy-server"],
  });
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-static-layout-"));
  const results = [];
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("audit-toolbox.newbie-mode", "0");
        localStorage.setItem("audit-toolbox.demo-data", "1");
      });
      for (const route of routes) {
        console.log(`Auditing ${viewport.label} ${route}`);
        await page.goto(`${baseUrl}/#${route}`, { waitUntil: "domcontentloaded" });
        await page.locator(".main").waitFor();
        try {
          await page.locator(".page-header:visible").first().waitFor({ timeout: 12_000 });
        } catch {
          results.push({
            viewport: viewport.label,
            route,
            issues: [{ kind: "page-render-failed", selector: ".page-header" }],
          });
          continue;
        }
        await page.evaluate(async () => {
          document.documentElement.dataset.theme = "blue-white";
          for (const details of document.querySelectorAll("main details")) details.open = true;
          await document.fonts.ready;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const issues = await page.evaluate(geometryAudit);
        results.push({ viewport: viewport.label, route, issues });
        if (issues.length) {
          const safeRoute = route === "/" ? "workspace" : route.replaceAll("/", "_");
          await page.screenshot({
            path: path.join(output, `${viewport.label}-${safeRoute}.png`),
            fullPage: true,
          });
        }
      }
      await context.close();
      console.log(`Completed ${viewport.label}`);
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(results, null, 2));
  const failures = results.filter((result) => result.issues.length);
  const summary = failures.slice(0, 80).map((result) => ({
    viewport: result.viewport,
    route: result.route,
    issues: result.issues.slice(0, 12),
  }));
  console.log(JSON.stringify({ output, cases: results.length, failures: failures.length, summary }, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
