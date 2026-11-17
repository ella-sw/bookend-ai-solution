-- W210 AI 질문에 답하기: 문답 기록 규칙 (A 회신 문서 합의, 수정 대기 목록 17번)
--  - records.status에 'active' 추가: 첫 답변 ~ [임시 저장] 전의 대화
--  - 이어 쓰기 (나) 기준점: [임시 저장] 때의 마지막 seq, 답을 기다리던 질문 id, 시각
--  - 1시간 규칙: 문답이 바뀔 때마다 records.updated_at 갱신 (마지막 활동 시각)
--  - 중복 저장 막기: records.save_token (essay_versions.save_token과 같은 방식)
--  - 브라우저 역할은 public 함수를 실행할 수 없게 (supabase.rpc() 차단)

alter table records drop constraint records_status_check;
alter table records add constraint records_status_check
  check (status in ('draft', 'active', 'saved'));

-- 한 사용자에 진행 중인 새 대화는 방식별 1개
create unique index records_one_active_per_type on records (user_id, type) where status = 'active';

alter table records
  add column checkpoint_seq        int,
  add column checkpoint_pending_id uuid,
  add column checkpoint_at         timestamptz,
  add column save_token            uuid;

comment on column records.checkpoint_seq is
  '문답 임시 저장 기준점: [임시 저장] 때의 마지막 qna_messages.seq';
comment on column records.checkpoint_pending_id is
  '기준점 때 답을 기다리던 질문 id. 되돌릴 때 answer = null, is_replaced = false로';
comment on column records.checkpoint_at is
  '기준점을 기록한 시각. 되돌릴 때 이 뒤에 시작한 ai_requests를 지운다';
comment on column records.save_token is
  '[소재로 저장] 중복 방지. 같은 사용자의 같은 값이면 기록을 새로 만들지 않는다';

create unique index records_save_token on records (user_id, save_token)
  where save_token is not null;

-- 문답이 바뀌면 그 기록의 updated_at = 마지막 활동 시각
create function touch_record_from_qna() returns trigger language plpgsql as $$
begin
  update records set updated_at = now()
   where id = coalesce(new.record_id, old.record_id) and status <> 'saved';
  return null;
end $$;

create trigger qna_messages_touch after insert or update on qna_messages
  for each row execute function touch_record_from_qna();

-- (나) 기준점으로 되돌리기: 기준점 뒤 문답과 그 AI 요청 기록은 지우고,
-- 답을 기다리던 질문은 원래대로 (ERD 규칙 6·14와 같은 이유로 AI 요청 기록도 지움)
create function revert_qna_draft(p_record uuid) returns void language plpgsql as $$
declare
  r records;
begin
  select * into r from records
   where id = p_record and type = 'qna' and status = 'draft'
   for update;
  if not found or r.checkpoint_seq is null then
    return;
  end if;

  delete from qna_messages where record_id = p_record and seq > r.checkpoint_seq;
  if r.checkpoint_pending_id is not null then
    update qna_messages set answer = null, is_replaced = false
     where id = r.checkpoint_pending_id and (answer is not null or is_replaced);
  end if;
  if r.checkpoint_at is not null then
    delete from ai_requests
     where target_type = 'record' and target_id = p_record and started_at > r.checkpoint_at;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 함수 실행 권한: public 스키마 함수는 브라우저에서 supabase.rpc()로 부를 수 있으므로
-- 브라우저 역할(anon, authenticated)과 PUBLIC에서 모두 뺀다. 서버(app_user)에만 준다.
-- 앞으로 만드는 테이블·함수도 Supabase가 기본으로 주는 브라우저 역할 권한을 뺀다.
-- 주의: PUBLIC 실행 권한은 스키마 단위 기본값으로 뺄 수 없으므로, 함수를 새로 만드는
-- 마이그레이션마다 `revoke execute on function ... from public, anon, authenticated`를 넣는다.
-- (tests/test_qna.py::test_browser_roles_cannot_call_functions가 빠뜨린 함수를 잡는다)
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function clear_user_data(uuid), revert_qna_draft(uuid) to app_user;

alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
