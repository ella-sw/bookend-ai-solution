"""DB-level checks: R02 다른 사람 기록 접근 차단 + ERD rules enforced by the database."""

import psycopg
import pytest

from tests.conftest import TEST_URL, as_user


def new_record(owner, uid, status="saved", type_="free", body="오늘 있었던 일"):
    saved = "now()" if status == "saved" else "null"
    return owner.execute(
        f"insert into records (user_id, type, body, status, saved_at) "
        f"values (%s, %s, %s, %s, {saved}) returning id",
        (uid, type_, body, status),
    ).fetchone()["id"]


# ---------------------------------------------------------------------------
# R02: a user only sees and changes their own data
# ---------------------------------------------------------------------------
def test_other_user_cannot_read_update_or_delete(owner, make_user):
    a, b = make_user(), make_user()
    rid = new_record(owner, a)

    with as_user(b) as conn:
        assert conn.execute("select * from records where id = %s", (rid,)).fetchall() == []
        assert conn.execute("update records set original_kept_at = now() where id = %s",
                            (rid,)).rowcount == 0
        assert conn.execute("delete from records where id = %s", (rid,)).rowcount == 0

    with as_user(a) as conn:
        assert len(conn.execute("select * from records where id = %s", (rid,)).fetchall()) == 1


def test_cannot_write_rows_for_another_user(make_user):
    a, b = make_user(), make_user()
    with pytest.raises(psycopg.errors.InsufficientPrivilege), as_user(b) as conn:
        conn.execute("insert into records (user_id, type, body) values (%s, 'free', 'x')", (a,))


def test_cannot_add_qna_to_another_users_record(owner, make_user):
    a, b = make_user(), make_user()
    rid = new_record(owner, a, status="draft", type_="qna", body=None)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), as_user(b) as conn:
        conn.execute("insert into qna_messages (record_id, seq, question, question_source) "
                     "values (%s, 1, 'q', 'daily')", (rid,))


def test_cannot_build_material_on_another_users_record(owner, make_user):
    a, b = make_user(), make_user()
    rid = new_record(owner, a)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), as_user(b) as conn:
        conn.execute("insert into materials (user_id, record_id, origin) values (%s, %s, 'ai')",
                     (b, rid))


def test_browser_roles_have_no_table_access(owner, make_user):
    new_record(owner, make_user())
    for role in ("anon", "authenticated"):
        with psycopg.connect(TEST_URL) as conn:
            conn.execute(f"set role {role}")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute("select * from records")
            conn.rollback()
            conn.execute(f"set role {role}")
            assert conn.execute("select count(*) from topics").fetchone()[0] == 10


# ---------------------------------------------------------------------------
# ERD rule 2: saved records are frozen
# ---------------------------------------------------------------------------
def test_saved_record_body_cannot_change(owner, make_user):
    a = make_user()
    rid = new_record(owner, a)
    with pytest.raises(psycopg.errors.CheckViolation), as_user(a) as conn:
        conn.execute("update records set body = '고친 내용' where id = %s", (rid,))
    # analysis fields may still change
    with as_user(a) as conn:
        conn.execute("update records set analysis_status = 'analyzing' where id = %s", (rid,))


def test_saved_qna_cannot_change(owner, make_user):
    a = make_user()
    rid = new_record(owner, a, status="draft", type_="qna", body=None)
    owner.execute("insert into qna_messages (record_id, seq, question, question_source, answer) "
                  "values (%s, 1, 'q', 'daily', 'a')", (rid,))
    owner.execute("update records set status = 'saved', saved_at = now() where id = %s", (rid,))
    with pytest.raises(psycopg.errors.CheckViolation), as_user(a) as conn:
        conn.execute("update qna_messages set answer = 'b' where record_id = %s", (rid,))


# ---------------------------------------------------------------------------
# ERD rule 16: one draft per type
# ---------------------------------------------------------------------------
def test_one_draft_per_record_type(owner, make_user):
    a = make_user()
    new_record(owner, a, status="draft", type_="free")
    new_record(owner, a, status="draft", type_="qna", body=None)  # other type is fine
    with pytest.raises(psycopg.errors.UniqueViolation):
        new_record(owner, a, status="draft", type_="free")


