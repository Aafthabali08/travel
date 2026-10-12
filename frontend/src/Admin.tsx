import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  Activity,
  AlertTriangle,
  Ban,
  Bell,
  CheckCircle2,
  Gauge,
  Inbox,
  LayoutDashboard,
  LogIn,
  MailCheck,
  MessagesSquare,
  Search,
  Send,
  Server,
  Settings,
  ShieldAlert,
  Ticket as TicketIcon,
  Trash2,
  UserCheck,
  Users,
} from "lucide-react";
import { sendEmailVerification } from "firebase/auth";
import { api } from "./api";
import { useAuth } from "./auth";
import { ADMIN_EMAIL, db, isAdminEmail } from "./firebase";
import {
  ago,
  broadcast,
  defaultSettings,
  lastDays,
  millis,
  notify,
  safeLink,
  setTicketStatus,
  STATUSES,
  ticketNo,
  today,
  useDoc,
  useLive,
  type AppSettings,
  type DayStats,
  type DayUsage,
  type Notice,
  type Problem,
  type Ticket,
  type TicketStatus,
  type UserProfile,
} from "./data";
import {
  Empty,
  PageShell,
  StatusBadge,
  TicketImage,
  TicketThread,
} from "./Shell";

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "users", label: "Users", icon: Users },
  { id: "usage", label: "Usage & quotas", icon: Gauge },
  { id: "tickets", label: "Tickets", icon: TicketIcon },
  { id: "chat", label: "Chat", icon: MessagesSquare },
  { id: "problems", label: "Problems", icon: AlertTriangle },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "settings", label: "Settings", icon: Settings },
] as const;
type TabId = (typeof TABS)[number]["id"];

const shortDate = (key: string) => {
  const [, m, d] = key.split("-");
  return `${Number(d)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}`;
};
const fmt = (n: number) => n.toLocaleString("en-IN");

