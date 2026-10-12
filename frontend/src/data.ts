import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  increment,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentData,
  type Query,
  type Timestamp,
} from "firebase/firestore";
import { log } from "./api";
import { db } from "./firebase";

// ---- Shapes stored in Firestore (see firestore.rules for who may write what) ----
export type UsageKind = "searches" | "locates" | "navigations";
export type Counts = Partial<Record<UsageKind, number>>;
export interface UserProfile {
  id: string;
  uid: string;
  email: string;
  name: string;
  provider: string;
  createdAt?: Timestamp;
  lastActive?: Timestamp;
  usage?: Counts;
  tickets?: number;
  problems?: number;
  // Admin-only fields
  blocked?: boolean;
  dailyLimit?: number | null;
}
export interface DayUsage extends Counts {
  id: string;
  uid: string;
  date: string;
}
export interface DayStats extends Counts {
  id: string;
  date: string;
  signups?: number;
  tickets?: number;
  problems?: number;
}
export interface AppSettings {
  defaultDailyLimit: number;
  dailyApiBudget: number;
  announcement: string;
}
export const defaultSettings: AppSettings = {
  defaultDailyLimit: 30,
  dailyApiBudget: 500,
  announcement: "",
};
export type TicketStatus =
  "open" | "received" | "in_progress" | "resolved" | "closed";
export const STATUSES: { id: TicketStatus; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "received", label: "Received" },
  { id: "in_progress", label: "In progress" },
  { id: "resolved", label: "Resolved" },
  { id: "closed", label: "Closed" },
];
export const statusLabel = (s: TicketStatus) =>
  STATUSES.find((x) => x.id === s)?.label ?? s;
export const CATEGORIES = [
  "Route or fare is wrong",
  "App not working",
  "Account & login",
  "Usage limit",
  "Feature request",
  "Other",
];
export type Priority = "low" | "normal" | "high";
export interface Ticket {
  id: string;
  uid: string;
  email: string;
  name: string;
  subject: string;
  category: string;
  priority: Priority;
  description: string;
  hasImage: boolean;
  status: TicketStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  lastMessage?: string;
  lastMessageAt?: Timestamp;
  unreadForAdmin?: boolean;
  unreadForUser?: boolean;
}
export interface Message {
  id: string;
  from: "user" | "admin" | "system";
  uid: string;
  text: string;
  createdAt?: Timestamp;
}
export interface Notice {
  id: string;
  to: string; // a uid, or "admin"
  from: string;
  title: string;
  body: string;
  link?: string;
  read: boolean;
  createdAt?: Timestamp;
}
export interface Problem {
  id: string;
  uid: string;
  email: string;
  message: string;
  source: string;
  page: string;
  createdAt?: Timestamp;
}

