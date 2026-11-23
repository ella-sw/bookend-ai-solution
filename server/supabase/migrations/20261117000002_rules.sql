-- Data rules enforced in the database (ERD v7 rules + B·C 규칙 1·3)

-- ---------------------------------------------------------------------------
-- updated_at helpers
-- ---------------------------------------------------------------------------
create function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger materials_updated_at before update on materials
  for each row execute function set_updated_at();
create trigger essays_updated_at before update on essays
  for each row execute function set_updated_at();
create trigger essay_versions_updated_at before update on essay_versions
  for each row execute function set_updated_at();

-- B·C 규칙 1: a topic change counts as a material change (basis_hash input)
create function touch_material_from_topics() returns trigger language plpgsql as $$
begin
  update materials set updated_at = now()
   where id = coalesce(new.material_id, old.material_id);
  return null;
end $$;

create trigger material_topics_touch after insert or delete on material_topics
  for each row execute function touch_material_from_topics();

-- ---------------------------------------------------------------------------
-- ERD rule 2: a saved record is frozen
-- ---------------------------------------------------------------------------
create function guard_record_update() returns trigger language plpgsql as $$
begin
  if old.status = 'saved' then
    if new.status <> 'saved'
       or new.type is distinct from old.type
       or new.title is distinct from old.title
       or new.body is distinct from old.body
       or new.saved_at is distinct from old.saved_at then
      raise exception 'record % is saved and cannot be changed', old.id
        using errcode = 'check_violation';
    end if;
  else
    new.updated_at := now();  -- "임시 저장 중에만 바뀜"
  end if;
  return new;
end $$;

create trigger records_guard before update on records
  for each row execute function guard_record_update();

create function guard_qna_change() returns trigger language plpgsql as $$
begin
  if exists (select 1 from records where id = new.record_id and status = 'saved') then
    raise exception 'record % is saved; its Q&A cannot be changed', new.record_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger qna_messages_guard before insert or update on qna_messages
  for each row execute function guard_qna_change();

-- ---------------------------------------------------------------------------
-- ERD rule 14: clear all of one user's data, keep the users row and consent
-- Runs as the caller: from the API (app_user) RLS limits it to the caller's
-- own rows; the monthly cleanup job runs it as the owner.
-- ---------------------------------------------------------------------------
create function clear_user_data(p_user uuid) returns void language plpgsql as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user then
    raise exception 'cannot clear another user''s data' using errcode = 'insufficient_privilege';
  end if;

  delete from events      where user_id = p_user;
  delete from essays      where user_id = p_user;  -- versions, essay_materials cascade
  delete from suggestions where user_id = p_user;  -- suggestion_materials cascade
  delete from records     where user_id = p_user;  -- qna, materials, material_topics cascade
  delete from ai_requests where user_id = p_user;
  update users set data_cleared_at = now() where id = p_user;
end $$;

-- ERD rule 15: one month after last visit
create function cleanup_inactive_users() returns int language plpgsql as $$
declare
  u record;
  n int := 0;
begin
  for u in
    select id from users
     where last_seen_at < now() - interval '1 month'
       and (data_cleared_at is null or data_cleared_at < last_seen_at)
  loop
    perform clear_user_data(u.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- ERD rule 3 + B·C 규칙 3: running requests older than the limit become
-- 'timeout'. A result that arrives later is discarded by the API, because
-- results are applied only while status = 'running'.
-- ---------------------------------------------------------------------------
create function expire_ai_requests(p_limit interval default interval '60 seconds')
returns int language plpgsql as $$
declare
  n int;
begin
  with expired as (
    update ai_requests
       set status = 'timeout', finished_at = now(), failure_reason = 'timeout'
     where status = 'running' and started_at < now() - p_limit
    returning id, kind, target_id
  ), rec as (
    update records r
       set analysis_status = 'failed'
      from expired e
     where e.kind = 'extract'
       and r.latest_analysis_request_id = e.id
       and r.analysis_status = 'analyzing'
  ), sug as (
    update suggestions s
       set status = 'failed', computed_at = now()
      from expired e
     where e.kind = 'suggest'
       and s.id = e.target_id
       and s.status = 'computing'
  )
  select count(*) into n from expired;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Access: RLS on every table (ERD rule 17)
-- ---------------------------------------------------------------------------
alter table users                enable row level security;
alter table records              enable row level security;
alter table qna_messages         enable row level security;
alter table materials            enable row level security;
alter table material_topics      enable row level security;
alter table suggestions          enable row level security;
alter table suggestion_materials enable row level security;
alter table essays               enable row level security;
alter table essay_materials      enable row level security;
alter table essay_versions       enable row level security;
alter table ai_requests          enable row level security;
alter table events               enable row level security;
alter table topics               enable row level security;
alter table daily_questions      enable row level security;

-- Browser roles: no direct access to user data (all data goes through the API)
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- Shared tables: read-only for everyone
grant select on topics, daily_questions to anon, authenticated, app_user;
create policy topics_read on topics for select using (true);
create policy daily_questions_read on daily_questions for select using (true);

-- API role
grant select, insert, update, delete on
  users, records, qna_messages, materials, material_topics, suggestions,
  suggestion_materials, essays, essay_materials, essay_versions, ai_requests, events
  to app_user;
grant usage, select on all sequences in schema public to app_user;
grant execute on function clear_user_data(uuid) to app_user;

-- Owner-column tables
create policy own on users       to app_user using (id = auth.uid())      with check (id = auth.uid());
create policy own on records     to app_user using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on materials   to app_user using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and exists (select 1 from records r where r.id = record_id and r.user_id = auth.uid()));
create policy own on suggestions to app_user using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on essays      to app_user using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and (suggestion_id is null
                   or exists (select 1 from suggestions s where s.id = suggestion_id and s.user_id = auth.uid())));
create policy own on ai_requests to app_user using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on events      to app_user using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Child tables: owned through their parent
create policy own on qna_messages to app_user
  using (exists (select 1 from records r where r.id = record_id and r.user_id = auth.uid()))
  with check (exists (select 1 from records r where r.id = record_id and r.user_id = auth.uid()));

create policy own on material_topics to app_user
  using (exists (select 1 from materials m where m.id = material_id and m.user_id = auth.uid()))
  with check (exists (select 1 from materials m where m.id = material_id and m.user_id = auth.uid()));

create policy own on essay_versions to app_user
  using (exists (select 1 from essays e where e.id = essay_id and e.user_id = auth.uid()))
  with check (exists (select 1 from essays e where e.id = essay_id and e.user_id = auth.uid()));

create policy own on essay_materials to app_user
  using (exists (select 1 from essays e where e.id = essay_id and e.user_id = auth.uid()))
  with check (exists (select 1 from essays e where e.id = essay_id and e.user_id = auth.uid())
              and exists (select 1 from materials m where m.id = material_id and m.user_id = auth.uid()));

create policy own on suggestion_materials to app_user
  using (exists (select 1 from suggestions s where s.id = suggestion_id and s.user_id = auth.uid()))
  with check (exists (select 1 from suggestions s where s.id = suggestion_id and s.user_id = auth.uid())
              and exists (select 1 from materials m where m.id = material_id and m.user_id = auth.uid()));
