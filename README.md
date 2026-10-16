# RouteWise

React + TypeScript + FastAPI journey planner for Visakhapatnam, running on live Google Routes and Places data. Solid-color UI; no gradients. A failed provider is reported, never replaced with made-up routes.

## Run locally

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
npm ci
npm run dev
```

Open http://127.0.0.1:5178. API documentation: http://127.0.0.1:8018/docs.

`npm run dev` starts both servers and streams their output to the same terminal. Ctrl+C stops both. Frontend changes reload automatically; restart the command after Python changes.

## Logs

- Errors appear on the page with request IDs. Render crashes have a recovery screen.
- The API writes structured JSON events (UTC time, severity, event, request ID, elapsed time) to stdout; browser warnings and errors are forwarded to it. On Render these appear in the service's **Logs** tab.
- Locally: `logs/development.log` (combined process output) and `logs/events.jsonl` (structured events). Set `LOG_FILE=` (empty) to disable the file.
- Coordinates and typed place names are not intentionally logged. GPS checks are processed without storing trails. Route results expire from process memory after 30 minutes; navigation session handles after two hours.

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

### Google quota errors (HTTP 429)

`Google Maps rejected the request (HTTP 429)` with "request quota is used up" means your Google Cloud project hit a request cap, usually the Routes API's **ComputeRoutes requests per day** (a new "Maps Platform Demo Project" can be capped as low as 100 a day). One search spends about 4-5 Routes requests (walk, bike, transit, auto/cab, share-auto). The message shows the limit Google reported.

- **Raise it:** Google Cloud Console > APIs & Services > Routes API > *Quotas & system limits* > edit "Compute Routes requests per day" (a few thousand is plenty; the free monthly allowance covers tens of thousands of calls, so a cap also protects you from surprise bills).
- **Or wait:** daily quotas reset at midnight Pacific time (12:30 IST in winter, 11:30 IST in summer).
- **Fewer requests:** identical searches reuse the provider's routes for 10 minutes (`ROUTE_CACHE_SECONDS` in `backend/app/main.py`). Fares, rider reports and Gemini are still recomputed each search, failures are never cached, and the keep-alive ping only calls `/api/health`, never Google.

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

Riders rate fares with **Correct** or **Wrong → What did you pay?**. Every report is saved with the price paid, the fare shown, the exact trip distance and duration, the hour of day (India time) and the coarse start/end map cells (~1.6 km; never exact coordinates). `backend/app/fare_model.py` turns each report into `y = ln(paid ÷ researched fare)` and, per fare kind, learns three smooth corrections on top of the fare card (which already scales with distance and day/night):

`fare = researched fare × exp(distance + area + time)` (kept within 0.5-2×)

- **Distance** is a kernel-smoothed curve over `ln(km)` (bandwidth 0.35), so a report at 3.8 km informs trips of roughly 2.5-5.5 km, there are no band edges, and a trip length nobody has reported keeps the fare card.
- **Area** is what riders pay beyond the distance effect around the trip's start and end. Nearby cells share information (Gaussian kernel, 2 km), so a trip between places nobody reported still benefits from reports next door. It needs 5 different riders within ~2.4 km, uses a heavier prior of 8, stays within 0.7-1.5×, and applies half strength when only one end is known.
- **Time of day** is how night / morning (6-11) / midday (11-16) / evening (16-22) differ from the average of all timed reports once distance and area are accounted for. It needs 5 riders in that period and stays within 0.8-1.3×; reports from a single period teach nothing.
- Each term is a shrunk weighted mean (`Σ w·k·y ÷ (prior + Σ w·k)`), so a few reports barely move the fare, many consistent reports pull it toward what riders pay, and the prior of 5 keeps one noisy rider from swinging it. Reports halve in weight every 60 days, amounts outside 0.25-4× the fare card are ignored, and disputes without an amount don't count.
- A fare is **rider-checked** once 3 different riders near that distance have reported. Before that each rider only **nudges** it (prior 3× heavier with one rider, 2× with two: about +4%, +12% for riders who say a fare is double, then +30% at three). Below three riders each rider counts once, so one person reporting on many days cannot stack up a bigger nudge. The leg says "nudged by N rider reports" and the vote reply says "Your report already nudged it to ₹X".
- The model also learns how much riders disagree and shows "Riders usually pay ₹a-₹b" once 3 riders have confirmed a fare: the range widens when riders disagree and narrows as agreeing reports accumulate.
- One vote per rider (anonymous browser token, stored hashed), fare kind and distance band per 24 hours. Votes are only accepted for live routes the server itself returned in the last 30 minutes.
- Existing databases are upgraded automatically on startup (new columns `origin_cell`, `dest_cell`, `trip_km`, `trip_minutes`, `hour` are added to `fare_votes`; older reports keep counting, using their distance band's centre as their distance, and are ignored for area and time).
- `GET /api/fares` publishes the full model: rules, sources, the learned distance curve per fare kind, every area with enough riders and every time-of-day effect.
- Every paid price carries an info icon: prices can differ with availability, holidays and weather, and the model (and Gemini's suggestion) can be inaccurate. Weather and holidays are not modelled.
- Without a database (or if it's unreachable) the app keeps working on researched fares; voting returns 503.

**Does it learn?** It is supervised regression (each rider report is a labelled example: trip distance, area and hour in, rupees paid out) on top of a rule-based fare card. `backend/app/model_eval.py` backtests it on a hidden Vizag-like pattern (longer trips relatively pricier, a railway-station premium, a cheaper suburb, pricier evenings, 10% rider variation, 5% absurd reports), scoring 250 trips nobody reported, averaged over 5 samples. MAPE: fare card 25.7%; with 10 riders the model is at 16.7% (a plain average of reports 19.5%), 10.5% at 30, 8.1% at 100 and 7.4% at 300 (R² 0.96, MAE ₹11.7 on ₹172 fares). With very few riders it is deliberately cautious, so at 3 riders a plain average is briefly better. `backend/tests/test_predictor.py` keeps these properties tested.

**Model accuracy (admin).** `Admin → Model accuracy` (`GET /api/admin/model-accuracy`, verified admin only) scores every real rider report against what each predictor said *before* that report existed — the RouteWise fare shown, the fare card, the average of earlier reports and Gemini — with MAE, RMSE, MAPE, median % error, R², bias, share within ±10% and range coverage (target ≈68%). It has an "all reports" view and a stricter "only reports with a price paid" view (Correct confirmations agree with the shown fare by definition), a per-fare-type breakdown, a learning curve, the latest scored reports, the simulated benchmark and a glossary. Votes record the Gemini suggestion and range shown at the time so they can be scored.

## Gemini fare suggestions

Each priced leg (private auto, cab, share auto, bus) shows **RouteWise fare** and **Gemini suggests** side by side. Gemini's number is an independent AI estimate for Visakhapatnam, shown with a typical range and labelled "AI estimate, not verified". It never feeds the rider-report model and never changes the fare RouteWise charges to the total.

- Set `GEMINI_API_KEY` (free key from [Google AI Studio](https://aistudio.google.com/apikey)) and optionally `GEMINI_MODEL`. By default the app tries `gemini-3.5-flash-lite` (fastest), then `gemini-3.6-flash`, then `gemini-3.8-flash`. A model Google answers 404 for (older models are closed to new keys) is skipped and remembered; a busy (429/5xx) or slow model is skipped for that request only, with a 6 s per-model limit and a 10 s overall deadline. `GEMINI_MODEL`, if set, is tried first. Without a key the Gemini column is hidden and everything else works.
- **Places, distance and rider fares.** Gemini is told the trip's start and end place names, distance, duration, day/night and what nearby riders actually paid: the amounts (never rider ids) from reports of the same fare kind and distance band that start or end within ~2.4 km of the trip, newest report per rider, last 120 days. The card says what it used ("Uses 3 rider reports nearby" / "No rider reports nearby yet"). Gemini still never changes RouteWise's own fare.
- Suggestions are cached for 7 days (memory and the `gemini_fares` table) by fare kind, distance (0.5 km), time (5 min), day/night, start and end area, and bucketed rider evidence, so repeat searches don't spend quota and a meaningful new rider report refreshes the answer. Identical legs in one search share one request.
- If Gemini fails or times out (8 s), that leg shows "Suggestion unavailable right now"; the route and fare are unaffected. Replies that are unreadable, non-positive or above ₹5,000 are rejected.
- Rider progress shows on every priced leg ("1 of 3 riders so far"). After a report, the server replies "Thanks! 1 of 3 riders so far. The fare updates once 3 riders report it." and, from the third distinct rider, the fare moves gradually as more riders report (see the model above).

## Deploy to Render (free)

Render runs the Docker image (API + built frontend on one HTTPS origin, which also enables phone GPS). Votes live in Supabase Postgres, whose free database doesn't expire.

1. **Supabase**: create a project → **Connect** → copy the **Session pooler** URI (Render can't reach Supabase's IPv6-only direct host). Change the prefix to `postgresql+psycopg://`. Tables are created automatically on startup.
2. **GitHub**: push this repository (`.env` is ignored and must never be committed).
3. **Render**: New → **Blueprint** → select the repo (`render.yaml`: free plan, Singapore, health check `/api/health`). Enter `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_BROWSER_KEY` and `DATABASE_URL` when prompted.
4. **Google Cloud**: add `https://<your-service>.onrender.com/*` to the browser key's website restrictions. For the server key, add the outbound IPs from Render's dashboard (service → **Connect** → Outbound) or set application restriction to None (API restrictions still apply).
5. **Firebase** (accounts, tickets, admin): in Render → Environment add `FIREBASE_PROJECT_ID`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` (values from `.env`). Render passes them to the Docker build as build arguments, and the `VITE_*` ones are compiled into the frontend, so **redeploy after changing them**. In the Firebase console add `<your-service>.onrender.com` under Authentication → Settings → Authorised domains, and publish `firestore.rules` (see [Accounts and admin](#accounts-and-admin)).
6. Open `https://<your-service>.onrender.com/api/health`: expect `"status":"ok"`, `"provider_configured":true`, `"database":"ok"`.

