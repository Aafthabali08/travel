// Firestore security rules, exercised against the local emulator: run with `npm run test:rules`.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";

const ADMIN = "aafthabali08@gmail.com";
let env: RulesTestEnvironment;
const as = (uid: string, email: string, verified = true) =>
  env.authenticatedContext(uid, { email, email_verified: verified }).firestore() as unknown as Firestore;
const alice = () => as("alice", "alice@example.com");
const bob = () => as("bob", "bob@example.com");
const admin = () => as("admin1", ADMIN);
const fakeAdmin = () => as("mallory", ADMIN, false); // claims the admin email, not verified
const anon = () => env.unauthenticatedContext().firestore() as unknown as Firestore;
const seed = (path: string, data: object) =>
  env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore() as unknown as Firestore, path), data));

const profile = (uid: string, email: string) => ({
  uid,
  email,
  name: uid,
  provider: "password",
  lastActive: serverTimestamp(),
  createdAt: serverTimestamp(),
  usage: { searches: 0, locates: 0, navigations: 0 },
});
const ticket = (overrides: object = {}) => ({
  uid: "alice",
  email: "alice@example.com",
  name: "Alice",
  subject: "Auto fare looks wrong",
  category: "Route or fare is wrong",
  priority: "normal",
  description: "It said ₹40 but I paid ₹80.",
  hasImage: false,
  status: "open",
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  lastMessage: "It said ₹40 but I paid ₹80.",
  lastMessageAt: serverTimestamp(),
  unreadForAdmin: true,
  unreadForUser: false,
  ...overrides,
});
const seededTicket = (overrides: object = {}) => ({
  ...ticket(overrides),
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
  lastMessageAt: Timestamp.now(),
});
const notice = (overrides: object = {}) => ({
  to: "admin",
  from: "alice",
  title: "New ticket #ABC",
  body: "hello",
  link: "#/admin/tickets/abc",
  read: false,
  createdAt: serverTimestamp(),
  ...overrides,
});
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U";

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-routewise",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});
afterAll(() => env?.cleanup());
beforeEach(() => env.clearFirestore());

describe("users", () => {
  it("lets a user create their own profile", async () => {
    await assertSucceeds(setDoc(doc(alice(), "users/alice"), profile("alice", "alice@example.com")));
  });
  it("blocks creating someone else's profile or spoofing the email", async () => {
    await assertFails(setDoc(doc(alice(), "users/bob"), profile("bob", "bob@example.com")));
    await assertFails(setDoc(doc(alice(), "users/alice"), profile("alice", ADMIN)));
    await assertFails(setDoc(doc(anon(), "users/alice"), profile("alice", "alice@example.com")));
  });
  it("blocks granting yourself a limit, an unblock or a head start on usage", async () => {
    await assertFails(setDoc(doc(alice(), "users/alice"), { ...profile("alice", "alice@example.com"), dailyLimit: 9999 }));
    await assertFails(setDoc(doc(alice(), "users/alice"), { ...profile("alice", "alice@example.com"), blocked: false }));
    await assertFails(setDoc(doc(alice(), "users/alice"), { ...profile("alice", "alice@example.com"), usage: { searches: 50 } }));
  });
  it("only allows usage counters to move up by one", async () => {
    await seed("users/alice", { ...profile("alice", "alice@example.com"), createdAt: Timestamp.now(), usage: { searches: 5 } });
    await assertSucceeds(setDoc(doc(alice(), "users/alice"), { usage: { searches: increment(1) } }, { merge: true }));
    await assertFails(setDoc(doc(alice(), "users/alice"), { usage: { searches: 0 } }, { merge: true }));
    await assertFails(setDoc(doc(alice(), "users/alice"), { usage: { searches: increment(10) } }, { merge: true }));
    await assertFails(updateDoc(doc(alice(), "users/alice"), { dailyLimit: 1000 }));
    await assertFails(updateDoc(doc(alice(), "users/alice"), { blocked: false }));
    await assertFails(updateDoc(doc(alice(), "users/alice"), { email: ADMIN }));
  });
  it("keeps profiles private to their owner and the admin", async () => {
    await seed("users/alice", { ...profile("alice", "alice@example.com"), createdAt: Timestamp.now() });
    await assertSucceeds(getDoc(doc(alice(), "users/alice")));
    await assertFails(getDoc(doc(bob(), "users/alice")));
    await assertFails(getDocs(collection(bob(), "users")));
    await assertFails(getDocs(collection(fakeAdmin(), "users")));
    await assertSucceeds(getDocs(collection(admin(), "users")));
  });
  it("lets only a verified admin block users or change limits", async () => {
    await seed("users/alice", { ...profile("alice", "alice@example.com"), createdAt: Timestamp.now() });
    await assertFails(updateDoc(doc(fakeAdmin(), "users/alice"), { blocked: true }));
    await assertFails(updateDoc(doc(bob(), "users/alice"), { blocked: true }));
    await assertSucceeds(updateDoc(doc(admin(), "users/alice"), { blocked: true, dailyLimit: 5 }));
  });
});

