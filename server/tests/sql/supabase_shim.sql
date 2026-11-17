-- Minimal stand-in for what Supabase provides, so migrations run on plain Postgres in tests.
-- Never apply this to a real Supabase project.
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key
);

-- Same behavior as Supabase's auth.uid(): reads the "sub" claim of the current request.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

-- Like Supabase: only the API roles may use the auth schema and auth.uid().
-- (Our own roles get it only by inheriting `authenticated`, see migration 0005.)
revoke all on schema auth from public;
grant usage on schema auth to anon, authenticated;
revoke execute on function auth.uid() from public;
grant execute on function auth.uid() to anon, authenticated;

-- Supabase runs migrations as `postgres`, which is NOT a superuser there: it cannot hand
-- out rights on the auth schema (owned by supabase_admin), but it administers anon and
-- authenticated. Tests run migrations as this role for the same limits (conftest.py).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_migrator') then
    create role supabase_migrator nologin createrole;
  end if;
end $$;
grant create, usage on schema public to supabase_migrator;
grant usage on schema auth to supabase_migrator;
grant anon, authenticated to supabase_migrator with admin option;
grant references, select on auth.users to supabase_migrator;
-- app_user is cluster-wide, so role grants from earlier test runs survive the dropped
-- test database. Undo them, and let the migrator administer it as postgres does on Supabase.
do $$
declare
  m record;
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    for m in select roleid::regrole as role, grantor::regrole as grantor
               from pg_auth_members where member = 'app_user'::regrole loop
      execute format('revoke %s from app_user granted by %s', m.role, m.grantor);
    end loop;
    grant app_user to supabase_migrator with admin option;
  end if;
end $$;

-- Supabase deletes users (dashboard / admin API) as this role: rights on auth only,
-- search_path = auth. Tests delete users as this role (test_db_rules.py).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin;
  end if;
end $$;
grant usage on schema auth to supabase_auth_admin;
grant select, delete on auth.users to supabase_auth_admin;
