import { useEffect, useRef, useState, type ReactNode } from "react";
import { collection, orderBy, query } from "firebase/firestore";
import {
  ArrowLeft,
  ImageIcon,
  Route as RouteIcon,
  Send,
  X,
} from "lucide-react";
import { AccountArea, useAuth } from "./auth";
import { db } from "./firebase";
import {
  ago,
  clearUnread,
  getDoc,
  doc,
  sendMessage,
  statusLabel,
  type Message,
  type Ticket,
  type TicketStatus,
  useLive,
} from "./data";

export function PageShell({
  title,
  children,
  wide,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="RouteWise home">
          <span className="brand-mark">
            <RouteIcon size={23} />
          </span>
          route<span>wise</span>
          <span className="brand-period">.</span>
        </a>
        <nav>
          <a className="nav-link" href="#/">
            <ArrowLeft size={17} /> Back to planner
          </a>
          <span className="nav-active nav-title">{title}</span>
        </nav>
        <div className="top-right">
          <AccountArea />
        </div>
      </header>
      <main className={wide ? "page wide" : "page"}>{children}</main>
    </div>
  );
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span className={`status status-${status}`}>{statusLabel(status)}</span>
  );
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function TicketImage({ ticketId }: { ticketId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState("loading");
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (!db) return;
    getDoc(doc(db, "ticketImages", ticketId))
      .then((d) => {
        const data = d.data()?.data;
        // Only ever render an image data URL from Firestore.
        setSrc(
          typeof data === "string" && data.startsWith("data:image/")
            ? data
            : null,
        );
        setState(d.exists() ? "ready" : "missing");
      })
      .catch(() => setState("error"));
  }, [ticketId]);
  if (state === "loading")
    return <div className="ticket-image placeholder">Loading image…</div>;
  if (!src)
    return (
      <div className="ticket-image placeholder">
        <ImageIcon size={16} /> Image unavailable
      </div>
    );
  return (
    <>
      <button
        className="ticket-image"
        onClick={() => setZoom(true)}
        aria-label="Enlarge attached image"
      >
        <img src={src} alt="Attachment from the ticket" />
      </button>
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(false)}>
          <button aria-label="Close image">
            <X size={20} />
          </button>
          <img src={src} alt="Attachment from the ticket, enlarged" />
        </div>
      )}
    </>
  );
}

// Live chat thread for one ticket; used by both the user's Help page and the admin dashboard.
export function TicketThread({
  ticket,
  asAdmin,
}: {
  ticket: Ticket;
  asAdmin: boolean;
}) {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const { rows, error: listenError } = useLive<Message>(
    () =>
      db
        ? query(
            collection(db, "tickets", ticket.id, "messages"),
            orderBy("createdAt", "asc"),
          )
        : null,
    `messages-${ticket.id}`,
  );
  const unread = asAdmin ? ticket.unreadForAdmin : ticket.unreadForUser;
  useEffect(() => {
    if (unread) clearUnread(ticket.id, asAdmin);
  }, [ticket.id, unread, asAdmin]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [rows.length]);
  const closed = ticket.status === "closed";
  async function submit() {
    if (!user || !text.trim()) return;
    setSending(true);
    setError("");
    try {
      await sendMessage(user, ticket, text, asAdmin);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }
  const mineSide = asAdmin ? "admin" : "user";
  return (
    <div className="thread">
      <div className="thread-messages">
        <div className="bubble theirs first">
          <small>
            {asAdmin ? ticket.name : "You"} · {ago(ticket.createdAt)}
          </small>
          <p>{ticket.description}</p>
        </div>
        {rows.map((m) =>
          m.from === "system" ? (
            <div className="thread-system" key={m.id}>
              {m.text} · {ago(m.createdAt)}
            </div>
          ) : (
            <div
              key={m.id}
              className={`bubble ${m.from === mineSide ? "mine" : "theirs"}`}
            >
              <small>
                {m.from === "admin"
                  ? asAdmin
                    ? "You (support)"
                    : "RouteWise support"
                  : asAdmin
                    ? ticket.name
                    : "You"}{" "}
                · {ago(m.createdAt)}
              </small>
              <p>{m.text}</p>
            </div>
          ),
        )}
        {listenError && <p className="form-error">{listenError}</p>}
        <div ref={end} />
      </div>
      {closed && !asAdmin ? (
        <p className="thread-closed">
          This ticket is closed. Reopen it to send another message.
        </p>
      ) : (
        <form
          className="thread-compose"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={asAdmin ? "Reply to the user…" : "Write a message…"}
            rows={2}
            maxLength={2000}
            aria-label="Message"
          />
          <button
            className="primary"
            disabled={sending || !text.trim()}
            aria-label="Send message"
          >
            {sending ? <span className="spinner" /> : <Send size={16} />}
          </button>
        </form>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
