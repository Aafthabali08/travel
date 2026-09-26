"""PostgreSQL storage: vehicle profiles (opaque browser token) and anonymous fare votes."""

import hashlib
import json
import os
import time
import uuid
from functools import lru_cache
from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

VOTE_WINDOW = 86400

FARE_VOTES_DDL = """
CREATE TABLE IF NOT EXISTS fare_votes (
    id varchar(36) PRIMARY KEY,
    voter_hash varchar(64) NOT NULL,
    kind varchar(20) NOT NULL,
    band varchar(12) NOT NULL,
    base_fare double precision NOT NULL CHECK (base_fare > 0),
    shown_fare double precision NOT NULL CHECK (shown_fare >= 0),
    paid_fare double precision CHECK (paid_fare >= 0),
    verdict varchar(8) NOT NULL CHECK (verdict IN ('correct', 'wrong')),
    created_at double precision NOT NULL
)
"""
PROFILES_DDL = """
CREATE TABLE IF NOT EXISTS user_vehicle_profiles (
    id uuid PRIMARY KEY,
    owner_token_hash text NOT NULL,
    profile jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
)
"""
FARE_VOTES_INDEX = (
    "CREATE INDEX IF NOT EXISTS fare_votes_key_idx ON fare_votes (kind, band, created_at)"
)


@lru_cache(maxsize=4)
def _engine(url):
    args = {"connect_timeout": 5} if url.startswith("postgresql") else {}
    return create_engine(
        url, pool_pre_ping=True, pool_size=3, max_overflow=2, connect_args=args
    )


def database():
    url = os.getenv("DATABASE_URL")
    if not url:
        raise HTTPException(
            503,
            "PostgreSQL is not configured. Vehicle settings remain available in browser storage.",
        )
    return _engine(url)


def hashed(token):
    return hashlib.sha256(token.encode()).hexdigest()


def owner(token):
    if not token or len(token) < 32 or len(token) > 256:
        raise HTTPException(
            401, "A private profile token of at least 32 characters is required."
        )
    return hashed(token)


def init_schema():
    if not os.getenv("DATABASE_URL"):
        return False
    engine = database()
    with engine.begin() as conn:
        conn.execute(text(FARE_VOTES_DDL))
        conn.execute(text(FARE_VOTES_INDEX))
        if engine.dialect.name == "postgresql":
            conn.execute(text(PROFILES_DDL))
    return True


def database_status():
    if not os.getenv("DATABASE_URL"):
        return "not configured"
    try:
        with database().connect() as conn:
            conn.execute(text("SELECT 1"))
        return "ok"
    except SQLAlchemyError:
        return "unreachable"


def fetch_votes():
    with database().connect() as conn:
        rows = conn.execute(
            text(
                "SELECT voter_hash, kind, band, base_fare, shown_fare, paid_fare, verdict, created_at "
                "FROM fare_votes WHERE created_at > :since"
            ),
            {"since": time.time() - 365 * 86400},
        )
        return [
            {
                "voter": r[0],
                "kind": r[1],
                "band": r[2],
                "base": r[3],
                "shown": r[4],
                "paid": r[5],
                "verdict": r[6],
                "created_at": r[7],
            }
            for r in rows
        ]


def save_vote(voter, kind, band, base, shown, paid, verdict):
    """One vote per rider, fare kind and distance band per 24 hours; a newer vote replaces it."""
    now = time.time()
    try:
        with database().begin() as conn:
            conn.execute(
                text(
                    "DELETE FROM fare_votes WHERE voter_hash=:voter AND kind=:kind "
                    "AND band=:band AND created_at > :since"
                ),
                {"voter": hashed(voter), "kind": kind, "band": band, "since": now - VOTE_WINDOW},
            )
            conn.execute(
                text(
                    "INSERT INTO fare_votes (id, voter_hash, kind, band, base_fare, shown_fare, paid_fare, verdict, created_at) "
                    "VALUES (:id, :voter, :kind, :band, :base, :shown, :paid, :verdict, :now)"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "voter": hashed(voter),
                    "kind": kind,
                    "band": band,
                    "base": base,
                    "shown": shown,
                    "paid": paid,
                    "verdict": verdict,
                    "now": now,
                },
            )
    except SQLAlchemyError as exc:
        raise HTTPException(
            503, "Fare votes can't be saved right now. The database is unavailable."
        ) from exc


def profiles(token, profile=None):
    owner_hash = owner(token)
    engine = database()
    try:
        with engine.begin() as conn:
            if profile:
                key = str(uuid.uuid4())
                conn.execute(
                    text(
                        "INSERT INTO user_vehicle_profiles (id,owner_token_hash,profile) VALUES (:id,:owner,CAST(:profile AS jsonb))"
                    ),
                    {
                        "id": key,
                        "owner": owner_hash,
                        "profile": json.dumps(profile.model_dump()),
                    },
                )
                return {"id": key, "profile": profile.model_dump()}
            return [
                {"id": str(row[0]), "profile": row[1]}
                for row in conn.execute(
                    text(
                        "SELECT id,profile FROM user_vehicle_profiles WHERE owner_token_hash=:owner ORDER BY updated_at DESC"
                    ),
                    {"owner": owner_hash},
                )
            ]
    except SQLAlchemyError as exc:
        raise HTTPException(
            503,
            "Vehicle storage is unavailable. Check PostgreSQL and apply backend/database/schema.sql.",
        ) from exc
