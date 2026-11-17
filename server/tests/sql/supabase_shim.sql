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
