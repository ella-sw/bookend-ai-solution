-- 글 생성 '사용자 요청' (A 요청 11/21)
--
-- direction(제안 AI가 준 글의 방향)과 따로, 사용자가 AI에게 바라는 점을 적는 칸.
-- 선택 입력, 200자까지. AI 초안 때 저장하고, 다시 만들기에도 그대로 AI 입력에 넣는다.
-- 고치기 화면은 후속이라 지금은 만들 때 한 번만 받는다.

alter table essays
  add column request text check (request is null or char_length(request) <= 200);

comment on column essays.request is '사용자 요청 (선택, 200자). AI 초안·다시 만들기 입력에 포함';