describe("usage and stats counters", () => {
  it("lets a user count their own usage one at a time", async () => {
    const ref = doc(alice(), "usage/alice_2026-10-12");
    await assertSucceeds(setDoc(ref, { uid: "alice", date: "2026-10-12", searches: increment(1) }, { merge: true }));
    await assertSucceeds(setDoc(ref, { uid: "alice", date: "2026-10-12", searches: increment(1) }, { merge: true }));
    await assertSucceeds(getDoc(ref));
  });
  it("stops resetting, inflating or forging usage", async () => {
    await seed("usage/alice_2026-10-12", { uid: "alice", date: "2026-10-12", searches: 30 });
    const ref = doc(alice(), "usage/alice_2026-10-12");
    await assertFails(setDoc(ref, { uid: "alice", date: "2026-10-12", searches: 0 }));
    await assertFails(setDoc(ref, { uid: "alice", date: "2026-10-12", searches: increment(5) }, { merge: true }));
    await assertFails(setDoc(doc(alice(), "usage/alice_2026-10-13"), { uid: "alice", date: "2026-10-13", searches: 7 }));
    await assertFails(setDoc(doc(alice(), "usage/bob_2026-10-12"), { uid: "bob", date: "2026-10-12", searches: 1 }));
    await assertFails(setDoc(doc(alice(), "usage/alice_2026-10-14"), { uid: "alice", date: "2026-10-14", searches: 1, extra: true }));
    await assertFails(getDoc(doc(bob(), "usage/alice_2026-10-12")));
    await assertSucceeds(getDocs(query(collection(admin(), "usage"), where("date", ">=", "2026-10-01"))));
  });
  it("lets shared stats grow by one per write only", async () => {
    await seed("stats/2026-10-12", { date: "2026-10-12", searches: 10 });
    const ref = doc(alice(), "stats/2026-10-12");
    await assertSucceeds(setDoc(ref, { date: "2026-10-12", searches: increment(1) }, { merge: true }));
    // Inflating the shared total would lock every user out via the daily budget.
    await assertFails(setDoc(ref, { date: "2026-10-12", searches: 1_000_000 }, { merge: true }));
    await assertFails(setDoc(ref, { date: "2026-10-12", searches: 0 }, { merge: true }));
    await assertFails(setDoc(ref, { date: "2026-10-12", hacked: 1 }, { merge: true }));
    await assertFails(setDoc(doc(anon(), "stats/2026-10-12"), { date: "2026-10-12", searches: increment(1) }, { merge: true }));
    await assertFails(deleteDoc(ref));
  });
});

