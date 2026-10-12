import { useState, type FormEvent } from "react";
import { collection, query, where } from "firebase/firestore";
import {
  Activity,
  ImagePlus,
  Inbox,
  LifeBuoy,
  LogIn,
  RotateCcw,
  X,
} from "lucide-react";
import { useAuth } from "./auth";
import { db } from "./firebase";
import {
  ago,
  CATEGORIES,
  compressImage,
  createTicket,
  millis,
  setTicketStatus,
  ticketNo,
  useLive,
  type Priority,
  type Ticket,
} from "./data";
import {
  Empty,
  PageShell,
  StatusBadge,
  TicketImage,
  TicketThread,
} from "./Shell";

function NewTicket({ onCreated }: { onCreated: (id: string) => void }) {
  const { user } = useAuth();
  const [subject, setSubject] = useState(""),
    [category, setCategory] = useState(CATEGORIES[0]!),
    [priority, setPriority] = useState<Priority>("normal"),
    [description, setDescription] = useState(""),
    [image, setImage] = useState<string | null>(null),
    [imageName, setImageName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function pick(file?: File) {
    if (!file) return;
    setError("");
    try {
      setImage(await compressImage(file));
      setImageName(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    setError("");
    try {
      const id = await createTicket(
        user,
        {
          subject: subject.trim(),
          category,
          priority,
          description: description.trim(),
        },
        image,
      );
      setSubject("");
      setDescription("");
      setImage(null);
      setImageName("");
      onCreated(id);
    } catch (err) {
      setError(
        (err as { code?: string }).code === "permission-denied"
          ? "Couldn't save the ticket: Firestore rules aren't published yet."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card ticket-form" onSubmit={submit}>
      <div className="panel-title">
        <h2>Raise a ticket</h2>
        <span>WE REPLY HERE</span>
      </div>
      <label className="field">
        <span>SUBJECT</span>
        <input
          required
          maxLength={140}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. Auto fare shown is too low"
        />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>CATEGORY</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>PRIORITY</span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>DESCRIBE THE PROBLEM</span>
        <textarea
          required
          rows={5}
          maxLength={5000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What happened, where you were going, and what you expected."
        />
      </label>
      <div className="field">
        <span>SCREENSHOT (OPTIONAL)</span>
        {image ? (
          <div className="image-preview">
            <img src={image} alt="Selected attachment preview" />
            <div>
              <strong>{imageName}</strong>
              <small>
                {Math.round((image.length * 0.75) / 1024)} KB after compression
              </small>
            </div>
            <button
              type="button"
              aria-label="Remove image"
              onClick={() => {
                setImage(null);
                setImageName("");
              }}
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <label className="image-drop">
            <ImagePlus size={20} />
            <span>Add a screenshot or photo</span>
            <small>PNG, JPG or WEBP</small>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => pick(e.target.files?.[0])}
            />
          </label>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary wide-btn" disabled={busy}>
        {busy ? <span className="spinner" /> : "Submit ticket"}
      </button>
    </form>
  );
}

export default function Support({ ticketId }: { ticketId?: string }) {
  const {
    user,
    ready,
    openAuth,
    profile,
    usageToday,
    dailyLimit,
    searchesLeft,
  } = useAuth();
  const [flash, setFlash] = useState("");
  const { rows, loading, error } = useLive<Ticket>(
    () =>
      db && user
        ? query(collection(db, "tickets"), where("uid", "==", user.uid))
        : null,
    `my-tickets-${user?.uid}`,
  );
  const tickets = [...rows].sort(
    (a, b) => millis(b.lastMessageAt) - millis(a.lastMessageAt),
  );
  const open = tickets.find((t) => t.id === ticketId);
  if (!ready) return <PageShell title="Help & support">{null}</PageShell>;
  if (!user)
    return (
      <PageShell title="Help & support">
        <Empty icon={<LogIn size={28} />} title="Log in to get help">
          Sign in to raise a ticket and chat with the RouteWise team.
        </Empty>
        <div className="center">
          <button className="primary" onClick={() => openAuth("login")}>
            Log in
          </button>
        </div>
      </PageShell>
    );
  return (
    <PageShell title="Help & support">
      <div className="page-heading">
        <div>
          <div className="eyebrow">HELP & SUPPORT</div>
          <h1>How can we help?</h1>
          <p>
            Raise a ticket and follow the conversation here. You'll get a
            notification when we reply or change its status.
          </p>
        </div>
      </div>
      <div className="usage-strip card">
        <Activity size={18} />
        <div>
          <strong>
            {searchesLeft} of {dailyLimit} route searches left today
          </strong>
          <span>
            Used today: {usageToday?.searches ?? 0} searches ·{" "}
            {usageToday?.locates ?? 0} location checks ·{" "}
            {usageToday?.navigations ?? 0} journeys tracked. All time:{" "}
            {profile?.usage?.searches ?? 0} searches.
          </span>
        </div>
      </div>
      {flash && (
        <div className="demo-banner" role="status">
          <LifeBuoy size={18} />
          <div>
            <strong>{flash}</strong>
            <p>We'll notify you here as soon as the team picks it up.</p>
          </div>
        </div>
      )}
      <div className="support-grid">
        <NewTicket
          onCreated={(id) => {
            setFlash(`Ticket ${ticketNo(id)} submitted`);
            location.hash = `#/support/${id}`;
          }}
        />
        <section className="card">
          <div className="panel-title">
            <h2>My tickets</h2>
            <span>{tickets.length} TOTAL</span>
          </div>
          {error && <p className="form-error">{error}</p>}
          {loading ? (
            <p className="muted">Loading…</p>
          ) : tickets.length === 0 ? (
            <Empty icon={<Inbox size={26} />} title="No tickets yet">
              Anything you raise will appear here.
            </Empty>
          ) : (
            <ul className="ticket-list">
              {tickets.map((t) => (
                <li key={t.id}>
                  <a
                    href={`#/support/${t.id === ticketId ? "" : t.id}`}
                    className={t.id === ticketId ? "active" : ""}
                  >
                    <div>
                      <strong>
                        {t.unreadForUser && (
                          <i className="dot" aria-label="New reply" />
                        )}
                        {t.subject}
                      </strong>
                      <small>
                        {ticketNo(t.id)} · {t.category} · {ago(t.lastMessageAt)}
                      </small>
                    </div>
                    <StatusBadge status={t.status} />
                  </a>
                  {t.id === ticketId && open && (
                    <div className="ticket-detail">
                      <div className="ticket-meta">
                        <span>Priority: {open.priority}</span>
                        <span>Opened {ago(open.createdAt)}</span>
                        {open.status === "closed" ||
                        open.status === "resolved" ? (
                          <button
                            onClick={() =>
                              setTicketStatus(user, open, "open", false)
                            }
                          >
                            <RotateCcw size={14} /> Reopen
                          </button>
                        ) : (
                          <button
                            onClick={() =>
                              setTicketStatus(user, open, "closed", false)
                            }
                          >
                            <X size={14} /> Close ticket
                          </button>
                        )}
                      </div>
                      {open.hasImage && <TicketImage ticketId={open.id} />}
                      <TicketThread ticket={open} asAdmin={false} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PageShell>
  );
}
