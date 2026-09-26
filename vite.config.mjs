import { defineConfig } from "vite";
export default defineConfig({
  root: "frontend",
  server: {
    port: 5178,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8018" },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