def test_one_direct_essay_draft(owner, make_user):
    a = make_user()
    owner.execute("insert into essays (user_id, method) values (%s, 'direct')", (a,))
    with pytest.raises(psycopg.errors.UniqueViolation):
        owner.execute("insert into essays (user_id, method) values (%s, 'direct')", (a,))


# ---------------------------------------------------------------------------
# B·C 규칙 1: topic changes bump materials.updated_at (basis_hash input)
# ---------------------------------------------------------------------------
def test_topic_change_bumps_material_updated_at(owner, make_user):
    a = make_user()
    rid = new_record(owner, a)
    mid = owner.execute("insert into materials (user_id, record_id, origin) values (%s, %s, 'ai') "
                        "returning id", (a, rid)).fetchone()["id"]
    created = owner.execute("select updated_at from materials where id = %s",
                            (mid,)).fetchone()["updated_at"]

    with as_user(a) as conn:  # new transaction, so now() is later than `created`
        conn.execute("insert into material_topics (material_id, topic_id) values (%s, 1)", (mid,))

    after = owner.execute("select updated_at from materials where id = %s",
                          (mid,)).fetchone()["updated_at"]
    assert after > created


# ---------------------------------------------------------------------------
# ERD rule 3 / B·C 규칙 3: stuck requests become timeout, record analysis fails
# ---------------------------------------------------------------------------
def test_expire_ai_requests(owner, make_user):
    a = make_user()
    rid = new_record(owner, a)
    req = owner.execute(
        "insert into ai_requests (user_id, kind, target_type, target_id, started_at) "
        "values (%s, 'extract', 'record', %s, now() - interval '2 minutes') returning id",
        (a, rid)).fetchone()["id"]
    owner.execute("update records set analysis_status = 'analyzing', "
                  "latest_analysis_request_id = %s where id = %s", (req, rid))

    assert owner.execute("select expire_ai_requests()").fetchone()["expire_ai_requests"] == 1
    assert owner.execute("select status from ai_requests where id = %s",
                         (req,)).fetchone()["status"] == "timeout"
    assert owner.execute("select analysis_status from records where id = %s",
                         (rid,)).fetchone()["analysis_status"] == "failed"


# ---------------------------------------------------------------------------
# ERD rule 14: clear all data, keep the user row and consent
# ---------------------------------------------------------------------------
def test_clear_user_data(owner, make_user):
    a, b = make_user(), make_user()
    new_record(owner, a)
    new_record(owner, b)

    with pytest.raises(psycopg.errors.InsufficientPrivilege), as_user(b) as conn:
        conn.execute("select clear_user_data(%s)", (a,))

    with as_user(a) as conn:
        conn.execute("select clear_user_data(auth.uid())")

    assert owner.execute("select count(*) n from records where user_id = %s", (a,)).fetchone()["n"] == 0
    assert owner.execute("select count(*) n from records where user_id = %s", (b,)).fetchone()["n"] == 1
    u = owner.execute("select * from users where id = %s", (a,)).fetchone()
    assert u["ai_consent_at"] is not None and u["data_cleared_at"] is not None


# ---------------------------------------------------------------------------
# Supabase deletes users as supabase_auth_admin (search_path = auth): our triggers
# must still find their tables (migration 0006)
# ---------------------------------------------------------------------------
def test_functions_have_fixed_search_path(owner):
    rows = owner.execute(
        "select proname from pg_proc where pronamespace = 'public'::regnamespace "
        "and prokind = 'f' and not coalesce(proconfig, '{}') @> "
        "array['search_path=public, pg_temp']"
    ).fetchall()
    assert rows == []


def test_deleting_auth_user_with_auth_search_path(owner, make_user):
    uid = make_user()
    rec = owner.execute(
        "insert into records (user_id, type, body, status, saved_at) "
        "values (%s, 'free', '원본', 'saved', now()) returning id", (uid,)).fetchone()["id"]
    mat = owner.execute(
        "insert into materials (user_id, record_id, origin) values (%s, %s, 'ai') returning id",
        (uid, rec)).fetchone()["id"]
    owner.execute("insert into material_topics values (%s, 1)", (mat,))

    owner.execute("set search_path = auth")
    try:
        owner.execute("delete from auth.users where id = %s", (uid,))
    finally:
        owner.execute("set search_path = public")
    assert owner.execute("select count(*) n from records where user_id = %s",
                         (uid,)).fetchone()["n"] == 0
