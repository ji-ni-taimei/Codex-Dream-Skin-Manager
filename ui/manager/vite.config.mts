import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)), base: "./",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  // A single classic bundle also works with WKWebView's restricted file loader;
  // no module fetch, dev server or file-origin CORS relaxation is necessary.
  build: { outDir: "../../build/ui/manager", emptyOutDir: true, target: "es2022",
    lib: { entry: fileURLToPath(new URL("./src/main.tsx", import.meta.url)), name: "DreamSkinManager",
      formats: ["iife"], fileName: () => "manager.js", cssFileName: "style" },
  },
  plugins: [{ name: "offline-manager-page", generateBundle() {
    const source = readFileSync(new URL("./index.html", import.meta.url), "utf8")
      .replace('<script type="module" src="./src/main.tsx"></script>', '<link rel="stylesheet" href="./style.css" /><script defer src="./manager.js"></script>');
    this.emitFile({ type: "asset", fileName: "index.html", source });
  } }],
});