Free-tier behaviour: Render sleeps after 15 idle minutes (first request then takes 30–60 s). Supabase pauses after 7 days without database activity; resume it from the dashboard. Fares fall back to the researched values meanwhile.

Test the production image locally:

```sh
docker build -t routewise .
docker run --rm -p 10000:10000 -e PORT=10000 --env-file .env routewise
```

## Scope and data limitations

Google transit supplies the walk/bus combinations; private auto, cab and share auto routes use Google road distance with the fare model above. Routes are filtered by your budget, walking and time limits, deduplicated, Pareto-filtered within each kind of transport and ranked. The app does not invent bus-to-auto combinations without a licensed transport dataset. Field-test navigation on a phone before relying on it.

PostgreSQL schema and GTFS importer are supplied, but no official local GTFS feed is bundled. Imported feeds are storage-ready; a time-dependent GTFS routing adapter remains future integration work. There is no AI explanation provider connected; displayed explanations are drawn from route facts. Accounts use Firebase Authentication; see below.

## Accounts and admin

Visitors see the planner as a demo; searching, location, tracking and Help & support need an account (Firebase email/password or Google). Data lives in Cloud Firestore:

| Collection | Holds |
| --- | --- |
| `users` | profile, all-time usage, admin-set `dailyLimit` / `blocked` |
| `usage`, `stats` | per-user and app-wide daily counters (searches, locations, journeys) |
| `tickets` (+ `messages`), `ticketImages` | support tickets, their chat, optional compressed screenshot |
| `notifications`, `problems`, `config/app` | in-app notifications, errors users saw, limits and announcement |

