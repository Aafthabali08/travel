import { describe, expect, it, vi, afterEach } from "vitest";
import { Timestamp } from "firebase/firestore";
import {
  ago,
  blockReason,
  compressImage,
  dateKey,
  explainFirestore,
  lastDays,
  safeLink,
  statusLabel,
  ticketNo,
} from "./data";

const allowed = {
  signedIn: true,
  blocked: false,
  searchesToday: 0,
  dailyLimit: 30,
  searchesAllUsersToday: 0,
  dailyApiBudget: 500,
};

describe("blockReason", () => {
  it("asks visitors to sign in before anything", () => {
    expect(blockReason({ ...allowed, signedIn: false })).toBe("login");
    expect(blockReason({ ...allowed, signedIn: false }, "searches")).toBe("login");
  });
  it("lets an ordinary signed-in user through", () => {
    expect(blockReason(allowed, "searches")).toBe("");
    expect(blockReason(allowed, "locates")).toBe("");
    expect(blockReason(allowed)).toBe("");
  });
  it("stops blocked users from every action", () => {
    expect(blockReason({ ...allowed, blocked: true })).toMatch(/paused/);
    expect(blockReason({ ...allowed, blocked: true }, "locates")).toMatch(/paused/);
  });
  it("enforces the personal daily limit exactly at the limit", () => {
    expect(blockReason({ ...allowed, searchesToday: 29 }, "searches")).toBe("");
    expect(blockReason({ ...allowed, searchesToday: 30 }, "searches")).toMatch(/all 30 route searches/);
    expect(blockReason({ ...allowed, dailyLimit: 0 }, "searches")).toMatch(/all 0/);
  });
  it("only counts the limit against searches", () => {
    expect(blockReason({ ...allowed, searchesToday: 99 }, "locates")).toBe("");
  });
  it("enforces the app-wide budget", () => {
    expect(blockReason({ ...allowed, searchesAllUsersToday: 500 }, "searches")).toMatch(/capacity/);
    expect(blockReason({ ...allowed, searchesAllUsersToday: 499 }, "searches")).toBe("");
  });
});

describe("safeLink", () => {
  it("allows in-app hash routes", () => {
    expect(safeLink("#/support/abc123")).toBe("#/support/abc123");
    expect(safeLink("#/admin/tickets/X_y-1")).toBe("#/admin/tickets/X_y-1");
    expect(safeLink("#/")).toBe("#/");
  });
  it("rejects anything that could run script or leave the app", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "https://evil.example",
      "//evil.example",
      "#/x\" onmouseover=\"alert(1)",
      "#/support?x=<script>",
      "data:text/html,hi",
      "",
      undefined,
    ])
      expect(safeLink(bad)).toBeUndefined();
  });
});

describe("dates and labels", () => {
  afterEach(() => vi.useRealTimers());
  it("formats local calendar dates with padding", () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dateKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
  it("lists the last N days oldest first, ending today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 2, 10));
    expect(lastDays(3)).toEqual(["2026-02-28", "2026-03-01", "2026-03-02"]);
  });
  it("describes how long ago something happened", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 10, 12));
    const at = (msAgo: number) => Timestamp.fromMillis(Date.now() - msAgo);
    expect(ago(undefined)).toBe("just now");
    expect(ago(at(30_000))).toBe("just now");
    expect(ago(at(5 * 60_000))).toBe("5m ago");
    expect(ago(at(3 * 3600_000))).toBe("3h ago");
    expect(ago(at(2 * 86400_000))).toBe("2d ago");
  });
  it("shows short ticket numbers and status names", () => {
    expect(ticketNo("abcdefghij")).toBe("#ABCDEF");
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("received")).toBe("Received");
  });
  it("explains Firestore failures in plain words", () => {
    expect(explainFirestore({ code: "permission-denied" })).toMatch(/rules/);
    expect(explainFirestore({ code: "unavailable" })).toMatch(/connection/);
    expect(explainFirestore({ message: "boom" })).toBe("boom");
  });
});

describe("compressImage", () => {
  it("rejects files that aren't images", async () => {
    const file = new File(["%PDF"], "doc.pdf", { type: "application/pdf" });
    await expect(compressImage(file)).rejects.toThrow(/image file/);
  });
  it("rejects images over 15 MB before reading them", async () => {
    const file = new File([new Uint8Array(16 * 1024 * 1024)], "big.png", { type: "image/png" });
    await expect(compressImage(file)).rejects.toThrow(/over 15 MB/);
  });
});
