import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type Auth,
  type User,
} from "firebase/auth";
import { collection, query, where } from "firebase/firestore";
import {
  Bell,
  CheckCheck,
  Compass,
  LifeBuoy,
  Lock,
  LogOut,
  Mail,
  ShieldCheck,
  User as UserIcon,
  X,
} from "lucide-react";
import { log, setTokenProvider } from "./api";
import { ThemeToggle } from "./theme";
import { auth, db, isAdmin as checkAdmin } from "./firebase";
import {
  ago,
  defaultSettings,
  ensureProfile,
  markRead,
  millis,
  safeLink,
  today,
  useDoc,
  useLive,
  blockReason,
  type AppSettings,
  type DayStats,
  type DayUsage,
  type Notice,
  type UsageKind,
  type UserProfile,
} from "./data";

export type AuthMode = "login" | "signup";
interface AuthState {
  user: User | null;
  ready: boolean;
  isAdmin: boolean;
  profile: UserProfile | null;
  usageToday: DayUsage | null;
  settings: AppSettings;
  dailyLimit: number;
  searchesLeft: number;
  openAuth: (mode: AuthMode) => void;
  refreshUser: () => Promise<void>;
  // Returns why an action is not allowed right now, or "" when it may go ahead.
  blockReason: (kind?: UsageKind) => string;
}
const AuthContext = createContext<AuthState | null>(null);
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

// getIdToken() returns a cached token and refreshes it shortly before it expires.
setTokenProvider(async () => auth?.currentUser?.getIdToken() ?? null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [, setVersion] = useState(0);
  const [ready, setReady] = useState(!auth);
  const [mode, setMode] = useState<AuthMode | null>(null);
  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setReady(true);
      if (u)
        ensureProfile(u).catch((e) =>
          log("profile.sync_failed", String(e?.code ?? e), "WARN"),
        );
    });
  }, []);
  const profile = useDoc<UserProfile>(user ? `users/${user.uid}` : null);
  const usageToday = useDoc<DayUsage>(
    user ? `usage/${user.uid}_${today()}` : null,
  );
  const stats = useDoc<DayStats>(user ? `stats/${today()}` : null);
  const stored = useDoc<Partial<AppSettings>>(user ? "config/app" : null);
  const settings = { ...defaultSettings, ...stored };
  const dailyLimit = profile?.dailyLimit ?? settings.defaultDailyLimit;
  const searchesLeft = Math.max(0, dailyLimit - (usageToday?.searches ?? 0));
  const refreshUser = useCallback(async () => {
    if (!auth?.currentUser) return;
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
    setUser(auth.currentUser);
    setVersion((v) => v + 1);
  }, []);
  const value: AuthState = {
    user,
    ready,
    isAdmin: checkAdmin(user),
    profile,
    usageToday,
    settings,
    dailyLimit,
    searchesLeft,
    openAuth: setMode,
    refreshUser,
    blockReason: (kind) =>
      blockReason(
        {
          signedIn: Boolean(user),
          blocked: Boolean(profile?.blocked),
          searchesToday: usageToday?.searches ?? 0,
          dailyLimit,
          searchesAllUsersToday: stats?.searches ?? 0,
          dailyApiBudget: settings.dailyApiBudget,
        },
        kind,
      ),
  };
  return (
    <AuthContext.Provider value={value}>
      {children}
      {mode && (
        <AuthModal mode={mode} onMode={setMode} onClose={() => setMode(null)} />
      )}
    </AuthContext.Provider>
  );
}

export function logOut() {
  if (auth) signOut(auth).then(() => log("auth.signed_out"));
}