The admin dashboard (`/#/admin`) opens only for `aafthabali08@gmail.com` with a **verified** email (Google sign-in verifies automatically). It has Overview, Users (limits, block, message), Usage & quotas, Tickets (status Open → Received → In progress → Resolved → Closed), Chat, Problems, Notifications and Settings.

**Who can do what is enforced by `firestore.rules`**, not the browser: users read only their own data, counters can only rise by one per write, nobody but the verified admin can set limits, block users or post as support, and notification links must stay inside the app. Publish the rules from Firebase console → Firestore Database → Rules (or `firebase deploy --only firestore:rules`) whenever they change. With `FIREBASE_PROJECT_ID` set, the backend also rejects route, place, navigation and fare-vote calls that lack a valid Firebase ID token, and rate-limits per account.

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
npm test          # backend (pytest) + frontend unit (Vitest) + Firestore rules (emulator)
npm run test:e2e  # browser tests against the Firebase emulators (Google Chrome required)
```

`test:rules` and `test:e2e` start the Firebase Auth/Firestore emulators, which need the Firebase CLI (`npm i -g firebase-tools`) and Java 21+ on `PATH` (`brew install openjdk@21`, then `export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"`). They use the throwaway `demo-routewise` project and never touch the real Firebase project. `test:e2e` starts its own backend (port 8028) and frontend (port 5188), so a running `npm run dev` is unaffected.

