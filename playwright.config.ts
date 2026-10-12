import { defineConfig } from "@playwright/test";

// Run with `npm run test:e2e`, which starts the Firebase Auth + Firestore emulators first.
// Tests get their own backend (8028) and frontend (5188) so a running dev server is untouched,
// and the frontend talks only to the emulators, never the real Firebase project.
const WEB = 5188;
const API = 8028;
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${WEB}`,
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: [
    {
      command: `.venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port ${API}`,
      url: `http://127.0.0.1:${API}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // Emulator tokens aren't Google-signed, so backend token checks stay off here
        // (they're covered by backend/tests/test_firebase_auth.py).
        FIREBASE_PROJECT_ID: "",
        DATABASE_URL: "",
        GEMINI_API_KEY: "",
        LOG_FILE: "",
      },
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${WEB}`,
      url: `http://127.0.0.1:${WEB}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ROUTEWISE_API_PORT: String(API),
        VITE_FIREBASE_EMULATORS: "1",
        VITE_FIREBASE_PROJECT_ID: "demo-routewise",
        VITE_FIREBASE_API_KEY: "demo-key",
        VITE_FIREBASE_AUTH_DOMAIN: "demo-routewise.firebaseapp.com",
        VITE_FIREBASE_APP_ID: "demo-app",
      },
    },
  ],
});
