import { defineConfig } from "vite";
export default defineConfig({
  root: "frontend",
  // Read VITE_* keys from the repo-root .env next to the backend's keys.
  envDir: "..",
  // Pre-bundle Firebase together; optimizing firestore later loads a second copy of @firebase/app.
  optimizeDeps: {
    include: ["firebase/app", "firebase/auth", "firebase/firestore"],
  },
  server: {
    port: 5178,
    strictPort: true,
    // End-to-end tests run their own backend on another port.
    proxy: {
      "/api": `http://127.0.0.1:${process.env.ROUTEWISE_API_PORT || 8018}`,
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
