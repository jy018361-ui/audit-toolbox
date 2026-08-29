import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";

const audipickRules = () => ({
  name: "audipick-rules",
  configureServer(server: {
    middlewares: {
      use: (
        route: string,
        handler: (
          req: unknown,
          res: {
            statusCode: number;
            setHeader: (key: string, value: string) => void;
            end: (body?: unknown) => void;
          },
          next: () => void,
        ) => void,
      ) => void;
    };
  }) {
    server.middlewares.use(
      "/audipick-rules",
      (request: unknown, response, next) => {
        const url = (request as { url?: string }).url?.split("?")[0] ?? "";
        const relative = decodeURIComponent(url).replace(/^\/+/, "");
        const root = resolve("assets/audipick/rules");
        const file = resolve(root, relative);
        if (!file.startsWith(root) || !existsSync(file)) return next();
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(readFileSync(file));
      },
    );
    server.middlewares.use(
      "/audipick-pdfjs",
      (request: unknown, response, next) => {
        const url = (request as { url?: string }).url?.split("?")[0] ?? "";
        const root = resolve("assets/audipick/pdfjs");
        const file = resolve(root, decodeURIComponent(url).replace(/^\/+/, ""));
        if (!file.startsWith(root) || !existsSync(file)) return next();
        response.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : "application/octet-stream",
        );
        response.end(readFileSync(file));
      },
    );
  },
  closeBundle() {
    const target = resolve("dist-web/audipick-rules");
    mkdirSync(target, { recursive: true });
    cpSync(resolve("assets/audipick/rules"), target, { recursive: true });
    // vendor 目录整拷会把 13MB 的调试件也塞进 EXE：未压缩的 pdf.js /
    // pdf.worker.js、从未加载的 pdf.sandbox.*、以及一批 .map（pdf.worker.js.map
    // 一个就 5.2MB）。运行时只用到 build 下的两个 .min.js 加 cmaps /
    // standard_fonts 两个数据目录（见 AudiPickPage.openDocument）。
    // 源目录保持完整，只在产物侧过滤，开发模式仍能用全部文件调试。
    const pdfjsRoot = resolve("assets/audipick/pdfjs");
    const runtimeBuildFiles = new Set(["pdf.min.js", "pdf.worker.min.js"]);
    cpSync(pdfjsRoot, resolve("dist-web/audipick-pdfjs"), {
      recursive: true,
      filter: (source) => {
        if (!source.startsWith(pdfjsRoot)) return false;
        const relative = source.slice(pdfjsRoot.length).replace(/\\/g, "/");
        // 目录一律放行，由其中的文件各自判断。
        if (!/\.[^/]+$/.test(relative)) return true;
        if (relative.startsWith("/legacy/build/")) {
          return runtimeBuildFiles.has(relative.split("/").pop() ?? "");
        }
        return !relative.endsWith(".map");
      },
    });
  },
});

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), audipickRules()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  // sourcemap 不进生产包：开着会把 3.6MB 的 .map 一起嵌进 EXE，而发布包里
  // 没有 devtools 去读它，纯占体积、拖慢冷启动读盘与杀软扫描。
  // 要调试打包产物时用 `vite build --mode development` 仍能拿到。
  build: {
    target: "chrome110",
    sourcemap: mode !== "production",
    outDir: "dist-web",
  },
}));
