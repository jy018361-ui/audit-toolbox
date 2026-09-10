// 文件名/导入大小写预检：在 CI 编译开始前拦截 TS1261 类错误。
// 背景：Windows 磁盘不区分大小写，本地开发察觉不到工作树文件名
// 与 git 记录的 casing 漂移，云端 Linux 构建会直接失败。
// 判定一律以 `git ls-files` 的记录为基准做区分大小写的比对，
// 因此本脚本在 Windows / Linux 上行为一致。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: appDir,
  encoding: "utf8",
}).trim();

const tracked = execFileSync("git", ["ls-files"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .map((p) => p.replace(/\\/g, "/"));

const errors = [];

// 1) git 里存在仅大小写不同的两条路径：Windows 检出时互相覆盖，必坏。
const byLower = new Map();
for (const p of tracked) {
  const key = p.toLowerCase();
  if (byLower.has(key)) {
    errors.push(`git 记录了仅大小写不同的两个路径：\n  ${byLower.get(key)}\n  ${p}`);
  } else {
    byLower.set(key, p);
  }
}

// 2) 相对导入的路径必须与 git 记录的文件名逐字符一致（含目录各段）。
const trackedSet = new Set(tracked);
const srcPrefix = "tauri-app/src/";
const srcFiles = tracked.filter(
  (p) => p.startsWith(srcPrefix) && /\.tsx?$/.test(p),
);
const importPattern =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.[^"']+)["']/g;

function candidates(imp) {
  const base = imp.replace(/\.(js|mjs|cjs)$/, "");
  return [imp, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`];
}

for (const relFile of srcFiles) {
  const abs = path.join(repoRoot, relFile);
  const text = (await import("node:fs")).readFileSync(abs, "utf8");
  for (const m of text.matchAll(importPattern)) {
    const imp = m[1];
    const resolved = path
      .join(path.posix.dirname(relFile), imp)
      .replace(/\\/g, "/");
    if (candidates(resolved).some((c) => trackedSet.has(c))) continue;
    const ci = candidates(resolved)
      .map((c) => byLower.get(c.toLowerCase()))
      .find(Boolean);
    if (ci) {
      errors.push(
        `${relFile} 引用 "${imp}"：git 中实际为 ${ci}（大小写不一致，云端必失败）`,
      );
    }
    // 大小写敏感环境下也不存在、且无近似项的引用不归本脚本管
    // （交给 tsc 报 TS2307），这里只盯 casing。
  }
}

if (errors.length > 0) {
  console.error(`大小写预检发现 ${errors.length} 处问题：`);
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}
console.log("大小写预检通过：文件名与导入引用无 casing 漂移。");
