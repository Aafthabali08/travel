type Level = "INFO" | "WARN" | "ERROR";
export function log(event: string, detail = "", level: Level = "INFO") {
  console[level === "ERROR" ? "error" : level === "WARN" ? "warn" : "info"](
    `[RouteWise] ${event}`,
    detail,
  );
  if (level === "INFO") return;
  fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, detail, level }),
  }).catch(() => {});
}
// auth.tsx registers this so API calls carry the Firebase ID token (kept here to avoid an import cycle).
let tokenProvider: () => Promise<string | null> = async () => null;
export function setTokenProvider(fn: () => Promise<string | null>) {
  tokenProvider = fn;
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const started = performance.now();
  log("request.started", path.split("?")[0]);
  try {
    const token = await tokenProvider().catch(() => null);
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        `${data.error || "Request failed"}${data.request_id ? ` (ID: ${data.request_id})` : ""}`,
      );
    log(
      "request.completed",
      `${path.split("?")[0]} · ${Math.round(performance.now() - started)}ms`,
    );
    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    log(
      "request.failed",
      `${path.split("?")[0]} · ${error instanceof Error ? error.message : "Network error"}`,
      "ERROR",
    );
    throw error;
  }
}
window.addEventListener("error", (e) =>
  log("runtime.error", e.message, "ERROR"),
);
window.addEventListener("unhandledrejection", (e) =>
  log("runtime.rejection", String(e.reason), "ERROR"),
);