Account tests cover the demo gate, sign-up/login errors, the daily allowance, the full ticket loop (image, admin confirm, live chat, notifications, resolve/reopen/close), admin limits/blocking/broadcasts/announcements, problem reporting, admin-only access (including an unverified admin email), HTML/script injection in tickets, and the dark theme. The rules suite attacks each Firestore collection as another user, an anonymous visitor and an unverified "admin".

The backend tests cover fuel/EV math, fare cards and the learning model, vote rules, Gemini parsing/caching/failure handling, the 1-of-3 rider progress, the area-learning model and the database migration, validation, disconnected legs, budget/walking limits, unknown fares, scoring, Pareto filtering, GPS accuracy/deviation/cooldowns, and API errors, with Google mocked. Browser tests use mocked Live responses for the journey, sorting, maps hand-off, live tracking, fare voting, Gemini side-by-side fares, the price note, vehicle settings, search, GPS denial, API failures, and mobile overflow. Real Google responses, Supabase, and physical GPS navigation need their services and a device.

## Source layout

- `frontend/src/App.tsx`: planner, routes, navigation, fare voting and settings.
- `frontend/src/Map.tsx`: Google Maps view.
- `frontend/src/api.ts`: client requests and error reporting.
- `backend/app/models.py`: validated domain/API schemas.
- `backend/app/engines.py`: energy cost, feasibility, scoring, Pareto, navigation math.
- `backend/app/provider.py`: server-side Google Places, photos and Routes adapter.
- `backend/app/main.py`: API, error handling, request IDs, rate limits, expiring sessions.
- `backend/app/fares.py`: researched fare cards, fuel prices and mileage presets with sources.
- `backend/app/fare_model.py`: the open fare-learning model.
- `backend/app/gemini.py`: cached Gemini fare suggestions, validated and failure-tolerant.
- `backend/app/storage.py`: PostgreSQL vehicle profiles and fare votes.
- `render.yaml`: Render deployment blueprint.
- `backend/database/schema.sql`: PostgreSQL and GTFS-compatible tables.


## Live connection audit

Run `npm run test:live` for a small set of real Google API checks (uses your API quota). It prints only redacted results and writes `reports/live-check.json`. A blocked or failed service exits with a nonzero status. The test stops dependent place/route checks when autocomplete authentication is rejected.

If you see `API_KEY_HTTP_REFERRER_BLOCKED`, edit the **server** key's application restriction in Google Cloud Console: use IP addresses for the backend's public outbound IP, and permit Places API (New) and Routes API. Keep the browser key separately restricted to the website origins and Maps JavaScript API. Do not paste either key into logs or chat. Restart `npm run dev` after changing `.env`.

To run PostgreSQL for local development, open Docker Desktop and run `docker compose up -d db` before `npm run dev`. This does not require a third terminal. Database-backed profile APIs remain optional; the Vehicle settings screen uses browser storage.
