-- Rowflow tables (ERD 소재추가 v7 + B·C 공유 DB 규칙 3건 + share_method)
-- Status values use text + CHECK (ERD rule 18, recommended option).

-- ---------------------------------------------------------------------------
-- API role
-- The Python server connects as the database owner and runs each request as
-- `app_user` (SET LOCAL ROLE), so RLS applies to server queries too.
-- `anon` / `authenticated` (Supabase's browser roles) get no access to user
-- tables: the browser only signs in, all data goes through the API.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

grant app_user to current_user;
grant usage on schema public to app_user;
grant usage on schema auth to app_user;

-- ---------------------------------------------------------------------------
-- Shared tables
-- ---------------------------------------------------------------------------
create table topics (
  id         smallint primary key,
  name       text not null unique,
  sort_order smallint not null
);

insert into topics (id, name, sort_order) values
  (1, '가족', 1), (2, '관계', 2), (3, '나·성장', 3), (4, '일·직업', 4), (5, '일상', 5),
  (6, '여행·장소', 6), (7, '음식', 7), (8, '취향·취미', 8), (9, '몸·건강', 9), (10, '자연·계절', 10);

create table daily_questions (
  id            uuid primary key default gen_random_uuid(),
  question_date date not null,
  seq           int  not null check (seq between 1 and 30),
  question      text not null,
  unique (question_date, seq)
);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
create table users (
  id              uuid primary key references auth.users (id) on delete cascade,
  created_at      timestamptz not null default now(),
  ai_consent_at   timestamptz,
  last_seen_at    timestamptz not null default now(),
  data_cleared_at timestamptz
);

-- ---------------------------------------------------------------------------
-- AI requests (created before records because records point at it)
-- target_type: B·C 규칙 2 — suggestion requests target suggestions.id (uuid)
-- ---------------------------------------------------------------------------
create table ai_requests (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references users (id) on delete cascade,
  kind           text not null check (kind in ('question', 'extract', 'suggest', 'draft', 'regen')),
  target_type    text not null check (target_type in ('record', 'suggestion', 'essay')),
  target_id      uuid not null,
  status         text not null default 'running'
                 check (status in ('running', 'ok', 'failed', 'timeout', 'discarded')),
  result         jsonb,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  failure_reason text,
  input_tokens   int,
  output_tokens  int
);
create index ai_requests_user_started_idx on ai_requests (user_id, started_at);
create index ai_requests_running_idx on ai_requests (started_at) where status = 'running';

-- ---------------------------------------------------------------------------
-- Stage 1: records and Q&A
-- ---------------------------------------------------------------------------
create table records (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null references users (id) on delete cascade,
  type                       text not null check (type in ('free', 'qna')),
  title                      text,
  body                       text,
  status                     text not null default 'draft' check (status in ('draft', 'saved')),
  analysis_status            text not null default 'none'
                             check (analysis_status in ('none', 'analyzing', 'done', 'empty', 'failed')),
  latest_analysis_request_id bigint references ai_requests (id) on delete set null,
  original_kept_at           timestamptz,
  created_at                 timestamptz not null default now(),
  saved_at                   timestamptz,
  updated_at                 timestamptz not null default now(),
  check ((status = 'saved') = (saved_at is not null))
);
create index records_user_idx on records (user_id, created_at desc);
-- ERD rule 16: one draft per record type per user
create unique index records_one_draft_per_type on records (user_id, type) where status = 'draft';

create table qna_messages (
  id                uuid primary key default gen_random_uuid(),
  record_id         uuid not null references records (id) on delete cascade,
  seq               int  not null,
  question          text not null,
  question_source   text not null check (question_source in ('daily', 'followup')),
  daily_question_id uuid references daily_questions (id) on delete set null,
  answer            text,
  is_replaced       boolean not null default false,
  unique (record_id, seq),
  check (not (is_replaced and answer is not null))
);

-- ---------------------------------------------------------------------------
-- Materials and topics
-- updated_at: B·C 규칙 1 — bumped on any change, including topic changes
-- ---------------------------------------------------------------------------
create table materials (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users (id) on delete cascade,
  record_id      uuid not null unique references records (id) on delete cascade,
  title          text,
  summary        text,
  evidence       text,
  keywords       text[] not null default '{}',
  origin         text not null check (origin in ('ai', 'manual')),
  confirmed_at   timestamptz,
  user_edited_at timestamptz,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index materials_user_idx on materials (user_id, created_at desc);

create table material_topics (
  material_id uuid not null references materials (id) on delete cascade,
  topic_id    smallint not null references topics (id),
  primary key (material_id, topic_id)
);
create index material_topics_topic_idx on material_topics (topic_id);

-- ---------------------------------------------------------------------------
-- Suggestions
-- ---------------------------------------------------------------------------
create table suggestions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  topic_id    smallint not null references topics (id),
  status      text not null default 'computing'
              check (status in ('computing', 'ready', 'none', 'failed')),
  title       text,
  direction   text,
  reason      text,
  basis_hash  text,
  computed_at timestamptz,
  unique (user_id, topic_id)
);

create table suggestion_materials (
  suggestion_id uuid not null references suggestions (id) on delete cascade,
  material_id   uuid not null references materials (id) on delete cascade,
  seq           int  not null,
  primary key (suggestion_id, material_id)
);

-- ---------------------------------------------------------------------------
-- Stage 2: essays and versions
-- ---------------------------------------------------------------------------
create table essays (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  suggestion_id uuid references suggestions (id) on delete set null,
  method        text not null check (method in ('direct', 'ai')),
  status        text not null default 'draft' check (status in ('draft', 'saved')),
  title         text,
  draft_body    text,
  direction     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index essays_user_idx on essays (user_id, updated_at desc);
-- ERD rule 16: one direct-writing draft per user
create unique index essays_one_draft on essays (user_id) where status = 'draft';

create table essay_materials (
  essay_id    uuid not null references essays (id) on delete cascade,
  material_id uuid not null references materials (id) on delete cascade,
  seq         int  not null,
  primary key (essay_id, material_id)
);

create table essay_versions (
  id                  uuid primary key default gen_random_uuid(),
  essay_id            uuid not null references essays (id) on delete cascade,
  version_no          int  not null check (version_no >= 0),
  kind                text not null check (kind in ('ai_first', 'ai_regen', 'direct_first', 'direct_new')),
  title               text,
  body                text not null,
  char_count          int  not null,
  style               text,
  length              text check (length in ('short', 'long')),
  regen_count         int  not null default 0,
  based_on_version_id uuid references essay_versions (id) on delete set null,
  ai_request_id       bigint references ai_requests (id) on delete set null,
  generation_input    jsonb,
  save_token          uuid unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (essay_id, version_no)
);

-- ---------------------------------------------------------------------------
-- Events (share_method: renamed from share_target, 11/16)
-- ---------------------------------------------------------------------------
create table events (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references users (id) on delete cascade,
  name           text not null check (name in (
                   'record_started', 'record_saved', 'material_confirmed', 'writing_started',
                   'suggestion_shown', 'suggestion_selected', 'essay_saved', 'body_shared')),
  occurred_at    timestamptz not null default now(),
  record_id      uuid references records (id) on delete set null,
  essay_id       uuid references essays (id) on delete set null,
  suggestion_id  uuid references suggestions (id) on delete set null,
  write_mode     text check (write_mode in ('direct', 'ai')),
  material_count int,
  entry_path     text check (entry_path in (
                   'home', 'materials', 'material_detail', 'suggestion', 'no_material')),
  share_method   text check (share_method in ('copy', 'share_sheet')),
  check ((name = 'body_shared') = (share_method is not null))
);
create index events_user_idx on events (user_id, occurred_at);
