import {
  useEffect,
  useRef,
  useState,
  Component,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  ArrowUpRight,
  ArrowUpDown,
  Bike,
  Bus,
  Car,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Compass,
  Footprints,
  Fuel,
  Info,
  Layers,
  LocateFixed,
  MapPin,
  Navigation,
  Pause,
  Route as RouteIcon,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrainFront,
  TriangleAlert,
  Wallet,
  X,
  Zap,
  CheckCircle2,
} from "lucide-react";
import { api, log } from "./api";
import { JourneyMap } from "./Map";
import type {
  FareResearch,
  Leg,
  Mode,
  Place,
  Point,
  Route,
  Vehicle,
} from "./types";
const TRANSIT_MODES: Mode[] = ["BUS", "TRAIN", "METRO"];
const fuelUnit: Record<Vehicle["fuel"], string> = {
  Petrol: "L",
  Diesel: "L",
  CNG: "kg",
  Electricity: "kWh",
};
const gap = (p: Point, q: Point) =>
  Math.hypot((p.lat - q.lat) * 111195, (p.lng - q.lng) * 106000);
function mapsLinks(leg: Leg) {
  const destination = `${leg.destination.lat},${leg.destination.lng}`;
  const transit = TRANSIT_MODES.includes(leg.mode);
  const google = new URLSearchParams({
    api: "1",
    destination,
    travelmode:
      leg.mode === "WALK"
        ? "walking"
        : leg.mode === "BICYCLE"
          ? "bicycling"
          : transit
            ? "transit"
            : leg.mode === "BIKE"
              ? "two-wheeler"
              : "driving",
    dir_action: "navigate",
  });
  const apple = new URLSearchParams({
    daddr: destination,
    dirflg: transit ? "r" : ["WALK", "BICYCLE"].includes(leg.mode) ? "w" : "d",
  });
  return {
    google: `https://www.google.com/maps/dir/?${google}`,
    apple: `https://maps.apple.com/?${apple}`,
  };
}
let sessionVoter = "";
function voterId() {
  const make = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  try {
    let id = localStorage.getItem("routewise.voter");
    if (!id) {
      id = make();
      localStorage.setItem("routewise.voter", id);
    }
    return id;
  } catch {
    sessionVoter ||= make();
    return sessionVoter;
  }
}
type VoteResult = {
  fare: number;
  voters: number;
  applied: boolean;
  needed?: number;
  message?: string;
};
const PRICE_NOTE =
  "Prices are estimates. They can differ with driver and vehicle availability, holidays and festivals, and weather. Our model and Gemini's suggestion can also be inaccurate at times.";
