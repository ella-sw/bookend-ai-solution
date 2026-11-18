-- R32 사용자별 하루 AI 호출 한도
--
-- ai_requests를 세지 않고 따로 센다: ai_requests는 대화 삭제·모든 기록 지우기 때 함께
-- 지워지므로, 그것만 세면 지우고 다시 쓰는 것으로 한도를 피할 수 있다.
-- 이 표는 사용자 행처럼 모든 기록 지우기 때 남긴다 (ERD 규칙 14의 지우는 목록에 없음).
-- 날짜는 한국 시간 기준. 한도 값은 서버 설정 AI_DAILY_LIMIT (팀 협의 후 확정, 정할 것 1번).

create table ai_usage (
  user_id uuid not null references users (id) on delete cascade,
  day     date not null,
  calls   int  not null default 0 check (calls >= 0),
  primary key (user_id, day)
);

comment on table ai_usage is 'R32 사용자별 하루 AI 호출 수 (한국 날짜). 모든 기록 지우기 때 남긴다';

alter table ai_usage enable row level security;
revoke all on ai_usage from anon, authenticated;
grant select, insert, update on ai_usage to app_user;
create policy own on ai_usage to app_user
  using (user_id = auth.uid()) with check (user_id = auth.uid());
