"""Test setup: a fresh Postgres database with the Supabase shim + all migrations.

Start the test database first:  ./scripts/test-db.sh
"""

import json
import os
import uuid
from contextlib import contextmanager
from pathlib import Path

import jwt
import psycopg
import pytest
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parent.parent
ADMIN_URL = os.environ.get("TEST_ADMIN_URL", "postgresql://postgres:postgres@localhost:54329/postgres")
TEST_DB = "rowflow_pytest"
TEST_URL = ADMIN_URL.rsplit("/", 1)[0] + "/" + TEST_DB
JWT_SECRET = "test-secret-for-pytest-only-0123456789"

# Settings are read when the app is imported, so set them first.
os.environ.update(
    DATABASE_URL=TEST_URL,
    SUPABASE_JWT_SECRET=JWT_SECRET,
    SUPABASE_URL="http://localhost",
    CORS_ORIGINS="http://localhost:3000",
)


@pytest.fixture(scope="session", autouse=True)
def database():
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f"drop database if exists {TEST_DB} with (force)")
        admin.execute(f"create database {TEST_DB}")
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute((ROOT / "tests/sql/supabase_shim.sql").read_text())
        conn.execute("set role supabase_migrator")  # not a superuser, like Supabase
        for f in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            conn.execute(f.read_text())
    yield


@pytest.fixture
def owner():
    """Connection as the database owner (bypasses RLS) for setup and checks."""
    with psycopg.connect(TEST_URL, autocommit=True, row_factory=dict_row) as conn:
        yield conn


@pytest.fixture
def make_user(owner):
    def _make(consented: bool = True) -> uuid.UUID:
        uid = uuid.uuid4()
        owner.execute("insert into auth.users (id) values (%s)", (uid,))
        if consented:
            owner.execute("insert into users (id, ai_consent_at) values (%s, now())", (uid,))
        return uid
    return _make


@contextmanager
def as_user(uid: uuid.UUID):
    """One transaction acting as `uid`, exactly like app.db.user_conn."""
    with psycopg.connect(TEST_URL, row_factory=dict_row) as conn, conn.transaction():
        conn.execute("set local role app_user")
        conn.execute("select set_config('request.jwt.claims', %s, true)",
                     (json.dumps({"sub": str(uid), "role": "authenticated"}),))
        yield conn


def token_for(uid: uuid.UUID, **extra) -> str:
    claims = {"sub": str(uid), "aud": "authenticated", "role": "authenticated",
              "is_anonymous": True, **extra}
    return jwt.encode(claims, JWT_SECRET, algorithm="HS256")
