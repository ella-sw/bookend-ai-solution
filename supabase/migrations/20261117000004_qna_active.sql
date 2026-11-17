-- W210 AI 질문에 답하기: 문답 기록 규칙 (A 회신 문서 합의, 수정 대기 목록 17번)
--  - records.status에 'active' 추가: 첫 답변 ~ [임시 저장] 전의 대화
--  - 이어 쓰기 (나) 기준점: [임시 저장] 때의 마지막 seq와 답을 기다리던 질문 id
--  - 1시간 규칙: 문답이 바뀔 때마다 records.updated_at 갱신 (마지막 활동 시각)

alter table records drop constraint records_status_check;
alter table records add constraint records_status_check
  check (status in ('draft', 'active', 'saved'));

-- 한 사용자에 진행 중인 새 대화는 방식별 1개
create unique index records_one_active_per_type on records (user_id, type) where status = 'active';

alter table records
  add column checkpoint_seq        int,
  add column checkpoint_pending_id uuid;

comment on column records.checkpoint_seq is
  '문답 임시 저장 기준점: [임시 저장] 때의 마지막 qna_messages.seq';
comment on column records.checkpoint_pending_id is
  '기준점 때 답을 기다리던 질문 id. 되돌릴 때 answer = null, is_replaced = false로';

-- 문답이 바뀌면 그 기록의 updated_at = 마지막 활동 시각
create function touch_record_from_qna() returns trigger language plpgsql as $$
begin
  update records set updated_at = now()
   where id = coalesce(new.record_id, old.record_id) and status <> 'saved';
  return null;
end $$;

create trigger qna_messages_touch after insert or update on qna_messages
  for each row execute function touch_record_from_qna();

-- (나) 기준점으로 되돌리기: 기준점 뒤 문답은 지우고, 답을 기다리던 질문은 원래대로
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
end $$;

grant execute on function revert_qna_draft(uuid) to app_user;