// ---- Small helpers ----
export const today = () => dateKey(new Date());
export function dateKey(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function lastDays(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (n - 1 - i));
    return dateKey(d);
  });
}
export const millis = (t?: Timestamp) => (t ? t.toMillis() : 0);
export function ago(t?: Timestamp) {
  if (!t) return "just now";
  const s = (Date.now() - t.toMillis()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return t.toDate().toLocaleDateString();
}
export const ticketNo = (id: string) => `#${id.slice(0, 6).toUpperCase()}`;
const displayName = (user: User) =>
  (user.displayName || user.email?.split("@")[0] || "Traveller").slice(0, 100);
// Notification links come from Firestore; only follow in-app hash routes (never javascript: etc.).
export const safeLink = (link?: string) =>
  link && /^#\/[A-Za-z0-9/_-]*$/.test(link) ? link : undefined;
const store = () => {
  if (!db) throw new Error("Firebase isn't configured.");
  return db;
};

// Live Firestore reads as React state. `key` re-subscribes when it changes; a null query yields [].
export function useLive<T>(
  make: () => Query<DocumentData> | null,
  key: string,
): { rows: T[]; loading: boolean; error: string } {
  const [state, setState] = useState({
    rows: [] as T[],
    loading: true,
    error: "",
  });
  useEffect(() => {
    const q = db ? make() : null;
    if (!q) {
      setState({ rows: [], loading: false, error: "" });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      q,
      (snap) =>
        setState({
          rows: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T),
          loading: false,
          error: "",
        }),
      (e) => {
        log("firestore.listen_failed", `${key} · ${e.code}`, "WARN");
        setState({ rows: [], loading: false, error: explainFirestore(e) });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
export function useDoc<T>(path: string | null): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!db || !path) {
      setValue(null);
      return;
    }
    return onSnapshot(
      doc(db, path),
      (d) => setValue(d.exists() ? ({ id: d.id, ...d.data() } as T) : null),
      (e) => log("firestore.listen_failed", `${path} · ${e.code}`, "WARN"),
    );
  }, [path]);
  return value;
}
export function explainFirestore(e: { code?: string; message?: string }) {
  if (e.code === "permission-denied")
    return "Permission denied by Firestore rules. Publish firestore.rules in the Firebase console.";
  if (e.code === "failed-precondition")
    return "Firestore needs an index or database setup for this view.";
  if (e.code === "unavailable")
    return "Can't reach Firestore. Check your connection.";
  return e.message || "Firestore request failed.";
}

// Why an action may not run right now ("" = allowed, "login" = must sign in first).
export function blockReason(
  s: {
    signedIn: boolean;
    blocked: boolean;
    searchesToday: number;
    dailyLimit: number;
    searchesAllUsersToday: number;
    dailyApiBudget: number;
  },
  kind?: UsageKind,
) {
  if (!s.signedIn) return "login";
  if (s.blocked)
    return "Your account has been paused by the RouteWise team. Open Help & support to raise a ticket.";
  if (kind === "searches") {
    if (s.searchesToday >= s.dailyLimit)
      return `You've used all ${s.dailyLimit} route searches for today. They reset at midnight — or raise a ticket in Help & support to ask for more.`;
    if (s.searchesAllUsersToday >= s.dailyApiBudget)
      return "RouteWise has reached today's search capacity. Please try again tomorrow.";
  }
  return "";
}

// ---- Writes ----
export async function ensureProfile(user: User) {
  const ref = doc(store(), "users", user.uid);
  const base = {
    uid: user.uid,
    email: user.email ?? "",
    name: displayName(user),
    provider: user.providerData[0]?.providerId ?? "password",
    lastActive: serverTimestamp(),
  };
  const existing = await getDoc(ref);
  if (existing.exists()) {
    await setDoc(ref, base, { merge: true });
    return;
  }
  await setDoc(ref, {
    ...base,
    createdAt: serverTimestamp(),
    usage: { searches: 0, locates: 0, navigations: 0 },
  });
  await bumpStats({ signups: 1 });
  log("profile.created");
}

async function bumpStats(fields: Partial<Record<keyof DayStats, number>>) {
  const date = today();
  const inc = Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, increment(v as number)]),
  );
  await setDoc(doc(store(), "stats", date), { date, ...inc }, { merge: true });
}

export async function trackUsage(user: User, kind: UsageKind) {
  const date = today();
  try {
    await Promise.all([
      setDoc(
        doc(store(), "usage", `${user.uid}_${date}`),
        { uid: user.uid, date, [kind]: increment(1) },
        { merge: true },
      ),
      setDoc(
        doc(store(), "users", user.uid),
        { usage: { [kind]: increment(1) }, lastActive: serverTimestamp() },
        { merge: true },
      ),
      bumpStats({ [kind]: 1 }),
    ]);
  } catch (e) {
    log("usage.track_failed", String(e), "WARN");
  }
}

const recentProblems = new Map<string, number>();
export async function reportProblem(
  user: User | null,
  message: string,
  source = "app",
) {
  if (!db || !user) return;
  // Same message from the same tab at most once a minute, so a loop can't flood the log.
  const last = recentProblems.get(message) ?? 0;
  if (Date.now() - last < 60000) return;
  recentProblems.set(message, Date.now());
  try {
    await addDoc(collection(db, "problems"), {
      uid: user.uid,
      email: user.email ?? "",
      message: message.slice(0, 1000),
      source: source.slice(0, 40),
      page: (location.hash || "#/").slice(0, 200),
      userAgent: navigator.userAgent.slice(0, 200),
      createdAt: serverTimestamp(),
    });
    await Promise.all([
      bumpStats({ problems: 1 }),
      setDoc(
        doc(db, "users", user.uid),
        { problems: increment(1) },
        { merge: true },
      ),
    ]);
  } catch {
    // Reporting must never cause another error banner.
  }
}

export async function notify(
  to: string,
  from: string,
  title: string,
  body: string,
  link = "",
) {
  await addDoc(collection(store(), "notifications"), {
    to,
    from,
    title,
    body: body.slice(0, 500),
    link,
    read: false,
    createdAt: serverTimestamp(),
  });
}
export async function broadcast(
  uids: string[],
  from: string,
  title: string,
  body: string,
) {
  for (let i = 0; i < uids.length; i += 400) {
    const batch = writeBatch(store());
    for (const to of uids.slice(i, i + 400))
      batch.set(doc(collection(store(), "notifications")), {
        to,
        from,
        title,
        body: body.slice(0, 500),
        link: "",
        read: false,
        createdAt: serverTimestamp(),
      });
    await batch.commit();
  }
}
export const markRead = (id: string) =>
  updateDoc(doc(store(), "notifications", id), { read: true });

