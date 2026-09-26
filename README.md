# RouteWise

React + TypeScript + FastAPI journey planner for Visakhapatnam. Solid-color UI; no gradients. Demo data is isolated from live Google Routes/Places responses. A failed live provider never falls back to demo data.

## Run locally

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
npm ci
npm run dev
```

Open http://127.0.0.1:5178. API documentation: http://127.0.0.1:8018/docs.

`npm run dev` starts both servers and streams their output to the same terminal. Ctrl+C stops both. Frontend changes reload automatically; restart the command after Python changes.

## Debugging

- **Debug** in the top bar opens a searchable, downloadable event stream.
- Errors appear on the page with request IDs. Render crashes have a recovery screen.
- `logs/development.log`: combined frontend/API process output.
- `logs/events.jsonl`: structured events with UTC timestamp, severity, event, request ID, elapsed time, and controlled context.
- Logs include clicks, field changes (not values), map movement, GPS accuracy, navigation transitions, route generation/filtering/ranking, cost totals, validation failures, and external failures.
- Continuous coordinates and location input values are not intentionally logged. GPS checks are processed without storing trails. Route results expire from process memory after 30 minutes; navigation session handles after two hours.
- Terminal commands: `tail -f logs/development.log` or `tail -f logs/events.jsonl`.

## Live maps

Copy `.env.example` to `.env`, then provide:

```dotenv
GOOGLE_MAPS_API_KEY=server-key
GOOGLE_MAPS_BROWSER_KEY=restricted-browser-key
```

Enable billing, Routes API, Places API (New), and Maps JavaScript API in your Google Cloud project. Restrict the server key to the required APIs/IPs and the browser key to your application origins/APIs. The browser key is intentionally public; the server key stays on the backend. Restart the app, select **Live**, and select real autocomplete results or grant GPS access.

- Live walking, cycling, personal bike/car/EV routes and transit are requested independently.
- Bus, share auto, private auto and cab fares come from the open fare model below; every fare shows its source and whether riders have checked it. Train/metro fares stay unavailable unless Google returns one. Budget limits exclude unknown-cost routes.
- Private auto and cab routes use Google road distance and time; availability is not guaranteed and the meter or app price may differ.
- Google transit support varies by area. Train/metro schema support does not imply local service availability.
- Vehicle costs default to researched Visakhapatnam fuel prices and real-world mileage (editable). Fuel/energy + user-supplied tolls and parking are operating costs, not taxi fares.
- Walking navigation checks GPS accuracy, repeated deviation, and a 30-second reroute cooldown. Three reliable off-route samples are required. Arrival needs location accuracy ≤25 m and proximity within 25 m.
- Photos are requested from fresh Places metadata and show supplied author names. No fake landmark image is used. Provider entrances and indoor platform access are not guaranteed.
- Mobile geolocation requires localhost or HTTPS, browser consent, and device location services.

Provider documentation: [Routes](https://developers.google.com/maps/documentation/routes/compute_route_directions), [Transit](https://developers.google.com/maps/documentation/routes/transit-route), [Places Autocomplete](https://developers.google.com/maps/documentation/places/web-service/place-autocomplete).

## Fares and the open fare model

`backend/app/fares.py` holds researched fare cards, each with its source and check date:

| Kind | Rule | Source |
|---|---|---|
| Private auto | ₹25 + ₹10/km; 22:00–06:00 ₹37.5 + ₹15/km | Ola Auto card, Vizag (Jan 2026) |
| Cab | ₹40 + ₹6/km + ₹1/min; night ₹8/km | Uber Go card, Vizag (Feb 2026) |
| Share auto | ₹10 up to 4 km, then ₹2.5/km, max ₹30 | Rider reports (low confidence) |
| City bus | ₹10 up to 5 km, then ₹1/km (Google fare used when returned) | APSRTC ₹1/km estimate (low confidence) |

Fuel defaults: petrol ₹116.5/L, diesel ₹103.95/L, CNG ₹92.5/kg, electricity ₹10/kWh (Visakhapatnam, 2026). The **Stree Shakti** option in Journey preferences makes City Ordinary / Metro Express bus fares ₹0.

Riders rate fares with **Correct** or **Wrong → What did you pay?**. `backend/app/fare_model.py` turns each vote into a ratio against the researched fare and learns a multiplier per fare kind and distance band (0–3, 3–7, 7–15, 15+ km):

`fare = researched fare × exp(Σ w·ln(rider ÷ researched) ÷ (5 + Σ w))`

- The prior weight of 5 keeps a few votes from swinging fares; at least 3 different riders are needed before a fare changes.
- Votes halve in weight every 60 days, ratios outside 0.25–4× are ignored, and the multiplier is clamped to 0.5–2×.
- One vote per rider (anonymous browser token, stored hashed), fare kind and band per 24 hours. Votes are only accepted for live routes the server itself returned in the last 30 minutes.
- `GET /api/fares` publishes the full model: rules, sources and every learned multiplier.
- Without a database (or if it's unreachable) the app keeps working on researched fares; voting returns 503.

## Deploy to Render (free)

Render runs the Docker image (API + built frontend on one HTTPS origin, which also enables phone GPS). Votes live in Supabase Postgres, whose free database doesn't expire.

1. **Supabase**: create a project → **Connect** → copy the **Session pooler** URI (Render can't reach Supabase's IPv6-only direct host). Change the prefix to `postgresql+psycopg://`. Tables are created automatically on startup.
2. **GitHub**: push this repository (`.env` is ignored and must never be committed).
3. **Render**: New → **Blueprint** → select the repo (`render.yaml`: free plan, Singapore, health check `/api/health`). Enter `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_BROWSER_KEY` and `DATABASE_URL` when prompted.
4. **Google Cloud**: add `https://<your-service>.onrender.com/*` to the browser key's website restrictions. For the server key, add the outbound IPs from Render's dashboard (service → **Connect** → Outbound) or set application restriction to None (API restrictions still apply).
5. Open `https://<your-service>.onrender.com/api/health`: expect `"status":"ok"`, `"provider_configured":true`, `"database":"ok"`.