describe("tickets", () => {
  it("lets a user open a well-formed ticket", async () => {
    await assertSucceeds(addDoc(collection(alice(), "tickets"), ticket()));
  });
  it("rejects malformed or forged tickets", async () => {
    const t = collection(alice(), "tickets");
    await assertFails(addDoc(t, ticket({ status: "resolved" })));
    await assertFails(addDoc(t, ticket({ uid: "bob" })));
    await assertFails(addDoc(t, ticket({ email: ADMIN })));
    await assertFails(addDoc(t, ticket({ subject: "x".repeat(141) })));
    await assertFails(addDoc(t, ticket({ subject: "" })));
    await assertFails(addDoc(t, ticket({ priority: "urgent!!" })));
    await assertFails(addDoc(t, ticket({ createdAt: Timestamp.fromDate(new Date(2000, 0, 1)) })));
    await assertFails(addDoc(t, ticket({ isAdmin: true })));
    await assertFails(addDoc(collection(anon(), "tickets"), ticket()));
  });
  it("keeps tickets private", async () => {
    await seed("tickets/t1", seededTicket());
    await assertSucceeds(getDoc(doc(alice(), "tickets/t1")));
    await assertSucceeds(getDocs(query(collection(alice(), "tickets"), where("uid", "==", "alice"))));
    await assertFails(getDoc(doc(bob(), "tickets/t1")));
    await assertFails(getDocs(query(collection(bob(), "tickets"), where("uid", "==", "alice"))));
    await assertFails(getDocs(collection(bob(), "tickets")));
    await assertFails(getDocs(collection(fakeAdmin(), "tickets")));
    await assertSucceeds(getDocs(collection(admin(), "tickets")));
  });
  it("lets owners close or reopen, and only the admin set other statuses", async () => {
    await seed("tickets/t1", seededTicket({ status: "received" }));
    await assertFails(updateDoc(doc(alice(), "tickets/t1"), { status: "resolved" }));
    await assertFails(updateDoc(doc(alice(), "tickets/t1"), { subject: "edited" }));
    await assertFails(updateDoc(doc(bob(), "tickets/t1"), { status: "closed" }));
    await assertSucceeds(updateDoc(doc(alice(), "tickets/t1"), { status: "closed", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(alice(), "tickets/t1"), { status: "open" }));
    await assertFails(updateDoc(doc(fakeAdmin(), "tickets/t1"), { status: "in_progress" }));
    await assertSucceeds(updateDoc(doc(admin(), "tickets/t1"), { status: "in_progress" }));
    await assertFails(deleteDoc(doc(alice(), "tickets/t1")));
    await assertSucceeds(deleteDoc(doc(admin(), "tickets/t1")));
  });
});

describe("ticket chat", () => {
  const msg = (uid: string, from: string, text = "hi") => ({ uid, from, text, createdAt: serverTimestamp() });
  beforeEach(() => seed("tickets/t1", seededTicket()));
  it("lets the owner and the admin talk", async () => {
    await assertSucceeds(addDoc(collection(alice(), "tickets/t1/messages"), msg("alice", "user")));
    await assertSucceeds(addDoc(collection(admin(), "tickets/t1/messages"), msg("admin1", "admin")));
    await assertSucceeds(getDocs(collection(alice(), "tickets/t1/messages")));
  });
  it("stops impersonating support and posting into other people's tickets", async () => {
    await assertFails(addDoc(collection(alice(), "tickets/t1/messages"), msg("alice", "admin")));
    await assertFails(addDoc(collection(alice(), "tickets/t1/messages"), msg("alice", "system")));
    await assertFails(addDoc(collection(fakeAdmin(), "tickets/t1/messages"), msg("mallory", "admin")));
    await assertFails(addDoc(collection(bob(), "tickets/t1/messages"), msg("bob", "user")));
    await assertFails(addDoc(collection(alice(), "tickets/t1/messages"), msg("bob", "user")));
    await assertFails(addDoc(collection(alice(), "tickets/t1/messages"), msg("alice", "user", "")));
    await assertFails(addDoc(collection(alice(), "tickets/t1/messages"), msg("alice", "user", "x".repeat(2001))));
    await assertFails(getDocs(collection(bob(), "tickets/t1/messages")));
  });
  it("refuses user messages on a closed ticket", async () => {
    await seed("tickets/t1", seededTicket({ status: "closed" }));
    await assertFails(addDoc(collection(alice(), "tickets/t1/messages"), msg("alice", "user")));
  });
  it("makes messages immutable for users", async () => {
    await seed("tickets/t1/messages/m1", { uid: "alice", from: "user", text: "hi", createdAt: Timestamp.now() });
    await assertFails(updateDoc(doc(alice(), "tickets/t1/messages/m1"), { text: "edited" }));
    await assertFails(deleteDoc(doc(alice(), "tickets/t1/messages/m1")));
  });
});

describe("ticket images", () => {
  beforeEach(() => seed("tickets/t1", seededTicket({ hasImage: true })));
  it("accepts a JPEG data URL from the ticket owner", async () => {
    await assertSucceeds(setDoc(doc(alice(), "ticketImages/t1"), { uid: "alice", data: JPEG }));
  });
  it("rejects scriptable or foreign content", async () => {
    await assertFails(setDoc(doc(alice(), "ticketImages/t1"), { uid: "alice", data: "data:image/svg+xml;base64,PHN2Zz4=" }));
    await assertFails(setDoc(doc(alice(), "ticketImages/t1"), { uid: "alice", data: "javascript:alert(1)" }));
    await assertFails(setDoc(doc(alice(), "ticketImages/t1"), { uid: "alice", data: JPEG + "<script>" }));
    await assertFails(setDoc(doc(bob(), "ticketImages/t1"), { uid: "bob", data: JPEG }));
  });
  it("shows images only to the owner and the admin", async () => {
    await seed("ticketImages/t1", { uid: "alice", data: JPEG });
    await assertSucceeds(getDoc(doc(alice(), "ticketImages/t1")));
    await assertSucceeds(getDoc(doc(admin(), "ticketImages/t1")));
    await assertFails(getDoc(doc(bob(), "ticketImages/t1")));
  });
});

describe("notifications", () => {
  it("lets users notify the admin inbox with an in-app link", async () => {
    await assertSucceeds(addDoc(collection(alice(), "notifications"), notice()));
  });
  it("blocks spam to other users, spoofed senders and unsafe links", async () => {
    const n = collection(alice(), "notifications");
    await assertFails(addDoc(n, notice({ to: "bob" })));
    await assertFails(addDoc(n, notice({ from: "admin1" })));
    await assertFails(addDoc(n, notice({ link: "javascript:alert(document.cookie)" })));
    await assertFails(addDoc(n, notice({ link: "https://evil.example/phish" })));
    await assertFails(addDoc(n, notice({ link: "#/x\" onclick=\"alert(1)" })));
    await assertFails(addDoc(n, notice({ read: true })));
    await assertFails(addDoc(n, notice({ body: "x".repeat(501) })));
    await assertFails(addDoc(collection(admin(), "notifications"), notice({ to: "alice", from: "admin1", link: "javascript:alert(1)" })));
  });
  it("lets the admin message any user", async () => {
    await assertSucceeds(addDoc(collection(admin(), "notifications"), notice({ to: "alice", from: "admin1", link: "" })));
    await assertFails(addDoc(collection(fakeAdmin(), "notifications"), notice({ to: "alice", from: "mallory" })));
  });
  it("lets recipients read and mark their own notifications only", async () => {
    await seed("notifications/n1", { ...notice({ to: "alice", from: "admin1" }), createdAt: Timestamp.now() });
    await assertSucceeds(getDocs(query(collection(alice(), "notifications"), where("to", "==", "alice"))));
    await assertFails(getDocs(query(collection(bob(), "notifications"), where("to", "==", "alice"))));
    await assertFails(getDocs(query(collection(bob(), "notifications"), where("to", "==", "admin"))));
    await assertSucceeds(updateDoc(doc(alice(), "notifications/n1"), { read: true }));
    await assertFails(updateDoc(doc(alice(), "notifications/n1"), { title: "changed" }));
    await assertFails(updateDoc(doc(bob(), "notifications/n1"), { read: true }));
  });
});

describe("problems and config", () => {
  const problem = (overrides: object = {}) => ({
    uid: "alice",
    email: "alice@example.com",
    message: "Provider unavailable",
    source: "planner",
    page: "#/",
    userAgent: "test",
    createdAt: serverTimestamp(),
    ...overrides,
  });
  it("lets users report problems but never read them", async () => {
    await assertSucceeds(addDoc(collection(alice(), "problems"), problem()));
    await assertFails(addDoc(collection(alice(), "problems"), problem({ uid: "bob" })));
    await assertFails(addDoc(collection(alice(), "problems"), problem({ extra: 1 })));
    await assertFails(getDocs(collection(alice(), "problems")));
    await assertSucceeds(getDocs(collection(admin(), "problems")));
  });
  it("lets everyone signed in read settings and only the admin change them", async () => {
    await seed("config/app", { defaultDailyLimit: 30, dailyApiBudget: 500, announcement: "" });
    await assertSucceeds(getDoc(doc(alice(), "config/app")));
    await assertFails(getDoc(doc(anon(), "config/app")));
    await assertFails(setDoc(doc(alice(), "config/app"), { defaultDailyLimit: 100000 }, { merge: true }));
    await assertFails(setDoc(doc(fakeAdmin(), "config/app"), { defaultDailyLimit: 100000 }, { merge: true }));
    await assertSucceeds(setDoc(doc(admin(), "config/app"), { announcement: "Hi" }, { merge: true }));
  });
  it("denies anything outside the known collections", async () => {
    await assertFails(setDoc(doc(alice(), "secrets/x"), { a: 1 }));
    await assertFails(getDoc(doc(admin(), "secrets/x")));
  });
});