export async function createTicket(
  user: User,
  fields: Pick<Ticket, "subject" | "category" | "priority" | "description">,
  image: string | null,
) {
  const ticket = await addDoc(collection(store(), "tickets"), {
    uid: user.uid,
    email: user.email ?? "",
    name: displayName(user),
    ...fields,
    hasImage: Boolean(image),
    status: "open",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastMessage: fields.description.slice(0, 140),
    lastMessageAt: serverTimestamp(),
    unreadForAdmin: true,
    unreadForUser: false,
  });
  if (image)
    await setDoc(doc(store(), "ticketImages", ticket.id), {
      uid: user.uid,
      data: image,
    });
  await Promise.all([
    notify(
      "admin",
      user.uid,
      `New ticket ${ticketNo(ticket.id)}`,
      `${fields.subject} — ${user.email}`,
      `#/admin/tickets/${ticket.id}`,
    ),
    bumpStats({ tickets: 1 }),
    setDoc(
      doc(store(), "users", user.uid),
      { tickets: increment(1) },
      { merge: true },
    ),
  ]);
  log("ticket.created");
  return ticket.id;
}

export async function sendMessage(
  user: User,
  ticket: Ticket,
  text: string,
  asAdmin: boolean,
) {
  const clean = text.trim().slice(0, 2000);
  if (!clean) return;
  await addDoc(collection(store(), "tickets", ticket.id, "messages"), {
    from: asAdmin ? "admin" : "user",
    uid: user.uid,
    text: clean,
    createdAt: serverTimestamp(),
  });
  await updateDoc(doc(store(), "tickets", ticket.id), {
    lastMessage: clean.slice(0, 140),
    lastMessageAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...(asAdmin ? { unreadForUser: true } : { unreadForAdmin: true }),
  });
  if (asAdmin)
    await notify(
      ticket.uid,
      user.uid,
      `Reply on ${ticketNo(ticket.id)}`,
      clean,
      `#/support/${ticket.id}`,
    );
  else
    await notify(
      "admin",
      user.uid,
      `${ticket.name} replied on ${ticketNo(ticket.id)}`,
      clean,
      `#/admin/tickets/${ticket.id}`,
    );
}

export async function setTicketStatus(
  user: User,
  ticket: Ticket,
  status: TicketStatus,
  asAdmin: boolean,
) {
  if (status === ticket.status) return;
  const note = `Status changed to ${statusLabel(status)}`;
  await updateDoc(doc(store(), "tickets", ticket.id), {
    status,
    updatedAt: serverTimestamp(),
    lastMessage: note,
    lastMessageAt: serverTimestamp(),
    ...(asAdmin ? { unreadForUser: true } : { unreadForAdmin: true }),
  });
  if (asAdmin) {
    await addDoc(collection(store(), "tickets", ticket.id, "messages"), {
      from: "system",
      uid: user.uid,
      text: note,
      createdAt: serverTimestamp(),
    });
    await notify(
      ticket.uid,
      user.uid,
      `${ticketNo(ticket.id)} is now ${statusLabel(status)}`,
      ticket.subject,
      `#/support/${ticket.id}`,
    );
  } else {
    await notify(
      "admin",
      user.uid,
      `${ticket.name} marked ${ticketNo(ticket.id)} ${statusLabel(status)}`,
      ticket.subject,
      `#/admin/tickets/${ticket.id}`,
    );
  }
}
export const clearUnread = (ticketId: string, asAdmin: boolean) =>
  updateDoc(
    doc(store(), "tickets", ticketId),
    asAdmin ? { unreadForAdmin: false } : { unreadForUser: false },
  ).catch(() => {});

// Downscale to JPEG so a screenshot fits comfortably inside one Firestore document (1 MiB cap).
export async function compressImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/"))
    throw new Error("Attach an image file (PNG, JPG, WEBP).");
  if (file.size > 15 * 1024 * 1024)
    throw new Error("That image is over 15 MB. Choose a smaller one.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read that image."));
      i.src = url;
    });
    for (const [max, quality] of [
      [1400, 0.75],
      [1100, 0.65],
      [800, 0.6],
      [600, 0.5],
    ]) {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", quality);
      if (data.length < 700_000) return data;
    }
    throw new Error("That image is too detailed to attach. Try a crop.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export { collection, doc, query, setDoc, updateDoc, getDoc };