Free-tier behaviour: Render sleeps after 15 idle minutes (first request then takes 30–60 s). Supabase pauses after 7 days without database activity; resume it from the dashboard. Fares fall back to the researched values meanwhile.

Test the production image locally:

```sh
docker build -t routewise .
docker run --rm -p 10000:10000 -e PORT=10000 --env-file .env routewise
```

## Scope and data limitations

The complete local app flow is usable now: select sample places, choose modes, apply budget/walking/time limits, compare routes, inspect legs, simulate navigation, save vehicle assumptions, inspect/export logs, and exercise error states. Demo geometry, schedules, numbers and fares are illustrative, never travel instructions.

Google adapters are implemented but require your credentials and a field test before using live navigation. Google transit supplies live multimodal walk/transit combinations. The bounded graph optimizer also supports a development transport graph, connectivity checks, deduplication, Pareto filtering, and configurable scoring weights. It does not invent live bus-to-auto combinations without a licensed transport dataset.

PostgreSQL schema and GTFS importer are supplied, but no official local GTFS feed is bundled. Imported feeds are storage-ready; a time-dependent GTFS routing adapter remains future integration work. There is no AI explanation provider connected; displayed explanations are drawn from route facts. No authentication, public deployment, or production operations validation is claimed.

## PostgreSQL and Docker

```sh
docker compose up --build
```

This serves the production frontend and API at http://localhost:8018 and initializes PostgreSQL with `backend/database/schema.sql`. PostgreSQL binds only to `127.0.0.1:5432`, so the local Python development server can connect without exposing the database to the network. Compose credentials are local development defaults; use managed secrets before deployment. Docker must be installed and running.

Vehicle settings use browser storage by default. Optional API profile persistence requires PostgreSQL and a private `X-Profile-Token` header (at least 32 random characters, generated and held by the caller). This isolates profile records by a hashed capability token; it is not account authentication. Do not expose the storage endpoints publicly without deployment access controls.

Import an official/licensed GTFS archive:

```sh
.venv/bin/python scripts/import_gtfs.py path/to/feed.zip --id city-agency --source https://agency.example/feed --license 'Feed licence'
```

Set `DATABASE_URL` first. Imports are transactional, validate required tables and foreign keys, preserve provenance, and fail on duplicate feed IDs without deleting existing data. The importer stores schedules but does not assert current service or fare availability.

## Build and tests

```sh
npm run build
npm test
# With npm run dev already running and Google Chrome installed:
npm run test:e2e
```

The backend tests cover fuel/EV math, validation, fares, bounded graph generation, impossible connections, budget/walking limits, unknown fares, scoring, Pareto filtering, GPS accuracy/deviation/cooldowns, API errors, and demo/live separation. Browser tests cover the end-to-end journey, playback, logging, vehicle persistence, search, GPS denial, API failure display, and mobile overflow. Real Google API responses, PostgreSQL execution, Docker build, and physical GPS navigation require their respective services and are not validated by the offline suite.

## Source layout

- `frontend/src/App.tsx`: planner, routes, navigation, settings and debug views.
- `frontend/src/Map.tsx`: demo OpenStreetMap/Leaflet and live Google Maps adapters.
- `frontend/src/api.ts`: client requests and mirrored event logging.
- `backend/app/models.py`: validated domain/API schemas.
- `backend/app/engines.py`: fares, energy, graph, scoring, Pareto, navigation math.
- `backend/app/provider.py`: server-side Google Places, photos and Routes adapter.
- `backend/app/demo.py`: isolated illustrative fixtures.
- `backend/app/main.py`: API, error handling, request IDs, rate limits, expiring sessions.
- `backend/app/fares.py`: researched fare cards, fuel prices and mileage presets with sources.
- `backend/app/fare_model.py`: the open fare-learning model.
- `backend/app/storage.py`: PostgreSQL vehicle profiles and fare votes.
- `render.yaml`: Render deployment blueprint.
- `backend/database/schema.sql`: PostgreSQL and GTFS-compatible tables.


## Live connection audit

Run `npm run test:live` for a small set of real Google API checks (uses your API quota). It prints only redacted results and writes `reports/live-check.json`. A blocked or failed service exits with a nonzero status. The test stops dependent place/route checks when autocomplete authentication is rejected.

If you see `API_KEY_HTTP_REFERRER_BLOCKED`, edit the **server** key's application restriction in Google Cloud Console: use IP addresses for the backend's public outbound IP, and permit Places API (New) and Routes API. Keep the browser key separately restricted to the website origins and Maps JavaScript API. Do not paste either key into logs or chat. Restart `npm run dev` after changing `.env`.

To run PostgreSQL for local development, open Docker Desktop and run `docker compose up -d db` before `npm run dev`. This does not require a third terminal. Database-backed profile APIs remain optional; the Vehicle settings screen uses browser storage.
