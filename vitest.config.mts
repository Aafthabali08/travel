import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["frontend/src/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          // Unit tests must never reach the real Firebase project.
          env: { VITE_FIREBASE_API_KEY: "" },
        },
      },
      {
        test: {
          name: "rules",
          include: ["tests/rules/**/*.test.ts"],
          environment: "node",
          testTimeout: 30000,
          hookTimeout: 30000,
          fileParallelism: false,
        },
      },
    ],
  },
});
