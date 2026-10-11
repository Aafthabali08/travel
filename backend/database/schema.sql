-- RouteWise PostgreSQL schema. Precise searches/GPS trails are deliberately not stored.
CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_vehicle_profiles (
    id uuid PRIMARY KEY,
    owner_token_hash text NOT NULL,
    profile jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_owner_idx ON user_vehicle_profiles(owner_token_hash);
-- Anonymous rider fare reports feeding the open fare model (backend/app/fare_model.py).
CREATE TABLE IF NOT EXISTS fare_votes (
    id varchar(36) PRIMARY KEY,
    voter_hash varchar(64) NOT NULL,
    kind varchar(20) NOT NULL,
    band varchar(12) NOT NULL,
    base_fare double precision NOT NULL CHECK (base_fare > 0),
    shown_fare double precision NOT NULL CHECK (shown_fare >= 0),
    paid_fare double precision CHECK (paid_fare >= 0),
    verdict varchar(8) NOT NULL CHECK (verdict IN ('correct', 'wrong')),
    created_at double precision NOT NULL,
    -- Coarse (~1.6 km) map cells of the trip's ends, never exact coordinates.
    origin_cell varchar(16),
    dest_cell varchar(16)
);
CREATE INDEX IF NOT EXISTS fare_votes_key_idx ON fare_votes (kind, band, created_at);
-- Cached Gemini fare suggestions (AI estimates, never fed into the rider-report model).
CREATE TABLE IF NOT EXISTS gemini_fares (
    cache_key varchar(120) PRIMARY KEY,
    kind varchar(20) NOT NULL,
    fare double precision NOT NULL CHECK (fare > 0),
    low_fare double precision NOT NULL,
    high_fare double precision NOT NULL,
    note text NOT NULL,
    model varchar(60) NOT NULL,
    created_at double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS places (
    place_id text PRIMARY KEY,
    name text NOT NULL,
    kind text,
    description text
    -- Fresh photo metadata and provider coordinates are requested on demand.
);
CREATE TABLE IF NOT EXISTS transport_modes (mode text PRIMARY KEY, label text NOT NULL);
CREATE TABLE IF NOT EXISTS transit_feeds (
    id text PRIMARY KEY,
    source_url text NOT NULL,
    license text NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transit_agencies (
    feed_id text REFERENCES transit_feeds(id) ON DELETE CASCADE,
    agency_id text,
    data jsonb NOT NULL,
    PRIMARY KEY (feed_id, agency_id)
);
CREATE TABLE IF NOT EXISTS transit_stops (
    feed_id text REFERENCES transit_feeds(id) ON DELETE CASCADE,
    stop_id text,
    name text NOT NULL,
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    data jsonb NOT NULL,
    PRIMARY KEY (feed_id, stop_id)
);
CREATE TABLE IF NOT EXISTS transit_routes (
    feed_id text REFERENCES transit_feeds(id) ON DELETE CASCADE,
    route_id text,
    data jsonb NOT NULL,
    PRIMARY KEY (feed_id, route_id)
);
CREATE TABLE IF NOT EXISTS transit_calendars (
    feed_id text REFERENCES transit_feeds(id) ON DELETE CASCADE,
    service_id text,
    data jsonb NOT NULL,
    PRIMARY KEY (feed_id, service_id)
);
CREATE TABLE IF NOT EXISTS transit_calendar_dates (
    feed_id text REFERENCES transit_feeds(id) ON DELETE CASCADE,
    service_id text,
    date text,
    exception_type integer NOT NULL CHECK (exception_type IN (1, 2)),
    PRIMARY KEY (feed_id, service_id, date)
);
CREATE TABLE IF NOT EXISTS transit_trips (
    feed_id text REFERENCES transit_feeds(id) ON DELETE CASCADE,
    trip_id text,
    route_id text NOT NULL,
    service_id text NOT NULL,
    data jsonb NOT NULL,
    PRIMARY KEY (feed_id, trip_id),
    FOREIGN KEY (feed_id, route_id) REFERENCES transit_routes(feed_id, route_id)
);
CREATE TABLE IF NOT EXISTS transit_stop_times (
    feed_id text,
    trip_id text,
    stop_id text NOT NULL,
    stop_sequence integer NOT NULL,
    arrival_time text,
    departure_time text,
    data jsonb NOT NULL,
    PRIMARY KEY (feed_id, trip_id, stop_sequence),
    FOREIGN KEY (feed_id, trip_id) REFERENCES transit_trips(feed_id, trip_id) ON DELETE CASCADE,
    FOREIGN KEY (feed_id, stop_id) REFERENCES transit_stops(feed_id, stop_id)
);
CREATE TABLE IF NOT EXISTS transit_transfers (
    feed_id text REFERENCES transit_feeds(id) ON DELETE CASCADE,
    data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS fare_rules (
    id bigserial PRIMARY KEY,
    feed_id text REFERENCES transit_feeds(id) ON DELETE CASCADE,
    source text NOT NULL,
    effective_date date,
    data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS fuel_prices (
    id bigserial PRIMARY KEY,
    city text NOT NULL,
    fuel text NOT NULL,
    price numeric NOT NULL CHECK (price > 0),
    source text NOT NULL,
    effective_date date NOT NULL
);
CREATE TABLE IF NOT EXISTS parking_rules (id bigserial PRIMARY KEY, place_id text, source text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS toll_rules (id bigserial PRIMARY KEY, source text NOT NULL, data jsonb NOT NULL);