// ---------- Building blocks ----------
function Tile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "warn" | "bad" | "good";
}) {
  return (
    <div className={`tile ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

// Single-series daily bar chart with hover tooltips and a table fallback.
function Bars({
  title,
  data,
  unit,
}: {
  title: string;
  data: { key: string; value: number }[];
  unit: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const top = Math.ceil(max / 4) * 4 || 4;
  const step = Math.ceil(data.length / 7);
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <figure className="chart card">
      <figcaption>
        <strong>{title}</strong>
        <span>
          {fmt(total)} {unit} in {data.length} days
        </span>
      </figcaption>
      <div className="chart-body">
        <div className="chart-y" aria-hidden="true">
          <span>{fmt(top)}</span>
          <span>{fmt(top / 2)}</span>
          <span>0</span>
        </div>
        <div className="chart-plot" role="list" aria-label={title}>
          {data.map((d) => (
            <div
              className="bar-col"
              key={d.key}
              role="listitem"
              tabIndex={0}
              aria-label={`${shortDate(d.key)}: ${d.value} ${unit}`}
            >
              <div
                className="bar"
                style={{ height: `${(d.value / top) * 100}%` }}
              />
              <span className="bar-tip">
                {shortDate(d.key)}
                <b>
                  {fmt(d.value)} {unit}
                </b>
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="chart-x" aria-hidden="true">
        {data.map((d, i) => (
          <span key={d.key}>
            {i % step === 0 || i === data.length - 1 ? shortDate(d.key) : ""}
          </span>
        ))}
      </div>
      <details className="chart-table">
        <summary>View as table</summary>
        <table>
          <tbody>
            {data.map((d) => (
              <tr key={d.key}>
                <td>{shortDate(d.key)}</td>
                <td>{fmt(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card admin-section">
      <div className="panel-title">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ---------- Data shared by every tab ----------
function useAdminData() {
  const since = lastDays(30)[0]!;
  const users = useLive<UserProfile>(
    () => (db ? query(collection(db, "users")) : null),
    "admin-users",
  );
  const tickets = useLive<Ticket>(
    () =>
      db
        ? query(collection(db, "tickets"), orderBy("createdAt", "desc"))
        : null,
    "admin-tickets",
  );
  const usage = useLive<DayUsage>(
    () =>
      db ? query(collection(db, "usage"), where("date", ">=", since)) : null,
    `admin-usage-${since}`,
  );
  const stats = useLive<DayStats>(
    () =>
      db ? query(collection(db, "stats"), where("date", ">=", since)) : null,
    `admin-stats-${since}`,
  );
  const problems = useLive<Problem>(
    () =>
      db
        ? query(
            collection(db, "problems"),
            orderBy("createdAt", "desc"),
            limit(300),
          )
        : null,
    "admin-problems",
  );
  const stored = useDoc<Partial<AppSettings>>("config/app");
  const settings = { ...defaultSettings, ...stored };
  const errors = [users, tickets, usage, stats, problems]
    .map((x) => x.error)
    .filter(Boolean);
  return {
    users: users.rows,
    tickets: tickets.rows,
    usage: usage.rows,
    stats: stats.rows,
    problems: problems.rows,
    settings,
    loading: users.loading || tickets.loading,
    error: errors[0] ?? "",
  };
}
type AdminData = ReturnType<typeof useAdminData>;

const series = (
  days: string[],
  rows: { date: string }[],
  pick: (r: never) => number,
) =>
  days.map((key) => ({
    key,
    value: rows
      .filter((r) => r.date === key)
      .reduce((s, r) => s + (pick(r as never) || 0), 0),
  }));
const limitFor = (u: UserProfile, s: AppSettings) =>
  u.dailyLimit ?? s.defaultDailyLimit;

// ---------- Tabs ----------
function Overview({ d }: { d: AdminData }) {
  const date = today();
  const days = lastDays(14);
  const todayStats = d.stats.find((s) => s.date === date);
  const activeToday = new Set(
    d.usage.filter((u) => u.date === date).map((u) => u.uid),
  ).size;
  const week = lastDays(7)[0]!;
  const activeWeek = new Set(
    d.usage.filter((u) => u.date >= week).map((u) => u.uid),
  ).size;
  const newWeek = d.users.filter(
    (u) => millis(u.createdAt) > Date.now() - 7 * 86400000,
  ).length;
  const openTickets = d.tickets.filter(
    (t) => !["resolved", "closed"].includes(t.status),
  );
  const searchesToday = todayStats?.searches ?? 0;
  const left = Math.max(0, d.settings.dailyApiBudget - searchesToday);
  const problems24 = d.problems.filter(
    (p) => millis(p.createdAt) > Date.now() - 86400000,
  ).length;
  return (
    <>
      <div className="tiles">
        <Tile
          label="Total users"
          value={fmt(d.users.length)}
          note={`${newWeek} new this week`}
        />
        <Tile
          label="Active today"
          value={fmt(activeToday)}
          note={`${activeWeek} in the last 7 days`}
        />
        <Tile
          label="API calls left today"
          value={fmt(left)}
          note={`${fmt(searchesToday)} of ${fmt(d.settings.dailyApiBudget)} route searches used`}
          tone={
            left === 0
              ? "bad"
              : left < d.settings.dailyApiBudget * 0.2
                ? "warn"
                : "good"
          }
        />
        <Tile
          label="Open tickets"
          value={fmt(openTickets.length)}
          note={`${d.tickets.filter((t) => t.unreadForAdmin).length} awaiting your reply`}
          tone={openTickets.length ? "warn" : undefined}
        />
        <Tile
          label="Problems (24h)"
          value={fmt(problems24)}
          note={`${d.problems.length} logged recently`}
          tone={problems24 ? "bad" : "good"}
        />
      </div>
      <div className="chart-grid">
        <Bars
          title="Route searches per day"
          unit="searches"
          data={series(days, d.stats, (r: DayStats) => r.searches ?? 0)}
        />
        <Bars
          title="New sign-ups per day"
          unit="sign-ups"
          data={series(days, d.stats, (r: DayStats) => r.signups ?? 0)}
        />
      </div>
      <div className="two-col">
        <Section
          title="Latest tickets"
          aside={<a href="#/admin/tickets">View all</a>}
        >
          {d.tickets.length === 0 ? (
            <Empty icon={<Inbox size={24} />} title="No tickets yet" />
          ) : (
            <ul className="ticket-list compact">
              {d.tickets.slice(0, 6).map((t) => (
                <li key={t.id}>
                  <a href={`#/admin/tickets/${t.id}`}>
                    <div>
                      <strong>
                        {t.unreadForAdmin && <i className="dot" />}
                        {t.subject}
                      </strong>
                      <small>
                        {ticketNo(t.id)} · {t.email} · {ago(t.createdAt)}
                      </small>
                    </div>
                    <StatusBadge status={t.status} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <BackendHealth />
      </div>
    </>
  );
}

function BackendHealth() {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState(0);
  useEffect(() => {
    api<Record<string, unknown>>("/api/health")
      .then((h) => {
        setHealth(h);
        setError("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [checked]);
  const row = (label: string, ok: boolean, detail?: string) => (
    <li className={ok ? "ok" : "bad"}>
      {ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      <span>{label}</span>
      <small>{detail ?? (ok ? "Working" : "Not configured")}</small>
    </li>
  );
  const database = health?.database as { status?: string } | string | undefined;
  const dbStatus =
    typeof database === "string" ? database : (database?.status ?? "unknown");
  return (
    <Section
      title="System health"
      aside={
        <button className="link-btn" onClick={() => setChecked((c) => c + 1)}>
          Re-check
        </button>
      }
    >
      {error ? (
        <ul className="health">{row("Backend API", false, error)}</ul>
      ) : !health ? (
        <p className="muted">Checking…</p>
      ) : (
        <ul className="health">
          {row("Backend API", health.status === "ok", String(health.status))}
          {row("Google Maps routing", Boolean(health.provider_configured))}
          {row("Gemini fare suggestions", Boolean(health.gemini_configured))}
          {row(
            "Database",
            /ok|ready|connected|memory/i.test(dbStatus),
            dbStatus,
          )}
          {row(
            "Firebase Auth & Firestore",
            Boolean(db),
            db ? "Connected" : "Missing config",
          )}
        </ul>
      )}
    </Section>
  );
}

function UsersTab({ d, selected }: { d: AdminData; selected?: string }) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const date = today();
  const todayByUser = new Map(
    d.usage.filter((u) => u.date === date).map((u) => [u.uid, u]),
  );
  const rows = d.users
    .filter((u) =>
      `${u.name} ${u.email}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => millis(b.lastActive) - millis(a.lastActive));
  const picked = d.users.find((u) => u.id === selected);
  return (
    <div className={picked ? "split" : ""}>
      <Section
        title={`Users (${d.users.length})`}
        aside={
          <label className="search-input">
            <Search size={15} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or email"
              aria-label="Search users"
            />
          </label>
        }
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Joined</th>
                <th>Last active</th>
                <th className="num">Today</th>
                <th className="num">Left today</th>
                <th className="num">All-time searches</th>
                <th className="num">Tickets</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const used = todayByUser.get(u.uid)?.searches ?? 0;
                const lim = limitFor(u, d.settings);
                const left = Math.max(0, lim - used);
                return (
                  <tr
                    key={u.id}
                    className={u.id === selected ? "selected" : ""}
                    onClick={() =>
                      (location.hash = `#/admin/users/${u.id === selected ? "" : u.id}`)
                    }
                  >
                    <td>
                      <strong>{u.name}</strong>
                      <small>
                        {u.email}
                        {u.email === ADMIN_EMAIL && " · admin"}
                      </small>
                    </td>
                    <td>
                      {u.createdAt
                        ? u.createdAt.toDate().toLocaleDateString()
                        : "—"}
                    </td>
                    <td>{ago(u.lastActive)}</td>
                    <td className="num">{used}</td>
                    <td className={`num ${left === 0 ? "bad-text" : ""}`}>
                      {left} / {lim}
                    </td>
                    <td className="num">{u.usage?.searches ?? 0}</td>
                    <td className="num">{u.tickets ?? 0}</td>
                    <td>
                      {u.blocked ? (
                        <span className="status status-closed">Blocked</span>
                      ) : (
                        <span className="status status-resolved">Active</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <Empty icon={<Users size={24} />} title="No users match" />
          )}
        </div>
      </Section>
      {picked && user && <UserDetail u={picked} d={d} adminUid={user.uid} />}
    </div>
  );
}

function UserDetail({
  u,
  d,
  adminUid,
}: {
  u: UserProfile;
  d: AdminData;
  adminUid: string;
}) {
  const [limitText, setLimitText] = useState(u.dailyLimit?.toString() ?? "");
  const [msg, setMsg] = useState("");
  const [status, setStatus] = useState("");
  // Keep the input in sync with saved data, but only clear the status line when switching users.
  useEffect(
    () => setLimitText(u.dailyLimit?.toString() ?? ""),
    [u.id, u.dailyLimit],
  );
  useEffect(() => setStatus(""), [u.id]);
  const mine = d.usage.filter((x) => x.uid === u.uid);
  const days = lastDays(14);
  const theirTickets = d.tickets.filter((t) => t.uid === u.uid);
  const save = async (fields: Partial<UserProfile>, done: string) => {
    try {
      await updateDoc(doc(db!, "users", u.id), fields);
      setStatus(done);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <aside className="card detail-panel">
      <div className="panel-title">
        <h2>{u.name}</h2>
        <a href="#/admin/users" aria-label="Close user details">
          ✕
        </a>
      </div>
      <p className="muted">
        {u.email} · signed in with {u.provider.replace(".com", "")} · joined{" "}
        {ago(u.createdAt)}
      </p>
      <div className="tiles small">
        <Tile label="Searches" value={u.usage?.searches ?? 0} />
        <Tile label="Locations" value={u.usage?.locates ?? 0} />
        <Tile label="Journeys" value={u.usage?.navigations ?? 0} />
        <Tile
          label="Problems"
          value={u.problems ?? 0}
          tone={u.problems ? "warn" : undefined}
        />
      </div>
      <Bars
        title="Searches, last 14 days"
        unit="searches"
        data={series(days, mine, (r: DayUsage) => r.searches ?? 0)}
      />
      <div className="field">
        <span>DAILY SEARCH LIMIT</span>
        <div className="inline-form">
          <input
            type="number"
            min={0}
            max={10000}
            value={limitText}
            onChange={(e) => setLimitText(e.target.value)}
            placeholder={`Default (${d.settings.defaultDailyLimit})`}
            aria-label="Daily search limit"
          />
          <button
            className="primary"
            onClick={() =>
              save(
                {
                  dailyLimit:
                    limitText.trim() === ""
                      ? null
                      : Math.max(0, Math.floor(Number(limitText))),
                },
                "Limit saved",
              )
            }
          >
            Save
          </button>
        </div>
      </div>
      <div className="action-row">
        {u.blocked ? (
          <button
            className="secondary"
            onClick={() => save({ blocked: false }, "User unblocked")}
          >
            <UserCheck size={15} /> Unblock user
          </button>
        ) : (
          <button
            className="danger-btn"
            disabled={u.email === ADMIN_EMAIL}
            onClick={() => save({ blocked: true }, "User blocked")}
          >
            <Ban size={15} /> Block user
          </button>
        )}
      </div>
      <div className="field">
        <span>SEND A NOTIFICATION</span>
        <div className="inline-form">
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder="Message to this user"
            maxLength={500}
            aria-label="Notification message"
          />
          <button
            className="primary"
            disabled={!msg.trim()}
            onClick={async () => {
              await notify(
                u.uid,
                adminUid,
                "Message from RouteWise",
                msg.trim(),
              );
              setMsg("");
              setStatus("Notification sent");
            }}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
      {status && <p className="form-note">{status}</p>}
      <h3 className="sub-heading">Tickets ({theirTickets.length})</h3>
      <ul className="ticket-list compact">
        {theirTickets.map((t) => (
          <li key={t.id}>
            <a href={`#/admin/tickets/${t.id}`}>
              <div>
                <strong>{t.subject}</strong>
                <small>
                  {ticketNo(t.id)} · {ago(t.createdAt)}
                </small>
              </div>
              <StatusBadge status={t.status} />
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function UsageTab({ d }: { d: AdminData }) {
  const [period, setPeriod] = useState(14);
  const days = lastDays(period);
  const from = days[0]!;
  const inPeriod = d.usage.filter((u) => u.date >= from);
  const sum = (k: "searches" | "locates" | "navigations") =>
    inPeriod.reduce((s, u) => s + (u[k] ?? 0), 0);
  const date = today();
  const byUser = new Map<
    string,
    {
      searches: number;
      locates: number;
      navigations: number;
      days: Set<string>;
    }
  >();
  for (const u of inPeriod) {
    const row = byUser.get(u.uid) ?? {
      searches: 0,
      locates: 0,
      navigations: 0,
      days: new Set(),
    };
    row.searches += u.searches ?? 0;
    row.locates += u.locates ?? 0;
    row.navigations += u.navigations ?? 0;
    row.days.add(u.date);
    byUser.set(u.uid, row);
  }
  const people = new Map(d.users.map((u) => [u.uid, u]));
  const top = [...byUser.entries()]
    .sort((a, b) => b[1].searches - a[1].searches)
    .slice(0, 15);
  const todayStats = d.stats.find((s) => s.date === date);
  const used = todayStats?.searches ?? 0;
  const nearLimit = d.users
    .map((u) => {
      const t =
        d.usage.find((x) => x.uid === u.uid && x.date === date)?.searches ?? 0;
      const lim = limitFor(u, d.settings);
      return { u, used: t, lim, left: Math.max(0, lim - t) };
    })
    .filter((x) => x.used > 0)
    .sort((a, b) => a.left - b.left);
  return (
    <>
      <div className="filter-row">
        {[7, 14, 30].map((n) => (
          <button
            key={n}
            className={period === n ? "chip selected" : "chip"}
            onClick={() => setPeriod(n)}
          >
            Last {n} days
          </button>
        ))}
      </div>
      <div className="tiles">
        <Tile
          label="API calls left today"
          value={fmt(Math.max(0, d.settings.dailyApiBudget - used))}
          note={
            <span className="meter">
              <i>
                <em
                  style={{
                    width: `${Math.min(100, (used / Math.max(1, d.settings.dailyApiBudget)) * 100)}%`,
                  }}
                />
              </i>
              {fmt(used)} / {fmt(d.settings.dailyApiBudget)} used
            </span>
          }
        />
        <Tile
          label="Route searches"
          value={fmt(sum("searches"))}
          note={`last ${period} days`}
        />
        <Tile
          label="Location checks"
          value={fmt(sum("locates"))}
          note={`last ${period} days`}
        />
        <Tile
          label="Journeys tracked"
          value={fmt(sum("navigations"))}
          note={`last ${period} days`}
        />
        <Tile
          label="Active users"
          value={fmt(byUser.size)}
          note={`used RouteWise in ${period} days`}
        />
      </div>
      <div className="chart-grid">
        <Bars
          title="Route searches per day"
          unit="searches"
          data={series(days, d.stats, (r: DayStats) => r.searches ?? 0)}
        />
        <Bars
          title="Active users per day"
          unit="users"
          data={days.map((key) => ({
            key,
            value: new Set(
              d.usage.filter((u) => u.date === key).map((u) => u.uid),
            ).size,
          }))}
        />
      </div>
      <div className="two-col">
        <Section title="Usage by user" aside={<span>LAST {period} DAYS</span>}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th className="num">Searches</th>
                  <th className="num">Locations</th>
                  <th className="num">Journeys</th>
                  <th className="num">Active days</th>
                </tr>
              </thead>
              <tbody>
                {top.map(([uid, r]) => (
                  <tr
                    key={uid}
                    onClick={() => (location.hash = `#/admin/users/${uid}`)}
                  >
                    <td>
                      <strong>{people.get(uid)?.name ?? "Unknown"}</strong>
                      <small>{people.get(uid)?.email ?? uid}</small>
                    </td>
                    <td className="num">{r.searches}</td>
                    <td className="num">{r.locates}</td>
                    <td className="num">{r.navigations}</td>
                    <td className="num">{r.days.size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {top.length === 0 && (
              <Empty
                icon={<Activity size={24} />}
                title="No usage in this period"
              />
            )}
          </div>
        </Section>
        <Section
          title="Leftover calls per user today"
          aside={<span>CLOSEST TO LIMIT FIRST</span>}
        >
          {nearLimit.length === 0 ? (
            <Empty
              icon={<Gauge size={24} />}
              title="Nobody has searched today"
            />
          ) : (
            <ul className="quota-list">
              {nearLimit.map(({ u, used: n, lim, left }) => (
                <li key={u.id}>
                  <a href={`#/admin/users/${u.id}`}>
                    <div>
                      <strong>{u.name}</strong>
                      <small>{u.email}</small>
                    </div>
                    <span className={left === 0 ? "bad-text" : ""}>
                      {left} left{" "}
                      <small>
                        ({n}/{lim})
                      </small>
                    </span>
                  </a>
                  <i className="meter-bar">
                    <em
                      className={left === 0 ? "full" : ""}
                      style={{
                        width: `${Math.min(100, (n / Math.max(1, lim)) * 100)}%`,
                      }}
                    />
                  </i>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

function TicketAdmin({ t }: { t: Ticket }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = async (s: TicketStatus) => {
    if (!user) return;
    setBusy(true);
    setError("");
    try {
      await setTicketStatus(user, t, s, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  async function remove() {
    if (
      !db ||
      !confirm(
        `Delete ticket ${ticketNo(t.id)} and its conversation? This can't be undone.`,
      )
    )
      return;
    const msgs = await getDocs(collection(db, "tickets", t.id, "messages"));
    const batch = writeBatch(db);
    msgs.forEach((m) => batch.delete(m.ref));
    batch.delete(doc(db, "ticketImages", t.id));
    batch.delete(doc(db, "tickets", t.id));
    await batch.commit();
    location.hash = "#/admin/tickets";
  }
  const next: Partial<Record<TicketStatus, [TicketStatus, string]>> = {
    open: ["received", "Confirm received"],
    received: ["in_progress", "Start working"],
    in_progress: ["resolved", "Mark resolved"],
    resolved: ["closed", "Close ticket"],
  };
  const step = next[t.status];
  return (
    <aside className="card detail-panel">
      <div className="panel-title">
        <h2>{t.subject}</h2>
        <a href="#/admin/tickets" aria-label="Close ticket">
          ✕
        </a>
      </div>
      <div className="ticket-meta">
        <StatusBadge status={t.status} />
        <span>{ticketNo(t.id)}</span>
        <span>{t.category}</span>
        <span className={`priority priority-${t.priority}`}>
          {t.priority} priority
        </span>
      </div>
      <p className="muted">
        From <a href={`#/admin/users/${t.uid}`}>{t.name}</a> ({t.email}) ·
        opened {ago(t.createdAt)}
      </p>
      <div className="status-controls">
        {step && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => change(step[0])}
          >
            {step[1]}
          </button>
        )}
        <label>
          <span>Set status</span>
          <select
            value={t.status}
            disabled={busy}
            onChange={(e) => change(e.target.value as TicketStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-btn danger"
          onClick={remove}
          aria-label="Delete ticket"
        >
          <Trash2 size={16} />
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {t.hasImage && <TicketImage ticketId={t.id} />}
      <TicketThread ticket={t} asAdmin />
    </aside>
  );
}

function TicketsTab({ d, selected }: { d: AdminData; selected?: string }) {
  const [filter, setFilter] = useState<TicketStatus | "all" | "active">(
    "active",
  );
  const [search, setSearch] = useState("");
  const counts = Object.fromEntries(
    STATUSES.map((s) => [
      s.id,
      d.tickets.filter((t) => t.status === s.id).length,
    ]),
  );
  const rows = d.tickets.filter(
    (t) =>
      (filter === "all" ||
        (filter === "active"
          ? !["resolved", "closed"].includes(t.status)
          : t.status === filter)) &&
      `${t.subject} ${t.email} ${t.name} ${ticketNo(t.id)}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const picked = d.tickets.find((t) => t.id === selected);
  return (
    <>
      <div className="filter-row">
        <button
          className={filter === "active" ? "chip selected" : "chip"}
          onClick={() => setFilter("active")}
        >
          Needs action (
          {
            d.tickets.filter((t) => !["resolved", "closed"].includes(t.status))
              .length
          }
          )
        </button>
        {STATUSES.map((s) => (
          <button
            key={s.id}
            className={filter === s.id ? "chip selected" : "chip"}
            onClick={() => setFilter(s.id)}
          >
            {s.label} ({counts[s.id]})
          </button>
        ))}
        <button
          className={filter === "all" ? "chip selected" : "chip"}
          onClick={() => setFilter("all")}
        >
          All ({d.tickets.length})
        </button>
        <label className="search-input">
          <Search size={15} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tickets"
            aria-label="Search tickets"
          />
        </label>
      </div>
      <div className={picked ? "split" : ""}>
        <Section title="Tickets">
          {rows.length === 0 ? (
            <Empty icon={<Inbox size={24} />} title="No tickets here" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>From</th>
                    <th>Priority</th>
                    <th>Updated</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr
                      key={t.id}
                      className={t.id === selected ? "selected" : ""}
                      onClick={() =>
                        (location.hash = `#/admin/tickets/${t.id}`)
                      }
                    >
                      <td>
                        <strong>
                          {t.unreadForAdmin && (
                            <i className="dot" aria-label="Unread" />
                          )}
                          {t.subject}
                        </strong>
                        <small>
                          {ticketNo(t.id)} · {t.category}
                          {t.hasImage ? " · 📎 image" : ""}
                        </small>
                      </td>
                      <td>
                        <strong>{t.name}</strong>
                        <small>{t.email}</small>
                      </td>
                      <td>
                        <span className={`priority priority-${t.priority}`}>
                          {t.priority}
                        </span>
                      </td>
                      <td>{ago(t.lastMessageAt)}</td>
                      <td>
                        <StatusBadge status={t.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        {picked && <TicketAdmin t={picked} />}
      </div>
    </>
  );
}

function ChatTab({ d, selected }: { d: AdminData; selected?: string }) {
  const convos = [...d.tickets].sort(
    (a, b) =>
      Number(b.unreadForAdmin ?? 0) - Number(a.unreadForAdmin ?? 0) ||
      millis(b.lastMessageAt) - millis(a.lastMessageAt),
  );
  const picked = d.tickets.find((t) => t.id === selected) ?? null;
  return (
    <div className="chat-layout card">
      <ul className="convo-list">
        {convos.length === 0 && (
          <Empty
            icon={<MessagesSquare size={24} />}
            title="No conversations yet"
          />
        )}
        {convos.map((t) => (
          <li key={t.id}>
            <a
              href={`#/admin/chat/${t.id}`}
              className={t.id === selected ? "active" : ""}
            >
              <span className="avatar sm">
                {t.name.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <strong>
                  {t.unreadForAdmin && <i className="dot" />}
                  {t.name}
                </strong>
                <small>{t.lastMessage ?? t.subject}</small>
              </div>
              <time>{ago(t.lastMessageAt)}</time>
            </a>
          </li>
        ))}
      </ul>
      <div className="convo-pane">
        {picked ? (
          <>
            <div className="convo-head">
              <div>
                <strong>{picked.subject}</strong>
                <small>
                  {picked.name} · {picked.email} · {ticketNo(picked.id)}
                </small>
              </div>
              <StatusBadge status={picked.status} />
              <a href={`#/admin/tickets/${picked.id}`} className="link-btn">
                Manage
              </a>
            </div>
            <TicketThread ticket={picked} asAdmin />
          </>
        ) : (
          <Empty
            icon={<MessagesSquare size={28} />}
            title="Pick a conversation"
          >
            Replies send a notification to the user straight away.
          </Empty>
        )}
      </div>
    </div>
  );
}

function ProblemsTab({ d }: { d: AdminData }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const map = new Map<string, Problem[]>();
    for (const p of d.problems)
      map.set(p.message, [...(map.get(p.message) ?? []), p]);
    return [...map.entries()].sort(
      (a, b) => millis(b[1][0]!.createdAt) - millis(a[1][0]!.createdAt),
    );
  }, [d.problems]);
  async function resolve(items: Problem[]) {
    if (!db) return;
    const batch = writeBatch(db);
    items.forEach((p) => batch.delete(doc(db!, "problems", p.id)));
    await batch.commit();
  }
  const days = lastDays(14);
  return (
    <>
      <div className="chart-grid">
        <Bars
          title="Problems reported per day"
          unit="problems"
          data={series(days, d.stats, (r: DayStats) => r.problems ?? 0)}
        />
        <BackendHealth />
      </div>
      <Section
        title={`Problems (${d.problems.length})`}
        aside={<span>ERRORS USERS SAW, GROUPED</span>}
      >
        {groups.length === 0 ? (
          <Empty icon={<CheckCircle2 size={24} />} title="No problems reported">
            Errors users see in the planner are logged here automatically.
          </Empty>
        ) : (
          <ul className="problem-list">
            {groups.map(([message, items]) => {
              const affected = new Set(items.map((p) => p.uid)).size;
              return (
                <li key={message}>
                  <div className="problem-row">
                    <ShieldAlert size={18} />
                    <button
                      className="problem-text"
                      onClick={() => setOpen(open === message ? null : message)}
                    >
                      <strong>{message}</strong>
                      <small>
                        {items.length}× · {affected} user
                        {affected === 1 ? "" : "s"} · last{" "}
                        {ago(items[0]!.createdAt)} · {items[0]!.source}
                      </small>
                    </button>
                    <button
                      className="secondary"
                      onClick={() => resolve(items)}
                    >
                      <CheckCircle2 size={15} /> Resolve
                    </button>
                  </div>
                  {open === message && (
                    <table className="data-table inner">
                      <tbody>
                        {items.slice(0, 20).map((p) => (
                          <tr key={p.id}>
                            <td>{p.email}</td>
                            <td>{p.page}</td>
                            <td>{ago(p.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}

function NotificationsTab({ d }: { d: AdminData }) {
  const { user } = useAuth();
  const [to, setTo] = useState("all");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const sent = useLive<Notice>(
    () =>
      db && user
        ? query(collection(db, "notifications"), where("from", "==", user.uid))
        : null,
    `sent-${user?.uid}`,
  );
  const inbox = useLive<Notice>(
    () =>
      db
        ? query(collection(db, "notifications"), where("to", "==", "admin"))
        : null,
    "admin-inbox",
  );
  const history = [...sent.rows]
    .sort((a, b) => millis(b.createdAt) - millis(a.createdAt))
    .slice(0, 50);
  const received = [...inbox.rows]
    .sort((a, b) => millis(b.createdAt) - millis(a.createdAt))
    .slice(0, 50);
  const people = new Map(d.users.map((u) => [u.uid, u]));
  async function send() {
    if (!user || !title.trim()) return;
    setBusy(true);
    setStatus("");
    try {
      if (to === "all") {
        const uids = d.users.filter((u) => !u.blocked).map((u) => u.uid);
        await broadcast(uids, user.uid, title.trim(), body.trim());
        setStatus(`Sent to ${uids.length} users`);
      } else {
        await notify(to, user.uid, title.trim(), body.trim());
        setStatus(`Sent to ${people.get(to)?.email ?? "user"}`);
      }
      setTitle("");
      setBody("");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="two-col">
      <Section title="Send a notification">
        <label className="field">
          <span>TO</span>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="all">
              All active users ({d.users.filter((u) => !u.blocked).length})
            </option>
            {d.users.map((u) => (
              <option key={u.uid} value={u.uid}>
                {u.name} — {u.email}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>TITLE</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder="e.g. New bus routes added"
          />
        </label>
        <label className="field">
          <span>MESSAGE</span>
          <textarea
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={500}
          />
        </label>
        <button
          className="primary wide-btn"
          disabled={busy || !title.trim()}
          onClick={send}
        >
          {busy ? (
            <span className="spinner" />
          ) : (
            <>
              <Send size={15} /> Send notification
            </>
          )}
        </button>
        {status && <p className="form-note">{status}</p>}
        <h3 className="sub-heading">Sent recently</h3>
        <ul className="notice-list">
          {history.length === 0 && <li className="muted">Nothing sent yet.</li>}
          {history.map((n) => (
            <li key={n.id}>
              <strong>{n.title}</strong>
              <span>{n.body}</span>
              <small>
                to {people.get(n.to)?.email ?? n.to} · {ago(n.createdAt)} ·{" "}
                {n.read ? "read" : "unread"}
              </small>
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title="Admin inbox"
        aside={<span>{received.filter((n) => !n.read).length} UNREAD</span>}
      >
        <ul className="notice-list">
          {received.length === 0 && <li className="muted">No activity yet.</li>}
          {received.map((n) => (
            <li key={n.id} className={n.read ? "" : "unread"}>
              <a
                href={safeLink(n.link)}
                onClick={() =>
                  !n.read &&
                  updateDoc(doc(db!, "notifications", n.id), { read: true })
                }
              >
                <strong>{n.title}</strong>
                <span>{n.body}</span>
                <small>{ago(n.createdAt)}</small>
              </a>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function SettingsTab({ d }: { d: AdminData }) {
  const [form, setForm] = useState<AppSettings>(d.settings);
  const [status, setStatus] = useState("");
  useEffect(
    () => setForm(d.settings),
    [
      d.settings.defaultDailyLimit,
      d.settings.dailyApiBudget,
      d.settings.announcement,
    ],
  );
  async function save() {
    try {
      await setDoc(
        doc(db!, "config", "app"),
        {
          defaultDailyLimit: Math.max(0, Math.floor(form.defaultDailyLimit)),
          dailyApiBudget: Math.max(0, Math.floor(form.dailyApiBudget)),
          announcement: form.announcement.trim().slice(0, 300),
        },
        { merge: true },
      );
      setStatus("Settings saved — users see changes immediately.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="two-col">
      <Section title="Limits & announcement">
        <div className="form-grid">
          <label className="field">
            <span>DEFAULT DAILY SEARCHES PER USER</span>
            <input
              type="number"
              min={0}
              value={form.defaultDailyLimit}
              onChange={(e) =>
                setForm({ ...form, defaultDailyLimit: Number(e.target.value) })
              }
            />
          </label>
          <label className="field">
            <span>TOTAL DAILY API BUDGET</span>
            <input
              type="number"
              min={0}
              value={form.dailyApiBudget}
              onChange={(e) =>
                setForm({ ...form, dailyApiBudget: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <label className="field">
          <span>ANNOUNCEMENT BANNER (BLANK TO HIDE)</span>
          <textarea
            rows={3}
            maxLength={300}
            value={form.announcement}
            onChange={(e) => setForm({ ...form, announcement: e.target.value })}
            placeholder="Shown at the top of the planner for every signed-in user"
          />
        </label>
        <button className="primary wide-btn" onClick={save}>
          Save settings
        </button>
        {status && <p className="form-note">{status}</p>}
      </Section>
      <Section title="How access works">
        <ul className="health">
          <li className="ok">
            <ShieldAlert size={16} />
            <span>Admin</span>
            <small>{ADMIN_EMAIL} (verified email only)</small>
          </li>
          <li className="ok">
            <Server size={16} />
            <span>Enforcement</span>
            <small>Firestore security rules in firestore.rules</small>
          </li>
          <li className="ok">
            <Gauge size={16} />
            <span>Limits</span>
            <small>Per-user override in Users → user</small>
          </li>
        </ul>
        <p className="muted small-print">
          Daily limits are counted per calendar day in the user's timezone.
          Blocked users keep their account but can't search, locate or track.
        </p>
      </Section>
    </div>
  );
}

// ---------- Page ----------
export default function Admin({
  tab,
  itemId,
}: {
  tab?: string;
  itemId?: string;
}) {
  const { user, ready, isAdmin, openAuth, refreshUser } = useAuth();
  const [note, setNote] = useState("");
  if (!ready) return <PageShell title="Admin">{null}</PageShell>;
  if (!user)
    return (
      <PageShell title="Admin">
        <Empty icon={<LogIn size={28} />} title="Admin sign-in required" />
        <div className="center">
          <button className="primary" onClick={() => openAuth("login")}>
            Log in
          </button>
        </div>
      </PageShell>
    );
  if (isAdminEmail(user) && !user.emailVerified)
    return (
      <PageShell title="Admin">
        <Empty
          icon={<MailCheck size={28} />}
          title="Verify your email to open the dashboard"
        >
          We sent a verification link to {user.email}. Click it, then press
          “I've verified”. Signing in with Google verifies automatically.
        </Empty>
        <div className="center action-row">
          <button
            className="secondary"
            onClick={() =>
              sendEmailVerification(user)
                .then(() => setNote("Verification email sent."))
                .catch((e) => setNote(e.message))
            }
          >
            Resend email
          </button>
          <button
            className="primary"
            onClick={() =>
              refreshUser().then(() =>
                setNote(
                  user.emailVerified
                    ? ""
                    : "Still not verified — check your inbox.",
                ),
              )
            }
          >
            I've verified
          </button>
        </div>
        {note && <p className="center muted">{note}</p>}
      </PageShell>
    );
  if (!isAdmin)
    return (
      <PageShell title="Admin">
        <Empty
          icon={<ShieldAlert size={28} />}
          title="This area is for the RouteWise team"
        >
          You're signed in as {user.email}. Head back to the planner, or open
          Help & support.
        </Empty>
      </PageShell>
    );
  return (
    <Dashboard
      tab={(TABS.some((t) => t.id === tab) ? tab : "overview") as TabId}
      itemId={itemId}
    />
  );
}

function Dashboard({ tab, itemId }: { tab: TabId; itemId?: string }) {
  const d = useAdminData();
  const badge: Partial<Record<TabId, number>> = {
    tickets: d.tickets.filter((t) => t.status === "open").length,
    chat: d.tickets.filter((t) => t.unreadForAdmin).length,
    problems: d.problems.filter(
      (p) => millis(p.createdAt) > Date.now() - 86400000,
    ).length,
  };
  const current = TABS.find((t) => t.id === tab)!;
  return (
    <PageShell title="Admin" wide>
      <div className="admin-layout">
        <nav className="admin-nav" aria-label="Admin sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#/admin/${id}`}
              className={id === tab ? "active" : ""}
              aria-current={id === tab ? "page" : undefined}
            >
              <Icon size={17} />
              <span>{label}</span>
              {badge[id] ? <b>{badge[id]}</b> : null}
            </a>
          ))}
        </nav>
        <div className="admin-content">
          <div className="admin-heading">
            <div>
              <div className="eyebrow">ADMIN DASHBOARD</div>
              <h1>{current.label}</h1>
            </div>
          </div>
          {d.error && (
            <div className="error-banner" role="alert">
              <AlertTriangle size={20} />
              <div>
                <strong>Some data couldn't load</strong>
                <p>{d.error}</p>
              </div>
            </div>
          )}
          {d.loading ? (
            <p className="muted">Loading dashboard…</p>
          ) : tab === "overview" ? (
            <Overview d={d} />
          ) : tab === "users" ? (
            <UsersTab d={d} selected={itemId} />
          ) : tab === "usage" ? (
            <UsageTab d={d} />
          ) : tab === "tickets" ? (
            <TicketsTab d={d} selected={itemId} />
          ) : tab === "chat" ? (
            <ChatTab d={d} selected={itemId} />
          ) : tab === "problems" ? (
            <ProblemsTab d={d} />
          ) : tab === "notifications" ? (
            <NotificationsTab d={d} />
          ) : (
            <SettingsTab d={d} />
          )}
        </div>
      </div>
    </PageShell>
  );
}
