import { useTheme } from "./theme";
import { useEffect, useRef, useState } from "react";
import { LocateFixed, Plus, Minus, Layers, MapPin } from "lucide-react";
import type { Place, Point, Route } from "./types";
import { log } from "./api";
const colors: Record<string, string> = {
  WALK: "#6c8e79",
  BUS: "#146447",
  AUTO: "#dc8a38",
  BIKE: "#7465bc",
  CAR: "#7465bc",
  EV: "#7465bc",
  CAB: "#467bb4",
  BICYCLE: "#b6883a",
  TRAIN: "#146447",
  METRO: "#146447",
};
let googlePromise: Promise<void> | null = null;
let googleAuthFailed = false;
const authError =
  "Google Maps authentication failed. Check the browser key, billing, Maps JavaScript API access, and allowed website origins.";
(window as any).gm_authFailure = () => {
  googleAuthFailed = true;
  log("map.authentication.failed", authError, "ERROR");
  window.dispatchEvent(new Event("routewise:map-auth-error"));
};
function loadGoogle(key: string) {
  if (!googlePromise)
    googlePromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
      s.onload = () => resolve();
      s.onerror = () => {
        googlePromise = null;
        reject(new Error("Google map failed to load"));
      };
      document.head.appendChild(s);
    });
  return googlePromise;
}
export function JourneyMap({
  route,
  position,
  origin,
  destination,
  activeLeg,
  browserKey,
  onError,
}: {
  route: Route | null;
  position: Point | null;
  origin: Place | null;
  destination: Place | null;
  activeLeg: number;
  browserKey: string;
  onError: (message: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const overlay = useRef<any[]>([]);
  const [ready, setReady] = useState(false);
  const [legend, setLegend] = useState(true);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const theme = useTheme();
  useEffect(() => {
    let dead = false;
    setReady(false);
    const onAuthFailure = () => {
      if (!dead) errorRef.current(authError);
    };
    window.addEventListener("routewise:map-auth-error", onAuthFailure);
    async function initialize() {
      if (!root.current || !browserKey) return;
      try {
        if (googleAuthFailed) throw new Error(authError);
        await loadGoogle(browserKey);
        if (dead || !root.current) return;
        const g = (window as any).google;
        map.current = new g.maps.Map(root.current, {
          center: { lat: 17.725, lng: 83.301 },
          zoom: 14,
          disableDefaultUI: true,
          // Only settable at creation, so the map is rebuilt when the theme changes.
          ...(g.maps.ColorScheme && {
            colorScheme:
              theme === "dark"
                ? g.maps.ColorScheme.DARK
                : g.maps.ColorScheme.LIGHT,
          }),
        });
        if (!dead) setReady(true);
      } catch (error) {
        errorRef.current(
          error instanceof Error
            ? error.message
            : "The map could not load. Check your internet connection and Maps configuration.",
        );
      }
    }
    initialize();
    return () => {
      dead = true;
      window.removeEventListener("routewise:map-auth-error", onAuthFailure);
      overlay.current.forEach((o) => o.setMap(null));
      overlay.current = [];
      map.current = null;
    };
  }, [browserKey, theme]);
  useEffect(() => {
    if (!ready || !map.current) return;
    const g = (window as any).google;
    overlay.current.forEach((o) => o.setMap(null));
    overlay.current = [];
    const bounds: Point[] = [];
    function marker(p: Point, label: string, color: string) {
      bounds.push(p);
      overlay.current.push(
        new g.maps.Marker({
          position: p,
          map: map.current,
          label: { text: label, color: "#fff" },
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            scale: 13,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: "#fff",
            strokeWeight: 3,
          },
        }),
      );
    }
    if (route) {
      route.legs.forEach((leg, i) => {
        const points = leg.polyline;
        bounds.push(...points);
        if (points.length > 1)
          overlay.current.push(
            new g.maps.Polyline({
              path: points,
              strokeColor: colors[leg.mode],
              strokeWeight: i === activeLeg ? 7 : 5,
              map: map.current,
            }),
          );
        if (i > 0) marker(leg.origin, String(i), colors[leg.mode]);
      });
    }
    if (origin) marker(origin, "A", "#146447");
    if (destination) marker(destination, "B", "#253d36");
    if (position) marker(position, "•", "#397cec");
    if (bounds.length > 1) {
      const b = new g.maps.LatLngBounds();
      bounds.forEach((p) => b.extend(p));
      map.current.fitBounds(b, 60);
    }
  }, [route, origin, destination, activeLeg, ready]);
  useEffect(() => {
    if (!ready || !position || !map.current) return;
    const marker = new (window as any).google.maps.Marker({
      position,
      map: map.current,
    });
    if (activeLeg >= 0) map.current.panTo(position);
    return () => marker.setMap(null);
  }, [position, ready, activeLeg]);
  const zoom = (delta: number) => {
    if (map.current) map.current.setZoom(map.current.getZoom() + delta);
  };
  const recenter = () => {
    const p = position || origin;
    if (map.current && p) {
      map.current.panTo(p);
      map.current.setZoom(16);
    }
  };
  return (
    <div className="map-shell">
      <div ref={root} className="map-canvas" aria-label="Journey map" />
      {!browserKey && (
        <div className="map-unavailable">
          <MapPin size={36} />
          <h3>Live map not configured</h3>
          <p>Set GOOGLE_MAPS_BROWSER_KEY on the server to show the map.</p>
        </div>
      )}
      <div className="map-chip">
        <span className="green-dot" />
        VISAKHAPATNAM <span className="map-chip-divider" /> LIVE MAP
      </div>
      <div className="map-controls">
        <button aria-label="Zoom in" onClick={() => zoom(1)}>
          <Plus size={19} />
        </button>
        <button aria-label="Zoom out" onClick={() => zoom(-1)}>
          <Minus size={19} />
        </button>
        <button aria-label="Recenter map" onClick={recenter}>
          <LocateFixed size={19} />
        </button>
        <button
          aria-label="Toggle map legend"
          onClick={() => setLegend(!legend)}
        >
          <Layers size={19} />
        </button>
      </div>
      {legend && (
        <div className="map-legend">
          <span>
            <i className="line walk" /> Walk
          </span>
          <span>
            <i className="line bus" /> Public transport
          </span>
          <span>
            <i className="line vehicle" /> Personal vehicle
          </span>
        </div>
      )}
    </div>
  );
}