function PriceNote({
  passive = false,
  align = "left",
}: {
  passive?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  if (passive)
    return (
      <span
        className="price-note passive"
        role="img"
        aria-label={PRICE_NOTE}
        title={PRICE_NOTE}
      >
        <Info size={12} />
      </span>
    );
  return (
    <span className="price-note-wrap" ref={wrap}>
      <button
        type="button"
        className="price-note"
        aria-label="About this price"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      >
        <Info size={12} />
      </button>
      {open && (
        <span role="note" className={`price-note-pop ${align}`}>
          {PRICE_NOTE}
        </span>
      )}
    </span>
  );
}
function FareCompare({ leg }: { leg: Leg }) {
  const needed = leg.fare_needed ?? 3;
  const voters = leg.fare_voters ?? 0;
  const gemini = leg.gemini_status;
  return (
    <div className={`fare-compare${gemini ? "" : " single"}`}>
      <div className="fare-side">
        <span className="fare-side-label">RouteWise fare</span>
        <b>
          {money(leg.cost)}
          <PriceNote />
        </b>
        <small>
          {leg.fare_applied
            ? `Rider-checked by ${voters} riders`
            : `${voters} of ${needed} riders so far`}
        </small>
      </div>
      {gemini && (
        <div className="fare-side gemini">
          <span className="fare-side-label">
            <Sparkles size={11} /> Gemini suggests
          </span>
          {gemini === "ok" && leg.gemini_fare != null ? (
            <>
              <b>
                {money(leg.gemini_fare)}
                <PriceNote align="right" />
              </b>
              <small>
                Typical {money(leg.gemini_low ?? leg.gemini_fare)}-
                {money(leg.gemini_high ?? leg.gemini_fare)} · AI estimate, not
                verified
              </small>
              {leg.gemini_note && <small>{leg.gemini_note}</small>}
              {leg.gemini_basis && (
                <small className="gemini-basis">{leg.gemini_basis}</small>
              )}
            </>
          ) : (
            <>
              <small>Suggestion unavailable right now.</small>
              {leg.gemini_note && <small>{leg.gemini_note}</small>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
function FareVote({
  routeId,
  legIndex,
  fare,
}: {
  routeId: string;
  legIndex: number;
  fare: number;
}) {
  const [step, setStep] = useState<"ask" | "paid" | "sending" | "done">("ask");
  const [paid, setPaid] = useState("");
  const [result, setResult] = useState<VoteResult | null>(null);
  const [error, setError] = useState("");
  async function send(verdict: "correct" | "wrong", amount?: number) {
    setStep("sending");
    setError("");
    try {
      const r = await api<VoteResult>("/api/fares/vote", {
        route_id: routeId,
        leg: legIndex,
        verdict,
        paid: amount ?? null,
        voter: voterId(),
      });
      setResult(r);
      setStep("done");
      log("fare.voted", verdict);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep(verdict === "wrong" ? "paid" : "ask");
    }
  }
  if (step === "done" && result)
    return (
      <p className="fare-vote done" role="status">
        <CheckCircle2 size={13} /> Thanks!{" "}
        {result.message?.replace(/^Thanks!\s*/, "") ??
          (result.applied
            ? `This fare is now ₹${result.fare}, learned from ${result.voters} riders.`
            : `${result.voters} of ${result.needed ?? 3} riders so far. The fare updates once ${result.needed ?? 3} riders report it.`)}
      </p>
    );
  return (
    <div className="fare-vote">
      {step === "paid" || (step === "sending" && paid) ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (Number(paid) > 0) send("wrong", Number(paid));
          }}
        >
          <label>
            What did you pay? ₹
            <input
              type="number"
              inputMode="decimal"
              min="1"
              max="5000"
              aria-label="Fare you paid in rupees"
              value={paid}
              autoFocus
              onChange={(e) => setPaid(e.target.value)}
            />
          </label>
          <button
            className="vote-button"
            type="submit"
            disabled={!(Number(paid) > 0) || step === "sending"}
          >
            Send
          </button>
          <button
            className="text-button"
            type="button"
            disabled={step === "sending"}
            onClick={() => {
              setPaid("");
              send("wrong");
            }}
          >
            Skip
          </button>
        </form>
      ) : (
        <>
          <span>Was ₹{Math.round(fare)} right?</span>
          <button
            className="vote-button"
            disabled={step === "sending"}
            onClick={() => send("correct")}
          >
            <Check size={12} /> Correct
          </button>
          <button
            className="vote-button wrong"
            disabled={step === "sending"}
            onClick={() => setStep("paid")}
          >
            <X size={12} /> Wrong
          </button>
        </>
      )}
      {error && <small className="fare-vote-error">{error}</small>}
    </div>
  );
}
type StopPhotoData = {
  photo: string | null;
  name: string;
  attribution: string[];
};
function StopPhoto({ place }: { place: Place }) {
  const [data, setData] = useState<StopPhotoData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (place.photo) {
      setData({
        photo: place.photo,
        name: place.name,
        attribution: place.attribution || [],
      });
      return;
    }
    setData(null);
    const controller = new AbortController();
    const params = new URLSearchParams({
      name: place.name,
      lat: String(place.lat),
      lng: String(place.lng),
    });
    api<StopPhotoData>(`/api/places/stop-photo?${params}`, undefined, controller.signal)
      .then(setData)
      .catch(() => setFailed(true));
    return () => controller.abort();
  }, [place.name, place.lat, place.lng, place.photo]);
  if (!failed && !data) return <p className="stop-photo-note">Finding a photo of {place.name}…</p>;
  if (failed || !data?.photo)
    return (
      <p className="stop-photo-note">
        No photo of {place.name} is available. Use the map and directions.
      </p>
    );
  return (
    <figure className="stop-photo">
      <img
        src={data.photo}
        alt={`What ${place.name} looks like`}
        loading="lazy"
        onError={() => setFailed(true)}
      />
      <figcaption>
        <strong>Look for: {place.name}</strong>
        {data.attribution.length > 0 && (
          <span>Photo: {data.attribution.join(", ")}</span>
        )}
      </figcaption>
    </figure>
  );
}
const defaultVehicle: Vehicle = {
  name: "My bike",
  mode: "BIKE",
  fuel: "Petrol",
  efficiency: 45,
  unit_price: 116.5,
  parking: 0,
  toll: 0,
};
const names: Record<Mode, string> = {
  WALK: "Walk",
  BUS: "Bus",
  TRAIN: "Train",
  METRO: "Metro",
  AUTO: "Auto",
  CAB: "Cab",
  BIKE: "My bike",
  CAR: "My car",
  EV: "My EV",
  BICYCLE: "Cycle",
};
const priorities = [
  ["balanced", "Balanced"],
  ["cheapest", "Cheapest"],
  ["fastest", "Fastest"],
  ["walking", "Less walking"],
  ["transfers", "Fewer transfers"],
];
function ModeIcon({ mode, size = 18 }: { mode: Mode; size?: number }) {
  const Icon =
    mode === "WALK"
      ? Footprints
      : mode === "BUS"
        ? Bus
        : mode === "TRAIN" || mode === "METRO"
          ? TrainFront
          : mode === "BIKE" || mode === "BICYCLE"
            ? Bike
            : Car;
  return <Icon size={size} />;
}
const money = (amount: number | null) =>
  amount === null ? "Unavailable" : `₹${Math.round(amount)}`;
const meters = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
function SearchBox({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: Place | null;
  onChange: (p: Place | null) => void;
  placeholder: string;
}) {
  const [text, setText] = useState(value?.name || "");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    if (value || !open) setText(value?.name || "");
    setResults([]);
  }, [value]);
  useEffect(() => {
    if (!open || text.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api<Place[]>(
          `/api/places/search?q=${encodeURIComponent(text)}`,
          undefined,
          controller.signal,
        );
        setResults(result);
      } catch (e) {
        if (!controller.signal.aborted) setError(String(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, open]);
  async function choose(place: Place) {
    const n = ++sequence.current;
    try {
      const full = await api<Place>(
        `/api/places/${encodeURIComponent(place.id)}`,
      );
      if (n !== sequence.current) return;
      onChange(full);
      setOpen(false);
      log("place.selected", label);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="place-input">
      <label>{label}</label>
      <div className="input-wrap">
        <input
          aria-label={label}
          value={text}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            if (value) onChange(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              setText(value?.name || "");
            }
          }}
        />
        <ChevronDown size={15} onClick={() => setOpen(!open)} />
      </div>
      {open && (
        <>
          <div
            className="dismiss-search"
            onClick={() => {
              setOpen(false);
              setText(value?.name || "");
            }}
          />
          <div className="suggestions">
            {loading ? (
              <p>Searching places…</p>
            ) : error ? (
              <p role="alert">{error}</p>
            ) : results.length ? (
              results.map((p) => (
                <button key={p.id} onClick={() => choose(p)}>
                  <MapPin size={16} />
                  <span>
                    {p.name}
                    <small>{p.address || "Google Places"}</small>
                  </span>
                </button>
              ))
            ) : (
              <p>
                {text.length < 2
                  ? "Type at least 2 characters."
                  : "No matching places. Try another name."}
              </p>
            )}
            {value && text !== value.name && (
              <small>Select a result to change your journey.</small>
            )}
            <small>Powered by Google</small>
          </div>
        </>
      )}
    </div>
  );
}
function VehicleSettings({
  vehicle,
  onSave,
  onClose,
  research,
}: {
  vehicle: Vehicle;
  onSave: (v: Vehicle) => void;
  onClose: () => void;
  research?: FareResearch;
}) {
  const [draft, setDraft] = useState(vehicle);
  const researched = research?.fuel_prices[draft.fuel];
  const priceFor = (fuel: string, fallback: number) =>
    research?.fuel_prices[fuel]?.price ?? fallback;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Vehicle settings"
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div className="eyebrow">MAKE IT YOURS</div>
          <button aria-label="Close settings" onClick={onClose}>
            <X size={21} />
          </button>
        </header>
        <h2>Your vehicle, your numbers.</h2>
        <p>
          Calculate operating costs with your own mileage and current energy
          price.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(draft);
            onClose();
          }}
        >
          <label>
            Vehicle name
            <input
              required
              maxLength={60}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <div className="form-grid">
            <label>
              Vehicle
              <select
                value={draft.mode}
                onChange={(e) => {
                  const fuel = e.target.value === "EV" ? "Electricity" : "Petrol";
                  setDraft({
                    ...draft,
                    mode: e.target.value as Vehicle["mode"],
                    fuel,
                    unit_price: priceFor(fuel, draft.unit_price),
                  });
                }}
              >
                <option value="BIKE">Motorbike</option>
                <option value="CAR">Car</option>
                <option value="EV">Electric vehicle</option>
              </select>
            </label>
            <label>
              Energy
              <select
                value={draft.fuel}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    fuel: e.target.value as Vehicle["fuel"],
                    unit_price: priceFor(e.target.value, draft.unit_price),
                  })
                }
              >
                {(draft.mode === "EV"
                  ? ["Electricity"]
                  : ["Petrol", "Diesel", "CNG"]
                ).map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label>
              Mileage (km/{fuelUnit[draft.fuel]})
              <input
                required
                type="number"
                step="0.1"
                min="0.1"
                max="1000"
                value={draft.efficiency}
                onChange={(e) =>
                  setDraft({ ...draft, efficiency: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Price (₹/{fuelUnit[draft.fuel]})
              <input
                required
                type="number"
                step="0.01"
                min="0.01"
                max="10000"
                value={draft.unit_price}
                onChange={(e) =>
                  setDraft({ ...draft, unit_price: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Parking (₹)
              <input
                required
                type="number"
                min="0"
                max="10000"
                value={draft.parking}
                onChange={(e) =>
                  setDraft({ ...draft, parking: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Tolls (₹)
              <input
                required
                type="number"
                min="0"
                max="10000"
                value={draft.toll}
                onChange={(e) =>
                  setDraft({ ...draft, toll: Number(e.target.value) })
                }
              />
            </label>
          </div>
          {draft.mode === "BIKE" && !!research?.mileage_presets.length && (
            <div className="preset-row">
              <span>Typical city mileage:</span>
              {research.mileage_presets.map((p) => (
                <button
                  type="button"
                  key={p.name}
                  className={`preset ${draft.efficiency === p.efficiency ? "active" : ""}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      fuel: p.fuel,
                      efficiency: p.efficiency,
                      unit_price: priceFor(p.fuel, draft.unit_price),
                    })
                  }
                >
                  {p.name} · {p.efficiency} km/L
                </button>
              ))}
              <small>{research.mileage_source}</small>
            </div>
          )}
          {researched && (
            <div className="info-box">
              <Info size={17} />
              <span>
                Visakhapatnam {draft.fuel.toLowerCase()}: ₹{researched.price}/
                {researched.unit} ({researched.source}, checked{" "}
                {researched.checked}). Prices change daily, so edit it if your
                pump shows a different price.{" "}
                {draft.unit_price !== researched.price && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      setDraft({ ...draft, unit_price: researched.price })
                    }
                  >
                    Use ₹{researched.price}
                  </button>
                )}
              </span>
            </div>
          )}
          <button className="primary full" type="submit">
            Save vehicle <Check size={17} />
          </button>
        </form>
      </section>
    </div>
  );
}
export default function App() {
  const [config, setConfig] = useState<
    | ({
        live_ready: boolean;
        browser_key: string;
      } & FareResearch)
    | null
  >(null);
  const [streeShakti, setStreeShakti] = useState(() => {
    try {
      return localStorage.getItem("routewise.streeShakti") === "1";
    } catch {
      return false;
    }
  });
  const [origin, setOrigin] = useState<Place | null>(null),
    [destination, setDestination] = useState<Place | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]),
    [selected, setSelected] = useState<Route | null>(null),
    [preference, setPreference] = useState("balanced");
  const [modes, setModes] = useState<Mode[]>(["WALK", "BUS", "AUTO", "CAB"]);
  const [budget, setBudget] = useState(""),
    [walking, setWalking] = useState("3000"),
    [duration, setDuration] = useState("180");
  const [filters, setFilters] = useState(false),
    [loading, setLoading] = useState(false),
    [searched, setSearched] = useState(false),
    [error, setError] = useState(""),
    [warnings, setWarnings] = useState<string[]>([]);
  const [position, setPosition] = useState<Point | null>(null),
    [accuracy, setAccuracy] = useState<number | null>(null),
    [gpsStatus, setGpsStatus] = useState("Location not shared");
  const [settings, setSettings] = useState(false),
    [vehicle, setVehicle] = useState<Vehicle>(() => {
      try {
        const p = JSON.parse(
          localStorage.getItem("routewise.vehicle") || "null",
        );
        return p && p.efficiency > 0 && p.unit_price > 0
          ? { ...defaultVehicle, ...p }
          : defaultVehicle;
      } catch {
        return defaultVehicle;
      }
    });
  const [active, setActive] = useState(false),
    [legIndex, setLegIndex] = useState(0),
    [navState, setNavState] = useState("READY"),
    [remaining, setRemaining] = useState<number | null>(null),
    [stepIndex, setStepIndex] = useState(0),
    [speed, setSpeed] = useState<number | null>(null),
    [lastFix, setLastFix] = useState<number | null>(null),
    [moved, setMoved] = useState(0),
    [now, setNow] = useState(Date.now()),
    [navMenu, setNavMenu] = useState(-1);
  const watch = useRef<number | null>(null),
    lastCheck = useRef(0),
    lastRecalc = useRef(0),
    deviations = useRef(0),
    busy = useRef(false),
    searchVersion = useRef(0),
    navVersion = useRef(0);
  const gpsPoint = useRef<Point | null>(null);
  const gpsAccuracy = useRef<number | null>(null);
  const currentLeg = selected?.legs[legIndex];
  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    log("error.displayed", msg, "ERROR");
  };
  function stopNavigation() {
    navVersion.current++;
    setActive(false);
    setNavState("READY");
    setRemaining(null);
    setStepIndex(0);
    setNavMenu(-1);
    if (watch.current !== null) {
      navigator.geolocation.clearWatch(watch.current);
      watch.current = null;
    }
    log("navigation.stopped");
  }
  function invalidate() {
    searchVersion.current++;
    stopNavigation();
    setRoutes([]);
    setSelected(null);
    setSearched(false);
    setWarnings([]);
    setError("");
    setLoading(false);
  }
  useEffect(() => {
    api<typeof config>("/api/config")
      .then((c) => {
        if (c) setConfig(c);
      })
      .catch(fail);
    return () => {
      if (watch.current !== null)
        navigator.geolocation.clearWatch(watch.current);
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  function query() {
    return {
      origin,
      destination,
      preference,
      modes,
      max_budget: budget === "" ? null : Number(budget),
      max_walking: Number(walking),
      max_duration: Number(duration),
      vehicle,
      stree_shakti: streeShakti,
    };
  }
  async function findRoutes() {
    if (!origin || !destination) {
      fail(
        "Select a starting point and destination from the place suggestions.",
      );
      return;
    }
    stopNavigation();
    const version = ++searchVersion.current;
    setLoading(true);
    setError("");
    setSelected(null);
    setRoutes([]);
    try {
      const result = await api<{ routes: Route[]; warnings: string[] }>(
        "/api/routes/search",
        query(),
      );
      if (version !== searchVersion.current) return;
      setRoutes(result.routes);
      setSelected(result.routes[0] || null);
      setLegIndex(0);
      setWarnings(result.warnings);
      setSearched(true);
      log("route.results.displayed", `${result.routes.length} routes`);
    } catch (e) {
      if (version === searchVersion.current) fail(e);
    } finally {
      if (version === searchVersion.current) setLoading(false);
    }
  }
  function requestGPS(forNavigation = false) {
    if (!navigator.geolocation) {
      fail(
        "This browser does not support GPS. Choose your starting point manually.",
      );
      return;
    }
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    setGpsStatus("Locating…");
    log("gps.permission.requested");
    watch.current = navigator.geolocation.watchPosition(
      (p) => {
        const point = { lat: p.coords.latitude, lng: p.coords.longitude };
        const previous = gpsPoint.current;
        if (forNavigation && previous && p.coords.accuracy <= 50) {
          const step = gap(previous, point);
          if (step >= 3) setMoved((m) => m + step);
        }
        setSpeed(p.coords.speed);
        setLastFix(p.timestamp);
        gpsPoint.current = point;
        gpsAccuracy.current = p.coords.accuracy;
        setPosition(point);
        setAccuracy(p.coords.accuracy);
        setGpsStatus(
          p.coords.accuracy > 50 ? "Low accuracy" : "Location connected",
        );
        log("gps.updated", `Accuracy ±${Math.round(p.coords.accuracy)} m`);
        if (!forNavigation) {
          setOrigin({
            ...point,
            id: "gps",
            name: "Current location",
            address: "Browser GPS",
          });
          setRoutes([]);
          setSelected(null);
          setSearched(false);
        }
      },
      (e) => {
        setGpsStatus("Location unavailable");
        fail(
          e.code === 1
            ? "Location permission was denied. Allow location in your browser settings, or choose a starting point manually."
            : e.code === 3
              ? "GPS timed out. Try again outdoors or choose a starting point manually."
              : "Your location is unavailable. Check device location services.",
        );
        if (forNavigation) setActive(false);
        if (watch.current !== null)
          navigator.geolocation.clearWatch(watch.current);
        watch.current = null;
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: forNavigation ? 0 : 5000,
      },
    );
  }
  function locate() {
    invalidate();
    requestGPS();
  }
  useEffect(() => {
    if (
      !active ||
      !position ||
      !currentLeg ||
      accuracy === null ||
      busy.current ||
      Date.now() - lastCheck.current < 1000
    )
      return;
    lastCheck.current = Date.now();
    const version = navVersion.current;
    async function check() {
      busy.current = true;
      try {
        if (!currentLeg || currentLeg.polyline.length < 2) return;
        const status = await api<{
          distance_to_target: number;
          remaining_distance: number;
          state: string;
          deviations: number;
          recalculate: boolean;
        }>("/api/navigation/check", {
          position,
          accuracy,
          polyline: currentLeg.polyline,
          target: currentLeg.destination,
          last_recalculation: lastRecalc.current,
          deviations: deviations.current,
        });
        if (version !== navVersion.current) return;
        setRemaining(status.remaining_distance);
        setNavState(status.state);
        deviations.current = status.deviations;
        const near = (p: Point, q: Point) =>
          Math.hypot((p.lat - q.lat) * 111195, (p.lng - q.lng) * 106000);
        if (
          currentLeg.steps[stepIndex] &&
          near(position!, currentLeg.steps[stepIndex].end) < 25
        )
          setStepIndex((i) => Math.min(i + 1, currentLeg.steps.length - 1));
        if (status.state === "ARRIVED") {
          setActive(false);
          setNavState("ARRIVED_AT_STOP");
        }
        if (status.recalculate && currentLeg.mode === "WALK") {
          lastRecalc.current = Date.now() / 1000;
          setNavState("RECALCULATING");
          const target = currentLeg.destination;
          const result = await api<{ routes: Route[] }>(
            "/api/navigation/recalculate",
            {
              ...query(),
              origin: { ...position, id: "gps", name: "Current location" },
              destination: { ...target, id: "gps-target" },
              modes: ["WALK"],
              max_budget: null,
              max_walking: 100000,
              max_duration: 1440,
            },
          );
          if (version !== navVersion.current) return;
          if (!result.routes.length)
            throw new Error(
              "No replacement walking route is available. Pause navigation and search again.",
            );
          setSelected((r) =>
            r
              ? {
                  ...r,
                  legs: r.legs.map((l, i) =>
                    i === legIndex ? result.routes[0].legs[0] : l,
                  ),
                }
              : null,
          );
          deviations.current = 0;
          setStepIndex(0);
          setNavState("ON_ROUTE");
          log("navigation.recalculated");
        }
      } catch (e) {
        if (version === navVersion.current) {
          fail(e);
          setActive(false);
        }
      } finally {
        busy.current = false;
      }
    }
    check();
  }, [position, active]);
  async function startNavigation() {
    if (!selected) return;
    if (Date.now() / 1000 - createdAt.current > 1800) {
      fail(
        "This route is more than 30 minutes old. Find routes again before navigating.",
      );
      return;
    }
    try {
      const version = ++navVersion.current;
      await api("/api/navigation/start", { route_id: selected.id });
      if (version !== navVersion.current) return;
      setActive(true);
      setNavState(currentLeg?.mode === "WALK" ? "WALKING" : "IN_TRANSIT");
      setRemaining(currentLeg?.distance ?? null);
      setMoved(0);
      setSpeed(null);
      setLastFix(null);
      gpsPoint.current = null;
      requestGPS(true);
      log("navigation.leg.started", `Leg ${legIndex + 1}`);
    } catch (e) {
      fail(e);
    }
  }
  function openExternalMaps(app: string) {
    setNavMenu(-1);
    log("navigation.external_opened", app);
    if (!active) startNavigation();
  }
  const createdAt = useRef(Date.now() / 1000);
  useEffect(() => {
    createdAt.current = Date.now() / 1000;
  }, [routes]);
  function nextLeg() {
    navVersion.current++;
    setActive(false);
    setNavMenu(-1);
    setStepIndex(0);
    setRemaining(null);
    if (selected && legIndex < selected.legs.length - 1) {
      setLegIndex((i) => i + 1);
      setNavState("READY");
    } else {
      stopNavigation();
      setNavState("DESTINATION_REACHED");
    }
    log("navigation.leg.completed", String(legIndex + 1));
  }
  function saveVehicle(v: Vehicle) {
    try {
      localStorage.setItem("routewise.vehicle", JSON.stringify(v));
      setVehicle(v);
      setModes((ms) => [
        ...ms.filter((m) => !["BIKE", "CAR", "EV"].includes(m)),
        v.mode,
      ]);
      invalidate();
      log("vehicle.saved", "Profile stored in this browser");
    } catch (e) {
      fail(e);
    }
  }
  const sorted = [...routes].sort((a, b) => {
    const value = (r: Route) =>
      preference === "cheapest"
        ? (r.cost ?? Infinity)
        : preference === "fastest"
          ? r.duration
          : preference === "walking"
            ? r.walking
            : preference === "transfers"
              ? r.transfers
              : r.score;
    return value(a) - value(b);
  });
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="RouteWise home">
          <span className="brand-mark">
            <RouteIcon size={23} />
          </span>
          route<span>wise</span>
          <span className="brand-period">.</span>
        </a>
        <nav>
          <button
            className="nav-active"
            onClick={() =>
              document
                .getElementById("planner")
                ?.scrollIntoView({ behavior: "smooth" })
            }
          >
            <Compass size={17} /> Plan a journey
          </button>
          <button onClick={() => setSettings(true)}>
            <Bike size={18} /> My vehicle
          </button>
        </nav>
        <div className="top-right">
          <span className="city">
            <MapPin size={14} /> Visakhapatnam
          </span>
          <span className="avatar">RW</span>
        </div>
      </header>
      <main id="planner">
        <div className="page-heading">
          <div>
            <div className="eyebrow">LESS GUESSWORK. MORE GOING.</div>
            <h1>Every step, sorted.</h1>
            <p>
              Find your way across the city. Compare the cost, follow the
              journey.
            </p>
          </div>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <TriangleAlert size={21} />
            <div>
              <strong>Something needs your attention</strong>
              <p>{error}</p>
            </div>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={18} />
            </button>
          </div>
        )}
        <div className="workspace">
          <aside className="planner-panel">
            <div className="panel-title">
              <h2>Your journey</h2>
              <span>01 — PLAN</span>
            </div>
            <div className="journey-fields">
              <div className="endpoint-icons">
                <i />
                <span />
                <MapPin size={20} />
              </div>
              <div className="fields">
                <SearchBox
                  label="STARTING POINT"
                  value={origin}
                  onChange={(p) => {
                    invalidate();
                    setOrigin(p);
                  }}
                  placeholder="Where are you starting?"
                />
                <div className="field-divider" />
                <SearchBox
                  label="DESTINATION"
                  value={destination}
                  onChange={(p) => {
                    invalidate();
                    setDestination(p);
                  }}
                  placeholder="Where do you want to go?"
                />
              </div>
              <button
                className="swap"
                aria-label="Swap origin and destination"
                onClick={() => {
                  invalidate();
                  setOrigin(destination);
                  setDestination(origin);
                }}
              >
                <ArrowUpDown size={16} />
              </button>
            </div>
            <button className="use-location" onClick={locate}>
              <LocateFixed size={15} /> Use my current location{" "}
              <ArrowUpRight size={14} />
            </button>
            <div className="section-label">WHAT MATTERS MOST?</div>
            <div className="priority-options">
              {priorities.slice(0, 3).map(([id, label], i) => (
                <button
                  key={id}
                  className={preference === id ? "selected" : ""}
                  onClick={() => {
                    setPreference(id);
                    log("ranking.preference_changed", id);
                  }}
                >
                  {i === 0 ? (
                    <Layers size={17} />
                  ) : i === 1 ? (
                    <Wallet size={17} />
                  ) : (
                    <Zap size={17} />
                  )}{" "}
                  {label}
                </button>
              ))}
            </div>
            <div className="section-label modes-label">
              WAYS TO GO <span>Select your options</span>
            </div>
            <div className="transport-options">
              {(
                [
                  "WALK",
                  "BUS",
                  "AUTO",
                  vehicle.mode,
                  "CAB",
                  "BICYCLE",
                ] as Mode[]
              ).map((mode) => (
                <button
                  key={mode}
                  className={modes.includes(mode) ? "selected" : ""}
                  onClick={() => {
                    invalidate();
                    setModes((ms) =>
                      ms.includes(mode)
                        ? ms.filter((m) => m !== mode)
                        : [...ms, mode],
                    );
                  }}
                >
                  <ModeIcon mode={mode} size={20} />
                  <span>{names[mode]}</span>
                  {modes.includes(mode) && (
                    <i>
                      <Check size={9} />
                    </i>
                  )}
                </button>
              ))}
            </div>
            <button
              className="filter-toggle"
              aria-expanded={filters}
              onClick={() => setFilters(!filters)}
            >
              <SlidersHorizontal size={16} /> Journey preferences{" "}
              <ChevronDown size={15} className={filters ? "rotated" : ""} />
            </button>
            {filters && (
              <div className="filters">
                <label>
                  Maximum budget (₹)
                  <input
                    type="number"
                    min="0"
                    placeholder="No limit"
                    value={budget}
                    onChange={(e) => {
                      invalidate();
                      setBudget(e.target.value);
                    }}
                  />
                </label>
                <label>
                  Maximum walking (m)
                  <input
                    type="number"
                    min="0"
                    value={walking}
                    onChange={(e) => {
                      invalidate();
                      setWalking(e.target.value);
                    }}
                  />
                </label>
                <label>
                  Maximum time (min)
                  <input
                    type="number"
                    min="1"
                    value={duration}
                    onChange={(e) => {
                      invalidate();
                      setDuration(e.target.value);
                    }}
                  />
                </label>
                <label>
                  Other priorities
                  <select
                    value={preference}
                    onChange={(e) => setPreference(e.target.value)}
                  >
                    {priorities.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="check-row" title={config?.stree_shakti}>
                  <input
                    type="checkbox"
                    checked={streeShakti}
                    onChange={(e) => {
                      invalidate();
                      setStreeShakti(e.target.checked);
                      try {
                        localStorage.setItem(
                          "routewise.streeShakti",
                          e.target.checked ? "1" : "0",
                        );
                      } catch {}
                    }}
                  />
                  <span>
                    I travel free on city buses (Stree Shakti)
                    <small>
                      Women and transgender riders · City Ordinary and Metro
                      Express only
                    </small>
                  </span>
                </label>
              </div>
            )}
            <button
              className="primary find-routes"
              disabled={loading || !config}
              onClick={findRoutes}
            >
              {loading ? (
                <>
                  <span className="spinner" /> Comparing your options…
                </>
              ) : (
                <>
                  Find my routes <ArrowRight size={19} />
                </>
              )}
            </button>
            <div className="planner-footnote">
              <ShieldCheck size={15} />
              <span>Know the source. Travel with confidence.</span>
            </div>
            <div className="vehicle-mini">
              <span className="vehicle-icon">
                <Fuel size={20} />
              </span>
              <div>
                <strong>Make your estimate personal</strong>
                <p>Add your vehicle’s mileage & fuel price.</p>
              </div>
              <button
                aria-label="Open vehicle settings"
                onClick={() => setSettings(true)}
              >
                <ArrowUpRight size={18} />
              </button>
            </div>
          </aside>
          <section className="map-panel">
            <JourneyMap
              route={selected}
              position={position}
              origin={origin}
              destination={destination}
              activeLeg={active ? legIndex : -1}
              browserKey={config?.browser_key || ""}
              onError={setError}
            />
            <div className="map-bottom">
              <div>
                <span
                  className={`gps-dot ${accuracy === null ? "inactive" : ""}`}
                />
                <strong>{gpsStatus}</strong>
                <span className="accuracy">
                  {accuracy !== null
                    ? `±${Math.round(accuracy)} m accuracy`
                    : "Your location stays private"}
                </span>
              </div>
              <button onClick={locate}>
                <LocateFixed size={15} />
                <span>Where am I?</span>
              </button>
            </div>
          </section>
        </div>
        <div className="results-heading">
          <div>
            <h2>
              {searched
                ? "A few ways to get there."
                : "Your next move starts here."}
            </h2>
            <p>
              {searched
                ? `${routes.length} practical ${routes.length === 1 ? "option" : "options"} · sorted by ${priorities.find((p) => p[0] === preference)?.[1].toLowerCase()}`
                : "Compare routes, then get guidance for every leg of the journey."}
            </p>
          </div>
          {searched && (
            <span className="data-badge">
              <span />
              PROVIDER ROUTE DATA
            </span>
          )}
        </div>
        {warnings.length > 0 && (
          <div className="source-notice">
            <Info size={16} />
            <span>{warnings.join(" ")}</span>
          </div>
        )}
        {!searched && !loading ? (
          <section className="empty-preview">
            <div className="empty-icon">
              <RouteIcon size={28} />
            </div>
            <div>
              <h3>A whole journey. Every little detail.</h3>
              <p>
                Choose your destination and find routes to compare fares, see
                transfer points, and follow each step.
              </p>
            </div>
            <span className="empty-preview-note">
              <Footprints size={20} /> Walk. Ride. Arrive.
            </span>
          </section>
        ) : loading ? (
          <section className="loading-state">
            <span className="spinner" />
            <h3>Finding the connections</h3>
            <p>
              Checking routes, calculating costs, and applying your preferences.
            </p>
          </section>
        ) : !routes.length ? (
          <section className="empty-preview">
            <Search size={28} />
            <div>
              <h3>No routes match your preferences.</h3>
              <p>
                Try increasing your budget, walking distance, or available
                travel modes.
              </p>
            </div>
          </section>
        ) : (
          <div className="results-grid">
            <section className="route-list">
              {sorted.map((r, i) => (
                <button
                  className={`route-card ${selected?.id === r.id ? "selected" : ""}`}
                  key={r.id}
                  onClick={() => {
                    stopNavigation();
                    setSelected(r);
                    setLegIndex(0);
                    log("route.selected", r.id);
                  }}
                >
                  <div className="route-card-top">
                    <span className={`route-tag tag-${i}`}>
                      {i === 0 ? (
                        <Sparkles size={12} />
                      ) : (
                        <RouteIcon size={12} />
                      )}{" "}
                      {i === 0
                        ? `${priorities.find((p) => p[0] === preference)?.[1]} choice`
                        : r.name}
                    </span>
                    <span className="route-time">
                      <Clock size={14} />
                      {Math.ceil(r.duration)} min
                    </span>
                  </div>
                  <div className="route-card-middle">
                    <div className="mode-chain">
                      {r.legs.map((l, j) => (
                        <span key={j}>
                          {j > 0 && <ChevronRight size={12} />}
                          <ModeIcon mode={l.mode} size={21} />
                          {l.line && <b>{l.line}</b>}
                        </span>
                      ))}
                    </div>
                    <strong>
                      {money(r.cost)}
                      {r.cost !== null && r.cost > 0 && <PriceNote passive />}
                      {r.cost !== null && (
                        <small>{r.cost_label}</small>
                      )}
                    </strong>
                  </div>
                  <div className="route-card-bottom">
                    <span>
                      {meters(r.distance)} <i>·</i> {meters(r.walking)} walk{" "}
                      <i>·</i> {r.transfers} transfers
                    </span>
                    <span className="radio-mark">
                      {selected?.id === r.id && <Check size={12} />}
                    </span>
                  </div>
                </button>
              ))}
            </section>
            {selected && (
              <section className="journey-detail">
                <div className="detail-heading">
                  <div>
                    <div className="eyebrow">YOUR JOURNEY, STEP BY STEP</div>
                    <h3>
                      {Math.ceil(selected.duration)} minutes to your destination
                    </h3>
                  </div>
                  <span className="detail-total">
                    {money(selected.cost)}
                    {selected.cost !== null && selected.cost > 0 && (
                      <PriceNote align="right" />
                    )}
                    <small>
                      total estimate
                    </small>
                  </span>
                </div>
                <div className="timeline">
                  {selected.legs.map((leg, i) => (
                    <div
                      key={i}
                      className={`timeline-leg ${i === legIndex ? "focused" : ""}`}
                    >
                      <button
                        className={`timeline-marker ${leg.mode.toLowerCase()}`}
                        aria-label={`View leg ${i + 1}`}
                        onClick={() => {
                          stopNavigation();
                          setLegIndex(i);
                        }}
                      >
                        <ModeIcon mode={leg.mode} size={18} />
                      </button>
                      <div className="leg-content">
                        <div className="leg-header">
                          <h4>
                            {leg.mode === "WALK"
                              ? `Walk to ${leg.destination.name}`
                              : leg.fare_kind === "auto"
                                ? `Private auto to ${leg.destination.name}`
                                : leg.mode === "AUTO"
                                ? `Share auto to ${leg.destination.name}`
                                : leg.line
                                  ? `Take ${names[leg.mode].toLowerCase()} ${leg.line}`
                                  : `${names[leg.mode]} to ${leg.destination.name}`}
                          </h4>
                          <span>{Math.ceil(leg.duration / 60)} min</span>
                        </div>
                        <p>
                          {meters(leg.distance)}{" "}
                          {leg.line
                            ? `· From ${leg.origin.name} towards ${leg.headsign}`
                            : `· From ${leg.origin.name}`}
                        </p>
                        <div className="leg-meta">
                          <span>{leg.source}</span>
                          <b>
                            {leg.cost === 0 ? "Free" : money(leg.cost)}
                            {leg.cost !== null && leg.cost > 0 && (
                              <PriceNote align="right" />
                            )}
                          </b>
                        </div>
                        {leg.fare_kind && leg.cost !== null && leg.cost > 0 && (
                          <FareCompare leg={leg} />
                        )}
                        {leg.fare_basis && (
                          <p className="fare-basis">{leg.fare_basis}</p>
                        )}
                        {["BIKE", "CAR", "EV"].includes(leg.mode) &&
                          !leg.fare_kind && (
                            <p className="fare-basis">
                              {(leg.distance / 1000).toFixed(1)} km ÷{" "}
                              {vehicle.efficiency} km/{fuelUnit[vehicle.fuel]} ×
                              ₹{vehicle.unit_price}/{fuelUnit[vehicle.fuel]} = ₹
                              {Math.round(
                                (leg.distance / 1000 / vehicle.efficiency) *
                                  vehicle.unit_price,
                              )}
                              {vehicle.parking + vehicle.toll > 0 &&
                                ` · + ₹${vehicle.parking + vehicle.toll} parking and tolls in the trip total`}
                            </p>
                          )}
                        {leg.fare_kind &&
                          leg.cost !== null &&
                          leg.cost > 0 && (
                            <FareVote
                              key={`${selected.id}-${i}`}
                              routeId={selected.id}
                              legIndex={i}
                              fare={leg.cost}
                            />
                          )}
                        {i === legIndex && (
                          <div className="leg-guidance">
                            <div className="guidance-title">
                              <Navigation size={17} />
                              <span>
                                {leg.steps[stepIndex]?.instruction ||
                                  `Continue to ${leg.destination.name}`}
                              </span>
                            </div>
                            {active || navState === "ARRIVED_AT_STOP" ? (
                              <div className="navigation-live">
                                <span>
                                  <strong>
                                    {meters(remaining ?? leg.distance)}
                                  </strong>{" "}
                                  to {leg.destination.name} · about{" "}
                                  {Math.max(
                                    1,
                                    Math.ceil(
                                      (((remaining ?? leg.distance) /
                                        leg.distance) *
                                        leg.duration) /
                                        60,
                                    ),
                                  )}{" "}
                                  min
                                </span>
                                <small>
                                  {navState.replaceAll("_", " ")}
                                </small>
                                {active && (
                                  <div className="live-stats" aria-live="polite">
                                    <span className="live-badge">
                                      <i /> LIVE
                                    </span>
                                    <span>
                                      {accuracy !== null
                                        ? `±${Math.round(accuracy)} m`
                                        : "GPS…"}
                                    </span>
                                    <span>
                                      {speed !== null
                                        ? `${(speed * 3.6).toFixed(1)} km/h`
                                        : "– km/h"}
                                    </span>
                                    <span>Moved {meters(moved)}</span>
                                    <span>
                                      {lastFix
                                        ? `Updated ${Math.max(0, Math.round((now - lastFix) / 1000))}s ago`
                                        : "Waiting for GPS"}
                                    </span>
                                  </div>
                                )}
                                <div className="progress-track">
                                  <span
                                    style={{
                                      width: `${Math.max(0, 100 - ((remaining ?? leg.distance) / leg.distance) * 100)}%`,
                                    }}
                                  />
                                </div>
                              </div>
                            ) : null}
                            <div className="leg-actions">
                              <div className="leg-primary-actions">
                                <div className="nav-launch">
                                  <button
                                    className="nav-button"
                                    aria-haspopup="menu"
                                    aria-expanded={navMenu === i}
                                    onClick={() =>
                                      setNavMenu((m) => (m === i ? -1 : i))
                                    }
                                  >
                                    <Navigation size={12} /> Navigate
                                    <ChevronDown size={12} />
                                  </button>
                                  {navMenu === i && (
                                    <div className="nav-menu" role="menu">
                                      <a
                                        role="menuitem"
                                        href={mapsLinks(leg).google}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() =>
                                          openExternalMaps("Google Maps")
                                        }
                                      >
                                        Google Maps
                                      </a>
                                      <a
                                        role="menuitem"
                                        href={mapsLinks(leg).apple}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() =>
                                          openExternalMaps("Apple Maps")
                                        }
                                      >
                                        Apple Maps
                                      </a>
                                      {!active && (
                                        <button
                                          role="menuitem"
                                          onClick={() => {
                                            setNavMenu(-1);
                                            startNavigation();
                                          }}
                                        >
                                          Track in RouteWise only
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              {active && (
                                <button
                                  className="nav-secondary"
                                  onClick={() => {
                                    navVersion.current++;
                                    setActive(false);
                                    if (watch.current !== null) {
                                      navigator.geolocation.clearWatch(
                                        watch.current,
                                      );
                                      watch.current = null;
                                    }
                                    log("navigation.paused");
                                  }}
                                >
                                  <Pause size={12} /> Stop tracking
                                </button>
                              )}
                              </div>
                              <button className="text-button" onClick={nextLeg}>
                                <CheckCircle2 size={14} />
                                {i === selected.legs.length - 1
                                  ? "Mark arrived"
                                  : "Complete leg"}
                              </button>
                            </div>
                            <p className="walking-warning">
                              Directions are estimates. Follow local signs and
                              traffic rules.
                            </p>
                            {i < selected.legs.length - 1 &&
                              leg.destination.name !== "Route point" && (
                                <StopPhoto place={leg.destination} />
                              )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="timeline-destination">
                    <span>
                      <MapPin size={18} />
                    </span>
                    <div>
                      <strong>{destination?.name}</strong>
                      <p>
                        {navState === "DESTINATION_REACHED"
                          ? "You’ve completed your journey."
                          : "Arrive at the mapped destination · indoor access may vary"}
                      </p>
                    </div>
                    {navState === "DESTINATION_REACHED" && (
                      <CheckCircle2 size={23} />
                    )}
                  </div>
                </div>
                <div className="wayfinding-note">
                  <div>
                    <MapPin size={20} />
                    <strong>Know what to look for.</strong>
                  </div>
                  {destination?.photo ? (
                    <>
                      <img
                        className="place-photo"
                        src={destination.photo}
                        alt={`Landmark at ${destination.name}`}
                        onError={() =>
                          fail(
                            "Place photo unavailable. Use the map and written directions.",
                          )
                        }
                      />
                      <small>
                        Photo: {destination.attribution?.join(", ")}
                      </small>
                    </>
                  ) : (
                    <p>
                      No photo is available for this place. Follow the route
                      and mapped destination.
                    </p>
                  )}
                </div>
              </section>
            )}
          </div>
        )}
        <footer>
          <div className="footer-brand">
            <RouteIcon size={16} /> routewise.
          </div>
          <span>Made for the journey, not just the destination.</span>
        </footer>
      </main>
      {settings && (
        <VehicleSettings
          vehicle={vehicle}
          onSave={saveVehicle}
          onClose={() => setSettings(false)}
          research={config ?? undefined}
        />
      )}
    </div>
  );
}
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  componentDidCatch(e: Error) {
    log("react.render.failed", e.message, "ERROR");
  }
  render() {
    return this.state.error ? (
      <div className="fatal-error" role="alert">
        <TriangleAlert size={32} />
        <h1>The page encountered an error</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>Reload RouteWise</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
