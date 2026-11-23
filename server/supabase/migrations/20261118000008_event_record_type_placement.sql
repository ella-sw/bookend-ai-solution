-- R33 이벤트 집계 기준 확정 (유진·A 회신, 2026-11-18)
--  - record_started: 기록 방식 구분 record_type = free / qna (필수)
--  - suggestion_shown: 노출 위치 placement = home (홈 카드) / suggestion_detail (N130) (필수)
-- 해석: 시작 이벤트에 이어 쓰기·재진입·새로고침이 포함되므로 '이탈률'이 아니라
-- '방식별 기록 화면 진입·저장 건수 비교'로 본다 (분석 한계로 명시).

alter table events
  add column record_type text check (record_type in ('free', 'qna')),
  add column placement   text check (placement in ('home', 'suggestion_detail'));

comment on column events.record_type is 'record_started의 기록 방식 (free / qna)';
comment on column events.placement is 'suggestion_shown의 노출 위치 (home / suggestion_detail = N130)';

-- body_shared ⇔ share_method 와 같은 방식. 예전 행은 검사하지 않는다 (not valid).
alter table events add constraint events_record_type_on_start
  check ((name = 'record_started') = (record_type is not null)) not valid;
alter table events add constraint events_placement_on_shown
  check ((name = 'suggestion_shown') = (placement is not null)) not valid;
