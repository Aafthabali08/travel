import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
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
  demo,
  onError,
}: {
  route: Route | null;
  position: Point | null;
  origin: Place | null;
  destination: Place | null;
  activeLeg: number;
  browserKey: string;
  demo: boolean;
  onError: (message: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const overlay = useRef<any[]>([]);
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [legend, setLegend] = useState(true);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    let dead = false;
    setReady(false);
    setTileError(false);
    const onAuthFailure = () => {
      if (!dead && !demo) errorRef.current(authError);
    };
    window.addEventListener("routewise:map-auth-error", onAuthFailure);
    async function initialize() {
      if (!root.current) return;
      try {
        if (demo) {
          map.current = L.map(root.current, {
            zoomControl: false,
            attributionControl: true,
          }).setView([17.725, 83.301], 14);
          const tiles = L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            {
              attribution:
                '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
              maxZoom: 19,
            },
          ).addTo(map.current);
          tiles.on("tileerror", () => {
            if (!dead) setTileError(true);
          });
          map.current.on("moveend", () =>
            log("map.motion.completed", "Map center or zoom changed"),
          );
        } else if (browserKey) {
          if (googleAuthFailed) throw new Error(authError);
          await loadGoogle(browserKey);
          if (dead || !root.current) return;
          const g = (window as any).google;
          map.current = new g.maps.Map(root.current, {
            center: { lat: 17.725, lng: 83.301 },
            zoom: 14,
            disableDefaultUI: true,
          });
          map.current.addListener("idle", () =>
            log("map.motion.completed", "Google map idle"),
          );
        } else return;
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
      overlay.current.forEach((o) => (demo ? o.remove() : o.setMap(null)));
      overlay.current = [];
      if (map.current && demo) map.current.remove();
      map.current = null;
    };
  }, [demo, browserKey]);
  useEffect(() => {
    if (!ready || !map.current) return;
    overlay.current.forEach((o) => (demo ? o.remove() : o.setMap(null)));
    overlay.current = [];
    const bounds: Point[] = [];
    function marker(p: Point, label: string, color: string) {
      bounds.push(p);
      if (demo) {
        const icon = L.divIcon({
          className: "route-marker",
          html: `<span style="background:${color}">${label}</span>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        });
        overlay.current.push(
          L.marker([p.lat, p.lng], { icon }).addTo(map.current),
        );
      } else {
        const g = (window as any).google;
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
    }
    if (route) {
      route.legs.forEach((leg, i) => {
        const points = leg.polyline;
        bounds.push(...points);
        if (points.length > 1) {
          if (demo)
            overlay.current.push(
              L.polyline(
                points.map((p) => [p.lat, p.lng]),
                {
                  color: colors[leg.mode],
                  weight: i === activeLeg ? 7 : 5,
                  opacity: activeLeg < 0 || i === activeLeg ? 1 : 0.45,
                  dashArray: leg.mode === "WALK" ? "5 10" : undefined,
                },
              ).addTo(map.current),
            );
          else {
            const g = (window as any).google;
            overlay.current.push(
              new g.maps.Polyline({
                path: points,
                strokeColor: colors[leg.mode],
                strokeWeight: i === activeLeg ? 7 : 5,
                map: map.current,
              }),
            );
          }
        }
        if (i > 0) marker(leg.origin, String(i), colors[leg.mode]);
      });
    }
    if (origin) marker(origin, "A", "#146447");
    if (destination) marker(destination, "B", "#253d36");
    if (position) {
      marker(position, "•", "#397cec");
      if (demo)
        overlay.current.push(
          L.circle([position.lat, position.lng], {
            radius: 18,
            color: "#397cec",
            weight: 1,
            fillOpacity: 0.12,
          }).addTo(map.current),
        );
    }
    if (bounds.length > 1) {
      if (demo)
        map.current.fitBounds(
          bounds.map((p) => [p.lat, p.lng]),
          { padding: [65, 65], maxZoom: 16 },
        );
      else {
        const b = new (window as any).google.maps.LatLngBounds();
        bounds.forEach((p) => b.extend(p));
        map.current.fitBounds(b, 60);
      }
    }
  }, [route, origin, destination, activeLeg, ready, demo]);
  useEffect(() => {
    if (!ready || !position || !map.current) return;
    let marker: any;
    if (demo) {
      marker = L.circleMarker([position.lat, position.lng], {
        radius: 9,
        fillColor: "#347ce5",
        color: "#fff",
        weight: 3,
        fillOpacity: 1,
      }).addTo(map.current);
    } else
      marker = new (window as any).google.maps.Marker({
        position,
        map: map.current,
      });
    if (activeLeg >= 0) map.current.panTo(position);
    return () => {
      if (demo) marker.remove();
      else marker.setMap(null);
    };
  }, [position, ready, demo, activeLeg]);
  const zoom = (delta: number) => {
    if (map.current) map.current.setZoom(map.current.getZoom() + delta);
    log("map.zoom", String(delta));
  };
  const recenter = () => {
    const p = position || origin;
    if (map.current && p) {
      if (demo) map.current.setView([p.lat, p.lng], 16);
      else {
        map.current.panTo(p);
        map.current.setZoom(16);
      }
    }
    log("map.recenter");
  };
  return (
    <div className="map-shell">
      <div ref={root} className="map-canvas" aria-label="Journey map" />
      {!demo && !browserKey && (
        <div className="map-unavailable">
          <MapPin size={36} />
          <h3>Connect your live map</h3>
          <p>
            Add your Maps API keys to enable live routes.
            <br />
            Explore the sample journey in Demo mode.
          </p>
        </div>
      )}
      <div className="map-chip">
        <span className="green-dot" />
        VISAKHAPATNAM <span className="map-chip-divider" />{" "}
        {demo ? "DEMO MAP" : "LIVE MAP"}
      </div>
      {tileError && (
        <div className="tile-warning">
          Map tiles unavailable. Route overlays remain visible.
        </div>
      )}
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
      <div className="map-scale">
        {demo
          ? "Illustrative paths · not for navigation"
          : "Google Maps · provider routes"}
      </div>
    </div>
  );
}
