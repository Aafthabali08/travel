"""Import an explicitly sourced GTFS ZIP into PostgreSQL in one transaction.

Usage: .venv/bin/python scripts/import_gtfs.py feed.zip --id city-agency \
  --source https://agency.example/feed --license 'Agency licence'

No archive files are extracted. This stores official data; Google Routes remains
this release's live transit router until a time-dependent GTFS router is connected.
"""

import argparse
import csv
import io
import json
import os
import zipfile
from pathlib import Path
from sqlalchemy import create_engine, text
from dotenv import load_dotenv


def rows(archive, name):
    if name not in archive.namelist():
        return []
    info = archive.getinfo(name)
    if info.file_size > 200_000_000:
        raise ValueError(f"{name} exceeds the import size limit")
    return csv.DictReader(io.TextIOWrapper(archive.open(name), encoding="utf-8-sig"))


def main():
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--license", required=True)
    args = parser.parse_args()
    if not os.getenv("DATABASE_URL"):
        raise SystemExit(
            "DATABASE_URL is required. Apply backend/database/schema.sql first."
        )
    engine = create_engine(os.environ["DATABASE_URL"])
    with zipfile.ZipFile(args.file) as archive, engine.begin() as conn:
        required = {
            "agency.txt",
            "stops.txt",
            "routes.txt",
            "trips.txt",
            "stop_times.txt",
        }
        missing = required - set(archive.namelist())
        if missing:
            raise ValueError(f"Missing required GTFS files: {sorted(missing)}")
        if not {"calendar.txt", "calendar_dates.txt"} & set(archive.namelist()):
            raise ValueError("GTFS requires calendar.txt or calendar_dates.txt")
        # Duplicate feed IDs fail without deleting a previously imported feed.
        conn.execute(
            text(
                "INSERT INTO transit_feeds (id,source_url,license) VALUES (:id,:source,:license)"
            ),
            vars(args),
        )
        definitions = [
            (
                "agency.txt",
                "transit_agencies",
                {"agency_id": lambda r: r.get("agency_id") or args.id},
            ),
            (
                "stops.txt",
                "transit_stops",
                {
                    "stop_id": lambda r: r["stop_id"],
                    "name": lambda r: r["stop_name"],
                    "latitude": lambda r: float(r["stop_lat"]),
                    "longitude": lambda r: float(r["stop_lon"]),
                },
            ),
            ("routes.txt", "transit_routes", {"route_id": lambda r: r["route_id"]}),
            (
                "calendar.txt",
                "transit_calendars",
                {"service_id": lambda r: r["service_id"]},
            ),
            (
                "trips.txt",
                "transit_trips",
                {
                    "trip_id": lambda r: r["trip_id"],
                    "route_id": lambda r: r["route_id"],
                    "service_id": lambda r: r["service_id"],
                },
            ),
            (
                "stop_times.txt",
                "transit_stop_times",
                {
                    "trip_id": lambda r: r["trip_id"],
                    "stop_id": lambda r: r["stop_id"],
                    "stop_sequence": lambda r: int(r["stop_sequence"]),
                    "arrival_time": lambda r: r.get("arrival_time"),
                    "departure_time": lambda r: r.get("departure_time"),
                },
            ),
            ("transfers.txt", "transit_transfers", {}),
        ]
        for filename, table, columns in definitions:
            count = 0
            # Names below come only from this static table, never user input.
            names = ["feed_id", *columns, "data"]
            values = [":feed_id", *(":" + c for c in columns), "CAST(:data AS jsonb)"]
            statement = text(
                f'INSERT INTO {table} ({",".join(names)}) VALUES ({",".join(values)})'
            )
            for row in rows(archive, filename):
                conn.execute(
                    statement,
                    {
                        "feed_id": args.id,
                        **{k: fn(row) for k, fn in columns.items()},
                        "data": json.dumps(row),
                    },
                )
                count += 1
            print(
                json.dumps(
                    {"event": "gtfs.table.imported", "table": table, "count": count}
                )
            )
        for row in rows(archive, "calendar_dates.txt"):
            conn.execute(
                text(
                    "INSERT INTO transit_calendar_dates VALUES (:feed,:service,:date,:type)"
                ),
                {
                    "feed": args.id,
                    "service": row["service_id"],
                    "date": row["date"],
                    "type": int(row["exception_type"]),
                },
            )
        for filename in (
            "fare_attributes.txt",
            "fare_rules.txt",
            "fare_products.txt",
            "fare_leg_rules.txt",
            "fare_transfer_rules.txt",
        ):
            for row in rows(archive, filename):
                conn.execute(
                    text(
                        "INSERT INTO fare_rules (feed_id,source,data) VALUES (:feed,:source,CAST(:data AS jsonb))"
                    ),
                    {
                        "feed": args.id,
                        "source": args.source,
                        "data": json.dumps({"gtfs_file": filename, **row}),
                    },
                )
    print(json.dumps({"event": "gtfs.import.committed", "feed": args.id}))


if __name__ == "__main__":
    main()
