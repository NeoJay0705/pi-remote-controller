import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