export function initials(user: User) {
  const source = user.displayName || user.email || "?";
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

const messages: Record<string, string> = {
  "auth/invalid-credential": "That email and password don't match.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/user-not-found": "No account with that email. Sign up instead?",
  "auth/wrong-password": "That email and password don't match.",
  "auth/email-already-in-use":
    "An account already uses that email. Log in instead.",
  "auth/weak-password": "Use at least 6 characters for your password.",
  "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  "auth/popup-closed-by-user": "Google sign-in was closed before finishing.",
  "auth/network-request-failed": "Network error. Check your connection.",
  "auth/operation-not-allowed":
    "This sign-in method isn't enabled in the Firebase console.",
  "auth/unauthorized-domain":
    "This domain isn't authorised in Firebase (Authentication → Settings → Authorised domains).",
};
const explain = (e: unknown) => {
  const code = (e as { code?: string })?.code ?? "";
  return messages[code] ?? (e instanceof Error ? e.message : String(e));
};

export function AuthModal({
  mode,
  onMode,
  onClose,
}: {
  mode: AuthMode;
  onMode: (m: AuthMode) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const signup = mode === "signup";
  useEffect(() => {
    setError("");
    setNotice("");
  }, [mode]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(action: (a: Auth) => Promise<unknown>, event: string) {
    if (!auth) {
      setError(
        "Sign-in isn't configured yet. Add the VITE_FIREBASE_* keys to .env and restart.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await action(auth);
      log(event);
      onClose();
    } catch (e) {
      setError(explain(e));
      log(`${event}_failed`, (e as { code?: string })?.code ?? "", "WARN");
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (signup)
      run(async (a) => {
        const { user } = await createUserWithEmailAndPassword(
          a,
          email.trim(),
          password,
        );
        if (name.trim()) {
          await updateProfile(user, { displayName: name.trim() });
          await user.reload();
        }
        await sendEmailVerification(user).catch(() => {});
      }, "auth.signed_up");
    else
      run(
        (a) => signInWithEmailAndPassword(a, email.trim(), password),
        "auth.logged_in",
      );
  }
  async function reset() {
    if (!auth) return;
    if (!email.trim()) {
      setError("Enter your email above, then choose “Forgot password?”.");
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setError("");
      setNotice(`Reset link sent to ${email.trim()}.`);
    } catch (e) {
      setError(explain(e));
    }
  }

  return (
    <div className="auth-backdrop" onMouseDown={onClose}>
      <div
        className="auth-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="auth-close"
          aria-label="Close sign-in"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <div className="eyebrow">
          {signup ? "JOIN ROUTEWISE" : "WELCOME BACK"}
        </div>
        <h2 id="auth-title">{signup ? "Create your account" : "Log in"}</h2>
        <p className="auth-sub">
          {signup
            ? "Sign up to plan journeys, compare fares and track your trip."
            : "Log in to plan journeys and use every feature."}
        </p>
        <div className="auth-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={!signup}
            className={!signup ? "selected" : ""}
            onClick={() => onMode("login")}
          >
            Log in
          </button>
          <button
            role="tab"
            aria-selected={signup}
            className={signup ? "selected" : ""}
            onClick={() => onMode("signup")}
          >
            Sign up
          </button>
        </div>
        <form onSubmit={submit}>
          {signup && (
            <label className="auth-field">
              <span>NAME</span>
              <div>
                <UserIcon size={16} />
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>
            </label>
          )}
          <label className="auth-field">
            <span>EMAIL</span>
            <div>
              <Mail size={16} />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                autoFocus
              />
            </div>
          </label>
          <label className="auth-field">
            <span>PASSWORD</span>
            <div>
              <Lock size={16} />
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={signup ? "At least 6 characters" : "Your password"}
                autoComplete={signup ? "new-password" : "current-password"}
              />
            </div>
          </label>
          {!signup && (
            <button type="button" className="auth-link" onClick={reset}>
              Forgot password?
            </button>
          )}
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          {notice && <p className="auth-notice">{notice}</p>}
          <button className="primary auth-submit" disabled={busy}>
            {busy ? (
              <span className="spinner" />
            ) : signup ? (
              "Create account"
            ) : (
              "Log in"
            )}
          </button>
        </form>
        <div className="auth-or">
          <span>or</span>
        </div>
        <button
          className="auth-google"
          disabled={busy}
          onClick={() =>
            run(
              (a) => signInWithPopup(a, new GoogleAuthProvider()),
              "auth.google_signed_in",
            )
          }
        >
          <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
            <path
              fill="#FFC107"
              d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
            />
            <path
              fill="#FF3D00"
              d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
            />
            <path
              fill="#4CAF50"
              d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
            />
            <path
              fill="#1976D2"
              d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
            />
          </svg>
          Continue with Google
        </button>
        <p className="auth-switch">
          {signup ? "Already have an account?" : "New to RouteWise?"}{" "}
          <button
            className="auth-link"
            onClick={() => onMode(signup ? "login" : "signup")}
          >
            {signup ? "Log in" : "Sign up"}
          </button>
        </p>
      </div>
    </div>
  );
}

function useClickAway(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) =>
      ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

function NotificationBell() {
  const { user, isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickAway(open, close);
  const mine = useLive<Notice>(
    () =>
      db && user
        ? query(collection(db, "notifications"), where("to", "==", user.uid))
        : null,
    `notices-${user?.uid}`,
  );
  const team = useLive<Notice>(
    () =>
      db && isAdmin
        ? query(collection(db, "notifications"), where("to", "==", "admin"))
        : null,
    `notices-admin-${isAdmin}`,
  );
  const items = [...mine.rows, ...team.rows]
    .sort((a, b) => millis(b.createdAt) - millis(a.createdAt))
    .slice(0, 30);
  const unread = items.filter((n) => !n.read);
  return (
    <div className="bell" ref={ref}>
      <button
        className="bell-btn"
        aria-label={`Notifications${unread.length ? `, ${unread.length} unread` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Bell size={18} />
        {unread.length > 0 && (
          <span className="bell-count">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
      </button>
      {open && (
        <div className="bell-menu" role="menu">
          <header>
            <strong>Notifications</strong>
            {unread.length > 0 && (
              <button
                onClick={() =>
                  unread.forEach((n) => markRead(n.id).catch(() => {}))
                }
              >
                <CheckCheck size={14} /> Mark all read
              </button>
            )}
          </header>
          {items.length === 0 ? (
            <p className="bell-empty">You're all caught up.</p>
          ) : (
            items.map((n) => (
              <a
                key={n.id}
                role="menuitem"
                className={n.read ? "" : "unread"}
                href={safeLink(n.link)}
                onClick={() => {
                  if (!n.read) markRead(n.id).catch(() => {});
                  setOpen(false);
                }}
              >
                <strong>{n.title}</strong>
                <span>{n.body}</span>
                <small>{ago(n.createdAt)}</small>
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Top-right of every page: Log in / Sign up when signed out; bell + account menu when signed in.
export function AccountArea({ onLogOut }: { onLogOut?: () => void }) {
  const { user, ready, isAdmin, openAuth, searchesLeft, dailyLimit } =
    useAuth();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickAway(open, close);
  if (!ready)
    return (
      <div className="account-area">
        <ThemeToggle />
        <span className="avatar" aria-hidden="true" />
      </div>
    );
  if (!user)
    return (
      <div className="auth-buttons">
        <ThemeToggle />
        <button className="login-btn" onClick={() => openAuth("login")}>
          Log in
        </button>
        <button className="signup-btn" onClick={() => openAuth("signup")}>
          Sign up
        </button>
      </div>
    );
  return (
    <div className="account-area">
      <ThemeToggle />
      <NotificationBell />
      <div className="account" ref={ref}>
        <button
          className="avatar"
          aria-label="Account menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {initials(user)}
        </button>
        {open && (
          <div className="account-menu" role="menu">
            <strong>{user.displayName || "Signed in"}</strong>
            <span>{user.email}</span>
            <div className="quota-line">
              <div>
                <b>{searchesLeft}</b> of {dailyLimit} route searches left today
              </div>
              <i>
                <em
                  style={{
                    width: `${Math.min(100, (searchesLeft / Math.max(1, dailyLimit)) * 100)}%`,
                  }}
                />
              </i>
            </div>
            <a role="menuitem" href="#/" onClick={close}>
              <Compass size={15} /> Plan a journey
            </a>
            <a role="menuitem" href="#/support" onClick={close}>
              <LifeBuoy size={15} /> Help & support
            </a>
            {isAdmin && (
              <a role="menuitem" href="#/admin" onClick={close}>
                <ShieldCheck size={15} /> Admin dashboard
              </a>
            )}
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                close();
                onLogOut?.();
                logOut();
              }}
            >
              <LogOut size={15} /> Log out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
