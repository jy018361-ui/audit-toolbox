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
    cpSync(
      resolve("assets/audipick/pdfjs"),
      resolve("dist-web/audipick-pdfjs"),
      { recursive: true },
    );
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), audipickRules()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "chrome110", sourcemap: true, outDir: "dist-web" },
});
