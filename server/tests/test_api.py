"""API checks: token verification and per-user access through /me."""

import uuid

import jwt
import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import token_for


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def auth(uid):
    return {"Authorization": f"Bearer {token_for(uid)}"}


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_missing_token(client):
    assert client.get("/me").status_code == 401


def test_bad_tokens(client):
    uid = uuid.uuid4()
    wrong_key = jwt.encode({"sub": str(uid), "aud": "authenticated"}, "x" * 40, algorithm="HS256")
    assert client.get("/me", headers={"Authorization": f"Bearer {wrong_key}"}).status_code == 401
    wrong_aud = token_for(uid, aud="someone-else")
    assert client.get("/me", headers={"Authorization": f"Bearer {wrong_aud}"}).status_code == 401
    expired = token_for(uid, exp=1)
    assert client.get("/me", headers={"Authorization": f"Bearer {expired}"}).status_code == 401


def test_consent_flow(client, make_user):
    a = make_user(consented=False)
    assert client.get("/me", headers=auth(a)).status_code == 404

    first = client.post("/me/consent", headers=auth(a)).json()
    assert first["id"] == str(a) and first["ai_consent_at"]

    again = client.post("/me/consent", headers=auth(a)).json()
    assert again["ai_consent_at"] == first["ai_consent_at"]  # first consent time is kept

    assert client.get("/me", headers=auth(a)).json()["id"] == str(a)


def test_each_user_sees_only_themselves(client, make_user):
    a, b = make_user(), make_user(consented=False)
    assert client.get("/me", headers=auth(a)).json()["id"] == str(a)
    assert client.get("/me", headers=auth(b)).status_code == 404  # A's row is not visible to B
